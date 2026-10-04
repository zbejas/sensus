/**
 * Pure row styling helpers for the chat sidebar (docs/DESIGN.md "Color and
 * theme" / "Motion"). No Solid/opentui runtime imports — unit-testable.
 */

import { textBgProps, type ResolvedTheme, type ThemeColor } from "../../theme/theme.ts"
import type { SegStyle } from "../../engine/index.ts"

export function pickColor(st: SegStyle, t: ResolvedTheme): ThemeColor {
  if (st.error) return t.danger
  if (st.accent) return t.accent
  if (st.code || st.heading || st.link) return t.accent
  if (st.dim) return t.muted
  return t.fg
}

export function spanAttrs(st: SegStyle, t: ResolvedTheme): Record<string, unknown> {
  return {
    fg: pickColor(st, t),
    bold: !!st.bold || !!st.heading,
    italic: !!st.italic,
    underline: !!st.link || !!st.underline,
    // `dim` already maps to the muted token in `pickColor`; a second SGR-faint
    // pass halved that color again on terminals that implement it, making
    // reasoning/tool bodies and labels unreadable. Paint the muted color only
    // (explicit false so a style change resets a prior paint).
    dim: false,
  }
}

export function bgStyle(t: ResolvedTheme): Record<string, unknown> {
  return textBgProps(t.bg)
}

/** Interaction feedback state for a clickable chat row. */
export type RowFx = "idle" | "hover" | "press"

/** How long the press highlight holds after mousedown — the action fires on
 * the down event, so the flash must outlive it to be visible. */
export const PRESS_HOLD_MS = 130

/** How long a second click on the same code row still counts as a double
 * click (paste + Enter) instead of a fresh paste. */
export const CODE_DOUBLE_CLICK_MS = 400

/** Last code-row click, for double-click detection (see {@link codeClickAction}). */
export interface CodeClickState {
  at: number
  code: string
}

/** Decide what a code-row mousedown does. The first click PASTES `code` (no
 * Enter); a second click on the SAME line within {@link CODE_DOUBLE_CLICK_MS}
 * presses Enter to run what the first click pasted. The returned `next` state
 * is cleared after a run, so a third click pastes again. Pure — unit-tested. */
export function codeClickAction(
  prev: CodeClickState | null,
  code: string,
  now: number,
): { action: "paste" | "run"; next: CodeClickState | null } {
  const elapsed = prev === null ? null : now - prev.at
  if (prev !== null && prev.code === code && elapsed !== null && elapsed >= 0 && elapsed <= CODE_DOUBLE_CLICK_MS) {
    return { action: "run", next: null }
  }
  return { action: "paste", next: { at: now, code } }
}

/** bg/fg for a row at interaction state `fx`: hover paints the theme selection
 * fill (falling back to the accent fg when a theme has none), press paints the
 * accent block. `baseBg` is the card surface. Always returns an explicit bg so
 * a cleared hover repaints (opentui styles are additive — docs/DESIGN.md). */
export function rowFx(t: ResolvedTheme, fx: RowFx, baseBg: string | null): { bg: ThemeColor; fg: ThemeColor | null } {
  if (fx === "press") return { bg: t.accent, fg: t.onAccent }
  if (fx === "hover") {
    if (t.selectionBg !== null) return { bg: t.selectionBg, fg: t.onSelection ?? t.fg }
    return { bg: baseBg ?? "transparent", fg: t.accent }
  }
  return { bg: baseBg ?? "transparent", fg: null }
}
