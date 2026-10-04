/**
 * ChatRegistry — the daemon's owned agent chats (P3c-ii; docs/daemon-api.md
 * "WebSocket channels", docs/agent.md "Remote approval & event stream").
 *
 * The daemon hosts one `ChatHost` (data dir, instance id, config, providers) and
 * creates a `ChatSession` per opened chat through it — one tab = one shell = one
 * chat. The registry mirrors each session's transport-agnostic `ChatEvent`
 * stream (IF3) to its subscribers, tracks the pending sudo prompt, and answers
 * approvals/sudo through the engine's own seams:
 *
 *  - `approvals.answer` → `ChatSession.resolveCard` (the engine's single gate,
 *    destructive floor and `ApprovalPolicy` semantics intact).
 *  - `sudo.answer` → the promise returned by the registry's `requestSudo`, which
 *    the engine calls while a tool needs a password (the same dep the TUI's
 *    popup implements).
 *
 * A chat survives client detach (D4): `ChatRegistry` keeps it until the daemon
 * stops; `chat.open` with `resume` reopens a transcript from disk.
 *
 * Every method is defensive: a bad id or a throwing listener becomes an error
 * result or a dropped event, never an exception (AGENTS.md rule 10).
 */

import { errorMessage } from "../core/util.ts"
import {
  configPath,
  parseSelectedModel,
  recordsToMessages,
  reconstructHistoryEntries,
  loadSessionFile,
  type AgentPane,
  type AgentDef,
  type ApprovalMode,
  type ChatEvent,
  type ChatHost,
  type ChatMessage,
  type ChatSession,
  type ChatStatus,
  type ContextBreakdown,
  type McpServerStatusFact,
  type ModelMeta,
  type PlanCardData,
  type TerminalSnapshotForChat,
  type TerminalStatus,
  type ToolCardData,
  type TrustPattern,
} from "../engine/index.ts"
import { readRawConfig } from "../config/configFile.ts"
import type { Logger } from "../core/log.ts"
import { componentLogger } from "./log.ts"
import { logStrictEnabled } from "./logStrict.ts"
import { redactConfig } from "./config.ts"
import type { ShellContextSource } from "./shells.ts"

/** Module-level child logger for the chat registry (component `daemon.chats`). */
const log: Logger = componentLogger("daemon.chats")

/** A chat event tagged with the chat it belongs to (the WS translation input).
 * A `meta`-only change (P4c-ii) carries `event: null` and the fresh `meta`; a
 * regular engine event may additionally carry the changed `meta`. */
export type DaemonChatEvent =
  | { chatId: string; event: ChatEvent; meta?: ChatMeta }
  | { chatId: string; event: null; meta: ChatMeta }

/** An engine `ChatHost.toast` relayed to clients (the daemon has no UI). */
export interface DaemonToast {
  message: string
  level?: string
  ttlMs?: number
}

/** How `ChatSession.handleInput` routed a line (the frozen `chat.send` mode,
 * P4a gap 2). Mirrors the engine's own return union exactly. */
export type ChatSendMode = "sent" | "empty" | "busy" | "steered" | "queued"

/** The frozen `chat.send` result: `accepted` is true for the modes that
 * actually took the input (`sent`/`steered`/`queued`), false for
 * `empty`/`busy`. A type alias (not an interface) so it stays assignable to the
 * WS envelope's `Record<string, unknown>` result. */
export type ChatSendResult = {
  accepted: boolean
  mode: ChatSendMode
}

/**
 * The engine-derived readouts a remote chat renders (P4c-ii; D13). Everything
 * here is derived in the daemon from the live `ChatSession` — a remote client
 * needs no in-process engine. Local display preferences (animations, card
 * style, thinking details, drafts, editor/slash state) are client-owned and
 * deliberately ABSENT.
 *
 * The object is a superset: it carries `chat.state`'s `status` peer readouts
 * plus the status-bar / context-inspector / picker inputs. It is stable: fields
 * are only added, never renamed or removed.
 */
export interface ChatMeta {
  /** The model pick in `endpoint@model` form (session override → config). */
  selectedModel: string
  /** The selected endpoint's name. */
  endpointName: string
  /** The model id for the next request. */
  modelName: string
  /** The endpoint's effective config with `apiKey` redacted (D13). */
  endpoint: Record<string, unknown> | null
  /** An API key (or the mock seam) is present — chat is usable. */
  hasKey: boolean
  /** Resolved model metadata (endpoint override → models.dev), or null. */
  modelMeta: ModelMeta | null
  /** The model accepts image input (metadata; unknown = false). */
  modelSupportsVision: boolean
  /** Effective thinking mode (`/effort` → endpoint thinkingMode → "default"). */
  effortSetting: string
  /** Effective context ceiling in tokens (pin → metadata, capped by the
   * model's input limit when advertised → 128k). */
  contextLimit: number
  /** Last reported prompt tokens (the status-bar `used`). */
  contextUsed: number
  /** Last reported cached prompt tokens (0 when unreported). */
  cacheRead: number
  /** The full serializable context snapshot (context inspector). */
  contextBreakdown: ContextBreakdown
  /** The active agent's selection name. */
  agentName: string
  /** The active agent's full definition (picker / gating). */
  agentDef: AgentDef
  /** The approval mode (`confirm` | `full-auto`). */
  approval: ApprovalMode
  /** Session-scoped trust patterns (status-bar chip). */
  trustPatterns: TrustPattern[]
  /** `no-tools` degradation is latched. */
  noTools: boolean
  /** Mid-work: streaming, compacting, or blocked on a prompt. */
  isWorking: boolean
  /** A compaction is in progress. */
  compacting: boolean
  /** Live background jobs started by this session. */
  activeJobCount: number
  /** Epoch ms the current generation started (0 when idle). */
  streamingSince: number
  /** Pending steer/queue counts while a turn streams. */
  busyPending: { steer: number; queue: number }
  /** The session `/mcp on|off` switch. */
  mcpEnabled: boolean
  /** Per-server MCP status facts (status bar / manager). */
  mcpStatusFacts: McpServerStatusFact[]
  /** Tab/session display title ("" = none yet). */
  sessionTitle: string
  /** Absolute transcript path (delete-guard for the sessions overlay). */
  sessionFilePath: string | null
}

/** One chat as `chat.list` reports it. */
export interface ChatListEntry {
  chatId: string
  shellId: string | null
  /** Live tab title (sidecar/auto title, else the first-message placeholder). */
  title: string
  status: ChatStatus
  /** No chat messages yet — an unsent tab, not worth offering for re-attach.
   * The boot picker skips these (docs/daemon-api.md "Lifecycle"). */
  empty: boolean
  /** Epoch ms the bound shell last lost its last client (or was created), or
   * null when unknown / currently attached. The boot picker age-gates re-attach
   * on this; the idle reaper uses the same clock (docs/daemon-api.md
   * "Lifecycle"). */
  lastDetachedAt: number | null
}

/** The pending sudo prompt the engine is blocked on, if any. */
export interface ChatPendingSudo {
  requestId: string
  command: string
  prompt: string
}

/** Full snapshot returned by `chat.open` / `chat.attach`. */
export interface ChatState {
  messages: ChatMessage[]
  status: ChatStatus
  plan: PlanCardData | null
  pendingApproval: ToolCardData | null
  pendingSudo: ChatPendingSudo | null
  /** Engine-derived readouts (P4c-ii); null when derivation failed. */
  meta: ChatMeta | null
}

/** A registry operation: a value or a stable error code. */
export type ChatOpResult<T> = { ok: true; result: T } | { ok: false; error: string }

export interface ChatOpenOptions {
  /** Bind the chat to a shell (one tab = one shell = one chat). Rejected with
   * `shell_taken` when another live chat owns it. */
  shellId?: string
  /** Session agent override (applies to this chat only). */
  agent?: string
  /** Session model override (`<endpoint>@<model>` or a bare model id). */
  model?: string
  /** Absolute path of a saved transcript to resume. */
  resume?: string
}

export interface ChatAnswerApprovalOptions {
  chatId: string
  callId: string
  action: "accept" | "reject"
  /** Trust intent: answer with the engine's `allow` (the card's own operation
   * class). The engine chooses the class; an arbitrary client prefix is never
   * trusted (a compound line is never trustable — docs/agent.md). */
  addPrefix?: string
  addToSession?: boolean
  trust?: boolean
}

export interface ChatRegistryOptions {
  /** The shared engine host (data dir, config, providers, sessions). A factory
   * defers construction until the first chat op, so a terminal-only daemon
   * never touches the config home. */
  host: ChatHost | (() => ChatHost)
  /** The daemon's shells, so a chat bound to a `shellId` gets terminal context
   * (P4a gap 3): client facts first, scanner ring as the no-client fallback. */
  shells?: ShellContextSource
  /** Test seam: clock for chat ids. */
  now?: () => number
}

interface ChatRecord {
  id: string
  chat: ChatSession
  shellId: string | null
  unsubscribe: () => void
  pendingSudo: ChatPendingSudo | null
}

export class ChatRegistry {
  private readonly records = new Map<string, ChatRecord>()
  private readonly listeners = new Set<(e: DaemonChatEvent) => void>()
  private readonly toastListeners = new Set<(t: DaemonToast) => void>()
  /** Pending `requestSudo` promises by engine-generated request id. */
  private readonly sudoResolvers = new Map<string, (password: string | null) => void>()
  /** Last emitted meta signature per chat, so `chat.meta` fires on change only. */
  private readonly lastMetaSig = new Map<string, string>()
  private idCounter = 0
  private tabCounter = 0
  private closed = false
  private hostCache: ChatHost | null = null

  constructor(private readonly opts: ChatRegistryOptions) {}

  /** The shared ChatHost, built lazily on first use. */
  private getHost(): ChatHost {
    if (this.hostCache !== null) return this.hostCache
    const host = typeof this.opts.host === "function" ? this.opts.host() : this.opts.host
    this.hostCache = host
    return host
  }

  /** Subscribe to the tagged chat event stream. Returns an unsubscribe fn. */
  subscribe(listener: (e: DaemonChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Subscribe to relayed engine toasts (WS `chat.toast`). Returns unsubscribe. */
  onToast(listener: (t: DaemonToast) => void): () => void {
    this.toastListeners.add(listener)
    return () => {
      this.toastListeners.delete(listener)
    }
  }

  /** Relay one engine toast to every client (global; the daemon has no UI). */
  notifyToast(message: string, level?: string, ttlMs?: number): void {
    if (message.length === 0) return
    for (const listener of [...this.toastListeners]) {
      try {
        listener({ message, ...(level !== undefined ? { level } : {}), ...(ttlMs !== undefined ? { ttlMs } : {}) })
      } catch (err) {
        // a toast listener must never break the engine
        log.warn("toast listener failed", { err })
      }
    }
  }

  private emit(e: DaemonChatEvent): void {
    if (this.listeners.size === 0) return
    for (const listener of [...this.listeners]) {
      try {
        listener(e)
      } catch (err) {
        // An observer failure must never break the chat it observes.
        log.warn("chat event listener failed", { err, chatId: e.chatId })
      }
    }
  }

  /** The sudo seam handed to `ChatHost`: registers a promise per request id. */
  requestSudo = (command: string, hint?: string, requestId?: string): Promise<string | null> => {
    if (requestId === undefined || requestId.length === 0) return Promise.resolve(null)
    return new Promise<string | null>((resolve) => {
      this.sudoResolvers.set(requestId, resolve)
    })
  }

  /**
   * Open a chat (optionally bound to a shell / resumed). The engine's
   * `ChatHost` builds the tab session; the registry subscribes to its events.
   */
  open(opts: ChatOpenOptions = {}): ChatOpResult<{ chatId: string; state: ChatState }> {
    if (this.closed) return { ok: false, error: "registry_closed" }
    if (opts.shellId !== undefined && opts.shellId.length > 0) {
      for (const record of this.records.values()) {
        if (record.shellId === opts.shellId) return { ok: false, error: "shell_taken" }
      }
    }

    const chatId = this.newChatId()
    const tabIndex = ++this.tabCounter
    let chat: ChatSession
    try {
      chat = this.getHost().createTabChat(tabIndex, opts.resume)
    } catch (e) {
      return { ok: false, error: `chat_open_failed: ${errorMessage(e)}` }
    }

    if (opts.agent !== undefined && opts.agent.length > 0) {
      try {
        chat.setAgentSelection(opts.agent)
      } catch {
        // best-effort session override
      }
    }
    if (opts.model !== undefined && opts.model.length > 0) {
      try {
        const parsed = parseSelectedModel(opts.model)
        if (parsed !== null) chat.setModelSelection(parsed.endpoint, parsed.model)
        else chat.setModelSelection(chat.endpointName(), opts.model)
      } catch {
        // best-effort session override
      }
    }

    const record: ChatRecord = {
      id: chatId,
      chat,
      shellId: opts.shellId !== undefined && opts.shellId.length > 0 ? opts.shellId : null,
      unsubscribe: () => {},
      pendingSudo: null,
    }

    if (opts.resume !== undefined && opts.resume.length > 0) {
      try {
        const loaded = loadSessionFile(opts.resume)
        chat.restore(recordsToMessages(loaded.messages), {
          checkpoint: loaded.checkpoint,
          checkpointIndex: loaded.checkpointIndex,
          history: reconstructHistoryEntries(loaded),
        })
        chat.setSessionTitle(loaded.title)
      } catch (e) {
        return { ok: false, error: `resume_failed: ${errorMessage(e)}` }
      }
    }

    record.unsubscribe = chat.subscribe((event) => this.handleChatEvent(record, event))
    this.records.set(chatId, record)
    this.attachShellContext(record)
    return { ok: true, result: { chatId, state: this.stateOf(record) } }
  }

  /** Every live chat (newest first). */
  list(): ChatListEntry[] {
    return [...this.records.values()].reverse().map((record) => ({
      chatId: record.id,
      shellId: record.shellId,
      title: record.chat.accessors.sessionTitle(),
      status: record.chat.accessors.status(),
      empty: this.isEmpty(record),
      lastDetachedAt:
        record.shellId === null ? null : (this.opts.shells?.lastDetachedAtOf?.(record.shellId) ?? null),
    }))
  }

  /**
   * Release every chat bound to a shell that has EXITED (a pane `exit`/kill, not
   * a client detach): one tab = one shell = one chat, so a dead shell's chat can
   * never be re-attached and must not linger. Any in-flight turn is aborted
   * first so a dropped session cannot keep generating invisibly. Never throws.
   */
  closeForShell(shellId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.shellId !== shellId) continue
      this.resolvePendingSudo(record, null)
      try {
        record.chat.abort()
      } catch (err) {
        // best-effort: a refused abort still lets the record drop
        log.warn("abort on shell close failed", { err, chatId: record.id, shellId })
      }
      this.drop(record)
    }
  }

  /** True when a chat has no messages yet (an unsent tab). */
  private isEmpty(record: ChatRecord): boolean {
    try {
      return record.chat.accessors.messages().length === 0
    } catch (e) {
      log.debug("empty-chat check failed", { err: e, chatId: record.id })
      return false
    }
  }

  /** Live per-server MCP facts (P4c-ii `/v1/mcp`); [] until a host exists. */
  mcpStatus(): McpServerStatusFact[] {
    if (this.hostCache === null) return []
    try {
      return this.hostCache.mcp.serverStatuses()
    } catch (e) {
      log.debug("mcp serverStatuses read failed", { err: e })
      return []
    }
  }

  /** Saved-session Context Inspector snapshot (P4e); null when unavailable. */
  sessionContextBreakdown(path: string): { title: string; breakdown: ContextBreakdown } | null {
    try {
      return this.getHost().sessionContextBreakdown(path)
    } catch (e) {
      log.warn("session context breakdown failed", { err: e, path })
      return null
    }
  }

  /** Re-read config on the shared host after a write (P4c-ii settings). */
  reloadConfig(kind: "internal" | "user" | "settings" = "settings"): string | null {
    let message: string | null = null
    try {
      message = this.getHost().reload(kind)
    } catch (err) {
      message = null
      log.error("config reload failed", { err, kind })
      // STRICT rethrow (#4): the daemon's only caller runs on the
      // `PUT /v1/config` path inside the settings route's try/catch (→ 500),
      // with Elysia's `onError` as the outer fallback.
      if (logStrictEnabled()) throw err
    }
    // A config write can change the engine-derived readouts (MCP facts, model,
    // context) — push a fresh `chat.meta` so remote clients re-render them.
    for (const record of this.records.values()) this.emitMeta(record)
    return message
  }

  /** The full state of one chat. */
  attach(chatId: string): ChatOpResult<{ chatId: string; state: ChatState }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    return { ok: true, result: { chatId, state: this.stateOf(record) } }
  }

  /** Route a line into the chat (slash commands included). The engine's own
   * `handleInput` return is the frozen `mode` (P4a gap 2). `images` are the
   * client-owned draft attachments (base64), staged on the engine composer
   * immediately before the send. */
  send(
    chatId: string,
    text: string,
    images: ReadonlyArray<{ name: string; mediaType: string; data: string }> = [],
  ): ChatOpResult<ChatSendResult> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    for (const img of images) {
      if (img.data.length === 0) continue
      try {
        const res = record.chat.addDraftImage(new Uint8Array(Buffer.from(img.data, "base64")), img.name, img.mediaType)
        if (!res.ok) return { ok: false, error: `image_rejected: ${res.error}` }
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
    }
    let mode: ChatSendMode
    try {
      mode = record.chat.handleInput(text)
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
    const accepted = mode === "sent" || mode === "steered" || mode === "queued"
    this.emitMeta(record)
    return { ok: true, result: { accepted, mode } }
  }

  /** Abort the generation (Esc); any pending sudo prompt resolves declined. */
  abort(chatId: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    this.resolvePendingSudo(record, null)
    try {
      record.chat.abort()
    } catch (e) {
      // best-effort
      log.debug("chat abort failed", { err: e, chatId })
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Manual compaction (the engine's `/compact` path). */
  compact(chatId: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.handleInput("/compact")
    } catch (e) {
      // the engine toasts a busy/refused state; the op itself is idempotent
      log.debug("chat compact input failed", { err: e, chatId })
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Retry the last message (the engine's `/retry` path). */
  retry(chatId: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.handleInput("/retry")
    } catch (e) {
      // the engine toasts when there is nothing to retry
      log.debug("chat retry input failed", { err: e, chatId })
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  // -- remote chat controls (P4c-iii; thin engine wrappers) -------------------

  /** Session model pick (`endpoint@model` or a bare model id). */
  setModel(chatId: string, model: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    if (model.length === 0) return { ok: false, error: "invalid_request" }
    try {
      const parsed = parseSelectedModel(model)
      if (parsed !== null) record.chat.setModelSelection(parsed.endpoint, parsed.model)
      else record.chat.setModelSelection(record.chat.endpointName(), model)
    } catch (e) {
      log.debug("setModel failed", { err: e, chatId, model })
      return { ok: false, error: "invalid_request" }
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Session agent pick (applies to THIS chat only). */
  setAgent(chatId: string, agent: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.setAgentSelection(agent)
    } catch (e) {
      log.debug("setAgent failed", { err: e, chatId, agent })
      return { ok: false, error: "invalid_request" }
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Session thinking-mode override (`/effort`). */
  setEffort(chatId: string, mode: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.setEffortOverride(mode)
    } catch (e) {
      log.debug("setEffort failed", { err: e, chatId, mode })
      return { ok: false, error: "invalid_request" }
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Cycle the session thinking mode (the status-bar chip). */
  cycleEffort(chatId: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.cycleEffort()
    } catch (e) {
      log.debug("cycleEffort failed", { err: e, chatId })
      return { ok: false, error: "invalid_request" }
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /**
   * Rewind the conversation to just before a user message (the UI `↺ revert`).
   * The engine truncates + reloads the draft; a `reset` event re-pushes the
   * full state so attached clients drop the discarded messages.
   */
  revert(chatId: string, messageId: number): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    let rewound = false
    try {
      rewound = record.chat.revertToUserMessage(messageId)
    } catch (e) {
      rewound = false
      log.debug("revertToUserMessage failed", { err: e, chatId, messageId })
    }
    if (!rewound) return { ok: false, error: "not_revertible" }
    this.emit({ chatId, event: { kind: "reset", messages: [...record.chat.accessors.messages()] } })
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Approval mode switch (`confirm` | `full-auto`). */
  setApproval(chatId: string, mode: ApprovalMode): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.setApproval(mode)
    } catch (e) {
      log.debug("setApproval failed", { err: e, chatId, mode })
      return { ok: false, error: "invalid_request" }
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Session MCP on/off (`/mcp`). */
  setMcpEnabled(chatId: string, enabled: boolean): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    try {
      record.chat.setMcpEnabled(enabled)
    } catch (e) {
      log.debug("setMcpEnabled failed", { err: e, chatId, enabled })
      return { ok: false, error: "invalid_request" }
    }
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Grant a session trust pattern (the plan-line trust affordance). */
  trustAdd(chatId: string, tool: string, prefix: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    const granted = record.chat.grantTrust(tool, prefix)
    this.emitMeta(record)
    return granted ? { ok: true, result: { ok: true } } : { ok: false, error: "invalid_request" }
  }

  /** Revoke one session trust pattern. */
  trustRevoke(chatId: string, tool: string, prefix: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    record.chat.revokeTrust(tool, prefix)
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Revoke every session trust pattern. */
  trustRevokeAll(chatId: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    record.chat.revokeAllTrust()
    this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  /** Commit an approval plan with the client's per-line decisions. */
  answerPlan(
    chatId: string,
    planMessageId: number,
    decisions: ReadonlyArray<{ callId: string; accept: boolean }>,
  ): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    const map = new Map<string, "accept" | "reject">()
    for (const d of decisions) map.set(d.callId, d.accept ? "accept" : "reject")
    const resolved = record.chat.answerPlan(String(planMessageId), map)
    this.emitMeta(record)
    return resolved ? { ok: true, result: { ok: true } } : { ok: false, error: "no_pending_plan" }
  }


  /**
   * Answer a pending approval card through the engine's card resolver. Trust
   * intent (`addToSession`/`trust`/`addPrefix`) answers with `allow`, which
   * records the CARD's offered operation class — the engine chooses the class,
   * so a client cannot widen the trust surface.
   */
  answerApproval(opts: ChatAnswerApprovalOptions): ChatOpResult<{ ok: true }> {
    const record = this.records.get(opts.chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    const trust = opts.addToSession === true || opts.trust === true || (opts.addPrefix !== undefined && opts.addPrefix.length > 0)
    let resolved: boolean
    try {
      resolved =
        opts.action === "accept"
          ? record.chat.resolveCard(opts.callId, trust ? "allow" : "accept")
          : record.chat.resolveCard(opts.callId, "reject")
    } catch (e) {
      log.debug("resolveCard failed", { err: e, chatId: opts.chatId, callId: opts.callId })
      return { ok: false, error: "approval_failed" }
    }
    this.emitMeta(record)
    return resolved ? { ok: true, result: { ok: true } } : { ok: false, error: "no_pending_approval" }
  }

  /** Answer a pending ask_user card (the UI's inline answer/option pick). */
  answerAsk(chatId: string, callId: string, answer: string): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    if (record === undefined) return { ok: false, error: "chat_not_found" }
    let answered = false
    try {
      answered = record.chat.answerAsk(callId, answer)
    } catch (e) {
      answered = false
      log.debug("answerAsk failed", { err: e, chatId, callId })
    }
    this.emitMeta(record)
    return answered ? { ok: true, result: { ok: true } } : { ok: false, error: "no_pending_ask" }
  }

  /** Answer a pending sudo prompt (empty password = declined). `remember`
   * caches it in the host vault so a later sudo in this session is silent. */
  answerSudo(chatId: string, requestId: string, password: string, remember = false): ChatOpResult<{ ok: true }> {
    const record = this.records.get(chatId)
    const resolve = this.sudoResolvers.get(requestId)
    if (resolve === undefined) return { ok: false, error: "no_sudo_request" }
    this.sudoResolvers.delete(requestId)
    if (record !== undefined && record.pendingSudo?.requestId === requestId) record.pendingSudo = null
    resolve(password.length > 0 ? password : null)
    if (remember && password.length > 0) {
      try {
        this.getHost().sudoVault.set(password)
      } catch (err) {
        // caching is best-effort; the prompt was still answered
        log.error("sudo vault cache write failed", { err, chatId })
      }
    }
    if (record !== undefined) this.emitMeta(record)
    return { ok: true, result: { ok: true } }
  }

  // -- lifetime policy (P3c-iii; docs/daemon-api.md "Lifecycle", D9/D10) ------

  /**
   * True while any chat has a running turn (status `streaming`) or blocks on an
   * approval / plan / sudo / ask prompt. A detached turn keeps the daemon alive
   * (D9); a blocked prompt is handled by the no-client hold (D10).
   */
  anyTurnRunning(): boolean {
    for (const record of this.records.values()) {
      if (this.isBlocked(record)) return true
      if (record.chat.accessors.status() === "streaming") return true
    }
    return false
  }

  /** Chat ids blocked on an approval / plan / sudo / ask prompt (the D10 hold set). */
  pendingPromptChats(): string[] {
    const ids: string[] = []
    for (const record of this.records.values()) {
      if (this.isBlocked(record)) ids.push(record.id)
    }
    return ids
  }

  /**
   * Deny a chat's pending approval / plan / sudo prompt WITHOUT aborting (D10).
   * Returns true when a prompt was actually resolved. An `ask_user` prompt has
   * no daemon answer op, so `denyPending` returns false for it and the caller
   * aborts the turn instead — nothing ever executes unapproved.
   */
  denyPending(chatId: string): boolean {
    const record = this.records.get(chatId)
    if (record === undefined) return false
    let denied = false
    const card = record.chat.pendingApproval()
    if (card !== null) {
      try {
        if (record.chat.resolveCard(card.callId, "reject")) denied = true
      } catch {
        // contained
      }
    }
    if (record.chat.pendingPlan() !== null) {
      try {
        if (record.chat.denyPlan()) denied = true
      } catch {
        // contained
      }
    }
    if (record.pendingSudo !== null) {
      this.resolvePendingSudo(record, null)
      denied = true
    }
    return denied
  }

  /** Abort a chat's running turn (the D10 timeout's second half). */
  abortTurn(chatId: string): void {
    const record = this.records.get(chatId)
    if (record === undefined) return
    this.resolvePendingSudo(record, null)
    try {
      record.chat.abort()
    } catch {
      // best-effort
    }
  }

  /** Release every chat (daemon shutdown). */
  closeAll(): void {
    this.closed = true
    for (const record of [...this.records.values()]) this.drop(record)
    for (const resolve of this.sudoResolvers.values()) resolve(null)
    this.sudoResolvers.clear()
    // The daemon owns the MCP stdio children too: stop them so `daemon stop`
    // leaves no orphaned server processes (the TUI no longer can).
    try {
      void this.hostCache?.shutdownMcp()
    } catch (err) {
      // best-effort during shutdown
      log.warn("MCP shutdown failed during chat closeAll", { err })
    }
  }

  // -- internals --------------------------------------------------------------

  private handleChatEvent(record: ChatRecord, event: ChatEvent): void {
    if (event.kind === "sudo-request") {
      record.pendingSudo = { requestId: event.requestId, command: event.command, prompt: event.prompt }
    } else if (event.kind === "sudo-resolved") {
      if (record.pendingSudo?.requestId === event.requestId) record.pendingSudo = null
      this.sudoResolvers.delete(event.requestId)
    }
    // Meta is recomputed on every event except deltas (which fire per streamed
    // fragment and never change the readouts) so a `chat.meta` follows any
    // engine-driven change (status, title, usage, jobs, trust, MCP facts).
    const meta = event.kind === "delta" ? undefined : this.metaIfChanged(record)
    this.emit({ chatId: record.id, event, meta })
  }

  /** Emit a `chat.meta` event when the readouts changed since the last emit. */
  private emitMeta(record: ChatRecord): void {
    const meta = this.metaIfChanged(record)
    if (meta !== undefined && meta !== null) this.emit({ chatId: record.id, event: null, meta })
  }

  /** The fresh meta when it changed (or was never emitted), else undefined. */
  private metaIfChanged(record: ChatRecord): ChatMeta | undefined {
    let sig: string
    try {
      sig = this.metaSignature(record)
    } catch (e) {
      log.debug("meta signature failed", { err: e, chatId: record.id })
      return undefined
    }
    if (this.lastMetaSig.get(record.id) === sig) return undefined
    this.lastMetaSig.set(record.id, sig)
    return this.metaOf(record) ?? undefined
  }

  /**
   * A cheap string signature of every meta readout, so the expensive full meta
   * (context breakdown, endpoint redaction) is built only when something
   * actually changed. Never throws.
   */
  private metaSignature(record: ChatRecord): string {
    const chat = record.chat
    const acc = chat.accessors
    return JSON.stringify([
      acc.status(),
      acc.sessionTitle(),
      chat.selectedModel(),
      chat.endpointName(),
      chat.modelName(),
      chat.hasKey(),
      chat.modelSupportsVision(),
      chat.effortSetting(),
      chat.contextLimit(),
      acc.contextUsed(),
      acc.cacheRead(),
      acc.messages().length,
      chat.agentName(),
      acc.approval(),
      chat.trustPatterns(),
      acc.noTools(),
      chat.isWorking(),
      acc.compacting(),
      chat.activeJobCount(),
      acc.streamingSince(),
      acc.busyPending(),
      acc.mcpEnabled(),
      chat.mcpStatusFacts(),
    ])
  }

  /**
   * Derive the full meta from the live engine session (P4c-ii; D13). The
   * endpoint config is redacted by the SAME `redactConfig` the config resource
   * uses, so no resolved secret can leak through `meta.endpoint`. Returns null
   * when a signal read throws — a state snapshot must never fail because of it.
   */
  private metaOf(record: ChatRecord): ChatMeta | null {
    const chat = record.chat
    const acc = chat.accessors
    try {
      const cfg = this.getHost().getConfig()
      const raw = readRawConfig(configPath())
      const redactedEndpoints = redactConfig(cfg, raw)["endpoints"]
      const endpoint =
        redactedEndpoints !== null && typeof redactedEndpoints === "object"
          ? ((redactedEndpoints as Record<string, unknown>)[chat.endpointName()] as Record<string, unknown> | undefined) ?? null
          : null
      return {
        selectedModel: chat.selectedModel(),
        endpointName: chat.endpointName(),
        modelName: chat.modelName(),
        endpoint,
        hasKey: chat.hasKey(),
        modelMeta: chat.modelMeta(),
        modelSupportsVision: chat.modelSupportsVision(),
        effortSetting: chat.effortSetting(),
        contextLimit: chat.contextLimit(),
        contextUsed: acc.contextUsed(),
        cacheRead: acc.cacheRead()?.cached ?? 0,
        contextBreakdown: chat.contextBreakdown(),
        agentName: chat.agentName(),
        agentDef: chat.agentDef(),
        approval: acc.approval(),
        trustPatterns: [...chat.trustPatterns()],
        noTools: acc.noTools(),
        isWorking: chat.isWorking(),
        compacting: acc.compacting(),
        activeJobCount: chat.activeJobCount(),
        streamingSince: acc.streamingSince(),
        busyPending: acc.busyPending(),
        mcpEnabled: acc.mcpEnabled(),
        mcpStatusFacts: chat.mcpStatusFacts(),
        sessionTitle: acc.sessionTitle(),
        sessionFilePath: chat.sessionFilePath,
      }
    } catch (err) {
      log.warn("chat meta derivation failed", { err, chatId: record.id })
      return null
    }
  }

  /** True when a chat is blocked on any prompt (approval/plan/sudo/ask). */
  private isBlocked(record: ChatRecord): boolean {
    if (record.pendingSudo !== null) return true
    try {
      return record.chat.pendingApproval() !== null || record.chat.pendingPlan() !== null || record.chat.pendingAsk() !== null
    } catch (err) {
      // A signal read must never escape the lifetime policy.
      log.warn("pending-prompt read failed", { err, chatId: record.id })
      return false
    }
  }

  /** Resolve the chat's pending sudo prompt (abort/close) and forget it. */
  private resolvePendingSudo(record: ChatRecord, password: string | null): void {
    if (record.pendingSudo === null) return
    const requestId = record.pendingSudo.requestId
    record.pendingSudo = null
    const resolve = this.sudoResolvers.get(requestId)
    this.sudoResolvers.delete(requestId)
    resolve?.(password)
  }

  /** Unsubscribe + forget one chat record. */
  private drop(record: ChatRecord): void {
    // Release the session (docs/events.md): the daemon owns the chat lifetime,
    // so its teardown is where `session.ended` fires.
    try {
      this.getHost().endTabChat(record.chat, this.closed ? "shutdown" : "closed")
    } catch (err) {
      // contained
      log.warn("endTabChat failed on drop", { err, chatId: record.id })
    }
    try {
      record.unsubscribe()
    } catch (err) {
      // contained
      log.warn("chat unsubscribe failed on drop", { err, chatId: record.id })
    }
    this.resolvePendingSudo(record, null)
    this.records.delete(record.id)
    this.lastMetaSig.delete(record.id)
  }

  private stateOf(record: ChatRecord): ChatState {
    const meta = this.metaOf(record)
    try {
      this.lastMetaSig.set(record.id, this.metaSignature(record))
    } catch (e) {
      // A signature failure only costs a redundant future `chat.meta`.
      log.debug("stateOf meta signature failed", { err: e, chatId: record.id })
    }
    return {
      messages: [...record.chat.accessors.messages()],
      status: record.chat.accessors.status(),
      plan: record.chat.pendingPlan(),
      pendingApproval: record.chat.pendingApproval(),
      pendingSudo: record.pendingSudo,
      meta,
    }
  }

  /** Wire the chat's terminal-context getter when it is bound to a shell (P4a
   * gap 3). Without this, `ChatSession` drops every `[terminal]` context block. */
  private attachShellContext(record: ChatRecord): void {
    if (record.shellId === null || this.opts.shells === undefined) return
    try {
      record.chat.attachTerminal(() => this.snapshotFor(record))
    } catch (err) {
      // A session that refuses the seam still runs; it just loses context.
      log.warn("attachTerminal failed", { err, chatId: record.id, shellId: record.shellId })
    }
  }

  /**
   * The live terminal snapshot a bound chat's context block and tools read:
   * the client's last `terminal.facts` while a client is attached (D2 — the VT
   * is client-owned and authoritative), else the scanner ring. Never throws;
   * a gone shell yields null so the context block is simply skipped.
   */
  private snapshotFor(record: ChatRecord): TerminalSnapshotForChat | null {
    const shellId = record.shellId
    const shells = this.opts.shells
    if (shellId === null || shells === undefined) return null
    try {
      const status: TerminalStatus | null = shells.statusOf(shellId)
      if (status === null) return null
      const facts = shells.getFacts(shellId)
      const fromFacts = facts !== null && facts.lines.length > 0 && shells.hasClient(shellId)
      const tailLines = fromFacts ? facts.lines.slice(-200) : shells.recentLines(shellId, 200)
      const pane: AgentPane | null = shells.ptyFor(shellId)
      return {
        pane,
        cwd: status.cwd,
        shell: shells.shellName(shellId) ?? "shell",
        currentCommand: status.currentCommand,
        alternateOn: status.alternateOn,
        tailLines,
      }
    } catch (e) {
      log.debug("terminal snapshot for chat failed", { err: e, shellId })
      return null
    }
  }

  /** ULID-ish, collision-resistant chat id (base36 time + counter + tail). */
  private newChatId(): string {
    this.idCounter += 1
    const now = (this.opts.now ?? Date.now)()
    return `chat-${now.toString(36)}-${this.idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}
