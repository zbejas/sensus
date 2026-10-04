/**
 * `sensus kill` — the global kill switch (docs/operations.md "Daemon"): the
 * pure process matchers, the `/proc`/`ps` scanner, and the SIGTERM→SIGKILL
 * orchestration (scan/signal/liveness are injectable, so no test ever signals
 * a real daemon it did not spawn).
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { daemonPidPath, daemonSocketPath } from "../../../src/daemon/paths.ts"
import {
  commandLineLooksLikeDaemonServe,
  isDaemonServeArgv,
  runKill,
  scanDaemonProcesses,
  type KillIo,
} from "../../../src/daemon/kill.ts"

function captureIo(): { out: string[]; err: string[]; io: KillIo } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

/** A hermetic env: its runtime dir/pidfile is empty and its HOME has no unit. */
function tempEnv(): { dir: string; runtime: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sensus-kill-test-"))
  const runtime = join(dir, "run")
  mkdirSync(runtime, { recursive: true })
  return {
    dir,
    runtime,
    env: { SENSUS_RUNTIME_DIR: runtime, HOME: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("sensus kill matchers", () => {
  test("isDaemonServeArgv accepts the compiled and dev daemon invocations only", () => {
    expect(isDaemonServeArgv(["/usr/local/bin/sensus", "daemon", "serve"])).toBe(true)
    expect(isDaemonServeArgv(["sensus", "daemon", "serve"])).toBe(true)
    expect(isDaemonServeArgv(["/usr/bin/bun", "/repo/src/index.tsx", "daemon", "serve"])).toBe(true)
    expect(isDaemonServeArgv(["/usr/bin/bun", "/repo/src/index.tsx", "daemon", "serve", "--flag"])).toBe(true)
    expect(isDaemonServeArgv(["bun-debug", "/repo/src/index.tsx", "daemon", "serve"])).toBe(true)
    // Not daemons: a different subcommand, a different runtime, or an unrelated
    // process that merely mentions the words.
    expect(isDaemonServeArgv(["sensus", "daemon", "stop"])).toBe(false)
    expect(isDaemonServeArgv(["sensus", "daemon"])).toBe(false)
    expect(isDaemonServeArgv(["node", "server.js", "daemon", "serve"])).toBe(false)
    expect(isDaemonServeArgv(["/usr/bin/bun", "/repo/other.ts", "daemon", "serve"])).toBe(false)
    expect(isDaemonServeArgv(["vim", "daemon", "serve"])).toBe(false)
    expect(isDaemonServeArgv([])).toBe(false)
  })

  test("commandLineLooksLikeDaemonServe matches ps-style command lines", () => {
    expect(commandLineLooksLikeDaemonServe("/usr/local/bin/sensus daemon serve")).toBe(true)
    expect(commandLineLooksLikeDaemonServe("sensus daemon serve")).toBe(true)
    expect(commandLineLooksLikeDaemonServe("/usr/bin/bun /repo/src/index.tsx daemon serve")).toBe(true)
    expect(commandLineLooksLikeDaemonServe("/usr/local/bin/sensus daemon stop")).toBe(false)
    expect(commandLineLooksLikeDaemonServe("/usr/bin/node server.js daemon serve")).toBe(false)
    expect(commandLineLooksLikeDaemonServe("grep daemon serve")).toBe(false)
    expect(commandLineLooksLikeDaemonServe("")).toBe(false)
  })
})

describe("sensus kill scan", () => {
  test("scanDaemonProcesses finds a live daemon-shaped process (real /proc or ps scan)", async () => {
    // A process whose argv is exactly `sensus ... daemon serve`, kept alive on
    // a held-open stdin (no children). `argv0` simulates the installed binary.
    const child = Bun.spawn({
      cmd: ["bash", "-c", "read x", "daemon", "serve"],
      argv0: "sensus",
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await Bun.sleep(100)
      // Only the dummy is in scope: a real daemon on this machine (different
      // argv[0]) must never be matched by this test.
      const result = scanDaemonProcesses({
        matchArgv: (argv) => argv[0] === "sensus" && isDaemonServeArgv(argv),
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.daemons.some((d) => d.pid === child.pid)).toBe(true)
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      await child.exited
    }
  })
})

describe("sensus kill", () => {
  test("no running daemons is a success (idempotent)", async () => {
    const { env, cleanup } = tempEnv()
    try {
      const { out, io } = captureIo()
      const code = await runKill([], io, env, { scan: () => ({ ok: true, daemons: [] }) })
      expect(code).toBe(0)
      expect(out.join("\n")).toContain("no running daemons")
    } finally {
      cleanup()
    }
  })

  test("SIGTERMs every daemon and removes the stale socket/pidfile artifacts", async () => {
    const { dir, runtime, env, cleanup } = tempEnv()
    try {
      writeFileSync(daemonPidPath(runtime), "101\n")
      writeFileSync(daemonSocketPath(runtime), "")
      const alive = new Set([101, 202])
      const signals: Array<[number, string]> = []
      const { out, io } = captureIo()
      const code = await runKill([], io, env, {
        scan: () => ({
          ok: true,
          daemons: [
            { pid: 101, runtimeDir: runtime },
            { pid: 202, runtimeDir: null },
          ],
        }),
        signal: (pid, sig) => {
          signals.push([pid, sig])
          if (sig === "SIGTERM") alive.delete(pid)
        },
        isAlive: (pid) => alive.has(pid),
        sleep: async () => {},
      })
      expect(code).toBe(0)
      expect(signals).toEqual([
        [101, "SIGTERM"],
        [202, "SIGTERM"],
      ])
      expect(out.join("\n")).toContain("stopped 2 daemon(s)")
      expect(existsSync(daemonPidPath(runtime))).toBe(false)
      expect(existsSync(daemonSocketPath(runtime))).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("escalates to SIGKILL for a daemon that ignores SIGTERM", async () => {
    const { env, cleanup } = tempEnv()
    try {
      const alive = new Set([303])
      const signals: Array<[number, string]> = []
      const { out, io } = captureIo()
      const code = await runKill([], io, env, {
        scan: () => ({ ok: true, daemons: [{ pid: 303, runtimeDir: null }] }),
        signal: (pid, sig) => {
          signals.push([pid, sig])
          if (sig === "SIGKILL") alive.delete(pid)
        },
        isAlive: (pid) => alive.has(pid),
        timeoutMs: 20,
        pollMs: 1,
        sleep: (ms) => Bun.sleep(Math.min(ms, 1)),
      })
      expect(code).toBe(0)
      expect(signals).toEqual([
        [303, "SIGTERM"],
        [303, "SIGKILL"],
      ])
      expect(out.join("\n")).toContain("force-killed")
    } finally {
      cleanup()
    }
  })

  test("--dry-run lists the daemons and signals nothing", async () => {
    const { env, cleanup } = tempEnv()
    try {
      const signals: Array<[number, string]> = []
      const { out, io } = captureIo()
      const code = await runKill(["--dry-run"], io, env, {
        scan: () => ({ ok: true, daemons: [{ pid: 404, runtimeDir: null }] }),
        signal: (pid, sig) => signals.push([pid, sig]),
      })
      expect(code).toBe(0)
      expect(signals).toEqual([])
      expect(out.join("\n")).toContain("would stop 1 daemon(s)")
    } finally {
      cleanup()
    }
  })

  test("a daemon known only through the current runtime-dir pidfile is still stopped", async () => {
    const { runtime, env, cleanup } = tempEnv()
    try {
      writeFileSync(daemonPidPath(runtime), "505\n")
      const alive = new Set([505])
      const signals: Array<[number, string]> = []
      const { out, io } = captureIo()
      const code = await runKill([], io, env, {
        scan: () => ({ ok: true, daemons: [] }),
        signal: (pid, sig) => {
          signals.push([pid, sig])
          if (sig === "SIGTERM") alive.delete(pid)
        },
        isAlive: (pid) => alive.has(pid),
        sleep: async () => {},
      })
      expect(code).toBe(0)
      expect(signals).toEqual([[505, "SIGTERM"]])
      expect(out.join("\n")).toContain("stopped 1 daemon(s)")
      expect(existsSync(daemonPidPath(runtime))).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("unknown flags are an error; --help prints the usage", async () => {
    const { env, cleanup } = tempEnv()
    try {
      const bad = captureIo()
      expect(await runKill(["--nope"], bad.io, env, { scan: () => ({ ok: true, daemons: [] }) })).toBe(1)
      expect(bad.err.join("\n")).toContain("unknown flag: --nope")

      const help = captureIo()
      expect(await runKill(["--help"], help.io, env, { scan: () => ({ ok: true, daemons: [] }) })).toBe(0)
      expect(help.out.join("\n")).toContain("usage: sensus kill")
    } finally {
      cleanup()
    }
  })

  test("scans and stops a live daemon-shaped process end to end (real signals)", async () => {
    const { runtime, env, cleanup } = tempEnv()
    const child = Bun.spawn({
      cmd: ["bash", "-c", "read x", "daemon", "serve"],
      argv0: "sensus",
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await Bun.sleep(100)
      const { out, io } = captureIo()
      const realAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "EPERM"
        }
      }
      const code = await runKill([], io, env, {
        // Only the dummy: a real daemon on this machine (different argv[0])
        // must never be in scope for this test.
        scan: () =>
          scanDaemonProcesses({
            matchArgv: (argv) => argv[0] === "sensus" && isDaemonServeArgv(argv),
          }),
        // Bun reaps the direct child; a zombie probe must not read as alive.
        isAlive: (pid) => (pid === child.pid && child.exitCode !== null ? false : realAlive(pid)),
        timeoutMs: 3000,
      })
      await child.exited
      expect(code).toBe(0)
      expect(out.join("\n")).toContain("stopped 1 daemon(s)")
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      await child.exited
      cleanup()
    }
  })
})
