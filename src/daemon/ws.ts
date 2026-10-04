/**
 * The daemon's WebSocket channel (P3c-i terminal, P3c-ii chat; IF2;
 * docs/daemon-api.md "WebSocket channels").
 *
 * ONE endpoint — `GET /v1/ws` — authenticated with the boot bearer token
 * (`Authorization: Bearer <token>`, or `?token=<token>`). Text frames, JSON.
 *
 * Frozen envelope:
 *   client -> server: { "type":"req", "id":"<ulid>", "op":"<op>", ... }
 *   server -> client: { "type":"res", "id":"<same>", "ok":true|false,
 *                       "result"?:{}, "error"?:string }
 *   server -> client: { "type":"evt", "event":"<name>", ... }
 *
 * Ops: terminal.list|open|attach|detach|handover|input|resize|facts|kill;
 * chat.list|open|attach|detach|send|abort|compact|retry; approvals.answer;
 * sudo.answer.
 * Events: terminal.output|exit|attached|role|shells|status; chat.state|message|
 * delta|status|plan|error|done; approvals.request|resolved; sudo.request|
 * resolved; plus a connection-level `hello` (clientId/protocol) that makes
 * `terminal.handover` usable.
 *
 * Chat events are PER-CHAT: `chat.open`/`chat.attach` subscribe the requesting
 * client, `chat.detach` unsubscribes it (the chat keeps running). Bytes travel
 * base64. The endpoint never throws out of a frame handler: a malformed frame,
 * an unknown op, or a PTY failure becomes an error `res` (AGENTS.md rule 10).
 * Per-client outbound queues are bounded and drop oldest, so a slow client
 * cannot OOM the daemon.
 *
 * The transport is loopback TCP, NOT the Unix socket: Bun's `Bun.serve({
 * unix })` accepts a WebSocket upgrade server-side, but Bun's WebSocket CLIENT
 * has no `unix` option, so neither our client (P4) nor the tests can connect
 * over UDS. The UDS keeps serving REST only.
 */

import { errorMessage, isRecord } from "../core/util.ts"
import type { Logger } from "../core/log.ts"
import { componentLogger } from "./log.ts"
import { logStrictEnabled } from "./logStrict.ts"
import type { ChatEvent, ChatStatus } from "../engine/index.ts"
import { bearerFrom, safeEqual } from "./auth.ts"
import type { ChatRegistry } from "./chats.ts"
import type { ShellClient, ShellListEntry, ShellRegistry, ShellRole } from "./shells.ts"

/** Module-level child logger for the WS transport (component `daemon.ws`). */
const log: Logger = componentLogger("daemon.ws")

/** Protocol tag sent in `hello`. */
export const WS_PROTOCOL = "sensus-ws/1"

/** Default per-client outbound cap (drop oldest). Must exceed the replay cap
 * (1 MiB, base64 ≈ 1.37 MiB) so a full-screen replay is never trimmed. */
const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024

/** Bun's own per-connection backpressure limit; `drain` resumes the queue. */
const WS_BACKPRESSURE_LIMIT = 16 * 1024 * 1024

/** Default grace window after the last client leaves (D9); P3c-iii owns the
 * idle-exit policy that reads it. */
export const DEFAULT_DAEMON_GRACE_MS = 300_000

/** `SENSUS_DAEMON_GRACE_MS` (ms, ≥ 0) or the 5-minute default. */
export function resolveGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["SENSUS_DAEMON_GRACE_MS"]
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAEMON_GRACE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAEMON_GRACE_MS
}

/**
 * The grace-window timer primitive (D9). P3c-i only exposes it; P3c-iii decides
 * what expiry means (it must also weigh running agent turns). The timer is
 * `unref`'d so it never holds the process alive on its own.
 */
export class GraceWindow {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly ms: number,
    private readonly onExpire: () => void,
  ) {}

  arm(): void {
    this.cancel()
    if (this.ms <= 0) {
      queueMicrotask(() => this.fire())
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.fire()
    }, this.ms)
    this.timer.unref?.()
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  get armed(): boolean {
    return this.timer !== null
  }

  private fire(): void {
    try {
      this.onExpire()
    } catch (e) {
      // The policy must never crash the daemon.
      log.debug("grace-window callback threw", { err: e })
    }
  }
}

/** `ws.data` for an upgraded socket. */
export interface WsSocketData {
  client: WsClientHandle
}

/** The per-connection handle the server handlers drive (implemented by the
 * internal `WsClient`). Exposed so `ws.data` is strongly typed. */
export interface WsClientHandle extends ShellClient {
  bindSocket(ws: Bun.ServerWebSocket<WsSocketData>): void
  sendEvent(event: string, payload: Record<string, unknown>): void
  sendResult(id: string, ok: boolean, result?: Record<string, unknown>, error?: string): void
  handleMessage(raw: string): void
  flush(): void
  close(): void
  onSocketClosed(): void
}

export interface WsEndpointDeps {
  /** Boot bearer token; every upgrade must present it. */
  token: string
  registry: ShellRegistry
  /** The daemon's agent chats (P3c-ii). Absent = chat ops return
   * `chats_unavailable` (the terminal channel still works). */
  chats?: ChatRegistry
  /** Version reported in `hello`. */
  version?: string
  /** Per-client outbound cap (drop oldest); defaults to 4 MiB. */
  maxOutboundBytes?: number
  /** Fired when a client finishes its upgrade/handshake. */
  onClientConnected?: () => void
  /** Fired after a client's socket closes: `remaining` attached clients, plus
   * the chats that client watched which no remaining client watches (the D10
   * "resolving client left" case). */
  onClientGone?: (info: { remaining: number; orphanedChats: string[] }) => void
}

/** The public shape serve.ts binds. */
export interface WsEndpoint {
  /** Serve `GET /v1/ws`: a Response when not upgrading (401/426/400), else
   * `undefined` after a successful upgrade. */
  handle(req: Request, server: Bun.Server<WsSocketData>): Response | undefined
  websocket: Bun.WebSocketHandler<WsSocketData>
  /** Send an event to every authenticated client. */
  broadcast(event: string, payload: Record<string, unknown>): void
  /** Authenticated client count (tests/lifecycle). */
  clientCount(): number
  /** Close every client (shutdown/tests). */
  closeAll(): void
}

type OpOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string }

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** A positive integer (Elysia/browser JSON sends numbers). */
function asPositiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/** A non-negative absolute output cursor; undefined (full replay) otherwise. */
function asCursor(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined
}

const invalid = (): OpOutcome => ({ ok: false, error: "invalid_request" })

/**
 * Build the endpoint. `createWsEndpoint` wires the `terminal.shells`
 * broadcast to the registry, so serve.ts only binds the transport.
 */
export function createWsEndpoint(deps: WsEndpointDeps): WsEndpoint {
  const clients = new Map<string, WsClient>()
  const registry = deps.registry
  const maxOutbound = deps.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES
  let counter = 0

  registry.onShellsChanged((shells) => {
    broadcast("terminal.shells", { shells })
  })

  function broadcast(event: string, payload: Record<string, unknown>): void {
    for (const client of clients.values()) client.sendEvent(event, payload)
  }

  /** Last status seen per chat, so a streaming→settled flip emits `chat.done`. */
  const lastChatStatus = new Map<string, ChatStatus>()

  /** Send an event to every client watching `chatId` (auto-includes chatId). */
  function sendToChat(chatId: string, event: string, payload: Record<string, unknown> = {}): void {
    for (const client of clients.values()) {
      if (!client.watchesChat(chatId)) continue
      client.sendEvent(event, { chatId, ...payload })
    }
  }

  /**
   * Translate one engine `ChatEvent` into the frozen chat WS events and
   * deliver it to the clients watching that chat. A `reset` re-reads the full
   * state from the registry so `chat.state` is a true snapshot (clear/resume).
   */
  function broadcastChatEvent(chatId: string, event: ChatEvent): void {
    switch (event.kind) {
      case "message-added":
      case "message-updated":
        sendToChat(chatId, "chat.message", { message: event.message })
        break
      case "delta":
        sendToChat(chatId, "chat.delta", { messageId: event.messageId, kind: event.field, text: event.text })
        break
      case "status": {
        const prev = lastChatStatus.get(chatId)
        lastChatStatus.set(chatId, event.status)
        sendToChat(chatId, "chat.status", { status: event.status })
        if (prev === "streaming" && event.status !== "streaming") sendToChat(chatId, "chat.done", {})
        break
      }
      // A title change has no dedicated WS event: it rides on the `chat.meta`
      // the daemon emits for any non-delta event (the tab title reads from meta).
      case "title":
        break
      case "plan":
        sendToChat(chatId, "chat.plan", { message: event.message })
        break
      case "approval-request":
        sendToChat(chatId, "approvals.request", {
          callId: event.callId,
          tool: event.tool,
          args: event.args,
          command: event.command,
          destructive: event.destructive,
        })
        break
      case "approval-resolved":
        sendToChat(chatId, "approvals.resolved", { callId: event.callId, action: event.action })
        break
      case "sudo-request":
        sendToChat(chatId, "sudo.request", { requestId: event.requestId, command: event.command, prompt: event.prompt })
        break
      case "sudo-resolved":
        sendToChat(chatId, "sudo.resolved", { requestId: event.requestId, ok: event.ok })
        break
      case "error":
        sendToChat(chatId, "chat.error", { message: event.message })
        break
      case "reset": {
        const state = deps.chats?.attach(chatId)
        sendToChat(chatId, "chat.state", {
          state: state !== undefined && state.ok ? state.result.state : { messages: event.messages },
        })
        break
      }
    }
  }

  deps.chats?.subscribe((e) => {
    try {
      if (e.event === null) {
        // A meta-only change (P4c-ii): no engine event to translate.
        sendToChat(e.chatId, "chat.meta", { meta: e.meta })
        return
      }
      broadcastChatEvent(e.chatId, e.event)
      if (e.meta !== undefined) sendToChat(e.chatId, "chat.meta", { meta: e.meta })
    } catch (err) {
      // A fan-out failure must never break the engine's mutation (rule 10).
      log.warn("chat event fan-out failed", { err, chatId: e.chatId })
      // STRICT rethrow (#3): the enclosing `ChatRegistry.emit` wraps each
      // listener in try/catch, so a rethrow is absorbed there.
      if (logStrictEnabled()) throw err
    }
  })

  // Engine toasts (e.g. `/clear`, `/yolo`) are global — relay them so the
  // client surfaces them (the daemon has no UI).
  deps.chats?.onToast((t) => {
    try {
      broadcast("chat.toast", {
        message: t.message,
        ...(t.level !== undefined ? { level: t.level } : {}),
        ...(t.ttlMs !== undefined ? { ttlMs: t.ttlMs } : {}),
      })
    } catch (err) {
      // contained
      log.warn("chat toast fan-out failed", { err })
      // STRICT rethrow (#3): `ChatRegistry.notifyToast` wraps each toast
      // listener in try/catch, so a rethrow is absorbed there.
      if (logStrictEnabled()) throw err
    }
  })

  class WsClient implements WsClientHandle {
    readonly id: string
    /** Chat ids this client currently observes (chat.attach/chat.open/detach). */
    private readonly chatIds = new Set<string>()
    private ws: Bun.ServerWebSocket<WsSocketData> | null = null
    private queue: string[] = []
    private queueBytes = 0
    private flushing = false
    private closed = false
    private gone = false

    constructor(id: string) {
      this.id = id
    }

    /** Called from the server's `open` handler. */
    bindSocket(ws: Bun.ServerWebSocket<WsSocketData>): void {
      this.ws = ws
      clients.set(this.id, this)
      this.sendEvent("hello", { clientId: this.id, protocol: WS_PROTOCOL, version: deps.version ?? null })
      deps.onClientConnected?.()
    }

    sendEvent(event: string, payload: Record<string, unknown>): void {
      this.sendFrame(JSON.stringify({ type: "evt", event, ...payload }))
    }

    sendResult(id: string, ok: boolean, result?: Record<string, unknown>, error?: string): void {
      const frame = ok
        ? { type: "res", id, ok: true, result: result ?? {} }
        : { type: "res", id, ok: false, error: error ?? "error" }
      this.sendFrame(JSON.stringify(frame))
    }

    /** `ShellClient`: terminal.output/exit/role fan-in. */
    deliver(event: string, payload: Record<string, unknown>): void {
      this.sendEvent(event, payload)
    }

    /** Does this client observe `chatId`? (chat events are per-chat.) */
    watchesChat(chatId: string): boolean {
      return this.chatIds.has(chatId)
    }

    watchChat(chatId: string): void {
      this.chatIds.add(chatId)
    }

    unwatchChat(chatId: string): void {
      this.chatIds.delete(chatId)
    }

    handleMessage(raw: string): void {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.sendResult("", false, undefined, "invalid_json")
        return
      }
      if (!isRecord(parsed) || parsed["type"] !== "req") {
        const id = isRecord(parsed) && typeof parsed["id"] === "string" ? parsed["id"] : ""
        this.sendResult(id, false, undefined, "invalid_request")
        return
      }
      const id = typeof parsed["id"] === "string" ? parsed["id"] : ""
      const op = typeof parsed["op"] === "string" ? parsed["op"] : ""
      try {
        void dispatch(op, parsed, this)
          .then((out) => this.sendResult(id, out.ok, out.ok ? out.result : undefined, out.ok ? undefined : out.error))
          .catch((e: unknown) => {
            try {
              this.sendResult(id, false, undefined, errorMessage(e))
            } catch {
              // The error frame itself failed to send (SENSUS_LOG_STRICT=1 can
              // rethrow from sendFrame): absorb it so the rejection cannot
              // escape this detached chain.
            }
          })
      } catch (e) {
        this.sendResult(id, false, undefined, errorMessage(e))
      }
    }

    /** Resume the bounded queue once the socket can take more (Bun `drain`). */
    flush(): void {
      if (this.flushing || this.gone) return
      this.flushing = true
      try {
        while (this.queue.length > 0) {
          const ws = this.ws
          if (ws === null) return
          const frame = this.queue[0] ?? ""
          let status: number
          try {
            status = ws.send(frame)
          } catch (err) {
            this.gone = true
            log.warn("ws send failed", { err, clientId: this.id })
            // STRICT rethrow (#1): `flush` is invoked from the `drain` handler
            // (wrapped in try/catch) and from `sendFrame`, whose callers
            // (`message`/`open` handlers, the registry fan-out loops) are each
            // guarded — so a rethrow is absorbed.
            if (logStrictEnabled()) throw err
            return
          }
          // -1 = backpressure: keep the frame queued and wait for `drain`.
          if (status === -1) return
          this.queue.shift()
          this.queueBytes -= frame.length
        }
      } finally {
        this.flushing = false
      }
    }

    /** Server-initiated close (shutdown/tests). */
    close(): void {
      this.closed = true
      this.queue = []
      this.queueBytes = 0
      try {
        this.ws?.close(1000, "server shutting down")
      } catch {
        // already gone
      }
    }

    /** Server `close`: deregister and detach from every shell. */
    onSocketClosed(): void {
      if (this.gone) return
      this.gone = true
      this.ws = null
      this.queue = []
      this.queueBytes = 0
      const watched = [...this.chatIds]
      this.chatIds.clear()
      clients.delete(this.id)
      try {
        registry.detachClient(this.id)
        registry.refreshShells()
      } catch (err) {
        // contained
        log.warn("detach/refresh on socket close failed", { err, clientId: this.id })
        // STRICT rethrow (#2): the `close` websocket handler wraps
        // `onSocketClosed` in try/catch, so a rethrow is absorbed there.
        if (logStrictEnabled()) throw err
      }
      // Chats this client watched that no present client watches (the D10
      // "resolving client left while others remain" case).
      const orphaned = watched.filter((chatId) => !this.watchedByAnyoneElse(chatId))
      try {
        deps.onClientGone?.({ remaining: clients.size, orphanedChats: orphaned })
      } catch (err) {
        // contained
        log.warn("onClientGone callback failed", { err, clientId: this.id })
        // STRICT rethrow (#2): absorbed by the `close` websocket handler.
        if (logStrictEnabled()) throw err
      }
    }

    /** Whether any client other than this one watches `chatId`. */
    private watchedByAnyoneElse(chatId: string): boolean {
      for (const client of clients.values()) {
        if (client.watchesChat(chatId)) return true
      }
      return false
    }

    private sendFrame(frame: string): void {
      if (this.closed || this.gone || this.ws === null) return
      this.queue.push(frame)
      this.queueBytes += frame.length
      // Bound the queue: drop oldest beyond the cap (a slow client cannot OOM
      // the daemon). The most recent frame always survives.
      while (this.queueBytes > maxOutbound && this.queue.length > 1) {
        const dropped = this.queue.shift()
        this.queueBytes -= dropped?.length ?? 0
      }
      this.flush()
    }
  }

  async function dispatch(op: string, params: Record<string, unknown>, client: WsClient): Promise<OpOutcome> {
    switch (op) {
      case "terminal.list": {
        const shells: ShellListEntry[] = registry.list()
        return { ok: true, result: { shells } }
      }

      case "terminal.open": {
        const cols = asPositiveInt(params["cols"])
        const rows = asPositiveInt(params["rows"])
        if (cols === null || rows === null) return invalid()
        const opened = registry.open({
          cols,
          rows,
          cwd: optionalString(params["cwd"]),
          shell: optionalString(params["shell"]),
        })
        return opened.ok ? { ok: true, result: { shellId: opened.result.shellId } } : opened
      }

      case "terminal.attach": {
        const shellId = asString(params["shellId"])
        if (shellId === null) return invalid()
        const role: ShellRole = params["role"] === "observer" ? "observer" : "controller"
        const attached = registry.attach(shellId, client, role, asCursor(params["cursor"]))
        if (!attached.ok) return attached
        // A controller attaching at its own size resizes the PTY to match.
        const cols = asPositiveInt(params["cols"])
        const rows = asPositiveInt(params["rows"])
        if (cols !== null && rows !== null && attached.result.role === "controller") {
          registry.resize(shellId, client, cols, rows)
          attached.result.cols = cols
          attached.result.rows = rows
        }
        // Refresh the status after any attach-time resize so the payload's
        // size matches the PTY (P4a gap 1).
        attached.result.status = registry.statusOf(shellId) ?? attached.result.status
        // Order matters (IF2): `terminal.attached` (with the replay) must reach
        // the client before any live output or the shells/role churn.
        client.sendEvent("terminal.attached", {
          shellId: attached.result.shellId,
          role: attached.result.role,
          replay: attached.result.replay,
          replayFrom: attached.result.replayFrom,
          cursor: attached.result.cursor,
          truncated: attached.result.truncated,
          resetAlt: attached.result.resetAlt,
          cols: attached.result.cols,
          rows: attached.result.rows,
          status: attached.result.status,
        })
        // Then the status event that seeds the client's polled state (P4a gap 1).
        registry.announceStatus(shellId)
        registry.announceRole(shellId)
        registry.refreshShells()
        return { ok: true, result: { shellId, role: attached.result.role } }
      }

      case "terminal.detach": {
        const shellId = asString(params["shellId"])
        if (shellId === null) return invalid()
        const detached = registry.detach(shellId, client)
        if (!detached.ok) return detached
        registry.refreshShells()
        return { ok: true, result: { shellId } }
      }

      case "terminal.handover": {
        const shellId = asString(params["shellId"])
        const to = asString(params["to"])
        if (shellId === null || to === null) return invalid()
        const moved = registry.handover(shellId, client, to)
        if (!moved.ok) return moved
        registry.announceRole(shellId)
        return { ok: true, result: { shellId, clientId: to } }
      }

      case "terminal.input": {
        const shellId = asString(params["shellId"])
        const data = asString(params["data"])
        if (shellId === null || data === null) return invalid()
        let bytes: Uint8Array
        try {
          bytes = Buffer.from(data, "base64")
        } catch {
          return invalid()
        }
        const wrote = registry.input(shellId, client, bytes)
        return wrote.ok ? { ok: true, result: { shellId } } : wrote
      }

      case "terminal.resize": {
        const shellId = asString(params["shellId"])
        const cols = asPositiveInt(params["cols"])
        const rows = asPositiveInt(params["rows"])
        if (shellId === null || cols === null || rows === null) return invalid()
        const resized = registry.resize(shellId, client, cols, rows)
        if (resized.ok) registry.announceStatus(shellId)
        return resized.ok ? { ok: true, result: { shellId } } : resized
      }

      case "terminal.facts": {
        const shellId = asString(params["shellId"])
        const lines = params["lines"]
        const cursor = params["cursor"]
        if (shellId === null || !Array.isArray(lines) || !lines.every((l) => typeof l === "string")) return invalid()
        if (!isRecord(cursor)) return invalid()
        const x = cursor["x"]
        const y = cursor["y"]
        const visible = cursor["visible"]
        if (typeof x !== "number" || typeof y !== "number" || typeof visible !== "boolean") return invalid()
        const stored = registry.facts(shellId, client, {
          lines: lines as string[],
          cursor: { x, y, visible },
        })
        return stored.ok ? { ok: true, result: { shellId } } : stored
      }

      case "terminal.kill": {
        const shellId = asString(params["shellId"])
        if (shellId === null) return invalid()
        const killed = registry.kill(shellId)
        return killed.ok ? { ok: true, result: { shellId } } : killed
      }

      // -- chat (P3c-ii; docs/daemon-api.md "Chat, approvals, sudo") -----------

      case "chat.list": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        return { ok: true, result: { chats: chats.list() } }
      }

      case "chat.open": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const opened = chats.open({
          shellId: optionalString(params["shellId"]),
          agent: optionalString(params["agent"]),
          model: optionalString(params["model"]),
          resume: optionalString(params["resume"]),
        })
        if (!opened.ok) return opened
        client.watchChat(opened.result.chatId)
        sendToChat(opened.result.chatId, "chat.state", { state: opened.result.state })
        return { ok: true, result: { chatId: opened.result.chatId, state: opened.result.state } }
      }

      case "chat.attach": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        if (chatId === null) return invalid()
        const attached = chats.attach(chatId)
        if (!attached.ok) return attached
        client.watchChat(chatId)
        sendToChat(chatId, "chat.state", { state: attached.result.state })
        return { ok: true, result: { chatId, state: attached.result.state } }
      }

      case "chat.detach": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        if (chatId === null) return invalid()
        // The chat survives (D4); only this client stops observing it.
        const known = chats.attach(chatId)
        if (!known.ok) return known
        client.unwatchChat(chatId)
        return { ok: true, result: { chatId } }
      }

      case "chat.send": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const text = typeof params["text"] === "string" ? params["text"] : null
        if (chatId === null || text === null) return invalid()
        const rawImages = params["images"]
        const images: Array<{ name: string; mediaType: string; data: string }> = []
        if (rawImages !== undefined) {
          if (!Array.isArray(rawImages)) return invalid()
          for (const raw of rawImages) {
            if (!isRecord(raw)) return invalid()
            const name = asString(raw["name"])
            const mediaType = asString(raw["mediaType"])
            const data = typeof raw["data"] === "string" ? raw["data"] : null
            if (name === null || mediaType === null || data === null) return invalid()
            images.push({ name, mediaType, data })
          }
        }
        const sent = chats.send(chatId, text, images)
        return sent.ok ? { ok: true, result: sent.result } : sent
      }

      case "chat.abort":
      case "chat.compact":
      case "chat.retry": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        if (chatId === null) return invalid()
        const res = op === "chat.abort" ? chats.abort(chatId) : op === "chat.compact" ? chats.compact(chatId) : chats.retry(chatId)
        return res.ok ? { ok: true, result: res.result } : res
      }

      // -- remote chat controls (P4c-iii; thin engine wrappers) ----------------

      case "chat.setModel": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const model = asString(params["model"])
        if (chatId === null || model === null) return invalid()
        const res = chats.setModel(chatId, model)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.setAgent": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const agent = asString(params["agent"])
        if (chatId === null || agent === null) return invalid()
        const res = chats.setAgent(chatId, agent)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.setEffort": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const mode = asString(params["mode"])
        if (chatId === null || mode === null) return invalid()
        const res = chats.setEffort(chatId, mode)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.cycleEffort": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        if (chatId === null) return invalid()
        const res = chats.cycleEffort(chatId)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.revert": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const messageId = asPositiveInt(params["messageId"])
        if (chatId === null || messageId === null) return invalid()
        const res = chats.revert(chatId, messageId)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.setApproval": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const mode = params["mode"]
        if (chatId === null || (mode !== "confirm" && mode !== "full-auto")) return invalid()
        const res = chats.setApproval(chatId, mode)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.setMcp": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const enabled = params["enabled"]
        if (chatId === null || typeof enabled !== "boolean") return invalid()
        const res = chats.setMcpEnabled(chatId, enabled)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.trustAdd": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const tool = asString(params["tool"])
        const prefix = asString(params["prefix"])
        if (chatId === null || tool === null || prefix === null) return invalid()
        const res = chats.trustAdd(chatId, tool, prefix)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.trustRevoke": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const tool = asString(params["tool"])
        const prefix = asString(params["prefix"])
        if (chatId === null || tool === null || prefix === null) return invalid()
        const res = chats.trustRevoke(chatId, tool, prefix)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.trustRevokeAll": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        if (chatId === null) return invalid()
        const res = chats.trustRevokeAll(chatId)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.planAnswer": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const messageId = asPositiveInt(params["messageId"])
        const rawDecisions = params["decisions"]
        if (chatId === null || messageId === null || !Array.isArray(rawDecisions)) return invalid()
        const decisions: Array<{ callId: string; accept: boolean }> = []
        for (const raw of rawDecisions) {
          if (!isRecord(raw)) return invalid()
          const callId = asString(raw["callId"])
          const accept = raw["accept"]
          if (callId === null || typeof accept !== "boolean") return invalid()
          decisions.push({ callId, accept })
        }
        const res = chats.answerPlan(chatId, messageId, decisions)
        return res.ok ? { ok: true, result: res.result } : res
      }


      case "approvals.answer": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const callId = asString(params["callId"])
        const action = params["action"]
        if (chatId === null || callId === null || (action !== "accept" && action !== "reject")) return invalid()
        const res = chats.answerApproval({
          chatId,
          callId,
          action,
          addPrefix: optionalString(params["addPrefix"]),
          addToSession: params["addToSession"] === true,
          trust: params["trust"] === true,
        })
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "chat.answerAsk": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const callId = asString(params["callId"])
        const answer = typeof params["answer"] === "string" ? params["answer"] : null
        if (chatId === null || callId === null || answer === null) return invalid()
        const res = chats.answerAsk(chatId, callId, answer)
        return res.ok ? { ok: true, result: res.result } : res
      }

      case "sudo.answer": {
        const chats = deps.chats
        if (chats === undefined) return { ok: false, error: "chats_unavailable" }
        const chatId = asString(params["chatId"])
        const requestId = asString(params["requestId"])
        const password = typeof params["password"] === "string" ? params["password"] : null
        if (chatId === null || requestId === null || password === null) return invalid()
        const res = chats.answerSudo(chatId, requestId, password, params["remember"] === true)
        return res.ok ? { ok: true, result: res.result } : res
      }

      default:
        return { ok: false, error: "unknown_op" }
    }
  }

  const websocket: Bun.WebSocketHandler<WsSocketData> = {
    data: {} as WsSocketData,
    open(ws) {
      try {
        ws.data.client.bindSocket(ws)
      } catch (err) {
        log.warn("ws bind failed on open", { err })
        try {
          ws.close()
        } catch (e) {
          // already gone
          log.warn("ws close after a failed bind failed", { err: e })
        }
      }
    },
    message(ws, message) {
      try {
        if (typeof message !== "string") return
        ws.data.client.handleMessage(message)
      } catch (err) {
        // A malformed frame must never take down the daemon (rule 10): log and
        // STILL swallow — this handler deliberately does not rethrow.
        log.error("ws message handler threw", { err })
      }
    },
    drain(ws) {
      try {
        ws.data.client.flush()
      } catch (err) {
        // contained
        log.warn("ws drain flush failed", { err })
      }
    },
    close(ws) {
      try {
        ws.data.client.onSocketClosed()
      } catch (err) {
        // contained
        log.warn("ws close cleanup failed", { err })
      }
    },
    maxPayloadLength: 16 * 1024 * 1024,
    backpressureLimit: WS_BACKPRESSURE_LIMIT,
    closeOnBackpressureLimit: false,
  }

  function handle(req: Request, server: Bun.Server<WsSocketData>): Response | undefined {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return json({ error: "invalid_request" }, 400)
    }
    const provided = bearerFrom(req.headers.get("authorization")) ?? url.searchParams.get("token")
    if (provided === null || !safeEqual(provided, deps.token)) {
      return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" })
    }
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket_upgrade" }, 426)
    }
    counter += 1
    const client = new WsClient(`c${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    let upgraded = false
    try {
      upgraded = server.upgrade(req, { data: { client } })
    } catch {
      return json({ error: "upgrade_failed" }, 400)
    }
    if (!upgraded) return json({ error: "upgrade_failed" }, 400)
    return undefined
  }

  return {
    handle,
    websocket,
    broadcast,
    clientCount: () => clients.size,
    closeAll: () => {
      for (const client of [...clients.values()]) client.close()
    },
  }
}
