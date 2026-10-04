# Sensus engineering docs

Knowledge base for **Sensus** — a terminal you live in: an embedded-terminal TUI that hosts
a real interactive shell (a native PTY via OpenTUI's Ghostty VT) in a large left pane with
an AI agent chat sidebar on the right, started by running `sensus` from a shell
(a plain first run opens the in-app setup wizard; `/init-wizard` reopens it).

> **How to use this:** start at the repo-root [`AGENTS.md`](../AGENTS.md) for task
> routing — it tells you which doc to read for which job. This index maps every doc.

> **Audience:** this is the engineering knowledge base — files, functions, invariants, and
> hard-won rules. The user manual lives at **https://sensus.sh/docs**
> (`site/src/content/docs/`), and user pages never name internals. A dev doc with a user page
> carries a `User guide:` line ([`TEMPLATE.md`](TEMPLATE.md)).

> **Credit:** Sensus is inspired by [OpenCode](https://opencode.ai); attribution is
> recorded in [`NOTICE`](../NOTICE).

## Docs

| Doc | Covers |
|---|---|
| [`architecture.md`](architecture.md) | System map, module responsibilities, data flows, lifecycle, non-goals. **Start here.** |
| [`PRODUCT.md`](PRODUCT.md) | What sensus is, who it is for, locked decisions, principles |
| [`DESIGN.md`](DESIGN.md) | TUI design system: regions, focus, theme tokens, color fidelity, do's/do not's |
| [`config.md`](config.md) | Config schema + resolution, settings screen, model/agent pickers, all paths |
| [`agent.md`](agent.md) | Agent harness hub: loop at a glance, key files, routing to the harness subsystem docs |
| [`agent-loop.md`](agent-loop.md) | Chat & tool loop: generation loop, busy sends, chat shortcuts, titles, no-tools mode, remote approval/event stream |
| [`agent-providers.md`](agent-providers.md) | Providers & models: protocols, retries, idle timeout, no-tools latch, thinking modes, selected model, model catalog |
| [`agent-tools.md`](agent-tools.md) | Tools & execution: the core tools, hidden shell/jobs, file tools, truncation, sudo, images, session search, undo/audit |
| [`agent-approvals.md`](agent-approvals.md) | Approvals & permissions: modes, `permission`/`allowPrefixes`, destructive floor, read-only guard, plan card, extensions |
| [`agent-context.md`](agent-context.md) | Context, compaction & caching: context injection, checkpoints, pinned facts, prune, rewind, prompt caching, inspector/usage |
| [`agent-prompt.md`](agent-prompt.md) | System prompt & streaming: prompt assembly, nearest-`AGENTS.md`, streaming/thinking display, truncation surfacing |
| [`agents.md`](agents.md) | Agent definitions (`~/.config/sensus/agents/`): format, built-ins, selection semantics |
| [`mcp.md`](mcp.md) | MCP client: config, transports, lifecycle, approvals, non-goals |
| [`terminal-layer.md`](terminal-layer.md) | Terminal engine spec: native PTY, embedded VT renderable, scanner, input/focus, scrollback, adaptive pane palette, death |
| [`keybindings.md`](keybindings.md) | Keymap, Ctrl+A prefix, slash autocomplete, command menu, click targets, overlays |
| [`ui.md`](ui.md) | Solid view layer: components, stores, chat rendering, toasts, overlays |
| [`operations.md`](operations.md) | CLI, setup wizard, install, build & ship, persistence, lifecycle |
| [`events.md`](events.md) | Instance identity (`instance.json`) + the durable event log (schema v1), no-egress guarantee |
| [`triggers.md`](triggers.md) | Local condition triggers: the `triggers` rules, `triggers.jsonl`, `sensus triggers tail`, the persistent service |
| [`daemon-api.md`](daemon-api.md) | The `sensus daemon` (worker): REST surface, auth, error shape, runtime/lifecycle (REST reference: Scalar at `/openapi`, generated from `src/daemon/apiSchemas.ts`) |
| [`logging.md`](logging.md) | Structured logging: the NDJSON envelope, levels + severity numbers, redaction, correlation, rotation, the reader API, `sensus daemon logs`, `SENSUS_LOG_LEVEL`/`SENSUS_LOG_STRICT` |
| [`testing.md`](testing.md) | Test layout, commands, philosophy, smoke-test rules, mocks, ship guards |
| [`roadmap.md`](roadmap.md) | Project status: what ships today and what is deliberately open |
| [`TEMPLATE.md`](TEMPLATE.md) | The shape every doc follows + the writing rules |

## Reading paths

| If you are… | Read in order |
|---|---|
| New to the repo | `AGENTS.md` → `architecture.md` → `PRODUCT.md` |
| Touching the terminal pane | `terminal-layer.md` → `ui.md` |
| Touching the harness | `agent.md` (hub) → the matching `agent-*.md` sibling → `agents.md` → `mcp.md` |
| Touching the chat/tool loop | `agent-loop.md` → `agent-approvals.md` → `daemon-api.md` |
| Touching providers/models | `agent-providers.md` → `config.md` (endpoints) |
| Touching tools/sudo | `agent-tools.md` → `agent-approvals.md` → `terminal-layer.md` |
| Touching context/compaction | `agent-context.md` → `config.md` (`context`, `compaction`) |
| Touching the prompt/streaming | `agent-prompt.md` → `agent-providers.md` → `ui.md` |
| Changing configuration or settings | `config.md` |
| Changing the look or colors | `DESIGN.md` → `config.md` (`themePalette`) |
| Shipping / packaging | `operations.md` |
| Writing or debugging tests | `testing.md` → `AGENTS.md` testing policy |
| Instance identity / the event log | `events.md` → `extensions.md` → `daemon-api.md` |
| Local triggers / persistent service | `triggers.md` → `events.md` → `operations.md` |
| Checking project status | `roadmap.md` |

## Writing docs

- Follow [`TEMPLATE.md`](TEMPLATE.md) — every doc has the same shape (**Overview →
  Key files → How it works → Gotchas & invariants → Related docs**).
- **The code wins.** If code and a doc disagree, the code is right and the doc is a
  bug — fix it in the same change.
- **State each fact once.** Cross-cutting facts (paths, env vars, the theme token
  contract, tools, status-bar segments) have one canonical doc; link, don't restate.
- **No bare counts or versions.** Anything volatile (tool count, test count, package
  versions) must link its source of truth (`src/...`) or carry an "as of" qualifier.
- **Mark anomalies explicitly** — dead code, known drift, TODOs. Do not silently omit.
- **Docs-only changes never touch `src/`.** If a doc fix requires a code change, make
  it in the same commit and say so in the report.
- Agent-facing hard-won rules (smoke-test lore, compiled-binary constraints) live in
  [`testing.md`](testing.md) and [`operations.md`](operations.md), summarized in
  `AGENTS.md`.

## Related docs

- [`../AGENTS.md`](../AGENTS.md) — task routing + non-negotiable rules
- [`../README.md`](../README.md) — user-facing install and usage
