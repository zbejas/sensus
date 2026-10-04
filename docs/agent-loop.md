# Chat & tool loop

## Overview

`ChatSession` owns one chat per tab and drives the whole turn: it estimates context, appends
the durable terminal block and the user text, streams a completion, executes any requested
tools in order behind the approval gate, and repeats until the model stops. This doc owns the
loop mechanics, the transport-agnostic event stream a non-UI host subscribes to, and the
chat-level UX around a turn. Providers are in [`agent-providers.md`](agent-providers.md);
the tools themselves in [`agent-tools.md`](agent-tools.md); gating in
[`agent-approvals.md`](agent-approvals.md); context in [`agent-context.md`](agent-context.md);
streaming display in [`agent-prompt.md`](agent-prompt.md).

## Key files

| File | Purpose |
|---|---|
| `src/agent/chat/chatSession.ts` | The state machine: `sendMessage`, the generation loop, `gateDecision`, steer/queue holds, abort handling, the event stream |
| `src/agent/chat/chatMessages.ts` | Pure chat data model: message/card types, `ChatEvent`, session deps interfaces, `recordsToMessages` |
| `src/agent/chat/chatHost.ts` | Creates/ends tab chats, wires every dep, memoizes providers, fires auto titles, owns the audit/index bridges |
| `src/agent/chat/toolCardBook.ts` | Tool-card bookkeeping, approval/ask waits, session trust patterns |
| `src/agent/chat/title.ts` | One-shot auto session title |
| `src/agent/slash.ts` + `src/agent/chat/slashDispatch.ts` | Slash parsing + the command switch (the `/edit`, `/retry`, `/find`, `/compact`, … actions) |
| `src/agent/chat/promptComposer.ts` | Input editor, prompt history ring, draft images, slash-autocomplete state |
| `src/agent/chat/compaction.ts` | Preflight estimate/trigger (detail in [`agent-context.md`](agent-context.md)) |
| `src/agent/context.ts` | The per-generation context block (detail in [`agent-context.md`](agent-context.md)) |
| `src/agent/tools/jobs.ts` | The job registry behind background-job visibility |

## How it works

### The generation loop

`ChatSession.sendMessage` runs, in order:

1. **Preflight compaction** near the context limit (order and trigger detail in
   [`agent-context.md`](agent-context.md)).
2. Append this generation's durable terminal context message + the user text to the
   provider history, then build the request: system prompt + session history.
3. Request a stream with tools. On `finish_reason=tool_calls`: execute each call **in
   order** (approval gate first when required), append the assistant + tool-result
   messages, and loop. A provider that emits a mis-cased or partial tool name is repaired
   against the specs actually sent (`resolveToolName`: exact, then case-insensitive, then a
   unique prefix/suffix); an ambiguous or unknown name is left unchanged so the structured
   `unknown tool "<name>"` result still surfaces. The repair happens **before** the
   assistant message is stored, so the call and its tool result always agree.
4. Max **`chat.maxToolTurns`** turns per user message (default **`null`** = no cap;
   a positive number caps the loop); hitting the cap tells the user in chat. The limit is
   read once per generation.
5. Every tool call renders a card (name, key params, status, output). `edit_file` /
   `write_file` cards show the diff rows while pending, so the user reviews before
   approving.
6. **Esc** aborts the loop and any running hidden command through one AbortSignal; pending
   approval / `ask_user` waits resolve as aborted. Every abort names its reason
   (`user`, `rewind`, `plan-cancel`, `shell-exit`, `approval-timeout`,
   `prompt-orphaned`, `shutdown`) on the settled turn's structured `turn completed`
   record and its `turn-complete` event ([`logging.md`](logging.md)).

### Busy sends (steer / queue)

Sending while a reply streams is not blocked. `chat.busySend`
(default `"steer"`) picks the default; Enter applies it and `Alt+Enter` applies the other
mode while streaming ([`keybindings.md`](keybindings.md)), and the sidebar shows a
`⇢ steering N · ⧗ queued N` indicator while entries are held.

- **steer** (default): the message is injected into the RUNNING turn at the next safe
  boundary — `ChatSession.drainSteers()` runs at the top of every tool-loop turn, after the
  previous turn's assistant/tool messages, so the model sees it on the next request without
  stopping. It is appended (display bubble + JSONL `user_message` + provider history) and
  never rewrites sent bytes, so the prompt-cache prefix holds. If the model would otherwise
  finish (a plain `stop`), the loop runs one more turn so the steer is answered; a steer is
  therefore never silently dropped. If the turn instead ends abnormally — an Esc abort, a
  provider error, the loop cap — `flushSteers()` re-dispatches the oldest undrained steer as
  a fresh generation (the rest drain at its first boundary), so the agent still answers
  rather than leaving a dead user bubble. A slash command is never steered — it waits for the
  reply. Steering needs a LIVE turn: while the settled reply's typewriter reveal is still
  draining, `finishStreamingWhenCaught` holds the streaming status after the loop has
  ended, and a message sent in that window is dispatched as a fresh generation instead of
  a steer that no running turn would ever drain.
- **queue**: the message is held and, once the current generation settles NORMALLY, sent as
  a fresh generation (its own AbortController, context block and turn accounting). An Esc
  abort keeps the queue (the user chose to stop); a rewind drops it.
- Both hold a copy of any draft image attachments; the input draft is cleared on accept.
  `/clear` and resume clear the holds.

### Chat UX shortcuts

- `/edit` loads the last user message back into the input for edit-and-resend.
- `↺ revert` on a user message's label row rewinds the chat to just before it (context +
  transcript), reloading the message for editing; see [`agent-context.md`](agent-context.md)
  "Rewind" and [`ui.md`](ui.md) "Rewind".
- `/retry` re-asks the last question (a fresh generation of the same text).
- `/find <text>` searches this chat's messages and prints the matches as a system bubble.
- `Alt+End` (or the palette's "Jump to latest") jumps the message list to the newest
  message. While a generation keeps appending, the sticky scrollbox unpins on a manual
  scroll-up; this is the one-key return to the bottom.

### Session titles

On the **first user prompt** of a session, `ChatHost.generateSessionTitle` fires a
fire-and-forget, no-tools completion (`src/agent/chat/title.ts`) and writes the cleaned result
to the transcript's metadata sidecar ([`sessions.md`](sessions.md) "Auto titles"). It uses
`config.titles.model` when set, else the session's selected model; it is gated by
`config.titles.enabled`, never overwrites an explicit/manual title, aborts with the
generation (Esc), and a failure silently keeps the derived title. The prompt is the user's
text only — no terminal context block, no history.

### No-tools degradation

Sessions against tool-less endpoints still get context injection, plain-markdown answers,
and instructions to print copy-pasteable commands (clicking a command line pastes just that
line into the visible pane — a double click presses Enter to run it; `Alt+S` writes the
whole newest block). The status bar shows a `no-tools` marker; the system prompt switches to
copy-paste guidance. The latch that puts a session in this mode is in
[`agent-providers.md`](agent-providers.md) "No-tools degradation".

### Remote approval & event stream

`ChatSession` exposes a transport-agnostic event stream so a non-UI host (the
`sensus daemon`) can mirror a session without reading Solid signals:

```ts
const unsub = chat.subscribe((event: ChatEvent) => { /* … */ })
```

`ChatEvent` (defined in `src/agent/chat/chatMessages.ts`, exported through
`src/engine/index.ts`) fires on every mutation a renderer would react to:
`message-added`/`message-updated` (whole message, including tool-card
status/output/exitCode and plan), `delta` (streamed content/thinking fragment),
`status`, `plan`, `approval-request`/`approval-resolved`, `sudo-request`/
`sudo-resolved`, `error`, and `reset` (the list was replaced by `/clear`/resume).
A listener that ignores `delta` still converges because the final patch carries
the whole message; a throwing listener is contained (AGENTS.md rule 10). The TUI adds no
listener, so its behavior is byte-identical.

Two seams let a transport answer the engine rather than bypass it:

- **Approvals.** A gated call emits
  `approval-request` and blocks; the answer
  is delivered through the existing `resolveCard(callId, action)` — the daemon's
  `approvals.answer` op does exactly that — so a transport cannot route around the gate
  ([`agent-approvals.md`](agent-approvals.md) "One enforcement point").
- **Sudo.** `ChatSessionDeps.requestSudo` is the prompt seam the TUI's masked
  popup implements. The session wraps it to emit `sudo-request`/`sudo-resolved`
  with an engine-generated `requestId` (also passed to the dep as its optional
  third argument), and resolves the wait as declined if the generation aborts —
  so a prompt nobody can answer can never hang a tool call. A cached session
  password resolves without a prompt and emits no event. The daemon's
  `ChatRegistry.requestSudo` returns a promise answered by `sudo.answer`; the
  password is then used by the normal askpass path (`src/agent/sudoAskpass.ts`)
  exactly as in-process.

The daemon's WS ops and lifecycle live in [`daemon-api.md`](daemon-api.md).

### Background-job visibility

`activeJobs` in `src/agent/tools/jobs.ts` tracks the live jobs: a job started detached outlives the turn, so it
must never go invisible. A status-bar `jobs:N` chip
shows the live count for the active tab while any job runs; the turn that started one
toasts `N background jobs still running — see the jobs chip` (only on a new high-water
mark, so a long-lived job does not toast every turn); and each generation's context
block carries an `[agent] background jobs: N running (ids …)` line, which is the agent's
cheap "are any of my jobs still running?" answer — it can poll (`job: <id>`) or kill
(`job: <id>, kill: true`) instead of leaving an orphan. `/clear` kills the tab's jobs
and drops the count.

### Doom-loop guard

`DOOM_LOOP_THRESHOLD = 3` in `src/agent/chat/chatSession.ts` (always on): three CONSECUTIVE tool calls
with the same name and identical JSON arguments within one generation are allowed; the
fourth is blocked — an error card + a warn toast, and the model gets "Repeated identical
tool call detected … Stop repeating it; change approach or ask the user." The per-generation
run counter resets on the next user message.

### Desktop notifications

The App watches the active chat's state and, on a meaningful transition, writes a terminal
notification sequence ([`config.md`](config.md) "notifications"): a reply that finished while the
user was elsewhere (`onFinish`), or a tool approval card that newly appeared (`onApproval`,
skipped while an overlay is already open). `mode: "bell"` emits a plain BEL; `"osc777"`
emits `ESC ] 777 ; notify ; … BEL` for terminals that surface it as an OS notification. The
decision logic is pure and unit-tested (`src/ui/lib/notify.ts`); emission is guarded so a
notification can never break the render.

## Gotchas & invariants

- **Tool execution is sequential**, never parallel — cards and approvals depend on order.
- **Esc is one `AbortSignal`** for the fetch, the hidden command's process group, and
  pending card waits. A partial answer is kept and marked aborted. The abort reason is
  threaded from the caller (Esc/`chat.abort` = `user`, rewind, plan cancel, shell exit,
  approval timeout, shutdown) and lands on the turn's structured record + seam event; the
  frozen v1 event schema still drops it.
- **The doom-loop guard blocks the 4th consecutive identical call** (same name, identical
  JSON args), not the 3rd; the counter resets on the next user message.
- **A background job is surfaced, not hidden**: the status chip + the context line + the
  high-water toast are the visibility contract; the job's abort semantics are in
  [`agent-tools.md`](agent-tools.md).
- **A steer is never silently dropped**: a normally finishing turn runs one more pass; an
  abnormal end re-dispatches it as a fresh generation.
- **A throwing event listener is contained**; the final whole-message patch means a
  listener may ignore `delta` and still converge.

## Related docs

- [`agent.md`](agent.md) — the harness hub
- [`agent-providers.md`](agent-providers.md) — streaming, retries, the no-tools latch
- [`agent-tools.md`](agent-tools.md) — tool execution, jobs, sudo
- [`agent-approvals.md`](agent-approvals.md) — the gate, the plan card, trust
- [`agent-context.md`](agent-context.md) — preflight compaction, rewind
- [`agent-prompt.md`](agent-prompt.md) — streaming display
- [`daemon-api.md`](daemon-api.md) — the daemon's chat WS ops
- [`config.md`](config.md) — `chat.busySend`, `chat.maxToolTurns`, `titles`
- [`sessions.md`](sessions.md) — transcripts, auto titles, resume
