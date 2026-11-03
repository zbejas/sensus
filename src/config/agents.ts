/**
 * Agents (docs/agents.md): markdown agent definitions in
 * ~/.config/sensus/agents/*.md — frontmatter (name, description, tools,
 * sudoPrompt) + a prompt body that is appended to the system prompt.
 *
 * - Built-in (copilot) is SENSUS-OWNED: materialized into the dir
 *   on boot with a hashed banner. An unedited built-in is refreshed in place
 *   when the compiled-in markdown changes; a user-modified one is rescued as
 *   <stem>.modified-<time>.md (unique name) and a fresh built-in is generated.
 *   The same lifecycle materializes the built-in skills (builtinSkills.ts) via
 *   the shared materializer in builtins.ts.
 * - The frontmatter parser is hand-rolled (no YAML dep): supports
 *   `key: value`, `key: [a, b]` inline arrays and `- item` block lists —
 *   enough for the documented fields. Unknown fields warn, never throw.
 * - `tools` restricts which core tools the agent's requests carry (absent or
 *   `["*"]` = all); `sudoPrompt` is `ask` (tell the user; default), `popup`
 *   (always prompt + retry), or `auto` (popup in full-auto, ask in confirm —
 *   the merged copilot). `shell` (auto/session/background) steers the agent
 *   toward the user's visible terminal or the hidden shell.
 *
 * Pure loader (fs reads only, no signals); /reload re-runs loadAgents().
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { agentsDir, memoryDir, skillsDir } from "./config.ts"
import { errorMessage } from "../core/util.ts"
import { builtInMarkdown, materializeBuiltIns, stripLeadingComment, type BuiltInFile } from "./builtins.ts"
import { BUILT_IN_SKILLS } from "./builtinSkills.ts"

export { builtInMarkdown } from "./builtins.ts"

export type SudoPromptMode = "ask" | "popup" | "auto"

/** Which shell an agent should default to (docs/agents.md `shell`):
 * `session` = the user's visible terminal (shell_session), `background` =
 * the hidden shell (shell_background), `auto` = the shared neutral guidance. */
export type ShellPreference = "auto" | "session" | "background"

export interface AgentDef {
  /** The agent's selection name (defaults to the file stem). */
  name: string
  /** One-line description (agent picker subtitle). */
  description: string
  /** Core tool names the agent may call; null = all. */
  tools: string[] | null
  /** Skill names this agent may see/use (docs/skills.md); null = all. */
  skills: string[] | null
  /** Sudo failure handling: "popup" (always prompt), "ask" (tell the user),
   * or "auto" (popup in full-auto, ask in confirm — the merged copilot). */
  sudoPrompt: SudoPromptMode
  /** Default shell posture: "session" (the user's visible terminal),
   * "background" (hidden shell), or "auto" (no preference). */
  shell: ShellPreference
  /**
   * Read-only guard (docs/agents.md `readonly`). When true the execution layer
   * hard-denies every mutating call — `edit_file`/`write_file`/`memory`, the
   * pane `shell_session`, and any mutating shell command — independent of the
   * `tools` list and un-overridable by permission rules, session trust or an
   * approval policy. Defaults to false (absent).
   */
  readonly?: boolean
  /** The prompt body (markdown, appended verbatim to the system prompt). */
  prompt: string
  /** Absolute path of the source file (diagnostics). */
  path: string
}

export interface AgentsLoadResult {
  agents: AgentDef[]
  /** Sorted by name — the picker's order. */
  byName: Record<string, AgentDef>
  warnings: string[]
}

/** The catalog surface consumers (ChatSession deps, ChatHost) use. */
export type AgentsCatalog = Pick<AgentsLoadResult, "agents" | "byName" | "warnings">

// ---- frontmatter parsing -------------------------------------------------------

/** Parse `---\n…\n---` frontmatter from an agent markdown file (never throws). */
export function parseAgentFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const src = stripLeadingComment(text)
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src)
  if (m === null) return { meta: {}, body: src }
  const meta: Record<string, string | string[]> = {}
  const lines = (m[1] ?? "").split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    i++
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1] ?? ""
    const value = (kv[2] ?? "").trim()
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1)
      meta[key] =
        inner.trim().length === 0
          ? []
          : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s.length > 0)
      continue
    }
    if (value.length === 0 && (lines[i] ?? "").trim().startsWith("- ")) {
      const items: string[] = []
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("- ")) {
        items.push((lines[i] ?? "").trim().slice(2).trim().replace(/^["']|["']$/g, ""))
        i++
      }
      meta[key] = items
      continue
    }
    meta[key] = value.replace(/^["']|["']$/g, "")
  }
  return { meta, body: m[2] ?? "" }
}

const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "tools", "skills", "sudoPrompt", "sudo", "shell", "readonly"])

/** Parse one agent file's text into a def (warnings collector, name fallback). */
export function parseAgentFile(fileName: string, text: string, warnings: string[]): AgentDef | null {
  const { meta, body } = parseAgentFrontmatter(text)
  for (const k of Object.keys(meta)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(k)) warnings.push(`agents: ${fileName}: unknown frontmatter key "${k}" ignored`)
  }
  const fallbackName = fileName.replace(/\.md$/i, "")
  const rawName = meta["name"]
  const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : fallbackName
  if (name.length === 0) return null
  const description = typeof meta["description"] === "string" ? meta["description"] : ""
  let tools: string[] | null = null
  const rawTools = meta["tools"]
  if (Array.isArray(rawTools)) {
    const cleaned = rawTools.map((t) => t.trim()).filter((t) => t.length > 0)
    tools = cleaned.includes("*") || cleaned.length === 0 ? null : cleaned
  } else if (typeof rawTools === "string" && rawTools.length > 0) {
    tools = rawTools === "*" ? null : [rawTools]
  }
  let skills: string[] | null = null
  const rawSkills = meta["skills"]
  if (Array.isArray(rawSkills)) {
    const cleaned = rawSkills.map((t) => t.trim()).filter((t) => t.length > 0)
    skills = cleaned.includes("*") || cleaned.length === 0 ? null : cleaned
  } else if (typeof rawSkills === "string" && rawSkills.length > 0) {
    skills = rawSkills === "*" ? null : [rawSkills]
  }
  const rawSudo = meta["sudoPrompt"] ?? meta["sudo"]
  let sudoPrompt: SudoPromptMode = "ask"
  if (typeof rawSudo === "string") {
    const v = rawSudo.trim().toLowerCase()
    if (v === "popup" || v === "ask" || v === "auto") sudoPrompt = v
    else if (v.length > 0) warnings.push(`agents: ${fileName}: sudoPrompt "${rawSudo}" must be "ask", "popup" or "auto" — using "ask"`)
  }
  let shell: ShellPreference = "auto"
  const rawShell = meta["shell"]
  if (typeof rawShell === "string") {
    const v = rawShell.trim().toLowerCase()
    if (v === "auto" || v === "session" || v === "background") shell = v
    else if (v.length > 0) warnings.push(`agents: ${fileName}: shell "${rawShell}" must be "auto", "session" or "background" — using "auto"`)
  }
  let readonly = false
  const rawReadonly = meta["readonly"]
  if (Array.isArray(rawReadonly)) {
    warnings.push(`agents: ${fileName}: readonly must be true or false, not a list — using false`)
  } else if (typeof rawReadonly === "string") {
    const v = rawReadonly.trim().toLowerCase()
    if (v === "true" || v === "yes" || v === "on" || v === "1") readonly = true
    else if (v === "false" || v === "no" || v === "off" || v === "0" || v.length === 0) readonly = false
    else warnings.push(`agents: ${fileName}: readonly "${rawReadonly}" must be true or false — using false`)
  }
  const prompt = body.trim()
  if (prompt.length === 0) warnings.push(`agents: ${fileName}: empty prompt body — the agent adds nothing to the system prompt`)
  return { name, description, tools, skills, sudoPrompt, shell, readonly, prompt, path: fileName }
}

// ---- built-ins ------------------------------------------------------------------

const COPILOT_BODY = `---
name: copilot
description: Guides you step by step in YOUR terminal — session-first in confirm, autonomous in full-auto
tools: ["*"]
sudoPrompt: auto
shell: auto
---
You are operating as COPILOT: the user's terminal guide. Their visible shell is
your shared workspace — work WITH it, not beside it.

The approval mode in the terminal context block sets your posture:

CONFIRM (default) — SESSION-FIRST. Anything the user asks you to run, change,
or see belongs in THEIR visible terminal: type it with shell_session so they
watch it happen and can stop it. If they say "use my terminal", "in my session",
or name the shell/pane, that command MUST go through shell_session.
shell_background is for quiet, read-only investigation and side work they do
not need to watch — never a shortcut around an approval card, never a hiding
place for a command they asked to run.

FULL-AUTO — BACKGROUND-FIRST, autonomous. The user handed you the wheel; take
it. Drive the task end-to-end with shell_background and the file tools. Plan
briefly, then execute without narrating every keystroke, and VERIFY each step
(rerun the check, read the file back) before moving on. A failed step is a fact
to investigate — fix it or report it, never paper over it. Use shell_session
only when the goal needs them to watch something live, or they asked for it.
Finish with a compact summary: what changed, what ran, what is left open.

Principles (both modes):
- Keep moving. Show the result, then stop and let the user speak. Do not close
  every step with a question.
- In confirm mode, one visible step at a time: say what you are about to do and
  why in one line, do it, then check the result (get_scrollback shows you the
  pane) before the next.
- Investigate freely: read_file and read-only shell_background commands need no
  ceremony. A state change is gated by its approval card anyway — do not stack
  a confirmation of your own on top.
- Keep answers short. Show the command, run it, show what happened. Theory only
  when asked.
`

export const COPILOT_AGENT_MD = builtInMarkdown(COPILOT_BODY)

const SCOUT_BODY = `---
name: scout
description: Read-only research — explores the machine and code, reports, never changes state
tools: ["*"]
readonly: true
sudoPrompt: ask
shell: background
---
You are operating as SCOUT: a read-only researcher. Explore the machine and the
code, answer the question, and report what you found. You never change state.

The readonly guard is enforced in the execution layer, not just here: mutating
tools (edit_file, write_file, shell_session) and any mutating shell command are
refused before they run, whatever your reasoning says. The memory tool is
read-only for you too — actions "list" and "read" work, every write is denied.
Work WITH that boundary instead of fighting it:
- Read with read_file, get_scrollback, session_search/list/view, skills_list/view,
  host_scan, HOST.md and JOURNAL.md (memory tool, "list"/"read"), and read-only
  shell_background commands (ls, cat, grep, find, git status/log/diff/show, ps,
  env, …).
- If a task genuinely needs a change, do not attempt it: describe exactly what
  should change and hand it back to the user (or suggest copilot), then stop.
- Never try to work around the guard (writing via an interpreter, redirects,
  in-place editors, package managers, service control). It will just be denied.

Report concisely: what you checked, what you found, and any uncertainty. Cite
paths and commands you actually ran.
`

export const SCOUT_AGENT_MD = builtInMarkdown(SCOUT_BODY)

const ASK_BODY = `---
name: ask
description: Answers questions about your terminal, machine and code — read-only, changes nothing
tools: ["*"]
readonly: true
sudoPrompt: ask
shell: background
---
You are operating as ASK: a read-only answering posture. The user has a question
about this machine, this code, or what is happening in their terminal. Answer it.

- Answer first, briefly, in plain language. Put the command, path or file:line
  that backs it up next to the claim.
- Ground every claim in evidence you actually gathered: the terminal context,
  read_file, get_scrollback, HOST.md (memory tool, action "list"/"read"),
  session_search, or a read-only shell command. Say "I could not confirm" when
  you could not — never fill a gap with what is usually true.
- Investigate only as deep as the question needs. Stop when the answer is
  established; do not tour the repo.
- You cannot change anything: edits, memory writes and shell_session are refused
  by the guard. When the answer is "do X", give the exact command or patch and
  stop — hand the change to copilot rather than attempting it.
- No preamble, no restating the question, no narration of what you inspected
  unless the path to the answer matters. One short answer beats three sections.
`

export const ASK_AGENT_MD = builtInMarkdown(ASK_BODY)

/** Built-in agent files written into ~/.config/sensus/agents/ on boot.
 * Copilot is the general guide: confirm mode is session-first, full-auto is
 * background-first/autonomous (the old autopilot), and `sudoPrompt: auto`
 * follows the approval mode. Scout is the read-only researcher and ask the
 * read-only answering posture: their `readonly: true` guard hard-denies every
 * mutation in the execution layer (memory reads still work). */
export const BUILT_IN_AGENTS: BuiltInFile[] = [
  { file: "copilot.md", markdown: COPILOT_AGENT_MD },
  { file: "scout.md", markdown: SCOUT_AGENT_MD },
  { file: "ask.md", markdown: ASK_AGENT_MD },
]

/**
 * The compiled-in definition of a built-in agent (parsed from the same
 * markdown that materializes into the config dir). The runtime fallback when
 * the user deleted the file or the dir is unreadable — copilot must keep
 * working even then.
 */
export function builtInAgent(name: string): AgentDef | null {
  for (const b of BUILT_IN_AGENTS) {
    if (b.file.replace(/\.md$/i, "") !== name) continue
    const warnings: string[] = []
    const def = parseAgentFile(b.file, b.markdown, warnings)
    return def
  }
  return null
}

/** Resolve a frontmatter `sudoPrompt` against the live approval mode. An
 * explicit `ask`/`popup` is fixed; `auto` (the merged copilot) follows the
 * approval mode — popup in full-auto, ask in confirm. Pure + unit-tested. */
export function resolveSudoPrompt(mode: SudoPromptMode, approval: "confirm" | "full-auto"): "ask" | "popup" {
  if (mode === "popup" || mode === "ask") return mode
  return approval === "full-auto" ? "popup" : "ask"
}

/** The last-resort agent (copilot) when nothing else resolves. */
export function fallbackAgent(): AgentDef {
  return (
    builtInAgent("copilot") ?? {
      name: "copilot",
      description: "",
      tools: null,
      skills: null,
      sudoPrompt: "auto",
      shell: "auto",
      readonly: false,
      prompt: "",
      path: "(built-in)",
    }
  )
}

/**
 * Ensure the agents/skills/memory dirs exist and the built-in agents + skills
 * are materialized. Built-ins are SENSUS-OWNED (shared lifecycle in
 * builtins.ts):
 *  - missing → written;
 *  - unchanged → left alone;
 *  - an older/unedited built-in (its banner hash still matches its body, or
 *    only the banner differs) → refreshed in place on update;
 *  - user-modified (banner hash missing/mismatched, or a banner-less file) →
 *    rescued as `<stem>.modified-<timestamp>.md` with a unique name, then a
 *    fresh built-in is generated.
 * Any other file is never touched. Best-effort: failures warn, never throw.
 */
export function ensureAgentDirs(home: string): string[] {
  const warnings: string[] = []
  for (const dir of [agentsDir(home), skillsDir(home), memoryDir(home)]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch (e) {
      warnings.push(`agents: could not create ${dir} (${errorMessage(e)})`)
    }
  }
  materializeBuiltIns(agentsDir(home), BUILT_IN_AGENTS, "AGENT", warnings)
  materializeBuiltIns(skillsDir(home), BUILT_IN_SKILLS, "SKILL", warnings)
  return warnings
}

// ---- loading ---------------------------------------------------------------------

/**
 * Load every agent in ~/.config/sensus/agents (sorted by file name, which
 * makes the built-in deterministic). Built-ins are NOT re-injected when
 * the user deleted them — an empty dir means no agents (the session falls
 * back to a default posture). Never throws.
 */
export function loadAgents(home: string): AgentsLoadResult {
  const warnings: string[] = []
  const dir = agentsDir(home)
  const agents: AgentDef[] = []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort()
  } catch {
    return { agents: [], byName: {}, warnings } // no dir — caller ensures it
  }
  for (const f of files) {
    const path = join(dir, f)
    try {
      const def = parseAgentFile(f, readFileSync(path, "utf8"), warnings)
      if (def !== null) agents.push(def)
    } catch (e) {
      warnings.push(`agents: could not read ${path} (${errorMessage(e)})`)
    }
  }
  const seen = new Set<string>()
  const byName: Record<string, AgentDef> = {}
  const unique: AgentDef[] = []
  for (const a of agents) {
    if (seen.has(a.name)) {
      warnings.push(`agents: duplicate agent name "${a.name}" — the first definition wins`)
      continue
    }
    seen.add(a.name)
    unique.push(a)
    byName[a.name] = a
  }
  return { agents: unique, byName, warnings }
}
