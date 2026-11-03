/**
 * System-prompt section contract (docs/agent-prompt.md "Sections"). The prompt
 * is a COMPILED registry: every section declares an order and renders itself
 * from the prompt facts plus the tool set the request actually carries, so
 * guidance for a tool that is not in the request is never rendered
 * (docs/agent-prompt.md "Tool-conditional sections").
 *
 * A section returns "" to contribute nothing — the registry skips it (no blank
 * line, no header). Everything a section renders must be derived from `facts`
 * and `ctx.tools` only: no clock, no cwd, no approval mode. The prompt is
 * BYTE-STABLE for the life of a session (docs/agent-context.md "Prompt
 * caching"); volatile values ride the per-generation terminal context block.
 */

import type { AgentDef } from "../../config/agents.ts"
import type { SkillsCatalog } from "../skills/loader.ts"

/** Everything the prompt is built from. Captured once per session (or per
 * request for the static parts) — see chatSession.ts. */
export interface SystemPromptFacts {
  /** e.g. "Linux 6.8.0 (linux)" */
  os: string
  hostname: string
  shell: string
  model: string
  /** The active agent (its prompt body lands in the prompt). */
  agent: AgentDef
  /** Short human descriptor of the terminal engine, e.g. "embedded PTY
   * (xterm-256color)". Static for the life of a session (prompt is byte-stable). */
  terminal: string
  /** The endpoint refused tools — plain-chat mode (docs/agent.md). */
  noTools: boolean
  /**
   * The core tool names the request actually offers, already filtered by the
   * agent's `tools` list, `readonly`, a disabled memory and model vision
   * (`toolSpecsForRequest`). A section must not mention a tool without asking
   * `ctx.has(...)`: an agent that opted out of the shell must not be told how
   * to use it. Empty in no-tools mode.
   */
  tools: readonly string[]
  /** Connected MCP servers + their tool names (M11, docs/mcp.md). */
  mcp?: Array<{ name: string; tools: string[] }>
  /** Skills catalog: only names + descriptions reach the prompt (progressive
   * disclosure); `skill_view` loads a full body (docs/skills.md). */
  skills?: SkillsCatalog
  /** ~/.config/sensus/AGENTS.md contents (null when absent). */
  customInstructions: string | null
  /** Frozen MEMORY.md snapshot (null/undefined = memory disabled or empty).
   * NEVER a live read — the ChatSession captures it once (docs/memory.md). */
  memory?: { text: string; used: number; limit: number } | null
}

/** What a section renders from. */
export interface SectionCtx {
  facts: SystemPromptFacts
  /** The tool names in this request (`facts.tools`, as a set). */
  tools: ReadonlySet<string>
  /** True when the request offers the named tool. */
  has(tool: string): boolean
}

/** One prompt section. `order` sorts the registry (gaps allow insertion). */
export interface PromptSection {
  name: string
  order: number
  /** The section body ("" = omit entirely). No trailing newline. */
  render(ctx: SectionCtx): string
}

/** Declare a section (keeps the registry literal-shaped). */
export function section(name: string, order: number, render: (ctx: SectionCtx) => string): PromptSection {
  return { name, order, render }
}
