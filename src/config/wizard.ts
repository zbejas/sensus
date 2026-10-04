/**
 * Setup wizard core (`sensus init`) — PURE logic only (docs/operations.md
 * "Setup wizard").
 *
 * The interactive component (`src/ui/components/SetupWizard.tsx`) owns the
 * renderer, signals, fetch and file IO; everything here is a pure function so
 * the step machine, validation, draft→document merging, theme selection and
 * the host-scan seed decision are unit-tested without a terminal.
 *
 * `sensus init` used to manage a zshrc launcher; that behavior is gone. The
 * wizard writes `~/.config/sensus/config.json` (or `$SENSUS_HOME/config.json`),
 * folding in the same starter keys as `init --create-config`, and NEVER touches
 * a shell rc file.
 *
 * Paths are passed in by the caller (`configPath(home)`, `memoryDir(home)`), so
 * the module stays free of `process.env` reads apart from the config defaults
 * it reuses from `config.ts`.
 */

import { defaultConfig, parseSelectedModel, selectedModelString, starterConfigDoc, validateBaseURL } from "./config.ts"
import type { ProviderKind } from "./config/types.ts"
import type { RawConfigDoc } from "./configFile.ts"
import { isRecord } from "../core/util.ts"
import { fuzzyScore } from "../engine/fuzzy.ts"
import { isThemeName, THEME_NAMES, type ThemeName } from "../theme/theme.ts"
import type { EndpointModel } from "../agent/provider/modelCatalog.ts"
import { canonicalProvider, PROTOCOL_KINDS, PROTOCOLS, type ProtocolKind } from "../agent/provider/protocols.ts"

// ---- step machine -----------------------------------------------------------

/**
 * The wizard steps, in order:
 *   1 existing   existing config detected → keep / edit / fresh
 *   2 theme      pick a theme with live preview (first so a theme whose
 *                contrast is poor can be swapped before anything else)
 *   3 endpoint   provider + endpoint name + baseURL + api key
 *   4 test       probe the draft over its protocol and show ok/fail + model count
 *   5 model      pick a fetched model or type an id
 *   6 hostscan   optionally scan the host and seed HOST.md
 *   7 review     confirm + write the config atomically
 */
export type WizardStep = "existing" | "theme" | "endpoint" | "test" | "model" | "hostscan" | "review"

export const WIZARD_STEPS: readonly WizardStep[] = [
  "existing",
  "theme",
  "endpoint",
  "test",
  "model",
  "hostscan",
  "review",
]

/** Human label per step (the component's header). */
export const STEP_TITLES: Record<WizardStep, string> = {
  existing: "existing config",
  endpoint: "endpoint",
  test: "test connection",
  model: "model",
  theme: "theme",
  hostscan: "host scan",
  review: "review & save",
}

/** The first step: `existing` only when a config file was found. */
export function firstStep(hasExisting: boolean): WizardStep {
  return hasExisting ? "existing" : "theme"
}

/** Next step, or null at the end of the wizard (review → done). */
export function nextStep(step: WizardStep): WizardStep | null {
  switch (step) {
    case "existing":
      return "theme"
    case "theme":
      return "endpoint"
    case "endpoint":
      return "test"
    case "test":
      return "model"
    case "model":
      return "hostscan"
    case "hostscan":
      return "review"
    case "review":
      return null
  }
}

/** Previous step; null at the start. `hasExisting` controls whether endpoint
 * goes back to the existing-config choice or is the first step. */
export function prevStep(step: WizardStep, hasExisting: boolean): WizardStep | null {
  switch (step) {
    case "existing":
      return null
    case "theme":
      return hasExisting ? "existing" : null
    case "endpoint":
      return "theme"
    case "test":
      return "endpoint"
    case "model":
      return "test"
    case "hostscan":
      return "model"
    case "review":
      return "hostscan"
  }
}

/** 0-based position used for the header progress readout. */
export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step)
}

// ---- existing-config choice -------------------------------------------------

export type ExistingChoice = "keep" | "edit" | "fresh"

/** How the doc is written: merge preserves unknown keys + other endpoints;
 * fresh replaces the file with the starter-shaped document. */
export type WizardMode = "merge" | "fresh"

export interface ExistingPlan {
  /** false → finish now without writing (the user chose keep). */
  proceed: boolean
  mode: WizardMode
  /** Next step when proceed is true. */
  step: WizardStep
}

/**
 * Map the existing-config prompt to the wizard flow:
 *   keep  → stop the wizard, leave the file untouched (index.tsx then boots
 *           sensus without onboarding)
 *   edit  → preload the current endpoint/model/theme, merge on save
 *   fresh → ignore the existing values, replace the file
 */
export function planExistingChoice(choice: ExistingChoice): ExistingPlan {
  if (choice === "keep") return { proceed: false, mode: "merge", step: "theme" }
  return { proceed: true, mode: choice === "fresh" ? "fresh" : "merge", step: "theme" }
}

/**
 * True when `existing` is an untouched auto-generated default config, so the
 * setup wizard can treat it as if there were no config at all.
 *
 * `sensus init --create-config` (run by the installers) scaffolds the starter doc
 * (`starterConfigDoc`: model + one endpoint + agent + approval), and a fresh
 * wizard save adds only the default theme. When the user later re-runs the
 * interactive `sensus init`, prompting "an existing config was found" for that
 * scaffold is noise — it carries no user intent. So `isDefaultConfig` returns
 * true for `null` and for a document that is exactly the baseline:
 *
 *   - top-level keys ⊆ {model, endpoints, agent, approval, theme};
 *   - `model`/`agent`/`approval` absent or strictly equal to the starter values;
 *   - `theme` absent or the valid default theme (`defaultConfig().theme`);
 *   - `endpoints` absent or a record whose values are records keyed only by
 *     `baseURL`/`apiKey`/`provider`, with the default baseURL, a default
 *     (or legacy `"http"`) provider and an empty (or absent) key.
 *     Endpoint NAMES are unrestricted — `openai` with default values is default.
 *
 * Any real edit (a key, a model, an agent, an approval, a non-default theme,
 * an extra top-level key such as `mcp`/`keymap`/`note`, or a per-endpoint
 * override such as `models`) is NOT default and still gets the existing-config
 * prompt. Defensive: malformed input returns false and never throws.
 */
export function isDefaultConfig(existing: RawConfigDoc | null): boolean {
  if (existing === null) return true

  const starter = starterConfigDoc()
  const baselineModel = typeof starter["model"] === "string" ? (starter["model"] as string) : ""
  const baselineAgent = typeof starter["agent"] === "string" ? (starter["agent"] as string) : ""
  const baselineApproval = typeof starter["approval"] === "string" ? (starter["approval"] as string) : ""
  const defaults = defaultConfig()
  const defaultTheme = defaults.theme
  const defaultBaseURL = defaults.endpoints["main"]?.baseURL ?? ""

  // Exactly the starter keys, plus the default theme key.
  for (const key of Object.keys(existing)) {
    if (key !== "model" && key !== "endpoints" && key !== "agent" && key !== "approval" && key !== "theme") {
      return false
    }
  }

  const model = existing["model"]
  if (model !== undefined && model !== baselineModel) return false

  const agent = existing["agent"]
  if (agent !== undefined && agent !== baselineAgent) return false

  const approval = existing["approval"]
  if (approval !== undefined && approval !== baselineApproval) return false

  const theme = existing["theme"]
  if (theme !== undefined) {
    if (typeof theme !== "string" || !isThemeName(theme) || theme !== defaultTheme) return false
  }

  const endpoints = existing["endpoints"]
  if (endpoints !== undefined) {
    if (!isRecord(endpoints)) return false
    for (const value of Object.values(endpoints)) {
      if (!isRecord(value)) return false
      for (const key of Object.keys(value)) {
        if (key !== "baseURL" && key !== "apiKey" && key !== "provider") return false
      }
      if (value["baseURL"] !== defaultBaseURL) return false
      const provider = value["provider"]
      if (provider !== undefined && canonicalProvider(provider) !== "openai-compatible") return false
      const apiKey = value["apiKey"]
      if (apiKey !== undefined && apiKey !== "") return false
    }
  }

  return true
}

// ---- draft ------------------------------------------------------------------

export interface EndpointDraft {
  /** Provider protocol (canonical kind; `"mock"` only via a preloaded config). */
  provider: ProviderKind
  name: string
  baseURL: string
  apiKey: string
}

export interface WizardDraft {
  endpoint: EndpointDraft
  /** Bare model id (empty until chosen in step 4). */
  model: string
  /** A built-in theme name (step 5). */
  theme: string
  /** Whether to run the host-scan seed (step 6). */
  seedHost: boolean
}

/** The neutral starting draft (fresh install). */
export function defaultDraft(): WizardDraft {
  return {
    endpoint: { provider: "openai-compatible", name: "main", baseURL: "https://api.openai.com/v1", apiKey: "" },
    model: "",
    theme: "terminal",
    seedHost: false,
  }
}

/** Endpoint names present in a raw config document (for duplicate checks). */
export function existingEndpointNames(existing: RawConfigDoc | null): string[] {
  if (existing === null) return []
  const eps = existing["endpoints"]
  return isRecord(eps) ? Object.keys(eps) : []
}

/**
 * Preload a draft from an existing config document so `edit` starts from what
 * the user already has. The selected endpoint/model/theme are read
 * defensively; missing or malformed values fall back to the defaults.
 */
export function draftFromConfig(existing: RawConfigDoc | null): WizardDraft {
  const draft = defaultDraft()
  if (existing === null) return draft
  const endpointsRaw = existing["endpoints"]
  const endpoints = isRecord(endpointsRaw) ? endpointsRaw : null
  const fileModel = typeof existing["model"] === "string" ? (existing["model"] as string) : ""
  const selected = parseSelectedModel(fileModel)
  let name = selected?.endpoint ?? ""
  if (endpoints !== null) {
    const names = Object.keys(endpoints)
    if (name.length === 0 || !isRecord(endpoints[name])) name = names[0] ?? name
    const ep = name.length > 0 && isRecord(endpoints[name]) ? (endpoints[name] as Record<string, unknown>) : null
    if (ep !== null) {
      if (typeof ep["baseURL"] === "string") draft.endpoint.baseURL = ep["baseURL"] as string
      if (typeof ep["apiKey"] === "string") draft.endpoint.apiKey = ep["apiKey"] as string
      draft.endpoint.provider = canonicalProvider(ep["provider"]) ?? "openai-compatible"
    }
  }
  if (name.length > 0) draft.endpoint.name = name
  if (selected !== null && selected.model.length > 0) draft.model = selected.model
  const theme = existing["theme"]
  if (typeof theme === "string" && isThemeName(theme)) draft.theme = theme
  return draft
}

// ---- endpoint fields --------------------------------------------------------

/** The editable endpoint fields, in browse/edit order (provider first). */
export const ENDPOINT_FIELDS = ["provider", "name", "baseURL", "apiKey"] as const
export type EndpointField = (typeof ENDPOINT_FIELDS)[number]

/** Read one endpoint field from a draft (never throws on a partial object). */
export function endpointFieldValue(ep: EndpointDraft, field: EndpointField): string {
  if (field === "provider") return ep.provider
  if (field === "name") return ep.name
  if (field === "baseURL") return ep.baseURL
  return ep.apiKey
}

/** Return a copy of `ep` with one field replaced (never mutates the input).
 * The provider field canonicalizes: legacy `"http"` → `"openai-compatible"`,
 * and an unknown value keeps the current kind. */
export function withEndpointField(ep: EndpointDraft, field: EndpointField, value: string): EndpointDraft {
  if (field === "provider") return { ...ep, provider: canonicalProvider(value) ?? ep.provider }
  return { ...ep, [field]: value }
}

/** Pick a protocol for the draft: set the kind, and when the current baseURL
 * is empty or still another protocol's default, fill the new default. A
 * custom baseURL is preserved. */
export function withProvider(ep: EndpointDraft, kind: ProtocolKind): EndpointDraft {
  if (ep.provider === kind) return ep
  const trimmed = ep.baseURL.trim()
  const followsDefault = trimmed.length === 0 || PROTOCOL_KINDS.some((k) => PROTOCOLS[k].defaultBaseURL === trimmed)
  return { ...ep, provider: kind, baseURL: followsDefault ? PROTOCOLS[kind].defaultBaseURL : ep.baseURL }
}

// ---- validation -------------------------------------------------------------

/**
 * Endpoint name rules (docs/config.md): non-empty and no `@` (it would break
 * the `endpoint@model` key). A name already present is a DUPLICATE — unless it
 * is the endpoint being edited (`allow`), which merge mode preloads.
 */
export function validateEndpointName(
  rawName: string,
  existingNames: readonly string[] = [],
  opts: { allow?: string } = {},
): string | null {
  const name = rawName.trim()
  if (name.length === 0) return "endpoint name is required"
  if (name.includes("@")) return `endpoint name cannot contain "@" (it breaks "<endpoint>@<model>")`
  if (name !== (opts.allow ?? "") && existingNames.includes(name)) {
    return `endpoint "${name}" already exists — pick another name or edit it`
  }
  return null
}

/** Validate a NON-EMPTY baseURL (reuses config.ts's validator). An empty
 * baseURL in a draft is valid — it resolves to the protocol default. */
export function validateBaseURLInput(url: string): string | null {
  return validateBaseURL(url)
}

/** Whole-draft validation before the review/write step. */
export function validateDraft(
  draft: WizardDraft,
  existingNames: readonly string[] = [],
  opts: { allow?: string } = {},
): string | null {
  const nameErr = validateEndpointName(draft.endpoint.name, existingNames, opts)
  if (nameErr !== null) return nameErr
  const baseURL = draft.endpoint.baseURL.trim()
  if (baseURL.length > 0) {
    const urlErr = validateBaseURLInput(baseURL)
    if (urlErr !== null) return urlErr
  }
  if (draft.model.trim().length === 0) return "model is required (pick one or type an id)"
  if (!isThemeName(draft.theme)) return `unknown theme "${draft.theme}"`
  return null
}

// ---- model selection --------------------------------------------------------

/** Chat-capable models when the endpoint advertises any, else the full list. */
export function chatModels(models: readonly EndpointModel[]): EndpointModel[] {
  const chat = models.filter((m) => m.chat)
  return chat.length > 0 ? chat : [...models]
}

/** Filter + rank by fuzzy score over the id (empty query keeps source order). */
export function rankModels(models: readonly EndpointModel[], query: string): EndpointModel[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...models]
  const scored: Array<{ m: EndpointModel; score: number; at: number }> = []
  models.forEach((m, at) => {
    const score = fuzzyScore(q, m.id)
    if (score === null) return
    scored.push({ m, score, at })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((s) => s.m)
}

/**
 * The model the user actually chose: the highlighted fetched row when one is
 * selected, else a typed id (the "or type an id" path). Null when neither.
 */
export function resolveModelChoice(
  ranked: readonly EndpointModel[],
  selectedIndex: number,
  query: string,
): string | null {
  const row = ranked[selectedIndex]
  if (row !== undefined) return row.id
  const typed = query.trim()
  return typed.length > 0 ? typed : null
}

// ---- theme selection --------------------------------------------------------

export const WIZARD_THEMES: readonly ThemeName[] = THEME_NAMES

/** Normalize a theme choice; unknown names return null. */
export function normalizeTheme(name: string): ThemeName | null {
  return isThemeName(name) ? name : null
}

/** Filter + rank theme names by fuzzy score (empty query keeps registry order). */
export function rankThemes(names: readonly ThemeName[], query: string): ThemeName[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...names]
  const scored: Array<{ name: ThemeName; score: number; at: number }> = []
  names.forEach((name, at) => {
    const score = fuzzyScore(q, name)
    if (score === null) return
    scored.push({ name, score, at })
  })
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.name)
}

// ---- config document --------------------------------------------------------

/** Bare starter keys the headless `--create-config` scaffold also writes. */
function starterBase(): RawConfigDoc {
  return { ...starterConfigDoc() }
}

/**
 * Build the document the wizard writes.
 *
 * - `merge` (edit): patches the existing parsed document, so unknown top-level
 *   keys and other endpoints survive; the draft endpoint's entry is merged over
 *   its previous entry (per-model metadata etc. preserved).
 * - `fresh`: replaces the file with the starter-shaped document
 *   (agent/approval defaults folded in, like `--create-config`) plus the
 *   wizard's endpoint/model/theme.
 *
 * Never throws; returns a plain object ready for `writeRawConfig`.
 */
export function buildConfigDoc(existing: RawConfigDoc | null, draft: WizardDraft, mode: WizardMode): RawConfigDoc {
  const name = draft.endpoint.name.trim()
  const entry: Record<string, unknown> = { baseURL: draft.endpoint.baseURL.trim(), apiKey: draft.endpoint.apiKey }
  // The default protocol is omitted; every other kind (incl. mock) is written.
  if (draft.endpoint.provider !== "openai-compatible") entry["provider"] = draft.endpoint.provider
  const modelId = draft.model.trim()

  if (mode === "fresh") {
    const doc = starterBase()
    doc["endpoints"] = { [name]: entry }
    if (modelId.length > 0) doc["model"] = selectedModelString(name, modelId)
    if (isThemeName(draft.theme)) doc["theme"] = draft.theme
    return doc
  }

  const doc: RawConfigDoc = { ...(existing ?? {}) }
  const epsRaw = doc["endpoints"]
  const endpoints: Record<string, unknown> = isRecord(epsRaw) ? { ...epsRaw } : {}
  const prevRaw = endpoints[name]
  const prev = isRecord(prevRaw) ? (prevRaw as Record<string, unknown>) : {}
  const next: Record<string, unknown> = { ...prev, ...entry }
  // Switching an existing non-default endpoint BACK to the default must clear
  // the persisted key, not leave the merged-in previous kind behind.
  if (draft.endpoint.provider === "openai-compatible") delete next["provider"]
  endpoints[name] = next
  doc["endpoints"] = endpoints
  if (modelId.length > 0) doc["model"] = selectedModelString(name, modelId)
  if (isThemeName(draft.theme)) doc["theme"] = draft.theme
  return doc
}

// ---- host-scan seed ---------------------------------------------------------

export interface HostSeedPlan {
  write: boolean
  /** Content to write when `write` is true (already capped). */
  content: string
  reason: "requested" | "declined" | "existing"
}

/**
 * Cap a host-scan draft to the HOST.md char budget. The scan output is a
 * starting point, not curated prose, so an over-budget draft is truncated with
 * an explicit marker rather than rejected.
 */
export function capSeedContent(draft: string, limit: number): string {
  const text = draft.trim()
  if (limit <= 0 || text.length <= limit) return text
  const marker = "\n…[host scan draft truncated — curate with the memory tool]\n"
  const head = text.slice(0, Math.max(0, limit - marker.length)).replace(/\s+$/, "")
  return `${head}${marker}`
}

/**
 * Decide whether/how to seed HOST.md (docs/memory.md):
 *   - the user declined → nothing,
 *   - HOST.md already has content → NEVER clobber it,
 *   - otherwise write the capped draft.
 */
export function planHostSeed(opts: {
  requested: boolean
  existing: string | null
  draft: string
  limit: number
}): HostSeedPlan {
  if (!opts.requested) return { write: false, content: "", reason: "declined" }
  if (opts.existing !== null && opts.existing.trim().length > 0) {
    return { write: false, content: "", reason: "existing" }
  }
  return { write: true, content: capSeedContent(opts.draft, opts.limit), reason: "requested" }
}

// ---- result -----------------------------------------------------------------

export type WizardStatus = "saved" | "kept" | "cancelled"

export interface WizardResult {
  status: WizardStatus
  /** The config path the wizard targeted. */
  path: string
  /** Set when a write was attempted and failed. */
  error?: string
  /** HOST.md was seeded this run. */
  hostSeeded?: boolean
  hostPath?: string
}
