/**
 * Model catalog resource (P4c-ii; docs/daemon-api.md "Routes", docs/config.md
 * "Model picker").
 *
 * `GET /v1/models` is the engine-free source the ModelPicker overlay needs: it
 * fetches every configured endpoint's `GET {baseURL}/models` (in parallel),
 * enriches the rows with models.dev metadata, and merges each endpoint's
 * per-model config overrides over the enrichment — exactly the pipeline the TUI
 * runs in-process. The daemon owns the config (D13), so the resolved endpoint
 * credentials never cross the wire and only `hasKey` is reported.
 *
 * Never throws: a per-endpoint fetch failure lands in `errors`, a models.dev
 * failure degrades to `meta: null` rows, and an absent cache still lists the
 * endpoint's own models.
 */

import { Elysia } from "elysia"
import { getLogger } from "../core/log.ts"
import { expandEnvRefs } from "../agent/mcp/types.ts"
import { sensusHome } from "../config/config.ts"
import { loadSecrets } from "../config/secrets.ts"
import {
  canonicalProvider,
  fetchModels,
  loadModelsDevProviders,
  matchModelId,
  mergeModelOverride,
  mergeNativeMeta,
  PROTOCOLS,
  resolveBaseURL,
  type CatalogModel,
  type EndpointConfig,
  type ProtocolKind,
  type SensusConfig,
} from "../engine/index.ts"
import {
  internalErrorResponse,
  invalidRequestResponse,
  jsonResponse,
  modelsResponseSchema,
  probeEndpointBodySchema,
  probeModelsResponseSchema,
  requestBody,
  unauthorizedResponse,
} from "./apiSchemas.ts"

/** One endpoint's catalog (config-derived, credential-free). */
export interface DaemonModelEndpoint {
  name: string
  baseURL: string
  provider: string
  /** A credential (or the mock seam) is present — chat is usable. */
  hasKey: boolean
  /** The endpoint's own model order, enriched + config-override merged. */
  models: CatalogModel[]
}

export interface DaemonModelsResult {
  endpoints: DaemonModelEndpoint[]
  /** Per-endpoint fetch failures as `"<name>: <reason>"`. */
  errors: string[]
}

export interface BuildModelCatalogOptions {
  /** Test seam: injected `fetch` for both the endpoint and models.dev. */
  fetchImpl?: typeof fetch
  /** Test seam: models.dev index URL. */
  modelsDevUrl?: string
  /** Test seam: models.dev cache file path. */
  cachePath?: string
}

/** Whether an endpoint can talk to a provider (matches `ChatSession.hasKey`). */
export function endpointHasKey(ep: Pick<EndpointConfig, "provider" | "apiKey">): boolean {
  if (ep.provider === "mock" || process.env["SENSUS_MOCK"] === "1") return true
  return ep.apiKey.length > 0
}

/** The models.dev provider a protocol pins to (null for mock/unknown kinds). */
function protocolPin(provider: string | undefined): string | null {
  const kind = canonicalProvider(provider)
  if (kind === null || kind === "mock") return null
  return PROTOCOLS[kind].modelsDevProvider
}

/**
 * Fetch + enrich every endpoint's models. ONE models.dev load, then each
 * endpoint's models are matched against it with the endpoint protocol's
 * models.dev pin (the same id can exist under several providers with different
 * metadata — enrichment must never be shared across endpoints), and each
 * endpoint's config overrides are merged per-field last.
 */
export async function buildModelCatalog(
  config: SensusConfig,
  opts: BuildModelCatalogOptions = {},
): Promise<DaemonModelsResult> {
  const entries = Object.entries(config.endpoints)
  const fetched = await Promise.all(
    entries.map(async ([name, ep]) => ({
      name,
      ep,
      result: await fetchModels(
        { provider: ep.provider, baseURL: ep.baseURL, apiKey: ep.apiKey },
        { fetchImpl: opts.fetchImpl },
      ),
    })),
  )

  const errors: string[] = []
  for (const f of fetched) {
    if (f.result.error !== null) errors.push(`${f.name}: ${f.result.error}`)
  }

  // ONE cache check/fetch shared by every endpoint; matching stays per-endpoint
  // so the protocol pin selects the right provider's metadata.
  const providers = await loadModelsDevProviders({
    fetchImpl: opts.fetchImpl,
    modelsDevUrl: opts.modelsDevUrl,
    cachePath: opts.cachePath,
  })

  const endpoints: DaemonModelEndpoint[] = fetched.map((f) => {
    const pin = protocolPin(f.ep.provider)
    const models: CatalogModel[] = f.result.models.map((m) => {
      const base = providers ? matchModelId(m.id, providers, pin) : null
      return {
        ...m,
        meta: mergeModelOverride(mergeNativeMeta(base, m.nativeMeta), f.ep.models[m.id] ?? null),
      }
    })
    return {
      name: f.name,
      baseURL: f.ep.baseURL,
      provider: f.ep.provider,
      hasKey: endpointHasKey(f.ep),
      models,
    }
  })

  return { endpoints, errors }
}

// ---- draft-endpoint probe (wizard/settings "test connection") ---------------

/** A draft endpoint the wizard/settings can test before saving it. */
export interface ProbeEndpointInput {
  /** Raw provider value; canonicalized (unknown/absent → openai-compatible, `mock` lists as openai-compatible). */
  provider?: string
  /** Empty/absent resolves to the protocol's default base URL. */
  baseURL?: string
  /** Used transiently for this probe only — never logged, persisted, or returned. */
  apiKey?: string
  /** Overrides the listing timeout. */
  timeoutMs?: number
}

export interface ProbeModelsResult {
  models: CatalogModel[]
  /** null on success; the fetch failure reason otherwise (never the apiKey). */
  error: string | null
}

/**
 * Expand `${NAME}` apiKey refs for a probe exactly like config resolution does
 * (docs/config.md "Secrets"): the encrypted store first, then the process env;
 * a literal key passes through unchanged. Best-effort — an unreadable store
 * still resolves from the process env.
 */
function resolveProbeKey(raw: string | undefined): string | undefined {
  if (raw === undefined || !raw.includes("${")) return raw
  const env: NodeJS.ProcessEnv = { ...process.env }
  try {
    for (const [name, value] of Object.entries(loadSecrets(sensusHome()).values)) env[name] = value
  } catch (e) {
    getLogger().child({ component: "daemon.models" }).debug("probe secret store load failed", { err: e })
  }
  return expandEnvRefs(raw, env).value
}

/**
 * List + enrich a DRAFT endpoint's models (no config overrides): the same
 * protocol-aware fetch and native-meta merge as `buildModelCatalog`, for just
 * this endpoint. Never throws; failures come back in `error`.
 */
export async function probeEndpointModels(
  input: ProbeEndpointInput,
  opts: BuildModelCatalogOptions = {},
): Promise<ProbeModelsResult> {
  const kind = canonicalProvider(input.provider) ?? "openai-compatible"
  const listing: ProtocolKind = kind === "mock" ? "openai-compatible" : kind
  const baseURL = resolveBaseURL(listing, input.baseURL)
  // The draft key may be a `${NAME}` ref (the raw config is secret-free): expand
  // it like config resolution so testing a SAVED endpoint keeps working.
  const apiKey = resolveProbeKey(input.apiKey)
  const result = await fetchModels(
    { provider: kind, baseURL, apiKey },
    { fetchImpl: opts.fetchImpl, timeoutMs: input.timeoutMs },
  )
  const providers = await loadModelsDevProviders({
    fetchImpl: opts.fetchImpl,
    modelsDevUrl: opts.modelsDevUrl,
    cachePath: opts.cachePath,
  })
  const pin = kind === "mock" ? null : PROTOCOLS[kind].modelsDevProvider
  const models: CatalogModel[] = result.models.map((m) => ({
    ...m,
    meta: mergeNativeMeta(providers ? matchModelId(m.id, providers, pin) : null, m.nativeMeta),
  }))
  return { models, error: result.error }
}

export interface ModelRoutesDeps {
  /** The catalog builder; defaults to an empty catalog (route-only tests). */
  models?: () => Promise<DaemonModelsResult>
  /** Draft-endpoint probe; defaults to an empty success (route-only tests). */
  probe?: (input: ProbeEndpointInput) => Promise<ProbeModelsResult>
}

/** Mount the model catalog routes (auth is applied globally by the parent app). */
export function modelRoutes(deps: ModelRoutesDeps = {}) {
  return new Elysia({ name: "sensus-daemon-models" })
    .get(
      "/v1/models",
      async ({ set }) => {
        try {
          const result = await (deps.models?.() ?? Promise.resolve({ endpoints: [], errors: [] }))
          return { ok: true, endpoints: result.endpoints, errors: result.errors }
        } catch (err) {
          getLogger().child({ component: "daemon.models" }).warn("model catalog build failed", { err })
          set.status = 500
          return { error: "internal_error" }
        }
      },
      {
        detail: {
          tags: ["models"],
          operationId: "listModels",
          summary: "Enriched, credential-free model catalog",
          description:
            "Fetches every configured endpoint's model list over its protocol (`GET {baseURL}/models` for openai-compatible/openai-responses, Anthropic's `x-api-key` listing, Gemini's `x-goog-api-key` listing), enriches with models.dev metadata pinned per protocol and layered with endpoint-native metadata, and merges each endpoint's per-model overrides last. Only `hasKey` is reported — a resolved key is never returned. A per-endpoint fetch failure lands in `errors`.",
          responses: {
            200: jsonResponse(modelsResponseSchema, "The model catalog plus any per-endpoint fetch errors."),
            401: unauthorizedResponse(),
            500: internalErrorResponse("The catalog builder threw."),
          },
        },
      },
    )
    .post(
      "/v1/models/probe",
      async ({ body, set }) => {
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          set.status = 400
          return { error: "invalid_request" }
        }
        const rec = body as Record<string, unknown>
        const input: ProbeEndpointInput = {}
        if (typeof rec["provider"] === "string") input.provider = rec["provider"]
        if (typeof rec["baseURL"] === "string") input.baseURL = rec["baseURL"]
        if (typeof rec["apiKey"] === "string") input.apiKey = rec["apiKey"]
        try {
          const result = await (deps.probe?.(input) ?? Promise.resolve({ models: [], error: null }))
          return { ok: true as const, models: result.models, error: result.error }
        } catch (err) {
          // NEVER log the request body: it carries the transient API key.
          getLogger().child({ component: "daemon.models" }).warn("model probe failed", { err })
          set.status = 500
          return { error: "internal_error" }
        }
      },
      {
        detail: {
          tags: ["models"],
          operationId: "probeModels",
          summary: "Probe a draft endpoint's model list",
          description:
            "Tests a DRAFT endpoint (provider + baseURL + apiKey, possibly not saved yet) by running the protocol-aware `GET {baseURL}/models` + models.dev enrichment. An empty `baseURL` uses the protocol default. The `apiKey` is used transiently for this request only — it is never logged, persisted, or returned; the response carries the enriched models plus any fetch error.",
          requestBody: requestBody(probeEndpointBodySchema, "The draft endpoint; every field is optional."),
          responses: {
            200: jsonResponse(probeModelsResponseSchema, "The draft endpoint's enriched models plus any fetch error."),
            400: invalidRequestResponse("A non-object JSON body."),
            401: unauthorizedResponse(),
            500: internalErrorResponse("The probe builder threw."),
          },
        },
      },
    )
}
