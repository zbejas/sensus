/**
 * Agent structured logging (docs/agent.md; mirrors tests/unit/daemon/logging.test.ts):
 *
 *  1. `componentLogger` resolves the process logger lazily — a module-level
 *     child captured before `configureLogger` must still land in the file sink
 *     configured later (the ordering regression guard).
 *  2. An instrumented silent catch (AuditLog's append failure) emits an
 *     error-level record with a serialized `err`.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configureLogger, flushLoggerSync, readLogFile, type LogRecord } from "../../../src/core/log.ts"
import { componentLogger } from "../../../src/agent/log.ts"
import { AuditLog } from "../../../src/agent/audit.ts"

const silentLogger = (): void => configureLogger({ level: "error", sink: () => {} })

describe("agent structured logging", () => {
  test("componentLogger binds the component and resolves the file sink configured after module load", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-agent-log-"))
    const path = join(dir, "agent-log.jsonl")
    try {
      // Bind the child FIRST — before any file sink exists. A module-level child
      // captured at import has the same relationship to the later configure.
      const log = componentLogger("agent.x")
      configureLogger({ path, level: "debug" })

      log.warn("agent.x warn lands in the configured file", { detail: 1 })
      flushLoggerSync()

      const recs: LogRecord[] = readLogFile(path)
      const rec = recs.find((r) => r.msg === "agent.x warn lands in the configured file")
      expect(rec).toBeDefined()
      expect(rec?.level).toBe("warn")
      expect(rec?.component).toBe("agent.x")
      expect(rec?.attributes?.["detail"]).toBe(1)
    } finally {
      flushLoggerSync()
      silentLogger()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failing AuditLog.record emits a warn record with the serialized err", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-agent-log-"))
    const path = join(dir, "agent-log.jsonl")
    try {
      configureLogger({ path, level: "debug" })
      // Materialize the parent dir as a FILE so `mkdirSync(dirname(path))`
      // throws inside AuditLog.record — the instrumented error-level catch.
      const blocker = join(dir, "blocker")
      writeFileSync(blocker, "")
      const audit = new AuditLog({ path: join(blocker, "audit.jsonl") })
      audit.record({
        ts: 1,
        session: "i",
        kind: "file",
        tool: "write_file",
        summary: "/tmp/a.txt",
        ok: true,
        path: "/tmp/a.txt",
        before: null,
      })
      flushLoggerSync()

      const recs: LogRecord[] = readLogFile(path)
      const rec = recs.find((r) => r.msg === "audit record write failed; undo/audit trail dropped")
      expect(rec).toBeDefined()
      expect(rec?.level).toBe("warn")
      expect(rec?.component).toBe("agent.audit")
      expect(rec?.err?.message).toBeString()
      expect(rec?.attributes?.["tool"]).toBe("write_file")
    } finally {
      flushLoggerSync()
      silentLogger()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
