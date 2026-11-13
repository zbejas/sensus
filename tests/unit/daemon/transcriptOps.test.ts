/**
 * Cloud-tunnel transcript + memory ops (docs/auth.md "Broker", docs/sessions.md
 * "Cloud reads"). Drives `RelayBroker.rpc` directly with real JSONL fixtures
 * and a real `MemoryStore`, so the bounded shapes, the path exclusion, the
 * destructive delete opt-in, and the op → scope table are exercised without a
 * network or a live daemon.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultPolicy } from "../../../src/auth/policy.ts"
import type { Scope } from "../../../src/auth/scopes.ts"
import { generateIdentity } from "../../../src/auth/identity.ts"
import { MemoryStore } from "../../../src/agent/memory/store.ts"
import { sessionFilePath, deleteSessionFile } from "../../../src/session/store.ts"
import { writeSessionMeta } from "../../../src/session/meta.ts"
import {
  RelayBroker,
  TRANSCRIPT_CONTEXT_MAX_HISTORY,
  TRANSCRIPT_CONTEXT_PREVIEW_CHARS,
  TRANSCRIPT_EXPORT_MAX_BYTES,
  TRANSCRIPT_MESSAGE_MAX_CHARS,
  type BrokerOptions,
} from "../../../src/daemon/cloud/broker.ts"
import { CloudTunnel, type TunnelBrokerLike } from "../../../src/daemon/cloud/tunnel.ts"
import { TUNNEL_OP_NAMES } from "../../../src/daemon/cloud/ops.ts"
import type { EventSink, MemoryLimits, SensusEvent } from "../../../src/engine/index.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sensus-transcript-ops-"))
  dirs.push(dir)
  return dir
}

/** Write a JSONL transcript from raw event objects (full ts control). */
function writeSession(path: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
}

const STANDBY = { ok: false as const, code: "daemon_socket_missing", message: "not running", state: "stopped" as const }

interface Harness {
  dir: string
  dataDir: string
  memoryDir: string
  broker: RelayBroker
  events: SensusEvent[]
  store: () => MemoryStore
}

interface HarnessOptions {
  scopes?: Scope[]
  deleteTranscripts?: boolean
  contextForSession?: BrokerOptions["contextForSession"]
  isSessionOpen?: (path: string) => boolean
  deleteSession?: BrokerOptions["deleteSession"]
  memoryLimits?: MemoryLimits
}

function harness(opts: HarnessOptions = {}): Harness {
  const dir = tempDir()
  const dataDir = join(dir, "data")
  const memoryDir = join(dir, "memory")
  const events: SensusEvent[] = []
  const sink: EventSink = {
    emit: (event) => {
      events.push(event)
    },
  }
  const limits = opts.memoryLimits ?? { memory: 400, host: 400, journal: 800 }
  const store = (): MemoryStore => new MemoryStore({ dir: memoryDir, limits, redactSecrets: true })
  const broker = new RelayBroker({
    policy: {
      ...defaultPolicy(),
      scopes: opts.scopes ?? ["view"],
      deleteTranscripts: opts.deleteTranscripts ?? false,
    },
    discover: async () => STANDBY,
    dataDir,
    memoryStore: store,
    events: sink,
    ...(opts.contextForSession !== undefined ? { contextForSession: opts.contextForSession } : {}),
    ...(opts.isSessionOpen !== undefined ? { isSessionOpen: opts.isSessionOpen } : {}),
    ...(opts.deleteSession !== undefined ? { deleteSession: opts.deleteSession } : {}),
  })
  return { dir, dataDir, memoryDir, broker, events, store }
}

type ResultRecord = Record<string, unknown>

async function rpc(broker: RelayBroker, op: string, params?: unknown): Promise<{ ok: boolean; result?: ResultRecord; code?: string; message?: string }> {
  return await broker.rpc(op, params)
}

describe("transcript.list over the cloud tunnel", () => {
  test("returns summaries without the absolute path, newest-first, with paging", async () => {
    const h = harness()
    const p1 = sessionFilePath(h.dataDir, "instA", 1, 0)
    writeSession(p1, [
      { ts: 100, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
      { ts: 101, type: "user_message", content: "alpha first" },
      { ts: 102, type: "assistant_message", content: "alpha reply", model: "m" },
    ])
    writeSessionMeta(p1, { title: "Alpha title", tags: ["x", "y"] })
    const p2 = sessionFilePath(h.dataDir, "instB", 2, 1)
    writeSession(p2, [{ ts: 200, type: "user_message", content: "beta first" }])

    const out = await rpc(h.broker, "transcript.list", {})
    expect(out.ok).toBe(true)
    const sessions = out.result?.["sessions"] as ResultRecord[]
    expect(sessions.map((s) => s["id"])).toEqual(["instB/tab-2-2", "instA/tab-1"])
    expect(out.result?.["nextOffset"]).toBeNull()
    for (const row of sessions) {
      expect(Object.hasOwn(row, "path")).toBe(false)
    }
    // The absolute data dir must never ride along in any field.
    expect(JSON.stringify(out.result)).not.toContain(h.dataDir)
    expect(sessions.find((s) => s["id"] === "instA/tab-1")).toMatchObject({
      title: "Alpha title",
      tags: ["x", "y"],
      tab: 1,
      messages: 2,
      lastTs: 102,
    })

    const page1 = await rpc(h.broker, "transcript.list", { limit: 1 })
    expect((page1.result?.["sessions"] as ResultRecord[]).map((s) => s["id"])).toEqual(["instB/tab-2-2"])
    expect(page1.result?.["nextOffset"]).toBe(1)
    const page2 = await rpc(h.broker, "transcript.list", { limit: 1, offset: 1 })
    expect((page2.result?.["sessions"] as ResultRecord[]).map((s) => s["id"])).toEqual(["instA/tab-1"])
    expect(page2.result?.["nextOffset"]).toBeNull()
    // A page size above the cloud max clamps instead of widening the payload.
    expect(((await rpc(h.broker, "transcript.list", { limit: 5000 })).result?.["sessions"] as ResultRecord[]).length).toBe(2)
    // Malformed paging is a typed request error.
    expect((await rpc(h.broker, "transcript.list", { limit: "many" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "transcript.list", { offset: "later" })).code).toBe("invalid_request")
  })

  test("caps one page at 50 rows even when the cloud asks for more", async () => {
    const h = harness()
    for (let tab = 1; tab <= 55; tab++) {
      writeSession(sessionFilePath(h.dataDir, "instCap", tab, 0), [
        { ts: tab, type: "user_message", content: `message ${tab}` },
      ])
    }
    const out = await rpc(h.broker, "transcript.list", { limit: 5000 })
    expect((out.result?.["sessions"] as ResultRecord[]).length).toBe(50)
    expect(out.result?.["nextOffset"]).toBe(50)
  })
})

describe("transcript.read over the cloud tunnel", () => {
  test("pages messages, clips long content, and omits thinking/images/usage/path", async () => {
    const h = harness()
    const p = sessionFilePath(h.dataDir, "instR", 1, 0)
    writeSession(p, [
      { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
      { ts: 2, type: "user_message", content: "one", images: [{ mime: "image/png", data: "AAAA" }] },
      {
        ts: 3,
        type: "assistant_message",
        content: "two",
        model: "m",
        thinking: "hidden reasoning",
        usage: { promptTokens: 1, completionTokens: 2 },
      },
      { ts: 4, type: "user_message", content: "three" },
      { ts: 5, type: "assistant_message", content: "x".repeat(TRANSCRIPT_MESSAGE_MAX_CHARS + 50), model: "m" },
    ])

    const full = await rpc(h.broker, "transcript.read", { id: "instR/tab-1" })
    expect(full.ok).toBe(true)
    expect(full.result).toMatchObject({ id: "instR/tab-1", total: 4, offset: 0 })
    const messages = full.result?.["messages"] as ResultRecord[]
    expect(messages.map((m) => m["content"]).slice(0, 3)).toEqual(["one", "two", "three"])
    for (const m of messages) {
      expect(Object.hasOwn(m, "thinking")).toBe(false)
      expect(Object.hasOwn(m, "images")).toBe(false)
      expect(Object.hasOwn(m, "usage")).toBe(false)
    }
    const clipped = messages[3]!
    expect((clipped["content"] as string).length).toBe(TRANSCRIPT_MESSAGE_MAX_CHARS)
    expect(clipped["truncated"]).toBe(true)
    expect(JSON.stringify(full.result)).not.toContain(h.dataDir)
    expect(JSON.stringify(full.result)).not.toContain("hidden reasoning")

    const page = await rpc(h.broker, "transcript.read", { id: "instR/tab-1", offset: 1, limit: 1 })
    expect(page.result).toMatchObject({ total: 4, offset: 1 })
    expect((page.result?.["messages"] as ResultRecord[]).map((m) => m["content"])).toEqual(["two"])

    expect((await rpc(h.broker, "transcript.read", { id: "nope/tab-1" })).code).toBe("not_found")
    expect((await rpc(h.broker, "transcript.read", { id: "../x" })).code).toBe("not_found")
    expect((await rpc(h.broker, "transcript.read", { id: "a/b/c" })).code).toBe("not_found")
    expect((await rpc(h.broker, "transcript.read", { id: "instR/tab-1", limit: "x" })).code).toBe("invalid_request")
  })
})

describe("transcript.export over the cloud tunnel", () => {
  test("exports md/jsonl and caps content at 2 MiB with the original byte count", async () => {
    const h = harness()
    const p = sessionFilePath(h.dataDir, "instE", 1, 0)
    writeSession(p, [
      { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
      { ts: 2, type: "slash_command", command: "/clear" },
      { ts: 3, type: "user_message", content: "hello export" },
      { ts: 4, type: "assistant_message", content: "reply export", model: "m" },
    ])

    const md = await rpc(h.broker, "transcript.export", { id: "instE/tab-1", format: "md" })
    expect(md.ok).toBe(true)
    expect(md.result?.["contentType"]).toContain("text/markdown")
    expect(md.result?.["content"]).toContain("hello export")
    expect(md.result?.["truncated"]).toBe(false)

    const jsonl = await rpc(h.broker, "transcript.export", { id: "instE/tab-1", format: "jsonl" })
    expect(jsonl.result?.["content"]).toBe(readFileSync(p, "utf8"))
    expect(jsonl.result?.["bytes"]).toBe(Buffer.byteLength(readFileSync(p, "utf8"), "utf8"))

    expect((await rpc(h.broker, "transcript.export", { id: "instE/tab-1", format: "xml" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "transcript.export", { id: "gone/tab-1", format: "md" })).code).toBe("not_found")

    const big = sessionFilePath(h.dataDir, "instBig", 1, 0)
    writeSession(big, [{ ts: 1, type: "user_message", content: "y".repeat(TRANSCRIPT_EXPORT_MAX_BYTES + 1024) }])
    const clipped = await rpc(h.broker, "transcript.export", { id: "instBig/tab-1", format: "jsonl" })
    expect(clipped.ok).toBe(true)
    expect(clipped.result?.["truncated"]).toBe(true)
    expect(clipped.result?.["bytes"]).toBeGreaterThan(TRANSCRIPT_EXPORT_MAX_BYTES)
    expect(Buffer.byteLength(clipped.result?.["content"] as string, "utf8")).toBeLessThanOrEqual(TRANSCRIPT_EXPORT_MAX_BYTES)
  })
})

describe("transcript.context over the cloud tunnel", () => {
  test("caps history rows and clips previews; absent callback is unsupported", async () => {
    const h = harness({
      contextForSession: () => ({
        title: "Ctx title",
        breakdown: {
          model: "main@m",
          history: Array.from({ length: TRANSCRIPT_CONTEXT_MAX_HISTORY + 10 }, (_, i) => ({
            role: "user",
            preview: `row-${i}-${"p".repeat(400)}`,
            tokens: i,
          })),
        },
      }),
    })
    const p = sessionFilePath(h.dataDir, "instC", 1, 0)
    writeSession(p, [{ ts: 1, type: "user_message", content: "ctx" }])

    const out = await rpc(h.broker, "transcript.context", { id: "instC/tab-1" })
    expect(out.ok).toBe(true)
    expect(out.result?.["id"]).toBe("instC/tab-1")
    expect(out.result?.["title"]).toBe("Ctx title")
    const breakdown = out.result?.["breakdown"] as ResultRecord
    const history = breakdown["history"] as ResultRecord[]
    expect(history).toHaveLength(TRANSCRIPT_CONTEXT_MAX_HISTORY)
    for (const row of history) {
      expect((row["preview"] as string).length).toBeLessThanOrEqual(TRANSCRIPT_CONTEXT_PREVIEW_CHARS)
    }
    expect(JSON.stringify(out.result)).not.toContain(h.dataDir)

    expect((await rpc(h.broker, "transcript.context", { id: "gone/tab-1" })).code).toBe("not_found")
    expect((await rpc(h.broker, "transcript.context", { id: "../x" })).code).toBe("not_found")

    const unwired = harness()
    const q = sessionFilePath(unwired.dataDir, "instC", 1, 0)
    writeSession(q, [{ ts: 1, type: "user_message", content: "ctx" }])
    const missing = await rpc(unwired.broker, "transcript.context", { id: "instC/tab-1" })
    expect(missing.code).toBe("unsupported")
  })
})

describe("transcript.delete over the cloud tunnel", () => {
  function fixture(h: Harness): string {
    const p = sessionFilePath(h.dataDir, "instD", 1, 0)
    writeSession(p, [{ ts: 1, type: "user_message", content: "delete me" }])
    return p
  }

  test("is refused without the host policy flag and with view only", async () => {
    const h = harness({ scopes: ["view", "control"] })
    const p = fixture(h)
    const disabled = await rpc(h.broker, "transcript.delete", { id: "instD/tab-1" })
    expect(disabled).toMatchObject({ ok: false, code: "delete_disabled" })
    expect(disabled.message).toContain("permanently")
    expect(existsSync(p)).toBe(true)

    const viewOnly = harness({ scopes: ["view"], deleteTranscripts: true })
    const q = fixture(viewOnly)
    const denied = await rpc(viewOnly.broker, "transcript.delete", { id: "instD/tab-1" })
    expect(denied).toMatchObject({ ok: false, code: "scope_required", message: "the local policy does not grant control" })
    expect(existsSync(q)).toBe(true)
  })

  test("refuses a live transcript and deletes an idle one when enabled", async () => {
    let open = true
    let deletedPath = ""
    const h = harness({
      scopes: ["view", "control"],
      deleteTranscripts: true,
      isSessionOpen: () => open,
      deleteSession: (path) => {
        deletedPath = path
        return deleteSessionFile(path) ? { ok: true } : { ok: false, message: "could not delete that session" }
      },
    })
    const p = fixture(h)

    const blocked = await rpc(h.broker, "transcript.delete", { id: "instD/tab-1" })
    expect(blocked).toMatchObject({ ok: false, code: "session_open" })
    expect(existsSync(p)).toBe(true)

    open = false
    const out = await rpc(h.broker, "transcript.delete", { id: "instD/tab-1" })
    expect(out).toEqual({ ok: true, result: { ok: true, id: "instD/tab-1" } })
    expect(deletedPath).toBe(p)
    expect(existsSync(p)).toBe(false)

    expect((await rpc(h.broker, "transcript.delete", { id: "../x" })).code).toBe("not_found")
    expect((await rpc(h.broker, "transcript.delete", { id: "a/b/c" })).code).toBe("not_found")
  })

  test("reports a delete failure as delete_failed", async () => {
    const h = harness({
      scopes: ["view", "control"],
      deleteTranscripts: true,
      deleteSession: () => ({ ok: false, message: "permission denied" }),
    })
    fixture(h)
    const out = await rpc(h.broker, "transcript.delete", { id: "instD/tab-1" })
    expect(out).toMatchObject({ ok: false, code: "delete_failed", message: "permission denied" })
  })
})

describe("memory ops over the cloud tunnel", () => {
  test("lists, reads and writes the three stores and audits committed writes", async () => {
    const h = harness({ scopes: ["view", "control"] })
    const list = await rpc(h.broker, "memory.list")
    expect(list.ok).toBe(true)
    expect((list.result?.["targets"] as ResultRecord[]).map((t) => t["target"])).toEqual(["memory", "host", "journal"])

    const write = await rpc(h.broker, "memory.write", { target: "memory", action: "add", content: "the build uses bun" })
    expect(write.ok).toBe(true)
    expect(write.result).toMatchObject({ ok: true, target: "memory", action: "add" })
    expect(write.result?.["content"]).toContain("the build uses bun")
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ type: "memory-write", session: "daemon", target: "memory", action: "add", ok: true })

    const read = await rpc(h.broker, "memory.read", { target: "memory" })
    expect(read.ok).toBe(true)
    expect(read.result?.["content"]).toContain("the build uses bun")
    expect(read.result?.["entries"]).toEqual(["the build uses bun"])
    expect(read.result?.["usage"]).toMatchObject({ target: "memory" })

    // A store-domain refusal is a NORMAL rpc.res (ok:false), never a transport error.
    const full = harness({ scopes: ["view", "control"], memoryLimits: { memory: 10, host: 10, journal: 10 } })
    const refused = await rpc(full.broker, "memory.write", {
      target: "memory",
      action: "add",
      content: "this is definitely longer than ten characters",
    })
    expect(refused.ok).toBe(true)
    expect(refused.result?.["ok"]).toBe(false)
    expect(refused.result?.["message"]).toContain("FULL")
    expect(full.events).toHaveLength(0)
    expect(full.store().read("memory")).toBe("")

    // Over-64 KiB content is a structural rejection, before the store sees it.
    const tooBig = "x".repeat(64 * 1024 + 1)
    const rejected = await rpc(h.broker, "memory.write", { target: "host", action: "add", content: tooBig })
    expect(rejected.code).toBe("invalid_request")
    expect(h.store().read("host")).toBe("")

    expect((await rpc(h.broker, "memory.write", { target: "memory", action: "add" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "memory.write", { target: "nope", action: "add", content: "x" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "memory.write", { target: "memory", action: "nope" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "memory.write", { target: "memory", action: "remove" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "memory.write", { target: "memory", action: "replace", content: "x" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "memory.write", { target: "memory", action: "prune", keep_chars: "half" })).code).toBe("invalid_request")
    expect((await rpc(h.broker, "memory.read", { target: "nope" })).code).toBe("invalid_request")
  })

  test("memory.write needs control; memory reads truncate content at 64 KiB and cap entries", async () => {
    const viewOnly = harness({ scopes: ["view"] })
    expect((await rpc(viewOnly.broker, "memory.write", { target: "memory", action: "add", content: "x" })).code).toBe("scope_required")

    const h = harness({ memoryLimits: { memory: 200_000, host: 200_000, journal: 200_000 } })
    mkdirSync(h.memoryDir, { recursive: true })
    writeFileSync(join(h.memoryDir, "JOURNAL.md"), `${"j".repeat(70 * 1024)}\n§\nsecond entry`, "utf8")
    const read = await rpc(h.broker, "memory.read", { target: "journal" })
    expect(read.ok).toBe(true)
    expect(read.result?.["truncated"]).toBe(true)
    expect(Buffer.byteLength(read.result?.["content"] as string, "utf8")).toBeLessThanOrEqual(64 * 1024)
    expect((read.result?.["entries"] as string[]).length).toBeLessThanOrEqual(200)
  })
})

describe("op table and hello features", () => {
  test("every declared op is in the known list and blocked ops stay blocked", async () => {
    expect(TUNNEL_OP_NAMES).toContain("transcript.read")
    expect(TUNNEL_OP_NAMES).toContain("memory.write")
    const h = harness()
    expect((await rpc(h.broker, "not.an.op")).code).toBe("unknown_op")
    expect((await rpc(h.broker, "terminal.kill", {})).code).toBe("blocked_op")
  })

  test("hello.features advertises transcript/memory reads and only opts into delete when enabled", async () => {
    const broker: TunnelBrokerLike = {
      rpc: async () => ({ ok: true, result: {} }),
      openStream: async () => ({ ok: false, code: "unused", message: "unused" }),
      streamSend: () => ({ ok: true }),
      closeStream: async () => false,
      closeAll: async () => {},
      daemonFacts: async () => ({ state: "running" }),
    }

    async function helloFeatures(deleteTranscripts: boolean): Promise<string[]> {
      const before = FakeSocket.instances.length
      const tunnel = new CloudTunnel({
        cloudUrl: "https://cloud.example",
        instanceId: "inst_1",
        deviceToken: "token",
        identity: generateIdentity(),
        policy: { ...defaultPolicy(), deleteTranscripts },
        broker,
        connectorVersion: "9.9.9",
        host: { hostname: "box", platform: "linux", arch: "x64" },
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
        reconnectBaseMs: 60_000,
        reconnectMaxMs: 60_000,
      })
      tunnel.start()
      const socket = FakeSocket.instances[before]
      expect(socket).toBeDefined()
      socket!.emit("open", {})
      socket!.emit("message", { data: JSON.stringify({ t: "challenge", nonce: "nonce", exp: Date.now() + 10_000 }) })
      socket!.emit("message", { data: JSON.stringify({ t: "auth.ok" }) })
      await Bun.sleep(20)
      const hello = socket!.frames().find((frame) => frame["t"] === "hello")
      await tunnel.stop()
      return (hello?.["features"] as string[]) ?? []
    }

    const defaults = await helloFeatures(false)
    expect(defaults).toContain("transcript.read")
    expect(defaults).toContain("memory.read")
    expect(defaults).toContain("memory.write")
    expect(defaults).not.toContain("transcript.delete")

    const enabled = await helloFeatures(true)
    expect(enabled).toContain("transcript.delete")
  })
})

type SocketListener = (event: unknown) => void

/** A WebSocket stand-in that records outbound frames and replays inbound ones. */
class FakeSocket {
  static instances: FakeSocket[] = []
  bufferedAmount = 0
  private readonly sent: string[] = []
  private readonly listeners = new Map<string, SocketListener[]>()

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, listener: SocketListener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    // no-op: the tunnel owns teardown
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  frames(): ResultRecord[] {
    return this.sent.map((text) => JSON.parse(text) as ResultRecord)
  }
}
