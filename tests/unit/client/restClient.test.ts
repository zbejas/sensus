/**
 * restClient — typed REST against the daemon's Unix socket (P4b;
 * docs/daemon-api.md "Routes").
 *
 * Drives a real daemon over UDS: health/info/config and the read-only resources,
 * plus the typed failures (401 unauthorized, unreachable, 404 not_found).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RestClient, RestClientError } from "../../../src/client/restClient.ts"
import { startTestDaemon } from "./support.ts"

describe("restClient: real daemon over UDS", () => {
  test("health/info/config and the read-only resources", async () => {
    const daemon = await startTestDaemon({ config: () => ({ model: "test-model", sidebarWidth: 40 }) })
    const rest = new RestClient({ runtimeDir: daemon.runtime, token: daemon.token })
    try {
      const health = await rest.health()
      expect(health.ok).toBe(true)
      expect(health.name).toBe("sensus-daemon")
      expect(typeof health.version).toBe("string")

      const info = await rest.info()
      expect(info.ok).toBe(true)
      expect(info.pid).toBeGreaterThan(0)
      expect(info.tcp.port).toBe(daemon.result.tcp.port)
      expect(info.shells).toBe(0)

      const config = await rest.config()
      expect(config).toEqual({ ok: true, config: { model: "test-model", sidebarWidth: 40 } })

      const agents = await rest.agents()
      expect(agents.ok).toBe(true)
      expect(Array.isArray(agents.agents)).toBe(true)
      expect(Array.isArray(agents.warnings)).toBe(true)

      const skills = await rest.skills()
      expect(skills.ok).toBe(true)
      expect(Array.isArray(skills.skills)).toBe(true)

      const memory = await rest.memory()
      expect(memory.ok).toBe(true)
      expect(memory.targets.map((t) => t.target)).toEqual(["memory", "host", "journal"])

      const memoryRead = await rest.memoryTarget("memory")
      expect(memoryRead.ok).toBe(true)
      expect(memoryRead.target).toBe("memory")
      expect(typeof memoryRead.content).toBe("string")
      expect(memoryRead.usage.target).toBe("memory")

      const sessions = await rest.sessions()
      expect(sessions.ok).toBe(true)
      expect(Array.isArray(sessions.sessions)).toBe(true)

      const audit = await rest.audit()
      expect(audit.ok).toBe(true)
      expect(Array.isArray(audit.records)).toBe(true)

      const stats = await rest.auditStats()
      expect(stats.ok).toBe(true)
      expect(typeof stats.total).toBe("number")
    } finally {
      daemon.cleanup()
    }
  }, 30000)

  test("probeModels posts a DRAFT endpoint (provider/baseURL/apiKey) and returns its listed models", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = []
    const draft = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        requests.push({
          url: `${url.pathname}${url.search}`,
          headers: {
            authorization: req.headers.get("authorization") ?? "",
            "x-api-key": req.headers.get("x-api-key") ?? "",
          },
        })
        return new Response(JSON.stringify({ data: [{ id: "claude-draft", display_name: "Claude Draft" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })
    // Sandbox the daemon's models.dev cache so probe enrichment never fetches.
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-client-cache-"))
    writeFileSync(join(cacheDir, "models-dev.json"), JSON.stringify({ fetchedAt: Date.now(), providers: {} }))
    const priorCacheDir = process.env["SENSUS_CACHE_DIR"]
    process.env["SENSUS_CACHE_DIR"] = cacheDir
    const daemon = await startTestDaemon()
    try {
      const rest = new RestClient({ runtimeDir: daemon.runtime, token: daemon.token })
      const res = await rest.probeModels({
        provider: "anthropic",
        baseURL: `http://127.0.0.1:${draft.port}/v1`,
        apiKey: "sk-draft-key",
      })
      expect(res.ok).toBe(true)
      expect(res.error).toBeNull()
      expect(res.models.map((m) => m.id)).toEqual(["claude-draft"])
      // The daemon listed the draft over the anthropic wire, so the client's
      // body fields (provider/baseURL/apiKey) all traveled.
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe("/v1/models?limit=1000")
      expect(requests[0]?.headers["x-api-key"]).toBe("sk-draft-key")
      expect(requests[0]?.headers["authorization"]).toBe("")
      // The key is never echoed back to the client.
      expect(JSON.stringify(res)).not.toContain("sk-draft-key")
    } finally {
      daemon.cleanup()
      draft.stop(true)
      if (priorCacheDir === undefined) delete process.env["SENSUS_CACHE_DIR"]
      else process.env["SENSUS_CACHE_DIR"] = priorCacheDir
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }, 30000)

  test("a wrong token is a typed 401; a dead runtime dir is unreachable", async () => {
    const daemon = await startTestDaemon()
    try {
      const wrong = new RestClient({ runtimeDir: daemon.runtime, token: "not-the-token", timeoutMs: 2000 })
      await expect(wrong.health()).rejects.toMatchObject({ code: "unauthorized", status: 401 })

      const dead = mkdtempSync(join(tmpdir(), "sensus-client-dead-"))
      try {
        const noDaemon = new RestClient({ runtimeDir: dead, token: "x", timeoutMs: 1500 })
        await expect(noDaemon.health()).rejects.toBeInstanceOf(RestClientError)
        await expect(noDaemon.health()).rejects.toMatchObject({ code: "unreachable", status: 0 })
      } finally {
        rmSync(dead, { recursive: true, force: true })
      }

      // A well-formed path with a missing session is a typed 404.
      await expect(rest(daemon).sessionExport("missing-instance", "missing-base", "md")).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      })
    } finally {
      daemon.cleanup()
    }
  }, 30000)
})

/** A correctly-authenticated client for the given daemon. */
function rest(daemon: { runtime: string; token: string }): RestClient {
  return new RestClient({ runtimeDir: daemon.runtime, token: daemon.token })
}
