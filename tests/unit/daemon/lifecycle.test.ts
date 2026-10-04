/**
 * Daemon lifetime policy (P3c-iii; docs/daemon-api.md "Lifecycle", D3/D4/D9/
 * D10/D21). Two layers:
 *
 *  - the pure helpers and the `DaemonLifecycle` state machine with injected
 *    deps (fast, deterministic timing);
 *  - a real daemon over the loopback listener: no-client idle exit, a
 *    reconnect cancelling the grace clock, a DETACHED turn keeping the daemon
 *    alive past the window and exiting only once it settles, and a no-client
 *    approval that holds then aborts with the call denied.
 *
 * Every daemon is stopped in `finally`; shells are only spawned by the terminal
 * tests, so the suite stays orphan-free.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DaemonLifecycle,
  versionMismatchAction,
  resolveApprovalTimeoutMs,
  resolvePersistent,
  resolveReattachMaxAgeMs,
  startDaemon,
  type StartDaemonResult,
} from "../../../src/daemon/index.ts"
import { defaultConfig, type SensusConfig } from "../../../src/engine/index.ts"
import { startMockOpenai, type MockOpenaiServer } from "../../mocks/mockOpenai.ts"

const TOKEN = "daemon-lifecycle-test-token"

let server: MockOpenaiServer

beforeAll(async () => {
  server = await startMockOpenai()
})

afterAll(async () => {
  await server.close()
})

/** A config pointed at the mock endpoint, deterministic (no auto-title). */
function mockConfig(): SensusConfig {
  const cfg = defaultConfig()
  cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, baseURL: server.url, apiKey: "chat-key", maxTokens: 128 }
  cfg.model = "main@plain-model"
  cfg.titles.enabled = false
  return cfg
}

/** Wait until `predicate()` is true (polls every 25ms). The predicate may be
 * async (e.g. an RPC per poll). */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(25)
  }
  throw new Error("waitUntil timed out")
}

type Frame = Record<string, unknown>

/** A small typed WS test client: request/response correlation + event waits. */
class WsTestClient {
  private readonly ws: WebSocket
  private readonly frames: Frame[] = []
  private readonly waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  private idc = 0
  readonly open: Promise<void>

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = headers !== undefined ? new WebSocket(url, { headers }) : new WebSocket(url)
    this.open = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000)
      this.ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      })
      this.ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("ws error"))
      })
    })
    this.ws.addEventListener("message", (e) => this.onMessage(String((e as MessageEvent).data)))
  }

  private onMessage(raw: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      return
    }
    this.frames.push(frame)
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i]
      if (waiter !== undefined && waiter.match(frame)) {
        this.waiters.splice(i, 1)
        i--
        waiter.resolve(frame)
      }
    }
  }

  private waitFor(pred: (f: Frame) => boolean, label: string, timeoutMs = 10000, fromIndex = 0): Promise<Frame> {
    const found = this.frames.slice(fromIndex).find(pred)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
      this.waiters.push({
        match: pred,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
      })
    })
  }

  mark(): number {
    return this.frames.length
  }

  request(op: string, params: Frame = {}): Promise<Frame> {
    const id = `r${++this.idc}`
    this.ws.send(JSON.stringify({ type: "req", id, op, ...params }))
    return this.waitFor((f) => f.type === "res" && f.id === id, `res ${op}`)
  }

  event(name: string, pred?: (f: Frame) => boolean, fromIndex = 0): Promise<Frame> {
    return this.waitFor((f) => f.type === "evt" && f.event === name && (pred?.(f) ?? true), `evt ${name}`, 10000, fromIndex)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already gone
    }
  }
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1/ws`
}

const auth = { authorization: `Bearer ${TOKEN}` }

interface TestDaemon {
  runtime: string
  home: string
  result: Extract<StartDaemonResult, { ok: true }>
  exited: () => boolean
  cleanup: () => void
}

async function startTestDaemon(opts: { graceMs: number; approvalTimeoutMs?: number; chats?: boolean; persistent?: boolean; reattachMaxAgeMs?: number; reapIntervalMs?: number }): Promise<TestDaemon> {
  const runtime = mkdtempSync(join(tmpdir(), "sensus-lifecycle-run-"))
  const home = mkdtempSync(join(tmpdir(), "sensus-lifecycle-home-"))
  const prevHome = process.env["SENSUS_HOME"]
  process.env["SENSUS_HOME"] = home
  let idleExited = false
  const result = await startDaemon({
    runtimeDir: runtime,
    token: TOKEN,
    home,
    argv: [],
    shell: "/bin/sh",
    graceMs: opts.graceMs,
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 60_000,
    // Explicit so an inherited SENSUS_DAEMON_PERSISTENT cannot change the test.
    persistent: opts.persistent ?? false,
    // Default the reaper off unless a test opts in, so it never races the
    // unrelated lifecycle tests.
    reattachMaxAgeMs: opts.reattachMaxAgeMs ?? 0,
    ...(opts.reapIntervalMs !== undefined ? { reapIntervalMs: opts.reapIntervalMs } : {}),
    onIdleExit: () => {
      idleExited = true
    },
    ...(opts.chats === true ? { dataDir: join(home, "data"), initialConfig: mockConfig(), chatInstanceId: "daemon-lifecycle-test" } : {}),
  })
  if (!result.ok) {
    restoreEnvHome(prevHome)
    rmSync(runtime, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    throw new Error(result.error)
  }
  return {
    runtime,
    home,
    result,
    exited: () => idleExited,
    cleanup: () => {
      try {
        result.stop()
      } catch {
        // idempotent
      }
      restoreEnvHome(prevHome)
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function restoreEnvHome(prev: string | undefined): void {
  if (prev === undefined) delete process.env["SENSUS_HOME"]
  else process.env["SENSUS_HOME"] = prev
}

describe("daemon lifecycle: pure helpers", () => {
  test("versionMismatchAction (D21)", () => {
    expect(versionMismatchAction("0.0.77", "0.0.77", 0)).toBe("ok")
    expect(versionMismatchAction("0.0.77", "0.0.77", 3)).toBe("ok")
    expect(versionMismatchAction("0.0.78", "0.0.77", 0)).toBe("restart")
    expect(versionMismatchAction("0.0.78", "0.0.77", 2)).toBe("warn")
  })

  test("resolvePersistent: env truthy spellings and the config flag", () => {
    expect(resolvePersistent({}, false)).toBe(false)
    expect(resolvePersistent({ SENSUS_DAEMON_PERSISTENT: "1" }, false)).toBe(true)
    expect(resolvePersistent({ SENSUS_DAEMON_PERSISTENT: "TRUE" }, false)).toBe(true)
    expect(resolvePersistent({ SENSUS_DAEMON_PERSISTENT: "0" }, true)).toBe(true)
    expect(resolvePersistent({ SENSUS_DAEMON_PERSISTENT: "no" }, true)).toBe(true)
    expect(resolvePersistent({ SENSUS_DAEMON_PERSISTENT: "maybe" }, false)).toBe(false)
  })

  test("resolveApprovalTimeoutMs: default 60s, override, invalid keeps default", () => {
    expect(resolveApprovalTimeoutMs({})).toBe(60_000)
    expect(resolveApprovalTimeoutMs({ SENSUS_DAEMON_APPROVAL_TIMEOUT_MS: "250" })).toBe(250)
    expect(resolveApprovalTimeoutMs({ SENSUS_DAEMON_APPROVAL_TIMEOUT_MS: "nope" })).toBe(60_000)
    expect(resolveApprovalTimeoutMs({ SENSUS_DAEMON_APPROVAL_TIMEOUT_MS: "-5" })).toBe(60_000)
  })

  test("resolveReattachMaxAgeMs: default 8h, override, invalid keeps default, 0 disables", () => {
    expect(resolveReattachMaxAgeMs({})).toBe(8 * 60 * 60 * 1000)
    expect(resolveReattachMaxAgeMs({ SENSUS_DAEMON_REATTACH_MAX_AGE_MS: "1000" })).toBe(1000)
    expect(resolveReattachMaxAgeMs({ SENSUS_DAEMON_REATTACH_MAX_AGE_MS: "0" })).toBe(0)
    expect(resolveReattachMaxAgeMs({ SENSUS_DAEMON_REATTACH_MAX_AGE_MS: "nope" })).toBe(8 * 60 * 60 * 1000)
    expect(resolveReattachMaxAgeMs({ SENSUS_DAEMON_REATTACH_MAX_AGE_MS: "-5" })).toBe(8 * 60 * 60 * 1000)
  })
})

describe("daemon lifecycle: state machine", () => {
  function lifecycle(
    overrides: Partial<ConstructorParameters<typeof DaemonLifecycle>[0]> & { running?: () => boolean } = {},
  ): { lc: DaemonLifecycle; events: string[] } {
    const events: string[] = []
    const { running, ...rest } = overrides
    const lc = new DaemonLifecycle({
      graceMs: 40,
      approvalTimeoutMs: 30,
      persistent: false,
      anyTurnRunning: running ?? (() => false),
      pendingPromptChats: () => [],
      denyPending: () => true,
      abortTurn: () => {},
      shutdown: () => events.push("shutdown"),
      ...rest,
    })
    return { lc, events }
  }

  test("a daemon with no client idle-exits; a connected client cancels the clock", async () => {
    const { lc, events } = lifecycle()
    lc.start()
    await Bun.sleep(120)
    expect(events).toEqual(["shutdown"])

    // Reconnect-before-expiry keeps it alive, then a disconnect re-arms.
    const second = lifecycle()
    second.lc.start()
    second.lc.clientConnected()
    await Bun.sleep(120)
    expect(second.events).toEqual([])
    second.lc.clientGone({ remaining: 0, orphanedChats: [] })
    await Bun.sleep(120)
    expect(second.events).toEqual(["shutdown"])
    lc.stop()
    second.lc.stop()
  })

  test("a detached turn keeps it alive past the window; exits only after it settles", async () => {
    let running = true
    const { lc, events } = lifecycle({ running: () => running })
    lc.start()
    lc.clientGone({ remaining: 0, orphanedChats: [] })
    await Bun.sleep(120)
    expect(events).toEqual([])
    running = false
    lc.onChatEvent("c1", { kind: "status", status: "idle" })
    await Bun.sleep(120)
    expect(events).toEqual(["shutdown"])
    lc.stop()
  })

  test("a live pane pins the daemon past the window; losing the last shell re-arms the clock", async () => {
    let shells = 1
    const { lc, events } = lifecycle({ hasLiveShells: () => shells > 0 })
    lc.start()
    lc.clientGone({ remaining: 0, orphanedChats: [] })
    await Bun.sleep(120)
    // The pane is the user's terminal: the daemon holds rather than reaping it.
    expect(events).toEqual([])
    // The last shell exits -> the idle clock runs again and the daemon exits.
    shells = 0
    lc.shellsChanged()
    await Bun.sleep(120)
    expect(events).toEqual(["shutdown"])
    lc.stop()
  })

  test("present clients keep it alive; a persistent daemon never exits", async () => {
    const persistent = lifecycle({ persistent: true })
    persistent.lc.start()
    await Bun.sleep(120)
    expect(persistent.events).toEqual([])
    persistent.lc.stop()

    const present = lifecycle()
    present.lc.start()
    present.lc.clientConnected()
    present.lc.clientConnected()
    await Bun.sleep(120)
    expect(present.events).toEqual([])
    present.lc.stop()
  })

  test("a no-client prompt holds, then is denied and the turn aborted (D10)", async () => {
    const denied: string[] = []
    const aborted: string[] = []
    let pending = ["c1"]
    const { lc } = lifecycle({
      pendingPromptChats: () => pending,
      anyTurnRunning: () => pending.length > 0,
      denyPending: (id) => {
        denied.push(id)
        pending = []
        return true
      },
      abortTurn: (id) => aborted.push(id),
    })
    lc.start()
    await Bun.sleep(15)
    // Still held — never declined the instant the client left.
    expect(denied).toEqual([])
    await Bun.sleep(80)
    expect(denied).toEqual(["c1"])
    expect(aborted).toEqual(["c1"])
    lc.stop()
  })

  test("a resolving client that leaves while others remain denies the orphan at once", () => {
    const denied: string[] = []
    const { lc } = lifecycle({
      pendingPromptChats: () => ["c1"],
      denyPending: (id) => {
        denied.push(id)
        return true
      },
    })
    lc.start()
    lc.clientConnected()
    lc.clientConnected()
    lc.clientGone({ remaining: 1, orphanedChats: ["c1"] })
    expect(denied).toEqual(["c1"])
    lc.stop()
  })

  test("the idle reaper runs at startup and on the interval, and stops with the daemon", async () => {
    const reaped: number[] = []
    const { lc } = lifecycle({
      reattachMaxAgeMs: 1000,
      reapIntervalMs: 30,
      reapIdleShells: (maxIdleMs) => reaped.push(maxIdleMs),
    })
    lc.start()
    // One immediate reap at startup.
    expect(reaped).toEqual([1000])
    await Bun.sleep(100)
    // The interval fired a few more times with the same window.
    expect(reaped.length).toBeGreaterThan(1)
    expect(reaped.every((m) => m === 1000)).toBe(true)
    const afterStop = reaped.length
    lc.stop()
    await Bun.sleep(80)
    // No ticks after stop.
    expect(reaped.length).toBe(afterStop)
  })

  test("the reaper is inert without a window or a reap callback", async () => {
    const reaped: number[] = []
    const noWindow = lifecycle({ reapIdleShells: (m) => reaped.push(m), reapIntervalMs: 20 })
    noWindow.lc.start()
    const noCallback = lifecycle({ reattachMaxAgeMs: 1000, reapIntervalMs: 20 })
    noCallback.lc.start()
    await Bun.sleep(80)
    expect(reaped).toEqual([])
    noWindow.lc.stop()
    noCallback.lc.stop()
  })
})

describe("daemon lifecycle: real daemon", () => {
  test("no clients: idle-exits after the grace window and removes the socket", async () => {
    const daemon = await startTestDaemon({ graceMs: 150 })
    try {
      await waitUntil(() => daemon.exited(), 5000)
      expect(existsSync(daemon.result.unix)).toBe(false)
      // stop() stays idempotent after an idle exit.
      daemon.result.stop()
    } finally {
      daemon.cleanup()
    }
  }, 15000)

  test("a persistent daemon never grace-exits even with no client (D3/D9)", async () => {
    const daemon = await startTestDaemon({ graceMs: 150, persistent: true })
    try {
      // Well past the grace window: still alive (the timer never arms).
      await Bun.sleep(700)
      expect(daemon.exited()).toBe(false)
      expect(existsSync(daemon.result.unix)).toBe(true)
    } finally {
      daemon.cleanup()
    }
  }, 15000)

  test("the idle reaper kills a shell left unattended past the re-attach window", async () => {
    // Persistent so the daemon stays up while the shell is killed; a tiny
    // window + fast tick keep the test quick.
    const daemon = await startTestDaemon({ graceMs: 60_000, persistent: true, reattachMaxAgeMs: 60, reapIntervalMs: 40 })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellId = String((opened.result as Frame).shellId)
      // Never attached: it is born inactive, so the reaper reclaims it. The
      // exit is not fanned to an unattached client, so poll the list.
      await waitUntil(async () => {
        const listed = (await client.request("terminal.list")).result as Frame
        return !(listed.shells as Frame[]).some((s) => s.shellId === shellId)
      }, 8000)
      const listed = (await client.request("terminal.list")).result as Frame
      expect((listed.shells as Frame[]).some((s) => s.shellId === shellId)).toBe(false)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 20000)

  test("the reaper leaves an attached shell alone while a client watches it", async () => {
    const daemon = await startTestDaemon({ graceMs: 60_000, persistent: true, reattachMaxAgeMs: 60, reapIntervalMs: 40 })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellId = String((opened.result as Frame).shellId)
      await client.request("terminal.attach", { shellId, cols: 80, rows: 24 })
      await client.event("terminal.attached", (f) => f.shellId === shellId)
      // Hold the atttachment well past the (tiny) window: it must survive.
      await Bun.sleep(400)
      const listed = (await client.request("terminal.list")).result as Frame
      const entry = (listed.shells as Frame[]).find((s) => s.shellId === shellId)
      expect(entry).toBeDefined()
      expect(entry?.attached).toBe(true)
      expect(entry?.lastDetachedAt).toBeNull()
      await client.request("terminal.kill", { shellId })
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 20000)

  test("a reconnecting client cancels the timer; a later disconnect re-arms it", async () => {
    const daemon = await startTestDaemon({ graceMs: 500 })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await Bun.sleep(120)
      await client.open
      await client.event("hello")
      await Bun.sleep(700)
      expect(daemon.exited()).toBe(false)
    } finally {
      client.close()
    }
    await waitUntil(() => daemon.exited(), 5000)
    daemon.cleanup()
  }, 15000)

  test("a detached turn keeps the daemon alive past the grace window; it exits once the turn settles", async () => {
    const daemon = await startTestDaemon({ graceMs: 400, chats: true })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "lag-plain" })
      const chatId = String((opened.result as Frame).chatId)
      // `lag-plain` delays the first chunk ~2.5s — the turn runs detached well
      // past the 400ms grace window.
      expect((await client.request("chat.send", { chatId, text: "plain:DETACHED-TURN" })).ok).toBe(true)
      await client.event("chat.status", (f) => f.chatId === chatId && f.status === "streaming")
      client.close()
      // Past the grace window, but the turn is still running: no exit.
      await Bun.sleep(900)
      expect(daemon.exited()).toBe(false)
      // Once the detached turn settles, the grace clock runs and it exits.
      await waitUntil(() => daemon.exited(), 8000)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 20000)

  test("a no-client approval holds, then aborts after the timeout with the call denied", async () => {
    const daemon = await startTestDaemon({ graceMs: 60_000, approvalTimeoutMs: 400, chats: true })
    const first = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    let chatId = ""
    let callId = ""
    try {
      await first.open
      await first.event("hello")
      const opened = await first.request("chat.open", {})
      chatId = String((opened.result as Frame).chatId)
      const sent = await first.request("chat.send", { chatId, text: "cmd:echo SHOULD-NOT-RUN" })
      expect(sent.ok).toBe(true)
      const request = await first.event("approvals.request", (f) => f.chatId === chatId)
      callId = String(request.callId)
      first.close()
    } finally {
      first.close()
    }

    // Before the timeout, a reconnect still sees the card pending (it HELD).
    const probe = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await probe.open
      await probe.event("hello")
      const state = (await probe.request("chat.attach", { chatId })).result as Frame
      expect((state.state as Frame).pendingApproval).not.toBeNull()
    } finally {
      probe.close()
    }

    // After the hold times out the turn aborts and the call is denied; a fresh
    // client sees an idle chat with a rejected card and no output.
    await Bun.sleep(900)
    const observer = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await observer.open
      await observer.event("hello")
      const state = (await observer.request("chat.attach", { chatId })).result as Frame
      expect((state.state as Frame).status).toBe("idle")
      const messages = (state.state as Frame).messages as Frame[]
      const card = messages.find((m) => m.role === "tool" && ((m.tool as Frame)?.callId ?? "") === callId)
      expect(card).toBeDefined()
      expect((card?.tool as Frame).status).toBe("rejected")
      expect(String((card?.tool as Frame).output ?? "")).not.toContain("SHOULD-NOT-RUN")
      expect(JSON.stringify(messages)).not.toContain("TOOLDONE-OK")
    } finally {
      observer.close()
      daemon.cleanup()
    }
  }, 25000)
})
