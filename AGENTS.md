# Sensus — AGENTS.md

Sensus is a terminal you live in: a TUI (OpenTUI/Solid) that hosts a real, interactive
shell (on a native PTY, rendered by OpenTUI's embedded Ghostty VT) in a large left pane,
with an AI agent chat sidebar on the right. The agent sees terminal context, runs commands
in a hidden shell, and can drive the visible terminal on request. Run `sensus` from any
shell; `sensus init` runs the setup wizard.

**Read [`docs/architecture.md`](docs/architecture.md) first, then the doc for the
subsystem you are touching (map below).**

## Documentation map

The knowledge base lives in [`docs/`](docs/README.md) — always consult it before changing
code. Start at [`docs/architecture.md`](docs/architecture.md); each doc owns one subsystem.

| Doc | Covers | Read when… |
|---|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System map, module responsibilities, data flows, lifecycle, non-goals | Starting any work; orienting in the repo |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What sensus is, users, positioning, locked decisions, principles | Making a product/scope decision |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Layout regions, focus, theme tokens, color fidelity, do's/do not's | Changing anything visual or color-related |
| [`docs/config.md`](docs/config.md) | Config schema + resolution, settings screen, model/agent pickers, paths | Touching config, settings, endpoints, env/CLI |
| [`docs/extensions.md`](docs/extensions.md) | The public extension seam: `ApprovalPolicy` + `EventSink`/`UdsEventSink`, config | Touching approvals/events or the daemon's extension hooks |
| [`docs/agent.md`](docs/agent.md) | Agent harness hub: the loop at a glance, key files, routing to the subsystem docs | Starting harness work |
| [`docs/agent-loop.md`](docs/agent-loop.md) | Chat & tool loop: generation loop, busy sends, chat shortcuts, titles, no-tools mode, remote events, doom-loop guard | Touching the turn loop or chat UX |
| [`docs/agent-providers.md`](docs/agent-providers.md) | Providers & models: protocols, retries, idle timeout, no-tools latch, thinking modes, selected model, model catalog | Touching providers or model selection |
| [`docs/agent-tools.md`](docs/agent-tools.md) | Tools & execution: the core tool set, hidden shell/jobs, file tools, `shell_session`, truncation, sudo, images, session search, audit | Changing a tool or its execution |
| [`docs/agent-approvals.md`](docs/agent-approvals.md) | Approvals & permissions: modes, `permission`/`allowPrefixes`, destructive floor, read-only guard, plan card | Touching approvals or permissions |
| [`docs/agent-context.md`](docs/agent-context.md) | Context, compaction & caching: context block, checkpoints, pinned facts, prune, rewind, prompt caching, inspector/usage | Touching context or compaction |
| [`docs/agent-prompt.md`](docs/agent-prompt.md) | System prompt & streaming: prompt blocks, nearest-`AGENTS.md`, streaming/thinking display, truncation surfacing | Touching the prompt or streaming |
| [`docs/memory.md`](docs/memory.md) | Agent memory: MEMORY/HOST/JOURNAL stores, hard caps, frozen injection, safety | Touching memory, its tool, or the manager UI |
| [`docs/skills.md`](docs/skills.md) | Skills: `SKILL.md` format, progressive disclosure, skills tools | Adding/editing skills or their loader/tools |
| [`docs/sessions.md`](docs/sessions.md) | Sessions: JSONL transcripts, metadata sidecar (titles/tags), search, export | Touching session persistence, resume, or export |
| [`docs/agents.md`](docs/agents.md) | Agent definition files, built-ins, selection semantics | Adding/editing agents |
| [`docs/mcp.md`](docs/mcp.md) | MCP client: config, transports, lifecycle, approvals | Touching MCP |
| [`docs/terminal-layer.md`](docs/terminal-layer.md) | Terminal engine: native PTY, embedded VT renderable, scanner, input/focus, scrollback, adaptive pane palette, death | Touching the pane, the PTY, or terminal input |
| [`docs/keybindings.md`](docs/keybindings.md) | Keymap, Ctrl+A prefix, slash/command menus, click targets, overlays | Adding/remapping keys or click targets |
| [`docs/ui.md`](docs/ui.md) | Solid components, stores, chat rendering, toasts, overlays | Touching components or UI state |
| [`docs/architecture.md`](docs/architecture.md) §client | The TUI's daemon transport + remote objects | Touching `src/client/**` or the boot path |
| [`docs/operations.md`](docs/operations.md) | CLI, setup wizard, install, build & ship, persistence, lifecycle | Build, packaging, CLI, lifecycle |
| [`docs/events.md`](docs/events.md) | Instance identity (`instance.json`) + the durable local event log (schema v1), no-egress guarantee | Touching instance/events, `events.jsonl`, or `sensus events` |
| [`docs/triggers.md`](docs/triggers.md) | Local condition triggers: the `triggers` rules, `triggers.jsonl`, `sensus triggers tail`, `daemon install`/`uninstall` | Touching triggers, the persistent service unit, or `sensus triggers` |
| [`docs/daemon-api.md`](docs/daemon-api.md) | The `sensus daemon` (worker): REST surface, terminal WS envelope, auth, error shape, runtime/lifecycle (REST reference: Scalar at `/openapi`, generated from `src/daemon/apiSchemas.ts`) | Touching `src/daemon/**`, the daemon CLI, or the REST/WS API |
| [`docs/logging.md`](docs/logging.md) | Structured logging: the NDJSON envelope, levels + severity numbers, redaction, correlation, rotation, the reader API, `sensus daemon logs`, `SENSUS_LOG_LEVEL`/`SENSUS_LOG_STRICT` | Touching `src/core/log.ts`, `agent/log.ts`, `daemon/log.ts`, the logs CLI, or log records |
| [`docs/testing.md`](docs/testing.md) | Test layout, commands, philosophy, smoke-test rules, mocks, ship guards | Writing or debugging tests |
| [`docs/roadmap.md`](docs/roadmap.md) | Project status: what ships today + what is deliberately open | Checking what is shipped or open |

**When behavior changes, update every doc surface it touches, in the same change.** The
three surfaces have distinct audiences and must not drift:

- [`docs/`](docs/README.md) is the engineering knowledge base for contributors and agents:
  mechanism, key files, invariants. Dev docs may name files, functions, and env vars. The
  affected subsystem doc updates with the code.
- [`site/src/content/docs/`](site/src/content/docs) is the user manual published at
  <https://sensus.sh/docs>: what the user sees. User pages never name files, functions, env
  vars, or internal identifiers; update the page when a user can observe the change.
- [`README.md`](README.md) is the front door. Keep it short and linked into the manual: do
  not duplicate reference material (tables, schemas, command lists) the manual owns. Update
  it when install, the quick tour, or its links change.

A dev doc with a user page carries a `User guide:` line linking it
([`docs/TEMPLATE.md`](docs/TEMPLATE.md)). The code wins over any doc; if they disagree, fix
the doc. `tests/unit/docs/**` guards these surfaces (manifest and frontmatter, dev-doc
pointers, README links, generated reference freshness); run `bun test tests/unit/docs/`
after touching `docs/`, the manual, or the README.

## Locked decisions — do not relitigate

These were decided with the project owner. Full rationale: [`docs/PRODUCT.md`](docs/PRODUCT.md).

1. **Stack**: Bun + TypeScript, `@opentui/solid` renderer (Solid components over `@opentui/core`).
2. **Terminal engine**: embedded terminal, split two ways. The `sensus daemon` owns each
   shell on a native PTY (`Bun.Terminal` / `Bun.spawn({ terminal })`); the TUI owns the
   rendering via OpenTUI's `EmbeddedTerminalRenderable` (Ghostty VT). Sensus does NOT write
   its own VT emulator. tmux is not a runtime dependency (it remains only as an optional
   outer test driver).
3. **Agent shell**: agent commands run in a hidden shell (`shell_background`), never the
   visible pane. `shell_session` is the explicit "type into my visible terminal" tool.
4. **Provider**: the Vercel AI SDK (`ai`) with provider packages — the endpoints'
   `provider` kind selects `@ai-sdk/openai-compatible` (the default, OpenAI-compatible
   `/chat/completions`), `@ai-sdk/openai` (Responses API), `@ai-sdk/anthropic`, or
   `@ai-sdk/google` (SSE streaming + function calling owned by the SDK; sensus keeps the
   retry/degradation policy on the seam). No vendor SDKs *beyond* the AI SDK.
5. **Tabs in v1**: one tab = one PTY shell = one chat session, hosted by the daemon; the
   sidebar follows the active tab and a re-attached tab reconnects to its shell.
6. **Exit / detach**: the TUI is a frontend to the local `sensus daemon`. Quitting (or
   `Ctrl+A d`, or closing any tab with `Ctrl+W`/`×`) detaches; the daemon keeps the shells
   and agent turns alive and they are re-attachable on the next boot. Closing a tab never
   kills its shell; typing `exit` in the pane ends that shell. The daemon binds only a local
   Unix socket + loopback (never public; `SENSUS_DAEMON_HOST`/`SENSUS_DAEMON_PORT` are the
   off-by-default opt-in to bind a LAN/Tailscale address so another machine can reach the
   docs), grace-exits when idle unless run as the opt-in persistent service, and
   `sensus daemon stop` tears everything down and kills each PTY child.
7. **Approval default**: `confirm` — every tool call gets an inline card (reads included;
   `shell_session` types freely but every Enter is confirmed; `ask_user` renders its question
   inline) unless the user saved an allow rule (`allowPrefixes`, a `permission` rule, or
   session trust). `/yolo` flips.
8. **Custom instructions**: `~/.config/sensus/AGENTS.md`, loaded into the system prompt.
9. **Name**: binary `sensus`, config dir `~/.config/sensus/`, env prefix `SENSUS_`.

## Repo layout

The full module map is [`docs/architecture.md`](docs/architecture.md) §Key files; `docs/`
has one doc per subsystem. Top-level:

```
src/
  index.tsx · cli.ts · version.ts
  core/       cross-cutting primitives (keymap, command registry, util)
  config/     config load/resolve, configFile writes, agents, setup wizard
  theme/      theme tokens, palette detection, markdown style
  terminal/   terminal engine: headless PTY session + client renderable, byte scanner, key encoder (see docs/terminal-layer.md)
  session/    chat JSONL persistence + FTS5 search index
  agent/      chat loop, providers, tools, context, prompt, MCP (docs/agent.md + agent-*.md, agents.md, mcp.md)
  engine/     headless engine barrel + pure helpers the UI renders from (IF1; docs/architecture.md §engine)
  daemon/     the `sensus daemon` worker: Elysia REST app, auth, listeners, the terminal + chat WS channels, the shell registry, the lifetime policy, the instance identity + event log, lifecycle CLI (docs/daemon-api.md)
  client/     the TUI's daemon transport + remote objects: WS/REST clients, daemonEnsure, RemoteTerminalSession, RemoteChat, HostAdapter, attachPicker (docs/architecture.md §client)
  ui/         Solid components + chat rendering + pure helpers (docs/ui.md)
scripts/build.ts   standalone binary compile (docs/operations.md)
site/              the sensus.sh landing site (Astro 7, Bun-managed) + the /install Pages Function; the user manual is site/src/content/docs/ (docs/operations.md §Website)
tests/             unit (mirrors src/ 1:1) + smoke + mocks (docs/testing.md)
docs/              knowledge base — keep it updated with behavior
```

A few layers are split into a module directory behind their original public **barrel**
(`src/agent/tools.ts` → `src/agent/tools/`, `src/config/config.ts` → `src/config/config/`);
import the barrel, not the internals. The chat session and the large UI components likewise
delegate to focused modules under `src/agent/chat/` and `src/ui/{chat,lib}/`.

**The engine is headless**: `src/engine/**` (plus `agent/`, `config/`, `session/`,
`terminal/`) must never import `src/ui/**` — the dependency is one-way `ui → engine`, and
`tests/unit/engine/importGraph.test.ts` fails the suite if a leak reappears. The same guard
fails if an engine-side file imports `@opentui/core` (the one exception is
`src/terminal/session.ts`, the client renderable); the headless shell core is
`src/terminal/ptySession.ts`. Pure helpers
the UI renders from (`inputEditor`, `slashComplete`, `streamReveal`, `contextInspector`,
`usage`, `toast`, `spinner`, `fuzzy`) live in `engine/`; their old `src/ui/...` paths are
re-export barrels. The `src/engine/index.ts` barrel is the frozen engine surface (IF1).
The daemon (`src/daemon/**`) hosts that surface headlessly and must likewise never import
`src/ui/**` or `@opentui/core`; it imports the engine through the IF1 barrel.

## Commands

| Command | Purpose |
|---|---|
| `bun install` | install deps |
| `bun run dev` | run the TUI locally (interactive) |
| `sensus init` | interactive setup wizard (endpoint, model, theme) |
| `bun run build` | compile the standalone binary (`dist/sensus`; `--outfile` to redirect) |
| `./scripts/build-install.sh` | build this checkout + install to `$PREFIX/bin/sensus` (asks user vs global `-g`) |
| `./scripts/install-release.sh` | download a prebuilt release + install (`-g`, `--version`, `SENSUS_PREBUILT=<bin>` skips the download) |
| `curl -fsSL https://sensus.sh/install \| bash` | one-line release install (the site's `/install` serves the latest release's installer; no Bun needed) |
| `cd site && bun run dev` | run the website locally (Astro dev server) |
| `cd site && bun run check` · `bun test` · `bun run build` | site types · `/install` unit tests · production build |
| `bun run typecheck` | `tsc --noEmit` — MUST pass before declaring work done |
| `bun run test:unit` | unit suite only (~15s) — the iteration loop while working |
| `bun run test:smoke` | reaps stale test processes/sockets, then the smoke suite (~80s) |
| `bun test` | full suite — the final gate for behavior-affecting changes (see rule 6) |
| `bun run test:clean` | reap orphaned test processes + test tmux hosts under /tmp/sensus |
| `bun run lint` | optional if oxlint installed |

## Non-negotiable rules

1. **Read the relevant doc before editing code** — the map above tells you which.
2. **The code wins.** If code and docs disagree, fix the doc (and say so).
3. **Update every doc surface with code.** A behavior change updates, in the same change:
   the affected engineering doc in `docs/`, the user manual page in
   `site/src/content/docs/` when users can see it, and `README.md` when the front door
   changes. See §Documentation map.
4. **Write scenario-shaped tests, not per-branch micro-tests**; extend an existing test
   before adding one. The full policy and the never-delete keep-list are in
   [`docs/testing.md`](docs/testing.md).
5. **Always run the reaper around smoke runs** (`bun run test:clean`; `test:smoke` does it
   automatically). A killed test run leaves its tmux-driven app tree alive and can OOM the
   machine. Reap only PPID-1 orphans — never `pkill -f` patterns that match your own command.
6. **Typecheck always; run the suite the change needs.** `bun run typecheck` and
   `bun run test:unit` must pass before declaring done. Run the full `bun test` (smoke
   included) only when the change can affect runtime/app behavior — UI/render, terminal/PTY,
   boot/lifecycle/exit, persistence, config resolution, provider/MCP/process spawning, or
   packaging/build. Docs, comments, string/constant content (prompts, skill/agent bodies),
   and pure helpers already covered by unit tests need only typecheck + `test:unit`; say
   which gate you ran in the report. The full list is in
   [`docs/testing.md`](docs/testing.md) "When the full suite is required".
7. **The standalone binary is built by `scripts/build.ts`, not plain `bun build --compile`.**
   Keep the dual Solid transform registration and `compile.autoloadBunfig: false`; the ship
   guard (`tests/smoke/ship.test.ts`) protects both. Details: [`docs/operations.md`](docs/operations.md).
8. **No placeholder/TODO-only commits.** If a feature is partial, say so in the report.
9. **No destructive git** — no `git reset --hard`, `git checkout --`, or forced cleanups.
10. **The TUI must never crash on unexpected data** — wrap PTY/renderable parsing / provider
    streaming in defensive try/catch and surface errors as a toast, not an exception.
11. **`SENSUS_VERSION`/package.json and all `SENSUS_*` names move together.**
12. **TypeScript strict mode, ESM, named exports only** (default export allowed only in
    `src/index.tsx`); no `any` unless justified in a comment.

## Workflow

- **Use subagents for bigger tasks** — delegate research, multi-file changes, and
  verification sweeps while you act as orchestrator and review the output.
- **Iteration loop:** `bun run typecheck` + `bun run test:unit`. **Final gate:** `bun test`
  only for behavior-affecting changes (the list is in [`docs/testing.md`](docs/testing.md));
  otherwise typecheck + `test:unit` is enough. Run `bun run test:clean` around smoke runs.
- **Verify UI changes in a tmux driver**, not by reading code — the full smoke-test pattern
  and all hard-won rules are in [`docs/testing.md`](docs/testing.md). The short version:
  boot at `-x 200 -y 50` in an outer tmux, prefer disappearance/transition waits over bare
  appearance waits, and give every boot its own outer socket/scratch dir.

## Runtime environment

- No tmux at runtime. The left pane is a native PTY (`Bun.Terminal`) rendered by OpenTUI's
  embedded VT; the native artifact supports x86_64/aarch64 on macOS and Linux
  (glibc/musl). The PTY path is POSIX-only.
- Bun ≥ 1.4.2 is required to run (not just build): the app uses `Bun.Terminal` /
  `Bun.spawn({ terminal })` at runtime. If `bun install` blocks on engine checks, run
  `bun upgrade` first.
- Building the standalone binary needs the same floor: bun 1.4.1's bundler emits an
  invalid binary for Elysia's schema module (it dies at startup with a `SyntaxError`
  before `main()`), so the repo has a single **bun ≥ 1.4.2** floor for dev and build
  (docs/operations.md "Build & ship").
- tmux is optional: the smoke suite uses an outer tmux as a driver only.
- A terminal of at least 20×5 is required; a smaller one refuses to boot with a clear
  message.
