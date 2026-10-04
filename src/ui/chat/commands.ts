/**
 * Command dispatch (extracted from App.tsx): the single path shared by global
 * hotkeys (through the OpenTUI keymap layer) and the Ctrl+P command palette.
 *
 * MOVE-ONLY extraction: `handleAction` (hotkey-backed ids), `chatCommand` and
 * the `runCommand` / `runCommandInner` pair are unchanged; App creates the
 * dispatcher once and uses it from both `installHotkeys` and the
 * `<CommandMenu onRun>` JSX.
 */

import { commandById, type CommandId } from "../../core/commandCatalog.ts"
import type { KeyActionId } from "../../core/keymap.ts"
import { cycleTabs, tabAtPosition } from "../lib/tabs.ts"
import type { RemoteChat } from "../../client/remoteChat.ts"
import type { UiStore } from "../lib/store.ts"

export interface CommandDeps {
  store: UiStore
  activeChat(): RemoteChat | null
  openNewTab(): void
  closeActiveTab(): void
  adjustSidebar(delta: number): void
  switchTo(id: number): void
  /** Paste the system clipboard (the "paste-image"/Paste row path). */
  paste(): void
  /** Reload config; returns a toast message to surface, or null. */
  reloadConfig(): string | null
}

export interface CommandDispatch {
  handleAction(action: KeyActionId): void
  runCommand(id: CommandId): void
}

export function createCommandDispatch(deps: CommandDeps): CommandDispatch {
  const { store } = deps

  const handleAction = (action: KeyActionId): void => {
    switch (action) {
      case "focus-toggle":
        store.toggleFocus()
        return
      case "focus-sidebar":
        store.setFocus("sidebar")
        return
      case "new-tab":
        void deps.openNewTab()
        return
      case "close-tab":
        void deps.closeActiveTab()
        return
      case "tab-prev":
      case "tab-next": {
        const ids = store.tabs().map((t) => t.id)
        const current = store.activeTabId()
        if (current === null || ids.length < 2) return
        const next = cycleTabs(ids, current, action === "tab-prev" ? "prev" : "next")
        if (next !== null) deps.switchTo(next)
        return
      }
      case "sidebar-shrink":
        deps.adjustSidebar(-4)
        return
      case "sidebar-grow":
        deps.adjustSidebar(4)
        return
      case "open-settings":
        store.setOverlay(store.overlay() === "settings" ? null : "settings")
        return
      case "open-menu":
        store.setOverlay(store.overlay() === "menu" ? null : "menu")
        return
      case "open-agents":
        store.setOverlay(store.overlay() === "agents" ? null : "agents")
        return
      case "toggle-approval": {
        const chat = deps.activeChat()
        if (chat) chat.setApproval(chat.accessors.approval() === "confirm" ? "full-auto" : "confirm")
        return
      }
      // M10 display toggles (Alt+T / Alt+E, the Ctrl+P rows, /thinking and
      // /details all land here). No active session: no-op.
      case "toggle-thinking":
        deps.activeChat()?.toggleLastThinkingOpen()
        return
      case "toggle-details":
        deps.activeChat()?.toggleLastCardExpand()
        return
      case "toggle-card-style": {
        const chat = deps.activeChat()
        if (chat) chat.toggleCardStyle()
        return
      }
      case "chat-bottom":
        store.requestChatBottom()
        return
      // Chat-only view (Alt+Home, ephemeral): hide the terminal pane, full-width
      // chat, top tab bar + status bar kept. The toast names the way back.
      case "toggle-chat-only": {
        store.toggleChatOnly()
        store.showToast(
          store.chatOnly()
            ? "chat-only view — terminal hidden (Alt+Home restores)"
            : "terminal view restored",
          "info",
          2500,
        )
        return
      }
      case "paste-image":
        deps.paste()
        return
      default: {
        const n = Number(action.slice(4))
        const target = tabAtPosition(
          store.tabs().map((t) => t.id),
          n,
        )
        if (target !== null) deps.switchTo(target)
      }
    }
  }

  /** Run a slash command on the active tab's chat (warn when none). */
  const chatCommand = (command: string): void => {
    const chat = deps.activeChat()
    if (!chat) {
      store.showToast("no active chat session", "warn")
      return
    }
    chat.handleInput(command) // routes through the normal slash path
  }

  /**
   * Palette entry point. A pick that NAVIGATES to another view (settings,
   * models, …) leaves the palette underneath so Esc/click-outside walks back
   * to it; any other pick closes the palette.
   */
  const runCommand = (id: CommandId): void => {
    const fromMenu = store.overlay() === "menu"
    runCommandInner(id)
    if (fromMenu && store.overlay() === "menu") store.setOverlay(null)
  }

  /**
   * M9: ONE dispatch path for commands (src/core/commandCatalog.ts). Hotkeys (via
   * the keymap layer) and Ctrl+P picks both land here; hotkey-backed ids
   * delegate to handleAction, palette-only ids run their own case. The old
   * separate runMenuCommand table is gone — behavior cannot drift.
   */
  const runCommandInner = (id: CommandId): void => {
    const def = commandById(id)
    if (def?.action !== undefined) {
      handleAction(def.action)
      return
    }
    switch (id) {
      case "open-models":
        store.setOverlay("models")
        return
      case "open-memory":
        store.setOverlay("memory")
        return
      case "open-skills":
        store.setOverlay("skills")
        return
      case "open-usage":
        store.setOverlay("usage")
        return
      case "open-keymap":
        store.setOverlay("keymap")
        return
      case "open-sessions":
        store.setOverlay("sessions")
        return
      case "open-mcp":
        store.setOverlay("mcp")
        return
      case "open-setup":
        store.setOverlay("setup")
        return
      case "cycle-thinking-mode": {
        const chat = deps.activeChat()
        if (!chat) {
          store.showToast("no active chat session", "warn")
          return
        }
        chat.cycleEffort()
        return
      }
      case "reload-config": {
        const msg = deps.reloadConfig()
        if (msg !== null) store.showToast(msg, "success", 2500)
        return
      }
      case "show-help":
        chatCommand("/help") // transcript + system bubble
        return
      case "show-status":
        chatCommand("/status") // runtime readout as a chat system bubble
        return
      case "compact-history":
        chatCommand("/compact") // compacts + notes in the chat transcript
        return
      case "open-context":
        store.setContextView(null)
        store.setOverlay("context")
        return
    }
  }

  return { handleAction, runCommand }
}
