/**
 * Pure message-text helpers for the chat sidebar: fenced-code re-rendering and
 * the one-line image chip. No Solid/opentui runtime imports — unit-testable.
 */

import { renderMarkdown, wrapLines, type MdLine } from "../../engine/index.ts"
import { truncateWithEllipsis } from "../../core/util.ts"
import { formatBytes, type ImageAttachment } from "../../core/image.ts"

/** Fenced-code rows (unchanged rendering — wrap + copy affordance) for the
 * segment view; the fence is re-fed through the markdown renderer so code
 * block rows stay byte-identical with the pre-M9 layout. */
export function fenceRows(seg: { kind: "fence"; code: string; lang: string }, w: number): MdLine[] {
  const md = renderMarkdown(`\`\`\`${seg.lang}\n${seg.code}\n\`\`\``)
  return wrapLines(md, w)
}

/** One-line image chip summary for a message bubble (non-interactive). Width-1
 * glyphs only, so the row padding stays cell-accurate. */
export function imageChipText(images: readonly ImageAttachment[], width: number): string {
  const text = images.map((a) => `▣ ${a.name} · ${formatBytes(a.bytes)}`).join("  ")
  return truncateWithEllipsis(text, Math.max(0, width - 1))
}
