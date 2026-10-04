/**
 * Instance identity (D13; docs/events.md): the daemon-owned
 * `~/.config/sensus/instance.json`. The load-bearing contract is STABILITY —
 * an existing valid file is never regenerated (id + createdAt survive
 * restarts and upgrades; only `version` refreshes) — plus a clean repair when
 * the file is missing or corrupt.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateInstanceId,
  instancePath,
  isSensusInstance,
  loadOrCreateInstance,
  readInstance,
} from "../../../src/engine/index.ts"

const TEMP = (): string => mkdtempSync(join(tmpdir(), "sensus-instance-"))

describe("generateInstanceId (ULID-like)", () => {
  test("is 26 Crockford base32 chars, time-ordered, and deterministic with an injected RNG", () => {
    const zero = () => new Uint8Array(10)
    const early = generateInstanceId(1_000_000, zero)
    const late = generateInstanceId(2_000_000, zero)
    expect(early).toHaveLength(26)
    expect(late).toHaveLength(26)
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    // The 10-char time prefix is lexicographically monotonic for a fixed RNG.
    expect(early < late).toBe(true)
    expect(generateInstanceId(1_000_000, zero)).toBe(early)
    // Randomness actually feeds the tail.
    expect(generateInstanceId(1_000_000, () => new Uint8Array(10).fill(255))).not.toBe(early)
  })

  test("isSensusInstance rejects missing/mistyped fields", () => {
    const good = { instanceId: "01ABC", createdAt: 1, version: "0.0.1" }
    expect(isSensusInstance(good)).toBe(true)
    expect(isSensusInstance({ ...good, instanceId: "" })).toBe(false)
    expect(isSensusInstance({ ...good, instanceId: 3 })).toBe(false)
    expect(isSensusInstance({ ...good, createdAt: 0 })).toBe(false)
    expect(isSensusInstance({ ...good, createdAt: Number.NaN })).toBe(false)
    expect(isSensusInstance({ ...good, version: 7 })).toBe(false)
    expect(isSensusInstance(null)).toBe(false)
    expect(isSensusInstance([])).toBe(false)
  })
})

describe("loadOrCreateInstance", () => {
  test("creates a valid instance.json on first boot and reuses it verbatim", () => {
    const home = TEMP()
    try {
      const first = loadOrCreateInstance(home, "0.0.1")
      expect(first).toMatchObject({ version: "0.0.1" })
      expect(first.instanceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(first.createdAt).toBeGreaterThan(0)
      const onDisk = JSON.parse(readFileSync(instancePath(home), "utf8")) as unknown
      expect(onDisk).toEqual(first)

      // A restart with the SAME version returns the identical identity.
      const again = loadOrCreateInstance(home, "0.0.1")
      expect(again).toEqual(first)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("stays stable across an upgrade: only version refreshes, id + createdAt do not", () => {
    const home = TEMP()
    try {
      const first = loadOrCreateInstance(home, "0.0.1")
      const upgraded = loadOrCreateInstance(home, "0.0.9")
      expect(upgraded.instanceId).toBe(first.instanceId)
      expect(upgraded.createdAt).toBe(first.createdAt)
      expect(upgraded.version).toBe("0.0.9")
      expect(readInstance(home)).toEqual(upgraded)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("repairs a corrupt file (bad JSON / bad shape / absent) by regenerating", () => {
    const home = TEMP()
    try {
      const path = instancePath(home)
      mkdirSync(home, { recursive: true })

      writeFileSync(path, "{ not json")
      expect(readInstance(home)).toBeNull()
      const fromGarbage = loadOrCreateInstance(home, "0.0.1")
      expect(isSensusInstance(fromGarbage)).toBe(true)
      expect(readInstance(home)).toEqual(fromGarbage)

      writeFileSync(path, JSON.stringify({ instanceId: "x", createdAt: -1, version: 1 }))
      expect(readInstance(home)).toBeNull()
      const fromShape = loadOrCreateInstance(home, "0.0.1")
      expect(isSensusInstance(fromShape)).toBe(true)
      expect(fromShape.instanceId).not.toBe("x")

      rmSync(path, { force: true })
      expect(readInstance(home)).toBeNull()
      expect(isSensusInstance(loadOrCreateInstance(home, "0.0.1"))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("never throws on a non-existent (unwritable) home: returns an in-memory identity", () => {
    // A file where the home directory should be makes the write fail; the
    // loader still returns a usable identity instead of throwing.
    const home = TEMP()
    try {
      const blocked = join(home, "blocked")
      writeFileSync(blocked, "not a directory")
      const inst = loadOrCreateInstance(blocked, "0.0.1")
      expect(isSensusInstance(inst)).toBe(true)
      expect(readInstance(blocked)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
