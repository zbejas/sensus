# Approvals & permissions

User guide: https://sensus.sh/docs/approvals/

## Overview

Every tool call passes through exactly one gate before it can run: `ChatSession.gateDecision`
applies the mode/tool baseline, `permission` rules, the allow-prefix list, session trust,
the memory-write gate, and the optional `ApprovalPolicy` extension seam. This doc owns the
approval modes, the destructive floor, session trust and saved allow rules, the read-only
agent guard, and the batch plan card. The extension interfaces themselves are specified in
[`extensions.md`](extensions.md); config keys in [`config.md`](config.md) (`permission`,
`allowPrefixes`, `memory.writeApproval`, `extensions`).

## Key files

| File | Purpose |
|---|---|
| `src/agent/tools/approval.ts` | `baselineApprovalDecision`, `approvalDecision`, `isDestructiveCommand`, `isTrustExempt`, `trustPatternFor`, `readonlyGuardDecision`, `isReadOnlyShellCommand`, `shellSessionSubmits` |
| `src/agent/chat/chatSession.ts` | `gateDecision` — the single enforcement point; the batch pre-evaluation; `resolveCard` |
| `src/agent/chat/toolCardBook.ts` | Pending-card bookkeeping, approval/`ask_user` waits, the session trust-pattern registry |
| `src/agent/chat/chatMessages.ts` | `ToolCardData` (including `allowPrefix`/`destructive`) and `PlanCardData` |
| `src/agent/tools/summary.ts` | `commandPrefix`/`suggestAllowPrefix` (the operation-class pattern), card detail |
| `src/agent/extensions.ts` | The `ApprovalPolicy` + `EventSink` seam ([`extensions.md`](extensions.md)) |
| `src/config/config/resolve.ts` | Parses `permission` / `allowPrefixes` / `extensions` ([`config.md`](config.md)) |
| `src/agent/chat/chatHost.ts` | Builds the policy/sink from config at boot and on `/reload` |
| `src/agent/memory/store.ts` + `src/agent/tools/execute.ts` | Surface the memory-write gate's committed char delta for the `memory-write` event |

## How it works

### Approval modes

- `confirm` (default): **every** tool call requires inline accept/reject — file/scrollback/
  session reads, writes, shell commands, memory, and every MCP tool — with two deliberate
  exceptions. `ask_user` IS the user interaction (it blocks on the question), so it renders
  inline without a card. `shell_session` TYPING auto-runs: the user watches every keystroke
  and nothing executes. Every `shell_session` SUBMISSION — any call that presses Enter (via
  `enter: true`, a plain Enter/Return in `keys`, or a newline in `text`), including a bare
  Enter over a line already in the pane — gets a card, so a line can never RUN without
  approval. A saved `permission` rule, the `allowPrefixes` list, or session trust can exempt
  a call (below). A destructive typed command still hits the destructive floor (below) in
  either mode.
- Pending cards are keyboard-actionable while the input draft is empty and are clickable:
  `y` accept, `n` reject, `a` "approve and don't ask again for this pattern this session"
  (`shell_background` / `shell_session` cards). The pattern is the OPERATION CLASS, not the
  literal string: an arity-aware command prefix (`commandPrefix` in
  `src/agent/tools/summary.ts`) offered as `tool: <prefix>*` — `git status --short` offers
  `git status*`, `systemctl status` offers `systemctl status*`. A compound line
  (`&&`/`|`/`;`/`$(`/newline) is never trustable: its class cannot be captured by a prefix.
  Session trust is **session-scoped and in-memory only** (locked decision 6 — no server,
  no persistence file to clean up); it is consulted at gate time *after* the destructive
  floor, so it can never wave an irreversible command through. The config
  `allowPrefixes` list is the separate *persistent* always-allow list
  ([`config.md`](config.md) "`agent` and `allowPrefixes`");
  session trust is never written to config.
- A card with a trustable class offers the `a` option; a **destructive/irreversible** call
  never does. The exemption is broader than the full-auto destructive floor: `rm`
  anywhere, `dd`, `mkfs`, disk/partition tools (`fdisk`/`parted`/`wipefs`), `shred`,
  `chmod`/`chown`/`chgrp`, `mv`, privileged/arbitrary-shell (`sudo`, `eval`/`exec`,
  `sh -c`), git history destruction (`git reset`/`clean`/`restore`/`checkout`/`rebase`,
  force-push, `branch -D`, `stash drop`), container/orchestration teardown
  (`docker rm`/`rmi`/`prune`, `compose down`, `kubectl delete`, `terraform destroy`,
  `pct destroy`), and process kills. `git reset --hard` in particular is never
  trustable even though it is not part of the full-auto floor. Over-matching is safe:
  an exempt command keeps its per-call card. In `confirm` mode a `shell_session`
  submission card offers trust for its typed command class just like `shell_background`:
  a matching trusted class auto-runs the submission, but an exempt class (`rm`, `sudo`, …)
  never does.
- The trusted patterns are visible and revocable: a status-bar `trust:<pattern>` chip names
  what is currently trusted (a single pattern is named outright; several collapse to
  `trust:<name>, +N`) and a click revokes all session trust, after which the next
  same-class command raises a card again ([`DESIGN.md`](DESIGN.md) "Status bar"). `/clear` also
  drops it.
- A pending card renders its **full** approval detail in the body — the complete shell
  command (or MCP args blob), wrapped and never truncated — so what is being approved is
  always visible; the header's clipped one-line peek (`toolParamsSummary`, 72 chars) is
  suppressed on those cards. Short single-line commands stay in the header alone
  (`toolApprovalDetail` returns null / equals the peek).
- `full-auto` (`/yolo`): everything auto-approved except destructive commands, which still
  gate. The destructive floor covers `rm` / `find -delete` / recursive `chmod`/`chown` /
  `mv` against a catastrophic target (`/`, `$HOME`/`~`, a bare glob, `.`/`..`, or a critical
  system root such as `/etc`/`/usr`/`/var` — but NOT a deep path under one), `shred`/`wipefs`,
  `mkfs`, `dd of=/dev/<device>` (not `of=/dev/null`), the fork bomb, power commands, and a
  redirect truncating a block device. A plain `rm -rf /tmp/sandbox` or `rm -rf ./build`
  stays non-destructive. Both shells carry the floor: `shell_session` normally auto-runs, but
  a catastrophic typed command gates in either mode. Full-auto never gates an ordinary
  `shell_session` submission (the confirm-mode submission card above is confirm-only).
- Switching: `/yolo [off]`, `Alt+Y`, or the status-bar approval indicator.
- A rejection sends the tool result "User rejected", so the model adapts.

### Rule-based permissions

A `permission` list of `{tool, pattern?, action}` rules (`approvalDecision` in
`src/agent/tools/approval.ts`; [`config.md`](config.md) "permission") is applied on top of
the mode/tool baseline. Rules are evaluated in order and the **last matching rule wins**,
replacing the baseline action: `allow` skips the gate, `ask` forces the card, `deny` is
terminal (never execute, no card — the model gets `Denied by permission policy: <tool>`).
Allow-prefixes and session trust sit inside the baseline and apply only when no rule
matched. This is last-match-wins, so a later `allow`
can override an earlier `deny`. A destructive command is never un-gated — by a rule,
by an allow-prefix, or by session trust (`allow`/`ask` rules and trust leave the floor
standing; only `deny` is terminal). A session-trust pattern also never overrides an
explicit `ask` rule. A rule's `pattern` matches the tool's primary value (the shell
command or typed text, the file path for the file tools) with glob semantics
(`*` any run, `?` one character, anchored).

### One enforcement point

`ChatSession.gateDecision` computes the mode/memory/`permission`/
allow-prefix/session-trust decision in exactly one place, shared by the
single-card path and the approval-batch pre-evaluation. Any transport that drives a turn
(the TUI today, the daemon socket) routes through this gate before a
tool executes, so the destructive floor and a terminal `deny` cannot be bypassed. The
daemon's `approvals.answer` op answers a gated call through `resolveCard(callId, action)`,
which this gate observes — the transport never re-decides a gate and never widens session
trust beyond the card's offered class ([`agent-loop.md`](agent-loop.md) "Remote approval &
event stream", [`daemon-api.md`](daemon-api.md)).

### Read-only guard

When the active agent has `readonly: true` ([`agents.md`](agents.md) `readonly`),
`gateDecision` returns a terminal `deny` **before** the mode/
`permission`/trust/policy pipeline via `readonlyGuardDecision`, so nothing can un-deny it. `edit_file`, `write_file`,
`memory`, `shell_session`, and MCP tools are refused outright; a `shell_background`
command is refused unless `isReadOnlyShellCommand` accepts it (no redirects, mutators,
package managers, service/container control, sudo, git writes, `find -delete`, `xargs`, …).
The denial surfaces as `Denied: read-only agent: …` and is emitted with
`source: "guard"`.

### Extensions seam

`gateDecision` consults an optional `ApprovalPolicy` ([`extensions.md`](extensions.md))
AFTER the built-in decision (mode/tool baseline + `permission` rules +
the memory-write gate) and before any card renders or an auto-approval runs. A policy may
`allow` (skip the gate), force an `ask` card, or terminally `deny`; a `null`/malformed/
throwing answer defers to the built-in decision. The **destructive floor is not
waivable**: an `allow` leaves the `rm -rf /`-class gate standing (exactly like a
`permission` `allow`), and a terminal `deny` is never re-decided. The same call path
feeds the optional `EventSink` ([`extensions.md`](extensions.md)): `command-approved` →
`command-ran` (plus `memory-write`), or a single `command-denied`, each stamped with the
instance id. The session also emits the monitoring events the durable v1 log projects —
`session-start`/`session-end`, `turn-complete`, `file-change`, `skill-use`, and
`error-raised` ([`events.md`](events.md)). Both are getters on the session deps, so
`/reload` swaps them live.

### Approval-batch plan card

When ONE assistant turn yields **≥2 calls that would each gate** in `confirm` mode, the
session pre-evaluates every call BEFORE anything executes (`PlanCardData` in
`src/agent/chat/chatMessages.ts`) and presents them as ONE plan — an
ordered list (`[i/N] tool  params`, with the line's full command/detail and a pending
`edit_file`/`write_file` diff), so the user approves the task rather than N opaque
commands. Per-line controls: the whole line toggles its decision on click, `↑/↓` (or
`k`/`j`) move the highlight, `space` toggles it, `y`/`n` set it approved/rejected and
advance, `Shift+A`/`Shift+N` approve/deny all, `Enter` commits. Non-destructive lines
default to **approved** (so the common case is one confirmation); a **destructive** line
defaults to `pending`, is never covered by approve-all, and is **rejected at commit**
unless explicitly approved per line. Approve-all (`Shift+A` / the `A approve all`
control) is a one-step "approve the task": it marks every non-destructive line approved
AND commits the plan immediately, so it runs the batch without a separate confirm; any
still-pending destructive line is rejected by that commit (with the usual warn toast),
so approve-all can never wave an irreversible command through. Deny-all and the
per-line `y`/`n`/toggle/`space` controls only mark state — `Enter` (or `↵ confirm`)
commits those. A line with a trustable class offers the plan-level
`a` (grant session trust for that class + approve). `Esc` aborts the plan and the turn
(like today). A single gated call is unchanged — it keeps its plain card; `ask_user`
still blocks inline and a terminal `deny` still never renders a card. The plan card is
display-only (never sent to the provider; lost on resume, where the individual result
cards replay). Committing runs the calls sequentially in their original order; each
still renders its own result card (approved/rejected + output), but a batch member never
separately blocks on a pending card. See [`ui.md`](ui.md) "Tool cards" and
[`keybindings.md`](keybindings.md).

## Gotchas & invariants

- **`gateDecision` is the single enforcement point**; the destructive floor is not waivable
  by rules, prefixes, session trust, or an `ApprovalPolicy`, and a `deny` is terminal.
- **The read-only guard runs before the permission/policy pipeline** — nothing can un-deny
  it, and it is enforced at the execution layer, not merely in the agent's prompt.
- **Session trust is in-memory only; `allowPrefixes` is persistent config.** Trust dies with
  the process and is consulted after the destructive floor; a compound command never offers
  trust; a trust-exempt class never carries the `a` affordance.
- **Approve-all can never wave an irreversible command through** — a still-pending
  destructive line is rejected at commit.
- **An `allow` from any source leaves the destructive gate standing**; only `deny` is
  terminal. Last-match-wins between `permission` rules means a later `allow` can override
  an earlier `deny`.
- **A policy runs on the tool path**: `decide` must be synchronous, prompt, and free of
  unbounded I/O; return `null` to defer ([`extensions.md`](extensions.md)).

## Related docs

- [`agent.md`](agent.md) — the harness hub
- [`agent-tools.md`](agent-tools.md) — the tools being gated, the read-only tool list
- [`agent-loop.md`](agent-loop.md) — the loop, the remote approval/event seams
- [`extensions.md`](extensions.md) — the `ApprovalPolicy`/`EventSink` interfaces
- [`agents.md`](agents.md) — `readonly`, `tools`, `sudoPrompt`, `shell` posture fields
- [`config.md`](config.md) — `permission`, `allowPrefixes`, `memory.writeApproval`, `extensions`
- [`keybindings.md`](keybindings.md) / [`ui.md`](ui.md) — card and plan controls
