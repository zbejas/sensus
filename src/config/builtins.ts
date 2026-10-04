/**
 * Sensus-owned built-in files (docs/agents.md, docs/skills.md): markdown files
 * that ship inside the binary and are materialized into the config dir on boot
 * with a hashed banner.
 *
 * Lifecycle (identical for built-in agents and skills):
 *  - missing            → written;
 *  - unchanged          → left alone;
 *  - an older/unedited  → refreshed in place (its banner hash still matches
 *    built-in               its body, or only the banner differs);
 *  - user-modified      → rescued as `<stem>.modified-<time>.md` with a unique
 *    frontmatter `name`, then a fresh built-in is generated.
 * Any other file in the directory is never touched.
 *
 * The banner is a leading HTML comment, so the shared frontmatter parser
 * (`parseAgentFrontmatter`) skips it — it never reaches a prompt or a body.
 * Best-effort: failures collect warnings, never throw.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import { errorMessage } from "../core/util.ts"

/** Built-in categories — select the banner label and warning prefix. */
export type BuiltInKind = "AGENT" | "SKILL"

/** One compiled-in file to materialize into a config directory. */
export interface BuiltInFile {
  /** File name inside the target dir (e.g. "copilot.md", "sensus.md"). */
  file: string
  /** The full markdown (frontmatter + body) written verbatim. */
  markdown: string
}

/**
 * Strip a leading banner/HTML comment. The frontmatter parsers skip it so the
 * banner never leaks into a prompt. Exported for the loaders' own checks.
 */
export const LEADING_COMMENT_RE = /^\s*<!--[\s\S]*?-->\s*/

/** The markdown after an optional leading banner comment. */
export function stripLeadingComment(text: string): string {
  return text.replace(LEADING_COMMENT_RE, "")
}

/** Short sha256 of a built-in body — embedded in its banner so edits are detectable. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12)
}

/**
 * The Sensus banner atop every built-in file. `body` is the
 * frontmatter+prompt markdown; the banner records `sha256(body)` so the boot
 * materializer can tell an unedited built-in (hash matches — refresh it in
 * place on update) from a user-modified one (hash missing or mismatched —
 * rescue the file under a new name, then regenerate).
 */
export function builtInMarkdown(body: string, kind: BuiltInKind = "AGENT"): string {
  return (
    `<!-- SENSUS BUILT-IN ${kind} sha256:${bodyHash(body)} — refreshed on every update. Edits are\n` +
    `     rescued to <name>.modified-<time>.md; copy to a new name to customize. -->\n` +
    body
  )
}

/** The hash recorded in a Sensus built-in banner of `kind`, or null when absent. */
function bannerHash(text: string, kind: BuiltInKind): string | null {
  const m = new RegExp(`^<!--\\s*SENSUS BUILT-IN ${kind} sha256:([0-9a-f]+)`).exec(text)
  return m?.[1] ?? null
}

/** True when the file is an unedited Sensus built-in (banner hash matches its body). */
export function isPristineBuiltIn(text: string, kind: BuiltInKind): boolean {
  const h = bannerHash(text, kind)
  return h !== null && bodyHash(stripLeadingComment(text)) === h
}

/** A free `<stem>.modified-<timestamp>.md` path in `dir` (never clobbers an earlier rescue). */
function preservedPath(dir: string, stem: string): string {
  const stamp = new Date().toISOString().replace(/[T:.]/g, "-").replace(/Z$/, "")
  let path = join(dir, `${stem}.modified-${stamp}.md`)
  let n = 1
  while (existsSync(path)) path = join(dir, `${stem}.modified-${stamp}-${n++}.md`)
  return path
}

/**
 * Give a rescued built-in a unique `name` so it does not collide with the
 * regenerated built-in. Files without frontmatter (or without a `name` line)
 * fall back to their unique filename stem.
 */
function renameInContent(text: string, name: string): string {
  const m = /^(\s*<!--[\s\S]*?-->\s*)?---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (m === null) return text
  const prefix = m[1] ?? ""
  const fm = m[2] ?? ""
  if (!/^name\s*:/m.test(fm)) return text
  return prefix + "---\n" + fm.replace(/^name\s*:.*$/m, `name: ${name}`) + "\n---" + text.slice(m[0].length)
}

const WARNING_PREFIX: Record<BuiltInKind, string> = { AGENT: "agents", SKILL: "skills" }

/**
 * Materialize a set of built-in files into `dir` (assumed to exist). See the
 * module comment for the refresh/rescue rules. Appends warnings to `warnings`;
 * never throws.
 */
export function materializeBuiltIns(
  dir: string,
  builtIns: readonly BuiltInFile[],
  kind: BuiltInKind,
  warnings: string[],
): void {
  const prefix = WARNING_PREFIX[kind]
  for (const b of builtIns) {
    const path = join(dir, b.file)
    try {
      let current: string | null = null
      try {
        current = readFileSync(path, "utf8")
      } catch {
        current = null // missing or unreadable — (re)write it
      }
      if (current === null) {
        writeFileSync(path, b.markdown, "utf8")
        continue
      }
      if (current === b.markdown) continue
      // Same body (e.g. only an older banner) or an intact built-in: refresh in place.
      if (stripLeadingComment(current) === stripLeadingComment(b.markdown) || isPristineBuiltIn(current, kind)) {
        writeFileSync(path, b.markdown, "utf8")
        continue
      }
      // User-modified: rescue their version under a fresh unique name, then regenerate.
      const rescue = preservedPath(dir, basename(b.file, ".md"))
      writeFileSync(rescue, renameInContent(current, basename(rescue, ".md")), "utf8")
      writeFileSync(path, b.markdown, "utf8")
      warnings.push(`${prefix}: ${b.file} was modified — rescued as ${basename(rescue)}; generated a fresh ${b.file}`)
    } catch (e) {
      warnings.push(`${prefix}: could not write ${path} (${errorMessage(e)})`)
    }
  }
}
