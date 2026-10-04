/**
 * McpRegistry tests (M11, docs/mcp.md): the REAL registry runs against the
 * mock stdio server (tests/mockMcpServer.ts) and an in-test streamable-HTTP
 * mock. Covers: lazy connect + initialize handshake, tools/list (incl.
 * pagination), tools/call round trip + isError, ${VAR}-expanded env reaching
 * the child, crash -> failed + dropped specs, call-timeout, wire-name
 * namespacing (incl. over-long names), restartChanged diffing and stopAll.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpRegistry, flattenContent, mcpRetryDelayMs, resolveMcpServerCwd } from "../../../../src/agent/mcp/registry.ts"
import { parseWireName, wireToolName } from "../../../../src/agent/mcp/types.ts"
import type { McpServerConfig } from "../../../../src/config/config.ts"

const MOCK = join(import.meta.dir, "../../../mocks/mockMcpServer.ts")

// Hermetic spawn dirs: stdio children now get a stable `<cache>/mcp/<server>`
// cwd, so point SENSUS_CACHE_DIR at a temp dir for the whole file — nothing is
// ever written to the real ~/.cache.
let mcpCacheDir = ""
const prevCacheDir = process.env["SENSUS_CACHE_DIR"]
beforeAll(() => {
  mcpCacheDir = mkdtempSync(join(tmpdir(), "sensus-mcp-cache-"))
  process.env["SENSUS_CACHE_DIR"] = mcpCacheDir
})
afterAll(() => {
  if (prevCacheDir === undefined) delete process.env["SENSUS_CACHE_DIR"]
  else process.env["SENSUS_CACHE_DIR"] = prevCacheDir
  rmSync(mcpCacheDir, { recursive: true, force: true })
})

const stdioServer = (mode?: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: process.execPath, // bun
  args: mode !== undefined ? [MOCK, mode] : [MOCK],
  enabled: true,
  timeoutS: 15,
  ...extra,
})

// ---- pure name helpers -------------------------------------------------------

describe("pure helpers", () => {
  test("wire names: namespaced + round-trip, non-mcp names rejected, sanitized + capped at 64 with a stable suffix", () => {
    const w = wireToolName("playwright", "browser_navigate")
    expect(w).toBe("mcp__playwright__browser_navigate")
    expect(parseWireName(w)).toEqual({ server: "playwright", tool: "browser_navigate" })
    expect(parseWireName("run_command")).toBeNull()
    expect(parseWireName("mcp__")).toBeNull()
    expect(parseWireName("mcp__server_only")).toBeNull()
    const long = wireToolName("my server", "a".repeat(80))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long.startsWith("mcp__my_server__")).toBe(true)
    expect(wireToolName("my server", "a".repeat(80))).toBe(long) // stable
    expect(parseWireName(long)).not.toBeNull()
  })

  test("flattenContent: text joined, non-text noted, null-safe", () => {
    expect(flattenContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb")
    expect(flattenContent([{ type: "image", mimeType: "image/png" }])).toBe("[image block: image/png]")
    expect(flattenContent(undefined)).toBe("")
    expect(flattenContent([{ type: "text", text: "x" }, { type: "resource", resource: { uri: "file:///r" } }])).toBe(
      "x\n[resource block: file:///r]",
    )
  })

  test("mcpRetryDelayMs: bounded exponential backoff (1-based failures)", () => {
    expect(mcpRetryDelayMs(0, { baseMs: 1000, capMs: 8000 })).toBe(1000)
    expect(mcpRetryDelayMs(1, { baseMs: 1000, capMs: 8000 })).toBe(1000)
    expect(mcpRetryDelayMs(2, { baseMs: 1000, capMs: 8000 })).toBe(2000)
    expect(mcpRetryDelayMs(3, { baseMs: 1000, capMs: 8000 })).toBe(4000)
    expect(mcpRetryDelayMs(4, { baseMs: 1000, capMs: 8000 })).toBe(8000)
    expect(mcpRetryDelayMs(40, { baseMs: 1000, capMs: 8000 })).toBe(8000)
  })
})

// ---- stdio end-to-end ---------------------------------------------------------

describe("McpRegistry over stdio", () => {
  test("lazy connect -> specs -> call round trip -> isError -> unknown server", async () => {
    const reg = new McpRegistry({ servers: { t: stdioServer() } })
    const failures = await reg.ensureReady({ servers: { t: stdioServer() } }, new AbortController().signal)
    expect(failures).toEqual([])

    const specs = reg.currentSpecs()
    const names = specs.map((s) => s.function.name)
    expect(names).toContain("mcp__t__echo")
    expect(names).toContain("mcp__t__fail")
    const echo = specs.find((s) => s.function.name === "mcp__t__echo")
    expect(echo?.function.parameters).toMatchObject({ type: "object" })
    expect(echo?.function.description).toContain("Echo")

    const ok = await reg.call("mcp__t__echo", { text: "hi" }, new AbortController().signal)
    expect(ok).toEqual({ ok: true, result: "ECHO:hi" })

    const bad = await reg.call("mcp__t__fail", {}, new AbortController().signal)
    expect(bad.ok).toBe(false)
    expect(bad.result).toContain("boom")

    const missing = await reg.call("mcp__nope__x", {}, new AbortController().signal)
    expect(missing.ok).toBe(false)
    expect(missing.result).toContain("not configured")

    const facts = reg.connectedServerFacts()
    expect(facts).toEqual([{ name: "t", tools: expect.arrayContaining(["echo", "fail"]) }])
    await reg.stopAll()
  })

  test("config env reaches the child process; tools/list pagination is followed", async () => {
    // Env: ${VAR}-expanded env vars land in the child.
    const envCfg = { servers: { e: stdioServer("env", { env: { MCP_MOCK_ENV: "expanded-value" } }) } }
    const envReg = new McpRegistry(envCfg)
    expect(await envReg.ensureReady(envCfg, new AbortController().signal)).toEqual([])
    const r = await envReg.call("mcp__e__envecho", {}, new AbortController().signal)
    expect(r.ok).toBe(true)
    expect(r.result).toBe("ENV=expanded-value")
    await envReg.stopAll()
    // Pagination: a paged tools/list still surfaces every tool.
    const pagedCfg = { servers: { p: stdioServer("paged") } }
    const pagedReg = new McpRegistry(pagedCfg)
    expect(await pagedReg.ensureReady(pagedCfg, new AbortController().signal)).toEqual([])
    const names = pagedReg.currentSpecs().map((s) => s.function.name)
    expect(names).toContain("mcp__p__echo")
    expect(names).toContain("mcp__p__fail")
    await pagedReg.stopAll()
  })

  test("failure modes: crashed server -> failed + specs dropped; slow server honors timeout_s; disabled server is skipped", async () => {
    // Crash.
    const crashCfg = { servers: { c: stdioServer("crash") } }
    const crashReg = new McpRegistry(crashCfg)
    const failures = await crashReg.ensureReady(crashCfg, new AbortController().signal)
    expect(failures.length).toBe(1)
    expect(failures[0]).toContain("c:")
    expect(crashReg.currentSpecs()).toEqual([])
    expect(crashReg.statusLines()[0]).toContain("c: failed")
    await crashReg.stopAll()
    // Slow -> call timeout surfaces as a failure.
    const slowCfg = { servers: { s: stdioServer("slow", { timeoutS: 1 }) } }
    const slowReg = new McpRegistry(slowCfg)
    const slowFailures = await slowReg.ensureReady(slowCfg, new AbortController().signal)
    expect(slowFailures[0]).toContain("timed out")
    await slowReg.stopAll()
    // Disabled: skipped entirely, no specs, status says so.
    const disabledCfg = { servers: { d: stdioServer("crash", { enabled: false }) } }
    const disabledReg = new McpRegistry(disabledCfg)
    expect(await disabledReg.ensureReady(disabledCfg, new AbortController().signal)).toEqual([])
    expect(disabledReg.currentSpecs()).toEqual([])
    expect(disabledReg.statusLines()[0]).toContain("disabled")
    await disabledReg.stopAll()
  })

  test("statusVersion bumps across connect/fail/stop and serverStatuses reports per-server facts", async () => {
    const cfg = {
      servers: { t: stdioServer(), c: stdioServer("crash"), d: stdioServer("crash", { enabled: false }) },
    }
    const reg = new McpRegistry(cfg)
    const before = reg.statusVersion()
    const failures = await reg.ensureReady(cfg, new AbortController().signal)
    expect(failures.length).toBe(1)
    // A connect attempt + a failure happened, so the reactive version advanced.
    expect(reg.statusVersion()).toBeGreaterThan(before)
    const byName = Object.fromEntries(reg.serverStatuses().map((f) => [f.name, f]))
    expect(byName["t"]).toEqual({ name: "t", status: "connected", toolCount: 2 })
    expect(byName["c"]?.status).toBe("failed")
    expect(byName["c"]?.toolCount).toBe(0)
    expect(byName["d"]).toEqual({ name: "d", status: "disabled", toolCount: 0 })

    const live = reg.statusVersion()
    await reg.stopAll()
    expect(reg.statusVersion()).toBeGreaterThan(live)
    expect(reg.serverStatuses().every((f) => f.status === "idle")).toBe(true)
  })

  test("restartChanged diffs and drops the old connection", async () => {
    const cfgA = { servers: { t: stdioServer() } }
    const reg = new McpRegistry(cfgA)
    await reg.ensureReady(cfgA, new AbortController().signal)
    expect(reg.currentSpecs().length).toBe(2)

    const cfgB = { servers: { t: stdioServer("env") } }
    const vBefore = reg.statusVersion()
    const changes = await reg.restartChanged(cfgB)
    expect(changes).toContain("mcp t: restarted (config changed)")
    // /reload rebuilt the conn table, so the status bar's version advanced.
    expect(reg.statusVersion()).toBeGreaterThan(vBefore)
    // Old conn is gone; the new one reconnects lazily.
    expect(await reg.ensureReady(cfgB, new AbortController().signal)).toEqual([])
    expect(reg.currentSpecs().map((s) => s.function.name)).toContain("mcp__t__envecho")

    const removed = await reg.restartChanged({ servers: {} })
    expect(removed).toContain("mcp t: removed")
    await reg.stopAll()
  })

  test("restartChanged reads an enabled flip as on/off, not a generic restart (MCP manager toggle)", async () => {
    const cfgOn = { servers: { t: stdioServer() } }
    const reg = new McpRegistry(cfgOn)
    await reg.ensureReady(cfgOn, new AbortController().signal)
    expect(reg.currentSpecs().length).toBe(2)

    const off = await reg.restartChanged({ servers: { t: stdioServer(undefined, { enabled: false }) } })
    expect(off).toContain("mcp t: disabled")
    expect(reg.serverStatuses()).toEqual([{ name: "t", status: "disabled", toolCount: 0 }])
    expect(reg.currentSpecs()).toEqual([])

    const on = await reg.restartChanged(cfgOn)
    expect(on).toContain("mcp t: enabled")
    expect(reg.serverStatuses()).toEqual([{ name: "t", status: "idle", toolCount: 0 }])
    await reg.stopAll()
  })

  test("stopAll REAPS the stdio child (shutdown must not orphan servers)", async () => {
    const cfg = { servers: { t: stdioServer() } }
    const reg = new McpRegistry(cfg)
    await reg.ensureReady(cfg, new AbortController().signal)
    expect(reg.statusLines()[0]).toContain("connected")
    const started = Date.now()
    await reg.stopAll()
    // Deterministic close: returns bounded, and the server process is gone.
    expect(Date.now() - started).toBeLessThan(5000)
    await Bun.sleep(150)
    const strays = Bun.spawnSync(["sh", "-c", "pgrep -f '[m]ockMcpServer' || true"], { stdout: "pipe" })
      .stdout.toString()
      .trim()
    expect(strays).toBe("")
  })

  test("a rejecting transport close never leaks an unhandled rejection (remove/replace paths)", async () => {
    // rebuildConns fires `void this.stopConn(conn)` on a removed/changed server,
    // and stopConn awaits transport.close() — which a transport may reject.
    // Nothing owns that promise, so a leak would reach Bun's fatal default.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on("unhandledRejection", onRejection)
    try {
      const cfg = { servers: { remove: stdioServer(), replace: stdioServer(), keep: stdioServer() } }
      const reg = new McpRegistry(cfg)
      const conns = (
        reg as unknown as { conns: Map<string, { transport: { close(): Promise<void> } | null; status: string }> }
      ).conns
      const rejecting = { close: (): Promise<void> => Promise.reject(new Error("close boom")) }
      for (const name of ["remove", "replace", "keep"]) {
        const conn = conns.get(name)
        expect(conn?.transport).toBeNull() // idle: never connected, no child spawned
        if (conn) {
          conn.transport = rejecting
          conn.status = "connected" // so the replace path reads as a config-change restart
        }
      }

      // restartChanged: `remove` is dropped, `replace` differs, `keep` is untouched.
      const removed = await reg.restartChanged({ servers: { replace: stdioServer("env"), keep: stdioServer() } })
      expect(removed).toContain("mcp remove: removed")
      expect(removed).toContain("mcp replace: restarted (config changed)")

      // ensureReady's config diff removes both survivors too.
      await reg.ensureReady({ servers: {} }, new AbortController().signal)
      expect(reg.serverStatuses()).toEqual([])

      await Bun.sleep(50)
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
    }
  })
})

// ---- stdio spawn cwd ----------------------------------------------------------

describe("stdio spawn cwd", () => {
  test("resolveMcpServerCwd: explicit wins, relative resolves under home, default is per-server cache, uncreatable falls back to tmpdir", () => {
    const homeDir = join(tmpdir(), "sensus-home-x")
    const cfg: McpServerConfig = { command: "run", enabled: true, timeoutS: 60 }

    expect(resolveMcpServerCwd("s", { ...cfg, cwd: "/abs/scratch" }, { cacheRoot: "/c", homeDir })).toEqual({
      cwd: "/abs/scratch",
    })
    expect(resolveMcpServerCwd("s", { ...cfg, cwd: "scratch" }, { cacheRoot: "/c", homeDir })).toEqual({
      cwd: join(homeDir, "scratch"),
    })

    const root = mkdtempSync(join(tmpdir(), "sensus-cwd-root-"))
    try {
      const def = resolveMcpServerCwd("playwright", cfg, { cacheRoot: root, homeDir })
      expect(def.cwd).toBe(join(root, "mcp", "playwright"))
      expect(existsSync(def.cwd)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    const bad = resolveMcpServerCwd("s", cfg, {
      cacheRoot: "/c",
      homeDir,
      mkdir: () => {
        throw new Error("nope")
      },
    })
    expect(bad.cwd).toBe(tmpdir())
    expect(bad.warning).toContain('mcp server "s"')
  })

  test("e2e: a stdio child gets the per-server cache dir by default; an explicit cwd wins", async () => {
    const cfg = { servers: { c: stdioServer("cwd") } }
    const reg = new McpRegistry(cfg)
    expect(await reg.ensureReady(cfg, new AbortController().signal)).toEqual([])
    const r = await reg.call("mcp__c__pwd", {}, new AbortController().signal)
    expect(r.ok).toBe(true)
    expect(r.result.trim()).toBe(`CWD=${join(mcpCacheDir, "mcp", "c")}`)
    await reg.stopAll()

    const explicit = mkdtempSync(join(tmpdir(), "sensus-mcp-cwd-"))
    try {
      const cfg2 = { servers: { c: stdioServer("cwd", { cwd: explicit }) } }
      const reg2 = new McpRegistry(cfg2)
      expect(await reg2.ensureReady(cfg2, new AbortController().signal)).toEqual([])
      const r2 = await reg2.call("mcp__c__pwd", {}, new AbortController().signal)
      expect(r2.ok).toBe(true)
      expect(r2.result.trim()).toBe(`CWD=${explicit}`)
      await reg2.stopAll()
    } finally {
      rmSync(explicit, { recursive: true, force: true })
    }
  })

  test("restartChanged: a cwd-only change counts as a config change", async () => {
    const cfgA = { servers: { t: stdioServer() } }
    const reg = new McpRegistry(cfgA)
    await reg.ensureReady(cfgA, new AbortController().signal)
    const cfgB = { servers: { t: stdioServer(undefined, { cwd: join(mcpCacheDir, "explicit") }) } }
    const changes = await reg.restartChanged(cfgB)
    expect(changes).toContain("mcp t: restarted (config changed)")
    await reg.stopAll()
  })
})

// ---- streamable HTTP end-to-end -----------------------------------------------

describe("McpRegistry over streamable HTTP", () => {
  let port = 0
  let server: ReturnType<typeof Bun.serve> | null = null
  const seenAuth: string[] = []
  const seenSessions: Array<string | null> = []
  let sessionIssued = "sess-123"

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })
        if (req.method === "DELETE") return new Response(null, { status: 204 }) // session close
        seenAuth.push(req.headers.get("authorization") ?? "")
        seenSessions.push(req.headers.get("mcp-session-id"))
        const raw = await req.text()
        const body = (raw.length > 0 ? JSON.parse(raw) : {}) as {
          id?: number | string
          method?: string
          params?: Record<string, unknown>
        }
        const headers: Record<string, string> = { "content-type": "application/json" }
        if (body.method === "initialize") {
          headers["mcp-session-id"] = sessionIssued
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "mock-http", version: "2.0" },
              },
            }),
            { headers },
          )
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  { name: "search", description: "Web search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
                ],
              },
            }),
            { headers },
          )
        }
        if (body.method === "tools/call") {
          const args = (body.params?.["arguments"] ?? {}) as Record<string, unknown>
          const q = String(args["q"] ?? "")
          // Answer over SSE (streamable-HTTP servers may choose either form).
          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `HTTP-RESULT:${q}` }] },
          })
          const sse = `: ping\n\nevent: message\ndata: ${payload}\n\n`
          return new Response(sse, { headers: { "content-type": "text/event-stream" } })
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }), { headers })
      },
    })
    port = server?.port ?? 0
  })

  afterAll(() => {
    server?.stop(true)
  })

  const httpCfg = (timeoutS = 15, path = "/mcp"): { servers: Record<string, McpServerConfig> } => ({
    servers: {
      firecrawl: {
        url: `http://127.0.0.1:${port}${path}`,
        headers: { Authorization: "Bearer test-key" },
        enabled: true,
        timeoutS,
      },
    },
  })

  test("connect, list, call over JSON and SSE with auth/session headers; HTTP error status surfaces as a failure", async () => {
    const reg = new McpRegistry(httpCfg())
    expect(await reg.ensureReady(httpCfg(), new AbortController().signal)).toEqual([])
    expect(seenAuth.every((a) => a === "Bearer test-key")).toBe(true)
    // The initialize response's session id is echoed on later requests.
    expect(seenSessions[seenSessions.length - 1]).toBe("sess-123")

    expect(reg.currentSpecs().map((s) => s.function.name)).toEqual(["mcp__firecrawl__search"])
    const r = await reg.call("mcp__firecrawl__search", { q: "sensus" }, new AbortController().signal)
    expect(r.ok).toBe(true)
    expect(r.result).toBe("HTTP-RESULT:sensus")

    const facts = reg.connectedServerFacts()
    expect(facts[0]?.name).toBe("firecrawl")
    await reg.stopAll()
    // A non-/mcp endpoint 404s -> the failure surfaces (HTTP 404) instead of hanging.
    const badReg = new McpRegistry(httpCfg(5, "/wrong"))
    const failures = await badReg.ensureReady(httpCfg(5, "/wrong"), new AbortController().signal)
    expect(failures.length).toBe(1)
    expect(failures[0]).toContain("HTTP 404")
    await badReg.stopAll()
  })

  test("a transient first-connect failure is retried after a bounded backoff instead of being skipped forever", async () => {
    let initializes = 0
    const flaky = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = (await req.text().then((t) => (t.length > 0 ? JSON.parse(t) : {}))) as {
          id?: unknown
          method?: string
        }
        const headers = { "content-type": "application/json" }
        if (body.method === "initialize") {
          initializes++
          if (initializes === 1) return new Response("boom", { status: 500 })
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "flaky" } },
            }),
            { headers },
          )
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] } }),
            { headers },
          )
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }), { headers })
      },
    })
    const url = `http://127.0.0.1:${flaky.port}/mcp`
    const cfg = { servers: { f: { url, enabled: true, timeoutS: 5 } } }
    const reg = new McpRegistry(cfg, { retryBaseMs: 300, retryCapMs: 300 })
    try {
      const first = await reg.ensureReady(cfg, new AbortController().signal)
      expect(first.length).toBe(1)
      expect(first[0]).toContain("f:")
      expect(reg.currentSpecs()).toEqual([])
      expect(initializes).toBe(1)
      // Immediately again: still inside the backoff window -> skipped lazily,
      // no hammering.
      expect(await reg.ensureReady(cfg, new AbortController().signal)).toEqual([])
      expect(initializes).toBe(1)
      // After the backoff elapses the server self-heals and its tools return.
      await Bun.sleep(350)
      expect(await reg.ensureReady(cfg, new AbortController().signal)).toEqual([])
      expect(initializes).toBe(2)
      expect(reg.currentSpecs().map((s) => s.function.name)).toContain("mcp__f__ping")
    } finally {
      await reg.stopAll()
      flaky.stop(true)
    }
  })
})
