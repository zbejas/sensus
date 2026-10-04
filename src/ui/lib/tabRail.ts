/**
 * Pure geometry for the vertical tab rail (`layout: "sidebar"`), the far-left
 * full-height card that replaces the horizontal `TabBar` (docs/DESIGN.md
 * "Tab bar"). No Solid/opentui imports — unit-testable on its own.
 *
 * Row budget (top to bottom): two border rows, one row per visible tab entry,
 * and two pinned action rows at the bottom (` + new tab`, ` ? commands`).
 * A rail row (left to right): a 2-cell marker slot (`"● "` active / `"  "`),
 * the `N:` index, the (truncated) title, an optional activity glyph slot, then
 * the trailing ` × ` close region, right-aligned.
 */

import { cps } from "../../core/util.ts"

/** Columns the rail's rounded border consumes (one per side). */
const RAIL_BORDER_WIDTH = 2
/** Rows the rail's rounded border consumes (top + bottom). */
const RAIL_BORDER_ROWS = 2
/** Pinned action rows at the bottom (` + new tab`, ` ? commands`). */
const RAIL_ACTION_ROWS = 2

/** Cells in the trailing ` × ` close region (space, glyph, space). */
export const RAIL_CLOSE_WIDTH = 3
/** Cells in the leading `● ` / `  ` marker slot. */
export const RAIL_MARKER_WIDTH = 2
/** Cells in the `N:` index slot (assumes a single-digit tab number; a
 * two-digit index simply borrows one cell from the title's padding). */
export const RAIL_INDEX_WIDTH = 2
/** Cells in the optional activity slot (a separating space + one glyph). */
export const RAIL_ACTIVITY_WIDTH = 2

/** Coerce a possibly non-finite dimension to a finite integer (0 fallback). */
function finiteInt(v: number): number {
  return Number.isFinite(v) ? Math.floor(v) : 0
}

/** The rail's inner cell width (outer columns minus the two border columns). */
export function railInnerWidth(width: number): number {
  return Math.max(0, finiteInt(width) - RAIL_BORDER_WIDTH)
}

/** Rows available to tab entries: height minus the two border rows and the
 * two pinned action rows, floored at 1 so a tiny rail still draws one tab. */
export function railTabCapacity(height: number): number {
  return Math.max(1, finiteInt(height) - RAIL_BORDER_ROWS - RAIL_ACTION_ROWS)
}

/**
 * The `[start, end)` slice of `count` tab entries the rail should render.
 *
 * When every entry fits (`count <= capacity`) the whole list is returned
 * (`start=0`, `end=count`). Otherwise the window slides so the ACTIVE entry is
 * on screen — centred where possible, then clamped to the list bounds — so a
 * long tab list keeps the active tab visible without a scroll position.
 * Defensive on the inputs: `count 0` → empty, `activeIndex < 0` (no active
 * tab) is treated as the first entry, `capacity` is floored at 1, and an
 * out-of-range `activeIndex` is clamped to the last entry.
 */
export function tabRailWindow(
  count: number,
  activeIndex: number,
  capacity: number,
): { start: number; end: number } {
  const n = Math.max(0, finiteInt(count))
  if (n === 0) return { start: 0, end: 0 }
  const cap = Math.max(1, finiteInt(capacity))
  if (n <= cap) return { start: 0, end: n }
  const active = activeIndex < 0 ? 0 : Math.min(Math.floor(activeIndex), n - 1)
  const maxStart = n - cap
  const start = Math.min(Math.max(active - Math.floor(cap / 2), 0), maxStart)
  return { start, end: start + cap }
}

/**
 * Rows the rail must paint BLANK underneath its visible tab entries to fill the
 * card (everything between the entries and the pinned action rows).
 *
 * These are rendered as full-width blank rows, not a bare flex spacer, so every
 * rail cell is repainted each frame: opentui keeps stale cells where nothing
 * paints, and a terminal renderable that briefly overlays the rail would leave
 * frozen shell output behind it (docs/DESIGN.md "Do's and don'ts"). `capacity`
 * is `railTabCapacity`; `visibleCount` is the windowed entry count (≤ capacity).
 */
export function railFillerRows(capacity: number, visibleCount: number): number {
  return Math.max(0, finiteInt(capacity) - Math.max(0, finiteInt(visibleCount)))
}

/**
 * Cells left for a tab title in one rail row after the fixed chrome:
 * `innerWidth` minus the ` × ` close region, the `● ` marker slot, the `N:`
 * index slot, and (when the tab is busy) the activity glyph slot. Never below
 * 1, so a title always renders at least one cell (the rail's minimum width
 * keeps the budget comfortable; this floor is the defensive case).
 */
export function railTitleBudget(innerWidth: number, hasActivity: boolean): number {
  const available = Math.max(0, finiteInt(innerWidth) - RAIL_CLOSE_WIDTH)
  const budget =
    available - RAIL_MARKER_WIDTH - RAIL_INDEX_WIDTH - (hasActivity ? RAIL_ACTIVITY_WIDTH : 0)
  return Math.max(1, budget)
}

/**
 * The column where the right-aligned ` × ` close region starts in a row of
 * `innerWidth` cells. Floored at 0 so a degenerate width can never produce a
 * negative region start.
 */
export function RAIL_CLOSE_AT(innerWidth: number): number {
  return Math.max(0, finiteInt(innerWidth) - RAIL_CLOSE_WIDTH)
}

/** The display width of a rail label/span in cells (emoji/CJK safe). */
export function railTextWidth(text: string): number {
  return cps(text).length
}
