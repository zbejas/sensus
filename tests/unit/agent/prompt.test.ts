import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../../../src/agent/prompt.ts"
import { fallbackAgent } from "../../../src/config/agents.ts"
import type { SkillsCatalog } from "../../../src/agent/skills/loader.ts"

const base = {
  os: "Linux test",
  hostname: "host",
  shell: "/bin/bash",
  model: "main@test",
  agent: fallbackAgent(),
  terminal: "embedded PTY (xterm-256color)",
  noTools: false,
  customInstructions: null,
}

const skills: SkillsCatalog = {
  skills: [{ name: "deploy", description: "ship the app", path: "/x/SKILL.md", body: "steps" }],
  byName: {},
  warnings: [],
}

describe("buildSystemPrompt facts", () => {
  test("skills appear as a name/description index only (progressive disclosure)", () => {
    const prompt = buildSystemPrompt({ ...base, skills })
    expect(prompt).toContain("Skills (reusable procedures")
    expect(prompt).toContain("- deploy: ship the app")
    expect(prompt).not.toContain("steps") // body is loaded via skill_view only
  })

  test("an empty or absent catalog adds no skills block", () => {
    const empty = buildSystemPrompt({ ...base, skills: { skills: [], byName: {}, warnings: [] } })
    expect(empty).not.toContain("Skills (reusable procedures")
    expect(buildSystemPrompt(base)).not.toContain("Skills (reusable procedures")
  })

  test("the memory block carries the frozen snapshot header and host/journal pointer", () => {
    const prompt = buildSystemPrompt({ ...base, memory: { text: "port 2222", used: 9, limit: 2200 } })
    expect(prompt).toContain("MEMORY [9/2200 chars]")
    expect(prompt).toContain("port 2222")
    expect(prompt).toContain("ALWAYS consult HOST.md")
    expect(prompt).toContain('target "host"')
    expect(prompt).toContain("target \"journal\"")
    // Memory-full guidance rides with the block (only when memory is present).
    expect(prompt).toContain("When a store is full")
    expect(prompt).toContain('action "rewrite"')
    // The prompt never advertises HOST.md when memory is disabled/absent.
    expect(buildSystemPrompt(base)).not.toContain("ALWAYS consult HOST.md")
    expect(buildSystemPrompt(base)).not.toContain("When a store is full")
  })

  test("the read_file-over-shell rule is present (approval-card hygiene)", () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).toContain("Read files with read_file")
    expect(prompt).toContain("approval card")
  })

  test("the active agent's shell preference steers the shell-tool guidance", () => {
    // Isolate the prompt's own shell guidance: the copilot BODY also mentions
    // both postures (it is approval-conditional), so use an empty body here.
    const bare = { ...base.agent, prompt: "" }
    const session = buildSystemPrompt({ ...base, agent: { ...bare, shell: "session" } })
    expect(session).toContain("SESSION-FIRST")
    expect(session).not.toContain("BACKGROUND-FIRST")
    const background = buildSystemPrompt({ ...base, agent: { ...bare, shell: "background" } })
    expect(background).toContain("BACKGROUND-FIRST")
    expect(background).not.toContain("SESSION-FIRST")
    const auto = buildSystemPrompt({ ...base, agent: { ...bare, shell: "auto" } })
    expect(auto).not.toContain("SESSION-FIRST")
    expect(auto).not.toContain("BACKGROUND-FIRST")
  })
})
