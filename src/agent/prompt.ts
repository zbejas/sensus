/**
 * System prompt assembly (docs/agent-prompt.md): a COMPILED registry of ordered
 * sections, each rendered from the prompt facts plus the tool set the request
 * actually carries. Role, environment, the shared rules, the approval and
 * ask-user policies, the ACTIVE AGENT's posture body (from
 * ~/.config/sensus/agents/, docs/agents.md), MCP facts and
 * ~/.config/sensus/AGENTS.md — each is one section under
 * `./prompt/sections/`, gated on the facts it needs. Pure.
 *
 * Prompt-cache invariant (docs/agent-context.md "Prompt caching"): the prompt
 * must be BYTE-STABLE for the life of a session — no volatile values (cwd,
 * approval mode, timestamps), and the tool set is fixed per session (agent,
 * `readonly`, memory enabled, model vision). Volatile environment facts ride in
 * the durable per-turn terminal context message instead, so a `cd` or /yolo
 * never invalidates the provider's prefix cache.
 */

import { PROMPT_SECTIONS } from "./prompt/sections/index.ts"
import type { SectionCtx, SystemPromptFacts } from "./prompt/section.ts"

export type { PromptSection, SectionCtx, SystemPromptFacts } from "./prompt/section.ts"

/** Every registered section, in render order (tests + the inspector). */
export { PROMPT_SECTIONS }

/**
 * Render the prompt. Sections that return "" are skipped entirely — no blank
 * line is left where a conditional block did not apply.
 */
export function buildSystemPrompt(f: SystemPromptFacts): string {
  const tools = new Set(f.tools)
  const ctx: SectionCtx = { facts: f, tools, has: (tool) => tools.has(tool) }
  const blocks: string[] = []
  for (const section of PROMPT_SECTIONS) {
    const text = section.render(ctx)
    if (text.length > 0) blocks.push(text)
  }
  return blocks.join("\n\n")
}
