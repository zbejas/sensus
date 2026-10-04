/**
 * Usage aggregation (phase 4.2): pure roll-ups over provider UsageInfo for the
 * usage dashboard. Tokens + cache hit rate are exact; cost needs a price table
 * and is computed only when one is supplied (docs/agent.md "Observability").
 */

import type { UsageInfo } from "../../agent/provider/provider.ts"

export interface UsageSample {
  /** Group key: a session id, a day (`2026-09-25`), or a model label. */
  key: string
  usage: UsageInfo | null
}

export interface UsageRollup {
  key: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  /** Cached / prompt, 0-100 (0 when no prompt tokens were reported). */
  cachePercent: number
}

/** Price per 1M tokens for a model (input/output USD); omit for tokens-only. */
export interface PriceTable {
  [key: string]: { input: number; output: number }
}

const cachedOf = (usage: UsageInfo): number => {
  const cached = usage.cachedTokens
  return typeof cached === "number" && Number.isFinite(cached) && cached > 0 ? Math.floor(cached) : 0
}

/** Roll up samples by key (order-preserving first-seen). */
export function aggregateUsage(samples: readonly UsageSample[]): UsageRollup[] {
  const byKey = new Map<string, UsageRollup>()
  for (const s of samples) {
    if (s.usage === null) continue
    const row = byKey.get(s.key) ?? {
      key: s.key,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cachePercent: 0,
    }
    row.calls += 1
    row.promptTokens += Math.max(0, s.usage.promptTokens ?? 0)
    row.completionTokens += Math.max(0, s.usage.completionTokens ?? 0)
    row.totalTokens += Math.max(0, s.usage.totalTokens ?? 0)
    row.cachedTokens += cachedOf(s.usage)
    byKey.set(s.key, row)
  }
  return [...byKey.values()].map((r) => ({
    ...r,
    cachePercent: r.promptTokens > 0 ? Math.max(0, Math.min(100, Math.floor((r.cachedTokens / r.promptTokens) * 100))) : 0,
  }))
}

/**
 * Combine already-aggregated rollups into one row (order-independent). Used
 * for the dashboard's `all` total: summing the SESSION rows keeps the call
 * count exact (the old path built a single synthetic sample, so `all` always
 * reported 1 call). Cache percent is recomputed from the summed tokens.
 */
export function sumRollups(rows: readonly UsageRollup[], key = "all"): UsageRollup {
  let calls = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedTokens = 0
  for (const r of rows) {
    calls += r.calls
    promptTokens += r.promptTokens
    completionTokens += r.completionTokens
    totalTokens += r.totalTokens
    cachedTokens += r.cachedTokens
  }
  return {
    key,
    calls,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cachePercent: promptTokens > 0 ? Math.max(0, Math.min(100, Math.floor((cachedTokens / promptTokens) * 100))) : 0,
  }
}

/** Estimated USD cost for a rollup under a price table (null when unpriced). */
export function estimatedCost(rollup: UsageRollup, prices: PriceTable): number | null {
  const price = prices[rollup.key]
  if (price === undefined) return null
  return (rollup.promptTokens / 1_000_000) * price.input + (rollup.completionTokens / 1_000_000) * price.output
}

/** `12.3k` / `1.3M` for compact rows (mirrors compaction.formatTokens). */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.floor(n))
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

/** One display row per rollup: `key · calls · total · cache%`. */
export function formatUsageRow(r: UsageRollup, prices?: PriceTable): string {
  const cost = prices !== undefined ? estimatedCost(r, prices) : null
  return `${r.key} · ${r.calls} call${r.calls === 1 ? "" : "s"} · ${formatTokenCount(r.totalTokens)} tok (${formatTokenCount(r.promptTokens)} in / ${formatTokenCount(r.completionTokens)} out) · cache ${r.cachePercent}%${cost !== null ? ` · $${cost.toFixed(4)}` : ""}`
}

// ---- chart -----------------------------------------------------------------

/**
 * Paint intent for one report/chart span. The dashboard maps these onto theme
 * tokens (`accent`/`fg`/`muted` + the semantic hues); keeping it as a plain
 * union lets the pure chart builders be tested without a theme.
 */
export type UsageTone = "accent" | "fg" | "muted" | "success" | "warning" | "danger"

/** One styled run of text within a report row. */
export interface UsageSpan {
  text: string
  tone: UsageTone
  /** Optional background tone (chart half-cells); omitted = transparent cell. */
  bg?: UsageTone
}

/** One rendered report/chart line (top→bottom). */
export interface UsageRow {
  spans: UsageSpan[]
  /** Present on `by session` rows: the transcript path to inspect (click). */
  sessionPath?: string
  /** Present on `by session` rows: the session's display title. */
  sessionTitle?: string
  /**
   * Present on the `by session` "load more" row: how many older sessions are
   * still hidden by the page limit. Activating the row reveals the next page.
   */
  loadMore?: number
}

/** The three stacked token segments a daily bar is painted from. */
export interface UsageSegments {
  /** Provider-reported cached (cache-hit) prompt tokens. */
  cache: number
  /** Prompt tokens that missed the cache. */
  miss: number
  /** Completion (output) tokens. */
  output: number
}

const DAILY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** True for a `YYYY-MM-DD` usage day key (the only keys the chart plots). */
export function isUsageDayKey(key: string): boolean {
  return DAILY_KEY.test(key)
}

/** Segment paint tones by role. */
export const USAGE_TONE_CACHE: UsageTone = "success"
export const USAGE_TONE_MISS: UsageTone = "accent"
export const USAGE_TONE_OUTPUT: UsageTone = "warning"

/** Stack order, bottom→top: output, cache miss, cache hit (cache rides on top). */
export const USAGE_SEGMENT_TONES: readonly UsageTone[] = [
  USAGE_TONE_OUTPUT,
  USAGE_TONE_MISS,
  USAGE_TONE_CACHE,
]

/**
 * Split a rollup into the stacked segments that sum to `prompt + completion`
 * (the provider's `totalTokens` may differ). Cached tokens are clamped to the
 * prompt so a malformed report can never paint past its own bar.
 */
export function usageSegments(r: UsageRollup): UsageSegments {
  const prompt = Math.max(0, r.promptTokens)
  const cache = Math.max(0, Math.min(r.cachedTokens, prompt))
  return { cache, miss: prompt - cache, output: Math.max(0, r.completionTokens) }
}

/** Build the segment ranges (in sub-cells) for one day's stacked bar. */
interface SegmentRange {
  tone: UsageTone
  start: number
  end: number
}

interface ChartBar {
  rollup: UsageRollup
  /** Bar height in HALF-cells (2 per row). */
  half: number
  /** Paint tone per half-cell (index 0 = bottom); null = empty. */
  halfTones: (UsageTone | null)[]
}

/** One plot cell: a glyph plus an fg tone and an optional bg tone (half-blocks
 * let one cell show the lower and upper half-cell in different colours). */
interface ChartCell {
  glyph: string
  tone: UsageTone | null
  bg: UsageTone | null
}

export interface UsageChart {
  /** Styled plot rows (top→bottom), y-axis gutter + date labels included. */
  rows: UsageRow[]
  /** Day keys actually plotted, oldest→newest. */
  days: string[]
  /** Days available before clamping to the plot width (null = all fit). */
  truncatedFrom: number | null
  /** Top-of-axis value. */
  max: number
}

/**
 * Build a stacked daily bar chart: one bar per calendar day, height scaled to
 * the busiest day, split bottom→top into cache hit / cache miss / output and
 * painted with `USAGE_SEGMENT_TONES`. Bars are `barW` columns wide and sit on a
 * `─` baseline; the y-axis shows the max / midpoint / 0 in the left gutter and
 * the x-axis labels a thinned-out subset of dates (`MM/DD`).
 *
 * Pure: no theme or session state. `width`/`height` are the cell budget the
 * caller has; an empty or usage-less input returns `rows: []`.
 */
export function buildUsageChart(
  dayRollups: readonly UsageRollup[],
  opts: { width: number; height: number },
): UsageChart {
  const width = Math.max(4, Math.floor(opts.width))
  const height = Math.max(2, Math.floor(opts.height))
  const days = dayRollups
    .filter((r) => r.totalTokens > 0 && DAILY_KEY.test(r.key))
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const available = days.length
  const max = days.reduce((m, r) => Math.max(m, r.totalTokens), 0)
  if (available === 0 || max <= 0) return { rows: [], days: [], truncatedFrom: null, max: 0 }

  // Left gutter sized to the widest tick label (+ 1 space), then the axis.
  const gutter = Math.max(
    formatTokenCount(max).length,
    formatTokenCount(Math.round(max / 2)).length,
    1,
  )
  const plotLeft = gutter + 2
  const plotWidth = Math.max(1, width - plotLeft)
  // One column per day plus a 1-cell gap; keep the most recent that fit.
  const maxBars = Math.max(1, Math.floor((plotWidth + 1) / 2))
  const shown = available > maxBars ? days.slice(available - maxBars) : days
  let barW = 1
  while (barW < 3 && shown.length * (barW + 2) <= plotWidth + 1) barW += 1
  const slot = barW + 1

  const segCount = (s: UsageSegments): number =>
    (s.cache > 0 ? 1 : 0) + (s.miss > 0 ? 1 : 0) + (s.output > 0 ? 1 : 0)
  const halfOf = (r: UsageRollup): number => {
    const scaled = Math.max(1, Math.round((r.totalTokens / max) * height * 2))
    // Grow a bar too short for its segments to one half-cell each, so a small
    // day still shows every colour without pretending it was a full bar.
    const minHalf = Math.max(1, segCount(usageSegments(r)))
    return Math.max(scaled, Math.min(height * 2, minHalf))
  }
  const bars: ChartBar[] = shown.map((r) => {
    const seg = usageSegments(r)
    const half = halfOf(r)
    // Stack bottom→top: output, cache miss, cache hit.
    const [outputH, missH] = allocateHalves(seg, half)
    const missEnd = outputH + missH
    const ranges: SegmentRange[] = [
      { tone: USAGE_TONE_OUTPUT, start: 0, end: outputH },
      { tone: USAGE_TONE_MISS, start: outputH, end: missEnd },
      { tone: USAGE_TONE_CACHE, start: missEnd, end: half },
    ].filter((rg) => rg.end > rg.start)
    const halfTones = Array.from({ length: half }, (_, i) => toneAt(ranges, i))
    return { rollup: r, half, halfTones }
  })

  const tick = (y: number): string => {
    if (y === height - 1) return formatTokenCount(max)
    if (y === 0) return "0"
    const midY = Math.floor((height - 1) / 2)
    if (y === midY) return formatTokenCount(Math.round(max / 2))
    return ""
  }

  const rows: UsageRow[] = []
  for (let y = height - 1; y >= 0; y -= 1) {
    const label = tick(y)
    const axis = label !== "" ? (y === 0 ? "┼" : "┤") : "│"
    // 0 row carries the `─` baseline; tick rows carry a faint `·` gridline.
    const grid = y === 0 ? "─" : label !== "" ? "·" : " "
    const cells: ChartCell[] = Array.from({ length: plotWidth }, () => ({
      glyph: grid,
      tone: "muted",
      bg: null,
    }))
    bars.forEach((bar, i) => {
      const cell = cellAt(bar, y)
      const base = i * slot
      for (let k = 0; k < barW; k += 1) {
        const col = base + k
        if (col < plotWidth) cells[col] = cell
      }
    })
    // Fold the row into same-(tone,bg) runs (fewer spans, same glyphs).
    const spans: UsageSpan[] = [
      { text: label.padStart(gutter) + " ", tone: "muted" },
      { text: axis + " ", tone: "muted" },
    ]
    let run = ""
    let runTone: UsageTone = "muted"
    let runBg: UsageTone | null = null
    for (const cell of cells) {
      const tone = cell.tone ?? "muted"
      if (tone !== runTone || cell.bg !== runBg) {
        if (run.length > 0) spans.push(runBg !== null ? { text: run, tone: runTone, bg: runBg } : { text: run, tone: runTone })
        run = ""
        runTone = tone
        runBg = cell.bg
      }
      run += cell.glyph
    }
    if (run.length > 0) spans.push(runBg !== null ? { text: run, tone: runTone, bg: runBg } : { text: run, tone: runTone })
    rows.push({ spans })
  }
  rows.push({
    spans: [
      { text: " ".repeat(plotLeft), tone: "muted" },
      { text: dateLabels(shown.map((r) => r.key), plotWidth, slot), tone: "muted" },
    ],
  })
  return {
    rows,
    days: shown.map((r) => r.key),
    truncatedFrom: available > shown.length ? available : null,
    max,
  }
}

/**
 * Half-cell heights in STACK order (bottom→top: output, miss, cache) summing to
 * `total`. Every non-zero segment reserves one half-cell, so even a one-row bar
 * can show two segments (lower/upper half) and a small day still shows every
 * colour; the remainder is split by largest remainder.
 */
function allocateHalves(seg: UsageSegments, total: number): [number, number, number] {
  const values = [seg.output, seg.miss, seg.cache]
  const out: [number, number, number] = [0, 0, 0]
  if (total <= 0) return out
  const active = values.map((v, i) => i).filter((i) => (values[i] ?? 0) > 0)
  if (active.length === 0) return out
  if (total <= active.length) {
    const order = [...active].sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0))
    for (let k = 0; k < total; k += 1) out[order[k] ?? 0] = 1
    return out
  }
  const remaining = total - active.length
  const sum = values.reduce((a, b) => a + b, 0)
  const exact = values.map((v) => (v > 0 ? (v / sum) * remaining : 0))
  const base = exact.map((e) => Math.floor(e))
  let used = base.reduce((a, b) => a + b, 0)
  const byRemainder = exact
    .map((e, i) => ({ i, f: e - Math.floor(e) }))
    .filter((x) => (values[x.i] ?? 0) > 0)
    .sort((a, b) => b.f - a.f)
  let k = 0
  while (used < remaining && k < byRemainder.length) {
    const idx = byRemainder[k]?.i ?? 0
    base[idx] = (base[idx] ?? 0) + 1
    used += 1
    k += 1
  }
  for (const i of active) out[i] = 1 + (base[i] ?? 0)
  return out
}

/** The tone owning half-cell index `i` (ranges tile `[0, total)` in order). */
function toneAt(ranges: readonly SegmentRange[], i: number): UsageTone | null {
  for (const rg of ranges) {
    if (i >= rg.start && i < rg.end) return rg.tone
  }
  return null
}

/**
 * The glyph and colours for one bar in plot row `y` (0 = bottom). A cell holds
 * two half-cells: `▀` paints the upper half in fg and the lower half in bg, so a
 * single row can show two segment colours; `█` when both halves match and `▄`
 * when only the lower half is filled.
 */
function cellAt(bar: ChartBar, y: number): ChartCell {
  const lower = bar.halfTones[y * 2] ?? null
  const upper = bar.halfTones[y * 2 + 1] ?? null
  if (lower === null && upper === null) return { glyph: " ", tone: null, bg: null }
  if (upper === null) return { glyph: "▄", tone: lower, bg: null }
  if (lower === null) return { glyph: "▀", tone: upper, bg: null }
  if (lower === upper) return { glyph: "█", tone: lower, bg: null }
  return { glyph: "▀", tone: upper, bg: lower }
}

/** Place `MM/DD` labels under a thinned, non-overlapping subset of bars. */
function dateLabels(keys: readonly string[], width: number, slot: number): string {
  const cells = Array.from({ length: width }, () => " ")
  let lastEnd = -2
  keys.forEach((key, i) => {
    const base = i * slot
    if (base < lastEnd + 2) return
    const label = key.slice(5).replace("-", "/")
    if (base + label.length > width) return
    for (let k = 0; k < label.length; k += 1) cells[base + k] = label[k] ?? " "
    lastEnd = base + label.length - 1
  })
  return cells.join("")
}

/** Legend for the stacked bar segments, in visual top→bottom order. */
export function usageChartLegend(): UsageRow {
  return {
    spans: [
      { text: " ", tone: "muted" },
      { text: "█", tone: USAGE_TONE_CACHE },
      { text: " cache hit  ", tone: "muted" },
      { text: "█", tone: USAGE_TONE_MISS },
      { text: " cache miss  ", tone: "muted" },
      { text: "█", tone: USAGE_TONE_OUTPUT },
      { text: " output  ", tone: "muted" },
      { text: "· bar height = total tokens", tone: "muted" },
    ],
  }
}
