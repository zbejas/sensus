/**
 * Daemon-kill degrade (P4d; D5). The TUI is a front end: if the daemon dies
 * mid-session the client must surface the loss and never crash. This drives the
 * real transport against a daemon that is stopped under it, then asserts the
 * connection state degrades, further ops become typed rejections (not thrown
 * exceptions), and the daemon's shells are gone (no PTY orphans).
 */

import { describe, expect, test } from "bun:test"
import { WsClient } from "../../../src/client/wsClient.ts"
import { startTestDaemon, waitUntil } from "./support.ts"

describe("client degrade when the daemon dies", () => {
  test("a killed daemon surfaces a closed/error state, never crashes, and reaps its shells", async () => {
    const daemon = await startTestDaemon()
    const errors: string[] = []
    const client = new WsClient({
      runtimeDir: daemon.runtime,
      token: daemon.token,
      port: daemon.result.tcp.port,
      reconnect: false,
      requestTimeoutMs: 2000,
      onError: (m) => errors.push(m),
    })
    try {
      await client.waitForHello(8000)
      const opened = await client.terminal.open({ cols: 80, rows: 24 })
      await client.terminal.attach({ shellId: opened.shellId, cols: 80, rows: 24 })

      // Kill the daemon under the live session (closes clients, kills shells).
      daemon.result.stop()

      await waitUntil(() => (client.state === "closed" ? true : null), 5000)
      expect(client.connected).toBe(false)

      // A later op is a typed rejection — the caller can show a dead/error
      // state; nothing throws out of the transport.
      await expect(client.terminal.list()).rejects.toMatchObject({ code: "closed" })

      // The daemon reaped its own PTY shells (no orphan children).
      const alive = daemon.result.registry.list().filter((s) => s.alive)
      expect(alive).toEqual([])
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})
