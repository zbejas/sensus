import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteText, isEnterKey, keyChar, printableKeyText, singleLinePaste } from "../../../src/core/util.ts"

describe("keyChar (printable reconstruction)", () => {
  test("space maps to ' ', shifted letters uppercase, named keys fall through", () => {
    // opentui reports space as the NAME "space" — the single-line editors and
    // the picker filters all rely on this mapping, or spaces cannot be typed.
    expect(keyChar({ name: "space" })).toBe(" ")
    expect(keyChar({ name: "a" })).toBe("a")
    expect(keyChar({ name: "a", shift: true })).toBe("A")
    expect(keyChar({ name: "up" })).toBe("up")
    expect(keyChar({ name: "return" })).toBe("return")
  })

  test("isEnterKey accepts the enter/return/linefeed spellings", () => {
    for (const name of ["enter", "return", "linefeed"]) expect(isEnterKey({ name })).toBe(true)
    expect(isEnterKey({ name: "space" })).toBe(false)
  })
})

describe("printableKeyText (exact typed character — password fields)", () => {
  test("prefers the literal sequence so symbols/spaces survive", () => {
    // opentui may report punctuation by NAME ("period"), which keyChar cannot
    // turn into the character; the raw sequence is exact. A truncated password
    // is why a correct sudo password came back "not accepted".
    expect(printableKeyText({ name: "period", sequence: "." })).toBe(".")
    expect(printableKeyText({ name: "exclam", sequence: "!" })).toBe("!")
    expect(printableKeyText({ name: "space", sequence: " " })).toBe(" ")
    expect(printableKeyText({ name: "at", sequence: "@" })).toBe("@")
    expect(printableKeyText({ name: "a", sequence: "a" })).toBe("a")
    expect(printableKeyText({ name: "a", shift: true, sequence: "A" })).toBe("A")
  })

  test("falls back to keyChar for name-only events and rejects special keys/modifiers", () => {
    expect(printableKeyText({ name: "space" })).toBe(" ")
    expect(printableKeyText({ name: "a", shift: true })).toBe("A")
    // Control/meta chords and special keys are not text.
    expect(printableKeyText({ name: "u", ctrl: true, sequence: "u" })).toBeNull()
    expect(printableKeyText({ name: "x", meta: true, sequence: "x" })).toBeNull()
    expect(printableKeyText({ name: "up", sequence: "\x1b[A" })).toBeNull()
    expect(printableKeyText({ name: "return", sequence: "\r" })).toBeNull()
  })
})

describe("singleLinePaste (overlay fields/filters drop line breaks)", () => {
  test("a terminal paste's trailing newline is stripped, inner text survives", () => {
    // API keys / URLs / single-line filters: a CR or LF would corrupt the value
    // (and a trailing LF must never submit or append a newline).
    expect(singleLinePaste("sk-test-1234\n")).toBe("sk-test-1234")
    expect(singleLinePaste("sk-a\r\nsk-b")).toBe("sk-ask-b")
    expect(singleLinePaste("plain")).toBe("plain")
    expect(singleLinePaste("\r\n")).toBe("")
    // Tabs/other characters are left alone (only line breaks are unsafe here).
    expect(singleLinePaste("a\tb")).toBe("a\tb")
  })
})

describe("atomicWriteText (private config/file writes)", () => {
  test("creates the file 0600 + parent dir 0700; tightens an existing target and .bak to 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "sensus-atomic-"))
    try {
      const dir = join(root, "nested", "deeper")
      const path = join(dir, "config.json")
      const res = atomicWriteText(path, '{"apiKey":"secret"}\n', { bak: true })
      expect(res.ok).toBe(true)
      // config.json holds plaintext API keys: owner-only.
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)

      // A pre-existing world-readable target + backup are tightened in place.
      chmodSync(path, 0o644)
      const bak = `${path}.bak`
      writeFileSync(bak, "old\n")
      chmodSync(bak, 0o644)
      const second = atomicWriteText(path, '{"apiKey":"rotated"}\n', { bak: true })
      expect(second.ok).toBe(true)
      expect(existsSync(bak)).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(bak).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("never throws on an unwritable path (returns an error result)", () => {
    const res = atomicWriteText("/proc/definitely/not/writable.json", "x", { bak: true })
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe("string")
  })
})
