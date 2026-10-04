/**
 * Input-area rows for the chat sidebar: draft image chips, the editor rows and
 * the slash-autocomplete rows. Kept in their own module so ChatSidebar owns
 * only the scrollbox wiring and the render tree.
 */

import { type JSX } from "@opentui/solid"
import { MouseButton, type MouseEvent } from "@opentui/core"
import { createMemo, For } from "solid-js"
import { theme, type ThemeColor } from "../../../theme/theme.ts"
import { blinkOn } from "../../lib/blink.ts"
import { truncateWithEllipsis } from "../../../core/util.ts"
import type { ImageAttachment } from "../../../core/image.ts"
import type { SlashCommandInfo } from "../../../agent/slash.ts"
import { leftClickColumn, regionAt } from "../../lib/clickTarget.ts"
import { bgStyle } from "../../chat/chatRowStyle.ts"

/**
 * Draft attachment chips above the input rows: `▣ name ×` per image, the ×
 * clickable to remove. Same one-text + column-map pattern as the other chrome
 * rows (ui/lib/clickTarget.ts); only width-1 glyphs keep the map accurate, so
 * `×` (U+00D7, Latin-1, covered by every monospace font) — not `✕`.
 */
export function DraftImageRow(props: {
  images: ImageAttachment[]
  rowWidth: number
  onRemove: (id: string) => void
}): JSX.Element {
  const t = () => theme()
  const view = createMemo(() => {
    const spans: Array<{ text: string; fg: ThemeColor; bold: boolean }> = []
    const removes: Array<{ start: number; length: number; id: string }> = []
    let col = 0
    const push = (text: string, fg: ThemeColor, bold = false): void => {
      spans.push({ text, fg, bold })
      col += [...text].length
    }
    push(" attach ", t().muted)
    let overflow = false
    for (const img of props.images) {
      const label = `▣ ${truncateWithEllipsis(img.name, 14)} `
      if (col + [...label].length + 3 > Math.max(0, props.rowWidth - 1)) {
        overflow = true
        break
      }
      push(label, t().fg, true)
      const start = col
      push("×", t().danger)
      removes.push({ start, length: 1, id: img.id })
      push("  ", t().muted)
    }
    if (overflow) push("…", t().muted)
    const w = Math.max(0, props.rowWidth - col)
    if (w > 0) push(" ".repeat(w), t().fg)
    return { spans, removes }
  })
  return (
    <text
      selectable={false}
      style={{ fg: t().fg, ...bgStyle(t()) }}
      onMouseDown={(e: MouseEvent) => {
        const col = leftClickColumn(e)
        if (col === null) return
        const idx = regionAt(view().removes, col)
        if (idx !== null) props.onRemove(view().removes[idx]!.id)
      }}
    >
      <For each={view().spans}>
        {(s) => <span style={{ fg: s.fg, bold: s.bold, bg: t().bg ?? "transparent" }}>{s.text}</span>}
      </For>
    </text>
  )
}

export function InputRow(props: {
  text: string
  isCursor: boolean
  cursorCol: number
  focused: boolean
  placeholder: string
  /** Width the row must cover (content width) — see the pad invariant below. */
  rowWidth: number
  onMouseDown?: (e: MouseEvent) => void
}): JSX.Element {
  const t = () => theme()
  // Reactive by design (M7 fix): the row's span list is ONE memo over every
  // prop — components run once in Solid, so branching on props in the body
  // (the old code) froze the row until its TEXT changed: the caret cell never
  // moved and kept its accent background after focus left (stale paint).
  // Fresh span objects every recompute force opentui to repaint them all.
  // Every span SETS bg explicitly (M5 rule: a disappearing style prop does
  // not reset); the pad keeps the row at a fixed cell budget so vacated
  // cells are repainted too. bg is "transparent" in the terminal theme.
  //
  // Blink (M8): the caret cell reads the shared blink phase — ON = accent
  // block, OFF = the plain char. Fresh objects either way so the cell
  // repaints on every toggle; blinkActivity() (App key/paste routing, input
  // clicks) holds it solid while typing.
  const spans = createMemo<Array<{ text: string; fg: ThemeColor; bg?: ThemeColor }>>(() => {
    const chars = [...props.text]
    const out: Array<{ text: string; fg: ThemeColor; bg?: ThemeColor }> = []
    const pad = (used: number): void => {
      const w = Math.max(0, props.rowWidth - used)
      if (w > 0) out.push({ text: " ".repeat(w), fg: t().fg })
    }
    if (props.isCursor && props.focused) {
      const col = Math.min(props.cursorCol, chars.length)
      const before = chars.slice(0, col).join("")
      const cursorCh = chars[col] ?? " "
      const after = chars.slice(col + 1).join("")
      if (before.length > 0) out.push({ text: before, fg: t().fg })
      out.push(
        blinkOn()
          ? { text: cursorCh, fg: t().onAccent, bg: t().accent }
          : { text: cursorCh, fg: t().fg },
      )
      if (after.length > 0) out.push({ text: after, fg: t().fg })
      pad(chars.length + (col === chars.length ? 1 : 0))
    } else if (chars.length === 0 && props.placeholder.length > 0) {
      out.push({ text: props.placeholder, fg: t().muted })
      pad([...props.placeholder].length)
    } else {
      if (chars.length > 0) out.push({ text: props.text, fg: t().fg })
      pad(chars.length)
    }
    return out
  })
  return (
    <text selectable={false} style={{ fg: t().fg, ...bgStyle(t()) }} onMouseDown={props.onMouseDown}>
      <For each={spans()}>
        {(s) => <span style={{ fg: s.fg, bg: s.bg ?? (t().bg ?? "transparent") }}>{s.text}</span>}
      </For>
    </text>
  )
}

/**
 * One autocomplete row (M8): `❯ /name  description`, padded to the full row
 * width. Same invariants as InputRow (M5/M7): the span list is ONE memo over
 * every prop (components run once in Solid), every span SETS fg and bg
 * explicitly (a disappearing style prop does not reset), and the pad keeps a
 * fixed cell budget so vacated cells repaint when the selection moves. Bg is
 * the overlay panel color (theme cardBg) — the menu floats over message rows,
 * so every cell must paint the opaque panel or the text underneath bleeds
 * through. Selection stays fg-only (❯ marker + accent).
 */
export function SlashMenuRow(props: {
  cmd: SlashCommandInfo
  selected: boolean
  /** Width the row must cover (content width) — fixed cell budget. */
  rowWidth: number
  onPick: (name: string) => void
}): JSX.Element {
  const t = () => theme()
  const spans = createMemo<Array<{ text: string; fg: ThemeColor; bold: boolean }>>(() => {
    const name = `/${props.cmd.name}`
    // Description budget: marker (2) + name + gap (2); truncate with "…".
    const budget = Math.max(0, props.rowWidth - name.length - 4)
    const shown = truncateWithEllipsis(props.cmd.description, budget)
    const out: Array<{ text: string; fg: ThemeColor; bold: boolean }> = [
      { text: props.selected ? "❯ " : "  ", fg: props.selected ? t().accent : t().muted, bold: false },
      { text: name, fg: t().accent, bold: props.selected },
      { text: "  ", fg: t().muted, bold: false },
    ]
    if (shown.length > 0) out.push({ text: shown, fg: props.selected ? t().fg : t().muted, bold: false })
    const used = 2 + name.length + 2 + [...shown].length
    const w = Math.max(0, props.rowWidth - used)
    if (w > 0) out.push({ text: " ".repeat(w), fg: t().muted, bold: false })
    return out
  })
  return (
    <text selectable={false} style={{ fg: t().fg, bg: t().cardBg ?? "transparent" }} onMouseDown={(e: MouseEvent) => { if (e.button === MouseButton.LEFT) props.onPick(props.cmd.name) }}>
      <For each={spans()}>
        {(s) => <span style={{ fg: s.fg, bold: s.bold, bg: t().cardBg ?? "transparent" }}>{s.text}</span>}
      </For>
    </text>
  )
}
