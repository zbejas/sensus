/**
 * TerminalScrollback — the pane's scrollbar geometry (docs/terminal-layer.md
 * "Capture & scrollback"). The controller is renderer-free, so a fake VT grid
 * stands in for the embedded renderable: `scroll` clamps, `fingerprint`
 * hashes the visible slice (exactly what the client adapter feeds it). Covers
 * calibration, delta tracking, stale refresh after output, the alternate
 * screen, and the no-op viewport (a fake renderable).
 */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PANE_SCROLLBACK_BYTES,
  TerminalScrollback,
  type ScrollbackViewport,
  type TerminalScrollbackOptions,
} from "../../../src/terminal/scrollback.ts"

/** A terminal-like grid: rows scrolled off the top become history. */
class FakeViewport implements ScrollbackViewport {
  readonly lines: string[]
  viewportRows: number
  pos = 0
  scrollCalls = 0

  constructor(lines: string[], viewportRows: number) {
    this.lines = [...lines]
    this.viewportRows = viewportRows
  }

  get max(): number {
    return Math.max(0, this.lines.length - this.viewportRows)
  }

  scroll(delta: number): void {
    this.scrollCalls++
    this.pos = Math.max(0, Math.min(this.max, this.pos + delta))
  }

  compose(): void {}

  fingerprint(): number {
    let hash = 0x811c9dc5
    for (let i = this.pos; i < this.pos + this.viewportRows; i++) {
      const line = this.lines[i] ?? ""
      for (let j = 0; j < line.length; j++) hash = Math.imul(hash ^ line.charCodeAt(j), 0x01000193)
    }
    return hash >>> 0
  }

  rows(): number {
    return this.viewportRows
  }

  append(count: number, from = this.lines.length): void {
    for (let i = 0; i < count; i++) this.lines.push(`line ${from + i}`)
  }
}

function lines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line ${i}`)
}

function make(opts: Partial<TerminalScrollbackOptions> & { viewport: ScrollbackViewport }): TerminalScrollback {
  return new TerminalScrollback({
    maxScrollbackBytes: DEFAULT_PANE_SCROLLBACK_BYTES,
    ...opts,
  })
}

describe("TerminalScrollback", () => {
  test("calibrates the exact history depth and reports the bar geometry", () => {
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp })
    const info = scroll.info()
    expect(info.ready).toBe(true)
    expect(info.viewport).toBe(10)
    expect(info.total).toBe(100)
    expect(info.position).toBe(90)
    expect(info.pinned).toBe(true)
    // Calibration leaves the viewport pinned to the live bottom.
    expect(vp.pos).toBe(90)
  })

  test("an empty history calibrates without a search and reports no scroll range", () => {
    const vp = new FakeViewport(lines(6), 10)
    const scroll = make({ viewport: vp })
    const info = scroll.info()
    expect(info.total).toBe(10)
    expect(info.position).toBe(0)
    expect(info.pinned).toBe(true)
    // One probe: top is bottom, so the search must not run.
    expect(vp.scrollCalls).toBeLessThanOrEqual(4)
  })

  test("scrollBy tracks rows against the VT clamp and keeps `position` exact", () => {
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp })
    scroll.info()

    scroll.scrollBy(-20)
    expect(vp.pos).toBe(70)
    expect(scroll.info().position).toBe(70)
    expect(scroll.info().pinned).toBe(false)

    // Far above the top: the VT clamps, the model clamps too.
    scroll.scrollBy(-1000)
    expect(vp.pos).toBe(0)
    expect(scroll.info().position).toBe(0)

    // A small step down is relative to the clamped position.
    scroll.scrollBy(5)
    expect(scroll.info().position).toBe(5)
    expect(scroll.info().pinned).toBe(false)

    // Overshooting the bottom re-pins.
    scroll.scrollBy(1000)
    expect(scroll.info().position).toBe(90)
    expect(scroll.info().pinned).toBe(true)
  })

  test("scrollTo jumps and clamps to the measured range", () => {
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp })
    scroll.info()

    scroll.scrollTo(40)
    expect(vp.pos).toBe(40)
    expect(scroll.info().position).toBe(40)
    expect(scroll.info().pinned).toBe(false)

    scroll.scrollTo(-25)
    expect(scroll.info().position).toBe(0)
    scroll.scrollTo(1e9)
    expect(scroll.info().position).toBe(90)
    expect(scroll.info().pinned).toBe(true)
  })

  test("output marks the geometry stale and a due poll re-measures it", () => {
    let now = 0
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp, now: () => now })
    expect(scroll.info().total).toBe(100)

    // 50 new rows while pinned: still pinned, but `total` only refreshes on a
    // due calibration (2.5s while pinned).
    vp.append(50)
    scroll.noteOutput()
    now = 100
    expect(scroll.info().total).toBe(100)
    now = 3000
    const refreshed = scroll.info()
    expect(refreshed.total).toBe(150)
    expect(refreshed.position).toBe(140)
    expect(refreshed.pinned).toBe(true)
  })

  test("output while scrolled up preserves the viewport row, not the bottom", () => {
    let now = 0
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp, now: () => now })
    scroll.info()
    scroll.scrollBy(-30)
    expect(scroll.info().position).toBe(60)

    // Output grows the history; the viewport stays anchored to the same row.
    vp.append(20)
    scroll.noteOutput()
    now = 1000
    const info = scroll.info()
    expect(info.total).toBe(120)
    expect(info.position).toBe(60)
    expect(info.pinned).toBe(false)
    expect(vp.pos).toBe(60)
  })

  test("a native scroll (wheel) is tracked exactly like scrollBy", () => {
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp })
    scroll.info()
    // The real wrapper notifies the controller, then the VT moves.
    scroll.noteNativeScroll(-6)
    vp.scroll(-6)
    expect(vp.pos).toBe(84)
    expect(scroll.info().position).toBe(84)
    scroll.noteNativeScroll(6)
    vp.scroll(6)
    expect(scroll.info().pinned).toBe(true)
  })

  test("the alternate screen hides the range and re-measures on return", () => {
    let alt = true
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp, altScreen: () => alt })

    const hidden = scroll.info()
    expect(hidden.altScreen).toBe(true)
    expect(hidden.total).toBe(hidden.viewport)
    expect(hidden.pinned).toBe(true)

    alt = false
    const shown = scroll.info()
    expect(shown.altScreen).toBe(false)
    expect(shown.total).toBe(100)
    expect(shown.position).toBe(90)
  })

  test("a no-op viewport (fake renderable) reports an empty range, never throws", () => {
    const noop: ScrollbackViewport = {
      scroll: () => {},
      compose: () => {},
      fingerprint: () => 0,
      rows: () => 24,
    }
    const scroll = make({ viewport: noop })
    const info = scroll.info()
    expect(info.viewport).toBe(24)
    expect(info.total).toBe(24)
    expect(info.position).toBe(0)
    expect(info.pinned).toBe(true)
    expect(() => {
      scroll.scrollBy(-3)
      scroll.scrollTo(100)
      scroll.noteOutput()
      scroll.noteResize()
      scroll.recalibrate()
    }).not.toThrow()
  })

  test("resize re-measures and keeps a pinned viewport at the bottom", () => {
    let now = 0
    const vp = new FakeViewport(lines(100), 10)
    const scroll = make({ viewport: vp, now: () => now })
    expect(scroll.info().total).toBe(100)

    vp.viewportRows = 20
    scroll.noteResize()
    now = 3000
    const info = scroll.info()
    expect(info.viewport).toBe(20)
    expect(info.total).toBe(100)
    expect(info.position).toBe(80)
    expect(info.pinned).toBe(true)
  })
})
