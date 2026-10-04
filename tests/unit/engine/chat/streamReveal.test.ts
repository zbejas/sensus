/**
 * Stream-reveal smoothing tests (docs/agent.md "Streaming display"): the
 * typewriter pour that turns burst deltas into a paced reveal. Pure logic —
 * the clock and the tick reader are injected, so every step is deterministic.
 */

import { describe, expect, test } from "bun:test"
import {
  advanceReveal,
  clampRevealCut,
  revealCut,
  REVEAL_MAX_ELAPSED_MS,
  REVEAL_MAX_STEP,
  REVEAL_MIN_STEP,
  REVEAL_SETTLED_MIN_STEP,
  REVEAL_TICK_MS,
  StreamReveal,
  type RevealState,
} from "../../../../src/engine/chat/streamReveal.ts"

/** Counting tick reader — asserts the conditional-subscription invariant. */
function tickCounter(): { read: () => number; count: () => number } {
  let n = 0
  return { read: () => ++n, count: () => n }
}

const st = (revealed = 0): RevealState => ({ revealed, lastAt: 0 })

describe("advanceReveal (step math)", () => {
  test("ease-out per tick: the live floor, proportional catch-up, and the bounded max cap", () => {
    // backlog 6 -> proportional 2 -> the live floor (~25 chars/s minimum).
    expect(advanceReveal(st(), 6, REVEAL_TICK_MS).revealed).toBe(REVEAL_MIN_STEP)
    // backlog 100 -> 18% of the backlog per tick (the ease-out).
    expect(advanceReveal(st(), 100, REVEAL_TICK_MS).revealed).toBe(18)
    // backlog 100k -> pours at MAX_STEP, never snaps the whole burst.
    expect(advanceReveal(st(), 100_000, REVEAL_TICK_MS).revealed).toBe(REVEAL_MAX_STEP)
  })

  test("charged time: settled drains faster than live, long gaps clamp, same-ms still moves, completion is stable", () => {
    // The settled floor outruns the live floor for the same backlog.
    const live = advanceReveal(st(), 400, REVEAL_TICK_MS)
    const settled = advanceReveal(st(), 400, REVEAL_TICK_MS, { settled: true })
    expect(settled.revealed).toBe(Math.min(400, REVEAL_SETTLED_MIN_STEP))
    expect(settled.revealed).toBeGreaterThan(live.revealed)
    // A 60s gap (hidden tab, stalled loop) is charged as 160ms -> 2 ticks:
    // backlog 100 -> 18 chars/tick * 2, not one giant jump.
    const clamped = advanceReveal(st(), 100, 60_000)
    expect(clamped.revealed).toBe(Math.round(18 * (REVEAL_MAX_ELAPSED_MS / REVEAL_TICK_MS)))
    // A same-ms advance still moves one char (the pour never stalls).
    expect(advanceReveal(st(), 100, 0).revealed).toBe(1)
    // Already complete stays complete (and never over-reveals).
    expect(advanceReveal(st(50), 50, REVEAL_TICK_MS)).toEqual({ revealed: 50, lastAt: REVEAL_TICK_MS })
    expect(advanceReveal(st(60), 50, REVEAL_TICK_MS).revealed).toBe(50)
  })
})

describe("clampRevealCut (grapheme safety)", () => {
  test("never cuts inside a grapheme: surrogate pairs, ZWJ families, selectors, combining marks", () => {
    const cases: Array<{ why: string; text: string; cuts: Array<[number, number]> }> = [
      { why: "plain ascii cuts anywhere", text: "hello world", cuts: [[5, 5]] },
      // "a👍b": the emoji is two UTF-16 units; a cut between them pulls back.
      { why: "surrogate pair", text: "a\uD83D\uDC4Db", cuts: [[2, 1], [3, 3]] },
      // "👨‍👩‍👧" = 👨 ZWJ 👩 ZWJ 👧 — any cut inside the family pulls back to 0.
      { why: "ZWJ family", text: "👨\u200d👩\u200d👧", cuts: [[3, 0], [6, 0], [8, 8]] },
      { why: "variation selector", text: "✌\uFE0F", cuts: [[1, 0]] },
      { why: "combining mark", text: "e\u0301x", cuts: [[1, 0], [2, 2]] },
    ]
    for (const { why, text, cuts } of cases) {
      for (const [cut, want] of cuts) {
        // (bun reports file:line on failure; the table below names each case.)
        expect(clampRevealCut(text, cut)).toBe(want)
      }
    }
  })
})

describe("revealCut (stateful pacing)", () => {
  test("the tick is read ONLY while a backlog exists (conditional-subscription invariant)", () => {
    const states = new Map<number, RevealState>()
    const ticks = tickCounter()
    // First sight of existing content snaps whole — no tick, no pour.
    expect(revealCut(states, 7, "already here", ticks.read, 100, true)).toBe(12)
    expect(ticks.count()).toBe(0)
    expect(states.get(7)?.revealed).toBe(12)
    // A fresh streaming bubble starts empty: hidden, no tick.
    expect(revealCut(states, 1, "", ticks.read, 0, false)).toBe(0)
    expect(ticks.count()).toBe(0)
    // First flush: one tick read, a bounded cut — never the whole burst.
    const cut = revealCut(states, 1, "hello streamed reply", ticks.read, REVEAL_TICK_MS, false)
    expect(ticks.count()).toBe(1)
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(20)
    // A long charged gap: floor 2 chars/tick * 2 ticks = the whole 4-char tail…
    expect(revealCut(states, 2, "", ticks.read, 0, false)).toBe(0) // fresh bubble, no tick
    expect(revealCut(states, 2, "abcd", ticks.read, 10_000, true)).toBe(4)
    // …and once caught up the tick stays untouched (idle repaints stay at zero).
    expect(revealCut(states, 2, "abcd", ticks.read, 20_000, true)).toBe(4)
    expect(ticks.count()).toBe(2)
  })

  test("settled drains faster than live for the same backlog; shrunken content clamps defensively", () => {
    const a = new Map<number, RevealState>()
    const b = new Map<number, RevealState>()
    a.set(9, { revealed: 0, lastAt: 0 })
    b.set(9, { revealed: 0, lastAt: 0 })
    expect(revealCut(b, 9, "x".repeat(400), null, REVEAL_TICK_MS, true)).toBeGreaterThan(
      revealCut(a, 9, "x".repeat(400), null, REVEAL_TICK_MS, false),
    )
    // Content that shrank below the tracked reveal never over-reveals.
    const states = new Map<number, RevealState>()
    states.set(4, { revealed: 10, lastAt: 0 })
    expect(revealCut(states, 4, "", null, 0, true)).toBe(0)
    expect(states.get(4)?.revealed).toBe(0)
  })

  test("cuts are grapheme-safe at every step of a mid-pour (caller slices with clampRevealCut)", () => {
    const states = new Map<number, RevealState>()
    states.set(3, { revealed: 0, lastAt: 0 })
    const full = "hi👍!"
    for (let t = 1; t < 60; t++) {
      const cut = revealCut(states, 3, full, null, t * REVEAL_TICK_MS, false)
      const shown = full.slice(0, clampRevealCut(full, cut))
      expect(full.startsWith(shown)).toBe(true)
      expect([...shown].join("")).toBe(shown) // no broken surrogate halves
    }
  })
})

describe("StreamReveal (per-tab state)", () => {
  test("content and thinking channels pour independently; reset snaps every in-flight pour (clear / resume)", () => {
    const reveal = new StreamReveal()
    const tick = (): number => 0
    expect(reveal.content(5, "", tick, 0, false)).toBe(0)
    expect(reveal.thinking(5, "", tick, 0, false)).toBe(0)
    // Same id, two channels: both pour independently (each saw an empty first sight).
    expect(reveal.content(5, "answer text", tick, REVEAL_TICK_MS, false)).toBeLessThan(11)
    expect(reveal.thinking(5, "reasoning text", tick, REVEAL_TICK_MS, false)).toBeLessThan(14)
    // /clear + resume: no message carries pending reveal state — both snap.
    reveal.reset()
    expect(reveal.content(5, "partial", tick, REVEAL_TICK_MS, false)).toBe(7)
    expect(reveal.thinking(5, "reasoning text", tick, REVEAL_TICK_MS, false)).toBe(14)
  })
})
