/**
 * The typed cloud broker (docs/auth.md "Broker"; protocol "Scopes"/"Streams").
 *
 * This is the security boundary. The cloud sends a small typed RPC/stream
 * surface; every operation is checked against the host-local `policy.json`
 * before a local daemon WS/REST call is made (the op → scope table lives in
 * `ops.ts`; that table is the allowlist). There is deliberately no generic
 * HTTP or WebSocket proxy, no config/secrets/audit/models surface, no sudo, no
 * trust mutation, no `terminal.kill`, and no update path.
 *
 * Persisted transcripts and agent memory are exposed read-mostly and BOUNDED:
 * transcript reads never return the absolute file path, messages are clipped,
 * exports are byte-capped, and memory writes go through the same `MemoryStore`
 * (caps + safety scans) the TUI uses. Transcript deletion is the one destructive
 * op: it needs `control` AND the host-local `deleteTranscripts` opt-in.
 *
 * One cloud stream maps to ONE local Sensus WS (`LocalDaemonClient`), so each
 * browser terminal gets its own daemon cursor/role and the daemon's own
 * controller/observer semantics apply. Terminal facts are forwarded only from a
 * controller stream; the cloud can never poison the agent's terminal context
 * from an observer.
 */

import { Buffer } from "node:buffer"
import { errorMessage, isRecord } from "../../core/util.ts"
import type { AuthPolicy } from "../../auth/policy.ts"
import { isCwdAllowed } from "../../auth/policy.ts"
import { hasScope } from "../../auth/scopes.ts"
import type { DiscoveryResult } from "./discovery.ts"
import { LocalDaemonClient, DaemonClientError, type DaemonFrame, type LocalDaemonLike } from "./daemonClient.ts"
import type { DaemonFacts, Scope, StreamKind } from "./protocol.ts"
import { CLOUD_APPROVAL_HARD_CAP_MS, CLOUD_MAX_CHAT_RUN_STREAMS, CLOUD_MAX_STREAMS, CLOUD_MAX_TERMINAL_STREAMS, RUN_DEFAULT_TIMEOUT_SEC, RUN_MAX_TIMEOUT_SEC } from "./protocol.ts"
import type { RunRecord } from "./cleanup.ts"
import type { ConnectorToCloud } from "./protocol.ts"
import { tunnelOpSpec } from "./ops.ts"
import {
  exportSession,
  isSafeSessionSegment,
  listSessions,
  readSession,
  resolveSessionPath,
  type SessionExportFormat,
} from "../sessions.ts"
import { MEMORY_TARGETS, emitMemoryWrite, isMemoryAction, isMemoryTarget } from "../memoryContract.ts"
import type { EventSink, MemoryResult, MemoryStore, MemoryTarget } from "../../engine/index.ts"

/** Ops the cloud may never invoke, whatever its scopes (protocol "Scopes"). */
export const BLOCKED_OPS: ReadonlySet<string> = new Set([
  "terminal.kill",
  "chat.setApproval",
  "chat.trustAdd",
  "chat.trustRevoke",
  "chat.trustRevokeAll",
  "chat.revert",
  "chat.setMcp",
  "sudo.answer",
])

/** Default/max cloud page for `transcript.list` and `transcript.read`. */
export const TRANSCRIPT_LIMIT_DEFAULT = 20
export const TRANSCRIPT_LIMIT_MAX = 50
/** Per-message content cap (characters) on `transcript.read`. */
export const TRANSCRIPT_MESSAGE_MAX_CHARS = 16_000
/** Hard byte cap on `transcript.export` content (the original size is reported). */
export const TRANSCRIPT_EXPORT_MAX_BYTES = 2 * 1024 * 1024
/** Context Inspector history rows / preview length returned to the cloud. */
export const TRANSCRIPT_CONTEXT_MAX_HISTORY = 120
export const TRANSCRIPT_CONTEXT_PREVIEW_CHARS = 160
/** `memory.read` content byte cap + entry cap. */
export const MEMORY_READ_MAX_BYTES = 64 * 1024
export const MEMORY_READ_MAX_ENTRIES = 200
/** `memory.write` content byte cap (rejected, never truncated). */
export const MEMORY_WRITE_MAX_BYTES = 64 * 1024

/** Chat/run stream ops the cloud may send (per chatId, see `streamSend`). */
const CHAT_STREAM_OPS: ReadonlySet<string> = new Set([
  "chat.send",
  "chat.abort",
  "chat.compact",
  "chat.retry",
  "chat.answerAsk",
  "chat.planAnswer",
  "approvals.answer",
])

const TERMINAL_STREAM_OPS: ReadonlySet<string> = new Set([
  "terminal.input",
  "terminal.resize",
  "terminal.facts",
  "terminal.detach",
  "terminal.handover",
])

export type BrokerEmit = (frame: ConnectorToCloud) => void

export interface BrokerOptions {
  policy: AuthPolicy
  discover: () => Promise<DiscoveryResult>
  /** Sessions root (`<dataDir>/sessions`); transcript ops read here directly. */
  dataDir: string
  /** Test seam: a fake local daemon client. */
  clientFactory?: () => LocalDaemonLike
  /** Run registry hooks (0600 `runs.json`). */
  recordRun?: (record: RunRecord) => { ok: boolean; error?: string }
  forgetRun?: (streamId: string) => { ok: boolean; error?: string }
  /** Local-policy daemon start (`startDaemon: true`). */
  startDaemon?: () => Promise<boolean>
  /** Saved-session Context Inspector snapshot; absent → `unsupported`. */
  contextForSession?: (path: string) => { title: string; breakdown: unknown } | null
  /** True when a live chat is still appending to this transcript path. */
  isSessionOpen?: (path: string) => boolean
  /** Delete a transcript + sidecar + FTS rows; absent → `unsupported`. */
  deleteSession?: (path: string) => { ok: boolean; message?: string }
  /** Per-call memory store (same store the REST route uses); absent → `unsupported`. */
  memoryStore?: () => MemoryStore
  /** Audit sink for a committed `memory.write`. */
  events?: EventSink
  now?: () => number
  maxStreams?: number
  approvalHardCapMs?: number
  onLog?: (level: "info" | "warn" | "error", message: string) => void
}

export interface RpcOutcome {
  ok: boolean
  result?: Record<string, unknown>
  code?: string
  message?: string
}

export interface StreamOpenResult {
  ok: boolean
  code?: string
  message?: string
}

type Role = "observer" | "controller"

interface StreamRecord {
  id: string
  kind: StreamKind
  client: LocalDaemonLike
  emit: BrokerEmit
  closed: boolean
  opened: boolean
  shellId: string | null
  chatId: string | null
  role: Role | null
  chatStatus: string | null
  /** Frames emitted by the daemon before `stream.opened`; flushed in order. */
  pending: Array<{ raw: string; frame: DaemonFrame }>
  offFrame: () => void
  offClose: () => void
  runTimer: ReturnType<typeof setTimeout> | null
  promptTimer: ReturnType<typeof setTimeout> | null
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/** A cloud page size: absent → default; non-finite/non-number → null (invalid). */
function parseLimit(raw: unknown, fallback = TRANSCRIPT_LIMIT_DEFAULT): number | null {
  if (raw === undefined) return fallback
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return Math.min(TRANSCRIPT_LIMIT_MAX, Math.max(1, Math.floor(raw)))
}

/** A cloud offset: absent → 0; non-finite/non-number → null (invalid); negatives clamp. */
function parseOffset(raw: unknown): number | null {
  if (raw === undefined) return 0
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  return Math.max(0, Math.floor(raw))
}

/** Split `"<instance>/<base>"` on the FIRST `/`; both segments must be safe. */
function splitTranscriptId(raw: unknown): { instance: string; base: string } | null {
  if (typeof raw !== "string") return null
  const slash = raw.indexOf("/")
  if (slash <= 0) return null
  const instance = raw.slice(0, slash)
  const base = raw.slice(slash + 1)
  if (!isSafeSessionSegment(instance) || !isSafeSessionSegment(base)) return null
  return { instance, base }
}

/** One cloud-facing transcript row (never the absolute `path`). */
export interface TranscriptSummary {
  id: string
  title: string
  tab: number | null
  mtime: number
  size: number
  tags: string[]
  messages: number
  lastTs: number | null
}

/** One cloud-facing message (never `thinking`/`images`/`usage`). */
export interface TranscriptMessage {
  role: "user" | "assistant"
  content: string
  ts?: number
  model?: string
  aborted?: boolean
  truncated?: boolean
}

/** Clip a UTF-8 string to at most `maxBytes`, never splitting a code point. */
function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= maxBytes) return { text, truncated: false, bytes }
  let clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  // A cut mid-code-point decodes to U+FFFD; drop that artifact only.
  if (clipped.endsWith("\uFFFD")) clipped = clipped.slice(0, -1)
  return { text: clipped, truncated: true, bytes }
}

/** Bound a ContextBreakdown's history rows/previews for cloud transport. */
function boundBreakdown(breakdown: unknown): unknown {
  if (!isRecord(breakdown)) return breakdown
  const history = breakdown["history"]
  if (!Array.isArray(history)) return breakdown
  const bounded = history.slice(0, TRANSCRIPT_CONTEXT_MAX_HISTORY).map((entry) => {
    if (!isRecord(entry)) return entry
    const preview = entry["preview"]
    if (typeof preview !== "string" || preview.length <= TRANSCRIPT_CONTEXT_PREVIEW_CHARS) return entry
    return { ...entry, preview: preview.slice(0, TRANSCRIPT_CONTEXT_PREVIEW_CHARS) }
  })
  return { ...breakdown, history: bounded }
}

/** Project one persisted chat record into the cloud message shape. */
function toTranscriptMessage(record: {
  role: "user" | "assistant"
  content: string
  ts?: number
  model?: string
  aborted?: boolean
}): TranscriptMessage {
  const clipped = record.content.length > TRANSCRIPT_MESSAGE_MAX_CHARS
  return {
    role: record.role,
    content: clipped ? record.content.slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS) : record.content,
    ...(record.ts !== undefined ? { ts: record.ts } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.aborted === true ? { aborted: true } : {}),
    ...(clipped ? { truncated: true } : {}),
  }
}

function parseDaemonRequest(raw: string): { ok: true; frame: Record<string, unknown>; id: string; op: string } | { ok: false; code: string; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: "invalid_json", message: "stream frame is not valid JSON" }
  }
  if (!isRecord(parsed) || parsed["type"] !== "req") {
    return { ok: false, code: "invalid_request", message: "stream frames must be Sensus `req` frames" }
  }
  const id = typeof parsed["id"] === "string" ? parsed["id"] : ""
  const op = typeof parsed["op"] === "string" ? parsed["op"] : ""
  if (id.length === 0 || op.length === 0) {
    return { ok: false, code: "invalid_request", message: "request frame needs id + op" }
  }
  return { ok: true, frame: parsed, id, op }
}

/** A synthetic `res` frame so the browser sees a typed stream op failure. */
export function daemonErrorFrame(id: string, code: string, message = code): string {
  return JSON.stringify({ type: "res", id, ok: false, error: code, message })
}

export class RelayBroker {
  private readonly streams = new Map<string, StreamRecord>()
  private control: LocalDaemonLike | null = null
  private controlConnecting: Promise<LocalDaemonLike> | null = null
  private readonly now: () => number
  private maxStreams: number
  private readonly approvalHardCapMs: number

  constructor(private readonly opts: BrokerOptions) {
    this.now = opts.now ?? Date.now
    this.maxStreams = Math.min(CLOUD_MAX_STREAMS, Math.max(1, opts.maxStreams ?? opts.policy.maxStreams))
    this.approvalHardCapMs = Math.max(1, opts.approvalHardCapMs ?? CLOUD_APPROVAL_HARD_CAP_MS)
  }

  /** Lower the stream budget to the cloud's `hello.ok` maxStreams (never widen). */
  setMaxStreams(value: number): void {
    if (!Number.isFinite(value) || value <= 0) return
    this.maxStreams = Math.min(this.maxStreams, Math.floor(value))
  }

  /** Fresh daemon facts for `hello`/`daemon.status`. Never throws. */
  async daemonFacts(): Promise<DaemonFacts> {
    const discovery = await this.opts.discover()
    return factsFromDiscovery(discovery)
  }

  /**
   * One typed RPC. The op → scope table (`ops.ts`) is consulted first, so an
   * op without a declared scope can never be served; blocked ops stay blocked
   * regardless of scopes. The switch below only handles the declared surface.
   */
  async rpc(op: string, params: unknown): Promise<RpcOutcome> {
    if (BLOCKED_OPS.has(op)) return { ok: false, code: "blocked_op", message: `${op} is never allowed for cloud traffic` }
    const spec = tunnelOpSpec(op)
    if (spec === null) return { ok: false, code: "unknown_op", message: op }
    if (!isRecord(params) && params !== undefined) return invalidRequest("params must be an object")
    if (!hasScope(this.opts.policy.scopes, spec.scope)) return scopeError(spec.scope)
    if (spec.policyFlag === "deleteTranscripts" && this.opts.policy.deleteTranscripts !== true) {
      return {
        ok: false,
        code: "delete_disabled",
        message:
          "transcript deletion is disabled in the local cloud policy; it permanently deletes transcripts with no trash (sensus cloud scopes --delete-transcripts on)",
      }
    }
    const p = isRecord(params) ? params : {}

    switch (op) {
      case "daemon.info": {
        const discovery = await this.opts.discover()
        const facts = factsFromDiscovery(discovery)
        return {
          ok: true,
          result: {
            ...facts,
            platform: discovery.ok ? (discovery.discovery.info.platform ?? process.platform) : process.platform,
          },
        }
      }
      case "daemon.health": {
        const discovery = await this.opts.discover()
        if (!discovery.ok) return { ok: true, result: { ok: false, version: null } }
        return { ok: true, result: { ok: true, version: discovery.discovery.info.version ?? null } }
      }
      case "daemon.start": {
        if (!this.opts.policy.startDaemon) {
          return { ok: false, code: "start_disabled", message: "daemon.start is disabled in the local cloud policy" }
        }
        if (this.opts.startDaemon === undefined) {
          return { ok: false, code: "start_unavailable", message: "this relay cannot start the daemon" }
        }
        const started = await this.opts.startDaemon()
        if (!started) return { ok: false, code: "start_failed", message: "the daemon did not become healthy" }
        const facts = await this.daemonFacts()
        return { ok: true, result: { state: facts.state } }
      }
      case "terminal.list": {
        return await this.controlRequest("terminal.list", {})
      }
      case "terminal.open": {
        const cols = positiveInt(p["cols"])
        const rows = positiveInt(p["rows"])
        if (cols === null || rows === null) return invalidRequest("cols and rows are required")
        const cwd = optionalString(p["cwd"])
        if (!isCwdAllowed(this.opts.policy, cwd)) {
          return { ok: false, code: "cwd_not_allowed", message: "cwd is outside the local policy's allowedCwd" }
        }
        // `shell` is never cloud-selectable: the daemon's configured default
        // shell is the allowlisted one.
        return await this.controlRequest("terminal.open", { cols, rows, ...(cwd !== undefined ? { cwd } : {}) })
      }
      case "chat.list": {
        return await this.controlRequest("chat.list", {})
      }
      case "chat.open": {
        if (p["resume"] !== undefined) {
          return { ok: false, code: "blocked_op", message: "chat.open may not resume a raw transcript path" }
        }
        const shellId = optionalString(p["shellId"])
        if (shellId !== undefined) {
          const shells = await this.controlRequest("terminal.list", {})
          if (!shells.ok) return shells
          const list = Array.isArray(shells.result?.["shells"]) ? (shells.result["shells"] as unknown[]) : []
          const found = list.some((entry) => isRecord(entry) && entry["shellId"] === shellId)
          if (!found) return { ok: false, code: "shell_not_found", message: "the bound shell does not exist" }
        }
        const agent = optionalString(p["agent"])
        const model = optionalString(p["model"])
        return await this.controlRequest("chat.open", {
          ...(shellId !== undefined ? { shellId } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(model !== undefined ? { model } : {}),
        })
      }
      case "transcript.list": {
        const limit = parseLimit(p["limit"])
        const offset = parseOffset(p["offset"])
        if (limit === null || offset === null) return invalidRequest("limit and offset must be numbers")
        const page = listSessions(this.opts.dataDir, { limit, offset })
        const sessions: TranscriptSummary[] = page.sessions.slice(0, TRANSCRIPT_LIMIT_MAX).map((s) => ({
          id: s.id,
          title: s.title,
          tab: s.tab,
          mtime: s.mtime,
          size: s.size,
          tags: s.tags,
          messages: s.messages,
          lastTs: s.lastTs,
        }))
        return { ok: true, result: { sessions, nextOffset: page.nextOffset } }
      }
      case "transcript.read": {
        const id = splitTranscriptId(p["id"])
        if (id === null) return notFound()
        const limit = parseLimit(p["limit"])
        const offset = parseOffset(p["offset"])
        if (limit === null || offset === null) return invalidRequest("limit and offset must be numbers")
        const page = readSession(this.opts.dataDir, id.instance, id.base, { limit, offset })
        if (page === null) return notFound()
        return {
          ok: true,
          result: {
            id: page.id,
            title: page.title,
            tags: page.tags,
            total: page.total,
            offset: page.offset,
            messages: page.messages.slice(0, TRANSCRIPT_LIMIT_MAX).map(toTranscriptMessage),
          },
        }
      }
      case "transcript.export": {
        const id = splitTranscriptId(p["id"])
        if (id === null) return notFound()
        const format = p["format"]
        if (format !== "md" && format !== "jsonl") return invalidRequest("format must be md|jsonl")
        const out = exportSession(this.opts.dataDir, id.instance, id.base, format as SessionExportFormat)
        if (out === null) return notFound()
        const clipped = clipUtf8(out.content, TRANSCRIPT_EXPORT_MAX_BYTES)
        return {
          ok: true,
          result: {
            content: clipped.text,
            contentType: out.contentType,
            truncated: clipped.truncated,
            bytes: clipped.bytes,
          },
        }
      }
      case "transcript.context": {
        const id = splitTranscriptId(p["id"])
        if (id === null) return notFound()
        const path = resolveSessionPath(this.opts.dataDir, id.instance, id.base)
        if (path === null) return notFound()
        const contextFor = this.opts.contextForSession
        if (contextFor === undefined) {
          return { ok: false, code: "unsupported", message: "session context is not available on this host" }
        }
        const view = contextFor(path)
        if (view === null) return notFound()
        return {
          ok: true,
          result: { id: `${id.instance}/${id.base}`, title: view.title, breakdown: boundBreakdown(view.breakdown) },
        }
      }
      case "transcript.delete": {
        const id = splitTranscriptId(p["id"])
        if (id === null) return notFound()
        const path = resolveSessionPath(this.opts.dataDir, id.instance, id.base)
        if (path === null) return notFound()
        if (this.opts.isSessionOpen?.(path) === true) {
          return { ok: false, code: "session_open", message: "the transcript is open in a live chat" }
        }
        const remove = this.opts.deleteSession
        if (remove === undefined) {
          return { ok: false, code: "unsupported", message: "transcript deletion is not available on this host" }
        }
        const deleted = remove(path)
        if (!deleted.ok) {
          return { ok: false, code: "delete_failed", message: deleted.message ?? "could not delete that transcript" }
        }
        return { ok: true, result: { ok: true, id: `${id.instance}/${id.base}` } }
      }
      case "memory.list": {
        const store = this.getMemoryStore()
        if (store === null) return memoryUnsupported()
        return { ok: true, result: { targets: MEMORY_TARGETS.map((target) => store.usage(target)) } }
      }
      case "memory.read": {
        const target = p["target"]
        if (!isMemoryTarget(target)) return invalidRequest("target must be memory|host|journal")
        const store = this.getMemoryStore()
        if (store === null) return memoryUnsupported()
        const read = store.readResult(target)
        const clipped = clipUtf8(read.content ?? "", MEMORY_READ_MAX_BYTES)
        const entries = (read.entries ?? []).slice(0, MEMORY_READ_MAX_ENTRIES)
        return {
          ok: true,
          result: {
            target,
            content: clipped.text,
            entries,
            usage: read.usage ?? store.usage(target),
            ...(clipped.truncated ? { truncated: true } : {}),
          },
        }
      }
      case "memory.write": {
        const target = p["target"]
        if (!isMemoryTarget(target)) return invalidRequest("target must be memory|host|journal")
        const action = p["action"]
        if (!isMemoryAction(action)) return invalidRequest("action must be add|replace|remove|rewrite|prune")
        const store = this.getMemoryStore()
        if (store === null) return memoryUnsupported()

        let result: MemoryResult
        switch (action) {
          case "add": {
            const content = memoryContent(p["content"])
            if (content === null) return invalidRequest("content is required (max 64 KiB)")
            result = store.add(target, content)
            break
          }
          case "replace": {
            const content = memoryContent(p["content"])
            const oldText = asOptionalString(p["old_text"])
            if (content === null || oldText === undefined) {
              return invalidRequest("replace needs content (max 64 KiB) + old_text")
            }
            result = store.replace(target, oldText, content)
            break
          }
          case "remove": {
            const oldText = asOptionalString(p["old_text"])
            if (oldText === undefined) return invalidRequest("remove needs old_text")
            result = store.remove(target, oldText)
            break
          }
          case "rewrite": {
            const content = memoryContent(p["content"])
            if (content === null) return invalidRequest("content is required (max 64 KiB)")
            result = store.rewrite(target, content)
            break
          }
          default: {
            // prune
            const keep = p["keep_chars"]
            if (keep !== undefined && (typeof keep !== "number" || !Number.isFinite(keep))) {
              return invalidRequest("keep_chars must be a number")
            }
            result = store.prune(target, keep as number | undefined)
            break
          }
        }

        // The audit event is identical to the REST route's; content is never logged.
        if (this.opts.events !== undefined) emitMemoryWrite(this.opts.events, result)
        return { ok: true, result: memoryResultBody(target, action, result) }
      }
      default:
        // Unreachable: the op table above is the allowlist.
        return { ok: false, code: "unknown_op", message: op }
    }
  }

  /** The per-call memory store (null when this relay has no store wired). */
  private getMemoryStore(): MemoryStore | null {
    return this.opts.memoryStore === undefined ? null : this.opts.memoryStore()
  }

  /**
   * Open one typed stream. The broker emits `stream.opened` and then flushes the
   * daemon frames in the exact order they arrived, so the cloud never sees a
   * frame before the stream it belongs to.
   */
  async openStream(streamId: string, kind: StreamKind, params: unknown, emit: BrokerEmit): Promise<StreamOpenResult> {
    if (!isRecord(params)) return { ok: false, code: "invalid_request", message: "stream params must be an object" }
    if (this.streams.has(streamId)) return { ok: false, code: "stream_exists", message: "stream id is already open" }
    const limit = this.streamLimit(kind)
    if (limit !== null) return { ok: false, code: "stream_limit", message: limit }

    const client = this.opts.clientFactory?.() ?? new LocalDaemonClient({ discover: this.opts.discover })
    let record: StreamRecord | null = null
    try {
      await client.connect()
    } catch (e) {
      client.close()
      return { ok: false, code: this.errorCode(e), message: errorMessage(e) }
    }

    record = {
      id: streamId,
      kind,
      client,
      emit,
      closed: false,
      opened: false,
      shellId: null,
      chatId: null,
      role: kind === "terminal" ? "observer" : null,
      chatStatus: null,
      pending: [],
      offFrame: () => {},
      offClose: () => {},
      runTimer: null,
      promptTimer: null,
    }
    this.streams.set(streamId, record)
    record.offFrame = client.onFrame((raw, frame) => this.onDaemonFrame(record!, raw, frame))
    record.offClose = client.onClose(() => {
      if (record!.closed) return
      this.failStream(record!, 1006, "daemon_disconnected")
    })

    try {
      if (kind === "terminal") return await this.openTerminalStream(record, params)
      if (kind === "chat") return await this.openChatStream(record, params)
      return await this.openRunStream(record, params)
    } catch (e) {
      // Open failures are reported by the tunnel as `stream.open.err`; never
      // also emit a `stream.closed` for a stream the cloud has not seen open.
      this.detachRecord(record)
      record.client.close()
      return { ok: false, code: this.errorCode(e), message: errorMessage(e) }
    }
  }

  /**
   * Forward one cloud `stream.send` frame after scope/op/ownership checks.
   * A rejected op yields a synthetic Sensus error `res` (never a dropped
   * socket), so the browser can render the typed failure.
   */
  streamSend(streamId: string, data: string): { ok: true } | { ok: false; id: string; code: string; message: string } {
    const record = this.streams.get(streamId)
    if (record === undefined || record.closed) {
      return { ok: false, id: "", code: "stream_not_found", message: "stream is not open" }
    }
    const parsed = parseDaemonRequest(data)
    if (!parsed.ok) return { ok: false, id: "", code: parsed.code, message: parsed.message }
    const { frame, id, op } = parsed
    if (BLOCKED_OPS.has(op)) {
      return { ok: false, id, code: "blocked_op", message: `${op} is never allowed for cloud traffic` }
    }

    if (record.kind === "terminal") {
      if (!hasScope(this.opts.policy.scopes, "view")) return { ok: false, id, code: "scope_required", message: "view" }
      if (!TERMINAL_STREAM_OPS.has(op)) return { ok: false, id, code: "blocked_op", message: `${op} is not allowed on a terminal stream` }
      if (op !== "terminal.detach" && record.role !== "controller") {
        return { ok: false, id, code: "not_controller", message: "this stream is an observer" }
      }
      if (op === "terminal.handover") {
        const to = optionalString(frame["to"])
        if (to === undefined || !this.isTerminalClient(to, record.id)) {
          return { ok: false, id, code: "invalid_request", message: "handover target is not a connector-owned terminal stream" }
        }
      }
      const rewritten = { ...frame, shellId: record.shellId ?? frame["shellId"] }
      this.sendLocal(record, JSON.stringify(rewritten), id)
      return { ok: true }
    }

    // chat/run streams: only the chat ops for THIS chat.
    const required: Scope = record.kind === "run" ? "orchestrator" : "chat"
    if (!hasScope(this.opts.policy.scopes, required)) return { ok: false, id, code: "scope_required", message: required }
    if (!CHAT_STREAM_OPS.has(op)) return { ok: false, id, code: "blocked_op", message: `${op} is not allowed on a ${record.kind} stream` }
    const chatId = record.chatId
    if (chatId === null || record.chatId === null) return { ok: false, id, code: "stream_not_found", message: "chat is not open yet" }
    const sentChatId = frame["chatId"]
    if (sentChatId !== undefined && sentChatId !== chatId) {
      return { ok: false, id, code: "invalid_request", message: "chatId does not belong to this stream" }
    }

    let normalized: Record<string, unknown>
    switch (op) {
      case "approvals.answer": {
        const callId = optionalString(frame["callId"])
        const action = frame["action"]
        if (callId === undefined || (action !== "accept" && action !== "reject")) {
          return { ok: false, id, code: "invalid_request", message: "approvals.answer needs callId + accept|reject" }
        }
        if (frame["addPrefix"] !== undefined || frame["addToSession"] !== undefined || frame["trust"] !== undefined) {
          return { ok: false, id, code: "trust_not_allowed", message: "trust flags are never accepted from the cloud" }
        }
        normalized = { type: "req", id, op, chatId, callId, action }
        break
      }
      case "chat.planAnswer": {
        const messageId = positiveInt(frame["messageId"])
        const raw = frame["decisions"]
        if (messageId === null || !Array.isArray(raw)) {
          return { ok: false, id, code: "invalid_request", message: "chat.planAnswer needs messageId + decisions" }
        }
        const decisions: Array<{ callId: string; accept: boolean }> = []
        for (const item of raw) {
          if (!isRecord(item) || typeof item["callId"] !== "string" || typeof item["accept"] !== "boolean") {
            return { ok: false, id, code: "invalid_request", message: "each decision needs callId + accept" }
          }
          decisions.push({ callId: item["callId"], accept: item["accept"] })
        }
        normalized = { type: "req", id, op, chatId, messageId, decisions }
        break
      }
      case "chat.answerAsk": {
        const callId = optionalString(frame["callId"])
        const answer = frame["answer"]
        if (callId === undefined || typeof answer !== "string") {
          return { ok: false, id, code: "invalid_request", message: "chat.answerAsk needs callId + answer" }
        }
        normalized = { type: "req", id, op, chatId, callId, answer }
        break
      }
      case "chat.send": {
        const text = frame["text"]
        if (typeof text !== "string") return { ok: false, id, code: "invalid_request", message: "chat.send needs text" }
        if (frame["images"] !== undefined) {
          return { ok: false, id, code: "invalid_request", message: "image attachments are not part of the cloud v1 chat surface" }
        }
        normalized = { type: "req", id, op, chatId, text }
        break
      }
      case "chat.abort":
      case "chat.compact":
      case "chat.retry":
        normalized = { type: "req", id, op, chatId }
        break
      default:
        return { ok: false, id, code: "blocked_op", message: op }
    }
    this.sendLocal(record, JSON.stringify(normalized), id)
    return { ok: true }
  }

  /**
   * Close one stream. Terminal → `terminal.detach` (never kill); chat →
   * `chat.detach` (the chat survives); run → abort-if-streaming then
   * kill the dedicated shell and forget the local run record. Returns false
   * for an unknown id so the tunnel can report `stream_not_found`.
   */
  async closeStream(streamId: string, reason = "closed"): Promise<boolean> {
    const record = this.streams.get(streamId)
    if (record === undefined) return false
    this.detachRecord(record)
    await this.cleanupRecord(record, reason)
    return true
  }

  /** Close every local stream (tunnel loss/shutdown). No cloud frames are sent. */
  async closeAll(reason = "tunnel_closed"): Promise<void> {
    const records = [...this.streams.values()]
    for (const record of records) this.detachRecord(record)
    await Promise.allSettled(records.map((record) => this.cleanupRecord(record, reason)))
    this.control?.close()
    this.control = null
  }

  // -- stream open ------------------------------------------------------------

  private async openTerminalStream(record: StreamRecord, params: Record<string, unknown>): Promise<StreamOpenResult> {
    if (!hasScope(this.opts.policy.scopes, "view")) return { ok: false, code: "scope_required", message: "view" }
    const wantsNew = params["new"] !== undefined
    if (wantsNew && !hasScope(this.opts.policy.scopes, "control")) return { ok: false, code: "scope_required", message: "control" }
    const requestedController = params["role"] === "controller" && hasScope(this.opts.policy.scopes, "control")
    const desiredRole: Role = wantsNew ? "controller" : requestedController ? "controller" : "observer"

    let shellId: string | null = optionalString(params["shellId"]) ?? null
    const cols = positiveInt(params["cols"])
    const rows = positiveInt(params["rows"])

    if (wantsNew) {
      const rawNew = params["new"]
      if (!isRecord(rawNew)) return { ok: false, code: "invalid_request", message: "new must be an object" }
      const newCols = positiveInt(rawNew["cols"])
      const newRows = positiveInt(rawNew["rows"])
      if (newCols === null || newRows === null) {
        return { ok: false, code: "invalid_request", message: "new.cols and new.rows are required" }
      }
      const cwd = optionalString(rawNew["cwd"])
      if (!isCwdAllowed(this.opts.policy, cwd)) {
        return { ok: false, code: "cwd_not_allowed", message: "cwd is outside the local policy's allowedCwd" }
      }
      // A cloud-selected shell is never accepted; the daemon default is used.
      const opened = await record.client.request("terminal.open", {
        cols: newCols,
        rows: newRows,
        ...(cwd !== undefined ? { cwd } : {}),
      })
      shellId = typeof opened["shellId"] === "string" ? opened["shellId"] : null
      if (shellId === null) return { ok: false, code: "daemon_error", message: "terminal.open returned no shellId" }
    }
    if (shellId === null) return { ok: false, code: "invalid_request", message: "shellId or new is required" }

    let attached: Record<string, unknown>
    try {
      attached = await record.client.request("terminal.attach", {
        shellId,
        role: desiredRole,
        ...(cols !== null ? { cols } : {}),
        ...(rows !== null ? { rows } : {}),
        ...(typeof params["cursor"] === "number" ? { cursor: params["cursor"] } : {}),
      })
    } catch (e) {
      if (desiredRole === "controller" && this.errorCode(e) === "controller_taken") {
        // The protocol's controller fallback: retry as observer and let the
        // actual role be reported in `terminal.attached`.
        record.pending = []
        attached = await record.client.request("terminal.attach", {
          shellId,
          role: "observer",
          ...(cols !== null ? { cols } : {}),
          ...(rows !== null ? { rows } : {}),
          ...(typeof params["cursor"] === "number" ? { cursor: params["cursor"] } : {}),
        })
        record.role = "observer"
      } else {
        throw e
      }
    }
    record.shellId = shellId
    record.role = attached["role"] === "controller" ? "controller" : "observer"
    this.openRecord(record, {
      shellId,
      role: record.role,
      ...(record.client.clientId !== null ? { clientId: record.client.clientId } : {}),
    })
    if (record.role === "controller" && cols !== null && rows !== null) {
      // A controller attach at its own size resizes the PTY (daemon behavior);
      // nothing extra is needed here.
    }
    return { ok: true }
  }

  private async openChatStream(record: StreamRecord, params: Record<string, unknown>): Promise<StreamOpenResult> {
    if (!hasScope(this.opts.policy.scopes, "view")) return { ok: false, code: "scope_required", message: "view" }
    const wantsNew = params["new"] !== undefined
    if (wantsNew && !hasScope(this.opts.policy.scopes, "chat")) return { ok: false, code: "scope_required", message: "chat" }
    if (wantsNew && params["resume"] !== undefined) {
      return { ok: false, code: "blocked_op", message: "a cloud chat may not resume a raw transcript path" }
    }
    if (wantsNew) {
      const rawNew = params["new"]
      if (!isRecord(rawNew)) return { ok: false, code: "invalid_request", message: "new must be an object" }
      if (rawNew["resume"] !== undefined) {
        return { ok: false, code: "blocked_op", message: "a cloud chat may not resume a raw transcript path" }
      }
      const shellId = optionalString(rawNew["shellId"])
      if (shellId !== undefined) {
        const shells = await record.client.request("terminal.list", {})
        const list = Array.isArray(shells["shells"]) ? (shells["shells"] as unknown[]) : []
        if (!list.some((entry) => isRecord(entry) && entry["shellId"] === shellId)) {
          return { ok: false, code: "shell_not_found", message: "the bound shell does not exist" }
        }
      }
      const agent = optionalString(rawNew["agent"])
      const model = optionalString(rawNew["model"])
      const opened = await record.client.request("chat.open", {
        ...(shellId !== undefined ? { shellId } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
      })
      const chatId = typeof opened["chatId"] === "string" ? opened["chatId"] : null
      if (chatId === null) return { ok: false, code: "daemon_error", message: "chat.open returned no chatId" }
      record.chatId = chatId
      this.openRecord(record, { chatId, shellId })
      return { ok: true }
    }

    const chatId = optionalString(params["chatId"])
    if (chatId === undefined) return { ok: false, code: "invalid_request", message: "chatId or new is required" }
    const attached = await record.client.request("chat.attach", { chatId })
    const actual = typeof attached["chatId"] === "string" ? attached["chatId"] : chatId
    record.chatId = actual
    this.openRecord(record, { chatId: actual })
    return { ok: true }
  }

  private async openRunStream(record: StreamRecord, params: Record<string, unknown>): Promise<StreamOpenResult> {
    if (!hasScope(this.opts.policy.scopes, "orchestrator")) return { ok: false, code: "scope_required", message: "orchestrator" }
    const prompt = params["prompt"]
    if (typeof prompt !== "string" || prompt.length === 0) {
      return { ok: false, code: "invalid_request", message: "run.prompt is required" }
    }
    const agent = optionalString(params["agent"])
    const model = optionalString(params["model"])

    // Headless runs get a dedicated shell so the chat has terminal context and
    // can be released deterministically (terminal.kill closes the bound chat).
    const shell = await record.client.request("terminal.open", { cols: 80, rows: 24 }, 10_000)
    const shellId = typeof shell["shellId"] === "string" ? shell["shellId"] : null
    if (shellId === null) return { ok: false, code: "daemon_error", message: "terminal.open returned no shellId" }
    record.shellId = shellId

    let chatId: string | null = null
    try {
      const opened = await record.client.request(
        "chat.open",
        {
          shellId,
          ...(agent !== undefined ? { agent } : {}),
          ...(model !== undefined ? { model } : {}),
        },
        10_000,
      )
      chatId = typeof opened["chatId"] === "string" ? opened["chatId"] : null
    } catch (error) {
      await record.client.request("terminal.kill", { shellId }, 2_000).catch(() => {})
      return { ok: false, code: this.errorCode(error), message: errorMessage(error) }
    }
    if (chatId === null) {
      await record.client.request("terminal.kill", { shellId }, 2_000).catch(() => {})
      return { ok: false, code: "daemon_error", message: "chat.open returned no chatId" }
    }
    record.chatId = chatId

    const timeoutSec = this.runTimeoutSec(params["timeoutSec"])
    const recordRun = this.opts.recordRun
    if (recordRun !== undefined) {
      const recorded = recordRun({ streamId: record.id, chatId, shellId, startedAt: this.now() })
      if (!recorded.ok) this.opts.onLog?.("warn", recorded.error ?? "could not record the run")
    }
    this.openRecord(record, { chatId, shellId })
    if (timeoutSec > 0) {
      record.runTimer = setTimeout(() => {
        void this.finishRun(record, "timeout", 1000)
      }, timeoutSec * 1000)
      record.runTimer.unref?.()
    }
    // Subscribe before sending: the daemon can emit events before the response.
    try {
      await record.client.request("chat.send", { chatId, text: prompt })
    } catch (error) {
      void this.finishRun(record, "run_failed", 1011)
      return { ok: false, code: this.errorCode(error), message: errorMessage(error) }
    }
    return { ok: true }
  }

  private runTimeoutSec(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return RUN_DEFAULT_TIMEOUT_SEC
    return Math.min(RUN_MAX_TIMEOUT_SEC, Math.max(1, Math.floor(raw)))
  }

  private openRecord(record: StreamRecord, meta: Record<string, unknown>): void {
    record.opened = true
    record.emit({ t: "stream.opened", streamId: record.id, meta })
    const pending = record.pending
    record.pending = []
    for (const frame of pending) this.emitFrame(record, frame.raw)
  }

  private onDaemonFrame(record: StreamRecord, raw: string, frame: DaemonFrame): void {
    if (record.closed) return
    if (
      record.kind === "terminal" &&
      frame.type === "evt" &&
      frame.event === "terminal.role" &&
      frame["clientId"] === record.client.clientId &&
      (frame["role"] === "controller" || frame["role"] === "observer")
    ) {
      record.role = frame["role"]
    }
    this.trackChatFrame(record, frame)
    if (!record.opened) {
      record.pending.push({ raw, frame })
      return
    }
    this.emitFrame(record, raw)
  }

  private emitFrame(record: StreamRecord, raw: string): void {
    try {
      record.emit({ t: "stream.frame", streamId: record.id, data: raw })
    } catch (e) {
      this.opts.onLog?.("warn", `stream frame emit failed: ${errorMessage(e)}`)
    }
  }

  /** Track chat status/prompt events for run cleanup + the prompt hard cap. */
  private trackChatFrame(record: StreamRecord, frame: DaemonFrame): void {
    if (record.kind === "terminal" || frame.type !== "evt" || typeof frame.event !== "string") return
    if (frame.event === "chat.status" && typeof frame["status"] === "string") {
      record.chatStatus = frame["status"]
      if (frame["status"] !== "streaming") this.clearPromptTimer(record)
    } else if (frame.event === "chat.done") {
      record.chatStatus = "idle"
      this.clearPromptTimer(record)
    } else if (frame.event === "approvals.request" || frame.event === "chat.plan" || frame.event === "sudo.request") {
      this.armPromptTimer(record)
    } else if (frame.event === "approvals.resolved" || frame.event === "sudo.resolved") {
      this.clearPromptTimer(record)
    }
  }

  private armPromptTimer(record: StreamRecord): void {
    if (record.promptTimer !== null) return
    record.promptTimer = setTimeout(() => {
      record.promptTimer = null
      if (record.closed || record.chatId === null) return
      this.opts.onLog?.("warn", `pending prompt exceeded the connector hard cap (${record.chatId}); aborting the turn`)
      void record.client.request("chat.abort", { chatId: record.chatId }).catch(() => {
        // best-effort; the chat is still released on close/startup cleanup
      })
    }, this.approvalHardCapMs)
    record.promptTimer.unref?.()
  }

  private clearPromptTimer(record: StreamRecord): void {
    if (record.promptTimer === null) return
    clearTimeout(record.promptTimer)
    record.promptTimer = null
  }

  // -- stream lifecycle -------------------------------------------------------

  private sendLocal(record: StreamRecord, raw: string, requestId: string): void {
    try {
      record.client.sendRaw(raw)
    } catch (e) {
      const code = this.errorCode(e)
      record.emit({ t: "stream.frame", streamId: record.id, data: daemonErrorFrame(requestId, code) })
    }
  }

  private streamLimit(kind: StreamKind): string | null {
    if (this.streams.size >= this.maxStreams) return `connection stream limit (${this.maxStreams}) reached`
    let terminal = 0
    let other = 0
    for (const stream of this.streams.values()) {
      if (stream.kind === "terminal") terminal += 1
      else other += 1
    }
    if (kind === "terminal" && terminal >= Math.min(CLOUD_MAX_TERMINAL_STREAMS, this.maxStreams)) {
      return "terminal stream limit reached"
    }
    if (kind !== "terminal" && other >= CLOUD_MAX_CHAT_RUN_STREAMS) return "chat/run stream limit reached"
    return null
  }

  private isTerminalClient(clientId: string, exceptStreamId: string): boolean {
    for (const stream of this.streams.values()) {
      if (stream.id === exceptStreamId) continue
      if (stream.kind !== "terminal" || stream.client.clientId === null) continue
      if (stream.client.clientId === clientId) return true
    }
    return false
  }

  /** Mark closed/remove from the map and clear timers/subscriptions. */
  private detachRecord(record: StreamRecord): void {
    if (record.closed) return
    record.closed = true
    this.streams.delete(record.id)
    this.clearPromptTimer(record)
    if (record.runTimer !== null) {
      clearTimeout(record.runTimer)
      record.runTimer = null
    }
    try {
      record.offFrame()
      record.offClose()
    } catch {
      // best-effort
    }
  }

  private async cleanupRecord(record: StreamRecord, reason: string): Promise<void> {
    const client = record.client
    try {
      if (record.kind === "terminal" && record.shellId !== null && record.role !== null) {
        // Detach, never kill. A controller detach frees the role for the local
        // TUI; the shell and any command running in it stay alive.
        await client.request("terminal.detach", { shellId: record.shellId }, 2_000).catch(() => {})
      } else if (record.kind === "chat" && record.chatId !== null) {
        // The chat survives (D4); only this stream stops observing it.
        await client.request("chat.detach", { chatId: record.chatId }, 2_000).catch(() => {})
      } else if (record.kind === "run" && record.chatId !== null) {
        // Always abort first, not only when a status event already arrived: the
        // daemon can be streaming before the first `chat.status` frame lands.
        await client.request("chat.abort", { chatId: record.chatId }, 2_000).catch(() => {})
        let closed = false
        if (record.shellId !== null) {
          try {
            await client.request("terminal.kill", { shellId: record.shellId }, 5_000)
            closed = true
          } catch (e) {
            const errorCode = this.errorCode(e)
            // An already-gone shell is clean; a transport failure keeps the run
            // record so the next startup cleanup can try again.
            if (errorCode === "shell_not_found") closed = true
            else this.opts.onLog?.("warn", `run cleanup terminal.kill failed (${errorCode})`)
          }
        }
        if (closed) this.opts.forgetRun?.(record.id)
      }
    } finally {
      client.close()
    }
    void reason
  }

  /** Async close for a timeout or a daemon-side chat release. */
  private async finishRun(record: StreamRecord, reason: string, code: number): Promise<void> {
    if (record.closed) return
    this.detachRecord(record)
    await this.cleanupRecord(record, reason)
    record.emit({ t: "stream.closed", streamId: record.id, code, reason })
  }

  private failStream(record: StreamRecord, code: number, reason: string): void {
    if (record.closed) return
    this.detachRecord(record)
    // A run chat may still exist in the daemon: keep runs.json for the next
    // startup cleanup, but close this local WS now.
    record.client.close()
    record.emit({ t: "stream.closed", streamId: record.id, code, reason })
  }

  // -- control client / RPC helpers ------------------------------------------

  private async controlClient(): Promise<LocalDaemonLike> {
    if (this.control !== null && this.control.connected) return this.control
    if (this.controlConnecting !== null) return await this.controlConnecting
    const client = this.opts.clientFactory?.() ?? new LocalDaemonClient({ discover: this.opts.discover })
    const connecting = (async () => {
      try {
        await client.connect()
      } catch (e) {
        client.close()
        throw e
      }
      client.onClose(() => {
        if (this.control === client) this.control = null
      })
      this.control = client
      return client
    })()
    this.controlConnecting = connecting
    try {
      return await connecting
    } finally {
      this.controlConnecting = null
    }
  }

  private async controlRequest(op: string, params: Record<string, unknown>): Promise<RpcOutcome> {
    try {
      const client = await this.controlClient()
      const result = await client.request(op, params)
      return { ok: true, result }
    } catch (e) {
      return { ok: false, code: this.errorCode(e), message: errorMessage(e) }
    }
  }

  private errorCode(e: unknown): string {
    if (e instanceof DaemonClientError) return e.code
    if (isRecord(e) && typeof e["code"] === "string") return e["code"]
    return "daemon_error"
  }
}

function scopeError(scope: Scope): RpcOutcome {
  return { ok: false, code: "scope_required", message: `the local policy does not grant ${scope}` }
}

function invalidRequest(message: string): RpcOutcome {
  return { ok: false, code: "invalid_request", message }
}

function notFound(): RpcOutcome {
  return { ok: false, code: "not_found", message: "unknown transcript" }
}

function memoryUnsupported(): RpcOutcome {
  return { ok: false, code: "unsupported", message: "memory is not available on this host" }
}

/** A store string field (REST parity: any string, including empty, is passed through). */
function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** A memory write's `content`: required string, rejected (not clipped) above 64 KiB. */
function memoryContent(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  if (Buffer.byteLength(raw, "utf8") > MEMORY_WRITE_MAX_BYTES) return null
  return raw
}

/**
 * The store's result verbatim (a store-domain refusal stays a NORMAL `rpc.res`
 * with `ok:false`, exactly like the REST route's 200). Content is not logged.
 */
function memoryResultBody(target: MemoryTarget, action: string, result: MemoryResult): Record<string, unknown> {
  return {
    ok: result.ok,
    target,
    action,
    message: result.message,
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.entries !== undefined ? { entries: result.entries } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.write !== undefined ? { write: result.write } : {}),
  }
}

/** Project a discovery result into the cloud's `DaemonFacts` (no pid/socket/tcp). */
export function factsFromDiscovery(discovery: DiscoveryResult): DaemonFacts {
  if (!discovery.ok) {
    return { state: discovery.state === "stopped" ? "stopped" : "unreachable" }
  }
  const info = discovery.discovery.info
  return {
    state: "running",
    version: info.version,
    instanceId: info.instance?.instanceId,
    startedAt: info.startedAt,
    persistent: info.persistent,
    shellCount: info.shells,
  }
}
