/**
 * Sessions resource routes (docs/daemon-api.md):
 *
 *   GET /v1/sessions                          list, paged newest-first
 *   GET /v1/sessions/:instance/:base          one transcript, paged messages
 *   GET /v1/sessions/:instance/:base/export   ?format=md|jsonl (raw for jsonl)
 *
 * Read-only: the routes only ever call the read-only service in
 * `src/daemon/sessions.ts`. Auth is applied globally by the parent app
 * (`auth.ts`). A structurally bad limit/offset/format is
 * `400 {error:"invalid_request"}`; an unknown id is `404 {error:"not_found"}`.
 * Every handler is wrapped so an unexpected throw becomes a JSON `500`, never
 * an unhandled exception.
 */

import { Elysia, t } from "elysia"
import { isRecord } from "../../core/util.ts"
import type { Logger } from "../../core/log.ts"
import { componentLogger } from "../log.ts"
import { deleteSessionFile } from "../../session/store.ts"
import {
  SESSION_EXPORT_FORMATS,
  exportSession,
  listSessions,
  readSession,
  resolveSessionPath,
  type SessionExportFormat,
} from "../sessions.ts"
import {
  invalidRequestResponse,
  jsonResponse,
  mediaResponse,
  notFoundResponse,
  sessionContextResponseSchema,
  sessionDeleteResponseSchema,
  sessionListResponseSchema,
  sessionReadResponseSchema,
  unauthorizedResponse,
} from "../apiSchemas.ts"

export interface SessionRoutesDeps {
  /** Sessions data dir (`sensusDataDir()`); injected for tests, never mutated. */
  dataDir: string
  /** Saved-session context breakdown (P4e); null when the transcript is unknown. */
  context?: (path: string) => { title: string; breakdown: unknown } | null
}

/** Query values Elysia hands us; unknown keys are ignored. */
function asQuery(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

type NumberResult = { ok: true; value: number | undefined } | { ok: false }

/** An optional numeric query param: absent OK, otherwise a finite number string. */
function parseNumber(raw: unknown): NumberResult {
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false }
  return { ok: true, value: n }
}

function invalid(set: { status?: number | string }): { error: string } {
  set.status = 400
  return { error: "invalid_request" }
}

function notFound(set: { status?: number | string }): { error: string } {
  set.status = 404
  return { error: "not_found" }
}

function internal(set: { status?: number | string }): { error: string } {
  set.status = 500
  return { error: "internal_error" }
}

/** Module-level child logger for the sessions routes (component `daemon.sessions`). */
const log: Logger = componentLogger("daemon.sessions")

function parseFormat(raw: unknown): SessionExportFormat | null {
  if (raw === undefined) return "md"
  if (typeof raw !== "string" || !(SESSION_EXPORT_FORMATS as readonly string[]).includes(raw)) return null
  return raw as SessionExportFormat
}

/** Mount the sessions routes (auth is applied globally by the parent app). */
export function sessionRoutes(deps: SessionRoutesDeps) {
  const sessionParams = t.Object({
    instance: t.String({ description: "Instance id of the transcript directory." }),
    base: t.String({ description: "Transcript base name (e.g. `tab-2`, `tab-2-3`)." }),
  })
  const pageQuery = t.Object({
    limit: t.Optional(t.String({ description: "Page size (clamped to the route's max). Numeric string." })),
    offset: t.Optional(t.String({ description: "Zero-based offset. Numeric string." })),
  })
  const exportQuery = t.Object({
    format: t.Optional(
      t.String({ enum: ["md", "jsonl"], description: "`md` (default) renders the merged logical view; `jsonl` returns the raw file bytes." }),
    ),
  })
  return new Elysia({ name: "sensus-daemon-sessions" })
    .get(
      "/v1/sessions",
      ({ query, set }) => {
        try {
          const limit = parseNumber(asQuery(query)["limit"])
          if (!limit.ok) return invalid(set)
          const offset = parseNumber(asQuery(query)["offset"])
          if (!offset.ok) return invalid(set)
          const page = listSessions(deps.dataDir, { limit: limit.value, offset: offset.value })
          return { ok: true, sessions: page.sessions, nextOffset: page.nextOffset }
        } catch (err) {
          log.error("list sessions handler failed", { err })
          return internal(set)
        }
      },
      {
        query: pageQuery,
        detail: {
          tags: ["sessions"],
          operationId: "listSessions",
          summary: "List persisted sessions, newest-first",
          description: "Lists non-empty transcripts newest-first, paged. A missing sessions dir degrades to an empty page.",
          responses: {
            200: jsonResponse(sessionListResponseSchema, "A page of session summaries."),
            400: invalidRequestResponse("A non-numeric limit/offset."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
    // Defined before the 2-segment read route so the static `export` wins.
    .get(
      "/v1/sessions/:instance/:base/export",
      ({ params, query, set }) => {
        try {
          const format = parseFormat(asQuery(query)["format"])
          if (format === null) return invalid(set)
          const out = exportSession(deps.dataDir, params.instance, params.base, format)
          if (out === null) return notFound(set)
          return new Response(out.content, { status: 200, headers: { "content-type": out.contentType } })
        } catch (err) {
          log.error("export session handler failed", { err, instance: params.instance, base: params.base })
          return internal(set)
        }
      },
      {
        params: sessionParams,
        query: exportQuery,
        detail: {
          tags: ["sessions"],
          operationId: "exportSession",
          summary: "Export a transcript (markdown or raw jsonl)",
          description:
            "`md` renders the merged, logical view; `jsonl` returns the raw file bytes (preserving `session_start`/`revert`/`compaction` events that a logical read consumes).",
          responses: {
            200: mediaResponse(
              { "text/markdown": { schema: t.String() }, "application/x-ndjson": { schema: t.String() } },
              "The exported transcript.",
            ),
            400: invalidRequestResponse("Unknown export format."),
            401: unauthorizedResponse(),
            404: notFoundResponse("Unknown session."),
          },
        },
      },
    )
    .get(
      "/v1/sessions/:instance/:base",
      ({ params, query, set }) => {
        try {
          const limit = parseNumber(asQuery(query)["limit"])
          if (!limit.ok) return invalid(set)
          const offset = parseNumber(asQuery(query)["offset"])
          if (!offset.ok) return invalid(set)
          const page = readSession(deps.dataDir, params.instance, params.base, { limit: limit.value, offset: offset.value })
          if (page === null) return notFound(set)
          return { ok: true, ...page }
        } catch (err) {
          log.error("read session handler failed", { err, instance: params.instance, base: params.base })
          return internal(set)
        }
      },
      {
        params: sessionParams,
        query: pageQuery,
        detail: {
          tags: ["sessions"],
          operationId: "getSession",
          summary: "Read one transcript with a paged message window",
          description: "Reads one transcript's logical user/assistant records, paged. A `revert` marker already truncated them at load time.",
          responses: {
            200: jsonResponse(sessionReadResponseSchema, "The transcript header and one message page."),
            400: invalidRequestResponse("A non-numeric limit/offset."),
            401: unauthorizedResponse(),
            404: notFoundResponse("Unknown session (or one with no chat records)."),
          },
        },
      },
    )
    // Saved-session Context Inspector snapshot (P4e; P4c-ii meta only covers a
    // LIVE chat). The daemon reconstructs it from the transcript with the engine
    // helper, so the client needs no local session files.
    .get(
      "/v1/sessions/:instance/:base/context",
      ({ params, set }) => {
        try {
          if (deps.context === undefined) return notFound(set)
          const path = resolveSessionPath(deps.dataDir, params.instance, params.base)
          if (path === null) return notFound(set)
          const view = deps.context(path)
          if (view === null) return notFound(set)
          return { ok: true, title: view.title, breakdown: view.breakdown }
        } catch (err) {
          log.error("session context handler failed", { err, instance: params.instance, base: params.base })
          return internal(set)
        }
      },
      {
        params: sessionParams,
        detail: {
          tags: ["sessions"],
          operationId: "getSessionContext",
          summary: "Context Inspector snapshot for a saved session",
          description: "Reconstructs the engine `ContextBreakdown` from the transcript, so a remote client needs no local session files.",
          responses: {
            200: jsonResponse(sessionContextResponseSchema, "The saved session's context breakdown."),
            401: unauthorizedResponse(),
            404: notFoundResponse("Unknown session, or no context snapshot available."),
          },
        },
      },
    )
    // Delete a transcript + sidecar (P4e; D13 — the daemon owns sessions). The
    // client must first refuse a session a live tab is still appending to.
    .delete(
      "/v1/sessions/:instance/:base",
      ({ params, set }) => {
        try {
          const path = resolveSessionPath(deps.dataDir, params.instance, params.base)
          if (path === null) return notFound(set)
          const ok = deleteSessionFile(path)
          if (!ok) return { ok: false, message: "could not delete that session" }
          return { ok: true, id: `${params.instance}/${params.base}` }
        } catch (err) {
          log.error("delete session handler failed", { err, instance: params.instance, base: params.base })
          return internal(set)
        }
      },
      {
        params: sessionParams,
        detail: {
          tags: ["sessions"],
          operationId: "deleteSession",
          summary: "Delete a transcript and its sidecar",
          description:
            "Deletes a persisted transcript + metadata sidecar. The client is responsible for first refusing a session a live tab is still appending to.",
          responses: {
            200: jsonResponse(sessionDeleteResponseSchema, "`{ok:true,id}` or a refusal (`ok:false,message`)."),
            401: unauthorizedResponse(),
            404: notFoundResponse("Unknown session."),
          },
        },
      },
    )
}
