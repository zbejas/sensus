/**
 * Shared fixtures for the docs invariants (`tests/unit/docs/*`). The site's
 * manifest is the single source of truth; these helpers resolve the derived
 * paths and parse the small frontmatter subset the content schema uses.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")
export const SITE = join(REPO_ROOT, "site")
export const MANIFEST_FILE = join(SITE, "src/data/docs-manifest.json")
export const CONTENT_DIR = join(SITE, "src/content/docs")
export const GENERATED_DIR = join(SITE, "src/data/generated")

export interface ManifestEntry {
  slug: string
  title: string
  order: number
  status: "planned" | "live"
  devDoc: string | null
}

export function readManifest(): ManifestEntry[] {
  const parsed = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as { docs: ManifestEntry[] }
  return parsed.docs
}

/** The derived content file for a slug (`siteFile` is not stored in the manifest). */
export function siteFileFor(slug: string): string {
  return join(CONTENT_DIR, `${slug}.md`)
}

/** Content pages on disk, sorted; empty until the migration lands pages. */
export function contentFiles(): string[] {
  if (!existsSync(CONTENT_DIR)) return []
  return readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
}

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

/**
 * Parse the frontmatter subset the schema uses: `key: value` lines between
 * `---` fences. Quoted values are unquoted; numeric values become numbers.
 * Returns null when the file has no frontmatter block.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  const data: Record<string, unknown> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue
    let raw = field[2]!.trim()
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      raw = raw.slice(1, -1)
    }
    const numeric = Number(raw)
    data[field[1]!] = raw !== "" && Number.isFinite(numeric) ? numeric : raw
  }
  return { data, body: text.slice(match[0].length) }
}
