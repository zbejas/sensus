# Product

What Sensus is, who it is for, and the decisions that define it. This is the "why" doc;
[`architecture.md`](architecture.md) is the "how".

## Platform

**Terminal (TUI).** Sensus is a fullscreen alternate-screen application for Linux and
macOS. It runs inside any terminal that reports a normal size (20×5 minimum) and hosts a
real, interactive shell on a private native PTY rendered by OpenTUI's embedded VT. Over
SSH it is just a TUI; no host-side terminal multiplexer is required.

Runtime requirements: Linux or macOS on x86_64/aarch64 (the embedded terminal's native
artifact; the PTY path is POSIX-only). Build/install requirement: Bun ≥ 1.4.1 (the shipped
artifact is a standalone compiled binary that embeds the runtime, but the PTY/embedded
terminal APIs are used at runtime). No tmux or other host multiplexer is needed. See
[`operations.md`](operations.md).

## Users

Primary: **developers and operators who already live in a terminal** — people who keep a
shell (or several) open all day, run commands constantly, and want help without switching
to a browser or a separate chat window. They care about latency, keyboard control, and
their own shell environment.

Secondary: **agent-curious terminal users** who want to watch and approve what an AI does
rather than hand it a black box. Sensus's default agent is a step-by-step guide that types
into *your* terminal with your acceptance.

## Product purpose

Give a terminal user an agent that can **see and drive the terminal they are already in**.
The shell on the left is real; the agent on the right sees its context (cwd, shell, recent
output, git status), can investigate in a hidden shell, and can type into the visible pane
on request. Success = the user never loses their shell or their muscle memory, and leaves
sensus back at a plain prompt with nothing to clean up.

## Positioning

- **vs. plain tmux:** a native PTY shell with an agent that has terminal context and an
  explicit "type into my visible terminal" tool.
- **vs. a standalone chat UI:** the agent is embedded where the work happens. No copy
  between windows; a suggested command can be pasted straight into the pane (double-click it
  to run).
- **vs. a terminal emulator with AI:** Sensus does not write a VT emulator — it uses
  OpenTUI's embedded Ghostty VT for the pane, so the shell, `vim`, `htop`, colors, and
  mouse behave like a real terminal, with an agent alongside.

## Operating context

- Run `sensus` from a shell; it runs as a **child** of that shell (never `exec`'d), so
  exiting returns to it. A first run opens the in-app setup wizard (`/init-wizard` reopens it).
- Owns **one native PTY per tab** (a `Bun.Terminal` child) in the local `sensus daemon`,
  rendered by OpenTUI's embedded VT; tmux is not involved.
- Exiting (or closing a tab with `Ctrl+W`/`×`, or `Ctrl+A d`) **detaches** the TUI and
  returns to the outer shell; the shells keep running in the daemon and are re-attachable on
  the next boot. Closing a tab never kills its shell — type `exit` in the pane to end one.
  `sensus daemon stop` tears them down.
- Talks to **any configured model endpoint** — OpenAI-compatible (`/chat/completions`, the
  default), OpenAI Responses, Anthropic, or Google Gemini; keys live in an encrypted local
  store, never in `config.json`, and never on the agent's wire.
- MCP servers can extend the agent's toolbox.

## Capabilities and constraints

- Real terminal pane on a native PTY: interactive shell, full-color VT rendering,
  scrollback, mouse passthrough, resize, per-tab sessions.
- Agent chat with a real tool loop: hidden shell, visible-shell typing, file read/edit/
  write, scrollback, `ask_user`, and MCP tools.
- Approval gates by default (`confirm`): every tool call — reads, commands, writes, MCP —
  shows an inline card unless you saved an allow rule; pane typing runs free, but every
  Enter is confirmed.
- Context management: per-generation terminal context, boundary tool-output truncation
  with full-output spill, and compaction with durable checkpoints.
- Sessions persist per tab as JSONL; `--resume` rebuilds them.
- Image input: paste the system clipboard (`Ctrl+Shift+V` / `Alt+V` — a copied
  picture attaches, a copied file list pastes paths / attaches image files, text pastes as
  text) or `/image <path>` to attach it to a message; the agent can also `view_image` a local
  file, on models that accept images.
- The adaptive default theme paints **no backgrounds** and blends into the terminal's own
  palette (see [`DESIGN.md`](DESIGN.md)).
- Constraints: no VT emulation of our own (OpenTUI's embedded VT renders the pane), one
  visible pane per tab, one tab = one PTY shell = one chat session.

## Locked decisions (owner-confirmed, do not relitigate)

These are the project owner's decisions; they are constraints on every change.

1. **Stack:** Bun + TypeScript, `@opentui/solid` renderer (Solid over `@opentui/core`).
2. **Terminal engine:** embedded terminal, split across two processes. The `sensus daemon`
   owns each shell on a native PTY (`Bun.Terminal`); the TUI owns the rendering, via
   OpenTUI's `EmbeddedTerminalRenderable` (Ghostty VT). **No VT emulator of our own**; tmux
   is not a runtime dependency.
3. **Agent shell:** agent commands run in a hidden shell (`shell_background`), never the
   visible pane; `shell_session` is the explicit "type into my visible terminal" tool.
4. **Provider:** the Vercel AI SDK (`ai`) with provider packages — per endpoint,
   `@ai-sdk/openai-compatible` (the default: OpenAI-compatible `/chat/completions`),
   `@ai-sdk/openai` (Responses API), `@ai-sdk/anthropic`, or `@ai-sdk/google`. Sensus owns
   the retry/degradation policy on the seam; no vendor SDKs beyond the AI SDK.
5. **Tabs:** one tab = one PTY shell = one chat session. The shell and its chat live in the
   daemon; the sidebar follows the active tab, and a re-attached tab reconnects to its shell.
6. **Exit / detach:** sensus is a frontend to the local `sensus daemon`. Quitting the TUI
   (or `Ctrl+A d`, or closing any tab with `Ctrl+W`/`×`) **detaches**: the shells and agent
   turns keep running in the daemon and are re-attachable on the next boot. Closing a tab
   never kills its shell; typing `exit` in the pane ends that shell. The daemon is spawned
   on demand, listens only on a local Unix socket plus loopback (never public), and
   grace-exits when it is idle (no client, no work, and no live pane shell) unless run as the
   opt-in persistent service — a live pane shell pins it so the terminal survives a client
   kill/restart. `sensus daemon stop` tears everything down and kills the PTY children.
7. **Approval default:** `confirm` — every tool call gets an inline card (reads included;
   pane typing runs free but every Enter is confirmed; `ask_user` renders its question
   inline) unless you saved an allow rule. `/yolo` flips to `full-auto`.
8. **Custom instructions:** `~/.config/sensus/AGENTS.md`, loaded into the system prompt.
9. **Naming:** binary `sensus`, config dir `~/.config/sensus/`, env prefix `SENSUS_`.

## Evidence on hand

- Source of truth: the code under `src/` and the tests under `tests/`.
- The default adaptive theme and the color behavior are covered by
  `tests/smoke/color-fidelity.test.ts` (boots the real app in an outer tmux driver).
- The shipped binary and the `--version`/package.json invariant are guarded by
  `tests/smoke/ship.test.ts`.
- The marketing site lives in `site/` (https://sensus.sh; [`operations.md`](operations.md)
  §Website). There is still no logo or user research in this repo, so do not invent claims
  about adoption or testimonials.

## Product principles

1. **The terminal is the product.** Sensus is chrome around a real shell; fidelity and
   input latency come before any feature.
2. **Nothing to clean up.** Exiting must never strand processes or a broken alt-screen.
3. **The user is in control.** Approval cards, `ask_user`, and visible-shell typing make
   the agent's actions watchable and interruptible.
4. **Blend in, do not take over.** The adaptive theme paints no backgrounds; the agent
   sidebar stays quiet until it has something to say.
5. **Degrade, never crash.** A PTY/renderable failure, a bad endpoint, a dead MCP server,
   or a corrupt session each surface a message; the terminal part keeps working.

## Related docs

- [`DESIGN.md`](DESIGN.md) — the visual/interaction system these principles become
- [`architecture.md`](architecture.md) — how the pieces fit
- [`../README.md`](../README.md) — user-facing install and usage
- [`../AGENTS.md`](../AGENTS.md) — the same locked decisions as engineering rules
