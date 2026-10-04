/**
 * The headless engine surface (IF1; docs/architecture.md "engine/").
 *
 * The engine is the whole of sensus that does not touch the renderer: the
 * agent chat loop, sessions, memory, skills, MCP, tools/approvals, audit,
 * host scan, usage roll-ups, config, the PTY session + byte scanner, and the
 * transport-agnostic helpers the UI renders from. A daemon (or a test) imports
 * THIS barrel and drives a full turn with no renderer.
 *
 * Dependency direction is one-way: `ui → engine`. Nothing under `src/engine/**`
 * (or `src/agent/**`, `src/config/**`, `src/session/**`, `src/terminal/**`)
 * imports `src/ui/**` — enforced by `tests/unit/engine/importGraph.test.ts`.
 *
 * The surface is mostly explicit so the inter-phase contract is reviewable;
 * `config` and `tools` re-export their existing public barrels wholesale (the
 * same barrels the TUI already treats as the stable API).
 */

// ---- helpers the UI renders from (moved down from ui/) ---------------------

export { InputEditor, visualToCursor, wrapEditorLine, type EditorRow } from "./chat/inputEditor.ts"
export { cps } from "./chat/inputEditor.ts"
export {
  acceptCompletion,
  isExactCommandQuery,
  menuWindow,
  slashMenuForLine,
  type SlashMenuState,
} from "./chat/slashComplete.ts"
export { StreamReveal } from "./chat/streamReveal.ts"
export {
  breakdownRows,
  emptyContextBreakdown,
  firstLine,
  formatContextBreakdown,
  formatHistoryRow,
  historyPreview,
  historyRoleTag,
  historyWindow,
  messagePreview,
  toolCallSummary,
  usageBar,
  type ContextBreakdown,
  type ContextHistoryEntry,
  type ContextHistoryWindow,
  type ContextRow,
  type ContextUsageBar,
} from "./chat/contextInspector.ts"
export {
  aggregateUsage,
  buildUsageChart,
  estimatedCost,
  formatTokenCount,
  formatUsageRow,
  isUsageDayKey,
  sumRollups,
  usageChartLegend,
  usageSegments,
  type PriceTable,
  type UsageChart,
  type UsageRollup,
  type UsageRow,
  type UsageSample,
  type UsageSegments,
  type UsageSpan,
  type UsageTone,
} from "./chat/usage.ts"
export {
  fuzzyScore,
  matchIndices,
  matchSegments,
  type MatchSegment,
} from "./fuzzy.ts"
export {
  defaultTtl,
  shouldPreemptToast,
  toastGlyph,
  toastSeverity,
  toastToken,
  type Toast,
  type ToastLevel,
} from "./toast.ts"
export { spinnerChar, spinnerFrame, SPINNER_FRAMES, SPINNER_INTERVAL_MS, SPINNER_STATIC } from "./spinner.ts"

// ---- chat ------------------------------------------------------------------

export { ChatSession } from "../agent/chat/chatSession.ts"
export type {
  ChatEvent,
  ChatMessage,
  ChatRole,
  ChatSessionDeps,
  ChatStatus,
  PlanCardData,
  PlanLine,
  PlanLineStatus,
  TerminalSnapshotForChat,
  ToolCardData,
  ToolCardStatus,
} from "../agent/chat/chatSession.ts"
export { recordsToMessages } from "../agent/chat/chatSession.ts"
export { reconstructHistoryEntries } from "../agent/chat/contextHistory.ts"
export { ChatHost, type ChatHostOptions, type ConfigChangeKind } from "../agent/chat/chatHost.ts"

// ---- config ----------------------------------------------------------------

export * from "../config/config.ts"

// ---- sessions --------------------------------------------------------------

export {
  SessionFile,
  loadSessionFile,
  listSessionFiles,
  listRecentSessions,
  listAllSessions,
  makeInstanceId,
  sessionsRoot,
  sessionFilePath,
  type ChatRecord,
  type LoadedSession,
  type LoadedToolCall,
} from "../session/store.ts"
export {
  deriveTitleFromText,
  readSessionMeta,
  sessionToMarkdown,
  type SessionMeta,
} from "../session/meta.ts"
export { SessionIndex } from "../session/indexDb.ts"

// ---- memory ----------------------------------------------------------------

export { MemoryStore } from "../agent/memory/store.ts"
export {
  HOST_SCAN_COMMANDS,
  HOST_SCAN_OUTPUT_CAP,
  formatHostScan,
  redactScanOutput,
  type HostScanEntry,
} from "../agent/memory/hostScan.ts"
export type {
  MemoryAction,
  MemoryLimits,
  MemoryResult,
  MemorySnapshot,
  MemoryTarget,
  MemoryToolBridge,
  MemoryUsage,
  MemoryWriteInfo,
} from "../agent/memory/types.ts"

// ---- agents (read-only listing for the daemon; docs/daemon-api.md) ---------

export { loadAgents, type AgentDef, type AgentsLoadResult } from "../config/agents.ts"

// ---- skills ----------------------------------------------------------------

export {
  loadSkills,
  skillsIndexText,
  filterSkillsForAgent,
  skillSlug,
  parseSkillFile,
  type SkillDef,
  type SkillsCatalog,
} from "../agent/skills/loader.ts"

// ---- provider protocols (docs/agent.md "Provider client") ------------------
// The UI's wizard/settings read the protocol labels + defaults; the config
// resolves canonical kinds through the same helpers (IF1 surface).
export {
  PROTOCOL_KINDS,
  PROTOCOLS,
  canonicalProvider,
  isProtocolKind,
  resolveBaseURL,
  type ProtocolInfo,
  type ProtocolKind,
} from "../agent/provider/protocols.ts"

// ---- model catalog (P4c-ii: the daemon serves `/v1/models`) ----------------

export {
  enrichModels,
  fetchModels,
  formatContextLimit,
  loadModelsDevProviders,
  matchModelId,
  mergeModelOverride,
  mergeNativeMeta,
  parseAnthropicModelsResponse,
  parseGoogleModelsResponse,
  parseModelsResponse,
  parseThinkingMode,
  warmModelsDevCache,
  type CatalogModel,
  type EndpointModel,
  type ModelFetchEndpoint,
  type ModelMeta,
  type NativeModelMeta,
  type ReasoningOption,
} from "../agent/provider/modelCatalog.ts"

// ---- pure UI-shared helpers (client-safe; no engine runtime) ----------------
export { formatTokens } from "../agent/chat/compaction.ts"
export { trustChipLabel } from "../agent/tools/approval.ts"
export {
  renderMarkdown,
  wrapLines,
  plain,
  textLine,
  linkifyLines,
  type MdLine,
  type Seg,
  type SegStyle,
} from "../agent/markdown.ts"
// Setup/settings helpers the overlays need without importing config runtime.
export * from "../config/wizard.ts"
export { readRawConfig, type RawConfigDoc } from "../config/configFile.ts"
export type { SlashCommandInfo } from "../agent/slash.ts"

// ---- mcp -------------------------------------------------------------------

export { McpRegistry } from "../agent/mcp/registry.ts"
export type {
  McpCallResult,
  McpServerFact,
  McpServerStatus,
  McpServerStatusFact,
} from "../agent/mcp/registry.ts"

// ---- tools + approvals -----------------------------------------------------

export * from "../agent/tools.ts"
// The pane askpass broker: the daemon injects its stable helper path into the
// visible pane's env so a `shell_session` `sudo -A` can authenticate
// (docs/agent.md "Sudo", docs/terminal-layer.md "PTY core vs renderable").
export { sudoAskpassBroker } from "../agent/sudoAskpass.ts"

// ---- extensions seam (public API; docs/extensions.md) ----------------------

export {
  consultApprovalPolicy,
  createApprovalPolicy,
  createEventSink,
  JsonlEventSink,
  NoopEventSink,
  UdsEventSink,
  toEventV1,
  EVENT_FIELD_MAX,
  EVENT_SCHEMA_VERSION,
  EVENT_TARGET_MAX,
  EVENT_V1_TYPES,
  JSONL_EVENT_MAX_BYTES,
  JSONL_EVENT_QUEUE_MAX,
  JSONL_EVENT_ROTATED_SUFFIX,
  UDS_EVENT_QUEUE_MAX,
  UDS_RECONNECT_MS,
  type ApprovalPolicy,
  type ApprovalPolicyConfig,
  type ApprovalPolicyContext,
  type ApprovalPolicyDecision,
  type ApprovalPolicyFactory,
  type CommandApprovedEvent,
  type CommandDeniedEvent,
  type CommandRanEvent,
  type CreateEventSinkOptions,
  type ErrorRaisedEvent,
  type EventSink,
  type EventSinkConfig,
  type EventSinkFactory,
  type EventV1,
  type EventV1Type,
  type ExtensionsConfig,
  type FileChangeEvent,
  type FileChangedV1,
  type JsonlEventSinkOptions,
  type MemoryWriteEvent,
  type MemoryWrittenV1,
  type SensusEvent,
  type SessionEndEvent,
  type SessionEndedV1,
  type SessionStartEvent,
  type SessionStartedV1,
  type SkillUseEvent,
  type SkillUsedV1,
  type ToolExecutedV1,
  type TurnCompleteEvent,
  type TurnCompletedV1,
  type ErrorRaisedV1,
} from "../agent/extensions.ts"

// ---- audit -----------------------------------------------------------------

export { AuditLog } from "../agent/audit.ts"
export type { AuditEntry, AuditBridge } from "../agent/audit.ts"

// ---- terminal (headless PTY session + byte scanner) ------------------------
//
// The engine exports the RENDERER-FREE `PtySession`; the embedded-VT
// `TerminalSession` is client-only (`@opentui/core`) and lives in
// `src/terminal/session.ts` for the UI. The import-graph guard fails if the
// engine barrel ever pulls `@opentui/core` back in.

export { PtySession, type PtySessionOptions, type TerminalStatus } from "../terminal/ptySession.ts"
export { StreamScanner, TextRing, parseOsc7 } from "../terminal/scan.ts"
export { shellLaunchArgv } from "../terminal/launch.ts"
