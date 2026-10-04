# MCP Support

## Overview

Sensus can connect to Model Context Protocol (MCP) servers and expose their tools to the
chat agent beside the core tools ([`agent.md`](agent.md); the specs live in
`src/agent/tools/specs.ts`). The client is hand-rolled (JSON-RPC
2.0 over stdio or streamable HTTP) — no MCP SDK, the same philosophy as the provider seam.

User guide: https://sensus.sh/docs/mcp/

## Key files

| File | Purpose |
|---|---|
| `src/agent/mcp/types.ts` | Config + wire types; `expandEnvRefsMap`; timeout default |
| `src/agent/mcp/jsonrpc.ts` | Request/response correlation over a transport |
| `src/agent/mcp/stdio.ts` | Subprocess transport (newline-delimited JSON-RPC; stderr captured) |
| `src/agent/mcp/http.ts` | Streamable-HTTP transport (JSON or SSE answers, session-id echo) |
| `src/agent/mcp/registry.ts` | Instance-wide lifecycle: connect, list, dispatch, restart, stop |
| `tests/mocks/mockMcpServer.ts` | Mock stdio server for tests |
| `tests/unit/agent/mcp/registry.test.ts` | End-to-end stdio + HTTP coverage |

Protocol revision: `2025-06-18`.

## Configuration

MCP servers live under `mcp.servers` in `~/.config/sensus/config.json`:

```json
{
  "mcp": {
    "servers": {
      "playwright": {
        "command": "npx",
        "args": ["@playwright/mcp@latest"],
        "cwd": "${HOME}/pw-scratch"
      },
      "firecrawl": {
        "url": "https://mcp.firecrawl.dev/mcp",
        "headers": { "Authorization": "Bearer ${FIRECRAWL_API_KEY}" }
      }
    }
  }
}
```

A server entry is exactly ONE of:

- **stdio** — `command` (+ `args`, + `env`, + `cwd`). Sensus spawns the process and speaks
  newline-delimited JSON-RPC over stdin/stdout (stderr captured, never inherited).
  `env` values are merged over the process environment. `cwd` sets the child's working
  directory; it never inherits sensus's own cwd (see the table below).
- **http** — `url` (+ `headers`). Streamable HTTP: each JSON-RPC message is a POST;
  responses may be `application/json` or `text/event-stream`; a `Mcp-Session-Id` response
  header is captured from any response and echoed on later requests; `close()` DELETEs the
  session.

Common keys:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` skips the server entirely (kept in the file) |
| `timeout_s` | `60` | Per-request timeout (initialize, tools/list, tools/call); clamped to 600 max; values below 1 warn and use the default |
| `cwd` | `<cache>/mcp/<server>/` | **stdio only**: the child's working directory. A relative path resolves against the config dir (`~/.config/sensus`); an absolute path is used as-is. The default is a stable per-server dir under the cache dir (mkdir -p, best-effort), so servers that write scratch files (e.g. `@playwright/mcp`'s `.playwright-mcp/`) never litter the directory sensus was launched from. If that dir cannot be created the default falls back to `os.tmpdir()`. The cache dir is `${SENSUS_CACHE_DIR}` → `${SENSUS_HOME}/cache` → `~/.cache/sensus`. The per-server cache dir is scratch space: files under `<cache>/mcp/` older than 7 days are pruned at startup (hourly-throttled, best-effort), while the directories themselves are kept. |

`${VAR}` references in `env`/`headers`/`cwd` values expand at config-resolution time from
the encrypted secrets store first, then the process environment (docs/config.md "Secrets").
A missing variable expands to the empty string with a one-time warning — API keys can live in
the store (`sensus secrets set FIRECRAWL_API_KEY …`) or the environment instead of the file.

Invalid entries (neither or both of `command`/`url`, a bad URL) warn and are SKIPPED — an
MCP misconfiguration never blocks boot, the same rule as unknown config keys. Unknown keys
inside a server entry warn once.

## Tool exposure

- Every server tool becomes an OpenAI function spec named `mcp__<server>__<tool>`
  (sanitized; over-long names get a stable hash suffix under OpenAI's 64-char cap). Spec
  names are deduped against the core tool specs (`src/agent/tools/specs.ts`) and across
  servers with a `_N` suffix, so a request never carries duplicates — a colliding tool is
  then not callable under its real name.
- Specs are merged into every request: the agent-filtered core specs (the agent's `tools`
  list narrows `TOOL_SPECS`) plus the connected servers' specs. The session's `noTools`
  latch drops MCP specs with the core ones — a no-tools session sends no MCP specs either.
- The system prompt lists connected servers and their tools.
- An agent's `tools` list filters MCP tools ([`agents.md`](agents.md)).

## Lifecycle

- **Lazy**: nothing spawns at boot. At the start of a generation the registry connects
  every enabled-but-unconnected server in parallel (`initialize` →
  `notifications/initialized` → `tools/list`, with cursor pagination) and caches the specs
  for the instance. Esc aborts the connection attempt.
- **Failure isolation**: a server that fails to start or times out drops its tools, toasts,
  and leaves a system note once; chat continues with the remaining tools. It is retried
  after a bounded exponential backoff (base 2s, cap 60s, `mcpRetryDelayMs`) —
  lazily/non-blocking, skipped by generations until the deadline passes; a successful
  connect clears the backoff and a config change (`/reload` rebuild) resets it. A server that
  dies mid-run drops its tools silently — the failing `tools/call` surfaces the error, and
  dead servers are skipped by later generations until the retry deadline. The next `mcp__`
  call to a dead server retries the connection once.
- **`/reload`**: `restartChanged()` diffs the new `mcp` config — changed servers are
  stopped and reconnect lazily on the next message; added/removed/enabled/disabled entries
  toast.
- **Exit**: `stopAll()` runs on shutdown — stdio children are killed with their process
  group, and HTTP sessions are DELETEd. Orphaned `npx` servers must not survive.

## Execution

- `mcp__<server>__<tool>` calls route through `tools.ts` `executeTool` → registry
  `tools/call`. Result content blocks flatten to text (text verbatim; image/audio/resource
  blocks become one-line notes), capped at ~16k chars head+tail for the model (card
  previews stay ~1.2k).
- Approvals follow the standard policy ([`agent-approvals.md`](agent-approvals.md)): MCP tools
  gate in `confirm` mode and auto-run in `full-auto`. They are never allow-prefixable —
  prefixes are shell commands.
- `isError` results return `ok:false`, so the model sees the failure text like a failed
  command.

## UI

- `/mcp` lists every configured server with status (`idle · starting · connected · failed ·
  disabled`), transport line, and tool counts.
- `/mcp on|off` is a session toggle; when off, no MCP specs are sent and no connections are
  attempted (mirrors `/context on|off`).
- **MCP manager** (Ctrl+P → "MCP servers", or the status-bar `mcp:` chip): an overlay
  listing every configured server. Toggling one persists its config `enabled` flag; the host
  writes it to `config.json` and reloads, so the choice is **global** (it survives relaunches
  and applies to every session) and applies live — a disabled server is stopped and its tool
  specs drop from later requests, which is how the popup saves context. This is per-server;
  `/mcp on|off` is the separate session-wide switch.
- `/status` carries an `mcp:` summary segment (connected over ENABLED servers — a
  config-disabled entry is not counted as "not connected").
- The **status bar** `mcp:` chip is the manager's entry point, so it is shown whenever MCP is
  on for the session and at least one server is configured — **including before the first
  message**, when every server is still `idle`: nothing attempted yet shows the enabled count
  (`mcp:3`), and every server deliberately off shows `mcp:0` (still clickable, so one can be
  turned back on). One connected server shows its name (`mcp:playwright`), several collapse
  to a count (`mcp:2`), and a connected/failed mix warns (`mcp:2/3`). It is hidden only when
  MCP is off for the session or nothing is configured, and it repaints live as servers
  connect, fail, or die mid-run (the registry's status signal).
- Tool cards render like any other call (name, JSON params peek, output preview, `Alt+E`
  expansion).

## Gotchas & invariants

- **One transport per entry, always.** `command` XOR `url`; both/neither skips the server.
- **Connection is lazy and cached for the instance** — a `/reload` config change restarts
  lazily, it does not eagerly reconnect.
- **stdio children die by process group** (`setsid`); a plain kill can leave an `npx`
  grandchild holding a pipe.
- **stdio children never inherit sensus's cwd** — each gets an explicit resolved dir
  (`cwd` or `<cache>/mcp/<server>/`); see "Configuration".
- **The per-server cache dir is scratch** — files under `<cache>/mcp/` older than 7 days are
  pruned at startup (hourly-throttled, best-effort); directories are kept.
- **MCP tools are never allow-prefixable** — only shell commands carry prefixes.
- **Name collisions are deduped, not resolved** — a colliding tool may be uncallable under
  its real name.

## Non-goals (v1)

MCP resources / prompts / sampling (tools only) · the server→client GET stream (async
notifications; `tools/list_changed` works on stdio only) · passing image blocks through to
the model · editing `args`/`env`/`headers` from the settings screen (the settings MCP
category handles servers, transport target, enabled and timeout; the rest is edited in the
file + `/reload`) · OAuth-style remote auth (static headers only).

## Related docs

- [`agent-loop.md`](agent-loop.md) / [`agent-approvals.md`](agent-approvals.md) /
  [`agent-prompt.md`](agent-prompt.md) — the tool loop, approvals, and system prompt
- [`agents.md`](agents.md) — per-agent tool filtering
- [`config.md`](config.md) — the `mcp` config section
- [`testing.md`](testing.md) — the mock MCP server and registry tests
