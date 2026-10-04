/**
 * README deep links route users to the manual. The pointer test guards the
 * dev-doc side; this guards the README side — a renamed slug or a typo in a
 * link would 404 in public and nothing else would catch it offline.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { REPO_ROOT, readManifest } from "./helpers"

const DOCS_URL = /https:\/\/sensus\.sh\/docs\/([a-z0-9-]*)\/?/g

describe("docs README links", () => {
  test("every sensus.sh/docs URL in README names a manifest slug", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8")
    const slugs = new Set(readManifest().map((doc) => doc.slug))
    const broken: string[] = []
    for (const match of readme.matchAll(DOCS_URL)) {
      const slug = match[1]!
      if (slug !== "" && !slugs.has(slug)) broken.push(match[0])
    }
    expect(broken, `README links to unknown docs slugs: ${broken.join(", ")}`).toEqual([])
  })
})
