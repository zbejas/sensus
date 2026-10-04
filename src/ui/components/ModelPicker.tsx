/**
 * ModelPicker: full-screen overlay listing the models of EVERY configured
 * endpoint (fetches each endpoint's /models in parallel; failures show as a
 * per-endpoint note, never kill the picker), enriched with models.dev
 * metadata MERGED with the endpoint's config overrides
 * (endpoints.<name>.models.<id> — docs/config.md). Endpoint order is
 * preserved; models list in each endpoint's own order. Fuzzy-filter as you
 * type; typing `endpoint@` scopes the filter to one endpoint.
 *
 * Enter PICKS the model: the pick applies to the CURRENT session and is
 * PERSISTED as the config default for NEW sessions (`model =
 * "<endpoint>@<id>"` in config.json — the last pick survives relaunches);
 * other already-open tabs are untouched (docs/config.md). The row tag shows
 * the current selection.
 *
 * Shared overlay primitives (M12 0.4): matched characters in the
 * `endpoint · id` label highlight via MatchSpans; navigation (arrows,
 * PgUp/PgDn, Home/End, vim j/k/g/G while the filter is empty) is resolved by
 * overlayNavStep; the mouse wheel moves the selection; a bounded detail pane
 * previews the highlighted model. Keys: type to filter · ↑/↓ pick · Enter
 * select (persists) · Esc close. Every row is clickable. A footer line names
 * models.dev as the metadata source (config overrides win).
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { type MouseEvent } from "@opentui/core"
import { formatContextLimit, type CatalogModel } from "../../engine/index.ts"
import { fuzzyScore } from "../lib/fuzzy.ts"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { UiStore, OverlayKey } from "../lib/store.ts"
import { isEnterKey, keyChar, singleLinePaste } from "../../core/util.ts"
import { menuWindow } from "../chat/commandMenu.ts"
import { OverlayPanel, overlayRowStyle, backspaceFilter, overlayMetrics } from "./overlayKit.tsx"
import { MatchSpans } from "./overlay/MatchSpans.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface ModelPickerProps {
  store: UiStore
  /** Load the daemon's enriched, credential-free catalog (`/v1/models`). */
  loadModels: () => Promise<{ models: PickerModel[]; errors: string[] }>
  /** The CURRENT session's selection (`endpoint@model`; tags the active row). */
  selectedModel: string
  /** Persist + apply the pick (`<endpoint>@<model>`); returns an error or null. */
  onPick: (endpoint: string, model: string) => string | null
  onClose: () => void
}

/** One row: a model resolved against its endpoint (+ the merged metadata). */
export interface PickerModel extends CatalogModel {
  endpoint: string
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; models: PickerModel[]; errors: string[] }

export function ErrorMessage(props: { message: string }): JSX.Element {
  return (
    <text selectable={false} style={{ fg: theme().danger }}> endpoint failed: {props.message} </text>
  )
}

/**
 * Filter + rank. EMPTY query: the endpoints' own order, verbatim (proxies
 * like LiteLLM curate it — never reshuffle). NON-empty query: fuzzy score
 * over id AND display name AND `endpoint@id`, best first, ties keep the
 * source order. Embeddings-only models stay in the list (tagged) so an
 * endpoint can still pick them.
 */
export function rankModels(models: readonly PickerModel[], query: string): PickerModel[] {
  if (query.length === 0) return [...models]
  const q = query.toLowerCase()
  const scoped = q.includes("@") ? q.split("@", 2) : null
  const scopedEndpoint = scoped !== null ? (scoped[0] ?? "") : null
  const scopedQuery = scoped !== null ? (scoped[1] ?? "") : q
  const effective = scopedQuery.length > 0 ? scopedQuery : ""
  if (scopedEndpoint !== null && effective.length === 0) {
    // "endpoint@" alone: scope without filtering.
    return models.filter((m) => m.endpoint.toLowerCase().includes(scopedEndpoint))
  }
  const scored: Array<{ m: PickerModel; score: number; at: number }> = []
  models.forEach((m, at) => {
    if (scopedEndpoint !== null && !m.endpoint.toLowerCase().includes(scopedEndpoint)) return
    if (effective.length === 0) {
      scored.push({ m, score: 0, at })
      return
    }
    const idScore = fuzzyScore(effective, m.id)
    const nameScore = m.meta?.name !== null && m.meta?.name !== undefined ? fuzzyScore(effective, m.meta.name) : null
    const epScore = fuzzyScore(effective, `${m.endpoint}/${m.id}`)
    const candidates = [idScore, nameScore, epScore].filter((s): s is number => s !== null)
    if (candidates.length === 0) return
    scored.push({ m, score: Math.max(...candidates), at })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((s) => s.m)
}

/** Yes/no/unknown rendering for a tri-state metadata flag. */
function tri(value: boolean | null | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "?"
}

/**
 * Bounded detail-pane lines for the highlighted model: endpoint, id, display
 * name, context limit, tool-call support, reasoning, owner and endpoint
 * types, plus the `← active` tag when this is the session's current model.
 * Pure so it is unit-tested without a renderer.
 */
export function modelDetailLines(m: PickerModel, activeModel: string): string[] {
  const name = m.meta?.name ?? null
  const ctx = formatContextLimit(m.meta?.context ?? null) ?? "?"
  const types = m.endpointTypes.length > 0 ? m.endpointTypes.join(", ") : "—"
  const here = `${m.endpoint}@${m.id}` === activeModel ? "  ← active" : ""
  return [
    ` ${m.endpoint}@${m.id}${m.chat ? "" : " (embeddings)"}${here}`,
    ` name       ${name ?? "(unknown)"}`,
    ` context    ${ctx} · tools ${tri(m.meta?.toolCall)} · reasoning ${tri(m.meta?.reasoning)}`,
    ` owned by   ${m.ownedBy ?? "—"} · types ${types}`,
  ]
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [state, setState] = createSignal<LoadState>({ phase: "loading" })
  const [filter, setFilter] = createSignal("")
  const [sel, setSel] = createSignal(0)
  /** `/` (or any typed char) focuses the filter: vim j/k/g/G then TYPE. */
  const [filterFocused, setFilterFocused] = createSignal(false)
  /** Mouse hover highlight (row index); cleared when the pointer leaves. */
  const [hover, setHover] = createSignal<number | null>(null)
  let disposed = false

  onMount(() => {
    void (async () => {
      let models: PickerModel[] = []
      let errors: string[] = []
      try {
        const loaded = await props.loadModels()
        models = loaded.models
        errors = loaded.errors
      } catch (e) {
        errors = [e instanceof Error ? e.message : String(e)]
      }
      if (disposed) return
      setState({ phase: "ready", models, errors })
      props.store.bumpModelInfo()
    })()
  })

  onCleanup(() => {
    disposed = true
  })

  const ranked = createMemo(() => {
    const st = state()
    if (st.phase !== "ready") return []
    return rankModels(st.models, filter().toLowerCase())
  })

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + 4-row detail pane + metadata note + filter + hint.
  const maxRows = () => Math.max(3, metrics().innerHeight - 8)
  /** Fixed cell budget for rows and the detail pane (stale-paint rule). */
  const rowWidth = () => Math.max(8, metrics().innerWidth - 2)
  const win = createMemo(() => {
    const items = ranked()
    const w = menuWindow(items.length, sel(), maxRows())
    return { rows: items.slice(w.start, w.start + w.list), start: w.start, selIdx: w.selIdx }
  })

  /** The fuzzy query actually matched against the primary label: an
   * `endpoint@` scope is stripped (it selects an endpoint, not characters). */
  const matchQuery = (): string => {
    const q = filter()
    const at = q.indexOf("@")
    return at >= 0 ? q.slice(at + 1) : q
  }

  const detailLines = createMemo<string[]>(() => {
    const m = ranked()[win().selIdx]
    return m === undefined ? [" no model selected "] : modelDetailLines(m, props.selectedModel)
  })

  /**
   * Apply one picked model: persists `<endpoint>@<id>` as the config default
   * (for NEW sessions) and applies it to the CURRENT session — the caller's
   * onPick owns both halves (docs/config.md).
   */
  const applyChoice = (m: PickerModel): void => {
    const err = props.onPick(m.endpoint, m.id)
    if (err !== null) props.store.showToast(`model save failed: ${err}`, "error", 4500)
    else props.store.showToast(`model → ${m.endpoint}@${m.id} (this session + default for new ones)`, "success", 2500)
    props.onClose()
  }

  const nav = (key: OverlayNavKey): number | null =>
    overlayNavStep(key, {
      index: sel(),
      count: ranked().length,
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
      { index: sel(), count: ranked().length, pageSize: maxRows(), vim: false, wrap: true },
    )
    if (next !== null) setSel(next)
  }

  // App routes ALL keys through store.overlayKeyHandler while the overlay is
  // open (multiple useKeyboard listeners would double-handle).
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
      const model = ranked()[win().selIdx]
      if (model) applyChoice(model)
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

  const errorLines = (): string[] => {
    const st = state()
    return st.phase === "ready" ? st.errors : []
  }

  return (
    <OverlayPanel title=" model picker " onClose={props.onClose}>
      <Show
        when={state().phase !== "loading"}
        fallback={<text selectable={false} style={{ fg: t().muted }}> loading models from the daemon… </text>}
      >
        <For each={win().rows}>
          {(m, i) => {
            const idx = () => win().start + i()
            const selected = () => idx() === win().selIdx
            const hovered = () => hover() === idx()
            const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), m.chat ? t().fg : t().muted, hovered())
            const rowBg = (): ThemeColor => rs().bg as ThemeColor
            const rowFg = (): ThemeColor => rs().fg as ThemeColor
            const arrow = () => (selected() ? " ❯ " : "   ")
            const label = () => {
              const tag = m.chat ? "" : " (embeddings)"
              return `${m.endpoint} · ${m.id}${tag}`
            }
            const rest = () => {
              const name = m.meta?.name ?? null
              const ctx = formatContextLimit(m.meta?.context ?? null) ?? "?"
              const tools = m.meta?.toolCall === true ? "✓" : m.meta?.toolCall === false ? "✗" : "?"
              const think = m.meta?.reasoning === true ? "· think" : ""
              const here = `${m.endpoint}@${m.id}` === props.selectedModel ? "  ← active" : ""
              return `  ${name ?? ""}  ${ctx}  tools ${tools} ${think}${here}`
            }
            const parts = () => {
              const budget = rowWidth()
              const pre = arrow()
              const fullLabel = label()
              const labelBudget = Math.max(0, budget - pre.length)
              const shownLabel = [...fullLabel].slice(0, labelBudget).join("")
              const restBudget = Math.max(0, budget - pre.length - shownLabel.length)
              const shownRest = [...rest()].slice(0, restBudget).join("")
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
                  const model = ranked()[idx()]
                  if (model) applyChoice(model)
                }}
              >
                <span style={{ fg: rowFg(), bg: rowBg() }}>{parts().pre}</span>
                <MatchSpans
                  query={matchQuery()}
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
        <Show when={state().phase === "ready" && ranked().length === 0}>
          <text selectable={false} style={{ fg: t().muted }}> no models match "{filter()}" </text>
        </Show>
        <For each={errorLines()}>
          {(line) => <ErrorMessage message={line} />}
        </For>
      </Show>
      <box style={{ height: 1 }} />
      <OverlayPreview lines={detailLines()} rows={4} width={rowWidth()} fg={t().fg} muted={t().muted} />
      <text selectable={false} style={{ fg: t().muted }}> metadata fetched from models.dev · your config overrides win </text>
      <text selectable={false} style={{ fg: t().accent }}> filter: {filter()}_ </text>
      <text selectable={false} style={{ fg: t().muted }}>
        {" type to filter (endpoint@ scopes) · ↑/↓/j/k pick · Enter select (persists) · Esc close "}
      </text>
    </OverlayPanel>
  )
}
