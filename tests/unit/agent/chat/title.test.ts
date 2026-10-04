/**
 * Auto-title generator unit tests (docs/sessions.md "Auto titles"): the
 * one-shot request shape, cleanup, and every best-effort null path. No network
 * — a tiny fake provider drives `requestSessionTitle`.
 */

import { describe, expect, test } from "bun:test"
import { requestSessionTitle, TITLE_MAX_TOKENS } from "../../../../src/agent/chat/title.ts"
import type { ChatProvider, StreamHandlers, StreamRequest, StreamResult } from "../../../../src/agent/provider/provider.ts"

class FakeProvider implements ChatProvider {
  readonly name = "fake"
  readonly requests: StreamRequest[] = []
  constructor(
    private readonly reply: string,
    private readonly finish: StreamResult["finish"] = "stop",
  ) {}
  async stream(req: StreamRequest, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    this.requests.push(req)
    if (signal.aborted) return { finish: "aborted", usage: null, error: null }
    if (this.reply.length > 0) h.onDelta(this.reply)
    return { finish: this.finish, usage: null, error: null }
  }
}

describe("requestSessionTitle", () => {
  test("a stop stream returns the cleaned title; the request is a no-tools, no-thinking one-shot", async () => {
    const p = new FakeProvider('Title: "Deploy the alpha service"')
    const title = await requestSessionTitle({ provider: p, model: "m", userText: "how do I deploy alpha?", signal: new AbortController().signal })
    expect(title).toBe("Deploy the alpha service")
    const req = p.requests[0]
    expect(req?.model).toBe("m")
    expect(req?.maxTokens).toBe(TITLE_MAX_TOKENS)
    expect(req?.tools).toBeUndefined()
    expect(req?.thinking).toBeNull()
    expect(req?.messages[0]?.role).toBe("system")
    expect(req?.messages[1]).toEqual({ role: "user", content: "how do I deploy alpha?" })
  })

  test("error/aborted streams and unusable output return null (best-effort)", async () => {
    const signal = new AbortController().signal
    expect(await requestSessionTitle({ provider: new FakeProvider("x", "error"), model: "m", userText: "hi", signal })).toBeNull()
    expect(await requestSessionTitle({ provider: new FakeProvider("Title:", "stop"), model: "m", userText: "hi", signal })).toBeNull()
    const aborted = new AbortController()
    aborted.abort()
    expect(await requestSessionTitle({ provider: new FakeProvider("x"), model: "m", userText: "hi", signal: aborted.signal })).toBeNull()
  })
})
