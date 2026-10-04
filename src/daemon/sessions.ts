/**
 * Sessions resource — pure read-only service (docs/daemon-api.md). The daemon
 * lists, reads and exports persisted transcripts; it **never mutates one**. The
 * only writer (`SessionFile`, `deleteSessionFile`, `writeSessionMeta`/
 * `renameSession`/`tagSession`) is deliberately not imported here, so this
 * module cannot touch a transcript even if a future route is careless.
 *
 * Why the store, not the FTS index: `src/session/indexDb.ts` opens a shared
 * SQLite cache that a running TUI already owns, so the daemon reads the JSONL
 * files directly. The trade-off is explicit — `listSessions` parses each file
 * (to derive a title, count messages and skip header-only files) rather than
 * using the stat-only index. That is acceptable for a local, single-user
 * daemon; reads are synchronous + bounded by the page size.
 *
 * A session id is `<instance-id>/<base>` (e.g. `m3abc-1a2b3c/tab-2`), which is
 * why the HTTP routes carry two path params (`:instance/:base`). The file lives
 * at `<dataDir>/sessions/<instance-id>/<base>.jsonl`.
 *
 * Everything here is non-throwing: a missing/corrupt/unreadable file degrades
 * to `null`/an empty page.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { loadSessionFile, sessionsRoot, sessionToMarkdown, type ChatRecord } from "../engine/index.ts"

/** Default/max page size for `GET /v1/sessions`. */
export const DEFAULT_SESSION_LIMIT = 20
export const MAX_SESSION_LIMIT = 100
/** Default/max page size for the message window in `GET /v1/sessions/:instance/:base`. */
export const DEFAULT_SESSION_MESSAGES = 20
export const MAX_SESSION_MESSAGES = 50

/** Export formats the daemon supports. */
export const SESSION_EXPORT_FORMATS = ["md", "jsonl"] as const
export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number]

/** One row in the session list. `tab` is parsed from `<base>` (never stored). */
export interface SessionSummary {
  /** `<instance-id>/<base>` (docs/session/indexDb.ts `sessionIdFromPath`). */
  id: string
  /** Sidecar title, else the derived first user message. */
  title: string
  /** Tab number parsed from `<base>` (`tab-2`, `tab-2-3`); null if unrecognized. */
  tab: number | null
  /** File mtime (epoch ms), the fallback recency when `lastTs` is null. */
  mtime: number
  /** File size in bytes. */
  size: number
  tags: string[]
  /** Number of user/assistant records (never 0 — empty files are skipped). */
  messages: number
  /** Last event timestamp (epoch ms), or null. */
  lastTs: number | null
  /** Absolute path of the transcript file (client reads/deletes need it). */
  path: string
}

export interface SessionListPage {
  sessions: SessionSummary[]
  /** Offset for the next page, or null when the listing is exhausted. */
  nextOffset: number | null
}

export interface SessionReadPage {
  id: string
  title: string
  tags: string[]
  /** Total number of user/assistant records before paging. */
  total: number
  offset: number
  messages: ChatRecord[]
}

export interface SessionExport {
  content: string
  contentType: string
}

/** The `<base>` -> tab-number convention (`tab-<n>`, `tab-<n>-<generation>`). */
const TAB_BASE = /^tab-(\d+)(?:-(\d+))?$/

/** Parse a transcript base into its tab number; null when it is not a tab file. */
export function sessionTabFromBase(base: string): number | null {
  const m = TAB_BASE.exec(base)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** Clamp a list page size into `[1, MAX_SESSION_LIMIT]`; malformed -> default. */
export function clampSessionLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SESSION_LIMIT
  return Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Clamp a message window into `[1, MAX_SESSION_MESSAGES]`; malformed -> default. */
export function clampSessionMessages(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SESSION_MESSAGES
  return Math.min(MAX_SESSION_MESSAGES, Math.max(1, Math.floor(limit)))
}

/** Clamp an offset into `>= 0`; malformed -> 0. */
export function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

/**
 * A route segment (`instance` or `base`) must be a single path component:
 * non-empty, not `.`/`..`, not absolute, and free of any separator or NUL.
 * Rejecting these makes the subsequent `resolve` incapable of escaping the
 * sessions root.
 */
export function isSafeSessionSegment(segment: unknown): segment is string {
  if (typeof segment !== "string") return false
  if (segment.length === 0) return false
  if (segment === "." || segment === "..") return false
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return false
  if (isAbsolute(segment)) return false
  return true
}

/** True when `target` resolves to a path strictly inside `root`. */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), target)
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Resolve `<dataDir>/sessions/<instance>/<base>.jsonl`, guarding against path
 * traversal. Returns null on an unsafe segment, a path outside the sessions
 * root, or a target that does not exist (or is not a regular file).
 */
export function resolveSessionPath(dataDir: string, instance: string, base: string): string | null {
  if (!isSafeSessionSegment(instance) || !isSafeSessionSegment(base)) return null
  const root = sessionsRoot(dataDir)
  const target = resolve(root, instance, `${base}.jsonl`)
  if (!isInside(root, target)) return null
  try {
    if (!statSync(target).isFile()) return null
  } catch {
    return null
  }
  return target
}

/** Newest-first: by logical `lastTs`, then mtime, then path (deterministic). */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  const at = a.lastTs ?? a.mtime
  const bt = b.lastTs ?? b.mtime
  if (bt !== at) return bt - at
  if (b.mtime !== a.mtime) return b.mtime - a.mtime
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * List persisted, non-empty sessions newest-first, paged. A transcript with no
 * user/assistant records is not a session (matching `listRecentSessions`) and is
 * skipped. Never throws.
 */
export function listSessions(dataDir: string, opts: { limit?: number; offset?: number } = {}): SessionListPage {
  const limit = clampSessionLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const root = sessionsRoot(dataDir)
  const summaries: SessionSummary[] = []

  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return { sessions: [], nextOffset: null } // no sessions yet
  }

  for (const dir of dirs) {
    const full = join(root, dir)
    let files: string[] = []
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const file of files) {
      const base = file.slice(0, -".jsonl".length)
      const path = join(full, file)
      try {
        const st = statSync(path)
        const loaded = loadSessionFile(path)
        if (loaded.messages.length === 0) continue
        summaries.push({
          id: `${dir}/${base}`,
          title: loaded.title,
          tab: sessionTabFromBase(base),
          mtime: st.mtimeMs,
          size: st.size,
          tags: loaded.tags,
          messages: loaded.messages.length,
          lastTs: loaded.lastTs,
          path,
        })
      } catch {
        // unreadable/vanished file — skip, never break the listing
      }
    }
  }

  summaries.sort(byRecency)
  const page = summaries.slice(offset, offset + limit)
  const nextOffset = offset + page.length < summaries.length ? offset + page.length : null
  return { sessions: page, nextOffset }
}

/**
 * Read one transcript as a page over its logical chat records (a `revert`
 * marker already truncated them at load time). Returns null when the session is
 * unknown or has no chat records. Never throws.
 */
export function readSession(
  dataDir: string,
  instance: string,
  base: string,
  opts: { offset?: number; limit?: number } = {},
): SessionReadPage | null {
  const path = resolveSessionPath(dataDir, instance, base)
  if (path === null) return null
  const loaded = loadSessionFile(path)
  if (loaded.messages.length === 0) return null
  const offset = clampOffset(opts.offset)
  const limit = clampSessionMessages(opts.limit)
  return {
    id: `${instance}/${base}`,
    title: loaded.title,
    tags: loaded.tags,
    total: loaded.messages.length,
    offset,
    messages: loaded.messages.slice(offset, offset + limit),
  }
}

/**
 * Export one transcript. `md` renders the merged, logical view; `jsonl` returns
 * the raw file bytes (faithful — it preserves `session_start` / `slash_command`
 * / `revert` / `compaction` events that `loadSessionFile` consumes). Returns
 * null when the session is unknown, or when the raw read fails. Never throws.
 */
export function exportSession(
  dataDir: string,
  instance: string,
  base: string,
  format: SessionExportFormat,
): SessionExport | null {
  const path = resolveSessionPath(dataDir, instance, base)
  if (path === null) return null
  if (format === "md") {
    return { content: sessionToMarkdown(loadSessionFile(path)), contentType: "text/markdown; charset=utf-8" }
  }
  try {
    return { content: readFileSync(path, "utf8"), contentType: "application/x-ndjson; charset=utf-8" }
  } catch {
    return null
  }
}
