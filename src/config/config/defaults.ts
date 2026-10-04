import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../agent/truncate.ts"
import type { EndpointConfig, SelectedModel, SensusConfig } from "./types.ts"

const DEFAULTS = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  temperature: 1.0,
  // maxTokens is deliberately ABSENT: unset = auto (the model's advertised
  // output limit, else the field is omitted entirely) so a user is never
  // silently capped below what their model can emit (docs/config.md "maxTokens").
  provider: "openai-compatible" as const,
} as const

export const defaultEndpoint = (name: string): EndpointConfig => ({ name, ...DEFAULTS, models: {} })

/**
 * Default chat sidebar width in columns. Leaves room for the terminal pane,
 * which is the product's centerpiece, so the chat must not claim the majority of
 * a common desktop window. The older 65 left a 140-column terminal only ~48 pane
 * columns once the vertical tab rail (default `"sidebar"` layout) was also
 * subtracted; 50 keeps the pane roomier without crowding the chat. The single
 * source of truth is re-exported and re-used by the UI geometry
 * (`src/ui/lib/layout.ts`), the built-in skills seed, and the docs.
 */
export const SIDEBAR_DEFAULT_WIDTH = 50

// ---- selected-model parsing ---------------------------------------------------

/**
 * Parse `<endpoint>@<model-id>`. The split is at the FIRST "@" — endpoint
 * names must not contain "@" (validated), model ids may (rare, but legal).
 * A bare string with no "@" is NOT selected-model syntax (callers use it as
 * a model-id override for the current endpoint).
 */
export function parseSelectedModel(raw: string): SelectedModel | null {
  const s = raw.trim()
  if (s.length === 0) return null
  const at = s.indexOf("@")
  if (at <= 0 || at === s.length - 1) return null
  return { endpoint: s.slice(0, at), model: s.slice(at + 1) }
}

/** `<endpoint>@<model>` — the config `model` key format. */
export function selectedModelString(endpoint: string, model: string): string {
  return `${endpoint}@${model}`
}

export function defaultConfig(): SensusConfig {
  return {
    shell: resolveShell(),
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    layout: "sidebar",
    tabRailWidth: 24,
    autoChatOnly: true,
    daemonPersistent: false,
    updateCheck: true,
    keymap: {},
    approval: "confirm",
    defaultAgent: "copilot",
    allowPrefixes: [],
    permission: [],
    instructions: [],
    context: { scrollbackLines: 100, enabled: true, autoCompact: true, keepTokens: 15_000, bufferTokens: 20_000, contextLimit: 0 },
    toolOutput: { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES },
    compaction: { prune: false, tailTurns: 0 },
    chat: { thinking: "hide", toolOutput: "collapsed", animations: true, cardStyle: "border", maxToolTurns: null, busySend: "steer" },
    memory: {
      enabled: true,
      memoryCharLimit: 2200,
      hostCharLimit: 4000,
      journalCharLimit: 8000,
      writeApproval: false,
      consolidateAtPercent: 80,
      redactSecrets: true,
    },
    titles: { enabled: true, model: "" },
    triggers: [],
    notifications: { enabled: true, mode: "bell", onFinish: true, onApproval: true },
    theme: "terminal",
    themePalette: null,
    mcp: { servers: {} },
    extensions: { approvalPolicy: { kind: "default" }, eventSink: { kind: "noop" } },
    endpoints: { main: defaultEndpoint("main") },
    model: "main@gpt-5",
    warnings: [],
    bootError: null,
  }
}

function resolveShell(): string {
  const env = process.env["SHELL"]
  if (env && env.length > 0) return env
  return "/bin/zsh"
}

/**
 * Starter document scaffolded by `sensus init --create-config` (and by the
 * installers): the knobs a new user actually edits — NOT a dump of every
 * default (missing keys fall back to the built-ins, docs/config.md). Never
 * written over an existing file.
 */
export function starterConfigDoc(): Record<string, unknown> {
  const d = defaultConfig()
  const main = d.endpoints["main"] ?? defaultEndpoint("main")
  return {
    model: d.model,
    endpoints: {
      main: {
        baseURL: main.baseURL,
        apiKey: "",
      },
    },
    agent: d.defaultAgent,
    approval: d.approval,
  }
}
