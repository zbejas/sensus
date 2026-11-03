import { section } from "../section.ts"

/** `Active agent: <name> — <description>`. */
export const activeAgentSection = section("active-agent", 200, ({ facts }) => {
  const { agent } = facts
  return `Active agent: ${agent.name}${agent.description.length > 0 ? ` — ${agent.description}` : ""}`
})
