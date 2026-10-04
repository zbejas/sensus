/**
 * Pure selectors backing the keyboard equivalents of the mouse-only chat row
 * actions (src/ui/components/chat/messageActions.ts). App owns the side effects;
 * these tests pin target selection.
 */

import { describe, expect, test } from "bun:test"
import { lastCodeBlock, lastMessageText, lastUserMessageId } from "../../../../src/ui/components/chat/messageActions.ts"
import type { ChatMessage } from "../../../../src/agent/chat/chatMessages.ts"

const msg = (id: number, role: ChatMessage["role"], content: string): ChatMessage => ({
  id,
  role,
  content,
  ts: id,
})

describe("messageActions — keyboard parity target selection", () => {
  test("lastMessageText: newest non-empty content, skipping empty streaming/system bubbles", () => {
    expect(lastMessageText([])).toBeNull()
    expect(lastMessageText([msg(1, "user", "")])).toBeNull()
    const list = [msg(1, "user", "hi"), msg(2, "assistant", ""), msg(3, "assistant", "the answer")]
    expect(lastMessageText(list)).toBe("the answer")
    // An empty newest bubble falls back to the last message that had text.
    expect(lastMessageText([msg(1, "user", "hi"), msg(2, "assistant", "")])).toBe("hi")
  })

  test("lastUserMessageId: newest user turn, ignoring assistant/tool bubbles", () => {
    expect(lastUserMessageId([])).toBeNull()
    expect(lastUserMessageId([msg(1, "assistant", "x"), msg(2, "tool", "y")])).toBeNull()
    const list = [msg(1, "user", "a"), msg(2, "assistant", "b"), msg(3, "user", "c"), msg(4, "assistant", "d")]
    expect(lastUserMessageId(list)).toBe(3)
    // A pending tool bubble after the turn does not shift the target.
    expect(lastUserMessageId([msg(1, "user", "a"), msg(2, "tool", "t")])).toBe(1)
  })

  test("lastCodeBlock: newest assistant fence; last fence within a message; older messages used when the newest has none", () => {
    expect(lastCodeBlock([])).toBeNull()
    expect(lastCodeBlock([msg(1, "user", "```\nnpm i\n```")])).toBeNull() // user fences are not click-to-send rows
    const one = msg(1, "assistant", "before\n```bash\necho one\n```\nafter")
    expect(lastCodeBlock([one])).toBe("echo one")
    // Two fences in one message: the LAST one wins.
    const two = msg(1, "assistant", "```\nfirst\n```\nmid\n```\nsecond\n```")
    expect(lastCodeBlock([two])).toBe("second")
    // Newest message has no fence -> fall back to the newest that does.
    const list = [one, msg(2, "assistant", "no code here")]
    expect(lastCodeBlock(list)).toBe("echo one")
    // A newer fence wins over an older one.
    const newer = msg(3, "assistant", "```\nnewest\n```")
    expect(lastCodeBlock([one, newer])).toBe("newest")
    // An empty/unclosed fence is skipped, not treated as a block.
    expect(lastCodeBlock([msg(4, "assistant", "```\n\n```")])).toBeNull()
  })
})
