import { describe, expect, test } from "bun:test"
import {
  elapsedText,
  formatDuration,
  cardTextWidth,
  cardOuterWidth,
  userBubbleTextWidth,
  layoutMessage,
  layoutThinking,
  liveAssistantLabel,
  segmentAssistant,
  segmentAssistantSpans,
  streamingLabelText,
  thinkingHeaderText,
  reuseRows,
  sameRow,
  type CardAction,
  type LayoutRow,
} from "../../../../src/ui/chat/chatLayout.ts"
import { textLine } from "../../../../src/agent/markdown.ts"
import type { ChatMessage, ToolCardData } from "../../../../src/agent/chat/chatSession.ts"

describe("card / bubble geometry", () => {
  test("assistant cards use the full content width; user bubbles cap at 80%", () => {
    expect(cardTextWidth(52, "assistant")).toBe(52)
    expect(cardTextWidth(52, "tool")).toBe(52)
    expect(cardTextWidth(52, "user")).toBe(41) // floor(52 * 0.8)
    // Tiny widths clamp without going below the content floor.
    expect(cardTextWidth(10, "user")).toBe(10)
    expect(cardOuterWidth(41)).toBe(43)
  })

  test("user bubbles shrink-wrap to the longest line, within [min, cap]", () => {
    // The min leaves room for the label and BOTH affordances (copy + revert).
    const min = 23
    expect(userBubbleTextWidth("hi", 41)).toBe(min)
    expect(userBubbleTextWidth("hello world", 41)).toBe(min) // below the min
    expect(userBubbleTextWidth("x".repeat(20), 41)).toBe(min) // still below the min
    expect(userBubbleTextWidth("x".repeat(30), 41)).toBe(30) // above the min
    expect(userBubbleTextWidth("x".repeat(200), 41)).toBe(41) // cap
    // The widest of several lines wins; empty content stays at the min.
    expect(userBubbleTextWidth("x".repeat(10) + "\n" + "y".repeat(30), 41)).toBe(30)
    expect(userBubbleTextWidth("", 41)).toBe(min)
  })
})

// ---- M10 helpers ---------------------------------------------------------

const toolCard = (over: Partial<ToolCardData>): ChatMessage => ({
  id: 1,
  role: "tool",
  content: "",
  ts: Date.now(),
  tool: {
    callId: "c1",
    name: "run_command",
    paramsSummary: "npm test",
    status: "done",
    ...over,
  },
})

const textOf = (msg: ChatMessage, opts?: Parameters<typeof layoutMessage>[2]): string =>
  layoutMessage(msg, 60, opts)
    .body.map((l) => l.segs.map((s) => s.text).join(""))
    .join("\n")

const actionKinds = (laid: ReturnType<typeof layoutMessage>): string[] =>
  laid.body.flatMap((l) => ((l as { actions?: CardAction[] }).actions ?? []).map((a) => a.kind))

describe("formatDuration / elapsedText", () => {
  test("human durations: sub-second, seconds, minutes (label clock uses whole seconds)", () => {
    const cases: Array<[number, string]> = [
      [0, "0s"],
      [400, "<1s"],
      [2300, "2.3s"],
      [12_400, "12.4s"],
      [64_000, "1m04s"],
      [-5, "0s"], // negative durations never render oddly
    ]
    for (const [ms, want] of cases) expect(formatDuration(ms)).toBe(want)
    // The streaming label rounds to whole seconds instead.
    expect(elapsedText(400)).toBe("<1s")
    expect(elapsedText(9000)).toBe("9s")
    expect(elapsedText(125_000)).toBe("2m05s")
  })

  test("streamingLabelText: the assistant bubble's animated label format", () => {
    expect(streamingLabelText("⠙", "gpt-5", 3000)).toBe("⠙ gpt-5 · 3s")
    expect(streamingLabelText("⋯", "deepseek-v4.1-flash", 0)).toBe("⋯ deepseek-v4.1-flash · <1s")
    expect(streamingLabelText("⠋", "m", 125_000)).toBe("⠋ m · 2m05s")
  })

  test("thinkingHeaderText: the active thinking header and the standalone waiting row share one format", () => {
    expect(thinkingHeaderText("⠹")).toBe("⠹ Thinking")
    expect(thinkingHeaderText("⋯")).toBe("⋯ Thinking")
  })

  test("liveAssistantLabel: never stacks a second spinner above the active thinking header", () => {
    const g = (): string => "⠙"
    // Answer streaming with no live reasoning: the animated model label shows.
    expect(liveAssistantLabel(true, false, g, "gpt-5", 3000)).toBe("⠙ gpt-5 · 3s")
    // Reasoning on screen: the thinking header is the bubble's only live row.
    expect(liveAssistantLabel(true, true, g, "gpt-5", 3000)).toBeNull()
    // Settled: the settled label takes over, no live label.
    expect(liveAssistantLabel(false, false, g, "gpt-5", 3000)).toBeNull()
    // Sub-flush window (reasoning not yet flushed): the label is still the cue.
    expect(liveAssistantLabel(true, false, g, "gpt-5", 0)).toBe("⠙ gpt-5 · <1s")
    // The glyph thunk is lazy: never invoked when the label is suppressed, so
    // the spinner tick is not read for settled/thinking-live blocks.
    let calls = 0
    liveAssistantLabel(false, false, () => { calls++; return "⠙" }, "m", 0)
    liveAssistantLabel(true, true, () => { calls++; return "⠙" }, "m", 0)
    expect(calls).toBe(0)
  })
})

describe("tool card output collapse (chat.toolOutput)", () => {
  const tenLines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n")

  test("toolOutput modes: the legacy default renders everything; 'collapsed' previews 6 lines behind a toggle hint", () => {
    // Default (no opts): fully expanded, no expand hint.
    const expanded = textOf(toolCard({ output: tenLines }))
    expect(expanded).toContain("l10")
    expect(expanded).not.toContain("expand")
    // Collapsed: 6-line preview + clickable expand hint; header + hint rows
    // both carry the toggle action.
    const laid = layoutMessage(toolCard({ output: tenLines }), 60, { toolOutput: "collapsed" })
    const text = laid.body.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
    expect(text).toContain("l6")
    expect(text).not.toContain("l7")
    expect(text).toContain("… +4 lines (click or Alt+E to expand)")
    expect(actionKinds(laid).filter((k) => k === "toggle-card").length).toBe(2)
  })

  test("collapsed cards keep their status/question rows; outputless cards carry no toggle", () => {
    const text = textOf(toolCard({ output: tenLines, status: "pending", allowPrefix: "npm" }), {
      toolOutput: "collapsed",
    })
    expect(text).toContain("awaiting approval")
    expect(text).toContain("[y accept]")
    const noOutput = layoutMessage(toolCard({ output: null }), 60, { toolOutput: "collapsed" })
    expect(actionKinds(noOutput)).not.toContain("toggle-card")
  })

  test("rendering edges: pathological output is capped even when expanded; running cards animate the status glyph", () => {
    const big = Array.from({ length: 500 }, (_, i) => `row-${i}`).join("\n")
    expect(textOf(toolCard({ output: big }), { toolOutput: "expanded" })).toContain("output capped")
    expect(textOf(toolCard({ status: "running", output: null }))).toContain("◐ running")
    expect(textOf(toolCard({ status: "running", output: null }), { runningGlyph: "⠋" })).toContain("⠋ running")
  })

  test("a single long line hints at truncation and is fully revealed when expanded", () => {
    // One long line: no extra SOURCE line to count, but text is still hidden —
    // the card must hint, and the expanded view must WRAP (not re-truncate).
    const longLine = `journal-${"x".repeat(180)}`
    const collapsed = textOf(toolCard({ output: longLine }), { toolOutput: "collapsed" })
    expect(collapsed).toContain("… long line (click or Alt+E to expand)")
    expect(collapsed).not.toContain(longLine)
    const expanded = textOf(toolCard({ output: longLine }), { toolOutput: "expanded" })
    // Wrapped across rows, so drop whitespace and require every char present.
    expect(expanded.replace(/\s/g, "")).toContain(longLine)
  })
})

describe("pending approval card shows the full command", () => {
  const pendingCmd = (over: Partial<ToolCardData>): ChatMessage =>
    toolCard({ name: "shell_background", status: "pending", ...over })

  test("a command clipped by the 72-char peek renders in full (wrapped); the header peek is dropped", () => {
    const cmd = `cd /home/franga2000/DEV/oJPP/karte/django-ticketing && git commit -m ${"x".repeat(80)}`
    const laid = layoutMessage(pendingCmd({ paramsSummary: `${cmd.slice(0, 72)}…`, detail: cmd, allowPrefix: "cd " }), 60)
    const body = laid.body.map((l) => l.segs.map((s) => s.text).join(""))
    const text = body.join("\n")
    // Every character survives the wrap (drop the inserted breaks/spaces).
    expect(text.replace(/\s/g, "")).toContain(cmd.replace(/\s/g, ""))
    // The clipped header peek is suppressed: no truncation marker, bare header.
    expect(body[0]).toBe("▸ shell_background")
    expect(text).not.toContain("…")
    // Status + action rows still follow the full command.
    expect(text).toContain("○ awaiting approval")
    expect(text).toContain("[y accept]")
    expect(text).toContain("[n reject]")
    expect(text).toContain("[a allow cd*]")
  })

  test("a multi-line &&-continued command keeps every source line, not just the first", () => {
    const cmd = "cd /srv/app && \\\nsource .venv/bin/activate && \\\npython manage.py migrate"
    const text = textOf(pendingCmd({ paramsSummary: "cd /srv/app && \\", detail: cmd }))
    expect(text.replace(/\s/g, "")).toContain(cmd.replace(/\s/g, ""))
    expect(text).toContain("python manage.py migrate")
  })

  test("a short single-line command is not duplicated — the header peek already shows it", () => {
    const laid = layoutMessage(pendingCmd({ paramsSummary: "git status", detail: "git status" }), 60)
    const text = laid.body.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
    expect(text).toContain("▸ shell_background  git status")
    expect(text.match(/git status/g)?.length).toBe(1)
  })

  test("only pending cards render the detail", () => {
    const cmd = `echo ${"y".repeat(100)}`
    const text = textOf(
      toolCard({ name: "shell_background", status: "done", paramsSummary: `${cmd.slice(0, 72)}…`, detail: cmd }),
    )
    expect(text).not.toContain("y".repeat(100))
  })
})

describe("ask_user card", () => {
  const askCard = (over: Partial<ToolCardData> = {}): ChatMessage =>
    toolCard({
      name: "ask_user",
      paramsSummary: "",
      question: "Which way?",
      options: ["left", "right"],
      status: "running",
      ...over,
    })

  test("the question renders in full (wrapped, never truncated) and links are clickable", () => {
    const long = `Should I overwrite ${"x".repeat(120)}? See [docs](https://x.dev).`
    const laid = layoutMessage(askCard({ question: long }), 40)
    const body = laid.body.map((l) => l.segs.map((s) => s.text).join(""))
    const text = body.join("\n")
    // Wrapped across rows, so drop the inserted breaks: every char survives.
    expect(text.replace(/\s/g, "")).toContain("x".repeat(120))
    expect(text).not.toContain("…")
    // The markdown link segment carries its href (OSC-8 hyperlink).
    const link = laid.body.flatMap((l) => l.segs).find((s) => s.style.href !== undefined)
    expect(link?.style.href).toBe("https://x.dev")
    // The header never repeats the question (title/content no longer collide).
    expect(body[0]).toBe("▸ ask_user")
  })

  test("any number of options render numbered + clickable; the custom-answer entry is always last", () => {
    const many = ["a", "b", "c", "d", "e", "f"]
    const laid = layoutMessage(askCard({ options: many }), 60)
    const text = laid.body.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
    for (let i = 0; i < many.length; i++) expect(text).toContain(`[${i + 1}] ${many[i]}`)
    expect(text).toContain(`[${many.length + 1}] ✎ type your custom answer in the chat`)
    // Real options carry their index; the custom row points one past the list
    // so App never submits its label as the answer.
    const optionActions = laid.body
      .flatMap((l) => ((l as { actions?: CardAction[] }).actions ?? []))
      .filter((a) => a.kind === "option")
    expect(optionActions.map((a) => a.optionIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test("long options wrap in full — never truncated — and every wrapped row is clickable", () => {
    const long = "Type the NPM admin password in chat — you add the proxy host + certificate yourself"
    const laid = layoutMessage(askCard({ options: [long, "short"] }), 40)
    const rows = laid.body as LayoutRow[]
    const text = rows.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
    // The whole option survives (wrapped across rows; only whitespace breaks).
    expect(text.replace(/\s/g, "")).toContain(long.replace(/\s/g, ""))
    expect(text).not.toContain("…")
    // Continuation rows hang-indent under the option text and carry the SAME
    // action, so clicking any part of a wrapped option picks it.
    const optRows = rows.filter((r) => (r.actions ?? []).some((a) => a.kind === "option" && a.optionIndex === 0))
    expect(optRows.length).toBeGreaterThan(1)
    for (const r of optRows) {
      expect(r.actions?.[0]).toMatchObject({ kind: "option", optionIndex: 0, label: long })
    }
    const cont = optRows[1]!
    expect(cont.segs[0]?.text).toBe(" ".repeat("  [1] ".length))
    expect(cont.segs[0]?.text.trim()).toBe("")
  })

  test("the custom entry is appended even when the model supplies no options", () => {
    const text = textOf(askCard({ options: null }))
    expect(text).toContain("[1] ✎ type your custom answer in the chat")
  })
})

describe("row identity across the spinner tick (reuseRows)", () => {
  // Deterministic frame set (same glyphs as the shared spinner) — no timers.
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴"]
  const ask = (over: Partial<ToolCardData> = {}): ChatMessage =>
    toolCard({
      name: "ask_user",
      paramsSummary: "",
      question: "Which way?",
      options: ["left", "right"],
      status: "running",
      ...over,
    })
  const rowsFor = (glyph: string): LayoutRow[] =>
    layoutMessage(ask(), 60, { runningGlyph: glyph }).body
  const rowText = (r: LayoutRow): string => r.segs.map((s) => s.text).join("")
  const statusAt = (rows: LayoutRow[]): number => rows.findIndex((r) => rowText(r).includes("running"))

  test("one tick rebuilds only the animated status row; the interactive option rows keep their object identity", () => {
    const first = reuseRows([], rowsFor(FRAMES[0]!))
    const next = reuseRows(first, rowsFor(FRAMES[1]!))
    const i = statusAt(first)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(next.length).toBe(first.length)
    // The animated row is a fresh object carrying the new glyph...
    expect(statusAt(next)).toBe(i)
    expect(rowText(next[i]!)).toContain(`${FRAMES[1]} running`)
    expect(next[i]).not.toBe(first[i])
    // ...every other row (question, numbered options, custom entry) is the SAME
    // object, so its <For>-mapped component — and the hover/press signals it
    // owns — survives the tick instead of remounting (docs/DESIGN.md "Motion").
    for (let k = 0; k < first.length; k++) {
      if (k !== i) expect(next[k]).toBe(first[k])
    }
    // The clickable option rows specifically are reused — the hover-target proof.
    const options = first.filter((r) => (r.actions ?? []).some((a) => a.kind === "option"))
    expect(options.length).toBe(3) // two real options + the always-appended custom entry
    for (const r of options) expect(next).toContain(r)
  })

  test("advancing through successive frames never remounts settled rows", () => {
    let prev = reuseRows([], rowsFor(FRAMES[0]!))
    const optionRow = prev.find((r) => (r.actions ?? []).some((a) => a.kind === "option"))
    expect(optionRow).toBeDefined()
    for (let tick = 1; tick < FRAMES.length; tick++) {
      const next = reuseRows(prev, rowsFor(FRAMES[tick]!))
      expect(next).toContain(optionRow!)
      expect(next).not.toBe(prev) // a new array per lay (the glyph must repaint)
      prev = next
    }
  })

  test("sameRow: identical renders reuse; a semantic change is never frozen behind a stale row", () => {
    const a = reuseRows([], rowsFor("⠋"))
    // A re-lay with the same glyph reproduces the exact same rows.
    const rerun = reuseRows(a, rowsFor("⠋"))
    expect(rerun).toEqual(a)
    expect(rerun.every((r, i) => r === a[i])).toBe(true)

    // A changed option must NOT reuse the old object (no stale content).
    const changed = layoutMessage(ask({ options: ["up", "right"] }), 60, { runningGlyph: "⠋" }).body
    const old = a.find((r) => (r.actions ?? []).some((x) => x.kind === "option" && x.optionIndex === 0))
    const merged = reuseRows(a, changed)
    const updated = merged.find((r) => (r.actions ?? []).some((x) => x.kind === "option" && x.optionIndex === 0))
    expect(rowText(updated!)).toContain("up")
    expect(updated).not.toBe(old)

    // sameRow is the predicate: text, style and actions all count.
    const row = textLine("  [1] left", { accent: true }) as LayoutRow
    expect(sameRow(row, { segs: [{ text: "  [1] left", style: { accent: true } }] })).toBe(true)
    expect(sameRow(row, textLine("  [1] right", { accent: true }) as LayoutRow)).toBe(false)
    expect(sameRow(row, { segs: [{ text: "  [1] left", style: {} }] })).toBe(false)
    expect(sameRow(row, { ...row, actions: [{ label: "left", kind: "option", callId: "c1", optionIndex: 0 }] })).toBe(false)
  })
})

describe("thinking block layout", () => {
  const thinkingMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 7,
    role: "assistant",
    content: "Answer",
    ts: Date.now(),
    model: "gpt-5",
    thinking: "Let me reason about this.\nSecond thought.",
    thinkingMs: 2300,
    ...over,
  })

  const headerOf = (tl: { header: { segs: Array<{ text: string }> } }): string =>
    tl.header.segs.map((s) => s.text).join("")
  const bodyOf = (tl: { body: Array<{ segs: Array<{ text: string }> }> }): string =>
    tl.body.map((l) => l.segs.map((s) => s.text).join("")).join("\n")

  test("block states: no text → null; active animates and toggles; done collapses/open with a styled body", () => {
    // Blank / whitespace-only thinking renders nothing.
    expect(layoutThinking(thinkingMsg({ thinking: "" }), 60, { open: false, active: false })).toBeNull()
    expect(layoutThinking(thinkingMsg({ thinking: "   " }), 60, { open: false, active: false })).toBeNull()

    // Active (still reasoning) + hidden: animated header only — the reasoning
    // body is NOT drawn unless the block is open (the /thinking hide bug). The
    // header still carries the toggle action: clicking the live `⠋ Thinking`
    // row expands the reasoning mid-stream.
    const active = layoutThinking(thinkingMsg(), 60, { open: false, active: true, glyph: "⠙" })
    expect(active).not.toBeNull()
    expect(headerOf(active!)).toBe("⠙ Thinking")
    expect(active!.header.actions?.[0]?.kind).toBe("toggle-thinking")
    expect(active!.header.actions?.[0]?.callId).toBe("7")
    expect(bodyOf(active!)).not.toContain("Second thought.")
    expect(active!.body).toEqual([])

    // Active AND open: the body streams while the header animates (still togglable).
    const activeOpen = layoutThinking(thinkingMsg(), 60, { open: true, active: true, glyph: "⠙" })
    expect(activeOpen!.header.actions?.[0]?.kind).toBe("toggle-thinking")
    expect(bodyOf(activeOpen!)).toContain("Second thought.")

    // Done + collapsed: '+ Thought for …' toggle, no body.
    const collapsed = layoutThinking(thinkingMsg(), 60, { open: false, active: false })
    expect(headerOf(collapsed!)).toBe("+ Thought for 2.3s")
    expect(collapsed!.header.actions?.[0]?.kind).toBe("toggle-thinking")
    expect(collapsed!.header.actions?.[0]?.callId).toBe("7")
    expect(collapsed!.body).toEqual([])

    // Done + open: '- Thought for …', dim italic body.
    const open = layoutThinking(thinkingMsg(), 60, { open: true, active: false })
    expect(headerOf(open!)).toBe("- Thought for 2.3s")
    expect(open!.body.length).toBeGreaterThan(0)
    expect(open!.body.every((l) => l.segs.every((s) => s.style.dim === true && s.style.italic === true))).toBe(true)

    // No duration recorded → the header omits it.
    expect(headerOf(layoutThinking(thinkingMsg({ thinkingMs: null }), 60, { open: false, active: false })!)).toBe(
      "+ Thought",
    )
  })

  test("bodyText override renders only the revealed prefix (stream pacing) while the header keeps the real duration", () => {
    const tl = layoutThinking(thinkingMsg(), 60, { open: true, active: false, bodyText: "Let me reason" })
    expect(tl).not.toBeNull()
    expect(bodyOf(tl!)).toContain("Let me reason")
    expect(bodyOf(tl!)).not.toContain("Second thought.")
    expect(headerOf(tl!)).toBe("- Thought for 2.3s")
    // Empty override (nothing revealed yet): no visible body text.
    const empty = layoutThinking(thinkingMsg(), 60, { open: true, active: false, bodyText: "" })
    expect(empty!.body.map((l) => l.segs.map((s) => s.text).join("")).join("").trim()).toBe("")
  })
})

describe("assistant label durations (finishedTs)", () => {
  test("settled labels show the duration; streaming stays clean; the aborted tag survives", () => {
    const base = { id: 3, role: "assistant" as const, content: "hi", ts: 1_000_000, model: "gpt-5" }
    expect(layoutMessage({ ...base, finishedTs: 1_012_400 }, 60).label).toBe("✱ gpt-5 · 12.4s")
    expect(layoutMessage({ ...base }, 60).label).toBe("✱ gpt-5")
    expect(layoutMessage({ ...base, aborted: true }, 60).label).toBe("✱ gpt-5 (aborted)")
    // The label names the AGENT when one is supplied (the model is the fallback).
    expect(layoutMessage(base, 60, { agentName: "copilot" }).label).toBe("✱ copilot")
    expect(layoutMessage({ ...base, finishedTs: 1_012_400 }, 60, { agentName: "copilot" }).label).toBe("✱ copilot · 12.4s")
    // Empty agent name falls back to the model.
    expect(layoutMessage(base, 60, { agentName: "" }).label).toBe("✱ gpt-5")
  })
})

describe("segmentAssistantSpans (stream-reveal offsets)", () => {
  test("yields segmentAssistant's segments plus exact source slices, fences included (even unclosed ones)", () => {
    const content = "Intro paragraph.\n\n```sh\necho one\necho two\n```\n\nOutro."
    const spans = segmentAssistantSpans(content)
    expect(spans.map((s) => s.seg)).toEqual(segmentAssistant(content))
    const [intro, fence, outro] = spans
    expect(intro).toBeDefined()
    expect(fence).toBeDefined()
    expect(outro).toBeDefined()
    // Each span's slice of the source covers its segment's region exactly
    // (a leading blank line belongs to the following prose, as always).
    expect(content.slice(intro!.start, intro!.start + intro!.len)).toBe("Intro paragraph.\n\n")
    expect(content.slice(fence!.start, fence!.start + fence!.len)).toBe("echo one\necho two\n")
    expect(content.slice(outro!.start, outro!.start + outro!.len)).toBe("\nOutro.")
    // Mid-stream: a never-closed fence still yields a code span to the end.
    const partial = "text first\n```js\nlet x = 1"
    const pspans = segmentAssistantSpans(partial)
    expect(pspans.map((s) => s.seg.kind)).toEqual(["prose", "fence"])
    const pfence = pspans[1]!
    expect(pfence.seg.kind === "fence" && pfence.seg.code).toBe("let x = 1")
    expect(partial.slice(pfence.start, pfence.start + pfence.len)).toBe("let x = 1")
  })
})
