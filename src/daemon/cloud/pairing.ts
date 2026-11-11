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
