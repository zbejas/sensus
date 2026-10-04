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
 * daemon log.
 *
 * Both the unit path and the command runner are injectable, so tests never
 * touch the real `$HOME` and never invoke `systemctl`/`launchctl`.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { sensusRuntimeDirFrom } from "../engine/index.ts"
import { errorMessage } from "../core/util.ts"
import { daemonLogPath } from "./paths.ts"
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
      `StandardOutput=append:${spec.logPath}`,
      `StandardError=append:${spec.logPath}`,
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
  /** Override the command runner (tests) — the real one runs systemctl/launchctl. */
  runner?: CommandRunner
}

interface ServiceContext {
  kind: ServiceUnitKind
  unitPath: string
  spec: ServiceUnitSpec
  runner: CommandRunner
  dryRun: boolean
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
  const logPath = opts.logPath ?? daemonLogPath(runtimeDir)
  const selfArgv = opts.selfArgv ?? daemonSelfArgv(process.execPath, Bun.main, compiledEntry())
  return {
    ok: true,
    kind,
    unitPath,
    spec: {
      argv: [...selfArgv, "daemon", "serve"],
      // Pin the runtime dir so the socket/pid/log the service uses match what an
      // interactive `sensus daemon status|logs` resolves from the same env.
      env: { SENSUS_DAEMON_PERSISTENT: "1", SENSUS_RUNTIME_DIR: runtimeDir },
      logPath,
      label: kind === "systemd" ? SYSTEMD_UNIT_NAME : LAUNCHD_LABEL,
    },
    runner: opts.runner ?? realRunner,
    dryRun: (opts.argv ?? []).includes("--dry-run"),
  }
}

/** A service-manager command; `optional` failures are tolerated (best-effort). */
interface ServiceCommand {
  argv: string[]
  optional?: boolean
}

/** The commands that load/enable the unit, in order. */
function enableCommands(kind: ServiceUnitKind, unitPath: string): ServiceCommand[] {
  return kind === "systemd"
    ? [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        { argv: ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME] },
      ]
    : [
        // A repeat install must not fail on an already-loaded agent: unload
        // best-effort (a not-loaded job errors), then load fresh.
        { argv: ["launchctl", "unload", "-w", unitPath], optional: true },
        { argv: ["launchctl", "load", "-w", unitPath] },
      ]
}

/** The commands that unload/disable the unit, in order (before removal). */
function disableCommands(kind: ServiceUnitKind, unitPath: string): ServiceCommand[] {
  return kind === "systemd"
    ? [{ argv: ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME] }]
    : [{ argv: ["launchctl", "unload", "-w", unitPath] }]
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
    return 0
  }
  try {
    mkdirSync(dirname(ctx.unitPath), { recursive: true })
    writeFileSync(ctx.unitPath, content, { encoding: "utf8", mode: 0o644 })
    chmodSync(ctx.unitPath, 0o644)
  } catch (e) {
    opts.io.err(`sensus daemon install: cannot write ${ctx.unitPath}: ${errorMessage(e)}`)
    return 1
  }
  if (!(await runCommands(opts.io, ctx.runner, enableCommands(ctx.kind, ctx.unitPath)))) return 1
  opts.io.out(`sensus daemon: installed ${ctx.kind === "systemd" ? "systemd user unit" : "launchd user agent"} → ${ctx.unitPath}`)
  opts.io.out(`sensus daemon: persistent mode (SENSUS_DAEMON_PERSISTENT=1); log ${ctx.spec.logPath}`)
  opts.io.out("sensus daemon: the service starts on login — check it with `sensus daemon status`")
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
