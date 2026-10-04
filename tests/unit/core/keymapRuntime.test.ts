/**
 * Tests for the @opentui/keymap integration glue (keymapRuntime.ts).
 *
 * The integration tests run against a minimal hand-rolled KeymapHost (the
 * same small interface the opentui adapter implements) so tests can dispatch
 * custom events — including opentui's Alt+punctuation quirk (ESC , arrives as
 * an EMPTY name with no meta flag) which the keymap testing harness's events
 * cannot express. Listener order mirrors opentui's emitWithPriority: the
 * keymap's own listener (registered at Keymap construction) runs first, a
 * later-registered probe stands in for App's useKeyboard, and a consumed
 * event (propagationStopped) stops the chain.
 */

import { describe, expect, test } from "bun:test"
import type { KeymapHost } from "@opentui/keymap"
import { Keymap } from "@opentui/keymap"
import { defaultKeymap, parseKeySpec, type KeyActionId, type KeySpec } from "../../../src/core/keymap.ts"
import {
  configureSensusKeymap,
  enableModifyOtherKeysLevel2,
  installGlobalKeyLayer,
  strokeFromAltSequence,
  toBindingKey,
} from "../../../src/core/keymapRuntime.ts"

// ---- fake host ------------------------------------------------------------

// Standalone shape: structurally satisfies KeymapEvent (mutable
// propagationStopped satisfies its readonly member) while keeping the flags
// writable for the fake dispatch.
interface FakeEvent {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
  sequence?: string
  defaultPrevented: boolean
  propagationStopped: boolean
  preventDefault(): void
  stopPropagation(): void
}

interface FakeTarget {
  id: string
  isDestroyed: boolean
}

const ROOT: FakeTarget = { id: "root", isDestroyed: false }

function makeEvent(
  name: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
  sequence?: string,
): FakeEvent {
  const event: FakeEvent = {
    name,
    ctrl: mods.ctrl ?? false,
    shift: mods.shift ?? false,
    meta: mods.meta ?? false,
    super: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      event.propagationStopped = true
    },
  }
  if (sequence !== undefined) event.sequence = sequence
  return event
}

function makeHost(): {
  host: KeymapHost<FakeTarget, FakeEvent>
  press: Array<(event: FakeEvent) => void>
} {
  const press: Array<(event: FakeEvent) => void> = []
  const host: KeymapHost<FakeTarget, FakeEvent> = {
    metadata: {
      platform: "linux",
      primaryModifier: "ctrl",
      modifiers: {
        ctrl: "supported",
        shift: "supported",
        meta: "supported",
        super: "unknown",
        hyper: "unknown",
      },
    },
    rootTarget: ROOT,
    isDestroyed: false,
    getFocusedTarget: () => null,
    getParentTarget: () => null,
    isTargetDestroyed: () => false,
    onKeyPress(listener) {
      press.push(listener)
      return () => {}
    },
    onKeyRelease: () => () => {},
    onFocusChange: () => () => {},
    onTargetDestroy: () => () => {},
    createCommandEvent: () => makeEvent("command"),
  }
  return { host, press }
}

/** Dispatch like opentui's emitWithPriority: run listeners in order, stop
 * when the event's propagation is stopped (consumed upstream). */
function dispatch(listeners: Array<(event: FakeEvent) => void>, event: FakeEvent): void {
  for (const listener of listeners) {
    listener(event)
    if (event.propagationStopped) return
  }
}

/** Full stack mirroring production: bare Keymap + configureSensusKeymap +
 * the global hotkey layer. `run` dispatches through the keymap's listener
 * (registered first) and then the probe (App's useKeyboard stand-in), which
 * only sees keys the keymap did not consume. */
function setupLayer(opts: {
  gate?: () => boolean
  resolved?: Record<KeyActionId, KeySpec>
}): {
  run(event: FakeEvent): void
  probed(): boolean
  actions(): KeyActionId[]
} {
  const { host, press } = makeHost()
  const keymap = new Keymap<FakeTarget, FakeEvent>(host)
  configureSensusKeymap(keymap)
  const seen: KeyActionId[] = []
  installGlobalKeyLayer(keymap, {
    gate: opts.gate,
    resolved: opts.resolved,
    onAction: (action) => seen.push(action),
  })
  let probeSeen = false
  host.onKeyPress(() => {
    probeSeen = true
  })
  return {
    run: (event) => {
      probeSeen = false
      dispatch(press, event)
    },
    probed: () => probeSeen,
    actions: () => seen,
  }
}

// ---- tests ----------------------------------------------------------------

describe("keymapRuntime", () => {
  test("pure helpers: toBindingKey spells strokes for the binding language; strokeFromAltSequence accepts only ESC+punctuation", () => {
    expect(toBindingKey({ name: "t", ctrl: true })).toBe("ctrl+t")
    expect(toBindingKey({ name: "tab", shift: true })).toBe("shift+tab")
    expect(toBindingKey({ name: ",", meta: true })).toBe("alt+comma")
    expect(toBindingKey({ name: ".", meta: true })).toBe("alt+period")
    expect(toBindingKey({ name: "a", meta: true })).toBe("alt+a")
    expect(toBindingKey({ name: "1", meta: true })).toBe("alt+1")
    expect(toBindingKey({ name: "a", ctrl: true })).toBe("ctrl+a")

    // ESC + punctuation maps onto the named stroke with meta...
    expect(strokeFromAltSequence("\x1b,")).toEqual({ name: "comma", meta: true })
    expect(strokeFromAltSequence("\x1b.")).toEqual({ name: "period", meta: true })
    expect(strokeFromAltSequence("\x1b[")).toEqual({ name: "leftbracket", meta: true })
    // ...letters/digits (opentui parses those with meta set), lone ESC,
    // longer sequences and undefined are all rejected.
    for (const bad of ["\x1ba", "\x1b1", "\x1b", "\x1b\x1b", "ab", "", undefined]) {
      expect(strokeFromAltSequence(bad)).toBeNull()
    }
  })

  test("enableModifyOtherKeysLevel2 writes the exact level-2 sequence and never throws", () => {
    // Boot emits this xterm mode sequence so terminals without the kitty
    // protocol report Shift+Enter (docs/keybindings.md "Gotchas"); a failing
    // stdout write must never crash boot.
    const writes: string[] = []
    enableModifyOtherKeysLevel2((s) => writes.push(s))
    expect(writes).toEqual(["\x1b[>4;2m"])
    expect(() =>
      enableModifyOtherKeysLevel2(() => {
        throw new Error("EPIPE")
      }),
    ).not.toThrow()
  })

  test("matched hotkeys run + are consumed before App's probe; unmatched keys fall through; config overrides rebind", () => {
    const layer = setupLayer({})
    layer.run(makeEvent("t", { ctrl: true }))
    expect(layer.actions()).toEqual(["new-tab"])
    expect(layer.probed()).toBe(false) // consumed upstream

    const plain = setupLayer({})
    plain.run(makeEvent("x"))
    expect(plain.actions()).toEqual([])
    expect(plain.probed()).toBe(true) // unconsumed fall-through

    // A config override rebinds the action AND unbinds the default key.
    const resolved: Record<KeyActionId, KeySpec> = {
      ...defaultKeymap,
      "new-tab": parseKeySpec("ctrl+u"),
    }
    const rebound = setupLayer({ resolved })
    rebound.run(makeEvent("u", { ctrl: true }))
    expect(rebound.actions()).toEqual(["new-tab"])
    rebound.run(makeEvent("t", { ctrl: true }))
    expect(rebound.actions()).toEqual(["new-tab"])
    expect(rebound.probed()).toBe(true) // ctrl+t no longer bound
  })

  test("gate: the layer goes inert while an overlay is open or the prefix is armed (keys reach App instead)", () => {
    // Overlay open: hotkeys fall through; closing the overlay re-arms the layer.
    let open = true
    const overlay = setupLayer({ gate: () => !open })
    overlay.run(makeEvent("t", { ctrl: true }))
    expect(overlay.actions()).toEqual([])
    expect(overlay.probed()).toBe(true)
    open = false
    overlay.run(makeEvent("t", { ctrl: true }))
    expect(overlay.actions()).toEqual(["new-tab"])
    expect(overlay.probed()).toBe(false)

    // Prefix: ctrl+a arms via the command; the SECOND key falls through so
    // App's prefix.secondKey routing sees it.
    let armed = false
    const prefix = setupLayer({ gate: () => !armed })
    prefix.run(makeEvent("a", { ctrl: true }))
    expect(prefix.actions()).toEqual(["prefix"])
    armed = true // App's gate mirrors prefix.isArmed
    prefix.run(makeEvent("t", { ctrl: true }))
    expect(prefix.actions()).toEqual(["prefix"])
    expect(prefix.probed()).toBe(true)
  })

  test("Alt+punctuation quirk: raw-sequence events match through the stack; Alt+letter and shift+tab keep the default path", () => {
    const layer = setupLayer({})
    // opentui parses alt+, into name:"" with no meta; the two-byte sequence
    // is the discriminator the appended resolver maps onto "alt+comma".
    layer.run(makeEvent("", {}, "\x1b,"))
    expect(layer.actions()).toEqual(["sidebar-shrink"])
    expect(layer.probed()).toBe(false)
    layer.run(makeEvent("", {}, "\x1b."))
    expect(layer.actions()).toEqual(["sidebar-shrink", "sidebar-grow"])

    // Letters/digits parse normally through the default resolver...
    layer.run(makeEvent("a", { meta: true }))
    expect(layer.actions()).toEqual(["sidebar-shrink", "sidebar-grow", "focus-sidebar"])
    layer.run(makeEvent("1", { meta: true }))
    expect(layer.actions()).toEqual(["sidebar-shrink", "sidebar-grow", "focus-sidebar", "tab-1"])
    // ...and the stock shift+tab match survives the replaced resolver.
    layer.run(makeEvent("tab", { shift: true }))
    expect(layer.actions()).toEqual(["sidebar-shrink", "sidebar-grow", "focus-sidebar", "tab-1", "focus-toggle"])
  })

  test("Alt+punctuation under an extended keyboard protocol (Kitty/modifyOtherKeys) aliases to the punctuation stroke", () => {
    const layer = setupLayer({})
    // Kitty encodes Alt+. as codepoint 46 (".") with the alt modifier; the
    // binding language calls that stroke "period". Same for Alt+, -> comma
    // and the other punctuation names.
    layer.run(makeEvent(".", { meta: true }, "\x1b[46;3u"))
    expect(layer.actions()).toEqual(["sidebar-grow"])
    layer.run(makeEvent(",", { meta: true }, "\x1b[44;3u"))
    expect(layer.actions()).toEqual(["sidebar-grow", "sidebar-shrink"])
    // xterm modifyOtherKeys path (name is the literal char with meta).
    layer.run(makeEvent(".", { meta: true }))
    expect(layer.actions()).toEqual(["sidebar-grow", "sidebar-shrink", "sidebar-grow"])

    // A bare "." (no modifier) is still ordinary chat/pane input.
    const plain = setupLayer({})
    plain.run(makeEvent("."))
    expect(plain.actions()).toEqual([])
    expect(plain.probed()).toBe(true)
  })

  test("paste: ctrl+shift+v primary and alt+v alias run paste-image; ctrl+v falls through; a primary remap drops the alias", () => {
    const layer = setupLayer({})
    layer.run(makeEvent("v", { ctrl: true, shift: true }))
    expect(layer.actions()).toEqual(["paste-image"])
    expect(layer.probed()).toBe(false)
    layer.run(makeEvent("v", { meta: true }))
    expect(layer.actions()).toEqual(["paste-image", "paste-image"])

    // Ctrl+V is NOT bound: it falls through to the focused region.
    layer.run(makeEvent("v", { ctrl: true }))
    expect(layer.actions()).toEqual(["paste-image", "paste-image"])
    expect(layer.probed()).toBe(true)

    // Remapping the primary binding unbinds the alias too.
    const resolved: Record<KeyActionId, KeySpec> = {
      ...defaultKeymap,
      "paste-image": parseKeySpec("alt+p"),
    }
    const rebound = setupLayer({ resolved })
    rebound.run(makeEvent("v", { ctrl: true, shift: true }))
    expect(rebound.actions()).toEqual([])
    expect(rebound.probed()).toBe(true)
    rebound.run(makeEvent("v", { meta: true }))
    expect(rebound.actions()).toEqual([])
    expect(rebound.probed()).toBe(true)
    rebound.run(makeEvent("p", { meta: true }))
    expect(rebound.actions()).toEqual(["paste-image"])
  })
})
