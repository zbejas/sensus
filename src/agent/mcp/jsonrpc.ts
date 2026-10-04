/**
 * JSON-RPC 2.0 session over an MCP transport (docs/mcp.md): id correlation,
 * per-request timeouts and Esc-abort wiring. Transports (stdio.ts, http.ts)
 * only move serialized messages; this layer owns request/response pairing.
 *
 * Server->client REQUESTS are not supported in v1 (sampling, roots); incoming
 * non-response messages are surfaced via onNotification and otherwise ignored.
 */

export interface JsonRpcMessage {
  jsonrpc: "2.0"
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export function isResponse(msg: JsonRpcMessage): boolean {
  return msg.method === undefined && (msg.result !== undefined || msg.error !== undefined || msg.id !== undefined)
}

export class JsonRpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "JsonRpcError"
    this.code = code
    this.data = data
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  onAbort: (() => void) | null
}

export interface JsonRpcSessionOpts {
  /** Human-readable server name for error messages. */
  name: string
  /** Deliver one outbound message (throws propagate to the caller). */
  send(msg: JsonRpcMessage): void | Promise<void>
  /** Server notifications / unsupported requests (e.g. tools/list_changed). */
  onNotification?: (msg: JsonRpcMessage) => void
}

export class JsonRpcSession {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly opts: JsonRpcSessionOpts

  constructor(opts: JsonRpcSessionOpts) {
    this.opts = opts
  }

  /** Feed one inbound (parsed) message. Never throws. */
  handleIncoming(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
      const p = Number.isFinite(id) ? this.pending.get(id) : undefined
      if (!p) return // late/unknown response — drop
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (p.onAbort) p.onAbort = null
      if (msg.error) p.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data))
      else p.resolve(msg.result)
      return
    }
    if (msg.method !== undefined) this.opts.onNotification?.(msg)
  }

  /**
   * One request/response round trip. Rejects on timeout, abort, transport
   * send failure or a JSON-RPC error response.
   *
   * Cleanup paths (each must remove the pending entry AND stop its timer —
   * a stale timer firing on a reused id would reject the wrong promise):
   *   - timeout fires:        delete entry, reject
   *   - abort BEFORE send:    timer cleared, immediate reject (no listener)
   *   - abort DURING flight:  onAbort deletes the entry + clears the timer;
   *     the listener stays registered until then ({once:true}, and
   *     handleIncoming nulls the p.onAbort REFERENCE on success so a later
   *     signal fire cannot double-reject — the listener itself is a no-op)
   *   - send failure:         delete entry, clear timer, remove the abort
   *     listener, reject with the transport error
   */
  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId++
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp ${this.opts.name}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, Math.max(1, timeoutMs))

      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`mcp ${this.opts.name}: ${method} aborted`))
      }
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new Error(`mcp ${this.opts.name}: ${method} aborted`))
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }

      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject, timer, onAbort }
      this.pending.set(id, entry)

      Promise.resolve()
        .then(() => this.opts.send(msg))
        .catch((e) => {
          this.pending.delete(id)
          clearTimeout(timer)
          if (signal) signal.removeEventListener("abort", onAbort)
          entry.onAbort = null
          reject(e instanceof Error ? e : new Error(String(e)))
        })
    })
  }

  /** One notification (no id, no reply). Fire-and-forget. */
  notify(method: string, params?: unknown): void {
    void Promise.resolve()
      .then(() => this.opts.send({ jsonrpc: "2.0", method, params }))
      .catch(() => {
        // notification loss is never fatal
      })
  }

  /** Transport died: reject everything pending so callers stop waiting. */
  failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  /** Outstanding request count (tests / status). */
  get inFlight(): number {
    return this.pending.size
  }
}
