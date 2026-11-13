/**
 * Pairing for the embedded cloud client.
 *
 * The daemon no longer needs the standalone `sensus-cloud` binary: the CLI
 * creates the host identity/scope policy locally, exchanges the one-time code
 * with the cloud over HTTPS, stores the device token under
 * `<SENSUS_HOME>/cloud/connection.json` (0600), and the daemon opens the
 * outbound WSS tunnel. The private key never leaves the host.
 */

import { errorMessage, isRecord } from "../../core/util.ts"
import type { HostIdentity } from "../../auth/identity.ts"
import type { AuthPolicy } from "../../auth/policy.ts"
import {
  clearCloudConnection,
  cloudApiUrl,
  normalizeCloudUrl,
  normalizePairingCode,
  writeCloudConnection,
  type CloudConnection,
} from "./state.ts"
import { normalizeScopeArray, type HostFacts, type Scope } from "./protocol.ts"
import { MAX_STREAMS } from "../../auth/scopes.ts"

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface HttpJsonResult {
  ok: boolean
  status: number
  body: Record<string, unknown> | null
  error: string | null
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<HttpJsonResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" })
    const text = await res.text()
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) body = parsed
    } catch {
      // non-JSON errors are not echoed
    }
    return { ok: res.ok, status: res.status, body, error: null }
  } catch (error) {
    return { ok: false, status: 0, body: null, error: errorMessage(error) }
  } finally {
    clearTimeout(timer)
  }
}

function errorCode(body: Record<string, unknown> | null): string | null {
  return body !== null && typeof body["error"] === "string" ? body["error"] : null
}

export type WhoamiState = "active" | "pending" | "revoked"

export interface WhoamiResult {
  ok: boolean
  /** HTTP status when the request completed; 0 for a transport error. */
  status: number
  state: WhoamiState | null
  scopes: Scope[]
  error: string | null
}

/** Read the cloud's view of this pairing. A revoked token is HTTP 401. */
export async function whoami(
  connection: Pick<CloudConnection, "cloud" | "instanceId" | "deviceToken">,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<WhoamiResult> {
  const res = await fetchJson(
    cloudApiUrl(connection.cloud, "/api/connector/whoami"),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${connection.deviceToken}`,
        "X-Sensus-Instance": connection.instanceId,
        accept: "application/json",
      },
    },
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 10_000,
  )
  if (res.error !== null) return { ok: false, status: res.status, state: null, scopes: [], error: res.error }
  if (!res.ok) {
    return { ok: false, status: res.status, state: null, scopes: [], error: errorCode(res.body) ?? `HTTP ${res.status}` }
  }
  const stateRaw = res.body?.["state"]
  const state = stateRaw === "active" || stateRaw === "pending" || stateRaw === "revoked" ? stateRaw : null
  if (state === null) {
    return { ok: false, status: res.status, state: null, scopes: [], error: "invalid whoami response" }
  }
  return { ok: true, status: res.status, state, scopes: normalizeScopeArray(res.body?.["scopes"]) ?? [], error: null }
}

/** Features a cloud config profile may deny (protocol "Cloud config profiles"). */
export const CONNECTOR_CONFIG_FEATURES = ["transcript.read", "transcript.delete", "memory.read", "memory.write"] as const
export type ConnectorConfigFeature = (typeof CONNECTOR_CONFIG_FEATURES)[number]
export type ConnectorChatApproval = "inherit" | "confirm"
export type ConnectorConductorApproval = "inherit" | "off" | "no-destructive"

/** The read-only profile returned by `GET /api/connector/config`. */
export interface ConnectorConfigProfile {
  id: string
  name: string
  updatedAt: number
  scopes: Scope[]
  deniedFeatures: ConnectorConfigFeature[]
  chatApproval: ConnectorChatApproval
  conductorApprovals: ConnectorConductorApproval
  maxStreams: number | null
}

export interface ConnectorConfigResult {
  ok: boolean
  status: number
  profile: ConnectorConfigProfile | null
  /** Pull-contract version when the response was well formed. */
  version: number | null
  error: string | null
}

const CONFIG_FEATURE_SET = new Set<string>(CONNECTOR_CONFIG_FEATURES)
const CHAT_APPROVALS = new Set<string>(["inherit", "confirm"])
const CONDUCTOR_APPROVALS = new Set<string>(["inherit", "off", "no-destructive"])

/**
 * Strict parse of one profile object. Unknown fields are ignored (the cloud may
 * add fields), but a wrong type invalidates the profile rather than silently
 * falling back to a wider default. `null` means "unusable payload".
 */
export function parseConnectorConfigProfile(raw: unknown): ConnectorConfigProfile | null {
  if (!isRecord(raw)) return null
  const id = typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : null
  const name = typeof raw["name"] === "string" ? raw["name"] : null
  const updatedAt = typeof raw["updatedAt"] === "number" && Number.isFinite(raw["updatedAt"]) && raw["updatedAt"] >= 0 ? raw["updatedAt"] : null
  const scopes = normalizeScopeArray(raw["scopes"])
  if (id === null || name === null || updatedAt === null || scopes === null) return null
  const deniedFeatures: ConnectorConfigFeature[] = []
  if (raw["deniedFeatures"] !== undefined) {
    if (!Array.isArray(raw["deniedFeatures"])) return null
    for (const item of raw["deniedFeatures"]) {
      if (typeof item !== "string" || !CONFIG_FEATURE_SET.has(item)) return null
      if (!deniedFeatures.includes(item as ConnectorConfigFeature)) deniedFeatures.push(item as ConnectorConfigFeature)
    }
  }
  const chatApproval = raw["chatApproval"] ?? "inherit"
  const conductorApprovals = raw["conductorApprovals"] ?? "inherit"
  if (typeof chatApproval !== "string" || !CHAT_APPROVALS.has(chatApproval)) return null
  if (typeof conductorApprovals !== "string" || !CONDUCTOR_APPROVALS.has(conductorApprovals)) return null
  const rawMax = raw["maxStreams"]
  const maxStreams =
    rawMax === null || rawMax === undefined
      ? null
      : typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= MAX_STREAMS
        ? rawMax
        : null
  if (rawMax !== null && rawMax !== undefined && maxStreams === null) return null
  return {
    id,
    name,
    updatedAt,
    scopes,
    deniedFeatures,
    chatApproval: chatApproval as ConnectorChatApproval,
    conductorApprovals: conductorApprovals as ConnectorConductorApproval,
    maxStreams,
  }
}

/**
 * The host may only narrow. Intersect the cloud's effective scopes with the
 * local policy and clamp its stream ceiling, so a broken or malicious cloud
 * response can never widen what the host itself would allow.
 */
export function intersectConnectorProfile(
  profile: ConnectorConfigProfile,
  localScopes: readonly Scope[],
  localMaxStreams?: number,
): ConnectorConfigProfile {
  const allowed = new Set(localScopes)
  const scopes = profile.scopes.filter((scope) => allowed.has(scope))
  const maxStreams =
    profile.maxStreams === null || localMaxStreams === undefined
      ? profile.maxStreams
      : Math.min(profile.maxStreams, Math.max(1, Math.floor(localMaxStreams)))
  return { ...profile, scopes, maxStreams }
}

/**
 * Pull the assigned config profile. A profile is optional: `profile: null`
 * means none is assigned. Auth/transport/version failures return `ok:false`
 * with `profile:null`; callers keep their last cached value and never treat a
 * failed pull as an empty profile.
 */
export async function fetchConnectorConfig(
  connection: Pick<CloudConnection, "cloud" | "instanceId" | "deviceToken">,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ConnectorConfigResult> {
  const res = await fetchJson(
    cloudApiUrl(connection.cloud, "/api/connector/config"),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${connection.deviceToken}`,
        "X-Sensus-Instance": connection.instanceId,
        accept: "application/json",
      },
    },
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 10_000,
  )
  if (res.error !== null) return { ok: false, status: res.status, profile: null, version: null, error: res.error }
  if (!res.ok) {
    return { ok: false, status: res.status, profile: null, version: null, error: errorCode(res.body) ?? `HTTP ${res.status}` }
  }
  if (res.body === null || res.body["version"] !== 1) {
    const version = res.body?.["version"]
    return {
      ok: false,
      status: res.status,
      profile: null,
      version: typeof version === "number" ? version : null,
      error: `unsupported config pull version ${JSON.stringify(version)}`,
    }
  }
  if (!Object.hasOwn(res.body, "profile")) {
    return { ok: false, status: res.status, profile: null, version: 1, error: "invalid config pull response" }
  }
  const rawProfile = res.body["profile"]
  if (rawProfile === null) return { ok: true, status: res.status, profile: null, version: 1, error: null }
  const profile = parseConnectorConfigProfile(rawProfile)
  if (profile === null) {
    return { ok: false, status: res.status, profile: null, version: 1, error: "invalid config profile payload" }
  }
  return { ok: true, status: res.status, profile, version: 1, error: null }
}

export interface PollWhoamiOptions {
  fetchImpl?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxWaitMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  onPending?: () => void
}

export type PollWhoamiResult =
  | { ok: true; state: "active"; scopes: Scope[] }
  | { ok: true; state: "revoked" }
  | { ok: false; state: "pending"; error: string }
  | { ok: false; state: null; error: string }

export async function pollWhoami(
  connection: Pick<CloudConnection, "cloud" | "instanceId" | "deviceToken">,
  opts: PollWhoamiOptions = {},
): Promise<PollWhoamiResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60 * 1000
  const initial = opts.initialDelayMs ?? 1000
  const maxDelay = opts.maxDelayMs ?? 10_000
  const deadline = now() + maxWaitMs
  let delay = initial
  let announced = false
  for (;;) {
    const res = await whoami(connection, { fetchImpl: opts.fetchImpl })
    if (!res.ok) return { ok: false, state: null, error: res.error ?? "whoami failed" }
    if (res.state === "active") return { ok: true, state: "active", scopes: res.scopes }
    if (res.state === "revoked") return { ok: true, state: "revoked" }
    if (!announced) {
      announced = true
      opts.onPending?.()
    }
    const remaining = deadline - now()
    if (remaining <= 0) return { ok: false, state: "pending", error: "still pending owner approval" }
    await sleep(Math.min(delay, remaining))
    delay = Math.min(maxDelay, delay * 2)
  }
}

/** Read a line from the TTY without echo (the pairing code). */
export function promptHidden(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (input.isTTY !== true) {
    return Promise.reject(
      new Error("cannot prompt for the pairing code: stdin is not a TTY (pass --code)"),
    )
  }
  return new Promise<string>((resolve, reject) => {
    let value = ""
    const wasRaw = input.isRaw === true
    const cleanup = (): void => {
      try {
        input.setRawMode?.(wasRaw)
      } catch {
        // best-effort
      }
      input.removeListener("data", onData)
    }
    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk)
      for (const char of text) {
        if (char === "\u0003") {
          cleanup()
          stderr.write("\n")
          reject(new Error("pairing cancelled"))
          return
        }
        if (char === "\r" || char === "\n") {
          cleanup()
          stderr.write("\n")
          resolve(value.trim())
          return
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1)
          continue
        }
        if (char >= " ") value += char
      }
    }
    try {
      input.setRawMode?.(true)
      input.resume()
    } catch {
      cleanup()
      reject(new Error("cannot disable terminal echo for the pairing code"))
      return
    }
    stderr.write(question)
    input.on("data", onData)
  })
}

export interface PairOptions {
  home: string
  cloud: string
  code: string
  identity: HostIdentity
  policy: AuthPolicy
  version: string
  host: HostFacts
  name?: string
  uid?: number
  allowRoot?: boolean
  /** Which persistent service scope this pairing should use. */
  serviceScope?: "user" | "system" | "none"
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
  waitForApproval?: boolean
  poll?: Omit<PollWhoamiOptions, "fetchImpl">
  io: { out(s: string): void; err(s: string): void }
}

export type PairResult =
  | { ok: true; connection: CloudConnection; state: "active" | "pending" }
  | { ok: false; error: string }

/** Pair this host. Never logs or echoes the pairing code. */
export async function pairWithCloud(opts: PairOptions): Promise<PairResult> {
  const uid = opts.uid ?? process.getuid?.()
  if (uid === 0 && opts.allowRoot !== true) {
    return { ok: false, error: "refusing to pair as root without --allow-root" }
  }
  const normalized = normalizeCloudUrl(opts.cloud)
  if (!normalized.ok) return { ok: false, error: normalized.error }
  const code = normalizePairingCode(opts.code)
  if (code === null) return { ok: false, error: "invalid pairing code (want 8 characters, e.g. ABCD-EFGH)" }
  if (opts.policy.scopes.length === 0) return { ok: false, error: "the host policy grants no scopes" }

  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchJson(
    cloudApiUrl(normalized.cloud, "/api/connector/pair"),
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code,
        publicKey: opts.identity.publicKey,
        fingerprint: opts.identity.fingerprint,
        connectorVersion: opts.version,
        clientKind: "sensus-daemon",
        clientVersion: opts.version,
        scopes: opts.policy.scopes,
        host: opts.host,
      }),
    },
    fetchImpl,
    opts.timeoutMs ?? 20_000,
  )
  if (res.error !== null) return { ok: false, error: `pairing request failed: ${res.error}` }
  if (!res.ok) return { ok: false, error: `pairing refused (${errorCode(res.body) ?? `HTTP ${res.status}`})` }
  const instanceId = res.body?.["instanceId"]
  const deviceToken = res.body?.["deviceToken"]
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    return { ok: false, error: "pairing response has no instanceId" }
  }
  if (typeof deviceToken !== "string" || deviceToken.length === 0) {
    return { ok: false, error: "pairing response has no deviceToken" }
  }

  const connection: CloudConnection = {
    version: 1,
    cloud: normalized.cloud,
    instanceId,
    deviceToken,
    fingerprint: opts.identity.fingerprint,
    name: opts.name !== undefined && opts.name.length > 0 ? opts.name : null,
    pairedAt: (opts.now ?? Date.now)(),
    scopes: opts.policy.scopes,
    clientKind: "sensus-daemon",
    clientVersion: opts.version,
    unixUser: opts.host.unixUser ?? String(uid ?? "unknown"),
    uid,
    runsAsRoot: uid === 0,
    ...(opts.serviceScope !== undefined ? { serviceScope: opts.serviceScope } : {}),
    enabled: true,
  }
  const stored = writeCloudConnection(opts.home, connection, { uid, allowRoot: opts.allowRoot })
  if (!stored.ok) return { ok: false, error: stored.error ?? "cannot store the device token" }

  opts.io.out(`sensus cloud: paired with ${normalized.cloud}`)
  opts.io.out(`sensus cloud: instance    ${connection.instanceId}`)
  opts.io.out(`sensus cloud: fingerprint ${opts.identity.fingerprint} (compare this in the cloud panel)`)
  opts.io.out(`sensus cloud: scopes      ${opts.policy.scopes.join(",")}`)
  opts.io.out(`sensus cloud: runs as     ${connection.unixUser}${connection.runsAsRoot ? " (root)" : ""}`)

  const preflight = await whoami(connection, { fetchImpl })
  if (!preflight.ok) {
    if (preflight.status === 401) clearCloudConnection(opts.home)
    opts.io.err(`sensus cloud: whoami preflight failed: ${preflight.error ?? "unknown error"}`)
    return { ok: false, error: preflight.error ?? "whoami preflight failed" }
  }
  if (preflight.state === "revoked") {
    clearCloudConnection(opts.home)
    return { ok: false, error: "this instance was revoked; re-pair from the cloud panel" }
  }
  if (preflight.state === "active") {
    opts.io.out("sensus cloud: instance is active")
    return { ok: true, connection, state: "active" }
  }

  if (opts.waitForApproval === false) {
    opts.io.out("sensus cloud: waiting for owner approval in the cloud panel; the daemon will connect after approval")
    return { ok: true, connection, state: "pending" }
  }

  const polled = await pollWhoami(connection, {
    fetchImpl,
    ...(opts.poll ?? {}),
    onPending: () => opts.io.out("sensus cloud: waiting for owner approval in the cloud panel…"),
  })
  if (!polled.ok) {
    if (polled.state === "pending") {
      opts.io.out("sensus cloud: still pending — approve it in the cloud, then start the daemon")
      return { ok: true, connection, state: "pending" }
    }
    return { ok: false, error: polled.error }
  }
  if (polled.state === "revoked") {
    clearCloudConnection(opts.home)
    return { ok: false, error: "this instance was revoked; re-pair from the cloud panel" }
  }
  opts.io.out("sensus cloud: instance approved")
  return { ok: true, connection, state: "active" }
}
