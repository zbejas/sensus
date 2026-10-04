/**
 * The chat-input key state machine (extracted from App.tsx). Everything here
 * operates on the active tab's RemoteChat and its InputEditor — the ONLY
 * App-owned state is the Alt+Enter disambiguation timer, which arrives as
 * three closures (see ChatKeyEscSeam).
 *
 * Dispatch order (docs/keybindings.md "Chat focus"):
 *   1. approval cards      — y/n/a while a card is pending AND draft empty
 *   2. ask_user            — plain Enter answers with the draft; digits pick
 *   3. slash autocomplete  — ↑/↓ navigate, Tab/Enter complete (partial only)
 *   4. Esc                 — abort (with the 30ms Alt+Enter split window)
 *   5. Enter               — send; while streaming applies the configured
 *                            busy-send mode (steer | queue, config `chat.busySend`)
 *                            and Alt+Enter applies the other one
 *   6. newline             — Shift+Enter / Ctrl+Enter / Ctrl+J (and Alt+Enter
 *                            when idle, or an Esc-chunked Alt+Enter)
 *   7. editing             — history browse on ↑/↓ when empty/browsing, else
 *                            cursor moves (Ctrl+←/→ jump by word), deletions,
 *                            ^C clear, printable chars
 */

import { isEnterKey, keyChar } from "../../core/util.ts"
import { isExactCommandQuery } from "./slashComplete.ts"
import type { RemoteChat } from "../../client/remoteChat.ts"

export interface ChatKey {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  sequence: string
}

/**
 * The Esc-disambiguation window is App-owned state (paste and pane keys
 * clear it too): `clear` cancels a pending window, `arm` schedules `fire`
 * after ~30ms (fire re-checks the streaming status itself), `pending`
 * reports whether a window is currently open.
 */
export interface ChatKeyEscSeam {
  clear(): void
  arm(fire: () => void): void
  pending(): boolean
}

/** Chat message-list scrolling seam (the App store satisfies it structurally). */
export interface ChatScrollSeam {
  requestChatBottom(): void
  requestChatScroll(pages: number): void
}

/**
 * Message-list scrolling keys, routed BEFORE the chat input machine (App calls
 * this first; the machine never sees a consumed key):
 *   - End on an EMPTY draft jumps to the newest message (an editor cursor move
 *     is a no-op there); a non-empty draft keeps End = end-of-line.
 *   - bare PgUp/PgDn page the list; modified forms stay free.
 *   - Ctrl+Home / Ctrl+End jump to the ends.
 * Returns true when a scroll action consumed the key.
 */
export function routeChatScrollKey(key: ChatKey, chat: RemoteChat, scroll: ChatScrollSeam): boolean {
  if (key.name === "end" && !key.ctrl && !key.meta && !key.shift && chat.editorState.isEmpty()) {
    scroll.requestChatBottom()
    return true
  }
  if (!key.ctrl && !key.meta && !key.shift && key.name === "pageup") {
    scroll.requestChatScroll(-0.9)
    return true
  }
  if (!key.ctrl && !key.meta && !key.shift && key.name === "pagedown") {
    scroll.requestChatScroll(0.9)
    return true
  }
  if (key.ctrl && !key.meta && key.name === "home") {
    scroll.requestChatScroll(-1e6)
    return true
  }
  if (key.ctrl && !key.meta && key.name === "end") {
    scroll.requestChatBottom()
    return true
  }
  return false
}

/** Enter = send; Alt+Enter / Shift+Enter / Ctrl+Enter = newline; the rest edit.
 * While a reply streams, Enter applies the configured busy-send mode and
 * Alt+Enter applies the OTHER one (docs/config.md `chat.busySend`,
 * docs/keybindings.md). Alt+Enter arrives as ESC CR, which some stdin chunking
 * splits into a bare ESC event followed by a plain return. A bare ESC therefore
 * opens a short disambiguation window: a return right after it is a newline, and
 * Esc's real action (abort) fires only when the window expires. */
export function handleChatKey(key: ChatKey, chat: RemoteChat, esc: ChatKeyEscSeam): void {
  const ed = chat.editorState
  const isEnter = isEnterKey(key)
  const isAltEnter = isEnter && (key.meta || key.sequence === "\x1b\r")
  const isShiftEnter = isEnter && key.shift
  /** Ctrl+Enter (or Ctrl+J): newline. Terminals without an extended keyboard
   * protocol (kitty or xterm modifyOtherKeys level 2) send Ctrl+Enter as a bare
   * linefeed (`\n`), which opentui reports as name "linefeed" with no modifier. */
  const isCtrlEnter = isEnter && (key.ctrl || key.name === "linefeed")

  // Approval-BATCH plan (docs/agent.md "Approval-batch plan card"): when one
  // turn produced ≥2 gated calls the plan is the single gate. Keys act only
  // while the draft is empty (typing must never half-toggle a line):
  //   ↑/↓ (or k/j) move the highlight, space toggles the highlighted line,
  //   y/n set it approved/rejected and advance, Shift+A / Shift+N approve/deny
  //   all, Enter commits the plan, Esc (below) aborts the turn.
  if (ed.isEmpty()) {
    const plan = chat.pendingPlan()
    if (plan !== null) {
      const printable = !key.ctrl && !key.meta
      if (printable && (key.name === "up" || key.name === "k")) {
        chat.planMove(-1)
        return
      }
      if (printable && (key.name === "down" || key.name === "j")) {
        chat.planMove(1)
        return
      }
      if (printable && !key.shift && key.name === "space") {
        chat.planToggle()
        return
      }
      if (printable && !key.shift && key.name === "y") {
        chat.planSetHighlighted("approved")
        chat.planMove(1)
        return
      }
      if (printable && !key.shift && key.name === "n") {
        chat.planSetHighlighted("rejected")
        chat.planMove(1)
        return
      }
      if (printable && key.shift && key.name === "a") {
        chat.planApproveAll()
        return
      }
      if (printable && key.shift && key.name === "n") {
        chat.planDenyAll()
        return
      }
      if (isEnter && !isCtrlEnter && !isAltEnter && !isShiftEnter && !esc.pending()) {
        chat.planCommit()
        return
      }
    }
  }

  // M3 approval cards: y/n/a act only while a card is pending AND the draft
  // is empty (typing a message must never half-trigger an approval). Modified
  // Enter (newline forms) must never resolve a card.
  if (!key.ctrl && !key.meta && !key.shift && key.name !== "linefeed") {
    const pending = chat.pendingApproval()
    if (pending !== null && ed.isEmpty()) {
      if (key.name === "y") {
        chat.resolveCard(pending.callId, "accept")
        return
      }
      if (key.name === "n") {
        chat.resolveCard(pending.callId, "reject")
        return
      }
      if (key.name === "a" && pending.allowPrefix && pending.allowPrefix.length > 0) {
        chat.resolveCard(pending.callId, "allow")
        return
      }
    }
    // M3 ask_user: digits pick options while the draft is empty; a PLAIN Enter
    // answers with the draft text (newline Enter falls through to editing).
    const ask = chat.pendingAsk()
    if (ask !== null) {
      if (isEnter) {
        const answer = chat.getDraft().trim()
        if (answer.length > 0) {
          chat.answerAsk(ask.callId, answer)
          chat.clearDraft()
        }
        return
      }
      if (ed.isEmpty() && /^[1-9]$/.test(key.name) && ask.options !== null && ask.options !== undefined) {
        const opt = ask.options[Number(key.name) - 1]
        if (opt !== undefined) {
          chat.answerAsk(ask.callId, opt)
          return
        }
      }
      // fall through: the user is composing a custom answer
    }
  }

  // M8 slash autocomplete: while the menu is open, Up/Down navigate it, Tab
  // accepts the highlighted completion, and Enter completes a PARTIAL token
  // (an exact command like "/clear" still sends immediately — sending "/cl"
  // would just be an unknown-command error). The menu itself is derived from
  // the draft, so edits open/close it with no extra state to keep in sync.
  const menu = chat.slashMenu()
  if (menu !== null) {
    if (key.name === "up") {
      chat.slashSelect(-1, menu.matches.length)
      return
    }
    if (key.name === "down") {
      chat.slashSelect(1, menu.matches.length)
      return
    }
    if (key.name === "tab" && !key.ctrl && !key.meta) {
      chat.acceptSlashCompletion()
      return
    }
    if (
      isEnter &&
      !key.ctrl &&
      !isAltEnter &&
      !isShiftEnter &&
      !isCtrlEnter &&
      !isExactCommandQuery(menu.query) &&
      chat.acceptSlashCompletion()
    ) {
      return
    }
  }

  if (key.name === "escape") {
    // A bare ESC also arrives when stdin splits Alt+Enter's ESC CR (see
    // header): dismiss an open menu, then arm the abort window.
    if (menu !== null) chat.slashDismiss()
    esc.clear()
    esc.arm(() => {
      // Re-check: a burst of buffered input may have started a new send
      // while this timer waited (Esc must not abort the WRONG generation).
      if (chat.accessors.status() === "streaming") chat.abort()
    })
    return
  }
  if (isEnter) {
    esc.clear()
    // Shift+Enter / Ctrl+Enter / Ctrl+J always insert a newline.
    if (isShiftEnter || isCtrlEnter) {
      newline(chat)
      return
    }
    // ESC CR split by stdin chunking — this Enter is Alt+Enter (the newline
    // fallback; see the header).
    if (esc.pending()) {
      newline(chat)
      return
    }
    if (isAltEnter) {
      // While a reply streams, Alt+Enter applies the OTHER busy-send mode
      // (docs/config.md `chat.busySend`); when idle it
      // stays the Alt+Enter newline fallback.
      if (chat.isBusy()) {
        const res = chat.handleInput(chat.getDraft(), { alternate: true })
        if (res === "sent" || res === "steered" || res === "queued") chat.clearDraft()
        return
      }
      newline(chat)
      return
    }
    const res = chat.handleInput(chat.getDraft())
    if (res === "sent" || res === "steered" || res === "queued") chat.clearDraft()
    // "busy": a slash command or compaction is in progress — keep the draft so
    // nothing is lost; "empty": nothing to send.
    return
  }
  esc.clear()
  if (key.name === "up") {
    if (ed.isEmpty() || chat.isBrowsingHistory()) {
      const t = chat.historyOlder()
      if (t !== null) chat.setDraft(t)
    } else {
      ed.moveUp()
      edited(chat)
    }
    return
  }
  if (key.name === "down") {
    if (chat.isBrowsingHistory()) {
      const t = chat.historyNewer()
      chat.setDraft(t ?? "")
    } else {
      ed.moveDown()
      edited(chat)
    }
    return
  }
  if (key.name === "left") {
    if (key.ctrl && !key.meta) ed.moveWordLeft()
    else ed.moveLeft()
    chat.bumpEditor()
    return
  }
  if (key.name === "right") {
    if (key.ctrl && !key.meta) ed.moveWordRight()
    else ed.moveRight()
    chat.bumpEditor()
    return
  }
  if (key.name === "home") {
    ed.home()
    chat.bumpEditor()
    return
  }
  if (key.name === "end") {
    ed.end()
    chat.bumpEditor()
    return
  }
  if (key.name === "backspace") {
    ed.backspace()
    edited(chat)
    return
  }
  if (key.name === "delete") {
    ed.deleteForward()
    edited(chat)
    return
  }
  if (key.ctrl && key.name === "c") {
    if (!ed.isEmpty()) {
      ed.clear()
      edited(chat)
    }
    return
  }
  // Printable characters (opentui lowercases letters + sets shift).
  if (!key.ctrl && !key.meta && key.name.length === 1 && key.name !== " ") {
    const ch = keyChar(key)
    ed.insert(ch)
    edited(chat)
    return
  }
  if (key.name === "space" && !key.ctrl && !key.meta) {
    ed.insert(" ")
    edited(chat)
  }
}

/** The draft text changed AND the editor must repaint (the two-call pairing
 * every edit path needs — noteTextEdited re-derives the slash menu, bumpEditor
 * invalidates the caret memo). */
function edited(chat: RemoteChat): void {
  chat.noteTextEdited()
  chat.bumpEditor()
}

/** Insert a line break at the cursor (Alt+Enter / Shift+Enter / split ESC CR). */
function newline(chat: RemoteChat): void {
  chat.editorState.newline()
  edited(chat)
}
