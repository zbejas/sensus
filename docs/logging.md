# Structured Logging

## Overview

Sensus emits **structured logs**: one compact JSON envelope per line ("NDJSON") written
through `src/core/log.ts`, the headless core, and read back by `sensus daemon logs`. The
durable form is always pure JSON (never ANSI); the pretty console form is rendering only.
The module never throws and never crashes its writer — logging is observability, not
control flow. This doc owns the envelope, levels, redaction, correlation, rotation, the
reader API, the CLI, and the two log env vars.

## Key files

| File | Purpose |
|---|---|
| `src/core/log.ts` | The whole logging core: `LogRecord` envelope, `createLogger`/`getLogger`/`configureLogger`, levels + severity numbers, redaction, error serialization, rotation, the pretty console renderer, `parseLogLine`/`readLogFile`, `withCorrelation`, `flushLoggerSync` |
| `src/agent/log.ts` | `componentLogger(component)` — an agent-side lazy child logger (resolves `getLogger()` per emit so a boot-time `configureLogger` applies) |
| `src/daemon/log.ts` | The daemon-side twin of `src/agent/log.ts` (same lazy-resolution contract) |
| `src/daemon/logStrict.ts` | `logStrictEnabled` — the `SENSUS_LOG_STRICT=1` gate for the allow-listed daemon rethrow sites |
| `src/daemon/paths.ts` | `daemonLogJsonlPath` (`daemon-log.jsonl`, the structured file) vs `daemonLogPath` (`daemon.log`, the raw stdio banner) |
| `src/daemon/serve.ts` | Boot: `configureLogger` with the runtime-dir path, `SENSUS_LOG_LEVEL`, the instance id, and the bearer token as a literal redaction value |
| `src/daemon/cli.ts` | `sensus daemon logs` — the reader CLI (pretty/raw, filters, follow) |
| `tests/unit/core/log.test.ts` | The core unit suite (envelope, redaction, rotation, read-back) |
| `tests/unit/daemon/logging.test.ts` | Boot wiring + the `SENSUS_LOG_STRICT` gate |
| `tests/unit/daemon/logsCli.test.ts` | The `sensus daemon logs` CLI behavior |

## How it works

### The envelope

Each line is one `LogRecord` (`src/core/log.ts`):

```json
{"ts":1759100000000,"level":"info","severityNumber":9,"msg":"shell spawned",
 "component":"daemon.shells","instanceId":"01J8...","corrId":"...","session":"ses_ab12",
 "attributes":{"pid":1234},"err":{"type":"Error","message":"boom","stack":"..."}}
```

| Field | Meaning |
|---|---|
| `ts` | Epoch milliseconds (`Date.now()`; injectable via `createLogger({ now })` in tests) |
| `level` | One of `trace`/`debug`/`info`/`warn`/`error` |
| `severityNumber` | OTel-aligned number: trace `1`, debug `5`, info `9`, warn `13`, error `17` |
| `msg` | The human message (redaction applied) |
| `component` | Dotted logger name (e.g. `daemon.ws`, `agent.provider`) |
| `instanceId` | The machine identity from `instance.json` (see [`events.md`](events.md)) |
| `corrId` | Correlation id — an explicit binding or the active `withCorrelation` scope |
| `session` | The chat session id, when bound |
| `attributes` | All caller fields, under ONE reserved key so envelope keys cannot be overwritten |
| `err` | A thrown value serialized to `SerializedError` (`type`/`message`/`stack`/`code`, capped `cause`/`errors`) |

Arbitrary caller fields never collide with the envelope: they are funnelled under
`attributes`. `err` is reserved — passing `{ err }` pulls it out of `attributes` and
serializes it into the `err` field.

### Levels + gating

`LOG_LEVELS` is `["trace","debug","info","warn","error"]` and gating compares indices: a
logger at a minimum level drops every record below it. `severityNumber(level)` maps to the
OTel numbers above (unknown level falls back to `info`).

### Redaction

Redaction happens on **live values before serialization** (never post-stringify):

- Keys matching `SENSITIVE_KEYS` (`authorization`, `token`, `apikey`, `api_key`, `secret`,
  `password`, `passwd`, `cookie`, case-insensitive) have their value replaced with
  `[redacted]`.
- String values are scanned for `Bearer …`, 64-hex, `sk-…`, and `ghp_…` patterns.
- Extra literal values can be passed via `createLogger({ redact: [...] })`; the daemon uses
  this for the boot bearer token so it can never appear in a record.
- Serialization is depth/cycle-safe (depth cap 8, cycles → `{"$truncated":true}`).

### Correlation

`withCorrelation(corrId, fn)` runs `fn` inside an `AsyncLocalStorage` scope; every logger
inside that scope (including async continuations) stamps the `corrId` unless a logger
binding overrides it. The daemon wraps REST requests for exactly this. When neither binding
nor scope is present, `corrId` is omitted.

### Writing + rotation

- A logger with a `path` appends to `<path>`. Writes are queued and flushed on a
  `setImmediate`; the backlog is bounded (`LOG_QUEUE_MAX`, drop-oldest).
- The file is rotated in one generation when the incoming batch would cross
  `LOG_MAX_BYTES` (5 MiB): `<path>` → `<path>.1` (the previous `.1` is unlinked first).
  A logger with no path writes to stderr.
- A line over `LOG_LINE_MAX_BYTES` (64 KiB) is truncated with an
  `,"attributes":{"$truncated":true}}` marker, cut at a UTF-8 boundary.
- `flushLoggerSync()` drains the process-wide queue synchronously (daemon shutdown).
- **No public method or the write path throws** (AGENTS.md rule 10): a failed write drops the
  batch; serialization of circular/weird values cannot throw.

### The reader API

`parseLogLine(line): LogRecord | null` parses one line; blank/garbage lines (including a
truncated trailing line) return `null`. `readLogFile(path): LogRecord[]` reads a whole file
and skips unparseable lines; a missing/unreadable file returns `[]`. The console pretty
renderer (`prettyLine`) is **internal** — the CLI reimplements the small rendering it needs
so the frozen core stays untouched.

### The CLI — `sensus daemon logs`

Reads the STRUCTURED log `daemon-log.jsonl` in the runtime dir (NOT the raw `daemon.log`
banner; see [`daemon-api.md`](daemon-api.md)). Pretty on a TTY, raw NDJSON when piped, so
`sensus daemon logs | jq` works.

| Flag | Behavior |
|---|---|
| `--json` | Force raw NDJSON (one unchanged JSON record per line) |
| `--pretty` | Force pretty lines (`HH:MM:SS.mmm  LEVEL  component  msg  {attributes}`) |
| `--level <lvl>` | Minimum level filter: `trace|debug|info|warn|error` |
| `--component <s>` | Exact component match, or a trailing-`*` prefix (`daemon*`) |
| `--follow`, `-f` | Keep printing appended records until Ctrl+C |

- **Pretty vs raw** is decided by the color precedence `--pretty`/`--json` > `NO_COLOR` >
  `FORCE_COLOR` > `TERM=dumb` > stdout-is-a-TTY. If both `--json` and `--pretty` are given,
  the last one wins.
- Pretty lines color by level with standard ANSI (error red, warn yellow, info green,
  debug/trace dim), dim the `corrId`/`session`, and append the error message + first stack
  line. `--pretty` still renders readable lines when `NO_COLOR` strips the ANSI.
- Filters apply to **both** pretty and raw output.
- `--follow` with plain raw output and no filters may use `tail -f`; the pretty/filtered
  path uses a built-in ~200 ms polling tail (rendering and filtering cannot go through
  `tail`), stopping cleanly on SIGINT.
- Missing structured file: prints `(no daemon log yet — <path>)`, and if a raw `daemon.log`
  exists, says so (it is the banner, not the structured log).

### Env vars

| Var | Default | Effect |
|---|---|---|
| `SENSUS_LOG_LEVEL` | `info` | Minimum emitted level (`trace|debug|info|warn|error`; invalid → `info`) |
| `SENSUS_LOG_STRICT` | off | When `1`, an allow-listed set of daemon catch sites rethrows after logging instead of swallowing; every other catch still swallows (rule 10) |

## Gotchas & invariants

- **The file is pure JSON, never ANSI.** The pretty path is console-only. Do not add color
  to the serialized line.
- **Redaction is pre-serialization on live values.** Adding post-`JSON.stringify` scrubbing
  is wrong and will miss structured fields.
- **`componentLogger` resolves `getLogger()` per emit, on purpose.** A child captured once at
  module load would freeze the pre-`configureLogger` (stderr) handle, because `serve.ts`
  configures the file logger only inside `startDaemon`, after every daemon module imported.
- **Two different files.** `daemon-log.jsonl` is the structured log; `daemon.log` is the
  detached process's raw stdio banner. `daemonLogJsonlPath` vs `daemonLogPath`.
- **The pretty renderer in `core/log.ts` is not exported.** The CLI owns its own small copy;
  keep the ANSI palette identical when either changes.
- **The daemon never writes the structured log through `src/ui/**`.** `core/log.ts` imports
  only `node:*` and `core/util.ts`, so it is daemon/engine-safe.

## Related docs

- [`operations.md`](operations.md) — the daemon CLI + the `sensus daemon logs` row
- [`daemon-api.md`](daemon-api.md) — where the daemon writes its structured log; boot wiring
- [`events.md`](events.md) — the instance id stamped as `instanceId`
- [`architecture.md`](architecture.md) — the module map (`src/core/log.ts`, `agent/log.ts`, `daemon/log.ts`)
- [`agent.md`](agent.md) — agent-side components that log
