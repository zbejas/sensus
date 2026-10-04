/**
 * Durable-history reconstruction for the Context inspector (docs/agent.md
 * "Context inspector"). A saved transcript persists tool calls as their own
 * `tool_call` events, but the durable provider history rebuilt on resume keeps
 * only plain text (a v1 limitation — tool results are persisted as previews,
 * not the bytes the model saw). The inspector should still show what the
 * session did, so this turns a `LoadedSession` into the same role/preview/token
 * rows the live inspector paints, tool calls included.
 *
 * Shared by `ChatHost.sessionContextBreakdown` (a saved session opened from the
 * Usage Dashboard) and the resumed tab (`ChatSession.restore`), so both views
 * agree on the shape and token estimates.
 */

import { estimateImageTokens } from "../../core/image.ts"
import type { LoadedSession, LoadedToolCall } from "../../session/store.ts"
import { messagePreview, type ContextHistoryEntry } from "../../engine/chat/contextInspector.ts"
import { estTokens } from "./compaction.ts"

/** Token estimate for a group of persisted tool calls (name + summarized params). */
export function callListTokens(calls: readonly { name: string; paramsSummary: string }[]): number {
  let n = 0
  for (const c of calls) n += estTokens(c.name) + estTokens(c.paramsSummary) + 8
  return n
}

/**
 * Reconstruct the durable-history rows for a saved transcript: the checkpoint
 * (when present) plus each record after `checkpointIndex`, with persisted tool
 * calls grouped onto the record they followed. An assistant turn whose bubble
 * was dropped (no text/thinking) surfaces as its own tool-call row — the same
 * way the live provider history would carry it. A call attached to a record
 * inside the summarized prefix is skipped (the checkpoint already covers it).
 */
export function reconstructHistoryEntries(loaded: LoadedSession): ContextHistoryEntry[] {
  const callsByIndex = new Map<number, LoadedToolCall[]>()
  for (const c of loaded.toolCalls) {
    if (c.afterMessage < loaded.checkpointIndex) continue
    const list = callsByIndex.get(c.afterMessage)
    if (list) list.push(c)
    else callsByIndex.set(c.afterMessage, [c])
  }
  const history: ContextHistoryEntry[] = []
  if (loaded.checkpoint !== null) {
    history.push({ role: "system", preview: "[compaction summary]", tokens: estTokens(loaded.checkpoint) + 4 })
  }
  for (let i = loaded.checkpointIndex; i < loaded.messages.length; i++) {
    const m = loaded.messages[i]
    if (m === undefined) continue
    const calls = callsByIndex.get(i) ?? []
    const imageCount = m.images?.length ?? 0
    const imageTokens = m.images?.reduce((s, a) => s + estimateImageTokens(a), 0) ?? 0
    if (m.role === "user") {
      history.push({
        role: m.role,
        preview: messagePreview(m.content, [], imageCount),
        tokens: estTokens(m.content) + 4 + imageTokens,
      })
      // The assistant bubble for this turn was dropped (no text/thinking), so
      // its tool calls follow the user record — surface them as the assistant
      // turn they belonged to.
      if (calls.length > 0) {
        history.push({
          role: "assistant",
          preview: messagePreview("", calls.map((c) => c.name)),
          tokens: 4 + callListTokens(calls),
        })
      }
    } else {
      history.push({
        role: m.role,
        preview: messagePreview(m.content, calls.map((c) => c.name), imageCount),
        tokens: estTokens(m.content) + 4 + imageTokens + callListTokens(calls),
      })
    }
  }
  return history
}
