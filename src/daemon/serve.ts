/**
 * Start the daemon's two listeners (D7; docs/daemon-api.md): a Unix socket
 * (filesystem perms + token) and a loopback TCP listener (bearer token). Never a
 * public bind. Modelled on `src/agent/extensions.ts`'s UDS ergonomics: bind
 * failures are returned, not thrown, and the caller owns `stop()` — no process
 * signal handlers, so this stays embeddable and testable.
 */

import { chmodSync, rmSync } from "node:fs"
import { networkInterfaces } from "node:os"
import {
  ChatHost,
  createEventSink,
  eventsPath,
  JsonlEventSink,
  loadConfig,
  loadOrCreateInstance,
  makeInstanceId,
  memoryDir,
  MemoryStore,
  sensusDataDir,
  sensusHome,
  sudoAskpassBroker,
  triggersPath,
  warmModelsDevCache,
  type EventSink,
  type SensusConfig,
  type SensusInstance,
  type TriggerConfig,
} from "../engine/index.ts"
import { SENSUS_VERSION } from "../version.ts"
import { errorMessage } from "../core/util.ts"
import { configureLogger, flushLoggerSync, getLogger, withCorrelation, type Logger } from "../core/log.ts"
import { createDaemonApp, type DaemonInfo } from "./app.ts"
import { LegacyAuditJsonlSource, type AuditSource } from "./audit/reader.ts"
import { ChatRegistry } from "./chats.ts"
import { readRedactedConfig } from "./config.ts"
import { buildModelCatalog, probeEndpointModels } from "./models.ts"
import { daemonLogJsonlPath, daemonRuntimeDir, daemonSocketPath, daemonTokenPath } from "./paths.ts"
import { ShellRegistry } from "./shells.ts"
import { buildUsageReport } from "./usage.ts"
import { createWsEndpoint, resolveGraceMs, type WsSocketData } from "./ws.ts"
import { createTriggerSink, TriggerEngine, type TriggerRecord } from "./triggers.ts"
import { DaemonLifecycle, resolveApprovalTimeoutMs, resolvePersistent, resolveReattachMaxAgeMs } from "./lifecycle.ts"
import { ensureRuntimeDir, generateToken, writeToken } from "./token.ts"
import type { PtySession, PtySessionOptions } from "../engine/index.ts"

export interface StartDaemonOptions {
  /** Defaults to `daemonRuntimeDir()` (the `SENSUS_RUNTIME_DIR` seam). */
  runtimeDir?: string
  /** Defaults to a freshly generated token. */
  token?: string
  /** Ignored unless it is a loopback name; always defaults to `127.0.0.1`. */
  host?: string
  /** `0` (default) asks the kernel for an ephemeral port. */
  port?: number
  /** Test seam: overrides the config-derived `MemoryStore` factory. */
  memoryStore?: () => MemoryStore
  /** Test seam: overrides the config-derived event sink. */
  events?: EventSink
  /** Test seam: overrides the trigger rules (defaults to `config().triggers`). */
  triggers?: readonly TriggerConfig[]
  /** Test seam: overrides the triggers log path (defaults to `<dataDir>/triggers.jsonl`). */
  triggerLogPath?: string
  /** Test seam: overrides the audit query source (defaults to legacy JSONL). */
  auditSource?: AuditSource
  /** Test seam: overrides the sessions data dir (defaults to `sensusDataDir()`). */
  dataDir?: string
  /** Test seam: overrides the redacted-config getter (defaults to the real config). */
  config?: () => Record<string, unknown>
  /** Boot-time resolved config handed to the engine `ChatHost` (defaults to
   * `loadConfig`). Injecting it points a test's chats at a mock endpoint. */
  initialConfig?: SensusConfig
  /** Test seam: use a pre-built `ChatHost` instead of constructing one. */
  chatHost?: ChatHost
  /** Test seam: instance id for the engine `ChatHost` (chat session ids). */
  chatInstanceId?: string
  /**
   * Warm the models.dev catalog at boot (docs/config.md "Model catalog cache").
   * The `sensus daemon` CLI turns it on; it defaults OFF so `startDaemon`
   * callers (unit tests, embedders) stay hermetic and never hit the network.
   */
  warmCatalog?: boolean
  /** Test seam: config home for the agents/skills listings. */
  home?: string
  /** Flag list used to resolve config; defaults to the daemon's own args. */
  argv?: readonly string[]
  /** Default shell for `terminal.open`; defaults to the config `shell` (`$SHELL`). */
  shell?: string
  /** Test seam: default cwd for spawned shells. */
  cwd?: string
  /** Test seam: overrides the PTY spawner used by the shell registry. */
  spawnPty?: (opts: PtySessionOptions) => PtySession
  /** Test seam: raw-replay ring cap in bytes (defaults to `SHELL_REPLAY_MAX_BYTES`). */
  replayMaxBytes?: number
  /** Test seam: overrides the `SENSUS_DAEMON_GRACE_MS` grace window. */
  graceMs?: number
  /** Test seam: overrides the `SENSUS_DAEMON_APPROVAL_TIMEOUT_MS` hold. */
  approvalTimeoutMs?: number
  /** Test seam: overrides `SENSUS_DAEMON_PERSISTENT` / the config flag. */
  persistent?: boolean
  /** Test seam: overrides `SENSUS_DAEMON_REATTACH_MAX_AGE_MS` (the idle reaper
   * window). `0` disables reaping. */
  reattachMaxAgeMs?: number
  /** Test seam: overrides the idle-reaper tick interval (ms). */
  reapIntervalMs?: number
  /** Fired when the idle policy shuts the daemon down (D9). The foreground CLI
   * uses it to remove the pidfile and exit 0. */
  onIdleExit?: () => void
}

export type StartDaemonResult =
  | {
      ok: true
      unix: string
      tcp: { host: string; port: number }
      token: string
      /** The live shell registry (tests/lifecycle; D4/D11/D12). */
      registry: ShellRegistry
      stop: () => void
    }
  | { ok: false; error: string }

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

/** Default TCP bind host — loopback (D7/D14). */
export const DEFAULT_DAEMON_HOST = "127.0.0.1"

/** Only ever loopback; anything else (notably `0.0.0.0`) is coerced to `127.0.0.1`. */
function loopbackOnly(host: string | undefined): string {
  return host !== undefined && LOOPBACK_HOSTS.has(host) ? host : DEFAULT_DAEMON_HOST
}

/** Parse a `SENSUS_DAEMON_PORT` value; null when unset or not a valid port. */
function parseDaemonPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null
  return n
}

const VALID_LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error"])

/** `SENSUS_LOG_LEVEL` when it is one of the five valid levels, else `"info"`. */
function resolveLogLevel(env: NodeJS.ProcessEnv): "trace" | "debug" | "info" | "warn" | "error" {
  const raw = env["SENSUS_LOG_LEVEL"]?.trim().toLowerCase()
  return raw !== undefined && VALID_LOG_LEVELS.has(raw) ? (raw as "trace" | "debug" | "info" | "warn" | "error") : "info"
}

/**
 * Resolve the TCP bind. Loopback (D7/D14) is the default, and `opts.host`/
 * `opts.port` stay coercible test seams — non-loopback through them is coerced
 * back. The **deliberate opt-in** is `SENSUS_DAEMON_HOST` (+ `SENSUS_DAEMON_PORT`),
 * which lets a LAN/Tailscale address (or `0.0.0.0`) be bound without a code
 * change; it is never on by default. The REST/WS API stays bearer-gated; only
 * the docs surface is unauthenticated.
 */
export function resolveDaemonBind(
  env: NodeJS.ProcessEnv,
  opts: { host?: string; port?: number } = {},
): { host: string; port: number } {
  const envHost = typeof env["SENSUS_DAEMON_HOST"] === "string" ? env["SENSUS_DAEMON_HOST"].trim() : ""
  const host = envHost.length > 0 ? envHost : loopbackOnly(opts.host)
  const port = opts.port ?? parseDaemonPort(env["SENSUS_DAEMON_PORT"]) ?? 0
  return { host, port }
}

/**
 * A host a human can actually open in a browser: a wildcard bind (`0.0.0.0`/`::`)
 * resolves to the machine's first non-internal IPv4, else loopback.
 */
export function displayHost(host: string): string {
  if (host !== "0.0.0.0" && host !== "::" && host !== "::0") return host
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address
    }
  }
  return DEFAULT_DAEMON_HOST
}

/** Map the config memory section onto the store's hard caps (same mapping as chatHost). */
function memoryLimits(cfg: SensusConfig["memory"]) {
  return { memory: cfg.memoryCharLimit, host: cfg.hostCharLimit, journal: cfg.journalCharLimit }
}

/**
 * Extra env for pane shells: the stable askpass helper path, when a tmpfs base
 * is usable. The broker lives in this daemon process and the executor arms the
 * same instance, so the pane's `sudo -A` reads the secret the agent stages
 * (docs/agent.md "Sudo"). Returns undefined when no helper could be created,
 * leaving the shell to fall back to its own sudo prompt.
 */
function paneShellEnv(): Record<string, string | undefined> | undefined {
  try {
    const helper = sudoAskpassBroker.helperPath()
    return helper !== null ? { SUDO_ASKPASS: helper } : undefined
  } catch (e) {
    getLogger().child({ component: "daemon.serve" }).debug("askpass helper path unavailable", { err: e })
    return undefined
  }
}

/**
 * The daemon's default event sink (D13; docs/events.md). The daemon OWNS the
 * durable event log, so the engine's `noop` default means "use the built-in
 * JSONL sink", not "drop everything"; `uds` honours a configured local
 * receiver, and `jsonl` selects the log explicitly (with an optional path).
 */
function daemonEventSink(cfg: SensusConfig["extensions"]["eventSink"], opts: { instanceId: string; dataDir: string }): EventSink {
  if (cfg.kind === "uds" && typeof cfg.path === "string" && cfg.path.length > 0) return createEventSink(cfg, opts)
  const path = cfg.kind === "jsonl" && typeof cfg.path === "string" && cfg.path.trim().length > 0 ? cfg.path.trim() : eventsPath(opts.dataDir)
  return new JsonlEventSink({ path, instanceId: opts.instanceId })
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<StartDaemonResult> {
  const runtimeDir = opts.runtimeDir ?? daemonRuntimeDir()
  const socketPath = daemonSocketPath(runtimeDir)
  const tokenPath = daemonTokenPath(runtimeDir)

  const dir = ensureRuntimeDir(runtimeDir)
  if (!dir.ok) return { ok: false, error: dir.error ?? `cannot create runtime dir ${runtimeDir}` }

  const token = opts.token ?? generateToken()
  const wrote = writeToken(tokenPath, token)
  if (!wrote.ok) return { ok: false, error: wrote.error ?? `cannot write token ${tokenPath}` }

  // A socket left behind by a crashed process makes bind fail with EADDRINUSE.
  try {
    rmSync(socketPath, { force: true })
  } catch (e) {
    // best-effort: a missing/undeletable path surfaces at bind time
    getLogger().child({ component: "daemon.serve" }).debug("stale socket unlink failed", { err: e, socket: socketPath })
  }

  const startedAt = Date.now()
  const bind = resolveDaemonBind(process.env, { host: opts.host, port: opts.port })
  const host = bind.host
  const requestedPort = bind.port
  let tcpServer: Bun.Server<WsSocketData> | undefined

  const dataDir = opts.dataDir ?? sensusDataDir()
  const homeDir = opts.home ?? sensusHome()
  // Machine identity (D13; docs/events.md): the daemon owns instance.json. A
  // valid file is reused verbatim (stable across restarts/upgrades); only the
  // `version` refreshes on upgrade. Corrupt/missing regenerates.
  const instance: SensusInstance = loadOrCreateInstance(homeDir, SENSUS_VERSION)

  // Structured logging (docs/operations.md): one NDJSON record per line at
  // `<runtimeDir>/daemon-log.jsonl`, distinct from `daemon.log` (the detached
  // process's raw stdio banner). The boot bearer token is redacted by literal
  // value so it can never appear in a record.
  configureLogger({
    path: daemonLogJsonlPath(runtimeDir),
    level: resolveLogLevel(process.env),
    instanceId: instance.instanceId,
    component: "daemon",
    redact: [token],
  })
  const log: Logger = getLogger()

  const info = (): DaemonInfo => ({
    ok: true,
    name: "sensus-daemon",
    version: SENSUS_VERSION,
    pid: process.pid,
    platform: process.platform,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    socket: socketPath,
    tcp: { host: tcpServer?.hostname ?? host, port: tcpServer?.port ?? requestedPort },
    /** Live PTY shells the daemon owns (D4/D21). */
    shells: registry.list().length,
    /** Never grace-exit (D3/D9). */
    persistent,
    /** The machine/installation identity (docs/events.md). */
    instance,
  })

  // Resolved once, lazily: a test that injects both overrides never reads config.
  const configArgv = opts.argv ?? process.argv.slice(2)
  let cachedConfig: SensusConfig | undefined
  const config = (): SensusConfig => (cachedConfig ??= loadConfig(configArgv))

  // Per-request factory (never cached) so a config reload is reflected; caps +
  // safety come from the same `MemoryStore` the TUI uses (docs/memory.md).
  const memoryStore =
    opts.memoryStore ??
    ((): MemoryStore => {
      const cfg = config().memory
      return new MemoryStore({ dir: memoryDir(homeDir), limits: memoryLimits(cfg), redactSecrets: cfg.redactSecrets })
    })
  // The daemon's durable local event log (docs/events.md). A test may inject its
  // own sink; otherwise the daemon defaults to the v1 JSONL sink (the engine's
  // `noop` default means "the daemon's log", D13). The sink is then decorated so
  // the local condition triggers (docs/triggers.md) see the same v1 events the
  // log does. `broadcastTrigger` is wired to the WS endpoint once it exists.
  let broadcastTrigger: (record: TriggerRecord) => void = () => {}
  const triggerEngine = new TriggerEngine({
    rules: opts.triggers ?? config().triggers,
    path: opts.triggerLogPath ?? triggersPath(dataDir),
    onMatch: (record: TriggerRecord) => broadcastTrigger(record),
  })
  const baseEvents = opts.events ?? daemonEventSink(config().extensions.eventSink, { instanceId: instance.instanceId, dataDir })
  const events = createTriggerSink(baseEvents, triggerEngine, instance.instanceId)
  const audit = opts.auditSource ?? new LegacyAuditJsonlSource()

  // The daemon owns the shells (D1): a registry per daemon, the user's shell as
  // the default. The config `shell` is resolved lazily so a reload is honoured.
  const registry = new ShellRegistry({
    defaultShell: opts.shell !== undefined ? () => opts.shell as string : () => config().shell,
    cwd: opts.cwd,
    spawn: opts.spawnPty,
    ...(opts.replayMaxBytes !== undefined ? { replayMaxBytes: opts.replayMaxBytes } : {}),
    // The pane is the user's real shell; its env is fixed at spawn, so the
    // stable `SUDO_ASKPASS` helper path must be present now or a later
    // `shell_session` `sudo -A` has nothing to run (docs/agent.md "Sudo").
    env: paneShellEnv(),
  })

  // The daemon hosts the agent chat (P3c-ii; D13). The `ChatHost` is built
  // LAZILY on the first chat op, so a terminal-only daemon never reads the
  // config home or materializes agents/memory. `requestSudo` routes a prompt to
  // the WS `sudo.request`/`sudo.answer` round-trip through the registry (the
  // same dep the TUI's popup implements).
  let chatsRef: ChatRegistry | undefined
  // models.dev catalog generation (docs/config.md): the boot warm below bumps
  // it when the index lands, so a session that resolved a pre-fetch
  // 128k/no-metadata value re-resolves its context window and reasoning knobs.
  let catalogVersion = 0
  const chats = new ChatRegistry({
    shells: registry,
    host:
      opts.chatHost ??
      (() =>
        new ChatHost({
          dataDir,
          instanceId: opts.chatInstanceId ?? makeInstanceId(Date.now(), process.pid),
          initialConfig: opts.initialConfig ?? config(),
          argv: configArgv,
          catalogVersion: () => catalogVersion,
          toast: (m: string, level?: string, ttl?: number) => chats.notifyToast(m, level, ttl),
          // Route the engine's seam events into the daemon's own sink (the v1
          // JSONL log by default; docs/events.md). The daemon owns the sink.
          eventSinkFactory: () => events,
          requestSudo: (command, hint, requestId) =>
            chatsRef?.requestSudo(command, hint, requestId) ?? Promise.resolve(null),
        })),
  })
  chatsRef = chats

  // One tab = one shell = one chat (D1): when a shell EXITS (a pane `exit`/
  // `terminal.kill`, not a client detach) its bound chat is unreachable, so the
  // daemon releases it — no orphan chats linger and an in-flight turn cannot
  // keep generating invisibly.
  registry.onShellExit((shellId) => {
    try {
      chats.closeForShell(shellId)
    } catch (e) {
      // a release failure must never break the PTY exit path
      log.child({ component: "daemon.serve" }).warn("closeForShell on shell exit failed", { err: e, shellId })
    }
    // Re-evaluate the idle clock: losing the last shell may be the moment the
    // daemon can finally grace-exit (the policy holds while shells live).
    try {
      lifecycle.shellsChanged()
    } catch (e) {
      // the lifetime policy must never break the PTY exit path
      log.child({ component: "daemon.serve" }).warn("lifecycle.shellsChanged failed", { err: e, shellId })
    }
  })

  // The lifetime policy (P3c-iii; D3/D4/D9/D10): the grace/idle exit, the
  // detached-turn keep-alive, and the no-client approval hold. `chats` feeds it
  // every engine event; `stopRef` lets the policy shut the daemon down cleanly
  // (it is assigned once `stop` exists, below).
  const graceMs = opts.graceMs ?? resolveGraceMs(process.env)
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? resolveApprovalTimeoutMs(process.env)
  const persistent = opts.persistent ?? resolvePersistent(process.env, config().daemonPersistent)
  const reattachMaxAgeMs = opts.reattachMaxAgeMs ?? resolveReattachMaxAgeMs(process.env)
  let stopRef: () => void = () => {}
  const lifecycle = new DaemonLifecycle({
    graceMs,
    approvalTimeoutMs,
    persistent,
    reattachMaxAgeMs,
    ...(opts.reapIntervalMs !== undefined ? { reapIntervalMs: opts.reapIntervalMs } : {}),
    anyTurnRunning: () => chats.anyTurnRunning(),
    pendingPromptChats: () => chats.pendingPromptChats(),
    denyPending: (chatId) => chats.denyPending(chatId),
    abortTurn: (chatId) => chats.abortTurn(chatId),
    // The daemon owns the visible panes (D1, locked #6): while a live shell
    // exists it must not idle-exit and reap it, so a killed/restarted client can
    // re-attach and a running command survives (docs/daemon-api.md "Lifecycle").
    hasLiveShells: () => registry.list().length > 0,
    // Kill shells left unattended past the re-attach window: once killed, the
    // bound chat is released and the session is unrecoverable (no re-attach) —
    // a session from a previous workday cannot be resumed later.
    reapIdleShells: (maxIdleMs) => {
      const now = Date.now()
      for (const shellId of registry.abandoned(now, maxIdleMs)) {
        try {
          registry.kill(shellId)
        } catch (e) {
          // A kill failure must not stop the reaper.
          log.child({ component: "daemon.serve" }).warn("reap kill failed", { err: e, shellId })
        }
      }
    },
    shutdown: () => {
      stopRef()
      opts.onIdleExit?.()
    },
  })
  const unsubscribeLifecycle = chats.subscribe((e) => {
    if (e.event !== null) lifecycle.onChatEvent(e.chatId, e.event)
  })

  const ws = createWsEndpoint({
    token,
    registry,
    chats,
    version: SENSUS_VERSION,
    onClientConnected: () => lifecycle.clientConnected(),
    onClientGone: (info) => lifecycle.clientGone(info),
  })
  // A matched condition trigger fans out to every attached client (docs/triggers.md).
  broadcastTrigger = (record: TriggerRecord) => {
    try {
      ws.broadcast("trigger", { trigger: record })
    } catch (e) {
      // a fan-out failure must never break the engine event that fired it
      log.child({ component: "daemon.serve" }).warn("trigger broadcast failed", { err: e })
    }
  }

  const app = createDaemonApp({
    token,
    version: SENSUS_VERSION,
    info,
    memory: memoryStore,
    events,
    audit,
    sessionsDataDir: dataDir,
    config: opts.config ?? (() => readRedactedConfig(configArgv)),
    home: homeDir,
    // P4c-ii engine-free readouts: the client's pickers/overlays source these
    // from the daemon (D13). `config()` is invalidated on a settings write so a
    // subsequent catalog/usage read reflects the new config.
    mcp: () => chats.mcpStatus(),
    models: () => buildModelCatalog(config()),
    probeModels: (input) => probeEndpointModels(input),
    usage: () => buildUsageReport(dataDir),
    onConfigWrite: () => {
      cachedConfig = undefined
      // Re-read the trigger rules so a `PUT /v1/config` change applies live.
      triggerEngine.setRules(config().triggers)
      chats.reloadConfig("settings")
    },
    sessionContext: (path) => chats.sessionContextBreakdown(path),
  })

  // The WS channel lives on the TCP listener (loopback by default; the
  // `SENSUS_DAEMON_HOST` opt-in can bind it wider): Bun's WebSocket CLIENT has no
  // `unix` option, so a UDS-hosted channel would be unreachable by our own
  // client (P4) and tests. The UDS keeps serving REST (docs/daemon-api.md).
  const tcpFetch = (req: Request, server: Bun.Server<WsSocketData>): Response | Promise<Response> | undefined => {
    let path = ""
    try {
      path = new URL(req.url).pathname
    } catch (e) {
      path = ""
      log.child({ component: "daemon.serve" }).debug("tcp fetch URL parse failed", { err: e })
    }
    if (path === "/v1/ws") return ws.handle(req, server)
    // Correlate every REST record under this request with the path, so a
    // multi-record failure (e.g. onError + a route log) is traceable together.
    return withCorrelation(`http:${req.method}:${path}`, () => app.fetch(req))
  }

  let unixServer: ReturnType<typeof Bun.serve>
  try {
    unixServer = Bun.serve({ unix: socketPath, fetch: app.fetch })
  } catch (e) {
    log.child({ component: "daemon.serve" }).debug("unix socket bind failed", { err: e, socket: socketPath })
    return { ok: false, error: errorMessage(e) }
  }

  try {
    tcpServer = Bun.serve<WsSocketData>({
      hostname: host,
      port: requestedPort,
      fetch: tcpFetch,
      websocket: ws.websocket,
    })
  } catch (e) {
    try {
      unixServer.stop(true)
    } catch (stopErr) {
      // ignore: we are already failing
      log.child({ component: "daemon.serve" }).debug("unix stop after tcp bind failure failed", { err: stopErr })
    }
    try {
      rmSync(socketPath, { force: true })
    } catch (rmErr) {
      // ignore
      log.child({ component: "daemon.serve" }).debug("socket cleanup after tcp bind failure failed", { err: rmErr })
    }
    return { ok: false, error: errorMessage(e) }
  }

  try {
    chmodSync(socketPath, 0o600)
  } catch (e) {
    // best-effort: the dir's 0700 remains the primary protection
    log.child({ component: "daemon.serve" }).warn("socket chmod 0600 failed", { err: e, socket: socketPath, mode: "0600" })
  }

  const stop = () => {
    log.child({ component: "daemon.serve" }).info("daemon stopping", { socket: socketPath })
    // Cancel the lifetime timers and the lifecycle event subscription first so
    // no grace/approval callback fires mid-teardown.
    try {
      lifecycle.stop()
    } catch (e) {
      // idempotent
      log.child({ component: "daemon.serve" }).debug("lifecycle.stop failed in teardown", { err: e })
    }
    try {
      unsubscribeLifecycle()
    } catch (e) {
      // idempotent
      log.child({ component: "daemon.serve" }).debug("lifecycle unsubscribe failed in teardown", { err: e })
    }
    // The anticipated PTY-child teardown: close the channels first, then kill
    // every shell (no orphaned children on `daemon stop` — D9/orphan rule).
    try {
      ws.closeAll()
    } catch (e) {
      // idempotent
      log.child({ component: "daemon.serve" }).debug("ws.closeAll failed in teardown", { err: e })
    }
    try {
      registry.killAll()
    } catch (e) {
      // idempotent
      log.child({ component: "daemon.serve" }).debug("registry.killAll failed in teardown", { err: e })
    }
    try {
      chats.closeAll()
    } catch (e) {
      // idempotent
      log.child({ component: "daemon.serve" }).debug("chats.closeAll failed in teardown", { err: e })
    }
    // Drain the durable event log before the process can exit (docs/events.md).
    try {
      const flushable = events as EventSink & { flushSync?: () => void }
      flushable.flushSync?.()
    } catch (e) {
      // an audit flush must never block teardown
      log.child({ component: "daemon.serve" }).error("event sink flush failed at shutdown", { err: e })
    }
    // Drain the structured-log queue synchronously too, best-effort.
    try {
      flushLoggerSync()
    } catch (e) {
      log.child({ component: "daemon.serve" }).error("logger flush failed at shutdown", { err: e })
    }
    try {
      unixServer.stop(true)
    } catch (e) {
      // idempotent
      log.child({ component: "daemon.serve" }).debug("unix server stop failed in teardown", { err: e })
    }
    if (tcpServer !== undefined) {
      try {
        tcpServer.stop(true)
      } catch (e) {
        // idempotent
        log.child({ component: "daemon.serve" }).debug("tcp server stop failed in teardown", { err: e })
      }
    }
    try {
      rmSync(socketPath, { force: true })
    } catch (e) {
      // best-effort
      log.child({ component: "daemon.serve" }).debug("socket unlink failed in teardown", { err: e })
    }
  }
  stopRef = stop

  // Arm the startup grace only once every listener and `stop` exist: a daemon
  // that never gets a client still idle-exits (D9).
  lifecycle.start()

  log.child({ component: "daemon.serve" }).info("daemon started", {
    socket: socketPath,
    host: tcpServer.hostname ?? host,
    port: tcpServer.port ?? 0,
    persistent,
  })

  // Warm the models.dev catalog at boot (docs/config.md "Model catalog cache":
  // "warmed at boot"), best-effort and never throwing. A fresh install then
  // resolves the real context window + reasoning metadata for the status bar /
  // `think:` chip without opening the model picker first; the version bump
  // invalidates any value a session resolved before the fetch landed. Only the
  // `sensus daemon` CLI enables it (see `warmCatalog`) so tests stay hermetic.
  if (opts.warmCatalog === true) {
    void warmModelsDevCache()
      .then((ok) => {
        if (ok) catalogVersion += 1
      })
      .catch(() => {
        // Defense in depth: warmModelsDevCache swallows internally today, but
        // this fire-and-forget chain must never leak a rejection.
      })
  }

  return {
    ok: true,
    unix: socketPath,
    tcp: { host: tcpServer.hostname ?? host, port: tcpServer.port ?? 0 },
    token,
    registry,
    stop,
  }
}
