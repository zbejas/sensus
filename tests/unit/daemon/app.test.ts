/**
 * Daemon app (docs/daemon-api.md): bearer auth on every route, the health/info
 * payloads, the redacted-config resource, the read-only agents/skills listings,
 * 404/500 JSON errors, and the guarantee that a malformed request never throws.
 * Transport-independent — driven with `app.handle`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore, NoopEventSink, SessionFile, sessionFilePath, defaultConfig, defaultEndpoint } from "../../../src/engine/index.ts"
import type { ModelOverride } from "../../../src/engine/index.ts"
import {
  applyConfigPatch,
  bearerFrom,
  buildModelCatalog,
  buildUsageReport,
  createDaemonApp,
  endpointHasKey,
  mergeConfigPatch,
  probeEndpointModels,
  safeEqual,
  type DaemonInfo,
} from "../../../src/daemon/index.ts"

const TOKEN = "0123456789abcdef0123456789abcdef"

function makeInfo(): DaemonInfo {
  return {
    ok: true,
    name: "sensus-daemon",
    version: "9.9.9",
    pid: 4242,
    platform: "linux",
    startedAt: 1_000_000,
    uptimeMs: 1234,
    socket: "/run/user/1000/sensus-1000/daemon.sock",
    tcp: { host: "127.0.0.1", port: 54321 },
    shells: 0,
    persistent: false,
    instance: { instanceId: "test-instance", createdAt: 1, version: "9.9.9" },
  }
}

function makeApp(over: Partial<Parameters<typeof createDaemonApp>[0]> = {}) {
  const memory = (): MemoryStore =>
    new MemoryStore({ dir: "/nonexistent-sensus-daemon-test", limits: { memory: 1, host: 1, journal: 1 } })
  return createDaemonApp({
    token: TOKEN,
    version: "9.9.9",
    info: makeInfo,
    memory,
    events: new NoopEventSink(),
    config: () => ({ theme: "terminal", endpoints: { main: { apiKey: "<redacted>" } } }),
    ...over,
  })
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe("daemon app: bearer auth", () => {
  test("401 without a token, with a wrong token, and with a malformed header", async () => {
    const app = makeApp()
    for (const headers of [{}, auth("nope"), { authorization: "Basic x" }, { authorization: "Bearer" }]) {
      const res = await app.handle(new Request("http://localhost/v1/health", { headers }))
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toBe("Bearer")
      expect(await res.json()).toEqual({ error: "unauthorized" })
    }
  })

  test("200 with the right token on health and info", async () => {
    const app = makeApp()
    const health = await app.handle(new Request("http://localhost/v1/health", { headers: auth(TOKEN) }))
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, name: "sensus-daemon", version: "9.9.9" })

    const info = await app.handle(new Request("http://localhost/v1/info", { headers: auth(TOKEN) }))
    expect(info.status).toBe(200)
    expect(await info.json()).toEqual(makeInfo())
  })

  test("config/agents/skills respond and are auth-gated", async () => {
    const app = makeApp()
    const cfg = await app.handle(new Request("http://localhost/v1/config", { headers: auth(TOKEN) }))
    expect(cfg.status).toBe(200)
    expect(await cfg.json()).toEqual({ ok: true, config: { theme: "terminal", endpoints: { main: { apiKey: "<redacted>" } } } })

    for (const path of ["/v1/config", "/v1/agents", "/v1/skills"]) {
      const denied = await app.handle(new Request(`http://localhost${path}`))
      expect(denied.status).toBe(401)
    }
  })

  test("unknown route is 404 JSON, and malformed requests never throw", async () => {
    const app = makeApp()
    const missing = await app.handle(new Request("http://localhost/v1/nope", { headers: auth(TOKEN) }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "not_found" })

    // Odd methods / unparseable bodies must surface as a JSON status, not a throw.
    for (const init of [
      { method: "POST", body: "{ not json", headers: { ...auth(TOKEN), "content-type": "application/json" } },
      { method: "DELETE", headers: auth(TOKEN) },
      { method: "OPTIONS", headers: {} },
    ] satisfies RequestInit[]) {
      const res = await app.handle(new Request("http://localhost/v1/health", init))
      expect(res.status).toBeGreaterThanOrEqual(200)
      expect(res.headers.get("content-type")).toContain("application/json")
    }
  })
})

describe("daemon agents/skills listings", () => {
  test("read-only listings project name/description from the config home", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-daemon-catalog-"))
    try {
      mkdirSync(join(home, "agents"), { recursive: true })
      writeFileSync(
        join(home, "agents", "critic.md"),
        "---\nname: critic\ndescription: reviews code\n---\nYou are a critic.\n",
        "utf8",
      )
      mkdirSync(join(home, "skills", "deploy"), { recursive: true })
      writeFileSync(join(home, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ship it\n---\nSteps.\n", "utf8")

      const app = makeApp({ home })
      const agents = (await (await app.handle(new Request("http://localhost/v1/agents", { headers: auth(TOKEN) }))).json()) as {
        ok: boolean
        agents: Array<{ name: string; description: string }>
      }
      expect(agents.ok).toBe(true)
      expect(agents.agents.map((a) => a.name)).toContain("critic")
      expect(agents.agents.find((a) => a.name === "critic")?.description).toBe("reviews code")

      const skills = (await (await app.handle(new Request("http://localhost/v1/skills", { headers: auth(TOKEN) }))).json()) as {
        ok: boolean
        skills: Array<{ name: string; description: string }>
      }
      expect(skills.ok).toBe(true)
      expect(skills.skills.map((s) => s.name)).toContain("deploy")
      expect(skills.skills.find((s) => s.name === "deploy")?.description).toBe("ship it")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("daemon auth helpers", () => {
  test("bearerFrom parses only well-formed Bearer headers", () => {
    expect(bearerFrom("Bearer abc")).toBe("abc")
    expect(bearerFrom("bearer   abc")).toBe("abc")
    expect(bearerFrom("  Bearer abc  ")).toBe("abc")
    expect(bearerFrom("Basic abc")).toBeNull()
    expect(bearerFrom("Bearer")).toBeNull()
    expect(bearerFrom("")).toBeNull()
    expect(bearerFrom(null)).toBeNull()
    expect(bearerFrom(undefined)).toBeNull()
  })

  test("safeEqual compares equal strings and refuses unequal lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
    expect(safeEqual("", "")).toBe(true)
  })
})

// -- P4c-ii: engine-free read + write resources ------------------------------

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { ...auth(TOKEN), "content-type": "application/json", ...extra },
})

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "sensus-daemon-settings-"))
}

function writeConfigFile(home: string, doc: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, "config.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf8")
}

function readConfigFile(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>
}

describe("daemon resources (P4c-ii)", () => {
  test("/v1/mcp returns live status facts and is auth-gated", async () => {
    const servers = [
      { name: "playwright", status: "connected" as const, toolCount: 2 },
      { name: "firecrawl", status: "disabled" as const, toolCount: 0 },
    ]
    const app = makeApp({ mcp: () => servers })
    const res = await app.handle(new Request("http://localhost/v1/mcp", { headers: auth(TOKEN) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, servers })

    const denied = await app.handle(new Request("http://localhost/v1/mcp"))
    expect(denied.status).toBe(401)
  })

  test("/v1/models returns the catalog; a throwing builder is a 500", async () => {
    const catalog = {
      endpoints: [
        {
          name: "main",
          baseURL: "https://api.example/v1",
          provider: "http",
          hasKey: true,
          models: [{ id: "gpt-5", ownedBy: "openai", endpointTypes: [], chat: true, meta: null }],
        },
      ],
      errors: ["backup: HTTP 503"],
    }
    const app = makeApp({ models: async () => catalog })
    const res = await app.handle(new Request("http://localhost/v1/models", { headers: auth(TOKEN) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ...catalog })

    const broken = makeApp({
      models: async () => {
        throw new Error("boom")
      },
    })
    const err = await broken.handle(new Request("http://localhost/v1/models", { headers: auth(TOKEN) }))
    expect(err.status).toBe(500)
    expect(await err.json()).toEqual({ error: "internal_error" })
  })

  test("POST /v1/models/probe runs the injected probe, is auth-gated, rejects a non-object body, and never echoes the draft key", async () => {
    const seen: Array<Record<string, unknown>> = []
    const models = [{ id: "draft-model", ownedBy: null, endpointTypes: [], chat: true, meta: null }]
    const app = makeApp({
      probeModels: async (input) => {
        seen.push(input as Record<string, unknown>)
        return { models, error: null }
      },
    })
    const res = await app.handle(
      new Request("http://localhost/v1/models/probe", {
        method: "POST",
        headers: { ...auth(TOKEN), "content-type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          baseURL: "https://api.anthropic.test/v1",
          apiKey: "sk-secret-draft-key",
        }),
      }),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain("sk-secret-draft-key")
    expect(JSON.parse(text)).toEqual({ ok: true, models, error: null })
    expect(seen).toEqual([
      { provider: "anthropic", baseURL: "https://api.anthropic.test/v1", apiKey: "sk-secret-draft-key" },
    ])

    // Auth-gated like every route.
    const denied = await app.handle(new Request("http://localhost/v1/models/probe", { method: "POST" }))
    expect(denied.status).toBe(401)

    // A non-object JSON body (array/scalar) is an explicit 400; malformed JSON
    // falls through to the onError 400.
    for (const body of ["[1,2]", '"nope"']) {
      const bad = await app.handle(
        new Request("http://localhost/v1/models/probe", {
          method: "POST",
          headers: { ...auth(TOKEN), "content-type": "application/json" },
          body,
        }),
      )
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: "invalid_request" })
    }
    const malformed = await app.handle(
      new Request("http://localhost/v1/models/probe", {
        method: "POST",
        headers: { ...auth(TOKEN), "content-type": "application/json" },
        body: "{ not json",
      }),
    )
    expect(malformed.status).toBe(400)

    // A throwing probe is a 500 — and the key is not in the response.
    const broken = makeApp({
      probeModels: async () => {
        throw new Error(`boom sk-secret-draft-key`)
      },
    })
    const err = await broken.handle(
      new Request("http://localhost/v1/models/probe", {
        method: "POST",
        headers: { ...auth(TOKEN), "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-secret-draft-key" }),
      }),
    )
    expect(err.status).toBe(500)
    const errText = await err.text()
    expect(errText).not.toContain("sk-secret-draft-key")
    expect(JSON.parse(errText)).toEqual({ error: "internal_error" })
  })

  test("probeEndpointModels: protocol default baseURL + auth header, draft failure degrades to {models:[],error} without the key", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-probe-cache-"))
    try {
      const cachePath = join(cacheDir, "models-dev.json")
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), providers: {} }))
      const calls: Array<{ url: string; headers: Record<string, string> }> = []
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v)
        calls.push({ url: String(url), headers })
        return new Response(JSON.stringify({ data: [{ id: "claude-draft", display_name: "Claude Draft" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch

      // Empty baseURL resolves to the anthropic protocol default.
      const res = await probeEndpointModels({ provider: "anthropic", baseURL: "", apiKey: "sk-draft" }, { fetchImpl, cachePath })
      expect(res.error).toBeNull()
      expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000")
      expect(calls[0]?.headers["x-api-key"]).toBe("sk-draft")
      expect(res.models[0]?.id).toBe("claude-draft")

      // An unreachable draft is {models:[], error}, never a throw — and the key
      // never appears in the payload.
      const fail = (async () => {
        throw new Error("connect refused")
      }) as unknown as typeof fetch
      const bad = await probeEndpointModels(
        { provider: "openai-compatible", baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-secret-draft-key" },
        { fetchImpl: fail, cachePath },
      )
      expect(bad.models).toEqual([])
      expect(bad.error).not.toBeNull()
      expect(JSON.stringify(bad)).not.toContain("sk-secret-draft-key")
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("probeEndpointModels expands ${NAME} apiKey refs like config resolution", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-probe-ref-"))
    const prev = process.env["SENSUS_PROBE_REF_KEY"]
    process.env["SENSUS_PROBE_REF_KEY"] = "resolved-probe-key"
    try {
      const cachePath = join(cacheDir, "models-dev.json")
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), providers: {} }))
      const calls: Array<Record<string, string>> = []
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v)
        }
        calls.push(headers)
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch

      const res = await probeEndpointModels(
        {
          provider: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
          apiKey: "${SENSUS_PROBE_REF_KEY}",
        },
        { fetchImpl, cachePath },
      )
      expect(res.error).toBeNull()
      expect(calls[0]?.["authorization"]).toBe("Bearer resolved-probe-key")
    } finally {
      if (prev === undefined) delete process.env["SENSUS_PROBE_REF_KEY"]
      else process.env["SENSUS_PROBE_REF_KEY"] = prev
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("endpointHasKey mirrors the mock seam and an empty credential", () => {
    expect(endpointHasKey({ provider: "openai-compatible", apiKey: "x" })).toBe(true)
    expect(endpointHasKey({ provider: "openai-compatible", apiKey: "" })).toBe(false)
    expect(endpointHasKey({ provider: "mock", apiKey: "" })).toBe(true)
  })

  test("buildModelCatalog fetches every endpoint, merges overrides and reports per-endpoint errors", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-models-cache-"))
    try {
      const cfg = defaultConfig()
      const override: ModelOverride = {
        contextLimit: 999,
        inputLimit: null,
        reasoning: null,
        reasoningEfforts: null,
        reasoningBudgetMin: null,
        reasoningBudgetMax: null,
        toolCall: null,
        temperatureSupported: null,
        vision: true,
      }
      cfg.endpoints = {
        main: {
          ...defaultEndpoint("main"),
          baseURL: "https://main.test/v1",
          apiKey: "main-key",
          models: { "gpt-5": override },
        },
        down: { ...defaultEndpoint("down"), baseURL: "https://down.test/v1", apiKey: "" },
      }

      const fetchImpl = (async (url: string) => {
        if (url.includes("main.test")) {
          return new Response(JSON.stringify({ data: [{ id: "gpt-5", owned_by: "openai" }, { id: "emb" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        // models.dev and the down endpoint both fail; enrichment degrades safely.
        return new Response("nope", { status: 503 })
      }) as unknown as typeof fetch

      const result = await buildModelCatalog(cfg, {
        fetchImpl,
        modelsDevUrl: "https://models.dev.test/api.json",
        cachePath: join(cacheDir, "models-dev.json"),
      })
      const main = result.endpoints.find((e) => e.name === "main")
      expect(main?.hasKey).toBe(true)
      expect(main?.models.map((m) => m.id)).toEqual(["gpt-5", "emb"])
      // The config override wins even when models.dev enrichment is unavailable.
      expect(main?.models[0]?.meta?.context).toBe(999)
      expect(main?.models[0]?.meta?.vision).toBe(true)
      const down = result.endpoints.find((e) => e.name === "down")
      expect(down?.hasKey).toBe(false)
      expect(result.errors.some((e) => e.startsWith("down:"))).toBe(true)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("buildModelCatalog pins models.dev per endpoint: the same id must not share metadata across protocols (regression)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-models-pin-"))
    try {
      const cachePath = join(cacheDir, "models-dev.json")
      writeFileSync(
        cachePath,
        JSON.stringify({
          fetchedAt: Date.now(),
          providers: {
            anthropic: { models: { "shared-model": { id: "shared-model", name: "Anthropic Shared", limit: { context: 100000 } } } },
            openai: { models: { "shared-model": { id: "shared-model", name: "OpenAI Shared", limit: { context: 200000 } } } },
          },
        }),
      )
      const cfg = defaultConfig()
      cfg.endpoints = {
        claude: { ...defaultEndpoint("claude"), provider: "anthropic", baseURL: "https://claude.test/v1", apiKey: "k", models: {} },
        responses: { ...defaultEndpoint("responses"), provider: "openai-responses", baseURL: "https://responses.test/v1", apiKey: "k", models: {} },
      }
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ data: [{ id: "shared-model" }] }), { status: 200 })) as unknown as typeof fetch
      const result = await buildModelCatalog(cfg, { fetchImpl, cachePath })
      const claude = result.endpoints.find((e) => e.name === "claude")
      const responses = result.endpoints.find((e) => e.name === "responses")
      // Each endpoint's protocol pin selects ITS provider's metadata — the old
      // global dedupe handed both rows the first endpoint's enrichment.
      expect(claude?.models[0]?.meta?.provider).toBe("anthropic")
      expect(claude?.models[0]?.meta?.name).toBe("Anthropic Shared")
      expect(claude?.models[0]?.meta?.context).toBe(100000)
      expect(responses?.models[0]?.meta?.provider).toBe("openai")
      expect(responses?.models[0]?.meta?.name).toBe("OpenAI Shared")
      expect(responses?.models[0]?.meta?.context).toBe(200000)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("buildModelCatalog: endpoint native metadata beats models.dev; the config override still wins over both", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-models-native-"))
    try {
      const cachePath = join(cacheDir, "models-dev.json")
      writeFileSync(
        cachePath,
        JSON.stringify({
          fetchedAt: Date.now(),
          providers: {
            anthropic: {
              models: {
                "native-model": { id: "native-model", name: "Models.dev Native", limit: { context: 100000, output: 4096 } },
                "override-model": { id: "override-model", name: "Models.dev Override", limit: { context: 100000, output: 4096 } },
              },
            },
          },
        }),
      )
      const override: ModelOverride = {
        contextLimit: 999,
        inputLimit: null,
        reasoning: null,
        reasoningEfforts: null,
        reasoningBudgetMin: null,
        reasoningBudgetMax: null,
        toolCall: null,
        temperatureSupported: null,
        vision: null,
      }
      const cfg = defaultConfig()
      cfg.endpoints = {
        claude: {
          ...defaultEndpoint("claude"),
          provider: "anthropic",
          baseURL: "https://claude.test/v1",
          apiKey: "k",
          models: { "override-model": override },
        },
      }
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "native-model",
                display_name: "Native Name",
                max_input_tokens: 500000,
                max_tokens: 8192,
                capabilities: {
                  thinking: { supported: true },
                  effort: { low: { supported: true }, high: { supported: true } },
                },
              },
              {
                id: "override-model",
                display_name: "Native Override",
                max_input_tokens: 500000,
                max_tokens: 8192,
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch
      const result = await buildModelCatalog(cfg, { fetchImpl, cachePath })
      const models = result.endpoints[0]?.models ?? []
      const native = models.find((m) => m.id === "native-model")?.meta
      expect(native?.name).toBe("Native Name") // native beats models.dev
      expect(native?.context).toBe(500000)
      expect(native?.input).toBe(500000) // max_input_tokens maps to both ceilings
      expect(native?.output).toBe(8192) // native beats models.dev's 4096
      expect(native?.reasoning).toBe(true)
      expect(native?.reasoningOptions.find((o) => o.type === "effort")?.values).toEqual(["low", "high"])
      const overridden = models.find((m) => m.id === "override-model")?.meta
      expect(overridden?.context).toBe(999) // config override beats native 500000
      expect(overridden?.output).toBe(8192) // native still beats models.dev
      expect(overridden?.name).toBe("Native Override")
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("/v1/usage rolls up the real sessions data dir (default builder)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sensus-daemon-usage-"))
    try {
      const path = sessionFilePath(dataDir, "inst", 1, 0)
      const sf = SessionFile.create(path, { endpoint: "main", model: "gpt-5" })
      sf.append({ ts: Date.UTC(2026, 8, 20, 12), type: "user_message", content: "hi" })
      sf.append({
        ts: Date.UTC(2026, 8, 20, 12, 1),
        type: "assistant_message",
        content: "yo",
        model: "gpt-5",
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedTokens: 6 },
        aborted: false,
      })
      sf.append({ ts: Date.UTC(2026, 8, 21, 8), type: "user_message", content: "more" })
      sf.append({
        ts: Date.UTC(2026, 8, 21, 8, 1),
        type: "assistant_message",
        content: "ok",
        model: "gpt-5",
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, cachedTokens: 0 },
        aborted: false,
      })

      // A second session with ONLY an old turn: it stays in `bySession` (all
      // retained history) but is outside the 14-day `byDay` window, so it must
      // NOT count toward `windowSessions`.
      const oldPath = sessionFilePath(dataDir, "inst", 2, 0)
      const oldSf = SessionFile.create(oldPath, { endpoint: "main", model: "gpt-5" })
      oldSf.append({ ts: Date.UTC(2026, 0, 1, 12), type: "user_message", content: "old" })
      oldSf.append({
        ts: Date.UTC(2026, 0, 1, 12, 1),
        type: "assistant_message",
        content: "old reply",
        model: "gpt-5",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 },
        aborted: false,
      })

      const app = makeApp({ sessionsDataDir: dataDir })
      const res = await app.handle(new Request("http://localhost/v1/usage", { headers: auth(TOKEN) }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        windowDays: number
        windowSessions: number
        total: { calls: number; totalTokens: number; cachePercent: number }
        byDay: Array<{ key: string }>
        bySession: Array<{ key: string; calls: number }>
        sessions: Array<{ path: string; title: string }>
      }
      expect(body.ok).toBe(true)
      expect(body.windowDays).toBe(14)
      expect(body.total.calls).toBe(3)
      expect(body.total.totalTokens).toBe(21)
      // `byDay` order is unspecified (first-seen; the dashboard re-sorts it), and
      // the two sessions are created milliseconds apart, so their mtime order —
      // and thus the raw day order — is not deterministic. Compare as a set.
      expect([...body.byDay.map((d) => d.key)].sort()).toEqual([
        "2026-01-01",
        "2026-09-20",
        "2026-09-21",
      ])
      expect(body.bySession).toHaveLength(2)
      expect(body.sessions).toHaveLength(2)
      // The window is the newest 14 distinct days WITH usage (there are only
      // three here), so both sessions count; a narrower window excludes the
      // old-only session (asserted on the pure builder below).
      expect(body.windowSessions).toBe(2)

      // The pure builder windows to the newest N days.
      const narrow = buildUsageReport(dataDir, { windowDays: 1 })
      expect(narrow.byDay.map((d) => d.key)).toEqual(["2026-09-21"])
      expect(narrow.total.calls).toBe(1)
      expect(narrow.windowSessions).toBe(1)
      // ...while `bySession` still carries all retained history.
      expect(narrow.bySession).toHaveLength(2)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe("daemon settings writes (P4c-ii)", () => {
  test("mergeConfigPatch deep-merges, replaces arrays/scalars, deletes on null, drops prototype keys", () => {
    const patch = JSON.parse(
      '{"chat":{"thinking":"show"},"model":"x@y","keep":null,"list":[3],"__proto__":{"evil":true}}',
    ) as Record<string, unknown>
    const merged = mergeConfigPatch(
      { chat: { thinking: "hide", cardStyle: "border" }, model: "a@b", keep: true, list: [1, 2] },
      patch,
    )
    expect(merged).toEqual({ chat: { thinking: "show", cardStyle: "border" }, model: "x@y", list: [3] })
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect((merged as { evil?: unknown }).evil).toBeUndefined()
  })

  test("PUT /v1/config patches, preserves unknown keys, captures a literal secret and never writes it", async () => {
    const home = tempHome()
    const calls: number[] = []
    try {
      writeConfigFile(home, {
        model: "main@gpt-5",
        unknownTop: 42,
        chat: { thinking: "hide", cardStyle: "border" },
        endpoints: { main: { baseURL: "https://api.example/v1", apiKey: "${MAIN_KEY}" } },
      })
      const app = makeApp({ home, config: () => ({ ok: true }), onConfigWrite: () => calls.push(1) })

      const res = await app.handle(
        new Request(
          "http://localhost/v1/config",
          json({ config: { chat: { thinking: "show" }, endpoints: { main: { apiKey: "sk-literal-secret" } } } }),
        ),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; captured: string[] }
      expect(body.ok).toBe(true)
      expect(body.captured).toHaveLength(1)
      expect(calls).toHaveLength(1)

      const doc = readConfigFile(home)
      expect(doc["unknownTop"]).toBe(42)
      expect((doc["chat"] as Record<string, unknown>)["thinking"]).toBe("show")
      expect((doc["chat"] as Record<string, unknown>)["cardStyle"]).toBe("border")
      const apiKey = ((doc["endpoints"] as Record<string, unknown>)["main"] as Record<string, unknown>)["apiKey"]
      const capturedName = body.captured[0] ?? ""
      expect(capturedName.length).toBeGreaterThan(0)
      expect(apiKey).toBe(`\${${capturedName}}`)
      expect(JSON.stringify(doc)).not.toContain("sk-literal-secret")

      // The captured value is in the store, reachable by name only.
      const secrets = (await (
        await app.handle(new Request("http://localhost/v1/secrets", { headers: auth(TOKEN) }))
      ).json()) as { ok: boolean; names: string[] }
      expect(secrets.names).toContain(capturedName)
      expect(JSON.stringify(secrets)).not.toContain("sk-literal-secret")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("GET /v1/config/raw returns the UNREDACTED raw document (settings editor)", async () => {
    const home = tempHome()
    try {
      writeConfigFile(home, {
        model: "main@gpt-5",
        endpoints: { main: { baseURL: "https://api.example/v1", apiKey: "sk-literal-in-raw" } },
      })
      const app = makeApp({ home })
      const res = await app.handle(new Request("http://localhost/v1/config/raw", { headers: auth(TOKEN) }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; raw: Record<string, unknown> }
      expect(body.ok).toBe(true)
      expect(body.raw["model"]).toBe("main@gpt-5")
      // The raw view is by design not redacted (the settings editor round-trips
      // the whole document; the route is bearer-gated and local-only).
      expect(JSON.stringify(body.raw)).toContain("sk-literal-in-raw")

      // A missing file degrades to an empty document, never an error.
      const emptyHome = tempHome()
      try {
        const empty = makeApp({ home: emptyHome })
        const emptyRes = await empty.handle(new Request("http://localhost/v1/config/raw", { headers: auth(TOKEN) }))
        expect(await emptyRes.json()).toEqual({ ok: true, raw: {} })
      } finally {
        rmSync(emptyHome, { recursive: true, force: true })
      }

      const denied = await app.handle(new Request("http://localhost/v1/config/raw"))
      expect(denied.status).toBe(401)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("PUT /v1/config restores a <redacted> placeholder instead of overwriting the ref", async () => {
    const home = tempHome()
    try {
      writeConfigFile(home, { endpoints: { main: { baseURL: "https://api.example/v1", apiKey: "${KEEP_ME}" } } })
      const app = makeApp({ home })
      const res = await app.handle(
        new Request("http://localhost/v1/config", json({ config: { endpoints: { main: { apiKey: "<redacted>" } } } })),
      )
      expect(res.status).toBe(200)
      const apiKey = ((readConfigFile(home)["endpoints"] as Record<string, unknown>)["main"] as Record<string, unknown>)[
        "apiKey"
      ]
      expect(apiKey).toBe("${KEEP_ME}")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("PUT /v1/config rejects a non-object body with 400 (never a crash)", async () => {
    const home = tempHome()
    try {
      const app = makeApp({ home })
      // A syntactically invalid JSON body: a 400 JSON status, never a throw.
      const malformed = await app.handle(
        new Request("http://localhost/v1/config", {
          method: "PUT",
          headers: { ...auth(TOKEN), "content-type": "application/json" },
          body: "{ not json",
        }),
      )
      expect(malformed.status).toBe(400)
      // A well-formed but non-object body is an explicit invalid_request.
      const arrayBody = await app.handle(
        new Request("http://localhost/v1/config", {
          method: "PUT",
          headers: { ...auth(TOKEN), "content-type": "application/json" },
          body: "[1,2]",
        }),
      )
      expect(arrayBody.status).toBe(400)
      expect(await arrayBody.json()).toEqual({ error: "invalid_request" })
      expect(existsSync(join(home, "config.json"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("secrets POST/GET/DELETE round-trips; a value is never echoed and bad names are 400", async () => {
    const home = tempHome()
    try {
      const app = makeApp({ home })
      const created = await app.handle(
        new Request("http://localhost/v1/secrets", {
          method: "POST",
          body: JSON.stringify({ name: "FOO_KEY", value: "s3cr3t-value" }),
          headers: { ...auth(TOKEN), "content-type": "application/json" },
        }),
      )
      expect(created.status).toBe(200)
      expect(await created.json()).toEqual({ ok: true, name: "FOO_KEY" })

      const list = await app.handle(new Request("http://localhost/v1/secrets", { headers: auth(TOKEN) }))
      const listed = (await list.json()) as { ok: boolean; names: string[] }
      expect(listed.names).toEqual(["FOO_KEY"])
      expect(JSON.stringify(listed)).not.toContain("s3cr3t-value")

      const bad = await app.handle(
        new Request("http://localhost/v1/secrets", {
          method: "POST",
          body: JSON.stringify({ name: "1bad", value: "x" }),
          headers: { ...auth(TOKEN), "content-type": "application/json" },
        }),
      )
      expect(bad.status).toBe(400)

      const removed = await app.handle(
        new Request("http://localhost/v1/secrets?name=FOO_KEY", { method: "DELETE", headers: auth(TOKEN) }),
      )
      expect(await removed.json()).toEqual({ ok: true, name: "FOO_KEY", removed: true })
      const empty = (await (
        await app.handle(new Request("http://localhost/v1/secrets", { headers: auth(TOKEN) }))
      ).json()) as { names: string[] }
      expect(empty.names).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("applyConfigPatch returns a message (not a throw) when the secrets store is unreadable", () => {
    const home = tempHome()
    try {
      // A bogus encrypted-looking store with no key: loadSecrets is unavailable,
      // so captureSecrets refuses to overwrite it.
      writeFileSync(join(home, "secrets.json"), JSON.stringify({ version: 1, alg: "aes-256-gcm", iv: "x", tag: "y", data: "z" }))
      writeConfigFile(home, { endpoints: { main: { apiKey: "literal" } } })
      const res = applyConfigPatch(home, { model: "a@b" })
      expect(res.ok).toBe(false)
      expect(res.error).toBeDefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

