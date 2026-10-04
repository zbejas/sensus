/**
 * Agent memory data model (docs/memory.md): three plain-markdown stores the
 * agent maintains with the `memory` tool.
 *
 *   - MEMORY.md  — environment facts/conventions/lessons; ALWAYS injected
 *                  into the system prompt as a frozen per-session snapshot.
 *   - HOST.md    — the machine/server architecture map; never injected, read
 *                  and edited through the tool.
 *   - JOURNAL.md — episodic log; never injected, append-only + ring-trimmed.
 *
 * Pure types (plus tiny pure predicates) — no fs, no signals — so the store,
 * tools, UI and tests share one vocabulary.
 */

export type MemoryTarget = "memory" | "host" | "journal"

/** A whole-store `rewrite` applies only to the two hard-capped stores
 * (MEMORY/HOST); JOURNAL is episodic and ring-trims automatically. */
export function isRewritableTarget(target: MemoryTarget): boolean {
  return target === "memory" || target === "host"
}

/** The agent-facing actions of the `memory` tool. `rewrite` commits a
 * whole-store replacement the MODEL supplies (memory/host only; docs/memory.md
 * "Rewrite") — no second provider pass. */
export type MemoryAction = "add" | "replace" | "remove" | "list" | "read" | "rewrite"

/** Hard character caps per store (config `memory.*CharLimit`). */
export interface MemoryLimits {
  memory: number
  host: number
  journal: number
}

/** Live usage of one store (manager UI + the model-facing error payload). */
export interface MemoryUsage {
  target: MemoryTarget
  /** Rendered content length (entries joined by the `§` delimiter). */
  used: number
  limit: number
  /** Integer percent of the cap, clamped 0-100. */
  percent: number
  /** Number of entries. */
  entries: number
}

/** Frozen MEMORY.md content captured once per ChatSession for the prompt. */
export interface MemorySnapshot {
  /** Rendered entries ("" when empty). */
  text: string
  used: number
  limit: number
}

/** Result of one store mutation/read. */
export interface MemoryResult {
  ok: boolean
  /** Model-facing message (success note or a precise error). */
  message: string
  /** Live content after the operation (rendered), when applicable. */
  content?: string
  usage?: MemoryUsage
  /** Live entries after the operation (list/read/ambiguous payloads). */
  entries?: string[]
  /** Present on a COMMITTED write: the structured char delta the audit
   * `memory-write` event carries (docs/extensions.md). */
  write?: MemoryWriteInfo
}

/** A committed memory write's char delta (docs/extensions.md "memory-write"). */
export interface MemoryWriteInfo {
  target: MemoryTarget
  /** The action that committed (`add`/`replace`/`remove`/`rewrite`/`prune`). */
  action: string
  beforeChars: number
  afterChars: number
  /** `afterChars - beforeChars` (negative = the store shrank). */
  delta: number
}

/** A paragraph separator line in a memory file. */
export const MEMORY_ENTRY_SEPARATOR = "§"

/**
 * The store surface the `memory` tool needs (MemoryStore satisfies it
 * structurally). Kept here so the tool layer never imports the fs store.
 */
export interface MemoryToolBridge {
  read(target: MemoryTarget): string
  list(target: MemoryTarget): MemoryResult
  readResult(target: MemoryTarget): MemoryResult
  add(target: MemoryTarget, content: string): MemoryResult
  replace(target: MemoryTarget, oldText: string, content: string): MemoryResult
  remove(target: MemoryTarget, oldText: string): MemoryResult
  /** Commit a whole-store replacement body (memory/host only) supplied by the
   * model. Applies the same safety scans + hard cap as a normal write. */
  rewrite(target: MemoryTarget, body: string): MemoryResult
  usage(target: MemoryTarget): MemoryUsage
}

/** Per-store file name under the memory dir. */
export const MEMORY_FILE: Record<MemoryTarget, string> = {
  memory: "MEMORY.md",
  host: "HOST.md",
  journal: "JOURNAL.md",
}
