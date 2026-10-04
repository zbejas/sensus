/**
 * `sensus daemon logs` reading the STRUCTURED log (docs/logging.md; Phase 5).
 *
 * Drives `runDaemon(["logs", ...], io, env)` against a hermetic runtime dir with
 * a hand-written `daemon-log.jsonl`, asserting the raw NDJSON passthrough, the
 * `--level`/`--component` filters, pretty rendering (with and without ANSI), and
 * the missing-file message naming the structured path.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { daemonLogJsonlPath, daemonLogPath, runDaemon, type DaemonIo } from "../../../src/daemon/index.ts"

interface Capture {
  out: string[]
  err: string[]
  io: DaemonIo
}

function captureIo(): Capture {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

/** A hermetic runtime dir + the env the CLI resolves it from. */
function withRuntimeDir(fn: (info: { dir: string; env: Record<string, string>; write: (text: string) => void }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-logs-"))
  const env: Record<string, string> = { SENSUS_RUNTIME_DIR: dir }
  const write = (text: string): void => writeFileSync(daemonLogJsonlPath(dir), text)
  return fn({ dir, env, write }).finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** Three records spanning components + levels, one with an error + corrId. */
const RECORDS = [
  {
    ts: 1_700_000_000_000,
    level: "info",
    severityNumber: 9,
    msg: "shell spawned",
    component: "daemon.shells",
    attributes: { pid: 1234 },
  },
  {
    ts: 1_700_000_001_000,
    level: "warn",
    severityNumber: 13,
    msg: "slow turn",
    component: "daemon.chats",
    corrId: "corr-1",
  },
  {
    ts: 1_700_000_002_000,
    level: "error",
    severityNumber: 17,
    msg: "http request failed",
    component: "daemon.ws",
    err: { type: "Error", message: "boom", stack: "Error: boom\n    at x (a.ts:1:1)" },
  },
]
const RECORD_LINES = RECORDS.map((r) => JSON.stringify(r))
const LOG_TEXT = `${RECORD_LINES.join("\n")}\n`

const ANSI = /\x1b\[[0-9;]*m/

describe("sensus daemon logs: raw NDJSON", () => {
  test("--json emits each parsed record unchanged", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out, err } = captureIo()
      expect(await runDaemon(["logs", "--json"], io, env)).toBe(0)
      expect(err).toEqual([])
      const lines = out.join("\n").split("\n")
      expect(lines).toEqual(RECORD_LINES)
      // A record is parseable JSON as emitted.
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ msg: "shell spawned", component: "daemon.shells" })
      expect(out.join("\n")).not.toMatch(ANSI)
    })
  })

  test("--level warn drops info and keeps warn/error", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      expect(await runDaemon(["logs", "--json", "--level", "warn"], io, env)).toBe(0)
      const lines = out.join("\n").split("\n")
      expect(lines).toEqual([RECORD_LINES[1]!, RECORD_LINES[2]!])
    })
  })

  test("--level debug keeps everything at debug and above", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      await runDaemon(["logs", "--json", "--level=debug"], io, env)
      expect(out.join("\n").split("\n")).toEqual(RECORD_LINES)
    })
  })

  test("an invalid --level is reported and exits nonzero", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out, err } = captureIo()
      expect(await runDaemon(["logs", "--level", "verbose"], io, env)).toBe(1)
      expect(out).toEqual([])
      expect(err.join("\n")).toContain("invalid --level")
    })
  })
})

describe("sensus daemon logs: --component filter", () => {
  test("exact match keeps only that component", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      expect(await runDaemon(["logs", "--json", "--component", "daemon.chats"], io, env)).toBe(0)
      expect(out.join("\n").split("\n")).toEqual([RECORD_LINES[1]!])
    })
  })

  test("a trailing-* matches a component prefix", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      expect(await runDaemon(["logs", "--json", "--component=daemon.ws*"], io, env)).toBe(0)
      expect(out.join("\n").split("\n")).toEqual([RECORD_LINES[2]!])
    })
  })

  test("component and level filters compose", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      expect(await runDaemon(["logs", "--json", "--component", "daemon*", "--level", "warn"], io, env)).toBe(0)
      expect(out.join("\n").split("\n")).toEqual([RECORD_LINES[1]!, RECORD_LINES[2]!])
    })
  })
})

describe("sensus daemon logs: pretty rendering", () => {
  test("--pretty renders level + msg with ANSI colors", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      expect(await runDaemon(["logs", "--pretty"], io, { ...env, FORCE_COLOR: "1" })).toBe(0)
      const text = out.join("\n")
      expect(text).toMatch(ANSI)
      expect(text).toContain("INFO")
      expect(text).toContain("shell spawned")
      expect(text).toContain("daemon.shells")
      expect(text).toContain("WARN")
      expect(text).toContain("slow turn")
      // corrId is surfaced (dimmed) and the error message is appended.
      expect(text).toContain("corr-1")
      expect(text).toContain("boom")
      // dimmed corrId style
      expect(text).toContain("\x1b[90m")
    })
  })

  test("NO_COLOR strips all ANSI but keeps the readable line", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      expect(await runDaemon(["logs", "--pretty"], io, { ...env, NO_COLOR: "1" })).toBe(0)
      const text = out.join("\n")
      expect(text).not.toMatch(ANSI)
      expect(text).toContain("shell spawned")
      expect(text).toContain("INFO")
    })
  })

  test("a non-TTY stdout with no color flags falls back to raw NDJSON", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      // bun's test stdout is not a TTY, and no COLOR flags are set: raw.
      expect(await runDaemon(["logs"], io, env)).toBe(0)
      expect(out.join("\n").split("\n")).toEqual(RECORD_LINES)
    })
  })

  test("--pretty filters pretty output by level", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const { io, out } = captureIo()
      await runDaemon(["logs", "--pretty", "--level", "error"], io, { ...env, FORCE_COLOR: "1" })
      const text = out.join("\n")
      expect(text).toContain("http request failed")
      expect(text).not.toContain("shell spawned")
    })
  })

  test("the last of --json/--pretty wins", async () => {
    await withRuntimeDir(async ({ env, write }) => {
      write(LOG_TEXT)
      const first = captureIo()
      await runDaemon(["logs", "--json", "--pretty"], first.io, { ...env, FORCE_COLOR: "1" })
      expect(first.out.join("\n")).toMatch(ANSI)

      const second = captureIo()
      await runDaemon(["logs", "--pretty", "--json"], second.io, { ...env, FORCE_COLOR: "1" })
      expect(second.out.join("\n").split("\n")).toEqual(RECORD_LINES)
    })
  })
})

describe("sensus daemon logs: missing files", () => {
  test("a missing structured log names its path and exits 0", async () => {
    await withRuntimeDir(async ({ env, dir }) => {
      const { io, out } = captureIo()
      expect(await runDaemon(["logs"], io, env)).toBe(0)
      expect(out.join("\n")).toContain(daemonLogJsonlPath(dir))
      expect(existsSync(daemonLogJsonlPath(dir))).toBe(false)
    })
  })

  test("an existing raw banner is called out, not silently ignored", async () => {
    await withRuntimeDir(async ({ env, dir }) => {
      writeFileSync(daemonLogPath(dir), "raw stdio banner\n")
      const { io, out } = captureIo()
      expect(await runDaemon(["logs"], io, env)).toBe(0)
      const text = out.join("\n")
      expect(text).toContain(daemonLogJsonlPath(dir))
      expect(text).toContain(daemonLogPath(dir))
      expect(text).toContain("raw stdio banner")
    })
  })
})
