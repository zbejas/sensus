# Agents

User guide: https://sensus.sh/docs/agents/

## Overview

An agent is a markdown file in `~/.config/sensus/agents/` that defines the posture of the
Sensus agent: a prompt body appended to the system prompt, plus frontmatter that can
restrict tool access and choose the sudo behavior. The active agent is a global, persisted
selection. This doc is the file format and selection semantics; the generation loop that
consumes agents is in [`agent.md`](agent.md).

## Key files

| File | Purpose |
|---|---|
| `src/config/agents.ts` | Frontmatter parser, loader, built-in materialization, `AgentDef` |
| `src/agent/prompt.ts` | Places the active agent's `name`/`description`/`prompt` in the system prompt |
| `src/agent/chat/chatSession.ts` | Filters the request tool set by the agent's `tools`, and enforces the `readonly` guard in `gateDecision` |
| `src/ui/components/AgentPicker.tsx` | The picker overlay (rows + prompt preview) |

## File format

```markdown
---
name: copilot
description: Guides you step by step in YOUR terminal — reads state, proposes commands, types them when you accept
tools: ["*"]
sudoPrompt: ask
shell: session
---
You are operating as COPILOT: … (prompt body — appended verbatim to the
system prompt; the shared core stays in place)
```

Frontmatter fields (parser is hand-rolled — `key: value`, `key: [a, b]` inline arrays, and
`- item` block lists are supported; quotes optional):

- `name` (default: the file stem): the selection name. Must be unique — the first
  definition wins, later duplicates warn.
- `description`: one line shown in the picker and `/status`.
- `tools`: the agent's allowed core tool names (`shell_background`, `shell_session`,
  `read_file`, `edit_file`, `write_file`, `get_scrollback`, `view_image`, `ask_user`,
  `memory`, `host_scan`, `session_search`, `session_list`, `session_view`, `skills_list`,
  `skill_view`, `reload`). Absent, empty, or
  `["*"]` = all. When a list is declared, MCP tools (`mcp__*`) are filtered by it too.
- `skills`: the agent's allowed skill names (docs/skills.md). Absent, empty, or `["*"]` =
  all; a declared list limits both the prompt index and the skills tools.
- `sudoPrompt` (`ask` | `popup` | `auto`, default `ask`): what happens when a
  `shell_background` command fails because sudo needs a password. `popup` shows the password
  prompt and retries; `ask` returns "tell the user" guidance; `auto` **follows the approval
  mode** — popup in full-auto, ask in confirm (the merged copilot uses this). See
  [`agent.md`](agent.md) "Sudo".
- `shell` (`auto` | `session` | `background`, default `auto`): the agent's default shell
  posture. `session` makes `shell_session` (the user's visible terminal) the default for
  anything the user asks to run/change/see, with `shell_background` reserved for quiet,
  read-only investigation; `background` prefers the hidden shell and uses `shell_session`
  only when asked to show something; `auto` leaves the neutral shared rule. The preference
  lands in the system prompt ([`agent.md`](agent.md) "System prompt"), and is what makes
  copilot honor "use my terminal". The agent's `tools` list still has the final say on
  which shell tool actually exists in the request.
- `readonly` (`true` | `false`, default `false`): the **read-only guard**. When `true`, the
  execution layer hard-denies every mutating call, independent of `tools` and impossible to
  override from the model side:
  - `edit_file`, `write_file`, `memory`, `shell_session`, and MCP tools (`mcp__*`) are
    denied outright (and dropped from the request tool list);
  - a `shell_background` command is denied unless it is read-only: output redirection,
    in-place editors (`sed -i`, `perl -i`), filesystem mutators (`rm`, `mv`, `cp`, `mkdir`,
    `touch`, `chmod`, `chown`, `ln`, `truncate`, `dd`, `tee`, …), package managers, service
    control (`systemctl start/…`), container/orchestration mutations (`docker`/`pct`/`qm`),
    `sudo`/`su`, `find -delete`/`-exec`, `xargs`, and any `git` subcommand other than the
    read-only set (`status`, `log`, `diff`, `show`, `branch`, `remote`, `rev-parse`, …) are
    refused.
  Reads (`read_file`, `get_scrollback`, `session_*`, `skills_*`, `host_scan`, `ls`, `grep`,
  `git status`, …) still work. The guard runs in `gateDecision` **before** the permission/
  policy pipeline, so an `allow` prefix, session trust, a `permission` allow, or an
  ApprovalPolicy cannot wave a mutation through ([`agent.md`](agent.md) "Approval modes").
  It is a conservative guard, not a sandbox: an interpreter invoked in an unlisted way could
  still write, so treat it as a strong guardrail, not a container.
- Unknown frontmatter keys warn once and are ignored.

## Built-ins

`copilot.md` and `scout.md` ship inside the binary and are materialized into
`~/.config/sensus/agents/` on first boot (together with the `memory/` directory and the
built-in skills — [`skills.md`](skills.md) "Built-in skills"). They are **Sensus-owned**: each
carries a banner whose `sha256` hashes its
body. On boot, a file whose banner hash still matches is refreshed in place whenever the
compiled-in definition changes (i.e. on an update). A file whose hash does **not** match
(you edited the body) — or a banner-less file at the built-in name — is instead rescued:
it is renamed to `<stem>.modified-<timestamp>.md` with a unique agent name and a fresh
built-in is generated in its place. So nothing is lost, but don't edit a built-in in
place — copy it to a new name and edit the copy. `/reload` re-reads the directory.
Deleting a built-in is allowed: a missing name falls back to its compiled-in definition,
and an empty agents directory falls back to copilot.

- **copilot** (default) — `shell: auto`, `sudoPrompt: auto`: it **adapts to the approval
  mode** (session-first in confirm, background-first/autonomous in full-auto) instead of
  shipping a separate autopilot. It reserves `ask_user` for genuine forks (destructive or
  ambiguous choices).
- **scout** — the read-only researcher: `readonly: true`, `shell: background`,
  `sudoPrompt: ask`; the guard enforces that at the tool layer.
- The old `autopilot` built-in is gone. An existing `autopilot.md` on disk still loads (no
  file is deleted), but new installs get only copilot + scout; `agent: "autopilot"` in config
  now falls back to copilot, and the same autonomous behavior is one `/yolo` away.

## Selection semantics

Picks are **per-session with a persisted default**: switching an agent (or a model) moves
the current tab immediately and writes the pick to `config.json` so new sessions and
relaunches start there — other already-open tabs keep what they were using.

- **Model** selection is latched when a session is created: a config-default change from
  anywhere (another tab's pick, a settings write, `/reload`) seeds NEW sessions only, and
  an open session changes its model only through the picker or `/model`.
- **Agent**: a session that never picked follows the config default and picks it up on the
  next request after the config changes; a session that picked keeps its pick.

- `agent` in `config.json` names the default agent for new sessions
  ([`config.md`](config.md)).
- The picker, `/agent <name>`, `Alt+M`, and the status-bar chip apply-current +
  persist-default; the sidebar `agent:<name> ⇄` chip cycles through the loaded
  agents with the same semantics.
- The change takes effect on the next request (the system prompt and the tool list are
  rebuilt per request). `/status` shows the session's active agent.
- `/reload` re-reads the markdown files.

## Gotchas & invariants

- **Built-ins are refreshed; edits are rescued.** On boot, an unedited built-in (banner
  hash matches) is refreshed in place when the shipped markdown changes. A modified one is
  renamed to `<stem>.modified-<timestamp>.md` (with a unique agent name) and a fresh
  built-in is generated — nothing is lost, but two agents now exist. Any other agent file
  is never touched.
- **The tool filter is a subset, never an addition.** An agent cannot grant tools the
  endpoint does not support or that MCP did not provide.
- **Selection is session + persisted default**, not global-per-tab — other tabs are
  untouched by a pick.
- **Agent name collisions resolve first-wins** with a warning; a `name` field different
  from the file stem is allowed.

## Related docs

- [`agent.md`](agent.md) — the tool loop, approvals, sudo, and system prompt
- [`config.md`](config.md) — the `agent` key and settings screen
- [`mcp.md`](mcp.md) — MCP tool filtering by the agent's `tools`
