/**
 * MCP status resource (P4c-ii; docs/daemon-api.md "Routes", docs/mcp.md "UI").
 *
 * `GET /v1/mcp` returns the live per-server MCP facts (`McpServerStatusFact`:
 * `{ name, status, toolCount }`) so a remote client can render the status-bar
 * `mcp:` chip and the MCP manager without owning the engine. `status:
 * "disabled"` is the registry's marker for a config-disabled entry, so the
 * config `enabled` flag is carried without a second field.
 *
 * The facts come from the daemon's `ChatHost` registry (lazily built on the
 * first chat op). When no host exists yet the route answers with no servers —
 * never an error and never an exception (AGENTS.md rule 10).
 */

import { Elysia } from "elysia"
import type { McpServerStatusFact } from "../engine/index.ts"
import { getLogger } from "../core/log.ts"
import { jsonResponse, mcpResponseSchema, unauthorizedResponse } from "./apiSchemas.ts"

export interface McpRoutesDeps {
  /** Live per-server facts; defaults to none (a host-less daemon). */
  status?: () => McpServerStatusFact[]
}

/** Mount the MCP status route (auth is applied globally by the parent app). */
export function mcpRoutes(deps: McpRoutesDeps = {}) {
  return new Elysia({ name: "sensus-daemon-mcp" }).get(
    "/v1/mcp",
    () => {
      let servers: McpServerStatusFact[] = []
      try {
        servers = deps.status?.() ?? []
      } catch (err) {
        // A registry read must never break the route.
        servers = []
        getLogger().child({ component: "daemon.mcp" }).warn("MCP status read failed", { err })
      }
      return { ok: true, servers }
    },
    {
      detail: {
        tags: ["mcp"],
        operationId: "getMcpStatus",
        summary: "Live per-server MCP status facts",
        description:
          "The status-bar `mcp:` chip and the MCP manager source this. Facts come from the daemon's `ChatHost` registry, built lazily on the first chat op — before any chat exists the route answers `servers: []`, never an error.",
        responses: { 200: jsonResponse(mcpResponseSchema, "Per-server MCP facts."), 401: unauthorizedResponse() },
      },
    },
  )
}
