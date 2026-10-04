/**
 * The daemon's `GET /v1/config` resource (D13; docs/daemon-api.md): the
 * EFFECTIVE config (defaults → file → env → flags) with every secret resolved
 * OUT. The daemon owns config and secrets; the client receives a redacted view
 * over the API and keeps only theme/palette detection.
 *
 * Redaction rules:
 *   - a raw `${NAME}` reference (whole value or inside a larger string, e.g.
 *     `"Bearer ${TOKEN}"`) is kept verbatim — it names a secret, it is not one;
 *   - a literal secret (an endpoint `apiKey`, an MCP `env`/`headers` value, an
 *     MCP `cwd`) is replaced with `<redacted>` — never the resolved value;
 *   - an empty/absent credential stays `""`.
 *
 * Credential-bearing locations are known (endpoint `apiKey` + MCP
 * `env`/`headers`/`cwd`) rather than guessed by key name, so no unrelated field
 * is mangled and no secret slips through.
 */

import { isRecord } from "../core/util.ts"
import { configPath, loadConfig, type SensusConfig } from "../engine/index.ts"
import { readRawConfig } from "../config/configFile.ts"

/** Placeholder shown where a literal secret was present. */
export const REDACTED = "<redacted>"

/** Follow a raw-doc path, returning the string value there when well-typed. */
function rawString(raw: Record<string, unknown> | null, ...path: string[]): string | undefined {
  let node: unknown = raw
  for (const key of path) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return typeof node === "string" ? node : undefined
}

/**
 * The redacted value for one credential: keep a `${NAME}` reference visible,
 * otherwise show `<redacted>` when anything is set (and `""` when empty).
 */
function redactSecret(effective: unknown, rawValue: unknown): string {
  if (typeof rawValue === "string" && rawValue.includes("${")) return rawValue
  const value = typeof effective === "string" ? effective : ""
  return value.length > 0 ? REDACTED : ""
}

/**
 * Deep-copy the effective config and strip every resolved secret. Pure; the
 * returned object is JSON-serializable and safe to hand to a client.
 */
export function redactConfig(config: SensusConfig, raw: Record<string, unknown> | null): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(config)) as Record<string, unknown>

  const endpoints = isRecord(doc["endpoints"]) ? (doc["endpoints"] as Record<string, unknown>) : {}
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (!isRecord(endpoint)) continue
    endpoint["apiKey"] = redactSecret(endpoint["apiKey"], rawString(raw, "endpoints", name, "apiKey"))
  }

  const mcp = isRecord(doc["mcp"]) ? (doc["mcp"] as Record<string, unknown>) : null
  const servers = mcp !== null && isRecord(mcp["servers"]) ? (mcp["servers"] as Record<string, unknown>) : {}
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) continue
    for (const field of ["env", "headers"] as const) {
      const map = server[field]
      if (!isRecord(map)) continue
      for (const key of Object.keys(map)) {
        map[key] = redactSecret(map[key], rawString(raw, "mcp", "servers", name, field, key))
      }
    }
    if ("cwd" in server) server["cwd"] = redactSecret(server["cwd"], rawString(raw, "mcp", "servers", name, "cwd"))
  }

  return doc
}

/**
 * Resolve the effective config and the raw file document, then redact. `argv`
 * is the daemon's own flag list (docs/daemon-api.md); `env` is unused today
 * (the config layer reads `process.env` directly) and exists for symmetry.
 */
export function readRedactedConfig(argv: readonly string[]): Record<string, unknown> {
  return redactConfig(loadConfig(argv), readRawConfig(configPath()))
}
