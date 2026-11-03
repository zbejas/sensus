import { section } from "../section.ts"

/**
 * Plain-chat mode: the endpoint refused tools (docs/agent-loop.md "No-tools
 * degradation"). Appended after the agent body so it overrides any instruction
 * to call one.
 */
export const noToolsSection = section(
  "no-tools",
  700,
  ({ facts }) =>
    facts.noTools
      ? `Tool use is UNAVAILABLE on this endpoint (it rejected tools). From now on answer in plain markdown only.
When the user needs a command, print it in a fenced code block and keep it copy-pasteable; clicking a command line in the chat pastes just that line into their terminal (a double click presses Enter to run it). Do not claim to have run anything.`
      : "",
)
