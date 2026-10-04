/**
 * Chat session persistence (docs/architecture.md "session/", docs/config.md):
 * one JSONL file per chat session under
 *   <dataDir>/sessions/<instance-id>/<tab-n>.jsonl
 * where dataDir = ~/.local/share/sensus (SENSUS_HOME redirects for tests).
 *
 * Events appended: session_start, user_message, assistant_message,
 * slash_command. Writes are synchronous + guarded so a failing disk never
 * crashes the TUI. --resume lists recent files and re-opens one for appends.
 *
 * Assistant events carry the model's reasoning ("thinking") text when the
 * model streamed any — resumed transcripts re-render the collapsed block.
 *
 * /clear starts a fresh JSONL generation for a tab while keeping the old file:
 *   tab-<k>.jsonl, then tab-<k>-2.jsonl, etc.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { fnv1a } from "../core/util.ts"
import { parseImageAttachments, type ImageAttachment } from "../core/image.ts"
import { deriveTitle, readSessionMeta, sessionMetaPath } from "./meta.ts"
import type { UsageInfo } from "../agent/provider/provider.ts"

export type { UsageInfo }

/** Transcripts hold command output; the file is owner-only and its dir owner-only. */
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

export type SessionEvent =
  | { ts: number; type: "session_start"; sensus: string; endpoint: string; model: string }
  | { ts: number; type: "user_message"; content: string; /** Image attachments (docs/agent.md "Images"); omitted when none. */ images?: ImageAttachment[] }
  | {
      ts: number
      type: "assistant_message"
      content: string
      /** Model reasoning ("thinking") text, when the model streamed any. */
      thinking?: string
      model: string
      usage: UsageInfo | null
      aborted: boolean
    }
  | { ts: number; type: "slash_command"; command: string }
  /** M3 tool-call card event (docs/agent.md: persist tool events). */
  | {
      ts: number
      type: "tool_call"
      callId: string
      name: string
      paramsSummary: string
      status: string
      output: string | null
      exitCode: number | null
      /**
       * Raw JSON arguments the model streamed (docs/agent.md "Tool loop") — kept
       * so `--resume` can rebuild the assistant `tool_calls` message verbatim.
       * Omitted on old transcripts.
       */
      arguments?: string
      /**
       * The boundary-capped result the model saw (docs/agent.md "Context
       * management & compaction"), persisted alongside the short preview so
       * `--resume` replays the tool message instead of dropping the
       * investigation context. Only written on the final event for a call, and
       * omitted on old transcripts.
       */
      result?: string
    }
  /** Context compaction checkpoint (docs/agent.md): durable so --resume
   * rebuilds the provider history from the LAST checkpoint instead of
   * re-inflating every old message. */
  | { ts: number; type: "compaction"; checkpoint: string; model: string }
  /** Chat rewind marker (docs/ui.md "Rewind"): the user reverted to a message,
   * so the logical transcript is truncated to the first `keep` user+assistant
   * records. The file stays append-only — every revert event truncates the
   * logical list as it is read, and later records append after it. */
  | { ts: number; type: "revert"; keep: number }

export interface ChatRecord {
  role: "user" | "assistant"
  content: string
  /**
   * Event timestamp (ms since epoch) captured when the record was written.
   * Used by the usage dashboard to bucket a turn by the day it actually
   * happened (a session can span several days). Omitted for legacy records
   * whose event carried no numeric `ts`.
   */
  ts?: number
  model?: string
  usage?: UsageInfo | null
  aborted?: boolean
  /** Model reasoning ("thinking") streamed before the answer (display-only). */
  thinking?: string
  /** Image attachments on a user message (docs/agent.md "Images"). */
  images?: ImageAttachment[]
}

/** A persisted tool-call event reduced to what the Context inspector shows:
 * the tool name and its (already summarized) parameter line. When the event
 * carried the raw arguments + boundary-capped result, those ride along too so
 * `--resume` can replay the tool turn into the provider history. */
export interface LoadedToolCall {
  /** Index of the chat record this call followed (-1 = before any record). */
  afterMessage: number
  name: string
  paramsSummary: string
  /** The tool call id (undefined on old transcripts). */
  callId?: string
  /** Raw JSON arguments the model streamed (undefined on old transcripts). */
  arguments?: string
  /** The boundary-capped result the model saw (undefined on old transcripts). */
  result?: string
}

export interface LoadedSession {
  path: string
  /** user + assistant messages in file order (system markers skipped). */
  messages: ChatRecord[]
  /**
   * Persisted `tool_call` events in file order, each tied to the index of the
   * chat record it followed (`afterMessage`, -1 before any). Inspector-only
   * metadata — v1 resume does not replay tool calls (docs/agent.md
   * "Context inspector").
   */
  toolCalls: LoadedToolCall[]
  firstUser: string | null
  /**
   * Display title: the sidecar's `title` when set, else the derived first user
   * message (`deriveTitle`, docs/sessions.md). Never empty (falls back to
   * `(empty session)`).
   */
  title: string
  /** Sidecar tags (normalized); `[]` when none (docs/sessions.md). */
  tags: string[]
  lastTs: number | null
  /** Number of events read (incl. skipped). */
  eventCount: number
  warnings: string[]
  /** Latest compaction checkpoint text (null when the file has none). */
  checkpoint: string | null
  /** Number of chat records recorded BEFORE that checkpoint event — the
   * provider history resumes from `messages.slice(checkpointIndex)`. */
  checkpointIndex: number
  /** Count of compaction events in the file (survives reverts). */
  compactions: number
}

/** Short, sortable, collision-resistant-enough instance id: base36 ts + pid
 * hash (stable for a whole sensus run — docs/architecture.md). */
export function makeInstanceId(now: number, pid: number): string {
  const ts = now.toString(36)
  let h = fnv1a(`${now}:${pid}`)
  // Fold pid in again through a large odd multiplier so sibling processes
  // started in the same millisecond still diverge.
  h = (h ^ Math.imul(pid, 0x9e3779b1)) >>> 0
  return `${ts}-${h.toString(36).padStart(8, "0").slice(0, 6)}`
}

export function sessionsRoot(dataDir: string): string {
  return join(dataDir, "sessions")
}

/**
 * Path for a tab's nth session generation. tabIndex is 1-based; generation 0
 * is the tab's first file (tab-1.jsonl), 1 -> tab-1-2.jsonl, etc.
 */
export function sessionFilePath(dataDir: string, instanceId: string, tabIndex: number, generation = 0): string {
  const base = generation === 0 ? `tab-${tabIndex}` : `tab-${tabIndex}-${generation + 1}`
  return join(sessionsRoot(dataDir), instanceId, `${base}.jsonl`)
}

/**
 * Writes events to a JSONL file. Appends are synchronous (ordered + flushed
 * per event) and never throw — failures surface as a count for the caller.
 *
 * A fresh session is LAZY: nothing touches the disk until the first event with
 * real content arrives, so a tab the user never sent a message in leaves no
 * transcript (and no "(empty session)" row in search/resume). `slash_command`
 * events are the exception — `/help`, `/model`, `/yolo`, … are local UI actions,
 * not conversation, so they are buffered and flushed ahead of the first content
 * event instead of materializing a session on their own. `reopen` targets an
 * existing file and writes immediately (resume).
 */
export class SessionFile {
  private readonly path: string
  /** Header for a fresh session; null when reopening an existing file. */
  private readonly header: { endpoint: string; model: string } | null
  /** False until the first content event materializes the transcript. */
  private started: boolean
  private failure = 0
  /** Leading slash commands held back until the session has real content. */
  private pending: SessionEvent[] = []
  /** True once the transcript's mode has been secured (0600 file, 0700 dir). */
  private secured = false

  private constructor(path: string, header: { endpoint: string; model: string } | null) {
    this.path = path
    this.header = header
    this.started = header === null // reopen: the file already exists
  }

  /** Open a fresh session; the file is created on the first content event. */
  static create(path: string, header: { endpoint: string; model: string }): SessionFile {
    return new SessionFile(path, header)
  }

  /** Re-open an existing file for appending (resume). */
  static reopen(path: string): SessionFile {
    return new SessionFile(path, null)
  }

  /** True when the underlying file could not be written so far. */
  get hasErrors(): boolean {
    return this.failure > 0
  }

  append(event: SessionEvent): void {
    if (!this.started) {
      // A lone slash command is not a session; hold it until content arrives.
      if (event.type === "slash_command") {
        this.pending.push(event)
        return
      }
      this.started = true
      const events: SessionEvent[] = this.header === null ? [] : [this.headerEvent(this.header)]
      events.push(...this.pending, event)
      this.pending = []
      this.write(events)
      return
    }
    this.write([event])
  }

  private headerEvent(header: { endpoint: string; model: string }): SessionEvent {
    return {
      ts: Date.now(),
      type: "session_start",
      sensus: "sensus",
      endpoint: header.endpoint,
      model: header.model,
    }
  }

  /** Append a batch as one write; retry once after an mkdir for a fresh dir. */
  private write(events: readonly SessionEvent[]): void {
    const data = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
    try {
      appendFileSync(this.path, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      this.secure()
      return
    } catch {
      // Retry once: the directory may not exist yet on the very first event.
      if (this.failure === 0) {
        try {
          mkdirSync(join(this.path, ".."), { recursive: true, mode: PRIVATE_DIR_MODE })
          appendFileSync(this.path, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
          this.secure()
          return
        } catch {
          // fall through to the counter
        }
      }
      this.failure++
    }
  }

  /**
   * Owner-only the transcript + its directory (docs/architecture.md "session/").
   * Files hold command output; dirs hold the whole session tree. The `mode` on
   * append/mkdir only applies to NEW entries, so an existing file/dir is
   * best-effort chmod'ed once on the first write. Never throws.
   */
  private secure(): void {
    if (this.secured) return
    this.secured = true
    try {
      chmodSync(this.path, PRIVATE_FILE_MODE)
    } catch {
      // best-effort: an unchangeable mode must not break persistence
    }
    try {
      chmodSync(join(this.path, ".."), PRIVATE_DIR_MODE)
    } catch {
      // best-effort
    }
  }

  get filePath(): string {
    return this.path
  }
}

/**
 * Permanently remove a saved transcript, plus its metadata sidecar
 * (docs/sessions.md). Used by the `/sessions` overlay's delete action; the
 * caller must not delete a session that a tab is still appending to. Never
 * throws: returns true when the JSONL is gone (an already-absent file counts),
 * false when it could not be removed (e.g. permissions). Sidecar cleanup is
 * best-effort — a stale sidecar is harmless once its transcript is gone.
 */
export function deleteSessionFile(path: string): boolean {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false
  }
  try {
    unlinkSync(sessionMetaPath(path))
  } catch {
    // no sidecar / already gone — the JSONL is the source of truth
  }
  return true
}

/** Load a session file: skip corrupt lines with a warning, ignore unknown
 * event types (forward compat). Never throws. */
export function loadSessionFile(path: string): LoadedSession {
  const out: LoadedSession = {
    path,
    messages: [],
    toolCalls: [],
    firstUser: null,
    title: "(empty session)",
    tags: [],
    lastTs: null,
    eventCount: 0,
    warnings: [],
    checkpoint: null,
    checkpointIndex: 0,
    compactions: 0,
  }
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    out.warnings.push(`session: could not read ${path}`)
    return out
  }
  let corrupt = 0
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "") continue
    out.eventCount++
    let ev: unknown
    try {
      ev = JSON.parse(rawLine)
    } catch {
      corrupt++
      continue
    }
    if (ev === null || typeof ev !== "object") {
      corrupt++
      continue
    }
    const e = ev as Record<string, unknown>
    const ts = typeof e["ts"] === "number" ? e["ts"] : null
    if (ts !== null && (out.lastTs === null || ts > out.lastTs)) out.lastTs = ts
    if (e["type"] === "user_message" && typeof e["content"] === "string") {
      const images = parseImageAttachments(e["images"])
      out.messages.push({
        role: "user",
        content: e["content"],
        ...(ts !== null ? { ts } : {}),
        ...(images.length > 0 ? { images } : {}),
      })
    } else if (e["type"] === "assistant_message" && typeof e["content"] === "string") {
      out.messages.push({
        role: "assistant",
        content: e["content"],
        ...(ts !== null ? { ts } : {}),
        model: typeof e["model"] === "string" ? e["model"] : undefined,
        usage: typeof e["usage"] === "object" && e["usage"] !== null ? (e["usage"] as UsageInfo) : undefined,
        aborted: typeof e["aborted"] === "boolean" ? e["aborted"] : undefined,
        thinking: typeof e["thinking"] === "string" && e["thinking"].length > 0 ? e["thinking"] : undefined,
      })
    }
    // Tool calls are kept for the Context inspector, and — when the event
    // carried the raw arguments + boundary-capped result — for replay into the
    // provider history on `--resume`. Keyed to the record they followed.
    if (e["type"] === "tool_call" && typeof e["name"] === "string") {
      const callId = typeof e["callId"] === "string" ? e["callId"] : undefined
      const args = typeof e["arguments"] === "string" ? e["arguments"] : undefined
      const result = typeof e["result"] === "string" ? e["result"] : undefined
      out.toolCalls.push({
        afterMessage: out.messages.length - 1,
        name: e["name"],
        paramsSummary: typeof e["paramsSummary"] === "string" ? e["paramsSummary"] : "",
        ...(callId !== undefined ? { callId } : {}),
        ...(args !== undefined ? { arguments: args } : {}),
        ...(result !== undefined ? { result } : {}),
      })
    }
    // slash_command / session_start / future types: counted, not displayed
    // (tool cards are transient UI state in v1 resumes).
    if (e["type"] === "compaction" && typeof e["checkpoint"] === "string") {
      out.checkpoint = e["checkpoint"]
      out.checkpointIndex = out.messages.length
      out.compactions += 1
    }
    // Rewind marker: truncate the LOGICAL transcript to `keep` records. Events
    // are processed in file order, so a revert only discards records read
    // before it; records appended after it extend the truncated list (the
    // discarded bytes stay on disk but are never seen again).
    if (e["type"] === "revert" && typeof e["keep"] === "number" && Number.isFinite(e["keep"])) {
      const keep = Math.max(0, Math.floor(e["keep"]))
      if (keep < out.messages.length) {
        out.messages.length = keep
        out.toolCalls = out.toolCalls.filter((c) => c.afterMessage < keep)
      }
      // A checkpoint whose summarized records were (partly) discarded is no
      // longer valid; a checkpoint fully inside the kept prefix stays.
      if (out.checkpoint !== null && out.checkpointIndex > out.messages.length) {
        out.checkpoint = null
        out.checkpointIndex = 0
      }
    }
  }
  if (corrupt > 0) out.warnings.push(`session: skipped ${corrupt} corrupt line(s) in ${path}`)
  // The first user message may have been discarded by a revert — recompute it
  // from the surviving records rather than the first one seen on disk.
  const firstUser = out.messages.find((m) => m.role === "user")
  out.firstUser = firstUser !== undefined ? firstUser.content : null
  // Phase 3.3 metadata sidecar (docs/sessions.md): a missing/corrupt sidecar
  // degrades to the derived title, never blocks or throws.
  const meta = readSessionMeta(path)
  out.title = meta.title ?? deriveTitle(out)
  out.tags = meta.tags ?? []
  return out
}

interface Candidate {
  path: string
  lastTs: number | null
  mtime: number
  /** Parsed transcript, cached so listing never re-reads the same file. */
  loaded: LoadedSession
}

/**
 * Walk <dataDir>/sessions/<instance>/*.jsonl, parse each once and return the
 * candidates newest-first. Transcripts with no user/assistant records (empty
 * tabs from older versions) are skipped, so every OPEN/RESUME caller sees only
 * real sessions. This is the parse-heavy walk (used by `listRecentSessions` +
 * `listAllSessions`); the throttled search/list path uses the stat-only
 * `listSessionFiles` and lets the index re-ingest by mtime.
 */
function sessionCandidates(dataDir: string): Candidate[] {
  const root = sessionsRoot(dataDir)
  const cands: Candidate[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return [] // no sessions yet
  }
  for (const dir of dirs) {
    const full = join(root, dir)
    let files: string[] = []
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(full, f)
      try {
        const mtime = statSync(p).mtimeMs
        const loaded = loadSessionFile(p)
        // A transcript with no chat records is not a session: a fresh tab never
        // creates one (SessionFile is lazy), and stale empty files from older
        // versions must not surface in listings / the search index either.
        if (loaded.messages.length === 0) continue
        cands.push({ path: p, lastTs: loaded.lastTs, mtime, loaded })
      } catch {
        // unreadable file — skip
      }
    }
  }
  cands.sort((a, b) => {
    const at = a.lastTs ?? a.mtime
    const bt = b.lastTs ?? b.mtime
    if (bt !== at) return bt - at
    // Same logical time: newest file first, then path for determinism.
    if (b.mtime !== a.mtime) return b.mtime - a.mtime
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  return cands
}

/**
 * Walk <dataDir>/sessions/<instance>/*.jsonl and list every transcript path,
 * newest-first by mtime. STAT-ONLY on purpose (docs/agent.md "Session
 * search"): the session index's `refresh` decides what to (re)parse from the
 * file mtime it records, so a throttled search/list must not read+parse every
 * transcript first. Zero-message files are included here and hidden at the
 * index/query layer (`sessions.messages > 0`); full parsing stays on the
 * open/resume path (`listRecentSessions`, `listAllSessions`, `loadSessionFile`).
 */
export function listSessionFiles(dataDir: string): string[] {
  const root = sessionsRoot(dataDir)
  const found: Array<{ path: string; mtime: number }> = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return [] // no sessions yet
  }
  for (const dir of dirs) {
    const full = join(root, dir)
    let files: string[] = []
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(full, f)
      try {
        found.push({ path: p, mtime: statSync(p).mtimeMs })
      } catch {
        // unreadable/vanished file — skip (same as the parse-based walk)
      }
    }
  }
  found.sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return found.map((c) => c.path)
}

/**
 * Load the newest `limit` sessions (most recent first) for --resume. Sessions
 * with no chat records are already filtered out by `sessionCandidates`.
 */
export function listRecentSessions(dataDir: string, limit = 20): LoadedSession[] {
  return sessionCandidates(dataDir)
    .slice(0, limit)
    .map((c) => c.loaded)
    .filter((s) => s.messages.length > 0)
}

/**
 * Load every session transcript (all history), newest-first. The usage
 * dashboard reads this so its daily roll-up is not truncated by a recency
 * cap; a single parse pass feeds the whole report. Sessions with no chat
 * records are already filtered out by `sessionCandidates`.
 */
export function listAllSessions(dataDir: string): LoadedSession[] {
  return sessionCandidates(dataDir)
    .map((c) => c.loaded)
    .filter((s) => s.messages.length > 0)
}
