# Tools & execution

User guide: https://sensus.sh/docs/tools/

## Overview

The tool layer is what the model can actually do: the core tool set, the hidden-shell runner
and its background jobs, the visible-pane driver, file tools, sudo, images, session search,
and the audit log. Every call is capped once at the tool boundary, spilled to disk when
oversized, and executed sequentially behind the approval gate
([`agent-approvals.md`](agent-approvals.md)). The loop that dispatches calls is in
[`agent-loop.md`](agent-loop.md); the MCP client is in [`mcp.md`](mcp.md); memory stores in
[`memory.md`](memory.md); skills in [`skills.md`](skills.md).

## Key files

| File | Purpose |
|---|---|
| `src/agent/tools.ts` | Public barrel over `src/agent/tools/` (import this, not the internals) |
| `src/agent/tools/index.ts` | Explicit re-exports; the module map |
| `src/agent/tools/specs.ts` | The OpenAI function specs — the tool set's source of truth |
| `src/agent/tools/execute.ts` | `executeTool` dispatcher: shell executors, memory, host scan, image passthrough, previews |
| `src/agent/tools/jobs.ts` | Hidden-command runner + the background-job registry (`activeJobs`) |
| `src/agent/tools/approval.ts` | Destructive classification, trust patterns, permission rules, the read-only guard |
| `src/agent/tools/summary.ts` | Arity-aware command prefixes, card param summaries, approval detail |
| `src/agent/tools/parse.ts` | Tool-arg parsing, `resolveToolName` repair, path resolution |
| `src/agent/tools/filePlan.ts` | `edit_file`/`write_file` plans + apply |
| `src/agent/tools/diff.ts` | Diff-row computation for cards |
| `src/agent/tools/readFile.ts` | Bounded streamed regular-file reader |
| `src/agent/tools/sudo.ts` | Sudo detection/rewrite helpers |
| `src/agent/tools/text.ts` | Head/tail clipping helpers |
| `src/agent/tools/types.ts` | `ToolSpec`, `ToolContext`, `AgentPane`, `ApprovalDecision`, … |
| `src/agent/truncate.ts` | Boundary cap + full-text spill under `<state-dir>/tool-output/` |
| `src/agent/sudoAskpass.ts` | Askpass helper/broker (hidden shell + pane) |
| `src/agent/audit.ts` | Append-only audit log + `lastUndoable`/`markUndone` |
| `src/agent/processUtil.ts` | `haveSetsid`, `killProcessTree` (job trees) |
| `src/agent/memory/hostScan.ts` | The `host_scan` probe whitelist |
| `src/terminal/keys.ts` | PTY key encoder used by `shell_session` |
| `src/terminal/paneState.ts` | Structured pane-state read + refusal reasons |
| `src/terminal/delivery.ts` | Echo/prompt-anchored delivery verdict |
| `src/core/image.ts` | Image sniffing/dimensions, asset store, token estimation |
| `src/session/indexDb.ts` | FTS5 index behind `session_search`/`session_list`/`session_view` |
| `src/agent/mcp/registry.ts` | MCP `tools/call` dispatch ([`mcp.md`](mcp.md)) |

## How it works

### The core tool set

| Tool | Params | Behavior |
|---|---|---|
| `shell_background` | `command, timeout_s?=120, cwd?, background?=false, job?, wait?, kill?` | A HIDDEN background shell (the user sees nothing): a per-call `bash -lc` in its own session (via `setsid` when available) so a kill takes the whole tree. Captures stdout+stderr (merged) and returns the exit code; the model-facing result is capped at the `tool_output` policy (default 2000 lines / 51200 bytes, TAIL kept) with the full text spilled to disk. A foreground call is killed on timeout and on Esc. `background: true` starts it detached and returns a job id; poll with `job: <id>` (status + new output since the last poll; output streams live into a capped per-job buffer, so a poll sees new output before exit) and stop with `job: <id>, kill: true`. `wait: true` waits at most the job's own 1800s cap and aborts with Esc — only the WAIT is Esc-abortable; the job itself outlives the turn until killed or reaped. |
| `shell_session` | `text?, keys?, enter?=false` | Types into the ACTIVE visible pane via the PTY key encoder (`src/terminal/keys.ts`) — the user watches every keystroke. `keys` presses named keys in order; `enter=true` appends Enter. Returns `delivered` / `unverified` / `refused` and never claims execution: it PRE-FLIGHTS the pane state and refuses to type when the pane is not at a prompt (a `dquote>`/`quote>`/`heredoc>` continuation, a running foreground command, a sudo/SSH password prompt, a full-screen app), then acknowledges the write with a bounded echo check (`unverified` when no echo appears). In `confirm` mode pure typing and non-submit keys auto-run (the user watches every keystroke), but any SUBMISSION — a call that presses Enter, so the line actually RUNS — gets an inline card, and a catastrophic typed command hits the destructive floor in either mode ([`agent-approvals.md`](agent-approvals.md)). The typed `text` is matchable by a `permission` rule's `pattern`. |
| `read_file` | `path, offset?, limit?` | Read a REGULAR file — refuses a directory/device/FIFO/socket without opening it. offset/limit page by lines; a large file is read as a bounded streamed line window (8 MB whole-file cap, 64 MB scan cap), never loaded whole (`src/agent/tools/readFile.ts`). The model-facing output is capped at the `tool_output` policy (HEAD) with the full text spilled; the trailing hint suggests raising limit or offset. The preferred way to view a file — never shell out to `sed`/`awk`/`head`/`tail` for it. |
| `edit_file` | `path, old_string, new_string` | Search/replace; errors if not found or not unique. Refuses a file larger than the 8 MB read cap. Diff card while pending; applies on approval. |
| `write_file` | `path, content` | Overwrite/create; diff card when the file exists (also while pending). The diff's old-text read is bounded to the 8 MB prefix, so a huge existing file is never loaded whole. Applies on approval. |
| `get_scrollback` | `lines?=500` | Deep capture of the terminal's bounded plain-text ring (the native VT scrollback has no read API); clamped to 5000 lines; the model-facing output is capped at the `tool_output` policy (TAIL). |
| `view_image` | `path` | Read a local image file (png/jpeg/webp/gif, ≤12 MB) and add the pixels to the model's context. Read-only; gated like every tool in `confirm` mode. Offered only when the selected model advertises image input (models.dev `modalities.input` / `attachment`, overridable per model — [`config.md`](config.md)). See "Images". |
| `ask_user` | `question, options?` | Puts a question to the user and blocks until they answer (typed + Enter, digits 1–9 while the draft is empty, or a click). The question renders in full — wrapped, never truncated, with markdown and bare URLs as clickable links — and up to 8 options render as numbered clickable buttons. A final "type your custom answer in the chat" entry is always appended; it focuses the input rather than answering (its index is one past the option list, so its label is never sent). For genuine forks only — a decision that is the user's to make — not a per-step sign-off. |
| `memory` | `action, target, content?, old_text?` | Maintain MEMORY.md / HOST.md / JOURNAL.md ([`memory.md`](memory.md)). Gated like every tool in `confirm` mode; in full-auto reads auto-run and writes (incl. `rewrite`, memory/host only) auto-run unless `memory.writeApproval`. Dropped from the request when `memory.enabled:false`. |
| `host_scan` | — | Read-only machine discovery (whitelist of OS/disk/ports/services/containers/network/git probes) that returns a redacted draft for HOST.md. Invoked by `/map`. Gated like every tool in `confirm` mode; auto-runs only in `full-auto`. |
| `session_search` | `query, session?, limit?, offset?` | Search PAST chat sessions (every earlier transcript) by content via the FTS5 index (`src/session/indexDb.ts`). Parameterized MATCH over indexed user/assistant messages; returns newest-first hits with role, short session id and a snippet. `session` narrows to a session-id/path substring, `limit` caps (default 20, max 100), `offset` pages. Read-only; gated like every tool in `confirm` mode. |
| `session_list` | `limit?, offset?` | List PAST chat sessions newest-first (time, short session id, title, message count, tags), paged by `limit` (default 20, max 100) / `offset`. The entry point for browsing history before opening one with `session_view`. Read-only; gated like every tool in `confirm` mode. |
| `session_view` | `session, offset?, limit?` | Read ONE past transcript's messages in order (oldest first), resolved from the `sessions` table by `session` — an EXACT id/path wins, else the newest id/path-substring match. Paged by `offset` (0-based message index) / `limit` (default 20, max 50) so a huge transcript is sliced from SQLite, never loaded whole; each message body is clipped (~2k chars) and the header reports `total` so the model can page (the echoed `sessionId` resolves back to the same transcript). Read-only; gated like every tool in `confirm` mode. |
| `skills_list` / `skill_view` | — / `name` | Progressive-disclosure skills: the name+description index, then one full body ([`skills.md`](skills.md)). Read-only. |
| `reload` | — | Re-read config.json (endpoints, model, approval/permission rules, MCP servers), AGENTS.md + config `instructions`, agent definitions, and skills — the `/reload` action, so the model applies config edits itself instead of typing `/reload` into the user's terminal. Read-only (never writes; changed MCP servers restart in the background). Gated like every tool in `confirm` mode; auto-runs only in `full-auto`. |
| `mcp__<server>__<tool>` | server-defined (JSON) | MCP tools merged from configured servers via the registry. Gated like `shell_background` in confirm mode. See [`mcp.md`](mcp.md). |

The tool specs themselves are `TOOL_SPECS` in `src/agent/tools/specs.ts`; an agent's declared
`tools` list filters the core set, and an MCP tool's spec is deduped against the core specs
([`mcp.md`](mcp.md) "Tool exposure").

### The two shell tools

The two shell tools are deliberately named to steer the model: `shell_session` IS the
user's session; `shell_background` is a hidden scratch space. The system prompt states the
rule and each agent body reinforces it.

- `shell_background` is the hidden shell: a per-call `bash -lc` in its own process group
  (`setsid` when available), stdout+stderr merged, killed on timeout and on Esc (a
  foreground call). `background: true` detaches it as a job; `job: <id>` polls status plus
  output since the last poll; `job: <id>, kill: true` kills the tree; `wait: true` waits up
  to the job's own 1800s cap.
- `shell_background` cwd defaults to the active pane's cwd (OSC 7), not the agent shell's
  cwd — "agent works where you are".
- Background jobs are process-global but tagged with their owning session; `/clear` kills
  only that tab's jobs (other tabs are untouched). Past 32 live jobs the oldest is reaped,
  killing its process tree.
- File tools resolve relative paths against the pane's cwd at call time (`~` → `$HOME`).
- An agent's declared `tools` list filters the core set and MCP tools alike.
- Every result is capped ONCE at the tool boundary by the `tool_output` policy
  ([`config.md`](config.md) "tool_output"): oversized output spills its full text to
  `<state-dir>/tool-output/` and the model gets a preview plus a `read_file` /
  `shell_background` pointer. `view_image` is exempt (it carries pixels, not text).

#### `shell_session` is verified, not fire-and-forget

It used to return `ok:true` when bytes were *written* to the pane — not when the command
ran — so a write into a pane that had just redrawn or sat in a shell continuation could
silently no-op (the two #19 incidents: a 30s countdown reported as "aborted before any
output"; three typed commands swallowed as continuation text by a `dquote>`). Now
([`terminal-layer.md`](terminal-layer.md) "Pane state"):

- **Pre-flight.** Before typing, the executor probes the pane via
  `PtySession.paneState()` (a structured read of the live screen grid, not
  scrollback). If the pane is in a continuation (`dquote>`/`quote>`/`heredoc>`/…), has a
  running foreground command, is waiting on a sudo/SSH password prompt, or is owned by a
  full-screen app, it refuses: nothing is typed and the result is
  `refused: the pane is in a dquote continuation …` plus the offending pane lines and the
  keys to clear it. `unknown` never refuses (no guessing). The same applies to a
  keys-only call (a bare `enter` into a continuation is the same bug).
- **Acknowledgement.** After typing, a bounded (~400ms, no new blocking wait)
  echo/prompt-anchored check (`src/terminal/delivery.ts`) confirms the line landed on the
  shell's input line. Missing evidence is `unverified`, said explicitly, so the agent must
  not narrate success; a small pane tail is included. A pane without the probe (a stub)
  reports `unverified`, never a crash.
- **Recovery.** A refusal or an `unverified` result carries the pane context the agent
  needs (the bottom lines), so it is never blind.
- The result also echoes `pane state before typing: prompt (confidence 0.80)` so the agent
  can plan.

### Images

Images are files on disk, referenced by a small metadata record — never base64 in the
transcript. `src/core/image.ts` owns sniffing (magic bytes), dimensions
(png/gif/webp/jpeg) and the content-addressed asset store.

- **Attach.** `Ctrl+Shift+V` / `Alt+V` paste the system clipboard (the `paste-image`
  action; terminal bracketed paste carries only text, so this goes through opentui's native host
  clipboard service, `ui/lib/clipboard.ts`). The paste adapts to what the clipboard holds: image
  bytes attach to the draft, a copied file list attaches its image files and pastes the other
  paths as text (the agent can `read_file` them), and plain text goes to the chat draft — or, with
  the pane focused, to the shell as a bracketed paste. `/image <path>` attaches a file, and
  `/image clear` drops the pending ones. Attachments become chips above the input; a `×`
  click removes one. Limits: 4 formats, 12 MB each, 5 per message.
- **Store.** Clipboard bytes are written to `<session-dir>/assets/<sha1>.<ext>`; path
  attachments reference the original file. The record (`id`, `name`, `mediaType`, `bytes`,
  `path`, optional `width`/`height`) rides `user_message` events in the JSONL, so resume
  rebuilds the chips and the provider history.
- **Send.** `sendMessage(text, images)` puts the attachments on the display bubble, the
  JSONL record and the `ProviderMessage`. On the wire (`aiSdkProvider.toModelMessages`) a
  user message's images become AI SDK `FilePart`s, which the OpenAI-compatible provider
  turns into `image_url` data URLs. `Alt+Enter`-style empty text is allowed when an image
  is attached.
- **Vision tool.** `view_image(path)` reads, validates and returns an `ImageAttachment`.
  Because OpenAI-compatible tool roles are text-only, the session appends the pixels as a
  separate user message AFTER the tool results (all results stay contiguous, as the wire
  requires); the seam maps that user message to file parts. Deterministic per request, so
  the prompt-cache prefix holds. The tool spec is only offered when
  `modelMeta().vision === true`.
- **Gating.** Sending with an attachment is refused (toast, draft kept) when the selected
  model is explicitly `vision: false`; unknown models (`null`) are allowed through. `vision`
  resolves from models.dev `modalities.input` (fallback: `attachment`) and can be overridden
  per model in config.
- **Estimation.** Compaction counts each image at ~1 token / 750 px (clamped 256–4000),
  never the file's byte length; a missing asset degrades to a text note in the request.
- **Display.** Chips only (`▣ name · WxH · size`) — no inline image rendering. The chat
  message list and the draft row are the two surfaces; the bubble chips are plain rows
  ([`ui.md`](ui.md)).

### Session search

`session_search` (and the `/sessions` overlay, [`ui.md`](ui.md)) searches every past chat
transcript. The read-only session trio shares the index: `session_search` finds content,
`session_list` browses transcripts newest-first, and `session_view` reads one transcript a
window at a time (`offset`/`limit`, resolved by an exact id/path or else the newest
substring match) — every call is paged, so a large history is never loaded whole.
`src/session/indexDb.ts` maintains a SQLite FTS5 index at
`<state-dir>/sessions-index.sqlite` (`sensusStateDir()`): `sessions` holds one row per JSONL
file, `messages` one row per user/assistant record (ingested through the shared
`loadSessionFile`, so unknown events and corrupt lines are skipped exactly like `--resume`),
and the standalone `messages_fts` index covers message content. `ChatHost` owns the index,
ensures the DB at construction (the first ingest pass is deferred off boot) and re-ingests
files whose mtime changed, lazily/throttled before each search/list, through a refreshing
bridge shared by the tool and the overlay (the overlay's empty-filter recents come from
`list`). The listing walk (`listSessionFiles`) is stat-only (readdir + stat, newest-first by
mtime), so a throttled search/list never reads and parses every transcript; `refresh`
re-ingests by file mtime (sidecar mtime included), and the walk carries zero-message files
that the query layer hides (`sessions.messages > 0`). Each indexed message keeps its own
event `ts`, so `session_view`/search report when a message happened rather than the
session's last activity. User input is tokenized into quoted FTS prefix terms
(`"term"*`), so FTS operators can never raise a syntax error; when MATCH finds nothing a
parameterized LIKE substring fallback runs. Any DB/FTS failure degrades to `[]` (the tool
reports it as an error string) — the index never throws. Read-only; gated like every tool in
`confirm` mode.

### Sudo

`shell_background` runs without a tty, so password prompts always fail. When a command
invokes sudo:

- **Position-independent detection.** `sudo` is recognized as an actual invocation at ANY
  command boundary: `ls …; sudo …`, `sudo a | sudo b`, `x && sudo y`, `$( sudo z )`,
  `{ sudo x; }`, and `if …; then sudo z; fi` all count — not only a line that STARTS with
  sudo. Leading `VAR=x` assignments and the common wrappers (`env`/`command`/`nohup`/
  `setsid`/`nice`/`ionice`/`timeout <dur>`/`stdbuf <flags>`) stay recognized; `echo sudo`
  and `grep sudo` stay false (an argument is not an invocation). The old "sudo must be the
  first word" rule is gone: a shell-operator prefix (`ls …; sudo pct exec 500 -- docker cp …`)
  used to silently defeat the broker and fail with `sudo: a terminal is required to read the
  password` even with a cached password.
- **Prove the broker before running.** When a command invokes sudo anywhere and a
  popup/cache seam exists, the password is resolved UP FRONT (cache → no popup; else the
  masked popup). A decline fails fast with a clear message — `the sudo prompt was
  declined/cancelled … the command was NOT run` — so nothing is run bare first. If no seam
  exists at all, the command runs and a password failure in the *output* returns the
  hand-it-to-the-user guidance (as before).
- **Askpass arms the whole call.** The child gets `SUDO_ASKPASS` pointing at a throwaway
  helper (`src/agent/sudoAskpass.ts`) and every detected sudo is rewritten to `sudo -A`.
  Because the env is armed for the whole process tree, a sudo position the rewrite misses
  still authenticates (no tty ⇒ sudo falls back to the askpass program). The command's own
  stdin is untouched: piped commands (`echo x | sudo tee f`) keep working and no leftover
  password line can be read by a later command. The helper reads a `0600` secret under
  `$XDG_RUNTIME_DIR`/`/dev/shm` (RAM-backed when available), overwritten and removed when
  the submission returns; only if the helper cannot be created does it fall back to
  `sudo -S -p ''` with one stdin line per invocation. Because the password is applied to the
  WHOLE run, a compound ending in `echo`/`|| true` (exit 0) cannot mask a sudo step that
  would have failed.
- **Ticket note.** A successful privileged call appends a one-line note (~15 min, sudo's
  default `timestamp_timeout`) so the agent can order its commands and stop re-prompting.
  The session vault still reuses the password with no popup regardless.
- **`sudoPrompt: popup`**: sensus shows the masked password popup (type,
  Enter submits, Esc declines, Tab selects **cache for this session** — OFF by default,
  the user must opt in). The popup is a narrow centered modal card over the transparent
  backdrop, rendered above any open overlay (or with none), and, while pending, owns the keyboard:
  App blurs the pane/chat and routes keys/paste to it
  (`store.inputCaptured()`), so typing can never leak into the visible shell. On submit,
  the executor **deterministically** runs the same command via the askpass helper
  (`sudo -A`) — no extra LLM turn.
- **Session vault (opt-in, program-level).** When the user SELECTS caching, the password is
  held in RAM for the whole session — AES-256-GCM encrypted (`src/core/sudoVault.ts`),
  zeroed on clear, never on disk, never in the transcript, never model-facing — and the
  agent's hidden/background shell reuses it for every later sudo command, in ANY posture
  (the popup seam resolves straight from the vault with no UI). When the user does NOT
  select caching, nothing is stored and each sudo use re-prompts. Hashing is impossible:
  `sudo` needs the original back, so the vault is reversible-by-design, encrypted at rest.
  `/sudo` reports whether one is held; `/sudo forget` clears it. A wrong password is
  detected only when sudo actually TRIED it (`incorrect password attempt` / `Sorry, try
  again.`): that clears the vault, and `shell_background` then **re-prompts** with a
  "wrong password — try again" hint and retries the rewritten command — bounded to three
  password submissions in one call, so a typo is recoverable. Only after that bound (or if
  the retry is declined/aborted) does the tool return, and its message says the entered
  password was **incorrect** — never that the user cancelled or declined. A mere
  "a password is required" (a nested/unrewritten sudo, a missing askpass) does **not** clear
  it and does not re-prompt, so a good cached password is never wiped by an unrelated failure.
  Only a line whose **every** `sudo` is `-n`/`--non-interactive` is skipped (nothing can be
  rescued); a MIXED line (a `-n` probe beside a plain `sudo`) is still retried, so the plain
  calls authenticate while the `-n` ones fail by design — the trap where any `-n` disabled
  the rescue for the whole line is gone. The guidance is attached even when the `-n` failure
  sits inside an otherwise-successful chain (`sudo -n a; echo ok` → exit 0). The system
  prompt and copilot body state the rule: run plain `sudo <cmd>`, never `sudo -n` as a probe
  — the hidden shell has no ticket, so `-n` can never authenticate. Because a tty-less hidden shell has no shared sudo timestamp, the
  rewrite covers **every** `sudo` in the command, so `sudo -k true && sudo whoami`
  authenticates both.
- **`sudoPrompt: ask` (default)**: no popup for `shell_background` — the tool result tells the
  model to hand the command to the user to run in their terminal. (A password the user already
  selected to cache is still reused silently.) For `shell_session` an `ask` agent likewise gets
  guidance instead of the popup.
- **`sudoPrompt: auto`** (the built-in copilot): for `shell_background` it resolves per request
  against the approval mode — `popup` in full-auto, `ask` in confirm (`resolveSudoPrompt` is the
  pure helper). For `shell_session` any non-`ask` agent gets the popup in EITHER posture,
  because the visible pane cannot be left to a bare prompt (see below).

**Sudo in the visible pane (`shell_session`)** is a different path. The agent must never type a
bare `sudo <cmd>` into the pane, leave the prompt waiting, and then retry around it — a weak
model does exactly that, re-sending the command into the password prompt and corrupting the
line. Instead, when the typed text invokes sudo and the agent is not `ask` (the copilot is
`auto`), the executor resolves the password through the SAME seam — session cache first, else
the masked popup — and types the command rewritten to `sudo -A`. The pane env carries a
session-lived `SUDO_ASKPASS` helper (`sudoAskpassBroker` in `src/agent/sudoAskpass.ts`);
`arm(password)` writes the `0600` tmpfs secret just before the command is typed and zeroes +
removes it shortly after (and on `/sudo forget` or a detected rejection), so no plaintext
outlives the auth window and nothing reaches the pane's scrollback, shell history, or the
model.

The executor no longer claims success blindly. It first pre-flights the pane state (a
`dquote>`/`quote>`/`heredoc>` continuation, a running command, a password prompt or a
full-screen app is refused before any bytes) and snapshots the pane's scrollback BEFORE
typing so an older `Sorry, try again.` cannot be read as this command's failure (a
before-snapshot that already contains one yields an "unknown" verdict, never a false
rejection). After typing it polls the pane for up to ~1.6s: a NEW rejection means the
password was wrong — the vault is cleared and the tool returns `ok:false` saying the entered
password was **incorrect** and that this is **not** a cancellation (the same three-way split
as `shell_background`: valid / declined / wrong). Otherwise the note says the session password
was used via askpass. The wait is a bounded heuristic (a rejection that scrolls off the
bounded ring or arrives later reads as "unknown"/"clear"), not a guarantee.

If the user declines the popup, nothing is typed and the model is told — unambiguously — that
the user declined (distinct from a wrong password). An `ask` agent gets guidance to hand the
command to the user instead. The pane stays a real
interactive tty for whatever sudo runs (`pct enter`, editors, …) — see
[`terminal-layer.md`](terminal-layer.md) for the controlling-terminal requirement (zsh panes
had no `/dev/tty` at all until non-bash shells were launched through bash).

Esc during the popup resolves as declined and the generation aborts normally.

### Undo & audit

Every state-changing action is appended to an append-only audit log
(`src/agent/audit.ts`, `<state-dir>/audit.jsonl`): file writes (with the prior
content for undo), memory writes, and gated shell commands. `ChatHost` owns the log and
binds it per session; `ChatSession` records entries in the tool loop. The log is bounded
(newest 2000 kept) and best-effort — a failing disk never breaks the action.

- `/undo` restores the most recent recorded file write (recreates the file, or deletes it
  when it did not exist before) and tombstones that entry so the next `/undo` moves further
  back.
- `/audit [n]` prints the most recent `n` (default 20) entries as a chat system bubble.

The pure store + `lastUndoable`/`markUndone` semantics are unit-tested in
`tests/unit/agent/audit.test.ts`; the `/undo` + `/audit` wiring is tested through
`ChatSession` with a stub bridge.

## Gotchas & invariants

- **`shell_background` cwd is the pane's**, not the agent shell's — "agent works where you
  are". File tools resolve relative paths against the same cwd at call time.
- **A background job survives Esc on purpose** — only a `wait: true` poll is Esc-abortable;
  `job: <id>, kill: true` is the job's off switch. Jobs are process-global, tagged with
  their owning session, and the oldest is reaped past 32 live jobs.
- **`shell_session` preflights pane state, never claims execution, and gates every
  submission.** Typing auto-runs in `confirm` (the user watches); any call that presses
  Enter gates. A refusal or `unverified` always carries pane context.
- **The boundary cap happens here, once**: `src/agent/truncate.ts` caps every result to the
  `tool_output` policy and spills the full text to disk. What history does with those bytes
  (and the only other clip) is [`agent-context.md`](agent-context.md).
- **MCP tools connect lazily, isolate failures, and are never allow-prefixable** — prefixes
  are shell commands. A colliding MCP spec is deduped, not resolved
  ([`mcp.md`](mcp.md)).
- **The read-only guard refuses `edit_file`/`write_file`/`memory`/`shell_session`/MCP and
  mutating shell commands** ([`agent-approvals.md`](agent-approvals.md)).

## Related docs

- [`agent.md`](agent.md) — the harness hub
- [`agent-approvals.md`](agent-approvals.md) — gating, destructive floor, read-only guard
- [`agent-context.md`](agent-context.md) — boundary-cap/cache invariant, spill consumers
- [`agent-loop.md`](agent-loop.md) — the loop that executes these calls, job visibility
- [`mcp.md`](mcp.md) — MCP config, transports, lifecycle, naming
- [`memory.md`](memory.md) — the memory stores and `host_scan`
- [`skills.md`](skills.md) — progressive disclosure
- [`config.md`](config.md) — `tool_output`, `permission`, `allowPrefixes`, `memory`
- [`terminal-layer.md`](terminal-layer.md) — pane state, key encoding, delivery probes
- [`ui.md`](ui.md) — tool cards, diffs, image chips
