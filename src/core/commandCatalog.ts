/**
 * The single command registry (M9 phase 2): every user-invokable action —
 * hotkey-backed or palette/slash-only — has exactly one row here.
 *
 * Consumers:
 *   - keymap layer (keymapRuntime.installGlobalKeyLayer): hotkey commands get
 *     title/desc/category metadata, so keymap.getCommands() consumers (hint
 *     footers, /help, future pickers) read the same registry.
 *   - Ctrl+P palette (ui/CommandMenu.tsx): rows are the visible entries.
 *   - App: ONE dispatch switch keyed by command id — hotkeys and palette
 *     picks resolve through the same paths, so behavior cannot drift.
 *
 * Hint sources stay external and validated: bindings come from the resolved
 * keymap (specLabel), slash spellings are checked against SLASH_COMMANDS in
 * tests. Pure module — no opentui/solid imports (unit-tested alone).
 */

import type { KeyActionId } from "./keymap.ts"

/** Palette/slash-only ids (hotkey-backed ids ARE their KeyActionId). */
export type PaletteOnlyId =
  | "open-models"
  | "open-memory"
  | "open-skills"
  | "open-sessions"
  | "open-usage"
  | "open-keymap"
  | "cycle-thinking-mode"
  | "reload-config"
  | "show-help"
  | "show-status"
  | "compact-history"
  | "open-context"
  | "open-mcp"
  | "open-setup"

export type CommandId = KeyActionId | PaletteOnlyId

export type CommandCategory = "settings" | "chat" | "tabs" | "layout" | "help"

/** Header text for palette grouping (keyed by category; Title Case). */
export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  settings: "Settings",
  chat: "Chat",
  tabs: "Tabs",
  layout: "Layout",
  help: "Help",
}

export interface CommandDef {
  /** Stable command id. Hotkey-backed ids are their KeyActionId. */
  id: CommandId
  /** Palette label (imperative, Title Case). */
  label: string
  description: string
  category: CommandCategory
  /** The hotkey action backing this command (binding + hint source). */
  action?: KeyActionId
  /** Slash spelling for the palette hint (must exist in SLASH_COMMANDS). */
  slash?: string
  /** Excluded from the Ctrl+P palette (noisy per-key entries). */
  hidden?: boolean
}

/** Palette order = table order (actions first). The table is
 * GROUPED by category in the same order the palette renders its headers
 * (settings → chat → help → tabs → layout): keep rows with their category,
 * or the grouped palette visually reorders them (groupedRenderRows makes
 * categories contiguous). */
export const COMMAND_CATALOG: readonly CommandDef[] = [
  { id: "open-settings", label: "Open settings", description: "endpoints, keys, themes, globals", category: "settings", action: "open-settings", slash: "/settings" },
  { id: "open-models", label: "Model catalog", description: "endpoint models (picker)", category: "settings", slash: "/models" },
  { id: "open-setup", label: "Setup wizard", description: "guided first-run setup (endpoints, model, theme)", category: "settings", slash: "/init-wizard" },
  { id: "open-memory", label: "Agent memory", description: "memory · host map · journal (manager)", category: "settings", slash: "/memory" },
  { id: "open-skills", label: "Skills", description: "reusable procedures (manager)", category: "settings", slash: "/skills" },
  { id: "open-usage", label: "Usage dashboard", description: "token usage + cache hit rate", category: "settings", slash: "/usage" },
  { id: "open-keymap", label: "Keybindings", description: "remap global hotkeys", category: "settings", slash: "/keys" },
  { id: "open-sessions", label: "Session search", description: "search past chat sessions", category: "settings", slash: "/sessions" },
  { id: "open-mcp", label: "MCP servers", description: "enable/disable MCP servers (saves context)", category: "settings", slash: "/mcp" },
  { id: "reload-config", label: "Reload config", description: "re-read config + AGENTS.md", category: "settings", slash: "/reload" },
  { id: "open-agents", label: "Agent picker", description: "switch agent (copilot/…)", category: "chat", action: "open-agents", slash: "/agent" },
  { id: "toggle-approval", label: "Toggle approval", description: "confirm / full-auto", category: "chat", action: "toggle-approval", slash: "/yolo" },
  { id: "toggle-thinking", label: "Toggle thinking display", description: "model reasoning show/hide", category: "chat", action: "toggle-thinking", slash: "/thinking" },
  { id: "cycle-thinking-mode", label: "Cycle thinking mode", description: "reasoning effort/budget for this session", category: "chat", slash: "/effort" },
  { id: "toggle-details", label: "Toggle tool details", description: "expand/collapse tool output", category: "chat", action: "toggle-details", slash: "/details" },
  { id: "toggle-card-style", label: "Toggle card style", description: "message cards: fill panel / border", category: "chat", action: "toggle-card-style", slash: "/cards" },
  { id: "paste-image", label: "Paste", description: "clipboard image/file/text → chat", category: "chat", action: "paste-image", slash: "/image" },
  { id: "chat-bottom", label: "Jump to latest", description: "scroll the chat to the newest message", category: "chat", action: "chat-bottom" },
  { id: "copy-message", label: "Copy message", description: "copy the newest message (or the selection)", category: "chat", action: "copy-message" },
  { id: "revert-message", label: "Revert to message", description: "rewind the chat to the newest user turn", category: "chat", action: "revert-message" },
  { id: "send-code-block", label: "Send code block", description: "newest code block → visible terminal", category: "chat", action: "send-code-block" },
  { id: "compact-history", label: "Compact history", description: "summarize older messages to free context", category: "chat", slash: "/compact" },
  { id: "open-context", label: "Context inspector", description: "what occupies the model context window", category: "chat", slash: "/ctx" },
  { id: "show-help", label: "Show help", description: "command list in the chat", category: "help", slash: "/help" },
  { id: "show-status", label: "Session status", description: "runtime readout (model, ctx, terminal) in chat", category: "help", slash: "/status" },
  { id: "new-tab", label: "New tab", description: "terminal session + fresh chat", category: "tabs", action: "new-tab" },
  { id: "close-tab", label: "Close tab", description: "detaches — the shell keeps running (quits when last)", category: "tabs", action: "close-tab" },
  { id: "tab-prev", label: "Previous tab", description: "focus the tab to the left", category: "tabs", action: "tab-prev" },
  { id: "tab-next", label: "Next tab", description: "focus the tab to the right", category: "tabs", action: "tab-next" },
  { id: "focus-toggle", label: "Toggle focus", description: "terminal / chat", category: "layout", action: "focus-toggle" },
  { id: "focus-sidebar", label: "Focus chat input", description: "move focus to the chat", category: "layout", action: "focus-sidebar" },
  { id: "sidebar-shrink", label: "Shrink chat", description: "chat -4 cols (min 30)", category: "layout", action: "sidebar-shrink" },
  { id: "sidebar-grow", label: "Grow chat", description: "chat +4 cols (max 50%)", category: "layout", action: "sidebar-grow" },
  { id: "toggle-chat-only", label: "Chat-only view", description: "hide the terminal pane (full-width chat)", category: "layout", action: "toggle-chat-only" },
  // Hotkeys without palette rows (noise) — still registered as keymap
  // commands with metadata so keymap consumers see them.
  { id: "open-menu", label: "Command menu", description: "this palette (Ctrl+P)", category: "help", action: "open-menu", hidden: true },
  { id: "prefix", label: "Prefix key", description: "Ctrl+A command prefix (tmux muscle memory)", category: "tabs", action: "prefix", hidden: true },
  { id: "tab-1", label: "Go to tab 1", description: "switch to tab 1", category: "tabs", action: "tab-1", hidden: true },
  { id: "tab-2", label: "Go to tab 2", description: "switch to tab 2", category: "tabs", action: "tab-2", hidden: true },
  { id: "tab-3", label: "Go to tab 3", description: "switch to tab 3", category: "tabs", action: "tab-3", hidden: true },
  { id: "tab-4", label: "Go to tab 4", description: "switch to tab 4", category: "tabs", action: "tab-4", hidden: true },
  { id: "tab-5", label: "Go to tab 5", description: "switch to tab 5", category: "tabs", action: "tab-5", hidden: true },
  { id: "tab-6", label: "Go to tab 6", description: "switch to tab 6", category: "tabs", action: "tab-6", hidden: true },
  { id: "tab-7", label: "Go to tab 7", description: "switch to tab 7", category: "tabs", action: "tab-7", hidden: true },
  { id: "tab-8", label: "Go to tab 8", description: "switch to tab 8", category: "tabs", action: "tab-8", hidden: true },
  { id: "tab-9", label: "Go to tab 9", description: "switch to tab 9", category: "tabs", action: "tab-9", hidden: true },
]

/** Rows the Ctrl+P palette renders (catalog order). */
export function paletteCommands(): CommandDef[] {
  return COMMAND_CATALOG.filter((c) => c.hidden !== true)
}

/** Look up a command by id (undefined for unknown ids). */
export function commandById(id: string): CommandDef | undefined {
  return COMMAND_CATALOG.find((c) => c.id === id)
}

/** The command backing a hotkey action (undefined for unregistered ones). */
export function commandForAction(action: KeyActionId): CommandDef | undefined {
  return COMMAND_CATALOG.find((c) => c.action === action)
}