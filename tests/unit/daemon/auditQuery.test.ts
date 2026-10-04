/**
 * Audit query/export core (docs/daemon-api.md): the pure
 * normalization of legacy entries + events, the filter boundaries, cursor
 * pagination, and the JSONL/CSV/stat formatters. No I/O — the reader is covered
 * in auditRoutes.test.ts.
 */

import { describe, expect, test } from "bun:test"
import type { AuditEntry } from "../../../src/agent/audit.ts"
import type { SensusEvent } from "../../../src/agent/extensions.ts"
import {
  auditStats,
  clampAuditLimit,
  decodeCursor,
  encodeCursor,
  filterRecords,
  normalizeAuditEntry,
  normalizeEvent,
  paginate,
  sortNewestFirst,
  toCsv,
  toJsonl,
  CSV_COLUMNS,
  type NormalizedAuditRecord,
} from "../../../src/daemon/index.ts"

function rec(over: Partial<NormalizedAuditRecord> = {}): NormalizedAuditRecord {
  return { ts: 1, session: "run-1", kind: "file", tool: "write_file", summary: "x", ok: true, source: "legacy", ...over }
}

describe("normalizeAuditEntry", () => {
  test("copies AuditEntry fields and labels the source", () => {
    const entry: AuditEntry = {
      ts: 10,
      session: "run-1",
      kind: "file",
      tool: "write_file",
      summary: "/tmp/a.txt",
      ok: true,
      path: "/tmp/a.txt",
      before: "old",
      undone: false,
      refTs: 7,
    }
    expect(normalizeAuditEntry(entry)).toEqual({
      ts: 10,
      session: "run-1",
      kind: "file",
      tool: "write_file",
      summary: "/tmp/a.txt",
      ok: true,
      path: "/tmp/a.txt",
      before: "old",
      undone: false,
      refTs: 7,
      source: "legacy",
    })
  })

  test("omits absent optional fields (before stays null when explicitly null)", () => {
    const record = normalizeAuditEntry({ ts: 1, session: "s", kind: "memory", tool: "memory", summary: "add", ok: true })
    expect("path" in record).toBe(false)
    expect("before" in record).toBe(false)
    expect(normalizeAuditEntry({ ts: 1, session: "s", kind: "file", tool: "write_file", summary: "new", ok: true, before: null }).before).toBeNull()
  })
})

describe("normalizeEvent", () => {
  test("command-* events are kind shell with their tool", () => {
    const approved: SensusEvent = {
      type: "command-approved",
      ts: 1,
      session: "run-1",
      tool: "shell_background",
      source: "auto",
      approval: "confirm",
      agent: "copilot",
      cwd: "/tmp",
      shell: "bash",
    }
    expect(normalizeEvent(approved)).toMatchObject({ kind: "shell", tool: "shell_background", ok: true, source: "events", type: "command-approved" })

    const denied: SensusEvent = {
      type: "command-denied",
      ts: 2,
      session: "run-1",
      tool: "rm",
      source: "user",
      approval: "confirm",
      agent: "copilot",
    }
    expect(normalizeEvent(denied)).toMatchObject({ kind: "shell", tool: "rm", ok: false, type: "command-denied" })
    expect(normalizeEvent(denied).summary).toContain("denied rm")

    const ran: SensusEvent = {
      type: "command-ran",
      ts: 3,
      session: "run-1",
      tool: "shell_background",
      command: "ls -la",
      approval: "confirm",
      agent: "copilot",
      cwd: null,
      shell: "bash",
      ok: true,
      exitCode: 0,
    }
    expect(normalizeEvent(ran)).toMatchObject({ kind: "shell", tool: "shell_background", summary: "ls -la", ok: true })
  })

  test("memory-write and session-start have no tool", () => {
    const memory: SensusEvent = {
      type: "memory-write",
      ts: 4,
      session: "run-1",
      target: "memory",
      action: "add",
      beforeChars: 0,
      afterChars: 5,
      delta: 5,
      ok: true,
    }
    expect(normalizeEvent(memory)).toMatchObject({ kind: "memory", tool: null, ok: true, source: "events" })
    expect(normalizeEvent(memory).summary).toBe("add memory (+5)")

    const start: SensusEvent = {
      type: "session-start",
      ts: 5,
      session: "run-1",
      agent: "copilot",
      approval: "confirm",
      shell: "bash",
      model: "gpt",
      resumed: false,
    }
    expect(normalizeEvent(start)).toMatchObject({ kind: "session", tool: null, ok: true, type: "session-start" })
  })
})

describe("filterRecords", () => {
  const records = [
    rec({ ts: 100, session: "a", tool: "write_file", kind: "file" }),
    rec({ ts: 200, session: "b", tool: "shell_background", kind: "shell" }),
    rec({ ts: 300, session: "a", tool: "memory", kind: "memory", source: "legacy" }),
    rec({ ts: 400, session: "a", tool: "write_file", kind: "file" }),
  ]

  test("since is inclusive, until is exclusive", () => {
    expect(filterRecords(records, { since: 200 }).map((r) => r.ts)).toEqual([200, 300, 400])
    expect(filterRecords(records, { until: 300 }).map((r) => r.ts)).toEqual([100, 200])
    // Adjacent windows tile with no overlap and no gap.
    const first = filterRecords(records, { until: 300 }).map((r) => r.ts)
    const second = filterRecords(records, { since: 300 }).map((r) => r.ts)
    expect([...first, ...second]).toEqual([100, 200, 300, 400])
  })

  test("matches each string field and combines filters", () => {
    expect(filterRecords(records, { session: "a" }).map((r) => r.ts)).toEqual([100, 300, 400])
    expect(filterRecords(records, { tool: "write_file" }).map((r) => r.ts)).toEqual([100, 400])
    expect(filterRecords(records, { kind: "shell" }).map((r) => r.ts)).toEqual([200])
    expect(filterRecords(records, { session: "a", tool: "write_file", since: 150 }).map((r) => r.ts)).toEqual([400])
  })

  test("no filters returns a copy; null tool never matches a tool filter", () => {
    const all = filterRecords(records)
    expect(all).toEqual(records)
    expect(all).not.toBe(records)
    expect(filterRecords([rec({ tool: null })], { tool: "write_file" })).toEqual([])
  })
})

describe("sortNewestFirst", () => {
  test("orders by ts descending, stably, without mutating the input", () => {
    const input = [rec({ ts: 1 }), rec({ ts: 3 }), rec({ ts: 2 }), rec({ ts: 3 })]
    const sorted = sortNewestFirst(input)
    expect(sorted.map((r) => r.ts)).toEqual([3, 3, 2, 1])
    expect(input.map((r) => r.ts)).toEqual([1, 3, 2, 3])
    expect(sorted[0]).toBe(input[1])
    expect(sorted[1]).toBe(input[3])
  })
})

describe("pagination + cursors", () => {
  const records = Array.from({ length: 25 }, (_, i) => rec({ ts: i }))

  test("clamps the limit (default 20, min 1, max 100)", () => {
    expect(clampAuditLimit(undefined)).toBe(20)
    expect(clampAuditLimit(0)).toBe(1)
    expect(clampAuditLimit(-5)).toBe(1)
    expect(clampAuditLimit(500)).toBe(100)
    expect(clampAuditLimit(Number.NaN)).toBe(20)
    expect(paginate(records, undefined).records).toHaveLength(20)
    expect(paginate(records, 500).records).toHaveLength(25)
  })

  test("cursor round-trips and pages until nextCursor is null", () => {
    const first = paginate(records, 10)
    expect(first.records.map((r) => r.ts)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(first.nextCursor).not.toBeNull()
    expect(decodeCursor(first.nextCursor ?? "")).toBe(10)

    const second = paginate(records, 10, first.nextCursor ?? "")
    expect(second.records.map((r) => r.ts)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(second.nextCursor).not.toBeNull()

    const third = paginate(records, 10, second.nextCursor ?? "")
    expect(third.records.map((r) => r.ts)).toEqual([20, 21, 22, 23, 24])
    expect(third.nextCursor).toBeNull()
  })

  test("an offset past the end is an empty page; a malformed cursor throws", () => {
    const page = paginate(records, 10, encodeCursor(1000))
    expect(page.records).toEqual([])
    expect(page.nextCursor).toBeNull()

    expect(() => decodeCursor("!!!not-a-cursor")).toThrow()
    expect(() => decodeCursor(Buffer.from("{}").toString("base64url"))).toThrow()
    expect(() => paginate(records, 10, "bogus")).toThrow()
  })
})

describe("toJsonl", () => {
  test("one lossless record per line, parseable back to the input", () => {
    const records = [
      rec({ ts: 1, before: "old\ncontent" }),
      rec({ ts: 2, session: "b", kind: "memory", tool: null, summary: "add memory (+5)", source: "events", type: "memory-write" }),
    ]
    const jsonl = toJsonl(records)
    expect(jsonl.endsWith("\n")).toBe(true)
    const lines = jsonl.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "")).toEqual(records[0])
    expect(JSON.parse(lines[1] ?? "")).toEqual(records[1])
    expect(toJsonl([])).toBe("")
  })
})

describe("toCsv", () => {
  test("header, one row per record, RFC4180 escaping, and before omitted", () => {
    const records = [
      rec({ ts: 1, summary: "a,b", before: "SECRET PRIOR CONTENT" }),
      rec({ ts: 2, tool: null, kind: "memory", summary: 'he said "hi"', ok: false }),
      rec({ ts: 3, summary: "line1\nline2", path: "/tmp/x", undone: true, refTs: 2 }),
    ]
    const csv = toCsv(records)
    expect(csv.startsWith(`${CSV_COLUMNS.join(",")}\r\n`)).toBe(true)
    expect(CSV_COLUMNS).not.toContain("before")
    expect(csv).not.toContain("SECRET PRIOR CONTENT")
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"he said ""hi"""')
    expect(csv).toContain('"line1\nline2"')
    expect(csv).toContain("true") // ok / undone
    expect(csv).toContain("false") // ok=false
  })

  test("round-trips every column through a CSV parser", () => {
    const records = [rec({ ts: 1, summary: "a,b" }), rec({ ts: 2, kind: "memory", tool: null, summary: 'q"q', ok: false })]
    const rows = parseCsv(toCsv(records))
    expect(rows[0]).toEqual([...CSV_COLUMNS])
    expect(rows[1]?.[0]).toBe("1")
    expect(rows[1]?.[3]).toBe("write_file")
    expect(rows[1]?.[4]).toBe("a,b")
    expect(rows[1]?.[5]).toBe("true")
    expect(rows[2]?.[3]).toBe("")
    expect(rows[2]?.[4]).toBe('q"q')
    expect(rows[2]?.[5]).toBe("false")
  })
})

describe("auditStats", () => {
  test("totals by kind/tool/session; tool-less records count under (none)", () => {
    const records = [
      rec({ kind: "file", tool: "write_file", session: "a" }),
      rec({ kind: "shell", tool: "shell_background", session: "a" }),
      rec({ kind: "memory", tool: null, session: "b" }),
      rec({ kind: "message", tool: "mcp__x__y", session: "b" }),
    ]
    expect(auditStats(records)).toEqual({
      total: 4,
      byKind: { file: 1, shell: 1, memory: 1, message: 1 },
      byTool: { write_file: 1, shell_background: 1, "(none)": 1, mcp__x__y: 1 },
      bySession: { a: 2, b: 2 },
    })
    expect(auditStats([])).toEqual({ total: 0, byKind: {}, byTool: {}, bySession: {} })
  })

  test("maps stay bounded past the key cap", () => {
    const records = Array.from({ length: 120 }, (_, i) => rec({ ts: i, session: `s${i}`, tool: `t${i}`, kind: `k${i}` }))
    const stats = auditStats(records)
    expect(Object.keys(stats.bySession).length).toBeLessThanOrEqual(51)
    expect(stats.bySession["(other)"]).toBe(120 - 50)
    expect(stats.byKind["(other)"]).toBe(120 - 50)
    expect(stats.byTool["(other)"]).toBe(120 - 50)
    // Every record is still accounted for.
    const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0)
    expect(sum(stats.bySession)).toBe(120)
  })
})

/** Minimal RFC4180 parser for the round-trip assertion (test-only). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
