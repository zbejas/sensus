/**
 * installTerminalWheelScroll — the pane's wheel hook (docs/terminal-layer.md
 * "Capture & scrollback"). OpenTUI's embedded renderable falls back to its own
 * scrollback on a wheel notch when the inner app does not claim the mouse;
 * this wrapper accelerates that fallback (macOS-style, like the chat list) and
 * notifies the scrollback controller before the VT moves. The fake lib mirrors
 * the real one's shape: methods live on the object, so the proxy must forward
 * everything else untouched.
 */

import { describe, expect, test } from "bun:test"
import type { EmbeddedTerminalRenderable } from "@opentui/core"
import { installTerminalWheelScroll } from "../../../src/client/remoteTerminalSession.ts"

class FakeLib {
  readonly scrolls: Array<{ handle: number; delta: number }> = []
  writes = 0

  embeddedTerminalScroll(handle: number, delta: number): void {
    this.scrolls.push({ handle, delta })
  }

  embeddedTerminalWrite(): void {
    this.writes++
  }
}

function fakeRenderable(lib: FakeLib): EmbeddedTerminalRenderable {
  return { lib } as unknown as EmbeddedTerminalRenderable
}

describe("installTerminalWheelScroll", () => {
  test("accelerates the notch, notifies before the VT moves, and forwards other calls", () => {
    const lib = new FakeLib()
    const renderable = fakeRenderable(lib)
    const seen: number[] = []
    const uninstall = installTerminalWheelScroll(renderable, (delta) => seen.push(delta))

    const internals = renderable as unknown as { lib: FakeLib }
    internals.lib.embeddedTerminalScroll(7, -3)

    // One notch: same direction, at least the base 3 rows (the accel multiplier
    // is >= 1), and the controller saw exactly what the VT was asked to do.
    expect(lib.scrolls).toHaveLength(1)
    const applied = lib.scrolls[0]!
    expect(applied.handle).toBe(7)
    expect(applied.delta).toBeLessThanOrEqual(-3)
    expect(seen).toEqual([applied.delta])

    // Non-scroll native methods still reach the original object.
    internals.lib.embeddedTerminalWrite()
    expect(lib.writes).toBe(1)

    uninstall()
    expect((renderable as unknown as { lib: FakeLib }).lib).toBe(lib)
  })

  test("a renderable without native internals installs a no-op uninstaller", () => {
    const renderable = {} as EmbeddedTerminalRenderable
    const uninstall = installTerminalWheelScroll(renderable, () => {})
    expect(() => uninstall()).not.toThrow()
  })
})
