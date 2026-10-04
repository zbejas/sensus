/**
 * Compaction / context-management unit tests (docs/agent.md "Context
 * management & compaction"): estimation, trigger math, checkpoint assembly,
 * pair-safe tail selection, summary-time tool clipping, overflow detection —
 * all pure.
 */

import { describe, expect, test } from "bun:test"
import {
  applyCheckpoint,
  buildCompactionRequest,
  buildSummaryRetry,
  CHECKPOINT_TAG,
  clipToolResult,
  compactionEligible,
  compactionReserve,
  COMPACT_OUTPUT_RESERVE_CAP,
  estimateMessagesTokens,
  estimateRequestTokens,
  estTokens,
  FALLBACK_CONTEXT_LIMIT,
  formatTokens,
  isContextOverflowError,
  isValidSummary,
  oneShotMaxTokens,
  PRUNE_MINIMUM_TOKENS,
  PRUNE_PROTECT_TOKENS,
  PRUNE_PROTECTED_TOOLS,
  PRUNED_TOOL_CONTENT,
  pruneToolOutputs,
  resolveContextLimit,
  resolveOutputTokens,
  selectTailStart,
  shouldCompact,
  TOOL_SPEC_TOKENS,
} from "../../../../src/agent/chat/compaction.ts"
import type { ProviderMessage, UsageInfo } from "../../../../src/agent/provider/provider.ts"

const msg = (role: ProviderMessage["role"], content: string, extra: Partial<ProviderMessage> = {}): ProviderMessage => ({
  role,
  content,
  ...extra,
})

describe("token estimation", () => {
  test("estimateRequestTokens: local estimate with system/tool overhead and tool-call args", () => {
    // estTokens is ceil(chars/4) underneath.
    expect(estTokens("")).toBe(0)
    expect(estTokens("xxxx")).toBe(1)
    expect(estTokens("xxxxx")).toBe(2)
    // Local estimate: 11 chars -> 3 tokens + 4 overhead + 100 system + the real
    // tool-spec overhead (computed from TOOL_SPECS, not a stale constant).
    const est = estimateRequestTokens({
      history: [msg("user", "hello world")],
      systemPrompt: "s".repeat(400),
      withTools: true,
      anchor: null,
    })
    expect(TOOL_SPEC_TOKENS).toBeGreaterThan(1500)
    expect(est).toBe(3 + 4 + 100 + TOOL_SPEC_TOKENS)
    // Tool calls count their arguments.
    const withCalls = estimateMessagesTokens([
      msg("assistant", "", { toolCalls: [{ id: "1", name: "run_command", arguments: '{"command":"' + "x".repeat(40) + '"}' }] }),
    ])
    expect(withCalls).toBeGreaterThan(10)
  })

  test("usage anchor adds the last prompt usage + locally estimated NEW messages only; stale anchor falls back to local", () => {
    const history = [msg("user", "old"), msg("assistant", "reply"), msg("user", "brand new question")]
    const est = estimateRequestTokens({
      history,
      systemPrompt: "s".repeat(1000),
      withTools: true,
      anchor: { promptTokens: 10_000, historyLength: 2 },
    })
    // 10k anchor + only the third message locally estimated (system/tools
    // assumed unchanged in the stable prefix).
    expect(est).toBe(10_000 + estimateMessagesTokens([history[2]!]))
    // An anchor pointing past the history is stale -> full local estimate.
    const stale = estimateRequestTokens({
      history: [msg("user", "hello")],
      systemPrompt: "",
      withTools: false,
      anchor: { promptTokens: 10_000, historyLength: 5 },
    })
    expect(stale).toBe(estimateMessagesTokens([msg("user", "hello")]))
    // Anchor shape matches UsageInfo consumers.
    const u: UsageInfo = { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    expect(u.promptTokens).toBe(10)
  })
})

describe("compaction trigger math", () => {
  test("reserve = max(min(maxTokens, 32k cap), buffer); fires at limit - reserve; needs a replaceable older part", () => {
    expect(compactionReserve(8192, 20_000)).toBe(20_000)
    expect(compactionReserve(200_000, 20_000)).toBe(COMPACT_OUTPUT_RESERVE_CAP)
    expect(compactionReserve(8192, 0)).toBe(8192)
    expect(compactionReserve(0, 0)).toBe(0)
    expect(shouldCompact(100_000, 128_000, 28_000)).toBe(true)
    expect(shouldCompact(99_999, 128_000, 28_000)).toBe(false)
    expect(shouldCompact(1000, 0, 0)).toBe(false) // no usable limit
    // Eligibility: the tail must not already cover everything.
    const h = [msg("user", "hello")]
    expect(compactionEligible(h, 15_000)).toBe(false)
    expect(compactionEligible([...h, msg("assistant", "y".repeat(200_000))], 15_000)).toBe(true)
    expect(compactionEligible([], 15_000)).toBe(false)
  })

  test("resolveOutputTokens: explicit endpoint max wins; else the model output; else undefined (omit)", () => {
    // An explicit number wins, even when the model advertises more (a user pin).
    expect(resolveOutputTokens(8192, 128_000)).toBe(8192)
    // Unset (auto) -> the model's advertised output limit.
    expect(resolveOutputTokens(undefined, 128_000)).toBe(128_000)
    expect(resolveOutputTokens(null, 64_000)).toBe(64_000)
    // Unset + unknown model -> undefined, which OMITS maxOutputTokens entirely
    // (the endpoint applies its own default; never a silent 8192 cap).
    expect(resolveOutputTokens(undefined, null)).toBeUndefined()
    expect(resolveOutputTokens(undefined, undefined)).toBeUndefined()
  })

  test("reserve: an unknown output cap (auto, no metadata) reserves only the buffer", () => {
    expect(compactionReserve(undefined, 20_000)).toBe(20_000)
    expect(compactionReserve(null, 20_000)).toBe(20_000)
    expect(compactionReserve(undefined, 0)).toBe(0)
  })

  test("oneShotMaxTokens: endpoint clamp for auto/unknown; the model output raises the bounded budget", () => {
    // Explicit endpoint max below the clamp is used as-is.
    expect(oneShotMaxTokens(4096)).toBe(4096)
    // Auto (undefined) = the endpoint clamp, not zero.
    expect(oneShotMaxTokens(undefined)).toBe(8192)
    // The advertised output raises the budget, capped at the one-shot ceiling.
    expect(oneShotMaxTokens(8192, 128_000)).toBe(32_768)
    expect(oneShotMaxTokens(undefined, 16_000)).toBe(16_000)
    expect(oneShotMaxTokens(undefined, null)).toBe(8192)
  })

  test("resolveContextLimit: explicit override wins; else the model metadata; else the 128k fallback (0/null = auto); an advertised input ceiling caps the result", () => {
    // Explicit positive setting beats models.dev.
    expect(resolveContextLimit(32_000, 400_000)).toBe(32_000)
    // 0 (the settings default = unlimited/auto) defers to the fetched window.
    expect(resolveContextLimit(0, 400_000)).toBe(400_000)
    expect(resolveContextLimit(null, 400_000)).toBe(400_000)
    expect(resolveContextLimit(undefined, 400_000)).toBe(400_000)
    // No metadata -> the fallback (never a zero/garbage limit).
    expect(resolveContextLimit(0, null)).toBe(FALLBACK_CONTEXT_LIMIT)
    expect(resolveContextLimit(0, 0)).toBe(FALLBACK_CONTEXT_LIMIT)
    expect(resolveContextLimit(null, -1)).toBe(FALLBACK_CONTEXT_LIMIT)
    // gpt-5 shape: context 400k, input 272k -> the input cap wins.
    expect(resolveContextLimit(0, 400_000, 272_000)).toBe(272_000)
    // No input ceiling: the context resolves as before.
    expect(resolveContextLimit(0, 400_000, null)).toBe(400_000)
    expect(resolveContextLimit(0, 400_000, undefined)).toBe(400_000)
    // No context metadata: the input cap still bounds the 128k fallback.
    expect(resolveContextLimit(0, null, 272_000)).toBe(FALLBACK_CONTEXT_LIMIT)
    expect(resolveContextLimit(0, null, 100_000)).toBe(100_000)
    // An explicit settings pin is capped too — the input cap is a hard ceiling.
    expect(resolveContextLimit(500_000, 400_000, 272_000)).toBe(272_000)
    expect(resolveContextLimit(300_000, null, 272_000)).toBe(272_000)
    // models.dev's `num()` accepts 0: a non-positive/NaN input is ignored.
    expect(resolveContextLimit(0, 400_000, 0)).toBe(400_000)
    expect(resolveContextLimit(0, 400_000, -1)).toBe(400_000)
    expect(resolveContextLimit(0, 400_000, Number.NaN)).toBe(400_000)
  })
})

describe("tail selection (pair-safe)", () => {
  test("budget: newest message always retained, spans ~keepTokens, tool results count at ACTUAL size", () => {
    // Newest message is retained even when over budget.
    const newest = [msg("user", "x".repeat(4000)), msg("assistant", "y".repeat(4000)), msg("user", "latest")]
    expect(selectTailStart(newest, 10)).toBe(2)
    // ~104 tokens per message: the tail holds 2-3 messages, not all 5.
    const history = [
      msg("user", "1".repeat(400)),
      msg("assistant", "2".repeat(400)),
      msg("user", "3".repeat(400)),
      msg("assistant", "4".repeat(400)),
      msg("user", "final"),
    ]
    const start = selectTailStart(history, 250)
    expect(start).toBeGreaterThanOrEqual(2)
    expect(start).toBeLessThanOrEqual(3)
    expect(start).toBeLessThan(history.length)
    // A retained 100k-char tool result costs its REAL ~25k tokens, so it no
    // longer rides free into a 15k tail: only the newest user message stays.
    const bigTool = msg("tool", "z".repeat(100_000), { toolCallId: "c" })
    const withTool = [msg("user", "old"), msg("assistant", "", { toolCalls: [{ id: "c", name: "t", arguments: "{}" }] }), bigTool, msg("user", "n")]
    expect(selectTailStart(withTool, 15_000)).toBe(3)
  })

  test("pair safety: the tail never starts on a tool result whose caller is outside the tail", () => {
    const history: ProviderMessage[] = [
      msg("user", "old question"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "run_command", arguments: "{}" }] }),
      msg("tool", "tool output", { toolCallId: "c1" }),
      msg("assistant", "done"),
      msg("user", "next"),
    ]
    const start = selectTailStart(history, 10)
    const tail = history.slice(start)
    // If the budget forces the caller out, the tool result is dropped from
    // the tail instead of dangling.
    const first = tail[0]
    expect(first?.role === "tool" && tail.every((m) => m.role !== "assistant")).toBe(false)
    // Sanity: newest user message retained.
    expect(tail.at(-1)?.content).toBe("next")
  })

  test("minTailTurns extends the tail to cover at least N recent user turns (0 = no effect)", () => {
    const history: ProviderMessage[] = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "u3"),
      msg("assistant", "a3"),
    ]
    // Tiny budget: only the newest assistant would normally be retained.
    const bare = selectTailStart(history, 1)
    expect(bare).toBe(5)
    expect(selectTailStart(history, 1, 0)).toBe(bare) // default = no effect
    // Two turns back reaches u2 (index 2); three reaches u1 (index 0).
    expect(selectTailStart(history, 1, 2)).toBe(2)
    expect(selectTailStart(history, 1, 3)).toBe(0)
    // More turns than exist: include the earliest user, never past the newest.
    const over = selectTailStart(history, 1, 99)
    expect(over).toBe(0)
    expect(over).toBeLessThan(history.length)
    // A tail that already covers the requested turns is unchanged.
    expect(selectTailStart(history, 100_000, 2)).toBe(0)
  })
})

describe("applyCheckpoint", () => {
  test("replaces older history with the checkpoint + retained tail; the tail is verbatim (no re-clip); nothing older -> checkpoint is prepended", () => {
    const history: ProviderMessage[] = [
      msg("user", "first"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "run_command", arguments: "{}" }] }),
      msg("tool", "z".repeat(10_000), { toolCallId: "c1" }),
      msg("assistant", "middle answer"),
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
    ]
    // Small budget: the 10000-char tool result costs its real ~2500 tokens, so
    // it falls outside the retained tail; the recent pair is kept.
    const next = applyCheckpoint({ history, summary: "## Objective\nDo things", keepTokens: 400 })
    expect(next[0]?.role).toBe("user")
    expect(next[0]?.content.startsWith(CHECKPOINT_TAG)).toBe(true)
    expect(next[0]?.content).toContain("## Objective")
    expect(next[0]?.content).toContain("NOT a new instruction")
    expect(next.find((m) => m.role === "tool")).toBeUndefined()
    expect(next.at(-1)?.content).toBe("recent answer")
    // A budget that fits the tool keeps it VERBATIM — the boundary cap is the
    // only cap, and applyCheckpoint never re-clips the retained tail.
    const kept = applyCheckpoint({ history, summary: "## Objective\nDo things", keepTokens: 15_000 })
    const tool = kept.find((m) => m.role === "tool")
    expect(tool?.content).toBe("z".repeat(10_000))
    expect(tool?.content).not.toContain("truncated")
    // Nothing older than the tail: the checkpoint is simply prepended.
    const tiny = applyCheckpoint({ history: [msg("user", "only")], summary: "## Objective\nx", keepTokens: 15_000 })
    expect(tiny[0]?.content.startsWith(CHECKPOINT_TAG)).toBe(true)
    expect(tiny).toHaveLength(2)
    expect(tiny[1]?.content).toBe("only")
  })

  test("minTailTurns keeps at least N recent user turns verbatim beside the checkpoint", () => {
    const history: ProviderMessage[] = [
      msg("user", "old question"),
      msg("assistant", "old answer"),
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
    ]
    // Tiny budget alone would retain only the newest assistant reply.
    const bare = applyCheckpoint({ history, summary: "## Objective\nx", keepTokens: 1 })
    expect(bare.find((m) => m.role === "user" && m.content === "recent question")).toBeUndefined()
    const kept = applyCheckpoint({ history, summary: "## Objective\nx", keepTokens: 1, minTailTurns: 2 })
    expect(kept[0]?.content.startsWith(CHECKPOINT_TAG)).toBe(true)
    expect(kept.some((m) => m.role === "user" && m.content === "old question")).toBe(true)
    expect(kept.some((m) => m.role === "user" && m.content === "recent question")).toBe(true)
    expect(kept.at(-1)?.content).toBe("recent answer")
  })
})

describe("prune (optional, cache-invalidating)", () => {
  const tool = (content: string, extra: Partial<ProviderMessage> = {}): ProviderMessage =>
    msg("tool", content, { toolCallId: "c", toolName: "shell_background", ...extra })

  test("constants mirror OpenCode; protected tools covers the skills loader", () => {
    expect(PRUNE_PROTECT_TOKENS).toBe(40_000)
    expect(PRUNE_MINIMUM_TOKENS).toBe(20_000)
    expect(PRUNE_PROTECTED_TOOLS.has("skill_view")).toBe(true)
    expect(PRUNED_TOOL_CONTENT).toBe("[Old tool result content cleared]")
  })

  test("keeps the recent protected window; clears older tool outputs and reports counts", () => {
    // 400 chars -> 100 tokens each. protect=100 keeps the two newest.
    const a = tool("a".repeat(400), { toolCallId: "a" })
    const b = tool("b".repeat(400), { toolCallId: "b" })
    const c = tool("c".repeat(400), { toolCallId: "c" })
    const d = tool("d".repeat(400), { toolCallId: "d" })
    const history = [a, b, c, d]
    const res = pruneToolOutputs(history, { protectTokens: 100, minimumTokens: 100 })
    expect(res.prunedCount).toBe(2)
    expect(res.reclaimedTokens).toBe(200)
    expect(res.history[0]?.content).toBe(PRUNED_TOOL_CONTENT)
    expect(res.history[1]?.content).toBe(PRUNED_TOOL_CONTENT)
    expect(res.history[2]?.content).toBe("c".repeat(400))
    expect(res.history[3]?.content).toBe("d".repeat(400))
    // role/toolCallId/toolName survive the content rewrite.
    expect(res.history[0]?.role).toBe("tool")
    expect(res.history[0]?.toolCallId).toBe("a")
    expect(res.history[0]?.toolName).toBe("shell_background")
    // Pure: the input array and its messages are untouched.
    expect(history[0]?.content).toBe("a".repeat(400))
    expect(history).toHaveLength(4)
  })

  test("commit threshold: below the minimum the pass is a no-op (history unchanged)", () => {
    const a = tool("a".repeat(400))
    const b = tool("b".repeat(400))
    const c = tool("c".repeat(400))
    const d = tool("d".repeat(400))
    const history = [a, b, c, d]
    // 200 reclaimable < 500 minimum.
    const res = pruneToolOutputs(history, { protectTokens: 100, minimumTokens: 500 })
    expect(res.prunedCount).toBe(0)
    expect(res.reclaimedTokens).toBe(0)
    expect(res.history.map((m) => m.content)).toEqual(history.map((m) => m.content))
  })

  test("protected tools are never cleared even when old", () => {
    const old = tool("s".repeat(400), { toolCallId: "s", toolName: "skill_view" })
    const a = tool("a".repeat(400), { toolCallId: "a" })
    const b = tool("b".repeat(400), { toolCallId: "b" })
    const c = tool("c".repeat(400), { toolCallId: "c" })
    const res = pruneToolOutputs([old, a, b, c], { protectTokens: 100, minimumTokens: 100 })
    expect(res.history[0]?.content).toBe("s".repeat(400))
    expect(res.history[0]?.toolName).toBe("skill_view")
    // The older unprotected output IS cleared; the protected one is skipped.
    expect(res.history[1]?.content).toBe(PRUNED_TOOL_CONTENT)
    expect(res.prunedCount).toBe(1)
    expect(res.reclaimedTokens).toBe(100)
  })

  test("a custom protected set/thresholds are honored; non-tool messages are untouched", () => {
    const system = msg("system", "x".repeat(400))
    const a = tool("a".repeat(400))
    const b = tool("b".repeat(400))
    const res = pruneToolOutputs([system, a, b], {
      protectTokens: 0,
      minimumTokens: 10,
      protectedTools: new Set(["other"]),
    })
    // With protect=0 the newest tool output still fills the window; the older
    // one is cleared. The system message is never considered.
    expect(res.history[0]?.content).toBe(system.content)
    expect(res.history[1]?.content).toBe(PRUNED_TOOL_CONTENT)
    expect(res.history[2]?.content).toBe("b".repeat(400))
    expect(res.prunedCount).toBe(1)
    expect(res.reclaimedTokens).toBe(100)
  })
})

describe("summary request + validation", () => {
  test("buildCompactionRequest serializes roles/tool calls without tools; a previous checkpoint is folded in for updating", () => {
    const history: ProviderMessage[] = [
      msg("user", "please run ls"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "run_command", arguments: `{"command":"ls"}` }] }),
      msg("tool", "file.txt", { toolCallId: "c1" }),
      msg("assistant", "here is the listing"),
    ]
    const req = buildCompactionRequest({ history, previousCheckpoint: null })
    expect(req).toHaveLength(2)
    expect(req[0]?.role).toBe("system")
    const user = req[1]!
    expect(user.content).toContain("[user]")
    expect(user.content).toContain("[tool result for c1]")
    expect(user.content).toContain("[tool calls]")
    expect(user.content).toContain("## Next steps")
    expect(user.content).not.toContain("UPDATE it")
    // With a previous checkpoint, the request asks to UPDATE it.
    const prev = `${CHECKPOINT_TAG}\nold summary`
    const update = buildCompactionRequest({ history: [msg("user", "hi")], previousCheckpoint: prev })
    expect(update[1]?.content).toContain("UPDATE it")
    expect(update[1]?.content).toContain("old summary")
  })

  test("isValidSummary requires a template heading; the retry request appends the bad reply + instruction", () => {
    expect(isValidSummary("## Objective\nstuff")).toBe(true)
    expect(isValidSummary("## Blockers\nnone")).toBe(true)
    expect(isValidSummary("just some prose")).toBe(false)
    expect(isValidSummary("")).toBe(false)
    const base = buildCompactionRequest({ history: [msg("user", "hi")], previousCheckpoint: null })
    const retry = buildSummaryRetry(base, "prose without headings")
    expect(retry).toHaveLength(4)
    expect(retry[2]?.role).toBe("assistant")
    expect(retry[2]?.content).toBe("prose without headings")
    expect(retry[3]?.content).toContain("## Objective")
  })
})

describe("summary-serialization tool clipping", () => {
  test("clipToolResult truncates over-limit output (head+tail, marker in the middle); short output untouched", () => {
    const big = clipToolResult("z".repeat(9_000))
    expect(big.length).toBeLessThan(2_200)
    expect(big).toContain("truncated")
    expect(clipToolResult("short output")).toBe("short output")
  })

  test("buildCompactionRequest clips a >2k tool result in the serialized summary text", () => {
    const history: ProviderMessage[] = [
      msg("assistant", "", { toolCalls: [{ id: "c9", name: "run_command", arguments: "{}" }] }),
      msg("tool", "z".repeat(9_000), { toolCallId: "c9" }),
    ]
    const req = buildCompactionRequest({ history, previousCheckpoint: null })
    const text = req[1]!.content
    expect(text).toContain("[tool result for c9]")
    expect(text).toContain("truncated")
    // Only the clipped ~2k body is serialized, never the full 9k.
    expect(text).not.toContain("z".repeat(3_000))
  })
})

describe("overflow detection + status formatting", () => {
  test("isContextOverflowError matches provider phrasings, ignores unrelated errors", () => {
    for (const phrase of [
      "HTTP 400: This model's maximum context length is 8192 tokens",
      "context length exceeded",
      "input is too long for the model",
      "too many tokens in the prompt",
      "please reduce the length of your messages",
    ]) {
      expect(isContextOverflowError(phrase)).toBe(true)
    }
    for (const other of [null, "", "HTTP 429: rate limit", "network: connection refused", "HTTP 401: invalid api key"]) {
      expect(isContextOverflowError(other)).toBe(false)
    }
  })

  test("formatTokens compacts for the status bar", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(11)).toBe("11")
    expect(formatTokens(42_000)).toBe("42.0k")
    expect(formatTokens(1_280_000)).toBe("1.3M")
  })
})

describe("pinned facts survive compaction (docs/agent.md)", () => {
  test("the summary request demands verbatim preservation and applyCheckpoint re-injects the pins", () => {
    const history = [msg("user", "earlier turn"), msg("assistant", "reply")]
    const req = buildCompactionRequest({ history, previousCheckpoint: null, pinned: ["the ssh port is 2222"] })
    expect(req[1]?.content).toContain("the ssh port is 2222")
    expect(req[1]?.content).toMatch(/VERBATIM/i)

    const next = applyCheckpoint({ history, summary: "a summary", keepTokens: 0, pinned: ["the ssh port is 2222"] })
    expect(next[0]?.content).toContain(CHECKPOINT_TAG)
    expect(next[1]?.content).toContain("the ssh port is 2222")
    // Without pins, no extra message is inserted.
    const plain = applyCheckpoint({ history, summary: "s", keepTokens: 0 })
    expect(plain[1]?.content).not.toContain("user-pinned-facts")
  })
})
