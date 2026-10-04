/**
 * Clipboard paste routing (docs/keybindings.md, docs/agent.md "Images").
 *
 * Two DELIBERATELY distinct paths, both owned here:
 *
 * - `pasteClipboard` (Ctrl+Shift+V / Alt+V / the palette "Paste" row): reads
 *   the host clipboard and adapts — image bytes attach to the chat draft, a
 *   copied-file list attaches image files and pastes other paths as text, and
 *   plain text lands in the focused surface via `insertPastedText`. At
 *   TERMINAL focus it sends a bracketed paste to the pane (`session.pasteText`).
 * - `handleBracketedPaste` (the `usePaste` listener): terminal focus is a
 *   deliberate NO-OP (the embedded renderable owns bracketed paste itself); it
 *   only inserts into the chat draft, or forwards to an open overlay.
 *
 * Everything is injected (store + active chat + clipboard reader + blink) so the
 * routing is unit-tested without a renderer. App keeps the `usePaste`
 * registration and wires the decisions.
 */

import { imageExtension } from "../../core/image.ts"
import type { RemoteChat } from "../../client/remoteChat.ts"
import { readClipboard, type ClipboardReadResult } from "../lib/clipboard.ts"
import { blinkActivity } from "../lib/blink.ts"
import type { ToastLevel } from "../lib/toast.ts"

/** Structural tab slice the paste paths touch (UiStore's TabView satisfies it). */
export interface PasteTab {
  readonly session: { pasteText(text: string): void }
  readonly chat: RemoteChat
}

/** Structural store slice the paste paths touch (UiStore satisfies it). */
export interface PasteStore {
  inputCaptured(): boolean
  readonly overlayPasteHandler: ((text: string) => void) | null
  focus(): "terminal" | "sidebar"
  setFocus(focus: "terminal" | "sidebar"): void
  activeTab(): PasteTab | null
  showToast(message: string, level?: ToastLevel, ttlMs?: number): void
}

export interface PasteControllerDeps {
  store: PasteStore
  activeChat(): RemoteChat | null
  /** Clipboard reader seam (tests): defaults to the real host clipboard. */
  readClipboard?: () => Promise<ClipboardReadResult>
  /** Caret-hold seam (tests): defaults to the shared blink activity. */
  blink?: () => void
}

export interface PasteController {
  pasteClipboard(): void
  attachClipboardImage(bytes: Uint8Array, mimeType: string): void
  fileListToText(paths: readonly string[]): string
  insertPastedText(text: string): void
  handleBracketedPaste(text: string): { consume: boolean; inserted: boolean }
}

/** Insert draft text + re-derive slash menu + invalidate caret (the
 * `noteTextEdited()` + `bumpEditor()` pairing every edit path needs). */
export function insertDraftText(chat: RemoteChat, text: string): void {
  chat.editorState.insert(text)
  chat.noteTextEdited()
  chat.bumpEditor()
}

export function createPasteController(deps: PasteControllerDeps): PasteController {
  const read = deps.readClipboard ?? readClipboard
  const blink = deps.blink ?? blinkActivity
  const { store } = deps

  /** Store clipboard image bytes on the active chat's draft and focus it
   * (docs/agent.md "Images"). */
  function attachClipboardImage(bytes: Uint8Array, mimeType: string): void {
    const chat = deps.activeChat()
    if (!chat) {
      store.showToast("no active chat session", "warn")
      return
    }
    // Reachable when the palette's "Paste" row runs while another overlay is
    // stacked underneath: the chat draft would be hidden, so say so instead.
    if (store.inputCaptured()) {
      store.showToast("close this overlay to paste an image into the chat", "warn", 3500)
      return
    }
    const saved = chat.addDraftImage(bytes, `clipboard.${imageExtension(mimeType)}`, mimeType)
    if (!saved.ok) {
      store.showToast(saved.error, "error", 4500)
      return
    }
    store.setFocus("sidebar")
    store.showToast("image attached — Enter sends, /image clear removes", "success", 3500)
  }

  /**
   * A copied-file list: attach any image files to the chat draft and return the
   * remaining paths as newline-joined text (the agent can `read_file` them).
   * Pasting a path is the terminal-natural behavior; only images ride the
   * provider request as attachments.
   */
  function fileListToText(paths: readonly string[]): string {
    const chat = deps.activeChat()
    const remaining: string[] = []
    for (const path of paths) {
      if (chat !== null && chat.addDraftImageFromPath(path).ok) continue
      remaining.push(path)
    }
    const attached = paths.length - remaining.length
    if (attached > 0) {
      store.setFocus("sidebar")
      store.showToast(`attached ${attached} image${attached === 1 ? "" : "s"} — Enter sends`, "success", 3000)
    }
    return remaining.join("\n")
  }

  /** Route pasted text to the surface that owns input: the chat draft, or the
   * visible pane as a bracketed paste (newlines never execute). */
  function insertPastedText(text: string): void {
    if (text.length === 0) return
    if (store.inputCaptured()) {
      store.overlayPasteHandler?.(text)
      return
    }
    const tab = store.activeTab()
    if (!tab) return
    if (store.focus() === "terminal") {
      tab.session.pasteText(text)
      return
    }
    store.setFocus("sidebar")
    insertDraftText(tab.chat, text)
    blink()
  }

  /**
   * Unified paste (Ctrl+Shift+V / Alt+V): read the system clipboard and adapt
   * to what it holds — image bytes attach to the chat draft, a copied-file list
   * attaches image files and pastes other paths as text, and plain text lands in
   * the focused surface (chat draft or the visible pane). Failure is a toast,
   * never a throw.
   */
  function pasteClipboard(): void {
    void read()
      .then((res) => {
        if (!res.ok) {
          store.showToast(res.reason, "warn", 4000)
          return
        }
        if (res.kind === "image") {
          attachClipboardImage(res.bytes, res.mimeType)
          return
        }
        insertPastedText(res.kind === "files" ? fileListToText(res.paths) : res.text)
      })
      .catch(() => store.showToast("clipboard read failed", "error", 3000))
  }

  /**
   * The `usePaste` listener's routing. `consume` tells App to stop the event
   * (an open overlay owned it, or the chat draft took it); `inserted` reports
   * whether text reached the chat draft. Terminal focus is a NO-OP here: the
   * embedded renderable handles bracketed paste itself (the listener still
   * fires), so inserting again would double the text.
   */
  function handleBracketedPaste(text: string): { consume: boolean; inserted: boolean } {
    if (text.length === 0) return { consume: false, inserted: false }
    // Paste into an open overlay's / the sudo popup's text fields when editing.
    if (store.inputCaptured()) {
      store.overlayPasteHandler?.(text)
      return { consume: true, inserted: false }
    }
    const tab = store.activeTab()
    if (!tab) return { consume: false, inserted: false }
    if (store.focus() === "terminal") return { consume: false, inserted: false }
    blink() // chat caret: hold solid while pasting
    insertDraftText(tab.chat, text)
    return { consume: true, inserted: true }
  }

  return { pasteClipboard, attachClipboardImage, fileListToText, insertPastedText, handleBracketedPaste }
}
