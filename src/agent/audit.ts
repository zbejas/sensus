/**
 * Audit log (docs/operations.md "Persistence", phase 4.8): an append-only JSONL
 * record of state-changing actions (file writes, memory writes, gated shell
 * commands) plus enough data to UNDO the most recent file write. Kept under
 * the state dir so it survives relaunches; bounded so it cannot grow forever.
 *
 * Never throws: a failing disk must not break the action it is recording.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { componentLogger } from "./log.ts"

const log = componentLogger("agent.audit")

export interface AuditEntry {
  ts: number
  /** Instance id (coarse session grouping). */
  session: string
  /** Coarse kind for filtering: "file" | "memory" | "shell" | "other". */
  kind: string
  /** Tool name. */
  tool: string
  /** One-line description of what changed. */
  summary: string
  ok: boolean
  /** File writes: absolute path. */
  path?: string
  /** File writes: prior content (null = the file did not exist). */
  before?: string | null
  /** True once an undo has consumed this entry. */
  undone?: boolean
  /** On an undo tombstone: the ts of the entry it consumed. */
  refTs?: number
}

const DEFAULT_KEEP = 2000

/**
 * The session-facing audit surface (docs/agent.md "Undo & audit"): ChatHost
 * binds an AuditLog and fills the session id, so ChatSession never touches fs.
 */
export interface AuditBridge {
  record(entry: Omit<AuditEntry, "session">): void
  lastUndoable(): AuditEntry | null
  markUndone(ts: number): void
  recent(limit?: number): AuditEntry[]
}

export class AuditLog {
  readonly path: string
  private readonly keep: number
  private wrote = 0

  constructor(opts: { path: string; keep?: number }) {
    this.path = opts.path
    this.keep = opts.keep !== undefined && opts.keep > 0 ? opts.keep : DEFAULT_KEEP
    this.wrote = this.readLines().length
  }

  record(entry: AuditEntry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8")
      this.wrote++
      if (this.wrote > this.keep * 1.2) this.trim()
    } catch (e) {
      // audit is best-effort
      log.warn("audit record write failed; undo/audit trail dropped", { tool: entry.tool, kind: entry.kind, err: e })
    }
  }

  recent(limit = 50): AuditEntry[] {
    const lines = this.readLines()
    return lines.slice(Math.max(0, lines.length - Math.max(0, limit)))
  }

  /**
   * The most recent file-write entry that has not been undone. Marking it
   * undone appends a tombstone so the next undo moves further back.
   */
  lastUndoable(): AuditEntry | null {
    const lines = this.readLines()
    const undone = new Set<number>()
    for (const e of lines) {
      if (e.tool === "undo" && typeof e.refTs === "number") undone.add(e.refTs)
      else if (e.undone === true) undone.add(e.ts)
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = lines[i]!
      if (e.kind === "file" && typeof e.path === "string" && e.before !== undefined && !undone.has(e.ts)) return e
    }
    return null
  }

  /** Tombstone an undo so it is not repeated. */
  markUndone(refTs: number): void {
    this.record({ ts: Date.now(), session: "audit", kind: "undo", tool: "undo", summary: `undo ${refTs}`, ok: true, undone: true, refTs })
  }

  private readLines(): AuditEntry[] {
    let text = ""
    try {
      text = readFileSync(this.path, "utf8")
    } catch (e) {
      log.debug("audit log read failed; treating as empty", { err: e })
      return []
    }
    const out: AuditEntry[] = []
    for (const raw of text.split("\n")) {
      if (raw.trim().length === 0) continue
      try {
        const v = JSON.parse(raw) as unknown
        if (v !== null && typeof v === "object") out.push(v as AuditEntry)
      } catch (e) {
        // skip corrupt line
        log.debug("audit log corrupt line skipped", { err: e })
      }
    }
    return out
  }

  private trim(): void {
    try {
      const lines = this.readLines()
      const kept = lines.slice(Math.max(0, lines.length - this.keep))
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
      renameSync(tmp, this.path)
      this.wrote = kept.length
    } catch (e) {
      // trimming is best-effort
      log.debug("audit log trim failed", { err: e })
    }
  }
}
