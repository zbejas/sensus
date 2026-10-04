import { describe, expect, test } from "bun:test"
import {
  RAIL_ACTIVITY_WIDTH,
  RAIL_CLOSE_AT,
  RAIL_CLOSE_WIDTH,
  RAIL_INDEX_WIDTH,
  RAIL_MARKER_WIDTH,
  railFillerRows,
  railInnerWidth,
  railTabCapacity,
  railTextWidth,
  railTitleBudget,
  tabRailWindow,
} from "../../../../src/ui/lib/tabRail.ts"

describe("railInnerWidth", () => {
  test("subtracts the two border columns and never goes negative", () => {
    expect(railInnerWidth(24)).toBe(22)
    expect(railInnerWidth(17)).toBe(15)
    expect(railInnerWidth(16)).toBe(14)
    // Degenerate widths clamp at 0 rather than going negative.
    expect(railInnerWidth(2)).toBe(0)
    expect(railInnerWidth(1)).toBe(0)
    expect(railInnerWidth(0)).toBe(0)
    expect(railInnerWidth(-5)).toBe(0)
  })

  test("floors a fractional width", () => {
    expect(railInnerWidth(24.9)).toBe(22)
  })

  test("a non-finite width degrades to 0 rather than NaN", () => {
    expect(railInnerWidth(Number.NaN)).toBe(0)
    expect(railInnerWidth(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe("railTabCapacity", () => {
  test("height minus the two border rows and the two pinned action rows", () => {
    expect(railTabCapacity(24)).toBe(20)
    expect(railTabCapacity(10)).toBe(6)
    expect(railTabCapacity(6)).toBe(2)
  })

  test("floors at 1 for a rail too short for any tab", () => {
    expect(railTabCapacity(5)).toBe(1)
    expect(railTabCapacity(4)).toBe(1)
    expect(railTabCapacity(3)).toBe(1)
    expect(railTabCapacity(0)).toBe(1)
    expect(railTabCapacity(-10)).toBe(1)
    expect(railTabCapacity(Number.NaN)).toBe(1)
  })
})

describe("tabRailWindow", () => {
  test("empty list yields an empty window", () => {
    expect(tabRailWindow(0, -1, 5)).toEqual({ start: 0, end: 0 })
    expect(tabRailWindow(0, 3, 5)).toEqual({ start: 0, end: 0 })
  })

  test("when everything fits the whole list is shown regardless of the active tab", () => {
    expect(tabRailWindow(3, 1, 5)).toEqual({ start: 0, end: 3 })
    expect(tabRailWindow(5, 2, 5)).toEqual({ start: 0, end: 5 })
    // capacity >= count is treated as "fits".
    expect(tabRailWindow(2, 0, 10)).toEqual({ start: 0, end: 2 })
  })

  test("slides so the active entry is visible (centred where possible)", () => {
    // capacity 3, active 5 → start 4..6, so 5 is inside the window.
    const win = tabRailWindow(10, 5, 3)
    expect(win).toEqual({ start: 4, end: 7 })
    expect(win.start).toBeLessThanOrEqual(5)
    expect(win.end).toBeGreaterThan(5)
  })

  test("clamps at the start of the list", () => {
    expect(tabRailWindow(10, 0, 3)).toEqual({ start: 0, end: 3 })
    // activeIndex -1 (no active tab) is treated as the first entry.
    expect(tabRailWindow(10, -1, 3)).toEqual({ start: 0, end: 3 })
  })

  test("clamps at the end of the list", () => {
    expect(tabRailWindow(10, 9, 4)).toEqual({ start: 6, end: 10 })
    expect(tabRailWindow(10, 9, 3)).toEqual({ start: 7, end: 10 })
  })

  test("defends against out-of-range activeIndex and capacity", () => {
    // activeIndex past the end clamps to the last entry.
    expect(tabRailWindow(10, 99, 3)).toEqual({ start: 7, end: 10 })
    expect(tabRailWindow(10, -99, 3)).toEqual({ start: 0, end: 3 })
    // capacity <= 0 floors at one visible row.
    expect(tabRailWindow(5, 2, 0)).toEqual({ start: 2, end: 3 })
    expect(tabRailWindow(5, 2, -4)).toEqual({ start: 2, end: 3 })
    // Non-finite inputs degrade to an empty/one-row window, never NaN.
    expect(tabRailWindow(Number.NaN, 0, 3)).toEqual({ start: 0, end: 0 })
    expect(tabRailWindow(5, 0, Number.NaN)).toEqual({ start: 0, end: 1 })
  })

  test("always yields a bounded window that contains the active entry", () => {
    for (let n = 1; n <= 20; n++) {
      for (let cap = 1; cap <= 8; cap++) {
        for (const active of [0, Math.floor((n - 1) / 2), n - 1]) {
          const { start, end } = tabRailWindow(n, active, cap)
          expect(start).toBeGreaterThanOrEqual(0)
          expect(end).toBeLessThanOrEqual(n)
          expect(end - start).toBe(Math.min(n, cap))
          expect(active).toBeGreaterThanOrEqual(start)
          expect(active).toBeLessThan(end)
        }
      }
    }
  })
})

describe("railTitleBudget", () => {
  test("subtracts the fixed chrome, close region and optional activity slot", () => {
    // inner 22: 19 after close; 19 - 2 marker - 2 index = 15 title cells.
    expect(railTitleBudget(22, false)).toBe(15)
    // A busy tab reserves 2 more cells (space + glyph).
    expect(railTitleBudget(22, true)).toBe(13)
    expect(railTitleBudget(22, false) - railTitleBudget(22, true)).toBe(RAIL_ACTIVITY_WIDTH)
  })

  test("the budget plus the fixed chrome never exceeds the inner width", () => {
    for (const inner of [14, 16, 22, 40]) {
      for (const hasActivity of [false, true]) {
        const title = railTitleBudget(inner, hasActivity)
        const used =
          RAIL_MARKER_WIDTH +
          RAIL_INDEX_WIDTH +
          (hasActivity ? RAIL_ACTIVITY_WIDTH : 0) +
          title +
          RAIL_CLOSE_WIDTH
        expect(used).toBeLessThanOrEqual(inner)
      }
    }
  })

  test("never drops below 1 even on a degenerate width", () => {
    expect(railTitleBudget(5, false)).toBe(1)
    expect(railTitleBudget(5, true)).toBe(1)
    expect(railTitleBudget(3, false)).toBe(1)
    expect(railTitleBudget(0, false)).toBe(1)
    expect(railTitleBudget(-10, true)).toBe(1)
    expect(railTitleBudget(Number.NaN, true)).toBe(1)
  })
})

describe("railFillerRows (blank rows that repaint the whole card)", () => {
  test("fills the card below the visible entries", () => {
    expect(railFillerRows(20, 3)).toBe(17)
    expect(railFillerRows(20, 0)).toBe(20)
    expect(railFillerRows(20, 20)).toBe(0)
  })

  test("never negative / non-finite (a full or overflowing window)", () => {
    expect(railFillerRows(3, 5)).toBe(0)
    expect(railFillerRows(0, 0)).toBe(0)
    expect(railFillerRows(-4, 2)).toBe(0)
    expect(railFillerRows(Number.NaN, 1)).toBe(0)
    expect(railFillerRows(10, Number.NaN)).toBe(10)
  })
})

describe("close region geometry", () => {
  test("RAIL_CLOSE_WIDTH is the space × space region", () => {
    expect(RAIL_CLOSE_WIDTH).toBe(3)
    expect(railTextWidth(" × ")).toBe(3)
  })

  test("RAIL_CLOSE_AT returns the right-aligned start, floored at 0", () => {
    expect(RAIL_CLOSE_AT(22)).toBe(19)
    expect(RAIL_CLOSE_AT(3)).toBe(0)
    expect(RAIL_CLOSE_AT(2)).toBe(0)
    expect(RAIL_CLOSE_AT(0)).toBe(0)
    expect(RAIL_CLOSE_AT(Number.NaN)).toBe(0)
  })
})

describe("railTextWidth", () => {
  test("counts code points (emoji/CJK safe) like the bar kit", () => {
    expect(railTextWidth("● ")).toBe(2)
    expect(railTextWidth("12:")).toBe(3)
    expect(railTextWidth("×")).toBe(1)
    expect(railTextWidth("a")).toBe(1)
  })
})
