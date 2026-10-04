/**
 * Pane palette / default-color derivation (docs/DESIGN.md "Pane color
 * fidelity", docs/config.md "themePalette").
 *
 * The embedded VT composes a FIXED palette and ignores the host terminal, so
 * App rewrites indexed SGR to truecolor from the detected (or config-override)
 * palette, and re-applies the theme default fg on every reset/39; the default
 * bg is painted by `PanePainter` in the composed frame. The
 * bodies live here as pure functions over plain arguments; App owns the mutable
 * merged palette (`panePalette`) and pushes the results to each live session.
 *
 * No renderer/opentui imports (unit-tested directly). `tabs` is the structural
 * TabView list — each session exposes setPalette/setBoldBright/setDefaults.
 */

import { buildPanePalette, type PanePalette, type Rgb } from "../../terminal/sgr.ts"
import { parseHexColor, type PaletteColors, type PaletteOverride } from "../../theme/themePalette.ts"
import type { TabView } from "./store.ts"

/** How the PANE paints indexed colors (config `themePalette.paneColors`). */
export interface PaneColorConfig {
  mode: "exact" | "index"
  boldBright: boolean
}

/** Theme default fg/bg applied to every cell with no explicit color. */
export interface PaneDefaultColors {
  fg: Rgb | null
  bg: Rgb | null
}

/** Pane color mode + bold-bright, defaulting to exact/on when unset. */
export function paneColorConfig(tp: PaletteOverride | null | undefined): PaneColorConfig {
  return { mode: tp?.paneColors ?? "exact", boldBright: tp?.boldBright ?? true }
}

/**
 * Default pane fg/bg. The config override wins (it is explicit); then the
 * active theme tokens; then `fallbackBg` for the adaptive theme (bg = null),
 * which is the terminal's detected background (or a constant).
 */
export function paneDefaultColors(
  tp: PaletteOverride | null | undefined,
  tokens: { fg: string | null; bg: string | null },
  fallbackBg: string,
): PaneDefaultColors {
  const fg = parseHexColor(tp?.foreground ?? null) ?? parseHexColor(tokens.fg)
  const bg = parseHexColor(tp?.background ?? null) ?? parseHexColor(tokens.bg ?? fallbackBg)
  return {
    fg: fg !== null ? [fg.r, fg.g, fg.b] : null,
    bg: bg !== null ? [bg.r, bg.g, bg.b] : null,
  }
}

/** The merged pane palette, or null when `paneColors: "index"` disables the
 * rewrite (indices pass through to the VT's built-in palette). */
export function panePaletteFor(
  tp: PaletteOverride | null | undefined,
  merged: PaletteColors | null,
): PanePalette | null {
  return (tp?.paneColors ?? "exact") === "index" ? null : buildPanePalette(merged)
}

/** Push the pane palette + bold-bright to every live session. */
export function applyPanePalette(
  tabs: readonly TabView[],
  palette: PanePalette | null,
  boldBright: boolean,
): void {
  for (const t of tabs) {
    t.session.setPalette(palette)
    t.session.setBoldBright(boldBright)
  }
}

/** Push the default fg/bg to every live session. */
export function applyPaneDefaults(tabs: readonly TabView[], fg: Rgb | null, bg: Rgb | null): void {
  for (const t of tabs) t.session.setDefaults(fg, bg)
}
