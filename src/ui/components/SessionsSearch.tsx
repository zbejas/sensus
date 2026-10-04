/**
 * SessionsSearch (Phase 1.6): full-screen overlay to search PAST chat sessions.
 * It reads the daemon REST session list (`GET /v1/sessions`) — the FTS5 index
 * (`src/session/indexDb.ts`) has no daemon endpoint, so filtering is
 * client-side over the newest pages.
 *
 * - With an empty filter the overlay lists the RECENT sessions newest-first
 *   (`index.list`), so `/sessions` is useful before you type anything. A row
 *   whose transcript is currently OPEN in a tab is marked like the tab bar: an
 *   accent `●` for the active tab, a muted `·` for another open tab, or the
 *   tab's activity glyph (`!` approval / streaming spinner) — so the overlay
 *   shows live sessions "like in tabs".
 * - A filter bar: type to search (Backspace edits, Esc closes). `/` focuses
 *   the filter so a query may start with vim navigation letters.
 * - A results list: arrow-marker selection (`overlayRowStyle`, accent fg only)
 *   + mouse hover fill; recents rows show the time, short id and title, while
 *   search rows show the role, short session id and the match snippet (matched
 *   characters highlighted via MatchSpans).
 * - A bounded detail pane below previews the selected row's session metadata /
 *   snippet.
 * - `Enter` ATTACHES: the selected transcript opens in a new tab (resumed via
 *   the same path `--resume` uses). Clicking a row only moves the selection.
 * - `Delete` (or Ctrl+D) asks to permanently delete the highlighted transcript
 *   (`y` confirms, `n`/Esc cancels, memory-manager pattern). A session that a
 *   tab is still appending to is refused; on success the file + sidecar are
 *   unlinked and the index row dropped, then the list reloads from the top.
 * - Infinite scroll: rows load a page at a time (`index.list`/`search` with an
 *   offset); nearing the bottom of the loaded window fetches the next page.
 * - Navigation reuses `overlayNavStep` (arrows, PgUp/PgDn, Home/End, and
 *   j/k/g/G while the filter is empty); the wheel moves the selection.
 *
 * Keys register through the store's single `overlayKeyHandler` dispatch — no
 * second global listener. Every row/span sets an explicit `bg` and a fixed
 * cell budget (opentui paint is additive + components run once).
 */

import { type JSX, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { type MouseEvent } from "@opentui/core"
import type { IndexedSession, SessionSearchHit } from "../../session/indexDb.ts"
import type { RestClient } from "../../client/restClient.ts"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { OverlayKey, UiStore } from "../lib/store.ts"
import { isEnterKey, keyChar, singleLinePaste } from "../../core/util.ts"
import { menuWindow } from "../chat/commandMenu.ts"
import { OverlayPanel, overlayRowStyle, backspaceFilter, overlayMetrics } from "./overlayKit.tsx"
import { MatchSpans } from "./overlay/MatchSpans.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"
import { tabActivity } from "../lib/tabs.ts"

export interface SessionsSearchProps {
  store: UiStore
  /** The daemon REST client (the daemon owns the transcripts; D13). */
  rest: RestClient
  /**
   * Attach to the selected transcript (Enter). App opens it in a new tab,
   * resuming the file for appends.
   */
  onAttach(path: string): void
  onClose(): void
}

/** Map a daemon session summary onto the overlay's `IndexedSession` shape. */
function toIndexed(s: { id: string; path: string; title: string; tags: string[]; messages: number; lastTs: number | null }): IndexedSession {
  return { path: s.path, sessionId: s.id, title: s.title, tags: s.tags, messages: s.messages, lastTs: s.lastTs, firstUser: null }
}

/** Derive `<instance>/<base>` from a transcript path (delete/context routes). */
function instanceBaseOf(path: string): { instance: string; base: string } | null {
  const m = /\/sessions\/([^/]+)\/([^/]+)\.jsonl$/.exec(path)
  return m === null ? null : { instance: m[1]!, base: m[2]! }
}

/** Fixed cells reserved for the short session id in a row. */
const SID_BUDGET = 16
/** Fixed cells reserved for the `YYYY-MM-DD HH:MM` timestamp in a recents row. */
const TIME_BUDGET = 16
/** Rows fetched per page (infinite scroll; the bridge caps one page at 100). */
const PAGE_SIZE = 50
/** Fetch the next page once the selection is within this many rows of the end. */
const PREFETCH = 5
/** Detail-pane rows below the list. */
const DETAIL_ROWS = 4

/** Last `SID_BUDGET` characters of a session id (the disambiguating tail). */
export function shortSessionId(id: string): string {
  return [...id].slice(-SID_BUDGET).join("")
}

/** Wrap `text` into fixed-width lines, capped at `maxRows` (pure). */
export function wrapSnippet(text: string, width: number, maxRows: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i < chars.length && out.length < maxRows; i += w) {
    out.push(chars.slice(i, i + w).join(""))
  }
  if (out.length === 0) out.push("")
  return out
}

/** `YYYY-MM-DD HH:MM` in local time; `?` when the session had no timestamp. */
export function fmtSessionTs(ts: number | null): string {
  if (ts === null) return "?"
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * What the row shows for a session that is open in a tab, mirroring the tab
 * bar (docs/DESIGN.md "Tab bar"): the tab's activity glyph when it is busy,
 * else the accent `●` for the active tab or a muted `·` for another open tab.
 * `text` is always exactly 2 cells so the row budget stays fixed.
 */
export interface OpenMark {
  text: string
  tone: "accent" | "warning" | "muted"
  /** 1-based tab position (for the detail note). */
  index: number
  active: boolean
}

/** Build the 2-cell tab-style marker for one open tab (pure). */
export function openMarkFor(tab: {
  active: boolean
  index: number
  activity: { glyph: string; tone: string } | null
}): OpenMark {
  const glyph = tab.activity?.glyph
  if (glyph !== undefined && glyph.length > 0) {
    return { text: `${glyph} `, tone: tab.activity?.tone === "warning" ? "warning" : "accent", index: tab.index, active: tab.active }
  }
  return tab.active
    ? { text: "● ", tone: "accent", index: tab.index, active: true }
    : { text: "· ", tone: "muted", index: tab.index, active: false }
}

/** The fixed-budget segments of one recents (session-level) row. */
export interface RecentsRowParts {
  pre: string
  marker: string
  markerTone: "accent" | "warning" | "muted"
  time: string
  sid: string
  title: string
  pad: string
}

/** Lay out a recents row to a fixed `budget` so stale paint never survives. */
export function recentsRowParts(s: IndexedSession, selected: boolean, budget: number, mark?: OpenMark): RecentsRowParts {
  const pre = selected ? " ❯ " : "   "
  const marker = mark?.text ?? "  "
  const time = `${fmtSessionTs(s.lastTs).padEnd(TIME_BUDGET)} `
  const sid = `${[...shortSessionId(s.sessionId)].slice(0, SID_BUDGET).join("").padEnd(SID_BUDGET)} `
  const used = pre.length + marker.length + time.length + sid.length
  const titleBudget = Math.max(0, budget - used)
  const title = [...s.title].slice(0, titleBudget).join("")
  const pad = " ".repeat(Math.max(0, budget - used - [...title].length))
  return { pre, marker, markerTone: mark?.tone ?? "muted", time, sid, title, pad }
}

/** The ` · open in tab N (active)` note for a row whose session is open. */
function openNote(mark: OpenMark | undefined): string {
  if (mark === undefined) return ""
  return ` · open in tab ${mark.index}${mark.active ? " (active)" : ""}`
}

/** The detail pane for a selected recents (session-level) row (pure). */
export function recentsDetailLines(s: IndexedSession, width: number, rows: number, mark?: OpenMark): string[] {
  const head = ` ${s.sessionId} · ${fmtSessionTs(s.lastTs)} · ${s.messages} msg${s.tags.length > 0 ? ` · ${s.tags.join(",")}` : ""}${openNote(mark)}`
  const title = ` ${s.title.length > 0 ? s.title : "(untitled session)"}`
  const body = wrapSnippet(s.firstUser ?? "(no messages)", width, Math.max(1, rows - 2))
  return [head, title, ...body]
}

/** The detail pane for a selected search hit (pure). */
export function hitDetailLines(hit: SessionSearchHit, width: number, rows: number, mark?: OpenMark): string[] {
  const when = hit.ts !== null ? new Date(hit.ts).toISOString().replace("T", " ").slice(0, 19) : "unknown time"
  const head = ` ${hit.role} · ${hit.title.length > 0 ? hit.title : hit.sessionId} #${hit.messageIndex} · ${when}${hit.tags.length > 0 ? ` · ${hit.tags.join(",")}` : ""}${openNote(mark)}`
  const body = wrapSnippet(hit.snippet, width, Math.max(1, rows - 2))
  return [head, ` ${hit.path}`, ...body]
}

export function SessionsSearch(props: SessionsSearchProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [filter, setFilter] = createSignal("")
  const [sel, setSel] = createSignal(0)
  const [hover, setHover] = createSignal<number | null>(null)
  /** `/` (or any typed char) focuses the filter: vim j/k/g/G then TYPE. */
  const [filterFocused, setFilterFocused] = createSignal(false)
  /** Loaded pages (infinite scroll): search hits while filtering, else recents. */
  const [hits, setHits] = createSignal<SessionSearchHit[]>([])
  const [recents, setRecents] = createSignal<IndexedSession[]>([])
  /** True while the last fetched page was full (there may be more rows). */
  const [hasMore, setHasMore] = createSignal(false)
  /** A pending destructive confirm: `y` deletes, `n`/Esc cancels. */
  const [confirm, setConfirm] = createSignal<{ path: string; title: string } | null>(null)

  /** The trimmed query; empty means "show recents". */
  const query = (): string => filter().trim()
  const searching = (): boolean => query().length > 0

  /** Fetch one REST page (`/v1/sessions`) mapped to the overlay's shape. */
  const fetchPage = async (offset: number): Promise<IndexedSession[]> => {
    const res = await props.rest.sessions({ limit: PAGE_SIZE, offset })
    return res.sessions.map(toIndexed)
  }

  /** A title-match "hit" (the daemon exposes no FTS endpoint; see the header). */
  const toHit = (s: IndexedSession): SessionSearchHit => ({
    path: s.path,
    sessionId: s.sessionId,
    title: s.title,
    role: "user",
    ts: s.lastTs,
    messageIndex: 0,
    snippet: s.title.length > 0 ? s.title : "(untitled session)",
    tags: s.tags,
  })

  /** Fetch page 0 for `q` (recents when empty): replaces the loaded rows. */
  const loadFirstPage = (q: string): void => {
    void (async () => {
      try {
        if (q.length === 0) {
          setHits([])
          const page = await fetchPage(0)
          setRecents(page)
          setHasMore(page.length >= PAGE_SIZE)
        } else {
          setRecents([])
          // No daemon FTS: filter the newest page by title/id client-side.
          const needle = q.toLowerCase()
          const page = await fetchPage(0)
          setHits(page.filter((s) => s.title.toLowerCase().includes(needle) || s.sessionId.toLowerCase().includes(needle)).map(toHit))
          setHasMore(false)
        }
      } catch {
        setHits([])
        setRecents([])
        setHasMore(false)
      }
    })()
  }

  /** Append the next page (scroll-near-the-end). No-op at the end of data. */
  const loadMore = (): void => {
    if (!hasMore() || searching()) return
    void (async () => {
      try {
        const next = await fetchPage(recents().length)
        setRecents((prev) => [...prev, ...next])
        setHasMore(next.length >= PAGE_SIZE)
      } catch {
        setHasMore(false)
      }
    })()
  }

  // A filter change starts a fresh list (selection + hover reset). The effect
  // also owns the initial load, so the overlay is usable on first paint.
  createEffect(() => {
    const q = query()
    setSel(0)
    setHover(null)
    loadFirstPage(q)
  })

  /** The active row count: recents while empty, search hits while filtering. */
  const count = (): number => (searching() ? hits().length : recents().length)

  /** Widen the loaded window when the selection nears the bottom. */
  const maybeLoadMore = (): void => {
    if (count() > 0 && sel() >= count() - PREFETCH) loadMore()
  }

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: filter + spacer + DETAIL_ROWS preview + hint.
  const maxRows = () => Math.max(3, metrics().innerHeight - (DETAIL_ROWS + 3))
  /** Fixed cell budget for rows and the detail pane (stale-paint rule). */
  const rowWidth = () => Math.max(12, metrics().innerWidth - 2)

  const win = createMemo(() => {
    const w = menuWindow(count(), sel(), maxRows())
    return { len: w.list, start: w.start, selIdx: w.selIdx }
  })

  const selectedHit = (): SessionSearchHit | undefined => (searching() ? hits()[win().selIdx] : undefined)
  const selectedRecents = (): IndexedSession | undefined => (searching() ? undefined : recents()[win().selIdx])

  /** The path of the highlighted row (recents or hit), for Enter-attach. */
  const selectedPath = (): string | null =>
    (searching() ? selectedHit()?.path : selectedRecents()?.path) ?? null

  /** The path + title of the highlighted row, for the delete confirm. */
  const selectedRef = (): { path: string; title: string } | null => {
    if (searching()) {
      const hit = selectedHit()
      return hit === undefined ? null : { path: hit.path, title: hit.title }
    }
    const s = selectedRecents()
    return s === undefined ? null : { path: s.path, title: s.title }
  }

  /**
   * The tab-style markers for transcripts currently open in THIS client, keyed
   * by absolute session path. Reactive over the tab list + active tab, so
   * opening/closing/switching a tab refreshes the overlay (Solid runs once).
   */
  const openMarks = createMemo<Map<string, OpenMark>>(() => {
    const map = new Map<string, OpenMark>()
    const activeId = props.store.activeTabId()
    props.store.tabs().forEach((tab, i) => {
      const p = tab.chat.sessionFilePath
      if (typeof p !== "string" || p.length === 0) return
      map.set(p, openMarkFor({ active: tab.id === activeId, index: i + 1, activity: tabActivity(tab) }))
    })
    return map
  })

  /** Session files a tab is still writing to — never unlink one out from under it. */
  const openSessionPaths = (): Set<string> => new Set(openMarks().keys())

  /** Confirm handler: DELETE the transcript + sidecar on the daemon, reload. */
  const performDelete = (ref: { path: string; title: string }): void => {
    if (openSessionPaths().has(ref.path)) {
      props.store.showToast("can't delete a session that's open in a tab — close the tab first", "warn", 4000)
      return
    }
    const ib = instanceBaseOf(ref.path)
    if (ib === null) {
      props.store.showToast("couldn't delete that session", "warn", 3000)
      return
    }
    void (async () => {
      try {
        const res = await props.rest.deleteSession(ib.instance, ib.base)
        if (res.ok) props.store.showToast(`deleted session "${ref.title}"`, "success", 2500)
        else props.store.showToast(res.message ?? "couldn't delete that session", "warn", 3000)
      } catch {
        props.store.showToast("couldn't delete that session", "warn", 3000)
      }
      // Re-list from page 0 so paging offsets stay valid, keeping the selection
      // clamped to the same place in the now-shorter list.
      const keep = sel()
      loadFirstPage(query())
      setSel(Math.max(0, Math.min(keep, Math.max(0, count() - 1))))
      maybeLoadMore()
    })()
  }

  const detailLines = createMemo<string[]>(() => {
    if (searching()) {
      const hit = selectedHit()
      if (hit === undefined) return [" no match selected — type to search past sessions "]
      return hitDetailLines(hit, rowWidth(), DETAIL_ROWS, openMarks().get(hit.path))
    }
    const s = selectedRecents()
    if (s === undefined) return [" no past sessions yet "]
    return recentsDetailLines(s, rowWidth(), DETAIL_ROWS, openMarks().get(s.path))
  })

  const nav = (key: OverlayNavKey): number | null =>
    overlayNavStep(key, {
      index: sel(),
      count: count(),
      pageSize: maxRows(),
      vim: !filterFocused() && filter() === "",
      wrap: true,
    })

  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    setConfirm(null)
    const next = overlayNavStep(
      { name: dir === "up" ? "up" : "down", ctrl: false, meta: false, shift: false },
      { index: sel(), count: count(), pageSize: maxRows(), vim: false, wrap: true },
    )
    if (next !== null) setSel(next)
    maybeLoadMore()
  }

  const handleOverlayKey = (key: OverlayKey): void => {
    // A pending delete confirm is modal: y deletes, n/Esc cancels (the same
    // destructive-confirm shape the memory manager uses).
    const pending = confirm()
    if (pending !== null) {
      if (key.name === "escape") {
        setConfirm(null)
        return
      }
      const c = keyChar(key)
      if (!key.ctrl && !key.meta && (c === "y" || c === "Y")) {
        setConfirm(null)
        performDelete(pending)
        return
      }
      if (!key.ctrl && !key.meta && (c === "n" || c === "N")) setConfirm(null)
      return
    }
    if (key.name === "escape") {
      props.onClose()
      return
    }
    // Del / Ctrl+D asks to delete the highlighted transcript.
    if ((key.name === "delete" && !key.ctrl && !key.meta) || (key.ctrl && key.name === "d")) {
      const ref = selectedRef()
      if (ref !== null) setConfirm(ref)
      return
    }
    if (key.name === "/" && !key.ctrl && !key.meta && !key.shift) {
      setFilterFocused(true)
      return
    }
    const next = nav(key)
    if (next !== null) {
      setSel(next)
      maybeLoadMore()
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
      return
    }
    // Enter opens the highlighted transcript in a new tab (Esc closes).
    if (isEnterKey(key) && !key.ctrl && !key.meta) {
      const path = selectedPath()
      if (path !== null) props.onAttach(path)
    }
  }
  props.store.overlayKeyHandler = handleOverlayKey
  // Paste types into the filter (same effect as the keystrokes above, one chunk).
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    setFilterFocused(true)
    setFilter((f) => f + text)
    setSel(0)
  }

  return (
    <OverlayPanel title=" session search " onClose={props.onClose}>
      <text selectable={false} style={{ fg: t().accent, bg: "transparent" }}>
        {` filter: ${filter()}_`.padEnd(rowWidth())}
      </text>
      <Show
        when={count() > 0}
        fallback={
          <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>
            {` ${searching() ? `no matches for "${filter()}"` : "no past sessions yet"} `.padEnd(rowWidth())}
          </text>
        }
      >
        <Show
          when={!searching()}
          fallback={
            <For each={hits().slice(win().start, win().start + win().len)}>
              {(hit, i) => {
                const idx = () => win().start + i()
                const selected = () => idx() === win().selIdx
                const hovered = () => hover() === idx()
                const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
                const rowBg = (): ThemeColor => rs().bg as ThemeColor
                const rowFg = (): ThemeColor => rs().fg as ThemeColor
                const parts = () => {
                  const budget = rowWidth()
                  const pre = selected() ? " ❯ " : "   "
                  const mark = openMarks().get(hit.path)
                  const marker = mark?.text ?? "  "
                  const tag = hit.role === "assistant" ? "[asst] " : "[user] "
                  const sid = [...shortSessionId(hit.sessionId)]
                    .slice(0, SID_BUDGET)
                    .join("")
                    .padEnd(SID_BUDGET)
                  const used = pre.length + marker.length + tag.length + SID_BUDGET
                  const snipBudget = Math.max(0, budget - used)
                  const snippet = [...hit.snippet].slice(0, snipBudget).join("")
                  const pad = " ".repeat(Math.max(0, budget - used - [...snippet].length))
                  return { pre, marker, markerTone: mark?.tone ?? "muted", tag, sid, snippet, pad }
                }
                const markerFg = (): ThemeColor =>
                  parts().markerTone === "warning" ? t().warning : parts().markerTone === "accent" ? t().accent : t().muted
                return (
                  <text selectable={false}
                    style={rs()}
                    onMouseOver={() => setHover(idx())}
                    onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
                    onMouseScroll={onWheel}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setConfirm(null)
                      setSel(idx())
                      maybeLoadMore()
                    }}
                  >
                    <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().pre}</span>
                    <span style={{ fg: markerFg(), bg: rowBg() }}>{parts().marker}</span>
                    <span style={{ fg: t().muted, bg: rowBg() }}>{parts().tag}</span>
                    <span style={{ fg: t().accent, bg: rowBg() }}>{parts().sid}{" "}</span>
                    <MatchSpans
                      query={filter()}
                      text={parts().snippet}
                      matchedFg={t().accent}
                      plainFg={rowFg()}
                      bg={rowBg()}
                    />
                    <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().pad}</span>
                  </text>
                )
              }}
            </For>
          }
        >
          <For each={recents().slice(win().start, win().start + win().len)}>
            {(s, i) => {
              const idx = () => win().start + i()
              const selected = () => idx() === win().selIdx
              const hovered = () => hover() === idx()
              const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
              const rowBg = (): ThemeColor => rs().bg as ThemeColor
              const rowFg = (): ThemeColor => rs().fg as ThemeColor
              const parts = () => recentsRowParts(s, selected(), rowWidth(), openMarks().get(s.path))
              const markerFg = (): ThemeColor =>
                parts().markerTone === "warning" ? t().warning : parts().markerTone === "accent" ? t().accent : t().muted
              return (
                <text selectable={false}
                  style={rs()}
                  onMouseOver={() => setHover(idx())}
                  onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
                  onMouseScroll={onWheel}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    setConfirm(null)
                    setSel(idx())
                    maybeLoadMore()
                  }}
                >
                  <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().pre}</span>
                  <span style={{ fg: markerFg(), bg: rowBg() }}>{parts().marker}</span>
                  <span style={{ fg: t().muted, bg: rowBg() }}>{parts().time}</span>
                  <span style={{ fg: t().accent, bg: rowBg() }}>{parts().sid}</span>
                  <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().title}{parts().pad}</span>
                </text>
              )
            }}
          </For>
        </Show>
      </Show>
      <box style={{ height: 1 }} />
      <OverlayPreview lines={detailLines()} rows={DETAIL_ROWS} width={rowWidth()} fg={t().fg} muted={t().muted} />
      <Show
        when={confirm()}
        fallback={
          <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>
            {" recent sessions · type to search · ↑/↓/j/k pick · Enter open · ● open tab · Del delete · Esc close ".padEnd(rowWidth())}
          </text>
        }
      >
        <text selectable={false} style={{ fg: t().danger, bg: "transparent" }}>
          {` delete "${confirm()?.title ?? ""}"?  y confirm · n/Esc cancel `.padEnd(rowWidth())}
        </text>
      </Show>
    </OverlayPanel>
  )
}
