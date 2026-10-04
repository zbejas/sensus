import { describe, expect, test } from "bun:test"
import { overlayRowStyle, overlayMetrics, OVERLAY_HEIGHT_RATIO, OVERLAY_WIDTH_RATIO } from "../../../../src/ui/components/overlayKit.tsx"
import { BUILTIN_THEMES, type ResolvedTheme } from "../../../../src/theme/theme.ts"

// BUILTIN_THEMES rows are ThemeTokens (nullable fg/muted); the helper only
// reads concrete tokens, so the cast keeps the test free of theme plumbing.
const withSelection = BUILTIN_THEMES.dark as unknown as ResolvedTheme
const withoutSelection = BUILTIN_THEMES.terminal as unknown as ResolvedTheme

describe("overlayRowStyle (a row never keeps a stale background)", () => {
  test("EVERY branch sets an explicit bg — selection is arrow-only (transparent)", () => {
    const selected = overlayRowStyle(withSelection, true, withSelection.fg)
    // The "items stay selected when I move down" fix: selection adds no fill,
    // so the arrow + accent fg carry it and no background can leak.
    expect(selected.bg).toBe("transparent")
    expect(selected.fg).toBe(withSelection.accent)

    const unselected = overlayRowStyle(withSelection, false, withSelection.fg)
    expect(unselected.bg).toBe("transparent")
    expect(unselected.fg).toBe(withSelection.fg)
  })

  test("hover paints the selectionBg fill; leaving hover returns to transparent", () => {
    const hovered = overlayRowStyle(withSelection, false, withSelection.fg, true)
    expect(hovered.bg).toBe(withSelection.selectionBg)
    expect(hovered.fg).toBe(withSelection.onSelection)
  })

  test("hover still returns a bg when the theme has no selectionBg (accent fallback)", () => {
    const hovered = overlayRowStyle(withoutSelection, false, withoutSelection.fg, true)
    expect(hovered.bg).toBe("transparent")
    expect(hovered.fg).toBe(withoutSelection.accent)
  })

  test("selected wins over hovered: no double highlight on the active row", () => {
    const both = overlayRowStyle(withSelection, true, withSelection.fg, true)
    expect(both.bg).toBe("transparent")
    expect(both.fg).toBe(withSelection.accent)
  })
})

describe("overlayMetrics (bounded-large modal card)", () => {
  test("the card fills the width/height ratios on a normal terminal", () => {
    const m = overlayMetrics({ width: 200, height: 50 })
    expect(m.width).toBe(Math.floor(200 * OVERLAY_WIDTH_RATIO))
    expect(m.height).toBe(Math.floor(50 * OVERLAY_HEIGHT_RATIO))
    // Inside-the-border budget is the card minus its two border cells.
    expect(m.innerWidth).toBe(m.width - 2)
    expect(m.innerHeight).toBe(m.height - 2)
  })

  test("never grows past the terminal minus a 1-cell frame (narrow/short)", () => {
    const m = overlayMetrics({ width: 22, height: 6 })
    expect(m.width).toBeLessThanOrEqual(20)
    expect(m.height).toBeLessThanOrEqual(4)
    expect(m.innerWidth).toBeGreaterThanOrEqual(1)
    expect(m.innerHeight).toBeGreaterThanOrEqual(1)
  })

  test("floors stay drawable at the 20x5 minimum", () => {
    const m = overlayMetrics({ width: 20, height: 5 })
    expect(m.width).toBeGreaterThanOrEqual(8)
    expect(m.height).toBeGreaterThanOrEqual(3)
  })
})
