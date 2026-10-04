# Providers & models

## Overview

The provider layer turns a configured endpoint into a `ChatProvider` and owns everything on
that seam: the wire protocol, retries, the idle stream timeout, no-tools degradation,
thinking-mode mapping, and model metadata. Endpoints and the selected model are config's
business ([`config.md`](config.md) "Endpoints and the selected model"); this doc owns how the
harness consumes them. The model loop that calls the provider is in
[`agent-loop.md`](agent-loop.md); the tools it streams are in [`agent-tools.md`](agent-tools.md).

## Key files

| File | Purpose |
|---|---|
| `src/agent/provider/provider.ts` | The `ChatProvider`/`StreamRequest`/`StreamResult` seam, `ProviderMessage`, `MockProvider`, and `createProvider` (the factory) |
| `src/agent/provider/protocols.ts` | The ONE protocol seam: `PROTOCOLS` (kinds, default baseURLs, key-env hints, models.dev pins), `createLanguageModel`, `canonicalProvider`, reasoning mapping (`reasoningArgs`) |
| `src/agent/provider/aiSdkProvider.ts` | The real client: Vercel AI SDK streaming, retries, idle timeout, no-tools degradation, content-filter surfacing, usage |
| `src/agent/provider/modelCatalog.ts` | Protocol-aware endpoint model listing, endpoint-native metadata, models.dev enrichment, config overrides, `resolveThinkingKnob` |
| `src/agent/chat/chatHost.ts` | Memoizes one provider per endpoint and revalidates the credential signature on every request |
| `src/agent/processUtil.ts` | `abortableSleep` (retry backoff / stream waits) |
| `src/config/config/resolve.ts` + `src/config/config/types.ts` | Endpoint/model/thinking config parsing ([`config.md`](config.md)) |

## How it works

### The provider seam

The client is built on the **Vercel AI SDK** (`ai`) with one provider package per protocol
kind: `@ai-sdk/openai-compatible` (the default — OpenAI-compatible `/chat/completions`),
`@ai-sdk/openai` (the OpenAI Responses API), `@ai-sdk/anthropic`, and `@ai-sdk/google`
(Gemini). The SDK owns each wire format (chat-completions/Responses schema, `tool_calls`
merge, reasoning deltas, usage), so provider format changes arrive as package updates
rather than sensus patches. `src/agent/provider/protocols.ts` is the single place
protocol-specific model construction and reasoning mapping live; `AiSdkProvider` just
passes the endpoint's kind through.

What sensus keeps on the seam:

- The `ChatProvider` interface is stable: `stream()` never rejects; deltas arrive through
  `onDelta` / `onReasoning` / `onUsage` / `onToolCallDelta`; Esc aborts through the
  AbortSignal (a graceful abort keeps the partial answer, marked "aborted"). `finish`
  reports `stop` / `tool_calls` / `aborted` / `error`, plus `length` when the endpoint hit
  its output cap: a truncated-but-real reply that the durable-summary caller (compaction)
  accepts rather than discards, because its own validity gate decides.
- Wire mapping is the SDK's job (`convertToOpenAICompatibleChatMessages`): tool results
  carry `tool_call_id`; assistant tool calls become
  `tool_calls: [{id, type: "function", function: {name, arguments}}]`. Executed tool
  arguments are the raw streamed string, not a re-serialization.
- `usage` (prompt/completion/total) is tracked from the finish part and pushed through
  `onUsage`, so the status bar's token count updates live. `cachedTokens` is optional and
  only reported when the endpoint provides `prompt_tokens_details.cached_tokens`.

### Protocols & defaults

An omitted or empty endpoint `baseURL` resolves to the protocol's default; requests to
OpenAI Responses always carry `store: false`, so sensus never opts into server-side
response retention.

| `provider` kind | Protocol | Default baseURL | API-key env hint | models.dev pin |
|---|---|---|---|---|
| `openai-compatible` (default; legacy `"http"`) | OpenAI-compatible `/chat/completions` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | provider-agnostic match |
| `openai-responses` | OpenAI Responses API | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `openai` |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `anthropic` |
| `google` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `GOOGLE_GENERATIVE_AI_API_KEY` | `google` |
| `mock` | canned replies (test seam) | — | — | — |

`canonicalProvider` maps the legacy `"http"` spelling to `openai-compatible`; an unknown
kind resolves to null (config validation warns and keeps the default,
`openai-compatible`).

### Retries

429/5xx + network errors honoring `Retry-After` (seconds or an
HTTP-date) and `retry-after-ms` (integer milliseconds; it wins when both are present),
max 3 retries after the first attempt, exponential backoff (base 500ms, capped 8s) with
±25% jitter. The SDK's own retry is disabled (`maxRetries: 0`) so the policy lives in one
place. Only a stream that produced no VISIBLE content (text, tool input, or a completed
call) is retried; reasoning alone does not block the retry (the consumer discards it
via `onStreamRestart`), while a failure after visible content arrived surfaces as the
normal error bubble. A provider context-overflow error is never retried here — it
takes the single compact-and-retry path in `ChatSession`. Aborted generations never retry.
A provider-supplied `Retry-After` delay is honored verbatim, capped at 30s, and never
jittered.

### Idle stream timeout

The stream is guarded by an idle deadline — the caller's signal
combined with a timer via `AbortSignal.any` — that resets on every streamed part, so a
half-open connection or a server that accepts then never emits cannot hang the turn.
Default **120000 ms**; `SENSUS_STREAM_TIMEOUT_MS` (invalid ignored, `0` disables) or the
`streamTimeoutMs` option overrides it. A timeout before any visible content (reasoning
alone does not count) is treated as a retryable network error (the backoff above); a
post-visible-content stall surfaces as the normal error bubble; a user Esc still returns
`aborted`.

### No-tools degradation (openai-compatible only)

A 400 whose body mentions tools/functions triggers one immediate retry without `tools`;
the SESSION then latches
(`StreamRequest.noTools`) so later requests omit tools from the start. The latch is
per-`ChatSession`, not per-provider — one tab's tools-rejection cannot disable tools for
another tab or model that shares the memoized per-endpoint provider. 400s about the
request's schema are excluded (they mention "tool" only because the broken field
did). Native protocols (Responses/Anthropic/Google) surface the error instead — no
tool-less retry and no latch. The user-facing behavior of a latched session (copy-paste
guidance, the status-bar marker) is in [`agent-loop.md`](agent-loop.md) "No-tools
degradation".

### Content filter

A `content-filter` finish surfaces as `finish:"error"` with "the
provider stopped the response with a content filter" — never a silent stop — and is not
retried.

### Thinking modes

Reasoning models get a per-session thinking mode resolved against the model's metadata.
Precedence is **config override > endpoint `/models` report (Anthropic
`capabilities`, Gemini limits) > models.dev** — the endpoint's
`endpoints.<name>.models.<id>` override wins per field, and the endpoint's own report
wins per field over the models.dev entry (`reasoning` + `reasoning_options`; see
[`config.md`](config.md) "Model metadata overrides").

| Mode | Wire knob |
|---|---|
| unset (no `/effort`, no endpoint `thinkingMode`) | the model's **highest** advertised setting: top effort, `budget:<max>`, or reasoning on for a toggle — nothing when the model advertises no knob |
| effort keyword (`low`…`xhigh`, `minimal`, …) | OpenAI-style `reasoning_effort` |
| `budget:<n>` | unified `reasoning: { max_tokens }` body field (clamped to the model's advertised min/max) |
| `off` | the lowest advertised effort (`none`/`minimal`), or the reasoning-off toggle for a toggle-only model |

The metadata is the single source of truth: choices **mirror** it (advertised effort
values, budget presets for a budget model, `off`/`on` for a toggle-only model) — there is
no synthetic `default`/keyword list, and a model with no metadata exposes no choices at all
(set one explicitly with `/effort <mode>`). An unset mode defaults to the model's **highest**
advertised setting, so a reasoning model actually reasons (and a knob-requiring gateway
gets one); an explicit choice is always sent even when the metadata does not list it.
Selection surfaces: `/effort [<mode>]` (no arg lists the choices), the status-bar `think:`
chip (shown for known reasoners or when a mode is set; click cycles the advertised choices),
and the endpoint's `thinkingMode` config as the fallback default. Changing the mode is
silent — the status chip updates in place, so no toast is raised. The resolved knob rides
`StreamRequest.thinking` and is mapped per protocol by `src/agent/provider/protocols.ts`
(`reasoningArgs`): unified effort keywords ride the AI SDK's top-level `reasoning`;
Anthropic budgets/toggles become `thinking` provider options; Gemini budgets/toggles
become `thinkingConfig` (`includeThoughts`); OpenAI Responses approximates a budget to an
effort (and always sends `store: false`); openai-compatible keeps the legacy
`reasoningEffort` / unified `reasoning` body fields. Models marked `temperature: false`
also omit the request temperature. Reasoning **display** is the separate `/thinking`
toggle ([`agent-prompt.md`](agent-prompt.md) "Thinking blocks").

### Provider selection

The factory picks the provider for the selected endpoint:

- endpoint `provider: "mock"` → `MockProvider` (canned replies);
- env `SENSUS_MOCK=1` forces the mock regardless (test seam);
- otherwise the real `AiSdkProvider` over the endpoint's protocol kind —
  `"openai-compatible"` (the default; the legacy `"http"` canonicalizes to it),
  `"openai-responses"`, `"anthropic"`, or `"google"` — with its baseURL + API key.
  `protocols.ts` constructs the matching language model (or applies the protocol's
  default baseURL when the endpoint omits one).

`ChatHost` memoizes one provider per endpoint, recording the credential signature (kind ·
baseURL · API key). `/reload` and any config write that goes through it swap the config,
and the next request revalidates the signature and rebuilds the client when it changed.
Editing credentials therefore takes effect without a restart; an unrelated reload reuses
the existing client.

### Selected model

Endpoints + the `model` key are config's business ([`config.md`](config.md) "Endpoints and
the selected model"). `/model <endpoint>@<id>` (or a bare `<id>` for the current endpoint)
applies the pick to the current session and persists it as the default for new sessions;
`/model` alone and `/models` open the picker. The change takes effect on the next request,
toasts, and leaves other open tabs untouched. A session's model is latched when the session
is created, so a config-default change (a pick elsewhere, a settings write, `/reload`)
reaches new sessions only.

### Model catalog & models.dev

`src/agent/provider/modelCatalog.ts` builds the picker's model list and the metadata the
harness resolves against:

- `fetchModels` is protocol-aware: OpenAI-compatible/Responses GET `{baseURL}/models`
  (Bearer auth), Anthropic GETs `{baseURL}/models?limit=1000` (`x-api-key` +
  `anthropic-version`), Gemini GETs `{baseURL}/models?pageSize=1000` (`x-goog-api-key`)
  and strips the `models/` id prefix. It flags chat-capable vs embeddings-only models so
  chat pickers can exclude the latter.
- Endpoint-native metadata (Anthropic capabilities, Gemini limits) is parsed onto
  `EndpointModel.nativeMeta`; `mergeNativeMeta` layers it per field OVER models.dev, and a
  config override wins over both.
- `enrichModels` looks each endpoint model id up against the models.dev index
  (`https://models.dev/api.json`) with provider-agnostic normalization (provider path
  prefixes, `:latest`, dot/dash/underscore equivalence). Enrichment adds display name,
  context/input/output limits, tool-call support, vision modality, and cost; unmatched
  models keep null limits ("unknown").
- The index is cached at `$SENSUS_CACHE_DIR`/`~/.cache/sensus/models-dev.json` with a 24h
  TTL; a stale cache is used immediately while a background refetch runs. Everything times
  out and never throws — the TUI must not block or crash on network problems.
- `resolveThinkingKnob` resolves the per-model reasoning knob used by the thinking modes
  above.

## Gotchas & invariants

- **Provider memoization keys on credentials** (kind · baseURL · key), not just the
  endpoint name; otherwise an edited key would reuse a stale client.
- **The no-tools latch is per-`ChatSession`**, not per-provider — a tools-rejection in one
  tab must not disable tools for another tab sharing the memoized endpoint provider.
- **Only a stream with no visible content is retried**; reasoning alone is discarded via
  `onStreamRestart` (the consumer clears the answer-less reasoning bubble in place), while
  a failure after visible content surfaces as the error bubble.
- **OpenAI Responses always sends `store: false`** — no server-side response retention.
- **A context-overflow error is never retried on this seam** — `ChatSession` owns the
  single compact-and-retry path ([`agent-context.md`](agent-context.md)).
- **The tool-spec token estimate is computed from the real specs** (`TOOL_SPEC_TOKENS`,
  `src/agent/chat/compaction.ts`), not a constant — see
  [`agent-context.md`](agent-context.md) "Estimates".
- **Reasoning display is separate from the thinking mode**: `/effort` selects the wire
  knob; `/thinking` controls whether reasoning renders ([`agent-prompt.md`](agent-prompt.md)).

## Related docs

- [`agent.md`](agent.md) — the harness hub
- [`agent-loop.md`](agent-loop.md) — the tool loop that drives the provider
- [`agent-context.md`](agent-context.md) — compaction estimates and overflow recovery
- [`agent-prompt.md`](agent-prompt.md) — streaming and thinking display
- [`config.md`](config.md) — endpoints, model metadata overrides, `thinkingMode`, secrets
- [`logging.md`](logging.md) — `agent.provider` log component
