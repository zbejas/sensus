import { describe, expect, test } from "bun:test"
import { cycleTabs, nextActiveOnClose, tabActivity, tabAtPosition, tabTitle } from "../../../../src/ui/lib/tabs.ts"
import type { TabView } from "../../../../src/ui/lib/store.ts"

describe("tab registry semantics", () => {
  test("nextActiveOnClose: prefers the left neighbor, falls back right, no successor for the last tab", () => {
    expect(nextActiveOnClose([1, 2, 3], 2)).toBe(1)
    expect(nextActiveOnClose([1, 2, 3], 3)).toBe(2)
    expect(nextActiveOnClose([1, 2, 3], 1)).toBe(2) // closing the first tab
    // No successor: single tab, empty list, or a closed id that isn't present.
    const noSuccessor: Array<[readonly number[], number]> = [[[1], 1], [[], 1], [[1, 2], 99]]
    for (const [ids, closed] of noSuccessor) {
      expect(nextActiveOnClose(ids, closed)).toBeNull()
    }
  })

  test("cycleTabs wraps in both directions; single/empty lists and unknown current ids are no-ops", () => {
    expect(cycleTabs([1, 2, 3], 1, "next")).toBe(2)
    expect(cycleTabs([1, 2, 3], 3, "next")).toBe(1)
    expect(cycleTabs([1, 2, 3], 2, "prev")).toBe(1)
    expect(cycleTabs([1, 2, 3], 1, "prev")).toBe(3)
    expect(cycleTabs([5], 5, "next")).toBe(5)
    expect(cycleTabs([], 1, "next")).toBeNull()
    // An unknown current id starts from index 0 (either direction).
    expect(cycleTabs([7, 8], 42, "next")).toBe(8)
    expect(cycleTabs([7, 8], 42, "prev")).toBe(8)
  })

  test("tabAtPosition: 1-based jump (Alt+1..9); missing positions return null", () => {
    expect(tabAtPosition([10, 11, 12], 1)).toBe(10)
    expect(tabAtPosition([10, 11, 12], 3)).toBe(12)
    expect(tabAtPosition([10, 11], 3)).toBeNull()
    expect(tabAtPosition([10], 0)).toBeNull()
    expect(tabAtPosition([], 1)).toBeNull()
  })
})

describe("tabTitle (session title with shell fallback)", () => {
  const fake = (sessionTitle: string, fallback: string): TabView =>
    ({
      id: 1,
      title: fallback,
      session: null,
      status: null,
      chat: { accessors: { sessionTitle: () => sessionTitle } },
    }) as unknown as TabView

  test("prefers the session title; falls back to the store title when empty", () => {
    expect(tabTitle(fake("Deploy the alpha service", "zsh"))).toBe("Deploy the alpha service")
    expect(tabTitle(fake("", "zsh"))).toBe("zsh")
  })
})

describe("tabActivity (shared busy-tab glyph)", () => {
  const fake = (status: string, pending: boolean, animations = false): TabView =>
    ({
      id: 1,
      title: "zsh",
      session: null,
      status: null,
      chat: {
        accessors: { status: () => status, animations: () => animations },
        pendingApproval: () => (pending ? { callId: "c" } : null),
      },
    }) as unknown as TabView

  test("a quiet tab has no glyph", () => {
    expect(tabActivity(fake("idle", false))).toBeNull()
    expect(tabActivity(fake("done", false))).toBeNull()
  })

  test("streaming shows the spinner in the accent; animations off uses the static glyph", () => {
    expect(tabActivity(fake("streaming", false))).toEqual({ glyph: "⋯", tone: "accent" })
  })

  test("a pending approval outranks streaming with the warning `!`", () => {
    expect(tabActivity(fake("streaming", true))).toEqual({ glyph: "!", tone: "warning" })
  })
})
