/**
 * Pane palette / default derivation (src/ui/lib/paneTheme.ts): the pure bodies
 * App pushes to every live session. Config override wins over the theme tokens;
 * `paneColors: "index"` disables the SGR rewrite.
 */

import { describe, expect, test } from "bun:test"
import { paneColorConfig, paneDefaultColors, panePaletteFor } from "../../../../src/ui/lib/paneTheme.ts"

const fullPalette = (hex: string | null): { palette: (string | null)[]; defaultForeground: null; defaultBackground: null } => ({
  palette: Array<string | null>(256).fill(hex),
  defaultForeground: null,
  defaultBackground: null,
})

describe("paneColorConfig", () => {
  test("defaults to exact + bold-bright; explicit fields win", () => {
    expect(paneColorConfig(null)).toEqual({ mode: "exact", boldBright: true })
    expect(paneColorConfig(undefined)).toEqual({ mode: "exact", boldBright: true })
    expect(paneColorConfig({})).toEqual({ mode: "exact", boldBright: true })
    expect(paneColorConfig({ paneColors: "index" })).toEqual({ mode: "index", boldBright: true })
    expect(paneColorConfig({ boldBright: false })).toEqual({ mode: "exact", boldBright: false })
    expect(paneColorConfig({ paneColors: "index", boldBright: false })).toEqual({ mode: "index", boldBright: false })
  })
})

describe("paneDefaultColors", () => {
  test("config override wins over theme tokens", () => {
    expect(
      paneDefaultColors({ foreground: "#ff0000", background: "#00ff00" }, { fg: "#111111", bg: "#222222" }, "#333333"),
    ).toEqual({ fg: [255, 0, 0], bg: [0, 255, 0] })
  })

  test("theme tokens are used when there is no override; adaptive bg falls back", () => {
    expect(paneDefaultColors(null, { fg: "#111111", bg: "#222222" }, "#333333")).toEqual({
      fg: [0x11, 0x11, 0x11],
      bg: [0x22, 0x22, 0x22],
    })
    // Adaptive theme: bg = null → the terminal's detected background.
    expect(paneDefaultColors(undefined, { fg: "#111111", bg: null }, "#abcdef")).toEqual({
      fg: [0x11, 0x11, 0x11],
      bg: [0xab, 0xcd, 0xef],
    })
  })

  test("unparseable inputs yield null channels", () => {
    expect(paneDefaultColors(null, { fg: null, bg: "not-a-color" }, "also-not")).toEqual({ fg: null, bg: null })
  })
})

describe("panePaletteFor", () => {
  test("exact mode builds the palette from the merged colors", () => {
    const p = panePaletteFor(null, fullPalette("#123456"))
    expect(p).not.toBeNull()
    expect(p?.[0]).toEqual([0x12, 0x34, 0x56])
    expect(p?.[255]).toEqual([0x12, 0x34, 0x56])
  })

  test("index mode disables the rewrite (null) regardless of the merged palette", () => {
    expect(panePaletteFor({ paneColors: "index" }, fullPalette("#123456"))).toBeNull()
  })

  test("nothing answered → null", () => {
    expect(panePaletteFor(null, null)).toBeNull()
    expect(panePaletteFor(null, fullPalette(null))).toBeNull()
  })
})
