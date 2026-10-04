/**
 * Real provider client (docs/agent.md "Provider client") — built on the
 * Vercel AI SDK (`ai` + the provider packages) instead of a hand-rolled SSE
 * client. The SDK owns the wire format (chat completions schema, tool_calls
 * merge, reasoning deltas, usage) for every protocol kind: OpenAI-compatible
 * (the default), the OpenAI Responses API, Anthropic, and Google Gemini. The
 * protocol-specific model construction + reasoning mapping live in
 * `protocols.ts`; this file stays protocol-agnostic.
 *
 * What stays in sensus (behavioral contract — docs/agent.md):
 * - The `ChatProvider` seam: `stream()` never rejects; deltas arrive via
 *   handlers; Esc aborts through the AbortSignal.
 * - Retries: 429/5xx + network errors honoring `Retry-After` (seconds or
 *   HTTP-date) and `retry-after-ms` (integer ms; it wins when both are
 *   present), max `maxRetries` retries after the first attempt, exponential
 *   backoff (base 500ms, capped 8s) with ±25% jitter. The SDK's own retry is
 *   disabled (`maxRetries: 0`) so this policy stays in one place. Only a stream
 *   that produced NO content yet is retried — mid-stream failures surface — and
 *   a context-overflow error is never retried here (it takes the single
 *   compact-and-retry path in ChatSession).
 * - No-tools degradation (openai-compatible ONLY — native protocols surface
 *   the error instead of latching): a 400 whose body mentions tools/functions
 *   triggers one immediate retry WITHOUT `tools`, then the SESSION latches (the
 *   request carries `noTools` so the latch is per-conversation, not
 *   per-provider). Schema/deserialize 400s are excluded.
 * - Idle stream timeout: an AbortSignal combined with the caller's signal that
 *   fires when no stream part arrives for `streamTimeoutMs`
 *   (`SENSUS_STREAM_TIMEOUT_MS`, default 120000). A pre-content timeout is
 *   retryable like a network error; a post-content timeout surfaces; a user
 *   abort still returns `finish:"aborted"`.
 * - Thinking modes: `StreamRequest.thinking` is mapped per protocol by
 *   `protocols.ts reasoningArgs` (unified `reasoning` efforts, Anthropic
 *   thinking budget, Gemini thinkingBudget, the legacy OpenAI-compatible
 *   `reasoningEffort` / unified `reasoning` body fields) — resolved from
 *   models.dev metadata by the caller (agent/modelCatalog.ts
 *   `resolveThinkingKnob`). OpenAI Responses requests always carry
 *   `store: false` (`protocolRequestOptions`).
 * - A content-filter finish is surfaced as `finish:"error"`, never a silent
 *   "stop" (the provider refused to generate the answer).
 */

import {
  dynamicTool,
  jsonSchema,
  streamText,
  type JSONValue,
  type FilePart,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolSet,
} from "ai"
import { APICallError } from "@ai-sdk/provider"
import { abortableSleep } from "../processUtil.ts"
import { isContextOverflowError } from "../chat/compaction.ts"
import { componentLogger } from "../log.ts"
import { readImageBytes, type ImageAttachment } from "../../core/image.ts"
import {
  type ChatProvider,
  type CompletedToolCall,
  type ProviderMessage,
  type StreamHandlers,
  type StreamRequest,
  type StreamResult,
  type ToolCallDelta,
  type UsageInfo,
} from "./provider.ts"
import {
  createLanguageModel,
  protocolRequestOptions,
  reasoningArgs,
  compatibleThinkingProviderOptions,
  type ProtocolKind,
  type ReasoningArgs,
} from "./protocols.ts"

const log = componentLogger("agent.provider")

export interface AiSdkProviderOptions {
  /** Protocol family for this client. Defaults to "openai-compatible"
   * (existing direct-constructor callers keep today's behavior). */
  provider?: ProtocolKind
  baseURL: string
  apiKey: string
  /** Retries AFTER the first attempt (docs/agent.md: "max 3"). Default 3. */
  maxRetries?: number
  /** Exponential backoff base in ms (test seam). Default 500. */
  retryBaseDelayMs?: number
  /** Cap for a single backoff sleep. Default 8000. */
  maxBackoffMs?: number
  /**
   * IDLE stream timeout in ms: the maximum gap between streamed parts. Resets
   * on every part, so a long legitimate generation survives; a half-open
   * connection or a server that accepts then never emits is aborted and
   * retried. 0 disables. Defaults to `SENSUS_STREAM_TIMEOUT_MS` when set and
   * valid, else 120000.
   */
  streamTimeoutMs?: number
  /** Extra request headers (rarely needed). */
  headers?: Record<string, string>
}

/** How many retries after the first attempt (docs/agent.md "max 3"). */
export const DEFAULT_MAX_RETRIES = 3

/** Idle stream timeout when neither the option nor the env var is set. */
export const DEFAULT_STREAM_TIMEOUT_MS = 120_000

/**
 * Resolve the idle stream timeout from `SENSUS_STREAM_TIMEOUT_MS`. Parsed
 * defensively: a non-numeric/negative/non-finite value is ignored (the default
 * applies); `0` explicitly disables the timeout. Never throws.
 */
export function parseStreamTimeoutMs(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

/**
 * Seam messages -> AI SDK ModelMessages. Tool-call arguments arrive as raw
 * JSON strings and go back as parsed inputs (the SDK re-serializes them to
 * the wire schema, `tool_call_id` / `tool_calls[].function` included).
 *
 * Images (docs/agent.md "Images"): a user message's attachments become
 * `FilePart`s (the OpenAI-compatible provider turns image file parts into
 * `image_url` data URLs). A `view_image` tool result's pixels are NOT carried
 * on the tool message — the session appends them as a separate user message
 * AFTER the (text-only) tool results, so every tool result stays contiguous
 * (OpenAI requires all of them immediately after the assistant tool_calls).
 *
 * `readImage` is injectable for unit tests; the default reads the stored
 * asset from disk (sync — small local files, once per request).
 */
export type ImageReader = (path: string) => Uint8Array | null

const defaultImageReader: ImageReader = (path) => readImageBytes(path)

/** Image attachments -> user-content file parts (unreadable => a text note). */
function imageParts(images: readonly ImageAttachment[] | undefined, readImage: ImageReader): Array<TextPart | FilePart> {
  const parts: Array<TextPart | FilePart> = []
  for (const img of images ?? []) {
    const bytes = readImage(img.path)
    if (bytes === null) {
      parts.push({ type: "text", text: `[image unavailable: ${img.name}]` })
      continue
    }
    parts.push({ type: "file", data: { type: "data", data: bytes }, mediaType: img.mediaType, filename: img.name })
  }
  return parts
}

export function toModelMessages(
  messages: readonly ProviderMessage[],
  readImage: ImageReader = defaultImageReader,
): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId ?? "",
            toolName: m.toolName ?? "",
            output: { type: "text", value: m.content },
          },
        ],
      }
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const parts: Array<TextPart | ToolCallPart> = []
      if (m.content.length > 0) parts.push({ type: "text", text: m.content })
      for (const c of m.toolCalls) {
        parts.push({ type: "tool-call", toolCallId: c.id, toolName: c.name, input: safeParseJson(c.arguments) })
      }
      return { role: "assistant", content: parts }
    }
    if (m.role === "user" && m.images !== undefined && m.images.length > 0) {
      const parts: Array<TextPart | FilePart> = []
      if (m.content.length > 0) parts.push({ type: "text", text: m.content })
      parts.push(...imageParts(m.images, readImage))
      return { role: "user", content: parts }
    }
    return { role: m.role, content: m.content }
  })
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

/** OpenAI function-tool specs -> an AI SDK ToolSet (schema-only, sensus executes). */
export function toToolSet(specs: readonly unknown[]): ToolSet {
  const set: ToolSet = {}
  for (const spec of specs) {
    if (spec === null || typeof spec !== "object") continue
    const fn = (spec as Record<string, unknown>)["function"]
    if (fn === null || typeof fn !== "object") continue
    const f = fn as Record<string, unknown>
    const name = typeof f["name"] === "string" ? f["name"] : ""
    if (name.length === 0) continue
    set[name] = dynamicTool({
      description: typeof f["description"] === "string" ? f["description"] : undefined,
      inputSchema: jsonSchema<Record<string, unknown>>(
        (f["parameters"] ?? {}) as Parameters<typeof jsonSchema>[0],
      ),
    })
  }
  return set
}

/** Seconds until a retry (Retry-After: "2") or null when absent/invalid. */
export function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null
  const s = header.trim()
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? Math.max(0, n) : null
  }
  const date = Date.parse(s) // HTTP-date form
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000)
  return null
}

/** Milliseconds until a retry from a `retry-after-ms` header (integer ms). */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const s = header.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.max(0, n) : null
}

/**
 * Retry delay in MILLISECONDS from response headers. `retry-after-ms` takes
 * precedence over the seconds/HTTP-date `Retry-After` form.
 */
function retryAfterFromHeaders(headers: Record<string, unknown>): number | null {
  const ms = parseRetryAfterMs(headerString(headers["retry-after-ms"]))
  if (ms !== null) return ms
  const secs = parseRetryAfterSeconds(headerString(headers["retry-after"]))
  return secs === null ? null : secs * 1000
}

/** Header values are normally strings; tolerate numbers defensively. */
function headerString(v: unknown): string | null {
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  return null
}

const NO_TOOLS_RE = /tool|function/i
/**
 * A 400 about the request BODY's schema (serde-style: "Failed to deserialize
 * the JSON body ...", "missing field …") is NOT "endpoint lacks tool
 * support" — degrading on it would latch the session into no-tools mode while
 * the real problem is a malformed request (docs/agent.md). These surface as
 * normal errors.
 */
const SCHEMA_400_RE = /deserialize|missing field|json body/i

/**
 * Defensive status/message extraction from any SDK error shape. Retry timing is
 * returned in MILLISECONDS (`retry-after-ms` wins over `Retry-After`).
 */
export function errorInfo(err: unknown): { statusCode: number | null; message: string; retryAfterMs: number | null } {
  if (APICallError.isInstance(err)) {
    const headers = err.responseHeaders ?? {}
    const retryAfterMs = retryAfterFromHeaders(headers)
    return { statusCode: err.statusCode ?? null, message: err.message, retryAfterMs }
  }
  if (err !== null && typeof err === "object") {
    const rec = err as Record<string, unknown>
    const statusCode = typeof rec["statusCode"] === "number" ? rec["statusCode"] : null
    const headers = rec["responseHeaders"]
    const retryAfterMs =
      headers !== null && typeof headers === "object"
        ? retryAfterFromHeaders(headers as Record<string, unknown>)
        : null
    const body = rec["responseBody"]
    const text = rec["text"]
    const message =
      typeof rec["message"] === "string" && rec["message"].length > 0
        ? rec["message"]
        : typeof body === "string"
          ? body
          : typeof text === "string"
            ? text
            : JSON.stringify(rec).slice(0, 300)
    return { statusCode, message, retryAfterMs }
  }
  return { statusCode: null, message: String(err), retryAfterMs: null }
}

function isRetryableStatus(status: number | null): boolean {
  return status === 429 || (status !== null && status >= 500)
}

/** Hard cap on a provider-supplied Retry-After delay. */
const RETRY_AFTER_MAX_MS = 30_000
/** Default exponential-backoff jitter, as a fraction of the delay (±). */
const DEFAULT_JITTER_RATIO = 0.25

/**
 * Pure retry-backoff policy (deterministically testable). A provider-supplied
 * `retryAfterMs` is honored verbatim, capped at 30s and never jittered;
 * otherwise the exponential delay `baseMs * 2**attempt` gets `±jitterRatio`
 * jitter and is clamped to `maxMs`. Always non-negative.
 */
export function backoffDelayMs(opts: {
  baseMs: number
  maxMs: number
  attempt: number
  retryAfterMs?: number | null
  jitterRatio?: number
  random?: () => number
}): number {
  const retryAfterMs = opts.retryAfterMs ?? null
  const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO
  const random = opts.random ?? Math.random
  if (retryAfterMs !== null) return Math.max(0, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS))
  const exp = opts.baseMs * 2 ** opts.attempt
  const jittered = exp * (1 + (random() * 2 - 1) * jitterRatio)
  return Math.max(0, Math.min(jittered, opts.maxMs))
}

/**
 * Merge protocol-level request defaults UNDER the reasoning provider options
 * (per provider key, reasoning wins on conflicts). Undefined-safe.
 */
function mergeProviderOptions(
  base: Record<string, Record<string, JSONValue>> | undefined,
  override: Record<string, Record<string, JSONValue>> | undefined,
): Record<string, Record<string, JSONValue>> | undefined {
  if (base === undefined) return override
  if (override === undefined) return base
  const merged: Record<string, Record<string, JSONValue>> = { ...base }
  for (const [provider, opts] of Object.entries(override)) {
    merged[provider] = { ...(merged[provider] ?? {}), ...opts }
  }
  return merged
}

/** One attempt's collected outcome. */
interface AttemptResult {
  finish: StreamResult["finish"]
  usage: UsageInfo | null
  error: string | null
  /** A protocol-level error the attempt already explains (e.g. a content
   * filter); when set, `stream()` surfaces it verbatim instead of formatting
   * the raw error as a network/HTTP failure. */
  errorText: string | null
  toolCalls: CompletedToolCall[]
  /** Visible content delivered (non-empty text, tool-input delta, completed
   * call) — the retry guard: only an answer-less attempt is retried. */
  deliveredContent: boolean
  /** Reasoning was delivered but no visible content (display-only): a retry
   * still happens, and the consumer restarts/discards it. */
  deliveredReasoning: boolean
  /** The raw error value of a failed attempt (classification). */
  rawError: unknown
  httpStatus: number | null
  retryAfterMs: number | null
}

export class AiSdkProvider implements ChatProvider {
  /** The protocol kind — doubles as the diagnostic name. */
  readonly name: string
  private readonly provider: ProtocolKind
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number
  private readonly maxBackoffMs: number
  private readonly extraHeaders: Record<string, string>
  /** Idle stream timeout in ms (0 = disabled). */
  private readonly streamTimeoutMs: number

  constructor(opts: AiSdkProviderOptions) {
    this.provider = opts.provider ?? "openai-compatible"
    this.name = this.provider
    this.baseURL = opts.baseURL.replace(/\/+$/, "")
    this.apiKey = opts.apiKey
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.retryBaseDelayMs = Math.max(0, opts.retryBaseDelayMs ?? 500)
    this.maxBackoffMs = Math.max(1, opts.maxBackoffMs ?? 8000)
    this.extraHeaders = opts.headers ?? {}
    const envTimeout = parseStreamTimeoutMs(process.env["SENSUS_STREAM_TIMEOUT_MS"])
    this.streamTimeoutMs = Math.max(0, opts.streamTimeoutMs ?? envTimeout ?? DEFAULT_STREAM_TIMEOUT_MS)
  }

  /** The language model for one request (cheap — the SDK wraps config). */
  private model(modelId: string) {
    return createLanguageModel(
      this.provider,
      { baseURL: this.baseURL, apiKey: this.apiKey, headers: this.extraHeaders },
      modelId,
    )
  }

  /** Provider options carrying the thinking knobs (docs/agent.md) — the
   * openai-compatible mapping, kept as a static seam for existing callers. */
  static thinkingProviderOptions(
    thinking: StreamRequest["thinking"],
  ): Record<string, Record<string, JSONValue>> | undefined {
    return compatibleThinkingProviderOptions(thinking)
  }

  private backoffDelay(attempt: number, retryAfterMs: number | null): number {
    return backoffDelayMs({
      baseMs: this.retryBaseDelayMs,
      maxMs: this.maxBackoffMs,
      attempt,
      retryAfterMs,
    })
  }

  async stream(req: StreamRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    const messages = toModelMessages(req.messages)
    // Protocol-shaped request options: the protocol's own defaults (e.g.
    // OpenAI Responses `store: false`) UNDER the thinking knobs (reasoning
    // options win on conflict).
    const reasoning = reasoningArgs(this.provider, req.thinking)
    const providerOptions = mergeProviderOptions(protocolRequestOptions(this.provider), reasoning?.providerOptions)
    // The no-tools latch is SESSION-scoped (docs/agent.md "Provider client"):
    // the request carries it, so one session's tools-rejection cannot disable
    // tools for another tab sharing the memoized provider. The single
    // immediate no-tools retry for THIS request is tracked locally.
    let droppedTools = false

    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return { finish: "aborted", usage: null, error: null }
      // Recomputed per attempt: a degradation retry must drop the tools.
      const useTools = !droppedTools && !req.noTools && Array.isArray(req.tools) && req.tools.length > 0
      const tools = useTools ? toToolSet(req.tools ?? []) : undefined
      const r = await this.attempt({
        req,
        messages,
        tools,
        reasoning: reasoning?.reasoning,
        providerOptions,
        handlers,
        signal,
      })
      if (signal.aborted) return { finish: "aborted", usage: r.usage, error: null }

      if (r.finish !== "error") {
        return { finish: r.finish, usage: r.usage, error: null, toolCalls: r.toolCalls }
      }

      // ---- error classification (docs/agent.md retry/degradation rules) --
      const info = errorInfo(r.rawError)
      const status = r.httpStatus ?? info.statusCode

      // No-tools degradation is OPENAI-COMPATIBLE ONLY: an endpoint that
      // rejects `tools` (400 mentioning tools/functions; serde-style schema
      // 400s excluded) gets one immediate retry WITHOUT tools; the SESSION
      // latches via `onNoTools`. Native protocols (Responses/Anthropic/Google)
      // surface the error instead of latching.
      if (
        this.provider === "openai-compatible" &&
        useTools &&
        attempt === 0 &&
        status === 400 &&
        NO_TOOLS_RE.test(info.message) &&
        !SCHEMA_400_RE.test(info.message)
      ) {
        droppedTools = true
        handlers.onNoTools?.()
        continue
      }

      // Retry 429/5xx + network errors (Retry-After / retry-after-ms respected)
      // — but only a stream that produced NO VISIBLE content (mid-stream
      // failures and post-content idle timeouts surface). Reasoning-only
      // delivery still retries: the consumer discards the partial reasoning
      // through `onStreamRestart` and the next attempt re-streams it
      // (docs/agent.md "Streaming display"). A context overflow is never
      // retried here: it goes through the single compact-and-retry path in
      // ChatSession. A content-filter finish carries no transport status; it
      // is explained by `errorText` and is NOT retryable (retrying would just
      // be filtered again).
      const retryable = (status !== null && isRetryableStatus(status)) || status === null
      if (retryable && r.errorText === null && !r.deliveredContent && !isContextOverflowError(info.message) && attempt < this.maxRetries) {
        await abortableSleep(this.backoffDelay(attempt, r.retryAfterMs ?? info.retryAfterMs), signal)
        if (signal.aborted) return { finish: "aborted", usage: r.usage, error: null }
        // Reasoning was shown from the attempt that just failed: tell the
        // consumer to restart it before the retry re-streams (a no-tools
        // degradation retry happens pre-stream, before any handler ran).
        if (r.deliveredReasoning) safeCall(() => handlers.onStreamRestart?.())
        continue
      }

      const snippet = info.message.length > 300 ? `${info.message.slice(0, 300)}…` : info.message
      const prefix = status !== null ? `HTTP ${status}: ` : "network: "
      return { finish: "error", usage: r.usage, error: r.errorText ?? `${prefix}${snippet}` }
    }
  }

  /** One streamText attempt; never throws. */
  private async attempt(args: {
    req: StreamRequest
    messages: ModelMessage[]
    tools: ToolSet | undefined
    reasoning: ReasoningArgs["reasoning"]
    providerOptions: Record<string, Record<string, JSONValue>> | undefined
    handlers: StreamHandlers
    signal: AbortSignal
  }): Promise<AttemptResult> {
    const { req, messages, tools, reasoning, providerOptions, handlers, signal } = args
    const out: AttemptResult = {
      finish: "stop",
      usage: null,
      error: null,
      errorText: null,
      toolCalls: [],
      deliveredContent: false,
      deliveredReasoning: false,
      rawError: null,
      httpStatus: null,
      retryAfterMs: null,
    }
    // Raw streamed tool arguments (the executed arguments — exactly what the
    // model sent, never a re-serialization of parsed input).
    const rawArgs = new Map<string, string>()
    const inputIndex = new Map<string, number>()
    let indexCounter = 0
    let aborted = false
    // Idle-timeout state. `timedOut` distinguishes a stalled transport from a
    // user Esc: both abort the combined signal, but only a timeout is treated
    // as a (retryable, pre-content) error (docs/agent.md "Provider client").
    let timedOut = false
    const timeoutMs = this.streamTimeoutMs
    const idle = new AbortController()
    const combined = timeoutMs > 0 ? AbortSignal.any([signal, idle.signal]) : signal
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdle = (): void => {
      if (timeoutMs <= 0) return
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        idle.abort()
      }, timeoutMs)
      idleTimer.unref?.()
    }
    const clearIdle = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }
    const timeoutError = (): Error => new Error(`stream idle timeout after ${timeoutMs}ms`)

    let result: ReturnType<typeof streamText>
    try {
      armIdle()
      result = streamText({
        model: this.model(req.model),
        messages,
        allowSystemInMessages: true, // the seam carries the system prompt as messages[0]
        tools,
        toolChoice: tools !== undefined ? ("auto" as const) : undefined,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
        reasoning,
        providerOptions,
        abortSignal: combined,
        maxRetries: 0, // sensus owns the retry policy (docs/agent.md)
        onError: () => {}, // errors are consumed via the error stream part
      })
      // The accessor promises (text/usage/steps/…) reject when the stream
      // carries an error part — we consume the error via fullStream, so the
      // others must never surface as unhandled rejections.
      for (const p of [result.text, result.usage, result.steps, result.finishReason, result.toolCalls, result.content, result.request, result.response, result.warnings]) {
        Promise.resolve(p as unknown as Promise<unknown>).catch((e: unknown) => {
          // Intentional: errors are consumed via fullStream; the accessors must
          // not surface as unhandled rejections.
          log.debug("provider accessor rejected (consumed via fullStream)", { err: e })
        })
      }
    } catch (e) {
      clearIdle()
      if (signal.aborted) {
        out.finish = "aborted"
        return out
      }
      if (timedOut) {
        out.finish = "error"
        out.rawError = timeoutError()
        return out
      }
      const info = errorInfo(e)
      out.finish = "error"
      out.rawError = e
      out.httpStatus = info.statusCode
      out.retryAfterMs = info.retryAfterMs
      return out
    }

    try {
      for await (const part of result.fullStream) {
        if (signal.aborted) {
          aborted = true
          break
        }
        if (timedOut) {
          // The idle abort fired between parts (a stalled transport): surface
          // it as an error, not a user abort.
          out.finish = "error"
          out.rawError = timeoutError()
          break
        }
        armIdle() // every part resets the idle deadline
        switch (part.type) {
          case "text-delta": {
            const text = partText(part)
            if (text.length === 0) break
            out.deliveredContent = true
            safeCall(() => handlers.onDelta(text))
            break
          }
          case "reasoning-delta": {
            const text = partText(part)
            if (text.length === 0) break
            out.deliveredReasoning = true
            safeCall(() => handlers.onReasoning?.(text))
            break
          }
          case "tool-input-start": {
            inputIndex.set(part.id, indexCounter++)
            break
          }
          case "tool-input-delta": {
            const idx = inputIndex.get(part.id) ?? 0
            rawArgs.set(part.id, (rawArgs.get(part.id) ?? "") + part.delta)
            out.deliveredContent = true
            const delta: ToolCallDelta = { index: idx, arguments: part.delta }
            safeCall(() => handlers.onToolCallDelta?.(delta))
            break
          }
          case "tool-input-end": {
            break
          }
          case "tool-call": {
            out.deliveredContent = true
            out.toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              arguments: rawArgs.get(part.toolCallId) ?? JSON.stringify(part.input ?? {}),
            })
            break
          }
          case "finish": {
            clearIdle() // the stream completed: no timeout can race the finish
            out.usage = toUsage(part.totalUsage)
            if (out.usage !== null) safeCall(() => handlers.onUsage?.(out.usage!))
            // Faithfully surface truncation: "length" (hit maxOutputTokens)
            // must not collapse into "stop", or callers cannot tell a complete
            // reply from a cut-off one. An SDK "error" reason is a provider
            // failure the user must see, not a silent stop (it defaults its
            // explanation when the stream carried none); any other unmapped
            // reason stays "stop" but is logged with its raw wire form, so an
            // unexplained stop is diagnosable (docs/agent.md "Streaming display").
            if (part.finishReason === "tool-calls") out.finish = "tool_calls"
            else if (part.finishReason === "length") out.finish = "length"
            else if (part.finishReason === "content-filter") {
              // The provider refused to generate the answer: an error the user
              // must see, not a silent stop (docs/agent.md "Provider client").
              out.finish = "error"
              out.errorText = "the provider stopped the response with a content filter"
              log.warn("provider content filter stopped the response", { model: req.model })
            } else if (part.finishReason === "error") {
              out.finish = "error"
              out.errorText = out.errorText ?? "the provider stopped the response with an error"
              log.warn("provider stream finished with an error", {
                model: req.model,
                rawFinishReason: rawFinishReason(part),
              })
            } else if (part.finishReason !== "stop") {
              log.warn("stream finished with unmapped reason", {
                model: req.model,
                finishReason: part.finishReason,
                rawFinishReason: rawFinishReason(part),
              })
            }
            // The raw finish reason is the ground truth for "why did the agent
            // go quiet": log it (debug) so a silent mid-thought stop is
            // diagnosable without reproducing under SENSUS_DEBUG (docs/logging.md).
            log.debug("stream finished", {
              model: req.model,
              finishReason: part.finishReason,
              finish: out.finish,
              outputTokens: out.usage?.completionTokens,
            })
            break
          }
          case "abort": {
            if (signal.aborted) aborted = true
            else if (timedOut) {
              out.finish = "error"
              out.rawError = timeoutError()
            } else aborted = true
            break
          }
          case "error": {
            out.finish = "error"
            out.rawError = part.error
            const info = errorInfo(part.error)
            out.httpStatus = info.statusCode
            out.retryAfterMs = info.retryAfterMs
            break
          }
          default:
            break // start/step/source/file/raw metadata parts — not consumed
        }
        if (aborted || out.finish === "error") break
      }
    } catch (e) {
      if (signal.aborted) {
        aborted = true
      } else if (timedOut) {
        out.finish = "error"
        out.rawError = timeoutError()
      } else {
        out.finish = "error"
        out.rawError = e
        const info = errorInfo(e)
        out.httpStatus = info.statusCode
        out.retryAfterMs = info.retryAfterMs
      }
    } finally {
      clearIdle()
    }

    if (aborted) out.finish = "aborted"
    else if (timedOut && !signal.aborted && out.finish !== "error") {
      // A timeout that fired without an abort part reaching us.
      out.finish = "error"
      out.rawError = timeoutError()
    }
    if (out.finish === "tool_calls" && out.toolCalls.length === 0) {
      // Degenerate stream: no completed calls — treat as a plain stop so the
      // loop doesn't spin on an empty tool turn. Warn with what WAS delivered:
      // a bare tool_calls finish that silently becomes a stop is exactly the
      // "agent went quiet" shape this diagnostic exists for.
      log.warn("stream reported tool_calls but delivered no completed calls; collapsing to stop", {
        model: req.model,
        deliveredContent: out.deliveredContent,
        deliveredReasoning: out.deliveredReasoning,
      })
      out.finish = "stop"
    }
    return out
  }
}

/** v7 stream parts carry `text` (streamText output) — tolerate `delta`. */
function partText(part: { text?: unknown; delta?: unknown }): string {
  if (typeof part.text === "string") return part.text
  if (typeof part.delta === "string") return part.delta
  return ""
}

/** The provider's literal finish-reason string (`rawFinishReason` on the SDK
 * part). Read defensively through a cast so a future SDK type narrowing cannot
 * break the diagnostic; null when absent/empty. */
function rawFinishReason(part: unknown): string | null {
  if (part === null || typeof part !== "object") return null
  const raw = (part as Record<string, unknown>)["rawFinishReason"]
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

function toUsage(u: {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  /** v7 flat shape: cached read tokens live under inputTokenDetails. */
  inputTokenDetails?: { cacheReadTokens?: number | null } | null
  /** Provider-level (v2) shape, kept for safety across SDK upgrades. */
  cachedInputTokens?: number | null
} | null | undefined): UsageInfo | null {
  if (!u) return null
  const input = typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0
  const output = typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? u.outputTokens : 0
  const total = typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) ? u.totalTokens : input + output
  if (input === 0 && output === 0 && total === 0) return null
  const rawCached = u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens
  const cached = typeof rawCached === "number" && Number.isFinite(rawCached) ? rawCached : null
  return { promptTokens: input, completionTokens: output, totalTokens: total, cachedTokens: cached }
}

function safeCall(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    // A throwing UI handler must not kill the read loop.
    log.warn("provider stream handler threw", { err: e })
  }
}
