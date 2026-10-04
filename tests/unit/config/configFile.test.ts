/**
 * M5 config-file mutation tests (roadmap feature B): atomic writes, one-time
 * .bak backup, unknown-key preservation, and defensive error handling.
 * Explicit paths only — never touches process.env (parallel bun test files).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readRawConfig, updateRawConfig, writeRawConfig } from "../../../src/config/configFile.ts"

// Test scratch root; create it so a fresh checkout can run this file alone.
mkdirSync("/tmp/sensus", { recursive: true })

const dirs: string[] = []
const sandbox = (): string => {
  const dir = mkdtempSync(join("/tmp/sensus", "sensus-configfile-"))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe("configFile read/write/update", () => {
  test("readRawConfig: missing/invalid/non-object -> null; a valid document round-trips", () => {
    const dir = sandbox()
    const path = join(dir, "sensus.json")
    expect(readRawConfig(path)).toBeNull() // missing file
    writeFileSync(path, "{not json")
    expect(readRawConfig(path)).toBeNull() // invalid JSON
    writeFileSync(path, "[1,2]")
    expect(readRawConfig(path)).toBeNull() // not an object
    writeFileSync(path, '{"theme":"nord","custom": {"a":1}}')
    expect(readRawConfig(path)).toEqual({ theme: "nord", custom: { a: 1 } })
  })

  test("writeRawConfig: creates the file, backs up the original exactly once, stays atomic", () => {
    const dir = sandbox()
    const path = join(dir, "sensus.json")
    // First write with no pre-existing file: no backup (nothing to back up).
    const r1 = writeRawConfig(path, { theme: "dark" })
    expect(r1.ok).toBe(true)
    expect(r1.backupCreated).toBeFalsy()
    expect(existsSync(`${path}.bak`)).toBe(false)

    // Second write: backs up the ORIGINAL contents; third does NOT overwrite it.
    const r2 = writeRawConfig(path, { theme: "light" })
    expect(r2.ok).toBe(true)
    expect(r2.backupCreated).toBe(true)
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual({ theme: "dark" })
    // Repeated writes stay atomic: readers only ever see complete, valid
    // documents (and no .tmp- staging files linger).
    for (const doc of [{ a: 1 }, { a: 2 }, { theme: "nord" }]) {
      expect(writeRawConfig(path, doc).ok).toBe(true)
      expect(readRawConfig(path)).toEqual(doc)
      expect(readdirSync(dir).filter((e) => e.includes(".tmp-"))).toEqual([])
    }
  })

  test("failure paths report errors, never throw (unwritable target, mutator throw)", () => {
    const dir = sandbox()
    // A DIRECTORY where the file should be: both writeFileSync and rename
    // onto it fail — the helper must report, not throw.
    const path = join(dir, "sensus.json")
    mkdirSync(path)
    const res = writeRawConfig(path, { b: 2 })
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe("string")

    // A throwing mutator: error result carrying the ORIGINAL doc; file unchanged.
    writeFileSync(join(dir, "real.json"), '{"a":1}')
    const res2 = updateRawConfig(join(dir, "real.json"), () => {
      throw new Error("boom")
    })
    expect(res2.ok).toBe(false)
    expect(res2.error).toContain("boom")
    expect(res2.doc).toEqual({ a: 1 })
    expect(JSON.parse(readFileSync(join(dir, "real.json"), "utf8"))).toEqual({ a: 1 })
  })

  test("updateRawConfig patches known keys, preserves unknown ones, and bootstraps a missing file from {}", () => {
    const dir = sandbox()
    const path = join(dir, "sensus.json")
    writeFileSync(
      path,
      JSON.stringify({
        defaultProfile: "main",
        profiles: { main: { baseURL: "http://old:3000/v1", model: "m1", temperature: 0.5 } },
        theme: "dark",
        _ownerNote: "keep me",
        futureKey: { nested: true },
      }),
    )

    const res = updateRawConfig(path, (doc) => {
      const profiles = doc["profiles"] as Record<string, Record<string, unknown>>
      profiles["main"] = { ...profiles["main"], baseURL: "http://new:3000/v1" }
      doc["theme"] = "nord"
      return doc
    })

    expect(res.ok).toBe(true)
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const profiles = after["profiles"] as Record<string, Record<string, unknown>>
    expect(profiles["main"]?.baseURL).toBe("http://new:3000/v1")
    expect(profiles["main"]?.model).toBe("m1") // untouched sibling key
    expect(profiles["main"]?.temperature).toBe(0.5)
    expect(after["theme"]).toBe("nord")
    expect(after["_ownerNote"]).toEqual("keep me") // unknown keys survive
    expect(after["futureKey"]).toEqual({ nested: true })
    expect(existsSync(`${path}.bak`)).toBe(true)

    // Missing file: the mutator starts from {} and the write creates it.
    const fresh = join(dir, "fresh.json")
    const res2 = updateRawConfig(fresh, (doc) => ({ ...doc, theme: "terminal" }))
    expect(res2.ok).toBe(true)
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ theme: "terminal" })
  })
})
