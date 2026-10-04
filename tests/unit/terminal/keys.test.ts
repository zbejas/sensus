import { describe, expect, test } from "bun:test"
import {
  agentKeyAction,
  encodeKeyAction,
  encodeNamedKey,
  installFunctionKeyEncoding,
  mapKeyEventToAction,
  pasteAction,
  type KeyAction,
  type KeyInfo,
} from "../../../src/terminal/keys.ts"

const key = (name: string, flags: Partial<KeyInfo> = {}): KeyInfo => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  sequence: name,
  ...flags,
})

const bytes = (u: Uint8Array): number[] => [...u]

describe("mapKeyEventToAction", () => {
  test("printable keys map to literals (incl. the opentui shifted-letter quirk)", () => {
    const cases: Array<[KeyInfo, KeyAction]> = [
      [key("a"), { kind: "literal", text: "a" }],
      [key("9"), { kind: "literal", text: "9" }],
      [key("!"), { kind: "literal", text: "!" }],
      [key("space"), { kind: "literal", text: " " }],
      // opentui reports capital 'S' as { name: "s", shift: true }.
      [key("s", { shift: true }), { kind: "literal", text: "S" }],
      [key("a", { shift: true }), { kind: "literal", text: "A" }],
    ]
    for (const [input, expected] of cases) {
      expect(mapKeyEventToAction(input)).toEqual(expected)
    }
  })

  test("named keys + modifier combos keep the tmux spellings; unrepresentable keys drop", () => {
    const cases: Array<[KeyInfo, KeyAction | null]> = [
      [key("return"), { kind: "keys", names: ["Enter"] }],
      [key("enter"), { kind: "keys", names: ["Enter"] }],
      [key("tab"), { kind: "keys", names: ["Tab"] }],
      [key("backspace"), { kind: "keys", names: ["BSpace"] }],
      [key("escape"), { kind: "keys", names: ["Escape"] }],
      [key("up"), { kind: "keys", names: ["Up"] }],
      [key("down"), { kind: "keys", names: ["Down"] }],
      [key("left"), { kind: "keys", names: ["Left"] }],
      [key("right"), { kind: "keys", names: ["Right"] }],
      [key("home"), { kind: "keys", names: ["Home"] }],
      [key("end"), { kind: "keys", names: ["End"] }],
      [key("pageup"), { kind: "keys", names: ["PageUp"] }],
      [key("pagedown"), { kind: "keys", names: ["PageDown"] }],
      [key("insert"), { kind: "keys", names: ["Insert"] }],
      [key("delete"), { kind: "keys", names: ["Delete"] }],
      [key("f5"), { kind: "keys", names: ["F5"] }],
      [key("f12"), { kind: "keys", names: ["F12"] }],
      [key("c", { ctrl: true }), { kind: "keys", names: ["C-C"] }],
      [key("a", { ctrl: true }), { kind: "keys", names: ["C-A"] }],
      [key("left", { ctrl: true }), { kind: "keys", names: ["C-Left"] }],
      [key("space", { ctrl: true }), { kind: "keys", names: ["C-Space"] }],
      [key("x", { meta: true }), { kind: "keys", names: ["M-X"] }],
      [key("up", { ctrl: true, meta: true }), { kind: "keys", names: ["C-M-Up"] }],
      [key("up", { shift: true }), { kind: "keys", names: ["S-Up"] }],
      [key("tab", { shift: true }), { kind: "keys", names: ["S-Tab"] }],
      [key("enter", { meta: true }), { kind: "keys", names: ["M-Enter"] }],
      [key("menu"), null],
      [key(""), null],
    ]
    for (const [input, expected] of cases) {
      expect(mapKeyEventToAction(input)).toEqual(expected)
    }
  })
})

describe("encodeNamedKey / encodeKeyAction (raw PTY bytes)", () => {
  test("base named keys encode to their xterm sequences", () => {
    const cases: Array<[string, number[]]> = [
      ["Enter", [0x0d]],
      ["return", [0x0d]],
      ["Tab", [0x09]],
      ["tab", [0x09]],
      ["BTab", [0x1b, 0x5b, 0x5a]],
      ["S-Tab", [0x1b, 0x5b, 0x5a]],
      ["BSpace", [0x7f]],
      ["backspace", [0x7f]],
      ["Escape", [0x1b]],
      ["space", [0x20]],
      ["Space", [0x20]],
      ["Up", [0x1b, 0x5b, 0x41]],
      ["Down", [0x1b, 0x5b, 0x42]],
      ["Right", [0x1b, 0x5b, 0x43]],
      ["Left", [0x1b, 0x5b, 0x44]],
      ["Home", [0x1b, 0x5b, 0x48]],
      ["End", [0x1b, 0x5b, 0x46]],
      ["PageUp", [0x1b, 0x5b, 0x35, 0x7e]],
      ["PPage", [0x1b, 0x5b, 0x35, 0x7e]],
      ["PageDown", [0x1b, 0x5b, 0x36, 0x7e]],
      ["NPage", [0x1b, 0x5b, 0x36, 0x7e]],
      ["Delete", [0x1b, 0x5b, 0x33, 0x7e]],
      ["Insert", [0x1b, 0x5b, 0x32, 0x7e]],
      ["IC", [0x1b, 0x5b, 0x32, 0x7e]],
      ["F1", [0x1b, 0x4f, 0x50]],
      ["F2", [0x1b, 0x4f, 0x51]],
      ["F3", [0x1b, 0x4f, 0x52]],
      ["F4", [0x1b, 0x4f, 0x53]],
      ["F5", [0x1b, 0x5b, 0x31, 0x35, 0x7e]],
      ["F6", [0x1b, 0x5b, 0x31, 0x37, 0x7e]],
      ["F7", [0x1b, 0x5b, 0x31, 0x38, 0x7e]],
      ["F8", [0x1b, 0x5b, 0x31, 0x39, 0x7e]],
      ["F9", [0x1b, 0x5b, 0x32, 0x30, 0x7e]],
      ["F10", [0x1b, 0x5b, 0x32, 0x31, 0x7e]],
      ["F11", [0x1b, 0x5b, 0x32, 0x33, 0x7e]],
      ["F12", [0x1b, 0x5b, 0x32, 0x34, 0x7e]],
    ]
    for (const [name, expected] of cases) {
      expect(bytes(encodeKeyAction({ kind: "keys", names: [name] }))).toEqual(expected)
      expect(bytes(encodeNamedKey(name) ?? new Uint8Array())).toEqual(expected)
    }
  })

  test("literal text is UTF-8; modifier combos encode correctly", () => {
    expect(bytes(encodeKeyAction({ kind: "literal", text: "hi" }))).toEqual([0x68, 0x69])
    expect(bytes(encodeKeyAction({ kind: "literal", text: "世" }))).toEqual([0xe4, 0xb8, 0x96])
    expect(bytes(encodeKeyAction({ kind: "literal", text: "" }))).toEqual([])

    const combos: Array<[string, number[]]> = [
      ["C-A", [0x01]],
      ["C-C", [0x03]],
      ["C-?", [0x7f]],
      ["C-@", [0x00]],
      ["C-Space", [0x00]],
      ["M-X", [0x1b, 0x78]],
      ["M-a", [0x1b, 0x61]],
      ["C-M-X", [0x1b, 0x18]],
      ["S-X", [0x58]],
      // Named key + modifier goes through the xterm CSI modifier parameter.
      ["C-Left", [0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44]],
      ["M-Enter", [0x1b, 0x0d]],
    ]
    for (const [name, expected] of combos) {
      expect(bytes(encodeKeyAction({ kind: "keys", names: [name] }))).toEqual(expected)
    }
  })

  test("known names concatenate; unknown names are skipped (never thrown)", () => {
    expect(bytes(encodeKeyAction({ kind: "keys", names: ["Enter", "Tab"] }))).toEqual([0x0d, 0x09])
    expect(bytes(encodeKeyAction({ kind: "keys", names: ["menu", "Enter", "nope"] }))).toEqual([0x0d])
    expect(bytes(encodeKeyAction({ kind: "keys", names: ["menu"] }))).toEqual([])
    expect(encodeNamedKey("menu")).toBeNull()
    expect(encodeNamedKey("")).toBeNull()
  })

  test("round-trips mapKeyEventToAction output", () => {
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("x", { meta: true }))!))).toEqual([0x1b, 0x78])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("c", { ctrl: true }))!))).toEqual([0x03])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("a", { ctrl: true }))!))).toEqual([0x01])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("tab", { shift: true }))!))).toEqual([0x1b, 0x5b, 0x5a])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("up"))!))).toEqual([0x1b, 0x5b, 0x41])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("f5"))!))).toEqual([0x1b, 0x5b, 0x31, 0x35, 0x7e])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("s", { shift: true }))!))).toEqual([0x53])
    expect(bytes(encodeKeyAction(mapKeyEventToAction(key("space"))!))).toEqual([0x20])
  })
})

describe("agentKeyAction", () => {
  test("accepted spellings map to the same actions as the tmux encoder", () => {
    const cases: Array<[string, KeyAction | null]> = [
      ["enter", { kind: "keys", names: ["Enter"] }],
      ["ENTER", { kind: "keys", names: ["Enter"] }],
      ["return", { kind: "keys", names: ["Enter"] }],
      ["tab", { kind: "keys", names: ["Tab"] }],
      ["esc", { kind: "keys", names: ["Escape"] }],
      ["backspace", { kind: "keys", names: ["BSpace"] }],
      ["pageup", { kind: "keys", names: ["PageUp"] }],
      ["pgup", { kind: "keys", names: ["PageUp"] }],
      ["pgdn", { kind: "keys", names: ["PageDown"] }],
      ["del", { kind: "keys", names: ["Delete"] }],
      ["ins", { kind: "keys", names: ["Insert"] }],
      ["f12", { kind: "keys", names: ["F12"] }],
      ["ctrl+c", { kind: "keys", names: ["C-C"] }],
      ["c-c", { kind: "keys", names: ["C-C"] }],
      ["control+c", { kind: "keys", names: ["C-C"] }],
      ["alt+x", { kind: "keys", names: ["M-X"] }],
      ["m-x", { kind: "keys", names: ["M-X"] }],
      ["shift+tab", { kind: "keys", names: ["S-Tab"] }],
      ["s-tab", { kind: "keys", names: ["S-Tab"] }],
      ["ctrl+alt+del", { kind: "keys", names: ["C-M-Delete"] }],
      ["a", { kind: "literal", text: "a" }],
      ["shift+a", { kind: "literal", text: "A" }],
      ["bogus", null],
      ["", null],
    ]
    for (const [raw, expected] of cases) {
      expect(agentKeyAction(raw)).toEqual(expected)
    }
  })

  test("agent actions encode to the expected bytes", () => {
    expect(bytes(encodeKeyAction(agentKeyAction("ctrl+c")!))).toEqual([0x03])
    expect(bytes(encodeKeyAction(agentKeyAction("enter")!))).toEqual([0x0d])
    expect(bytes(encodeKeyAction(agentKeyAction("shift+tab")!))).toEqual([0x1b, 0x5b, 0x5a])
    expect(bytes(encodeKeyAction(agentKeyAction("alt+x")!))).toEqual([0x1b, 0x78])
    expect(bytes(encodeKeyAction(agentKeyAction("ctrl+alt+del")!))).toEqual([0x1b, 0x5b, 0x33, 0x3b, 0x37, 0x7e])
  })
})

describe("pasteAction", () => {
  test("paste is a single literal action (multiline preserved)", () => {
    expect(pasteAction("line1\nline2\n")).toEqual({ kind: "literal", text: "line1\nline2\n" })
    expect(bytes(encodeKeyAction(pasteAction("hi")))).toEqual([0x68, 0x69])
    expect(bytes(encodeKeyAction(pasteAction("a\nb")))).toEqual([0x61, 0x0a, 0x62])
  })
})

describe("installFunctionKeyEncoding (F1–F12 native patch)", () => {
  test("F-keys get the native physical name; other keys pass through untouched", () => {
    const seen: Array<{ name: string; code: string | undefined }> = []
    const fake = {
      encodeKey(key: { name: string; code?: string }): Uint8Array {
        seen.push({ name: key.name, code: key.code })
        return Uint8Array.from([0xaa])
      },
    }
    installFunctionKeyEncoding(fake)

    // Legacy SS3 F1 parses with code "OP"; F5 with the raw CSI string the
    // renderable's physicalKey() rejects; a kitty event may carry no code.
    expect([...fake.encodeKey({ name: "f1", code: "OP" })]).toEqual([0xaa])
    const f5 = { name: "f5", code: "[15~" }
    fake.encodeKey(f5)
    fake.encodeKey({ name: "f12" })
    fake.encodeKey({ name: "up", code: "OA" })

    expect(seen).toEqual([
      { name: "f1", code: "F1" },
      { name: "f5", code: "F5" },
      { name: "f12", code: "F12" },
      { name: "up", code: "OA" },
    ])
    // The live event is restored after the native call.
    expect(f5.code).toBe("[15~")
  })
})

describe("application cursor mode (DECCKM)", () => {
  test("unmodified arrows/Home/End emit SS3 when enabled, CSI otherwise", () => {
    const cases: Array<[string, number[], number[]]> = [
      ["Up", [0x1b, 0x5b, 0x41], [0x1b, 0x4f, 0x41]],
      ["Down", [0x1b, 0x5b, 0x42], [0x1b, 0x4f, 0x42]],
      ["Right", [0x1b, 0x5b, 0x43], [0x1b, 0x4f, 0x43]],
      ["Left", [0x1b, 0x5b, 0x44], [0x1b, 0x4f, 0x44]],
      ["Home", [0x1b, 0x5b, 0x48], [0x1b, 0x4f, 0x48]],
      ["End", [0x1b, 0x5b, 0x46], [0x1b, 0x4f, 0x46]],
    ]
    for (const [name, csi, ss3] of cases) {
      expect(bytes(encodeNamedKey(name, { applicationCursor: true }) ?? new Uint8Array())).toEqual(ss3)
      expect(bytes(encodeKeyAction({ kind: "keys", names: [name] }, { applicationCursor: true }))).toEqual(ss3)
      // Default (and explicit false) stay on the CSI form.
      expect(bytes(encodeNamedKey(name) ?? new Uint8Array())).toEqual(csi)
      expect(bytes(encodeNamedKey(name, { applicationCursor: false }) ?? new Uint8Array())).toEqual(csi)
    }
  })

  test("modified nav keys and unrelated keys are unaffected by DECCKM", () => {
    // Modified arrows keep the xterm CSI modifier parameter even in DECCKM.
    expect(bytes(encodeNamedKey("C-Up", { applicationCursor: true }) ?? new Uint8Array())).toEqual([
      0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41,
    ])
    expect(bytes(encodeNamedKey("S-Left", { applicationCursor: true }) ?? new Uint8Array())).toEqual([
      0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44,
    ])
    // F1-F4 are already SS3; PageUp/Down are `~`-final.
    expect(bytes(encodeNamedKey("F1", { applicationCursor: true }) ?? new Uint8Array())).toEqual([0x1b, 0x4f, 0x50])
    expect(bytes(encodeNamedKey("PageUp", { applicationCursor: true }) ?? new Uint8Array())).toEqual([
      0x1b, 0x5b, 0x35, 0x7e,
    ])
    expect(bytes(encodeKeyAction({ kind: "literal", text: "a" }, { applicationCursor: true }))).toEqual([0x61])
  })
})
