/**
 * SetupWizard — the interactive setup surface (docs/operations.md "Setup
 * setup"), now an ordinary in-app OVERLAY (settings-sized modal) rather than
 * its own pre-boot renderer. Because setup lives inside sensus, a plain first
 * run, `sensus init`, a boot config error, `` and Ctrl+P → Setup flow
 * all reach the same component; nothing needs the terminal engine to boot
 * first.
 *
 * On save the caller (App) live-reloads config.json and opens the first-run
 * welcome overlay, so setup ends inside sensus. Leaving the modal (Esc, the
 * backdrop, or the exit button) asks first — nothing is written, and the same
 * knobs are always editable in the settings screen (Ctrl+O) or config.json.
 *
 * All non-render logic lives in `src/config/setup.ts` (pure, unit-tested);
 * this component owns only signals plus fetch/file IO:
 *   1 existing  keep / edit / fresh when config.json is already there
 *   2 theme     pick a theme with live preview through the theme token map
 *   3 endpoint  provider + name + baseURL + api key
 *   4 test      the daemon probes the draft over its protocol
 *               (`POST /v1/models/probe`) → ok/fail + count
 *   5 model     pick a fetched model (chat-capable) or type an id
 *   6 hostscan  optionally run the host_scan probes and seed HOST.md
 *   7 review    validate, then write config.json atomically (unknown keys
 *               preserved on edit; starter keys folded in on fresh) and hand
 *               the result to the caller
 *
 * Interaction model (the "press Enter to edit" contract):
 *   - Everything is a ROW list. Browse with ↑/↓ (j/k where there is no text
 *     filter) or Tab; Enter activates the highlighted row. On the endpoint
 *     step a field row opens the single-line editor; the trailing
 *     "continue" row advances.
 *   - Editing is a cursor editor (SettingsScreen parity): printable/Backspace/
 *     Delete edit at the cursor, ←/→/Home/End move, Ctrl+U clears, Enter commits
 *     (and advances), Tab commits and moves on, Esc cancels just the edit.
 *   - Esc while browsing ASKS to exit (a confirm dialog explains the settings
 *     screen / config.json); on a filtered list Esc first clears the filter.
 *   - Rows and footer actions are clickable: hover highlights, click selects,
 *     a click on the selected model row picks it. Paste into a selected
 *     endpoint field (or while editing) inserts at the cursor.
 *
 * Input is routed through `store.overlayKeyHandler` / `store.overlayPasteHandler`
 * (App's single dispatch point), the same as every other overlay.
 *
 * No shell rc file is ever touched.
 */

import { type JSX, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { setTheme, theme, type ThemeColor, type ThemeName } from "../../theme/theme.ts"
import { cps, isEnterKey, printableKeyText, singleLinePaste, truncateWithEllipsis } from "../../core/util.ts"
import {
  buildConfigDoc,
  canonicalProvider,
  capSeedContent,
  chatModels,
  defaultDraft,
  draftFromConfig,
  ENDPOINT_FIELDS,
  endpointFieldValue,
  existingEndpointNames,
  firstStep,
  formatHostScan,
  HOST_SCAN_COMMANDS,
  isDefaultConfig,
  nextStep,
  normalizeTheme,
  planExistingChoice,
  planHostSeed,
  prevStep,
  PROTOCOL_KINDS,
  PROTOCOLS,
  rankModels,
  rankThemes,
  resolveModelChoice,
  STEP_TITLES,
  validateBaseURLInput,
  validateDraft,
  validateEndpointName,
  WIZARD_STEPS,
  WIZARD_THEMES,
  withEndpointField,
  withProvider,
  type EndpointDraft,
  type EndpointField,
  type EndpointModel,
  type ExistingChoice,
  type HostScanEntry,
  type ProtocolKind,
  type RawConfigDoc,
  type WizardDraft,
  type WizardMode,
  type WizardResult,
  type WizardStep,
} from "../../engine/index.ts"
import { menuWindow } from "../chat/commandMenu.ts"
import {
  commitDraft,
  draftParts,
  editDraft,
  startDraft,
  type MemoryDraft,
  type MemoryDraftEdit,
} from "../chat/memoryManager.ts"
import { overlayNavStep } from "./overlay/nav.ts"
import { OverlayPanel, overlayMetrics, overlayRowStyle } from "./overlayKit.tsx"
import type { UiStore } from "../lib/store.ts"

export interface SetupWizardProps {
  /** UI store — the setup flow registers its key/paste handlers on it (App routes
   * all overlay input through the store's single dispatch point). */
  store: UiStore
  /** The raw (secret-free) config document the daemon owns (D13). */
  rawConfig: Record<string, unknown>
  /** The live HOST.md content, or null (the seed refuses to clobber one). */
  hostContent: string | null
  /** HOST.md character cap (config `memory.hostCharLimit`). */
  hostCharLimit: number
  /** Persist the built config doc through the daemon; error message or null. */
  onSaveDoc: (doc: RawConfigDoc) => Promise<string | null>
  /** Seed HOST.md through the daemon; true when written. */
  onSeedHost: (content: string) => Promise<boolean>
  /** Probe the draft endpoint through the daemon (`POST /v1/models/probe`). */
  testConnection: (draft: { provider?: string; baseURL: string; apiKey: string }) => Promise<{ ok: boolean; error?: string; models?: EndpointModel[] }>
  onDone: (result: WizardResult) => void
}

type TestPhase = "idle" | "loading" | "ok" | "fail"
type HostPhase = "ask" | "running" | "done" | "skipped"

/** Display labels for the editable endpoint fields. */
const FIELD_LABELS: Record<EndpointField, string> = {
  provider: "provider",
  name: "name",
  baseURL: "base URL",
  apiKey: "API key",
}
/** Label column width (label + colon), so values line up. */
const FIELD_LABEL_WIDTH = 9
/** The `existing` step's choices, in display order. */
const EXISTING_CHOICES: readonly { key: ExistingChoice; label: string; desc: string }[] = [
  { key: "keep", label: "keep", desc: "leave the file untouched and start sensus" },
  { key: "edit", label: "edit", desc: "preload the current endpoint, model and theme" },
  { key: "fresh", label: "fresh", desc: "start over and replace the file" },
]
/** The `hostscan` step's choices, in display order. */
const HOST_CHOICES: readonly { action: "scan" | "skip"; label: string; desc: string }[] = [
  { action: "scan", label: "scan & seed HOST.md", desc: "read-only probes · seeds the capped draft · never overwrites an existing HOST.md" },
  { action: "skip", label: "skip", desc: "leave HOST.md alone" },
]

/** Canonical real-protocol kind for display/cycling; mock/unknown → the default. */
function protocolKindOf(raw: string): ProtocolKind {
  const kind = canonicalProvider(raw)
  return kind !== null && kind !== "mock" ? kind : "openai-compatible"
}

/** Friendly provider label (mock is only reachable via a preloaded config here). */
function providerLabel(raw: string): string {
  const kind = canonicalProvider(raw)
  if (kind === null) return PROTOCOLS["openai-compatible"].label
  return kind === "mock" ? "mock (test seam)" : PROTOCOLS[kind].label
}

/** Cycle the draft through the real protocols (mock is NOT offered), letting
 * `withProvider` move a defaulted baseURL to the new protocol's default. */
function cycleProvider(ep: EndpointDraft, dir: 1 | -1): EndpointDraft {
  const current = canonicalProvider(ep.provider)
  const idx = current !== null && current !== "mock" ? PROTOCOL_KINDS.indexOf(current) : -1
  const at = idx < 0 ? 0 : (idx + dir + PROTOCOL_KINDS.length) % PROTOCOL_KINDS.length
  const next = PROTOCOL_KINDS[at]
  return next === undefined ? ep : withProvider(ep, next)
}

/** Mask everything but the last 4 chars of an api key for display. */
function maskKey(key: string): string {
  if (key.length <= 4) return "•".repeat(key.length)
  return `${"•".repeat(Math.min(12, key.length - 4))}${key.slice(-4)}`
}

/** Wizard drafts carry a plain string theme; normalize to a registry name. */
function asThemeName(name: string): ThemeName {
  return normalizeTheme(name) ?? "terminal"
}

/** A single endpoint-field edit: which field + its cursor draft. */
interface EndpointEdit {
  field: EndpointField
  draft: MemoryDraft
}

/** Print a color sample for the live theme preview. */
function Swatch(props: { label: string; fg: string; bg: ThemeColor }): JSX.Element {
  return (
    <text selectable={false} style={{ fg: props.fg, bg: props.bg }}>{` ${props.label} `}</text>
  )
}

export function SetupWizard(props: SetupWizardProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const m = () => overlayMetrics(dims())
  // The daemon owns the config + memory files (D13): seed from the raw config
  // snapshot and the live HOST.md the caller fetched over REST.
  const configLabel = "config.json"
  const hostLabel = "HOST.md"
  const rawExisting = props.rawConfig as RawConfigDoc
  const existing = isDefaultConfig(rawExisting) ? null : rawExisting
  const initial = draftFromConfig(existing)
  const hostCharLimit = props.hostCharLimit
  const hostExisting = props.hostContent

  const [step, setStep] = createSignal<WizardStep>(firstStep(existing !== null))
  // A clean install folds in the starter keys (`--create-config` semantics);
  // an existing file is patched (merge) unless the user picks "fresh".
  const [mode, setMode] = createSignal<WizardMode>(existing === null ? "fresh" : "merge")
  const [existingSel, setExistingSel] = createSignal(0)
  const [allowedName, setAllowedName] = createSignal<string | undefined>(
    existing !== null ? initial.endpoint.name : undefined,
  )

  // endpoint step: 3 field rows + a trailing "continue" row; `edit` holds the
  // one field currently open for editing (browse mode owns the rest).
  const [endpoint, setEndpoint] = createSignal<EndpointDraft>(initial.endpoint)
  const [endpointSel, setEndpointSel] = createSignal(0)
  const [edit, setEdit] = createSignal<EndpointEdit | null>(null)
  const [revealKey, setRevealKey] = createSignal(false)
  const [error, setError] = createSignal("")

  // test step
  const [testPhase, setTestPhase] = createSignal<TestPhase>("idle")
  const [models, setModels] = createSignal<EndpointModel[]>([])
  const [testError, setTestError] = createSignal("")

  // model step
  const [modelFilter, setModelFilter] = createSignal("")
  const [modelSel, setModelSel] = createSignal(0)
  const [model, setModel] = createSignal(initial.model)

  // theme step
  const [themeChoice, setThemeChoice] = createSignal<ThemeName>(asThemeName(initial.theme))
  const [themeFilter, setThemeFilter] = createSignal("")
  const originalTheme = theme().name

  // host scan step
  const [hostPhase, setHostPhase] = createSignal<HostPhase>("ask")
  const [hostSel, setHostSel] = createSignal(0)
  const [seedHost, setSeedHost] = createSignal(false)
  const [hostDraft, setHostDraft] = createSignal("")
  const [hostMessage, setHostMessage] = createSignal("")

  // review step
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal("")

  // shared pointer target key (`model:3`, `btn:back`, …)
  const [hover, setHover] = createSignal<string | null>(null)
  // Leaving is confirm-gated: Esc / a backdrop click / the exit button first
  // explain that the same knobs live in Ctrl+O and config.json.
  const [confirmExit, setConfirmExit] = createSignal(false)
  let finished = false

  const contentWidth = (): number => Math.max(20, m().innerWidth - 2)
  const padTo = (used: number): string => " ".repeat(Math.max(0, contentWidth() - used))

  const existingNames = (): string[] => (mode() === "fresh" ? [] : existingEndpointNames(existing))
  const currentDraft = (): WizardDraft => ({
    endpoint: endpoint(),
    model: model(),
    theme: themeChoice(),
    seedHost: seedHost(),
  })

  // Ranked/windowed lists. The model list windows like the theme list so a
  // long catalog is fully reachable (previously rows past the viewport were
  // unreachable).
  const ranked = createMemo<EndpointModel[]>(() => rankModels(chatModels(models()), modelFilter()))
  const modelRows = (): number => Math.max(3, m().innerHeight - 13)
  const modelWin = createMemo(() => {
    const items = ranked()
    const sel = Math.max(0, Math.min(modelSel(), Math.max(0, items.length - 1)))
    const w = menuWindow(items.length, sel, modelRows())
    return { rows: items.slice(w.start, w.start + w.list), start: w.start, selIdx: w.selIdx }
  })

  const rankedThemes = createMemo<ThemeName[]>(() => rankThemes(WIZARD_THEMES, themeFilter()))
  const themeRows = (): number => Math.max(3, m().innerHeight - 16)
  const themeSel = (): number => Math.max(0, rankedThemes().indexOf(themeChoice()))
  const themeWin = createMemo(() => {
    const items = rankedThemes()
    const w = menuWindow(items.length, themeSel(), themeRows())
    return { rows: items.slice(w.start, w.start + w.list), start: w.start, selIdx: w.selIdx }
  })
  /** Highlight + preview the theme at `index` in the ranked list. */
  const pickThemeAt = (index: number): void => {
    const name = rankedThemes()[index]
    if (name) {
      setThemeChoice(name)
      setTheme(name)
    }
  }

  const finish = (result: WizardResult): void => {
    if (finished) return
    finished = true
    props.onDone(result)
  }

  const cancel = (): void => {
    setTheme(originalTheme)
    finish({ status: "cancelled", path: configLabel })
  }

  /** Ask before leaving: setup is skippable, but the user should know the same
   * settings stay editable afterwards (Ctrl+O / config.json / ). */
  const requestExit = (): void => {
    if (!finished) setConfirmExit(true)
  }
  const stayInSetup = (): void => {
    setConfirmExit(false)
  }

  const goto = (next: WizardStep): void => {
    setError("")
    setEdit(null)
    setHover(null)
    setStep(next)
    if (next === "test") void runTest()
    if (next === "hostscan" && hostPhase() === "ask") setHostSel(0)
    if (next === "theme") {
      setThemeFilter("")
      setTheme(themeChoice())
    }
  }

  /** Follow the step machine forward; past review (no next) means save. */
  const advance = (): void => {
    const next = nextStep(step())
    if (next === null) write()
    else goto(next)
  }

  const canGoBack = (): boolean => prevStep(step(), existing !== null) !== null

  /** Step back along the machine (setup-level, not the field edit). */
  const goBack = (): void => {
    const prev = prevStep(step(), existing !== null)
    if (prev === null) return
    setEdit(null)
    goto(prev)
  }

  // ---- IO: test connection --------------------------------------------------

  async function runTest(): Promise<void> {
    setTestPhase("loading")
    setTestError("")
    const r = await props.testConnection({
      provider: endpoint().provider,
      baseURL: endpoint().baseURL.trim(),
      apiKey: endpoint().apiKey,
    })
    if (!r.ok) {
      setModels([])
      setTestError(r.error ?? "connection failed")
      setTestPhase("fail")
      return
    }
    setModels(r.models ?? [])
    setTestPhase("ok")
  }

  // ---- IO: host scan --------------------------------------------------------

  async function runHostScan(): Promise<void> {
    setHostPhase("running")
    setHostMessage("")
    const entries: HostScanEntry[] = []
    for (const command of HOST_SCAN_COMMANDS) {
      let output = ""
      let ok = false
      try {
        const proc = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "ignore" })
        const timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {
            // already dead
          }
        }, 20_000)
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        clearTimeout(timer)
        output = out
        ok = code === 0
      } catch {
        ok = false
      }
      entries.push({ command, output, ok })
    }
    const rawDraft = formatHostScan(entries, { cwd: null })
    const scan = { ok: entries.filter((e) => e.ok).length, total: entries.length }
    setSeedHost(true)

    // An existing non-empty HOST.md is never clobbered (the seed plan refuses
    // to write anyway) — skip straight to done.
    if (hostExisting !== null && hostExisting.trim().length > 0) {
      setHostDraft(rawDraft)
      setHostPhase("done")
      setHostMessage(`HOST.md already exists — it will NOT be overwritten`)
      return
    }

    // Seed the raw capped scan; the agent curates HOST.md later through the
    // memory tool (docs/memory.md "Rewrite").
    setHostDraft(capSeedContent(rawDraft, hostCharLimit))
    setHostPhase("done")
    setHostMessage(`scan ready: ${scan.ok}/${scan.total} probes answered · seeding the raw scan`)
  }

  function skipHostScan(): void {
    setSeedHost(false)
    setHostPhase("skipped")
    goto("review")
  }

  // ---- IO: write ------------------------------------------------------------

  function write(): void {
    if (saving()) return
    const draft = currentDraft()
    const err = validateDraft(draft, existingNames(), { allow: allowedName() })
    if (err !== null) {
      setSaveError(err)
      return
    }
    setSaving(true)
    // The typed API key goes into the daemon's encrypted store, never the file:
    // `PUT /v1/config` captures it and writes a `${NAME}` ref (docs/config.md).
    const doc = buildConfigDoc(existing, draft, mode())
    void (async () => {
      const err = await props.onSaveDoc(doc)
      if (err !== null) {
        setSaveError(err)
        setSaving(false)
        return
      }
      const plan = planHostSeed({
        requested: seedHost(),
        existing: hostExisting,
        draft: hostDraft(),
        limit: hostCharLimit,
      })
      const hostSeeded = plan.write ? await props.onSeedHost(plan.content) : false
      // Hand the result to the caller immediately: index.tsx boots the TUI and
      // shows the first-run welcome overlay (docs/operations.md "Setup flow").
      finish({ status: "saved", path: configLabel, hostSeeded, hostPath: hostSeeded ? hostLabel : undefined })
    })()
  }

  // ---- existing-config choice ----------------------------------------------

  function chooseExisting(choice: ExistingChoice): void {
    const plan = planExistingChoice(choice)
    if (!plan.proceed) {
      finish({ status: "kept", path: configLabel })
      return
    }
    setMode(plan.mode)
    if (choice === "edit") {
      setEndpoint(initial.endpoint)
      setModel(initial.model)
      setThemeChoice(asThemeName(initial.theme))
      setThemeFilter("")
      setAllowedName(initial.endpoint.name)
    } else {
      const fresh = defaultDraft()
      setEndpoint(fresh.endpoint)
      setModel(fresh.model)
      setThemeChoice(asThemeName(fresh.theme))
      setThemeFilter("")
      setAllowedName(undefined)
    }
    setEndpointSel(0)
    goto("theme")
  }

  // ---- endpoint editing -----------------------------------------------------

  const endpointRowCount = (): number => ENDPOINT_FIELDS.length + 1
  const isContinueRow = (): boolean => endpointSel() === ENDPOINT_FIELDS.length
  const continueRowStyle = (): Record<string, unknown> =>
    overlayRowStyle(t(), isContinueRow(), t().fg, hover() === "field:continue")
  const continueRowFg = (): ThemeColor => continueRowStyle().fg as ThemeColor
  const continueRowBg = (): ThemeColor => continueRowStyle().bg as ThemeColor

  /** The resolved default baseURL for the draft's protocol. */
  const protocolDefault = (): string => PROTOCOLS[protocolKindOf(endpoint().provider)].defaultBaseURL

  /** The value shown for a field when it is not being edited; `muted` marks a
   * placeholder (an empty baseURL resolved to the protocol default). */
  function fieldDisplay(field: EndpointField): { text: string; muted: boolean } {
    if (field === "provider") return { text: providerLabel(endpoint().provider), muted: false }
    if (field === "apiKey") {
      return { text: revealKey() ? endpoint().apiKey : maskKey(endpoint().apiKey), muted: false }
    }
    if (field === "baseURL") {
      const v = endpointFieldValue(endpoint(), field)
      if (v.trim().length > 0) return { text: v, muted: false }
      return { text: `${protocolDefault()} (default)`, muted: true }
    }
    return { text: endpointFieldValue(endpoint(), field), muted: false }
  }

  /** The hint shown under the field rows for the highlighted row. */
  function fieldHint(): string {
    const field = ENDPOINT_FIELDS[endpointSel()]
    switch (field) {
      case "provider":
        return `${providerLabel(endpoint().provider)} — Enter/←/→ cycles the protocol`
      case "baseURL":
        return `base URL (empty = ${protocolDefault()})`
      case "apiKey":
        return `key for this endpoint · e.g. ${PROTOCOLS[protocolKindOf(endpoint().provider)].apiKeyEnv} · empty → chat disabled`
      case "name":
        return "endpoint name — no @, must be unique"
      default:
        return ""
    }
  }

  function startEdit(field: EndpointField): void {
    setError("")
    setEdit({ field, draft: startDraft(endpointFieldValue(endpoint(), field)) })
  }

  function applyEdit(action: MemoryDraftEdit): void {
    setEdit((e) => (e === null ? e : { ...e, draft: editDraft(e.draft, action) }))
  }

  /** Commit the open edit into the draft and advance one row. */
  function commitEdit(): void {
    const e = edit()
    if (e === null) return
    setEndpoint((ep) => withEndpointField(ep, e.field, commitDraft(e.draft)))
    setEdit(null)
    setEndpointSel((s) => Math.min(endpointRowCount() - 1, Math.max(0, s + 1)))
  }

  /** Activate the highlighted endpoint row: cycle the provider, edit a field or continue. */
  function activateEndpointRow(): void {
    const idx = endpointSel()
    if (idx < ENDPOINT_FIELDS.length) {
      const field = ENDPOINT_FIELDS[idx]
      if (field === "provider") setEndpoint((ep) => cycleProvider(ep, 1))
      else if (field !== undefined) startEdit(field)
      return
    }
    submitEndpoint()
  }

  function submitEndpoint(): void {
    const ep = endpoint()
    const nErr = validateEndpointName(ep.name, existingNames(), { allow: allowedName() })
    if (nErr !== null) {
      setEndpointSel(ENDPOINT_FIELDS.indexOf("name"))
      setError(nErr)
      return
    }
    // Empty is valid: it resolves to the protocol default (validateDraft).
    const baseURL = ep.baseURL.trim()
    if (baseURL.length > 0) {
      const uErr = validateBaseURLInput(baseURL)
      if (uErr !== null) {
        setEndpointSel(ENDPOINT_FIELDS.indexOf("baseURL"))
        setError(uErr)
        return
      }
    }
    setError("")
    goto("test")
  }

  function chooseModel(): void {
    const id = resolveModelChoice(ranked(), modelWin().selIdx, modelFilter())
    if (id === null) {
      setError("type a model id or pick a row")
      return
    }
    setModel(id)
    setError("")
    goto("hostscan")
  }

  // ---- keyboard -------------------------------------------------------------

  // App routes every overlay key through this single handler (the store's
  // dispatch point; release events are filtered by App before we see them).
  props.store.overlayKeyHandler = (key) => {
    if (finished) return

    // 0. The exit-confirm dialog owns the keyboard while it is up.
    if (confirmExit()) {
      if (key.name === "escape" || isEnterKey(key)) {
        stayInSetup()
        return
      }
      if (key.name === "y" || key.name === "e") {
        cancel()
        return
      }
      return
    }

    // 1. An open endpoint-field edit owns every key until Enter/Tab/Esc.
    if (edit() !== null) {
      if (isEnterKey(key) && !key.ctrl) {
        commitEdit()
        return
      }
      if (key.name === "tab") {
        commitEdit()
        return
      }
      if (key.name === "BTab") {
        const e = edit()
        if (e !== null) {
          setEndpoint((ep) => withEndpointField(ep, e.field, commitDraft(e.draft)))
          setEdit(null)
          setEndpointSel((s) => Math.max(0, s - 1))
        }
        return
      }
      if (key.name === "escape") {
        setEdit(null)
        return
      }
      if (key.name === "backspace") return applyEdit({ type: "backspace" })
      if (key.name === "delete") return applyEdit({ type: "delete" })
      if (key.name === "left") return applyEdit({ type: "left" })
      if (key.name === "right") return applyEdit({ type: "right" })
      if (key.name === "home") return applyEdit({ type: "home" })
      if (key.name === "end") return applyEdit({ type: "end" })
      if (key.ctrl && key.name === "u") return applyEdit({ type: "clear" })
      if (key.ctrl && key.name === "r") {
        setRevealKey((v) => !v)
        return
      }
      const ch = printableKeyText(key)
      if (ch !== null) applyEdit({ type: "insert", char: ch })
      return
    }

    // 2. Wizard-level Esc: clear a list filter first, else ask before exiting.
    if (key.name === "escape" && !key.ctrl) {
      if (step() === "model" && modelFilter().length > 0) {
        setModelFilter("")
        setModelSel(0)
        return
      }
      if (step() === "theme" && themeFilter().length > 0) {
        setThemeFilter("")
        return
      }
      requestExit()
      return
    }

    switch (step()) {
      case "existing": {
        if (key.name === "up" || key.name === "k") setExistingSel((s) => Math.max(0, s - 1))
        else if (key.name === "down" || key.name === "j" || key.name === "tab") setExistingSel((s) => Math.min(2, s + 1))
        else if (key.name === "BTab") setExistingSel((s) => Math.max(0, s - 1))
        else if (isEnterKey(key) || key.name === "space") {
          const choice = EXISTING_CHOICES[existingSel()]?.key ?? "keep"
          chooseExisting(choice)
        } else if (key.name === "e") chooseExisting("edit")
        else if (key.name === "f") chooseExisting("fresh")
        return
      }
      case "endpoint": {
        if (key.name === "up" || key.name === "k") setEndpointSel((s) => Math.max(0, s - 1))
        else if (key.name === "down" || key.name === "j" || key.name === "tab") {
          setEndpointSel((s) => Math.min(endpointRowCount() - 1, s + 1))
        } else if (key.name === "BTab") setEndpointSel((s) => Math.max(0, s - 1))
        else if (isEnterKey(key)) activateEndpointRow()
        else if (key.name === "left" || key.name === "right") {
          // On the provider row ←/→ cycle the protocol; elsewhere ← steps back.
          if (ENDPOINT_FIELDS[endpointSel()] === "provider") {
            setEndpoint((ep) => cycleProvider(ep, key.name === "left" ? -1 : 1))
          } else if (key.name === "left") goBack()
        } else if (key.ctrl && key.name === "r") setRevealKey((v) => !v)
        return
      }
      case "test": {
        if (key.name === "r" && !key.ctrl && !key.meta) void runTest()
        else if (key.name === "e" && !key.ctrl && !key.meta) goto("endpoint")
        else if (isEnterKey(key) || key.name === "s") advance()
        else if (key.name === "left") goBack()
        return
      }
      case "model": {
        const nav = overlayNavStep(key, {
          index: modelWin().selIdx,
          count: ranked().length,
          pageSize: modelRows(),
          vim: false,
          wrap: true,
        })
        if (nav !== null) {
          setModelSel(nav)
          return
        }
        if (isEnterKey(key) && !key.ctrl) {
          chooseModel()
          return
        }
        if (key.name === "left") {
          goBack()
          return
        }
        if (key.name === "backspace") {
          setModelFilter((f) => [...f].slice(0, -1).join(""))
          setModelSel(0)
          return
        }
        const ch = printableKeyText(key)
        if (ch !== null) {
          setModelFilter((f) => f + ch)
          setModelSel(0)
        }
        return
      }
      case "theme": {
        const nav = overlayNavStep(key, {
          index: themeWin().selIdx,
          count: rankedThemes().length,
          pageSize: themeRows(),
          vim: false,
          wrap: true,
        })
        if (nav !== null) {
          pickThemeAt(nav)
          return
        }
        if (isEnterKey(key)) {
          advance()
          return
        }
        if (key.name === "left") {
          goBack()
          return
        }
        if (key.name === "backspace") {
          setThemeFilter((f) => [...f].slice(0, -1).join(""))
          return
        }
        const ch = printableKeyText(key)
        if (ch !== null) {
          setThemeFilter((f) => f + ch)
          pickThemeAt(0)
        }
        return
      }
      case "hostscan": {
        if (hostPhase() === "running") return
        if (hostPhase() === "ask") {
          if (key.name === "up" || key.name === "k") setHostSel((s) => Math.max(0, s - 1))
          else if (key.name === "down" || key.name === "j" || key.name === "tab") setHostSel((s) => Math.min(1, s + 1))
          else if (key.name === "BTab") setHostSel((s) => Math.max(0, s - 1))
          else if (key.name === "y") void runHostScan()
          else if (key.name === "n") skipHostScan()
          else if (isEnterKey(key)) {
            // Enter runs the HIGHLIGHTED row — it never silently skips: the
            // default highlight is scan, and y/n stay explicit.
            if (hostSel() === 0) void runHostScan()
            else skipHostScan()
          } else if (key.name === "left") goBack()
        } else if (isEnterKey(key) || key.name === "s") {
          advance()
        } else if (key.name === "left") {
          goBack()
        }
        return
      }
      case "review": {
        if (isEnterKey(key) || key.name === "s") advance()
        else if (key.name === "left") goBack()
        return
      }
    }
  }

  // Paste (bracketed paste / Ctrl+Shift+V) inserts at the cursor of an open
  // edit, or starts editing the selected endpoint field; on a filter it types
  // into the query. App decodes the bytes and routes the text here.
  // API keys are long and effectively untypable, so this path matters.
  props.store.overlayPasteHandler = (raw) => {
    if (finished || confirmExit()) return
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    if (edit() !== null) {
      applyEdit({ type: "insert", char: text })
      return
    }
    switch (step()) {
      case "endpoint": {
        const field = ENDPOINT_FIELDS[endpointSel()]
        // The provider row has no text editor; paste is a no-op there.
        if (field !== undefined && field !== "provider") {
          setError("")
          setEdit({ field, draft: { text, cursor: cps(text).length } })
        }
        return
      }
      case "model": {
        setModelFilter((f) => f + text)
        setModelSel(0)
        return
      }
      case "theme": {
        setThemeFilter((f) => f + text)
        pickThemeAt(0)
        return
      }
      default:
        return
    }
  }

  // ---- rendering ------------------------------------------------------------

  const visibleSteps = (): readonly WizardStep[] =>
    existing !== null ? WIZARD_STEPS : WIZARD_STEPS.filter((s) => s !== "existing")

  const progress = (): string => {
    const steps = visibleSteps()
    const shown = Math.max(1, steps.indexOf(step()) + 1)
    return `${shown}/${steps.length}`
  }

  const breadcrumb = (): string =>
    visibleSteps()
      .map((s) => (s === step() ? `[${STEP_TITLES[s]}]` : STEP_TITLES[s]))
      .join(" › ")

  /** Header step name. */
  const stepTitle = (): string => STEP_TITLES[step()]

  function hint(): string {
    if (edit() !== null) {
      return " Enter commit · Tab next · Esc cancel edit · ←/→ Home/End cursor · Ctrl+U clear "
    }
    switch (step()) {
      case "existing":
        return " ↑/↓ or j/k choose · Enter select · e edit · f fresh · Esc exit "
      case "endpoint":
        return " ↑/↓ or Tab move · Enter edit / cycle provider / continue · ← back · Esc cancel "
      case "test":
        return " r retry · e edit endpoint · Enter continue · ← back · Esc cancel "
      case "model":
        return " type to filter · ↑/↓ PgUp/PgDn pick · Enter use highlighted · ← back · Esc clear filter "
      case "theme":
        return " type to filter · ↑/↓ preview · Enter apply · ← back · Esc clear filter "
      case "hostscan":
        if (hostPhase() === "running") return " scanning the host with read-only probes … "
        if (hostPhase() === "ask") {
          return hostSel() === 0
            ? " ↑/↓ choose · Enter runs 'scan & seed' · y scan · n skip · ← back · Esc cancel "
            : " ↑/↓ choose · Enter runs 'skip' · y scan · n skip · ← back · Esc cancel "
        }
        return " Enter continue · ← back · Esc cancel "
      case "review":
        return " Enter save · ← back · Esc cancel "
    }
  }

  /** The footer's primary action, when a step has one separate from its rows. */
  function footerPrimary(): { label: string; onPress: () => void } | null {
    switch (step()) {
      case "test":
        return { label: "continue ▶", onPress: advance }
      case "model":
        return { label: "use highlighted ▶", onPress: chooseModel }
      case "theme":
        return { label: "apply & continue ▶", onPress: advance }
      case "hostscan":
        if (hostPhase() === "ask") {
          const scan = hostSel() === 0
          return {
            label: scan ? "scan & seed ▶" : "skip ▶",
            onPress: () => {
              if (scan) void runHostScan()
              else skipHostScan()
            },
          }
        }
        if (hostPhase() === "running") return null
        return { label: "continue ▶", onPress: advance }
      case "review":
        return { label: "save & exit ▶", onPress: advance }
      default:
        return null
    }
  }

  const btnStyle = (key: string, primary = false): Record<string, unknown> => {
    if (hover() === key) return { bg: t().selectionBg ?? "transparent", fg: t().onSelection ?? t().fg }
    return { bg: "transparent", fg: primary ? t().accent : t().fg }
  }

  return (
    <OverlayPanel title=" sensus setup " onClose={requestExit}>
      <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}>
        <Show when={confirmExit()}>
          <box style={{ flexDirection: "column", flexGrow: 1, justifyContent: "center", alignItems: "center" }}>
            <text selectable={false} style={{ fg: t().accent }}> exit setup? </text>
            <text selectable={false} style={{ fg: t().muted }}> Nothing has been saved. You can set everything up later: </text>
            <box style={{ height: 1 }} />
            <text selectable={false} style={{ fg: t().fg }}>   • Settings screen — Ctrl+O (endpoints, model, theme, agent) </text>
            <text selectable={false} style={{ fg: t().fg }}>   • Config file — {configLabel} (docs/config.md) </text>
            <text selectable={false} style={{ fg: t().fg }}>   • Reopen this setup anytime —  or Ctrl+P → Setup flow </text>
            <box style={{ height: 1 }} />
            <box style={{ flexDirection: "row" }}>
              <text
                selectable={false}
                style={btnStyle("confirm:stay", true)}
                onMouseOver={() => setHover("confirm:stay")}
                onMouseOut={() => setHover((h) => (h === "confirm:stay" ? null : h))}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  stayInSetup()
                }}
              >
                {" keep setting up "}
              </text>
              <text selectable={false} style={{ fg: t().muted }}>{"  "}</text>
              <text
                selectable={false}
                style={btnStyle("confirm:exit")}
                onMouseOver={() => setHover("confirm:exit")}
                onMouseOut={() => setHover((h) => (h === "confirm:exit" ? null : h))}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  cancel()
                }}
              >
                {" exit setup "}
              </text>
            </box>
            <box style={{ height: 1 }} />
            <text selectable={false} style={{ fg: t().muted }}> Esc / Enter stays · y exits </text>
          </box>
        </Show>
        <Show when={!confirmExit()}>
      <text selectable={false} style={{ fg: t().accent }}>
        {` sensus setup — ${stepTitle()} (${progress()}) `}
      </text>
      <text selectable={false} style={{ fg: t().muted }}>
        {` ${truncateWithEllipsis(breadcrumb(), contentWidth() - 1)} `}
      </text>
      <text selectable={false} style={{ fg: t().muted }}>
        {` ${truncateWithEllipsis(hint(), contentWidth() - 1)} `}
      </text>
      <box style={{ height: 1 }} />

      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        <Show when={step() === "existing"}>
            <text selectable={false} style={{ fg: t().fg }}> An existing config was found at {configLabel} </text>
            <text selectable={false} style={{ fg: t().muted }}> Your file is never touched unless you continue. </text>
            <box style={{ height: 1 }} />
            <For each={EXISTING_CHOICES}>
              {(choice, i) => {
                const selected = (): boolean => existingSel() === i()
                const hovered = (): boolean => hover() === `existing:${i()}`
                const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
                const fg = (): ThemeColor => rs().fg as ThemeColor
                const bg = (): ThemeColor => rs().bg as ThemeColor
                const text = `${selected() ? "❯ " : "  "}${choice.label.padEnd(6)} ${choice.desc}`
                return (
                  <text
                    selectable={false}
                    style={rs()}
                    onMouseOver={() => setHover(`existing:${i()}`)}
                    onMouseOut={() => setHover((h) => (h === `existing:${i()}` ? null : h))}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setExistingSel(i())
                      chooseExisting(choice.key)
                    }}
                  >
                    <span style={{ fg: fg(), bg: bg() }}>{text}</span>
                    <span style={{ fg: t().muted, bg: bg() }}>{padTo(cps(text).length)}</span>
                  </text>
                )
              }}
            </For>
          </Show>

          <Show when={step() === "endpoint"}>
            <text selectable={false} style={{ fg: t().muted }}> An endpoint is a provider: OpenAI-compatible, OpenAI Responses, Anthropic or Google Gemini. </text>
            <text selectable={false} style={{ fg: t().muted }}> Enter a field to edit it; Enter on ▸ continue moves on. </text>
            <box style={{ height: 1 }} />
            <For each={ENDPOINT_FIELDS}>
              {(field, i) => {
                const selected = (): boolean => endpointSel() === i()
                const editing = (): boolean => edit()?.field === field
                const hovered = (): boolean => hover() === `field:${field}`
                const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
                const fg = (): ThemeColor => rs().fg as ThemeColor
                const bg = (): ThemeColor => rs().bg as ThemeColor
                const label = `${FIELD_LABELS[field]}:`.padEnd(FIELD_LABEL_WIDTH) + " "
                const parts = (): { before: string; cursor: string; after: string; beforeMuted: boolean; afterMuted: boolean } => {
                  const e = edit()
                  if (e !== null && e.field === field) {
                    // A secret stays masked while edited unless Ctrl+R revealed it.
                    if (field === "apiKey" && !revealKey()) {
                      return { before: maskKey(e.draft.text), cursor: "▌", after: "", beforeMuted: false, afterMuted: false }
                    }
                    const p = draftParts(e.draft)
                    // An empty baseURL shows what it resolves to.
                    if (field === "baseURL" && p.before.length === 0 && p.after.length === 0) {
                      return { ...p, after: ` (empty = ${protocolDefault()})`, beforeMuted: false, afterMuted: true }
                    }
                    return { ...p, beforeMuted: false, afterMuted: false }
                  }
                  const d = fieldDisplay(field)
                  return { before: d.text, cursor: "", after: "", beforeMuted: d.muted, afterMuted: false }
                }
                const used = (): number => {
                  const p = parts()
                  return 2 + cps(label).length + cps(p.before).length + cps(p.cursor).length + cps(p.after).length
                }
                return (
                  <text
                    selectable={false}
                    style={rs()}
                    onMouseOver={() => setHover(`field:${field}`)}
                    onMouseOut={() => setHover((h) => (h === `field:${field}` ? null : h))}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      if (edit() !== null) commitEdit()
                      const idx = ENDPOINT_FIELDS.indexOf(field)
                      setEndpointSel(idx)
                      // The provider row cycles on click; the rest open the editor.
                      if (field === "provider") setEndpoint((ep) => cycleProvider(ep, 1))
                      else startEdit(field)
                    }}
                  >
                    <span style={{ fg: fg(), bg: bg() }}>{`${selected() ? "❯ " : "  "}${label}`}</span>
                    <span style={{ fg: parts().beforeMuted ? t().muted : fg(), bg: bg() }}>{parts().before}</span>
                    <span style={editing() ? { fg: t().onAccent, bg: t().accent } : { fg: fg(), bg: bg() }}>
                      {parts().cursor}
                    </span>
                    <span style={{ fg: parts().afterMuted ? t().muted : fg(), bg: bg() }}>{parts().after}</span>
                    <span style={{ fg: t().muted, bg: bg() }}>{padTo(used())}</span>
                  </text>
                )
              }}
            </For>
            <text selectable={false} style={{ fg: t().muted }}>
              {` ${truncateWithEllipsis(fieldHint(), contentWidth() - 1)}`}
            </text>
            <text
              selectable={false}
              style={continueRowStyle()}
              onMouseOver={() => setHover("field:continue")}
              onMouseOut={() => setHover((h) => (h === "field:continue" ? null : h))}
              onMouseDown={(e) => {
                e.stopPropagation()
                if (edit() !== null) commitEdit()
                setEndpointSel(ENDPOINT_FIELDS.length)
                submitEndpoint()
              }}
            >
              <span style={{ fg: continueRowFg(), bg: continueRowBg() }}>
                {`${isContinueRow() ? "❯ " : "  "}▸ continue to connection test`}
              </span>
              <span style={{ fg: t().muted, bg: continueRowBg() }}>
                {padTo(2 + cps("▸ continue to connection test").length)}
              </span>
            </text>
            <Show when={error().length > 0}>
              <text selectable={false} style={{ fg: t().danger }}> {error()} </text>
            </Show>
          </Show>

          <Show when={step() === "test"}>
            <text selectable={false} style={{ fg: t().fg }}> Testing {endpoint().baseURL.trim() || protocolDefault()} … </text>
            <Show when={testPhase() === "loading"}>
              <text selectable={false} style={{ fg: t().muted }}> probing {providerLabel(endpoint().provider)} /models … </text>
            </Show>
            <Show when={testPhase() === "ok"}>
              <text selectable={false} style={{ fg: t().success }}> ok — {models().length} model(s) available </text>
            </Show>
            <Show when={testPhase() === "fail"}>
              <text selectable={false} style={{ fg: t().danger }}> failed: {testError()} </text>
              <text selectable={false} style={{ fg: t().muted }}> You can still continue and type a model id by hand. </text>
            </Show>
          </Show>

          <Show when={step() === "model"}>
            <text selectable={false} style={{ fg: t().muted }}> Pick a model, or type an id and press Enter. </text>
            <text selectable={false} style={{ fg: t().accent }}> filter: {modelFilter()}_ </text>
            <box style={{ height: 1 }} />
            <Show
              when={ranked().length > 0}
              fallback={<text selectable={false} style={{ fg: t().muted }}> no fetched model matches — Enter uses "{modelFilter()}" </text>}
            >
              <For each={modelWin().rows}>
                {(m, i) => {
                  const idx = (): number => modelWin().start + i()
                  const selected = (): boolean => idx() === modelWin().selIdx
                  const hovered = (): boolean => hover() === `model:${idx()}`
                  const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), m.chat ? t().fg : t().muted, hovered())
                  const fg = (): ThemeColor => rs().fg as ThemeColor
                  const bg = (): ThemeColor => rs().bg as ThemeColor
                  const text = `${selected() ? "❯ " : "  "}${m.id}${m.chat ? "" : " (embeddings)"}`
                  return (
                    <text
                      selectable={false}
                      style={rs()}
                      onMouseOver={() => setHover(`model:${idx()}`)}
                      onMouseOut={() => setHover((h) => (h === `model:${idx()}` ? null : h))}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setModelSel(idx())
                        const picked = ranked()[idx()]
                        if (picked !== undefined) {
                          setModel(picked.id)
                          setError("")
                          goto("hostscan")
                        }
                      }}
                    >
                      <span style={{ fg: fg(), bg: bg() }}>{text}</span>
                      <span style={{ fg: t().muted, bg: bg() }}>{padTo(cps(text).length)}</span>
                    </text>
                  )
                }}
              </For>
            </Show>
            <Show when={error().length > 0}>
              <text selectable={false} style={{ fg: t().danger }}> {error()} </text>
            </Show>
          </Show>

          <Show when={step() === "theme"}>
            <text selectable={false} style={{ fg: t().muted }}> Live preview — the whole UI re-tints as you move. </text>
            <box style={{ flexDirection: "row" }}>
              <Swatch label="accent" fg={t().onAccent} bg={t().accent} />
              <Swatch label="success" fg={t().onAccent} bg={t().success} />
              <Swatch label="warning" fg={t().onAccent} bg={t().warning} />
              <Swatch label="danger" fg={t().onAccent} bg={t().danger} />
            </box>
            <text selectable={false} style={{ fg: t().accent }}> filter: {themeFilter()}_ </text>
            <box style={{ height: 1 }} />
            <Show
              when={rankedThemes().length > 0}
              fallback={<text selectable={false} style={{ fg: t().muted }}> no theme matches "{themeFilter()}" </text>}
            >
              <For each={themeWin().rows}>
                {(nameOpt, i) => {
                  const idx = (): number => themeWin().start + i()
                  const selected = (): boolean => themeSel() === idx()
                  const hovered = (): boolean => hover() === `theme:${idx()}`
                  const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
                  const fg = (): ThemeColor => rs().fg as ThemeColor
                  const bg = (): ThemeColor => rs().bg as ThemeColor
                  const text = `${selected() ? "❯ " : "  "}${nameOpt}`
                  return (
                    <text
                      selectable={false}
                      style={rs()}
                      onMouseOver={() => setHover(`theme:${idx()}`)}
                      onMouseOut={() => setHover((h) => (h === `theme:${idx()}` ? null : h))}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        pickThemeAt(idx())
                      }}
                    >
                      <span style={{ fg: fg(), bg: bg() }}>{text}</span>
                      <span style={{ fg: t().muted, bg: bg() }}>{padTo(cps(text).length)}</span>
                    </text>
                  )
                }}
              </For>
            </Show>
          </Show>

          <Show when={step() === "hostscan"}>
            <text selectable={false} style={{ fg: t().fg }}> Scan this machine with read-only probes and seed HOST.md? </text>
            <text selectable={false} style={{ fg: t().muted }}> HOST.md is the agent's server-architecture map (docs/memory.md). It is never injected and can be edited later. </text>
            <box style={{ height: 1 }} />
            <Show
              when={hostPhase() === "ask"}
              fallback={
                <box style={{ flexDirection: "column" }}>
                  <Show when={hostPhase() === "running"}>
                    <text selectable={false} style={{ fg: t().muted }}> scanning … </text>
                  </Show>
                  <Show when={hostMessage().length > 0}>
                    <text selectable={false} style={{ fg: t().muted }}>
                      {" "}{hostMessage()}{" "}
                    </text>
                  </Show>
                  <Show when={hostPhase() === "skipped"}>
                    <text selectable={false} style={{ fg: t().muted }}> skipped </text>
                  </Show>
                </box>
              }
            >
              <For each={HOST_CHOICES}>
                {(choice, i) => {
                  const selected = (): boolean => hostSel() === i()
                  const hovered = (): boolean => hover() === `host:${i()}`
                  const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
                  const fg = (): ThemeColor => rs().fg as ThemeColor
                  const bg = (): ThemeColor => rs().bg as ThemeColor
                  const text = `${selected() ? "❯ " : "  "}${choice.label.padEnd(18)} ${choice.desc}`
                  return (
                    <text
                      selectable={false}
                      style={rs()}
                      onMouseOver={() => setHover(`host:${i()}`)}
                      onMouseOut={() => setHover((h) => (h === `host:${i()}` ? null : h))}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setHostSel(i())
                        if (choice.action === "scan") void runHostScan()
                        else skipHostScan()
                      }}
                    >
                      <span style={{ fg: fg(), bg: bg() }}>{text}</span>
                      <span style={{ fg: t().muted, bg: bg() }}>{padTo(cps(text).length)}</span>
                    </text>
                  )
                }}
              </For>
            </Show>
          </Show>

          <Show when={step() === "review"}>
            <text selectable={false} style={{ fg: t().accent }}> Review — Enter saves {configLabel} </text>
            <box style={{ height: 1 }} />
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" mode      "}</span>
              {mode()}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" provider  "}</span>
              {providerLabel(endpoint().provider)}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" endpoint  "}</span>
              {endpoint().name}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" baseURL   "}</span>
              {endpoint().baseURL.trim() || protocolDefault()}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" api key   "}</span>
              {maskKey(endpoint().apiKey)}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" model     "}</span>
              {`${endpoint().name}@${model()}`}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" theme     "}</span>
              {themeChoice()}
            </text>
            <text selectable={false} style={{ fg: t().fg }}>
              <span style={{ fg: t().muted, bg: "transparent" }}>{" host scan "}</span>
              {seedHost() ? "yes (if HOST.md is empty)" : "no"}
            </text>
            <Show when={saving()}>
              <text selectable={false} style={{ fg: t().muted }}> writing … </text>
            </Show>
            <Show when={saveError().length > 0}>
              <text selectable={false} style={{ fg: t().danger }}> {saveError()} </text>
            </Show>
          </Show>
      </box>

      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row" }}>
        <Show when={canGoBack()}>
          <text
            selectable={false}
            style={btnStyle("btn:back")}
            onMouseOver={() => setHover("btn:back")}
            onMouseOut={() => setHover((h) => (h === "btn:back" ? null : h))}
            onMouseDown={(e) => {
              e.stopPropagation()
              goBack()
            }}
          >
            {" ← back   "}
          </text>
        </Show>
        <Show when={footerPrimary() !== null}>
          <text
            selectable={false}
            style={btnStyle("btn:primary", true)}
            onMouseOver={() => setHover("btn:primary")}
            onMouseOut={() => setHover((h) => (h === "btn:primary" ? null : h))}
            onMouseDown={(e) => {
              e.stopPropagation()
              footerPrimary()?.onPress()
            }}
          >
            {` ${footerPrimary()?.label ?? ""} `}
          </text>
        </Show>
        <text selectable={false} style={{ fg: t().muted }}> {" Esc exits setup "} </text>
        <text
          selectable={false}
          style={btnStyle("btn:exit")}
          onMouseOver={() => setHover("btn:exit")}
          onMouseOut={() => setHover((h) => (h === "btn:exit" ? null : h))}
          onMouseDown={(e) => {
            e.stopPropagation()
            requestExit()
          }}
        >
          {" exit "}
        </text>
      </box>
        </Show>
      </box>
    </OverlayPanel>
  )
}
