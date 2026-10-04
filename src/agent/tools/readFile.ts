import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { errorMessage } from "../../core/util.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.tools")

// ---- Bounded file reads (read_file / edit_file / write_file diffs) ----------
//
// A tool must NEVER read an unbounded file into the TUI thread (AGENTS.md rule
// 10): a multi-GB file, `/dev/zero`, `/dev/random`, a FIFO or a pseudo-file
// would OOM the process or block the synchronous read forever. Every read goes
// through this module, which refuses non-regular files WITHOUT opening them and
// caps how much is read (a positioned prefix for whole-file reads, a bounded
// streaming window for read_file's line paging of a large file).

/** Whole-file read cap for read_file / edit_file / write_file diffs. */
export const FILE_READ_MAX_BYTES = 8 * 1024 * 1024
/** Maximum bytes scanned while seeking a large file's line window. */
const SCAN_MAX_BYTES = 64 * 1024 * 1024
/** Chunk size for the streaming window read. */
const READ_CHUNK_BYTES = 256 * 1024

export interface GuardedFileRead {
  ok: true
  content: string
  /** True when the file was larger than the cap and only a prefix was read. */
  truncated: boolean
}
export type GuardedFileReadResult = GuardedFileRead | { ok: false; error: string }

/** stat() guard: only regular files are readable; never opens a device/FIFO. */
function regularFileOrError(fullPath: string): { ok: true; size: number } | { ok: false; error: string } {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(fullPath)
  } catch (e) {
    log.debug("read_file stat failed", { path: fullPath, err: e })
    return { ok: false, error: errorMessage(e) }
  }
  if (st.isDirectory()) return { ok: false, error: `${fullPath} is a directory, not a file` }
  if (!st.isFile()) return { ok: false, error: `${fullPath} is not a regular file (device, FIFO or socket) — refusing to read it` }
  return { ok: true, size: st.size }
}

/**
 * Read a regular file into a string, bounded by `maxBytes`. A larger file
 * yields only its first `maxBytes` bytes (`truncated: true`). Non-regular files
 * are refused WITHOUT opening them (a FIFO/device can block forever).
 */
export function readRegularFile(fullPath: string, maxBytes = FILE_READ_MAX_BYTES): GuardedFileReadResult {
  const g = regularFileOrError(fullPath)
  if (!g.ok) return { ok: false, error: g.error }
  const cap = Math.max(1, Math.floor(maxBytes))
  if (g.size <= cap) {
    try {
      return { ok: true, content: readFileSync(fullPath, "utf8"), truncated: false }
    } catch (e) {
      log.debug("read_file whole-file read failed", { path: fullPath, err: e })
      return { ok: false, error: errorMessage(e) }
    }
  }
  // Too large: positioned read of the bounded prefix (never the whole file).
  let fd: number | null = null
  try {
    fd = openSync(fullPath, "r")
    const buf = Buffer.allocUnsafe(cap)
    const n = readSync(fd, buf, 0, cap, 0)
    return { ok: true, content: buf.subarray(0, n).toString("utf8"), truncated: true }
  } catch (e) {
    log.debug("read_file prefix read failed", { path: fullPath, err: e })
    return { ok: false, error: errorMessage(e) }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (e) {
        // already closed
        log.debug("read_file closeSync failed", { err: e })
      }
    }
  }
}

export interface TextWindow {
  ok: true
  /** The requested lines (offset/limit applied). */
  lines: string[]
  /** True when the file has content beyond the returned window. */
  more: boolean
  /** Extra note when the requested range could not be reached within the cap. */
  note?: string
}
export type TextWindowResult = TextWindow | { ok: false; error: string }

/**
 * Read a regular text file's line window (`offset` 1-based, `limit` optional),
 * without ever loading a whole large file. Small files take the exact
 * whole-file path; larger files stream in chunks and retain only the requested
 * lines (bounded by FILE_READ_MAX_BYTES), scanning at most SCAN_MAX_BYTES to
 * reach the offset. Non-regular files are refused.
 */
export function readTextWindow(fullPath: string, offset: number, limit: number | null): TextWindowResult {
  const g = regularFileOrError(fullPath)
  if (!g.ok) return { ok: false, error: g.error }
  const start = Math.max(0, offset - 1)
  const end = limit !== null ? start + limit : Infinity
  if (g.size <= FILE_READ_MAX_BYTES) {
    let content: string
    try {
      content = readFileSync(fullPath, "utf8")
    } catch (e) {
      log.debug("read_file whole-file window read failed", { path: fullPath, err: e })
      return { ok: false, error: errorMessage(e) }
    }
    const all = content.split("\n")
    const lines = offset > 1 || limit !== null ? all.slice(start, limit !== null ? start + limit : undefined) : all
    const more = limit !== null && all.length > start + limit
    return { ok: true, lines, more }
  }
  return streamWindow(fullPath, start, end)
}

/** Streaming line-window read for a file larger than the whole-file cap. */
function streamWindow(fullPath: string, start: number, end: number): TextWindowResult {
  let fd: number | null = null
  try {
    fd = openSync(fullPath, "r")
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    const dec = new TextDecoder()
    const out: string[] = []
    let carry = ""
    let index = 0
    let scanned = 0
    let retained = 0
    let more = false
    let capped = false
    let pos = 0
    for (;;) {
      if (scanned >= SCAN_MAX_BYTES) {
        capped = true
        more = true
        break
      }
      const want = Math.min(READ_CHUNK_BYTES, SCAN_MAX_BYTES - scanned)
      const n = readSync(fd, buf, 0, want, pos)
      if (n <= 0) break
      pos += n
      scanned += n
      const text = dec.decode(buf.subarray(0, n), { stream: true })
      // Only split when the chunk actually closes a line: a single enormous
      // line (no newlines) must not trigger a repeated full-buffer scan.
      if (!text.includes("\n")) {
        carry += text
        if (carry.length >= SCAN_MAX_BYTES) {
          capped = true
          more = true
          break
        }
        continue
      }
      carry += text
      const parts = carry.split("\n")
      carry = parts.pop() ?? ""
      let stop = false
      for (const line of parts) {
        if (index >= end) {
          more = true
          stop = true
          break
        }
        if (index >= start) {
          out.push(line)
          retained += line.length + 1
        }
        index++
      }
      if (stop) break
      // A run-away whole-file read on a huge file is itself capped.
      if (retained >= FILE_READ_MAX_BYTES) {
        more = true
        capped = true
        break
      }
    }
    // A trailing partial line (no final newline) is the file's last line.
    if (carry.length > 0) {
      if (index < end && !capped) {
        if (index >= start) out.push(carry)
        index++
      } else {
        more = true
      }
    }
    const note =
      capped && out.length === 0
        ? "the requested line range is beyond what sensus scans for a very large file — read an earlier offset"
        : undefined
    return { ok: true, lines: out, more, ...(note !== undefined ? { note } : {}) }
  } catch (e) {
    log.debug("read_file stream window failed", { path: fullPath, err: e })
    return { ok: false, error: errorMessage(e) }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (e) {
        // already closed
        log.debug("read_file stream closeSync failed", { err: e })
      }
    }
  }
}
