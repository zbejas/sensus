/**
 * Audit resource routes (docs/daemon-api.md): bearer auth,
 * filters, cursor pagination, the JSONL/CSV exports, stats, the invalid-param
 * 400s, and the never-throws guarantee. Driven through `app.handle` over a temp
 * audit file injected via `LegacyAuditJsonlSource` — no env mutation.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditEntry } from "../../../src/agent/audit.ts"
import type { EventSink } from "../../../src/agent/extensions.ts"
import { MemoryStore } from "../../../src/agent/memory/store.ts"
import {
  createDaemonApp,
  LegacyAuditJsonlSource,
  type AuditSource,
  type NormalizedAuditRecord,
  type DaemonInfo,
} from "../../../src/daemon/index.ts"

const TOKEN = "cafebabecafebabecafebabecafebabe"
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
  new MemoryStore({ dir: "/nonexistent-sensus-daemon-audit-test", limits: { memory: 1, host: 1, journal: 1 } })

type App = ReturnType<typeof createDaemonApp>

function buildApp(audit: AuditSource): App {
  return createDaemonApp({ token: TOKEN, version: "9.9.9", info: () => INFO, memory, events: { emit: () => {} } satisfies EventSink, audit })
}

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return { ts: 1, session: "run-1", kind: "file", tool: "write_file", summary: "x", ok: true, ...over }
}

interface Harness {
  app: App
  dir: string
  path: string
  source: LegacyAuditJsonlSource
}

function harness(records: AuditEntry[] = []): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-audit-"))
  const path = join(dir, "audit.jsonl")
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
  const source = new LegacyAuditJsonlSource(path)
  return { app: buildApp(source), dir, path, source }
}

async function get(app: App, path: string, auth = true): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers: auth ? AUTH : {} }))
}

interface AuditResponse {
  ok: boolean
  records: NormalizedAuditRecord[]
  nextCursor: string | null
}

describe("daemon audit resource", () => {
  test("401 without a token on both routes", async () => {
    const h = harness([entry()])
    try {
      for (const path of ["/v1/audit", "/v1/audit/stats"]) {
        const res = await get(h.app, path, false)
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: "unauthorized" })
      }
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("JSON view is newest-first and honors since/until/session/tool/kind", async () => {
    const h = harness([
      entry({ ts: 100, session: "a", tool: "write_file", kind: "file" }),
      entry({ ts: 200, session: "b", tool: "shell_background", kind: "shell" }),
      entry({ ts: 300, session: "a", tool: "memory", kind: "memory" }),
      entry({ ts: 400, session: "a", tool: "write_file", kind: "file" }),
    ])
    try {
      const all = (await (await get(h.app, "/v1/audit")).json()) as AuditResponse
      expect(all.ok).toBe(true)
      expect(all.records.map((r) => r.ts)).toEqual([400, 300, 200, 100])
      expect(all.records.every((r) => r.source === "legacy")).toBe(true)
      expect(all.nextCursor).toBeNull()

      const since = (await (await get(h.app, "/v1/audit?since=200")).json()) as AuditResponse
      expect(since.records.map((r) => r.ts)).toEqual([400, 300, 200])
      const until = (await (await get(h.app, "/v1/audit?until=300")).json()) as AuditResponse
      expect(until.records.map((r) => r.ts)).toEqual([200, 100])

      const session = (await (await get(h.app, "/v1/audit?session=a&kind=file")).json()) as AuditResponse
      expect(session.records.map((r) => r.ts)).toEqual([400, 100])
      const tool = (await (await get(h.app, "/v1/audit?tool=shell_background")).json()) as AuditResponse
      expect(tool.records.map((r) => r.ts)).toEqual([200])
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("pagination returns a nextCursor that walks the whole set", async () => {
    const h = harness(Array.from({ length: 5 }, (_, i) => entry({ ts: (i + 1) * 100 })))
    try {
      const first = (await (await get(h.app, "/v1/audit?limit=2")).json()) as AuditResponse
      expect(first.records.map((r) => r.ts)).toEqual([500, 400])
      expect(first.nextCursor).not.toBeNull()

      const second = (await (await get(h.app, `/v1/audit?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).json()) as AuditResponse
      expect(second.records.map((r) => r.ts)).toEqual([300, 200])
      expect(second.nextCursor).not.toBeNull()

      const third = (await (await get(h.app, `/v1/audit?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? "")}`)).json()) as AuditResponse
      expect(third.records.map((r) => r.ts)).toEqual([100])
      expect(third.nextCursor).toBeNull()
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("format=jsonl and format=csv set their content types; exports are unpaged by default", async () => {
    const h = harness(Array.from({ length: 3 }, (_, i) => entry({ ts: i + 1, summary: `line ${i + 1}` })))
    try {
      const jsonl = await get(h.app, "/v1/audit?format=jsonl")
      expect(jsonl.status).toBe(200)
      expect(jsonl.headers.get("content-type")).toContain("application/x-ndjson")
      const lines = (await jsonl.text()).trim().split("\n")
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ ts: 3, source: "legacy" })

      const csv = await get(h.app, "/v1/audit?format=csv")
      expect(csv.status).toBe(200)
      expect(csv.headers.get("content-type")).toContain("text/csv")
      const csvText = await csv.text()
      expect(csvText.split("\r\n").filter((l) => l.length > 0)).toHaveLength(4) // header + 3
      expect(csvText).toContain("line 3")

      // A filter still applies to an export.
      const filtered = await get(h.app, "/v1/audit?format=csv&since=3")
      expect((await filtered.text()).split("\r\n").filter((l) => l.length > 0)).toHaveLength(2)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("stats counts the filtered set", async () => {
    const h = harness([
      entry({ ts: 1, session: "a", kind: "file", tool: "write_file" }),
      entry({ ts: 2, session: "a", kind: "shell", tool: "shell_background" }),
      entry({ ts: 3, session: "b", kind: "file", tool: "write_file" }),
    ])
    try {
      const all = (await (await get(h.app, "/v1/audit/stats")).json()) as Record<string, unknown>
      expect(all).toMatchObject({ ok: true, total: 3, byKind: { file: 2, shell: 1 }, byTool: { write_file: 2, shell_background: 1 }, bySession: { a: 2, b: 1 } })

      const filtered = (await (await get(h.app, "/v1/audit/stats?session=b")).json()) as Record<string, unknown>
      expect(filtered).toMatchObject({ ok: true, total: 1, bySession: { b: 1 } })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("bad filter/limit/format/cursor is 400 invalid_request", async () => {
    const h = harness([entry()])
    try {
      for (const path of [
        "/v1/audit?since=notanumber",
        "/v1/audit?until=",
        "/v1/audit?session=",
        "/v1/audit?tool=",
        "/v1/audit?kind=",
        "/v1/audit?limit=abc",
        "/v1/audit?format=xml",
        "/v1/audit?cursor=",
        "/v1/audit?cursor=not-a-cursor",
        "/v1/audit/stats?since=notanumber",
      ]) {
        const res = await get(h.app, path)
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: "invalid_request" })
      }
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("a missing or empty log is an empty result, not an error", async () => {
    const h = harness([])
    try {
      const empty = (await (await get(h.app, "/v1/audit")).json()) as AuditResponse
      expect(empty).toEqual({ ok: true, records: [], nextCursor: null })
      writeFileSync(h.path, "", "utf8")
      const blank = (await (await get(h.app, "/v1/audit")).json()) as AuditResponse
      expect(blank.records).toEqual([])

      rmSync(h.path, { force: true })
      const missing = (await (await get(h.app, "/v1/audit")).json()) as AuditResponse
      expect(missing).toEqual({ ok: true, records: [], nextCursor: null })

      const stats = (await (await get(h.app, "/v1/audit/stats")).json()) as Record<string, unknown>
      expect(stats).toMatchObject({ ok: true, total: 0 })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test("corrupt and blank lines are skipped; a throwing source degrades to empty", async () => {
    const h = harness([])
    try {
      writeFileSync(h.path, `${JSON.stringify(entry({ ts: 1 }))}\nnot json\n\n{"ts":"nope"}\n${JSON.stringify(entry({ ts: 2 }))}\n`, "utf8")
      const res = (await (await get(h.app, "/v1/audit")).json()) as AuditResponse
      expect(res.records.map((r) => r.ts)).toEqual([2, 1])

      let calls = 0
      const throwing: AuditSource = {
        read: () => {
          calls++
          throw new Error("boom")
        },
      }
      const badApp = buildApp(throwing)
      const degraded = await get(badApp, "/v1/audit")
      expect(degraded.status).toBe(200)
      expect(await degraded.json()).toEqual({ ok: true, records: [], nextCursor: null })
      expect(calls).toBeGreaterThan(0)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})
