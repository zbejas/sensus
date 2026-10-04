/**
 * Shared cursor-blink phase (chat input caret + terminal-pane cursor).
 *
 * One module-level signal toggles every BLINK_PERIOD_MS; `blinkOn()` also
 * holds solid for a window after `blinkActivity()` (typing / cursor moves)
 * so a caret never vanishes mid-edit. The pure decision lives in
 * `caretVisible` (unit-tested); this module only wires the interval.
 *
 * Animation is gated: `setBlinkAnimations(false)` (App wires it from
 * `chat.animations` + `SENSUS_REDUCED_MOTION`) keeps the caret solid and takes
 * the toggle out of the paint path. The terminal-pane cursor is native to the
 * embedded VT and is unaffected.
 *
 * The interval is unref'd so importing this module never keeps a test
 * process (or a torn-down app) alive.
 */

import { createSignal } from "solid-js"

/** Half the blink cycle: visible for one phase, hidden for one. */
export const BLINK_PERIOD_MS = 530
/** After activity the caret stays solid at least this long. */
export const SOLID_AFTER_ACTIVITY_MS = 600

/** Pure blink decision: visible while in the ON phase, or briefly after activity.
 * When `animationsEnabled` is false (chat.animations off, or reduced motion) the
 * caret stays solid — the ON phase — so motion-sensitive users get no blink. */
export function caretVisible(
  phase: boolean,
  lastActivityAt: number,
  now: number,
  animationsEnabled = true,
): boolean {
  if (!animationsEnabled) return true
  return phase || now - lastActivityAt < SOLID_AFTER_ACTIVITY_MS
}

const TRUTHY = new Set(["1", "true", "yes", "on"])

/**
 * `SENSUS_REDUCED_MOTION` (default `process.env`) forces the caret solid as a
 * user-level override, independent of `chat.animations`. Pure over an env map
 * so the decision is unit-testable.
 */
export function reducedMotionEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = env["SENSUS_REDUCED_MOTION"]
  return v !== undefined && TRUTHY.has(v.toLowerCase())
}

const [phase, setPhase] = createSignal(true)
const [lastActivity, setLastActivity] = createSignal(0)
/** Whether the caret is allowed to animate (App sets it from chat.animations +
 * reduced motion). Read reactively so an InputRow repaints solid immediately. */
const [animations, setAnimations] = createSignal(true)

/** Reactive: true when a blinking caret should currently be painted. When
 * animation is disabled this returns solid WITHOUT reading the phase signal, so
 * an InputRow memo never subscribes to the 530ms tick. */
export function blinkOn(): boolean {
  if (!animations()) return true
  return caretVisible(phase(), lastActivity(), Date.now())
}

/** Enable/disable caret animation (App wires this from config + reduced motion). */
export function setBlinkAnimations(enabled: boolean): void {
  setAnimations(enabled)
}

/** User input touched a caret (typing, cursor move, click): hold it solid. */
export function blinkActivity(): void {
  setLastActivity(Date.now())
}

const timer = setInterval(() => setPhase((p) => !p), BLINK_PERIOD_MS)
timer.unref?.()
