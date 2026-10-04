import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuditLog } from "../../../src/agent/audit.ts"

function withLog(fn: (log: AuditLog, path: string) => void, keep?: number): void {
  const dir = mkdtempSync(join(tmpdir(), "sensus-audit-"))
  const path = join(dir, "audit.jsonl")
  try {
    fn(new AuditLog({ path, keep }), path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fileEntry = (ts: number, before: string | null) => ({
  ts,
  session: "inst",
  kind: "file",
  tool: "write_file",
  summary: "/tmp/a.txt",
  ok: true,
  path: "/tmp/a.txt",
  before,
})

describe("AuditLog", () => {
  test("record/recent round-trip; recent returns the tail", () => {
    withLog((log) => {
      for (let i = 1; i <= 5; i++) log.record(fileEntry(i, `v${i}`))
      const last2 = log.recent(2)
      expect(last2.map((e) => e.ts)).toEqual([4, 5])
      expect(last2[1]?.before).toBe("v5")
    })
  })

  test("lastUndoable returns the newest file write; markUndone moves further back", () => {
    withLog((log) => {
      log.record({ ts: 1, session: "i", kind: "memory", tool: "memory", summary: "add", ok: true })
      log.record(fileEntry(2, "old-a"))
      log.record(fileEntry(3, "old-b"))
      expect(log.lastUndoable()?.ts).toBe(3)
      log.markUndone(3)
      expect(log.lastUndoable()?.ts).toBe(2)
      log.markUndone(2)
      expect(log.lastUndoable()).toBeNull()
    })
  })

  test("the log is bounded (oldest entries trimmed past the keep budget)", () => {
    withLog((log) => {
      for (let i = 0; i < 30; i++) log.record(fileEntry(i, `v${i}`))
      expect(log.recent(1000).length).toBeLessThanOrEqual(30)
      expect(log.recent(1)[0]?.ts).toBe(29)
    }, 5)
  })

  test("a corrupt line is skipped and an unwritable path never throws", () => {
    withLog((log, path) => {
      writeFileSync(path, `${JSON.stringify(fileEntry(1, "x"))}\nnot json\n`, "utf8")
      expect(log.recent().map((e) => e.ts)).toEqual([1])
      log.record(fileEntry(2, "y"))
      expect(log.recent().map((e) => e.ts)).toEqual([1, 2])
    })
    const bad = new AuditLog({ path: "/nonexistent-dir-xyz/audit.jsonl" })
    expect(() => bad.record(fileEntry(1, "x"))).not.toThrow()
  })
})
