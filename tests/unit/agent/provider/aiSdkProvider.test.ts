/**
 * AiSdkProvider unit tests against a real local SSE server (docs/agent.md
 * "Provider client"): deltas, tool_calls (merge + wire shape), reasoning
 * deltas, usage, retries (429 honoring Retry-After), no-tools degradation,
 * schema-400 exclusion, abort, and the thinking-mode knobs on the wire
 * (reasoning_effort / unified reasoning object). No network beyond 127.0.0.1.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AiSdkProvider, backoffDelayMs, errorInfo, parseRetryAfterMs, parseRetryAfterSeconds, parseStreamTimeoutMs, toModelMessages, toToolSet } from "../../../../src/agent/provider/aiSdkProvider.ts"
import { APICallError } from "@ai-sdk/provider"
import type { StreamRequest } from "../../../../src/agent/provider/provider.ts"
import { startMockOpenai, wireValidationError, type MockOpenaiServer } from "../../../mocks/mockOpenai.ts"

let server: MockOpenaiServer

beforeAll(async () => {
  server = await startMockOpenai()
})

afterAll(async () => {
  await server.close()
})

const req = (model: string, tools?: unknown[], userText = "hello"): StreamRequest => ({
  model,
  messages: [{ role: "user", content: userText }],
  tools,
})

interface Collected {
  deltas: string[]
  reasoning: string[]
  usage: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }>
  noTools: number
}

/** A real (named) tool spec — a bare {type:"function"} without a name is
 * legitimately dropped from the wire by the SDK (no name -> no tool). */
const SPEC = [{ type: "function", function: { name: "x", description: "d", parameters: { type: "object", properties: {} } } }]

async function run(p: AiSdkProvider, model: string, signal: AbortSignal, tools?: unknown[], userText = "hello") {
  const got: Collected = { deltas: [], reasoning: [], usage: [], noTools: 0 }
  const result = await p.stream(req(model, tools, userText), {
    onDelta: (d) => got.deltas.push(d),
    onReasoning: (d) => got.reasoning.push(d),
    onUsage: (u) => got.usage.push(u),
    onNoTools: () => got.noTools++,
  }, signal)
  return { result, got }
}

/** One SSE text-content chunk (the mock's wire shape, minimized). */
function sseContentChunk(text: string): string {
  return `data: ${JSON.stringify({ id: "stall", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
}

/** One SSE reasoning chunk (`delta.reasoning_content` — the OpenAI-compatible
 * "thinking" wire shape, see tests/mocks/mockOpenai.ts). */
function sseReasoningChunk(text: string): string {
  return `data: ${JSON.stringify({ id: "reason", choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}\n\n`
}

interface StallServer {
  url: string
  requestCount(): number
  close(): Promise<void>
}

/** An endpoint that accepts the request, optionally emits `initialChunks`, then
 * never closes or emits again — the half-open/stalled transport the idle
 * timeout must rescue. */
function startStallServer(initialChunks: string[]): StallServer {
  let count = 0
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      count++
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of initialChunks) controller.enqueue(encoder.encode(chunk))
          // Deliberately never close: the connection stalls forever.
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requestCount: () => count,
    close: async () => {
      server.stop(true)
    },
  }
}

/** A stall fixture whose FIRST response emits `firstChunks` then stalls (the
 * idle timeout fires), and whose LATER responses stream fresh reasoning + an
 * answer and close — so a retry is observable end-to-end over real SSE. */
function startRetryAfterStallServer(firstChunks: string[]): StallServer {
  let count = 0
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      count++
      const retry = count > 1
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (chunk: string): void => controller.enqueue(encoder.encode(chunk))
          for (const chunk of firstChunks) push(chunk)
          if (!retry) return // stall: the first attempt times out
          push(sseReasoningChunk("fresh reasoning "))
          push(sseContentChunk("retry answer"))
          push(
            `data: ${JSON.stringify({
              id: "retry",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            })}\n\n`,
          )
          push("data: [DONE]\n\n")
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requestCount: () => count,
    close: async () => {
      server.stop(true)
    },
  }
}

describe("AiSdkProvider stream", () => {
  test("plain reply: ordered deltas, usage, finish stop; system messages accepted (v7 regression)", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    const { result, got } = await run(p, "plain-model", new AbortController().signal)
    expect(result.finish).toBe("stop")
    expect(result.error).toBeNull()
    expect(got.deltas.join("")).toContain("PLAINREPLY-OK")
    expect(got.usage).toHaveLength(1)
    expect(got.usage[0]?.totalTokens).toBe(18)
    expect(result.usage?.promptTokens).toBe(11)
    // prompt_tokens_details.cached_tokens flows through to UsageInfo (the
    // /status cache line reads it).
    expect(result.usage?.cachedTokens).toBe(8)
    // Regression: v7 rejects system messages without allowSystemInMessages —
    // the app's stream always carries the system prompt as messages[0].
    const withSystem = await p.stream(
      {
        model: "plain-model",
        messages: [
          { role: "system", content: "system prompt here" },
          { role: "user", content: "hello" },
        ],
      },
      { onDelta: () => {} },
      new AbortController().signal,
    )
    expect(withSystem.finish).toBe("stop")
    expect(withSystem.error).toBeNull()
  })

  test("a truncated reply (finish_reason 'length') surfaces as finish:'length', not collapsed to stop", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    const { result, got } = await run(p, "length-model", new AbortController().signal)
    expect(result.finish).toBe("length")
    expect(result.error).toBeNull()
    expect(got.deltas.join("")).toContain("PARTIAL-TRUNCATED-OK")
  })

  test("a content-filter finish surfaces as an error (not a silent stop) and is not retried", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k", retryBaseDelayMs: 1 })
    const { result, got } = await run(p, "contentfilter-model", new AbortController().signal)
    expect(result.finish).toBe("error")
    expect(result.error).toContain("content filter")
    // No content was delivered, but a filter is not a transport failure: the
    // explained errorText must suppress the network-retry path (one request).
    expect(got.deltas).toHaveLength(0)
    expect(server.requests.filter((r) => r.model === "contentfilter-model").length).toBe(1)
  })

  test("tool calls: the app's TOOL_SPECS drive a tool_calls finish end-to-end; fragments merge; parallel calls keep index order", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    // End-to-end shape with the real specs + system prompt.
    const { TOOL_SPECS } = await import("../../../../src/agent/tools.ts")
    const e2e = await p.stream(
      {
        model: "mock",
        messages: [
          { role: "system", content: "system prompt here" },
          { role: "user", content: "cmd: echo hi" },
        ],
        tools: TOOL_SPECS,
      },
      { onDelta: () => {} },
      new AbortController().signal,
    )
    expect(e2e.finish).toBe("tool_calls")
    expect(e2e.toolCalls?.[0]?.name).toBe("shell_background")
    expect(JSON.parse(e2e.toolCalls?.[0]?.arguments ?? "{}")).toEqual({ command: "echo hi" })
    // Fragmented arguments merge into a complete call.
    const merged = await run(p, "any", new AbortController().signal, SPEC)
    const calls = merged.result.toolCalls ?? []
    expect(merged.result.finish).toBe("tool_calls")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe("shell_background")
    expect((JSON.parse(calls[0]?.arguments ?? "{}") as { command?: string }).command).toBe("echo hi")
    expect(merged.got.noTools).toBe(0)
    // Parallel calls arrive in index order.
    const parallel = await run(p, "any", new AbortController().signal, SPEC, "both: echo SEQ-A | echo SEQ-B")
    const both = parallel.result.toolCalls ?? []
    expect(both).toHaveLength(2)
    expect((JSON.parse(both[0]?.arguments ?? "{}") as { command?: string }).command).toContain("SEQ-A")
    expect((JSON.parse(both[1]?.arguments ?? "{}") as { command?: string }).command).toContain("SEQ-B")
  })

  test("reasoning_content chunks reach onReasoning (never onDelta); endpoints without them never call onReasoning", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    const withReasoning = await p.stream(
      req("mock-reasoner", undefined, "think: explain"),
      { onDelta: () => {}, onReasoning: () => {} },
      new AbortController().signal,
    )
    // Re-run with collectors to assert routing.
    const reasoning: string[] = []
    const deltas: string[] = []
    await p.stream(
      req("mock-reasoner", undefined, "think: explain"),
      { onDelta: (d) => deltas.push(d), onReasoning: (d) => reasoning.push(d) },
      new AbortController().signal,
    )
    expect(withReasoning.finish).toBe("stop")
    expect(reasoning.join("")).toContain("reasoning first")
    expect(deltas.join("")).not.toContain("reasoning first")
    expect(deltas.join("")).toContain("PLAINREPLY-OK")
    // Plain endpoints: no reasoning -> handler never fires.
    let reasoningCalls = 0
    const plain = await p.stream(
      req("mock-plain", undefined, "hello"),
      { onDelta: () => {}, onReasoning: () => reasoningCalls++ },
      new AbortController().signal,
    )
    expect(plain.finish).toBe("stop")
    expect(reasoningCalls).toBe(0)
  })

  test("wire mapping: tool-history round trip carries the OpenAI shape (camelCase never leaks); the mock validator rejects the pre-fix seam shape", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    const deltas: string[] = []
    const result = await p.stream(
      {
        model: "wire-shape",
        messages: [
          { role: "user", content: "run it" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_xyz", name: "run_command", arguments: '{"command":"echo hi"}' }],
          },
          { role: "tool", toolCallId: "call_xyz", toolName: "run_command", content: "hi" },
        ],
      },
      { onDelta: (d) => deltas.push(d) },
      new AbortController().signal,
    )
    // The mock server REJECTS schema-invalid messages (serde-style 400),
    // so a "stop" finish already proves the shape; assert the fields too.
    expect(result.finish).toBe("stop")
    expect(result.error).toBeNull()
    expect(deltas.join("")).toContain("TOOLDONE-OK")
    const hits = server.requests.filter((r) => r.model === "wire-shape")
    const wire = hits[hits.length - 1]?.wireMessages ?? []
    const tool = wire.find((m) => m["role"] === "tool")
    expect(tool?.["tool_call_id"]).toBe("call_xyz")
    expect(tool?.["content"]).toBe("hi")
    expect(tool !== undefined && "toolCallId" in tool).toBe(false)
    const assistant = wire.find((m) => m["role"] === "assistant")
    expect(assistant?.["tool_calls"]).toEqual([
      { id: "call_xyz", type: "function", function: { name: "run_command", arguments: '{"command":"echo hi"}' } },
    ])
    expect(assistant !== undefined && "toolCalls" in assistant).toBe(false)
    // The validator itself catches the pre-fix shapes (guards this harness).
    expect(wireValidationError([{ role: "tool", toolCallId: "c1", content: "x" }])).toContain("camelCase")
    expect(wireValidationError([{ role: "tool", content: "x" }])).toContain("tool_call_id")
    expect(
      wireValidationError([{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", arguments: "{}" }] }]),
    ).toContain("camelCase")
    expect(
      wireValidationError([
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      ]),
    ).toBeNull()
  })

  test("retries: a 429 with Retry-After is honored then succeeds; a dead endpoint exhausts retries and surfaces the error", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k", retryBaseDelayMs: 1 })
    const { result, got } = await run(p, "rate429-model", new AbortController().signal)
    expect(result.finish).toBe("stop")
    expect(got.deltas.join("")).toContain("PLAINREPLY-OK")
    expect(server.requests.filter((r) => r.model === "rate429-model").length).toBe(2)
    // Port with nothing listening -> fetch rejects -> retries -> error.
    const dead = new AiSdkProvider({
      baseURL: "http://127.0.0.1:9/v1",
      apiKey: "k",
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })
    const deadRun = await run(dead, "x", new AbortController().signal)
    expect(deadRun.result.finish).toBe("error")
    expect(deadRun.result.error).toContain("network")
  })

  test("no-tools degradation: a 400-on-tools retries once WITHOUT tools for that request; the session latch rides the request flag", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k", retryBaseDelayMs: 1 })
    const { result, got } = await run(p, "notools-endpoint", new AbortController().signal, [
      { type: "function", function: { name: "x" } },
    ])
    expect(result.finish).toBe("stop")
    expect(got.noTools).toBe(1)
    const hits = server.requests.filter((r) => r.model === "notools-endpoint")
    expect(hits.length).toBe(2)
    expect(hits[0]?.hasTools).toBe(true)
    expect(hits[1]?.hasTools).toBe(false) // immediate retry omitted tools
    // The provider holds NO latch of its own: a later session request with
    // tools re-sends them (the session, not the provider, owns the latch).
    const again = await run(p, "notools-endpoint", new AbortController().signal, SPEC)
    expect(again.result.finish).toBe("stop")
    expect(again.got.noTools).toBe(1)
    // A session that already latched passes `noTools`, so tools are omitted
    // from the start with no extra degradation round-trip.
    const before = server.requests.filter((r) => r.model === "notools-latched").length
    const latched = await p.stream(
      { model: "notools-latched", messages: [{ role: "user", content: "plain: hi" }], tools: SPEC, noTools: true },
      { onDelta: () => {} },
      new AbortController().signal,
    )
    expect(latched.finish).toBe("stop")
    const latchedHits = server.requests.filter((r) => r.model === "notools-latched")
    expect(latchedHits.length).toBe(before + 1) // one request, no 400 retry
    expect(latchedHits.at(-1)?.hasTools).toBe(false)
  })

  test("schema/deserialize 400s surface as errors WITHOUT no-tools degradation (regression: they merely mention 'tool')", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k", retryBaseDelayMs: 1 })
    const { result, got } = await run(p, "schema400-endpoint", new AbortController().signal, SPEC)
    expect(result.finish).toBe("error")
    expect(result.error).toContain("tool_call_id")
    expect(got.noTools).toBe(0)
    expect(server.requests.filter((r) => r.model === "schema400-endpoint").length).toBe(1) // no tool-less retry
  })

  test("abort: mid-stream reports finish aborted with partial deltas; a pre-aborted signal never hits the server", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    const controller = new AbortController()
    let delivered = 0
    let usageSeen = false
    const result = await p.stream(
      req("slow-model"),
      {
        onDelta: (d) => {
          delivered += d.length
          if (delivered > 8) controller.abort()
        },
        onUsage: () => {
          usageSeen = true
        },
      },
      controller.signal,
    )
    expect(result.finish).toBe("aborted")
    expect(delivered).toBeGreaterThan(0)
    expect(usageSeen).toBe(false)
    // Pre-aborted: nothing sent.
    const pre = new AbortController()
    pre.abort()
    const preRun = await run(p, "never-sent", pre.signal)
    expect(preRun.result.finish).toBe("aborted")
    expect(preRun.got.deltas).toHaveLength(0)
    expect(server.requests.some((r) => r.model === "never-sent")).toBe(false)
  })

  test("thinking knobs on the wire: effort -> reasoning_effort, budget -> unified reasoning object, none -> neither", async () => {
    const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
    await p.stream(
      { ...req("effort-high"), thinking: { reasoningEffort: "high" } },
      { onDelta: () => {} },
      new AbortController().signal,
    )
    expect(server.requests.filter((r) => r.model === "effort-high").pop()?.reasoningEffort).toBe("high")
    await p.stream(
      { ...req("effort-budget"), thinking: { reasoningBudgetTokens: 8192 } },
      { onDelta: () => {} },
      new AbortController().signal,
    )
    const budgetHit = server.requests.filter((r) => r.model === "effort-budget").pop()
    expect(budgetHit?.reasoningEffort).toBeNull()
    expect(budgetHit?.reasoningBody).toEqual({ maxTokens: 8192 })
    await p.stream(
      { ...req("effort-toggle"), thinking: { reasoningEnabled: true } },
      { onDelta: () => {} },
      new AbortController().signal,
    )
    const toggleHit = server.requests.filter((r) => r.model === "effort-toggle").pop()
    expect(toggleHit?.reasoningEffort).toBeNull()
    expect(toggleHit?.reasoningBody).toEqual({ enabled: true })
    await p.stream(req("effort-none"), { onDelta: () => {} }, new AbortController().signal)
    const noneHit = server.requests.filter((r) => r.model === "effort-none").pop()
    expect(noneHit?.reasoningEffort).toBeNull()
    expect(noneHit?.reasoningBody).toBeNull()
  })
})

describe("AiSdkProvider idle stream timeout", () => {
  test("a stalled endpoint times out and retries (no content delivered)", async () => {
    const stall = startStallServer([])
    try {
      const p = new AiSdkProvider({
        baseURL: stall.url,
        apiKey: "k",
        streamTimeoutMs: 100,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      })
      const { result } = await run(p, "stall-model", new AbortController().signal, SPEC)
      expect(result.finish).toBe("error")
      expect(result.error).toContain("idle timeout")
      // First attempt + 2 retries, each timing out.
      expect(stall.requestCount()).toBe(3)
    } finally {
      await stall.close()
    }
  })

  test("delivered-then-stall is NOT retried; a user abort still aborts immediately", async () => {
    const stall = startStallServer([sseContentChunk("partial answer")])
    try {
      const p = new AiSdkProvider({
        baseURL: stall.url,
        apiKey: "k",
        streamTimeoutMs: 100,
        maxRetries: 3,
        retryBaseDelayMs: 1,
      })
      const { result, got } = await run(p, "stall-after", new AbortController().signal)
      expect(result.finish).toBe("error")
      expect(result.error).toContain("idle timeout")
      expect(got.deltas.join("")).toContain("partial answer")
      // Content was delivered, so the mid-stream failure surfaces — no retry.
      expect(stall.requestCount()).toBe(1)
    } finally {
      await stall.close()
    }

    // A user Esc during a stall is an abort, not a timeout, and returns fast.
    const stall2 = startStallServer([])
    try {
      const p = new AiSdkProvider({
        baseURL: stall2.url,
        apiKey: "k",
        streamTimeoutMs: 5000,
        maxRetries: 3,
        retryBaseDelayMs: 1,
      })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 30)
      const started = Date.now()
      const { result } = await run(p, "abort-model", controller.signal)
      expect(result.finish).toBe("aborted")
      expect(Date.now() - started).toBeLessThan(2000) // not the 5s idle timeout
      expect(stall2.requestCount()).toBe(1)
    } finally {
      await stall2.close()
    }
  })

  test("a reasoning-only pre-content failure retries and announces a restart; delivered content still surfaces", async () => {
    // Reasoning is display-only: it must not block the retry the way visible
    // content does. The failed attempt's reasoning is announced for restart
    // (the consumer discards it) before the retry re-streams.
    const stall = startRetryAfterStallServer([sseReasoningChunk("stale reasoning ")])
    try {
      const p = new AiSdkProvider({
        baseURL: stall.url,
        apiKey: "k",
        streamTimeoutMs: 100,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      })
      const got = { deltas: [] as string[], reasoning: [] as string[], restarts: 0 }
      const result = await p.stream(
        req("reason-retry"),
        {
          onDelta: (d) => got.deltas.push(d),
          onReasoning: (d) => got.reasoning.push(d),
          onStreamRestart: () => got.restarts++,
        },
        new AbortController().signal,
      )
      expect(result.finish).toBe("stop")
      expect(result.error).toBeNull()
      expect(stall.requestCount()).toBe(2)
      expect(got.restarts).toBe(1)
      // Both attempts' reasoning reached the handler (discarding is the
      // consumer's job); the answer is the second attempt's.
      expect(got.reasoning.join("")).toContain("stale reasoning")
      expect(got.reasoning.join("")).toContain("fresh reasoning")
      expect(got.deltas.join("")).toContain("retry answer")
    } finally {
      await stall.close()
    }

    // Visible content delivered before the stall: the mid-stream failure
    // surfaces (no retry, no restart) exactly like the post-content stall case.
    const contentStall = startRetryAfterStallServer([sseContentChunk("partial answer")])
    try {
      const p = new AiSdkProvider({
        baseURL: contentStall.url,
        apiKey: "k",
        streamTimeoutMs: 100,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      })
      let restarts = 0
      const result = await p.stream(
        req("content-stall"),
        { onDelta: () => {}, onStreamRestart: () => restarts++ },
        new AbortController().signal,
      )
      expect(result.finish).toBe("error")
      expect(result.error).toContain("idle timeout")
      expect(restarts).toBe(0)
      expect(contentStall.requestCount()).toBe(1)
    } finally {
      await contentStall.close()
    }
  })

  test("parseStreamTimeoutMs parses the env var defensively (0 disables, invalid ignored)", () => {
    expect(parseStreamTimeoutMs(undefined)).toBeNull()
    expect(parseStreamTimeoutMs("")).toBeNull()
    expect(parseStreamTimeoutMs("garbage")).toBeNull()
    expect(parseStreamTimeoutMs("-5")).toBeNull()
    expect(parseStreamTimeoutMs("2500")).toBe(2500)
    expect(parseStreamTimeoutMs(" 80 ")).toBe(80)
    expect(parseStreamTimeoutMs("0")).toBe(0)
  })
})

describe("pure helpers", () => {
  test("parseRetryAfterSeconds handles seconds and HTTP-dates", () => {
    expect(parseRetryAfterSeconds(null)).toBeNull()
    expect(parseRetryAfterSeconds("2")).toBe(2)
    expect(parseRetryAfterSeconds("0.5")).toBe(0.5)
    expect(parseRetryAfterSeconds("garbage")).toBeNull()
    const future = new Date(Date.now() + 60_000).toUTCString()
    const v = parseRetryAfterSeconds(future) ?? -1
    expect(v).toBeGreaterThan(50)
    expect(v).toBeLessThanOrEqual(60)
  })

  test("parseRetryAfterMs reads integer milliseconds; errorInfo prefers retry-after-ms over Retry-After (both branches)", () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs("1500")).toBe(1500)
    expect(parseRetryAfterMs(" 250 ")).toBe(250)
    for (const junk of ["2.5", "-5", "garbage", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      expect(parseRetryAfterMs(junk)).toBeNull()
    }
    // Plain-object branch: ms wins; absent ms falls back to seconds * 1000.
    const msWins = errorInfo({
      statusCode: 429,
      message: "rate limited",
      responseHeaders: { "retry-after-ms": "1500", "retry-after": "2" },
    })
    expect(msWins.statusCode).toBe(429)
    expect(msWins.retryAfterMs).toBe(1500)
    const secsFallback = errorInfo({ statusCode: 429, message: "rate limited", responseHeaders: { "retry-after": "2" } })
    expect(secsFallback.retryAfterMs).toBe(2000)
    // Numeric header values are tolerated.
    expect(errorInfo({ statusCode: 429, message: "x", responseHeaders: { "retry-after-ms": 900 } }).retryAfterMs).toBe(900)
    expect(errorInfo({ statusCode: 500, message: "boom" }).retryAfterMs).toBeNull()
    // APICallError branch prefers ms too.
    const apiMs = errorInfo(
      new APICallError({
        message: "rate limited",
        url: "http://127.0.0.1/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "750", "retry-after": "5" },
      }),
    )
    expect(apiMs.statusCode).toBe(429)
    expect(apiMs.retryAfterMs).toBe(750)
    const apiSecs = errorInfo(
      new APICallError({
        message: "rate limited",
        url: "http://127.0.0.1/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after": "5" },
      }),
    )
    expect(apiSecs.retryAfterMs).toBe(5000)
  })

  test("backoffDelayMs: retryAfterMs precedence + 30s clamp, exponential growth, jitter bounds, maxMs clamp", () => {
    // Provider hint wins and is clamped at 30s; no jitter.
    expect(backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt: 0, retryAfterMs: 1234 })).toBe(1234)
    expect(backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt: 5, retryAfterMs: 60_000 })).toBe(30_000)
    expect(backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt: 0, retryAfterMs: -10 })).toBe(0)
    // Exponential growth with jitter pinned to the centre (random 0.5 => factor 1).
    const centre = (attempt: number): number => backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt, random: () => 0.5 })
    expect(centre(0)).toBe(500)
    expect(centre(1)).toBe(1000)
    expect(centre(2)).toBe(2000)
    expect(centre(3)).toBe(4000)
    // Clamped to maxMs once the exponential exceeds it.
    expect(centre(4)).toBe(8000)
    expect(centre(9)).toBe(8000)
    // ±25% jitter bounds (random 0 => 0.75x, random 1 => 1.25x).
    expect(backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt: 0, random: () => 0 })).toBe(375)
    expect(backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt: 0, random: () => 1 })).toBe(625)
    // A custom jitterRatio of 0 disables the spread.
    expect(backoffDelayMs({ baseMs: 500, maxMs: 8000, attempt: 1, jitterRatio: 0, random: () => 0 })).toBe(1000)
  })

  test("toModelMessages maps the seam shape (v7 parts, tool results, unparseable args -> {}); toToolSet converts specs and skips junk", () => {
    const msgs = toModelMessages([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "running it",
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"x"}' }],
      },
      { role: "tool", toolCallId: "c1", toolName: "read_file", content: "contents" },
      { role: "assistant", content: "done" },
    ])
    expect(msgs[0]).toEqual({ role: "system", content: "s" })
    expect(msgs[1]).toEqual({ role: "user", content: "u" })
    // v7 shape: assistant tool calls ride INSIDE the content parts array.
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "running it" },
        { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "x" } },
      ],
    })
    expect(msgs[3]).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "contents" } }],
    })
    expect(msgs[4]).toEqual({ role: "assistant", content: "done" })
    // Unparseable arguments become an empty input object.
    expect(toModelMessages([{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "f", arguments: "not json" }] }])[0])
      .toEqual({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c", toolName: "f", input: {} }],
      })
    // ToolSet: named specs convert; nameless specs and junk are skipped.
    const set = toToolSet([
      { type: "function", function: { name: "run_command", description: "d", parameters: { type: "object", properties: {} } } },
      { type: "function", function: {} }, // nameless — skipped
      "garbage", // skipped
    ])
    expect(Object.keys(set)).toEqual(["run_command"])
  })

  test("toModelMessages maps images: user attachments -> file parts; unreadable -> a text note", () => {
    const att = { id: "a1", name: "shot.png", mediaType: "image/png", bytes: 3, path: "/virtual/shot.png" }
    const bytes = new Uint8Array([1, 2, 3])
    const read = (p: string): Uint8Array | null => (p === att.path ? bytes : null)
    const filePart = { type: "file" as const, data: { type: "data" as const, data: bytes }, mediaType: "image/png", filename: "shot.png" }
    const msgs = toModelMessages([{ role: "user", content: "look at this", images: [att] }], read)
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "look at this" }, filePart] })
    // An unreadable asset degrades to a text note instead of dropping the message.
    const bad = toModelMessages([{ role: "user", content: "x", images: [{ ...att, path: "/gone.png" }] }], read)
    expect(bad[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "x" }, { type: "text", text: "[image unavailable: shot.png]" }],
    })
  })

  test("images on the wire: a user attachment becomes an image_url data URL the server accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-img-wire-"))
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      )
      const path = join(dir, "shot.png")
      writeFileSync(path, png)
      const p = new AiSdkProvider({ baseURL: server.url, apiKey: "k" })
      const result = await p.stream(
        {
          model: "plain-model",
          messages: [
            { role: "system", content: "system prompt here" },
            { role: "user", content: "look", images: [{ id: "a1", name: "shot.png", mediaType: "image/png", bytes: png.length, path }] },
          ],
        },
        { onDelta: () => {} },
        new AbortController().signal,
      )
      expect(result.finish).toBe("stop")
      expect(result.error).toBeNull()
      const recorded = server.requests.at(-1)!
      const user = recorded.wireMessages.filter((m) => m["role"] === "user").at(-1)!
      const content = user["content"] as Array<Record<string, unknown>>
      expect(Array.isArray(content)).toBe(true)
      expect(content.some((c) => c["type"] === "text" && c["text"] === "look")).toBe(true)
      const image = content.find((c) => c["type"] === "image_url")
      expect(image).toBeDefined()
      const url = (image!["image_url"] as Record<string, unknown>)["url"] as string
      expect(url.startsWith("data:image/png;base64,")).toBe(true)
      expect(url).toContain(png.toString("base64").slice(0, 24))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
