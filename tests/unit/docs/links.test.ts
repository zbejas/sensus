/**
 * Every internal `/docs/<slug>` link in user content must resolve to a
 * manifest slug — a link to a slug that does not exist would 404.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CONTENT_DIR, contentFiles, readManifest } from "./helpers"

const DOCS_LINK = /\/docs\/([a-z0-9-]+)/g

describe("docs internal links", () => {
  test("every /docs/<slug> link resolves to a manifest slug", () => {
    const slugs = new Set(readManifest().map((doc) => doc.slug))
    const broken: string[] = []
    for (const file of contentFiles()) {
      const text = readFileSync(join(CONTENT_DIR, file), "utf8")
      for (const match of text.matchAll(DOCS_LINK)) {
        if (!slugs.has(match[1]!)) broken.push(`${file}: /docs/${match[1]}`)
      }
    }
    expect(broken).toEqual([])
  })
})
