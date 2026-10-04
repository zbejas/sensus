/**
 * MCP streamable-HTTP transport (docs/mcp.md): every JSON-RPC message is one
 * POST to the endpoint; the server answers `application/json` (single
 * message) or `text/event-stream` (SSE carrying the response, possibly with
 * progress notifications). A `Mcp-Session-Id` response header is captured at
 * initialize and echoed on every later request; close() DELETEs the session.
 *
 * The optional server->client GET stream (async server notifications) is not
 * opened in v1 — `tools/list_changed` is stdio-only until it is.
 */

import type { JsonRpcMessage } from "./jsonrpc.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.mcp")

export interface HttpSpawnOpts {
  name: string
  url: string
  headers: Record<string, string>
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export class HttpTransport {
  private handlers: { onMessage(msg: JsonRpcMessage): void } | null = null
  private sessionId: string | null = null
  private readonly aborts = new Set<AbortController>()
  private readonly opts: HttpSpawnOpts

  constructor(opts: HttpSpawnOpts) {
    this.opts = opts
  }

  /** Connectionless transport — record the handlers, nothing to open. */
  async start(handlers: { onMessage(msg: JsonRpcMessage): void; onDown(err: string): void }): Promise<void> {
    this.handlers = { onMessage: handlers.onMessage }
  }

  private headerBag(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.opts.headers,
    }
    if (this.sessionId !== null) h["mcp-session-id"] = this.sessionId
    return h
  }

  /**
   * POST one message. Resolves when the request was dispatched AND (for
   * id-bearing messages) the response was parsed — send() failures reject,
   * which rejects the correlated JsonRpcSession request.
   */
  async send(msg: JsonRpcMessage): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const ac = new AbortController()
    this.aborts.add(ac)
    try {
      const res = await fetchImpl(this.opts.url, {
        method: "POST",
        headers: this.headerBag(),
        body: JSON.stringify(msg),
        signal: ac.signal,
      })
      const sid = res.headers.get("mcp-session-id")
      if (sid) this.sessionId = sid

      if (!res.ok) {
        let snippet = ""
        try {
          snippet = (await res.text()).slice(0, 200)
        } catch (e) {
          // body unreadable
          log.debug("mcp http error body unreadable", { mcp: this.opts.name, err: e })
        }
        throw new Error(`mcp ${this.opts.name}: HTTP ${res.status}${snippet.length > 0 ? ` — ${snippet}` : ""}`)
      }
      if (res.status === 202) return // notification accepted, no body

      const ctype = (res.headers.get("content-type") ?? "").toLowerCase()
      if (ctype.includes("text/event-stream")) {
        await this.drainSse(res, msg, ac)
        return
      }
      const text = await res.text()
      if (text.trim().length === 0) return // empty 200 (notification echo)
      this.parseAndDeliver(text, msg.id !== undefined ? msg.id : null)
    } catch (e) {
      if (ac.signal.aborted) return // caller closed — not an error
      if (e instanceof Error) throw e
      throw new Error(String(e))
    } finally {
      this.aborts.delete(ac)
    }
  }

  /** Read an SSE response; resolve the correlated request via onMessage. */
  private async drainSse(res: Response, sent: JsonRpcMessage, ac: AbortController): Promise<void> {
    const body = res.body
    if (!body) return
    const awaitId = sent.id !== undefined ? sent.id : null
    let gotResponse = false
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let sep: number
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const event = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue
            const data = line.slice(5).trim()
            if (data.length === 0) continue
            if (this.parseAndDeliver(data, awaitId)) gotResponse = true
          }
        }
        // The response to THIS POST has been seen — stop reading. Servers
        // typically close the stream here anyway; notifications ride the
        // (v1-unopened) GET stream.
        if (gotResponse) break
      }
    } catch (e) {
      // stream died mid-read — whatever arrived was delivered
      log.warn("mcp http SSE stream died mid-read; response may be missing", { mcp: this.opts.name, err: e })
    } finally {
      try {
        await reader.cancel()
      } catch (e) {
        // already closed
        log.debug("mcp http SSE reader cancel failed", { mcp: this.opts.name, err: e })
      }
      ac.abort() // release the socket
    }
  }

  /**
   * Parse one SSE `data:` payload and hand it to the session. Returns true
   * when it is the response to `awaitId` (id-bearing, method-less).
   */
  private parseAndDeliver(text: string, awaitId: number | string | null): boolean {
    try {
      const msg = JSON.parse(text) as JsonRpcMessage
      if (msg === null || typeof msg !== "object") return false
      this.handlers?.onMessage(msg)
      return awaitId !== null && msg.method === undefined && msg.id === awaitId
    } catch (e) {
      log.debug("mcp http non-JSON SSE data ignored", { mcp: this.opts.name, err: e })
      return false // non-JSON event data — ignore
    }
  }

  /** DELETE the session (best effort) and abort in-flight reads. */
  async close(): Promise<void> {
    for (const ac of this.aborts) ac.abort()
    this.aborts.clear()
    if (this.sessionId === null) return
    const sid = this.sessionId
    this.sessionId = null
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 1500)
      await fetchImpl(this.opts.url, {
        method: "DELETE",
        headers: { ...this.opts.headers, "mcp-session-id": sid },
        signal: ac.signal,
      }).catch(() => undefined)
      clearTimeout(timer)
    } catch (e) {
      // best effort
      log.debug("mcp http session DELETE failed", { mcp: this.opts.name, err: e })
    }
  }
}

