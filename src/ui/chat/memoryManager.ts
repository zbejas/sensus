/**
 * Memory manager (M?/Phase 1.4) pure helpers — the rail list, usage/entry row
 * formatting, the bounded preview builder, and the single-line draft-edit
 * reducer. Extracted so the overlay's non-render behavior is unit-tested
 * without a renderer (docs/testing.md "non-render behavior lives in pure
 * helpers").
 *
 * The component (ui/components/MemoryManager.tsx) owns only signals + wiring;
 * every string/geometry decision that can be tested lives here.
 */

import { type MemoryTarget, type MemoryUsage } from "../../engine/index.ts"
import { cps, truncateWithEllipsis } from "../../core/util.ts"

/** Which pane owns the keyboard focus in the manager overlay. */
export type MemoryPane = "rail" | "detail"

/** One row of the left rail: one memory store + its display label + file. */
export interface MemoryRailItem {
  target: MemoryTarget
  /** User-visible rail label. */
  label: string
  /** File name under the memory dir (footer/title context). */
  file: string
}

/**
 * The left rail, top to bottom (docs/memory.md): MEMORY is injected into the
 * system prompt, HOST/JOURNAL are tool-only. The labels are user-visible and
 * exact; the detail pane keys off `target`.
 */
export const MEMORY_RAIL: readonly MemoryRailItem[] = [
  { target: "memory", label: "Memory", file: "MEMORY.md" },
  { target: "host", label: "Host map", file: "HOST.md" },
  { target: "journal", label: "Journal", file: "JOURNAL.md" },
] as const

/** Characters in one entry, using the SAME accounting as the store's cap
 * (UTF-16 code units, trimmed) so the row's count matches what is written. */
export function entryCharCount(entry: string): number {
  return entry.trim().length
}

/** First line of an entry, trimmed, for a one-line row preview. */
export function entryPreview(entry: string): string {
  const first = entry.split("\n")[0] ?? ""
  return first.trim()
}

/** The usage line: `used/limit chars · N% · M entry|entries`. */
export function formatUsage(usage: MemoryUsage): string {
  const word = usage.entries === 1 ? "entry" : "entries"
  return `${usage.used}/${usage.limit} chars · ${usage.percent}% · ${usage.entries} ${word}`
}

/**
 * One detail row for an entry, padded/truncated to a fixed `budget` cells
 * (stale-paint rule) with the `❯` arrow marker when selected and the entry's
 * character count right-aligned. The caller paints fg/bg from
 * `overlayRowStyle`; this helper owns only the text cells.
 */
export function formatEntryRow(entry: string, index: number, selected: boolean, budget: number): string {
  const b = Math.max(0, budget)
  const prefix = selected ? " ❯ " : "   "
  const suffix = ` ${entryCharCount(entry)}c`
  const label = `${index + 1}. ${entryPreview(entry)}`
  const avail = Math.max(0, b - prefix.length - suffix.length)
  const shown = avail > 0 ? truncateWithEllipsis(label, avail) : ""
  const pad = " ".repeat(Math.max(0, b - prefix.length - cps(shown).length - suffix.length))
  return `${prefix}${shown}${pad}${suffix}`
}

/**
 * Exactly `rows` preview lines, each truncated/padded to a fixed `width`
 * (stale-paint rule): a bounded detail area for the selected entry's full
 * text. Missing lines are blank.
 */
export function previewLines(text: string, rows: number, width: number): string[] {
  const w = Math.max(0, width)
  const source = text.length > 0 ? text.split("\n") : []
  const out: string[] = []
  for (let i = 0; i < Math.max(0, rows); i++) {
    const raw = source[i] ?? ""
    out.push(cps(raw).slice(0, w).join("").padEnd(w))
  }
  return out
}

// ---- single-line draft editor -------------------------------------------------

/** A single-line edit draft: text + a CODEPOINT cursor index. */
export interface MemoryDraft {
  text: string
  cursor: number
}

/** The draft-edit actions the manager's single-line editor handles. */
export type MemoryDraftEdit =
  | { type: "insert"; char: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "clear" }

/** Start editing `text` with the cursor at the end (SettingsScreen parity). */
export function startDraft(text: string): MemoryDraft {
  return { text, cursor: cps(text).length }
}

function clampCursor(cursor: number, len: number): number {
  return Math.max(0, Math.min(cursor, len))
}

/**
 * Apply one edit action, returning the next draft. Codepoint-aware so
 * multi-unit characters (emoji/CJK) move/delete as one cell. Never throws.
 */
export function editDraft(draft: MemoryDraft, action: MemoryDraftEdit): MemoryDraft {
  const chars = cps(draft.text)
  const c = clampCursor(draft.cursor, chars.length)
  switch (action.type) {
    case "insert": {
      const ins = cps(action.char)
      if (ins.length === 0) return { ...draft, cursor: c }
      return { text: chars.slice(0, c).concat(ins, chars.slice(c)).join(""), cursor: c + ins.length }
    }
    case "backspace": {
      if (c === 0) return { ...draft, cursor: c }
      return { text: chars.slice(0, c - 1).concat(chars.slice(c)).join(""), cursor: c - 1 }
    }
    case "delete": {
      if (c >= chars.length) return { ...draft, cursor: c }
      return { text: chars.slice(0, c).concat(chars.slice(c + 1)).join(""), cursor: c }
    }
    case "left":
      return { ...draft, cursor: Math.max(0, c - 1) }
    case "right":
      return { ...draft, cursor: Math.min(chars.length, c + 1) }
    case "home":
      return { ...draft, cursor: 0 }
    case "end":
      return { ...draft, cursor: chars.length }
    case "clear":
      return { text: "", cursor: 0 }
    default:
      return draft
  }
}

/** The committed text of a draft (callers trim/validate before writing). */
export function commitDraft(draft: MemoryDraft): string {
  return draft.text
}

/** Split a draft for cursor rendering: before + the char under the cursor
 * (a space at end-of-line) + after. */
export function draftParts(draft: MemoryDraft): { before: string; cursor: string; after: string } {
  const chars = cps(draft.text)
  const c = clampCursor(draft.cursor, chars.length)
  return {
    before: chars.slice(0, c).join(""),
    cursor: chars[c] ?? " ",
    after: chars.slice(c + 1).join(""),
  }
}
