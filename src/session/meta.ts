/**
 * Session metadata sidecar (Phase 3.3, docs/sessions.md): a small JSON file
 * next to each transcript JSONL holding the human title + tags:
 *
 *   <session>.jsonl.meta.json  ->  { title?, tags?, renamedAt? }
 *
 * Why a sidecar: transcripts are append-only (docs/architecture.md
 * "session/"). Renaming or tagging must never rewrite the JSONL, so metadata
 * lives beside it and is merged in at load time.
 *
 * Everything here is pure or best-effort: `readSessionMeta` returns `{}` on a
 * missing/corrupt file and `writeSessionMeta` never throws (atomic tmp+rename
 * through the shared `atomicWriteText` seam). A bad sidecar degrades to the
 * derived title, never a crash.
 */

import { readFileSync } from "node:fs"
import { atomicWriteText, isRecord, truncateWithEllipsis } from "../core/util.ts"
import type { LoadedSession } from "./store.ts"

/** Sidecar shape. All fields optional; unknown keys in the file are ignored. */
export interface SessionMeta {
  /** Human title. Overrides the derived (first user message) title. */
  title?: string
  /** Free-form tags (normalized: trimmed, non-empty, de-duplicated). */
  tags?: string[]
  /** Epoch ms of the last explicit rename. */
  renamedAt?: number
}

/** Titles are bounded for one-line rows (~60 chars, ellipsized). */
export const TITLE_MAX = 60

/** Word cap for model-generated titles (docs/sessions.md "Auto titles"). */
export const TITLE_MAX_WORDS = 10

/** `<jsonl>` -> `<jsonl>.meta.json`. */
export function sessionMetaPath(jsonlPath: string): string {
  return `${jsonlPath}.meta.json`
}

/** Trim, drop empties, de-duplicate (order-preserving) a tag list. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim()
    if (t.length === 0 || out.includes(t)) continue
    out.push(t)
  }
  return out
}

/**
 * Read a transcript's sidecar. Never throws: a missing, unreadable, non-JSON
 * or wrong-shaped file yields `{}` (the caller falls back to derived values).
 */
export function readSessionMeta(jsonlPath: string): SessionMeta {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sessionMetaPath(jsonlPath), "utf8"))
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const out: SessionMeta = {}
  if (typeof parsed["title"] === "string") {
    const title = parsed["title"].trim()
    if (title.length > 0) out.title = truncateWithEllipsis(title, TITLE_MAX)
  }
  if (Array.isArray(parsed["tags"])) {
    const tags = normalizeTags(parsed["tags"].filter((t): t is string => typeof t === "string"))
    if (tags.length > 0) out.tags = tags
  }
  if (typeof parsed["renamedAt"] === "number" && Number.isFinite(parsed["renamedAt"])) {
    out.renamedAt = parsed["renamedAt"]
  }
  return out
}

/**
 * Merge `patch` into a transcript's sidecar and write it atomically. A key set
 * to `undefined` is removed. Empty tags are serialized away (clearing them).
 * Returns the merged metadata; never throws.
 */
export function writeSessionMeta(jsonlPath: string, patch: SessionMeta): SessionMeta {
  const merged: SessionMeta = { ...readSessionMeta(jsonlPath) }
  // Delete every patch key first so an `undefined` explicitly clears it, then
  // copy only the defined values.
  for (const key of Object.keys(patch) as Array<keyof SessionMeta>) {
    if (patch[key] === undefined) delete merged[key]
    else (merged as Record<string, unknown>)[key] = patch[key]
  }
  const body: Record<string, unknown> = {}
  if (typeof merged.title === "string" && merged.title.length > 0) body["title"] = merged.title
  if (Array.isArray(merged.tags) && merged.tags.length > 0) body["tags"] = merged.tags
  if (typeof merged.renamedAt === "number") body["renamedAt"] = merged.renamedAt
  atomicWriteText(sessionMetaPath(jsonlPath), `${JSON.stringify(body)}\n`)
  return merged
}

/**
 * Default title from raw first-user-message text: whitespace-collapsed and
 * ellipsized to ~60 chars. `""` when there is no usable text. Pure
 * (docs/sessions.md). Also the tab-title placeholder while the model-generated
 * title is still being produced.
 */
export function deriveTitleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length === 0) return ""
  return truncateWithEllipsis(clean, TITLE_MAX)
}

/**
 * Default title for a session: its first user message, whitespace-collapsed
 * and ellipsized to ~60 chars. `(empty session)` when it has no user text.
 * Pure (docs/sessions.md).
 */
export function deriveTitle(session: LoadedSession): string {
  return deriveTitleFromText(session.firstUser ?? "") || "(empty session)"
}

/**
 * Normalize a model-generated title (docs/sessions.md "Auto titles"): collapse
 * whitespace, drop a leading `Title:`/`Session title:` label and wrapping
 * quotes/backticks/trailing punctuation, cap at `maxWords` words, then bound
 * to TITLE_MAX chars. Returns "" when nothing usable remains, so the caller
 * keeps the derived title. Pure — the provider call lives in agent/chat/title.ts.
 */
export function cleanSessionTitle(raw: string, maxWords = TITLE_MAX_WORDS): string {
  let s = raw.replace(/\s+/g, " ").trim()
  if (s.length === 0) return ""
  s = s.replace(/^(?:session\s+)?title\s*[:\-–—]\s*/i, "")
  s = s.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim()
  s = s.replace(/[.!?,;:]+$/, "").trim()
  if (s.length === 0) return ""
  const words = s.split(" ").filter((w) => w.length > 0)
  if (words.length === 0) return ""
  const cap = Math.max(1, Math.floor(maxWords))
  return truncateWithEllipsis(words.slice(0, cap).join(" "), TITLE_MAX)
}

/** Set (or clear, with an empty string) a session's title. Never throws. */
export function renameSession(jsonlPath: string, title: string): SessionMeta {
  const clean = title.replace(/\s+/g, " ").trim()
  if (clean.length === 0) return writeSessionMeta(jsonlPath, { title: undefined, renamedAt: Date.now() })
  return writeSessionMeta(jsonlPath, { title: truncateWithEllipsis(clean, TITLE_MAX), renamedAt: Date.now() })
}

/** Replace a session's tags (normalized; an empty list clears them). Never throws. */
export function tagSession(jsonlPath: string, tags: readonly string[]): SessionMeta {
  return writeSessionMeta(jsonlPath, { tags: normalizeTags(tags) })
}

/** ISO-ish local-ish timestamp used in export headers (stable, no T). */
function fmtStamp(ts: number | null): string {
  if (ts === null) return "unknown"
  try {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19)
  } catch {
    return "unknown"
  }
}

/**
 * Render a loaded session as Markdown: title heading, tags/timestamp facts,
 * then role-labelled messages. Message bodies are emitted verbatim, so fenced
 * code, lists and quotes survive. Pure (docs/sessions.md).
 */
export function sessionToMarkdown(session: LoadedSession): string {
  const title = session.title.length > 0 ? session.title : deriveTitle(session)
  const lines: string[] = [`# ${title}`, ""]
  const facts = [`last activity: ${fmtStamp(session.lastTs)}`]
  if (session.tags.length > 0) facts.push(`tags: ${session.tags.join(", ")}`)
  if (session.path.length > 0) facts.push(`session: ${session.path}`)
  lines.push(...facts.map((f) => `- ${f}`), "", "---", "")
  if (session.messages.length === 0) {
    lines.push("_(empty session)_", "")
    return lines.join("\n")
  }
  for (const m of session.messages) {
    if (m.role === "assistant") {
      const meta: string[] = []
      if (m.model !== undefined && m.model.length > 0) meta.push(`model: ${m.model}`)
      if (m.aborted === true) meta.push("aborted")
      lines.push(`## Assistant${meta.length > 0 ? ` (${meta.join(" · ")})` : ""}`)
    } else {
      lines.push("## User")
    }
    lines.push("", m.content, "")
  }
  return lines.join("\n")
}
