# Roadmap

## Overview

Where Sensus is today and what is deliberately not on the near-term list. This page tracks
status only — current behavior is documented in the canonical subsystem docs linked below.

## Status

Sensus ships as native standalone binaries (`sensus-linux-x64`, `sensus-linux-arm64`,
`sensus-darwin-arm64`, `sensus-darwin-x64`) for Linux and macOS on x86_64/aarch64, released
automatically when the `package.json` version changes and installable with one line
(`curl -fsSL https://sensus.sh/install | bash`); the version lives in `package.json`.
Building from source needs Bun ≥ 1.4.2. The site lives in `site/`
([`operations.md`](operations.md) §Website).
The shipped surface:

- **`sensus` (TUI):** one native PTY shell per tab, an agent chat sidebar, approvals,
  agents, memory, skills, sessions, MCP, themes and settings. System map:
  [`architecture.md`](architecture.md); each subsystem has its own doc.
- **`sensus daemon` (worker):** owns the shells and agent turns, re-attachable across client
  restarts. REST/WS contract and lifecycle: [`daemon-api.md`](daemon-api.md).
- **CLI:** `sensus init`, `sensus secrets`, `sensus --export`, `sensus update` (alias
  `upgrade`), `sensus daemon …`, and the optional persistent service.
  [`operations.md`](operations.md) has the full list.

## Open / post-v1

Explicitly not scheduled: a background-jobs view, a `web_fetch` tool, `@`-file mentions,
themes beyond the built-ins, multiple visible panes (splits), and SSH remote mode. The MCP
non-goals live in [`mcp.md`](mcp.md).

## Related docs

- [`architecture.md`](architecture.md) — how the shipped system fits together
- [`operations.md`](operations.md) — CLI, install, build & ship, lifecycle
- [`../AGENTS.md`](../AGENTS.md) — how work is routed and verified
