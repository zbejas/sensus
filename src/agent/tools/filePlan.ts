import { existsSync, writeFileSync } from "node:fs"
import { countOccurrences } from "../../core/util.ts"
import { resolveToolPath } from "./parse.ts"
import { compactDiff, diffLinesText } from "./diff.ts"
import { FILE_READ_MAX_BYTES, readRegularFile } from "./readFile.ts"
import type { FilePlan, PlanResult } from "./types.ts"

// ---- File plans (edit_file / write_file) --------------------------------------

export const argString = (args: Record<string, unknown>, key: string): string | null => {
  const v = args[key]
  return typeof v === "string" ? v : null
}

export const numArg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Validate args + compute the planned content/diff WITHOUT writing. */
export function planEditFile(args: Record<string, unknown>, baseCwd: string | null): PlanResult {
  const path = argString(args, "path")
  const oldStr = argString(args, "old_string")
  const newStr = argString(args, "new_string")
  if (!path || path.length === 0) return { ok: false, error: "edit_file: missing path" }
  if (oldStr === null) return { ok: false, error: "edit_file: missing old_string" }
  if (newStr === null) return { ok: false, error: "edit_file: missing new_string" }
  const full = resolveToolPath(path, baseCwd)
  const read = readRegularFile(full)
  if (!read.ok) return { ok: false, error: `edit_file: cannot read ${path} (${read.error})` }
  if (read.truncated) {
    const mb = Math.floor(FILE_READ_MAX_BYTES / (1024 * 1024))
    return { ok: false, error: `edit_file: ${path} is larger than ${mb} MB — too large to edit safely with this tool` }
  }
  const content = read.content
  const count = countOccurrences(content, oldStr)
  if (count === 0) return { ok: false, error: `edit_file: old_string not found in ${path}` }
  if (count > 1) {
    return {
      ok: false,
      error: `edit_file: old_string is not unique (${count} occurrences in ${path}) — include more surrounding lines`,
    }
  }
  const newContent = content.replace(oldStr, newStr)
  return {
    ok: true,
    plan: { path: full, newContent, existed: true, diff: compactDiff(diffLinesText(content, newContent)) },
  }
}

export function planWriteFile(args: Record<string, unknown>, baseCwd: string | null): PlanResult {
  const path = argString(args, "path")
  const content = argString(args, "content")
  if (!path || path.length === 0) return { ok: false, error: "write_file: missing path" }
  if (content === null) return { ok: false, error: "write_file: missing content" }
  const full = resolveToolPath(path, baseCwd)
  const existed = existsSync(full)
  if (existed) {
    // Bound the diff's old-text read: a huge existing file is diffed against
    // its first cap-sized window, never loaded whole.
    const read = readRegularFile(full)
    const old = read.ok ? read.content : ""
    return { ok: true, plan: { path: full, newContent: content, existed: true, diff: compactDiff(diffLinesText(old, content)) } }
  }
  return { ok: true, plan: { path: full, newContent: content, existed: false, diff: compactDiff(diffLinesText("", content), 40) } }
}

/** Write the approved plan to disk. Returns a model-facing result string. */
export function applyFilePlan(plan: FilePlan): string {
  writeFileSync(plan.path, plan.newContent, "utf8")
  const bytes = Buffer.byteLength(plan.newContent, "utf8")
  return plan.existed
    ? `wrote ${plan.path} (${bytes} bytes, overwritten)`
    : `created ${plan.path} (${bytes} bytes)`
}
