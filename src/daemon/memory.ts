/**
 * Memory resource (docs/daemon-api.md): list the three stores, read one, and
 * edit it through the SAME `MemoryStore` the TUI uses, so caps and the safety
 * scans apply identically.
 *
 * Error model (the store's contract, not HTTP's): structurally-invalid input
 * (unknown target/action, missing required arg) is a `400 {error:"invalid_request"}`.
 * A store DOMAIN refusal — cap FULL, safety refusal, ambiguous `old_text` — is a
 * successful HTTP `200` carrying `{ok:false, message, …}`: the caller renders the
 * store's precise message rather than a generic status. A committed write emits
 * exactly one `memory-write` event with `session:"daemon"`; a sink failure is
 * swallowed so it can never break a route.
 */

import { Elysia, t } from "elysia"
import type { EventSink, MemoryResult, MemoryStore, MemoryTarget, MemoryUsage } from "../engine/index.ts"
import {
  MEMORY_ACTIONS,
  MEMORY_TARGETS,
  emitMemoryWrite,
  isMemoryAction,
  isMemoryTarget,
  type DaemonMemoryAction,
} from "./memoryContract.ts"
import {
  invalidRequestResponse,
  jsonResponse,
  memoryEditRequestSchema,
  memoryEditResponseSchema,
  memoryListResponseSchema,
  memoryReadResponseSchema,
  requestBody,
  unauthorizedResponse,
} from "./apiSchemas.ts"

export { MEMORY_ACTIONS, MEMORY_TARGETS, isMemoryAction, isMemoryTarget }
export type { DaemonMemoryAction }

export interface MemoryRoutesDeps {
  /** Built per request so a config reload is picked up (never cached here). */
  store: () => MemoryStore
  /** Audit sink; the daemon emits committed writes through it. */
  events: EventSink
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function invalid(set: { status?: number | string }): { error: string } {
  set.status = 400
  return { error: "invalid_request" }
}

/** `memory-write` for a committed store write; only emitted on `{ok:true, write}`. */
function emitWrite(deps: MemoryRoutesDeps, result: MemoryResult): void {
  emitMemoryWrite(deps.events, result)
}

/** Mount the memory routes (auth is applied globally by the parent app). */
export function memoryRoutes(deps: MemoryRoutesDeps) {
  const targetParams = t.Object({
    target: t.String({
      enum: ["memory", "host", "journal"],
      description: "Which store to read/edit. An unknown target is `400 invalid_request` (the handler validates it).",
    }),
  })
  return new Elysia({ name: "sensus-daemon-memory" })
    .get(
      "/v1/memory",
      () => {
        const store = deps.store()
        return { ok: true, targets: MEMORY_TARGETS.map((target): MemoryUsage => store.usage(target)) }
      },
      {
        detail: {
          tags: ["memory"],
          operationId: "listMemory",
          summary: "Memory usage for all three stores",
          description: "Live usage (used/limit/percent/entries) for MEMORY, HOST and JOURNAL, in display order.",
          responses: { 200: jsonResponse(memoryListResponseSchema, "Usage for all three stores."), 401: unauthorizedResponse() },
        },
      },
    )
    .get(
      "/v1/memory/:target",
      ({ params, set }) => {
        const target: unknown = params.target
        if (!isMemoryTarget(target)) return invalid(set)
        const store = deps.store()
        const result = store.readResult(target)
        return {
          ok: true,
          target,
          content: result.content ?? "",
          entries: result.entries ?? [],
          usage: result.usage ?? store.usage(target),
        }
      },
      {
        params: targetParams,
        detail: {
          tags: ["memory"],
          operationId: "getMemory",
          summary: "Read one memory store",
          description: "Reads one store through the SAME `MemoryStore` the TUI uses (caps and safety scans apply identically).",
          responses: {
            200: jsonResponse(memoryReadResponseSchema, "The rendered store content, entries and usage."),
            400: invalidRequestResponse("Unknown memory target."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
    .post(
      "/v1/memory/:target",
      ({ params, body, set }) => {
        const target: unknown = params.target
        if (!isMemoryTarget(target)) return invalid(set)
        const input = asRecord(body)
        const action: unknown = input["action"]
        if (!isMemoryAction(action)) return invalid(set)

        const store = deps.store()
        let result: MemoryResult
        switch (action) {
          case "add": {
            const content = asString(input["content"])
            if (content === undefined) return invalid(set)
            result = store.add(target, content)
            break
          }
          case "replace": {
            const content = asString(input["content"])
            const oldText = asString(input["old_text"])
            if (content === undefined || oldText === undefined) return invalid(set)
            result = store.replace(target, oldText, content)
            break
          }
          case "remove": {
            const oldText = asString(input["old_text"])
            if (oldText === undefined) return invalid(set)
            result = store.remove(target, oldText)
            break
          }
          case "rewrite": {
            const content = asString(input["content"])
            if (content === undefined) return invalid(set)
            result = store.rewrite(target, content)
            break
          }
          default: {
            // prune
            const keep = input["keep_chars"]
            if (keep !== undefined && (typeof keep !== "number" || !Number.isFinite(keep))) return invalid(set)
            result = store.prune(target, keep as number | undefined)
            break
          }
        }

        emitWrite(deps, result)
        if (!result.ok) {
          return { ok: false, message: result.message, entries: result.entries, usage: result.usage }
        }
        return {
          ok: true,
          target,
          action,
          message: result.message,
          content: result.content,
          entries: result.entries,
          usage: result.usage,
          write: result.write,
        }
      },
      {
        params: targetParams,
        detail: {
          tags: ["memory"],
          operationId: "editMemory",
          summary: "Edit one memory store",
          description:
            "Applies one mutation (`add`/`replace`/`remove`/`rewrite`/`prune`) through the engine `MemoryStore`. A store-DOMAIN refusal (cap full, safety refusal, ambiguous `old_text`) is a successful `200 {ok:false,message,…}`; structurally-invalid input is `400`. A committed write also emits one `memory-write` audit event.",
          requestBody: requestBody(memoryEditRequestSchema, "The store edit; required fields depend on `action`."),
          responses: {
            200: jsonResponse(memoryEditResponseSchema, "Committed (`ok:true`) or a store-domain refusal (`ok:false`)."),
            400: invalidRequestResponse("Unknown target/action or a missing required argument."),
            401: unauthorizedResponse(),
          },
        },
      },
    )
}
