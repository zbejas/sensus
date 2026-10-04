/**
 * `sensus daemon <cmd>` lifecycle CLI (D18; docs/operations.md "Daemon"). The
 * daemon subcommands are headless: `src/cli.ts` dispatches here BEFORE the nest
 * guard, so `sensus daemon serve` works even inside a sensus pane, and
 * `src/index.tsx` awaits this (only) async decision.
 *
 * Commands:
 *   serve      run the listeners in the foreground and stay alive; on
 *              SIGINT/SIGTERM stop cleanly (close listeners, remove the socket
 *              file and pidfile). Tests drive exactly this.
 *   start      daemonize (setsid + detached, stdio -> logfile, pidfile), then
 *              wait briefly for `/v1/health` and report.
 *   stop       read the pidfile, SIGTERM, wait, confirm the socket is gone;
 *              idempotent when not running.
 *   status     pid + a health probe; exit 0 when healthy, 1 otherwise.
 *   logs       render the STRUCTURED log (`daemon-log.jsonl`); pretty on a TTY,
 *              raw NDJSON when piped, or forced with `--json`/`--pretty`.
 *   install / uninstall  write/remove a user service unit (systemd/launchd,
 *              persistent mode; P6). `--dry-run` prints instead of acting.
 *
 * Self-exec (`start`): derive the argv from `process.execPath` + `Bun.main` so it
 * works BOTH as the compiled binary (`dist/sensus`) and in dev
 * (`bun run src/index.tsx`). See `daemonSelfArgv`.
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs"
import { flushLoggerSync, LOG_LEVELS, parseLogLine, type LogLevel, type LogRecord } from "../core/log.ts"
import { sensusHomeFrom, sensusRuntimeDirFrom } from "../engine/index.ts"
import { daemonLogJsonlPath, daemonLogPath, daemonPidPath, daemonSocketPath, daemonTokenPath } from "./paths.ts"
import { componentLogger } from "./log.ts"
import { DOCS_PATH } from "./openapi.ts"
import { compiledEntry, daemonSelfArgv } from "./selfExec.ts"
import { installService, uninstallService } from "./service.ts"
import { displayHost, startDaemon } from "./serve.ts"
import { ensureRuntimeDir, readPidFile, readToken, writePidFile } from "./token.ts"

/** Re-exported for compatibility; the implementation is Elysia-free (selfExec.ts). */
export { daemonSelfArgv, compiledEntry } from "./selfExec.ts"

/** Output seam (structurally matches `src/cli.ts`'s `CliIo`). */
export interface DaemonIo {
  out(s: string): void
  err(s: string): void
}

/** Result of `runDaemon`: the process exit code. */
export type DaemonRunResult = number

const USAGE = `usage: sensus daemon <command>

  serve        run the daemon in the foreground (dev/tests)
  start        start the daemon in the background (detached)
  stop         stop the running daemon
  restart      stop then start the daemon
  status       show the pid and a health probe
  logs         render the daemon's structured log (daemon-log.jsonl)
  install      install the persistent user service (systemd/launchd; --dry-run)
  uninstall    remove the persistent user service (--dry-run)

sensus daemon logs [flags]

  --json           raw NDJSON, one JSON record per line (default when piped)
  --pretty         colored human-readable lines (default on a TTY)
  --level <lvl>    minimum level: trace|debug|info|warn|error
  --component <s>  exact component match, or a trailing-* prefix (e.g. daemon*)
  --follow, -f     keep printing appended records until Ctrl+C

Color precedence (pretty mode): --pretty > --json > NO_COLOR > FORCE_COLOR >
  TERM=dumb > stdout-is-a-TTY. If both --json and --pretty are given, the last
  one wins. Filters (--level/--component) apply to both pretty and raw output.`

/**
 * Lazily-bound daemon logger (resolves `getLogger()` per emit, so the boot
 * `configureLogger` inside startDaemon takes effect; see ./log.ts).
 */
const log = componentLogger("daemon")

/** Wait between readiness polls during `start`. */
const POLL_MS = 100
/** How long `start` waits for the health endpoint. */
const START_TIMEOUT_MS = 8000
/** How long `stop` waits for a clean SIGTERM before escalating. */
const STOP_TIMEOUT_MS = 5000
/** Poll interval for `logs --follow` on the pretty/filtered path. */
const FOLLOW_POLL_MS = 200

// ---- minimal HTTP over a Unix socket ----------------------------------------

export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: string
}

interface RawRequest {
  unix: string
  method?: string
  path: string
  token?: string
  body?: string
  timeoutMs?: number
}

/** Decode a chunked body; null while it is incomplete. */
function decodeChunked(raw: string): string | null {
  let out = ""
  let i = 0
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", i)
    if (lineEnd < 0) return null
    const size = Number.parseInt(raw.slice(i, lineEnd).split(";")[0] ?? "", 16)
    if (!Number.isFinite(size)) return null
    if (size === 0) return out
    const start = lineEnd + 2
    const end = start + size
    if (raw.length < end + 2) return null
    out += raw.slice(start, end)
    i = end + 2
  }
}

/**
 * A minimal HTTP/1.1 request over a Unix socket (docs/daemon-api.md) — the
 * daemon's own probe path, with no `curl`/`fetch` dependency. Resolves on
 * connection close (the request sends `Connection: close`); rejects on a
 * connect error or timeout.
 */
export function requestOverUnix(req: RawRequest): Promise<HttpResult> {
  const timeoutMs = req.timeoutMs ?? 2000
  const method = req.method ?? "GET"
  const body = req.body ?? ""
  const head = [`${method} ${req.path} HTTP/1.1`, "Host: localhost", "Connection: close"]
  if (req.token !== undefined) head.push(`Authorization: Bearer ${req.token}`)
  if (body.length > 0) {
    head.push(`Content-Length: ${Buffer.byteLength(body)}`)
    head.push("Content-Type: application/json")
  }
  const payload = `${head.join("\r\n")}\r\n\r\n${body}`

  return new Promise<HttpResult>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result?: HttpResult, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(result ?? { status: 0, headers: {}, body: "" })
    }
    const parse = (): HttpResult | null => {
      const text = Buffer.concat(chunks).toString("utf8")
      const split = text.indexOf("\r\n\r\n")
      if (split < 0) return null
      const head = text.slice(0, split).split("\r\n")
      const status = Number(head[0]?.split(" ")[1] ?? 0)
      const headers: Record<string, string> = {}
      for (const line of head.slice(1)) {
        const colon = line.indexOf(":")
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const rawBody = text.slice(split + 4)
      if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
        const decoded = decodeChunked(rawBody)
        return decoded === null ? null : { status, headers, body: decoded }
      }
      const length = Number(headers["content-length"] ?? "0")
      // Compare/slice in BYTES, not JS string length: a multi-byte body (e.g.
      // an em-dash in a version string) would otherwise mis-parse and hang.
      const bodyBytes = Buffer.from(text.slice(split + 4), "utf8")
      if (bodyBytes.length < length) return null
      return { status, headers, body: bodyBytes.subarray(0, length).toString("utf8") }
    }

    const timer = setTimeout(() => finish(undefined, new Error("timeout")), timeoutMs)
    Bun.connect({
      unix: req.unix,
      socket: {
        open(socket) {
          socket.write(payload)
        },
        data(_socket, data) {
          chunks.push(Buffer.from(data))
          const parsed = parse()
          if (parsed !== null) finish(parsed)
        },
        close() {
          finish(parse() ?? undefined)
        },
        end() {
          finish(parse() ?? undefined)
        },
        error(_socket, error) {
          finish(undefined, error)
        },
        connectError(_socket, error) {
          finish(undefined, error)
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))))
  })
}

// ---- process helpers --------------------------------------------------------

/** Best-effort one-line text for an unknown rejection reason (never throws). */
function rejectionText(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`
  if (typeof reason === "string") return reason
  try {
    const json = JSON.stringify(reason)
    return json === undefined ? String(reason) : json
  } catch {
    return String(reason)
  }
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

/** `/v1/health` over the socket; null when unreachable/not ready. */
async function health(dir: string): Promise<HttpResult | null> {
  const token = readToken(daemonTokenPath(dir))
  if (token === null) return null
  try {
    return await requestOverUnix({ unix: daemonSocketPath(dir), path: "/v1/health", token, timeoutMs: 1500 })
  } catch {
    return null
  }
}

/** The TCP bind the daemon reports at `/v1/info` (null when unreachable). */
async function daemonTcp(dir: string): Promise<{ host: string; port: number } | null> {
  const token = readToken(daemonTokenPath(dir))
  if (token === null) return null
  try {
    const res = await requestOverUnix({ unix: daemonSocketPath(dir), path: "/v1/info", token, timeoutMs: 1500 })
    if (res === null || res.status !== 200) return null
    const tcp = (JSON.parse(res.body) as { tcp?: { host?: unknown; port?: unknown } }).tcp
    if (tcp === undefined || typeof tcp.port !== "number") return null
    return { host: typeof tcp.host === "string" ? tcp.host : "127.0.0.1", port: tcp.port }
  } catch {
    return null
  }
}

/**
 * The base argv to re-exec the daemon with (no subcommand). In a compiled
 * binary `process.execPath` IS the binary and `Bun.main` is a virtual
 * `/$bunfs/...` path, so only `execPath` is used; in dev `execPath` is `bun` and
 * `Bun.main` is the entry file. `compiled` is normally
 * `import.meta.url.includes("$bunfs")`.
 *
 * The implementation now lives in the Elysia-free `selfExec.ts` so the client
 * can reuse it; it is re-exported from here for compatibility.
 */

// ---- commands ---------------------------------------------------------------

/**
 * Why a previous daemon's state is not a healthy running daemon (recorded as
 * the `previous` restart reason on `daemon started`; docs/logging.md).
 * `"running"` means a live pid answered `/v1/health` — serve must refuse to
 * steal it.
 */
export type PriorDaemonState = "clean" | "stale-pid" | "stale-socket" | "unresponsive" | "running"

/**
 * Classify the prior daemon state from the boot checks (docs/logging.md):
 * a dead pidfile is `"stale-pid"`, a live pid that fails health is
 * `"unresponsive"`, a leftover socket with no pidfile is `"stale-socket"`,
 * nothing at all is `"clean"`. Pure so the classification is unit-testable.
 */
export function classifyPriorDaemon(facts: {
  pidPresent: boolean
  pidAlive: boolean
  healthy: boolean
  socketPresent: boolean
}): PriorDaemonState {
  if (facts.pidPresent && facts.pidAlive) return facts.healthy ? "running" : "unresponsive"
  if (facts.pidPresent) return "stale-pid"
  return facts.socketPresent ? "stale-socket" : "clean"
}

/** `sensus daemon serve` — foreground listeners that stay alive until a signal. */
async function serveForeground(io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  const dir = sensusRuntimeDirFrom(env)
  const pidPath = daemonPidPath(dir)
  const socketPath = daemonSocketPath(dir)

  // Refuse to steal a live daemon's socket: startDaemon unlinks a stale socket,
  // so a second `serve` on a healthy daemon would clobber it. The same checks
  // classify WHY the previous daemon is gone for the `daemon started` record.
  const existing = readPidFile(pidPath)
  const existingAlive = existing !== null && isAlive(existing)
  let healthy = false
  if (existingAlive) {
    const probe = await health(dir)
    healthy = probe !== null && probe.status === 200
    if (healthy) {
      io.err(`sensus daemon: already running (pid ${existing}) — use \`sensus daemon stop\``)
      return 1
    }
  }
  const previous = classifyPriorDaemon({
    pidPresent: existing !== null,
    pidAlive: existingAlive,
    healthy,
    socketPresent: existsSync(socketPath),
  })

  // Shutdown is reachable from a signal AND from the idle policy (D9): the
  // lifetime controller calls `onIdleExit` when the grace window expires. The
  // reason rides `stop()`'s `daemon stopping` record (docs/logging.md).
  let stopping = false
  let stopListeners: ((reason?: string) => void) | null = null
  const shutdown = (code: number, reason: string): void => {
    if (stopping) return
    stopping = true
    try {
      stopListeners?.(reason)
    } catch {
      // idempotent
    }
    try {
      rmSync(pidPath, { force: true })
    } catch {
      // best-effort
    }
    process.exit(code)
  }
  process.on("SIGINT", () => shutdown(0, "signal:SIGINT"))
  process.on("SIGTERM", () => shutdown(0, "signal:SIGTERM"))
  process.on("SIGHUP", () => shutdown(0, "signal:SIGHUP"))

  // Crash containment. `serve` runs headless before src/index.tsx registers its
  // own process handlers, so without these Bun's fatal default kills the daemon
  // (and every pane socket) on the first escaped rejection. A rejection has no
  // owner to retry it and locked decision #6 requires the shells/turns to
  // survive, so log it and STAY ALIVE. An uncaught exception is unrecoverable:
  // log the stack, flush the log, then reuse the signal shutdown (stop
  // listeners, drop the pidfile, exit 1) so no PTY child is left running.
  process.on("unhandledRejection", (reason: unknown) => {
    log.error("unhandled rejection — daemon stays alive", { err: reason, reason: rejectionText(reason) })
  })
  process.on("uncaughtException", (err: unknown) => {
    try {
      log.error("uncaught exception — shutting down", { err })
    } catch {
      // logging must never mask the crash
    }
    try {
      flushLoggerSync()
    } catch {
      // best-effort
    }
    // `crash` names the stop; stop() emits `daemon stopping` and then flushes
    // the structured log again, so the crash + stopping records both land.
    shutdown(1, "crash")
  })

  const res = await startDaemon({
    runtimeDir: dir,
    home: sensusHomeFrom(env),
    // The idle policy's stop reason is `"idle"` (serve.ts names it itself);
    // this callback only removes the pidfile and exits.
    onIdleExit: () => shutdown(0, "idle"),
    // Why the previous daemon is gone, from the boot checks above.
    previous,
    // SENSUS_MODELS_DEV_WARM=0 opts out (tests/reproducible boots).
    warmCatalog: env["SENSUS_MODELS_DEV_WARM"] !== "0",
  })
  if (!res.ok) {
    io.err(`sensus daemon: ${res.error}`)
    return 1
  }
  stopListeners = res.stop
  const pidWrite = writePidFile(pidPath, process.pid)
  if (!pidWrite.ok) {
    io.err(`sensus daemon: ${pidWrite.error ?? "cannot write pidfile"}`)
  }

  io.out(`sensus daemon: listening on ${res.unix}`)
  io.out(`sensus daemon: token      ${daemonTokenPath(dir)}`)
  io.out(`sensus daemon: pid        ${process.pid}`)
  io.out(`sensus daemon: tcp        ${res.tcp.host}:${res.tcp.port}`)
  io.out(`sensus daemon: docs       http://${displayHost(res.tcp.host)}:${res.tcp.port}${DOCS_PATH}`)
  if (!["127.0.0.1", "::1", "localhost"].includes(res.tcp.host)) {
    io.err(
      `sensus daemon: warning: bound to ${res.tcp.host} — the REST/WS API is reachable beyond loopback (still bearer-gated) and the docs are unauthenticated`,
    )
  }

  await new Promise<never>(() => {})
  return 0 // unreachable
}

/** `sensus daemon start` — spawn a detached `serve` and wait for health. */
async function startDetached(io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  const dir = sensusRuntimeDirFrom(env)
  const pidPath = daemonPidPath(dir)
  const logPath = daemonLogPath(dir)

  const existing = readPidFile(pidPath)
  if (existing !== null && isAlive(existing)) {
    const probe = await health(dir)
    if (probe !== null && probe.status === 200) {
      io.out(`sensus daemon: already running (pid ${existing})`)
      return 0
    }
  }

  const ready = ensureRuntimeDir(dir)
  if (!ready.ok) {
    io.err(`sensus daemon: ${ready.error ?? `cannot create runtime dir ${dir}`}`)
    return 1
  }

  let child: ReturnType<typeof Bun.spawn>
  const fd = openSync(logPath, "a", 0o600)
  try {
    const base = daemonSelfArgv(process.execPath, Bun.main, compiledEntry())
    child = Bun.spawn([...base, "daemon", "serve"], {
      detached: true, // setsid on POSIX: outlives the launching shell
      stdio: ["ignore", fd, fd],
    })
    child.unref()
  } catch (e) {
    io.err(`sensus daemon: could not start: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }

  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null) {
      io.err(`sensus daemon: exited on startup (code ${child.exitCode}) — see ${logPath}`)
      return 1
    }
    const probe = await health(dir)
    if (probe !== null && probe.status === 200) {
      const pid = readPidFile(pidPath)
      io.out(`sensus daemon: started${pid !== null ? ` (pid ${pid})` : ""}`)
      io.out(`sensus daemon: socket  ${daemonSocketPath(dir)}`)
      io.out(`sensus daemon: log     ${logPath}`)
      return 0
    }
    if (Date.now() >= deadline) {
      io.err(`sensus daemon: timed out waiting for /v1/health — see ${logPath}`)
      return 1
    }
    await Bun.sleep(POLL_MS)
  }
}

/** `sensus daemon stop` — SIGTERM the pidfile pid and confirm the socket is gone. */
async function stopDaemon(io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  const dir = sensusRuntimeDirFrom(env)
  const pidPath = daemonPidPath(dir)
  const socketPath = daemonSocketPath(dir)
  const pid = readPidFile(pidPath)

  if (pid === null || !isAlive(pid)) {
    try {
      rmSync(pidPath, { force: true })
      rmSync(socketPath, { force: true })
    } catch {
      // best-effort
    }
    io.out("sensus daemon: not running")
    return 0
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (e) {
    io.err(`sensus daemon: could not signal pid ${pid}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline && isAlive(pid)) await Bun.sleep(POLL_MS)
  if (isAlive(pid)) {
    // A wedged process must not be left behind (D9/orphan rule).
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // it may have exited between the check and the kill
    }
    await Bun.sleep(200)
  }

  try {
    rmSync(pidPath, { force: true })
  } catch {
    // best-effort
  }
  for (let i = 0; i < 20 && existsSync(socketPath); i++) await Bun.sleep(POLL_MS)
  try {
    rmSync(socketPath, { force: true })
  } catch {
    // best-effort
  }
  io.out(`sensus daemon: stopped (pid ${pid})`)
  return 0
}

/** `sensus daemon restart` — stop (idempotent) then start, reporting clearly. */
async function restartDaemon(io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  io.out("sensus daemon: restarting…")
  const stopped = await stopDaemon(io, env)
  if (stopped !== 0) return stopped
  return await startDetached(io, env)
}

/** `sensus daemon status` — pid + health; exit 0 only when healthy. */
async function statusDaemon(io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  const dir = sensusRuntimeDirFrom(env)
  const pid = readPidFile(daemonPidPath(dir))
  if (pid === null || !isAlive(pid)) {
    io.out("sensus daemon: not running")
    return 1
  }
  const probe = await health(dir)
  if (probe === null || probe.status !== 200) {
    io.err(`sensus daemon: pid ${pid} is alive but /v1/health is not answering`)
    return 1
  }
  let version = "?"
  try {
    version = (JSON.parse(probe.body) as { version?: string }).version ?? "?"
  } catch {
    // non-JSON body — leave version unknown
  }
  io.out(`sensus daemon: running (pid ${pid}, version ${version})`)
  io.out(`sensus daemon: socket  ${daemonSocketPath(dir)}`)
  const tcp = await daemonTcp(dir)
  if (tcp !== null) io.out(`sensus daemon: docs    http://${displayHost(tcp.host)}:${tcp.port}${DOCS_PATH}`)
  return 0
}

// ---- `sensus daemon logs` (structured log reader) ----------------------------

/** Parsed `sensus daemon logs` options. */
interface LogsOptions {
  follow: boolean
  /** Explicit output mode; undefined ⇒ auto-detect from TTY/color env. */
  format: "pretty" | "json" | null
  /** Minimum level filter (undefined ⇒ no filter). */
  level: LogLevel | null
  /** Component filter: exact match, or a trailing-`*` prefix match. */
  component: string | null
}

/**
 * Parse `logs` flags. Unknown flags are ignored (the caller still renders the
 * log); a malformed `--level` is reported via the returned `error`.
 */
function parseLogsOptions(args: readonly string[]): { opts: LogsOptions; error: string | null } {
  const opts: LogsOptions = { follow: false, format: null, level: null, component: null }
  let error: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === "--follow" || arg === "-f") {
      opts.follow = true
    } else if (arg === "--json") {
      // Last flag wins when both --json and --pretty are present.
      opts.format = "json"
    } else if (arg === "--pretty") {
      opts.format = "pretty"
    } else if (arg === "--level") {
      const value = (args[++i] ?? "").trim().toLowerCase()
      if (LOG_LEVELS.includes(value as LogLevel)) opts.level = value as LogLevel
      else error = `invalid --level ${JSON.stringify(args[i] ?? "")} (want trace|debug|info|warn|error)`
    } else if (arg.startsWith("--level=")) {
      const value = arg.slice("--level=".length).trim().toLowerCase()
      if (LOG_LEVELS.includes(value as LogLevel)) opts.level = value as LogLevel
      else error = `invalid --level ${JSON.stringify(arg.slice("--level=".length))} (want trace|debug|info|warn|error)`
    } else if (arg === "--component") {
      const value = (args[++i] ?? "").trim()
      if (value.length > 0) opts.component = value
    } else if (arg.startsWith("--component=")) {
      const value = arg.slice("--component=".length).trim()
      if (value.length > 0) opts.component = value
    }
    // Unknown flags are ignored on purpose (forward-compatible).
  }
  return { opts, error }
}

/** Truncate a stack to its first non-empty line. */
function firstStackLine(stack: string): string {
  for (const line of stack.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ""
}

/** `HH:MM:SS.mmm` local time for a record's `ts` (mirrors core/log.ts). */
function logTimestamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Standard per-level ANSI colors; must match `core/log.ts` (which is frozen). */
const LOGS_LEVEL_COLOR: Readonly<Record<LogLevel, string>> = {
  trace: "\x1b[90m",
  debug: "\x1b[90m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
}
const LOGS_ANSI_RESET = "\x1b[0m"
const LOGS_ANSI_DIM = "\x1b[90m"

/**
 * Resolve pretty-vs-raw for `logs`, mirroring `core/log.ts`'s precedence
 * (explicit flag > NO_COLOR > FORCE_COLOR > TERM=dumb > isTTY). This module
 * cannot import core/log.ts's private `detectColors`, so it reimplements the
 * tiny decision; keep the two in step.
 */
function logsColors(explicit: boolean | undefined, env: NodeJS.ProcessEnv, stdoutTTY: boolean): boolean {
  if (explicit !== undefined) return explicit
  const noColor = env["NO_COLOR"]
  if (noColor !== undefined && noColor.length > 0) return false
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "") return true
  if (env["TERM"] === "dumb") return false
  return stdoutTTY
}

/** True when every filter in `opts` accepts this record. */
function logsRecordPasses(rec: LogRecord, opts: LogsOptions): boolean {
  if (opts.level !== null && LOG_LEVELS.indexOf(rec.level) < LOG_LEVELS.indexOf(opts.level)) return false
  if (opts.component !== null) {
    const component = rec.component ?? ""
    if (opts.component.endsWith("*")) {
      if (!component.startsWith(opts.component.slice(0, -1))) return false
    } else if (component !== opts.component) {
      return false
    }
  }
  return true
}

/** Render one record as a colored/plain single line (corrId/session/err included). */
function renderLogLine(rec: LogRecord, color: boolean): string {
  const time = logTimestamp(rec.ts)
  const level = rec.level.toUpperCase()
  const parts: string[] = []
  if (rec.component !== undefined) parts.push(rec.component)
  parts.push(rec.msg)
  if (rec.attributes !== undefined && Object.keys(rec.attributes).length > 0) {
    try {
      parts.push(JSON.stringify(rec.attributes))
    } catch {
      parts.push("{}")
    }
  }
  if (rec.err?.message) {
    parts.push(rec.err.message)
    const stackLine = rec.err.stack ? firstStackLine(rec.err.stack) : ""
    if (stackLine.length > 0) parts.push(stackLine)
  }
  const body = parts.join("  ")
  const dims: string[] = []
  if (rec.corrId !== undefined && rec.corrId.length > 0) dims.push(`[${rec.corrId}]`)
  if (rec.session !== undefined && rec.session.length > 0) dims.push(`session=${rec.session}`)
  const suffix = dims.length > 0 ? ` ${dims.join(" ")}` : ""
  if (!color) return `${time}  ${level.padEnd(5)}  ${body}${suffix}`
  const c = LOGS_LEVEL_COLOR[rec.level] ?? ""
  const dimSuffix = suffix.length > 0 ? `${LOGS_ANSI_DIM}${suffix}${LOGS_ANSI_RESET}` : ""
  return `${LOGS_ANSI_DIM}${time}${LOGS_ANSI_RESET}  ${c}${level.padEnd(5)}${LOGS_ANSI_RESET}  ${body}${dimSuffix}`
}

/** Render one parsed line for the chosen mode; `null` when it is skipped. */
function renderRecord(line: string, opts: LogsOptions, pretty: boolean, color: boolean): string | null {
  const rec = parseLogLine(line)
  if (rec === null) return null
  if (!logsRecordPasses(rec, opts)) return null
  if (!pretty) return line.trimEnd()
  return renderLogLine(rec, color)
}

/** The byte offset of the end of the last COMPLETE line at or before `size`. */
function completePrefixLength(text: string): number {
  const lastNewline = text.lastIndexOf("\n")
  return lastNewline < 0 ? 0 : lastNewline + 1
}

/** Sleep `ms`, resolving to false on abort. */
function sleepUntil(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * `--follow` polling tail (used for the pretty/filtered path; `tail -f` is only
 * valid for unfiltered raw passthrough — see `logsDaemon`). Polls the file's
 * byte size every `FOLLOW_POLL_MS`, reads the appended slice, and renders only
 * complete lines. Never throws; returns on SIGINT (or an unreadable file).
 */
async function followStructuredLog(
  path: string,
  opts: LogsOptions,
  pretty: boolean,
  color: boolean,
  io: DaemonIo,
): Promise<DaemonRunResult> {
  const controller = new AbortController()
  const signal = controller.signal
  const onSigint = (): void => controller.abort()
  try {
    process.on("SIGINT", onSigint)
  } catch {
    // no signal support (unlikely) — polling still runs until the file vanishes
  }
  try {
    let offset = 0
    let carry = ""
    try {
      const text = readFileSync(path, "utf8")
      const consumed = completePrefixLength(text)
      offset = Buffer.byteLength(text.slice(0, consumed), "utf8")
      carry = text.slice(consumed)
    } catch {
      return 0 // the file vanished between existence check and read
    }
    while (!signal.aborted) {
      if (!(await sleepUntil(signal, FOLLOW_POLL_MS))) break
      let text: string
      try {
        const size = statSync(path).size
        if (size <= offset) continue
        const chunk = readFileSync(path, { encoding: "utf8" })
        // Re-read from the byte offset (the file is append-only in practice);
        // a rewrite that shrinks the file resets to the start.
        if (size < offset) {
          offset = 0
          carry = ""
        }
        const slice = Buffer.from(chunk, "utf8").subarray(offset).toString("utf8")
        offset = size
        text = carry + slice
      } catch {
        // rotate/rename/unlink: keep polling without throwing
        continue
      }
      const consumed = completePrefixLength(text)
      carry = text.slice(consumed)
      for (const line of text.slice(0, consumed).split("\n")) {
        const rendered = renderRecord(line, opts, pretty, color)
        if (rendered !== null) io.out(rendered)
      }
    }
  } finally {
    try {
      process.removeListener("SIGINT", onSigint)
    } catch {
      // ignore
    }
  }
  return 0
}

/**
 * `sensus daemon logs [flags]` — render the daemon's STRUCTURED log
 * (`daemon-log.jsonl`), distinct from the raw `daemon.log` banner. Pretty on a
 * TTY, raw NDJSON when piped; `--level`/`--component` filter both modes. See the
 * USAGE block for flags and the color precedence.
 */
async function logsDaemon(args: readonly string[], io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  const dir = sensusRuntimeDirFrom(env)
  const logPath = daemonLogJsonlPath(dir)
  const bannerPath = daemonLogPath(dir)
  const { opts, error } = parseLogsOptions(args)
  if (error !== null) {
    io.err(`sensus daemon logs: ${error}`)
    return 1
  }

  if (!existsSync(logPath)) {
    io.out(`(no daemon log yet — ${logPath})`)
    if (existsSync(bannerPath)) {
      io.out(
        `daemon.log exists but holds the raw stdio banner, not the structured log — see ${bannerPath}`,
      )
    }
    return 0
  }

  // Format and color are decided separately: `--json`/`--pretty` force the
  // FORMAT; within pretty, ANSI follows the core/log.ts precedence (only an
  // explicit `--json`, i.e. "no color", overrides it). So `--pretty` + NO_COLOR
  // still renders readable pretty lines without ANSI.
  const autoColor = logsColors(undefined, env, process.stdout.isTTY === true)
  const pretty = opts.format === "pretty" ? true : opts.format === "json" ? false : autoColor
  const color = opts.format === "json" ? false : autoColor

  // Unfiltered raw passthrough can lean on `tail -f`; anything pretty or
  // filtered takes the polling tail (tail cannot render or filter records).
  const rawPassthrough = !pretty && opts.level === null && opts.component === null
  if (opts.follow && rawPassthrough) {
    const tail = Bun.spawn(["tail", "-f", logPath], { stdin: "ignore", stdout: "inherit", stderr: "inherit" })
    return await tail.exited
  }

  if (opts.follow) return await followStructuredLog(logPath, opts, pretty, color, io)

  let text: string
  try {
    text = readFileSync(logPath, "utf8")
  } catch (e) {
    io.err(`sensus daemon: cannot read ${logPath}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  const lines: string[] = []
  for (const line of text.split("\n")) {
    const rendered = renderRecord(line, opts, pretty, color)
    if (rendered !== null) lines.push(rendered)
  }
  if (lines.length > 0) io.out(lines.join("\n"))
  return 0
}

/**
 * Dispatch `sensus daemon <cmd>`. Returns the exit code. `env` is `process.env`
 * in production and a fake env in tests (spawned children inherit the real one).
 */
export async function runDaemon(argv: readonly string[], io: DaemonIo, env: NodeJS.ProcessEnv): Promise<DaemonRunResult> {
  const sub = argv[0] ?? ""
  switch (sub) {
    case "serve":
      return await serveForeground(io, env)
    case "start":
      return await startDetached(io, env)
    case "stop":
      return await stopDaemon(io, env)
    case "restart":
      return await restartDaemon(io, env)
    case "status":
      return await statusDaemon(io, env)
    case "logs":
      return await logsDaemon(argv.slice(1), io, env)
    case "install":
      return await installService({ io, env, argv: argv.slice(1) })
    case "uninstall":
      return await uninstallService({ io, env, argv: argv.slice(1) })
    default:
      io.err(USAGE)
      return 1
  }
}
