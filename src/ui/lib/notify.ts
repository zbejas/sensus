/**
 * Desktop notifications (phase 4.3): decide WHEN to alert (a reply finished, an
 * approval is waiting) and emit a terminal escape the emulator can turn into an
 * OS notification. Pure + unit-tested; the App writes the returned sequence.
 */

export type NotifyMode = "bell" | "osc777"

export type NotifyReason = "finished" | "approval"

export interface NotifyState {
  /** The active chat is streaming a reply. */
  streaming: boolean
  /** A tool approval card is waiting for the user. */
  pendingApproval: boolean
}

export interface NotifyPolicy {
  enabled: boolean
  /** Alert when a reply finishes while the user is elsewhere. */
  onFinish: boolean
  /** Alert when an approval card appears. */
  onApproval: boolean
}

/**
 * The escape sequence for a reason. `bell` is the plain BEL; `osc777` is the
 * widely-supported `\x1b]777;notify;<title>;<body>\x07` (iTerm2/WezTerm/kitty).
 */
export function notifySequence(mode: NotifyMode, title: string, body: string): string {
  if (mode === "bell") return "\x07"
  const clean = (s: string): string => s.replace(/[\x07\x1b;]/g, " ").slice(0, 200)
  return `\x1b]777;notify;${clean(title)};${clean(body)}\x07`
}

/**
 * Decide whether a state transition deserves an alert. Returns the reason or
 * null. Only the transition matters: a reply that was streaming and stopped,
 * or an approval that newly appeared. A user already looking at the overlay is
 * not alerted for approvals (the card is in front of them).
 */
export function decideNotification(
  prev: NotifyState,
  next: NotifyState,
  policy: NotifyPolicy,
  opts: { overlayOpen: boolean },
): NotifyReason | null {
  if (!policy.enabled) return null
  if (policy.onFinish && prev.streaming && !next.streaming && !next.pendingApproval) return "finished"
  if (policy.onApproval && !prev.pendingApproval && next.pendingApproval && !opts.overlayOpen) return "approval"
  return null
}
