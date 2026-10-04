/**
 * bootPicker — pure reductions for the two boot pickers (P4c; D4) that the
 * TUI now presents as in-app windows instead of taking over the terminal in
 * their own renderer.
 *
 * The DATA fetch (daemon shells/chats, on-disk sessions) still happens before
 * the app boots — it needs the daemon transport and the session dir — but the
 * user's CHOICE is made in App, over the live layout, exactly like Settings.
 * These helpers keep the "do we even ask?" decision and the candidate→target
 * mapping out of the components so they can be unit-tested without a renderer.
 */

import type { AttachCandidate, AttachTarget } from "./attachPicker.ts"

/**
 * The tab-engine attach target for a chosen candidate (or the lone
 * auto-attached one). The chat id is the candidate's own id only when it is a
 * chat; a bare shell opens a fresh chat bound to that shell.
 */
export function candidateTarget(choice: AttachCandidate): AttachTarget {
  const shellId = choice.shellId ?? choice.id
  return {
    shellId,
    chatId: choice.kind === "chat" ? choice.id : null,
    ...(choice.title.length > 0 ? { title: choice.title } : {}),
  }
}

/**
 * The target to auto-attach WITHOUT asking, or null when the boot must ask (or
 * start fresh).
 *
 *  - 0 candidates → null (nothing to re-attach; boot a fresh tab).
 *  - 1 candidate → attach it silently. The common case is the user having
 *    detached one tab, and a lone "empty" pane (a shell with no messages) must
 *    be kept rather than abandoned.
 *  - ≥2 candidates → null (App opens the picker window so the user chooses).
 *
 * `maxAgeMs` is a no-op here (the data was already age-gated); kept as a
 * parameter so both callers share the same reduction.
 */
export function loneAttachTarget(candidates: readonly AttachCandidate[]): AttachTarget | null {
  if (candidates.length === 1) return candidateTarget(candidates[0]!)
  return null
}

/** Whether the boot attach picker window must be shown (a real choice exists). */
export function shouldAskAttach(candidates: readonly AttachCandidate[]): boolean {
  return candidates.length >= 2
}
