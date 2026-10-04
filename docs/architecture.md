# Architecture

## Overview

Sensus is a fullscreen TUI. Its left pane is a real shell running on a **native PTY**
rendered by OpenTUI's embedded terminal (Ghostty VT); its right pane is an agent chat.
Sensus is started by running `sensus` from a shell, spawns one PTY shell per tab, and hands
control back to the plain shell when it exits (the last pane exiting quits sensus). There
is no tmux server.

Work is splitting the process in two (D1/D15): `sensus daemon serve` hosts the engine
headless behind a loopback-only HTTP/WS API, and the TUI becomes a thin client. P3 ships
the daemon's REST surface and lifecycle; the client cutover is P4. Until then the TUI still
runs the engine in-process. See [`daemon-api.md`](daemon-api.md).

This doc is the system map: what the modules are, how data flows, and what the lifecycle
is. Each subsystem has a theme doc that owns its depth (linked throughout).

## Key files

Every source file has one job; the module table below maps directories to their theme
doc. The per-module sections that follow name the individual files.

| Path | Purpose | Depth doc |
|---|---|---|
| `src/index.tsx` | Entry: CLI dispatch, config load, `--resume`, boot UI (App spawns the first PTY) | this doc (Lifecycle) |
| `src/cli.ts` | Headless entry points (`--help` / `--version` / `init` / `secrets` / `update` / `daemon`) + nest guard | [`operations.md`](operations.md), [`daemon-api.md`](daemon-api.md) |
| `src/version.ts` | Re-exports package.json's version (single source of truth) | [`operations.md`](operations.md) |
| `src/update.ts` | `sensus update`/`upgrade` + the cached launch update alert | [`operations.md`](operations.md) |
| `src/core/` | Cross-cutting primitives: keymap, command registry, shared helpers | [`keybindings.md`](keybindings.md), this doc |
| `src/config/` | Config load/resolve, settings writes, agent definitions, setup wizard | [`config.md`](config.md), [`agents.md`](agents.md) |
| `src/theme/` | Theme token maps, palette detection, persistence, markdown style | [`DESIGN.md`](DESIGN.md) |
| `src/terminal/` | The terminal engine: headless PTY session (`ptySession.ts`) + renderable wiring (`session.ts`), byte scanner/ring, key encoder | [`terminal-layer.md`](terminal-layer.md) |
| `src/session/` | Chat JSONL persistence + the SQLite FTS5 session search index | [`sessions.md`](sessions.md), [`operations.md`](operations.md) |
| `src/agent/` | Provider seam, tool loop, tools, context, prompt, slash, memory, MCP | [`agent.md`](agent.md), [`agents.md`](agents.md), [`memory.md`](memory.md), [`mcp.md`](mcp.md) |
| `src/engine/` | Headless engine barrel + the pure helpers the UI renders from (chat/input/context/toast/spinner/fuzzy). `ui → engine` one-way | this doc (engine), [`agent.md`](agent.md), [`ui.md`](ui.md) |
| `src/daemon/` | The daemon (worker): Elysia REST app, bearer auth, token/paths, UDS + loopback listeners, the terminal + chat WS channels, the instance identity + event log, and the `sensus daemon` lifecycle | this doc (daemon), [`daemon-api.md`](daemon-api.md), [`events.md`](events.md) |
| `src/ui/` | Solid components, chat rendering, pure UI helpers/stores | [`ui.md`](ui.md), [`keybindings.md`](keybindings.md) |
| `scripts/build.ts` | Standalone binary compile | [`operations.md`](operations.md) |
| `bin/sensus.js` | npm-style run-from-source launcher (`package.json` `bin`) | [`operations.md`](operations.md) |
| `scripts/install-release.sh` | Public release installer: download + checksum + install to `$PREFIX/bin` (served at `sensus.sh/install`) | [`operations.md`](operations.md) |
| `scripts/build-install.sh` | Checkout build installer (`bun run build`, then delegates to `install-release.sh`) | [`operations.md`](operations.md) |
| `site/` | The sensus.sh landing site (Astro 7, Bun-managed) + the `/install` Pages Function | [`operations.md`](operations.md) |
| `tests/` | Unit + smoke suites, mocks, shared harness | [`testing.md`](testing.md) |

## System map

```
outer zsh (the user's terminal)
└── sensus (bun process, fullscreen alt-screen)
    ├── one native PTY shell per tab (Bun.Terminal; rendered by EmbeddedTerminalRenderable)
    ├── hidden agent shells (per-call `bash -lc`; own process group so abort kills the tree)
    ├── MCP servers (stdio children / remote HTTP sessions)
    └── UI (opentui/solid): TabBar / TerminalPane / ChatSidebar / StatusBar / overlays / toasts
```

The one hard boundary: **sensus does not emulate a terminal.** OpenTUI's embedded VT
(Ghostty) owns the screen, cursor, colors, and scrollback for the PTY; sensus only scans
the byte stream for status facts and the agent's text tail.

## Module responsibilities

### `core/`

| File | Purpose |
|---|---|
| `util.ts` | Tiny shared pure helpers (`errorMessage`, `isRecord`, `cps`, `truncate`, `fnv1a`, `rgbToHex`, `atomicWriteText`, key idioms) |
| `image.ts` | Image attachments: magic-byte sniffing, dimensions, content-addressed asset store, defensive JSONL parsing (docs/agent.md "Images") |
| `keymap.ts` | The default hotkey table + `KeyActionId`s; `parseKeySpec`/`specLabel`/`resolveKeymap`/`matchKey`/`findAction` (pure, unit-tested) |
| `keymapRuntime.ts` | Installs the keymap over the renderer via `@opentui/keymap`; consumed keys never reach App's dispatch |
| `commandCatalog.ts` | The single command registry (label/description/category/slash per command) driving the Ctrl+P palette and keymap metadata |
| `log.ts` | Structured logging core: the NDJSON `LogRecord` envelope, `Logger`/`createLogger`/`getLogger`/`configureLogger`, levels + severity numbers, redaction, correlation, rotation, the pretty console renderer, `readLogFile`/`parseLogLine` (docs/logging.md) |

The keymap↔catalog invariant is enforced by tests: every keymap action has exactly one
registry row, and every slash hint exists in `SLASH_COMMANDS`. See
[`keybindings.md`](keybindings.md) for dispatch order and the opentui quirks.

### `config/`

| File | Purpose |
|---|---|
| `config.ts` + `config/` | Config layer: `config.ts` is the public barrel over `config/` — schema types, defaults, path helpers, args, MCP parsing, resolution order, active accessors |
| `configFile.ts` | Settings-screen writes: patch the parsed document → atomic write + one-time `.bak`; never throws |
| `agents.ts` | Agent markdown definitions: frontmatter parser, loader, built-in materialization |
| `wizard.ts` | Pure setup-wizard logic (in-app modal; step machine, validation, draft→config, host seed) |

Full schema, resolution order, and the settings screen are in [`config.md`](config.md);
agent format is in [`agents.md`](agents.md).

### `theme/`

| File | Purpose |
|---|---|
| `themes.ts` | The `ThemeTokens` contract + the built-in theme registry (`THEME_NAMES`, `THEME_DEFS`, kind helpers) |
| `theme.ts` | Re-exports the registry + owns active-theme signals, adaptive resolution, style-prop helpers |
| `themePalette.ts` | OSC 4/10/11 detection results, indexed-accent derivation, softened accents, the Konsole OSC-4 lie fingerprint, config palette overrides |
| `konsoleScheme.ts` | KDE (Konsole/Yakuake) color-scheme reader: profile via `KONSOLE_PROFILE_NAME` / session D-Bus / `konsolerc`, else OSC-10/11 fg+bg fingerprint of installed `.colorscheme` files (`Color0`-`Color7` normal + `ColorNIntense` bright + fg/bg), used when the OSC-4 lie is detected |
| `themePersist.ts` | Theme switch: validate → apply live → persist to config |
| `markdownStyle.ts` | `SyntaxStyle` for the native `<markdown>` renderable, derived from theme tokens |

The token contract, color-fidelity rules, and do's/don'ts are canonical in
[`DESIGN.md`](DESIGN.md).

### `terminal/`

One shell per tab on a native PTY; OpenTUI's embedded VT renderable owns the screen.

| File | Purpose |
|---|---|
| `ptySession.ts` | `PtySession` + `TerminalStatus` + `PtySessionOptions`: the **renderer-free** PTY core (no `@opentui/core`) — `Bun.Terminal` + `Bun.spawn({ terminal })`, the SGR-rewrite → scanner output pipeline, the input reply-leak guard, resize, status facts, the plain-text ring, `onOutput`/`onExit`/`kill()` |
| `session.ts` | `TerminalSession` (client): builds on `PtySession`, mounts the `EmbeddedTerminalRenderable`, pipes its output in and its `onData` out, and owns the `PanePainter` theming hook, focus/blur, paste, and the cursor-bearing `status()`/`paneState()` |
| `launch.ts` | `shellLaunchArgv`: launches the pane shell so the PTY is its controlling terminal (bash claims the tty, then `exec`s the real shell) |
| `shellIntegration.ts` | Generated zsh/bash startup files + `ZDOTDIR`/`--rcfile` plan so the pane shell reports `$PWD` via OSC 7 (fish does this natively) |
| `scan.ts` | `StreamScanner` + `TextRing`: incremental OSC/CSI scanner for the plain-text ring, title, OSC 7 cwd, and alt-screen flag |
| `sgr.ts` | `SgrColorRewriter` + `buildPanePalette`: rewrites indexed output SGR to truecolor from the detected/override palette and re-applies the theme default **fg** on resets before the VT sees it (the default bg is painted by `paneBg.ts`; pure, never throws) |
| `paneBg.ts` | `PanePainter` + `paintDefaultBackground`: in the renderable's `renderAfter` hook, remaps frozen theme/palette colors to the current ones and repaints the VT's opaque-black default cells, so existing content follows the theme across resize and theme switches (pure) |
| `keys.ts` | `KeyAction` vocabulary, opentui key → action mapping, action → raw PTY byte encoding |

The full engine spec (PTY wiring, the scanner contract, input/focus, native scrollback,
the adaptive palette rewrite, and the verified gotchas) is in
[`terminal-layer.md`](terminal-layer.md).

### `session/`

| File | Purpose |
|---|---|
| `store.ts` | JSONL session files: event types, `SessionFile`, `loadSessionFile`, `listRecentSessions`, `listAllSessions`, `makeInstanceId` |
| `meta.ts` | Session metadata sidecar: title/tags/rename + `sessionToMarkdown` export (docs/sessions.md) |
| `indexDb.ts` | SQLite FTS5 session search index (`SessionIndex`) backing `session_search` / `session_list` / `session_view` (the `/sessions` overlay reads the daemon REST list, not the index) |

One JSONL file per chat session at `<data>/sessions/<instance>/<tab-n>.jsonl`
(`<data>` = `~/.local/share/sensus`, redirected wholesale by `SENSUS_HOME`). The instance
id is stable for a run, fresh per run. Events: `session_start`, `user_message`
(content + optional `images` attachment records — [`agent.md`](agent.md) "Images"),
`assistant_message` (content, thinking, model, usage, aborted), `slash_command`,
`tool_call`, `compaction`, and `revert` (a chat rewind marker; [`ui.md`](ui.md)
"Rewind"). Writes are synchronous and never throw (disk failures are
counted, not crashed on); corrupt lines are skipped with a warning on load. A fresh
transcript is **lazy** — a tab with no sent message stores nothing (only `slash_command`
events are buffered until the first content record), so empty `(empty session)` files are
never created and zero-message transcripts are ignored by listings and the index
([`sessions.md`](sessions.md) "Empty sessions are not stored"). `/clear`
rotates to a new file generation (`tab-1.jsonl` → `tab-1-2.jsonl`) and keeps the old one.
Resume rebuilds the provider history from the **last** `compaction` checkpoint plus the
records after it. Details: [`operations.md`](operations.md).

A SQLite FTS5 index (`indexDb.ts`, `<state-dir>/sessions-index.sqlite`) is built from these
files so `session_search` / `session_list` / `session_view` and the `/sessions` overlay can
search and page every past transcript;
ingest reuses `loadSessionFile`, refreshes on mtime change, and degrades to `[]` on any DB
error. The state dir is `$SENSUS_STATE | $SENSUS_HOME | ~/.local/state/sensus`; there is
no detached-server registry (detach/reattach was removed with tmux).

### `agent/`

See [`agent.md`](agent.md) for the provider seam, tool loop, tools, approvals, sudo,
context/compaction, streaming, and the system prompt. File map:

| File | Purpose |
|---|---|
| `chat/chatSession.ts` | Per-tab chat state machine + the generation loop |
| `chat/chatMessages.ts` | Pure chat data model: message/card types, deps interfaces, `recordsToMessages`, `/help` text |
| `chat/chatHost.ts` | UI-facing deps/wiring seam over sessions; protocol-aware provider memoization per endpoint |
| `chat/compaction.ts` | Context management: estimates, summary-serialization clipping, checkpoint compaction |
| `chat/contextAccounting.ts` | Context-window limit/estimates/token breakdown + the system-prompt token memo |
| `chat/promptComposer.ts` | Input editor, prompt history ring, draft images, slash-autocomplete state |
| `chat/slashDispatch.ts` | Slash-command dispatch (`dispatchSlash` + its `SlashHost`) |
| `chat/toolCardBook.ts` | Tool-card bookkeeping, approval/ask waits, session allow-prefixes |
| `provider/provider.ts` | Provider seam + factory (mock vs the endpoint's protocol) |
| `provider/protocols.ts` | The protocol seam: provider kinds, per-protocol default baseURLs, AI SDK model construction, reasoning mapping |
| `provider/aiSdkProvider.ts` | Vercel AI SDK client (streaming, retries, no-tools degradation on openai-compatible) |
| `provider/modelCatalog.ts` | Model catalog: protocol-aware endpoint listing + models.dev enrichment + endpoint-reported metadata + config overrides |
| `mcp/` | Hand-rolled MCP client (see [`mcp.md`](mcp.md)) |
| `memory/` | Agent memory stores, caps, safety + tool/host-scan bridges (see [`memory.md`](memory.md)) |
| `skills/` | Skill loader + progressive-disclosure index (see [`skills.md`](skills.md)) |
| `tools.ts` + `tools/` | The tool layer: `tools.ts` is the public barrel over `tools/` — specs, hidden shell/jobs, sudo, diff/file plans, approval, executors, summaries |
| `extensions.ts` | The public extension seam (`ApprovalPolicy` + `EventSink`/`UdsEventSink`); the daemon consumes it (see [`extensions.md`](extensions.md)) |
| `truncate.ts` | Tool-output truncation: boundary cap + full-text spill with a `read_file` pointer |
| `instructions.ts` | Config `instructions` resolution (paths/globs/URLs) + nearest-AGENTS.md walk |
| `context.ts` | Terminal context block builder |
| `prompt.ts` | System prompt assembly |
| `slash.ts` | Slash command parsing + the `SLASH_COMMANDS` table |
| `markdown.ts` | Chat markdown segmentation (per-line click-to-paste safe) |
| `processUtil.ts` | Shared process management: `haveSetsid`, `killProcessTree`, `abortableSleep` |
| `log.ts` | `componentLogger`: the agent-side lazy child logger over `core/log.ts` (docs/logging.md) |

### `engine/`

The headless core: everything sensus can do with no renderer. The dependency is strictly
one-way `ui → engine` — nothing under `agent/`, `config/`, `session/`, `terminal/`, or
`engine/` imports `src/ui/**` (enforced by
[`tests/unit/engine/importGraph.test.ts`](../tests/unit/engine/importGraph.test.ts)). A
daemon (or a unit test) hosts the engine by importing `src/engine/index.ts` and driving a
turn; the frozen export surface (IF1) is reviewable in that file.

| File | Purpose |
|---|---|
| `index.ts` | The IF1 barrel: chat (`ChatSession`/`ChatHost`), sessions, memory, skills, MCP, tools/approvals, extensions, audit, host scan, usage, config, the headless terminal (`PtySession` + scanner), and the moved pure helpers below. No `@opentui/core` reachable from it |
| `chat/inputEditor.ts` | Multi-line input editor state (cursor, word wrap, visual↔logical mapping) — moved down from `ui/chat/` |
| `chat/slashComplete.ts` | Slash autocomplete filter/window math — moved down from `ui/chat/` |
| `chat/streamReveal.ts` | Streamed-text reveal pacing state — moved down from `ui/chat/` |
| `chat/contextInspector.ts` | `ContextBreakdown`/`ContextHistoryEntry` shapes + the pure inspector row/window math — moved down from `ui/chat/` |
| `chat/usage.ts` | Pure usage roll-ups/chart/legend for the usage dashboard — moved down from `ui/chat/` |
| `toast.ts` | `ToastLevel` + toast TTL/glyph/severity policy and panel wrap math — moved down from `ui/lib/` |
| `spinner.ts` | Shared 80ms braille animation tick — moved down from `ui/lib/` |
| `fuzzy.ts` | Subsequence/substring fuzzy scoring — moved down from `ui/lib/` (`config/wizard` needs it) |

The original `src/ui/...` locations are re-export barrels so existing UI imports keep
working; the engine side owns the implementation (one definition, no drift). The agent
chat loop is the transport-agnostic core: it emits through callbacks/signals and exposes
`ChatSession.gateDecision` as the single approval-enforcement point (`docs/agent.md`
"Approval modes"); a socket-driven turn cannot bypass it. `ChatSession.subscribe`
(IF3; [`agent.md`](agent.md) "Remote approval & event stream") is the
transport-agnostic `ChatEvent` stream a non-UI host mirrors, so the daemon reads no
Solid signals.

### `daemon/`

The daemon (worker) hosts the engine headless (docs/daemon-api.md). It is a **mode of
the `sensus` binary** — `sensus daemon serve` — not a separate artifact (D15): the
`elysia` app, the bearer auth, the runtime-dir helpers, and the lifecycle CLI all live
under `src/daemon/**` (D18).

| File | Purpose |
|---|---|
| `app.ts` | `createDaemonApp`: the Elysia app (health/info/config/agents/skills + the memory/sessions/audit resources) and the defensive JSON `onError` |
| `auth.ts` | Constant-time bearer auth (`bearerAuth` global hook); every request is gated |
| `token.ts` · `paths.ts` | `0700` dir + `0600` token/pidfile helpers; `daemon.sock`/`daemon.token`/`daemon.pid`/`daemon.log`/`daemon-log.jsonl` |
| `serve.ts` | `startDaemon`: binds the UDS (REST) + loopback TCP listener (REST + terminal WS); builds `instance.json`, configures the structured logger (docs/operations.md), and defaults the event log to `JsonlEventSink` (docs/events.md); returns `stop()` (which kills every shell and flushes the log) |
| `log.ts` · `logStrict.ts` | `componentLogger` (lazy per-component child logger so a boot-time `configureLogger` applies) and the `SENSUS_LOG_STRICT=1` rethrow gate |
| `shells.ts` | `ShellRegistry`: the daemon-owned PTY shells (`PtySession`), controller/observer roles (D11), the bounded replay buffer (D12), client facts (D2), and the streamed `terminal.status` facts |
| `chats.ts` | `ChatRegistry`: the daemon-owned agent chats — opens a `ChatSession` per chat through `ChatHost`, mirrors the engine `ChatEvent` stream, answers approvals (`resolveCard`) and sudo (`requestSudo`), and derives `ChatMeta` (P4c-ii) |
| `ws.ts` | `GET /v1/ws` (loopback only): upgrade + auth, the request/response/event envelope, the terminal + chat op dispatch, bounded per-client queues, the `hello`/client-gone seam |
| `lifecycle.ts` | The lifetime policy (P3c-iii): grace/idle exit (held while a live pane shell exists), the idle reaper that kills panes inactive past the re-attach window, detached-turn keep-alive, the no-client approval hold, `versionMismatchAction` |
| `cli.ts` | `sensus daemon {serve,start,stop,restart,status,logs,install,uninstall}` (install/uninstall write the persistent user unit) |
| `service.ts` | Persistent user service (P6): systemd/launchd unit rendering + install/uninstall through an injectable runner (no root, no system-wide paths) |
| `triggers.ts` | Local condition triggers (P6): rule matching, the bounded `triggers.jsonl` writer, and the event-sink decoration that feeds it (docs/triggers.md) |
| `config.ts` | `GET /v1/config` — the effective config with secrets redacted (D13) |
| `settings.ts` | `PUT /v1/config` (patch) + `/v1/secrets` — validated secret-safe writes (P4c-ii) |
| `mcp.ts` · `models.ts` · `usage.ts` | The engine-free read resources: MCP status facts, the enriched model catalog, and usage roll-ups (P4c-ii) |
| `memory.ts` · `sessions.ts` + `sessions/routes.ts` · `audit/{query,reader,routes}.ts` | The read/edit resources (sessions are read-only by construction) |
| `index.ts` | The daemon barrel (import from here, not the internals) |

The daemon imports the engine through `src/engine/index.ts` only, so the one-way
dependency holds and the daemon stays renderer-free. `src/cli.ts` dispatches
`sensus daemon` BEFORE the nest guard (headless) and `src/index.tsx` awaits the
runner lazily, so a TUI boot never loads Elysia. P3c-i adds the terminal WS
channel (`ShellRegistry` + `/v1/ws`) and the daemon-side PTY byte path; P3c-ii
adds the chat/approval/sudo channel (`ChatRegistry` over `ChatSession.subscribe`);
P3c-iii adds the lifetime policy (`lifecycle.ts`: grace/idle exit, held while a
live pane shell exists, the
no-client approval hold, the version handshake); P4a adds the streamed
`terminal.status` facts, the `chat.send` mode result, the bound-chat terminal
context wiring, and the byte-transparent PTY (a null palette — the client owns
SGR rewrite + `PanePainter`, D1); P4c-i/P4c-ii add the remote client transport
and the engine-free read/write surface (the `ChatMeta` readouts + `chat.meta`
event, `/v1/mcp`, `/v1/models`, `/v1/usage`, and the `PUT /v1/config` +
`/v1/secrets` settings writes); and P4 cuts the client over
(with the boot re-attach picker).

P5 adds the monitoring seam (docs/events.md): the daemon owns a **stable
identity** (`~/.config/sensus/instance.json`, reported on `GET /v1/info`) and a
**durable event log** (`~/.local/share/sensus/events.jsonl`, event schema v1)
written by the built-in `JsonlEventSink` — the daemon's default sink, bounded
and rotating, flushed on `stop()`. It is local-only: `SENSUS_CONTROL_URL` is
unreferenced in `src/**` and v1 ships no forwarding (D8).

P6 adds the opt-in always-on layer: `sensus daemon install/uninstall`
(`service.ts`) write/remove a **user** systemd unit or launchd agent that runs
`serve` in persistent mode, and `triggers.ts` watches the v1 stream for the
configured `triggers` rules, recording matches to `triggers.jsonl` and
broadcasting a `trigger` WS event (docs/triggers.md). Still local-only — no
egress (D8).

### `client/`

The client transport + remote objects the TUI uses (P4c; D5): the TUI is a front end
to the daemon over HTTP/WS only. No in-process `ChatHost`/`ChatSession`/`TerminalSession`
is constructed in the app path.

| File | Purpose |
|---|---|
| `wsClient.ts` | The typed `/v1/ws` transport: request/response correlation, typed events/ops, bounded queues, reconnect/backoff, base64 helpers |
| `restClient.ts` | Typed REST over the UDS (health/info/config/agents/skills/memory/sessions/audit/models/mcp/usage reads; `PUT /v1/config` incl. `?mode=replace`, `GET /v1/config/raw`, `/v1/secrets`; session `GET`/`context`/`DELETE`) |
| `daemonEnsure.ts` | Boot: resolve the runtime dir, reuse/auto-spawn the daemon, the D21 version handshake + `restartAndReconnect` (Elysia-free) |
| `remoteTerminalSession.ts` | The client VT: owns `EmbeddedTerminalRenderable` + `SgrColorRewriter` + `PanePainter` + key encoding; consumes `terminal.output`, tracks the absolute output cursor, applies only missed replay ranges, heals dropped frames with a resync attach, publishes `terminal.facts` (D1/D2/D12) |
| `remoteChat.ts` | The remote `ChatSession`: mirrors `chat.state`/`chat.meta`/events; keeps the purely-local UI state (editor, slash, drafts, reveal, expand, display prefs); commands go out as WS ops (`chat.send`/`approvals.answer`/`sudo.answer`/`chat.set*`/`chat.planAnswer`/`chat.answerAsk`/`chat.revert`); UI-only slash commands (`/memory`, `/theme <name>`, `/image`, `/cards`) are handled locally |
| `hostAdapter.ts` | A REST-backed, `ChatHost`-shaped facade for the overlays/App (config reload, agents/skills, memory/session-search shims, MCP facts); contains no engine objects |
| `attachPicker.ts` | Lists the daemon's **unattended** live panes for boot re-attach (D4); a lone pane (shell or chat, empty or not) is re-attached without asking, and unsent chats are marked `empty` and sorted after chats with content |
| `reattach.ts` | After a WS reconnect, re-attaches every open tab: `terminal.attach` resumes from the session's applied output cursor (only missed bytes), `chat.attach` pushes fresh state. Awaits failures and reports them; `controller_taken` is retried; tabs whose shell is gone are rebuilt by the tab engine (D5/D12) |

Detach is the default (D4): quitting or `Ctrl+A d` closes the WS and leaves the daemon +
shells alive; `sensus daemon stop` is the full teardown for this environment, and
`sensus kill` is the global kill switch across every daemon/runtime dir
([`operations.md`](operations.md) "Daemon").

**Reconnect recovery (D5/D12).** The daemon tracks `terminal.attach`/`chat.attach`
subscriptions **per WebSocket** and drops them when that socket closes. When `WsClient`'s
auto-reconnect opens a new socket, the tab engine hears the new `hello` and calls
`reattachTabs` (`client/reattach.ts`): each tab re-issues `terminal.attach` with the
session's last applied output cursor (the daemon replays only the missed bytes — a full
replay when the cursor predates the retained ring, reported as `truncated`) and
`chat.attach` (re-watches the chat and pushes a fresh `chat.state`). Recovery passes are
epoch-guarded so a flapping socket cannot double-attach; a `controller_taken` race against
the daemon's still-open previous socket is retried. Tabs whose shell no longer exists are
rebuilt in place; other failures are a toast, never a throw. A daemon that never comes
back still degrades to a visible disconnect rather than recovering (D5).

**P4e — the overlay ports.** The last in-process engine reads/writes were ported
to the daemon so a remote client needs no local engine or sessions dir:

- **UsageDashboard** sources `GET /v1/usage` (roll-ups incl. `windowSessions`,
  `bySession`, `sessions` metadata);
- **Memory manager** and **Session search** read/write through the REST memory
  and sessions resources (a session open reconstructs the transcript from
  `GET /v1/sessions/:instance/:base`; delete is `DELETE …`; the saved-session
  Context Inspector is `GET …/context`);
- **SettingsScreen** and **SetupWizard** write `PUT /v1/config` (plus
  `GET /v1/config/raw` for the editor's raw document, and `/v1/secrets` for the
  write-only secret values);
- **Context inspector** for a saved session uses
  `sessionContextBreakdown` over `GET /v1/sessions/:instance/:base/context`.

These are engine-free reads: `HostAdapter`/`RestClient` call the daemon and
return plain data (D13); no `ChatHost`/`MemoryStore`/`SessionIndex` is
constructed in the client path.

### `ui/`

Thin view layer; all state lives in small stores. Full detail in [`ui.md`](ui.md). The
dispatch seam (keymap → prefix → focus) is in [`keybindings.md`](keybindings.md). Several
"pure helper" modules that used to live here (`chat/inputEditor.ts`, `chat/slashComplete.ts`,
`chat/streamReveal.ts`, `chat/contextInspector.ts`, `chat/usage.ts`, `lib/toast.ts`,
`lib/spinner.ts`, `lib/fuzzy.ts`) now live in `engine/` and are re-exported here.
`TabView.session`/`chat` are the remote objects (`RemoteTerminalSession`/`RemoteChat`).

## Data flows

### Terminal output → screen

1. The PTY child writes raw bytes; `Bun.Terminal`'s data callback hands them to
   `PtySession.handleOutput`.
2. `handleOutput` rewrites indexed SGR colors to truecolor and re-applies the theme default
   fg via `SgrColorRewriter`, pushes the rewritten bytes into `StreamScanner`
   (title/cwd/alt-screen + the plain-text ring for the agent), then fans them out through
   `onOutput` to `EmbeddedTerminalRenderable`, which owns the VT state — screen, cursor,
   colors, native scrollback. Sensus never composes a frame.
3. `TerminalPane` mounts the active session's renderable imperatively into a container box
   (`container.add` reparents on tab switch), so each tab keeps its VT state. Color fidelity
   comes from that output-SGR rewrite against the detected/override palette plus the
   re-applied theme default fg and the `PanePainter` default-bg repaint (so the pane background
   follows the theme); the embedded
   VT's fixed palette is the fallback, and 256/truecolor pass through
   (see [`DESIGN.md`](DESIGN.md)).
4. The cursor is native (`renderable.screen().cursor`); `status()` reads `x`/`y`/`visible`
   for the UI. There is no synthesized cursor overlay.
5. A lightweight status poll (~1/s) updates the status bar and chat context facts (and the
   tab-title fallback) from `TerminalStatus`; death is observed primarily through
   `session.onExit`.

### Keys → pane / chat

1. opentui key event → the `@opentui/keymap` layer (matched hotkeys consumed) → else
   `dispatchKey`: overlay → prefix → route to the focused region.
2. Terminal focus: the focused renderable owns encoding and PTY writes (emulator responses
   ride the same `onData`); `dispatchKey` does nothing for terminal-focus keys. `keys.ts` is
   the encoder for the non-renderable paths — the prefix machine's pass-through and the
   `shell_session` tool.
3. Chat focus / overlays / the armed prefix blur the renderable, so its input is fully
   suspended; the second prefix key reaches `dispatchKey` through `PrefixMachine`.
4. Chat focus: the input box edits locally; Enter sends (while a reply streams it
   steers/queues per `chat.busySend`), Shift+Enter/Ctrl+Enter insert a newline, and
   Alt+Enter applies the other busy-send mode while streaming (newline when idle).

### Mouse and selection

1. Mouse/wheel/click-to-focus are native: the focused renderable forwards them to the PTY
   and emits them through `onData`. The renderer's `focused_renderable` event mirrors a
   click-focus into the store. There is no manual re-encoding layer.
2. Only two surfaces are selectable — the terminal pane (when the inner app is not in
   app-mouse mode) and the chat message list; every chrome/overlay/menu text is
   `selectable={false}`, so clicking a menu can never start (and copy) a selection. A
   drag-release on a selectable surface copies the selection + toast; `Ctrl+C` /
   `Ctrl+Shift+C` copy it when a selection exists (otherwise `Ctrl+C` reaches the shell as
   `^C`).

### Chat turn

```
user msg → slash command? handle locally (never sent) : send
        → ChatSession.sendMessage
        → MCP ensureReady (lazy-connect configured servers once per instance)
        → prune finished generations' tool results (~2k clip)
        → capture the terminal context block ONCE per generation
        → preflight compaction at the top of each loop turn when near the limit
        → block injected into the newest user message at request-assembly time
        → provider stream (AI SDK over the endpoint's protocol; MockProvider under SENSUS_MOCK=1)
        → text deltas buffer + flush; reasoning deltas land in the display-only thinking field
        → on tool_calls: render a card, execute SEQUENTIALLY (approval gate in confirm mode),
          append results, loop (max chat.maxToolTurns turns; default null = no cap)
        → final usage accumulates; JSONL append
```

Esc aborts the generation through one AbortSignal: fetch stops, a running hidden command's
process group is killed, and pending approval/`ask_user` waits resolve as aborted. The
partial answer is marked "aborted" and persisted. OpenAI-compatible endpoints that reject
tools degrade to plain chat with per-line click-to-paste code blocks; native protocols surface
the error. Full detail: [`agent.md`](agent.md).

## Lifecycle

- **CLI (headless).** `sensus --help|-h|help`, `--version|-v|version`,
  `sensus update`/`upgrade`, and `sensus init --create-config` run before config resolution
  so they work headless and from the compiled binary. `sensus init` boots the TUI with the
  setup modal open (setup is
  in-app; `/init-wizard` and Ctrl+P reopen it). The **nest guard** refuses a TUI boot when
  `SENSUS_ACTIVE` is set (`SENSUS_SKIP=1`, the test/dogfooding hatch, overrides; headless
  subcommands stay usable).
- **Boot.** parse args → CLI dispatch → nest guard → load config → render the UI, which
  opens the boot picker windows when needed and spawns the first PTY session. A terminal below
  20×5 refuses to boot with a clear message; a mid-run shrink swaps to a full-screen notice +
  status-bar warning and recovers on resize.
- **Tabs.** `Ctrl+T` spawns a new PTY session + a fresh chat session; `Ctrl+W` (or the tab
  `×`) **detaches** the tab — the daemon shell + chat (and any running turn) stay alive and
  re-attachable; `Alt+1..9` / `Alt+Left/Right` switch. Switching reparents the tab's
  renderable into the pane container and selects its chat store.
- **Pane death.** `session.onExit` fires when the child exits (typing `exit`); the last tab
  quits sensus (the client detaches), otherwise the tab closes and the neighbor (left, else
  right) is focused. The daemon releases the dead shell's bound chat so no orphan lingers. A
  lightweight status poll (~1/s) is a safety net.
- **Exit.** Detach: close the WS, leave the alt-screen, print nothing; the daemon keeps every
  shell (and any running turn) alive. `Ctrl+A d` quits sensus; `sensus daemon stop` is the
  full teardown (it kills each PTY child), and `sensus kill` is the kill switch for every
  daemon this user runs (all runtime dirs).
- **Resume / re-attach.** Both boot pickers are **in-app windows** over the live layout (the
  settings-style modal card), not separate fullscreen renderers. `--resume` opens the
  transcript picker (`resume` overlay) at boot; a chosen transcript is restored into tab 1.
  Otherwise the boot **re-attach picker** (`attach` overlay) lists the daemon's live unattended
  panes; a **lone** pane (shell, or chat with or without messages) is re-attached **without
  asking**, and the window only appears when there is a real choice (≥2 candidates). An unsent
  chat is kept (its pane is live) but labelled `empty` and sorted after chats with content. The
  data (daemon listings / recent sessions) is fetched before the UI renders, but the choice is
  made in-app and tab 1 is booted from it. A reconnecting client also rebuilds in place any tab
  whose daemon shell no longer exists (a daemon restart) rather than orphaning it
  ([`daemon-api.md`](daemon-api.md) "Lifecycle").
- **Daemon lifetime (D3/D4/D9/D10/D21).** `sensus daemon serve` is on-demand: with no WS
  client it holds a grace window (`SENSUS_DAEMON_GRACE_MS`, default 300000) and then
  **idle-exits**, killing its shells. A **live pane shell pins the daemon** (the visible pane
  is the user's terminal and must survive a client kill/restart — D1, locked #6), so it only
  idle-exits once no pane remains; a **detached turn keeps it alive** until it settles, and
  `SENSUS_DAEMON_PERSISTENT=1` (or config `daemonPersistent`) never exits. A no-client
  approval/sudo **holds** and aborts the turn after `SENSUS_DAEMON_APPROVAL_TIMEOUT_MS`
  (default 60000). A daemon whose **version differs** after an update is restarted
  silently when it holds no shells; one that holds shells prompts at boot to restart-and-lose
  vs defer (`DaemonMismatchPrompt`, D21), and `sensus daemon restart` does it manually.
  `sensus daemon install`/`uninstall` write/remove a user service unit for the
  always-on persistent mode ([`operations.md`](operations.md) "Daemon"), which is
  what keeps the local condition triggers watching with no client
  ([`triggers.md`](triggers.md)). Full detail:
  [`daemon-api.md`](daemon-api.md) "Lifecycle".

Full CLI/install/build detail: [`operations.md`](operations.md). The terminal-engine side:
[`terminal-layer.md`](terminal-layer.md). Agent side: [`agent.md`](agent.md).

## Build & ship

`bun run build` (`scripts/build.ts`) compiles the standalone `dist/sensus` binary with
`Bun.build({ compile: { autoloadBunfig: false } })` — the embedded runtime must never read
the launching directory's `bunfig.toml`. The Solid JSX transform is registered **both** via
`plugins: [solidPlugin]` and `plugin(solidPlugin)`. `scripts/build-install.sh` builds and
installs to `$PREFIX/bin/sensus` by delegating to `scripts/install-release.sh` (which also
takes `SENSUS_PREBUILT=<bin>`); `bin/sensus.js` is the
npm-style run-from-source launcher. Keep-following binary rules live in
[`operations.md`](operations.md).

## Non-goals (v1)

No VT emulation of our own — the pane uses OpenTUI's embedded Ghostty VT parser; no multiple
visible panes (splits); no SSH remote mode. (Detach/reattach shipped with the daemon
cutover — [`daemon-api.md`](daemon-api.md); image input shipped after the v1 non-goal — see
[`agent.md`](agent.md) "Images". Inline image rendering in the terminal is still out of
scope.) The open post-v1 list lives in [`roadmap.md`](roadmap.md).

## Related docs

- [`PRODUCT.md`](PRODUCT.md) — what sensus is and the locked decisions
- [`daemon-api.md`](daemon-api.md) — the daemon (worker) REST API and lifecycle
- [`events.md`](events.md) — the instance identity and the durable event log
- [`triggers.md`](triggers.md) — local condition triggers over the v1 stream
- [`DESIGN.md`](DESIGN.md) — the visual/interaction system
- [`terminal-layer.md`](terminal-layer.md) — the terminal engine spec
- [`agent.md`](agent.md) / [`agents.md`](agents.md) / [`mcp.md`](mcp.md) — the agent
- [`ui.md`](ui.md) / [`keybindings.md`](keybindings.md) — the view layer and input
- [`config.md`](config.md) / [`operations.md`](operations.md) / [`testing.md`](testing.md)
