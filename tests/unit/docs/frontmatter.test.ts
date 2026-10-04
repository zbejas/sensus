/**
 * Every content page parses with the schema's required frontmatter (title,
 * description, order), matches its manifest entry, and derives its slug from
 * the filename (no orphan files).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { contentFiles, parseFrontmatter, readManifest, siteFileFor } from "./helpers"

describe("docs frontmatter", () => {
  test("every content file carries title, description, and order matching the manifest", () => {
    const bySlug = new Map(readManifest().map((doc) => [doc.slug, doc]))
    const problems: string[] = []

    for (const file of contentFiles()) {
      const slug = file.replace(/\.md$/, "")
      const entry = bySlug.get(slug)
      if (!entry) {
        problems.push(`${file}: no manifest entry for slug "${slug}"`)
        continue
      }
      const parsed = parseFrontmatter(readFileSync(siteFileFor(slug), "utf8"))
      if (!parsed) {
        problems.push(`${file}: no frontmatter block`)
        continue
      }
      const { title, description, order } = parsed.data
      if (typeof title !== "string" || title.trim() === "") {
        problems.push(`${file}: title missing`)
      } else if (title !== entry.title) {
        problems.push(`${file}: title "${title}" != manifest "${entry.title}"`)
      }
      if (typeof description !== "string" || description.trim() === "") {
        problems.push(`${file}: description missing`)
      }
      if (typeof order !== "number") {
        problems.push(`${file}: order missing or not a number`)
      } else if (order !== entry.order) {
        problems.push(`${file}: order ${order} != manifest ${entry.order}`)
      }
    }

    expect(problems).toEqual([])
  })
})
