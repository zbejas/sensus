/**
 * First-run onboarding model (src/ui/chat/welcome.ts): the page list, the
 * navigation clamp and the hotkey cheat sheet — pure, no renderer.
 */

import { describe, expect, test } from "bun:test"
import {
  WELCOME_CARD_HEIGHT,
  WELCOME_CARD_WIDTH,
  WELCOME_KEYS,
  WELCOME_PAGES,
  welcomeCardSize,
  welcomeStep,
} from "../../../../src/ui/chat/welcome.ts"

describe("welcome onboarding model", () => {
  test("pages cover layout and keys in order", () => {
    expect(WELCOME_PAGES.map((p) => p.id)).toEqual(["layout", "keys"])
    for (const page of WELCOME_PAGES) {
      expect(page.title.length).toBeGreaterThan(0)
      expect(page.blurb.length).toBeGreaterThan(0)
    }
  })

  test("welcomeStep advances/rewinds and clamps at both ends", () => {
    // Default count = WELCOME_PAGES.length (two pages now).
    expect(welcomeStep(0, 1)).toBe(1)
    expect(welcomeStep(1, 1)).toBe(1) // last page clamps (the component closes instead)
    expect(welcomeStep(1, -1)).toBe(0)
    expect(welcomeStep(0, -1)).toBe(0) // first page clamps
    // An explicit count still clamps generically.
    expect(welcomeStep(1, 1, 3)).toBe(2)
    expect(welcomeStep(2, 1, 3)).toBe(2)
  })

  test("welcomeStep is defensive about a weird index or an empty page list", () => {
    expect(welcomeStep(-5, 1, 3)).toBe(0)
    expect(welcomeStep(Number.NaN, 1, 3)).toBe(1)
    expect(welcomeStep(0, 1, 0)).toBe(0)
  })

  test("the cheat sheet names unique keys with a description each", () => {
    expect(WELCOME_KEYS.length).toBeGreaterThan(0)
    const keys = WELCOME_KEYS.map((k) => k.keys)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of WELCOME_KEYS) {
      expect(entry.keys.length).toBeGreaterThan(0)
      expect(entry.what.length).toBeGreaterThan(0)
    }
  })
})

describe("welcomeCardSize (compact tour card leaves the live UI visible)", () => {
  test("uses the preferred compact size on a roomy terminal", () => {
    const card = welcomeCardSize({ width: 200, height: 50 })
    expect(card.width).toBe(WELCOME_CARD_WIDTH)
    expect(card.height).toBe(WELCOME_CARD_HEIGHT)
    // Deliberately smaller than the bounded-large overlay default (90% × 85%).
    expect(card.width).toBeLessThan(200 * 0.9)
    expect(card.height).toBeLessThan(50 * 0.85)
  })

  test("shrinks on a narrow terminal so the interface still shows around it", () => {
    const card = welcomeCardSize({ width: 120, height: 40 })
    expect(card.width).toBeLessThan(WELCOME_CARD_WIDTH)
    expect(card.width).toBeLessThanOrEqual(Math.floor(120 * 0.55) + 1)
    // The rail (24 cols) or topbar stays visible on at least one side.
    expect(card.width).toBeLessThan(120)
  })

  test("never spills past the frame and stays drawable at the 20x5 minimum", () => {
    const card = welcomeCardSize({ width: 20, height: 5 })
    expect(card.width).toBeLessThanOrEqual(18)
    expect(card.height).toBeLessThanOrEqual(3)
    expect(card.width).toBeGreaterThanOrEqual(8)
    expect(card.height).toBeGreaterThanOrEqual(3)
  })
})
