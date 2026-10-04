/**
 * ResumePicker — the `sensus --resume` session list, presented as an in-app
 * window over the live layout (like Settings), not its own fullscreen renderer
 * (docs/architecture.md "session/", docs/sessions.md). Most recent session
 * first; shows the title (sidecar or derived), a timestamp and message counts.
 * Type-to-filter over title + first user text + tags with matched-character
 * highlighting; Enter resumes (the chosen file becomes tab 1's session), Esc/q
 * cancels into a normal fresh boot.
 *
 * App opens it (`store.setOverlay("resume")`) at boot when `--resume` was
 * passed. Input goes through the store's single overlay dispatch point (never
 * its own global key listener), plus the overlay paste handler for filtering.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import type { UiStore } from "../lib/store.ts"
import type { LoadedSession } from "../../session/store.ts"
import { isEnterKey, printableKeyText, singleLinePaste, truncateWithEllipsis } from "../../core/util.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import { MatchSpans } from "./overlay/MatchSpans.tsx"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface ResumePickerProps {
  store: UiStore
  sessions: LoadedSession[]
  /** Enter resumes the chosen path; Esc/q passes null (fresh boot). */
  onPick: (path: string | null) => void
}

const PREVIEW_ROWS = 5

function fmtTime(ts: number | null): string {
  if (ts === null) return "?"
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ResumePicker(props: ResumePickerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [filter, setFilter] = createSignal("")
  const [filterFocused, setFilterFocused] = createSignal(false)
  const [hover, setHover] = createSignal<number | null>(null)
  const sessions = props.sessions

  /** Recency order, narrowed by a fuzzy query over title/firstUser/tags. */
  const filtered = createMemo<LoadedSession[]>(() => {
    const q = filter().trim().toLowerCase()
    if (q.length === 0) return sessions
    return sessions.filter((s) => {
      if (fuzzyScore(q, s.title) !== null) return true
      if (fuzzyScore(q, s.firstUser ?? "") !== null) return true
      return s.tags.some((tag) => fuzzyScore(q, tag) !== null)
    })
  })

  const clampedSel = createMemo(() => Math.min(sel(), Math.max(0, filtered().length - 1)))

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: hint + filter + spacer + PREVIEW_ROWS preview + count.
  const maxRows = () => Math.max(2, metrics().innerHeight - (PREVIEW_ROWS + 6))
  const win = createMemo(() => {
    const list = filtered()
    const start = Math.max(0, Math.min(clampedSel() - Math.floor(maxRows() / 2), Math.max(0, list.length - maxRows())))
    return { items: list.slice(start, start + maxRows()), start }
  })

  const active = (): LoadedSession | null => filtered()[clampedSel()] ?? null

  props.store.overlayKeyHandler = (key) => {
    if (key.name === "escape") {
      if (filter().length > 0 || filterFocused()) {
        setFilter("")
        setFilterFocused(false)
        setSel(0)
        return
      }
      props.onPick(null)
      return
    }
    if (key.name === "q" && filter().length === 0 && !filterFocused() && !key.ctrl && !key.meta) {
      props.onPick(null)
      return
    }
    if (isEnterKey(key) && !key.meta && !key.ctrl) {
      props.onPick(active()?.path ?? null)
      return
    }
    if (key.name === "backspace") {
      setFilter((f) => [...f].slice(0, -1).join(""))
      setSel(0)
      return
    }
    const vim = !filterFocused() && filter().length === 0
    const next = overlayNavStep(key as OverlayNavKey, {
      index: clampedSel(),
      count: filtered().length,
      pageSize: maxRows(),
      vim,
      wrap: false,
    })
    if (next !== null) {
      setSel(next)
      return
    }
    const ch = printableKeyText(key)
    if (ch !== null) {
      setFilterFocused(true)
      setFilter((f) => f + ch)
      setSel(0)
    }
  }

  // Paste types into the filter (routed by App through the overlay slot).
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    setFilterFocused(true)
    setFilter((f) => f + text)
    setSel(0)
  }

  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    const next = overlayNavStep(
      { name: dir === "up" ? "up" : "down", ctrl: false, meta: false, shift: false },
      { index: clampedSel(), count: filtered().length, pageSize: maxRows(), vim: false, wrap: false },
    )
    if (next !== null) setSel(next)
  }

  const previewLines = (): string[] => {
    const s = active()
    const width = Math.max(8, metrics().innerWidth - 2)
    const rows: string[] = s === null
      ? ["(no session selected)"]
      : [
          `title: ${s.title}`,
          `time: ${fmtTime(s.lastTs)}`,
          `messages: ${s.messages.filter((m) => m.role === "user").length}u / ${s.messages.filter((m) => m.role === "assistant").length}a`,
          `tags: ${s.tags.length > 0 ? s.tags.join(", ") : "(none)"}`,
          `path: ${s.path}`,
        ]
    const out: string[] = []
    for (let i = 0; i < PREVIEW_ROWS; i++) out.push((rows[i] ?? "").slice(0, width).padEnd(width))
    return out
  }

  return (
    <OverlayPanel title=" resume a session " onClose={() => props.onPick(null)}>
      <text selectable={false} style={{ fg: t().muted }}>
        {" / or type to filter · ↑/↓ or j/k pick · Enter resume · Esc/q fresh "}
      </text>
      <text selectable={false} style={{ fg: t().accent }}>{` filter: ${filter()}_ `}</text>
      <Show
        when={filtered().length > 0}
        fallback={<text selectable={false} style={{ fg: t().muted }}>{` (no sessions match "${filter()}") `}</text>}
      >
        <For each={win().items}>
          {(s, i) => {
            const idx = () => win().start + i()
            const selected = () => idx() === clampedSel()
            const hovered = () => hover() === idx()
            const label = s.title.length > 0 ? s.title : truncateWithEllipsis(s.firstUser ?? "(empty session)", 60)
            const width = Math.max(20, metrics().innerWidth - 10)
            return (
              <text selectable={false}
                style={overlayRowStyle(t(), selected(), t().fg, hovered())}
                onMouseOver={() => setHover(idx())}
                onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
                onMouseScroll={onWheel}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  setSel(idx())
                }}
              >
                {selected() ? "❯ " : "  "}
                <span style={{ fg: t().muted }}>{fmtTime(s.lastTs)} </span>
                <MatchSpans query={filter()} text={label.slice(0, width)} matchedFg={t().accent} plainFg={selected() ? t().accent : t().fg} bg="transparent" />
                <span style={{ fg: t().muted }}>
                  {" "}
                  {s.messages.filter((m) => m.role === "user").length}u / {s.messages.filter((m) => m.role === "assistant").length}a
                  {s.tags.length > 0 ? ` · ${s.tags.join(",")}` : ""}
                </span>
              </text>
            )
          }}
        </For>
      </Show>
      <box style={{ height: 1 }} />
      <OverlayPreview lines={previewLines()} rows={PREVIEW_ROWS} width={Math.max(8, metrics().innerWidth - 2)} fg={t().fg} muted={t().muted} />
    </OverlayPanel>
  )
}
