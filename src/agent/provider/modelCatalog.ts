/**
 * Model catalog: endpoint models + models.dev
 * enrichment.
 *
 * - `fetchModels` is protocol-aware: OpenAI-compatible/Responses GET
 *   `{baseURL}/models` with `Authorization: Bearer` (LiteLLM proxies add
 *   `supported_endpoint_types`); Anthropic GETs `{baseURL}/models?limit=1000`
 *   with `x-api-key` + `anthropic-version`; Gemini GETs
 *   `{baseURL}/models?pageSize=1000` with `x-goog-api-key` and strips the
 *   `models/` id prefix. It flags chat-capable vs embeddings-only models so
 *   chat pickers can exclude the latter.
 * - Native endpoint metadata (Anthropic capabilities, Gemini limits) is parsed
 *   onto `EndpointModel.nativeMeta`; `mergeNativeMeta` layers it per field OVER
 *   models.dev, and a config override wins over both.
 * - `enrichModels` looks each endpoint model id up against the models.dev
 *   index (https://models.dev/api.json, ~4.5MB, 213 providers) — provider-
 *   AGNOSTIC matching via normalization (provider path prefixes, ":latest",
 *   dot/dash/underscore equivalence). Enrichment adds display name,
 *   context/input/output limits, tool_call support and cost; unmatched models
 *   keep null limits ("unknown").
 * - The index is cached at `$SENSUS_CACHE_DIR|~/.cache/sensus/models-dev.json`
 *   (SENSUS_HOME sandboxes redirect it for tests) with a 24h TTL; a stale
 *   cache is used immediately while a background refetch runs. Everything
 *   times out and never throws — the TUI must not block or crash on network
 *   problems.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { errorMessage } from "../../core/util.ts"
import { componentLogger } from "../log.ts"
// Type-only (erased at runtime): config.ts imports parseThinkingMode from
// here, so a value import back would be a cycle.
import type { ModelOverride } from "../../config/config.ts"
import type { ProviderKind } from "../../config/config/types.ts"
import { canonicalProvider, type ProtocolKind } from "./protocols.ts"

const log = componentLogger("agent.provider")

/** Metadata an endpoint's OWN /models reports (Anthropic capabilities, Gemini
 * limits). Merged per field OVER models.dev; config overrides win over both. */
export interface NativeModelMeta {
  name?: string | null
  contextLimit?: number | null
  /** The endpoint's own INPUT-token ceiling (Anthropic `max_input_tokens`,
   * Gemini `inputTokenLimit`), when reported. */
  inputLimit?: number | null
  outputLimit?: number | null
  vision?: boolean | null
  reasoning?: boolean | null
  /** Advertised effort vocabulary (Anthropic capabilities.effort). */
  reasoningEfforts?: string[] | null
}

export interface EndpointModel {
  id: string
  ownedBy: string | null
  /** Raw supported_endpoint_types (LiteLLM-style proxies). */
  endpointTypes: string[]
  /** Chat-capable (as opposed to embeddings-only / rerank-only). */
  chat: boolean
  /** Provider-reported metadata; absent/null when the endpoint reports none. */
  nativeMeta?: NativeModelMeta | null
}

export interface ModelMeta {
  /** The models.dev model id that matched. */
  id: string
  /** The models.dev provider id that matched. */
  provider: string
  name: string | null
  context: number | null
  /** The provider's INPUT-token ceiling (models.dev `limit.input`), when it is
   * smaller than the context window. The compaction ceiling is
   * `min(context, input)`; null/absent = unknown. Optional to keep fixtures
   * minimal — consumers normalize to null. */
  input?: number | null
  output: number | null
  toolCall: boolean | null
  costInputPerMtok: number | null
  costOutputPerMtok: number | null
  /** Model reasons ("thinking") — models.dev `reasoning` flag. */
  reasoning: boolean | null
  /** Advertised reasoning knobs (models.dev `reasoning_options`). */
  reasoningOptions: ReasoningOption[]
  /** models.dev `temperature: false` — the endpoint rejects a temperature. */
  temperatureSupported: boolean | null
  /** Image input support. models.dev `modalities.input` containing "image"
   * (falling back to the `attachment` flag); null/absent = unknown. Gates the
   * `view_image` tool + whether attaching an image is allowed. */
  vision?: boolean | null
}

/** One reasoning knob a model advertises (models.dev `reasoning_options[]`):
 * `{type: "effort", values: ["low","medium","high"]}` (OpenAI-style keywords)
 * or `{type: "budget_tokens", min, max}` (Anthropic-style token budgets). */
export interface ReasoningOption {
  type: string
  values: string[]
  min: number | null
  max: number | null
  /** Numeric effort-value aliases (e.g. qwen mapping 0/1/2) kept for display. */
  raw: Record<string, unknown>
}

export interface CatalogModel extends EndpointModel {
  meta: ModelMeta | null
}

export interface CatalogOptions {
  /** Per-request timeout (default 6s; models.dev 8s). */
  timeoutMs?: number
  /** Test seam. */
  fetchImpl?: typeof fetch
  /** Test seam for TTL math. */
  now?: () => number
  /** Explicit cache file override (tests); default see modelsDevCachePath(). */
  cachePath?: string
  /** Test seam. */
  modelsDevUrl?: string
  /** Test seam (default 24h). */
  ttlMs?: number
  /** models.dev provider id to prefer when several providers expose the same
   * model id (the endpoint protocol's pin: PROTOCOLS[kind].modelsDevProvider). */
  preferredProvider?: string | null
}

export interface FetchModelsResult {
  models: EndpointModel[]
  /** null on success; a human-readable failure reason otherwise. */
  error: string | null
}

const DEFAULT_MODELS_TIMEOUT_MS = 6000
const DEFAULT_DEV_TIMEOUT_MS = 8000
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MODELS_DEV_URL = "https://models.dev/api.json"

/** models.dev index URL; SENSUS_MODELS_DEV_URL overrides (test seam, like
 * SENSUS_MOCK — lets dogfood runs point the catalog at a local mock). */
export function modelsDevUrl(): string {
  const env = process.env["SENSUS_MODELS_DEV_URL"]
  return env !== undefined && env.length > 0 ? env : MODELS_DEV_URL
}

// ---- endpoint /models ------------------------------------------------------

/** Chat-capability from LiteLLM-style supported_endpoint_types. A model with
 * no advertised types is assumed chat-capable (plain OpenAI-compatible). */
export function isChatCapable(endpointTypes: readonly string[]): boolean {
  if (endpointTypes.length === 0) return true
  return endpointTypes.some((t) => /chat|completion|^openai$|responses/i.test(t))
}

/** Join a baseURL and a path without double/missing slashes. */
function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

/** A model-listing target: protocol + base URL + (draft) credential. */
export interface ModelFetchEndpoint {
  /** Defaults to "openai-compatible"; "mock" behaves as openai-compatible. */
  provider?: ProviderKind
  baseURL: string
  apiKey?: string
}

/** The protocol used for LISTING: unknown/null and "mock" list like OpenAI. */
function listingKind(provider: ProviderKind | undefined): ProtocolKind {
  const kind = canonicalProvider(provider) ?? "openai-compatible"
  return kind === "mock" ? "openai-compatible" : kind
}

/**
 * GET `{baseURL}/models` using the endpoint's protocol wire:
 * OpenAI-compatible/Responses use Bearer auth; Anthropic uses `x-api-key` +
 * `anthropic-version`; Gemini uses `x-goog-api-key`. Returns the parsed
 * endpoint models (never throws; failures come back in `error`).
 */
export async function fetchModels(
  endpoint: ModelFetchEndpoint,
  opts: CatalogOptions = {},
): Promise<FetchModelsResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeout = opts.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS
  const kind = listingKind(endpoint.provider)
  const headers: Record<string, string> = { accept: "application/json" }
  let path = "models"
  if (kind === "anthropic") {
    if (endpoint.apiKey && endpoint.apiKey.length > 0) headers["x-api-key"] = endpoint.apiKey
    headers["anthropic-version"] = "2023-06-01"
    path = "models?limit=1000"
  } else if (kind === "google") {
    if (endpoint.apiKey && endpoint.apiKey.length > 0) headers["x-goog-api-key"] = endpoint.apiKey
    path = "models?pageSize=1000"
  } else if (endpoint.apiKey && endpoint.apiKey.length > 0) {
    headers.authorization = `Bearer ${endpoint.apiKey}`
  }
  try {
    const res = await fetchWithTimeout(
      joinURL(endpoint.baseURL, path),
      { method: "GET", headers },
      timeout,
      doFetch,
    )
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { models: [], error: "invalid JSON from /models" }
    }
    const models =
      kind === "anthropic"
        ? parseAnthropicModelsResponse(body)
        : kind === "google"
          ? parseGoogleModelsResponse(body)
          : parseModelsResponse(body)
    return { models, error: null }
  } catch (e) {
    return { models: [], error: errorMessage(e) }
  }
}

/** Parse an OpenAI-compatible /models body defensively (never throws). */
export function parseModelsResponse(body: unknown): EndpointModel[] {
  if (body === null || typeof body !== "object") return []
  const data = (body as Record<string, unknown>)["data"]
  if (!Array.isArray(data)) return []
  const out: EndpointModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue
    const rec = entry as Record<string, unknown>
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : ""
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const rawTypes = rec["supported_endpoint_types"]
    const endpointTypes = Array.isArray(rawTypes)
      ? rawTypes.filter((t): t is string => typeof t === "string")
      : []
    const ownedBy = typeof rec["owned_by"] === "string" ? rec["owned_by"] : null
    out.push({ id, ownedBy, endpointTypes, chat: isChatCapable(endpointTypes) })
  }
  // Endpoint order is preserved verbatim (dedup keeps the first occurrence):
  // proxies like LiteLLM return a curated order and the picker must mirror it.
  return out
}

/** Finite, strictly-positive number helper for endpoint-reported limits. */
function positiveNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
}

/** The Anthropic effort vocabulary we accept, in `EFFORT_ORDER` display order. */
const ANTHROPIC_EFFORT_KEYS = new Set(["low", "medium", "high", "xhigh", "max"])

/**
 * Parse an Anthropic `/models?limit=1000` body defensively (never throws).
 * `capabilities.image_input.supported` → vision, `capabilities.thinking.supported`
 * → reasoning, and the `capabilities.effort.<key>.supported === true` keys
 * (restricted to low/medium/high/xhigh/max, EFFORT_ORDER) → reasoningEfforts.
 */
export function parseAnthropicModelsResponse(body: unknown): EndpointModel[] {
  if (body === null || typeof body !== "object") return []
  const data = (body as Record<string, unknown>)["data"]
  if (!Array.isArray(data)) return []
  const out: EndpointModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue
    const rec = entry as Record<string, unknown>
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : ""
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const nativeMeta: NativeModelMeta = {}
    if (typeof rec["display_name"] === "string") nativeMeta.name = rec["display_name"]
    const contextLimit = positiveNumber(rec["max_input_tokens"])
    if (contextLimit !== null) {
      // Anthropic reports one number for both the window and the input cap;
      // keep contextLimit for compatibility and mirror it as the input ceiling.
      nativeMeta.contextLimit = contextLimit
      nativeMeta.inputLimit = contextLimit
    }
    const outputLimit = positiveNumber(rec["max_tokens"])
    if (outputLimit !== null) nativeMeta.outputLimit = outputLimit
    const rawCaps = rec["capabilities"]
    const capabilities =
      rawCaps !== null && typeof rawCaps === "object" && !Array.isArray(rawCaps)
        ? (rawCaps as Record<string, unknown>)
        : null
    if (capabilities !== null) {
      const supportedBool = (key: string): boolean | null => {
        const cap = capabilities[key]
        if (cap === null || typeof cap !== "object") return null
        const supported = (cap as Record<string, unknown>)["supported"]
        return typeof supported === "boolean" ? supported : null
      }
      const vision = supportedBool("image_input")
      if (vision !== null) nativeMeta.vision = vision
      const reasoning = supportedBool("thinking")
      if (reasoning !== null) nativeMeta.reasoning = reasoning
      const effort = capabilities["effort"]
      if (effort !== null && typeof effort === "object") {
        const effortRec = effort as Record<string, unknown>
        const values: string[] = []
        for (const key of EFFORT_ORDER) {
          if (!ANTHROPIC_EFFORT_KEYS.has(key)) continue
          const effortEntry = effortRec[key]
          if (
            effortEntry !== null &&
            typeof effortEntry === "object" &&
            (effortEntry as Record<string, unknown>)["supported"] === true
          ) {
            values.push(key)
          }
        }
        if (values.length > 0) nativeMeta.reasoningEfforts = values
      }
    }
    out.push({ id, ownedBy: null, endpointTypes: [], chat: true, nativeMeta })
  }
  // Endpoint order is preserved verbatim (dedup keeps the first occurrence).
  return out
}

/** Strip the `models/` prefix Gemini puts on model names. */
function stripModelsPrefix(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name
}

/**
 * Parse a Gemini `/models?pageSize=1000` body defensively (never throws).
 * The id is `name` without the `models/` prefix; `chat` requires
 * `supportedGenerationMethods` to include `generateContent` (an absent array
 * assumes chat-capable, mirroring the OpenAI-compatible no-types rule).
 * Gemini does not report image support here, so `vision` stays null and
 * models.dev fills it in.
 */
export function parseGoogleModelsResponse(body: unknown): EndpointModel[] {
  if (body === null || typeof body !== "object") return []
  const models = (body as Record<string, unknown>)["models"]
  if (!Array.isArray(models)) return []
  const out: EndpointModel[] = []
  const seen = new Set<string>()
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue
    const rec = entry as Record<string, unknown>
    const rawName = typeof rec["name"] === "string" ? rec["name"].trim() : ""
    const id = stripModelsPrefix(rawName)
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const methods = Array.isArray(rec["supportedGenerationMethods"])
      ? rec["supportedGenerationMethods"].filter((m): m is string => typeof m === "string")
      : []
    const nativeMeta: NativeModelMeta = {}
    if (typeof rec["displayName"] === "string") nativeMeta.name = rec["displayName"]
    const contextLimit = positiveNumber(rec["inputTokenLimit"])
    if (contextLimit !== null) {
      // Gemini's inputTokenLimit is the accepted-input ceiling; keep the
      // historical contextLimit mapping and mirror it as inputLimit.
      nativeMeta.contextLimit = contextLimit
      nativeMeta.inputLimit = contextLimit
    }
    const outputLimit = positiveNumber(rec["outputTokenLimit"])
    if (outputLimit !== null) nativeMeta.outputLimit = outputLimit
    if (typeof rec["thinking"] === "boolean") nativeMeta.reasoning = rec["thinking"]
    out.push({
      id,
      ownedBy: null,
      endpointTypes: [],
      chat: methods.length === 0 ? true : methods.includes("generateContent"),
      nativeMeta,
    })
  }
  return out
}

// ---- models.dev cache ------------------------------------------------------

interface CacheFile {
  fetchedAt: number
  providers: Record<string, unknown>
}

/** Default cache location: SENSUS_CACHE_DIR → SENSUS_HOME sandbox → XDG. */
export function modelsDevCachePath(): string {
  const cacheDir = process.env["SENSUS_CACHE_DIR"]
  if (cacheDir && cacheDir.length > 0) return `${cacheDir.replace(/\/+$/, "")}/models-dev.json`
  const home = process.env["SENSUS_HOME"]
  if (home && home.length > 0) return `${home.replace(/\/+$/, "")}/cache/models-dev.json`
  return `${process.env["HOME"] ?? ""}/.cache/sensus/models-dev.json`
}

/** Parsed-cache memo keyed by path + mtime (StatusBar reads this per frame). */
const cacheMemo = new Map<string, { mtimeMs: number; cache: CacheFile | null }>()

function loadCache(path: string): CacheFile | null {
  try {
    const mtimeMs = Bun.file(path).lastModified
    const memo = cacheMemo.get(path)
    if (memo && memo.mtimeMs === mtimeMs) return memo.cache
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    let cache: CacheFile | null = null
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["fetchedAt"] === "number" &&
      (parsed as Record<string, unknown>)["providers"] !== null &&
      typeof (parsed as Record<string, unknown>)["providers"] === "object"
    ) {
      cache = parsed as CacheFile
    }
    cacheMemo.set(path, { mtimeMs, cache })
    return cache
  } catch {
    cacheMemo.set(path, { mtimeMs: -1, cache: null })
    return null
  }
}

async function fetchModelsDev(opts: CatalogOptions): Promise<CacheFile | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const url = opts.modelsDevUrl ?? modelsDevUrl()
  const timeout = opts.timeoutMs ?? DEFAULT_DEV_TIMEOUT_MS
  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, timeout, doFetch)
    if (!res.ok) return null
    const parsed: unknown = await res.json()
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return { fetchedAt: (opts.now ?? Date.now)(), providers: parsed as Record<string, unknown> }
  } catch {
    return null
  }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch (e) {
      // existsSync races etc. — the write below reports real failures
      log.debug("models.dev cache dir mkdir failed", { err: e })
    }
    writeFileSync(path, JSON.stringify(cache), "utf8")
  } catch (e) {
    // Cache writes are best-effort; enrichment still works this session.
    log.debug("models.dev cache write failed", { err: e })
  }
}

const backgroundRefresh = new Set<string>()

/**
 * Ensure the models.dev cache is usable: fresh → return it; stale → return it
 * AND kick a background refetch; missing → fetch in the foreground (bounded).
 * Any failure yields null (callers degrade to no enrichment).
 */
async function ensureCache(opts: CatalogOptions): Promise<CacheFile | null> {
  const path = opts.cachePath ?? modelsDevCachePath()
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const cached = loadCache(path)
  if (cached && now() - cached.fetchedAt < ttl) return cached
  if (cached === null) {
    // Nothing usable at all: bounded foreground fetch, persisted so the
    // status bar + the next picker open read it without refetching.
    const fresh = await fetchModelsDev(opts)
    if (fresh !== null) writeCache(path, fresh)
    return fresh
  }
  // Stale: use it now, refresh in the background (single-flight per path).
  if (!backgroundRefresh.has(path)) {
    backgroundRefresh.add(path)
    void fetchModelsDev({ ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_DEV_TIMEOUT_MS })
      .then((fresh) => {
        if (fresh !== null) writeCache(path, fresh)
      })
      .catch((e: unknown) => {
        log.debug("models.dev background refresh failed", { err: e })
      })
      .finally(() => backgroundRefresh.delete(path))
  }
  return cached
}

/**
 * The models.dev provider index (one cache check/fetch shared by callers; the
 * memoized cache object is stable, so downstream indexes build once). Null when
 * the index is unavailable — callers degrade to no enrichment.
 */
export async function loadModelsDevProviders(opts: CatalogOptions = {}): Promise<Record<string, unknown> | null> {
  const cache = await ensureCache(opts)
  return cache === null ? null : cache.providers
}

// ---- normalization + matching ----------------------------------------------

/** Lowercase, trim, strip a trailing ":latest" tag. */
export function normalizeModelId(raw: string): string {
  return (raw ?? "").toLowerCase().trim().replace(/:latest$/, "")
}

/** Separator-folded comparison key: dots/dashes/underscores are equivalent. */
export function canonicalModelKey(raw: string): string {
  return normalizeModelId(raw)
    .replace(/[-_.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Candidate ids for an endpoint model (most specific first):
 * the normalized id, the part after an "accounts/…/models/" prefix, and the
 * last path segment ("openai/gpt-4o" → "gpt-4o"). */
export function modelIdCandidates(raw: string): string[] {
  const out: string[] = []
  const push = (s: string): void => {
    if (s.length > 0 && !out.includes(s)) out.push(s)
  }
  const norm = normalizeModelId(raw)
  push(norm)
  const modelsPrefix = "/models/"
  const idx = norm.lastIndexOf(modelsPrefix)
  if (idx >= 0) push(norm.slice(idx + modelsPrefix.length))
  const slash = norm.lastIndexOf("/")
  if (slash >= 0) push(norm.slice(slash + 1))
  return out
}

interface IndexEntry {
  provider: string
  id: string
  meta: ModelMeta
}

interface MatchIndex {
  /** normalized (case/tag-stripped) id → entries. */
  exact: Map<string, IndexEntry[]>
  /** separator-folded key → entries (fallback tier). */
  folded: Map<string, IndexEntry[]>
}

function metaFor(provider: string, id: string, rec: Record<string, unknown>): ModelMeta {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
  const limit = rec["limit"]
  const limitRec = limit !== null && typeof limit === "object" ? (limit as Record<string, unknown>) : {}
  const cost = rec["cost"]
  const costRec = cost !== null && typeof cost === "object" ? (cost as Record<string, unknown>) : {}
  return {
    id,
    provider,
    name: typeof rec["name"] === "string" ? rec["name"] : null,
    context: num(limitRec["context"]),
    // `num` accepts 0; consumers guard `> 0` before treating it as a ceiling.
    input: num(limitRec["input"]),
    output: num(limitRec["output"]),
    toolCall: typeof rec["tool_call"] === "boolean" ? rec["tool_call"] : null,
    costInputPerMtok: num(costRec["input"]),
    costOutputPerMtok: num(costRec["output"]),
    reasoning: typeof rec["reasoning"] === "boolean" ? rec["reasoning"] : null,
    reasoningOptions: parseReasoningOptions(rec["reasoning_options"]),
    temperatureSupported: typeof rec["temperature"] === "boolean" ? rec["temperature"] : null,
    vision: parseVision(rec),
  }
}

/** Image input support from models.dev: prefer `modalities.input`, fall back
 * to the `attachment` flag; null when neither is present. */
function parseVision(rec: Record<string, unknown>): boolean | null {
  const modalities = rec["modalities"]
  if (modalities !== null && typeof modalities === "object" && !Array.isArray(modalities)) {
    const input = (modalities as Record<string, unknown>)["input"]
    if (Array.isArray(input)) return input.some((m) => typeof m === "string" && m.toLowerCase() === "image")
  }
  return typeof rec["attachment"] === "boolean" ? rec["attachment"] : null
}

/** Defensive parse of models.dev `reasoning_options` (never throws). */
export function parseReasoningOptions(raw: unknown): ReasoningOption[] {
  if (!Array.isArray(raw)) return []
  const out: ReasoningOption[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue
    const rec = entry as Record<string, unknown>
    const type = typeof rec["type"] === "string" ? rec["type"] : ""
    if (type.length === 0) continue
    const values = Array.isArray(rec["values"])
      ? rec["values"].filter((v): v is string => typeof v === "string" && v.length > 0)
      : []
    out.push({
      type,
      values,
      min: num2(rec["min"]),
      max: num2(rec["max"]),
      raw: rec,
    })
  }
  return out
}

function num2(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function buildMatchIndex(providers: Record<string, unknown>): MatchIndex {
  const exact = new Map<string, IndexEntry[]>()
  const folded = new Map<string, IndexEntry[]>()
  const add = (map: Map<string, IndexEntry[]>, key: string, entry: IndexEntry): void => {
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }
  for (const [provider, prov] of Object.entries(providers)) {
    if (prov === null || typeof prov !== "object") continue
    const models = (prov as Record<string, unknown>)["models"]
    if (models === null || typeof models !== "object") continue
    for (const [id, rec] of Object.entries(models as Record<string, unknown>)) {
      if (rec === null || typeof rec !== "object") continue
      const entry: IndexEntry = { provider, id, meta: metaFor(provider, id, rec as Record<string, unknown>) }
      add(exact, normalizeModelId(id), entry)
      add(folded, canonicalModelKey(id), entry)
    }
  }
  return { exact, folded }
}

/** Deterministic "best" entry: exact id equality with the candidate first,
 * then the shortest id (closest to what the endpoint advertises), then the
 * protocol's models.dev pin (when set), then lexicographic provider for
 * stability. With no pin the ordering is EXACTLY the historical one. */
function bestEntry(entries: IndexEntry[], candidate: string, preferredProvider?: string | null): IndexEntry {
  const score = (e: IndexEntry): number => {
    if (e.id === candidate) return 0
    if (normalizeModelId(e.id) === candidate) return 1
    return 2 * 1000 + Math.min(e.id.length, 999)
  }
  const preference = (e: IndexEntry): number =>
    preferredProvider !== undefined && preferredProvider !== null && e.provider === preferredProvider ? 0 : 1
  return [...entries].sort(
    (a, b) => score(a) - score(b) || preference(a) - preference(b) || a.provider.localeCompare(b.provider),
  )[0] as IndexEntry
}

/** Look one endpoint model id up in the index; null when unmatched.
 * Index builds are memoized per providers object (the cache memo makes the
 * same object recur across calls — StatusBar matches per render). */
const indexMemo = new WeakMap<Record<string, unknown>, MatchIndex>()

export function matchModelId(
  rawId: string,
  providers: Record<string, unknown>,
  preferredProvider?: string | null,
): ModelMeta | null {
  let index = indexMemo.get(providers)
  if (index === undefined) {
    index = buildMatchIndex(providers)
    indexMemo.set(providers, index)
  }
  return matchWithIndex(rawId, index, preferredProvider)
}

function matchWithIndex(rawId: string, index: MatchIndex, preferredProvider?: string | null): ModelMeta | null {
  for (const candidate of modelIdCandidates(rawId)) {
    const exactHits = index.exact.get(candidate)
    if (exactHits !== undefined && exactHits.length > 0) return bestEntry(exactHits, candidate, preferredProvider).meta
  }
  for (const candidate of modelIdCandidates(rawId)) {
    const foldedHits = index.folded.get(canonicalModelKey(candidate))
    if (foldedHits !== undefined && foldedHits.length > 0) return bestEntry(foldedHits, candidate, preferredProvider).meta
  }
  return null
}

/**
 * Sync metadata lookup for UI chrome (status bar): reads whatever cache file
 * exists (ANY age — stale data beats a network wait), returns null when the
 * cache or match is missing. `opts.preferredProvider` pins the models.dev
 * provider for an ambiguous id. Never throws.
 */
export function lookupModelMeta(modelId: string, opts: CatalogOptions = {}): ModelMeta | null {
  try {
    const cache = loadCache(opts.cachePath ?? modelsDevCachePath())
    if (!cache) return null
    return matchModelId(modelId, cache.providers, opts.preferredProvider)
  } catch {
    return null
  }
}

/**
 * Attach models.dev metadata to endpoint models. Stale caches are used
 * immediately (background-refetched); a missing cache triggers one bounded
 * foreground fetch; offline → models pass through with meta: null.
 * `opts.preferredProvider` is the endpoint protocol's models.dev pin.
 */
export async function enrichModels(
  models: readonly EndpointModel[],
  opts: CatalogOptions = {},
): Promise<CatalogModel[]> {
  const providers = await loadModelsDevProviders(opts)
  if (!providers) return models.map((m) => ({ ...m, meta: null }))
  const index = buildMatchIndex(providers)
  return models.map((m) => ({ ...m, meta: matchWithIndex(m.id, index, opts.preferredProvider) }))
}

/**
 * Warm the models.dev cache at boot (best-effort, never throws). A fresh cache
 * returns immediately; a stale one is returned while a background refetch
 * runs; a missing cache triggers one bounded foreground fetch. Returns true
 * when a usable cache resulted, so the caller can refresh context-limit reads
 * that raced the fetch.
 */
export async function warmModelsDevCache(opts: CatalogOptions = {}): Promise<boolean> {
  try {
    return (await ensureCache(opts)) !== null
  } catch {
    return false
  }
}

// ---- config model overrides --------------------------------------------------

/**
 * Merge a config-level model override (endpoints.<name>.models.<id>,
 * docs/config.md) over the models.dev-enriched metadata. Per field: the
 * override wins; anything it leaves null falls through to the enrichment
 * (null = unknown when neither knows). The override's reasoningEfforts /
 * budget range synthesize the reasoningOptions the thinking-mode picker and
 * the "off" resolution consume — so a config override fully replaces what
 * models.dev advertised for those knobs.
 */
export function mergeModelOverride(base: ModelMeta | null, o: ModelOverride | null): ModelMeta | null {
  if (o === null) return base
  const merged: ModelMeta = {
    id: base?.id ?? "",
    provider: base?.provider ?? "",
    name: base?.name ?? null,
    context: o.contextLimit ?? base?.context ?? null,
    input: o.inputLimit ?? base?.input ?? null,
    output: base?.output ?? null,
    toolCall: o.toolCall ?? base?.toolCall ?? null,
    costInputPerMtok: base?.costInputPerMtok ?? null,
    costOutputPerMtok: base?.costOutputPerMtok ?? null,
    reasoning: o.reasoning ?? base?.reasoning ?? null,
    reasoningOptions: base?.reasoningOptions ?? [],
    temperatureSupported: o.temperatureSupported ?? base?.temperatureSupported ?? null,
    vision: o.vision ?? base?.vision ?? null,
  }
  if (o.reasoningEfforts !== null) {
    merged.reasoningOptions = [{ type: "effort", values: o.reasoningEfforts, min: null, max: null, raw: {} }]
  }
  if (o.reasoningBudgetMin !== null || o.reasoningBudgetMax !== null) {
    const existing = merged.reasoningOptions.find((opt) => opt.type === "budget_tokens")
    merged.reasoningOptions = [
      ...merged.reasoningOptions.filter((opt) => opt.type !== "budget_tokens"),
      {
        type: "budget_tokens",
        values: [],
        min: o.reasoningBudgetMin ?? existing?.min ?? null,
        max: o.reasoningBudgetMax ?? existing?.max ?? null,
        raw: {},
      },
    ]
  }
  return merged
}

// ---- native endpoint metadata (Anthropic capabilities / Gemini limits) ------

/**
 * Merge endpoint-REPORTED metadata (`native`) per field OVER models.dev
 * (`base`): a non-null native value wins, everything else falls through to
 * `base` — and a config override (`mergeModelOverride`) is applied last, so
 * the precedence is config override > endpoint /models > models.dev. An
 * empty/native-null input returns `base` unchanged (null when base is null
 * too). `provider`/`id`/`toolCall`/`temperatureSupported`/cost come from base.
 *
 * `native.reasoningEfforts` REPLACES only the `effort`-typed option, keeping
 * other option types (e.g. models.dev's budget_tokens range).
 */
export function mergeNativeMeta(base: ModelMeta | null, native: NativeModelMeta | null | undefined): ModelMeta | null {
  if (native === null || native === undefined) return base
  const hasEfforts =
    native.reasoningEfforts !== null && native.reasoningEfforts !== undefined && native.reasoningEfforts.length > 0
  const hasAny =
    native.name != null ||
    native.contextLimit != null ||
    native.inputLimit != null ||
    native.outputLimit != null ||
    native.vision != null ||
    native.reasoning != null ||
    hasEfforts
  if (!hasAny) return base
  let reasoningOptions = base?.reasoningOptions ?? []
  if (hasEfforts) {
    reasoningOptions = [
      ...reasoningOptions.filter((opt) => opt.type !== "effort"),
      {
        type: "effort",
        values: [...(native.reasoningEfforts as string[])],
        min: null,
        max: null,
        raw: {},
      },
    ]
  }
  return {
    id: base?.id ?? "",
    provider: base?.provider ?? "",
    name: native.name ?? base?.name ?? null,
    context: native.contextLimit ?? base?.context ?? null,
    input: native.inputLimit ?? base?.input ?? null,
    output: native.outputLimit ?? base?.output ?? null,
    toolCall: base?.toolCall ?? null,
    costInputPerMtok: base?.costInputPerMtok ?? null,
    costOutputPerMtok: base?.costOutputPerMtok ?? null,
    reasoning: native.reasoning ?? base?.reasoning ?? null,
    reasoningOptions,
    temperatureSupported: base?.temperatureSupported ?? null,
    vision: native.vision ?? base?.vision ?? null,
  }
}

// ---- formatting ------------------------------------------------------------

/** "262144" → "262k", "128000" → "128k", "1000000" → "1M". null-safe. */
export function formatContextLimit(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : Math.round(m * 10) / 10}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// ---- thinking modes (models.dev reasoning metadata) -------------------------

/**
 * A thinking-mode selection. Three user-facing shapes (slash /effort, status
 * chip, profile `thinkingMode`):
 *   "default"    — omit the knob entirely (provider default)
 *   "off"        — the LOWEST advertised effort ("none"/"minimal") — the only
 *                  portable off across OpenAI-compatible endpoints
 *   "budget:<n>" — a token budget (Anthropic-style reasoning.max_tokens)
 *   anything else — an effort keyword passed as reasoning_effort ("low",
 *                  "medium", "high", "xhigh", "max", …)
 */
export type ThinkingMode =
  | { kind: "default" }
  | { kind: "off" }
  | { kind: "effort"; effort: string }
  | { kind: "budget"; tokens: number }

/** Parse a user/config thinking-mode string; null when not a valid mode. */
export function parseThinkingMode(raw: string): ThinkingMode | null {
  const s = (raw ?? "").trim().toLowerCase()
  if (s === "" || s === "default") return { kind: "default" }
  if (s === "off") return { kind: "off" }
  const budget = /^budget:(\d+)$/.exec(s)
  if (budget) {
    const n = Number(budget[1])
    if (Number.isFinite(n) && n > 0) return { kind: "budget", tokens: Math.floor(n) }
    return null
  }
  if (/^[a-z][a-z0-9_-]*$/.test(s)) return { kind: "effort", effort: s }
  return null
}

/** Ordered effort vocabulary (models.dev) — sort + "lowest" anchor. */
export const EFFORT_ORDER: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

function effortRank(v: string): number {
  const i = EFFORT_ORDER.indexOf(v.toLowerCase())
  return i >= 0 ? i : EFFORT_ORDER.length + Math.min(v.length, 99)
}

/** The model's advertised effort values, vocabulary order. */
export function effortValues(meta: ModelMeta | null): string[] {
  const opt = meta?.reasoningOptions.find((o) => o.type === "effort")
  if (!opt) return []
  return [...opt.values].sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b))
}

/** Budget min/max when the model advertises budget_tokens reasoning. */
export function budgetRange(meta: ModelMeta | null): { min: number | null; max: number | null } | null {
  const opt = meta?.reasoningOptions.find((o) => o.type === "budget_tokens")
  if (!opt) return null
  return { min: opt.min, max: opt.max }
}

/** True when the model advertises a plain reasoning on/off toggle. */
export function hasToggleReasoning(meta: ModelMeta | null): boolean {
  return meta?.reasoningOptions.some((o) => o.type === "toggle") ?? false
}

/** The model's highest advertised effort (the default when none is chosen). */
export function highestEffort(meta: ModelMeta | null): string | null {
  const values = effortValues(meta)
  return values.length > 0 ? (values[values.length - 1] ?? null) : null
}

/**
 * The mode a model uses when the user has not chosen one: its HIGHEST
 * advertised setting, mirroring models.dev only. `null` when the model
 * advertises no knob (nothing to send — e.g. a non-reasoner).
 */
export function defaultThinkingMode(meta: ModelMeta | null): string | null {
  const top = highestEffort(meta)
  if (top !== null) return top
  const max = budgetRange(meta)?.max
  if (typeof max === "number" && Number.isFinite(max) && max > 0) return `budget:${Math.floor(max)}`
  if (hasToggleReasoning(meta)) return "on"
  return null
}

/** What goes on the wire for a thinking-mode selection. */
export interface ThinkingKnob {
  /** OpenAI-style `reasoning_effort` (the provider maps it natively). */
  reasoningEffort?: string
  /** Anthropic-style budget → unified `reasoning: {max_tokens}` body field. */
  reasoningBudgetTokens?: number
  /** Toggle-style reasoning → unified `reasoning: {enabled}` body field. */
  reasoningEnabled?: boolean
}

/**
 * Resolve a thinking-mode string against the model's models.dev metadata
 * (the metadata ADVISES — an explicit user effort choice is always sent).
 * An unset mode resolves to the model's HIGHEST advertised setting, so a
 * reasoning model reasons by default; null = send nothing (no advertised knob).
 */
export function resolveThinkingKnob(mode: string | null | undefined, meta: ModelMeta | null): ThinkingKnob | null {
  const parsed = parseThinkingMode(mode ?? "")
  if (parsed === null) return null
  if (parsed.kind === "default") {
    const fallback = defaultThinkingMode(meta)
    return fallback === null ? null : resolveThinkingKnob(fallback, meta)
  }
  if (parsed.kind === "effort") {
    // A toggle-only model expresses on/off as an enable flag, not an effort
    // keyword ("on" parses as an effort token).
    const toggleOnly = hasToggleReasoning(meta) && effortValues(meta).length === 0
    if (toggleOnly && (parsed.effort === "on" || parsed.effort === "off")) {
      return { reasoningEnabled: parsed.effort === "on" }
    }
    return { reasoningEffort: parsed.effort }
  }
  if (parsed.kind === "budget") {
    const range = budgetRange(meta)
    let tokens = parsed.tokens
    if (range?.min !== null && range?.min !== undefined && tokens < range.min) tokens = range.min
    if (range?.max !== null && range?.max !== undefined && tokens > range.max) tokens = range.max
    return { reasoningBudgetTokens: tokens }
  }
  // "off": the lowest advertised effort — "none" then "minimal". A toggle-only
  // model turns reasoning off; without metadata there is no portable off, so
  // the knob is omitted.
  const values = effortValues(meta)
  const lowest = values.find((v) => v.toLowerCase() === "none") ?? values.find((v) => v.toLowerCase() === "minimal")
  if (lowest !== undefined) return { reasoningEffort: lowest }
  if (hasToggleReasoning(meta) && values.length === 0) return { reasoningEnabled: false }
  return null
}

/**
 * Reasoning knob for a mechanical one-shot pass (chat compaction): the model's
 * LOWEST advertised effort so hidden thinking cannot
 * consume the whole output budget and starve the answer. For a budget-style
 * model (Anthropic via a gateway) the advertised minimum budget is used. Null
 * when the model advertises neither — the pass then omits the field entirely,
 * because a strict endpoint that never advertised reasoning may 400 on it.
 */
export function oneShotThinkingKnob(meta: ModelMeta | null): ThinkingKnob | null {
  const lowestEffort = effortValues(meta)[0]
  if (lowestEffort !== undefined) return { reasoningEffort: lowestEffort }
  const min = budgetRange(meta)?.min
  if (typeof min === "number" && Number.isFinite(min) && min > 0) return { reasoningBudgetTokens: Math.floor(min) }
  return null
}

/** Budget presets offered in pickers/cycles (clamped to the advertised range). */
function budgetChoices(meta: ModelMeta | null): string[] {
  const range = budgetRange(meta)
  const min = range?.min ?? 1024
  const max = range?.max ?? 32768
  const out: string[] = []
  for (const n of [1024, 4096, 8192, 16384, 32768, 65536]) {
    if (n >= min && n <= max) out.push(`budget:${n}`)
  }
  if (out.length === 0) out.push(`budget:${min}`)
  return out
}

/**
 * Cycle/picker choices for a model: the model's OWN advertised settings, and
 * nothing synthetic — models.dev is the single source of truth. Effort values
 * come first (vocabulary order), then budget presets when the model advertises
 * a budget_tokens option; a toggle-only model gets `off`/`on`. An unknown model
 * (no metadata) has no choices — the control is driven by `/effort <mode>`
 * alone, never by invented keywords.
 */
export function thinkingChoices(meta: ModelMeta | null): string[] {
  const out = effortValues(meta)
  if (budgetRange(meta) !== null) out.push(...budgetChoices(meta))
  if (out.length === 0 && hasToggleReasoning(meta)) return ["off", "on"]
  return out
}

/** Next entry of a choices cycle after `current` (for the status chip). An
 * unknown/absent current anchors on the model's metadata default (highest). */
export function cycleThinkingMode(current: string, meta: ModelMeta | null): string {
  const choices = thinkingChoices(meta)
  if (choices.length === 0) return current
  const idx = choices.indexOf(current)
  if (idx === -1) return defaultThinkingMode(meta) ?? (choices[0] as string)
  return choices[(idx + 1) % choices.length] as string
}

/** One-line human description of a resolved knob (toasts, /effort). */
export function knobDescription(knob: ThinkingKnob | null): string {
  if (knob === null) return "omitted (provider default)"
  if (knob.reasoningEnabled !== undefined) return `reasoning.enabled = ${knob.reasoningEnabled}`
  if (knob.reasoningBudgetTokens !== undefined) return `reasoning.max_tokens = ${knob.reasoningBudgetTokens}`
  return `reasoning_effort = ${knob.reasoningEffort}`
}
