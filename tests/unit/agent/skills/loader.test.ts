import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSkills, parseSkillFile, skillsIndexText, filterSkillsForAgent, skillSlug } from "../../../../src/agent/skills/loader.ts"

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "sensus-skills-"))
  try {
    mkdirSync(join(home, "skills"), { recursive: true })
    fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe("skills loader", () => {
  test("loads directory SKILL.md + flat markdown, frontmatter wins, index is name: description", () => {
    withHome((home) => {
      mkdirSync(join(home, "skills", "deploy"), { recursive: true })
      writeFileSync(
        join(home, "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: ship the app safely\n---\n# Deploy\n\n1. build\n2. ship\n",
      )
      writeFileSync(join(home, "skills", "notes.md"), "Just some notes\n\nmore\n")

      const cat = loadSkills(home)
      expect(cat.skills.map((s) => s.name)).toEqual(["deploy", "notes"])
      expect(cat.byName["deploy"]?.description).toBe("ship the app safely")
      expect(cat.byName["deploy"]?.body).toContain("1. build")
      // Flat file: name from the stem, description from the first body line.
      expect(cat.byName["notes"]?.description).toBe("Just some notes")
      expect(skillsIndexText(cat)).toBe("- deploy: ship the app safely\n- notes: Just some notes")
    })
  })

  test("a missing skills dir is empty and warning-free; duplicate names keep the first", () => {
    withHome((home) => {
      rmSync(join(home, "skills"), { recursive: true, force: true })
      expect(loadSkills(home)).toEqual({ skills: [], byName: {}, warnings: [] })

      mkdirSync(join(home, "skills", "a"), { recursive: true })
      mkdirSync(join(home, "skills", "b"), { recursive: true })
      writeFileSync(join(home, "skills", "a", "SKILL.md"), "---\nname: same\n---\nfirst\n")
      writeFileSync(join(home, "skills", "b", "SKILL.md"), "---\nname: same\n---\nsecond\n")
      const cat = loadSkills(home)
      expect(cat.skills.length).toBe(1)
      expect(cat.byName["same"]?.body).toBe("first")
      expect(cat.warnings.some((w) => w.includes("duplicate skill name"))).toBe(true)
    })
  })

  test("parseSkillFile survives an unreadable path with a warning", () => {
    const warnings: string[] = []
    expect(parseSkillFile("/nonexistent/SKILL.md", "x", warnings)).toBeNull()
    expect(warnings.length).toBe(1)
  })

  test("skillsIndexText is empty for an empty catalog", () => {
    expect(skillsIndexText({ skills: [], byName: {}, warnings: [] })).toBe("")
  })

  test("skillSlug sanitizes a /learn argument into a bounded slug", () => {
    expect(skillSlug("Deploy App!!")).toBe("deploy-app")
    expect(skillSlug("  ---  ")).toBe("")
    expect(skillSlug("a".repeat(100)).length).toBe(48)
  })

  test("filterSkillsForAgent: a declared list filters the catalog and its byName; null passes everything", () => {
    const cat = {
      skills: [
        { name: "a", description: "A", path: "/a", body: "a" },
        { name: "b", description: "B", path: "/b", body: "b" },
      ],
      byName: { a: { name: "a", description: "A", path: "/a", body: "a" }, b: { name: "b", description: "B", path: "/b", body: "b" } },
      warnings: [],
    }
    const only = filterSkillsForAgent(cat, ["b"])
    expect(only.skills.map((s) => s.name)).toEqual(["b"])
    expect(Object.keys(only.byName)).toEqual(["b"])
    expect(filterSkillsForAgent(cat, null)).toBe(cat)
  })
})
