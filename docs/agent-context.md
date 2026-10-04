# Context, compaction & caching

## Overview

The harness keeps the provider history append-only and byte-stable so the endpoint's prefix
cache keeps working, and folds older history into a structured checkpoint when the window
fills. This doc owns the per-generation terminal context block, the estimate/trigger math,
checkpoint compaction, pinned facts, the optional prune pass, rewind, and the context/usage
observability surfaces. The system prompt's stability rule is in
[`agent-prompt.md`](agent-prompt.md); the tool-boundary cap that feeds history is in
[`agent-tools.md`](agent-tools.md); config keys are in [`config.md`](config.md) (`context`,
`compaction`).

## Key files

| File | Purpose |
|---|---|
| `src/agent/chat/compaction.ts` | Pure estimators (`TOOL_SPEC_TOKENS`, `estimateRequestTokens`, `resolveContextLimit`, `compactionReserve`, `shouldCompact`), checkpoint assembly, tail selection, prune, overflow match |
| `src/agent/chat/contextAccounting.ts` | `ContextAccounting`: limit/estimates/breakdown + the system-prompt token memo |
| `src/agent/chat/contextHistory.ts` | Resumed-transcript durable-history reconstruction for the inspector |
| `src/agent/chat/chatSession.ts` | Preflight compaction, checkpoint requests, usage anchor, rewind, the live signals the inspector reads |
| `src/agent/context.ts` | Terminal context block builder + git collection/fingerprint |
| `src/agent/truncate.ts` | Tool-boundary cap + spill (the bytes history keeps) |
| `src/engine/chat/contextInspector.ts` | Pure `ContextBreakdown`/`ContextHistoryEntry` + `messagePreview` |
| `src/engine/chat/usage.ts` | `/usage` roll-ups (`buildUsageChart`, day/session lists) |
| `src/core/image.ts` | `estimateImageTokens` (compaction counts pixels, not bytes) |
| `src/agent/chat/chatHost.ts` | `sessionContextBreakdown` for saved sessions; usage seeding on resume |

## How it works

### Context injection

Once per generation, a compact terminal context block is emitted as its OWN
provider-history message, right before the user's text (the display transcript and JSONL
keep only the user's text):

```
[terminal] cwd: ~/server · shell: zsh · cmd: shell
[terminal] last output:
<tail N=100 lines of terminal output, trimmed of blank spam>
[git] branch main, 2 changed files   (only when a repo is detected)
[agent] approval: confirm
```

A native PTY has no foreground-command source, so `cmd:` is always `shell` (the scanner
exposes only cwd, title, and alt-screen). The tail comes from the bounded plain-text ring
fed by the byte scanner. In the daemon, a chat opened with a `shellId` wires
`ChatSession.attachTerminal` to that shell: the tail is the last client `terminal.facts`
grid while a client is attached (D2 — the VT is client-owned), else the scanner ring, and
cwd/alt-screen come from the streamed `TerminalStatus` ([`daemon-api.md`](daemon-api.md)
"Terminal status"). Without that wiring a daemon chat's context block would be dropped.

The message is **durable**: it is never re-derived, moved, or rewritten on later requests;
later generations append NEW context messages. Volatility therefore lands at the request
tail, where it cannot invalidate the provider's prefix cache (see "Prompt caching"). When
the trimmed tail is unchanged since the block the model last saw (fingerprint compare), the
new block collapses the tail to `[terminal] last output: unchanged (N lines …)` — one line
per quiet turn.

Toggle: `/context on|off` per session. Never emit the tail while a full-screen app (alt
screen) is active — instead note "user is in alt-screen app (shell)". Git status comes from
one hidden `git ...` composite call in the pane cwd (5s timeout; null when not a repo).

### Context management & compaction

Context management keeps the provider history to the real conversation and caps, spills, or
checkpoints bulk output (`src/agent/chat/compaction.ts`):

- **Boundary truncation + spill**: every tool result is capped ONCE at the tool boundary
  (`src/agent/truncate.ts`) to `tool_output` (default 2000 lines / 51200 bytes; HEAD, or TAIL
  for shell-like output), and the FULL text is spilled to `<state-dir>/tool-output/` with a
  `read_file`/`shell_background` pointer. History stores that capped result verbatim — the
  first bytes sent are the bytes kept forever (the prompt-cache invariant). The old ~2k
  write-time clip is gone.
- **Estimates**: the next request is estimated from the last response's `usage.prompt_tokens`
  (anchor = the history length it covered) plus a chars/4 estimate of newer content;
  without usage, everything is estimated locally. Tool-spec overhead is computed at module
  load from the real `TOOL_SPECS` (`TOOL_SPEC_TOKENS` in `src/agent/chat/compaction.ts`,
  memoized serialization) rather than a
  flat constant, so growing the tool set cannot silently undercount and delay compaction.
  The anchor is used only while the request SHAPE it covered still matches — system-prompt
  tokens, `noTools`, MCP spec tokens; a no-tools flip, MCP server connect, or agent/model
  switch invalidates it, so the next estimate is recomputed locally.
- **Trigger**: at generation start (before the context message is appended) and before
  later tool turns, when `estimate >= effectiveLimit - reserve` with
  `reserve = max(min(resolved maxTokens, 32k), context.bufferTokens)`. `resolved maxTokens`
  is the endpoint's explicit `maxTokens` → the model's advertised output limit
  (`models.dev limit.output`) → unknown (0: only the buffer reserves).
  `effectiveLimit` is the resolved context ceiling — a positive `context.contextLimit`
  override → endpoint `models.<id>.contextLimit` → models.dev `limit.context` → 128k
  fallback — capped by the model's input-token ceiling (the endpoint
  `models.<id>.inputLimit` override → models.dev `limit.input`, e.g. gpt-5's 272k beside a
  400k window) when one is known: the API rejects a longer prompt, so the trigger fires at
  `min(context window, input cap)`. The reserve stays on top because the compaction summary
  request itself must fit under that input cap. `context.contextLimit: 0`, the default,
  means "unlimited/auto": use the fetched metadata. The models.dev index is
  warmed in the background at boot so a fresh install resolves the real window.
- **Checkpoint**: one extra no-tools request summarizes the history into a structured
  summary (`## Objective / Requirements / Completed / Active right now / Blockers / Next
  steps` — validated, one template-repair retry). The request sizes its output budget with
  `oneShotMaxTokens`: the endpoint max (clamped to **8,192**; an auto/unset endpoint max
  uses the clamp) raised toward the model's advertised output limit, up to **32,768**
  (`ONE_SHOT_MAX_TOKENS`), and pins the model's
  **lowest advertised reasoning effort** (`oneShotThinkingKnob`, omitted when the model
  advertises none) so hidden thinking cannot consume the budget (the old 4,096 cap could be
  consumed entirely by reasoning, yielding `finish_reason: length` with no summary). A
  **truncated** summary (`finish:"length"`) that still validates is accepted — `isValidSummary`
  is the authority, only abort/error is fatal — and a truncated reply that did NOT validate is
  reported as reasoning starvation ("the model ran out of output budget before returning a usable
  summary (hidden reasoning can consume it)"), while a failure names the finish reason
  (`compaction failed: … (finish=length)`) so a cap problem is diagnosable. While building that request the
  serializer clips each tool result to ~2k chars (`SERIALIZE_TOOL_CHARS`) — the ONLY place
  the 2k clip remains. The history becomes a `<conversation-checkpoint>` user message
  (historical context, explicitly NOT new instructions) + the recent tail within
  `context.keepTokens` (default 15k), kept verbatim (a retained tool result counts at its
  actual size, so the tail reflects what is really kept); `compaction.tail_turns` (default
  0 = off) additionally guarantees at least that many recent user turns stay in the tail
  even when the token budget would cut them (a "turn" = a user message plus its following
  assistant/tool messages). A later compaction updates the
  previous checkpoint. A dangling tool result never starts the tail.
- **Pinned facts**: `/pin` pins the last reply and `/unpin` clears the pins. Pinned text is
  required verbatim in the summary request AND re-injected as a `<user-pinned-facts>` message
  after every checkpoint, so it survives compaction even when the model's summary drops it.
  `/remember <fact>` promotes a fact straight into `MEMORY.md` ([`memory.md`](memory.md)).
- **Optional prune** (`compaction.prune`, default `false`; [`config.md`](config.md)
  "compaction"). When
  enabled, the generation start (before preflight compaction and before the context message
  is appended — first turn only, like compaction) clears tool results older than the
  protected recent window: the most recent ~40k tokens of tool output are kept, older
  unprotected results become `[Old tool result content cleared]`, and the pass commits only
  when at least ~20k tokens are reclaimable. `skill_view` is never cleared. This REWRITES
  already-sent bytes, so it invalidates the provider's prompt-cache prefix — it is therefore
  an explicit, observable event: the session appends an audit entry (`tool: "prune"`), shows
  a toast, and resets its usage anchor so the next estimate is recomputed locally instead of
  trusting a stale prompt-token count. The default off means zero behavior change.
- **Overflow recovery**: a provider context-overflow error (defensive text match) compacts
  once and retries the same step; a second overflow surfaces as the normal error bubble.

### Observability: `/status`, `/ctx`, `/usage`

- `/compact` runs compaction on demand; `/status` prints model,
  ctx `used/limit`, the cache hit rate of the last response (when the endpoint reports
  `prompt_tokens_details.cached_tokens`), mode, approval, and the compaction count. The
  status bar's model segment shows `used/limit`. `/ctx` (also the Ctrl+P "Context
  inspector" row) opens a centered modal readout of the same accounting:
  `ChatSession.contextBreakdown()` returns a plain, serializable `ContextBreakdown`
  snapshot built from the existing estimators (`src/agent/chat/compaction.ts`) + the session's
  live signals — model, window limit, anchored `used`/percent (plus a `pinned` flag once
  the compaction threshold is reached), the local system/history/tool/MCP decomposition,
  durable message and compaction counts, cache read/write, and a bounded list of the
  durable history messages (role + a one-line preview + token estimate). A message's
  preview is its first content line plus an `→ tool ×n` call summary and an image note
  (`messagePreview`), so an assistant turn that only carries tool calls/reasoning reads as
  its tools rather than `(empty)`; each row's token estimate is `estimateMessageTokens`
  (the same figure the list total uses). The overlay recomputes
  through a memo that reads the session signals, so it updates live while a generation
  streams; an empty or disabled session degrades to zeros plus a note, never an error.
  On a **resumed** tab the inspector reconstructs the saved transcript's durable history
  (tool calls included, `src/agent/chat/contextHistory.ts`) and merges anything sent since, so the
  persisted `tool_call` events appear and `used`/`messages` describe the whole session
  rather than the (often smaller, and for pre-`result` transcripts plain-text) request the
  model resumes from (the note flags the reconstruction; `pinned` still tracks the real
  compaction trigger). Resume also seeds
  the status bar's last-response `used`/cache figures from the transcript (display only —
  the usage anchor stays null).
- `/usage` (Ctrl+P "Usage dashboard") rolls up provider-reported token usage over the
  newest 14 days with activity for its summary, chart and `by day` list, with the cache hit
  rate (`src/engine/chat/usage.ts`, re-exported at `ui/chat/usage.ts`); each assistant turn is attributed to the day of its own event
  timestamp, so multi-day sessions land on the right dates instead of collapsing onto the
  session's newest activity date, and the window is bounded rather than loading unlimited
  history. The `by session` list is NOT windowed: it ranks every transcript by volume and
  pages 50 at a time behind a "load more" row (`Enter`/click reveals the next page), so
  older sessions stay reachable. Cost
  is shown only when a price table is supplied (none ships yet). The dashboard opens with a
  stacked daily bar chart — one bar per day, height scaled to the busiest day, split
  bottom→top into output / cache miss / cache hit and colour-separated (legend included) —
  with a y-axis token scale, faint tick gridlines, thinned `MM/DD` labels, and the full text
  roll-ups below (`buildUsageChart`). Segment heights are proportional; a bar too short for
  its segments is grown to one cell per segment, and a slice too small for a cell borrows a
  boundary cell, so every colour stays visible. Both text lists read newest-first (the most
  recent day/session on top): the `by day` list is reverse-chronological and
  `by session` ranks transcripts by newest activity (volume breaks ties); distinct sessions
  that share a title stay separate rows. ↑/↓ (or j/k) move a cursor over those rows and
  Enter opens the
  Context Inspector for that SAVED session, reconstructed from its transcript
  (`ChatHost.sessionContextBreakdown`): the durable history resumes from its last checkpoint
  and the window/system/tool overhead comes from the current config, with a "reconstructed"
  note (read-only — it never resumes the session). Because the transcript persists its own
  `tool_call` events, the reconstruction also shows each turn's tool calls (`→ name ×n`); a
  resumed tab's own inspector uses the same reconstruction, so its persisted tool calls
  show there too. Resume replays a tool turn only when its event carried the persisted
  `result`; a transcript whose tool events predate that field still replays as plain text.

### Persistence & rewind

- **Persistence**: the checkpoint is appended as a `compaction` JSONL event; `--resume`
  rebuilds the provider history from the last checkpoint plus the records after it (the
  visible transcript keeps everything). `tool_call` events persist the raw streamed
  `arguments` and the boundary-capped `result`, so resume also replays assistant
  `tool_calls` + tool-result messages and keeps the investigation context the model actually
  saw; the fields are absent on old transcripts, which replay exactly as before.
- **Rewind**: the `↺ revert` affordance on a user message ([`ui.md`](ui.md) "Rewind") aborts any
  in-flight generation, truncates the display transcript, the durable provider history (via a
  per-message history mark, so tool calls/results in the retained prefix survive) and the
  logical JSONL transcript to just before that message, then reloads its text + images into
  the input to edit and resend. A `revert` JSONL event (`keep` = surviving user+assistant
  records) records the truncation append-only, so `--resume` never resurrects the discarded
  turns; a checkpoint that summarized a discarded record is dropped. When a compaction/prune
  invalidated the history marks, the rewind rebuilds the durable history from the surviving
  transcript instead. While the session is mid-work (reply / compaction / pending approval),
  the UI asks for a second click before rewinding.

### Prompt caching

Implicit prefix caching (OpenAI/GLM-style endpoints) reuses the longest byte-identical
request prefix. Sensus guarantees an **append-only** request shape:

1. **Never rewrite sent bytes.** The context message is emitted once and kept verbatim;
   tool results are capped once at the tool boundary (the bytes appended are simply
   larger) and clipped only while serializing a compaction summary. There is no silent
   retroactive pruning: the only rewrite of sent bytes is an explicit compaction, `/clear`,
   or the optional `compaction.prune` pass — and prune is always logged (audit + toast) and
   resets the usage anchor ([`config.md`](config.md) "compaction").
2. **Append-only history.** Each generation appends its context message + user text; the
   tool loop only appends assistant/tool messages (plus the synthetic vision and
   nearest-`AGENTS.md` user messages, which extend the prefix rather than rewrite it).
   Request N is a byte-identical prefix of request N+1 (except after an explicit compaction
   or `/clear`).
3. **Static system prompt.** Volatile facts (pane cwd, approval mode) ride in the
   per-generation context message, never the system prompt — a `cd` or `/yolo` must not
   invalidate the whole prefix. The prompt changes only when the agent, MCP facts, custom
   instructions, or no-tools mode actually change ([`agent-prompt.md`](agent-prompt.md)).
4. **Volatility lives at the tail.** Fresh terminal snapshots, git status, and approval are
   all in the newest context message.

Observed effect: cross-generation cache reads go from ~system-prompt-size partials to
full-history-minus-new-tail (~98%). `/status` surfaces the last response's cached-token
percentage so regressions are visible.

## Gotchas & invariants

- **History is append-only; never rewrite sent bytes.** The only rewrites are explicit
  compaction, `/clear`, and the logged `prune` pass.
- **Preflight compaction runs before the context message is appended**, or the rewrite can
  eat the fresh block. The same ordering holds for `prune`.
- **The context block is durable but its tail collapses.** Do not "fix" the unchanged-tail
  note by re-emitting the full tail — that invalidates the cache.
- **Tool results are capped once, at the tool boundary**; the summary serialization's 2k
  clip (`SERIALIZE_TOOL_CHARS`) is the only other clip. The mechanism lives in
  [`agent-tools.md`](agent-tools.md).
- **The provider sees the context block as its own user message right before the user's
  text**; scripted test servers must key markers off the last paragraph
  ([`testing.md`](testing.md)).
- **The usage anchor is shape-sensitive**: a no-tools flip, an MCP connect, or an
  agent/model switch invalidates it, and `prune` resets it explicitly.

## Related docs

- [`agent.md`](agent.md) — the harness hub
- [`agent-prompt.md`](agent-prompt.md) — the byte-stable system prompt and streaming display
- [`agent-tools.md`](agent-tools.md) — the tool-boundary cap and spill
- [`agent-loop.md`](agent-loop.md) — the loop order preflight compaction fits into
- [`agent-providers.md`](agent-providers.md) — model metadata, output limits
- [`config.md`](config.md) — `context`, `compaction`, `tool_output`
- [`memory.md`](memory.md) — `/remember`, the memory stores
- [`sessions.md`](sessions.md) — transcripts, resume, metadata sidecars
- [`ui.md`](ui.md) — the Context inspector, rewind, usage dashboard
