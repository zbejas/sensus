import { section } from "../section.ts"

/**
 * The core rules. Each bullet is conditional on the tool it talks about: the
 * read_file-over-shell rule only matters when `read_file` exists, the reload
 * rule only when `reload` exists, the HOST.md rule only when the memory tool is
 * enabled and present. The approval economics and the ask-user policy have
 * their own sections (approvals.ts / whenToAsk.ts) so neither hides in a wall
 * of bullets.
 */
export const rulesSection = section("rules", 500, ({ facts, has }) => {
  const lines: string[] = ["Rules:"]
  const lookText = has("read_file")
    ? has("get_scrollback")
      ? "read files with read_file or the terminal with get_scrollback"
      : "read files with read_file"
    : has("get_scrollback")
      ? "read the terminal with get_scrollback"
      : "gather evidence with the tools you have"
  lines.push(
    has("shell_background")
      ? `- Investigate before guessing: check state with shell_background, then ${lookText}.`
      : `- Investigate before guessing: ${lookText}.`,
  )
  lines.push("- Never claim a command ran or a file changed unless a tool call returned it.")
  if (has("read_file") || has("edit_file") || has("write_file")) {
    lines.push("- File tools resolve relative paths against the user's terminal cwd, not yours.")
  }
  if (has("read_file")) {
    lines.push(
      "- Read files with read_file, not the shell: offset/limit page by lines (offset is 1-based). " +
        "Do NOT run sed -n/awk/head/tail/cat through the shell just to view a file — read_file " +
        "is bounded and pageable, and every call costs the user one approval card either way." +
        (has("shell_background") ? " Reserve shell_background for inspection that needs a command (git, ls, grep with flags) and for real work." : ""),
    )
  }
  // The reload rule only matters to an agent that can EDIT something.
  if (has("reload") && (has("edit_file") || has("write_file"))) {
    lines.push(
      "- To make edits to config.json, AGENTS.md, agent definitions, skills, or MCP servers take " +
        "effect, call the reload tool — it re-reads them (the /reload action). Never type /reload " +
        "into the user's terminal.",
    )
  }
  if (has("shell_background") || has("shell_session")) {
    const sudoHint =
      facts.agent.sudoPrompt === "popup"
        ? has("shell_session")
          ? "sensus asks for it in a popup (or reuses the session cache) and applies it to the command for you, in the hidden shell and in the visible pane"
          : "sensus asks for it in a popup (or reuses the session cache) and applies it to the command for you"
        : facts.agent.sudoPrompt === "auto"
          ? "sensus asks for it in a popup (or reuses the session cache) and applies it for you — for shell_background before the command runs (whenever `sudo` appears anywhere in the line) and for shell_session before the command is typed; if you decline to ask, hand the command to the user"
          : "tell the user to run privileged commands in their own terminal"
    lines.push(
      `- sudo: never type or ask for the user's password yourself — ${sudoHint}.` +
        (has("shell_session")
          ? " For a privileged command the user should WATCH, use shell_session and let sensus ask for the password; never type a bare sudo into the pane and then retry around the prompt."
          : ""),
    )
    if (has("shell_background")) {
      lines.push(
        "- sudo in the hidden shell: run plain `sudo <cmd>` — position does not matter (sensus arms the password helper for the whole call, so `a; sudo b` authenticates too). Never pass `-n`/`--non-interactive` — that forbids the password helper, so the tty-less command can never authenticate. Do not use `sudo -n` as a probe; just run `sudo <cmd>`.",
      )
    }
  }
  return lines.join("\n")
})
