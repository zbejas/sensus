/**
 * Daemon structured logging (docs/operations.md "Structured daemon log"): boot
 * configures `<runtimeDir>/daemon-log.jsonl`, a logged path writes a
 * `daemon`-component record, the boot bearer token is redacted by value, and the
 * `SENSUS_LOG_STRICT` gate decides whether an allow-listed absorbed failure
 * rethrows (→ 500) or stays soft (→ 200).
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Elysia } from "elysia"
import { configureLogger, flushLoggerSync, readLogFile, type LogRecord } from "../../../src/core/log.ts"
import { daemonLogJsonlPath, logStrictEnabled, settingsRoutes, startDaemon, type StartDaemonOptions, type StartDaemonResult } from "../../../src/daemon/index.ts"

const TOKEN = "feedfacefeedfacefeedfacefeedface"

/** Boot a hermetic daemon in a scratch runtime dir; the logger writes there. */
async function withLoggedDaemon(
  fn: (info: { dir: string; logPath: string; result: Extract<StartDaemonResult, { ok: true }> }) => Promise<void>,
  env: Record<string, string> = { SENSUS_LOG_LEVEL: "debug" },
  startOpts: Partial<StartDaemonOptions> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sensus-daemon-log-"))
  const prev = { level: process.env["SENSUS_LOG_LEVEL"], strict: process.env["SENSUS_LOG_STRICT"] }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  if (!("SENSUS_LOG_STRICT" in env)) delete process.env["SENSUS_LOG_STRICT"]
  let result: StartDaemonResult | undefined
  try {
    result = await startDaemon({ runtimeDir: dir, token: TOKEN, home: join(dir, "home"), config: () => ({}), ...startOpts })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    flushLoggerSync()
    await fn({ dir, logPath: daemonLogJsonlPath(dir), result })
  } finally {
    result?.ok && result.stop()
    flushLoggerSync()
    // Do not leak the file logger into other tests in this process.
    silentLogger()
    if (prev.level === undefined) delete process.env["SENSUS_LOG_LEVEL"]
    else process.env["SENSUS_LOG_LEVEL"] = prev.level
    if (prev.strict === undefined) delete process.env["SENSUS_LOG_STRICT"]
    else process.env["SENSUS_LOG_STRICT"] = prev.strict
    rmSync(dir, { recursive: true, force: true })
  }
}

const records = (path: string): LogRecord[] => readLogFile(path)

/** Keep the process-wide logger quiet (and file-free) during direct-route tests. */
const silentLogger = (): void => configureLogger({ level: "error", sink: () => {} })

describe("daemon structured logging: boot + records", () => {
  test("boot writes a daemon-component 'daemon started' info record", async () => {
    await withLoggedDaemon(async ({ logPath }) => {
      expect(existsSync(logPath)).toBe(true)
      const recs = records(logPath)
      const started = recs.find((r) => r.msg === "daemon started")
      expect(started).toBeDefined()
      expect(started?.level).toBe("info")
      expect(started?.component?.startsWith("daemon")).toBe(true)
      // The instanceId binding is the machine identity, and the boot facts ride
      // in attributes.
      expect(typeof started?.instanceId).toBe("string")
      expect(started?.attributes?.["socket"]).toBeString()
      expect(started?.attributes?.["persistent"]).toBe(false)
      // No prior daemon state suggested otherwise: the restart reason is clean.
      expect(started?.attributes?.["previous"]).toBe("clean")
    })
  })

  test("a boot with a stale prior daemon records the restart reason; stop records why it stopped", async () => {
    await withLoggedDaemon(
      async ({ logPath, result }) => {
        // The CLI passes the classified prior state; the boot record names it.
        result.stop("signal:SIGTERM")
        flushLoggerSync()
        const recs = records(logPath)
        const started = recs.find((r) => r.msg === "daemon started")
        expect(started?.attributes?.["previous"]).toBe("stale-pid")
        const stopping = recs.find((r) => r.msg === "daemon stopping")
        expect(stopping?.level).toBe("info")
        expect(stopping?.component?.startsWith("daemon")).toBe(true)
        expect(stopping?.attributes?.["reason"]).toBe("signal:SIGTERM")
        // stop() is idempotent: the withLoggedDaemon teardown must not emit a
        // second `daemon stopping` record.
        expect(recs.filter((r) => r.msg === "daemon stopping")).toHaveLength(1)
      },
      { SENSUS_LOG_LEVEL: "debug" },
      { previous: "stale-pid" },
    )
  })

  test("a routed failure writes an error-level record, and the boot token is redacted", async () => {
    await withLoggedDaemon(async ({ logPath, result }) => {
      // An unknown path is a NOT_FOUND → Elysia's onError boundary logs at
      // error. The request carries the bearer in the query string so
      // redaction-by-literal-value is actually exercised (the daemon
      // authenticates the header, but `request.url` in the record would
      // otherwise expose the query token).
      const res = await fetch(`http://127.0.0.1:${result.tcp.port}/v1/nope?token=${TOKEN}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(404)
      flushLoggerSync()

      const recs = records(logPath)
      const errRec = recs.find((r) => r.level === "error")
      expect(errRec).toBeDefined()
      expect(errRec?.msg).toBe("http request failed")
      expect(errRec?.component?.startsWith("daemon")).toBe(true)
      // The thrown error is serialized under the reserved `err` key.
      expect(errRec?.err?.message).toBeString()

      // The boot token never appears anywhere in the durable log.
      const text = records(logPath).map((r) => JSON.stringify(r)).join("\n")
      expect(text).not.toContain(TOKEN)
    })
  })
})

describe("daemon structured logging: strict-mode gate", () => {
  test("logStrictEnabled is true only for SENSUS_LOG_STRICT=1", () => {
    expect(logStrictEnabled({})).toBe(false)
    expect(logStrictEnabled({ SENSUS_LOG_STRICT: "0" })).toBe(false)
    expect(logStrictEnabled({ SENSUS_LOG_STRICT: "true" })).toBe(false)
    expect(logStrictEnabled({ SENSUS_LOG_STRICT: "1" })).toBe(true)
  })

  test("a throwing onWritten is soft without strict mode and surfaces a 500 with it", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-daemon-strict-"))
    const logPath = join(home, "daemon-log.jsonl")
    try {
      // A file logger proves the module-level `daemon.settings` logger resolves
      // the configured handle lazily (it is captured at import, before any
      // configureLogger call).
      configureLogger({ path: logPath, level: "debug" })
      const build = () =>
        new Elysia().use(
          settingsRoutes({
            home,
            config: () => ({}),
            onWritten: () => {
              throw new Error("reload exploded")
            },
          }),
        )
      const put = (): Promise<Response> =>
        build().handle(
          new Request("http://localhost/v1/config", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: { theme: "terminal" } }),
          }),
        )

      delete process.env["SENSUS_LOG_STRICT"]
      const soft = await put()
      // The write committed; the reload failure was logged and swallowed.
      expect(soft.status).toBe(200)

      process.env["SENSUS_LOG_STRICT"] = "1"
      const strict = await put()
      // Strict mode rethrows from onWritten; the route's outer catch → 500.
      expect(strict.status).toBe(500)
      expect(await strict.json()).toEqual({ error: "internal_error" })

      // The module-level `daemon.settings` logger routed both failures to the
      // configured file (a regression guard for the lazy-resolution helper).
      flushLoggerSync()
      const recs = records(logPath).filter((r) => r.msg === "onWritten config reload failed")
      expect(recs.length).toBe(2)
      expect(recs[0]?.level).toBe("error")
      expect(recs[0]?.component).toBe("daemon.settings")
    } finally {
      delete process.env["SENSUS_LOG_STRICT"]
      flushLoggerSync()
      silentLogger()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
