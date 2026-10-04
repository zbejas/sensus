import { describe, expect, test } from "bun:test"
import { defaultKeyAliases, defaultKeymap, findAction, keyEventToSpec, matchKey, parseKeySpec, resolveKeymap, specLabel, type KeyActionId } from "../../../src/core/keymap.ts"

const key = (
  name: string,
  flags: { ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } = {},
) => ({
  name,
  ctrl: flags.ctrl ?? false,
  meta: flags.meta ?? false,
  shift: flags.shift ?? false,
  sequence: flags.sequence ?? name,
})

describe("keymap", () => {
  test("parseKeySpec: modifier forms parse, alt+punctuation gains a sequence fallback, malformed specs throw; specLabel mirrors the syntax", () => {
    expect(parseKeySpec("shift+tab")).toEqual({ name: "tab", shift: true })
    expect(parseKeySpec("ctrl+t")).toEqual({ name: "t", ctrl: true })
    expect(parseKeySpec("alt+1")).toEqual({ name: "1", meta: true })
    expect(parseKeySpec("a")).toEqual({ name: "a" })
    expect(parseKeySpec("meta+a")).toEqual({ name: "a", meta: true })

    // ESC , parses into an EMPTY key name without the meta flag; only the raw
    // sequence reliably identifies Alt+, / Alt+. (opentui quirk)
    expect(parseKeySpec("alt+,")).toEqual({ name: ",", meta: true, sequence: "\x1b," })
    expect(parseKeySpec("alt+.")).toEqual({ name: ".", meta: true, sequence: "\x1b." })

    expect(() => parseKeySpec("hyper+q")).toThrow()
    expect(() => parseKeySpec("")).toThrow()

    // specLabel is the human hint (command menu rows) and inverts parseKeySpec.
    for (const spec of ["ctrl+o", "shift+tab", "alt+,", "ctrl+p"]) {
      expect(specLabel(parseKeySpec(spec))).toBe(spec)
    }
    expect(specLabel({ name: " " })).toBe("space")
  })

  test("default bindings match their opentui events; unmodified/plain keys do not; findAction routes", () => {
    const km = resolveKeymap()
    const binds: Array<[ReturnType<typeof key>, KeyActionId]> = [
      [key("tab", { shift: true }), "focus-toggle"],
      [key("t", { ctrl: true }), "new-tab"],
      [key("w", { ctrl: true }), "close-tab"],
      [key("p", { ctrl: true }), "open-menu"],
      [key("m", { meta: true }), "open-agents"],
      [key("y", { meta: true }), "toggle-approval"],
      [key("1", { meta: true }), "tab-1"],
      [key("left", { meta: true }), "tab-prev"],
      [key("right", { meta: true }), "tab-next"],
      [key("home", { meta: true }), "toggle-chat-only"],
    ]
    for (const [event, id] of binds) {
      expect(matchKey(event, km[id])).toBe(true)
      expect(findAction(event, km)).toBe(id)
    }
    // Ctrl+Home is the chat's "scroll to top" (routed in chatKeys, NOT the
    // global keymap) — Alt+Home must not swallow it.
    expect(findAction(key("home", { ctrl: true }), km)).toBeNull()
    expect(findAction(key("home"), km)).toBeNull()
    // Alt+1..9 all bound.
    for (let n = 1; n <= 9; n++) {
      expect(matchKey(key(String(n), { meta: true }), km[`tab-${n}` as KeyActionId])).toBe(true)
    }
    // The ESC-prefixed path (empty name, raw sequence) also matches the
    // quirk-bound actions (M6 letters, M10 toggles ride the same KeySpec).
    expect(matchKey(key("", { sequence: "\x1bm" }), km["open-agents"])).toBe(true)
    expect(matchKey(key("", { sequence: "\x1by" }), km["toggle-approval"])).toBe(true)

    // Non-matches: unmodified keys never fire modified bindings, and plain
    // keys route to null (they belong to the focused region).
    expect(matchKey(key("tab"), km["focus-toggle"])).toBe(false)
    expect(matchKey(key("p"), km["open-menu"])).toBe(false)
    expect(matchKey(key("p", { meta: true }), km["open-menu"])).toBe(false)
    expect(matchKey(key("m"), km["open-agents"])).toBe(false)
    expect(matchKey(key(",", { meta: true }), km["sidebar-grow"])).toBe(false)
    expect(findAction(key("x"), km)).toBeNull()
    expect(findAction(key("tab"), km)).toBeNull()
  })

  test("alt+punctuation matches via the raw-sequence fallback (both event parse paths)", () => {
    const km = resolveKeymap()
    // Real opentui parse of ESC , / ESC .: empty name, no meta flag.
    expect(matchKey(key("", { sequence: "\x1b," }), km["sidebar-shrink"])).toBe(true)
    expect(matchKey(key("", { sequence: "\x1b." }), km["sidebar-grow"])).toBe(true)
    // Kitty-style terminals report name+meta normally; both paths match.
    expect(matchKey(key(",", { meta: true }), km["sidebar-shrink"])).toBe(true)
  })

  test("paste aliases: ctrl+shift+v primary, alt+v alias routes; a remap drops the alias", () => {
    const km = resolveKeymap()
    for (const event of [key("v", { ctrl: true, shift: true }), key("v", { meta: true })]) {
      expect(findAction(event, km)).toBe("paste-image")
    }
    // Ctrl+V is deliberately NOT bound (never stolen from the inner app).
    expect(findAction(key("v", { ctrl: true }), km)).toBeNull()
    // The ESC-prefixed alias encoding (opentui quirk) also routes.
    expect(matchKey(key("", { sequence: "\x1bv" }), defaultKeyAliases["paste-image"]![0]!)).toBe(true)

    // Remapping the primary binding makes the alias go quiet.
    const rebound = resolveKeymap({ "paste-image": "alt+p" })
    expect(findAction(key("p", { meta: true }), rebound)).toBe("paste-image")
    expect(findAction(key("v", { ctrl: true, shift: true }), rebound)).toBeNull()
    expect(findAction(key("v", { meta: true }), rebound)).toBeNull()
  })

  test("resolveKeymap: config overrides rebind (unknown ids ignored, malformed kept at default)", () => {
    const km = resolveKeymap({ "new-tab": "ctrl+n", "close-tab": "bogus+9" as never })
    expect(km["new-tab"].name).toBe("n")
    expect(km["new-tab"].ctrl).toBe(true)
    expect(km["close-tab"]).toEqual(defaultKeymap["close-tab"]) // malformed -> default

    const rebound = resolveKeymap({ "open-menu": "alt+k", "open-agents": "alt+n", "bogus-action": "alt+z" } as never)
    expect(matchKey(key("k", { meta: true }), rebound["open-menu"])).toBe(true)
    expect(rebound["open-agents"].name).toBe("n")
    expect(rebound["open-agents"].meta).toBe(true)
  })

  test("keyEventToSpec captures combos, rejects bare letters/modifiers, round-trips through parseKeySpec", () => {
    expect(keyEventToSpec({ name: "o", ctrl: true })).toBe("ctrl+o")
    expect(keyEventToSpec({ name: "tab", shift: true })).toBe("shift+tab")
    expect(keyEventToSpec({ name: "1", meta: true })).toBe("alt+1")
    expect(keyEventToSpec({ name: " ", ctrl: true })).toBe("ctrl+space")
    // A bare printable must never become a global hotkey; a lone modifier is unusable.
    expect(keyEventToSpec({ name: "a" })).toBeNull()
    expect(keyEventToSpec({ name: "shift", shift: true })).toBeNull()
    expect(keyEventToSpec({ name: "" })).toBeNull()
    // The captured string parses back into the same binding.
    expect(matchKey(key("o", { ctrl: true }), parseKeySpec(keyEventToSpec({ name: "o", ctrl: true })!))).toBe(true)
  })

  test("chat-row keyboard parity: Alt+B/R/S bind copy/revert/send-code and do not collide with the existing Alt toggles", () => {
    const km = resolveKeymap()
    const binds: Array<[ReturnType<typeof key>, KeyActionId]> = [
      [key("b", { meta: true }), "copy-message"],
      [key("r", { meta: true }), "revert-message"],
      [key("s", { meta: true }), "send-code-block"],
    ]
    for (const [event, id] of binds) {
      expect(matchKey(event, km[id])).toBe(true)
      expect(findAction(event, km)).toBe(id)
    }
    // The ESC-prefixed encoding (opentui's Alt-punctuation-style path for
    // letters) also routes each one.
    expect(matchKey(key("", { sequence: "\x1bb" }), km["copy-message"])).toBe(true)
    expect(matchKey(key("", { sequence: "\x1br" }), km["revert-message"])).toBe(true)
    expect(matchKey(key("", { sequence: "\x1bs" }), km["send-code-block"])).toBe(true)
    // No collision: Alt+C stays the card-style toggle, and the selection-copy
    // layer owns ctrl+c / ctrl+shift+c (never the keymap).
    expect(findAction(key("c", { meta: true }), km)).toBe("toggle-card-style")
    expect(findAction(key("b", { ctrl: true }), km)).toBeNull()
    expect(findAction(key("c", { ctrl: true, shift: true }), km)).toBeNull()
  })
})
