/**
 * Session FTS5 index (Phase 1.6): ingest real JSONL transcripts through the
 * shared `loadSessionFile` parser, then search/list. Real temp files; no tmux,
 * no network. Scenario-shaped: one test per behavior.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { sessionFilePath } from "../../../src/session/store.ts"
import {
  ftsQuery,
  makeSnippet,
  SessionIndex,
  sessionIdFromPath,
} from "../../../src/session/indexDb.ts"

let root: string

beforeAll(() => {
  root = join(tmpdir(), "sensus-indexdb-")
  mkdirSync(root, { recursive: true })
})

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/** Write a JSONL transcript from raw event objects (full ts control). */
function writeSession(path: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
}

/** Fresh DB path per test (isolated). */
function dbPath(name: string): string {
  return join(root, `${name}.sqlite`)
}

describe("session index: ingest + search", () => {
  test("ingests via loadSessionFile, searches FTS content, orders newest-first, caps, and filters by session", () => {
    const p1 = sessionFilePath(root, "instA", 1, 0)
    writeSession(p1, [
      { ts: 100, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
      { ts: 101, type: "user_message", content: "alpha project setup notes" },
      { ts: 102, type: "assistant_message", content: "alpha reply here", model: "m" },
      { ts: 103, type: "slash_command", command: "/clear" },
      { ts: 104, type: "tool_call", callId: "c1", name: "shell_background", paramsSummary: "ls", status: "done", output: "ok", exitCode: 0 },
      { ts: 105, type: "compaction", checkpoint: "summary", model: "m" },
      { ts: 106, type: "future_event_type", payload: { anything: true } },
    ])
    const p2 = sessionFilePath(root, "instB", 2, 0)
    writeSession(p2, [
      { ts: 200, type: "user_message", content: "beta alpha discussion" },
      { ts: 201, type: "assistant_message", content: "beta answer" },
    ])

    const idx = new SessionIndex({ dbPath: dbPath("ingest") })
    try {
      idx.refresh([p1, p2])
      const hits = idx.search("alpha")
      // 2 matches in instA + 1 in instB; only user/assistant messages indexed.
      expect(hits.length).toBe(3)
      expect(hits.every((h) => h.snippet.toLowerCase().includes("alpha"))).toBe(true)
      expect(hits.map((h) => h.role).filter((r) => r === "assistant").length).toBe(1)
      // Newest session first (instB lastTs 201 > instA 106).
      expect(hits[0]?.sessionId).toContain("instB")
      expect(hits[0]?.path).toBe(p2)
      // messageIndex is the record index within the file.
      const firstUser = hits.find((h) => h.path === p1 && h.role === "user")
      expect(firstUser?.messageIndex).toBe(0)
      // The hit's ts is the MESSAGE's own event ts, not the file's last ts.
      expect(firstUser?.ts).toBe(101)
      // Cap.
      expect(idx.search("alpha", 1).length).toBe(1)
      expect(idx.search("alpha", 1000).length).toBe(3)
      // Session filter matches the id or the path substring.
      const scoped = idx.search("alpha", 20, "instA")
      expect(scoped.length).toBe(2)
      expect(scoped.every((h) => h.path === p1)).toBe(true)
      expect(idx.search("alpha", 20, "tab-2").every((h) => h.path === p2)).toBe(true)
      // list(): one row per session, newest first, with counts + first user.
      const list = idx.list()
      expect(list.length).toBe(2)
      expect(list[0]?.path).toBe(p2)
      const a = list.find((s) => s.path === p1)
      expect(a?.messages).toBe(2)
      expect(a?.lastTs).toBe(106)
      expect(a?.firstUser).toBe("alpha project setup notes")
      // Offset paging returns disjoint slices (the overlay's infinite scroll).
      const hitPage1 = idx.search("alpha", 2, undefined, 0)
      const hitPage2 = idx.search("alpha", 2, undefined, 2)
      expect(hitPage1.length).toBe(2)
      expect(hitPage2.length).toBe(1)
      expect(new Set([...hitPage1, ...hitPage2].map((h) => `${h.path}#${h.messageIndex}`)).size).toBe(3)
      expect(idx.search("alpha", 2, undefined, 99)).toEqual([])
      const listPage2 = idx.list(1, 1)
      expect(listPage2.length).toBe(1)
      expect(listPage2[0]?.path).toBe(p1)
      // readSession (session_view): resolve by id/path substring, page by
      // message index, and report the full count so the caller knows to page.
      const view = idx.readSession("instA")
      expect(view?.sessionId).toBe("instA/tab-1")
      expect(view?.total).toBe(2)
      expect(view?.offset).toBe(0)
      expect(view?.messages.map((m) => m.content)).toEqual(["alpha project setup notes", "alpha reply here"])
      expect(view?.messages.map((m) => m.role)).toEqual(["user", "assistant"])
      // Per-message timestamps survive the read path (not the file's last ts).
      expect(view?.messages.map((m) => m.ts)).toEqual([101, 102])
      const page = idx.readSession("instA", 1, 1)
      expect(page?.total).toBe(2)
      expect(page?.offset).toBe(1)
      expect(page?.messages.map((m) => m.index)).toEqual([1])
      expect(idx.readSession("instA", 5)?.messages).toEqual([])
      expect(idx.readSession("tab-2")?.sessionId).toBe("instB/tab-2")
      expect(idx.readSession("does-not-exist")).toBeNull()
      expect(idx.readSession("   ")).toBeNull()
      // Empty query never matches.
      expect(idx.search("")).toEqual([])
      expect(idx.search("   ")).toEqual([])
    } finally {
      idx.close()
    }
  })

  test("readSession prefers an exact id/path over a newer substring match (stable paging)", () => {
    // Same tab base, two generations: tab-1 (older) and tab-1-2 (newer). The
    // id `instG1/tab-1` is a SUBSTRING of the newer `instG1/tab-1-2`.
    const older = sessionFilePath(root, "instG1", 1, 0)
    const newer = sessionFilePath(root, "instG1", 1, 1)
    writeSession(older, [
      { ts: 10, type: "user_message", content: "older tab one" },
      { ts: 11, type: "assistant_message", content: "older reply", model: "m" },
    ])
    writeSession(newer, [
      { ts: 100, type: "user_message", content: "newer generation" },
      { ts: 101, type: "assistant_message", content: "newer reply", model: "m" },
    ])
    const idx = new SessionIndex({ dbPath: dbPath("resolve") })
    try {
      idx.refresh([older, newer])
      // The exact id binds to the older transcript even though tab-1-2 is newer.
      const exact = idx.readSession("instG1/tab-1")
      expect(exact?.path).toBe(older)
      expect(exact?.messages[0]?.content).toBe("older tab one")
      // The exact path binds too.
      expect(idx.readSession(newer)?.path).toBe(newer)
      // A loose substring with no exact hit takes the newest match.
      expect(idx.readSession("tab-1")?.path).toBe(newer)
    } finally {
      idx.close()
    }
  })
})

describe("session index: refresh", () => {
  test("picks up an appended message via mtime and re-reads all with force", () => {
    const p = sessionFilePath(root, "instC", 1, 0)
    writeSession(p, [
      { ts: 10, type: "user_message", content: "apple fruit basket" },
      { ts: 11, type: "assistant_message", content: "apple noted" },
    ])
    // Pin an old mtime so the later append is guaranteed to differ.
    utimesSync(p, new Date(1_000_000), new Date(1_000_000))

    const idx = new SessionIndex({ dbPath: dbPath("refresh") })
    try {
      idx.refresh([p])
      expect(idx.search("banana")).toEqual([])
      expect(idx.search("apple").length).toBe(2)

      appendFileSync(p, JSON.stringify({ ts: 12, type: "user_message", content: "banana bread recipe" }) + "\n", "utf8")
      idx.refresh([p])
      const banana = idx.search("banana")
      expect(banana.length).toBe(1)
      expect(banana[0]?.snippet).toContain("banana")
      // Re-ingest replaced the file's rows: no duplicates of the old content.
      expect(idx.search("apple").length).toBe(2)
      expect(idx.list()[0]?.messages).toBe(3)

      // force re-reads even when the mtime map says "seen".
      appendFileSync(p, JSON.stringify({ ts: 13, type: "user_message", content: "cherry pie" }) + "\n", "utf8")
      idx.refresh([p], true)
      expect(idx.search("cherry").length).toBe(1)
    } finally {
      idx.close()
    }
  })

  test("refresh skips files whose mtime is unchanged (the index owns re-ingest by mtime)", () => {
    const p = sessionFilePath(root, "instMtime", 1, 0)
    writeSession(p, [
      { ts: 10, type: "user_message", content: "original papaya" },
      { ts: 11, type: "assistant_message", content: "papaya reply" },
    ])
    utimesSync(p, new Date(2_000_000), new Date(2_000_000))
    const idx = new SessionIndex({ dbPath: dbPath("mtime-skip") })
    try {
      idx.refresh([p])
      expect(idx.search("papaya").length).toBe(2)
      // Rewrite the file with different content but pin the SAME mtime: a
      // second refresh must not re-parse it (the stat-only listing hands it
      // over; the mtime map is what decides).
      writeSession(p, [{ ts: 10, type: "user_message", content: "replaced guava" }])
      utimesSync(p, new Date(2_000_000), new Date(2_000_000))
      idx.refresh([p])
      expect(idx.search("papaya").length).toBe(2) // old rows survived
      expect(idx.search("guava")).toEqual([])
      // force re-reads regardless of mtime.
      idx.refresh([p], true)
      expect(idx.search("papaya")).toEqual([])
      expect(idx.search("guava").length).toBe(1)
    } finally {
      idx.close()
    }
  })

  test("unknown event types are ignored and corrupt lines skipped (forward compat)", () => {
    const p = sessionFilePath(root, "instD", 1, 0)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      [
        JSON.stringify({ ts: 1, type: "user_message", content: "knownword here" }),
        "{ this is not valid json",
        JSON.stringify({ ts: 2, type: "assistant_message", content: "knownword reply", model: "m" }),
        JSON.stringify({ ts: 3, type: "some_future_event", extra: 1 }),
        JSON.stringify({ ts: 4, type: "tool_call", callId: "x", name: "n", paramsSummary: "", status: "done", output: null, exitCode: null }),
        "",
      ].join("\n") + "\n",
      "utf8",
    )
    const idx = new SessionIndex({ dbPath: dbPath("forward") })
    try {
      idx.refresh([p])
      expect(idx.search("knownword").length).toBe(2)
      // Only the user/assistant records count toward the session's messages.
      expect(idx.list()[0]?.messages).toBe(2)
      // No match + an index with nothing relevant -> safe empties.
      expect(idx.search("zzzznotfound")).toEqual([])
    } finally {
      idx.close()
    }
  })

  test("zero-message transcripts are hidden from search, list and readSession even if already indexed", () => {
    const p = sessionFilePath(root, "inst-empty-idx", 1, 0)
    writeSession(p, [
      { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" },
      { ts: 2, type: "slash_command", command: "/help" },
    ])
    const idx = new SessionIndex({ dbPath: dbPath("empty") })
    try {
      // refresh() is handed an explicit path (not listSessionFiles), so the
      // empty row IS ingested — queries must still hide it.
      idx.refresh([p])
      expect(idx.search("help")).toEqual([])
      expect(idx.list().some((s) => s.path === p)).toBe(false)
      expect(idx.readSession("inst-empty-idx")).toBeNull()
    } finally {
      idx.close()
    }
  })

  test("remove drops a session's rows from search + list; a later refresh cannot resurrect a deleted file", () => {
    const p = sessionFilePath(root, "inst-rm", 1, 0)
    writeSession(p, [
      { ts: 1, type: "user_message", content: "removable durian note" },
      { ts: 2, type: "assistant_message", content: "durian reply", model: "m" },
    ])
    const idx = new SessionIndex({ dbPath: dbPath("remove") })
    try {
      idx.refresh([p])
      expect(idx.search("durian").length).toBe(2)
      expect(idx.list().some((s) => s.path === p)).toBe(true)

      expect(idx.remove(p)).toBe(true)
      expect(idx.search("durian")).toEqual([])
      expect(idx.list().some((s) => s.path === p)).toBe(false)

      // The caller unlinks the file; a subsequent pass does not bring it back.
      rmSync(p)
      idx.refresh([p], true)
      expect(idx.list().some((s) => s.path === p)).toBe(false)

      // Removing an unknown path is a harmless no-op.
      expect(idx.remove(join(root, "never-indexed.jsonl"))).toBe(true)
    } finally {
      idx.close()
    }
  })
})

describe("session index: pure helpers + degradation", () => {
  test("ftsQuery quotes/prefixes terms safely; makeSnippet windows the first match", () => {
    expect(ftsQuery("")).toBeNull()
    expect(ftsQuery("   !! ")).toBeNull()
    expect(ftsQuery("Hello World")).toBe('"hello"* "world"*')
    expect(ftsQuery('foo" OR "bar NEAR(x)')).toBe('"foo"* "or"* "bar"* "near"* "x"*')
    expect(ftsQuery("foo*bar")).toBe('"foo"* "bar"*')

    const long = `${"x".repeat(100)} needle ${"y".repeat(300)}`
    const snip = makeSnippet(long, "needle")
    expect(snip).toContain("needle")
    expect(snip.startsWith("…")).toBe(true)
    expect(snip.endsWith("…")).toBe(true)
    expect(makeSnippet("short", "nomatch")).toBe("short")
    // Prefix hit still centers on the token.
    expect(makeSnippet("a wonderful world", "wonder")).toContain("wonderful")

    expect(sessionIdFromPath("/x/sessions/inst1/tab-2.jsonl")).toBe("inst1/tab-2")
    expect(sessionIdFromPath("/x/tab-1.jsonl")).toBe("x/tab-1")
  })

  test("a broken DB path degrades to [] and never throws; FTS-syntax queries are safe", () => {
    // Using a DIRECTORY as the DB file makes open/migrate fail.
    const asDir = join(root, "not-a-db")
    mkdirSync(asDir, { recursive: true })
    const idx = new SessionIndex({ dbPath: asDir })
    try {
      idx.ensure()
      idx.refresh([sessionFilePath(root, "instE", 1, 0)])
      expect(idx.search("anything")).toEqual([])
      expect(idx.list()).toEqual([])
      expect(idx.readSession("instE")).toBeNull()
      expect(ftsQuery('a" OR b*')).not.toBeNull()
    } finally {
      idx.close()
    }

    // A valid index never throws on hostile FTS input.
    const p = sessionFilePath(root, "instF", 1, 0)
    writeSession(p, [{ ts: 1, type: "user_message", content: "ordinary content" }])
    const ok = new SessionIndex({ dbPath: dbPath("hostile") })
    try {
      ok.refresh([p])
      for (const q of ['a" OR "b', "NEAR(x)", "col:val", "*", "()", "foo-bar"]) {
        expect(Array.isArray(ok.search(q))).toBe(true)
      }
    } finally {
      ok.close()
    }
  })
})
