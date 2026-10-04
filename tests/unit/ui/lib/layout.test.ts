import { describe, expect, test } from "bun:test"
import {
  canUseSidebarLayout,
  clampSidebarWidth,
  clampSidebarWidthInLayout,
  clampTabRailWidth,
  computePaneCells,
  isTooSmall,
  MIN_COLS,
  MIN_ROWS,
  PANE_DIVIDER_WIDTH,
  shouldAutoChatOnly,
  sidebarWidthForDrag,
  SIDEBAR_MIN,
  TAB_RAIL_DEFAULT_WIDTH,
  TAB_RAIL_MAX_WIDTH,
  TAB_RAIL_MIN_WIDTH,
  tooSmallMessage,
  AUTO_CHAT_ONLY_MAX_COLS,
} from "../../../../src/ui/lib/layout.ts"

describe("clampSidebarWidth", () => {
  test("keeps a width inside [min, half the terminal]", () => {
    // At 200 columns half is 100: 60 is already valid.
    expect(clampSidebarWidth(60, 200)).toBe(60)
    expect(clampSidebarWidth(72, 200)).toBe(72)
  })

  test("clamps below the minimum and above half the terminal", () => {
    expect(clampSidebarWidth(5, 200)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(10_000, 200)).toBe(100)
  })

  test("on a narrow terminal the minimum wins over half the width", () => {
    // 40 columns would mean max 20, but the sidebar never drops below the min.
    expect(clampSidebarWidth(80, 40)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(10, 40)).toBe(SIDEBAR_MIN)
  })

  test("rounds a fractional drag width", () => {
    expect(clampSidebarWidth(60.4, 200)).toBe(60)
    expect(clampSidebarWidth(60.6, 200)).toBe(61)
  })
})

describe("clampSidebarWidthInLayout (sidebar mode reserves the rail)", () => {
  test("caps the chat + rail pair at half the terminal", () => {
    // At 200 cols with a 25-column rail footprint (24 + divider), the chat may
    // claim at most 100 - 25 = 75 columns, so the pane keeps at least half.
    expect(clampSidebarWidthInLayout(50, 200, 25)).toBe(50)
    expect(clampSidebarWidthInLayout(100, 200, 25)).toBe(75)
    expect(clampSidebarWidthInLayout(1_000, 200, 25)).toBe(75)
  })

  test("without a rail it matches the plain half-terminal clamp", () => {
    expect(clampSidebarWidthInLayout(60, 200, 0)).toBe(60)
    expect(clampSidebarWidthInLayout(1_000, 200, 0)).toBe(100)
  })

  test("the minimum wins on a narrow terminal even with a large rail", () => {
    // A third-of-terminal rail footprint on 60 cols: half (30) minus 20 is 10,
    // below the 30 floor, so the sidebar stays at SIDEBAR_MIN.
    expect(clampSidebarWidthInLayout(60, 60, 20)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidthInLayout(10, 60, 20)).toBe(SIDEBAR_MIN)
  })

  test("rounds a fractional width", () => {
    expect(clampSidebarWidthInLayout(50.4, 200, 25)).toBe(50)
    expect(clampSidebarWidthInLayout(50.6, 200, 25)).toBe(51)
  })
})

describe("sidebarWidthForDrag", () => {
  test("dragging the divider right widens the terminal (narrows the sidebar)", () => {
    expect(sidebarWidthForDrag(139, 60, 149)).toBe(50)
  })

  test("dragging left widens the sidebar", () => {
    expect(sidebarWidthForDrag(139, 60, 129)).toBe(70)
  })

  test("no movement keeps the width", () => {
    expect(sidebarWidthForDrag(139, 60, 139)).toBe(60)
  })
})

describe("clampTabRailWidth (layout: sidebar vertical rail)", () => {
  test("keeps a width inside [min, min(max, third of the terminal)]", () => {
    expect(TAB_RAIL_DEFAULT_WIDTH).toBe(24)
    expect(TAB_RAIL_MIN_WIDTH).toBe(16)
    expect(TAB_RAIL_MAX_WIDTH).toBe(60)
    // At 200 cols the third is 66, so the 60 max wins: 24 is untouched.
    expect(clampTabRailWidth(24, 200)).toBe(24)
    expect(clampTabRailWidth(60, 200)).toBe(60)
  })

  test("clamps below the minimum and above the maximum", () => {
    expect(clampTabRailWidth(5, 200)).toBe(TAB_RAIL_MIN_WIDTH)
    expect(clampTabRailWidth(1000, 200)).toBe(TAB_RAIL_MAX_WIDTH)
  })

  test("never exceeds a third of the terminal", () => {
    // 60 cols → third 20, so both 30 and 60 settle at 20.
    expect(clampTabRailWidth(30, 60)).toBe(20)
    expect(clampTabRailWidth(60, 60)).toBe(20)
  })

  test("on a narrow terminal the minimum wins over the third", () => {
    // A third of 40 is 13, still below the 16-cell floor.
    expect(clampTabRailWidth(10, 40)).toBe(TAB_RAIL_MIN_WIDTH)
    expect(clampTabRailWidth(100, 40)).toBe(TAB_RAIL_MIN_WIDTH)
  })

  test("rounds a fractional drag width", () => {
    expect(clampTabRailWidth(24.4, 200)).toBe(24)
    expect(clampTabRailWidth(24.6, 200)).toBe(25)
  })
})

describe("canUseSidebarLayout (App falls back to topbar when false)", () => {
  test("true when the pane keeps at least 10 usable columns", () => {
    expect(canUseSidebarLayout(200, 24, 60)).toBe(true)
    expect(canUseSidebarLayout(100, 24, 60)).toBe(true)
    // Exactly 10 usable columns: 10 + 24 rail + 1 divider + 60 chat = 95.
    expect(canUseSidebarLayout(95, 24, 60)).toBe(true)
  })

  test("false when the rail would starve the terminal pane", () => {
    expect(canUseSidebarLayout(90, 24, 60)).toBe(false)
    expect(canUseSidebarLayout(94, 24, 60)).toBe(false)
    expect(canUseSidebarLayout(20, 16, 30)).toBe(false)
  })
})

describe("computePaneCells (topbar default vs sidebar rail)", () => {
  test("the default 3-argument call is exactly the historical topbar result", () => {
    // 200 - 60 sidebar - 1 divider = 139 box; -2 border = 137 cols.
    // 50 - 1 tabbar - 1 statusbar - 2 border = 46 rows.
    expect(computePaneCells(200, 50, 60)).toEqual({ cols: 137, rows: 46 })
    // Same shape at another size: 120 - 40 - 1 - 2 = 77; 30 - 4 = 26.
    expect(computePaneCells(120, 30, 40)).toEqual({ cols: 77, rows: 26 })
  })

  test("explicit defaults { railWidth: 0, topBar: true } match the default call", () => {
    expect(computePaneCells(200, 50, 60, {})).toEqual(computePaneCells(200, 50, 60))
    expect(computePaneCells(200, 50, 60, { railWidth: 0, topBar: true })).toEqual(
      computePaneCells(200, 50, 60),
    )
  })

  test("railWidth subtracts exactly the rail columns; topBar:false gains one row", () => {
    const base = computePaneCells(200, 50, 60)
    const rail = computePaneCells(200, 50, 60, { railWidth: 24 })
    expect(rail.cols).toBe(base.cols - 24)
    expect(rail.rows).toBe(base.rows)
    const noTop = computePaneCells(200, 50, 60, { topBar: false })
    expect(noTop.cols).toBe(base.cols)
    expect(noTop.rows).toBe(base.rows + 1)
    // The sidebar layout uses both: rail columns and no top tab-bar row.
    const side = computePaneCells(200, 50, 60, { railWidth: 24, topBar: false })
    expect(side).toEqual({ cols: 113, rows: 47 })
  })

  test("never returns a non-positive cell count (degenerate terminals clamp at 1)", () => {
    expect(computePaneCells(1, 1, 0)).toEqual({ cols: 1, rows: 1 })
    expect(computePaneCells(10, 3, 30, { railWidth: 40 })).toEqual({ cols: 1, rows: 1 })
    expect(computePaneCells(200, 50, 60, { topBar: false })).toEqual({
      cols: 137,
      rows: 47,
    })
  })

  test("PANE_DIVIDER_WIDTH is the one shared separator column", () => {
    // cols = width - sidebar - rail - divider - 2 border.
    const { cols } = computePaneCells(200, 50, 60, { railWidth: 24 })
    expect(cols).toBe(200 - 60 - 24 - PANE_DIVIDER_WIDTH - 2)
  })
})

/**
 * The App-level layout decision: App.tsx mirrors this pure chain over
 * `store.layoutMode` / `store.tabRailWidth` / `store.sidebarWidth` and
 * `dims()`. Proving the helpers cohere together (rail clamp → chat clamp →
 * fallback guard → pane math) is the App-level guarantee; the individual
 * helpers are covered above.
 */
function appLayoutDecision(
  termWidth: number,
  termHeight: number,
  mode: "topbar" | "sidebar",
  storedChatWidth: number,
  storedRailWidth: number,
): { sidebar: boolean; chatWidth: number; cells: { cols: number; rows: number } } {
  const railWidth = clampTabRailWidth(storedRailWidth, termWidth)
  const railFootprint = railWidth + PANE_DIVIDER_WIDTH
  // App reserves the rail's footprint when clamping the chat in sidebar mode,
  // so chat + rail together stay within half the terminal.
  const layoutChatWidth = clampSidebarWidthInLayout(storedChatWidth, termWidth, railFootprint)
  const sidebar =
    mode === "sidebar" &&
    !isTooSmall(termWidth, termHeight) &&
    canUseSidebarLayout(termWidth, railFootprint, layoutChatWidth)
  const chatWidth = sidebar ? layoutChatWidth : storedChatWidth
  const cells = computePaneCells(termWidth, termHeight, chatWidth, {
    railWidth: sidebar ? railFootprint : 0,
    topBar: !sidebar,
  })
  return { sidebar, chatWidth, cells }
}

describe("shouldAutoChatOnly (narrow/mobile terminals start in chat-only)", () => {
  test("the ceiling sits above a small-font phone but below wide desktop windows", () => {
    expect(AUTO_CHAT_ONLY_MAX_COLS).toBe(90)
    expect(shouldAutoChatOnly(AUTO_CHAT_ONLY_MAX_COLS)).toBe(true)
    expect(shouldAutoChatOnly(AUTO_CHAT_ONLY_MAX_COLS + 1)).toBe(false)
  })

  test("a phone-sized terminal auto-switches; a wide desktop window does not", () => {
    // A phone terminal is ~70-90 columns depending on the font (cell aspect
    // distorts the pixel aspect, so width — not a 9:19 pixel ratio — is the
    // signal); a wide desktop window is 120+.
    expect(shouldAutoChatOnly(84)).toBe(true)
    expect(shouldAutoChatOnly(57)).toBe(true)
    expect(shouldAutoChatOnly(40)).toBe(true)
    expect(shouldAutoChatOnly(80)).toBe(true)
    expect(shouldAutoChatOnly(120)).toBe(false)
    expect(shouldAutoChatOnly(200)).toBe(false)
    expect(shouldAutoChatOnly(0)).toBe(true)
  })
})

describe("App-level layout decision (rail clamp + chat clamp + fallback + pane cells)", () => {
  test("sidebar mode with room shows the rail and drops the top-bar row", () => {
    const d = appLayoutDecision(200, 50, "sidebar", 60, 24)
    expect(d.sidebar).toBe(true)
    expect(d.chatWidth).toBe(60)
    // 200 - 60 chat - 25 rail footprint (24 + gap) - 1 chat divider - 2 border
    // = 112; 50 - 1 status - 2 border = 47.
    expect(d.cells).toEqual({ cols: 112, rows: 47 })
  })

  test("sidebar mode clamps an over-wide chat/rail so the pane is never starved", () => {
    // Chat configured at 200 and rail at 200 on a 200-col terminal: the rail
    // caps at 60 (footprint 61), and the chat then caps so chat + rail fit in
    // half the terminal — 100 - 61 = 39 — so the pane is never starved.
    const d = appLayoutDecision(200, 50, "sidebar", 200, 200)
    expect(d.sidebar).toBe(true)
    expect(d.chatWidth).toBe(39)
    // 200 - 39 chat - 61 rail footprint - 1 chat divider - 2 border = 97 usable
    // cols (the pane keeps roughly half the terminal, the whole point of the
    // layout guard).
    expect(d.cells.cols).toBe(97)
    expect(d.cells).toEqual({ cols: 97, rows: 47 })
  })

  test("sidebar mode falls back to topbar when the rail would starve the pane", () => {
    // 60 cols: rail clamps to a third (20) and chat to the 30 min, so the pane
    // would keep only 9 box columns — below the 10 floor.
    const d = appLayoutDecision(60, 50, "sidebar", 60, 24)
    expect(d.sidebar).toBe(false)
    // Topbar fallback: no rail, the configured chat width, the tab-bar row back.
    expect(d.chatWidth).toBe(60)
    expect(d.cells).toEqual(computePaneCells(60, 50, 60, { railWidth: 0, topBar: true }))
    expect(d.cells.rows).toBe(46) // 50 - 1 tabbar - 1 status - 2 border
  })

  test("topbar mode ignores the rail width and always keeps the top bar", () => {
    const d = appLayoutDecision(200, 50, "topbar", 60, 24)
    expect(d.sidebar).toBe(false)
    expect(d.chatWidth).toBe(60)
    expect(d.cells).toEqual(computePaneCells(200, 50, 60))
    expect(d.cells.rows).toBe(46)
  })
})

describe("isTooSmall / tooSmallMessage (the guard that hides the layout and overlays)", () => {
  test("the minimum is 20x5; exactly at the minimum is fine, anything below is too small", () => {
    expect(MIN_COLS).toBe(20)
    expect(MIN_ROWS).toBe(5)
    expect(isTooSmall(MIN_COLS, MIN_ROWS)).toBe(false)
    expect(isTooSmall(200, 50)).toBe(false)
    expect(isTooSmall(MIN_COLS - 1, MIN_ROWS)).toBe(true)
    expect(isTooSmall(MIN_COLS, MIN_ROWS - 1)).toBe(true)
    expect(isTooSmall(0, 0)).toBe(true)
  })

  test("the notice names the current size and the required minimum", () => {
    const message = tooSmallMessage(10, 3)
    expect(message).toContain("10x3")
    expect(message).toContain("20x5")
  })
})
