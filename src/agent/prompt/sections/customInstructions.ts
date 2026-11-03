import { section } from "../section.ts"

/** `~/.config/sensus/AGENTS.md` + every resolved `instructions` source
 * (docs/config.md), appended verbatim. Repo/project instructions arrive as
 * separate durable messages, never here (docs/agent-prompt.md). */
export const customInstructionsSection = section("custom-instructions", 850, ({ facts }) => {
  const text = facts.customInstructions
  if (text === null || text.trim().length === 0) return ""
  return ["Custom instructions (AGENTS.md + config `instructions`):", text.trimEnd()].join("\n")
})
