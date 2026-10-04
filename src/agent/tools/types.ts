/**
 * Shared type surface for the tool layer (see docs/agent.md "Tools"). Type
 * declarations only — every runtime helper lives in a sibling module.
 */

import type { ImageAttachment } from "../../core/image.ts"
import type { PaneState } from "../../terminal/paneState.ts"
import type { MemoryToolBridge, MemoryWriteInfo } from "../memory/types.ts"
import type { SkillsCatalog } from "../skills/loader.ts"
import type { ToolOutputLimits } from "../truncate.ts"
import type { SessionSearchBridge } from "../../session/indexDb.ts"

export interface ToolSpec {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Structural pane surface the tools need (the real Pane satisfies it). */
export interface AgentPane {
  sendKeys(action: { kind: "literal"; text: string } | { kind: "keys"; names: string[] }): Promise<void>
  captureScrollbackRaw(lines: number): Promise<string>
  /**
   * Structured pane-state probe (docs/terminal-layer.md "Pane state"). Optional
   * so older/stub panes still satisfy the surface; when absent, `shell_session`
   * treats the state as unknown (it never refuses blindly).
   */
  paneState?(tailLines?: number): PaneState
}

/**
 * MCP bridge (M11, docs/mcp.md): routes `mcp__<server>__<tool>` calls to the
 * registry. Structural so tests stub it like AgentPane.
 */
export interface McpBridge {
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; result: string }>
}

export interface ToolContext {
  /** Active pane handle (shell_session / get_scrollback); null = unavailable. */
  pane: AgentPane | null
  /** Active pane cwd (#{pane_current_path}); base for relative paths. */
  paneCwd: string | null
  /**
   * Stable id of the owning chat session. Background jobs are tagged with it so
   * `/clear` kills only that session's jobs (the job registry is process-global
   * across tabs). undefined = jobs are untagged/global.
   */
  jobScope?: string
  /** Generation signal: Esc aborts fetches AND kills running commands. */
  signal: AbortSignal
  /** MCP registry bridge (mcp__* dispatch); undefined = MCP off. */
  mcp?: McpBridge
  /** Sudo popup/seam: resolve the user's sudo password (from the session
   * vault when cached, else the masked popup). When absent (ask posture with
   * no cached password), sudo failures return "ask the user" guidance. The
   * password is never model-facing. `hint` is an optional line the popup shows
   * to explain a re-prompt (e.g. after sudo refused a wrong password). */
  requestSudo?(command: string, hint?: string): Promise<string | null>
  /** The user's cached sudo password was just REJECTED: drop it so a later
   * sudo failure can ask again instead of silently reusing a bad password. */
  onSudoRejected?(): void
  /** True when a session sudo password is already cached. Lets the executor
   * authenticate proactively (askpass) and run once — no first failure to
   * depend on, no popup. */
  hasSudoPassword?(): boolean
  /** Agent memory bridge (docs/memory.md). undefined = memory disabled. */
  memory?: MemoryToolBridge
  /** Session search index (Phase 1.6). undefined = index not wired. */
  sessionSearch?: SessionSearchBridge
  /** Skills catalog (docs/skills.md); undefined = skills unavailable. */
  skills?: SkillsCatalog
  /** Tool-output truncation thresholds (docs/config.md "tool_output"). */
  toolOutput?: ToolOutputLimits
  /** Where truncated output is spilled; null/absent = cap without spilling. */
  toolOutputDir?: string | null
  /** Re-read config + AGENTS.md/instructions + agents + skills + MCP config
   * (the /reload action); returns a status message, or null when the reload
   * failed. undefined = unavailable (no config host wired). Read-only. */
  reloadConfig?: () => string | null
}

export interface RunCommandResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  /** Killed because the user aborted (Esc), not because of a timeout. */
  aborted: boolean
  /** A background job id, when started with background: true. */
  jobId?: number
}

export interface JobReport {
  ok: boolean
  error?: string
  running?: boolean
  exitCode?: number | null
  timedOut?: boolean
  output?: string
}

export interface DiffLine {
  kind: " " | "+" | "-"
  text: string
}

export interface FilePlan {
  path: string
  /** Content to write once approved. */
  newContent: string
  /** True when the file already exists on disk. */
  existed: boolean
  /** Card diff (already compacted). */
  diff: DiffLine[]
}

export type PlanResult = { ok: true; plan: FilePlan } | { ok: false; error: string }

export interface ApprovalDecision {
  /** true = render an accept/reject card and wait for the user. */
  gate: boolean
  destructive?: boolean
  /** When auto-approved via the session allowlist: the matching prefix. */
  allowPrefix?: string
  /**
   * Explicit outcome when a `permission` rule decided this call (P2a). Absent
   * when no rule matched (the mode/tool baseline stands). `"deny"` is terminal:
   * the tool must not execute, even in full-auto.
   */
  action?: "allow" | "ask" | "deny"
  /**
   * Set when an extensions `ApprovalPolicy` produced a `deny`
   * (docs/extensions.md) or when a read-only agent's guard denied the call
   * (docs/agents.md `readonly`). Absent on a config `permission` deny; the
   * caller phrases the sources distinctly.
   */
  denySource?: "permission" | "policy" | "guard"
  /** Optional human-readable reason for a policy denial. */
  denyReason?: string
  /**
   * For an `allow`, whether the extensions policy (rather than the built-in
   * baseline) made the call (docs/extensions.md). Absent = the baseline.
   */
  allowSource?: "auto" | "policy"
}

export interface ToolExecution {
  ok: boolean
  /** Model-facing result (role:"tool" content). */
  result: string
  /** Card output preview (harder truncation). */
  preview: string
  exitCode?: number | null
  /** Image attachments produced by the call (view_image): the session lifts
   * these into the provider history after the tool result (docs/agent.md
   * "Images"). */
  images?: ImageAttachment[]
  /** The model-facing result exceeded the limits and was spilled (P0). */
  truncated?: boolean
  /** Absolute path of the spill file when `truncated`. */
  outputPath?: string
  /** A successful `memory` write's structured char deltas (docs/extensions.md
   * `memory-write`); absent for reads or failed writes. */
  memoryWrite?: MemoryWriteInfo
}
