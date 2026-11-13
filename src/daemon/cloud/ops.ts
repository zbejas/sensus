/**
 * The RPC op → required-scope table (docs/auth.md "Scopes").
 *
 * `RelayBroker.rpc` consults this table BEFORE its switch, so the policy check
 * lives in exactly one place and a new RPC op cannot be served without a
 * declared scope. An op that is not listed is `unknown_op`; stream ops keep
 * their own per-kind checks in the broker (`CHAT_STREAM_OPS`/`TERMINAL_STREAM_OPS`).
 *
 * `policyFlag` names a host-local `AuthPolicy` boolean that gates an otherwise
 * scope-allowed op. It is checked here too; the broker still owns the typed
 * refusal code so the cloud can render it.
 */

import type { Scope } from "../../auth/scopes.ts"

export interface TunnelOpSpec {
  /** Host-local scope the policy must grant (`view`, `chat`, `control`, `orchestrator`). */
  scope: Scope
  /** Optional host-local policy boolean that must be `true` for this op. */
  policyFlag?: "deleteTranscripts"
}

/**
 * Every cloud-invokable RPC op and its scope. Keep this exhaustive: the broker
 * answers `unknown_op` for anything absent, so adding a `case` without a row
 * here would silently leave the op unreachable (the safer failure).
 */
export const TUNNEL_OPS: Readonly<Record<string, TunnelOpSpec>> = Object.freeze({
  "daemon.info": { scope: "view" },
  "daemon.health": { scope: "view" },
  // Starting the daemon is gated by `policy.startDaemon`, not by `control`.
  "daemon.start": { scope: "view" },
  "terminal.list": { scope: "view" },
  "terminal.open": { scope: "control" },
  "chat.list": { scope: "view" },
  "chat.open": { scope: "chat" },
  // Persisted transcripts: bounded, read-only, and never path-bearing.
  "transcript.list": { scope: "view" },
  "transcript.read": { scope: "view" },
  "transcript.export": { scope: "view" },
  "transcript.context": { scope: "view" },
  // Permanently destructive: `control` plus the host-local opt-in flag.
  "transcript.delete": { scope: "control", policyFlag: "deleteTranscripts" },
  // Agent memory: reads are `view`; writes go through the same store the TUI uses.
  "memory.list": { scope: "view" },
  "memory.read": { scope: "view" },
  "memory.write": { scope: "control" },
})

/** The known RPC op names (tests + docs drift checks). */
export const TUNNEL_OP_NAMES: readonly string[] = Object.freeze(Object.keys(TUNNEL_OPS))

/** Look up one op's spec; null for an unknown (or prototype-polluted) key. */
export function tunnelOpSpec(op: string): TunnelOpSpec | null {
  return Object.hasOwn(TUNNEL_OPS, op) ? (TUNNEL_OPS[op] ?? null) : null
}
