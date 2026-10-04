/**
 * ArmGuard (src/ui/lib/armGuard.ts): the double-confirm arm/timer state used by
 * the streaming-tab close and the mid-work rewind. The clock is a seam so the
 * auto-disarm window is deterministic (mirrors prefix.test.ts).
 */

import { describe, expect, test } from "bun:test"
import { ArmGuard } from "../../../../src/ui/lib/armGuard.ts"

interface FakeClock {
  schedule(fn: () => void, ms: number): unknown
  unschedule(handle: unknown): void
  fire(): void
  lastDelay(): number
  cancelCount(): number
}

function fakeClock(): FakeClock {
  let fn: (() => void) | null = null
  let delay = 0
  let cancelled = 0
  return {
    schedule: (f, ms) => {
      fn = f
      delay = ms
      return f
    },
    unschedule: () => {
      cancelled++
      fn = null
    },
    fire: () => {
      const f = fn
      fn = null
      f?.()
    },
    lastDelay: () => delay,
    cancelCount: () => cancelled,
  }
}

function guardWithClock(windowMs: number): { guard: ArmGuard; clock: FakeClock } {
  const clock = fakeClock()
  const guard = new ArmGuard({ windowMs, schedule: clock.schedule, unschedule: clock.unschedule })
  return { guard, clock }
}

describe("ArmGuard", () => {
  test("arm marks only the target armed and schedules the configured window", () => {
    const { guard, clock } = guardWithClock(3000)
    expect(guard.isArmed(7)).toBe(false)
    guard.arm(7)
    expect(guard.isArmed(7)).toBe(true)
    expect(guard.isArmed(8)).toBe(false)
    expect(clock.lastDelay()).toBe(3000)
  })

  test("re-arming replaces the target and cancels the older window", () => {
    const { guard, clock } = guardWithClock(3500)
    guard.arm(1)
    guard.arm(2)
    expect(guard.isArmed(1)).toBe(false)
    expect(guard.isArmed(2)).toBe(true)
    expect(clock.cancelCount()).toBe(1)
  })

  test("the window auto-disarms when it fires", () => {
    const { guard, clock } = guardWithClock(3000)
    guard.arm(5)
    clock.fire()
    expect(guard.isArmed(5)).toBe(false)
    // A second fire is inert (no pending window).
    clock.fire()
    expect(guard.isArmed(5)).toBe(false)
  })

  test("clear disarms immediately and cancels the pending window", () => {
    const { guard, clock } = guardWithClock(3500)
    guard.arm(3)
    guard.clear()
    expect(guard.isArmed(3)).toBe(false)
    expect(clock.cancelCount()).toBe(1)
    clock.fire()
    expect(guard.isArmed(3)).toBe(false)
  })
})
