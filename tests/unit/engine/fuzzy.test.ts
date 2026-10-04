import { describe, expect, test } from "bun:test"
import { fuzzyScore, matchIndices, matchSegments } from "../../../src/engine/fuzzy.ts"

describe("fuzzyScore", () => {
  test("matching: an empty query matches everything neutrally; misses return null", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
    expect(fuzzyScore("the", "Switch theme")).not.toBeNull() // substring
    expect(fuzzyScore("swthm", "Switch theme")).not.toBeNull() // loose subsequence
    expect(fuzzyScore("zzz", "Switch theme")).toBeNull()
  })

  test("ranking: substrings beat subsequences, earlier hits rank higher (position-based score)", () => {
    // A real substring ranks above a loose subsequence of the same target.
    expect(fuzzyScore("theme", "Switch theme")!).toBeGreaterThan(fuzzyScore("swthm", "Switch theme")!)
    // Substrings at the same position score equally.
    expect(fuzzyScore("theme", "Switch theme")).toBe(fuzzyScore("the", "Switch theme"))
    // The same query ranks an earlier match higher.
    expect(fuzzyScore("mod", "model catalog")!).toBeGreaterThan(fuzzyScore("mod", "command model")!)
  })
})

describe("matchIndices / matchSegments (row highlight)", () => {
  test("substring hit returns the contiguous run; loose subsequence returns its positions; misses are null", () => {
    expect(matchIndices("theme", "Switch theme")).toEqual([7, 8, 9, 10, 11])
    expect(matchIndices("swthm", "Switch theme")).toEqual([0, 1, 3, 5, 10])
    expect(matchIndices("zzz", "Switch theme")).toBeNull()
    expect(matchIndices("", "Switch theme")).toEqual([])
  })

  test("segments coalesce adjacent match/non-match runs and preserve the exact original text", () => {
    expect(matchSegments("theme", "Switch theme")).toEqual([
      { text: "Switch ", match: false },
      { text: "theme", match: true },
    ])
    // Non-contiguous match: the gaps rejoin into unmatched runs.
    const loose = matchSegments("st", "sensus tools")
    expect(loose).toEqual([
      { text: "s", match: true },
      { text: "ensus ", match: false },
      { text: "t", match: true },
      { text: "ools", match: false },
    ])
    expect(loose.map((s) => s.text).join("")).toBe("sensus tools")
    // No match / empty query: one unmatched run; empty target: nothing.
    expect(matchSegments("zzz", "abc")).toEqual([{ text: "abc", match: false }])
    expect(matchSegments("", "abc")).toEqual([{ text: "abc", match: false }])
    expect(matchSegments("a", "")).toEqual([])
  })
})
