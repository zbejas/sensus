/**
 * Clipboard paste routing (src/ui/chat/paste.ts, docs/keybindings.md,
 * docs/agent.md "Images"). A fake store/chat/terminal records the routing so
 * the two DISTINCT paste paths stay honest:
 *   - `insertPastedText` (Ctrl+Shift+V) at terminal focus sends a bracketed
 *     paste to the pane;
 *   - `handleBracketedPaste` (the `usePaste` listener) deliberately no-ops at
 *     terminal focus — the embedded renderable owns bracketed paste.
 */

import { describe, expect, test } from "bun:test"
import {
  createPasteController,
  insertDraftText,
  type PasteController,
  type PasteStore,
} from "../../../../src/ui/chat/paste.ts"
import { InputEditor } from "../../../../src/ui/chat/inputEditor.ts"
import type { RemoteChat } from "../../../../src/client/remoteChat.ts"
import type { ClipboardReadResult } from "../../../../src/ui/lib/clipboard.ts"

class FakeChat {
  readonly editorState = new InputEditor()
  readonly images: { bytes: Uint8Array; name: string; mimeType: string | undefined }[] = []
  readonly pathImages: string[] = []
  noteEdits = 0
  bumps = 0

  addDraftImage(bytes: Uint8Array, name: string, mimeType?: string): { ok: true } {
    this.images.push({ bytes, name, mimeType })
    return { ok: true }
  }
  addDraftImageFromPath(path: string): { ok: true; name: string; bytes: number } | { ok: false; error: string } {
    if (path.endsWith(".png")) {
      this.pathImages.push(path)
      return { ok: true, name: path, bytes: 1 }
    }
    return { ok: false, error: "not an image" }
  }
  noteTextEdited(): void {
    this.noteEdits++
  }
  bumpEditor(): void {
    this.bumps++
  }
}

class FakeTerminal {
  readonly pasted: string[] = []
  pasteText(text: string): void {
    this.pasted.push(text)
  }
}

class FakeStore {
  captured = false
  overlayPasteHandler: ((text: string) => void) | null = null
  focusState: "terminal" | "sidebar" = "terminal"
  tab: { session: FakeTerminal; chat: FakeChat } | null = null
  readonly toasts: { message: string; level?: string; ttl?: number }[] = []

  inputCaptured(): boolean {
    return this.captured
  }
  focus(): "terminal" | "sidebar" {
    return this.focusState
  }
  setFocus(focus: "terminal" | "sidebar"): void {
    this.focusState = focus
  }
  activeTab(): { session: FakeTerminal; chat: FakeChat } | null {
    return this.tab
  }
  showToast(message: string, level?: "info" | "success" | "warn" | "error", ttl?: number): void {
    this.toasts.push({ message, level, ttl })
  }
}

interface Setup {
  store: FakeStore
  chat: FakeChat
  term: FakeTerminal
  controller: PasteController
  blinks: () => number
}

function makeController(overrides: {
  store: FakeStore
  chat: FakeChat | null
  readClipboard?: () => Promise<ClipboardReadResult>
  blink?: () => void
}): PasteController {
  return createPasteController({
    store: overrides.store as unknown as PasteStore,
    activeChat: () => overrides.chat as unknown as RemoteChat | null,
    readClipboard: overrides.readClipboard,
    blink: overrides.blink,
  })
}

function setup(read?: () => Promise<ClipboardReadResult>): Setup {
  const store = new FakeStore()
  const term = new FakeTerminal()
  const chat = new FakeChat()
  store.tab = { session: term, chat }
  let blinks = 0
  const controller = makeController({
    store,
    chat,
    readClipboard: read,
    blink: () => {
      blinks++
    },
  })
  return { store, chat, term, controller, blinks: () => blinks }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("insertDraftText", () => {
  test("inserts at the cursor + re-derives the menu + invalidates the caret", () => {
    const chat = new FakeChat()
    chat.editorState.setText("ab")
    insertDraftText(chat as unknown as RemoteChat, "X")
    expect(chat.editorState.getText()).toBe("abX")
    expect(chat.noteEdits).toBe(1)
    expect(chat.bumps).toBe(1)
  })
})

describe("insertPastedText", () => {
  test("empty text is a no-op", () => {
    const { store, chat, term, controller } = setup()
    controller.insertPastedText("")
    expect(chat.editorState.getText()).toBe("")
    expect(term.pasted).toEqual([])
    expect(store.focusState).toBe("terminal")
  })

  test("input-captured routes to the overlay paste handler", () => {
    const { store, chat, term, controller } = setup()
    store.captured = true
    const seen: string[] = []
    store.overlayPasteHandler = (t) => seen.push(t)
    controller.insertPastedText("hi")
    expect(seen).toEqual(["hi"])
    expect(chat.editorState.getText()).toBe("")
    expect(term.pasted).toEqual([])
  })

  test("no active tab is a no-op", () => {
    const { store, controller } = setup()
    store.tab = null
    controller.insertPastedText("hi")
    expect(store.focusState).toBe("terminal")
  })

  test("terminal focus sends a bracketed paste to the pane (Ctrl+Shift+V path)", () => {
    const { store, chat, term, controller } = setup()
    store.focusState = "terminal"
    controller.insertPastedText("echo hi")
    expect(term.pasted).toEqual(["echo hi"])
    expect(chat.editorState.getText()).toBe("")
    expect(store.focusState).toBe("terminal")
  })

  test("chat focus inserts into the draft, focuses the sidebar, and blinks", () => {
    const { store, chat, controller, blinks } = setup()
    store.focusState = "sidebar"
    controller.insertPastedText("hello")
    expect(store.focusState).toBe("sidebar")
    expect(chat.editorState.getText()).toBe("hello")
    expect(chat.noteEdits).toBe(1)
    expect(chat.bumps).toBe(1)
    expect(blinks()).toBe(1)
  })
})

describe("attachClipboardImage", () => {
  test("no active chat warns and attaches nothing", () => {
    const store = new FakeStore()
    const controller = makeController({ store, chat: null })
    controller.attachClipboardImage(new Uint8Array([1]), "image/png")
    expect(store.toasts.at(-1)?.message).toBe("no active chat session")
    expect(store.toasts.at(-1)?.level).toBe("warn")
  })

  test("input-captured warns the draft is hidden instead of attaching", () => {
    const { store, chat, controller } = setup()
    store.captured = true
    controller.attachClipboardImage(new Uint8Array([1]), "image/png")
    expect(chat.images).toEqual([])
    expect(store.toasts.at(-1)?.message).toBe("close this overlay to paste an image into the chat")
    expect(store.toasts.at(-1)?.ttl).toBe(3500)
  })

  test("success stores the image by extension, focuses sidebar, and toasts", () => {
    const { store, chat, controller } = setup()
    controller.attachClipboardImage(new Uint8Array([1, 2]), "image/jpeg")
    expect(chat.images).toHaveLength(1)
    expect(chat.images[0]?.name).toBe("clipboard.jpg")
    expect(chat.images[0]?.mimeType).toBe("image/jpeg")
    expect(store.focusState).toBe("sidebar")
    expect(store.toasts.at(-1)?.level).toBe("success")
    expect(store.toasts.at(-1)?.ttl).toBe(3500)
  })
})

describe("fileListToText", () => {
  test("attaches image files and returns the remaining paths as text", () => {
    const { store, chat, controller } = setup()
    const text = controller.fileListToText(["/tmp/a.png", "/tmp/notes.txt"])
    expect(chat.pathImages).toEqual(["/tmp/a.png"])
    expect(text).toBe("/tmp/notes.txt")
    expect(store.focusState).toBe("sidebar")
    expect(store.toasts.at(-1)?.message).toBe("attached 1 image — Enter sends")
  })

  test("no images attached keeps the paths as text with no toast/focus change", () => {
    const { store, controller } = setup()
    const text = controller.fileListToText(["/tmp/notes.txt", "/tmp/b.md"])
    expect(text).toBe("/tmp/notes.txt\n/tmp/b.md")
    expect(store.toasts).toEqual([])
    expect(store.focusState).toBe("terminal")
  })
})

describe("pasteClipboard", () => {
  test("plain text lands in the focused chat draft", async () => {
    const { store, chat, controller } = setup(async () => ({ ok: true, kind: "text", text: "hello" }))
    store.focusState = "sidebar"
    controller.pasteClipboard()
    await tick()
    expect(chat.editorState.getText()).toBe("hello")
  })

  test("a file list goes through fileListToText", async () => {
    const { store, chat, controller } = setup(async () => ({ ok: true, kind: "files", paths: ["/tmp/a.png"] }))
    store.focusState = "sidebar"
    controller.pasteClipboard()
    await tick()
    expect(chat.pathImages).toEqual(["/tmp/a.png"])
    expect(chat.editorState.getText()).toBe("")
  })

  test("image bytes attach", async () => {
    const { chat, controller } = setup(async () => ({
      ok: true,
      kind: "image",
      mimeType: "image/png",
      bytes: new Uint8Array([1]),
    }))
    controller.pasteClipboard()
    await tick()
    expect(chat.images).toHaveLength(1)
  })

  test("a failed read warns with its reason and TTL", async () => {
    const { store, controller } = setup(async () => ({ ok: false, reason: "clipboard is empty" }))
    controller.pasteClipboard()
    await tick()
    expect(store.toasts.at(-1)?.message).toBe("clipboard is empty")
    expect(store.toasts.at(-1)?.level).toBe("warn")
    expect(store.toasts.at(-1)?.ttl).toBe(4000)
  })

  test("a rejected read reports the failure", async () => {
    const { store, controller } = setup(() => Promise.reject(new Error("boom")))
    controller.pasteClipboard()
    await tick()
    expect(store.toasts.at(-1)?.message).toBe("clipboard read failed")
    expect(store.toasts.at(-1)?.level).toBe("error")
    expect(store.toasts.at(-1)?.ttl).toBe(3000)
  })
})

describe("handleBracketedPaste", () => {
  test("empty text is neither consumed nor inserted", () => {
    const { controller } = setup()
    expect(controller.handleBracketedPaste("")).toEqual({ consume: false, inserted: false })
  })

  test("input-captured forwards to the overlay handler and consumes", () => {
    const { store, chat, controller } = setup()
    store.captured = true
    const seen: string[] = []
    store.overlayPasteHandler = (t) => seen.push(t)
    expect(controller.handleBracketedPaste("hi")).toEqual({ consume: true, inserted: false })
    expect(seen).toEqual(["hi"])
    expect(chat.editorState.getText()).toBe("")
  })

  test("no active tab is neither consumed nor inserted", () => {
    const { store, controller } = setup()
    store.tab = null
    expect(controller.handleBracketedPaste("hi")).toEqual({ consume: false, inserted: false })
  })

  test("terminal focus is a deliberate no-op (the renderable owns bracketed paste)", () => {
    const { store, chat, term, controller } = setup()
    store.focusState = "terminal"
    expect(controller.handleBracketedPaste("hi")).toEqual({ consume: false, inserted: false })
    expect(chat.editorState.getText()).toBe("")
    expect(term.pasted).toEqual([])
  })

  test("chat focus inserts into the draft, blinks, and consumes", () => {
    const { store, chat, controller, blinks } = setup()
    store.focusState = "sidebar"
    expect(controller.handleBracketedPaste("hi")).toEqual({ consume: true, inserted: true })
    expect(chat.editorState.getText()).toBe("hi")
    expect(chat.noteEdits).toBe(1)
    expect(chat.bumps).toBe(1)
    expect(blinks()).toBe(1)
  })
})
