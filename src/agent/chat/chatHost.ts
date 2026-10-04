/**
 * ChatHost — owns the per-tab ChatSession lifecycle: builds each tab's
 * SessionFile (fresh, or reopened on --resume), rotates the file on /clear,
 * re-loads config for /reload and agents for /reload + agent switches.
 * Constructed once in index.tsx, passed to App.
 *
 * Post-rework (docs/config.md): model selection is GLOBAL —
 * `config.model = "<endpoint>@<model-id>"` — and the picker//model writes it
 * through setSelectedModel so the last pick survives relaunches. The default
 * agent persists the same way (`config.agent`).
 */

import { loadConfig, loadCustomInstructions, configPath, activeEndpoint, activeEndpointName, activeModelId, memoryDir, parseSelectedModel, sensusHome, sensusStateDir, selectedModelString, type EndpointConfig, type MemoryConfig, type SensusConfig } from "../../config/config.ts"
import { ensureAgentDirs, fallbackAgent, loadAgents, type AgentsCatalog } from "../../config/agents.ts"
import { loadSkills, type SkillsCatalog } from "../skills/loader.ts"
import { expandInstructionEntries, listInstructionUrls, readInstructionFiles, INSTRUCTION_URL_TIMEOUT_MS } from "../instructions.ts"
import { sessionFilePath, SessionFile, listSessionFiles, loadSessionFile, deleteSessionFile } from "../../session/store.ts"
import { readSessionMeta, renameSession } from "../../session/meta.ts"
import { SessionIndex, type SessionSearchBridge } from "../../session/indexDb.ts"
import { createProvider } from "../provider/provider.ts"
import { ChatSession } from "./chatSession.ts"
import { requestSessionTitle } from "./title.ts"
import type { FirstPromptInfo } from "./chatMessages.ts"
import { MemoryStore } from "../memory/store.ts"
import { AuditLog } from "../audit.ts"
import type { MemoryLimits, MemorySnapshot } from "../memory/types.ts"
import { createEventSink, NoopEventSink, type ApprovalPolicy, type ApprovalPolicyFactory, type EventSink, type EventSinkFactory, type ExtensionsConfig, type SensusEvent } from "../extensions.ts"
import { McpRegistry } from "../mcp/registry.ts"
import type { ToastLevel } from "../../engine/toast.ts"
import { errorMessage } from "../../core/util.ts"
import { SudoVault } from "../../core/sudoVault.ts"
import { sudoAskpassBroker } from "../sudoAskpass.ts"
import { updateRawConfig } from "../../config/configFile.ts"
import { buildSystemPrompt } from "../prompt.ts"
import { estTokens, resolveContextLimit, TOOL_SPEC_TOKENS } from "./compaction.ts"
import { type ContextBreakdown } from "../../engine/chat/contextInspector.ts"
import { reconstructHistoryEntries } from "./contextHistory.ts"
import { join } from "node:path"
import * as os from "node:os"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.chat")

/**
 * Why the config was swapped, passed to every `onConfigChange` listener so the
 * UI knows which surfaces to re-apply (docs/config.md "Live config reload"):
 *
 * - `internal` — a reload that re-read config for an unrelated reason (model or
 *   agent pick, MCP toggle, keymap remap, setup completion). It must NOT clobber
 *   session-scoped overrides such as a tab's `/cards` display choice.
 * - `user` — an explicit reload: the chat `/reload` slash command, the agent's
 *   `reload` tool, or the Ctrl+P "Reload config" row. Re-seeds session display.
 * - `settings` — a settings-screen write. Re-seeds session display AND the
 *   settings-owned layout store (sidebar width, layout, tab-rail width).
 */
export type ConfigChangeKind = "internal" | "user" | "settings"

/** A config-change listener; fired after a successful config swap with the
 * change kind. Listener problems are contained by the host. */
export type ConfigChangeListener = (kind: ConfigChangeKind) => void

export interface ChatHostOptions {
  dataDir: string
  instanceId: string
  /** Boot-time resolved config (file + env + CLI). */
  initialConfig: SensusConfig
  /** Original process argv (used by /reload to re-resolve). */
  argv: readonly string[]
  toast(message: string, level?: ToastLevel, ttlMs?: number): void
  /** Open a full-screen overlay in the UI (M5 /settings, /models, /agents, /memory, /sessions). */
  openOverlay?(kind: "settings" | "models" | "agents" | "themes" | "memory" | "sessions" | "skills" | "context" | "usage" | "keymap"): void
  /** Live theme name + apply/persist (M5 /theme). */
  getTheme?(): string
  applyTheme?(name: string): string | null
  /** /status extras: UI-owned runtime facts (terminal, focus, size, theme). */
  getRuntimeStatus?: () => string | null
  /** Catalog generation accessor (the UI's `modelInfoVersion` signal). Sessions
   * key their memoized model metadata on it so a models.dev prefetch/picker
   * enrichment invalidates a pre-fetch 128k fallback. */
  catalogVersion?: () => number
  /** Sudo popup: ask the user (masked overlay). Resolves null when
   * declined/aborted. The password is kept in memory for the session only.
   * `hint` is an optional line the popup shows to explain a re-prompt.
   * `requestId` is the engine-generated correlation id; a remote transport
   * (the daemon) forwards it so it can answer the matching `sudo.request`. */
  requestSudo?(command: string, hint?: string, requestId?: string): Promise<string | null>
  /** Extensions (docs/extensions.md): build the approval policy from config.
   * Absent = the built-in approval modes only. A host (the enterprise addon)
   * passes this to supply policy kinds beyond the built-in `"default"`. */
  approvalPolicyFactory?: ApprovalPolicyFactory
  /** Extensions (docs/extensions.md): build the event sink from config.
   * Defaults to `createEventSink` (noop | uds). */
  eventSinkFactory?: EventSinkFactory
}

interface ChatFileState {
  tabIndex: number
  generation: number
  file: SessionFile
}

export class ChatHost {
  private readonly dataDir: string
  private readonly instanceId: string
  private readonly argv: readonly string[]
  private readonly toast: (message: string, level?: ToastLevel, ttlMs?: number) => void
  private readonly openOverlay: ((kind: "settings" | "models" | "agents" | "themes" | "memory" | "sessions" | "skills" | "context" | "usage" | "keymap") => void) | undefined
  private readonly getTheme: (() => string) | undefined
  private readonly applyTheme: ((name: string) => string | null) | undefined
  private readonly getRuntimeStatus: (() => string | null) | undefined
  private readonly catalogVersion: (() => number) | undefined
  private readonly requestSudo: ((command: string, hint?: string, requestId?: string) => Promise<string | null>) | undefined
  /** Extensions (docs/extensions.md): the live approval policy (null = the
   * built-in modes only) and event sink (noop when nothing is configured). */
  private approvalPolicy: ApprovalPolicy | null = null
  private eventSink: EventSink = new NoopEventSink()
  private readonly approvalPolicyFactory: ApprovalPolicyFactory | undefined
  private readonly eventSinkFactory: EventSinkFactory | undefined
  /** Current resolved config (swapped by /reload). */
  private config: SensusConfig
  /**
   * Cached combined custom-instruction text for the system prompt: the global
   * `~/.config/sensus/AGENTS.md` + the resolved config `instructions` files +
   * best-effort URL bodies (docs/config.md "instructions"). Rebuilt by the
   * constructor and `/reload`; sessions read it through the `getInstructions`
   * dep so `buildSystemPrompt` stays synchronous.
   */
  private instructionsText: string | null = null
  /** Guards an in-flight URL fetch from overwriting a newer rebuild. */
  private instructionsGeneration = 0
  /** Current agents catalog (swapped by /reload + agent file changes). */
  private agents: AgentsCatalog = { agents: [], byName: {}, warnings: [] }
  /** Current skills catalog (docs/skills.md; swapped by /reload). */
  private skills: SkillsCatalog = { skills: [], byName: {}, warnings: [] }
  /**
   * Config-change listeners — THE single seam by which a config swap reaches
   * the UI (docs/config.md "Live config reload"). App registers ONE listener
   * whose body is the full surface list; the kind tells it which surfaces to
   * re-apply so future config-derived surfaces do not need their own hook.
   */
  private readonly configChangeListeners = new Set<ConfigChangeListener>()
  /** One provider per endpoint name. A provider bakes in the endpoint's
   * baseURL + API key at construction, so each memo records the credential
   * signature it was built from: a config (re)load that changes either
   * rebuilds the client instead of serving requests — and 401s — from a stale
   * one until the process restarts. */
  private readonly providers = new Map<
    string,
    { provider: ReturnType<typeof createProvider>; signature: string }
  >()
  /**
   * MCP registry (M11, docs/mcp.md) — ONE per sensus instance, shared by
   * every tab's ChatSession. Servers connect lazily at first use and are
   * stopped on exit AND on detach (the sensus process goes away in both).
   */
  readonly mcp: McpRegistry
  /**
   * Agent memory (docs/memory.md): the single writer for MEMORY/HOST/JOURNAL.
   * Rebuilt on /reload so a caps/policy change takes effect for the next
   * session (the live session keeps its frozen prompt snapshot).
   */
  private memory: MemoryStore
  /** Append-only action log + undo (docs/agent.md "Undo & audit"). */
  private readonly audit: AuditLog
  /**
   * Session search (Phase 1.6): one FTS5 index over every past transcript,
   * shared by every tab's ChatSession (the `session_search` / `session_list` /
   * `session_view` tools) and the UI `/sessions` overlay. Construction ensures
   * the DB; the first ingest pass is deferred so a large sessions dir never
   * blocks boot.
   */
  private readonly sessionIndex: SessionIndex
  /** Wall-clock of the last lazy ingest pass (searches throttle re-stats). */
  private lastIndexRefresh = 0
  /** Refreshing bridge handed to sessions/ctx + the overlay (search re-stats). */
  private readonly sessionSearch: SessionSearchBridge = {
    search: (query, limit, session, offset) => {
      this.refreshSessionIndex()
      return this.sessionIndex.search(query, limit, session, offset)
    },
    list: (limit, offset) => {
      this.refreshSessionIndex()
      return this.sessionIndex.list(limit, offset)
    },
    readSession: (session, offset, limit) => {
      this.refreshSessionIndex()
      return this.sessionIndex.readSession(session, offset, limit)
    },
    remove: (path) => {
      // Delete the file first; only forget the index row once the transcript
      // is actually gone, so a failed unlink leaves a retryable entry.
      const ok = deleteSessionFile(path)
      if (ok) this.sessionIndex.remove(path)
      return ok
    },
  }
  /**
   * Session-scoped sudo password vault (never persisted to disk, never sent
   * to the model). The sudo POPUP writes here only when the user SELECTS
   * "cache for this session" (off by default); every later sudo failure then
   * reuses it silently in ANY approval posture until sensus exits. When not
   * selected, nothing is stored and each sudo use re-prompts. The value is
   * AES-256-GCM encrypted in RAM (src/core/sudoVault.ts). A rejected
   * password (or `/sudo forget`) clears it so the next failure can ask again.
   */
  readonly sudoVault = new SudoVault()

  constructor(opts: ChatHostOptions) {
    this.dataDir = opts.dataDir
    this.instanceId = opts.instanceId
    this.argv = opts.argv
    this.toast = opts.toast
    this.openOverlay = opts.openOverlay
    this.getTheme = opts.getTheme
    this.applyTheme = opts.applyTheme
    this.getRuntimeStatus = opts.getRuntimeStatus
    this.catalogVersion = opts.catalogVersion
    this.requestSudo = opts.requestSudo
    this.config = opts.initialConfig
    this.approvalPolicyFactory = opts.approvalPolicyFactory
    this.eventSinkFactory = opts.eventSinkFactory
    this.applyExtensions(opts.initialConfig.extensions)
    this.mcp = new McpRegistry(opts.initialConfig.mcp)
    this.memory = new MemoryStore({
      dir: memoryDir(sensusHome()),
      limits: memoryLimits(opts.initialConfig.memory),
      redactSecrets: opts.initialConfig.memory.redactSecrets,
    })
    this.memory.ensure()
    this.audit = new AuditLog({ path: join(sensusStateDir(), "audit.jsonl") })
    // Session search index (Phase 1.6). ensure() is cheap; the first ingest
    // pass is deferred to a macrotask so a large sessions dir cannot stall
    // boot. Everything here is best-effort and never throws.
    this.sessionIndex = new SessionIndex({ dbPath: join(sensusStateDir(), "sessions-index.sqlite") })
    this.sessionIndex.ensure()
    try {
      setTimeout(() => this.refreshSessionIndex(), 0)
    } catch {
      // a missing timer API must not stop construction
    }
    // Materialize agents/skills/memory dirs + built-in agent files, then load.
    for (const w of ensureAgentDirs(sensusHome())) this.toast(w, "warn", 5000)
    this.agents = loadAgents(sensusHome())
    for (const w of this.agents.warnings) this.toast(w, "warn", 5000)
    this.skills = loadSkills(sensusHome())
    for (const w of this.skills.warnings) this.toast(w, "warn", 5000)
    if (this.agents.agents.length === 0) {
      this.toast("no agents loaded — using the built-in copilot (check ~/.config/sensus/agents/)", "warn", 6000)
    }
    this.refreshInstructions()
  }

  /**
   * (Re)build the extensions seam from config (docs/extensions.md): the
   * approval policy and the event sink. Called at construction and after every
   * `/reload`, so a config change takes effect for the next call. Both builders
   * are best-effort — a throwing factory falls back to the no-op defaults and
   * must never fail boot/reload.
   */
  private applyExtensions(ext: ExtensionsConfig): void {
    try {
      this.eventSink = (this.eventSinkFactory ?? createEventSink)(ext.eventSink)
    } catch (e) {
      this.eventSink = new NoopEventSink()
      log.error("event sink factory threw; falling back to noop (events dropped)", { err: e })
    }
    try {
      this.approvalPolicy = this.approvalPolicyFactory !== undefined ? this.approvalPolicyFactory(ext.approvalPolicy) : null
    } catch (e) {
      this.approvalPolicy = null
      log.warn("approval policy factory threw; falling back to built-in modes", { err: e })
    }
  }

  /** Fire-and-forget host-level event (docs/extensions.md); never throws. */
  private emitEvent(event: SensusEvent): void {
    try {
      this.eventSink.emit(event)
    } catch {
      // an audit event must never break boot/reload
    }
  }

  getConfig(): SensusConfig {
    return this.config
  }

  /** The cached combined instruction text (global AGENTS.md + config
   * `instructions` + fetched URLs); null when there are none. */
  getInstructions(): string | null {
    return this.instructionsText
  }

  getAgents(): AgentsCatalog {
    return this.agents
  }

  /** Current skills catalog (docs/skills.md). */
  getSkills(): SkillsCatalog {
    return this.skills
  }

  /**
   * Rebuild the cached instruction text from the current config: the global
   * `~/.config/sensus/AGENTS.md` + the resolved `instructions` files
   * (synchronously), then `http(s)` URL bodies in the background. The URL
   * fetch is best-effort (short timeout, failures ignored) and only lands if
   * no newer rebuild has started — so an in-flight fetch can never clobber a
   * `/reload` result. Sessions see the text through `getInstructions`.
   */
  private refreshInstructions(): void {
    const generation = ++this.instructionsGeneration
    this.instructionsText = this.buildLocalInstructions()
    const urls = listInstructionUrls(this.config.instructions)
    if (urls.length === 0) return
    void this.fetchInstructionUrls(urls, generation)
  }

  /** The synchronous half of the instruction build (global + local files). */
  private buildLocalInstructions(): string | null {
    const parts: string[] = []
    const global = loadCustomInstructions()
    if (global !== null && global.trim().length > 0) parts.push(global.trimEnd())
    const { files } = expandInstructionEntries(this.config.instructions, {
      // `instructions` entries are relative to where sensus was launched; the
      // config dir is the fallback (docs/config.md "instructions").
      cwd: process.cwd(),
      home: process.env["HOME"] ?? os.homedir(),
      configDir: sensusHome(),
    })
    const { text } = readInstructionFiles(files)
    if (text.length > 0) parts.push(text)
    return parts.length === 0 ? null : parts.join("\n\n")
  }

  /** Best-effort fetch of `instructions` URL entries (never throws). */
  private async fetchInstructionUrls(urls: readonly string[], generation: number): Promise<void> {
    const bodies: string[] = []
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(INSTRUCTION_URL_TIMEOUT_MS) })
        if (!res.ok) continue
        const body = (await res.text()).trim()
        if (body.length > 0) bodies.push(`# Instructions from ${url}\n${body}`)
      } catch {
        // unreachable/slow URL — best-effort, ignored
      }
    }
    if (bodies.length === 0 || generation !== this.instructionsGeneration) return
    const base = this.instructionsText
    this.instructionsText = base === null ? bodies.join("\n\n") : `${base}\n\n${bodies.join("\n\n")}`
  }

  /** The live memory store (tools + manager UI). */
  getMemoryStore(): MemoryStore {
    return this.memory
  }

  /** The raw session search index (advanced callers + tests). */
  getSessionIndex(): SessionIndex {
    return this.sessionIndex
  }

  /**
   * The refreshing session search bridge: every search/list lazily re-stats
   * the sessions dir (throttled) before answering, so the tool and the
   * `/sessions` overlay always see the newest transcripts. Best-effort only.
   */
  getSessionSearch(): SessionSearchBridge {
    return this.sessionSearch
  }

  /** Re-stat + ingest changed transcripts (throttled unless `force`). */
  private refreshSessionIndex(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastIndexRefresh < 1500) return
    this.lastIndexRefresh = now
    try {
      this.sessionIndex.refresh(listSessionFiles(this.dataDir), force)
    } catch {
      // best-effort: search still answers from whatever is already indexed
    }
  }

  /** Frozen MEMORY.md snapshot captured once per ChatSession (docs/memory.md). */
  getMemorySnapshot(): MemorySnapshot {
    return this.memory.snapshot()
  }

  /**
   * Reconstruct a read-only Context Inspector snapshot for a SAVED session
   * (docs/agent.md "Context inspector"). The durable history resumes from the
   * last checkpoint, so the entries + token estimates match what a `--resume`
   * would send. Best-effort and never throws: the CURRENT config supplies the
   * window limit and a system-prompt estimate, and the note flags that this is
   * a reconstruction, not the live session.
   */
  sessionContextBreakdown(path: string): { title: string; breakdown: ContextBreakdown } | null {
    try {
      const loaded = loadSessionFile(path)
      const durable = loaded.messages.slice(loaded.checkpointIndex)
      const history = reconstructHistoryEntries(loaded)
      const historyTokens = history.reduce((sum, e) => sum + e.tokens, 0)
      const last = [...durable].reverse()
      const lastModel = last.find((m) => m.role === "assistant" && m.model !== undefined)?.model ?? ""
      const usage = last.find((m) => m.role === "assistant" && m.usage != null)?.usage ?? null
      const cachePrompt = usage?.promptTokens ?? 0
      const cacheRead = usage?.cachedTokens ?? 0
      // Saved-session reconstruction: no live metadata, so the inspector keeps
      // its historical context-only limit (the input cap is a live-model concern).
      const limit = resolveContextLimit(this.config.context.contextLimit, null, null)
      const systemTokens = this.systemPromptTokens(lastModel)
      const used = systemTokens + historyTokens + TOOL_SPEC_TOKENS
      return {
        title: loaded.title,
        breakdown: {
          model: lastModel,
          limit,
          used,
          percent: limit > 0 ? Math.max(0, Math.round((used / limit) * 100)) : 0,
          systemTokens,
          historyTokens,
          toolSpecTokens: TOOL_SPEC_TOKENS,
          mcpSpecTokens: 0,
          messages: history.length,
          compactions: loaded.compactions,
          cacheRead,
          cacheWrite: Math.max(0, cachePrompt - cacheRead),
          cachePrompt,
          pinned: false,
          enabled: true,
          note: "reconstructed from the saved transcript (not the live session)",
          history,
        },
      }
    } catch {
      return null
    }
  }

  /** Best-effort system-prompt token estimate for the current config (past session). */
  private systemPromptTokens(model: string): number {
    try {
      const cfg = this.config
      const agent = this.agents.byName[cfg.defaultAgent] ?? this.agents.agents[0] ?? fallbackAgent()
      const prompt = buildSystemPrompt({
        os: `${os.type()} ${os.release()} (${process.platform})`,
        hostname: os.hostname(),
        shell: cfg.shell,
        agent,
        model,
        terminal: "embedded PTY (xterm-256color)",
        noTools: false,
        mcp: [],
        skills: this.skills,
        customInstructions: this.instructionsText,
        memory: cfg.memory.enabled ? this.getMemorySnapshot() : null,
      })
      return estTokens(prompt)
    } catch {
      return 0
    }
  }

  /**
   * Register a config-change listener and return an unsubscribe function. It
   * fires after EVERY successful config swap with the change kind (see
   * ConfigChangeKind): App's one listener re-applies the config-derived UI
   * surfaces, so a new surface is added to that list rather than wired through
   * a new setter here. A throwing listener is contained — UI problems never
   * fail a reload.
   */
  onConfigChange(listener: ConfigChangeListener): () => void {
    this.configChangeListeners.add(listener)
    return () => {
      this.configChangeListeners.delete(listener)
    }
  }

  /** Notify every config-change listener; listener errors are contained. */
  private notifyConfigChange(kind: ConfigChangeKind): void {
    for (const listener of this.configChangeListeners) {
      try {
        listener(kind)
      } catch {
        // listeners are UI-side — never fail the reload because of them
      }
    }
  }

  /**
   * Create a tab's chat. tabIndex is 1-based; pass resumePath to continue an
   * existing session file (sensus --resume) instead of creating a new one.
   */
  createTabChat(tabIndex: number, resumePath?: string): ChatSession {
    const state: ChatFileState = resumePath
      ? {
          tabIndex,
          generation: 0,
          file: SessionFile.reopen(resumePath),
        }
      : {
          tabIndex,
          generation: 0,
          file: SessionFile.create(sessionFilePath(this.dataDir, this.instanceId, tabIndex, 0), this.header()),
        }
    const chat = new ChatSession({
      getConfig: () => this.getConfig(),
      catalogVersion: this.catalogVersion,
      // Getter by endpoint name: a tab's model pick can switch endpoints
      // mid-conversation; the host memoizes one provider per endpoint.
      provider: (endpointName) => this.provider(endpointName),
      file: () => state.file,
      rotateFile: () => {
        state.generation++
        state.file = SessionFile.create(
          sessionFilePath(this.dataDir, this.instanceId, state.tabIndex, state.generation),
          this.header(),
        )
        return state.file
      },
      toast: this.toast,
      reloadConfig: () => this.reload("user"),
      getInstructions: () => this.getInstructions(),
      getAgents: () => this.getAgents(),
      getSkills: () => this.getSkills(),
      audit: {
        record: (entry) => this.audit.record({ ...entry, session: this.instanceId }),
        lastUndoable: () => this.audit.lastUndoable(),
        markUndone: (ts) => this.audit.markUndone(ts),
        recent: (limit) => this.audit.recent(limit),
      },
      getMemorySnapshot: () => this.getMemorySnapshot(),
      memory: this.memory,
      sessionSearch: this.sessionSearch,
      setSelectedModel: (endpoint, model) => this.setSelectedModel(endpoint, model),
      setDefaultAgent: (name) => this.setDefaultAgent(name),
      openOverlay: this.openOverlay,
      getTheme: this.getTheme,
      applyTheme: this.applyTheme,
      getRuntimeStatus: this.getRuntimeStatus,
      mcp: this.mcp,
      sessionId: this.instanceId,
      approvalPolicy: () => this.approvalPolicy,
      eventSink: () => this.eventSink,
      requestSudo:
        this.requestSudo !== undefined
          ? async (command, hint, requestId) => {
              // Cached session password: answer without bothering the user.
              const cached = this.sudoVault.get()
              if (cached !== null) return cached
              return this.requestSudo!(command, hint, requestId)
            }
          : undefined,
      // A cached password lets a later hidden-shell sudo failure retry
      // silently even in a confirm/ask posture (no new popup).
      hasSudoPassword: () => this.sudoVault.has(),
      clearSudoPassword: () => {
        this.sudoVault.clear()
        // Drop any pane askpass secret too (rejection or /sudo forget).
        sudoAskpassBroker.disarm()
      },
      onFirstPrompt: (info) => this.generateSessionTitle(info, (title) => chat.setSessionTitle(title)),
    })
    // Extensions session-start (docs/extensions.md): the tab's session now
    // exists (fresh or resumed). Fire-and-forget; the sink never throws.
    this.emitEvent({
      type: "session-start",
      ts: Date.now(),
      session: this.instanceId,
      agent: this.config.defaultAgent,
      approval: this.config.approval,
      shell: this.config.shell,
      model: this.header().model,
      resumed: resumePath !== undefined,
    })
    // Activity record (docs/logging.md): the same facts, filterable at info.
    log.info("session started", {
      session: this.instanceId,
      tab: tabIndex,
      path: state.file.filePath,
      agent: this.config.defaultAgent,
      approval: this.config.approval,
      shell: this.config.shell,
      model: this.header().model,
      resumed: resumePath !== undefined,
    })
    return chat
  }

  /**
   * Release a tab's chat (docs/events.md): the symmetric `session-end`. The
   * daemon calls this when it drops a chat / shuts down; there is no per-tab
   * close in v1 (a chat survives client detach). Fire-and-forget; never throws.
   */
  endTabChat(chat: ChatSession, reason = "closed"): void {
    // Activity record (docs/logging.md): the matching `session ended` at info.
    log.info("session ended", { session: this.instanceId, reason, path: chat.sessionFilePath })
    chat.endSession(reason)
  }

  /**
   * The provider for one endpoint (mock seam or real HTTP), MEMOIZED by name —
   * a provider holds the baseURL + API key, so switching endpoints
   * mid-session must build/reuse the right one without leaking client
   * instances per request. The memo is revalidated against the endpoint's
   * current credential signature on every call, so `/reload` (and any config
   * write that goes through it) picks up a corrected key or baseURL
   * immediately — no restart required.
   */
  private provider(endpointName: string): ReturnType<typeof createProvider> {
    const cfg = this.config
    const endpoint = cfg.endpoints[endpointName] ?? activeEndpoint(cfg)
    const signature = providerSignature(endpoint)
    const memo = this.providers.get(endpointName)
    if (memo !== undefined && memo.signature === signature) return memo.provider
    const provider = createProvider(endpoint)
    this.providers.set(endpointName, { provider, signature })
    return provider
  }

  private header(): { endpoint: string; model: string } {
    return { endpoint: activeEndpointName(this.config), model: activeModelId(this.config) }
  }

  /**
   * Persist the selected model (`<endpoint>@<model>`) to config.json — the
   * picker and /model land here, so the last pick survives relaunches
   * (fresh read-modify-write; must not clobber unrelated settings changes).
   */
  setSelectedModel(endpoint: string, model: string): string | null {
    const res = updateRawConfig(configPath(), (raw) => ({ ...raw, model: selectedModelString(endpoint, model) }))
    if (!res.ok) return res.error ?? "config write failed"
    this.reload()
    return null
  }

  /** Persist the default agent name to config.json (picker + /agent). */
  setDefaultAgent(name: string): string | null {
    const res = updateRawConfig(configPath(), (raw) => ({ ...raw, agent: name }))
    if (!res.ok) return res.error ?? "config write failed"
    this.reload()
    return null
  }

  /**
   * Best-effort LLM session title on the first prompt (docs/sessions.md "Auto
   * titles"). Fired by ChatSession as fire-and-forget; never throws and never
   * blocks a send. The model is `config.titles.model` when set (`<endpoint>@
   * <model>` or a bare id on the session's endpoint), else the session's
   * selected model. Writes the sidecar via `renameSession`; a manual rename
   * that lands mid-generation wins (re-checked before the write). On success
   * `apply` pushes the title to the tab (display-only; docs/sessions.md).
   */
  private generateSessionTitle(info: FirstPromptInfo, apply: (title: string) => void): void {
    if (!this.config.titles.enabled) return
    void (async () => {
      try {
        if (info.signal.aborted) return
        if (readSessionMeta(info.path).title !== undefined) return
        let endpointName = info.endpoint
        let model = info.model
        const configured = this.config.titles.model.trim()
        if (configured.length > 0) {
          const parsed = parseSelectedModel(configured)
          if (parsed !== null) {
            if (this.config.endpoints[parsed.endpoint] === undefined) return
            endpointName = parsed.endpoint
            model = parsed.model
          } else {
            // A bare id keeps the session's endpoint.
            model = configured
          }
        }
        const title = await requestSessionTitle({
          provider: this.provider(endpointName),
          model,
          userText: info.text,
          signal: info.signal,
        })
        if (title === null || info.signal.aborted) return
        if (readSessionMeta(info.path).title !== undefined) return
        renameSession(info.path, title)
        // Reflect the generated title in the tab (docs/sessions.md "Auto
        // titles"); the tab-title seam is display-only and never throws.
        try {
          apply(title)
        } catch (e) {
          // display-only: a bad UI callback must not fail the title write
          log.debug("auto-title tab callback threw", { err: e })
        }
      } catch (e) {
        // A title is a nicety: provider/disk failures keep the derived title.
        log.debug("auto-title generation failed", { err: e })
      }
    })()
  }

  /**
   * Re-read config + AGENTS.md + agents. Returns a toast message (never
   * throws). `kind` classifies the cause for the config-change listeners (see
   * ConfigChangeKind); it defaults to `internal` because most callers re-read
   * for an unrelated reason. The user-initiated paths (`reloadConfig`, the
   * Ctrl+P row, a settings write) pass their kind explicitly.
   */
  reload(kind: ConfigChangeKind = "internal"): string | null {
    try {
      const next = loadConfig(this.argv)
      const modelDiff = next.model !== this.config.model ? `; model now ${next.model}` : ""
      this.config = next
      // Extensions (docs/extensions.md): swap the policy/sink for the next call.
      this.applyExtensions(next.extensions)
      // Re-resolve the combined instruction text (global AGENTS.md + config
      // `instructions` + fetched URLs) against the new config.
      this.refreshInstructions()
      const instr = this.instructionsText
      this.memory.updateLimits(memoryLimits(next.memory))
      this.memory.setRedactSecrets(next.memory.redactSecrets)
      this.memory.ensure()
      // Agents reload with the config (/reload picks up agent file edits).
      this.agents = loadAgents(sensusHome())
      this.skills = loadSkills(sensusHome())
      this.notifyConfigChange(kind)
      // MCP (M11): diff the server configs in the background; changed
      // servers stop now and reconnect lazily on the next message.
      void this.mcp
        .restartChanged(next.mcp)
        .then((changes) => {
          for (const c of changes) this.toast(c, "info", 4000)
        })
        .catch((e: unknown) => {
          // restart diffing is best-effort
          log.warn("mcp restart after config reload failed", { err: e })
        })
      return (
        `config reloaded (${Object.keys(next.endpoints).length} endpoint(s)${modelDiff} · ${this.agents.agents.length} agent(s))` +
        (instr !== null ? ` · instructions ${instr.length} chars` : " · no instructions")
      )
    } catch (e) {
      this.toast(`config reload failed: ${errorMessage(e)}`, "error", 4000)
      return null
    }
  }

  /**
   * Stop every MCP server (stdio children die, HTTP sessions DELETE).
   * Called by index.tsx on normal exit AND on detach — the sensus process
   * leaves in both, and orphaned `npx` servers would outlive it otherwise.
   */
  async shutdownMcp(): Promise<void> {
    try {
      await this.mcp.stopAll()
    } catch (e) {
      // never throw during shutdown
      log.debug("mcp stopAll failed during shutdown", { err: e })
    }
  }
}

/**
 * Everything `createProvider` bakes into a client: the transport choice, the
 * baseURL, and the endpoint's API key. Used to decide whether a memoized
 * provider is still valid for the endpoint's live config, so credential/config
 * edits (config.json + /reload, Settings save, model/agent pickers) rebuild it
 * instead of silently reusing the old client.
 */
function providerSignature(endpoint: EndpointConfig): string {
  return `${endpoint.provider}\u0000${endpoint.baseURL}\u0000${endpoint.apiKey}`
}

/** Map the config memory section onto the store's hard caps. */
function memoryLimits(cfg: MemoryConfig): MemoryLimits {
  return { memory: cfg.memoryCharLimit, host: cfg.hostCharLimit, journal: cfg.journalCharLimit }
}
