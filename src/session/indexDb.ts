/**
 * Session search index (Phase 1.6): a SQLite FTS5 index over past chat
 * transcripts, so the agent (`session_search`, `session_list`, `session_view`)
 * and the UI (`/sessions` overlay) can search and read every conversation.
 *
 * Design (docs/agent.md "Session search", docs/architecture.md "session/"):
 * - `bun:sqlite` + FTS5. Three tables: `sessions` (one row per JSONL file),
 *   `messages` (one row per user/assistant record) and the standalone
 *   `messages_fts` index whose `rowid` mirrors `messages.id`.
 * - Ingest reuses the EXISTING `loadSessionFile` parser (never a second JSONL
 *   reader), so unknown event types stay forward-compatible and corrupt lines
 *   are skipped exactly like `--resume`.
 * - `refresh` re-reads only files whose mtime changed since the last pass
 *   (in-memory map; the schema stays minimal), `force` re-reads all.
 * - `search` runs a parameterized FTS5 MATCH. User input is tokenized and
 *   re-emitted as quoted prefix terms (`"term"*`), which cannot throw on FTS
 *   syntax; when MATCH finds nothing it falls back to a parameterized LIKE
 *   substring scan so mid-word queries still work. Results are newest-first.
 * - Everything degrades: a corrupt DB, a bad file, or an FTS error returns
 *   `[]` — the class NEVER throws (the tool layer surfaces an error string).
 */

import { Database } from "bun:sqlite"
import { mkdirSync, statSync } from "node:fs"
import { basename, dirname } from "node:path"
import { loadSessionFile, type LoadedSession } from "./store.ts"
import { normalizeTags, sessionMetaPath } from "./meta.ts"

/** One matching message. */
export interface SessionSearchHit {
  path: string
  sessionId: string
  /** Human title (sidecar → derived first user message, docs/sessions.md). */
  title: string
  /** Sidecar tags; `[]` when none. */
  tags: string[]
  /** Session recency (the file's last event ts; null when it had none). */
  ts: number | null
  role: "user" | "assistant"
  /** Short window around the first match, whitespace-collapsed. */
  snippet: string
  /** 0-based index among the file's user/assistant records. */
  messageIndex: number
}

/** One indexed session (a JSONL transcript). */
export interface IndexedSession {
  path: string
  sessionId: string
  /** Human title (sidecar → derived first user message, docs/sessions.md). */
  title: string
  /** Sidecar tags; `[]` when none. */
  tags: string[]
  /** Number of user/assistant records indexed. */
  messages: number
  lastTs: number | null
  firstUser: string | null
}

/** One message in a `session_view` window. */
export interface SessionViewMessage {
  /** 0-based logical index among the transcript's user/assistant records. */
  index: number
  role: "user" | "assistant"
  ts: number | null
  content: string
}

/** One window of a single transcript (`session_view`). */
export interface SessionView {
  path: string
  sessionId: string
  /** Human title (sidecar → derived first user message, docs/sessions.md). */
  title: string
  /** Sidecar tags; `[]` when none. */
  tags: string[]
  /** Total user/assistant records in the (logical) transcript. */
  total: number
  /** The window's 0-based start (clamped >= 0). */
  offset: number
  /** Session recency (the file's last event ts; null when it had none). */
  lastTs: number | null
  /** Up to `limit` messages, ascending by `index`. */
  messages: SessionViewMessage[]
}

/** The structural surface the tool + UI depend on (tests stub it). `offset`
 * pages through the full result set (the UI's infinite scroll); omitted = 0. */
export interface SessionSearchBridge {
  search(query: string, limit?: number, session?: string, offset?: number): SessionSearchHit[]
  list(limit?: number, offset?: number): IndexedSession[]
  /**
   * Read one transcript's messages by window (`session_view`): resolve the
   * session whose id/path matches `session` (an EXACT id or path wins; else the
   * newest substring match), then return `limit` messages from `offset`
   * (0-based), ascending. Null when nothing matches or the index is unusable.
   * Never throws. Optional so read-only stubs (the `session_search` tool tests)
   * need not implement it.
   */
  readSession?(session: string, offset?: number, limit?: number): SessionView | null
  /**
   * Forget one indexed transcript — the `/sessions` overlay's delete action
   * (the FILE removal is the caller's job; this only drops the rows + mtime so
   * a later refresh cannot resurrect them). Optional so read-only stubs (the
   * `session_search` tool tests) need not implement it. Never throws; returns
   * true when the index accepted the removal.
   */
  remove?(path: string): boolean
}

export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 100
/** `session_view` page size (max messages per call; the tool keeps a window
 * small so a huge transcript is read in slices, never loaded whole). */
export const DEFAULT_SESSION_VIEW_LIMIT = 20
export const MAX_SESSION_VIEW_LIMIT = 50
/** Snippet window (chars) around the first match. */
export const SNIPPET_WIDTH = 160
/** Most query terms fed to FTS5 (bounds the expression). */
const MAX_TERMS = 12

const clampLimit = (n: number | undefined): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SEARCH_LIMIT
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(n)))
}

/** Non-negative integer offset for paging (anything malformed -> 0). */
const clampOffset = (n: number | undefined): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0
  return Math.max(0, Math.floor(n))
}

/** `session_view` page size (default 20, capped at 50). */
const clampViewLimit = (n: number | undefined): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SESSION_VIEW_LIMIT
  return Math.min(MAX_SESSION_VIEW_LIMIT, Math.max(1, Math.floor(n)))
}

/** Decode a stored tags JSON string; anything malformed degrades to `[]`. */
function decodeTags(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return normalizeTags(arr.filter((t): t is string => typeof t === "string"))
  } catch {
    return []
  }
}

/** The sidecar mtime (0 when absent) — a rename/tag change re-ingests too. */
function metaMtime(jsonlPath: string): number {
  try {
    return statSync(sessionMetaPath(jsonlPath)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression: lowercase
 * word tokens, each quoted and prefix-starred (`"cfg"*`). Quoting makes FTS
 * operators (`AND`, `NEAR`, `col:`, `*`, quotes) ordinary text and the token
 * regex drops everything else, so this can never raise an FTS syntax error.
 * Returns null when there is nothing searchable (empty/whitespace/punctuation).
 */
export function ftsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  const uniq: string[] = []
  for (const t of tokens) {
    if (uniq.includes(t)) continue
    uniq.push(t)
    if (uniq.length >= MAX_TERMS) break
  }
  if (uniq.length === 0) return null
  return uniq.map((t) => `"${t}"*`).join(" ")
}

/**
 * A stable per-transcript id: `<instance-dir>/<file-base>` (e.g.
 * `m3abc-1a2b3c/tab-2`). Unique across instances, filterable by either half.
 */
export function sessionIdFromPath(path: string): string {
  const base = basename(path).replace(/\.jsonl$/, "")
  const dir = basename(dirname(path))
  return dir.length > 0 ? `${dir}/${base}` : base
}

/**
 * A short window around the first match, whitespace-collapsed, with ellipses
 * when clipped. Pure + deterministic (unit-tested): the UI and the tool show
 * the same snippet. No match falls back to the head of the message.
 */
export function makeSnippet(content: string, query: string, width = SNIPPET_WIDTH): string {
  const text = content.replace(/\s+/g, " ").trim()
  if (text.length === 0) return ""
  const q = query.trim().toLowerCase()
  const lower = text.toLowerCase()
  let at = q.length > 0 ? lower.indexOf(q) : -1
  if (at < 0) {
    // Prefix/substring fallbacks: the first whole token occurrence.
    for (const tok of q.match(/[\p{L}\p{N}_]+/gu) ?? []) {
      const i = lower.indexOf(tok)
      if (i >= 0 && (at < 0 || i < at)) at = i
    }
  }
  if (at < 0) at = 0
  const before = Math.floor(width / 3)
  const start = Math.max(0, at - before)
  const end = Math.min(text.length, start + width)
  let out = text.slice(start, end)
  if (start > 0) out = `…${out}`
  if (end < text.length) out = `${out}…`
  return out
}

interface HitRow {
  path: string
  session_id: string
  title: string | null
  tags: string | null
  message_index: number
  ts: number | null
  role: string
  content: string
}

interface SessionRow {
  path: string
  session_id: string
  title: string | null
  tags: string | null
  messages: number
  last_ts: number | null
  first_user: string | null
}

interface MessageRow {
  message_index: number
  ts: number | null
  role: string
  content: string
}

export class SessionIndex implements SessionSearchBridge {
  private readonly dbPath: string
  private db: Database | null = null
  private ready = false
  private failed = false
  /** Last ingested mtime per path (change detection between passes). */
  private readonly mtimes = new Map<string, number>()

  constructor(opts: { dbPath: string }) {
    this.dbPath = opts.dbPath
  }

  /** Open + migrate the DB. Idempotent, never throws (a failure latches). */
  ensure(): void {
    if (this.ready || this.failed) return
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true })
      const db = new Database(this.dbPath)
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run(
        `CREATE TABLE IF NOT EXISTS sessions (
           path TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           messages INTEGER NOT NULL DEFAULT 0,
           last_ts INTEGER,
           first_user TEXT,
           title TEXT,
           tags TEXT
         )`,
      )
      // Migrate pre-existing databases (sessions created before titles/tags).
      const cols = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
      const names = new Set(cols.map((c) => c.name))
      if (!names.has("title")) db.run("ALTER TABLE sessions ADD COLUMN title TEXT")
      if (!names.has("tags")) db.run("ALTER TABLE sessions ADD COLUMN tags TEXT")
      db.run(
        `CREATE TABLE IF NOT EXISTS messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           path TEXT NOT NULL,
           message_index INTEGER NOT NULL,
           ts INTEGER,
           role TEXT NOT NULL,
           content TEXT NOT NULL
         )`,
      )
      db.run("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content)")
      db.run("CREATE INDEX IF NOT EXISTS messages_path ON messages(path)")
      this.db = db
      this.ready = true
    } catch {
      this.failed = true
      this.db = null
    }
  }

  /**
   * Re-ingest files whose mtime changed since the last pass (`force` = every
   * file). Best-effort: one unreadable/corrupt file is skipped, never aborting
   * the pass. Never throws.
   */
  refresh(files: readonly string[], force = false): void {
    this.ensure()
    const db = this.db
    if (db === null) return
    for (const path of files) {
      try {
        let mtime: number
        try {
          // A rename/tag writes the sidecar without touching the JSONL, so a
          // metadata change must also trigger re-ingest (docs/sessions.md).
          mtime = Math.max(statSync(path).mtimeMs, metaMtime(path))
        } catch {
          continue // vanished/unreadable file
        }
        if (!force && this.mtimes.get(path) === mtime) continue
        const loaded = loadSessionFile(path)
        this.ingestOne(db, path, loaded)
        this.mtimes.set(path, mtime)
      } catch {
        // A single file must not poison the whole pass.
      }
    }
  }

  private ingestOne(db: Database, path: string, loaded: LoadedSession): void {
    const tx = db.transaction(() => {
      db.run("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE path = ?)", [path])
      db.run("DELETE FROM messages WHERE path = ?", [path])
      db.run("DELETE FROM sessions WHERE path = ?", [path])
      db.run("INSERT INTO sessions(path, session_id, messages, last_ts, first_user, title, tags) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        path,
        sessionIdFromPath(path),
        loaded.messages.length,
        loaded.lastTs,
        loaded.firstUser,
        loaded.title,
        JSON.stringify(loaded.tags),
      ])
      const insMsg = db.query("INSERT INTO messages(path, message_index, ts, role, content) VALUES (?, ?, ?, ?, ?)")
      const insFts = db.query("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)")
      loaded.messages.forEach((m, i) => {
        // Per-message ts (the event's own timestamp), falling back to the
        // file's last ts only for legacy records that carried none — so
        // `session_view` reports when each message actually happened.
        const msgTs = typeof m.ts === "number" ? m.ts : loaded.lastTs
        const info = insMsg.run(path, i, msgTs, m.role, m.content)
        insFts.run(info.lastInsertRowid, m.content)
      })
    })
    tx()
  }

  /**
   * Search indexed messages. FTS5 MATCH first; a parameterized LIKE substring
   * fallback when MATCH finds nothing. Newest sessions first, capped
   * (default 20, max 100) and paged by `offset`. Empty query or an unusable
   * DB returns [].
   */
  search(query: string, limit?: number, session?: string, offset?: number): SessionSearchHit[] {
    this.ensure()
    const db = this.db
    if (db === null) return []
    const q = query.trim()
    if (q.length === 0) return []
    const lim = clampLimit(limit)
    const off = clampOffset(offset)
    const scope = session !== undefined && session.trim().length > 0 ? `%${session.trim()}%` : null
    try {
      let rows: HitRow[] = []
      const fq = ftsQuery(q)
      if (fq !== null) rows = this.matchFts(db, fq, lim, off, scope)
      if (rows.length === 0) rows = this.matchLike(db, q, lim, off, scope)
      return rows.map((r) => ({
        path: r.path,
        sessionId: r.session_id,
        title: typeof r.title === "string" && r.title.length > 0 ? r.title : "(empty session)",
        tags: decodeTags(r.tags),
        ts: r.ts,
        role: r.role === "assistant" ? "assistant" : "user",
        snippet: makeSnippet(r.content, q),
        messageIndex: r.message_index,
      }))
    } catch {
      return []
    }
  }

  private matchFts(db: Database, fq: string, limit: number, offset: number, scope: string | null): HitRow[] {
    const cols = `m.path, s.session_id, s.title, s.tags, m.message_index, m.ts, m.role, m.content`
    const from = `FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.path = m.path`
    const where = `WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant') AND s.messages > 0`
    const order = `ORDER BY COALESCE(s.last_ts, 0) DESC, m.path ASC, m.message_index ASC LIMIT ? OFFSET ?`
    if (scope === null) return db.query(`SELECT ${cols} ${from} ${where} ${order}`).all(fq, limit, offset) as HitRow[]
    return db
      .query(`SELECT ${cols} ${from} ${where} AND (s.session_id LIKE ? OR m.path LIKE ?) ${order}`)
      .all(fq, scope, scope, limit, offset) as HitRow[]
  }

  private matchLike(db: Database, query: string, limit: number, offset: number, scope: string | null): HitRow[] {
    const cols = `m.path, s.session_id, s.title, s.tags, m.message_index, m.ts, m.role, m.content`
    const from = `FROM messages m JOIN sessions s ON s.path = m.path`
    const where = `WHERE m.content LIKE ? AND m.role IN ('user', 'assistant') AND s.messages > 0`
    const order = `ORDER BY COALESCE(s.last_ts, 0) DESC, m.path ASC, m.message_index ASC LIMIT ? OFFSET ?`
    const needle = `%${query}%`
    if (scope === null) return db.query(`SELECT ${cols} ${from} ${where} ${order}`).all(needle, limit, offset) as HitRow[]
    return db
      .query(`SELECT ${cols} ${from} ${where} AND (s.session_id LIKE ? OR m.path LIKE ?) ${order}`)
      .all(needle, scope, scope, limit, offset) as HitRow[]
  }

  /** Indexed sessions, newest first (default 20, max 100), paged by `offset`. */
  list(limit?: number, offset?: number): IndexedSession[] {
    this.ensure()
    const db = this.db
    if (db === null) return []
    try {
      const rows = db
        .query(
          `SELECT path, session_id, messages, last_ts, first_user, title, tags FROM sessions
           WHERE messages > 0
           ORDER BY COALESCE(last_ts, 0) DESC, path ASC LIMIT ? OFFSET ?`,
        )
        .all(clampLimit(limit), clampOffset(offset)) as SessionRow[]
      return rows.map((r) => ({
        path: r.path,
        sessionId: r.session_id,
        title: typeof r.title === "string" && r.title.length > 0 ? r.title : "(empty session)",
        tags: decodeTags(r.tags),
        messages: r.messages,
        lastTs: r.last_ts,
        firstUser: r.first_user,
      }))
    } catch {
      return []
    }
  }

  /**
   * Read one transcript's messages by window (`session_view`): resolve the
   * session whose id/path matches `session` (an EXACT id or path wins; else the
   * newest substring match), then return `limit` messages from `offset`
   * (0-based), ascending by logical index. `total` is the transcript's full
   * record count, so the caller can tell there is more to page through — the
   * whole transcript is never loaded. Null when nothing matches, the query is
   * empty, or the index is unusable. Never throws.
   */
  readSession(session: string, offset?: number, limit?: number): SessionView | null {
    this.ensure()
    const db = this.db
    if (db === null) return null
    const scope = session.trim()
    if (scope.length === 0) return null
    const off = clampOffset(offset)
    const lim = clampViewLimit(limit)
    try {
      const needle = `%${scope}%`
      // Prefer an EXACT session-id match, then an exact path, and only then a
      // loose substring. This makes paging stable: the `sessionId` echoed in a
      // `session_view` header always resolves back to the SAME transcript, even
      // when another session's id merely CONTAINS it (e.g. `inst/tab-1` vs the
      // newer `inst/tab-1-2` generation file).
      const row = db
        .query(
          `SELECT path, session_id, messages, last_ts, first_user, title, tags FROM sessions
           WHERE (session_id LIKE ? OR path LIKE ?) AND messages > 0
           ORDER BY
             CASE WHEN session_id = ? THEN 0 WHEN path = ? THEN 1 ELSE 2 END,
             COALESCE(last_ts, 0) DESC, path ASC
           LIMIT 1`,
        )
        .get(needle, needle, scope, scope) as SessionRow | null
      if (row === null) return null
      const messages = db
        .query(
          `SELECT message_index, ts, role, content FROM messages
           WHERE path = ? ORDER BY message_index ASC LIMIT ? OFFSET ?`,
        )
        .all(row.path, lim, off) as MessageRow[]
      return {
        path: row.path,
        sessionId: row.session_id,
        title: typeof row.title === "string" && row.title.length > 0 ? row.title : "(empty session)",
        tags: decodeTags(row.tags),
        total: row.messages,
        offset: off,
        lastTs: row.last_ts,
        messages: messages.map((m) => ({
          index: m.message_index,
          role: m.role === "assistant" ? "assistant" : "user",
          ts: m.ts,
          content: m.content,
        })),
      }
    } catch {
      return null
    }
  }

  /**
   * Forget one indexed transcript (the `/sessions` overlay delete). Drops the
   * session row, its messages and their FTS entries, and the cached mtime so
   * the next refresh cannot re-ingest a stale copy. Never throws.
   */
  remove(path: string): boolean {
    this.ensure()
    const db = this.db
    if (db === null) return false
    try {
      const tx = db.transaction(() => {
        db.run("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE path = ?)", [path])
        db.run("DELETE FROM messages WHERE path = ?", [path])
        db.run("DELETE FROM sessions WHERE path = ?", [path])
      })
      tx()
      this.mtimes.delete(path)
      return true
    } catch {
      return false
    }
  }

  /** Close the DB (idempotent, never throws). */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // already closed / mid-teardown
    }
    this.db = null
    this.ready = false
  }
}
