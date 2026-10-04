import { MCP_DEFAULT_TIMEOUT_S, expandEnvRefs, expandEnvRefsMap } from "../../agent/mcp/types.ts"
import { isRecord } from "../../core/util.ts"
import type { McpConfig, McpServerConfig } from "./types.ts"

const MCP_SERVER_KEYS = new Set(["command", "args", "env", "cwd", "url", "headers", "enabled", "timeout_s"])

/**
 * Parse the `mcp` config section (docs/mcp.md): each entry under
 * `mcp.servers` is a stdio server (`command`[+`args`+`env`]) or a remote
 * streamable-HTTP server (`url`[+`headers`]). Invalid entries warn + skip —
 * an MCP misconfiguration must never block boot (same rule as unknown keys).
 * ${VAR} refs in env/header values expand from `env` (missing -> "" + warn).
 */
export function parseMcpSection(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): McpConfig {
  const serversRaw = raw["servers"]
  const servers: Record<string, McpServerConfig> = {}
  if (serversRaw === undefined || serversRaw === null) {
    return { servers: {} }
  }
  if (typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
    warnings.push(`config: mcp.servers must be an object — ignored (docs/mcp.md)`)
    return { servers: {} }
  }
  for (const [name, entry] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`config: mcp server "${name}" must be an object — skipped`)
      continue
    }
    const e = entry as Record<string, unknown>
    for (const k of Object.keys(e)) {
      if (!MCP_SERVER_KEYS.has(k)) warnings.push(`config: mcp server "${name}" has unknown key "${k}" ignored`)
    }
    const command = typeof e["command"] === "string" ? (e["command"] as string) : undefined
    const url = typeof e["url"] === "string" ? (e["url"] as string) : undefined
    if ((command === undefined) === (url === undefined)) {
      warnings.push(`config: mcp server "${name}" needs exactly one of "command" (stdio) or "url" (http) — skipped`)
      continue
    }
    if (url !== undefined) {
      try {
        const u = new URL(url)
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol")
      } catch {
        warnings.push(`config: mcp server "${name}" has an invalid url "${url}" — skipped`)
        continue
      }
    }

    let envValues: Record<string, string> | undefined
    let headerValues: Record<string, string> | undefined
    if (e["env"] !== undefined) {
      const ev = e["env"]
      if (isRecord(ev)) {
        const r = expandEnvRefsMap(ev as Record<string, string>, env)
        if (r.missing.length > 0) {
          warnings.push(`config: mcp server "${name}" env vars ${[...new Set(r.missing)].join(", ")} not set — empty`)
        }
        envValues = r.values
      } else {
        warnings.push(`config: mcp server "${name}" env must be an object — ignored`)
      }
    }
    if (e["headers"] !== undefined) {
      const hv = e["headers"]
      if (isRecord(hv)) {
        const r = expandEnvRefsMap(hv as Record<string, string>, env)
        if (r.missing.length > 0) {
          warnings.push(`config: mcp server "${name}" header vars ${[...new Set(r.missing)].join(", ")} not set — empty`)
        }
        headerValues = r.values
      } else {
        warnings.push(`config: mcp server "${name}" headers must be an object — ignored`)
      }
    }

    // cwd (stdio only): ${VAR}-expanded like env/headers. A relative path is
    // resolved against the config dir later (registry.resolveMcpServerCwd).
    let cwd: string | undefined
    if (e["cwd"] !== undefined) {
      if (typeof e["cwd"] === "string") {
        const r = expandEnvRefs(e["cwd"] as string, env)
        if (r.missing.length > 0) {
          warnings.push(`config: mcp server "${name}" cwd vars ${[...new Set(r.missing)].join(", ")} not set — empty`)
        }
        cwd = r.value
      } else {
        warnings.push(`config: mcp server "${name}" cwd must be a string — ignored`)
      }
    }

    const enabled = e["enabled"] === undefined ? true : e["enabled"] === true
    let timeoutS = MCP_DEFAULT_TIMEOUT_S
    const ts = e["timeout_s"]
    if (typeof ts === "number" && Number.isFinite(ts) && ts >= 1) {
      timeoutS = Math.min(Math.floor(ts), 600)
    } else if (ts !== undefined) {
      warnings.push(`config: mcp server "${name}" timeout_s must be a number >= 1 — using default`)
    }

    if (command !== undefined) {
      servers[name] = {
        command,
        args: Array.isArray(e["args"]) ? (e["args"] as unknown[]).map((a) => String(a)) : undefined,
        env: envValues,
        cwd,
        enabled,
        timeoutS,
      }
    } else {
      if (cwd !== undefined) warnings.push(`config: mcp server "${name}" cwd is stdio-only — ignored`)
      servers[name] = { url: url!, headers: headerValues, enabled, timeoutS }
    }
  }
  return { servers }
}
