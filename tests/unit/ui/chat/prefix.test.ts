/**
 * M6 prefix-mode unit tests: the key routing table (src/ui/chat/prefix.ts) must
 * behave tmux-like — `d` detaches from either focus, other keys pass the
 * raw prefix through to the pane (terminal focus) or cancel (chat focus),
 * and the timeout sends a plain prefix only when the terminal is focused.
 */

import { describe, expect, test } from "bun:test"
import { mapKeyEventToAction, type KeyAction } from "../../../../src/terminal/keys.ts"
import {
  PREFIX_DETACH_KEY,
  PREFIX_WINDOW_MS,
  PrefixMachine,
  prefixKeyAction,
  resolvePrefixEvent,
} from "../../../../src/ui/chat/prefix.ts"

const key = (over: Partial<{ name: string; ctrl: boolean; meta: boolean; shift: boolean; sequence: string }> = {}) => ({
  name: "x",
  ctrl: false,
  meta: false,
  shift: false,
  sequence: "x",
  ...over,
})

describe("resolvePrefixEvent (key routing table)", () => {
  test("d detaches from either focus (case-insensitive, plain modifiers only); any other key in chat cancels", () => {
    expect(PREFIX_DETACH_KEY).toBe("d")
    for (const k of [key({ name: "d" }), key({ name: "D", shift: true })]) {
      expect(resolvePrefixEvent(k, "terminal", "second-key")).toEqual({ action: "detach" })
      expect(resolvePrefixEvent(k, "sidebar", "second-key")).toEqual({ action: "detach" })
    }
    // Modified d is NOT a detach (it routes like any other key).
    expect(resolvePrefixEvent(key({ name: "d", ctrl: true }), "terminal", "second-key")).not.toEqual({
      action: "detach",
    })
    expect(resolvePrefixEvent(key({ name: "d", meta: true }), "sidebar", "second-key")).not.toEqual({
      action: "detach",
    })
    expect(resolvePrefixEvent(key({ name: "e" }), "terminal", "second-key")).not.toEqual({ action: "detach" })
    // Chat focus: a non-d second key cancels the prefix and behaves normally.
    for (const k of [key({ name: "z" }), key({ name: "return", sequence: "\r" }), key({ name: "a", ctrl: true })]) {
      expect(resolvePrefixEvent(k, "sidebar", "second-key")).toEqual({ action: "pass-through" })
    }
  })

  test("terminal focus: any other key routes as PREFIX + that key; the timeout sends the bare prefix", () => {
    // Plain letter: C-a a
    expect(resolvePrefixEvent(key({ name: "a" }), "terminal", "second-key")).toEqual({
      action: "send-to-pane",
      prefix: { kind: "keys", names: ["C-A"] },
      followup: { kind: "literal", text: "a" },
    })
    // Ctrl+A again (readline C-a C-a)
    expect(resolvePrefixEvent(key({ name: "a", ctrl: true }), "terminal", "second-key")).toEqual({
      action: "send-to-pane",
      prefix: { kind: "keys", names: ["C-A"] },
      followup: { kind: "keys", names: ["C-A"] },
    })
    // Named key: Enter
    expect(resolvePrefixEvent(key({ name: "return", sequence: "\r" }), "terminal", "second-key")).toEqual({
      action: "send-to-pane",
      prefix: { kind: "keys", names: ["C-A"] },
      followup: { kind: "keys", names: ["Enter"] },
    })
    // Unmappable key: the bare prefix still goes through.
    expect(resolvePrefixEvent(key({ name: "", sequence: "\x1b," }), "terminal", "second-key")).toEqual({
      action: "send-to-pane",
      prefix: { kind: "keys", names: ["C-A"] },
      followup: null,
    })
    // The prefix action itself is tmux's C-A name, and routed followups are
    // valid send-keys actions (the machine never invents a mapping).
    expect(prefixKeyAction()).toEqual({ kind: "keys", names: ["C-A"] })
    const decision = resolvePrefixEvent(key({ name: "k", ctrl: true }), "terminal", "second-key")
    if (decision.action !== "send-to-pane") throw new Error("expected send-to-pane")
    expect(decision.followup).toEqual(mapKeyEventToAction(key({ name: "k", ctrl: true })))
    // Timeout: terminal sends the bare prefix (readline C-a alone); chat cancels silently.
    expect(resolvePrefixEvent(key(), "terminal", "timeout")).toEqual({
      action: "send-to-pane",
      prefix: { kind: "keys", names: ["C-A"] },
      followup: null,
    })
    expect(resolvePrefixEvent(key(), "sidebar", "timeout")).toEqual({ action: "ignore" })
  })

  test("a CUSTOM prefix key passes itself through — and the machine forwards it to its resolutions", () => {
    const custom = { kind: "keys" as const, names: ["C-Space"] }
    expect(resolvePrefixEvent(key({ name: "k" }), "terminal", "second-key", "d", custom)).toEqual({
      action: "send-to-pane",
      prefix: custom,
      followup: { kind: "literal", text: "k" },
    })
    // With modifiers on the second key the followup is a named key combo:
    expect(resolvePrefixEvent(key({ name: "k", ctrl: true }), "terminal", "second-key", "d", custom)).toEqual({
      action: "send-to-pane",
      prefix: custom,
      followup: { kind: "keys", names: ["C-K"] },
    })
    expect(resolvePrefixEvent(key(), "terminal", "timeout", "d", custom)).toEqual({
      action: "send-to-pane",
      prefix: custom,
      followup: null,
    })
    // The machine wires the same custom action through secondKey.
    let fire: () => void = () => {}
    const machine = new PrefixMachine({
      prefixAction: custom,
      schedule: (fn) => {
        fire = fn
      },
      unschedule: () => {},
    })
    machine.arm("terminal")
    expect(machine.secondKey(key({ name: "z" }), "terminal")).toEqual({
      action: "send-to-pane",
      prefix: custom,
      followup: { kind: "literal", text: "z" },
    })
    machine.arm("terminal")
    fire()
    // The timeout callback is the caller's — it receives no prefix; the App
    // sends its own (resolved) action. Verified via the decision table above.
    expect(machine.isArmed).toBe(false)
  })
})

describe("PrefixMachine (armed state + timeout)", () => {
  /** Deterministic clock: capture the scheduled callback. */
  function machineWithClock(overrides: {
    onTimeout?: (focus: "terminal" | "sidebar") => void
    windowMs?: number
    prefixAction?: KeyAction
  } = {}): { machine: PrefixMachine; fire: () => void } {
    let fire: () => void = () => {}
    const machine = new PrefixMachine({
      windowMs: overrides.windowMs ?? PREFIX_WINDOW_MS,
      onTimeout: overrides.onTimeout ?? (() => {}),
      prefixAction: overrides.prefixAction,
      schedule: (fn) => {
        fire = fn
      },
      unschedule: () => {},
    })
    return { machine, fire: () => fire() }
  }

  test("arm/secondKey lifecycle: exactly one routed key, then disarmed; idle and post-resolution keys pass through", () => {
    const { machine } = machineWithClock()
    expect(machine.isArmed).toBe(false)
    // Idle: keys are NOT consumed by a machine that isn't armed.
    expect(machine.secondKey(key({ name: "d" }), "terminal")).toEqual({ action: "pass-through" })
    machine.arm("terminal")
    expect(machine.isArmed).toBe(true)
    expect(machine.secondKey(key({ name: "d" }), "terminal")).toEqual({ action: "detach" })
    expect(machine.isArmed).toBe(false)
    // A non-detach resolution disarms too — no second resolution afterwards.
    machine.arm("terminal")
    expect(machine.secondKey(key({ name: "k" }), "terminal").action).toBe("send-to-pane")
    expect(machine.secondKey(key({ name: "d" }), "terminal")).toEqual({ action: "pass-through" })
    // disarm() cancels the pending timeout with no side effects.
    const seen: string[] = []
    const cancelled = machineWithClock({ onTimeout: (f) => seen.push(f) })
    cancelled.machine.arm("terminal")
    cancelled.machine.disarm()
    cancelled.fire()
    expect(seen).toEqual([])
    expect(cancelled.machine.isArmed).toBe(false)
  })

  test("timeout: fires onTimeout with the focus at arm time; re-arming refreshes the window", () => {
    const seen: string[] = []
    const { machine, fire } = machineWithClock({ onTimeout: (f) => seen.push(f) })
    machine.arm("sidebar")
    fire()
    expect(seen).toEqual(["sidebar"])
    expect(machine.isArmed).toBe(false)
    // A late second key after the timeout is NOT a prefix resolution.
    expect(machine.secondKey(key({ name: "d" }), "terminal")).toEqual({ action: "pass-through" })
    // Re-arm replaces the pending timer — the older window's timeout never fires.
    const rearmed = machineWithClock({ onTimeout: (f) => seen.push(f) })
    rearmed.machine.arm("terminal")
    rearmed.machine.arm("terminal")
    rearmed.fire()
    expect(seen).toEqual(["sidebar", "terminal"])
    expect(rearmed.machine.isArmed).toBe(false)
  })
})
