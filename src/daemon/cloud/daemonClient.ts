/**
 * A small local client for the daemon's `/v1/ws` channel (docs/daemon-api.md
 * "Envelope"). It is deliberately not `src/client/wsClient.ts`: the relay needs
 * a fresh discovery (token + port) for every socket and no automatic reconnect
 * (the cloud owns stream lifetimes), and it must not pull any client/TUI code.
 *
 * One instance = one local Sensus WS = one cloud stream (docs/auth.md
 * "Terminal/chat/run streams"). Frames are forwarded verbatim to `onFrame`,
 * while request ids are correlated for the broker's own ops.
 */

import { errorMessage, isRecord } from "../../core/util.ts"
import type { DiscoveryResult } from "./discovery.ts"

/** A daemon WS frame (`req`/`res`/`evt`), kept loose at the transport boundary. */
export interface DaemonFrame extends Record<string, unknown> {
  type?: string
  id?: string
  ok?: boolean
  result?: unknown
  error?: string
  event?: string
}

/** The daemon `hello` info. */
export interface DaemonHello {
  clientId: string
  protocol: string
  version: string | null
}

/** A stable transport/daemon failure code. */
export class DaemonClientError extends Error {
  readonly code: string
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = "DaemonClientError"
    this.code = code
  }
}

export interface DaemonClientOptions {
  /** Fresh discovery per connect (token + port are never cached). */
  discover: () => Promise<DiscoveryResult>
  WebSocketImpl?: typeof WebSocket
  requestTimeoutMs?: number
  helloTimeoutMs?: number
  /** Hard cap on one inbound frame; larger frames are rejected. */
  maxFrameBytes?: number
  onError?: (message: string) => void
}

type Pending = {
  op: string
  resolve: (result: Record<string, unknown>) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** The interface the broker depends on (tests substitute a fake). */
export interface LocalDaemonLike {
  readonly clientId: string | null
  readonly connected: boolean
  connect(): Promise<DaemonHello>
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  sendRaw(raw: string): void
  onFrame(handler: (raw: string, frame: DaemonFrame) => void): () => void
  onEvent(name: string, handler: (frame: DaemonFrame) => void): () => void
  onClose(handler: (info: { code: number; reason: string }) => void): () => void
  close(): void
}

function parseFrame(raw: string): DaemonFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as DaemonFrame) : null
  } catch {
    return null
  }
}

export class LocalDaemonClient implements LocalDaemonLike {
  private readonly WebSocketImpl: typeof WebSocket
  private readonly requestTimeoutMs: number
  private readonly helloTimeoutMs: number
  private readonly maxFrameBytes: number
  private socket: WebSocket | null = null
  private state: "idle" | "connecting" | "open" | "closed" = "idle"
  private helloValue: DaemonHello | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly frameHandlers = new Set<(raw: string, frame: DaemonFrame) => void>()
  private readonly eventHandlers = new Map<string, Set<(frame: DaemonFrame) => void>>()
  private readonly closeHandlers = new Set<(info: { code: number; reason: string }) => void>()
  private idCounter = 0
  private helloWaiters: Array<{ resolve: (hello: DaemonHello) => void; reject: (e: unknown) => void }> = []

  constructor(private readonly opts: DaemonClientOptions) {
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 5_000
    this.maxFrameBytes = opts.maxFrameBytes ?? 4 * 1024 * 1024
  }

  get clientId(): string | null {
    return this.helloValue?.clientId ?? null
  }

  get connected(): boolean {
    return this.state === "open" && this.socket !== null
  }

  /**
   * Discover + open + wait for `hello`. On a pre-hello close (a rotated token /
   * 401 is indistinguishable at the WebSocket layer) it re-discovers and tries
   * exactly once, so a daemon restart is transparent but a wrong token is not
   * retried forever.
   */
  async connect(): Promise<DaemonHello> {
    if (this.state === "open" && this.helloValue !== null) return this.helloValue
    if (this.state === "closed") throw new DaemonClientError("closed", "local daemon client is closed")
    this.state = "connecting"
    let lastError: unknown = new DaemonClientError("daemon_unreachable", "local daemon not reachable")
    for (let attempt = 0; attempt < 2; attempt++) {
      const discovery = await this.opts.discover()
      if (!discovery.ok) {
        lastError = new DaemonClientError(discovery.code, discovery.message)
        // A missing socket/token cannot be fixed by re-reading it.
        if (discovery.state === "stopped") break
        continue
      }
      try {
        await this.openSocket(discovery.discovery.wsUrl, discovery.discovery.token)
        const hello = await this.waitForHello()
        this.state = "open"
        return hello
      } catch (e) {
        lastError = e
        this.closeSocket()
        this.state = "connecting"
        this.helloValue = null
        // Retry once with a FRESH discovery on any pre-hello transport failure.
        // This covers the daemon's 401-on-upgrade path (Bun's client exposes no
        // HTTP status), plus a token/port rotation between the discovery read
        // and the upgrade. A stable protocol error is never retried.
        const retryable =
          e instanceof DaemonClientError &&
          (e.code === "hello_timeout" || e.code === "daemon_connect_failed" || e.code === "daemon_disconnected")
        if (!retryable) break
      }
    }
    this.state = "closed"
    throw lastError instanceof Error ? lastError : new DaemonClientError("daemon_unreachable", String(lastError))
  }

  /** Send one op and resolve its `res` (rejects with `DaemonClientError`). */
  request(op: string, params: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<Record<string, unknown>> {
    if (!this.connected) {
      return Promise.reject(new DaemonClientError("daemon_disconnected", `${op}: local daemon is not connected`))
    }
    const id = this.nextId()
    let frame: string
    try {
      frame = JSON.stringify({ type: "req", id, op, ...params })
    } catch (e) {
      return Promise.reject(new DaemonClientError("invalid_request", errorMessage(e)))
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DaemonClientError("timeout", `${op} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { op, resolve, reject, timer })
      try {
        this.sendRaw(frame)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  /** Forward a raw daemon WS frame (used for cloud-initiated stream ops). */
  sendRaw(raw: string): void {
    if (this.socket === null || this.state !== "open") {
      throw new DaemonClientError("daemon_disconnected", "local daemon is not connected")
    }
    try {
      this.socket.send(raw)
    } catch (e) {
      throw new DaemonClientError("daemon_send_failed", errorMessage(e))
    }
  }

  onFrame(handler: (raw: string, frame: DaemonFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => this.frameHandlers.delete(handler)
  }

  onEvent(name: string, handler: (frame: DaemonFrame) => void): () => void {
    let set = this.eventHandlers.get(name)
    if (set === undefined) {
      set = new Set()
      this.eventHandlers.set(name, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  onClose(handler: (info: { code: number; reason: string }) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.rejectHelloWaiters(new DaemonClientError("closed", "client closed"))
    this.failPending(new DaemonClientError("closed", "local daemon client closed"))
    this.closeSocket()
  }

  // -- transport --------------------------------------------------------------

  private openSocket(url: string, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        if (error !== undefined) reject(error)
        else resolve()
      }
      let socket: WebSocket
      try {
        socket = new this.WebSocketImpl(url, { headers: { authorization: `Bearer ${token}` } })
      } catch (e) {
        finish(new DaemonClientError("daemon_connect_failed", errorMessage(e)))
        return
      }
      this.socket = socket
      const openTimer = setTimeout(() => {
        finish(new DaemonClientError("daemon_connect_failed", "local daemon socket open timed out"))
        try {
          socket.close()
        } catch {
          // already gone
        }
      }, this.helloTimeoutMs)
      socket.addEventListener("open", () => {
        clearTimeout(openTimer)
        if (this.socket !== socket) return
        // `state` becomes open only after `hello`; sendRaw must still work for
        // the daemon's own hello event, so mark the transport ready here.
        this.state = "open"
        finish()
      })
      socket.addEventListener("message", (event: MessageEvent) => {
        if (this.socket !== socket) return
        this.onMessage(event)
      })
      socket.addEventListener("error", () => {
        clearTimeout(openTimer)
        if (this.socket !== socket) return
        finish(new DaemonClientError("daemon_connect_failed", "local daemon socket error"))
      })
      socket.addEventListener("close", (event: CloseEvent) => {
        clearTimeout(openTimer)
        if (this.socket !== socket) return
        const code = typeof event.code === "number" ? event.code : 1006
        const reason = typeof event.reason === "string" ? event.reason : ""
        this.onSocketClosed(code, reason)
        finish(new DaemonClientError("daemon_disconnected", `local daemon socket closed (${code})`))
      })
    })
  }

  private waitForHello(): Promise<DaemonHello> {
    if (this.helloValue !== null) return Promise.resolve(this.helloValue)
    return new Promise<DaemonHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiters = this.helloWaiters.filter((w) => w.resolve !== resolve)
        reject(new DaemonClientError("hello_timeout", "local daemon did not send hello"))
      }, this.helloTimeoutMs)
      timer.unref?.()
      this.helloWaiters.push({
        resolve: (hello) => {
          clearTimeout(timer)
          resolve(hello)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
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
      this.reportError(`local daemon: bad frame: ${errorMessage(e)}`)
      return
    }
    if (Buffer.byteLength(raw, "utf8") > this.maxFrameBytes) {
      this.reportError("local daemon: frame exceeds the relay's inbound cap")
      return
    }
    const frame = parseFrame(raw)
    if (frame === null) {
      this.reportError("local daemon: invalid JSON frame")
      return
    }
    if (frame.type === "evt" && frame.event === "hello") {
      const hello: DaemonHello = {
        clientId: typeof frame["clientId"] === "string" ? frame["clientId"] : "",
        protocol: typeof frame["protocol"] === "string" ? frame["protocol"] : "",
        version: typeof frame["version"] === "string" ? frame["version"] : null,
      }
      this.helloValue = hello
      this.state = "open"
      const waiters = this.helloWaiters
      this.helloWaiters = []
      for (const waiter of waiters) waiter.resolve(hello)
    }
    for (const handler of [...this.frameHandlers]) {
      try {
        handler(raw, frame)
      } catch (e) {
        this.reportError(`local daemon: frame handler threw: ${errorMessage(e)}`)
      }
    }
    if (frame.type === "res") this.handleResponse(frame)
    if (frame.type === "evt" && typeof frame.event === "string") this.handleEvent(frame.event, frame)
  }

  private handleResponse(frame: DaemonFrame): void {
    const id = typeof frame.id === "string" ? frame.id : ""
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (frame.ok === true) {
      pending.resolve(isRecord(frame.result) ? frame.result : {})
      return
    }
    pending.reject(new DaemonClientError(typeof frame.error === "string" ? frame.error : "error", `${pending.op} failed`))
  }

  private handleEvent(name: string, frame: DaemonFrame): void {
    const set = this.eventHandlers.get(name)
    if (set === undefined) return
    for (const handler of [...set]) {
      try {
        handler(frame)
      } catch (e) {
        this.reportError(`local daemon: ${name} handler threw: ${errorMessage(e)}`)
      }
    }
  }

  private onSocketClosed(code: number, reason: string): void {
    if (this.socket === null && this.state === "closed") return
    const hadHello = this.helloValue !== null
    this.socket = null
    this.state = "closed"
    this.rejectHelloWaiters(new DaemonClientError("daemon_disconnected", `local daemon socket closed (${code})`))
    this.failPending(new DaemonClientError("daemon_disconnected", "local daemon socket closed"))
    // A pre-hello close is a failed connect (the caller owns the retry); there
    // is no established stream to tell the broker about.
    if (!hadHello) return
    for (const handler of [...this.closeHandlers]) {
      try {
        handler({ code, reason })
      } catch (e) {
        this.reportError(`local daemon: close handler threw: ${errorMessage(e)}`)
      }
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket === null) return
    try {
      socket.close()
    } catch {
      // already gone
    }
  }

  private rejectHelloWaiters(error: unknown): void {
    const waiters = this.helloWaiters
    this.helloWaiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private nextId(): string {
    this.idCounter += 1
    return `cloud${this.idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  private reportError(message: string): void {
    try {
      this.opts.onError?.(message)
    } catch {
      // the error sink must never throw
    }
  }
}
