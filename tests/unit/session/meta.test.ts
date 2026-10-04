import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanSessionTitle,
  deriveTitle,
  deriveTitleFromText,
  normalizeTags,
  readSessionMeta,
  renameSession,
  sessionMetaPath,
  sessionToMarkdown,
  tagSession,
  writeSessionMeta,
} from "../../../src/session/meta.ts"
import type { LoadedSession } from "../../../src/session/store.ts"

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sensus-meta-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function loaded(over: Partial<LoadedSession> = {}): LoadedSession {
  return {
    path: "/s/inst/tab-1.jsonl",
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there", model: "m" }],
    toolCalls: [],
    firstUser: "hello",
    title: "hello",
    tags: [],
    lastTs: 1700000000000,
    eventCount: 2,
    warnings: [],
    checkpoint: null,
    checkpointIndex: 0,
    compactions: 0,
    ...over,
  }
}

describe("session metadata sidecar", () => {
  test("write/read round-trips title + tags; rename clears with an empty string", () => {
    withDir((dir) => {
      const jsonl = join(dir, "tab-1.jsonl")
      writeFileSync(jsonl, "")
      expect(readSessionMeta(jsonl)).toEqual({})
      writeSessionMeta(jsonl, { title: "My session", tags: ["a", "a", " b "] })
      expect(readSessionMeta(jsonl)).toEqual({ title: "My session", tags: ["a", "b"] })
      renameSession(jsonl, "  renamed  ")
      expect(readSessionMeta(jsonl).title).toBe("renamed")
      renameSession(jsonl, "   ")
      expect(readSessionMeta(jsonl).title).toBeUndefined()
      tagSession(jsonl, [])
      expect(readSessionMeta(jsonl).tags).toBeUndefined()
    })
  })

  test("a corrupt or wrong-shaped sidecar degrades to {} and never throws", () => {
    withDir((dir) => {
      const jsonl = join(dir, "tab-1.jsonl")
      writeFileSync(sessionMetaPath(jsonl), "{not json")
      expect(readSessionMeta(jsonl)).toEqual({})
      writeFileSync(sessionMetaPath(jsonl), JSON.stringify([1, 2]))
      expect(readSessionMeta(jsonl)).toEqual({})
    })
  })

  test("deriveTitle collapses whitespace, ellipsizes, and falls back for an empty session", () => {
    expect(deriveTitle(loaded({ firstUser: "  a   b\n c " }))).toBe("a b c")
    expect(deriveTitle(loaded({ firstUser: null }))).toBe("(empty session)")
    expect(deriveTitle(loaded({ firstUser: "x".repeat(200) })).length).toBeLessThanOrEqual(60)
    expect(normalizeTags(["a", " a ", "", "b", "b"])).toEqual(["a", "b"])
  })

  test("deriveTitleFromText is the raw-text title helper (empty → \"\", bounded)", () => {
    expect(deriveTitleFromText("  a   b\n c ")).toBe("a b c")
    expect(deriveTitleFromText("   \n ")).toBe("")
    expect(deriveTitleFromText("x".repeat(200)).length).toBeLessThanOrEqual(60)
  })

  test("cleanSessionTitle strips labels/quotes/punctuation, caps words, and bounds length", () => {
    expect(cleanSessionTitle('  Title: "Deploy the alpha service."  ')).toBe("Deploy the alpha service")
    expect(cleanSessionTitle("```\nFix flaky tmux capture```")).toBe("Fix flaky tmux capture")
    // Word cap: only the first 10 words survive (and the char bound applies).
    const long = cleanSessionTitle("one two three four five six seven eight nine ten eleven twelve")
    expect(long.split(" ")).toHaveLength(10)
    expect(long).not.toContain("eleven")
    expect(cleanSessionTitle("")).toBe("")
    expect(cleanSessionTitle("   \n  ")).toBe("")
    expect(cleanSessionTitle("Title:")).toBe("")
    // TITLE_MAX char bound still applies after the word cap.
    expect(cleanSessionTitle("w".repeat(120)).length).toBeLessThanOrEqual(60)
  })

  test("sessionToMarkdown renders the title, facts and role-labelled messages", () => {
    const md = sessionToMarkdown(loaded({ title: "Deploy notes", tags: ["ops"] }))
    expect(md).toContain("# Deploy notes")
    expect(md).toContain("tags: ops")
    expect(md).toContain("## User")
    expect(md).toContain("hello")
    expect(md).toContain("## Assistant (model: m)")
    expect(md).toContain("hi there")
    expect(sessionToMarkdown(loaded({ messages: [], title: "Empty" }))).toContain("_(empty session)_")
  })
})
