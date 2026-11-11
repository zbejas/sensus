/**
 * The Sensus Cloud relay protocol v1 (`/projects/sensus_cloud/docs/protocol.md`).
 *
 * This module is the frozen wire contract: scope names, the host/daemon facts,
 * both frame unions, and the transport limits. It has no I/O and imports only
 * shared pure helpers, so the broker/tunnel/tests can all agree on one shape.
 *
 * The connector is a typed broker, never a generic proxy: the frame unions
 * below deliberately contain no HTTP request/response frame and no update op.
 */

import { isRecord } from "../../core/util.ts"
import { DEFAULT_SCOPE, SCOPES, normalizeScopeArray, type Scope } from "../../auth/scopes.ts"
import { challengeSigningInput } from "../../auth/identity.ts"

export { DEFAULT_SCOPE, SCOPES, normalizeScopeArray }
export type { Scope }
export { challengeSigningInput }

/** The protocol tag carried in `hello`. */
export const CLOUD_PROTOCOL = "sensus-cloud/1" as const

/** Heartbeat cadence requested by the cloud (fallback when hello.ok omits it). */
export const CLOUD_HEARTBEAT_MS = 15_000
/** Close after this long without any inbound frame (protocol transport rule). */
export const CLOUD_HEARTBEAT_TIMEOUT_MS = 45_000
/** Maximum JSON frame either direction. */
export const CLOUD_MAX_FRAME_BYTES = 4 * 1024 * 1024
/** Maximum concurrent streams per connection. */
export const CLOUD_MAX_STREAMS = 8
export const MAX_STREAMS = CLOUD_MAX_STREAMS
/** Terminal streams are at most half of the connection's stream budget. */
export const CLOUD_MAX_TERMINAL_STREAMS = 4
/** Chat/run streams share the other half. */
export const CLOUD_MAX_CHAT_RUN_STREAMS = 4
/** Default orchestrator run timeout (the cloud may ask for less/more). */
export const RUN_DEFAULT_TIMEOUT_SEC = 600
/** Hard upper bound a cloud-provided run timeout can request. */
export const RUN_MAX_TIMEOUT_SEC = 24 * 60 * 60
/**
 * Connector-side safety net for a pending prompt. The cloud owns the real
 * approval deadline (60 s, extendable while a viewer is active); this cap only
 * guarantees a wedged cloud can never park a run forever.
 */
export const CLOUD_APPROVAL_HARD_CAP_MS = 10 * 60 * 1000

/** Which host client is connected (legacy connector or the embedded daemon). */
export interface ClientFacts {
  kind: "connector" | "sensus-daemon"
  version: string
}

/** Host facts sent in the pairing request and the tunnel hello. */
export interface HostFacts {
  hostname: string
  platform: string
  arch: string
  unixUser?: string
  uid?: number
  runsAsRoot?: boolean
}

/** Daemon facts sent in `hello`/`daemon.status` (no pid/socket/tcp). */
export interface DaemonFacts {
  state: "running" | "stopped" | "unreachable"
  version?: string
  instanceId?: string
  startedAt?: number
  persistent?: boolean
  shellCount?: number
}

/** The typed stream kinds the cloud may open. */
export type StreamKind = "terminal" | "chat" | "run"

/** Connector → cloud frames. */
export type ConnectorToCloud =
  | { t: "auth"; signature: string }
  | {
      t: "hello"
      protocol: typeof CLOUD_PROTOCOL
      connectorVersion: string
      client?: ClientFacts
      scopes: Scope[]
      host: HostFacts
      daemon: DaemonFacts
      features: string[]
      limits: { maxStreams: number }
    }
  | { t: "pong"; n: number }
  | { t: "rpc.res"; id: string; result: unknown }
  | { t: "rpc.err"; id: string; code: string; message: string }
  | { t: "stream.opened"; streamId: string; meta?: Record<string, unknown> }
  | { t: "stream.open.err"; streamId: string; code: string; message: string }
  | { t: "stream.frame"; streamId: string; data: string }
  | { t: "stream.closed"; streamId: string; code: number; reason: string }
  | { t: "daemon.status"; daemon: DaemonFacts }
  | { t: "log"; level: "info" | "warn" | "error"; message: string }

/** Cloud → connector frames. */
export type CloudToConnector =
  | { t: "challenge"; nonce: string; exp: number }
  | { t: "auth.ok" }
  | {
      t: "hello.ok"
      connectionId: string
      heartbeatMs: number
      maxFrameBytes: number
      maxStreams: number
      serverTime: number
      scopes: Scope[]
    }
  | { t: "auth.err"; code: "unauthorized" | "revoked" | "pending" | "unsupported_protocol"; message?: string }
  | { t: "ping"; n: number }
  | { t: "rpc"; id: string; op: string; params?: unknown }
  | { t: "stream.open"; streamId: string; kind: StreamKind; params: unknown }
  | { t: "stream.send"; streamId: string; data: string }
  | { t: "stream.close"; streamId: string; code?: number; reason?: string }
  | { t: "bye"; reason: string }

/** Parse one inbound frame, with a typed failure (never throws). */
export type ParsedCloudFrame =
  | { ok: true; frame: CloudToConnector }
  | { ok: false; code: "invalid_json" | "invalid_frame" | "frame_too_large"; message: string }

/**
 * Parse an inbound JSON text frame and enforce the 4 MiB limit. Unknown `t`
 * values are `invalid_frame` — the connector never guesses at an extension it
 * does not understand, which is also why no tunnel op can update the binary.
 */
export function parseCloudFrame(raw: unknown, maxFrameBytes = CLOUD_MAX_FRAME_BYTES): ParsedCloudFrame {
  if (typeof raw !== "string") return { ok: false, code: "invalid_frame", message: "frame is not text" }
  if (Buffer.byteLength(raw, "utf8") > maxFrameBytes) {
    return { ok: false, code: "frame_too_large", message: `frame exceeds ${maxFrameBytes} bytes` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: "invalid_json", message: "frame is not valid JSON" }
  }
  if (!isRecord(parsed) || typeof parsed["t"] !== "string") {
    return { ok: false, code: "invalid_frame", message: "frame has no type tag" }
  }
  const t = parsed["t"]
  switch (t) {
    case "challenge":
      if (typeof parsed["nonce"] !== "string" || typeof parsed["exp"] !== "number") {
        return { ok: false, code: "invalid_frame", message: "challenge needs nonce + exp" }
      }
      break
    case "hello.ok":
      if (
        typeof parsed["connectionId"] !== "string" ||
        typeof parsed["heartbeatMs"] !== "number" ||
        typeof parsed["maxFrameBytes"] !== "number" ||
        typeof parsed["maxStreams"] !== "number" ||
        typeof parsed["serverTime"] !== "number" ||
        !Array.isArray(parsed["scopes"])
      ) {
        return { ok: false, code: "invalid_frame", message: "hello.ok is missing transport limits" }
      }
      break
    case "auth.err":
      if (typeof parsed["code"] !== "string") {
        return { ok: false, code: "invalid_frame", message: "auth.err has no code" }
      }
      break
    case "ping":
      if (typeof parsed["n"] !== "number") {
        return { ok: false, code: "invalid_frame", message: "ping has no sequence number" }
      }
      break
    case "rpc":
      if (typeof parsed["id"] !== "string" || typeof parsed["op"] !== "string") {
        return { ok: false, code: "invalid_frame", message: "rpc needs id + op" }
      }
      break
    case "stream.open":
      if (
        typeof parsed["streamId"] !== "string" ||
        (parsed["kind"] !== "terminal" && parsed["kind"] !== "chat" && parsed["kind"] !== "run")
      ) {
        return { ok: false, code: "invalid_frame", message: "stream.open needs streamId + kind" }
      }
      break
    case "stream.send":
      if (typeof parsed["streamId"] !== "string" || typeof parsed["data"] !== "string") {
        return { ok: false, code: "invalid_frame", message: "stream.send needs streamId + data" }
      }
      break
    case "stream.close":
      if (typeof parsed["streamId"] !== "string") {
        return { ok: false, code: "invalid_frame", message: "stream.close needs streamId" }
      }
      break
    case "auth.ok":
    case "bye":
      break
    default:
      return { ok: false, code: "invalid_frame", message: `unknown frame type ${JSON.stringify(t)}` }
  }
  return { ok: true, frame: parsed as unknown as CloudToConnector }
}
