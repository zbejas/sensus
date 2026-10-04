/**
 * ThemePicker: full-screen overlay listing every built-in theme (docs/DESIGN.md
 * "Color and theme"). Moving the selection applies the theme LIVE so the whole
 * UI is the preview; Enter persists it, Esc restores the theme you came in
 * with.
 *
 * Opened by `/theme` (no argument) and by the settings screen's Appearance row.
 * Shared overlay primitives: fuzzy filter over name + kind (matching the other
 * pickers) with matched characters highlighted via MatchSpans; navigation
 * (arrows, PgUp/PgDn, Home/End, vim j/k/g/G while the filter is empty) resolved
 * by overlayNavStep; the mouse wheel moves the selection; rows clickable.
 *
 * Keys: type to filter · ↑/↓ preview · Enter apply (persists) · Esc cancel.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { type MouseEvent } from "@opentui/core"
import {
  BUILTIN_THEMES,
  setTheme,
  theme,
  themeKind,
  THEME_NAMES,
  type ThemeColor,
  type ThemeKind,
  type ThemeName,
} from "../../theme/theme.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import type { UiStore, OverlayKey } from "../lib/store.ts"
import { isEnterKey, keyChar, singleLinePaste } from "../../core/util.ts"
import { menuWindow } from "../chat/commandMenu.ts"
import { OverlayPanel, overlayRowStyle, backspaceFilter, overlayMetrics } from "./overlayKit.tsx"
import { MatchSpans } from "./overlay/MatchSpans.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface ThemePickerProps {
  store: UiStore
  /** Persist the pick; returns an error or null. */
  onPick: (name: string) => string | null
  onClose: () => void
}

/** Registry rows with their derived kind (stable; themes never change). */
const ROWS: ReadonlyArray<{ name: ThemeName; tokens: (typeof BUILTIN_THEMES)[ThemeName]; kind: ThemeKind }> =
  THEME_NAMES.map((name) => ({ name, tokens: BUILTIN_THEMES[name], kind: themeKind(name) }))

export function ThemePicker(props: ThemePickerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const original = theme().name
  const [sel, setSel] = createSignal(Math.max(0, ROWS.findIndex((r) => r.name === original)))
  const [filter, setFilter] = createSignal("")
  /** `/` (or any typed char) focuses the filter: vim j/k/g/G then TYPE. */
  const [filterFocused, setFilterFocused] = createSignal(false)
  /** Mouse hover highlight (row index); cleared when the pointer leaves. */
  const [hover, setHover] = createSignal<number | null>(null)

  /** Fuzzy filter on name + display name + kind (empty query keeps order). */
  const filtered = createMemo<typeof ROWS[number][]>(() => {
    const q = filter().toLowerCase()
    if (q.length === 0) return [...ROWS]
    const scored: Array<{ row: (typeof ROWS)[number]; score: number; at: number }> = []
    ROWS.forEach((row, at) => {
      const nameScore = fuzzyScore(q, row.name)
      const displayScore = fuzzyScore(q, row.tokens.displayName)
      const kindScore = fuzzyScore(q, row.kind)
      const best = [nameScore, displayScore, kindScore].reduce<number | null>(
        (acc, s) => (s === null ? acc : acc === null ? s : Math.max(acc, s)),
        null,
      )
      if (best !== null) scored.push({ row, score: best, at })
    })
    return scored.sort((x, y) => y.score - x.score || x.at - y.at).map((s) => s.row)
  })

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + swatch strip + filter + hint.
  const maxRows = () => Math.max(3, metrics().innerHeight - 4)
  /** Fixed cell budget for rows and swatch labels (stale-paint rule). */
  const rowWidth = () => Math.max(8, metrics().innerWidth - 2)
  const win = createMemo(() => {
    const items = filtered()
    const w = menuWindow(items.length, sel(), maxRows())
    return { rows: items.slice(w.start, w.start + w.list), start: w.start, selIdx: w.selIdx }
  })

  /** Apply the theme at `index` (live preview) — the whole UI re-tints. */
  const preview = (index: number): void => {
    const row = filtered()[index]
    if (row) setTheme(row.name)
  }

  const select = (index: number): void => {
    setSel(index)
    preview(index)
  }

  const nav = (key: OverlayNavKey): number | null =>
    overlayNavStep(key, {
      index: sel(),
      count: filtered().length,
      pageSize: maxRows(),
      vim: !filterFocused() && filter() === "",
      wrap: true,
    })

  /** Mouse wheel over a row moves the selection (and previews). */
  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    const next = overlayNavStep(
      { name: dir === "up" ? "up" : "down", ctrl: false, meta: false, shift: false },
      { index: sel(), count: filtered().length, pageSize: maxRows(), vim: false, wrap: true },
    )
    if (next !== null) select(next)
  }

  const pick = (row: (typeof ROWS)[number]): void => {
    setTheme(row.name)
    const err = props.onPick(row.name)
    if (err !== null) props.store.showToast(`theme save failed: ${err}`, "error", 4500)
    else props.store.showToast(`theme → ${row.name} (live; persisted to config)`, "success", 2500)
    props.onClose()
  }

  /** Escape / backdrop: undo the live preview, then close. */
  const cancel = (): void => {
    setTheme(original)
    props.onClose()
  }

  props.store.overlayKeyHandler = (key: OverlayKey) => {
    if (key.name === "escape") {
      cancel()
      return
    }
    if (key.name === "/" && !key.ctrl && !key.meta && !key.shift) {
      setFilterFocused(true)
      return
    }
    if (isEnterKey(key) && !key.ctrl) {
      const row = filtered()[win().selIdx]
      if (row) pick(row)
      return
    }
    const next = nav(key)
    if (next !== null) {
      select(next)
      return
    }
    if (key.name === "backspace") {
      setFilter((f) => backspaceFilter(f))
      select(0)
      return
    }
    const ch = keyChar(key)
    if (!key.ctrl && !key.meta && ch.length === 1) {
      setFilterFocused(true)
      setFilter((f) => f + ch)
      select(0)
    }
  }
  // Paste types into the filter (same effect as the keystrokes above, one chunk).
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    setFilterFocused(true)
    setFilter((f) => f + text)
    select(0)
  }

  const rowRest = (row: (typeof ROWS)[number]): string =>
    ` — ${row.kind}${row.name === original ? "  ← active" : ""}`

  /** Swatch strip rendered from the LIVE (previewed) theme. */
  const swatches = (): Array<{ label: string; fg: string; bg: ThemeColor }> => [
    { label: "accent", fg: t().onAccent, bg: t().accent },
    { label: "success", fg: t().onAccent, bg: t().success },
    { label: "warning", fg: t().onAccent, bg: t().warning },
    { label: "danger", fg: t().onAccent, bg: t().danger },
  ]

  return (
    <OverlayPanel title=" themes " onClose={cancel}>
      <Show
        when={filtered().length > 0}
        fallback={<text selectable={false} style={{ fg: t().muted }}> no themes match "{filter()}" </text>}
      >
        <For each={win().rows}>
          {(row, i) => {
            const idx = () => win().start + i()
            const selected = () => idx() === win().selIdx
            const hovered = () => hover() === idx()
            const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
            const rowBg = (): ThemeColor => rs().bg as ThemeColor
            const rowFg = (): ThemeColor => rs().fg as ThemeColor
            const parts = () => {
              const budget = rowWidth()
              const pre = selected() ? " ❯ " : "   "
              const labelBudget = Math.max(0, budget - pre.length)
              const shownLabel = [...row.name].slice(0, labelBudget).join("")
              const restBudget = Math.max(0, budget - pre.length - shownLabel.length)
              const shownRest = [...rowRest(row)].slice(0, restBudget).join("")
              const used = pre.length + shownLabel.length + shownRest.length
              return { pre, shownLabel, shownRest, pad: " ".repeat(Math.max(0, budget - used)) }
            }
            return (
              <text selectable={false}
                style={rs()}
                onMouseOver={() => setHover(idx())}
                onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
                onMouseScroll={onWheel}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  select(idx())
                  const picked = filtered()[idx()]
                  if (picked) pick(picked)
                }}
              >
                <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().pre}</span>
                <MatchSpans
                  query={filter()}
                  text={parts().shownLabel}
                  matchedFg={t().accent}
                  plainFg={rowFg()}
                  bg={rowBg()}
                />
                <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().shownRest + parts().pad}</span>
              </text>
            )
          }}
        </For>
      </Show>
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row", paddingLeft: 1 }}>
        <For each={swatches()}>
          {(s) => (
            <text selectable={false} style={{ fg: s.fg, bg: s.bg }}> {s.label} </text>
          )}
        </For>
      </box>
      <text selectable={false} style={{ fg: t().accent }}> filter: {filter()}_ </text>
      <text selectable={false} style={{ fg: t().muted }}> {` ${ROWS.length} themes · ↑/↓ preview · type to filter · Enter apply (persists) · Esc cancel `} </text>
    </OverlayPanel>
  )
}
