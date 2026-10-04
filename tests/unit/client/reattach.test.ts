/**
 * reconnect re-attachment (D5/D12): after a transport reconnect the daemon has
 * dropped the socket's subscriptions, so every open tab re-attaches its terminal
 * (cursor-resumed replay) and chat (fresh state). Terminal failures are awaited
 * and reported so the caller can rebuild a dead shell; chat failures are
 * surfaced but never throw into the tab engine.
 */

import { describe, expect, test } from "bun:test"
import { partitionReattachTabs, reattachTabs, type ReattachableTab } from "../../../src/client/reattach.ts"

/** A fake transport capturing `chat.attach` calls (optionally rejecting). */
function fakeWs(attach: (chatId: string) => Promise<unknown>): {
  calls: string[]
  chat: { attach: (params: { chatId: string }) => Promise<unknown> }
} {
  const calls: string[] = []
  return {
    calls,
    chat: {
      attach: (params) => {
        calls.push(params.chatId)
        return attach(params.chatId)
      },
    },
  }
}

/** A fake tab recording `session.reattach` calls (optionally failing). */
function fakeTab(
  chatId: string,
  reattached: string[],
  failWith: Error | null = null,
  shellId = chatId,
): ReattachableTab {
  return {
    id: fakeTabIds++,
    chat: { chatId },
    session: {
      shellId,
      reattach: async () => {
        if (failWith !== null) throw failWith
        reattached.push(chatId)
      },
    },
  }
}

/** A transport error with the daemon's stable `code` field. */
function codedError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

let fakeTabIds = 1

describe("reattachTabs", () => {
  test("re-attaches every tab's terminal and chat", async () => {
    const ws = fakeWs(async () => ({}))
    const reattached: string[] = []
    const report = await reattachTabs(ws, [fakeTab("c1", reattached), fakeTab("c2", reattached)])
    expect(report.attempted).toBe(2)
    expect(report.terminalFailed).toEqual([])
    expect(reattached).toEqual(["c1", "c2"])
    expect(ws.calls).toEqual(["c1", "c2"])
  })

  test("a failing terminal is reported (with its code) and a rejecting chat is surfaced", async () => {
    const errors: string[] = []
    const ws = fakeWs(async (chatId) => {
      if (chatId === "bad") throw new Error("chat gone")
      return {}
    })
    const reattached: string[] = []
    const tabs = [
      fakeTab("ok", reattached),
      fakeTab("dead", reattached, codedError("shell_not_found", "boom dead")),
      fakeTab("bad", reattached),
    ]
    const report = await reattachTabs(ws, tabs, (m) => errors.push(m))
    expect(report.attempted).toBe(3)
    expect(report.terminalFailed.map((f) => [f.tab.chat.chatId, f.code])).toEqual([["dead", "shell_not_found"]])
    expect(reattached).toEqual(["ok", "bad"])
    // A dead shell's chat is not attached (it is going away with the shell).
    expect(ws.calls).toEqual(["ok", "bad"])
    expect(errors.some((m) => m.includes("boom dead"))).toBe(true)
    expect(errors.some((m) => m.includes("chat gone"))).toBe(true)
  })

  test("retries controller_taken with backoff and recovers", async () => {
    let attempts = 0
    const sleeps: number[] = []
    const tab: ReattachableTab = {
      id: 100,
      chat: { chatId: "c1" },
      session: {
        shellId: "s1",
        reattach: async () => {
          attempts += 1
          if (attempts <= 2) throw codedError("controller_taken")
        },
      },
    }
    const report = await reattachTabs(fakeWs(async () => ({})), [tab], undefined, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([100, 200])
    expect(report.terminalFailed).toEqual([])
  })

  test("gives up on controller_taken after the retry budget", async () => {
    const tab: ReattachableTab = {
      id: 101,
      chat: { chatId: "c1" },
      session: {
        shellId: "s1",
        reattach: async () => {
          throw codedError("controller_taken")
        },
      },
    }
    const report = await reattachTabs(fakeWs(async () => ({})), [tab], undefined, {
      controllerRetries: 1,
      sleep: async () => {},
    })
    expect(report.terminalFailed.map((f) => f.code)).toEqual(["controller_taken"])
  })

  test("no tabs is a no-op", async () => {
    const ws = fakeWs(async () => ({}))
    const report = await reattachTabs(ws, [])
    expect(report.attempted).toBe(0)
    expect(ws.calls).toEqual([])
  })
})

describe("partitionReattachTabs", () => {
  test("splits by the live shell set; a missing shell is rebuilt", () => {
    const tabs = [
      fakeTab("c1", [], null, "s1"),
      fakeTab("c2", [], null, "s2"),
      fakeTab("c3", [], null, "s3"),
    ]
    const { present, missing } = partitionReattachTabs(tabs, new Set(["s1", "s3"]))
    expect(present.map((t) => t.chat.chatId)).toEqual(["c1", "c3"])
    expect(missing.map((t) => t.chat.chatId)).toEqual(["c2"])
  })

  test("an unavailable listing treats every tab as present (best-effort re-attach)", () => {
    const tabs = [fakeTab("c1", [], null, "s1"), fakeTab("c2", [], null, "s2")]
    const { present, missing } = partitionReattachTabs(tabs, null)
    expect(present.map((t) => t.chat.chatId)).toEqual(["c1", "c2"])
    expect(missing).toEqual([])
  })
})
