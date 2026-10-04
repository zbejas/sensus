/**
 * M5 model catalog unit tests (roadmap feature C): endpoint /models parsing
 * + chat flagging, models.dev enrichment (normalization matching incl.
 * ":latest" and provider-path ids), cache TTL + background refresh, offline
 * fallback, and timeouts. A local mock HTTP server stands in for the
 * endpoint; the models.dev index comes from an injected fetch + cache file
 * (no network in tests).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalModelKey,
  cycleThinkingMode,
  defaultThinkingMode,
  effortValues,
  enrichModels,
  fetchModels,
  formatContextLimit,
  hasToggleReasoning,
  highestEffort,
  isChatCapable,
  knobDescription,
  loadModelsDevProviders,
  lookupModelMeta,
  matchModelId,
  mergeModelOverride,
  mergeNativeMeta,
  modelIdCandidates,
  normalizeModelId,
  oneShotThinkingKnob,
  parseAnthropicModelsResponse,
  parseGoogleModelsResponse,
  parseModelsResponse,
  parseThinkingMode,
  resolveThinkingKnob,
  thinkingChoices,
  warmModelsDevCache,
  type EndpointModel,
  type ModelMeta,
} from "../../../../src/agent/provider/modelCatalog.ts"
import { MOCK_MODELS_DEV, startMockOpenai } from "../../../mocks/mockOpenai.ts"

// ---- pure parsing / flagging / normalization ---------------------------------

describe("parsing + normalization", () => {
  test("parseModelsResponse: server order verbatim, dedup, junk skipped; chat flagging assumes chat without types", () => {
    const models = parseModelsResponse({
      data: [
        { id: "b-model", owned_by: "org", supported_endpoint_types: ["chat_completions"] },
        { id: "a-model" },
        { id: "a-model" },
        { id: "" },
        "garbage",
        null,
      ],
    })
    // server order verbatim (LiteLLM curates it) — no alphabetizing
    expect(models.map((m) => m.id)).toEqual(["b-model", "a-model"])
    expect(models[0]?.ownedBy).toBe("org")
    expect(models[1]?.chat).toBe(true) // no advertised types -> assume chat
    // Embeddings/rerank-only models are non-chat; everything else is chat.
    expect(isChatCapable(["embeddings"])).toBe(false)
    expect(isChatCapable(["rerank"])).toBe(false)
    expect(isChatCapable(["chat_completions"])).toBe(true)
    expect(isChatCapable(["openai"])).toBe(true)
    expect(isChatCapable(["completions", "embeddings"])).toBe(true)
    expect(isChatCapable([])).toBe(true)
    // Non-object bodies parse to empty.
    expect(parseModelsResponse(null)).toEqual([])
    expect(parseModelsResponse("x")).toEqual([])
    expect(parseModelsResponse({ data: "nope" })).toEqual([])
  })

  test("id normalization: lowercases, strips :latest, folds separators; candidates add path-suffix variants", () => {
    expect(normalizeModelId("GPT-4o:latest")).toBe("gpt-4o")
    expect(normalizeModelId("  Qwen3-Coder ")).toBe("qwen3-coder")
    expect(canonicalModelKey("gpt.4o_mini")).toBe("gpt-4o-mini")
    expect(canonicalModelKey("gpt--4o-")).toBe("gpt-4o")
    expect(modelIdCandidates("accounts/fireworks/models/deepseek-v4-pro")).toEqual([
      "accounts/fireworks/models/deepseek-v4-pro",
      "deepseek-v4-pro",
    ])
    expect(modelIdCandidates("openai/gpt-4o")).toEqual(["openai/gpt-4o", "gpt-4o"])
    expect(modelIdCandidates("plain")).toEqual(["plain"])
  })
})

// ---- protocol-aware listing (Anthropic / Gemini) ---------------------------

/** Capture the URL + lowercased headers of each injected fetch call. */
function captureFetch(payload: unknown): {
  calls: Array<{ url: string; headers: Record<string, string> }>
  fetchImpl: typeof fetch
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = init?.headers ?? {}
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, string>)) headers[key.toLowerCase()] = String(value)
    calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url, headers })
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe("protocol-aware listing (anthropic/gemini)", () => {
  test("parseAnthropicModelsResponse: ids, display name, limits, vision/reasoning and the effort vocabulary in EFFORT_ORDER", () => {
    const models = parseAnthropicModelsResponse({
      data: [
        {
          id: "claude-sonnet-x",
          display_name: "Claude Sonnet X",
          max_input_tokens: 200000,
          max_tokens: 8192,
          capabilities: {
            image_input: { supported: true },
            thinking: { supported: true },
            // Out-of-vocabulary and unsupported keys must be dropped.
            effort: {
              none: { supported: true },
              low: { supported: true },
              medium: { supported: false },
              high: { supported: true },
              max: { supported: true },
              bogus: { supported: true },
            },
          },
        },
        // Only "none" is supported: not an effort vocabulary we advertise.
        { id: "claude-haiku-x", capabilities: { effort: { none: { supported: true } } } },
        // Invalid limits are ignored, not stored as 0/NaN.
        { id: "claude-junk", max_input_tokens: 0, max_tokens: Number.NaN, capabilities: { image_input: "nope" } },
        { id: "claude-sonnet-x" },
        { id: "" },
        "garbage",
        null,
      ],
    })
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-x", "claude-haiku-x", "claude-junk"])
    expect(models[0]).toMatchObject({ ownedBy: null, endpointTypes: [], chat: true })
    expect(models[0]?.nativeMeta).toEqual({
      name: "Claude Sonnet X",
      contextLimit: 200000,
      inputLimit: 200000,
      outputLimit: 8192,
      vision: true,
      reasoning: true,
      reasoningEfforts: ["low", "high", "max"],
    })
    expect(models[1]?.nativeMeta?.reasoningEfforts).toBeUndefined()
    expect(models[2]?.nativeMeta).toEqual({})
    expect(parseAnthropicModelsResponse(null)).toEqual([])
    expect(parseAnthropicModelsResponse({ data: "nope" })).toEqual([])
  })

  test("parseGoogleModelsResponse: models/ prefix stripped, generateContent gating, limits and thinking (vision stays null)", () => {
    const models = parseGoogleModelsResponse({
      models: [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent", "countTokens"],
          thinking: true,
        },
        // Not a generation model: chat: false.
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        // No advertised methods -> assume chat-capable (OpenAI no-types rule).
        { name: "models/gemini-unknown" },
        // The prefix-stripped id dedups against the bare name.
        { name: "gemini-2.5-pro" },
        { name: "models/" },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "text-embedding-004", "gemini-unknown"])
    expect(models[0]?.chat).toBe(true)
    expect(models[0]?.nativeMeta).toEqual({
      name: "Gemini 2.5 Pro",
      contextLimit: 1048576,
      inputLimit: 1048576,
      outputLimit: 65536,
      reasoning: true,
    })
    expect(models[0]?.nativeMeta?.vision).toBeUndefined() // models.dev fills it in
    expect(models[1]?.chat).toBe(false)
    expect(models[2]?.chat).toBe(true)
    expect(parseGoogleModelsResponse(null)).toEqual([])
    expect(parseGoogleModelsResponse({ models: "nope" })).toEqual([])
  })

  test("fetchModels sends the protocol's headers: Anthropic x-api-key + version (no Authorization), Gemini x-goog-api-key; Responses stays Bearer", async () => {
    const anthropic = captureFetch({
      data: [{ id: "claude-x", display_name: "Claude X", max_input_tokens: 1, max_tokens: 2 }],
    })
    const a = await fetchModels(
      { provider: "anthropic", baseURL: "https://anthropic.test/v1/", apiKey: "sk-ant" },
      { fetchImpl: anthropic.fetchImpl },
    )
    expect(a.error).toBeNull()
    expect(anthropic.calls).toHaveLength(1)
    expect(anthropic.calls[0]?.url).toBe("https://anthropic.test/v1/models?limit=1000")
    expect(anthropic.calls[0]?.headers["x-api-key"]).toBe("sk-ant")
    expect(anthropic.calls[0]?.headers["anthropic-version"]).toBe("2023-06-01")
    expect(anthropic.calls[0]?.headers["authorization"]).toBeUndefined()
    expect(a.models[0]?.nativeMeta?.name).toBe("Claude X")

    const google = captureFetch({ models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"] }] })
    const g = await fetchModels(
      { provider: "google", baseURL: "https://generativelanguage.test/v1beta", apiKey: "goog-key" },
      { fetchImpl: google.fetchImpl },
    )
    expect(g.error).toBeNull()
    expect(google.calls[0]?.url).toBe("https://generativelanguage.test/v1beta/models?pageSize=1000")
    expect(google.calls[0]?.headers["x-goog-api-key"]).toBe("goog-key")
    expect(google.calls[0]?.headers["authorization"]).toBeUndefined()
    expect(g.models[0]?.id).toBe("gemini-x")

    // openai-responses keeps the OpenAI-compatible listing wire exactly.
    const responses = captureFetch({ data: [{ id: "gpt-5" }] })
    const r = await fetchModels(
      { provider: "openai-responses", baseURL: "https://api.openai.test/v1", apiKey: "k" },
      { fetchImpl: responses.fetchImpl },
    )
    expect(r.error).toBeNull()
    expect(responses.calls[0]?.url).toBe("https://api.openai.test/v1/models")
    expect(responses.calls[0]?.headers["authorization"]).toBe("Bearer k")

    // "mock"/unknown fall back to the OpenAI wire.
    const mocked = captureFetch({ data: [{ id: "mock-x" }] })
    const m = await fetchModels({ provider: "mock", baseURL: "https://mock.test/v1" }, { fetchImpl: mocked.fetchImpl })
    expect(m.error).toBeNull()
    expect(mocked.calls[0]?.url).toBe("https://mock.test/v1/models")
  })
})

// ---- live HTTP (mock endpoint) ---------------------------------------------

const endpoint = await startMockOpenai()

afterAll(async () => {
  await endpoint.close()
})

describe("fetchModels (mock endpoint)", () => {
  test("fetches + flags the mock catalog; auth header travels", async () => {
    const res = await fetchModels({ baseURL: endpoint.url, apiKey: "k" })
    expect(res.error).toBeNull()
    const byId = new Map(res.models.map((m) => [m.id, m]))
    expect(byId.get("mock-gpt-large")?.chat).toBe(true)
    expect(byId.get("text-embedding-mock")?.chat).toBe(false)
    expect(byId.get("accounts/fireworks/models/deepseek-v4-pro")?.chat).toBe(true)
    expect(byId.get("qwen3-coder:latest")?.chat).toBe(true)
    expect(byId.get("plain-no-types")?.chat).toBe(true)
    // Server accepts even with an empty key (failure mode is status-based).
    const noAuth = await fetchModels({ baseURL: `${endpoint.url}/`, apiKey: "" })
    expect(noAuth.error).toBeNull()
    expect(noAuth.models.length).toBeGreaterThan(0)
  })

  test("failure modes: unreachable baseURL and a hanging endpoint produce error results, never throws/hangs", async () => {
    const bad = await fetchModels({ baseURL: "http://127.0.0.1:1/v1" }, { timeoutMs: 300 })
    expect(bad.error).not.toBeNull()
    expect(bad.models).toEqual([])
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Promise<Response>(() => {
          // never resolves; aborted by the catalog timeout
        }),
    })
    try {
      const res = await fetchModels({ baseURL: `http://127.0.0.1:${slow.port}/v1` }, { timeoutMs: 250 })
      expect(res.error).not.toBeNull()
    } finally {
      slow.stop(true)
    }
  })
})

// ---- enrichment -------------------------------------------------------------

function writeCache(path: string, ageMs: number): void {
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now() - ageMs, providers: MOCK_MODELS_DEV }))
}

function sandbox(): { dir: string; cachePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "sensus-catalog-"))
  mkdirSync(join(dir, "cache"), { recursive: true })
  const cachePath = join(dir, "cache", "models-dev.json")
  sandboxes.push(dir)
  return { dir, cachePath }
}

const sandboxes: string[] = []

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

const endpointModels: EndpointModel[] = [
  { id: "mock-gpt-large", ownedBy: "mock-org", endpointTypes: ["chat_completions"], chat: true },
  { id: "accounts/fireworks/models/deepseek-v4-pro", ownedBy: "fireworks", endpointTypes: ["openai"], chat: true },
  { id: "qwen3-coder:latest", ownedBy: "mock-org", endpointTypes: ["openai"], chat: true },
  { id: "gpt.4o.variant", ownedBy: "x", endpointTypes: [], chat: true },
  { id: "text-embedding-mock", ownedBy: "mock-org", endpointTypes: ["embeddings"], chat: false },
  { id: "totally-unknown-model", ownedBy: null, endpointTypes: [], chat: true },
]

describe("enrichModels", () => {
  test("matching: provider-path ids, :latest tags, dots/dashes; reasoning metadata rides along; unknown stays null", async () => {
    const { cachePath } = sandbox()
    writeCache(cachePath, 0)
    const enriched = await enrichModels(endpointModels, { cachePath })
    const byId = new Map(enriched.map((m) => [m.id, m]))
    const large = byId.get("mock-gpt-large")?.meta
    expect(large?.name).toBe("Mock GPT Large")
    expect(large?.provider).toBe("mock-org")
    expect(large?.context).toBe(262144)
    // models.dev `limit.input` rides along as the provider's input ceiling.
    expect(large?.input).toBe(200000)
    expect(large?.output).toBe(65536)
    expect(large?.toolCall).toBe(true)
    expect(large?.costInputPerMtok).toBe(1.25)
    expect(large?.costOutputPerMtok).toBe(10)
    // Reasoning metadata from the models.dev index.
    expect(large?.reasoning).toBe(true)
    expect(large?.reasoningOptions[0]?.type).toBe("effort")
    expect(large?.reasoningOptions[0]?.values).toContain("high")
    expect(large?.temperatureSupported).toBe(false)
    // Image input comes from modalities.input; the attachment flag is the fallback.
    expect(large?.vision).toBe(true)
    expect(byId.get("qwen3-coder:latest")?.meta?.vision).toBe(true) // attachment:true fallback
    expect(byId.get("accounts/fireworks/models/deepseek-v4-pro")?.meta?.vision).toBe(false) // modalities.input: ["text"]
    // provider-path id resolves to the models.dev "deepseek-v4-pro"
    expect(byId.get("accounts/fireworks/models/deepseek-v4-pro")?.meta?.name).toBe("DeepSeek V4 Pro")
    expect(byId.get("accounts/fireworks/models/deepseek-v4-pro")?.meta?.context).toBe(128000)
    // ":latest" tag stripped; embeddings model matches too (metadata is
    // orthogonal to the chat flag).
    expect(byId.get("qwen3-coder:latest")?.meta?.name).toBe("Qwen3 Coder")
    expect(byId.get("text-embedding-mock")?.meta?.toolCall).toBe(false)
    // unmatched -> "unknown" limits (null); no throw on near-miss ids.
    expect(byId.get("gpt.4o.variant")?.meta).toBeNull()
    expect(byId.get("totally-unknown-model")?.meta).toBeNull()
  })

  test("cache lifecycle: fresh TTL never refetches; stale serves + background-refreshes; missing cache foreground-fetches and persists (M5 regression); failing fetch degrades", async () => {
    // Fresh cache: TTL means no fetch at all.
    const fresh = sandbox()
    writeCache(fresh.cachePath, 0)
    let freshFetches = 0
    await enrichModels(endpointModels, {
      cachePath: fresh.cachePath,
      fetchImpl: (async () => {
        freshFetches++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(freshFetches).toBe(0)
    // Missing cache + failing fetch: graceful no-enrichment.
    const offline = sandbox()
    const offlineModels = await enrichModels(endpointModels, {
      cachePath: offline.cachePath,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    })
    expect(offlineModels.every((m) => m.meta === null)).toBe(true)
    // Missing cache: a foreground fetch populates enrichment AND persists the
    // cache — Regression (M5 dogfood): the fetched index must land on disk so
    // the status-bar lookup + the next picker open see it without refetching.
    const cold = sandbox()
    const coldModels = await enrichModels(endpointModels, {
      cachePath: cold.cachePath,
      fetchImpl: (async () => new Response(JSON.stringify(MOCK_MODELS_DEV), { status: 200 })) as unknown as typeof fetch,
      modelsDevUrl: "http://127.0.0.1:2/x",
    })
    expect(coldModels.find((m) => m.id === "mock-gpt-large")?.meta?.context).toBe(262144)
    expect(existsSync(cold.cachePath)).toBe(true)
    expect(lookupModelMeta("mock-gpt-large", { cachePath: cold.cachePath })?.context).toBe(262144)
    // Stale cache: served immediately, refreshed in the background; the next
    // lookup sees fresh data once the refresh has landed.
    const stale = sandbox()
    writeCache(stale.cachePath, 48 * 60 * 60 * 1000) // 48h old — stale
    let fetches = 0
    const freshPayload = {
      "fresh-org": { id: "fresh-org", models: { "mock-gpt-large": { id: "mock-gpt-large", name: "Fresh Name", limit: { context: 1 } } } },
    }
    const res = await enrichModels(endpointModels, {
      cachePath: stale.cachePath,
      fetchImpl: (async () => {
        fetches++
        // The parsed-cache memo invalidates by mtime (ms granularity): make
        // sure the background write lands on a LATER millisecond than the
        // stale read the call above memoized, or the fresh data would never
        // become visible to lookupModelMeta.
        await Bun.sleep(5)
        return new Response(JSON.stringify(freshPayload), { status: 200 })
      }) as unknown as typeof fetch,
      modelsDevUrl: "http://127.0.0.1:1/never",
    })
    expect(res.find((m) => m.id === "mock-gpt-large")?.meta?.name).toBe("Mock GPT Large")
    // The suite runs files in parallel in one process — smoke tests spawning
    // tmux can starve the event loop for seconds, so this poll is generous,
    // and the wait is permissive: the ASSERTION is that the next lookup sees
    // fresh data once the refresh has landed (fetches > 0 is the real gate).
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (fetches > 0) {
        const meta = lookupModelMeta("mock-gpt-large", { cachePath: stale.cachePath })
        if (meta?.name === "Fresh Name") break
      }
      await Bun.sleep(25)
    }
    expect(fetches).toBeGreaterThan(0)
    expect(lookupModelMeta("mock-gpt-large", { cachePath: stale.cachePath })?.name).toBe("Fresh Name")
    const onDisk = JSON.parse(readFileSync(stale.cachePath, "utf8")) as { fetchedAt: number; providers: unknown }
    expect(onDisk.fetchedAt).toBeGreaterThan(0)
  }, 45000)

  test("timeout on the index fetch degrades to null metas", async () => {
    const { cachePath } = sandbox()
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Promise<Response>(() => {
          // hang until aborted
        }),
    })
    try {
      const enriched = await enrichModels(endpointModels, {
        cachePath,
        modelsDevUrl: `http://127.0.0.1:${slow.port}/api.json`,
        timeoutMs: 250,
      })
      expect(enriched.every((m) => m.meta === null)).toBe(true)
    } finally {
      slow.stop(true)
    }
  })

  test("warmModelsDevCache (boot prefetch): a missing cache foreground-fetches once and persists; failures resolve false", async () => {
    // Missing cache: one fetch, persisted so the status-bar lookup (which reads
    // the file, never fetches) resolves the real window without the picker.
    const { cachePath } = sandbox()
    let fetches = 0
    const warmed = await warmModelsDevCache({
      cachePath,
      fetchImpl: (async () => {
        fetches++
        return new Response(JSON.stringify(MOCK_MODELS_DEV), { status: 200 })
      }) as unknown as typeof fetch,
      modelsDevUrl: "http://127.0.0.1:2/x",
    })
    expect(warmed).toBe(true)
    expect(fetches).toBe(1)
    expect(existsSync(cachePath)).toBe(true)
    expect(lookupModelMeta("mock-gpt-large", { cachePath })?.context).toBe(262144)
    // A second warm with the fresh cache does not refetch.
    await warmModelsDevCache({
      cachePath,
      fetchImpl: (async () => {
        fetches++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(fetches).toBe(1)
    // Unreachable index: false, never throws.
    const cold = sandbox()
    const failed = await warmModelsDevCache({
      cachePath: cold.cachePath,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      modelsDevUrl: "http://127.0.0.1:1/never",
    })
    expect(failed).toBe(false)
  })
})

describe("thinking modes (models.dev reasoning metadata)", () => {
  const effortMeta = {
    id: "gpt-test",
    provider: "openai",
    name: "GPT Test",
    context: 128000,
    output: 4096,
    toolCall: true,
    costInputPerMtok: null,
    costOutputPerMtok: null,
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["high", "minimal", "low", "medium"], min: null, max: null, raw: {} }],
    temperatureSupported: false,
  }
  const budgetMeta = {
    id: "claude-test",
    provider: "anthropic",
    name: "Claude Test",
    context: 200000,
    output: 8192,
    toolCall: true,
    costInputPerMtok: null,
    costOutputPerMtok: null,
    reasoning: true,
    reasoningOptions: [{ type: "budget_tokens", values: [], min: 1024, max: 32768, raw: {} }],
    temperatureSupported: null,
  }
  const plainMeta = { ...effortMeta, reasoning: false, reasoningOptions: [] }
  const toggleMeta = { ...effortMeta, reasoningOptions: [{ type: "toggle", values: [], min: null, max: null, raw: {} }] }

  test("vocabulary: parseThinkingMode accepts default/off/budget:<n>/keywords and rejects junk; choices mirror metadata only; cycling wraps and anchors on the highest", () => {
    expect(parseThinkingMode("default")).toEqual({ kind: "default" })
    expect(parseThinkingMode("")).toEqual({ kind: "default" })
    expect(parseThinkingMode("off")).toEqual({ kind: "off" })
    expect(parseThinkingMode("high")).toEqual({ kind: "effort", effort: "high" })
    expect(parseThinkingMode("Budget:8192")).toEqual({ kind: "budget", tokens: 8192 })
    expect(parseThinkingMode("budget:0")).toBeNull()
    expect(parseThinkingMode("not a mode!")).toBeNull()
    // Choices mirror models.dev exactly: no synthetic "default"/"off"/keywords.
    expect(thinkingChoices(effortMeta)).toEqual(["minimal", "low", "medium", "high"])
    expect(thinkingChoices({ ...effortMeta, reasoningOptions: [{ type: "effort", values: ["low", "high"], min: null, max: null, raw: {} }] })).toEqual([
      "low",
      "high",
    ])
    expect(thinkingChoices(budgetMeta)).toContain("budget:4096")
    expect(thinkingChoices(toggleMeta)).toEqual(["off", "on"])
    // No metadata -> no invented choices.
    expect(thinkingChoices(null)).toEqual([])
    expect(thinkingChoices(plainMeta)).toEqual([])
    // The default anchor is the model's HIGHEST advertised setting.
    expect(highestEffort(effortMeta)).toBe("high")
    expect(highestEffort(plainMeta)).toBeNull()
    expect(defaultThinkingMode(effortMeta)).toBe("high")
    expect(defaultThinkingMode(budgetMeta)).toBe("budget:32768")
    expect(defaultThinkingMode(toggleMeta)).toBe("on")
    expect(defaultThinkingMode(plainMeta)).toBeNull()
    // Cycling wraps; an unknown/absent current anchors on the highest.
    expect(cycleThinkingMode("high", effortMeta)).toBe("minimal")
    expect(cycleThinkingMode("garbage", effortMeta)).toBe("high")
    expect(cycleThinkingMode("default", toggleMeta)).toBe("on")
  })

  test("resolveThinkingKnob: explicit keywords pass through, an unset mode resolves to the HIGHEST advertised setting, 'off' picks the lowest, budget clamps; toggle models use the enable flag", () => {
    expect(effortValues(effortMeta)).toEqual(["minimal", "low", "medium", "high"])
    expect(effortValues(plainMeta)).toEqual([])
    expect(resolveThinkingKnob("high", effortMeta)).toEqual({ reasoningEffort: "high" })
    // Unset -> the model's highest advertised effort (was: omit).
    expect(resolveThinkingKnob("default", effortMeta)).toEqual({ reasoningEffort: "high" })
    expect(resolveThinkingKnob(null, effortMeta)).toEqual({ reasoningEffort: "high" })
    // Explicit choice passes even when metadata doesn't list it.
    expect(resolveThinkingKnob("xhigh", effortMeta)).toEqual({ reasoningEffort: "xhigh" })
    // Unknown model (no metadata) -> unset omits; an explicit effort still passes.
    expect(resolveThinkingKnob("default", null)).toBeNull()
    expect(resolveThinkingKnob("medium", null)).toEqual({ reasoningEffort: "medium" })
    // "off": lowest advertised effort; "none" when advertised; omitted without metadata.
    expect(resolveThinkingKnob("off", effortMeta)).toEqual({ reasoningEffort: "minimal" })
    const withNone = { ...effortMeta, reasoningOptions: [{ type: "effort", values: ["none", "low"], min: null, max: null, raw: {} }] }
    expect(resolveThinkingKnob("off", withNone)).toEqual({ reasoningEffort: "none" })
    expect(resolveThinkingKnob("off", null)).toBeNull()
    // Toggle-only models: unset -> enabled; "on"/"off" map to the flag.
    expect(hasToggleReasoning(toggleMeta)).toBe(true)
    expect(resolveThinkingKnob("default", toggleMeta)).toEqual({ reasoningEnabled: true })
    expect(resolveThinkingKnob("on", toggleMeta)).toEqual({ reasoningEnabled: true })
    expect(resolveThinkingKnob("off", toggleMeta)).toEqual({ reasoningEnabled: false })
    expect(resolveThinkingKnob("off", budgetMeta)).toBeNull() // budget models have no portable off
    // Budget: unset -> the advertised max; explicit clamps to the range.
    expect(resolveThinkingKnob("default", budgetMeta)).toEqual({ reasoningBudgetTokens: 32768 })
    expect(resolveThinkingKnob("budget:4096", budgetMeta)).toEqual({ reasoningBudgetTokens: 4096 })
    expect(resolveThinkingKnob("budget:16", budgetMeta)).toEqual({ reasoningBudgetTokens: 1024 })
    expect(resolveThinkingKnob("budget:999999", budgetMeta)).toEqual({ reasoningBudgetTokens: 32768 })
    expect(resolveThinkingKnob("budget:4096", null)).toEqual({ reasoningBudgetTokens: 4096 })
  })

  test("oneShotThinkingKnob: lowest advertised effort, else the advertised budget minimum, else omit", () => {
    // A mechanical one-shot pass (compaction) pins the LEAST reasoning
    // so hidden thinking cannot consume the whole output budget.
    expect(oneShotThinkingKnob(effortMeta)).toEqual({ reasoningEffort: "minimal" })
    expect(oneShotThinkingKnob({ ...effortMeta, reasoningOptions: [{ type: "effort", values: ["low", "high"], min: null, max: null, raw: {} }] })).toEqual({
      reasoningEffort: "low",
    })
    expect(oneShotThinkingKnob(budgetMeta)).toEqual({ reasoningBudgetTokens: 1024 })
    // No advertised knob -> omit (a strict non-reasoning endpoint may 400).
    expect(oneShotThinkingKnob(plainMeta)).toBeNull()
    expect(oneShotThinkingKnob(null)).toBeNull()
  })

  test("display formatters: formatContextLimit k/M/unknown; knobDescription renders the knob", () => {
    expect(formatContextLimit(262144)).toBe("262k")
    expect(formatContextLimit(128000)).toBe("128k")
    expect(formatContextLimit(1000000)).toBe("1M")
    expect(formatContextLimit(1500000)).toBe("1.5M")
    expect(formatContextLimit(8192)).toBe("8k")
    expect(formatContextLimit(null)).toBeNull()
    expect(formatContextLimit(0)).toBeNull()
    expect(knobDescription(null)).toContain("omitted")
    expect(knobDescription({ reasoningEffort: "high" })).toContain("reasoning_effort = high")
    expect(knobDescription({ reasoningBudgetTokens: 8192 })).toContain("8192")
    expect(knobDescription({ reasoningEnabled: true })).toContain("reasoning.enabled = true")
  })
})

describe("mergeModelOverride (config endpoint model overrides, docs/config.md)", () => {
  const base = {
    id: "gpt-x",
    provider: "openai",
    name: "GPT X",
    context: 100_000,
    input: 150_000,
    output: 4096,
    toolCall: true,
    costInputPerMtok: 1,
    costOutputPerMtok: 2,
    reasoning: false,
    reasoningOptions: [{ type: "effort", values: ["low", "high"], min: null, max: null, raw: {} }],
    temperatureSupported: true,
    vision: true,
  }
  const empty = {
    contextLimit: null,
    inputLimit: null,
    reasoning: null,
    reasoningEfforts: null,
    reasoningBudgetMin: null,
    reasoningBudgetMax: null,
    toolCall: null,
    temperatureSupported: null,
    vision: null,
  }

  test("null and empty overrides pass the enrichment through untouched", () => {
    expect(mergeModelOverride(base, null)).toEqual(base)
    expect(mergeModelOverride(base, empty)).toEqual(base)
  })

  test("set fields win per-field; reasoningEfforts replace the effort list, budget ranges merge; a null base still carries the override", () => {
    const merged = mergeModelOverride(base, {
      contextLimit: 400_000,
      inputLimit: 272_000,
      reasoning: null,
      reasoningEfforts: null,
      reasoningBudgetMin: null,
      reasoningBudgetMax: null,
      toolCall: false,
      temperatureSupported: null,
      vision: null,
    })
    expect(merged?.context).toBe(400_000)
    expect(merged?.input).toBe(272_000) // override wins over the base ceiling
    expect(merged?.toolCall).toBe(false)
    expect(merged?.output).toBe(4096) // untouched enrichment
    expect(merged?.reasoning).toBe(false)
    // Effort list replacement + budget range merge drive the thinking-mode
    // vocabulary.
    const remodeled = mergeModelOverride(base, {
      contextLimit: null,
      inputLimit: null,
      reasoning: true,
      reasoningEfforts: ["minimal", "low", "max"],
      reasoningBudgetMin: 1024,
      reasoningBudgetMax: 8192,
      toolCall: null,
      temperatureSupported: null,
      vision: null,
    })
    expect(remodeled?.reasoning).toBe(true)
    expect(remodeled?.input).toBe(150_000) // null falls through to the base
    const effort = remodeled?.reasoningOptions.find((o) => o.type === "effort")
    expect(effort?.values).toEqual(["minimal", "low", "max"])
    const budget = remodeled?.reasoningOptions.find((o) => o.type === "budget_tokens")
    expect(budget?.min).toBe(1024)
    expect(budget?.max).toBe(8192)
    expect(effortValues(remodeled)).toEqual(["minimal", "low", "max"])
    // No models.dev match: the override alone shapes the metadata.
    const nullBase = mergeModelOverride(null, {
      contextLimit: 8192,
      inputLimit: 272_000,
      reasoning: false,
      reasoningEfforts: null,
      reasoningBudgetMin: null,
      reasoningBudgetMax: null,
      toolCall: true,
      temperatureSupported: null,
      vision: null,
    })
    expect(nullBase?.context).toBe(8192)
    expect(nullBase?.input).toBe(272_000) // override alone shapes the metadata
    expect(nullBase?.toolCall).toBe(true)
    expect(nullBase?.name).toBeNull()
  })
})

describe("mergeNativeMeta (endpoint-reported metadata over models.dev)", () => {
  const base: ModelMeta = {
    id: "gpt-x",
    provider: "openai",
    name: "GPT X",
    context: 100_000,
    input: 150_000,
    output: 4096,
    toolCall: true,
    costInputPerMtok: 1,
    costOutputPerMtok: 2,
    reasoning: false,
    reasoningOptions: [
      { type: "budget_tokens", values: [], min: 1024, max: 32768, raw: {} },
      { type: "effort", values: ["low", "high"], min: null, max: null, raw: {} },
    ],
    temperatureSupported: true,
    vision: true,
  }

  test("native wins per field; everything else falls through to models.dev; base identity/toolCall/cost/temperature survive", () => {
    const merged = mergeNativeMeta(base, {
      name: "Native Name",
      contextLimit: 500_000,
      inputLimit: 272_000,
      vision: false,
      reasoning: true,
      reasoningEfforts: ["low", "medium", "max"],
    })
    expect(merged).not.toBeNull()
    expect(merged?.id).toBe("gpt-x")
    expect(merged?.provider).toBe("openai")
    expect(merged?.name).toBe("Native Name")
    expect(merged?.context).toBe(500_000)
    expect(merged?.input).toBe(272_000) // native input ceiling beats models.dev's
    expect(merged?.output).toBe(4096) // fell through
    expect(merged?.reasoning).toBe(true)
    expect(merged?.vision).toBe(false)
    expect(merged?.toolCall).toBe(true)
    expect(merged?.temperatureSupported).toBe(true)
    expect(merged?.costOutputPerMtok).toBe(2)
  })

  test("effort replacement keeps other option types; null/empty native returns the base untouched; both empty → null", () => {
    const merged = mergeNativeMeta(base, { reasoningEfforts: ["minimal", "low"] })
    const effort = merged?.reasoningOptions.find((o) => o.type === "effort")
    expect(effort?.values).toEqual(["minimal", "low"])
    // models.dev's budget_tokens range is kept (native knowledge is effort-only).
    expect(merged?.reasoningOptions.find((o) => o.type === "budget_tokens")?.max).toBe(32768)
    // With no native input limit, models.dev's input ceiling falls through.
    expect(merged?.input).toBe(150_000)
    // null native / empty native object are pass-throughs.
    expect(mergeNativeMeta(base, null)).toBe(base)
    expect(mergeNativeMeta(base, undefined)).toBe(base)
    expect(mergeNativeMeta(base, {})).toBe(base)
    expect(mergeNativeMeta(null, null)).toBeNull()
    expect(mergeNativeMeta(null, {})).toBeNull()
    // Native-only metadata still yields a meta (empty identity).
    const nativeOnly = mergeNativeMeta(null, { contextLimit: 8192 })
    expect(nativeOnly?.id).toBe("")
    expect(nativeOnly?.provider).toBe("")
    expect(nativeOnly?.context).toBe(8192)
    // A native input ceiling alone counts as metadata (hasAny).
    const inputOnly = mergeNativeMeta(null, { inputLimit: 272_000 })
    expect(inputOnly?.input).toBe(272_000)
    expect(inputOnly?.context).toBeNull()
  })
})

describe("matchModelId provider pinning + loadModelsDevProviders", () => {
  test("the protocol pin wins a same-tier tie; no pin keeps today's lexicographic choice", () => {
    const providers = {
      anthropic: { models: { "shared-id": { id: "shared-id", name: "Anthropic Shared" } } },
      "some-proxy": { models: { "shared-id": { id: "shared-id", name: "Proxy Shared" } } },
    }
    // Historical behavior (shortest id, then lexicographic provider).
    expect(matchModelId("shared-id", providers)?.provider).toBe("anthropic")
    expect(matchModelId("shared-id", providers, null)?.provider).toBe("anthropic")
    // An explicit pin outranks the tie-break.
    expect(matchModelId("shared-id", providers, "some-proxy")?.provider).toBe("some-proxy")
    expect(matchModelId("shared-id", providers, "some-proxy")?.name).toBe("Proxy Shared")
  })

  test("loadModelsDevProviders returns the cached index and null when unavailable (same memoized object)", async () => {
    const { cachePath } = sandbox()
    writeCache(cachePath, 0)
    const providers = await loadModelsDevProviders({ cachePath })
    expect(providers).not.toBeNull()
    expect(providers?.["mock-org"]).toBeDefined()
    expect(await loadModelsDevProviders({ cachePath })).toBe(providers)
    const cold = sandbox()
    const offline = await loadModelsDevProviders({
      cachePath: cold.cachePath,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      modelsDevUrl: "http://127.0.0.1:1/never",
    })
    expect(offline).toBeNull()
  })

  test("enrichModels passes the pin through (the pinned provider's metadata wins an ambiguous id)", async () => {
    const { cachePath } = sandbox()
    writeCache(cachePath, 0)
    const models: EndpointModel[] = [{ id: "mock-gpt-large", ownedBy: null, endpointTypes: [], chat: true }]
    const pinned = await enrichModels(models, { cachePath, preferredProvider: "mock-org" })
    expect(pinned[0]?.meta?.provider).toBe("mock-org")
  })
})
