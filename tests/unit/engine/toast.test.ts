/**
 * Toast pure-logic tests (src/engine/toast.ts): levels → TTL/token/glyph, and
 * the floating panel's wrap math (word wrap, hard split, line cap + ellipsis).
 */

import { describe, expect, test } from "bun:test"
import {
  TOAST_CHROME_X,
  TOAST_MAX_LINES,
  TOAST_MAX_WIDTH,
  defaultTtl,
  shouldPreemptToast,
  toastGlyph,
  toastLines,
  toastPanelWidth,
  toastSeverity,
  toastToken,
  type ToastLevel,
} from "../../../src/engine/toast.ts"

describe("toast levels", () => {
  test("each level carries its TTL, glyph, and theme token (confirmations snappy, problems lingering)", () => {
    // Per-level fixture table (docs/ui.md "Toasts", docs/config.md).
    const LEVELS: Array<[ToastLevel, number, string, ReturnType<typeof toastToken>]> = [
      ["info", 2500, "·", "toast"],
      ["success", 2000, "✓", "success"],
      ["warn", 4000, "⚠", "warning"],
      ["error", 5000, "✗", "danger"],
    ]
    for (const [level, ttl, glyph, token] of LEVELS) {
      expect(defaultTtl(level)).toBe(ttl)
      expect(toastGlyph(level)).toBe(glyph)
      expect(toastToken(level)).toBe(token)
    }
  })

  test("severity ranks info < success < warn < error", () => {
    expect(toastSeverity("info")).toBe(0)
    expect(toastSeverity("success")).toBe(1)
    expect(toastSeverity("warn")).toBe(2)
    expect(toastSeverity("error")).toBe(3)
  })
})

describe("toast slot replacement policy (shouldPreemptToast)", () => {
  test("a lower-severity toast cannot replace a higher one still within its TTL", () => {
    const expires = 10_000
    // A live ERROR is never buried by a lower severity.
    expect(shouldPreemptToast("error", expires, 1_000, "success")).toBe(false)
    expect(shouldPreemptToast("error", expires, 1_000, "warn")).toBe(false)
    expect(shouldPreemptToast("error", expires, 1_000, "info")).toBe(false)
    // Equal severity replaces (newest wins within a level).
    expect(shouldPreemptToast("error", expires, 1_000, "error")).toBe(true)
    expect(shouldPreemptToast("success", expires, 1_000, "success")).toBe(true)
    // Higher severity always wins.
    expect(shouldPreemptToast("info", expires, 1_000, "error")).toBe(true)
    expect(shouldPreemptToast("success", expires, 1_000, "warn")).toBe(true)
    // Only `error` is protected: a warn/success/info never blocks the newest,
    // so a routine confirmation is never swallowed by a lingering warning.
    expect(shouldPreemptToast("warn", expires, 1_000, "info")).toBe(true)
    expect(shouldPreemptToast("success", expires, 1_000, "info")).toBe(true)
    expect(shouldPreemptToast("info", expires, 1_000, "info")).toBe(true)
  })

  test("an expired toast is replaceable by anything (boundary is inclusive)", () => {
    expect(shouldPreemptToast("error", 500, 500, "info")).toBe(true)
    expect(shouldPreemptToast("error", 500, 501, "info")).toBe(true)
    // One tick before expiry the higher severity still holds the slot.
    expect(shouldPreemptToast("error", 500, 499, "info")).toBe(false)
  })
})

describe("toastLines — floating panel wrap math", () => {
  test("word-wraps at the cap width without losing words; \\n breaks hard; overlong words hard-split; tiny widths floor at 8", () => {
    // Short messages stay a single line; empty messages render one blank line.
    expect(toastLines("theme → dark")).toEqual(["theme → dark"])
    expect(toastLines("")).toEqual([""])
    // Long messages word-wrap: every line within the cap, no words lost.
    const msg = "unknown profile \"x\" — pick one of: alpha, beta, gamma, delta"
    const lines = toastLines(msg, 30)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(30)
    expect(lines.join(" ").split(/\s+/)).toEqual(msg.split(/\s+/))
    // An embedded \n is a hard break, and trailing blank lines collapse.
    expect(toastLines("first\nsecond", 40)).toEqual(["first", "second"])
    expect(toastLines("done\n")).toEqual(["done"])
    // Overlong words hard-split into width chunks.
    const hard = toastLines("aaaaaaaaaaaaaaaaaaaaaaaaaa", 10)
    expect(hard.length).toBe(3) // 26 chars / 10 → 10+10+6
    expect(hard.join("")).toBe("a".repeat(26))
    // Widths below 8 floor at 8 columns.
    expect(toastLines("hello world", 2)).toEqual(["hello", "world"])
  })

  test("caps at TOAST_MAX_LINES with an ellipsis only when content was cut; defaults stay in the shipped geometry", () => {
    const capped = toastLines("word ".repeat(40), 10)
    expect(capped.length).toBe(TOAST_MAX_LINES)
    expect([...capped[TOAST_MAX_LINES - 1]!].at(-1)).toBe("…")
    // Exactly-fitting messages get no ellipsis.
    const fits = toastLines("aa bb", 10)
    expect(fits).toEqual(["aa bb"])
    expect(fits.join(" ").at(-1)).not.toBe("…")
    // The default width keeps every real message within the shipped geometry.
    for (const l of toastLines("config reloaded (2 profile(s) · AGENTS.md 1234 chars)")) {
      expect([...l].length).toBeLessThanOrEqual(TOAST_MAX_WIDTH)
    }
  })
})

describe("toastPanelWidth", () => {
  test("panel width = widest line + card chrome, clamped to [10, maxWidth+chrome]; the m10 one-row toast still fits", () => {
    expect(TOAST_CHROME_X).toBe(6) // glyph column (2) + 2 cols padding a side
    expect(toastPanelWidth(["abc"])).toBe(10) // min clamp
    expect(toastPanelWidth(["a".repeat(30)])).toBe(30 + TOAST_CHROME_X)
    expect(toastPanelWidth(["a".repeat(200)])).toBe(TOAST_MAX_WIDTH + TOAST_CHROME_X) // max clamp
    // REGRESSION (m10): a 36-char message + glyph fits ONE row — the panel
    // width must include glyph + box padding or the last word wraps.
    const msg = "chat cleared — old session file kept"
    const lines = toastLines(msg)
    expect(lines).toEqual([msg])
    expect(toastPanelWidth(lines) - 2 * 2).toBeGreaterThanOrEqual(2 + [...msg].length)
  })
})
