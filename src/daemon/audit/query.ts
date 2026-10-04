/**
 * Audit query/export primitives (docs/daemon-api.md): the pure, zero-I/O core
 * of the `GET /v1/audit` resource. It normalizes the two sources the daemon can
 * read — the legacy `src/agent/audit.ts` JSONL (`AuditEntry`) and the event
 * stream (`SensusEvent`) — into ONE record shape, then filters, sorts,
 * paginates and formats them.
 *
 * Everything here is pure (no fs, no clock): the reader owns I/O. The shapes are
 * deliberately stable so the event log can slot in behind `AuditSource` without
 * a route change. See `reader.ts` for the source seam.
 */

import type { AuditEntry, SensusEvent } from "../../engine/index.ts"
import { isRecord } from "../../core/util.ts"

/** Where a normalized record came from: the legacy JSONL or the event log. */
export type AuditSourceLabel = "legacy" | "events"

/**
 * One audit record, source-agnostic. Mirrors `AuditEntry`'s fields but widens
 * `tool` to `string | null` (memory-write / session-start events carry no tool)
 * and adds the `source` label plus an optional event `type` discriminator.
 */
export interface NormalizedAuditRecord {
  /** Epoch millis. */
  ts: number
  /**
   * Per-run **instance id** (`makeInstanceId`) — NOT a transcript/session-file
   * id. The legacy log additionally uses `session:"audit"` for undo tombstones.
   */
  session: string
  /** Coarse kind: `"file" | "memory" | "shell" | "session" | "other" | "undo"`. */
  kind: string
  /** Tool name; `null` for events that have none (memory-write, session-start). */
  tool: string | null
  /** One-line description. */
  summary: string
  ok: boolean
  /** File writes: absolute path. */
  path?: string
  /** File writes: prior content (null = the file did not exist). Omitted from CSV. */
  before?: string | null
  /** True once an undo has consumed this entry. */
  undone?: boolean
  /** On an undo tombstone: the ts of the entry it consumed. */
  refTs?: number
  source: AuditSourceLabel
  /** Event discriminator (`command-ran`, `memory-write`, …); events source only. */
  type?: string
}

/** Normalize a legacy `AuditEntry` (labels it `legacy`). Pure. */
export function normalizeAuditEntry(entry: AuditEntry): NormalizedAuditRecord {
  const record: NormalizedAuditRecord = {
    ts: entry.ts,
    session: entry.session,
    kind: entry.kind,
    tool: entry.tool,
    summary: entry.summary,
    ok: entry.ok,
    source: "legacy",
  }
  if (entry.path !== undefined) record.path = entry.path
  if (entry.before !== undefined) record.before = entry.before
  if (entry.undone !== undefined) record.undone = entry.undone
  if (entry.refTs !== undefined) record.refTs = entry.refTs
  return record
}

/** Format the `memory-write` char delta as a signed hint for the summary. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`
}

/**
 * Normalize a `SensusEvent` (labels it `events`). `command-*` → kind `"shell"`
 * + their tool; `memory-write` → kind `"memory"`, tool `null`; `session-start`
 * → kind `"session"`, tool `null`. Pure and total over the union.
 */
export function normalizeEvent(event: SensusEvent): NormalizedAuditRecord {
  const base = { ts: event.ts, session: event.session, source: "events" as const, type: event.type }
  switch (event.type) {
    case "command-approved":
      return { ...base, kind: "shell", tool: event.tool, summary: `approved ${event.tool} (${event.source})`, ok: true }
    case "command-denied":
      return {
        ...base,
        kind: "shell",
        tool: event.tool,
        summary: `denied ${event.tool} (${event.source})${event.reason !== undefined ? `: ${event.reason}` : ""}`,
        ok: false,
      }
    case "command-ran":
      return { ...base, kind: "shell", tool: event.tool, summary: event.command, ok: event.ok }
    case "memory-write":
      return {
        ...base,
        kind: "memory",
        tool: null,
        summary: `${event.action} ${event.target} (${signed(event.delta)})`,
        ok: event.ok,
      }
    case "session-start":
      return {
        ...base,
        kind: "session",
        tool: null,
        summary: `${event.resumed ? "resumed" : "started"} session (${event.agent})`,
        ok: true,
      }
    case "session-end":
      return {
        ...base,
        kind: "session",
        tool: null,
        summary: `ended session (${event.reason})`,
        ok: true,
      }
    case "turn-complete":
      return {
        ...base,
        kind: "turn",
        tool: null,
        summary: `turn ${event.outcome} in ${Math.round(event.durationMs)}ms`,
        ok: event.outcome === "ok",
      }
    case "file-change":
      return { ...base, kind: "file", tool: event.tool, summary: `${event.action} ${event.path}`, ok: event.ok }
    case "skill-use":
      return { ...base, kind: "skill", tool: "skill_view", summary: `used skill ${event.name}`, ok: true }
    case "error-raised":
      return { ...base, kind: "error", tool: event.tool ?? null, summary: event.message, ok: false }
  }
}

/** Filters for `GET /v1/audit`. */
export interface AuditQuery {
  /** Inclusive lower bound on `ts` (epoch ms): `record.ts >= since`. */
  since?: number
  /** Exclusive upper bound on `ts` (epoch ms): `record.ts < until`. */
  until?: number
  session?: string
  tool?: string
  kind?: string
}

/**
 * Apply the `since`/`until`/`session`/`tool`/`kind` filters. Boundaries are
 * `since` inclusive and `until` exclusive (so adjacent windows tile without
 * double-counting). Pure; returns a new array preserving input order.
 */
export function filterRecords(records: readonly NormalizedAuditRecord[], q: AuditQuery = {}): NormalizedAuditRecord[] {
  return records.filter((record) => {
    if (q.since !== undefined && !(record.ts >= q.since)) return false
    if (q.until !== undefined && !(record.ts < q.until)) return false
    if (q.session !== undefined && record.session !== q.session) return false
    if (q.tool !== undefined && record.tool !== q.tool) return false
    if (q.kind !== undefined && record.kind !== q.kind) return false
    return true
  })
}

/** Newest-first by `ts` (stable for equal timestamps: input order kept). Pure. */
export function sortNewestFirst(records: readonly NormalizedAuditRecord[]): NormalizedAuditRecord[] {
  return [...records].sort((a, b) => b.ts - a.ts)
}

/** Default page size for `GET /v1/audit`. */
export const DEFAULT_AUDIT_LIMIT = 20
/** Hard page-size cap. */
export const MAX_AUDIT_LIMIT = 100

/** Clamp a page size into `[1, MAX_AUDIT_LIMIT]`; malformed → the default. */
export function clampAuditLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_AUDIT_LIMIT
  return Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Opaque base64url cursor: the offset of the NEXT page. */
export function encodeCursor(offset: number): string {
  const n = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  return Buffer.from(JSON.stringify({ o: n }), "utf8").toString("base64url")
}

/**
 * Decode an opaque cursor to its next-page offset. Malformed input **throws**
 * (`Error("invalid cursor")`) — the route maps that to
 * `400 {error:"invalid_request"}`. A cursor is opaque: callers must not read it.
 */
export function decodeCursor(cursor: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new Error("invalid cursor")
  }
  if (!isRecord(parsed)) throw new Error("invalid cursor")
  const offset = parsed["o"]
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new Error("invalid cursor")
  return offset
}

/** One page of records plus the cursor for the next page (null at the end). */
export interface AuditPage {
  records: NormalizedAuditRecord[]
  nextCursor: string | null
}

/**
 * Slice `records` from an optional cursor. `limit` is clamped (default 20, max
 * 100). A malformed cursor throws (see `decodeCursor`); an offset past the end
 * yields an empty page with `nextCursor: null`.
 */
export function paginate(
  records: readonly NormalizedAuditRecord[],
  limit: number | undefined,
  cursor?: string,
): AuditPage {
  const size = clampAuditLimit(limit)
  const offset = cursor === undefined || cursor === "" ? 0 : decodeCursor(cursor)
  const page = records.slice(offset, offset + size)
  const next = offset + page.length
  return { records: page, nextCursor: next < records.length ? encodeCursor(next) : null }
}

/** One normalized record per line (lossless: every field, `before` included). */
export function toJsonl(records: readonly NormalizedAuditRecord[]): string {
  if (records.length === 0) return ""
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

/**
 * Fixed CSV columns. `before` is **omitted**: it holds the prior file content
 * (up to the whole file) and would bloat/blow up a CSV cell; the JSONL export
 * keeps it for a lossless round-trip.
 */
export const CSV_COLUMNS = ["ts", "session", "kind", "tool", "summary", "ok", "path", "undone", "refTs"] as const

/** RFC4180 field quoting: wrap and double `"` when the value has `,`/`"`/CR/LF. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** RFC4180 CSV (CRLF rows), one header + one row per record; `before` omitted. */
export function toCsv(records: readonly NormalizedAuditRecord[]): string {
  const rows: string[] = [CSV_COLUMNS.join(",")]
  for (const record of records) {
    rows.push(
      [
        String(record.ts),
        record.session,
        record.kind,
        record.tool ?? "",
        record.summary,
        record.ok ? "true" : "false",
        record.path ?? "",
        record.undone === undefined ? "" : record.undone ? "true" : "false",
        record.refTs === undefined ? "" : String(record.refTs),
      ]
        .map(csvField)
        .join(","),
    )
  }
  return `${rows.join("\r\n")}\r\n`
}

/** Bound on distinct keys per stats map; overflow collapses into `"(other)"`. */
export const AUDIT_STATS_KEY_MAX = 50
const OTHER_KEY = "(other)"
const NO_TOOL_KEY = "(none)"

/** Increment `map[key]`, collapsing new keys into `"(other)"` past the cap. */
function tally(into: Record<string, number>, key: string): void {
  const current = into[key]
  if (current !== undefined) {
    into[key] = current + 1
    return
  }
  if (Object.keys(into).length >= AUDIT_STATS_KEY_MAX) {
    into[OTHER_KEY] = (into[OTHER_KEY] ?? 0) + 1
    return
  }
  into[key] = 1
}

export interface AuditStats {
  total: number
  byKind: Record<string, number>
  byTool: Record<string, number>
  bySession: Record<string, number>
}

/**
 * Count records by kind/tool/session. Maps are **bounded**
 * (`AUDIT_STATS_KEY_MAX`); a tool-less record counts under `"(none)"`. Pure.
 */
export function auditStats(records: readonly NormalizedAuditRecord[]): AuditStats {
  const byKind: Record<string, number> = {}
  const byTool: Record<string, number> = {}
  const bySession: Record<string, number> = {}
  for (const record of records) {
    tally(byKind, record.kind)
    tally(byTool, record.tool ?? NO_TOOL_KEY)
    tally(bySession, record.session)
  }
  return { total: records.length, byKind, byTool, bySession }
}
