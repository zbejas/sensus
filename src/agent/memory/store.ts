/**
 * MemoryStore (docs/memory.md): the single writer for the three plain-markdown
 * stores under the memory dir. Pure fs + logic (no signals, no provider).
 *
 * Invariants:
 *   - A cap is a HARD limit for MEMORY.md and HOST.md: an over-limit write
 *     returns an ERROR and never truncates, so the model consolidates first.
 *     JOURNAL.md is episodic and RING-TRIMMED (oldest entries drop to fit).
 *   - Entries are paragraphs separated by a lone `§` line; the file is human-
 *     editable and round-trips.
 *   - Duplicate `add` is a no-op success.
 *   - `replace` is a FIND-AND-REPLACE: it locates the single entry containing
 *     `old_text` and substitutes `content` for EXACTLY the matched span, so
 *     the rest of the entry is untouched. When `old_text` is the whole entry,
 *     that entry is replaced. `remove` deletes the whole matched entry. A
 *     whole-entry exact match wins; an ambiguous/multi-occurrence match
 *     returns the candidates instead of guessing.
 *   - Secret redaction + injection scanning refuse a write by default.
 *   - Every successful write appends a compact before/after record to
 *     `.history.jsonl` (newest 500 kept) so edits are auditable/undoable.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { countOccurrences } from "../../core/util.ts"
import { componentLogger } from "../log.ts"
import { containsInjection, containsSecret, stripInvisible } from "./safety.ts"
import {
  MEMORY_ENTRY_SEPARATOR,
  MEMORY_FILE,
  type MemoryLimits,
  type MemoryResult,
  type MemorySnapshot,
  type MemoryTarget,
  type MemoryUsage,
} from "./types.ts"

export interface MemoryStoreOptions {
  dir: string
  limits: MemoryLimits
  /** Refuse writes that look like secrets (default true). */
  redactSecrets?: boolean
}

const HISTORY_FILE = ".history.jsonl"
const HISTORY_KEEP = 500

const log = componentLogger("agent.memory")

/** Split a memory file body into trimmed, non-empty entries. */
export function parseEntries(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  const flush = (): void => {
    const t = cur.join("\n").trim()
    if (t.length > 0) out.push(t)
    cur = []
  }
  for (const line of text.split("\n")) {
    if (line.trim() === MEMORY_ENTRY_SEPARATOR) flush()
    else cur.push(line)
  }
  flush()
  return out
}

/** Render entries back to the on-disk body (lone `§` separator lines). */
export function renderEntries(entries: readonly string[]): string {
  return entries.map((e) => e.trim()).filter((e) => e.length > 0).join(`\n${MEMORY_ENTRY_SEPARATOR}\n`)
}

function percent(used: number, limit: number): number {
  if (limit <= 0) return 100
  return Math.max(0, Math.min(100, Math.floor((used / limit) * 100)))
}

function oneLine(s: string, max = 100): string {
  const first = (s.split("\n")[0] ?? "").trim()
  return first.length > max ? `${first.slice(0, max)}…` : first
}

export class MemoryStore {
  readonly dir: string
  private limits: MemoryLimits
  private redact: boolean

  constructor(opts: MemoryStoreOptions) {
    this.dir = opts.dir
    this.limits = opts.limits
    this.redact = opts.redactSecrets ?? true
  }

  /** Update caps live (config reload); never throws. */
  updateLimits(limits: MemoryLimits): void {
    this.limits = limits
  }

  /** Update the secret-redaction policy live (config reload). */
  setRedactSecrets(v: boolean): void {
    this.redact = v
  }

  getLimits(): MemoryLimits {
    return this.limits
  }

  /** Materialize the directory defensively (ChatHost + /reload + tests). */
  ensure(): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch (e) {
      // best-effort; a later write reports the real error
      log.debug("memory dir mkdir failed", { dir: this.dir, err: e })
    }
  }

  pathFor(target: MemoryTarget): string {
    return join(this.dir, MEMORY_FILE[target])
  }

  /** Live file body ("" when absent/unreadable). Never throws. */
  read(target: MemoryTarget): string {
    try {
      return readFileSync(this.pathFor(target), "utf8")
    } catch (e) {
      log.debug("memory read failed; treating as empty", { target, err: e })
      return ""
    }
  }

  entries(target: MemoryTarget): string[] {
    return parseEntries(this.read(target))
  }

  usage(target: MemoryTarget): MemoryUsage {
    const entries = this.entries(target)
    const used = renderEntries(entries).length
    const limit = this.limits[target]
    return { target, used, limit, percent: percent(used, limit), entries: entries.length }
  }

  /** `list`: live entries + usage for the target (read-only). */
  list(target: MemoryTarget): MemoryResult {
    const entries = this.entries(target)
    const used = renderEntries(entries).length
    const limit = this.limits[target]
    const header = `${target}: ${used}/${limit} chars (${percent(used, limit)}%) · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`
    const body = entries.length === 0 ? "(empty)" : entries.map((e, i) => `${i + 1}. ${e}`).join("\n")
    return {
      ok: true,
      message: `${header}\n${body}`,
      content: renderEntries(entries),
      entries,
      usage: { target, used, limit, percent: percent(used, limit), entries: entries.length },
    }
  }

  /** `read`: full current content of the target (host/journal are not injected). */
  readResult(target: MemoryTarget): MemoryResult {
    const content = renderEntries(this.entries(target))
    const usage = this.usage(target)
    return {
      ok: true,
      message: content.length > 0 ? content : `(${target} is empty)`,
      content,
      entries: this.entries(target),
      usage,
    }
  }

  add(target: MemoryTarget, content: string): MemoryResult {
    const clean = content.trim()
    if (clean.length === 0) return this.err(target, "nothing to add (empty content)")
    const guard = this.scan(clean)
    if (guard !== null) return this.err(target, guard)

    const entries = this.entries(target)
    if (entries.includes(clean)) {
      return { ok: true, message: "no duplicate added", content: renderEntries(entries), entries, usage: this.usage(target) }
    }
    let next = [...entries, clean]
    if (target === "journal") next = this.ringTrim(next, target)
    else {
      const over = this.overflow(next, target)
      if (over !== null) return over
    }
    return this.commit(target, "add", entries, next)
  }

  /**
   * Find-and-replace within one entry: `old_text` must match a unique span,
   * and `content` replaces ONLY that span (the rest of the entry survives).
   * When `old_text` equals the whole entry, the whole entry is replaced.
   */
  replace(target: MemoryTarget, oldText: string, content: string): MemoryResult {
    const clean = content.trim()
    if (clean.length === 0) return this.err(target, "nothing to replace with (empty content)")
    const guard = this.scan(clean)
    if (guard !== null) return this.err(target, guard)

    const entries = this.entries(target)
    const needle = oldText.trim()
    if (needle.length === 0) return this.err(target, "old_text is required")
    const match = this.locate(entries, oldText, target)
    if (match.error !== null) return match.error
    const idx = match.index!
    const entry = entries[idx] ?? ""
    // The located entry is unique, but `old_text` must also be unique INSIDE
    // it — otherwise a blind first-occurrence edit silently corrupts the rest.
    const occurrences = countOccurrences(entry, needle)
    if (occurrences > 1) {
      return this.err(
        target,
        `old_text "${oneLine(needle)}" appears ${occurrences} times in the matched entry — include more surrounding text to make it unique`,
      )
    }
    const at = entry.indexOf(needle)
    const edited = at < 0 ? entry : entry.slice(0, at) + clean + entry.slice(at + needle.length)
    const next = entries.map((e, i) => (i === idx ? edited : e))
    const over = this.overflow(next, target)
    if (over !== null) return over
    return this.commit(target, "replace", entries, next)
  }

  remove(target: MemoryTarget, oldText: string): MemoryResult {
    const entries = this.entries(target)
    const match = this.locate(entries, oldText, target)
    if (match.error !== null) return match.error
    const idx = match.index!
    const next = entries.filter((_, i) => i !== idx)
    return this.commit(target, "remove", entries, next)
  }

  /**
   * Commit a whole-store replacement body (docs/memory.md "Rewrite") that the
   * MODEL supplied through the `memory` tool — no second provider pass. Parses
   * the `§`-separated body, dedupes, and applies the SAME safety scans and hard
   * cap as a normal write — an over-budget rewrite is refused (never
   * truncated), so the model cannot silently drop durable facts past the cap.
   * Records a `.history.jsonl` action `"rewrite"`. Memory/host only: JOURNAL is
   * episodic and ring-trims.
   */
  rewrite(target: MemoryTarget, body: string): MemoryResult {
    if (target === "journal") {
      return this.err(target, "journal is append-only and ring-trims automatically — rewrite applies to memory or host")
    }
    const seen = new Set<string>()
    const next: string[] = []
    for (const raw of parseEntries(body)) {
      const e = raw.trim()
      if (e.length === 0 || seen.has(e)) continue
      const guard = this.scan(e)
      if (guard !== null) return this.err(target, guard)
      seen.add(e)
      next.push(e)
    }
    if (next.length === 0) {
      return this.err(target, "rewrite needs a non-empty body of entries separated by a lone § line")
    }
    const over = this.overflow(next, target)
    if (over !== null) return over
    return this.commit(target, "rewrite", this.entries(target), next)
  }

  /** Frozen MEMORY.md snapshot for the system prompt. */
  snapshot(): MemorySnapshot {
    const entries = this.entries("memory")
    const text = renderEntries(entries)
    return { text, used: text.length, limit: this.limits.memory }
  }

  /**
   * Remove the OLDEST entries until the rendered body fits `keepChars`
   * (default: half the store's cap). The last entry is never removed, so a
   * single oversized entry is kept intact. Used by the manager's explicit
   * prune action; journal writes already ring-trim automatically.
   */
  prune(target: MemoryTarget, keepChars?: number): MemoryResult {
    const entries = this.entries(target)
    const limit = this.limits[target]
    const keep = keepChars !== undefined && keepChars > 0 ? Math.floor(keepChars) : Math.max(1, Math.floor(limit / 2))
    const next = [...entries]
    while (renderEntries(next).length > keep && next.length > 1) next.shift()
    if (next.length === entries.length) {
      return {
        ok: true,
        message: `${target} already fits (${renderEntries(entries).length}/${keep} target chars) — nothing pruned`,
        content: renderEntries(entries),
        entries,
        usage: this.usage(target),
      }
    }
    return this.commit(target, "prune", entries, next)
  }

  // ---- internals -----------------------------------------------------------

  private scan(text: string): string | null {
    if (containsInjection(text)) {
      return "refused: content looks like a prompt-injection/instruction override (or hidden Unicode) — memory is injected into the system prompt"
    }
    if (this.redact && containsSecret(text)) {
      return "refused: content looks like it contains a secret (key/token/password/private key) — never store credentials in memory"
    }
    return null
  }

  private overflow(entries: readonly string[], target: MemoryTarget): MemoryResult | null {
    const rendered = renderEntries(entries)
    if (rendered.length <= this.limits[target]) return null
    const current = this.entries(target)
    const limit = this.limits[target]
    const body = current.length === 0 ? "(empty)" : current.map((e, i) => `${i + 1}. ${oneLine(e)}`).join("\n")
    const hint =
      target === "journal"
        ? ""
        : ' Or run the memory tool with action "rewrite" to replace the whole store with a condensed body that keeps the durable facts.'
    return {
      ok: false,
      message:
        `${target} is FULL: the write would use ${rendered.length}/${limit} chars. Nothing was written. ` +
        `Consolidate with replace/remove first (or shorten).${hint} Current entries:\n${body}`,
      content: renderEntries(current),
      entries: current,
      usage: this.usage(target),
    }
  }

  /** JOURNAL ring trim: drop oldest entries until the rendered body fits. */
  private ringTrim(entries: string[], target: MemoryTarget): string[] {
    const limit = this.limits[target]
    const next = [...entries]
    while (renderEntries(next).length > limit && next.length > 1) next.shift()
    return next
  }

  private locate(
    entries: readonly string[],
    oldText: string,
    target: MemoryTarget,
  ): { index: number | null; error: MemoryResult | null } {
    const needle = oldText.trim()
    if (needle.length === 0) return { index: null, error: this.err(target, "old_text is required") }
    const exact = entries.map((e, i) => (e === needle ? i : -1)).filter((i) => i >= 0)
    if (exact.length === 1) return { index: exact[0]!, error: null }
    const hits = exact.length > 1 ? exact : entries.map((e, i) => (e.includes(needle) ? i : -1)).filter((i) => i >= 0)
    if (hits.length === 0) return { index: null, error: this.err(target, `no entry matches "${oneLine(needle)}"`) }
    if (hits.length > 1) {
      const list = hits.map((i) => `${i + 1}. ${oneLine(entries[i] ?? "")}`).join("\n")
      return {
        index: null,
        error: this.err(target, `"${oneLine(needle)}" is ambiguous — it matches ${hits.length} entries:\n${list}\nUse a longer, unique substring.`),
      }
    }
    return { index: hits[0]!, error: null }
  }

  private commit(
    target: MemoryTarget,
    action: string,
    before: readonly string[],
    after: readonly string[],
  ): MemoryResult {
    const rendered = renderEntries(after)
    try {
      this.ensure()
      writeAtomic(this.pathFor(target), rendered.length > 0 ? `${rendered}\n` : "")
      this.appendHistory(target, action, before, after)
    } catch (e) {
      return this.err(target, `write failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    const used = rendered.length
    const limit = this.limits[target]
    const beforeUsed = renderEntries(before).length
    const delta = used - beforeUsed
    // A replace/rewrite that removes a quarter (and ≥200 chars) of the store is
    // the exact shape of a silent wipe: call it out in the result so the user
    // can verify (and, under writeApproval, reject) it.
    const largeReduction =
      (action === "replace" || action === "rewrite") && delta < 0 && -delta >= Math.max(200, Math.floor(beforeUsed * 0.25))
    const deltaText =
      delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta} chars${largeReduction ? " — large reduction: verify the entry" : ""})`
    return {
      ok: true,
      message: `${target} ${action}: ${after.length} entr${after.length === 1 ? "y" : "ies"}, ${used}/${limit} chars (${percent(used, limit)}%)${deltaText}`,
      content: rendered,
      entries: [...after],
      usage: { target, used, limit, percent: percent(used, limit), entries: after.length },
      write: { target, action, beforeChars: beforeUsed, afterChars: used, delta },
    }
  }

  private err(target: MemoryTarget, message: string): MemoryResult {
    return { ok: false, message, content: renderEntries(this.entries(target)), entries: this.entries(target), usage: this.usage(target) }
  }

  private appendHistory(
    target: MemoryTarget,
    action: string,
    before: readonly string[],
    after: readonly string[],
  ): void {
    try {
      this.ensure()
      const record = JSON.stringify({ ts: Date.now(), target, action, before: before.join(`\n${MEMORY_ENTRY_SEPARATOR}\n`), after: after.join(`\n${MEMORY_ENTRY_SEPARATOR}\n`) })
      const path = join(this.dir, HISTORY_FILE)
      let lines: string[] = []
      try {
        lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0)
      } catch (e) {
        lines = []
        log.debug("memory history read failed; starting fresh", { target, err: e })
      }
      lines.push(record)
      if (lines.length > HISTORY_KEEP) lines = lines.slice(lines.length - HISTORY_KEEP)
      writeAtomic(path, `${lines.join("\n")}\n`)
    } catch (e) {
      // history is best-effort and must never fail a memory write
      log.warn("memory history append failed; write succeeded but its history record was lost", { target, action, err: e })
    }
  }
}

/** tmp+rename atomic write so a crash cannot leave a half-written store. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, path)
}

/** Strip invisible Unicode before persisting (kept for callers/tests). */
export { stripInvisible }
