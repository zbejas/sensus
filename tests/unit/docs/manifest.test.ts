/**
 * The docs manifest is the single source of truth for the /docs tree: unique
 * slugs and orders, a valid dev-doc mapping, and a content page for every
 * entry that is marked live. Planned entries may not have pages yet.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { REPO_ROOT, readManifest, siteFileFor } from "./helpers"

describe("docs manifest", () => {
  test("slugs, orders, and titles are well-formed and unique", () => {
    const docs = readManifest()
    expect(docs.length).toBeGreaterThan(0)

    const slugs = docs.map((doc) => doc.slug)
    const orders = docs.map((doc) => doc.order)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(new Set(orders).size).toBe(orders.length)

    for (const doc of docs) {
      expect(doc.slug).toMatch(/^[a-z0-9-]+$/)
      expect(doc.title.trim()).not.toBe("")
      expect(Number.isInteger(doc.order)).toBe(true)
    }
  })

  test("every devDoc exists (or is null) and every status is planned|live", () => {
    for (const doc of readManifest()) {
      expect(["planned", "live"]).toContain(doc.status)
      if (doc.devDoc !== null) {
        expect(existsSync(resolve(REPO_ROOT, doc.devDoc))).toBe(true)
      }
    }
  })

  test("every live entry has its derived content page", () => {
    for (const doc of readManifest()) {
      if (doc.status !== "live") continue
      expect(existsSync(siteFileFor(doc.slug))).toBe(true)
    }
  })
})
