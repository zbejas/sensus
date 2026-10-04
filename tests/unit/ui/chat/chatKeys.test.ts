/**
 * Chat-input key machine (src/ui/chat/chatKeys.ts, docs/keybindings.md "Chat
 * focus"). These are the Enter-family rules that the busy-send work touched:
 * Shift+Enter / Ctrl+Enter always newline, plain Enter sends (steer/queue while
 * streaming per chat.busySend), and Alt+Enter applies the OTHER busy-send mode
 * while streaming but stays the newline fallback when idle. A tiny fake session
 * records the calls — no provider, no UI.
 */

import { describe, expect, test } from "bun:test"
import { handleChatKey, routeChatScrollKey, type ChatKey, type ChatKeyEscSeam, type ChatScrollSeam } from "../../../../src/ui/chat/chatKeys.ts"
import { InputEditor } from "../../../../src/ui/chat/inputEditor.ts"
import type { RemoteChat } from "../../../../src/client/remoteChat.ts"
import type { PlanCardData } from "../../../../src/engine/index.ts"

interface Sent {
  text: string
  alternate: boolean | undefined
}

class FakeChat {
  readonly editorState = new InputEditor()
  readonly sends: Sent[] = []
  readonly aborts: number[] = []
  /** Approval-batch plan: the fake plan + recorded plan-key calls. */
  plan: PlanCardData | null = null
  readonly planCalls: string[] = []
  draft = ""
  busy = false
  result: "sent" | "empty" | "busy" | "steered" | "queued" = "sent"

  pendingApproval(): never | null {
    return null
  }
  pendingAsk(): never | null {
    return null
  }
  pendingPlan(): PlanCardData | null {
    return this.plan
  }
  planMove(delta: number): void {
    this.planCalls.push(`move:${delta}`)
  }
  planToggle(): void {
    this.planCalls.push("toggle")
  }
  planSetHighlighted(status: string): void {
    this.planCalls.push(`set:${status}`)
  }
  planApproveAll(): void {
    this.planCalls.push("approveAll")
  }
  planDenyAll(): void {
    this.planCalls.push("denyAll")
  }
  planCommit(): void {
    this.planCalls.push("commit")
  }
  slashMenu(): null {
    return null
  }
  slashSelect(): void {}
  acceptSlashCompletion(): boolean {
    return false
  }
  slashDismiss(): void {}
  accessors = { status: (): "idle" | "streaming" => (this.busy ? "streaming" : "idle") }
  abort(): void {
    this.aborts.push(Date.now())
  }
  isBusy(): boolean {
    return this.busy
  }
  handleInput(text: string, opts: { alternate?: boolean } = {}): "sent" | "empty" | "busy" | "steered" | "queued" {
    this.sends.push({ text, alternate: opts.alternate })
    return this.result
  }
  getDraft(): string {
    return this.editorState.getText()
  }
  clearDraft(): void {
    this.editorState.clear()
  }
  noteTextEdited(): void {}
  bumpEditor(): void {}
}

function key(partial: Partial<ChatKey> & { name: string }): ChatKey {
  return { ctrl: false, meta: false, shift: false, sequence: "", ...partial }
}

const escSeam = (): ChatKeyEscSeam => ({ clear(): void {}, arm(): void {}, pending: () => false })

describe("chat input Enter-family keys", () => {
  test("plain Enter (idle) sends the draft", () => {
    const chat = new FakeChat()
    chat.editorState.setText("hello")
    handleChatKey(key({ name: "return" }), chat as unknown as RemoteChat, escSeam())
    expect(chat.sends).toEqual([{ text: "hello", alternate: undefined }])
    expect(chat.getDraft()).toBe("")
  })

  test("plain Enter while streaming uses the configured busy-send mode", () => {
    const chat = new FakeChat()
    chat.busy = true
    chat.result = "steered"
    chat.editorState.setText("steer me")
    handleChatKey(key({ name: "return" }), chat as unknown as RemoteChat, escSeam())
    expect(chat.sends).toEqual([{ text: "steer me", alternate: undefined }])
    expect(chat.getDraft()).toBe("") // accepted → draft cleared
  })

  test("Shift+Enter inserts a newline and never sends", () => {
    const chat = new FakeChat()
    chat.busy = true // even while streaming
    chat.editorState.setText("line one")
    handleChatKey(key({ name: "return", shift: true }), chat as unknown as RemoteChat, escSeam())
    expect(chat.sends).toEqual([])
    expect(chat.getDraft()).toBe("line one\n")
  })

  test("Ctrl+Enter (linefeed) inserts a newline and never sends", () => {
    const chat = new FakeChat()
    chat.editorState.setText("line one")
    handleChatKey(key({ name: "linefeed" }), chat as unknown as RemoteChat, escSeam())
    expect(chat.sends).toEqual([])
    expect(chat.getDraft()).toBe("line one\n")
  })

  test("Alt+Enter while streaming applies the alternate busy-send mode", () => {
    const chat = new FakeChat()
    chat.busy = true
    chat.result = "queued"
    chat.editorState.setText("queue me")
    handleChatKey(key({ name: "return", meta: true }), chat as unknown as RemoteChat, escSeam())
    expect(chat.sends).toEqual([{ text: "queue me", alternate: true }])
    expect(chat.getDraft()).toBe("")
  })

  test("Alt+Enter when idle stays the newline fallback", () => {
    const chat = new FakeChat()
    chat.editorState.setText("line one")
    handleChatKey(key({ name: "return", meta: true }), chat as unknown as RemoteChat, escSeam())
    expect(chat.sends).toEqual([])
    expect(chat.getDraft()).toBe("line one\n")
  })

  test("Esc-chunked Alt+Enter inserts a newline", () => {
    const chat = new FakeChat()
    chat.busy = true
    chat.editorState.setText("line one")
    const seam: ChatKeyEscSeam = { clear(): void {}, arm(): void {}, pending: () => true }
    handleChatKey(key({ name: "return" }), chat as unknown as RemoteChat, seam)
    expect(chat.sends).toEqual([])
    expect(chat.getDraft()).toBe("line one\n")
  })
})

describe("chat input word navigation", () => {
  test("Ctrl+Left/Right jump by word; plain Left/Right stay single-char", () => {
    const chat = new FakeChat()
    const c = chat as unknown as RemoteChat
    chat.editorState.setText("foo bar baz")
    handleChatKey(key({ name: "left", ctrl: true }), c, escSeam())
    expect(chat.editorState.cursor()).toEqual({ row: 0, col: 8 })
    handleChatKey(key({ name: "left", ctrl: true }), c, escSeam())
    expect(chat.editorState.cursor()).toEqual({ row: 0, col: 4 })
    handleChatKey(key({ name: "left" }), c, escSeam())
    expect(chat.editorState.cursor()).toEqual({ row: 0, col: 3 })
    handleChatKey(key({ name: "right", ctrl: true }), c, escSeam())
    expect(chat.editorState.cursor()).toEqual({ row: 0, col: 7 })
    handleChatKey(key({ name: "right" }), c, escSeam())
    expect(chat.editorState.cursor()).toEqual({ row: 0, col: 8 })
    // The draft is unchanged by navigation.
    expect(chat.getDraft()).toBe("foo bar baz")
  })
})

describe("approval-batch plan keys", () => {
  const withPlan = (): FakeChat => {
    const chat = new FakeChat()
    chat.plan = {
      lines: [{ callId: "c1", name: "shell_background", paramsSummary: "echo x", status: "approved" }],
      cursor: 0,
    }
    return chat
  }

  test("movement, toggle, per-line set and approve/deny-all route to the session", () => {
    const chat = withPlan()
    const c = chat as unknown as RemoteChat
    const seam = escSeam()
    handleChatKey(key({ name: "up" }), c, seam)
    handleChatKey(key({ name: "down" }), c, seam)
    handleChatKey(key({ name: "k" }), c, seam)
    handleChatKey(key({ name: "j" }), c, seam)
    handleChatKey(key({ name: "space" }), c, seam)
    handleChatKey(key({ name: "y" }), c, seam)
    handleChatKey(key({ name: "n" }), c, seam)
    handleChatKey(key({ name: "a", shift: true }), c, seam)
    handleChatKey(key({ name: "n", shift: true }), c, seam)
    expect(chat.planCalls).toEqual([
      "move:-1",
      "move:1",
      "move:-1",
      "move:1",
      "toggle",
      "set:approved",
      "move:1",
      "set:rejected",
      "move:1",
      "approveAll",
      "denyAll",
    ])
  })

  test("Enter commits the plan; Ctrl+J / Shift+Enter still newline; other keys type", () => {
    const chat = withPlan()
    const c = chat as unknown as RemoteChat
    handleChatKey(key({ name: "return" }), c, escSeam())
    expect(chat.planCalls).toEqual(["commit"])
    // A newline form must not commit.
    handleChatKey(key({ name: "linefeed" }), c, escSeam())
    expect(chat.planCalls).toEqual(["commit"])
    expect(chat.getDraft()).toBe("\n")
    // A printable key still edits the draft (the plan only claims its keys).
    chat.clearDraft()
    handleChatKey(key({ name: "z" }), c, escSeam())
    expect(chat.getDraft()).toBe("z")
    expect(chat.planCalls).toEqual(["commit"])
  })
})

describe("chat message-list scroll routing", () => {
  interface ScrollCall {
    kind: "bottom" | "scroll"
    pages: number
  }
  const seam = (calls: ScrollCall[]): ChatScrollSeam => ({
    requestChatBottom: () => calls.push({ kind: "bottom", pages: 0 }),
    requestChatScroll: (pages) => calls.push({ kind: "scroll", pages }),
  })

  test("End on an empty draft jumps to the newest message; a non-empty draft falls through", () => {
    const calls: ScrollCall[] = []
    const chat = new FakeChat()
    expect(routeChatScrollKey(key({ name: "end" }), chat as unknown as RemoteChat, seam(calls))).toBe(true)
    expect(calls).toEqual([{ kind: "bottom", pages: 0 }])

    calls.length = 0
    chat.editorState.setText("draft")
    expect(routeChatScrollKey(key({ name: "end" }), chat as unknown as RemoteChat, seam(calls))).toBe(false)
    expect(calls).toEqual([])
  })

  test("bare PgUp/PgDn page; modified forms stay free", () => {
    const calls: ScrollCall[] = []
    const chat = new FakeChat()
    const c = chat as unknown as RemoteChat
    expect(routeChatScrollKey(key({ name: "pageup" }), c, seam(calls))).toBe(true)
    expect(routeChatScrollKey(key({ name: "pagedown" }), c, seam(calls))).toBe(true)
    expect(calls).toEqual([
      { kind: "scroll", pages: -0.9 },
      { kind: "scroll", pages: 0.9 },
    ])
    calls.length = 0
    for (const k of [
      key({ name: "pageup", ctrl: true }),
      key({ name: "pagedown", meta: true }),
      key({ name: "pageup", shift: true }),
    ]) {
      expect(routeChatScrollKey(k, c, seam(calls))).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test("Ctrl+Home/End jump to the ends", () => {
    const calls: ScrollCall[] = []
    const chat = new FakeChat()
    const c = chat as unknown as RemoteChat
    expect(routeChatScrollKey(key({ name: "home", ctrl: true }), c, seam(calls))).toBe(true)
    expect(routeChatScrollKey(key({ name: "end", ctrl: true }), c, seam(calls))).toBe(true)
    expect(calls).toEqual([
      { kind: "scroll", pages: -1e6 },
      { kind: "bottom", pages: 0 },
    ])
  })

  test("a plain editing key is not consumed", () => {
    const calls: ScrollCall[] = []
    const chat = new FakeChat()
    const c = chat as unknown as RemoteChat
    expect(routeChatScrollKey(key({ name: "left" }), c, seam(calls))).toBe(false)
    // Modified End keeps its editor meaning (Alt+End / Shift+End are not scrolls).
    expect(routeChatScrollKey(key({ name: "end", meta: true }), c, seam(calls))).toBe(false)
    expect(routeChatScrollKey(key({ name: "end", shift: true }), c, seam(calls))).toBe(false)
    expect(calls).toEqual([])
  })
})
