/**
 * Theme runtime (docs/DESIGN.md "Color and theme", docs/config.md "theme").
 *
 * This module owns the REACTIVE theme state, adaptive resolution for the
 * `terminal` theme, and the style-prop helpers. The token contract
 * (`ThemeTokens`) and the shipped theme data live in `./themes.ts`; everything
 * public there is re-exported here so components keep importing one module.
 *
 * Token contract:
 * - bg-ish tokens (bg, barBg, cardBg, selectionBg, scrollbar): `null` means
 *   "omit the style entirely" → opentui paints nothing → the user's terminal
 *   background shows through. This is what makes the default "terminal" theme
 *   blend into any palette (the owner's #1 complaint: forced black boxes).
 * - border `null` → omit borderColor (opentui then emits no SGR on borders).
 * - fg-ish tokens (fg, muted, barFg): `null` on a theme definition means
 *   "adaptive" — resolved from the terminal's detected light/dark mode
 *   (renderer OSC 10/11 detection). The NEUTRAL tokens (muted, barFg, border,
 *   borderFocused) resolve to PALETTE INDICES (`RGBA.fromIndex` → SGR
 *   38;5;N): the HOST terminal applies its active palette at paint time. The
 *   CHROMATIC accents (accent, danger, success, warning, toast) also use
 *   palette INDICES as the fallback, but when the terminal answered OSC 10/11
 *   they are derived as desaturated, mid-lightness RGB (`softenAccent`) so
 *   chrome is not painted in full-saturation bright ANSI while keeping the
 *   terminal's hue family. `fg` and the overlay blends (cardBg/selectionBg)
 *   are RGB-derived too (OSC 10/11 answers — truthful in all terminals).
 *   The constants below are only the fallback for terminals that never answer.
 *   OpenTUI always emits an explicit fg (omitted fg renders forced white), so
 *   "inherit" is approximated, not literal; `null` bg IS literal inheritance.
 *
 * Reactivity: the active theme + terminal mode live in module signals so
 * /theme, the settings screen and config reload apply LIVE without restart.
 * A plain module signal needs no Solid root; components subscribe by calling
 * theme() inside their JSX.
 */

import { createSignal, type Accessor } from "solid-js"
import { RGBA } from "@opentui/core"
import {
  deriveAdaptivePalette,
  deriveIndexedAccents,
  readableMutedHex,
  type PaletteColors,
} from "./themePalette.ts"
import { BUILTIN_THEMES, DEFAULT_THEME } from "./themes.ts"
import type { ThemeColor, ThemeName, ThemeTokens } from "./themes.ts"

// Re-export the definitions module's public surface so `src/ui/` and config
// keep a single import home for theme concepts.
export {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  isThemeName,
  matchThemeName,
  resolveTheme,
  themeKind,
  themesOfKind,
  THEME_NAMES,
} from "./themes.ts"
export type { ThemeColor, ThemeKind, ThemeName, ThemeTokens } from "./themes.ts"

/** Stable string identity of a ThemeColor (cache keys — RGBA stringifies as
 * "[object Object]"). */
export function colorKey(c: ThemeColor): string {
  if (typeof c === "string") return c
  return c.intent === "indexed" ? `idx:${c.slot}` : `rgb:${c.toInts().join(",")}`
}

/** Neutral palettes used when the terminal never answers the OSC palette
 * queries (fallback; a detected palette overrides these — see
 * src/theme/themePalette.ts). */
const ADAPTIVE_DARK = { fg: "#d4d4d4", muted: "#8b949e", barFg: "#c9c9c9" }
const ADAPTIVE_LIGHT = { fg: "#24292e", muted: "#6a737d", barFg: "#3a3a3a" }

/**
 * Overlay panel colors for the adaptive theme. Full-screen overlays (settings,
 * model catalog) MUST paint an opaque panel — with a transparent bg the text
 * underneath bleeds through the dialog and it is unreadable. The panel color
 * is a mode-appropriate neutral: a floating dialog over the user's terminal,
 * not chrome (the main UI stays background-free).
 */
const ADAPTIVE_OVERLAY = {
  dark: { cardBg: "#262626", selectionBg: "#3b3b3b", onSelection: "#f0f0f0" },
  light: { cardBg: "#f2f2f2", selectionBg: "#d7e0e8", onSelection: "#1b1f23" },
}

export type TerminalMode = "dark" | "light" | null

// ---- reactive state (module-level; safe before any Solid root) ------------

const [themeSignal, setThemeSignal] = createSignal<ThemeTokens>(BUILTIN_THEMES[DEFAULT_THEME])
const [modeSignal, setModeSignal] = createSignal<TerminalMode>(null)
const [paletteSignal, setPaletteSignal] = createSignal<PaletteColors | null>(null)

/** Switch the active theme (UI-applies live). Persistence is the caller's job. */
export function setTheme(name: ThemeName): void {
  setThemeSignal(BUILTIN_THEMES[name])
}

/** Feed the terminal light/dark detection (renderer.waitForThemeMode). */
export function setTerminalMode(mode: TerminalMode): void {
  setModeSignal(mode)
}

/**
 * Feed the terminal's OSC 4/10/11 palette detection (App boot + renderer
 * "palette" events). null = unsupported / absent → the adaptive theme keeps
 * its fixed fallback constants.
 */
export function setTerminalPalette(colors: PaletteColors | null): void {
  setPaletteSignal(colors)
}

/** The raw palette detection (null = not detected / unsupported). */
export const terminalPalette: Accessor<PaletteColors | null> = paletteSignal

/** Theme tokens after adaptive resolution: text-ish colors are concrete;
 * bg-ish tokens may still be null (= "omit the style entirely"). */
export type ResolvedTheme = ThemeTokens & {
  fg: string
  muted: ThemeColor
  barFg: ThemeColor
  border: ThemeColor
  borderFocused: ThemeColor
}

/** Build an indexed paint color (host-terminal palette resolution). */
function indexed(index: number): RGBA {
  return RGBA.fromIndex(index)
}

/** Per-palette derivation cache: the App pushes the same object identity
 * until a new palette event arrives, so derivation runs once per palette,
 * not once per theme() read. */
let lastPalette: PaletteColors | null = null
let lastLight: boolean | null = null
let lastDerived: ReturnType<typeof deriveAdaptivePalette> = null

function derivedFor(
  palette: PaletteColors | null,
  light: boolean,
): ReturnType<typeof deriveAdaptivePalette> {
  if (palette !== lastPalette || light !== lastLight) {
    lastPalette = palette
    lastLight = light
    lastDerived = deriveAdaptivePalette(palette, light)
  }
  return lastDerived
}

// Non-adaptive themes ship published palettes whose `muted` is often only
// ~2-3:1 on their own `bg`; raise it to the readable floor once per theme object
// (identity-cached, like the adaptive derivation).
let lastStaticTheme: ThemeTokens | null = null
let lastStaticResolved: ResolvedTheme | null = null

function resolveStatic(t: ThemeTokens): ResolvedTheme {
  if (t === lastStaticTheme && lastStaticResolved !== null) return lastStaticResolved
  const bg = typeof t.bg === "string" ? t.bg : null
  const muted =
    bg !== null && typeof t.muted === "string" ? readableMutedHex(t.muted, bg) : t.muted
  lastStaticTheme = t
  lastStaticResolved = { ...t, muted } as ResolvedTheme
  return lastStaticResolved
}

function resolveAdaptive(t: ThemeTokens, mode: TerminalMode): ResolvedTheme {
  const light = mode === "light"
  if (t.name !== "terminal") {
    // Non-adaptive themes carry concrete values already (muted contrast-fixed).
    return resolveStatic(t)
  }
  // Neutral structure + accent INDICES live in deriveIndexedAccents: the host
  // terminal resolves those at paint time. The chromatic accents are only the
  // FALLBACK when the terminal did not answer OSC 10/11 (no soft derivation is
  // possible); when it did, `deriveAdaptivePalette` returns desaturated,
  // mid-lightness hex accents so chrome is not full-saturation bright ANSI.
  const accents = deriveIndexedAccents(paletteSignal(), light)
  const derived = derivedFor(paletteSignal(), light)
  const adaptive = light ? ADAPTIVE_LIGHT : ADAPTIVE_DARK
  const overlay = light ? ADAPTIVE_OVERLAY.light : ADAPTIVE_OVERLAY.dark
  return {
    ...t,
    fg: derived?.fg ?? t.fg ?? adaptive.fg,
    muted: indexed(accents.muted),
    barFg: indexed(accents.barFg),
    accent: derived ? derived.accent : indexed(accents.accent),
    onAccent: derived?.onAccent ?? t.onAccent,
    // Structure is NEUTRAL: the unfocused border is the quiet grey and the
    // focused one a slightly stronger grey, so a focused pane never floods a
    // whole rounded box in the accent. Focus reads through the accent-colored
    // TITLE (components set `titleColor`), which keeps the accent where it
    // carries meaning. A concrete value is required — omitted style keys do
    // not reset a previously painted color when the theme switches live
    // (opentui applies only the keys present in the new style object).
    border: indexed(accents.border),
    borderFocused: indexed(accents.borderFocused),
    danger: derived ? derived.danger : indexed(accents.danger),
    success: derived ? derived.success : indexed(accents.success),
    warning: derived ? derived.warning : indexed(accents.warning),
    toast: derived ? derived.warning : indexed(accents.warning),
    cardBg: derived?.cardBg ?? overlay.cardBg,
    selectionBg: derived?.selectionBg ?? overlay.selectionBg,
    onSelection: derived?.onSelection ?? overlay.onSelection,
  }
}

/**
 * Effective tokens for rendering: adaptive fg/muted/barFg resolved from the
 * detected terminal mode (dark fallback when the terminal never answered the
 * OSC query). bg-ish tokens keep their null = "omit" contract.
 *
 * A plain derived accessor (NOT createMemo): bun resolves `solid-js` to the
 * non-reactive server build under `bun test` (the app swaps in the reactive
 * build via the @opentui/solid preload), where memos evaluate ONCE and go
 * stale — a plain getter reads the live signals on every call, so it is
 * reactive in the app AND correct in tests. The palette derivation is cached
 * by palette-object identity so per-call cost stays an object spread.
 */
export const theme: Accessor<ResolvedTheme> = () => resolveAdaptive(themeSignal(), modeSignal())

/**
 * Concrete default background color for the CURRENT detection state: the
 * terminal's OSC 11 answer → the active theme's bg token → dark/light
 * constant by detected mode. The adaptive theme's bg is null ("inherit"),
 * but reverse video needs a REAL color to swap into the glyph — a swap
 * cannot inherit. Safe to read inside a memo:
 * it tracks the palette/theme/mode signals.
 */
export function defaultBackgroundColor(): string {
  const detected = terminalPalette()?.defaultBackground
  if (detected) return detected
  const bg = theme().bg
  if (bg) return bg
  return modeSignal() === "light" ? "#ffffff" : "#000000"
}

// ---- style-prop helpers ----------------------------------------------------
// opentui style props treat `null` as "unset → default", so null tokens must
// be OMITTED, not passed. These helpers keep the conditional-spread noise out
// of the components (and keep TS narrowing honest).

/** Box `backgroundColor` prop for a nullable bg token. null → explicit
 * "transparent" (must SET the property: omitted keys don't reset a
 * previously painted color on live theme switches). */
export function bgProps(bg: string | null): { backgroundColor: string } {
  return { backgroundColor: bg ?? "transparent" }
}

/** Box `borderColor` prop for a nullable border token. */
export function borderProps(border: ThemeColor | null): { borderColor: ThemeColor } {
  return { borderColor: border ?? "transparent" }
}

/** Text `bg` prop for a nullable bg token. */
export function textBgProps(bg: string | null): { bg: string } {
  return { bg: bg ?? "transparent" }
}
