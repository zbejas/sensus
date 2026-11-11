/**
 * Persisted pairing state for the embedded cloud client.
 *
 * The daemon owns this file; the standalone connector is no longer required.
 * It lives under `<SENSUS_HOME>/cloud/connection.json` (0600) so a root daemon
 * (`/root/.config/sensus`) and a uid-1000 daemon never share a token.
 */

import { existsSync, readFileSync, rmSync } from "node:fs"
import { arch, hostname } from "node:os"
import { errorMessage, isRecord } from "../../core/util.ts"
import { connectionPath, writeCloudJson } from "./paths.ts"
import { normalizeScopeArray, type HostFacts, type Scope } from "./protocol.ts"

export interface CloudConnection {
  version: 1
  cloud: string
  instanceId: string
  deviceToken: string
  fingerprint: string
  name: string | null
  pairedAt: number
  scopes: Scope[]
  clientKind: "sensus-daemon"
  clientVersion: string
  unixUser: string
  uid: number | undefined
  runsAsRoot: boolean
  /** False = keep the pairing but do not open the tunnel. */
  enabled: boolean
}

export type CloudConfigResult =
  | { ok: true; connection: CloudConnection | null; existed: boolean }
  | { ok: false; error: string }

function normalizeConnection(value: unknown): CloudConnection | null {
  if (!isRecord(value) || value["version"] !== 1) return null
  const cloud = value["cloud"]
  const instanceId = value["instanceId"]
  const deviceToken = value["deviceToken"]
  const fingerprint = value["fingerprint"]
  const name = value["name"]
  const pairedAt = value["pairedAt"]
  const scopes = normalizeScopeArray(value["scopes"])
  if (typeof cloud !== "string" || cloud.length === 0) return null
  if (typeof instanceId !== "string" || instanceId.length === 0) return null
  if (typeof deviceToken !== "string" || deviceToken.length === 0) return null
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return null
  if (name !== null && typeof name !== "string") return null
  if (typeof pairedAt !== "number") return null
  if (scopes === null) return null
  const unixUser = value["unixUser"]
  const uid = value["uid"]
  return {
    version: 1,
    cloud,
    instanceId,
    deviceToken,
    fingerprint,
    name,
    pairedAt,
    scopes,
    clientKind: "sensus-daemon",
    clientVersion: typeof value["clientVersion"] === "string" ? value["clientVersion"] : "unknown",
    unixUser: typeof unixUser === "string" && unixUser.length > 0 ? unixUser : String(uid ?? "unknown"),
    uid: typeof uid === "number" && Number.isFinite(uid) ? uid : undefined,
    runsAsRoot: value["runsAsRoot"] === true,
    enabled: value["enabled"] !== false,
  }
}

/** Read the paired connection; a missing file means "not paired". */
export function readCloudConnection(home: string): CloudConfigResult {
  const path = connectionPath(home)
  if (!existsSync(path)) return { ok: true, connection: null, existed: false }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    return { ok: false, error: `cannot read ${path}: ${errorMessage(e)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `invalid connection.json at ${path}: ${errorMessage(e)}` }
  }
  const connection = normalizeConnection(parsed)
  if (connection === null) return { ok: false, error: `invalid connection.json at ${path}` }
  return { ok: true, connection, existed: true }
}

/**
 * Write the pairing state (0600). Root writes are allowed only when the caller
 * explicitly approved root pairing (`allowRoot`); the daemon itself never calls
 * this after pairing.
 */
export function writeCloudConnection(
  home: string,
  connection: CloudConnection,
  opts: { uid?: number; allowRoot?: boolean } = {},
): { ok: boolean; error?: string } {
  if ((opts.uid ?? process.getuid?.() ?? -1) === 0 && opts.allowRoot !== true) {
    return { ok: false, error: "refusing to write the cloud token as root without --allow-root" }
  }
  if (normalizeConnection(connection) === null) return { ok: false, error: "invalid cloud connection" }
  const res = writeCloudJson(connectionPath(home), connection)
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "cannot write connection.json" }
}

/** Remove the pairing state; the identity and scopes stay. */
export function clearCloudConnection(home: string): { ok: boolean; error?: string } {
  try {
    if (existsSync(connectionPath(home))) rmSync(connectionPath(home), { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase()
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1"
}

/** Normalize a cloud base URL to its origin; TLS is required off-loopback. */
export function normalizeCloudUrl(raw: string): { ok: true; cloud: string } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: `invalid cloud URL ${JSON.stringify(raw)}` }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, error: "the cloud URL must not contain credentials" }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "the cloud URL must be https:// (http:// is only allowed on loopback)" }
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: "plain http is only allowed on loopback; use https:// (TLS is required)" }
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    return { ok: false, error: "the cloud URL must be an origin (no path, query, or fragment)" }
  }
  return { ok: true, cloud: url.origin }
}

/** The outbound WebSocket endpoint for a paired origin. */
export function connectorUrl(cloud: string): string {
  const url = new URL(cloud)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/api/connector"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function cloudApiUrl(cloud: string, path: string): string {
  return new URL(path, `${cloud}/`).toString()
}

/** Normalize `ABCD-EFGH` (the cloud's alphabet excludes I/O/0/1). */
export function normalizePairingCode(raw: string): string | null {
  const stripped = raw.toUpperCase().replace(/-/gu, "").trim()
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u.test(stripped)) return null
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`
}

/** The Unix account this daemon runs as, for cloud display and disambiguation. */
export function unixUserLabel(uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): string {
  if (typeof uid === "number" && uid === 0) return "root"
  const user = env["USER"] ?? env["LOGNAME"]
  if (user !== undefined && user.length > 0) return user
  return typeof uid === "number" ? String(uid) : "unknown"
}

/** Host facts sent at pairing and in `hello`. */
export function hostFacts(
  opts: { uid?: number; env?: NodeJS.ProcessEnv; unixUser?: string } = {},
): HostFacts {
  const uid = opts.uid ?? process.getuid?.()
  const architecture = arch() === "x64" ? "x64" : arch()
  return {
    hostname: hostname(),
    platform: process.platform,
    arch: architecture,
    unixUser: opts.unixUser ?? unixUserLabel(uid, opts.env),
    ...(typeof uid === "number" ? { uid } : {}),
    runsAsRoot: uid === 0,
  }
}
