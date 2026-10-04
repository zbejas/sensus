import { describe, expect, test } from "bun:test"
import {
  overlayNavStep,
  type OverlayNavKey,
  type OverlayNavState,
} from "../../../../src/ui/components/overlay/nav.ts"

const key = (name: string, mods: Partial<OverlayNavKey> = {}): OverlayNavKey => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...mods,
})

const state = (over: Partial<OverlayNavState> = {}): OverlayNavState => ({
  index: 2,
  count: 5,
  pageSize: 3,
  vim: false,
  wrap: true,
  ...over,
})

describe("overlayNavStep (shared picker navigation)", () => {
  test("arrow keys step by one and wrap or clamp per the state", () => {
    expect(overlayNavStep(key("down"), state({ index: 2 }))).toBe(3)
    expect(overlayNavStep(key("up"), state({ index: 2 }))).toBe(1)
    // wrap=true wraps both ends.
    expect(overlayNavStep(key("down"), state({ index: 4 }))).toBe(0)
    expect(overlayNavStep(key("up"), state({ index: 0 }))).toBe(4)
    // wrap=false clamps at both ends.
    expect(overlayNavStep(key("down"), state({ index: 4, wrap: false }))).toBe(4)
    expect(overlayNavStep(key("up"), state({ index: 0, wrap: false }))).toBe(0)
  })

  test("page keys move by pageSize, wrapping or clamping", () => {
    expect(overlayNavStep(key("pageup"), state({ index: 2, pageSize: 3 }))).toBe(4)
    expect(overlayNavStep(key("pagedown"), state({ index: 2, pageSize: 3 }))).toBe(0)
    expect(overlayNavStep(key("pageup"), state({ index: 1, pageSize: 3, wrap: false }))).toBe(0)
    expect(overlayNavStep(key("pagedown"), state({ index: 3, pageSize: 3, wrap: false }))).toBe(4)
  })

  test("home and end jump to the first and last row", () => {
    expect(overlayNavStep(key("home"), state({ index: 3 }))).toBe(0)
    expect(overlayNavStep(key("end"), state({ index: 0 }))).toBe(4)
  })

  test("vim keys navigate only while vim is on: h/j/k/g/G, both G spellings", () => {
    expect(overlayNavStep(key("k"), state({ index: 2, vim: true }))).toBe(1)
    expect(overlayNavStep(key("j"), state({ index: 2, vim: true }))).toBe(3)
    expect(overlayNavStep(key("g"), state({ index: 3, vim: true }))).toBe(0)
    expect(overlayNavStep(key("G"), state({ index: 3, vim: true }))).toBe(4)
    // opentui reports shifted letters as lowercase + shift in some protocols.
    expect(overlayNavStep(key("g", { shift: true }), state({ index: 3, vim: true }))).toBe(4)
  })

  test("j/k/g/G are ordinary filter characters when vim is off", () => {
    expect(overlayNavStep(key("k"), state({ vim: false }))).toBeNull()
    expect(overlayNavStep(key("j"), state({ vim: false }))).toBeNull()
    expect(overlayNavStep(key("g"), state({ vim: false }))).toBeNull()
    expect(overlayNavStep(key("G"), state({ vim: false }))).toBeNull()
    expect(overlayNavStep(key("g", { shift: true }), state({ vim: false }))).toBeNull()
    // ...and a plain printable never navigates regardless of vim.
    expect(overlayNavStep(key("a"), state({ vim: true }))).toBeNull()
    expect(overlayNavStep(key("return"), state({ vim: true }))).toBeNull()
    expect(overlayNavStep(key("escape"), state({ vim: true }))).toBeNull()
  })

  test("ctrl/meta are ignored, not rejected: a modified arrow still steps", () => {
    expect(overlayNavStep(key("down", { ctrl: true }), state({ index: 2 }))).toBe(3)
    expect(overlayNavStep(key("up", { meta: true }), state({ index: 2 }))).toBe(1)
    // ctrl+home/end still jump.
    expect(overlayNavStep(key("end", { ctrl: true }), state({ index: 0 }))).toBe(4)
    // ...but a modified letter stays a filter character, not vim motion.
    expect(overlayNavStep(key("j", { ctrl: true }), state({ vim: false }))).toBeNull()
  })

  test("an empty list resolves a navigation key to 0", () => {
    expect(overlayNavStep(key("down"), state({ index: 0, count: 0 }))).toBe(0)
    expect(overlayNavStep(key("end"), state({ index: 0, count: 0 }))).toBe(0)
    expect(overlayNavStep(key("g"), state({ count: 0, vim: true }))).toBe(0)
    expect(overlayNavStep(key("a"), state({ count: 0, vim: true }))).toBeNull()
  })

  // The pickers pass vim=false while a filter is non-empty so typing a model
  // query like "gpt" keeps inserting characters instead of moving the cursor.
  test("the vim gate is what keeps query typing working", () => {
    expect(overlayNavStep(key("g"), state({ vim: true }))).toBe(0)
    expect(overlayNavStep(key("g"), state({ vim: false }))).toBeNull()
  })
})
