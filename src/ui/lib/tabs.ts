/**
 * Tab registry semantics: one tab = one native PTY
 * session + its chat session. This module holds the pure decision logic over
 * an ordered id list; Solid state lives in ui/store.ts.
 */

import type { TabView } from "./store.ts"
import type { BarTone } from "./bar.ts"
import { spinnerChar } from "./spinner.ts"

/** Which tab gets focus when `closedId` is removed from the ordered list. */
export function nextActiveOnClose(ids: readonly number[], closedId: number): number | null {
  const idx = ids.indexOf(closedId)
  if (idx === -1 || ids.length <= 1) return null
  // Prefer the left neighbor; fall back to the right neighbor.
  return ids[idx - 1] ?? ids[idx + 1] ?? null
}

/** Cycle to the previous/next tab in list order (wraps around). */
export function cycleTabs(ids: readonly number[], currentId: number, dir: "prev" | "next"): number | null {
  if (ids.length === 0) return null
  const idx = ids.indexOf(currentId)
  const i = idx === -1 ? 0 : idx
  const delta = dir === "next" ? 1 : -1
  const n = ids.length
  return ids[(i + delta + n) % n] ?? null
}

/** Jump to the Nth tab (1-based, Alt+1..9); null when it does not exist. */
export function tabAtPosition(ids: readonly number[], position: number): number | null {
  if (position < 1) return null
  return ids[position - 1] ?? null
}

/**
 * The tab's display title (docs/sessions.md "Auto titles"): the chat session's
 * title — the auto/manual session title, or the derived first-user-message
 * placeholder while it generates — when set, else the store fallback (the
 * shell basename). Reads the session-title signal, so a caller inside a
 * reactive scope re-renders when the title changes.
 */
export function tabTitle(tab: TabView): string {
  const title = tab.chat.accessors.sessionTitle()
  return title.length > 0 ? title : tab.title
}

/**
 * The shared "which tab needs me?" activity marker for a tab (docs/DESIGN.md
 * "Tab bar"): null when the tab is quiet, else one glyph — `!` in the warning
 * tone while an approval is pending (an action is needed, not just progress),
 * else the shared streaming spinner in the accent. Used by both the horizontal
 * `TabBar` and the vertical `TabRail`.
 */
export function tabActivity(tab: TabView): { glyph: string; tone: BarTone } | null {
  const status = tab.chat.accessors.status()
  if (status !== "streaming") return null
  // Approval outranks streaming: an action is needed, not just progress.
  if (tab.chat.pendingApproval() !== null) return { glyph: "!", tone: "warning" }
  return { glyph: spinnerChar(tab.chat.accessors.animations()), tone: "accent" }
}
