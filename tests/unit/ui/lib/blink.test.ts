/** Unit tests for the shared blink decision (pure logic). */

import { describe, expect, test } from "bun:test"
import { BLINK_PERIOD_MS, SOLID_AFTER_ACTIVITY_MS, blinkOn, caretVisible, reducedMotionEnv, setBlinkAnimations } from "../../../../src/ui/lib/blink.ts"

describe("caretVisible", () => {
  test("the ON phase is always visible; the OFF phase holds solid after activity, then expires", () => {
    expect(caretVisible(true, 0, 1_000_000)).toBe(true)
    // Solid window right after activity (typing / cursor moves).
    const now = 50_000
    expect(caretVisible(false, now - 10, now)).toBe(true)
    expect(caretVisible(false, now - SOLID_AFTER_ACTIVITY_MS + 1, now)).toBe(true)
    // The window expires at exactly SOLID_AFTER_ACTIVITY_MS; old activity stays hidden.
    expect(caretVisible(false, now - SOLID_AFTER_ACTIVITY_MS, now)).toBe(false)
    expect(caretVisible(false, 0, SOLID_AFTER_ACTIVITY_MS + 5000)).toBe(false)
  })

  test("period constants are sane (sub-second blink; the solid window outlasts a phase)", () => {
    expect(BLINK_PERIOD_MS).toBeGreaterThan(100)
    expect(BLINK_PERIOD_MS).toBeLessThan(1000)
    expect(SOLID_AFTER_ACTIVITY_MS).toBeGreaterThan(BLINK_PERIOD_MS)
  })
})

describe("caret blink gating (chat.animations / reduced motion)", () => {
  test("animations disabled keeps the caret solid regardless of phase or activity; enabled preserves the blink", () => {
    // OFF phase far past any activity: hidden when animating, solid when not.
    expect(caretVisible(false, 0, 1_000_000, false)).toBe(true)
    expect(caretVisible(false, 0, 1_000_000, true)).toBe(false)
    // ON phase is visible either way, and the default stays animated.
    expect(caretVisible(true, 0, 1_000_000, false)).toBe(true)
    expect(caretVisible(false, 0, 1_000_000)).toBe(false)
  })

  test("SENSUS_REDUCED_MOTION parses truthy spellings and ignores unset/falsey values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      expect(reducedMotionEnv({ SENSUS_REDUCED_MOTION: v })).toBe(true)
    }
    for (const v of [undefined, "", "0", "false", "no", "off"]) {
      expect(reducedMotionEnv({ SENSUS_REDUCED_MOTION: v })).toBe(false)
    }
  })

  test("setBlinkAnimations(false) makes the reactive blinkOn() solid", () => {
    setBlinkAnimations(false)
    try {
      expect(blinkOn()).toBe(true)
    } finally {
      setBlinkAnimations(true)
    }
  })
})
