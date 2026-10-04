/**
 * AgentPicker: full-screen overlay listing the agents loaded from
 * ~/.config/sensus/agents/ (docs/agents.md). Enter switches the agent for
 * the CURRENT session AND persists it as the config default (`agent` key in
 * config.json) — existing other tabs are untouched; new sessions + relaunches
 * use the persisted default.
 *
 * Shared overlay primitives (M12 0.4): a fuzzy filter over name +
 * description (matching the other pickers) with matched characters
 * highlighted via MatchSpans; navigation (arrows, PgUp/PgDn, Home/End, vim
 * j/k/g/G while the filter is empty) resolved by overlayNavStep; the mouse
 * wheel moves the selection; the bounded detail pane shows the highlighted
 * agent's metadata and prompt-body preview.
 *
 * Keys: type to filter · ↑/↓ pick · Enter switch (persists) · Esc close.
 * Rows clickable.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { type MouseEvent } from "@opentui/core"
import type { AgentDef } from "../../engine/index.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { UiStore, OverlayKey } from "../lib/store.ts"
import { isEnterKey, keyChar, singleLinePaste } from "../../core/util.ts"
import { menuWindow } from "../chat/commandMenu.ts"
import { OverlayPanel, overlayRowStyle, backspaceFilter, overlayMetrics } from "./overlayKit.tsx"
import { MatchSpans } from "./overlay/MatchSpans.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface AgentPickerProps {
  store: UiStore
  /** Loaded agents (sorted by file name — loadAgents order). */
  agents: AgentDef[]
  /** The currently active agent name (highlight). */
  activeName: string
  /** Persist the pick as the config default; returns an error or null. */
  onPick: (name: string) => string | null
  onClose: () => void
}

const PREVIEW_ROWS = 6

export function AgentPicker(props: AgentPickerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(Math.max(0, props.agents.findIndex((a) => a.name === props.activeName)))
  const [filter, setFilter] = createSignal("")
  /** `/` (or any typed char) focuses the filter: vim j/k/g/G then TYPE. */
  const [filterFocused, setFilterFocused] = createSignal(false)
  /** Mouse hover highlight (row index); cleared when the pointer leaves. */
  const [hover, setHover] = createSignal<number | null>(null)

  /** Fuzzy filter on name + description (empty query keeps file order). */
  const filtered = createMemo<AgentDef[]>(() => {
    const q = filter().toLowerCase()
    if (q.length === 0) return props.agents
    const scored: Array<{ a: AgentDef; score: number; at: number }> = []
    props.agents.forEach((a, at) => {
      const nameScore = fuzzyScore(q, a.name)
      const descScore = fuzzyScore(q, a.description)
      const best =
        nameScore !== null && descScore !== null
          ? Math.max(nameScore, descScore)
          : (nameScore ?? descScore)
      if (best !== null) scored.push({ a, score: best, at })
    })
    return scored.sort((x, y) => y.score - x.score || x.at - y.at).map((s) => s.a)
  })

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + 6-row preview + filter + hint.
  const maxRows = () => Math.max(3, metrics().innerHeight - (PREVIEW_ROWS + 3))
  /** Fixed cell budget for rows and the detail pane (stale-paint rule). */
  const rowWidth = () => Math.max(8, metrics().innerWidth - 2)
  const win = createMemo(() => {
    const items = filtered()
    const w = menuWindow(items.length, sel(), maxRows())
    return { rows: items.slice(w.start, w.start + w.list), start: w.start, selIdx: w.selIdx }
  })

  const active = (): AgentDef | null => filtered()[win().selIdx] ?? null

  const nav = (key: OverlayNavKey): number | null =>
    overlayNavStep(key, {
      index: sel(),
      count: filtered().length,
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
      { index: sel(), count: filtered().length, pageSize: maxRows(), vim: false, wrap: true },
    )
    if (next !== null) setSel(next)
  }

  const pick = (a: AgentDef): void => {
    const err = props.onPick(a.name)
    if (err !== null) props.store.showToast(`agent save failed: ${err}`, "error", 4500)
    else props.store.showToast(`agent → ${a.name} (this session + default for new ones)`, "success", 2500)
    props.onClose()
  }

  props.store.overlayKeyHandler = (key: OverlayKey) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if (key.name === "/" && !key.ctrl && !key.meta && !key.shift) {
      setFilterFocused(true)
      return
    }
    if (isEnterKey(key) && !key.ctrl) {
      const a = active()
      if (a !== null) pick(a)
      return
    }
    const next = nav(key)
    if (next !== null) {
      setSel(next)
      return
    }
    if (key.name === "backspace") {
      setFilter((f) => backspaceFilter(f))
      setSel(0)
      return
    }
    const ch = keyChar(key)
    if (!key.ctrl && !key.meta && ch.length === 1) {
      setFilterFocused(true)
      setFilter((f) => f + ch)
      setSel(0)
    }
  }
  // Paste types into the filter (same effect as the keystrokes above, one chunk).
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    setFilterFocused(true)
    setFilter((f) => f + text)
    setSel(0)
  }

  const rowLabel = (a: AgentDef): string => a.name
  const rowRest = (a: AgentDef): string => {
    const tools = a.tools === null ? "all tools" : `${a.tools.length} tool(s)`
    const sudo = a.sudoPrompt === "popup" ? " · sudo popup" : a.sudoPrompt === "auto" ? " · sudo auto" : ""
    const here = a.name === props.activeName ? "  ← active" : ""
    return ` — ${a.description.length > 0 ? a.description : "(no description)"} · ${tools}${sudo}${here}`
  }

  /** Bounded detail lines: metadata + the prompt body preview. */
  const previewLines = createMemo<string[]>(() => {
    const a = active()
    if (a === null) return []
    const tools = a.tools === null ? "all tools" : `${a.tools.length} tool(s)`
    const here = a.name === props.activeName ? "  ← active" : ""
    const meta = ` ${a.description.length > 0 ? a.description : "(no description)"} · ${tools} · sudo ${a.sudoPrompt}`
    const body = a.prompt.length > 0 ? a.prompt.split("\n") : ["(empty prompt body)"]
    return [` ${a.name}${here}`, meta, ...body.slice(0, PREVIEW_ROWS - 2)]
  })

  return (
    <OverlayPanel title=" agents " onClose={props.onClose}>
      <Show
        when={props.agents.length > 0}
        fallback={<text selectable={false} style={{ fg: t().muted }}> no agents loaded — ~/.config/sensus/agents/ (docs/agents.md) </text>}
      >
        <Show
          when={filtered().length > 0}
          fallback={<text selectable={false} style={{ fg: t().muted }}> no agents match "{filter()}" </text>}
        >
          <For each={win().rows}>
            {(a, i) => {
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
                const shownLabel = [...rowLabel(a)].slice(0, labelBudget).join("")
                const restBudget = Math.max(0, budget - pre.length - shownLabel.length)
                const shownRest = [...rowRest(a)].slice(0, restBudget).join("")
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
                    setSel(idx())
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
        <OverlayPreview lines={previewLines()} rows={PREVIEW_ROWS} width={rowWidth()} fg={t().fg} muted={t().muted} />
      </Show>
      <text selectable={false} style={{ fg: t().accent }}> filter: {filter()}_ </text>
      <text selectable={false} style={{ fg: t().muted }}> {` ${props.agents.length} agent(s) · type to filter · ↑/↓/j/k pick · Enter switch (persists) · Esc close `} </text>
    </OverlayPanel>
  )
}
