/**
 * Provider protocols (docs/agent.md "Provider client" / "Provider selection").
 *
 * This is the ONE place protocol-specific model construction and reasoning
 * mapping live: an endpoint's `provider` kind resolves to an AI SDK language
 * model (OpenAI-compatible chat completions, the OpenAI Responses API,
 * Anthropic, or Google Gemini) and to the protocol-shaped `streamText` options
 * (`reasoning` + `providerOptions`). `provider.ts` (the factory) and
 * `aiSdkProvider.ts` (streaming) stay protocol-agnostic — they only pass the
 * kind through. The legacy config value `"http"` canonicalizes to
 * `"openai-compatible"`, so existing configs keep today's client.
 *
 * Engine-side: never import `src/ui/**` or `@opentui/core` from here.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { JSONValue, LanguageModel } from "ai"
import type { ProviderKind } from "../../config/config/types.ts"
// Type-only (erased at runtime): provider.ts imports functions from here.
import type { ThinkingRequest } from "./provider.ts"

/** A real (non-mock) provider protocol. */
export type ProtocolKind = Exclude<ProviderKind, "mock">

export interface ProtocolInfo {
  kind: ProtocolKind
  /** Friendly label for settings/wizard (e.g. "OpenAI-compatible", "Anthropic", "Google Gemini"). */
  label: string
  /** Default when the endpoint's baseURL is empty. */
  defaultBaseURL: string
  /** Suggested API-key env var name (wizard/settings hints). */
  apiKeyEnv: string
  /** models.dev provider id this protocol's models should pin to (null = provider-agnostic match). */
  modelsDevProvider: string | null
}

/** Display order for pickers/settings (docs/config.md "Endpoints and the selected model"). */
export const PROTOCOL_KINDS: readonly ProtocolKind[] = ["openai-compatible", "openai-responses", "anthropic", "google"]

export const PROTOCOLS: Record<ProtocolKind, ProtocolInfo> = {
  "openai-compatible": {
    kind: "openai-compatible",
    label: "OpenAI-compatible",
    defaultBaseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    modelsDevProvider: null,
  },
  "openai-responses": {
    kind: "openai-responses",
    label: "OpenAI (Responses)",
    defaultBaseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    modelsDevProvider: "openai",
  },
  anthropic: {
    kind: "anthropic",
    label: "Anthropic",
    defaultBaseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelsDevProvider: "anthropic",
  },
  google: {
    kind: "google",
    label: "Google Gemini",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    modelsDevProvider: "google",
  },
}

/** Is `v` one of the real protocol kinds (mock excluded)? */
export function isProtocolKind(v: string): v is ProtocolKind {
  return (PROTOCOL_KINDS as readonly string[]).includes(v)
}

/**
 * Parse a raw config value into a canonical provider kind: the canonical
 * names, the mock test seam, and the legacy `"http"` spelling (which is the
 * OpenAI-compatible chat-completions protocol). Unknown values → null.
 */
export function canonicalProvider(raw: unknown): ProviderKind | null {
  if (typeof raw !== "string") return null
  const v = raw.trim()
  if (v === "http") return "openai-compatible"
  if (v === "mock") return "mock"
  return isProtocolKind(v) ? v : null
}

/** `baseURL || PROTOCOLS[kind].defaultBaseURL`, with whitespace/trailing slashes trimmed. */
export function resolveBaseURL(kind: ProtocolKind, baseURL: string | undefined): string {
  const trimmed = (baseURL ?? "").trim().replace(/\/+$/, "")
  return trimmed.length > 0 ? trimmed : PROTOCOLS[kind].defaultBaseURL
}

/**
 * Build one AI SDK language model for a protocol. `modelId` is the bare model
 * id; `creds.baseURL` is used as given (trailing slashes trimmed here so the
 * per-protocol constructors all see the same normalized URL).
 */
export function createLanguageModel(
  kind: ProtocolKind,
  creds: { baseURL: string; apiKey: string; headers?: Record<string, string> },
  modelId: string,
): LanguageModel {
  const baseURL = creds.baseURL.trim().replace(/\/+$/, "")
  const headers = creds.headers !== undefined && Object.keys(creds.headers).length > 0 ? creds.headers : undefined
  switch (kind) {
    case "openai-compatible":
      return createOpenAICompatible({ name: "sensus", baseURL, apiKey: creds.apiKey, headers, includeUsage: true })(modelId)
    case "openai-responses":
      // Explicitly the Responses API (not the chat-completions path).
      return createOpenAI({ baseURL, apiKey: creds.apiKey, headers }).responses(modelId)
    case "anthropic":
      return createAnthropic({ baseURL, apiKey: creds.apiKey, headers })(modelId)
    case "google":
      return createGoogle({ baseURL, apiKey: creds.apiKey, headers })(modelId)
  }
}

// ---- reasoning mapping ------------------------------------------------------

/**
 * The unified effort vocabulary the AI SDK's top-level `reasoning` accepts.
 * `"xhigh"` is in the union but Google Gemini tops out at `"high"`.
 */
export type UnifiedReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

const UNIFIED_EFFORTS: readonly UnifiedReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"]

function isUnifiedEffort(v: string): v is UnifiedReasoningEffort {
  return (UNIFIED_EFFORTS as readonly string[]).includes(v)
}

/** Approximate a token budget as an effort keyword (docs/agent.md "Thinking modes"). */
function effortFromBudget(tokens: number): UnifiedReasoningEffort {
  if (tokens < 4096) return "low"
  if (tokens < 16384) return "medium"
  return "high"
}

export interface ReasoningArgs {
  /** Top-level streamText reasoning (native protocols; closed union). */
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** streamText providerOptions (exact map). */
  providerOptions?: Record<string, Record<string, JSONValue>>
}

/** The providerOptions key the OpenAI-compatible knobs ride under (== name "sensus"). */
const COMPATIBLE_PROVIDER_KEY = "sensus"

/**
 * The OpenAI-compatible thinking knobs — today's exact wire mapping:
 * an effort keyword as `reasoningEffort`, a token budget as the unified
 * `reasoning: { maxTokens }` body field (OpenRouter-style gateways map it
 * onto Anthropic budget_tokens / Gemini thinkingBudget), and a toggle model as
 * `reasoning: { enabled }`. Unknown provider options are spread into the
 * request body by the AI SDK.
 */
export function compatibleThinkingProviderOptions(
  thinking: ThinkingRequest | null | undefined,
): Record<string, Record<string, JSONValue>> | undefined {
  if (!thinking) return undefined
  const opts: Record<string, JSONValue> = {}
  if (thinking.reasoningEffort !== undefined) opts["reasoningEffort"] = thinking.reasoningEffort
  if (thinking.reasoningBudgetTokens !== undefined) {
    opts["reasoning"] = { maxTokens: thinking.reasoningBudgetTokens }
  }
  if (thinking.reasoningEnabled !== undefined) {
    opts["reasoning"] = { enabled: thinking.reasoningEnabled }
  }
  return Object.keys(opts).length > 0 ? { [COMPATIBLE_PROVIDER_KEY]: opts } : undefined
}

/** OpenAI Responses: effort/reasoningSummary provider options (+ store, see protocolRequestOptions). */
function responsesReasoningArgs(thinking: ThinkingRequest): ReasoningArgs | undefined {
  const openai: Record<string, JSONValue> = {}
  let reasoning: UnifiedReasoningEffort | undefined
  if (thinking.reasoningEffort !== undefined) {
    if (isUnifiedEffort(thinking.reasoningEffort)) {
      reasoning = thinking.reasoningEffort
      // Summaries make the reasoning displayable; "none" has nothing to summarize.
      if (reasoning !== "none") openai["reasoningSummary"] = "auto"
    } else {
      // Closed top-level union (e.g. "max") — pass it as the Responses-specific effort.
      openai["reasoningEffort"] = thinking.reasoningEffort
      openai["reasoningSummary"] = "auto"
    }
  }
  if (thinking.reasoningBudgetTokens !== undefined) {
    reasoning = effortFromBudget(thinking.reasoningBudgetTokens)
    openai["reasoningSummary"] = "auto"
  }
  if (thinking.reasoningEnabled !== undefined) {
    reasoning = thinking.reasoningEnabled ? "medium" : "none"
    if (thinking.reasoningEnabled) openai["reasoningSummary"] = "auto"
    else delete openai["reasoningSummary"]
  }
  const out: ReasoningArgs = {}
  if (reasoning !== undefined) out.reasoning = reasoning
  if (Object.keys(openai).length > 0) out.providerOptions = { openai }
  return reasoning !== undefined || out.providerOptions !== undefined ? out : undefined
}

/** Anthropic: unified efforts ride the top-level reasoning; budgets/toggles are thinking options. */
function anthropicReasoningArgs(thinking: ThinkingRequest): ReasoningArgs | undefined {
  const out: ReasoningArgs = {}
  const anthropic: Record<string, JSONValue> = {}
  if (thinking.reasoningEffort !== undefined) {
    if (isUnifiedEffort(thinking.reasoningEffort)) out.reasoning = thinking.reasoningEffort
    else anthropic["effort"] = thinking.reasoningEffort
  }
  if (thinking.reasoningBudgetTokens !== undefined) {
    anthropic["thinking"] = { type: "enabled", budgetTokens: thinking.reasoningBudgetTokens }
  }
  if (thinking.reasoningEnabled !== undefined) {
    anthropic["thinking"] = { type: thinking.reasoningEnabled ? "adaptive" : "disabled" }
  }
  if (Object.keys(anthropic).length > 0) out.providerOptions = { anthropic }
  return out.reasoning !== undefined || out.providerOptions !== undefined ? out : undefined
}

/** Google: unified efforts ride top-level reasoning; xhigh/custom coerce to "high". */
function googleReasoningArgs(thinking: ThinkingRequest): ReasoningArgs | undefined {
  const out: ReasoningArgs = {}
  const google: Record<string, JSONValue> = {}
  if (thinking.reasoningEffort !== undefined) {
    out.reasoning =
      isUnifiedEffort(thinking.reasoningEffort) && thinking.reasoningEffort !== "xhigh" ? thinking.reasoningEffort : "high"
    google["thinkingConfig"] = { includeThoughts: true }
  }
  if (thinking.reasoningBudgetTokens !== undefined) {
    google["thinkingConfig"] = { thinkingBudget: thinking.reasoningBudgetTokens, includeThoughts: true }
  }
  if (thinking.reasoningEnabled !== undefined) {
    out.reasoning = thinking.reasoningEnabled ? "low" : "none"
    if (thinking.reasoningEnabled) google["thinkingConfig"] = { includeThoughts: true }
    else delete google["thinkingConfig"]
  }
  if (Object.keys(google).length > 0) out.providerOptions = { google }
  return out.reasoning !== undefined || out.providerOptions !== undefined ? out : undefined
}

/**
 * Map the models.dev-resolved thinking knob onto the protocol's streamText
 * options (docs/agent.md "Thinking modes"). Null/undefined thinking → no
 * options; the openai-compatible branch preserves the exact legacy output.
 */
export function reasoningArgs(
  kind: ProtocolKind,
  thinking: ThinkingRequest | null | undefined,
): ReasoningArgs | undefined {
  if (!thinking) return undefined
  switch (kind) {
    case "openai-compatible": {
      const providerOptions = compatibleThinkingProviderOptions(thinking)
      return providerOptions === undefined ? undefined : { providerOptions }
    }
    case "openai-responses":
      return responsesReasoningArgs(thinking)
    case "anthropic":
      return anthropicReasoningArgs(thinking)
    case "google":
      return googleReasoningArgs(thinking)
  }
}

/**
 * Protocol-level request defaults that apply to EVERY request (not only when a
 * thinking mode is set). OpenAI Responses stores responses server-side by
 * default; a local-first client opts out with `store: false`. Callers merge
 * this UNDER the reasoning provider options (reasoning wins on conflict).
 */
export function protocolRequestOptions(kind: ProtocolKind): Record<string, Record<string, JSONValue>> | undefined {
  return kind === "openai-responses" ? { openai: { store: false } } : undefined
}
