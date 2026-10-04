/**
 * M6 prefix mode (tmux muscle memory, docs/keybindings.md): pressing the
 * prefix key (default Ctrl+A, keymap action "prefix") opens a short window
 * (~1s, status-bar hint). The next key decides:
 *
 *   `d`           -> detach sensus (the daemon keeps the shells and any
 *                    running turn alive; re-attach on the next boot)
 *   any other key -> terminal focus: the pane receives PREFIX + that key
 *                    (readline C-a, C-a a, C-a C-a, ... keep working)
 *                  -> chat focus: the prefix is canceled and the key behaves
 *                    normally in the chat
 *   timeout       -> terminal focus: the pane receives plain PREFIX
 *                  -> chat focus: cancel (the pane is not focused — nothing
 *                    is sent)
 *
 * Pure module — no opentui/solid imports (unit-tested in
 * tests/unit/ui/chat/prefix.test.ts). App wires the decisions to the PTY /
 * exit.
 */

import { mapKeyEventToAction, type KeyAction, type KeyInfo } from "../../terminal/keys.ts"

/** How long the prefix window stays open (ms). tmux defaults to 500ms; a
 * JS TUI adds a frame or two of latency, so we allow a little more. */
export const PREFIX_WINDOW_MS = 1000

/** The detach key inside the prefix window (tmux binds lowercase `d`). */
export const PREFIX_DETACH_KEY = "d"

export type PrefixDecision =
  /** Detach the UI (prefix+d; the daemon keeps the shells and turns alive). */
  | { action: "detach" }
  /** Send the raw PREFIX to the pane, then the key's own mapping (may be
   * null for keys tmux cannot represent — PREFIX alone is still sent). */
  | { action: "send-to-pane"; prefix: KeyAction; followup: KeyAction | null }
  /** Chat focus: cancel the prefix and handle the key normally. */
  | { action: "pass-through" }
  /** Chat focus timeout: cancel silently (the pane is not focused). */
  | { action: "ignore" }

/** The bare prefix as a send-keys action (Ctrl+A by keymap default). */
export function prefixKeyAction(): KeyAction {
  return { kind: "keys", names: ["C-A"] }
}

/**
 * The key routing table (unit-tested). `phase` distinguishes a real second
 * key from the window expiring with no key. `prefixAction` is what a
 * pass-through sends to the pane — the ACTUAL prefix byte the user pressed
 * (C-a with the default binding; a custom keymap prefix sends itself).
 */
export function resolvePrefixEvent(
  key: KeyInfo,
  focus: "terminal" | "sidebar",
  phase: "second-key" | "timeout",
  detachKey: string = PREFIX_DETACH_KEY,
  prefixAction: KeyAction = prefixKeyAction(),
): PrefixDecision {
  if (phase === "timeout") {
    return focus === "terminal"
      ? { action: "send-to-pane", prefix: prefixAction, followup: null }
      : { action: "ignore" }
  }
  if (!key.ctrl && !key.meta && key.name.toLowerCase() === detachKey.toLowerCase()) {
    return { action: "detach" }
  }
  if (focus === "terminal") {
    return { action: "send-to-pane", prefix: prefixAction, followup: mapKeyEventToAction(key) }
  }
  return { action: "pass-through" }
}

export interface PrefixMachineOptions {
  /** Prefix window duration (ms). */
  windowMs?: number
  /** Fired on timeout with the focus at arm time. */
  onTimeout?: (focus: "terminal" | "sidebar") => void
  /** The pass-through action for the prefix key itself (see
   * resolvePrefixEvent). */
  prefixAction?: KeyAction
  /** Clock seams (tests): schedule captures the callback, unschedule cancels. */
  schedule?: (fn: () => void, ms: number) => unknown
  unschedule?: (handle: unknown) => void
}

/**
 * Armed/idle state + timer. The clock is injectable so tests can fire the
 * timeout deterministically (schedule captures the callback instead of the
 * event loop running it).
 */
export class PrefixMachine {
  private armed = false
  private timer: unknown = null

  readonly windowMs: number
  private readonly onTimeout: (focus: "terminal" | "sidebar") => void
  private readonly prefixAction: KeyAction
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly unschedule: (handle: unknown) => void

  constructor(opts: PrefixMachineOptions = {}) {
    this.windowMs = opts.windowMs ?? PREFIX_WINDOW_MS
    this.onTimeout = opts.onTimeout ?? (() => {})
    this.prefixAction = opts.prefixAction ?? prefixKeyAction()
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms)
      })
    this.unschedule =
      opts.unschedule ??
      ((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>)
      })
  }

  get isArmed(): boolean {
    return this.armed
  }

  /** The prefix key was pressed. Re-pressing while armed refreshes the
   * window (tmux re-arms the same way). */
  arm(focus: "terminal" | "sidebar"): void {
    this.cancelTimer()
    this.armed = true
    const fire = (): void => {
      this.timer = null
      if (!this.armed) return
      this.armed = false
      this.onTimeout(focus)
    }
    this.timer = this.schedule(fire, this.windowMs)
  }

  /** A second key arrived while armed. Returns the routing decision and
   * disarms. When idle the key is not consumed (cancel). */
  secondKey(
    key: KeyInfo,
    focus: "terminal" | "sidebar",
  ): PrefixDecision {
    if (!this.armed) return { action: "pass-through" }
    this.disarm()
    return resolvePrefixEvent(key, focus, "second-key", PREFIX_DETACH_KEY, this.prefixAction)
  }

  /** Cancel without side effects (paste, overlay, teardown, re-entry). */
  disarm(): void {
    this.cancelTimer()
    this.armed = false
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.unschedule(this.timer)
      this.timer = null
    }
  }
}
