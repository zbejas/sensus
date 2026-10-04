import { type KeyActionId } from "../../core/keymap.ts"
import { type McpConfig, type McpServerConfig } from "../../agent/mcp/types.ts"
import { type EventV1Type, type ExtensionsConfig } from "../../agent/extensions.ts"
import { type PaletteOverride } from "../../theme/themePalette.ts"

// Re-exported for MCP consumers (registry/chatSession import from config.ts).
export type { McpConfig, McpServerConfig }
// Re-exported so `config.ts` stays the single config import for consumers.
export type { ExtensionsConfig, ApprovalPolicyConfig, EventSinkConfig } from "../../agent/extensions.ts"

export type ApprovalMode = "confirm" | "full-auto"

/** Global layout: where the tab strip lives — a vertical rail on the left
 * ("sidebar", default) or the top row ("topbar"). docs/config.md "layout". */
export type LayoutMode = "topbar" | "sidebar"

/**
 * Per-model metadata override (docs/config.md "endpoints.<name>.models"):
 * a field set here wins over the models.dev enrichment; null/absent fields
 * fall through. Only the model's own id keys the map (endpoint-relative).
 */
export interface ModelOverride {
  contextLimit: number | null
  /** Hard INPUT-token ceiling (models.dev `limit.input`, e.g. gpt-5's 272000):
   * the preflight compaction treats `min(contextLimit, inputLimit)` as the
   * effective ceiling because the provider rejects a prompt over it even inside
   * a larger context window. */
  inputLimit: number | null
  reasoning: boolean | null
  /** Advertised effort keywords ("low","medium","high",...) — replaces models.dev's. */
  reasoningEfforts: string[] | null
  /** Anthropic-style reasoning token budget range (min/max). */
  reasoningBudgetMin: number | null
  reasoningBudgetMax: number | null
  toolCall: boolean | null
  /** false = the endpoint rejects a temperature for this model. */
  temperatureSupported: boolean | null
  /** Image input support (docs/agent.md "Images"); overrides models.dev. */
  vision: boolean | null
}

/**
 * The protocol family for an endpoint (docs/config.md "Endpoints and the
 * selected model"): the OpenAI-compatible chat-completions wire (the DEFAULT;
 * the legacy value "http" parses as this), OpenAI's Responses API, Anthropic,
 * Google Gemini, or the canned-reply "mock" test seam (SENSUS_MOCK=1 forces
 * mock regardless). Model construction + reasoning mapping per kind live in
 * `agent/provider/protocols.ts`.
 */
export type ProviderKind = "openai-compatible" | "openai-responses" | "anthropic" | "google" | "mock"

export interface EndpointConfig {
  name: string
  /** Where the requests go. Empty/missing resolves to the protocol's default
   * (protocols.ts `PROTOCOLS[kind].defaultBaseURL`). */
  baseURL: string
  /** The API key (config.json `endpoints.<name>.apiKey`). Empty = chat disabled. */
  apiKey: string
  temperature: number
  /**
   * Output cap sent as `maxOutputTokens` (docs/config.md "maxTokens").
   * `undefined` = auto: use the model's advertised output limit (models.dev
   * `limit.output`), and when that is unknown, OMIT the field so the endpoint
   * uses its own default. An explicit number always wins.
   */
  maxTokens?: number
  /** Protocol family for this endpoint (docs/config.md "Endpoints and the
   * selected model"). "openai-compatible" is the default; `canonicalProvider`
   * maps the legacy "http" onto it. "mock" is the canned test seam
   * (SENSUS_MOCK=1 forces mock regardless — docs/config.md). */
  provider: ProviderKind
  /** Thinking mode for reasoning models (docs/config.md "thinkingMode"). */
  thinkingMode?: string
  /** Optional per-model metadata overrides (keyed by bare model id). */
  models: Record<string, ModelOverride>
}

export interface ContextConfig {
  scrollbackLines: number
  enabled: boolean
  /** Auto-compaction near the model's context limit (docs/agent.md). */
  autoCompact: boolean
  /** Retained recent tokens beside a compaction checkpoint (OpenCode keep.tokens). */
  keepTokens: number
  /** Safety reserve below the context limit that triggers compaction early (OpenCode buffer). */
  bufferTokens: number
  /** Hard override for the model's context limit (tokens). `0` (default) =
   * "unlimited"/auto: resolve the endpoint override → models.dev → 128k
   * fallback. A positive value pins the limit. */
  contextLimit: number
}

/**
 * Chat display options (docs/config.md "chat"): how the sidebar presents
 * model reasoning ("thinking") and tool-call output, and whether run
 * animations (spinner frames) play at all. Sessions override the first two
 * via /thinking and /details.
 */
export interface ChatDisplayConfig {
  /** Reasoning display for thinking models: "hide" = collapsed one-liner
   * (click/`t` to expand, the default), "show" = expanded. */
  thinking: "show" | "hide"
  /** Tool-call output: "collapsed" = ~6-line preview + expand hint,
   * "expanded" = full output (pre-M10 behavior). */
  toolOutput: "collapsed" | "expanded"
  /** Run animations (spinner frames while streaming / tools / thinking). */
  animations: boolean
  /** Message card style: "fill" (default) = borderless themed panel;
   * "border" = rounded bordered card with no fill. */
  cardStyle: "fill" | "border"
  /** Provider round-trips (tool turns) allowed per user message. null = no
   * cap (the loop runs until the model stops or the user aborts). Default: null. */
  maxToolTurns: number | null
  /** What a message sent while a reply is still streaming does (docs/config.md
   * "chat"): "steer" injects it into the RUNNING turn at
   * the next safe boundary (the next model call / tool boundary), keeping the
   * run going; "queue" holds it and sends it as the next turn once the current
   * turn finishes. Enter uses this setting; Alt+Enter uses the other mode
   * (docs/keybindings.md "Chat focus"). Default "steer". */
  busySend: "steer" | "queue"
}

/** Auto session titles (docs/sessions.md "Auto titles"): on the first user
 * prompt, ask a model for a short title and write it to the sidecar. */
export interface SessionTitlesConfig {
  /** Master switch. `false` keeps only the derived (first-user-message) title. */
  enabled: boolean
  /** Model that writes the title: `<endpoint>@<model>` or a bare model id on
   * the session's endpoint. Empty = the session's selected model. */
  model: string
}

/** Agent memory (docs/memory.md): hard caps + write policy for the three stores. */
export interface MemoryConfig {
  /** false drops the memory tool + prompt block entirely. */
  enabled: boolean
  /** MEMORY.md character cap (always injected). */
  memoryCharLimit: number
  /** HOST.md character cap (tool-only). */
  hostCharLimit: number
  /** JOURNAL.md character cap (tool-only, ring-trimmed). */
  journalCharLimit: number
  /** true = memory writes are gated for approval in full-auto (confirm mode
   * already gates every tool) instead of auto-running. */
  writeApproval: boolean
  /** Prompt hint threshold: the agent is told to consolidate near this %. */
  consolidateAtPercent: number
  /** Refuse writes that look like they contain credentials. */
  redactSecrets: boolean
}

/**
 * Tool-output truncation thresholds (docs/config.md "tool_output"). A tool result over
 * either limit is spilled to disk and returned as a preview + pointer.
 */
export interface ToolOutputConfig {
  maxLines: number
  maxBytes: number
}

/** Rule outcome for the `permission` list (docs/config.md "permission"). */
export type PermissionAction = "allow" | "ask" | "deny"

/**
 * One `permission` rule (docs/config.md "permission"). `tool` is a tool name or
 * `"*"`; `pattern` is an optional glob (`*`/`?`) matched against the shell
 * command (`shell_background`) or the target path (`edit_file`/`write_file`/
 * `read_file`/`view_image`); absent = match any. Rules are evaluated in order
 * and the LAST matching rule wins.
 */
export interface PermissionRule {
  tool: string
  pattern?: string
  action: PermissionAction
}

/**
 * Compaction tuning (docs/config.md "compaction"). OpenCode key names.
 * `context.*` is parsed first and these keys OVERRIDE the matching
 * `context.*` values when present: `auto` → `autoCompact`,
 * `preserve_recent_tokens` → `keepTokens`, `reserved` → `bufferTokens`. Only
 * the genuinely new knobs live here; the aliases resolve into `context` at
 * load time so there is a single runtime source of truth.
 */
export interface CompactionConfig {
  /** Optional cache-invalidating prune pass (default false). */
  prune: boolean
  /** Always retain the tail covering at least this many recent user turns (0 = off). */
  tailTurns: number
}

/**
 * One condition trigger (docs/triggers.md): a local, opt-in watcher over the
 * v1 event stream. `on` is the v1 event type to match (or `"*"` for any);
 * `tool`/`session` are optional exact-match filters. A match appends a record
 * to `triggers.jsonl` and broadcasts a `trigger` WS event. The FIRST matching
 * rule wins. There is no egress (D8): a trigger only writes locally.
 */
export interface TriggerConfig {
  /** The v1 event type to match — one of `EVENT_V1_TYPES` — or `"*"` for any. */
  on: EventV1Type | "*"
  /** Optional tool-name filter (`tool.executed`/`file.changed`/`error.raised`). */
  tool?: string
  /** Optional exact chat-session-id filter (the v1 `session` field). */
  session?: string
}

/** Desktop notifications (docs/config.md "notifications"). */
export interface NotificationsConfig {
  enabled: boolean
  /** "bell" (terminal BEL) or "osc777" (rich OS notification where supported). */
  mode: "bell" | "osc777"
  /** Alert when a reply finishes while the user is elsewhere. */
  onFinish: boolean
  /** Alert when a tool approval card appears. */
  onApproval: boolean
}

export interface SensusConfig {
  /** Login shell for the embedded terminal: $SHELL, fallback zsh, fallback bash. */
  shell: string
  /** Sidebar width in columns (docs: default `SIDEBAR_DEFAULT_WIDTH`). */
  sidebarWidth: number
  /** Global layout: "sidebar" (a vertical tab rail on the left, default) or
   * "topbar" (tab strip on row 0). docs/config.md "layout". */
  layout: LayoutMode
  /** Vertical tab rail width in columns (resolved `tabs.width`, default 24);
   * used when layout is "sidebar". docs/config.md "layout". */
  tabRailWidth: number
  /** Auto chat-only view (docs/config.md "autoChatOnly", default true): a
   * narrow/mobile terminal (width at or below `AUTO_CHAT_ONLY_MAX_COLS`) starts
   * with the terminal pane hidden and the chat full-width. The manual Alt+Home
   * toggle overrides it for the session. */
  autoChatOnly: boolean
  /** Daemon idle policy (docs/config.md "daemon", D3/D9): a persistent daemon
   * never grace-exits; `SENSUS_DAEMON_PERSISTENT` overrides it. Default false. */
  daemonPersistent: boolean
  /** Launch update alert (docs/config.md "updateCheck", docs/operations.md
   * "Update"): check the latest release once a day and toast when a newer one
   * exists; `SENSUS_UPDATE_CHECK` overrides it. Default true. */
  updateCheck: boolean
  /** Global hotkey overrides, e.g. { "focus-toggle": "shift+tab" }. */
  keymap: Partial<Record<KeyActionId, string>>
  approval: ApprovalMode
  /** Default agent (a name from ~/.config/sensus/agents/); the agent picker
   * persists its picks here. Unknown names fall back at request time. */
  defaultAgent: string
  /** Persistent always-allow command prefixes (docs/agent.md approvals) —
   * shell_background commands starting with one skip the confirm gate. */
  allowPrefixes: string[]
  /** Ordered rule-based permission list (docs/config.md "permission"): the
   * last matching rule overrides the mode/tool baseline. */
  permission: PermissionRule[]
  /** Extra instruction sources (docs/config.md "instructions"): file paths,
   * `~/` paths, globs and `http(s)://` URLs merged with the global
   * `~/.config/sensus/AGENTS.md` into the system prompt. Resolved by
   * `src/agent/instructions.ts`; `/reload` re-resolves. */
  instructions: string[]
  context: ContextConfig
  /** Tool-output truncation thresholds (docs/config.md "tool_output"). */
  toolOutput: ToolOutputConfig
  /** Compaction aliases + the optional prune pass (docs/config.md "compaction"). */
  compaction: CompactionConfig
  /** Chat display options (docs/config.md "chat"): thinking, tool output, animations. */
  chat: ChatDisplayConfig
  /** Agent memory (docs/memory.md): caps + write policy for MEMORY/HOST/JOURNAL. */
  memory: MemoryConfig
  /** Auto session titles (docs/sessions.md "Auto titles"). */
  titles: SessionTitlesConfig
  /** Local condition triggers (docs/triggers.md): watch the v1 event stream
   * and record/broadcast matches. Empty (default) = no triggers. */
  triggers: TriggerConfig[]
  /** Desktop notifications (docs/config.md "notifications"). */
  notifications: NotificationsConfig
  /** Theme name (docs/config.md); unknown names fall back to "terminal". */
  theme: string
  /** Manual palette override (docs/config.md "themePalette"): per-entry color
   * pinning over the OSC 4 detection — for terminals that never answer or
   * answer with the wrong scheme. null = detection only. */
  themePalette: PaletteOverride | null
  /** MCP servers (M11, docs/mcp.md) — stdio commands and/or remote URLs. */
  mcp: McpConfig
  /** Extension seam (docs/extensions.md): the approval policy + event sink the
   * agent consults/emits through. Both default to no-op/local. */
  extensions: ExtensionsConfig
  /** All endpoints from the file (the model picker lists them all). */
  endpoints: Record<string, EndpointConfig>
  /** Selected model as `<endpoint>@<model-id>` (docs/config.md). */
  model: string
  /** Non-fatal problems collected during resolution (surface once as a toast). */
  warnings: string[]
  /** Validation problem (bad baseURL): index.tsx logs it and opens the setup
   * modal so the endpoint can be fixed in place (docs/operations.md). */
  bootError: string | null
}

export interface CliArgs {
  /** endpoint@model or bare model id (bare = keep the configured endpoint). */
  model?: string
  /** Switch the selected model's endpoint. */
  endpoint?: string
  baseURL?: string
  resume: boolean
  yolo: boolean
  sidebarWidth?: number
}

export interface SelectedModel {
  endpoint: string
  model: string
}
