/**
 * Daemon lifetime policy (D3/D4/D9/D10/D21; docs/daemon-api.md "Lifecycle").
 *
 * A non-persistent daemon is on-demand: once the last WebSocket client is gone
 * and no agent turn is running, it holds for a grace window so a restarting
 * client can re-attach, then idle-exits and takes its shells with it. A
 * detached turn is NEVER aborted just because the client left — the daemon
 * stays up until the turn settles and only then starts (or re-starts) the
 * grace clock.
 *
 * With no client attached, a pending approval / sudo / plan prompt holds (it is
 * never declined immediately) and, after the approval timeout, the call is
 * recorded as denied and the turn is aborted — nothing executes unapproved
 * (D10). `chat.abort` still declines immediately; a *resolving* client that
 * leaves while other clients remain leaves a prompt nobody is watching, so
 * that prompt is denied at once (never dangling).
 *
 * `versionMismatchAction` is the pure handshake helper the client uses on
 * connect (D21): equal versions are fine; a mismatch restarts a worker that
 * holds no shells; a worker that holds shells warns and lets the user choose.
 *
 * The timers are the `unref`'d `GraceWindow` primitive, owned by this class and
 * cancelled on `stop()`, so they never hold the process open on their own.
 */

import type { ChatEvent } from "../engine/index.ts"
import type { Logger } from "../core/log.ts"
import { componentLogger } from "./log.ts"
import { GraceWindow } from "./ws.ts"

/** Module-level child logger for the lifetime policy (component `daemon.lifecycle`). */
const log: Logger = componentLogger("daemon.lifecycle")

/** Re-exported for compatibility; the implementation is Elysia-free (version.ts). */
export { versionMismatchAction } from "./version.ts"

/** Default no-client approval/sudo hold before the turn is aborted (D10). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/**
 * Default re-attach window (8h): a shell left **inactive** (no attached client)
 * longer than this is killed by the idle reaper, so a session from a previous
 * workday cannot be resumed later (docs/daemon-api.md "Lifecycle"). A live pane
 * pins the daemon and is never reaped while a client watches it.
 */
export const DEFAULT_REATTACH_MAX_AGE_MS = 8 * 60 * 60 * 1000

/** How often the idle reaper checks for stale shells (ms). Fixed; only the
 * window is tunable. */
export const REAP_INTERVAL_MS = 60_000

/** `SENSUS_DAEMON_REATTACH_MAX_AGE_MS` (ms, ≥ 0) or the 8h default. `0` disables
 * reaping (a shell may be re-attached indefinitely). An invalid value keeps the
 * default. */
export function resolveReattachMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["SENSUS_DAEMON_REATTACH_MAX_AGE_MS"]
  if (raw === undefined || raw.trim() === "") return DEFAULT_REATTACH_MAX_AGE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_REATTACH_MAX_AGE_MS
}

/** `SENSUS_DAEMON_APPROVAL_TIMEOUT_MS` (ms, ≥ 0) or the 60s default. */
export function resolveApprovalTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["SENSUS_DAEMON_APPROVAL_TIMEOUT_MS"]
  if (raw === undefined || raw.trim() === "") return DEFAULT_APPROVAL_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_APPROVAL_TIMEOUT_MS
}

/** Truthy spellings accepted for `SENSUS_DAEMON_PERSISTENT`. */
const TRUTHY = new Set(["1", "true", "yes", "on"])

/**
 * Whether the daemon never grace-exits (D3/D9): `SENSUS_DAEMON_PERSISTENT` is a
 * truthy value, or the config flag `daemonPersistent` is set.
 */
export function resolvePersistent(env: Record<string, string | undefined> = process.env, configFlag = false): boolean {
  const raw = env["SENSUS_DAEMON_PERSISTENT"]
  const envOn = raw !== undefined && TRUTHY.has(raw.trim().toLowerCase())
  return envOn || configFlag === true
}

/**
 * The client's version-handshake decision (D21). Pure: `ok` when the versions
 * match; `restart` when the daemon holds no shells (a restart loses nothing);
 * `warn` when it holds shells (the user chooses restart-and-lose or defer).
 *
 * The implementation now lives in the Elysia-free `version.ts` so the client
 * can reuse it; it is re-exported from here for compatibility.
 */

/** What a disconnecting client leaves behind (from the WS endpoint). */
export interface ClientGoneInfo {
  /** Attached clients still connected after this one left. */
  remaining: number
  /** Chats this client watched that no remaining client watches. */
  orphanedChats: readonly string[]
}

/** The daemon state the policy reads / acts on. */
export interface DaemonLifecycleDeps {
  /** Non-persistent idle grace in ms (`SENSUS_DAEMON_GRACE_MS`). */
  graceMs: number
  /** No-client approval/sudo hold in ms (`SENSUS_DAEMON_APPROVAL_TIMEOUT_MS`). */
  approvalTimeoutMs: number
  /** Never grace-exit (`SENSUS_DAEMON_PERSISTENT` / config). */
  persistent: boolean
  /** True while any chat turn runs (streaming) or blocks on a prompt. */
  anyTurnRunning: () => boolean
  /** Chat ids blocked on an approval / plan / sudo / ask prompt. */
  pendingPromptChats: () => string[]
  /**
   * True while the daemon owns at least one live pane shell. The daemon holds
   * (does not idle-exit) while this is true, so a client kill/restart cannot
   * reap a pane or a command running in it (D1, locked #6; docs/daemon-api.md
   * "Lifecycle"). Optional so existing test deps stay valid; absent ≡ false.
   */
  hasLiveShells?: () => boolean
  /**
   * Re-attach window in ms (docs/daemon-api.md "Lifecycle"): a shell idle
   * (no attached client) longer than this is killed by `reapIdleShells`.
   * Omitted / `0` disables reaping. Optional so existing test deps stay valid.
   */
  reattachMaxAgeMs?: number
  /**
   * Kill every shell left inactive past `reattachMaxAgeMs`. Called on the reaper
   * tick; killing a shell releases its bound chat (one tab = one shell = one
   * chat), so a reaped session is gone and cannot be re-attached. Optional;
   * absent ≡ no reaping.
   */
  reapIdleShells?: (maxIdleMs: number) => void
  /** Reaper tick interval in ms; defaults to `REAP_INTERVAL_MS`. Optional test
   * seam. */
  reapIntervalMs?: number
  /** Deny a chat's pending approval/plan/sudo (no abort). Returns true when a
   * prompt was actually resolved. */
  denyPending: (chatId: string) => boolean
  /** Abort a chat's running turn (resolves any leftover wait as aborted).
   * `reason` names the cause on the turn's structured record (docs/logging.md). */
  abortTurn: (chatId: string, reason?: string) => void
  /** Clean shutdown: kill shells/chats, close listeners, remove socket/pid. */
  shutdown: () => void
}

/**
 * The lifetime state machine. `clients` is tracked here; `serve.ts` feeds it
 * client connect/disconnect plus every engine `ChatEvent`.
 */
export class DaemonLifecycle {
  private clients = 0
  private started = false
  private stopped = false
  /** Whether the no-client approval hold is currently armed (so unrelated chat
   * events never reset the timeout). */
  private approvalHeld = false
  private readonly grace: GraceWindow
  private readonly approval: GraceWindow
  /** Periodic reaper for shells left inactive past the re-attach window. */
  private reapTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: DaemonLifecycleDeps) {
    this.grace = new GraceWindow(deps.graceMs, () => this.onGraceExpired())
    this.approval = new GraceWindow(deps.approvalTimeoutMs, () => this.onApprovalExpired())
  }

  /** Arm the startup grace: a daemon that never gets a client still exits. Also
   * start the idle reaper when a re-attach window is configured. */
  start(): void {
    this.started = true
    this.armGraceIfIdle()
    this.armApprovalIfNeeded()
    this.startReaper()
  }

  /** A client upgraded and handshook: cancel both timers (a present client can
   * resolve prompts, and the idle clock stops). */
  clientConnected(): void {
    this.clients += 1
    this.grace.cancel()
    this.cancelApproval()
  }

  /** A client's socket closed. */
  clientGone(info: ClientGoneInfo): void {
    this.clients = Math.max(0, info.remaining)
    if (this.stopped) return
    if (this.clients > 0) {
      // The resolving client left while others remain: deny any prompt that no
      // present client watches so it can never dangle (nothing runs unapproved).
      const pending = new Set(this.deps.pendingPromptChats())
      for (const chatId of info.orphanedChats) {
        if (pending.has(chatId)) this.resolveOrphan(chatId)
      }
      this.cancelApproval()
      return
    }
    this.armGraceIfIdle()
    this.armApprovalIfNeeded()
  }

  /**
   * React to an engine chat event: a raised prompt with no client arms the
   * approval hold, a settled turn re-arms the idle grace, and a running turn
   * keeps the daemon alive.
   */
  onChatEvent(_chatId: string, event: ChatEvent): void {
    if (this.stopped) return
    switch (event.kind) {
      case "approval-request":
      case "sudo-request":
      case "approval-resolved":
      case "sudo-resolved":
        this.armApprovalIfNeeded()
        break
      case "status":
        if (event.status === "streaming") this.grace.cancel()
        else this.armGraceIfIdle()
        break
      default:
        break
    }
    // A prompt may have appeared via a plain message/card update.
    if (this.clients === 0) this.armApprovalIfNeeded()
  }

  /** Cancel both timers (daemon shutdown). */
  stop(): void {
    this.stopped = true
    this.grace.cancel()
    this.cancelApproval()
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
  }

  /**
   * The live-shell set changed. The daemon holds while any pane shell lives, so
   * a shell opening (nothing to do) or exiting (the last one may free the idle
   * clock) re-evaluates the grace window. Called by `serve.ts` on shell exit.
   */
  shellsChanged(): void {
    this.armGraceIfIdle()
  }

  // -- internals --------------------------------------------------------------

  /**
   * Start the periodic idle reaper when a re-attach window is configured. It
   * runs on an `unref`'d interval so it never holds the process open on its
   * own; a persistent daemon still reaps (that is the point — a service that
   * never exits would otherwise accumulate sessions forever).
   */
  private startReaper(): void {
    const maxAge = this.deps.reattachMaxAgeMs ?? 0
    if (maxAge <= 0 || this.deps.reapIdleShells === undefined) return
    if (this.reapTimer !== null) return
    const interval = this.deps.reapIntervalMs ?? REAP_INTERVAL_MS
    this.reapTimer = setInterval(() => this.reap(maxAge), Math.max(1, Math.floor(interval)))
    this.reapTimer.unref?.()
    // Reap once at startup too: sessions left over from a previous (still
    // running) daemon are cleaned without waiting a full tick.
    this.reap(maxAge)
  }

  private reap(maxAge: number): void {
    if (this.stopped) return
    try {
      this.deps.reapIdleShells?.(maxAge)
    } catch (err) {
      // The reaper must never crash the daemon.
      log.warn("idle reaper tick failed", { err, maxIdleMs: maxAge })
    }
  }

  private armGraceIfIdle(): void {
    if (!this.started || this.stopped || this.deps.persistent) return
    if (this.clients > 0) return
    if (this.deps.anyTurnRunning()) return
    if (this.deps.pendingPromptChats().length > 0) return
    // A live pane pins the daemon: the visible shell is the user's terminal and
    // must stay re-attachable (D1, locked #6). It is released on `exit`/kill,
    // which calls `shellsChanged` and re-arms this clock.
    if (this.deps.hasLiveShells?.() === true) return
    this.grace.arm()
  }

  private onGraceExpired(): void {
    if (this.stopped || this.deps.persistent || this.clients > 0) return
    // A detached turn keeps the daemon alive; `armGraceIfIdle` re-arms when it
    // settles.
    if (this.deps.anyTurnRunning() || this.deps.pendingPromptChats().length > 0) return
    // A pane that appeared after the clock was armed pins the daemon too.
    if (this.deps.hasLiveShells?.() === true) return
    this.shutdown()
  }

  private armApprovalIfNeeded(): void {
    if (!this.started || this.stopped) return
    if (this.clients > 0 || this.deps.pendingPromptChats().length === 0) {
      this.cancelApproval()
      return
    }
    // Already holding: never reset the window on an unrelated chat event.
    if (this.approvalHeld) return
    this.approvalHeld = true
    this.approval.arm()
  }

  private cancelApproval(): void {
    this.approval.cancel()
    this.approvalHeld = false
  }

  private onApprovalExpired(): void {
    if (this.stopped) return
    this.approvalHeld = false
    for (const chatId of [...this.deps.pendingPromptChats()]) {
      // Record the call as denied (approval/plan/sudo), then end the turn so a
      // blocked no-client turn can never sit forever (D10).
      try {
        this.deps.denyPending(chatId)
      } catch (err) {
        // contained
        log.error("denyPending failed on approval timeout", { err, chatId })
      }
      try {
        this.deps.abortTurn(chatId, "approval-timeout")
      } catch (err) {
        // contained
        log.error("abortTurn failed on approval timeout", { err, chatId })
      }
    }
    // Retry if a prompt somehow survived, then let the idle clock run.
    this.armApprovalIfNeeded()
    this.armGraceIfIdle()
  }

  /** Deny an orphaned prompt; abort only when nothing could be denied (plan/ask). */
  private resolveOrphan(chatId: string): void {
    let denied = false
    try {
      denied = this.deps.denyPending(chatId)
    } catch (err) {
      denied = false
      log.error("denyPending failed on orphaned prompt", { err, chatId })
    }
    if (denied) return
    try {
      this.deps.abortTurn(chatId, "prompt-orphaned")
    } catch (err) {
      // contained
      log.error("abortTurn failed on orphaned prompt", { err, chatId })
    }
  }

  private shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    this.grace.cancel()
    this.cancelApproval()
    try {
      this.deps.shutdown()
    } catch (err) {
      // The policy must never crash the daemon.
      log.error("shutdown callback failed", { err })
    }
  }
}
