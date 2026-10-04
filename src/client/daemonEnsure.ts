/**
 * daemonEnsure — the boot primitive (D3/D5/D21; docs/daemon-api.md "Lifecycle").
 *
 * The client is HTTP/WS-only (D5): before it can do anything it needs a running
 * daemon. `ensureDaemon` resolves the runtime dir, probes for a healthy daemon
 * (over REST), and otherwise auto-spawns one with the SAME self-exec logic the
 * CLI uses (`daemonSelfArgv`). It then reads `GET /v1/info` and applies the
 * D21 version handshake via the daemon's own pure `versionMismatchAction`: equal
 * versions proceed, a shell-less daemon is restarted, and a daemon that holds
 * shells yields a warning for the caller (P4c lets the user choose).
 *
 * Nothing here throws into the TUI (AGENTS.md rule 10): every failure is a
 * discriminated `{ ok:false, error }` with a human message — a missing socket,
 * a refused spawn, a token error, or a readiness timeout.
 *
 * `connect()` is the convenience the P4c boot uses: ensure, then open a
 * `WsClient`; its `stop()` detaches (closes the socket) but never kills the
 * daemon — quitting leaves the shells alive (D4).
 */

import { closeSync, existsSync, openSync, rmSync } from "node:fs"
import { errorMessage } from "../core/util.ts"
import { SENSUS_VERSION } from "../version.ts"
import { daemonLogPath, daemonPidPath, daemonRuntimeDir, daemonSocketPath, daemonTokenPath } from "../daemon/paths.ts"
import { ensureRuntimeDir, readPidFile, readToken } from "../daemon/token.ts"
import { daemonSelfArgv } from "../daemon/selfExec.ts"
import { versionMismatchAction } from "../daemon/version.ts"
import type { DaemonInfo } from "../daemon/index.ts"
import { RestClient } from "./restClient.ts"
import { WsClient, type WsClientOptions } from "./wsClient.ts"

/** The daemon a caller can now talk to (also embedded in the `ok` results). */
export interface DaemonTarget {
  runtimeDir: string
  token: string
  info: DaemonInfo
  /** True when THIS call spawned the daemon (false when it attached). */
  spawned: boolean
  /**
   * A non-fatal handshake note. Set when the running daemon's version differs
   * from `localVersion` and it could not be auto-restarted (it holds shells, or
   * auto-spawn is disabled) — the caller warns and lets the user choose (D21).
   */
  warning: string | null
}

export type EnsureDaemonResult = ({ ok: true } & DaemonTarget) | { ok: false; error: string }

export type SpawnOutcome = { ok: true; pid?: number } | { ok: false; error: string }
export type StopOutcome = { ok: true } | { ok: false; error: string }

export interface EnsureDaemonOptions {
  /** Runtime dir holding `daemon.sock`/`daemon.token`; defaults to `daemonRuntimeDir()`. */
  runtimeDir?: string
  /** Version to compare against `/v1/info.version`; defaults to `SENSUS_VERSION`. */
  localVersion?: string
  /**
   * Allow auto-spawn (D3); default true. When false, a missing/unreachable
   * daemon is a clear error instead of a spawn.
   */
  spawn?: boolean
  /** Per-probe REST timeout (ms); default 2000. */
  probeTimeoutMs?: number
  /** Readiness poll budget after a spawn (ms); default 8000. */
  spawnTimeoutMs?: number
  /** SIGTERM→SIGKILL budget while restarting (ms); default 5000. */
  stopTimeoutMs?: number
  /** Poll interval for readiness and stop (ms); default 100. */
  pollMs?: number
  /** Test seam: start the daemon instead of `Bun.spawn`. */
  spawnDaemon?: (argv: readonly string[]) => SpawnOutcome | Promise<SpawnOutcome>
  /** Test seam: stop the daemon instead of the pidfile SIGTERM path. */
  stopDaemon?: (runtimeDir: string) => StopOutcome | Promise<StopOutcome>
  /** Test seam: build the REST client (defaults to a UDS `RestClient`). */
  rest?: (runtimeDir: string, token: string) => RestClient
  /** Test seam: sleep (defaults to `Bun.sleep`). */
  sleep?: (ms: number) => Promise<void>
  /** Test seam: the argv to re-exec with (defaults to `process.execPath`). */
  execPath?: string
  /** Test seam: `Bun.main` (dev entry). */
  bunMain?: string
  /** Test seam: whether this is a compiled binary. */
  compiled?: boolean
}

/** A live connection: the ensured daemon plus the REST + WS clients it needs. */
export interface DaemonConnection extends DaemonTarget {
  rest: RestClient
  ws: WsClient
  /** Detach: close the socket; the daemon (and its shells) stay alive (D4). */
  stop(): void
}

export type ConnectDaemonResult = ({ ok: true } & DaemonConnection) | { ok: false; error: string }

export interface ConnectDaemonOptions extends EnsureDaemonOptions {
  /** Extra WS client options (timeout/reconnect/queue caps/error sink). */
  wsOptions?: Omit<WsClientOptions, "runtimeDir" | "token" | "port" | "host" | "url">
}

function sleepDefault(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

/** True when a pid names a live process (EPERM still counts as alive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function makeRest(opts: EnsureDaemonOptions, runtimeDir: string, token: string): RestClient {
  if (opts.rest !== undefined) return opts.rest(runtimeDir, token)
  return new RestClient({ runtimeDir, token, timeoutMs: opts.probeTimeoutMs ?? 2000 })
}

/** A human warning for a mismatch that could not be auto-resolved (D21). */
function mismatchWarning(localVersion: string, info: DaemonInfo): string {
  const held = info.shells > 0 ? ` and holds ${info.shells} shell(s)` : ""
  return `daemon version ${info.version} differs from sensus ${localVersion}${held}; restart the daemon to update`
}

/** The clear "nothing is there" message (D5): names the exact missing piece. */
function describeUnavailable(runtimeDir: string): string {
  if (readToken(daemonTokenPath(runtimeDir)) === null) {
    return `no daemon is running at ${runtimeDir} (missing ${daemonTokenPath(runtimeDir)})`
  }
  return `the daemon at ${runtimeDir} is not responding on ${daemonSocketPath(runtimeDir)}`
}

/** Probe an existing daemon: null when there is no token or it does not answer. */
async function probeExisting(
  runtimeDir: string,
  opts: EnsureDaemonOptions,
): Promise<{ token: string; info: DaemonInfo } | null> {
  const token = readToken(daemonTokenPath(runtimeDir))
  if (token === null) return null
  try {
    const info = await makeRest(opts, runtimeDir, token).info()
    return { token, info }
  } catch {
    return null
  }
}

/** The base argv to re-exec the daemon with, via the CLI's exported helper. */
function selfArgv(opts: EnsureDaemonOptions): string[] {
  const execPath = opts.execPath ?? process.execPath
  const bunMain = opts.bunMain ?? Bun.main
  const compiled = opts.compiled ?? import.meta.url.includes("$bunfs")
  return daemonSelfArgv(execPath, bunMain, compiled)
}

interface Launched {
  /** The child's exit code, or null while it runs (undefined seam = unknown). */
  exitCode: () => number | null | undefined
}

/** Launch the daemon (detached) or delegate to the test seam. */
async function launch(
  opts: EnsureDaemonOptions,
  runtimeDir: string,
): Promise<({ ok: true } & Launched) | { ok: false; error: string }> {
  const ready = ensureRuntimeDir(runtimeDir)
  if (!ready.ok) return { ok: false, error: `cannot create runtime dir ${runtimeDir}: ${ready.error ?? "unknown error"}` }

  const argv = [...selfArgv(opts), "daemon", "serve"]
  if (opts.spawnDaemon !== undefined) {
    try {
      const out = await opts.spawnDaemon(argv)
      return out.ok ? { ok: true, exitCode: () => null } : { ok: false, error: out.error }
    } catch (e) {
      return { ok: false, error: `could not start the daemon: ${errorMessage(e)}` }
    }
  }

  const logPath = daemonLogPath(runtimeDir)
  let child: ReturnType<typeof Bun.spawn>
  const fd = openSync(logPath, "a", 0o600)
  try {
    child = Bun.spawn(argv, { detached: true, stdio: ["ignore", fd, fd] })
    child.unref()
  } catch (e) {
    return { ok: false, error: `could not start the daemon: ${errorMessage(e)}` }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
  return { ok: true, exitCode: () => child.exitCode }
}

/** Spawn, then poll the token + `/v1/info` until ready (or the budget ends). */
async function spawnAndWait(
  opts: EnsureDaemonOptions,
  runtimeDir: string,
  localVersion: string,
): Promise<EnsureDaemonResult> {
  const launched = await launch(opts, runtimeDir)
  if (!launched.ok) return launched
  const sleep = opts.sleep ?? sleepDefault
  const pollMs = opts.pollMs ?? 100
  const deadline = Date.now() + (opts.spawnTimeoutMs ?? 8000)
  const logPath = daemonLogPath(runtimeDir)

  for (;;) {
    const exited = launched.exitCode()
    if (typeof exited === "number") {
      return { ok: false, error: `the daemon exited on startup (code ${exited}) — see ${logPath}` }
    }
    const token = readToken(daemonTokenPath(runtimeDir))
    if (token !== null) {
      try {
        const info = await makeRest(opts, runtimeDir, token).info()
        const action = versionMismatchAction(localVersion, info.version, info.shells)
        return {
          ok: true,
          runtimeDir,
          token,
          info,
          spawned: true,
          warning: action === "ok" ? null : mismatchWarning(localVersion, info),
        }
      } catch {
        // not ready yet — keep polling
      }
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: `timed out waiting for the daemon at ${runtimeDir} — see ${logPath}` }
    }
    await sleep(pollMs)
  }
}

/** Stop a running daemon (pidfile SIGTERM→SIGKILL) so a restart can rebind. */
async function stopDaemonProcess(opts: EnsureDaemonOptions, runtimeDir: string): Promise<StopOutcome> {
  if (opts.stopDaemon !== undefined) {
    try {
      return await opts.stopDaemon(runtimeDir)
    } catch (e) {
      return { ok: false, error: errorMessage(e) }
    }
  }
  const sleep = opts.sleep ?? sleepDefault
  const pollMs = opts.pollMs ?? 100
  const pidPath = daemonPidPath(runtimeDir)
  const socketPath = daemonSocketPath(runtimeDir)
  const pid = readPidFile(pidPath)

  if (pid === null || !isAlive(pid)) {
    try {
      rmSync(pidPath, { force: true })
      rmSync(socketPath, { force: true })
    } catch {
      // best-effort
    }
    return { ok: true }
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (e) {
    return { ok: false, error: `could not signal pid ${pid}: ${errorMessage(e)}` }
  }
  const deadline = Date.now() + (opts.stopTimeoutMs ?? 5000)
  while (Date.now() < deadline && isAlive(pid)) await sleep(pollMs)
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // it may have exited between the check and the kill
    }
    await sleep(200)
  }
  try {
    rmSync(pidPath, { force: true })
  } catch {
    // best-effort
  }
  for (let i = 0; i < 20 && existsSync(socketPath); i++) await sleep(pollMs)
  try {
    rmSync(socketPath, { force: true })
  } catch {
    // best-effort
  }
  return { ok: true }
}

async function ensure(opts: EnsureDaemonOptions, restarted: boolean): Promise<EnsureDaemonResult> {
  const runtimeDir = opts.runtimeDir ?? daemonRuntimeDir()
  const localVersion = opts.localVersion ?? SENSUS_VERSION
  const existing = await probeExisting(runtimeDir, opts)

  if (existing !== null) {
    const action = versionMismatchAction(localVersion, existing.info.version, existing.info.shells)
    if (action === "ok") {
      return {
        ok: true,
        runtimeDir,
        token: existing.token,
        info: existing.info,
        spawned: false,
        warning: null,
      }
    }
    if (action === "warn" || opts.spawn === false || restarted) {
      // A shell-holding daemon, a no-spawn caller, or a daemon we just launched:
      // never restart silently. Hand the warning up (D21).
      return {
        ok: true,
        runtimeDir,
        token: existing.token,
        info: existing.info,
        spawned: false,
        warning: mismatchWarning(localVersion, existing.info),
      }
    }
    // action === "restart": the shell-less old daemon is stopped and replaced.
    const stopped = await stopDaemonProcess(opts, runtimeDir)
    if (!stopped.ok) {
      return {
        ok: false,
        error: `version mismatch (${existing.info.version} → ${localVersion}) and the daemon could not be stopped: ${stopped.error}`,
      }
    }
    return await spawnAndWait(opts, runtimeDir, localVersion)
  }

  if (opts.spawn === false) return { ok: false, error: describeUnavailable(runtimeDir) }
  return await spawnAndWait(opts, runtimeDir, localVersion)
}

/**
 * Ensure a daemon is running: reuse a healthy one, otherwise auto-spawn, then
 * apply the D21 version handshake. Never throws; failures are `{ok:false,error}`.
 */
export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  return await ensure(opts, false)
}

/**
 * Stop any running daemon and start a fresh one (the user's "restart, lose the
 * shells" choice from D21). Reuses the same spawn/handshake path.
 */
export async function restartDaemon(opts: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const runtimeDir = opts.runtimeDir ?? daemonRuntimeDir()
  const stopped = await stopDaemonProcess(opts, runtimeDir)
  if (!stopped.ok) return { ok: false, error: `could not stop the daemon: ${stopped.error}` }
  return await ensure({ ...opts, spawn: opts.spawn ?? true }, true)
}

/**
 * The D21 boot action behind the version prompt's "restart" choice: detach the
 * current connection, stop the stale daemon (losing its shells), start a fresh
 * one, and open a new client to it. `restartDaemon` already reuses the exact
 * spawn/handshake path; the extra `connect` here is what re-opens the REST + WS
 * clients the UI needs. Never throws — failures are `{ok:false,error}`.
 */
export async function restartAndReconnect(
  conn: DaemonConnection,
  opts: ConnectDaemonOptions = {},
): Promise<ConnectDaemonResult> {
  // Detach first: the old socket must not outlive the daemon it talks to.
  conn.stop()
  const restarted = await restartDaemon({ ...opts, spawn: opts.spawn ?? true })
  if (!restarted.ok) return restarted
  return await connect(opts)
}

/**
 * A wildcard daemon bind (`0.0.0.0`/`::`, from `SENSUS_DAEMON_HOST`) is
 * reachable at loopback from the same host — used for the WS client.
 */
function wsConnectHost(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "::0" ? "127.0.0.1" : host
}

/**
 * Ensure a daemon and open the terminal WebSocket. `stop()` detaches only
 * (D4) — it closes the socket and leaves the daemon and its shells alive.
 */
export async function connect(opts: ConnectDaemonOptions = {}): Promise<ConnectDaemonResult> {
  const ensured = await ensureDaemon(opts)
  if (!ensured.ok) return ensured
  const rest = makeRest(opts, ensured.runtimeDir, ensured.token)
  const ws = new WsClient({
    runtimeDir: ensured.runtimeDir,
    token: ensured.token,
    host: wsConnectHost(ensured.info.tcp.host),
    port: ensured.info.tcp.port,
    ...opts.wsOptions,
  })
  const stop = (): void => {
    try {
      ws.close()
    } catch {
      // idempotent
    }
  }
  return { ...ensured, rest, ws, stop }
}
