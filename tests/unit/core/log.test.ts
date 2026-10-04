/**
 * Structured logging core (src/core/log.ts): the NDJSON envelope, error
 * serialization, redaction, level gating, child/correlation bindings, file
 * round-trip + rotation, and the never-throws contract. Scenario-shaped —
 * every assertion reads a real serialized/round-tripped record.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LOG_LEVELS,
  createLogger,
  flushLoggerSync,
  getLogger,
  parseLogLine,
  readLogFile,
  serializeError,
  severityNumber,
  withCorrelation,
  type LogLevel,
} from "../../../src/core/log.ts"

/** Fixed clock so `ts` is deterministic in assertions. */
const TS = 1_759_100_000_000
const now = (): number => TS

describe("log: envelope + severity", () => {
  test("each level carries the OTel severity number and the fixed envelope keys", () => {
    expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error"])
    expect(LOG_LEVELS.map(severityNumber)).toEqual([1, 5, 9, 13, 17])

    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now, level: "trace", component: "daemon.shell", instanceId: "i-1", session: "ses_ab12" })
    for (const level of LOG_LEVELS) logger[level](`at ${level}`)

    expect(lines).toHaveLength(5)
    const records = lines.map((l) => parseLogLine(l))
    records.forEach((rec, i) => {
      const level = LOG_LEVELS[i] as LogLevel
      expect(rec).not.toBeNull()
      expect(rec?.ts).toBe(TS)
      expect(rec?.level).toBe(level)
      expect(rec?.severityNumber).toBe(severityNumber(level))
      expect(rec?.msg).toBe(`at ${level}`)
      expect(rec?.component).toBe("daemon.shell")
      expect(rec?.instanceId).toBe("i-1")
      expect(rec?.session).toBe("ses_ab12")
      // No caller fields -> the envelope stays lean (no attributes key).
      expect(rec?.attributes).toBeUndefined()
      // The raw line is pure compact JSON, never ANSI.
      expect(lines[i]?.includes("\x1b[")).toBe(false)
    })
  })
})

describe("log: level gating", () => {
  test("records below the configured level are dropped before serialization", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now, level: "warn" })
    logger.trace("t")
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")
    expect(lines.map((l) => parseLogLine(l)?.msg)).toEqual(["w", "e"])
  })
})

describe("log: attributes + reserved-key protection", () => {
  test("caller fields nest under attributes and cannot override the envelope", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now })
    logger.info("shell spawned", { pid: 1234, level: "trace", msg: "hijacked", ts: -1, severityNumber: 999 })
    const rec = parseLogLine(lines[0] ?? "")
    expect(rec?.level).toBe("info")
    expect(rec?.severityNumber).toBe(9)
    expect(rec?.msg).toBe("shell spawned")
    expect(rec?.ts).toBe(TS)
    expect(rec?.attributes).toEqual({ pid: 1234, level: "trace", msg: "hijacked", ts: -1, severityNumber: 999 })
  })
})

describe("log: serializeError", () => {
  test("an Error with a .cause chain walks the chain", () => {
    const root = Object.assign(new Error("disk full"), { code: "E_BOOT" })
    const outer = new Error("boot failed", { cause: root })
    const s = serializeError(outer)
    expect(s.type).toBe("Error")
    expect(s.message).toBe("boot failed")
    expect(typeof s.stack).toBe("string")
    expect(s.cause?.message).toBe("disk full")
    expect(s.cause?.code).toBe("E_BOOT")
  })

  test("an AggregateError exposes its members as errors", () => {
    const agg = new AggregateError([new Error("a"), new Error("b")], "many failed")
    const s = serializeError(agg)
    expect(s.type).toBe("AggregateError")
    expect(s.errors?.map((e) => e.message)).toEqual(["a", "b"])
  })

  test("a thrown string is captured without throwing", () => {
    const s = serializeError("plain boom")
    expect(s.message).toBe("plain boom")
    expect(s.type).toBe("string")
  })
})

describe("log: redaction", () => {
  test("sensitive keys, secret substrings, and extra literals are scrubbed live", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now, redact: ["hunter2-literal"] })
    const hex = "a".repeat(64)
    logger.info("calling with Bearer abc.def-123", {
      authorization: "Bearer abc.def-123",
      extra: `token=${hex} key=sk-abcdefgh1234 gh=ghp_abcdefghijklmnop`,
      note: "the secret is hunter2-literal here",
    })

    const raw = lines[0] ?? ""
    expect(raw).not.toContain("Bearer abc.def-123")
    expect(raw).not.toContain(hex)
    expect(raw).not.toContain("sk-abcdefgh1234")
    expect(raw).not.toContain("ghp_abcdefghijklmnop")
    expect(raw).not.toContain("hunter2-literal")
    // Surrounding message text survives the substring pass.
    expect(parseLogLine(raw)?.msg).toBe("calling with [redacted]")
    expect(parseLogLine(raw)?.attributes?.["authorization"]).toBe("[redacted]")
  })

  test("err.message/err.stack are scrubbed too", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now })
    const err = new Error("auth failed: Bearer topsecret-xyz")
    logger.error("request failed", { err })
    const raw = lines[0] ?? ""
    expect(raw).not.toContain("topsecret-xyz")
    expect(parseLogLine(raw)?.err?.message).toBe("auth failed: [redacted]")
  })
})

describe("log: circular + oversized values never throw", () => {
  test("a circular attribute object serializes to a truncation marker", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now })
    const circular: Record<string, unknown> = { name: "loop" }
    circular["self"] = circular
    expect(() => logger.info("circular", { circular })).not.toThrow()
    const rec = parseLogLine(lines[0] ?? "")
    expect(rec?.msg).toBe("circular")
    const nested = rec?.attributes?.["circular"] as Record<string, unknown>
    expect(nested["name"]).toBe("loop")
    // The cycle is broken by the replacer at the first repeat: `self` mirrors
    // the outer object, so its own `self` back-reference is truncated.
    const selfOnce = nested["self"] as Record<string, unknown>
    expect(selfOnce["name"]).toBe("loop")
    const depth = rec?.attributes?.["circular"] as Record<string, unknown>
    expect(JSON.stringify(depth)).toContain('"$truncated":true')
  })

  test("an over-long line is capped and marked truncated, not thrown", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now })
    expect(() => logger.info("big", { blob: "x".repeat(200_000) })).not.toThrow()
    const raw = lines[0] ?? ""
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64 * 1024)
    expect(raw).toContain('"$truncated":true')
  })
})

describe("log: child bindings + correlation", () => {
  test("child() merges bindings (override wins) and withCorrelation supplies corrId", () => {
    const lines: string[] = []
    const { logger } = createLogger({ sink: (l) => lines.push(l), now, component: "root", instanceId: "i-1" })
    const child = logger.child({ component: "child", session: "ses_x" })

    child.info("inside")
    const inside = parseLogLine(lines[0] ?? "")
    expect(inside?.component).toBe("child")
    expect(inside?.instanceId).toBe("i-1")
    expect(inside?.session).toBe("ses_x")
    expect(inside?.corrId).toBeUndefined()

    withCorrelation("corr-99", () => {
      child.info("correlated")
    })
    expect(parseLogLine(lines[1] ?? "")?.corrId).toBe("corr-99")
  })

  test("child loggers share the parent's queue, so flushSync drains them too", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-test-"))
    try {
      const path = join(dir, "child.ndjson")
      const { logger, flushSync } = createLogger({ path, now })
      const child = logger.child({ component: "child", session: "ses_x" })
      // Emit through both the parent and a grandchild, then drain only via the ROOT handle.
      logger.info("from root")
      child.info("from child")
      child.child({ component: "grandchild" }).info("from grandchild")
      flushSync()

      const records = readLogFile(path)
      expect(records.map((r) => r.msg)).toEqual(["from root", "from child", "from grandchild"])
      expect(records[1]?.component).toBe("child")
      expect(records[2]?.component).toBe("grandchild")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("log: file round-trip + rotation", () => {
  test("NDJSON written to disk round-trips and rotates to .1 past maxBytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-test-"))
    try {
      const path = join(dir, "app.ndjson")
      const { logger, flushSync } = createLogger({ path, maxBytes: 200, queueMax: 1000, now })
      for (let i = 0; i < 20; i++) {
        logger.info(`line ${i}`)
        flushSync() // incremental appends so rotation triggers once the file has content
      }
      flushSync()

      const rotated = `${path}.1`
      expect(existsSync(path)).toBe(true)
      expect(existsSync(rotated)).toBe(true)

      const records = readLogFile(path).concat(readLogFile(rotated))
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((r) => r.level === "info" && r.ts === TS)).toBe(true)
      // The file is pure JSON — never ANSI escapes.
      expect(readLogFile(path).every((r) => r.msg.startsWith("line "))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("log: parseLogLine", () => {
  test("returns null for blank/garbage and a record for a good line", () => {
    expect(parseLogLine("")).toBeNull()
    expect(parseLogLine("   ")).toBeNull()
    expect(parseLogLine("not json")).toBeNull()
    expect(parseLogLine('{"level":"bogus","ts":1,"msg":"x"}')).toBeNull()
    expect(parseLogLine('{"msg":"no ts","level":"info"}')).toBeNull()
    const rec = parseLogLine('{"ts":5,"level":"info","msg":"hi","extra":"kept"}')
    expect(rec?.msg).toBe("hi")
    expect(rec?.severityNumber).toBe(9)
    expect((rec as unknown as Record<string, unknown>)["extra"]).toBe("kept")
  })
})

describe("log: never throws", () => {
  test("an unwritable path drops the batch and readLogFile returns []", () => {
    const handle = createLogger({ path: "/proc/definitely/not/writable.ndjson", now })
    expect(() => handle.logger.info("nope")).not.toThrow()
    expect(() => handle.flushSync()).not.toThrow()

    // The process-wide logger is safe before/without configuration too.
    expect(() => getLogger().info("stderr fallback")).not.toThrow()
    expect(() => flushLoggerSync()).not.toThrow()
    expect(readLogFile("/proc/definitely/not/writable.ndjson")).toEqual([])
  })

  test("reading a corrupt file skips malformed lines without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-test-"))
    try {
      const path = join(dir, "corrupt.ndjson")
      const good = `{"ts":1,"level":"info","severityNumber":9,"msg":"ok"}`
      writeFileSync(path, `${good}\n\n{GARBAGE\n${good.slice(0, 20)}`)
      const records = readLogFile(path)
      expect(records).toHaveLength(1)
      expect(records[0]?.msg).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
