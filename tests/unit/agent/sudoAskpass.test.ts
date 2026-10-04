import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { createSudoAskpass } from "../../../src/agent/sudoAskpass.ts"

const created: Array<() => void> = []
afterAll(() => {
  for (const c of created) c()
})

/** Run a program and return its stdout. */
async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

/**
 * The askpass helper is what `sudo -A` runs: it must print the exact password
 * and its transient secret must be removed on cleanup (docs/agent.md "Sudo").
 */
describe("createSudoAskpass", () => {
  test("helper prints the exact password (symbols included) and cleans up", async () => {
    const a = createSudoAskpass("hu!ter.2 & spaced")
    expect(a).not.toBeNull()
    created.push(() => a?.cleanup())
    expect(existsSync(a!.helperPath)).toBe(true)

    // Executed directly (sudo execs the path) and via sh — both must work.
    expect(await run([a!.helperPath])).toBe("hu!ter.2 & spaced\n")
    expect(await run(["/bin/sh", a!.helperPath])).toBe("hu!ter.2 & spaced\n")

    // The helper embeds no secret; the secret is a sibling 0600 file.
    expect(readFileSync(a!.helperPath, "utf8")).not.toContain("hu!ter.2")

    a!.cleanup()
    expect(existsSync(a!.helperPath)).toBe(false)
    expect(existsSync(a!.helperPath.replace(/\/askpass$/, "/pw"))).toBe(false)
  })

  test("empty password still round-trips (helper prints one blank line)", async () => {
    const a = createSudoAskpass("")
    created.push(() => a?.cleanup())
    expect(await run([a!.helperPath])).toBe("\n")
    a!.cleanup()
  })

  test("cleanup is idempotent and never throws", () => {
    const a = createSudoAskpass("x")
    created.push(() => a?.cleanup())
    a!.cleanup()
    expect(() => a!.cleanup()).not.toThrow()
    expect(existsSync(a!.helperPath)).toBe(false)
  })
})
