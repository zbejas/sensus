/**
 * Tool-output truncation unit tests (docs/config.md "tool_output";
 * `src/agent/truncate.ts`): fits-under-limit passthrough, head vs tail,
 * lines-vs-bytes `removed` accounting, disk spill + readable pointer, hint
 * text, null-dir degradation, unwritable-dir safety, and stale-file cleanup.
 * Real files in a temp dir; no PTY, no network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupToolOutput,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateToolOutput,
} from "../../../src/agent/truncate.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sensus-truncate-"))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/** `n` distinct short lines ("row 0" …) — deterministic byte accounting. */
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `row ${i}`).join("\n")

describe("truncateToolOutput", () => {
  test("output under the limits is returned untouched", () => {
    const text = "hello\nworld"
    expect(truncateToolOutput(text, { limits: { maxLines: 10, maxBytes: 1000 }, dir: null })).toEqual({
      content: text,
      truncated: false,
    })
    // No opts at all uses the V2-parity defaults.
    expect(truncateToolOutput(text).truncated).toBe(false)
    expect(DEFAULT_MAX_LINES).toBe(2000)
    expect(DEFAULT_MAX_BYTES).toBe(51200)
  })

  test("head keeps the first lines; tail keeps the last", () => {
    const text = lines(100)
    const head = truncateToolOutput(text, { limits: { maxLines: 5, maxBytes: 1_000_000 }, direction: "head", dir: null })
    expect(head.truncated).toBe(true)
    expect(head.content).toContain("row 0")
    expect(head.content).not.toContain("row 99")
    expect(head.content).toContain("95 lines truncated")
    const tail = truncateToolOutput(text, { limits: { maxLines: 5, maxBytes: 1_000_000 }, direction: "tail", dir: null })
    expect(tail.truncated).toBe(true)
    expect(tail.content).toContain("row 99")
    expect(tail.content).not.toContain("row 0")
  })

  test("removed accounting distinguishes lines from bytes", () => {
    // Lines: 100 small rows, keep 5 -> 95 lines removed.
    const byLines = truncateToolOutput(lines(100), { limits: { maxLines: 5, maxBytes: 1_000_000 }, dir: null })
    expect(byLines.content).toContain("95 lines truncated")
    // Bytes: ten 10-char rows (109 bytes) with a 50-byte budget -> 4 rows
    // (43 bytes) fit; 66 bytes removed even though the line count is under.
    const rows = Array.from({ length: 10 }, () => "0123456789").join("\n")
    const byBytes = truncateToolOutput(rows, { limits: { maxLines: 1_000, maxBytes: 50 }, dir: null })
    expect(byBytes.content).toContain("bytes truncated")
    expect(byBytes.content).toContain("66 bytes truncated")
  })

  test("a single line over the byte budget is byte-sliced (not kept whole); the spill holds the full line", () => {
    const full = "y".repeat(60_000)
    const r = truncateToolOutput(full, { limits: { maxLines: 2_000, maxBytes: 51_200 }, dir })
    expect(r.truncated).toBe(true)
    expect(r.content).toContain("bytes truncated")
    // Bounded to the byte cap (+ marker/hint), never the 60k original.
    expect(r.content.length).toBeLessThan(51_200 + 600)
    expect(r.content.length).toBeLessThan(full.length)
    // The full original line is recoverable from the spill file.
    expect(r.outputPath).toBeDefined()
    expect(readFileSync(r.outputPath!, "utf8")).toBe(full)
  })

  test("overflow spills the FULL text to a readable file and points the model at it", () => {
    const full = lines(5000)
    const r = truncateToolOutput(full, { limits: { maxLines: 10, maxBytes: 1_000_000 }, dir })
    expect(r.truncated).toBe(true)
    expect(r.outputPath).toBeDefined()
    expect(readFileSync(r.outputPath!, "utf8")).toBe(full)
    expect(r.content).toContain("read_file")
    expect(r.content).toContain("shell_background")
    expect(r.content).toContain(r.outputPath!)
    expect(r.content.length).toBeLessThan(full.length)
  })

  test("dir:null still caps without a path; an unwritable dir degrades without throwing", () => {
    const full = lines(5000)
    const noDir = truncateToolOutput(full, { limits: { maxLines: 10, maxBytes: 1_000_000 }, dir: null })
    expect(noDir.truncated).toBe(true)
    expect(noDir.outputPath).toBeUndefined()
    expect(noDir.content).toContain("truncated")
    // A regular file where the tool-output dir should be: mkdir fails -> preview only.
    const fileAsDir = join(dir, "not-a-dir")
    writeFileSync(fileAsDir, "x")
    const broken = truncateToolOutput(full, {
      limits: { maxLines: 10, maxBytes: 1_000_000 },
      dir: join(fileAsDir, "tool-output"),
    })
    expect(broken.truncated).toBe(true)
    expect(broken.outputPath).toBeUndefined()
  })
})

describe("cleanupToolOutput", () => {
  test("deletes stale tool_* files only; keeps fresh spills and unrelated names", () => {
    const spill = join(dir, "cleanup")
    mkdirSync(spill, { recursive: true })
    const stale = join(spill, "tool_stale")
    const fresh = join(spill, "tool_fresh")
    const other = join(spill, "notes.txt")
    writeFileSync(stale, "old")
    writeFileSync(fresh, "new")
    writeFileSync(other, "keep")
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(stale, past, past)
    cleanupToolOutput(spill, 7 * 24 * 60 * 60 * 1000, Date.now())
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
    // A missing dir is a no-op, never a throw.
    expect(() => cleanupToolOutput(join(dir, "does-not-exist"))).not.toThrow()
  })
})
