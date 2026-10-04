/**
 * The ⧉ copy affordance on message label rows (chatLayout.labelCopyAffordance):
 * rendered — with a click region covering it exactly — when label + gap +
 * affordance fit the content width, and hidden (never clipped) otherwise.
 */

import { describe, expect, test } from "bun:test"
import { COPY_AFFORDANCE, COPY_AFFORDANCE_GAP, REVERT_AFFORDANCE, labelCopyAffordance, labelRevertAffordance } from "../../../../src/ui/chat/chatLayout.ts"

describe("labelCopyAffordance", () => {
  test("renders with exact geometry when it fits; hides (never clips) when it does not", () => {
    // Fitting: "❯ you" is 5 cells; the region is gap + affordance.
    const a = labelCopyAffordance("❯ you", 52)
    expect(a).not.toBeNull()
    expect(a!.text).toBe(COPY_AFFORDANCE_GAP + COPY_AFFORDANCE)
    expect(a!.start).toBe(5)
    expect(a!.length).toBe([...COPY_AFFORDANCE].length + 2)
    // The click region covers the affordance exactly.
    expect(a!.start + a!.length).toBe(5 + [...COPY_AFFORDANCE].length + 2)

    // Hidden cases: no room for label + affordance, no label at all
    // (system/tool rows), and the tiny-width floor.
    for (const [label, width] of [
      ["✱ a-very-long-model-name", 20],
      ["", 52],
      ["❯ you", 4],
    ] as const) {
      expect(labelCopyAffordance(label, width)).toBeNull()
    }

    // Boundary: an exactly-fitting label hides the affordance rather than
    // clipping it (label 18 cells + gap 2 + affordance 6 = 26 total).
    const label = "✱ 1234567890123456"
    expect(labelCopyAffordance(label, 18)).toBeNull()
    expect(labelCopyAffordance(label, 25)).toBeNull()
    expect(labelCopyAffordance(label, 26)).not.toBeNull()
  })
})

describe("labelRevertAffordance", () => {
  test("follows copy exactly; hidden when copy is (or the pair does not fit)", () => {
    // "❯ you" (5) + "  ⧉ copy" (8) + "  ↺ revert" (10) = 23 cells.
    const r = labelRevertAffordance("❯ you", 52)
    expect(r).not.toBeNull()
    expect(r!.text).toBe(COPY_AFFORDANCE_GAP + REVERT_AFFORDANCE)
    expect(r!.start).toBe(13) // right after the copy region
    expect(r!.start + r!.length).toBe(23)
    // The row degrades to copy-only when the pair does not fit (never clips).
    expect(labelRevertAffordance("❯ you", 22)).toBeNull()
    expect(labelRevertAffordance("❯ you", 23)).not.toBeNull()
    // No copy (long label / empty label) means no revert either.
    expect(labelRevertAffordance("✱ a-very-long-model-name", 20)).toBeNull()
    expect(labelRevertAffordance("", 52)).toBeNull()
  })
})
