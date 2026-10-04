/**
 * Daemon chat / approvals / sudo channel over the real loopback listener
 * (docs/daemon-api.md "Chat, approvals, sudo"; P3c-ii, IF2 chat half).
 *
 * Drives a full agent turn end to end against the REAL scripted mock OpenAI
 * server: `chat.open` → `chat.send` a `cmd:` prompt (a gated `shell_background`
 * call) → `approvals.request` → `approvals.answer accept` → the tool card
 * update + the follow-up assistant message → `chat.done` → the JSONL persisted
 * under the temp home. Also covers `chat.list|attach|detach`, the shell binding,
 * and `chat.abort` stopping a slow streaming turn.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, listSessionFiles, type SensusConfig } from "../../../src/engine/index.ts"
import { daemonLogJsonlPath, startDaemon, type StartDaemonResult } from "../../../src/daemon/index.ts"
import { flushLoggerSync, parseLogLine } from "../../../src/core/log.ts"
import { startMockOpenai, startMockModelsDev, type MockOpenaiServer } from "../../mocks/mockOpenai.ts"

const TOKEN = "daemon-chat-test-token"

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

interface TestDaemon {
  runtime: string
  home: string
  dataDir: string
  result: Extract<StartDaemonResult, { ok: true }>
  cleanup: () => void
}

async function startTestDaemon(opts: { warmCatalog?: boolean; autoTitles?: boolean } = {}): Promise<TestDaemon> {
  const runtime = mkdtempSync(join(tmpdir(), "sensus-chat-run-"))
  const home = mkdtempSync(join(tmpdir(), "sensus-chat-home-"))
  const dataDir = join(home, "data")
  // The engine ChatHost (memory/agents/session state) reads sensusHome(); point
  // it at the sandbox for the whole test, restore in cleanup.
  const prevHome = process.env["SENSUS_HOME"]
  process.env["SENSUS_HOME"] = home
  const initialConfig = mockConfig()
  if (opts.autoTitles === true) {
    initialConfig.titles.enabled = true
    // A laggy title model (the mock delays "lag*" first chunks ~2.5s) so the
    // generated title lands AFTER the main turn settles — the exact ordering
    // the daemon must still surface (no other engine event follows it).
    initialConfig.titles.model = "lag-plain"
  }
  const result = await startDaemon({
    runtimeDir: runtime,
    token: TOKEN,
    home,
    dataDir,
    initialConfig,
    chatInstanceId: "daemon-chat-test",
    config: () => ({}),
    shell: "/bin/sh",
    graceMs: 60_000,
    ...(opts.warmCatalog !== undefined ? { warmCatalog: opts.warmCatalog } : {}),
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
    dataDir,
    result,
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

/** Restore `SENSUS_HOME` after a sandboxed daemon test. */
function restoreEnvHome(prev: string | undefined): void {
  if (prev === undefined) delete process.env["SENSUS_HOME"]
  else process.env["SENSUS_HOME"] = prev
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

  /** Every decoded `terminal.output` byte for a shell, concatenated. */
  outputText(shellId: string): string {
    return this.frames
      .filter((f) => f.type === "evt" && f.event === "terminal.output" && f.shellId === shellId)
      .map((f) => Buffer.from(String(f.data), "base64").toString("utf8"))
      .join("")
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
async function waitUntil<T>(read: () => T | null | undefined, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("waitUntil timed out")
    await Bun.sleep(25)
  }
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1/ws`
}

const auth = { authorization: `Bearer ${TOKEN}` }

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")

/** The one JSONL transcript under the temp data dir (throws when none). */
function readTranscript(dataDir: string): string {
  const files = listSessionFiles(dataDir)
  const path = files[0]
  if (path === undefined) throw new Error("no transcript persisted")
  return readFileSync(path, "utf8")
}

describe("daemon chat: full gated turn over WS", () => {
  test("chat.open → chat.send → approvals.request → accept → tool card + reply + chat.done, persisted", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")

      expect((await client.request("chat.list")).result).toEqual({ chats: [] })

      // chat.open returns the full state and broadcasts a matching chat.state.
      const stateMark = client.mark()
      const opened = await client.request("chat.open", {})
      expect(opened.ok).toBe(true)
      const chatId = String((opened.result as Frame).chatId)
      const state = (opened.result as Frame).state as Frame
      expect(state).toMatchObject({ status: "idle", plan: null, pendingApproval: null, pendingSudo: null })
      expect(state.messages).toEqual([])
      const stateEvt = await client.event("chat.state", (f) => f.chatId === chatId, stateMark)
      expect((stateEvt.state as Frame).status).toBe("idle")

      const list = (await client.request("chat.list")).result as Frame
      expect((list.chats as Frame[]).find((c) => c.chatId === chatId)).toMatchObject({ status: "idle", shellId: null })

      // Send a prompt that scripts a gated shell_background call (confirm mode).
      const reqMark = client.mark()
      const sent = await client.request("chat.send", { chatId, text: "cmd:echo DAEMON-TOOL-OK" })
      expect(sent.ok).toBe(true)
      // The frozen chat.send result (P4a gap 2): accepted + the engine's mode.
      expect(sent.result).toMatchObject({ accepted: true, mode: "sent" })

      const request = await client.event("approvals.request", (f) => f.chatId === chatId, reqMark)
      expect(request.tool).toBe("shell_background")
      expect(request.destructive).toBe(false)
      expect((request.args as Frame).command).toBe("echo DAEMON-TOOL-OK")
      const callId = String(request.callId)

      // The engine is blocked on this decision; nothing ran before the answer.
      expect((await client.request("approvals.answer", { chatId, callId, action: "accept" })).ok).toBe(true)
      await client.event("approvals.resolved", (f) => f.chatId === chatId && f.callId === callId && f.action === "accept", reqMark)

      // The tool card reaches a done status with the real command output.
      const card = await client.event(
        "chat.message",
        (f) =>
          f.chatId === chatId &&
          (f.message as Frame)?.role === "tool" &&
          ((f.message as Frame).tool as Frame)?.callId === callId &&
          ((f.message as Frame).tool as Frame)?.status === "done",
        reqMark,
      )
      const tool = (card.message as Frame).tool as Frame
      expect(String(tool.output)).toContain("DAEMON-TOOL-OK")
      expect(tool.exitCode).toBe(0)

      // The model's follow-up turn completed and the turn is done.
      const delta = await client.event("chat.delta", (f) => f.chatId === chatId && f.kind === "content", reqMark)
      expect(typeof delta.text).toBe("string")
      const assistant = await client.event(
        "chat.message",
        (f) =>
          f.chatId === chatId &&
          (f.message as Frame)?.role === "assistant" &&
          String((f.message as Frame).content).includes("TOOLDONE-OK"),
        reqMark,
      )
      expect(String((assistant.message as Frame).content)).toContain("TOOLDONE-OK")
      await client.event("chat.done", (f) => f.chatId === chatId, reqMark)

      // The full turn is persisted without any UI involvement.
      const jsonl = readTranscript(daemon.dataDir)
      expect(jsonl).toContain('"type":"tool_call"')
      expect(jsonl).toContain("DAEMON-TOOL-OK")
      expect(jsonl).toContain("TOOLDONE-OK")
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("chat.abort stops a streaming turn (a lagging first chunk never lands)", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "lag-plain" })
      const chatId = String((opened.result as Frame).chatId)

      // The mock's `lag` model delays the FIRST chunk ~2.5s; abort during it.
      const sendMark = client.mark()
      expect((await client.request("chat.send", { chatId, text: "plain:ABORTME-NEVER" })).ok).toBe(true)
      await client.event("chat.status", (f) => f.chatId === chatId && f.status === "streaming", sendMark)
      expect((await client.request("chat.abort", { chatId })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatId, sendMark)

      // The turn settled back to idle and the partial turn is marked aborted.
      const state = (await client.request("chat.attach", { chatId })).result as Frame
      expect((state.state as Frame).status).toBe("idle")
      const messages = (state.state as Frame).messages as Frame[]
      const aborted = messages.find((m) => m.role === "assistant" && String(m.content).includes("aborted"))
      expect(aborted).toBeDefined()
      // The aborted turn never produced the mock's (delayed) reply text.
      expect(JSON.stringify(messages)).not.toContain("PLAINREPLY-OK")
      // The structured daemon log names WHY the turn aborted (docs/logging.md):
      // `chat.abort` is a user abort, and the session-start is recorded too.
      flushLoggerSync()
      const logRecs = readFileSync(daemonLogJsonlPath(daemon.runtime), "utf8")
        .split("\n")
        .map((line) => parseLogLine(line))
        .filter((r) => r !== null)
      expect(logRecs.some((r) => r.msg === "session started" && r.attributes?.["session"] === "daemon-chat-test")).toBe(true)
      const turnRec = logRecs.find((r) => r.msg === "turn completed" && r.attributes?.["outcome"] === "aborted")
      expect(turnRec?.component).toBe("agent.chat")
      expect(turnRec?.attributes?.["reason"]).toBe("user")
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("aborting a pending ask_user leaves the daemon alive and the next send works", async () => {
    // The reported failure: abort an ask, then send again. The ask card keeps
    // its question with no answer, so a client that still treats it as pending
    // diverts the next Enter into `chat.answerAsk` (daemon: `no_pending_ask`),
    // and a crash here would close the WS ("socket closed before a response").
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", {})
      const chatId = String((opened.result as Frame).chatId)

      // A question is put to the user and the turn parks on it.
      const askMark = client.mark()
      expect((await client.request("chat.send", { chatId, text: "ask:Which way?|left/right" })).ok).toBe(true)
      const askCard = await client.event(
        "chat.message",
        (f) =>
          f.chatId === chatId &&
          ((f.message as Frame).tool as Frame)?.name === "ask_user" &&
          ((f.message as Frame).tool as Frame)?.status === "running",
        askMark,
      )
      const askCallId = String(((askCard.message as Frame).tool as Frame).callId)
      expect(((askCard.message as Frame).tool as Frame).question).toBe("Which way?")

      // Esc: the turn winds down and the card is marked aborted (no answer).
      expect((await client.request("chat.abort", { chatId })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatId, askMark)
      const abortedCard = await client.event(
        "chat.message",
        (f) =>
          f.chatId === chatId &&
          ((f.message as Frame).tool as Frame)?.callId === askCallId &&
          ((f.message as Frame).tool as Frame)?.status === "aborted",
        askMark,
      )
      expect(((abortedCard.message as Frame).tool as Frame).answer ?? null).toBeNull()

      // The daemon and its chat survive: a fresh send still runs to completion.
      const sendMark = client.mark()
      expect((await client.request("chat.send", { chatId, text: "plain:AFTER-ABORT-OK" })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatId, sendMark)
      const reply = await client.event(
        "chat.message",
        (f) =>
          f.chatId === chatId &&
          (f.message as Frame)?.role === "assistant" &&
          String((f.message as Frame).content).includes("AFTER-ABORT-OK"),
        sendMark,
      )
      expect(String((reply.message as Frame).content)).toContain("AFTER-ABORT-OK")
      // The socket is still usable (no daemon death).
      expect((await client.request("chat.attach", { chatId })).ok).toBe(true)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("steering then aborting does not wedge the daemon (post-abort send still works)", async () => {
    // The reported sequence: steer a running turn, then abort. The aborted
    // generation re-dispatches the undrained steer as a fresh turn; the daemon
    // must stay responsive (a socket close here is what surfaced as
    // "socket closed before a response" and left the TUI frozen).
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "lag-plain" })
      const chatId = String((opened.result as Frame).chatId)

      // A lagging first chunk keeps the turn "streaming" while we steer.
      const mark = client.mark()
      expect((await client.request("chat.send", { chatId, text: "plain:TURN-ONE" })).ok).toBe(true)
      await client.event("chat.status", (f) => f.chatId === chatId && f.status === "streaming", mark)
      expect((await client.request("chat.send", { chatId, text: "plain:TURN-TWO" })).result).toMatchObject({
        accepted: true,
        mode: "steered",
      })

      // Abort mid-stream: the undrained steer becomes the next generation.
      expect((await client.request("chat.abort", { chatId })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatId, mark)

      // A fresh send after all that is still answered, and the socket lives.
      const after = client.mark()
      expect((await client.request("chat.send", { chatId, text: "plain:AFTER-STEER-ABORT" })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatId, after)
      expect((await client.request("chat.attach", { chatId })).ok).toBe(true)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("steer with no abort: the steered message reaches the model and is answered", async () => {
    // A steer accepted mid-stream must actually reach the model (drained at the
    // next safe boundary, or re-dispatched as the next generation) — not be
    // stranded as a dead user bubble.
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "lag-plain" })
      const chatId = String((opened.result as Frame).chatId)

      const mark = client.mark()
      const reqMark = server.requests.length
      expect((await client.request("chat.send", { chatId, text: "plain:STEER-BASE" })).ok).toBe(true)
      await client.event("chat.status", (f) => f.chatId === chatId && f.status === "streaming", mark)
      expect((await client.request("chat.send", { chatId, text: "plain:STEER-EXTRA" })).result).toMatchObject({
        accepted: true,
        mode: "steered",
      })

      // The steer is answered (the mock echoes the scripted text).
      const reply = await client.event(
        "chat.message",
        (f) =>
          f.chatId === chatId &&
          (f.message as Frame)?.role === "assistant" &&
          String((f.message as Frame).content).includes("STEER-EXTRA"),
        mark,
      )
      expect(String((reply.message as Frame).content)).toContain("STEER-EXTRA")
      // The model actually saw the steered user text on the wire.
      const sawSteer = server.requests.slice(reqMark).some((r) => r.userText.includes("STEER-EXTRA"))
      expect(sawSteer).toBe(true)
      // The socket is still usable.
      expect((await client.request("chat.attach", { chatId })).ok).toBe(true)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("shell binding, detach/attach, and unknown-id errors", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")

      const opened = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellId = String((opened.result as Frame).shellId)
      const chatOpen = await client.request("chat.open", { shellId })
      expect(chatOpen.ok).toBe(true)
      const chatId = String((chatOpen.result as Frame).chatId)
      const list = (await client.request("chat.list")).result as Frame
      expect((list.chats as Frame[]).find((c) => c.chatId === chatId)).toMatchObject({ shellId })

      // A second chat cannot bind the same shell (one tab = one shell = one chat).
      expect((await client.request("chat.open", { shellId })).error).toBe("shell_taken")

      // detach only stops THIS client observing; the chat survives and re-attaches.
      expect((await client.request("chat.detach", { chatId })).ok).toBe(true)
      const detached = await client.request("chat.attach", { chatId })
      expect(detached.ok).toBe(true)
      expect((detached.result as Frame).chatId).toBe(chatId)

      // Unknown ids are stable errors, never a crash.
      expect((await client.request("chat.send", { chatId: "nope", text: "hi" })).error).toBe("chat_not_found")
      expect((await client.request("chat.attach", { chatId: "nope" })).error).toBe("chat_not_found")
      expect((await client.request("approvals.answer", { chatId, callId: "nope", action: "accept" })).error).toBe("no_pending_approval")
      expect((await client.request("approvals.answer", { chatId, callId: "x", action: "maybe" })).error).toBe("invalid_request")
      expect((await client.request("chat.open", {})).ok).toBe(true)
      expect((await client.request("terminal.kill", { shellId })).ok).toBe(true)
      // Killing the shell releases its bound chat (one tab = one shell = one
      // chat): a dead shell's chat is unreachable, so it must not linger.
      const afterKill = (await client.request("chat.list")).result as Frame
      expect((afterKill.chats as Frame[]).some((c) => c.chatId === chatId)).toBe(false)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("daemon chat: terminal context wiring (P4a gap 3)", () => {
  test("a bound chat's context comes from client facts, then the scanner ring", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")

      // Facts path: an attached client's VT grid is authoritative (D2).
      const openedA = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellA = String((openedA.result as Frame).shellId)
      expect((await client.request("terminal.attach", { shellId: shellA, cols: 80, rows: 24 })).ok).toBe(true)
      await client.event("terminal.attached", (f) => f.shellId === shellA)
      expect(
        (
          await client.request("terminal.facts", {
            shellId: shellA,
            lines: ["FACTS_ONLY_LINE_ABC"],
            cursor: { x: 0, y: 0, visible: true },
          })
        ).ok,
      ).toBe(true)
      const chatA = String(((await client.request("chat.open", { shellId: shellA })).result as Frame).chatId)
      const markA = server.requests.length
      const doneA = client.mark()
      expect((await client.request("chat.send", { chatId: chatA, text: "plain:FACTSPATH" })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatA, doneA)
      const reqA = server.requests.slice(markA).find((r) => r.userText.includes("FACTSPATH"))
      expect(reqA).toBeDefined()
      expect(JSON.stringify(reqA!.wireMessages)).toContain("FACTS_ONLY_LINE_ABC")

      // Scanner fallback: no facts supplied, so the bounded text ring is used.
      const openedB = await client.request("terminal.open", { cols: 80, rows: 24 })
      const shellB = String((openedB.result as Frame).shellId)
      expect((await client.request("terminal.attach", { shellId: shellB, cols: 80, rows: 24 })).ok).toBe(true)
      await client.event("terminal.attached", (f) => f.shellId === shellB)
      expect((await client.request("terminal.input", { shellId: shellB, data: b64("echo SCANNER_ONLY_LINE_XYZ\n") })).ok).toBe(true)
      await waitUntil(() => (client.outputText(shellB).includes("SCANNER_ONLY_LINE_XYZ") ? true : null))
      const chatB = String(((await client.request("chat.open", { shellId: shellB })).result as Frame).chatId)
      const markB = server.requests.length
      const doneB = client.mark()
      expect((await client.request("chat.send", { chatId: chatB, text: "plain:SCANNERPATH" })).ok).toBe(true)
      await client.event("chat.done", (f) => f.chatId === chatB, doneB)
      const reqB = server.requests.slice(markB).find((r) => r.userText.includes("SCANNERPATH"))
      expect(reqB).toBeDefined()
      expect(JSON.stringify(reqB!.wireMessages)).toContain("SCANNER_ONLY_LINE_XYZ")

      expect((await client.request("terminal.kill", { shellId: shellA })).ok).toBe(true)
      expect((await client.request("terminal.kill", { shellId: shellB })).ok).toBe(true)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("daemon chat: chat.send mode (P4a gap 2)", () => {
  test("mirrors the engine's handleInput return (sent/empty/steered/busy)", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "lag-plain" })
      const chatId = String((opened.result as Frame).chatId)

      // Idle: the engine dispatches the line.
      const sent = await client.request("chat.send", { chatId, text: "plain:MODES" })
      expect(sent.result).toMatchObject({ accepted: true, mode: "sent" })
      // Nothing to send.
      const empty = await client.request("chat.send", { chatId, text: "" })
      expect(empty.result).toMatchObject({ accepted: false, mode: "empty" })

      // Streaming (the lag model holds the first chunk): a plain line steers
      // (the default chat.busySend); a slash command is refused as busy.
      await client.event("chat.status", (f) => f.chatId === chatId && f.status === "streaming")
      const steered = await client.request("chat.send", { chatId, text: "steer me" })
      expect(steered.result).toMatchObject({ accepted: true, mode: "steered" })
      const busy = await client.request("chat.send", { chatId, text: "/compact" })
      expect(busy.result).toMatchObject({ accepted: false, mode: "busy" })

      expect((await client.request("chat.abort", { chatId })).ok).toBe(true)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("daemon chat meta (P4c-ii)", () => {
  /** Materialize a second agent so an agent switch is observable. */
  function addCriticAgent(home: string): void {
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(
      join(home, "agents", "critic.md"),
      "---\nname: critic\ndescription: reviews code\n---\nYou are a critic.\n",
      "utf8",
    )
  }

  test("chat.state carries the meta and chat.meta updates on agent + effort change", async () => {
    const daemon = await startTestDaemon()
    addCriticAgent(daemon.home)
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")

      const opened = await client.request("chat.open", {})
      const chatId = String((opened.result as Frame).chatId)
      const meta = ((opened.result as Frame).state as Frame).meta as Frame
      expect(meta).toBeDefined()
      expect(meta).toMatchObject({
        selectedModel: "main@plain-model",
        endpointName: "main",
        modelName: "plain-model",
        hasKey: true,
        agentName: "copilot",
        approval: "confirm",
        noTools: false,
        isWorking: false,
        compacting: false,
        activeJobCount: 0,
        streamingSince: 0,
        mcpEnabled: true,
        trustPatterns: [],
        mcpStatusFacts: [],
        sessionTitle: "",
        effortSetting: "default",
        contextUsed: 0,
        cacheRead: 0,
        busyPending: { steer: 0, queue: 0 },
      })
      expect(typeof meta.modelSupportsVision).toBe("boolean")
      expect(meta.contextLimit as number).toBeGreaterThan(0)
      expect((meta.contextBreakdown as Frame).limit).toBeGreaterThan(0)
      expect(((meta.endpoint as Frame).apiKey as string)).toBe("<redacted>")
      // The resolved credential never crosses the wire.
      expect(JSON.stringify(meta)).not.toContain("chat-key")

      // Agent override applies to this chat's meta immediately.
      const opened2 = await client.request("chat.open", { agent: "critic" })
      const meta2 = ((opened2.result as Frame).state as Frame).meta as Frame
      expect(meta2.agentName).toBe("critic")
      expect(meta2.selectedModel).toBe("main@plain-model")

      // A slash send that changes the thinking mode pushes a fresh meta.
      const mark = client.mark()
      expect((await client.request("chat.send", { chatId, text: "/effort high" })).ok).toBe(true)
      const changed = await client.event(
        "chat.meta",
        (f) => f.chatId === chatId && (f.meta as Frame)?.effortSetting === "high",
        mark,
      )
      expect((changed.meta as Frame).effortSetting).toBe("high")
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("accepting a card with trust emits chat.meta carrying the trusted pattern", async () => {
    const daemon = await startTestDaemon()
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", {})
      const chatId = String((opened.result as Frame).chatId)
      const meta0 = ((opened.result as Frame).state as Frame).meta as Frame
      expect((meta0.trustPatterns as Frame[]).length).toBe(0)

      const reqMark = client.mark()
      expect((await client.request("chat.send", { chatId, text: "cmd:echo META-TRUST-OK" })).ok).toBe(true)
      const request = await client.event("approvals.request", (f) => f.chatId === chatId, reqMark)
      const callId = String(request.callId)

      const metaMark = client.mark()
      expect((await client.request("approvals.answer", { chatId, callId, action: "accept", trust: true })).ok).toBe(true)
      const changed = await client.event(
        "chat.meta",
        (f) => f.chatId === chatId && (((f.meta as Frame).trustPatterns as Frame[])?.length ?? 0) > 0,
        metaMark,
      )
      const patterns = (changed.meta as Frame).trustPatterns as Frame[]
      expect(patterns[0]?.tool).toBe("shell_background")
      expect(String(patterns[0]?.prefix)).toContain("echo")
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("the async auto title lands after the turn settles and pushes chat.meta", async () => {
    // Regression: the generated title resolves after `chat.done`, so no other
    // engine event follows it. The title must still surface as a `chat.meta`
    // (docs/sessions.md "Auto titles") or the tab never retitles.
    const daemon = await startTestDaemon({ autoTitles: true })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", {})
      const chatId = String((opened.result as Frame).chatId)

      const mark = client.mark()
      // `plain:` forces a text-only reply (no tool gate) so the turn settles.
      expect((await client.request("chat.send", { chatId, text: "plain:help me deploy the alpha service" })).ok).toBe(true)
      // The derived first-message title is the immediate placeholder.
      const attached = (await client.request("chat.attach", { chatId })).result as Frame
      const derived = String(((attached.state as Frame).meta as Frame).sessionTitle)
      expect(derived).toContain("deploy the alpha service")
      // Wait for the whole turn, so the generated title cannot ride a
      // streaming event; it lands ~2.5s later on the lagging title model.
      await client.event("chat.done", (f) => f.chatId === chatId, mark)
      const titled = await client.event(
        "chat.meta",
        (f) => f.chatId === chatId && String((f.meta as Frame).sessionTitle ?? "").length > 0 && (f.meta as Frame).sessionTitle !== derived,
        mark,
      )
      // The model-generated title (not the derived placeholder) replaced it.
      expect(String((titled.meta as Frame).sessionTitle)).not.toBe(derived)
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("the daemon warms models.dev at boot: a fresh home resolves reasoning metadata", async () => {
    // A fresh sandbox home has no models.dev cache. The daemon's boot warm must
    // fetch the index (docs/config.md "Model catalog cache": warmed at boot) so
    // a session resolves the model's reasoning metadata / context window without
    // opening the model picker first. `SENSUS_MODELS_DEV_URL` points the warm at
    // the mock index; without the warm, `modelMeta` stays null forever.
    const modelsDev = await startMockModelsDev()
    const prevUrl = process.env["SENSUS_MODELS_DEV_URL"]
    process.env["SENSUS_MODELS_DEV_URL"] = modelsDev.url
    const daemon = await startTestDaemon({ warmCatalog: true })
    const client = new WsTestClient(wsUrl(daemon.result.tcp.port), auth)
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "main@mock-gpt-large" })
      const chatId = String((opened.result as Frame).chatId)

      // The boot warm is fire-and-forget; poll until the session's metadata
      // lands (the version bump re-resolves a session that opened pre-fetch).
      const deadline = Date.now() + 8000
      let meta: Frame | null = null
      for (;;) {
        const state = (await client.request("chat.attach", { chatId })).result as Frame
        meta = (state.state as Frame).meta as Frame
        const modelMeta = meta.modelMeta as Frame | null
        if (modelMeta !== null && modelMeta !== undefined) {
          expect(modelMeta.reasoning).toBe(true)
          expect(String(modelMeta.id)).toBe("mock-gpt-large")
          break
        }
        if (Date.now() >= deadline) throw new Error("models.dev metadata never resolved — the daemon did not warm the cache")
        await Bun.sleep(100)
      }
    } finally {
      client.close()
      daemon.cleanup()
      if (prevUrl === undefined) delete process.env["SENSUS_MODELS_DEV_URL"]
      else process.env["SENSUS_MODELS_DEV_URL"] = prevUrl
      await modelsDev.close()
    }
  }, 30000)
})

