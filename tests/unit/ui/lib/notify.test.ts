import { describe, expect, test } from "bun:test"
import { decideNotification, notifySequence, type NotifyPolicy } from "../../../../src/ui/lib/notify.ts"

const policy: NotifyPolicy = { enabled: true, onFinish: true, onApproval: true }
const st = (streaming: boolean, pendingApproval: boolean) => ({ streaming, pendingApproval })

describe("notifications", () => {
  test("fires on the streaming→idle transition and on a newly-pending approval (unless the overlay is open)", () => {
    expect(decideNotification(st(true, false), st(false, false), policy, { overlayOpen: false })).toBe("finished")
    expect(decideNotification(st(false, false), st(false, true), policy, { overlayOpen: false })).toBe("approval")
    // No transition / overlay already in front of the user / disabled.
    expect(decideNotification(st(false, false), st(false, false), policy, { overlayOpen: false })).toBeNull()
    expect(decideNotification(st(false, false), st(false, true), policy, { overlayOpen: true })).toBeNull()
    expect(decideNotification(st(true, false), st(false, false), { ...policy, enabled: false }, { overlayOpen: false })).toBeNull()
    // A finish that immediately has a pending card is the approval's to announce.
    expect(decideNotification(st(true, false), st(false, true), policy, { overlayOpen: false })).toBe("approval")
  })

  test("sequences: bell is BEL; osc777 carries a sanitized title/body", () => {
    expect(notifySequence("bell", "sensus", "done")).toBe("\x07")
    const osc = notifySequence("osc777", "sensus", "reply finished")
    expect(osc.startsWith("\x1b]777;notify;")).toBe(true)
    expect(osc.endsWith("\x07")).toBe(true)
    // Semicolons and BEL in the payload are sanitized (no field/sequence escape).
    const sanitized = notifySequence("osc777", "a;b", "x\x07y")
    expect(sanitized).toContain("a b")
    expect(sanitized).toContain("x y")
  })
})
