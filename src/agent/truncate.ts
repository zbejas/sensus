/**
 * Tool-output truncation (docs/config.md "tool_output"; mirrors OpenCode's
 * `tool/truncate.ts`).
 *
 * A tool result that exceeds `maxLines` or `maxBytes` is replaced by a preview
 * plus a pointer: the FULL text is written under the tool-output dir and the
 * model is told to read it back with `read_file` / `shell_background`. This
 * keeps tool output recoverable instead of destroying it at a fixed 2k clip at
 * write time (the old `clipToolResult` policy).
 *
 * Best-effort: a missing dir or a failed write degrades to a preview with no
 * path — never throws (AGENTS.md rule 10).
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { componentLogger } from "./log.ts"

const log = componentLogger("agent.tools")

/** OpenCode defaults (`tool_output.max_lines` / `tool_output.max_bytes`). */
export const DEFAULT_MAX_LINES = 2_000
export const DEFAULT_MAX_BYTES = 50 * 1024

export interface ToolOutputLimits {
  maxLines: number
  maxBytes: number
}

export interface TruncateResult {
  /** The model-facing text (preview + pointer when truncated). */
  content: string
  truncated: boolean
  /** Absolute path of the full output — only when it was spilled. */
  outputPath?: string
}

/** Spill files older than this are deleted (OpenCode: 7 days). */
export const TRUNCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_THROTTLE_MS = 60 * 60 * 1000

let lastCleanup = 0
let seq = 0

/** `<stateDir>/tool-output` — where truncated tool results are spilled. */
export function toolOutputDir(stateDir: string): string {
  return join(stateDir, "tool-output")
}

function nextId(): string {
  seq = (seq + 1) % 1_000_000
  return `tool_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 8)}`
}

function truncationHint(outputPath: string | null): string {
  const head = "The tool call succeeded but the output was truncated."
  if (outputPath === null) return head
  return (
    `${head} Full output saved to: ${outputPath}\n` +
    "Use read_file with offset/limit to view specific sections, or grep the file with shell_background."
  )
}

/**
 * Delete `tool_*` spill files older than `maxAgeMs`. Best-effort; never throws.
 */
export function cleanupToolOutput(dir: string, maxAgeMs = TRUNCATION_RETENTION_MS, now = Date.now()): void {
  try {
    const cutoff = now - maxAgeMs
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("tool_")) continue
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
      } catch (e) {
        // The file vanished / is unreadable — nothing to do.
        log.debug("tool output cleanup stat/rm failed", { file, err: e })
      }
    }
  } catch (e) {
    // Missing dir / unreadable — nothing to clean.
    log.debug("tool output cleanup dir unreadable", { dir, err: e })
  }
}

/**
 * Cap `text` at `opts.limits`, keeping `opts.direction` (default "head").
 * Returns the input unchanged when it fits; otherwise the full text is spilled
 * to `opts.dir` (when non-null) and the content becomes a preview + pointer.
 */
export function truncateToolOutput(
  text: string,
  opts: { limits?: ToolOutputLimits; direction?: "head" | "tail"; dir?: string | null } = {},
): TruncateResult {
  const limits = opts.limits ?? { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }
  const maxLines = Math.max(1, Math.floor(limits.maxLines))
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes))
  if (text.length === 0) return { content: text, truncated: false }

  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) return { content: text, truncated: false }

  const direction = opts.direction ?? "head"
  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i]!, "utf8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(lines[i]!)
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i]!, "utf8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(lines[i]!)
      bytes += size
    }
  }
  // A single line larger than maxBytes leaves the buffer empty; byte-slice that
  // one line so the preview is always reduced (never an unbounded line). The
  // byte cap still tripped, so `hitBytes` stays true and `removed` is computed
  // against the sliced size.
  if (out.length === 0) {
    const line = direction === "head" ? lines[0]! : lines[lines.length - 1]!
    const sliced = Buffer.from(line, "utf8").subarray(0, maxBytes).toString("utf8")
    out.push(sliced)
    bytes = Buffer.byteLength(sliced, "utf8")
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
  const unit = hitBytes ? "bytes" : "lines"
  const dir = opts.dir ?? null
  let outputPath: string | null = null
  if (dir !== null) {
    try {
      mkdirSync(dir, { recursive: true })
      outputPath = join(dir, nextId())
      writeFileSync(outputPath, text, "utf8")
      const now = Date.now()
      if (now - lastCleanup > CLEANUP_THROTTLE_MS) {
        lastCleanup = now
        cleanupToolOutput(dir)
      }
    } catch (e) {
      outputPath = null
      log.debug("tool output spill write failed; preview only", { dir, err: e })
    }
  }
  const preview = out.join("\n")
  return {
    content:
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${truncationHint(outputPath)}`
        : `...${removed} ${unit} truncated...\n\n${truncationHint(outputPath)}\n\n${preview}`,
    truncated: true,
    ...(outputPath !== null ? { outputPath } : {}),
  }
}
