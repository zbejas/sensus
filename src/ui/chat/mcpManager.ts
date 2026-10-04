/**
 * Pure helpers for the MCP manager overlay (docs/mcp.md "UI", docs/ui.md
 * "Overlays"). Kept out of the component so the row label / enabled-state /
 * toggle-intent decisions are unit-tested without a renderer, the same
 * convention as `overlay/nav.ts` and `lib/mcpChip.ts`.
 */

import type { McpServerStatusFact } from "../../engine/index.ts"

/** Config-level on/off for one server: `disabled` is the registry's marker for
 * an entry with `enabled: false` in the config file. */
export function mcpServerEnabled(server: McpServerStatusFact): boolean {
  return server.status !== "disabled"
}

/** Short human label for a server's live state (manager row). */
export function mcpStatusLabel(server: McpServerStatusFact): string {
  switch (server.status) {
    case "connected":
      return server.toolCount === 1 ? "connected · 1 tool" : `connected · ${server.toolCount} tools`
    case "starting":
      return "starting…"
    case "failed":
      return "failed"
    case "disabled":
      return "off"
    case "idle":
    default:
      return "idle"
  }
}

/**
 * One manager row, truncated/padded to `width` cells (opentui keeps stale
 * painted cells on a shrinking row, so every row has a fixed budget).
 */
export function mcpServerRow(server: McpServerStatusFact, selected: boolean, width: number): string {
  const mark = mcpServerEnabled(server) ? "[x]" : "[ ]"
  const arrow = selected ? "❯ " : "  "
  return ` ${arrow}${mark} ${server.name} · ${mcpStatusLabel(server)}`.slice(0, Math.max(1, width))
}

/** Should this key toggle the highlighted server? Enter is accepted in all its
 * opentui spellings; Space toggles too. */
export function mcpToggleIntent(key: { name: string }): boolean {
  return key.name === "return" || key.name === "enter" || key.name === "linefeed" || key.name === "space"
}
