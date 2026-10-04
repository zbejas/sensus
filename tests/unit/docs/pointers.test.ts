/**
 * A migrated dev doc keeps a `User guide:` pointer to the site page that now
 * owns its user-facing half. Planned entries are skipped: the pointer lands
 * with the migration.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { REPO_ROOT, readManifest } from "./helpers"

describe("docs dev-doc pointers", () => {
  test("every live dev doc points at its user page", () => {
    const missing: string[] = []
    for (const doc of readManifest()) {
      if (doc.status !== "live" || doc.devDoc === null) continue
      const text = readFileSync(resolve(REPO_ROOT, doc.devDoc), "utf8")
      const url = `https://sensus.sh/docs/${doc.slug}`
      if (!text.includes(url)) missing.push(`${doc.devDoc} → ${url}`)
    }
    expect(missing).toEqual([])
  })
})
