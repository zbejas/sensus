/**
 * Pure selectors for the keyboard equivalents of the mouse-only chat row
 * actions (docs/keybindings.md "Click targets"): `⧉ copy` on a message label,
 * `↺ revert` on a user label, and the whole-block send for a fenced code block
 * (per-line click-to-paste is pointer-only).
 *
 * There is no per-message focus model, so the keyboard actions act on the
 * newest relevant target: the newest non-empty message, the newest user turn,
 * and the newest fenced code block. App owns the wiring (clipboard, rewind
 * confirmation, pane send); these helpers only choose the target so they can
 * be unit-tested without a renderer.
 */

import type { ChatMessage } from "../../../agent/chat/chatMessages.ts"
import { segmentAssistantSpans } from "../../chat/chatLayout.ts"

/** Raw text of the newest message with non-empty content (null when none). */
export function lastMessageText(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content ?? ""
    if (content.length > 0) return content
  }
  return null
}

/** Id of the newest user message (the revert target), or null when none. */
export function lastUserMessageId(messages: readonly ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg !== undefined && msg.role === "user") return msg.id
  }
  return null
}

/**
 * Code of the newest non-empty fenced block, searched newest-message-first and
 * last-fence-within-a-message. Only assistant content is segmented into
 * clickable fences (docs/ui.md "Prose vs. code"), so only assistant messages
 * are considered. Null when the transcript has no code block.
 */
export function lastCodeBlock(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined || msg.role !== "assistant") continue
    let found: string | null = null
    for (const span of segmentAssistantSpans(msg.content)) {
      if (span.seg.kind === "fence" && span.seg.code.trim().length > 0) found = span.seg.code
    }
    if (found !== null) return found
  }
  return null
}
