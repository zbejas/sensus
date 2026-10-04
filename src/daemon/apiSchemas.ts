/**
 * TypeBox response schemas for the daemon OpenAPI/Scalar spec (docs/daemon-api.md).
 *
 * These schemas are attached to each route through the OpenAPI `detail.responses`
 * block (see `openapi.ts` builders), so they are **documentation only** — Elysia
 * never validates a handler's return value against them. Handlers stay the
 * source of truth for behavior (defensive, `{error}`-shaped failures, store
 * domain refusals as `200 {ok:false}`); the schemas describe that behavior to a
 * caller reading the Scalar reference.
 *
 * `ok` in a success envelope is `t.Literal(true)` so the spec carries the
 * constant, matching the actual payloads. Field descriptions are the primary
 * docs — keep them accurate when a handler's shape changes.
 */

import { t, type TSchema } from "elysia"

// ── Response helpers ────────────────────────────────────────────────────────
//
// Elysia types `detail.responses`/`detail.requestBody` as OpenAPI objects whose
// `schema` is nominally narrower than TypeBox's `TSchema` (e.g. TypeBox's
// `TInteger.exclusiveMaximum` is a number where OpenAPI wants a boolean). These
// helpers return `any` — the same openness as the `detail` metadata itself — so
// a TypeBox schema can be attached as documentation without a cast at each of
// the ~20 call sites.

/** A `responses` entry for the OpenAPI operation object. */
export interface ApiResponse {
  description: string
  content?: Record<string, { schema: TSchema }>
}

/** A JSON `200`/failure response entry. */
export function jsonResponse(schema: TSchema, description = "OK"): any {
  return { description, content: { "application/json": { schema } } }
}

/** A response entry with several media types (e.g. json + ndjson + csv). */
export function mediaResponse(content: Record<string, { schema: TSchema }>, description = "OK"): any {
  return { description, content }
}

/** A raw text/file response entry (markdown, ndjson, csv). */
export function textResponse(contentType: string, description = "OK"): any {
  return { description, content: { [contentType]: { schema: t.String() } } }
}

/** A JSON `requestBody` entry carrying a TypeBox schema. */
export function requestBody(schema: TSchema, description?: string, required = true): any {
  return { required, ...(description === undefined ? {} : { description }), content: { "application/json": { schema } } }
}

/** The shared `{ error }` body every failure returns. */
export const errorSchema = t.Object(
  {
    error: t.String({
      enum: ["unauthorized", "invalid_request", "not_found", "internal_error"],
      description: "Machine-readable failure code.",
    }),
  },
  { description: "The one failure shape every route returns (docs/daemon-api.md)." },
)

/** A `401` — missing or wrong bearer token. */
export function unauthorizedResponse(
  description = "Missing or wrong bearer token; the response carries `WWW-Authenticate: Bearer`.",
): any {
  return { description, content: { "application/json": { schema: errorSchema } } }
}

/** A `400` — structurally bad request. */
export function invalidRequestResponse(
  description = "Structurally bad filter/cursor/format/body or an unknown path parameter.",
): any {
  return { description, content: { "application/json": { schema: errorSchema } } }
}

/** A `404` — unknown route or resource. */
export function notFoundResponse(description = "Unknown route or resource."): any {
  return { description, content: { "application/json": { schema: errorSchema } } }
}

/** A `500` — an unexpected throw surfaced as JSON. */
export function internalErrorResponse(description = "An unexpected throw, surfaced as JSON (never an unhandled exception)."): any {
  return { description, content: { "application/json": { schema: errorSchema } } }
}

// ── Shared scalars ──────────────────────────────────────────────────────────

/** The three agent memory stores (docs/memory.md). */
export const memoryTargetSchema = t.Union([t.Literal("memory"), t.Literal("host"), t.Literal("journal")])

// ── Core ────────────────────────────────────────────────────────────────────

export const healthSchema = t.Object(
  {
    ok: t.Literal(true),
    name: t.Literal("sensus-daemon"),
    version: t.String({ description: "The daemon's version (package.json)." }),
  },
  { description: "Cheap liveness payload; the readiness probe `sensus daemon start` waits on." },
)

/** The installation identity (docs/events.md). */
export const instanceSchema = t.Object({
  instanceId: t.String({ description: "Stable ULID-like installation id." }),
  createdAt: t.Integer({ description: "Epoch ms of first creation." }),
  version: t.String({ description: "The sensus version that last wrote it." }),
})

export const infoSchema = t.Object(
  {
    ok: t.Literal(true),
    name: t.Literal("sensus-daemon"),
    version: t.String(),
    pid: t.Integer(),
    platform: t.String(),
    startedAt: t.Integer({ description: "Epoch ms the daemon process started." }),
    uptimeMs: t.Integer({ description: "Milliseconds since `startedAt`, sampled per request." }),
    socket: t.String({ description: "Unix socket path the API is bound to." }),
    tcp: t.Object(
      { host: t.String(), port: t.Integer() },
      { description: "Loopback TCP address; `port` is the actual bound (ephemeral) port." },
    ),
    shells: t.Integer({ description: "Live PTY shells the daemon currently owns." }),
    persistent: t.Boolean({ description: "True when the daemon never grace-exits." }),
    instance: instanceSchema,
  },
  { description: "Daemon facts: process, transports, live shells and the machine identity." },
)

// ── Config + secrets ────────────────────────────────────────────────────────

/** Free-form config object; the daemon redacts resolved secrets (docs/daemon-api.md). */
export const redactedConfigSchema = t.Object({}, {
  additionalProperties: true,
  description: "Effective config (defaults → file → env → flags) with every resolved secret redacted; `${NAME}` references are kept verbatim.",
})

export const configResponseSchema = t.Object(
  { ok: t.Literal(true), config: redactedConfigSchema },
  { description: "The effective, redacted config (D13)." },
)

export const rawConfigResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    raw: t.Object({}, {
      additionalProperties: true,
      description: "The raw `config.json` document, secrets included — the settings editor round-trips it. Bearer-gated and local-only.",
    }),
  },
  { description: "The UNREDACTED raw config used by the settings editor." },
)

export const configWriteResponseSchema = t.Union([
  t.Object(
    {
      ok: t.Literal(true),
      config: redactedConfigSchema,
      captured: t.Array(t.String(), { description: "Secret names moved into the encrypted store by this write." }),
      backupCreated: t.Boolean({ description: "True when a one-time `.bak` was written." }),
    },
    { description: "A committed config write: the new redacted config plus the secret names captured." },
  ),
  t.Object(
    { ok: t.Literal(false), message: t.String({ description: "The precise refusal reason." }) },
    { description: "A store-domain refusal (e.g. an unreadable secrets store) — still HTTP 200." },
  ),
])

export const secretsResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    names: t.Array(t.String(), { description: "Stored secret NAMES only; a value is never returned." }),
    warnings: t.Array(t.String()),
  },
  { description: "The stored secret names (write-only values)." },
)

export const secretWriteResponseSchema = t.Union([
  t.Object({ ok: t.Literal(true), name: t.String() }),
  t.Object({ ok: t.Literal(false), message: t.String() }),
])

export const secretDeleteResponseSchema = t.Union([
  t.Object({ ok: t.Literal(true), name: t.String(), removed: t.Literal(true) }),
  t.Object({ ok: t.Literal(false), message: t.String() }),
])

// ── Agents + skills ─────────────────────────────────────────────────────────

export const agentSummarySchema = t.Object(
  {
    name: t.String(),
    description: t.String(),
    tools: t.Nullable(t.Array(t.String()), { description: "Core tool allowlist; null = all." }),
    skills: t.Nullable(t.Array(t.String()), { description: "Skill allowlist; null = all." }),
    sudoPrompt: t.String(),
    shell: t.String(),
    path: t.String({ description: "Absolute path of the definition file." }),
    prompt: t.String({ description: "The prompt body (the picker preview)." }),
  },
  { description: "A one-line projection of an agent definition." },
)

export const agentsResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    agents: t.Array(agentSummarySchema),
    warnings: t.Array(t.String(), { description: "Non-fatal load warnings (e.g. a malformed definition)." }),
  },
  { description: "The read-only agent definitions from the config home." },
)

export const skillSummarySchema = t.Object({
  name: t.String(),
  description: t.String(),
  path: t.String(),
})

export const skillsResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    skills: t.Array(skillSummarySchema, { description: "Name/description index only — skill bodies are progressive-disclosure." }),
    warnings: t.Array(t.String()),
  },
  { description: "The read-only skill index (name/description, no bodies)." },
)

// ── Memory ──────────────────────────────────────────────────────────────────

export const memoryUsageSchema = t.Object({
  target: memoryTargetSchema,
  used: t.Integer({ description: "Rendered content length (entries joined by `§`)." }),
  limit: t.Integer({ description: "Hard character cap for the store." }),
  percent: t.Integer({ description: "Integer percent of the cap, clamped 0–100." }),
  entries: t.Integer(),
})

/** The structured char delta a committed memory write records (docs/extensions.md). */
export const memoryWriteSchema = t.Object({
  target: memoryTargetSchema,
  action: t.String({ description: "The action that committed (`add`/`replace`/`remove`/`rewrite`/`prune`)." }),
  beforeChars: t.Integer(),
  afterChars: t.Integer(),
  delta: t.Integer({ description: "`afterChars - beforeChars` (negative = the store shrank)." }),
})

export const memoryListResponseSchema = t.Object(
  { ok: t.Literal(true), targets: t.Array(memoryUsageSchema, { description: "Usage for MEMORY/HOST/JOURNAL, in display order." }) },
  { description: "Live usage for all three memory stores." },
)

export const memoryReadResponseSchema = t.Object({
  ok: t.Literal(true),
  target: memoryTargetSchema,
  content: t.String({ description: "The rendered store content (`\"\"` when empty)." }),
  entries: t.Array(t.String()),
  usage: memoryUsageSchema,
})

export const memoryEditRequestSchema = t.Object(
  {
    action: t.String({ enum: ["add", "replace", "remove", "rewrite", "prune"], description: "The mutation to apply." }),
    content: t.Optional(t.String({ description: "`add`/`replace`/`rewrite`: the new body." })),
    old_text: t.Optional(t.String({ description: "`replace`/`remove`: the anchor text to match." })),
    keep_chars: t.Optional(t.Integer({ description: "`prune`: retain this many characters (default applies when omitted)." })),
  },
  { description: "A memory-store edit. Required fields depend on `action`." },
)

export const memoryEditResponseSchema = t.Object(
  {
    ok: t.Boolean(),
    target: t.Optional(memoryTargetSchema),
    action: t.Optional(t.String()),
    message: t.Optional(t.String({ description: "The store's precise success note or domain refusal." })),
    content: t.Optional(t.String()),
    entries: t.Optional(t.Array(t.String())),
    usage: t.Optional(memoryUsageSchema),
    write: t.Optional(memoryWriteSchema),
  },
  { description: "A committed write (`ok:true` + `write`) or a store-domain refusal (`ok:false` + `message`) — both HTTP 200." },
)

// ── Audit ───────────────────────────────────────────────────────────────────

export const auditRecordSchema = t.Object(
  {
    ts: t.Integer({ description: "Epoch ms." }),
    session: t.String({ description: "Per-run instance id — not a transcript id." }),
    kind: t.String({ description: "Coarse kind: file/memory/shell/session/turn/skill/error/other." }),
    tool: t.Nullable(t.String(), { description: "Tool name; null for events that carry none." }),
    summary: t.String({ description: "One-line description." }),
    ok: t.Boolean(),
    path: t.Optional(t.String({ description: "File writes: absolute path." })),
    before: t.Optional(t.Nullable(t.String(), { description: "File writes: prior content (null = did not exist)." })),
    undone: t.Optional(t.Boolean({ description: "True once an undo consumed this entry." })),
    refTs: t.Optional(t.Integer({ description: "On an undo tombstone: the ts it consumed." })),
    source: t.Union([t.Literal("legacy"), t.Literal("events")], { description: "Which log the record came from." }),
    type: t.Optional(t.String({ description: "Event discriminator; events source only." })),
  },
  { description: "One source-agnostic audit record." },
)

export const auditListResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    records: t.Array(auditRecordSchema),
    nextCursor: t.Nullable(t.String(), { description: "Opaque cursor for the next page; null at the end." }),
  },
  { description: "A filtered, newest-first page of audit records." },
)

export const auditStatsResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    total: t.Integer(),
    byKind: t.Record(t.String(), t.Integer()),
    byTool: t.Record(t.String(), t.Integer()),
    bySession: t.Record(t.String(), t.Integer()),
  },
  { description: "Audit counts by kind/tool/session over the same filter; maps are bounded (overflow collapses to `(other)`)." },
)

// ── Sessions ────────────────────────────────────────────────────────────────

export const sessionSummarySchema = t.Object(
  {
    id: t.String({ description: "`<instance-id>/<base>`." }),
    title: t.String({ description: "Sidecar title, else the derived first user message." }),
    tab: t.Nullable(t.Integer(), { description: "Tab number parsed from `<base>`; null when unrecognized." }),
    mtime: t.Integer({ description: "File mtime (epoch ms)." }),
    size: t.Integer({ description: "File size in bytes." }),
    tags: t.Array(t.String()),
    messages: t.Integer({ description: "Number of user/assistant records (never 0)." }),
    lastTs: t.Nullable(t.Integer(), { description: "Last event timestamp (epoch ms), or null." }),
    path: t.String({ description: "Absolute transcript path (the client reads/deletes by it)." }),
  },
  { description: "One row in the persisted-session listing." },
)

export const sessionListResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    sessions: t.Array(sessionSummarySchema),
    nextOffset: t.Nullable(t.Integer(), { description: "Offset for the next page; null when exhausted." }),
  },
  { description: "Persisted sessions, newest-first and paged." },
)

export const usageInfoSchema = t.Object({
  promptTokens: t.Integer(),
  completionTokens: t.Integer(),
  totalTokens: t.Integer(),
  cachedTokens: t.Optional(t.Nullable(t.Integer(), { description: "Prompt tokens served from the provider cache; null when unreported." })),
})

export const imageAttachmentSchema = t.Object({
  id: t.String({ description: "Content hash (sha1, 12 hex chars)." }),
  name: t.String({ description: "Display name (original filename or `clipboard.png`)." }),
  mediaType: t.String({ description: "IANA media type, sniffed from the bytes." }),
  bytes: t.Integer({ description: "Byte size of the stored asset." }),
  path: t.String({ description: "Absolute path of the stored asset." }),
  width: t.Optional(t.Integer()),
  height: t.Optional(t.Integer()),
})

export const chatRecordSchema = t.Object(
  {
    role: t.Union([t.Literal("user"), t.Literal("assistant")]),
    content: t.String(),
    ts: t.Optional(t.Integer({ description: "Event timestamp (epoch ms); omitted on legacy records." })),
    model: t.Optional(t.String()),
    usage: t.Optional(t.Nullable(usageInfoSchema)),
    aborted: t.Optional(t.Boolean()),
    thinking: t.Optional(t.String({ description: "Model reasoning streamed before the answer (display-only)." })),
    images: t.Optional(t.Array(imageAttachmentSchema, { description: "Image attachments on a user message." })),
  },
  { description: "One logical user/assistant chat record." },
)

export const sessionReadResponseSchema = t.Object({
  ok: t.Literal(true),
  id: t.String(),
  title: t.String(),
  tags: t.Array(t.String()),
  total: t.Integer({ description: "Total records before paging." }),
  offset: t.Integer(),
  messages: t.Array(chatRecordSchema),
})

export const contextHistoryEntrySchema = t.Object({
  role: t.String({ description: "Provider role (`system` | `user` | `assistant` | `tool`)." }),
  preview: t.String({ description: "First non-empty line of the message, trimmed." }),
  tokens: t.Integer({ description: "Local token estimate for the message (overhead included)." }),
})

export const contextBreakdownSchema = t.Object({
  model: t.String({ description: "Selected model in `endpoint@model` form." }),
  limit: t.Integer({ description: "Effective context ceiling: min(context window, model input-token limit)." }),
  used: t.Integer({ description: "Next-request estimate (usage-anchored; local fallback)." }),
  percent: t.Integer({ description: "`used / limit` as a whole percent." }),
  systemTokens: t.Integer(),
  historyTokens: t.Integer(),
  toolSpecTokens: t.Integer(),
  mcpSpecTokens: t.Integer(),
  messages: t.Integer(),
  compactions: t.Integer(),
  cacheRead: t.Integer(),
  cacheWrite: t.Integer(),
  cachePrompt: t.Integer(),
  pinned: t.Boolean({ description: "Estimate reached the compaction threshold." }),
  enabled: t.Boolean({ description: "Session is usable (an API key / mock seam is present)." }),
  note: t.Nullable(t.String()),
  history: t.Array(contextHistoryEntrySchema, { description: "Durable history messages, newest last (bounded previews)." }),
})

export const sessionContextResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    title: t.String(),
    breakdown: contextBreakdownSchema,
  },
  { description: "The Context Inspector snapshot for a saved session (P4e)." },
)

export const sessionDeleteResponseSchema = t.Object({
  ok: t.Boolean(),
  id: t.Optional(t.String()),
  message: t.Optional(t.String({ description: "Present on a refusal (`ok:false`) — e.g. a write failure." })),
})

// ── MCP ─────────────────────────────────────────────────────────────────────

export const mcpServerFactSchema = t.Object(
  {
    name: t.String(),
    status: t.String({ enum: ["idle", "starting", "connected", "failed", "disabled"] }),
    toolCount: t.Integer(),
  },
  { description: "One MCP server's live status (`disabled` = the config entry has `enabled:false`)." },
)

export const mcpResponseSchema = t.Object(
  { ok: t.Literal(true), servers: t.Array(mcpServerFactSchema) },
  { description: "Live per-server MCP facts; `servers: []` before any chat host exists." },
)

// ── Models ──────────────────────────────────────────────────────────────────

export const catalogModelSchema = t.Object(
  {
    id: t.String(),
    ownedBy: t.Nullable(t.String()),
    endpointTypes: t.Array(t.String(), { description: "Raw supported_endpoint_types (LiteLLM-style proxies)." }),
    chat: t.Boolean({ description: "Chat-capable (as opposed to embeddings-only / rerank-only)." }),
    meta: t.Nullable(
      t.Object({}, { additionalProperties: true, description: "Merged metadata — the endpoint's own /models info over models.dev, with the endpoint's per-model override on top (and `vision`)." }),
    ),
  },
  { description: "One model in an endpoint's enriched catalog." },
)

export const modelEndpointSchema = t.Object(
  {
    name: t.String(),
    baseURL: t.String(),
    provider: t.String({
      description:
        "Canonical protocol kind: `openai-compatible`, `openai-responses`, `anthropic`, `google`, or `mock` (the legacy config value `http` canonicalizes to `openai-compatible`).",
    }),
    hasKey: t.Boolean({ description: "A credential (or the mock seam) is present; the key itself is never returned." }),
    models: t.Array(catalogModelSchema),
  },
  { description: "One endpoint's catalog (config-derived, credential-free)." },
)

export const modelsResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    endpoints: t.Array(modelEndpointSchema),
    errors: t.Array(t.String(), { description: "Per-endpoint fetch failures as `\"<name>: <reason>\"`." }),
  },
  { description: "The enriched, credential-free model catalog for the picker." },
)

/** `POST /v1/models/probe` request body — a DRAFT endpoint, key included. */
export const probeEndpointBodySchema = t.Object(
  {
    provider: t.Optional(
      t.String({
        description:
          "Canonical protocol kind (`openai-compatible`, `openai-responses`, `anthropic`, `google`, or `mock`); unknown/absent lists like openai-compatible. Determines the wire (auth headers, URL, id shape).",
      }),
    ),
    baseURL: t.Optional(t.String({ description: "Draft base URL; empty/absent uses the protocol's default." })),
    apiKey: t.Optional(t.String({ description: "Used transiently for this probe only — never logged, persisted, or returned." })),
  },
  { description: "A DRAFT endpoint (provider + baseURL + apiKey) the wizard/settings can test before saving." },
)

export const probeModelsResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    models: t.Array(catalogModelSchema),
    error: t.Nullable(t.String(), { description: "null on success; the fetch failure reason otherwise (never the apiKey)." }),
  },
  { description: "The draft endpoint's enriched model list plus any fetch error." },
)

// ── Usage ───────────────────────────────────────────────────────────────────

export const usageRollupSchema = t.Object({
  key: t.String({ description: "The day (`YYYY-MM-DD`) or session path this row aggregates." }),
  calls: t.Integer(),
  promptTokens: t.Integer(),
  completionTokens: t.Integer(),
  totalTokens: t.Integer(),
  cachedTokens: t.Integer(),
  cachePercent: t.Integer(),
})

export const usageSessionMetaSchema = t.Object({
  path: t.String(),
  title: t.String(),
  lastTs: t.Integer(),
})

export const usageResponseSchema = t.Object(
  {
    ok: t.Literal(true),
    windowDays: t.Integer({ description: "The newest N distinct days with usage." }),
    generatedAt: t.Integer({ description: "Epoch ms the report was built." }),
    total: usageRollupSchema,
    byDay: t.Array(usageRollupSchema),
    bySession: t.Array(usageRollupSchema, { description: "All retained history, newest activity first (capped at 500 sessions)." }),
    sessions: t.Array(usageSessionMetaSchema, { description: "Display metadata for every session in `bySession`." }),
    windowSessions: t.Integer({ description: "Distinct sessions with usage inside the day window." }),
  },
  { description: "Serializable usage roll-ups for the dashboard." },
)
