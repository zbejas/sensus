/**
 * The extension seam (docs/extensions.md): the two privileged interfaces the
 * agent exposes to a third party, and their built-in, no-op/local defaults.
 *
 *   1. `ApprovalPolicy` — consulted once per tool call BEFORE anything renders
 *      or auto-approves, and returns a decision (it never renders). It can
 *      `allow`, force a card (`ask`), or terminally `deny`. A `null`/invalid
 *      answer defers to the built-in approval modes.
 *   2. `EventSink` — a fire-and-forget stream of the audit-worthy events the
 *      agent already produces implicitly: `session-start`, `command-approved`,
 *      `command-denied`, `command-ran`, `memory-write`.
 *
 * Both are OPTIONAL and default to a no-op: with neither configured the agent
 * behaves byte-for-byte as before. The interfaces are the public API (the
 * open/paid boundary, docs/licensing.md); config.json only selects the
 * built-in implementations ([`docs/extensions.md`](../../docs/extensions.md)).
 *
 * Never throws into the tool path: every consultation and every emit is
 * wrapped, the sink is fire-and-forget, and its buffer is bounded (drop
 * oldest). This mirrors `src/terminal/responseGuard.ts`: pure, bounded,
 * synchronous, never-throw.
 */

import type { ApprovalMode } from "../config/config/types.ts"
import type { ApprovalDecision } from "./tools/types.ts"
import type { MemoryTarget } from "./memory/types.ts"
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { eventsPath } from "../config/config/paths.ts"
import { componentLogger } from "./log.ts"

const log = componentLogger("agent.extensions")

// ---- Configuration (docs/config.md "extensions") ----------------------------

/**
 * Config for an approval policy. `kind` names the implementation —
 * `"default"` (the shipped default) defers to the built-in approval modes; any
 * other kind is resolved by the host-supplied factory (a stock build has none,
 * so an unknown kind is a no-op). Extra keys are free-form settings handed to
 * that factory.
 */
export interface ApprovalPolicyConfig {
  kind: string
  [key: string]: unknown
}

/** Config for the event sink. `"noop"` (default) drops every event; `"uds"`
 * writes newline-delimited JSON to a local Unix socket; `"jsonl"` appends the
 * versioned (v1) local event log. No TCP, ever. */
export interface EventSinkConfig {
  kind: "noop" | "uds" | "jsonl"
  /** Absolute Unix-socket path (required for `"uds"`). A `unix://` prefix is
   * accepted for symmetry with the worker↔server config. For `"jsonl"` an
   * optional override for the event-log path (defaults to `<data>/events.jsonl`). */
  path?: string
}

export interface ExtensionsConfig {
  approvalPolicy: ApprovalPolicyConfig
  eventSink: EventSinkConfig
}

// ---- Events -----------------------------------------------------------------

/** Who permitted a call: the built-in decision (`auto`), the user, or a policy. */
export type ApprovalSource = "auto" | "user" | "policy"

/** Who refused a call: a config rule, a policy, a read-only guard, the user, or an abort. */
export type DenialSource = "permission" | "policy" | "guard" | "user" | "aborted"

interface EventBase {
  /** Epoch millis. */
  ts: number
  /** Instance id of the session (coarse grouping; matches the audit log). */
  session: string
  /** Tool name (`shell_background`, `edit_file`, `mcp__…`). */
  tool: string
}

/** A tool call was permitted to run (or rendered an auto-approved card). */
export interface CommandApprovedEvent extends EventBase {
  type: "command-approved"
  source: ApprovalSource
  approval: ApprovalMode
  agent: string
  cwd: string | null
  shell: string
}

/** A tool call was refused — a terminal policy/permission `deny`, a user
 * reject, or an abort. It never executed and rendered no pending card. */
export interface CommandDeniedEvent extends EventBase {
  type: "command-denied"
  source: DenialSource
  approval: ApprovalMode
  agent: string
  /** Present for a policy denial. */
  reason?: string
}

/** A tool call executed (the counterpart to `command-approved`). `command` is
 * the call's primary target — the shell command, file path, or query — capped
 * at `EVENT_TARGET_MAX`. */
export interface CommandRanEvent extends EventBase {
  type: "command-ran"
  command: string
  approval: ApprovalMode
  agent: string
  cwd: string | null
  shell: string
  ok: boolean
  exitCode?: number | null
}

/** A `memory` tool write committed; the char deltas the store computes. */
export interface MemoryWriteEvent {
  type: "memory-write"
  ts: number
  session: string
  target: MemoryTarget
  action: string
  beforeChars: number
  afterChars: number
  delta: number
  ok: boolean
}

/** A chat session opened (fresh or resumed). */
export interface SessionStartEvent {
  type: "session-start"
  ts: number
  session: string
  agent: string
  approval: ApprovalMode
  shell: string
  model: string
  resumed: boolean
}

/** A chat session was released (the daemon drops a chat / shuts down). */
export interface SessionEndEvent {
  type: "session-end"
  ts: number
  session: string
  /** Free-form reason (`"shutdown"`, `"closed"`). */
  reason: string
}

/** An agent turn settled — the session status returned to idle. */
export interface TurnCompleteEvent {
  type: "turn-complete"
  ts: number
  session: string
  /** Wall-clock duration of the generation, ms. */
  durationMs: number
  outcome: "ok" | "aborted" | "error"
  model: string
}

/** A write/edit tool committed (or failed to commit) a file. */
export interface FileChangeEvent {
  type: "file-change"
  ts: number
  session: string
  tool: string
  path: string
  action: "write" | "edit"
  ok: boolean
}

/** A skill was loaded/used (the `skill_view` tool). */
export interface SkillUseEvent {
  type: "skill-use"
  ts: number
  session: string
  name: string
  /** Where the use came from (`"tool"` in v1). */
  source: string
}

/** A provider/engine/tool error surfaced to the session. */
export interface ErrorRaisedEvent {
  type: "error-raised"
  ts: number
  session: string
  /** `"provider"` | `"compaction"` | `"tool"` | `"engine"`. */
  source: string
  message: string
  tool?: string
}

export type SensusEvent =
  | CommandApprovedEvent
  | CommandDeniedEvent
  | CommandRanEvent
  | MemoryWriteEvent
  | SessionStartEvent
  | SessionEndEvent
  | TurnCompleteEvent
  | FileChangeEvent
  | SkillUseEvent
  | ErrorRaisedEvent

/** The primary-target cap on a `command-ran` event (bounded emit). */
export const EVENT_TARGET_MAX = 512

/**
 * The audit-event sink. Implementations MUST return promptly (never block the
 * TUI), MUST NOT throw (a failing sink is dropped silently), and MAY drop
 * events under load. `emit` is fire-and-forget: a slow/absent receiver must
 * never stall a tool call.
 */
export interface EventSink {
  emit(event: SensusEvent): void
}

/** The default sink: drops everything. Used when nothing is configured. */
export class NoopEventSink implements EventSink {
  emit(_event: SensusEvent): void {
    // no-op
  }
}

/** Bounded backlog per sink; the oldest line is dropped past this (never grows). */
export const UDS_EVENT_QUEUE_MAX = 500
/** Minimum delay between reconnect attempts after a failed/closed connection. */
export const UDS_RECONNECT_MS = 1000

const encoder = new TextEncoder()

/** UTF-8 byte length of a string (the rotation cap is bytes, not chars). */
function byteLength(s: string): number {
  return encoder.encode(s).length
}

/**
 * Writes newline-delimited JSON events to a local Unix socket. Local-only and
 * dependency-free (`Bun.connect({ unix })`). A missing/refused socket drops
 * events silently and never throws or blocks: `emit` only enqueues and, at
 * most, kicks off a non-awaited connect. The queue is bounded (drop oldest)
 * and writes are partially retried on backpressure, so a stalled receiver
 * cannot grow memory or the TUI's latency.
 */
export class UdsEventSink implements EventSink {
  private readonly path: string
  private readonly maxQueue: number
  private readonly queue: string[] = []
  private socket: import("bun").Socket | null = null
  private connected = false
  private connecting = false
  private retryAt = 0
  /** In-flight line whose bytes are partially written (backpressure). */
  private pending: Uint8Array | null = null
  private pendingOffset = 0

  constructor(path: string, opts: { maxQueue?: number } = {}) {
    // Accept the `unix://` form the worker↔server config uses.
    this.path = path.startsWith("unix://") ? path.slice("unix://".length) : path
    this.maxQueue = opts.maxQueue !== undefined && opts.maxQueue > 0 ? Math.floor(opts.maxQueue) : UDS_EVENT_QUEUE_MAX
  }

  emit(event: SensusEvent): void {
    try {
      this.queue.push(`${JSON.stringify(event)}\n`)
      if (this.queue.length > this.maxQueue) this.queue.shift()
      this.ensureConnected()
      if (this.connected) this.flush()
    } catch {
      // an audit event must never break the action it records
    }
  }

  /** Lines waiting to be written (diagnostics/tests; the bound is the contract). */
  pendingCount(): number {
    return this.queue.length + (this.pending !== null ? 1 : 0)
  }

  private ensureConnected(): void {
    if (this.connected || this.connecting) return
    if (Date.now() < this.retryAt) return
    this.connecting = true
    void this.connect()
  }

  private async connect(): Promise<void> {
    try {
      const socket = await Bun.connect({
        unix: this.path,
        socket: {
          open: () => {
            this.connected = true
            this.connecting = false
            this.retryAt = 0
            this.flush()
          },
          data: () => {},
          error: () => this.onClose(),
          close: () => this.onClose(),
          drain: () => this.flush(),
          connectError: () => this.onClose(),
        },
      })
      this.socket = socket
      this.connected = true
      this.connecting = false
      this.retryAt = 0
      try {
        socket.unref()
      } catch (e) {
        // unref is best-effort; an open audit socket must not pin the process
        log.debug("uds event sink socket unref failed", { err: e })
      }
      this.flush()
    } catch (e) {
      log.warn("uds event sink connect failed; events dropped until reconnect", { path: this.path, err: e })
      this.onClose()
    }
  }

  private onClose(): void {
    this.connected = false
    this.connecting = false
    this.socket = null
    // Drop the partially written line: a reconnect must not splice a corrupt
    // NDJSON record onto the next one.
    this.pending = null
    this.pendingOffset = 0
    this.retryAt = Date.now() + UDS_RECONNECT_MS
  }

  private flush(): void {
    const socket = this.socket
    if (socket === null || !this.connected) return
    try {
      for (;;) {
        if (this.pending === null) {
          const line = this.queue.shift()
          if (line === undefined) return
          this.pending = encoder.encode(line)
          this.pendingOffset = 0
        }
        const buf = this.pending
        const written = socket.write(buf, this.pendingOffset)
        if (written < 0) {
          this.onClose()
          return
        }
        this.pendingOffset += written
        if (this.pendingOffset < buf.length) return // backpressure: wait for drain
        this.pending = null
        this.pendingOffset = 0
      }
    } catch (e) {
      log.warn("uds event sink write failed; reconnecting", { err: e })
      this.onClose()
    }
  }
}

export type EventSinkFactory = (config: EventSinkConfig) => EventSink

// ---- Event schema v1 (the durable local log; docs/events.md) -----------------
//
// The UDS sink above streams the RAW seam events to a local receiver. The JSONL
// sink below is the frozen, versioned on-disk form: every line is one `EventV1`
// with a `v` discriminator, written to `<data>/events.jsonl`. The eight v1
// types are a projection of the seam events; `command-approved`/`command-denied`
// have no v1 counterpart yet and are dropped there (the UDS stream keeps them).

/** The frozen v1 event schema version. Bump only with a migration. */
export const EVENT_SCHEMA_VERSION = 1 as const

/** Hard byte cap of `events.jsonl` before it rotates to `events.jsonl.1`. */
export const JSONL_EVENT_MAX_BYTES = 5 * 1024 * 1024
/** Suffix of the single retained rotated file (`events.jsonl.1`). */
export const JSONL_EVENT_ROTATED_SUFFIX = ".1"
/** Bounded in-memory backlog per sink; the oldest line is dropped past this. */
export const JSONL_EVENT_QUEUE_MAX = 1000
/** Per-field character cap on a v1 record (bounded file growth, never throws). */
export const EVENT_FIELD_MAX = 4096

export type EventV1Type =
  | "session.started"
  | "session.ended"
  | "turn.completed"
  | "tool.executed"
  | "file.changed"
  | "memory.written"
  | "skill.used"
  | "error.raised"

/** The eight v1 event type names, for runtime validation (config parsing,
 * trigger matching). Keep in sync with `EventV1Type`. */
export const EVENT_V1_TYPES: readonly EventV1Type[] = [
  "session.started",
  "session.ended",
  "turn.completed",
  "tool.executed",
  "file.changed",
  "memory.written",
  "skill.used",
  "error.raised",
]

interface EventV1Base {
  /** Schema version (always `1` in this build). */
  v: typeof EVENT_SCHEMA_VERSION
  /** Epoch millis. */
  ts: number
  /** The machine/installation id (instance.json). */
  instanceId: string
  /** The chat session the event belongs to. */
  session: string
  type: EventV1Type
}

export interface SessionStartedV1 extends EventV1Base {
  type: "session.started"
  agent: string
  approval: ApprovalMode
  shell: string
  model: string
  resumed: boolean
}

export interface SessionEndedV1 extends EventV1Base {
  type: "session.ended"
  reason: string
}

export interface TurnCompletedV1 extends EventV1Base {
  type: "turn.completed"
  durationMs: number
  outcome: "ok" | "aborted" | "error"
  model: string
}

export interface ToolExecutedV1 extends EventV1Base {
  type: "tool.executed"
  tool: string
  command: string
  ok: boolean
  exitCode?: number | null
  approval: ApprovalMode
  agent: string
  cwd: string | null
  shell: string
}

export interface FileChangedV1 extends EventV1Base {
  type: "file.changed"
  tool: string
  path: string
  action: "write" | "edit"
  ok: boolean
}

export interface MemoryWrittenV1 extends EventV1Base {
  type: "memory.written"
  target: MemoryTarget
  action: string
  beforeChars: number
  afterChars: number
  delta: number
  ok: boolean
}

export interface SkillUsedV1 extends EventV1Base {
  type: "skill.used"
  name: string
  source: string
}

export interface ErrorRaisedV1 extends EventV1Base {
  type: "error.raised"
  source: string
  message: string
  tool?: string
}

/** The frozen event schema v1 union (one JSON object per NDJSON line). */
export type EventV1 =
  | SessionStartedV1
  | SessionEndedV1
  | TurnCompletedV1
  | ToolExecutedV1
  | FileChangedV1
  | MemoryWrittenV1
  | SkillUsedV1
  | ErrorRaisedV1

/** Cap a free-form string field so one event can never grow the log unbounded. */
function capField(value: string, max = EVENT_FIELD_MAX): string {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Project a seam event onto the frozen v1 schema. Returns null for a seam event
 * that has no v1 counterpart. Pure and total over the union.
 */
export function toEventV1(event: SensusEvent, instanceId: string): EventV1 | null {
  const base = { v: EVENT_SCHEMA_VERSION, ts: event.ts, instanceId, session: event.session } as const
  switch (event.type) {
    case "session-start":
      return {
        ...base,
        type: "session.started",
        agent: event.agent,
        approval: event.approval,
        shell: event.shell,
        model: event.model,
        resumed: event.resumed,
      }
    case "session-end":
      return { ...base, type: "session.ended", reason: capField(event.reason) }
    case "turn-complete":
      return {
        ...base,
        type: "turn.completed",
        durationMs: Math.max(0, Math.round(event.durationMs)),
        outcome: event.outcome,
        model: event.model,
      }
    case "command-ran":
      return {
        ...base,
        type: "tool.executed",
        tool: event.tool,
        command: capField(event.command),
        ok: event.ok,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        approval: event.approval,
        agent: event.agent,
        cwd: event.cwd,
        shell: event.shell,
      }
    case "file-change":
      return {
        ...base,
        type: "file.changed",
        tool: event.tool,
        path: capField(event.path),
        action: event.action,
        ok: event.ok,
      }
    case "memory-write":
      return {
        ...base,
        type: "memory.written",
        target: event.target,
        action: event.action,
        beforeChars: event.beforeChars,
        afterChars: event.afterChars,
        delta: event.delta,
        ok: event.ok,
      }
    case "skill-use":
      return { ...base, type: "skill.used", name: capField(event.name), source: event.source }
    case "error-raised":
      return {
        ...base,
        type: "error.raised",
        source: event.source,
        message: capField(event.message),
        ...(event.tool !== undefined ? { tool: event.tool } : {}),
      }
    case "command-approved":
    case "command-denied":
      return null
  }
}

export interface JsonlEventSinkOptions {
  /** Absolute path to the NDJSON log. */
  path: string
  /** The machine/installation id stamped on every record. */
  instanceId: string
  /** Byte cap before rotation; `0` disables rotation. Default `JSONL_EVENT_MAX_BYTES`. */
  maxBytes?: number
  /** Bounded backlog; default `JSONL_EVENT_QUEUE_MAX`. */
  queueMax?: number
}

/**
 * The built-in durable local event log (event schema v1; docs/events.md).
 *
 * `emit` is fire-and-forget and never throws: the record is appended to a
 * bounded in-memory queue (drop-oldest) and flushed on a `setImmediate`, so a
 * tool call is never blocked on disk. The file grows to `maxBytes`, then
 * rotates to `<path>.1` (one retained generation; the older `.1` is replaced
 * wholesale), bounding total growth. `flushSync()` drains the queue
 * synchronously (daemon shutdown / tests). No network, ever.
 */
export class JsonlEventSink implements EventSink {
  private readonly path: string
  private readonly instanceId: string
  private readonly maxBytes: number
  private readonly queueMax: number
  private readonly queue: string[] = []
  private flushing = false

  constructor(opts: JsonlEventSinkOptions) {
    this.path = opts.path
    this.instanceId = opts.instanceId
    this.maxBytes = opts.maxBytes !== undefined && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : JSONL_EVENT_MAX_BYTES
    this.queueMax = opts.queueMax !== undefined && opts.queueMax > 0 ? Math.floor(opts.queueMax) : JSONL_EVENT_QUEUE_MAX
  }

  emit(event: SensusEvent): void {
    try {
      const v1 = toEventV1(event, this.instanceId)
      if (v1 === null) return
      this.queue.push(`${JSON.stringify(v1)}\n`)
      if (this.queue.length > this.queueMax) this.queue.shift()
      this.schedule()
    } catch {
      // an audit event must never break the action it records
    }
  }

  /** Lines waiting to be written (diagnostics/tests; the bound is the contract). */
  pendingCount(): number {
    return this.queue.length
  }

  /** Drain the queue synchronously. Never throws. */
  flushSync(): void {
    if (this.queue.length === 0) return
    const batch = this.queue.join("")
    this.queue.length = 0
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      this.rotateIfNeeded(byteLength(batch))
      appendFileSync(this.path, batch)
    } catch (e) {
      // drop the batch: the log must never break its writer
      log.error("jsonl event sink flush failed; durable events dropped", { path: this.path, err: e })
    }
  }

  private schedule(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      setImmediate(() => this.drain())
    } catch {
      this.flushing = false
    }
  }

  private drain(): void {
    this.flushing = false
    this.flushSync()
    if (this.queue.length > 0) this.schedule()
  }

  /** Rotate when the incoming batch would push the file over `maxBytes`. */
  private rotateIfNeeded(incoming: number): void {
    if (this.maxBytes <= 0) return
    let size = 0
    try {
      size = statSync(this.path).size
    } catch (e) {
      log.debug("jsonl event sink stat failed; nothing to rotate", { err: e })
      return // no file yet: nothing to rotate
    }
    if (size + incoming <= this.maxBytes) return
    const rotated = `${this.path}${JSONL_EVENT_ROTATED_SUFFIX}`
    try {
      unlinkSync(rotated)
    } catch (e) {
      // no previous rotation
      log.debug("jsonl event sink rotated-file unlink failed", { err: e })
    }
    try {
      renameSync(this.path, rotated)
    } catch (e) {
      // if the rename fails the append still lands; growth stays bounded by size check
      log.debug("jsonl event sink rotate rename failed", { err: e })
    }
  }
}

/** Options for building a sink outside a config file (the daemon's boot). */
export interface CreateEventSinkOptions {
  /** Machine/installation id stamped on v1 records (`"jsonl"`). */
  instanceId?: string
  /** Data dir used for the default `events.jsonl` path (`"jsonl"`). */
  dataDir?: string
}

/** Build the built-in sink for `config`. Unknown/invalid kinds are a no-op. */
export function createEventSink(config: EventSinkConfig, opts: CreateEventSinkOptions = {}): EventSink {
  if (config.kind === "uds" && typeof config.path === "string" && config.path.length > 0) {
    return new UdsEventSink(config.path)
  }
  if (config.kind === "jsonl") {
    const path = typeof config.path === "string" && config.path.trim().length > 0 ? config.path.trim() : eventsPath(opts.dataDir)
    return new JsonlEventSink({ path, instanceId: opts.instanceId ?? "" })
  }
  return new NoopEventSink()
}

// ---- Approval policy --------------------------------------------------------

/** The per-call facts a policy sees. `decision` is what the built-in path
 * (mode/tool baseline + `permission` rules + the memory write gate) produced. */
export interface ApprovalPolicyContext {
  tool: string
  args: Record<string, unknown>
  decision: ApprovalDecision
  mode: ApprovalMode
  session: string
  agent: string
  cwd: string | null
  shell: string
}

/** What a policy may decide. `null`/an invalid answer defers to the built-in
 * decision. A `deny` is terminal (never execute, no card); `ask` forces a card;
 * `allow` skips the gate — EXCEPT the destructive floor, which no policy may
 * waive (same invariant as a `permission` allow). */
export type ApprovalPolicyDecision =
  | { action: "allow" }
  | { action: "ask" }
  | { action: "deny"; reason?: string }

export interface ApprovalPolicy {
  /**
   * Decide one tool call. MUST be synchronous and prompt, MUST NOT throw, and
   * MUST NOT perform unbounded I/O — it runs on the tool path. Return `null` to
   * defer to the built-in approval modes.
   */
  decide(ctx: ApprovalPolicyContext): ApprovalPolicyDecision | null
}

export type ApprovalPolicyFactory = (config: ApprovalPolicyConfig) => ApprovalPolicy | null

/**
 * The shipped policy resolver: only `"default"` is known, and it means "the
 * built-in modes decide" (no policy). A host may pass its own
 * `ApprovalPolicyFactory` to `ChatHost` for other kinds (docs/extensions.md).
 */
export function createApprovalPolicy(_config: ApprovalPolicyConfig): ApprovalPolicy | null {
  return null
}

/**
 * Consult a policy without ever throwing. A `null`, malformed, or throwing
 * answer defers to the built-in decision (never a hung call, never an
 * exception into the tool path).
 */
export function consultApprovalPolicy(
  policy: ApprovalPolicy,
  ctx: ApprovalPolicyContext,
): ApprovalPolicyDecision | null {
  try {
    const decision = policy.decide(ctx)
    if (decision === null || typeof decision !== "object") return null
    if (decision.action === "allow" || decision.action === "ask" || decision.action === "deny") return decision
    return null
  } catch (e) {
    log.debug("approval policy decide threw; deferring to built-in", { err: e })
    return null
  }
}
