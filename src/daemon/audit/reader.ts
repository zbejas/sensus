/**
 * The audit source seam (docs/daemon-api.md): a thin, never-throwing adapter
 * over the on-disk audit logs. The legacy `src/agent/audit.ts` JSONL is the
 * shipped source; the event log can plug in later behind `AuditSource`, so the
 * `GET /v1/audit` shapes never change.
 *
 * This is deliberately NOT `AuditLog`: importing the TUI's writer would couple
 * the daemon to ChatHost's in-memory `wrote` counter and trim policy. Here every
 * read is independent, missing files are empty, and corrupt lines are skipped.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AuditEntry } from "../../engine/index.ts"
import { sensusStateDir } from "../../engine/index.ts"
import { isRecord } from "../../core/util.ts"
import { normalizeAuditEntry, type NormalizedAuditRecord } from "./query.ts"

/** A read-only, defensive view of one audit log. `read` must never throw. */
export interface AuditSource {
  read(): NormalizedAuditRecord[]
}

/** Legacy audit filename under the state dir. */
export const LEGACY_AUDIT_FILENAME = "audit.jsonl"

/** Default legacy audit path: `<state-dir>/audit.jsonl` (ChatHost's writer). */
export function defaultLegacyAuditPath(): string {
  return join(sensusStateDir(), LEGACY_AUDIT_FILENAME)
}

/**
 * Coerce a parsed JSON object into an `AuditEntry`, or null when a required
 * field is missing/mistyped. Optional fields are copied only when well-typed.
 */
function asAuditEntry(v: Record<string, unknown>): AuditEntry | null {
  const { ts, session, kind, tool, summary, ok } = v
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null
  if (typeof session !== "string") return null
  if (typeof kind !== "string") return null
  if (typeof tool !== "string") return null
  if (typeof summary !== "string") return null
  if (typeof ok !== "boolean") return null
  const entry: AuditEntry = { ts, session, kind, tool, summary, ok }
  if (typeof v["path"] === "string") entry.path = v["path"]
  if (v["before"] === null || typeof v["before"] === "string") entry.before = v["before"]
  if (typeof v["undone"] === "boolean") entry.undone = v["undone"]
  if (typeof v["refTs"] === "number" && Number.isFinite(v["refTs"])) entry.refTs = v["refTs"]
  return entry
}

/**
 * The legacy `audit.jsonl` reader (docs/agent.md "Undo & audit"). Injectable
 * path (tests); defaults to `defaultLegacyAuditPath()`. Tolerates a missing
 * file, blank lines and corrupt/partial JSON: any per-line failure is skipped,
 * and the file read is wrapped, so `read()` never throws.
 */
export class LegacyAuditJsonlSource implements AuditSource {
  readonly path: string

  constructor(path: string = defaultLegacyAuditPath()) {
    this.path = path
  }

  read(): NormalizedAuditRecord[] {
    let text: string
    try {
      text = readFileSync(this.path, "utf8")
    } catch {
      return []
    }
    const out: NormalizedAuditRecord[] = []
    for (const raw of text.split("\n")) {
      if (raw.trim().length === 0) continue
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!isRecord(parsed)) continue
        const entry = asAuditEntry(parsed)
        if (entry === null) continue
        out.push(normalizeAuditEntry(entry))
      } catch {
        // Skip a corrupt line; one bad byte must not hide the rest of the log.
      }
    }
    return out
  }
}

/**
 * Concatenate several sources. Each source labels its own records
 * (`source: "legacy" | "events"`), so the union is tagged by construction.
 *
 * A throwing source is swallowed, never propagated.
 */
export class MergedAuditSource implements AuditSource {
  private readonly sources: AuditSource[]

  constructor(sources: readonly AuditSource[]) {
    this.sources = [...sources]
  }

  read(): NormalizedAuditRecord[] {
    const out: NormalizedAuditRecord[] = []
    for (const source of this.sources) {
      try {
        out.push(...source.read())
      } catch {
        // A broken source must never break the merge (or the request).
      }
    }
    return out
  }
}
