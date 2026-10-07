# Terminal Layer (Terminal Engine)

## Overview

The engine behind the left pane: one interactive shell per tab on a **private native PTY**
(`Bun.Terminal` + `Bun.spawn({ terminal })`), rendered by OpenTUI's
`EmbeddedTerminalRenderable` (a Ghostty VT parser compiled into the native artifact).
Sensus still does **not** write its own VT emulator — the renderable owns the screen,
cursor, colors, and native scrollback; we only scan the byte stream for the facts it does
not expose to JS. tmux is no longer a runtime dependency; it survives only as an optional
**outer** test harness (smoke tests boot the app inside a tmux driver, never a private
sensus server). The UI that mounts the renderable is [`ui.md`](ui.md); the color rules are
[`DESIGN.md`](DESIGN.md).

## Key files

| File | Purpose |
|---|---|
| `src/terminal/ptySession.ts` | `PtySession` + `TerminalStatus` + `PtySessionOptions`: the **headless** PTY core (no `@opentui/core`) — PTY spawn, the SGR-rewrite → scanner pipeline, the input reply-leak guard, resize, status facts, the text ring, `onOutput`/`onExit`/`kill()` |
| `src/terminal/session.ts` | `TerminalSession` (client): builds on `PtySession` and adds the embedded-VT renderable, the `PanePainter` render hook, focus/blur, bracketed paste, and the screen-grid `status()`/`paneState()` |
| `src/terminal/launch.ts` | `shellLaunchArgv`: launches the pane shell so the PTY is its **controlling terminal** (bash claims the tty, then `exec`s the real shell) |
| `src/terminal/shellIntegration.ts` | Shell integration: generated zsh/bash startup files plus the `ZDOTDIR` / `--rcfile` launch plan that makes the pane shell report `$PWD` via OSC 7 (pure planners + a per-process generated dir) |
| `src/terminal/scan.ts` | `StreamScanner` + `TextRing`: incremental OSC/CSI scanner over raw bytes for the plain-text ring, title, OSC 7 cwd, alt-screen flag, application-cursor (DECCKM) and OSC 133 marks |
| `src/terminal/sgr.ts` | `SgrColorRewriter` + `buildPanePalette`: rewrites indexed output SGR colors to truecolor from the detected/override palette and re-applies the theme default **fg** on resets before the bytes reach the VT (the default **bg** is painted by `paneBg.ts`; pure, incremental, never throws) |
| `src/terminal/paneBg.ts` | `PanePainter` + `paintDefaultBackground`: in the renderable's `renderAfter` hook, remaps frozen theme/palette colors to the current ones and repaints the VT's opaque-black default-background cells, so existing content follows the theme across resize and theme switches (pure) |
| `src/terminal/scrollback.ts` | `TerminalScrollback` + `DEFAULT_PANE_SCROLLBACK_BYTES` + `TerminalScrollInfo`: the pane scrollbar's geometry. Renderer-free (a `ScrollbackViewport` seam): calibrates the exact history depth with relative scrolls + a screen-unchanged probe, tracks the viewport row between calibrations, and throttles re-measures (pinned vs. scrolled). The client's native-scroll hook adds wheel acceleration |
| `src/terminal/keys.ts` | `KeyAction` vocabulary, opentui key event → action mapping, action → raw PTY bytes (`mapKeyEventToAction`, `agentKeyAction`, `encodeKeyAction`, `encodeNamedKey`), and the embedded renderable's F1–F12 patch (`installFunctionKeyEncoding`) |
| `src/terminal/responseGuard.ts` | `ResponseLeakGuard` + `looksLikeTerminalResponse`: drops terminal-query reply tails the stdin parser split into key events, so they are never typed into the pane |
| `src/terminal/paneState.ts` | `classifyPaneState` + `PaneState`: structured state probe (`prompt`/`continuation`/`running`/`password-prompt`/`fullscreen`/`unknown`) over the LIVE screen grid, plus `paneStateRefusal`/`formatPaneEvidence` (pure, never throws) |
| `src/terminal/delivery.ts` | `verifyPaneDelivery`: bounded echo/prompt-anchored check that a `shell_session` write actually landed (`delivered` vs `unverified`; pure, never throws) |

The UI side that consumes these is `src/ui/components/TerminalPane.tsx` ([`ui.md`](ui.md)).

## PTY core vs renderable

The terminal engine is split in two along the renderer boundary (D1):

- **`PtySession` (`ptySession.ts`) is headless.** It owns the PTY child
  (`Bun.Terminal` + `Bun.spawn({ terminal })`), the output pipeline
  (`SgrColorRewriter` → `StreamScanner`), the input `ResponseLeakGuard`, resize,
  the plain-text ring, and the status facts. It imports **no `@opentui/core`** and
  has no screen grid, so the daemon can own shells without a renderer. Its public
  surface is `write(bytes)` (guarded input), `sendKeys`/`sendText`/`sendBytes`,
  `resize`, `recentLines`/`captureScrollbackRaw`, `status()`/`paneState()`,
  `onOutput(cb)` (raw post-rewrite bytes, for a client/WS to fan out),
  `onExit(cb)`, `setPalette`/`setBoldBright`/`setDefaults`, `kill()`, `pid`,
  `exited`, `cols`, `rows`. Every method is defensively wrapped: a PTY failure is
  a dead session, never a throw. `onOutput` buffers (bounded) until the first
  listener attaches, so bytes written before a client mounts are not lost.
- **`TerminalSession` (`session.ts`) is the client.** It builds on a `PtySession`,
  mounts the `EmbeddedTerminalRenderable` (the Ghostty VT — screen, cursor,
  colors, native scrollback), pipes `onOutput` into `renderable.write`, routes the
  renderable's `onData` (keys/mouse + DA/CPR replies) to `pty.write`, and owns the
  `PanePainter` theming hook. Its `paneState()` still classifies the **live screen
  grid** (the renderable's `screen().lines` + cursor); its `status()` overlays the
  native cursor onto the `PtySession` facts.

`src/engine/index.ts` exports `PtySession`; `TerminalSession` stays client-only.
`tests/unit/engine/importGraph.test.ts` fails if any engine-side file imports
`@opentui/core` (the one allowed exception is `session.ts`). With no client
attached, `PtySession.paneState()` falls back to the scanner-ring lines (D2) and
passes `cursorY: null`; `status()` reports `cursorX`/`cursorY` as `null`.

## Daemon-hosted PTY (P3c-i)

D1 splits the pane along the transport: the **daemon owns every `PtySession`**,
the **client owns the embedded VT**. `src/daemon/shells.ts` (`ShellRegistry`)
spawns the shell through the same `PtySession.spawn` path the TUI uses (native
`Bun.Terminal`, `shellLaunchArgv`, shell integration) and fans its post-rewrite
`onOutput` bytes out as `terminal.output` frames over `GET /v1/ws`
([`daemon-api.md`](daemon-api.md)). The client feeds those bytes to
`SgrColorRewriter` → `EmbeddedTerminalRenderable.write` and returns its
renderable's `onData` bytes as `terminal.input`; the renderable's VT stays
single-sourced in OpenTUI (D2). `TerminalSession` (`session.ts`) is the in-process
client; the remote client is P4.

The daemon side adds only what the TUI kept in `TerminalSession` outside the
renderable:

- **Roles (D11):** one controller may `terminal.input`/`terminal.resize`; other
  attached clients are read-only observers, with explicit `terminal.handover`.
- **Replay (D12):** a bounded (~1 MiB, drop-oldest) raw post-rewrite byte ring
  per shell plus an absolute output cursor (`outCursor`, with `bufferStart` the
  absolute offset of the oldest retained byte). Every `terminal.output` frame
  carries its end cursor; `terminal.attach` takes the client's last applied
  cursor and replays only the missed range (flagged `truncated` when the cursor
  predates the ring, in which case the retained ring is replayed whole with
  `resetAlt` when the shell is on the alternate screen). The client applies
  replay and live frames as absolute ranges and skips anything it already has,
  so reattach is idempotent; a dropped frame is detected from the cursor gap and
  healed with a resync attach from the last applied offset.
- **Facts (D2):** `terminal.facts` stores the attached client's VT grid
  (`lines` + cursor) as the authoritative pane state; the scanner ring remains
  the no-client fallback (`PtySession.paneState()`).

`PtySession` with no palette and no theme defaults is byte-transparent (the SGR
rewrite is a no-op), so the daemon streams the shell's exact bytes; the client's
rewriter/painter apply the theme. `daemon stop`/`stop()` kills every shell, so no
PTY child is orphaned.

## Wiring

```
Bun.Terminal (PTY)  --data callback-->  rewrite indexed SGR -> scan
      ^                                      |
      | write(bytes)                         v
      |                              PtySession.onOutput(bytes)
      |                                      |
      |                              EmbeddedTerminalRenderable.write
      |                                      |
      | onData(encoded keys/mouse + emulator responses)
      +--------- PtySession.write <----------+
```

- `PtySession.spawn(opts)` creates the `Bun.Terminal` and starts the child. The
  session object exists before the child runs so the PTY's first output bytes are not
  dropped (a late-bound holder forwards the data callback once construction completes);
  bytes emitted before a client attaches `onOutput` are buffered (bounded).
- `TerminalSession.spawn(ctx, opts)` creates the `PtySession`, then the
  `EmbeddedTerminalRenderable` in `ctx` (a renderer-level spawn failure still throws so the
  caller can toast and skip the tab).
- The renderable is created with a `renderAfter` hook that runs `PanePainter.paint`
  (`paneBg.ts`) after every compose: it remaps frozen theme/palette colors to the current
  ones and repaints the VT's opaque-black default background (see
  [Colors](#colors-adaptive-rewrite)).
- `PtySession.handleOutput(bytes)` rewrites indexed SGR colors to truecolor and re-applies
  the theme default fg through `SgrColorRewriter` (see [Colors](#colors-adaptive-rewrite)),
  pushes the rewritten bytes into the scanner, then fans them out to the renderable through
  `onOutput`. Every method is defensively wrapped: a PTY/renderable failure surfaces as a
  dead session or a dropped byte, never an exception (the TUI must not crash on unexpected
  data).
- The renderable's `onData` fires for encoded keys/mouse (`source: "input"`) **and**
  emulator responses such as DA/CPR replies (`source: "response"`); both belong on the PTY
  input, so the source is deliberately ignored and the bytes go to `PtySession.write`,
  which passes them through the [reply leak guard](#input--focus).
- `onTerminalResize` forwards the renderable's new size to `PtySession.resize()` (which
  calls `term.resize()` and updates `cols`/`rows`).

### PTY child

- Spawned with `Bun.spawn({ cmd: shellLaunchArgv(opts.shell), terminal: term, cwd, detached: true, env })`.
- **`detached: true` is load-bearing, not cosmetic.** Without it the child inherits the
  parent's session, so the shell never becomes a session leader and `/dev/tty` resolves to the
  OUTER terminal instead of the pane. `detached` makes Bun call `setsid()`. The child is
  killed explicitly via `kill()` (it does not get SIGHUP on exit).
- **`setsid()` alone does NOT make the PTY the controlling terminal** — Bun never calls
  `TIOCSCTTY`. bash claims the tty while starting; zsh and fish do not, so a zsh pane had
  `open("/dev/tty")` fail with ENXIO and `sudo`/`ssh`/`gpg` died with "a terminal is required
  to read the password". `shellLaunchArgv` (`launch.ts`) therefore spawns every non-bash shell
  as `bash -c 'exec "$0" "$@"' <shell>`: bash claims the controlling tty, then the SAME pid
  becomes the requested shell (no extra process). A pane whose shell is bash spawns directly.
  See also the [`agent.md`](agent.md) sudo notes.
- **`Bun.Terminal.name` does NOT set the child's `$TERM`** (verified in the spike).
  `TERM=xterm-256color`, `COLORTERM=truecolor`, and `SENSUS_ACTIVE=1` are set explicitly in
  the spawn env, over `process.env`, with `opts.env` last. `opts.env` also carries
  `SUDO_ASKPASS` (a session-lived helper from `src/agent/sudoAskpass.ts`) so a `shell_session`
  sudo command authenticates from the session password with no in-pane prompt
  ([`agent.md`](agent.md) "Sudo").
- Default shell: the config `shell` value (`$SHELL`, fallback `/bin/zsh` — see
  [`config.md`](config.md)).
- **`maxScrollback` is a byte budget, not lines** (OpenTUI's own 10_000-byte default keeps
  only ~1_000 short lines). Sensus passes `DEFAULT_PANE_SCROLLBACK_BYTES` (10 MB, Ghostty's
  default) so the pane retains thousands of rows; the client's `TerminalScrollback`
  measures the real history depth for the scrollbar (see [Scrollbar](#scrollbar-client)).

### Shell integration (cwd + prompt bindings)

The status bar's `cwd` chip, the agent's terminal-context block, and relative file-tool
paths all read the pane cwd — which only comes from **OSC 7**. zsh and bash do not emit it
on their own, so without integration the chip froze at the spawn directory. At spawn,
`PtySession` merges the `shellIntegration.ts` plan into the child (`shellLaunchArgv`
`extraArgs` + spawn env) so the shell reports `$PWD` before every prompt:

| Family | Mechanism |
|---|---|
| **zsh** | `ZDOTDIR` points at a generated dir whose `.zshenv`/`.zshrc` source the user's files (the original dir is preserved in `SENSUS_USER_ZDOTDIR`), then append `_sensus_report_cwd` to `precmd_functions`, and fill in the Ctrl+Left/Right `backward-word`/`forward-word` bindings zsh does not ship (only when the user's rc left `^[[1;5D`/`^[[1;5C` unbound; bash readline and fish bind them natively). `ZDOTDIR` stays ours so a pane `exec zsh` keeps the hook. |
| **bash** | `bash --rcfile <generated>` replays bash's normal interactive rc chain (`bash --rcfile` replaces **both** the system and user rc: `/etc/bash.bashrc`, `/etc/bashrc`, `~/.bashrc`), then prepends `_sensus_report_cwd` to `PROMPT_COMMAND`. Ctrl+Left/Right are already bound by readline. |
| **fish** | Untouched — fish reports OSC 7 natively (unconditional since 4.0) and binds Ctrl+Left/Right. |
| **sh/dash/other** | Untouched; the spawn-cwd fallback stands. |

The reporter emits a BEL-terminated `ESC ] 7 ; file://<host><PWD> BEL`; the scanner's OSC
handler percent-decodes it into `StreamScanner.cwd` (`parseOsc7`). The generated dir is one
`mkdtemp` per process (shared by every tab, files written once) and removed on process exit;
`prepareShellIntegration` never throws — a failure just leaves the spawn-cwd fallback in
place, so the pane always boots.

## Input & focus

- While the terminal region is focused, the renderable owns key/mouse encoding and writes
  to the PTY through `onData`. `App` does nothing for terminal-focus keys in its dispatch —
  they are already consumed by the focused renderable.
- **Extended keyboard protocols / `modifyOtherKeys` level 2** (boot, `src/index.tsx`):
  the kitty protocol is pushed and the xterm fallback is upgraded to level 2
  (`enableModifyOtherKeysLevel2`, `>4;2m`) so non-kitty terminals report the Shift
  modifier on Enter ([`keybindings.md`](keybindings.md) "Gotchas"). Level 2 changes the
  encoding of every modified key: the terminal sends `CSI 27 ; <mod> ; <code> ~` (e.g.
  `ESC [ 27 ; 2 ; 13 ~` Shift+Enter, `ESC [ 27 ; 5 ; 101 ~` Ctrl+E). OpenTUI's parser
  decodes that to `{name, ctrl/shift}` and the focused renderable **re-encodes it for the
  embedded PTY** (its native key encoder) — the bytes are never forwarded as literal text,
  nor double-encoded. Verified end-to-end in `tests/smoke/chat.test.ts`: the raw
  Shift+Enter sequence inserts a chat newline instead of sending, and a Ctrl+letter / Tab /
  Enter regression pass reaches the shell (readline end-of-line, `^I` from `cat -A`, and a
  submitted command) with no dropped keys.
- **Function keys are patched in** (`keys.ts` `installFunctionKeyEncoding`, applied by both
  clients right after the renderable is constructed): OpenTUI's
  `EmbeddedTerminalRenderable` derives the native encoder's physical key through an internal
  `physicalKey()` that has **no F1–F12 mapping** — the parsed event carries either an SS3
  pair (`OP` for F1) or a raw CSI string (`[15~` for F5), both of which fail its lookup, so
  the native encoder received an empty key and every function key was silently dropped
  (nvtop's F2/F12, htop's F-keys dead). The patch sets the event's `code` to the physical
  name (`F1`…`F12`) for the native call and restores it after; the native encoder then emits
  the right sequence and still honors modifiers and the inner app's kitty keyboard mode.
  Remove the patch once OpenTUI maps function keys itself.
- **Terminal-reply leak guard** (`responseGuard.ts`): OpenTUI's stdin parser flushes an
  incomplete escape sequence after a 20 ms timeout. When a reply to sensus's OSC 4/10/11
  (palette/theme) or CSI capability probes is split across reads — typical over SSH, where the
  ssh client/PTY re-chunk the bytes — the parser emits the reply's head as a dropped response
  and its **tail as ordinary key events**, which the focused pane renderable would type into
  the visible shell (the `:ffff/ffff/ffff` / `]11;rgb:…` reports users see on the prompt).
  `PtySession.write` (the renderable's `onData` target) runs every chunk through `ResponseLeakGuard`: a chunk
  that begins with ESC (an encoded key, bracketed paste, or SGR mouse) and ordinary characters
  pass untouched; a run beginning with a reply-opening byte (`: ; # [ ] r g b ? >`) is held for
  at most ~30 ms of idle so the whole run can be classified — a run that reads as a terminal
  reply (colour triplet, `#rrggbb`, numeric CSI reply, XTVERSION, CPR tail) is dropped, anything
  else is released. A dropped reply opens a short (~500 ms) tail window that keeps discarding
  residual reply bytes (hex, `/`, separators) that arrive in a later read without a marker — the
  reported `:ffff/ffff/ffff` followed by a separate `0c` — and a real keystroke ends it. Human
  typing cannot accumulate a reply-shaped run (the idle timer flushes between keystrokes), so the
  pane never loses ordinary input.
- `renderable.blur()` **fully suspends terminal input** (global hotkeys still fire). This is
  how chat focus, open overlays, and the armed Ctrl+A prefix window suppress terminal
  input; `focus()` restores it. `TerminalPane` mirrors the store's focus flag onto the
  renderable.
- Global hotkeys are consumed before the renderable by the `@opentui/keymap` layer
  ([`keybindings.md`](keybindings.md)).
- `Ctrl+C` reaches the shell as `0x03` (`C-C` → `0x03`); the renderer is created with
  `exitOnCtrlC: false` so it does not quit sensus.
- `Ctrl+Left` / `Ctrl+Right` reach the shell as the xterm `ESC [ 1 ; 5 D` / `ESC [ 1 ; 5 C`
  (the renderable's native encoding). Bash readline and fish bind those to
  `backward-word`/`forward-word`; vanilla zsh does not, so the generated zsh shell
  integration fills the bindings in when the user's rc left them unbound
  ([keybindings.md](keybindings.md) — the chat input uses the same keys for word movement).
- Mouse and selection are native: the renderable forwards mouse/wheel and click-to-focus,
  and the renderer's `focused_renderable` event mirrors a click into the store. There is no
  manual mouse re-encoding layer.

### Key encoding (`keys.ts`)

While the renderable is focused it encodes live typing itself; `keys.ts` is the encoder for
the paths that build actions in JS (the prefix pass-through, `shell_session`, and any
programmatic send).

- `KeyAction` is either `{ kind: "literal", text }` (UTF-8 bytes) or
  `{ kind: "keys", names }` (concatenated raw sequences). The vocabulary keeps the
  tmux-style spellings (`Enter`, `Tab`, `BSpace`, `Up`, `C-A`, `M-X`, `S-Tab`, `F5`, …), so
  callers that build actions by hand (the prefix machine, `shell_session`) keep working.
- `mapKeyEventToAction` maps one opentui key event; `agentKeyAction` parses the
  agent-facing `shell_session` spellings (`enter`, `ctrl+c`, `alt+x`, `shift+tab`,
  `f1..f12`, …). Both are pure and drop unrepresentable keys (never throw).
- Shifted letters: opentui reports the base name with `shift: true`, so a shifted letter is
  reconstructed as the uppercase glyph; shifted punctuation arrives as the glyph already.
- `S-Tab` (and `BTab`) encode as the back-tab sequence `ESC [ Z`.
- Named keys with modifiers on arrows / Home / End / PageUp / PageDown / Insert / Delete /
  F1–F12 go through the xterm CSI modifier parameter (`ESC [ 1 ; <m> <final>`, and
  `ESC [ <n> ; <m> ~` for the `~`-final keys); Alt/Meta on the remaining keys (Enter, Tab,
  …) is an **ESC prefix** (`M-Enter` → `ESC CR`).
- Char combos: `C-a` → `0x01`, `C-?` → `0x7f`, `C-@`/`C-Space` → `0x00`, `M-x` → `ESC x`,
  `C-M-x` → `ESC <ctrl byte>`.
- Unmodified printable keys are literal actions; paste is a single literal action (the
  renderable does its own bracketed-paste framing while focused).
- **DECCKM:** when the scanner's `applicationCursor` flag is set (the shell asked for
  application cursor keys), unmodified arrows / Home / End encode as SS3 (`ESC O A`,
  `ESC O H`, …) instead of CSI (`ESC [ A`, …); modified forms keep the CSI modifier
  parameter. `TerminalSession.sendKeys` sources the mode from the scanner, so the prefix
  pass-through and `shell_session` both honor it.

## Status & facts

`status()` returns `TerminalStatus`:

| Field | Source |
|---|---|
| `dead` / `deadStatus` | the child's `exited` promise (`deadStatus` null while alive) |
| `cols` / `rows` | the session's last known size |
| `cwd` | OSC 7 (scanner), emitted by the shell integration, falling back to the spawn cwd |
| `currentCommand` | always `""` — a native PTY has no `#{pane_current_command}`; the tab title shows the session title and falls back to the shell basename |
| `alternateOn` | CSI `?47`/`?1047`/`?1049` h/l from the scanner |
| `applicationCursor` | DECSET/DECRST `?1` (DECCKM) from the scanner |
| `commandRunning` | OSC 133 `C` (command started) … `D` (finished), from the scanner |
| `lastExitCode` | exit code from the last OSC 133 `D;<code>`, else null |
| `cursorX` / `cursorY` / `cursorVisible` | `renderable.screen().cursor` (native; no synthesized overlay) in `TerminalSession`; `null`/`null`/`false` in the headless `PtySession` |

There is no palette hook into the renderable and no `display-message`-style status RPC: the
native screen owns the cursor and colors, and the scanner supplies only the facts the
renderable does not expose to JS. Because the VT ignores the host palette, indexed SGR
colors and the default fg are rewritten on the way in, and the pane is repainted after
each compose (see [Colors](#colors-adaptive-rewrite)).

## Pane state (`paneState.ts`) — source of truth

The agent's window into the pane used to be `get_scrollback` alone: raw, wrapped,
prompt-redrawn text that encodes "at a prompt" vs "mid-continuation", "running", "waiting
for a password" and "a full-screen app owns the terminal" in nothing but prose. Both
#19 incidents (a command swallowed by a `dquote>` continuation; a countdown misreported)
were guess-the-state failures. `paneState.ts` turns that into a small typed object.

- **Source: the live screen grid, not scrollback.** `TerminalSession.paneState()` reads
  `renderable.screen().lines` (the bottom N visible lines the embedded Ghostty VT
  composes, wrapping/redraws already resolved) plus the scanner's `alternateOn` /
  `commandRunning` flags. It does not parse the scanner's ring. The headless
  `PtySession.paneState()` (no client, D2) is the fallback: it classifies the scanner
  ring's bottom lines with `cursorY: null`.
- **Shape:** `state` (`prompt` | `continuation` | `running` | `password-prompt` |
  `fullscreen` | `unknown`), `continuationKind` (`dquote` | `quote` | `heredoc` |
  `backtick` | `paren`; absent for a bare bash PS2 `> `), `cwd`, `shellPid`, `tail` (a few
  sanitized bottom lines for evidence), `confidence` (0..1), and `lastCommand` (heuristic
  last accepted command-looking line, else null).
- **Precedence:** a waiting password/confirmation prompt (sudo/ssh/su/gpg/host-key) wins —
  the shell is blocked on input — then the alternate screen, then a running command
  (OSC 133, outranking the screen text), then a continuation, then a prompt. Nothing
  matching is `unknown`.
- **Confidence + refusal.** Named zsh continuations (`dquote>`/`quote>`/`heredoc>`/
  `cmdsubst>`/…) score 0.9; a bare `> ` scores 0.6; a prompt scores 0.8 (0.9 with OSC 133
  idle, 0.6 for a prompt with pending input). `paneStateRefusal` returns a reason only for
  a confident (`≥0.5`) non-prompt state; `unknown` never refuses.
- **Best-effort and never throws** (AGENTS.md rule 10): a malformed/native surprise yields
  `unknown`, and every helper is pure or defensively wrapped.
- **Consumers.** `shell_session` pre-flights it before typing (refusing a continuation,
  running command, password prompt or full-screen app; see [`agent.md`](agent.md)
  "`shell_session`") and echoes the state in its result so the agent can plan. OSC 133
  marks are parsed but not yet emitted by the generated shell integration, so in practice
  `running` usually comes from a real prompt/continuation shape rather than the flag.

`delivery.ts` is the sibling acknowledgement: after a `shell_session` write it classifies
the before/after tails (`verifyPaneDelivery`) — the typed text echoed on a changed screen
is `delivered`; a missing echo is `unverified`, never a hard failure.

## The scanner (`scan.ts`)

`StreamScanner` is the embedded-terminal analogue of tmux's `capture-pane` /
`display-message`: it exists only for the facts the renderable does not expose to us.
Contract: **never throws and never unbounded**.

- Decoding is incremental (`TextDecoder` with `{ stream: true }`); incomplete escape
  sequences stay in a carry string capped at 64KB (cleared if exceeded). UTF-8 multibyte
  sequences split across PTY chunks decode intact.
- Consumes CSI, OSC (BEL- or ST-terminated), DCS/SOS/PM/APC (through ST/BEL), charset
  designations, and single-byte escapes; other C0 controls and `DEL` are ignored.
- Plain text accumulates into `TextRing` (default capacity 5000): `\n` pushes a line, `\r`
  rewinds the write column (a progress bar `50%\r100%` overwrites in place while CRLF
  output keeps its content), tab → four spaces, backspace pops a column. The ring is a
  fixed array with a moving head index, so a full ring overwrites its oldest slot in O(1)
  (no per-line buffer shift under high line-rate output).
- OSC `0`/`2` set the title; OSC `7` sets `cwd` (percent-decoded; accepts
  `file://host/path`, `file:///path`, and host-less `file:/path`). OSC 7 is produced by the
  generated shell integration (above), not by zsh/bash themselves.
- The alternate screen is tracked from DECSET `?47`/`?1047`/`?1049`.
- DECSET/DECRST `?1` (DECCKM, application cursor keys) sets `applicationCursor`; OSC 133
  (FinalTerm shell-integration marks `A`/`B`/`C`/`D;<exit>`) tracks `commandRunning` and
  `lastExitCode`. OSC 133 is PARSED but the generated shell integration does not yet EMIT
  it (a known follow-up), so those two fields may be absent in practice.

## Capture & scrollback

- **Visible screen:** `renderable.screen().lines` (`screenText()`), composed plain text.
- **Agent context tail:** `recentLines(n)` slices the scanner ring (the per-message context
  block; `App` passes 200).
- **`get_scrollback`:** `captureScrollbackRaw(lines)` returns the last N scanned plain-text
  lines, clamped to the tool's hard cap of 5000 (default 500).
- The **native scrollback** held by the embedded VT has no read API, so deep history for
  the agent comes from our bounded plain-text ring (cap 5000 lines), not from the VT's
  scrollback. Wheel scrollback is handled natively by the renderable, macOS-accelerated
  by the client hook; the user-facing scrollbar is reconstructed below.

### Scrollbar (client)

The embedded VT exposes no "where am I" getter — only `scroll(delta)` and the composed
screen — so `src/terminal/scrollback.ts` (`TerminalScrollback`, renderer-free) reconstructs
the geometry for the overlay bar that [`ui/components/TerminalPane.tsx`](ui.md) mounts:

- **Calibration** measures the exact history depth: scroll to the top, then binary-search
  the first row where scrolling down one more row leaves the composed *screen* unchanged
  (a pin-to-bottom probe driven by the client's char-buffer hash). It is cursor-independent,
  so an app that hides the cursor or parks it mid-screen cannot fool it, and a no-op
  viewport (tests/fakes) degrades to an empty range in one probe.
- **Tracking** keeps the viewport row between calibrations. `RemoteTerminalSession`
  installs a per-renderable hook over the native scroll call
  (`installTerminalWheelScroll`) that scales the wheel's ±3-row fallback with
  `MacOSScrollAccel` (matching the chat list) and feeds every native move to the
  controller; `scrollTo(position)` is the scrollbar drag/click route, and output/resize
  only mark the geometry stale. `info()` re-measures at most every 2.5 s while pinned,
  800 ms while scrolled, and a scroll action may force one after 400 ms — all synchronous,
  so the viewport is restored before the next frame.
- **Rendering:** a width-1 `ScrollBarRenderable` overlays the terminal's last column
  (z-index above the buffered VT, `focusable: false` so a drag never steals the pane's
  keyboard, transparent track so only the thumb covers cells, thumb = the theme
  `scrollbar` token falling back to muted). It auto-hides while there is no history and
  while an alternate-screen app owns the VT. `TerminalPane` polls `session.scrollInfo()`
  at ~8 Hz; `session.scrollTo()` maps a drag/click back to the VT.

## Cursor

The cursor is native: `renderable.screen().cursor` (`x`, `y`, `visible`; hidden by DECSET
25l). There is no synthesized cursor overlay and no pane blink phase — the shared
`ui/lib/blink.ts` phase remains for the chat input caret only.

## Resize

- `resize(cols, rows)` calls `term.resize()` and sets the renderable's `width`/`height`.
- The renderable's own `onTerminalResize` (which forwards to `term.resize()` and updates
  `cols`/`rows`) is unreliable for an **inner** layout change — the Alt+./Alt+, sidebar
  resize and the divider drag: the card narrows but the shell can keep its OLD width and
  wrap at the wrong column. `App` therefore drives the **active** session from the computed
  pane cells: a `createEffect` calls `session.resize(cells())` whenever the cell size
  changes (skipped below the 20×5 minimum, where the too-small notice replaces the layout).
  `TerminalPane` still mounts the renderable at `100%` with `flexGrow`, so the initial
  layout and outer renderer resizes keep firing `onTerminalResize`. `/status` reads the live
  `session.status()`, not the ~1s-polled store copy, so a size immediately after a resize is
  not masked by the poll.
- Cell size = the pane area of the layout (`ui/lib/layout.ts` `computePaneCells`): width −
  sidebar − (in `layout: "sidebar"`, the vertical tab-rail width) − divider gap − border,
  height − tab bar − status bar − border. In `"sidebar"` layout the rail replaces the top
  tab bar, so the pane loses the rail's columns but gains the top-bar row. (The terminal and
  chat are separate bordered cards with a 1-column draggable gap between them.)
- The 20×5 terminal-size guard lives in `ui/lib/layout.ts`: below it the app refuses to
  boot with a clear message, and a mid-run shrink shows a notice until it recovers.

## Death & lifecycle

- `proc.exited` resolves → `markDead(code)` sets `dead`/`deadStatus` and fires registered
  `onExit` listeners once (immediately, via microtask, if already dead).
- A dead tab closes (focusing a neighbor); when it was the last tab, sensus detaches and the
  user drops back to the outer shell. Closing a tab (`Ctrl+W`/`×`) does **not** kill its
  shell: the daemon keeps it (and any running turn) alive for the next boot's re-attach
  picker, until the idle reaper kills a pane left inactive past the re-attach window
  (`SENSUS_DAEMON_REATTACH_MAX_AGE_MS`, 8h; see [`daemon-api.md`](daemon-api.md)
  "Lifecycle"). Only typing `exit` in the pane ends that shell; the daemon then releases its
  bound chat.
- `PtySession.kill()` sets `closed`, kills the child, and closes the PTY (best-effort, never
  throws). In the TUI this path is reached when a shell is genuinely ended (`exit`/`daemon
  stop`), not on an ordinary tab close.
- There is no tmux server and no detached registry; detach/reattach is daemon-owned
  ([`daemon-api.md`](daemon-api.md)). `Ctrl+A d` quits sensus
  ([`keybindings.md`](keybindings.md)).

## Colors (adaptive rewrite)

The embedded VT composes a **fixed built-in palette** (libghostty "Tomorrow Night": index 1
`#CC6666`, 2 `#B5BD68`, 4 `#81A2BE`, 9 `#D54E53`, …) and exposes **no palette hook**:
`rendererSetPaletteState` does not affect what it composes (verified). So sensus adapts the
pane by rewriting the shell's **output** SGR color parameters to **truecolor** from the
terminal's detected palette before the bytes reach the VT. Truecolor passes through the VT
unchanged, so the pane follows the user's terminal theme again (the adaptive-theme promise).

`src/terminal/sgr.ts` (`SgrColorRewriter` + `buildPanePalette`; pure, incremental, never
throws) sits in `PtySession.handleOutput` between the PTY data callback and the
`onOutput` fan-out to `renderable.write`. It rewrites:

- basic fg/bg `30-37` / `40-47` → `palette[index]`;
- bright fg/bg `90-97` / `100-107` → `palette[index + 8]`;
- `38;5;n` / `48;5;n` (and colon forms) → `palette[n]` when known;
- the **default fg** (`\e[0m` / `\e[m`, `39`) → the active theme's fg truecolor, re-applied
  so plain text never falls back to the VT's own fg. The **default bg** (reset / `49`) is
  deliberately left as the VT default: an explicit bg truecolor painted onto every cell makes
  the embedded VT's width-reflow emit a blank row after every content row (the resize
  "double-spacing" bug). The default background is painted by `PanePainter` instead.

A chunk with no `ESC` byte, no pending carry, and no default prefix to assert is returned
by reference unchanged — zero allocation, the common case on high line-rate output.

The PanePainter is what repaints existing content — the SGR rewrite alone cannot: the VT
composes cells to plain RGB (it drops the SGR intent) and its own default background is
opaque black, so (a) blank/redrawn cells went back to black on resize/scroll and (b)
already-written text kept the theme it was written under after a switch. So a per-session
`PanePainter` (`src/terminal/paneBg.ts`) runs from the renderable's `renderAfter` hook —
which receives the renderable's own frame buffer after each compose — and every frame:

1. remaps each cell's fg/bg through a **source → current color map**: the previous theme
   default fg/bg and the previous palette entries mapped to the current ones, composed across
   successive changes, so existing text/prompt colors repaint immediately on a theme or
   palette change; and
2. repaints every plain opaque-black default-background cell (`[0,0,0,255]`) with the theme
   background, covering blank and newly exposed cells.

`TerminalSession.setPalette`/`setDefaults` update the painter and call `renderable.invalidate()`,
so an existing screen repaints on the change itself, not only on the next output. Together
these make the pane follow the theme across redraw, **resize**, and **theme switches**.

On the **first** output chunk the SGR rewriter asserts the theme default fg (later
theme/palette changes re-assert it without clearing — a theme switch never wipes output). It
deliberately does **not** emit a background-color-erase (`\e[2J\e[H`): once the embedded VT
has seen that clear, a later width resize wipes the visible screen back to a fresh prompt (the
"resize clears the terminal" bug). `PanePainter` themes the grid from the first composed frame
instead. Effective defaults, highest first: config `themePalette.foreground`/`background`, the
active theme's `fg`/`bg`, the terminal's detected OSC 11 background (adaptive `terminal` theme,
`bg = null`), the built-in dark/light constant. `App` seeds them before the first session
spawns and re-pushes on theme/palette/config change; per session via
`TerminalSession.setDefaults(fg, bg)` (spawn options `defaultFg`/`defaultBg`) →
`SgrColorRewriter.setDefaults` + the `PanePainter` remap/repaint.

Untouched: truecolor `38;2;r;g;b`, every attribute (bold/italic/underline/reverse/dim),
non-`m` escapes, and OSC. Because the pane's default fg is now the theme fg, **reverse
video** swaps the theme fg with the VT's default (black) bg instead of the fixed palette's
white-on-black; `PanePainter` leaves the (non-black) swapped bg untouched.

- **Palette source:** OSC 4 detection (`renderer.getPalette({size:256})`) merged with the
  config `themePalette.palette` override (the override wins per entry). `themePalette`
  `foreground`/`background` set the pane default fg (re-applied) and painted default bg (above)
  in addition to the chrome
  tokens. Unanswered entries are left as indices, so the VT palette shows for exactly those.
- **Konsole/Yakuake lie:** KDE terminals answer OSC 4 with their compiled-in
  `ColorScheme::defaultTable`, never the active scheme (a saturated primary table), so
  `src/theme/konsoleScheme.ts` resolves the real scheme when
  `isKonsoleDefaultPalette` matches the detection: the legacy `KONSOLE_PROFILE_NAME` →
  `~/.local/share/konsole/<profile>.profile` → its `ColorScheme` `.colorscheme` file
  (`Color0`-`Color7` normal + `ColorNIntense` bright + fg/bg), else the session's D-Bus
  profile (`KONSOLE_DBUS_SERVICE` + `KONSOLE_DBUS_SESSION` → `org.kde.konsole.Session.profile()`
  via the session-bus CLIs (`busctl`/`dbus-send`/`gdbus`/`qdbus`; modern Konsole no
  longer exports the env var), else `konsolerc`
  `[Desktop Entry] DefaultProfile`, else the first installed `*.colorscheme` whose
  `[Foreground]`/`[Background]` match the truthful OSC 10/11 defaults. The result is merged
  **over** the detection (0-15 + fg/bg; entries 16-255 are kept
  from the detection). `/status` then shows `source: KDE scheme "<name>"`. If every route is
  missing, `buildPanePalette` leaves the lying 0-15 row as indices — the pane
  uses the VT palette (the same look as the no-detection/SSH path) and `/status`/a one-time
  toast point at the `themePalette.palette` pin (`/status` also names the failing lookup
  step, e.g. `KDE scheme lookup: Nord.colorscheme not found`). A pin always wins the merge.
- **Fallback:** with no config override and no OSC 11 answer the default bg falls back to
  the built-in dark/light constant, so the pane still follows the selected theme rather than
  the VT's black; the fixed VT palette is used only for the indexed entries the palette did
  not answer.
- `themePalette.paneColors` (`"exact"` default | `"index"`): `"index"` disables the indexed
  rewrite and passes indices to the VT's built-in palette (the default fg re-application
  still applies; the default bg is painted by `PanePainter` either way).
- `themePalette.boldBright` (boolean, default `true`): a bold basic fg `0-7` promotes to the
  bright entry (`index + 8`), suppressed by dim, foreground only.
- The config override is seeded from the FIRST frame (before sessions spawn), so an explicit
  palette does not wait for detection. App re-merges and pushes it to every live session on
  detection and `/reload`.

The sidebar and theme tokens are unaffected: they still derive from OSC 4/10/11 detection
([`DESIGN.md`](DESIGN.md)).

## Gotchas & invariants

- **`detached: true` is required** for job control (session leader), AND the shell must claim
  the controlling tty. Bun's `setsid()` does not call `TIOCSCTTY`, so non-bash shells are
  launched through bash (`shellLaunchArgv`); dropping either breaks `/dev/tty` (sudo, ssh) or
  `Ctrl+C`/`Ctrl+Z`/`fg`/`bg`.
- **`Bun.Terminal.name` does not set the child `$TERM`** — pass `TERM`/`COLORTERM` in the
  spawn env explicitly.
- **The pane cwd depends on shell integration** — zsh/bash are launched with a generated
  `ZDOTDIR`/`--rcfile` that emits OSC 7 (fish does it natively; sh/dash fall back to the
  spawn cwd). The integration only adds a prompt hook: it sources the user's normal rc first,
  so aliases/completions/env are unchanged.
- **Alt on named keys is an ESC prefix**, not a CSI parameter; arrows/nav/F-keys use the CSI
  modifier parameter (`encodeNamedKey` in `keys.ts`).
- **OpenTUI's embedded renderable drops F1–F12** unless `installFunctionKeyEncoding` patches
  the instance (see "Input & focus") — its `physicalKey()` has no function-key mapping. The
  patch is required until OpenTUI learns them.
- **The embedded VT's scrollback has no read API** — agent deep-capture reads our bounded
  plain-text ring, not the VT's scrollback, and the pane scrollbar's geometry is
  reconstructed by `TerminalScrollback` (relative scrolls + a screen-unchanged probe),
  never read from the VT. `maxScrollback` is a **byte** budget: the 10_000-byte OpenTUI
  default is ~1_000 short lines, so the client passes `DEFAULT_PANE_SCROLLBACK_BYTES`
  (10 MB).
- **The embedded VT ignores the host palette, freezes colors, defaults to black, and its
  width-reflow is fragile** — `rendererSetPaletteState` has no effect on the renderable
  (verified). Pane fidelity comes from the `sgr.ts` output rewrite to truecolor plus the
  re-applied default **fg**, and the `paneBg.ts` `PanePainter` repaints every composed frame
  (remapping frozen theme/palette colors and the default background), so existing content
  follows the theme across resize/redraw/theme switches. The **default background is never
  painted through SGR** (no `\e[2J` erase, no default-bg truecolor): the embedded VT, once it
  has seen a `\e[2J` clear, wipes the screen on the next width resize, and an explicit bg
  truecolor on every cell makes that resize double-space every row. `PanePainter` covers both
  instead. The fixed VT palette is the fallback for the indexed entries the palette did not
  answer, and `themePalette.paneColors: "index"` opts back into it for indices.
- **The scanner must never throw or grow unbounded** (carry cap 64KB, ring cap 5000); a
  malformed byte stream degrades to dropped text.
- **`currentCommand` is always empty** with a native PTY. The tab title shows the session
  title (falling back to the shell basename) and the context `cmd:` line says `shell`.
- **`blur()` fully suspends terminal input** — overlays and the prefix window rely on it;
  global hotkeys still fire.
- **`renderable.screen()` after destroy** throws; `status()`/`screenText()` catch and fall
  back to a neutral cursor / empty lines.
- The renderable is a Core renderable mounted imperatively (not a Solid component);
  `container.add` reparents it on tab switch, and detaching only blurs it, so each
  session's VT state is preserved.
- **Smoke tests boot the app inside an outer tmux as a driver only** — no private sensus
  server and no socket ([`testing.md`](testing.md)).

## Related docs

- [`DESIGN.md`](DESIGN.md) — adaptive pane palette rewrite, color fidelity, theme tokens
- [`ui.md`](ui.md) — `TerminalPane`, the store, focus mirroring
- [`architecture.md`](architecture.md) — lifecycle (tabs, death, exit)
- [`keybindings.md`](keybindings.md) — the keymap and reserved hotkeys
- [`agent.md`](agent.md) — `shell_session`, `get_scrollback`, the context tail
- [`testing.md`](testing.md) — the outer-tmux smoke harness
