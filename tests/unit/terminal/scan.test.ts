import { describe, expect, test } from "bun:test"
import { StreamScanner, TextRing, parseOsc7 } from "../../../src/terminal/scan.ts"

const TE = new TextEncoder()
const push = (sc: StreamScanner, text: string): void => sc.push(TE.encode(text))

describe("TextRing", () => {
  test("keeps lines oldest -> newest and evicts past capacity", () => {
    const ring = new TextRing(3)
    for (const l of ["a", "b", "c", "d", "e"]) ring.pushLine(l)
    expect(ring.lines()).toEqual(["c", "d", "e"])
    expect(new TextRing(2).lines()).toEqual([])
  })

  test("wraps in place preserving order across many evictions, and clears", () => {
    const ring = new TextRing(4)
    for (let i = 1; i <= 10; i++) ring.pushLine(`l${i}`)
    expect(ring.lines()).toEqual(["l7", "l8", "l9", "l10"])
    // Re-copying must not mutate the ring.
    expect(ring.lines()).toEqual(["l7", "l8", "l9", "l10"])
    ring.clear()
    expect(ring.lines()).toEqual([])
    ring.pushLine("x")
    expect(ring.lines()).toEqual(["x"])
  })

  test("capacity 1 keeps only the newest line", () => {
    const ring = new TextRing(1)
    ring.pushLine("a")
    ring.pushLine("b")
    expect(ring.lines()).toEqual(["b"])
  })
})

describe("StreamScanner plain text", () => {
  test("accumulates printable lines into the ring (CRLF safe)", () => {
    const sc = new StreamScanner()
    push(sc, "hello\r\nworld\r\n")
    expect(sc.ring.lines()).toEqual(["hello", "world"])
  })

  test("tab -> four spaces, backspace pops, CR overwrites in place", () => {
    const sc = new StreamScanner()
    push(sc, "a\tb\n")
    push(sc, "abc\bX\n")
    push(sc, "abc\rXY\n")
    expect(sc.ring.lines()).toEqual(["a    b", "abX", "XYc"])
  })

  test("CSI SGR / cursor sequences are consumed, not rendered into text", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b[31m\x1b[1;1Hred\x1b[0m\n")
    expect(sc.ring.lines()).toEqual(["red"])
  })
})

describe("StreamScanner OSC", () => {
  test("OSC 0/2 set the title (BEL or ST terminated)", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]0;My Title\x07")
    expect(sc.title).toBe("My Title")
    push(sc, "\x1b]2;Second\x1b\\")
    expect(sc.title).toBe("Second")
  })

  test("OSC 7 sets cwd, with or without host, percent-decoded", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]7;file://host/tmp/a%20b\x07")
    expect(sc.cwd).toBe("/tmp/a b")
    push(sc, "\x1b]7;file:///home/user\x07")
    expect(sc.cwd).toBe("/home/user")

    expect(parseOsc7("file://host/tmp/x")).toBe("/tmp/x")
    expect(parseOsc7("file:///tmp/x")).toBe("/tmp/x")
    expect(parseOsc7("file:/tmp/x")).toBe("/tmp/x")
    expect(parseOsc7("file://host")).toBeNull()
    expect(parseOsc7("not-a-url")).toBeNull()
  })

  test("a non-OSC-7 command leaves cwd untouched", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]0;title only\x07")
    expect(sc.cwd).toBeNull()
  })
})

describe("StreamScanner alt screen", () => {
  test("DECSET 47/1047/1049 toggle alternateOn", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b[?1049h")
    expect(sc.alternateOn).toBe(true)
    push(sc, "\x1b[?1049l")
    expect(sc.alternateOn).toBe(false)
    push(sc, "\x1b[?47h")
    expect(sc.alternateOn).toBe(true)
    push(sc, "\x1b[?47l")
    expect(sc.alternateOn).toBe(false)
    push(sc, "\x1b[?1047h")
    expect(sc.alternateOn).toBe(true)
    push(sc, "\x1b[?1047l")
    expect(sc.alternateOn).toBe(false)
  })

  test("unrelated DECSET (mouse) does not flip alternateOn", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b[?1000h\x1b[?1006h")
    expect(sc.alternateOn).toBe(false)
  })
})

describe("StreamScanner DECCKM (application cursor)", () => {
  test("DECSET/DECRST ?1 toggles applicationCursor", () => {
    const sc = new StreamScanner()
    expect(sc.applicationCursor).toBe(false)
    push(sc, "\x1b[?1h")
    expect(sc.applicationCursor).toBe(true)
    push(sc, "\x1b[?1l")
    expect(sc.applicationCursor).toBe(false)
  })

  test("?1 among other private params is detected; other modes do not flip it", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b[?25h\x1b[?1;1049h")
    expect(sc.applicationCursor).toBe(true)
    expect(sc.alternateOn).toBe(true)
    push(sc, "\x1b[?1049l\x1b[?1000l")
    expect(sc.applicationCursor).toBe(true)
  })
})

describe("StreamScanner OSC 133 shell-integration marks", () => {
  test("C marks a command running; D ends it and records the exit code", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]133;C\x07")
    expect(sc.commandRunning).toBe(true)
    push(sc, "\x1b]133;D;0\x07")
    expect(sc.commandRunning).toBe(false)
    expect(sc.lastExitCode).toBe(0)
    push(sc, "\x1b]133;C\x07\x1b]133;D;130\x1b\\")
    expect(sc.commandRunning).toBe(false)
    expect(sc.lastExitCode).toBe(130)
  })

  test("prompt marks A/B reset the flag; a bare D clears the exit code", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]133;C\x07")
    push(sc, "\x1b]133;A\x07")
    expect(sc.commandRunning).toBe(false)
    push(sc, "\x1b]133;D\x07")
    expect(sc.lastExitCode).toBeNull()
  })

  test("reset clears DECCKM and the OSC 133 marks", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]133;D;1\x07\x1b[?1h")
    sc.reset()
    expect(sc.lastExitCode).toBeNull()
    expect(sc.commandRunning).toBe(false)
    expect(sc.applicationCursor).toBe(false)
  })
})

describe("StreamScanner chunk boundaries", () => {
  test("escape sequence split across pushes is reassembled", () => {
    const sc = new StreamScanner()
    const seq = TE.encode("\x1b[?1049h")
    sc.push(seq.slice(0, 3))
    expect(sc.alternateOn).toBe(false)
    sc.push(seq.slice(3))
    expect(sc.alternateOn).toBe(true)

    const osc = TE.encode("\x1b]0;Split\x07")
    sc.push(osc.slice(0, 5))
    expect(sc.title).toBeNull()
    sc.push(osc.slice(5))
    expect(sc.title).toBe("Split")
  })

  test("UTF-8 multibyte split across pushes is decoded intact", () => {
    const sc = new StreamScanner()
    const bytes = TE.encode("世\n")
    expect(bytes.length).toBeGreaterThan(1)
    sc.push(bytes.slice(0, 1))
    sc.push(bytes.slice(1))
    expect(sc.ring.lines()).toEqual(["世"])
  })
})

describe("StreamScanner malformed input never throws", () => {
  test("truncated escapes carry over and resume cleanly", () => {
    const sc = new StreamScanner()
    expect(() => push(sc, "\x1b")).not.toThrow()
    push(sc, "[31mred\n")
    expect(sc.ring.lines()).toEqual(["red"])
  })

  test("unknown CSI final is consumed without corrupting following text", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b[999zok\n")
    expect(sc.ring.lines()).toEqual(["ok"])
  })

  test("unterminated DCS is held until ST, then text resumes", () => {
    const sc = new StreamScanner()
    expect(() => push(sc, "\x1bP1;2|payload")).not.toThrow()
    expect(sc.ring.lines()).toEqual([])
    push(sc, "\x1b\\tail\n")
    expect(sc.ring.lines()).toEqual(["tail"])
  })

  test("reset clears state", () => {
    const sc = new StreamScanner()
    push(sc, "\x1b]0;T\x07\x1b[?1049hhello\n")
    sc.reset()
    expect(sc.title).toBeNull()
    expect(sc.alternateOn).toBe(false)
    expect(sc.ring.lines()).toEqual([])
  })
})
