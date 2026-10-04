import { abortableSleep, haveSetsid, killProcessTree } from "../processUtil.ts"
import type { JobReport, RunCommandResult } from "./types.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.tools")

// ---- Hidden shell (shell_background) -----------------------------------------

const clampTimeoutS = (s: number): number => Math.min(Math.max(s, 1), 1800)

/** A background job's own lifetime cap (seconds). */
const JOB_TIMEOUT_S = 1800

/** Output kept per background job (head+tail; a chatty daemon must not eat RAM). */
const JOB_OUTPUT_LIMIT = 128_000
/** Trim hysteresis: only re-trim once the buffer grows past this. */
const JOB_OUTPUT_TRIM_AT = JOB_OUTPUT_LIMIT * 2
/** Most background jobs alive at once (oldest reaped). */
const MAX_JOBS = 32

interface Job {
  id: number
  command: string
  output: string
  exitCode: number | null
  running: boolean
  timedOut: boolean
  /** How many chars of output were already reported to the model. */
  reported: number
  done: Promise<void>
  /** Process-tree killer (null once the process exited). */
  kill: (() => void) | null
  /**
   * The chat session that started this job (ToolContext.jobScope). Lets `/clear`
   * drop only the clearing tab's jobs instead of every tab's — the map itself is
   * process-global. Undefined for jobs started without a scope.
   */
  owner?: string
}

let nextJobId = 1
const jobs = new Map<number, Job>()

function trimJobOutput(j: Job): void {
  if (j.output.length <= JOB_OUTPUT_LIMIT) return
  const half = JOB_OUTPUT_LIMIT / 2
  j.output =
    j.output.slice(0, half) +
    `\n…[${j.output.length - JOB_OUTPUT_LIMIT} chars trimmed]…\n` +
    j.output.slice(j.output.length - half)
  if (j.reported > j.output.length) j.reported = 0 // offsets are void after a trim
}

/** Kill a job's process tree if it is still running (best-effort). */
function killJobTree(j: Job): void {
  if (!j.running) return
  try {
    j.kill?.()
  } catch {
    // already exited
  }
}

function reapOldJobs(): void {
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined) break
    const j = jobs.get(oldest)
    // Kill before forgetting: otherwise the process runs on (up to its 1800s
    // cap) with no id left to stop it.
    if (j !== undefined) killJobTree(j)
    jobs.delete(oldest)
  }
}

/**
 * Kill and forget background jobs. The chat calls this on `/clear` with its own
 * `owner` so a fresh session cannot inherit stale, unkillable jobs without
 * touching other tabs' jobs. Omitting `owner` clears every job (tests / global
 * teardown). Returns how many running jobs were stopped.
 */
export function clearJobs(owner?: string): number {
  let killed = 0
  for (const [id, j] of jobs) {
    if (owner !== undefined && j.owner !== owner) continue
    if (j.running) {
      killJobTree(j)
      killed++
    }
    jobs.delete(id)
  }
  if (owner === undefined) jobs.clear()
  return killed
}

/** A live background job, as reported to the UI / context block. */
export interface ActiveJobInfo {
  id: number
  command: string
  /** Owning chat session (undefined for unscoped/global jobs). */
  owner?: string
}

/**
 * Enumerate the background jobs that are STILL RUNNING, newest-first. `owner`
 * narrows to one chat session (the status-bar jobs chip + the per-generation
 * context line use the tab's `jobScope`); omitted = every live job. Read-only
 * and cheap — never throws (docs/agent.md "Background-job visibility").
 */
export function activeJobs(owner?: string): ActiveJobInfo[] {
  const out: ActiveJobInfo[] = []
  for (const j of jobs.values()) {
    if (!j.running) continue
    if (owner !== undefined && j.owner !== owner) continue
    out.push({ id: j.id, command: j.command, ...(j.owner !== undefined ? { owner: j.owner } : {}) })
  }
  return out.reverse()
}

/**
 * Run one command in a hidden `bash -lc` process (spawned in its own session
 * when setsid is available, so a kill takes the whole tree with it).
 * stdout+stderr merge in arrival order. The child is killed on timeout AND on
 * abort signal (Esc). `stdinData` is written to the child's stdin and closed
 * (the sudo retry feeds the password this way — never logged anywhere).
 */
export async function runHiddenCommand(opts: {
  command: string
  cwd?: string | null
  timeoutS?: number
  signal?: AbortSignal
  env?: Record<string, string>
  stdinData?: string
  /** Receives a kill-the-tree closure (background jobs store it for `kill`). */
  onSpawnKill?: (kill: () => void) => void
  /**
   * Live output sink. When provided, decoded chunks stream here as they arrive
   * (stdout+stderr, arrival order) and are NOT accumulated in memory; the
   * returned `output` is empty. Background jobs use this so polls see output
   * before exit and the buffer stays bounded.
   */
  onOutput?: (text: string) => void
}): Promise<RunCommandResult> {
  const timeoutMs = clampTimeoutS(opts.timeoutS ?? 120) * 1000
  let timedOut = false
  let aborted = false
  const env = { ...process.env, ...(opts.env ?? {}) }
  delete env["SENSUS_ACTIVE"] // the hidden shell is not the sensus pane
  const useSetsid = haveSetsid()
  const proc = Bun.spawn(useSetsid ? ["setsid", "bash", "-lc", opts.command] : ["bash", "-lc", opts.command], {
    cwd: opts.cwd && opts.cwd.length > 0 ? opts.cwd : undefined,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdinData !== undefined ? "pipe" : "ignore",
  })
  if (opts.stdinData !== undefined) {
    try {
      proc.stdin?.write(opts.stdinData)
      proc.stdin?.end()
    } catch {
      // child died before we could feed stdin — the exit explains it
    }
  }
  const chunks: string[] = []
  const sink = opts.onOutput
  // The pump owns each reader so the drain timeout below can cancel through it.
  // Cancelling the *stream* while a reader is mid-read throws a rejection
  // ("Cannot cancel a locked ReadableStream"); `reader.cancel()` is the legal
  // door and resolves the pending read so the pump settles.
  const readers: Array<{ cancel(reason?: unknown): Promise<void> }> = []
  const pump = async (s: unknown, err: boolean): Promise<void> => {
    if (!s) return
    const dec = new TextDecoder()
    const reader = (s as ReadableStream<Uint8Array>).getReader()
    readers.push(reader)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const text = dec.decode(value, { stream: true })
        if (sink !== undefined) sink(text)
        else chunks.push((err ? "\u0001" : "") + text)
      }
    } catch {
      // stream died (kill/cancel) — keep what arrived
    }
  }
  const pOut = pump(proc.stdout, false)
  const pErr = pump(proc.stderr, true)

  const kill = (why: "timeout" | "abort"): void => {
    if (why === "timeout") timedOut = true
    else aborted = true
    killProcessTree(proc, false)
    setTimeout(() => killProcessTree(proc, true), 2000)
  }
  opts.onSpawnKill?.(() => killProcessTree(proc, false))
  const timer = setTimeout(() => kill("timeout"), timeoutMs)
  const onAbort = (): void => kill("abort")
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  const code = await proc.exited
  clearTimeout(timer)
  opts.signal?.removeEventListener("abort", onAbort)
  // Streams normally EOF once the whole group is gone; if a straggler still
  // holds a pipe (no setsid), cancel them so the pumps settle.
  const drained = await Promise.race([
    Promise.all([pOut, pErr]).then(() => true),
    Bun.sleep(150).then(() => false),
  ])
  if (!drained) {
    // A straggler still holds a pipe (no setsid): cancel through each pump's
    // reader. Directly cancelling the stream rejects when it is locked (the
    // pump holds the lock) — an unhandled rejection that crashed the daemon —
    // so cancel the reader instead and never let a rejection escape.
    for (const reader of readers) void reader.cancel().catch((e: unknown) => {
      log.debug("background job reader cancel failed", { err: e })
    })
    // Bounded: even a reader that refuses to settle must not hang the call.
    await Promise.race([Promise.all([pOut, pErr]), Bun.sleep(150)])
  }
  // Arrival-order merge: drop the stderr marker used to tag out-of-order chunks.
  // In streaming mode the caller consumed each chunk directly; nothing to join.
  const output = sink !== undefined ? "" : chunks.map((c) => (c.startsWith("\u0001") ? c.slice(1) : c)).join("")
  return { exitCode: timedOut || aborted ? null : code, output, timedOut, aborted }
}

/**
 * shell_background `background: true`: start detached, return a job id at
 * once. The job's output accumulates (capped) until the process exits; the
 * model polls with `job: <id>`. Deliberately NOT tied to the generation's
 * abort signal — a background job outlives the reply that started it (Esc
 * kills the conversation turn, not the daemon); `kill` is the off switch.
 */
export async function startBackgroundJob(opts: {
  command: string
  cwd?: string | null
  env?: Record<string, string>
  stdinData?: string
  /** Owning chat session (ToolContext.jobScope) for per-session `/clear`. */
  owner?: string
}): Promise<number> {
  const id = nextJobId++
  const j: Job = {
    id,
    command: opts.command,
    output: "",
    exitCode: null,
    running: true,
    timedOut: false,
    reported: 0,
    done: Promise.resolve(),
    kill: null,
    owner: opts.owner,
  }
  jobs.set(id, j)
  reapOldJobs()
  const run = (async (): Promise<void> => {
    try {
      const r = await runHiddenCommand({
        ...opts,
        timeoutS: JOB_TIMEOUT_S,
        onSpawnKill: (fn) => {
          j.kill = fn
        },
        // Stream output in incrementally, capping the buffer as it grows, so
        // polls see new output during the run instead of only after exit.
        onOutput: (text) => {
          j.output += text
          if (j.output.length > JOB_OUTPUT_TRIM_AT) trimJobOutput(j)
        },
      })
      j.exitCode = r.exitCode
      j.timedOut = r.timedOut
    } catch {
      // spawn failure / unexpected error — surface as a finished job, never a
      // rejected `done` (checkBackgroundJob awaits it).
      j.exitCode = null
    } finally {
      trimJobOutput(j)
      j.running = false
    }
  })()
  j.done = run
  return id
}

/** Poll one background job: status + output since the last poll. */
export async function checkBackgroundJob(
  jobId: number,
  opts: { wait?: boolean; timeoutS?: number; signal?: AbortSignal } = {},
): Promise<JobReport> {
  const j = jobs.get(jobId)
  if (j === undefined) return { ok: false, error: `no such job #${jobId} (expired or finished long ago)` }
  if (opts.wait === true) {
    const requested = numOr(opts.timeoutS, 120)
    // A wait can never outlive the job itself (its own 1800s cap), and Esc
    // aborts it promptly instead of blocking the turn.
    const budget = Math.min(Math.max(1, requested), JOB_TIMEOUT_S) * 1000
    const signal = opts.signal ?? new AbortController().signal
    await Promise.race([j.done, abortableSleep(budget, signal)])
  }
  const fresh = j.output.slice(j.reported)
  j.reported = j.output.length
  trimJobOutput(j)
  return {
    ok: true,
    running: j.running,
    exitCode: j.exitCode,
    timedOut: j.timedOut,
    output: fresh,
  }
}

function numOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

/**
 * Kill a background job's process group and forget it (the explicit off
 * switch).
 */
export function killBackgroundJob(jobId: number): { ok: boolean; error?: string } {
  const j = jobs.get(jobId)
  if (j === undefined) return { ok: false, error: `no such job #${jobId}` }
  jobs.delete(jobId)
  killJobTree(j)
  return { ok: true }
}

/**
 * Model-facing text for a shell_background result. UNCAPPED — the tool boundary
 * (`capToolExecution`) applies the `tool_output` limits with a tail bias.
 */
export function runCommandResultText(r: RunCommandResult): string {
  const notes: string[] = []
  if (r.timedOut) notes.push("(timed out — process killed)")
  if (r.aborted) notes.push("(aborted by user — process killed)")
  const exit = r.exitCode === null ? "exit ? (killed)" : `exit ${r.exitCode}`
  const body = r.output.length === 0 ? "(no output)" : r.output
  return [notes.length > 0 ? `${exit} ${notes.join(" ")}` : exit, body].join("\n")
}
