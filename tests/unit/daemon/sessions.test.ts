/**
 * Sessions resource (docs/daemon-api.md): list/read/export
 * over a temp data dir, the 400/404 error model, and — the load-bearing
 * guarantee — that no GET mutates a transcript. Driven through `app.handle`
 * with real JSONL fixtures (plus a metadata sidecar), no index, no TUI.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { NoopEventSink } from "../../../src/agent/extensions.ts"
import { MemoryStore } from "../../../src/agent/memory/store.ts"
import { writeSessionMeta } from "../../../src/session/meta.ts"
import { sessionFilePath } from "../../../src/session/store.ts"
import {
  createDaemonApp,
  isSafeSessionSegment,
  resolveSessionPath,
  sessionTabFromBase,
  type SessionSummary,
  type DaemonInfo,
} from "../../../src/daemon/index.ts"

const TOKEN = "0123456789abcdef0123456789abcdef"
const AUTH = { authorization: `Bearer ${TOKEN}` }

const INFO: DaemonInfo = {
  ok: true,
  name: "sensus-daemon",
  version: "9.9.9",
  pid: 4242,
  platform: "linux",
  startedAt: 1_000_000,
  uptimeMs: 1,
  socket: "/tmp/daemon.sock",
  tcp: { host: "127.0.0.1", port: 1 },
  shells: 0,
  persistent: false,
  instance: { instanceId: "test-instance", createdAt: 1, version: "9.9.9" },
}

const memory = (): MemoryStore =>
  new MemoryStore({ dir: "/nonexistent-sensus-daemon-sessions-test", limits: { memory: 1, host: 1, journal: 1 } })

function makeApp(dataDir: string, context?: (path: string) => { title: string; breakdown: unknown } | null) {
  return createDaemonApp({
    token: TOKEN,
    version: "9.9.9",
    info: () => INFO,
    memory,
    events: new NoopEventSink(),
    sessionsDataDir: dataDir,
    ...(context !== undefined ? { sessionContext: context } : {}),
  })
}

/** Write a JSONL transcript from raw event objects (full ts control). */
function writeSession(path: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
}

type App = ReturnType<typeof createDaemonApp>

function get(app: App, path: string, auth = true): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers: auth ? AUTH : {} }))
}

interface ListBody {
  ok: boolean
  sessions: SessionSummary[]
  nextOffset: number | null
}

interface ReadBody {
  ok: boolean
  id: string
  title: string
  tags: string[]
  total: number
  offset: number
  messages: Array<{ role: string; content: string }>
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sensus-daemon-sessions-"))
}

describe("daemon sessions resource", () => {
  test("lists non-empty sessions newest-first with id/title/tab/mtime/size and pages with nextOffset", async () => {
    const dir = tempDir()
    try {
      const p1 = sessionFilePath(dir, "instA", 1, 0) // instA/tab-1
      writeSession(p1, [
        { ts: 100, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
        { ts: 101, type: "user_message", content: "alpha first" },
        { ts: 102, type: "assistant_message", content: "alpha reply", model: "m" },
      ])
      writeSessionMeta(p1, { title: "Alpha title", tags: ["x", "y"] })

      const p2 = sessionFilePath(dir, "instB", 2, 1) // instB/tab-2-2 (generation 1)
      writeSession(p2, [{ ts: 200, type: "user_message", content: "beta first" }])

      // A header-only transcript is not a session and must be hidden.
      const empty = sessionFilePath(dir, "instA", 3, 0)
      writeSession(empty, [{ ts: 300, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" }])

      const app = makeApp(dir)
      const res = await get(app, "/v1/sessions")
      expect(res.status).toBe(200)
      const body = (await res.json()) as ListBody
      expect(body.ok).toBe(true)
      // Newest-first by lastTs (200 > 102); the empty header file is absent.
      expect(body.sessions.map((s) => s.id)).toEqual(["instB/tab-2-2", "instA/tab-1"])
      expect(body.nextOffset).toBeNull()

      const a = body.sessions.find((s) => s.id === "instA/tab-1")
      const st = statSync(p1)
      expect(a).toMatchObject({ title: "Alpha title", tags: ["x", "y"], tab: 1, messages: 2, lastTs: 102, mtime: st.mtimeMs, size: st.size })
      const b = body.sessions.find((s) => s.id === "instB/tab-2-2")
      expect(b).toMatchObject({ title: "beta first", tab: 2, messages: 1, lastTs: 200 })

      // Paging: limit=1 walks the set and reports the next offset.
      const page1 = (await (await get(app, "/v1/sessions?limit=1")).json()) as ListBody
      expect(page1.sessions.map((s) => s.id)).toEqual(["instB/tab-2-2"])
      expect(page1.nextOffset).toBe(1)
      const page2 = (await (await get(app, "/v1/sessions?limit=1&offset=1")).json()) as ListBody
      expect(page2.sessions.map((s) => s.id)).toEqual(["instA/tab-1"])
      expect(page2.nextOffset).toBeNull()
      // Past the end: empty page, no next offset.
      const past = (await (await get(app, "/v1/sessions?offset=99")).json()) as ListBody
      expect(past.sessions).toEqual([])
      expect(past.nextOffset).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reads a transcript with a paged logical message window; unknown -> 404, bad limit/offset -> 400", async () => {
    const dir = tempDir()
    try {
      const p = sessionFilePath(dir, "instR", 1, 0)
      writeSession(p, [
        { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
        { ts: 2, type: "user_message", content: "one" },
        { ts: 3, type: "assistant_message", content: "two", model: "m" },
        { ts: 4, type: "user_message", content: "three" },
      ])
      const app = makeApp(dir)

      const full = (await (await get(app, "/v1/sessions/instR/tab-1")).json()) as ReadBody
      expect(full).toMatchObject({ ok: true, id: "instR/tab-1", total: 3, offset: 0 })
      expect(full.messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "one"],
        ["assistant", "two"],
        ["user", "three"],
      ])

      const page = (await (await get(app, "/v1/sessions/instR/tab-1?offset=1&limit=1")).json()) as ReadBody
      expect(page).toMatchObject({ total: 3, offset: 1 })
      expect(page.messages.map((m) => m.content)).toEqual(["two"])

      expect((await get(app, "/v1/sessions/instR/tab-1?limit=abc")).status).toBe(400)
      expect((await get(app, "/v1/sessions/instR/tab-1?offset=x")).status).toBe(400)
      const unknown = await get(app, "/v1/sessions/nope/tab-1")
      expect(unknown.status).toBe(404)
      expect(await unknown.json()).toEqual({ error: "not_found" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("exports md (rendered) and jsonl (raw bytes, faithful); bad format -> 400", async () => {
    const dir = tempDir()
    try {
      const p = sessionFilePath(dir, "instE", 1, 0)
      writeSession(p, [
        { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
        { ts: 2, type: "slash_command", command: "/clear" },
        { ts: 3, type: "user_message", content: "hello export" },
        { ts: 4, type: "assistant_message", content: "reply export", model: "m" },
      ])
      const app = makeApp(dir)

      const md = await get(app, "/v1/sessions/instE/tab-1/export?format=md")
      expect(md.status).toBe(200)
      expect(md.headers.get("content-type")).toContain("text/markdown")
      const mdText = await md.text()
      expect(mdText).toContain("hello export")
      expect(mdText).toContain("reply export")
      expect(mdText).not.toContain("/clear") // slash_command is not a message

      // jsonl is the raw file verbatim — it keeps events md drops.
      const jsonl = await get(app, "/v1/sessions/instE/tab-1/export?format=jsonl")
      expect(jsonl.status).toBe(200)
      expect(jsonl.headers.get("content-type")).toContain("application/x-ndjson")
      const raw = readFileSync(p, "utf8")
      expect(await jsonl.text()).toBe(raw)
      expect(raw).toContain("session_start")
      expect(raw).toContain("/clear")

      // The default export format is md.
      const dflt = await get(app, "/v1/sessions/instE/tab-1/export")
      expect(dflt.headers.get("content-type")).toContain("text/markdown")

      const bad = await get(app, "/v1/sessions/instE/tab-1/export?format=xml")
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: "invalid_request" })
      expect((await get(app, "/v1/sessions/unknown/tab-1/export?format=md")).status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("GETs never mutate a transcript: bytes, mtime and directory entries unchanged", async () => {
    const dir = tempDir()
    try {
      const p = sessionFilePath(dir, "instRO", 1, 0)
      writeSession(p, [
        { ts: 1, type: "user_message", content: "read only" },
        { ts: 2, type: "assistant_message", content: "no writes", model: "m" },
      ])
      const sessionDir = dirname(p)
      const before = {
        bytes: readFileSync(p, "utf8"),
        mtimeMs: statSync(p).mtimeMs,
        entries: readdirSync(sessionDir).sort(),
      }
      expect(before.entries.some((e) => e.endsWith(".meta.json"))).toBe(false)

      const app = makeApp(dir)
      await get(app, "/v1/sessions")
      await get(app, "/v1/sessions/instRO/tab-1")
      await get(app, "/v1/sessions/instRO/tab-1/export?format=md")
      await get(app, "/v1/sessions/instRO/tab-1/export?format=jsonl")

      const after = {
        bytes: readFileSync(p, "utf8"),
        mtimeMs: statSync(p).mtimeMs,
        entries: readdirSync(sessionDir).sort(),
      }
      expect(after).toEqual(before)
      expect(after.entries.some((e) => e.endsWith(".meta.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("401 without a bearer token on every route", async () => {
    const dir = tempDir()
    try {
      writeSession(sessionFilePath(dir, "inst", 1, 0), [{ ts: 1, type: "user_message", content: "x" }])
      const app = makeApp(dir)
      for (const path of ["/v1/sessions", "/v1/sessions/inst/tab-1", "/v1/sessions/inst/tab-1/export?format=md"]) {
        const res = await get(app, path, false)
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: "unauthorized" })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("daemon sessions: context + delete (P4e)", () => {
  const del = (app: App, path: string, auth = true): Promise<Response> =>
    app.handle(new Request(`http://localhost${path}`, { method: "DELETE", headers: auth ? AUTH : {} }))

  test("GET /:instance/:base/context returns the saved-session snapshot; unknown or unwired -> 404", async () => {
    const dir = tempDir()
    try {
      const p = sessionFilePath(dir, "instC", 1, 0)
      writeSession(p, [
        { ts: 1, type: "user_message", content: "one" },
        { ts: 2, type: "assistant_message", content: "two", model: "m" },
      ])
      const breakdown = { rows: [], note: "fixture" }
      const app = makeApp(dir, (path) => (path === p ? { title: "Saved title", breakdown } : null))

      const res = await get(app, "/v1/sessions/instC/tab-1/context")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, title: "Saved title", breakdown })

      // Unknown id and a daemon without the context dep both 404; no throw.
      expect((await get(app, "/v1/sessions/instC/tab-9/context")).status).toBe(404)
      const unwired = makeApp(dir)
      expect((await get(unwired, "/v1/sessions/instC/tab-1/context")).status).toBe(404)
      // Traversal attempts are refused before the dep is called.
      expect((await get(app, "/v1/sessions/..%2F..%2Fetc/tab-1/context")).status).toBe(404)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("DELETE /:instance/:base unlinks transcript + sidecar; a second delete is 404", async () => {
    const dir = tempDir()
    try {
      const p = sessionFilePath(dir, "instD", 1, 0)
      writeSession(p, [{ ts: 1, type: "user_message", content: "bye" }])
      writeSessionMeta(p, { title: "Doomed" })
      const metaPath = `${p}.meta.json`
      expect(existsSync(p)).toBe(true)
      expect(existsSync(metaPath)).toBe(true)

      const app = makeApp(dir)
      const res = await del(app, "/v1/sessions/instD/tab-1")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, id: "instD/tab-1" })
      expect(existsSync(p)).toBe(false)
      expect(existsSync(metaPath)).toBe(false)

      // Gone now: resolveSessionPath cannot find it -> 404.
      const again = await del(app, "/v1/sessions/instD/tab-1")
      expect(again.status).toBe(404)
      // Delete is auth-gated like every other route.
      writeSession(p, [{ ts: 1, type: "user_message", content: "x" }])
      expect((await del(app, "/v1/sessions/instD/tab-1", false)).status).toBe(401)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("daemon sessions: path-traversal guard", () => {
  test("resolveSessionPath rejects separators, dot segments and absolute segments; accepts a real file", () => {
    const dir = tempDir()
    try {
      const p = sessionFilePath(dir, "inst", 1, 0)
      writeSession(p, [{ ts: 1, type: "user_message", content: "guarded" }])
      expect(resolveSessionPath(dir, "inst", "tab-1")).toBe(p)
      for (const [instance, base] of [
        ["..", "tab-1"],
        ["inst", ".."],
        ["inst/../..", "tab-1"],
        ["inst", "../../etc/passwd"],
        ["", "tab-1"],
        ["inst", ""],
        ["/abs", "tab-1"],
        ["inst", "/abs"],
        ["inst", "tab-1\0"],
        ["a\\b", "tab-1"],
        ["inst", "missing"],
      ] as const) {
        expect(resolveSessionPath(dir, instance, base)).toBeNull()
      }
      expect(isSafeSessionSegment("inst")).toBe(true)
      expect(isSafeSessionSegment("..")).toBe(false)
      expect(isSafeSessionSegment("a/b")).toBe(false)
      expect(isSafeSessionSegment("")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("sessionTabFromBase parses generations and rejects non-tab bases", () => {
    expect(sessionTabFromBase("tab-1")).toBe(1)
    expect(sessionTabFromBase("tab-2-3")).toBe(2)
    expect(sessionTabFromBase("tab-10-2")).toBe(10)
    expect(sessionTabFromBase("other")).toBeNull()
    expect(sessionTabFromBase("tab-x")).toBeNull()
  })
})
