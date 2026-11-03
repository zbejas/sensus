import { section } from "../section.ts"

/** Connected MCP servers: one line per server + a prefer-the-domain nudge
 * (docs/mcp.md). A disabled/absent registry contributes nothing. */
export const mcpSection = section("mcp", 750, ({ facts }) => {
  const servers = facts.mcp ?? []
  if (servers.length === 0) return ""
  const lines = ["MCP servers (external tools, names are mcp__<server>__<tool>):"]
  for (const s of servers) {
    const shown = s.tools.slice(0, 8)
    const rest = s.tools.length - shown.length
    lines.push(
      `- ${s.name}: ${s.tools.length} tool(s)${shown.length > 0 ? ` (${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""})` : ""}`,
    )
  }
  lines.push("- Prefer the matching MCP tool when the task is clearly its domain (browsing, web search, ...).")
  return lines.join("\n")
})
