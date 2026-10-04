/**
 * Shared model, geometry, and paint for the one-text-row chrome bars
 * (TabBar, StatusBar) — docs/DESIGN.md "Tab bar"/"Status bar" and
 * docs/keybindings.md "Click targets".
 *
 * opentui spans cannot carry handlers, so each bar renders ONE <text> and maps
 * the mouse column back onto its parts (region-mapped clicks). A "part" is one
 * interaction unit (a tab, a status chip) with a stable id and one or more
 * styled spans — a muted label next to a readable value. Layout is pure, so
 * rendering, hover, and click all agree on the exact same cells.
 *
 * Interaction language is the rest of the app's (docs/DESIGN.md "Neutral
 * structure"): idle parts carry tone color only; the mouse HOVER paints the
 * theme selection fill (falling back to the accent fg when a theme has none)
 * and a press flashes the accent block. Every span always sets an explicit
 * `bg` because opentui styles are additive — a cleared fill must be repainted.
 */

import { createSignal, onCleanup } from "solid-js"
import type { MouseEvent } from "@opentui/core"
import { cps, truncateWithEllipsis } from "../../core/util.ts"
import { theme, type ResolvedTheme, type ThemeColor } from "../../theme/theme.ts"
import { eventCell, leftClickColumn, regionAt } from "./clickTarget.ts"

/** Paint intent for one span; resolved to a theme token by `barToneFg`. */
export type BarTone = "label" | "muted" | "value" | "accent" | "success" | "warning" | "danger"

export interface BarSpan {
  text: string
  tone?: BarTone
  bold?: boolean
}

export interface BarPart {
  /** Stable id (unique among clickable parts) for hover/press tracking. */
  id: string
  spans: BarSpan[]
  /** Present = interactive: hover fill + press flash + click. */
  onClick?: () => void
  /** An inert divider (`joinBarParts`, or a bar's own separator). The overflow
   * fitter collapses orphans when a neighbour is sacrificed, so a dropped
   * chip never leaves a dangling ` · `. */
  separator?: boolean
}

export interface BarRegion {
  id: string
  start: number
  length: number
}

export interface BarLayout {
  text: string
  regions: BarRegion[]
}

/** The right-align marker: `resolveBarParts` pads this part to the bar edge. */
export const BAR_FLEX_ID = "__bar-flex"

/** The id `joinBarParts` gives every injected separator. */
export const BAR_SEP_ID = "sep"

/** An elastic spacer part. Place it where the remaining width should collect:
 * before a right-aligned button, or between the bar's left and right groups. */
export function barFlex(): BarPart {
  return { id: BAR_FLEX_ID, spans: [{ text: "" }] }
}

/** The exact string a part renders as. */
export function partText(part: BarPart): string {
  return part.spans.map((s) => s.text).join("")
}

/** Lay parts out left to right (no implicit gap — separators are parts). */
export function layoutBar(parts: readonly BarPart[]): BarLayout {
  const regions: BarRegion[] = []
  let text = ""
  let width = 0
  for (const part of parts) {
    const t = partText(part)
    const len = cps(t).length
    regions.push({ id: part.id, start: width, length: len })
    text += t
    width += len
  }
  return { text, regions }
}

/** Intersperse an inert separator part between `parts` (all share id "sep"). */
export function joinBarParts(parts: readonly BarPart[], separator: string, tone: BarTone = "label"): BarPart[] {
  const out: BarPart[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push({ id: BAR_SEP_ID, spans: [{ text: separator, tone }], separator: true })
    out.push(p)
  })
  return out
}

/** Pad the `barFlex()` part so the row fills `innerWidth` cells (min 1 so the
 * groups never touch when the content already overflows). Pads with spaces, so
 * a shrinking row always repaints every cell (opentui keeps stale ones). */
export function resolveBarParts(parts: readonly BarPart[], innerWidth: number): BarPart[] {
  const idx = parts.findIndex((p) => p.id === BAR_FLEX_ID)
  if (idx === -1) return [...parts]
  let used = 0
  for (const p of parts) used += cps(partText(p)).length
  const pad = Math.max(innerWidth - used, 1)
  return parts.map((p, i) => (i === idx ? { ...p, spans: [{ text: " ".repeat(pad) }] } : p))
}

/** One overflow-sacrifice step, tried in order until the row fits. */
export interface BarFitRule {
  /** Part id(s) this rule applies to. */
  ids: readonly string[]
  /** `"truncate"` shrinks one span per affected part (an ellipsis at the edge,
   * balanced across the parts so a title budget shrinks evenly); `"drop"`
   * removes the parts outright. Truncation always preserves the part's label. */
  mode: "truncate" | "drop"
  /** truncate: span index to shrink (default: the last span — the value). */
  span?: number
  /** truncate: minimum code points to keep before the next rule takes over. */
  min?: number
}

/**
 * Overflow policy (docs/DESIGN.md "Tab bar"/"Status bar"): when the assembled
 * parts exceed the row, sacrifice them in the caller's priority order so the
 * important right-hand affordances (the palette button; the model/context/
 * think/agent/approval chips) survive at the expense of long values (cwd,
 * model ids) and low-priority conditional chips. Each rule is applied until
 * the row fits; `truncate` rules shrink the longest eligible span first so a
 * shared title budget degrades evenly instead of starving one tab.
 *
 * `resolveBarParts` keeps a minimum 1-cell elastic gap, so the content must fit
 * into `innerWidth - 1` for the row to end exactly at the terminal edge. Rules
 * that name no present part are skipped, so a caller can pass a static plan.
 */
export function fitBarParts(
  parts: readonly BarPart[],
  innerWidth: number,
  plan: readonly BarFitRule[],
): BarPart[] {
  const budget = Math.max(0, innerWidth - 1)
  let out: BarPart[] = parts.map((p) => ({ ...p, spans: [...p.spans] }))

  const used = (list: readonly BarPart[]): number => {
    let w = 0
    for (const p of list) if (p.id !== BAR_FLEX_ID) w += cps(partText(p)).length
    return w
  }

  // Full (untruncated) span text, captured on the first truncate rule so
  // repeated shrink steps never re-truncate an already-ellipsized string.
  const originals = new Map<string, string>()

  for (const rule of plan) {
    if (used(out) <= budget) break
    const idSet = new Set(rule.ids)
    if (rule.mode === "drop") {
      if (!out.some((p) => idSet.has(p.id))) continue
      out = collapseSeparators(out.filter((p) => !idSet.has(p.id)))
      continue
    }
    const min = Math.max(0, rule.min ?? 4)
    // Shrink the longest eligible span by one code point, repeatedly, so
    // several parts share the squeeze evenly. Stop when none can shrink.
    for (;;) {
      if (used(out) <= budget) break
      let bestIdx = -1
      let bestLen = min
      for (let i = 0; i < out.length; i++) {
        const p = out[i]
        if (p === undefined || !idSet.has(p.id)) continue
        const spanIdx = rule.span ?? p.spans.length - 1
        const len = cps(p.spans[spanIdx]?.text ?? "").length
        if (len > bestLen) {
          bestLen = len
          bestIdx = i
        }
      }
      if (bestIdx === -1) break
      const part = out[bestIdx]
      if (part === undefined) break
      const spanIdx = rule.span ?? part.spans.length - 1
      const key = `${part.id}#${spanIdx}`
      if (!originals.has(key)) originals.set(key, part.spans[spanIdx]?.text ?? "")
      const full = originals.get(key) ?? ""
      const text = truncateWithEllipsis(full, bestLen - 1)
      out = out.map((p, i) =>
        i === bestIdx ? { ...p, spans: p.spans.map((s, j) => (j === spanIdx ? { ...s, text } : s)) } : p,
      )
    }
  }
  return out
}

/** Collapse separators that no longer sit between two content parts: leading,
 * trailing, duplicated (a run keeps its last), or adjacent to the elastic pad. */
function collapseSeparators(parts: readonly BarPart[]): BarPart[] {
  const out: BarPart[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === undefined) continue
    if (p.separator === true) {
      const prev = out[out.length - 1]
      const next = parts[i + 1]
      const prevOk = prev !== undefined && prev.separator !== true && prev.id !== BAR_FLEX_ID
      const nextOk = next !== undefined && next.separator !== true && next.id !== BAR_FLEX_ID
      if (prevOk && nextOk) out.push(p)
    } else {
      out.push(p)
    }
  }
  return out
}

/** The theme token a span paints with when idle. */
export function barToneFg(t: ResolvedTheme, tone: BarTone | undefined): ThemeColor {
  switch (tone) {
    case "label":
    case "muted":
      return t.muted
    case "accent":
      return t.accent
    case "success":
      return t.success
    case "warning":
      return t.warning
    case "danger":
      return t.danger
    case "value":
    default:
      return t.barFg
  }
}

export type BarFx = "idle" | "hover" | "press"

export interface BarSpanStyle {
  fg: ThemeColor
  bg: ThemeColor
  bold: boolean
}

/** bg/fg/bold for a span at interaction state `fx`. Always returns an explicit
 * `bg` (a disappearing style prop does not reset — docs/DESIGN.md). */
export function barSpanStyle(t: ResolvedTheme, span: BarSpan, fx: BarFx): BarSpanStyle {
  const bold = span.bold ?? false
  if (fx === "press") return { fg: t.onAccent, bg: t.accent, bold: true }
  if (fx === "hover") {
    if (t.selectionBg !== null) return { fg: t.onSelection ?? t.fg, bg: t.selectionBg, bold }
    return { fg: t.accent, bg: "transparent", bold }
  }
  return { fg: barToneFg(t, span.tone), bg: "transparent", bold }
}

/** Which clickable part does column `col` hit? Null over a separator, the
 * elastic pad, or any non-interactive part. */
export function barHitId(parts: readonly BarPart[], col: number): string | null {
  const layout = layoutBar(parts)
  const idx = regionAt(layout.regions, col)
  if (idx === null) return null
  const id = layout.regions[idx]?.id
  if (id === undefined) return null
  const part = parts.find((p) => p.id === id)
  return part?.onClick !== undefined ? id : null
}

/** How long the press flash holds — the action fires on mousedown, so the
 * highlight must outlive it to be visible (matches the chat rows). */
export const BAR_PRESS_HOLD_MS = 130

export interface BarSpanView {
  text: string
  style: BarSpanStyle
}

export interface BarRow {
  /** Flat, reactive span list for the row's single <text>. */
  spans: () => BarSpanView[]
  onMouseMove: (e: MouseEvent) => void
  onMouseOut: () => void
  onMouseDown: (e: MouseEvent) => void
}

/**
 * Wire one bar row: rebuild the part list, resolve the elastic pad to the
 * available width, track the hovered/pressed part by mouse column, and expose
 * the styled spans. `build` runs inside the reactive render scope, so reading
 * store/theme signals in it keeps the bar live.
 */
export function createBarRow(opts: { build: () => BarPart[]; innerWidth: () => number }): BarRow {
  const [hoverId, setHoverId] = createSignal<string | null>(null)
  const [pressId, setPressId] = createSignal<string | null>(null)
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  const clearPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  onCleanup(clearPress)

  const parts = (): BarPart[] => resolveBarParts(opts.build(), opts.innerWidth())

  const spans = (): BarSpanView[] => {
    const t = theme()
    const out: BarSpanView[] = []
    for (const part of parts()) {
      const fx: BarFx = pressId() === part.id ? "press" : hoverId() === part.id ? "hover" : "idle"
      for (const span of part.spans) out.push({ text: span.text, style: barSpanStyle(t, span, fx) })
    }
    return out
  }

  const onMouseMove = (e: MouseEvent): void => {
    try {
      const cell = eventCell(e)
      setHoverId(cell !== null ? barHitId(parts(), cell.col) : null)
    } catch {
      // hover must never take the TUI down
    }
  }

  const onMouseOut = (): void => {
    clearPress()
    setPressId(null)
    setHoverId(null)
  }

  const onMouseDown = (e: MouseEvent): void => {
    try {
      const col = leftClickColumn(e) // null on right-click = selection copy
      if (col === null) return
      const id = barHitId(parts(), col)
      if (id === null) return
      clearPress()
      setPressId(id)
      pressTimer = setTimeout(() => {
        pressTimer = null
        setPressId(null)
      }, BAR_PRESS_HOLD_MS)
      parts().find((p) => p.id === id)?.onClick?.()
    } catch {
      // a click must never take the TUI down
    }
  }

  return { spans, onMouseMove, onMouseOut, onMouseDown }
}
