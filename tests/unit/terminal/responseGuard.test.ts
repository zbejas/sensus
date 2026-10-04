import { describe, expect, test } from "bun:test"
import {
  looksLikeTerminalResponse,
  ResponseLeakGuard,
} from "../../../src/terminal/responseGuard.ts"

const TE = new TextEncoder()
const dec = (b: Uint8Array): string => Buffer.from(b).toString("latin1")

/** Push a plain string one character at a time (the parser's leak shape). */
function pushChars(guard: ResponseLeakGuard, text: string, now?: number): string {
  let out = ""
  for (const ch of text) out += dec(guard.push(TE.encode(ch), now))
  return out
}

describe("looksLikeTerminalResponse", () => {
  test("recognises the reply shapes users see leaked on the prompt", () => {
    for (const run of [
      ":ffff/ffff/ffff",
      ":ffff/ffff/ffff0c",
      "rgb:ffff/ffff/ffff",
      "]11;rgb:ffff/ffff/ffff",
      "10;rgb:ffff/ffff/ffff",
      "4;0;rgb:1e1e/1e1e/1e1e",
      "#ffffff",
      ";12R",
      "[4;1080;1920t",
      "[?62;c",
      "P>|Windows Terminal",
    ]) {
      expect(looksLikeTerminalResponse(run)).toBe(true)
    }
  })

  test("does not match ordinary input", () => {
    for (const run of [
      ":wq",
      ":123",
      "#fff",
      "#123",
      "[a",
      "[1]",
      "hello",
      "deadbeef",
      "cat",
      "rgb(false)",
      "[1;2",
    ]) {
      expect(looksLikeTerminalResponse(run)).toBe(false)
    }
  })
})

describe("ResponseLeakGuard", () => {
  test("drops a leaked colour-triplet tail (the reported `:ffff/...` leak)", () => {
    const g = new ResponseLeakGuard()
    expect(pushChars(g, ":ffff/ffff/ffff")).toBe("")
    expect(g.pending).toBe(true)
    expect(dec(g.flush(0))).toBe("")
    expect(g.pending).toBe(false)
  })

  test("swallows a residual tail arriving after the idle flush (the `0c` report)", () => {
    const g = new ResponseLeakGuard()
    pushChars(g, ":ffff/ffff/ffff")
    // Idle timer resolves the reply run and opens the tail window.
    expect(dec(g.flush(1000, true))).toBe("")
    expect(g.tailActive).toBe(true)
    // The residual bytes arrive in a later read and no longer carry a marker.
    expect(dec(g.push(TE.encode("0"), 1050))).toBe("")
    expect(dec(g.push(TE.encode("c"), 1051))).toBe("")
    expect(g.tailActive).toBe(true)
    // A real keystroke ends the window and passes.
    expect(dec(g.push(TE.encode("l"), 1100))).toBe("l")
    expect(g.tailActive).toBe(false)
  })

  test("the tail window expires so later typing is untouched", () => {
    const g = new ResponseLeakGuard()
    pushChars(g, ":ffff/ffff/ffff")
    g.flush(1000, true) // window open until 1500
    expect(dec(g.push(TE.encode("0c"), 1100))).toBe("")
    expect(pushChars(g, "ls", 2000)).toBe("ls")
    expect(g.tailActive).toBe(false)
  })

  test("an encoded key ends the tail window", () => {
    const g = new ResponseLeakGuard()
    pushChars(g, ":ffff/ffff/ffff")
    g.flush(0, true)
    expect(dec(g.push(TE.encode("\x1b[A"), 10))).toBe("\x1b[A")
    expect(g.tailActive).toBe(false)
  })

  test("drops a leaked OSC reply tail once the leading bracket is present", () => {
    const g = new ResponseLeakGuard()
    expect(pushChars(g, "]11;rgb:ffff/ffff/ffff")).toBe("")
    expect(dec(g.flush())).toBe("")
  })

  test("drops a leaked CSI reply tail", () => {
    const g = new ResponseLeakGuard()
    expect(pushChars(g, "[4;1080;1920t")).toBe("")
    expect(dec(g.flush())).toBe("")
  })

  test("encoded key/paste/mouse chunks (starting with ESC) pass untouched", () => {
    const g = new ResponseLeakGuard()
    for (const seq of ["\x1b[A", "\x1b[1;5C", "\x1b[200~hi\x1b[201~", "\x1b[<0;3;4M"]) {
      expect(dec(g.push(TE.encode(seq)))).toBe(seq)
    }
    // A flushed lone ESC is its own event and is passed as the Escape key.
    expect(dec(g.push(TE.encode("\x1b")))).toBe("\x1b")
  })

  test("ordinary typing passes with no hold", () => {
    const g = new ResponseLeakGuard()
    expect(pushChars(g, "hello")).toBe("hello")
    expect(g.pending).toBe(false)
    expect(pushChars(g, "cat file1")).toBe("cat file1")
  })

  test("a non-reply run that starts with a marker is released", () => {
    const g = new ResponseLeakGuard()
    expect(pushChars(g, ":wq")).toBe("")
    expect(g.pending).toBe(true)
    expect(dec(g.flush())).toBe(":wq")
    expect(g.pending).toBe(false)
  })

  test("a held run is released before a following encoded key, in order", () => {
    const g = new ResponseLeakGuard()
    g.push(TE.encode(":"))
    const out = dec(g.push(TE.encode("\x1b[A")))
    expect(out).toBe(":\x1b[A")
    expect(g.pending).toBe(false)
  })

  test("a leaked reply does not merge with later genuine input", () => {
    const g = new ResponseLeakGuard()
    pushChars(g, ":ffff/ffff/ffff")
    expect(dec(g.flush())).toBe("")
    // The shell's next real keys arrive after the idle window and pass.
    expect(pushChars(g, "ls")).toBe("ls")
  })

  test("#fff is ordinary input; #ffffff is a reply", () => {
    const g = new ResponseLeakGuard()
    expect(pushChars(g, "#fff!")).toBe("#fff!")
    expect(pushChars(g, "#ffffff")).toBe("")
    expect(dec(g.flush())).toBe("")
  })

  test("never throws on arbitrary bytes", () => {
    const g = new ResponseLeakGuard()
    const bytes = Uint8Array.from([0x00, 0xff, 0x7f, 0x1b, 0xc3, 0xa9, 0x3a, 0x2f])
    expect(() => g.push(bytes)).not.toThrow()
    expect(() => g.flush()).not.toThrow()
  })
})
