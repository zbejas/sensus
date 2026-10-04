/**
 * Context inspector pure-helper tests (Phase 3.1, docs/agent.md "Context
 * inspector"): the labelled breakdown rows, the text-cell usage bar, the
 * bounded history-row formatting, and the window math. No renderer — the
 * component only wires these to signals.
 */

import { describe, expect, test } from "bun:test"
import {
  breakdownRows,
  emptyContextBreakdown,
  firstLine,
  formatContextBreakdown,
  formatHistoryRow,
  historyPreview,
  historyRoleTag,
  historyWindow,
  messagePreview,
  toolCallSummary,
  usageBar,
  type ContextBreakdown,
  type ContextHistoryEntry,
} from "../../../../src/engine/chat/contextInspector.ts"
import { cps } from "../../../../src/core/util.ts"

const entry = (role: string, preview: string, tokens = 10): ContextHistoryEntry => ({ role, preview, tokens })

const base: ContextBreakdown = {
  model: "main@gpt-test",
  limit: 128_000,
  used: 42_000,
  percent: 33,
  systemTokens: 1_200,
  historyTokens: 30_000,
  toolSpecTokens: 1_500,
  mcpSpecTokens: 400,
  messages: 7,
  compactions: 2,
  cacheRead: 9_000,
  cacheWrite: 1_000,
  cachePrompt: 10_000,
  pinned: false,
  enabled: true,
  note: null,
  history: [entry("user", "hi"), entry("assistant", "hello")],
}

describe("breakdown rows", () => {
  test("labels the occupancy, decomposition, counts and cache in a fixed order", () => {
    const rows = breakdownRows(base)
    expect(rows.map((r) => r.label)).toEqual([
      "model",
      "window limit",
      "used",
      "system prompt",
      "durable history",
      "tool specs",
      "mcp specs",
      "messages",
      "compactions",
      "cache read",
      "cache write",
    ])
    expect(rows[0]).toEqual({ label: "model", value: "main@gpt-test" })
    expect(rows[1]?.value).toBe("128.0k")
    expect(rows[2]?.value).toBe("42.0k · 33%")
    expect(rows[7]?.value).toBe("7")
    expect(rows[8]?.value).toBe("2")
    // cache read/write show the cached/total split.
    expect(rows[9]?.value).toBe("9.0k / 10.0k")
    expect(rows[10]?.value).toBe("1.0k / 10.0k")
  })

  test("pinned adds the capacity tag; unreported cache degrades to dashes; empty model/limit safe", () => {
    const pinned = breakdownRows({ ...base, pinned: true })
    expect(pinned[2]?.value).toContain("at capacity")
    const noCache = breakdownRows({ ...base, cacheRead: 0, cacheWrite: 0, cachePrompt: 0 })
    expect(noCache[9]?.value).toBe("— / —")
    expect(noCache[10]?.value).toBe("— / —")
    const empty = breakdownRows({ ...base, model: "", limit: 0, percent: 0, used: 0 })
    expect(empty[0]?.value).toBe("(none)")
    expect(empty[1]?.value).toBe("unknown")
  })

  test("formatContextBreakdown joins the rows as label: value lines", () => {
    const text = formatContextBreakdown(base)
    const lines = text.split("\n")
    expect(lines).toHaveLength(11)
    expect(lines[0]).toBe("model: main@gpt-test")
    expect(lines[2]).toBe("used: 42.0k · 33%")
  })

  test("emptyContextBreakdown is a zeroed disabled snapshot carrying a note", () => {
    const b = emptyContextBreakdown("reconstructed from the saved transcript")
    expect(b.enabled).toBe(false)
    expect(b.used).toBe(0)
    expect(b.history).toEqual([])
    expect(b.note).toBe("reconstructed from the saved transcript")
  })
})

describe("usage bar", () => {
  test("paints a fixed-width bar; over-limit clamps the fill at 100%", () => {
    const half = usageBar(50, 10)
    expect(half.filled).toHaveLength(5)
    expect(half.empty).toHaveLength(5)
    expect(half.fillPercent).toBe(50)
    const over = usageBar(250, 10)
    expect(over.filled).toHaveLength(10)
    expect(over.empty).toHaveLength(0)
    expect(over.fillPercent).toBe(100)
    // Defensive: NaN/negative never throw and produce an empty fill.
    const bad = usageBar(Number.NaN, 8)
    expect(bad.filled).toHaveLength(0)
    expect(bad.empty).toHaveLength(8)
    expect(usageBar(0, 0)).toEqual({ filled: "", empty: "", fillPercent: 0 })
  })
})

describe("durable-history rows", () => {
  test("fixed cell budget, arrow marker, role tag and token suffix", () => {
    const row = entry("assistant", "a first line that should be truncated when the budget is small", 1234)
    const selected = formatHistoryRow(row, 0, true, 30)
    const unselected = formatHistoryRow(row, 0, false, 30)
    expect(cps(selected)).toHaveLength(30)
    expect(cps(unselected)).toHaveLength(30)
    expect(selected.startsWith(" ❯ ")).toBe(true)
    expect(unselected.startsWith("   ")).toBe(true)
    expect(selected).toContain("[assistant]")
    expect(selected.endsWith(" 1.2k")).toBe(true)
  })

  test("blank previews read (empty); unknown roles still render", () => {
    expect(historyPreview(entry("tool", "   "))).toBe("(empty)")
    expect(historyRoleTag("")).toBe("[?]")
    expect(historyRoleTag("tool")).toBe("[tool]")
    const row = formatHistoryRow(entry("tool", ""), 3, false, 24)
    expect(row).toContain("[tool]")
    expect(row).toContain("(empty)")
    expect(cps(row)).toHaveLength(24)
  })

  test("firstLine skips leading blank lines and trims", () => {
    expect(firstLine("")).toBe("")
    expect(firstLine("\n\n  second line here \nthird")).toBe("second line here")
  })
})

describe("tool-call previews", () => {
  test("toolCallSummary collapses repeats, preserves order, and is empty for none", () => {
    expect(toolCallSummary([])).toBe("")
    expect(toolCallSummary(["run_command"])).toBe("→ run_command")
    expect(toolCallSummary(["run_command", "read_file", "run_command"])).toBe("→ run_command ×2, read_file")
    // Defensive: blank names degrade to "?" without throwing.
    expect(toolCallSummary(["  "])).toBe("→ ?")
  })

  test("messagePreview combines content + calls + images, and stays empty only when all are absent", () => {
    // A reasoning/tool-only turn now reads as its tools, not "(empty)".
    expect(messagePreview("", ["run_command", "run_command", "read_file"])).toBe("→ run_command ×2, read_file")
    expect(messagePreview("  ", ["run_command"])).toBe("→ run_command")
    expect(messagePreview("first line\nmore", ["read_file"], 2)).toBe("first line · → read_file · [2 images]")
    expect(messagePreview("look", [], 1)).toBe("look · [1 image]")
    expect(messagePreview("", [], 0)).toBe("")
    // The empty preview still degrades to the "(empty)" row note.
    expect(historyPreview(entry("assistant", messagePreview("", [])))).toBe("(empty)")
  })
})

describe("history window", () => {
  test("clamps selection and slides a bounded window; empty list is safe", () => {
    expect(historyWindow(0, 5, 4)).toEqual({ start: 0, list: 0, sel: 0 })
    expect(historyWindow(3, 99, 4)).toEqual({ start: 0, list: 3, sel: 2 })
    // 20 rows, 3 visible, selection 19 -> window at the end.
    expect(historyWindow(20, 19, 3)).toEqual({ start: 17, list: 3, sel: 19 })
    // Selection near the middle -> centred-ish window.
    expect(historyWindow(20, 2, 3)).toEqual({ start: 1, list: 3, sel: 2 })
    expect(historyWindow(2, 0, 8)).toEqual({ start: 0, list: 2, sel: 0 })
  })
})
