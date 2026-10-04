/**
 * Local condition triggers (P6; docs/triggers.md).
 *
 * An opt-in, entirely-local watcher over the **v1 event stream** (docs/events.md):
 * a `{ on, tool?, session? }` rule list matches an event type (plus optional
 * `tool` / `session` filters) and, on a match, appends a bounded record to
 * `<data>/triggers.jsonl` and hands it to a callback (the daemon broadcasts a
 * `trigger` WS event). There is **no egress** (D8): a trigger only ever writes
 * to a local file and fans out to already-attached local clients.
 *
 * `createTriggerSink` decorates the daemon's real `EventSink` (the
 * `JsonlEventSink`) so the trigger engine sees the same events that reach the
 * durable event log — it never becomes a second source of truth.
 *
 * The writer mirrors `JsonlEventSink`: a bounded in-memory queue (drop-oldest)
 * flushed on a `setImmediate`, one-generation rotation at a byte cap, and a
 * never-throw / never-block contract (a trigger must not break the action it
 * records).
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "../core/log.ts"
import { componentLogger } from "./log.ts"
import {
  toEventV1,
  type EventSink,
  type EventV1,
  type EventV1Type,
  type SensusEvent,
  type TriggerConfig,
} from "../engine/index.ts"

/** Module-level child logger for the trigger engine (component `daemon.triggers`). */
const log: Logger = componentLogger("daemon.triggers")

/** The frozen trigger-log schema version (bump only with a migration). */
export const TRIGGER_SCHEMA_VERSION = 1 as const

/** Hard byte cap of `triggers.jsonl` before it rotates to `triggers.jsonl.1`. */
export const TRIGGER_LOG_MAX_BYTES = 5 * 1024 * 1024
/** Suffix of the single retained rotated trigger file. */
export const TRIGGER_ROTATED_SUFFIX = ".1"
/** Bounded in-memory backlog; the oldest line is dropped past this. */
export const TRIGGER_QUEUE_MAX = 1000

/** v1 types that carry a `tool` field, so a rule's `tool` filter can match. */
export const TOOL_EVENT_TYPES: readonly EventV1Type[] = ["tool.executed", "file.changed", "error.raised"]

const encoder = new TextEncoder()

/** UTF-8 byte length (the rotation cap is bytes, not chars). */
function byteLength(s: string): number {
  return encoder.encode(s).length
}

/** One matched trigger: the rule index/`on` plus the full v1 event that fired it. */
export interface TriggerRecord {
  /** Schema version (always `1` in this build). */
  v: typeof TRIGGER_SCHEMA_VERSION
  /** Epoch millis of the matched event. */
  ts: number
  /** Index of the matching rule in the `triggers` config list. */
  rule: number
  /** The matching rule's `on` value. */
  on: EventV1Type | "*"
  /** The matched v1 event, verbatim. */
  event: EventV1
}

/** The `tool` a v1 event carries, or null (only the tool-bearing types do). */
function toolOf(event: EventV1): string | null {
  if (event.type === "tool.executed" || event.type === "file.changed") return event.tool
  if (event.type === "error.raised") return event.tool ?? null
  return null
}

/**
 * Does one rule match one v1 event? `on` is the event type (or `"*"` for any);
 * `tool`/`session` are optional exact-match filters. Pure.
 */
export function matchRule(rule: TriggerConfig, event: EventV1): boolean {
  if (rule.on !== "*" && rule.on !== event.type) return false
  if (rule.tool !== undefined && toolOf(event) !== rule.tool) return false
  if (rule.session !== undefined && event.session !== rule.session) return false
  return true
}

/** Index of the FIRST matching rule (the first match wins), or -1. Pure. */
export function matchTrigger(rules: readonly TriggerConfig[], event: EventV1): number {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (rule !== undefined && matchRule(rule, event)) return i
  }
  return -1
}

export interface TriggerEngineOptions {
  /** The `triggers` config rules; empty = the engine is a no-op. */
  rules: readonly TriggerConfig[]
  /** Absolute path to the NDJSON trigger log. */
  path: string
  /** Called synchronously for each matched event (the daemon broadcasts here). */
  onMatch?: (record: TriggerRecord) => void
  /** Byte cap before rotation; `0` disables rotation. Default `TRIGGER_LOG_MAX_BYTES`. */
  maxBytes?: number
  /** Bounded backlog; default `TRIGGER_QUEUE_MAX`. */
  queueMax?: number
}

/**
 * Watch the v1 stream and record matches. `handle` is synchronous,
 * fire-and-forget, and never throws; the log write is deferred to a
 * `setImmediate` (drop-oldest queue), so no tool call ever blocks on disk.
 */
export class TriggerEngine {
  private rules: readonly TriggerConfig[]
  private readonly path: string
  private readonly onMatch: ((record: TriggerRecord) => void) | undefined
  private readonly maxBytes: number
  private readonly queueMax: number
  private readonly queue: string[] = []
  private flushing = false

  constructor(opts: TriggerEngineOptions) {
    this.rules = opts.rules
    this.path = opts.path
    this.onMatch = opts.onMatch
    this.maxBytes = opts.maxBytes !== undefined && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : TRIGGER_LOG_MAX_BYTES
    this.queueMax = opts.queueMax !== undefined && opts.queueMax > 0 ? Math.floor(opts.queueMax) : TRIGGER_QUEUE_MAX
  }

  /** Replace the rule list (a config reload); existing buffered records are kept. */
  setRules(rules: readonly TriggerConfig[]): void {
    this.rules = rules
  }

  /**
   * Offer one v1 event; returns the record when a rule matched (and appends it
   * to the log + calls `onMatch`). Never throws.
   */
  handle(event: EventV1): TriggerRecord | null {
    try {
      const rule = matchTrigger(this.rules, event)
      if (rule < 0) return null
      const config = this.rules[rule]
      if (config === undefined) return null
      const record: TriggerRecord = {
        v: TRIGGER_SCHEMA_VERSION,
        ts: event.ts,
        rule,
        on: config.on,
        event,
      }
      try {
        this.queue.push(`${JSON.stringify(record)}\n`)
        if (this.queue.length > this.queueMax) this.queue.shift()
        this.schedule()
      } catch (err) {
        // the log must never break the action it records
        log.warn("trigger record enqueue failed", { err, rule })
      }
      try {
        this.onMatch?.(record)
      } catch (err) {
        // a broadcast failure must never break the engine
        log.warn("trigger onMatch callback failed", { err, rule })
      }
      return record
    } catch (err) {
      log.debug("trigger handle failed", { err })
      return null
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
    } catch (err) {
      // drop the batch: the log must never break its writer
      log.error("trigger log flush write failed", { err, path: this.path })
    }
  }

  private schedule(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      setImmediate(() => this.drain())
    } catch (err) {
      this.flushing = false
      log.debug("trigger flush schedule failed", { err })
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
      // no file yet: nothing to rotate
      log.debug("trigger log stat failed; nothing to rotate", { err: e, path: this.path })
      return
    }
    if (size + incoming <= this.maxBytes) return
    const rotated = `${this.path}${TRIGGER_ROTATED_SUFFIX}`
    try {
      unlinkSync(rotated)
    } catch (e) {
      // no previous rotation
      log.debug("no previous trigger rotation to unlink", { err: e, rotated })
    }
    try {
      renameSync(this.path, rotated)
    } catch (e) {
      // if the rename fails the append still lands; growth stays bounded by the size check
      log.debug("trigger log rotation rename failed", { err: e, path: this.path, rotated })
    }
  }
}

/** An `EventSink` that also exposes the daemon's synchronous shutdown drain. */
export interface FlushableEventSink extends EventSink {
  flushSync(): void
}

/**
 * Decorate the daemon's real event sink so the trigger engine sees the same
 * seam events the durable v1 log does. The wrapper preserves the sink's
 * never-throw contract and flushes both halves on shutdown.
 */
export function createTriggerSink(inner: EventSink, engine: TriggerEngine, instanceId: string): FlushableEventSink {
  return {
    emit(event: SensusEvent): void {
      try {
        inner.emit(event)
      } catch (err) {
        // the inner sink is contractually non-throwing, but be defensive
        log.error("inner event sink emit failed", { err })
      }
      try {
        const v1 = toEventV1(event, instanceId)
        if (v1 !== null) engine.handle(v1)
      } catch (err) {
        // a trigger must never break the action it records
        log.error("trigger engine handle failed", { err })
      }
    },
    flushSync(): void {
      try {
        ;(inner as Partial<FlushableEventSink>).flushSync?.()
      } catch (err) {
        // best-effort
        log.error("inner event sink flush failed", { err })
      }
      try {
        engine.flushSync()
      } catch (err) {
        // best-effort
        log.error("trigger engine flush failed", { err })
      }
    },
  }
}
