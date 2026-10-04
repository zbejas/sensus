/**
 * Keystroke latency budget (P4d; docs/testing.md "Latency budget"). The pane is
 * client-owned, but every keystroke/size/fact is a WebSocket round-trip to the
 * daemon. This measures the raw `terminal.input` → `terminal.output` echo on a
 * real daemon + real PTY and asserts a documented budget: loose enough to be
 * stable on a loaded CI box, tight enough to catch a pathological regression
 * (e.g. an accidental synchronous block or a per-keystroke full-state resend).
 *
 * The budget is a MEDIAN over several warm iterations; the shell is warmed first
 * so one-off boot costs never dominate.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon } from "../../../src/daemon/index.ts"
import { WsClient } from "../../../src/client/wsClient.ts"

/** Documented median budget for one keystroke→echo round-trip over WS+UDS. */
const KEYSTROKE_BUDGET_MS = 1500
const ITERATIONS = 5

describe("perf: keystroke latency budget", () => {
  test(`median input→echo round-trip < ${KEYSTROKE_BUDGET_MS}ms`, async () => {
    const runtime = mkdtempSync(join(tmpdir(), "sensus-perf-run-"))
    const home = mkdtempSync(join(tmpdir(), "sensus-perf-home-"))
    const daemon = await startDaemon({
      runtimeDir: runtime,
      token: "perf-token",
      home,
      shell: "/bin/sh",
      config: () => ({}),
      graceMs: 60_000,
    })
    if (!daemon.ok) {
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      throw new Error(daemon.error)
    }
    const client = new WsClient({
      runtimeDir: runtime,
      token: "perf-token",
      port: daemon.tcp.port,
      reconnect: false,
      requestTimeoutMs: 8000,
    })
    const samples: number[] = []
    try {
      await client.waitForHello(8000)
      const opened = await client.terminal.open({ cols: 80, rows: 24 })
      const shellId = opened.shellId
      await client.terminal.attach({ shellId, cols: 80, rows: 24 })

      /** Send `echo MARK` and resolve when the marker echoes back. */
      const roundTrip = (mark: string): Promise<number> =>
        new Promise<number>((resolve, reject) => {
          const t0 = Date.now()
          const timer = setTimeout(() => reject(new Error(`no echo for ${mark}`)), 5000)
          const off = client.on("terminal.output", (e) => {
            if (e.shellId !== shellId) return
            const text = Buffer.from(e.data, "base64").toString("utf8")
            if (!text.includes(mark)) return
            clearTimeout(timer)
            off()
            resolve(Date.now() - t0)
          })
          void client.terminal.input({ shellId, data: `echo ${mark}\n` })
        })

      // Warm the shell (first prompt / integration output) so timing is steady.
      await roundTrip("PERF_WARM")
      for (let i = 0; i < ITERATIONS; i++) samples.push(await roundTrip(`PERF_${i}`))

      samples.sort((a, b) => a - b)
      const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY
      // Surfaces the numbers in the log for future budget tuning.
      console.log(`[perf] keystroke round-trip median=${median}ms samples=[${samples.join(", ")}]`)
      expect(median).toBeLessThan(KEYSTROKE_BUDGET_MS)
      await client.terminal.kill({ shellId })
    } finally {
      client.close()
      daemon.stop()
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }, 30000)
})
