import { describe, expect, test } from "bun:test"
import { theme, type ResolvedTheme } from "../../../../src/theme/theme.ts"
import {
  CODE_DOUBLE_CLICK_MS,
  PRESS_HOLD_MS,
  bgStyle,
  codeClickAction,
  pickColor,
  rowFx,
  spanAttrs,
} from "../../../../src/ui/chat/chatRowStyle.ts"

/** A theme with a concrete selection fill (the hover-highlight branch). */
const withSelection = (): ResolvedTheme => ({ ...theme(), selectionBg: "#3b3b3b", onSelection: "#f0f0f0" })
/** The adaptive `terminal` theme leaves the selection fill null. */
const noSelection = (): ResolvedTheme => ({ ...theme(), selectionBg: null, onSelection: null })

describe("pickColor / spanAttrs", () => {
  test("style flags map to the theme tokens", () => {
    const t = theme()
    expect(pickColor({ error: true }, t)).toBe(t.danger)
    expect(pickColor({ accent: true }, t)).toBe(t.accent)
    expect(pickColor({ code: true }, t)).toBe(t.accent)
    expect(pickColor({ heading: true }, t)).toBe(t.accent)
    expect(pickColor({ link: true }, t)).toBe(t.accent)
    expect(pickColor({ dim: true }, t)).toBe(t.muted)
    expect(pickColor({}, t)).toBe(t.fg)
    // error wins over every other flag.
    expect(pickColor({ error: true, dim: true, code: true }, t)).toBe(t.danger)
  })

  test("spanAttrs carries bold/italic/underline and paints dim as a color, not SGR-faint", () => {
    const t = theme()
    const heading = spanAttrs({ heading: true }, t)
    expect(heading.bold).toBe(true)
    expect(heading.italic).toBe(false)
    expect(spanAttrs({ italic: true }, t).italic).toBe(true)
    expect(spanAttrs({ link: true }, t).underline).toBe(true)
    expect(spanAttrs({ underline: true }, t).underline).toBe(true)
    // dim sets `false` so a prior SGR-faint paint is reset.
    expect(spanAttrs({ dim: true }, t).dim).toBe(false)
    expect(spanAttrs({ dim: true }, t).fg).toBe(t.muted)
  })
})

describe("rowFx", () => {
  test("idle paints the base surface and overrides no fg", () => {
    const t = theme()
    expect(rowFx(t, "idle", null)).toEqual({ bg: "transparent", fg: null })
    expect(rowFx(t, "idle", "#202020")).toEqual({ bg: "#202020", fg: null })
  })

  test("press flashes the accent block", () => {
    const t = theme()
    expect(rowFx(t, "press", "#202020")).toEqual({ bg: t.accent, fg: t.onAccent })
  })

  test("hover uses the selection fill when the theme has one", () => {
    const t = withSelection()
    expect(rowFx(t, "hover", "#202020")).toEqual({ bg: "#3b3b3b", fg: "#f0f0f0" })
    // onSelection null → falls back to fg.
    const noOn = { ...t, onSelection: null }
    expect(rowFx(noOn, "hover", null)).toEqual({ bg: "#3b3b3b", fg: noOn.fg })
  })

  test("hover without a selection fill falls back to the card surface + accent fg", () => {
    const t = noSelection()
    expect(rowFx(t, "hover", "#101010")).toEqual({ bg: "#101010", fg: t.accent })
    expect(rowFx(t, "hover", null)).toEqual({ bg: "transparent", fg: t.accent })
  })

  test("PRESS_HOLD_MS keeps the flash visible", () => {
    expect(PRESS_HOLD_MS).toBeGreaterThan(0)
  })
})

describe("codeClickAction", () => {
  test("the first click pastes; a second click on the same line within the window runs", () => {
    const first = codeClickAction(null, "ls -la", 1000)
    expect(first.action).toBe("paste")
    const second = codeClickAction(first.next, "ls -la", 1000 + CODE_DOUBLE_CLICK_MS)
    expect(second.action).toBe("run")
    // The run consumes the tracker, so a third click pastes again.
    expect(second.next).toBeNull()
    expect(codeClickAction(second.next, "ls -la", 2000).action).toBe("paste")
  })

  test("a different line or a slow second click starts a fresh paste", () => {
    const first = codeClickAction(null, "ls", 1000)
    expect(codeClickAction(first.next, "pwd", 1100).action).toBe("paste")
    expect(codeClickAction(first.next, "ls", 1000 + CODE_DOUBLE_CLICK_MS + 1).action).toBe("paste")
    // A backwards clock never reads as a double click.
    expect(codeClickAction(first.next, "ls", 0).action).toBe("paste")
  })
})

describe("bgStyle", () => {
  test("null bg becomes an explicit transparent (style reset invariant)", () => {
    const t = theme()
    expect(bgStyle({ ...t, bg: null })).toEqual({ bg: "transparent" })
    expect(bgStyle({ ...t, bg: "#000000" })).toEqual({ bg: "#000000" })
  })
})
