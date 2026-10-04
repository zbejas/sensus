import { describe, expect, test } from "bun:test"
import {
  ENTRANCE_MAX_AGE_MS,
  ENTRANCE_MS,
  createEntranceTracker,
  easeOutCubic,
  entranceActive,
  entranceProgress,
  entranceSlide,
} from "../../../../src/ui/chat/entrance.ts"

describe("entrance timing (pure)", () => {
  test("easeOutCubic starts at 0, lands at 1, and is monotonic", () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
    let prev = -1
    for (let i = 0; i <= 10; i++) {
      const v = easeOutCubic(i / 10)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  test("entranceProgress: null/disabled are instant; timing eases to 1", () => {
    expect(entranceProgress(null, 1000)).toBe(1)
    expect(entranceProgress(0, 0, false)).toBe(1)
    expect(entranceProgress(0, 0)).toBe(0)
    expect(entranceProgress(0, ENTRANCE_MS)).toBe(1)
    const mid = entranceProgress(0, ENTRANCE_MS / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(entranceActive(mid)).toBe(true)
    expect(entranceActive(1)).toBe(false)
  })

  test("entranceSlide is a bounded 1-cell slide that never overshoots", () => {
    expect(entranceSlide(0)).toBe(1)
    expect(entranceSlide(1)).toBe(0)
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const s = entranceSlide(p)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe("createEntranceTracker (once per recent message)", () => {
  test("a recent id animates once; repeats, old messages, and disabled are null", () => {
    const track = createEntranceTracker()
    const now = Date.now()
    const first = track(1, now, true)
    expect(typeof first).toBe("number")
    // The streaming block remounts per delta — the same id must not replay.
    expect(track(1, now, true)).toBeNull()
    // Historical / resumed messages are too old to animate.
    expect(track(2, now - ENTRANCE_MAX_AGE_MS - 5000, true)).toBeNull()
    // A different recent message still animates.
    expect(typeof track(3, now, true)).toBe("number")
    // chat.animations: false → never animate.
    expect(track(4, now, false)).toBeNull()
  })
})
