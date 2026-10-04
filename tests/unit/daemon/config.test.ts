/**
 * Config redaction (D13; docs/daemon-api.md): `/v1/config` returns the effective
 * config with every resolved secret stripped. A `${NAME}` reference is kept (it
 * names a secret, it is not one); a literal secret becomes `<redacted>`.
 */

import { describe, expect, test } from "bun:test"
import { defaultConfig, defaultEndpoint, type SensusConfig } from "../../../src/engine/index.ts"
import { REDACTED, redactConfig } from "../../../src/daemon/index.ts"

const SECRET = "sk-super-secret-value-1234567890"

function configWithEndpoint(apiKey: string): SensusConfig {
  const cfg = defaultConfig()
  cfg.endpoints = { main: { ...defaultEndpoint("main"), apiKey } }
  return cfg
}

describe("redactConfig", () => {
  test("keeps a ${NAME} reference verbatim (a ref, not a secret)", () => {
    const raw = { endpoints: { main: { apiKey: "${OPENAI_API_KEY}" } } }
    const out = redactConfig(configWithEndpoint(SECRET), raw)
    const endpoints = out["endpoints"] as Record<string, Record<string, unknown>>
    expect(endpoints["main"]?.["apiKey"]).toBe("${OPENAI_API_KEY}")
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  test("keeps a ref embedded in a larger string (Bearer ${TOKEN})", () => {
    const raw = { mcp: { servers: { remote: { headers: { Authorization: "Bearer ${TOKEN}" } } } } }
    const cfg = defaultConfig()
    cfg.mcp = { servers: { remote: { url: "https://example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` }, enabled: true, timeoutS: 30 } } }
    const out = redactConfig(cfg, raw)
    const servers = (out["mcp"] as { servers: Record<string, { headers: Record<string, string> }> }).servers
    expect(servers["remote"]?.headers["Authorization"]).toBe("Bearer ${TOKEN}")
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  test("redacts a literal secret to <redacted>, and an empty credential stays empty", () => {
    const literal = redactConfig(configWithEndpoint(SECRET), { endpoints: { main: { apiKey: SECRET } } })
    const endpoints = literal["endpoints"] as Record<string, Record<string, unknown>>
    expect(endpoints["main"]?.["apiKey"]).toBe(REDACTED)
    expect(JSON.stringify(literal)).not.toContain(SECRET)

    const empty = redactConfig(configWithEndpoint(""), { endpoints: { main: { apiKey: "" } } })
    expect((empty["endpoints"] as Record<string, Record<string, unknown>>)["main"]?.["apiKey"]).toBe("")

    // Resolved with no raw entry (e.g. an env-injected value) is redacted too.
    const orphan = redactConfig(configWithEndpoint(SECRET), null)
    expect((orphan["endpoints"] as Record<string, Record<string, unknown>>)["main"]?.["apiKey"]).toBe(REDACTED)
  })

  test("redacts MCP env/headers/cwd values that are literals", () => {
    const cfg = defaultConfig()
    cfg.mcp = {
      servers: {
        stdio: { command: "npx", args: ["x"], env: { API_KEY: SECRET }, cwd: `/tmp/${SECRET}`, enabled: true, timeoutS: 30 },
      },
    }
    const raw = { mcp: { servers: { stdio: { env: { API_KEY: SECRET }, cwd: `/tmp/${SECRET}` } } } }
    const out = redactConfig(cfg, raw)
    const server = (out["mcp"] as { servers: Record<string, Record<string, unknown>> }).servers["stdio"]
    expect(server?.["env"]).toEqual({ API_KEY: REDACTED })
    expect(server?.["cwd"]).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })
})
