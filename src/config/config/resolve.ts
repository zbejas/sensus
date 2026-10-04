import { readFileSync } from "node:fs"
import { expandEnvRefs } from "../../agent/mcp/types.ts"
import { EVENT_V1_TYPES, type EventV1Type } from "../../agent/extensions.ts"
import { parseThinkingMode } from "../../agent/provider/modelCatalog.ts"
import { canonicalProvider, isProtocolKind, resolveBaseURL } from "../../agent/provider/protocols.ts"
import { type KeyActionId } from "../../core/keymap.ts"
import type { ColorMode } from "../../core/colorMode.ts"
import { errorMessage, isRecord } from "../../core/util.ts"
import { isThemeName } from "../../theme/theme.ts"
import { parseHexColor } from "../../theme/themePalette.ts"
import { parseArgs, validateBaseURL } from "./args.ts"
import { defaultConfig, defaultEndpoint, parseSelectedModel, selectedModelString } from "./defaults.ts"
import { parseMcpSection } from "./mcp.ts"
import type { ApprovalMode, EndpointConfig, ModelOverride, PermissionRule, SensusConfig, TriggerConfig } from "./types.ts"

/**
 * Parse + validate the config file. Returns warnings; never throws.
 */
function readConfigFile(file: string): { raw: Record<string, unknown> | null; warnings: string[] } {
  const warnings: string[] = []
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return { raw: null, warnings } // no file yet — silently use defaults
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      raw: null,
      warnings: [`${file}: invalid JSON — ignoring file (${errorMessage(e)})`],
    }
  }
  if (!isRecord(parsed)) {
    return { raw: null, warnings: [`${file}: expected a JSON object — ignoring file`] }
  }
  return { raw: parsed as Record<string, unknown>, warnings }
}

const TOP_KEYS = new Set([
  "model",
  "endpoints",
  "agent",
  "approval",
  "allowPrefixes",
  "permission",
  "instructions",
  "context",
  "tool_output",
  "compaction",
  "chat",
  "sidebar",
  "layout",
  "autoChatOnly",
  "daemonPersistent",
  "updateCheck",
  "tabs",
  "keymap",
  "theme",
  "themePalette",
  "mcp",
  "memory",
  "notifications",
  "titles",
  "triggers",
  "extensions",
])
/** Legacy keys from the profiles era: clean break, but a helpful warning. */
const LEGACY_TOP_KEYS = new Set(["profiles", "defaultProfile", "defaultMode"])
/** Removed endpoint keys — a behavior change deserves a clear pointer. */
const LEGACY_ENDPOINT_KEYS = new Set(["apiKeyEnv"])
const ENDPOINT_KEYS = new Set(["baseURL", "apiKey", "provider", "thinkingMode", "temperature", "maxTokens", "models"])
const MODEL_OVERRIDE_KEYS = new Set([
  "contextLimit",
  "inputLimit",
  "reasoning",
  "reasoningEfforts",
  "reasoningBudgetMin",
  "reasoningBudgetMax",
  "toolCall",
  "temperatureSupported",
  "vision",
])
const TOOL_OUTPUT_KEYS = new Set(["max_lines", "max_bytes"])
const PERMISSION_KEYS = new Set(["tool", "pattern", "action"])
const COMPACTION_KEYS = new Set(["auto", "prune", "tail_turns", "preserve_recent_tokens", "reserved"])
const MEMORY_KEYS = new Set([
  "enabled",
  "memoryCharLimit",
  "hostCharLimit",
  "journalCharLimit",
  "writeApproval",
  "consolidateAtPercent",
  "redactSecrets",
])
/** `tabs.*` keys (docs/config.md "layout"): only the vertical rail width. */
const TABS_KEYS = new Set(["width"])
/** `extensions.*` keys (docs/extensions.md): the approval policy + event sink. */
const EXTENSION_KEYS = new Set(["approvalPolicy", "eventSink"])
/** `triggers[]` keys (docs/triggers.md): the event match + optional filters. */
const TRIGGER_KEYS = new Set(["on", "tool", "session"])

/** Parse one `endpoints.<name>.models.<modelId>` entry; null skips it. */
function parseModelOverride(
  endpointName: string,
  modelId: string,
  raw: unknown,
  warnings: string[],
): ModelOverride | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`config: endpoints.${endpointName}.models.${modelId} must be an object — skipped`)
    return null
  }
  const e = raw as Record<string, unknown>
  for (const k of Object.keys(e)) {
    if (!MODEL_OVERRIDE_KEYS.has(k)) {
      warnings.push(`config: endpoints.${endpointName}.models.${modelId} has unknown key "${k}" ignored`)
    }
  }
  const bool = (k: string): boolean | null => {
    const v = e[k]
    return typeof v === "boolean" ? v : null
  }
  const posInt = (k: string): number | null => {
    const v = e[k]
    if (v === null) return null
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v)
    if (v !== undefined) warnings.push(`config: endpoints.${endpointName}.models.${modelId}.${k} must be a positive number or null — ignored`)
    return null
  }
  let efforts: string[] | null = null
  const effortsRaw = e["reasoningEfforts"]
  if (Array.isArray(effortsRaw)) {
    efforts = effortsRaw.filter((v): v is string => typeof v === "string" && v.length > 0)
  } else if (effortsRaw !== undefined) {
    warnings.push(`config: endpoints.${endpointName}.models.${modelId}.reasoningEfforts must be an array of strings — ignored`)
  }
  return {
    contextLimit: posInt("contextLimit"),
    inputLimit: posInt("inputLimit"),
    reasoning: bool("reasoning"),
    reasoningEfforts: efforts,
    reasoningBudgetMin: posInt("reasoningBudgetMin"),
    reasoningBudgetMax: posInt("reasoningBudgetMax"),
    toolCall: bool("toolCall"),
    temperatureSupported: bool("temperatureSupported"),
    vision: bool("vision"),
  }
}

/** Is the override non-trivial (any field set)? Trivial ones are dropped. */
function overrideIsEmpty(o: ModelOverride): boolean {
  return (
    o.contextLimit === null &&
    o.inputLimit === null &&
    o.reasoning === null &&
    o.reasoningEfforts === null &&
    o.reasoningBudgetMin === null &&
    o.reasoningBudgetMax === null &&
    o.toolCall === null &&
    o.temperatureSupported === null &&
    o.vision === null
  )
}

/** Resolve file -> env -> CLI over the defaults. Pure wrt process.env when
 * env is passed; parseArgs reads argv only. */
export function resolveConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  file: string | null = null,
): SensusConfig {
  const args = parseArgs([...argv])
  const out = defaultConfig()
  const warnings = out.warnings

  // ---- 1. Config file -------------------------------------------------
  let fileModel: string | undefined
  let fileEndpoints: Record<string, Partial<EndpointConfig>> | null = null
  let fileAgent: string | undefined
  let fileAllowPrefixes: string[] | null = null
  if (file !== null) {
    const { raw, warnings: w } = readConfigFile(file)
    warnings.push(...w)
    if (raw) {
      for (const key of Object.keys(raw)) {
        if (LEGACY_TOP_KEYS.has(key)) {
          warnings.push(`config: "${key}" is gone — models are endpoints now, see docs/config.md ("endpoints", "model")`)
          continue
        }
        if (!TOP_KEYS.has(key)) warnings.push(`config: unknown key "${key}" ignored (docs/config.md)`)
      }
      if (typeof raw["model"] === "string") fileModel = raw["model"] as string
      const eps = raw["endpoints"]
      if (isRecord(eps)) {
        fileEndpoints = {}
        for (const [name, p] of Object.entries(eps as Record<string, unknown>)) {
          if (name.includes("@")) {
            warnings.push(`config: endpoint name "${name}" cannot contain "@" (it would break "endpoint@model" keys) — skipped`)
            continue
          }
          if (p === null || typeof p !== "object" || Array.isArray(p)) {
            warnings.push(`config: endpoint "${name}" must be an object — skipped`)
            continue
          }
          const partial = p as Record<string, unknown>
          for (const k of Object.keys(partial)) {
            if (LEGACY_ENDPOINT_KEYS.has(k)) {
              warnings.push(`config: endpoint "${name}" key "${k}" is gone — put the key in "apiKey" (docs/config.md)`)
              continue
            }
            if (!ENDPOINT_KEYS.has(k)) warnings.push(`config: endpoint "${name}" has unknown key "${k}" ignored`)
          }
          const num = (v: unknown): number | undefined =>
            typeof v === "number" && Number.isFinite(v) ? v : undefined
          const ep: Partial<EndpointConfig> = {}
          if (typeof partial["baseURL"] === "string") ep.baseURL = partial["baseURL"] as string
          if (typeof partial["apiKey"] === "string") {
            // `${NAME}` refs resolve from the secrets store / process env
            // (docs/config.md "Secrets"); a literal key passes through as-is.
            const ref = expandEnvRefs(partial["apiKey"] as string, env)
            if (ref.missing.length > 0) {
              warnings.push(
                `config: endpoint "${name}" apiKey references ${[...new Set(ref.missing)].join(", ")} which is not set — the key is empty`,
              )
            }
            ep.apiKey = ref.value
          }
          const temp = num(partial["temperature"])
          if (temp !== undefined) ep.temperature = temp
          const mt = num(partial["maxTokens"])
          if (mt !== undefined) ep.maxTokens = mt
          // Provider protocols (docs/config.md "Endpoints and the selected
          // model"): canonical names, mock, and the legacy "http" spelling
          // (canonicalized to "openai-compatible", no warning).
          const provider = canonicalProvider(partial["provider"])
          if (provider !== null) {
            ep.provider = provider
          } else if (partial["provider"] !== undefined) {
            warnings.push(
              `config: endpoint "${name}" provider must be "openai-compatible", "openai-responses", "anthropic", "google" or "mock" (legacy "http" = openai-compatible) — using default`,
            )
          }
          if (typeof partial["thinkingMode"] === "string") {
            if (parseThinkingMode(partial["thinkingMode"]) !== null) {
              ep.thinkingMode = partial["thinkingMode"]
            } else {
              warnings.push(
                `config: endpoint "${name}" thinkingMode "${partial["thinkingMode"]}" is not a thinking mode (default|off|budget:<n>|effort keyword) — ignored`,
              )
            }
          } else if (partial["thinkingMode"] !== undefined) {
            warnings.push(`config: endpoint "${name}" thinkingMode must be a string — ignored`)
          }
          const modelsRaw = partial["models"]
          if (modelsRaw !== undefined) {
            if (isRecord(modelsRaw)) {
              const models: Record<string, ModelOverride> = {}
              for (const [modelId, mraw] of Object.entries(modelsRaw as Record<string, unknown>)) {
                const o = parseModelOverride(name, modelId, mraw, warnings)
                if (o !== null && !overrideIsEmpty(o)) models[modelId] = o
              }
              ep.models = models
            } else {
              warnings.push(`config: endpoint "${name}" models must be an object — ignored`)
            }
          }
          fileEndpoints[name] = ep
        }
      }
      if (typeof raw["agent"] === "string" && (raw["agent"] as string).length > 0) {
        fileAgent = raw["agent"] as string
      } else if (raw["agent"] !== undefined) {
        warnings.push(`config: agent must be a non-empty string (an agent name from ~/.config/sensus/agents/) — using default`)
      }
      const apRaw = raw["allowPrefixes"]
      if (Array.isArray(apRaw)) {
        fileAllowPrefixes = apRaw.filter((v): v is string => typeof v === "string" && v.length > 0)
        const dropped = apRaw.length - fileAllowPrefixes.length
        if (dropped > 0) warnings.push(`config: allowPrefixes has ${dropped} non-string/empty entr${dropped === 1 ? "y" : "ies"} — dropped`)
      } else if (apRaw !== undefined) {
        warnings.push(`config: allowPrefixes must be an array of command prefixes — ignored`)
      }
      // permission (docs/config.md "permission"): an ordered list of
      // {tool, pattern?, action} rules; the last matching rule wins. Parsed
      // defensively — a bad entry is skipped with a warning, never fatal.
      const permRaw = raw["permission"]
      if (Array.isArray(permRaw)) {
        const rules: PermissionRule[] = []
        permRaw.forEach((entry, i) => {
          if (!isRecord(entry)) {
            warnings.push(`config: permission[${i}] must be an object — skipped`)
            return
          }
          const e = entry as Record<string, unknown>
          for (const k of Object.keys(e)) {
            if (!PERMISSION_KEYS.has(k)) warnings.push(`config: permission[${i}] has unknown key "${k}" ignored`)
          }
          const tool = e["tool"]
          if (typeof tool !== "string" || tool.length === 0) {
            warnings.push(`config: permission[${i}].tool must be a non-empty tool name (or "*") — skipped`)
            return
          }
          const action = e["action"]
          if (action !== "allow" && action !== "ask" && action !== "deny") {
            warnings.push(`config: permission[${i}].action must be "allow", "ask" or "deny" — skipped`)
            return
          }
          const pattern = e["pattern"]
          if (pattern === undefined) {
            rules.push({ tool, action })
          } else if (typeof pattern === "string" && pattern.length > 0) {
            rules.push({ tool, pattern, action })
          } else {
            warnings.push(`config: permission[${i}].pattern must be a non-empty string — ignored`)
            rules.push({ tool, action })
          }
        })
        out.permission = rules
      } else if (permRaw !== undefined) {
        warnings.push(`config: permission must be an array of rules — ignored (docs/config.md)`)
      }
      // instructions (docs/config.md "instructions"): file paths, ~/ paths,
      // globs and http(s) URLs merged into the system prompt. String entries
      // are kept verbatim; non-strings/empties are dropped with a warning.
      const instrRaw = raw["instructions"]
      if (Array.isArray(instrRaw)) {
        out.instructions = instrRaw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        const droppedInstr = instrRaw.length - out.instructions.length
        if (droppedInstr > 0) {
          warnings.push(`config: instructions has ${droppedInstr} non-string/empty entr${droppedInstr === 1 ? "y" : "ies"} — dropped`)
        }
      } else if (instrRaw !== undefined) {
        warnings.push(`config: instructions must be an array of file paths/globs/URLs — ignored (docs/config.md)`)
      }
      // approval
      if (raw["approval"] === "full-auto" || raw["approval"] === "confirm") {
        out.approval = raw["approval"] as ApprovalMode
      } else if (raw["approval"] !== undefined) {
        warnings.push(`config: approval must be "confirm" or "full-auto" — using default`)
      }
      // context
      const ctx = raw["context"]
      if (isRecord(ctx)) {
        const c = ctx as Record<string, unknown>
        if (typeof c["enabled"] === "boolean") out.context.enabled = c["enabled"] as boolean
        if (typeof c["scrollbackLines"] === "number" && (c["scrollbackLines"] as number) > 0) {
          out.context.scrollbackLines = Math.floor(c["scrollbackLines"] as number)
        }
        if (typeof c["autoCompact"] === "boolean") out.context.autoCompact = c["autoCompact"] as boolean
        const ctxNum = (k: string): number | undefined => {
          const v = c[k]
          return typeof v === "number" && Number.isFinite(v) ? v : undefined
        }
        const keep = ctxNum("keepTokens")
        if (keep !== undefined && keep > 0) out.context.keepTokens = Math.floor(keep)
        else if (keep !== undefined) warnings.push(`config: context.keepTokens must be a positive number — using default`)
        const buf = ctxNum("bufferTokens")
        if (buf !== undefined && buf >= 0) out.context.bufferTokens = Math.floor(buf)
        else if (buf !== undefined) warnings.push(`config: context.bufferTokens must be a non-negative number — using default`)
        const rawLimit = c["contextLimit"]
        const limit = ctxNum("contextLimit")
        if (rawLimit === undefined || rawLimit === null) out.context.contextLimit = 0
        else if (limit !== undefined && limit >= 0) out.context.contextLimit = Math.floor(limit)
        else warnings.push(`config: context.contextLimit must be a number >= 0 (0 = unlimited/auto) — using default`)
      }
      // compaction (docs/config.md "compaction"). Parsed
      // AFTER context: every key here OVERRIDES the matching context.* value.
      // Only prune/tail_turns are stored; the aliases resolve into context.
      const compactionRaw = raw["compaction"]
      if (isRecord(compactionRaw)) {
        const cm = compactionRaw as Record<string, unknown>
        for (const k of Object.keys(cm)) {
          if (!COMPACTION_KEYS.has(k)) warnings.push(`config: compaction has unknown key "${k}" ignored (docs/config.md)`)
        }
        if (typeof cm["auto"] === "boolean") out.context.autoCompact = cm["auto"] as boolean
        else if (cm["auto"] !== undefined) warnings.push(`config: compaction.auto must be a boolean — using default`)
        if (typeof cm["prune"] === "boolean") out.compaction.prune = cm["prune"] as boolean
        else if (cm["prune"] !== undefined) warnings.push(`config: compaction.prune must be a boolean — using default`)
        const nonNeg = (k: string): number | undefined => {
          const v = cm[k]
          if (v === undefined) return undefined
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v)
          warnings.push(`config: compaction.${k} must be a non-negative number — using default`)
          return undefined
        }
        const tailTurns = nonNeg("tail_turns")
        if (tailTurns !== undefined) out.compaction.tailTurns = tailTurns
        // preserve_recent_tokens aliases context.keepTokens (positive, like context).
        const preserve = cm["preserve_recent_tokens"]
        if (preserve !== undefined) {
          if (typeof preserve === "number" && Number.isFinite(preserve) && preserve > 0) {
            out.context.keepTokens = Math.floor(preserve)
          } else {
            warnings.push(`config: compaction.preserve_recent_tokens must be a positive number — ignored`)
          }
        }
        // reserved aliases context.bufferTokens (non-negative, like context).
        const reserved = cm["reserved"]
        if (reserved !== undefined) {
          if (typeof reserved === "number" && Number.isFinite(reserved) && reserved >= 0) {
            out.context.bufferTokens = Math.floor(reserved)
          } else {
            warnings.push(`config: compaction.reserved must be a non-negative number — ignored`)
          }
        }
      } else if (compactionRaw !== undefined) {
        warnings.push(`config: compaction must be an object — ignored (docs/config.md)`)
      }
      // tool-output truncation (docs/config.md "tool_output")
      const toolOutRaw = raw["tool_output"]
      if (isRecord(toolOutRaw)) {
        const t = toolOutRaw as Record<string, unknown>
        for (const k of Object.keys(t)) {
          if (!TOOL_OUTPUT_KEYS.has(k)) warnings.push(`config: tool_output has unknown key "${k}" ignored (docs/config.md)`)
        }
        const pos = (k: string): number | undefined => {
          const v = t[k]
          if (v === undefined) return undefined
          if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v)
          warnings.push(`config: tool_output.${k} must be a positive number — using default`)
          return undefined
        }
        const ml = pos("max_lines")
        if (ml !== undefined) out.toolOutput.maxLines = ml
        const mb = pos("max_bytes")
        if (mb !== undefined) out.toolOutput.maxBytes = mb
      } else if (toolOutRaw !== undefined) {
        warnings.push(`config: tool_output must be an object — using default`)
      }
      // chat display options (docs/config.md "chat")
      const chatRaw = raw["chat"]
      if (isRecord(chatRaw)) {
        const c = chatRaw as Record<string, unknown>
        if (c["thinking"] === "show" || c["thinking"] === "hide") {
          out.chat.thinking = c["thinking"]
        } else if (c["thinking"] !== undefined) {
          warnings.push(`config: chat.thinking must be "show" or "hide" — using default`)
        }
        if (c["toolOutput"] === "expanded" || c["toolOutput"] === "collapsed") {
          out.chat.toolOutput = c["toolOutput"]
        } else if (c["toolOutput"] !== undefined) {
          warnings.push(`config: chat.toolOutput must be "expanded" or "collapsed" — using default`)
        }
        if (typeof c["animations"] === "boolean") out.chat.animations = c["animations"] as boolean
        if (c["cardStyle"] === "fill" || c["cardStyle"] === "border") {
          out.chat.cardStyle = c["cardStyle"]
        } else if (c["cardStyle"] !== undefined) {
          warnings.push(`config: chat.cardStyle must be "fill" or "border" — using default`)
        }
        if (c["maxToolTurns"] === null) {
          out.chat.maxToolTurns = null // explicit "off" — no loop cap
        } else if (c["maxToolTurns"] !== undefined) {
          const mt = c["maxToolTurns"]
          if (typeof mt === "number" && Number.isFinite(mt) && mt > 0) out.chat.maxToolTurns = Math.floor(mt)
          else warnings.push(`config: chat.maxToolTurns must be a positive number or null — using default`)
        }
        if (c["busySend"] === "steer" || c["busySend"] === "queue") {
          out.chat.busySend = c["busySend"]
        } else if (c["busySend"] !== undefined) {
          warnings.push(`config: chat.busySend must be "steer" or "queue" — using default`)
        }
      }
      // memory (docs/memory.md)
      const memRaw = raw["memory"]
      if (isRecord(memRaw)) {
        const m = memRaw as Record<string, unknown>
        for (const k of Object.keys(m)) {
          if (!MEMORY_KEYS.has(k)) warnings.push(`config: memory has unknown key "${k}" ignored (docs/memory.md)`)
        }
        if (typeof m["enabled"] === "boolean") out.memory.enabled = m["enabled"] as boolean
        const posCap = (k: string): number | undefined => {
          const v = m[k]
          if (v === undefined) return undefined
          if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v)
          warnings.push(`config: memory.${k} must be a positive number — using default`)
          return undefined
        }
        const mc = posCap("memoryCharLimit")
        if (mc !== undefined) out.memory.memoryCharLimit = mc
        const hc = posCap("hostCharLimit")
        if (hc !== undefined) out.memory.hostCharLimit = hc
        const jc = posCap("journalCharLimit")
        if (jc !== undefined) out.memory.journalCharLimit = jc
        if (typeof m["writeApproval"] === "boolean") out.memory.writeApproval = m["writeApproval"] as boolean
        if (typeof m["redactSecrets"] === "boolean") out.memory.redactSecrets = m["redactSecrets"] as boolean
        const pct = m["consolidateAtPercent"]
        if (pct !== undefined) {
          if (typeof pct === "number" && Number.isFinite(pct) && pct >= 1 && pct <= 100) {
            out.memory.consolidateAtPercent = Math.floor(pct)
          } else {
            warnings.push(`config: memory.consolidateAtPercent must be 1-100 — using default`)
          }
        }
      } else if (memRaw !== undefined) {
        warnings.push(`config: memory must be an object — ignored (docs/memory.md)`)
      }
      // notifications (docs/config.md "notifications")
      const notifyRaw = raw["notifications"]
      if (isRecord(notifyRaw)) {
        const n = notifyRaw as Record<string, unknown>
        if (typeof n["enabled"] === "boolean") out.notifications.enabled = n["enabled"] as boolean
        if (n["mode"] === "bell" || n["mode"] === "osc777") out.notifications.mode = n["mode"]
        else if (n["mode"] !== undefined) warnings.push(`config: notifications.mode must be "bell" or "osc777" — using default`)
        if (typeof n["onFinish"] === "boolean") out.notifications.onFinish = n["onFinish"] as boolean
        if (typeof n["onApproval"] === "boolean") out.notifications.onApproval = n["onApproval"] as boolean
      } else if (notifyRaw !== undefined) {
        warnings.push(`config: notifications must be an object — ignored`)
      }
      // auto session titles (docs/sessions.md "Auto titles")
      const titlesRaw = raw["titles"]
      if (isRecord(titlesRaw)) {
        const tt = titlesRaw as Record<string, unknown>
        for (const k of Object.keys(tt)) {
          if (k !== "enabled" && k !== "model") warnings.push(`config: titles has unknown key "${k}" ignored`)
        }
        if (typeof tt["enabled"] === "boolean") out.titles.enabled = tt["enabled"] as boolean
        else if (tt["enabled"] !== undefined) warnings.push(`config: titles.enabled must be a boolean — using default`)
        if (typeof tt["model"] === "string") out.titles.model = (tt["model"] as string).trim()
        else if (tt["model"] !== undefined) warnings.push(`config: titles.model must be a string — ignored`)
      } else if (titlesRaw !== undefined) {
        warnings.push(`config: titles must be an object — ignored`)
      }
      // triggers (docs/triggers.md): local condition triggers over the v1 event
      // stream. A list of { on, tool?, session? } rules; the first match wins.
      // Parsed defensively — a bad entry is skipped with a warning, never fatal.
      const triggersRaw = raw["triggers"]
      if (Array.isArray(triggersRaw)) {
        const rules: TriggerConfig[] = []
        triggersRaw.forEach((entry, i) => {
          if (!isRecord(entry)) {
            warnings.push(`config: triggers[${i}] must be an object — skipped (docs/triggers.md)`)
            return
          }
          const e = entry as Record<string, unknown>
          for (const k of Object.keys(e)) {
            if (!TRIGGER_KEYS.has(k)) warnings.push(`config: triggers[${i}] has unknown key "${k}" ignored`)
          }
          const on = e["on"]
          if (typeof on !== "string" || (on !== "*" && !EVENT_V1_TYPES.includes(on as EventV1Type))) {
            warnings.push(`config: triggers[${i}].on must be a v1 event type (or "*") — skipped (docs/triggers.md)`)
            return
          }
          const rule: TriggerConfig = { on: on as EventV1Type | "*" }
          const tool = e["tool"]
          if (typeof tool === "string" && tool.length > 0) rule.tool = tool
          else if (tool !== undefined) warnings.push(`config: triggers[${i}].tool must be a non-empty string — ignored`)
          const session = e["session"]
          if (typeof session === "string" && session.length > 0) rule.session = session
          else if (session !== undefined) warnings.push(`config: triggers[${i}].session must be a non-empty string — ignored`)
          rules.push(rule)
        })
        out.triggers = rules
      } else if (triggersRaw !== undefined) {
        warnings.push(`config: triggers must be an array of rules — ignored (docs/triggers.md)`)
      }
      // layout (docs/config.md "layout"): where the tab strip lives. Invalid
      // values keep the default and warn; config-file-only.
      if (raw["layout"] === "topbar" || raw["layout"] === "sidebar") {
        out.layout = raw["layout"]
      } else if (raw["layout"] !== undefined) {
        warnings.push(`config: layout must be "topbar" or "sidebar" — using default`)
      }
      // autoChatOnly (docs/config.md "layout"): narrow terminals start in the
      // chat-only view. A non-boolean keeps the default and warns.
      if (typeof raw["autoChatOnly"] === "boolean") {
        out.autoChatOnly = raw["autoChatOnly"]
      } else if (raw["autoChatOnly"] !== undefined) {
        warnings.push(`config: autoChatOnly must be a boolean — using default`)
      }
      // daemonPersistent (docs/config.md "daemon", D3/D9): a persistent daemon
      // never grace-exits. A non-boolean keeps the default and warns.
      if (typeof raw["daemonPersistent"] === "boolean") {
        out.daemonPersistent = raw["daemonPersistent"]
      } else if (raw["daemonPersistent"] !== undefined) {
        warnings.push(`config: daemonPersistent must be a boolean — using default`)
      }
      // updateCheck (docs/config.md "updateCheck", docs/operations.md "Update"):
      // the launch update alert. A non-boolean keeps the default and warns.
      if (typeof raw["updateCheck"] === "boolean") {
        out.updateCheck = raw["updateCheck"]
      } else if (raw["updateCheck"] !== undefined) {
        warnings.push(`config: updateCheck must be a boolean — using default`)
      }
      // tabs (docs/config.md "layout"): vertical rail width, used when layout
      // is "sidebar". A record is expected; unknown keys warn, width accepts
      // 16-60 (floored), anything else keeps the default.
      const tabsRaw = raw["tabs"]
      if (isRecord(tabsRaw)) {
        const tb = tabsRaw as Record<string, unknown>
        for (const k of Object.keys(tb)) {
          if (!TABS_KEYS.has(k)) warnings.push(`config: tabs has unknown key "${k}" ignored`)
        }
        const w = tb["width"]
        if (w !== undefined) {
          if (typeof w === "number" && Number.isFinite(w) && w >= 16 && w <= 60) {
            out.tabRailWidth = Math.floor(w)
          } else {
            warnings.push(`config: tabs.width must be a number 16-60 — using default`)
          }
        }
      } else if (tabsRaw !== undefined) {
        warnings.push(`config: tabs must be an object — ignored`)
      }
      // sidebar
      const sb = raw["sidebar"]
      if (isRecord(sb)) {
        const w = (sb as Record<string, unknown>)["width"]
        if (typeof w === "number" && Number.isFinite(w)) {
          out.sidebarWidth = Math.max(20, Math.floor(w))
        }
      }
      if (typeof raw["theme"] === "string") {
        out.theme = raw["theme"] as string
        if (!isThemeName(out.theme)) {
          warnings.push(`config: unknown theme "${out.theme}" — using "terminal" (docs/config.md)`)
        }
      }
      // themePalette (manual palette override, docs/config.md "themePalette")
      const tp = raw["themePalette"]
      if (tp !== undefined) {
        if (!isRecord(tp)) {
          warnings.push(`config: themePalette must be an object — ignored (docs/config.md)`)
        } else {
          const o = tp as Record<string, unknown>
          const override: {
            palette?: (string | null)[]
            foreground?: string
            background?: string
            paneColors?: "exact" | "index"
            boldBright?: boolean
            colorMode?: ColorMode
          } = {}
          const pal = o["palette"]
          if (pal !== undefined) {
            if (Array.isArray(pal)) {
              const entries: (string | null)[] = []
              let bad = 0
              for (const e of pal) {
                if (typeof e === "string" && parseHexColor(e) !== null) entries.push(e)
                else {
                  entries.push(null)
                  bad++
                }
              }
              if (bad > 0) {
                warnings.push(`config: themePalette.palette has ${bad} invalid color(s) — those entries fall back to detection`)
              }
              if (entries.some((e) => e !== null)) override.palette = entries
            } else {
              warnings.push(`config: themePalette.palette must be an array of colors — ignored`)
            }
          }
          const fg = o["foreground"]
          if (fg !== undefined) {
            if (typeof fg === "string" && parseHexColor(fg) !== null) override.foreground = fg
            else warnings.push(`config: themePalette.foreground must be a color (#rgb/#rrggbb/rgb:r/g/b) — ignored`)
          }
          const bg = o["background"]
          if (bg !== undefined) {
            if (typeof bg === "string" && parseHexColor(bg) !== null) override.background = bg
            else warnings.push(`config: themePalette.background must be a color (#rgb/#rrggbb/rgb:r/g/b) — ignored`)
          }
          for (const k of Object.keys(o)) {
            if (
              k !== "palette" &&
              k !== "foreground" &&
              k !== "background" &&
              k !== "paneColors" &&
              k !== "boldBright" &&
              k !== "colorMode"
            ) {
              warnings.push(`config: themePalette has unknown key "${k}" ignored`)
            }
          }
          const pc = o["paneColors"]
          if (pc === "exact" || pc === "index") override.paneColors = pc
          else if (pc !== undefined) {
            warnings.push(`config: themePalette.paneColors must be "exact" or "index" — ignored`)
          }
          const bb = o["boldBright"]
          if (typeof bb === "boolean") override.boldBright = bb
          else if (bb !== undefined) warnings.push(`config: themePalette.boldBright must be a boolean — ignored`)
          const cm = o["colorMode"]
          if (cm === "auto" || cm === "truecolor" || cm === "ansi256") override.colorMode = cm
          else if (cm !== undefined) {
            warnings.push(`config: themePalette.colorMode must be "auto", "truecolor" or "ansi256" — ignored`)
          }
          if (
            override.palette ||
            override.foreground ||
            override.background ||
            override.paneColors !== undefined ||
            override.boldBright !== undefined ||
            override.colorMode !== undefined
          ) {
            out.themePalette = override
          }
        }
      }
      // keymap
      const km = raw["keymap"]
      if (isRecord(km)) {
        const merged: Partial<Record<KeyActionId, string>> = { ...out.keymap }
        for (const [k, v] of Object.entries(km as Record<string, unknown>)) {
          if (typeof v === "string") (merged as Record<string, unknown>)[k] = v
        }
        out.keymap = merged
      }
      // mcp (M11, docs/mcp.md)
      const mc = raw["mcp"]
      if (isRecord(mc)) {
        out.mcp = parseMcpSection(mc as Record<string, unknown>, env, warnings)
      } else if (mc !== undefined) {
        warnings.push(`config: mcp must be an object — ignored (docs/mcp.md)`)
      }
      // extensions (docs/extensions.md): the approval-policy + event-sink seam.
      // Both default to no-op/local. An unknown policy kind is passed through
      // (resolved by a host-supplied factory; a stock build ignores it); an
      // invalid sink kind/path warns and keeps the noop default.
      const extRaw = raw["extensions"]
      if (isRecord(extRaw)) {
        const e = extRaw as Record<string, unknown>
        for (const k of Object.keys(e)) {
          if (!EXTENSION_KEYS.has(k)) warnings.push(`config: extensions has unknown key "${k}" ignored (docs/extensions.md)`)
        }
        const ap = e["approvalPolicy"]
        if (isRecord(ap)) {
          const obj = ap as Record<string, unknown>
          const kind = obj["kind"]
          if (typeof kind === "string" && kind.trim().length > 0) {
            out.extensions.approvalPolicy = { ...obj, kind: kind.trim() }
          } else {
            warnings.push(`config: extensions.approvalPolicy.kind must be a non-empty string — using default (docs/extensions.md)`)
          }
        } else if (ap !== undefined) {
          warnings.push(`config: extensions.approvalPolicy must be an object — using default (docs/extensions.md)`)
        }
        const es = e["eventSink"]
        if (isRecord(es)) {
          const obj = es as Record<string, unknown>
          for (const k of Object.keys(obj)) {
            if (k !== "kind" && k !== "path") {
              warnings.push(`config: extensions.eventSink has unknown key "${k}" ignored (docs/extensions.md)`)
            }
          }
          const kind = obj["kind"]
          if (kind === "noop") {
            out.extensions.eventSink = { kind: "noop" }
          } else if (kind === "jsonl") {
            const p = obj["path"]
            if (p === undefined) out.extensions.eventSink = { kind: "jsonl" }
            else if (typeof p === "string" && p.trim().length > 0) out.extensions.eventSink = { kind: "jsonl", path: p.trim() }
            else warnings.push(`config: extensions.eventSink.path must be a non-empty string — using the default log (docs/extensions.md)`)
          } else if (kind === "uds") {
            const p = obj["path"]
            if (typeof p === "string" && p.trim().length > 0) out.extensions.eventSink = { kind: "uds", path: p.trim() }
            else warnings.push(`config: extensions.eventSink.path is required for kind "uds" — using noop (docs/extensions.md)`)
          } else if (kind !== undefined) {
            warnings.push(`config: extensions.eventSink.kind must be "noop", "uds" or "jsonl" — using default (docs/extensions.md)`)
          }
        } else if (es !== undefined) {
          warnings.push(`config: extensions.eventSink must be an object — using default (docs/extensions.md)`)
        }
      } else if (extRaw !== undefined) {
        warnings.push(`config: extensions must be an object — ignored (docs/extensions.md)`)
      }
    }
  }

  // ---- Merge endpoints --------------------------------------------------
  const names = new Set(["main"])
  if (fileEndpoints) {
    out.endpoints = {}
    for (const name of Object.keys(fileEndpoints)) {
      names.add(name)
      out.endpoints[name] = { ...defaultEndpoint(name), ...(fileEndpoints[name] ?? {}) }
    }
    // An omitted/empty baseURL on a real protocol resolves to the protocol's
    // default (docs/config.md "Endpoints and the selected model"; e.g.
    // Anthropic's api.anthropic.com). The raw partial is consulted because the
    // merge above already filled defaultEndpoint's generic OpenAI URL. Mock
    // keeps the constructed default.
    for (const [name, partial] of Object.entries(fileEndpoints)) {
      const ep = out.endpoints[name]
      if (ep === undefined || !isProtocolKind(ep.provider)) continue
      if (partial.baseURL === undefined || partial.baseURL.trim().length === 0) {
        ep.baseURL = resolveBaseURL(ep.provider, partial.baseURL)
      }
    }
  }
  // Validate every endpoint's baseURL (a bad one sets bootError, surfaced by
  // the setup modal rather than refusing to boot).
  for (const name of Object.keys(out.endpoints)) {
    const p = out.endpoints[name]
    if (p) {
      const err = validateBaseURL(p.baseURL)
      if (err) {
        out.bootError = `config: endpoint "${name}" has a bad baseURL (${err}) — fix ${file ?? "config"} or pass --base-url`
      }
    }
  }

  // ---- Selected model: file -> env -> CLI ---------------------------------
  let selected = parseSelectedModel(fileModel ?? out.model)
  if (fileModel !== undefined && selected === null) {
    warnings.push(`config: model "${fileModel}" is not "<endpoint>@<model>" — using default`)
    selected = parseSelectedModel(out.model)
  }
  // env: SENSUS_MODEL is endpoint@model, or a bare model id on the current endpoint.
  if (env["SENSUS_MODEL"]) {
    const parsed = parseSelectedModel(env["SENSUS_MODEL"])
    if (parsed !== null) selected = parsed
    else if (selected !== null) selected = { endpoint: selected.endpoint, model: env["SENSUS_MODEL"] }
  }
  // env: SENSUS_ENDPOINT switches the endpoint, keeping the model id.
  if (env["SENSUS_ENDPOINT"] && selected !== null) selected = { endpoint: env["SENSUS_ENDPOINT"], model: selected.model }
  // CLI (highest): --model (endpoint@model or bare), then --endpoint.
  if (args.model) {
    const parsed = parseSelectedModel(args.model)
    if (parsed !== null) selected = parsed
    else if (selected !== null) selected = { endpoint: selected.endpoint, model: args.model }
  }
  if (args.endpoint && selected !== null) selected = { endpoint: args.endpoint, model: selected.model }

  if (selected === null || !(selected.endpoint in out.endpoints)) {
    if (selected !== null) {
      warnings.push(`config: endpoint "${selected.endpoint}" is not defined — using the first one`)
    }
    const first = Object.keys(out.endpoints)[0] ?? "main"
    const fallbackModel = selected !== null ? selected.model : parseSelectedModel(out.model)?.model ?? "gpt-5"
    selected = { endpoint: first, model: fallbackModel }
  }
  out.model = selectedModelString(selected.endpoint, selected.model)

  if (env["SENSUS_APPROVAL"] === "confirm" || env["SENSUS_APPROVAL"] === "full-auto") {
    out.approval = env["SENSUS_APPROVAL"] as ApprovalMode
  } else if (env["SENSUS_APPROVAL"] !== undefined) {
    warnings.push(`env SENSUS_APPROVAL must be "confirm" or "full-auto" — ignored`)
  }
  // SENSUS_DAEMON_PERSISTENT (docs/config.md "daemon", D3/D9): a persistent
  // daemon never grace-exits. Truthy/falsey spellings only; anything else warns.
  const persistentEnv = env["SENSUS_DAEMON_PERSISTENT"]
  if (persistentEnv !== undefined) {
    const v = persistentEnv.trim().toLowerCase()
    if (v === "1" || v === "true" || v === "yes" || v === "on") out.daemonPersistent = true
    else if (v === "0" || v === "false" || v === "no" || v === "off" || v === "") out.daemonPersistent = false
    else warnings.push(`env SENSUS_DAEMON_PERSISTENT must be a boolean-ish value — ignored`)
  }
  // SENSUS_UPDATE_CHECK (docs/config.md "updateCheck"): the launch update alert.
  // Truthy/falsey spellings only; anything else warns.
  const updateCheckEnv = env["SENSUS_UPDATE_CHECK"]
  if (updateCheckEnv !== undefined) {
    const v = updateCheckEnv.trim().toLowerCase()
    if (v === "1" || v === "true" || v === "yes" || v === "on") out.updateCheck = true
    else if (v === "0" || v === "false" || v === "no" || v === "off" || v === "") out.updateCheck = false
    else warnings.push(`env SENSUS_UPDATE_CHECK must be a boolean-ish value — ignored`)
  }
  // env field overrides on the SELECTED endpoint (highest env tier).
  const active = out.endpoints[selected.endpoint]
  if (active) {
    if (env["SENSUS_BASE_URL"]) {
      const err = validateBaseURL(env["SENSUS_BASE_URL"])
      if (err) out.bootError = `env SENSUS_BASE_URL is invalid: ${err}`
      else active.baseURL = env["SENSUS_BASE_URL"]
    }
    if (args.baseURL) {
      const err = validateBaseURL(args.baseURL)
      if (err) out.bootError = `--base-url is invalid: ${err}`
      else active.baseURL = args.baseURL
    }
  }
  if (fileAgent !== undefined) out.defaultAgent = fileAgent
  if (fileAllowPrefixes !== null) out.allowPrefixes = fileAllowPrefixes
  if (args.yolo) out.approval = "full-auto"
  if (args.sidebarWidth !== undefined) out.sidebarWidth = args.sidebarWidth

  return out
}
