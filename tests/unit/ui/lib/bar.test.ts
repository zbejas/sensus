import { describe, expect, test } from "bun:test"
import {
  barFlex,
  barHitId,
  barSpanStyle,
  fitBarParts,
  joinBarParts,
  layoutBar,
  partText,
  resolveBarParts,
  type BarPart,
} from "../../../../src/ui/lib/bar.ts"
import { theme } from "../../../../src/theme/theme.ts"

const clickable = (id: string, text: string): BarPart => ({ id, spans: [{ text, tone: "value" }], onClick: () => {} })
const inert = (id: string, text: string): BarPart => ({ id, spans: [{ text, tone: "label" }] })

describe("bar layout + hit mapping", () => {
  test("regions cover each part in order and map a column back to its clickable id", () => {
    // A tab bar shape: two tabs, the `│` separator, the elastic pad, the button.
    const parts = [
      clickable("t1", "1:a"),
      inert("tab-sep", " │ "),
      clickable("t2", "2:b"),
      barFlex(),
      clickable("menu", " commands"),
    ]
    const resolved = resolveBarParts(parts, 30)
    // used = 3 + 3 + 3 + 0 + 9 = 18, so the elastic part pads with 12 spaces.
    const layout = layoutBar(resolved)
    expect(layout.text).toBe("1:a │ 2:b" + " ".repeat(12) + " commands")
    expect(layout.text.length).toBe(30)

    expect(partText(resolved[0]!)).toBe("1:a")
    expect(barHitId(resolved, 0)).toBe("t1")
    expect(barHitId(resolved, 4)).toBeNull() // the separator is inert
    expect(barHitId(resolved, 7)).toBe("t2")
    expect(barHitId(resolved, 15)).toBeNull() // the elastic pad is inert
    expect(barHitId(resolved, 25)).toBe("menu")
    expect(barHitId(resolved, 30)).toBeNull() // past the row
  })

  test("the elastic pad fills the width and grows as content shrinks (no stale cells)", () => {
    const wide = resolveBarParts([clickable("t1", "1:very-long-title"), barFlex(), clickable("menu", "m")], 40)
    const narrow = resolveBarParts([clickable("t1", "1:x"), barFlex(), clickable("menu", "m")], 40)
    expect(layoutBar(wide).text.length).toBe(40)
    expect(layoutBar(narrow).text.length).toBe(40)
    // The pad absorbs the difference: the shorter row carries more spaces.
    expect(partText(narrow[1]!).length).toBeGreaterThan(partText(wide[1]!).length)
  })

  test("the pad never collapses to zero (groups keep a cell between them when overflowing)", () => {
    const out = resolveBarParts([clickable("t1", "1:abcdefghij"), barFlex(), clickable("t2", "zz")], 4)
    expect(partText(out[1]!)).toBe(" ")
    expect(layoutBar(out).text).toContain("1:abcdefghij zz")
  })

  test("joinBarParts intersperses an inert separator that is never clickable", () => {
    const joined = joinBarParts([clickable("a", "A"), clickable("b", "B")], " · ")
    expect(layoutBar(joined).text).toBe("A · B")
    expect(barHitId(joined, 2)).toBeNull() // the separator
    expect(barHitId(joined, 0)).toBe("a")
  })

  test("a part with no handler is inert even though it owns a region", () => {
    expect(barHitId([inert("x", "label")], 1)).toBeNull()
  })
})

describe("bar overflow fit (fitBarParts)", () => {
  const sep = (): BarPart => ({ id: "sep", spans: [{ text: " · ", tone: "label" }], separator: true })
  const labeled = (id: string, label: string, value: string): BarPart => ({
    id,
    spans: [
      { text: label, tone: "label" },
      { text: " ", tone: "label" },
      { text: value, tone: "value" },
    ],
  })
  /** The rendered width of the resolved row (what a terminal cell would show). */
  const rowWidth = (parts: readonly BarPart[], innerWidth: number): number =>
    layoutBar(resolveBarParts(parts, innerWidth)).text.length

  test("leaves the row untouched when it already fits", () => {
    const parts = [labeled("cwd", "cwd:", "~/dev"), barFlex(), inert("menu", "commands")]
    const fitted = fitBarParts(parts, 40, [{ ids: ["cwd"], mode: "truncate", span: 2, min: 4 }])
    expect(partText(fitted[0]!)).toBe("cwd: ~/dev")
    expect(fitted.map((p) => p.id)).toEqual(["cwd", "__bar-flex", "menu"])
    expect(rowWidth(fitted, 40)).toBe(40)
  })

  test("truncates a long value with an ellipsis to the computed budget, keeping the label and the right chip", () => {
    // cwd (34-char path) + model (24-char id) is far wider than the row; cwd
    // must shrink to its floor, the model (an agent affordance) must not.
    const parts: BarPart[] = [
      labeled("cwd", "cwd:", "/home/user/projects/sensus/src/ui/chat"),
      barFlex(),
      { id: "model", spans: [{ text: "openrouter@", tone: "label" }, { text: "very-long-model-id-here", tone: "value" }] },
    ]
    // budget 43 forces the cwd value down to its 4-code-point floor:
    // 5 (label) + 4 + 34 (model) = 43.
    const fitted = fitBarParts(parts, 44, [{ ids: ["cwd"], mode: "truncate", span: 2, min: 4 }])
    const cwd = fitted.find((p) => p.id === "cwd")!
    expect(partText(cwd).startsWith("cwd: ")).toBe(true)
    expect(partText(cwd).endsWith("…")).toBe(true)
    // min 4 code points: 3 path chars + the ellipsis.
    expect([...partText(cwd).slice(5)].length).toBe(4)
    // The model chip is untouched (its span text is still the full id).
    expect(partText(fitted.find((p) => p.id === "model")!)).toBe("openrouter@very-long-model-id-here")
    expect(rowWidth(fitted, 44)).toBe(44)
  })

  test("drops low-priority chips in plan order before touching the important affordances", () => {
    const parts = [
      clickable("mcp", "mcp:2"),
      sep(),
      clickable("no-tools", "no-tools"),
      sep(),
      clickable("agent", "agent:copilot"),
      barFlex(),
      clickable("menu", "commands"),
    ]
    const plan = [
      { ids: ["mcp"], mode: "drop" as const },
      { ids: ["no-tools"], mode: "drop" as const },
      { ids: ["agent"], mode: "drop" as const },
    ]
    // used = 6+3+8+3+13+0+8 = 41. budget 30 → drop mcp and no-tools only.
    const fitted = fitBarParts(parts, 31, plan)
    const ids = fitted.map((p) => p.id)
    expect(ids).not.toContain("mcp")
    expect(ids).not.toContain("no-tools")
    expect(ids).toContain("agent")
    expect(ids).toContain("menu")
    expect(rowWidth(fitted, 31)).toBe(31)
  })

  test("drops a middle chip without leaving a dangling or doubled separator", () => {
    const parts = [clickable("a", "AAAA"), sep(), clickable("b", "BBBB"), sep(), clickable("c", "CCCC"), barFlex()]
    // used = 4+3+4+3+4 = 18; budget 14 forces the drop, and the surviving
    // separator sits between the two remaining chips.
    const fitted = fitBarParts(parts, 15, [{ ids: ["b"], mode: "drop" }])
    expect(layoutBar(resolveBarParts(fitted, 15)).text).toBe("AAAA · CCCC".padEnd(15))
    expect(fitted.filter((p) => p.separator === true).length).toBe(1)
  })

  test("truncates several parts evenly so a shared title budget does not starve one", () => {
    const parts = [
      labeled("tab:1", "1:", "a-very-long-title-one"),
      sep(),
      labeled("tab:2", "2:", "a-very-long-title-two"),
      barFlex(),
      clickable("menu", "commands"),
    ]
    // Plan truncates both titles to a shared floor; used = 2+22 +3+ 2+22 +0+ 8 = 59.
    const fitted = fitBarParts(parts, 40, [{ ids: ["tab:1", "tab:2"], mode: "truncate", span: 2, min: 2 }])
    const t1 = partText(fitted.find((p) => p.id === "tab:1")!)
    const t2 = partText(fitted.find((p) => p.id === "tab:2")!)
    expect(rowWidth(fitted, 40)).toBe(40)
    // Balanced: both titles end with an ellipsis, neither falls to the floor
    // while the other stays long.
    expect(t1.endsWith("…")).toBe(true)
    expect(t2.endsWith("…")).toBe(true)
    expect(Math.abs([...t1].length - [...t2].length)).toBeLessThanOrEqual(1)
    expect(partText(fitted.find((p) => p.id === "menu")!)).toBe("commands")
  })

  test("a plan that cannot free enough space still returns a safe, ordered row", () => {
    const parts = [
      clickable("a", "AAAAAAAAAA"),
      sep(),
      clickable("b", "BBBBBBBBBB"),
      sep(),
      clickable("c", "CCCCCCCCCC"),
      barFlex(),
    ]
    const fitted = fitBarParts(parts, 5, [{ ids: ["a"], mode: "drop" }, { ids: ["b"], mode: "drop" }])
    // Never throws; the remaining parts keep their order and the pad still
    // renders a full-width row (overflow is the terminal's clip, not a crash).
    expect(fitted.map((p) => p.id)).toEqual(["c", "__bar-flex"])
    expect(resolveBarParts(fitted, 20).find((p) => p.id === "__bar-flex")).toBeDefined()
  })

  test("joinBarParts marks injected separators for orphan cleanup", () => {
    const joined = joinBarParts([clickable("a", "A"), clickable("b", "B")], " · ")
    expect(joined[1]?.separator).toBe(true)
    // The separator between them stays put when nothing is dropped.
    expect(fitBarParts(joined, 20, [])[1]?.separator).toBe(true)
  })
})

describe("bar span paint", () => {
  const t = theme()

  test("idle paints the tone token with a transparent bg (every branch sets bg)", () => {
    const idle = barSpanStyle(t, { text: "!", tone: "warning" }, "idle")
    expect(idle.fg).toBe(t.warning)
    expect(idle.bg).toBe("transparent")
    expect(idle.bold).toBe(false)
  })

  test("hover paints the theme selection fill; press flashes the accent block", () => {
    const fill = t.selectionBg
    expect(fill).not.toBeNull()
    const hover = barSpanStyle(t, { text: "agent:x", tone: "value" }, "hover")
    expect(hover.bg).toBe(fill as string)
    expect(hover.fg).toBe(t.onSelection ?? t.fg)

    const press = barSpanStyle(t, { text: "agent:x", tone: "value" }, "press")
    expect(press.bg).toBe(t.accent)
    expect(press.fg).toBe(t.onAccent)
    expect(press.bold).toBe(true)
  })

  test("hover falls back to the accent fg when a theme has no selection fill", () => {
    const noFill = { ...t, selectionBg: null }
    const hover = barSpanStyle(noFill, { text: "x", tone: "value" }, "hover")
    expect(hover.bg).toBe("transparent")
    expect(hover.fg).toBe(noFill.accent)
  })

  test("a bold span keeps bold through hover", () => {
    expect(barSpanStyle(t, { text: "confirm", tone: "warning", bold: true }, "hover").bold).toBe(true)
  })
})
