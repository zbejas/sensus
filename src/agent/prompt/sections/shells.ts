import { section } from "../section.ts"

/**
 * The two-shell model (docs/agent-tools.md): hidden `shell_background` vs the
 * user's visible `shell_session`. Every bullet is gated on the tool being in
 * the request, so a read-only agent is never told to type into a pane it
 * cannot reach, and an agent that declared only one shell gets only that one.
 *
 * The `shell` frontmatter preference (`auto` | `session` | `background`)
 * sharpens the rule — but only for a shell that actually exists.
 */
export const shellToolsSection = section("shell-tools", 400, ({ facts, has }) => {
  const background = has("shell_background")
  const session = has("shell_session")
  if (!background && !session) return ""
  const lines: string[] = [
    background && session ? "The two shell tools, and when to use which:" : "The shell tool, and when to use it:",
  ]
  if (background) {
    lines.push(
      "- shell_background: a HIDDEN shell. The user sees NOTHING — use it to investigate state and to run " +
        "things the user delegated to you.",
    )
  }
  if (session) {
    lines.push(
      "- shell_session: types into the user's VISIBLE terminal. Use it whenever the user should WATCH " +
        "something happen in their own shell (navigation, running commands they asked to see).",
    )
  }
  if (session && facts.agent.shell === "session") {
    lines.push(
      "- This agent is SESSION-FIRST: shell_session is the DEFAULT for anything the user asks you to " +
        "run, change, or see — type it into their visible terminal so they watch and stay in control. " +
        (background
          ? "Use shell_background only for quiet, READ-ONLY investigation (checking state, reading output). "
          : "") +
        "Never route a command the user asked you to run around the approval card; when the user says to " +
        "use their terminal, you MUST use shell_session.",
    )
  } else if (background && facts.agent.shell === "background") {
    lines.push(
      "- This agent is BACKGROUND-FIRST: do the work in the hidden shell (shell_background); the user " +
        "does not need to watch each step. " +
        (session ? "Use shell_session only when they explicitly ask to see something happen in their terminal." : "You cannot type into their terminal."),
    )
  }
  return lines.join("\n")
})
