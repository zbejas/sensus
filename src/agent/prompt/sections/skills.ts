import { section } from "../section.ts"
import { skillsIndexText } from "../../skills/loader.ts"

/**
 * Skills index (docs/skills.md): name + description only — the body loads
 * through `skill_view`, which is why the block is gated on that tool being in
 * the request. Listing procedures an agent cannot open would be a tease.
 */
export const skillsSection = section("skills", 800, ({ facts, has }) => {
  const catalog = facts.skills
  if (catalog === undefined || catalog.skills.length === 0) return ""
  if (!has("skill_view")) return ""
  return [
    "Skills (reusable procedures; read the full one with the skill_view tool before following it):",
    skillsIndexText(catalog),
  ].join("\n")
})
