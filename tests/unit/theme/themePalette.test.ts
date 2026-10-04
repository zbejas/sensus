import { describe, expect, test } from "bun:test"
import {
  contrastRatio,
  deriveAdaptivePalette,
  deriveIndexedAccents,
  isKonsoleDefaultPalette,
  isPaletteAnswered,
  KONSOLE_DEFAULT_PALETTE,
  mergePaletteOverride,
  MUTED_MIN_CONTRAST,
  PALETTE_RETRY_DELAYS_MS,
  parseHexColor,
  paletteStatusSummary,
  readableMuted,
  readableMutedHex,
  type PaletteColors,
} from "../../../src/theme/themePalette.ts"

const colors = (
  palette: Array<string | null>,
  defaultForeground: string | null,
  defaultBackground: string | null,
): PaletteColors => ({ palette, defaultForeground, defaultBackground })

/** Real gruvbox-dark ANSI 0-15 (typical dark palette, soft/muted hues). */
const GRUVBOX = [
  "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
  "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
]

/** Konsole's compiled-in ANSI table (the "lying" OSC-4 answer). */
const KONSOLE_LIE = colors(
  [
    "#000000", "#b21818", "#18b218", "#b26818", "#1818b2", "#b218b2", "#18b2b2", "#b2b2b2",
    "#686868", "#ff5454", "#54ff54", "#ffff54", "#5454ff", "#ff54ff", "#54ffff", "#ffffff",
  ],
  "#d8dee9",
  "#2e3440",
)

describe("parseHexColor", () => {
  test("parses the formats terminals answer OSC with; everything else → null", () => {
    const cases: Array<[string | null, { r: number; g: number; b: number } | null]> = [
      ["#102030", { r: 0x10, g: 0x20, b: 0x30 }],
      ["#0af", { r: 0, g: 0xaa, b: 0xff }],
      // rgb:R/G/B with 1-4 digits per channel, scaled like xterm; case-insensitive.
      ["rgb:ffff/0000/8080", { r: 255, g: 0, b: 128 }],
      ["rgb:ff/00/80", { r: 255, g: 0, b: 128 }],
      ["RGB:FF/00/80", { r: 255, g: 0, b: 128 }],
      // 12-digit #rrrrggggbbbb scales 16-bit.
      ["#ffffffff0000", { r: 255, g: 255, b: 0 }],
      [null, null],
      ["", null],
      ["#12345", null],
      ["red", null],
    ]
    for (const [input, expected] of cases) {
      expect(parseHexColor(input)).toEqual(expected)
    }
  })
})

describe("deriveIndexedAccents (palette INDICES for the host terminal to resolve)", () => {
  test("bright-vs-normal picks follow the palette flavor (dark, light, or no detection)", () => {
    const cases: Array<{
      name: string
      colors: PaletteColors | null
      light: boolean
      expect: Partial<
        Record<
          "muted" | "barFg" | "border" | "borderFocused" | "accent" | "danger" | "success" | "warning",
          number
        >
      >
    }> = [
      {
        name: "dark gruvbox: bright entries win the contrast picks, borders are neutral",
        colors: colors(GRUVBOX, "#ebdbb2", "#282828"),
        light: false,
        expect: {
          muted: 8,
          barFg: 7,
          border: 8,
          borderFocused: 7,
          accent: 12,
          danger: 9,
          success: 10,
          warning: 11,
        },
      },
      {
        name: "light palette: normal variants beat bright ones, darker grey is the strong border",
        colors: colors(
          [
            "#ffffff", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#cccccc",
            "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
          ],
          "#24292e",
          "#ffffff",
        ),
        light: true,
        expect: { border: 7, borderFocused: 8, accent: 4, danger: 1, success: 2, warning: 3 },
      },
      {
        name: "no detection at all: standard xterm math picks the reference",
        colors: null,
        light: false,
        expect: { muted: 8, barFg: 7, border: 8, borderFocused: 7, accent: 12, danger: 9 },
      },
    ]
    for (const c of cases) {
      const a = deriveIndexedAccents(c.colors, c.light)
      for (const [token, index] of Object.entries(c.expect)) {
        expect(a[token as keyof typeof a]).toBe(index)
      }
    }
  })

  test("a LYING OSC-4 answer (Konsole built-ins) still yields valid blue/red/green/yellow indices", () => {
    // The pick may differ from the truth, but it is always A blue/red/green/
    // yellow index — the host terminal resolves it with the real scheme
    // (documented in docs/config.md: detection costs at most a
    // bright-vs-normal shade, never a wrong hue).
    const a = deriveIndexedAccents(KONSOLE_LIE, false)
    expect([4, 12]).toContain(a.accent)
    expect([1, 9]).toContain(a.danger)
    expect([2, 10]).toContain(a.success)
    expect([3, 11]).toContain(a.warning)
  })
})

describe("deriveAdaptivePalette (RGB tokens: fg, overlays, softened accents)", () => {
  test("fg from OSC 11, overlay blends toward fg (exact math), on-tokens pick the better contrast", () => {
    const d = deriveAdaptivePalette(colors(GRUVBOX, "#ebdbb2", "#282828"))
    expect(d).not.toBeNull()
    expect(d?.fg).toBe("#ebdbb2")
    // r: 40 + (235-40)*0.12 = 63.4 → 63 = 0x3f; g: 61.5 → 0x3d; b: 56.6 → 0x39
    expect(d?.cardBg).toBe("#3f3d39")
    // 0.22 blend: r 82.9 → 0x53; g 79.4 → 0x4f; b 70.4 → 0x46
    expect(d?.selectionBg).toBe("#534f46")
    // fg is far brighter than bg → on the mid-lightness accent the DARK bg wins;
    // onSelection is close to fg → fg reads better on it.
    expect(d?.onAccent).toBe("#282828")
    expect(d?.onSelection).toBe("#ebdbb2")

    // Chromatic accents soften to hex: desaturated, mid-lightness, and still
    // readable on the terminal background (hue family preserved).
    const bg = parseHexColor("#282828")!
    for (const c of [d!.accent, d!.danger, d!.success, d!.warning]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrastRatio(parseHexColor(c)!, bg)).toBeGreaterThanOrEqual(4.5)
    }
    expect(d!.accent).not.toBe("#83a598") // never the raw bright ANSI entry

    // A light terminal normalizes the other way (dark mid-lightness accents).
    const light = colors(
      [
        "#ffffff", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#cccccc",
        "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
      ],
      "#24292e",
      "#ffffff",
    )
    const dl = deriveAdaptivePalette(light, true)
    expect(dl?.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(contrastRatio(parseHexColor(dl!.accent)!, parseHexColor("#ffffff")!)).toBeGreaterThanOrEqual(4.5)

    // Black/white extremes of the overlay blend: mix(bg=0, fg=255, 0.12) = 31,
    // mix 0.22 = 56.
    const extreme = deriveAdaptivePalette(colors(GRUVBOX, "#ffffff", "#000000"))
    expect(extreme?.cardBg).toBe("#1f1f1f")
    expect(extreme?.selectionBg).toBe("#383838")

    // The WCAG ratio behind the picks: black/white ≈ 21, identical ≈ 1.
    expect(contrastRatio(parseHexColor("#000000")!, parseHexColor("#ffffff")!)).toBeCloseTo(21, 0)
    expect(contrastRatio(parseHexColor("#000000")!, parseHexColor("#000000")!)).toBeCloseTo(1, 5)
  })

  test("degenerate detections: no/garbage defaults → null; answered defaults + empty palette still derive", () => {
    // OSC 10/11 unsupported or garbage → null (theme keeps its fallback constants).
    expect(deriveAdaptivePalette(colors(GRUVBOX, null, null))).toBeNull()
    expect(deriveAdaptivePalette(colors(GRUVBOX, "garbage", "#000000"))).toBeNull()
    expect(deriveAdaptivePalette(null)).toBeNull()

    // Defaults answered but palette entries missing → fg/overlays derive;
    // onAccent falls back to standard-xterm snapshot math.
    const d = deriveAdaptivePalette(colors([], "#dddddd", "#000000"))
    expect(d?.fg).toBe("#dddddd")
    // mix(bg, fg, 0.12): 221*0.12 = 26.52 → 27 = 0x1b
    expect(d?.cardBg).toBe("#1b1b1b")
    expect(d?.onAccent).not.toBeNull()
  })
})

describe("readableMuted (secondary-text contrast floor)", () => {
  test("raises a low-contrast muted to the WCAG floor while preserving its hue tint", () => {
    const bg = parseHexColor("#282a36")! // dracula
    const muted = parseHexColor("#6272a4")!
    expect(contrastRatio(muted, bg)).toBeLessThan(MUTED_MIN_CONTRAST)
    const fixed = readableMuted(muted, bg)
    expect(contrastRatio(fixed, bg)).toBeGreaterThanOrEqual(MUTED_MIN_CONTRAST)
    // Hue family preserved (still the same blue-ish tint), not a grey/white.
    expect(fixed.b).toBeGreaterThan(fixed.r)

    // Already-readable colors pass through; unparseable hex passes through too.
    const readable = readableMuted(parseHexColor("#8b949e")!, bg)
    expect(readable).toEqual(parseHexColor("#8b949e")!)
    expect(readableMutedHex("#8b949e", "#0d1117")).toBe("#8b949e")
    expect(readableMutedHex("nope", "#0d1117")).toBe("nope")

    // A light background darkens instead of lightens.
    const lightBg = parseHexColor("#fdf6e3")!
    const lightMuted = readableMuted(parseHexColor("#93a1a1")!, lightBg)
    expect(contrastRatio(lightMuted, lightBg)).toBeGreaterThanOrEqual(MUTED_MIN_CONTRAST)
    expect(lightMuted.r).toBeLessThan(0x93)
  })
})

describe("mergePaletteOverride (config themePalette)", () => {
  test("config wins per field/entry; everything else passes through; extends a null detection", () => {
    const c = colors(GRUVBOX, "#ebdbb2", "#282828")
    const perEntry = mergePaletteOverride(c, { palette: [null, "#ff0000", null] })
    expect(perEntry?.palette[0]).toBe(GRUVBOX[0]) // untouched
    expect(perEntry?.palette[1]).toBe("#ff0000") // overridden
    expect(perEntry?.palette[2]).toBe(GRUVBOX[2])
    expect(perEntry?.defaultForeground).toBe("#ebdbb2")

    // fg/bg override the OSC 10/11 answers (each side independently).
    const both = mergePaletteOverride(c, { foreground: "#abcdef", background: "#123456" })
    expect(both?.defaultForeground).toBe("#abcdef")
    expect(both?.defaultBackground).toBe("#123456")
    const onlyFg = mergePaletteOverride(c, { foreground: "#abcdef" })
    expect(onlyFg?.defaultForeground).toBe("#abcdef")
    expect(onlyFg?.defaultBackground).toBe("#282828")

    // An override over NO detection yields a usable palette.
    const extended = mergePaletteOverride(null, { palette: ["#000000", null, "#00ff00"] })
    expect(extended?.palette).toHaveLength(3)
    expect(extended?.palette[0]).toBe("#000000")
    expect(extended?.palette[1]).toBeNull()
    expect(extended?.defaultForeground).toBeNull()
  })

  test("no override keeps the detected identity; invalid override colors are dropped", () => {
    const c = colors(GRUVBOX, "#ebdbb2", "#282828")
    // Identity preserved (the theme derivation caches by object identity).
    expect(mergePaletteOverride(c, null)).toBe(c)
    expect(mergePaletteOverride(c, undefined)).toBe(c)
    expect(mergePaletteOverride(c, {})).toBe(c)
    expect(mergePaletteOverride(null, { foreground: "#fff" })).not.toBeNull()

    // Unparseable entries fall back to detection instead of poisoning the palette.
    const m = mergePaletteOverride(c, { palette: ["nope", "#ff0000"], foreground: "zzz", background: "#123456" })
    expect(m?.palette[0]).toBe(GRUVBOX[0]) // invalid → detected
    expect(m?.palette[1]).toBe("#ff0000")
    expect(m?.defaultForeground).toBe("#ebdbb2") // invalid → detected
    expect(m?.defaultBackground).toBe("#123456")
  })
})

describe("detection state (isPaletteAnswered / retry schedule / status summary)", () => {
  test("answered = any palette entry, fg or bg; retry schedule is ascending, ≥1s, bounded", () => {
    expect(isPaletteAnswered(null)).toBe(false)
    expect(isPaletteAnswered(colors(new Array(16).fill(null), null, null))).toBe(false)
    expect(isPaletteAnswered(colors(new Array(16).fill(null), null, "#000000"))).toBe(true)
    expect(isPaletteAnswered(colors(new Array(16).fill(null), "#ffffff", null))).toBe(true)
    const partial = new Array(16).fill(null)
    partial[4] = "#0000ff"
    expect(isPaletteAnswered(colors(partial, null, null))).toBe(true)

    // The /status retry pacing contract: a handful of ascending delays ≥ 1s.
    expect(PALETTE_RETRY_DELAYS_MS.length).toBeGreaterThan(0)
    expect(PALETTE_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(5)
    let prev = 0
    for (const d of PALETTE_RETRY_DELAYS_MS) {
      expect(d).toBeGreaterThanOrEqual(Math.max(prev, 1000))
      prev = d
    }
  })

  test("summary reports entry/fg/bg state + a 0-15 swatch and probe count; a Konsole table warns", () => {
    const s = paletteStatusSummary(colors([...GRUVBOX], "#ebdbb2", "#282828"), 1)!
    const [head, swatch] = s.split("\n")
    expect(head).toContain("16/16 entries")
    expect(head).toContain("fg #ebdbb2")
    expect(head).toContain("bg #282828")
    expect(swatch).toContain(GRUVBOX[5]!) // answered entries render their hex

    // Konsole reports its compiled-in table, not the active scheme — the
    // summary warns so the pane fallback is explainable (config.md pins it).
    expect(paletteStatusSummary(KONSOLE_LIE, 1)!.includes("⚠")).toBe(true)

    // A non-detection palette origin (the KDE scheme auto-read) is surfaced.
    const withSource = paletteStatusSummary(
      colors([...GRUVBOX], "#ebdbb2", "#282828"),
      1,
      'KDE scheme "Nord"',
    )!
    expect(withSource).toContain('source: KDE scheme "Nord"')

    // Partial detection: unanswered slots render as "?", probe count noted.
    const p = paletteStatusSummary(colors([null, "#ff0000", ...new Array(14).fill(null)], null, null), 3)!
    const [pHead, pSwatch] = p.split("\n")
    expect(pHead).toContain("1/16 entries")
    expect(pHead).toContain("fg ?")
    expect(pHead).toContain("bg ?")
    expect(pHead).toContain("after 3 probes")
    expect(pSwatch?.includes("#ff0000")).toBe(true)
    expect((pSwatch?.match(/\?/g) ?? []).length).toBe(15)

    // No detection at all: the xterm fallback line, with the probe count > 1.
    expect(paletteStatusSummary(null, 1)).toContain("NOT detected")
    expect(paletteStatusSummary(null, 1)).toContain("xterm fallback")
    expect(paletteStatusSummary(null, 4)).toContain("(4 probes)")
  })
})

describe("isKonsoleDefaultPalette (the OSC-4 lie fingerprint)", () => {
  test("matches Konsole's compiled-in table exactly; a real scheme or a pin does not", () => {
    expect(isKonsoleDefaultPalette(colors([...KONSOLE_DEFAULT_PALETTE], "#d8dee9", "#2e3440"))).toBe(true)
    // Case/format-insensitive (parsed RGB comparison).
    expect(isKonsoleDefaultPalette(colors(KONSOLE_DEFAULT_PALETTE.map((c) => c.toUpperCase()), null, null))).toBe(true)
    // A Nord-style scheme (what the user is actually running) is NOT the lie.
    expect(isKonsoleDefaultPalette(colors(GRUVBOX, "#ebdbb2", "#282828"))).toBe(false)
    // Not detected / partial answers are a different problem → false.
    expect(isKonsoleDefaultPalette(null)).toBe(false)
    expect(isKonsoleDefaultPalette(colors(new Array(16).fill(null), "#fff", "#000"))).toBe(false)
    expect(isKonsoleDefaultPalette(colors([...KONSOLE_DEFAULT_PALETTE.slice(0, 15)], null, null))).toBe(false)
  })
})
