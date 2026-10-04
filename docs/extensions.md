# Extensions

## Overview

The extension seam is the single **privileged** API sensus exposes to a third party
(a local auditor, an enterprise addon, the `sensus daemon`). It has exactly two
interfaces:

- **`ApprovalPolicy`** — consulted once per tool call, before anything renders or
  auto-approves; it returns a decision and renders nothing.
- **`EventSink`** — a fire-and-forget stream of the audit-worthy events the agent already
  produces implicitly.

Both are **optional** and default to no-op/local: with neither configured the agent
behaves byte-for-byte as the built-in modes. The interfaces are a documented **public API**
([`licensing.md`](licensing.md)): the whole repo is Apache-2.0 with no open/paid split, and
a host may link its own implementations. There is deliberately **no plugin loader** — MCP
servers, agents and skills remain the user-addable extension surfaces; this seam is the one
place a decision is made and an event is recorded. The `sensus daemon` consumes the same
seam so a socket-driven turn cannot bypass the approval gate.

## Key files

| File | Purpose |
|---|---|
| `src/agent/extensions.ts` | The public seam: config/runtime/policy types, the `NoopEventSink` + `UdsEventSink` + `JsonlEventSink`, the frozen event schema v1 (`EventV1`/`toEventV1`), `createEventSink`, `consultApprovalPolicy`, `createApprovalPolicy` |
| `src/agent/chat/chatSession.ts` | Consults the policy in `gateDecision`; emits `command-approved` / `command-denied` / `command-ran` / `memory-write` from `runToolCall` |
| `src/agent/chat/chatHost.ts` | Builds the policy/sink from config at boot and on every `/reload`; emits `session-start` from `createTabChat` |
| `src/agent/chat/chatMessages.ts` | `ChatSessionDeps.approvalPolicy` / `.eventSink` / `.sessionId` (the getter seam) |
| `src/config/config/resolve.ts` | Parses the `extensions` config section ([`config.md`](config.md) "extensions") |
| `src/agent/memory/store.ts` + `src/agent/tools/execute.ts` | Surface the committed memory write's char delta for the `memory-write` event |

## How it works

### The approval policy

```ts
interface ApprovalPolicy {
  decide(ctx: ApprovalPolicyContext): ApprovalPolicyDecision | null
}
type ApprovalPolicyDecision =
  | { action: "allow" }
  | { action: "ask" }
  | { action: "deny"; reason?: string }
```

| Caller | When |
|---|---|
| `ChatSession.gateDecision` | Once per call that reaches execution — after the built-in decision (mode/tool baseline + `permission` rules + the memory write gate), before any card renders or an auto-approval runs. The batch pre-evaluation consults it too, so a policy may see a call more than once. NOT consulted for a call a read-only agent's guard already denied (docs/agents.md `readonly`). |
| `consultApprovalPolicy` | Wraps every call; a `null`, malformed, or **throwing** answer defers to the built-in decision. |

What a policy may decide:

| `action` | Effect |
|---|---|
| `allow` | Skip the gate (no card). It may not un-gate a **destructive** call — the floor is a hard invariant, exactly as for a `permission` `allow`. |
| `ask` | Force an approval card (in `full-auto` too). |
| `deny` | Terminal: never execute, no card; the model gets `Denied by approval policy: <tool>` (+ the reason). |
| `null` / invalid | Defer to the built-in decision. |

`ApprovalPolicyContext` carries `tool`, `args`, the built-in `decision`, `mode`,
`session`, `agent`, `cwd`, and `shell`. A policy is **privileged within the gate**: an
`allow` outranks the memory write gate and a config `ask` rule, but it cannot overrule a
terminal `deny` or the destructive floor.

The `sensus daemon` answers a WS `approvals.answer` through `ChatSession.resolveCard`
→ `gateDecision`, so a socket-driven turn is decided by this exact seam; the transport
never re-decides a gate, never widens session trust beyond the card's offered class, and
cannot override a terminal `deny` or the destructive floor.

### The event sink

```ts
interface EventSink {
  emit(event: SensusEvent): void
}
```

`emit` is a synchronous hand-off: it MUST return promptly (never block the TUI), MUST NOT
throw, and MAY drop events under load. The session/host wrap every call anyway, so a
misbehaving sink can never break a tool call or a reload.

| Event | Emitted when | Payload highlights |
|---|---|---|
| `session-start` | `ChatHost.createTabChat` (fresh or resumed), once per tab | `session`, `agent`, `approval`, `shell`, `model`, `resumed` |
| `session-end` | `ChatHost.endTabChat` — the daemon releases a chat (`daemon stop`); a chat survives client detach (D4) | `session`, `reason` |
| `turn-complete` | An agent turn settled (status returned to idle) | `session`, `durationMs`, `outcome` (`ok`/`aborted`/`error`), `model` |
| `command-approved` | A call is permitted to run | `tool`, `source` (`auto`/`user`/`policy`), `approval`, `agent`, `cwd`, `shell` |
| `command-denied` | A call is refused: a terminal `permission`/guard/policy `deny`, a user reject, or an abort | `tool`, `source` (`permission`/`policy`/`guard`/`user`/`aborted`), `reason?` |
| `command-ran` | A call executed (tool execution, or a file write) | `tool`, `command` (the call's primary target, capped at `EVENT_TARGET_MAX`), `ok`, `exitCode?`, `approval`, `agent`, `cwd`, `shell` |
| `file-change` | A `write_file`/`edit_file` committed (or failed to commit) a file | `tool`, `path`, `action` (`write`/`edit`), `ok` |
| `memory-write` | A `memory` write committed | `target`, `action`, `beforeChars`, `afterChars`, `delta`, `ok` |
| `skill-use` | The `skill_view` tool loaded a skill body | `name`, `source` (`tool`) |
| `error-raised` | A surfaced provider/compaction/engine error (or a genuine tool failure) | `source`, `message`, `tool?` |

Ordering: within one call it is `command-approved` → `command-ran` (plus `memory-write`
for a memory write), or a single `command-denied` for a refusal (only an approved call
reaches `command-ran`). A call that never passes the gate (the doom-loop guard) or an
interaction tool (`ask_user`) emits no command event. Every event carries `ts` (epoch
millis) and `session` (the instance id, matching the audit log).

### Configuration

```json
{
  "extensions": {
    "approvalPolicy": { "kind": "default" },
    "eventSink": { "kind": "uds", "path": "/run/sensus/events.sock" }
  }
}
```

Defaults are `{ approvalPolicy: { kind: "default" }, eventSink: { kind: "noop" } }`. See
[`config.md`](config.md) "extensions" for the keys.

- **`eventSink.kind`** — `"noop"` (default; drops every event), `"uds"` (newline-delimited
  JSON to a local Unix socket; a `unix://` path prefix is accepted), or `"jsonl"` (the
  frozen event schema v1 appended to the local log — default
  `~/.local/share/sensus/events.jsonl`, bounded and rotating; [`events.md`](events.md)).
  The `uds` sink is local-only and dependency-free (`Bun.connect({ unix })`), never TCP.
  The daemon defaults to the **JSONL** sink: the engine's `noop` default means "the
  daemon's log" (D13).
- **`approvalPolicy.kind`** — `"default"` (the shipped default: defer to the built-in
  modes). Any other kind and the object's extra keys are handed to the host's
  `ApprovalPolicyFactory`; a stock build has none, so an unknown kind is a no-op.

A malformed `extensions` section never throws and never blocks boot: an unknown key warns;
an invalid policy kind keeps the default; an invalid sink kind/path warns and keeps the
noop default ([`config.md`](config.md) "extensions").

### The event schema v1 (the JSONL sink)

The `JsonlEventSink` writes the frozen, versioned projection the monitoring seam reads:
one `EventV1` JSON object per line with `{ v: 1, ts, instanceId, session, type, … }`.
`toEventV1(event, instanceId)` is the pure seam→v1 mapping (the eight types plus the type
fields); `command-approved`/`command-denied` have no v1 counterpart and are dropped there.
The schema, its emission points, the file cap/rotation, and the no-egress guarantee are in
[`events.md`](events.md).

### Wiring an implementation (the public API)

The host factory is the injection point a third party uses; with neither factory the
built-in behavior is untouched:

```ts
import { ChatHost, type ApprovalPolicy, type EventSink } from "sensus"

const approvalPolicyFactory = (cfg: ApprovalPolicyConfig): ApprovalPolicy | null => ({
  decide: (ctx) => (ctx.tool === "shell_background" && isDenied(ctx.args["command"]) ? { action: "deny", reason: "blocked" } : null),
})

new ChatHost({
  /* … */
  approvalPolicyFactory,
  eventSinkFactory: (cfg): EventSink => mySink, // default: createEventSink(cfg)
})
```

### The UDS sink (built-in)

- Newline-delimited JSON, one event per line, written to a Unix socket; no TCP, no new
  dependency.
- A missing/refused socket drops events silently — `emit` never throws and never awaits.
- The backlog is **bounded** (`UDS_EVENT_QUEUE_MAX`, drop oldest) and reconnects are
  throttled (`UDS_RECONNECT_MS`); partial writes are retried on the socket's `drain` and a
  partially written line is dropped on close (never spliced into the next record). The
  socket is `unref`'d so it cannot pin the process.

## Gotchas & invariants

- **The destructive floor is not waivable by a policy.** An `allow` leaves it standing;
  only a `deny` is terminal. This mirrors a `permission` `allow` ([`agent.md`](agent.md)).
- **A policy runs on the tool path.** Keep `decide` synchronous, prompt, and free of
  unbounded I/O (no provider or network call) — it is consulted inline before a card or an
  execution. Return `null` to defer.
- **The sink is audit, not a transaction log.** It is fire-and-forget and may drop; a
  receiver outage must never block or slow the TUI, and events must not be treated as
  durable.
- **No network, no licence check, no new dependency** in the client. Sensus works fully
  with the seam absent.
- **`session` is the instance id** (coarse session grouping), matching `AuditEntry.session`
  in `src/agent/audit.ts`.
- **Reload swaps both live.** The deps are getters, so a `/reload` that changes
  `extensions` takes effect for the next call without a restart.
- **The batch pre-evaluation consults the policy too.** A stateful policy should be
  deterministic for the same call, since `gateDecision` runs in both the pre-collected
  plan and the executor.
- **The UDS socket path may `unix://`-prefix** (the daemon↔control-plane symmetry); the
  built-in sink strips it. A bare path is used as-is.

## Related docs

- [`config.md`](config.md) — the `extensions` config keys
- [`events.md`](events.md) — the frozen event schema v1 and the durable local log
- [`agent.md`](agent.md) — approval modes, the tool loop, memory writes
- [`memory.md`](memory.md) — the `memory-write` source
- [`architecture.md`](architecture.md) — the daemon that consumes the seam
- [`licensing.md`](licensing.md) — the Apache-2.0 statement
