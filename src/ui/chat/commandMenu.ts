/**
 * Command menu (Ctrl+P) — pure filter/window math over the command registry
 * (src/core/commandCatalog.ts), unit-tested. The overlay (CommandMenu.tsx) renders
 * paletteCommands(); App maps ids through runCommand — the same paths hotkeys
 * use. Hints come from the RESOLVED keymap where an entry has a backing
 * action, so a remapped binding shows correctly (never hardcoded).
 */

import type { KeyActionId, KeySpec } from "../../core/keymap.ts"
import { specLabel } from "../../core/keymap.ts"
import { paletteCommands, CATEGORY_LABELS, type CommandDef } from "../../core/commandCatalog.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"

export type { CommandDef } from "../../core/commandCatalog.ts"

/** The palette rows: visible catalog entries in registry order. */
export function menuRows(): CommandDef[] {
  return paletteCommands()
}

/** The rendered hint for a command: its current keymap binding, or the slash
 * spelling for commands that only exist as commands. */
export function hintFor(def: CommandDef, keymap: Record<KeyActionId, KeySpec>): string {
  if (def.action !== undefined) return specLabel(keymap[def.action])
  return def.slash ?? ""
}

/**
 * Fuzzy-filter the menu on label + description (best score wins; ties keep
 * table order). Empty query returns the full table unchanged.
 */
export function filterCommands(
  commands: readonly CommandDef[],
  query: string,
): CommandDef[] {
  const q = query.toLowerCase()
  if (q.length === 0) return [...commands]
  const scored: Array<{ c: CommandDef; score: number }> = []
  for (const c of commands) {
    const labelScore = fuzzyScore(q, c.label)
    const descScore = fuzzyScore(q, c.description)
    const best =
      labelScore !== null && descScore !== null
        ? Math.max(labelScore, descScore)
        : (labelScore ?? descScore)
    if (best !== null) scored.push({ c, score: best })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.c)
}

/**
 * Sliding window around the selection (mirrors the model picker): the
 * selection stays visible, clamped to the list. Returns the slice bounds and
 * the effective selection (clamped for out-of-range callers).
 */
export function menuWindow(
  count: number,
  sel: number,
  maxRows: number,
): { start: number; list: number; selIdx: number } {
  const selIdx = Math.max(0, Math.min(sel, Math.max(0, count - 1)))
  const rows = Math.max(1, maxRows)
  const start = Math.max(0, Math.min(selIdx - Math.floor(rows / 2), Math.max(0, count - rows)))
  return { start, list: Math.min(rows, count - start), selIdx }
}

/** One row the palette renders: a non-selectable group header or a command
 * (index = the item's position in the caller's array — selection stays
 * item-indexed, headers are render-only). */
export type MenuRenderRow = { kind: "header"; label: string } | { kind: "command"; index: number }

/**
 * Palette render rows for an UNFILTERED view: items grouped under category
 * headers (CATEGORY_LABELS lookup on `categoryOf(item)`), each category
 * CONTIGUOUS (registry order interleaves categories — e.g. reload-config is
 * "settings" but sits after the chat rows), group order = the categories'
 * first appearance — so the Settings group still leads. While a filter is
 * active the caller renders FLAT rows (ranked matches interleave categories;
 * headers would be noise) — the component does that inline.
 */
export function groupedRenderRows<T>(
  items: readonly T[],
  categoryOf: (item: T) => string,
): MenuRenderRow[] {
  const labels = CATEGORY_LABELS as Record<string, string>
  const groups = new Map<string, number[]>() // category → item indices
  items.forEach((item, index) => {
    const cat = categoryOf(item)
    const bucket = groups.get(cat)
    if (bucket === undefined) groups.set(cat, [index])
    else bucket.push(index)
  })
  const rows: MenuRenderRow[] = []
  for (const [cat, indices] of groups) {
    rows.push({ kind: "header", label: labels[cat] ?? cat })
    for (const index of indices) rows.push({ kind: "command", index })
  }
  return rows
}

/**
 * Render-row position of a command index (for windowing the grouped view).
 * Out-of-range commands clamp to the LAST command row (mirrors menuWindow's
 * end-clamp); an empty list yields 0.
 */
export function renderIndexOf(rows: readonly MenuRenderRow[], commandIndex: number): number {
  let last = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r === undefined) break
    if (r.kind === "command") {
      if (r.index === commandIndex) return i
      last = i
    }
  }
  return last
}