/**
 * Audit resource routes (docs/daemon-api.md):
 *
 *   GET /v1/audit         filtered + paginated records; `?format=jsonl|csv` export
 *   GET /v1/audit/stats   counts by kind/tool/session over the same filter
 *
 * Auth is applied globally by the parent app (see `auth.ts`). A structurally bad
 * filter/cursor/format is `400 {error:"invalid_request"}`; a source read failure
 * degrades to an empty result (the resource never throws).
 */

import { Elysia, t } from "elysia"
import { isRecord } from "../../core/util.ts"
import {
  auditStats,
  filterRecords,
  paginate,
  sortNewestFirst,
  toCsv,
  toJsonl,
  type AuditPage,
  type AuditQuery,
  type NormalizedAuditRecord,
} from "./query.ts"
import type { AuditSource } from "./reader.ts"
import { auditListResponseSchema, auditStatsResponseSchema, invalidRequestResponse, jsonResponse, mediaResponse, unauthorizedResponse } from "../apiSchemas.ts"

/** Response formats: JSON (default) or a file-oriented export. */
const FORMATS = ["json", "jsonl", "csv"] as const
type AuditFormat = (typeof FORMATS)[number]

interface ParsedAuditQuery {
  filter: AuditQuery
  /** Raw (pre-clamp) page size; undefined means the default applies. */
  limit?: number
  cursor?: string
  format: AuditFormat
}

type ParseResult = { ok: true; value: ParsedAuditQuery } | { ok: false }

/** Query values Elysia hands us; unknown keys are ignored. */
function asQuery(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/**
 * Validate the recognized query params. `since`/`until`/`limit` must be finite
 * numbers, string filters must be non-empty, `format` must be known, and a
 * cursor must be a non-empty string (its content is validated at decode time).
 */
function parseAuditQuery(raw: Record<string, unknown>): ParseResult {
  const filter: AuditQuery = {}
  for (const key of ["since", "until"] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "string" || value.trim() === "") return { ok: false }
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false }
    filter[key] = n
  }
  for (const key of ["session", "tool", "kind"] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "string" || value.length === 0) return { ok: false }
    filter[key] = value
  }

  let limit: number | undefined
  const rawLimit = raw["limit"]
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || rawLimit.trim() === "") return { ok: false }
    const n = Number(rawLimit)
    if (!Number.isFinite(n)) return { ok: false }
    limit = n
  }

  let cursor: string | undefined
  const rawCursor = raw["cursor"]
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== "string" || rawCursor.length === 0) return { ok: false }
    cursor = rawCursor
  }

  let format: AuditFormat = "json"
  const rawFormat = raw["format"]
  if (rawFormat !== undefined) {
    if (typeof rawFormat !== "string" || !(FORMATS as readonly string[]).includes(rawFormat)) return { ok: false }
    format = rawFormat as AuditFormat
  }

  return { ok: true, value: { filter, limit, cursor, format } }
}

function invalid(set: { status?: number | string }): { error: string } {
  set.status = 400
  return { error: "invalid_request" }
}

/** A source read must never break a request; degrade to empty on a throw. */
function safeRead(source: AuditSource): NormalizedAuditRecord[] {
  try {
    return source.read()
  } catch {
    return []
  }
}

function textResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } })
}

/** Mount the audit routes against the injected source. */
export function auditRoutes(source: AuditSource) {
  const filterQuerySchema = t.Object({
    since: t.Optional(t.String({ description: "Inclusive lower bound on `ts` (epoch ms). Numeric string." })),
    until: t.Optional(t.String({ description: "Exclusive upper bound on `ts` (epoch ms). Numeric string." })),
    session: t.Optional(t.String({ description: "Filter by per-run instance id." })),
    tool: t.Optional(t.String({ description: "Filter by tool name." })),
    kind: t.Optional(t.String({ description: "Filter by coarse kind (file/memory/shell/session/turn/skill/error/…)." })),
  })
  const querySchema = t.Object({
    ...filterQuerySchema.properties,
    limit: t.Optional(t.String({ description: "Page size (1–100, clamped; default 20). Numeric string." })),
    cursor: t.Optional(t.String({ description: "Opaque cursor from a previous page's `nextCursor`." })),
    format: t.Optional(t.String({ enum: ["json", "jsonl", "csv"], description: "`json` (default, paged), or a whole-filtered-set export." })),
  })
  return new Elysia({ name: "sensus-daemon-audit" })
    .get(
      "/v1/audit/stats",
      ({ query, set }) => {
        const parsed = parseAuditQuery(asQuery(query))
        if (!parsed.ok) return invalid(set)
        const records = sortNewestFirst(filterRecords(safeRead(source), parsed.value.filter))
        return { ok: true, ...auditStats(records) }
      },
      {
        query: filterQuerySchema,
        detail: {
          tags: ["audit"],
          operationId: "getAuditStats",
          summary: "Audit counts by kind/tool/session",
          description:
            "Counts the records that match the same filters as `GET /v1/audit`. Each map is bounded (overflow collapses to `(other)`); a tool-less record counts under `(none)`.",
          responses: {
            200: jsonResponse(auditStatsResponseSchema, "Audit counts."),
            400: invalidRequestResponse("A malformed filter."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
    .get(
      "/v1/audit",
      ({ query, set }) => {
        const parsed = parseAuditQuery(asQuery(query))
        if (!parsed.ok) return invalid(set)
        const { filter, limit, cursor, format } = parsed.value
        const filtered = sortNewestFirst(filterRecords(safeRead(source), filter))

        // An export returns the whole filtered set unless the caller explicitly
        // pages it; the JSON view always pages (default 20, max 100).
        let page: AuditPage
        try {
          page =
            format !== "json" && limit === undefined && cursor === undefined
              ? { records: filtered, nextCursor: null }
              : paginate(filtered, limit, cursor)
        } catch {
          // decodeCursor throws on a malformed cursor.
          return invalid(set)
        }

        if (format === "jsonl") return textResponse(toJsonl(page.records), "application/x-ndjson; charset=utf-8")
        if (format === "csv") return textResponse(toCsv(page.records), "text/csv; charset=utf-8")
        return { ok: true, records: page.records, nextCursor: page.nextCursor }
      },
      {
        query: querySchema,
        detail: {
          tags: ["audit"],
          operationId: "listAudit",
          summary: "Filtered, paginated audit records (or a jsonl/csv export)",
          description:
            "Returns newest-first audit records normalized from the legacy JSONL and/or the event log. `since` is inclusive, `until` exclusive. " +
            "With `?format=jsonl` or `?format=csv` (and no explicit `limit`/`cursor`) the WHOLE filtered set is exported; `before` is omitted from CSV.",
          responses: {
            200: mediaResponse(
              {
                "application/json": { schema: auditListResponseSchema },
                "application/x-ndjson": { schema: t.String() },
                "text/csv": { schema: t.String() },
              },
              "A JSON page, or a whole-set jsonl/csv export.",
            ),
            400: invalidRequestResponse("A malformed filter, cursor or format."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
}
