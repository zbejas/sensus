/**
 * Instruction resolution (docs/config.md "instructions"): the config `instructions`
 * list resolver and the nearest-AGENTS.md walk. Pure filesystem tests under a
 * temp dir; no network, no provider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  expandInstructionEntries,
  findNearestInstructionFile,
  listInstructionUrls,
  readInstructionFiles,
} from "../../../src/agent/instructions.ts"

let root: string
let cwd: string
let home: string
let configDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sensus-instructions-"))
  cwd = join(root, "cwd")
  home = join(root, "home")
  configDir = join(root, "config")
  mkdirSync(join(cwd, "docs"), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(cwd, "top.md"), "TOP")
  writeFileSync(join(cwd, "empty.md"), "")
  writeFileSync(join(cwd, "docs", "a.md"), "A")
  writeFileSync(join(cwd, "docs", "b.md"), "B")
  writeFileSync(join(home, "h.md"), "HOME")
  writeFileSync(join(configDir, "c.md"), "CONFIG")
})

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe("expandInstructionEntries", () => {
  test("resolves paths, ~/, globs (sorted + de-duplicated), config-dir fallback; ignores missing + URLs", () => {
    const { files } = expandInstructionEntries(
      [
        "top.md", // relative -> cwd
        join(cwd, "docs", "a.md"), // absolute
        "~/h.md", // tilde -> home
        "docs/*.md", // glob (a.md de-dupes against the absolute entry)
        "missing.md", // missing -> ignored
        "c.md", // relative fallback -> config dir
        "https://example.test/rules.md", // URL -> ignored here
      ],
      { cwd, home, configDir },
    )
    expect(files).toEqual(
      [
        join(cwd, "top.md"),
        join(cwd, "docs", "a.md"),
        join(cwd, "docs", "b.md"),
        join(home, "h.md"),
        join(configDir, "c.md"),
      ]
        .map((p) => resolve(p))
        .sort(),
    )
  })

  test("a glob with no cwd matches falls back to the config dir", () => {
    writeFileSync(join(configDir, "z.fallback.md"), "Z")
    const { files } = expandInstructionEntries(["*.fallback.md"], { cwd, home, configDir })
    expect(files).toEqual([resolve(join(configDir, "z.fallback.md"))])
  })

  test("an absolute glob expands without a cwd", () => {
    const { files } = expandInstructionEntries([join(cwd, "docs", "*.md")], { cwd, home, configDir })
    expect(files).toEqual([resolve(join(cwd, "docs", "a.md")), resolve(join(cwd, "docs", "b.md"))].sort())
  })
})

describe("readInstructionFiles", () => {
  test("labels each file by path, joins with separators, skips missing/dir/empty, never throws", () => {
    const { text, sources } = readInstructionFiles([
      join(cwd, "docs", "a.md"),
      join(cwd, "docs", "b.md"),
      join(root, "nope.md"),
      cwd, // a directory -> read throws -> skipped
      join(cwd, "empty.md"),
    ])
    expect(sources).toEqual([join(cwd, "docs", "a.md"), join(cwd, "docs", "b.md")])
    expect(text).toContain(`# Instructions from ${join(cwd, "docs", "a.md")}`)
    expect(text).toContain(`# Instructions from ${join(cwd, "docs", "b.md")}`)
    expect(text).toContain("\n---\n")
  })

  test("an empty input yields empty text/sources", () => {
    expect(readInstructionFiles([])).toEqual({ text: "", sources: [] })
  })
})

describe("listInstructionUrls", () => {
  test("keeps only http(s) entries, in order, trimmed", () => {
    expect(
      listInstructionUrls(["https://a.test/x.md", "docs/a.md", " http://b.test/y.md ", "~/h.md"]),
    ).toEqual(["https://a.test/x.md", "http://b.test/y.md"])
  })
})

describe("findNearestInstructionFile", () => {
  test("walks up to the nearest AGENTS.md", () => {
    const tree = join(root, "tree")
    mkdirSync(join(tree, "a", "b", "c"), { recursive: true })
    writeFileSync(join(tree, "AGENTS.md"), "ROOT")
    writeFileSync(join(tree, "a", "AGENTS.md"), "A")
    const found = findNearestInstructionFile(join(tree, "a", "b", "c", "f.ts"), {
      globalPath: join(root, "sentinel", "AGENTS.md"),
    })
    expect(found).toBe(join(tree, "a", "AGENTS.md"))
  })

  test("returns null when no AGENTS.md is found", () => {
    const none = join(root, "none")
    mkdirSync(join(none, "sub"), { recursive: true })
    // Skip the environment's /tmp/AGENTS.md so the walk can reach the root.
    const found = findNearestInstructionFile(join(none, "sub", "f.ts"), {
      globalPath: join(tmpdir(), "AGENTS.md"),
    })
    expect(found).toBeNull()
  })

  test("skips the global AGENTS.md and keeps walking", () => {
    const g = join(root, "global-skip")
    mkdirSync(join(g, "proj", "sub"), { recursive: true })
    writeFileSync(join(g, "proj", "AGENTS.md"), "GLOBAL-STATIC")
    writeFileSync(join(g, "AGENTS.md"), "REAL")
    const found = findNearestInstructionFile(join(g, "proj", "sub", "f.ts"), {
      globalPath: join(g, "proj", "AGENTS.md"),
    })
    expect(found).toBe(join(g, "AGENTS.md"))
  })
})
