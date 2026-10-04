import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionFile,
  deleteSessionFile,
  listRecentSessions,
  listSessionFiles,
  loadSessionFile,
  makeInstanceId,
  sessionFilePath,
  sessionsRoot,
} from "../../../src/session/store.ts"
import { sessionMetaPath, writeSessionMeta } from "../../../src/session/meta.ts"

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "sensus-session-"))
}

describe("session store", () => {
  test("ids + path layout: instance ids are stable/distinct, files are tab-<n>[-gen].jsonl under sessions/", () => {
    const a = makeInstanceId(1700000000000, 123)
    expect(a).toBe(makeInstanceId(1700000000000, 123))
    expect(makeInstanceId(1700000000001, 123)).not.toBe(a)
    expect(makeInstanceId(1700000000000, 124)).not.toBe(a)
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]{6}$/)

    const root = sandbox()
    try {
      expect(sessionsRoot("/tmp/x")).toBe("/tmp/x/sessions")
      expect(sessionFilePath(root, "abc", 1, 0)).toBe(join(root, "sessions", "abc", "tab-1.jsonl"))
      expect(sessionFilePath(root, "abc", 1, 1)).toBe(join(root, "sessions", "abc", "tab-1-2.jsonl"))
      expect(sessionFilePath(root, "abc", 2, 0)).toBe(join(root, "sessions", "abc", "tab-2.jsonl"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("append + load round-trip: header + events persist, reopen resumes, compaction tracks its checkpoint", () => {
    const root = sandbox()
    try {
      // Fresh session: parent dirs are created and events round-trip.
      const path = sessionFilePath(root, "inst1", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      sf.append({ ts: 1, type: "user_message", content: "first" })
      sf.append({
        ts: 2,
        type: "assistant_message",
        content: "reply",
        model: "gpt-5",
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
        aborted: false,
      })
      sf.append({ ts: 3, type: "slash_command", command: "/clear" })
      expect(existsSync(path)).toBe(true)
      expect(sf.hasErrors).toBe(false)
      const loaded = loadSessionFile(path)
      expect(loaded.messages).toEqual([
        { role: "user", content: "first", ts: 1 },
        {
          role: "assistant",
          content: "reply",
          ts: 2,
          model: "gpt-5",
          usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
          aborted: false,
        },
      ])
      expect(loaded.firstUser).toBe("first")
      expect(loaded.eventCount).toBe(4) // header + 3 events
      expect(loaded.warnings).toEqual([])

      // Resume: reopening an existing file appends (no second header).
      SessionFile.reopen(path).append({ ts: 9, type: "user_message", content: "resumed-msg" })
      expect(loadSessionFile(path).messages.map((m) => m.content)).toContain("resumed-msg")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    // Compaction: the checkpoint text + the count of records written before it.
    const root2 = sandbox()
    try {
      const path = sessionFilePath(root2, "inst-cp", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      sf.append({ ts: 1, type: "user_message", content: "one" })
      sf.append({ ts: 2, type: "assistant_message", content: "two", model: "gpt-5", usage: null, aborted: false })
      sf.append({ ts: 3, type: "compaction", checkpoint: "<conversation-checkpoint>\nsummary", model: "gpt-5" })
      sf.append({ ts: 4, type: "user_message", content: "three" })
      const loaded = loadSessionFile(path)
      expect(loaded.checkpoint).toBe("<conversation-checkpoint>\nsummary")
      expect(loaded.checkpointIndex).toBe(2) // two chat records BEFORE the compaction event
      expect(loaded.messages).toHaveLength(3) // all records still load for the visible transcript
      expect(loaded.messages[2]?.content).toBe("three")
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  test("revert events truncate the logical transcript in file order; a discarded checkpoint is dropped", () => {
    const root = sandbox()
    try {
      const path = sessionFilePath(root, "inst-rw", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      sf.append({ ts: 1, type: "user_message", content: "a" })
      sf.append({ ts: 2, type: "assistant_message", content: "A", model: "gpt-5", usage: null, aborted: false })
      sf.append({ ts: 3, type: "user_message", content: "b" })
      sf.append({ ts: 4, type: "assistant_message", content: "B", model: "gpt-5", usage: null, aborted: false })
      // Rewind to before "b": keep the first two records.
      sf.append({ ts: 5, type: "revert", keep: 2 })
      expect(loadSessionFile(path).messages.map((m) => m.content)).toEqual(["a", "A"])
      expect(loadSessionFile(path).firstUser).toBe("a")

      // New records appended AFTER the revert extend the truncated list (the
      // discarded bytes stay on disk but are never loaded again).
      sf.append({ ts: 6, type: "user_message", content: "c" })
      sf.append({ ts: 7, type: "assistant_message", content: "C", model: "gpt-5", usage: null, aborted: false })
      expect(loadSessionFile(path).messages.map((m) => m.content)).toEqual(["a", "A", "c", "C"])

      // A second revert is relative to the CURRENT logical list.
      sf.append({ ts: 8, type: "revert", keep: 1 })
      const loaded = loadSessionFile(path)
      expect(loaded.messages.map((m) => m.content)).toEqual(["a"])
      expect(loaded.firstUser).toBe("a")

      // Checkpoint invalidation: a checkpoint that summarized a discarded
      // record is cleared; one that stays inside the kept prefix survives.
      const cpPath = sessionFilePath(root, "inst-rw-cp", 1, 0)
      const cp = SessionFile.create(cpPath, { endpoint: "main", model: "gpt-5" })
      cp.append({ ts: 1, type: "user_message", content: "one" })
      cp.append({ ts: 2, type: "assistant_message", content: "two", model: "gpt-5", usage: null, aborted: false })
      cp.append({ ts: 3, type: "compaction", checkpoint: "<conversation-checkpoint>\nsummary", model: "gpt-5" })
      cp.append({ ts: 4, type: "user_message", content: "three" })
      cp.append({ ts: 5, type: "revert", keep: 1 }) // discards the summarized turn
      const dropped = loadSessionFile(cpPath)
      expect(dropped.checkpoint).toBeNull()
      expect(dropped.checkpointIndex).toBe(0)
      expect(dropped.messages.map((m) => m.content)).toEqual(["one"])
      // Reverting to a point AFTER the checkpoint keeps it valid.
      cp.append({ ts: 6, type: "assistant_message", content: "restart", model: "gpt-5", usage: null, aborted: false })
      cp.append({ ts: 7, type: "compaction", checkpoint: "<conversation-checkpoint>\nsecond", model: "gpt-5" })
      cp.append({ ts: 8, type: "revert", keep: 3 }) // keeps one assistant + the checkpoint
      const kept = loadSessionFile(cpPath)
      expect(kept.checkpoint).toBe("<conversation-checkpoint>\nsecond")
      expect(kept.checkpointIndex).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("tool_call events load as inspector metadata tied to the preceding record; raw args + capped result survive; a revert drops discarded calls", () => {
    const root = sandbox()
    try {
      const path = sessionFilePath(root, "inst-tools", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      sf.append({ ts: 1, type: "user_message", content: "clean /tmp" })
      // A dropped assistant bubble (no text/thinking) leaves its calls after
      // the user record. The final event carries the raw args + capped result
      // `--resume` replays.
      sf.append({
        ts: 2,
        type: "tool_call",
        callId: "c1",
        name: "run_command",
        paramsSummary: "du -sh /tmp",
        status: "done",
        output: "14G /tmp",
        exitCode: 0,
        arguments: '{"command":"du -sh /tmp"}',
        result: "14G\t/tmp\nboundary-capped tail",
      })
      sf.append({ ts: 3, type: "assistant_message", content: "", model: "gpt-5", usage: null, aborted: false })
      sf.append({ ts: 4, type: "tool_call", callId: "c2", name: "run_command", paramsSummary: "rm -rf x", status: "done", output: null, exitCode: 0 })
      sf.append({ ts: 5, type: "tool_call", callId: "c3", name: "read_file", paramsSummary: "/tmp/x", status: "done", output: null, exitCode: null })
      const loaded = loadSessionFile(path)
      expect(loaded.messages.map((m) => m.content)).toEqual(["clean /tmp", ""])
      expect(loaded.toolCalls).toEqual([
        {
          afterMessage: 0,
          name: "run_command",
          paramsSummary: "du -sh /tmp",
          callId: "c1",
          arguments: '{"command":"du -sh /tmp"}',
          result: "14G\t/tmp\nboundary-capped tail",
        },
        { afterMessage: 1, name: "run_command", paramsSummary: "rm -rf x", callId: "c2" },
        { afterMessage: 1, name: "read_file", paramsSummary: "/tmp/x", callId: "c3" },
      ])

      // Rewinding past the assistant record drops its calls (and any later).
      sf.append({ ts: 6, type: "revert", keep: 1 })
      const rewound = loadSessionFile(path)
      expect(rewound.messages.map((m) => m.content)).toEqual(["clean /tmp"])
      expect(rewound.toolCalls).toEqual([
        {
          afterMessage: 0,
          name: "run_command",
          paramsSummary: "du -sh /tmp",
          callId: "c1",
          arguments: '{"command":"du -sh /tmp"}',
          result: "14G\t/tmp\nboundary-capped tail",
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("load resilience: corrupt lines skipped with a warning, unknown types counted, missing file warns", () => {
    const root = sandbox()
    try {
      const dir = join(root, "sessions", "i")
      mkdirSync(dir, { recursive: true })
      const path = join(dir, "tab-1.jsonl")
      writeFileSync(
        path,
        [
          JSON.stringify({ ts: 1, type: "user_message", content: "good" }),
          "{ this is not json",
          JSON.stringify({ ts: 2, type: "user_message", content: "also good" }),
          // Unknown event types load as nothing but still count (forward compat).
          JSON.stringify({ ts: 3, type: "tool_call", name: "x" }),
          "",
        ].join("\n"),
      )
      const loaded = loadSessionFile(path)
      expect(loaded.messages.map((m) => m.content)).toEqual(["good", "also good"])
      expect(loaded.warnings.join("\n")).toContain("1 corrupt")
      expect(loaded.eventCount).toBe(4)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    // A missing file yields a warning, not a throw.
    const missing = loadSessionFile("/nonexistent/nope.jsonl")
    expect(missing.messages).toEqual([])
    expect(missing.warnings.length).toBe(1)
  })

  test("a fresh session is lazy: no file until content, slash-only is not stored, leading slash commands flush with the first record", () => {
    const root = sandbox()
    try {
      const path = sessionFilePath(root, "inst-lazy", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      // Merely opening a tab materializes nothing.
      expect(existsSync(path)).toBe(false)
      sf.append({ ts: 1, type: "slash_command", command: "/help" })
      sf.append({ ts: 2, type: "slash_command", command: "/model" })
      expect(existsSync(path)).toBe(false)
      expect(listSessionFiles(root)).toEqual([])

      // The first content event creates the file: header + buffered slash
      // commands land BEFORE the record that started the session.
      sf.append({ ts: 3, type: "user_message", content: "hello" })
      expect(existsSync(path)).toBe(true)
      const types = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { type: string }).type)
      expect(types).toEqual(["session_start", "slash_command", "slash_command", "user_message"])
      expect(loadSessionFile(path).messages.map((m) => m.content)).toEqual(["hello"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("listSessionFiles is stat-only (header-only files listed for the index); resume still filters them", () => {
    const root = sandbox()
    try {
      const empty = sessionFilePath(root, "inst-empty", 1, 0)
      mkdirSync(join(empty, ".."), { recursive: true })
      writeFileSync(
        empty,
        JSON.stringify({ ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "m" }) + "\n",
      )
      const real = sessionFilePath(root, "inst-real", 1, 0)
      SessionFile.create(real, { endpoint: "main", model: "m" }).append({ ts: 2, type: "user_message", content: "real" })
      // The listing no longer parses: header-only files are included so the
      // index can decide by mtime (empty sessions are hidden at query time).
      expect(listSessionFiles(root).sort()).toEqual([empty, real].sort())
      // The open/resume path still drops the empty transcript.
      expect(listRecentSessions(root).map((s) => s.path)).toEqual([real])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("session transcripts + dirs are owner-only (0600 file, 0700 dir)", () => {
    const root = sandbox()
    try {
      const path = sessionFilePath(root, "inst-perm", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "m" })
      sf.append({ ts: 1, type: "user_message", content: "command output" })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, "sessions", "inst-perm")).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("listSessionFiles / listRecentSessions: newest first across instances, limited, empty dir -> []", () => {
    const root = sandbox()
    try {
      expect(listSessionFiles(root)).toEqual([])
      expect(listRecentSessions(root)).toEqual([])

      const a = sessionFilePath(root, "inst-a", 1, 0)
      const b = sessionFilePath(root, "inst-b", 1, 0)
      const c = sessionFilePath(root, "inst-b", 1, 1) // /clear generation
      // Create c first, then a, then b so b is newest by lastTs. The event ts
      // sits ahead of `Date.now()` (the session_start header's ts) so ordering
      // is deterministic even when the three files share a millisecond.
      const base = Date.now() + 10_000
      SessionFile.create(c, { endpoint: "main", model: "m" }).append({ ts: base + 50, type: "user_message", content: "c" })
      SessionFile.create(a, { endpoint: "main", model: "m" }).append({ ts: base + 100, type: "user_message", content: "older" })
      SessionFile.create(b, { endpoint: "main", model: "m" }).append({ ts: base + 200, type: "user_message", content: "newest" })
      // Pin distinct mtimes: the stat-only listing orders by mtime (the
      // open/resume path still orders by last event ts below).
      utimesSync(c, new Date(1_000_000), new Date(1_000_000))
      utimesSync(a, new Date(2_000_000), new Date(2_000_000))
      utimesSync(b, new Date(3_000_000), new Date(3_000_000))

      const files = listSessionFiles(root)
      expect(files).toHaveLength(3)
      expect(files[0]).toBe(b) // newest mtime first
      const recent = listRecentSessions(root, 2)
      expect(recent[0]?.firstUser).toBe("newest")
      expect(recent.length).toBeLessThanOrEqual(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("append resilience: an unwritable path counts a failure, never throws", () => {
    const sf = SessionFile.reopen("/proc/definitely/not/writable.jsonl")
    sf.append({ ts: 1, type: "user_message", content: "x" })
    expect(sf.hasErrors).toBe(true)
  })

  test("user_message images round-trip; malformed attachment records are dropped", () => {
    const root = sandbox()
    try {
      const path = sessionFilePath(root, "inst-img", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      const att = { id: "abc123", name: "shot.png", mediaType: "image/png", bytes: 42, path: "/tmp/shot.png", width: 4, height: 3 }
      sf.append({ ts: 1, type: "user_message", content: "look", images: [att] })
      sf.append({ ts: 2, type: "user_message", content: "plain" })
      const loaded = loadSessionFile(path)
      expect(loaded.messages).toEqual([
        { role: "user", content: "look", ts: 1, images: [att] },
        { role: "user", content: "plain", ts: 2 },
      ])
      // A malformed image list degrades to a plain user record, never throws.
      writeFileSync(
        path,
        [
          JSON.stringify({ ts: 1, type: "user_message", content: "bad", images: [{ id: "x" }, "junk"] }),
        ].join("\n"),
      )
      const reloaded = loadSessionFile(path)
      expect(reloaded.messages).toEqual([{ role: "user", content: "bad", ts: 1 }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("deleteSessionFile unlinks the transcript + sidecar, is idempotent, and fails cleanly on an undeletable path", () => {
    const root = sandbox()
    try {
      const path = sessionFilePath(root, "inst-del", 1, 0)
      SessionFile.create(path, { endpoint: "main", model: "m" }).append({ ts: 1, type: "user_message", content: "bye" })
      writeSessionMeta(path, { title: "to remove", tags: ["x"] })
      expect(existsSync(path)).toBe(true)
      expect(existsSync(sessionMetaPath(path))).toBe(true)

      expect(deleteSessionFile(path)).toBe(true)
      expect(existsSync(path)).toBe(false)
      expect(existsSync(sessionMetaPath(path))).toBe(false)
      // Already gone: still reports success and never throws.
      expect(deleteSessionFile(path)).toBe(true)

      // A path that cannot be unlinked (a directory) fails cleanly.
      const dir = join(root, "a-directory")
      mkdirSync(dir, { recursive: true })
      expect(deleteSessionFile(dir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
