# System prompt & streaming

## Overview

`buildSystemPrompt` assembles the byte-stable system prompt — role, environment, the
active agent's body, MCP/skills/instructions/memory blocks — and the streaming layer renders
the answer live: paced text, thinking blocks, compaction progress, and explicit surfacing of
truncated or empty completions. This doc owns the prompt's content rules and the display
pipeline. Prompt caching (why the prompt must not change mid-session) is in
[`agent-context.md`](agent-context.md); the providers that stream are in
[`agent-providers.md`](agent-providers.md).

## Key files

| File | Purpose |
|---|---|
| `src/agent/prompt.ts` | `buildSystemPrompt` — the section registry loop + `SystemPromptFacts` |
| `src/agent/prompt/section.ts` | `PromptSection` / `SectionCtx` / `SystemPromptFacts` contracts |
| `src/agent/prompt/sections/` | One module per prompt block (role, environment, shells, rules, approvals, when-to-ask, agent, no-tools, MCP, skills, instructions, memory) |
| `src/agent/instructions.ts` | Config `instructions` resolution (paths, `~/`, globs, URLs) + the nearest-`AGENTS.md` lookup |
| `src/agent/skills/loader.ts` | `skillsIndexText` — the name+description prompt index |
| `src/agent/memory/store.ts` | The frozen MEMORY snapshot the prompt carries ([`memory.md`](memory.md)) |
| `src/agent/chat/chatSession.ts` | Prompt assembly call site, streaming state, reveal pacing, the truncation/empty-completion notes, nearest-AGENTS.md attachment |
| `src/agent/chat/chatHost.ts` | Builds prompt facts from config/agents/skills/memory; resolves instruction URLs |
| `src/engine/chat/streamReveal.ts` | `StreamReveal` — the paced visible prefix (`ui/chat/streamReveal.ts` is a re-export barrel) |
| `src/agent/chat/contextAccounting.ts` | The system-prompt token memo the inspector uses |

## How it works

### System prompt

The prompt is a **registry of ordered sections**, not one function that pushes lines.
`src/agent/prompt.ts` is the assembler (`buildSystemPrompt`); one module per block lives
under `src/agent/prompt/sections/`, each declaring an `order` and a `render(ctx)`. A section
renders from the prompt facts **plus the tool set the request actually carries**
(`SystemPromptFacts.tools`, filled from `toolSpecsForRequest` + the MCP specs), so guidance
for a tool that is not in the request is never rendered: a read-only agent is not taught
`shell_session`, an agent whose `tools` list has no shell tool never sees the sudo rule, and
no-tools mode drops every tool block. A section that returns `""` is skipped entirely — no
blank gap, no orphan header.

Render order:

1. **Role** — expert terminal/server copilot living inside the user's terminal. Concise,
   ops-focused; prefer showing a command over explaining theory.
2. **Active agent** — `Active agent: <name> — <description>`.
3. **Environment** — os, host, shell, model, terminal engine (`- terminal: embedded PTY
   (xterm-256color)`), plus a cwd line that says the working directory is provided per
   message in the terminal context block. Static by design — volatile facts live in the
   per-generation terminal context message ([`agent-context.md`](agent-context.md)).
4. **Shell tools** — gated on `shell_background`/`shell_session`: hidden shell vs the user's
   visible terminal. The active agent's `shell` preference sharpens it — `session` =
   SESSION-FIRST (shell_session is the default for anything the user asks to
   run/change/see; background only for quiet read-only investigation), `background` =
   BACKGROUND-FIRST, `auto` = the neutral rule — but only for a shell that exists in the
   request.
5. **Rules** — investigate before guessing; **read files with `read_file`
   (`offset`/`limit`, 1-based), never by shelling out to `sed -n`/`awk`/`head`/`tail`/`cat`
   (read_file is bounded and pageable; every call costs an approval card either way)**;
   apply config/AGENTS.md/agent/skill/MCP edits with the `reload` tool, never by typing
   `/reload` into the terminal; file tools resolve against the pane cwd; never claim a
   command ran without a tool call; never ask for the user's sudo password yourself. The
   sudo rules (plain `sudo <cmd>`, never `-n` as a probe) appear only when a shell tool
   exists ([`agent-tools.md`](agent-tools.md) "Sudo").
6. **Working with approvals** — the approval economy: in confirm mode every gated call is a
   card the user answers, so independent calls batch into one turn (one plan card for N
   calls), a card is never spent re-reading what the agent already has, a state change is
   announced in one line, and the destructive floor holds in full-auto too
   ([`agent-approvals.md`](agent-approvals.md)).
7. **When to ask** — the ask-vs-act boundary, rendered only when `ask_user` is in the
   request: ask only for a genuine fork (destructive/irreversible, missing credentials, an
   ambiguous goal whose readings need different work), never for permission or
   "what next?", once and with the options.
8. **Agent instructions** — the active agent's prompt body verbatim, AFTER the shared rules
   so its posture wins on conflict (the header says so). Built-in bodies are posture only:
   anything every agent needs lives in a section above, which is what keeps copilot, scout
   and ask from drifting apart. The copilot body is approval-conditional (session-first in
   confirm, autonomous/background-first in full-auto), so the static body never embeds the
   volatile approval value.
9. **No-tools** — the copy-paste-only section ("Tool use is UNAVAILABLE on this endpoint …"),
   see [`agent-loop.md`](agent-loop.md) "No-tools degradation".
10. **MCP servers** — one line per server with its tool names, plus a prefer-the-domain-tool
    nudge ([`mcp.md`](mcp.md)).
11. **Skills** — only when a catalog exists AND `skill_view` is offered: the
    name+description index from `skillsIndexText` plus a read-the-full-one-first nudge
    ([`skills.md`](skills.md)).
12. **Custom instructions** — `~/.config/sensus/AGENTS.md` plus every resolved source from
    the config `instructions` list (paths, `~/` paths, globs, fetched URLs;
    [`config.md`](config.md) "instructions"), appended verbatim under one `Custom
    instructions (AGENTS.md + config \`instructions\`)` section. `/reload` re-resolves.
13. **Memory** — only when enabled: the frozen MEMORY snapshot, the HOST.md/JOURNAL.md
    read pointer and the store-full rewrite guidance ([`memory.md`](memory.md)).

### Dynamic nearest-`AGENTS.md` on read

When the agent `read_file`s a path, Sensus walks
UP from that file's directory for the closest `AGENTS.md` and, the first time that file is
seen this session, appends its body as its own durable `user` message
(`Project instructions (from <path>):`). The global `~/.config/sensus/AGENTS.md` is skipped
(already loaded statically). This is deliberately appended rather than folded into the
system prompt: the prompt is byte-stable for the life of a session, and a new message
EXTENDS the provider's cached prefix instead of rewriting it (see "Prompt caching" in
[`agent-context.md`](agent-context.md)). Each
file is attached at most once; `/clear` resets the tracking. Best-effort: a failed read is
never fatal.

### Streaming display

While a generation runs, the sidebar and status bar show progress:

- **Animated streaming label**: the assistant bubble's label is a braille spinner + the
  agent name + elapsed seconds (`⠹ copilot · 3s`); the settled label takes over with the total
  duration (`✱ copilot · 4.0s`). The status bar shows the same (`chat:streaming ⠋ 12s`). Tick
  reads are conditional — settled messages never subscribe. While the active thinking
  header is on screen it is the bubble's only live row — the label is suppressed so two
  spinners never stack — and it returns the moment content streams.
- **Waiting indicator**: the assistant bubble is created on its first delta, so before that
  (right after a send, and between tool turns) there is no bubble to host the animated label
  — historically the only cue was the bare streaming caret. A standalone row now shows the
  active thinking header (`⠹ Thinking`) until the bubble appears, at which point its own
  header/label takes over seamlessly (same text/style, no duration so it cannot appear to
  reset). It is suppressed while a tool card is `pending`/`running` (that is the user or the
  command being waited on, not the model).
- **Compaction progress**: a compaction (manual `/compact` or the automatic preflight) is a
  distinct phase that has no assistant bubble to host it, so it drives its own indicator: the
  session exposes a reactive `accessors.compacting` flag and the sidebar shows a
  `⠹ compacting context…` row (it takes precedence over the waiting indicator), while the
  status bar's `chat:` chip reads `chat:compacting ⠋`. Both read the shared 80ms tick only
  while visible, so idle sessions never subscribe. The flag is the same one `isWorking()`
  reads, so a rewind still asks for confirmation mid-compaction.
- **Delta coalescing**: text/reasoning deltas buffer and land on the message list at most
  every 40ms, with a final flush on resolve/abort/throw so no tail is dropped.
- **Reveal smoothing**: what a bubble SHOWS is paced (`src/engine/chat/streamReveal.ts`; the
  UI import path is a re-export barrel): the
  visible prefix advances each 80ms tick by a fraction of the backlog, so burst deltas
  unfurl instead of popping. The streaming status is held until the pour lands (bounded by
  a 3s failsafe); cuts are grapheme-safe; first sight of an already-populated message
  shows it whole; `chat.animations: false` bypasses it entirely.
- **Output cap (auto by default).** The `maxOutputTokens` sent per request resolves as:
  an explicit endpoint `maxTokens` → the model's advertised output limit
  (`models.dev limit.output`, endpoint override first) → **omitted**, so the endpoint
  applies its own default (`resolveOutputTokens`). Users are never silently capped below
  what their model can emit — the old fixed 8192 default cut long reasoning replies off
  mid-answer. See [`config.md`](config.md) "maxTokens".
- **Truncation & empty completions are never silent.** A stream that ends with
  `finish:"length"` (the endpoint hit the output-token cap resolved above) keeps its
  partial text but is surfaced: a `⚠ reply hit the <N>-token output cap …` system note, a
  warn toast, and a provider `error-raised` event; the turn settles as outcome `error` (the
  frozen v1 `turn.complete` schema has no dedicated outcome, so a capped reply is folded
  into `error`, never logged as a clean `ok`). A plain stop with no visible content
  ("empty completion") is surfaced too — a system note plus a provider `error-raised`
  (deliberately no toast, like the original empty-completion path) — including the
  reasoning-only case, where the thinking block renders but no answer does: the note says
  there was no visible answer after reasoning, and the turn settles `error`, never a silent
  `ok`. Completed tool calls that arrive with a non-`tool_calls` finish are dropped
  unexecuted and named in that note (the tool branch requires `finish:"tool_calls"`). Both
  cases log at `warn` through `agent.chat`, and the provider logs the raw finish reason at
  `debug`
  (`agent.provider`) — see [`logging.md`](logging.md). A pre-visible-content transport
  failure clears the answer-less reasoning bubble in place via `onStreamRestart`; the retry
  policy itself is in [`agent-providers.md`](agent-providers.md) "Retries". A
  `finish:"error"` (default explanation when the stream carried none) and any
  unmapped finish reason are logged at `warn` by the provider, so an unexplained stop is
  diagnosable.
- **Thinking blocks**: reasoning renders as a collapsible block above the answer — an
  animated header while the model reasons (click it to reveal the live reasoning), then a
  collapsed `+ Thought for 2.3s`. With display off (`/thinking hide`, the default) only the
  one-line header shows: the reasoning body is **not drawn** while hidden — expand with
  `/thinking show`, `Alt+T` or a header click; a mid-stream expand reveals the reasoning
  accumulated so far, then streams the rest. Reasoning is display-only (never sent back to
  the provider) but persisted in `assistant_message` and restored on resume.
- **Running tool cards** animate their status glyph.

## Gotchas & invariants

- **The system prompt is byte-stable**; volatile facts (cwd, approval mode) ride the
  per-generation context message. A `cd` or `/yolo` must not invalidate the prefix cache.
- **A section may not read volatile state** (clock, cwd, approval mode, live memory): its
  inputs are `facts` and `ctx.tools` only, or the cached prefix breaks.
- **The request's tool set is part of the prompt's identity**: the same facts with a
  different tool list legitimately render different bytes (that is the point of the
  tool-conditional sections), which is why the set is fixed per session — agent, `readonly`,
  memory on/off and model vision all resolve before the prompt is built.
- **`tests/unit/agent/__snapshots__/prompt.test.ts.snap` is the guard**: the copilot, scout
  and ask prompts are snapshotted, so an accidental wording or ordering change is a diff,
  not a surprise in the field.
- **The memory snapshot is frozen per session; writes appear next session**
  ([`memory.md`](memory.md)).
- **Skills put only name+description in the prompt**; bodies load via `skill_view`
  ([`skills.md`](skills.md)).
- **A nearest-`AGENTS.md` is appended as a durable user message, never folded into the
  prompt** — the prompt never rewrites mid-session.
- **Truncated and empty completions are never silent**: a `length` finish keeps its text
  but settles `error`; a stop with no visible content gets a system note plus
  `error-raised`.

## Related docs

- [`agent.md`](agent.md) — the harness hub
- [`agent-context.md`](agent-context.md) — prompt caching, compaction, the context block
- [`agent-providers.md`](agent-providers.md) — streaming, retries, thinking modes
- [`agent-loop.md`](agent-loop.md) — no-tools behavior, the loop that streams
- [`memory.md`](memory.md) — the frozen snapshot and stores
- [`skills.md`](skills.md) — progressive disclosure
- [`mcp.md`](mcp.md) — the connected-servers prompt block
- [`config.md`](config.md) — `instructions`, `chat.animations`, `maxTokens`
- [`ui.md`](ui.md) / [`DESIGN.md`](DESIGN.md) — rendering rules
