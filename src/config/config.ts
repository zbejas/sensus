/**
 * Configuration: file (~/.config/sensus/config.json) -> env (SENSUS_*) -> CLI
 * flags, per docs/config.md.
 *
 * Model selection (rework): there are no profiles. The config carries a set
 * of ENDPOINTS (provider targets — one of the protocols in
 * agent/provider/protocols.ts, or the mock seam) and ONE global selection
 * `"model": "<endpoint>@<model-id>"`. The /models picker fetches every
 * endpoint's model list over its protocol and writes the pick back to `model`
 * — the last selection survives relaunches. Endpoints may define per-model
 * METADATA OVERRIDES (contextLimit, reasoning, …) that take precedence over
 * the models.dev enrichment; the enrichment remains the fallback.
 *
 * Resolution order (docs/config.md):
 *   1. built-in defaults
 *   2. config file (SENSUS_HOME redirects the location for tests)
 *   3. env: SENSUS_MODEL (endpoint@model or bare model), SENSUS_ENDPOINT,
 *      SENSUS_BASE_URL, SENSUS_APPROVAL
 *      (SENSUS_MOCK=1 is a provider test seam — see docs/config.md)
 *   4. CLI: --model --endpoint --base-url --resume --yolo
 *
 * API keys live in the endpoint's `apiKey` (config.json) — there is no
 * per-endpoint env-var indirection and no global env key fallback.
 * Unknown file keys warn once; an unparseable baseURL sets bootError (the TUI
 * still boots and opens the setup modal to fix it — docs/operations.md).
 * `allowPrefixes` is the persistent always-allow command prefix list
 * (docs/agent.md "Approval modes"); `agent` is the default agent
 * (~/.config/sensus/agents/).
 */

export * from "./config/index.ts"
