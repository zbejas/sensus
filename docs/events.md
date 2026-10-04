# Events & Identity

User guide: https://sensus.sh/docs/privacy/

## Overview

Sensus keeps a **durable local record of what it did** and a **stable machine
identity**, both owned by the `sensus daemon` (D13) and both entirely local:
there is **no telemetry and no egress** (D8). Two artifacts make up this
monitoring seam:

- **`~/.config/sensus/instance.json`** — the installation identity
  (`instanceId`, `createdAt`, `version`). Generated once at first daemon boot
  and **stable across restarts and upgrades**.
- **`~/.local/share/sensus/events.jsonl`** — the **event schema v1** log
  (newline-delimited JSON, one `EventV1` per line), written by the built-in
  JSONL `EventSink`.

A user (or a future opt-in control plane) reads them with
`sensus events tail` ([`operations.md`](operations.md)) / any NDJSON reader; the engine
emits through the same public seam the daemon already consumes
([`extensions.md`](extensions.md)).

The same v1 stream drives **local condition triggers** ([`triggers.md`](triggers.md)):
an opt-in rule list that records matched events to `triggers.jsonl` and broadcasts
a `trigger` WS event. Triggers never forward anywhere — like the log, they are
local-only (D8).

## Key files

| File | Purpose |
|---|---|
| `src/config/config/instance.ts` | `SensusInstance` + `generateInstanceId` (ULID-like) + `readInstance`/`loadOrCreateInstance` (create/refresh/repair) |
| `src/config/config/paths.ts` | `instancePath(home)`, `eventsPath(dataDir)` — the canonical locations |
| `src/agent/extensions.ts` | The v1 schema (`EventV1`), the pure `toEventV1` projection, and `JsonlEventSink` (bounded queue + cap/rotate) |
| `src/agent/chat/chatSession.ts` | Emission points: `addError`, turn settle, file writes, `skill_view`; `endSession` |
| `src/agent/chat/chatHost.ts` | `session-start` on tab create, `endTabChat` on release |
| `src/daemon/serve.ts` | Builds `instance.json` at boot, defaults the daemon to the JSONL sink, exposes the identity on `GET /v1/info`, flushes on `stop()` |
| `src/daemon/chats.ts` | `ChatRegistry.drop` → `session.ended` (the daemon owns chat lifetime) |
| `src/cli.ts` | `sensus events tail` (headless; `--follow`, `--type`, `--since`) |

## How it works

### Instance identity (`instance.json`)

```json
{
  "instanceId": "01J8Z6M6Y3Q7V9K2N4P6R8T0W2",
  "createdAt": 1759100000000,
  "version": "<sensus-version>"
}
```

- `instanceId` is a **ULID-like** id — 10 Crockford-base32 chars of 48-bit
  millisecond time + 16 chars (80 bits) of crypto randomness, 26 chars total.
  It sorts by creation time and is collision-resistant.
- `createdAt` is the epoch ms of the **first** creation. It never changes.
- `version` is the sensus version that last wrote the file.

`loadOrCreateInstance(home, version)` is the whole contract:

| On disk | Result |
|---|---|
| valid, same `version` | returned verbatim |
| valid, older/newer `version` | same `instanceId` + `createdAt`, `version` refreshed (an upgrade) |
| missing / not JSON / bad shape | a **new** identity is generated and written (repair) |
| unwritable home | the in-memory identity is returned; boot still succeeds |

The file is written atomically (`atomicWriteText`, one-time `.bak`) and the
helper never throws.

### Event schema v1 (frozen, `"v": 1`)

Every line of `events.jsonl` is one JSON object. The **common envelope** is:

```jsonc
{
  "v": 1,               // schema version (frozen at 1)
  "ts": 1759100000123,  // epoch millis
  "instanceId": "01J8Z…", // the machine identity from instance.json
  "session": "<id>",    // the chat session the event belongs to
  "type": "…"           // one of the eight types below
}
```

The eight types and their type-specific fields:

| `type` | Extra fields |
|---|---|
| `session.started` | `agent`, `approval`, `shell`, `model`, `resumed` |
| `session.ended` | `reason` |
| `turn.completed` | `durationMs`, `outcome` (`"ok"`/`"aborted"`/`"error"`), `model` |
| `tool.executed` | `tool`, `command`, `ok`, `exitCode?`, `approval`, `agent`, `cwd`, `shell` |
| `file.changed` | `tool`, `path`, `action` (`"write"`/`"edit"`), `ok` |
| `memory.written` | `target`, `action`, `beforeChars`, `afterChars`, `delta`, `ok` |
| `skill.used` | `name`, `source` |
| `error.raised` | `source`, `message`, `tool?` |

The schema is projected from the engine's seam events by the pure
`toEventV1(event, instanceId)`:

| Seam event | v1 type |
|---|---|
| `session-start` (`ChatHost.createTabChat`) | `session.started` |
| `session-end` (`ChatHost.endTabChat`) | `session.ended` |
| `turn-complete` (end of an agent turn) | `turn.completed` |
| `command-ran` (a tool executed) | `tool.executed` |
| `file-change` (`write_file`/`edit_file` committed) | `file.changed` |
| `memory-write` | `memory.written` |
| `skill-use` (`skill_view` loaded a body) | `skill.used` |
| `error-raised` (a surfaced provider/engine/tool error) | `error.raised` |
| `command-approved` / `command-denied` | — no v1 counterpart (dropped) |

Emission points are the real engine ones: a turn's `turn.completed` fires when
the generation settles (status returns to idle), `tool.executed` from
`runToolCall`, `file.changed` from the file-write branch, `skill.used` from a
successful `skill_view`, `error.raised` from `addError` (provider / compaction /
engine) and from a genuine tool failure (not a shell command's non-zero exit),
`memory.written` from the memory tool (and the daemon memory resource), and
`session.ended` when the daemon releases a chat (`ChatRegistry.drop`, i.e.
`daemon stop`; a chat survives client detach, D4).

Fields are capped at `EVENT_FIELD_MAX` (4096 chars) so one record can never
grow the log unbounded.

### The JSONL sink (`JsonlEventSink`)

The sink is a built-in `EventSink`, selected by config
(`extensions.eventSink.kind: "jsonl"`) or, on the daemon, used **by default**
(the daemon owns the log, D13 — the engine `"noop"` default means "the
daemon's JSONL log", and `"uds"` still selects the local-socket stream):

- `emit` is **fire-and-forget and never throws**: the line goes into a bounded
  in-memory queue (`JSONL_EVENT_QUEUE_MAX`, default 1000, **drop-oldest**) and
  is flushed on a `setImmediate`, so no tool call ever blocks on disk.
- **Bounded growth:** before each flush the file is rotated when it would
  exceed `JSONL_EVENT_MAX_BYTES` (5 MiB): `events.jsonl` → `events.jsonl.1`
  (the previous `.1` is replaced). One retained generation bounds the log at
  ~2× the cap.
- `flushSync()` drains the queue synchronously; the daemon calls it in
  `stop()` so no buffered event is lost on teardown.
- The sink writes **only** to the local file — no socket, no network, ever.

### Reading it: `sensus events tail`

```
sensus events tail                     # print the whole log
sensus events tail --follow            # then tail appended lines
sensus events tail --type tool.executed,error.raised
sensus events tail --since 1759100000000   # or an ISO date
```

It is headless (never boots the TUI, works inside a sensus pane), prints the
raw NDJSON lines (pipe to `jq`), and reads the log path from the data dir
(`SENSUS_HOME` redirects it). With no filter, every line is printed; with a
filter, an unparseable line never matches.

### No egress (D8)

`SENSUS_CONTROL_URL` is not referenced anywhere in `src/**`: there is **no
forwarding path to construct** in v1. `tests/unit/engine/noEgress.test.ts`
proves both halves — no source file references the variable, and a full offline
headless turn (plus the sink) calls neither `fetch` nor `Bun.connect`. No
telemetry, no licence check, no outbound call.

## Gotchas & invariants

- **Never regenerate a valid identity.** A restart or upgrade must reuse
  `instanceId`/`createdAt`; only a corrupt/missing file is repaired.
- **Instance vs session.** `instanceId` is the machine identity; `session` is
  the chat session (the engine host's instance id — one per daemon run, shared
  by its tabs). Do not conflate them.
- **The event log is audit, not a transaction log.** Like the UDS sink it is
  fire-and-forget and may drop under load; a receiver/disk outage must never
  block or slow a turn.
- **`command-approved`/`command-denied` have no v1 record.** The eight v1 types
  are the frozen monitoring contract; the raw seam events stay available
  through the `uds` sink and the `/v1/audit` resource.
- **The daemon owns both artifacts** (D13). The TUI is a client and never
  writes them; only `stop()`/idle-exit flushes the log.
- **Bounded by construction.** Queue (`JSONL_EVENT_QUEUE_MAX`), per-field cap
  (`EVENT_FIELD_MAX`), and rotation (`JSONL_EVENT_MAX_BYTES` → `events.jsonl.1`)
  are the caps; changing any is a schema/behavior change that updates this doc.

## Related docs

- [`extensions.md`](extensions.md) — the `EventSink`/`ApprovalPolicy` seam and the raw events
- [`triggers.md`](triggers.md) — the local condition triggers built on this stream
- [`config.md`](config.md) — the `extensions` config keys and all paths
- [`daemon-api.md`](daemon-api.md) — `GET /v1/info` (the identity) and the daemon lifecycle
- [`operations.md`](operations.md) — `sensus events tail`
- [`architecture.md`](architecture.md) — the daemon that owns the stores
