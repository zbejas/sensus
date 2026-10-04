/**
 * Message / card entrance animation (docs/DESIGN.md "Motion"): a short
 * ease-out slide+fade played ONCE when a message first appears, gated by
 * `chat.animations` (chat.animations: false → instant).
 *
 * Why once-per-message and not once-per-component: Solid's reference-keyed
 * `<For>` recreates the streaming assistant block on every delta (chatSession
 * replaces the message object each append), so a mount-keyed animation would
 * replay on every chunk. `createEntranceTracker` remembers which message ids
 * have already played and refuses to re-trigger, and the timestamp window
 * keeps historical / resumed messages from animating at all (they were not
 * "just sent").
 *
 * The pure math + the shared tick live here (same shape as ui/lib/spinner.ts);
 * the tick is read ONLY while a message is still animating, so settled
 * messages never subscribe and idle repaints stay at zero.
 */

import { createSignal } from "solid-js"

/** Entrance duration. */
export const ENTRANCE_MS = 220
/** Animation frame period. */
export const ENTRANCE_TICK_MS = 55
/** A message older than this at first sight does not animate (history/resume). */
export const ENTRANCE_MAX_AGE_MS = 1500

/** Cubic ease-out: fast start, gentle landing. Pure. */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - x, 3)
}

/** Progress 0..1 for an entrance that started at `startedAt`. A disabled or
 * null start returns 1 immediately (no animation). Pure. */
export function entranceProgress(startedAt: number | null, now: number, enabled = true): number {
  if (!enabled || startedAt === null) return 1
  return easeOutCubic((now - startedAt) / ENTRANCE_MS)
}

/** Cells of slide remaining at progress `p` (max 1, so a card never overflows
 * the content column while animating). Pure. */
export function entranceSlide(p: number): number {
  return Math.max(0, Math.round((1 - Math.min(1, Math.max(0, p))) * 1))
}

/** Whether the shared entrance tick is still needed to finish `p`. Pure. */
export function entranceActive(p: number): boolean {
  return p < 1
}

export type EntranceStart = (id: number, ts: number, enabled: boolean) => number | null

/**
 * One tracker per chat sidebar: returns a start timestamp the first time a
 * recent message id is seen (and null for every later sight or an old
 * message). `enabled=false` (chat.animations off) always returns null.
 */
export function createEntranceTracker(): EntranceStart {
  const seen = new Set<number>()
  return (id, ts, enabled) => {
    if (!enabled || seen.has(id)) return null
    seen.add(id)
    const now = Date.now()
    if (now - ts > ENTRANCE_MAX_AGE_MS) return null
    return now
  }
}

const [frame, setFrame] = createSignal(0)

const timer = setInterval(() => setFrame((f) => (f + 1) % 1_000_000), ENTRANCE_TICK_MS)
timer.unref?.()

/** Reactive entrance tick (monotonic; consumers read it only while animating). */
export function entranceFrame(): number {
  return frame()
}
