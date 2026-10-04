/**
 * daemonEnsure — the boot primitive (P4b; D3/D5/D21; docs/daemon-api.md
 * "Lifecycle").
 *
 * Happy path against a real daemon, the clear-failure paths (a dead runtime dir,
 * a refused spawn), and the D21 version-handshake cases with injected versions:
 * a shell-holding mismatch warns, a shell-less mismatch restarts. Also the
 * `connect()` convenience and its detach-only `stop()`.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon, daemonTokenPath, writeToken, type StartDaemonResult } from "../../../src/daemon/index.ts"
import { connect, ensureDaemon, restartAndReconnect } from "../../../src/client/daemonEnsure.ts"
import { SENSUS_VERSION } from "../../../src/version.ts"
import { startTestDaemon } from "./support.ts"

describe("daemonEnsure", () => {
  test("uses a healthy daemon already in the runtime dir", async () => {
    const daemon = await startTestDaemon()
    try {
      const ensured = await ensureDaemon({ runtimeDir: daemon.runtime, localVersion: SENSUS_VERSION })
      expect(ensured.ok).toBe(true)
      if (!ensured.ok) return
      expect(ensured.spawned).toBe(false)
      expect(ensured.warning).toBeNull()
      expect(ensured.token).toBe(daemon.token)
      expect(ensured.info.version).toBe(SENSUS_VERSION)
      expect(ensured.info.tcp.port).toBe(daemon.result.tcp.port)
    } finally {
      daemon.cleanup()
    }
  }, 30000)

  test("fails clearly at a dead runtime dir (no spawn)", async () => {
    const dead = mkdtempSync(join(tmpdir(), "sensus-ensure-dead-"))
    try {
      const ensured = await ensureDaemon({ runtimeDir: dead, spawn: false })
      expect(ensured.ok).toBe(false)
      if (ensured.ok) return
      expect(ensured.error).toContain("no daemon is running")
      expect(ensured.error).toContain(dead)
    } finally {
      rmSync(dead, { recursive: true, force: true })
    }
  }, 30000)

  test("reports a token-present daemon that is not answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-ensure-token-"))
    try {
      const wrote = writeToken(daemonTokenPath(dir), "stale-token")
      expect(wrote.ok).toBe(true)
      const ensured = await ensureDaemon({ runtimeDir: dir, spawn: false, probeTimeoutMs: 1000 })
      expect(ensured.ok).toBe(false)
      if (ensured.ok) return
      expect(ensured.error).toContain("not responding")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("a refused spawn is a clear error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-ensure-refused-"))
    try {
      const ensured = await ensureDaemon({
        runtimeDir: dir,
        spawnDaemon: () => ({ ok: false, error: "spawn refused by test" }),
      })
      expect(ensured.ok).toBe(false)
      if (ensured.ok) return
      expect(ensured.error).toContain("spawn refused by test")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  test("D21: a mismatch on a daemon holding shells warns instead of restarting", async () => {
    const daemon = await startTestDaemon()
    try {
      const opened = daemon.result.registry.open({ cols: 80, rows: 24 })
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      const ensured = await ensureDaemon({ runtimeDir: daemon.runtime, localVersion: "9.9.9" })
      expect(ensured.ok).toBe(true)
      if (!ensured.ok) return
      expect(ensured.spawned).toBe(false)
      expect(ensured.warning).not.toBeNull()
      expect(ensured.warning).toContain("9.9.9")
      expect(ensured.warning).toContain("shell")
      expect(ensured.info.shells).toBe(1)
      // The daemon was left untouched: its shell registry still holds the shell.
      expect(daemon.result.registry.list().length).toBe(1)
      daemon.result.registry.kill(opened.result.shellId)
    } finally {
      daemon.cleanup()
    }
  }, 30000)

  test("D21: a shell-less mismatch restarts the daemon (stop + spawn)", async () => {
    const daemon = await startTestDaemon()
    const replacements: Array<Extract<StartDaemonResult, { ok: true }>> = []
    let stopped = false
    let spawned = false
    try {
      const ensured = await ensureDaemon({
        runtimeDir: daemon.runtime,
        localVersion: "9.9.9",
        stopDaemon: () => {
          stopped = true
          daemon.result.stop()
          return { ok: true }
        },
        spawnDaemon: async () => {
          spawned = true
          const r = await startDaemon({
            runtimeDir: daemon.runtime,
            token: daemon.token,
            home: daemon.home,
            shell: "/bin/sh",
            config: () => ({}),
            graceMs: 60_000,
          })
          if (!r.ok) return { ok: false, error: r.error }
          replacements.push(r)
          return { ok: true }
        },
      })
      expect(ensured.ok).toBe(true)
      if (!ensured.ok) return
      expect(stopped).toBe(true)
      expect(spawned).toBe(true)
      expect(ensured.spawned).toBe(true)
      expect(ensured.token).toBe(daemon.token)
      expect(ensured.info.version).toBe(SENSUS_VERSION)
      // The injected version "9.9.9" still mismatches the freshly spawned real
      // daemon, so the handshake surfaces it as a warning rather than looping.
      expect(ensured.warning).not.toBeNull()
    } finally {
      for (const r of replacements) {
        try {
          r.stop()
        } catch {
          // idempotent
        }
      }
      daemon.cleanup()
    }
  }, 30000)

  test("D21: restartAndReconnect detaches, stops the shell-holding daemon, and reconnects to the new version", async () => {
    const daemon = await startTestDaemon()
    const replacements: Array<Extract<StartDaemonResult, { ok: true }>> = []
    try {
      const opened = daemon.result.registry.open({ cols: 80, rows: 24 })
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      const conn = await connect({
        runtimeDir: daemon.runtime,
        localVersion: "9.9.9",
        wsOptions: { reconnect: false, requestTimeoutMs: 8000 },
      })
      expect(conn.ok).toBe(true)
      if (!conn.ok) return
      expect(conn.warning).not.toBeNull()
      await conn.ws.waitForHello(8000)

      let stopped = false
      const reconnected = await restartAndReconnect(conn, {
        runtimeDir: daemon.runtime,
        localVersion: SENSUS_VERSION,
        wsOptions: { reconnect: false, requestTimeoutMs: 8000 },
        stopDaemon: () => {
          stopped = true
          daemon.result.stop()
          return { ok: true }
        },
        spawnDaemon: async () => {
          const r = await startDaemon({
            runtimeDir: daemon.runtime,
            token: daemon.token,
            home: daemon.home,
            shell: "/bin/sh",
            config: () => ({}),
            graceMs: 60_000,
          })
          if (!r.ok) return { ok: false, error: r.error }
          replacements.push(r)
          return { ok: true }
        },
      })
      expect(stopped).toBe(true)
      // The old client was detached before the daemon was replaced.
      expect(conn.ws.state).toBe("closed")
      expect(reconnected.ok).toBe(true)
      if (!reconnected.ok) return
      expect(reconnected.warning).toBeNull()
      expect(reconnected.info.version).toBe(SENSUS_VERSION)
      await reconnected.ws.waitForHello(8000)
      expect(reconnected.ws.connected).toBe(true)
      reconnected.stop()
    } finally {
      for (const r of replacements) {
        try {
          r.stop()
        } catch {
          // idempotent
        }
      }
      daemon.cleanup()
    }
  }, 30000)

  test("connect() hands back a live wsClient; stop() detaches but leaves the daemon", async () => {
    const daemon = await startTestDaemon()
    try {
      const conn = await connect({
        runtimeDir: daemon.runtime,
        localVersion: SENSUS_VERSION,
        wsOptions: { reconnect: false, requestTimeoutMs: 8000 },
      })
      expect(conn.ok).toBe(true)
      if (!conn.ok) return
      expect(conn.spawned).toBe(false)
      const hello = await conn.ws.waitForHello(8000)
      expect(hello.protocol).toBe("sensus-ws/1")
      expect(conn.ws.connected).toBe(true)

      conn.stop()
      expect(conn.ws.state).toBe("closed")

      // Detach does NOT kill the daemon: REST still answers and the shell
      // registry is intact.
      const probe = await conn.rest.health()
      expect(probe.ok).toBe(true)
      expect(daemon.result.registry.list()).toEqual([])
    } finally {
      daemon.cleanup()
    }
  }, 30000)
})
