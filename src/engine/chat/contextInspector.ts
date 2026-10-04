/**
 * Context inspector (Phase 3.1) pure helpers — the labelled-breakdown rows,
 * the text-cell usage bar, the bounded durable-history row/window math. Extracted
 * so the overlay's non-render behavior is unit-tested without a renderer
 * (docs/testing.md "non-render behavior lives in pure helpers").
 *
 * The component (ui/components/ContextInspector.tsx) owns only signals + wiring;
 * every string/geometry decision that can be tested lives here. The snapshot
 * shape (`ContextBreakdown`) is defined here and re-exported by ChatSession so
 * the accessor and the formatter share one source of truth.
 */

import { formatTokens } from "../../agent/chat/compaction.ts"
import { cps, truncateWithEllipsis } from "../../core/util.ts"

/** One durable provider-history message, reduced to a preview for display. */
export interface ContextHistoryEntry {
  /** Provider role ("system" | "user" | "assistant" | "tool"). */
  role: string
  /** First non-empty line of the message, trimmed. */
  preview: string
  /** Local token estimate for the message (overhead included). */
  tokens: number
}

/**
 * A plain, serializable snapshot of what currently occupies the model's
 * context window (ChatSession.contextBreakdown). Every field is a number /
 * string / boolean / array so the inspector can render it without touching the
 * session again.
 */
export interface ContextBreakdown {
  /** Selected model in `endpoint@model` form. */
  model: string
  /** Model context window (config override → models.dev → 128k fallback). */
  limit: number
  /** Next-request estimate (usage-anchored; local fallback). */
  used: number
  /** `used / limit` as a whole percent (can exceed 100; clamped to ≥ 0). */
  percent: number
  /** Local estimate of the static system prompt. */
  systemTokens: number
  /** Local estimate of the durable provider history. */
  historyTokens: number
  /** Core tool-spec overhead when tools are in play (0 in no-tools mode). */
  toolSpecTokens: number
  /** Connected MCP specs' overhead merged into requests (0 when none). */
  mcpSpecTokens: number
  /** Durable provider-history message count ("what's in context"). */
  messages: number
  /** Completed compactions this session. */
  compactions: number
  /** Cached prompt tokens of the last response (0 when unreported). */
  cacheRead: number
  /** Fresh (non-cached) prompt tokens of the last response (0 when unreported). */
  cacheWrite: number
  /** Total prompt tokens of the last response (0 when unreported). */
  cachePrompt: number
  /** Estimate reached the compaction threshold (context is at capacity). */
  pinned: boolean
  /** Session is usable (an API key / mock seam is present). */
  enabled: boolean
  /** Human note when the context is empty or the session is disabled. */
  note: string | null
  /** Durable history messages, newest last (bounded previews). */
  history: ContextHistoryEntry[]
}

/** One labelled row of the breakdown header. */
export interface ContextRow {
  label: string
  value: string
}

/** First non-empty line of a message, trimmed ("" when the body is blank). */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? ""
  return line.trim()
}

/**
 * The labelled breakdown rows the inspector paints, top to bottom. `used` is
 * the anchored next-request estimate that also drives compaction; the
 * system/history/spec rows are the local decomposition beside it. Values are
 * plain strings (the caller owns fg/bg).
 */
export function breakdownRows(b: ContextBreakdown): ContextRow[] {
  const cache = b.cachePrompt > 0
    ? {
        read: formatTokens(b.cacheRead),
        write: formatTokens(b.cacheWrite),
        total: formatTokens(b.cachePrompt),
      }
    : { read: "—", write: "—", total: "—" }
  return [
    { label: "model", value: b.model.length > 0 ? b.model : "(none)" },
    { label: "window limit", value: b.limit > 0 ? formatTokens(b.limit) : "unknown" },
    {
      label: "used",
      value: `${formatTokens(b.used)} · ${b.percent}%${b.pinned ? " · at capacity" : ""}`,
    },
    { label: "system prompt", value: formatTokens(b.systemTokens) },
    { label: "durable history", value: formatTokens(b.historyTokens) },
    { label: "tool specs", value: formatTokens(b.toolSpecTokens) },
    { label: "mcp specs", value: formatTokens(b.mcpSpecTokens) },
    { label: "messages", value: `${b.messages}` },
    { label: "compactions", value: `${b.compactions}` },
    { label: "cache read", value: `${cache.read} / ${cache.total}` },
    { label: "cache write", value: `${cache.write} / ${cache.total}` },
  ]
}

/** The whole breakdown as one multi-line string (tests / simple readouts). */
export function formatContextBreakdown(b: ContextBreakdown): string {
  return breakdownRows(b)
    .map((r) => `${r.label}: ${r.value}`)
    .join("\n")
}

/** A zeroed breakdown (disabled/unavailable session) with an optional note. */
export function emptyContextBreakdown(note: string | null = null): ContextBreakdown {
  return {
    model: "",
    limit: 0,
    used: 0,
    percent: 0,
    systemTokens: 0,
    historyTokens: 0,
    toolSpecTokens: 0,
    mcpSpecTokens: 0,
    messages: 0,
    compactions: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cachePrompt: 0,
    pinned: false,
    enabled: false,
    note,
    history: [],
  }
}

/** A text-cell usage bar: the filled/empty runs are returned separately so the
 * caller can paint them in different tokens (explicit bg on every span). */
export interface ContextUsageBar {
  /** Filled cells (`█`). */
  filled: string
  /** Remaining cells (`░`). */
  empty: string
  /** The percent actually painted (clamped 0..100). */
  fillPercent: number
}

/**
 * Build a fixed-`width` text bar for `percent`. The BAR clamps at 100% so an
 * over-limit request cannot overflow the row; callers still show the raw
 * percent in the `used` row.
 */
export function usageBar(percent: number, width: number): ContextUsageBar {
  const w = Math.max(0, Math.floor(width))
  const pct = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  const filled = Math.round((pct / 100) * w)
  return { filled: "█".repeat(filled), empty: "░".repeat(Math.max(0, w - filled)), fillPercent: pct }
}

/**
 * Compact one-line summary of an assistant turn's tool calls, e.g.
 * `→ run_command ×3, read_file` (first-seen order, repeats collapsed).
 * Empty when there are none. The inspector uses this so a reasoning/tool-only
 * turn reads as its tools instead of a bare "(empty)".
 */
export function toolCallSummary(names: readonly string[]): string {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const raw of names) {
    const name = raw.trim().length > 0 ? raw.trim() : "?"
    if (!counts.has(name)) order.push(name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (order.length === 0) return ""
  const parts = order.map((name) => {
    const n = counts.get(name) ?? 1
    return n > 1 ? `${name} ×${n}` : name
  })
  return `→ ${parts.join(", ")}`
}

/**
 * Display preview for a durable-history message: the first content line, an
 * `→ tool ×n` call summary, and an image note, joined with ` · ` (each part
 * omitted when empty). Returns "" only when the message carries none of the
 * three — the row then renders "(empty)" via `historyPreview`.
 */
export function messagePreview(content: string, toolNames: readonly string[] = [], imageCount = 0): string {
  const parts: string[] = []
  const text = firstLine(content)
  if (text.length > 0) parts.push(text)
  const calls = toolCallSummary(toolNames)
  if (calls.length > 0) parts.push(calls)
  if (imageCount > 0) parts.push(`[${imageCount} image${imageCount === 1 ? "" : "s"}]`)
  return parts.join(" · ")
}

/** `[role]` tag for a durable-history row (unknown roles still render safely). */
export function historyRoleTag(role: string): string {
  return `[${role.length > 0 ? role : "?"}]`
}

/** Display preview for an entry: the stored first line, or an "(empty)" note. */
export function historyPreview(entry: ContextHistoryEntry): string {
  const p = entry.preview.trim()
  return p.length > 0 ? p : "(empty)"
}

/**
 * One durable-history row, padded/truncated to a fixed `budget` cells
 * (stale-paint rule) with the `❯` arrow marker when selected and the message's
 * token estimate right-aligned. The caller paints fg/bg from
 * `overlayRowStyle`; this helper owns only the text cells.
 */
export function formatHistoryRow(entry: ContextHistoryEntry, index: number, selected: boolean, budget: number): string {
  const b = Math.max(0, budget)
  const prefix = selected ? " ❯ " : "   "
  const suffix = ` ${formatTokens(entry.tokens)}`
  const label = `${index + 1}. ${historyRoleTag(entry.role)} ${historyPreview(entry)}`
  const avail = Math.max(0, b - prefix.length - suffix.length)
  const shown = avail > 0 ? truncateWithEllipsis(label, avail) : ""
  const pad = " ".repeat(Math.max(0, b - prefix.length - cps(shown).length - suffix.length))
  return `${prefix}${shown}${pad}${suffix}`
}

/** Clamped selection + visible window for the durable-history list. */
export interface ContextHistoryWindow {
  start: number
  list: number
  sel: number
}

/**
 * Window the durable-history list so the selection stays visible. Mirrors the
 * other overlays' window math: a bounded slice that slides near the ends.
 * Safe for an empty list (returns zeros).
 */
export function historyWindow(count: number, sel: number, rows: number): ContextHistoryWindow {
  const total = Math.max(0, Math.floor(count))
  const cap = Math.max(1, Math.floor(rows))
  const clampedSel = total === 0 ? 0 : Math.max(0, Math.min(sel, total - 1))
  const start = Math.max(0, Math.min(clampedSel - Math.floor(cap / 2), Math.max(0, total - cap)))
  return { start, list: Math.min(cap, Math.max(0, total - start)), sel: clampedSel }
}
