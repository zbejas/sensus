/**
 * Theme application + persistence. One implementation shared by
 * /theme (ChatHost dep) and the settings screen: validate → apply live (the
 * theme.ts signal) → persist to the real config file (unknown keys preserved,
 * atomic write + one-time .bak — see configFile.ts).
 */

import { configPath } from "../config/config.ts"
import { isThemeName, setTheme, theme } from "./theme.ts"
import { updateRawConfig } from "../config/configFile.ts"

/** The live theme name (may differ from config.theme until persisted). */
export function currentThemeName(): string {
  return theme().name
}

/**
 * Switch the theme live and persist it. Returns an error message, or null on
 * success. A failed write still applies the theme live (session-scoped) and
 * reports the write problem.
 */
export function applyThemePersisted(name: string, path = configPath()): string | null {
  if (!isThemeName(name)) return `unknown theme "${name}"`
  setTheme(name)
  const res = updateRawConfig(path, (doc) => ({ ...doc, theme: name }))
  if (!res.ok) return res.error ?? "config write failed"
  return null
}
