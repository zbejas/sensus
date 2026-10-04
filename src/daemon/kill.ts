/**
 * `sensus kill` — the global kill switch (docs/operations.md "Daemon").
 *
 * `sensus daemon stop` stops the daemon the CURRENT environment owns (the
 * runtime dir resolved from this shell); `sensus kill` is the escape hatch:
 * it finds every running `sensus daemon serve` process owned by the current
 * user — whatever `SENSUS_RUNTIME_DIR` it was started with (a dev/test
 * instance, another checkout, a stale persistent unit) — SIGTERMs them all,
 * escalates to SIGKILL for anything that will not exit, and removes the stale
 * socket/pidfile artifacts.
 *
 * Discovery is a process-table scan: `/proc/<pid>/cmdline` on Linux (exact
 * argv, uid-filtered) and `ps -axo pid=,uid=,command=` elsewhere. The pure
 * matchers (`isDaemonServeArgv`, `commandLineLooksLikeDaemonServe`) keep the
 * scan precise: a process that merely mentions "daemon serve" in its args is
 * never matched. Only the current uid is ever signalled, and nothing here
 * throws — a scan/signal failure is a result the caller reports.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename } from "node:path"
import { sensusRuntimeDirFrom } from "../engine/index.ts"
import { daemonPidPath, daemonSocketPath } from "./paths.ts"
import { serviceUnitKind, serviceUnitPath } from "./service.ts"
import { readPidFile } from "./token.ts"

/** Wait between liveness polls while stopping daemons. */
const KILL_POLL_MS = 100
/** How long SIGTERM gets before the SIGKILL escalation. */
const KILL_TIMEOUT_MS = 5000
/** Extra beat after SIGKILL before declaring a process unstoppable. */
const KILL_SETTLE_MS = 200

/** Output seam (structurally matches `src/cli.ts`'s `CliIo`). */
export interface KillIo {
  out(s: string): void
  err(s: string): void
}

export const KILL_USAGE = `usage: sensus kill [--dry-run]

Stop every running sensus daemon on this machine (all runtime dirs, current
user) and the shells they own: SIGTERM first, SIGKILL for anything that will
not exit. This is the kill switch; \`sensus daemon stop\` stops only the daemon
this environment owns.

  --dry-run, -n   list the daemons that would be stopped; kill nothing
  --help, -h      this text`

// ---- process matchers (pure) ------------------------------------------------

/** True when `exe` looks like the sensus binary or a Bun runtime. */
function looksLikeSensusOrBun(exe: string): boolean {
  return exe === "sensus" || /^bun(?:-[a-z0-9.]+)?$/i.test(exe)
}

/**
 * Pure matcher for one process's exact argv (`/proc/<pid>/cmdline`): the
 * compiled form `sensus daemon serve`, or the dev form `bun <entry> daemon
 * serve` when the entry looks like sensus (its path names sensus, or it is an
 * `index.tsx` entry).
 */
export function isDaemonServeArgv(argv: readonly string[]): boolean {
  let serveAt = -1
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] === "daemon" && argv[i + 1] === "serve") {
      serveAt = i
      break
    }
  }
  if (serveAt < 0) return false
  const exe = basename(argv[0] ?? "")
  if (!looksLikeSensusOrBun(exe)) return false
  if (exe === "sensus") return true
  for (let i = 1; i < serveAt; i++) {
    const arg = argv[i] ?? ""
    if (/sensus/i.test(arg) || arg.endsWith("index.tsx")) return true
  }
  return false
}

/**
 * Pure matcher for a `ps`-style command line (the non-Linux scan path): the
 * same shapes as `isDaemonServeArgv`, matched as one whitespace-joined string.
 */
export function commandLineLooksLikeDaemonServe(command: string): boolean {
  const trimmed = command.trim()
  if (!/(?:^|\s)daemon\s+serve(?:\s|$)/.test(trimmed)) return false
  const exe = basename(trimmed.split(/\s+/)[0] ?? "")
  if (exe === "sensus") return true
  if (!looksLikeSensusOrBun(exe)) return false
  return /sensus/i.test(trimmed) || /index\.tsx(?:\s|$)/.test(trimmed)
}

// ---- process-table scan ------------------------------------------------------

/** One discovered daemon process. */
export interface DaemonProcess {
  pid: number
  /** The daemon's runtime dir when discoverable (Linux `/proc/<pid>/environ`), else null. */
  runtimeDir: string | null
}

export type DaemonScanResult = { ok: true; daemons: DaemonProcess[] } | { ok: false; error: string }

export interface ScanDaemonOptions {
  /** uid to keep; defaults to `process.getuid()`. Negative disables the filter (tests). */
  uid?: number
  /** Exact-argv matcher override (tests). */
  matchArgv?: (argv: readonly string[]) => boolean
  /** Command-line matcher override (tests). */
  matchCommandLine?: (command: string) => boolean
  /** Pids to exclude; the caller is always excluded. */
  exclude?: readonly number[]
  /** Force the `ps` fallback (tests). */
  forcePs?: boolean
}

/** The current uid, or -1 where `getuid` is unavailable (no uid filter). */
function currentUid(): number {
  try {
    const uid = process.getuid?.()
    return typeof uid === "number" ? uid : -1
  } catch {
    return -1
  }
}

/** Read one process's exact argv from `/proc/<pid>/cmdline`; null when gone. */
function readProcArgv(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8")
    const argv = raw.split("\0").filter((part) => part.length > 0)
    return argv.length > 0 ? argv : null
  } catch {
    return null
  }
}

/** Read one env value from `/proc/<pid>/environ`; null when absent/unreadable. */
function readProcEnviron(pid: number, key: string): string | null {
  try {
    const prefix = `${key}=`
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      if (entry.startsWith(prefix)) return entry.slice(prefix.length)
    }
  } catch {
    // a foreign uid or a race — the runtime dir stays unknown
  }
  return null
}

/** Scan `/proc` for daemons; null when procfs is unavailable (macOS/BSD). */
function scanProc(
  uid: number,
  exclude: ReadonlySet<number>,
  match: (argv: readonly string[]) => boolean,
): DaemonProcess[] | null {
  let entries: string[]
  try {
    entries = readdirSync("/proc")
  } catch {
    return null
  }
  const daemons: DaemonProcess[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (exclude.has(pid)) continue
    try {
      if (uid >= 0 && statSync(`/proc/${pid}`).uid !== uid) continue
      const argv = readProcArgv(pid)
      if (argv === null || !match(argv)) continue
      daemons.push({ pid, runtimeDir: readProcEnviron(pid, "SENSUS_RUNTIME_DIR") })
    } catch {
      // the process exited (or /proc denied us) between readdir and read
    }
  }
  return daemons
}

/** The real `ps` runner; `ps` then `/bin/ps` for a broken PATH. */
function runPs(): { ok: true; text: string } | { ok: false; error: string } {
  for (const bin of ["ps", "/bin/ps"]) {
    try {
      const res = Bun.spawnSync([bin, "-axo", "pid=,uid=,command="], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
      if (res.exitCode === 0) return { ok: true, text: res.stdout.toString() }
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "cannot list processes (ps failed)" }
}

/** The `ps` fallback: parse `pid uid command` lines, uid-filtered. */
function scanPs(
  uid: number,
  exclude: ReadonlySet<number>,
  match: (command: string) => boolean,
): DaemonScanResult {
  const ps = runPs()
  if (!ps.ok) return ps
  const daemons: DaemonProcess[] = []
  for (const line of ps.text.split("\n")) {
    const parsed = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (parsed === null) continue
    const pid = Number(parsed[1])
    const lineUid = Number(parsed[2])
    const command = parsed[3] ?? ""
    if (exclude.has(pid)) continue
    if (uid >= 0 && lineUid !== uid) continue
    if (!match(command)) continue
    daemons.push({ pid, runtimeDir: null })
  }
  return { ok: true, daemons }
}

/**
 * Find every running sensus daemon owned by `uid` (default: this user).
 * `/proc` first (exact argv), `ps` otherwise. Never throws.
 */
export function scanDaemonProcesses(opts: ScanDaemonOptions = {}): DaemonScanResult {
  const uid = opts.uid ?? currentUid()
  const exclude = new Set<number>(opts.exclude ?? [])
  exclude.add(process.pid)
  if (!(opts.forcePs ?? false)) {
    const viaProc = scanProc(uid, exclude, opts.matchArgv ?? isDaemonServeArgv)
    if (viaProc !== null) return { ok: true, daemons: viaProc }
  }
  return scanPs(uid, exclude, opts.matchCommandLine ?? commandLineLooksLikeDaemonServe)
}

// ---- the kill switch ---------------------------------------------------------

/** True when a pid names a live process (EPERM still counts as alive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

type ParsedKillArgs = { ok: true; dryRun: boolean; help: boolean } | { ok: false; error: string }

/** Parse `sensus kill` flags. Unknown flags are an error (unlike `daemon logs`). */
function parseKillArgs(args: readonly string[]): ParsedKillArgs {
  let dryRun = false
  let help = false
  for (const arg of args) {
    if (arg === "--dry-run" || arg === "-n") dryRun = true
    else if (arg === "--help" || arg === "-h") help = true
    else if (arg.length > 0) return { ok: false, error: `unknown flag: ${arg}` }
  }
  return { ok: true, dryRun, help }
}

/** Note the persistent service so the kill switch is not silently undone. */
function notePersistentService(io: KillIo, env: NodeJS.ProcessEnv, opts: RunKillOptions): void {
  const kind = serviceUnitKind(opts.platform ?? process.platform)
  if (kind === null) return
  const home = opts.home ?? env["HOME"] ?? homedir()
  const unitPath = serviceUnitPath(kind, home)
  if (!existsSync(unitPath)) return
  io.out(
    `sensus kill: note: the persistent service is installed (${unitPath}) and can start a daemon again — \`sensus daemon uninstall\` removes it`,
  )
}

/** Test seams for `runKill`; production callers pass none. */
export interface RunKillOptions {
  /** Scanner override (tests). Defaults to `scanDaemonProcesses`. */
  scan?: () => DaemonScanResult
  /** Signal sender override (tests). Defaults to `process.kill`. */
  signal?: (pid: number, signal: NodeJS.Signals) => void
  /** Liveness probe override (tests). Defaults to `kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean
  /** Sleep override (tests). Defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
  /** SIGTERM→SIGKILL budget (ms); default 5000. */
  timeoutMs?: number
  /** Liveness poll interval (ms); default 100. */
  pollMs?: number
  /** Platform override for the persistent-service note (tests). */
  platform?: NodeJS.Platform
  /** HOME override for the persistent-service note (tests). */
  home?: string
}

/**
 * `sensus kill [--dry-run]` — stop every running daemon, whatever runtime dir
 * it was started with. Idempotent: "no running daemons" is a success. Returns
 * the process exit code; never throws.
 */
export async function runKill(
  argv: readonly string[],
  io: KillIo,
  env: NodeJS.ProcessEnv,
  opts: RunKillOptions = {},
): Promise<number> {
  const parsed = parseKillArgs(argv)
  if (!parsed.ok) {
    io.err(`sensus kill: ${parsed.error}`)
    io.err(KILL_USAGE)
    return 1
  }
  if (parsed.help) {
    io.out(KILL_USAGE)
    return 0
  }

  const scanned = (opts.scan ?? scanDaemonProcesses)()
  if (!scanned.ok) {
    io.err(`sensus kill: ${scanned.error}`)
    return 1
  }

  // Union with the current runtime dir's pidfile: a daemon the scan cannot see
  // (a renamed binary, a restricted /proc) is still stopped when it is the one
  // this environment owns. Same pidfile contract `daemon stop` uses.
  const currentDir = sensusRuntimeDirFrom(env)
  const pidfilePid = readPidFile(daemonPidPath(currentDir))
  const byPid = new Map<number, DaemonProcess>()
  for (const daemon of scanned.daemons) byPid.set(daemon.pid, daemon)
  if (pidfilePid !== null && !byPid.has(pidfilePid) && pidfilePid !== process.pid) {
    byPid.set(pidfilePid, { pid: pidfilePid, runtimeDir: currentDir })
  }
  const daemons = [...byPid.values()].sort((a, b) => a.pid - b.pid)
  const pidsLabel = daemons.map((d) => `pid ${d.pid}`).join(", ")

  if (daemons.length === 0) {
    io.out("sensus kill: no running daemons")
    return 0
  }

  if (parsed.dryRun) {
    io.out(`sensus kill: would stop ${daemons.length} daemon(s) (${pidsLabel})`)
    notePersistentService(io, env, opts)
    return 0
  }

  if (env["SENSUS_ACTIVE"] !== undefined && env["SENSUS_ACTIVE"] !== "") {
    io.err("sensus kill: warning: this includes the daemon hosting this sensus pane — its shell dies with it")
  }

  const signal = opts.signal ?? ((pid: number, sig: NodeJS.Signals): void => { process.kill(pid, sig) })
  const alive = opts.isAlive ?? isAlive
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const timeoutMs = opts.timeoutMs ?? KILL_TIMEOUT_MS
  const pollMs = opts.pollMs ?? KILL_POLL_MS

  for (const daemon of daemons) {
    try {
      signal(daemon.pid, "SIGTERM")
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && daemons.some((d) => alive(d.pid))) await sleep(pollMs)

  const forceKilled: number[] = []
  for (const daemon of daemons) {
    if (!alive(daemon.pid)) continue
    try {
      signal(daemon.pid, "SIGKILL")
      forceKilled.push(daemon.pid)
    } catch {
      // it exited between the liveness check and the kill
    }
  }
  if (forceKilled.length > 0) await sleep(KILL_SETTLE_MS)

  const survivors = daemons.filter((d) => alive(d.pid)).map((d) => d.pid)
  if (survivors.length > 0) {
    io.err(`sensus kill: could not stop ${survivors.length} daemon(s) (${survivors.map((p) => `pid ${p}`).join(", ")})`)
    return 1
  }

  // A SIGKILLed daemon never runs its own cleanup, so drop the stale
  // socket/pidfile for every runtime dir we discovered (plus this one).
  const dirs = new Set<string>([currentDir])
  for (const daemon of daemons) if (daemon.runtimeDir !== null) dirs.add(daemon.runtimeDir)
  for (const dir of dirs) {
    for (const path of [daemonPidPath(dir), daemonSocketPath(dir)]) {
      try {
        rmSync(path, { force: true })
      } catch {
        // best-effort
      }
    }
  }

  io.out(`sensus kill: stopped ${daemons.length} daemon(s) (${pidsLabel})`)
  if (forceKilled.length > 0) {
    io.out(`sensus kill: force-killed ${forceKilled.map((p) => `pid ${p}`).join(", ")}`)
  }
  notePersistentService(io, env, opts)
  return 0
}
