/**
 * Daemon listeners (docs/daemon-api.md): both transports serve the same app,
 * both reject an absent token and accept the right one, the runtime
 * dir/token/socket carry their private modes, the TCP bind is loopback only, and
 * `stop()` tears the socket down. Real Unix + TCP sockets, real filesystem —
 * cleaned up in `finally`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readToken, startDaemon, daemonSocketPath, daemonTokenPath, DEFAULT_DAEMON_HOST, displayHost, resolveDaemonBind, type StartDaemonResult } from "../../../src/daemon/index.ts"

const TOKEN = "feedfacefeedfacefeedfacefeedface"

const withDaemon = async (
  fn: (info: { dir: string; result: Extract<StartDaemonResult, { ok: true }>; sock: string }) => Promise<void>,
  opts: { host?: string } = {},
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-serve-"))
  let result: StartDaemonResult | undefined
  try {
    result = await startDaemon({ runtimeDir: dir, token: TOKEN, home: join(dir, "home"), config: () => ({}), ...opts })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await fn({ dir, result, sock: daemonSocketPath(dir) })
  } finally {
    result?.ok && result.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

const mode = (path: string): number => statSync(path).mode & 0o777

describe("daemon serve: both transports", () => {
  test("loopback TCP and the Unix socket 401 without the token and 200 with it", async () => {
    await withDaemon(async ({ result, sock }) => {
      const base = `http://127.0.0.1:${result.tcp.port}/v1/health`

      const tcpDenied = await fetch(base)
      expect(tcpDenied.status).toBe(401)
      const tcpOk = await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } })
      expect(tcpOk.status).toBe(200)

      const udsUrl = "http://localhost/v1/health"
      const udsDenied = await fetch(udsUrl, { unix: sock })
      expect(udsDenied.status).toBe(401)
      const udsOk = await fetch(udsUrl, { unix: sock, headers: { authorization: `Bearer ${TOKEN}` } })
      expect(udsOk.status).toBe(200)
      expect(await udsOk.json()).toMatchObject({ ok: true, name: "sensus-daemon" })
    })
  })

  test("info over loopback reports the real ephemeral port and the socket path", async () => {
    await withDaemon(async ({ dir, result, sock }) => {
      const res = await fetch(`http://127.0.0.1:${result.tcp.port}/v1/info`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const info = (await res.json()) as Record<string, unknown>
      expect(info).toMatchObject({ ok: true, name: "sensus-daemon", socket: sock, tcp: { host: "127.0.0.1", port: result.tcp.port } })
      expect(info["pid"]).toBe(process.pid)
      // Machine identity (docs/events.md): generated at boot under the config
      // home and reported on /v1/info.
      const instance = info["instance"] as { instanceId?: unknown; createdAt?: unknown; version?: unknown }
      expect(typeof instance.instanceId).toBe("string")
      expect(typeof instance.createdAt).toBe("number")
      expect(existsSync(join(dir, "home", "instance.json"))).toBe(true)
    })
  })

  test("instance.json is created once and REUSED across restarts (stable identity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-instance-"))
    let first: StartDaemonResult | undefined
    let second: StartDaemonResult | undefined
    try {
      const home = join(dir, "home")
      first = await startDaemon({ runtimeDir: dir, token: TOKEN, home, config: () => ({}) })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const info1 = (await (
        await fetch(`http://127.0.0.1:${first.tcp.port}/v1/info`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json()) as { instance: { instanceId: string; createdAt: number } }
      first.stop()
      first = undefined

      second = await startDaemon({ runtimeDir: dir, token: TOKEN, home, config: () => ({}) })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      const info2 = (await (
        await fetch(`http://127.0.0.1:${second.tcp.port}/v1/info`, { headers: { authorization: `Bearer ${TOKEN}` } })
      ).json()) as { instance: { instanceId: string; createdAt: number } }
      expect(info2.instance.instanceId).toBe(info1.instance.instanceId)
      expect(info2.instance.createdAt).toBe(info1.instance.createdAt)
    } finally {
      first?.ok && first.stop()
      second?.ok && second.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("daemon serve: filesystem, loopback and lifecycle", () => {
  test("dir 0700, token/socket 0600, token contents, stop() removes the socket", async () => {
    await withDaemon(async ({ dir, result, sock }) => {
      expect(result.unix).toBe(sock)
      expect(result.tcp.host).toBe("127.0.0.1")
      expect(result.tcp.port).toBeGreaterThan(0)

      expect(mode(dir)).toBe(0o700)
      expect(mode(daemonTokenPath(dir))).toBe(0o600)
      expect(mode(sock)).toBe(0o600)
      expect(readToken(daemonTokenPath(dir))).toBe(TOKEN)
      expect(statSync(sock).isSocket()).toBe(true)

      result.stop()
      expect(existsSync(sock)).toBe(false)
      // stop() is idempotent.
      result.stop()
    })
  })

  test("a stale socket file is unlinked before binding; a non-loopback host is coerced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-stale-"))
    let result: StartDaemonResult | undefined
    try {
      writeFileSync(daemonSocketPath(dir), "stale", "utf8")
      result = await startDaemon({ runtimeDir: dir, token: TOKEN, host: "0.0.0.0", home: dir, config: () => ({}) })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.tcp.host).toBe("127.0.0.1")
      expect(statSync(result.unix).isSocket()).toBe(true)
    } finally {
      result?.ok && result.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("daemon bind opt-in (D7/D14)", () => {
  test("loopback is the default and the programmatic seam stays coerced", () => {
    expect(resolveDaemonBind({}, {})).toEqual({ host: DEFAULT_DAEMON_HOST, port: 0 })
    // opts.host is a test seam: non-loopback through it is coerced back.
    expect(resolveDaemonBind({}, { host: "0.0.0.0", port: 1234 })).toEqual({ host: "127.0.0.1", port: 1234 })
  })

  test("SENSUS_DAEMON_HOST/PORT are the explicit opt-in", () => {
    expect(resolveDaemonBind({ SENSUS_DAEMON_HOST: "192.168.10.10" }, {})).toEqual({ host: "192.168.10.10", port: 0 })
    expect(resolveDaemonBind({ SENSUS_DAEMON_HOST: "0.0.0.0", SENSUS_DAEMON_PORT: "4711" }, {})).toEqual({
      host: "0.0.0.0",
      port: 4711,
    })
    // opts.port wins over env; an invalid/blank env host or port falls back.
    expect(resolveDaemonBind({ SENSUS_DAEMON_PORT: "4711" }, { port: 999 })).toEqual({ host: "127.0.0.1", port: 999 })
    expect(resolveDaemonBind({ SENSUS_DAEMON_PORT: "nope" }, {})).toEqual({ host: "127.0.0.1", port: 0 })
    expect(resolveDaemonBind({ SENSUS_DAEMON_HOST: "   " }, {})).toEqual({ host: "127.0.0.1", port: 0 })
  })

  test("displayHost maps a wildcard bind to a usable address", () => {
    expect(displayHost("192.168.10.10")).toBe("192.168.10.10")
    expect(displayHost("0.0.0.0")).not.toBe("0.0.0.0")
    expect(displayHost("::")).not.toBe("::")
  })

  test("a SENSUS_DAEMON_HOST opt-in is actually bound by startDaemon", async () => {
    const prev = process.env["SENSUS_DAEMON_HOST"]
    process.env["SENSUS_DAEMON_HOST"] = "0.0.0.0"
    const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-bind-"))
    let result: StartDaemonResult | undefined
    try {
      result = await startDaemon({ runtimeDir: dir, token: TOKEN, home: join(dir, "home"), config: () => ({}) })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.tcp.host).toBe("0.0.0.0")
    } finally {
      result?.ok && result.stop()
      if (prev === undefined) delete process.env["SENSUS_DAEMON_HOST"]
      else process.env["SENSUS_DAEMON_HOST"] = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
