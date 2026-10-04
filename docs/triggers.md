# Triggers

## Overview

Condition triggers are the **opt-in, always-local** watcher over the durable
event stream ([`events.md`](events.md)): a small config list of
`{ on, tool?, session? }` rules that the `sensus daemon` evaluates against every
**event schema v1** record the engine emits. On a match the daemon appends a
record to `~/.local/share/sensus/triggers.jsonl` and broadcasts a `trigger`
event to attached WS clients.

Triggers exist to make the **persistent service** useful
([`operations.md`](operations.md) "Daemon"): with `sensus daemon install`, an
always-on daemon keeps a durable local trail of the conditions you care about
(errors, specific tools, one session) even while no TUI is attached. There is
**no egress and no telemetry** (D8): a trigger only ever writes to a local file
and fans out to already-attached local clients.

The config key is documented in [`config.md`](config.md) "triggers".

User guide: https://sensus.sh/docs/triggers/

## Key files

| File | Purpose |
|---|---|
| `src/config/config/types.ts` | `TriggerConfig` (`on` + optional `tool`/`session`) and `SensusConfig.triggers` |
| `src/config/config/resolve.ts` | Parses/validates the `triggers` section (invalid entries warn and are skipped; boot never fails) |
| `src/agent/extensions.ts` | `EVENT_V1_TYPES` (the valid `on` values) + the v1 projection the engine matches |
| `src/daemon/triggers.ts` | `matchRule`/`matchTrigger`, `TriggerEngine` (bounded `triggers.jsonl` writer), `createTriggerSink` (decorates the real sink) |
| `src/daemon/serve.ts` | Wires the trigger engine to the daemon's event sink and the WS `trigger` broadcast; reloads the rules on a config write; flushes on `stop()` |
| `src/config/config/paths.ts` | `triggersPath(dataDir)` → `<dataDir>/triggers.jsonl` |
| `src/cli.ts` | `sensus triggers tail` (headless: `--follow`, `--type`, `--since`) |

## How it works

### Config

```jsonc
{
  "triggers": [
    { "on": "error.raised" },
    { "on": "tool.executed", "tool": "shell_background" },
    { "on": "file.changed", "session": "01J8Z…" },
    { "on": "*" }
  ]
}
```

- `on` (required) is one of the eight v1 event types (`session.started`,
  `session.ended`, `turn.completed`, `tool.executed`, `file.changed`,
  `memory.written`, `skill.used`, `error.raised`) or `"*"` for any.
- `tool` (optional) is an exact tool-name filter; it only ever matches the
  tool-bearing types (`tool.executed`, `file.changed`, `error.raised`), so
  `{ "on": "*", "tool": "x" }` still cannot match a session event.
- `session` (optional) is an exact match against the v1 `session` field (the
  chat session, [`events.md`](events.md) "Instance vs session").
- **The FIRST matching rule wins.** One event produces at most one record, so a
  broad rule and a narrow rule for the same event do not double-log.

A malformed entry (non-object, missing/unknown `on`, non-string
`tool`/`session`), an unknown key, or a non-array `triggers` warns and is
skipped/ignored; boot never fails. An empty list (the default) makes the engine
a no-op.

### Matching + the log

`src/daemon/triggers.ts` decorates the daemon's real `EventSink`
(the `JsonlEventSink`, [`events.md`](events.md)): every seam event is first
projected by the **same** `toEventV1` the durable log uses, then offered to the
`TriggerEngine`. A match appends one record to `triggers.jsonl`:

```jsonc
{
  "v": 1,                    // trigger-log schema version (frozen at 1)
  "ts": 1759100000123,       // the matched event's epoch millis
  "rule": 1,                 // the matching rule's index in `triggers`
  "on": "tool.executed",     // that rule's `on`
  "event": { /* the full EventV1 record, verbatim */ }
}
```

The writer mirrors `JsonlEventSink` and is **bounded by construction**:

- `emit` is fire-and-forget and never throws; the line goes into a bounded
  in-memory queue (`TRIGGER_QUEUE_MAX`, default 1000, **drop-oldest**) and is
  flushed on a `setImmediate`, so no tool call ever blocks on disk;
- the file rotates to `triggers.jsonl.1` when it would exceed
  `TRIGGER_LOG_MAX_BYTES` (5 MiB), keeping one generation (~2× cap total);
- `flushSync()` drains synchronously; the daemon calls it in `stop()`.

A config write (`PUT /v1/config`) re-reads the rules live, so a trigger can be
added or removed without a restart.

### The WS `trigger` event

Every attached client receives:

```jsonc
{ "type": "evt", "event": "trigger", "trigger": { /* the TriggerRecord */ } }
```

It is a broadcast (not per-chat) because a matched event may belong to a chat
the client is not watching. The event fires **synchronously** with the engine
event (same tick), so a client sees it as soon as the condition is recorded.
The daemon-api contract is [`daemon-api.md`](daemon-api.md) "Events".

### Reading it: `sensus triggers tail`

`sensus triggers tail [--follow] [--type <t,t>] [--since <epoch-ms|ISO>]` is
headless (never boots the TUI, works inside a sensus pane), prints the raw
NDJSON lines (pipe to `jq`), and reads the log from the data dir
(`SENSUS_HOME` redirects it). `--type` matches the rule's `on` **or** the
underlying event's `type` (so a `"*"` rule is still selectable by the concrete
event it fired on); an unparseable line never matches when a filter is set.

### The persistent service

`sensus daemon install` writes a **user** service unit that runs the daemon in
persistent mode (`SENSUS_DAEMON_PERSISTENT=1`), so triggers keep watching with
no TUI attached; `uninstall` removes it. The units, paths, and `--dry-run` are
documented in [`operations.md`](operations.md) "Daemon".

## Gotchas & invariants

- **No egress (D8).** A trigger appends a local file and broadcasts to attached
  local clients; it never opens a socket, calls a model, or forwards anywhere.
- **The daemon owns the log** (D13). The TUI is a client and never writes
  `triggers.jsonl`; only the daemon's `stop()` flushes it.
- **First match wins.** One event → at most one record. Reordering the rules
  changes which fires.
- **Bounded and non-throwing.** Queue, rotation, and the never-throw contract
  are the caps; a disk failure drops the batch and never breaks the action it
  records. The v1 `event` is embedded verbatim, so a record cannot exceed one
  event's bounded size.
- **Only v1 events.** The two seam events with no v1 counterpart
  (`command-approved`/`command-denied`, [`events.md`](events.md)) never match a
  trigger; a rule's `on` must be one of the eight frozen types (or `"*"`).
- **The trigger schema is versioned separately.** `v: 1` is the trigger-log
  schema; it embeds an `EventV1` (whose own `v` is the event schema).

## Related docs

- [`events.md`](events.md) — the event schema v1 the triggers watch
- [`config.md`](config.md) — the `triggers` config key
- [`operations.md`](operations.md) — `sensus daemon install/uninstall` and `sensus triggers tail`
- [`daemon-api.md`](daemon-api.md) — the `trigger` WS event and the daemon lifecycle
- [`architecture.md`](architecture.md) — the daemon that owns the stores
