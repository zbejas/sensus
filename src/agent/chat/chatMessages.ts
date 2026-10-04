/**
 * Chat data model: message/card shapes, session dependency interfaces and
 * the JSONL-records → display-messages rebuild. Pure module (no signals, no
 * provider I/O) so both the session store and the UI can import it freely.
 */

import type { DiffLine, AgentPane, ToolSpec } from "../tools.ts"
import type { ChatProvider, UsageInfo } from "../provider/provider.ts"
import type { ImageAttachment } from "../../core/image.ts"
import type { SessionFile, ChatRecord } from "../../session/store.ts"
import type { SensusConfig, McpConfig } from "../../config/config.ts"
import type { AgentsCatalog } from "../../config/agents.ts"
import type { SkillsCatalog } from "../skills/loader.ts"
import type { AuditBridge } from "../audit.ts"
import type { TerminalSnapshot } from "../context.ts"
import type { MemorySnapshot, MemoryToolBridge } from "../memory/types.ts"
import type { ApprovalPolicy, EventSink } from "../extensions.ts"
import type { SessionSearchBridge } from "../../session/indexDb.ts"
import type { ToastLevel } from "../../engine/toast.ts"
import { SLASH_COMMANDS } from "../slash.ts"

export type ChatRole = "user" | "assistant" | "system" | "error" | "tool"
export type ChatStatus = "idle" | "streaming" | "disabled"

export type ToolCardStatus = "pending" | "approved" | "running" | "done" | "error" | "rejected" | "aborted"

/** Card data rendered in chat for every tool call (docs/agent.md loop #4). */
export interface ToolCardData {
  callId: string
  name: string
  /** One-line params summary. */
  paramsSummary: string
  /** Full, untruncated approval-relevant detail (a gated shell command, an MCP
   * args blob) rendered wrapped on a pending card so the user never approves a
   * clipped command unseen (docs/agent.md "Approval modes"). Null when the
   * header summary already tells the whole story. */
  detail?: string | null
  status: ToolCardStatus
  /** shell_background exit code. */
  exitCode?: number | null
  /** Output preview (display; harder truncation than the model result). */
  output?: string | null
  /** Diff rows for edit_file/write_file cards. */
  diff?: DiffLine[] | null
  /** write_file: created (vs overwritten). */
  created?: boolean
  /** ask_user options. */
  options?: string[] | null
  question?: string | null
  /** ask_user answer once given. */
  answer?: string | null
  /** Destructive command (rm -rf-class) note. */
  destructive?: boolean
  /** Suggested session trust prefix — the card's OPERATION CLASS (an
   * arity-aware command prefix; "a" records it for this session). Null when the
   * call has no trustable class or is destructive/irreversible-exempt. */
  allowPrefix?: string | null
}

/** One line's decision inside an approval-batch plan (docs/agent.md
 * "Approval-batch plan card"). `pending` is only ever a destructive line that
 * has not been explicitly approved — a commit resolves it as rejected. */
export type PlanLineStatus = "pending" | "approved" | "rejected"

/** One call in an approval-batch plan, pre-evaluated before execution. */
export interface PlanLine {
  callId: string
  name: string
  /** One-line params summary (the same peek a single card shows). */
  paramsSummary: string
  /** Full, untruncated approval detail (the command / MCP args blob). */
  detail?: string | null
  /** Catastrophic-floor command: never covered by approve-all (explicit only). */
  destructive?: boolean
  /** Session-trust class offered for this line, if any. */
  allowPrefix?: string | null
  /** Planned file diff (edit_file / write_file) — reviewed before committing. */
  diff?: DiffLine[] | null
  created?: boolean
  status: PlanLineStatus
}

/**
 * The whole-turn approval plan (docs/agent.md "Approval-batch plan card"): when
 * ONE assistant turn yields ≥2 calls that would each gate in `confirm` mode,
 * they render as ONE ordered plan the user approves as a task. The pre-collected
 * per-line decisions are committed in a single step; execution then runs the
 * calls in their original order. Display + interaction state only (never sent
 * to the provider; lost on resume, where the individual result cards replay).
 */
export interface PlanCardData {
  lines: PlanLine[]
  /** Highlighted line for keyboard navigation. */
  cursor: number
  /** True once committed/cancelled; the card freezes to its outcome. */
  resolved?: boolean
  outcome?: "committed" | "aborted"
}

/** Live terminal facts the UI hands to the session (docs/agent.md context). */
export interface TerminalSnapshotForChat extends TerminalSnapshot {
  /** Real pane handle for shell_session/get_scrollback; null when unavailable. */
  pane: AgentPane | null
}

/**
 * First-user-prompt hook payload (docs/sessions.md "Auto titles"). The session
 * hands over the text + its selected endpoint/model; the host resolves the
 * title model (config.titles.model, else `endpoint`/`model`) and writes the
 * sidecar.
 */
export interface FirstPromptInfo {
  /** The first user message text (empty/image-only prompts are skipped). */
  text: string
  /** Absolute path of the session's transcript JSONL (the sidecar target). */
  path: string
  /** Session-selected endpoint (the default title model's endpoint). */
  endpoint: string
  /** Session-selected model id (the default title model). */
  model: string
  /** Aborts with the generation (Esc). */
  signal: AbortSignal
}

export interface ChatMessage {
  id: number
  role: ChatRole
  content: string
  ts: number
  /** Image attachments on a user message (docs/agent.md "Images"). */
  images?: ImageAttachment[]
  model?: string
  usage?: UsageInfo | null
  aborted?: boolean
  /** Model reasoning ("thinking") streamed before/around the content. */
  thinking?: string
  /** How long the model reasoned before content started (ms; null/undefined = n/a). */
  thinkingMs?: number | null
  /** When this assistant message finished (label duration; null while streaming). */
  finishedTs?: number | null
  /** system/error/tool bubbles never go to the provider as-is. */
  local?: boolean
  /** Tool call card (role "tool" only). */
  tool?: ToolCardData
  /** Approval-batch plan card (role "tool" only) — a ≥2-call turn pre-collected
   * into ONE approved-as-a-task card (docs/agent.md "Approval-batch plan card"). */
  plan?: PlanCardData
}

/**
 * The transport-agnostic chat event stream (IF3; docs/daemon-api.md "WebSocket
 * channels", docs/agent.md "Remote approval & event stream"). `ChatSession.subscribe`
 * fires one of these for every mutation a renderer would react to, so a daemon
 * (or any other host) can mirror a session without importing Solid signals.
 *
 * `message-added`/`message-updated` carry the WHOLE message (deltas are the
 * cheap streaming fast-path); a listener that ignores `delta` still converges at
 * settle because the final patch carries the full content. A throwing listener
 * is contained — an observer must never break a turn (AGENTS.md rule 10).
 */
export type ChatEvent =
  /** A message was appended (user/assistant/system/error/tool card/plan). */
  | { kind: "message-added"; message: ChatMessage }
  /** An existing message was patched (tool status/output/exitCode, plan, usage…). */
  | { kind: "message-updated"; message: ChatMessage }
  /** One streamed content/thinking fragment for a message. */
  | { kind: "delta"; messageId: number; field: "content" | "thinking"; text: string }
  /** The session status changed (idle/streaming/disabled). */
  | { kind: "status"; status: ChatStatus }
  /**
   * The session (tab) title changed — the derived first-message title or an
   * async model-generated title landing after the turn settled. Display-only:
   * the daemon folds it into `meta.sessionTitle`, so a client that never
   * handles this event still converges through `chat.meta`.
   */
  | { kind: "title"; title: string }
  /** A plan card was set or changed (the message carries the whole plan). */
  | { kind: "plan"; message: ChatMessage }
  /** An approval card became pending — the engine is blocked on a decision. */
  | { kind: "approval-request"; callId: string; tool: string; args: Record<string, unknown>; command: string | null; destructive: boolean }
  /** A pending approval was decided (accept/reject) or aborted. */
  | { kind: "approval-resolved"; callId: string; action: "accept" | "reject" | "aborted" }
  /** A sudo password is required to continue a tool call. */
  | { kind: "sudo-request"; requestId: string; command: string; prompt: string }
  /** The sudo prompt was answered; `ok:false` = declined/aborted. */
  | { kind: "sudo-resolved"; requestId: string; ok: boolean }
  /** An error bubble was appended (also carried as a `message-added`). */
  | { kind: "error"; message: string }
  /** The whole message list was replaced (/clear, or resume/restore). */
  | { kind: "reset"; messages: ChatMessage[] }

export interface ChatSessionDeps {
  /** Live config accessor (the /reload handler swaps what it returns). */
  getConfig: () => SensusConfig
  /** Catalog generation (models.dev prefetch / picker enrichment / reload).
   * Bumping it invalidates the session's memoized model metadata so a
   * pre-fetch 128k fallback gives way to the fetched window. Optional (tests). */
  catalogVersion?: () => number
  /** Provider for an endpoint — a GETTER BY NAME: the session's model pick
   * can switch endpoints mid-conversation, so nothing may bake one provider
   * in at creation; the host memoizes one per endpoint. */
  provider: (endpointName: string) => ChatProvider
  /** Current session file (replaced by rotateFile on /clear). */
  file: () => SessionFile
  /** Close the current file and open the next generation for this tab. */
  rotateFile: () => SessionFile
  /** Toast a UI-action note (the notification channel — such notes are NOT
   * transcript lines; docs/ui.md "Toasts"). Level defaults to info. */
  toast(message: string, level?: ToastLevel, ttlMs?: number): void
  /** Re-load config from disk; returns a toast message. */
  reloadConfig?(): string | null
  /** Fresh ~/.config/sensus/AGENTS.md contents for the system prompt. */
  getInstructions?(): string | null
  /** Agents catalog (~/.config/sensus/agents — docs/agents.md). Optional for
   * tests; the session falls back to the built-in copilot definition. */
  getAgents?(): AgentsCatalog
  /** Skills catalog (~/.config/sensus/skills — docs/skills.md). */
  getSkills?(): SkillsCatalog
  /** Audit/undo bridge (docs/agent.md "Undo & audit"). */
  audit?: AuditBridge
  /** Frozen MEMORY.md snapshot for the system prompt, captured ONCE at
   * ChatSession construction (docs/memory.md cache discipline). */
  getMemorySnapshot?(): MemorySnapshot | null
  /** Live memory store bridge for the `memory` tool (docs/memory.md). */
  memory?: MemoryToolBridge
  /** Session search bridge for the `session_search` tool (Phase 1.6). */
  sessionSearch?: SessionSearchBridge
  /** Persist the selected model `<endpoint>@<model>` to config.json (model
   * picker + /model). Returns an error message or null on success. */
  setSelectedModel?(endpoint: string, model: string): string | null
  /** Persist the default agent to config.json (agent picker + /agent). */
  setDefaultAgent?(name: string): string | null
  /** Called when streaming starts / stops. */
  onStatusChange?(status: ChatStatus): void
  /** Open a full-screen overlay (M5: /settings, /models; agents picker;
   * memory manager; session search; /init-wizard setup wizard). */
  openOverlay?(kind: "settings" | "models" | "agents" | "themes" | "memory" | "sessions" | "skills" | "context" | "usage" | "keymap" | "setup"): void
  /** Live theme name (may differ from config while a persist failed). */
  getTheme?(): string
  /** Apply + persist a theme switch; returns an error message or null. */
  applyTheme?(name: string): string | null
  /** /status extras (UI-owned runtime facts: terminal, focus, size, theme). */
  getRuntimeStatus?: () => string | null
  /**
   * MCP registry (M11, docs/mcp.md): tool specs merge into every request and
   * mcp__* calls route to it. Structural so tests stub it; when present but
   * `mcpEnabled()` is false (session toggle) the specs are omitted too.
   */
  mcp?: McpRegistryLike
  /** Sudo popup: ask the user for their sudo password (masked). Resolves
   * null when declined. Wired only when the agent resolves to
   * `sudoPrompt: popup` (explicit, or `auto` while approval is full-auto),
   * OR when a session password is already cached (so it retries silently in
   * any posture). The password is RAM-only and never model-facing. `hint` is
   * an optional line the popup shows to explain a re-prompt (e.g. after sudo
   * refused a wrong password). `requestId` is the engine-generated correlation
   * id surfaced on the `sudo-request` ChatEvent; a transport (the daemon) uses
   * it to answer `sudo.request` without inventing its own id. Ignored by the
   * TUI's popup. */
  requestSudo?(command: string, hint?: string, requestId?: string): Promise<string | null>
  /** True when a session sudo password is already cached in RAM. Lets a
   * later hidden-shell sudo failure reuse it silently — no new popup, no LLM
   * turn — even in a confirm/ask posture. */
  hasSudoPassword?(): boolean
  /** Drop the cached session sudo password (rejected/incorrect password, or
   * `/sudo forget`), so the next sudo failure can ask again. */
  clearSudoPassword?(): void
  /** Fires once when a session's FIRST user prompt is sent — the auto-title
   * seam (docs/sessions.md "Auto titles"). Best-effort and optional: tests
   * without it never pay for an extra provider request. */
  onFirstPrompt?(info: FirstPromptInfo): void
  /** Stable session id carried on emitted extension events (docs/extensions.md). */
  sessionId?: string
  /** Extensions approval policy (docs/extensions.md): consulted once per tool
   * call, after the built-in decision, before any card renders. A getter so a
   * `/reload` can swap it live. undefined/null = built-in behavior only. */
  approvalPolicy?: () => ApprovalPolicy | null
  /** Extensions event sink (docs/extensions.md): the audit-event stream. A
   * getter so a `/reload` can swap it live. undefined = no events. */
  eventSink?: () => EventSink | undefined
}

/** Per-server MCP status vocabulary (the status-bar chip's input). */
export type McpServerStatus = "idle" | "starting" | "connected" | "failed" | "disabled"

/** One configured MCP server's live state, for the UI (status bar). */
export interface McpServerStatusFact {
  name: string
  status: McpServerStatus
  toolCount: number
}

/** The registry surface ChatSession uses (McpRegistry satisfies it). */
export interface McpRegistryLike {
  /** Connected servers' tool specs (sync cache — [] when none). */
  currentSpecs(): ToolSpec[]
  /** Lazy connect pass; returns per-server failure messages ([] = ok). */
  ensureReady(cfg: McpConfig | undefined, signal: AbortSignal): Promise<string[]>
  /** Execute one mcp__<server>__<tool> call. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; result: string }>
  /** One line per configured server (/mcp, /status). */
  statusLines(): string[]
  /** Connected servers + tool names (system prompt facts). */
  connectedServerFacts(): Array<{ name: string; tools: string[] }>
  /** Read inside a tracked scope to repaint on any per-server status change. */
  statusVersion(): number
  /** Per-server `{name, status, toolCount}` snapshot (status bar). */
  serverStatuses(): McpServerStatusFact[]
}

/** Rebuild display messages from persisted records (resume path). */
export function recordsToMessages(records: readonly ChatRecord[]): ChatMessage[] {
  let n = 0
  return records.map((r) => {
    const now = Date.now()
    if (r.role === "user")
      return { id: ++n, role: "user", content: r.content, ts: now, ...(r.images !== undefined && r.images.length > 0 ? { images: r.images } : {}) }
    return {
      id: ++n,
      role: "assistant",
      content: r.content,
      ts: now,
      model: r.model,
      usage: r.usage ?? null,
      aborted: r.aborted ?? false,
      thinking: r.thinking ?? "",
    }
  })
}

/** Command list derived from the slash table (M8) — cannot drift from the
 * autocomplete menu, which renders the same entries. */
const HELP_COMMANDS = SLASH_COMMANDS.map((c) => {
  const left = `/${c.name}${c.usage.length > 0 ? ` ${c.usage}` : ""}`
  return `  ${left.padEnd(27)}${c.description}`
}).join("\n")

export const HELP_TEXT = `Sensus chat commands

${HELP_COMMANDS}

  Enter sends · Alt+Enter (or Shift+Enter) adds a line · Esc aborts a reply
  Tool cards: y accept · n reject · a trust this command class for the session
  Approval plan (≥2 gated calls): ↑/↓ move · space toggle · A/N approve/deny all · Enter commit
  Ctrl+O opens /settings from anywhere
  Ctrl+P opens the command menu (settings, theme, tabs, mode, approval)
  "/" opens the command autocomplete (Up/Down pick · Tab/Enter complete)`
