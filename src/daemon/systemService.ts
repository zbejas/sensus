/**
 * Root-owned persistent service (Linux systemd). This is the `--root` path:
 * `/etc/systemd/system/sensus.service`, `User=root`, `/root/.config/sensus`,
 * and `/run/sensus` for the socket/token. It starts with `multi-user.target`
 * and never needs `loginctl enable-linger`.
 *
 * macOS system-wide launchd is deliberately not implemented yet: `--root`
 * errors there instead of writing `/Library/LaunchDaemons`.
 *
 * The unit path and command runner are injectable so tests never touch
 * `/etc/systemd/system` or invoke the real `systemctl`.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errorMessage } from "../core/util.ts"
import { SYSTEM_RUNTIME_DIR } from "./paths.ts"
import { compiledEntry, daemonSelfArgv } from "./selfExec.ts"
import { realRunner, type CommandRunner, type ServiceIo } from "./service.ts"

/** The system unit name (a different manager from the user unit). */
export const SYSTEM_UNIT_NAME = "sensus.service"
/** The system manager's unit directory. */
export const SYSTEM_UNIT_DIR = "/etc/systemd/system"
/** The root service's config home. */
export const SYSTEM_CONFIG_HOME = join("/root", ".config", "sensus")

/** The normalized inputs the root unit renderer consumes. */
export interface SystemServiceSpec {
  /** Absolute ExecStart argv, already ending with `daemon serve`. */
  argv: readonly string[]
  runtimeDir: string
  home: string
}

/** Quote one token for a systemd command line (`%` is a specifier). */
function systemdArg(token: string): string {
  const escaped = token.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")
  return `"${escaped}"`
}

/** Render `/etc/systemd/system/sensus.service`. */
export function renderSystemdSystemUnit(spec: SystemServiceSpec): string {
  const env = [
    "SENSUS_DAEMON_PERSISTENT=1",
    `SENSUS_RUNTIME_DIR=${spec.runtimeDir}`,
    `SENSUS_HOME=${spec.home}`,
  ].map((value) => `Environment=${systemdArg(value)}`)
  return (
    [
      "[Unit]",
      "Description=Sensus daemon (system)",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=root",
      ...env,
      // RuntimeDirectory creates /run/sensus for the service, removes it on
      // stop, and leaves the socket/token inaccessible to unprivileged users.
      "RuntimeDirectory=sensus",
      "RuntimeDirectoryMode=0700",
      `ExecStart=${spec.argv.map(systemdArg).join(" ")}`,
      "Restart=on-failure",
      "RestartSec=2",
      "StandardOutput=journal",
      "StandardError=journal",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n")
  )
}

// ---- install / uninstall ----------------------------------------------------

export interface SystemServiceOptions {
  io: ServiceIo
  env: NodeJS.ProcessEnv
  /** Flags after `install`/`uninstall` (`--dry-run`). */
  argv?: readonly string[]
  /** Override the platform (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Override the unit directory (tests). */
  unitDir?: string
  /** Override the command runner (tests). */
  runner?: CommandRunner
  /** Override the installing uid (tests); only 0 is accepted. */
  uid?: number
  /** Override the self-exec base argv (tests). */
  selfArgv?: readonly string[]
  /** Override `/run/sensus` (tests). */
  runtimeDir?: string
  /** Override the root service config home (tests). */
  home?: string
  /** Start the unit after enabling it (default true). */
  startNow?: boolean
}

interface SystemServiceContext {
  unitPath: string
  spec: SystemServiceSpec
  runner: CommandRunner
  dryRun: boolean
  startNow: boolean
}

type SystemServiceContextResult = ({ ok: true } & SystemServiceContext) | { ok: false; error: string }

/** The root unit path for a unit-dir override. */
export function systemServicePath(unitDir: string = SYSTEM_UNIT_DIR): string {
  return join(unitDir, SYSTEM_UNIT_NAME)
}

/** True when the root unit file exists. */
export function systemServiceInstalled(unitDir: string = SYSTEM_UNIT_DIR): boolean {
  return existsSync(systemServicePath(unitDir))
}

function resolveSystemServiceContext(opts: SystemServiceOptions): SystemServiceContextResult {
  const platform = opts.platform ?? process.platform
  if (platform !== "linux") {
    return { ok: false, error: `a system service is only supported on Linux (systemd), not ${platform}` }
  }
  const uid = opts.uid ?? process.getuid?.() ?? -1
  if (uid !== 0) {
    return { ok: false, error: "the system service must be installed as root (run it with sudo or from a root shell)" }
  }
  const home = opts.home ?? join(homedir(), ".config", "sensus")
  const runtimeDir = opts.runtimeDir ?? SYSTEM_RUNTIME_DIR
  const selfArgv = opts.selfArgv ?? daemonSelfArgv(process.execPath, Bun.main, compiledEntry())
  return {
    ok: true,
    unitPath: systemServicePath(opts.unitDir ?? SYSTEM_UNIT_DIR),
    spec: {
      argv: [...selfArgv, "daemon", "serve"],
      runtimeDir,
      home,
    },
    runner: opts.runner ?? realRunner,
    dryRun: (opts.argv ?? []).includes("--dry-run"),
    startNow: opts.startNow ?? true,
  }
}

interface SystemCommand {
  argv: string[]
  optional?: boolean
}

function enableCommands(startNow: boolean): SystemCommand[] {
  return [
    { argv: ["systemctl", "daemon-reload"] },
    { argv: ["systemctl", "enable", ...(startNow ? ["--now"] : []), SYSTEM_UNIT_NAME] },
    { argv: ["systemctl", "is-enabled", SYSTEM_UNIT_NAME] },
  ]
}

function disableCommands(): SystemCommand[] {
  return [{ argv: ["systemctl", "disable", "--now", SYSTEM_UNIT_NAME] }]
}

async function runCommands(io: ServiceIo, runner: CommandRunner, commands: readonly SystemCommand[]): Promise<boolean> {
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
 * `sensus daemon install --root`: write the root system unit and load/enable
 * it. Idempotent; `--dry-run` prints the unit without touching the filesystem.
 */
export async function installSystemService(opts: SystemServiceOptions): Promise<number> {
  const ctx = resolveSystemServiceContext(opts)
  if (!ctx.ok) {
    opts.io.err(`sensus daemon install: ${ctx.error}`)
    return 1
  }
  const content = renderSystemdSystemUnit(ctx.spec)
  if (ctx.dryRun) {
    opts.io.out(`# systemd system unit (dry run — not written): ${ctx.unitPath}`)
    opts.io.out(content.replace(/\n$/, ""))
    opts.io.out(
      ctx.startNow
        ? `# would run: systemctl daemon-reload && systemctl enable --now ${SYSTEM_UNIT_NAME}`
        : `# would run: systemctl daemon-reload && systemctl enable ${SYSTEM_UNIT_NAME}`,
    )
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
  if (!(await runCommands(opts.io, ctx.runner, enableCommands(ctx.startNow)))) return 1
  opts.io.out(`sensus daemon: installed systemd system service → ${ctx.unitPath}`)
  opts.io.out(`sensus daemon: runs as root; config ${ctx.spec.home}; runtime ${ctx.spec.runtimeDir}`)
  if (ctx.startNow) {
    const active = await ctx.runner.run(["systemctl", "is-active", SYSTEM_UNIT_NAME])
    if (!active.ok) {
      const state = active.stdout.trim() || active.stderr.trim() || "not active"
      opts.io.err(`sensus daemon: warning: the unit is enabled but not running (${state}); see journalctl -u ${SYSTEM_UNIT_NAME}`)
    }
  }
  return 0
}

/** `sensus daemon uninstall --root`: stop/disable and remove the root unit. */
export async function uninstallSystemService(opts: SystemServiceOptions): Promise<number> {
  const ctx = resolveSystemServiceContext(opts)
  if (!ctx.ok) {
    opts.io.err(`sensus daemon uninstall: ${ctx.error}`)
    return 1
  }
  if (ctx.dryRun) {
    opts.io.out(`# would remove ${ctx.unitPath}`)
    for (const cmd of [...disableCommands(), { argv: ["systemctl", "daemon-reload"] }]) {
      opts.io.out(`# would run: ${cmd.argv.join(" ")}`)
    }
    return 0
  }
  if (!existsSync(ctx.unitPath)) {
    opts.io.out(`sensus daemon: system service not installed (no ${ctx.unitPath})`)
    return 0
  }
  if (!(await runCommands(opts.io, ctx.runner, disableCommands()))) return 1
  try {
    rmSync(ctx.unitPath, { force: true })
  } catch (e) {
    opts.io.err(`sensus daemon uninstall: cannot remove ${ctx.unitPath}: ${errorMessage(e)}`)
    return 1
  }
  if (!(await runCommands(opts.io, ctx.runner, [{ argv: ["systemctl", "daemon-reload"] }]))) return 1
  opts.io.out(`sensus daemon: uninstalled system service (removed ${ctx.unitPath})`)
  return 0
}
