---
title: MCP
description: Connect external tool servers so the agent can use their tools, with the same approvals as everything else.
order: 11
---

MCP (the Model Context Protocol) is an open standard for giving AI assistants tools. Sensus can
connect to MCP servers (programs it launches on your machine, or remote endpoints you configure),
and their tools join the agent's toolbox beside the built-ins. Every MCP tool call goes through
the same approval flow as the rest of the agent's actions; see [Approvals](/docs/approvals/).

## Adding a server

Servers live under `mcp.servers` in your configuration (`~/.config/sensus/config.json`). A
server is either local (Sensus launches a command and talks to it) or remote, an HTTP endpoint:

```json
{
  "mcp": {
    "servers": {
      "playwright": {
        "command": "npx",
        "args": ["@playwright/mcp@latest"]
      },
      "firecrawl": {
        "url": "https://mcp.firecrawl.dev/mcp",
        "headers": { "Authorization": "Bearer ${FIRECRAWL_API_KEY}" }
      }
    }
  }
}
```

- A local server needs `command`, plus optional `args`, `env`, and `cwd`.
- A remote server needs `url`, plus optional `headers`.
- A `${NAME}` value is resolved from your encrypted secrets store first, then the environment, so
  keys don't have to sit in the file. `sensus secrets set FIRECRAWL_API_KEY <value>` stores one.
- `enabled: false` keeps a server in the file but skips it. `timeout_s` adjusts the per-request
  timeout.

Sensus launches local servers in their own scratch directory rather than the folder you started
Sensus from. A malformed entry is skipped with a warning; a bad server never blocks startup. Run
`/reload` after editing the file by hand.

## How tools appear

Each server tool becomes `mcp__<server>__<tool>`, for example `mcp__playwright__browser_navigate`.
They ride in the agent's requests next to the built-in tools, and the agent is told which servers
are connected. Agents with restricted tool lists can narrow them further; see
[Agents](/docs/agents/).

## Connecting and failing safely

Nothing starts at boot. Sensus connects enabled servers in parallel the first time the agent needs
to think after you add or enable one, and caches the connection. `Esc` cancels a connection
attempt.

A server that fails to start or times out loses its tools with a note in the chat; the
conversation continues with everything else. Failed servers are retried later in the background.
A server that dies mid-conversation doesn't take the others down: the call that hit it reports
the error, and a later call can reconnect it.

## Controlling what's connected

- `/mcp` prints each server's status (`idle`, `starting`, `connected`, `failed`, `disabled`), its
  transport, and its tool count.
- `/mcp off` turns MCP off for the current session: no MCP tools are sent and no connections are
  attempted. `/mcp on` turns it back on.
- The `mcp:` chip in the status bar (or Ctrl+P → "MCP servers") opens a manager where you can
  toggle individual servers. These toggles are saved to your configuration, apply to every
  session, and survive restarts. Turning a server off is a quick way to save context.

## Approvals

MCP tools are gated exactly like built-in tools: in **confirm** mode each call gets a card, and in
**full-auto** they run without one. They are never covered by shell allow-prefixes, but
`permission` rules can allow, ask, or deny them by matching `mcp__server__*`; see
[Approvals](/docs/approvals/) and [Configuration](/docs/configuration/).

## What MCP does not cover

- Tools only: MCP resources, prompts, and sampling aren't supported.
- Server-initiated notifications (such as a tool list changing) work for local servers; remote
  HTTP servers don't get a push channel.
- Images a server returns aren't passed to the model; you get a text note in their place.
- Remote servers use static headers: there is no OAuth-style sign-in flow.
- The settings screen edits a server's transport target, enabled flag, and timeout; `args`,
  `env`, and `headers` are edited in the configuration file.

## Next steps

- [Approvals](/docs/approvals/): the card model and permission rules
- [Tools](/docs/tools/): the built-in toolbox MCP tools join
- [Configuration](/docs/configuration/): the full `mcp` reference
- [Agents](/docs/agents/): restrict which tools an agent may use
