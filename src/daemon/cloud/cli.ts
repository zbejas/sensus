/**
 * `sensus cloud` — pair this daemon with a Sensus Cloud panel.
 *
 * This replaces the separate `sensus auth` step and the standalone connector:
 * pairing creates the Ed25519 host identity and host-local scope policy if
 * needed, exchanges the one-time code, stores the device token under
 * `<SENSUS_HOME>/cloud/connection.json` (0600), and the daemon opens the
 * outbound tunnel. No inbound port is opened.
 */

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { errorMessage, isRecord } from "../../core/util.ts"
import { loadOrCreateIdentity, readIdentity } from "../../auth/identity.ts"
import { defaultPolicy, readPolicy, writePolicy } from "../../auth/policy.ts"
import { parseScopeList, hasScope, SCOPES, type Scope } from "../../auth/scopes.ts"
import { safeUid } from "../../auth/paths.ts"
import { sensusHomeFrom } from "../../config/config/paths.ts"
import { SENSUS_VERSION } from "../../version.ts"
import { checkUserLinger, installService, type LingerStatus } from "../service.ts"
import { discoverDaemon, requestOverUnix, type DaemonInfoPayload } from "./discovery.ts"
import { daemonSocketPath, resolveRuntimeDir } from "./paths.ts"
import { pairWithCloud, promptHidden, whoami } from "./pairing.ts"
import { probeConnectorUpgrade } from "./probe.ts"
import {
  clearCloudConnection,
  normalizeCloudUrl,
  readCloudConnection,
  unixUserLabel,
  writeCloudConnection,
  type CloudConnection,
} from "./state.ts"
import { hostFacts } from "./state.ts"

export interface CloudIo {
  out(s: string): void
  err(s: string): void
}

export interface CloudCliOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  uid?: number
  runtimeDir?: string
  now?: () => number
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  interactive?: boolean
  /** Test seam for the install prompt; default reads the TTY. */
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>
  /** Test seam for the pairing scope prompt; default reads the TTY. */
  promptText?: (question: string) => Promise<string>
  /** Test seam for `sensus daemon install`. */
  install?: (opts: { home: string; env: NodeJS.ProcessEnv; runtimeDir: string }) => Promise<number>
  /** Test seam for the local daemon probe. */
  discover?: (opts: { runtimeDir: string; env: NodeJS.ProcessEnv }) => ReturnType<typeof discoverDaemon>
  /** Test seam for the post-pair reload. */
  reload?: (opts: { runtimeDir: string; env: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; error?: string }>
  /** Test seam for the local daemon cloud-status probe. */
  cloudStatus?: (opts: { home: string; runtimeDir: string; env: NodeJS.ProcessEnv }) => Promise<CloudDaemonStatus>
  /** Max wait for `connected:true` after pair/reload (default 20 s; 0 skips). */
  waitTimeoutMs?: number
  /** Poll interval while waiting for the tunnel (default 250 ms). */
  waitPollMs?: number
  /** Test seam for waiting; defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam for the lingering check; defaults to `loginctl`. */
  linger?: (opts: { env: NodeJS.ProcessEnv }) => Promise<LingerStatus>
}

/** The local daemon's cloud view, enriched with `/v1/info` facts. */
export interface CloudDaemonStatus {
  running: boolean
  /** `stopped | unreachable | error` from the probe, else the tunnel state. */
  state: string
  connected: boolean
  lastError: string | null
  version: string | null
  pid: number | null
  /** The config home the running daemon reports (null on older builds). */
  home: string | null
  unixUser: string | null
  uid: number | null
  /** Non-null when `/v1/cloud/status` could not be read. */
  probeError: string | null
}

const USAGE = `sensus cloud — pair this host with a Sensus Cloud panel

Usage:
  sensus cloud pair --cloud <url> [--code <CODE>] [--allow <scopes>] [--allow-root] [--no-wait]
  sensus cloud scopes [--allow <scopes>] [--allow-root] [--json]
  sensus cloud status [--json]
  sensus cloud doctor [--json]
  sensus cloud disable | enable
  sensus cloud unpair

Pairing creates the host identity and scope policy if they do not exist,
stores the device token at <config>/cloud/connection.json (0600), and opens
one outbound WebSocket to the pinned cloud origin. No inbound port is opened.

After pairing/reloading, the command waits for the daemon's tunnel to report
connected and exits non-zero when it does not. --no-wait saves the pairing and
returns immediately. "doctor" checks pairing, identity, the local daemon
(user/home/version), the tunnel, HTTPS whoami, the WebSocket upgrade, and
systemd lingering.

Scopes: view, chat, control, orchestrator.
Interactive pairing lists them and asks which to grant; the default is view,chat,control.
Root: pairing as root is refused unless --allow-root (or an interactive yes).
Run as the Unix user whose daemon should be controlled.
`

interface ParsedFlags {
  values: Map<string, string | true>
  error: string | null
}

function parseFlags(argv: readonly string[], booleanFlags: ReadonlySet<string>): ParsedFlags {
  const values = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (!arg.startsWith("--")) return { values, error: `unexpected argument ${JSON.stringify(arg)}` }
    const body = arg.slice(2)
    const eq = body.indexOf("=")
    if (eq >= 0) {
      values.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    if (booleanFlags.has(body)) {
      values.set(body, true)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) return { values, error: `--${body} needs a value` }
    values.set(body, next)
    i++
  }
  return { values, error: null }
}

function stringFlag(values: Map<string, string | true>, name: string): string | undefined {
  const value = values.get(name)
  return typeof value === "string" ? value : undefined
}

function defaultInteractive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true
}

async function ask(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    if (answer === "") return defaultYes
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

async function askText(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Scopes an interactive pairing offers unless the user narrows them. */
const PAIRING_DEFAULT_SCOPES: Scope[] = ["view", "chat", "control"]

async function promptScopes(io: CloudIo, opts: CloudCliOptions): Promise<Scope[]> {
  io.err("sensus cloud: choose what this cloud may do on this host:")
  io.err("  view          watch terminals and chats, list shells and chats")
  io.err("  chat          send prompts, approve tool calls, answer questions")
  io.err("  control       open shells, type into terminals, resize, take control")
  io.err("  orchestrator  run Conductor/headless agent jobs")
  const fallback = PAIRING_DEFAULT_SCOPES.join(",")
  const askFn = opts.promptText ?? askText
  for (;;) {
    const answer = await askFn(`Scopes (comma-separated) [${fallback}]: `)
    const raw = answer.trim() === "" ? fallback : answer
    const parsed = raw.trim().toLowerCase() === "all" ? { ok: true as const, scopes: [...SCOPES] } : parseScopeList(raw)
    if (parsed.ok) return parsed.scopes
    io.err(`sensus cloud pair: ${parsed.error}`)
  }
}

async function confirmRoot(
  io: CloudIo,
  uid: number,
  allowRoot: boolean,
  interactive: boolean,
  confirm: CloudCliOptions["confirm"],
): Promise<boolean> {
  if (uid !== 0) return false
  io.err("sensus cloud: warning: this daemon runs as root. The paired cloud will be able to run")
  io.err("  commands and type into shells as root. Pair only with a cloud/account you trust.")
  if (allowRoot) return true
  if (!interactive) {
    io.err("sensus cloud: refusing to pair as root without --allow-root (non-interactive)")
    return false
  }
  const askFn = confirm ?? ((q: string, d: boolean) => ask(q, d))
  return await askFn("Continue as root? [y/N] ", false)
}

/** Compare two paths after symlink normalization; fall back to `resolve`. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

interface DaemonIncompatibility {
  /** The daemon's config home when it is not the one this command writes. */
  home: string | null
  /** The daemon's uid when it is not the one this command runs as. */
  uid: number | null
}

function daemonIncompatibility(info: DaemonInfoPayload, home: string, uid: number): DaemonIncompatibility {
  return {
    home: typeof info.home === "string" && info.home.length > 0 && !samePath(info.home, home) ? info.home : null,
    uid: typeof info.uid === "number" && uid >= 0 && info.uid !== uid ? info.uid : null,
  }
}

/**
 * Explain why the running daemon cannot use a pairing written by this command.
 * Returns a short reason for exit paths, or null when it is compatible.
 */
function explainIncompatibility(
  io: CloudIo,
  info: DaemonInfoPayload,
  home: string,
  uid: number,
): string | null {
  const bad = daemonIncompatibility(info, home, uid)
  if (bad.home !== null) {
    io.err(`sensus cloud: a Sensus daemon is already running with SENSUS_HOME=${bad.home}, not ${home}.`)
    io.err("sensus cloud: it will not read this pairing. Restart it with the same SENSUS_HOME, or run this command as the user whose daemon should connect.")
    return `daemon home ${bad.home} does not match ${home}`
  }
  if (bad.uid !== null) {
    io.err(`sensus cloud: a Sensus daemon is already running as uid ${bad.uid}, not uid ${uid}.`)
    io.err("sensus cloud: it cannot use this pairing. Stop it (`sensus daemon stop`) or run this command as that user.")
    return `daemon uid ${bad.uid} does not match ${uid}`
  }
  return null
}

/** Read the daemon's `/v1/cloud/status`; API failures become a reported state. */
async function probeCloudDaemon(opts: CloudCliOptions, home: string, runtimeDir: string): Promise<CloudDaemonStatus> {
  const env = opts.env ?? process.env
  const discovery = await (opts.discover ?? discoverDaemon)({ runtimeDir, env })
  if (!discovery.ok) {
    const unreachable = discovery.state === "unreachable"
    return {
      running: false,
      state: discovery.state,
      connected: false,
      lastError: unreachable ? discovery.message : null,
      version: null,
      pid: null,
      home: null,
      unixUser: null,
      uid: null,
      probeError: unreachable ? discovery.message : null,
    }
  }
  const info = discovery.discovery.info
  const base = {
    running: true,
    version: info.version ?? null,
    pid: info.pid ?? null,
    home: info.home ?? null,
    unixUser: info.unixUser ?? null,
    uid: info.uid ?? null,
  }
  try {
    const res = await requestOverUnix({
      unix: daemonSocketPath(runtimeDir),
      path: "/v1/cloud/status",
      token: discovery.discovery.token,
      timeoutMs: 5000,
    })
    if (res.status !== 200) {
      const message =
        res.status === 0
          ? "GET /v1/cloud/status closed without a response"
          : `GET /v1/cloud/status returned HTTP ${res.status}`
      return { ...base, state: "error", connected: false, lastError: message, probeError: message }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.body)
    } catch {
      parsed = null
    }
    if (!isRecord(parsed)) {
      const message = "GET /v1/cloud/status returned an invalid payload"
      return { ...base, state: "error", connected: false, lastError: message, probeError: message }
    }
    return {
      ...base,
      state: typeof parsed["state"] === "string" ? parsed["state"] : "unknown",
      connected: parsed["connected"] === true,
      lastError: typeof parsed["lastError"] === "string" ? parsed["lastError"] : null,
      probeError: null,
    }
  } catch (e) {
    const message = errorMessage(e)
    return { ...base, state: "error", connected: false, lastError: message, probeError: message }
  }
}

function getCloudDaemonStatus(opts: CloudCliOptions, home: string, runtimeDir: string): Promise<CloudDaemonStatus> {
  if (opts.cloudStatus !== undefined) return opts.cloudStatus({ home, runtimeDir, env: opts.env ?? process.env })
  return probeCloudDaemon(opts, home, runtimeDir)
}

async function reloadDaemon(
  io: CloudIo,
  opts: CloudCliOptions,
  home: string,
  runtimeDir: string,
): Promise<boolean> {
  if (opts.reload !== undefined) {
    const res = await opts.reload({ runtimeDir, env: opts.env ?? process.env })
    if (!res.ok) io.err(`sensus cloud: daemon reload failed: ${res.error ?? "unknown error"}`)
    return res.ok
  }
  const env = opts.env ?? process.env
  const uid = opts.uid ?? safeUid() ?? -1
  const discovery = await (opts.discover ?? discoverDaemon)({ runtimeDir, env })
  if (!discovery.ok) return false
  const info = discovery.discovery.info
  if (typeof info.home === "string" && info.home.length > 0 && !samePath(info.home, home)) {
    io.err(`sensus cloud: the running daemon reads ${info.home}, not ${home}; not reloading it.`)
    return false
  }
  if (typeof info.uid === "number" && uid >= 0 && info.uid !== uid) {
    io.err(`sensus cloud: the running daemon is uid ${info.uid}, not uid ${uid}; not reloading it.`)
    return false
  }
  if (typeof info.version === "string" && info.version !== SENSUS_VERSION) {
    io.err(`sensus cloud: note: the running daemon is version ${info.version}, this CLI is ${SENSUS_VERSION}.`)
  }
  try {
    const res = await requestOverUnix({
      unix: daemonSocketPath(runtimeDir),
      method: "POST",
      path: "/v1/cloud/reload",
      token: discovery.discovery.token,
      body: "{}",
      timeoutMs: 5000,
    })
    if (res.status !== 200) {
      io.err(`sensus cloud: daemon reload returned HTTP ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    io.err(`sensus cloud: daemon reload failed: ${errorMessage(e)}`)
    return false
  }
}

interface EnsureResult {
  ok: boolean
  connected: boolean
  message: string
}

const DEFAULT_TUNNEL_WAIT_MS = 20_000
const DEFAULT_TUNNEL_POLL_MS = 250

/**
 * Poll the daemon until it reports a ready tunnel. A stale/unreachable daemon
 * must not look like a successful pairing: every failure returns a reason and
 * the caller exits non-zero.
 */
async function waitForTunnel(
  io: CloudIo,
  opts: CloudCliOptions,
  home: string,
  runtimeDir: string,
): Promise<EnsureResult> {
  const timeoutMs = opts.waitTimeoutMs ?? DEFAULT_TUNNEL_WAIT_MS
  if (timeoutMs <= 0) return { ok: true, connected: false, message: "wait skipped" }
  const pollMs = Math.max(1, opts.waitPollMs ?? DEFAULT_TUNNEL_POLL_MS)
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const deadline = Date.now() + timeoutMs
  let last: CloudDaemonStatus = await getCloudDaemonStatus(opts, home, runtimeDir)
  for (;;) {
    if (last.connected) {
      io.out("sensus cloud: tunnel connected")
      return { ok: true, connected: true, message: "connected" }
    }
    if (Date.now() >= deadline) break
    await sleep(pollMs)
    last = await getCloudDaemonStatus(opts, home, runtimeDir)
  }
  const detail =
    last.lastError ??
    last.probeError ??
    (!last.running ? `daemon is ${last.state}` : `daemon state is ${last.state}`)
  io.err(`sensus cloud: the tunnel did not connect within ${Math.round(timeoutMs / 1000)}s: ${detail}`)
  io.err("sensus cloud: check `sensus cloud doctor`, `sensus daemon logs --component cloud`, and the cloud's proxy/WebSocket settings.")
  return { ok: false, connected: false, message: detail }
}

async function ensureDaemonService(
  io: CloudIo,
  opts: CloudCliOptions,
  home: string,
  runtimeDir: string,
  uid: number,
  wait: boolean,
): Promise<EnsureResult> {
  const env = opts.env ?? process.env
  const discovery = await (opts.discover ?? discoverDaemon)({ runtimeDir, env })
  if (discovery.ok) {
    const reason = explainIncompatibility(io, discovery.discovery.info, home, uid)
    if (reason !== null) return { ok: false, connected: false, message: reason }
    if (!(await reloadDaemon(io, opts, home, runtimeDir))) {
      return { ok: false, connected: false, message: "daemon reload failed" }
    }
    io.out(wait ? "sensus cloud: daemon reloaded; waiting for the tunnel…" : "sensus cloud: daemon reloaded")
    if (!wait) return { ok: true, connected: false, message: "not waiting" }
    return await waitForTunnel(io, opts, home, runtimeDir)
  }
  if (discovery.state === "unreachable") {
    const message = `a daemon socket exists but is not reachable (${discovery.message})`
    io.err(`sensus cloud: ${message}.`)
    io.err("sensus cloud: fix or restart it with `sensus daemon restart`; pairing is saved.")
    return { ok: false, connected: false, message }
  }
  const user = unixUserLabel(uid, env)
  io.out(`sensus cloud: no Sensus daemon is running for ${user}.`)
  if (uid === 0) {
    io.err("sensus cloud: warning: a root user service may need `loginctl enable-linger root`; a system unit is not installed automatically.")
  }
  const interactive = opts.interactive ?? defaultInteractive()
  const askFn = opts.confirm ?? ((q: string, d: boolean) => ask(q, d))
  let install = false
  if (interactive) {
    install = await askFn(`Install and enable the Sensus daemon service for ${user}? [Y/n] `, true)
  } else {
    io.out("sensus cloud: start it with `sensus daemon start` (or `sensus daemon install` for an always-on user service).")
  }
  if (!install) {
    return {
      ok: false,
      connected: false,
      message: `no daemon is running for ${user}; start it with \`sensus daemon start\``,
    }
  }

  const installFn =
    opts.install ??
    (async (input: { home: string; env: NodeJS.ProcessEnv; runtimeDir: string }) =>
      installService({
        io,
        env: input.env,
        home: input.env["HOME"] ?? input.home,
        runtimeDir: input.runtimeDir,
        sensusHome: input.home,
      }))
  const code = await installFn({ home, env, runtimeDir })
  if (code !== 0) {
    io.err("sensus cloud: service install failed; start the daemon with `sensus daemon start` when ready.")
    return { ok: false, connected: false, message: "service install failed" }
  }
  io.out(`sensus cloud: installed and enabled the Sensus daemon service for ${user}`)
  // The service manager starts it asynchronously; the daemon reads
  // connection.json on boot and opens the tunnel without another command.
  if (!wait) return { ok: true, connected: false, message: "not waiting" }
  return await waitForTunnel(io, opts, home, runtimeDir)
}

interface StatusContext {
  home: string
  runtimeDir: string
  uid: number
  homeMismatch: boolean
  userMismatch: boolean
  versionMismatch: boolean
}

function printDaemonStatus(io: CloudIo, daemon: CloudDaemonStatus): void {
  if (!daemon.running) {
    io.out(`sensus cloud: daemon      not running (${daemon.state})`)
  } else {
    const state = daemon.connected ? "connected" : daemon.state
    const facts = [
      daemon.version !== null ? `version ${daemon.version}` : null,
      daemon.pid !== null ? `pid ${daemon.pid}` : null,
    ].filter((part): part is string => part !== null)
    io.out(`sensus cloud: daemon      ${state}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`)
    io.out(`sensus cloud: daemon home ${daemon.home ?? "(not reported by this build)"}`)
  }
  if (daemon.lastError !== null) io.out(`sensus cloud: last error  ${daemon.lastError}`)
  if (daemon.probeError !== null) io.out(`sensus cloud: daemon API  ${daemon.probeError}`)
}

function printStatus(
  io: CloudIo,
  connection: CloudConnection,
  daemon: CloudDaemonStatus,
  json: boolean,
  ctx: StatusContext,
): void {
  if (json) {
    io.out(
      JSON.stringify(
        {
          paired: true,
          cloud: connection.cloud,
          instanceId: connection.instanceId,
          fingerprint: connection.fingerprint,
          scopes: connection.scopes,
          unixUser: connection.unixUser,
          runsAsRoot: connection.runsAsRoot,
          enabled: connection.enabled,
          clientKind: connection.clientKind,
          clientVersion: connection.clientVersion,
          home: ctx.home,
          runtimeDir: ctx.runtimeDir,
          homeMismatch: ctx.homeMismatch,
          userMismatch: ctx.userMismatch,
          versionMismatch: ctx.versionMismatch,
          daemon,
        },
        null,
        2,
      ),
    )
    return
  }
  io.out(`sensus cloud: cloud       ${connection.cloud}`)
  io.out(`sensus cloud: instance    ${connection.instanceId}`)
  io.out(`sensus cloud: fingerprint ${connection.fingerprint}`)
  io.out(`sensus cloud: scopes      ${connection.scopes.join(",")}`)
  io.out(`sensus cloud: runs as     ${connection.unixUser}${connection.runsAsRoot ? " (root)" : ""}`)
  io.out(`sensus cloud: enabled     ${connection.enabled ? "yes" : "no"}`)
  printDaemonStatus(io, daemon)
  if (ctx.homeMismatch) {
    io.err(`sensus cloud: warning: the running daemon uses ${daemon.home ?? "(unknown)"}, not ${ctx.home}.`)
    io.err("sensus cloud: this pairing will not be used until the daemon runs with the same SENSUS_HOME.")
  }
  if (ctx.userMismatch) {
    io.err(`sensus cloud: warning: the running daemon is uid ${daemon.uid ?? "?"}, not uid ${ctx.uid}.`)
  }
  if (ctx.versionMismatch) {
    io.err(`sensus cloud: warning: the daemon is version ${daemon.version ?? "?"}, this CLI is ${SENSUS_VERSION}; restart it after an upgrade.`)
  }
}

async function scopesCommand(
  io: CloudIo,
  opts: CloudCliOptions,
  home: string,
  runtimeDir: string,
  argv: readonly string[],
): Promise<number> {
  const flags = parseFlags(argv, new Set(["json", "allow-root"]))
  if (flags.error !== null) {
    io.err(`sensus cloud scopes: ${flags.error}`)
    return 1
  }
  const read = readPolicy(home)
  if (!read.ok) {
    io.err(`sensus cloud scopes: ${read.error}`)
    return 1
  }
  const allowRaw = stringFlag(flags.values, "allow")
  if (allowRaw === undefined) {
    if (flags.values.get("json") === true) {
      io.out(JSON.stringify(read.policy, null, 2))
    } else {
      io.out(`sensus cloud: scopes      ${read.policy.scopes.join(",")}`)
      io.out(`sensus cloud: allowed cwd ${read.policy.allowedCwd.length > 0 ? read.policy.allowedCwd.join(", ") : "(none)"}`)
      io.out(`sensus cloud: start daemon ${read.policy.startDaemon ? "yes" : "no"}`)
      if (!read.existed) io.out("sensus cloud: policy is the default (view only)")
    }
    return 0
  }
  const parsed = parseScopeList(allowRaw)
  if (!parsed.ok) {
    io.err(`sensus cloud scopes: ${parsed.error}`)
    return 1
  }
  const uid = opts.uid ?? safeUid() ?? -1
  const env = opts.env ?? process.env
  const allowRoot = flags.values.get("allow-root") === true
  const approvedRoot = await confirmRoot(io, uid, allowRoot, opts.interactive ?? defaultInteractive(), opts.confirm)
  if (uid === 0 && !approvedRoot) return 1
  const written = writePolicy(home, { ...read.policy, scopes: parsed.scopes }, { uid, allowRoot: approvedRoot })
  if (!written.ok) {
    io.err(`sensus cloud scopes: ${written.error}`)
    return 1
  }
  io.out(`sensus cloud: scopes ${parsed.scopes.join(",")}`)
  if (await reloadDaemon(io, opts, home, runtimeDir)) io.out("sensus cloud: daemon reloaded")
  else io.out("sensus cloud: the daemon will load the new scopes on its next start")
  return 0
}

async function statusCommand(io: CloudIo, opts: CloudCliOptions, home: string, runtimeDir: string, json: boolean): Promise<number> {
  const read = readCloudConnection(home)
  if (!read.ok) {
    io.err(`sensus cloud: ${read.error}`)
    return 1
  }
  const uid = opts.uid ?? safeUid() ?? -1
  const daemon = await getCloudDaemonStatus(opts, home, runtimeDir)
  const homeMismatch = daemon.home !== null && !samePath(daemon.home, home)
  const userMismatch = daemon.uid !== null && uid >= 0 && daemon.uid !== uid
  const versionMismatch = daemon.version !== null && daemon.version !== SENSUS_VERSION
  const ctx: StatusContext = { home, runtimeDir, uid, homeMismatch, userMismatch, versionMismatch }
  if (read.connection === null) {
    if (json) {
      io.out(JSON.stringify({ paired: false, home, runtimeDir, homeMismatch, userMismatch, daemon }, null, 2))
    } else {
      io.out("sensus cloud: not paired — run `sensus cloud pair --cloud <url>`")
      printDaemonStatus(io, daemon)
      if (homeMismatch) io.err(`sensus cloud: warning: the running daemon uses ${daemon.home ?? "(unknown)"}, not ${home}.`)
      if (userMismatch) io.err(`sensus cloud: warning: the running daemon is uid ${daemon.uid ?? "?"}, not uid ${uid}.`)
    }
    return daemon.probeError !== null || homeMismatch || userMismatch ? 1 : 0
  }
  printStatus(io, read.connection, daemon, json, ctx)
  // A paired host whose local daemon API, home, or user does not line up is
  // not healthy: scripts must be able to tell that apart from a stopped daemon.
  return daemon.probeError !== null || homeMismatch || userMismatch || versionMismatch ? 1 : 0
}

async function pairCommand(io: CloudIo, opts: CloudCliOptions, argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["allow-root", "no-wait", "json"]))
  if (flags.error !== null) {
    io.err(`sensus cloud pair: ${flags.error}`)
    return 1
  }
  const cloudRaw = stringFlag(flags.values, "cloud")
  if (cloudRaw === undefined) {
    io.err("sensus cloud pair: --cloud <url> is required")
    return 1
  }
  const normalized = normalizeCloudUrl(cloudRaw)
  if (!normalized.ok) {
    io.err(`sensus cloud pair: ${normalized.error}`)
    return 1
  }
  const uid = opts.uid ?? safeUid() ?? -1
  const env = opts.env ?? process.env
  const home = opts.home ?? sensusHomeFrom(env)
  const runtimeDir = opts.runtimeDir ?? resolveRuntimeDir(env)
  const interactive = opts.interactive ?? defaultInteractive()
  const allowRoot = flags.values.get("allow-root") === true
  const approvedRoot = await confirmRoot(io, uid, allowRoot, interactive, opts.confirm)
  if (uid === 0 && !approvedRoot) return 1

  // Pairing writes into THIS config home and reloads THIS runtime dir. If a
  // daemon is already running with another home/user, it would never see the
  // pairing; refuse before touching the cloud rather than report a false success.
  const existingDaemon = await (opts.discover ?? discoverDaemon)({ runtimeDir, env })
  if (existingDaemon.ok) {
    const reason = explainIncompatibility(io, existingDaemon.discovery.info, home, uid)
    if (reason !== null) {
      io.err(`sensus cloud pair: refusing to pair: ${reason}`)
      return 1
    }
  }

  const allowRaw = stringFlag(flags.values, "allow")
  const parsedScopes = allowRaw === undefined ? null : parseScopeList(allowRaw)
  if (parsedScopes !== null && !parsedScopes.ok) {
    io.err(`sensus cloud pair: ${parsedScopes.error}`)
    return 1
  }
  let chosenScopes: Scope[] | null = parsedScopes?.ok ? parsedScopes.scopes : null
  if (allowRaw === undefined && interactive) {
    try {
      chosenScopes = await promptScopes(io, opts)
    } catch (e) {
      io.err(`sensus cloud pair: ${errorMessage(e)}`)
      return 1
    }
  }

  const identity = loadOrCreateIdentity(home, { uid, allowRoot: approvedRoot })
  if (!identity.ok) {
    io.err(`sensus cloud pair: ${identity.error}`)
    return 1
  }

  const existingPolicy = readPolicy(home)
  if (!existingPolicy.ok) {
    io.err(`sensus cloud pair: ${existingPolicy.error}`)
    return 1
  }
  const policy = existingPolicy.existed
    ? chosenScopes === null
      ? existingPolicy.policy
      : { ...existingPolicy.policy, scopes: chosenScopes }
    : { ...defaultPolicy(), scopes: chosenScopes ?? defaultPolicy().scopes }
  if (!existingPolicy.existed || chosenScopes !== null) {
    const written = writePolicy(home, policy, { uid, allowRoot: approvedRoot })
    if (!written.ok) {
      io.err(`sensus cloud pair: ${written.error}`)
      return 1
    }
  }

  let code = stringFlag(flags.values, "code")
  if (code === undefined) {
    if (!interactive) {
      io.err("sensus cloud pair: --code <CODE> is required when stdin is not a TTY")
      return 1
    }
    try {
      code = await promptHidden("Pairing code (hidden): ")
    } catch (e) {
      io.err(`sensus cloud pair: ${errorMessage(e)}`)
      return 1
    }
  }

  const host = hostFacts({ uid, env })
  if (stringFlag(flags.values, "code") !== undefined) {
    io.err("sensus cloud pair: warning: --code can remain in shell history; prefer the interactive prompt")
  }
  const result = await pairWithCloud({
    home,
    cloud: normalized.cloud,
    code,
    identity: identity.identity,
    policy,
    version: SENSUS_VERSION,
    host,
    uid,
    allowRoot: approvedRoot,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    waitForApproval: flags.values.get("no-wait") !== true,
    io,
  })
  if (!result.ok) {
    io.err(`sensus cloud pair: ${result.error}`)
    return 1
  }

  const noWait = flags.values.get("no-wait") === true
  const wait = !noWait && result.state !== "pending"
  const ensured = await ensureDaemonService(io, opts, home, runtimeDir, uid, wait)
  io.out("")
  io.out("sensus cloud: pairing saved. Revoke it any time in the cloud's Fleet panel.")
  if (result.state === "pending") {
    io.out("sensus cloud: the instance is awaiting owner approval; the tunnel connects after approval.")
    return 0
  }
  if (noWait) {
    io.out("sensus cloud: --no-wait set; not checking the tunnel. Run `sensus cloud status` after the daemon starts.")
    return 0
  }
  if (!ensured.ok) {
    io.err("sensus cloud: pairing is saved, but this host is not connected to the cloud.")
    io.err(`sensus cloud: ${ensured.message}`)
    io.err("sensus cloud: re-run with --no-wait to save a pairing without waiting for the daemon.")
    return 1
  }
  return 0
}

async function setEnabled(io: CloudIo, opts: CloudCliOptions, home: string, runtimeDir: string, enabled: boolean): Promise<number> {
  const read = readCloudConnection(home)
  if (!read.ok) {
    io.err(`sensus cloud: ${read.error}`)
    return 1
  }
  if (read.connection === null) {
    io.err("sensus cloud: not paired")
    return 1
  }
  const uid = opts.uid ?? safeUid() ?? -1
  const next: CloudConnection = { ...read.connection, enabled }
  const written = writeCloudConnection(home, next, { uid, allowRoot: true })
  if (!written.ok) {
    io.err(`sensus cloud: ${written.error}`)
    return 1
  }
  io.out(`sensus cloud: ${enabled ? "enabled" : "disabled"}`)
  if (await reloadDaemon(io, opts, home, runtimeDir)) io.out("sensus cloud: daemon reloaded")
  return 0
}

async function unpairCommand(io: CloudIo, opts: CloudCliOptions, home: string, runtimeDir: string): Promise<number> {
  const cleared = clearCloudConnection(home)
  if (!cleared.ok) {
    io.err(`sensus cloud: ${cleared.error}`)
    return 1
  }
  io.out("sensus cloud: pairing removed locally")
  if (await reloadDaemon(io, opts, home, runtimeDir)) io.out("sensus cloud: daemon reloaded; the tunnel is stopped")
  io.out("sensus cloud: revoke the instance in the cloud's Fleet panel if it should not reconnect")
  return 0
}

type DoctorStatus = "ok" | "warn" | "fail" | "skip"

interface DoctorCheck {
  id: string
  status: DoctorStatus
  message: string
}

const DOCTOR_MARK: Readonly<Record<DoctorStatus, string>> = {
  ok: "OK",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
}

/**
 * `sensus cloud doctor` — one command that separates the failure domains the
 * old status could not: pairing/identity, the local daemon (user/home/version),
 * the tunnel, HTTPS whoami, the WebSocket upgrade, and systemd lingering.
 */
async function doctorCommand(
  io: CloudIo,
  opts: CloudCliOptions,
  home: string,
  runtimeDir: string,
  argv: readonly string[],
): Promise<number> {
  const flags = parseFlags(argv, new Set(["json"]))
  if (flags.error !== null) {
    io.err(`sensus cloud doctor: ${flags.error}`)
    return 1
  }
  const env = opts.env ?? process.env
  const uid = opts.uid ?? safeUid() ?? -1
  const checks: DoctorCheck[] = []
  const add = (id: string, status: DoctorStatus, message: string): void => {
    checks.push({ id, status, message })
  }
  const finish = (): number => {
    const ok = !checks.some((check) => check.status === "fail")
    if (flags.values.get("json") === true) {
      io.out(JSON.stringify({ ok, home, runtimeDir, checks }, null, 2))
    } else {
      io.out("sensus cloud: doctor")
      for (const check of checks) {
        io.out(`  ${DOCTOR_MARK[check.status].padEnd(4)}  ${check.id.padEnd(10)} ${check.message}`)
      }
      io.out(ok ? "sensus cloud: no blocking problems found" : "sensus cloud: blocking problems found")
    }
    return ok ? 0 : 1
  }

  const read = readCloudConnection(home)
  if (!read.ok) {
    add("pairing", "fail", read.error)
    return finish()
  }
  if (read.connection === null) {
    add("pairing", "fail", "not paired — run `sensus cloud pair --cloud <url>`")
    return finish()
  }
  const connection = read.connection
  add("pairing", "ok", `${connection.cloud} (${connection.instanceId})`)

  const identity = readIdentity(home)
  if (identity.error !== null) add("identity", "fail", identity.error)
  else if (identity.identity === null) add("identity", "fail", "host identity is missing (a new pairing is required)")
  else if (identity.identity.fingerprint !== connection.fingerprint) {
    add("identity", "fail", `fingerprint ${identity.identity.fingerprint} does not match the pairing ${connection.fingerprint}`)
  } else add("identity", "ok", `fingerprint ${identity.identity.fingerprint}`)

  const policy = readPolicy(home)
  if (!policy.ok) add("policy", "fail", policy.error)
  else if (policy.policy.scopes.length === 0) add("policy", "fail", "the host policy grants no scopes")
  else add("policy", "ok", `scopes ${policy.policy.scopes.join(",")}`)

  const daemon = await getCloudDaemonStatus(opts, home, runtimeDir)
  if (!daemon.running) {
    add("daemon", "fail", daemon.lastError ?? `not running (${daemon.state})`)
  } else {
    add("daemon", "ok", `pid ${daemon.pid ?? "?"}, version ${daemon.version ?? "?"}`)
    if (daemon.home === null) add("home", "warn", "the running daemon does not report its config home (older build)")
    else if (!samePath(daemon.home, home)) add("home", "fail", `daemon home ${daemon.home} != ${home}`)
    else add("home", "ok", daemon.home)
    if (daemon.uid === null) add("user", "skip", "the daemon does not report a uid")
    else if (uid >= 0 && daemon.uid !== uid) add("user", "fail", `daemon uid ${daemon.uid} != ${uid}`)
    else add("user", "ok", `uid ${daemon.uid}${daemon.unixUser !== null ? ` (${daemon.unixUser})` : ""}`)
    if (daemon.version === null) add("version", "skip", "the daemon does not report a version")
    else if (daemon.version !== SENSUS_VERSION) {
      add("version", "warn", `daemon ${daemon.version}, CLI ${SENSUS_VERSION}; restart after an upgrade`)
    } else add("version", "ok", `daemon ${daemon.version}`)

    if (daemon.probeError !== null) add("tunnel", "fail", daemon.probeError)
    else if (daemon.connected) add("tunnel", "ok", `connected (${daemon.state})`)
    else {
      add("tunnel", "fail", `state ${daemon.state}${daemon.lastError !== null ? `: ${daemon.lastError}` : ""}`)
    }
  }

  const who = await whoami(
    { cloud: connection.cloud, instanceId: connection.instanceId, deviceToken: connection.deviceToken },
    opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {},
  )
  if (!who.ok) add("whoami", "fail", who.error ?? `HTTP ${who.status}`)
  else if (who.state === "active") add("whoami", "ok", "active")
  else if (who.state === "pending") add("whoami", "warn", "pending owner approval")
  else add("whoami", "fail", "revoked")

  if (daemon.running && daemon.connected) {
    add("wss", "ok", "tunnel is connected; upgrade probe skipped")
  } else {
    const probe = await probeConnectorUpgrade({
      cloud: connection.cloud,
      deviceToken: connection.deviceToken,
      instanceId: connection.instanceId,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    })
    add("wss", probe.ok ? "ok" : "fail", probe.detail)
  }

  const linger = await (opts.linger ?? checkUserLinger)({ env })
  if (!linger.applicable) add("linger", "skip", "not a systemd user session")
  else if (linger.enabled === true) add("linger", "ok", `enabled for ${linger.user}`)
  else if (linger.enabled === false) {
    add("linger", "warn", `disabled; run \`${linger.enableCommand ?? `loginctl enable-linger ${linger.user}`}\``)
  } else add("linger", "skip", linger.detail ?? "could not read the lingering state")

  return finish()
}

/** Run one `sensus cloud` invocation. Returns a process exit code. */
export async function runCloud(
  argv: readonly string[],
  io: CloudIo,
  env: NodeJS.ProcessEnv = process.env,
  opts: CloudCliOptions = {},
): Promise<number> {
  const home = opts.home ?? sensusHomeFrom(env)
  const runtimeDir = opts.runtimeDir ?? resolveRuntimeDir(env)
  const [command, ...rest] = argv
  try {
    if (command === undefined || command === "help" || command === "--help") {
      io.out(USAGE)
      return command === undefined ? 1 : 0
    }
    if (command === "pair") return await pairCommand(io, { ...opts, env }, rest)
    if (command === "scopes") return await scopesCommand(io, { ...opts, env }, home, runtimeDir, rest)
    if (command === "status") {
      const flags = parseFlags(rest, new Set(["json"]))
      if (flags.error !== null) {
        io.err(`sensus cloud status: ${flags.error}`)
        return 1
      }
      return await statusCommand(io, { ...opts, env }, home, runtimeDir, flags.values.get("json") === true)
    }
    if (command === "doctor") return await doctorCommand(io, { ...opts, env }, home, runtimeDir, rest)
    if (command === "disable") return await setEnabled(io, { ...opts, env }, home, runtimeDir, false)
    if (command === "enable") return await setEnabled(io, { ...opts, env }, home, runtimeDir, true)
    if (command === "unpair") return await unpairCommand(io, { ...opts, env }, home, runtimeDir)
    io.err(`sensus cloud: unknown command ${JSON.stringify(command)}`)
    io.err(USAGE)
    return 1
  } catch (e) {
    io.err(`sensus cloud: ${errorMessage(e)}`)
    return 1
  }
}

/** True when this pairing grants a scope (for the status line/tests). */
export function connectionHasScope(connection: CloudConnection, scope: "view" | "chat" | "control" | "orchestrator"): boolean {
  return hasScope(connection.scopes, scope)
}
