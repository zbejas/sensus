---
title: Memory
description: What the agent remembers between sessions, where those notes live, and how to review or edit them.
order: 9
---

Sensus gives the agent a small, explicit memory instead of leaning on the conversation window:
plain Markdown notes it keeps about your machine, your preferences, and what it has done. They
live in `~/.config/sensus/memory/`, stay on your machine, and survive across sessions.

## The stores

| Store | What it holds | When the agent sees it |
|---|---|---|
| `MEMORY.md` | Durable facts: environment conventions, preferences, lessons learned | Every session, as part of the agent's instructions |
| `HOST.md` | The machine map of what runs where: services, ports, key paths, commands, gotchas | On demand, when the agent reads it |
| `JOURNAL.md` | A running log of what the agent did | On demand, when the agent reads it |

The agent maintains all of this with its `memory` tool: it can add an entry, edit part of one,
delete one, read a store, or rewrite a store to consolidate it when it is full.

Each store has a character cap, and they behave differently when full. `MEMORY.md` and `HOST.md`
refuse a write that would go over the cap: the agent consolidates first, so nothing is silently
dropped. `JOURNAL.md` is a log, so its oldest entries fall away as new ones arrive. The caps are
configurable; see [Configuration](/docs/configuration/).

## What the agent sees right now

At the start of each session the agent takes a snapshot of `MEMORY.md` and keeps it for that
conversation. Notes written during a session are saved to disk immediately, and the agent can
always read the live store on request, but the running conversation's instructions don't change
under it. The next session starts from the updated snapshot, which keeps each turn's instructions
stable.

In **confirm** mode, memory actions get an approval card like any other tool call. In
**full-auto** writes run without one unless you turn on `memory.writeApproval`. Setting
`memory.enabled` to `false` turns memory off entirely: the agent loses the tool and never sees
a memory block.

## Reviewing and editing: `/memory`

`/memory` (or Ctrl+P → "Agent memory") opens the memory manager: a rail for the stores, usage
bars, and one row per entry.

- `↑`/`↓` (or `j`/`k`) move, `Enter` edits the selected entry, and `a` adds a new one.
- `d` deletes an entry (with a `y/N` confirmation), `p` prunes the oldest entries down to half
  the cap, and `r` reloads from disk.
- `Tab` switches between the rail and the entry list; `Esc` closes.

The manager writes through the same rules as the agent, so caps and the safety checks below apply
either way. The settings screen's Memory category tunes the caps and write policy.

The files are ordinary Markdown: entries are paragraphs separated by a line containing only `§`.
You can edit them by hand; the manager and the agent read the files live, and the agent picks up
your change in its next session.

## Mapping your machine

`HOST.md` is built once and refreshed when things change. `/map` asks the agent to run a
read-only scan of the machine (operating system, disks, listening ports, services, containers,
network addresses, git remotes) and curate the result into the map rather than pasting it raw.
The scan never changes anything and redacts anything that looks like a credential before it
reaches the model. The setup wizard can seed a first draft.

## Safety

Memory text becomes part of the agent's instructions, so writes are checked before they land:

- Credential-looking text (keys, tokens, passwords, private keys) is refused by default, and
  scan output is redacted.
- Text that looks like an instruction override, or that hides invisible characters, is refused.
- Every committed write is recorded in an edit history beside the stores, so changes are
  auditable.

You can turn the credential scan off in configuration if you truly need to store something that
trips it, but keeping secrets out of memory is the safer habit.

## Next steps

- [Configuration](/docs/configuration/): tune the memory caps and write policy
- [Sessions](/docs/sessions/): where conversations live and how to resume them
- [Tools](/docs/tools/): the agent's toolbox, including `memory`
- [Privacy & data](/docs/privacy/): what stays on your machine
