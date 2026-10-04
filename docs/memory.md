# Agent Memory

Sensus gives the agent a small, explicit, human-readable memory instead of relying on the
context window. Three plain-markdown stores under `~/.config/sensus/memory/` are maintained
through the `memory` tool; only one of them is ever injected into the system prompt.

User guide: https://sensus.sh/docs/memory/

Adapted from Hermes Agent (Nous Research): hard character caps, `§`-separated entries,
frozen per-session injection, and a management surface.

## Files and hard caps

| File | Purpose | Default cap | Injected |
|---|---|---|---|
| `MEMORY.md` | environment facts, conventions, lessons learned | 2,200 chars | **always** (frozen snapshot) |
| `HOST.md` | server/machine architecture map (what/where) | 4,000 chars | never (tool-only) |
| `JOURNAL.md` | episodic log, append-only | 8,000 chars | never (tool-only) |

- Entries are paragraphs separated by a lone `§` line; the files are human-editable and
  round-trip.
- A cap is a **hard limit** for MEMORY/HOST: an over-limit write returns an error (with the
  current entries) and never truncates, so the model consolidates first. JOURNAL is
  episodic and **ring-trimmed** — the oldest entries drop to fit.
- Duplicate `add` is a no-op success.

Location helpers live in `src/config/config.ts` (`memoryDir(home)`, `SENSUS_HOME`
redirects). The store itself is `src/agent/memory/store.ts`; types are in
`src/agent/memory/types.ts`; the safety scans are in `src/agent/memory/safety.ts`.

## Cache discipline (frozen snapshot)

A `ChatSession` captures a **frozen `MEMORY.md` snapshot once at construction** (`new tab`,
resume) and renders it into the system prompt. Memory writes during a session
persist to disk immediately but do **not** change the live prompt: they appear in the
*next* session's snapshot. Tool results always show live state. A new session (new tab or
resume) captures a fresh snapshot; the manager's `r` re-reads the store from disk but does
not re-snapshot the live prompt. This preserves the prompt-prefix cache invariant
(docs/agent.md "Prompt caching").

The prompt block (placed after the custom instructions) carries only MEMORY, plus one
static line telling the model that the `host` and `journal` stores exist and are reached
through the tool:

```
══════════════════════════════════════════════
MEMORY (your notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
<entry>
§
<entry>
```

## The memory tool

The agent maintains all three stores with one `memory` tool
(`action` · `target` · `content?` · `old_text?`):

- `list` / `read` — live entries + usage, or the full content (`host`/`journal` are never
  injected, so `read` is how the agent sees them). Gated like every tool in `confirm` mode;
  in full-auto they auto-run.
- `add` / `replace` / `remove` — write. `replace` is a **find-and-replace**: it locates the
  single entry containing `old_text` and substitutes `content` for exactly that matched span,
  leaving the rest of the entry intact (when `old_text` is the whole entry, the whole entry is
  replaced); `remove` deletes the whole matched entry. A whole-entry exact match wins and an
  ambiguous match — or an `old_text` that occurs more than once inside the entry — returns the
  candidates instead of guessing. Every write reports the character delta in its result, and a
  `replace` that removes a large fraction of the store is flagged ("large reduction: verify the
  entry") so a destructive edit is visible immediately.
- `rewrite` — memory/host only: the MODEL supplies a complete new store body (entries separated
  by lone `§` lines) and it replaces the store atomically (see "Rewrite" below). This is how the
  agent consolidates a full store — there is no separate summarization pass.
- In `confirm` mode every memory action is gated like any other tool. In full-auto, writes
  auto-run unless `memory.writeApproval: true`, which gates every mutating action (`add` /
  `replace` / `remove` / `rewrite`).
- When `memory.enabled:false` the tool (and `host_scan`) are dropped from the request and the
  prompt block is omitted.

## HOST.md and host_scan

`HOST.md` is the machine/server architecture map — the "what runs where" memory. It is never
injected; the agent reads and edits it through the `memory` tool. The fixed section template:
`## What this machine is` · `## OS & hardware` · `## Services & ports` · `## Key paths` ·
`## Commands` · `## Data & volumes` · `## Network/topology` · `## Conventions` · `## Gotchas` ·
`## Open questions` · `## Recent changes`.

`/map` bootstraps it: it asks the agent to run the `host_scan` tool (a READ-ONLY whitelist of
OS/disk/port/service/container/network/git probes — see
`src/agent/memory/hostScan.ts`), then curate the redacted draft into `HOST.md` rather than
dumping it verbatim. `host_scan` is read-only and redacts secrets before anything reaches the
model or a file; in `confirm` mode it is gated like every tool, in full-auto it auto-runs.

The setup wizard's host-scan step seeds `HOST.md` from the same probes: it writes the raw
capped draft (`capSeedContent`) and the agent curates it later with the `memory` tool. The
wizard no longer calls a model for this — seeding never blocks init. An existing non-empty
`HOST.md` is never overwritten and nothing is written (see `planHostSeed`).

## Management UI

`/memory` (Ctrl+P "Agent memory", or the settings screen's Memory category for the config)
opens `MemoryManager` (`src/ui/components/MemoryManager.tsx`), a centered modal overlay with a
rail — **Memory · Host map · Journal** — usage bars (`used/limit chars · % · entries`),
per-entry rows with char counts and a bounded preview, and inline add/edit/delete/prune
(prune drops the oldest entries to half the cap)/reload. The manager writes through the
daemon's memory API, so `MemoryStore`'s caps and safety scans apply identically to the agent
and the user. The settings screen's Memory category edits the `memory` config knobs
(docs/config.md).

`JOURNAL.md` is the chronological **journey** of what the agent did — entries are ordered
by append time and it ring-trims automatically on overflow; the manager's prune gives an
explicit trim.
For MEMORY/HOST the prompt's memory block points the agent at the `rewrite` action whenever a
store is full (usage at its cap or an over-limit write rejection) — rather than dropping durable
facts.

## Rewrite

MEMORY and HOST are hard-capped, so a full store rejects the next `add`/`replace`/`rewrite` and
the error names the `rewrite` action as the consolidation path — or the agent merges with
`replace`/`remove` for a small change. `memory action:"rewrite"` (`target` memory or host) takes
the MODEL's complete new store body: the tool parses it into entries and
`MemoryStore.rewrite` commits it atomically. There is **no second provider pass** — the main
model composes the condensed body inside the normal tool loop, so there is no summarizer to
starve, no reasoning-budget knob, and no parse/retry gate. The store's safety scans and hard cap
are re-applied, so an over-budget rewrite is refused (never truncated) and the model composes a
smaller body. A blank body is refused. `rewrite` is a mutating action: gated like every tool
in `confirm` mode; in full-auto it is gated by `memory.writeApproval` and auto-runs otherwise.

Entries are separated by lone `§` lines in `content`, exactly as in the file; duplicates and blank
entries are dropped. The model is told to merge related entries, drop stale detail, and keep every
durable fact. Because MEMORY is already injected into the prompt the model can rewrite it without
a read; HOST.md is never injected, so the model reads it (`action:"list"`/`"read"`) first.

JOURNAL is **not** rewritable — it is episodic and ring-trims itself. A rewrite writes disk
immediately but does not change the live prompt: like every memory write it appears in the *next*
session's frozen snapshot (see "Cache discipline").

## Safety

- **Secret refusal**: writes that look like API keys, tokens, passwords, JWTs or private
  keys are refused when `memory.redactSecrets` is true (default). `host_scan` output is
  redacted before it is returned.
- **Injection scan**: instruction-override/exfiltration phrasing and invisible/bidi-control
  Unicode are refused because memory text is injected into the system prompt.
- **Audit history**: every successful write appends a compact before/after record to
  `memory/.history.jsonl` (newest 500 kept) so edits are auditable.
- **Rewrite**: the model's rewritten entries pass through the same secret/injection scans at
  commit time (`MemoryStore.rewrite`), so a consolidation cannot smuggle a credential or an
  instruction override into the store.
- Memory content is model-facing: it is treated as untrusted input and clearly delimited in
  the prompt; it can never override the agent instructions.

## Configuration

See docs/config.md "memory": `enabled`, `memoryCharLimit`, `hostCharLimit`,
`journalCharLimit`, `writeApproval`, `consolidateAtPercent`, `redactSecrets`. `enabled:false`
drops the tool and the prompt block so the model is never told about a tool it cannot use.
`consolidateAtPercent` is parsed and validated but not yet enforced at runtime — the full-store
path today is the model's explicit `rewrite` action (or `replace`/`remove` merges); the threshold
is reserved for a future automatic trigger.

## Tests and docs

- Unit: `tests/unit/agent/memory/store.test.ts` (caps, overflow, duplicates, substring
  matching/ambiguity, ring-trim, redaction, injection, snapshot, history, `rewrite`);
  `tests/unit/agent/memory/hostScan.test.ts` (read-only whitelist, redaction, formatting);
  `tests/unit/config/wizard.test.ts` (the host-scan seed plan + `capSeedContent`);
  `tests/unit/agent/tools.test.ts` + `tests/unit/agent/chat/chatSession.test.ts` (tool dispatch
  incl. `rewrite`, write approval, frozen-snapshot cache invariant, disabled-memory tool drop);
  `tests/unit/ui/chat/memoryManager.test.ts` (the manager's pure helpers).
- Config: the `memory` section parses and validates in `tests/unit/config/config.test.ts`.
- The manager overlay (phase 1.4) and session search (phase 1.6) document themselves.

## Related docs

- [`config.md`](config.md) — the `memory` config section
- [`agent.md`](agent.md) — the tool loop, approvals, prompt caching
- [`ui.md`](ui.md) — overlays
