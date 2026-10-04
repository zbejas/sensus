/**
 * Context builder tests (docs/agent.md "Context injection"): block format,
 * blank-spam trimming, alt-screen suppression, git parsing against a real
 * temp repo (hidden shell runs `git` in the pane cwd).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  abbreviateHome,
  buildContextBlock,
  collectGitStatus,
  parseGitOutput,
  tailFingerprint,
  trimBlankSpam,
  type TerminalSnapshot,
} from "../../../src/agent/context.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sensus-context-"))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const snap = (overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  cwd: dir,
  shell: "zsh",
  currentCommand: "vim",
  alternateOn: false,
  tailLines: [],
  ...overrides,
})

describe("buildContextBlock", () => {
  test("block format: header line, tail lines, git line, maxLines cap, blank collapse, ~ abbreviation, styled join", () => {
    const block = buildContextBlock(
      snap({ tailLines: ["$ ls", "file.txt"], currentCommand: "zsh" }),
      { branch: "main", changed: 2 },
      100,
    )
    const lines = block.split("\n")
    expect(lines[0]).toBe(`[terminal] cwd: ${dir} · shell: zsh · cmd: zsh`)
    expect(lines[1]).toBe("[terminal] last output:")
    expect(lines[2]).toBe("$ ls")
    expect(lines[3]).toBe("file.txt")
    expect(lines[4]).toBe("[git] branch main, 2 changed files")
    // The approval option adds an [agent] line; absent = no line.
    const withApproval = buildContextBlock(snap(), null, 100, { approval: "full-auto" })
    expect(withApproval).toContain("[agent] approval: full-auto")
    expect(buildContextBlock(snap(), null, 100)).not.toContain("[agent] approval")
    // Blank spam collapses to one blank; maxLines caps the tail (keeps the LAST n).
    const spammy = buildContextBlock(snap({ tailLines: ["a", "", "", "", "b"] }), null, 100)
    expect(spammy.split("\n").filter((l) => l === "")).toHaveLength(1)
    const capped = buildContextBlock(snap({ tailLines: ["1", "2", "3", "4"] }), null, 2)
    expect(capped).toContain("4")
    expect(capped).not.toContain("\n1")
    // trimBlankSpam under the cap: collapses runs, trims the edges.
    expect(trimBlankSpam(["", "", "a", "", "", "", "b", "  ", ""])).toEqual(["a", "", "b"])
    expect(trimBlankSpam(["   "])).toEqual([])
    // abbreviateHome shortens $HOME.
    const home = process.env["HOME"] ?? "/home/x"
    expect(abbreviateHome(`${home}/proj`)).toBe("~/proj")
    expect(abbreviateHome("/usr/local")).toBe("/usr/local")
    expect(abbreviateHome(null)).toBe("?")
  })

  test("alt-screen suppresses the tail; tailUnchanged replaces lines with a note (fingerprint-stable)", () => {
    const tail = ["$ ls", "file.txt"]
    // Alt-screen: tail replaced by a note naming the app.
    const alt = buildContextBlock(snap({ alternateOn: true, tailLines: ["SECRET-TAIL"], currentCommand: "vim" }), null)
    expect(alt).toContain("user is in alt-screen app (vim)")
    expect(alt).not.toContain("SECRET-TAIL")
    expect(alt).not.toContain("last output")
    // Equal content fingerprints equal; different content differs.
    expect(tailFingerprint(tail)).toBe(tailFingerprint(["$ ls", "file.txt"]))
    expect(tailFingerprint(tail)).not.toBe(tailFingerprint(["$ ls", "other.txt"]))
    expect(tailFingerprint([])).toBe(tailFingerprint([]))
    // tailUnchanged swaps the lines for a note; header + git survive.
    const unchanged = buildContextBlock(snap({ tailLines: tail }), { branch: "main", changed: 0 }, 100, {
      tailUnchanged: true,
    })
    expect(unchanged).toContain("[terminal] last output: unchanged (2 lines since your last look)")
    expect(unchanged).not.toContain("$ ls")
    expect(unchanged).toContain("cmd: vim")
    expect(unchanged).toContain("[git] branch main (clean)")
    // The plain shape keeps the lines.
    const plain = buildContextBlock(snap({ tailLines: tail }), null, 100)
    expect(plain).toContain("$ ls")
    expect(plain).not.toContain("unchanged")
  })

  test("collectGitStatus against real temp repos: clean, dirty, non-repo", async () => {
    const { execSync } = await import("node:child_process")
    // Clean repo reports the branch with 0 changed files.
    const clean = join(dir, "clean-repo")
    execSync(`git init -q -b main ${JSON.stringify(clean)} && git -C ${JSON.stringify(clean)} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`)
    const cleanSt = await collectGitStatus(clean, new AbortController().signal)
    expect(cleanSt).not.toBeNull()
    expect(cleanSt?.branch).toBe("main")
    expect(cleanSt?.changed).toBe(0)
    // Dirty repo counts changed files.
    const dirty = join(dir, "dirty-repo")
    execSync(`git init -q ${JSON.stringify(dirty)}`)
    writeFileSync(join(dirty, "one.txt"), "x\n")
    writeFileSync(join(dirty, "two.txt"), "y\n")
    const dirtySt = await collectGitStatus(dirty, new AbortController().signal)
    expect(dirtySt?.changed).toBe(2)
    // Non-repo returns null.
    expect(await collectGitStatus(join(dir, "not-a-repo"), new AbortController().signal)).toBeNull()
  })

  test("parseGitOutput: branch + porcelain count, no-worktree null, detached HEAD fallback", () => {
    expect(parseGitOutput("true\nmain\n M a.txt\n?? b.txt\n")).toEqual({ branch: "main", changed: 2 })
    expect(parseGitOutput("")).toBeNull()
    expect(parseGitOutput("false\n")).toBeNull()
    expect(parseGitOutput("true\nHEAD\n M a.txt\n")).toEqual({ branch: "HEAD", changed: 1 })
  })
})
