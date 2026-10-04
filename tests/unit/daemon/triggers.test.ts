/**
 * Local condition triggers (P6; docs/triggers.md): pure rule matching, the
 * bounded `triggers.jsonl` writer, the `EventSink` decoration that feeds it
 * from the v1 stream, and a real daemon where an emitted `error.raised` fires a
 * `trigger` WS event and lands in the log.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  TriggerEngine,
  createTriggerSink,
  matchRule,
  matchTrigger,
  startDaemon,
  type StartDaemonResult,
} from "../../../src/daemon/index.ts"
import {
  defaultConfig,
  toEventV1,
  triggersPath,
  type EventSink,
  type EventV1,
  type SensusEvent,
  type SensusConfig,
} from "../../../src/engine/index.ts"

const TOKEN = "daemon-triggers-test-token"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readLines(path: string): Array<Record<string, unknown>> {
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const errorEvent = (over: Partial<EventV1> = {}): EventV1 =>
  ({ v: 1, ts: 10, instanceId: "inst", session: "s1", type: "error.raised", source: "provider", message: "boom", ...over }) as EventV1

const toolEvent = (tool: string, session = "s1", ts = 20): EventV1 =>
  ({
    v: 1,
    ts,
    instanceId: "inst",
    session,
    type: "tool.executed",
    tool,
    command: "echo hi",
    ok: true,
    approval: "confirm",
    agent: "copilot",
    cwd: null,
    shell: "bash",
  }) as EventV1

describe("trigger matching (pure)", () => {
  test("matchRule: event type, wildcard, and the tool/session filters", () => {
    expect(matchRule({ on: "error.raised" }, errorEvent())).toBe(true)
    expect(matchRule({ on: "error.raised" }, toolEvent("shell_background"))).toBe(false)
    expect(matchRule({ on: "*" }, toolEvent("shell_background"))).toBe(true)
    expect(matchRule({ on: "tool.executed", tool: "shell_background" }, toolEvent("shell_background"))).toBe(true)
    expect(matchRule({ on: "tool.executed", tool: "read_file" }, toolEvent("shell_background"))).toBe(false)
    expect(matchRule({ on: "error.raised", session: "s1" }, errorEvent())).toBe(true)
    expect(matchRule({ on: "error.raised", session: "other" }, errorEvent())).toBe(false)
    // `tool` never matches a non-tool event even with a wildcard `on`.
    expect(matchRule({ on: "*", tool: "x" }, errorEvent({ tool: undefined }))).toBe(false)
  })

  test("matchTrigger: the FIRST matching rule wins; no match is -1", () => {
    expect(matchTrigger([], errorEvent())).toBe(-1)
    expect(matchTrigger([{ on: "tool.executed" }], errorEvent())).toBe(-1)
    expect(matchTrigger([{ on: "error.raised" }], errorEvent())).toBe(0)
    expect(matchTrigger([{ on: "tool.executed" }, { on: "error.raised" }], errorEvent())).toBe(1)
    expect(matchTrigger([{ on: "*" }, { on: "error.raised" }], errorEvent())).toBe(0)
  })
})

describe("TriggerEngine: bounded local log", () => {
  test("writes one record per match, only for matching events, and calls onMatch", () => {
    const dir = tempDir("sensus-triggers-")
    try {
      const matched: Array<Record<string, unknown>> = []
      const engine = new TriggerEngine({
        rules: [{ on: "error.raised" }],
        path: join(dir, "triggers.jsonl"),
        onMatch: (r) => matched.push(r as unknown as Record<string, unknown>),
      })
      expect(engine.handle(toolEvent("shell_background"))).toBeNull()
      expect(matched).toHaveLength(0)
      const record = engine.handle(errorEvent())
      expect(record).not.toBeNull()
      expect(record?.on).toBe("error.raised")
      expect(record?.rule).toBe(0)
      expect(record?.ts).toBe(10)
      expect(matched).toHaveLength(1)
      engine.flushSync()
      const lines = readLines(join(dir, "triggers.jsonl"))
      expect(lines).toHaveLength(1)
      expect(lines[0]?.v).toBe(1)
      expect(lines[0]?.on).toBe("error.raised")
      expect((lines[0]?.event as Record<string, unknown>).type).toBe("error.raised")
      expect((lines[0]?.event as Record<string, unknown>).message).toBe("boom")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("drops the oldest past the queue cap (bounded memory)", () => {
    const dir = tempDir("sensus-triggers-")
    try {
      const path = join(dir, "triggers.jsonl")
      const engine = new TriggerEngine({ rules: [{ on: "error.raised" }], path, queueMax: 2 })
      for (let i = 0; i < 4; i++) engine.handle(errorEvent({ ts: i, message: `m${i}` }))
      expect(engine.pendingCount()).toBe(2)
      engine.flushSync()
      const lines = readLines(path)
      expect(lines).toHaveLength(2)
      expect((lines[0]?.event as Record<string, unknown>).message).toBe("m2")
      expect((lines[1]?.event as Record<string, unknown>).message).toBe("m3")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rotates at the byte cap and never throws on an unwritable destination", () => {
    const dir = tempDir("sensus-triggers-")
    try {
      const path = join(dir, "triggers.jsonl")
      const engine = new TriggerEngine({ rules: [{ on: "error.raised" }], path, maxBytes: 200 })
      for (let i = 0; i < 20; i++) engine.handle(errorEvent({ ts: i }))
      engine.flushSync()
      engine.handle(errorEvent({ ts: 999 }))
      engine.flushSync()
      expect(existsSync(`${path}.1`)).toBe(true)

      const fileAsDir = join(dir, "afile")
      writeFileSync(fileAsDir, "x")
      const broken = new TriggerEngine({ rules: [{ on: "error.raised" }], path: join(fileAsDir, "nested", "triggers.jsonl") })
      expect(() => {
        broken.handle(errorEvent())
        broken.flushSync()
      }).not.toThrow()
      expect(broken.pendingCount()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("setRules applies a config reload; an empty rule list is a no-op", () => {
    const dir = tempDir("sensus-triggers-")
    try {
      const engine = new TriggerEngine({ rules: [], path: join(dir, "triggers.jsonl") })
      expect(engine.handle(errorEvent())).toBeNull()
      engine.setRules([{ on: "error.raised" }])
      expect(engine.handle(errorEvent())).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createTriggerSink feeds the engine from the v1 stream", () => {
  test("projects the seam event and still forwards to the decorated sink", () => {
    const dir = tempDir("sensus-triggers-")
    try {
      const seen: SensusEvent[] = []
      const inner: EventSink = { emit: (e) => seen.push(e) }
      const engine = new TriggerEngine({ rules: [{ on: "tool.executed" }], path: join(dir, "triggers.jsonl") })
      const sink = createTriggerSink(inner, engine, "inst")
      const seam: SensusEvent = {
        type: "command-ran",
        ts: 5,
        session: "s1",
        tool: "shell_background",
        command: "echo hi",
        ok: true,
        approval: "confirm",
        agent: "copilot",
        cwd: null,
        shell: "bash",
      }
      sink.emit(seam)
      expect(seen).toHaveLength(1)
      // The v1 projection is what the engine saw (same as the durable log).
      expect(engine.pendingCount()).toBe(1)
      sink.flushSync()
      const lines = readLines(join(dir, "triggers.jsonl"))
      expect((lines[0]?.event as Record<string, unknown>).type).toBe("tool.executed")
      expect(toEventV1(seam, "inst")?.type).toBe("tool.executed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- real daemon: an emitted error fires the trigger WS event + log ----------

/** A small typed WS test client (request/response + event waits). */
type Frame = Record<string, unknown>
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

/** A config with no API key: sending a turn surfaces `error.raised`. */
function errorConfig(): SensusConfig {
  const cfg = defaultConfig()
  cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, apiKey: "" }
  cfg.model = "main@plain-model"
  cfg.titles.enabled = false
  return cfg
}

let server: Extract<StartDaemonResult, { ok: true }>
let runtime = ""
let home = ""

beforeAll(async () => {
  runtime = tempDir("sensus-triggers-run-")
  home = tempDir("sensus-triggers-home-")
  const result = await startDaemon({
    runtimeDir: runtime,
    token: TOKEN,
    home,
    dataDir: join(home, "data"),
    argv: [],
    shell: "/bin/sh",
    persistent: true,
    triggers: [{ on: "error.raised" }],
    initialConfig: errorConfig(),
    chatInstanceId: "triggers-test",
  })
  if (!result.ok) throw new Error(result.error)
  server = result
})

afterAll(() => {
  try {
    server.stop()
  } catch {
    // idempotent
  }
  rmSync(runtime, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe("real daemon: a trigger fires locally", () => {
  test("a matching v1 error emits a `trigger` WS event and appends triggers.jsonl", async () => {
    const client = new WsTestClient(`ws://127.0.0.1:${server.tcp.port}/v1/ws`, { authorization: `Bearer ${TOKEN}` })
    try {
      await client.open
      await client.event("hello")
      const opened = await client.request("chat.open", { model: "plain-model" })
      const chatId = String((opened.result as Frame).chatId)
      expect((await client.request("chat.send", { chatId, text: "plain:hi" })).ok).toBe(true)

      const trigger = await client.event("trigger", (f) => ((f.trigger as Frame)?.event as Frame)?.type === "error.raised")
      const record = trigger.trigger as Frame
      expect(record.v).toBe(1)
      expect(record.on).toBe("error.raised")
      expect((record.event as Frame).message).toContain("no API key")

      const path = triggersPath(join(home, "data"))
      const deadline = Date.now() + 5000
      let lines: Array<Record<string, unknown>> = []
      while (Date.now() < deadline) {
        lines = readLines(path)
        if (lines.length > 0) break
        await Bun.sleep(25)
      }
      expect(lines.length).toBeGreaterThan(0)
      expect((lines[0]?.event as Record<string, unknown>).type).toBe("error.raised")
    } finally {
      client.close()
    }
  }, 20000)
})
