/**
 * Local-daemon discovery (docs/auth.md "Discovery"; protocol "Local connector
 * policy"). Every connection re-reads the per-boot bearer token and asks
 * `GET /v1/info` over the Unix socket for the loopback TCP port, so a daemon
 * restart (new token/port) is picked up without caching anything across boots.
 *
 * The token is never placed in a URL: `/v1/ws` is opened with an
 * `Authorization: Bearer` header, exactly like the daemon's own client.
 */

import { existsSync, readFileSync } from "node:fs"
import { errorMessage, isRecord } from "../../core/util.ts"
import { daemonSocketPath, daemonTokenPath, resolveRuntimeDir as defaultRuntimeDir } from "./paths.ts"

/** Minimal HTTP response over the Unix socket. */
export interface UnixHttpResult {
  status: number
  headers: Record<string, string>
  body: string
}

/** The subset of `GET /v1/info` discovery needs. */
export interface DaemonInfoPayload {
  ok?: boolean
  version?: string
  platform?: string
  pid?: number
  startedAt?: number
  /** Config home the daemon actually reads (`SENSUS_HOME`) — mismatch detection. */
  home?: string
  /** Unix uid the daemon runs as, when the platform has one. */
  uid?: number
  unixUser?: string
  tcp: { host: string; port: number }
  shells?: number
  persistent?: boolean
  instance?: { instanceId?: string; createdAt?: number; version?: string }
}

/** One fresh daemon endpoint snapshot. */
export interface DaemonDiscovery {
  runtimeDir: string
  token: string
  info: DaemonInfoPayload
  /** `ws://host:port/v1/ws` — never carries the token. */
  wsUrl: string
  /** Changes on every daemon boot; used to cache feature probes only. */
  epoch: string
}

export type DiscoveryResult =
  | { ok: true; discovery: DaemonDiscovery }
  | { ok: false; code: string; message: string; state: "stopped" | "unreachable" }

export interface DiscoverOptions {
  /** `--runtime-dir` override; defaults to `SENSUS_RUNTIME_DIR` etc. */
  runtimeDir?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Test seam for the UDS request. */
  request?: (req: UnixHttpRequest) => Promise<UnixHttpResult>
}

export interface UnixHttpRequest {
  unix: string
  method?: string
  path: string
  token?: string
  body?: string
  timeoutMs?: number
}

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
 * A minimal HTTP/1.1 request over a Unix socket. Kept local so importing the
 * cloud module never pulls in Elysia via the daemon's CLI barrel.
 */
export function requestOverUnix(req: UnixHttpRequest): Promise<UnixHttpResult> {
  const timeoutMs = req.timeoutMs ?? 2000
  const method = req.method ?? "GET"
  const body = req.body ?? ""
  const head = [`${method} ${req.path} HTTP/1.1`, "Host: localhost", "Connection: close"]
  if (req.token !== undefined) head.push(`Authorization: Bearer ${req.token}`)
  if (body.length > 0) {
    head.push(`Content-Length: ${Buffer.byteLength(body)}`)
    head.push("Content-Type: application/json")
  }
  const payload = `${head.join("\r\n")}\r\n\r\n${body}`

  return new Promise<UnixHttpResult>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result?: UnixHttpResult, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(result ?? { status: 0, headers: {}, body: "" })
    }
    const parse = (): UnixHttpResult | null => {
      const text = Buffer.concat(chunks).toString("utf8")
      const split = text.indexOf("\r\n\r\n")
      if (split < 0) return null
      const headLines = text.slice(0, split).split("\r\n")
      const status = Number(headLines[0]?.split(" ")[1] ?? 0)
      const headers: Record<string, string> = {}
      for (const line of headLines.slice(1)) {
        const colon = line.indexOf(":")
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const rawBody = text.slice(split + 4)
      if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
        const decoded = decodeChunked(rawBody)
        return decoded === null ? null : { status, headers, body: decoded }
      }
      const length = Number(headers["content-length"] ?? "0")
      const bodyBytes = Buffer.from(rawBody, "utf8")
      if (bodyBytes.length < length) return null
      return { status, headers, body: bodyBytes.subarray(0, length).toString("utf8") }
    }

    const timer = setTimeout(() => finish(undefined, new Error("timeout")), timeoutMs)
    Bun.connect({
      unix: req.unix,
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

/** Resolve the local runtime dir (`--runtime-dir` > `SENSUS_RUNTIME_DIR` > defaults). */
export function resolveRuntimeDir(opts: Pick<DiscoverOptions, "runtimeDir" | "env"> = {}): string {
  return opts.runtimeDir !== undefined && opts.runtimeDir.length > 0
    ? opts.runtimeDir
    : defaultRuntimeDir(opts.env ?? process.env)
}

/** Read `daemon.token` for this runtime dir; never cached by discovery. */
export function readDaemonToken(runtimeDir: string): string | null {
  try {
    const token = readFileSync(daemonTokenPath(runtimeDir), "utf8").trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

/**
 * Build the loopback WS URL from `/v1/info`. Wildcard binds (`0.0.0.0`, `::`)
 * are reached through loopback; IPv6 literals are bracketed. The URL contains
 * no credentials — the bearer rides the upgrade header.
 */
export function daemonWsUrl(info: Pick<DaemonInfoPayload, "tcp">, path = "/v1/ws"): string {
  const host = info.tcp.host
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  const formatted = reachable.includes(":") && !reachable.startsWith("[") ? `[${reachable}]` : reachable
  return `ws://${formatted}:${info.tcp.port}${path}`
}

/** The daemon-boot identity used to cache a feature probe across reconnects. */
export function daemonEpoch(info: DaemonInfoPayload): string {
  return `${info.instance?.instanceId ?? "unknown"}:${info.startedAt ?? 0}`
}

function parseInfo(body: string): DaemonInfoPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const tcp = parsed["tcp"]
  if (!isRecord(tcp) || typeof tcp["port"] !== "number" || !Number.isFinite(tcp["port"]) || tcp["port"] <= 0) {
    return null
  }
  const host = typeof tcp["host"] === "string" && tcp["host"].length > 0 ? tcp["host"] : "127.0.0.1"
  const instance = isRecord(parsed["instance"])
    ? {
        instanceId: typeof parsed["instance"]["instanceId"] === "string" ? parsed["instance"]["instanceId"] : undefined,
        createdAt: typeof parsed["instance"]["createdAt"] === "number" ? parsed["instance"]["createdAt"] : undefined,
        version: typeof parsed["instance"]["version"] === "string" ? parsed["instance"]["version"] : undefined,
      }
    : undefined
  return {
    ok: parsed["ok"] === true,
    version: typeof parsed["version"] === "string" ? parsed["version"] : undefined,
    platform: typeof parsed["platform"] === "string" ? parsed["platform"] : undefined,
    pid: typeof parsed["pid"] === "number" ? parsed["pid"] : undefined,
    startedAt: typeof parsed["startedAt"] === "number" ? parsed["startedAt"] : undefined,
    home: typeof parsed["home"] === "string" ? parsed["home"] : undefined,
    uid: typeof parsed["uid"] === "number" && Number.isFinite(parsed["uid"]) ? parsed["uid"] : undefined,
    unixUser: typeof parsed["unixUser"] === "string" ? parsed["unixUser"] : undefined,
    tcp: { host, port: Math.floor(tcp["port"]) },
    shells: typeof parsed["shells"] === "number" ? parsed["shells"] : undefined,
    persistent: typeof parsed["persistent"] === "boolean" ? parsed["persistent"] : undefined,
    instance,
  }
}

/**
 * Discover the current daemon endpoint. Re-reads `daemon.token` and queries
 * `/v1/info` on every call — callers must invoke this per connect, never cache
 * the result across a daemon boot.
 */
export async function discoverDaemon(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const runtimeDir = resolveRuntimeDir(opts)
  const socket = daemonSocketPath(runtimeDir)
  if (!existsSync(socket)) {
    return { ok: false, code: "daemon_socket_missing", message: `daemon socket not found at ${socket}`, state: "stopped" }
  }
  const token = readDaemonToken(runtimeDir)
  if (token === null) {
    return {
      ok: false,
      code: "daemon_token_missing",
      message: `daemon token not found at ${daemonTokenPath(runtimeDir)}`,
      state: "stopped",
    }
  }
  let res: UnixHttpResult
  try {
    res = await (opts.request ?? requestOverUnix)({
      unix: socket,
      path: "/v1/info",
      token,
      timeoutMs: opts.timeoutMs ?? 2000,
    })
  } catch (e) {
    return { ok: false, code: "daemon_unreachable", message: errorMessage(e), state: "unreachable" }
  }
  if (res.status === 401) {
    return { ok: false, code: "unauthorized", message: "the daemon rejected the boot token (restart/re-read the token)", state: "unreachable" }
  }
  if (res.status !== 200) {
    return { ok: false, code: "daemon_info_failed", message: `GET /v1/info returned HTTP ${res.status}`, state: "unreachable" }
  }
  const info = parseInfo(res.body)
  if (info === null) {
    return { ok: false, code: "daemon_info_invalid", message: "GET /v1/info returned an invalid payload", state: "unreachable" }
  }
  return {
    ok: true,
    discovery: { runtimeDir, token, info, wsUrl: daemonWsUrl(info), epoch: daemonEpoch(info) },
  }
}
