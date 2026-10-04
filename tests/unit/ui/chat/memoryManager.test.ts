import { describe, expect, test } from "bun:test"
import type { MemoryUsage } from "../../../../src/agent/memory/types.ts"
import {
  MEMORY_RAIL,
  commitDraft,
  draftParts,
  editDraft,
  entryCharCount,
  entryPreview,
  formatEntryRow,
  formatUsage,
  previewLines,
  startDraft,
  type MemoryDraft,
} from "../../../../src/ui/chat/memoryManager.ts"

const usage = (over: Partial<MemoryUsage> = {}): MemoryUsage => ({
  target: "memory",
  used: 474,
  limit: 2200,
  percent: 21,
  entries: 3,
  ...over,
})

describe("memoryManager rail + usage helpers", () => {
  test("the rail is MEMORY · HOST.md · JOURNAL.md with stable targets", () => {
    expect(MEMORY_RAIL.map((r) => r.target)).toEqual(["memory", "host", "journal"])
    expect(MEMORY_RAIL.map((r) => r.file)).toEqual(["MEMORY.md", "HOST.md", "JOURNAL.md"])
    expect(MEMORY_RAIL.map((r) => r.label)).toEqual(["Memory", "Host map", "Journal"])
  })

  test("formatUsage renders the used/limit · percent · entries line", () => {
    expect(formatUsage(usage())).toBe("474/2200 chars · 21% · 3 entries")
    expect(formatUsage(usage({ entries: 1 }))).toBe("474/2200 chars · 21% · 1 entry")
    expect(formatUsage(usage({ used: 0, percent: 0, entries: 0 }))).toBe("0/2200 chars · 0% · 0 entries")
  })

  test("entryCharCount matches the store's trimmed UTF-16 cap accounting", () => {
    expect(entryCharCount("hello")).toBe(5)
    expect(entryCharCount("  spaced  ")).toBe(6)
    expect(entryCharCount("line one\nline two")).toBe(17)
  })

  test("entryPreview is the trimmed first line", () => {
    expect(entryPreview("  first line  \nsecond")).toBe("first line")
    expect(entryPreview("\n\nonly")).toBe("")
  })

})

describe("formatEntryRow", () => {
  const entry = "shell is zsh with a long convention note that overflows the row"

  test("always occupies exactly the fixed cell budget", () => {
    for (const selected of [true, false]) {
      const row = formatEntryRow(entry, 0, selected, 40)
      expect([...row].length).toBe(40)
    }
  })

  test("marks the selected row with the arrow and every row with its char count", () => {
    const selected = formatEntryRow("short entry", 2, true, 40)
    expect(selected.startsWith(" ❯ 3. short entry")).toBe(true)
    expect(selected.trimEnd().endsWith("11c")).toBe(true)
    const unselected = formatEntryRow("short entry", 2, false, 40)
    expect(unselected.startsWith("   3. short entry")).toBe(true)
  })

  test("truncates the preview to keep the right-aligned count inside the budget", () => {
    const row = formatEntryRow(entry, 0, false, 30)
    expect([...row].length).toBe(30)
    expect(row.endsWith("c")).toBe(true)
    expect(row.includes("…")).toBe(true)
  })

  test("degrades on a tiny budget without throwing", () => {
    const row = formatEntryRow("x", 0, true, 2)
    expect(row.length).toBeGreaterThan(0)
  })
})

describe("previewLines (bounded detail area)", () => {
  test("returns exactly `rows` lines, each padded to `width`", () => {
    const lines = previewLines("a\nbb\nccc", 5, 4)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe("a   ")
    expect(lines[1]).toBe("bb  ")
    expect(lines[2]).toBe("ccc ")
    expect(lines[3]).toBe("    ")
    expect(lines[4]).toBe("    ")
  })

  test("truncates long lines to the fixed width and handles empty text", () => {
    expect(previewLines("abcdefgh", 1, 3)).toEqual(["abc"])
    expect(previewLines("", 2, 3)).toEqual(["   ", "   "])
  })
})

describe("draft reducer (single-line editor)", () => {
  test("startDraft seeds the text with the cursor at the end", () => {
    expect(startDraft("hello")).toEqual({ text: "hello", cursor: 5 })
  })

  test("insert edits at the cursor and advances it", () => {
    const d = editDraft({ text: "ac", cursor: 1 }, { type: "insert", char: "b" })
    expect(d).toEqual({ text: "abc", cursor: 2 })
    // Append at the end.
    expect(editDraft(startDraft("ab"), { type: "insert", char: "c" })).toEqual({ text: "abc", cursor: 3 })
  })

  test("backspace deletes before the cursor; at column 0 it is a no-op", () => {
    expect(editDraft({ text: "abc", cursor: 2 }, { type: "backspace" })).toEqual({ text: "ac", cursor: 1 })
    expect(editDraft({ text: "abc", cursor: 0 }, { type: "backspace" })).toEqual({ text: "abc", cursor: 0 })
  })

  test("delete removes the char under the cursor; at the end it is a no-op", () => {
    expect(editDraft({ text: "abc", cursor: 1 }, { type: "delete" })).toEqual({ text: "ac", cursor: 1 })
    expect(editDraft({ text: "abc", cursor: 3 }, { type: "delete" })).toEqual({ text: "abc", cursor: 3 })
  })

  test("left/right/home/end move the cursor and clamp at the ends", () => {
    const d: MemoryDraft = { text: "abc", cursor: 1 }
    expect(editDraft(d, { type: "left" }).cursor).toBe(0)
    expect(editDraft({ text: "abc", cursor: 0 }, { type: "left" }).cursor).toBe(0)
    expect(editDraft(d, { type: "right" }).cursor).toBe(2)
    expect(editDraft({ text: "abc", cursor: 3 }, { type: "right" }).cursor).toBe(3)
    expect(editDraft(d, { type: "home" }).cursor).toBe(0)
    expect(editDraft(d, { type: "end" }).cursor).toBe(3)
  })

  test("clear empties the draft", () => {
    expect(editDraft({ text: "abc", cursor: 2 }, { type: "clear" })).toEqual({ text: "", cursor: 0 })
  })

  test("is codepoint-aware for multi-unit characters", () => {
    // "👋" is one codepoint (two UTF-16 units): inserting it advances by one.
    const inserted = editDraft(startDraft(""), { type: "insert", char: "👋" })
    expect(inserted).toEqual({ text: "👋", cursor: 1 })
    // Backspacing it removes the whole glyph.
    expect(editDraft(inserted, { type: "backspace" })).toEqual({ text: "", cursor: 0 })
  })

  test("draftParts splits around the cursor, space at end-of-line", () => {
    expect(draftParts({ text: "abc", cursor: 1 })).toEqual({ before: "a", cursor: "b", after: "c" })
    expect(draftParts({ text: "ab", cursor: 2 })).toEqual({ before: "ab", cursor: " ", after: "" })
  })

  test("commitDraft returns the raw draft text", () => {
    expect(commitDraft({ text: "  keep  ", cursor: 2 })).toBe("  keep  ")
  })
})
