/**
 * attachPicker — list the daemon's live shells/chats for the boot re-attach
 * picker (P4c; D4). The TUI does not own anything on disk any more, so on boot
 * it asks the daemon what is already running and offers to re-attach instead of
 * starting from scratch.
 *
 * Pure transport: it issues `terminal.list` / `chat.list` over the client and
 * reduces the two lists into one presentable candidate list. Every call is
 * defensive — a missing/unreachable daemon yields an empty list, never a throw.
 */

import type { ChatListEntry, ShellListEntry } from "../daemon/index.ts"
import type { WsClient } from "./wsClient.ts"

/** One re-attachable thing offered at boot. */
export interface AttachCandidate {
  kind: "shell" | "chat"
  /** The shell id or chat id (used by the caller to attach/open). */
  id: string
  /** The chat's bound shell, or the shell's own id. */
  shellId: string | null
  /** A human label (chat title, else a short id). */
  title: string
  /** `chat.status` for a chat; `"alive"`/`"dead"` for a shell. */
  status: string
  /** Whether a client is already attached/observing (server state). */
  attached: boolean
  /** Whether the underlying shell is alive (always true for chats). */
  alive: boolean
  /** A chat with no messages yet. It has nothing to resume, but the pane's
   * shell is still live, so a lone one is re-attached silently rather than
   * abandoned. Always false for a bare shell. */
  empty: boolean
  /** Epoch ms the pane was last inactive (lost its last client), or null when
   * unknown. Used to age-gate re-attach. */
  lastDetachedAt: number | null
}

export interface AttachListResult {
  shells: ShellListEntry[]
  chats: ChatListEntry[]
  candidates: AttachCandidate[]
}

/**
 * The tab-engine attach target: the daemon shell to re-attach and its bound
 * chat (null = open a fresh chat on that shell), plus an optional title.
 * `bootPicker.candidateTarget` maps a chosen candidate onto this shape.
 */
export interface AttachTarget {
  shellId: string
  chatId: string | null
  title?: string
}

/** Fetch the live shells; [] on any error. */
export async function listShells(ws: WsClient): Promise<ShellListEntry[]> {
  try {
    const result = await ws.terminal.list()
    return Array.isArray(result.shells) ? result.shells : []
  } catch {
    return []
  }
}

/** Fetch the live chats; [] on any error. */
export async function listChats(ws: WsClient): Promise<ChatListEntry[]> {
  try {
    const result = await ws.chat.list()
    return Array.isArray(result.chats) ? result.chats : []
  } catch {
    return []
  }
}

/**
 * The boot picker's data: shells and chats plus a flat, ordered candidate list.
 * Shells with no bound chat come first (the common re-attach case), then chats
 * with content, then unsent ("empty") chats last. Every unattended live pane is
 * a candidate, including an unsent chat: the pane's shell is still live, so it
 * is never abandoned — but it is marked `empty` and sorted after real sessions
 * so it cannot be mistaken for one (docs/daemon-api.md "Lifecycle").
 *
 * `maxAgeMs` (default 0 = no limit) drops candidates inactive longer than the
 * re-attach window, so a session from a previous workday is never offered. The
 * daemon's idle reaper kills such shells anyway; this is the client-side
 * defense-in-depth guard against a race (a picker shown between daemon boot and
 * the first reap tick).
 */
export async function listAttachCandidates(ws: WsClient, maxAgeMs = 0): Promise<AttachListResult> {
  const [shells, chats] = await Promise.all([listShells(ws), listChats(ws)])
  // Only UNATTENDED live shells are re-attachable (D4): a shell another client
  // currently controls (or a dead one) must not block a fresh boot.
  const attachable = new Set(shells.filter((s) => s.alive && !s.attached).map((s) => s.shellId))
  const shellById = new Map(shells.map((s) => [s.shellId, s]))
  const chatShells = new Set(chats.map((c) => c.shellId).filter((id): id is string => id !== null))

  // A candidate is too old when its pane has been inactive past the window.
  const tooOld = (lastDetachedAt: number | null): boolean =>
    maxAgeMs > 0 && lastDetachedAt !== null && Date.now() - lastDetachedAt > maxAgeMs

  const candidates: AttachCandidate[] = []
  const chatCandidates: AttachCandidate[] = []
  const emptyCandidates: AttachCandidate[] = []
  for (const shell of shells) {
    if (!attachable.has(shell.shellId)) continue
    if (chatShells.has(shell.shellId)) continue
    if (tooOld(shell.lastDetachedAt)) continue
    candidates.push({
      kind: "shell",
      id: shell.shellId,
      shellId: shell.shellId,
      title: shell.cwd ?? shell.shellId,
      status: "alive",
      attached: false,
      alive: true,
      empty: false,
      lastDetachedAt: shell.lastDetachedAt,
    })
  }
  for (const chat of chats) {
    // A chat bound to a dead or currently-controlled shell is not re-attachable.
    if (chat.shellId === null || !attachable.has(chat.shellId)) continue
    if (tooOld(chat.lastDetachedAt)) continue
    // An unsent tab ("empty session") has nothing to resume — but its pane is
    // live, so it is still a candidate (marked `empty`) rather than abandoned.
    const shell = shellById.get(chat.shellId)
    const row: AttachCandidate = {
      kind: "chat",
      id: chat.chatId,
      shellId: chat.shellId,
      title: chat.title.length > 0 ? chat.title : shell?.cwd ?? chat.chatId,
      status: chat.status,
      attached: false,
      alive: true,
      empty: chat.empty,
      lastDetachedAt: chat.lastDetachedAt,
    }
    if (chat.empty) emptyCandidates.push(row)
    else chatCandidates.push(row)
  }
  candidates.push(...chatCandidates, ...emptyCandidates)
  return { shells, chats, candidates }
}
