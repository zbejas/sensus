/**
 * MCP status chip for the StatusBar (docs/mcp.md "UI", docs/DESIGN.md
 * "Status bar"). A compact, conditionally-rendered summary of the active
 * tab's MCP servers, kept pure so its representation is unit-tested without a
 * renderer (same pattern as the rest of `ui/lib`).
 *
 * Policy:
 * - Hidden when MCP is off for the session, or no servers are configured at
 *   all. Otherwise it is ALWAYS shown — including before the first message,
 *   when every server is still `idle`: the chip is the entry point to the MCP
 *   manager (click to enable/disable servers and save context), so it must be
 *   reachable before a send.
 * - Nothing has connected yet -> the count of enabled servers (`mcp:3`); every
 *   configured server deliberately off -> `mcp:0` (still clickable, so the
 *   manager can re-enable one).
 * - One connected server shows its name (capped so a long name cannot crowd
 *   the row); several collapse to a count (`mcp:2`) — names are unbounded and
 *   the bar's right group must stay short.
 * - Any failure warns (`mcp:2/3`) instead of hiding: a misconfiguration is
 *   worth surfacing. `starting` is transient and reads as a plain value.
 */

import { truncateWithEllipsis } from "../../core/util.ts"
import type { McpServerStatusFact } from "../../engine/index.ts"
import type { BarPart, BarTone } from "./bar.ts"

/** Cap for a single connected server's name (code points). */
export const MCP_NAME_MAX = 16

/**
 * Build the `mcp:` chip for the status bar, or null when it would not mean
 * anything. `enabled` is the session `/mcp on|off` toggle.
 */
export function mcpChipPart(enabled: boolean, servers: readonly McpServerStatusFact[]): BarPart | null {
  if (!enabled) return null
  if (servers.length === 0) return null

  let total = 0
  let connected = 0
  let starting = 0
  let failed = 0
  let onlyConnected = ""
  for (const server of servers) {
    if (server.status === "disabled") continue // configured but deliberately off
    total++
    if (server.status === "connected") {
      connected++
      onlyConnected = server.name
    } else if (server.status === "starting") {
      starting++
    } else if (server.status === "failed") {
      failed++
    }
  }

  let value: string
  let tone: BarTone = "value"
  let bold = false
  if (total === 0) {
    // Every configured server is deliberately off. Keep the chip clickable so
    // the manager can turn one back on.
    value = "0"
  } else if (failed > 0) {
    value = `${connected}/${total}`
    tone = "warning"
    bold = true
  } else if (starting > 0) {
    value = connected > 0 ? `${connected}/${total}` : "starting"
  } else if (connected === 0) {
    // Before the first message nothing has connected yet; show the enabled
    // count so the chip means something (and is clickable) before a send.
    value = `${total}`
  } else if (connected === 1) {
    value = truncateWithEllipsis(onlyConnected, MCP_NAME_MAX)
  } else {
    value = `${connected}`
  }

  return {
    id: "mcp",
    spans: [
      { text: "mcp:", tone: "label" },
      { text: value, tone, bold },
    ],
  }
}
