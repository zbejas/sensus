# Testing

## Overview

Sensus tests are scenario-shaped: one test per behavior with related assertions grouped
inside it, not one test per branch. Unit tests cover pure logic without a renderer; smoke
tests boot the real app **inside an outer tmux as a driver only** and assert on
`capture-pane` output (the app itself runs no tmux server and no private socket). This doc
is the canonical home for the test layout, the iteration loop, and the hard-won smoke-test
rules.

## Key files

| Path | Purpose |
|---|---|
| `tests/helpers.ts` | Shared smoke harness: `createHarness` (`sh`/`outer`/`capture`/`send-keys`/`waitFor`/`waitChatIdle`), boot/teardown scaffolding |
| `tests/mocks/mockOpenai.ts` | Scripted SSE chat-completions server |
| `tests/mocks/mockMcpServer.ts` | Standalone mock stdio MCP server (modes: default, `env`, `crash`, `slow`, `paged`) |
| `tests/unit/**` | Unit suite, mirroring `src/` 1:1 (`tests/unit/ui/chat/…`, `tests/unit/engine/…`) |
| `tests/unit/docs/**` | Docs invariants: manifest ↔ content ↔ README, dev-doc `User guide:` pointers, generated-JSON freshness, frontmatter, internal links |
| `tests/unit/engine/importGraph.test.ts` | The one-way `ui → engine` guard: fails if any `agent/`/`config/`/`session/`/`terminal/`/`engine/` file imports `src/ui/**`; also checks the `src/engine/index.ts` barrel loads headlessly |
| `tests/unit/engine/headlessTurn.test.ts` | A full turn (message → gated tool call → approval → completion) against `mockOpenai.ts` with zero UI imports |
| `tests/unit/terminal/keys.test.ts`, `scan.test.ts`, `sgr.test.ts`, `paneBg.test.ts` | Key encoding + byte-scanner + SGR palette-rewriter + pane default-background repaint unit tests (the tmux-layer unit tests were removed) |
| `tests/smoke/app.test.ts` | Shell-focused dogfood suite |
| `tests/smoke/chat.test.ts` | Agent-focused dogfood suite (incl. the MCP scenario) |
| `tests/smoke/color-fidelity.test.ts` | Color/SGR fidelity guard |
| `tests/smoke/ship.test.ts` | Compiled-binary + version guards |
| `tests/unit/perf/budgets.test.ts` | Keystroke latency budget: median `terminal.input`→`terminal.output` echo over a real daemon (budget 1500 ms) |
| `scripts/test-cleanup.sh` | Reaps orphaned test processes/sockets under `/tmp/sensus` |

## Commands

| Command | Purpose |
|---|---|
| `bun run test:unit` | Unit suite only (~15s) — the iteration loop |
| `bun run test:smoke` | Reaps stale test processes, then the smoke suite (~80s) |
| `bun test` | Full suite — the final gate for behavior-affecting changes (see below) |
| `bun run test:clean` | Reap orphaned test processes + test tmux hosts under `/tmp/sensus` |
| `bun run typecheck` | `tsc --noEmit` — must pass before declaring work done |

`test:unit` and `test:smoke` run `test:clean` first. Always run the reaper around smoke
runs: a killed test run leaves its tmux-driven app tree and mock/MCP children alive, and
stacked orphans OOM the machine. Never use `pkill -f` patterns that match your own command
line — reap only PPID-1 orphans (`scripts/test-cleanup.sh`).

These commands are wired into GitHub Actions: `.github/workflows/ci.yml` runs `typecheck` +
`test:unit` (Bun floor and latest) and a macOS build/sign guard — but **not** `test:smoke`,
which boots the real app in tmux and is too taxing for GitHub. Smoke stays the **local**
final gate for behavior-affecting changes. See [`operations.md`](operations.md) §CI.

## When the full suite is required

`bun run typecheck` and `bun run test:unit` gate every change. The full `bun test` (smoke
included) is the final gate only when the change can affect runtime/app behavior:

- UI/render, terminal/PTY, the byte scanner, key encoding, color/SGR fidelity
- boot, lifecycle, exit, the nest guard
- persistence: sessions, config writes, the search index, tool-output spill
- config resolution and agent/skill/MCP loading
- provider streaming, the tool loop, approvals, process spawning
- anything exercised by a `tests/smoke/*` case (app, chat/MCP, color-fidelity, ship)
- packaging/build (`scripts/build.ts`, the standalone binary)

Changes that do NOT need it: docs, comments, string/constant content (prompts, skill or
agent bodies), pure helpers with direct unit coverage, and test-only edits. Typecheck +
`test:unit` is sufficient; state in the report which gate ran. When unsure whether a change
is behavior-affecting, run the full suite — it costs ~80s, an escaped regression costs more.

## Layout

- `tests/unit/` mirrors `src/` 1:1 (`*.test.ts` beside their mirror position).
- `tests/smoke/` holds the in-tmux dogfood suites and the cheap dedicated guards.
- `tests/mocks/` holds the mock servers.
- Spawned-by-path references (mock servers, repo-root math) must use `REPO_ROOT` or
  `import.meta.dir`-relative joins — they are NOT import rewrites.

## Philosophy

- **Scenario-shaped tests, not per-branch micro-tests.** One test per behavior; multiple
  `expect()`s inside it are fine.
- **Parametrize fixture variants** in a loop inside one test — never one test per fixture.
- **Extend an existing test before adding a new one.** A new module lands with a handful of
  focused tests.
- **Don't assert implementation details**: exact error strings, internal call shapes,
  constants echoed back. Assert the observable behavior.
- **Keep-list (never delete):** bug-fix regression tests, cross-module invariants
  (keymap ↔ commandCatalog 1:1, slash-hint consistency), the zero-bg-SGR invariant,
  resolution-order semantics, and the ship guards.

## Smoke-test pattern

We verify rendered output by running the app inside tmux (dogfooding):

```
tmux -S /tmp/sensus/sensus-test.sock new-session -d -x 200 -y 50 'bun run src/index.tsx'
tmux -S /tmp/sensus/sensus-test.sock capture-pane -p -t <target>
```

Assert key UI strings appear, then kill the session. Use `/tmp/sensus` for test sockets,
never the user's default socket.

### Waits and frames

- **Never bare-wait for a status that changes a frame late** (e.g. `chat:idle` right after
  Enter): the capture can see a STALE pre-transition frame and the next keystroke then hits
  a different code path silently. Wait for the transition INTO the state first (e.g.
  `chat:streaming`), then require the target state to hold across two polls ~250ms apart
  (`waitChatIdle`).
- **Prefer DISAPPEARANCE waits** (condition = string gone) — they can only pass once truly
  true. Stale frames make appearance waits pass wrongly.
- **Don't send stray Escapes** before typing into a shell prompt: ESC + "exit" is readline
  `M-e` → bash sees "xit". Close overlays, wait for closure, then type.
- **Toasts paint rows 2–7 of the pane's top-right.** Row comparisons (pin/scroll assertions)
  must compare by ROW INDEX below the toast region, never by fixed char offsets (capture
  rows are trailing-trimmed, so a toast padding a row shifts every later offset). Panel width
  must include the glyph column + box padding (2 + 2×2 cols) plus the right margin, or the
  last word wraps and a full-string predicate never matches. Toast TTLs are short — catch one
  while it is up.

### Processes and sockets

- **The app runs no tmux server.** Smoke tests boot it directly in an outer tmux pane and
  capture that pane; there is no private `--socket`, no server, and therefore no
  duplicate-session hazard. Give every boot its own outer socket/scratch dir and kill the
  outer session in teardown.
- **Each sandbox owns its daemon.** The TUI is a front end (D5): `appBootCommand` sets a
  per-sandbox `SENSUS_RUNTIME_DIR` (`<sensusHome>/daemon-runtime`) and the app auto-spawns
  `sensus daemon serve` into it. On quit the app DETACHES (the daemon + shells stay alive,
  D4), so teardown must STOP it: `expectNoStrayProcesses(sensusHome)` calls
  `stopSandboxDaemon` first (SIGTERM → the daemon kills its shells/MCP children), then scans
  `/proc/<pid>/environ` for `SENSUS_HOME=<sensusHome>`. Helpers building a boot command by
  hand MUST add `SENSUS_RUNTIME_DIR=…` too (`sandboxRuntimeEnv`). A test that boots the SAME
  sandbox twice shares one daemon — per-boot env overrides (e.g. `SENSUS_MODEL`) must instead
  be applied at runtime (`/model …`), or the daemon stopped between boots.
- **The daemon owns the MCP children.** They die with the daemon, so a no-stray check that
  follows a detached client must stop the sandbox daemon first.
- **Latency budget.** `tests/unit/perf/budgets.test.ts` asserts the median WS keystroke→echo
  round-trip stays under 1500 ms (loose for a loaded CI box, tight enough to catch a
  pathological regression).
- **`pgrep -f` matches its own `sh -c` cmdline.** Use a `[s]leep`-style bracket pattern, and
  scope it to what the APP puts on its cmdline (e.g. `src/index.tsx`); never `pkill -f` a
  pattern your own command line contains.
- **Hidden-shell kills must target the process GROUP.** A plain `proc.kill()` on
  `bash -lc "…; sleep N"` leaves the orphaned grandchild holding the stdout pipe (the
  capture never EOFs). Spawn via `setsid` and `kill(-pid)`; bun's `process_group` option does
  NOT give a killable group (child pgid != `proc.pid`).
- **Observing exit / pane death:** the outer pane must outlive the app — wrap the boot in a
  launcher script and run `bash launch.sh; echo "EXIT-CODE=$?"; sleep N` as the pane command
  (a bare `bun …` pane dies with the app and cannot be captured).
- **Prefix smoke:** `C-a` and the second key are two `send-keys` invocations ~30ms apart,
  well inside the 1s window. Reset a bash line between probes with `C-c` (fresh prompt) —
  `C-u` only kills up to the cursor, and the prefix's `C-a` sequences leave the cursor near
  the line start, so `C-u` leaves residue and a later `exit` becomes e.g. `ZABCexit`.
- **Debug-boot caveat:** `tmux new-session -d -x N` from an unattached script may be
  overridden by tmux `window-size` (panes end up ~58×28) — the app correctly lays out tiny
  and the capture looks broken. Always boot smoke tests with `-x 200 -y 50`, and compare
  layout regressions against HEAD with the SAME boot.

### opentui / rendering

- opentui hijacks `console.error` while the TUI is up — in-app diagnostics must write to a
  file (e.g. `appendFileSync`) to be observable in boot logs.
- opentui coalesces rapid same-coordinate wheel events; pace synthetic wheel bursts ~20ms.
- `bun test` runs files in parallel in one process: a throwing `ReadableStream` callback in
  one file (mock server enqueue-after-close) surfaces as a random failure in whichever test
  is running — wrap such callbacks defensively.
- Full-screen overlays: register ONE key handler through the store. Multiple `useKeyboard`
  listeners ALL fire, so an overlay + App would double-handle every key.
- The tab bar and status bar each render as ONE text element; clickable regions map
  `e.x - currentTarget.screenX` back onto the recomputed strings. `bold` is a `<span>`-only
  style prop.
- `@opentui/keymap` and `useKeyboard` both hook `renderer.keyInput`; the keymap listener is
  prepended and consumed keys never reach `useKeyboard`. Never add a second global key
  listener. (opentui's stock event-match resolver throws on empty-name events; sensus
  replaces it — do not re-add `registerDefaultKeys`.)
- A `<scrollbox>` paints its internal boxes' default background — tests that assert the
  zero-bg invariant must ensure `rootOptions`/`wrapperOptions`/`viewportOptions`/
  `contentOptions` set `backgroundColor: "transparent"` and the scrollbar is hidden. A
  remounted flow sibling next to a scrollbox may not repaint (the slash menu is absolutely
  positioned for this reason).
- The native `<markdown>` renderable requires `syntaxStyle` (the constructor throws without
  it) and falls back to plain text for code fences without a tree-sitter client. Fenced code
  stays on the custom row model so per-line click-to-paste survives.

### Theme / color

- Verify black-boxing with `capture-pane -e`: count `48;2;` / `48;5;` / `40-47m` sequences.
  The `terminal` theme must produce ZERO with the overlays closed.
- Style props that disappear between renders do not reset — a live theme switch must SET
  `backgroundColor`/`bg` explicitly to `"transparent"`.
- The zero-bg invariant is chrome-only: pane CONTENT backgrounds legitimately emit
  `48;5;N` / `48;2;r;g;b` when the inner app paints one.
- To assert what sensus PAINTED, capture the outer tmux pane with `capture-pane -e`; use
  `script -q -e -c <cmd> file` when a test needs the literal SGR stream (the outer capture
  re-encodes the grid).
- The pane is an embedded Ghostty VT with a **fixed built-in palette** and no palette hook;
  `src/terminal/sgr.ts` rewrites indexed pane SGR to truecolor from the detected/override
  palette and re-applies the theme default fg on resets, and `src/terminal/paneBg.ts`
  (`PanePainter`) remaps frozen theme/palette colors and repaints the VT's black default
  background cells after each compose (so existing content follows the theme across resize
  and theme switches; the default bg is painted there, never through SGR, because an explicit
  bg truecolor or a `\e[2J` erase corrupts the VT's resize reflow — the chat smoke's
  reverse-video row asserts the theme-fg swap).
  `tests/smoke/color-fidelity.test.ts` covers the black-box paths:
  no palette (fixed VT palette + 256/truecolor passthrough), the renderer's ansi256
  quantization, the `themePalette.palette` override (index 1 → the override truecolor), and
  the theme background surviving a live resize. Unit coverage is
  `tests/unit/terminal/sgr.test.ts` and `tests/unit/terminal/paneBg.test.ts`.
- A pty's ECHOCTL caret-expands control bytes echoed by dumb programs; SGR color tests must
  use a real color-emitting program (`printf`), not tty echo.
- `pipe-pane` + `cat` block-buffers on exit; tests asserting on piped pane output must use
  `dd of=... bs=1` (unbuffered).

### Provider scripting

- The provider sees the terminal context block as its OWN user message right before the user's
  text (durable, append-only — [`agent.md`](agent.md) "Prompt caching"). Scripted servers
  must key markers off the LAST paragraph, not `startsWith`.

## Dependencies and mocks

- `mockOpenai.ts` serves scripted SSE chat completions; use it for provider/tool-loop tests.
  The native protocols (Responses/Anthropic/Gemini) are covered by the protocol-listing and
  reasoning-mapping unit tests (`tests/unit/agent/provider/protocols.test.ts`,
  `modelCatalog.test.ts`) instead of a scripted server.
- `mockMcpServer.ts` is a real stdio child process used by `tests/unit/agent/mcp/registry.test.ts`
  (connect/list/call, env propagation, pagination, crash, timeout, restart diffing) and
  `tests/smoke/chat.test.ts` (the real TUI driving the real registry).
- `SENSUS_MOCK=1` forces the mock provider; `SENSUS_HOME` sandboxes all paths
  ([`config.md`](config.md)); `SENSUS_MODELS_DEV_URL` overrides the catalog URL.

## Compiled-binary and ship guards

- `scripts/build.ts` is the only supported build path; see [`operations.md`](operations.md)
  for its constraints (dual Solid plugin registration, `autoloadBunfig: false`).
- `tests/smoke/ship.test.ts` boots the binary from a poisoned-bunfig cwd (a top-level
  `preload` there must not break it) and asserts `--version` matches `package.json`. Do not
  delete it. On macOS this same `--version` run is also the code-signature guard: without the
  ad-hoc re-sign in `scripts/build.ts` the kernel SIGKILLs the binary (`Killed: 9`).
- The same file drives `scripts/install-release.sh` end-to-end in a temp HOME/PREFIX, the
  `scripts/build-install.sh` build+delegate wrapper, and the release-download path against a
  local release server (`Bun.serve`), including the corrupt-checksum refusal;
  `SENSUS_RELEASES_BASE_URL` is the seam. Keep it in sync with `release.yml`'s asset names
  ([`operations.md`](operations.md) "Releases").
- The site (`site/`) is its own Bun project with its own gates: `bun run check` (Astro
  types), `bun test` (the `/install` logic in `site/src/lib/install.test.ts`), and
  `bun run build`; CI's `site` job runs all three. Site-only changes cannot touch the TUI,
  so they need those plus the root `typecheck`/`unit` — not the app smoke suite.
- When asserting tiny-terminal behavior in tmux captures, remember the pane closes instantly
  on refusal — write the app's stderr to a file to assert the message (a stdout redirect also
  breaks opentui's tty sizing: redirect stderr only).
- `resize-window` to trigger mid-run shrink tests: pick 40×4-style sizes — rows below the
  minimum but columns wide enough that the notice text stays greppable.

## Gotchas & invariants

- The suite is a time budget: prefer extending an existing scenario over adding a file.
- A test that cannot observe its transition is worse than no test — wait for the transition,
  then hold.
- The smoke harness boots the real app; an orphaned run is a resource leak, so the reaper is
  not optional.
- Never assert exact error strings from the app; assert observable behavior.

## Related docs

- [`architecture.md`](architecture.md) — the lifecycle the smoke tests drive
- [`terminal-layer.md`](terminal-layer.md) — the PTY/embedded-VT engine the dogfood suites exercise
- [`operations.md`](operations.md) — the build/ship rules the ship guard protects
- [`agent.md`](agent.md) — the context message shape the mock servers must account for
- [`mcp.md`](mcp.md) — the mock MCP server modes
