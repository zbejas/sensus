import { section } from "../section.ts"

/**
 * The active agent's body, verbatim, AFTER the shared rules so its posture wins
 * on conflict (the header says so). Built-in bodies are posture only: anything
 * every agent needs lives in a shared section above, which is what keeps them
 * from drifting apart.
 */
export const agentInstructionsSection = section("agent-instructions", 650, ({ facts }) => {
  const header = "Agent instructions (follow these first when they conflict with anything above):"
  const body = facts.agent.prompt
  return body.length > 0 ? `${header}\n${body}` : header
})
