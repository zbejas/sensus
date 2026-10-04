/**
 * Provider seam (docs/agent.md "Provider client"). The real client is the
 * Vercel AI SDK-based AiSdkProvider (aiSdkProvider.ts via protocols.ts — the
 * SDK owns the wire format for each protocol kind); the factory picks mock vs
 * the endpoint's protocol from the endpoint + SENSUS_MOCK test seam.
 *
 * Design notes:
 * - `stream()` returns a promise resolving with a StreamResult; deltas arrive
 *   via handlers. Abort uses an AbortSignal (Esc in the UI).
 * - `onToolCallDelta` reports tool_calls fragments as they stream; the
 *   provider merges them and returns the completed calls on the result
 *   (`finish: "tool_calls"`). MockProvider never emits them.
 * - Usage comes back on the result AND is pushed through onUsage so the UI can
 *   update tokens live where the transport reports them mid-stream.
 * - `thinking` carries the models.dev-resolved reasoning knob (effort
 *   keyword or token budget); null/omitted = provider default.
 */

import { type EndpointConfig } from "../../config/config.ts"
import { type ImageAttachment, estimateImageTokens } from "../../core/image.ts"
import { AiSdkProvider } from "./aiSdkProvider.ts"
import { errorMessage } from "../../core/util.ts"
import { abortableSleep } from "../processUtil.ts"

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Prompt tokens served from the provider's cache (prompt_tokens_details.
   * cached_tokens). Undefined when the endpoint does not report it — the
   * /status cache line stays quiet instead of lying. */
  cachedTokens?: number | null
}

/** A completed tool call accumulated from stream fragments (M3). */
export interface CompletedToolCall {
  id: string
  name: string
  /** Raw JSON arguments string (may fail to parse — callers defend). */
  arguments: string
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** Image attachments (docs/agent.md "Images") on a user message. A
   * `view_image` tool result carries its pixels in a separate user message
   * appended after the tool results (tool roles are text-only on the
   * OpenAI-compatible wire). */
  images?: ImageAttachment[]
  /** Assistant message carrying the tool calls it requested. */
  toolCalls?: CompletedToolCall[]
  /** For role:"tool" result messages: the id of the call being answered. */
  toolCallId?: string
  /** For role:"tool" result messages: the tool's name (AI SDK tool-result
   * parts require it; OpenAI-compatible wire ignores it). */
  toolName?: string
}

/** A fragment of an accumulating tool call (streaming). */
export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  arguments?: string
}

export interface StreamRequest {
  model: string
  messages: ProviderMessage[]
  temperature?: number
  maxTokens?: number
  /** OpenAI function-tool specs. Omitted entirely in no-tools mode. */
  tools?: unknown[]
  /**
   * SESSION-scoped no-tools latch (docs/agent.md "Provider client"): the
   * provider omits tools for this request even when `tools` is present. Set
   * from the ChatSession that owns the conversation, so a tools-rejection in
   * one session cannot disable tools for another tab sharing the provider.
   */
  noTools?: boolean
  /** Thinking-mode knob resolved from models.dev metadata
   * (agent/modelCatalog.ts `resolveThinkingKnob`). Null = provider default. */
  thinking?: ThinkingRequest | null
}

/** The reasoning knob for one request (docs/agent.md "Thinking modes"). */
export interface ThinkingRequest {
  /** OpenAI-style `reasoning_effort` keyword ("low"…"xhigh", "minimal"…). */
  reasoningEffort?: string
  /** Anthropic-style token budget → unified `reasoning: {max_tokens}`. */
  reasoningBudgetTokens?: number
  /** Toggle-style models → unified `reasoning: {enabled}`. */
  reasoningEnabled?: boolean
}

export interface StreamHandlers {
  /** One text delta. Order of calls == order of the underlying stream. */
  onDelta(text: string): void
  /** One reasoning ("thinking") delta — OpenAI-compatible endpoints carry it
   * as `delta.reasoning_content` (DeepSeek/OpenRouter style) or
   * `delta.reasoning`. Display-only: never enters the provider history. */
  onReasoning?(text: string): void
  onUsage?(usage: UsageInfo): void
  onToolCallDelta?(delta: ToolCallDelta): void
  /** Fired when the endpoint rejects tool support (M3 no-tools mode). */
  onNoTools?(): void
  /**
   * The current attempt is being restarted after a retryable pre-content
   * failure: the consumer must discard any reasoning shown from the failed
   * attempt — the provider re-streams it on the next attempt. Only called
   * when the failed attempt delivered reasoning but no visible content;
   * content/tool calls never trigger a restart.
   */
  onStreamRestart?(): void
}

export interface StreamResult {
  /**
   * "tool_calls": the model asked for tools — completed calls in `toolCalls`.
   * "length": the model hit its output-token cap (truncated). The answer so
   * far is still real content — callers that only need durable text (compaction
   * and the normal reply display) must treat it like "stop" and
   * let their own validity/budget gate decide; only a hard abort/error
   * discards a reply outright.
   */
  finish: "stop" | "length" | "aborted" | "error" | "tool_calls"
  usage: UsageInfo | null
  error: string | null
  /** Present when finish === "tool_calls" (may be empty in degenerate streams). */
  toolCalls?: CompletedToolCall[]
}

export interface ChatProvider {
  readonly name: string
  /** Stream one completion. Resolves when done/aborted/errored. Never rejects
   * on provider/network problems — those come back as finish:"error". */
  stream(req: StreamRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamResult>
}

/**
 * Canned reply markers — deterministic strings the smoke tests assert on.
 */
export const MOCK_REPLY_OK = "MOCKREPLY-OK"
export const MOCK_EXPLAIN_OK = "MOCKEXPLAIN-OK"
/** Canned reasoning streamed before the explain reply (thinking-display seam). */
export const MOCK_THINKING =
  "The user wants a longer explanation. I should cover streaming, then markdown features, then close with a code fence."

export const MOCK_DEFAULT_REPLY =
  "This is the MockProvider talking. It streams in small chunks so the TUI exercises live markdown rendering. " +
  `You can send **bold**, *italic*, \`inline code\`, and a list works too. ${MOCK_REPLY_OK}`

/** Appended to the reply when a request carried image attachments — lets tests
 * assert images reached the provider without inspecting the provider internals. */
export const MOCK_IMAGE_SEEN = "MOCKIMAGE-OK"

const MOCK_EXPLAIN_REPLY = `Here is a longer, multi-paragraph mock explanation.

## Streaming

Text arrives **word by word** while the status bar shows \`chat: streaming\`. Inline \`code\` and [links](https://example.com) render as text.

- first bullet
- second bullet

\`\`\`ts
const tool = "terminal"
console.log(\`sensus: \${tool}\`)
\`\`\`

That is the end of the mock explanation. ${MOCK_EXPLAIN_OK}`

/** Select the reply for a first user message (test seam + "explain:" marker). */
export function mockReplyFor(firstUserMessage: string): string {
  if (firstUserMessage.trim().toLowerCase().startsWith("explain:")) return MOCK_EXPLAIN_REPLY
  return MOCK_DEFAULT_REPLY
}

export interface MockProviderOptions {
  /** Delay between chunks in ms. 0 = synchronous (tests). */
  chunkDelayMs?: number
  /** Override the reply computation (tests). */
  replyFor?: (firstUserMessage: string) => string
  /** Chunk size in characters (default ~11). */
  chunkSize?: number
}

/**
 * Streams a canned reply character-by-character. Honours abort between chunks
 * (partial content already delivered is kept by the caller). finish:"error"
 * when the request is empty or aborted is signalled as finish:"aborted".
 */
export class MockProvider implements ChatProvider {
  readonly name = "mock"
  private readonly chunkDelayMs: number
  private readonly replyFor: (firstUserMessage: string) => string
  private readonly chunkSize: number

  constructor(opts: MockProviderOptions = {}) {
    this.chunkDelayMs = opts.chunkDelayMs ?? 14
    this.replyFor = opts.replyFor ?? mockReplyFor
    this.chunkSize = Math.max(1, opts.chunkSize ?? 11)
  }

  async stream(req: StreamRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    const firstUserMsg = req.messages.find((m) => m.role === "user")
    const firstUser = firstUserMsg?.content ?? ""
    const baseReply = this.replyFor(firstUser)
    const hasImages = req.messages.some((m) => (m.images?.length ?? 0) > 0)
    const reply = hasImages ? `${baseReply} ${MOCK_IMAGE_SEEN}` : baseReply
    const chars = [...reply]
    const estTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4))
    const imageTokens = req.messages.reduce(
      (n, m) => n + (m.images?.reduce((s, a) => s + estimateImageTokens(a), 0) ?? 0),
      0,
    )
    try {
      let delivered = 0
      // The "explain:" path streams reasoning first (thinking-display seam):
      // the same chunk pacing, delivered through onReasoning.
      if (baseReply === MOCK_EXPLAIN_REPLY) {
        const thinkChars = [...MOCK_THINKING]
        let thinkDelivered = 0
        while (thinkDelivered < thinkChars.length) {
          if (signal.aborted) return { finish: "aborted", usage: null, error: null }
          const slice = thinkChars.slice(thinkDelivered, thinkDelivered + this.chunkSize).join("")
          if (slice.length === 0) break
          handlers.onReasoning?.(slice)
          thinkDelivered += slice.length
          if (this.chunkDelayMs > 0) await abortableSleep(this.chunkDelayMs, signal)
        }
      }
      while (delivered < chars.length) {
        if (signal.aborted) return { finish: "aborted", usage: null, error: null }
        const slice = chars.slice(delivered, delivered + this.chunkSize).join("")
        if (slice.length === 0) break
        handlers.onDelta(slice)
        delivered += slice.length
        if (this.chunkDelayMs > 0) await abortableSleep(this.chunkDelayMs, signal)
      }
      if (signal.aborted) return { finish: "aborted", usage: null, error: null }
      const usage: UsageInfo = {
        promptTokens: estTokens(req.messages.map((m) => m.content).join("\n")) + imageTokens,
        completionTokens: estTokens(reply),
        totalTokens: estTokens(req.messages.map((m) => m.content).join("\n")) + imageTokens + estTokens(reply),
      }
      handlers.onUsage?.(usage)
      return { finish: "stop", usage, error: null }
    } catch (e) {
      if (signal.aborted) return { finish: "aborted", usage: null, error: null }
      return { finish: "error", usage: null, error: errorMessage(e) }
    }
  }
}

/**
 * Factory — picks the provider for an endpoint:
 * - `provider: "mock"` in the endpoint, or `SENSUS_MOCK=1` in the env (test
 *   seam, documented in docs/config.md) → MockProvider.
 * - otherwise the real client (aiSdkProvider.ts — Vercel AI SDK over the
 *   endpoint's protocol kind: openai-compatible (default), openai-responses,
 *   anthropic, or google; protocols.ts owns the model construction).
 *
 * Test seam: SENSUS_MOCK_DELAY (ms per chunk) slows the mock so streaming and
 * Esc-abort are observable in the real TUI.
 */
export function createProvider(endpoint: EndpointConfig): ChatProvider {
  if (endpoint.provider === "mock" || process.env["SENSUS_MOCK"] === "1") {
    const delay = Number(process.env["SENSUS_MOCK_DELAY"])
    return new MockProvider({ chunkDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 14 })
  }
  // The mock branch returned above, so TypeScript narrows the kind to the
  // real ProtocolKind union here.
  return new AiSdkProvider({
    provider: endpoint.provider,
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
  })
}
