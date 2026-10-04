---
title: Triggers
description: Watch for local events and keep a durable, local-only log of the ones you care about.
order: 12
---

Triggers are opt-in rules that watch the events Sensus already records (a session starting or
ending, a turn finishing, a tool running, a file changing, a memory write, a skill being used, an
error) and write each match to a local log. They keep a durable trail of the conditions you care
about; with the persistent service below, that trail keeps building while no Sensus window is
open. Nothing leaves your machine.

## Rules

Rules are a list under `triggers` in your configuration (`~/.config/sensus/config.json`):

```json
{
  "triggers": [
    { "on": "error.raised" },
    { "on": "tool.executed", "tool": "shell_background" },
    { "on": "file.changed", "session": "01J8Z6M6Y3Q7V9K2N4P6R8T0W2" },
    { "on": "*" }
  ]
}
```

- `on` (required) is one of `session.started`, `session.ended`, `turn.completed`,
  `tool.executed`, `file.changed`, `memory.written`, `skill.used`, `error.raised`, or `*` for
  any event.
- `tool` (optional) filters to one exact tool name. It only ever matches the tool-bearing
  events.
- `session` (optional) filters to one chat session id.
- The first matching rule wins: one event produces at most one record, so a broad rule and a
  narrow rule don't double-log the same event.

A malformed rule is skipped with a warning, and an empty list (the default) leaves triggers off.
The local service reads the rules from your configuration; they apply when configuration is
saved through Sensus or when the service restarts.

## Where matches go

Each match is appended to a local log at `~/.local/share/sensus/triggers.jsonl` (the log rotates
when it grows). There is no egress: a trigger only ever writes to that file.

Read it with `sensus triggers tail`:

```sh
sensus triggers tail                      # print the whole log
sensus triggers tail --follow             # then stream new matches
sensus triggers tail --type error.raised  # only errors (comma-separate several types)
sensus triggers tail --since 2026-10-01   # epoch milliseconds or a date
```

The output is one JSON record per line, so you can pipe it to `jq` or another tool. `--type`
matches the rule's `on` or the underlying event's type, so a `*` rule is still selectable by the
concrete event it fired on.

## Keeping triggers running

Triggers are evaluated by the local background service, so they only watch while that service is
running. By default it exits once it has been idle for a while; if you want triggers to keep
watching with no Sensus window open, install it as a persistent service:

```sh
sensus daemon install     # user service; starts on login, no root
sensus daemon uninstall   # remove it again
```

Both accept `--dry-run` to print what would happen. `sensus daemon status` shows whether the
service is up.

## Good to know

- The log is local-only, and so is everything triggers see.
- A trigger never breaks the action it records: a disk failure drops the record, not the action.
- Only the events Sensus records can fire a rule; a rule's `on` must be one of the event types
  above or `*`.

## Next steps

- [Configuration](/docs/configuration/): the `triggers` key and the rest of the config
- [CLI](/docs/cli/): `sensus triggers tail` and the other headless commands
- [Privacy & data](/docs/privacy/): what stays on your machine
