/**
 * TabRail: the vertical tab strip for `layout: "sidebar"` (docs/DESIGN.md
 * "Tab bar"). It replaces the horizontal `TabBar` with a full-height rounded
 * card on the far left; the terminal pane stays in the middle and the chat
 * sidebar on the right.
 *
 * Visual language mirrors `TabBar`: the ACTIVE tab carries an accent `●`
 * marker and an accent bold label; inactive tabs are neutral (muted marker +
 * bar-value index/title). A right-aligned ` × ` closes a tab (its own click
 * region), the rows are windowed when the list outgrows the rail, and two
 * pinned rows at the bottom open a new tab (` + new tab`) and the command
 * palette (` ? commands`). A busy tab appends one activity glyph — `!`
 * while an approval is pending, else the shared streaming spinner.
 *
 * opentui spans cannot carry handlers, so each row is ONE <text> and the
 * clicked column maps back onto its regions (` × ` = close, elsewhere =
 * select). Pointer hover paints the theme selection fill and a press flashes
 * the accent block — the same feedback every clickable row uses. Every span
 * sets an explicit bg (opentui styles are additive — docs/DESIGN.md), and the
 * mouse handlers are wrapped so a malformed event can never take the TUI down.
 */

import { type JSX } from "@opentui/solid"
import type { MouseEvent } from "@opentui/core"
import { createMemo, createSignal, onCleanup, For } from "solid-js"
import { bgProps, borderProps, theme } from "../../theme/theme.ts"
import type { TabView } from "../lib/store.ts"
import { tabActivity, tabTitle } from "../lib/tabs.ts"
import { truncateWithEllipsis } from "../../core/util.ts"
import { BAR_PRESS_HOLD_MS, barSpanStyle, type BarFx, type BarRegion, type BarSpan } from "../lib/bar.ts"
import { leftClickColumn, regionAt } from "../lib/clickTarget.ts"
import {
  RAIL_CLOSE_WIDTH,
  railFillerRows,
  railInnerWidth,
  railTabCapacity,
  railTextWidth,
  railTitleBudget,
  tabRailWindow,
} from "../lib/tabRail.ts"

/** Per-tab close affordance (docs/DESIGN.md "Tab bar"): `×` (U+00D7) is
 * Latin-1 and covered by every monospace font at text scale/width, unlike
 * `✕` (U+2715). Wrapped in spaces so its click region is symmetric. */
const RAIL_CLOSE_GLYPH = "×"

/** One rendered rail row: styled spans plus the click regions that map columns
 * back to actions (docs/ui.md "Click mapping"). */
interface RailRowModel {
  spans: BarSpan[]
  regions: BarRegion[]
}

/**
 * A single full-width rail row with hover/press feedback. `build` runs inside a
 * reactive memo, so reading store/theme signals keeps the row live. The row is
 * one <text>; `onHit` receives the region id under the clicked column.
 */
function RailHoverRow(props: { build: () => RailRowModel; onHit: (regionId: string) => void }): JSX.Element {
  const t = () => theme()
  const [fx, setFx] = createSignal<BarFx>("idle")
  // Whether the pointer actually entered this row. The press flash restores
  // hover only when it did: opentui's `out` can target a stale renderable, so
  // restoring unconditionally could leave a stuck selection fill.
  const [over, setOver] = createSignal(false)
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  const clearPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  onCleanup(clearPress)

  const view = createMemo(() => {
    const active = theme()
    return props.build().spans.map((s) => ({ text: s.text, style: barSpanStyle(active, s, fx()) }))
  })

  /** Which region id does column `col` hit? Null outside every region. */
  const hitAt = (col: number): string | null => {
    const regions = props.build().regions
    const idx = regionAt(regions, col)
    return idx === null ? null : (regions[idx]?.id ?? null)
  }

  return (
    <box style={{ height: 1, flexDirection: "row" }}>
      <text
        selectable={false}
        style={{ fg: t().barFg }}
        onMouseOver={() => {
          try {
            setOver(true)
            setFx("hover")
          } catch {
            // hover must never take the TUI down
          }
        }}
        onMouseOut={() => {
          try {
            setOver(false)
            clearPress()
            setFx("idle")
          } catch {
            // hover must never take the TUI down
          }
        }}
        onMouseDown={(e: MouseEvent) => {
          try {
            const col = leftClickColumn(e) // null on right-click = selection copy
            if (col === null) return
            const id = hitAt(col)
            if (id === null) return
            clearPress()
            setFx("press")
            pressTimer = setTimeout(() => {
              pressTimer = null
              setFx(over() ? "hover" : "idle")
            }, BAR_PRESS_HOLD_MS)
            props.onHit(id)
          } catch {
            // a click must never take the TUI down
          }
        }}
      >
        <For each={view()}>{(s) => <span style={s.style}>{s.text}</span>}</For>
      </text>
    </box>
  )
}

/** One tab entry: marker + index + title + optional activity + ` × ` close. */
function TabEntry(props: {
  tab: TabView
  /** Absolute 1-based-ready index in the full tab list (reactive). */
  index: () => number
  activeTabId: number | null
  width: () => number
  onSelect?: (index: number) => void
  onClose?: (index: number) => void
}): JSX.Element {
  const build = (): RailRowModel => {
    const width = railInnerWidth(props.width())
    const i = props.index()
    const active = props.tab.id === props.activeTabId
    const activity = tabActivity(props.tab)
    const title = truncateWithEllipsis(tabTitle(props.tab), railTitleBudget(width, activity !== null))
    const marker = active ? "● " : "  "
    const idxText = `${i + 1}:`
    const activityText = activity !== null ? ` ${activity.glyph}` : ""
    const leftWidth = railTextWidth(marker) + railTextWidth(idxText) + railTextWidth(title) + railTextWidth(activityText)
    const pad = Math.max(0, width - leftWidth - RAIL_CLOSE_WIDTH)
    const spans: BarSpan[] = [
      // Fixed 2-cell marker slot so labels align across tabs (mirrors TabBar).
      { text: marker, tone: active ? "accent" : "muted", bold: active },
      { text: idxText, tone: active ? "accent" : "value", bold: active },
      { text: title, tone: active ? "accent" : "value", bold: active },
    ]
    if (activity !== null) spans.push({ text: activityText, tone: activity.tone, bold: true })
    spans.push({ text: " ".repeat(pad), tone: "value" })
    spans.push({ text: ` ${RAIL_CLOSE_GLYPH} `, tone: "muted" })
    // Everything before the close region selects (including the pad).
    const bodyLength = leftWidth + pad
    return {
      spans,
      regions: [
        { id: "select", start: 0, length: bodyLength },
        { id: "close", start: bodyLength, length: RAIL_CLOSE_WIDTH },
      ],
    }
  }
  return (
    <RailHoverRow
      build={build}
      onHit={(regionId) => {
        const i = props.index()
        if (regionId === "close") props.onClose?.(i)
        // Clicking the active tab also selects it, so App can refocus the pane.
        else props.onSelect?.(i)
      }}
    />
  )
}

/** One pinned bottom action row, padded to the full inner width. */
function RailActionRow(props: {
  width: () => number
  spans: BarSpan[]
  regionId: string
  onPress?: () => void
}): JSX.Element {
  const build = (): RailRowModel => {
    const width = railInnerWidth(props.width())
    const used = props.spans.reduce((n, s) => n + railTextWidth(s.text), 0)
    const pad = Math.max(0, width - used)
    return {
      spans: [...props.spans, { text: " ".repeat(pad), tone: "value" }],
      regions: [{ id: props.regionId, start: 0, length: width }],
    }
  }
  return <RailHoverRow build={build} onHit={() => props.onPress?.()} />
}

/** One full-width blank row. Painted (a run of spaces) rather than left as a
 * bare flex spacer so every rail cell is repainted each frame — opentui keeps
 * stale cells where nothing paints (docs/DESIGN.md "Do's and don'ts"). */
function RailBlankRow(props: { width: () => number }): JSX.Element {
  const t = () => theme()
  return (
    <box style={{ height: 1, flexDirection: "row" }}>
      <text selectable={false} style={{ fg: t().muted }}>
        {" ".repeat(railInnerWidth(props.width()))}
      </text>
    </box>
  )
}

export interface TabRailProps {
  tabs: TabView[]
  activeTabId: number | null
  /** Outer rail width in columns (App clamps via `clampTabRailWidth`). */
  width: number
  /** Rows allotted to the rail (App passes the content-row height). */
  height: number
  /** Click on tab region i (0-based); App selects it or refocuses the pane. */
  onSelectTab?: (index: number) => void
  /** Click on tab i's ` × `; App closes that tab (streaming arm applies). */
  onCloseTab?: (index: number) => void
  /** Click on the ` + new tab` row. */
  onNewTab?: () => void
  /** Click on the ` ? commands` row. */
  onOpenMenu?: () => void
}

export function TabRail(props: TabRailProps): JSX.Element {
  const t = () => theme()
  const width = createMemo(() => (Number.isFinite(props.width) ? Math.max(0, Math.floor(props.width)) : 0))
  const height = createMemo(() => (Number.isFinite(props.height) ? Math.max(0, Math.floor(props.height)) : 0))
  const capacity = createMemo(() => railTabCapacity(height()))
  const activeIndex = createMemo(() => {
    const id = props.activeTabId
    if (id === null) return -1
    return props.tabs.findIndex((tab) => tab.id === id)
  })
  const win = createMemo(() => tabRailWindow(props.tabs.length, activeIndex(), capacity()))
  const visible = createMemo(() => props.tabs.slice(win().start, win().end))
  // Blank rows under the entries: paint the rest of the card so no rail cell is
  // left unpainted (opentui keeps stale cells where nothing paints — a
  // terminal that transiently overlays the rail would freeze there otherwise).
  const fillers = createMemo(() => railFillerRows(capacity(), visible().length))

  // Pinned rows mirror the horizontal bar's wording + tones.
  const newTabSpans: BarSpan[] = [
    { text: " + ", tone: "label" },
    { text: "new tab", tone: "value" },
  ]
  const menuSpans: BarSpan[] = [
    { text: " ", tone: "label" },
    { text: "?", tone: "label" },
    { text: " ", tone: "label" },
    { text: "commands", tone: "value" },
  ]

  return (
    <box
      title=" tabs "
      titleAlignment="left"
      titleColor={t().muted}
      style={{
        width: width(),
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        ...borderProps(t().border),
        ...bgProps(t().bg),
      }}
    >
      <For each={visible()}>
        {(tab, i) => (
          <TabEntry
            tab={tab}
            index={() => win().start + i()}
            activeTabId={props.activeTabId}
            width={width}
            onSelect={props.onSelectTab}
            onClose={props.onCloseTab}
          />
        )}
      </For>
      <For each={Array.from({ length: fillers() }, (_, i) => i)}>{() => <RailBlankRow width={width} />}</For>
      {/* Elastic absorber: keeps the two action rows pinned at the bottom
       * (zero-height once the filler rows consume the card). */}
      <box style={{ flexGrow: 1 }} />
      <RailActionRow width={width} spans={newTabSpans} regionId="new-tab" onPress={props.onNewTab} />
      <RailActionRow width={width} spans={menuSpans} regionId="menu" onPress={props.onOpenMenu} />
    </box>
  )
}
