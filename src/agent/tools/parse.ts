import { isAbsolute, join } from "node:path"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.tools")

/** Defensive parse of a tool call's raw JSON arguments. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
    return {}
  } catch (e) {
    log.debug("tool arguments JSON parse failed; using empty args", { err: e })
    return {}
  }
}

/**
 * Repair a model-emitted tool name against the specs actually sent for the
 * request (mirrors OpenCode's `experimental_repairToolCall`). Resolution order:
 * exact -> case-insensitive -> a UNIQUE whole-prefix/suffix match (e.g. `read`
 * for `read_file`). An ambiguous match (0 or >1 candidates) leaves the name
 * unchanged, so the structured `unknown tool "<name>"` error still surfaces.
 */
export function resolveToolName(name: string, known: readonly string[]): string {
  if (name.length === 0) return name
  if (known.includes(name)) return name
  const lower = name.toLowerCase()
  const ci = known.filter((k) => k.toLowerCase() === lower)
  if (ci.length === 1) return ci[0]!
  // Prefix/suffix: the model may drop a segment ("read" for "read_file") or
  // rearrange it. Only an unambiguous hit is repaired.
  const candidates = new Set<string>()
  for (const k of known) {
    const kl = k.toLowerCase()
    if (kl.startsWith(lower) || kl.endsWith(lower)) candidates.add(k)
  }
  if (candidates.size === 1) return candidates.values().next().value as string
  return name
}

// ---- Paths -----------------------------------------------------------------

/** Resolve a tool path against the pane cwd; ~ expands to $HOME. */
export function resolveToolPath(p: string, baseCwd: string | null): string {
  if (p === "~") return process.env["HOME"] ?? p
  if (p.startsWith("~/")) return join(process.env["HOME"] ?? "~", p.slice(2))
  if (isAbsolute(p)) return p
  const base = baseCwd && baseCwd.length > 0 ? baseCwd : process.cwd()
  return join(base, p)
}
