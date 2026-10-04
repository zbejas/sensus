/**
 * Barrel for the tool layer: the single aggregation point that re-exports the
 * public surface consumed via `../tools.ts` (docs/agent.md "Tools"). Each
 * module owns one cohesive slice; this file only wires names, never logic.
 *
 * Exports are listed explicitly (rather than `export *`) so internal
 * cross-module helpers (`argString`, `numArg`) stay private and the public
 * surface matches the original single-file module exactly.
 */

export { TOOL_SPECS } from "./specs.ts"
export { truncateHeadTail, truncateHead } from "./text.ts"
export { parseToolArguments, resolveToolName, resolveToolPath } from "./parse.ts"
export {
  commandUsesSudo,
  isSudoPasswordFailure,
  isSudoPasswordRejection,
  commandHasNonInteractiveSudo,
  commandAllSudoNonInteractive,
  commandWithSudoStdin,
  commandWithSudoAskpass,
  countSudoInvocations,
} from "./sudo.ts"
export {
  runHiddenCommand,
  startBackgroundJob,
  checkBackgroundJob,
  killBackgroundJob,
  clearJobs,
  activeJobs,
  runCommandResultText,
} from "./jobs.ts"
export { diffLinesText, compactDiff } from "./diff.ts"
export { planEditFile, planWriteFile, applyFilePlan } from "./filePlan.ts"
export {
  isDestructiveCommand,
  matchGlob,
  approvalDecision,
  isTrustExempt,
  trustPatternFor,
  trustChipLabel,
  shellSessionSubmits,
  shellSessionSubmitText,
  READONLY_DENIED_TOOLS,
  isReadOnlyShellCommand,
  readonlyGuardDecision,
} from "./approval.ts"
export { executeMemoryTool, isMemoryWrite, runHostScan, executeTool } from "./execute.ts"
export { commandPrefix, suggestAllowPrefix, toolApprovalDetail, toolParamsSummary } from "./summary.ts"

export type {
  ToolSpec,
  AgentPane,
  McpBridge,
  ToolContext,
  RunCommandResult,
  JobReport,
  DiffLine,
  FilePlan,
  PlanResult,
  ApprovalDecision,
  ToolExecution,
} from "./types.ts"
export type { ActiveJobInfo } from "./jobs.ts"
export type { TrustPattern } from "./approval.ts"
