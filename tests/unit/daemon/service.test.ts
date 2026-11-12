/**
 * Persistent-service units (P6; docs/operations.md "Daemon"). Pure unit-string
 * generation for systemd (Linux) and launchd (macOS), plus install/uninstall
 * through an INJECTED command runner and a temp unit dir — no real `$HOME`,
 * no real `systemctl`/`launchctl`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import {
  LAUNCHD_LABEL,
  LAUNCHD_PLIST_NAME,
  SYSTEMD_UNIT_NAME,
  daemonServiceLogPath,
  installService,
  renderLaunchdPlist,
  renderServiceUnit,
  renderSystemdUnit,
  serviceUnitDir,
  serviceUnitFileName,
  serviceUnitKind,
  serviceUnitPath,
  uninstallService,
  type CommandResult,
  type CommandRunner,
  type ServiceIo,
  type ServiceUnitSpec,
} from "../../../src/daemon/index.ts"

function captureIo(): { out: string[]; err: string[]; io: ServiceIo } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

interface Recorder extends CommandRunner {
  calls: string[][]
  failAt: number
}

/** A fake runner: records argv, succeeds unless `failAt` names the call index. */
function recorder(failAt = -1): Recorder {
  const calls: string[][] = []
  return {
    calls,
    failAt,
    async run(argv: readonly string[]): Promise<CommandResult> {
      calls.push([...argv])
      const index = calls.length - 1
      if (index === failAt) return { ok: false, code: 1, stdout: "", stderr: "boom" }
      return { ok: true, code: 0, stdout: "", stderr: "" }
    },
  }
}

const SPEC: ServiceUnitSpec = {
  argv: ["/opt/sensus/bin/sensus", "daemon", "serve"],
  env: { SENSUS_DAEMON_PERSISTENT: "1", SENSUS_RUNTIME_DIR: "/run/user/1000/sensus-1000" },
  logPath: "/run/user/1000/sensus-1000/daemon.log",
  label: SYSTEMD_UNIT_NAME,
}

function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "sensus-service-"))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe("service units: paths", () => {
  test("kind/path are user-scoped and platform-specific", () => {
    expect(serviceUnitKind("linux")).toBe("systemd")
    expect(serviceUnitKind("darwin")).toBe("launchd")
    expect(serviceUnitKind("win32")).toBeNull()

    expect(serviceUnitFileName("systemd")).toBe(SYSTEMD_UNIT_NAME)
    expect(serviceUnitFileName("launchd")).toBe(LAUNCHD_PLIST_NAME)
    expect(serviceUnitDir("systemd", "/home/u")).toBe("/home/u/.config/systemd/user")
    expect(serviceUnitDir("launchd", "/Users/u")).toBe("/Users/u/Library/LaunchAgents")
    expect(serviceUnitPath("systemd", "/home/u")).toBe(`/home/u/.config/systemd/user/${SYSTEMD_UNIT_NAME}`)
    expect(serviceUnitPath("launchd", "/Users/u")).toBe(`/Users/u/Library/LaunchAgents/${LAUNCHD_PLIST_NAME}`)
  })
})

describe("service units: rendering", () => {
  test("systemd unit: argv, persistent env, restart and log wiring", () => {
    const unit = renderSystemdUnit(SPEC)
    expect(unit).toContain("[Unit]")
    expect(unit).toContain("[Service]")
    expect(unit).toContain("[Install]")
    expect(unit).toContain('ExecStart="/opt/sensus/bin/sensus" "daemon" "serve"')
    expect(unit).toContain('Environment="SENSUS_DAEMON_PERSISTENT=1"')
    expect(unit).toContain('Environment="SENSUS_RUNTIME_DIR=/run/user/1000/sensus-1000"')
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("StandardOutput=append:/run/user/1000/sensus-1000/daemon.log")
    expect(unit).toContain("StandardError=append:/run/user/1000/sensus-1000/daemon.log")
    expect(unit).toContain("WantedBy=default.target")
    // Never a system-wide unit.
    expect(unit).not.toContain("/etc/systemd")
  })

  test("systemd escapes quote/backslash/percent so a path with spaces cannot split the line", () => {
    const unit = renderSystemdUnit({
      ...SPEC,
      argv: ['/home/a b/sensus', "daemon", "serve"],
      logPath: "/home/a b/daemon%20.log",
      env: { SENSUS_RUNTIME_DIR: "/run/user/100%0/sensus" },
    })
    expect(unit).toContain('ExecStart="/home/a b/sensus" "daemon" "serve"')
    expect(unit).toContain('Environment="SENSUS_RUNTIME_DIR=/run/user/100%%0/sensus"')
    expect(unit).toContain("StandardOutput=append:/home/a b/daemon%%20.log")
  })

  test("launchd plist: label, argv, env, KeepAlive and the log path", () => {
    const plist = renderLaunchdPlist({ ...SPEC, label: LAUNCHD_LABEL })
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(plist).toContain(`<key>Label</key>\n\t<string>${LAUNCHD_LABEL}</string>`)
    expect(plist).toContain("<key>ProgramArguments</key>")
    expect(plist).toContain("<string>/opt/sensus/bin/sensus</string>")
    expect(plist).toContain("<key>EnvironmentVariables</key>")
    expect(plist).toContain("<key>SENSUS_DAEMON_PERSISTENT</key>")
    expect(plist).toContain("<key>RunAtLoad</key>")
    expect(plist).toContain("<key>KeepAlive</key>")
    expect(plist).toContain("<true/>")
    expect(plist).toContain("<key>StandardOutPath</key>")
    expect(plist).toContain("<string>/run/user/1000/sensus-1000/daemon.log</string>")
  })

  test("launchd escapes XML metacharacters in argv/paths", () => {
    const plist = renderLaunchdPlist({
      ...SPEC,
      argv: ['/home/a&b/<sensus>', "daemon", "serve"],
      logPath: '/tmp/a"b.log',
    })
    expect(plist).toContain("<string>/home/a&amp;b/&lt;sensus&gt;</string>")
    expect(plist).toContain('<string>/tmp/a&quot;b.log</string>')
  })

  test("renderServiceUnit dispatches by kind", () => {
    expect(renderServiceUnit("systemd", SPEC)).toContain("ExecStart=")
    expect(renderServiceUnit("launchd", { ...SPEC, label: LAUNCHD_LABEL })).toContain("<plist")
  })
})

/** A runner that answers the lingering query with `Linger=yes|no`. */
function lingerRunner(value: "yes" | "no"): Recorder {
  const calls: string[][] = []
  return {
    calls,
    failAt: -1,
    async run(argv: readonly string[]): Promise<CommandResult> {
      calls.push([...argv])
      if (argv[0] === "loginctl" && argv[1] === "show-user") {
        return { ok: true, code: 0, stdout: `Linger=${value}\n`, stderr: "" }
      }
      return { ok: true, code: 0, stdout: "", stderr: "" }
    },
  }
}

describe("sensus daemon install / uninstall", () => {
  test("install writes the systemd unit and runs daemon-reload + enable --now", async () => {
    const { home, cleanup } = tempHome()
    try {
      const unitDir = join(home, "units")
      const logPath = join(home, "state", "logs", "daemon.log")
      const runner = recorder()
      const { out, err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "tester" },
        platform: "linux",
        unitDir,
        selfArgv: ["/opt/sensus"],
        runtimeDir: "/run/user/42/sensus-42",
        logPath,
        uid: 1000,
        runner,
      })
      expect(code).toBe(0)
      expect(err).toEqual([])
      const file = join(unitDir, SYSTEMD_UNIT_NAME)
      const unit = readFileSync(file, "utf8")
      expect(unit).toContain('ExecStart="/opt/sensus" "daemon" "serve"')
      expect(unit).toContain('Environment="SENSUS_DAEMON_PERSISTENT=1"')
      expect(unit).toContain(`StandardOutput=append:${logPath}`)
      expect(existsSync(join(home, "state", "logs"))).toBe(true)
      expect(runner.calls).toEqual([
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME],
        ["systemctl", "--user", "is-enabled", SYSTEMD_UNIT_NAME],
        ["loginctl", "show-user", "tester", "-p", "Linger"],
        ["systemctl", "--user", "is-active", SYSTEMD_UNIT_NAME],
      ])
      expect(out.join("\n")).toContain("installed")
    } finally {
      cleanup()
    }
  })

  test("the service banner defaults to the persistent state dir and its parent is created", async () => {
    const { home, cleanup } = tempHome()
    try {
      const unitDir = join(home, "units")
      const expected = daemonServiceLogPath({ HOME: home, USER: "tester" })
      const { io } = captureIo()
      expect(
        await installService({
          io,
          env: { HOME: home, USER: "tester" },
          platform: "linux",
          unitDir,
          selfArgv: ["/opt/sensus"],
          uid: 1000,
          runner: recorder(),
        }),
      ).toBe(0)
      expect(expected).toBe(join(home, ".local", "state", "sensus", "logs", "daemon.log"))
      expect(existsSync(dirname(expected))).toBe(true)
      const unit = readFileSync(join(unitDir, SYSTEMD_UNIT_NAME), "utf8")
      expect(unit).toContain(`StandardOutput=append:${expected}`)
    } finally {
      cleanup()
    }
  })

  test("a pinned SENSUS_HOME is used for the service banner too", async () => {
    const { home, cleanup } = tempHome()
    try {
      const pinned = join(home, "pinned-home")
      const unitDir = join(home, "units")
      const { io } = captureIo()
      expect(
        await installService({
          io,
          env: { HOME: home, USER: "tester" },
          platform: "linux",
          unitDir,
          selfArgv: ["/opt/sensus"],
          sensusHome: pinned,
          uid: 1000,
          runner: recorder(),
        }),
      ).toBe(0)
      const unit = readFileSync(join(unitDir, SYSTEMD_UNIT_NAME), "utf8")
      expect(unit).toContain(`StandardOutput=append:${join(pinned, "logs", "daemon.log")}`)
      expect(existsSync(join(pinned, "logs"))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("install --dry-run prints the unit and writes nothing", async () => {
    const { home, cleanup } = tempHome()
    try {
      const unitDir = join(home, "units")
      const runner = recorder()
      const { out, err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "tester" },
        platform: "linux",
        unitDir,
        selfArgv: ["/opt/sensus"],
        runner,
        uid: 1000,
        argv: ["--dry-run"],
      })
      expect(code).toBe(0)
      expect(err).toEqual([])
      expect(existsSync(join(unitDir, SYSTEMD_UNIT_NAME))).toBe(false)
      expect(runner.calls).toEqual([])
      const text = out.join("\n")
      expect(text).toContain("dry run")
      expect(text).toContain('ExecStart="/opt/sensus" "daemon" "serve"')
    } finally {
      cleanup()
    }
  })

  test("install warns when systemd lingering is disabled", async () => {
    const { home, cleanup } = tempHome()
    try {
      const runner = lingerRunner("no")
      const { err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "tester" },
        platform: "linux",
        unitDir: join(home, "units"),
        selfArgv: ["/opt/sensus"],
        runner,
        uid: 1000,
      })
      expect(code).toBe(0)
      expect(err.join("\n")).toContain("stops at logout")
      expect(err.join("\n")).toContain("loginctl enable-linger tester")
    } finally {
      cleanup()
    }
  })

  test("install --linger enables lingering for the service account", async () => {
    const { home, cleanup } = tempHome()
    try {
      const runner = recorder()
      const { out, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "tester" },
        platform: "linux",
        unitDir: join(home, "units"),
        selfArgv: ["/opt/sensus"],
        runner,
        uid: 1000,
        argv: ["--linger"],
      })
      expect(code).toBe(0)
      expect(runner.calls).toContainEqual(["loginctl", "enable-linger", "tester"])
      expect(out.join("\n")).toContain("lingering enabled for tester")
      expect(out.join("\n")).toContain("starts at boot")
    } finally {
      cleanup()
    }
  })

  test("install on macOS writes the launchd plist and (re)loads it; a missing prior load is tolerated", async () => {
    const { home, cleanup } = tempHome()
    try {
      const unitDir = join(home, "agents")
      const runner = recorder()
      const { io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home },
        platform: "darwin",
        unitDir,
        selfArgv: ["/Applications/sensus"],
        uid: 1000,
        runner,
      })
      expect(code).toBe(0)
      const file = join(unitDir, LAUNCHD_PLIST_NAME)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, "utf8")).toContain(`<string>${LAUNCHD_LABEL}</string>`)
      expect(runner.calls).toEqual([
        ["launchctl", "unload", "-w", file],
        ["launchctl", "load", "-w", file],
      ])

      // Idempotency: the best-effort unload failing (not loaded) must not fail install.
      const second = recorder(0)
      const { io: io2 } = captureIo()
      expect(
        await installService({ io: io2, env: { HOME: home }, platform: "darwin", unitDir, selfArgv: ["/Applications/sensus"], uid: 1000, runner: second }),
      ).toBe(0)
      expect(second.calls).toEqual([
        ["launchctl", "unload", "-w", file],
        ["launchctl", "load", "-w", file],
      ])
    } finally {
      cleanup()
    }
  })

  test("a real command failure is non-zero and reported", async () => {
    const { home, cleanup } = tempHome()
    try {
      const runner = recorder(1) // the enable call fails
      const { err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home },
        platform: "linux",
        unitDir: join(home, "units"),
        selfArgv: ["/opt/sensus"],
        uid: 1000,
        runner,
      })
      expect(code).toBe(1)
      expect(err.join("\n")).toContain("boom")
    } finally {
      cleanup()
    }
  })

  test("install fails when the unit was written but is not enabled", async () => {
    const { home, cleanup } = tempHome()
    try {
      // daemon-reload (0), enable --now (1), is-enabled (2) — the last fails
      // when `systemctl is-enabled` reports disabled.
      const runner = recorder(2)
      const { err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "tester" },
        platform: "linux",
        unitDir: join(home, "units"),
        selfArgv: ["/opt/sensus"],
        uid: 1000,
        runner,
      })
      expect(code).toBe(1)
      expect(err.join("\n")).toContain("is-enabled")
    } finally {
      cleanup()
    }
  })

  test("install warns when a root user service has no lingering", async () => {
    const { home, cleanup } = tempHome()
    try {
      // The default recorder returns no Linger value, so the state is unknown.
      const runner = recorder()
      const { err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "root" },
        platform: "linux",
        unitDir: join(home, "units"),
        selfArgv: ["/opt/sensus"],
        uid: 0,
        runner,
      })
      expect(code).toBe(0)
      expect(err.join("\n")).toContain("root's user service does not start at boot")
      expect(err.join("\n")).toContain("loginctl enable-linger root")
    } finally {
      cleanup()
    }
  })

  test("install warns when the enabled unit is not running", async () => {
    const { home, cleanup } = tempHome()
    try {
      const runner: CommandRunner = {
        async run(argv: readonly string[]): Promise<CommandResult> {
          if (argv[0] === "loginctl" && argv[1] === "show-user") {
            return { ok: true, code: 0, stdout: "Linger=yes\n", stderr: "" }
          }
          if (argv[0] === "systemctl" && argv[2] === "is-active") {
            return { ok: false, code: 3, stdout: "failed\n", stderr: "" }
          }
          return { ok: true, code: 0, stdout: "", stderr: "" }
        },
      }
      const { err, io } = captureIo()
      const code = await installService({
        io,
        env: { HOME: home, USER: "tester" },
        platform: "linux",
        unitDir: join(home, "units"),
        selfArgv: ["/opt/sensus"],
        uid: 1000,
        runner,
      })
      expect(code).toBe(0)
      expect(err.join("\n")).toContain("enabled but not running")
      expect(err.join("\n")).toContain("failed")
    } finally {
      cleanup()
    }
  })

  test("an unsupported platform is a clear non-zero error", async () => {
    const { home, cleanup } = tempHome()
    try {
      const { err, io } = captureIo()
      const code = await installService({ io, env: { HOME: home }, platform: "win32" })
      expect(code).toBe(1)
      expect(err.join("\n")).toContain("not supported")
    } finally {
      cleanup()
    }
  })

  test("uninstall unloads, removes the unit, reloads, and is idempotent", async () => {
    const { home, cleanup } = tempHome()
    try {
      const unitDir = join(home, "units")
      const file = join(unitDir, SYSTEMD_UNIT_NAME)
      const installRunner = recorder()
      await installService({
        io: captureIo().io,
        env: { HOME: home },
        platform: "linux",
        unitDir,
        selfArgv: ["/opt/sensus"],
        uid: 1000,
        runner: installRunner,
      })
      expect(existsSync(file)).toBe(true)

      const runner = recorder()
      const { out, err, io } = captureIo()
      expect(await uninstallService({ io, env: { HOME: home }, platform: "linux", unitDir, runner })).toBe(0)
      expect(err).toEqual([])
      expect(existsSync(file)).toBe(false)
      expect(runner.calls).toEqual([
        ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME],
        ["systemctl", "--user", "daemon-reload"],
      ])
      expect(out.join("\n")).toContain("uninstalled")

      // Idempotent: a second uninstall reports not-installed and runs nothing.
      const again = recorder()
      const { out: out2, io: io2 } = captureIo()
      expect(await uninstallService({ io: io2, env: { HOME: home }, platform: "linux", unitDir, runner: again })).toBe(0)
      expect(again.calls).toEqual([])
      expect(out2.join("\n")).toContain("not installed")
    } finally {
      cleanup()
    }
  })

  test("uninstall --dry-run reports the plan without touching anything", async () => {
    const { home, cleanup } = tempHome()
    try {
      const unitDir = join(home, "units")
      const runner = recorder()
      const { out, io } = captureIo()
      expect(
        await uninstallService({ io, env: { HOME: home }, platform: "linux", unitDir, runner, argv: ["--dry-run"] }),
      ).toBe(0)
      expect(runner.calls).toEqual([])
      const text = out.join("\n")
      expect(text).toContain("would remove")
      expect(text).toContain("disable --now")
    } finally {
      cleanup()
    }
  })
})
