/**
 * CommandMenu (Ctrl+P): full-screen overlay listing the commands from
 * src/core/commandCatalog.ts (the registry hotkeys also read) — command-palette
 * style. UNFILTERED, rows are grouped under muted category headers
 * (Settings/Chat/Tabs/Layout/Help, registry first-appearance order — headers
 * are render-only and never selectable); TYPING switches to a flat ranked
 * list (headers would be noise between fuzzy matches). Type-to-filter (fuzzy,
 * label + description), ↑/↓ pick (wraps, commands only), Enter runs, Esc
 * closes; every row is clickable, clicking the backdrop closes.
 *
 * Shared overlay primitives (M12 0.4): matched characters in the label are
 * highlighted via MatchSpans; navigation (arrows, PgUp/PgDn, Home/End, and
 * vim j/k/g/G while the filter is empty) is resolved by overlayNavStep; the
 * mouse wheel moves the selection; a one-line detail footer previews the
 * highlighted command.
 *
 * Rows render from the RESOLVED keymap so hints show current bindings.
 * Chat-dependent entries show the active tab's live mode/approval as a
 * suffix (reactive memo — the M7 staleness rule).
 *
 * Keys are handled through store.overlayKeyHandler (App's single dispatch
 * point — multiple useKeyboard listeners would double-handle).
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { type MouseEvent } from "@opentui/core"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { KeyActionId, KeySpec } from "../../core/keymap.ts"
import type { RemoteChat } from "../../client/remoteChat.ts"
import {
  filterCommands,
  groupedRenderRows,
  hintFor,
  menuWindow,
  menuRows,
  renderIndexOf,
  type MenuRenderRow,
} from "../chat/commandMenu.ts"
import type { CommandId } from "../../core/commandCatalog.ts"
import type { UiStore, OverlayKey } from "../lib/store.ts"
import { isEnterKey, keyChar, singleLinePaste } from "../../core/util.ts"
import {
  draftParts,
  editDraft,
  startDraft,
  type MemoryDraft,
  type MemoryDraftEdit,
} from "../chat/memoryManager.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { MatchSpans } from "./overlay/MatchSpans.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface CommandMenuProps {
  store: UiStore
  /** Resolved keymap (App already merged config overrides). */
  keymap: Record<KeyActionId, KeySpec>
  /** Run the selected command. Called AFTER the menu closed itself. */
  onRun: (id: CommandId) => void
  onClose: () => void
}

const VISIBLE_ROWS = menuRows()

/** Fixed label column width (stable across filter states). */
const LABEL_WIDTH = Math.max(...VISIBLE_ROWS.map((c) => c.label.length)) + 2

/** Live state suffix for chat-dependent rows ("" elsewhere). */
function stateSuffix(chat: RemoteChat | null, id: CommandId): string {
  if (chat === null) return ""
  if (id === "open-agents") return ` · now: ${chat.agentName()}`
  if (id === "toggle-approval") return ` · now: ${chat.accessors.approval()}`
  if (id === "toggle-card-style") return ` · now: ${chat.accessors.cardStyle()}`
  return ""
}

export function CommandMenu(props: CommandMenuProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  // The filter is a single-line edit draft (text + codepoint cursor) so Left/
  // Right/Home/End/Delete edit the query in place — the same `editDraft`
  // editor SettingsScreen and the memory manager use (ui/chat/memoryManager.ts).
  const [filterDraft, setFilterDraft] = createSignal<MemoryDraft>(startDraft(""))
  const filter = (): string => filterDraft().text
  const draftView = createMemo(() => draftParts(filterDraft()))
  const [sel, setSel] = createSignal(0)
  /** `/` (or any typed char) focuses the filter: vim j/k/g/G then TYPE instead
   * of navigating, so a query may start with those letters (e.g. "gpt"). */
  const [filterFocused, setFilterFocused] = createSignal(false)
  /** Mouse hover highlight (row index); cleared when the pointer leaves. */
  const [hover, setHover] = createSignal<number | null>(null)

  const chat = () => props.store.activeTab()?.chat ?? null

  /** Filtered rows + their live state suffixes (tracked reads so a mode or
   * approval change elsewhere repaints the menu while it is open). */
  const rows = createMemo(() => {
    const c = chat()
    return filterCommands(VISIBLE_ROWS, filter()).map((def) => ({
      def,
      hint: hintFor(def, props.keymap),
      suffix: stateSuffix(c, def.id),
    }))
  })

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + detail footer + filter + hint.
  const maxRows = () => Math.max(3, metrics().innerHeight - 4)

  /**
   * What the palette paints: category-grouped rows while UNFILTERED (muted
   * headers between groups), a flat ranked list while filtering (headers
   * would be noise). `sel` stays an index into `rows()` (commands only), so
   * headers are never selectable; `selRender` maps it onto the render rows
   * for the sliding window.
   */
  const renderRows = createMemo<MenuRenderRow[]>(() =>
    filter().length === 0 ? groupedRenderRows(rows(), (r) => r.def.category) : rows().map((_, index) => ({ kind: "command", index })),
  )
  const selRender = createMemo(() => renderIndexOf(renderRows(), sel()))
  const win = createMemo(() => menuWindow(renderRows().length, selRender(), maxRows()))

  /** The command row at a render position (skips forward past a header —
   * only reachable via the window's end-clamp on an odd edge). */
  const commandAt = (renderIdx: number): ReturnType<typeof rows>[number] | undefined => {
    const rr = renderRows()
    for (let i = Math.max(0, Math.min(renderIdx, rr.length - 1)); i < rr.length; i++) {
      const r = rr[i]
      if (r?.kind === "command") return rows()[r.index]
    }
    return undefined
  }

  /** The highlighted command's one-line detail footer (reacts to filter/sel
   * and to the live state suffix). */
  const detail = createMemo(() => {
    const row = commandAt(win().selIdx)
    if (row === undefined) return ` no command match "${filter()}" `
    const parts = [
      row.def.label,
      row.hint.length > 0 ? row.hint : null,
      row.def.slash ?? null,
      row.def.description,
    ].filter((p): p is string => p !== null && p.length > 0)
    const width = Math.max(8, metrics().innerWidth - 2)
    return ` ${parts.join(" · ")}${row.suffix} `.slice(0, width)
  })

  /** Trailing pad so a shrinking draft never leaves stale cells on the card. */
  const filterPad = createMemo(() => {
    const p = draftView()
    const used = 9 + [...p.before].length + [...p.cursor].length + [...p.after].length
    return " ".repeat(Math.max(0, Math.max(8, metrics().innerWidth - 2) - used))
  })

  /** Shared navigation: arrows/PgUp/PgDn/Home/End always, vim j/k/g/G only
   * while the filter is empty (otherwise those letters filter the list). */
  const nav = (key: OverlayNavKey): number | null =>
    overlayNavStep(key, {
      index: sel(),
      count: rows().length,
      pageSize: maxRows(),
      vim: !filterFocused() && filter() === "",
      wrap: true,
    })

  /** Mouse wheel over a row moves the selection one step. */
  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    const next = overlayNavStep(
      { name: dir === "up" ? "up" : "down", ctrl: false, meta: false, shift: false },
      { index: sel(), count: rows().length, pageSize: maxRows(), vim: false, wrap: true },
    )
    if (next !== null) setSel(next)
  }

  /** App's `onRun` owns navigation: it closes the palette for a plain action,
   * or leaves it underneath when the command opens another overlay (so Esc /
   * click-outside walks back to the palette). */
  const run = (id: CommandId): void => {
    props.onRun(id)
  }

  // App routes ALL keys through store.overlayKeyHandler while the overlay is
  // open (the single dispatch point).
  props.store.overlayKeyHandler = (key: OverlayKey) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    // `/` focuses the filter without typing a char (vim search-style): the
    // next key, even j/k/g, filters instead of navigating.
    if (key.name === "/" && !key.ctrl && !key.meta && !key.shift) {
      setFilterFocused(true)
      return
    }
    // Cursor editing once a draft exists: Left/Right/Home/End move the caret
    // and Delete removes forward. While the draft is empty these stay list
    // navigation, so Home/End still jump the unfiltered list.
    if (filter().length > 0 && !key.ctrl && !key.meta) {
      const action: MemoryDraftEdit | null =
        key.name === "left"
          ? { type: "left" }
          : key.name === "right"
            ? { type: "right" }
            : key.name === "home"
              ? { type: "home" }
              : key.name === "end"
                ? { type: "end" }
                : key.name === "delete"
                  ? { type: "delete" }
                  : null
      if (action !== null) {
        setFilterDraft((d) => editDraft(d, action))
        return
      }
    }
    const next = nav(key)
    if (next !== null) {
      setSel(next)
      return
    }
    if (key.name === "backspace") {
      setFilterDraft((d) => editDraft(d, { type: "backspace" }))
      setSel(0)
      return
    }
    if (isEnterKey(key) && !key.ctrl && !key.meta) {
      const row = commandAt(win().selIdx)
      if (row) run(row.def.id)
      return
    }
    const ch = keyChar(key)
    if (!key.ctrl && !key.meta && ch.length === 1) {
      setFilterFocused(true)
      setFilterDraft((d) => editDraft(d, { type: "insert", char: ch }))
      setSel(0)
    }
  }
  // Paste types into the filter at the caret (one chunk).
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    setFilterFocused(true)
    setFilterDraft((d) => editDraft(d, { type: "insert", char: text }))
    setSel(0)
  }

  return (
    <OverlayPanel title=" command menu " onClose={props.onClose}>
      <Show
        when={rows().length > 0}
        fallback={<text selectable={false} style={{ fg: t().muted }}> no commands match "{filter()}" </text>}
      >
        <For each={renderRows().slice(win().start, win().start + win().list)}>
          {(r) => {
            return (
              <Show
                when={r.kind === "command"}
                fallback={<text selectable={false} style={{ fg: t().muted }}>{` ── ${r.kind === "header" ? r.label : ""} `}</text>}
              >
                {(() => {
                  const rr = r as { kind: "command"; index: number }
                  const row = rows()[rr.index]
                  if (row === undefined) return null
                  const idx = rr.index
                  const selected = () => sel() === idx
                  const hovered = () => hover() === idx
                  const rs = (): Record<string, unknown> =>
                    overlayRowStyle(t(), selected(), t().fg, hovered())
                  const rowBg = (): ThemeColor => rs().bg as ThemeColor
                  const rowFg = (): ThemeColor => rs().fg as ThemeColor
                  return (
                    <text selectable={false}
                      style={rs()}
                      onMouseOver={() => setHover(idx)}
                      onMouseOut={() => setHover((h) => (h === idx ? null : h))}
                      onMouseScroll={onWheel}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setSel(idx)
                        run(row.def.id)
                      }}
                    >
                      <span style={{ fg: rowFg(), bg: rowBg() }}>{selected() ? " ❯ " : "   "}</span>
                      <MatchSpans
                        query={filter()}
                        text={row.def.label.padEnd(LABEL_WIDTH)}
                        matchedFg={t().accent}
                        plainFg={rowFg()}
                        bg={rowBg()}
                      />
                      <span style={{ fg: rowFg(), bg: rowBg() }}>
                        {`${row.hint.padEnd(10)}${row.suffix}  ${row.def.description} `}
                      </span>
                    </text>
                  )
                })()}
              </Show>
            )
          }}
        </For>
      </Show>
      <box style={{ height: 1 }} />
      <text selectable={false} style={{ fg: t().muted }}>{detail()}</text>
      <text selectable={false} style={{ fg: t().accent }}>
        {" filter: "}
        <span style={{ fg: t().accent }}>{draftView().before}</span>
        <span style={{ fg: t().onAccent, bg: t().accent }}>{draftView().cursor}</span>
        <span style={{ fg: t().accent }}>{draftView().after}</span>
        <span style={{ fg: t().accent }}>{filterPad()}</span>
      </text>
      <text selectable={false} style={{ fg: t().muted }}> {" type to filter · ←/→ Home/End/Delete cursor · ↑/↓/j/k pick · Enter run · Esc close "} </text>
    </OverlayPanel>
  )
}
