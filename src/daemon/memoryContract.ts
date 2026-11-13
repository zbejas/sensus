/**
 * The memory resource contract shared by the local REST routes
 * (`src/daemon/memory.ts`) and the cloud broker (`src/daemon/cloud/broker.ts`).
 *
 * Kept Elysia-free so the broker can reuse the exact same target/action
 * validation and the `memory-write` audit emit without importing the HTTP layer.
 */

import { getLogger } from "../core/log.ts"
import type { EventSink, MemoryResult, MemoryTarget } from "../engine/index.ts"

/** The three stores, in display order. */
export const MEMORY_TARGETS = ["memory", "host", "journal"] as const

/** The mutating actions the local API accepts (reads are the `GET` routes). */
export const MEMORY_ACTIONS = ["add", "replace", "remove", "rewrite", "prune"] as const

export type DaemonMemoryAction = (typeof MEMORY_ACTIONS)[number]

export function isMemoryTarget(value: unknown): value is MemoryTarget {
  return typeof value === "string" && (MEMORY_TARGETS as readonly string[]).includes(value)
}

export function isMemoryAction(value: unknown): value is DaemonMemoryAction {
  return typeof value === "string" && (MEMORY_ACTIONS as readonly string[]).includes(value)
}

/**
 * Emit one `memory-write` for a committed store write (docs/extensions.md):
 * only a `{ok:true, write}` result is recorded. A sink failure is swallowed so
 * it can never break the action it records. Content is never logged.
 */
export function emitMemoryWrite(events: EventSink, result: MemoryResult): void {
  const write = result.write
  if (!result.ok || write === undefined) return
  try {
    events.emit({
      type: "memory-write",
      ts: Date.now(),
      session: "daemon",
      target: write.target,
      action: write.action,
      beforeChars: write.beforeChars,
      afterChars: write.afterChars,
      delta: write.delta,
      ok: true,
    })
  } catch (err) {
    // A sink must never break the action it records.
    getLogger().child({ component: "daemon.memory" }).warn("memory-write event emit failed", { err, target: write.target })
  }
}
