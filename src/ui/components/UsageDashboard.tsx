/**
 * UsageDashboard (docs/agent.md "Observability"): a read-only overlay that
 * rolls up token usage over the newest 14 days with activity — a stacked daily
 * bar chart (cache hit / cache miss / output) plus text roll-ups by day and by
 * session (title). Cost is shown only when a price table is available (none
 * ships yet; tokens + cache hit rate are the exact, provider-reported numbers).
 *
 * Keys: ↑/↓/j/k · PgUp/PgDn/Home/End scroll · wheel · r refresh · Esc close.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { MouseButton, type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For, onMount } from "solid-js"
import { cps, isEnterKey } from "../../core/util.ts"
import { theme, type ResolvedTheme, type ThemeColor } from "../../theme/theme.ts"
import type { RestClient, RestUsage } from "../../client/restClient.ts"
import type { UiStore } from "../lib/store.ts"
import {
  buildUsageChart,
  formatUsageRow,
  sumRollups,
  usageChartLegend,
  type UsageRow,
  type UsageSpan,
  type UsageTone,
} from "../chat/usage.ts"
import { OverlayPanel, overlayMetrics } from "./overlayKit.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"
import { leftClickColumn } from "../lib/clickTarget.ts"

export interface UsageDashboardProps {
  store: UiStore
  /** The daemon REST client (the daemon owns the sessions/usage; D13). */
  rest: RestClient
  onClose: () => void
  /** Open the reconstructed context inspector for a `by session` row's path. */
  onOpenSessionContext?: (path: string, title: string) => void
}

/** Plot height ceiling; smaller terminals get a shorter chart. */
const CHART_HEIGHT = 10
/** The report covers the newest N distinct days with usage (a bounded window). */
const USAGE_WINDOW_DAYS = 14
/** Sessions revealed per page in the `by session` list (older pages on demand). */
const SESSION_PAGE = 50
const MIN_CHART_WIDTH = 20

export interface UsageReportOptions {
  /** Cell budget for the chart (the card's usable width/height). */
  width?: number
  height?: number
  /**
   * Max `by session` rows to render (older sessions page in on demand). Omit to
   * render every session (tests / simple readouts).
   */
  sessionLimit?: number
}

/** The report shape the row builder consumes (`GET /v1/usage` minus its `ok`). */
export type UsageReportData = Omit<RestUsage, "ok">

/**
 * Build the styled report rows (chart + text roll-ups). Never throws: a missing
 * or unreadable sessions dir degrades to an empty report. The summary, chart and
 * `by day` list cover the newest `USAGE_WINDOW_DAYS` days with usage; the
 * `by session` list spans ALL history, paginated via `opts.sessionLimit` so
 * older sessions stay reachable.
 */
export function usageReport(report: UsageReportData, opts: UsageReportOptions = {}): UsageRow[] {
  const dayRows = report.byDay
  const total = report.total
  const sessionMeta = new Map<string, { path: string; title: string; lastTs: number }>()
  for (const s of report.sessions) sessionMeta.set(s.path, { path: s.path, title: s.title, lastTs: s.lastTs })

  const rows: UsageRow[] = []
  const header = (text: string): void => {
    rows.push({ spans: [{ text, tone: "accent" }] })
  }
  const plain = (text: string, tone: UsageTone = "fg"): void => {
    rows.push({ spans: [{ text, tone }] })
  }

  const nSessions = report.windowSessions
  header(` usage over the last ${report.windowDays} days · ${nSessions} session${nSessions === 1 ? "" : "s"} `)
  if (total.calls > 0) plain(formatUsageRow(total))
  else plain("(no usage reported yet)", "muted")
  plain("")

  const chart = buildUsageChart(dayRows, {
    width: opts.width ?? MIN_CHART_WIDTH,
    height: opts.height ?? CHART_HEIGHT,
  })
  if (chart.rows.length > 0) {
    const n = chart.days.length
    header(` tokens by day · ${n} day${n === 1 ? "" : "s"} `)
    rows.push(usageChartLegend())
    plain("")
    rows.push(...chart.rows)
    if (chart.truncatedFrom !== null && chart.truncatedFrom > chart.days.length) {
      plain(` (showing the last ${chart.days.length} of ${chart.truncatedFrom} days)`, "muted")
    }
    plain("")
  }

  // Text lists read newest-first: the most recent day/session is the top row.
  // (The chart keeps its time axis oldest→newest; only the text lists flip.)
  const dayOrdered = [...dayRows].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  const sessionOrdered = [...report.bySession].sort((a, b) => {
    const at = sessionMeta.get(a.key)?.lastTs ?? 0
    const bt = sessionMeta.get(b.key)?.lastTs ?? 0
    if (bt !== at) return bt - at // newest activity first
    return b.totalTokens - a.totalTokens // tie-break: biggest usage
  })
  header(" by day")
  if (dayOrdered.length > 0) for (const r of dayOrdered) plain(`  ${formatUsageRow(r)}`)
  else plain("  (none)", "muted")
  plain("")

  const limit = Math.max(0, Math.floor(opts.sessionLimit ?? sessionOrdered.length))
  const shownSessions = sessionOrdered.slice(0, limit)
  const remaining = sessionOrdered.length - shownSessions.length
  header(remaining > 0 ? ` by session · ${shownSessions.length} of ${sessionOrdered.length} ` : " by session")
  if (shownSessions.length > 0) {
    for (const r of shownSessions) {
      const meta = sessionMeta.get(r.key)
      rows.push({
        spans: [{ text: `  ${formatUsageRow({ ...r, key: meta?.title ?? r.key })}`, tone: "fg" }],
        sessionPath: r.key,
        sessionTitle: meta?.title ?? r.key,
      })
    }
  } else plain("  (none)", "muted")
  if (remaining > 0) {
    rows.push({
      spans: [
        { text: `  … ${remaining} older session${remaining === 1 ? "" : "s"} · Enter to load more`, tone: "muted" },
      ],
      loadMore: remaining,
    })
  }
  return rows
}

/** The report flattened to plain text (tests + simple readouts). */
export function usageLines(report: UsageReportData, opts?: UsageReportOptions): string[] {
  return usageReport(report, opts).map((r) => r.spans.map((s) => s.text).join(""))
}

/** Map a report tone onto the active theme token. */
function toneFg(t: ResolvedTheme, tone: UsageTone): ThemeColor {
  switch (tone) {
    case "accent":
      return t.accent
    case "success":
      return t.success
    case "warning":
      return t.warning
    case "danger":
      return t.danger
    case "muted":
      return t.muted
    case "fg":
    default:
      return t.fg
  }
}

interface FitSpan {
  text: string
  style: { fg: ThemeColor; bg: ThemeColor | "transparent" }
}

/** Truncate/pad one report row to exactly `width` cells with explicit bg.
 * `fill` paints rows whose spans have no bg of their own (hover highlight). */
function fitRow(spans: readonly UsageSpan[], width: number, t: ResolvedTheme, fill?: ThemeColor): FitSpan[] {
  const out: FitSpan[] = []
  let used = 0
  for (const span of spans) {
    if (used >= width) break
    const chars = cps(span.text)
    const room = width - used
    const text = chars.length > room ? chars.slice(0, room).join("") : span.text
    if (text.length === 0) continue
    const bg = span.bg !== undefined ? toneFg(t, span.bg) : (fill ?? "transparent")
    out.push({ text, style: { fg: toneFg(t, span.tone), bg } })
    used += cps(text).length
  }
  if (used < width) out.push({ text: " ".repeat(width - used), style: { fg: t.fg, bg: fill ?? "transparent" } })
  return out
}

/** Paint a selected session row: accent fg + the `❯` selection marker. */
function markSelected(spans: readonly UsageSpan[]): UsageSpan[] {
  return spans.map((s, i) => ({
    text: i === 0 && s.text.startsWith("  ") ? `❯ ${s.text.slice(2)}` : s.text,
    tone: "accent",
  }))
}

/** Hover sentinel for the `by session` load-more row (never a real path). */
const MORE_HOVER = "\u0000usage-more"

export function UsageDashboard(props: UsageDashboardProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [version, setVersion] = createSignal(0)
  /** The daemon report (null until the first `/v1/usage` load resolves). */
  const [report, setReport] = createSignal<UsageReportData | null>(null)
  const [hoverPath, setHoverPath] = createSignal<string | null>(null)
  /** `by session` page size: grows when the load-more row is activated. */
  const [sessionLimit, setSessionLimit] = createSignal(SESSION_PAGE)
  // Scroll offset = index of the TOP visible line. The dashboard is a
  // read-only report: there is no cursor to move, so `j`/`down` shifts the
  // viewport one line immediately.
  const [top, setTop] = createSignal(0)
  const metrics = () => overlayMetrics(dims())
  const width = (): number => Math.max(MIN_CHART_WIDTH, metrics().innerWidth - 2)
  const chartHeight = (): number =>
    Math.max(3, Math.min(CHART_HEIGHT, metrics().innerHeight - 8))
  /** Fetch the report from the daemon (the overlay owns no local sessions). */
  const load = (): void => {
    void (async () => {
      try {
        setReport(await props.rest.usage())
      } catch {
        setReport(null)
      }
    })()
  }
  onMount(load)
  const rows = createMemo(() => {
    void version()
    const r = report()
    if (r === null) return []
    const m = metrics()
    return usageReport(r, {
      width: Math.max(MIN_CHART_WIDTH, m.innerWidth - 2),
      height: chartHeight(),
      sessionLimit: sessionLimit(),
    })
  })
  // Chrome inside the card: spacer + hint.
  const maxRows = () => Math.max(4, metrics().innerHeight - 2)
  const maxTop = () => Math.max(0, rows().length - maxRows())
  const clamped = () => Math.max(0, Math.min(top(), maxTop()))
  const win = createMemo(() => {
    const start = clamped()
    return { start, items: rows().slice(start, start + maxRows()) }
  })

  // Keyboard cursor over the `by session` rows and the load-more row
  // (↑/↓/j/k). Enter opens the selected session's context, or loads the next
  // page when the load-more row is selected. Report rows are not selectable.
  const actionRowIndices = createMemo(() =>
    rows()
      .map((r, i) => (r.sessionPath !== undefined || r.loadMore !== undefined ? i : -1))
      .filter((i) => i >= 0),
  )
  const [selRow, setSelRow] = createSignal(-1)
  const effectiveSel = createMemo(() => {
    const idxs = actionRowIndices()
    return idxs.includes(selRow()) ? selRow() : (idxs[0] ?? -1)
  })
  const visibleRow = (row: number): boolean => row >= clamped() && row < clamped() + maxRows()
  const ensureVisible = (row: number): void => {
    if (row < clamped()) setTop(row)
    else if (row >= clamped() + maxRows()) setTop(Math.max(0, row - maxRows() + 1))
  }
  const moveSelection = (delta: number): void => {
    const idxs = actionRowIndices()
    if (idxs.length === 0) return
    const current = effectiveSel()
    if (!visibleRow(current)) {
      ensureVisible(current) // first press reveals the current row
      return
    }
    const at = idxs.indexOf(current)
    const next = Math.max(0, Math.min((at < 0 ? 0 : at) + delta, idxs.length - 1))
    const row = idxs[next]
    if (row === undefined) return
    setSelRow(row)
    ensureVisible(row)
  }
  const activateRow = (row: number): void => {
    const r = rows()[row]
    if (r === undefined) return
    if (r.loadMore !== undefined) {
      // Reveal the next page. The selected index now lands on the first newly
      // shown session (rows are inserted before the load-more row).
      setSessionLimit((n) => n + SESSION_PAGE)
      return
    }
    if (r.sessionPath !== undefined && props.onOpenSessionContext !== undefined) {
      props.onOpenSessionContext(r.sessionPath, r.sessionTitle ?? r.sessionPath)
    }
  }

  const move = (key: OverlayNavKey): void => {
    // count = number of distinct scroll positions (maxTop + 1) so the shared
    // resolver clamps `end` to a full window instead of the last single line.
    const next = overlayNavStep(key, {
      index: clamped(),
      count: maxTop() + 1,
      pageSize: maxRows(),
      vim: true,
      wrap: false,
    })
    if (next !== null) setTop(next)
  }

  props.store.overlayKeyHandler = (key) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if (key.name === "r" && !key.ctrl && !key.meta) {
      setVersion((v) => v + 1)
      load()
      return
    }
    if (isEnterKey(key)) {
      activateRow(effectiveSel())
      return
    }
    if (key.name === "down" || (key.name === "j" && !key.ctrl && !key.meta)) {
      moveSelection(1)
      return
    }
    if (key.name === "up" || (key.name === "k" && !key.ctrl && !key.meta)) {
      moveSelection(-1)
      return
    }
    move(key as OverlayNavKey)
  }

  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    move({ name: dir, ctrl: false, meta: false, shift: false })
  }

  const hint = (): string =>
    props.onOpenSessionContext !== undefined
      ? " ↑/↓ pick · Enter opens its context (or loads older sessions) · PgUp/PgDn/Home/End scroll · wheel · r refresh · Esc close "
      : " ↑/↓/PgUp/PgDn/Home/End scroll · wheel · r refresh · Esc close "

  return (
    <OverlayPanel title=" usage dashboard " onClose={props.onClose}>
      <For each={win().items}>
        {(row, i) => {
          const abs = (): number => win().start + i()
          const key = (): string | null =>
            row.loadMore !== undefined ? MORE_HOVER : (row.sessionPath ?? null)
          const actionable = (): boolean =>
            row.loadMore !== undefined ||
            (row.sessionPath !== undefined && props.onOpenSessionContext !== undefined)
          const selected = (): boolean => actionable() && abs() === effectiveSel()
          const view = (): readonly UsageSpan[] => (selected() ? markSelected(row.spans) : row.spans)
          const fill = (): ThemeColor | undefined =>
            actionable() && hoverPath() === key() && t().selectionBg !== null
              ? (t().selectionBg as ThemeColor)
              : undefined
          return (
            <text
              selectable={false}
              style={{ bg: "transparent" }}
              onMouseScroll={onWheel}
              onMouseOver={actionable() ? () => setHoverPath(key()) : undefined}
              onMouseOut={actionable() ? () => setHoverPath((p) => (p === key() ? null : p)) : undefined}
              onMouseDown={
                actionable()
                  ? (e: MouseEvent) => {
                      // Wheel over a clickable row must SCROLL, not activate it.
                      // Terminals deliver it three ways: a scroll event
                      // (SGR), or a button-down with the wheel button codes.
                      if (e.type === "scroll" || e.scroll !== undefined) {
                        onWheel(e)
                        return
                      }
                      if (e.button === MouseButton.WHEEL_UP) {
                        move({ name: "up", ctrl: false, meta: false, shift: false })
                        return
                      }
                      if (e.button === MouseButton.WHEEL_DOWN) {
                        move({ name: "down", ctrl: false, meta: false, shift: false })
                        return
                      }
                      if (leftClickColumn(e) === null) return // right-click = select/copy
                      e.stopPropagation()
                      setSelRow(abs())
                      activateRow(abs())
                    }
                  : undefined
              }
            >
              <For each={fitRow(view(), width(), t(), fill())}>{(s) => <span style={s.style}>{s.text}</span>}</For>
            </text>
          )
        }}
      </For>
      <box style={{ height: 1 }} />
      <text selectable={false} style={{ fg: t().muted }}> {hint()} </text>
    </OverlayPanel>
  )
}
