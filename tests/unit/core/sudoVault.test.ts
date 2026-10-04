import { describe, expect, test } from "bun:test"
import { SudoVault } from "../../../src/core/sudoVault.ts"

/**
 * The session sudo vault keeps the password encrypted in RAM (docs/agent.md
 * "Sudo"): hashing is impossible because sudo needs the original back, so the
 * contract is set/get/has/clear with the ciphertext never being the plaintext.
 */
describe("SudoVault (RAM-only encrypted sudo password)", () => {
  test("round-trips a password, reports presence, replaces, and clears", () => {
    const vault = new SudoVault()
    expect(vault.has()).toBe(false)
    expect(vault.get()).toBeNull()

    vault.set("hunter2 with spaces & symbols")
    expect(vault.has()).toBe(true)
    expect(vault.get()).toBe("hunter2 with spaces & symbols")

    // Replacing keeps only the newest.
    vault.set("second")
    expect(vault.get()).toBe("second")

    vault.clear()
    expect(vault.has()).toBe(false)
    expect(vault.get()).toBeNull()
  })

  test("survives unicode and empty-ish values without throwing", () => {
    const vault = new SudoVault()
    vault.set("pãss🔒word")
    expect(vault.get()).toBe("pãss🔒word")
    vault.set("")
    // An empty stored password round-trips as "" (has() is the presence check).
    expect(vault.has()).toBe(true)
    expect(vault.get()).toBe("")
  })
})
