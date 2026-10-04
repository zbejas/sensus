/**
 * Setup-wizard core tests (src/config/wizard.ts): the step machine, endpoint
 * validation, draft preloading, draft→config merging (unknown keys preserved),
 * model/theme selection, and the host-scan seed decision. Pure — no renderer,
 * no fetch, no filesystem.
 */

import { describe, expect, test } from "bun:test"
import {
  buildConfigDoc,
  capSeedContent,
  chatModels,
  defaultDraft,
  draftFromConfig,
  ENDPOINT_FIELDS,
  endpointFieldValue,
  existingEndpointNames,
  firstStep,
  isDefaultConfig,
  nextStep,
  normalizeTheme,
  planExistingChoice,
  planHostSeed,
  prevStep,
  rankModels,
  rankThemes,
  resolveModelChoice,
  stepIndex,
  validateBaseURLInput,
  validateDraft,
  validateEndpointName,
  WIZARD_STEPS,
  WIZARD_THEMES,
  withEndpointField,
  withProvider,
  type EndpointDraft,
  type WizardDraft,
} from "../../../src/config/wizard.ts"
import type { RawConfigDoc } from "../../../src/config/configFile.ts"
import { starterConfigDoc } from "../../../src/config/config.ts"
import type { EndpointModel } from "../../../src/agent/provider/modelCatalog.ts"

function makeModel(id: string, chat = true): EndpointModel {
  return { id, ownedBy: null, endpointTypes: [], chat }
}

const draft = (
  over: Partial<Omit<WizardDraft, "endpoint">> & { endpoint?: Partial<EndpointDraft> } = {},
): WizardDraft => ({
  ...defaultDraft(),
  ...over,
  endpoint: { ...defaultDraft().endpoint, ...(over.endpoint ?? {}) },
})

describe("wizard step machine", () => {
  test("order, first step and forward chain", () => {
    expect(WIZARD_STEPS).toEqual(["existing", "theme", "endpoint", "test", "model", "hostscan", "review"])
    expect(firstStep(true)).toBe("existing")
    expect(firstStep(false)).toBe("theme")

    const chain: string[] = []
    let step = firstStep(true)
    while (true) {
      chain.push(step)
      const n = nextStep(step)
      if (n === null) break
      step = n
    }
    expect(chain).toEqual(["existing", "theme", "endpoint", "test", "model", "hostscan", "review"])
    expect(nextStep("review")).toBeNull()
  })

  test("backward chain respects whether an existing config was found", () => {
    expect(prevStep("existing", true)).toBeNull()
    expect(prevStep("theme", true)).toBe("existing")
    expect(prevStep("theme", false)).toBeNull()
    expect(prevStep("endpoint", true)).toBe("theme")
    expect(prevStep("endpoint", false)).toBe("theme")
    expect(prevStep("test", false)).toBe("endpoint")
    expect(prevStep("review", true)).toBe("hostscan")
    expect(stepIndex("endpoint")).toBe(2)
  })

  test("existing-config choice maps to keep/edit/fresh", () => {
    expect(planExistingChoice("keep")).toEqual({ proceed: false, mode: "merge", step: "theme" })
    expect(planExistingChoice("edit")).toEqual({ proceed: true, mode: "merge", step: "theme" })
    expect(planExistingChoice("fresh")).toEqual({ proceed: true, mode: "fresh", step: "theme" })
  })
})

describe("wizard default config detection", () => {
  test("null and the untouched starter doc are both default", () => {
    expect(isDefaultConfig(null)).toBe(true)
    expect(isDefaultConfig(starterConfigDoc())).toBe(true)
    // The helper's expectations track the scaffold's actual shape.
    expect(starterConfigDoc().model).toBe("main@gpt-5")
    expect(starterConfigDoc().agent).toBe("copilot")
    expect(starterConfigDoc().approval).toBe("confirm")
  })

  test("the default theme is allowed, a non-default theme is not", () => {
    expect(isDefaultConfig({ ...starterConfigDoc(), theme: "terminal" })).toBe(true)
    expect(isDefaultConfig({ ...starterConfigDoc(), theme: "nord" })).toBe(false)
  })

  test("endpoint names are unrestricted, endpoint values are not", () => {
    // A differently named endpoint with all-default values is still default.
    expect(
      isDefaultConfig({ ...starterConfigDoc(), endpoints: { openai: { baseURL: "https://api.openai.com/v1", apiKey: "" } } }),
    ).toBe(true)
    // A missing apiKey counts as "".
    expect(
      isDefaultConfig({ ...starterConfigDoc(), endpoints: { main: { baseURL: "https://api.openai.com/v1" } } }),
    ).toBe(true)
    // A changed key or baseURL is a real edit.
    expect(
      isDefaultConfig({ ...starterConfigDoc(), endpoints: { main: { baseURL: "https://api.openai.com/v1", apiKey: "sk-x" } } }),
    ).toBe(false)
    expect(
      isDefaultConfig({ ...starterConfigDoc(), endpoints: { main: { baseURL: "https://other/v1", apiKey: "" } } }),
    ).toBe(false)
  })

  test("a changed model, agent or approval is not default", () => {
    expect(isDefaultConfig({ ...starterConfigDoc(), model: "main@gpt-4" })).toBe(false)
    expect(isDefaultConfig({ ...starterConfigDoc(), agent: "reviewer" })).toBe(false)
    expect(isDefaultConfig({ ...starterConfigDoc(), approval: "yolo" })).toBe(false)
  })

  test("extra top-level keys and per-endpoint keys are not default", () => {
    expect(isDefaultConfig({ ...starterConfigDoc(), mcp: { servers: {} } })).toBe(false)
    expect(isDefaultConfig({ ...starterConfigDoc(), note: "hi" })).toBe(false)
    expect(
      isDefaultConfig({
        ...starterConfigDoc(),
        endpoints: {
          main: { baseURL: "https://api.openai.com/v1", apiKey: "", models: { "gpt-5": { contextLimit: 1 } } },
        },
      }),
    ).toBe(false)
  })

  test("a default provider key is still default; a real protocol or mock is not", () => {
    const docWithProvider = (provider: string): RawConfigDoc => ({
      ...starterConfigDoc(),
      endpoints: { main: { baseURL: "https://api.openai.com/v1", apiKey: "", provider } },
    })
    expect(isDefaultConfig(docWithProvider("openai-compatible"))).toBe(true)
    // The legacy spelling means the same protocol.
    expect(isDefaultConfig(docWithProvider("http"))).toBe(true)
    expect(isDefaultConfig(docWithProvider("anthropic"))).toBe(false)
    expect(isDefaultConfig(docWithProvider("mock"))).toBe(false)
    expect(isDefaultConfig(docWithProvider("wat"))).toBe(false)
  })

  test("malformed input never throws and is not default", () => {
    expect(isDefaultConfig({ endpoints: "nope" })).toBe(false)
    expect(isDefaultConfig({ endpoints: { main: 5 } })).toBe(false)
    expect(isDefaultConfig({ theme: 123 })).toBe(false)
  })
})

describe("wizard endpoint fields", () => {
  test("field order is the browse/edit order (provider first)", () => {
    expect(ENDPOINT_FIELDS).toEqual(["provider", "name", "baseURL", "apiKey"])
  })

  test("endpointFieldValue reads each field and withEndpointField copies without mutating", () => {
    const ep: EndpointDraft = { provider: "anthropic", name: "main", baseURL: "https://x/v1", apiKey: "sk-a" }
    expect(ENDPOINT_FIELDS.map((f) => endpointFieldValue(ep, f))).toEqual(["anthropic", "main", "https://x/v1", "sk-a"])
    const next = withEndpointField(ep, "baseURL", "https://new/v1")
    expect(next).toEqual({ provider: "anthropic", name: "main", baseURL: "https://new/v1", apiKey: "sk-a" })
    expect(ep.baseURL).toBe("https://x/v1")
    expect(withEndpointField(ep, "name", "renamed").name).toBe("renamed")
    expect(withEndpointField(ep, "apiKey", "").apiKey).toBe("")
    // The provider field canonicalizes: legacy "http" → the default, unknown keeps the current kind.
    expect(withEndpointField(ep, "provider", "http").provider).toBe("openai-compatible")
    expect(withEndpointField(ep, "provider", "google").provider).toBe("google")
    expect(withEndpointField(ep, "provider", "wat").provider).toBe("anthropic")
  })

  test("withProvider moves an empty/other-default baseURL and preserves a custom one", () => {
    const base: EndpointDraft = {
      provider: "openai-compatible",
      name: "main",
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
    }
    // Another protocol's default is replaced by the new protocol's default.
    const anthro = withProvider(base, "anthropic")
    expect(anthro.provider).toBe("anthropic")
    expect(anthro.baseURL).toBe("https://api.anthropic.com/v1")
    // Empty baseURL fills the new default.
    expect(withProvider({ ...base, baseURL: "" }, "google").baseURL).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    )
    // A custom baseURL is preserved.
    expect(withProvider({ ...base, baseURL: "https://proxy.example/v1" }, "anthropic").baseURL).toBe(
      "https://proxy.example/v1",
    )
    // Same kind is a no-op (the SAME object).
    expect(withProvider(base, "openai-compatible")).toBe(base)
  })
})

describe("wizard validation", () => {
  test("endpoint name: required, no @, no duplicate (unless editing it)", () => {
    expect(validateEndpointName("main")).toBeNull()
    expect(validateEndpointName("   ")).toContain("required")
    expect(validateEndpointName("a@b")).toContain('"@"')
    expect(validateEndpointName("openai", ["openai"])).toContain("already exists")
    expect(validateEndpointName("openai", ["openai"], { allow: "openai" })).toBeNull()
  })

  test("baseURL must be a non-empty http(s) URL (validateDraft allows empty)", () => {
    expect(validateBaseURLInput("https://api.openai.com/v1")).toBeNull()
    expect(validateBaseURLInput("http://localhost:11434/v1")).toBeNull()
    expect(validateBaseURLInput("")).not.toBeNull()
    expect(validateBaseURLInput("ftp://x")).not.toBeNull()
    expect(validateBaseURLInput("not a url")).not.toBeNull()
    // An empty draft baseURL resolves to the protocol default and is valid.
    expect(validateDraft(draft({ endpoint: { baseURL: "" }, model: "m" }))).toBeNull()
    expect(validateDraft(draft({ endpoint: { baseURL: "   " }, model: "m" }))).toBeNull()
  })

  test("whole-draft validation catches each missing piece", () => {
    expect(validateDraft(draft({ model: "gpt-5" }))).toBeNull()
    expect(validateDraft(draft({ endpoint: { name: "", baseURL: "https://x/v1", apiKey: "" }, model: "m" }))).toContain(
      "required",
    )
    expect(validateDraft(draft({ endpoint: { name: "main", baseURL: "bad", apiKey: "" }, model: "m" }))).not.toBeNull()
    expect(validateDraft(draft({ model: "" }))).toContain("model is required")
    expect(validateDraft(draft({ model: "m", theme: "nope" }))).toContain("unknown theme")
  })

  test("existing endpoint names are read defensively", () => {
    const doc: RawConfigDoc = { endpoints: { a: {}, b: {} } }
    expect(existingEndpointNames(doc).sort()).toEqual(["a", "b"])
    expect(existingEndpointNames(null)).toEqual([])
    expect(existingEndpointNames({ endpoints: "nope" })).toEqual([])
  })
})

describe("wizard draft preloading", () => {
  test("defaults are neutral", () => {
    const d = defaultDraft()
    expect(d.endpoint.provider).toBe("openai-compatible")
    expect(d.endpoint.name).toBe("main")
    expect(d.endpoint.baseURL).toBe("https://api.openai.com/v1")
    expect(d.model).toBe("")
    expect(d.theme).toBe("terminal")
    expect(d.seedHost).toBe(false)
  })

  test("draftFromConfig preloads the selected endpoint, model and theme", () => {
    const doc: RawConfigDoc = {
      model: "openrouter@anthropic/claude",
      endpoints: {
        openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-a" },
        openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-or" },
      },
      theme: "nord",
    }
    const d = draftFromConfig(doc)
    expect(d.endpoint).toEqual({
      provider: "openai-compatible",
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "sk-or",
    })
    expect(d.model).toBe("anthropic/claude")
    expect(d.theme).toBe("nord")
  })

  test("draftFromConfig canonicalizes the provider (kind, legacy http, mock, unknown)", () => {
    const providerOf = (provider: unknown): string =>
      draftFromConfig({ endpoints: { a: { baseURL: "https://x/v1", provider } } }).endpoint.provider
    expect(providerOf("anthropic")).toBe("anthropic")
    expect(providerOf("openai-responses")).toBe("openai-responses")
    expect(providerOf("google")).toBe("google")
    expect(providerOf("mock")).toBe("mock")
    expect(providerOf("http")).toBe("openai-compatible")
    expect(providerOf("wat")).toBe("openai-compatible")
    expect(providerOf(undefined)).toBe("openai-compatible")
  })

  test("draftFromConfig falls back to the first endpoint and defaults on bad data", () => {
    const d = draftFromConfig({ endpoints: { only: { baseURL: "http://localhost/v1" } } })
    expect(d.endpoint.name).toBe("only")
    expect(d.endpoint.baseURL).toBe("http://localhost/v1")
    expect(d.model).toBe("")
    expect(d.theme).toBe("terminal")
    expect(draftFromConfig(null)).toEqual(defaultDraft())
  })
})

describe("wizard config document", () => {
  const existing: RawConfigDoc = {
    model: "main@gpt-5",
    note: "keep me",
    endpoints: {
      main: { baseURL: "https://old/v1", apiKey: "old", models: { "gpt-5": { contextLimit: 400000 } } },
      other: { baseURL: "https://other/v1" },
    },
    mcp: { servers: { x: { command: "x" } } },
  }

  test("merge preserves unknown top-level keys, other endpoints and per-endpoint metadata", () => {
    const next = buildConfigDoc(
      existing,
      draft({ endpoint: { name: "main", baseURL: "https://new/v1", apiKey: "new" }, model: "gpt-5", theme: "dark" }),
      "merge",
    )
    expect(next["note"]).toBe("keep me")
    expect(next["mcp"]).toEqual({ servers: { x: { command: "x" } } })
    const eps = next["endpoints"] as Record<string, Record<string, unknown>>
    expect(Object.keys(eps).sort()).toEqual(["main", "other"])
    expect(eps["main"]?.["baseURL"]).toBe("https://new/v1")
    expect(eps["main"]?.["apiKey"]).toBe("new")
    // Unknown endpoint keys (model overrides) survive the merge.
    expect(eps["main"]?.["models"]).toEqual({ "gpt-5": { contextLimit: 400000 } })
    expect(eps["other"]?.["baseURL"]).toBe("https://other/v1")
    expect(next["model"]).toBe("main@gpt-5")
    expect(next["theme"]).toBe("dark")
    // The original object is not mutated.
    expect((existing.endpoints as Record<string, Record<string, unknown>>)["main"]?.["baseURL"]).toBe("https://old/v1")
  })

  test("merge can add a brand-new endpoint", () => {
    const next = buildConfigDoc(
      existing,
      draft({ endpoint: { name: "ollama", baseURL: "http://localhost:11434/v1", apiKey: "" }, model: "llama3" }),
      "merge",
    )
    const eps = next["endpoints"] as Record<string, Record<string, unknown>>
    expect(eps["ollama"]).toEqual({ baseURL: "http://localhost:11434/v1", apiKey: "" })
    expect(next["model"]).toBe("ollama@llama3")
  })

  test("fresh folds in the --create-config starter keys and replaces endpoints", () => {
    const next = buildConfigDoc(
      existing,
      draft({ endpoint: { name: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-x" }, model: "gpt-5", theme: "gruvbox-dark" }),
      "fresh",
    )
    expect(next["agent"]).toBe("copilot")
    expect(next["approval"]).toBe("confirm")
    expect(next["endpoints"]).toEqual({ openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-x" } })
    expect(next["model"]).toBe("openai@gpt-5")
    expect(next["theme"]).toBe("gruvbox-dark")
    expect(next["note"]).toBeUndefined()
    expect(next["mcp"]).toBeUndefined()
  })

  test("a non-default provider persists (fresh + merge); the default is omitted", () => {
    const fresh = buildConfigDoc(
      null,
      draft({ endpoint: { provider: "anthropic", baseURL: "https://api.anthropic.com/v1" }, model: "claude" }),
      "fresh",
    )
    expect((fresh["endpoints"] as Record<string, Record<string, unknown>>)["main"]).toEqual({
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "",
      provider: "anthropic",
    })

    const merged = buildConfigDoc(
      existing,
      draft({ endpoint: { provider: "mock", baseURL: "http://localhost/v1" }, model: "m" }),
      "merge",
    )
    expect((merged["endpoints"] as Record<string, Record<string, unknown>>)["main"]?.["provider"]).toBe("mock")

    const defaulted = buildConfigDoc(
      existing,
      draft({ endpoint: { provider: "openai-compatible", baseURL: "https://api.openai.com/v1" }, model: "m" }),
      "merge",
    )
    expect(
      (defaulted["endpoints"] as Record<string, Record<string, unknown>>)["main"]?.["provider"],
    ).toBeUndefined()
  })

  test("merge CLEARS a previous provider when switching back to the default", () => {
    const anthro = buildConfigDoc(
      existing,
      draft({ endpoint: { provider: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKey: "k" }, model: "m" }),
      "merge",
    )
    expect((anthro["endpoints"] as Record<string, Record<string, unknown>>)["main"]?.["provider"]).toBe("anthropic")

    const back = buildConfigDoc(
      anthro,
      draft({ endpoint: { provider: "openai-compatible", baseURL: "https://api.openai.com/v1" }, model: "m" }),
      "merge",
    )
    const main = (back["endpoints"] as Record<string, Record<string, unknown>>)["main"]
    expect(main?.["provider"]).toBeUndefined()
    expect(main?.["baseURL"]).toBe("https://api.openai.com/v1")
    // Unknown endpoint keys (per-model metadata) survive both passes.
    expect(main?.["models"]).toEqual({ "gpt-5": { contextLimit: 400000 } })
  })

  test("an empty model leaves the existing selection untouched", () => {
    const next = buildConfigDoc(existing, draft({ endpoint: { name: "main", baseURL: "https://new/v1", apiKey: "" }, model: "" }), "merge")
    expect(next["model"]).toBe("main@gpt-5")
  })
})

describe("wizard model selection", () => {
  const models = [makeModel("gpt-5"), makeModel("text-embedding-3", false), makeModel("o3-mini")]

  test("chatModels prefers chat-capable, falls back to all", () => {
    expect(chatModels(models).map((m) => m.id)).toEqual(["gpt-5", "o3-mini"])
    expect(chatModels([models[1] as EndpointModel]).map((m) => m.id)).toEqual(["text-embedding-3"])
  })

  test("rankModels keeps source order for an empty query and ranks fuzzy hits", () => {
    expect(rankModels(models, "").map((m) => m.id)).toEqual(["gpt-5", "text-embedding-3", "o3-mini"])
    expect(rankModels(models, "o3").map((m) => m.id)).toEqual(["o3-mini"])
    expect(rankModels(models, "zzz")).toEqual([])
  })

  test("resolveModelChoice picks the highlighted row or the typed id", () => {
    const ranked = rankModels(models, "")
    expect(resolveModelChoice(ranked, 1, "")).toBe("text-embedding-3")
    expect(resolveModelChoice([], 0, "my-private-model")).toBe("my-private-model")
    expect(resolveModelChoice([], 0, "   ")).toBeNull()
  })
})

describe("wizard theme selection", () => {
  test("normalizeTheme accepts built-ins only", () => {
    expect(WIZARD_THEMES.length).toBeGreaterThan(0)
    expect(normalizeTheme("nord")).toBe("nord")
    expect(normalizeTheme("terminal")).toBe("terminal")
    expect(normalizeTheme("hotdog")).toBeNull()
  })

  test("rankThemes filters by fuzzy name and keeps registry order for an empty query", () => {
    expect(rankThemes(WIZARD_THEMES, "")).toEqual([...WIZARD_THEMES])
    expect(rankThemes(WIZARD_THEMES, "gruv")[0]).toBe("gruvbox-dark")
    expect(rankThemes(WIZARD_THEMES, "catppuccin")).toHaveLength(4)
    expect(rankThemes(WIZARD_THEMES, "zzz")).toEqual([])
  })
})

describe("wizard host-scan seed", () => {
  test("capSeedContent truncates with an explicit marker", () => {
    expect(capSeedContent("short", 100)).toBe("short")
    const big = "x".repeat(200)
    const capped = capSeedContent(big, 80)
    expect(capped.length).toBeLessThanOrEqual(80)
    expect(capped).toContain("truncated")
  })

  test("planHostSeed: declined, never clobbers existing, else writes capped draft", () => {
    expect(planHostSeed({ requested: false, existing: null, draft: "d", limit: 100 })).toEqual({
      write: false,
      content: "",
      reason: "declined",
    })
    expect(planHostSeed({ requested: true, existing: "# existing\n", draft: "d", limit: 100 })).toEqual({
      write: false,
      content: "",
      reason: "existing",
    })
    const plan = planHostSeed({ requested: true, existing: null, draft: "# draft\n", limit: 100 })
    expect(plan.write).toBe(true)
    expect(plan.content).toBe("# draft")
    expect(planHostSeed({ requested: true, existing: "   ", draft: "d", limit: 100 }).write).toBe(true)
  })

})
