/**
 * SettingsScreen (rail + detail rework): full-screen settings
 * overlay with a LEFT nav rail and a RIGHT detail pane.
 *
 * - Rail categories (fixed order): Endpoints · Model · Agent · Appearance ·
 *   Chat · Context · MCP servers · Memory.
 * - Endpoints: endpoint list (+ "+ add endpoint") in the detail pane;
 *   selecting one opens its editor (name, baseURL, apiKey masked with
 *   show/hide, test connection, provider, temperature, maxTokens,
 *   thinkingMode, model metadata overrides, browse models, delete with an
 *   inline y/N confirm, back to list).
 * - The settings that were previously read-only/hand-edited are now first
 *   class: model metadata + per-endpoint request knobs, chat display
 *   (thinking/toolOutput/animations), context/compaction, MCP enable toggles.
 * - Every section ends with an "Advanced…" row (when it has any) that opens a
 *   nested submenu one level deeper; Appearance's holds the themePalette color
 *   overrides plus runtime facts.
 * - Type-to-filter (Ctrl+P style): printable keys build a query; while it is
 *   non-empty the body is a FLAT fuzzy-ranked list across ALL categories
 *   (`ui/chat/settingsFilter.ts`), each row tagged with `[category]`.
 * - vim + paging: Up/Down, j/k/g/G (navigation only while the filter is
 *   empty), PgUp/PgDn/Home/End always navigate. No wrap — clamped.
 * - Esc chain: cancel an in-progress edit → clear a non-empty filter → close.
 * - Destructive actions (delete endpoint, clear palette, reset colors) ask
 *   inline `…? y/N`; a single Enter never destroys anything.
 * - Every edit persists to the REAL config file via props.persistDoc
 *   (unknown keys preserved, atomic write, one-time .bak). Fully
 *   keyboard-navigable and clickable; the backdrop click closes.
 *
 * Keys go through the store's single overlayKeyHandler dispatch (never a
 * second listener). Every row sets an explicit bg via overlayRowStyle and a
 * fixed cell budget so shrinking text cannot leave stale cells.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { type AgentDef, type LayoutMode, type RawConfigDoc, type SensusConfig, parseSelectedModel, parseThinkingMode, canonicalProvider, PROTOCOL_KINDS, PROTOCOLS, type ProtocolKind } from "../../engine/index.ts"
import { theme, isThemeName, type ThemeColor } from "../../theme/theme.ts"
import { parseHexColor } from "../../theme/themePalette.ts"
import type { ToastLevel } from "../lib/toast.ts"
import type { OverlayKey, UiStore } from "../lib/store.ts"
import { cps, isEnterKey, isRecord, keyChar, singleLinePaste, truncateWithEllipsis } from "../../core/util.ts"
import { OverlayPanel, overlayRowStyle, backspaceFilter, overlayMetrics } from "./overlayKit.tsx"
import { SETTINGS_CATEGORIES, filterSettings, stepIndex, cycleOption } from "../chat/settingsFilter.ts"
import { settingsSeedDoc, readEndpoints, num, str, type EndpointDraft } from "../chat/settingsDoc.ts"

export interface SettingsScreenProps {
  /** The UI store (overlay key-handler registration). */
  store: UiStore
  /** Boot/resolved config (bootstrap for a missing file). */
  config: SensusConfig
  /** The raw (secret-free) config document (the daemon's, D13). */
  rawConfig: Record<string, unknown>
  /** Loaded agents (docs/agents.md) — the default-agent cycle lists these. */
  agents: AgentDef[]
  /** Write the full document (preserving unknown keys) + reload config.
   * Returns an error message or null. */
  persistDoc: (doc: RawConfigDoc) => string | null
  /** Probe the draft endpoint through the daemon (`POST /v1/models/probe`). */
  testConnection: (draft: { provider?: string; baseURL: string; apiKey: string }) => Promise<{ ok: boolean; error?: string; models?: Array<{ chat?: boolean }> }>
  /** Live chat sidebar width application (global field commit). */
  onSidebarWidth: (cols: number) => void
  /** Live layout-mode application (Appearance → layout cycle). */
  onLayoutMode: (mode: LayoutMode) => void
  /** Live vertical tab-rail width application (Appearance → tab rail width). */
  onTabRailWidth: (cols: number) => void
  /** Open the theme picker overlay (Appearance → theme). */
  onPickTheme: () => void
  /** Open the model picker (picking sets the global selected model). */
  onBrowseModels: (endpointName: string) => void
  toast: (message: string, level?: ToastLevel, ttlMs?: number) => void
  onClose: () => void
}

type TestState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "ok"; message: string }
  | { phase: "fail"; message: string }

/** One actionable row in a detail pane (or a filter hit). */
interface Field {
  id: string
  label: string
  kind: "text" | "masked" | "button" | "cycle" | "pick"
  value?: string
  /** Value used to seed a text edit when it differs from the display value
   * (masked fields: the masked display must not become the draft). */
  editValue?: string
  hint?: string
  /** Optional longer display label (defaults to `label`). */
  display?: string
  onCommit?: (v: string) => string | null
  onActivate?: () => void
  onCycle?: (dir: 1 | -1) => void
}

interface ConfirmState {
  message: string
  onYes: () => void
}

/** Left rail width (columns), including its right border. */
const RAIL_WIDTH = 24

/** Test-connection result line (separate component for type narrowing). */
function TestResultLine(props: { test: TestState }): JSX.Element {
  const t = () => theme()
  const text = (): string => {
    const st = props.test
    if (st.phase === "running") return " test connection: testing… "
    if (st.phase === "ok") return ` test connection: ok — ${st.message} `
    if (st.phase === "fail") return ` test connection: FAILED — ${st.message} `
    return ""
  }
  const color = (): ThemeColor => {
    const st = props.test
    if (st.phase === "ok") return t().success
    if (st.phase === "fail") return t().danger
    return t().muted
  }
  return <text selectable={false} style={{ fg: color() }}>{text()}</text>
}

/** Cursor-highlighted text for an in-progress edit (one line). Props are
 * accessors so the cursor + draft stay reactive (the component body runs once). */
function EditableValue(props: { text: () => string; cursor: () => number }): JSX.Element {
  const t = () => theme()
  const chars = (): string[] => [...props.text()]
  const col = (): number => Math.min(props.cursor(), chars().length)
  const before = (): string => chars().slice(0, col()).join("")
  const cursorCh = (): string => chars()[col()] ?? " "
  const after = (): string => chars().slice(col() + 1).join("")
  return (
    <span>
      {before().length > 0 && <span>{before()}</span>}
      <span style={{ fg: t().onAccent, bg: t().accent }}>{cursorCh()}</span>
      {after().length > 0 && <span>{after()}</span>}
    </span>
  )
}

function RailRow(props: {
  label: string
  idx: number
  selected: () => boolean
  hovered: () => boolean
  budget: () => number
  onHover: (on: boolean) => void
  onPick: (idx: number) => void
}): JSX.Element {
  const t = () => theme()
  const text = (): string => ` ${props.selected() ? "❯ " : "  "}${props.label}`.padEnd(props.budget())
  return (
    <text selectable={false}
      style={{ ...overlayRowStyle(t(), props.selected(), t().fg, props.hovered()) }}
      onMouseOver={() => props.onHover(true)}
      onMouseOut={() => props.onHover(false)}
      onMouseDown={(e) => {
        e.stopPropagation()
        props.onPick(props.idx)
      }}
    >
      {text()}
    </text>
  )
}

function FilterRow(props: {
  label: string
  category: string
  idx: number
  selected: () => boolean
  hovered: () => boolean
  budget: () => number
  onHover: (on: boolean) => void
  onPick: (idx: number) => void
}): JSX.Element {
  const t = () => theme()
  const tag = (): string => ` [${props.category}]`
  const text = (): string => {
    const body = truncateWithEllipsis(props.label, Math.max(1, props.budget() - tag().length - 3))
    return ` ${props.selected() ? "❯ " : "  "}${body}`.padEnd(Math.max(0, props.budget() - tag().length)) + tag()
  }
  return (
    <text selectable={false}
      style={{ ...overlayRowStyle(t(), props.selected(), t().fg, props.hovered()) }}
      onMouseOver={() => props.onHover(true)}
      onMouseOut={() => props.onHover(false)}
      onMouseDown={(e) => {
        e.stopPropagation()
        props.onPick(props.idx)
      }}
    >
      {text()}
    </text>
  )
}

function DetailRow(props: {
  field: Field
  idx: number
  selected: () => boolean
  hovered: () => boolean
  budget: () => number
  isEditing: () => boolean
  draft: () => string
  cursor: () => number
  onHover: (on: boolean) => void
  onPick: (idx: number, field: Field) => void
}): JSX.Element {
  const t = () => theme()
  const separator = (): string =>
    props.field.kind === "text" || props.field.kind === "masked" || props.field.kind === "cycle" || props.field.kind === "pick" ? ": " : "  "
  const prefix = (): string => ` ${props.selected() ? "❯ " : "  "}${props.field.display ?? props.field.label}${separator()}`
  const rawValue = (): string => (props.isEditing() ? props.draft() : (props.field.value ?? ""))
  const valueBudget = (): number => Math.max(0, props.budget() - cps(prefix()).length)
  const shown = (): string => truncateWithEllipsis(rawValue(), valueBudget())
  const pad = (): string => " ".repeat(Math.max(0, props.budget() - cps(prefix()).length - cps(shown()).length))
  const valueColor = (): ThemeColor =>
    props.field.kind === "cycle" || props.field.kind === "pick" ? t().accent : t().fg
  const valueVisible = (): boolean =>
    props.isEditing() ||
    props.field.kind === "cycle" ||
    props.field.kind === "pick" ||
    ((props.field.kind === "text" || props.field.kind === "masked") && (props.field.value ?? "").length > 0)
  return (
    <text selectable={false}
      style={{ ...overlayRowStyle(t(), props.selected(), t().fg, props.hovered()) }}
      onMouseOver={() => props.onHover(true)}
      onMouseOut={() => props.onHover(false)}
      onMouseDown={(e) => {
        e.stopPropagation()
        props.onPick(props.idx, props.field)
      }}
    >
      <span>{prefix()}</span>
      <Show when={valueVisible()}>
        <Show when={props.isEditing()} fallback={<span style={{ fg: valueColor() }}>{shown()}</span>}>
          <EditableValue text={shown} cursor={props.cursor} />
        </Show>
      </Show>
      <span style={{ fg: t().muted }}>{pad()}</span>
    </text>
  )
}

/** Tool-turn presets the Chat settings row cycles (null = no loop cap). */
const TOOL_TURN_OPTIONS: ReadonlyArray<number | null> = [25, 50, 100, null]

/** The provider cycle: the four real protocols. The mock seam stays reachable
 * through config (`provider: "mock"`) and `SENSUS_MOCK=1`, but is not offered
 * in the UI (the wizard likewise excludes it). */
const PROVIDER_CYCLE: readonly ProtocolKind[] = PROTOCOL_KINDS

/** Friendly provider label (mock is selectable here, unlike the wizard). */
function providerLabel(raw: string): string {
  const kind = canonicalProvider(raw)
  if (kind === null) return PROTOCOLS["openai-compatible"].label
  return kind === "mock" ? "mock (test seam)" : PROTOCOLS[kind].label
}

/** The resolved default baseURL for a provider (mock/unknown → openai-compatible). */
function defaultBaseURLFor(raw: string): string {
  const kind = canonicalProvider(raw)
  return kind !== null && kind !== "mock"
    ? PROTOCOLS[kind].defaultBaseURL
    : PROTOCOLS["openai-compatible"].defaultBaseURL
}

export function SettingsScreen(props: SettingsScreenProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [doc, setDoc] = createSignal<RawConfigDoc>(settingsSeedDoc(props.rawConfig, props.config))
  /** Selected rail category index. */
  const [catIdx, setCatIdx] = createSignal(0)
  /** Focused pane: the rail or the detail form. */
  const [pane, setPane] = createSignal<"rail" | "detail">("detail")
  /** Detail field index within the current category. */
  const [detailIdx, setDetailIdx] = createSignal(0)
  /** When set (Endpoints category), the detail pane shows that endpoint's editor. */
  const [endpointSel, setEndpointSel] = createSignal<number | null>(null)
  /** When set, the detail pane shows that section's nested "Advanced" submenu. */
  const [advancedFor, setAdvancedFor] = createSignal<string | null>(null)
  /** Type-to-filter query. Non-empty ⇒ the body is the flat ranked list. */
  const [filter, setFilter] = createSignal("")
  const [filterIdx, setFilterIdx] = createSignal(0)
  /** `/` (or any typed char) focuses the search: vim j/k/g/G then TYPE. */
  const [filterFocused, setFilterFocused] = createSignal(false)
  const [editing, setEditing] = createSignal<{ id: string; draft: string; cursor: number } | null>(null)
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null)
  const [revealKey, setRevealKey] = createSignal(false)
  const [test, setTest] = createSignal<TestState>({ phase: "idle" })
  /** Mouse hover highlight: a single `"rail:3" | "detail:5" | "filter:1"` key. */
  const [hover, setHover] = createSignal<string | null>(null)
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  const endpoints = createMemo(() => readEndpoints(doc()))
  const globalTheme = createMemo(() => (isThemeName(str(doc()["theme"])) ? str(doc()["theme"]) : "terminal"))

  const catName = (): string => SETTINGS_CATEGORIES[catIdx()] ?? "Endpoints"

  const commit = (next: RawConfigDoc, note?: string): void => {
    setDoc(next)
    const err = props.persistDoc(next)
    if (err !== null) props.toast(`settings write failed: ${err}`, "error", 5000)
    else if (note !== undefined && note.length > 0) props.toast(note, "success", 2500)
  }

  const endpointsDoc = (d: RawConfigDoc): Record<string, RawConfigDoc> => {
    const p = d["endpoints"]
    return isRecord(p) ? (p as Record<string, RawConfigDoc>) : {}
  }

  const docObject = (key: string): Record<string, unknown> => {
    const v = doc()[key]
    return isRecord(v) ? v : {}
  }

  const commitNested = (key: "chat" | "context" | "memory" | "titles", patch: Record<string, unknown>, note?: string): void => {
    commit({ ...doc(), [key]: { ...docObject(key), ...patch } }, note)
  }

  /** The `themePalette` object from the doc (copy) — unknown sub-keys are
   * preserved by the callers' spread. */
  const themePaletteDoc = (d: RawConfigDoc): Record<string, unknown> => {
    const tp = d["themePalette"]
    return isRecord(tp) ? { ...tp } : {}
  }

  /** Patch the `themePalette` object: set `patch` keys, drop `drop` keys, and
   * remove the whole object when it becomes empty. Persists + live-reloads. */
  const commitThemePalette = (patch: Record<string, unknown>, drop: string[] = [], note?: string): void => {
    const tp = themePaletteDoc(doc())
    for (const k of drop) delete tp[k]
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete tp[k]
      else tp[k] = v
    }
    const next: RawConfigDoc = { ...doc() }
    if (Object.keys(tp).length === 0) delete next["themePalette"]
    else next["themePalette"] = tp
    commit(next, note)
  }

  /** Set/clear a hex foreground/background override; returns an error string. */
  const setTpColor = (key: "foreground" | "background", rawVal: string): string | null => {
    const v = rawVal.trim()
    if (v.length === 0) {
      commitThemePalette({}, [key])
      return null
    }
    if (parseHexColor(v) === null) return `${key} must be a hex color like #d4d4d4`
    commitThemePalette({ [key]: v })
    return null
  }

  /** The saved `palette` array rendered as a single editor string (`?` = a
   * null entry, preserved so re-committing does not shift positions). */
  const paletteText = (): string => {
    const raw = themePaletteDoc(doc())["palette"]
    if (!Array.isArray(raw)) return ""
    return raw.map((c) => (typeof c === "string" ? c : "?")).join(" ")
  }

  /** Parse the palette editor (space/comma separated, 16 or 256 entries;
   * `?`/`-` = leave the entry to detection); empty clears it. */
  const setTpPalette = (rawVal: string): string | null => {
    const v = rawVal.trim()
    if (v.length === 0) {
      commitThemePalette({}, ["palette"])
      return null
    }
    const tokens = v.split(/[\s,]+/).filter((tok) => tok.length > 0)
    if (tokens.length !== 16 && tokens.length !== 256) return "palette needs 16 or 256 entries"
    const entries: (string | null)[] = []
    for (const tok of tokens) {
      if (tok === "?" || tok === "-" || tok.toLowerCase() === "null") {
        entries.push(null)
        continue
      }
      if (parseHexColor(tok) === null) return `not a color: ${tok}`
      entries.push(tok)
    }
    commitThemePalette({ palette: entries })
    return null
  }

  /** Patch several endpoint keys in one commit; `undefined` deletes a key. */
  const setEndpointPatch = (oldName: string, patch: Record<string, unknown>, note?: string): void => {
    const next: RawConfigDoc = { ...doc() }
    const eps = { ...endpointsDoc(next) }
    // Drop the removed apiKeyEnv key: editing an endpoint migrates it.
    const { ["apiKeyEnv"]: _legacy, ...cur } = (eps[oldName] ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cur[k]
      else cur[k] = v
    }
    eps[oldName] = cur as RawConfigDoc
    next["endpoints"] = eps
    commit(next, note)
  }

  /** Patch one endpoint key; `undefined` deletes the key (revert to default). */
  const setEndpointField = (oldName: string, field: string, value: unknown): void => {
    setEndpointPatch(oldName, { [field]: value })
  }

  /** Cycle the four real protocols and let a defaulted baseURL follow the new
   * protocol; a custom baseURL is preserved. A preloaded mock config moves off
   * mock on the first cycle. */
  const cycleProvider = (d: EndpointDraft, dir: 1 | -1): void => {
    const current = canonicalProvider(d.provider) ?? "openai-compatible"
    const idx = PROVIDER_CYCLE.findIndex((k) => k === current)
    const at = (((idx < 0 ? 0 : idx) + dir) % PROVIDER_CYCLE.length + PROVIDER_CYCLE.length) % PROVIDER_CYCLE.length
    const next = PROVIDER_CYCLE[at] ?? "openai-compatible"
    const patch: Record<string, unknown> = { provider: next === "openai-compatible" ? undefined : next }
    const trimmed = d.baseURL.trim()
    const followsDefault = trimmed.length === 0 || PROTOCOL_KINDS.some((k) => PROTOCOLS[k].defaultBaseURL === trimmed)
    if (followsDefault) patch["baseURL"] = PROTOCOLS[next].defaultBaseURL
    setEndpointPatch(d.name, patch, `provider → ${providerLabel(next)}`)
    setTest({ phase: "idle" })
  }

  const commitEndpointNumber = (name: string, field: "temperature" | "maxTokens", rawVal: string): string | null => {
    const trimmed = rawVal.trim()
    if (trimmed.length === 0) {
      setEndpointField(name, field, undefined)
      return null
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return `${field} must be a finite number`
    setEndpointField(name, field, n)
    return null
  }

  const commitThinkingMode = (name: string, rawVal: string): string | null => {
    const trimmed = rawVal.trim()
    if (trimmed.length === 0) {
      setEndpointField(name, "thinkingMode", undefined)
      return null
    }
    if (parseThinkingMode(trimmed) === null) return "thinkingMode must be default|off|budget:<n>|effort keyword"
    setEndpointField(name, "thinkingMode", trimmed)
    return null
  }

  const renameEndpoint = (oldName: string, newName: string): string | null => {
    const name = newName.trim()
    if (name.length === 0) return "endpoint name cannot be empty"
    if (/\s/.test(name)) return "endpoint name cannot contain spaces"
    if (name.includes("@")) return "endpoint name cannot contain @"
    if (name !== oldName && name in endpointsDoc(doc())) return `endpoint "${name}" already exists`
    const next: RawConfigDoc = { ...doc() }
    const eps: Record<string, RawConfigDoc> = {}
    for (const [k, v] of Object.entries(endpointsDoc(next))) eps[k === oldName ? name : k] = v
    next["endpoints"] = eps
    // Follow the selection: model "<old>@<id>" becomes "<new>@<id>".
    const sel = str(next["model"])
    if (sel.startsWith(`${oldName}@`)) next["model"] = `${name}@${sel.slice(oldName.length + 1)}`
    commit(next, `endpoint renamed to ${name}`)
    return null
  }

  const openEndpoint = (idx: number): void => {
    setEndpointSel(idx)
    setAdvancedFor(null)
    setPane("detail")
    setDetailIdx(0)
    setEditing(null)
    setConfirm(null)
    setRevealKey(false)
    setTest({ phase: "idle" })
  }

  const addEndpoint = (): void => {
    const existing = new Set(endpoints().map((p) => p.name))
    let n = 2
    while (existing.has(`endpoint-${n}`)) n++
    const name = `endpoint-${n}`
    const next: RawConfigDoc = { ...doc() }
    next["endpoints"] = { ...endpointsDoc(next), [name]: { baseURL: "https://api.openai.com/v1" } }
    commit(next, `endpoint ${name} added`)
    setCatIdx(SETTINGS_CATEGORIES.indexOf("Endpoints"))
    setEndpointSel(endpoints().length - 1) // appended last (memo is fresh post-commit)
    setAdvancedFor(null)
    setPane("detail")
    setDetailIdx(0)
    setEditing(null)
    setConfirm(null)
    setTest({ phase: "idle" })
  }

  const deleteEndpoint = (name: string): void => {
    const next: RawConfigDoc = { ...doc() }
    const eps = { ...endpointsDoc(next) }
    delete eps[name]
    next["endpoints"] = eps
    // The deleted endpoint must not stay selected.
    const sel = str(next["model"])
    if (sel.startsWith(`${name}@`)) {
      const first = Object.keys(eps)[0]
      if (first !== undefined) next["model"] = sel.replace(/^.*?@/, `${first}@`)
      else delete next["model"]
    }
    commit(next, `endpoint ${name} deleted`)
    setEndpointSel(null)
    setAdvancedFor(null)
    setPane("detail")
    setDetailIdx(0)
    setTest({ phase: "idle" })
  }

  const runTestConnection = async (draftEp: EndpointDraft): Promise<void> => {
    setTest({ phase: "running" })
    const res = await props.testConnection({
      provider: draftEp.provider,
      baseURL: draftEp.baseURL,
      apiKey: draftEp.apiKey,
    })
    if (disposed) return
    if (!res.ok || res.error !== undefined) {
      setTest({ phase: "fail", message: res.error ?? "connection failed" })
      return
    }
    const models = res.models ?? []
    setTest({ phase: "ok", message: `${models.length} model(s) · ${models.filter((m) => m.chat).length} chat-capable` })
  }

  const requestConfirm = (message: string, onYes: () => void): void => {
    setEditing(null)
    setConfirm({ message, onYes })
  }

  const toggleMcpEnabled = (name: string): void => {
    const next: RawConfigDoc = { ...doc() }
    const mcp = isRecord(next["mcp"]) ? { ...(next["mcp"] as Record<string, unknown>) } : {}
    const servers = isRecord(mcp["servers"]) ? { ...(mcp["servers"] as Record<string, unknown>) } : {}
    const cur = isRecord(servers[name]) ? { ...(servers[name] as Record<string, unknown>) } : {}
    const now = cur["enabled"] === false ? false : true
    cur["enabled"] = !now
    servers[name] = cur
    mcp["servers"] = servers
    next["mcp"] = mcp
    commit(next, `mcp ${name} → ${!now ? "on" : "off"}`)
  }

  // ---- MCP server management (phase 4.6, docs/mcp.md) ----------------------
  const mcpServersDoc = (d: RawConfigDoc): Record<string, unknown> => {
    const mcp = isRecord(d["mcp"]) ? (d["mcp"] as Record<string, unknown>) : {}
    return isRecord(mcp["servers"]) ? { ...(mcp["servers"] as Record<string, unknown>) } : {}
  }

  const commitMcpServer = (name: string, patch: Record<string, unknown> | null, note?: string): void => {
    const next: RawConfigDoc = { ...doc() }
    const mcp = isRecord(next["mcp"]) ? { ...(next["mcp"] as Record<string, unknown>) } : {}
    const servers = mcpServersDoc(next)
    if (patch === null) delete servers[name]
    else servers[name] = { ...(isRecord(servers[name]) ? (servers[name] as Record<string, unknown>) : {}), ...patch }
    mcp["servers"] = servers
    next["mcp"] = mcp
    commit(next, note)
  }

  const renameMcpServer = (oldName: string, newName: string): string | null => {
    const clean = newName.trim()
    if (clean.length === 0) return "name cannot be empty"
    if (/[@\s]/.test(clean)) return "name cannot contain spaces or @"
    if (clean === oldName) return null
    const servers = mcpServersDoc(doc())
    if (clean in servers) return `server "${clean}" already exists`
    const next: RawConfigDoc = { ...doc() }
    const mcp = isRecord(next["mcp"]) ? { ...(next["mcp"] as Record<string, unknown>) } : {}
    const s = { ...servers }
    const cur = s[oldName]
    delete s[oldName]
    s[clean] = cur ?? {}
    mcp["servers"] = s
    next["mcp"] = mcp
    commit(next, `mcp ${oldName} → ${clean}`)
    return null
  }

  const addMcpServer = (transport: "http" | "stdio"): void => {
    const servers = mcpServersDoc(doc())
    let n = 1
    while (`server-${n}` in servers) n++
    const name = `server-${n}`
    commitMcpServer(
      name,
      transport === "http" ? { url: "https://", enabled: true } : { command: "", enabled: true },
      `mcp added ${name} (${transport})`,
    )
  }

  const deleteMcpServer = (name: string): void => {
    setConfirm({ message: `delete mcp server "${name}"? y/N`, onYes: () => commitMcpServer(name, null, `mcp deleted ${name}`) })
  }

  const setHoverKey = (key: string, on: boolean): void => {
    setHover((h) => (on ? key : h === key ? null : h))
  }

  // ---- detail field builders (one per rail category) ------------------------

  const draftEp = (idx: number): EndpointDraft =>
    endpoints()[idx] ?? {
      name: "",
      baseURL: "",
      apiKey: "",
      provider: "openai-compatible",
      temperature: "",
      maxTokens: "",
      thinkingMode: "",
      modelsJson: "",
    }

  const endpointsListFields = (): Field[] => {
    const list: Field[] = endpoints().map((p, i) => ({
      id: `endpoint:${p.name}`,
      label: `${p.name} — ${p.baseURL.length > 0 ? p.baseURL : "(no baseURL)"}`,
      kind: "button",
      hint: "Enter opens the endpoint editor",
      onActivate: () => openEndpoint(i),
    }))
    list.push({
      id: "add-endpoint",
      label: "+ add endpoint",
      kind: "button",
      hint: "adds endpoint-N and opens its editor",
      onActivate: addEndpoint,
    })
    return list
  }

  const endpointEditorFields = (d: EndpointDraft): Field[] => {
    const maskedValue = (): string =>
      revealKey() || d.apiKey.length === 0 ? d.apiKey : "•".repeat(Math.min(d.apiKey.length, 24))
    return [
      {
        id: "name",
        label: "name",
        kind: "text",
        value: d.name,
        hint: "Enter to edit — renames the endpoint (selection follows)",
        onCommit: (v) => renameEndpoint(d.name, v),
      },
      {
        id: "baseURL",
        label: "baseURL",
        kind: "text",
        value: d.baseURL,
        hint: `base URL · empty = ${defaultBaseURLFor(d.provider)}`,
        onCommit: (v) => {
          const trimmed = v.trim()
          if (trimmed.length === 0) {
            setEndpointField(d.name, "baseURL", "")
            return null
          }
          try {
            const u = new URL(trimmed)
            if (u.protocol !== "http:" && u.protocol !== "https:") return "baseURL must be http(s)"
          } catch {
            return "baseURL is not a valid URL"
          }
          setEndpointField(d.name, "baseURL", trimmed)
          return null
        },
      },
      {
        id: "apiKey",
        label: "apiKey",
        kind: "masked",
        value: maskedValue(),
        editValue: d.apiKey,
        hint: "key for this endpoint · empty → chat disabled",
        onCommit: (v) => {
          setEndpointField(d.name, "apiKey", v)
          return null
        },
      },
      {
        id: "toggle-key",
        label: revealKey() ? "hide key" : "show key",
        kind: "button",
        hint: "reveal/hide the apiKey value",
        onActivate: () => setRevealKey((r) => !r),
      },
      { id: "test", label: "test connection", kind: "button", hint: "protocol /models probe (uses the draft, even unsaved)", onActivate: () => void runTestConnection(d) },
      {
        id: "provider",
        label: "provider",
        kind: "cycle",
        value: providerLabel(d.provider),
        hint: PROVIDER_CYCLE.map((k) => providerLabel(k)).join(" | ") + " — Enter/←/→ cycles",
        onCycle: (dir) => cycleProvider(d, dir),
      },
      {
        id: "temperature",
        label: "temperature",
        kind: "text",
        value: d.temperature,
        hint: "request temperature (finite number; empty = default)",
        onCommit: (v) => commitEndpointNumber(d.name, "temperature", v),
      },
      {
        id: "maxTokens",
        label: "maxTokens",
        kind: "text",
        value: d.maxTokens,
        hint: "request max tokens (finite number; empty = auto: the model's output limit, else the endpoint default)",
        onCommit: (v) => commitEndpointNumber(d.name, "maxTokens", v),
      },
      {
        id: "thinkingMode",
        label: "thinkingMode",
        kind: "text",
        value: d.thinkingMode,
        hint: "default|off|budget:<n>|effort keyword (empty clears)",
        onCommit: (v) => commitThinkingMode(d.name, v),
      },
      {
        id: "models-json",
        label: "model metadata overrides",
        kind: "text",
        value: d.modelsJson,
        hint: 'JSON: {"gpt-5":{"contextLimit":400000,"inputLimit":272000}} — wins over models.dev',
        onCommit: (v) => {
          const trimmed = v.trim()
          if (trimmed.length === 0) {
            const next: RawConfigDoc = { ...doc() }
            const eps = { ...endpointsDoc(next) }
            const cur = eps[d.name] ?? {}
            const { ["models"]: _drop, ...rest } = cur as Record<string, unknown>
            eps[d.name] = rest as RawConfigDoc
            next["endpoints"] = eps
            commit(next, "model overrides cleared")
            return null
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            return "not valid JSON"
          }
          if (!isRecord(parsed)) return "must be a JSON object of {modelId: {…}}"
          setEndpointField(d.name, "models", parsed)
          return null
        },
      },
      {
        id: "browse-models",
        label: "browse models (picker)",
        kind: "button",
        hint: "opens the model picker",
        onActivate: () => props.onBrowseModels(d.name),
      },
      {
        id: "delete",
        label: "delete endpoint",
        kind: "button",
        hint: "asks y/N before deleting",
        onActivate: () => requestConfirm(`delete endpoint "${d.name}"? y/N`, () => deleteEndpoint(d.name)),
      },
      {
        id: "back",
        label: "back to endpoint list",
        kind: "button",
        hint: "returns to the endpoint list",
        onActivate: () => {
          setEndpointSel(null)
          setPane("detail")
          setDetailIdx(0)
          setTest({ phase: "idle" })
        },
      },
    ]
  }

  const activeDocEndpointName = (): string => {
    const sel = str(doc()["model"])
    const at = sel.indexOf("@")
    if (at > 0) return sel.slice(0, at)
    return endpoints()[0]?.name ?? ""
  }

  const modelFields = (): Field[] => {
    const titlesRaw = docObject("titles")
    const titlesEnabled = titlesRaw["enabled"] !== false
    return [
      {
        id: "model",
        label: "model",
        kind: "text",
        value: str(doc()["model"]),
        hint: "<endpoint>@<model> — the default for new sessions",
        onCommit: (v) => {
          const trimmed = v.trim()
          const parsed = parseSelectedModel(trimmed)
          if (parsed === null) return "model must be <endpoint>@<model>"
          if (!(parsed.endpoint in endpointsDoc(doc()))) return `unknown endpoint "${parsed.endpoint}"`
          commit({ ...doc(), model: trimmed }, `model → ${trimmed}`)
          return null
        },
      },
      {
        id: "browse-models-global",
        label: "browse models (picker)",
        kind: "button",
        hint: "opens the model picker",
        onActivate: () => props.onBrowseModels(activeDocEndpointName()),
      },
      {
        id: "titles-enabled",
        label: "auto session title",
        kind: "cycle",
        value: titlesEnabled ? "on" : "off",
        hint: "on | off — name the session on its first prompt (docs/sessions.md)",
        onCycle: () =>
          commitNested("titles", { enabled: !titlesEnabled }, `auto session title → ${!titlesEnabled ? "on" : "off"}`),
      },
      {
        id: "titles-model",
        label: "title model",
        kind: "text",
        value: str(titlesRaw["model"]),
        hint: "<endpoint>@<model> or bare id — empty = same as the chat model",
        onCommit: (v) => {
          const trimmed = v.trim()
          if (trimmed.length === 0) {
            commitNested("titles", { model: undefined }, "title model → same as chat model")
            return null
          }
          const parsed = parseSelectedModel(trimmed)
          if (parsed !== null && !(parsed.endpoint in endpointsDoc(doc()))) {
            return `unknown endpoint "${parsed.endpoint}"`
          }
          commitNested("titles", { model: trimmed }, `title model → ${trimmed}`)
          return null
        },
      },
    ]
  }

  const agentFields = (): Field[] => {
    const agentNames = props.agents.map((a) => a.name)
    const agentNow = str(doc()["agent"]) || props.config.defaultAgent
    const agentIdx = Math.max(0, agentNames.indexOf(agentNow))
    const approval = str(doc()["approval"]) || props.config.approval
    const allowRaw = Array.isArray(doc()["allowPrefixes"])
      ? (doc()["allowPrefixes"] as unknown[]).filter((p) => typeof p === "string")
      : []
    return [
      {
        id: "agent",
        label: "agent",
        kind: "cycle",
        value: agentNow,
        hint: `${agentNames.join(", ")} — default for new sessions`,
        onCycle: (dir) => {
          if (agentNames.length === 0) return
          const nextName = agentNames[(agentIdx + dir + agentNames.length) % agentNames.length] ?? agentNames[0] ?? agentNow
          commit({ ...doc(), agent: nextName }, `agent → ${nextName}`)
        },
      },
      {
        id: "approval",
        label: "approval default",
        kind: "cycle",
        value: approval,
        hint: "confirm | full-auto — new sessions",
        onCycle: () => {
          const nextName = approval === "full-auto" ? "confirm" : "full-auto"
          commit({ ...doc(), approval: nextName }, `approval default → ${nextName}`)
        },
      },
      {
        id: "allow-prefixes",
        label: "always-allow prefixes",
        kind: "text",
        value: (allowRaw as string[]).join(", "),
        hint: "comma-separated command prefixes (e.g. git, ls) — auto-approved",
        onCommit: (v) => {
          const list = v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => (s.endsWith(" ") ? s : `${s} `))
          commit({ ...doc(), allowPrefixes: list }, `always-allow prefixes → ${list.length}`)
          return null
        },
      },
    ]
  }

  const appearanceFields = (): Field[] => {
    const width = num(docObject("sidebar")["width"])
    const layoutRaw = doc()["layout"]
    const layout: LayoutMode =
      layoutRaw === "sidebar" || layoutRaw === "topbar" ? layoutRaw : props.config.layout
    const autoRaw = doc()["autoChatOnly"]
    const autoChatOnly: boolean = typeof autoRaw === "boolean" ? autoRaw : props.config.autoChatOnly
    return [
      {
        id: "theme",
        label: "theme",
        kind: "pick",
        value: globalTheme(),
        hint: "Enter opens the theme picker — applies live",
        onActivate: props.onPickTheme,
      },
      {
        id: "sidebar-width",
        label: "chat sidebar width",
        kind: "text",
        value: String(width ?? props.config.sidebarWidth),
        hint: "columns (20-200) — the chat pane, applies live",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 20 || n > 200) return "chat sidebar width must be 20-200"
          commit({ ...doc(), sidebar: { ...docObject("sidebar"), width: Math.floor(n) } })
          props.onSidebarWidth(Math.floor(n))
          return null
        },
      },
      {
        id: "layout",
        label: "layout",
        kind: "cycle",
        value: layout,
        hint: "topbar | sidebar — tab strip position",
        onCycle: () => {
          const next: LayoutMode = layout === "topbar" ? "sidebar" : "topbar"
          commit({ ...doc(), layout: next }, `layout → ${next}`)
          props.onLayoutMode(next)
        },
      },
      {
        id: "auto-chat-only",
        label: "auto chat-only",
        kind: "cycle",
        value: autoChatOnly ? "on" : "off",
        hint: "on | off — terminals under 90 cols start with the terminal pane hidden (Alt+Home overrides)",
        onCycle: () => {
          commit({ ...doc(), autoChatOnly: !autoChatOnly }, `autoChatOnly → ${!autoChatOnly ? "on" : "off"}`)
        },
      },
      {
        id: "tab-rail-width",
        label: "tab rail width",
        kind: "text",
        value: String(num(docObject("tabs")["width"]) ?? props.config.tabRailWidth),
        hint: "columns (16-60) — only in the sidebar layout",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 16 || n > 60) return "tab rail width must be 16-60"
          commit({ ...doc(), tabs: { ...docObject("tabs"), width: Math.floor(n) } })
          props.onTabRailWidth(Math.floor(n))
          return null
        },
      },
    ]
  }

  const chatFields = (): Field[] => {
    const c = docObject("chat")
    const thinking = c["thinking"] === "show" ? "show" : "hide"
    const toolOutput = c["toolOutput"] === "expanded" ? "expanded" : "collapsed"
    const animations = c["animations"] === false ? false : true
    const cardStyle =
      c["cardStyle"] === "fill" || c["cardStyle"] === "border" ? c["cardStyle"] : props.config.chat.cardStyle
    // Explicit null in the file = "off"; a missing key falls back to the
    // resolved config (the default, or a hand-edited value from the file).
    const maxTurns = "maxToolTurns" in c ? (c["maxToolTurns"] === null ? null : num(c["maxToolTurns"])) : props.config.chat.maxToolTurns
    const busySend = c["busySend"] === "steer" || c["busySend"] === "queue" ? c["busySend"] : props.config.chat.busySend
    return [
      {
        id: "chat-thinking",
        label: "thinking",
        kind: "cycle",
        value: thinking,
        hint: "show | hide — reasoning blocks",
        onCycle: () => {
          const next = thinking === "show" ? "hide" : "show"
          commitNested("chat", { thinking: next }, `chat.thinking → ${next}`)
        },
      },
      {
        id: "chat-toolOutput",
        label: "tool output",
        kind: "cycle",
        value: toolOutput,
        hint: "collapsed | expanded — tool cards",
        onCycle: () => {
          const next = toolOutput === "expanded" ? "collapsed" : "expanded"
          commitNested("chat", { toolOutput: next }, `chat.toolOutput → ${next}`)
        },
      },
      {
        id: "chat-animations",
        label: "animations",
        kind: "cycle",
        value: animations ? "on" : "off",
        hint: "on | off — spinner frames + reveal pacing + input caret blink",
        onCycle: () => {
          const next = !animations
          commitNested("chat", { animations: next }, `chat.animations → ${next ? "on" : "off"}`)
        },
      },
      {
        id: "chat-cardStyle",
        label: "card style",
        kind: "cycle",
        value: cardStyle,
        hint: "fill | border — message cards (fill = panel)",
        onCycle: () => {
          const next = cardStyle === "fill" ? "border" : "fill"
          commitNested("chat", { cardStyle: next }, `chat.cardStyle → ${next}`)
        },
      },
      {
        id: "chat-maxToolTurns",
        label: "tool turns",
        kind: "cycle",
        value: maxTurns === null ? "off" : String(maxTurns),
        hint: "round-trips per message — 25 | 50 | 100 | off (no cap)",
        onCycle: (dir) => {
          const next = cycleOption(maxTurns, TOOL_TURN_OPTIONS, dir, 50)
          commitNested("chat", { maxToolTurns: next }, `chat.maxToolTurns → ${next === null ? "off" : next}`)
        },
      },
      {
        id: "chat-busySend",
        label: "busy send",
        kind: "cycle",
        value: busySend,
        hint: "steer | queue — a message sent while the reply streams",
        onCycle: () => {
          const next = busySend === "steer" ? "queue" : "steer"
          commitNested("chat", { busySend: next }, `chat.busySend → ${next}`)
        },
      },
    ]
  }

  const contextFields = (): Field[] => {
    const c = docObject("context")
    const enabled = c["enabled"] === false ? false : true
    const autoCompact = c["autoCompact"] === false ? false : true
    const lines = num(c["scrollbackLines"]) ?? props.config.context.scrollbackLines
    const keep = num(c["keepTokens"]) ?? props.config.context.keepTokens
    const buffer = num(c["bufferTokens"]) ?? props.config.context.bufferTokens
    const limit = num(c["contextLimit"])
    return [
      {
        id: "context-enabled",
        label: "enabled",
        kind: "cycle",
        value: enabled ? "on" : "off",
        hint: "on | off — master context-injection switch",
        onCycle: () => commitNested("context", { enabled: !enabled }, `context.enabled → ${!enabled ? "on" : "off"}`),
      },
      {
        id: "context-scrollbackLines",
        label: "scrollback lines",
        kind: "text",
        value: String(lines),
        hint: "terminal tail attached to each message (10-1000)",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 10 || n > 1000) return "scrollback lines must be 10-1000"
          commitNested("context", { scrollbackLines: Math.floor(n) })
          return null
        },
      },
      {
        id: "context-autoCompact",
        label: "auto compact",
        kind: "cycle",
        value: autoCompact ? "on" : "off",
        hint: "on | off — preflight compaction near the limit",
        onCycle: () => commitNested("context", { autoCompact: !autoCompact }, `context.autoCompact → ${!autoCompact ? "on" : "off"}`),
      },
      {
        id: "context-keepTokens",
        label: "keep tokens",
        kind: "text",
        value: String(keep),
        hint: "recent tokens kept verbatim beside a checkpoint (>0)",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n <= 0) return "keep tokens must be > 0"
          commitNested("context", { keepTokens: Math.floor(n) })
          return null
        },
      },
      {
        id: "context-bufferTokens",
        label: "buffer tokens",
        kind: "text",
        value: String(buffer),
        hint: "safety reserve below the limit (>=0)",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 0) return "buffer tokens must be >= 0"
          commitNested("context", { bufferTokens: Math.floor(n) })
          return null
        },
      },
      {
        id: "context-contextLimit",
        label: "context limit",
        kind: "text",
        value: String(limit ?? 0),
        hint: "0 = unlimited/auto (use model metadata), else >0 tokens",
        onCommit: (v) => {
          const trimmed = v.trim()
          if (trimmed.length === 0) {
            commitNested("context", { contextLimit: 0 })
            return null
          }
          const n = Number(trimmed)
          if (!Number.isFinite(n) || n < 0) return "context limit must be >= 0 or empty"
          commitNested("context", { contextLimit: Math.floor(n) })
          return null
        },
      },
    ]
  }

  const memoryFields = (): Field[] => {
    const m = docObject("memory")
    const enabled = m["enabled"] === false ? false : true
    const writeApproval = m["writeApproval"] === true
    const redactSecrets = m["redactSecrets"] === false ? false : true
    const cap = (key: string, fallback: number): number => num(m[key]) ?? fallback
    const memoryCap = cap("memoryCharLimit", props.config.memory.memoryCharLimit)
    const hostCap = cap("hostCharLimit", props.config.memory.hostCharLimit)
    const journalCap = cap("journalCharLimit", props.config.memory.journalCharLimit)
    const pct = cap("consolidateAtPercent", props.config.memory.consolidateAtPercent)
    const capField = (id: string, label: string, key: string, value: number): Field => ({
      id,
      label,
      kind: "text",
      value: String(value),
      hint: `${key} — hard character cap (>0)`,
      onCommit: (v) => {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return `${label} must be > 0`
        commitNested("memory", { [key]: Math.floor(n) }, `memory.${key} → ${Math.floor(n)}`)
        return null
      },
    })
    return [
      {
        id: "memory-enabled",
        label: "enabled",
        kind: "cycle",
        value: enabled ? "on" : "off",
        hint: "on | off — drops the memory tool + prompt block when off",
        onCycle: () => commitNested("memory", { enabled: !enabled }, `memory.enabled → ${!enabled ? "on" : "off"}`),
      },
      capField("memory-memoryCharLimit", "MEMORY.md cap", "memoryCharLimit", memoryCap),
      capField("memory-hostCharLimit", "HOST.md cap", "hostCharLimit", hostCap),
      capField("memory-journalCharLimit", "JOURNAL.md cap", "journalCharLimit", journalCap),
      {
        id: "memory-writeApproval",
        label: "write approval",
        kind: "cycle",
        value: writeApproval ? "on" : "off",
        hint: "on | off — gate memory writes behind the approval card",
        onCycle: () => commitNested("memory", { writeApproval: !writeApproval }, `memory.writeApproval → ${!writeApproval ? "on" : "off"}`),
      },
      {
        id: "memory-consolidateAtPercent",
        label: "consolidate at %",
        kind: "text",
        value: String(pct),
        hint: "prompt hint threshold (1-100)",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 1 || n > 100) return "consolidate at % must be 1-100"
          commitNested("memory", { consolidateAtPercent: Math.floor(n) }, `memory.consolidateAtPercent → ${Math.floor(n)}`)
          return null
        },
      },
      {
        id: "memory-redactSecrets",
        label: "redact secrets",
        kind: "cycle",
        value: redactSecrets ? "on" : "off",
        hint: "on | off — refuse writes that look like credentials",
        onCycle: () => commitNested("memory", { redactSecrets: !redactSecrets }, `memory.redactSecrets → ${!redactSecrets ? "on" : "off"}`),
      },
    ]
  }

  const mcpFields = (): Field[] => {
    const serversRaw = mcpServersDoc(doc())
    const names = Object.keys(serversRaw).sort()
    const out: Field[] = []
    for (const name of names) {
      const rec = isRecord(serversRaw[name]) ? (serversRaw[name] as Record<string, unknown>) : {}
      const url = typeof rec["url"] === "string" ? rec["url"] : null
      const command = typeof rec["command"] === "string" ? rec["command"] : null
      const transport = url !== null ? "http" : "stdio"
      const target = url ?? command ?? ""
      const timeout = num(rec["timeout_s"]) ?? 60
      out.push({
        id: `mcp-enabled:${name}`,
        label: `${name} · ${transport} · ${rec["enabled"] === false ? "off" : "on"}`,
        kind: "cycle",
        value: rec["enabled"] === false ? "off" : "on",
        hint: "Enter toggles enabled (docs/mcp.md)",
        onCycle: () => toggleMcpEnabled(name),
      })
      out.push({
        id: `mcp-name:${name}`,
        label: "name",
        kind: "text",
        value: name,
        hint: "rename this server (no spaces or @)",
        onCommit: (v) => renameMcpServer(name, v),
      })
      out.push({
        id: `mcp-target:${name}`,
        label: transport === "http" ? "url" : "command",
        kind: "text",
        value: target,
        hint: transport === "http" ? "http(s) URL" : "stdio command (args/env stay in config.json)",
        onCommit: (v) => {
          if (v.trim().length === 0) {
            commitMcpServer(name, transport === "http" ? { url: undefined } : { command: undefined })
            return null
          }
          commitMcpServer(name, transport === "http" ? { url: v.trim() } : { command: v.trim() }, `mcp ${name} ${transport} updated`)
          return null
        },
      })
      out.push({
        id: `mcp-timeout:${name}`,
        label: "timeout (s)",
        kind: "text",
        value: String(timeout),
        hint: "1-600 seconds",
        onCommit: (v) => {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 1 || n > 600) return "timeout must be 1-600 seconds"
          commitMcpServer(name, { timeout_s: Math.floor(n) }, `mcp ${name} timeout → ${Math.floor(n)}s`)
          return null
        },
      })
      out.push({
        id: `mcp-delete:${name}`,
        label: "delete server",
        kind: "button",
        onActivate: () => deleteMcpServer(name),
      })
    }
    out.push({ id: "mcp-add-http", label: "+ add http server", kind: "button", onActivate: () => addMcpServer("http") })
    out.push({ id: "mcp-add-stdio", label: "+ add stdio server", kind: "button", onActivate: () => addMcpServer("stdio") })
    return out
  }

  /**
   * Appearance's nested "Advanced" submenu: the `themePalette` color overrides
   * (moved out of the old global Advanced category — docs/config.md). Other
   * sections gain their own builder here as config-file-only keys graduate.
   */
  const appearanceAdvancedFields = (): Field[] => {
    const tp = themePaletteDoc(doc())
    const colorMode = tp["colorMode"] === "truecolor" || tp["colorMode"] === "ansi256" ? tp["colorMode"] : "auto"
    return [
      {
        id: "default-fg",
        label: "default foreground",
        kind: "text",
        value: str(tp["foreground"]),
        hint: "hex override for the terminal default fg (empty = detected)",
        onCommit: (v) => setTpColor("foreground", v),
      },
      {
        id: "default-bg",
        label: "default background",
        kind: "text",
        value: str(tp["background"]),
        hint: "hex override for the terminal default bg (empty = detected)",
        onCommit: (v) => setTpColor("background", v),
      },
      {
        id: "color-mode",
        label: "color mode",
        kind: "cycle",
        value: colorMode,
        hint: "auto | truecolor | ansi256 · RESTART to apply (read at load)",
        onCycle: () => {
          const next = colorMode === "auto" ? "truecolor" : colorMode === "truecolor" ? "ansi256" : "auto"
          commitThemePalette({ colorMode: next }, [], `color mode → ${next} (restart)`)
        },
      },
      {
        id: "palette",
        label: "palette",
        kind: "text",
        value: paletteText(),
        hint: "16 or 256 hex entries (? = detected); empty clears (asks y/N)",
        onCommit: (v) => {
          const trimmed = v.trim()
          if (trimmed.length === 0) {
            if (!Array.isArray(themePaletteDoc(doc())["palette"])) return null
            requestConfirm("clear palette? y/N", () => commitThemePalette({}, ["palette"], "palette cleared"))
            return null
          }
          return setTpPalette(v)
        },
      },
      {
        id: "reset-colors",
        label: "reset terminal colors",
        kind: "button",
        hint: "asks y/N — clears every color override",
        onActivate: () =>
          requestConfirm("reset terminal colors? y/N", () =>
            commitThemePalette(
              {},
              ["foreground", "background", "palette", "colorMode"],
              "terminal colors reset",
            ),
          ),
      },
      {
        id: "advanced-back",
        label: "back to Appearance",
        kind: "button",
        hint: "returns to the section",
        onActivate: () => closeAdvanced(),
      },
    ]
  }

  /** Per-section advanced fields: the submenu shown one level below a
   * category's detail pane. A section with no entries has no "Advanced…" row. */
  const advancedFieldsFor = (category: string): Field[] => {
    switch (category) {
      case "Appearance":
        return appearanceAdvancedFields()
      default:
        return []
    }
  }

  const openAdvanced = (category: string): void => {
    setAdvancedFor(category)
    setEndpointSel(null)
    setPane("detail")
    setDetailIdx(0)
    setEditing(null)
    setConfirm(null)
    setTest({ phase: "idle" })
  }

  /** Pop one level back: the advanced submenu → its section. */
  const closeAdvanced = (): void => {
    setAdvancedFor(null)
    setDetailIdx(0)
    setEditing(null)
    setConfirm(null)
  }

  const fieldsForCategory = (ci: number): Field[] => {
    const category = SETTINGS_CATEGORIES[ci]
    const base = ((): Field[] => {
      switch (category) {
        case "Endpoints":
          return endpointsListFields()
        case "Model":
          return modelFields()
        case "Agent":
          return agentFields()
        case "Appearance":
          return appearanceFields()
        case "Chat":
          return chatFields()
        case "Context":
          return contextFields()
        case "MCP servers":
          return mcpFields()
        case "Memory":
          return memoryFields()
        default:
          return []
      }
    })()
    if (category === undefined || advancedFieldsFor(category).length === 0) return base
    return [
      ...base,
      {
        id: "advanced",
        label: "Advanced…",
        kind: "button",
        hint: `advanced ${category} settings`,
        onActivate: () => openAdvanced(category),
      },
    ]
  }

  const detailFields = createMemo<Field[]>(() => {
    const adv = advancedFor()
    if (adv !== null) return advancedFieldsFor(adv)
    if (catName() === "Endpoints" && endpointSel() !== null) return endpointEditorFields(draftEp(endpointSel() ?? 0))
    return fieldsForCategory(catIdx())
  })

  // ---- flat filter entries (all categories) ---------------------------------

  interface FilterEntry {
    label: string
    category: string
    run: () => void
  }

  const filterEntries = createMemo<FilterEntry[]>(() => {
    const out: FilterEntry[] = []
    SETTINGS_CATEGORIES.forEach((category, ci) => {
      const fields = fieldsForCategory(ci)
      const push = (field: Field, fi: number, advanced: boolean): void => {
        out.push({
          label: field.label,
          category,
          run: () => {
            setFilter("")
            setCatIdx(ci)
            setEndpointSel(null)
            setAdvancedFor(advanced ? category : null)
            setPane("detail")
            setDetailIdx(fi)
            setEditing(null)
            setConfirm(null)
            setTest({ phase: "idle" })
            activate(field)
          },
        })
      }
      fields.forEach((field, fi) => push(field, fi, false))
      // Advanced fields are ranked alongside the section's regular rows and
      // open the section's nested submenu before activating.
      advancedFieldsFor(category).forEach((field, fi) => push(field, fi, true))
    })
    return out
  })

  const activate = (field: Field | undefined): void => {
    if (!field) return
    if (field.kind === "text" || field.kind === "masked") startEditing(field)
    else if (field.kind === "cycle") field.onCycle?.(1)
    else field.onActivate?.()
  }

  const startEditing = (field: Field): void => {
    if (field.kind !== "text" && field.kind !== "masked") return
    const seed = field.editValue ?? field.value ?? ""
    setEditing({ id: field.id, draft: seed, cursor: cps(seed).length })
  }

  const commitEditing = (): void => {
    const ed = editing()
    if (ed === null) return
    const field = detailFields().find((f) => f.id === ed.id)
    if (!field?.onCommit) {
      setEditing(null)
      return
    }
    const err = field.onCommit(ed.draft)
    if (err !== null) {
      props.toast(err, "error", 4000)
      return
    }
    setEditing(null)
  }

  const openCategory = (i: number): void => {
    setCatIdx(i)
    setEndpointSel(null)
    setAdvancedFor(null)
    setDetailIdx(0)
    setPane("detail")
    setEditing(null)
    setConfirm(null)
    setTest({ phase: "idle" })
  }

  // ---- clamping / windows ----------------------------------------------------

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: footer + (filter) + (test result) + (confirm) → 4.
  const bodyRows = (): number => Math.max(4, metrics().innerHeight - 4)
  const railBudget = (): number => Math.max(10, RAIL_WIDTH - 4)
  const detailBudget = (): number => Math.max(12, metrics().innerWidth - RAIL_WIDTH - 4)
  const filterBudget = (): number => Math.max(20, metrics().innerWidth - 2)

  const filtered = createMemo(() => filterSettings(filterEntries(), filter()))

  const clampedCatIdx = createMemo(() => Math.max(0, Math.min(catIdx(), SETTINGS_CATEGORIES.length - 1)))
  const clampedDetailIdx = createMemo(() => Math.min(detailIdx(), Math.max(0, detailFields().length - 1)))
  const clampedFilterIdx = createMemo(() => Math.min(filterIdx(), Math.max(0, filtered().length - 1)))

  const railRows = createMemo(() => {
    const rows = Math.max(1, bodyRows())
    const sel = clampedCatIdx()
    const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), Math.max(0, SETTINGS_CATEGORIES.length - rows)))
    return SETTINGS_CATEGORIES.slice(start, start + rows).map((label, k) => ({ label, idx: start + k }))
  })

  const detailRows = createMemo(() => {
    const fs = detailFields()
    const rows = Math.max(1, bodyRows())
    const sel = clampedDetailIdx()
    const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), Math.max(0, fs.length - rows)))
    return fs.slice(start, start + rows).map((field, k) => ({ field, idx: start + k }))
  })

  const filterRows = createMemo(() => {
    const items = filtered()
    const rows = Math.max(1, bodyRows())
    const sel = clampedFilterIdx()
    const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), Math.max(0, items.length - rows)))
    return items.slice(start, start + rows).map((entry, k) => ({ entry, idx: start + k }))
  })

  // ---- keyboard --------------------------------------------------------------

  const handleOverlayKey = (key: OverlayKey): void => {
    // 1. Inline text editing: all keys go to the draft until Enter/Esc.
    const ed = editing()
    if (ed !== null) {
      const isEnter = isEnterKey(key)
      if (isEnter && !key.ctrl) {
        commitEditing()
        return
      }
      if (key.name === "escape") {
        setEditing(null)
        return
      }
      if (key.name === "backspace") {
        const chars = [...ed.draft]
        const c = Math.min(ed.cursor, chars.length)
        if (c > 0) {
          const next = chars.slice(0, c - 1).concat(chars.slice(c)).join("")
          setEditing({ ...ed, draft: next, cursor: c - 1 })
        }
        return
      }
      if (key.ctrl && key.name === "u") {
        setEditing({ ...ed, draft: "", cursor: 0 })
        return
      }
      if (key.name === "delete") {
        const chars = [...ed.draft]
        const c = Math.min(ed.cursor, chars.length)
        if (c < chars.length) {
          const next = chars.slice(0, c).concat(chars.slice(c + 1)).join("")
          setEditing({ ...ed, draft: next, cursor: c })
        }
        return
      }
      if (key.name === "left") {
        setEditing({ ...ed, cursor: Math.max(0, ed.cursor - 1) })
        return
      }
      if (key.name === "right") {
        setEditing({ ...ed, cursor: Math.min([...ed.draft].length, ed.cursor + 1) })
        return
      }
      if (key.name === "home") {
        setEditing({ ...ed, cursor: 0 })
        return
      }
      if (key.name === "end") {
        setEditing({ ...ed, cursor: [...ed.draft].length })
        return
      }
      const ch = keyChar(key)
      if (!key.ctrl && !key.meta && ch.length === 1) {
        const chars = [...ed.draft]
        const c = Math.min(ed.cursor, chars.length)
        const next = chars.slice(0, c).concat([ch], chars.slice(c)).join("")
        setEditing({ ...ed, draft: next, cursor: c + ch.length })
      }
      return
    }

    // 2. Destructive confirm: y confirms, n/Esc cancels; Enter does nothing.
    const c = confirm()
    if (c !== null) {
      const yes = !key.ctrl && !key.meta && (keyChar(key) === "y" || keyChar(key) === "Y")
      if (yes) {
        setConfirm(null)
        c.onYes()
        return
      }
      if (key.name === "escape" || keyChar(key).toLowerCase() === "n") setConfirm(null)
      return
    }

    const isEnter = isEnterKey(key)

    // 3. Filter mode: the flat ranked list owns the body.
    if (filter().length > 0) {
      if (key.name === "escape") {
        setFilter("")
        setFilterFocused(false)
        return
      }
      if (key.name === "backspace") {
        setFilter((f) => backspaceFilter(f))
        setFilterIdx(0)
        return
      }
      if (isEnter && !key.ctrl && !key.meta) {
        const entry = filtered()[clampedFilterIdx()]
        if (entry) entry.run()
        return
      }
      const step = stepIndex(key, { index: clampedFilterIdx(), count: filtered().length, pageSize: bodyRows(), vim: false })
      if (step !== null) {
        setFilterIdx(step)
        return
      }
      if (!key.ctrl && !key.meta && key.name.length === 1) {
        setFilterFocused(true)
        setFilter((f) => f + keyChar(key))
        setFilterIdx(0)
      }
      return
    }

    // 4. Normal rail/detail navigation.
    const onRail = pane() === "rail"
    const count = onRail ? SETTINGS_CATEGORIES.length : detailFields().length
    const index = onRail ? clampedCatIdx() : clampedDetailIdx()
    if (key.name === "/" && !key.ctrl && !key.meta && !key.shift) {
      setFilterFocused(true)
      return
    }
    const step = stepIndex(key, { index, count, pageSize: bodyRows(), vim: !filterFocused() })
    if (step !== null) {
      if (onRail) setCatIdx(step)
      else setDetailIdx(step)
      return
    }

    if (isEnter && !key.ctrl && !key.meta) {
      if (onRail) openCategory(clampedCatIdx())
      else activate(detailFields()[clampedDetailIdx()])
      return
    }
    if (key.name === "escape") {
      if (filterFocused()) {
        setFilterFocused(false)
        return
      }
      if (advancedFor() !== null) {
        closeAdvanced()
        return
      }
      props.onClose()
      return
    }
    if (key.name === "tab" || key.name === "BTab") {
      setPane(onRail ? "detail" : "rail")
      return
    }
    if (key.name === "left" || key.name === "right") {
      const field = detailFields()[clampedDetailIdx()]
      if (!onRail && field?.kind === "cycle") {
        field.onCycle?.(key.name === "left" ? -1 : 1)
        return
      }
      setPane(key.name === "left" ? "rail" : "detail")
      return
    }
    const ch = keyChar(key)
    if (!key.ctrl && !key.meta && ch.length === 1) {
      // Start a filter query (j/k/g/G were consumed as navigation above).
      setFilterFocused(true)
      setFilter(ch)
      setFilterIdx(0)
    }
  }
  props.store.overlayKeyHandler = handleOverlayKey
  // Paste targets whatever the key handler would type into: the inline edit
  // draft (cursor-aware) or the type-to-filter query. Single-line only.
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    const ed = editing()
    if (ed !== null) {
      const chars = [...ed.draft]
      const c = Math.min(ed.cursor, chars.length)
      const ins = [...text]
      setEditing({ ...ed, draft: chars.slice(0, c).concat(ins, chars.slice(c)).join(""), cursor: c + ins.length })
      return
    }
    if (confirm() !== null) return
    setFilterFocused(true)
    setFilter((f) => f + text)
    setFilterIdx(0)
  }

  // ---- mouse -----------------------------------------------------------------

  const pickDetail = (idx: number, field: Field): void => {
    setPane("detail")
    setDetailIdx(idx)
    if (editing() !== null && editing()?.id !== field.id) commitEditing()
    if (field.kind === "text" && !(editing()?.id === field.id)) startEditing(field)
    else if (editing()?.id === field.id) return
    else activate(field)
  }

  // ---- rendering -------------------------------------------------------------

  const activeHint = createMemo(() => {
    void editing()
    let text: string
    if (filter().length > 0) text = " type to filter · ↑/↓ pick · Enter open · Esc clear"
    else if (pane() === "rail") text = " / search · ↑/↓ or j/k choose a section · Enter open · Tab detail · Esc close"
    else text = ` ${detailFields()[clampedDetailIdx()]?.hint ?? ""}`
    return text.padEnd(Math.max(10, metrics().innerWidth - 2))
  })

  const title = (): string => {
    if (filter().length > 0) return " settings · filter "
    if (advancedFor() !== null) return ` settings · ${advancedFor()} · advanced `
    if (catName() === "Endpoints" && endpointSel() !== null) return ` settings · endpoint "${draftEp(endpointSel() ?? 0).name}" `
    return ` settings · ${catName()} `
  }

  return (
    <OverlayPanel title={title()} onClose={props.onClose}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <Show when={filter().length === 0}>
          <box style={{ flexDirection: "row", flexGrow: 1 }}>
              <box
                style={{
                  width: RAIL_WIDTH,
                  flexShrink: 0,
                  flexDirection: "column",
                  border: ["right" as const],
                  borderStyle: "single",
                  borderColor: t().border,
                }}
              >
                <For each={railRows()}>
                  {(row) => (
                    <RailRow
                      label={row.label}
                      idx={row.idx}
                      selected={() => pane() === "rail" && row.idx === clampedCatIdx()}
                      hovered={() => hover() === `rail:${row.idx}`}
                      budget={() => railBudget()}
                      onHover={(on) => setHoverKey(`rail:${row.idx}`, on)}
                      onPick={(i) => openCategory(i)}
                    />
                  )}
                </For>
              </box>
              <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1 }}>
                <For each={detailRows()}>
                  {(row) => (
                    <DetailRow
                      field={row.field}
                      idx={row.idx}
                      selected={() => pane() === "detail" && row.idx === clampedDetailIdx()}
                      hovered={() => hover() === `detail:${row.idx}`}
                      budget={() => detailBudget()}
                      isEditing={() => editing()?.id === row.field.id}
                      draft={() => editing()?.draft ?? ""}
                      cursor={() => editing()?.cursor ?? 0}
                      onHover={(on) => setHoverKey(`detail:${row.idx}`, on)}
                      onPick={pickDetail}
                    />
                  )}
                </For>
                <Show when={catName() === "MCP servers" && detailFields().length === 0}>
                  <text selectable={false} style={{ fg: t().muted }}>{" no MCP servers configured — add mcp.servers in config.json ".padEnd(detailBudget())}</text>
                </Show>
                <Show when={advancedFor() === "Appearance"}>
                  <box style={{ flexDirection: "column" }}>
                    <box style={{ height: 1 }} />
                    <text selectable={false} style={{ fg: t().muted }}>{` shell: ${props.config.shell}`.padEnd(detailBudget())}</text>
                  </box>
                </Show>
              </box>
          </box>
        </Show>
        <Show when={filter().length > 0}>
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            <Show
              when={filtered().length > 0}
              fallback={<text selectable={false} style={{ fg: t().muted }}>{` no settings match "${filter()}" `}</text>}
            >
              <For each={filterRows()}>
                {(row) => (
                  <FilterRow
                    label={row.entry.label}
                    category={row.entry.category}
                    idx={row.idx}
                    selected={() => row.idx === clampedFilterIdx()}
                    hovered={() => hover() === `filter:${row.idx}`}
                    budget={() => filterBudget()}
                    onHover={(on) => setHoverKey(`filter:${row.idx}`, on)}
                    onPick={(i) => filtered()[i]?.run()}
                  />
                )}
              </For>
            </Show>
          </box>
        </Show>
      </box>
      <Show when={catName() === "Endpoints" && endpointSel() !== null}>
        <TestResultLine test={test()} />
      </Show>
      <Show
        when={confirm() === null}
        fallback={<text selectable={false} style={{ fg: t().danger }}>{` ${confirm()?.message ?? ""} `}</text>}
      >
        <text selectable={false} style={{ fg: t().muted }}>{activeHint()}</text>
      </Show>
      <Show when={filter().length > 0}>
        <text selectable={false} style={{ fg: t().accent }}>{` filter: ${filter()}_`}</text>
      </Show>
      <text selectable={false} style={{ fg: t().muted }}>
        {filter().length > 0
          ? " type to filter · ↑/↓ pick · Enter open · Esc clear "
          : " / search · Tab pane · ↑/↓ or j/k move · ←/→ cycle · Enter edit/run · Esc close "}
      </text>
    </OverlayPanel>
  )
}
