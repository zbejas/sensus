/**
 * Settings writes (P4c-ii; docs/daemon-api.md "Settings writes").
 *
 * The daemon owns config + secrets (D13). These routes give a remote client
 * write parity with the settings screen WITHOUT ever persisting a secret in
 * `config.json`:
 *
 *   PUT    /v1/config    apply a config PATCH (deep-merged into the raw doc)
 *   GET    /v1/secrets   list stored secret NAMES (never values)
 *   POST   /v1/secrets   set one `${NAME}` value in the encrypted store
 *   DELETE /v1/secrets   remove one name (?name= or JSON `{name}`)
 *
 * Write semantics:
 *   - The body is a top-level PATCH, deep-merged into the RAW document
 *     (`readRawConfig`), so unknown keys survive; objects merge, arrays and
 *     scalars replace, and a `null` deletes the key. Prototype keys are dropped.
 *   - A `<redacted>` placeholder echoed from `GET /v1/config` is restored to
 *     the existing credential (or removed) — a client can never overwrite a
 *     stored secret with the redaction marker.
 *   - Every literal credential in the merged doc is moved into the encrypted
 *     store and replaced with a `${NAME}` reference (`captureSecrets`), so a
 *     typed API key is never written in the clear (docs/config.md "Secrets").
 *   - Writes are atomic + one-time `.bak` via the same `configFile` path the
 *     TUI uses; a failed write applies nothing and returns `{ok:false,message}`.
 *
 * Structurally bad input is `400 {error:"invalid_request"}`. A store-domain
 * refusal (an unreadable secrets store) is a `200 {ok:false,message}` so the
 * client renders the precise reason, matching the memory resource.
 */

import { Elysia, t } from "elysia"
import { isRecord } from "../core/util.ts"
import type { Logger } from "../core/log.ts"
import { componentLogger } from "./log.ts"
import { logStrictEnabled } from "./logStrict.ts"
import { configPath } from "../engine/index.ts"
import { readRawConfig, writeRawConfig, type RawConfigDoc } from "../config/configFile.ts"
import { captureSecrets, deleteSecret, loadSecrets, setSecret } from "../config/secrets.ts"
import { REDACTED } from "./config.ts"
import {
  configWriteResponseSchema,
  invalidRequestResponse,
  jsonResponse,
  rawConfigResponseSchema,
  requestBody,
  secretDeleteResponseSchema,
  secretWriteResponseSchema,
  secretsResponseSchema,
  unauthorizedResponse,
} from "./apiSchemas.ts"

/** Secret names accepted from the wire (matches the `${NAME}` grammar). */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Module-level child logger for the settings routes (component `daemon.settings`). */
const log: Logger = componentLogger("daemon.settings")

/** Keys that must never be written through a patch (prototype pollution). */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value)
}

function invalid(set: { status?: number | string }): { error: string } {
  set.status = 400
  return { error: "invalid_request" }
}

/**
 * Deep-merge `patch` into `base` (a new object; `base` is not mutated):
 * plain objects merge recursively, arrays/scalars replace, `null` deletes.
 */
export function mergeConfigPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (DANGEROUS_KEYS.has(key)) continue
    if (value === null) {
      delete out[key]
      continue
    }
    const existing = out[key]
    if (isPlainRecord(value) && isPlainRecord(existing)) out[key] = mergeConfigPatch(existing, value)
    else out[key] = value
  }
  return out
}

/** Put back the base credential where the merged doc carries `<redacted>`. */
function restoreRedacted(base: Record<string, unknown>, merged: Record<string, unknown>): void {
  const baseEndpoints = isPlainRecord(base["endpoints"]) ? base["endpoints"] : {}
  const mergedEndpoints = isPlainRecord(merged["endpoints"]) ? merged["endpoints"] : {}
  for (const [name, ep] of Object.entries(mergedEndpoints)) {
    if (!isPlainRecord(ep)) continue
    if (ep["apiKey"] !== REDACTED) continue
    const prior = isPlainRecord(baseEndpoints[name]) ? baseEndpoints[name]["apiKey"] : undefined
    if (typeof prior === "string") ep["apiKey"] = prior
    else delete ep["apiKey"]
  }

  const baseMcp = isPlainRecord(base["mcp"]) ? base["mcp"] : {}
  const mergedMcp = isPlainRecord(merged["mcp"]) ? merged["mcp"] : {}
  const baseServers = isPlainRecord(baseMcp["servers"]) ? baseMcp["servers"] : {}
  const mergedServers = isPlainRecord(mergedMcp["servers"]) ? mergedMcp["servers"] : {}
  for (const [name, server] of Object.entries(mergedServers)) {
    if (!isPlainRecord(server)) continue
    const priorServer = isPlainRecord(baseServers[name]) ? baseServers[name] : {}
    for (const field of ["env", "headers"] as const) {
      const map = server[field]
      if (!isPlainRecord(map)) continue
      const priorMap = isPlainRecord(priorServer[field]) ? priorServer[field] : {}
      for (const key of Object.keys(map)) {
        if (map[key] !== REDACTED) continue
        if (typeof priorMap[key] === "string") map[key] = priorMap[key]
        else delete map[key]
      }
    }
    if (server["cwd"] === REDACTED) {
      if (typeof priorServer["cwd"] === "string") server["cwd"] = priorServer["cwd"]
      else delete server["cwd"]
    }
  }
}

export interface ConfigPatchResult {
  ok: boolean
  /** Secret names captured into the encrypted store by this write. */
  moved: string[]
  backupCreated: boolean
  error?: string
}

/**
 * Apply a config patch to `<home>/config.json`: deep-merge into the raw doc,
 * restore redaction placeholders, capture literal secrets, atomic write.
 */
export function applyConfigPatch(home: string, patch: Record<string, unknown>): ConfigPatchResult {
  try {
    const path = configPath(home)
    const base: RawConfigDoc = readRawConfig(path) ?? {}
    const merged = mergeConfigPatch(base, patch)
    return commitConfigDoc(home, base, merged)
  } catch (e) {
    return { ok: false, moved: [], backupCreated: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * REPLACE the raw config with a full document (the settings screen's
 * write-whole-doc path; `PUT /v1/config?mode=replace`). Redaction placeholders
 * are restored and literal secrets captured exactly as for a patch, but keys
 * absent from `doc` are DELETED (a merge cannot express a delete).
 */
export function applyConfigDocument(home: string, doc: Record<string, unknown>): ConfigPatchResult {
  try {
    const path = configPath(home)
    const base: RawConfigDoc = readRawConfig(path) ?? {}
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(doc)) {
      if (DANGEROUS_KEYS.has(key)) continue
      next[key] = value
    }
    return commitConfigDoc(home, base, next)
  } catch (e) {
    return { ok: false, moved: [], backupCreated: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Shared tail: restore redaction, capture secrets, atomic write. */
function commitConfigDoc(home: string, base: RawConfigDoc, merged: Record<string, unknown>): ConfigPatchResult {
  restoreRedacted(base, merged)
  const captured = captureSecrets(home, merged)
  if (captured.error !== undefined) return { ok: false, moved: captured.moved, backupCreated: false, error: captured.error }
  const written = writeRawConfig(configPath(home), captured.doc)
  if (!written.ok) {
    return { ok: false, moved: captured.moved, backupCreated: false, error: written.error ?? "config write failed" }
  }
  return { ok: true, moved: captured.moved, backupCreated: written.backupCreated === true }
}

export interface SettingsRoutesDeps {
  /** Config home: `config.json` + the secrets store live here. */
  home: string
  /** Effective, redacted config for the write response (GET shape). */
  config: () => Record<string, unknown>
  /** Fired after a successful config write (the daemon reloads its chats). */
  onWritten?: () => void
}

/** Mount the config + secrets write routes (auth is applied globally). */
export function settingsRoutes(deps: SettingsRoutesDeps) {
  return new Elysia({ name: "sensus-daemon-settings" })
    .put(
      "/v1/config",
      ({ body, query, set }) => {
        try {
          const input = isRecord(body) ? body : null
          if (input === null) return invalid(set)
          const candidate = isRecord(input["config"]) ? input["config"] : input
          if (!isPlainRecord(candidate)) return invalid(set)
          const replace = isRecord(query) && query["mode"] === "replace"
          const applied = replace ? applyConfigDocument(deps.home, candidate) : applyConfigPatch(deps.home, candidate)
          if (!applied.ok) return { ok: false, message: applied.error ?? "config write failed" }
          try {
            deps.onWritten?.()
          } catch (err) {
            // A reload failure must not fail the committed write (default).
            log.error("onWritten config reload failed", { err })
            // STRICT rethrow (#5): the PUT /v1/config route wraps this in
            // try/catch (→ 500) and Elysia's `onError` is the outer fallback.
            if (logStrictEnabled()) throw err
          }
          return { ok: true, config: deps.config(), captured: applied.moved, backupCreated: applied.backupCreated }
        } catch {
          set.status = 500
          return { error: "internal_error" }
        }
      },
      {
        query: t.Object({
          mode: t.Optional(
            t.String({ description: "`replace` REPLACES the whole document; anything else (or absent) applies a deep-merged patch." }),
          ),
        }),
        detail: {
          tags: ["config"],
          operationId: "putConfig",
          summary: "Apply a validated config patch (never writes a literal secret)",
          description:
            "Deep-merges a config patch into the raw `config.json`. Objects merge, arrays/scalars replace, a `null` deletes a key; prototype keys are dropped. A `<redacted>` placeholder echoed from `GET /v1/config` is restored instead of overwriting the stored secret, and every literal credential in the merged doc is moved into the encrypted store as a `${NAME}` reference (`captured`). " +
            "With `?mode=replace` the body REPLACES the whole document (keys absent are deleted)." +
            "\n\nA failed write is `200 {ok:false,message}`; a structurally bad body is `400`.",
          requestBody: requestBody(
            t.Object(
              {
                config: t.Optional(
                  t.Object({}, { additionalProperties: true, description: "The patch; when present the outer object is only a wrapper." }),
                ),
              },
              { additionalProperties: true, description: "A config patch, optionally wrapped as `{ config: <patch> }`." },
            ),
            "A config patch (optionally wrapped as `{ config: <patch> }`).",
          ),
          responses: {
            200: jsonResponse(configWriteResponseSchema, "Committed (`ok:true`) or a write refusal (`ok:false,message`)."),
            400: invalidRequestResponse(),
            401: unauthorizedResponse(),
          },
        },
      },
    )
    .get(
      "/v1/config/raw",
      () => {
        try {
          const raw = readRawConfig(configPath(deps.home)) ?? {}
          return { ok: true, raw }
        } catch {
          return { ok: true, raw: {} }
        }
      },
      {
        detail: {
          tags: ["config"],
          operationId: "getRawConfig",
          summary: "Raw (unredacted) config document",
          description:
            "The raw `config.json` used by the settings editor, which round-trips the whole document. NOT redacted (a literal credential can appear) — bearer-gated and local-only. A missing file degrades to `{}`.",
          responses: { 200: jsonResponse(rawConfigResponseSchema, "The raw config document."), 401: unauthorizedResponse() },
        },
      },
    )
    .get(
      "/v1/secrets",
      () => {
        const loaded = loadSecrets(deps.home)
        return { ok: true, names: Object.keys(loaded.values).sort(), warnings: loaded.warnings }
      },
      {
        detail: {
          tags: ["config"],
          operationId: "listSecrets",
          summary: "List stored secret names (values are never returned)",
          description:
            "Returns the names in the encrypted secret store, sorted. A value is never returned; an unreadable store yields `warnings` rather than an error.",
          responses: { 200: jsonResponse(secretsResponseSchema, "Stored secret names."), 401: unauthorizedResponse() },
        },
      },
    )
    .post(
      "/v1/secrets",
      ({ body, set }) => {
        try {
          const input = isRecord(body) ? body : null
          const name = input !== null && typeof input["name"] === "string" ? input["name"] : null
          const value = input !== null && typeof input["value"] === "string" ? input["value"] : null
          if (name === null || value === null || !SECRET_NAME_RE.test(name)) return invalid(set)
          const res = setSecret(deps.home, name, value)
          return res.ok ? { ok: true, name } : { ok: false, message: res.error ?? "secrets write failed" }
        } catch {
          set.status = 500
          return { error: "internal_error" }
        }
      },
      {
        detail: {
          tags: ["config"],
          operationId: "setSecret",
          summary: "Set one secret value (write-only)",
          description: "Stores one `${NAME}` value in the AES-256-GCM store. The name must match `[A-Za-z_][A-Za-z0-9_]*`.",
          requestBody: requestBody(
            t.Object({
              name: t.String({ description: "Secret name (`[A-Za-z_][A-Za-z0-9_]*`)." }),
              value: t.String({ description: "The secret value; never echoed back." }),
            }),
            "The secret to store.",
          ),
          responses: {
            200: jsonResponse(secretWriteResponseSchema, "`{ok:true,name}` or `{ok:false,message}` (an unreadable store refuses the write)."),
            400: invalidRequestResponse("A missing/invalid name or value."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
    .delete(
      "/v1/secrets",
      ({ query, body, set }) => {
        try {
          const fromQuery = isRecord(query) && typeof query["name"] === "string" ? query["name"] : null
          const fromBody = isRecord(body) && typeof body["name"] === "string" ? body["name"] : null
          const name = fromQuery ?? fromBody
          if (name === null || !SECRET_NAME_RE.test(name)) return invalid(set)
          const res = deleteSecret(deps.home, name)
          return res.ok ? { ok: true, name, removed: true } : { ok: false, message: res.error ?? "secrets write failed" }
        } catch {
          set.status = 500
          return { error: "internal_error" }
        }
      },
      {
        query: t.Object({ name: t.Optional(t.String({ description: "The secret name to remove. May also be sent as a JSON `{ name }` body." })) }),
        detail: {
          tags: ["config"],
          operationId: "deleteSecret",
          summary: "Remove one secret value",
          description: "Removes one stored secret by `?name=` (or a JSON `{ name }` body).",
          responses: {
            200: jsonResponse(secretDeleteResponseSchema, "`{ok:true,name,removed}` or `{ok:false,message}`."),
            400: invalidRequestResponse("A missing/invalid name."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
}
