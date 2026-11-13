/**
 * Persistent-service installation (P6; docs/operations.md "Daemon",
 * docs/triggers.md). `sensus daemon install` writes a **user** unit and wires
 * the service manager to load/enable it; `uninstall` unloads and removes it.
 *
 *   Linux  — a systemd **user** unit: `~/.config/systemd/user/sensus.service`
 *            (`systemctl --user daemon-reload` + `enable --now`).
 *   macOS  — a launchd **user** agent:
 *            `~/Library/LaunchAgents/com.sensus.daemon.plist`
 *            (`launchctl load -w` / `unload -w`).
 *
 * Never root, never a system-wide path: both live under the user's `$HOME`.
 * The unit runs `sensus daemon serve` in **persistent** mode
 * (`SENSUS_DAEMON_PERSISTENT=1`, D3/D9) with the same self-exec argv the
 * on-demand path uses (`daemonSelfArgv`, so the compiled binary and dev agree),
 * restarts on failure (`Restart=on-failure` / `KeepAlive`), and points at the
 * daemon log. That banner lives in the persistent state dir, not the runtime
 * dir: systemd/launchd open the file before the daemon runs, and the runtime
 * dir is tmpfs, so it does not exist after a reboot.
 *
 * Both the unit path and the command runner are injectable, so tests never
 * touch the real `$HOME` and never invoke `systemctl`/`launchctl`.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { sensusRuntimeDirFrom } from "../engine/index.ts"
import { errorMessage } from "../core/util.ts"
import { daemonServiceLogPath } from "./paths.ts"
import { compiledEntry, daemonSelfArgv } from "./selfExec.ts"

/** The service manager a platform uses for a user-scoped unit. */
export type ServiceUnitKind = "systemd" | "launchd"

/** systemd user unit name. */
export const SYSTEMD_UNIT_NAME = "sensus.service"
/** launchd user-agent label. */
export const LAUNCHD_LABEL = "com.sensus.daemon"
/** launchd agent plist filename. */
export const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`

/** The service manager for `platform`, or null when unsupported. */
export function serviceUnitKind(platform: NodeJS.Platform): ServiceUnitKind | null {
  if (platform === "linux") return "systemd"
  if (platform === "darwin") return "launchd"
  return null
}

/** The unit's filename for `kind`. */
export function serviceUnitFileName(kind: ServiceUnitKind): string {
  return kind === "systemd" ? SYSTEMD_UNIT_NAME : LAUNCHD_PLIST_NAME
}

/** The user-scoped unit directory (never system-wide). */
export function serviceUnitDir(kind: ServiceUnitKind, home: string): string {
  return kind === "systemd" ? join(home, ".config", "systemd", "user") : join(home, "Library", "LaunchAgents")
}

/** The absolute user-unit path for `kind`/`home`. */
export function serviceUnitPath(kind: ServiceUnitKind, home: string): string {
  return join(serviceUnitDir(kind, home), serviceUnitFileName(kind))
}

/** The normalized inputs both unit renderers consume. */
export interface ServiceUnitSpec {
  /** Absolute exec argv — already ends with `daemon serve`. */
  argv: readonly string[]
  /** Environment variables set for the service. */
  env: Record<string, string>
  /** Absolute log file path. */
  logPath: string
  /** systemd unit name / launchd label. */
  label: string
  /** systemd `Description=`. */
  description?: string
}

/** Quote one token for a systemd command line (`%` is a specifier). */
function systemdArg(token: string): string {
  const escaped = token.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")
  return `"${escaped}"`
}

/** Render a systemd **user** service unit (docs/operations.md "Daemon"). */
export function renderSystemdUnit(spec: ServiceUnitSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${systemdArg(`${k}=${v}`)}`)
    .join("\n")
  // `%` is a systemd specifier in every value, not just argv/env.
  const logPath = spec.logPath.replaceAll("%", "%%")
  return (
    [
      "[Unit]",
      `Description=${spec.description ?? "Sensus daemon (persistent)"}`,
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${spec.argv.map(systemdArg).join(" ")}`,
      ...(env.length > 0 ? [env] : []),
      "Restart=on-failure",
      "RestartSec=2",
      `StandardOutput=append:${logPath}`,
      `StandardError=append:${logPath}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n")
  )
}

/** XML-escape a string for a plist `<string>`. */
function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/** Render a launchd **user** agent plist (docs/operations.md "Daemon"). */
export function renderLaunchdPlist(spec: ServiceUnitSpec): string {
  const args = spec.argv.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n")
  const env = Object.entries(spec.env)
    .map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>`)
    .join("\n")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xmlEscape(spec.label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    env,
    "\t</dict>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xmlEscape(spec.logPath)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xmlEscape(spec.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

/** Render the platform's unit content. */
export function renderServiceUnit(kind: ServiceUnitKind, spec: ServiceUnitSpec): string {
  return kind === "systemd" ? renderSystemdUnit(spec) : renderLaunchdPlist(spec)
}

// ---- command runner (injectable; the real one shells out) -------------------

export interface CommandResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/** The service-manager command seam; tests inject a recorder. */
export interface CommandRunner {
  run(argv: readonly string[]): Promise<CommandResult>
}

/** The real runner: spawn the command and capture stdout/stderr/exit code. */
export const realRunner: CommandRunner = {
  async run(argv: readonly string[]): Promise<CommandResult> {
    try {
      const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { ok: code === 0, code, stdout, stderr }
    } catch (e) {
      return { ok: false, code: -1, stdout: "", stderr: errorMessage(e) }
    }
  },
}

// ---- lingering (systemd user services) --------------------------------------

/** The account a user service belongs to (`$USER`, else the passwd entry). */
export function serviceUserName(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env["USER"] ?? env["LOGNAME"]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  try {
    return userInfo().username
  } catch {
    return "unknown"
  }
}

/** The installing account's uid, or null when the platform has no `getuid`. */
function serviceUid(): number | null {
  try {
    return typeof process.getuid === "function" ? process.getuid() : null
  } catch {
    return null
  }
}

export interface LingerStatus {
  /** False off Linux/systemd; every other field is then informational. */
  applicable: boolean
  /** `true`/`false` from `loginctl`; null when it cannot be determined. */
  enabled: boolean | null
  user: string
  /** The exact command that keeps the user service alive after logout. */
  enableCommand: string | null
  detail: string | null
}

/**
 * Read `Linger` for the service account. A systemd **user** service is stopped
 * at logout unless lingering is enabled, which is the most common reason a
 * paired host reconnects only while the user is logged in (docs/auth.md).
 */
export async function checkUserLinger(opts: {
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runner?: CommandRunner
  user?: string
}): Promise<LingerStatus> {
  const platform = opts.platform ?? process.platform
  const user = serviceUserName(opts.env, opts.user)
  if (platform !== "linux") {
    return { applicable: false, enabled: null, user, enableCommand: null, detail: `not systemd (${platform})` }
  }
  const runner = opts.runner ?? realRunner
  const command = ["loginctl", "show-user", user, "-p", "Linger"]
  const res = await runner.run(command)
  const enableCommand = `loginctl enable-linger ${user}`
  if (!res.ok) {
    return {
      applicable: true,
      enabled: null,
      user,
      enableCommand,
      detail: res.stderr.trim() || res.stdout.trim() || `\`${command.join(" ")}\` failed`,
    }
  }
  const match = /(?:^|\n)Linger=(yes|no)\b/u.exec(res.stdout)
  if (match === null) {
    return { applicable: true, enabled: null, user, enableCommand, detail: "loginctl returned no Linger value" }
  }
  return { applicable: true, enabled: match[1] === "yes", user, enableCommand, detail: null }
}

/** The result of a best-effort `loginctl enable-linger`. */
export interface LingerEnableResult {
  ok: boolean
  /** stderr/stdout from the failed command, for a warning. */
  detail: string | null
}

/**
 * Enable lingering for the service account (Linux/systemd). Callers treat this
 * as best-effort: `loginctl enable-linger` can require polkit/root authorization,
 * so a refusal should warn and let the service install continue.
 */
export async function enableUserLinger(opts: {
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runner?: CommandRunner
  user?: string
}): Promise<LingerEnableResult> {
  const platform = opts.platform ?? process.platform
  if (platform !== "linux") return { ok: true, detail: null }
  const user = serviceUserName(opts.env, opts.user)
  const res = await (opts.runner ?? realRunner).run(["loginctl", "enable-linger", user])
  if (res.ok) return { ok: true, detail: null }
  return { ok: false, detail: res.stderr.trim() || res.stdout.trim() || `exit ${res.code}` }
}

// ---- install / uninstall ----------------------------------------------------

export interface ServiceIo {
  out(s: string): void
  err(s: string): void
}

export interface ServiceCommandOptions {
  io: ServiceIo
  /** Process env (resolves `$HOME` and the runtime dir). */
  env: NodeJS.ProcessEnv
  /** Flags after the subcommand (`--dry-run`). */
  argv?: readonly string[]
  /** Override the platform (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Override `$HOME` (tests). */
  home?: string
  /** Override the unit directory (tests) — bypasses the platform default. */
  unitDir?: string
  /** Override the self-exec base argv (tests). */
  selfArgv?: readonly string[]
  /** Override the log file path (tests). */
  logPath?: string
  /** Override the runtime dir baked into the unit (tests). */
  runtimeDir?: string
  /** Pin `SENSUS_HOME` in the unit (pairing with a non-default config home). */
  sensusHome?: string
  /** Override the service account used for the lingering check (tests). */
  user?: string
  /** Override the installing account's uid (tests); 0 means root. */
  uid?: number
  /** Override the command runner (tests) — the real one runs systemctl/launchctl. */
  runner?: CommandRunner
  /**
   * Start the unit after enabling it (default true). A reconciliation pass that
   * runs while a daemon is already alive sets this false, so it writes/enables
   * the unit without starting a second daemon.
   */
  startNow?: boolean
}

interface ServiceContext {
  kind: ServiceUnitKind
  unitPath: string
  spec: ServiceUnitSpec
  runner: CommandRunner
  dryRun: boolean
  /** Run `loginctl enable-linger` instead of only reporting it. */
  linger: boolean
  /** Start the unit after enabling it; false only enables it for next boot/login. */
  startNow: boolean
  user: string
  /** Installing account's uid; 0 is root. */
  uid: number | null
}

type ServiceContextResult = ({ ok: true } & ServiceContext) | { ok: false; error: string }

/** Resolve the platform/paths/argv/runner; never throws. */
function resolveServiceContext(opts: ServiceCommandOptions): ServiceContextResult {
  const platform = opts.platform ?? process.platform
  const kind = serviceUnitKind(platform)
  if (kind === null) return { ok: false, error: `a user service is not supported on ${platform}` }
  const home = opts.home ?? opts.env["HOME"] ?? homedir()
  const unitPath = opts.unitDir !== undefined ? join(opts.unitDir, serviceUnitFileName(kind)) : serviceUnitPath(kind, home)
  const runtimeDir = opts.runtimeDir ?? sensusRuntimeDirFrom(opts.env)
  const serviceEnv: Record<string, string> = {
    SENSUS_DAEMON_PERSISTENT: "1",
    SENSUS_RUNTIME_DIR: runtimeDir,
    ...(opts.sensusHome !== undefined && opts.sensusHome.length > 0 ? { SENSUS_HOME: opts.sensusHome } : {}),
  }
  // The banner lives in the state dir (see daemonServiceLogPath). Resolve it
  // against the unit's env, so a pinned SENSUS_HOME matches `sensus daemon logs`.
  const logPath = opts.logPath ?? daemonServiceLogPath({ ...opts.env, ...serviceEnv })
  const selfArgv = opts.selfArgv ?? daemonSelfArgv(process.execPath, Bun.main, compiledEntry())
  return {
    ok: true,
    kind,
    unitPath,
    spec: {
      argv: [...selfArgv, "daemon", "serve"],
      // Pin the runtime dir so the socket/pid/log the service uses match what an
      // interactive `sensus daemon status|logs` resolves from the same env.
      env: serviceEnv,
      logPath,
      label: kind === "systemd" ? SYSTEMD_UNIT_NAME : LAUNCHD_LABEL,
    },
    runner: opts.runner ?? realRunner,
    dryRun: (opts.argv ?? []).includes("--dry-run"),
    linger: (opts.argv ?? []).includes("--linger"),
    startNow: opts.startNow ?? true,
    user: serviceUserName(opts.env, opts.user),
    uid: opts.uid ?? serviceUid(),
  }
}

/** A service-manager command; `optional` failures are tolerated (best-effort). */
interface ServiceCommand {
  argv: string[]
  optional?: boolean
}

/** The commands that load/enable the unit, in order. */
function enableCommands(kind: ServiceUnitKind, unitPath: string, startNow: boolean): ServiceCommand[] {
  if (kind === "systemd") {
    return [
      { argv: ["systemctl", "--user", "daemon-reload"] },
      {
        argv: ["systemctl", "--user", "enable", ...(startNow ? ["--now"] : []), SYSTEMD_UNIT_NAME],
      },
      // `enable --now` can print success while the start job is only queued;
      // verify the symlink is really in place so a boot without the service
      // fails the install instead of looking healthy until reboot.
      { argv: ["systemctl", "--user", "is-enabled", SYSTEMD_UNIT_NAME] },
    ]
  }
  // A repeat install must not fail on an already-loaded agent: unload
  // best-effort (a not-loaded job errors), then load fresh. When the caller
  // already has a daemon alive, writing the plist is enough: a LaunchAgent is
  // loaded at the next login, and loading it now would start a second daemon.
  if (!startNow) return []
  return [
    { argv: ["launchctl", "unload", "-w", unitPath], optional: true },
    { argv: ["launchctl", "load", "-w", unitPath] },
  ]
}

/** The commands that unload/disable the unit, in order (before removal). */
function disableCommands(kind: ServiceUnitKind, unitPath: string): ServiceCommand[] {
  return kind === "systemd"
    ? [{ argv: ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME] }]
    : [{ argv: ["launchctl", "unload", "-w", unitPath], optional: true }]
}

/** The commands that refresh the manager after a unit file change. */
function reloadCommands(kind: ServiceUnitKind): ServiceCommand[] {
  return kind === "systemd" ? [{ argv: ["systemctl", "--user", "daemon-reload"] }] : []
}

async function runCommands(io: ServiceIo, runner: CommandRunner, commands: readonly ServiceCommand[]): Promise<boolean> {
  for (const cmd of commands) {
    const res = await runner.run(cmd.argv)
    if (!res.ok) {
      if (cmd.optional === true) continue
      const detail = res.stderr.trim() || res.stdout.trim()
      io.err(`sensus daemon: \`${cmd.argv.join(" ")}\` failed${detail.length > 0 ? ` — ${detail}` : ""}`)
      return false
    }
  }
  return true
}

/**
 * `sensus daemon install [--dry-run]`: write the user unit and load/enable it.
 * Idempotent; `--dry-run` prints the unit without touching the filesystem.
 */
export async function installService(opts: ServiceCommandOptions): Promise<number> {
  const ctx = resolveServiceContext(opts)
  if (!ctx.ok) {
    opts.io.err(`sensus daemon install: ${ctx.error}`)
    return 1
  }
  const content = renderServiceUnit(ctx.kind, ctx.spec)
  if (ctx.dryRun) {
    opts.io.out(`# ${ctx.kind} unit (dry run — not written): ${ctx.unitPath}`)
    opts.io.out(content.replace(/\n$/, ""))
    if (ctx.kind === "systemd") {
      opts.io.out(
        ctx.linger
          ? `# would run: loginctl enable-linger ${ctx.user}`
          : `# lingering: check with \`loginctl show-user ${ctx.user} -p Linger\` (add --linger to enable)`,
      )
    }
    return 0
  }
  try {
    // The service manager opens StandardOutput before ExecStart, and the
    // runtime dir is tmpfs (gone after a reboot). The banner therefore lives in
    // the persistent state dir, whose parent must exist at boot.
    mkdirSync(dirname(ctx.spec.logPath), { recursive: true, mode: 0o700 })
    chmodSync(dirname(ctx.spec.logPath), 0o700)
  } catch (e) {
    opts.io.err(`sensus daemon install: cannot create log directory ${dirname(ctx.spec.logPath)}: ${errorMessage(e)}`)
    return 1
  }
  try {
    mkdirSync(dirname(ctx.unitPath), { recursive: true })
    writeFileSync(ctx.unitPath, content, { encoding: "utf8", mode: 0o644 })
    chmodSync(ctx.unitPath, 0o644)
  } catch (e) {
    opts.io.err(`sensus daemon install: cannot write ${ctx.unitPath}: ${errorMessage(e)}`)
    return 1
  }
  if (!(await runCommands(opts.io, ctx.runner, enableCommands(ctx.kind, ctx.unitPath, ctx.startNow)))) return 1
  opts.io.out(`sensus daemon: installed ${ctx.kind === "systemd" ? "systemd user unit" : "launchd user agent"} → ${ctx.unitPath}`)
  opts.io.out(`sensus daemon: persistent mode (SENSUS_DAEMON_PERSISTENT=1); log ${ctx.spec.logPath}`)
  let lingerEnabled: boolean | null = null
  if (ctx.kind === "systemd") {
    if (ctx.linger) {
      const linger = await ctx.runner.run(["loginctl", "enable-linger", ctx.user])
      if (!linger.ok) {
        const detail = linger.stderr.trim() || linger.stdout.trim()
        opts.io.err(
          `sensus daemon: \`loginctl enable-linger ${ctx.user}\` failed${detail.length > 0 ? ` — ${detail}` : ""}`,
        )
        return 1
      }
      lingerEnabled = true
      opts.io.out(`sensus daemon: lingering enabled for ${ctx.user}`)
    } else {
      const status = await checkUserLinger({
        env: opts.env,
        platform: opts.platform,
        runner: ctx.runner,
        user: ctx.user,
      })
      lingerEnabled = status.enabled
      if (status.enabled === false) {
        opts.io.err("sensus daemon: warning: a systemd user service stops at logout unless lingering is enabled.")
        opts.io.err(`sensus daemon: run \`${status.enableCommand}\` (or \`sensus daemon install --linger\`) to keep it running.`)
        opts.io.err("sensus daemon: on a headless server, use lingering or manage a system unit yourself; install never writes a system-wide unit.")
      } else if (status.enabled === true) {
        opts.io.out(`sensus daemon: lingering is enabled for ${ctx.user}`)
      }
      // Unknown (no loginctl, containers): stay quiet; the service still works
      // for the current login session.
    }
    if (ctx.uid === 0 && lingerEnabled !== true) {
      opts.io.err("sensus daemon: warning: root's user service does not start at boot without lingering.")
      opts.io.err(`sensus daemon: run \`sensus daemon install --linger\` (or \`loginctl enable-linger ${ctx.user}\`) so root does not need to log in.`)
    }
    // Enabled is not the same as running: `enable --now` can finish its start
    // job and the process can still exit before the next `daemon status`.
    // A reconciliation install (`startNow: false`) deliberately does not start
    // a second daemon, so this check would always warn there.
    if (ctx.startNow) {
      const active = await ctx.runner.run(["systemctl", "--user", "is-active", SYSTEMD_UNIT_NAME])
      if (!active.ok) {
        const state = active.stdout.trim() || active.stderr.trim() || "not active"
        opts.io.err(`sensus daemon: warning: the unit is enabled but not running (${state}); see ${ctx.spec.logPath}`)
      }
    }
  }
  if (ctx.kind === "systemd" && lingerEnabled === false) {
    opts.io.out(`sensus daemon: the service starts when ${ctx.user} logs in; enable lingering to start it at boot`)
  } else if (ctx.kind === "systemd" && lingerEnabled === true) {
    opts.io.out("sensus daemon: the service starts at boot (lingering is enabled) — check it with `sensus daemon status`")
  } else {
    opts.io.out("sensus daemon: the service starts at login — check it with `sensus daemon status`")
  }
  return 0
}

/**
 * `sensus daemon uninstall [--dry-run]`: unload/disable the unit, remove its
 * file, and reload the manager. Idempotent when not installed; `--dry-run`
 * prints the planned actions without touching the filesystem or the manager.
 */
export async function uninstallService(opts: ServiceCommandOptions): Promise<number> {
  const ctx = resolveServiceContext(opts)
  if (!ctx.ok) {
    opts.io.err(`sensus daemon uninstall: ${ctx.error}`)
    return 1
  }
  const installed = existsSync(ctx.unitPath)
  if (ctx.dryRun) {
    opts.io.out(`# would remove ${ctx.unitPath}`)
    for (const cmd of [...disableCommands(ctx.kind, ctx.unitPath), ...reloadCommands(ctx.kind)]) {
      opts.io.out(`# would run: ${cmd.argv.join(" ")}`)
    }
    return 0
  }
  if (!installed) {
    opts.io.out(`sensus daemon: not installed (no ${ctx.unitPath})`)
    return 0
  }
  if (!(await runCommands(opts.io, ctx.runner, disableCommands(ctx.kind, ctx.unitPath)))) return 1
  try {
    rmSync(ctx.unitPath, { force: true })
  } catch (e) {
    opts.io.err(`sensus daemon uninstall: cannot remove ${ctx.unitPath}: ${errorMessage(e)}`)
    return 1
  }
  if (!(await runCommands(opts.io, ctx.runner, reloadCommands(ctx.kind)))) return 1
  opts.io.out(`sensus daemon: uninstalled (removed ${ctx.unitPath})`)
  return 0
}
