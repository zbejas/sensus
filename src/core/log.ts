/**
 * Structured logging (NDJSON envelope + pretty TTY console) — headless core.
 *
 * One compact JSON object per line is the durable form:
 *
 *   {"ts":1759100000000,"level":"info","severityNumber":9,"msg":"shell spawned",
 *    "component":"daemon.shell","instanceId":"01J8...","corrId":"...","session":"ses_ab12",
 *    "attributes":{"pid":1234},"err":{"type":"Error","message":"boom","stack":"..."}}
 *
 * Design contract (mirrors `src/agent/extensions.ts` `JsonlEventSink`):
 *   - NEVER throws (AGENTS.md rule 10): every public method and the write path is
 *     wrapped; a failed write drops the batch (or, with no file, falls back to
 *     stderr). Serialization of circular/weird values can't throw.
 *   - The FILE is pure JSON, never ANSI. The pretty path is console-only.
 *   - Redaction happens on LIVE values before serialization, never post-stringify.
 *   - Arbitrary caller fields live under one `attributes` object so reserved
 *     envelope keys can't be overwritten.
 *   - Bounded write queue (drop-oldest) flushed on a `setImmediate`, with a
 *     synchronous `flushLoggerSync()` for daemon shutdown.
 *
 * This module imports only `node:*` builtins + `src/core/util.ts`, so it is safe
 * for the daemon/engine (no `@opentui/core`, no `src/ui/**`).
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { errorMessage, isRecord } from "./util.ts"

// ---- Level -------------------------------------------------------------------

/** The five log levels, low → high. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error"

/** The levels in ascending severity order (gating compares indices). */
export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"]

/** OTel-aligned severity numbers: trace=1, debug=5, info=9, warn=13, error=17. */
const SEVERITY_NUMBERS: Readonly<Record<LogLevel, number>> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
}

/** OTel severity number for a level. */
export function severityNumber(level: LogLevel): number {
  return SEVERITY_NUMBERS[level] ?? SEVERITY_NUMBERS.info
}

// ---- Record shape ------------------------------------------------------------

/** A thrown value serialized to a plain, JSON-safe shape (capped cause chain). */
export interface SerializedError {
  type: string
  message: string
  stack?: string
  code?: string | number
  cause?: SerializedError
  errors?: SerializedError[]
}

/** The durable envelope written to the NDJSON file. */
export interface LogRecord {
  ts: number
  level: LogLevel
  severityNumber: number
  msg: string
  component?: string
  instanceId?: string
  corrId?: string
  session?: string
  attributes?: Record<string, unknown>
  err?: SerializedError
}

// ---- Constants ---------------------------------------------------------------

/** Rotation cap (bytes) before `<path>.1` takes over. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024
/** Suffix of the single retained rotated generation. */
export const LOG_ROTATED_SUFFIX = ".1"
/** Bounded write backlog (drop-oldest past this). */
export const LOG_QUEUE_MAX = 1000
/** Hard per-line byte cap; an over-long line is truncated with a marker. */
export const LOG_LINE_MAX_BYTES = 64 * 1024
/** Cause-chain / redaction-walk depth cap. */
const MAX_DEPTH = 8
/** Marker inserted where a value was dropped (overflow / too deep). */
const TRUNCATED = { $truncated: true } as const

// ---- Error serialization -----------------------------------------------------

/** Serialize an arbitrary thrown value (Error, AggregateError, string, …). */
export function serializeError(e: unknown, depth = 0): SerializedError {
  try {
    const capped = depth >= MAX_DEPTH
    if (e instanceof Error) {
      const out: SerializedError = { type: e.name || "Error", message: redactSubstring(e.message) }
      if (typeof e.stack === "string") out.stack = redactSubstring(e.stack)
      const code = (e as Error & { code?: unknown }).code
      if (typeof code === "string" || typeof code === "number") out.code = code
      if (capped) return out
      if (e instanceof AggregateError) {
        const errs: SerializedError[] = []
        for (const inner of e.errors) errs.push(serializeError(inner, depth + 1))
        if (errs.length > 0) out.errors = errs
      }
      if (e.cause !== undefined) out.cause = serializeError(e.cause, depth + 1)
      return out
    }
    if (isRecord(e)) {
      const out: SerializedError = { type: "Object", message: redactSubstring(safeString(e)) }
      const code = e["code"]
      if (typeof code === "string" || typeof code === "number") out.code = code
      return out
    }
    return { type: typeof e, message: redactSubstring(String(e)) }
  } catch (err) {
    return { type: "Error", message: errorMessage(err) }
  }
}

/** JSON-ish string of a record for a non-Error throw, itself guarded. */
function safeString(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// ---- Redaction ---------------------------------------------------------------

/** Keys whose VALUE is always replaced, case-insensitively. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "passwd",
  "cookie",
])

/** Substrings scanned + scrubbed inside string values. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]{6,}=*/g,
  /\b[0-9a-f]{64}\b/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
]

const REDACTED = "[redacted]"

/** Full redactor: key match, substring scan, then literal secrets. */
function redactValue(v: unknown, extra: readonly string[], depth = 0): unknown {
  if (typeof v === "string") return redactString(v, extra)
  if (v === null || typeof v !== "object") return v
  if (depth >= MAX_DEPTH) return TRUNCATED
  if (Array.isArray(v)) return v.map((item) => redactValue(item, extra, depth + 1))
  if (v instanceof Error) return redactString(String(v.stack ?? v.message), extra)
  if (v instanceof Date) return v.toISOString()
  if (isRecord(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redactValue(val, extra, depth + 1)
    }
    return out
  }
  return v
}

function applyLiterals(s: string, extra: readonly string[]): string {
  let out = s
  for (const lit of extra) {
    if (lit.length > 0) out = out.split(lit).join(REDACTED)
  }
  return out
}

/** Replace only the matched substring so surrounding text survives. */
function redactSubstring(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

function redactString(s: string, extra: readonly string[]): string {
  return applyLiterals(redactSubstring(s), extra)
}

// ---- Line serialization ------------------------------------------------------

const encoder = new TextEncoder()

/** UTF-8 byte length of a string (caps are bytes, not chars). */
function byteLength(s: string): number {
  return encoder.encode(s).length
}

/** Depth/cycle-safe JSON replacer shared by records + attributes. */
function makeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "function" || typeof value === "symbol") return undefined
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return TRUNCATED
      seen.add(value)
    }
    return value
  }
}

/** Build the readable envelope from a record + bindings (redaction applied). */
function toWire(
  bindings: Partial<LogRecord>,
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> | undefined,
  now: () => number,
  extraSecrets: readonly string[],
): LogRecord {
  const wire: LogRecord = { ts: now(), level, severityNumber: severityNumber(level), msg: redactSubstring(msg) }
  if (typeof bindings.component === "string" && bindings.component.length > 0) wire.component = bindings.component
  if (typeof bindings.instanceId === "string" && bindings.instanceId.length > 0) wire.instanceId = bindings.instanceId
  const corrId = typeof bindings.corrId === "string" && bindings.corrId.length > 0 ? bindings.corrId : correlationStore.getStore()
  if (corrId !== undefined && corrId.length > 0) wire.corrId = corrId
  if (typeof bindings.session === "string" && bindings.session.length > 0) wire.session = bindings.session
  if (fields !== undefined && Object.keys(fields).length > 0) {
    const errField = fields["err"]
    // `err` is reserved: pull it out of attributes and serialize it, and leave
    // the rest of the caller fields under `attributes`.
    const attrs: Record<string, unknown> = { ...fields }
    if (errField !== undefined) delete attrs["err"]
    if (Object.keys(attrs).length > 0) wire.attributes = redactValue(attrs, extraSecrets) as Record<string, unknown>
    if (errField !== undefined) wire.err = serializeError(errField)
  }
  return wire
}

/** Serialize a wire record to one compact JSON line, truncated past the byte cap. */
function serializeLine(wire: LogRecord): string {
  let line: string
  try {
    line = JSON.stringify(wire, makeReplacer())
  } catch {
    line = JSON.stringify({ ts: wire.ts, level: wire.level, severityNumber: wire.severityNumber, msg: wire.msg })
  }
  if (typeof line !== "string") line = `{"ts":${wire.ts},"level":"${wire.level}","severityNumber":${wire.severityNumber},"msg":""}`
  if (line.includes("\n")) line = line.replace(/\n/g, "\\n")
  if (byteLength(line) > LOG_LINE_MAX_BYTES) {
    const marker = ',"attributes":{"$truncated":true}}'
    const keep = LOG_LINE_MAX_BYTES - byteLength(marker) - 1
    line = `${truncateUtf8(line, keep < 0 ? 0 : keep)}${marker}`
  }
  return line
}

/** Cut a string to at most `maxBytes` UTF-8 bytes at a codepoint boundary. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (byteLength(s) <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}

// ---- Pretty console rendering ------------------------------------------------

/** Standard per-level ANSI colors (error red, warn yellow, info green, debug/trace dim). */
const LEVEL_COLOR: Readonly<Record<LogLevel, string>> = {
  trace: "\x1b[90m",
  debug: "\x1b[90m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
}
const ANSI_RESET = "\x1b[0m"
const ANSI_DIM = "\x1b[90m"

/** Decide whether to colorize the console output. */
function detectColors(explicit: boolean | undefined, env: NodeJS.ProcessEnv, stderrTTY: boolean): boolean {
  if (explicit !== undefined) return explicit
  const noColor = env["NO_COLOR"]
  if (noColor !== undefined && noColor.length > 0) return false
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "") return true
  if (env["TERM"] === "dumb") return false
  return stderrTTY
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0")
}

/** `HH:MM:SS.mmm` in local time for a record's `ts`. */
function timestamp(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function prettyLine(wire: LogRecord, color: boolean): string {
  const time = timestamp(wire.ts)
  const level = wire.level.toUpperCase()
  const parts: string[] = []
  if (wire.component !== undefined) parts.push(wire.component)
  parts.push(wire.msg)
  if (wire.attributes !== undefined && Object.keys(wire.attributes).length > 0) {
    try {
      parts.push(JSON.stringify(wire.attributes, makeReplacer()))
    } catch {
      parts.push("{}")
    }
  }
  const body = parts.join("  ")
  if (!color) return `${time}  ${level.padEnd(5)}  ${body}`
  const c = LEVEL_COLOR[wire.level] ?? ""
  const corr = wire.corrId !== undefined ? ` ${ANSI_DIM}[${wire.corrId}]${ANSI_RESET}` : ""
  return `${ANSI_DIM}${time}${ANSI_RESET}  ${c}${level.padEnd(5)}${ANSI_RESET}  ${body}${corr}`
}

// ---- AsyncLocalStorage correlation -------------------------------------------

/** Holds the active correlation id for `withCorrelation`. */
const correlationStore = new AsyncLocalStorage<string>()

/** Run `fn` with `corrId` visible to every logger inside (async-safe). */
export function withCorrelation<T>(corrId: string, fn: () => T): T {
  return correlationStore.run(corrId, fn)
}

// ---- Logger ------------------------------------------------------------------

/** Per-level methods: `(msg, fields?)`. */
export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /** Derive a logger with extra bindings (overrides win). */
  child(bindings: Partial<Pick<LogRecord, "component" | "instanceId" | "corrId" | "session">>): Logger
}

/** Construction options for `createLogger`. */
export interface LoggerOptions {
  /** NDJSON file; `null`/undefined ⇒ stderr only. */
  path?: string | null
  /** Minimum emitted level (default `"info"`). */
  level?: LogLevel
  component?: string
  instanceId?: string
  corrId?: string
  session?: string
  /** Byte cap before rotation; default `LOG_MAX_BYTES`; `0` disables. */
  maxBytes?: number
  /** Bounded backlog; default `LOG_QUEUE_MAX`. */
  queueMax?: number
  /** Injectable clock (tests). */
  now?: () => number
  /** Extra literal secret values to scrub. */
  redact?: readonly string[]
  /** Force pretty/color on|off; undefined ⇒ auto-detect. */
  colors?: boolean
  /** Test seam: capture serialized lines instead of writing. */
  sink?: (line: string) => void
}

/** A logger plus its shutdown drain (`flushLoggerSync` façade target). */
export interface LoggerHandle {
  logger: Logger
  /** Drain the write queue synchronously. Never throws. */
  flushSync(): void
}

interface ResolvedOptions {
  path: string | null
  level: LogLevel
  component?: string
  instanceId?: string
  corrId?: string
  session?: string
  maxBytes: number
  queueMax: number
  now: () => number
  redact: readonly string[]
  colors: boolean
  sink: ((line: string) => void) | null
}

function resolveOptions(opts: LoggerOptions): ResolvedOptions {
  const path = typeof opts.path === "string" && opts.path.trim().length > 0 ? opts.path.trim() : null
  return {
    path,
    level: opts.level !== undefined && LOG_LEVELS.includes(opts.level) ? opts.level : "info",
    component: opts.component,
    instanceId: opts.instanceId,
    corrId: opts.corrId,
    session: opts.session,
    maxBytes: opts.maxBytes !== undefined && opts.maxBytes >= 0 ? Math.floor(opts.maxBytes) : LOG_MAX_BYTES,
    queueMax: opts.queueMax !== undefined && opts.queueMax > 0 ? Math.floor(opts.queueMax) : LOG_QUEUE_MAX,
    now: opts.now ?? (() => Date.now()),
    redact: opts.redact ?? [],
    colors: detectColors(opts.colors, process.env, process.stderr.isTTY === true),
    sink: opts.sink ?? null,
  }
}

/**
 * Build a logger. Returns a handle so callers can drain the file queue at
 * shutdown; a bare `Logger` (from `getLogger`) can be drained with
 * `flushLoggerSync()`.
 */
export function createLogger(opts: LoggerOptions = {}): LoggerHandle {
  const o = resolveOptions(opts)

  let queue: string[] = []
  let flushing = false
  let initialized = false

  /** Wire-level emit shared by the root logger and every `child()`, so all
   * children drain through the same queue/writer as their parent. */
  function emitWith(bindings: Partial<LogRecord>, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    try {
      if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(o.level)) return
      const text = typeof msg === "string" ? msg : String(msg)
      const wire = toWire(bindings, level, text, fields, o.now, o.redact)
      const line = serializeLine(wire)
      if (o.sink !== null) {
        o.sink(line)
        return
      }
      if (o.path !== null) {
        queue.push(`${line}\n`)
        if (queue.length > o.queueMax) queue.shift()
        schedule()
        return
      }
      const rendered = o.colors ? prettyLine(wire, true) : `${line}\n`
      process.stderr.write(`${rendered}\n`)
    } catch {
      // logging must never throw into the caller
    }
  }

  /** Ensure the parent dir exists once (best-effort; failures drop the batch). */
  function ensureDir(): void {
    if (initialized || o.path === null) return
    initialized = true
    mkdirSync(dirname(o.path), { recursive: true })
  }

  /** Rotate `<path>` → `<path>.1` when the incoming batch would exceed the cap. */
  function rotateIfNeeded(incoming: number): void {
    if (o.path === null || o.maxBytes <= 0) return
    let size = 0
    try {
      size = statSync(o.path).size
    } catch {
      return
    }
    if (size + incoming <= o.maxBytes) return
    const rotated = `${o.path}${LOG_ROTATED_SUFFIX}`
    try {
      unlinkSync(rotated)
    } catch {
      // no previous generation
    }
    try {
      renameSync(o.path, rotated)
    } catch {
      // if rename fails the append still lands; growth stays bounded by size check
    }
  }

  function writeBatch(text: string): void {
    if (o.path === null) return
    try {
      ensureDir()
      rotateIfNeeded(byteLength(text))
      appendFileSync(o.path, text)
    } catch {
      // drop the batch: the log must never break its writer
    }
  }

  function flushSync(): void {
    if (queue.length === 0) return
    const batch = queue.join("")
    queue = []
    try {
      writeBatch(batch)
    } catch {
      // drop the batch: the log must never break its writer
    }
  }

  function schedule(): void {
    if (flushing) return
    flushing = true
    try {
      setImmediate(() => {
        flushing = false
        flushSync()
        if (queue.length > 0) schedule()
      })
    } catch {
      flushing = false
    }
  }

  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    emitWith({ component: o.component, instanceId: o.instanceId, corrId: o.corrId, session: o.session }, level, msg, fields)
  }

  /** Build a logger whose emits share THIS handle's queue/writer. */
  function makeLogger(bindings: Partial<LogRecord>): Logger {
    return {
      trace: (msg, fields) => emitWith(bindings, "trace", msg, fields),
      debug: (msg, fields) => emitWith(bindings, "debug", msg, fields),
      info: (msg, fields) => emitWith(bindings, "info", msg, fields),
      warn: (msg, fields) => emitWith(bindings, "warn", msg, fields),
      error: (msg, fields) => emitWith(bindings, "error", msg, fields),
      child(extra) {
        return makeLogger({ ...bindings, ...extra })
      },
    }
  }

  const logger: Logger = makeLogger({
    component: o.component,
    instanceId: o.instanceId,
    corrId: o.corrId,
    session: o.session,
  })

  return { logger, flushSync }
}

// ---- Process-wide logger -----------------------------------------------------

/** Handle of the configured/derived process-wide logger (drained at shutdown). */
const state: { handle: LoggerHandle | null } = { handle: null }

/** Configure (and store) the process-wide default logger. */
export function configureLogger(opts: LoggerOptions): void {
  try {
    state.handle = createLogger(opts)
  } catch {
    state.handle = null
  }
}

/**
 * The process-wide default logger. Safe before `configureLogger`: an
 * unconfigured logger writes pretty JSON lines to stderr.
 */
export function getLogger(): Logger {
  if (state.handle === null) {
    try {
      state.handle = createLogger()
    } catch {
      // A logger that cannot even be constructed still must not break callers:
      // fall back to a throwaway handle over stderr.
      state.handle = createLogger({ level: "error" })
    }
  }
  return state.handle.logger
}

/** Drain the process-wide logger's write queue synchronously (daemon shutdown). */
export function flushLoggerSync(): void {
  try {
    state.handle?.flushSync()
  } catch {
    // never throws
  }
}

// ---- Reading -----------------------------------------------------------------

/** Parse one NDJSON line to a record; `null` on blank/garbage. */
export function parseLogLine(line: string): LogRecord | null {
  try {
    if (typeof line !== "string") return null
    const trimmed = line.trim()
    if (trimmed.length === 0) return null
    const parsed: unknown = JSON.parse(trimmed)
    if (!isRecord(parsed)) return null
    const level = parsed["level"]
    if (typeof level !== "string" || !LOG_LEVELS.includes(level as LogLevel)) return null
    if (typeof parsed["ts"] !== "number" || typeof parsed["msg"] !== "string") return null
    // Preserve unknown keys; the known envelope keys are validated above.
    const out = parsed as unknown as LogRecord
    out.level = level as LogLevel
    if (typeof out.severityNumber !== "number") out.severityNumber = severityNumber(out.level)
    return out
  } catch {
    return null
  }
}

/**
 * Read an NDJSON log file into records. A whole-file `readFileSync` is used
 * (this repo targets Bun; logs are rotated and size-bounded, so a full read is
 * acceptable). Blank lines and malformed/corrupt lines — including one
 * truncated trailing line — are skipped. Never throws.
 */
export function readLogFile(path: string): LogRecord[] {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const out: LogRecord[] = []
  for (const line of text.split("\n")) {
    const rec = parseLogLine(line)
    if (rec !== null) out.push(rec)
  }
  return out
}
