import type { PromptSection } from "../section.ts"
import { activeAgentSection } from "./activeAgent.ts"
import { agentInstructionsSection } from "./agentInstructions.ts"
import { approvalsSection } from "./approvals.ts"
import { customInstructionsSection } from "./customInstructions.ts"
import { environmentSection } from "./environment.ts"
import { mcpSection } from "./mcp.ts"
import { memorySection } from "./memory.ts"
import { noToolsSection } from "./noTools.ts"
import { roleSection } from "./role.ts"
import { rulesSection } from "./rules.ts"
import { shellToolsSection } from "./shells.ts"
import { skillsSection } from "./skills.ts"
import { whenToAskSection } from "./whenToAsk.ts"

/**
 * The ordered prompt registry (docs/agent-prompt.md "Sections"). Order gaps of
 * 50-100 leave room to insert a section without renumbering the rest; the
 * array is sorted once at module load, so a section cannot drift by being
 * appended in the wrong place.
 */
export const PROMPT_SECTIONS: readonly PromptSection[] = [
  roleSection,
  activeAgentSection,
  environmentSection,
  shellToolsSection,
  rulesSection,
  approvalsSection,
  whenToAskSection,
  agentInstructionsSection,
  noToolsSection,
  mcpSection,
  skillsSection,
  customInstructionsSection,
  memorySection,
].sort((a, b) => a.order - b.order)
