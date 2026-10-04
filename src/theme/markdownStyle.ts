/**
 * M9 phase 4: SyntaxStyle for the native <markdown> renderable, derived from
 * the active theme tokens (no hardcoded colors — same contract as the rest of
 * the UI). The native markdown renderer styles via scope names
 * ("markup.heading", "markup.strong", ...); one style instance is cached per
 * theme snapshot and rebuilt when the theme changes (live /theme switches).
 */

import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"
import { colorKey, theme, type ThemeColor } from "./theme.ts"

/** Scoped token styles the markdown renderer resolves against. */
function tokenStyles(): ThemeTokenStyle[] {
  const t = theme()
  const style = (
    scope: string[],
    s: {
      foreground?: ThemeColor
      bold?: boolean
      italic?: boolean
      underline?: boolean
      dim?: boolean
    },
  ): ThemeTokenStyle => ({ scope, style: s })
  return [
    style(["default"], { foreground: t.fg }),
    style(["markup.heading"], { foreground: t.accent, bold: true }),
    style(["markup.strong"], { bold: true }),
    style(["markup.italic"], { italic: true }),
    style(["markup.raw"], { foreground: t.accent }),
    style(["markup.link"], { foreground: t.accent, underline: true }),
    style(["markup.link.url"], { foreground: t.muted, underline: true }),
    style(["markup.link.label"], { foreground: t.accent }),
    style(["markup.quote"], { foreground: t.muted, italic: true }),
    style(["markup.list"], { foreground: t.accent }),
    style(["markup.strikethrough"], { dim: true }),
  ]
}

let cached: { key: string; style: SyntaxStyle } | null = null

/** The SyntaxStyle for the CURRENT theme (rebuilt live on theme switches).
 * Keyed on the token VALUES the styles use — theme() returns a fresh object
 * per read for the adaptive theme, so object identity cannot key the cache;
 * RGBA tokens (indexed accents) need colorKey (they stringify as
 * "[object Object]"). */
export function markdownSyntaxStyle(): SyntaxStyle {
  const t = theme()
  const key = `${t.name}|${colorKey(t.fg)}|${colorKey(t.accent)}|${colorKey(t.muted)}`
  if (cached === null || cached.key !== key) {
    cached?.style.destroy()
    cached = { key, style: SyntaxStyle.fromTheme(tokenStyles()) }
  }
  return cached.style
}