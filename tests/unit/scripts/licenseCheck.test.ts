/**
 * SPDX expression classification for the license gate (`scripts/license-check.ts`).
 * Guards the "AND binds tighter than OR" rule and the conservative treatment of
 * parenthesized expressions, so a required non-permissive term can never pass
 * through an allowed OR branch (verification finding D2).
 */

import { describe, expect, test } from "bun:test"
import { classify } from "../../../scripts/license-check.ts"

describe("license:check SPDX classify", () => {
  test("a single allow-listed id passes; an unknown one fails", () => {
    expect(classify("MIT").ok).toBe(true)
    expect(classify("Apache-2.0").ok).toBe(true)
    expect(classify("ISC").ok).toBe(true)
    expect(classify("GPL-3.0").ok).toBe(false)
    expect(classify("SEE LICENSE IN LICENSE").ok).toBe(false)
  })

  test("OR passes when any branch is allowed", () => {
    expect(classify("MIT OR GPL-3.0").ok).toBe(true)
    expect(classify("GPL-3.0 OR MPL-2.0").ok).toBe(false)
  })

  test("AND requires every term", () => {
    expect(classify("MIT AND Apache-2.0").ok).toBe(true)
    expect(classify("MIT AND GPL-3.0").ok).toBe(false)
  })

  test("parentheses are honored: a required non-permissive term fails the whole expression", () => {
    // The old flat parser returned OK here (it split OR first) — a fail-open bug.
    expect(classify("GPL-3.0 AND (MIT OR Apache-2.0)").ok).toBe(false)
    expect(classify("(MIT OR GPL-3.0) AND Apache-2.0").ok).toBe(true)
    expect(classify("(GPL-3.0 OR MPL-2.0) AND MIT").ok).toBe(false)
  })

  test("WITH suffixes and a trailing + are stripped before the id check", () => {
    expect(classify("Apache-2.0 WITH LLVM-exception").ok).toBe(true)
    expect(classify("GPL-2.0+ WITH Classpath-exception-2.0").ok).toBe(false)
  })
})
