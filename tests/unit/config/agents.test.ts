/**
 * Agents loader tests (docs/agents.md): frontmatter parsing, file loading,
 * built-in materialization (Sensus-owned, refreshed on update), built-in
 * fallbacks. All inside a temp SENSUS_HOME — never touches the real config dir.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  builtInAgent,
  builtInMarkdown,
  BUILT_IN_AGENTS,
  COPILOT_AGENT_MD,
  ensureAgentDirs,
  fallbackAgent,
  loadAgents,
  parseAgentFile,
  parseAgentFrontmatter,
  resolveSudoPrompt,
} from "../../../src/config/agents.ts"
import { BUILT_IN_SKILLS, SENSUS_SKILL_MD } from "../../../src/config/builtinSkills.ts"
import { loadSkills } from "../../../src/agent/skills/loader.ts"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../../../src/agent/truncate.ts"
import { agentsDir, skillsDir } from "../../../src/config/config.ts"

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sensus-agents-"))
})

afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe("agents", () => {
  test("frontmatter: key: value, inline arrays, and block lists parse; no frontmatter = all body", () => {
    const { meta, body } = parseAgentFrontmatter(
      `---\nname: scout\ndescription: reads only\ntools: [read_file, get_scrollback]\nextra:\n  - one\n  - two\n---\n\nPrompt body here.`,
    )
    expect(meta["name"]).toBe("scout")
    expect(meta["description"]).toBe("reads only")
    expect(meta["tools"]).toEqual(["read_file", "get_scrollback"])
    expect(meta["extra"]).toEqual(["one", "two"])
    expect(body).toContain("Prompt body here.")

    const plain = parseAgentFrontmatter("just a prompt")
    expect(plain.meta).toEqual({})
    expect(plain.body).toBe("just a prompt")

    // A leading Sensus banner comment is skipped (built-in files carry one).
    const bannered = parseAgentFrontmatter(builtInMarkdown("---\nname: copilot\n---\nBody."))
    expect(bannered.meta["name"]).toBe("copilot")
    expect(bannered.body.trim()).toBe("Body.")
  })

  test("parseAgentFile: full def parses, name falls back to the file stem, tools */absent/empty = all (null)", () => {
    const warnings: string[] = []
    const def = parseAgentFile("scout.md", "---\nname: scout\ndescription: reads\ntools: [read_file]\n---\nYou scout.", warnings)
    expect(def).toMatchObject({ name: "scout", description: "reads", tools: ["read_file"], sudoPrompt: "ask", shell: "auto", readonly: false })
    expect(def?.prompt).toBe("You scout.")

    // `readonly` parses to a boolean; invalid values warn and fall back to false.
    const ro = parseAgentFile("r.md", "---\nname: r\nreadonly: true\n---\nbody", warnings)
    expect(ro?.readonly).toBe(true)
    const roNo = parseAgentFile("r.md", "---\nname: r\nreadonly: 'no'\n---\nbody", warnings)
    expect(roNo?.readonly).toBe(false)
    const roBad = parseAgentFile("r.md", "---\nname: r\nreadonly: maybe\n---\nbody", warnings)
    expect(roBad?.readonly).toBe(false)
    expect(warnings.some((w) => w.includes("readonly"))).toBe(true)

    // Name defaults to the file stem when frontmatter omits it.
    expect(parseAgentFile("scout.md", "---\ndescription: x\n---\nbody", warnings)?.name).toBe("scout")

    // All-tools variants: "*", absent, and an empty list all mean "no restriction".
    for (const tools of ['tools: ["*"]', "", "tools: []"]) {
      expect(parseAgentFile("a.md", `---\n${tools}\n---\nb`, warnings)?.tools).toBeNull()
    }

    // skills allowlist parses like tools; absent/"*"/empty = all (null).
    const withSkills = parseAgentFile("s.md", "---\nname: s\nskills: [deploy, notes]\n---\nbody", warnings)
    expect(withSkills?.skills).toEqual(["deploy", "notes"])
    for (const s of ['skills: ["*"]', "", "skills: []"]) {
      expect(parseAgentFile("a.md", `---\n${s}\n---\nb`, warnings)?.skills).toBeNull()
    }
  })

  test("parseAgentFile: sudoPrompt modes parse, and unknown keys / invalid sudo / empty body warn", () => {
    const warnings: string[] = []
    // Both spellings select the popup mode; `auto` follows the approval mode.
    expect(parseAgentFile("a.md", "---\nsudoPrompt: popup\n---\nb", warnings)?.sudoPrompt).toBe("popup")
    expect(parseAgentFile("a.md", "---\nsudo: popup\n---\nb", warnings)?.sudoPrompt).toBe("popup")
    expect(parseAgentFile("a.md", "---\nsudoPrompt: auto\n---\nb", warnings)?.sudoPrompt).toBe("auto")

    parseAgentFile("a.md", "---\nsudoPrompt: wat\n---\nb", warnings)
    expect(warnings.some((w) => w.includes("sudoPrompt"))).toBe(true)
    // `auto` follows the approval mode; explicit modes never do.
    expect(resolveSudoPrompt("auto", "confirm")).toBe("ask")
    expect(resolveSudoPrompt("auto", "full-auto")).toBe("popup")
    expect(resolveSudoPrompt("ask", "full-auto")).toBe("ask")
    expect(resolveSudoPrompt("popup", "confirm")).toBe("popup")
    // shell selects the default terminal posture; invalid values warn + auto.
    expect(parseAgentFile("a.md", "---\nshell: session\n---\nb", warnings)?.shell).toBe("session")
    expect(parseAgentFile("a.md", "---\nshell: background\n---\nb", warnings)?.shell).toBe("background")
    expect(parseAgentFile("a.md", "---\nshell: auto\n---\nb", warnings)?.shell).toBe("auto")
    expect(parseAgentFile("a.md", "---\nshell: sideways\n---\nb", warnings)?.shell).toBe("auto")
    expect(warnings.some((w) => w.includes('shell "sideways"'))).toBe(true)
    parseAgentFile("a.md", "---\nwat: 1\n---\nb", warnings)
    expect(warnings.some((w) => w.includes('unknown frontmatter key "wat"'))).toBe(true)
    parseAgentFile("a.md", "---\nname: x\n---\n", warnings)
    expect(warnings.some((w) => w.includes("empty prompt body"))).toBe(true)
  })

  test("ensureAgentDirs materializes agents/skills/memory + built-ins; a modified built-in is rescued under a fresh name and regenerated; custom files are never touched", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-agentdirs-"))
    try {
      const agentDir = agentsDir(dir)
      const copilotPath = join(agentDir, "copilot.md")
      const rescues = (): string[] => readdirSync(agentDir).filter((f) => f.startsWith("copilot.modified-") && f.endsWith(".md"))

      expect(ensureAgentDirs(dir)).toEqual([])
      expect(existsSync(agentDir)).toBe(true)
      expect(existsSync(join(dir, "skills"))).toBe(true)
      expect(existsSync(join(dir, "memory"))).toBe(true)
      expect(readFileSync(copilotPath, "utf8")).toBe(COPILOT_AGENT_MD)
      // Autopilot is merged into copilot — no autopilot.md is materialized.
      expect(existsSync(join(agentDir, "autopilot.md"))).toBe(false)

      // Banner-less file at the built-in name = user-modified: rescued, not clobbered.
      writeFileSync(copilotPath, "---\nname: copilot\n---\nmy custom prompt", "utf8")
      const warned = ensureAgentDirs(dir)
      expect(warned.some((w) => w.includes("was modified") && w.includes("rescued as"))).toBe(true)
      expect(readFileSync(copilotPath, "utf8")).toBe(COPILOT_AGENT_MD) // fresh generated
      expect(rescues().length).toBe(1)
      const saved = readFileSync(join(agentDir, rescues()[0]!), "utf8")
      expect(saved).toContain("my custom prompt")
      // The rescue got a unique agent name, so it and the fresh copilot both load, no duplicate warning.
      const loaded = loadAgents(dir)
      expect(loaded.byName["copilot"]?.prompt).toContain("operating as COPILOT")
      expect(loaded.byName["copilot"]?.prompt).not.toContain("SENSUS BUILT-IN")
      expect(loaded.byName[rescues()[0]!.replace(/\.md$/, "")]?.prompt).toBe("my custom prompt")
      expect(loaded.warnings.some((w) => w.includes("duplicate agent name"))).toBe(false)

      // An unedited older built-in (banner hash still matches its body) is refreshed in place, not rescued.
      writeFileSync(copilotPath, builtInMarkdown("---\nname: copilot\ndescription: old\n---\nold body"), "utf8")
      expect(ensureAgentDirs(dir)).toEqual([])
      expect(readFileSync(copilotPath, "utf8")).toBe(COPILOT_AGENT_MD)
      expect(rescues().length).toBe(1)

      // An in-place edit that keeps the banner no longer matches the hash → rescued.
      writeFileSync(copilotPath, COPILOT_AGENT_MD.replace("Keep moving.", "Edited by the user."), "utf8")
      ensureAgentDirs(dir)
      expect(rescues().length).toBe(2)

      // A custom (non-built-in) agent file is never touched.
      writeFileSync(join(agentDir, "mine.md"), "my own prompt", "utf8")
      ensureAgentDirs(dir)
      expect(readFileSync(join(agentDir, "mine.md"), "utf8")).toBe("my own prompt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("built-in skills: ensureAgentDirs materializes the Sensus-owned sensus skill; edits are rescued and both versions load", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-skilldirs-"))
    try {
      const skillsPath = join(skillsDir(dir), "sensus.md")
      expect(ensureAgentDirs(dir)).toEqual([])
      expect(BUILT_IN_SKILLS.map((b) => b.file)).toEqual(["sensus.md"])
      expect(readFileSync(skillsPath, "utf8")).toBe(SENSUS_SKILL_MD)

      // The banner is stripped: the loader sees a normal skill named "sensus".
      const cat = loadSkills(dir)
      expect(cat.byName["sensus"]?.name).toBe("sensus")
      expect(cat.byName["sensus"]?.description).toContain("Sensus")
      const body = cat.byName["sensus"]?.body ?? ""
      // The self-reference must actually document MCP/agents/skills/memory + config.
      for (const needle of ["## MCP SERVERS", "mcp__<server>__<tool>", "config.json", "agents/", "skills/", "## MEMORY"]) {
        expect(body).toContain(needle)
      }
      expect(body).not.toContain("SENSUS BUILT-IN")
      // The body must fit the tool-output defaults or skill_view truncates it.
      expect(body.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)

      // An unedited older built-in (banner hash still matches its body) refreshes in place.
      writeFileSync(skillsPath, builtInMarkdown("---\nname: sensus\ndescription: old\n---\nold body", "SKILL"), "utf8")
      expect(ensureAgentDirs(dir)).toEqual([])
      expect(readFileSync(skillsPath, "utf8")).toBe(SENSUS_SKILL_MD)

      // A user edit is rescued under a unique name (frontmatter renamed), then regenerated.
      writeFileSync(skillsPath, "---\nname: sensus\ndescription: mine\n---\nmy notes", "utf8")
      const warned = ensureAgentDirs(dir)
      expect(warned.some((w) => w.includes("sensus.md") && w.includes("rescued as"))).toBe(true)
      expect(readFileSync(skillsPath, "utf8")).toBe(SENSUS_SKILL_MD)
      expect(readdirSync(skillsDir(dir)).filter((f) => f.startsWith("sensus.modified-")).length).toBe(1)
      const loaded = loadSkills(dir)
      expect(loaded.byName["sensus"]?.description).not.toBe("mine")
      expect(loaded.skills.length).toBe(2) // fresh built-in + rescue, distinct names
      expect(loaded.warnings.some((w) => w.includes("duplicate skill name"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loadAgents: sorted by name, duplicate names keep the first, missing dir loads empty", () => {
    mkdirSync(agentsDir(home), { recursive: true })
    const write = (file: string, name: string, description: string): void =>
      writeFileSync(join(agentsDir(home), file), `---\nname: ${name}\ndescription: ${description}\n---\n${name} body`, "utf8")
    write("zeta.md", "zeta", "z")
    write("alpha.md", "alpha", "a")
    write("dup.md", "alpha", "duplicate")
    const res = loadAgents(home)
    expect(res.agents.map((a) => a.name)).toEqual(["alpha", "zeta"])
    expect(res.byName["alpha"]?.description).toBe("a")
    expect(res.warnings.some((w) => w.includes("duplicate agent name"))).toBe(true)
    for (const f of ["zeta.md", "alpha.md", "dup.md"]) rmSync(join(agentsDir(home), f)) // clean up for later tests
    expect(loadAgents(join(home, "nope")).agents).toEqual([])
  })

  test("built-ins: copilot + scout compile in with the documented frontmatter; fallbackAgent is a usable copilot", () => {
    const copilot = builtInAgent("copilot")
    expect(copilot?.name).toBe("copilot")
    expect(copilot?.tools).toBeNull()
    expect(copilot?.sudoPrompt).toBe("auto")
    expect(copilot?.shell).toBe("auto")
    expect(copilot?.readonly).toBe(false)
    expect(copilot?.prompt).toContain("COPILOT")
    expect(copilot?.prompt).not.toContain("SENSUS BUILT-IN")
    // Scout is the read-only researcher: readonly + background shell.
    const scout = builtInAgent("scout")
    expect(scout?.name).toBe("scout")
    expect(scout?.readonly).toBe(true)
    expect(scout?.shell).toBe("background")
    expect(scout?.prompt).toContain("You are operating as SCOUT")
    // Autopilot was merged into copilot (approval mode picks the posture).
    expect(builtInAgent("autopilot")).toBeNull()
    expect(builtInAgent("ghost")).toBeNull()
    expect(BUILT_IN_AGENTS.map((b) => b.file)).toEqual(["copilot.md", "scout.md"])

    const fb = fallbackAgent()
    expect(fb.name).toBe("copilot")
    expect(fb.prompt.length).toBeGreaterThan(0)
  })
})
