/**
 * OpenAPI 3.1 / Scalar configuration for the daemon REST API (docs/daemon-api.md).
 *
 * The daemon serves an interactive Scalar reference at `DOCS_PATH` and the
 * generated JSON spec at `DOCS_SPEC_PATH`. Both are mounted on the same Elysia
 * app that serves the API (`app.ts`) and are generated from the routes'
 * `detail` metadata — there is no hand-maintained spec file. `/openapi*` is
 * exempt from bearer auth (`auth.ts` `isDocsPath`) so a browser can load the UI
 * and its spec; it still binds only the local socket + loopback, never public,
 * and documents no secrets.
 *
 * The Scalar frontend bundle loads from the plugin's default CDN (jsdelivr) as a
 * convenience; the daemon process itself makes no outbound call (D8).
 *
 * `servers` is relative (`/`) so the single entry resolves to whatever origin
 * served the docs — no internal socket path or ephemeral port is baked in.
 * `info.version` is the caller's daemon version, so the spec tracks the build.
 */

import type { ElysiaOpenAPIConfig } from "@elysiajs/openapi"

/** Path of the interactive Scalar UI. */
export const DOCS_PATH = "/openapi"
/** Path of the generated OpenAPI JSON spec (Scalar fetches it from the UI). */
export const DOCS_SPEC_PATH = "/openapi/json"

/**
 * True for any path under the documentation surface. The bearer-auth global
 * hook skips these (a browser cannot attach the token to the initial UI/spec
 * fetch); everything else stays token-gated.
 */
export function isDocsPath(pathname: string): boolean {
  return pathname === DOCS_PATH || pathname.startsWith(`${DOCS_PATH}/`)
}

/**
 * The location to redirect to when a docs URL is requested with a trailing
 * slash, else `null`. Scalar builds its spec URL relative to the page path
 * (`openapi/json`), so `/openapi/` would resolve it to
 * `/openapi/openapi/json` and report the spec as dead; canonicalising to
 * `/openapi` avoids that. The redirect keeps the request's origin, so it still
 * works behind a proxy/port-forward.
 */
export function docsTrailingSlashRedirect(url: URL): string | null {
  if (url.pathname !== `${DOCS_PATH}/`) return null
  const canonical = new URL(url)
  canonical.pathname = DOCS_PATH
  return canonical.toString()
}

const DESCRIPTION =
  "The local management API hosted by `sensus daemon serve` (docs/daemon-api.md). " +
  "Bound to a Unix socket (`daemon.sock`, 0600) and a loopback TCP port only; never public.\n\n" +
  "## Authentication\n\n" +
  "Every route except this documentation surface requires `Authorization: Bearer <token>`, " +
  "where the token is `<runtime-dir>/daemon.token` (mode 0600, regenerated per boot). " +
  "A missing or wrong token is `401 { error: \"unauthorized\" }` with `WWW-Authenticate: Bearer`.\n\n" +
  "## Errors\n\n" +
  "One shape for every failure: `{ \"error\": \"<code>\" }` with `unauthorized` (401), " +
  "`invalid_request` (400), `not_found` (404) or `internal_error` (500). A **store-domain** " +
  "refusal (an over-cap memory write, a safety refusal, an unreadable secrets store) is NOT an " +
  "HTTP error: it is a successful `200 { ok: false, message }` so the caller can render the " +
  "precise reason.\n\n" +
  "## WebSocket channels\n\n" +
  "The terminal and chat channels (`GET /v1/ws`, loopback only) are request/response + event " +
  "framed and are not described here; see docs/daemon-api.md " +
  "\"WebSocket channels — terminal + chat\"."

/** Build the daemon's OpenAPI/Scalar plugin config for a given daemon version. */
export function daemonOpenApiConfig(version: string) {
  return {
    path: DOCS_PATH,
    specPath: DOCS_SPEC_PATH,
    provider: "scalar",
    documentation: {
      info: {
        title: "Sensus daemon API",
        description: DESCRIPTION,
        version,
        license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      },
      servers: [{ url: "/", description: "Relative to this documentation's origin (the local socket or loopback listener)." }],
      tags: [
        { name: "core", description: "Liveness and daemon facts — `GET /v1/health`, `GET /v1/info`." },
        { name: "config", description: "The effective (redacted) config read/write surface, plus stored secret names/values (docs/daemon-api.md)." },
        { name: "agents", description: "Read-only agent definitions from the config home." },
        { name: "skills", description: "Read-only skill index (name/description, no bodies)." },
        { name: "memory", description: "The MEMORY/HOST/JOURNAL stores, read and edited through the same `MemoryStore` the TUI uses." },
        { name: "sessions", description: "Persisted transcript listing, paged reads, context snapshots and export." },
        { name: "audit", description: "The normalized audit log: filtered records, jsonl/csv export and counts." },
        { name: "mcp", description: "Live per-server MCP status facts." },
        { name: "models", description: "The enriched, credential-free model catalog for the picker." },
        { name: "usage", description: "Serializable token-usage roll-ups for the dashboard." },
      ],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "`<runtime-dir>/daemon.token`, written with mode 0600 and regenerated per boot.",
          },
        },
      },
    },
  } satisfies ElysiaOpenAPIConfig<true, "/openapi">
}
