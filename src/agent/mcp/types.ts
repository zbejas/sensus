/**
 * MCP (Model Context Protocol) config types + helpers (docs/mcp.md).
 *
 * A configured server is either
 * - stdio:  sensus spawns `command args…` and speaks newline-delimited
 *           JSON-RPC 2.0 over its stdin/stdout (the MCP stdio transport), or
 * - http:   a remote streamable-HTTP endpoint (`url`) addressed with
 *           extra `headers` (e.g. `Authorization: Bearer ${FIRECRAWL_API_KEY}`).
 *
 * `${VAR}` references in `env` values and `headers` values expand at
 * config-resolution time from the encrypted secrets store first, then the
 * process environment (missing var -> empty value + one warning) so API keys
 * never have to live in config.json (docs/config.md "Secrets").
 */

export interface McpServerConfig {
  /** stdio server: argv[0] (e.g. "npx"). */
  command?: string
  /** stdio server: argv[1..]. */
  args?: string[]
  /** stdio only: extra env merged over the process env (${VAR}-expanded). */
  env?: Record<string, string>
  /**
   * stdio only: the child's working directory (${VAR}-expanded). Relative
   * paths resolve against the config dir (`sensusHome()`). Absent = a stable
   * per-server dir under the cache dir (`<cache>/mcp/<server>/`), so a server
   * never litters the directory sensus was launched from (docs/mcp.md).
   */
  cwd?: string
  /** http server: the streamable-HTTP endpoint. */
  url?: string
  /** http only: extra request headers (${VAR}-expanded). */
  headers?: Record<string, string>
  /** Disabled servers are skipped (kept in the file). Default true. */
  enabled: boolean
  /** Per-call and initialize timeout, seconds (default 60, clamped 1..600). */
  timeoutS: number
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

export const MCP_DEFAULT_TIMEOUT_S = 60

export function defaultMcpConfig(): McpConfig {
  return { servers: {} }
}

/**
 * Expand `${NAME}` references from `env`. A missing variable expands to ""
 * and is reported (once per reference) in the returned warnings.
 */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
  const missing: string[] = []
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
    const v = env[name]
    if (v === undefined || v === null) {
      missing.push(name)
      return ""
    }
    return v
  })
  return { value: out, missing }
}

/** Expand a whole string map (values may carry ${VAR} refs). */
export function expandEnvRefsMap(
  map: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): { values: Record<string, string> | undefined; missing: string[] } {
  if (!map) return { values: undefined, missing: [] }
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const [k, v] of Object.entries(map)) {
    const r = expandEnvRefs(String(v), env)
    values[k] = r.value
    missing.push(...r.missing)
  }
  return { values, missing }
}

/** Server/tool names ride in OpenAI function names — restrict the alphabet. */
export function sanitizeNamePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_")
}

export const MCP_TOOL_PREFIX = "mcp__"

/** True when a tool name is in the MCP namespace (`mcp__…`). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

/** A short hash for over-long wire names (OpenAI caps function names at 64). */
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Wire name for one server tool: `mcp__<server>__<tool>`, sanitized, and
 * truncated with a stable hash suffix when the OpenAI 64-char cap would bite.
 * `parseWireName` inverts this for everything short enough to stay readable.
 */
export function wireToolName(server: string, tool: string): string {
  const full = `${MCP_TOOL_PREFIX}${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`
  if (full.length <= 64) return full
  return `${full.slice(0, 54)}_${shortHash(full)}`
}

export interface WireToolRef {
  server: string
  tool: string
}

/** Split a `mcp__<server>__<tool>` wire name (null when not namespaced). */
export function parseWireName(name: string): WireToolRef | null {
  if (!isMcpToolName(name)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf("__")
  if (sep <= 0 || sep >= rest.length - 2) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}
