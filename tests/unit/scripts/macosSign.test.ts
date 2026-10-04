/**
 * macOS ad-hoc signing fallback (scripts/macosSign.ts).
 *
 * A compiled binary can carry a truncated signature that makes a plain
 * `codesign --force --sign -` fail with "invalid or unsupported format for
 * signature"; the fallback strips it first. This is the exact path that makes a
 * `bun build --compile` binary runnable on macOS (the kernel otherwise SIGKILLs
 * it with `Killed: 9`), so the sequence is asserted directly with a fake runner
 * rather than by shelling out to a real `codesign`.
 */

import { describe, expect, test } from "bun:test"
import { adHocSignMacBinary, type CodeSignRunner } from "../../../scripts/macosSign.ts"

/** A runner that records every argv and replays a scripted exit-code queue. */
function scriptedRunner(codes: number[]): { run: CodeSignRunner; calls: string[][] } {
  const calls: string[][] = []
  let i = 0
  const run: CodeSignRunner = (argv) => {
    calls.push([...argv])
    return codes[i++] ?? -1
  }
  return { run, calls }
}

describe("macOS ad-hoc signing", () => {
  test("signs in place when codesign accepts the existing binary", () => {
    const { run, calls } = scriptedRunner([0])
    expect(adHocSignMacBinary("/tmp/sensus", run)).toBe(true)
    expect(calls).toEqual([["codesign", "--force", "--sign", "-", "/tmp/sensus"]])
  })

  test("strips a truncated signature and retries when the overwrite fails", () => {
    const { run, calls } = scriptedRunner([1, 0, 0])
    expect(adHocSignMacBinary("/tmp/sensus", run)).toBe(true)
    expect(calls).toEqual([
      ["codesign", "--force", "--sign", "-", "/tmp/sensus"],
      ["codesign", "--remove-signature", "/tmp/sensus"],
      ["codesign", "--force", "--sign", "-", "/tmp/sensus"],
    ])
  })

  test("reports failure when codesign cannot sign at all", () => {
    const { run } = scriptedRunner([-1, -1, -1])
    expect(adHocSignMacBinary("/tmp/sensus", run)).toBe(false)
  })
})
