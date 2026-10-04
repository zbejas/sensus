/**
 * Pure layout geometry: terminal-size guards, the pane/sidebar/rail widths,
 * and the terminal-pane cell math.
 *
 * A sensus layout below 20x5 cannot render meaningfully (tab bar + status bar
 * + a 1x1 pane is already garbage). At boot we refuse to start; mid-run shrink
 * shows a clear full-screen notice plus a status bar warning instead of
 * rendering a broken layout.
 *
 * The global `layout` mode picks where the tab strip lives: the default
 * `"topbar"` keeps the horizontal strip on row 0 (docs/DESIGN.md "Tab bar"),
 * while `"sidebar"` moves it to a full-height vertical rail on the far left
 * (`TAB_RAIL_*`, `clampTabRailWidth`, `computePaneCells`). The terminal pane
 * stays in the middle and the chat sidebar on the right either way.
 */

/** Minimum terminal columns sensus will render. */
export const MIN_COLS = 20
/** Minimum terminal rows sensus will render. */
export const MIN_ROWS = 5

export function isTooSmall(width: number, height: number): boolean {
  return width < MIN_COLS || height < MIN_ROWS
}

export function tooSmallMessage(width: number, height: number): string {
  return `terminal too small (${width}x${height}) — sensus needs at least ${MIN_COLS}x${MIN_ROWS}`
}

/** Width in columns of the draggable divider between the terminal pane and the
 * chat sidebar (ui/components/PaneDivider.tsx). The two panes drop their shared
 * border side, so this one column is the single separator. */
export const PANE_DIVIDER_WIDTH = 1

/** Minimum chat sidebar width in columns (keyboard resize and drag). */
export const SIDEBAR_MIN = 30

/**
 * Default chat sidebar width in columns (docs/DESIGN.md "Chat sidebar",
 * docs/config.md "`sidebar` and `keymap`"). Re-exported from the config layer
 * (`src/config/config/defaults.ts`), which is the source of truth, so the
 * config default, the built-in skill, the UI geometry and the tests cannot
 * drift. Kept deliberately modest: the terminal pane is the product's
 * centerpiece, so the chat should never claim the majority of a common desktop
 * window. The old 65 left a 140-column terminal with only ~48 pane columns
 * once the vertical tab rail (default `"sidebar"` layout) also came out of the
 * budget.
 */
export { SIDEBAR_DEFAULT_WIDTH } from "../../config/config/defaults.ts"

/**
 * Clamp a desired chat sidebar width to the layout's bounds: at least
 * `SIDEBAR_MIN` and at most half the terminal. Used by both the keyboard
 * resize and the divider drag so they cannot drift.
 */
export function clampSidebarWidth(width: number, termWidth: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.floor(termWidth / 2))
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)))
}

/**
 * Clamp the chat width for the `"sidebar"` layout, where the vertical tab rail
 * (`railFootprint` columns) is also taken out of the terminal. The plain
 * `clampSidebarWidth` caps the chat at half the WHOLE terminal and ignores the
 * rail, so chat + rail could together claim well over half and starve the pane
 * (at 200 cols: chat 100 + rail 60 left the pane ~37 columns). Here the pair
 * must fit in half the terminal, so the pane keeps at least half.
 *
 * `railFootprint` is the rail width plus its divider gap (App's
 * `railFootprint()`); the chat still never drops below `SIDEBAR_MIN`, which
 * wins on a narrow terminal.
 */
export function clampSidebarWidthInLayout(width: number, termWidth: number, railFootprint: number): number {
  const half = Math.floor(termWidth / 2)
  const max = Math.max(SIDEBAR_MIN, half - Math.max(0, railFootprint))
  return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)))
}

/**
 * Sidebar width while dragging the pane divider: the divider follows the
 * pointer, so moving right widens the terminal and narrows the sidebar.
 * `startCol`/`startWidth` are captured on mousedown; App clamps the result.
 */
export function sidebarWidthForDrag(startCol: number, startWidth: number, col: number): number {
  return startWidth - (col - startCol)
}

// ---- vertical tab rail (layout: "sidebar") -------------------------------

/** Default width of the vertical tab rail in columns (`layout: "sidebar"`). */
export const TAB_RAIL_DEFAULT_WIDTH = 24
/** Minimum tab rail width in columns. */
export const TAB_RAIL_MIN_WIDTH = 16
/** Maximum tab rail width in columns. */
export const TAB_RAIL_MAX_WIDTH = 60

/**
 * Clamp a desired vertical-rail width to the layout's bounds: at least
 * `TAB_RAIL_MIN_WIDTH`, at most `TAB_RAIL_MAX_WIDTH`, and at most a third of
 * the terminal so the pane/chat keep the majority of the frame. Mirroring
 * `clampSidebarWidth`, the minimum wins over the third — on a very narrow
 * terminal the rail stays readable even though it exceeds one third.
 */
export function clampTabRailWidth(width: number, termWidth: number): number {
  const max = Math.max(TAB_RAIL_MIN_WIDTH, Math.min(TAB_RAIL_MAX_WIDTH, Math.floor(termWidth / 3)))
  return Math.min(max, Math.max(TAB_RAIL_MIN_WIDTH, Math.round(width)))
}

/**
 * Whether the `"sidebar"` layout leaves the terminal pane at least 10 usable
 * columns once the rail, the divider and the chat sidebar are subtracted. App
 * falls back to the `"topbar"` layout when this is false (a rail would starve
 * the pane), so the guard lives here as pure, testable math.
 */
export function canUseSidebarLayout(termWidth: number, railWidth: number, chatWidth: number): boolean {
  return termWidth - railWidth - PANE_DIVIDER_WIDTH - chatWidth >= 10
}

// ---- auto chat-only (narrow/mobile terminals) -----------------------------

/**
 * Column ceiling for the auto chat-only view (docs/config.md "autoChatOnly"):
 * at or below this width the terminal pane would be unusable, so the chat-only
 * view turns on by default (the pane is hidden and the chat spans the full
 * width). A phone with a small font reports ~70-90 columns (the pixel aspect
 * ratio is NOT a reliable signal: a monospace cell is ~twice as tall as wide, so
 * a portrait phone is often wider than tall in cells), so the ceiling has to sit
 * above that — while the common wide desktop window (120+) stays untouched. An
 * 80-column desktop terminal therefore also auto-switches; `Alt+Home` overrides
 * it for the session and `autoChatOnly: false` disables it entirely.
 */
export const AUTO_CHAT_ONLY_MAX_COLS = 90

/** Should a terminal of this width start in the chat-only view? */
export function shouldAutoChatOnly(width: number): boolean {
  return width <= AUTO_CHAT_ONLY_MAX_COLS
}

/**
 * Cell size of the terminal pane given terminal dimensions and layout.
 *
 * The sidebar keeps its full width; the terminal pane is its full rounded
 * border (2 columns) plus the draggable gap between the two cards, plus (in
 * `"sidebar"` layout) the vertical tab rail's columns.
 *
 * `opts.railWidth` (default 0) is the vertical rail's width; `opts.topBar`
 * (default true) says whether the horizontal tab-bar row exists. In
 * `"sidebar"` layout the rail replaces the top bar, so the pane gains one row
 * (`topBar: false`) while losing `railWidth` columns. Called with no options it
 * produces exactly the historical `"topbar"` result.
 */
export function computePaneCells(
  width: number,
  height: number,
  sidebarWidth: number,
  opts?: { railWidth?: number; topBar?: boolean },
): { cols: number; rows: number } {
  const railWidth = opts?.railWidth ?? 0
  const topBar = opts?.topBar ?? true
  const termBoxWidth = Math.max(width - sidebarWidth - railWidth - PANE_DIVIDER_WIDTH, 0)
  const cols = termBoxWidth - 2 // border
  const rows = height - (topBar ? 1 : 0) /* tab bar */ - 1 /* status bar */ - 2 /* border */
  return { cols: Math.max(cols, 1), rows: Math.max(rows, 1) }
}
