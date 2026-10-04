/**
 * Daemon WebSocket terminal channel over the real loopback listener
 * (docs/daemon-api.md "WebSocket channels", P3c-i; D1/D4/D11/D12).
 *
 * A real `Bun.WebSocket` client drives the frozen envelope: authenticate,
 * `terminal.open`, `terminal.attach` (replay), `terminal.input` (the shell
 * echoes), `terminal.resize`, a second observer client (output but no input),
 * `terminal.handover`, detach → re-attach (replay repaints), `terminal.kill`
 * → `terminal.exit`. The no-orphan `daemon stop` assertion lives in
 * `e2e.test.ts` (it needs the spawned `serve` process).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon, type StartDaemonResult } from "../../../src/daemon/index.ts"
import type { PtySession, PtySessionOptions, TerminalStatus } from "../../../src/engine/index.ts"

const TOKEN = "daemon-ws-test-token"

interface TestDaemon {
  runtime: string
  home: string
  result: Extract<StartDaemonResult, { ok: true }>
  cleanup: () => void
}

async function startTestDaemon(
  shell = "/bin/sh",
  spawnPty?: (opts: PtySessionOptions) => PtySession,
  replayMaxBytes?: number,
): Promise<TestDaemon> {
  const runtime = mkdtempSync(join(tmpdir(), "sensus-ws-run-"))
  const home = mkdtempSync(join(tmpdir(), "sensus-ws-home-"))
  const result = await startDaemon({
    runtimeDir: runtime,
    token: TOKEN,
    home,
    shell,
    spawnPty,
    ...(replayMaxBytes !== undefined ? { replayMaxBytes } : {}),
    config: () => ({}),
    graceMs: 60_000,
  })
  if (!result.ok) {
    rmSync(runtime, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    throw new Error(result.error)
  }
  return {
    runtime,
    home,
    result,
    cleanup: () => {
      try {
        result.stop()
      } catch {
        // idempotent
      }
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
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

  private waitFor(pred: (f: Frame) => boolean, label: string, timeoutMs = 8000, fromIndex = 0): Promise<Frame> {
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

  /** A frame-count mark for `event(..., { fromIndex })` (newest-only waits). */
  mark(): number {
    return this.frames.length
  }

  request(op: string, params: Frame = {}): Promise<Frame> {
    const id = `r${++this.idc}`
    this.ws.send(JSON.stringify({ type: "req", id, op, ...params }))
    return this.waitFor((f) => f.type === "res" && f.id === id, `res ${op}`)
  }

  event(name: string, pred?: (f: Frame) => boolean, fromIndex = 0): Promise<Frame> {
    return this.waitFor((f) => f.type === "evt" && f.event === name && (pred?.(f) ?? true), `evt ${name}`, 8000, fromIndex)
  }

  /** Every decoded `terminal.output` byte for a shell, concatenated. */
  outputText(shellId: string): string {
    return this.frames
      .filter((f) => f.type === "evt" && f.event === "terminal.output" && f.shellId === shellId)
      .map((f) => Buffer.from(String(f.data), "base64").toString("utf8"))
      .join("")
  }

  /** Every `terminal.output` byte for a shell, raw (byte-transparency checks). */
  outputBytes(shellId: string): Buffer {
    return Buffer.concat(
      this.frames
        .filter((f) => f.type === "evt" && f.event === "terminal.output" && f.shellId === shellId)
        .map((f) => Buffer.from(String(f.data), "base64")),
    )
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already gone
    }
  }
}

/** Wait until `read()` is truthy (polls every 25ms). */
async function waitUntil<T>(read: () => T | null | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("waitUntil timed out")
    await Bun.sleep(25)
  }
}

/**
 * A controllable stand-in for the daemon's native PTY (P4a gap 4). It records
 * the spawn options (so a test can prove no palette was applied) and lets the
 * test push exact bytes through `onOutput`. The `as unknown as PtySession` cast
 * is justified: the registry only touches this structural subset.
 */
class FakePty {
  cols: number
  rows: number
  readonly opts: PtySessionOptions
  spawnError: string | null = null
  private readonly outCbs: Array<(bytes: Uint8Array) => void> = []
  private readonly exitCbs: Array<(code: number | null) => void> = []
  private dead = false

  constructor(opts: PtySessionOptions) {
    this.opts = opts
    this.cols = opts.cols
    this.rows = opts.rows
  }

  onOutput(cb: (bytes: Uint8Array) => void): void {
    this.outCbs.push(cb)
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb)
  }

  status(): TerminalStatus {
    return {
      dead: this.dead,
      deadStatus: null,
      cols: this.cols,
      rows: this.rows,
      cwd: "/fake",
      currentCommand: "",
      alternateOn: false,
      commandRunning: false,
      cursorX: null,
      cursorY: null,
      cursorVisible: false,
    }
  }

  write(): void {}
  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols))
    this.rows = Math.max(1, Math.floor(rows))
  }
  recentLines(): string[] {
    return []
  }
  kill(): void {
    this.dead = true
    for (const cb of this.exitCbs) cb(0)
  }

  /** Push exact output bytes (the raw PTY output). */
  emit(bytes: Uint8Array): void {
    for (const cb of this.outCbs) cb(bytes)
  }
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1/ws`
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")

describe("daemon ws: auth + upgrade", () => {
  test("bearer header and ?token are required; a non-upgrade request is refused", async () => {
    const daemon = await startTestDaemon()
    try {
      const http = `http://127.0.0.1:${daemon.result.tcp.port}/v1/ws`
      expect((await fetch(http)).status).toBe(401)
      expect((await fetch(`${http}?token=bogus`)).status).toBe(401)
      // Authenticated but no `Upgrade: websocket` header.
      expect((await fetch(http, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(426)
      expect((await fetch(`${http}?token=${TOKEN}`)).status).toBe(426)

      // A real upgrade over the header works; the query-token form works too.
      const viaHeader = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
      const viaQuery = new WsTestClient(`${wsUrl(daemon.result.tcp.port)}?token=${TOKEN}`)
      try {
        await Promise.all([viaHeader.open, viaQuery.open])
        const [h, q] = await Promise.all([viaHeader.event("hello"), viaQuery.event("hello")])
        expect(h.protocol).toBe("sensus-ws/1")
        expect(typeof h.clientId).toBe("string")
        expect(q.clientId).not.toBe(h.clientId)
      } finally {
        viaHeader.close()
        viaQuery.close()
      }
    } finally {
      daemon.cleanup()
    }
  })
})

describe("daemon ws: terminal channel", () => {
  test("open → attach → input echoes → resize → observer read-only → handover → kill", async () => {
    const daemon = await startTestDaemon()
    const controller = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    const observer = new WsTestClient(`${wsUrl(daemon.result.tcp.port)}?token=${TOKEN}`)
    try {
      await Promise.all([controller.open, observer.open])
      const controllerHello = await controller.event("hello")
      const observerHello = await observer.event("hello")

      expect((await controller.request("terminal.list")).result).toEqual({ shells: [] })

      const opened = await controller.request("terminal.open", { cols: 80, rows: 24 })
      expect(opened.ok).toBe(true)
      const shellId = String((opened.result as Frame).shellId)
      expect(shellId.length).toBeGreaterThan(0)

      // Attach as controller: the server pushes `terminal.attached` first, with
      // the (empty) replay, before the response.
      const attach = await controller.request("terminal.attach", { shellId, cols: 80, rows: 24 })
      expect(attach.ok).toBe(true)
      const attached = await controller.event("terminal.attached", (f) => f.shellId === shellId)
      expect(attached.role).toBe("controller")
      expect(attached.resetAlt).toBe(false)
      expect(attached.cols).toBe(80)
      expect(String(attached.replay)).toBe("")

      // Controller input reaches the shell and comes back on output.
      expect((await controller.request("terminal.input", { shellId, data: b64("echo CONTROLLER_MARKER\n") })).ok).toBe(true)
      await waitUntil(() => (controller.outputText(shellId).includes("CONTROLLER_MARKER") ? true : null))

      expect((await controller.request("terminal.resize", { shellId, cols: 100, rows: 30 })).ok).toBe(true)

      // Observer: gets live output, is rejected on input/resize, and a second
      // controller attach is refused.
      const observerAttach = await observer.request("terminal.attach", { shellId, role: "observer" })
      expect(observerAttach.ok).toBe(true)
      expect((observerAttach.result as Frame).role).toBe("observer")
      expect((await observer.request("terminal.input", { shellId, data: b64("nope\n") })).error).toBe("not_controller")
      expect((await observer.request("terminal.resize", { shellId, cols: 40, rows: 10 })).error).toBe("not_controller")
      expect((await observer.request("terminal.attach", { shellId, role: "controller" })).error).toBe("controller_taken")

      expect((await controller.request("terminal.input", { shellId, data: b64("echo OBSERVER_MARKER\n") })).ok).toBe(true)
      await waitUntil(() => (observer.outputText(shellId).includes("OBSERVER_MARKER") ? true : null))

      // Hand over control: the observer may then type; the old controller may not.
      const roleMark = controller.mark()
      const handover = await controller.request("terminal.handover", { shellId, to: observerHello.clientId })
      expect(handover.ok).toBe(true)
      const roleEvt = await controller.event(
        "terminal.role",
        (f) => f.shellId === shellId && f.clientId === controllerHello.clientId && f.role === "observer",
        roleMark,
      )
      expect(roleEvt.role).toBe("observer")
      expect((await observer.request("terminal.input", { shellId, data: b64("echo HANDOVER_MARKER\n") })).ok).toBe(true)
      await waitUntil(() => (observer.outputText(shellId).includes("HANDOVER_MARKER") ? true : null))
      expect((await controller.request("terminal.input", { shellId, data: b64("nope\n") })).error).toBe("not_controller")

      // Kill: attached clients see `terminal.exit`; the shell leaves the list.
      expect((await controller.request("terminal.kill", { shellId })).ok).toBe(true)
      await controller.event("terminal.exit", (f) => f.shellId === shellId)
      await observer.event("terminal.exit", (f) => f.shellId === shellId)
      expect((await observer.request("terminal.list")).result).toEqual({ shells: [] })
    } finally {
      controller.close()
      observer.close()
      daemon.cleanup()
    }
  }, 30000)

  test("detach keeps the shell alive; re-attach replays and resumes from a cursor (D4/D12)", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 60, rows: 20 })
      const shellId = String((opened.result as Frame).shellId)
      await client.request("terminal.attach", { shellId, cols: 60, rows: 20 })
      await client.event("terminal.attached", (f) => f.shellId === shellId)

      expect((await client.request("terminal.input", { shellId, data: b64("echo REPLAY_MARKER_123\n") })).ok).toBe(true)
      await waitUntil(() => (client.outputText(shellId).includes("REPLAY_MARKER_123") ? true : null))

      // Detach: the shell stays alive and listed (D4).
      expect((await client.request("terminal.detach", { shellId })).ok).toBe(true)
      const listed = (await client.request("terminal.list")).result as Frame
      const entry = (listed.shells as Frame[]).find((s) => s.shellId === shellId)
      expect(entry).toMatchObject({ alive: true, attached: false, controller: false })

      // Re-attach with cursor 0: the bounded raw replay repaints the prior
      // output and reports the absolute cursor a client resumes from (D12).
      const replayMark = client.mark()
      const reattach = await client.request("terminal.attach", { shellId, cursor: 0 })
      expect(reattach.ok).toBe(true)
      const replayEvt = await client.event("terminal.attached", (f) => f.shellId === shellId, replayMark)
      const replayText = Buffer.from(String(replayEvt.replay), "base64").toString("utf8")
      expect(replayText).toContain("REPLAY_MARKER_123")
      expect(replayEvt.replayFrom).toBe(0)
      expect(replayEvt.truncated).toBe(false)
      const cursorAfterFirst = Number(replayEvt.cursor)
      expect(cursorAfterFirst).toBeGreaterThan(0)

      // A second client produces output while the first is detached...
      await client.request("terminal.detach", { shellId })
      const other = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
      try {
        await other.open
        await other.event("hello")
        await other.request("terminal.attach", { shellId, cols: 60, rows: 20 })
        await other.event("terminal.attached", (f) => f.shellId === shellId)
        expect((await other.request("terminal.input", { shellId, data: b64("echo SECOND_MARKER_456\n") })).ok).toBe(true)
        await waitUntil(() => (other.outputText(shellId).includes("SECOND_MARKER_456") ? true : null))
        await other.request("terminal.detach", { shellId })
      } finally {
        other.close()
      }

      // ...and the first resumes from its old cursor: only the missed bytes.
      const resumeMark = client.mark()
      await client.request("terminal.attach", { shellId, cursor: cursorAfterFirst })
      const resumeEvt = await client.event("terminal.attached", (f) => f.shellId === shellId, resumeMark)
      const resumed = Buffer.from(String(resumeEvt.replay), "base64").toString("utf8")
      expect(resumeEvt.replayFrom).toBe(cursorAfterFirst)
      expect(resumeEvt.truncated).toBe(false)
      expect(resumed).toContain("SECOND_MARKER_456")
      expect(resumed).not.toContain("REPLAY_MARKER_123")
      expect(Number(resumeEvt.cursor)).toBeGreaterThan(cursorAfterFirst)

      expect((await client.request("terminal.kill", { shellId })).ok).toBe(true)
      await client.event("terminal.exit", (f) => f.shellId === shellId)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("a cursor older than the replay ring re-attaches truncated from the tail (D12)", async () => {
    let fake: FakePty | null = null
    const daemon = await startTestDaemon(
      "/bin/sh",
      (opts) => {
        fake = new FakePty(opts)
        return fake as unknown as PtySession
      },
      8,
    )
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 60, rows: 20 })
      const shellId = String((opened.result as Frame).shellId)
      await client.request("terminal.attach", { shellId, cols: 60, rows: 20 })
      await client.event("terminal.attached", (f) => f.shellId === shellId)

      // 20 bytes through an 8-byte ring: the first 12 are dropped.
      fake!.emit(Buffer.from("0123456789ABCDEFGHIJ", "utf8"))
      await waitUntil(() => (client.outputText(shellId).length >= 20 ? true : null))

      const mark = client.mark()
      await client.request("terminal.attach", { shellId, cursor: 0 })
      const evt = await client.event("terminal.attached", (f) => f.shellId === shellId, mark)
      expect(evt.truncated).toBe(true)
      expect(evt.replayFrom).toBe(12)
      expect(evt.cursor).toBe(20)
      expect(Buffer.from(String(evt.replay), "base64").toString("utf8")).toBe("CDEFGHIJ")

      await client.request("terminal.kill", { shellId })
      await client.event("terminal.exit", (f) => f.shellId === shellId)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("malformed and unknown frames become error responses, never a crash", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const unknown = await client.request("terminal.bogus")
      expect(unknown.ok).toBe(false)
      expect(unknown.error).toBe("unknown_op")
      const bad = await client.request("terminal.open", { cols: "wide", rows: 0 })
      expect(bad.ok).toBe(false)
      expect(bad.error).toBe("invalid_request")
      // The connection is still usable afterwards.
      expect((await client.request("terminal.list")).ok).toBe(true)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("chat ops share /v1/ws alongside the (unchanged) terminal ops", async () => {
    // P3c-ii extends the same endpoint; `chat.list` is empty and unknown chat
    // ids fail cleanly without ever constructing the engine ChatHost.
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      expect((await client.request("chat.list")).result).toEqual({ chats: [] })
      expect((await client.request("chat.attach", { chatId: "missing" })).error).toBe("chat_not_found")
      expect((await client.request("chat.send", { chatId: "missing", text: "hi" })).error).toBe("chat_not_found")
      expect((await client.request("chat.abort", { chatId: "missing" })).error).toBe("chat_not_found")
      expect((await client.request("approvals.answer", { chatId: "missing", callId: "c", action: "accept" })).error).toBe("chat_not_found")
      expect((await client.request("sudo.answer", { chatId: "missing", requestId: "r", password: "p" })).error).toBe("no_sudo_request")
      // The terminal channel is byte-compatible: the same ops still answer.
      expect((await client.request("terminal.list")).result).toEqual({ shells: [] })
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("daemon ws: terminal status (P4a gap 1)", () => {
  test("streams cwd via OSC 7, resize, and death; attach carries status", async () => {
    // bash is the shell whose integration installs the OSC 7 cwd reporter
    // (docs/terminal-layer.md "Shell integration").
    const shell = Bun.which("bash") ?? "/bin/bash"
    const daemon = await startTestDaemon(shell)
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellId = String((opened.result as Frame).shellId)

      // `terminal.attached` carries the status, and a terminal.status follows it.
      const attachMark = client.mark()
      expect((await client.request("terminal.attach", { shellId, cols: 80, rows: 24 })).ok).toBe(true)
      const attached = await client.event("terminal.attached", (f) => f.shellId === shellId, attachMark)
      expect((attached.status as Frame).cols).toBe(80)
      expect((attached.status as Frame).rows).toBe(24)
      const initial = await client.event("terminal.status", (f) => f.shellId === shellId, attachMark)
      expect((initial.status as Frame).cols).toBe(80)

      // `cd /tmp` reports $PWD via OSC 7 before the next prompt.
      const cdMark = client.mark()
      expect((await client.request("terminal.input", { shellId, data: b64("cd /tmp\n") })).ok).toBe(true)
      const cd = await client.event(
        "terminal.status",
        (f) => f.shellId === shellId && (f.status as Frame)?.cwd === "/tmp",
        cdMark,
      )
      expect((cd.status as Frame).cwd).toBe("/tmp")

      // Resize emits the new size.
      const resizeMark = client.mark()
      expect((await client.request("terminal.resize", { shellId, cols: 100, rows: 30 })).ok).toBe(true)
      const resized = await client.event(
        "terminal.status",
        (f) => f.shellId === shellId && (f.status as Frame)?.cols === 100 && (f.status as Frame)?.rows === 30,
        resizeMark,
      )
      expect((resized.status as Frame).rows).toBe(30)

      // Death emits a dead status before `terminal.exit`.
      const exitMark = client.mark()
      expect((await client.request("terminal.kill", { shellId })).ok).toBe(true)
      const dead = await client.event(
        "terminal.status",
        (f) => f.shellId === shellId && (f.status as Frame)?.dead === true,
        exitMark,
      )
      expect((dead.status as Frame).dead).toBe(true)
      await client.event("terminal.exit", (f) => f.shellId === shellId, exitMark)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("daemon ws: byte transparency (P4a gap 4)", () => {
  test("the streamed bytes equal the PTY output when no palette is set", async () => {
    let fake: FakePty | null = null
    const daemon = await startTestDaemon("/bin/sh", (opts) => {
      fake = new FakePty(opts)
      return fake as unknown as PtySession
    })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellId = String((opened.result as Frame).shellId)
      expect((await client.request("terminal.attach", { shellId })).ok).toBe(true)
      await client.event("terminal.attached", (f) => f.shellId === shellId)

      const raw = Buffer.from("\x1b[31mRAW-INDEXED\x1b[0m\x1b]7;file://host/raw\x07")
      fake!.emit(raw)
      const streamed = await waitUntil(() => {
        const bytes = client.outputBytes(shellId)
        return bytes.length >= raw.length ? bytes : null
      })
      // One line: the daemon is byte-transparent (no palette rewrite).
      expect(streamed.equals(raw)).toBe(true)
      // ... and the registry never handed the PTY a palette.
      expect(fake!.opts.palette ?? null).toBeNull()
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("daemon ws: pane askpass env (docs/agent.md Sudo)", () => {
  test("terminal.open spawns the pane with the daemon's SUDO_ASKPASS helper", async () => {
    let fake: FakePty | null = null
    const daemon = await startTestDaemon("/bin/sh", (opts) => {
      fake = new FakePty(opts)
      return fake as unknown as PtySession
    })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("terminal.open", { cols: 80, rows: 24 })
      expect(opened.ok).toBe(true)
      // The pane is the user's real shell: its env is fixed at spawn, so the
      // stable askpass helper path must be there for a later `sudo -A`.
      const helper = fake!.opts.env?.["SUDO_ASKPASS"]
      expect(typeof helper).toBe("string")
      expect((helper as string).length).toBeGreaterThan(0)
      await client.request("terminal.kill", { shellId: String((opened.result as Frame).shellId) })
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})
