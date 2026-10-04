/**
 * Provider protocol mapping tests (docs/agent.md "Provider client" /
 * "Provider selection" / "Thinking modes"; docs/config.md "Endpoints and the
 * selected model"): canonical kind parsing, per-protocol default baseURLs,
 * AI SDK model construction, and the reasoning/provider-option shapes for
 * every protocol. Pure unit tests — no network.
 */

import { describe, expect, test } from "bun:test"
import {
  PROTOCOLS,
  PROTOCOL_KINDS,
  canonicalProvider,
  compatibleThinkingProviderOptions,
  createLanguageModel,
  isProtocolKind,
  protocolRequestOptions,
  reasoningArgs,
  resolveBaseURL,
  type ProtocolKind,
} from "../../../../src/agent/provider/protocols.ts"

/** The SDK's model objects expose provider/modelId; the union hides them. */
function modelInfo(m: ReturnType<typeof createLanguageModel>): { provider: string; modelId: string } {
  return m as unknown as { provider: string; modelId: string }
}

describe("canonicalProvider / isProtocolKind / resolveBaseURL", () => {
  test("canonical kinds and the legacy http alias parse; unknown values are null", () => {
    expect(canonicalProvider("openai-compatible")).toBe("openai-compatible")
    expect(canonicalProvider("openai-responses")).toBe("openai-responses")
    expect(canonicalProvider("anthropic")).toBe("anthropic")
    expect(canonicalProvider("google")).toBe("google")
    expect(canonicalProvider("mock")).toBe("mock")
    // Legacy spelling canonicalizes (no warning at the resolver).
    expect(canonicalProvider("http")).toBe("openai-compatible")
    expect(canonicalProvider(" http ")).toBe("openai-compatible")
    for (const bad of [undefined, null, 42, "", "wat", "HTTP"]) {
      expect(canonicalProvider(bad)).toBeNull()
    }
    expect(isProtocolKind("google")).toBe(true)
    expect(isProtocolKind("openai-responses")).toBe(true)
    expect(isProtocolKind("mock")).toBe(false)
    expect(isProtocolKind("http")).toBe(false)
  })

  test("resolveBaseURL: empty/missing falls back to the protocol default; explicit URLs are trimmed", () => {
    expect(resolveBaseURL("openai-compatible", undefined)).toBe("https://api.openai.com/v1")
    expect(resolveBaseURL("openai-responses", "")).toBe("https://api.openai.com/v1")
    expect(resolveBaseURL("anthropic", "   ")).toBe("https://api.anthropic.com/v1")
    expect(resolveBaseURL("google", undefined)).toBe("https://generativelanguage.googleapis.com/v1beta")
    expect(resolveBaseURL("anthropic", "http://localhost:9999/v1/")).toBe("http://localhost:9999/v1")
    expect(resolveBaseURL("google", " https://proxy.example/api// ")).toBe("https://proxy.example/api")
  })

  test("PROTOCOLS metadata: display order, labels, env hints, models.dev ids", () => {
    expect(PROTOCOL_KINDS).toEqual(["openai-compatible", "openai-responses", "anthropic", "google"])
    expect(PROTOCOLS["openai-compatible"].label).toBe("OpenAI-compatible")
    expect(PROTOCOLS["openai-responses"].label).toBe("OpenAI (Responses)")
    expect(PROTOCOLS.anthropic.label).toBe("Anthropic")
    expect(PROTOCOLS.google.label).toBe("Google Gemini")
    expect(PROTOCOLS["openai-compatible"].apiKeyEnv).toBe("OPENAI_API_KEY")
    expect(PROTOCOLS.anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY")
    expect(PROTOCOLS.google.apiKeyEnv).toBe("GOOGLE_GENERATIVE_AI_API_KEY")
    expect(PROTOCOLS["openai-compatible"].modelsDevProvider).toBeNull()
    expect(PROTOCOLS["openai-responses"].modelsDevProvider).toBe("openai")
    expect(PROTOCOLS.anthropic.modelsDevProvider).toBe("anthropic")
    expect(PROTOCOLS.google.modelsDevProvider).toBe("google")
  })
})

describe("createLanguageModel", () => {
  test("each protocol constructs a real AI SDK model with the expected provider/modelId", () => {
    const headers = { "x-extra": "1" }
    const compat = createLanguageModel("openai-compatible", { baseURL: "https://example.test/v1/", apiKey: "k", headers }, "compat-model")
    const responses = createLanguageModel("openai-responses", { baseURL: "https://example.test/v1", apiKey: "k" }, "responses-model")
    const anthropic = createLanguageModel("anthropic", { baseURL: "https://example.test/v1", apiKey: "k" }, "claude-sonnet-5")
    const google = createLanguageModel("google", { baseURL: "https://example.test/v1", apiKey: "k" }, "gemini-2.5-pro")

    expect(modelInfo(compat)).toMatchObject({ provider: "sensus.chat", modelId: "compat-model" })
    expect(modelInfo(responses)).toMatchObject({ provider: "openai.responses", modelId: "responses-model" })
    expect(modelInfo(anthropic)).toMatchObject({ provider: "anthropic.messages", modelId: "claude-sonnet-5" })
    expect(modelInfo(google)).toMatchObject({ provider: "google.generative-ai", modelId: "gemini-2.5-pro" })
  })

  test("every protocol kind builds a model (constructors accept the creds shape)", () => {
    for (const kind of PROTOCOL_KINDS as readonly ProtocolKind[]) {
      const m = createLanguageModel(kind, { baseURL: PROTOCOLS[kind].defaultBaseURL, apiKey: "", headers: {} }, "m")
      expect(modelInfo(m).modelId).toBe("m")
    }
  })
})

describe("reasoningArgs (per-protocol thinking mapping)", () => {
  test("openai-compatible preserves the legacy exact mapping (reasoningEffort / unified reasoning body)", () => {
    expect(reasoningArgs("openai-compatible", null)).toBeUndefined()
    expect(reasoningArgs("openai-compatible", undefined)).toBeUndefined()
    expect(reasoningArgs("openai-compatible", {})).toBeUndefined()
    expect(reasoningArgs("openai-compatible", { reasoningEffort: "high" })).toEqual({
      providerOptions: { sensus: { reasoningEffort: "high" } },
    })
    expect(reasoningArgs("openai-compatible", { reasoningBudgetTokens: 8192 })).toEqual({
      providerOptions: { sensus: { reasoning: { maxTokens: 8192 } } },
    })
    expect(reasoningArgs("openai-compatible", { reasoningEnabled: false })).toEqual({
      providerOptions: { sensus: { reasoning: { enabled: false } } },
    })
    // The static delegate keeps this exact output (existing callers).
    expect(compatibleThinkingProviderOptions({ reasoningEffort: "max" })).toEqual({ sensus: { reasoningEffort: "max" } })
    expect(compatibleThinkingProviderOptions(null)).toBeUndefined()
    expect(compatibleThinkingProviderOptions({})).toBeUndefined()
  })

  test("openai-responses: unified efforts top-level + summary; custom effort via provider options; budgets approximate; toggle", () => {
    expect(reasoningArgs("openai-responses", { reasoningEffort: "high" })).toEqual({
      reasoning: "high",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    // "none" disables reasoning — nothing to summarize.
    expect(reasoningArgs("openai-responses", { reasoningEffort: "none" })).toEqual({ reasoning: "none" })
    // The top-level union is closed: "max" rides the Responses effort option.
    expect(reasoningArgs("openai-responses", { reasoningEffort: "max" })).toEqual({
      providerOptions: { openai: { reasoningEffort: "max", reasoningSummary: "auto" } },
    })
    // Budget → approximate effort (<4096 low, <16384 medium, else high).
    expect(reasoningArgs("openai-responses", { reasoningBudgetTokens: 2048 })).toEqual({
      reasoning: "low",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    expect(reasoningArgs("openai-responses", { reasoningBudgetTokens: 4095 })).toEqual({
      reasoning: "low",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    expect(reasoningArgs("openai-responses", { reasoningBudgetTokens: 4096 })).toEqual({
      reasoning: "medium",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    expect(reasoningArgs("openai-responses", { reasoningBudgetTokens: 16383 })).toEqual({
      reasoning: "medium",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    expect(reasoningArgs("openai-responses", { reasoningBudgetTokens: 16384 })).toEqual({
      reasoning: "high",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    expect(reasoningArgs("openai-responses", { reasoningEnabled: true })).toEqual({
      reasoning: "medium",
      providerOptions: { openai: { reasoningSummary: "auto" } },
    })
    expect(reasoningArgs("openai-responses", { reasoningEnabled: false })).toEqual({ reasoning: "none" })
    expect(reasoningArgs("openai-responses", {})).toBeUndefined()
  })

  test("anthropic: unified efforts ride the top-level reasoning; custom effort / budget / toggle are thinking options", () => {
    expect(reasoningArgs("anthropic", { reasoningEffort: "medium" })).toEqual({ reasoning: "medium" })
    expect(reasoningArgs("anthropic", { reasoningEffort: "xhigh" })).toEqual({ reasoning: "xhigh" })
    expect(reasoningArgs("anthropic", { reasoningEffort: "max" })).toEqual({
      providerOptions: { anthropic: { effort: "max" } },
    })
    expect(reasoningArgs("anthropic", { reasoningBudgetTokens: 8192 })).toEqual({
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } } },
    })
    expect(reasoningArgs("anthropic", { reasoningEnabled: true })).toEqual({
      providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
    })
    expect(reasoningArgs("anthropic", { reasoningEnabled: false })).toEqual({
      providerOptions: { anthropic: { thinking: { type: "disabled" } } },
    })
    expect(reasoningArgs("anthropic", {})).toBeUndefined()
  })

  test("google: includeThoughts; xhigh/custom coerce to high; budget/toggle", () => {
    expect(reasoningArgs("google", { reasoningEffort: "medium" })).toEqual({
      reasoning: "medium",
      providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
    })
    // Gemini tops out at "high" — xhigh/custom efforts coerce (never dropped).
    expect(reasoningArgs("google", { reasoningEffort: "xhigh" })).toEqual({
      reasoning: "high",
      providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
    })
    expect(reasoningArgs("google", { reasoningEffort: "max" })).toEqual({
      reasoning: "high",
      providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
    })
    expect(reasoningArgs("google", { reasoningBudgetTokens: 12000 })).toEqual({
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 12000, includeThoughts: true } } },
    })
    expect(reasoningArgs("google", { reasoningEnabled: true })).toEqual({
      reasoning: "low",
      providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
    })
    expect(reasoningArgs("google", { reasoningEnabled: false })).toEqual({ reasoning: "none" })
    expect(reasoningArgs("google", {})).toBeUndefined()
  })

  test("protocolRequestOptions: OpenAI Responses opts out of server-side storage; other protocols have none", () => {
    expect(protocolRequestOptions("openai-responses")).toEqual({ openai: { store: false } })
    expect(protocolRequestOptions("openai-compatible")).toBeUndefined()
    expect(protocolRequestOptions("anthropic")).toBeUndefined()
    expect(protocolRequestOptions("google")).toBeUndefined()
  })
})
