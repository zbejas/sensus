/**
 * Shared spinner/animation phase (chat streaming indicator, running tool
 * cards, thinking header, status bar). OpenCode-TUI parity: braille frames at
 * ~80ms (packages/tui/src/component/spinner.tsx) — but our pinned opentui
 * 0.5.11 has no native <spinner> renderable, so this is the same pattern as
 * ui/blink.ts: one module-level tick signal, components derive a frame char.
 *
 * Only computations that READ spinnerFrame() re-render per tick; settled
 * messages never read it (conditional reads in the layout memos), so idle
 * repaints stay at zero.
 *
 * The interval is unref'd so importing this module never keeps a test
 * process (or a torn-down app) alive.
 */

import { createSignal } from "solid-js"

/** OpenCode's spinner frame set (packages/tui/src/component/spinner.tsx). */
export const SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
/** Frame advance period — matches opencode's <spinner interval={80}>. */
export const SPINNER_INTERVAL_MS = 80
/** Static glyph when animations are disabled (opencode's fallback). */
export const SPINNER_STATIC = "⋯"

const [frame, setFrame] = createSignal(0)

const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS)
timer.unref?.()

/** Reactive tick counter (monotonic; consumers derive what they need). */
export function spinnerFrame(): number {
  return frame()
}

/** Current frame glyph, or the static glyph when animations are disabled. */
export function spinnerChar(animationsEnabled: boolean): string {
  if (!animationsEnabled) return SPINNER_STATIC
  return SPINNER_FRAMES[frame() % SPINNER_FRAMES.length] ?? SPINNER_STATIC
}
