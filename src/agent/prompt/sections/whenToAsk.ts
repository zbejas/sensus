import { section } from "../section.ts"

/**
 * The ask-vs-act boundary (docs/agent-prompt.md "When to ask"). Rendered only
 * when the request actually offers `ask_user`, so a read-only researcher is
 * never handed a tool it does not have. Its job is to stop the two failure
 * modes at once: asking for permission the card already grants, and guessing
 * at a fork only the user can settle.
 */
export const whenToAskSection = section("when-to-ask", 600, ({ has }) => {
  if (!has("ask_user")) return ""
  return [
    "When to ask (ask_user):",
    "- Ask only for a genuine fork you cannot resolve by investigation: a destructive or irreversible choice, missing credentials, or an ambiguous goal whose readings need different work.",
    '- Do not ask for permission, acknowledgement, or "what next?" — the approval card is the gate, and your final message ends the turn.',
    "- Ask once. Put the options in the question when there are options, and keep working the moment the answer arrives.",
    "- Never ask for something the terminal, a file, HOST.md or a session search already answers.",
  ].join("\n")
})
