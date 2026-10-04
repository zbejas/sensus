/**
 * Skills (docs/agents.md sibling concept, docs/memory.md Hermes adaptation):
 * reusable procedure documents the agent loads on demand. A skill is a
 * `SKILL.md` (frontmatter: name, description; body: the procedure) under
 * `~/.config/sensus/skills/<slug>/`, or a flat `<name>.md` for convenience.
 *
 * Progressive disclosure: only the name + description reach the system prompt;
 * the agent calls the `skill_view` tool to read a full body. Pure loader (fs
 * reads only, no signals); `/reload` re-runs it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { skillsDir } from "../../config/config.ts"
import { parseAgentFrontmatter } from "../../config/agents.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.skills")

export interface SkillDef {
  /** Selection name (frontmatter, else the directory/file stem). */
  name: string
  /** One-line description (frontmatter, else the first body line). */
  description: string
  /** Absolute path of the source file (diagnostics). */
  path: string
  /** The full procedure body (markdown). */
  body: string
}

export interface SkillsCatalog {
  /** Sorted by name — the picker/prompt order. */
  skills: SkillDef[]
  byName: Record<string, SkillDef>
  warnings: string[]
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim().replace(/^#+\s*/, "")
    if (t.length > 0) return t.length > 120 ? `${t.slice(0, 120)}…` : t
  }
  return ""
}

/** Parse one skill file into a def (null when it has no usable name). */
export function parseSkillFile(path: string, fallbackName: string, warnings: string[]): SkillDef | null {
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    warnings.push(`skills: could not read ${path} (${e instanceof Error ? e.message : String(e)})`)
    log.debug("skill file read failed", { path, err: e })
    return null
  }
  const { meta, body } = parseAgentFrontmatter(text)
  const rawName = meta["name"]
  const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : fallbackName
  if (name.length === 0) return null
  const rawDesc = meta["description"]
  const description = typeof rawDesc === "string" && rawDesc.trim().length > 0 ? rawDesc.trim() : firstLine(body)
  return { name, description, path, body: body.trim() }
}

/**
 * Load every skill under the skills dir. Directories are checked for
 * `SKILL.md`; flat `*.md` files are also accepted. Never throws.
 */
export function loadSkills(home: string): SkillsCatalog {
  const warnings: string[] = []
  const dir = skillsDir(home)
  const skills: SkillDef[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir).sort()
  } catch (e) {
    log.debug("skills dir unreadable; no skills loaded", { dir, err: e })
    return { skills: [], byName: {}, warnings } // no dir yet — ChatHost materializes it
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch (e) {
      log.debug("skill entry stat failed; skipping", { path: full, err: e })
      continue
    }
    let file: string | null = null
    let fallback = entry
    if (isDir) {
      const candidate = join(full, "SKILL.md")
      if (existsSync(candidate)) {
        file = candidate
        fallback = entry
      }
    } else if (entry.toLowerCase().endsWith(".md")) {
      file = full
      fallback = entry.replace(/\.md$/i, "")
    }
    if (file === null) continue
    const def = parseSkillFile(file, fallback, warnings)
    if (def !== null) skills.push(def)
  }
  const seen = new Set<string>()
  const byName: Record<string, SkillDef> = {}
  const unique: SkillDef[] = []
  for (const s of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.has(s.name)) {
      warnings.push(`skills: duplicate skill name "${s.name}" — the first definition wins`)
      continue
    }
    seen.add(s.name)
    unique.push(s)
    byName[s.name] = s
  }
  return { skills: unique, byName, warnings }
}

/** The one-line-per-skill index the system prompt carries (progressive disclosure). */
export function skillsIndexText(catalog: SkillsCatalog): string {
  if (catalog.skills.length === 0) return ""
  return catalog.skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n")
}

/**
 * Filter a catalog to an agent's allowlist (docs/agents.md frontmatter
 * `skills`): a declared list filters; null/`["*"]` passes everything. Used for
 * both the prompt index and the skills tools.
 */
export function filterSkillsForAgent(catalog: SkillsCatalog, allowed: string[] | null): SkillsCatalog {
  if (allowed === null) return catalog
  const set = new Set(allowed)
  const skills = catalog.skills.filter((s) => set.has(s.name))
  return {
    skills,
    byName: Object.fromEntries(skills.map((s) => [s.name, s])),
    warnings: catalog.warnings,
  }
}

/** Sanitize a `/learn` argument into a skill slug (empty when unusable). */
export function skillSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}
