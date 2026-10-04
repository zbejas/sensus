/**
 * The core tools (docs/agent-tools.md) + their OpenAI
 * tool specs, the hidden-shell runner, background jobs, the shell_session
 * key encoder, path resolution, output truncation, sudo detection/retry and
 * approval classification.
 *
 * Hidden shell (docs/agent-tools.md): v1 spawns a per-call `bash -lc`
 * process instead of a persistent hidden shell — no cwd/PTY bookkeeping, and
 * the per-call cwd defaults to the ACTIVE PANE's cwd (`#{pane_current_path}`)
 * so "the agent works where you are" holds. Output is stdout+stderr merged in
 * arrival order. Every tool result is capped at the tool boundary
 * (`capToolExecution`, docs/config.md "tool_output") with the full text spilled
 * to disk. `background: true` starts the process detached and returns a job id;
 * the `job` param polls/kills it.
 *
 * Pure pieces (truncation, paths, diff, approval, git parsing, key encoding,
 * sudo detection) are exported for unit tests; executors take a structural
 * `AgentPane` so tests can stub the pane without a real PTY.
 *
 * Implementation is split into cohesive modules under `./tools/`; this file is
 * the public entry point (see `./tools/index.ts` for the module map).
 */

export * from "./tools/index.ts"
