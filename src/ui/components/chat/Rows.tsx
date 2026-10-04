/**
 * Shared chat message rows: segment spans, interactive/plain rows, code copy
 * rows, card action rows, message label rows and the agent chip. ChatSidebar's
 * message list is rendered through these; MessageBlock composes them.
 */

import { type JSX } from "@opentui/solid"
import { MouseButton, type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, onCleanup, Show, For } from "solid-js"
import { theme, type ThemeColor } from "../../../theme/theme.ts"
import { labelCopyAffordance, labelRevertAffordance, type CardAction } from "../../chat/chatLayout.ts"
import type { MdLine, Seg, SegStyle } from "../../../agent/markdown.ts"
import { eventCell, leftClickColumn, regionAt } from "../../lib/clickTarget.ts"
import { codeClickAction, PRESS_HOLD_MS, rowFx, spanAttrs, type CodeClickState, type RowFx } from "../../chat/chatRowStyle.ts"

function SegView(props: { seg: Seg; bg: ThemeColor | null; fgOverride?: ThemeColor }): JSX.Element {
  const attrs = createMemo(() => spanAttrs(props.seg.style, theme()))
  const href = createMemo(() => props.seg.style.href)
  const style = createMemo(() => ({
    ...attrs(),
    fg: props.fgOverride ?? attrs().fg,
    bg: props.bg ?? "transparent",
  }))
  // A link segment renders through opentui's `<a>` (OSC-8 hyperlink); every
  // other segment is a plain span. Terminals without hyperlink support still
  // show the styled label + the dim URL beside it.
  return (
    <Show when={href()} fallback={<span style={style()}>{props.seg.text}</span>}>
      <a href={href() ?? ""} style={style()}>
        {props.seg.text}
      </a>
    </Show>
  )
}

/**
 * Shared row shell: one <text> whose mousedown handler is the only per-row
 * variation (plain render / code copy / card action). Left button only —
 * right-click is the selection-copy trigger. `bg` is the card surface
 * (theme cardBg, or null → transparent) so row fills match the card they sit
 * in (an explicit bg on every span is required: a disappearing style prop
 * does not reset).
 *
 * Hover/press feedback (docs/DESIGN.md "Motion"): a row with a mousedown
 * handler highlights under the pointer (selection fill) and flashes the accent
 * block on press. Non-interactive rows (RowText) never bind the handlers.
 *
 * `selectable` is off for interactive rows: opentui starts a text selection on
 * every left mousedown over a selectable <text>, so a button would both fire
 * its action AND begin a selection. Non-interactive body rows stay selectable.
 */
function InteractiveRow(props: {
  line: MdLine
  bg: string | null
  onMouseDown?: (e: MouseEvent) => void
}): JSX.Element {
  const t = () => theme()
  const interactive = (): boolean => props.onMouseDown !== undefined
  const [fx, setFx] = createSignal<RowFx>("idle")
  // Whether the pointer actually entered this row. The press flash restores
  // hover only when it did: opentui targets `out` at a possibly-stale
  // lastOverRenderable, so a click with no prior `over` (or a row that is
  // re-created mid-click) can miss `out` — restoring hover unconditionally
  // would then leave a stuck selection fill.
  const [over, setOver] = createSignal(false)
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  const clearPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  onCleanup(clearPress)
  const view = createMemo(() => rowFx(t(), fx(), props.bg))
  const pressed = (): boolean => fx() === "press"
  return (
    <text
      selectable={!interactive()}
      style={{ fg: view().fg ?? t().fg, bg: view().bg }}
      onMouseOver={() => {
        if (interactive()) {
          setOver(true)
          setFx("hover")
        }
      }}
      onMouseOut={() => {
        setOver(false)
        clearPress()
        setFx("idle")
      }}
      onMouseDown={(e: MouseEvent) => {
        if (interactive()) {
          clearPress()
          setFx("press")
          pressTimer = setTimeout(() => {
            pressTimer = null
            setFx(over() ? "hover" : "idle")
          }, PRESS_HOLD_MS)
        }
        props.onMouseDown?.(e)
      }}
    >
      <For each={props.line.segs}>
        {(seg) => <SegView seg={seg} bg={view().bg} fgOverride={pressed() ? t().onAccent : undefined} />}
      </For>
    </text>
  )
}

export function RowText(props: { line: MdLine; bg: string | null }): JSX.Element {
  return <InteractiveRow line={props.line} bg={props.bg} />
}

/** A code row: a single click pastes that command into the visible pane (no
 * Enter); a second click within the double-click window presses Enter to run
 * what the first click pasted (M3, docs/ui.md "Prose vs. code"). */
export function CopyableRow(props: {
  line: MdLine
  bg: string | null
  onCodeClick: (code: string, run: boolean) => void
}): JSX.Element {
  let lastClick: CodeClickState | null = null
  return (
    <InteractiveRow
      line={props.line}
      bg={props.bg}
      onMouseDown={(e: MouseEvent) => {
        if (e.button !== MouseButton.LEFT) return
        // Read the line at CLICK time: a streaming fence grows after mount, so
        // a value captured at creation would paste a stale partial line.
        const code = props.line.copyLine ?? ""
        if (code.length === 0) return
        const { action, next } = codeClickAction(lastClick, code, Date.now())
        lastClick = next
        props.onCodeClick(code, action === "run")
      }}
    />
  )
}

/** A card action row (one action per row) — the whole row is clickable
 * (left button only; a right-click must never resolve an approval). */
export function ActionRow(props: { line: MdLine; bg: string | null; actions: CardAction[]; onPick: (callId: string, kind: CardAction["kind"], optionIndex?: number) => void }): JSX.Element {
  return (
    <InteractiveRow
      line={props.line}
      bg={props.bg}
      onMouseDown={(e: MouseEvent) => {
        if (e.button !== MouseButton.LEFT) return
        // Read the action at CLICK time, NOT at creation: a row's action list
        // can change across renders (a thinking header's form flips between the
        // active `⠋ Thinking` and the settled `+ Thought for …`, though both
        // carry the toggle), so a captured `actions[0]` can go stale.
        const first = props.actions[0]
        if (first) props.onPick(first.callId, first.kind, first.optionIndex)
      }}
    />
  )
}

/**
 * One message label row (`❯ you`, `✱ model`, `⚠ error`) with the per-message
 * label affordances: `⧉ copy` after a two-space gap, and (user messages only)
 * `↺ revert` after copy. Geometry comes from chatLayout.labelCopyAffordance /
 * labelRevertAffordance; each is hidden when it does not fit, so a narrow
 * sidebar degrades to copy-only and then to a clean label. Click handling is
 * TabBar-style (M7): the row is ONE text element and the mouse column maps back
 * onto the rendered spans — only an affordance region triggers its action.
 * Same invariants as InputRow: the span list is ONE memo over every prop
 * (components run once; body-level geometry would freeze across sidebar
 * resizes), and every span SETS fg and bg explicitly (a disappearing style
 * prop does not reset; the terminal theme's bg is "transparent").
 *
 * The row is `selectable={false}`: a left mousedown on a selectable <text>
 * also starts a text selection, so clicking `⧉ copy`/`↺ revert` would select
 * the label.
 */
export function LabelRow(props: {
  text: string
  style: SegStyle
  contentWidth: number
  copyText: string
  bg: string | null
  onCopy?: (text: string) => void
  /** User messages: `↺ revert` (rewinds the chat to this message — App gates
   * it behind a confirmation while the agent is working). */
  onRevert?: () => void
}): JSX.Element {
  const t = () => theme()
  // Affordances in render order. Geometry is keyed on (label, width) only —
  // NOT on copyText: the label of a streaming assistant message must not
  // rebuild spans per stream delta. Visibility flips once when the content
  // appears, so the span list recomputes exactly once then.
  const affords = createMemo(() => {
    const out: Array<{ key: "copy" | "revert"; text: string; start: number; length: number }> = []
    const copy = labelCopyAffordance(props.text, props.contentWidth)
    if (copy !== null && props.copyText.length > 0) out.push({ key: "copy", ...copy })
    if (props.onRevert !== undefined) {
      const revert = labelRevertAffordance(props.text, props.contentWidth)
      if (revert !== null) out.push({ key: "revert", ...revert })
    }
    return out
  })
  // Hover/press feedback, keyed by affordance: the row can host copy AND
  // revert, and each highlights independently (InteractiveRow precedent).
  const [hoverKey, setHoverKey] = createSignal<string | null>(null)
  const [pressKey, setPressKey] = createSignal<string | null>(null)
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  const clearPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  onCleanup(clearPress)
  const view = createMemo(() => {
    const base = props.bg ?? "transparent"
    const spans: Array<{ text: string; style: Record<string, unknown> }> = [
      { text: props.text, style: { ...spanAttrs(props.style, t()), bg: base } },
    ]
    for (const a of affords()) {
      const fx: RowFx = pressKey() === a.key ? "press" : hoverKey() === a.key ? "hover" : "idle"
      const s = rowFx(t(), fx, props.bg)
      spans.push({ text: a.text, style: { fg: s.fg ?? t().muted, bg: s.bg } })
    }
    return spans
  })
  /** Which affordance does column `col` hit? Null when outside all of them. */
  const hitKey = (col: number): string | null => {
    const list = affords()
    const idx = regionAt(list, col)
    return idx === null ? null : (list[idx]?.key ?? null)
  }
  return (
    <text
      selectable={false}
      style={{ fg: t().fg, bg: props.bg ?? "transparent" }}
      onMouseMove={(e: MouseEvent) => {
        try {
          const cell = eventCell(e)
          setHoverKey(cell !== null ? hitKey(cell.col) : null)
        } catch {
          // hover must never take the TUI down
        }
      }}
      onMouseOut={() => {
        clearPress()
        setPressKey(null)
        setHoverKey(null)
      }}
      onMouseDown={(e: MouseEvent) => {
        try {
          const col = leftClickColumn(e) // null on right-click = selection copy
          if (col === null) return
          const key = hitKey(col)
          if (key === null) return
          clearPress()
          setPressKey(key)
          pressTimer = setTimeout(() => {
            pressTimer = null
            setPressKey(null)
          }, PRESS_HOLD_MS)
          if (key === "copy") props.onCopy?.(props.copyText)
          else props.onRevert?.()
        } catch {
          // a click must never take the TUI down
        }
      }}
    >
      <For each={view()}>{(s) => <span style={s.style}>{s.text}</span>}</For>
    </text>
  )
}

/**
 * The clickable `agent:<name> ⇄` chip above the input. Hover/press feedback
 * mirrors the message rows (selection fill on hover, accent flash on press).
 * A click CYCLES to the next agent (the status-bar chip opens the full picker).
 */
export function AgentChip(props: { name: string; onCycle?: () => void }): JSX.Element {
  const t = () => theme()
  const [fx, setFx] = createSignal<RowFx>("idle")
  const [over, setOver] = createSignal(false)
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  const clearPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  onCleanup(clearPress)
  const view = createMemo(() => rowFx(t(), fx(), t().bg))
  const labelFg = (): ThemeColor => {
    if (fx() === "press") return t().onAccent
    if (fx() === "hover") return t().onSelection ?? t().accent
    return t().accent
  }
  return (
    <text
      selectable={false}
      style={{ fg: view().fg ?? t().muted, bg: view().bg }}
      onMouseOver={() => {
        setOver(true)
        setFx("hover")
      }}
      onMouseOut={() => {
        setOver(false)
        clearPress()
        setFx("idle")
      }}
      onMouseDown={(e: MouseEvent) => {
        clearPress()
        setFx("press")
        pressTimer = setTimeout(() => {
          pressTimer = null
          setFx(over() ? "hover" : "idle")
        }, PRESS_HOLD_MS)
        if (e.button === MouseButton.LEFT) props.onCycle?.()
      }}
    >
      <span style={{ fg: labelFg(), bold: true }}>{` agent:${props.name} ⇄ `}</span>
    </text>
  )
}
