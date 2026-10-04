---
title: Configuration
description: "Where sensus keeps its settings and what each option does: endpoints, models, themes, context, approvals, memory, and more."
order: 4
---

Sensus reads settings in a fixed order: built-in defaults, then `~/.config/sensus/config.json`, then environment overrides, then command-line flags. A missing config file is normal: the defaults apply until you save your first setting, and most hand edits are picked up with `/reload`. Most of the file is also editable from the settings screen.

## The settings screen

`Ctrl+O` or `/settings` opens the settings screen: a category rail on the left, the selected category's fields on the right. The categories are **Endpoints · Model · Agent · Appearance · Chat · Context · MCP servers · Memory**.

- Type to filter across every category.
- `Tab` switches between the rail and the fields; `Enter` opens a section or edits a value; `Esc` backs out one step at a time.
- Every change persists immediately and applies live where it can.
- Destructive actions ask first (`y`/`n`).

The guided setup wizard (`sensus init`, `/init-wizard`, or a first run) covers a fresh install with a step-by-step flow; see [Install](/docs/install/).

## Endpoints and models

An endpoint is a named provider target. The `provider` field picks the protocol:

| Provider | Protocol |
|---|---|
| `openai-compatible` (default) | OpenAI-compatible chat completions |
| `openai-responses` | OpenAI's Responses API |
| `anthropic` | Anthropic's Messages API |
| `google` | Google Gemini |

`baseURL` is optional: leave it empty to use the protocol's default. An empty `apiKey` disables chat for that endpoint while the terminal keeps working.

```json
{
  "model": "openai@gpt-5",
  "endpoints": {
    "openai": { "baseURL": "https://api.openai.com/v1", "apiKey": "${OPENAI_API_KEY}" },
    "anthropic": { "provider": "anthropic", "apiKey": "${ANTHROPIC_API_KEY}" },
    "ollama": { "baseURL": "http://localhost:11434/v1" }
  }
}
```

`"model": "<endpoint>@<model-id>"` is the default for new sessions. `/models`, the model chip in the status bar, or the settings screen's Model section list every configured endpoint's models; `Enter` applies the pick to the current session and saves it as the new default. `/model <endpoint>@<id>` sets it directly. The `--model`, `--endpoint`, and `--base-url` flags override a single launch. Tabs that are already open keep the model they started with.

Endpoint names cannot contain `@`, because that character separates the endpoint from the model.

### API keys

Keep keys out of the config file: sensus stores them encrypted and references them by name.

```sh
sensus secrets set OPENAI_API_KEY sk-…
sensus secrets migrate
```

- `sensus secrets set <name> <value>`, `sensus secrets list`, and `sensus secrets rm <name>` manage the encrypted store.
- `${NAME}` in an endpoint's `apiKey` resolves from the store first, then from your shell environment.
- `sensus secrets migrate` moves any plaintext keys already in the config file into the store and rewrites them as references.
- A reference that resolves to nothing leaves that endpoint without a key, so chat is disabled for it until you fix it.

### Model metadata overrides

When a model's capabilities are unknown or reported incorrectly, override them per endpoint under `models`:

```json
{
  "endpoints": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "models": {
        "gpt-5": {
          "contextLimit": 400000,
          "inputLimit": 272000,
          "reasoning": true,
          "vision": true
        }
      }
    }
  }
}
```

The supported fields are `contextLimit`, `inputLimit`, `reasoning`, `reasoningEfforts`, `reasoningBudgetMin`, `reasoningBudgetMax`, `toolCall`, `temperatureSupported`, and `vision`. A value set here wins over the endpoint's own model list and the public model catalog.

### Thinking mode

`endpoints.<name>.thinkingMode` sets the default reasoning effort for models that support it: an effort keyword such as `low`, `medium`, or `high`; `budget:<n>` for a token budget; `off` for the lowest setting; or `default`. `/effort` overrides it for the current session.

## Theme and appearance

`theme` names the active theme. The default, `terminal`, paints no backgrounds and follows your terminal's own palette. `dark`, `light`, and a large set of named palettes (`nord`, `gruvbox-dark`, `catppuccin-mocha`, `tokyo-night`, and many more) are built in. `/theme` opens a picker with a live preview; the settings screen's Appearance section switches too. A theme change made from either applies immediately; a theme edited into the config file by hand takes effect on the next start.

The rest of the appearance settings:

- `layout`: `sidebar` (default) puts tabs on a vertical rail; `topbar` keeps them on the top row.
- `sidebar.width`: the chat width in columns (20–200; default 50).
- `tabs.width`: the tab rail width in columns (16–60).
- `autoChatOnly` (default on): starts narrow terminals with the chat full-width and the terminal pane hidden; `Alt+Home` toggles that view for the session.
- `themePalette`: pins colors for terminals that report the wrong palette or none at all: `foreground`, `background`, `palette`, `colorMode`, `paneColors`, and `boldBright`. Appearance → Advanced edits the common ones.

## Context and compaction

The agent sees a slice of your terminal, and long conversations are summarized before they overflow the model's context window.

- `context.enabled` (default on): master switch; `/context on` and `/context off` toggle it for the session.
- `context.scrollbackLines` (default 100): how many recent terminal lines accompany each request.
- `context.autoCompact` (default on): compact automatically as the window fills.
- `context.keepTokens` (default 15000): recent tokens kept verbatim beside a summary.
- `context.bufferTokens` (default 20000): safety reserve that triggers compaction early.
- `context.contextLimit` (default 0): `0` uses the model's own limit; a positive number pins it.

The `compaction` section tunes the same behavior with alternate names:

```json
{
  "compaction": {
    "auto": true,
    "tail_turns": 0,
    "preserve_recent_tokens": 15000,
    "reserved": 20000,
    "prune": false
  }
}
```

`auto`, `preserve_recent_tokens`, and `reserved` override the matching `context` values. `tail_turns` always keeps at least that many recent user turns. `prune` (default off) clears old tool output to reclaim space: it invalidates the provider's prompt cache and is recorded in the session audit, so leave it off unless you want that trade.

`/compact` summarizes on demand, and `/ctx` shows what currently occupies the window.

## Tool output

Every tool result is capped so a single huge command cannot flood the conversation:

```json
{ "tool_output": { "max_lines": 2000, "max_bytes": 51200 } }
```

A result that exceeds either limit is written to disk in full; the model receives a short preview and a pointer to read the rest back when it needs it. In the chat, `chat.toolOutput` controls the card preview: `collapsed` (default) shows a few lines with an expand hint, `expanded` shows the full output. Click a card header, press `Alt+E`, or use `/details` to toggle it.

## Chat behavior

The `chat` section controls how the sidebar presents a conversation:

- `chat.thinking`: `hide` (default) collapses reasoning to a one-line summary you can expand; `show` keeps it expanded. `Alt+T` toggles the newest block, `/thinking` changes the session default.
- `chat.animations` (default on): spinners, streaming reveal pacing, and entrance effects. Turn it off for a still UI.
- `chat.cardStyle`: `border` (default) draws outlined cards; `fill` draws solid panels. `Alt+C` or `/cards` toggles it.
- `chat.maxToolTurns`: limits how many tool round-trips one message may take (default: no limit; the settings screen offers 25, 50, 100, or off).
- `chat.busySend`: what `Enter` does while a reply is still streaming: `steer` (default) feeds your message into the running turn, `queue` sends it after. `Alt+Enter` uses the other mode for that message.

Session titles and alerts have their own keys:

```json
{
  "titles": { "enabled": true, "model": "" },
  "notifications": { "enabled": true, "mode": "bell", "onFinish": true, "onApproval": true }
}
```

`titles.model` empty means the session's own model writes the title. `notifications.mode` is `bell` or `osc777` (a richer OS notification where the terminal supports it).

## Custom instructions

Sensus always reads `~/.config/sensus/AGENTS.md` into the system prompt. `instructions` adds more sources on top:

```json
{
  "instructions": ["~/notes/style.md", "notes/*.md", "https://example.com/rules.md"]
}
```

Entries can be absolute paths, `~/` paths, globs, paths relative to where you launched sensus, or `http(s)://` URLs (fetched best-effort). Missing files and unreachable URLs are ignored, and `/reload` re-reads everything.

## Approvals

`approval` sets the default mode:

- `confirm` (default): every tool call waits behind an inline card: `y` accepts, `n` rejects, `a` trusts that command class for the rest of the session. Reads, writes, shell commands, memory, and MCP calls all use the same card.
- `full-auto`: calls run without a card, except destructive commands, which still ask. Toggle with `/yolo`, `Alt+Y`, or the settings screen.

`shell_session` may type into your terminal freely, but every Enter is still confirmed. The session-only `a` trust is never saved; the two keys below are.

### allowPrefixes

`allowPrefixes` is the persistent always-allow list for commands the agent runs in its hidden shell. A command that starts with one of these prefixes skips the approval card:

```json
{ "allowPrefixes": ["git status ", "npm run test ", "ls "] }
```

The settings screen edits the list as comma-separated text. Prefixes are offered by operation class: approving `git status --short` offers `git status `, and approving `git commit -m "…"` offers `git commit `. This list survives restarts.

### permission rules

`permission` is an ordered list of rules for finer control. Each rule has:

| Key | Meaning |
|---|---|
| `tool` | The tool to match: `shell_background`, `shell_session`, `read_file`, `edit_file`, `write_file`, `view_image`, `memory`, `session_search`, `host_scan`, an MCP tool as `mcp__<server>__<tool>`, or `*` for any. |
| `pattern` | Optional glob (`*` matches any run, `?` matches one character) matched against the shell command, the text typed into your terminal, or the target file path. Omit it to match any. |
| `action` | `allow` (run without asking), `ask` (show a card), or `deny` (never run). |

```json
{
  "permission": [
    { "tool": "read_file", "pattern": "notes/*", "action": "allow" },
    { "tool": "shell_background", "pattern": "git status*", "action": "allow" },
    { "tool": "shell_background", "pattern": "rm *", "action": "ask" },
    { "tool": "mcp__firecrawl__*", "action": "deny" }
  ]
}
```

Rules are evaluated in order and the **last matching rule wins**, so a later `allow` can override an earlier `deny`. A `deny` is final: the tool never runs, no card appears, and the model is told the call was denied. `allow` and `ask` cannot un-gate destructive commands: that floor always stands. A read-only agent likewise refuses anything that would change state, whatever the rules say. Invalid entries are skipped with a warning instead of blocking startup.

See [Approvals](/docs/approvals/) for how cards, modes, and session trust work in practice.

## Memory

The agent keeps plain-markdown stores under `~/.config/sensus/memory/`, managed from `/memory`. The `memory` section tunes them:

- `memory.enabled` (default on): turning it off removes the memory tool and its prompt block.
- `memory.memoryCharLimit` (default 2200): cap for the always-injected fact store.
- `memory.hostCharLimit` (default 4000): cap for the machine map.
- `memory.journalCharLimit` (default 8000): cap for the activity journal.
- `memory.writeApproval` (default off): ask before every memory write, even in full-auto.
- `memory.consolidateAtPercent` (default 80): when the agent is nudged to consolidate a full store.
- `memory.redactSecrets` (default on): refuse writes that look like credentials.

What each store is for: [Memory](/docs/memory/).

## MCP servers

`mcp.servers` adds external tools to the agent. Local servers run a command; remote servers connect to a URL:

```json
{
  "mcp": {
    "servers": {
      "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
      "firecrawl": {
        "url": "https://mcp.firecrawl.dev/mcp",
        "headers": { "Authorization": "Bearer ${FIRECRAWL_API_KEY}" }
      }
    }
  }
}
```

Local entries accept `command`, `args`, `env`, and `cwd`; remote entries accept `url` and `headers`. Both accept `enabled` and `timeout_s`, and `${NAME}` works in `env`, `headers`, and `cwd`. The settings screen manages the list. Full details: [MCP](/docs/mcp/).

## Updates

Sensus checks for a newer release once a day when it starts and shows a short notice when one exists. Set `updateCheck` to `false` to turn that check off; the request carries nothing about you or your machine either way. Update any time with `sensus update` — see [CLI](/docs/cli/) and [Install](/docs/install/).

## Background service

The local worker that owns your shells runs on demand: it exits after a grace period when no window is attached and no terminal pane is alive, taking its shells with it. Set `daemonPersistent` to `true` to keep it running (that is what lets triggers act with no sensus window open), and `sensus daemon install` registers it as a user service that starts automatically. `sensus kill` stops every local worker and the shells they own. See [CLI](/docs/cli/) and [Triggers](/docs/triggers/).

## Extensions

`extensions` is an integration seam for external tooling:

```json
{
  "extensions": {
    "approvalPolicy": { "kind": "default" },
    "eventSink": { "kind": "jsonl" }
  }
}
```

`approvalPolicy` can hand approval decisions to a custom policy, and `eventSink` can drop events (`noop`), stream them to a local Unix socket (`uds`), or append them to the local event log (`jsonl`). The defaults are local and inert, and unrecognized values fall back to the default. See [Privacy & data](/docs/privacy/).

## Next steps

- [Approvals](/docs/approvals/): approval modes, cards, and trust in practice.
- [Memory](/docs/memory/): the stores the agent maintains.
- [CLI](/docs/cli/): commands, flags, and the background service.
- [Keybindings](/docs/keybindings/): remap the global hotkeys.
- [Privacy & data](/docs/privacy/): what stays local and what leaves the machine.
