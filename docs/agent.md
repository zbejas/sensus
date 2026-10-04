# Agent harness

User guide: https://sensus.sh/docs/how-it-works/

## Overview

The agent harness connects each tab's chat session to a configured model endpoint and runs a
sequential tool loop on top of it. It owns the provider seam, the core tools and their
approval gates, terminal context injection, context compaction, the system prompt, and the
streaming display. One tab is one PTY shell and one chat session, hosted by the daemon; the
harness is headless (`src/engine/index.ts` is the frozen engine surface, IF1) and the TUI
renders from it.

This doc is the hub. Six subsystem docs own the detail: [`agent-loop.md`](agent-loop.md)
(the generation/tool loop and chat UX), [`agent-providers.md`](agent-providers.md) (the
provider seam, protocols, models), [`agent-tools.md`](agent-tools.md) (the tool set and its
execution), [`agent-approvals.md`](agent-approvals.md) (approval modes and permissions),
[`agent-context.md`](agent-context.md) (terminal context, compaction, prompt caching), and
[`agent-prompt.md`](agent-prompt.md) (the system prompt and streaming display). Agent
postures are specified in [`agents.md`](agents.md); MCP in [`mcp.md`](mcp.md); memory in
[`memory.md`](memory.md); skills in [`skills.md`](skills.md).

## Key files

| File | Purpose |
|---|---|
| `src/agent/chat/chatSession.ts` | Per-tab chat state machine: the generation/tool loop, `gateDecision`, streaming state, the approval plan, the event stream |
| `src/agent/chat/chatMessages.ts` | Pure chat data model: message/card types, `ChatEvent`, session deps interfaces, `recordsToMessages`, `/help` text |
| `src/agent/chat/chatHost.ts` | UI-facing deps/wiring seam; memoizes one provider per endpoint; owns the audit/index/memory/title bridges |
| `src/agent/chat/compaction.ts` | Pure context estimates, summary serialization, checkpoint compaction, optional prune |
| `src/agent/chat/contextAccounting.ts` | Context-window limit/estimates/token breakdown + the system-prompt token memo |
| `src/agent/chat/contextHistory.ts` | Resumed-transcript durable-history reconstruction for the Context inspector |
| `src/agent/chat/toolCardBook.ts` | Tool-card bookkeeping, approval/ask waits, session trust patterns |
| `src/agent/chat/title.ts` | One-shot auto session title over the first user prompt |
| `src/agent/chat/promptComposer.ts` | Input editor, prompt history ring, draft images, slash-autocomplete state |
| `src/agent/chat/slashDispatch.ts` | The slash-command switch (`dispatchSlash` + its host) |
| `src/agent/provider/provider.ts` | The `ChatProvider` seam + factory (mock vs the endpoint's protocol) |
| `src/agent/provider/protocols.ts` | The ONE protocol seam: kinds, default baseURLs, AI SDK model construction, reasoning/provider-option mapping |
| `src/agent/provider/aiSdkProvider.ts` | Vercel AI SDK client: SSE streaming, retries, idle timeout, no-tools degradation, thinking |
| `src/agent/provider/modelCatalog.ts` | Protocol-aware endpoint model listing + models.dev enrichment + endpoint-native metadata + config overrides |
| `src/agent/tools.ts` | Public barrel over `src/agent/tools/` (import this, not the internals) |
| `src/agent/tools/index.ts` | Explicit re-exports; the tool-layer module map |
| `src/agent/tools/specs.ts` | The OpenAI function specs — the tool set's source of truth |
| `src/agent/tools/execute.ts` | `executeTool` dispatch: shell/memory/host-scan executors, image passthrough, previews |
| `src/agent/tools/jobs.ts` | Hidden-command runner + background-job registry (`activeJobs`) |
| `src/agent/tools/approval.ts` | Approval classification, trust patterns, permission rules, read-only guard |
| `src/agent/tools/summary.ts` | Arity-aware command prefixes, card param summaries, approval detail |
| `src/agent/tools/parse.ts` | Tool-arg parsing, `resolveToolName` repair, path resolution |
| `src/agent/tools/filePlan.ts` | `edit_file`/`write_file` plans + apply |
| `src/agent/tools/diff.ts` | Diff-row computation for cards |
| `src/agent/tools/readFile.ts` | Bounded streamed regular-file reader |
| `src/agent/tools/sudo.ts` | Sudo detection/rewrite helpers |
| `src/agent/tools/text.ts` | Head/tail clipping helpers |
| `src/agent/tools/types.ts` | `ToolSpec`, `ToolContext`, `AgentPane`, `ApprovalDecision`, … |
| `src/agent/truncate.ts` | Tool-output boundary cap + full-text spill |
| `src/agent/context.ts` | Terminal context block builder |
| `src/agent/prompt.ts` | System prompt assembly |
| `src/agent/instructions.ts` | Config `instructions` resolution + nearest-`AGENTS.md` lookup |
| `src/agent/slash.ts` | Slash parsing + the `SLASH_COMMANDS` table |
| `src/agent/markdown.ts` | Chat markdown segmentation (pure, no opentui imports) |
| `src/agent/audit.ts` | Append-only audit log + `lastUndoable`/`markUndone` |
| `src/agent/sudoAskpass.ts` | Askpass helper/broker for hidden-shell and pane sudo |
| `src/agent/processUtil.ts` | `haveSetsid`, `killProcessTree`, `abortableSleep` (shared with MCP + providers) |
| `src/agent/extensions.ts` | The `ApprovalPolicy` + `EventSink` extension seam ([`extensions.md`](extensions.md)) |
| `src/agent/log.ts` | `componentLogger` — the shared component-scoped logger ([`logging.md`](logging.md)) |
| `src/agent/memory/types.ts` | The three-store memory data model ([`memory.md`](memory.md)) |
| `src/agent/memory/store.ts` | The single writer: read/write, hard caps, journal ring-trim |
| `src/agent/memory/safety.ts` | Secret redaction + injection/invisible-Unicode scans |
| `src/agent/memory/hostScan.ts` | The `host_scan` probe whitelist |
| `src/agent/skills/loader.ts` | Skill discovery, frontmatter parsing, the prompt index ([`skills.md`](skills.md)) |
| `src/agent/mcp/types.ts` | MCP config/wire types, env-ref expansion, timeout default ([`mcp.md`](mcp.md)) |
| `src/agent/mcp/jsonrpc.ts` | Request/response correlation over a transport |
| `src/agent/mcp/stdio.ts` | Subprocess transport (newline-delimited JSON-RPC) |
| `src/agent/mcp/http.ts` | Streamable-HTTP transport |
| `src/agent/mcp/registry.ts` | Instance-wide lifecycle: connect, list, dispatch, restart, stop |
| `src/agent/mcp/cache.ts` | Per-server scratch-dir pruning |
| `src/engine/chat/streamReveal.ts` · `contextInspector.ts` · `usage.ts` | Pure render pacing, Context-inspector snapshot, usage roll-ups the UI renders ([`ui.md`](ui.md)) |

## The loop at a glance

```
user sends
   │
   ▼
1. preflight compaction (near the context limit)      → agent-context.md
   ▼
2. append the durable terminal context block + the user text
   ▼
3. provider.stream(system prompt + history + tools)   → agent-providers.md
   │
   ├─ finish: tool_calls → 4. gate each call           → agent-approvals.md
   │                       5. execute the calls in order → agent-tools.md
   │                       6. append assistant + results, loop to 3
   │
   └─ finish: stop → stream the answer to the sidebar   → agent-prompt.md
```

The full step list (compaction order, tool-name repair, the loop cap, Esc abort) is in
[`agent-loop.md`](agent-loop.md).

## Agents (copilot / your own)

The agent's posture is a markdown file in `~/.config/sensus/agents/` (full spec:
[`agents.md`](agents.md); user-facing behavior:
[How the agent works](https://sensus.sh/docs/how-it-works/) and
[Agents](https://sensus.sh/docs/agents/)). The active agent is the session's pick, falling
back to the persisted `agent` default in `config.json`; it reaches the system prompt as
`Active agent: <name>` + the file's prompt body, and its `tools` list filters the request's
core tool set.

Built-ins (materialized on first boot; Sensus-owned — refreshed on updates, edits rescued):

- **copilot** (default) — `shell: auto`, `sudoPrompt: auto`: it **adapts to the approval
  mode** (session-first in confirm, background-first/autonomous in full-auto).
- **scout** — `readonly: true`, `shell: background`, `sudoPrompt: ask`: the read-only
  researcher; the guard enforces it at the tool layer.

Switching applies the pick to the current session and persists it as the default for new
sessions (other open tabs are untouched). Paths: `/agent <name>`, `/agent` or `Alt+M`
(picker), the status-bar `agent:<name>` chip, or the sidebar chip (which cycles to the
next agent). Every switch toasts.

## Where each detail lives

| Looking for… | Read |
|---|---|
| The tool loop, loop cap, steering/queue, abort semantics, doom-loop guard, background-job visibility | [`agent-loop.md`](agent-loop.md) |
| Session titles, chat shortcuts, no-tools degradation, the remote approval/event stream, desktop notifications | [`agent-loop.md`](agent-loop.md) |
| Provider protocols, retries, idle timeout, the no-tools latch, thinking modes, selected model, model catalog | [`agent-providers.md`](agent-providers.md) |
| The core tool table, hidden shell/jobs, file tools, `shell_session` delivery, truncation/spill, sudo, images, session search, undo/audit | [`agent-tools.md`](agent-tools.md) |
| Approval modes, `permission`/`allowPrefixes`, the destructive floor, read-only guard, plan card, `ApprovalPolicy` | [`agent-approvals.md`](agent-approvals.md) |
| Context block, compaction/checkpoint, pinned facts, prune, rewind, prompt caching, `/ctx` and `/usage` | [`agent-context.md`](agent-context.md) |
| System prompt, nearest-`AGENTS.md`, memory/skills/MCP prompt blocks, streaming/thinking display, truncation surfacing | [`agent-prompt.md`](agent-prompt.md) |
| Agent posture files and built-ins | [`agents.md`](agents.md) |
| MCP client (config, transports, lifecycle) | [`mcp.md`](mcp.md) |
| Memory stores / skills | [`memory.md`](memory.md) / [`skills.md`](skills.md) |
| Config keys (`permission`, `allowPrefixes`, `context`, `compaction`, `tool_output`, `chat`, `titles`, `memory`, `extensions`) | [`config.md`](config.md) |
| Chat rendering, toasts, overlays | [`ui.md`](ui.md) |
| Keymap and slash dispatch | [`keybindings.md`](keybindings.md) |
| Daemon chat WS ops and the transport that drives a turn | [`daemon-api.md`](daemon-api.md) |
| Terminal pane state, scrollback, delivery probes | [`terminal-layer.md`](terminal-layer.md) |

## Scope & deliberate absences

- **Agents are postures, not subagents** — selecting an agent never launches a child
  session; one tab is one shell and one chat ([`agents.md`](agents.md)).
- **No Code Mode / `execute` tool** — tool composition is not sandboxed JavaScript.
- **No web fetch/search tools** — `web_fetch` is explicitly open in
  [`roadmap.md`](roadmap.md).
- **MCP is tools-only** — no resources/prompts/sampling, no OAuth-style remote auth
  ([`mcp.md`](mcp.md)).

## Gotchas & invariants

- **The harness is defensive.** Provider streams, tool-argument parsing, markdown, and
  context gathering never throw at the UI: failures surface as a toast, an error bubble,
  or a system note (AGENTS.md rule 10).
- **One tab = one PTY shell = one chat session**, daemon-hosted. Closing a tab detaches;
  typing `exit` in the pane ends the shell.
- **No bare counts.** The tool set lives in `src/agent/tools/specs.ts`; the tool-spec
  token estimate is computed from it at module load ([`agent-providers.md`](agent-providers.md),
  [`agent-context.md`](agent-context.md)).
- **The prefix cache is the health metric.** `/status`'s cached-token percentage catches an
  accidental rewrite of sent bytes; the append-only rule lives in
  [`agent-context.md`](agent-context.md).
- **Each subsystem owns its invariants.** They are stated once in their home doc (see the
  table above) and linked, not restated, here.

## Related docs

- [`agent-loop.md`](agent-loop.md) · [`agent-providers.md`](agent-providers.md) ·
  [`agent-tools.md`](agent-tools.md) · [`agent-approvals.md`](agent-approvals.md) ·
  [`agent-context.md`](agent-context.md) · [`agent-prompt.md`](agent-prompt.md)
- [`agents.md`](agents.md) — agent definitions (format, built-ins, selection)
- [`mcp.md`](mcp.md) — MCP tools merged beside the core tools
- [`config.md`](config.md) — endpoints, model overrides, `permission`, `context`, `chat`, `tool_output`
- [`ui.md`](ui.md) — chat rendering, toasts, overlays
- [`DESIGN.md`](DESIGN.md) — streaming/thinking presentation rules
- [`operations.md`](operations.md) — session persistence and resume
