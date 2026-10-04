/**
 * Daemon end-to-end over the real Unix socket (docs/daemon-api.md): spawn
 * `sensus daemon serve` against a temp `SENSUS_RUNTIME_DIR`/`SENSUS_HOME`, wait
 * for the socket, verify the bearer token is required, read health/info over
 * `Bun.connect` (no curl), then SIGTERM and prove the process and socket are
 * gone. Also drives the dev-mode `start`/`status`/`stop` lifecycle so the
 * self-exec argv is exercised outside the compiled-binary smoke test.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  daemonPidPath,
  daemonSelfArgv,
  daemonSocketPath,
  daemonTokenPath,
  readPidFile,
  readToken,
  requestOverUnix,
  runDaemon,
  type DaemonIo,
} from "../../../src/daemon/index.ts"

/** The real repo entry (`bun run src/index.tsx`); the test runner's `Bun.main` is not it. */
const ENTRY = fileURLToPath(new URL("../../../src/index.tsx", import.meta.url))

/** The base argv for re-execing the CLI in dev mode (bun + the entry file). */
function entryArgv(): string[] {
  return daemonSelfArgv(process.execPath, ENTRY, false)
}

function captureIo(): { out: string[]; err: string[]; io: DaemonIo } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

function tempDirs(): { runtime: string; home: string; cleanup: () => void } {
  const runtime = mkdtempSync(join(tmpdir(), "sensus-daemon-e2e-run-"))
  const home = mkdtempSync(join(tmpdir(), "sensus-daemon-e2e-home-"))
  return {
    runtime,
    home,
    cleanup: () => {
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function envFor(runtime: string, home: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    SENSUS_RUNTIME_DIR: runtime,
    SENSUS_HOME: home,
    SENSUS_SKIP: "1",
    // Pin the idle policy so an inherited value cannot change the e2e timing.
    SENSUS_DAEMON_PERSISTENT: "0",
    SENSUS_DAEMON_GRACE_MS: "300000",
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error("waitFor timed out")
}

/** Poll until `read()` is truthy; returns the value. */
async function waitValue<T>(read: () => T | null | undefined, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("waitValue timed out")
    await Bun.sleep(50)
  }
}

/** Open a real WebSocket to the daemon's loopback listener. */
function wsOpen(url: string, token: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("ws error"))
    })
  })
}

/** Send one request frame and await the matching response. */
function wsRequest(ws: WebSocket, op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `e2e-${op}-${Math.random().toString(36).slice(2, 8)}`
    let timer: ReturnType<typeof setTimeout>
    const onMessage = (event: MessageEvent): void => {
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>
        if (frame["type"] === "res" && frame["id"] === id) {
          clearTimeout(timer)
          ws.removeEventListener("message", onMessage)
          resolve(frame)
        }
      } catch {
        // ignore non-JSON frames
      }
    }
    timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error(`ws request timeout: ${op}`))
    }, 8000)
    ws.addEventListener("message", onMessage)
    ws.send(JSON.stringify({ type: "req", id, op, ...params }))
  })
}

describe("daemonSelfArgv", () => {
  test("compiled binary uses execPath alone; dev uses execPath + Bun.main", () => {
    expect(daemonSelfArgv("/opt/sensus", "/$bunfs/root/sensus", true)).toEqual(["/opt/sensus"])
    expect(daemonSelfArgv("/usr/bin/bun", "/repo/src/index.tsx", false)).toEqual(["/usr/bin/bun", "/repo/src/index.tsx"])
  })
})

describe("daemon e2e: socket + lifecycle", () => {
  test("serve: socket auth, health/info over Bun.connect, SIGTERM removes the socket", async () => {
    const { runtime, home, cleanup } = tempDirs()
    // A config with an unreachable mock endpoint so /v1/models answers fast.
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ model: "main@m", endpoints: { main: { baseURL: "http://127.0.0.1:1/v1", apiKey: "" } } }),
      "utf8",
    )
    // Pre-seed a fresh models.dev cache so the catalog route makes no outbound call.
    writeFileSync(join(runtime, "models-dev.json"), JSON.stringify({ fetchedAt: Date.now(), providers: {} }), "utf8")
    const child = Bun.spawn([...entryArgv(), "daemon", "serve"], {
      env: { ...envFor(runtime, home), SENSUS_CACHE_DIR: runtime },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const sock = daemonSocketPath(runtime)
      await waitFor(async () => {
        if (!existsSync(sock)) return false
        const probe = await requestOverUnix({ unix: sock, path: "/v1/health", timeoutMs: 700 }).catch(() => null)
        return probe !== null && probe.status === 401
      })

      // No bearer -> 401.
      const denied = await requestOverUnix({ unix: sock, path: "/v1/health" })
      expect(denied.status).toBe(401)
      expect(JSON.parse(denied.body)).toEqual({ error: "unauthorized" })

      const token = readToken(daemonTokenPath(runtime))
      expect(token).not.toBeNull()
      const authed = await requestOverUnix({ unix: sock, path: "/v1/health", token: token ?? undefined })
      expect(authed.status).toBe(200)
      expect(JSON.parse(authed.body)).toMatchObject({ ok: true, name: "sensus-daemon" })

      const info = await requestOverUnix({ unix: sock, path: "/v1/info", token: token ?? undefined })
      expect(info.status).toBe(200)
      const infoBody = JSON.parse(info.body) as { name: string; socket: string; pid: number; shells: number; persistent: boolean }
      expect(infoBody.name).toBe("sensus-daemon")
      expect(infoBody.socket).toBe(sock)
      expect(infoBody.pid).toBe(child.pid)
      // D21/D9: the live shell count and the persistent flag are part of info.
      expect(infoBody.shells).toBe(0)
      expect(infoBody.persistent).toBe(false)

      // P4c-ii read resources are reachable over the real UDS socket.
      const read = async (path: string): Promise<Record<string, unknown>> => {
        const res = await requestOverUnix({ unix: sock, path, token: token ?? undefined })
        expect(res.status).toBe(200)
        return JSON.parse(res.body) as Record<string, unknown>
      }
      expect(await read("/v1/mcp")).toEqual({ ok: true, servers: [] })
      const models = await read("/v1/models")
      expect(models["ok"]).toBe(true)
      expect((models["endpoints"] as Array<{ name: string; hasKey: boolean }>)[0]).toMatchObject({ name: "main", hasKey: false })
      expect((models["errors"] as string[]).length).toBe(1) // the unreachable endpoint
      // Draft-endpoint probe: an unreachable draft is a successful response with
      // a fetch error (never a 500), and the transient key never comes back.
      const probe = await requestOverUnix({
        unix: sock,
        method: "POST",
        path: "/v1/models/probe",
        token: token ?? undefined,
        body: JSON.stringify({ provider: "anthropic", baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-e2e-secret" }),
      })
      expect(probe.status).toBe(200)
      const probeBody = JSON.parse(probe.body) as { ok: boolean; models: unknown[]; error: string | null }
      expect(probeBody.ok).toBe(true)
      expect(probeBody.models).toEqual([])
      expect(probeBody.error).not.toBeNull()
      expect(probe.body).not.toContain("sk-e2e-secret")
      const usage = await read("/v1/usage")
      expect(usage["ok"]).toBe(true)
      expect((usage["total"] as { calls: number }).calls).toBe(0)
      expect(usage["windowDays"]).toBe(14)
      expect(await read("/v1/secrets")).toEqual({ ok: true, names: [], warnings: [] })

      // P4c-ii secrets: write-only values, listable names.
      const setSecret = await requestOverUnix({
        unix: sock,
        method: "POST",
        path: "/v1/secrets",
        token: token ?? undefined,
        body: JSON.stringify({ name: "E2E_KEY", value: "e2e-secret-value" }),
      })
      expect(setSecret.status).toBe(200)
      const listed = await read("/v1/secrets")
      expect(listed["names"]).toEqual(["E2E_KEY"])
      expect(JSON.stringify(listed)).not.toContain("e2e-secret-value")
      const removed = await requestOverUnix({
        unix: sock,
        method: "DELETE",
        path: "/v1/secrets?name=E2E_KEY",
        token: token ?? undefined,
      })
      expect(JSON.parse(removed.body)).toEqual({ ok: true, name: "E2E_KEY", removed: true })

      // P4c-ii config write: a patch is applied and the redacted config reflects it.
      const patched = await requestOverUnix({
        unix: sock,
        method: "PUT",
        path: "/v1/config",
        token: token ?? undefined,
        body: JSON.stringify({ config: { model: "main@m2" } }),
      })
      expect(patched.status).toBe(200)
      expect((JSON.parse(patched.body) as { config: { model: string } }).config.model).toBe("main@m2")

      const pid = readPidFile(daemonPidPath(runtime))
      expect(pid).toBe(child.pid)

      // SIGTERM: the foreground serve stops cleanly and removes the socket.
      child.kill("SIGTERM")
      const code = await child.exited
      expect(code).toBe(0)
      await waitFor(() => !existsSync(sock), 5000)
      expect(existsSync(daemonPidPath(runtime))).toBe(false)
      // The child is reaped: no live process at that pid.
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // already exited
      }
      cleanup()
    }
  }, 30000)

  test("start/status/stop in dev mode leaves no pidfile, socket or process", async () => {    const { runtime, home, cleanup } = tempDirs()
    const started = Bun.spawn([...entryArgv(), "daemon", "start"], {
      env: envFor(runtime, home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let pid: number | null = null
    try {
      const [code, out, err] = await Promise.all([
        started.exited,
        new Response(started.stdout).text(),
        new Response(started.stderr).text(),
      ])
      expect(err).toBe("")
      expect(code).toBe(0)
      expect(out).toContain("started")

      const sock = daemonSocketPath(runtime)
      await waitFor(() => existsSync(sock))
      pid = readPidFile(daemonPidPath(runtime))
      expect(pid).not.toBeNull()
      expect(process.kill(pid ?? 0, 0)).toBe(true)

      const status = captureIo()
      expect(await runDaemon(["status"], status.io, envFor(runtime, home))).toBe(0)
      expect(status.out.join("\n")).toContain("running")

      const stop = captureIo()
      expect(await runDaemon(["stop"], stop.io, envFor(runtime, home))).toBe(0)
      expect(stop.out.join("\n")).toContain("stopped")

      await waitFor(() => !existsSync(sock) && !existsSync(daemonPidPath(runtime)), 8000)
      expect(() => process.kill(pid ?? 0, 0)).toThrow()

      // stop is idempotent when nothing is running.
      const again = captureIo()
      expect(await runDaemon(["stop"], again.io, envFor(runtime, home))).toBe(0)
      expect(again.out.join("\n")).toContain("not running")
    } finally {
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // already gone
        }
      }
      cleanup()
    }
  }, 40000)

  test("daemon stop tears down the shell PTY child (no orphan)", async () => {
    const { runtime, home, cleanup } = tempDirs()
    // A pane "shell" that records its own pid and then execs a long sleep, so
    // the PTY child's pid is stable across the shell launch.
    const pidFile = join(runtime, "shell.pid")
    const script = join(runtime, "shell-under-test.sh")
    writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 1000\n`, { mode: 0o755 })
    chmodSync(script, 0o755)

    const child = Bun.spawn([...entryArgv(), "daemon", "serve"], {
      env: envFor(runtime, home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let ws: WebSocket | null = null
    let shellPid: number | null = null
    try {
      const sock = daemonSocketPath(runtime)
      await waitFor(async () => {
        if (!existsSync(sock)) return false
        const probe = await requestOverUnix({ unix: sock, path: "/v1/health", timeoutMs: 700 }).catch(() => null)
        return probe !== null && probe.status === 401
      })
      const token = readToken(daemonTokenPath(runtime))
      expect(token).not.toBeNull()

      // The WS channel is loopback-only; the UDS info route reports the port.
      const info = await requestOverUnix({ unix: sock, path: "/v1/info", token: token ?? undefined })
      const port = (JSON.parse(info.body) as { tcp: { port: number } }).tcp.port
      expect(port).toBeGreaterThan(0)

      ws = await wsOpen(`ws://127.0.0.1:${port}/v1/ws`, token ?? "")
      const opened = await wsRequest(ws, "terminal.open", { cols: 80, rows: 24, shell: script })
      expect(opened["ok"]).toBe(true)

      shellPid = await waitValue(() => {
        if (!existsSync(pidFile)) return null
        const n = Number(readFileSync(pidFile, "utf8").trim())
        return Number.isFinite(n) && n > 0 ? n : null
      })
      expect(process.kill(shellPid, 0)).toBe(true)

      const stop = captureIo()
      expect(await runDaemon(["stop"], stop.io, envFor(runtime, home))).toBe(0)
      expect(await child.exited).toBe(0)

      // The daemon is gone AND its shell child was killed, not orphaned.
      await waitValue(() => {
        try {
          process.kill(shellPid ?? 0, 0)
          return null
        } catch {
          return true
        }
      }, 8000)
      expect(() => process.kill(shellPid ?? 0, 0)).toThrow()
    } finally {
      try {
        ws?.close()
      } catch {
        // already closed
      }
      if (shellPid !== null) {
        try {
          process.kill(shellPid, "SIGKILL")
        } catch {
          // already gone
        }
      }
      try {
        child.kill("SIGKILL")
      } catch {
        // already exited
      }
      cleanup()
    }
  }, 40000)
})

describe("runDaemon: headless command surface", () => {
  test("install/uninstall --dry-run print the unit/plan (never touch the system); unknown commands fail with usage", async () => {
    const { runtime, home, cleanup } = tempDirs()
    try {
      const env = envFor(runtime, home)
      // `--dry-run` exercises the real dispatch without writing a unit or
      // invoking systemctl/launchctl (the injected-runner path is unit-tested).
      const install = captureIo()
      expect(await runDaemon(["install", "--dry-run"], install.io, env)).toBe(0)
      expect(install.err).toEqual([])
      const text = install.out.join("\n")
      expect(text).toContain("dry run")
      expect(text).toContain("SENSUS_DAEMON_PERSISTENT=1")

      const uninstall = captureIo()
      expect(await runDaemon(["uninstall", "--dry-run"], uninstall.io, env)).toBe(0)
      expect(uninstall.out.join("\n")).toContain("would remove")

      const unknown = captureIo()
      expect(await runDaemon(["bogus"], unknown.io, env)).toBe(1)
      expect(unknown.err.join("\n")).toContain("usage: sensus daemon")
    } finally {
      cleanup()
    }
  })

  test("restart stops a running daemon and starts a fresh one (D18)", async () => {
    const { runtime, home, cleanup } = tempDirs()
    let pid: number | null = null
    try {
      const env = envFor(runtime, home)
      // `restart` when nothing runs is just a start.
      const restart = Bun.spawn([...entryArgv(), "daemon", "restart"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, out, err] = await Promise.all([
        restart.exited,
        new Response(restart.stdout).text(),
        new Response(restart.stderr).text(),
      ])
      expect(err).toBe("")
      expect(code).toBe(0)
      expect(out).toContain("restarting")
      expect(out).toContain("started")

      const sock = daemonSocketPath(runtime)
      await waitFor(() => existsSync(sock))
      pid = readPidFile(daemonPidPath(runtime))
      expect(pid).not.toBeNull()
      expect(process.kill(pid ?? 0, 0)).toBe(true)

      // A second restart swaps the process for a new one.
      const again = Bun.spawn([...entryArgv(), "daemon", "restart"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code2, out2] = await Promise.all([again.exited, new Response(again.stdout).text()])
      expect(code2).toBe(0)
      expect(out2).toContain("stopped")
      expect(out2).toContain("started")
      await waitFor(() => existsSync(sock))
      // Track the replacement process for the finally cleanup.
      pid = readPidFile(daemonPidPath(runtime))

      const stop = captureIo()
      expect(await runDaemon(["stop"], stop.io, env)).toBe(0)
      await waitFor(() => !existsSync(sock) && !existsSync(daemonPidPath(runtime)), 8000)
      expect(() => process.kill(pid ?? 0, 0)).toThrow()
    } finally {
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // already gone
        }
      }
      cleanup()
    }
  }, 40000)
})
