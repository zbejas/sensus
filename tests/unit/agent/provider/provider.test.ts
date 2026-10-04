import { describe, expect, test } from "bun:test"
import {
  MockProvider,
  MOCK_EXPLAIN_OK,
  MOCK_REPLY_OK,
  createProvider,
  mockReplyFor,
} from "../../../../src/agent/provider/provider.ts"
import { AiSdkProvider } from "../../../../src/agent/provider/aiSdkProvider.ts"
import { defaultEndpoint } from "../../../../src/config/config.ts"

describe("MockProvider", () => {
  test("streams the canned reply in ordered deltas (sync mode too); abort stops delivery and reports aborted", async () => {
    const p = new MockProvider({ chunkDelayMs: 0 })
    const deltas: string[] = []
    const usage: unknown[] = []
    const result = await p.stream(
      { model: "mock", messages: [{ role: "user", content: "hi" }] },
      {
        onDelta: (d) => deltas.push(d),
        onUsage: (u) => usage.push(u),
      },
      new AbortController().signal,
    )
    expect(result.finish).toBe("stop")
    expect(result.error).toBeNull()
    expect(result.usage).not.toBeNull()
    expect(deltas.length).toBeGreaterThan(1)
    expect(usage.length).toBe(1)
    // Deltas must arrive in order (the concatenation equals the reply).
    expect(deltas.join("")).toBe(mockReplyFor("hi"))
    // Synchronous mode still yields each chunk exactly once.
    const sync: string[] = []
    await new MockProvider({ chunkDelayMs: 0, chunkSize: 3 }).stream(
      { model: "m", messages: [{ role: "user", content: "sync" }] },
      { onDelta: (d) => sync.push(d) },
      new AbortController().signal,
    )
    expect(sync.join("")).toBe(mockReplyFor("sync"))
    // Abort mid-stream: partial content delivered, no usage reported.
    const slow = new MockProvider({ chunkDelayMs: 1, chunkSize: 1 })
    let delivered = 0
    let usageSeen = false
    const controller = new AbortController()
    let resolve!: (r: unknown) => void
    const done = new Promise<unknown>((res) => (resolve = res))
    void slow
      .stream(
        { model: "mock", messages: [{ role: "user", content: "hello there" }] },
        {
          onDelta: (d) => {
            delivered += d.length
            if (delivered > 20) controller.abort()
          },
          onUsage: () => {
            usageSeen = true
          },
        },
        controller.signal,
      )
      .then(resolve)
    await done
    const aborted = (await done) as { finish: string }
    expect(aborted.finish).toBe("aborted")
    expect(usageSeen).toBe(false)
    expect(delivered).toBeGreaterThan(0)
    expect(delivered).toBeLessThan(mockReplyFor("hello there").length)
  })

  test("mockReplyFor variants: 'explain:' prefix yields the multi-paragraph code-block reply; empty uses the default", () => {
    const reply = mockReplyFor("explain: how tabs work")
    expect(reply).toContain(MOCK_EXPLAIN_OK)
    expect(reply).toContain("```")
    expect(reply.split("\n").length).toBeGreaterThan(3)
    expect(mockReplyFor("")).toContain(MOCK_REPLY_OK)
  })
})

describe("createProvider (protocol factory)", () => {
  test("selects the AI SDK client per protocol kind and the mock for mock / SENSUS_MOCK=1", () => {
    for (const kind of ["openai-compatible", "openai-responses", "anthropic", "google"] as const) {
      const p = createProvider({ ...defaultEndpoint("ep"), provider: kind, apiKey: "k" })
      expect(p).toBeInstanceOf(AiSdkProvider)
      expect(p.name).toBe(kind)
    }
    expect(createProvider({ ...defaultEndpoint("m"), provider: "mock" })).toBeInstanceOf(MockProvider)

    const prev = process.env["SENSUS_MOCK"]
    process.env["SENSUS_MOCK"] = "1"
    try {
      expect(createProvider({ ...defaultEndpoint("m"), provider: "google", apiKey: "k" })).toBeInstanceOf(MockProvider)
    } finally {
      if (prev === undefined) delete process.env["SENSUS_MOCK"]
      else process.env["SENSUS_MOCK"] = prev
    }
  })
})
