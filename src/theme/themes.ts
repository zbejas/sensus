/**
 * Built-in theme definitions (docs/DESIGN.md "Color and theme").
 *
 * This module owns the token CONTRACT (`ThemeTokens`) and the shipped theme
 * data. `theme.ts` owns the runtime: reactivity, adaptive resolution (the
 * `terminal` theme), and the style-prop helpers. Everything defined here is
 * re-exported from `theme.ts`, so `src/ui/` keeps importing from one place.
 *
 * Token contract:
 * - bg-ish tokens (bg, barBg, cardBg, selectionBg, scrollbar): `null` means
 *   "omit the style entirely" → opentui paints nothing → the user's terminal
 *   background shows through. This is what makes the default "terminal" theme
 *   blend into any palette.
 * - border `null` → omit borderColor.
 * - fg-ish tokens (fg, muted, barFg): `null` on a definition means "adaptive".
 *   Non-adaptive themes carry concrete hex values.
 *
 * Adding a theme is two edits: append the name to `THEME_NAMES` and add its
 * definition to `THEME_DEFS` (the `Record<ThemeName, …>` annotation makes the
 * compiler demand the second). `borderFocused` defaults to `accent`, `toast`
 * to `warning`, `barFg`/`onSelection` to `fg`, and `scrollbar` to `border`, so
 * only the colors a theme genuinely distinguishes need spelling out.
 */

import type { RGBA } from "@opentui/core"
import { parseHexColor } from "./themePalette.ts"

/**
 * A theme token color: concrete hex, or an opentui indexed-intent RGBA
 * (`RGBA.fromIndex` → the HOST terminal resolves the index against its active
 * palette at paint time). The adaptive "terminal" theme emits indexed accent
 * tokens so chrome matches the shell's scheme with zero configuration.
 */
export type ThemeColor = string | RGBA

/** Ordered registry of built-in theme names (drives /theme, the pickers, the
 * settings screen and the setup wizard). Insertion order is the display order:
 * the adaptive default, then the plain dark/light pair, then the families. */
export const THEME_NAMES = [
  "terminal",
  "dark",
  "light",
  "solarized-dark",
  "solarized-light",
  "gruvbox-dark",
  "nord",
  "dracula",
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "catppuccin-latte",
  "tokyo-night",
  "one-dark",
  "one-light",
  "monokai",
  "rose-pine",
  "rose-pine-moon",
  "rose-pine-dawn",
  "everforest-dark",
  "everforest-light",
  "kanagawa",
  "ayu-dark",
  "ayu-mirage",
  "ayu-light",
  "night-owl",
  "palenight",
  "material",
  "github-dark",
  "github-light",
  "cobalt2",
  "horizon",
  "zenburn",
  "iceberg-dark",
  "synthwave-84",
  "spacegray",
  "oceanic-next",
  "papercolor-light",
] as const satisfies readonly string[]

export type ThemeName = (typeof THEME_NAMES)[number]

/** The shipped default: adaptive, inherits the terminal palette. */
export const DEFAULT_THEME: ThemeName = "terminal"

export interface ThemeTokens {
  name: ThemeName
  displayName: string
  /** Screen background. null → omit (inherit the terminal's own). */
  bg: string | null
  /** Default text color; null = adaptive (resolved from terminal mode). */
  fg: string | null
  /** Secondary text; null = adaptive. */
  muted: ThemeColor | null
  accent: ThemeColor
  /** Text color on accent backgrounds (cursor cell, selection chips). */
  onAccent: string
  /** Unfocused box borders; null → omit (terminal default). */
  border: ThemeColor | null
  borderFocused: ThemeColor | null
  danger: ThemeColor
  success: ThemeColor
  warning: ThemeColor
  toast: ThemeColor
  /** Overlay/card panels; null → no fill. */
  cardBg: string | null
  /** Selected row background; null → highlight with accent fg + bold only. */
  selectionBg: string | null
  onSelection: string | null
  /** Scrollbar thumb (chat message list). null → no fill. */
  scrollbar: string | null
  /** Tab + status bars; null → no fill (rows inherit the terminal bg). */
  barBg: string | null
  barFg: ThemeColor | null
}

/** Broad classification for listing/grouping (derived, never stored). */
export type ThemeKind = "adaptive" | "dark" | "light"

/**
 * A shipped theme minus the fields the registry fills in. Only the colors a
 * theme actually distinguishes are required; structural defaults are derived
 * in `BUILTIN_THEMES` below.
 */
type ThemeDefinition = Omit<
  ThemeTokens,
  "name" | "displayName" | "borderFocused" | "toast" | "onSelection" | "barFg" | "scrollbar"
> & {
  displayName?: string
  borderFocused?: ThemeColor | null
  toast?: ThemeColor
  onSelection?: string | null
  barFg?: ThemeColor | null
  scrollbar?: string | null
}

/**
 * The built-in theme data. Keyed by `ThemeName`; the annotation makes a missing
 * or misspelled key a compile error. Palettes follow each theme's published
 * colors (bg/fg/accent/semantic hues), with surfaces mapped onto sensus's
 * card/bar/selection roles.
 */
const THEME_DEFS: Record<ThemeName, ThemeDefinition> = {
  terminal: {
    displayName: "terminal (adaptive)",
    bg: null,
    fg: null,
    muted: null,
    accent: "#0087af",
    onAccent: "#ffffff",
    border: null,
    borderFocused: "#0087af",
    danger: "#d75f5f",
    success: "#5faf5f",
    warning: "#d7af5f",
    cardBg: null,
    selectionBg: null,
    barBg: null,
  },
  dark: {
    bg: "#000000",
    fg: "#e6e6e6",
    muted: "#7a7a7a",
    accent: "#5fafd7",
    onAccent: "#000000",
    border: "#3a3a3a",
    danger: "#d75f5f",
    success: "#5faf87",
    warning: "#d7af5f",
    cardBg: "#111111",
    selectionBg: "#264f78",
    onSelection: "#ffffff",
    scrollbar: "#444444",
    barBg: "#1a1a1a",
    barFg: "#c0c0c0",
  },
  light: {
    bg: "#ffffff",
    fg: "#24292e",
    muted: "#6a737d",
    accent: "#005f87",
    onAccent: "#ffffff",
    border: "#c9c9c9",
    danger: "#cc3333",
    success: "#22884a",
    warning: "#9a6700",
    cardBg: "#f6f8fa",
    selectionBg: "#d0e3f3",
    onSelection: "#1b1f23",
    scrollbar: "#d0d0d0",
    barBg: "#ececec",
    barFg: "#3a3a3a",
  },
  "solarized-dark": {
    bg: "#002b36",
    fg: "#93a1a1",
    muted: "#657b83",
    accent: "#268bd2",
    onAccent: "#eee8d5",
    border: "#073642",
    danger: "#dc322f",
    success: "#859900",
    warning: "#b58900",
    toast: "#cb4b16",
    cardBg: "#073642",
    selectionBg: "#0a4250",
    onSelection: "#eee8d5",
    scrollbar: "#0e4a56",
    barBg: "#073642",
    barFg: "#93a1a1",
  },
  "solarized-light": {
    bg: "#fdf6e3",
    fg: "#657b83",
    muted: "#93a1a1",
    accent: "#268bd2",
    onAccent: "#fdf6e3",
    border: "#eee8d5",
    danger: "#dc322f",
    success: "#859900",
    warning: "#b58900",
    toast: "#cb4b16",
    cardBg: "#eee8d5",
    selectionBg: "#e6dfc8",
    onSelection: "#586e75",
    scrollbar: "#ddd6c1",
    barBg: "#eee8d5",
    barFg: "#586e75",
  },
  "gruvbox-dark": {
    bg: "#282828",
    fg: "#ebdbb2",
    muted: "#928374",
    accent: "#83a598",
    onAccent: "#1d2021",
    border: "#504945",
    danger: "#fb4934",
    success: "#b8bb26",
    warning: "#fabd2f",
    cardBg: "#32302f",
    selectionBg: "#504945",
    onSelection: "#fbf1c7",
    scrollbar: "#665c54",
    barBg: "#3c3836",
    barFg: "#ebdbb2",
  },
  nord: {
    bg: "#2e3440",
    fg: "#d8dee9",
    muted: "#7b88a1",
    accent: "#88c0d0",
    onAccent: "#2e3440",
    border: "#434c5e",
    danger: "#bf616a",
    success: "#a3be8c",
    warning: "#ebcb8b",
    cardBg: "#3b4252",
    selectionBg: "#434c5e",
    onSelection: "#eceff4",
    scrollbar: "#4c566a",
    barBg: "#3b4252",
    barFg: "#d8dee9",
  },
  dracula: {
    bg: "#282a36",
    fg: "#f8f8f2",
    muted: "#6272a4",
    accent: "#bd93f9",
    onAccent: "#282a36",
    border: "#44475a",
    danger: "#ff5555",
    success: "#50fa7b",
    warning: "#f1fa8c",
    cardBg: "#21222c",
    selectionBg: "#44475a",
    onSelection: "#f8f8f2",
    scrollbar: "#44475a",
    barBg: "#21222c",
  },
  "catppuccin-mocha": {
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    muted: "#7f849c",
    accent: "#89b4fa",
    onAccent: "#1e1e2e",
    border: "#313244",
    danger: "#f38ba8",
    success: "#a6e3a1",
    warning: "#f9e2af",
    cardBg: "#181825",
    selectionBg: "#45475a",
    scrollbar: "#45475a",
    barBg: "#181825",
  },
  "catppuccin-macchiato": {
    bg: "#24273a",
    fg: "#cad3f5",
    muted: "#8087a2",
    accent: "#8aadf4",
    onAccent: "#24273a",
    border: "#363a4f",
    danger: "#ed8796",
    success: "#a6da95",
    warning: "#eed49f",
    cardBg: "#1e2030",
    selectionBg: "#494d64",
    scrollbar: "#494d64",
    barBg: "#1e2030",
  },
  "catppuccin-frappe": {
    bg: "#303446",
    fg: "#c6d0f5",
    muted: "#838ba7",
    accent: "#8caaee",
    onAccent: "#303446",
    border: "#414559",
    danger: "#e78284",
    success: "#a6d189",
    warning: "#e5c890",
    cardBg: "#292c3c",
    selectionBg: "#51576d",
    scrollbar: "#51576d",
    barBg: "#292c3c",
  },
  "catppuccin-latte": {
    bg: "#eff1f5",
    fg: "#4c4f69",
    muted: "#8c8fa1",
    accent: "#1e66f5",
    onAccent: "#ffffff",
    border: "#ccd0da",
    danger: "#d20f39",
    success: "#40a02b",
    warning: "#df8e1d",
    cardBg: "#e6e9ef",
    selectionBg: "#bcc0cc",
    onSelection: "#4c4f69",
    scrollbar: "#ccd0da",
    barBg: "#e6e9ef",
  },
  "tokyo-night": {
    bg: "#1a1b26",
    fg: "#c0caf5",
    muted: "#565f89",
    accent: "#7aa2f7",
    onAccent: "#1a1b26",
    border: "#292e42",
    danger: "#f7768e",
    success: "#9ece6a",
    warning: "#e0af68",
    cardBg: "#16161e",
    selectionBg: "#33467c",
    scrollbar: "#414868",
    barBg: "#16161e",
  },
  "one-dark": {
    bg: "#282c34",
    fg: "#abb2bf",
    muted: "#5c6370",
    accent: "#61afef",
    onAccent: "#282c34",
    border: "#3e4451",
    danger: "#e06c75",
    success: "#98c379",
    warning: "#e5c07b",
    cardBg: "#21252b",
    selectionBg: "#3e4451",
    scrollbar: "#4b5263",
    barBg: "#21252b",
  },
  "one-light": {
    bg: "#fafafa",
    fg: "#383a42",
    muted: "#a0a1a7",
    accent: "#4078f2",
    onAccent: "#ffffff",
    border: "#e5e5e6",
    danger: "#e45649",
    success: "#50a14f",
    warning: "#c18401",
    cardBg: "#f0f0f1",
    selectionBg: "#d3d7e0",
    onSelection: "#383a42",
    scrollbar: "#e5e5e6",
    barBg: "#f0f0f1",
  },
  monokai: {
    bg: "#272822",
    fg: "#f8f8f2",
    muted: "#75715e",
    accent: "#66d9ef",
    onAccent: "#272822",
    border: "#3e3d32",
    danger: "#f92672",
    success: "#a6e22e",
    warning: "#e6db74",
    cardBg: "#1e1f1c",
    selectionBg: "#49483e",
    scrollbar: "#49483e",
    barBg: "#1e1f1c",
  },
  "rose-pine": {
    bg: "#191724",
    fg: "#e0def4",
    muted: "#6e6a86",
    accent: "#c4a7e7",
    onAccent: "#191724",
    border: "#26233a",
    danger: "#eb6f92",
    success: "#9ccfd8",
    warning: "#f6c177",
    cardBg: "#1f1d2e",
    selectionBg: "#403d52",
    scrollbar: "#524f67",
    barBg: "#1f1d2e",
  },
  "rose-pine-moon": {
    bg: "#232136",
    fg: "#e0def4",
    muted: "#6e6a86",
    accent: "#c4a7e7",
    onAccent: "#232136",
    border: "#393552",
    danger: "#eb6f92",
    success: "#9ccfd8",
    warning: "#f6c177",
    cardBg: "#2a273f",
    selectionBg: "#44415a",
    scrollbar: "#56526e",
    barBg: "#2a273f",
  },
  "rose-pine-dawn": {
    bg: "#faf4ed",
    fg: "#575279",
    muted: "#9893a5",
    accent: "#907aa9",
    onAccent: "#ffffff",
    border: "#f2e9e1",
    danger: "#b4637a",
    success: "#56949f",
    warning: "#ea9d34",
    cardBg: "#fffaf3",
    selectionBg: "#dfdad9",
    onSelection: "#575279",
    scrollbar: "#cecacd",
    barBg: "#fffaf3",
  },
  "everforest-dark": {
    bg: "#2d353b",
    fg: "#d3c6aa",
    muted: "#859289",
    accent: "#a7c080",
    onAccent: "#2d353b",
    border: "#3d484d",
    danger: "#e67e80",
    success: "#a7c080",
    warning: "#dbbc7f",
    cardBg: "#343f44",
    selectionBg: "#425047",
    scrollbar: "#4f585e",
    barBg: "#343f44",
  },
  "everforest-light": {
    bg: "#fdf6e3",
    fg: "#5c6a72",
    muted: "#939f91",
    accent: "#8da101",
    onAccent: "#ffffff",
    border: "#efebd4",
    danger: "#f85552",
    success: "#8da101",
    warning: "#dfa000",
    cardBg: "#f4f0d9",
    selectionBg: "#e6e2cc",
    onSelection: "#5c6a72",
    scrollbar: "#e0dcc7",
    barBg: "#f4f0d9",
  },
  kanagawa: {
    bg: "#1f1f28",
    fg: "#dcd7ba",
    muted: "#727169",
    accent: "#7e9cd8",
    onAccent: "#1f1f28",
    border: "#2a2a37",
    danger: "#e82424",
    success: "#98bb6c",
    warning: "#e6c384",
    cardBg: "#16161d",
    selectionBg: "#2d4f67",
    scrollbar: "#363646",
    barBg: "#16161d",
  },
  "ayu-dark": {
    bg: "#0a0e14",
    fg: "#b3b1ad",
    muted: "#626a73",
    accent: "#ff8f40",
    onAccent: "#0a0e14",
    border: "#1f2430",
    danger: "#f07178",
    success: "#aad94c",
    warning: "#e6b450",
    cardBg: "#131721",
    selectionBg: "#1f2430",
    scrollbar: "#253340",
    barBg: "#131721",
  },
  "ayu-mirage": {
    bg: "#1f2430",
    fg: "#cbccc6",
    muted: "#707a8c",
    accent: "#ffcc66",
    onAccent: "#1f2430",
    border: "#2b3240",
    danger: "#f28779",
    success: "#bae67e",
    warning: "#ffd580",
    cardBg: "#191e2a",
    selectionBg: "#343f52",
    scrollbar: "#3d4759",
    barBg: "#191e2a",
  },
  "ayu-light": {
    bg: "#fafafa",
    fg: "#5c6773",
    muted: "#abb0b6",
    accent: "#399ee6",
    onAccent: "#ffffff",
    border: "#e6e6e6",
    danger: "#f07178",
    success: "#86b300",
    warning: "#f2ae49",
    cardBg: "#f0f0f0",
    selectionBg: "#e5e5e5",
    onSelection: "#5c6773",
    scrollbar: "#e6e6e6",
    barBg: "#f0f0f0",
  },
  "night-owl": {
    bg: "#011627",
    fg: "#d6deeb",
    muted: "#637777",
    accent: "#82aaff",
    onAccent: "#011627",
    border: "#0b2942",
    danger: "#ef5350",
    success: "#addb67",
    warning: "#ecc48d",
    cardBg: "#01111d",
    selectionBg: "#1d3b53",
    scrollbar: "#1d3b53",
    barBg: "#01111d",
  },
  palenight: {
    bg: "#292d3e",
    fg: "#a6accd",
    muted: "#676e95",
    accent: "#82aaff",
    onAccent: "#292d3e",
    border: "#3a3f58",
    danger: "#f07178",
    success: "#c3e88d",
    warning: "#ffcb6b",
    cardBg: "#1f2233",
    selectionBg: "#3a3f58",
    scrollbar: "#444267",
    barBg: "#1f2233",
  },
  material: {
    bg: "#263238",
    fg: "#eeffff",
    muted: "#546e7a",
    accent: "#82aaff",
    onAccent: "#263238",
    border: "#37474f",
    danger: "#f07178",
    success: "#c3e88d",
    warning: "#ffcb6b",
    cardBg: "#1e272c",
    selectionBg: "#314549",
    scrollbar: "#37474f",
    barBg: "#1e272c",
  },
  "github-dark": {
    bg: "#0d1117",
    fg: "#c9d1d9",
    muted: "#8b949e",
    accent: "#58a6ff",
    onAccent: "#0d1117",
    border: "#30363d",
    danger: "#f85149",
    success: "#3fb950",
    warning: "#d29922",
    cardBg: "#161b22",
    selectionBg: "#264f78",
    onSelection: "#ffffff",
    scrollbar: "#30363d",
    barBg: "#161b22",
  },
  "github-light": {
    bg: "#ffffff",
    fg: "#24292f",
    muted: "#57606a",
    accent: "#0969da",
    onAccent: "#ffffff",
    border: "#d0d7de",
    danger: "#cf222e",
    success: "#1a7f37",
    warning: "#9a6700",
    cardBg: "#f6f8fa",
    selectionBg: "#ddf4ff",
    onSelection: "#24292f",
    scrollbar: "#d0d7de",
    barBg: "#f6f8fa",
  },
  cobalt2: {
    bg: "#193549",
    fg: "#ffffff",
    muted: "#5f7e97",
    accent: "#ffc600",
    onAccent: "#193549",
    border: "#0d3a58",
    danger: "#ff2600",
    success: "#3ad900",
    warning: "#ff9d00",
    cardBg: "#122738",
    selectionBg: "#2a4a63",
    scrollbar: "#1f4662",
    barBg: "#122738",
  },
  horizon: {
    bg: "#1c1e26",
    fg: "#cbced0",
    muted: "#6c6f93",
    accent: "#26bbd9",
    onAccent: "#1c1e26",
    border: "#2e303e",
    danger: "#e95678",
    success: "#29d398",
    warning: "#fab795",
    cardBg: "#232530",
    selectionBg: "#2e303e",
    scrollbar: "#2e303e",
    barBg: "#232530",
  },
  zenburn: {
    bg: "#3f3f3f",
    fg: "#dcdccc",
    muted: "#709080",
    accent: "#8cd0d3",
    onAccent: "#3f3f3f",
    border: "#4f4f4f",
    danger: "#cc9393",
    success: "#7f9f7f",
    warning: "#f0dfaf",
    cardBg: "#2b2b2b",
    selectionBg: "#5f5f5f",
    scrollbar: "#5f5f5f",
    barBg: "#2b2b2b",
  },
  "iceberg-dark": {
    bg: "#161821",
    fg: "#c6c8d1",
    muted: "#6b7089",
    accent: "#84a0c6",
    onAccent: "#161821",
    border: "#1e2132",
    danger: "#e27878",
    success: "#b4be82",
    warning: "#e2a478",
    cardBg: "#1e2132",
    selectionBg: "#2e3345",
    scrollbar: "#2e3345",
    barBg: "#1e2132",
  },
  "synthwave-84": {
    bg: "#262335",
    fg: "#ffffff",
    muted: "#6e6a8f",
    accent: "#ff7edb",
    onAccent: "#262335",
    border: "#34294f",
    danger: "#fe4450",
    success: "#72f1b8",
    warning: "#fede5d",
    cardBg: "#1e1a2e",
    selectionBg: "#3b2e5a",
    scrollbar: "#463465",
    barBg: "#1e1a2e",
  },
  spacegray: {
    bg: "#2b303b",
    fg: "#c0c5ce",
    muted: "#65737e",
    accent: "#8fa1b3",
    onAccent: "#2b303b",
    border: "#343d46",
    danger: "#bf616a",
    success: "#a3be8c",
    warning: "#ebcb8b",
    cardBg: "#20242d",
    selectionBg: "#3b4451",
    scrollbar: "#4f5b66",
    barBg: "#20242d",
  },
  "oceanic-next": {
    bg: "#1b2b34",
    fg: "#c0c5ce",
    muted: "#65737e",
    accent: "#6699cc",
    onAccent: "#1b2b34",
    border: "#343d46",
    danger: "#ec5f67",
    success: "#99c794",
    warning: "#fac863",
    cardBg: "#16242c",
    selectionBg: "#343d46",
    scrollbar: "#4f5b66",
    barBg: "#16242c",
  },
  "papercolor-light": {
    bg: "#eeeeee",
    fg: "#444444",
    muted: "#878787",
    accent: "#0087af",
    onAccent: "#ffffff",
    border: "#d0d0d0",
    danger: "#af0000",
    success: "#008700",
    warning: "#d75f00",
    cardBg: "#e4e4e4",
    selectionBg: "#d0d0d0",
    onSelection: "#444444",
    scrollbar: "#d0d0d0",
    barBg: "#e4e4e4",
  },
}

/** The built-in themes with structural defaults filled in. */
export const BUILTIN_THEMES: Record<ThemeName, ThemeTokens> = Object.fromEntries(
  THEME_NAMES.map((name): [ThemeName, ThemeTokens] => {
    const def = THEME_DEFS[name]
    return [
      name,
      {
        name,
        displayName: def.displayName ?? name,
        ...def,
        borderFocused: def.borderFocused ?? def.accent,
        toast: def.toast ?? def.warning,
        onSelection: def.onSelection ?? def.fg,
        barFg: def.barFg ?? def.fg,
        scrollbar: def.scrollbar ?? (typeof def.border === "string" ? def.border : null),
      },
    ]
  }),
) as Record<ThemeName, ThemeTokens>

export function isThemeName(name: string): name is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(name)
}

/** Resolve a config-stored theme name; unknown names fall back to the
 * adaptive default (config tolerance — callers may warn). */
export function resolveTheme(name: string | null | undefined): ThemeTokens {
  return isThemeName(name ?? "") ? BUILTIN_THEMES[name as ThemeName] : BUILTIN_THEMES[DEFAULT_THEME]
}

/**
 * Resolve a typed `/theme` argument: exact name first, then a UNIQUE
 * case-insensitive prefix, then a unique substring. Ambiguous or absent →
 * null, so the caller can report an unknown theme rather than guess.
 */
export function matchThemeName(input: string): ThemeName | null {
  const q = input.trim().toLowerCase()
  if (q.length === 0) return null
  if (isThemeName(q)) return q
  const prefix = THEME_NAMES.filter((n) => n.startsWith(q))
  if (prefix.length === 1) return prefix[0]!
  const sub = THEME_NAMES.filter((n) => n.includes(q))
  return sub.length === 1 ? sub[0]! : null
}

/** Adaptive, dark or light — derived from the background for grouping/labels. */
export function themeKind(name: ThemeName): ThemeKind {
  if (name === "terminal") return "adaptive"
  const rgb = parseHexColor(BUILTIN_THEMES[name].bg)
  if (!rgb) return "dark"
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
  return luminance > 0.5 ? "light" : "dark"
}

/** Theme names of one kind, in registry order. */
export function themesOfKind(kind: ThemeKind): ThemeName[] {
  return THEME_NAMES.filter((n) => themeKind(n) === kind)
}
