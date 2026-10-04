import { describe, expect, test } from "bun:test"
import {
  SETTINGS_CATEGORIES,
  filterSettings,
  stepIndex,
  cycleOption,
  type FilterableSetting,
  type SettingsNavKey,
} from "../../../../src/ui/chat/settingsFilter.ts"

const key = (name: string, extra: Partial<SettingsNavKey> = {}): SettingsNavKey => ({ name, ...extra })

describe("settingsFilter (rail + flat filter helpers)", () => {
  test("the rail category order/labels are exact", () => {
    expect(SETTINGS_CATEGORIES).toEqual([
      "Endpoints",
      "Model",
      "Agent",
      "Appearance",
      "Chat",
      "Context",
      "MCP servers",
      "Memory",
    ])
  })

  const items: FilterableSetting[] = [
    { label: "baseURL", category: "Endpoints" },
    { label: "apiKey", category: "Endpoints" },
    { label: "theme", category: "Appearance" },
    { label: "thinking", category: "Chat" },
    { label: "MCP servers", category: "MCP servers" },
  ]

  test("an empty/whitespace query returns the full list in source order", () => {
    expect(filterSettings(items, "").map((i) => i.label)).toEqual(["baseURL", "apiKey", "theme", "thinking", "MCP servers"])
    expect(filterSettings(items, "   ")).toHaveLength(items.length)
  })

  test("matches label or category, case-insensitively, and drops non-matches", () => {
    // "url" is a substring of baseURL (rank 1); "Key" is a subsequence-free hit.
    expect(filterSettings(items, "BASEURL").map((i) => i.label)).toEqual(["baseURL"])
    // Category hits still surface the field ("appear" only matches the tag).
    expect(filterSettings(items, "appear").map((i) => i.label)).toEqual(["theme"])
    expect(filterSettings(items, "zzz-nope")).toEqual([])
  })

  test("substring hits rank above loose subsequences; ties keep source order", () => {
    const fields: FilterableSetting[] = [
      { label: "axb", category: "Cat" }, // "ab" is only a loose subsequence
      { label: "ab", category: "Cat" }, // substring hit
    ]
    expect(filterSettings(fields, "ab").map((f) => f.label)).toEqual(["ab", "axb"])
    // Equal-score items stay in the order they were passed.
    const tie = filterSettings(
      [
        { label: "alpha", category: "A" },
        { label: "alpine", category: "A" },
      ],
      "al",
    ).map((f) => f.label)
    expect(tie).toEqual(["alpha", "alpine"])
  })
})

describe("cycleOption (preset settings rows like the tool-turn limit)", () => {
  const opts: ReadonlyArray<number | null> = [25, 50, 100, null]

  test("cycles forward/backward through the presets and wraps at both ends", () => {
    expect(cycleOption(25, opts, 1, 50)).toBe(50)
    expect(cycleOption(50, opts, 1, 50)).toBe(100)
    expect(cycleOption(100, opts, 1, 50)).toBeNull()
    expect(cycleOption(null, opts, 1, 50)).toBe(25) // wraps
    expect(cycleOption(25, opts, -1, 50)).toBeNull() // wraps backward
    expect(cycleOption(100, opts, -1, 50)).toBe(50)
  })

  test("an off-list custom value steps from the fallback slot; empty options no-op", () => {
    expect(cycleOption(30, opts, 1, 50)).toBe(100)
    expect(cycleOption(30, opts, -1, 50)).toBe(25)
    expect(cycleOption(7, [], 1, 50)).toBe(7)
  })
})

describe("stepIndex (settings rail/detail/filter navigation)", () => {
  test("up/down step and CLAMP at the ends (no wrap)", () => {
    expect(stepIndex(key("down"), { index: 0, count: 3, pageSize: 5, vim: true })).toBe(1)
    expect(stepIndex(key("down"), { index: 2, count: 3, pageSize: 5, vim: true })).toBe(2)
    expect(stepIndex(key("up"), { index: 0, count: 3, pageSize: 5, vim: true })).toBe(0)
  })

  test("pageup/pagedown/home/end always navigate, regardless of the filter", () => {
    const pageState = { index: 5, count: 20, pageSize: 4, vim: false }
    expect(stepIndex(key("pageup"), pageState)).toBe(1)
    expect(stepIndex(key("pagedown"), pageState)).toBe(9)
    expect(stepIndex(key("home"), pageState)).toBe(0)
    expect(stepIndex(key("end"), pageState)).toBe(19)
    // alias spellings
    expect(stepIndex(key("pgdn"), pageState)).toBe(9)
  })

  test("vim j/k/g/G navigate ONLY while the filter is empty", () => {
    const state = { index: 4, count: 10, pageSize: 5, vim: true }
    expect(stepIndex(key("j"), state)).toBe(5)
    expect(stepIndex(key("k"), state)).toBe(3)
    expect(stepIndex(key("g"), state)).toBe(0)
    expect(stepIndex(key("g", { shift: true }), state)).toBe(9)
    expect(stepIndex(key("G"), state)).toBe(9)
    // With the filter active they are ordinary typed characters.
    const filtered = { ...state, vim: false }
    expect(stepIndex(key("j"), filtered)).toBeNull()
    expect(stepIndex(key("k"), filtered)).toBeNull()
    expect(stepIndex(key("g"), filtered)).toBeNull()
    expect(stepIndex(key("G"), filtered)).toBeNull()
  })

  test("non-navigation keys return null; an empty list resolves to 0", () => {
    expect(stepIndex(key("enter"), { index: 0, count: 3, pageSize: 5, vim: true })).toBeNull()
    expect(stepIndex(key("a"), { index: 0, count: 3, pageSize: 5, vim: false })).toBeNull()
    expect(stepIndex(key("down"), { index: 0, count: 0, pageSize: 5, vim: true })).toBe(0)
  })
})
