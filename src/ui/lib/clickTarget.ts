/**
 * Click-target mapping for the "ONE text row" chrome pattern (M7). opentui
 * spans cannot carry handlers, so TabBar/StatusBar/label rows each render a
 * single <text> and map the clicked COLUMN back onto a segment by re-walking
 * the exact rendered strings (cps widths — emoji/CJK safe).
 *
 * Shared here because the prologue was hand-rolled identically in five
 * components; the width walk and left-button guard now have one home.
 */

import { MouseButton, type MouseEvent as OpentuiMouseEvent } from "@opentui/core"
import { cps } from "../../core/util.ts"

/** The clicked column within the element (0-based), or null when the event
 * carries no target or is not a LEFT press (right-click = selection copy). */
export function leftClickColumn(e: OpentuiMouseEvent): number | null {
  if (e.button !== MouseButton.LEFT) return null
  const origin = e.currentTarget
  if (origin === null) return null
  return e.x - origin.screenX
}

/** Pane-local {col, row} for mouse re-encoding (App's packetFromEvent). */
export function eventCell(e: OpentuiMouseEvent): { col: number; row: number } | null {
  const origin = e.currentTarget
  if (origin === null) return null
  return { col: e.x - origin.screenX, row: e.y - origin.screenY }
}

/** Width of a rendered segment in cells. */
export const spanWidth = (s: string): number => cps(s).length

/**
 * Which region does column `col` fall in? Regions are {start, length} spans
 * in render order (returns the LAST region containing the column, matching
 * the sequential walk used before this helper existed). Null when outside.
 */
export function regionAt(regions: ReadonlyArray<{ start: number; length: number }>, col: number): number | null {
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]
    if (r === undefined) continue
    if (col >= r.start && col < r.start + r.length) return i
  }
  return null
}

/**
 * Walk `texts` in order (each `gap` cells wide after its text) and invoke
 * `hit(index)` for the segment containing `col`; stops at the first hit.
 * `tail` is appended once after the last text (TabBar's " + " affordance).
 */
export function walkSegments(
  texts: readonly string[],
  col: number,
  hit: (index: number) => void,
  gap = 0,
  tail?: { text: string; onHit: () => void },
): void {
  let x = 0
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] ?? ""
    const w = spanWidth(t)
    if (col >= x && col < x + w) {
      hit(i)
      return
    }
    x += w + gap
  }
  if (tail !== undefined && col >= x && col < x + spanWidth(tail.text)) tail.onHit()
}
