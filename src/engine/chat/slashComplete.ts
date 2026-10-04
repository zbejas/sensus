/**
 * Slash-command autocomplete (M8): pure filtering + completion helpers for
 * the chat input menu. No Solid/opentui imports — unit-tested directly.
 *
 * Menu rule: the cursor must sit on the FIRST logical line of the draft and
 * that line must be exactly "/" + token with no whitespace in it (typing a
 * space closes the menu — argument regions are never completed). Matching is
 * a case-insensitive PREFIX match on the command name; no matches = closed.
 */

import { SLASH_COMMANDS, type SlashCommandInfo } from "../../agent/slash.ts"

export interface SlashMenuState {
  /** The token being completed (text after the "/", original case). */
  query: string
  /** Commands whose name starts with the query (case-insensitive). */
  matches: readonly SlashCommandInfo[]
}

/**
 * Autocomplete state for the draft's first line, or null when the menu is
 * closed (cursor elsewhere, non-slash line, argument region, no matches).
 */
export function slashMenuForLine(firstLine: string, cursorOnFirstLine: boolean): SlashMenuState | null {
  if (!cursorOnFirstLine) return null
  if (!firstLine.startsWith("/")) return null
  const token = firstLine.slice(1)
  if (/\s/.test(token)) return null
  const query = token.toLowerCase()
  const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(query))
  if (matches.length === 0) return null
  return { query: token, matches }
}

/**
 * Accept a completion: the first line becomes "/<name> " (trailing space —
 * ready for an argument); the other logical lines are preserved. Returns the
 * new draft text plus where the editor cursor must land (end of the token).
 * Callers must ensure the menu is open (the token is replaced wholesale).
 */
export function acceptCompletion(
  draft: string,
  name: string,
): { text: string; cursorRow: number; cursorCol: number } {
  const lines = draft.split("\n")
  lines[0] = `/${name} `
  return { text: lines.join("\n"), cursorRow: 0, cursorCol: name.length + 2 }
}

/**
 * Hybrid Enter (docs/keybindings.md): true when the typed query already IS a
 * complete command name ("clear" for "/clear") — Enter sends it as-is. A
 * strict prefix ("/cl") completes instead of sending (sending would be an
 * unknown-command error).
 */
export function isExactCommandQuery(query: string): boolean {
  return query.length > 0 && SLASH_COMMANDS.some((c) => c.name === query.toLowerCase())
}

/**
 * Visible window of the match list around the selected row: the menu shows
 * at most `max` rows and slides to keep the selection in view.
 */
export function menuWindow<T>(
  items: readonly T[],
  selected: number,
  max: number,
): { rows: readonly T[]; start: number } {
  const maxRows = Math.max(1, Math.floor(max))
  const sel = Math.max(0, Math.min(Math.floor(selected), items.length - 1))
  const start = Math.max(0, Math.min(sel - maxRows + 1, items.length - maxRows))
  return { rows: items.slice(start, start + maxRows), start }
}
