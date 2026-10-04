/**
 * Context inspector (Phase 3.1): a full-screen overlay showing what occupies
 * the model's context window, from `RemoteChat.contextBreakdown()`.
 *
 * - Header: labelled rows (model · window limit · used/percent · system prompt ·
 *   durable history · tool specs · MCP specs · messages · compactions · cache
 *   read/write) plus a text-cell usage bar (docs/agent.md "Context inspector").
 * - Body: a bounded, scrollable list of the durable provider-history messages
 *   (role + first line + token estimate) so the user can see "what's in context".
 * - Keys: ↑/↓/PgUp/PgDn/Home/End scroll (shared `overlay/nav.ts` resolver), Esc
 *   closes. One handler via `store.overlayKeyHandler` — never a global listener.
 *
 * The snapshot is recomputed through a memo that reads the session's signals,
 * so the inspector updates live while a generation streams. It renders zeros +
 * a note for an empty/disabled session and never throws.
 *
 * Every row sets an explicit `bg` via `overlayRowStyle` (or `"transparent"`),
 * uses theme tokens only, and pads to a fixed cell budget (opentui paint is
 * additive — a shrinking row must clear its old cells).
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { RemoteChat } from "../../client/remoteChat.ts"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { UiStore } from "../lib/store.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"
import {
  breakdownRows,
  emptyContextBreakdown,
  formatHistoryRow,
  historyWindow,
  usageBar,
  type ContextBreakdown,
} from "../chat/contextInspector.ts"

export interface ContextInspectorProps {
  store: UiStore
  onClose(): void
  /** The active tab's session; the memo tracks its signals for live updates. */
  chat?: RemoteChat
  /** A prebuilt snapshot (read-only); used for a saved session when `chat` is absent. */
  breakdown?: ContextBreakdown
  /** Overlay title override (e.g. the inspected session's title). */
  title?: string
}

/** Widest content budget (the overlay also clamps to the terminal). */
const MAX_WIDTH = 200
/** Cells reserved for a breakdown label (` system prompt:` etc.). */
const LABEL_W = 16
/** Bar cells cap (kept compact even on a wide screen). */
const BAR_MAX = 40
/** Non-list rows: 11 breakdown + bar + note + spacer + history header + footer. */
const CHROME_ROWS = 16

export function ContextInspector(props: ContextInspectorProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [hover, setHover] = createSignal<number | null>(null)

  // Reads the session's live signals (messages / status / cache / compactions /
  // model) so a streaming generation repaints the inspector.
  const bd = createMemo<ContextBreakdown>(
    () => props.chat?.contextBreakdown() ?? props.breakdown ?? emptyContextBreakdown("context unavailable for this session"),
  )

  const metrics = () => overlayMetrics(dims())
  const contentWidth = (): number => Math.max(12, Math.min(MAX_WIDTH, metrics().innerWidth - 2))
  const valueBudget = (): number => Math.max(0, contentWidth() - LABEL_W)
  const barWidth = (): number => Math.max(6, Math.min(BAR_MAX, contentWidth() - LABEL_W - 12))
  const listRows = (): number => Math.max(1, metrics().innerHeight - CHROME_ROWS)

  const win = createMemo(() => historyWindow(bd().history.length, sel(), listRows()))

  const usage = createMemo(() => usageBar(bd().percent, barWidth()))

  const visibleRows = createMemo(() => {
    const b = bd()
    const w = win()
    const budget = contentWidth()
    const rows: Array<{ index: number; text: string }> = []
    for (let i = 0; i < w.list; i++) {
      const idx = w.start + i
      const entry = b.history[idx]
      if (entry === undefined) continue
      rows.push({ index: idx, text: formatHistoryRow(entry, idx, idx === sel(), budget) })
    }
    return rows
  })

  const scroll = (dir: "up" | "down"): void => {
    const next = overlayNavStep(
      { name: dir, ctrl: false, meta: false, shift: false },
      { index: sel(), count: bd().history.length, pageSize: listRows(), vim: true, wrap: false },
    )
    if (next !== null) setSel(next)
  }

  props.store.overlayKeyHandler = (key) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    const next = overlayNavStep(key as OverlayNavKey, {
      index: sel(),
      count: bd().history.length,
      pageSize: listRows(),
      vim: true,
      wrap: false,
    })
    if (next !== null) setSel(next)
  }

  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    scroll(dir)
  }

  const historyHeader = (): string => {
    const n = bd().messages
    return ` durable history (${n} message${n === 1 ? "" : "s"}) `
  }

  const hint = (): string =>
    " ↑/↓ PgUp/PgDn Home/End scroll · Esc close "

  return (
    <OverlayPanel title={props.title !== undefined ? ` context · ${props.title} ` : " context inspector "} onClose={props.onClose}>
      <For each={breakdownRows(bd())}>
        {(row) => (
          <text selectable={false} style={{ fg: t().fg, bg: "transparent" }}>
            <span style={{ fg: t().muted, bg: "transparent" }}>{` ${row.label}:`.padEnd(LABEL_W)}</span>
            <span style={{ fg: t().fg, bg: "transparent" }}>{row.value.padEnd(valueBudget())}</span>
          </text>
        )}
      </For>

      <text selectable={false} style={{ fg: t().fg, bg: "transparent" }}>
        <span style={{ fg: t().muted, bg: "transparent" }}>{` ${"usage"}:`.padEnd(LABEL_W)}</span>
        <span style={{ fg: t().accent, bg: "transparent" }}>{usage().filled}</span>
        <span style={{ fg: t().muted, bg: "transparent" }}>{usage().empty}</span>
        <span style={{ fg: t().fg, bg: "transparent" }}>
          {` ${bd().percent}%`.padEnd(Math.max(0, contentWidth() - LABEL_W - barWidth()))}
        </span>
      </text>

      <text selectable={false} style={{ fg: bd().note !== null ? t().warning : t().muted, bg: "transparent" }}>
        <span style={{ fg: bd().note !== null ? t().warning : t().muted, bg: "transparent" }}>
          {` ${bd().note ?? ""} `.padEnd(contentWidth())}
        </span>
      </text>

      <text selectable={false} style={{ fg: t().accent, bg: "transparent" }}>
        <span style={{ fg: t().accent, bg: "transparent" }}>{historyHeader().padEnd(contentWidth())}</span>
      </text>

      <Show
        when={visibleRows().length > 0}
        fallback={
          <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>
            <span style={{ fg: t().muted, bg: "transparent" }}>{" (no durable messages yet) ".padEnd(contentWidth())}</span>
          </text>
        }
      >
        <For each={visibleRows()}>
          {(row) => {
            const selected = (): boolean => row.index === sel()
            const hovered = (): boolean => hover() === row.index
            const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
            const bg = (): ThemeColor => rs().bg as ThemeColor
            const fg = (): ThemeColor => rs().fg as ThemeColor
            return (
              <text selectable={false}
                style={rs()}
                onMouseOver={() => setHover(row.index)}
                onMouseOut={() => setHover((h) => (h === row.index ? null : h))}
                onMouseScroll={onWheel}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  setSel(row.index)
                }}
              >
                <span style={{ fg: fg(), bg: bg() }}>{row.text}</span>
              </text>
            )
          }}
        </For>
      </Show>

      <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>
        <span style={{ fg: t().muted, bg: "transparent" }}>{hint().padEnd(contentWidth())}</span>
      </text>
    </OverlayPanel>
  )
}
