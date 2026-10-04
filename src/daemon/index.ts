/**
 * The daemon's local management API (D18; docs/daemon-api.md): the public
 * surface of `src/daemon/`. Import from this barrel, not the internals.
 */

export { createDaemonApp } from "./app.ts"
export type {
  DaemonAgentSummary,
  DaemonAppOptions,
  DaemonInfo,
  DaemonSkillSummary,
} from "./app.ts"
export { DOCS_PATH, DOCS_SPEC_PATH, daemonOpenApiConfig, docsTrailingSlashRedirect, isDocsPath } from "./openapi.ts"
export {
  errorSchema,
  internalErrorResponse,
  invalidRequestResponse,
  jsonResponse,
  notFoundResponse,
  textResponse,
  unauthorizedResponse,
} from "./apiSchemas.ts"
export type { ApiResponse } from "./apiSchemas.ts"
export { auditRoutes } from "./audit/routes.ts"
export {
  LegacyAuditJsonlSource,
  MergedAuditSource,
  defaultLegacyAuditPath,
  LEGACY_AUDIT_FILENAME,
} from "./audit/reader.ts"
export type { AuditSource } from "./audit/reader.ts"
export {
  AUDIT_STATS_KEY_MAX,
  CSV_COLUMNS,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  auditStats,
  clampAuditLimit,
  decodeCursor,
  encodeCursor,
  filterRecords,
  normalizeAuditEntry,
  normalizeEvent,
  paginate,
  sortNewestFirst,
  toCsv,
  toJsonl,
} from "./audit/query.ts"
export type { AuditPage, AuditQuery, AuditStats, AuditSourceLabel, NormalizedAuditRecord } from "./audit/query.ts"
export { bearerAuth, bearerFrom, safeEqual } from "./auth.ts"
export { REDACTED, readRedactedConfig, redactConfig } from "./config.ts"
export { mcpRoutes } from "./mcp.ts"
export type { McpRoutesDeps } from "./mcp.ts"
export { buildModelCatalog, endpointHasKey, modelRoutes, probeEndpointModels } from "./models.ts"
export type {
  BuildModelCatalogOptions,
  DaemonModelEndpoint,
  DaemonModelsResult,
  ModelRoutesDeps,
  ProbeEndpointInput,
  ProbeModelsResult,
} from "./models.ts"
export { applyConfigPatch, mergeConfigPatch, SECRET_NAME_RE, settingsRoutes } from "./settings.ts"
export type { ConfigPatchResult, SettingsRoutesDeps } from "./settings.ts"
export { buildUsageReport, MAX_USAGE_SESSIONS, USAGE_WINDOW_DAYS, usageRoutes } from "./usage.ts"
export type { BuildUsageReportOptions, DaemonUsageReport, UsageRoutesDeps, UsageSessionMeta } from "./usage.ts"
export { memoryRoutes, isMemoryAction, isMemoryTarget, MEMORY_ACTIONS, MEMORY_TARGETS } from "./memory.ts"
export type { DaemonMemoryAction, MemoryRoutesDeps } from "./memory.ts"
export {
  daemonEventsSocketPath,
  daemonLogJsonlPath,
  daemonLogPath,
  daemonPidPath,
  daemonRuntimeDir,
  daemonSocketPath,
  daemonTokenPath,
} from "./paths.ts"
export { ensureRuntimeDir, generateToken, readPidFile, readToken, writePidFile, writeToken } from "./token.ts"
export type { TokenResult } from "./token.ts"
export { ShellRegistry, SHELL_REPLAY_MAX_BYTES } from "./shells.ts"
export type {
  ShellAttachResult,
  ShellClient,
  ShellContextSource,
  ShellEventName,
  ShellFacts,
  ShellListEntry,
  ShellOpenOptions,
  ShellOpResult,
  ShellRegistryOptions,
  ShellRole,
} from "./shells.ts"
export { ChatRegistry } from "./chats.ts"
export type {
  ChatAnswerApprovalOptions,
  ChatListEntry,
  ChatMeta,
  ChatOpenOptions,
  ChatOpResult,
  ChatPendingSudo,
  ChatRegistryOptions,
  ChatSendMode,
  ChatSendResult,
  ChatState,
  DaemonChatEvent,
} from "./chats.ts"
export { createWsEndpoint, GraceWindow, resolveGraceMs, DEFAULT_DAEMON_GRACE_MS, WS_PROTOCOL } from "./ws.ts"
export type { WsEndpoint, WsEndpointDeps, WsSocketData } from "./ws.ts"
export {
  DaemonLifecycle,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_REATTACH_MAX_AGE_MS,
  REAP_INTERVAL_MS,
  resolveApprovalTimeoutMs,
  resolvePersistent,
  resolveReattachMaxAgeMs,
} from "./lifecycle.ts"
export { versionMismatchAction } from "./version.ts"
export { compiledEntry, daemonSelfArgv } from "./selfExec.ts"
export type { ClientGoneInfo, DaemonLifecycleDeps } from "./lifecycle.ts"
export {
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_NAME,
  SYSTEMD_UNIT_NAME,
  installService,
  realRunner,
  renderLaunchdPlist,
  renderServiceUnit,
  renderSystemdUnit,
  serviceUnitDir,
  serviceUnitFileName,
  serviceUnitKind,
  serviceUnitPath,
  uninstallService,
} from "./service.ts"
export type {
  CommandResult,
  CommandRunner,
  ServiceCommandOptions,
  ServiceIo,
  ServiceUnitKind,
  ServiceUnitSpec,
} from "./service.ts"
export {
  TOOL_EVENT_TYPES,
  TRIGGER_LOG_MAX_BYTES,
  TRIGGER_QUEUE_MAX,
  TRIGGER_ROTATED_SUFFIX,
  TRIGGER_SCHEMA_VERSION,
  TriggerEngine,
  createTriggerSink,
  matchRule,
  matchTrigger,
} from "./triggers.ts"
export type { FlushableEventSink, TriggerEngineOptions, TriggerRecord } from "./triggers.ts"
export { DEFAULT_DAEMON_HOST, displayHost, resolveDaemonBind, startDaemon } from "./serve.ts"
export type { StartDaemonOptions, StartDaemonResult } from "./serve.ts"
export {
  DEFAULT_SESSION_LIMIT,
  DEFAULT_SESSION_MESSAGES,
  MAX_SESSION_LIMIT,
  MAX_SESSION_MESSAGES,
  SESSION_EXPORT_FORMATS,
  clampOffset,
  clampSessionLimit,
  clampSessionMessages,
  exportSession,
  isSafeSessionSegment,
  listSessions,
  readSession,
  resolveSessionPath,
  sessionTabFromBase,
} from "./sessions.ts"
export type {
  SessionExport,
  SessionExportFormat,
  SessionListPage,
  SessionReadPage,
  SessionSummary,
} from "./sessions.ts"
export { sessionRoutes } from "./sessions/routes.ts"
export type { SessionRoutesDeps } from "./sessions/routes.ts"
export { requestOverUnix, runDaemon } from "./cli.ts"
export type { DaemonIo, DaemonRunResult, HttpResult } from "./cli.ts"
export { KILL_USAGE, commandLineLooksLikeDaemonServe, isDaemonServeArgv, runKill, scanDaemonProcesses } from "./kill.ts"
export type { DaemonProcess, DaemonScanResult, KillIo, RunKillOptions, ScanDaemonOptions } from "./kill.ts"
export { logStrictEnabled } from "./logStrict.ts"
