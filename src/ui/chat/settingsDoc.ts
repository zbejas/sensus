/**
 * Settings-screen document helpers (pure, no renderer/state): seed the editable
 * raw-config doc (the file verbatim, else the resolved config — with the
 * resolved endpoints standing in when the file omits them), and read the
 * endpoint list back out of that doc. `SettingsScreen.tsx` owns the UI and the
 * writes; these functions only shape data (docs/config.md "Settings screen").
 */

import type { RawConfigDoc, SensusConfig } from "../../engine/index.ts"
import { canonicalProvider } from "../../agent/provider/protocols.ts"
import { isRecord } from "../../core/util.ts"

/** One endpoint row in the settings editor (all values are display strings). */
export interface EndpointDraft {
  name: string
  baseURL: string
  apiKey: string
  provider: string
  temperature: string
  maxTokens: string
  thinkingMode: string
  /** Raw `models` object from the doc (serialized back verbatim on commit). */
  modelsJson: string
}

/** Bootstrap a doc from the resolved config when no file exists yet. */
export function docFromConfig(config: SensusConfig): RawConfigDoc {
  const endpoints: Record<string, RawConfigDoc> = {}
  for (const [name, e] of Object.entries(config.endpoints)) {
    endpoints[name] = {
      baseURL: e.baseURL,
      apiKey: e.apiKey,
      // Only non-default protocols are written: readEndpoints defaults the
      // key to "openai-compatible", so omitting it minimizes churn.
      ...(e.provider !== "openai-compatible" ? { provider: e.provider } : {}),
      ...(e.thinkingMode !== undefined ? { thinkingMode: e.thinkingMode } : {}),
    }
  }
  return {
    model: config.model,
    endpoints,
    agent: config.defaultAgent,
    approval: config.approval,
    allowPrefixes: config.allowPrefixes,
    context: { scrollbackLines: config.context.scrollbackLines, enabled: config.context.enabled },
    sidebar: { width: config.sidebarWidth },
    theme: config.theme,
  }
}

/**
 * Seed the doc the settings screen edits. A raw file is used verbatim so unknown
 * keys survive; when there is no file, or the file OMITS an `endpoints` section
 * (or has junk there), the resolved config's endpoints fill it in.
 *
 * Without that fallback a hand-written config like `{"theme":"dark"}` shows an
 * empty endpoint list, and adding-then-removing an endpoint persists
 * `"endpoints": {}` — which zeroes the runtime endpoints on the next `/reload`
 * (the picker and chat lose every endpoint; docs/config.md "Settings screen").
 * An explicit `"endpoints": {}` is kept as written (the user really has none).
 */
export function settingsSeedDoc(raw: RawConfigDoc | null, config: SensusConfig): RawConfigDoc {
  const bootstrap = docFromConfig(config)
  if (raw === null) return bootstrap
  if (isRecord(raw["endpoints"])) return raw
  return { ...raw, endpoints: bootstrap.endpoints }
}

/** Read the `endpoints` doc section into editor rows (never throws on junk). */
export function readEndpoints(doc: RawConfigDoc): EndpointDraft[] {
  const raw = doc["endpoints"]
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>).map(([name, p]) => {
    const rec = isRecord(p) ? p : {}
    const temperature = num(rec["temperature"])
    const maxTokens = num(rec["maxTokens"])
    return {
      name,
      baseURL: typeof rec["baseURL"] === "string" ? rec["baseURL"] : "",
      apiKey: typeof rec["apiKey"] === "string" ? rec["apiKey"] : "",
      // Canonicalized: canonical kinds + legacy "http" → "openai-compatible",
      // unknown/absent → the default (docs/config.md).
      provider: canonicalProvider(rec["provider"]) ?? "openai-compatible",
      temperature: temperature === null ? "" : String(temperature),
      maxTokens: maxTokens === null ? "" : String(maxTokens),
      thinkingMode: typeof rec["thinkingMode"] === "string" ? rec["thinkingMode"] : "",
      modelsJson: prettyJson(rec["models"]),
    }
  })
}

/** Stable one-line JSON for the models field (compact — it's one row). */
export function prettyJson(v: unknown): string {
  if (v === undefined || v === null) return ""
  try {
    return JSON.stringify(v)
  } catch {
    return ""
  }
}

/** Unknown raw-config field → string ("" when absent). */
export const str = (v: unknown): string => (typeof v === "string" ? v : "")
/** Unknown raw-config field → finite number, else null. */
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
