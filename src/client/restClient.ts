/**
 * restClient — typed REST against the daemon's Unix socket (IF2; P4b;
 * docs/daemon-api.md "Routes").
 *
 * The daemon serves its management API on a Unix socket (`daemon.sock`, mode
 * `0600`) with bearer auth over the runtime token. The client uses it for the
 * read-only resources (health/info/config/agents/skills/memory/sessions/audit)
 * and for the `info.tcp.port` the WebSocket channel needs.
 *
 * The HTTP-over-UDS transport is a local reimplementation of
 * `src/daemon/cli.ts`'s `requestOverUnix` (the CLI's probe path): reusing that
 * module would pull Elysia into the client's boot graph, so it is mirrored here
 * against the same wire shape. Every failure is a `RestClientError` — never an
 * unhandled rejection — and every call has a bounded timeout.
 */

import { errorMessage, isRecord } from "../core/util.ts"
import { daemonRuntimeDir, daemonSocketPath, daemonTokenPath } from "../daemon/paths.ts"
import { readToken } from "../daemon/token.ts"
import type {
  AuditPage,
  AuditQuery,
  AuditStats,
  DaemonAgentSummary,
  DaemonInfo,
  DaemonSkillSummary,
  SessionExportFormat,
  SessionReadPage,
  SessionSummary,
} from "../daemon/index.ts"
import type { MemoryTarget, MemoryUsage, ContextBreakdown, UsageRollup, CatalogModel } from "../engine/index.ts"

/** A raw HTTP response over the Unix socket. */
export interface RestResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface RestClientOptions {
  /** Runtime dir holding `daemon.sock`/`daemon.token`; defaults to `daemonRuntimeDir()`. */
  runtimeDir?: string
  /** Bearer token; defaults to `readToken(daemon.token)`. */
  token?: string
  /** Per-request timeout (ms); default 5000. */
  timeoutMs?: number
}

/** A typed REST failure: an HTTP `{error}` body or a transport/timeout error. */
export class RestClientError extends Error {
  /** HTTP status; 0 for a transport failure (unreachable/timeout). */
  readonly status: number
  /** Daemon error code (`not_found`, `invalid_request`, `unreachable`, `timeout`…). */
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? `${code}${status > 0 ? ` (${status})` : ""}`)
    this.name = "RestClientError"
    this.status = status
    this.code = code
  }
}

interface RawRequestOptions {
  method?: string
  body?: string
  timeoutMs?: number
  token?: string
}

/** Query string from defined values (URL-encoded). */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length > 0 ? `?${parts.join("&")}` : ""
}

/** Decode a chunked body; null while it is incomplete. */
function decodeChunked(raw: string): string | null {
  let out = ""
  let i = 0
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", i)
    if (lineEnd < 0) return null
    const size = Number.parseInt(raw.slice(i, lineEnd).split(";")[0] ?? "", 16)
    if (!Number.isFinite(size)) return null
    if (size === 0) return out
    const start = lineEnd + 2
    const end = start + size
    if (raw.length < end + 2) return null
    out += raw.slice(start, end)
    i = end + 2
  }
}

/**
 * A minimal HTTP/1.1 request over a Unix socket (mirrors
 * `src/daemon/cli.ts` `requestOverUnix`). Resolves on connection close (the
 * request sends `Connection: close`); rejects only on a connect error/timeout.
 */
function requestOverUnix(unix: string, path: string, opts: RawRequestOptions = {}): Promise<RestResponse> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const method = opts.method ?? "GET"
  const body = opts.body ?? ""
  const head = [`${method} ${path} HTTP/1.1`, "Host: localhost", "Connection: close"]
  if (opts.token !== undefined) head.push(`Authorization: Bearer ${opts.token}`)
  if (body.length > 0) {
    head.push(`Content-Length: ${Buffer.byteLength(body)}`)
    head.push("Content-Type: application/json")
  }
  const payload = `${head.join("\r\n")}\r\n\r\n${body}`

  return new Promise<RestResponse>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result?: RestResponse, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(result ?? { status: 0, headers: {}, body: "" })
    }
    const parse = (): RestResponse | null => {
      // Byte-based: Content-Length counts UTF-8 bytes, and multi-byte bodies
      // (e.g. an em-dash in an agent description) would never satisfy a JS
      // string-length check, hanging the request until close.
      const buf = Buffer.concat(chunks)
      const split = buf.indexOf("\r\n\r\n")
      if (split < 0) return null
      const headLines = buf.subarray(0, split).toString("utf8").split("\r\n")
      const status = Number(headLines[0]?.split(" ")[1] ?? 0)
      const headers: Record<string, string> = {}
      for (const line of headLines.slice(1)) {
        const colon = line.indexOf(":")
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const bodyBuf = buf.subarray(split + 4)
      if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
        const decoded = decodeChunked(bodyBuf.toString("utf8"))
        return decoded === null ? null : { status, headers, body: decoded }
      }
      const length = Number(headers["content-length"] ?? "0")
      if (bodyBuf.length < length) return null
      return { status, headers, body: bodyBuf.subarray(0, length).toString("utf8") }
    }

    const timer = setTimeout(() => finish(undefined, new Error("timeout")), timeoutMs)
    Bun.connect({
      unix,
      socket: {
        open(socket) {
          socket.write(payload)
        },
        data(_socket, data) {
          chunks.push(Buffer.from(data))
          const parsed = parse()
          if (parsed !== null) finish(parsed)
        },
        close() {
          finish(parse() ?? undefined)
        },
        end() {
          finish(parse() ?? undefined)
        },
        error(_socket, error) {
          finish(undefined, error)
        },
        connectError(_socket, error) {
          finish(undefined, error)
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))))
  })
}

/** `GET /v1/health` payload. */
export interface RestHealth {
  ok: true
  name: string
  version: string
}

export type RestMemoryRead = {
  ok: true
  target: MemoryTarget
  content: string
  entries: string[]
  usage: MemoryUsage
}

export type RestMemoryWrite =
  | { ok: true; target: MemoryTarget; action: string; message: string; content?: string; entries?: string[]; usage?: MemoryUsage }
  | { ok: false; message: string; entries?: string[]; usage?: MemoryUsage }

export type RestMemoryList = { ok: true; targets: MemoryUsage[] }
export type RestConfig = {
  ok: true
  config: Record<string, unknown>
  /** Present on a PUT: secret names moved into the store. */
  captured?: string[]
  backupCreated?: boolean
}
export type RestAgents = { ok: true; agents: DaemonAgentSummary[]; warnings: string[] }
export type RestSkills = { ok: true; skills: DaemonSkillSummary[]; warnings: string[] }
export type RestSessions = { ok: true; sessions: SessionSummary[]; nextOffset: number | null }
export type RestSession = { ok: true } & SessionReadPage
export type RestAudit = { ok: true } & Pick<AuditPage, "records" | "nextCursor">
export type RestAuditStats = { ok: true } & AuditStats

/** `GET /v1/secrets` — names only, never values. */
export type RestSecrets = { ok: true; names: string[]; warnings: string[] }
export type RestSecretSet = { ok: boolean; name?: string; message?: string }
export type RestSecretDelete = { ok: boolean; name?: string; removed?: boolean; message?: string }
/** `GET /v1/mcp` — live per-server status facts. */
export type RestMcp = { ok: true; servers: Array<{ name: string; status: string; toolCount: number }> }
/** `GET /v1/models` — the credential-free catalog (endpoint rows). */
export interface RestModelEndpoint {
  name: string
  baseURL: string
  /** Canonical protocol kind: `openai-compatible`, `openai-responses`, `anthropic`, `google`, or `mock`. */
  provider: string
  hasKey: boolean
  models: CatalogModel[]
}
export type RestModels = { ok: true; endpoints: RestModelEndpoint[]; errors: string[] }
/** `POST /v1/models/probe` — a DRAFT endpoint the wizard/settings can test. */
export interface RestProbeEndpoint {
  provider?: string
  baseURL?: string
  /** Used transiently by the daemon; never logged, persisted, or returned. */
  apiKey?: string
}
export type RestProbeModels = { ok: true; models: CatalogModel[]; error: string | null }
/** `GET /v1/usage` — serializable usage roll-ups for the dashboard. */
export interface RestUsage {
  ok: true
  windowDays: number
  generatedAt: number
  total: UsageRollup
  byDay: UsageRollup[]
  bySession: UsageRollup[]
  sessions: Array<{ path: string; title: string; lastTs: number }>
  /** Distinct sessions with usage inside the day window (the header count). */
  windowSessions: number
}

/** `GET /v1/config/raw` — the raw (secret-free) config document. */
export type RestRawConfig = { ok: true; raw: Record<string, unknown> }
/** `GET /v1/sessions/:instance/:base/context` — a saved-session inspector snapshot. */
export type RestSessionContext = { ok: true; title: string; breakdown: ContextBreakdown }
/** `DELETE /v1/sessions/:instance/:base` result. */
export type RestSessionDelete = { ok: boolean; id?: string; message?: string }

/** Audit filters plus paging; `limit`/`cursor` are route query params. */
export type RestAuditQuery = AuditQuery & { limit?: number; cursor?: string }

/**
 * A typed client for the daemon's REST API over the Unix socket. A missing
 * token is not fatal at construction: `raw()` returns the daemon's 401, which
 * `json()` turns into `RestClientError(401, "unauthorized")`.
 */
export class RestClient {
  private token: string | null
  private readonly socketPath: string
  private readonly timeoutMs: number

  constructor(opts: RestClientOptions = {}) {
    const runtimeDir = opts.runtimeDir ?? daemonRuntimeDir()
    this.socketPath = daemonSocketPath(runtimeDir)
    this.token =
      opts.token !== undefined && opts.token.length > 0 ? opts.token : readToken(daemonTokenPath(runtimeDir))
    this.timeoutMs = opts.timeoutMs ?? 5000
  }

  /** The socket path this client targets. */
  get socket(): string {
    return this.socketPath
  }

  /** Whether a bearer token was resolved. */
  get hasToken(): boolean {
    return this.token !== null
  }

  /** Adopt a newly-written token (after an auto-spawn). */
  setToken(token: string): void {
    this.token = token.length > 0 ? token : null
  }

  /** Perform a raw request; throws `RestClientError` on a transport failure. */
  async raw(path: string, opts: RawRequestOptions = {}): Promise<RestResponse> {
    try {
      return await requestOverUnix(this.socketPath, path, {
        method: opts.method,
        body: opts.body,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        token: opts.token ?? this.token ?? undefined,
      })
    } catch (e) {
      const message = errorMessage(e)
      const code = message.includes("timeout") ? "timeout" : "unreachable"
      throw new RestClientError(0, code, `${path}: ${message}`)
    }
  }

  /** Perform a request and parse its JSON body; a non-2xx is a typed error. */
  async json<T>(path: string, opts: RawRequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts)
    if (res.status < 200 || res.status >= 300) {
      let code = `http_${res.status}`
      try {
        const parsed: unknown = JSON.parse(res.body)
        if (isRecord(parsed) && typeof parsed["error"] === "string") code = parsed["error"]
      } catch {
        // non-JSON error body — keep the status code
      }
      throw new RestClientError(res.status, code, `${path}: ${code} (${res.status})`)
    }
    try {
      return JSON.parse(res.body) as T
    } catch (e) {
      throw new RestClientError(res.status, "invalid_json", `${path}: ${errorMessage(e)}`)
    }
  }

  // -- read-only resources ----------------------------------------------------

  health(): Promise<RestHealth> {
    return this.json<RestHealth>("/v1/health")
  }

  info(): Promise<DaemonInfo> {
    return this.json<DaemonInfo>("/v1/info")
  }

  config(): Promise<RestConfig> {
    return this.json<RestConfig>("/v1/config")
  }

  agents(): Promise<RestAgents> {
    return this.json<RestAgents>("/v1/agents")
  }

  skills(): Promise<RestSkills> {
    return this.json<RestSkills>("/v1/skills")
  }

  memory(): Promise<RestMemoryList> {
    return this.json<RestMemoryList>("/v1/memory")
  }

  memoryTarget(target: MemoryTarget): Promise<RestMemoryRead> {
    return this.json<RestMemoryRead>(`/v1/memory/${encodeURIComponent(target)}`)
  }

  /** POST a memory action; a store-domain refusal is `{ok:false,message}` (200). */
  memoryWrite(
    target: MemoryTarget,
    action: "add" | "replace" | "remove" | "rewrite" | "prune",
    body: Record<string, unknown> = {},
  ): Promise<RestMemoryWrite> {
    return this.json<RestMemoryWrite>(`/v1/memory/${encodeURIComponent(target)}`, {
      method: "POST",
      body: JSON.stringify({ action, ...body }),
    })
  }

  sessions(opts: { limit?: number; offset?: number } = {}): Promise<RestSessions> {
    return this.json<RestSessions>(`/v1/sessions${buildQuery({ limit: opts.limit, offset: opts.offset })}`)
  }

  session(instance: string, base: string, opts: { limit?: number; offset?: number } = {}): Promise<RestSession> {
    const path = `/v1/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(base)}`
    return this.json<RestSession>(`${path}${buildQuery({ limit: opts.limit, offset: opts.offset })}`)
  }

  /** Export a transcript as markdown (default) or raw JSONL. */
  async sessionExport(instance: string, base: string, format: SessionExportFormat = "md"): Promise<string> {
    const path = `/v1/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(base)}/export${buildQuery({ format })}`
    const res = await this.raw(path)
    if (res.status < 200 || res.status >= 300) {
      let code = `http_${res.status}`
      try {
        const parsed: unknown = JSON.parse(res.body)
        if (isRecord(parsed) && typeof parsed["error"] === "string") code = parsed["error"]
      } catch {
        // keep the status code
      }
      throw new RestClientError(res.status, code, `${path}: ${code} (${res.status})`)
    }
    return res.body
  }

  audit(query: RestAuditQuery = {}): Promise<RestAudit> {
    return this.json<RestAudit>(`/v1/audit${buildAuditQuery(query)}`)
  }

  auditStats(query: RestAuditQuery = {}): Promise<RestAuditStats> {
    return this.json<RestAuditStats>(`/v1/audit/stats${buildAuditQuery(query)}`)
  }

  // -- writes + meta (P4c-iii host adapter) -----------------------------------

  /** PUT a validated config patch (the daemon deep-merges + captures secrets).
   * `replace: true` writes the whole document instead (missing keys are dropped). */
  putConfig(patch: Record<string, unknown>, opts: { replace?: boolean } = {}): Promise<RestConfig> {
    const query = opts.replace === true ? "?mode=replace" : ""
    return this.json<RestConfig>(`/v1/config${query}`, { method: "PUT", body: JSON.stringify(patch) })
  }

  secrets(): Promise<RestSecrets> {
    return this.json<RestSecrets>("/v1/secrets")
  }

  setSecret(name: string, value: string): Promise<RestSecretSet> {
    return this.json<RestSecretSet>("/v1/secrets", { method: "POST", body: JSON.stringify({ name, value }) })
  }

  deleteSecret(name: string): Promise<RestSecretDelete> {
    return this.json<RestSecretDelete>(`/v1/secrets${buildQuery({ name })}`, { method: "DELETE" })
  }

  models(): Promise<RestModels> {
    return this.json<RestModels>("/v1/models")
  }

  /** Probe a DRAFT endpoint (provider/baseURL/apiKey) before saving it. The
   * daemon uses the key transiently and never returns it. */
  probeModels(input: RestProbeEndpoint): Promise<RestProbeModels> {
    return this.json<RestProbeModels>("/v1/models/probe", { method: "POST", body: JSON.stringify(input) })
  }

  mcp(): Promise<RestMcp> {
    return this.json<RestMcp>("/v1/mcp")
  }

  usage(): Promise<RestUsage> {
    return this.json<RestUsage>("/v1/usage")
  }

  /** The raw (secret-free) config document — the settings screen's seed. */
  rawConfig(): Promise<RestRawConfig> {
    return this.json<RestRawConfig>("/v1/config/raw")
  }

  /** A saved transcript's Context Inspector snapshot. */
  sessionContext(instance: string, base: string): Promise<RestSessionContext> {
    const path = `/v1/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(base)}/context`
    return this.json<RestSessionContext>(path)
  }

  /** Delete a transcript + sidecar (the sessions overlay's `Del`). */
  deleteSession(instance: string, base: string): Promise<RestSessionDelete> {
    const path = `/v1/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(base)}`
    return this.json<RestSessionDelete>(path, { method: "DELETE" })
  }
}

/** Build the shared `?since=&until=&session=&tool=&kind=&limit=&cursor=` filters. */
function buildAuditQuery(query: RestAuditQuery): string {
  return buildQuery({
    since: query.since,
    until: query.until,
    session: query.session,
    tool: query.tool,
    kind: query.kind,
    limit: query.limit,
    cursor: query.cursor,
  })
}
