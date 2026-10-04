/**
 * The configuration page is hand-written (its keys cannot be generated: they
 * are prose + snippets), so nothing else catches an invented key. Every JSON
 * key used in its examples must exist somewhere in the config sources.
 *
 * Keys a user invents (endpoint names, server names) are example values; if
 * one ever appears as a quoted JSON key, add it to EXTRA_EXAMPLE_KEYS.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { REPO_ROOT, SITE } from "./helpers"

const PAGE = join(SITE, "src/content/docs/configuration.md")
const SCHEMA_DIR = join(REPO_ROOT, "src/config")
const EXTRA_EXAMPLE_KEYS = new Set<string>()

function configSources(): string {
  return readdirSync(SCHEMA_DIR, { recursive: true })
    .filter((name): name is string => typeof name === "string" && name.endsWith(".ts"))
    .map((name) => readFileSync(join(SCHEMA_DIR, name), "utf8"))
    .join("\n")
}

describe("docs configuration reference", () => {
  test("every config key in the page's JSON examples exists in the schema", () => {
    const page = readFileSync(PAGE, "utf8")
    const sources = configSources()
    const keys = new Set(
      [...page.matchAll(/"([a-zA-Z_][a-zA-Z0-9_]*)":/g)].map((match) => match[1]!),
    )
    const missing = [...keys].filter(
      (key) => !EXTRA_EXAMPLE_KEYS.has(key) && !new RegExp(`\\b${key}\\b`).test(sources),
    )
    expect(missing, `unknown config keys in configuration.md: ${missing.join(", ")}`).toEqual([])
  })
})
