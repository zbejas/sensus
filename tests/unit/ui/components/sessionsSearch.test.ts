/**
 * SessionsSearch pure helpers: the recents list shown by `/sessions` before
 * any typing (fixed-cell row layout + detail pane) and the search-hit detail
 * pane. No renderer, no tmux — the component's data shaping only.
 */

import { describe, expect, test } from "bun:test"
import type { IndexedSession, SessionSearchHit } from "../../../../src/session/indexDb.ts"
import {
  fmtSessionTs,
  hitDetailLines,
  openMarkFor,
  recentsDetailLines,
  recentsRowParts,
  shortSessionId,
  wrapSnippet,
} from "../../../../src/ui/components/SessionsSearch.tsx"

const session = (over: Partial<IndexedSession> = {}): IndexedSession => ({
  path: "/data/sessions/inst1/tab-1.jsonl",
  sessionId: "inst1/tab-1",
  title: "Set up the alpha project",
  tags: [],
  messages: 7,
  lastTs: 1_700_000_000_000,
  firstUser: "hello there",
  ...over,
})

describe("recents row layout (stale-paint fixed budget)", () => {
  test("segments always sum to the row budget and truncate the title", () => {
    const budget = 60
    const p = recentsRowParts(session(), true, budget)
    const total = p.pre.length + p.marker.length + p.time.length + p.sid.length + [...p.title].length + [...p.pad].length
    expect(total).toBe(budget)
    expect(p.pre).toBe(" ❯ ")
    expect(p.marker).toBe("  ")
    expect(p.markerTone).toBe("muted")
    expect(p.time.trimEnd()).toBe(fmtSessionTs(1_700_000_000_000))
    expect(p.sid).toBe(`${shortSessionId("inst1/tab-1").padEnd(16)} `)
    expect(p.title).toContain("Set up")
  })

  test("a long title is clipped and the unselected marker is blank", () => {
    const p = recentsRowParts(session({ title: "x".repeat(200) }), false, 40)
    expect(p.pre).toBe("   ")
    expect([...p.title].length + [...p.pad].length).toBe(Math.max(0, 40 - 3 - 2 - 17 - 17))
  })

  test("an open session shows the tab-style marker (active dot / open dot / activity)", () => {
    const active = recentsRowParts(session(), false, 60, openMarkFor({ active: true, index: 1, activity: null }))
    expect(active.marker).toBe("● ")
    expect(active.markerTone).toBe("accent")
    const open = recentsRowParts(session(), false, 60, openMarkFor({ active: false, index: 2, activity: null }))
    expect(open.marker).toBe("· ")
    expect(open.markerTone).toBe("muted")
    const busy = recentsRowParts(session(), false, 60, openMarkFor({ active: false, index: 3, activity: { glyph: "!", tone: "warning" } }))
    expect(busy.marker).toBe("! ")
    expect(busy.markerTone).toBe("warning")
    // The budget still holds with a marker present.
    const total = busy.pre.length + busy.marker.length + busy.time.length + busy.sid.length + [...busy.title].length + [...busy.pad].length
    expect(total).toBe(60)
  })

  test("an unknown timestamp renders as a single '?' padded into the budget", () => {
    expect(fmtSessionTs(null)).toBe("?")
    const p = recentsRowParts(session({ lastTs: null }), false, 50)
    expect(p.time).toBe(`${"?".padEnd(16)} `)
  })
})

describe("detail panes", () => {
  test("recents detail surfaces id, time, message count, tags and title", () => {
    const lines = recentsDetailLines(session({ tags: ["work", "alpha"] }), 80, 4)
    expect(lines.length).toBeLessThanOrEqual(4)
    const joined = lines.join("\n")
    expect(joined).toContain("inst1/tab-1")
    expect(joined).toContain("7 msg")
    expect(joined).toContain("work,alpha")
    expect(joined).toContain("Set up the alpha project")
    expect(joined).toContain("hello there")
  })

  test("an open session's detail notes the tab position and active state", () => {
    const active = openMarkFor({ active: true, index: 2, activity: null })
    expect(recentsDetailLines(session(), 80, 4, active).join("\n")).toContain("open in tab 2 (active)")
    const other = openMarkFor({ active: false, index: 3, activity: null })
    const hit: SessionSearchHit = {
      path: "/data/sessions/inst1/tab-1.jsonl",
      sessionId: "inst1/tab-1",
      title: "Set up the alpha project",
      tags: [],
      ts: 1_700_000_000_000,
      role: "user",
      snippet: "hello there",
      messageIndex: 1,
    }
    const note = hitDetailLines(hit, 80, 4, other).join("\n")
    expect(note).toContain("open in tab 3")
    expect(note).not.toContain("(active)")
  })

  test("recents detail falls back to placeholders for an empty session", () => {
    const lines = recentsDetailLines(session({ title: "", firstUser: null }), 80, 4)
    const joined = lines.join("\n")
    expect(joined).toContain("(untitled session)")
    expect(joined).toContain("(no messages)")
  })

  test("hit detail surfaces role, session, message index, path and snippet", () => {
    const hit: SessionSearchHit = {
      path: "/data/sessions/inst1/tab-1.jsonl",
      sessionId: "inst1/tab-1",
      title: "Set up the alpha project",
      tags: ["work"],
      ts: 1_700_000_000_000,
      role: "assistant",
      snippet: "alpha reply here",
      messageIndex: 2,
    }
    const lines = hitDetailLines(hit, 80, 4)
    const joined = lines.join("\n")
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(joined).toContain("assistant")
    expect(joined).toContain("#2")
    expect(joined).toContain(hit.path)
    expect(joined).toContain("alpha reply here")
  })
})

describe("small helpers", () => {
  test("wrapSnippet caps at maxRows and never returns an empty array", () => {
    expect(wrapSnippet("", 10, 3)).toEqual([""])
    expect(wrapSnippet("abcdefghijklmnop", 5, 2)).toEqual(["abcde", "fghij"])
  })
})
