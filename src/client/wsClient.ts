/**
 * wsClient — a typed client for the daemon's `/v1/ws` channel (IF2; P4b;
 * docs/daemon-api.md "WebSocket channels").
 *
 * The daemon owns the PTY/engine; the client owns the VT (D1). This module is
 * the transport half of the client: it opens the loopback WebSocket, correlates
 * request/response frames by `id`, fans events out to typed subscribers, and
 * exposes typed helpers for every frozen op. It performs NO rendering and no
 * UI imports — P4c wires a signal mirror on top of `on(event, handler)`.
 *
 * The transport is loopback TCP, not the Unix socket: Bun's WebSocket CLIENT
 * has no `unix` option, so the daemon serves `/v1/ws` on the loopback listener
 * (docs/daemon-api.md "Transport"). The WebSocket URL is therefore derived from
 * the daemon's loopback `tcp` address (read over REST — `restClient.ts`); the
 * auth token is read from the runtime dir (`token.ts`) unless supplied.
 *
 * Frozen envelope (docs/daemon-api.md):
 *   req {type:"req",id,op,…} · res {type:"res",id,ok,result?|error?}
 *   evt {type:"evt",event,…}
 *
 * Every handler is defensive (AGENTS.md rule 10): a malformed frame, a throwing
 * subscriber, or a socket error never throws into the TUI — it is reported
 * through `onError`. Inbound and outbound queues are bounded and drop-oldest so
 * a stalled reader/writer cannot grow memory without bound, mirroring the
 * daemon's own per-client queues.
 */

import { errorMessage, isRecord } from "../core/util.ts"
import { daemonRuntimeDir, daemonTokenPath } from "../daemon/paths.ts"
import { readToken } from "../daemon/token.ts"
import type {
  ChatListEntry,
  ChatMeta,
  ChatSendMode,
  ChatState,
  ShellAttachResult,
  ShellListEntry,
  ShellRole,
} from "../daemon/index.ts"
import type { ChatMessage, ChatStatus, TerminalStatus } from "../engine/index.ts"

// ---- base64 helpers (every WS byte field is base64) -------------------------

/** Encode raw bytes as base64 (the WS `data`/`replay` wire form). */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/** Decode a base64 WS byte field back to bytes. */
export function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"))
}

/** Encode UTF-8 text as base64 (convenience for `terminal.input`). */
export function textToBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64")
}

/** Decode a base64 WS byte field as UTF-8 text. */
export function base64ToText(data: string): string {
  return Buffer.from(data, "base64").toString("utf8")
}

// ---- typed events -----------------------------------------------------------

/** The `hello` handshake payload (sent once per socket, on every (re)connect). */
export interface HelloInfo {
  clientId: string
  protocol: string
  /** The daemon's `SENSUS_VERSION`, or null when unknown. */
  version: string | null
}

/** The frozen daemon → client event payloads (docs/daemon-api.md "Events"). */
export interface DaemonEventMap {
  hello: HelloInfo
  "terminal.output": { shellId: string; data: string; cursor?: number }
  "terminal.attached": ShellAttachResult
  "terminal.status": { shellId: string; status: TerminalStatus }
  "terminal.exit": { shellId: string; code: number | null }
  "terminal.role": { shellId: string; clientId: string; role: ShellRole }
  "terminal.shells": { shells: ShellListEntry[] }
  "chat.state": { chatId: string; state: ChatState }
  "chat.meta": { chatId: string; meta: ChatMeta }
  "chat.message": { chatId: string; message: ChatMessage }
  "chat.delta": { chatId: string; messageId: number; kind: "content" | "thinking"; text: string }
  "chat.status": { chatId: string; status: ChatStatus }
  "chat.plan": { chatId: string; message: ChatMessage }
  "chat.error": { chatId: string; message: string }
  "chat.done": { chatId: string }
  "chat.toast": { message: string; level?: string; ttlMs?: number }
  "approvals.request": {
    chatId: string
    callId: string
    tool: string
    args: Record<string, unknown>
    command: string | null
    destructive: boolean
  }
  "approvals.resolved": { chatId: string; callId: string; action: "accept" | "reject" | "aborted" }
  "sudo.request": { chatId: string; requestId: string; command: string; prompt: string }
  "sudo.resolved": { chatId: string; requestId: string; ok: boolean }
}

export type DaemonEventName = keyof DaemonEventMap

export type DaemonEventHandler<K extends DaemonEventName> = (payload: DaemonEventMap[K]) => void

// ---- typed ops --------------------------------------------------------------

/** The frozen client → daemon ops, params and results (docs/daemon-api.md). */
export interface DaemonOps {
  "terminal.list": { params: Record<string, never>; result: { shells: ShellListEntry[] } }
  "terminal.open": { params: { cols: number; rows: number; cwd?: string; shell?: string }; result: { shellId: string } }
  "terminal.attach": {
    params: { shellId: string; role?: ShellRole; cols?: number; rows?: number; cursor?: number }
    result: { shellId: string; role: ShellRole }
  }
  "terminal.detach": { params: { shellId: string }; result: { shellId: string } }
  "terminal.handover": { params: { shellId: string; to: string }; result: { shellId: string; clientId: string } }
  "terminal.input": { params: { shellId: string; data: string }; result: { shellId: string } }
  "terminal.resize": { params: { shellId: string; cols: number; rows: number }; result: { shellId: string } }
  "terminal.facts": {
    params: { shellId: string; lines: string[]; cursor: { x: number; y: number; visible: boolean } }
    result: { shellId: string }
  }
  "terminal.kill": { params: { shellId: string }; result: { shellId: string } }
  "chat.list": { params: Record<string, never>; result: { chats: ChatListEntry[] } }
  "chat.open": {
    params: { shellId?: string; agent?: string; model?: string; resume?: string }
    result: { chatId: string; state: ChatState }
  }
  "chat.attach": { params: { chatId: string }; result: { chatId: string; state: ChatState } }
  "chat.detach": { params: { chatId: string }; result: { chatId: string } }
  "chat.send": {
    params: { chatId: string; text: string; images?: Array<{ name: string; mediaType: string; data: string }> }
    result: { accepted: boolean; mode: ChatSendMode }
  }
  "chat.abort": { params: { chatId: string }; result: { ok: true } }
  "chat.compact": { params: { chatId: string }; result: { ok: true } }
  "chat.retry": { params: { chatId: string }; result: { ok: true } }
  "chat.setModel": { params: { chatId: string; model: string }; result: { ok: true } }
  "chat.setAgent": { params: { chatId: string; agent: string }; result: { ok: true } }
  "chat.setEffort": { params: { chatId: string; mode: string }; result: { ok: true } }
  "chat.cycleEffort": { params: { chatId: string }; result: { ok: true } }
  "chat.revert": { params: { chatId: string; messageId: number }; result: { ok: true } }
  "chat.setApproval": { params: { chatId: string; mode: "confirm" | "full-auto" }; result: { ok: true } }
  "chat.setMcp": { params: { chatId: string; enabled: boolean }; result: { ok: true } }
  "chat.trustAdd": { params: { chatId: string; tool: string; prefix: string }; result: { ok: true } }
  "chat.trustRevoke": { params: { chatId: string; tool: string; prefix: string }; result: { ok: true } }
  "chat.trustRevokeAll": { params: { chatId: string }; result: { ok: true } }
  "chat.planAnswer": {
    params: { chatId: string; messageId: number; decisions: Array<{ callId: string; accept: boolean }> }
    result: { ok: true }
  }
  "chat.answerAsk": { params: { chatId: string; callId: string; answer: string }; result: { ok: true } }
  "approvals.answer": {
    params: {
      chatId: string
      callId: string
      action: "accept" | "reject"
      addPrefix?: string
      addToSession?: boolean
      trust?: boolean
    }
    result: { ok: true }
  }
  "sudo.answer": { params: { chatId: string; requestId: string; password: string; remember?: boolean }; result: { ok: true } }
}

export type DaemonOpName = keyof DaemonOps

/** A WS error response / transport failure. `code` is a daemon error code. */
export class WsClientError extends Error {
  readonly code: string
  /** The op that failed, when known. */
  readonly op: string | undefined

  constructor(code: string, op?: string, message?: string) {
    super(message ?? (op !== undefined ? `${op}: ${code}` : code))
    this.name = "WsClientError"
    this.code = code
    this.op = op
  }
}

/** The client's connection state (observable; never throws). */
export type WsClientState = "idle" | "connecting" | "open" | "reconnecting" | "closed"

export interface WsClientOptions {
  /** Explicit WS URL (`ws://…/v1/ws`). Overrides `host`/`port`. */
  url?: string
  /** Loopback host; defaults to `127.0.0.1`. */
  host?: string
  /** The daemon's loopback TCP port (from `GET /v1/info`). Required unless `url`. */
  port?: number
  /** Runtime dir holding `daemon.token`; defaults to `daemonRuntimeDir()`. */
  runtimeDir?: string
  /** Bearer token; defaults to `readToken(daemon.token)`. */
  token?: string
  /** Per-request response timeout (ms); default 15000. */
  requestTimeoutMs?: number
  /** Auto-reconnect after an unexpected close; default true. */
  reconnect?: boolean
  /** First reconnect delay (ms); default 250, doubled per attempt. */
  reconnectBaseMs?: number
  /** Reconnect delay cap (ms); default 5000. */
  reconnectMaxMs?: number
  /** Bounded outbound queue cap in frame characters; default 4 MiB. */
  maxOutboundBytes?: number
  /** Bounded inbound queue cap in frame characters; default 4 MiB. */
  maxInboundBytes?: number
  /** WebSocket implementation seam (tests); defaults to the global `WebSocket`. */
  WebSocketImpl?: typeof WebSocket
  /** Transport/subscriber failure sink; never throws into the caller. */
  onError?: (message: string) => void
  /** Fired after a re-connect's `hello` (not the first connect). */
  onReconnect?: () => void
}

/** A bounded (drop-oldest) byte/char queue; the most recent item always survives. */
export class BoundedQueue<T> {
  private readonly items: T[] = []
  private bytes = 0

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (item: T) => number,
  ) {}

  get length(): number {
    return this.items.length
  }

  get byteLength(): number {
    return this.bytes
  }

  /** Append; returns the item dropped by the cap, or null when nothing dropped. */
  push(item: T): T | null {
    this.items.push(item)
    this.bytes += this.sizeOf(item)
    let dropped: T | null = null
    // Keep at least one item so the newest frame is never discarded.
    while (this.bytes > this.maxBytes && this.items.length > 1) {
      const old = this.items.shift()
      if (old === undefined) break
      this.bytes -= this.sizeOf(old)
      dropped = old
    }
    return dropped
  }

  shift(): T | undefined {
    const item = this.items.shift()
    if (item !== undefined) this.bytes -= this.sizeOf(item)
    return item
  }

  clear(): void {
    this.items.length = 0
    this.bytes = 0
  }
}

/** A pending `request()` awaiting its `res` frame. */
interface PendingRequest {
  op: string
  resolve: (result: Record<string, unknown>) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

type EventHandler = (payload: Record<string, unknown>) => void

/** The typed terminal op surface; each call is a `request()` round trip. */
export interface TerminalClient {
  list(): Promise<{ shells: ShellListEntry[] }>
  open(params: { cols: number; rows: number; cwd?: string; shell?: string }): Promise<{ shellId: string }>
  attach(params: { shellId: string; role?: ShellRole; cols?: number; rows?: number; cursor?: number }): Promise<{ shellId: string; role: ShellRole }>
  detach(params: { shellId: string }): Promise<{ shellId: string }>
  handover(params: { shellId: string; to: string }): Promise<{ shellId: string; clientId: string }>
  /** Encode `data` (bytes or UTF-8 text) as base64 and write it to the shell. */
  input(params: { shellId: string; data: Uint8Array | string }): Promise<{ shellId: string }>
  resize(params: { shellId: string; cols: number; rows: number }): Promise<{ shellId: string }>
  facts(params: {
    shellId: string
    lines: string[]
    cursor: { x: number; y: number; visible: boolean }
  }): Promise<{ shellId: string }>
  kill(params: { shellId: string }): Promise<{ shellId: string }>
}

/** The typed chat op surface. */
export interface ChatClient {
  list(): Promise<{ chats: ChatListEntry[] }>
  open(params?: { shellId?: string; agent?: string; model?: string; resume?: string }): Promise<{ chatId: string; state: ChatState }>
  attach(params: { chatId: string }): Promise<{ chatId: string; state: ChatState }>
  detach(params: { chatId: string }): Promise<{ chatId: string }>
  send(params: { chatId: string; text: string }): Promise<{ accepted: boolean; mode: ChatSendMode }>
  abort(params: { chatId: string }): Promise<{ ok: true }>
  compact(params: { chatId: string }): Promise<{ ok: true }>
  retry(params: { chatId: string }): Promise<{ ok: true }>
}

/** The typed approvals/sudo answer surface. */
export interface ApprovalsClient {
  answer(params: {
    chatId: string
    callId: string
    action: "accept" | "reject"
    addPrefix?: string
    addToSession?: boolean
    trust?: boolean
  }): Promise<{ ok: true }>
}

export interface SudoClient {
  answer(params: { chatId: string; requestId: string; password: string }): Promise<{ ok: true }>
}

function resolveUrl(opts: WsClientOptions): string | null {
  if (typeof opts.url === "string" && opts.url.length > 0) return opts.url
  if (typeof opts.port !== "number" || !Number.isFinite(opts.port) || opts.port <= 0) return null
  const host = opts.host !== undefined && opts.host.length > 0 ? opts.host : "127.0.0.1"
  return `ws://${host}:${opts.port}/v1/ws`
}

/**
 * A typed daemon WebSocket client. Construction starts connecting; every
 * failure is surface through `onError` (and the `state` getter), never a throw.
 */
export class WsClient {
  private readonly options: WsClientOptions
  private readonly WebSocketImpl: typeof WebSocket
  private readonly url: string | null
  private readonly token: string | null
  private readonly requestTimeoutMs: number
  private readonly maxOutboundBytes: number
  private readonly maxInboundBytes: number
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly handlers = new Map<string, Set<EventHandler>>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly outbound: BoundedQueue<string>
  private readonly inbound: BoundedQueue<string>

  private socket: WebSocket | null = null
  private openState: WsClientState = "idle"
  private idCounter = 0
  private helloSettled = false
  private helloValue: HelloInfo | null = null
  private everConnected = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private draining = false

  /** Resolves with the first `hello`; never rejects (check `state`/`onError`). */
  readonly hello: Promise<HelloInfo>

  readonly terminal: TerminalClient
  readonly chat: ChatClient
  readonly approvals: ApprovalsClient
  readonly sudo: SudoClient

  constructor(opts: WsClientOptions = {}) {
    this.options = opts
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket
    this.url = resolveUrl(opts)
    this.token =
      opts.token !== undefined && opts.token.length > 0
        ? opts.token
        : readToken(daemonTokenPath(opts.runtimeDir ?? daemonRuntimeDir()))
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
    this.maxOutboundBytes = opts.maxOutboundBytes ?? 4 * 1024 * 1024
    this.maxInboundBytes = opts.maxInboundBytes ?? 4 * 1024 * 1024
    this.reconnect = opts.reconnect !== false
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 250
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 5000
    this.outbound = new BoundedQueue(this.maxOutboundBytes, (frame) => frame.length)
    this.inbound = new BoundedQueue(this.maxInboundBytes, (frame) => frame.length)

    this.hello = new Promise<HelloInfo>((resolve) => {
      this.resolveHello = resolve
    })

    this.terminal = {
      list: () => this.request("terminal.list", {}),
      open: (params) => this.request("terminal.open", params),
      attach: (params) => this.request("terminal.attach", params),
      detach: (params) => this.request("terminal.detach", params),
      handover: (params) => this.request("terminal.handover", params),
      input: (params) =>
        this.request("terminal.input", {
          shellId: params.shellId,
          data: typeof params.data === "string" ? textToBase64(params.data) : bytesToBase64(params.data),
        }),
      resize: (params) => this.request("terminal.resize", params),
      facts: (params) => this.request("terminal.facts", params),
      kill: (params) => this.request("terminal.kill", params),
    }
    this.chat = {
      list: () => this.request("chat.list", {}),
      open: (params = {}) => this.request("chat.open", params),
      attach: (params) => this.request("chat.attach", params),
      detach: (params) => this.request("chat.detach", params),
      send: (params) => this.request("chat.send", params),
      abort: (params) => this.request("chat.abort", params),
      compact: (params) => this.request("chat.compact", params),
      retry: (params) => this.request("chat.retry", params),
    }
    this.approvals = {
      answer: (params) => this.request("approvals.answer", params),
    }
    this.sudo = {
      answer: (params) => this.request("sudo.answer", params),
    }

    if (this.url === null) {
      this.openState = "closed"
      this.reportError("wsClient: a port or url is required")
      return
    }
    this.open()
  }

  /** The current connection state. */
  get state(): WsClientState {
    return this.openState
  }

  /** Whether the socket is open and handshaked. */
  get connected(): boolean {
    return this.openState === "open"
  }

  /** The `hello` client id, or null before the first handshake. */
  get clientId(): string | null {
    return this.helloValue?.clientId ?? null
  }

  /** The daemon version from `hello`, or null before the first handshake. */
  get version(): string | null {
    return this.helloValue?.version ?? null
  }

  /** Resolve once `hello` arrives (rejects on timeout). */
  async waitForHello(timeoutMs = 5000): Promise<HelloInfo> {
    if (this.helloValue !== null) return this.helloValue
    return await new Promise<HelloInfo>((resolve, reject) => {
      let unsubscribe: (() => void) | null = null
      const timer = setTimeout(() => {
        unsubscribe?.()
        reject(new WsClientError("timeout", "hello", `hello not received within ${timeoutMs}ms`))
      }, timeoutMs)
      unsubscribe = this.on("hello", (info) => {
        clearTimeout(timer)
        unsubscribe?.()
        resolve(info)
      })
    })
  }

  /**
   * Send an op and resolve its `res`. Rejects with `WsClientError` on a daemon
   * error, a timeout, or a disconnect before the response.
   */
  request<Op extends DaemonOpName>(
    op: Op,
    params: DaemonOps[Op]["params"],
    timeoutMs = this.requestTimeoutMs,
  ): Promise<DaemonOps[Op]["result"]> {
    // A permanently-closed client rejects immediately instead of queueing a
    // frame that can never be sent (a reconnectable client queues).
    if (this.openState === "closed") {
      return Promise.reject(new WsClientError("closed", op, `${op}: client is closed`))
    }
    const id = this.nextId()
    let frame: string
    try {
      frame = JSON.stringify({ type: "req", id, op, ...params })
    } catch (e) {
      return Promise.reject(new WsClientError("invalid_request", op, errorMessage(e)))
    }
    return new Promise<DaemonOps[Op]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WsClientError("timeout", op, `${op} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        op,
        // The daemon echoes the frozen result shape for `op`; this is the one
        // boundary where JSON crosses into the typed surface.
        resolve: (result) => resolve(result as unknown as DaemonOps[Op]["result"]),
        reject,
        timer,
      })
      this.sendFrame(frame)
    })
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on<K extends DaemonEventName>(event: K, handler: DaemonEventHandler<K>): () => void {
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set<EventHandler>()
      this.handlers.set(event, set)
    }
    // Payload variance is asserted at this boundary; the daemon's event schema
    // is the single source (docs/daemon-api.md "Events").
    const stored = handler as unknown as EventHandler
    set.add(stored)
    return () => {
      set?.delete(stored)
    }
  }

  /** Remove a previously registered handler. */
  off<K extends DaemonEventName>(event: K, handler: DaemonEventHandler<K>): void {
    this.handlers.get(event)?.delete(handler as unknown as EventHandler)
  }

  /** Close intentionally (no reconnect) and reject in-flight requests. */
  close(): void {
    this.closedByUser = true
    this.cancelReconnect()
    this.failPending(new WsClientError("closed", undefined, "wsClient closed"))
    this.outbound.clear()
    this.inbound.clear()
    const socket = this.socket
    this.socket = null
    this.openState = "closed"
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // already gone
      }
    }
  }

  // -- transport --------------------------------------------------------------

  private open(): void {
    if (this.socket !== null || this.closedByUser || this.url === null) return
    this.openState = this.everConnected ? "reconnecting" : "connecting"
    let socket: WebSocket
    try {
      socket = new this.WebSocketImpl(
        this.url,
        this.token !== null ? { headers: { authorization: `Bearer ${this.token}` } } : undefined,
      )
    } catch (e) {
      this.reportError(`wsClient: connect failed: ${errorMessage(e)}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener("open", () => this.onOpen())
    socket.addEventListener("message", (event: MessageEvent) => this.onMessage(event))
    socket.addEventListener("error", () => this.reportError("wsClient: socket error"))
    socket.addEventListener("close", () => this.onClose())
  }

  private onOpen(): void {
    this.reconnectAttempt = 0
    this.openState = "open"
    this.flushOutbound()
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
      this.reportError(`wsClient: bad frame: ${errorMessage(e)}`)
      return
    }
    this.inbound.push(raw)
    if (!this.draining) {
      this.draining = true
      queueMicrotask(() => this.drainInbound())
    }
  }

  private drainInbound(): void {
    try {
      for (;;) {
        const raw = this.inbound.shift()
        if (raw === undefined) break
        this.handleFrame(raw)
      }
    } finally {
      this.draining = false
    }
  }

  private handleFrame(raw: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      this.reportError("wsClient: invalid_json frame")
      return
    }
    if (!isRecord(frame)) return
    if (frame["type"] === "res") {
      this.handleResponse(frame)
      return
    }
    if (frame["type"] === "evt" && typeof frame["event"] === "string") {
      this.handleEvent(frame["event"], frame)
    }
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = typeof frame["id"] === "string" ? frame["id"] : ""
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (frame["ok"] === true) {
      const result = isRecord(frame["result"]) ? frame["result"] : {}
      pending.resolve(result)
      return
    }
    const code = typeof frame["error"] === "string" ? frame["error"] : "error"
    pending.reject(new WsClientError(code, pending.op))
  }

  private handleEvent(name: string, payload: Record<string, unknown>): void {
    if (name === "hello") {
      const info: HelloInfo = {
        clientId: typeof payload["clientId"] === "string" ? payload["clientId"] : "",
        protocol: typeof payload["protocol"] === "string" ? payload["protocol"] : "",
        version: typeof payload["version"] === "string" ? payload["version"] : null,
      }
      this.helloValue = info
      this.openState = "open"
      if (!this.helloSettled) {
        this.helloSettled = true
        this.resolveHello(info)
      } else {
        try {
          this.options.onReconnect?.()
        } catch (e) {
          this.reportError(`wsClient: onReconnect threw: ${errorMessage(e)}`)
        }
      }
      this.everConnected = true
    }
    const set = this.handlers.get(name)
    if (set === undefined) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (e) {
        this.reportError(`wsClient: ${name} handler threw: ${errorMessage(e)}`)
      }
    }
  }

  private sendFrame(frame: string): void {
    const socket = this.socket
    if (socket !== null && socket.readyState === this.WebSocketImpl.OPEN && socket.bufferedAmount < 1024 * 1024) {
      try {
        socket.send(frame)
        return
      } catch {
        // fall through to the bounded queue
      }
    }
    this.outbound.push(frame)
  }

  private flushOutbound(): void {
    for (;;) {
      const frame = this.outbound.shift()
      if (frame === undefined) break
      const socket = this.socket
      if (socket === null || socket.readyState !== this.WebSocketImpl.OPEN) {
        // Lost the socket mid-flush: re-queue and stop (order preserved).
        this.outbound.push(frame)
        break
      }
      try {
        socket.send(frame)
      } catch {
        this.outbound.push(frame)
        break
      }
    }
  }

  private onClose(): void {
    this.socket = null
    // Frames queued from this socket are stale: a reconnect re-attaches and the
    // daemon's replay covers anything that was still in flight. Draining them
    // after the new socket attaches would double-apply output.
    this.inbound.clear()
    if (this.closedByUser) {
      this.openState = "closed"
      return
    }
    // In-flight requests can no longer be answered on this socket.
    this.failPending(new WsClientError("disconnected", undefined, "socket closed before a response"))
    if (!this.reconnect) {
      this.openState = "closed"
      return
    }
    this.openState = "reconnecting"
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return
    this.reconnectAttempt += 1
    const exponent = Math.min(this.reconnectAttempt - 1, 20)
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** exponent)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      try {
        pending.reject(error)
      } catch {
        // a rejected promise with no handler is the caller's concern
      }
    }
    this.pending.clear()
  }

  private nextId(): string {
    this.idCounter += 1
    return `c${this.idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  private reportError(message: string): void {
    try {
      this.options.onError?.(message)
    } catch {
      // the error sink must never throw back into the client
    }
  }

  /** Assigned in the constructor; resolves the public `hello` promise once. */
  private resolveHello: (info: HelloInfo) => void = () => {}
}
