/**
 * Slash command parsing. Pure + unit-tested.
 * Anything whose trimmed text starts with "/" is a command and is NEVER sent
 * to the provider; unknown commands become a chat error bubble.
 */

/**
 * Single source of truth for chat commands (M8): the slash autocomplete menu
 * and /help both render from this table, so descriptions cannot drift.
 * Order = menu order (help first).
 */
export interface SlashCommandInfo {
  /** Lower-cased command token (without the leading "/"). */
  name: string
  /** Argument hint for /help ("" when the command takes none). */
  usage: string
  /** One-line description (autocomplete menu + /help). */
  description: string
}

export const SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: "help", usage: "", description: "show the command list" },
  { name: "model", usage: "[<endpoint>@<model>]", description: "model picker / set model (persists)" },
  { name: "models", usage: "", description: "open the model picker (all endpoints)" },
  { name: "agent", usage: "[<name>]", description: "agent picker / switch agent (persists)" },
  { name: "context", usage: "on|off", description: "attach terminal context (on|off)" },
  { name: "compact", usage: "", description: "summarize older history to free context" },
  { name: "image", usage: "[<path>|clear]", description: "attach an image file for the model" },
  { name: "ctx", usage: "", description: "context inspector (what's in context)" },
  { name: "status", usage: "", description: "runtime readout in the chat" },
  { name: "yolo", usage: "[off]", description: "full-auto approval toggle" },
  { name: "sudo", usage: "[forget]", description: "session sudo password (forget clears it)" },
  { name: "thinking", usage: "[show|hide]", description: "model reasoning display (show|hide)" },
  { name: "effort", usage: "[<mode>]", description: "thinking mode (effort/budget)" },
  { name: "details", usage: "[on|off]", description: "tool output detail (on=expanded)" },
  { name: "cards", usage: "[fill|border]", description: "message card style (fill panel | border)" },
  { name: "clear", usage: "", description: "wipe this chat (old file kept)" },
  { name: "reload", usage: "", description: "re-read config + AGENTS.md + agents" },
  { name: "memory", usage: "", description: "agent memory manager" },
  { name: "skills", usage: "", description: "skill manager" },
  { name: "skill", usage: "<name>", description: "load a skill into the chat" },
  { name: "learn", usage: "[name]", description: "save this procedure as a skill" },
  { name: "remember", usage: "<fact>", description: "save a fact to MEMORY.md" },
  { name: "pin", usage: "", description: "pin the last reply vs compaction" },
  { name: "unpin", usage: "", description: "clear pinned facts" },
  { name: "undo", usage: "", description: "restore the last file write" },
  { name: "audit", usage: "[n]", description: "show recent actions" },
  { name: "usage", usage: "", description: "token usage dashboard" },
  { name: "keys", usage: "", description: "remap global hotkeys" },
  { name: "edit", usage: "", description: "edit + resend the last message" },
  { name: "retry", usage: "", description: "ask again (resend the last message)" },
  { name: "find", usage: "<text>", description: "search this chat" },
  { name: "sessions", usage: "[query]", description: "search past chat sessions" },
  { name: "map", usage: "", description: "read-only scan; draft HOST.md" },
  { name: "mcp", usage: "[on|off]", description: "MCP servers status / session toggle" },
  { name: "theme", usage: "[name]", description: "switch theme live (persists)" },
  { name: "settings", usage: "", description: "settings screen (endpoints, keys)" },
  { name: "init-wizard", usage: "", description: "setup wizard (endpoints, model, theme)" },
]

/** Names only (parseSlash known-check) — derived, cannot drift. */
export const SLASH_NAMES: readonly string[] = SLASH_COMMANDS.map((c) => c.name)

export interface SlashCommand {
  /** Lower-cased command token (may be unknown). */
  name: string
  /** Known command? (help/model/models/agent/context/compact/status/yolo/thinking/details/cards/clear/reload/theme/settings) */
  known: boolean
  /** Rest of the line after the command token, trimmed. */
  arg: string
  /** The raw input line (for persistence). */
  raw: string
}

/** Is this input a slash command at all? (trimmed input starts with "/") */
export function isSlashInput(input: string): boolean {
  return input.trim().startsWith("/")
}

/**
 * Parse a chat input line into a SlashCommand when it starts with "/".
 * Returns null for normal messages. "/" alone -> name "" (unknown, error).
 */
export function parseSlash(input: string): SlashCommand | null {
  if (typeof input !== "string") return null
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const rest = trimmed.slice(1)
  const m = /^([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(rest)
  if (!m) {
    return { name: "", known: false, arg: "", raw: input }
  }
  const name = (m[1] ?? "").toLowerCase()
  const arg = (m[2] ?? "").trim()
  return { name, known: SLASH_NAMES.includes(name), arg, raw: input }
}
