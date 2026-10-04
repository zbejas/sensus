/**
 * Palette-derived adaptive theme tokens (docs/config.md "theme").
 *
 * The adaptive "terminal" theme used to paint FIXED neutral text colors and
 * 256-cube accent hues, which read brighter / more saturated than the user's
 * own terminal palette (the "sidebar pops next to my shell" complaint).
 *
 * Two complementary derivations:
 *
 * - `deriveIndexedAccents` (always available): picks WHICH palette index each
 *   neutral/accent token uses (accent = blue 12/4, danger = red 9/1, success =
 *   green 10/2, warning = yellow 11/3 — bright vs normal by contrast; muted =
 *   8, barFg/borderFocused/border = the stronger/quieter neutral of grey 7/8
 *   by contrast). The UI paints these via opentui's indexed intent
 *   (`RGBA.fromIndex` → SGR 38;5;N), so the HOST terminal resolves them with
 *   its ACTIVE palette at paint time. Detection quality only influences the
 *   bright-vs-normal pick; even a lying OSC-4 answer (Konsole) costs at most
 *   a bright-vs-normal shade, never a wrong hue.
 * - `deriveAdaptivePalette` (needs OSC 10/11): the tokens that genuinely need
 *   RGB — fg (the terminal's default foreground), overlay panel blends
 *   (cardBg/selectionBg), the on-accent/on-selection contrast picks, and the
 *   SOFTENED chromatic accents (`softenAccent`: saturation-capped, mid
 *   lightness, hue preserved) so chrome is not full-saturation bright ANSI.
 *
 * Unusable input (unsupported terminal, garbage colors) yields null / per-token
 * null so theme.ts keeps its fixed fallback constants. Pure module: the only
 * non-stdlib imports are `rgbToHex` (core/util.ts) and the standard-xterm
 * snapshot math (local `indexedToRgb`, below).
 */

import { rgbToHex } from "../core/util.ts"
import type { ColorMode } from "../core/colorMode.ts"

export interface RGB {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** What App.tsx hands over from opentui's TerminalColors (OSC 4 + 10/11). */
export interface PaletteColors {
  /** ANSI entries 0-15 as `#rrggbb` (lowercase) or null when unanswered. */
  palette: readonly (string | null)[]
  defaultForeground: string | null
  defaultBackground: string | null
}

/**
 * Derived adaptive tokens that genuinely need RGB (OSC 10/11 + blends +
 * softened accents). `fg`/overlays come from the terminal's OSC 10/11 answers;
 * the chromatic accents are the terminal's own ANSI hues with their saturation
 * capped and lightness normalized (`softenAccent`), so chrome is not painted in
 * full-saturation bright ANSI. Terminals that never answer keep the indexed
 * accents (`deriveIndexedAccents`).
 */
export interface DerivedAdaptivePalette {
  fg: string
  onAccent: string | null
  cardBg: string
  selectionBg: string
  onSelection: string | null
  /** Softened accent hues (hex), preserving the terminal's hue family. */
  accent: string
  danger: string
  success: string
  warning: string
}

/**
 * The adaptive theme's accent-ish tokens as PALETTE INDICES. The host terminal
 * resolves them with its active scheme at paint time (no RGB knowledge needed
 * in sensus). `light` only steers the contrast reference when the terminal
 * never answered OSC 11.
 */
export interface IndexedAccents {
  /** Bright black (what "dim" shell text uses). */
  muted: number
  /** White (bar text). */
  barFg: number
  /** Quiet box border (unfocused): the NEUTRAL that recedes into the bg. */
  border: number
  /** Focused box border: a slightly stronger neutral — never a flood of the
   * accent (that is reserved for titles/highlights via `accent`). */
  borderFocused: number
  /** Blue: bright (12) vs normal (4) by contrast. */
  accent: number
  /** Red: bright (9) vs normal (1). */
  danger: number
  /** Green: bright (10) vs normal (2). */
  success: number
  /** Yellow: bright (11) vs normal (3). */
  warning: number
}

// ---- color math -------------------------------------------------------------

/**
 * Parse the color formats terminals actually answer OSC with: `#rgb`,
 * `#rrggbb`, `#rrrrggggbbbb` (16-bit scaled) and `rgb:R/G/B` (1-4 digits per
 * channel, scaled like xterm). Anything else → null (defensive; callers keep
 * their fallback).
 */
export function parseHexColor(hex: string | null | undefined): RGB | null {
  if (typeof hex !== "string") return null
  const s = hex.trim().toLowerCase()
  const scale = (raw: string): number => {
    const val = parseInt(raw, 16)
    if (!Number.isFinite(val)) return 0
    const max = (1 << (4 * raw.length)) - 1
    return max <= 0 ? 0 : Math.round((val / max) * 255)
  }
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) {
    const [r, g, b] = (m[1] ?? "").split("").map((c) => parseInt(c + c, 16))
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0 }
  }
  m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) {
    const h = m[1] ?? ""
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  m = /^#([0-9a-f]{12})$/.exec(s)
  if (m) {
    const h = m[1] ?? ""
    return {
      r: scale(h.slice(0, 4)),
      g: scale(h.slice(4, 8)),
      b: scale(h.slice(8, 12)),
    }
  }
  m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/.exec(s)
  if (m) return { r: scale(m[1] ?? "0"), g: scale(m[2] ?? "0"), b: scale(m[3] ?? "0") }
  return null
}

function toHex(c: RGB): string {
  return rgbToHex(c.r, c.g, c.b)
}

/**
 * Standard xterm 256-color palette: 0-15 named, 16-231 cube, 232-255 grayscale.
 * Local copy (was shared with the removed tmux capture) — used ONLY as the
 * snapshot RGB beside an index to feed contrast picks/fallbacks; never for
 * painting (indices paint as `38;5;N` and the host terminal resolves them).
 */
const BASIC_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // black
  [205, 0, 0], // red
  [0, 205, 0], // green
  [205, 205, 0], // yellow
  [0, 0, 238], // blue
  [205, 0, 205], // magenta
  [0, 205, 205], // cyan
  [229, 229, 229], // white
  [127, 127, 127], // bright black
  [255, 0, 0], // bright red
  [0, 255, 0], // bright green
  [255, 255, 0], // bright yellow
  [92, 92, 255], // bright blue
  [255, 0, 255], // bright magenta
  [0, 255, 255], // bright cyan
  [255, 255, 255], // bright white
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** ANSI index 0-15 → snapshot RGB (standard xterm table). */
function basicColor(index: number): readonly [number, number, number] | null {
  return BASIC_PALETTE[index] ?? null
}

/** Any palette index 0-255 → snapshot RGB (standard xterm math). */
function indexedToRgb(index: number): [number, number, number] {
  if (index < 16) {
    const c = basicColor(index)
    return c ? [c[0], c[1], c[2]] : [0, 0, 0]
  }
  if (index < 232) {
    const i = index - 16
    const r = CUBE_LEVELS[Math.floor(i / 36)] ?? 0
    const g = CUBE_LEVELS[Math.floor((i % 36) / 6)] ?? 0
    const b = CUBE_LEVELS[i % 6] ?? 0
    return [r, g, b]
  }
  if (index <= 255) {
    const v = 8 + 10 * (index - 232)
    return [v, v, v]
  }
  return [0, 0, 0]
}

/** Linearize an 8-bit sRGB channel (WCAG 2.x relative luminance). */
function linearize(v: number): number {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

function luminance(c: RGB): number {
  return (
    0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b)
  )
}

/** WCAG contrast ratio (1..21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb) + 0.05
  const lo = Math.min(la, lb) + 0.05
  return hi / lo
}

/** Linear blend a → b by t (0 = a, 1 = b). */
function mix(a: RGB, b: RGB, t: number): RGB {
  const ch = (x: number, y: number): number => Math.round(x + (y - x) * t)
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b) }
}

/** sRGB → HSL (h degrees [0,360), s/l [0,1]). */
function rgbToHsl(c: RGB): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60
  return { h, s, l }
}

/** HSL → sRGB (inverse of rgbToHsl). */
function hslToRgb(h: number, s: number, l: number): RGB {
  const hp = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hp / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hp < 60) [r, g] = [c, x]
  else if (hp < 120) [r, g] = [x, c]
  else if (hp < 180) [g, b] = [c, x]
  else if (hp < 240) [g, b] = [x, c]
  else if (hp < 300) [r, b] = [x, c]
  else [r, b] = [c, x]
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

/** Max HSL saturation for chrome accents. Raw ANSI hues are often 0.8-1.0. */
const ACCENT_SATURATION_CAP = 0.55
/** Comfortable accent lightness on a dark / light terminal background. */
const ACCENT_LIGHTNESS = { dark: 0.64, light: 0.4 }
/** WCAG contrast the softened accent must reach against the terminal bg. */
const ACCENT_MIN_CONTRAST = 4.5

/**
 * Desaturate + lightness-normalize one ANSI accent so chrome is not painted in
 * full-saturation bright ANSI, while keeping the terminal's HUE family and
 * staying readable on its background. Walks outward from the target lightness
 * until the WCAG contrast floor is met, then falls back to the best contrast.
 */
function softenAccent(rgb: RGB, bg: RGB): RGB {
  const { h, s: rawS } = rgbToHsl(rgb)
  const s = Math.min(rawS, ACCENT_SATURATION_CAP)
  const target = luminance(bg) < 0.5 ? ACCENT_LIGHTNESS.dark : ACCENT_LIGHTNESS.light
  const candidates = [target]
  for (let d = 0.04; d <= 0.42; d += 0.04) candidates.push(target + d, target - d)
  let fallback = hslToRgb(h, s, target)
  let fallbackScore = -1
  for (const l of candidates) {
    if (l < 0.12 || l > 0.9) continue
    const c = hslToRgb(h, s, l)
    const score = contrastRatio(c, bg)
    if (score > fallbackScore) {
      fallback = c
      fallbackScore = score
    }
    if (score >= ACCENT_MIN_CONTRAST) return c
  }
  return fallback
}

/** WCAG contrast floor for secondary (`muted`) text. Reasoning/tool bodies,
 * bar labels and hints all paint `muted`, so it must stay legible — a theme's
 * published "comment grey" is often only ~2-3:1 on its own background. */
export const MUTED_MIN_CONTRAST = 4.5

/** Cap a raised secondary color's saturation so it stays a tint, not an accent. */
const MUTED_SATURATION_CAP = 0.35

/**
 * Nudge a shipped secondary (muted) color toward the readable end of its own
 * hue until it clears the WCAG floor against `bg`, preserving hue (and keeping
 * saturation capped so a brightened grey does not read as a chromatic accent).
 * Idempotent: a color already at or above the floor passes through untouched.
 * Mirrors `softenAccent`'s contrast walk for the neutral token, so every theme's
 * reasoning/tool bodies and bar labels stay readable on its own background.
 */
export function readableMuted(muted: RGB, bg: RGB, minContrast = MUTED_MIN_CONTRAST): RGB {
  if (contrastRatio(muted, bg) >= minContrast) return muted
  const { h, s, l } = rgbToHsl(muted)
  const sat = Math.min(s, MUTED_SATURATION_CAP)
  // Walk away from the background: brighter on a dark bg, darker on a light one.
  const step = luminance(bg) < 0.5 ? 0.03 : -0.03
  let best = hslToRgb(h, sat, l)
  let bestScore = contrastRatio(best, bg)
  for (let cur = l + step; cur >= 0.02 && cur <= 0.99; cur += step) {
    const cand = hslToRgb(h, sat, cur)
    const score = contrastRatio(cand, bg)
    if (score > bestScore) {
      best = cand
      bestScore = score
    }
    if (score >= minContrast) return cand
  }
  // Background so extreme that no lightness reaches the floor: take the best.
  return best
}

/** Hex wrapper for `readableMuted`: unparseable input passes through. */
export function readableMutedHex(muted: string, bg: string): string {
  const m = parseHexColor(muted)
  const b = parseHexColor(bg)
  if (!m || !b) return muted
  return toHex(readableMuted(m, b))
}

/**
 * The candidate with the highest contrast against `against`, skipping
 * unparseable entries (ties → first). All-null → null.
 */
function pickHighestContrast(
  reference: RGB,
  candidates: ReadonlyArray<RGB | null>,
): RGB | null {
  let best: RGB | null = null
  let bestScore = -1
  for (const c of candidates) {
    if (!c) continue
    const score = contrastRatio(c, reference)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best
}

// ---- derivation ---------------------------------------------------------------

/** Snapshot RGB of a palette index: the detected answer when sane, the
 * standard xterm math otherwise (indices resolve correctly at paint time
 * regardless — this only feeds contrast picks and fallback snapshots). */
function entryRgb(colors: PaletteColors | null, index: number): RGB {
  const raw = colors?.palette[index]
  const parsed = raw == null ? null : parseHexColor(raw)
  if (parsed) return parsed
  const [r, g, b] = indexedToRgb(index)
  return { r, g, b }
}

/**
 * The better-contrasting of two palette indices against `reference`
 * (ties → the bright entry, matching the shells' bright-first habit).
 */
function pickIndex(
  reference: RGB,
  bright: number,
  normal: number,
  entry: (index: number) => RGB,
): number {
  return contrastRatio(entry(bright), reference) >= contrastRatio(entry(normal), reference)
    ? bright
    : normal
}

/**
 * Pick the two neutral greys used for structure (bars + borders): the index
 * with the MOST contrast against the reference (bar text / focused border) and
 * the one with the LEAST (quiet unfocused borders). Grey 7 (light) vs grey 8
 * (bright black) is the terminal-native neutral pair; on a dark bg the lighter
 * grey 7 reads as the strong tone, on a light bg the darker grey 8 does.
 */
function pickNeutrals(
  reference: RGB,
  entry: (index: number) => RGB,
): { quiet: number; strong: number } {
  const seven = contrastRatio(entry(7), reference)
  const eight = contrastRatio(entry(8), reference)
  return seven >= eight ? { strong: 7, quiet: 8 } : { strong: 8, quiet: 7 }
}

/**
 * Pick WHICH palette index each accent-ish token paints with. Pure index
 * arithmetic + a best-effort contrast pick — the resulting INDICES are painted
 * by the host terminal, so detection quality never changes the hue family,
 * only bright-vs-normal. Works with no detection at all (reference falls back
 * to a mode-appropriate black/white).
 */
export function deriveIndexedAccents(colors: PaletteColors | null, light: boolean): IndexedAccents {
  const bgRef =
    parseHexColor(colors?.defaultBackground ?? null) ??
    (light ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 })
  const entry = (index: number): RGB => entryRgb(colors, index)
  const { quiet, strong } = pickNeutrals(bgRef, entry)
  return {
    muted: 8,
    barFg: strong,
    // Structure is neutral: focused boxes get a slightly stronger grey rather
    // than a full accent outline. The accent lives in the title/highlights.
    border: quiet,
    borderFocused: strong,
    accent: pickIndex(bgRef, 12, 4, entry),
    danger: pickIndex(bgRef, 9, 1, entry),
    success: pickIndex(bgRef, 10, 2, entry),
    warning: pickIndex(bgRef, 11, 3, entry),
  }
}

export function deriveAdaptivePalette(
  colors: PaletteColors | null,
  light = false,
): DerivedAdaptivePalette | null {
  if (!colors) return null
  const fg = parseHexColor(colors.defaultForeground)
  const bg = parseHexColor(colors.defaultBackground)
  if (!fg || !bg) return null

  // The on-accent pick needs the accent's RGB: resolve the same index the
  // indexed-accent derivation chose (detected entry, else standard math), then
  // soften it so chrome is not full-saturation ANSI.
  const acc = deriveIndexedAccents(colors, light)
  const accentRgb = softenAccent(entryRgb(colors, acc.accent), bg)
  const onAccent = pickHighestContrast(accentRgb, [bg, fg])

  // Opaque overlay panels: the user's bg lifted slightly toward fg — a
  // floating dialog in the terminal's own tones, not chrome.
  const cardBg = mix(bg, fg, 0.12)
  const selectionBg = mix(bg, fg, 0.22)
  const onSelection = pickHighestContrast(selectionBg, [fg, bg])

  return {
    fg: toHex(fg),
    onAccent: onAccent ? toHex(onAccent) : null,
    cardBg: toHex(cardBg),
    selectionBg: toHex(selectionBg),
    onSelection: onSelection ? toHex(onSelection) : null,
    accent: toHex(accentRgb),
    danger: toHex(softenAccent(entryRgb(colors, acc.danger), bg)),
    success: toHex(softenAccent(entryRgb(colors, acc.success), bg)),
    warning: toHex(softenAccent(entryRgb(colors, acc.warning), bg)),
  }
}

// ---- palette override (config `themePalette`) --------------------------------

/**
 * A user-supplied palette + terminal-color-behavior override (config key
 * `themePalette`, docs/config.md "theme"). With indexed paint this is purely
 * OPTIONAL tuning — never needed for correct colors:
 * - `foreground`/`background` override the OSC 10/11 answers (reverse-video
 *   swap fallbacks, theme derivation, the light/dark pick) for terminals that
 *   answer those wrongly or not at all;
 * - `palette[i]` feeds the bright-vs-normal contrast picks and /status.
 */
export interface PaletteOverride {
  readonly palette?: readonly (string | null)[]
  readonly foreground?: string
  readonly background?: string
  /**
   * How the PANE paints indexed colors (docs/config.md "themePalette").
   * The embedded VT has a fixed palette, so `"exact"` (default) rewrites
   * indexed SGR to truecolor from this palette/the OSC-4 detection; `"index"`
   * passes indices through to the VT's built-in palette.
   */
  readonly paneColors?: "exact" | "index"
  /** Bold basic foreground paints the bright entry (default true). */
  readonly boldBright?: boolean
  /**
   * Renderer color mode (docs/config.md "themePalette.colorMode"). Applied at
   * STARTUP only (OpenTUI's native renderer reads the capability around library
   * load — see src/core/colorMode.ts); `/reload` cannot change it.
   */
  readonly colorMode?: ColorMode
}

/**
 * Merge a config override over detected colors (config wins per field /
 * per entry; everything else passes through). Returns the detected object
 * identity unchanged when there is no override (the theme derivation caches
 * by identity). Returns null when both sides are null.
 */
export function mergePaletteOverride(
  detected: PaletteColors | null,
  override: PaletteOverride | null | undefined,
): PaletteColors | null {
  if (!override) return detected
  const hasPalette = Array.isArray(override.palette) && override.palette.length > 0
  const hasFg = typeof override.foreground === "string" && parseHexColor(override.foreground) !== null
  const hasBg = typeof override.background === "string" && parseHexColor(override.background) !== null
  if (!hasPalette && !hasFg && !hasBg) return detected
  const base = detected?.palette ?? []
  const over = hasPalette ? override.palette! : []
  const palette: (string | null)[] = []
  for (let i = 0; i < Math.max(base.length, over.length); i++) {
    const o = over[i]
    palette.push(typeof o === "string" && parseHexColor(o) !== null ? o : (base[i] ?? null))
  }
  return {
    palette,
    defaultForeground: hasFg ? override.foreground! : (detected?.defaultForeground ?? null),
    defaultBackground: hasBg ? override.background! : (detected?.defaultBackground ?? null),
  }
}

// ---- detection state -----------------------------------------------------------

/**
 * Konsole's COMPILED-IN `ColorScheme::defaultTable` — what Konsole's OSC 4
 * reporter answers when the color was never OSC-4-SET at runtime (i.e. always,
 * in practice: the active color scheme is applied at display time and never
 * surfaces in OSC 4 reports; src/colorscheme/ColorScheme.cpp). If a detection
 * comes back EXACTLY equal to this, the terminal's answers do not reflect what
 * it paints — the pane would be repainted with these saturated primaries
 * instead of the user's scheme. OSC 10/11 are NOT affected (they report the
 * real default fg/bg). Docs: DESIGN.md "Pane color fidelity", config.md.
 */
export const KONSOLE_DEFAULT_PALETTE: readonly string[] = [
  "#000000", "#b21818", "#18b218", "#b26818",
  "#1818b2", "#b218b2", "#18b2b2", "#b2b2b2",
  "#686868", "#ff5454", "#54ff54", "#ffff54",
  "#5454ff", "#ff54ff", "#54ffff", "#ffffff",
]

/**
 * Does the detected 0-15 row match Konsole's compiled-in defaults exactly?
 * Format-agnostic (compares parsed RGB). All-null → false (that is "not
 * detected", a different problem). A `themePalette` pin changes the merged
 * palette, so a pinned Konsole no longer matches (no false positive).
 */
export function isKonsoleDefaultPalette(
  colors: { readonly palette: readonly (string | null)[] } | null | undefined,
): boolean {
  if (!colors) return false
  for (let i = 0; i < 16; i++) {
    const c = parseHexColor(colors.palette[i] ?? null)
    const k = parseHexColor(KONSOLE_DEFAULT_PALETTE[i] ?? null)
    if (!c || !k || c.r !== k.r || c.g !== k.g || c.b !== k.b) return false
  }
  return true
}

/** The /status + toast guidance for that case (config.md "themePalette"). */
export const KONSOLE_DEFAULT_NOTE =
  "KDE terminal (Konsole/Yakuake) limitation: OSC 4 reports the built-in palette, not your scheme — pin themePalette (docs/config.md)"

/**
 * Did the terminal answer AT ALL? A failed OSC probe yields all-null entries
 * AND null default colors (opentui caches that empty answer — see the retry
 * logic in App.tsx). One answered entry, fg or bg counts as success.
 */
export function isPaletteAnswered(colors: PaletteColors | null | undefined): boolean {
  if (!colors) return false
  if (colors.defaultForeground !== null || colors.defaultBackground !== null) return true
  return colors.palette.some((c) => c !== null)
}

/** /status retries note: schedule App uses when the first probe comes back
 * empty (slow SSH links beat the renderer's 300ms probe on a later try). */
export const PALETTE_RETRY_DELAYS_MS: readonly number[] = [1000, 4000, 10000]

/**
 * One-line /status summary of the detection state (UI-owned runtime facts).
 * `attempts` = probe tries consumed (1 = first probe answered). `source` names
 * a non-detection palette origin (e.g. the KDE scheme read for a lying OSC 4
 * answer). Never throws. Returns TWO lines: the state summary plus the answered
 * ANSI 0-15 swatch (hex per index) so color-fidelity reports can be diffed
 * against the terminal's own scheme without any extra tooling.
 */
export function paletteStatusSummary(
  colors: PaletteColors | null,
  attempts: number,
  source?: string | null,
): string | null {
  if (!colors) return attempts > 1 ? `palette: NOT detected (${attempts} probes) — xterm fallback` : "palette: NOT detected — xterm fallback"
  const answered = colors.palette.filter((c) => c !== null).length
  const fg = parseHexColor(colors.defaultForeground)
  const bg = parseHexColor(colors.defaultBackground)
  const parts = [
    `${answered}/${colors.palette.length} entries`,
    fg ? `fg ${rgbToHex(fg.r, fg.g, fg.b)}` : "fg ?",
    bg ? `bg ${rgbToHex(bg.r, bg.g, bg.b)}` : "bg ?",
  ]
  const retry = attempts > 1 ? ` · after ${attempts} probes` : ""
  const src = source ? ` · source: ${source}` : ""
  const hex = (i: number): string => {
    const c = parseHexColor(colors.palette[i] ?? null)
    return c ? rgbToHex(c.r, c.g, c.b) : "?"
  }
  const swatch = Array.from({ length: 16 }, (_, i) => hex(i)).join(" ")
  // Konsole reports its compiled-in table, not the active scheme — say so, or
  // the pane silently falls back to the VT palette with no explanation.
  const konsole = isKonsoleDefaultPalette(colors) ? `\n⚠ ${KONSOLE_DEFAULT_NOTE}` : ""
  return `palette: ${parts.join(" · ")}${retry}${src}\npalette 0-15: ${swatch}${konsole}`
}