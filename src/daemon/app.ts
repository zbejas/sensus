/**
 * The daemon's Elysia app (IF2; docs/daemon-api.md): the authenticated REST
 * management API mounted on both a Unix socket and loopback TCP by `serve.ts`.
 * This module is transport-free so tests can drive it directly with
 * `app.handle(new Request(...))`.
 *
 * Every request is bearer-authenticated (`auth.ts`); `onError` is defensive so
 * an unexpected throw becomes a JSON `500`, never an unhandled exception. Every
 * response is secret-free: `/v1/config` is redacted (`config.ts`, D13).
 */

import { Elysia } from "elysia"
import { openapi } from "@elysiajs/openapi"
import { getLogger } from "../core/log.ts"
import {
  loadAgents,
  loadSkills,
  sensusDataDir,
  sensusHome,
  type EventSink,
  type McpServerStatusFact,
  type MemoryStore,
  type SensusInstance,
} from "../engine/index.ts"
import { auditRoutes } from "./audit/routes.ts"
import { LegacyAuditJsonlSource, type AuditSource } from "./audit/reader.ts"
import { agentsResponseSchema, configResponseSchema, healthSchema, infoSchema, jsonResponse, skillsResponseSchema, unauthorizedResponse } from "./apiSchemas.ts"
import { ensureAgentDirs } from "../config/agents.ts"
import { bearerAuth } from "./auth.ts"
import { mcpRoutes } from "./mcp.ts"
import { memoryRoutes } from "./memory.ts"
import { modelRoutes, type DaemonModelsResult, type ProbeEndpointInput, type ProbeModelsResult } from "./models.ts"
import { daemonOpenApiConfig, docsTrailingSlashRedirect } from "./openapi.ts"
import { sessionRoutes } from "./sessions/routes.ts"
import { settingsRoutes } from "./settings.ts"
import { buildUsageReport, usageRoutes, type DaemonUsageReport } from "./usage.ts"

/** `GET /v1/info` payload — no secrets. */
export interface DaemonInfo {
  ok: true
  name: "sensus-daemon"
  version: string
  pid: number
  platform: string
  /** Epoch ms the daemon process started. */
  startedAt: number
  /** Milliseconds since `startedAt`, sampled per request. */
  uptimeMs: number
  /** Unix socket path the API is bound to. */
  socket: string
  /** Loopback TCP address; `port` is the actual bound (ephemeral) port. */
  tcp: { host: string; port: number }
  /** Live PTY shells the daemon currently owns (D4/D21). */
  shells: number
  /** True when the daemon never grace-exits — `SENSUS_DAEMON_PERSISTENT` / config (D3/D9). */
  persistent: boolean
  /** The machine/installation identity (docs/events.md). */
  instance: SensusInstance
}

/** A one-line projection of an agent definition for `GET /v1/agents`. */
export interface DaemonAgentSummary {
  name: string
  description: string
  /** Core tool allowlist; null = all. */
  tools: string[] | null
  /** Skill allowlist; null = all. */
  skills: string[] | null
  sudoPrompt: string
  shell: string
  path: string
  /** The prompt body (the picker preview). */
  prompt: string
}

/** A one-line projection of a skill for `GET /v1/skills` (no body — progressive disclosure). */
export interface DaemonSkillSummary {
  name: string
  description: string
  path: string
}

export interface DaemonAppOptions {
  /** Bearer token every request must present. */
  token: string
  /** Version reported by health/info. */
  version: string
  /** Supplies the live info payload (socket/tcp/uptime are known only to serve.ts). */
  info: () => DaemonInfo
  /** Builds a `MemoryStore` per request (the memory resource). */
  memory: () => MemoryStore
  /** Audit sink; committed memory writes are emitted through it. */
  events: EventSink
  /** Audit query/export source. Defaults to the legacy JSONL reader. */
  audit?: AuditSource
  /** Sessions data dir for the read-only sessions resource. Defaults lazily in serve.ts. */
  sessionsDataDir?: string
  /** Effective, redacted config (D13). Defaults to `{}` for route-only tests. */
  config?: () => Record<string, unknown>
  /** Config home for the read-only agents/skills listings. Defaults to `sensusHome()`. */
  home?: string
  /** Saved-session Context Inspector snapshot (P4e); null for an unknown path. */
  sessionContext?: (path: string) => { title: string; breakdown: unknown } | null
  /** Live per-server MCP facts (P4c-ii). Defaults to none. */
  mcp?: () => McpServerStatusFact[]
  /** Model catalog builder (P4c-ii). Defaults to an empty catalog. */
  models?: () => Promise<DaemonModelsResult>
  /** Draft-endpoint probe for the wizard/settings (never logged/returned). */
  probeModels?: (input: ProbeEndpointInput) => Promise<ProbeModelsResult>
  /** Usage report (P4c-ii). Defaults to the real sessions data dir. */
  usage?: () => DaemonUsageReport
  /** Fired after a successful `PUT /v1/config` (the daemon reloads its chats). */
  onConfigWrite?: () => void
}

const NAME = "sensus-daemon" as const

/** Build the daemon app; callers bind it (see `serve.ts`). */
export function createDaemonApp(opts: DaemonAppOptions) {
  return new Elysia({ name: NAME })
    // Canonicalise a trailing-slash docs URL before routing: Scalar's relative
    // spec URL breaks at `/openapi/` (see `docsTrailingSlashRedirect`).
    .onRequest(({ request }) => {
      try {
        const location = docsTrailingSlashRedirect(new URL(request.url))
        if (location !== null) return Response.redirect(location, 308)
      } catch (e) {
        // A malformed URL falls through to the normal 404.
        getLogger().debug("docs redirect skipped for a malformed URL", { err: e })
      }
    })
    .use(openapi(daemonOpenApiConfig(opts.version)))
    .use(bearerAuth(opts.token))
    .use(memoryRoutes({ store: opts.memory, events: opts.events }))
    .use(auditRoutes(opts.audit ?? new LegacyAuditJsonlSource()))
    .use(sessionRoutes({ dataDir: opts.sessionsDataDir ?? sensusDataDir(), context: opts.sessionContext }))
    .use(mcpRoutes({ status: opts.mcp }))
    .use(modelRoutes({ models: opts.models, probe: opts.probeModels }))
    .use(usageRoutes({ report: opts.usage ?? (() => buildUsageReport(opts.sessionsDataDir ?? sensusDataDir())) }))
    .use(
      settingsRoutes({
        home: opts.home ?? sensusHome(),
        config: opts.config ?? (() => ({})),
        onWritten: opts.onConfigWrite,
      }),
    )
    .get("/v1/health", () => ({ ok: true, name: NAME, version: opts.version }), {
      detail: {
        tags: ["core"],
        operationId: "getHealth",
        summary: "Liveness/readiness probe",
        description: "Cheap liveness payload; the readiness probe `sensus daemon start` waits on. Bearer-authenticated like every route.",
        responses: { 200: jsonResponse(healthSchema, "Daemon is up."), 401: unauthorizedResponse() },
      },
    })
    .get("/v1/info", () => opts.info(), {
      detail: {
        tags: ["core"],
        operationId: "getInfo",
        summary: "Daemon facts",
        description: "Process, transport, live-shell and machine-identity facts. `tcp.port` is the actual bound (ephemeral) port.",
        responses: { 200: jsonResponse(infoSchema, "Daemon facts."), 401: unauthorizedResponse() },
      },
    })
    .get("/v1/config", () => ({ ok: true, config: (opts.config ?? (() => ({})))() }), {
      detail: {
        tags: ["config"],
        operationId: "getConfig",
        summary: "Effective, redacted config",
        description:
          "The EFFECTIVE config (defaults → file → env → flags) with every resolved secret stripped (D13). A `${NAME}` reference is kept verbatim; a literal credential becomes `<redacted>`.",
        responses: { 200: jsonResponse(configResponseSchema, "The redacted effective config."), 401: unauthorizedResponse() },
      },
    })
    .get(
      "/v1/agents",
      () => {
        const home = opts.home ?? sensusHome()
        // Materialize the built-ins first (a fresh home has no agents dir), so the
        // listing matches the in-process ChatHost catalog.
        ensureAgentDirs(home)
        const loaded = loadAgents(home)
        const agents: DaemonAgentSummary[] = loaded.agents.map((a) => ({
          name: a.name,
          description: a.description,
          tools: a.tools,
          skills: a.skills,
          sudoPrompt: a.sudoPrompt,
          shell: a.shell,
          path: a.path,
          prompt: a.prompt,
        }))
        return { ok: true, agents, warnings: loaded.warnings }
      },
      {
        detail: {
          tags: ["agents"],
          operationId: "listAgents",
          summary: "List agent definitions",
          description: "The read-only agent definitions from the config home, each projected with its prompt body for the picker.",
          responses: { 200: jsonResponse(agentsResponseSchema, "Agent definitions."), 401: unauthorizedResponse() },
        },
      },
    )
    .get(
      "/v1/skills",
      () => {
        const home = opts.home ?? sensusHome()
        ensureAgentDirs(home)
        const catalog = loadSkills(home)
        const skills: DaemonSkillSummary[] = catalog.skills.map((s) => ({
          name: s.name,
          description: s.description,
          path: s.path,
        }))
        return { ok: true, skills, warnings: catalog.warnings }
      },
      {
        detail: {
          tags: ["skills"],
          operationId: "listSkills",
          summary: "List skills (name/description only)",
          description: "The read-only skill index. Bodies are progressive-disclosure and never returned here.",
          responses: { 200: jsonResponse(skillsResponseSchema, "Skill index."), 401: unauthorizedResponse() },
        },
      },
    )
    .onError(({ code, error, request, set }) => {
      try {
        let method: string | undefined
        let url: string | undefined
        try {
          method = request?.method
          url = request?.url
        } catch {
          // a defensive read of the request must never break onError
        }
        getLogger().error("http request failed", { err: error, code, method, url })
        const status = code === "NOT_FOUND" ? 404 : code === "VALIDATION" || code === "PARSE" ? 400 : 500
        const errorName = status === 404 ? "not_found" : status === 400 ? "invalid_request" : "internal_error"
        set.status = status
        return { error: errorName }
      } catch {
        // onError itself must never escape.
        return new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      }
    })
}
