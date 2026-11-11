/**
 * `sensus cloud` — pair this daemon with a Sensus Cloud panel.
 *
 * This replaces the separate `sensus auth` step and the standalone connector:
 * pairing creates the Ed25519 host identity and host-local scope policy if
 * needed, exchanges the one-time code, stores the device token under
 * `<SENSUS_HOME>/cloud/connection.json` (0600), and the daemon opens the
 * outbound tunnel. No inbound port is opened.
 */

import { createInterface } from "node:readline/promises"
import { errorMessage } from "../../core/util.ts"
import { loadOrCreateIdentity } from "../../auth/identity.ts"
import { defaultPolicy, readPolicy, writePolicy } from "../../auth/policy.ts"
import { parseScopeList, hasScope, SCOPES, type Scope } from "../../auth/scopes.ts"
import { safeUid } from "../../auth/paths.ts"
import { sensusHomeFrom } from "../../config/config/paths.ts"
import { SENSUS_VERSION } from "../../version.ts"
import { installService } from "../service.ts"
import { discoverDaemon, requestOverUnix } from "./discovery.ts"
import { daemonSocketPath, resolveRuntimeDir } from "./paths.ts"
import { pairWithCloud, promptHidden } from "./pairing.ts"
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
}

const USAGE = `sensus cloud — pair this host with a Sensus Cloud panel

Usage:
  sensus cloud pair --cloud <url> [--code <CODE>] [--allow <scopes>] [--allow-root]
  sensus cloud scopes [--allow <scopes>] [--allow-root] [--json]
  sensus cloud status [--json]
  sensus cloud disable | enable
  sensus cloud unpair

Pairing creates the host identity and scope policy if they do not exist,
stores the device token at <config>/cloud/connection.json (0600), and opens
one outbound WebSocket to the pinned cloud origin. No inbound port is opened.

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

async function reloadDaemon(
  io: CloudIo,
  opts: CloudCliOptions,
  runtimeDir: string,
): Promise<boolean> {
  if (opts.reload !== undefined) {
    const res = await opts.reload({ runtimeDir, env: opts.env ?? process.env })
    if (!res.ok) io.err(`sensus cloud: daemon reload failed: ${res.error ?? "unknown error"}`)
    return res.ok
  }
  const discovery = await (opts.discover ?? discoverDaemon)({ runtimeDir, env: opts.env ?? process.env })
  if (!discovery.ok) return false
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

async function ensureDaemonService(io: CloudIo, opts: CloudCliOptions, home: string, runtimeDir: string, uid: number): Promise<void> {
  const env = opts.env ?? process.env
  const discovery = await (opts.discover ?? discoverDaemon)({ runtimeDir, env })
  if (discovery.ok) {
    if (await reloadDaemon(io, opts, runtimeDir)) io.out("sensus cloud: daemon reloaded; the tunnel will connect")
    return
  }
  if (discovery.state === "unreachable") {
    io.err(`sensus cloud: a daemon socket exists but is not reachable (${discovery.message}).`)
    io.err("sensus cloud: fix or restart it with `sensus daemon restart`; pairing is saved.")
    return
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
  if (!install) return

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
    return
  }
  io.out(`sensus cloud: installed and enabled the Sensus daemon service for ${user}`)
  // The service manager starts it asynchronously; the daemon reads
  // connection.json on boot and opens the tunnel without another command.
}

function printStatus(
  io: CloudIo,
  connection: CloudConnection,
  daemon: { running: boolean; state?: string; connected?: boolean; lastError?: string | null } | null,
  json: boolean,
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
  if (daemon === null) {
    io.out("sensus cloud: daemon      not running")
  } else {
    io.out(`sensus cloud: daemon      ${daemon.connected === true ? "connected" : daemon.state ?? (daemon.running ? "running" : "not running")}`)
    if (daemon.lastError !== undefined && daemon.lastError !== null) io.out(`sensus cloud: last error  ${daemon.lastError}`)
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
  if (await reloadDaemon(io, opts, runtimeDir)) io.out("sensus cloud: daemon reloaded")
  else io.out("sensus cloud: the daemon will load the new scopes on its next start")
  return 0
}

async function statusCommand(io: CloudIo, opts: CloudCliOptions, home: string, runtimeDir: string, json: boolean): Promise<number> {
  const read = readCloudConnection(home)
  if (!read.ok) {
    io.err(`sensus cloud: ${read.error}`)
    return 1
  }
  const env = opts.env ?? process.env
  const discovery = await (opts.discover ?? discoverDaemon)({ runtimeDir, env })
  let daemon: { running: boolean; state?: string; connected?: boolean; lastError?: string | null } = { running: false }
  if (discovery.ok) {
    daemon = { running: true }
    try {
      const res = await requestOverUnix({
        unix: daemonSocketPath(runtimeDir),
        path: "/v1/cloud/status",
        token: discovery.discovery.token,
        timeoutMs: 5000,
      })
      if (res.status === 200) {
        const parsed: unknown = JSON.parse(res.body)
        if (typeof parsed === "object" && parsed !== null) {
          const record = parsed as Record<string, unknown>
          daemon = {
            running: true,
            state: typeof record["state"] === "string" ? record["state"] : undefined,
            connected: record["connected"] === true,
            lastError: typeof record["lastError"] === "string" ? record["lastError"] : null,
          }
        }
      }
    } catch {
      // status stays "running" when the route is unavailable
    }
  }
  if (read.connection === null) {
    if (json) io.out(JSON.stringify({ paired: false, daemon }, null, 2))
    else {
      io.out("sensus cloud: not paired — run `sensus cloud pair --cloud <url>`")
      if (daemon.running !== true) io.out("sensus cloud: daemon      not running")
    }
    return 0
  }
  printStatus(io, read.connection, daemon, json)
  return 0
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

  await ensureDaemonService(io, opts, home, runtimeDir, uid)
  io.out("")
  io.out("sensus cloud: pairing saved. Revoke it any time in the cloud's Fleet panel.")
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
  if (await reloadDaemon(io, opts, runtimeDir)) io.out("sensus cloud: daemon reloaded")
  return 0
}

async function unpairCommand(io: CloudIo, opts: CloudCliOptions, home: string, runtimeDir: string): Promise<number> {
  const cleared = clearCloudConnection(home)
  if (!cleared.ok) {
    io.err(`sensus cloud: ${cleared.error}`)
    return 1
  }
  io.out("sensus cloud: pairing removed locally")
  if (await reloadDaemon(io, opts, runtimeDir)) io.out("sensus cloud: daemon reloaded; the tunnel is stopped")
  io.out("sensus cloud: revoke the instance in the cloud's Fleet panel if it should not reconnect")
  return 0
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
