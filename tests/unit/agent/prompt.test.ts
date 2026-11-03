import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../../../src/agent/prompt.ts"
import { TOOL_SPECS } from "../../../src/agent/tools.ts"
import { builtInAgent, fallbackAgent } from "../../../src/config/agents.ts"
import type { SkillsCatalog } from "../../../src/agent/skills/loader.ts"

/** Every core tool the endpoint can offer (the copilot request shape). */
const ALL_TOOLS = TOOL_SPECS.map((s) => s.function.name)

const base = {
  os: "Linux test",
  hostname: "host",
  shell: "/bin/bash",
  model: "main@test",
  agent: fallbackAgent(),
  terminal: "embedded PTY (xterm-256color)",
  noTools: false,
  tools: ALL_TOOLS,
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

describe("buildSystemPrompt tool-conditional sections", () => {
  /** A bare posture so only the shared sections are in play. */
  const bare = { ...base, agent: { ...fallbackAgent(), prompt: "" } }

  test("an agent without shell tools is never taught the two-shell model", () => {
    const prompt = buildSystemPrompt({
      ...bare,
      tools: ["read_file", "get_scrollback", "ask_user"],
      memory: { text: "", used: 0, limit: 2200 },
    })
    expect(prompt).not.toContain("shell_background")
    expect(prompt).not.toContain("shell_session")
    expect(prompt).not.toContain("sudo")
    // Its reads still get explained.
    expect(prompt).toContain("Read files with read_file")
  })

  test("guidance disappears with the tool that justifies it", () => {
    const noRead = buildSystemPrompt({ ...bare, tools: ALL_TOOLS.filter((n) => n !== "read_file") })
    expect(noRead).not.toContain("Read files with read_file")

    const noReload = buildSystemPrompt({ ...bare, tools: ALL_TOOLS.filter((n) => n !== "reload") })
    expect(noReload).not.toContain("call the reload tool")

    const noAsk = buildSystemPrompt({ ...bare, tools: ALL_TOOLS.filter((n) => n !== "ask_user") })
    expect(noAsk).not.toContain("When to ask (ask_user)")

    const noSkills = buildSystemPrompt({ ...base, skills, tools: ALL_TOOLS.filter((n) => n !== "skill_view") })
    expect(noSkills).not.toContain("Skills (reusable procedures")
  })

  test("a read-only agent keeps the approval economics but loses the ask-user policy", () => {
    const scout = builtInAgent("scout")
    expect(scout).not.toBeNull()
    const tools = ALL_TOOLS.filter((n) => !["edit_file", "write_file", "shell_session", "ask_user"].includes(n))
    const prompt = buildSystemPrompt({ ...base, agent: scout ?? base.agent, tools })
    // shell_session guidance is gone; background work still is explained.
    expect(prompt).not.toContain("- shell_session:")
    // It cannot type into the pane, so it is not asked to explain an approval card.
    expect(prompt).not.toContain("When to ask (ask_user)")
    expect(prompt).toContain("read-only researcher")
  })

  test("no-tools mode drops every tool-specific section", () => {
    const prompt = buildSystemPrompt({ ...base, agent: { ...fallbackAgent(), prompt: "" }, noTools: true, tools: [] })
    expect(prompt).toContain("Tool use is UNAVAILABLE on this endpoint")
    expect(prompt).not.toContain("shell_background")
    expect(prompt).not.toContain("- sudo:")
    expect(prompt).not.toContain("Working with approvals")
    expect(prompt).not.toContain("When to ask (ask_user)")
  })
})

describe("buildSystemPrompt registry", () => {
  const facts = {
    ...base,
    memory: { text: "port 2222", used: 9, limit: 2200 },
    mcp: [{ name: "github", tools: ["search_code", "create_issue"] }],
    skills,
    customInstructions: "Use bun, never npm.",
  }

  test("the built-in agents render a stable prompt (snapshot)", () => {
    const copilot = buildSystemPrompt(facts)
    expect(copilot).toMatchSnapshot("copilot")
    const scout = builtInAgent("scout")
    const ask = builtInAgent("ask")
    expect(scout).not.toBeNull()
    expect(ask).not.toBeNull()
    expect(buildSystemPrompt({ ...facts, agent: scout ?? facts.agent })).toMatchSnapshot("scout")
    expect(buildSystemPrompt({ ...facts, agent: ask ?? facts.agent })).toMatchSnapshot("ask")
  })

  test("the same facts always render the same bytes (prompt-cache invariant)", () => {
    expect(buildSystemPrompt(facts)).toBe(buildSystemPrompt(facts))
  })

  test("a section that renders nothing leaves no blank gap", () => {
    const prompt = buildSystemPrompt({ ...base, noTools: false })
    expect(prompt).not.toContain("\n\n\n")
    expect(prompt.startsWith("You are the Sensus agent")).toBe(true)
  })
})
