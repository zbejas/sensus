/**
 * Mock OpenAI-compatible server (docs/agent.md test support): a bun test
 * server on 127.0.0.1 with a random port serving /v1/chat/completions with
 * scripted SSE scenarios. Unit tests (aiSdkProvider.test.ts) and the UI smoke
 * test (tests/ui-smoke.test.ts, via SENSUS_BASE_URL) both drive it.
 *
 * Scenario selection (by the model string in the request):
 * - "notools…"  -> 400 mentioning tools when `tools` present; plain reply otherwise
 * - "schema400…" -> serde-style 400 ("missing field `tool_call_id`") when
 *                  `tools` present — must NOT trigger no-tools degradation
 * Every request's messages are validated against the OpenAI wire schema
 * (wireValidationError): tool results need `tool_call_id`, assistant
 * `tool_calls` entries need {id, type: "function", function:{name, arguments}}.
 * Schema-invalid bodies get the serde-style 400, like strict real endpoints.
 * - "rate429…"  -> first request 429 (Retry-After: 0), then normal behavior
 * - "slow…"     -> plain reply streamed slowly (mid-stream abort tests)
 * - "lag…"      -> plain reply whose FIRST chunk is delayed (waiting-indicator tests)
 * - "maxturns"  -> ALWAYS answers with another shell_background tool call (loop cap)
 * - user text "think:…" -> reasoning_content chunks first, then a plain reply
 * - user text "thinktool:…" -> reasoning_content chunks, then a shell_background
 *   tool call (empty content) — a pre-tool thinking bubble, for the
 *   thinking-header click regression
 * anything else:
 *     last message role "tool" -> final answer citing that result (TOOLDONE-OK)
 *     user message             -> scripted tool_calls parsed from markers:
 *         cmd:<shell>            shell_background
 *         both:<shell1>|<shell2> two parallel shell_background calls
 *         edit:<path>|<old>|<new>       edit_file
 *         write:<path>|<content>        write_file
 *         read:<path>                   read_file
 *         skill:<name>                  skill_view
 *         keys:<text>                   shell_session (enter=true)
 *         scroll:                       get_scrollback
 *         ask:<question>|<opt1>/<opt2>  ask_user
 *         mcp:<server>|<tool>|<json>    mcp__<server>__<tool> (M11)
 *         plain:<text>                   explicit plain reply even with tools
 *         (no marker)                   plain text reply
 */

export interface MockOpenaiRequest {
  model: string
  hasTools: boolean
  lastRole: string | null
  userText: string
  /** First system message content ("" when absent) — the sensus system
   * prompt; mode-posture assertions key off this (M7). */
  systemText: string
  /** The request's messages exactly as they arrived on the wire, so tests
   * can assert the OpenAI schema (tool_call_id / tool_calls.function). */
  wireMessages: Array<Record<string, unknown>>
  /** Thinking knobs as they arrived on the wire (docs/agent.md "Thinking
   * modes"): reasoning_effort is the OpenAI-style string; reasoningBody is
   * the unified reasoning object (budgets) when one was sent. */
  reasoningEffort: string | null
  reasoningBody: unknown
}

export interface MockOpenaiServer {
  url: string
  port: number
  requests: MockOpenaiRequest[]
  close(): Promise<void>
}

export interface MockOpenaiOptions {
  /**
   * When set, `/chat/completions` requires an `Authorization: Bearer <key>`
   * header whose value is in this list (401 otherwise). Exercises credential
   * handling/reload paths; omitted = no auth (existing behavior).
   */
  validApiKeys?: string[]
}

/** Start a mock models.dev endpoint (api.json-shaped) on a random port. */
export function startMockModelsDev(): Promise<{ url: string; close(): Promise<void> }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify(MOCK_MODELS_DEV), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  })
  return Promise.resolve({
    url: `http://127.0.0.1:${server.port}/api.json`,
    close: async () => {
      server.stop(true)
    },
  })
}

interface ScriptedCall {
  id: string
  name: string
  args: string
}

function encodeChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function sseTextChunks(text: string, finish: string, usage: Record<string, unknown>): string[] {
  const out: string[] = []
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }))
  const pieces = text.match(/[\s\S]{1,7}/g) ?? []
  for (const p of pieces) {
    out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }))
  }
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }))
  out.push("data: [DONE]\n\n")
  return out
}

/** Reasoning chunks first (`delta.reasoning_content`), then the plain text. */
function sseThinkingChunks(text: string, finish: string, usage: Record<string, unknown>): string[] {
  const out: string[] = []
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }))
  const thinking =
    "The user wants the mock reply. I will stream reasoning first, then the answer. " +
    "Let me walk through the request carefully before replying: " +
    "check each detail, weigh the options, and settle on the simplest correct answer. ".repeat(6)
  for (const p of thinking.match(/[\s\S]{1,9}/g) ?? []) {
    out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { reasoning_content: p }, finish_reason: null }] }))
  }
  for (const p of text.match(/[\s\S]{1,7}/g) ?? []) {
    out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }))
  }
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }))
  out.push("data: [DONE]\n\n")
  return out
}

function sseToolCallChunks(calls: ScriptedCall[], usage: Record<string, unknown>): string[] {
  const out: string[] = []
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }))
  for (let ci = 0; ci < calls.length; ci++) {
    const call = calls[ci]
    if (!call) continue
    // Fragment merge exercise: id+name in the first fragment, arguments split
    // across two more fragments (index-keyed).
    out.push(
      encodeChunk({
        id: "chatcmpl-mock",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: ci, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] },
            finish_reason: null,
          },
        ],
      }),
    )
    const half = Math.max(1, Math.floor(call.args.length / 2))
    out.push(
      encodeChunk({
        id: "chatcmpl-mock",
        choices: [{ index: 0, delta: { tool_calls: [{ index: ci, function: { arguments: call.args.slice(0, half) } }] }, finish_reason: null }],
      }),
    )
    out.push(
      encodeChunk({
        id: "chatcmpl-mock",
        choices: [{ index: 0, delta: { tool_calls: [{ index: ci, function: { arguments: call.args.slice(half) } }] }, finish_reason: null }],
      }),
    )
  }
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }))
  out.push("data: [DONE]\n\n")
  return out
}

/** Reasoning chunks, then a shell_background tool call (empty content) — the
 * pre-tool thinking bubble the stale-action regression needs. */
function sseThinkingToolChunks(usage: Record<string, unknown>): string[] {
  const out: string[] = []
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }))
  const thinking = "I need to run a quick command before answering."
  for (const p of thinking.match(/[\s\S]{1,9}/g) ?? []) {
    out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { reasoning_content: p }, finish_reason: null }] }))
  }
  const args = JSON.stringify({ command: "echo hi" })
  out.push(
    encodeChunk({
      id: "chatcmpl-mock",
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "call_tt", type: "function", function: { name: "shell_background", arguments: "" } }] }, finish_reason: null },
      ],
    }),
  )
  out.push(
    encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] }),
  )
  out.push(encodeChunk({ id: "chatcmpl-mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }))
  out.push("data: [DONE]\n\n")
  return out
}

// prompt_tokens_details exercises the cached-tokens mapping (toUsage).
const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  prompt_tokens_details: { cached_tokens: 8 },
}

/**
 * Static /models payload (M5 model catalog smoke): mixes chat models,
 * an embeddings-only entry, a provider-path id, and a ":latest" tag so the
 * picker exercises the chat flag + normalization matching.
 */
const MOCK_MODELS: Array<Record<string, unknown>> = [
  { id: "mock-gpt-large", object: "model", owned_by: "mock-org", supported_endpoint_types: ["chat_completions", "completions"] },
  { id: "accounts/fireworks/models/deepseek-v4-pro", object: "model", owned_by: "fireworks", supported_endpoint_types: ["openai"] },
  { id: "qwen3-coder:latest", object: "model", owned_by: "mock-org", supported_endpoint_types: ["openai"] },
  { id: "text-embedding-mock", object: "model", owned_by: "mock-org", supported_endpoint_types: ["embeddings"] },
  { id: "plain-no-types", object: "model", owned_by: "mock-org" },
]

/** Trimmed models.dev-shaped payload served for enrichment tests. */
export const MOCK_MODELS_DEV: Record<string, unknown> = {
  "mock-org": {
    id: "mock-org",
    name: "Mock Org",
    models: {
      "mock-gpt-large": {
        id: "mock-gpt-large",
        name: "Mock GPT Large",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
        temperature: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 262144, input: 200000, output: 65536 },
        cost: { input: 1.25, output: 10 },
      },
      "mock-gpt-large-latest": {
        id: "mock-gpt-large-latest",
        name: "Mock GPT Large (latest tag)",
        tool_call: true,
        limit: { context: 128000, output: 4096 },
      },
      "qwen3-coder": {
        id: "qwen3-coder",
        name: "Qwen3 Coder",
        tool_call: true,
        attachment: true,
        limit: { context: 256000, output: 65536 },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32768 }],
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 128000, output: 8192 },
      },
      "text-embedding-mock": {
        id: "text-embedding-mock",
        name: "Mock Embeddings",
        tool_call: false,
        limit: { context: 8192 },
      },
    },
  },
}

let idCounter = 0

/**
 * Strict wire validation, mimicking serde-backed OpenAI-compatible endpoints
 * (the real-world 400 that exposed the missing wire mapping): tool results
 * MUST carry `tool_call_id`; assistant `tool_calls` entries MUST be
 * `{id, type: "function", function: {name, arguments}}`. Returns the serde-
 * style error text or null when the body is schema-valid.
 */
export function wireValidationError(messages: Array<Record<string, unknown>>): string | null {
  for (const m of messages) {
    // The pre-fix seam shape (camelCase leaked to the wire) is rejected
    // outright — stricter than default serde, so the regression this guards
    // can never pass silently.
    if ("toolCalls" in m || "toolCallId" in m) {
      return "unknown field `toolCalls`/`toolCallId` — camelCase seam shape leaked to the wire"
    }
    if (m["role"] === "tool" && typeof m["tool_call_id"] !== "string") {
      return "missing field `tool_call_id`"
    }
    if (m["role"] === "assistant" && Array.isArray(m["tool_calls"])) {
      for (const raw of m["tool_calls"] as Array<Record<string, unknown>>) {
        if (typeof raw["id"] !== "string") return "missing field `id` in tool_calls entry"
        if (raw["type"] !== "function") return 'tool_calls entry must have type "function"'
        const fn = raw["function"]
        if (fn === null || typeof fn !== "object") return "missing field `function` in tool_calls entry"
        const f = fn as Record<string, unknown>
        if (typeof f["name"] !== "string") return "missing field `function.name` in tool_calls entry"
        if (typeof f["arguments"] !== "string") return "missing field `function.arguments` in tool_calls entry"
      }
    }
  }
  return null
}

function parseScripted(userText: string, hasTools: boolean): { calls: ScriptedCall[] } | { text: string } {
  const t = userText.trim()
  const call = (name: string, args: unknown): ScriptedCall => ({ id: `call_${name}_${++idCounter}`, name, args: JSON.stringify(args) })
  // Explicit plain reply even when tools are present (waiting-indicator /
  // streaming tests that need a delayed first token without a tool card).
  if (t.startsWith("plain:")) return { text: t.slice(6).trim() || "PLAINREPLY-OK" }
  if (t.startsWith("cmd:")) return { calls: [call("shell_background", { command: t.slice(4).trim() })] }
  if (t.startsWith("both:")) {
    const [a, b] = t.slice(5).split("|").map((s) => s.trim())
    return { calls: [call("shell_background", { command: a ?? "true" }), call("shell_background", { command: b ?? "true" })] }
  }
  if (t.startsWith("edit:")) {
    const [path, oldS, newS] = t.slice(5).split("|")
    return { calls: [call("edit_file", { path: path ?? "", old_string: oldS ?? "", new_string: newS ?? "" })] }
  }
  if (t.startsWith("write:")) {
    const [path, content] = t.slice(6).split("|")
    return { calls: [call("write_file", { path: path ?? "", content: content ?? "" })] }
  }
  if (t.startsWith("read:")) return { calls: [call("read_file", { path: t.slice(5).trim() })] }
  if (t.startsWith("skill:")) return { calls: [call("skill_view", { name: t.slice(6).trim() })] }
  if (t.startsWith("keys:")) return { calls: [call("shell_session", { text: t.slice(5).trim(), enter: true })] }
  if (t.startsWith("scroll:")) return { calls: [call("get_scrollback", {})] }
  if (t.startsWith("ask:")) {
    const [q, opts] = t.slice(4).split("|")
    return {
      calls: [
        call("ask_user", { question: q ?? "?", options: (opts ?? "yes/no").split("/").map((s) => s.trim()) }),
      ],
    }
  }
  // MCP (M11): "mcp:<server>|<tool>|<json-args>" -> an mcp__<server>__<tool>
  // call, executed by the real registry (docs/mcp.md end-to-end smoke).
  if (t.startsWith("mcp:")) {
    const [server, tool, argsJson] = t.slice(4).split("|")
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(argsJson ?? "{}") as Record<string, unknown>
    } catch {
      args = {}
    }
    return { calls: [call(`mcp__${server ?? "mock"}__${tool ?? "echo"}`, args)] }
  }
  // Tool-equipped request without markers: a default shell_background script
  // (deterministic for unit + smoke tests).
  if (hasTools) return { calls: [call("shell_background", { command: "echo hi" })] }
  return { text: DEFAULT_REPLY_TEXT }
}

/** The mock's default plain reply (also the content after `think:` reasoning).
 * The fenced command prints `PLAIN-REPLY-OK`, which appears NOWHERE in the
 * rendered reply (the template shows `%s`), so the smoke can tell "pasted"
 * from "actually ran" when it clicks the code row. */
const DEFAULT_REPLY_TEXT =
  "This is the mock OpenAI server. It streams plain markdown.\n\n" +
  "```sh\nprintf 'PLAIN-REPLY-%s\\n' OK\n```\n\nPLAINREPLY-OK"

export function startMockOpenai(opts: MockOpenaiOptions = {}): Promise<MockOpenaiServer> {
  const requests: MockOpenaiRequest[] = []
  const seen429 = new Set<string>()
  const validApiKeys = opts.validApiKeys

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      // M5: OpenAI-compatible model listing for the catalog/picker.
      if (url.pathname.endsWith("/models")) {
        return new Response(JSON.stringify({ object: "list", data: MOCK_MODELS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 })
      }
      if (validApiKeys !== undefined) {
        const auth = req.headers.get("authorization") ?? ""
        const key = auth.startsWith("Bearer ") ? auth.slice(7) : ""
        if (!validApiKeys.includes(key)) {
          return new Response(
            JSON.stringify({ error: { message: "Invalid API key provided", type: "invalid_request_error" } }),
            { status: 401 },
          )
        }
      }
      let body: Record<string, unknown> = {}
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return new Response(JSON.stringify({ error: { message: "bad json" } }), { status: 400 })
      }
      const model = typeof body["model"] === "string" ? body["model"] : ""
      const hasTools = Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0
      const messages = Array.isArray(body["messages"]) ? (body["messages"] as Array<Record<string, unknown>>) : []
      // Reject schema-invalid messages the way strict real endpoints do
      // (serde 400) — keeps the wire mapping honest in every test that
      // drives this server (unit + UI smoke).
      const wireError = wireValidationError(messages)
      if (wireError !== null) {
        return new Response(
          JSON.stringify({ error: { message: `Failed to deserialize the JSON body into the target type: ${wireError}`, type: "invalid_request_error" } }),
          { status: 400 },
        )
      }
      const last = messages[messages.length - 1]
      const lastRole = typeof last?.["role"] === "string" ? (last["role"] as string) : null
      const systemMsg = messages.find((m) => m?.["role"] === "system")
      const systemText = typeof systemMsg?.["content"] === "string" ? (systemMsg["content"] as string) : ""
      // The "latest" user message for scripting: the LAST user message, with
      // the prepended context block (docs/agent.md) stripped — the block ends
      // in a blank line, so the scripted text is the final paragraph.
      let userText = ""
      for (const m of messages) {
        if (m["role"] === "user" && typeof m["content"] === "string") userText = m["content"] as string
      }
      const paras = userText.split("\n\n")
      userText = paras[paras.length - 1] ?? userText
      requests.push({
        model,
        hasTools,
        lastRole,
        userText,
        systemText,
        wireMessages: messages,
        reasoningEffort: typeof body["reasoning_effort"] === "string" ? (body["reasoning_effort"] as string) : null,
        reasoningBody: body["reasoning"] ?? null,
      })

      const slow = model.includes("slow")
      // Waiting-indicator seam: delay only the FIRST chunk so the UI sits in
      // "streaming with no assistant bubble yet" long enough to observe.
      const lagFirstMs = model.includes("lag") ? 2500 : 0
      if (model.includes("rate429") && !seen429.has(model)) {
        seen429.add(model)
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        })
      }
      if (model.includes("notools") && hasTools) {
        return new Response(
          JSON.stringify({ error: { message: "this endpoint does not support tools or function calling", type: "invalid_request_error" } }),
          { status: 400 },
        )
      }
      // Schema-shaped 400 (serde-style) — mentions "tool" but is NOT a
      // no-tools endpoint; degradation must NOT latch on it.
      if (model.includes("schema400") && hasTools) {
        return new Response(
          JSON.stringify({ error: { message: "Failed to deserialize the JSON body into the target type: missing field `tool_call_id` at line 1 column 3116" } }),
          { status: 400 },
        )
      }

      // Truncation seam: a reply cut off at the output-token cap
      // (finish_reason "length") — the provider must surface it faithfully
      // instead of collapsing it into "stop".
      if (model.includes("length")) {
        return sseResponse(sseTextChunks("PARTIAL-TRUNCATED-OK", "length", USAGE), 0)
      }

      // Content-filter seam: the provider refused the answer
      // (finish_reason "content_filter") — surfaced as an error, not a stop.
      if (model.includes("contentfilter")) {
        return sseResponse(sseTextChunks("", "content_filter", USAGE), 0)
      }

      if (model.includes("maxturns")) {
        // Always demand another tool call — the loop must cap.
        const n = requests.filter((r) => r.lastRole === "tool").length + requests.length
        const chunks = sseToolCallChunks(
          [{ id: `call_t${n}`, name: "shell_background", args: JSON.stringify({ command: `echo turn-${n}` }) }],
          USAGE,
        )
        return sseResponse(chunks, 0)
      }

      // Tool-result turn -> final answer citing the last tool output.
      if (lastRole === "tool") {
        const lastContent = typeof last?.content === "string" ? last.content : ""
        const cite = lastContent.split("\n").slice(0, 3).join(" ").slice(0, 90)
        return sseResponse(sseTextChunks(`TOOLDONE-OK — the tool said: ${cite}`, "stop", USAGE), slow ? 25 : 0)
      }

      // "think:" marker -> reasoning_content chunks stream first, then the
      // default plain reply (thinking-display seam). Handled BEFORE the
      // scripted dispatch so it works with tools present too — otherwise the
      // hasTools default shell_background call would intercept it.
      if (userText.startsWith("think:")) {
        return sseResponse(sseThinkingChunks(DEFAULT_REPLY_TEXT, "stop", USAGE), slow ? 25 : 0, lagFirstMs)
      }
      if (userText.startsWith("thinktool:")) {
        return sseResponse(sseThinkingToolChunks(USAGE), slow ? 25 : 0, lagFirstMs)
      }

      // First turn with a user message: scripted tool calls or plain reply.
      const scripted = parseScripted(userText, hasTools)
      if ("calls" in scripted) {
        return sseResponse(sseToolCallChunks(scripted.calls, USAGE), 0)
      }
      return sseResponse(sseTextChunks(scripted.text, "stop", USAGE), slow ? 25 : 0, lagFirstMs)
    },
  })

  const port = server.port ?? 0
  return Promise.resolve({
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: async () => {
      server.stop(true)
    },
  })
}

function sseResponse(chunks: string[], delayMs: number, initialDelayMs = 0): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (i: number): void => {
        if (i >= chunks.length) {
          try {
            controller.close()
          } catch {
            // client already went away
          }
          return
        }
        try {
          const chunk = chunks[i]
          if (chunk !== undefined) controller.enqueue(encoder.encode(chunk))
        } catch {
          return // stream canceled (abort test) — stop pushing
        }
        if (delayMs > 0) {
          setTimeout(() => push(i + 1), delayMs)
        } else {
          push(i + 1)
        }
      }
      if (initialDelayMs > 0) setTimeout(() => push(0), initialDelayMs)
      else push(0)
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}