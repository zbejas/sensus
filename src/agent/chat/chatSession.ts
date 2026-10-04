/**
 * ChatSession — one per tab (one tab = one terminal session = one chat session).
 * Holds Solid signals for messages / status / tokens and orchestrates the M3
 * tool loop:
 *   send -> slash dispatch -> durable context message -> preflight compaction
 *        -> provider stream (with tools)
 *        -> on tool_calls: SEQUENTIAL execution (approval gates, cards)
 *        -> tool results appended (capped at the tool boundary) -> loop back
 *        (max chat.maxToolTurns turns; default null = no cap) -> persistence.
 *
 * Context management (docs/agent.md "Context management & compaction" +
 * "Prompt caching"): the provider history is APPEND-ONLY
 * — the terminal context block lands once per generation as its own durable
 * message (never re-derived or rewritten), and tool results are capped once at
 * the tool boundary (docs/config.md "tool_output"), so every request's prefix
 * stays byte-identical to the last one and the provider's prompt cache holds
 * across generations. The optional `compaction.prune` pass is the one explicit,
 * logged cache-invalidating exception (docs/config.md "compaction"). When the
 * estimated request approaches the model's context limit (or the provider
 * reports an overflow), the older history folds into a CHECKPOINT (structured
 * summary + retained recent tail) via one extra no-tools request; /compact
 * runs it manually, /status shows the runtime facts (+ cache-hit rate).
 *
 * Non-rendering UI state (input editor, history ring, message scroll) lives
 * here too so ChatSidebar stays a thin view (docs/architecture.md).
 *
 * Esc aborts the generation: the same AbortSignal aborts provider fetches AND
 * kills a running hidden command, and resolves pending approval/ask_user
 * waits as aborted (docs/agent.md loop #5).
 *
 * /clear rotates the session file: slash events append to the OLD file, the
 * transcript is wiped, then deps.rotateFile() points future appends at a new
 * JSONL generation (old file kept on disk).
 */

import { createSignal } from "solid-js"
import * as os from "node:os"
import { readFileSync } from "node:fs"
import {
  activeEndpoint,
  activeEndpointName,
  activeModelId,
  parseSelectedModel,
  selectedModelString,
  sensusStateDir,
  type ApprovalMode,
  type ChatDisplayConfig,
  type SensusConfig,
} from "../../config/config.ts"
import { builtInAgent, fallbackAgent, resolveSudoPrompt, type AgentDef } from "../../config/agents.ts"
import { type CompletedToolCall, type ProviderMessage, type StreamResult, type UsageInfo } from "../provider/provider.ts"
import { parseSlash, type SlashCommand } from "../slash.ts"
import { trustPatternFor, type TrustPattern } from "../tools/approval.ts"
import { activeJobs } from "../tools/jobs.ts"
import {
  applyFilePlan,
  approvalDecision,
  type ApprovalDecision,
  clearJobs,
  type FilePlan,
  executeTool,
  isMemoryWrite,
  parseToolArguments,
  planEditFile,
  planWriteFile,
  READONLY_DENIED_TOOLS,
  readonlyGuardDecision,
  resolveToolName,
  resolveToolPath,
  TOOL_SPECS,
  toolApprovalDetail,
  toolParamsSummary,
  type ToolSpec,
} from "../tools.ts"
import { buildContextBlock, collectGitStatus, tailFingerprint, trimBlankSpam } from "../context.ts"
import { buildSystemPrompt } from "../prompt.ts"
import { findNearestInstructionFile } from "../instructions.ts"
import { toolOutputDir } from "../truncate.ts"
import type { MemorySnapshot, MemoryWriteInfo } from "../memory/types.ts"
import type { SkillsCatalog } from "../skills/loader.ts"
import { filterSkillsForAgent } from "../skills/loader.ts"
import {
  applyCheckpoint,
  buildCompactionRequest,
  buildSummaryRetry,
  CHECKPOINT_TAG,
  compactionEligible,
  compactionReserve,
  DEFAULT_KEEP_TOKENS,
  estTokens,
  formatTokens,
  isContextOverflowError,
  isValidSummary,
  oneShotMaxTokens,
  pruneToolOutputs,
  resolveOutputTokens,
  shouldCompact,
  type UsageAnchor,
} from "./compaction.ts"
import { ContextAccounting } from "./contextAccounting.ts"
import { PromptComposer } from "./promptComposer.ts"
import { ToolCardBook } from "./toolCardBook.ts"
import { dispatchSlash, type SlashHost } from "./slashDispatch.ts"
import {
  cycleThinkingMode,
  defaultThinkingMode,
  lookupModelMeta,
  mergeModelOverride,
  oneShotThinkingKnob,
  resolveThinkingKnob,
  type ModelMeta,
} from "../provider/modelCatalog.ts"
import { canonicalProvider, PROTOCOLS } from "../provider/protocols.ts"
import { InputEditor } from "../../engine/chat/inputEditor.ts"
import { type ImageAttachment } from "../../core/image.ts"
import { type SlashMenuState } from "../../engine/chat/slashComplete.ts"
import { StreamReveal } from "../../engine/chat/streamReveal.ts"
import { type ContextBreakdown, type ContextHistoryEntry } from "../../engine/chat/contextInspector.ts"
import { spinnerFrame } from "../../engine/spinner.ts"
import { errorMessage } from "../../core/util.ts"
import { componentLogger } from "../log.ts"
import { consultApprovalPolicy, EVENT_TARGET_MAX, type SensusEvent } from "../extensions.ts"
import { deriveTitleFromText, readSessionMeta } from "../../session/meta.ts"
import { loadSessionFile, type LoadedToolCall } from "../../session/store.ts"
import {
  recordsToMessages,
  type ChatEvent,
  type ChatMessage,
  type ChatRole,
  type ChatSessionDeps,
  type ChatStatus,
  type McpRegistryLike,
  type McpServerStatusFact,
  type PlanCardData,
  type PlanLine,
  type PlanLineStatus,
  type TerminalSnapshotForChat,
  type ToolCardData,
  type ToolCardStatus,
} from "./chatMessages.ts"

// Re-exported for the established import path (ui + tests import these from
// chatSession); chatMessages.ts is the single definition home.
export {
  recordsToMessages,
  type ChatEvent,
  type ChatMessage,
  type ChatRole,
  type ChatSessionDeps,
  type ChatStatus,
  type McpRegistryLike,
  type McpServerStatusFact,
  type PlanCardData,
  type PlanLine,
  type PlanLineStatus,
  type TerminalSnapshotForChat,
  type ToolCardData,
  type ToolCardStatus,
}

// Re-exported for the Context inspector overlay (its pure formatter owns the
// shape; the session builds the snapshot) — one definition, no drift.
export type { ContextBreakdown, ContextHistoryEntry } from "../../engine/chat/contextInspector.ts"

/** Deltas coalesce for this long before the message list updates (one
 * re-render per flush instead of one per SSE event — smoother streaming on
 * chatty transports). Final flush always runs when the stream resolves. */
const STREAM_FLUSH_MS = 40

const log = componentLogger("agent.chat")

/** Failsafe for the drain-hold (finishStreamingWhenCaught): even a stuck
 * pour cannot hold the streaming display longer than this. */
const REVEAL_DRAIN_FAILSAFE_MS = 3000

/**
 * Doom-loop guard (docs/agent.md "Approval modes"): after this many CONSECUTIVE
 * identical `name` + JSON arguments calls within one generation, the next call
 * is blocked instead of executed.
 */
export const DOOM_LOOP_THRESHOLD = 3

/** Per-ChatSession job scope counter (background jobs are tagged so `/clear`
 * only drops the clearing session's jobs — the registry is process-global). */
let chatSessionScopeSeq = 0

/** Best-effort file read for the audit/undo snapshot ("" on failure). */
function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch (e) {
    log.debug("safeRead failed; treating as empty", { err: e })
    return ""
  }
}

/** A persisted tool call -> the seam's CompletedToolCall (raw args, or `{}` for
 * legacy events that predate the field). */
function toReplayedToolCall(c: LoadedToolCall): CompletedToolCall {
  return { id: c.callId ?? "", name: c.name, arguments: c.arguments ?? "{}" }
}

export class ChatSession {
  private readonly deps: ChatSessionDeps
  /** Stable id tagging this session's background jobs (per-session `/clear`). */
  private readonly jobScope = `chat-${++chatSessionScopeSeq}`
  /** Instance id carried on emitted extension events (docs/extensions.md). */
  private readonly sessionId: string
  /**
   * Highest live-job count already reported to the user at a turn end, so a
   * long-lived background job toasts once instead of on every turn
   * (docs/agent.md "Background-job visibility"). Reset when no jobs remain.
   */
  private reportedJobCount = 0
  /** Input editor + prompt history ring + draft images + slash state (M8). */
  private readonly composer = new PromptComposer({
    getFile: () => this.deps.file(),
    paneCwd: () => this.paneCwd(),
    isVisionModel: () => this.modelMeta()?.vision === true,
  })
  /** Approval/ask wait resolvers + tool-card bookkeeping + the session-only
   * shell_background allow-prefix list (extracted collaborator). */
  private readonly book = new ToolCardBook({
    getMessages: () => this.sMessages[0](),
    patchMessage: (id, patch) => this.patchMessage(id, patch),
    patchToolCard: (callId, patch) => this.patchToolCard(callId, patch),
    addMessage: (m) => this.pushMessage(m),
    getFile: () => this.deps.file(),
    toast: (message, level, ttl) => this.deps.toast(message, level, ttl),
  })

  private readonly sMessages = createSignal<ChatMessage[]>([])
  /**
   * Display title for this session's tab (docs/sessions.md "Auto titles"):
   * the sidecar/auto title when known, else the first-user-message placeholder
   * while the model-generated title is still in flight. Set on the first
   * prompt and on resume; reset by /clear. Display-only — the sidecar stays the
   * host's job.
   */
  private readonly sSessionTitle = createSignal("")
  private readonly sStatus = createSignal<ChatStatus>("idle")
  /**
   * Counts of messages accepted while a reply is streaming (docs/config.md
   * "chat" `busySend`): `steer` entries are injected into the RUNNING turn at
   * the next safe boundary; `queue` entries wait for the next turn. The
   * sidebar renders a small pending indicator; the messages themselves land in
   * the transcript when injected/sent. Display-only.
   */
  private readonly sBusyPending = createSignal<{ steer: number; queue: number }>({ steer: 0, queue: 0 })
  private readonly sTotalTokens = createSignal(0)
  private readonly sApproval = createSignal<ApprovalMode>("confirm")
  /**
   * Session model selection (model picker / /model): a full
   * `endpoint@model` string, seeded in the constructor from the config default.
   * Picks ALSO persist to config.json as the default for NEW sessions — but an
   * already-open session keeps whatever it was using: a config-default change
   * (another tab's pick, a settings write, `/reload`) never yanks a live
   * session's model (docs/config.md "Endpoints and the selected model").
   */
  private readonly sModelOverride = createSignal<string | null>(null)
  /**
   * Session agent override (agent picker / /agent). Unlike the model, a
   * session that never picked follows the live config default (docs/agents.md
   * "Selection semantics").
   */
  private readonly sAgentOverride = createSignal<string | null>(null)
  /** Session thinking-mode override (/effort). Null = the endpoint's
   * thinkingMode (or "default" = omit the knob entirely). */
  private readonly sEffortOverride = createSignal<string | null>(null)
  private readonly sContextEnabled = createSignal(true)
  private readonly sNoTools = createSignal(false)
  /** Session-level MCP toggle (/mcp on|off, M11). Default on. */
  private readonly sMcpEnabled = createSignal(true)
  /** Last request's prompt tokens (status bar ctx display + compaction anchor). */
  private readonly sContextUsed = createSignal(0)
  /** Last response's cached-prompt tokens (the /status cache line). Null when
   * the endpoint does not report prompt_tokens_details. */
  private readonly sCacheRead = createSignal<{ cached: number; prompt: number } | null>(null)
  /** Completed compactions for this session (visible via /status). */
  private readonly sCompactions = createSignal(0)
  /** User-pinned facts: re-injected after a checkpoint so they survive compaction. */
  private readonly sPinned = createSignal<string[]>([])
  /** Timestamp when the current generation started streaming (0 = idle). */
  private readonly sStreamingSince = createSignal(0)
  // ---- display state (docs/config.md "chat"; session overrides via slash) --
  private readonly sThinkingMode = createSignal<"show" | "hide">("hide")
  private readonly sToolDetails = createSignal<"expanded" | "collapsed">("collapsed")
  private readonly sAnimations = createSignal(true)
  /** Message card style ("fill" = borderless panel, "border" = bordered card). */
  private readonly sCardStyle = createSignal<"fill" | "border">("fill")
  /** Per-message thinking-block expansion overrides (keyed by message id). */
  private readonly sThinkingOpen = createSignal<Map<number, boolean>>(new Map())
  /** Per-card expansion overrides (keyed by tool call id). */
  private readonly sCardExpand = createSignal<Map<string, boolean>>(new Map())
  /** Stream-reveal pacing state (docs/agent.md "Streaming display"): one per
   * tab — it must survive the per-flush message-reference recreation and tab
   * switches, and reset on /clear + resume. */
  private readonly reveal = new StreamReveal()
  /** Drain-hold (finishStreamingWhenCaught): the pending flip-to-idle. */
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private drainBubbleId: number | null = null

  private nextId = 0
  private controller: AbortController | null = null
  /** Epoch ms the current generation started (0 = none), for `turn-complete`. */
  private turnStartedAt = 0
  /**
   * Why the in-flight generation was aborted (`abort(reason)`; e.g. `"user"`,
   * `"rewind"`, `"shell-exit"`, `"approval-timeout"`, `"shutdown"`). Read at
   * settle to stamp the `turn completed` record and the `turn-complete` event;
   * reset when a new turn starts. Null while a turn has not been aborted.
   */
  private abortReason: string | null = null

  /**
   * Transport-agnostic event listeners (IF3; docs/agent.md "Remote approval &
   * event stream"). Empty in the TUI; the daemon subscribes to mirror the
   * session without reading Solid signals.
   */
  private readonly chatListeners = new Set<(e: ChatEvent) => void>()
  /** Engine-generated sudo prompt correlation counter (see requestSudoWithEvents). */
  private sudoCounter = 0

  /** Real conversation kept for the provider (includes tool messages). */
  private readonly providerHistory: ProviderMessage[] = []
  /**
   * Busy-send holds (docs/config.md "chat" `busySend`): `pendingSteers` are
   * drained into the provider history at the next safe boundary inside the
   * running generation; `pendingQueue` is flushed as a fresh generation once
   * the current one settles normally.
   */
  private readonly pendingSteers: Array<{ text: string; images: ImageAttachment[] }> = []
  private readonly pendingQueue: Array<{ text: string; images: ImageAttachment[] }> = []
  /**
   * Provider-history position of each user message's generation start (the
   * index where its context block + user text were appended). Lets a rewind
   * (ChatSession.revertToUserMessage) truncate the durable context to exactly
   * that point — preserving tool calls/results in the retained prefix. Cleared
   * whenever the indexes are invalidated (compaction / prune / restore).
   */
  private readonly providerHistoryMarks = new Map<number, number>()
  /**
   * Resumed-session reconstruction for the Context inspector (docs/agent.md
   * "Context inspector"): the durable-history rows rebuilt from the saved
   * transcript, tool calls included — the model still resumes from plain text
   * (v1), but the inspector shows what the session did. `restoredMark` is the
   * `providerHistory` length these rows cover; anything appended later is live
   * content the inspector appends after them. Null when not resumed, or once a
   * rewrite invalidates it (rewind / compaction / prune / clear).
   */
  private restoredHistory: ContextHistoryEntry[] | null = null
  private restoredMark = 0
  /**
   * Set by revertToUserMessage: the generation in flight must not write
   * anything else (no stray bubbles, provider messages or JSONL records) after
   * the transcript was rewound. Reset at the top of every sendMessage.
   */
  private generationRewound = false
  /** Images produced by the CURRENT tool turn (view_image): lifted into the
   * provider history right after the tool results (docs/agent.md "Images"). */
  private readonly pendingToolImages = new Map<string, ImageAttachment[]>()
  /** Nearest-AGENTS.md paths already attached this session (docs/agent.md
   * "System prompt"): a file is attached at most once; /clear resets. */
  private readonly attachedInstructionFiles = new Set<string>()
  /** Doom-loop guard state for the CURRENT generation (reset at generation
   * start): the last tool-call signature and how many times it repeated. */
  private doomLoopSignature: string | null = null
  private doomLoopCount = 0
  /** UI-provided live terminal facts (pane, cwd, scrollback tail). */
  private terminal: (() => TerminalSnapshotForChat | null) | null = null

  private noTools = false

  /** Last response's prompt anchor for request estimates (null = estimate locally). */
  private usageAnchor: UsageAnchor | null = null
  /**
   * The request-shape signature the anchor was captured under (system prompt +
   * tool set). A later request whose shape differs (no-tools flip, MCP servers
   * connecting, agent/model switch) invalidates the anchor, so a stale
   * prompt-token count cannot hide the newly added overhead.
   */
  private usageAnchorKey: string | null = null
  /** Fingerprint of the terminal tail carried in the last context block —
   * an unchanged tail collapses to a note instead of repeated lines. */
  private lastTailFingerprint: string | null = null
  /**
   * Compaction in flight (manual `/compact` or an automatic preflight pass) —
   * blocks sends like a streaming reply. The signal makes it reactive so the
   * sidebar/status bar can show progress (docs/agent.md "Streaming display");
   * the getter/setter keep the existing synchronous reads (`handleInput`,
   * `isWorking`, `slashHost`) working unchanged.
   */
  private readonly sCompacting = createSignal(false)
  /** Context-window accounting + system-prompt token memo (Context inspector). */
  private readonly accounting = new ContextAccounting({
    getConfig: () => this.deps.getConfig(),
    getSkills: () => this.deps.getSkills?.(),
    getSystemPrompt: () => this.buildSystemPrompt(),
    getMcpSpecTokens: () => this.mcpSpecTokens(),
    isMcpEnabled: () => this.sMcpEnabled[0](),
    isNoTools: () => this.noTools,
    hasKey: () => this.hasKey(),
    getStatus: () => this.sStatus[0](),
    getHistory: () => this.providerHistory,
    getUsageAnchor: () => this.currentUsageAnchor(),
    getRestoredHistory: () =>
      this.restoredHistory === null ? null : { entries: this.restoredHistory, mark: this.restoredMark },
    selectedModel: () => this.selectedModel(),
    agentName: () => this.agentName(),
    getMetaContext: () => this.modelMeta()?.context,
    getMetaInput: () => this.modelMeta()?.input,
    getMaxTokens: (): number | undefined => this.outputTokensForRequest(),
    getCompactions: () => this.sCompactions[0](),
    getCacheRead: () => this.sCacheRead[0](),
    getMessages: () => this.sMessages[0](),
    getContextEnabled: () => this.sContextEnabled[0](),
    getPinnedLimit: () => this.sPinned[0]().length,
    getMcpServerCount: () => this.deps.mcp?.connectedServerFacts().length ?? 0,
  })
  /**
   * Frozen MEMORY.md snapshot captured ONCE here (docs/memory.md cache
   * discipline): later memory writes persist but do NOT change this session's
   * system prompt — the next session sees them. `/memory reload` is the
   * explicit cache break.
   */
  private readonly memorySnapshot: MemorySnapshot | null

  constructor(deps: ChatSessionDeps) {
    this.deps = deps
    this.sessionId = deps.sessionId ?? ""
    const cfg = deps.getConfig()
    // Latch the config default HERE (docs/agent.md "Selected model"): model
    // selection is per-session, so a later pick in another tab — which persists
    // a new config default for NEW sessions — must never change this session.
    // Only an explicit /model or picker pick replaces it.
    this.sModelOverride[1](selectedModelString(activeEndpointName(cfg), activeModelId(cfg)))
    this.memorySnapshot = deps.getMemorySnapshot?.() ?? null
    this.sApproval[1](cfg.approval)
    this.sContextEnabled[1](cfg.context.enabled)
    this.sThinkingMode[1](cfg.chat.thinking)
    this.sToolDetails[1](cfg.chat.toolOutput)
    this.sAnimations[1](cfg.chat.animations)
    this.sCardStyle[1](cfg.chat.cardStyle)
    if (!this.hasKey()) this.setStatus("disabled")
  }

  readonly accessors = {
    messages: this.sMessages[0],
    /** Tab display title (docs/sessions.md "Auto titles"); "" = none yet. */
    sessionTitle: this.sSessionTitle[0],
    status: this.sStatus[0],
    busyPending: this.sBusyPending[0],
    totalTokens: this.sTotalTokens[0],
    approval: this.sApproval[0],
    contextEnabled: this.sContextEnabled[0],
    noTools: this.sNoTools[0],
    mcpEnabled: this.sMcpEnabled[0],
    editorVersion: this.composer.editorVersion,
    draftImages: this.composer.draftImages,
    slashSelection: this.composer.slashSelection,
    contextUsed: this.sContextUsed[0],
    cacheRead: this.sCacheRead[0],
    compactions: this.sCompactions[0],
    pinned: this.sPinned[0],
    streamingSince: this.sStreamingSince[0],
    thinkingMode: this.sThinkingMode[0],
    toolDetails: this.sToolDetails[0],
    animations: this.sAnimations[0],
    cardStyle: this.sCardStyle[0],
    /** True while a compaction (manual `/compact` or automatic preflight)
     * runs — the sidebar/status bar show an in-progress indicator. */
    compacting: this.sCompacting[0],
  }

  /**
   * Subscribe to the transport-agnostic event stream (IF3; docs/agent.md
   * "Remote approval & event stream"). Fires for every mutation a renderer
   * would react to (messages, deltas, status, plans, approvals, sudo, errors).
   * Returns an unsubscribe function. A throwing listener is contained.
   */
  subscribe(listener: (e: ChatEvent) => void): () => void {
    this.chatListeners.add(listener)
    return () => {
      this.chatListeners.delete(listener)
    }
  }

  /** Fan a chat event out to every observer; a listener failure is dropped. */
  private emitChat(e: ChatEvent): void {
    if (this.chatListeners.size === 0) return
    for (const listener of [...this.chatListeners]) {
      try {
        listener(e)
      } catch {
        // An observer must never break the mutation it observes (rule 10).
      }
    }
  }

  /** Set + announce the session status (the single status mutation point). */
  private setStatus(status: ChatStatus): void {
    if (this.sStatus[0]() === status) return
    this.sStatus[1](status)
    this.emitChat({ kind: "status", status })
  }

  /** Reactive compaction flag, read live by the accessors/slashHost and the
   * UI progress indicator. */
  private get compacting(): boolean {
    return this.sCompacting[0]()
  }

  private set compacting(value: boolean) {
    this.sCompacting[1](value)
  }

  get editorState(): InputEditor {
    return this.composer.editor
  }

  /**
   * Absolute path of this tab's current transcript JSONL (M6 detach registry
   * mapping: windows reattach to their transcripts by path). Null when the
   * file handle is unavailable (should not happen).
   */
  get sessionFilePath(): string | null {
    try {
      return this.deps.file().filePath
    } catch {
      return null
    }
  }

  /**
   * Set the tab display title (docs/sessions.md "Auto titles"). The UI reads it
   * reactively through `accessors.sessionTitle`. Empty clears it so the tab
   * falls back to the shell basename. Never throws. Display-only.
   */
  setSessionTitle(title: string): void {
    const next = title.trim()
    this.sSessionTitle[1](next)
    // Emit so a remote host folds the change into `meta.sessionTitle` (the
    // auto title lands after the turn settles, when no other event fires).
    this.emitChat({ kind: "title", title: next })
  }

  /** The selected endpoint's name (session override → config default). */
  endpointName(): string {
    const own = parseSelectedModel(this.sModelOverride[0]() ?? "")
    if (own !== null) return own.endpoint
    return activeEndpointName(this.deps.getConfig())
  }

  /** Model id for the next request (session override → config default). */
  modelName(): string {
    const own = parseSelectedModel(this.sModelOverride[0]() ?? "")
    if (own !== null) return own.model
    return activeModelId(this.deps.getConfig())
  }

  /** The endpoint object backing the selected model. */
  endpoint() {
    const cfg = this.deps.getConfig()
    const name = this.endpointName()
    return cfg.endpoints[name] ?? activeEndpoint(cfg)
  }

  /** The selected model in `endpoint@model` form (status bar, pickers). */
  selectedModel(): string {
    return this.sModelOverride[0]() ?? this.deps.getConfig().model
  }

  /**
   * Session model pick (picker Enter / `/model <endpoint>@<id>`): applies to
   * THIS session immediately and persists as the config default for NEW
   * sessions — other tabs are untouched.
   */
  setModelSelection(endpoint: string, model: string): void {
    this.sModelOverride[1](selectedModelString(endpoint, model))
    this.metaCache = null
    if (!this.hasKey()) this.setStatus("disabled")
    else if (this.sStatus[0]() === "disabled") this.setStatus("idle")
  }

  // ---- agent ---------------------------------------------------------------

  /** The active agent definition (session override → config `agent` →
   * agents dir → compiled-in built-in of the same name → copilot). */
  agentDef(): AgentDef {
    const catalog = this.deps.getAgents?.()
    const name = this.sAgentOverride[0]() ?? this.deps.getConfig().defaultAgent
    return catalog?.byName[name] ?? builtInAgent(name) ?? fallbackAgent()
  }

  /** Agent name for chips/status (the def's name — never the raw config key). */
  agentName(): string {
    return this.agentDef().name
  }

  /** Session agent pick (picker Enter / `/agent <name>`): applies to THIS
   * session and persists as the config default for NEW sessions. */
  setAgentSelection(name: string): void {
    this.sAgentOverride[1](name)
  }

  /** Resolve `sudoPrompt` for the current request: `auto` (the merged
   * copilot) follows the approval mode — popup in full-auto, ask in confirm. */
  private effectiveSudoPrompt(): "ask" | "popup" {
    return resolveSudoPrompt(this.agentDef().sudoPrompt, this.sApproval[0]())
  }

  /**
   * Does this tool get the sudo popup/cache seam? `shell_background` follows
   * the resolved posture (`popup` in full-auto, `ask` in confirm).
   * `shell_session` runs in the user's VISIBLE terminal: the agent must never
   * type a bare `sudo`, leave a prompt waiting, and then retry around it, so a
   * non-`ask` agent (the built-in copilot is `auto`) gets the popup there in any
   * posture too. A password already cached in RAM is reused for either tool.
   */
  private sudoSeamFor(tool: string): boolean {
    if (this.deps.requestSudo === undefined) return false
    const cached = this.deps.hasSudoPassword?.() === true
    if (tool === "shell_background") return this.effectiveSudoPrompt() === "popup" || cached
    if (tool === "shell_session") return this.agentDef().sudoPrompt !== "ask" || cached
    return false
  }

  /**
   * Ask for a sudo password through the deps seam while surfacing the prompt on
   * the transport-agnostic event stream (IF3; docs/agent.md "Remote approval &
   * event stream"). A cached session password resolves without a prompt (the
   * host's vault wrapper), so no `sudo-request` is emitted then. The request id
   * is engine-generated and passed to the dep so a remote transport answers the
   * matching `sudo.request`; an abort (Esc/`chat.abort`) resolves the wait as
   * declined so the tool call can never hang on a prompt nobody can answer.
   */
  private async requestSudoWithEvents(
    command: string,
    hint: string | undefined,
    signal: AbortSignal,
  ): Promise<string | null> {
    const request = this.deps.requestSudo
    if (request === undefined) return null
    // A cached password is reused silently in any posture — no prompt event.
    if (this.deps.hasSudoPassword?.() === true) return request(command, hint)
    const requestId = `sudo-${Date.now().toString(36)}-${(++this.sudoCounter).toString(36)}`
    const prompt = hint !== undefined && hint.length > 0 ? hint : "sudo password required"
    this.emitChat({ kind: "sudo-request", requestId, command, prompt })
    let onAbort: (() => void) | null = null
    const aborted = new Promise<string | null>((resolve) => {
      if (signal.aborted) {
        resolve(null)
        return
      }
      onAbort = () => resolve(null)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    let password: string | null
    try {
      password = await Promise.race([request(command, hint, requestId), aborted])
    } catch {
      password = null
    } finally {
      if (onAbort !== null) signal.removeEventListener("abort", onAbort)
    }
    this.emitChat({ kind: "sudo-resolved", requestId, ok: password !== null && password.length > 0 })
    return password
  }

  // ---- thinking modes (docs/agent.md "Thinking modes") ---------------------

  /** Session thinking-mode override accessor (status bar chip). */
  get effortOverride(): string | null {
    return this.sEffortOverride[0]()
  }

  /** The effective thinking-mode string: /effort override → endpoint
   * thinkingMode → the model's HIGHEST advertised setting (metadata-driven;
   * "default" when the model advertises no knob, so nothing is sent). */
  effortSetting(): string {
    const o = this.sEffortOverride[0]()
    if (o !== null) return o
    const p = this.endpoint().thinkingMode
    if (p !== undefined && p.length > 0 && p !== "default") return p
    return defaultThinkingMode(this.modelMeta()) ?? "default"
  }

  /** /effort <mode>: set the session override (cycles pass the mode too).
   * Silent by design — the status-bar chip already reflects the mode. */
  setEffortOverride(mode: string): void {
    this.sEffortOverride[1](mode)
  }

  /** Cycle through the model's advertised thinking choices (status chip). */
  cycleEffort(): void {
    this.setEffortOverride(cycleThinkingMode(this.effortSetting(), this.modelMeta()))
  }

  /**
   * Memoized metadata for the CURRENT model: the endpoint's config override
   * (endpoints.<name>.models.<id>) wins per-field over the models.dev
   * enrichment (docs/config.md). The models.dev lookup is pinned to the
   * endpoint protocol's provider (`PROTOCOLS[kind].modelsDevProvider`) so an
   * ambiguous id resolves against the right provider's metadata. The memo
   * follows the selected model, the config identity (a /reload or Settings
   * save swaps the object), and the catalog generation (a models.dev
   * prefetch/picker enrichment bump) — so a pre-fetch 128k fallback gives way
   * to the fetched window without hitting the cache file on every render.
   */
  modelMeta(): ModelMeta | null {
    const cfg = this.deps.getConfig()
    const key = this.selectedModel()
    const version = this.deps.catalogVersion?.() ?? 0
    if (this.metaCache?.model !== key || this.metaCache.version !== version || this.metaCacheCfg !== cfg) {
      const model = this.modelName()
      const endpoint = this.endpoint()
      const override = endpoint.models[model] ?? null
      const kind = canonicalProvider(endpoint.provider)
      const pin = kind !== null && kind !== "mock" ? PROTOCOLS[kind].modelsDevProvider : null
      this.metaCache = {
        model: key,
        version,
        meta: mergeModelOverride(lookupModelMeta(model, { preferredProvider: pin }), override),
      }
      this.metaCacheCfg = cfg
    }
    return this.metaCache.meta
  }

  private metaCache: { model: string; version: number; meta: ModelMeta | null } | null = null
  private metaCacheCfg: SensusConfig | null = null

  /**
   * The output cap for the next request (docs/config.md "maxTokens"). An
   * explicit endpoint `maxTokens` wins; otherwise the model's advertised output
   * limit (models.dev `limit.output`); otherwise `undefined`, which OMITS the
   * field entirely so the endpoint uses its own default — a user is not
   * silently capped below what their model can emit.
   */
  outputTokensForRequest(): number | undefined {
    return resolveOutputTokens(this.endpoint().maxTokens, this.modelMeta()?.output)
  }

  /** The reasoning knob for the next request (null = omit). */
  private thinkingKnob() {
    return resolveThinkingKnob(this.effortSetting(), this.modelMeta())
  }

  /** temperature to send: endpoint value, or omitted when the resolved
   * metadata marks the model temperature-less (reasoning endpoints reject
   * the field). */
  private requestTemperature(endpoint: { temperature: number }): number | undefined {
    const supported = this.modelMeta()?.temperatureSupported
    if (supported === false) return undefined
    return endpoint.temperature
  }

  // ---- display state (thinking blocks, tool output, animations) -----------

  /**
   * Reasoning display for this session ("show" = expanded by default,
   * "hide" = collapsed one-liner, the default). /thinking and the
   * command menu flip it; per-block clicks override per message.
   */
  setThinkingMode(mode: "show" | "hide"): void {
    this.sThinkingMode[1](mode)
  }

  toggleThinkingMode(): "show" | "hide" {
    const next = this.sThinkingMode[0]() === "show" ? "hide" : "show"
    this.sThinkingMode[1](next)
    return next
  }

  /** Tool output display: "expanded" = full output, "collapsed" = preview. */
  setToolDetails(mode: "expanded" | "collapsed"): void {
    this.sToolDetails[1](mode)
  }

  toggleToolDetails(): "expanded" | "collapsed" {
    const next = this.sToolDetails[0]() === "expanded" ? "collapsed" : "expanded"
    this.sToolDetails[1](next)
    return next
  }

  /**
   * Animations on/off for this session: braille spinner frames, streamed-text
   * reveal pacing, message entrance effects, the streaming caret pulse and the
   * input caret blink (docs/config.md "chat" `animations`). Seeded from config
   * at construction; settings saves and `/reload` re-seed it via
   * `applyChatDisplayConfig`. `SENSUS_REDUCED_MOTION` still forces the input
   * caret solid independently (ui/lib/blink.ts).
   */
  setAnimations(enabled: boolean): void {
    this.sAnimations[1](enabled)
  }

  /** Message card style: "fill" = borderless themed panel, "border" = bordered. */
  setCardStyle(style: "fill" | "border"): void {
    this.sCardStyle[1](style)
  }

  toggleCardStyle(): "fill" | "border" {
    const next = this.sCardStyle[0]() === "fill" ? "border" : "fill"
    this.sCardStyle[1](next)
    return next
  }

  // ---- stream reveal (docs/agent.md "Streaming display") --------------------

  /**
   * Reveal cut for an assistant bubble's content: provider deltas arrive in
   * bursts and the paced reveal makes them unfurl like typing instead of
   * popping (ui/chat/streamReveal.ts). Returns how many chars are visible —
   * callers slice per display unit so mounted nodes keep updating until the
   * pour is caught up. Passthrough (full length) when animations are off;
   * the shared 80ms tick is read inside ONLY while a backlog exists, so
   * caught-up text never subscribes (ui/spinner.ts invariant). `settled` =
   * the bubble is no longer the live stream — its tail then drains on the
   * fast floor.
   */
  revealContentCut(id: number, content: string, settled: boolean): number {
    if (!this.sAnimations[0]()) return content.length
    return this.reveal.content(id, content, spinnerFrame, Date.now(), settled)
  }

  /** Same pacing for a VISIBLE reasoning body (collapsed blocks never ask). */
  revealThinkingCut(id: number, thinking: string, settled: boolean): number {
    if (!this.sAnimations[0]()) return thinking.length
    return this.reveal.thinking(id, thinking, spinnerFrame, Date.now(), settled)
  }

  /** Is the thinking block of `msgId` open? Default = the session mode. */
  thinkingOpen(msgId: number): boolean {
    const override = this.sThinkingOpen[0]().get(msgId)
    if (override !== undefined) return override
    return this.sThinkingMode[0]() === "show"
  }

  /** Click on a thinking header: flip that block (session default untouched). */
  toggleThinkingOpen(msgId: number): boolean {
    const map = new Map(this.sThinkingOpen[0]())
    map.set(msgId, !this.thinkingOpen(msgId))
    this.sThinkingOpen[1](map)
    return true
  }

  /** Is the output of tool card `callId` expanded? Default = session mode. */
  cardExpanded(callId: string): boolean {
    const override = this.sCardExpand[0]().get(callId)
    if (override !== undefined) return override
    return this.sToolDetails[0]() === "expanded"
  }

  /** Click on a card header / `e` key: flip that card's output expansion. */
  toggleCardExpand(callId: string): boolean {
    const map = new Map(this.sCardExpand[0]())
    map.set(callId, !this.cardExpanded(callId))
    this.sCardExpand[1](map)
    return true
  }

  /** `e` key: flip the most recent tool card. False when there is none (the
   * key then falls through to the editor — typing "e" still works). */
  toggleLastCardExpand(): boolean {
    const card = this.lastToolCard()
    if (card === null) return false
    return this.toggleCardExpand(card)
  }

  /** `t` key: flip the most recent thinking block. False when none exists. */
  toggleLastThinkingOpen(): boolean {
    const m = this.findLastMessage((m) => m.role === "assistant" && (m.thinking?.length ?? 0) > 0)
    return m !== null ? this.toggleThinkingOpen(m.id) : false
  }

  private lastToolCard(): string | null {
    return this.book.lastToolCardId()
  }

  /**
   * Approval mode switch shared by /yolo, the status-bar chip and Alt+Y —
   * the same note, surfaced as a toast.
   */
  setApproval(mode: ApprovalMode): void {
    if (this.sApproval[0]() === mode) return
    this.sApproval[1](mode)
    this.deps.toast(`approval → ${mode} (status bar reflects it)`)
  }

  hasKey(): boolean {
    const ep = this.endpoint()
    // The mock seam needs no credential; real endpoints read config's apiKey.
    if (ep.provider === "mock" || process.env["SENSUS_MOCK"] === "1") return true
    return ep.apiKey.length > 0
  }

  /**
   * Attach the active tab's live terminal facts (App does this once per tab).
   * Enables shell_session/get_scrollback, context injection and pane-cwd defaults.
   */
  attachTerminal(get: () => TerminalSnapshotForChat | null): void {
    this.terminal = get
  }

  // ---- history recall (per-tab, in-memory ring) ---------------------------

  historyOlder(): string | null {
    return this.composer.historyOlder()
  }

  historyNewer(): string | null {
    return this.composer.historyNewer()
  }

  isBrowsingHistory(): boolean {
    return this.composer.isBrowsingHistory()
  }

  noteTextEdited(): void {
    this.composer.noteTextEdited()
  }

  // ---- editor / scroll ------------------------------------------------------

  bumpEditor(): void {
    this.composer.bumpEditor()
  }

  setDraft(text: string): void {
    this.composer.setDraft(text)
  }

  getDraft(): string {
    return this.composer.getDraft()
  }

  clearDraft(): void {
    this.composer.clearDraft()
  }

  // ---- image attachments (docs/agent.md "Images") -------------------------

  /** Does the selected model accept image input? (models.dev / config override;
   * metadata absent = unknown, which does not enable the view_image tool.) */
  modelSupportsVision(): boolean {
    return this.composer.modelSupportsVision()
  }

  /**
   * Attach an image from raw bytes (clipboard paste): stored under the
   * session's assets dir so the transcript references stable bytes.
   */
  addDraftImage(bytes: Uint8Array, name: string, mediaTypeHint?: string): { ok: true } | { ok: false; error: string } {
    return this.composer.addDraftImage(bytes, name, mediaTypeHint)
  }

  /** Attach an image FILE (path resolves against the pane cwd). */
  addDraftImageFromPath(pathArg: string): { ok: true; name: string; bytes: number } | { ok: false; error: string } {
    return this.composer.addDraftImageFromPath(pathArg)
  }

  removeDraftImage(id: string): void {
    this.composer.removeDraftImage(id)
  }

  clearDraftImages(): void {
    this.composer.clearDraftImages()
  }

  // ---- slash autocomplete (M8) -----------------------------------------------

  /**
   * Current autocomplete state for the draft (null = menu closed): the cursor
   * must sit on the FIRST logical line and that line must be "/token" with no
   * space yet. Derived from the editor, so it can never go stale across tab
   * switches; an Esc dismissal resets on the next text edit.
   */
  slashMenu(): SlashMenuState | null {
    return this.composer.slashMenu()
  }

  /** Move the highlighted menu row (wraps); count = current match count. */
  slashSelect(delta: number, count: number): void {
    this.composer.slashSelect(delta, count)
  }

  /** Esc: dismiss the menu without touching the draft. */
  slashDismiss(): void {
    this.composer.slashDismiss()
  }

  /** Accept the highlighted completion (Tab / Enter on a partial token). */
  acceptSlashCompletion(): boolean {
    return this.composer.acceptSlashCompletion()
  }

  /** Click-to-accept a specific menu row (only while that row is offered). */
  acceptSlashNamed(name: string): boolean {
    return this.composer.acceptSlashNamed(name)
  }

  // ---- message list ---------------------------------------------------------

  pushMessage(m: Omit<ChatMessage, "id" | "ts">): ChatMessage {
    const msg: ChatMessage = { ...m, id: ++this.nextId, ts: Date.now() }
    this.sMessages[1]((list) => [...list, msg])
    this.emitChat({ kind: "message-added", message: msg })
    if (msg.plan !== undefined) this.emitChat({ kind: "plan", message: msg })
    return msg
  }

  patchMessage(id: number, patch: Partial<ChatMessage>): void {
    let updated: ChatMessage | undefined
    this.sMessages[1]((list) =>
      list.map((m) => {
        if (m.id !== id) return m
        updated = { ...m, ...patch }
        return updated
      }),
    )
    if (updated === undefined) return
    this.emitChat({ kind: "message-updated", message: updated })
    // A plan edit rides a normal message patch; surface it as its own event so
    // a client can react without diffing the message tree.
    if (patch.plan !== undefined) this.emitChat({ kind: "plan", message: updated })
  }

  /** Patch a tool card by call id (newest card wins on duplicate ids). */
  patchToolCard(callId: string, patch: Partial<ToolCardData>): number | null {
    const list = this.sMessages[0]()
    let msg: ChatMessage | undefined
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m?.tool?.callId === callId) {
        msg = m
        break
      }
    }
    const tool = msg?.tool
    if (!msg || !tool) return null
    this.patchMessage(msg.id, { tool: { ...tool, ...patch } })
    return msg.id
  }

  appendToMessage(id: number, text: string): void {
    this.sMessages[1]((list) => list.map((m) => (m.id === id ? { ...m, content: m.content + text } : m)))
    this.emitChat({ kind: "delta", messageId: id, field: "content", text })
  }

  /** Append one reasoning delta to an assistant bubble (display-only field). */
  private appendThinkingToMessage(id: number, text: string): void {
    this.sMessages[1]((list) =>
      list.map((m) => (m.id === id ? { ...m, thinking: (m.thinking ?? "") + text } : m)),
    )
    this.emitChat({ kind: "delta", messageId: id, field: "thinking", text })
  }

  addSystem(text: string): void {
    this.pushMessage({ role: "system", content: text, local: true })
  }

  addError(text: string): void {
    this.pushMessage({ role: "error", content: text, local: true })
    this.emitChat({ kind: "error", message: text })
    // Extensions v1 `error.raised` (docs/events.md): classify the common
    // provider/compaction failures, everything else stays `engine`.
    const source = text.startsWith("reply failed")
      ? "provider"
      : text.startsWith("compaction failed")
        ? "compaction"
        : "engine"
    this.emitErrorRaised(source, text)
  }

  /**
   * Replace the transcript (resume). `checkpoint` (from the last durable
   * compaction event) seeds the provider history so resumed sessions do not
   * re-inflate the messages the checkpoint already summarizes; only records
   * from `checkpointIndex` on are replayed verbatim.
   *
   * Tool turns replay too: the transcript's `tool_call` events (read lazily
   * from this session's file) carry the boundary-capped result + raw arguments,
   * so a resumed session keeps the investigation context the model actually
   * saw instead of dropping to plain text. Old transcripts without those
   * fields replay exactly as before.
   */
  restore(
    messages: readonly ChatMessage[],
    checkpoint: {
      checkpoint?: string | null
      checkpointIndex?: number
      /** Reconstructed durable-history rows from the saved transcript (tool
       *  calls included) — shown by the Context inspector. The provider history
       *  below ALSO replays persisted tool turns when their result was stored. */
      history?: readonly ContextHistoryEntry[]
    } = {},
  ): void {
    if (messages.length > 0) this.nextId = Math.max(...messages.map((m) => m.id))
    this.sMessages[1]([...messages])
    let tokens = 0
    for (const m of messages) tokens += m.usage?.totalTokens ?? 0
    this.sTotalTokens[1](tokens)
    // Rebuild the provider history from the visible transcript. Tool turns
    // whose persisted event carried a result are replayed as assistant
    // tool_calls + tool results (docs/agent.md "Session search"/resume).
    this.providerHistory.length = 0
    this.providerHistoryMarks.clear()
    this.pendingSteers.length = 0
    this.pendingQueue.length = 0
    this.publishBusyPending()
    this.generationRewound = false
    const cp = checkpoint.checkpoint ?? null
    if (cp !== null && cp.length > 0) this.providerHistory.push({ role: "user", content: cp })
    const start = cp !== null ? Math.max(0, checkpoint.checkpointIndex ?? 0) : 0
    const replayCalls = this.loadReplayableToolCalls()
    for (let i = start; i < messages.length; i++) {
      const m = messages[i]
      if (m === undefined) continue
      const calls = replayCalls.get(i) ?? []
      if (m.role === "user" && (m.content.length > 0 || (m.images?.length ?? 0) > 0)) {
        this.providerHistory.push({ role: "user", content: m.content, ...(m.images !== undefined && m.images.length > 0 ? { images: m.images } : {}) })
      } else if (m.role === "assistant" && (m.content.length > 0 || calls.length > 0)) {
        this.providerHistory.push({
          role: "assistant",
          content: m.content,
          ...(calls.length > 0 ? { toolCalls: calls.map(toReplayedToolCall) } : {}),
        })
      }
      // A dropped pre-tool assistant bubble: the calls attached to a
      // non-assistant record still need an assistant message carrying the
      // tool_calls (a dangling tool result is rejected by providers).
      if (m.role !== "assistant" && calls.length > 0) {
        this.providerHistory.push({ role: "assistant", content: "", toolCalls: calls.map(toReplayedToolCall) })
      }
      for (const c of calls) {
        this.providerHistory.push({ role: "tool", toolCallId: c.callId ?? "", toolName: c.name, content: c.result ?? "" })
      }
    }
    this.usageAnchor = null
    // Context-inspector display reconstruction (tool calls included); the
    // provider history above stays plain text. `restoredMark` pins where live
    // appended messages begin.
    this.restoredHistory = checkpoint.history !== undefined ? [...checkpoint.history] : null
    this.restoredMark = this.providerHistory.length
    // Seed the status bar's last-response figures from the transcript (display
    // only — the usage anchor above stays null, so compaction still estimates
    // the smaller text-only live request).
    const lastUsage = [...messages].reverse().find((m) => m.usage != null)?.usage ?? null
    this.sContextUsed[1](lastUsage?.promptTokens ?? 0)
    this.lastTailFingerprint = null
    this.sCacheRead[1](
      lastUsage != null && lastUsage.cachedTokens != null && lastUsage.cachedTokens > 0
        ? { cached: lastUsage.cachedTokens, prompt: lastUsage.promptTokens }
        : null,
    )
    this.sThinkingOpen[1](new Map())
    this.sCardExpand[1](new Map())
    this.reveal.reset()
    this.emitChat({ kind: "reset", messages: [...messages] })
  }

  /**
   * Read this session's transcript and group persisted tool calls that carry a
   * replayed result by the chat-record index they followed. Lazy: only the
   * resume path calls it, and a missing/legacy file simply yields an empty map.
   */
  private loadReplayableToolCalls(): Map<number, LoadedToolCall[]> {
    const map = new Map<number, LoadedToolCall[]>()
    const path = this.sessionFilePath
    if (path === null) return map
    let loaded: ReturnType<typeof loadSessionFile>
    try {
      loaded = loadSessionFile(path)
    } catch {
      return map
    }
    for (const c of loaded.toolCalls) {
      if (c.callId === undefined || c.result === undefined) continue
      const list = map.get(c.afterMessage)
      if (list !== undefined) list.push(c)
      else map.set(c.afterMessage, [c])
    }
    return map
  }

  clearAll(): void {
    this.sMessages[1]([])
    this.composer.setDraftImages([])
    this.sSessionTitle[1]("")
    this.sTotalTokens[1](0)
    this.providerHistory.length = 0
    this.providerHistoryMarks.clear()
    this.restoredHistory = null
    this.restoredMark = 0
    this.pendingSteers.length = 0
    this.pendingQueue.length = 0
    this.publishBusyPending()
    this.generationRewound = false
    this.book.clearTrust()
    this.attachedInstructionFiles.clear()
    this.book.clearWaits()
    // /clear discards the transcript, so this session's background jobs must
    // not stay alive as stale entries (scoped: other tabs' jobs are untouched).
    clearJobs(this.jobScope)
    this.reportedJobCount = 0
    this.usageAnchor = null
    this.lastTailFingerprint = null
    this.compacting = false
    this.sContextUsed[1](0)
    this.sCacheRead[1](null)
    this.sCompactions[1](0)
    this.sThinkingOpen[1](new Map())
    this.sCardExpand[1](new Map())
    this.reveal.reset()
    this.emitChat({ kind: "reset", messages: [] })
  }

  // ---- rewind (docs/ui.md "Rewind") -----------------------------------------

  /**
   * Is the session mid-work? True while a reply streams, a compaction runs, or
   * a tool call is waiting on an approval / ask_user answer. The UI gates a
   * rewind behind a confirmation on this (a rewind aborts the work).
   */
  isWorking(): boolean {
    return (
      this.sStatus[0]() === "streaming" ||
      this.compacting ||
      this.book.pendingWaits() > 0
    )
  }

  /**
   * Rewind the conversation to just BEFORE the user message `id`: drop that
   * message and everything after it from the transcript, the durable provider
   * history and (logically) the session file, then reload the message's text
   * and attachments into the editor to edit + resend. Aborts any in-flight
   * generation first and suppresses its late writes. Returns false when `id` is
   * not a live user message. Never throws.
   */
  revertToUserMessage(id: number): boolean {
    const list = this.sMessages[0]()
    const idx = list.findIndex((m) => m.id === id && m.role === "user")
    const target = idx >= 0 ? list[idx] : undefined
    if (target === undefined) return false
    // Stop the in-flight work; the generationRewound flag keeps its late writes
    // (stray bubbles / provider messages / JSONL records) out of the rewind.
    this.generationRewound = true
    this.abort("rewind")
    // A rewind discards the turn: any steer/queue accepted for it is dropped.
    this.pendingSteers.length = 0
    this.pendingQueue.length = 0
    this.publishBusyPending()
    const kept = list.slice(0, idx)
    this.sMessages[1](kept)
    // Durable provider history: truncate exactly when the mark is still valid
    // (preserves tool calls/results in the retained prefix); otherwise rebuild
    // from the surviving transcript (compaction invalidates the indexes).
    const mark = this.providerHistoryMarks.get(id)
    if (mark !== undefined && mark <= this.providerHistory.length) {
      this.providerHistory.length = mark
      for (const [mid, m] of this.providerHistoryMarks) {
        if (m >= this.providerHistory.length) this.providerHistoryMarks.delete(mid)
      }
    } else {
      this.rebuildProviderHistoryFrom(kept)
      this.providerHistoryMarks.clear()
    }
    // Stale per-generation state.
    this.usageAnchor = null
    this.lastTailFingerprint = null
    this.pendingToolImages.clear()
    this.doomLoopSignature = null
    this.doomLoopCount = 0
    // A rewind rewrites the durable history; the resumed-display reconstruction
    // (providerHistory indexes) is no longer valid.
    this.restoredHistory = null
    this.restoredMark = 0
    this.book.clearWaits()
    // Reload the message for editing + resend.
    this.setDraft(target.content)
    try {
      this.composer.setDraftImages(target.images !== undefined && target.images.length > 0 ? [...target.images] : [])
    } catch {
      this.composer.setDraftImages([])
    }
    this.reveal.reset()
    // Persist the rewind (append-only marker; loadSessionFile truncates the
    // logical transcript to `keep` user+assistant records).
    const keep = kept.filter((m) => m.role === "user" || m.role === "assistant").length
    try {
      this.deps.file().append({ ts: Date.now(), type: "revert", keep })
    } catch {
      // persistence is best-effort: never fail the rewind
    }
    this.deps.toast("rewound — edit your message and Enter to resend", "success", 3500)
    return true
  }

  /** Rebuild the durable provider history (plain user/assistant turns) from a
   * transcript — used by a rewind when the precise history marks are invalid. */
  private rebuildProviderHistoryFrom(messages: readonly ChatMessage[]): void {
    this.providerHistory.length = 0
    for (const m of messages) {
      if (m.role === "user" && (m.content.length > 0 || (m.images?.length ?? 0) > 0)) {
        this.providerHistory.push({
          role: "user",
          content: m.content,
          ...(m.images !== undefined && m.images.length > 0 ? { images: m.images } : {}),
        })
      } else if (m.role === "assistant" && m.content.length > 0) {
        this.providerHistory.push({ role: "assistant", content: m.content })
      }
    }
  }

  // ---- approval / ask_user resolution ---------------------------------------

  /** Backwards message scan (cards/labels resolve against the LATEST match,
   * so every lookup here walks newest-first). Null when nothing matches. */
  private findLastMessage(pred: (m: ChatMessage) => boolean): ChatMessage | null {
    const list = this.sMessages[0]()
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m && pred(m)) return m
    }
    return null
  }

  /** The latest pending approval card, if any (y/n/a keys + card clicks). */
  pendingApproval(): ToolCardData | null {
    return this.book.pendingApproval()
  }

  /** The latest pending ask_user card, if any. */
  pendingAsk(): ToolCardData | null {
    return this.book.pendingAsk()
  }

  /**
   * Resolve a pending approval card. "allow" records the card's operation-class
   * pattern as session trust (never persisted). Returns false when no card with
   * that id is pending.
   */
  resolveCard(callId: string, action: "accept" | "reject" | "allow"): boolean {
    return this.book.resolveCard(callId, action)
  }

  /** Answer a pending ask_user card (Enter with a draft, or an option pick). */
  answerAsk(callId: string, answer: string): boolean {
    return this.book.answerAsk(callId, answer)
  }

  // ---- approval-batch plan (docs/agent.md "Approval-batch plan card") --------

  /** The newest unresolved approval plan, if any (chatKeys + card clicks). */
  pendingPlan(): PlanCardData | null {
    return this.pendingPlanMessage()?.plan ?? null
  }

  private pendingPlanMessage(): ChatMessage | null {
    return this.findLastMessage((m) => m.plan !== undefined && m.plan.resolved !== true)
  }

  private patchPlan(msg: ChatMessage, plan: PlanCardData): void {
    this.patchMessage(msg.id, { plan })
  }

  /** Move the plan cursor by `delta` (clamped). */
  planMove(delta: number): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const cursor = Math.max(0, Math.min(plan.lines.length - 1, plan.cursor + delta))
    if (cursor !== plan.cursor) this.patchPlan(msg, { ...plan, cursor })
  }

  /** Toggle the highlighted line (approved ⇄ rejected). */
  planToggle(): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const line = plan.lines[plan.cursor]
    if (!line) return
    this.planSetLine(msg, plan.cursor, line.status === "approved" ? "rejected" : "approved")
  }

  /** Toggle one line by call id (a mouse click on that line row). */
  planToggleLine(callId: string): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const idx = plan.lines.findIndex((l) => l.callId === callId)
    if (idx === -1) return
    const line = plan.lines[idx]
    this.patchPlan(msg, { ...plan, cursor: idx, lines: plan.lines.map((l, i) => (i === idx ? { ...l, status: line!.status === "approved" ? "rejected" : "approved" } : l)) })
  }

  private planSetLine(msg: ChatMessage, idx: number, status: PlanLineStatus): void {
    const plan = msg.plan
    if (!plan) return
    this.patchPlan(msg, { ...plan, lines: plan.lines.map((l, i) => (i === idx ? { ...l, status } : l)) })
  }

  /** Set the highlighted line's status (y/n keys). */
  planSetHighlighted(status: PlanLineStatus): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    this.planSetLine(msg, plan.cursor, status)
  }

  /**
   * Approve every NON-destructive line and COMMIT the plan in one step
   * (docs/agent.md "Approval-batch plan card"): the "approve the task" intent,
   * so A runs the batch without a separate confirm. A destructive line is never
   * covered by approve-all — it keeps its explicit decision (still pending
   * until the user approves it per line) — and `planCommit` rejects any
   * still-pending destructive line (with its warn toast), so approve-all can
   * never wave an irreversible command through.
   */
  planApproveAll(): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    this.patchPlan(msg, {
      ...plan,
      lines: plan.lines.map((l) => (l.destructive === true ? l : { ...l, status: "approved" })),
    })
    this.planCommit()
  }

  /** Reject every line. */
  planDenyAll(): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    this.patchPlan(msg, { ...plan, lines: plan.lines.map((l) => ({ ...l, status: "rejected" })) })
  }

  /**
   * Trust the clicked line's operation class for this session and approve it
   * (the plan-level "a"; only offered when the line has a trustable class).
   */
  planTrustLine(callId: string): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const idx = plan.lines.findIndex((l) => l.callId === callId)
    const line = idx >= 0 ? plan.lines[idx] : undefined
    if (!line || line.destructive === true || !line.allowPrefix) return
    this.book.grantTrust(line.name, line.allowPrefix)
    this.planSetLine(msg, idx, "approved")
  }

  /**
   * Commit the plan: every line resolves to its current decision; a still-
   * `pending` line (a destructive line the user never explicitly approved) is
   * rejected. Resolves the batch wait so execution can proceed in order.
   */
  planCommit(): boolean {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return false
    const decisions = new Map<string, "accept" | "reject">()
    let rejectedDestructive = 0
    for (const l of plan.lines) {
      const accept = l.status === "approved"
      decisions.set(l.callId, accept ? "accept" : "reject")
      if (!accept && l.destructive === true) rejectedDestructive++
    }
    if (rejectedDestructive > 0) {
      this.deps.toast(
        `${rejectedDestructive} destructive line${rejectedDestructive === 1 ? "" : "s"} rejected — approve explicitly to run`,
        "warn",
        5000,
      )
    }
    return this.book.resolvePlan(String(msg.id), { decisions })
  }

  /**
   * Resolve a pending approval plan from a transport (P4c-iii): apply the
   * caller's per-call decisions and unblock the batch. `planCommit` uses the
   * local card's on-screen statuses; this takes the decisions directly so a
   * remote client owns its own highlight/toggle state.
   */
  answerPlan(planId: string, decisions: ReadonlyMap<string, "accept" | "reject">): boolean {
    if (decisions.size === 0) return false
    try {
      return this.book.resolvePlan(planId, { decisions: new Map(decisions) })
    } catch {
      return false
    }
  }

  /**
   * Deny every pending plan line without executing any of them — the daemon's
   * no-client path (docs/daemon-api.md "Lifecycle", D10). Distinct from
   * `planCommit` (which accepts the lines a UI already approved) and from
   * `planCancel` (which aborts the whole turn).
   */
  denyPlan(): boolean {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return false
    const decisions = new Map<string, "accept" | "reject">()
    for (const l of plan.lines) decisions.set(l.callId, "reject")
    return this.book.resolvePlan(String(msg.id), { decisions })
  }

  /** Cancel the plan (mouse "cancel") — aborts the turn like Esc. */
  planCancel(): boolean {
    if (this.pendingPlanMessage() === null) return false
    this.abort("plan-cancel")
    return true
  }

  /**
   * Session trust patterns ("approve and don't ask again this session") — the
   * status-bar chip reads this to name what is currently trusted. Session-only:
   * the list dies with the process (no persistence to clean up).
   */
  trustPatterns(): readonly TrustPattern[] {
    return this.book.trustPatterns()
  }

  /** Revoke one trusted pattern (the chip's click). False when it was absent. */
  revokeTrust(tool: string, prefix: string): boolean {
    return this.book.revokeTrust(tool, prefix)
  }

  /** Revoke every trusted pattern; returns how many were cleared. */
  revokeAllTrust(): number {
    return this.book.revokeAllTrust()
  }

  /**
   * Grant a session trust pattern from a transport (the plan-line trust
   * affordance, P4c-iii). Idempotent; false when the class is empty.
   */
  grantTrust(tool: string, prefix: string): boolean {
    try {
      return this.book.grantTrust(tool, prefix)
    } catch {
      return false
    }
  }

  /** Live background jobs started by THIS session (status-bar jobs chip). */
  activeJobCount(): number {
    return activeJobs(this.jobScope).length
  }

  // ---- commands / sending ------------------------------------------------------

  /** Route an input line. "sent" = dispatched now, "steered"/"queued" = accepted
   * while busy (docs/config.md "chat" `busySend`), "empty" = nothing to do,
   * "busy" = a slash command/compaction cannot proceed. `opts.alternate` picks
   * the OTHER busy-send mode (Alt+Enter while streaming, docs/keybindings.md). */
  handleInput(raw: string, opts: { alternate?: boolean } = {}): "sent" | "empty" | "busy" | "steered" | "queued" {
    const text = raw.trim()
    const draftImages = this.composer.draftImages()
    if (text === "" && draftImages.length === 0) return "empty"
    if (this.compacting) {
      this.deps.toast("compaction in progress — wait a moment", "warn", 3000)
      return "busy"
    }
    const slash = parseSlash(text)
    // Busy routing needs a LIVE generation loop, not merely the streaming
    // status: `finishStreamingWhenCaught` holds "streaming" while the settled
    // reply's reveal pours, after the loop's controller is already null. A
    // steer accepted in that window has no running turn to inject into — it
    // would sit in `pendingSteers` until some later send, so the user sees no
    // answer. Treat the trailing reveal as idle and dispatch a fresh
    // generation instead (docs/config.md `chat.busySend`; docs/agent.md
    // "Streaming display").
    if (this.sStatus[0]() === "streaming" && this.controller !== null) {
      // A slash command is a local action, not conversational input — never
      // steer/queue it; the reply must settle first.
      if (slash !== null) {
        this.deps.toast("reply still streaming — Esc aborts, or wait for it to finish", "warn", 3500)
        return "busy"
      }
      if (this.draftImagesBlocked(draftImages)) return "empty"
      const configured = this.busySendMode()
      const mode = opts.alternate === true ? (configured === "steer" ? "queue" : "steer") : configured
      if (mode === "steer") {
        this.enqueueSteer(text, draftImages)
        if (draftImages.length > 0) this.clearDraftImages()
        return "steered"
      }
      this.enqueueQueue(text, draftImages)
      if (draftImages.length > 0) this.clearDraftImages()
      return "queued"
    }
    if (slash !== null) {
      this.deps.file().append({ ts: Date.now(), type: "slash_command", command: slash.raw })
      this.handleSlash(slash)
      return "sent"
    }
    // Image preflight: a model that explicitly cannot take images must not get
    // a doomed request. Unknown metadata (null) is allowed through — the user
    // may know better than models.dev.
    if (this.draftImagesBlocked(draftImages)) return "empty"
    this.dispatchGeneration(text, draftImages)
    // The images now belong to the sent message; clear the draft's copies.
    if (draftImages.length > 0) this.clearDraftImages()
    return "sent"
  }

  /** Image preflight shared by the immediate and busy send paths: true (with a
   * toast) when the selected model explicitly cannot take images. */
  private draftImagesBlocked(images: readonly ImageAttachment[]): boolean {
    if (images.length === 0) return false
    if (this.modelMeta()?.vision !== false) return false
    this.deps.toast(
      `${this.selectedModel()} does not accept image input — switch model (/model) or remove the attachment`,
      "error",
      5000,
    )
    return true
  }

  /** The configured busy-send mode (docs/config.md `chat.busySend`), read live
   * so a settings change applies without a restart. */
  busySendMode(): "steer" | "queue" {
    return this.deps.getConfig().chat.busySend
  }

  /** Is a generation loop actually LIVE? Gates Alt+Enter's alternate busy-send
   * mode in the chat key machine (docs/keybindings.md "Chat focus"). Distinct
   * from the streaming STATUS: `finishStreamingWhenCaught` holds "streaming"
   * while the settled reply's reveal drains, but by then the loop's controller
   * is null and there is no turn left to steer. */
  isBusy(): boolean {
    return this.sStatus[0]() === "streaming" && this.controller !== null
  }

  /** Accept a message to inject into the RUNNING turn at its next safe boundary
   * (docs/config.md `chat.busySend` "steer"). */
  private enqueueSteer(text: string, images: readonly ImageAttachment[]): void {
    this.pendingSteers.push({ text, images: images.length > 0 ? [...images] : [] })
    this.pushHistory(text)
    this.publishBusyPending()
    this.deps.toast("steering into the running turn", "info", 3000)
  }

  /** Accept a message to send as the next turn once the current one settles
   * (docs/config.md `chat.busySend` "queue"). */
  private enqueueQueue(text: string, images: readonly ImageAttachment[]): void {
    this.pendingQueue.push({ text, images: images.length > 0 ? [...images] : [] })
    this.publishBusyPending()
    const n = this.pendingQueue.length
    this.deps.toast(n === 1 ? "queued for after this reply" : `queued (${n} waiting)`, "info", 3000)
  }

  private publishBusyPending(): void {
    this.sBusyPending[1]({ steer: this.pendingSteers.length, queue: this.pendingQueue.length })
  }

  /**
   * Inject every pending steer as a durable user turn at the loop's next safe
   * boundary (before the request is assembled): display bubble + JSONL +
   * provider history, in arrival order, so the running turn sees them and the
   * transcript stays 1:1 with the file. Called from inside `sendMessage`; a
   * generation that ends abnormally hands any undrained steer to
   * `flushSteers()` so it is still answered (docs/agent.md "Prompt caching" —
   * appended, never rewritten).
   */
  private drainSteers(): void {
    if (this.pendingSteers.length === 0) return
    const batch = this.pendingSteers.splice(0, this.pendingSteers.length)
    this.publishBusyPending()
    for (const s of batch) {
      const images = s.images.length > 0 ? [...s.images] : undefined
      const msg = this.pushMessage({ role: "user", content: s.text, ...(images !== undefined ? { images } : {}) })
      try {
        this.deps.file().append({ ts: msg.ts, type: "user_message", content: s.text, ...(images !== undefined ? { images } : {}) })
      } catch {
        // persistence is best-effort: never fail the send
      }
      this.providerHistoryMarks.set(msg.id, this.providerHistory.length)
      this.providerHistory.push({ role: "user", content: s.text, ...(images !== undefined ? { images } : {}) })
    }
  }

  /** Send the next queued message as a fresh generation after the current one
   * settled NORMALLY (an Esc abort keeps the queue — the user chose to stop).
   * No-op when empty or rewound. */
  private flushQueue(): void {
    if (this.generationRewound || this.pendingQueue.length === 0) return
    const next = this.pendingQueue.shift()
    if (next === undefined) return
    this.publishBusyPending()
    this.dispatchGeneration(next.text, next.images)
  }

  /**
   * A steer only reaches the model through a LIVE turn. When a generation ends
   * for a reason other than a plain stop — an Esc abort, a provider error, the
   * loop cap — a steer accepted during it may never have been drained, so the
   * model never saw it. Re-dispatch the oldest as a fresh generation so the
   * agent actually answers instead of leaving a dead user bubble; the rest stay
   * held and are drained at that generation's first boundary, in arrival order
   * (docs/agent.md "Busy sends (steer / queue)"). No-op when empty or rewound;
   * a plain stop already drained its steers in the loop.
   */
  private flushSteers(): void {
    if (this.generationRewound || this.pendingSteers.length === 0) return
    const first = this.pendingSteers.shift()
    if (first === undefined) return
    this.publishBusyPending()
    this.dispatchGeneration(first.text, first.images)
  }

  private handleSlash(cmd: SlashCommand): void {
    dispatchSlash(cmd, this.slashHost())
  }

  /**
   * The SlashHost surface the extracted dispatcher drives: bound signal
   * accessors plus this session's existing methods. Built per dispatch (slash
   * commands are rare), so every read stays live and no method loses `this`.
   */
  private slashHost(): SlashHost {
    return {
      addSystem: (text) => this.addSystem(text),
      messages: () => this.sMessages[0](),
      deps: this.deps,
      selectedModel: () => this.selectedModel(),
      modelName: () => this.modelName(),
      endpointName: () => this.endpointName(),
      setModelSelection: (endpoint, model) => this.setModelSelection(endpoint, model),
      agentName: () => this.agentName(),
      setAgentSelection: (name) => this.setAgentSelection(name),
      modelMeta: () => this.modelMeta(),
      effortSetting: () => this.effortSetting(),
      setEffortOverride: (mode) => this.setEffortOverride(mode),
      thinkingKnob: () => this.thinkingKnob(),
      status: () => this.sStatus[0](),
      approval: () => this.sApproval[0](),
      setApproval: (mode) => this.setApproval(mode),
      thinkingMode: () => this.sThinkingMode[0](),
      toggleThinkingMode: () => this.toggleThinkingMode(),
      setThinkingMode: (mode) => this.setThinkingMode(mode),
      toolDetails: () => this.sToolDetails[0](),
      toggleToolDetails: () => this.toggleToolDetails(),
      setToolDetails: (mode) => this.setToolDetails(mode),
      animations: () => this.sAnimations[0](),
      cardStyle: () => this.sCardStyle[0](),
      toggleCardStyle: () => this.toggleCardStyle(),
      setCardStyle: (style) => this.setCardStyle(style),
      compactions: () => this.sCompactions[0](),
      totalTokens: () => this.sTotalTokens[0](),
      isCompacting: () => this.compacting,
      clearAll: () => this.clearAll(),
      runManualCompaction: () => this.runManualCompaction(),
      mcpEnabled: () => this.sMcpEnabled[0](),
      setMcpEnabled: (on) => this.setMcpEnabled(on),
      mcpStatusSummary: () => this.mcpStatusSummary(),
      mcpSpecsForRequest: () => this.mcpSpecsForRequest(),
      noTools: () => this.noTools,
      contextEnabled: () => this.sContextEnabled[0](),
      setContextEnabled: (on) => this.sContextEnabled[1](on),
      contextUsed: () => this.sContextUsed[0](),
      contextLimit: () => this.contextLimit(),
      cacheRead: () => this.sCacheRead[0](),
      providerHistoryLength: () => this.providerHistory.length,
      draftImages: () => this.composer.draftImages(),
      clearDraftImages: () => this.clearDraftImages(),
      addDraftImageFromPath: (pathArg) => this.addDraftImageFromPath(pathArg),
      setEditorText: (text) => this.composer.editor.setText(text),
      sendMessage: (text) => this.sendMessage(text),
      pinned: () => this.sPinned[0](),
      setPinned: (value) => this.sPinned[1](value),
      skillCatalogForAgent: () => this.skillCatalogForAgent(),
    }
  }

  /**
   * Abort the in-flight generation. `reason` names WHY (docs/logging.md): the
   * settle path stamps it on the `turn completed` record and the
   * `turn-complete` seam event. Defaults to `"user"` (Esc / `chat.abort`); the
   * daemon threads `"shell-exit"`, `"approval-timeout"`, `"prompt-orphaned"`
   * and `"shutdown"`, and the engine uses `"rewind"` / `"plan-cancel"`.
   */
  abort(reason = "user"): void {
    if (this.controller) {
      this.abortReason = reason
      this.controller.abort() // fetches stop AND a running hidden command dies
      this.deps.toast("aborting…")
    }
    // Pending approval / ask_user waits resolve as aborted so the loop winds
    // down even when the provider already returned (mid-tool Esc).
    this.book.abortWaits()
  }

  // ---- the M3 generation (tool loop) ----------------------------------------

  private markNoTools(): void {
    if (this.noTools) return // fires per request — degrade once
    this.noTools = true
    this.sNoTools[1](true)
    this.deps.toast("provider reports no tool support — plain chat mode (click a code line to paste, double-click to run)", "warn", 4500)
  }

  // ---- MCP (M11, docs/mcp.md) -------------------------------------------------

  /**
   * MCP tool specs for the next request: connected servers' tools, [] when
   * the session toggle is off, tools are unavailable, or no registry wired.
   * NEVER throws (registry reads must not kill a send).
   */
  private mcpSpecsForRequest(): ToolSpec[] {
    if (this.noTools || !this.sMcpEnabled[0]()) return []
    try {
      const specs = this.deps.mcp?.currentSpecs() ?? []
      // The agent's `tools` list applies to MCP tools too when declared.
      const allowed = this.agentDef().tools
      if (allowed === null) return specs
      const set = new Set(allowed)
      return specs.filter((s) => set.has(s.function.name))
    } catch {
      return []
    }
  }

  /** The MCP specs' local token estimate (compaction preflight input). */
  private mcpSpecTokens(): number {
    const specs = this.mcpSpecsForRequest()
    return specs.length === 0 ? 0 : estTokens(JSON.stringify(specs))
  }

  /**
   * The AGENT's subset of the core tool specs (docs/agents.md frontmatter
   * `tools`): a declared list filters; absent/`["*"]` passes everything.
   * MCP tools are filtered by the same list when one is declared (an agent
   * that opted out of shell tools should not get external side effects
   * either); with no list MCP specs ride unfiltered.
   */
  private toolSpecsForRequest(core: readonly ToolSpec[]): ToolSpec[] {
    const cfg = this.deps.getConfig()
    const memoryOff = !cfg.memory.enabled
    const tools = this.agentDef().tools
    const allowed = tools === null ? null : new Set(tools)
    const readonly = this.agentDef().readonly === true
    return core.filter((s) => {
      const n = s.function.name
      // A read-only agent is never offered a mutating tool, whatever its
      // `tools` list says (the guard in gateDecision is the enforcement; this
      // keeps the model from being tempted). docs/agents.md `readonly`.
      if (readonly && READONLY_DENIED_TOOLS.has(n)) return false
      // A disabled memory drops its tools so the model is never told about
      // capabilities it cannot use (Hermes behavior, docs/memory.md).
      if (memoryOff && (n === "memory" || n === "host_scan")) return false
      // view_image only when the selected model accepts image input — a
      // text-only model cannot use it and the spec just costs tokens.
      if (n === "view_image" && this.modelMeta()?.vision !== true) return false
      return allowed === null || allowed.has(n)
    })
  }

  /** /mcp off|on: session-level toggle (config unchanged; toast-only). */
  setMcpEnabled(on: boolean): void {
    this.sMcpEnabled[1](on)
    const n = this.deps.mcp ? this.mcpSpecsForRequest().length : 0
    this.deps.toast(
      on ? `mcp tools on (${n} available)` : "mcp tools off for this session (/mcp on re-enables)",
      "info",
      3500,
    )
  }

  /** One-line MCP summary for /status (docs/mcp.md). Counts ENABLED servers
   *  (a config-disabled entry is not a "not connected" server). */
  private mcpStatusSummary(): string {
    if (!this.sMcpEnabled[0]()) return "off (/mcp on)"
    const registry = this.deps.mcp
    if (!registry) return "none"
    try {
      const facts = registry.serverStatuses()
      const enabled = facts.filter((f) => f.status !== "disabled")
      const total = enabled.length
      if (total === 0) return facts.length > 0 ? "all servers disabled (/mcp)" : "no servers configured"
      const connected = enabled.filter((f) => f.status === "connected").length
      if (connected === total) return `${connected} server(s) connected`
      return `${connected}/${total} server(s) connected`
    } catch {
      return "unknown"
    }
  }

  /**
   * Reactive per-server MCP facts for the status-bar chip (docs/mcp.md "UI").
   * Reading `statusVersion()` inside the tracked build keeps the chip live
   * across connect/fail/`markDown`/`/reload`; it never throws — a registry
   * error degrades the chip to hidden rather than taking the TUI down.
   */
  mcpStatusFacts(): McpServerStatusFact[] {
    const reg = this.deps.mcp
    if (!reg) return []
    try {
      reg.statusVersion()
      return reg.serverStatuses()
    } catch {
      return []
    }
  }

  private terminalSnapshot(): TerminalSnapshotForChat | null {
    try {
      return this.terminal?.() ?? null
    } catch {
      return null
    }
  }

  private paneCwd(): string | null {
    return this.terminalSnapshot()?.cwd ?? null
  }

  /**
   * The skills the ACTIVE AGENT may see (docs/skills.md, frontmatter `skills`):
   * a declared list filters the catalog; absent/`["*"]` passes everything.
   * Both the prompt index and the skills tools use this view.
   */
  private skillCatalogForAgent(): SkillsCatalog | undefined {
    const catalog = this.deps.getSkills?.()
    if (catalog === undefined) return undefined
    return filterSkillsForAgent(catalog, this.agentDef().skills)
  }

  private buildSystemPrompt(): string {
    const cfg = this.deps.getConfig()
    let mcp: Array<{ name: string; tools: string[] }> = []
    try {
      mcp = this.sMcpEnabled[0]() ? (this.deps.mcp?.connectedServerFacts() ?? []) : []
    } catch {
      mcp = []
    }
    return buildSystemPrompt({
      os: `${os.type()} ${os.release()} (${process.platform})`,
      hostname: os.hostname(),
      shell: cfg.shell,
      agent: this.agentDef(),
      model: this.selectedModel(),
      terminal: "embedded PTY (xterm-256color)",
      noTools: this.noTools,
      mcp,
      skills: this.skillCatalogForAgent(),
      customInstructions: this.deps.getInstructions?.() ?? null,
      memory: cfg.memory.enabled ? this.memorySnapshot : null,
    })
  }

  /**
   * Compact context block for the newest user message (docs/agent.md). The
   * block lands ONCE per generation as a DURABLE provider-history message —
   * never re-derived or rewritten on later requests — so the provider's
   * prefix cache stays valid across generations (docs/agent.md "Prompt
   * caching"). When the (trimmed) tail is unchanged since the last block it
   * collapses to an "unchanged" note instead of repeating ~100 lines.
   */
  private async buildContextBlockForMessage(signal: AbortSignal): Promise<string | null> {
    const cfg = this.deps.getConfig()
    if (!cfg.context.enabled || !this.sContextEnabled[0]()) return null
    const term = this.terminalSnapshot()
    if (!term) return null
    const git = term.cwd !== null ? await collectGitStatus(term.cwd, signal) : null
    const maxLines = Math.max(1, cfg.context.scrollbackLines)
    const trimmedTail = trimBlankSpam(term.tailLines.slice(-maxLines))
    const fp = trimmedTail.length > 0 ? tailFingerprint(trimmedTail) : null
    const unchanged = fp !== null && fp === this.lastTailFingerprint
    this.lastTailFingerprint = fp
    const block = buildContextBlock(
      {
        cwd: term.cwd,
        shell: term.shell,
        currentCommand: term.currentCommand,
        alternateOn: term.alternateOn,
        tailLines: term.tailLines,
      },
      git,
      cfg.context.scrollbackLines,
      { tailUnchanged: unchanged, approval: this.sApproval[0]() },
    )
    // Running-job visibility for the AGENT (docs/agent.md "Background-job
    // visibility"): the cheap "are any of my jobs still running?" answer rides
    // the per-generation context message, so the model can poll/kill instead of
    // leaving an orphan. Only present while a job is live, so quiet turns cost
    // nothing and the prefix stays stable.
    const live = activeJobs(this.jobScope)
    if (live.length === 0) return block
    const ids = live.map((j) => j.id).join(", ")
    return `${block}\n[agent] background jobs: ${live.length} running (ids ${ids}) — check with shell_background {job:<id>}, stop with {job:<id>, kill:true}`
  }

  // ---- context management (docs/agent.md "Context management & compaction")

  private compactionEnabled(): boolean {
    return this.deps.getConfig().context.autoCompact !== false
  }

  /**
   * Effective context ceiling (tokens) for the active model: an explicit
   * positive `context.contextLimit` wins; otherwise the resolved metadata
   * (endpoint model override → models.dev); otherwise the 128k fallback — then
   * capped by the model's advertised input-token ceiling (`models.dev
   * limit.input` / the per-model `inputLimit` override) when known. The API
   * rejects a prompt over the input cap even when the context window is
   * larger, so the preflight trigger fires at `effectiveCeiling - reserve`.
   * Public for the status bar so its display matches the compaction trigger.
   */
  contextLimit(): number {
    return this.accounting.limit()
  }

  /**
   * Request-token estimate (system prompt + durable history + MCP spec
   * overhead) shared by the preflight and the compaction accounting.
   */
  private estimateTokensFor(history: ProviderMessage[], anchor: UsageAnchor | null, withTools: boolean): number {
    return this.accounting.estimateFor(history, anchor, withTools)
  }

  /** A cheap signature of everything that shapes a request's fixed overhead
   * (memoized system-prompt tokens + tool specs). When it changes since the
   * anchor was captured, the anchor must not be trusted. */
  private currentAnchorKey(): string {
    return `${this.accounting.systemTokens()}|${this.noTools ? 1 : 0}|${this.mcpSpecTokens()}`
  }

  /**
   * The usage anchor, but only while the request shape still matches the one it
   * was captured under. A no-tools flip / MCP connect / agent switch resets it
   * implicitly, so the next estimate is recomputed locally.
   */
  private currentUsageAnchor(): UsageAnchor | null {
    const a = this.usageAnchor
    if (a === null) return null
    try {
      return this.usageAnchorKey === this.currentAnchorKey() ? a : null
    } catch {
      return a // shape probing must never lose a valid anchor
    }
  }

  /** Estimate the next request's tokens (usage-anchored, local fallback). */
  private estimateNextRequest(withTools: boolean): number {
    return this.accounting.estimateNext(withTools)
  }

  /**
   * Serializable snapshot of what currently occupies the model's context
   * window, for the Context inspector overlay (Phase 3.1, docs/agent.md
   * "Context inspector"). Pure reads of the EXISTING estimators
   * (agent/chat/compaction.ts) + the session's live signals — it never
   * mutates request-building state and never throws: any failure degrades to
   * zeros plus a note so an empty/disabled session still renders.
   *
   * Reading `accessors.messages()` (and the other signals) inside makes the
   * overlay's memo track the session, so the inspector updates live while a
   * generation streams. `providerHistory` is the durable context itself; the
   * `history` previews are bounded to one line per message.
   */
  contextBreakdown(): ContextBreakdown {
    return this.accounting.breakdown()
  }

  /**
   * Optional prune pass (docs/config.md "compaction.prune"): clear tool outputs older
   * than the protected recent window. Runs once at generation start, like
   * compaction, and ONLY when `compaction.prune` is enabled. A rewrite
   * invalidates the provider's prompt-cache prefix, so the event is never
   * silent: an audit entry + a toast record it, and the usage anchor is reset
   * so the next estimate is recomputed locally rather than trusting a stale
   * prompt-token count. `prune: false` (the default) is a no-op.
   */
  private pruneHistory(): void {
    if (!this.deps.getConfig().compaction.prune) return
    const { history, prunedCount, reclaimedTokens } = pruneToolOutputs(this.providerHistory)
    if (prunedCount === 0) return
    this.providerHistory.length = 0
    this.providerHistory.push(...history)
    this.providerHistoryMarks.clear() // indexes into the old array are meaningless
    this.usageAnchor = null // the prompt's bytes changed — a stale anchor would lie
    this.restoredHistory = null // resumed-display reconstruction no longer matches
    this.restoredMark = 0
    this.deps.audit?.record({
      ts: Date.now(),
      kind: "other",
      tool: "prune",
      summary: `pruned ${prunedCount} tool output(s) (~${reclaimedTokens} tokens)`,
      ok: true,
    })
    this.deps.toast(
      `pruned ${prunedCount} old tool output(s) (~${formatTokens(reclaimedTokens)} tokens) — cache prefix reset`,
      "info",
      3500,
    )
  }

  /**
   * Preflight compaction (docs/agent.md): near the model's context limit,
   * fold the older history into a checkpoint BEFORE the request. Called at
   * generation start (before the context message is appended — the fresh
   * block must survive the rewrite) and, for later turns, from the loop.
   */
  private async preflightCompact(signal: AbortSignal): Promise<void> {
    if (!this.compactionEnabled() || signal.aborted) return
    const cfg = this.deps.getConfig()
    const reserve = compactionReserve(this.outputTokensForRequest(), cfg.context.bufferTokens)
    const estimate = this.estimateNextRequest(!this.noTools)
    if (shouldCompact(estimate, this.contextLimit(), reserve)) {
      await this.compactHistory(signal, false)
    }
  }

  /**
   * Compaction: one extra no-tools request produces a
   * structured summary; the durable history is replaced by
   * [checkpoint message, retained tail]. Returns true when history changed.
   * Never throws; failures surface as a return value (+ toast/error when manual).
   */
  private async compactHistory(signal: AbortSignal, manual: boolean): Promise<boolean> {
    const history = [...this.providerHistory]
    if (history.length === 0) {
      if (manual) this.deps.toast("nothing to compact yet")
      return false
    }
    const cfg = this.deps.getConfig()
    const keepTokens = cfg.context.keepTokens > 0 ? cfg.context.keepTokens : DEFAULT_KEEP_TOKENS
    if (!manual && !compactionEligible(history, keepTokens)) return false
    const previousCheckpoint =
      history[0]?.role === "user" && history[0].content.startsWith(CHECKPOINT_TAG) ? history[0].content : null

    this.compacting = true
    try {
      const endpoint = this.endpoint()
      const model = this.modelName()
      const meta = this.modelMeta()
      const baseRequest = buildCompactionRequest({ history, previousCheckpoint, pinned: this.sPinned[0]() })
      const attempt = async (
        messages: typeof baseRequest,
      ): Promise<{ text: string; valid: boolean; finish: StreamResult["finish"] } | null> => {
        let text = ""
        const result = await this.deps.provider(this.endpointName()).stream(
          {
            model,
            messages,
            temperature: endpoint.temperature,
            // Size from the model's advertised output limit (up to the one-shot
            // ceiling) and pin the model's LOWEST reasoning effort so hidden
            // thinking cannot consume the whole budget and leave no summary.
            maxTokens: oneShotMaxTokens(endpoint.maxTokens, meta?.output),
            // `endpoint.maxTokens` may be undefined (auto); oneShotMaxTokens
            // treats that as the endpoint clamp and still considers the model's
            // advertised output, so the summary pass keeps its bounded budget.
            thinking: oneShotThinkingKnob(meta),
            tools: undefined, // summarization never dispatches tools
          },
          {
            onDelta: (d) => {
              text += d
            },
            onUsage: (u) => this.sTotalTokens[1]((t) => t + u.totalTokens),
          },
          signal,
        )
        // Accept a truncated summary (`finish:"length"`) — isValidSummary is
        // the authority; only abort/error is fatal.
        if (signal.aborted || result.finish === "aborted" || result.finish === "error") return null
        return { text, valid: isValidSummary(text), finish: result.finish }
      }

      let reply = await attempt(baseRequest)
      if (reply !== null && !reply.valid) {
        reply = await attempt(buildSummaryRetry(baseRequest, reply.text))
      }
      if (reply === null || !reply.valid || signal.aborted) {
        // Name a truncation so an empty/partial summary is diagnosable from
        // the error alone (`compaction failed: … (finish=length)`). A
        // `finish:"length"` reply that failed validation is starvation: the
        // budget ran out (hidden reasoning can consume it) before a usable
        // summary, so say that instead of the generic message.
        const starved = reply !== null && reply.finish === "length"
        const detail = reply !== null && reply.finish !== "stop" ? ` (finish=${reply.finish})` : ""
        const why = starved
          ? "the model ran out of output budget before returning a usable summary (hidden reasoning can consume it)"
          : "the model did not return a usable summary"
        if (manual) {
          this.addError(`compaction failed: ${why}${detail}`)
          this.deps.toast(`compaction failed: ${starved ? "reasoning starved the summary" : "no usable summary"}${detail}`, "error", 4500)
        }
        return false
      }

      const before = this.estimateTokensFor(history, null, !this.noTools)
      const next = applyCheckpoint({ history, summary: reply.text, keepTokens, minTailTurns: cfg.compaction.tailTurns, pinned: this.sPinned[0]() })
      this.providerHistory.length = 0
      this.providerHistory.push(...next)
      this.providerHistoryMarks.clear() // checkpoint rewrote the indexes
      this.usageAnchor = null // anchor's history indexes are meaningless now
      this.restoredHistory = null // checkpoint replaced the reconstructed prefix
      this.restoredMark = 0
      this.sCompactions[1]((n) => n + 1)
      this.deps.file().append({
        ts: Date.now(),
        type: "compaction",
        checkpoint: next[0]?.content ?? "",
        model,
      })
      const after = this.estimateTokensFor(this.providerHistory, null, !this.noTools)
      this.addSystem(
        `context compacted: ~${formatTokens(before)} → ~${formatTokens(after)} tokens estimated — older history summarized into a checkpoint (${formatTokens(keepTokens)} recent tokens kept)`,
      )
      if (manual) this.deps.toast("context compacted", "success", 3500)
      return true
    } finally {
      this.compacting = false
    }
  }

  /** /compact: manual compaction with its own abort controller. */
  private async runManualCompaction(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try {
      await this.compactHistory(controller.signal, true)
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  /**
   * Persist one assistant_message JSONL event — every generation exit path
   * (error / aborted / pre-tool / final / thrown) writes the same shape.
   */
  private persistAssistantBubble(o: {
    content: string
    thinking?: string
    model: string
    usage: UsageInfo | null
    aborted: boolean
  }): void {
    this.deps.file().append({
      ts: Date.now(),
      type: "assistant_message",
      content: o.content,
      thinking: o.thinking ?? "",
      model: o.model,
      usage: o.usage,
      aborted: o.aborted,
    })
  }

  /**
   * Best-effort auto-title trigger (docs/sessions.md "Auto titles"): fires the
   * host hook only for the FIRST user prompt of a session and only when the
   * sidecar has no explicit title yet — a manual rename is never overwritten.
   * Reads the sidecar once; a broken sidecar just skips the title. Never
   * throws (a bad hook must not kill a send).
   */
  private maybeTitleFirstPrompt(text: string, signal: AbortSignal): void {
    if (this.deps.onFirstPrompt === undefined) return
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const path = this.sessionFilePath
    if (path === null) return
    try {
      if (readSessionMeta(path).title !== undefined) return
    } catch {
      return
    }
    try {
      this.deps.onFirstPrompt({
        text: trimmed,
        path,
        endpoint: this.endpointName(),
        model: this.modelName(),
        signal,
      })
    } catch {
      // the hook is host-side — never fail the send because of it
    }
  }

  /** Append a sent line to the up-arrow history (bounded). */
  private pushHistory(text: string): void {
    this.composer.pushHistory(text)
  }

  /**
   * Fire-and-forget a generation from a non-awaiting caller (the chat input
   * path and the busy-send queue/steer flush): a rejection escaping
   * `sendMessage` would otherwise become an unhandled rejection — fatal in the
   * daemon. `sendMessage` handles its own errors; this is the belt-and-braces
   * seam.
   */
  private dispatchGeneration(text: string, images?: readonly ImageAttachment[]): void {
    void this.sendMessage(text, images ?? []).catch((e: unknown) =>
      log.error("generation dispatch failed", { err: e, session: this.sessionId }),
    )
  }

  private async sendMessage(text: string, images: readonly ImageAttachment[] = []): Promise<void> {
    if (!this.hasKey()) {
      this.setStatus("disabled")
      this.addError("no API key for this endpoint — set its apiKey in config.json (endpoints.<name>.apiKey)")
      this.deps.toast("no API key for this endpoint — see the error in chat", "error", 4500)
      return
    }
    this.pushHistory(text)

    const endpoint = this.endpoint()
    const model = this.modelName()
    // Loop cap for THIS generation: read once from config (chat.maxToolTurns;
    // null = no cap) so a settings change applies to the next message.
    const maxToolTurns = this.deps.getConfig().chat.maxToolTurns

    const attachments = images.length > 0 ? [...images] : undefined
    // Auto-title: only the FIRST user prompt of this session (resumed sessions
    // restore their user messages, so they are never "first" again).
    const isFirstPrompt = !this.sMessages[0]().some((m) => m.role === "user")
    const userMsg = this.pushMessage({ role: "user", content: text, ...(attachments !== undefined ? { images: attachments } : {}) })
    this.deps.file().append({ ts: userMsg.ts, type: "user_message", content: text, ...(attachments !== undefined ? { images: attachments } : {}) })

    this.setStatus("streaming")
    this.sStreamingSince[1](Date.now())
    this.turnStartedAt = Date.now()
    this.deps.onStatusChange?.("streaming")

    const controller = new AbortController()
    this.controller = controller
    // A new generation supersedes any pending reveal-drain flip from the one
    // that just settled (the queue can auto-start a send from sendMessage's
    // own finally — that flip must not force this run back to idle).
    this.cancelDrain()

    // Doom-loop guard: a fresh generation starts with no run history.
    this.doomLoopSignature = null
    this.doomLoopCount = 0
    // A new generation clears any rewind latch (the previous generation must
    // have fully settled before a send is accepted — see handleInput) and any
    // abort reason left over from a prior turn.
    this.generationRewound = false
    this.abortReason = null

    // Session title (docs/sessions.md "Auto titles"): on the first prompt show
    // the derived first-user-message title immediately (the tab's placeholder
    // while the model title generates), then fire-and-forget the auto title,
    // sharing this generation's AbortSignal (Esc cancels it).
    if (isFirstPrompt) {
      this.setSessionTitle(deriveTitleFromText(text))
      this.maybeTitleFirstPrompt(text, controller.signal)
    }

    // Delta coalescing: deltas accumulate in a buffer and land on the message
    // list at most every STREAM_FLUSH_MS. The bubble is still created on the
    // first delta (label + spinner appear immediately).
    let assistantId: number | null = null
    let contentStartTs = 0
    let reasoningStartTs = 0
    const buffer = { content: "", thinking: "" }
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flushBuffer = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (this.generationRewound) {
        // The transcript was rewound: never append to a removed bubble.
        buffer.content = ""
        buffer.thinking = ""
        return
      }
      if (assistantId === null) return
      if (buffer.content.length > 0) {
        this.appendToMessage(assistantId, buffer.content)
        buffer.content = ""
      }
      if (buffer.thinking.length > 0) {
        this.appendThinkingToMessage(assistantId, buffer.thinking)
        buffer.thinking = ""
      }
    }
    const scheduleFlush = (): void => {
      if (flushTimer === null) flushTimer = setTimeout(flushBuffer, STREAM_FLUSH_MS)
    }
    const ensureBubble = (): number => {
      if (assistantId === null) {
        assistantId = this.pushMessage({ role: "assistant", content: "", model, aborted: false }).id
      }
      return assistantId
    }

    // MCP (M11): lazy-connect configured servers ONCE per instance before
    // the first request of a generation, so their tools ride in it. Failures
    // degrade to core-tools-only (toast), never block the send. Esc aborts.
    if (!this.noTools && this.deps.mcp && this.sMcpEnabled[0]()) {
      try {
        const failures = await this.deps.mcp.ensureReady(this.deps.getConfig().mcp, controller.signal)
        if (controller.signal.aborted) {
          // Aborted during the lazy MCP connect, before any request was made:
          // mirror the loop's abort-before-output path so the turn is never a
          // silent user bubble with no reply (docs/agent.md "Streaming display").
          const abortedId = this.pushMessage({
            role: "assistant",
            content: "⏹ aborted before any output",
            model,
            aborted: true,
          }).id
          this.patchMessage(abortedId, { finishedTs: Date.now() })
          this.persistAssistantBubble({ content: "⏹ aborted before any output", model, usage: null, aborted: true })
          this.setStatus("idle")
          this.sStreamingSince[1](0)
          this.deps.onStatusChange?.("idle")
          this.emitTurnComplete("aborted", this.abortReason ?? "user")
          return
        }
        if (failures.length > 0) {
          this.deps.toast(`mcp: ${failures[0]}`, "warn", 5000)
          this.addSystem(`mcp server error: ${failures.join("; ")}`)
        }
      } catch {
        // registry explosion must not kill the send
      }
    }
    const mcpSpecs = this.mcpSpecsForRequest()

    let failed = false
    // A reply cut off by the endpoint's output cap (`finish:"length"`) is not a
    // failure, but it IS an incomplete answer — latch it so the turn outcome and
    // the `turn-complete` log/event reflect that instead of a clean `ok`
    // (docs/agent.md "Streaming display").
    let truncated = false
    // A plain stop with no visible answer (reasoning only, or nothing at all)
    // is the same kind of silently-incomplete turn — latch it too, so the
    // outcome is `error`, never a clean `ok` (docs/agent.md "Streaming
    // display").
    let answerless = false
    try {
      // Optional prune pass runs BEFORE preflight compaction and before this
      // generation's context message is appended (only on the first turn, like
      // compaction). `compaction.prune: false` (the default) is a no-op.
      this.pruneHistory()
      // Preflight compaction runs BEFORE this generation's context message is
      // appended, so a checkpoint rewrite can never eat the fresh block (the
      // prompt-cache invariant: appended messages stay put, docs/agent.md).
      await this.preflightCompact(controller.signal)
      // A rewind during preflight aborted this generation; the durable history
      // may already have been rewritten — do not append this turn's block.
      if (this.generationRewound) return
      // The terminal context block is DURABLE (docs/agent.md "Prompt caching"):
      // emitted once per generation as its own provider-history message, so
      // earlier requests' prefixes stay byte-identical. Volatility (fresh
      // tail snapshot, approval mode) lands at the tail where it belongs.
      const contextBlock = await this.buildContextBlockForMessage(controller.signal)
      if (this.generationRewound) return
      // Mark the history position this user message starts at (before its
      // context block + text), so a later rewind can truncate precisely.
      this.providerHistoryMarks.set(userMsg.id, this.providerHistory.length)
      if (contextBlock !== null) this.providerHistory.push({ role: "user", content: contextBlock })
      this.providerHistory.push({ role: "user", content: text, ...(attachments !== undefined ? { images: attachments } : {}) })

      let turn = 0
      let overflowRetried = false
      for (;;) {
        turn++
        if (maxToolTurns !== null && turn > maxToolTurns) {
          // Loop cap: a transcript note (it explains why the agent went quiet)
          // AND a warn toast for the moment it happens. null = no cap.
          this.addSystem(`stopped after ${maxToolTurns} tool turns (loop cap) — send a message to continue`)
          this.deps.toast(`stopped after ${maxToolTurns} tool turns — send a message to continue`, "warn", 4500)
          break
        }

        // Fresh assistant bubble per provider round-trip (a turn's deltas go
        // to that turn's bubble — the previous turn's is already settled).
        assistantId = null
        contentStartTs = 0
        reasoningStartTs = 0

        // Preflight compaction for LATER turns (turn 1 ran before the context
        // message was appended): near the model's context limit, fold the
        // older history into a checkpoint BEFORE the request.
        if (turn > 1 && this.compactionEnabled() && !controller.signal.aborted) {
          const cfg = this.deps.getConfig()
          const reserve = compactionReserve(this.outputTokensForRequest(), cfg.context.bufferTokens)
          const estimate = this.estimateNextRequest(!this.noTools)
          if (shouldCompact(estimate, this.contextLimit(), reserve)) {
            await this.compactHistory(controller.signal, false)
          }
        }

        // Busy-send steer injection (docs/config.md `chat.busySend`): a message
        // the user sent while the previous turn was streaming is appended HERE,
        // at the safe boundary after the previous turn's tool results, so the
        // model sees it on this request. Append-only — the prompt cache prefix
        // stays intact (docs/agent.md "Prompt caching").
        this.drainSteers()

        // Request assembly: system + durable history (the context block is
        // already IN the history — nothing is injected here). Tools are the
        // AGENT's subset of the core tool specs (docs/agents.md frontmatter `tools`)
        // plus the connected MCP servers' specs.
        const messages: ProviderMessage[] = [
          { role: "system", content: this.buildSystemPrompt() },
          ...this.providerHistory,
        ]
        const sentCount = this.providerHistory.length
        // The specs actually sent this request — reused below for tool-name
        // repair, so a mis-cased call resolves only against what the model saw.
        const requestSpecs = this.noTools ? [] : [...this.toolSpecsForRequest(TOOL_SPECS), ...mcpSpecs]
        // Output cap: explicit endpoint maxTokens → the model's advertised
        // output limit → omitted (endpoint default). Never a silent sub-model cap.
        const maxOutputTokens = this.outputTokensForRequest()
        const result = await this.deps.provider(this.endpointName()).stream(
          {
            model,
            messages,
            temperature: this.requestTemperature(endpoint),
            maxTokens: maxOutputTokens,
            tools: this.noTools ? undefined : requestSpecs,
            noTools: this.noTools,
            thinking: this.thinkingKnob(),
          },
          {
            onDelta: (d) => {
              if (this.generationRewound) return
              ensureBubble()
              if (contentStartTs === 0) contentStartTs = Date.now()
              buffer.content += d
              scheduleFlush()
            },
            onReasoning: (d) => {
              if (this.generationRewound) return
              ensureBubble()
              if (reasoningStartTs === 0) reasoningStartTs = Date.now()
              buffer.thinking += d
              scheduleFlush()
            },
            onStreamRestart: () => {
              // The provider is retrying a failed attempt (docs/agent.md
              // "Streaming display"): reasoning streamed by that attempt must
              // be discarded — the retry re-streams it. Runs synchronously
              // inside stream() and must never throw into it.
              try {
                if (this.generationRewound) return
                buffer.thinking = ""
                reasoningStartTs = 0
                if (assistantId === null) return
                const shown = this.sMessages[0]().find((m) => m.id === assistantId)
                if (shown === undefined) {
                  assistantId = null
                  return
                }
                // Clear the bubble IN PLACE. Removing it has no ChatEvent kind,
                // so a daemon mirror would keep the stale reasoning block; a
                // cleared bubble is observationally identical — the retry's
                // ensureBubble() reuses it and its reasoning streams afresh.
                this.patchMessage(assistantId, { thinking: "", thinkingMs: 0 })
              } catch {
                // A restart callback must never kill the generation (rule 10).
              }
            },
            onUsage: (u) => {
              if (this.generationRewound) return
              this.sContextUsed[1](u.promptTokens)
              this.sTotalTokens[1]((t) => t + u.totalTokens)
              this.sCacheRead[1](
                u.cachedTokens != null && u.cachedTokens > 0
                  ? { cached: u.cachedTokens, prompt: u.promptTokens }
                  : null,
              )
            },
            onNoTools: () => this.markNoTools(),
          },
          controller.signal,
        )
        flushBuffer()
        // Rewound mid-stream: the transcript/history were already truncated;
        // skip every result handler (bubble persistence, provider messages).
        if (this.generationRewound) break
        if (reasoningStartTs > 0 && assistantId !== null) {
          // Reasoning duration: first reasoning delta -> first content delta
          // (or stream end when the model never produced visible content).
          const ended = contentStartTs > 0 ? contentStartTs : Date.now()
          this.patchMessage(assistantId, { thinkingMs: Math.max(0, ended - reasoningStartTs) })
        }
        if (result.usage !== null && result.usage.promptTokens > 0) {
          // Anchor: the prompt covered exactly `sentCount` history messages;
          // everything appended after is new content for the next estimate.
          // The shape key pins the system-prompt/tool overhead this count
          // included, so a later tool-set/prompt change invalidates it.
          this.usageAnchor = { promptTokens: result.usage.promptTokens, historyLength: sentCount }
          this.usageAnchorKey = this.currentAnchorKey()
        }

        const bubble = (): ChatMessage | undefined =>
          assistantId === null ? undefined : this.sMessages[0]().find((m) => m.id === assistantId)
        const content = bubble()?.content ?? ""

        if (result.finish === "error") {
          // One-shot overflow recovery (docs/agent.md): a provider context
          // overflow compacts once and retries the SAME step.
          if (
            this.compactionEnabled() &&
            !overflowRetried &&
            !controller.signal.aborted &&
            isContextOverflowError(result.error) &&
            this.providerHistory.length > 0
          ) {
            overflowRetried = true
            if (await this.compactHistory(controller.signal, false)) {
              turn -= 1 // retry the same step; the retry costs no extra turn
              continue
            }
          }
          // Persist ONLY when an assistant bubble exists: a failed turn with no
          // output leaves no record, so the display transcript stays 1:1 with
          // the JSONL (a rewind's `keep` and --resume both rely on it).
          failed = true
          if (assistantId !== null) {
            this.patchMessage(assistantId, { usage: null })
            this.persistAssistantBubble({ content, thinking: bubble()?.thinking, model, usage: null, aborted: false })
          }
          this.addError(`reply failed: ${result.error ?? "unknown provider error"}`)
          this.deps.toast("reply failed — see the error in chat", "error", 4500)
          break
        }
        if (result.finish === "aborted") {
          if (assistantId === null) {
            // No output yet: a synthetic bubble IS the turn's display, so bind
            // it to assistantId — it is what gets persisted (1:1 with the file).
            assistantId = this.pushMessage({
              role: "assistant",
              content: "⏹ aborted before any output",
              model,
              aborted: true,
            }).id
          } else {
            this.appendToMessage(assistantId, "\n\n⏹ aborted")
            this.patchMessage(assistantId, { aborted: true })
          }
          this.persistAssistantBubble({
            content: bubble()?.content ?? content,
            thinking: bubble()?.thinking,
            model,
            usage: result.usage,
            aborted: true,
          })
          break
        }

        // Tool-name repair: a provider may emit a mis-cased or slightly-wrong
        // name (`Read_File`, `read` for `read_file`). Resolve it against the
        // specs sent this request BEFORE the assistant message is pushed — the
        // stored call and the tool result must both carry the canonical name.
        // An ambiguous/unknown name is left as-is so the structured
        // `unknown tool "<name>"` error still surfaces.
        const knownToolNames = requestSpecs.map((s) => s.function.name)
        const toolCalls = (result.toolCalls ?? []).map((c) => {
          const resolved = resolveToolName(c.name, knownToolNames)
          return resolved === c.name ? c : { ...c, name: resolved }
        })
        if (result.finish === "tool_calls" && toolCalls.length > 0) {
          if (assistantId !== null) {
            if (content.length === 0 && (bubble()?.thinking ?? "").length === 0) {
              // Empty pre-tool bubble: drop it, the cards tell the story.
              // (A bubble that carries THINKING is kept — reasoning before a
              // tool call is part of the story.)
              const dropId = assistantId
              this.sMessages[1]((list) => list.filter((m) => m.id !== dropId))
              // The bubble is gone: clear assistantId so no later exit path
              // persists a record with no matching display message.
              assistantId = null
            } else {
              this.persistAssistantBubble({
                content,
                thinking: bubble()?.thinking,
                model,
                usage: result.usage,
                aborted: false,
              })
            }
          }
          this.providerHistory.push({ role: "assistant", content, toolCalls: toolCalls })
          // Approval-batch plan (docs/agent.md "Approval-batch plan card"): when
          // this turn yields ≥2 gated calls, collect the whole plan's decisions
          // BEFORE executing, so the user approves the task as one ordered plan.
          const batch = await this.resolveApprovalBatch(toolCalls, controller.signal)
          const results: ProviderMessage[] = []
          for (const call of toolCalls) {
            // A rewind during an earlier call in this batch stops the rest:
            // never render/run a call whose turn was already rewound.
            if (this.generationRewound) break
            // The result is already capped + spilled at the tool boundary
            // (docs/config.md "tool_output"); the bytes appended here are the
            // bytes kept forever (no retroactive rewrites — prompt-cache
            // invariant). A batch member skips its own pending wait (its decision
            // was collected by the plan).
            const modelText = await this.runToolCall(call, controller.signal, batch?.get(call.id))
            results.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: modelText })
          }
          if (this.generationRewound) break
          this.providerHistory.push(...results)
          // Nearest-AGENTS.md attach: a read_file may have entered a project
          // tree whose instructions were never loaded statically. Appended as
          // its own durable user message (cache-safe, docs/agent.md "Prompt
          // caching") — never folded into the system prompt.
          if (!controller.signal.aborted) this.attachNearestInstructions(toolCalls)
          // Vision tool results: the image bytes trail the (text-only) tool
          // results as a synthetic user message the model can see (docs/agent.md
          // "Images"). Skipped on abort so tool results stay contiguous.
          if (!controller.signal.aborted && this.pendingToolImages.size > 0) {
            for (const call of toolCalls) {
              const imgs = this.pendingToolImages.get(call.id)
              if (imgs !== undefined && imgs.length > 0) {
                this.providerHistory.push({
                  role: "user",
                  content: `Image loaded by ${call.name}: ${imgs.map((a) => a.name).join(", ")}`,
                  images: imgs,
                })
              }
            }
            this.pendingToolImages.clear()
          } else if (controller.signal.aborted) {
            this.pendingToolImages.clear()
          }
          if (controller.signal.aborted) {
            // Patch history integrity: aborted mid-tools would leave tool
            // calls without results; the next request must stay valid.
            const answered = new Set(results.map((r) => r.toolCallId))
            for (const call of toolCalls) {
              if (!answered.has(call.id)) {
                this.providerHistory.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: "(aborted by user)" })
              }
            }
            // Persist only when a display bubble survived the empty-pre-tool
            // drop (1:1 display ↔ JSONL invariant).
            if (assistantId !== null) {
              this.persistAssistantBubble({
                content: bubble()?.content ?? "(aborted mid tool call)",
                thinking: bubble()?.thinking,
                model,
                usage: result.usage,
                aborted: true,
              })
            }
            break
          }
          continue // loop back with tool results
        }

        // Plain stop: final answer.
        this.providerHistory.push({ role: "assistant", content })
        // Skip the record when the model stopped with no bubble (empty
        // completion): the display transcript and the JSONL stay 1:1.
        if (assistantId !== null) {
          this.patchMessage(assistantId, { usage: result.usage })
          this.persistAssistantBubble({
            content: bubble()?.content ?? content,
            thinking: bubble()?.thinking,
            model,
            usage: result.usage,
            aborted: false,
          })
        }
        // Truncation is a REAL but silently-incomplete answer: the endpoint hit
        // its output-token cap and the stream was cut mid-reply (docs/agent.md
        // "Streaming display"). Without this the turn looks like a clean stop and
        // the user gets no clue why the agent went quiet.
        if (result.finish === "length") {
          truncated = true
          // The cap is whatever we actually sent: an explicit maxTokens, else the
          // model's advertised output limit; unknown (omitted) reads as "the
          // endpoint's own cap" rather than a bogus number.
          const cap = maxOutputTokens
          log.warn("reply hit the output-token cap; answer truncated", {
            session: this.sessionId,
            model,
            finish: "length",
            maxTokens: cap ?? null,
            contentChars: content.length,
            thinkingChars: bubble()?.thinking?.length ?? 0,
          })
          const capLabel = cap !== undefined ? `${cap}-token output cap` : "endpoint's output cap"
          this.addSystem(
            `⚠ reply hit the ${capLabel} and was cut off — raise maxTokens for endpoint "${this.endpointName()}" or say "continue"`,
          )
          this.deps.toast("reply hit the output cap — answer was cut off", "warn", 5000)
          this.emitErrorRaised("provider", `reply truncated at the ${capLabel}`)
        } else if (content.trim().length === 0) {
          // An empty completion: the model stopped with no visible text. A
          // reasoning-only turn DOES create a bubble (onReasoning calls
          // ensureBubble), so the guard is the bubble's CONTENT, not its
          // existence (docs/agent.md "Streaming display"). Completed tool calls
          // that arrived with a non-tool_calls finish are dropped unexecuted
          // (the tool branch requires finish:"tool_calls") and must not hide the
          // answerless state either. Nothing renders as an answer (the 1:1
          // display ↔ JSONL rule persists only the reasoning bubble), so without
          // a note the turn is genuinely silent.
          const hadReasoning = (bubble()?.thinking ?? "").length > 0
          const droppedCalls = toolCalls.length
          answerless = true
          log.warn("empty completion: model stopped with no visible content", {
            session: this.sessionId,
            model,
            finish: result.finish,
            thinkingChars: bubble()?.thinking?.length ?? 0,
            droppedToolCalls: droppedCalls,
          })
          const base = hadReasoning
            ? "model returned an empty reply — no visible answer after reasoning"
            : "model returned an empty reply"
          const dropped =
            droppedCalls > 0
              ? ` (${droppedCalls} tool call${droppedCalls === 1 ? "" : "s"} arrived without a tool_calls finish and ${
                  droppedCalls === 1 ? "was" : "were"
                } not executed)`
              : ""
          this.addSystem(`${base}${dropped} — send a message to retry`)
          this.emitErrorRaised(
            "provider",
            hadReasoning ? "model returned an empty reply after reasoning" : "model returned an empty reply",
          )
        } else {
          log.debug("turn stream settled", {
            session: this.sessionId,
            model,
            finish: result.finish,
            contentChars: content.length,
          })
        }
        // A steer that arrived during this final stream would otherwise be
        // stranded: run one more turn so the model actually responds to it
        // (docs/config.md `chat.busySend`). The next iteration drains it before
        // assembling the request.
        if (this.pendingSteers.length > 0) continue
        break
      }
      // Leftover steers (an abort / error / loop-cap exit) are answered by the
      // finally's `flushSteers()` — never drained into a dead transcript.
    } catch (e) {
      // A rewind abort surfaces here as an abort/throw; never log it as a
      // failure or append a stray bubble/record after the truncation.
      if (!this.generationRewound) {
        failed = true
        flushBuffer() // land whatever partial deltas arrived before the throw
        const message = errorMessage(e)
        this.addError(`reply failed: ${message}`)
        this.deps.toast("reply failed — see the error in chat", "error", 4500)
        // Persist only a bubble that actually exists (1:1 display ↔ JSONL).
        if (assistantId !== null) {
          const partial = this.sMessages[0]().find((m) => m.id === assistantId)
          this.persistAssistantBubble({
            content: partial?.content ?? "",
            thinking: partial?.thinking,
            model,
            usage: null,
            aborted: true,
          })
        }
      }
    } finally {
      flushBuffer()
      if (flushTimer !== null) clearTimeout(flushTimer)
      // Stamp the last bubble of the generation with its finish time (the
      // settled label shows the duration).
      if (assistantId !== null) this.patchMessage(assistantId, { finishedTs: Date.now() })
      this.controller = null
      this.finishStreamingWhenCaught(assistantId)
      // Turn outcome (docs/events.md): one `turn-complete` per generation.
      // A rewind/abort is `aborted`; a thrown failure, a truncated reply, or an
      // answerless completion is `error`; else `ok`. Truncation/answerless fold
      // into `error` deliberately: the v1 event schema is frozen at these three
      // outcomes, and an incomplete reply must not be indistinguishable from a
      // complete one (docs/logging.md, events.md).
      const outcome = this.generationRewound || controller.signal.aborted ? "aborted" : failed || truncated || answerless ? "error" : "ok"
      // The abort reason rides the settle: an aborted turn records WHY (Esc,
      // rewind, shell exit, approval timeout, shutdown, plan cancel). The
      // `turn completed` info record + seam event are emitted together by
      // `emitTurnComplete` (one per generation — never a second record).
      const reason = outcome === "aborted" ? this.abortReason ?? "user" : undefined
      this.emitTurnComplete(outcome, reason, { truncated, answerless, failed })
      // Background-job visibility at turn end (docs/agent.md): a job the agent
      // started detached outlives the turn, so surface a NEW high-water mark as
      // it ends (a long-lived job does not toast every turn). The live count is
      // also the status bar's `jobs:N` chip.
      const liveJobs = activeJobs(this.jobScope)
      if (liveJobs.length > this.reportedJobCount) {
        this.deps.toast(
          `${liveJobs.length} background job${liveJobs.length === 1 ? "" : "s"} still running — see the jobs chip`,
          "warn",
          5000,
        )
      }
      this.reportedJobCount = liveJobs.length
      // A steer the model never saw (an abort / error / loop-cap exit) is
      // re-dispatched as its own generation so the agent actually answers it,
      // instead of being drained into a dead user bubble. A plain stop already
      // drained its steers inside the loop.
      if (this.pendingSteers.length > 0) {
        this.flushSteers()
      } else if (!controller.signal.aborted) {
        // Queue flush (docs/config.md `chat.busySend` "queue"): a message the
        // user queued while this reply streamed becomes the NEXT generation. An
        // Esc abort keeps the queue (the user chose to stop); a rewind drops it.
        this.flushQueue()
      }
    }
  }

  /** Cancel a pending reveal-drain flip (a new generation supersedes it). */
  private cancelDrain(): void {
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer)
      this.drainTimer = null
    }
    this.drainBubbleId = null
  }

  /**
   * Leave the streaming display only once the reply has VISUALLY arrived
   * (docs/agent.md "Streaming display"): the tick-driven streaming UI —
   * status bar spinner, animated label — is what drives the render passes
   * that paint the reveal's final steps, so flipping to idle early can leave
   * the last rows unpainted until opentui's slow refresh. Holds "streaming"
   * while the pour drains (bounded by a failsafe), then flips. Headless /
   * animations-off / already-caught paths flip immediately.
   */
  private finishStreamingWhenCaught(assistantId: number | null): void {
    const flip = (): void => {
      if (this.drainTimer !== null) {
        clearInterval(this.drainTimer)
        this.drainTimer = null
      }
      this.drainBubbleId = null
      this.setStatus(this.hasKey() ? "idle" : "disabled")
      this.sStreamingSince[1](0)
      this.deps.onStatusChange?.("idle")
    }
    if (assistantId === null || !this.sAnimations[0]() || this.reveal.contentSettled(assistantId, Date.now())) {
      flip()
      return
    }
    this.drainBubbleId = assistantId
    const started = Date.now()
    this.drainTimer = setInterval(() => {
      const id = this.drainBubbleId
      const gone = id === null || !this.sMessages[0]().some((m) => m.id === id)
      if (gone || Date.now() - started > REVEAL_DRAIN_FAILSAFE_MS || this.reveal.contentSettled(id!, Date.now())) {
        flip()
      }
    }, 40)
    this.drainTimer.unref?.()
  }

  /**
   * Dynamic nearest-`AGENTS.md` attach (docs/agent.md "System prompt"). After a `read_file`
   * result, walk up from the read path for the closest `AGENTS.md` and append
   * its body as its own DURABLE user message. It is APPENDED — never folded
   * into the system prompt — because the system prompt must stay byte-stable
   * for the provider's prefix cache; a new message extends the prefix instead
   * of rewriting it (docs/agent.md "Prompt caching"). Each file is attached
   * once per session; reads are best-effort and never fatal.
   */
  private attachNearestInstructions(toolCalls: readonly CompletedToolCall[]): void {
    for (const call of toolCalls) {
      if (call.name !== "read_file") continue
      let nearest: string | null = null
      try {
        const args = parseToolArguments(call.arguments)
        const raw = String(args["path"] ?? "").trim()
        if (raw.length === 0) continue
        // Mirror the tool's own resolution so the ancestor walk starts where
        // the file was actually read from (pane cwd for relative paths).
        nearest = findNearestInstructionFile(resolveToolPath(raw, this.paneCwd()))
      } catch {
        continue
      }
      if (nearest === null || this.attachedInstructionFiles.has(nearest)) continue
      let body: string
      try {
        body = readFileSync(nearest, "utf8").trim()
      } catch {
        continue // best-effort: a later read of the same tree may succeed
      }
      if (body.length === 0) continue
      this.attachedInstructionFiles.add(nearest)
      this.providerHistory.push({
        role: "user",
        content: `Project instructions (from ${nearest}):\n${body}`,
      })
    }
  }

  /**
   * The gate decision for one call: the approval policy PLUS the
   * memory.writeApproval gate. Shared by the batch pre-evaluation and the
   * single-call executor so both always agree (docs/agent.md "Approval modes").
   *
   * This is THE single approval-enforcement point (IF1): every call —
   * interactive or socket-driven — routes through here before execution, so a
   * transport cannot bypass it. Public so the daemon can pre-flight a call's
   * decision without executing; destructive-floor and `deny` semantics are
   * unchanged.
   */
  gateDecision(call: CompletedToolCall, args: Record<string, unknown>): ApprovalDecision {
    // Read-only agent guard (docs/agents.md `readonly`): a hard, terminal deny
    // that runs BEFORE the permission/policy pipeline, so no allow-prefix,
    // session trust, `permission` allow or ApprovalPolicy can wave a mutation
    // through. The guard is enforced here — the single execution-layer gate —
    // not merely in the agent's prompt.
    if (this.agentDef().readonly === true) {
      const guardDenied = readonlyGuardDecision(call.name, args)
      if (guardDenied !== null) return guardDenied
    }
    let decision = approvalDecision(
      call.name,
      this.sApproval[0](),
      args,
      this.deps.getConfig().allowPrefixes,
      this.deps.getConfig().permission,
      this.book.trustPatterns(),
    )
    // memory.writeApproval additionally gates every mutating memory action in
    // full-auto (docs/memory.md); confirm mode already gates them. A `deny` is
    // terminal and outranks the gate.
    if (decision.action !== "deny" && isMemoryWrite(call.name, args) && this.deps.getConfig().memory.writeApproval) {
      decision = { gate: true, action: "ask" }
    }
    // Extensions approval policy (docs/extensions.md): the privileged seam.
    // Consulted AFTER the built-in decision, before any card renders. It may
    // override the gate, but the destructive floor is a hard invariant — an
    // `allow` can never un-gate a destructive call (same as a `permission`
    // allow). A terminal `deny` is never re-decided here. Never throws.
    const policy = this.deps.approvalPolicy?.() ?? null
    if (policy !== null && decision.action !== "deny") {
      const verdict = consultApprovalPolicy(policy, {
        tool: call.name,
        args,
        decision,
        mode: this.sApproval[0](),
        session: this.sessionId,
        agent: this.agentName(),
        cwd: this.paneCwd(),
        shell: this.deps.getConfig().shell,
      })
      if (verdict !== null) {
        if (verdict.action === "deny") {
          decision = {
            gate: true,
            destructive: decision.destructive,
            action: "deny",
            denySource: "policy",
            ...(verdict.reason !== undefined && verdict.reason.length > 0 ? { denyReason: verdict.reason } : {}),
          }
        } else if (verdict.action === "ask") {
          decision =
            decision.destructive === true
              ? { gate: true, destructive: true, action: "ask" }
              : { gate: true, action: "ask" }
        } else if (decision.destructive !== true) {
          decision = { gate: false, action: "allow", allowSource: "policy" }
        }
      }
    }
    return decision
  }

  // ---- extensions event sink (docs/extensions.md) --------------------------

  /**
   * Fire-and-forget emit. The sink is optional (absent = no events) and
   * contractually never throws; the extra try/catch is rule 10 insurance — an
   * audit event must never break the action it records.
   */
  private emit(event: SensusEvent): void {
    const sink = this.deps.eventSink?.()
    if (sink === undefined) return
    try {
      sink.emit(event)
    } catch (e) {
      // a failing sink is dropped silently
      log.error("event sink emit threw; engine event dropped", { type: event.type, err: e })
    }
  }

  /** The live facts stamped on every command event. */
  private eventContext(): { approval: ApprovalMode; agent: string; cwd: string | null; shell: string } {
    return {
      approval: this.sApproval[0](),
      agent: this.agentName(),
      cwd: this.paneCwd(),
      shell: this.deps.getConfig().shell,
    }
  }

  private emitApproved(call: CompletedToolCall, source: "auto" | "user" | "policy"): void {
    this.emit({
      type: "command-approved",
      ts: Date.now(),
      session: this.sessionId,
      tool: call.name,
      source,
      ...this.eventContext(),
    })
  }

  private emitDenied(call: CompletedToolCall, source: "permission" | "policy" | "guard" | "user" | "aborted", reason?: string): void {
    this.emit({
      type: "command-denied",
      ts: Date.now(),
      session: this.sessionId,
      tool: call.name,
      source,
      approval: this.sApproval[0](),
      agent: this.agentName(),
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    })
  }

  private emitRan(call: CompletedToolCall, ok: boolean, exitCode?: number | null): void {
    this.emit({
      type: "command-ran",
      ts: Date.now(),
      session: this.sessionId,
      tool: call.name,
      command: eventTarget(call.name, parseToolArguments(call.arguments)),
      ok,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...this.eventContext(),
    })
  }

  /**
   * One info record per EXECUTED tool call (docs/logging.md): the bounded
   * target, status, exit code and whether an abort cut it short. Never called
   * for a denied/blocked/interaction call, and never from `emitRan` itself —
   * one record per execution, no double-log.
   */
  private logToolExecuted(
    call: CompletedToolCall,
    args: Record<string, unknown>,
    exec: { ok: boolean; exitCode?: number | null; aborted: boolean; durationMs: number },
  ): void {
    log.info("tool executed", {
      session: this.sessionId,
      tool: call.name,
      target: eventTarget(call.name, args),
      ok: exec.ok,
      aborted: exec.aborted,
      ...(exec.exitCode !== undefined ? { exitCode: exec.exitCode } : {}),
      durationMs: exec.durationMs,
    })
  }

  private emitMemoryWrite(info: MemoryWriteInfo): void {
    this.emit({
      type: "memory-write",
      ts: Date.now(),
      session: this.sessionId,
      target: info.target,
      action: info.action,
      beforeChars: info.beforeChars,
      afterChars: info.afterChars,
      delta: info.delta,
      ok: true,
    })
  }

  /** A write/edit tool committed (or failed to commit) a file (docs/events.md). */
  private emitFileChange(tool: string, path: string, ok: boolean): void {
    this.emit({
      type: "file-change",
      ts: Date.now(),
      session: this.sessionId,
      tool,
      path,
      action: tool === "write_file" ? "write" : "edit",
      ok,
    })
  }

  /** A skill was loaded through the `skill_view` tool (docs/events.md). */
  private emitSkillUse(name: string): void {
    if (name.length === 0) return
    this.emit({ type: "skill-use", ts: Date.now(), session: this.sessionId, name, source: "tool" })
  }

  /** A provider/compaction/tool error surfaced (docs/events.md). */
  private emitErrorRaised(source: string, message: string, tool?: string): void {
    // Activity record (docs/logging.md): surfaced errors are filterable at
    // error level (`sensus daemon logs --level error`). The message is already
    // user-facing/bounded; the logger redacts known secret shapes.
    log.error("error raised", {
      session: this.sessionId,
      source,
      ...(tool !== undefined ? { tool } : {}),
      message,
    })
    this.emit({
      type: "error-raised",
      ts: Date.now(),
      session: this.sessionId,
      source,
      message,
      ...(tool !== undefined ? { tool } : {}),
    })
  }

  /**
   * One `turn-complete` per settled generation (idempotent by generation), plus
   * the matching `turn completed` info record (docs/logging.md). `reason`
   * explains an abort; `detail` distinguishes an error outcome. Both callers
   * (the generation finally and the early MCP-connect abort) go through here so
   * a turn is never double-logged.
   */
  private emitTurnComplete(
    outcome: "ok" | "aborted" | "error",
    reason?: string,
    detail?: { truncated: boolean; answerless: boolean; failed: boolean },
  ): void {
    if (this.turnStartedAt === 0) return
    const durationMs = Math.max(0, Date.now() - this.turnStartedAt)
    this.turnStartedAt = 0
    const model = this.modelName()
    log.info("turn completed", {
      session: this.sessionId,
      model,
      outcome,
      durationMs,
      ...(reason !== undefined ? { reason } : {}),
      ...(detail !== undefined ? detail : {}),
    })
    this.emit({
      type: "turn-complete",
      ts: Date.now(),
      session: this.sessionId,
      durationMs,
      outcome,
      model,
      ...(reason !== undefined ? { reason } : {}),
    })
  }

  /**
   * Release this session (docs/extensions.md): emit `session-end` once. The
   * daemon calls this when it drops a chat / shuts down; there is no per-tab
   * close path in v1 (a chat survives client detach, D4). Never throws.
   */
  endSession(reason = "closed"): void {
    try {
      this.emit({ type: "session-end", ts: Date.now(), session: this.sessionId, reason })
    } catch {
      // an audit event must never break teardown
    }
  }

  /** Plan an edit_file/write_file call WITHOUT writing (the diff the user
   * reviews). Shared by the single card and the batch plan. */
  private planFileWrite(
    call: CompletedToolCall,
    args: Record<string, unknown>,
  ): { plan: FilePlan | null; error: string | null } {
    if (call.name !== "edit_file" && call.name !== "write_file") return { plan: null, error: null }
    const res = call.name === "edit_file" ? planEditFile(args, this.paneCwd()) : planWriteFile(args, this.paneCwd())
    return res.ok ? { plan: res.plan, error: null } : { plan: null, error: res.error }
  }

  /**
   * Pre-evaluate a turn's tool calls and, when ≥2 of them would gate, present
   * ONE approval plan the user approves as a task (docs/agent.md
   * "Approval-batch plan card"). Returns the per-call decisions map, or null
   * when there is no batch (0/1 gated calls — the single-card path runs
   * unchanged). Nothing executes until the whole batch is decided.
   *
   * Batch membership: calls whose gate comes from the baseline/policy
   * (`decision.gate`), EXCLUDING `ask_user` (it blocks inline) and a terminal
   * `deny` (policy decides, no card).
   */
  private async resolveApprovalBatch(
    toolCalls: readonly CompletedToolCall[],
    signal: AbortSignal,
  ): Promise<Map<string, "accept" | "reject"> | null> {
    const members: Array<{ call: CompletedToolCall; args: Record<string, unknown>; decision: ApprovalDecision; plan: FilePlan | null }> = []
    for (const call of toolCalls) {
      if (call.name === "ask_user") continue
      const args = parseToolArguments(call.arguments)
      const decision = this.gateDecision(call, args)
      if (decision.action === "deny" || !decision.gate) continue
      members.push({ call, args, decision, plan: this.planFileWrite(call, args).plan })
    }
    if (members.length < 2) return null

    const lines: PlanLine[] = members.map(({ call, args, decision, plan }) => {
      const trust = decision.action === undefined ? trustPatternFor(call.name, args) : null
      return {
        callId: call.id,
        name: call.name,
        paramsSummary: toolParamsSummary(call.name, args),
        detail: toolApprovalDetail(call.name, args),
        destructive: decision.destructive === true,
        allowPrefix: trust?.prefix ?? null,
        diff: plan?.diff ?? null,
        ...(plan !== null ? { created: call.name === "write_file" && !plan.existed } : {}),
        // A destructive line is NEVER pre-approved: it requires an explicit
        // per-line decision (or it is rejected at commit).
        status: decision.destructive === true ? "pending" : "approved",
      }
    })
    const msg = this.pushMessage({ role: "tool", content: "", local: true, plan: { lines, cursor: 0 } })
    const resolution = await this.book.awaitPlan(String(msg.id), signal)
    const decisions = "decisions" in resolution ? resolution.decisions : null
    if (this.generationRewound) return null
    this.finalizePlan(msg, decisions)
    return decisions
  }

  /** Freeze a plan card once committed/aborted: lines show their final
   * decision and the interactive controls are replaced by the outcome. */
  private finalizePlan(msg: ChatMessage, decisions: Map<string, "accept" | "reject"> | null): void {
    const plan = msg.plan
    if (!plan) return
    if (decisions === null) {
      this.patchMessage(msg.id, { plan: { ...plan, resolved: true, outcome: "aborted" } })
      return
    }
    const lines = plan.lines.map((l) => {
      const d = decisions.get(l.callId)
      return d === undefined ? l : { ...l, status: (d === "accept" ? "approved" : "rejected") as PlanLineStatus }
    })
    this.patchMessage(msg.id, { plan: { ...plan, lines, resolved: true, outcome: "committed" } })
  }

  /**
   * Execute ONE tool call: card (with the diff for file writes, so the user
   * reviews before approving) -> approval gate (when required) -> execute ->
   * card updates. Returns the model-facing tool result text.
   *
   * `preset` is the pre-collected batch decision (docs/agent.md
   * "Approval-batch plan card"): present only for a call that was approved as
   * part of a plan, so it renders its final card WITHOUT a separate pending
   * wait. Absent on the unchanged single-card path.
   */
  private async runToolCall(
    call: CompletedToolCall,
    signal: AbortSignal,
    preset?: "accept" | "reject",
  ): Promise<string> {
    const args = parseToolArguments(call.arguments)
    const decision = this.gateDecision(call, args)

    // Rule-based permission `deny` (docs/config.md "permission") or an
    // extensions policy `deny` (docs/extensions.md): terminal — never render a
    // pending card, never execute, tell the model why.
    if (decision.action === "deny") {
      const source = decision.denySource ?? "permission"
      const reason = decision.denyReason
      const reasonSuffix = reason !== undefined && reason.length > 0 ? ` — ${reason}` : ""
      const msg =
        source === "policy"
          ? `Denied by approval policy: ${call.name}${reasonSuffix}`
          : source === "guard"
            ? `Denied: ${reason !== undefined && reason.length > 0 ? reason : `read-only agent may not run ${call.name}`}`
            : `Denied by permission policy: ${call.name}`
      this.book.pushToolCard(call, { status: "error", output: msg })
      this.book.appendToolEvent(call, "error", msg, null, msg)
      this.emitDenied(call, source, reason)
      return msg
    }

    // Doom-loop guard (docs/agent.md "Approval modes"): the
    // (DOOM_LOOP_THRESHOLD+1)th CONSECUTIVE identical call in this generation
    // is blocked with a warn card + toast instead of executing.
    const signature = `${call.name}:${JSON.stringify(args)}`
    if (signature === this.doomLoopSignature) this.doomLoopCount++
    else {
      this.doomLoopSignature = signature
      this.doomLoopCount = 1
    }
    if (this.doomLoopCount > DOOM_LOOP_THRESHOLD) {
      const msg = `Repeated identical tool call detected — \`${call.name}\` with the same arguments ran ${DOOM_LOOP_THRESHOLD} times consecutively. Stop repeating it; change approach or ask the user.`
      this.book.pushToolCard(call, { status: "error", output: msg })
      this.book.appendToolEvent(call, "error", msg, null, msg)
      this.deps.toast("doom loop guard: repeated identical tool call blocked", "warn", 4500)
      return msg
    }

    // ask_user blocks the loop until the user answers (docs/agent.md).
    if (call.name === "ask_user") {
      const question = String(args["question"] ?? "(no question)")
      const rawOpts = args["options"]
      const options = Array.isArray(rawOpts) ? rawOpts.map((o) => String(o)) : null
      this.book.pushToolCard(call, { status: "running", question, options, output: null })
      this.book.appendToolEvent(call, "running", null)
      const answer = await this.book.awaitAsk(call.id, signal)
      if (answer === null) {
        this.book.updateCard(call, "aborted", null, { output: "aborted" })
        return "(aborted by user)"
      }
      this.book.updateCard(call, "done", answer, { answer }, null, `user answered: ${answer}`)
      return `user answered: ${answer}`
    }

    // File writes are PLANNED up front (no write happens) so the pending
    // card already shows the diff the user is approving.
    const isFileWrite = call.name === "edit_file" || call.name === "write_file"
    const planned = this.planFileWrite(call, args)
    const plan = planned.plan
    const planError = planned.error

    // Every tool call renders a card (docs/agent.md loop #4). Gated calls
    // start "pending"; auto-approved ones go straight to execution.
    // Session trust is only OFFERED when the gate came from the baseline (no
    // `permission` rule decided the call) — a config `ask` rule must keep
    // forcing its own card.
    const trust = decision.action === undefined ? trustPatternFor(call.name, args) : null
    const cardBase = {
      destructive: decision.destructive === true,
      allowPrefix: trust?.prefix ?? null,
      diff: plan?.diff ?? null,
      ...(isFileWrite && plan !== null ? { created: call.name === "write_file" && !plan.existed } : {}),
    }

    if (preset === "reject") {
      // Batch-rejected: render the final rejected card directly (no pending
      // wait) — the plan already collected the decision.
      this.book.pushToolCard(call, { ...cardBase, status: "rejected", output: "rejected by user" })
      this.book.appendToolEvent(call, "rejected", null)
      this.emitDenied(call, "user")
      return "User rejected"
    }
    if (preset === "accept") {
      // Batch-approved: card goes straight to approved; the plan was the gate.
      this.book.pushToolCard(call, { ...cardBase, destructive: undefined, status: "approved" })
      this.book.appendToolEvent(call, "approved", null)
      this.emitApproved(call, "user")
    } else {
      this.book.pushToolCard(call, { ...cardBase, status: decision.gate ? "pending" : "approved" })
      if (decision.gate) {
        this.book.appendToolEvent(call, "pending", null)
        // Transport-agnostic approval request (IF3): a socket transport routes
        // its answer back through resolveCard, which this wait observes.
        this.emitChat({
          kind: "approval-request",
          callId: call.id,
          tool: call.name,
          args,
          command: typeof args["command"] === "string" ? args["command"] : null,
          destructive: decision.destructive === true,
        })
        const resolution = await this.book.awaitApproval(call.id, signal)
        this.emitChat({
          kind: "approval-resolved",
          callId: call.id,
          action: resolution === "aborted" ? "aborted" : resolution === "reject" ? "reject" : "accept",
        })
        if (resolution === "aborted") {
          this.book.updateCard(call, "aborted", null, { output: "aborted before running" })
          this.emitDenied(call, "aborted")
          return "(aborted by user — not run)"
        }
        if (resolution === "reject") {
          this.book.updateCard(call, "rejected", null, { output: "rejected by user" })
          this.emitDenied(call, "user")
          return "User rejected"
        }
        this.patchToolCard(call.id, { status: "approved", destructive: undefined })
        this.emitApproved(call, "user")
      } else {
        this.emitApproved(call, decision.allowSource === "policy" ? "policy" : "auto")
      }
    }

    // Execute. File writes use the plan computed above.
    if (isFileWrite) {
      if (plan === null || planError !== null) {
        const msg = planError ?? "file plan failed"
        this.book.updateCard(call, "error", msg, {}, null, msg)
        return msg
      }
      this.patchToolCard(call.id, { status: "running", diff: plan.diff })
      const startedAt = Date.now()
      try {
        const before = plan.existed ? safeRead(plan.path) : null
        const applied = applyFilePlan(plan)
        this.deps.audit?.record({
          ts: Date.now(),
          kind: "file",
          tool: call.name,
          summary: plan.path,
          ok: true,
          path: plan.path,
          before,
        })
        this.emitRan(call, true)
        this.logToolExecuted(call, args, { ok: true, aborted: false, durationMs: Date.now() - startedAt })
        this.emitFileChange(call.name, plan.path, true)
        this.book.updateCard(call, "done", applied, {}, null, applied)
        return applied
      } catch (e) {
        const msg = `${call.name}: write failed (${errorMessage(e)})`
        this.book.updateCard(call, "error", msg, {}, null, msg)
        this.emitRan(call, false)
        this.logToolExecuted(call, args, { ok: false, aborted: false, durationMs: Date.now() - startedAt })
        this.emitFileChange(call.name, plan.path, false)
        return msg
      }
    }

    this.patchToolCard(call.id, { status: "running" })
    const startedAt = Date.now()
    const exec = await executeTool(call.name, args, {
      pane: this.terminalSnapshot()?.pane ?? null,
      paneCwd: this.paneCwd(),
      jobScope: this.jobScope,
      signal,
      // The `reload` tool applies config/AGENTS.md/agents/skills/MCP edits
      // in-process (the /reload action) instead of typing /reload into the pane.
      reloadConfig: this.deps.reloadConfig,
      mcp: this.deps.mcp && this.sMcpEnabled[0]() ? this.deps.mcp : undefined,
      // Sudo popup (docs/agent.md "Sudo"): `shell_background` gets the
      // interactive popup per posture (`popup` full-auto, `ask` confirm);
      // `shell_session` gets it for any non-`ask` agent (copilot is `auto`)
      // because typing a bare `sudo` into the visible pane leaves a prompt the
      // model tries to retry around. `ask` agents receive guidance to hand the
      // command to the user instead. A password already cached in RAM is reused
      // in ANY posture for either tool (the seam resolves it from the vault
      // without showing UI), so one entry covers every later sudo this session.
      requestSudo: this.sudoSeamFor(call.name)
        ? (command, hint) => this.requestSudoWithEvents(command, hint, signal)
        : undefined,
      onSudoRejected:
        call.name === "shell_background" || call.name === "shell_session" ? this.deps.clearSudoPassword : undefined,
      hasSudoPassword:
        call.name === "shell_background" || call.name === "shell_session" ? this.deps.hasSudoPassword : undefined,
      memory: this.deps.getConfig().memory.enabled ? this.deps.memory : undefined,
      sessionSearch: this.deps.sessionSearch,
      skills: this.skillCatalogForAgent(),
      toolOutput: this.deps.getConfig().toolOutput,
      toolOutputDir: toolOutputDir(sensusStateDir()),
    })
    if (exec.images !== undefined && exec.images.length > 0) this.pendingToolImages.set(call.id, exec.images)
    this.deps.audit?.record({
      ts: Date.now(),
      kind: call.name === "memory" ? "memory" : call.name === "shell_background" ? "shell" : "other",
      tool: call.name,
      summary:
        call.name === "memory"
          ? `${String(args["action"] ?? "")} ${String(args["target"] ?? "")}`.trim()
          : String(args["command"] ?? args["query"] ?? "").replace(/\s+/g, " ").slice(0, 120),
      ok: exec.ok,
    })
    this.emitRan(call, exec.ok, exec.exitCode)
    const aborted = signal.aborted
    // Activity record (docs/logging.md): one per executed call. The target is
    // the same bounded `command-ran` projection (never stdin/sudo secrets).
    this.logToolExecuted(call, args, {
      ok: exec.ok,
      exitCode: exec.exitCode,
      aborted,
      durationMs: Date.now() - startedAt,
    })
    if (exec.memoryWrite !== undefined) this.emitMemoryWrite(exec.memoryWrite)
    // v1 skill usage (docs/events.md): the skill body was actually read.
    if (call.name === "skill_view" && exec.ok) this.emitSkillUse(String(args["name"] ?? "").trim())
    // v1 raised error (docs/events.md): a genuine tool failure, NOT a shell
    // command's non-zero exit (that is a normal `tool.executed` result).
    if (!exec.ok && !aborted && call.name !== "shell_background" && call.name !== "shell_session") {
      this.emitErrorRaised("tool", exec.preview.length > 0 ? exec.preview : exec.result, call.name)
    }
    this.book.updateCard(
      call,
      aborted ? "aborted" : exec.ok ? "done" : "error",
      aborted ? null : exec.preview,
      { output: aborted ? "aborted by user" : exec.preview, exitCode: exec.exitCode },
      exec.exitCode,
      aborted ? null : exec.result,
    )
    return exec.result
  }
}

/**
 * Bounded primary-target string for a `command-ran` event (docs/extensions.md):
 * the shell command, file path, or query, collapsed to one line and capped.
 */
function eventTarget(name: string, args: Record<string, unknown>): string {
  if (name === "memory") return `${String(args["action"] ?? "")} ${String(args["target"] ?? "")}`.trim()
  return String(args["command"] ?? args["path"] ?? args["query"] ?? "")
    .replace(/\s+/g, " ")
    .slice(0, EVENT_TARGET_MAX)
}

/**
 * Push the resolved `chat.*` display settings into a live session's signals
 * (docs/config.md "chat"): card style, thinking mode, tool-output details and
 * animations. `ChatSession` seeds these once in its constructor, so after a
 * config change an already-rendered bubble would otherwise keep its old look
 * until the app restarts. Settings saves and `/reload` call this for EVERY open
 * tab (App owns the tab list). Session-scoped overrides (`/cards`, `/thinking`,
 * `/details`) are intentionally re-seeded: the documented contract is that
 * config is re-read at session start / `/reload`. `maxToolTurns` / `busySend`
 * are read from config live per send and have no session signal.
 */
export function applyChatDisplayConfig(
  chat: Pick<ChatSession, "setThinkingMode" | "setToolDetails" | "setCardStyle" | "setAnimations">,
  chatConfig: Pick<ChatDisplayConfig, "thinking" | "toolOutput" | "animations" | "cardStyle">,
): void {
  chat.setThinkingMode(chatConfig.thinking)
  chat.setToolDetails(chatConfig.toolOutput)
  chat.setCardStyle(chatConfig.cardStyle)
  chat.setAnimations(chatConfig.animations)
}