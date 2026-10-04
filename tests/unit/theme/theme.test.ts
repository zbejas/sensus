import { beforeEach, describe, expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  defaultBackgroundColor,
  matchThemeName,
  setTerminalMode,
  setTerminalPalette,
  setTheme,
  theme,
  themeKind,
  themesOfKind,
  THEME_NAMES,
} from "../../../src/theme/theme.ts"
import { contrastRatio, MUTED_MIN_CONTRAST, parseHexColor } from "../../../src/theme/themePalette.ts"

/** Real gruvbox-dark ANSI 0-15 (soft hues a user's terminal might ship). */
const GRUVBOX: Array<string | null> = [
  "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
  "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
]

/** Neutral adaptive tokens (muted/bar/borders) are PALETTE INDICES. */
const slotOf = (c: unknown): number => {
  const rgba = c as RGBA
  expect(rgba.intent).toBe("indexed")
  return rgba.slot
}

const reset = (): void => {
  setTerminalPalette(null)
  setTerminalMode(null)
  setTheme(DEFAULT_THEME)
}

beforeEach(reset)

describe("theme palette derivation (adaptive tokens)", () => {
  test("tokens resolve per detection state: none, detected palette, empty palette, mode-only", () => {
    const setups: Array<{ name: string; setup: () => void; check: () => void }> = [
      {
        name: "no palette detected → indexed accents (standard pick) + fixed RGB fallbacks",
        setup: () => {},
        check: () => {
          const t = theme()
          expect(t.fg).toBe("#d4d4d4")
          // accents are INDICES — the terminal's own scheme colors, not constants
          expect(slotOf(t.accent)).toBe(12)
          expect(slotOf(t.danger)).toBe(9)
          expect(slotOf(t.muted)).toBe(8)
          expect(slotOf(t.barFg)).toBe(7)
          expect(slotOf(t.border)).toBe(8)
          expect(slotOf(t.borderFocused)).toBe(7)
          expect(t.cardBg).toBe("#262626")
        },
      },
      {
        name: "detected palette drives softened RGB accents + index neutrals; bg-null contract preserved",
        setup: () =>
          setTerminalPalette({ palette: GRUVBOX, defaultForeground: "#ebdbb2", defaultBackground: "#282828" }),
        check: () => {
          const t = theme()
          expect(t.fg).toBe("#ebdbb2") // the shell's own text color
          // neutrals stay host-resolved INDICES: muted 8, barFg 7, quiet
          // border 8, focused border 7
          expect(slotOf(t.muted)).toBe(8)
          expect(slotOf(t.barFg)).toBe(7)
          expect(slotOf(t.borderFocused)).toBe(7)
          expect(slotOf(t.border)).toBe(8)
          // chromatic accents SOFTEN to desaturated RGB (not raw bright ANSI)
          for (const c of [t.accent, t.danger, t.success, t.warning, t.toast]) {
            expect(String(c)).toMatch(/^#[0-9a-f]{6}$/)
          }
          expect(t.accent).not.toBe("#83a598") // not the terminal's raw accent
          // onAccent stays an RGB contrast pick (hex)
          expect(t.onAccent).toBe("#282828")
          expect(t.cardBg).toBe("#3f3d39")
          expect(t.selectionBg).toBe("#534f46")
          expect(t.onSelection).toBe("#ebdbb2")
          // bg-ish tokens stay null → the terminal background still shows through
          expect(t.bg).toBeNull()
          expect(t.barBg).toBeNull()
          expect(t.scrollbar).toBeNull()
        },
      },
      {
        name: "answered defaults without palette entries → accents soften from the xterm snapshot",
        setup: () =>
          setTerminalPalette({ palette: [], defaultForeground: "#dddddd", defaultBackground: "#000000" }),
        check: () => {
          const t = theme()
          expect(t.fg).toBe("#dddddd")
          expect(String(t.accent)).toMatch(/^#[0-9a-f]{6}$/)
          expect(String(t.danger)).toMatch(/^#[0-9a-f]{6}$/)
        },
      },
      {
        name: "mode-only fallback (no palette) still works",
        setup: () => setTerminalMode("light"),
        check: () => {
          expect(theme().fg).toBe("#24292e")
        },
      },
    ]
    for (const s of setups) {
      reset() // each fixture row starts from a clean detection state
      s.setup()
      s.check()
    }
  })

  test("non-adaptive themes are untouched by palette signals; module state resets after the suite", () => {
    setTerminalPalette({ palette: GRUVBOX, defaultForeground: "#ebdbb2", defaultBackground: "#282828" })
    setTheme("nord")
    const t = theme()
    expect(t.fg).toBe("#d8dee9")
    expect(t.accent).toBe("#88c0d0")
    expect(t.bg).toBe("#2e3440")

    // Parallel-file hygiene: the reset lands the module back on the adaptive
    // default (bun runs test files in one process).
    reset()
    const fresh = theme()
    expect(fresh.fg).toBe("#d4d4d4")
    expect(slotOf(fresh.accent)).toBe(12)
  })
})

describe("defaultBackgroundColor (reverse-video swap source)", () => {
  test("precedence ladder: detected OSC 11 bg → theme bg → mode constant", () => {
    // 1. A detected default background wins outright.
    setTerminalPalette({ palette: [], defaultForeground: "#dddddd", defaultBackground: "#282828" })
    expect(defaultBackgroundColor()).toBe("#282828")

    // 2. Detection WITHOUT a defaultBackground entry falls through — adaptive
    //    theme, no mode detected → dark constant.
    setTerminalPalette({ palette: GRUVBOX, defaultForeground: "#ebdbb2", defaultBackground: null })
    expect(defaultBackgroundColor()).toBe("#000000")

    // 3. No detection: a non-adaptive theme contributes its own bg token.
    setTheme("nord")
    expect(defaultBackgroundColor()).toBe("#2e3440")

    // 4. No detection + adaptive theme: the mode constant (dark default, light honored).
    reset()
    expect(defaultBackgroundColor()).toBe("#000000")
    setTerminalMode("light")
    expect(defaultBackgroundColor()).toBe("#ffffff")

    // Hygiene: the suite leaves the module at the dark default.
    reset()
    expect(defaultBackgroundColor()).toBe("#000000")
  })
})

describe("built-in theme registry (docs/DESIGN.md 'Built-in themes')", () => {
  test("THEME_NAMES and BUILTIN_THEMES list the same themes; each row names itself", () => {
    expect(Object.keys(BUILTIN_THEMES).sort()).toEqual([...THEME_NAMES].sort())
    expect(THEME_NAMES[0]).toBe("terminal")
    expect(DEFAULT_THEME).toBe("terminal")
    for (const name of THEME_NAMES) {
      const row = BUILTIN_THEMES[name]
      expect(row.name).toBe(name)
      expect(row.displayName.length).toBeGreaterThan(0)
    }
  })

  test("every non-adaptive theme fills the concrete tokens ResolvedTheme assumes", () => {
    const missing: string[] = []
    for (const name of THEME_NAMES) {
      if (name === "terminal") continue
      const row = BUILTIN_THEMES[name]
      const tokens = {
        bg: row.bg,
        fg: row.fg,
        muted: row.muted,
        border: row.border,
        borderFocused: row.borderFocused,
        cardBg: row.cardBg,
        selectionBg: row.selectionBg,
        onSelection: row.onSelection,
        barBg: row.barBg,
        barFg: row.barFg,
        accent: row.accent,
        danger: row.danger,
        success: row.success,
        warning: row.warning,
        toast: row.toast,
      }
      for (const [key, value] of Object.entries(tokens)) {
        if (value === null || value === undefined) missing.push(`${name}.${key}`)
      }
      // Hex tokens must be parseable colors, not typos.
      for (const [key, value] of Object.entries(tokens)) {
        if (typeof value === "string" && !/^#[0-9a-f]{6}$/i.test(value)) {
          missing.push(`${name}.${key}=${value}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test("themeKind partitions the registry; matchThemeName resolves exact/unique input only", () => {
    const partitioned = [...themesOfKind("dark"), ...themesOfKind("light"), ...themesOfKind("adaptive")]
    expect(partitioned.sort()).toEqual([...THEME_NAMES].sort())

    expect(themeKind("terminal")).toBe("adaptive")
    expect(themeKind("github-dark")).toBe("dark")
    expect(themeKind("github-light")).toBe("light")

    expect(matchThemeName("dracula")).toBe("dracula")
    expect(matchThemeName("DRAC")).toBe("dracula") // unique prefix, case-insensitive
    expect(matchThemeName("catppuccin-latte")).toBe("catppuccin-latte")
    expect(matchThemeName("a")).toBeNull() // ambiguous
    expect(matchThemeName("zzz")).toBeNull()
  })
})

describe("resolved secondary text stays readable (docs/DESIGN.md contrast)", () => {
  test("every non-adaptive theme's muted meets the WCAG floor against its own bg", () => {
    for (const name of THEME_NAMES) {
      if (name === "terminal") continue
      setTheme(name)
      const t = theme()
      const bg = typeof t.bg === "string" ? parseHexColor(t.bg) : null
      const muted = typeof t.muted === "string" ? parseHexColor(t.muted) : null
      expect(bg, `${name} bg`).not.toBeNull()
      expect(muted, `${name} muted`).not.toBeNull()
      expect(contrastRatio(muted!, bg!), `${name} muted/${t.bg}`).toBeGreaterThanOrEqual(
        MUTED_MIN_CONTRAST,
      )
    }
    reset()
  })
})
