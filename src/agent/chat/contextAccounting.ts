/**
 * ContextAccounting — the context-window accounting seam extracted from
 * ChatSession (MOVE-ONLY). It owns the system-prompt token memo and answers
 * the "what occupies the window / are we already at the limit" questions the
 * preflight compaction and the Context inspector ask.
 *
 * Every pure estimator lives in ./compaction.ts; this class only wires the
 * session's live state to them through `ContextAccountingHost`. `breakdown()`
 * reads through the host getters on purpose so the Context inspector's reactive
 * memo keeps updating while a generation streams.
 */

import {
  compactionReserve,
  estimateMessageTokens,
  estTokens,
  estimateRequestTokens,
  resolveContextLimit,
  shouldCompact,
  TOOL_SPEC_TOKENS,
  type UsageAnchor,
} from "./compaction.ts"
import type { ProviderMessage } from "../provider/provider.ts"
import type { SensusConfig } from "../../config/config.ts"
import type { SkillsCatalog } from "../skills/loader.ts"
import type { ChatMessage, ChatStatus } from "./chatMessages.ts"
import { messagePreview, type ContextBreakdown, type ContextHistoryEntry } from "../../engine/chat/contextInspector.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.chat")

/**
 * The live ChatSession state the accountant reads. All getters are called at
 * accounting time (never cached), so reactive ones (messages/history/status)
 * keep the inspector live.
 */
export interface ContextAccountingHost {
  getConfig(): SensusConfig
  getSkills(): SkillsCatalog | undefined
  /** ChatSession.buildSystemPrompt() */
  getSystemPrompt(): string
  /** ChatSession.mcpSpecTokens() */
  getMcpSpecTokens(): number
  isMcpEnabled(): boolean
  isNoTools(): boolean
  hasKey(): boolean
  getStatus(): ChatStatus
  getHistory(): readonly ProviderMessage[]
  getUsageAnchor(): UsageAnchor | null
  /**
   * Resumed-session reconstruction (docs/agent.md "Context inspector"): the
   * durable-history rows built from the saved transcript (tool calls included)
   * plus the `providerHistory` length they cover at restore time. Null when the
   * session was not resumed or the reconstruction was invalidated (rewind /
   * compaction / prune).
   */
  getRestoredHistory(): { entries: readonly ContextHistoryEntry[]; mark: number } | null
  selectedModel(): string
  agentName(): string
  /** modelMeta()?.context (endpoint override → models.dev). */
  getMetaContext(): number | null | undefined
  /** modelMeta()?.input — the provider's input-token ceiling (models.dev
   * `limit.input`), when advertised. Caps the effective context ceiling. */
  getMetaInput(): number | null | undefined
  /** The resolved output cap (endpoint maxTokens → model output → undefined =
   * omitted) — the output reserve input. */
  getMaxTokens(): number | undefined
  getCompactions(): number
  getCacheRead(): { cached: number; prompt: number } | null
  getMessages(): readonly ChatMessage[]
  getContextEnabled(): boolean
  getPinnedLimit(): number
  /**
   * Connected MCP server count for the system-prompt memo key. Reads the
   * registry; may throw (the accountant maps a throw to -1, as before).
   */
  getMcpServerCount(): number
}

export class ContextAccounting {
  /**
   * System-prompt token memo for the Context inspector (Phase 3.1). The prompt
   * is static by design, but `buildSystemPrompt` reads AGENTS.md from disk; the
   * inspector recomputes on every stream flush, so the estimate is cached until
   * an input actually changes (config object identity, agent/model/mcp/no-tools
   * overrides, skills catalog, connected MCP server count).
   */
  private sysPromptCache: { key: string; tokens: number } | null = null
  private sysPromptCfg: SensusConfig | null = null
  private sysPromptSkills: SkillsCatalog | undefined = undefined

  constructor(private readonly host: ContextAccountingHost) {}

  /**
   * Effective context ceiling (tokens) for the active model: an explicit
   * positive `context.contextLimit` wins; otherwise the resolved metadata
   * (endpoint model override → models.dev); otherwise the 128k fallback — then
   * capped by the model's advertised input-token ceiling (`meta.input`) when
   * known, because the provider rejects a prompt over it even inside a larger
   * context window.
   */
  limit(): number {
    const cfg = this.host.getConfig()
    return resolveContextLimit(cfg.context.contextLimit, this.host.getMetaContext(), this.host.getMetaInput())
  }

  /**
   * Request-token estimate (system prompt + durable history + MCP spec
   * overhead) shared by the preflight and the compaction accounting.
   */
  estimateFor(history: readonly ProviderMessage[], anchor: UsageAnchor | null, withTools: boolean): number {
    return estimateRequestTokens({
      history,
      systemPrompt: this.host.getSystemPrompt(),
      withTools,
      anchor,
      extraToolSpecTokens: withTools ? this.host.getMcpSpecTokens() : 0,
    })
  }

  /** Estimate the next request's tokens (usage-anchored, local fallback). */
  estimateNext(withTools: boolean): number {
    return this.estimateFor(this.host.getHistory(), this.host.getUsageAnchor(), withTools)
  }

  /**
   * Memoized system-prompt token estimate for the inspector: `buildSystemPrompt`
   * reads AGENTS.md, and the inspector recomputes per stream flush. The cache key
   * covers every non-frozen input (the memory snapshot is frozen at construction;
   * `/reload` swaps the config + skills objects, invalidating by identity).
   */
  systemTokens(): number {
    const cfg = this.host.getConfig()
    const skills = this.host.getSkills()
    let mcpCount = 0
    try {
      mcpCount = this.host.isMcpEnabled() ? this.host.getMcpServerCount() : 0
    } catch (e) {
      mcpCount = -1
      log.debug("mcp server count probe failed", { err: e })
    }
    const key = `${this.host.selectedModel()}|${this.host.agentName()}|${this.host.isMcpEnabled() ? 1 : 0}|${this.host.isNoTools() ? 1 : 0}|${mcpCount}`
    if (
      this.sysPromptCache === null ||
      this.sysPromptCfg !== cfg ||
      this.sysPromptSkills !== skills ||
      this.sysPromptCache.key !== key
    ) {
      this.sysPromptCache = { key, tokens: estTokens(this.host.getSystemPrompt()) }
      this.sysPromptCfg = cfg
      this.sysPromptSkills = skills
    }
    return this.sysPromptCache.tokens
  }

  /**
   * Serializable snapshot of what currently occupies the model's context
   * window, for the Context inspector overlay (Phase 3.1, docs/agent.md
   * "Context inspector"). Pure reads of the EXISTING estimators
   * (agent/chat/compaction.ts) + the session's live signals — it never
   * mutates request-building state and never throws: any failure degrades to
   * zeros plus a note so an empty/disabled session still renders.
   *
   * Reading `host.getMessages()` (and the other getters) inside makes the
   * overlay's memo track the session, so the inspector updates live while a
   * generation streams. The durable history is the context itself; the
   * `history` previews are bounded to one line per message.
   */
  breakdown(): ContextBreakdown {
    try {
      // Reactive dependency (providerHistory is not a signal): transcript
      // mutations drive live re-renders during a streaming generation.
      const transcript = this.host.getMessages()
      const enabled = this.host.hasKey() && this.host.getStatus() !== "disabled"
      const withTools = !this.host.isNoTools()
      const systemTokens = this.systemTokens()
      const live = this.host.getHistory()
      const restored = this.host.getRestoredHistory()
      const entryFor = (m: ProviderMessage): ContextHistoryEntry => ({
        role: m.role,
        preview: messagePreview(m.content, m.toolCalls?.map((c) => c.name) ?? [], m.images?.length ?? 0),
        tokens: estimateMessageTokens(m),
      })
      // A resumed tab keeps the persisted tool calls in the DISPLAY while the
      // model still resumes from plain text (v1). Merge the reconstructed
      // prefix with whatever was appended after `mark`, so the inspector shows
      // the whole session and keeps updating as new messages arrive.
      const history =
        restored === null
          ? live.map(entryFor)
          : [...restored.entries, ...live.slice(restored.mark).map(entryFor)]
      const historyTokens = history.reduce((sum, e) => sum + e.tokens, 0)
      const mcpSpecTokens = withTools ? this.host.getMcpSpecTokens() : 0
      const toolSpecTokens = withTools ? TOOL_SPEC_TOKENS : 0
      // The estimate that drives compaction (anchored when a response reported
      // usage). For a resumed tab the display instead sums the reconstructed
      // decomposition: the model's live request is smaller (text-only), so the
      // anchored figure would collapse the percentage back to near zero.
      const nextRequest = this.estimateNext(withTools)
      const used = enabled
        ? restored === null
          ? nextRequest
          : systemTokens + historyTokens + toolSpecTokens + mcpSpecTokens
        : 0
      const limit = this.limit()
      const percent = limit > 0 ? Math.max(0, Math.round((used / limit) * 100)) : 0
      const cache = this.host.getCacheRead()
      const cachePrompt = cache?.prompt ?? 0
      const cacheRead = cache?.cached ?? 0
      const cacheWrite = cachePrompt > 0 ? Math.max(0, cachePrompt - cacheRead) : 0
      const cfg = this.host.getConfig()
      const reserve = compactionReserve(this.host.getMaxTokens(), cfg.context.bufferTokens)
      const note = !enabled
        ? "no API key for this endpoint — context stays empty until one is set"
        : transcript.length === 0 && history.length === 0
          ? "empty context — send a message to start filling the window"
          : restored !== null && restored.entries.length > 0
            ? "resumed from a saved transcript — tool calls are shown, not replayed to the model"
            : null
      return {
        model: this.host.selectedModel(),
        limit,
        used,
        percent,
        systemTokens,
        historyTokens,
        toolSpecTokens,
        mcpSpecTokens,
        messages: history.length,
        compactions: this.host.getCompactions(),
        cacheRead,
        cacheWrite,
        cachePrompt,
        // `pinned` mirrors the real compaction trigger (the live request
        // estimate), so a reconstructed display never shows a false
        // "at capacity" that compaction would not act on.
        pinned: limit > 0 && shouldCompact(nextRequest, limit, reserve),
        enabled,
        note,
        history,
      }
    } catch (e) {
      // Degrade, never throw: the TUI must survive an unexpected session state.
      log.debug("context snapshot build failed; degrading", { err: e })
      return {
        model: "",
        limit: 0,
        used: 0,
        percent: 0,
        systemTokens: 0,
        historyTokens: 0,
        toolSpecTokens: 0,
        mcpSpecTokens: 0,
        messages: 0,
        compactions: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cachePrompt: 0,
        pinned: false,
        enabled: false,
        note: "context unavailable for this session",
        history: [],
      }
    }
  }
}
