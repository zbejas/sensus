/**
 * The outbound cloud tunnel (docs/auth.md "Tunnel"; protocol "Transport").
 *
 * TLS WSS only, one connection per paired instance, no inbound listener. The
 * handshake is challenge → auth signature → auth.ok → hello → hello.ok; the
 * signature covers `sensus-cloud/1\n<nonce>\n<instanceId>`, so a stolen device
 * token alone cannot replay a connection.
 *
 * Reconnect is jittered exponential backoff (1–60 s). Local streams never
 * survive a tunnel reconnect: the cloud marks them dead and a browser resync
 * opens a fresh stream with a cursor. Mutations are never retried.
 */

import { errorMessage } from "../../core/util.ts"
import { signChallenge, type HostIdentity } from "../../auth/identity.ts"
import type { AuthPolicy } from "../../auth/policy.ts"
import { hasScope } from "../../auth/scopes.ts"
import type { RpcOutcome, StreamOpenResult } from "./broker.ts"
import { daemonErrorFrame } from "./broker.ts"
import type { DaemonFacts, HostFacts, Scope, CloudToConnector } from "./protocol.ts"
import {
  CLOUD_HEARTBEAT_MS,
  CLOUD_HEARTBEAT_TIMEOUT_MS,
  CLOUD_MAX_FRAME_BYTES,
  CLOUD_MAX_STREAMS,
  CLOUD_PROTOCOL,
  parseCloudFrame,
} from "./protocol.ts"
import { connectorUrl } from "./state.ts"
import { whoami, type FetchLike, type WhoamiResult } from "./pairing.ts"
import { probeConnectorUpgrade } from "./probe.ts"

/** The broker surface the tunnel drives (tests substitute a fake). */
export interface TunnelBrokerLike {
  rpc(op: string, params: unknown): Promise<RpcOutcome>
  openStream(streamId: string, kind: "terminal" | "chat" | "run", params: unknown, emit: (frame: import("./protocol.ts").ConnectorToCloud) => void): Promise<StreamOpenResult>
  streamSend(streamId: string, data: string): { ok: true } | { ok: false; id: string; code: string; message: string }
  closeStream(streamId: string, reason?: string): Promise<boolean>
  closeAll(reason?: string): Promise<void>
  daemonFacts(): Promise<DaemonFacts>
  /** Optional: adopt the cloud's (never larger) stream budget. */
  setMaxStreams?(value: number): void
}

/** One queued outbound frame. */
export interface QueuedFrame {
  text: string
  control: boolean
}

/**
 * A bounded outbound queue with control priority. RPC/stream-open/close and
 * pong frames are `control`; bulk `stream.frame` output is droppable. When the
 * byte cap is hit, oldest data frames go first; only then oldest control
 * frames. The newest frame always survives.
 */
export class PriorityFrameQueue {
  private items: QueuedFrame[] = []
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  get length(): number {
    return this.items.length
  }

  get byteLength(): number {
    return this.bytes
  }

  /** Enqueue one frame; returns the number of dropped frames. */
  push(text: string, control: boolean): number {
    const size = Buffer.byteLength(text, "utf8")
    this.items.push({ text, control })
    this.bytes += size
    let dropped = 0
    while (this.bytes > this.maxBytes && this.items.length > 1) {
      let index = this.items.findIndex((item) => !item.control)
      if (index < 0) index = 0
      const [removed] = this.items.splice(index, 1)
      this.bytes -= removed === undefined ? 0 : Buffer.byteLength(removed.text, "utf8")
      dropped += 1
    }
    return dropped
  }

  shift(): QueuedFrame | undefined {
    const item = this.items.shift()
    if (item !== undefined) this.bytes -= Buffer.byteLength(item.text, "utf8")
    return item
  }

  clear(): void {
    this.items = []
    this.bytes = 0
  }
}

/** Jittered exponential backoff: 1–60 s by default. */
export function reconnectDelay(attempt: number, baseMs = 1000, maxMs = 60_000, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, attempt - 1), 20)
  const raw = Math.min(maxMs, baseMs * 2 ** exponent)
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4
  return Math.max(1, Math.round(raw * jitter))
}

export type TunnelState = "idle" | "connecting" | "handshaking" | "ready" | "reconnecting" | "stopped"

export interface CloudTunnelOptions {
  cloudUrl: string
  instanceId: string
  deviceToken: string
  identity: HostIdentity
  policy: AuthPolicy
  broker: TunnelBrokerLike
  connectorVersion: string
  host: HostFacts
  WebSocketImpl?: typeof WebSocket
  fetchImpl?: FetchLike
  /** Preflight `whoami` before each socket (off in tests/fake clouds). */
  preflight?: boolean
  /**
   * Probe `/api/connector` over HTTPS when a socket closes before its upgrade
   * completes, and log the HTTP answer (401/403/3xx/HTML). Off by default so
   * unit tests never reach the network; the daemon enables it.
   */
  probeUpgrade?: boolean
  now?: () => number
  random?: () => number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  heartbeatTimeoutMs?: number
  maxFrameBytes?: number
  maxOutboundBytes?: number
  maxStreams?: number
  onLog?: (level: "info" | "warn" | "error", message: string) => void
  onStateChange?: (state: TunnelState) => void
  onReady?: (info: { connectionId: string; heartbeatMs: number; maxFrameBytes: number; maxStreams: number }) => void
  onStopped?: (reason: string) => void
}

type HandshakePhase = "challenge" | "auth.ok" | "hello.ok"

export class CloudTunnel {
  private readonly WebSocketImpl: typeof WebSocket
  private readonly now: () => number
  private readonly random: () => number
  private readonly maxOutboundBytes: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly queue: PriorityFrameQueue
  private socket: WebSocket | null = null
  private stateValue: TunnelState = "idle"
  private phase: HandshakePhase = "challenge"
  private lastInbound = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private stopped = false
  /** True once the current socket reached its `open` event. */
  private opened = false
  /** Invalidates a late upgrade probe when a newer socket is ready/stopped. */
  private probeSeq = 0
  private serverMaxFrameBytes: number
  private serverMaxStreams: number
  private readyInfo: { connectionId: string; heartbeatMs: number; maxFrameBytes: number; maxStreams: number } | null = null

  constructor(private readonly opts: CloudTunnelOptions) {
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.maxOutboundBytes = opts.maxOutboundBytes ?? 8 * 1024 * 1024
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1000
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60_000
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? CLOUD_HEARTBEAT_TIMEOUT_MS
    this.serverMaxFrameBytes = opts.maxFrameBytes ?? CLOUD_MAX_FRAME_BYTES
    this.serverMaxStreams = opts.maxStreams ?? CLOUD_MAX_STREAMS
    this.queue = new PriorityFrameQueue(this.maxOutboundBytes)
  }

  get state(): TunnelState {
    return this.stateValue
  }

  /** Begin connecting; resolves once the socket attempt is started. */
  start(): void {
    this.stopped = false
    this.reconnectAttempt = 0
    this.openSocket()
  }

  /** Close intentionally and release every local stream. */
  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    this.queue.clear()
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      try {
        socket.close(1000, "connector stopping")
      } catch {
        // already gone
      }
    }
    this.setState("stopped")
    await this.opts.broker.closeAll("shutdown")
  }

  // -- connection -------------------------------------------------------------

  private openSocket(): void {
    if (this.stopped || this.socket !== null) return
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting")
    void this.preflightAndOpen()
  }

  private async preflightAndOpen(): Promise<void> {
    if (this.stopped) return
    if (this.opts.preflight === true) {
      const res: WhoamiResult = await whoami(
        { cloud: this.opts.cloudUrl, instanceId: this.opts.instanceId, deviceToken: this.opts.deviceToken },
        { fetchImpl: this.opts.fetchImpl },
      )
      if (this.stopped) return
      if (!res.ok) {
        if (res.status === 401) {
          this.stopBecause("unauthorized")
          return
        }
        this.report("warn", `whoami preflight failed: ${res.error ?? "unknown error"}`)
        this.scheduleReconnect()
        return
      }
      if (res.state === "revoked") {
        this.stopBecause("revoked")
        return
      }
      if (res.state === "pending") {
        this.report("info", "waiting for owner approval (whoami: pending)")
        this.scheduleReconnect()
        return
      }
    }
    this.connectWebSocket()
  }

  private connectWebSocket(): void {
    if (this.stopped || this.socket !== null) return
    let socket: WebSocket
    try {
      socket = new this.WebSocketImpl(connectorUrl(this.opts.cloudUrl), {
        headers: {
          authorization: `Bearer ${this.opts.deviceToken}`,
          "x-sensus-instance": this.opts.instanceId,
        },
      })
    } catch (e) {
      this.report("error", `cloud connect failed: ${errorMessage(e)}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.phase = "challenge"
    this.opened = false
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return
      this.opened = true
      this.lastInbound = this.now()
      this.setState("handshaking")
      this.handshakeTimer = setTimeout(() => {
        if (this.socket !== socket || this.stateValue !== "handshaking") return
        this.report("warn", "cloud handshake timed out")
        void this.closeSocket(4402, "handshake timeout")
      }, 15_000)
      this.handshakeTimer.unref?.()
      this.flushQueue()
    })
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== socket) return
      this.onMessage(event)
    })
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return
      this.report("warn", "cloud socket error")
    })
    socket.addEventListener("close", (event: CloseEvent) => {
      if (this.socket !== socket) return
      void this.onSocketClosed(
        typeof event.code === "number" ? event.code : 1006,
        typeof event.reason === "string" ? event.reason : "",
      )
    })
  }

  private onMessage(event: MessageEvent): void {
    let raw: string
    try {
      const data = event.data
      if (typeof data === "string") raw = data
      else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(new Uint8Array(data))
      else if (data instanceof Uint8Array) raw = new TextDecoder().decode(data)
      else raw = String(data)
    } catch (e) {
      this.report("warn", `cloud frame decode failed: ${errorMessage(e)}`)
      return
    }
    this.lastInbound = this.now()
    const parsed = parseCloudFrame(raw, this.serverMaxFrameBytes)
    if (!parsed.ok) {
      // Oversize/malformed frames are a typed log, not a dropped socket.
      this.send({ t: "log", level: "warn", message: `${parsed.code}: ${parsed.message}` }, true)
      return
    }
    void this.handleFrame(parsed.frame).catch((e: unknown) => {
      this.report("error", `cloud frame handler failed: ${errorMessage(e)}`)
    })
  }

  private async handleFrame(frame: CloudToConnector): Promise<void> {
    switch (frame.t) {
      case "challenge": {
        if (this.phase !== "challenge") {
          this.report("warn", "unexpected challenge during the handshake")
          return
        }
        if (frame.exp < this.now() - 30_000) {
          this.report("warn", "cloud challenge is expired")
          void this.closeSocket(4402, "expired challenge")
          return
        }
        const signature = signChallenge(this.opts.identity, frame.nonce, this.opts.instanceId)
        this.send({ t: "auth", signature }, true)
        this.phase = "auth.ok"
        return
      }
      case "auth.ok": {
        if (this.phase !== "auth.ok") return
        const daemon = await this.opts.broker.daemonFacts().catch(() => ({ state: "unreachable" as const }))
        const features: string[] = ["terminal.facts", "terminal.handover", "transcript.read", "memory.read", "memory.write"]
        // Deletion is permanently destructive and off unless the host opted in.
        if (this.opts.policy.deleteTranscripts === true) features.push("transcript.delete")
        this.send(
          {
            t: "hello",
            protocol: CLOUD_PROTOCOL,
            connectorVersion: this.opts.connectorVersion,
            client: { kind: "sensus-daemon", version: this.opts.connectorVersion },
            scopes: [...this.opts.policy.scopes],
            host: this.opts.host,
            daemon,
            features,
            limits: { maxStreams: Math.min(this.opts.maxStreams ?? CLOUD_MAX_STREAMS, this.opts.policy.maxStreams) },
          },
          true,
        )
        this.phase = "hello.ok"
        return
      }
      case "hello.ok": {
        if (this.phase !== "hello.ok") return
        this.clearHandshakeTimer()
        this.serverMaxFrameBytes = Math.max(1024, Math.min(frame.maxFrameBytes, this.opts.maxFrameBytes ?? CLOUD_MAX_FRAME_BYTES))
        this.serverMaxStreams = Math.max(1, Math.min(frame.maxStreams, CLOUD_MAX_STREAMS))
        this.opts.broker.setMaxStreams?.(this.serverMaxStreams)
        this.readyInfo = {
          connectionId: frame.connectionId,
          heartbeatMs: frame.heartbeatMs,
          maxFrameBytes: this.serverMaxFrameBytes,
          maxStreams: this.serverMaxStreams,
        }
        this.reconnectAttempt = 0
        this.setState("ready")
        this.startHeartbeatMonitor()
        this.sendDaemonStatus()
        this.opts.onReady?.(this.readyInfo)
        return
      }
      case "auth.err": {
        this.report("warn", `cloud auth error: ${frame.code}${frame.message !== undefined ? ` (${frame.message})` : ""}`)
        if (frame.code === "revoked" || frame.code === "unauthorized" || frame.code === "unsupported_protocol") {
          this.stopBecause(frame.code)
        } else {
          void this.closeSocket(4403, "pending approval")
        }
        return
      }
      case "ping": {
        this.send({ t: "pong", n: frame.n }, true)
        return
      }
      case "rpc": {
        if (this.stateValue !== "ready") return
        await this.handleRpc(frame.id, frame.op, frame.params)
        return
      }
      case "stream.open": {
        if (this.stateValue !== "ready") {
          this.send({ t: "stream.open.err", streamId: frame.streamId, code: "not_ready", message: "tunnel is not ready" }, true)
          return
        }
        await this.handleStreamOpen(frame.streamId, frame.kind, frame.params)
        return
      }
      case "stream.send": {
        if (this.stateValue !== "ready") return
        const outcome = this.opts.broker.streamSend(frame.streamId, frame.data)
        if (!outcome.ok) {
          this.send(
            {
              t: "stream.frame",
              streamId: frame.streamId,
              data: daemonErrorFrame(outcome.id || "cloud", outcome.code, outcome.message),
            },
            true,
          )
        }
        return
      }
      case "stream.close": {
        if (this.stateValue !== "ready") return
        const existed = await this.opts.broker.closeStream(frame.streamId, frame.reason ?? "closed")
        this.send({
          t: "stream.closed",
          streamId: frame.streamId,
          code: existed ? (frame.code ?? 1000) : 1004,
          reason: existed ? (frame.reason ?? "closed") : "stream_not_found",
        }, true)
        return
      }
      case "bye": {
        this.report("info", `cloud closed the connection: ${frame.reason}`)
        if (/revok/iu.test(frame.reason)) this.stopBecause("revoked")
        else void this.closeSocket(1000, "bye")
        return
      }
    }
  }

  private async handleRpc(id: string, op: string, params: unknown): Promise<void> {
    try {
      const outcome = await this.opts.broker.rpc(op, params)
      if (outcome.ok) this.send({ t: "rpc.res", id, result: outcome.result ?? {} }, true)
      else this.send({ t: "rpc.err", id, code: outcome.code ?? "error", message: outcome.message ?? "request failed" }, true)
    } catch (e) {
      this.send({ t: "rpc.err", id, code: "internal_error", message: errorMessage(e) }, true)
    }
  }

  private async handleStreamOpen(streamId: string, kind: "terminal" | "chat" | "run", params: unknown): Promise<void> {
    try {
      const res = await this.opts.broker.openStream(streamId, kind, params, (frame) => this.send(frame, frame.t !== "stream.frame"))
      if (!res.ok) {
        this.send(
          { t: "stream.open.err", streamId, code: res.code ?? "open_failed", message: res.message ?? "stream open failed" },
          true,
        )
      }
    } catch (e) {
      this.send({ t: "stream.open.err", streamId, code: "internal_error", message: errorMessage(e) }, true)
    }
  }

  // -- heartbeat/reconnect ----------------------------------------------------

  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor()
    const period = Math.max(1000, Math.min(5000, Math.floor(this.heartbeatTimeoutMs / 3)))
    this.heartbeatTimer = setInterval(() => {
      if (this.socket === null) return
      if (this.now() - this.lastInbound > this.heartbeatTimeoutMs) {
        this.report("warn", `cloud heartbeat timed out (${this.heartbeatTimeoutMs}ms)`)
        void this.closeSocket(4408, "heartbeat timeout")
      }
    }, period)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async onSocketClosed(code: number, reason: string): Promise<void> {
    const failedUpgrade = !this.opened
    this.socket = null
    this.clearTimers()
    this.readyInfo = null
    this.queue.clear()
    // No local stream survives a tunnel reconnect (protocol "Local connector
    // policy"): close every local WS; the cloud marks streams dead. Await the
    // cleanup so a fast reconnect cannot race a new control client.
    await this.opts.broker.closeAll("tunnel_closed")
    if (this.stopped) return
    if (failedUpgrade && this.opts.probeUpgrade === true) this.probeUpgradeFailure()
    if (code === 4401) {
      this.stopBecause("unauthorized")
      return
    }
    if (code === 4402) {
      this.stopBecause("unsupported_protocol")
      return
    }
    if (code === 4403) {
      this.report("info", "cloud says the instance is pending approval")
    } else if (code === 4429) {
      this.report("warn", "cloud rate limited the connector")
    } else if (reason.length > 0) {
      this.report("info", `cloud connection closed: ${code} ${reason}`)
    }
    this.scheduleReconnect()
  }

  /**
   * Best-effort: ask the same endpoint (over HTTPS) why the upgrade failed and
   * surface the HTTP status/content type instead of Bun's opaque error. Runs in
   * the background so a hanging proxy never delays the reconnect.
   */
  private probeUpgradeFailure(): void {
    const seq = ++this.probeSeq
    void probeConnectorUpgrade({
      cloud: this.opts.cloudUrl,
      deviceToken: this.opts.deviceToken,
      instanceId: this.opts.instanceId,
      ...(this.opts.fetchImpl !== undefined ? { fetchImpl: this.opts.fetchImpl } : {}),
      timeoutMs: 5000,
    })
      .then((result) => {
        if (this.stopped || seq !== this.probeSeq || this.stateValue === "ready") return
        this.report("warn", `cloud tunnel upgrade failed: ${result.detail}`)
      })
      .catch((e: unknown) => {
        if (this.stopped || seq !== this.probeSeq || this.stateValue === "ready") return
        this.report("warn", `cloud tunnel upgrade probe failed: ${errorMessage(e)}`)
      })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    this.reconnectAttempt += 1
    const delay = reconnectDelay(this.reconnectAttempt, this.reconnectBaseMs, this.reconnectMaxMs, this.random)
    this.setState("reconnecting")
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
    // The daemon's listeners (and, when paired, the lifecycle pin) keep the
    // process alive; the timer itself must not prevent an idle exit in tests.
    this.reconnectTimer.unref?.()
  }

  private async closeSocket(code: number, reason: string): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.clearTimers()
    this.readyInfo = null
    if (socket !== null) {
      try {
        socket.close(code, reason)
      } catch {
        // already gone
      }
    }
    // This path is a tunnel loss too (heartbeat/handshake/pending): no local
    // stream may survive into the next connection.
    await this.opts.broker.closeAll("tunnel_lost")
    if (this.stopped) return
    this.scheduleReconnect()
  }

  private stopBecause(reason: string): void {
    this.stopped = true
    this.clearTimers()
    this.queue.clear()
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      try {
        socket.close(1000, reason)
      } catch {
        // already gone
      }
    }
    this.setState("stopped")
    void this.opts.broker.closeAll(reason)
    this.report("info", `cloud relay stopped: ${reason}`)
    this.opts.onStopped?.(reason)
  }

  private clearTimers(): void {
    this.clearHandshakeTimer()
    this.stopHeartbeatMonitor()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  // -- outbound ---------------------------------------------------------------

  /** Serialize/send one frame; control frames jump the droppable data queue. */
  private send(frame: import("./protocol.ts").ConnectorToCloud, control: boolean): void {
    let text: string
    try {
      text = JSON.stringify(frame)
    } catch (e) {
      this.report("warn", `cloud frame serialize failed: ${errorMessage(e)}`)
      return
    }
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes > this.serverMaxFrameBytes) {
      this.sendOversizeError(frame)
      return
    }
    if (this.socket !== null && this.socket.bufferedAmount < 1024 * 1024 && this.queue.length === 0) {
      try {
        this.socket.send(text)
        return
      } catch {
        // fall through to the queue
      }
    }
    const dropped = this.queue.push(text, control)
    if (dropped > 0) this.report("warn", `cloud outbound queue dropped ${dropped} frame(s)`)
    this.flushQueue()
  }

  /** A typed fallback instead of sending an over-limit frame. */
  private sendOversizeError(frame: import("./protocol.ts").ConnectorToCloud): void {
    if (frame.t === "rpc.res") {
      this.send({ t: "rpc.err", id: frame.id, code: "frame_too_large", message: "the result exceeds the cloud frame limit" }, true)
      return
    }
    if (frame.t === "stream.frame") {
      this.send({ t: "stream.closed", streamId: frame.streamId, code: 1009, reason: "frame_too_large" }, true)
      return
    }
    this.report("warn", `over-limit cloud frame (${frame.t}) dropped`)
  }

  private flushQueue(): void {
    if (this.socket === null) return
    for (;;) {
      const item = this.queue.shift()
      if (item === undefined) return
      if (this.socket === null) return
      if (this.socket.bufferedAmount > 1024 * 1024) {
        this.queue.push(item.text, item.control)
        return
      }
      try {
        this.socket.send(item.text)
      } catch {
        this.queue.push(item.text, item.control)
        return
      }
    }
  }

  private sendDaemonStatus(): void {
    void this.opts.broker
      .daemonFacts()
      .then((daemon) => this.send({ t: "daemon.status", daemon }, true))
      .catch(() => {
        // status is best-effort
      })
  }

  private setState(state: TunnelState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    // A fresh ready connection invalidates any in-flight failure probe.
    if (state === "ready") this.probeSeq += 1
    try {
      this.opts.onStateChange?.(state)
    } catch {
      // observation must never break the tunnel
    }
  }

  private report(level: "info" | "warn" | "error", message: string): void {
    try {
      this.opts.onLog?.(level, message)
    } catch {
      // logging must never throw
    }
  }
}

/** True when the local policy grants `scope` — exported for the tunnel's docs/tests. */
export function tunnelScopeAllowed(policy: AuthPolicy, scope: Scope): boolean {
  return hasScope(policy.scopes, scope)
}
