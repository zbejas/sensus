import { describe, expect, test } from "bun:test"
import { defaultConfig } from "../../../../src/config/config.ts"
import { docFromConfig, readEndpoints, settingsSeedDoc } from "../../../../src/ui/chat/settingsDoc.ts"

describe("docFromConfig (settings bootstrap when no config file exists)", () => {
  test("maps the resolved config onto the raw-doc shape the screen edits", () => {
    const config = defaultConfig()
    config.model = "main@mock-gpt-large"
    config.defaultAgent = "copilot"
    config.approval = "full-auto"
    config.allowPrefixes = ["git ", "ls "]
    config.sidebarWidth = 72
    config.theme = "nord"
    config.context = { ...config.context, scrollbackLines: 250, enabled: false }
    config.endpoints = {
      main: { ...config.endpoints["main"]!, name: "main", baseURL: "http://localhost:1234/v1", apiKey: "sk-x" },
      ollama: {
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        temperature: 1,
        maxTokens: 8192,
        provider: "openai-compatible",
        thinkingMode: "high",
        models: {},
      },
    }

    const doc = docFromConfig(config)
    expect(doc["model"]).toBe("main@mock-gpt-large")
    expect(doc["agent"]).toBe("copilot")
    expect(doc["approval"]).toBe("full-auto")
    expect(doc["allowPrefixes"]).toEqual(["git ", "ls "])
    expect(doc["theme"]).toBe("nord")
    expect(doc["sidebar"]).toEqual({ width: 72 })
    expect(doc["context"]).toEqual({ scrollbackLines: 250, enabled: false })
    expect(doc["endpoints"]).toEqual({
      main: { baseURL: "http://localhost:1234/v1", apiKey: "sk-x" },
      ollama: { baseURL: "http://localhost:11434/v1", apiKey: "", thinkingMode: "high" },
    })
  })
})

describe("settingsSeedDoc (endpoint list is never silently empty)", () => {
  const config = defaultConfig()
  config.endpoints = { main: { ...config.endpoints["main"]!, name: "main", baseURL: "http://localhost:1234/v1", apiKey: "" } }

  test("no config file: bootstraps the resolved endpoints", () => {
    expect(readEndpoints(settingsSeedDoc(null, config)).map((e) => e.name)).toEqual(["main"])
  })

  test("a file that OMITS `endpoints` inherits the resolved endpoints (keeps its other keys)", () => {
    const doc = settingsSeedDoc({ theme: "nord", note: "keep me" }, config)
    expect(doc["theme"]).toBe("nord")
    expect(doc["note"]).toBe("keep me")
    expect(readEndpoints(doc)).toEqual([
      { name: "main", baseURL: "http://localhost:1234/v1", apiKey: "", provider: "openai-compatible", temperature: "", maxTokens: "", thinkingMode: "", modelsJson: "" },
    ])
  })

  test("a file's own endpoints win; an explicit empty set stays empty", () => {
    const mine = settingsSeedDoc({ endpoints: { mine: { baseURL: "http://x/v1" } } }, config)
    expect(readEndpoints(mine).map((e) => e.name)).toEqual(["mine"])
    // `endpoints: {}` is a deliberate "no endpoints" — the runtime agrees, so
    // the screen must not resurrect the default.
    expect(readEndpoints(settingsSeedDoc({ endpoints: {} }, config))).toEqual([])
    // Junk in `endpoints` falls back the same as a missing key.
    expect(readEndpoints(settingsSeedDoc({ endpoints: "oops" }, config)).map((e) => e.name)).toEqual(["main"])
  })
})

describe("readEndpoints provider canonicalization", () => {
  test("canonical kinds survive, legacy http canonicalizes, unknown/absent default to openai-compatible", () => {
    const rows = readEndpoints({
      endpoints: {
        compat: { provider: "openai-compatible" },
        responses: { provider: "openai-responses" },
        anthropic: { provider: "anthropic" },
        google: { provider: "google" },
        mock: { provider: "mock" },
        legacy: { provider: "http" },
        unknown: { provider: "wat" },
        absent: {},
      },
    })
    const byName = new Map(rows.map((r) => [r.name, r.provider]))
    expect(byName.get("compat")).toBe("openai-compatible")
    expect(byName.get("responses")).toBe("openai-responses")
    expect(byName.get("anthropic")).toBe("anthropic")
    expect(byName.get("google")).toBe("google")
    expect(byName.get("mock")).toBe("mock")
    expect(byName.get("legacy")).toBe("openai-compatible")
    expect(byName.get("unknown")).toBe("openai-compatible")
    expect(byName.get("absent")).toBe("openai-compatible")
  })

  test("docFromConfig emits provider only when it is not the default", () => {
    const base = defaultConfig().endpoints["main"]!
    const config = defaultConfig()
    config.endpoints = {
      main: { ...base, baseURL: "http://localhost:1234/v1", apiKey: "" },
      anthro: { ...base, name: "anthro", provider: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKey: "" },
    }
    const endpoints = docFromConfig(config)["endpoints"] as Record<string, Record<string, unknown>>
    expect(endpoints["main"]).toEqual({ baseURL: "http://localhost:1234/v1", apiKey: "" })
    expect(endpoints["anthro"]).toEqual({ baseURL: "https://api.anthropic.com/v1", apiKey: "", provider: "anthropic" })
  })
})
