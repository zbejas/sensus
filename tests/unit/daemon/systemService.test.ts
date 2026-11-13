/**
 * Root-owned system service (`--root`; docs/operations.md "Daemon"). Pure unit
 * rendering plus install/uninstall through an injected runner and temp unit dir;
 * no test touches `/etc/systemd/system` or invokes the real `systemctl`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SYSTEM_UNIT_NAME,
  installSystemService,
  renderSystemdSystemUnit,
  systemServiceInstalled,
  systemServicePath,
  uninstallSystemService,
  type CommandResult,
  type CommandRunner,
  type ServiceIo,
} from "../../../src/daemon/index.ts"

function captureIo(): { out: string[]; err: string[]; io: ServiceIo } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

interface Recorder extends CommandRunner {
  calls: string[][]
}

function recorder(failAt = -1): Recorder {
  const calls: string[][] = []
  return {
    calls,
    async run(argv: readonly string[]): Promise<CommandResult> {
      calls.push([...argv])
      return calls.length - 1 === failAt
        ? { ok: false, code: 1, stdout: "", stderr: "boom" }
        : { ok: true, code: 0, stdout: "", stderr: "" }
    },
  }
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sensus-system-service-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const SPEC = {
  argv: ["/opt/sensus/bin/sensus", "daemon", "serve"],
  runtimeDir: "/run/sensus",
  home: "/root/.config/sensus",
}

describe("system service unit", () => {
  test("renders the root unit with persistent mode, runtime and config", () => {
    const unit = renderSystemdSystemUnit(SPEC)
    expect(unit).toContain("Description=Sensus daemon (system)")
    expect(unit).toContain("User=root")
    expect(unit).toContain('ExecStart="/opt/sensus/bin/sensus" "daemon" "serve"')
    expect(unit).toContain('Environment="SENSUS_DAEMON_PERSISTENT=1"')
    expect(unit).toContain('Environment="SENSUS_RUNTIME_DIR=/run/sensus"')
    expect(unit).toContain('Environment="SENSUS_HOME=/root/.config/sensus"')
    expect(unit).toContain("RuntimeDirectory=sensus")
    expect(unit).toContain("RuntimeDirectoryMode=0700")
    expect(unit).toContain("WantedBy=multi-user.target")
    expect(unit).toContain("Restart=on-failure")
    expect(unit).not.toContain("/etc/systemd/user")
  })

  test("systemd escaping keeps a path with spaces and percent intact", () => {
    const unit = renderSystemdSystemUnit({
      ...SPEC,
      argv: ['/home/a b/%sensus', "daemon", "serve"],
      home: "/home/a b/%config",
    })
    expect(unit).toContain('ExecStart="/home/a b/%%sensus" "daemon" "serve"')
    expect(unit).toContain("SENSUS_HOME=/home/a b/%%config")
  })
})

describe("system service install / uninstall", () => {
  test("install writes the unit and enables/starts it", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const runner = recorder()
      const { out, err, io } = captureIo()
      const code = await installSystemService({
        io,
        env: { HOME: "/root" },
        platform: "linux",
        unitDir: dir,
        selfArgv: ["/opt/sensus"],
        uid: 0,
        runner,
      })
      expect(code).toBe(0)
      expect(err).toEqual([])
      expect(existsSync(join(dir, SYSTEM_UNIT_NAME))).toBe(true)
      expect(readFileSync(join(dir, SYSTEM_UNIT_NAME), "utf8")).toContain("User=root")
      expect(runner.calls).toEqual([
        ["systemctl", "daemon-reload"],
        ["systemctl", "enable", "--now", SYSTEM_UNIT_NAME],
        ["systemctl", "is-enabled", SYSTEM_UNIT_NAME],
        ["systemctl", "is-active", SYSTEM_UNIT_NAME],
      ])
      expect(out.join("\n")).toContain("installed systemd system service")
    } finally {
      cleanup()
    }
  })

  test("install startNow:false enables the unit without starting or probing it", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const runner = recorder()
      const { io } = captureIo()
      const code = await installSystemService({
        io,
        env: { HOME: "/root" },
        platform: "linux",
        unitDir: dir,
        selfArgv: ["/opt/sensus"],
        uid: 0,
        runner,
        startNow: false,
      })
      expect(code).toBe(0)
      expect(runner.calls).toContainEqual(["systemctl", "enable", SYSTEM_UNIT_NAME])
      expect(runner.calls).not.toContainEqual(["systemctl", "enable", "--now", SYSTEM_UNIT_NAME])
      expect(runner.calls.some((call) => call[2] === "is-active")).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("--dry-run prints the unit and writes nothing", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const runner = recorder()
      const { out, io } = captureIo()
      const code = await installSystemService({
        io,
        env: { HOME: "/root" },
        platform: "linux",
        unitDir: dir,
        selfArgv: ["/opt/sensus"],
        uid: 0,
        runner,
        argv: ["--dry-run"],
      })
      expect(code).toBe(0)
      expect(existsSync(join(dir, SYSTEM_UNIT_NAME))).toBe(false)
      expect(runner.calls).toEqual([])
      expect(out.join("\n")).toContain("dry run")
      expect(out.join("\n")).toContain("systemctl enable --now")
    } finally {
      cleanup()
    }
  })

  test("non-root and non-Linux are clear errors", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const { err, io } = captureIo()
      expect(
        await installSystemService({
          io,
          env: { HOME: "/root" },
          platform: "linux",
          unitDir: dir,
          uid: 1000,
          runner: recorder(),
        }),
      ).toBe(1)
      expect(err.join("\n")).toContain("must be installed as root")

      const mac = captureIo()
      expect(
        await installSystemService({
          io: mac.io,
          env: { HOME: "/root" },
          platform: "darwin",
          unitDir: dir,
          uid: 0,
          runner: recorder(),
        }),
      ).toBe(1)
      expect(mac.err.join("\n")).toContain("only supported on Linux")
    } finally {
      cleanup()
    }
  })

  test("uninstall disables, removes and reloads; idempotent and dry-run", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const installRunner = recorder()
      await installSystemService({
        io: captureIo().io,
        env: { HOME: "/root" },
        platform: "linux",
        unitDir: dir,
        selfArgv: ["/opt/sensus"],
        uid: 0,
        runner: installRunner,
      })
      expect(systemServiceInstalled(dir)).toBe(true)
      expect(systemServicePath(dir)).toBe(join(dir, SYSTEM_UNIT_NAME))

      const runner = recorder()
      const { out, err, io } = captureIo()
      expect(
        await uninstallSystemService({
          io,
          env: { HOME: "/root" },
          platform: "linux",
          unitDir: dir,
          uid: 0,
          runner,
        }),
      ).toBe(0)
      expect(err).toEqual([])
      expect(existsSync(join(dir, SYSTEM_UNIT_NAME))).toBe(false)
      expect(runner.calls).toEqual([
        ["systemctl", "disable", "--now", SYSTEM_UNIT_NAME],
        ["systemctl", "daemon-reload"],
      ])
      expect(out.join("\n")).toContain("uninstalled system service")

      const again = recorder()
      const second = captureIo()
      expect(
        await uninstallSystemService({
          io: second.io,
          env: { HOME: "/root" },
          platform: "linux",
          unitDir: dir,
          uid: 0,
          runner: again,
        }),
      ).toBe(0)
      expect(again.calls).toEqual([])
      expect(second.out.join("\n")).toContain("not installed")

      const dry = recorder()
      const plan = captureIo()
      expect(
        await uninstallSystemService({
          io: plan.io,
          env: { HOME: "/root" },
          platform: "linux",
          unitDir: dir,
          uid: 0,
          runner: dry,
          argv: ["--dry-run"],
        }),
      ).toBe(0)
      expect(dry.calls).toEqual([])
      expect(plan.out.join("\n")).toContain("would remove")
    } finally {
      cleanup()
    }
  })
})
