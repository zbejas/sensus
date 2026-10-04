/**
 * Event schema v1 (IF3; docs/events.md): the frozen projection the durable
 * `events.jsonl` log carries, the bounded JSONL sink (cap/rotation, drop-oldest
 * queue, never-throw), and the REAL engine emission points behind a headless
 * turn.
 *
 * The pure mapping is exercised for all eight v1 types; the integration half
 * drives a full scripted mock turn (tool + file write + skill + provider error)
 * with ZERO renderer imports, then reads back the log.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ChatHost,
  JsonlEventSink,
  NoopEventSink,
  createEventSink,
  defaultConfig,
  eventsPath,
  toEventV1,
  EVENT_FIELD_MAX,
  EVENT_SCHEMA_VERSION,
  JSONL_EVENT_ROTATED_SUFFIX,
  type EventV1,
  type SensusConfig,
  type SensusEvent,
} from "../../../src/engine/index.ts"
import { startMockOpenai, type MockOpenaiServer } from "../../mocks/mockOpenai.ts"

const TEMP = (): string => mkdtempSync(join(tmpdir(), "sensus-events-"))

function readLog(path: string): EventV1[] {
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EventV1)
}

const EVENTS: SensusEvent[] = [
  { type: "session-start", ts: 1, session: "s1", agent: "copilot", approval: "confirm", shell: "bash", model: "main@gpt", resumed: false },
  { type: "session-end", ts: 2, session: "s1", reason: "shutdown" },
  { type: "turn-complete", ts: 3, session: "s1", durationMs: 1234, outcome: "ok", model: "main@gpt" },
  {
    type: "command-ran",
    ts: 4,
    session: "s1",
    tool: "shell_background",
    command: "echo hi",
    ok: true,
    exitCode: 0,
    approval: "full-auto",
    agent: "copilot",
    cwd: "/tmp",
    shell: "bash",
  },
  { type: "file-change", ts: 5, session: "s1", tool: "write_file", path: "/tmp/x", action: "write", ok: true },
  {
    type: "memory-write",
    ts: 6,
    session: "s1",
    target: "memory",
    action: "add",
    beforeChars: 1,
    afterChars: 5,
    delta: 4,
    ok: true,
  },
  { type: "skill-use", ts: 7, session: "s1", name: "deploy", source: "tool" },
  { type: "error-raised", ts: 8, session: "s1", source: "provider", message: "boom", tool: "shell_background" },
]

describe("event schema v1 (toEventV1)", () => {
  test("projects all eight v1 types with v/ts/instanceId/session and their fields", () => {
    const types = EVENTS.map((e) => toEventV1(e, "inst")?.type)
    expect(types).toEqual([
      "session.started",
      "session.ended",
      "turn.completed",
      "tool.executed",
      "file.changed",
      "memory.written",
      "skill.used",
      "error.raised",
    ])
    for (const e of EVENTS) {
      const v1 = toEventV1(e, "inst")
      expect(v1?.v).toBe(EVENT_SCHEMA_VERSION)
      expect(v1?.instanceId).toBe("inst")
      expect(v1?.session).toBe("s1")
      expect(v1?.ts).toBe(e.ts)
    }
    expect(toEventV1(EVENTS[3]!, "inst")).toMatchObject({ tool: "shell_background", command: "echo hi", ok: true, exitCode: 0 })
    expect(toEventV1(EVENTS[7]!, "inst")).toMatchObject({ source: "provider", message: "boom", tool: "shell_background" })
    // The raw seam event now carries an optional abort reason, but the frozen
    // v1 schema keeps dropping it (docs/events.md).
    const abortedTurn = toEventV1(
      { type: "turn-complete", ts: 9, session: "s1", durationMs: 10, outcome: "aborted", model: "main@gpt", reason: "shell-exit" },
      "inst",
    )
    expect(abortedTurn).toMatchObject({ type: "turn.completed", outcome: "aborted" })
    expect(abortedTurn !== null && "reason" in abortedTurn).toBe(false)
  })

  test("drops the two seam events with no v1 counterpart and caps long fields", () => {
    expect(toEventV1({ type: "command-approved", ts: 1, session: "s", tool: "t", source: "auto", approval: "confirm", agent: "a", cwd: null, shell: "bash" }, "i")).toBeNull()
    expect(toEventV1({ type: "command-denied", ts: 1, session: "s", tool: "t", source: "user", approval: "confirm", agent: "a" }, "i")).toBeNull()

    const long = "x".repeat(EVENT_FIELD_MAX + 50)
    const exec = toEventV1({ type: "command-ran", ts: 1, session: "s", tool: "t", command: long, ok: false, approval: "confirm", agent: "a", cwd: null, shell: "bash" }, "i")
    expect(exec?.type).toBe("tool.executed")
    if (exec?.type === "tool.executed") expect(exec.command).toHaveLength(EVENT_FIELD_MAX)
  })
})

describe("JsonlEventSink (bounded, non-throwing)", () => {
  test("writes one v1 line per event, drops the oldest past the queue cap, and flushes", () => {
    const dir = TEMP()
    try {
      const path = join(dir, "events.jsonl")
      const sink = new JsonlEventSink({ path, instanceId: "inst", queueMax: 3 })
      for (const e of EVENTS) sink.emit(e)
      // The backlog is bounded synchronously (the flush is a setImmediate).
      expect(sink.pendingCount()).toBe(3)
      sink.flushSync()
      expect(sink.pendingCount()).toBe(0)
      const lines = readLog(path)
      expect(lines).toHaveLength(3)
      // Newest survive; the oldest three were dropped.
      expect(lines.map((l) => l.type)).toEqual(["memory.written", "skill.used", "error.raised"])
      expect(lines.every((l) => l.v === 1 && l.instanceId === "inst")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rotates at the byte cap: events.jsonl.1 holds the prior generation and growth stays bounded", () => {
    const dir = TEMP()
    try {
      const path = join(dir, "events.jsonl")
      const sink = new JsonlEventSink({ path, instanceId: "inst", maxBytes: 400 })
      const one = JSON.stringify(toEventV1(EVENTS[0]!, "inst")).length + 1
      const count = Math.ceil(400 / one) + 4
      for (let i = 0; i < count; i++) sink.emit({ ...EVENTS[0]!, ts: i })
      sink.flushSync()
      // A second batch, now that the file exists, trips the cap and rotates.
      sink.emit({ ...EVENTS[0]!, ts: count })
      sink.flushSync()
      expect(existsSync(`${path}${JSONL_EVENT_ROTATED_SUFFIX}`)).toBe(true)
      // Bounded: the live file is <= cap, and with one retained rotation total
      // stays under ~2x the cap plus at most one oversized batch.
      expect(statSync(path).size).toBeLessThanOrEqual(400 + one)
      const all = readLog(path).concat(readLog(`${path}${JSONL_EVENT_ROTATED_SUFFIX}`))
      expect(all.length).toBe(count + 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("never throws on an unwritable destination; createEventSink selects the built-ins", () => {
    const dir = TEMP()
    try {
      const fileAsDir = join(dir, "afile")
      writeFileSync(fileAsDir, "x")
      const sink = new JsonlEventSink({ path: join(fileAsDir, "nested", "events.jsonl"), instanceId: "i" })
      expect(() => {
        sink.emit(EVENTS[0]!)
        sink.flushSync()
      }).not.toThrow()
      // The queue is drained even when the write fails (bounded memory).
      expect(sink.pendingCount()).toBe(0)

      expect(createEventSink({ kind: "noop" })).toBeInstanceOf(NoopEventSink)
      const jsonl = createEventSink({ kind: "jsonl" }, { instanceId: "i", dataDir: dir })
      expect(jsonl).toBeInstanceOf(JsonlEventSink)
      const custom = createEventSink({ kind: "jsonl", path: join(dir, "custom.jsonl") }, { instanceId: "i", dataDir: dir })
      custom.emit(EVENTS[2]!)
      ;(custom as JsonlEventSink).flushSync()
      expect(readLog(join(dir, "custom.jsonl"))[0]?.type).toBe("turn.completed")
      expect(readLog(eventsPath(dir))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- real engine emission (headless turn; no renderer) -----------------------

let server: MockOpenaiServer

beforeAll(async () => {
  server = await startMockOpenai()
})

afterAll(async () => {
  await server.close()
})

async function until(f: () => boolean, ms = 8000, label = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (f()) return
    await Bun.sleep(15)
  }
  throw new Error(`until(${label}) timed out`)
}

function makeHost(home: string, sink: JsonlEventSink, approval: "confirm" | "full-auto" = "full-auto", apiKey = "events-key"): ChatHost {
  const cfg: SensusConfig = defaultConfig()
  cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, baseURL: server.url, apiKey, maxTokens: 128 }
  cfg.model = "main@plain-model"
  cfg.approval = approval
  cfg.titles.enabled = false
  return new ChatHost({
    dataDir: join(home, "data"),
    instanceId: "events-instance",
    initialConfig: cfg,
    argv: [],
    toast: () => {},
    eventSinkFactory: () => sink,
  })
}

describe("engine emission points write the v1 log", () => {
  test("a full turn emits session.started, tool.executed, file.changed, skill.used and turn.completed", async () => {
    const home = TEMP()
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      // A skill the scripted `skill:demo` call can load.
      const skillDir = join(home, "skills", "demo")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: a demo skill\n---\n1. do the thing\n")

      const path = join(home, "data", "events.jsonl")
      const sink = new JsonlEventSink({ path, instanceId: "inst" })
      const host = makeHost(home, sink)
      const chat = host.createTabChat(1)

      const target = join(home, "written.txt")
      expect(chat.handleInput(`write:${target}|hello-events`)).toBe("sent")
      await until(() => chat.accessors.status() === "idle", 8000, "idle after write")
      expect(readFileSync(target, "utf8")).toBe("hello-events")

      chat.handleInput("skill:demo")
      await until(() => chat.accessors.status() === "idle", 8000, "idle after skill")

      chat.handleInput("cmd:echo EVENTS-OK")
      await until(() => chat.accessors.status() === "idle", 8000, "idle after shell")

      sink.flushSync()
      const lines = readLog(path)
      const types = new Set(lines.map((l) => l.type))
      expect(types.has("session.started")).toBe(true)
      expect(types.has("tool.executed")).toBe(true)
      expect(types.has("file.changed")).toBe(true)
      expect(types.has("skill.used")).toBe(true)
      expect(types.has("turn.completed")).toBe(true)
      const file = lines.find((l) => l.type === "file.changed")
      expect(file).toMatchObject({ action: "write", ok: true, tool: "write_file" })
      const skill = lines.find((l) => l.type === "skill.used")
      expect(skill).toMatchObject({ name: "demo", source: "tool" })
      const turn = lines.find((l) => l.type === "turn.completed")
      if (turn?.type === "turn.completed") expect(turn.durationMs).toBeGreaterThanOrEqual(0)

      // session.ended fires on release (there is no per-tab close in v1).
      host.endTabChat(chat, "shutdown")
      sink.flushSync()
      expect(readLog(path).some((l) => l.type === "session.ended" && l.reason === "shutdown")).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a surfaced provider error emits error.raised (no API key)", async () => {
    const home = TEMP()
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      const path = join(home, "data", "events.jsonl")
      const sink = new JsonlEventSink({ path, instanceId: "inst" })
      const host = makeHost(home, sink, "confirm", "")
      const chat = host.createTabChat(1)
      chat.handleInput("plain:hi")
      sink.flushSync()
      const err = readLog(path).find((l) => l.type === "error.raised")
      expect(err).toBeDefined()
      if (err?.type === "error.raised") expect(err.message).toContain("no API key")
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
