/**
 * Settings screen (Ctrl+O) pure helpers — the rail category order, the flat
 * type-to-filter ranking, and the shared vim/paging navigation step. Extracted
 * so the screen's filter + navigation behavior is unit-tested without a
 * renderer (docs/testing.md "non-render behavior lives in pure helpers").
 */

import { fuzzyScore } from "../lib/fuzzy.ts"

/**
 * The left nav rail, top to bottom. The labels are user-visible and exact;
 * the detail pane is keyed off these strings (docs/config.md "Settings screen").
 */
export const SETTINGS_CATEGORIES = [
  "Endpoints",
  "Model",
  "Agent",
  "Appearance",
  "Chat",
  "Context",
  "MCP servers",
  "Memory",
] as const

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]

/** Anything the flat filter can rank: a label plus its category tag. */
export interface FilterableSetting {
  label: string
  category: string
}

/**
 * Fuzzy-rank settings across ALL categories on `label` + `category`. The
 * better of the two scores wins; a non-match is dropped. An empty (or
 * whitespace) query returns the full list in source order. Ties keep source
 * order (stable) so the flat list never jitters as the user types.
 */
export function filterSettings<T extends FilterableSetting>(settings: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...settings]
  const scored: Array<{ item: T; score: number; order: number }> = []
  settings.forEach((item, order) => {
    const labelScore = fuzzyScore(q, item.label)
    const categoryScore = fuzzyScore(q, item.category)
    const best =
      labelScore !== null && categoryScore !== null ? Math.max(labelScore, categoryScore) : (labelScore ?? categoryScore)
    if (best !== null) scored.push({ item, score: best, order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.map((s) => s.item)
}

/**
 * Cycle through a preset list of options (numbers, strings, or null = "off")
 * in `dir` direction, wrapping at both ends. `current` need not be in the
 * list (a hand-edited custom value): the step starts from `fallback`'s slot.
 * Used by preset settings rows (e.g. the tool-turn limit) so the cycle order
 * is pure and unit-tested.
 */
export function cycleOption<T>(current: T, options: readonly T[], dir: number, fallback: T): T {
  const n = options.length
  if (n === 0) return current
  const found = options.indexOf(current)
  const start = found >= 0 ? found : Math.max(0, options.indexOf(fallback))
  const step = dir === 0 ? 0 : dir > 0 ? 1 : -1
  const next = (((start + step) % n) + n) % n
  const value = options[next]
  return value === undefined ? fallback : value
}

/** Structural subset of the opentui key event navigation cares about. */
export interface SettingsNavKey {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export interface SettingsNavState {
  index: number
  count: number
  /** Rows stepped by PgUp/PgDn. */
  pageSize: number
  /** True while the filter query is empty — enables j/k/g/G as navigation. */
  vim: boolean
}

/**
 * Resolve a navigation key to the next index (CLAMPED at the ends, no wrap),
 * or null when the key is not a navigation key. `up`/`down` step ±1,
 * `pageup`/`pgup` and `pagedown`/`pgdn` step ±pageSize, `home`/`end` jump.
 * While `vim` is true (filter empty) `k`/`j` step ±1 and `g`/`G` jump; while
 * `vim` is false they are ordinary printable filter characters and return
 * null. Modifiers do not change the intent.
 */
export function stepIndex(key: SettingsNavKey, s: SettingsNavState): number | null {
  let delta: number | null = null
  let absolute: number | null = null
  switch (key.name) {
    case "up":
      delta = -1
      break
    case "down":
      delta = 1
      break
    case "pageup":
    case "pgup":
      delta = -s.pageSize
      break
    case "pagedown":
    case "pgdn":
      delta = s.pageSize
      break
    case "home":
      absolute = 0
      break
    case "end":
      absolute = s.count - 1
      break
    default:
      if (!s.vim) return null
      if (key.name === "k") delta = -1
      else if (key.name === "j") delta = 1
      else if (key.name === "g") absolute = key.shift === true ? s.count - 1 : 0
      else if (key.name === "G") absolute = s.count - 1
      else return null
  }
  if (s.count <= 0) return 0
  const next = absolute ?? s.index + (delta ?? 0)
  return Math.max(0, Math.min(next, s.count - 1))
}
