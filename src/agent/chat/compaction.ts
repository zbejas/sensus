/**
 * LLM context management (docs/agent.md "Context management & compaction"),
 * modeled on OpenCode's compaction:
 *
 *  - request token estimates anchored on the last provider usage (chars/4
 *    fallback when no usage has been seen yet)
 *  - a preflight trigger near the model's context limit:
 *      estimate >= contextLimit - reserve
 *    where reserve = max(min(maxTokens, 32k cap), bufferTokens)
 *  - a CHECKPOINT: one extra no-tools request produces a structured summary;
 *    it replaces the older history beside a retained recent tail (keepTokens)
 *    kept verbatim. The checkpoint is presented to the model as historical
 *    context, explicitly NOT new instructions.
 *  - one-shot recovery when a provider reports a context overflow
 *  - a DURABLE per-generation terminal context message appended to the
 *    history (never re-derived or rewritten — prompt-cache invariant,
 *    docs/agent.md "Prompt caching"). History is append-only: a tool result is
 *    capped once at the tool boundary (its full text spilled to disk) and
 *    clipped only while serializing into the summary request. The optional
 *    `compaction.prune` pass is the sole exception — an explicit, logged
 *    cache-invalidating rewrite (docs/config.md "compaction")
 *
 * Everything here is pure; ChatSession drives the actual requests.
 */

import { TOOL_SPECS, truncateHeadTail } from "../tools.ts"
import { estimateImageTokens } from "../../core/image.ts"
import type { ProviderMessage } from "../provider/provider.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.chat")

/** Rough chars-per-token for the local estimator (ASCII-leaning). */
export const CHARS_PER_TOKEN = 4
/** Context limit when the model catalog has no entry for the active model. */
export const FALLBACK_CONTEXT_LIMIT = 128_000
/**
 * Rough token cost of the core tool specs (OpenAI counts them into the
 * prompt). Computed once from the REAL specs (`TOOL_SPECS`) so growing the
 * tool set cannot silently undercount and delay compaction — the old hardcoded
 * 1500 dated from when there were 7 short specs.
 */
export const TOOL_SPEC_TOKENS: number = computeToolSpecTokens()
/** OpenCode-style cap on the output reserve so a huge maxTokens cannot push
 * the trigger past every useful threshold. */
export const COMPACT_OUTPUT_RESERVE_CAP = 32_000
/** Default retained recent context beside a checkpoint (OpenCode keep.tokens). */
export const DEFAULT_KEEP_TOKENS = 15_000
/** Default safety reserve below the context limit (OpenCode buffer). */
export const DEFAULT_BUFFER_TOKENS = 20_000
/** Tool results are clipped to this size ONLY while serializing the summary request. */
export const SERIALIZE_TOOL_CHARS = 2_000
/** Marker at the head of a checkpoint message (also detects prior checkpoints). */
export const CHECKPOINT_TAG = "<conversation-checkpoint>"

/**
 * Absolute output ceiling for a mechanical one-shot pass (chat compaction):
 * generous enough that a reasoning model's hidden thinking plus the answer fit,
 * still bounded against a runaway pass.
 */
export const ONE_SHOT_MAX_TOKENS = 32_768
/** Endpoint-max clamp for a one-shot pass before the model's advertised output
 * limit is considered (docs/agent.md "Context management & compaction"). */
const ONE_SHOT_ENDPOINT_CLAMP = 8_192

/**
 * Output-token budget for a mechanical one-shot pass. A reasoning model spends
 * the completion budget on hidden thinking before it emits content, so when the
 * model's advertised output limit is known and larger than the endpoint's
 * configured max, use it — up to {@link ONE_SHOT_MAX_TOKENS}. Unknown model
 * limits fall back to the endpoint max clamped to {@link ONE_SHOT_ENDPOINT_CLAMP},
 * so a plain endpoint is never sent a budget it did not already accept.
 */
export function oneShotMaxTokens(endpointMaxTokens: number | null | undefined, modelOutput?: number | null): number {
  const n =
    typeof endpointMaxTokens === "number" && Number.isFinite(endpointMaxTokens)
      ? Math.max(1, Math.floor(endpointMaxTokens))
      : ONE_SHOT_ENDPOINT_CLAMP
  const base = Math.min(n, ONE_SHOT_ENDPOINT_CLAMP)
  const advertised =
    typeof modelOutput === "number" && Number.isFinite(modelOutput) && modelOutput > 0 ? Math.floor(modelOutput) : 0
  return Math.max(base, Math.min(advertised, ONE_SHOT_MAX_TOKENS))
}

/**
 * Estimate the core tool specs' token cost from the real specs. Defensive: a
 * serialization failure degrades to the legacy placeholder rather than
 * breaking module load (the TUI must never crash on unexpected data).
 */
function computeToolSpecTokens(): number {
  try {
    const json = JSON.stringify(TOOL_SPECS)
    if (typeof json !== "string" || json.length === 0) return 1_500
    return Math.max(1, Math.ceil(json.length / CHARS_PER_TOKEN))
  } catch (e) {
    log.debug("tool spec token estimate failed; using placeholder", { err: e })
    return 1_500
  }
}

// ---- Token estimation ------------------------------------------------------

/** ~tokens for a string (never 0 for non-empty input). */
export function estTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Local estimate of ONE message (per-message RPC overhead + images +
 * tool-call arguments included). Single source of truth for the list
 * estimator and the Context inspector's per-row token suffix. */
export function estimateMessageTokens(m: ProviderMessage): number {
  let n = estTokens(m.content) + 4
  if (m.role === "tool") n += 8
  if (m.images !== undefined) {
    for (const a of m.images) n += estimateImageTokens(a)
  }
  if (m.toolCalls) {
    for (const c of m.toolCalls) n += estTokens(c.name) + estTokens(c.arguments) + 8
  }
  return n
}

/** Local estimate of a message list (per-message RPC overhead included). */
export function estimateMessagesTokens(messages: readonly ProviderMessage[]): number {
  let n = 0
  for (const m of messages) n += estimateMessageTokens(m)
  return n
}

/** Anchor from the last response: its prompt tokens covered `historyLength`
 * messages of the durable history; everything after is new content. */
export interface UsageAnchor {
  promptTokens: number
  historyLength: number
}

/**
 * Next-request estimate: anchored on the last usage when available (prompt
 * tokens + locally estimated new content), full local estimate otherwise.
 * Invalid anchors (empty, or pointing past the history — e.g. after a
 * compaction replaced it) fall back to the local estimate.
 */
export function estimateRequestTokens(opts: {
  history: readonly ProviderMessage[]
  systemPrompt: string
  withTools: boolean
  anchor: UsageAnchor | null
  /** MCP specs' token estimate (M11) — on top of TOOL_SPEC_TOKENS. */
  extraToolSpecTokens?: number
}): number {
  const local =
    estTokens(opts.systemPrompt) +
    estimateMessagesTokens(opts.history) +
    (opts.withTools ? TOOL_SPEC_TOKENS + Math.max(0, opts.extraToolSpecTokens ?? 0) : 0)
  const a = opts.anchor
  if (!a || a.promptTokens <= 0 || a.historyLength > opts.history.length) return local
  return a.promptTokens + estimateMessagesTokens(opts.history.slice(a.historyLength))
}

/**
 * The `maxOutputTokens` to send for a generation (docs/config.md "maxTokens").
 * Precedence: an explicit endpoint `maxTokens` wins; otherwise the model's
 * advertised output limit (models.dev `limit.output`); otherwise `undefined`,
 * which OMITS the field so the endpoint applies its own default. `undefined`
 * therefore means "auto", never a silent 8192 cap (a user is not hindered below
 * what their model can emit).
 */
export function resolveOutputTokens(
  endpointMaxTokens: number | null | undefined,
  modelOutput: number | null | undefined,
): number | undefined {
  if (typeof endpointMaxTokens === "number" && Number.isFinite(endpointMaxTokens) && endpointMaxTokens > 0) {
    return Math.floor(endpointMaxTokens)
  }
  if (typeof modelOutput === "number" && Number.isFinite(modelOutput) && modelOutput > 0) {
    return Math.floor(modelOutput)
  }
  return undefined
}

/** OpenCode formula: reserve = max(min(output reserve, 32k cap), buffer).
 * The reserve is subtracted from the EFFECTIVE ceiling (min(context window,
 * input ceiling) — see `resolveContextLimit`), because the compaction summary
 * request that must fit is itself an input and can be rejected by the
 * provider's input cap. An unknown output cap (auto with no advertised model
 * limit) reserves nothing beyond the buffer — the estimate is not pushed past
 * the useful threshold by a guess. */
export function compactionReserve(maxTokens: number | null | undefined, bufferTokens: number): number {
  const known = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  const cappedOutput = Math.max(0, Math.min(known, COMPACT_OUTPUT_RESERVE_CAP))
  return Math.max(cappedOutput, Math.max(0, bufferTokens))
}

/** Trigger rule: `estimate >= effectiveCeiling - reserve`, where
 * `contextLimit` is the effective input-capped ceiling from
 * `resolveContextLimit` (min(context window, provider input cap)). The reserve
 * stays on top of that ceiling: the compaction summary request itself must fit
 * under the input cap, so compacting any later would leave a request the
 * provider rejects. */
export function shouldCompact(estimate: number, contextLimit: number, reserve: number): boolean {
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return false
  return estimate >= contextLimit - reserve
}

/**
 * Resolve the effective context ceiling (tokens) for the active model:
 * an explicit positive `context.contextLimit` wins; otherwise the model's
 * metadata (endpoint `models.<id>.contextLimit` → models.dev); otherwise the
 * 128k fallback. `0` (the settings default — "unlimited"/auto) and null both
 * mean "no explicit cap", so the fetched models.dev window is used instead of
 * a hardcoded limit.
 *
 * `metaInput` is the model's advertised INPUT-token ceiling (models.dev
 * `limit.input`, e.g. gpt-5's 272000 beside a 400000 context window). When it
 * is a finite positive number the result is `min(resolved limit, metaInput)` —
 * the API rejects a longer prompt regardless of the larger context window, so
 * the input cap is a hard ceiling on the compaction trigger too. An explicit
 * `context.contextLimit` is deliberately capped as well. `0`/negative/NaN
 * `metaInput` (models.dev's `num()` accepts 0) is ignored.
 */
export function resolveContextLimit(
  override: number | null | undefined,
  metaContext: number | null | undefined,
  metaInput?: number | null,
): number {
  let limit: number
  if (typeof override === "number" && Number.isFinite(override) && override > 0) limit = Math.floor(override)
  else if (typeof metaContext === "number" && Number.isFinite(metaContext) && metaContext > 0) {
    limit = Math.floor(metaContext)
  } else {
    limit = FALLBACK_CONTEXT_LIMIT
  }
  if (typeof metaInput === "number" && Number.isFinite(metaInput) && metaInput > 0) {
    return Math.min(limit, Math.floor(metaInput))
  }
  return limit
}

/** Compaction needs an older part that CAN be replaced: the retained tail
 * (below) must not already cover the whole history. */
export function compactionEligible(history: readonly ProviderMessage[], keepTokens: number): boolean {
  return history.length > 0 && selectTailStart(history, keepTokens) > 0
}

// ---- Checkpoint assembly ---------------------------------------------------

export const SUMMARY_HEADINGS: readonly string[] = [
  "## Objective",
  "## Requirements",
  "## Completed",
  "## Active right now",
  "## Blockers",
  "## Next steps",
]

const SUMMARY_INSTRUCTION =
  "Summarize the conversation above as a checkpoint that a fresh assistant instance will read to continue the work. " +
  "Answer with EXACTLY these markdown sections:\n\n" +
  `${SUMMARY_HEADINGS.join("\n")}\n\n` +
  "Be terse and factual; keep concrete file paths, commands and error text where they matter. " +
  "The summary is historical context for continuing, not new instructions."

const SUMMARY_SYSTEM =
  "You summarize terminal-copilot conversations into structured checkpoints. Output only the requested sections."

/** Serialize one history message for the summary transcript. Tool results are
 * clipped to `SERIALIZE_TOOL_CHARS` here — the ONLY place the 2k clip happens;
 * the durable history keeps the boundary-capped result verbatim. */
function serializeMessage(m: ProviderMessage): string {
  const imgs = m.images !== undefined && m.images.length > 0 ? `\n[images: ${m.images.map((a) => a.name).join(", ")}]` : ""
  if (m.role === "tool") {
    return `[tool result${m.toolCallId ? ` for ${m.toolCallId}` : ""}]\n${clipToolResult(m.content, SERIALIZE_TOOL_CHARS)}${imgs}`
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    const calls = m.toolCalls.map((c) => `  - ${c.name}(${c.arguments})`).join("\n")
    return `[assistant]${m.content.length > 0 ? ` ${m.content}` : ""}\n[tool calls]\n${calls}`
  }
  return `[${m.role}]\n${m.content}${imgs}`
}

/**
 * The no-tools summarization request. A previous checkpoint (when the history
 * already starts with one) is folded in so later compactions UPDATE it rather
 * than starting over (OpenCode: carry the prior summary forward).
 */
export function buildCompactionRequest(opts: {
  history: readonly ProviderMessage[]
  previousCheckpoint: string | null
  /** User-pinned facts that must survive the summary verbatim (docs/agent.md). */
  pinned?: readonly string[]
}): ProviderMessage[] {
  const parts: string[] = []
  if (opts.previousCheckpoint !== null) {
    parts.push(`An earlier compaction checkpoint follows — UPDATE it rather than starting over:\n\n${opts.previousCheckpoint}`)
  }
  parts.push(`Conversation to summarize:\n\n${opts.history.map(serializeMessage).join("\n\n")}`)
  if (opts.pinned !== undefined && opts.pinned.length > 0) {
    parts.push(
      `The user PINNED these facts — they MUST appear VERBATIM (unchanged) in the summary and never be dropped:\n${opts.pinned
        .map((p) => `- ${p}`)
        .join("\n")}`,
    )
  }
  parts.push(SUMMARY_INSTRUCTION)
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ]
}

/** The durable provider message that re-injects user-pinned facts after compaction. */
export function pinnedFactsMessage(facts: readonly string[]): string {
  return [
    "<user-pinned-facts>",
    "The user pinned these facts; keep them in mind and preserve them verbatim:",
    ...facts.map((f) => `- ${f}`),
    "</user-pinned-facts>",
  ].join("\n")
}

/** A summary is usable when it contains at least one template heading. */
export function isValidSummary(text: string): boolean {
  return SUMMARY_HEADINGS.some((h) => text.includes(h))
}

/** One template-repair retry: the bad reply stays in context as an example. */
export function buildSummaryRetry(
  base: readonly ProviderMessage[],
  badReply: string,
): ProviderMessage[] {
  return [
    ...base,
    { role: "assistant", content: badReply },
    {
      role: "user",
      content: `Your reply did not follow the required section template. Answer again with ALL of the sections: ${SUMMARY_HEADINGS.join(", ")}`,
    },
  ]
}

/**
 * Where the retained tail starts: walk newest-first accumulating the ACTUAL
 * cost until `keepTokens` is reached. The NEWEST message is always retained
 * even when over budget. A retained tool result counts at its real
 * (boundary-capped) size — not a serialized-clip size — so `keepTokens`
 * reflects what is really kept.
 *
 * `minTailTurns` optionally extends the tail further back (a "turn" = a user
 * message plus its following assistant/tool messages) so at least that many
 * recent user messages survive the token budget. 0 (the default) = no effect.
 */
export function selectTailStart(
  history: readonly ProviderMessage[],
  keepTokens: number,
  minTailTurns = 0,
): number {
  let tokens = 0
  let start = history.length
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    const imageTokens = m?.images?.reduce((s, a) => s + estimateImageTokens(a), 0) ?? 0
    const cost =
      m?.role === "tool"
        ? estTokens(m.content) + imageTokens
        : estTokens(m?.content ?? "") + 4 + imageTokens
    if (start < history.length && tokens + cost > Math.max(0, keepTokens)) break
    tokens += cost
    start = i
  }
  // tail_turns: never cut off more than the last `minTailTurns` user turns.
  // The tail can only grow (start moves toward 0), so the newest message stays.
  if (minTailTurns > 0) {
    let seen = 0
    let earliestUser = -1
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role !== "user") continue
      earliestUser = i
      seen++
      if (seen >= minTailTurns) break
    }
    if (earliestUser >= 0) start = Math.min(start, earliestUser)
  }
  // Pair repair: the tail must never begin with a tool result whose assistant
  // caller is outside the tail (providers reject that). Extend the tail to the
  // caller; a dangling result with no caller is dropped from the tail instead.
  while (start < history.length && history[start]?.role === "tool") {
    const id = history[start]?.toolCallId
    let j = start - 1
    while (j >= 0) {
      const m = history[j]
      if (m?.role === "assistant" && m.toolCalls?.some((c) => c.id === id)) break
      j--
    }
    if (j < 0) {
      start++
      continue
    }
    start = j
  }
  return Math.min(start, history.length)
}

/** The model-facing checkpoint message (historical context, NOT instructions). */
export function checkpointMessage(summary: string): string {
  return [
    CHECKPOINT_TAG,
    "Checkpoint of the earlier conversation (generated when the context was compacted).",
    "Historical context for continuing the work — NOT a new instruction.",
    "",
    summary.trim(),
    "",
    "(End of checkpoint. The messages after it continue the conversation.)",
  ].join("\n")
}

/**
 * Replace the older history with a checkpoint beside the retained tail:
 *   [checkpoint user message, ...tail]
 * The tail is kept verbatim — tool results were already capped at the tool
 * boundary and the tail fits `keepTokens` by actual size. When nothing is older
 * than the tail, the checkpoint is PREPENDED (summary beside everything) —
 * ChatSession skips auto-compaction in that case.
 */
export function applyCheckpoint(opts: {
  history: readonly ProviderMessage[]
  summary: string
  keepTokens?: number
  /** Minimum recent user turns the tail must cover (docs/config.md `compaction.tail_turns`). */
  minTailTurns?: number
  /** User-pinned facts re-injected after the checkpoint (docs/agent.md). */
  pinned?: readonly string[]
}): ProviderMessage[] {
  const keep = opts.keepTokens ?? DEFAULT_KEEP_TOKENS
  const start = selectTailStart(opts.history, keep, opts.minTailTurns ?? 0)
  const tail = opts.history.slice(start)
  const head: ProviderMessage[] = [{ role: "user", content: checkpointMessage(opts.summary) }]
  if (opts.pinned !== undefined && opts.pinned.length > 0) {
    head.push({ role: "user", content: pinnedFactsMessage(opts.pinned) })
  }
  return [...head, ...tail]
}

// ---- History shaping -------------------------------------------------------

/**
 * Clip ONE tool result to `limit` chars (head+tail, marker in the middle).
 * Used ONLY by the summary serializer (`serializeMessage`) — the durable history
 * keeps the boundary-capped result verbatim, so sent bytes are never rewritten
 * (the prompt-cache invariant, docs/agent.md "Prompt caching").
 */
export function clipToolResult(content: string, limit: number = SERIALIZE_TOOL_CHARS): string {
  return truncateHeadTail(content, limit)
}

// ---- Prune (optional, cache-invalidating) ----------------------------------

/** Tokens of RECENT tool output kept intact by `pruneToolOutputs` (OpenCode PRUNE_PROTECT). */
export const PRUNE_PROTECT_TOKENS = 40_000
/** Minimum reclaimable tokens for a prune pass to commit at all (OpenCode PRUNE_MINIMUM). */
export const PRUNE_MINIMUM_TOKENS = 20_000
/** Tools whose output is never pruned (protects the progressive-skills loader). */
export const PRUNE_PROTECTED_TOOLS: ReadonlySet<string> = new Set(["skill_view"])
/** Replacement body for a pruned tool result (OpenCode parity). */
export const PRUNED_TOOL_CONTENT = "[Old tool result content cleared]"

export interface PruneResult {
  history: ProviderMessage[]
  prunedCount: number
  reclaimedTokens: number
}

/**
 * Optional OpenCode-style prune pass (docs/agent.md "Context management &
 * compaction"; docs/config.md "compaction.prune"): walk the history
 * NEWEST→OLDEST and keep the most recent `protectTokens` of unprotected tool
 * output; every older tool result is a candidate for clearing. The pass commits
 * only when the reclaimable total reaches `minimumTokens` — below that it is a
 * no-op (rewriting sent bytes for negligible gain is not worth a cache miss).
 *
 * Pure: the input array and its messages are never mutated; cleared messages are
 * copied with only `content` replaced (role/toolCallId/toolName stay). Rewriting
 * already-sent bytes invalidates the provider's prompt-cache prefix, so callers
 * MUST make the event observable (ChatSession records an audit entry + toast and
 * resets the usage anchor).
 */
export function pruneToolOutputs(
  history: readonly ProviderMessage[],
  opts: {
    protectTokens?: number
    minimumTokens?: number
    protectedTools?: ReadonlySet<string>
  } = {},
): PruneResult {
  const protect = opts.protectTokens ?? PRUNE_PROTECT_TOKENS
  const minimum = opts.minimumTokens ?? PRUNE_MINIMUM_TOKENS
  const protectedTools = opts.protectedTools ?? PRUNE_PROTECTED_TOOLS
  const marked = new Set<number>()
  let recent = 0
  let reclaimed = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m === undefined || m.role !== "tool") continue
    if (protectedTools.has(m.toolName ?? "")) continue
    const cost = estTokens(m.content)
    if (recent > protect) {
      marked.add(i)
      reclaimed += cost
    } else {
      recent += cost
    }
  }
  if (reclaimed < minimum) {
    return { history: [...history], prunedCount: 0, reclaimedTokens: 0 }
  }
  const next = history.map((m, i) => (marked.has(i) ? { ...m, content: PRUNED_TOOL_CONTENT } : m))
  return { history: next, prunedCount: marked.size, reclaimedTokens: reclaimed }
}

// ---- Overflow recovery -----------------------------------------------------

/**
 * Provider-side context overflow (OpenCode: "provider errors classified as
 * context overflow"). Matched defensively against the surfaced error text —
 * different backends phrase it very differently.
 */
export function isContextOverflowError(error: string | null | undefined): boolean {
  if (!error) return false
  return /context (length|window)|maximum context|too many (tokens|inputs?)|input (is )?too long|prompt (is )?too long|reduce (the )?(length|number of tokens|prompt)/i.test(
    error,
  )
}

// ---- Display ---------------------------------------------------------------

/** "11" -> "11", "12345" -> "12.3k", "1234567" -> "1.2M" (status bar + notes). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.max(0, Math.floor(n)))
}