# Operations

## Overview

How sensus is launched, installed, built, and persisted. This doc owns the CLI, the setup
wizard, the build/binary constraints, on-disk state (sessions, the search index), and the
boot/exit lifecycle. Subsystem behavior lives in [`architecture.md`](architecture.md) and
the theme docs.

User guide: https://sensus.sh/docs/install/
User guide: https://sensus.sh/docs/cli/
User guide: https://sensus.sh/docs/development/

## Key files

| File | Purpose |
|---|---|
| `src/index.tsx` | Boot sequence: CLI dispatch, config, `--resume`, render; spawns the first PTY; computes the setup intent (`setup`/`setupError`) |
| `src/cli.ts` | `--help` / `--version` / `init` (boot intent) + `secrets` + `update` + `daemon` dispatch + the nest guard (`USAGE`) |
| `src/update.ts` | `sensus update`/`upgrade` + the cached launch update alert ([Update](#update)) |
| `src/daemon/cli.ts` | `sensus daemon` lifecycle: `serve`/`start`/`stop`/`status`/`logs` ([`daemon-api.md`](daemon-api.md)) |
| `src/config/wizard.ts` | Pure setup-wizard logic: step machine, validation, draft→config merge, host-scan seed |
| `src/ui/components/SetupWizard.tsx` | The setup modal overlay (signals + input handlers + fetch/IO) |
| `src/config/configFile.ts` | Atomic config writes for the wizard and the settings screen |
| `src/config/config.ts` | Path helpers (`sensusHome`, `sensusDataDir`, `sensusStateDir`, `configPath`) |
| `src/session/store.ts` | Session JSONL: events, `SessionFile`, resume listing |
| `scripts/build.ts` | Standalone binary compile |
| `scripts/install-release.sh` | Public release installer (served at `sensus.sh/install`); download + checksum + install ([Install](#install)) |
| `scripts/build-install.sh` | Checkout build installer: `bun run build` then delegate to `install-release.sh` ([Install](#install)) |
| `site/` | The sensus.sh landing site (Astro 7, Bun-managed) + the `/install` Pages Function ([Website](#website)) |
| `.github/workflows/release.yml` | Version-bump release: verify → native build matrix → GitHub Release ([Releases](#releases)) |
| `bin/sensus.js` | npm-style run-from-source launcher (`package.json` `bin`) |
| `tests/smoke/ship.test.ts` | Binary + version regression guard |

## CLI

The headless subcommands are handled BEFORE config resolution, so they work without a TUI
and from the compiled binary; the interactive `sensus init` marker just boots the TUI with
`setup: "force"` (index.tsx computes the intent):

| Command | Behavior |
|---|---|
| `sensus` | Start the TUI (default) |
| `sensus --help` / `-h` / `help` | Usage text |
| `sensus --version` / `-v` / `version` | Version line (from `package.json`) |
| `sensus --export <session.jsonl>` | Print a session transcript as Markdown (docs/sessions.md) |
| `sensus update` / `sensus upgrade` | Update to the latest release in place (`--check`, `--dry-run`, `--version <tag>`) ([Update](#update)) |
| `sensus secrets <cmd>` | Manage the encrypted secrets store: `list`, `set <NAME> <value>`, `rm <NAME>`, `migrate` (docs/config.md "Secrets") |
| `sensus events tail` | Print the durable local event log (schema v1; `--follow`, `--type <t,t>`, `--since <ms\|ISO>`) ([`events.md`](events.md)) |
| `sensus triggers tail` | Print the durable local trigger log (`--follow`, `--type <t,t>`) ([`triggers.md`](triggers.md)) |
| `sensus daemon <cmd>` | Run/manage the local daemon (worker): `serve`, `start`, `stop`, `status`, `logs [--follow]`, `install`/`uninstall [--dry-run]` ([`daemon-api.md`](daemon-api.md)) |
| `sensus kill` | Kill switch: stop **every** running sensus daemon this user owns (all runtime dirs, current environment included), then remove stale sockets/pids; `--dry-run` lists without killing ([Daemon](#daemon)) |
| `sensus init` | Boot the TUI with the setup modal open (optional alias for `/init-wizard`) |
| `sensus init --create-config` | Headless: scaffold `~/.config/sensus/config.json` (never overwrites) |

`init --remove` / `--print` were removed with the zshrc launcher and now error with a
pointer. `init` never touches a shell rc file.

Start flags (parsed by `config.ts`; highest precedence):

| Flag | Meaning |
|---|---|
| `--model <endpoint@id>` | Select the model (a bare `<id>` keeps the endpoint) |
| `--endpoint <name>` | Switch the selected model's endpoint |
| `--base-url <url>` | Override the selected endpoint's baseURL |
| `--resume` | Pick a recent chat session to continue (an in-app window at boot) |
| `--yolo` | Start in full-auto approval mode |
| `--sidebar-width <cols>` | Chat sidebar width in columns |

`--resume` opens the session picker as an in-app window over the live layout, then boots a
fresh PTY session with the chosen transcript restored into it.

## Daemon

`sensus daemon` is the headless **worker** mode of the binary (D15/D18): it hosts
the engine (config, secrets, memory, sessions, audit, the **shells**, the
installation identity, and the event log) behind a loopback-only REST +
terminal-WebSocket API. The TUI is a front end to it (D5/P4). The full contract
lives in [`daemon-api.md`](daemon-api.md).

On boot the daemon writes/reuses `~/.config/sensus/instance.json` (stable
`instanceId` + `createdAt`, D13) and appends event schema v1 to
`~/.local/share/sensus/events.jsonl` — read them with `sensus events tail`
([`events.md`](events.md)).

The daemon subcommands are handled BEFORE the nest guard (like `secrets`), so
`sensus daemon serve` works even with `SENSUS_ACTIVE` set. `src/index.tsx` loads
the daemon runner lazily, so a normal TUI boot never pulls in Elysia.

| Command | Behavior |
|---|---|
| `sensus daemon serve` | Foreground: bind the listeners, print the socket/token/pid, stay alive; on `SIGINT`/`SIGTERM`/`SIGHUP` (or an idle exit) close the listeners, remove the socket file + pidfile, and stop. Tests drive exactly this. Refuses to clobber a healthy running daemon. |
| `sensus daemon start` | Daemonize (`setsid` + detached, stdio → `daemon.log`, `daemon.pid`), then wait briefly for `/v1/health` and report. Idempotent when already healthy. |
| `sensus daemon stop` | Read the pidfile, `SIGTERM`, wait, confirm the socket is gone; `SIGKILL` only if a process wedges. Kills every shell the worker owns (no orphaned PTY child). Idempotent when not running; never leaves an orphan. |
| `sensus daemon restart` | Stop (idempotent when not running) then start, reporting each step. |
| `sensus daemon status` | Print pid + a `/v1/health` probe; exit 0 when healthy, 1 otherwise. Also prints the loopback Scalar docs URL when `/v1/info` is reachable. |
| `sensus daemon logs [--json|--pretty] [--level <lvl>] [--component <s>] [--follow]` | Render the STRUCTURED log `daemon-log.jsonl` (pretty on a TTY, raw NDJSON when piped). Filters and follow: see "Structured daemon log" below. |
| `sensus daemon install` / `uninstall` | Write/remove a **user** service unit (systemd/launchd) that runs the daemon in persistent mode; `--dry-run` prints the unit/plan instead of acting. Never root, never a system-wide path. |

**Kill switch (`sensus kill`).** `sensus daemon stop` targets the daemon this
environment owns; `sensus kill` is the global escape hatch. It scans the
process table (current uid only) for `sensus daemon serve` invocations —
whatever `SENSUS_RUNTIME_DIR` they were started with (a dev/test instance,
another checkout, a stale persistent unit) — SIGTERMs them all, escalates to
SIGKILL for anything that will not exit, and removes the stale
`daemon.pid`/`daemon.sock` artifacts (also for a runtime dir it discovered from
the process env). `--dry-run` lists the pids without killing. It never touches
another user's processes and is headless (handled before the nest guard), so it
works from inside a sensus pane too — which it then kills, shell included. When
the persistent user service is installed the output points at
`sensus daemon uninstall`, since that unit can start a daemon again.

**Runtime dir** (`sensusRuntimeDir()`; docs/config.md "Locations"):
`$SENSUS_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/sensus-<uid>` → `/tmp/sensus-<uid>`. The
dir is `0700`; `daemon.sock`, `daemon.token` and `daemon.pid` are `0600`. The
socket is unlinked before bind (stale-socket recovery) and on stop.

**Transports** (D7/D14): the Unix socket above plus a `127.0.0.1` ephemeral TCP
listener, both serving the same app and both requiring
`Authorization: Bearer <daemon.token>`. Loopback is the default — never `0.0.0.0`,
never public. The explicit `SENSUS_DAEMON_HOST` (+ `SENSUS_DAEMON_PORT`) opt-in can
bind a LAN/Tailscale address (or `0.0.0.0`) so another machine can reach the
docs; it is off unless set, and the daemon warns when it binds beyond loopback
(the REST/WS API stays bearer-gated; the docs are unauthenticated). REST is
served on both; the terminal WebSocket is loopback-only by default (Bun's
WebSocket client has no `unix` option), so the UDS stays REST. The documentation
surface (`/openapi*`) is the one bearer exemption so a browser can load the
Scalar UI ([`daemon-api.md`](daemon-api.md)).

**Self-exec** (`start`): the re-exec argv is derived from `process.execPath` +
`Bun.main` — the compiled binary (`dist/sensus`) re-runs `execPath` directly,
while dev (`bun run src/index.tsx`) re-runs `bun <Bun.main>`. `daemonSelfArgv`
(in `src/daemon/cli.ts`) owns this split; the dev path is covered by the daemon
e2e test and the compiled path by the ship smoke test.

**Idle policy (D3/D9/D10).** A daemon is on-demand by default. Once it has no
attached WS clients it holds a grace window and then exits, killing its shells:
`SENSUS_DAEMON_GRACE_MS` (default `300000` ms). A client reconnecting cancels
the timer; a **detached agent turn is never aborted** and keeps the daemon alive
until it settles, after which the grace clock re-arms. A **live pane shell also
pins the daemon** (D1, locked #6): the visible pane is the user's terminal, so it
only idle-exits once no pane remains — this is what lets a killed/restarted
client re-attach to a live pane and a running command survive. Set
`SENSUS_DAEMON_PERSISTENT=1` — or `daemonPersistent: true` in `config.json`
(docs/config.md "daemon") — to make a daemon that never grace-exits. With no
client, a pending approval/sudo prompt **holds**; after
`SENSUS_DAEMON_APPROVAL_TIMEOUT_MS` (default `60000` ms) the turn is aborted and
the call denied, so nothing ever executes unapproved. `/v1/info` reports the
live `shells` count and `persistent` flag.

**Idle reaper.** A daemon never accumulates sessions forever: a shell left
**inactive** (no attached client) for longer than
`SENSUS_DAEMON_REATTACH_MAX_AGE_MS` (default `28800000` ms, 8h; `0` disables) is
killed by a periodic reaper (once at startup, then every 60s), which also runs in
a persistent daemon. Killing a shell releases its chat, so the session is gone
and cannot be re-attached — re-attach is for a *recent* detach, not a session
from a previous workday.

**Version mismatch (D21).** After an update, a running daemon is still the old
version. At boot the client compares `/v1/info.version` with its own: an equal
version proceeds, a **shell-less** stale daemon is restarted silently (a restart
loses nothing), and a daemon that **holds shells** — which a restart would kill —
opens the `DaemonMismatchPrompt` (its own fullscreen renderer — the resume /
attach pickers are in-app windows, but this one must resolve the daemon
connection before the UI is wired to it) offering **restart the daemon now** (starts the new version, loses
the held shells) or **keep the running daemon** (defer; the warning is re-shown as
a toast and `sensus daemon restart` does it later). The safe "keep" row is
highlighted by default (`Enter` keeps; `r` restarts; `d`/`Esc`/`q` keep). A prompt
renderer failure defers — it never kills the boot.

### Persistent service (`install` / `uninstall`)

The always-on layer (D3) is a **user** service unit; it never requires root and
never touches a system-wide path:

| Platform | Unit | Wiring |
|---|---|---|
| Linux | `~/.config/systemd/user/sensus.service` | `systemctl --user daemon-reload` + `systemctl --user enable --now sensus.service` |
| macOS | `~/Library/LaunchAgents/com.sensus.daemon.plist` | `launchctl load -w <plist>` / `unload -w <plist>` |

The unit runs `sensus daemon serve` with `SENSUS_DAEMON_PERSISTENT=1` and
`SENSUS_RUNTIME_DIR=<the installing shell's runtime dir>` (so the socket/pid/log
match an interactive `sensus daemon status|logs`), using the same self-exec argv
as `daemon start` (`daemonSelfArgv`, so the compiled binary and dev agree). It
restarts on failure (`Restart=on-failure` / `KeepAlive`) and points the
service's stdout/stderr at `daemon.log` in the runtime dir.

- `sensus daemon install` writes the unit and loads/enables it; idempotent, and
  `--dry-run` prints the unit (systemd INI / launchd plist) instead of writing.
- `sensus daemon uninstall` unloads/disables it, removes the unit, and reloads
  the manager; idempotent when not installed, and `--dry-run` prints the plan.
- A real write/manager failure is a clear non-zero exit; success names the unit
  path and points at `sensus daemon status`.

The unit path and the command runner are injectable
(`src/daemon/service.ts`), so tests never touch the real `$HOME` and never
invoke `systemctl`/`launchctl`. The persistent service is what makes triggers
useful with no client attached ([`triggers.md`](triggers.md)).

## Setup wizard

Setup runs INSIDE sensus as a modal overlay (settings-sized, the settings-screen chrome) —
there is no separate pre-boot renderer. `src/config/wizard.ts` is the pure, unit-tested core
(step machine, validation, draft→config merge, host-scan decision); the
`ui/components/SetupWizard.tsx` component renders it and owns its signals, input handlers,
provider construction and fetch/file IO. App opens it with `store.setOverlay("setup")`.

**When it opens.** A plain `sensus` opens setup automatically when `config.json` is missing or
is an untouched auto-generated default (`isDefaultConfig`), and when the boot config has an
error (`config.bootError`, e.g. a bad `baseURL`) — sensus no longer refuses to boot on a bad
endpoint (the provider client is lazy), so the wizard can fix it in place. `sensus init`,
`/init-wizard`, and Ctrl+P → Setup wizard force it open on demand, preloading the current file (the
"existing" step). A configured install never opens it unprompted. `SENSUS_NO_SETUP=1` is the
test/dogfooding hatch that suppresses the automatic open (it never suppresses `sensus init`).

Steps:

1. **existing** — when `config.json` exists, offer keep (write nothing) / edit (preload the
   current endpoint, model and theme) / fresh (replace the file). An untouched auto-generated
   default — the `--create-config` starter (scaffolded by the installers) with no user changes
   (at most the
   default theme added) — is treated as if there were no config: the step is skipped and the
   wizard proceeds as a fresh install (`isDefaultConfig` in `config/wizard.ts`).
2. **theme** — pick a built-in theme from a windowed fuzzy-filtered list with a live
   preview through the theme token map. It runs first on a fresh install (right after the
   existing-config step otherwise) so a theme whose secondary text reads poorly can be
   swapped before any other step.
3. **endpoint** — provider (OpenAI-compatible / OpenAI Responses / Anthropic / Google
   Gemini; `Enter`/`←`/`→` cycles, the baseURL follows the protocol default unless it is
   custom), name, baseURL and API key (name validated: non-empty, no `@`, no duplicate;
   baseURL may be empty = the protocol default, else an http(s) URL), plus a trailing
   `▸ continue` row. The mock provider is a test seam and is not offered here.
4. **test** — the daemon probes the DRAFT over its protocol (`POST /v1/models/probe` with
   the transient `{provider, baseURL, apiKey}`; the key is never logged or stored) and shows
   ok/fail and the model count. A failure does not block: type a model id by hand.
5. **model** — pick a fetched chat-capable model in a windowed fuzzy-filtered list, or type
   an id.
6. **host scan** — optionally run the read-only `host_scan` probes and seed `HOST.md` (never
   overwrites an existing one; skippable). The raw scan is capped (`capSeedContent`) and written
   as a starting point; the agent curates it later with the `memory` tool, so the wizard never
   calls a model and seeding cannot block init.
7. **review** — write `config.json` atomically (`configFile.ts`). Edit mode patches the
   parsed document so unknown keys and other endpoints survive; fresh mode folds in the same
   starter keys as `--create-config`. No shell rc file is ever touched.
8. **save + onboarding** — a successful save live-reloads `config.json` (the same path as
   `/reload`) and applies the chosen model to the current tab (model selection is
   per-session and latched at session creation, so the reload alone would seed NEW sessions
   only), then replaces the setup modal with the first-run **welcome** overlay over the LIVE
   UI (no "now run `sensus`" step — you are already in sensus). Its two pages explain the
   layout and the hotkey cheat sheet. The card is deliberately small so the real chrome
   stays visible; the layout preview is LIVE — `l` flips the actual tab strip (left rail vs top
   bar) behind the card, not a drawing, and SAVES the pick to config.json (Ctrl+O → Appearance
   reopens the same switch).
   It is an ordinary modal: `←`/`→`/`Enter` page through it, `Esc` (or the last page) dismisses
   it, and the backdrop click closes. Choosing **keep** on the existing-config step just closes
   the modal; cancelling is confirm-gated (below) and writes nothing.

The welcome overlay is App state (`store.setOverlay("welcome")`, `ui/components/WelcomeModal.tsx`
+ the pure `ui/chat/welcome.ts`), so it floats over the real chrome and simply leaves the user
in sensus when dismissed.

**Interaction.** Every step is a row list: `↑`/`↓` (and `j`/`k` where there is no text
filter, or `Tab`) move, `Enter` activates the highlighted row. On **host scan**, `y` scans &
seeds and `n` skips, and `Enter` runs the highlighted row — the default highlight is scan, so
`Enter` never silently skips; the footer button names the highlighted action. On **endpoint**,
the provider row cycles the protocols on `Enter`/`←`/`→` (no text editor), while a field
row's `Enter` opens that field for editing — typing never edits a field by accident — and
`Enter`, `Tab` or `↓` moves on; the single-line editor supports `←`/`→`/`Home`/`End`, `Delete`,
`Ctrl+U` and `Ctrl+R` (reveal the API key), with paste inserting at the cursor. `←` steps
back, and every row + footer action is clickable (hover highlights; clicking a model row
picks it). `Esc` cancels an in-progress field edit first, then clears a non-empty list
filter, then asks to leave. **Leaving is confirm-gated**: Esc, a backdrop click, or the footer
`exit` opens a dialog explaining that nothing has been saved and that the same knobs stay
editable later in the settings screen (Ctrl+O) and `~/.config/sensus/config.json` — and that
`/init-wizard` reopens the wizard anytime. `y` (or a click) exits (nothing written; a previewed theme
is restored); `Esc`/`Enter` (or "keep setting up") stays.

All non-render logic (`src/config/wizard.ts`, including the endpoint field helpers and the
host-scan seed plan) is unit-tested; the component owns its signals, input handlers
(`store.overlayKeyHandler` / `overlayPasteHandler`) and fetch/file IO.

Headless `sensus init --create-config` keeps its config-only behavior and is what the
installers run.

## Launcher

There is none. Sensus is **not** started from your shell rc: run `sensus` when you want it.
Sensus runs as a **child** of the shell you launched it from (never `exec`'d), so exiting —
or closing the last pane — returns you to that prompt.

The **nest guard** in `cli.ts` still refuses a manual `sensus` typed inside a sensus pane
(`$SENSUS_ACTIVE` is set in every sensus pane). `SENSUS_SKIP=1` is the test/dogfooding hatch
that starts a nested copy on purpose. Headless subcommands (`init --create-config`, `--help`,
`--version`) stay usable from inside sensus. `sensus init` now boots the TUI (setup is an
in-app overlay), so it refuses to nest like any other boot (`nestedBootRefused`).

## Install

`sensus.sh/install` serves the installer attached to the latest GitHub Release (`install.sh`,
staged by `release.yml` from [`scripts/install-release.sh`](../scripts/install-release.sh));
until that asset exists it falls back to the installer at the latest release tag — never
`main` (see "Website"). The installer downloads the matching prebuilt binary, verifies it
against the release's `checksums.txt`, installs it to `~/.local/bin` (or the prefix/global
target), and scaffolds a starter `config.json`. The release path needs `curl` (or `wget`)
and a sha256 tool — **not** Bun: the shipped binary embeds the runtime. From a checkout,
`./scripts/build-install.sh` builds from source instead (Bun required; see "Build & ship").
Flags:

- `--version vx.x.x` pins a release (`--version x.x.x` works too; default: the latest).
- `-g`/`--global` installs to `/usr/local/bin` without asking (the interactive user/global
  prompt only appears for a source build on a TTY; a piped install is always per-user).
- `PREFIX=~/.local` overrides the install prefix; `SENSUS_PREBUILT=<bin>` skips the
  download and installs the given binary (on macOS the supplied binary must already be
  code-signed — see "Build & ship").
- `SENSUS_RELEASE_VERSION` is the env form of `--version`; `SENSUS_RELEASES_BASE_URL`
  overrides the release host (used by the smoke suite to serve a local release).
- An unsupported platform (anything but Linux/macOS on x86_64/aarch64) fails with a pointer
  to the from-source path. Re-running is safe: the installed binary is overwritten and the
  config is never touched.

The install step warns if the install dir is not on PATH, runs the headless
`init --create-config` scaffold (never overwrites), and **never touches a shell rc file**.

- Requires bun ≥ 1.4.2 to run and to build from source (the repo's `engines` floor; see
  "Build & ship"). Bun below 1.4.1 cannot parse `bun.lock` (lockfileVersion 2): the build
  installer warns, `bun install` silently ignores the lockfile, and dependency versions
  float — run `bun upgrade` first.
- Release binaries are built on the pinned Bun 1.4.2 (see "Releases"), matching the floor.

## Update

`sensus update` (alias `sensus upgrade`) checks the latest GitHub Release and, when a
newer one exists, downloads the release installer and runs it against the running
binary's own prefix, replacing the binary in place. Headless, like `secrets`/`daemon`:
handled before the nest guard, so it works inside a sensus pane and from the compiled
binary (`src/update.ts`, dispatched by `cli.ts`, awaited by `index.tsx`).

| Flag | Behavior |
|---|---|
| `--check` | Report whether a newer release exists; install nothing |
| `--dry-run` | Print what would be installed; install nothing |
| `--version <tag>` | Install a specific release (e.g. `v0.2.0`); `latest` = the default |

- **Up to date** prints the version and exits 0. A locally built binary ahead of the
  latest release also reports up to date. `--check` with a newer release prints the tag
  and points at `sensus update`; the exit code stays 0.
- **In-place install.** The command derives the installer's `PREFIX` from the running
  binary (`/usr/local/bin/sensus` → `/usr/local`, `~/.local/bin/sensus` → `~/.local`) so
  the release lands where the running copy lives; an explicit `PREFIX` env still wins.
  The install runs the release's own `install.sh` (the same script the one-liner uses),
  so asset detection, checksum verification, sudo, and the config scaffold stay one
  implementation. A locally built binary not under a `bin/` dir (e.g. `dist/sensus`)
  cannot install in place and points at the installer one-liner instead.
- **Source checkouts** (`bun run src/index.tsx`, `bin/sensus.js`) refuse and print
  `git pull && bun install`.
- The **daemon is a separate process**: after an update it still runs the old binary.
  `sensus daemon restart` moves it to the new version (it loses live shells), or the boot
  D21 handshake offers restart-vs-defer ([`daemon-api.md`](daemon-api.md) "Version
  handshake").

**Launch alert.** At boot the client checks the latest release at most once per 24h (the
answer is cached at `<state-dir>/update-check.json`, docs/config.md "Locations") and
shows a toast when a newer version exists, pointing at `sensus update`. The check is
fire-and-forget: it never blocks or fails a boot, and an HTTP/parse failure stays silent.
It is the deliberate egress exception to D8 ([`events.md`](events.md) "No egress"):
disable it with `updateCheck: false` in `config.json` (docs/config.md "updateCheck") or
`SENSUS_UPDATE_CHECK=0`, after which no update request leaves the machine. `sensus
update` always checks the network — that is its job.

Test seams: `SENSUS_UPDATE_URL` (the latest-release JSON), `SENSUS_INSTALL_URL` (the
installer), and the installer's existing `SENSUS_RELEASES_BASE_URL`.

## Build & ship

`bun run build` compiles a standalone `dist/sensus` via `scripts/build.ts` —
`Bun.build({ compile: { autoloadBunfig: false } })` plus the Solid JSX transform. The
resulting binary embeds the runtime, so the target machine needs neither Bun nor
`node_modules`. The embedded terminal (native PTY + Ghostty VT) supports x86_64/aarch64 on
macOS and Linux (glibc/musl).

Keep-following rules (a broken build otherwise fails silently):

- The Solid transform must be registered BOTH via `plugins: [solidPlugin]` and
  `plugin(solidPlugin)` — Bun versions differ on which one the compile step honors, and with
  neither the binary renders the static layout but signals never fire ("tab: none" forever).
- `compile.autoloadBunfig: false` is required: a top-level `preload` in the launching cwd's
  `bunfig.toml` would otherwise resolve against the CWD and kill the binary with
  `preload not found`. `tests/smoke/ship.test.ts` guards this from a poisoned-bunfig cwd.
- **macOS signing**: Bun's `--compile` Mach-O signer has shipped broken/truncated ad-hoc
  signatures (Bun 1.3.12–1.3.13) and signatures macOS rejects (1.4.x), so the kernel
  SIGKILLs the binary on launch (`Killed: 9`, exit 137) before any code runs.
  `scripts/build.ts` sets `BUN_NO_CODESIGN_MACHO_BINARY=1` and then ad-hoc signs the output
  with the system `codesign --force --sign -` (`scripts/macosSign.ts`; it strips a truncated
  signature first if an in-place overwrite is refused). No certificate or entitlements file
  is needed. Linux is untouched. An unsigned `SENSUS_PREBUILT` binary on macOS still needs a
  manual `codesign --force --sign -`.
- `SENSUS_VERSION` (`src/version.ts`, re-exported from `package.json`) and
  `package.json`'s `version` move together; `ship.test.ts` asserts they match the built
  binary's `--version`.
- **Build with bun ≥ 1.4.2.** Bun 1.4.1's bundler renamer emits invalid JS for Elysia's
  `schema.mjs` — it rewrites the local `var Check = Check2` to `var Check2 = Check2`,
  shadowing the `let Check2` in the same scope — so a binary built on 1.4.1 dies at startup
  with `SyntaxError: Cannot declare a var variable that shadows a let/const/class variable:
  'Check2'` *before* `main()` runs (the build itself still reports success). 1.4.2 fixed the
  renamer, and it is the repo's single version floor (`package.json` `engines`): CI's
  `ship-macos` builds on it and running the binary is the guard.
- `bin/sensus.js` is the npm-style run-from-source launcher; it is not the compiled binary.

### Release contents

A release is not just the binary. Each platform asset (`sensus-linux-x64`,
`sensus-linux-arm64`, `sensus-darwin-arm64`, `sensus-darwin-x64` — the compiled binaries),
`checksums.txt` (sha256 per asset), and the licence files ship together on the GitHub
Release:

- the four platform binaries — the compiled artifacts, built natively per target;
- `checksums.txt` — `<sha256>  <asset>` lines; `scripts/install-release.sh` verifies against it
  and refuses a mismatch;
- `install.sh` — the release installer (a snapshot of `scripts/install-release.sh`) that
  `sensus.sh/install` serves;
- `LICENSE` — Apache-2.0 (appendix: `Copyright 2026 Anže Mavrič`);
- `NOTICE` — the copyright line + the OpenCode attribution.

`dist/sensus` is the local host build of the same compile. `package.json`'s `files` list
carries the licence files, so an npm-style install is compliant too.
The bundled-dependency half is enforced by `bun run license:check`
([`licensing.md`](licensing.md)): it builds `dist/sensus`, reads the packages actually
embedded in it, and fails on a missing licence or one outside
{MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC}. CI runs it in `verify` right after
`bun install`.

### Releases

`.github/workflows/release.yml` cuts a GitHub Release when the `package.json` version
changes on `main` (and on manual `workflow_dispatch`). The `version` job reads the version
and skips when release `v<version>` already exists — the trigger is "the version changed",
not "package.json was touched", and a failed run can be re-run without publishing twice.

- `verify` — the cheap gates (`license:check` + `typecheck` + `test:unit`) on the pinned
  build Bun.
- `build` — one **native** runner per target, because OpenTUI ships per-platform native
  libraries and each real binary must be built on its target OS/arch:

  | Runner | Asset |
  |---|---|
  | `ubuntu-latest` | `sensus-linux-x64` |
  | `ubuntu-24.04-arm` | `sensus-linux-arm64` |
  | `macos-latest` | `sensus-darwin-arm64` |
  | `macos-15-intel` | `sensus-darwin-x64` |

  Each job asserts the binary runs and reports the `package.json` version (on macOS this is
  also the ad-hoc code-signature guard) and that `init --create-config` works, then uploads
  the binary plus its sha256.
- `publish` — collects the artifacts into `checksums.txt` and runs `gh release create
  "v<version>" --target <sha> --generate-notes`, attaching the four binaries, the checksums
  and `LICENSE`/`NOTICE`. The tag is created by the release, pointing at the version-bump
  commit.

The build pins Bun **1.4.2** (the version that bundles Elysia correctly — see "Build &
ship"), which is also the repo's runtime floor for source builds (`engines`). musl builds
and Windows are deliberately not shipped: OpenTUI's musl native needs `OPENTUI_LIBC=musl`
and the PTY path is POSIX-only.

The installer consumes exactly this layout: `<base>/{latest|download/v<version>}/download/<asset>`
plus `checksums.txt` at the same level, where `<base>` defaults to the repo's GitHub
Releases and is overridable with `SENSUS_RELEASES_BASE_URL`.

### CI

`.github/workflows/ci.yml` runs on every push to `main`, every PR, and manual
`workflow_dispatch` (concurrency cancels superseded runs on the same ref):

- `verify` (`bun run typecheck` + `bun run test:unit`) on a Bun matrix of the pinned floor
  (`1.4.2`) **and** `latest` — the dual Solid-plugin registration in `scripts/build.ts`
  exists because Bun versions differ, so both ends are tested.
- `ship-macos` (`bun run build` on `macos-latest`, pinned to Bun **1.4.2** — the version
  that bundles Elysia correctly — then run the binary). This is the macOS-only code-sign
  guard: `scripts/build.ts` re-signs ad-hoc, and a rejected signature makes the kernel
  SIGKILL `dist/sensus --version` (`Killed: 9`). Ubuntu never exercises that path. It also
  checks the `--version` / `init --create-config` round-trip and uploads the macOS binary as
  an artifact.
- `site` (`bun run check` + `bun test` + `bun run build` under `site/`, Bun 1.4.2 plus Node
  22.12 for Astro's build floor) — the landing site's gates. Cloudflare Pages builds and
  deploys the same directory on push (see "Website").

The smoke suite is deliberately **not** run in CI: booting the real app in tmux costs ~3
minutes of real PTY/renderer per run and is too taxing for GitHub. It stays the **local
final gate** for behavior-affecting changes (AGENTS.md rule 6,
[`testing.md`](testing.md) "When the full suite is required"); CI carries only the cheap,
deterministic checks.

`.github/workflows/release.yml` is separate from `ci.yml` and only runs when the version in
`package.json` changes on `main` (or a manual dispatch) — see "Releases" for the pipeline.

`.github/workflows/nightly.yml` re-checks upstream advisories (`bun audit`, advisory) on a
daily schedule. `.github/dependabot.yml` opens weekly GitHub Actions version PRs. It
intentionally omits the `bun` ecosystem: this repo's `bun.lock` is lockfileVersion 2 and
Dependabot's bundled Bun updater only parses version 1 (`DependencyFileNotSupported`), so
every bun run fails — re-add it once Dependabot supports v2. `bun run build` still targets
only the host platform; the cross-platform matrix lives in `release.yml` ("Releases").

## Website

`site/` is the public site for **https://sensus.sh**: an Astro 7 static build managed by Bun
and deployed by **Cloudflare Pages** with its Git integration (no deploy workflow, no
repository secrets beyond the optional token below). One-time project setup:

- Production branch `main`; **root directory `site`**; build command `bun run build`; build
  output `dist`; env `NODE_VERSION=22.12.0` (Astro's build floor) and `BUN_VERSION=1.4.2`
  (the repo's pin).
- Build watch paths `site/*` plus `package.json`: the install section's `--version` example
  and the hero install command's `latest v…` tag are read from the root `package.json` at
  build time (`site/astro.config.mjs`), so a release bump must rebuild the site.
- Custom domain `sensus.sh`. The zone is on the same Cloudflare account, so DNS and TLS are
  automatic. The `www` to apex 301 is a Cloudflare **Bulk Redirect** (Rules -> Bulk
  Redirects): `_redirects` only supports path-based sources, so a domain-level rule there is
  silently skipped.
- Optional `GITHUB_TOKEN` secret while the repository is private: `/install` then reads the
  latest release through the GitHub API. **Launch gate:** public installs require the
  repository and its releases to be public — the installer itself downloads binaries from
  GitHub Releases without a token. Once the repo is public, remove the secret; the endpoint
  prefers the anonymous path anyway. For local `wrangler pages dev`, put the token in the
  gitignored `site/.dev.vars`.

`/install` is the only dynamic route: `site/functions/install.ts` (logic in
`site/src/lib/install.ts`, unit-tested by `site/src/lib/install.test.ts`) serves the latest
release's `install.sh` as `text/plain`, falls back to the installer at the latest release tag
(new layout first, then the pre-split root path), and caches the result at the edge for five
minutes.

Local development: `cd site && bun install && bun run dev`; `bun run check` (types), `bun test`
(the `/install` logic), `bun run build`. To exercise the Function locally, build then
`bunx wrangler pages dev dist`. `public/og.png` is rendered from `src/assets/og.svg` by
`bun run og` (`scripts/og.ts`) and committed; the raster's provenance is that script. The
layout versions the `og:image` URL with the PNG's content hash, so social embeds refetch
after a re-render instead of showing a stale cached card.

## Runtime requirements

- **No tmux.** The left pane is a native PTY (`Bun.Terminal`) rendered by OpenTUI's
  embedded VT; the native support covers x86_64/aarch64 on macOS and Linux (glibc/musl),
  and the PTY path is POSIX-only.
- **Bun ≥ 1.4.2 to run** (not just build): the app calls `Bun.Terminal` /
  `Bun.spawn({ terminal })` at runtime, and 1.4.1 cannot build a working binary. The shipped
  binary embeds Bun, so an end user needs no separate install; building from source needs it.
- A terminal of at least 20×5; a smaller one refuses to boot with a clear message, and a
  mid-run shrink shows a notice until it grows back.
- Over SSH sensus works as a normal TUI; no host-side terminal multiplexer is required.

## Persistence

One JSONL file per chat session:
`<dataDir>/sessions/<instance-id>/<tab-n>.jsonl` where `dataDir` =
`~/.local/share/sensus` (redirected by `SENSUS_HOME`). The instance id is stable for a whole
run and fresh per run.

Events (append-only): `session_start`, `user_message`, `assistant_message` (content,
`thinking`, model, usage, `aborted`), `slash_command`, `tool_call`, `compaction`, and
`revert` (a chat rewind marker: `keep` = user+assistant records to retain; `loadSessionFile`
truncates the logical transcript to it — see [`ui.md`](ui.md) "Rewind").
Writes are synchronous and never throw (disk failures are counted); corrupt lines are
skipped with a warning on load. Assistant `thinking` is persisted for resume even though it
is never sent back to the provider. A fresh session is **lazy**: opening a tab stores no
file until the first content record, so a chat with no sent message leaves no
`(empty session)` transcript behind (see [`sessions.md`](sessions.md) "Empty sessions are
not stored").

`/clear` rotates to a new file generation for the tab (`tab-1.jsonl` → `tab-1-2.jsonl`) and
keeps the old file. `--resume` lists the recent sessions (first user message + timestamp,
most recent first) and continues one; the provider history rebuilds from the **last**
`compaction` checkpoint plus the records after it (the visible transcript keeps everything).

### Structured daemon log

The daemon writes a **structured NDJSON log** at `<runtimeDir>/daemon-log.jsonl`
(`daemonLogJsonlPath`), distinct from `daemon.log` (which stays the detached process's raw
stdio banner — `daemonLogPath`). It is configured at boot in `serve.ts` through
`configureLogger` (see [`logging.md`](logging.md) for the envelope, redaction, correlation
and rotation). Records carry the `component`, `instanceId` and (for REST requests) a
`corrId`; the boot bearer token is redacted by literal value.

The log records **activity, not just lifecycle**: `session started`/`session ended`,
`tool executed` (status, exit code, duration, a bounded target), `turn completed`
(outcome + why an abort happened), `error raised`, the hidden-shell force-drain warn, and
the daemon's `previous` restart reason on `daemon started` / `reason` on
`daemon stopping`. Filter with `--component agent.chat` or `--level warn`.

Env vars:

- `SENSUS_LOG_LEVEL` — minimum level (`trace|debug|info|warn|error`, default `info`).
- `SENSUS_LOG_STRICT` — default off; when `1`, a small allow-listed set of absorbed
  daemon failures rethrow after logging (used by tests; otherwise every catch still
  swallows per AGENTS.md rule 10).

Read it with `sensus daemon logs` (not `daemon.log`):

| Flag | Behavior |
|---|---|
| `--json` / `--pretty` | Force raw NDJSON / pretty lines (default: pretty on a TTY, raw when piped; if both, the last wins) |
| `--level <lvl>` | Minimum level filter |
| `--component <s>` | Exact component match, or a trailing-`*` prefix (`daemon*`) |
| `--follow`, `-f` | Keep printing appended records until Ctrl+C |

`sensus daemon logs | jq` works (raw NDJSON). When the structured file is absent the CLI
prints `(no daemon log yet — <path>)` and, if a raw `daemon.log` exists, points at it
explicitly rather than showing nothing.

## Exit & lifecycle

The TUI is a front end to the local `sensus daemon` (D5). **Exiting detaches (D4):** the
last pane exiting, closing any tab (`Ctrl+W`/`×`), `Ctrl+A d`, a signal, or `/quit` closes the
client's WebSocket, destroys the renderer, and returns to the outer shell — the daemon
keeps every shell and any running turn alive, and they are re-attachable on the next boot
(the boot re-attach picker lists unattended shells/chats; an unsent/empty chat is skipped, so
closing an empty tab never prompts). Re-attach is bounded by the **idle reaper**: a shell
inactive longer than the re-attach window (8h by default) is killed, so a session from a
previous workday is never re-attached. Closing a tab never kills its shell — type `exit` in
the pane to end one (the daemon then releases its bound chat). Transcripts are persisted as
they stream, so a later `--resume` (or the `/sessions` overlay) reopens a past chat into a
fresh tab.

A full teardown is `sensus daemon stop` (see "Daemon"): it kills every PTY child and MCP
server and removes the socket/pid. `sensus kill` is the global version — it stops every
daemon this user runs, whatever runtime dir each was started with (a forgotten dev instance,
a stale persistent unit), not just this environment's. `sensus` auto-spawns an on-demand
daemon at boot (D3) and fails boot with a clear message if it cannot be reached or spawned
(never a crash).

`SENSUS_ACTIVE=1` is set in every PTY child, so the **nest guard** refuses a manual
`sensus` typed inside a sensus pane; `SENSUS_SKIP=1` overrides it for tests/dogfooding.
The daemon is a SEPARATE process, not a child of any TUI.

## Gotchas & invariants

- **The binary is not `bun build --compile`.** Use `scripts/build.ts`; see the rules above.
- **`sensus` is a child of the shell you launched it from, never `exec`'d.** Exit must return
  to the prompt with nothing printed. It is not auto-started from any rc file.
- **`sensus init` never writes a shell rc file.** Setup is an in-app modal now, so cancelling
  (confirm-gated) writes nothing; only the headless `--create-config` and the wizard's save
  touch `config.json`. A boot config error no longer refuses to start — the TUI comes up and
  setup fixes the endpoint.
- **Exit kills every PTY child.** `TerminalSession.kill()` runs on tab close and UI cleanup;
  there is no server or socket to clean up.
- **MCP servers die on exit** (`stopAll`) — the sensus process leaves, and orphaned children
  would hold pipes/ports.
- **Session writes never throw.** A failing disk must not crash the TUI.
- **Resume is provider-history-aware, not just transcript replay**: it rebuilds from the last
  compaction checkpoint.

## Related docs

- [`architecture.md`](architecture.md) — the full lifecycle and module map
- [`daemon-api.md`](daemon-api.md) — the daemon REST API and lifecycle
- [`events.md`](events.md) — the instance identity and the durable event log
- [`triggers.md`](triggers.md) — local condition triggers + the trigger log
- [`config.md`](config.md) — config locations, schema, resolution order
- [`testing.md`](testing.md) — the ship guard and how to run the suites
- [`../README.md`](../README.md) — the user-facing quick start
