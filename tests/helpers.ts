/**
 * Shared smoke-test harness. Every in-tmux test file re-implemented the same
 * ~80 lines (sh → outer → capture → send-keys → waitFor → boot → teardown);
 * this module is the single home. AGENTS.md smoke rules are baked in:
 *
 * - waitFor dumps the pane capture on timeout (failures are diagnosable from
 *   the log alone) and tracks the last predicate error,
 * - waitChatIdle waits for the transition INTO `chat:streaming` first (miss
 *   tolerated) and then a DISAPPEARANCE wait that can only pass once truly
 *   true — never bare-wait for a state that changes a frame late.
 *
 * The app itself no longer spawns a tmux server (the left pane is a native PTY
 * rendered by OpenTUI's embedded VT); the OUTER tmux here is only the test
 * driver that boots the app and captures its pane. Each harness owns its own
 * outer socket.
 *
 * Factory style (createHarness) on purpose: bun runs all test files in one
 * process, so helpers must not share module-level mutable state.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const REPO_ROOT = new URL("..", import.meta.url).pathname

/** Test scratch root (AGENTS.md smoke-test rules). Created here so a fresh
 * checkout can run the suite without an external `mkdir`; tests use fixed
 * paths under it (the reaper in scripts/test-cleanup.sh relies on the prefix). */
export const TEST_TMP = "/tmp/sensus"
mkdirSync(TEST_TMP, { recursive: true })

export interface ShResult {
  code: number
  stdout: string
  stderr: string
}

export interface ShOptions {
  /** Write this to the child's stdin then close (paste tests). */
  input?: string
  cwd?: string
  /** Merged over process.env. */
  env?: Record<string, string>
  /** Hard-kill the child after this many ms (binary boot guards). */
  timeoutMs?: number
}

/** The one process runner: spawn, pipe stdout/stderr, collect exit code. */
export async function sh(cmd: string[], opts: ShOptions = {}): Promise<ShResult> {
  const wantsInput = opts.input !== undefined
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: wantsInput ? "pipe" : "ignore",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  })
  const writeInput = wantsInput
    ? async (): Promise<void> => {
        const stdin = proc.stdin as Exclude<typeof proc.stdin, undefined>
        await new Response(opts.input)
          .arrayBuffer()
          .then((b) => stdin.write(new Uint8Array(b)))
        stdin.end()
      }
    : (): Promise<void> => Promise.resolve()
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          try {
            proc.kill()
          } catch {
            // already dead
          }
        }, opts.timeoutMs)
      : null
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      writeInput().then(() => proc.exited),
    ])
    return { code: code ?? -1, stdout, stderr }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// ---- pure assertion helpers ---------------------------------------------------

/**
 * Count painted-background SGR sequences in an -e capture, scoped to CHROME.
 *
 * The zero-background invariant is chrome-only (docs/DESIGN.md): the embedded
 * VT paints its fixed default background (`#000000`) on every pane-content row,
 * which is legitimately exempt. Everything else (`48;2;`, `48;5;`, `40`–`47`)
 * is chrome and must be zero in the `terminal` theme with overlays closed.
 * The chat input caret legitimately paints the accent bg while its blink phase
 * is ON, so callers that assert `=== 0` are catching an OFF frame.
 */
export function bgCount(escaped: string): number {
  // eslint-disable-next-line no-control-regex -- the ESC byte is the match target
  const matches = escaped.match(/48;2;\d+;\d+;\d+m|48;5;\d+m|\x1b\[4[0-7]m/g) ?? []
  return matches.filter((s) => s !== "48;2;0;0;0m").length
}

/** SGR mouse sequence builders — 0-based pane coords (the wire is 1-based). */
export const sgrPress = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`
export const sgrRelease = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`
export const sgrWheelSeq = (up: boolean, x: number, y: number): string => `\x1b[<${up ? 64 : 65};${x + 1};${y + 1}M`

/** Bytes → space-separated hex args for `tmux send-keys -H`. */
export function hexArgs(bytes: string): string[] {
  return Array.from(Buffer.from(bytes, "binary"))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .split(" ")
}

/** Fresh throwaway dir for SENSUS_HOME sandboxes (caller cleans up). */
export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `sensus-${label}-`))
}

/**
 * The per-sandbox daemon runtime dir (P4d). Each smoke sandbox gets its OWN
 * `SENSUS_RUNTIME_DIR` under its home so daemons never collide across parallel
 * test files, and so teardown can stop exactly this sandbox's daemon. The app
 * auto-spawns `sensus daemon serve` into it (D3); the daemon owns the shells.
 */
export function sandboxRuntimeDir(sensusHome: string): string {
  return join(sensusHome, "daemon-runtime")
}

/** `SENSUS_RUNTIME_DIR=…` env fragment for a hand-built boot command. */
export function sandboxRuntimeEnv(sensusHome: string): string {
  return `SENSUS_RUNTIME_DIR=${sandboxRuntimeDir(sensusHome)}`
}

// ---- polling --------------------------------------------------------------------

export interface WaitForOptions {
  timeoutMs?: number
  stepMs?: number
  /** Pane dump printed when the wait times out (defaults to the harness's). */
  dump?: () => Promise<string>
}

/**
 * Poll `predicate` until true or timeout; on timeout print a tagged screen
 * dump + the last predicate error, then throw. The core loop behind every
 * test file's local waitFor adapter.
 */
export async function waitForImpl(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  dump: () => Promise<string>,
  opts: WaitForOptions = {},
  tag = "smoke",
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const stepMs = opts.stepMs ?? 120
  const deadline = Date.now() + timeoutMs
  let lastErr: string | null = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await Bun.sleep(stepMs)
  }
  const shot = await dump().catch(() => "<capture failed>")
  console.log(`[${tag}] TIMEOUT at ${label}\nlast screen:\n${shot}`)
  throw new Error(`waitFor(${label}): condition not met within ${timeoutMs}ms${lastErr ? ` (last: ${lastErr})` : ""}`)
}

/**
 * Build the two-phase chat-idle waiter (AGENTS.md rule — see module docs).
 * `waitFor` is the caller's polling loop; probes/probeWindowMs shape the
 * tolerated "transition INTO streaming" window.
 */
export function makeWaitChatIdle(deps: {
  cap: () => Promise<string>
  waitFor: (predicate: () => boolean | Promise<boolean>, label: string, timeoutMs?: number) => Promise<void>
  probes?: number
  probeWindowMs?: number
  /** Default wait budget when the caller passes none (20000). */
  defaultTimeoutMs?: number
}): (timeoutMs?: number) => Promise<void> {
  const probes = deps.probes ?? 8
  const windowMs = deps.probeWindowMs ?? 1600
  return async (timeoutMs = deps.defaultTimeoutMs ?? 20000): Promise<void> => {
    const t0 = Date.now()
    for (let i = 0; i < probes && Date.now() - t0 < windowMs; i++) {
      if ((await deps.cap()).includes("chat:streaming")) break
      await Bun.sleep(50)
    }
    await deps.waitFor(async () => !(await deps.cap()).includes("chat:streaming"), "chat idle (held)", timeoutMs)
  }
}

// ---- the per-file harness ----------------------------------------------------------

export interface Harness {
  /** This file's private OUTER tmux socket (never the user's default). */
  sock: string
  sh: typeof sh
  outer: (args: string[]) => Promise<ShResult>
  outerWithInput: (args: string[], input: string) => Promise<ShResult>
  /** capture-pane -p (plain text). */
  capT: (target: string) => Promise<string>
  /** capture-pane -e -p (SGR kept). */
  capET: (target: string) => Promise<string>
  keyTo: (target: string, key: string) => Promise<void>
  typeTo: (target: string, text: string) => Promise<void>
  /** Raw bytes via send-keys -H (SGR mouse events, mostly). */
  sendHexTo: (bytes: string, target?: string) => Promise<void>
  /** SGR press+release at 0-based coords. */
  sgrClick: (target: string, x: number, y: number) => Promise<void>
  /** 0-based column of `sub` within a specific 0-based row; -1 when absent. */
  colOf: (target: string, row: number, sub: string) => Promise<number>
  /** First 0-based ROW containing `sub`; -1 when absent. */
  rowOf: (target: string, sub: string) => Promise<number>
  /**
   * Canonical waitFor: dump defaults to `dumpTarget`'s capture; the timeout
   * log is tagged with `tag`. Files with legacy positional signatures keep a
   * one-line adapter over this.
   */
  waitFor: (predicate: () => boolean | Promise<boolean>, label: string, opts?: WaitForOptions) => Promise<void>
  killServer: () => Promise<void>
}

export interface CreateHarnessOptions {
  sock: string
  /** Log tag in timeout dumps, e.g. "m7-smoke". */
  tag: string
  /** Capture target for the default timeout dump, e.g. "m7:0". */
  dumpTarget?: string
  /** Fallback dump when the primary target capture fails (m6 dual-boot). */
  dumpTargetFallback?: string
  /** Legacy ui-smoke behavior: derive the label from the predicate source. */
  labelFromPredicate?: boolean
}

export function createHarness(opts: CreateHarnessOptions): Harness {
  const outer = (args: string[]): Promise<ShResult> => sh(["tmux", "-S", opts.sock, ...args])
  const outerWithInput = (args: string[], input: string): Promise<ShResult> =>
    sh(["tmux", "-S", opts.sock, ...args], { input })
  const capT = async (target: string): Promise<string> => (await outer(["capture-pane", "-p", "-t", target])).stdout
  const capET = async (target: string): Promise<string> => (await outer(["capture-pane", "-e", "-p", "-t", target])).stdout
  const keyTo = async (target: string, key: string): Promise<void> => {
    await outer(["send-keys", "-t", target, key])
  }
  const typeTo = async (target: string, text: string): Promise<void> => {
    await outer(["send-keys", "-t", target, "-l", "--", text])
  }
  const sendHexTo = async (bytes: string, target = "smoke:0"): Promise<void> => {
    const r = await outer(["send-keys", "-H", "-t", target, ...hexArgs(bytes)])
    if (r.code !== 0) throw new Error(`send-keys -H failed: ${r.stderr}`)
  }
  const dump = async (): Promise<string> => {
    const target = opts.dumpTarget
    if (target === undefined) return "<no dump target>"
    const primary = capT(target)
    const fallback = opts.dumpTargetFallback
    if (fallback === undefined) return primary.catch(() => "<capture failed>")
    return primary.catch(() => capT(fallback).catch(() => "<capture failed>"))
  }
  return {
    sock: opts.sock,
    sh,
    outer,
    outerWithInput,
    capT,
    capET,
    keyTo,
    typeTo,
    sendHexTo,
    sgrClick: async (target: string, x: number, y: number): Promise<void> => {
      await sendHexTo(sgrPress(x, y) + sgrRelease(x, y), target)
    },
    colOf: async (target: string, row: number, sub: string): Promise<number> => {
      const line = (await capT(target)).split("\n")[row] ?? ""
      return line.indexOf(sub)
    },
    rowOf: async (target: string, sub: string): Promise<number> => {
      const lines = (await capT(target)).split("\n")
      for (let i = 0; i < lines.length; i++) {
        if ((lines[i] ?? "").includes(sub)) return i
      }
      return -1
    },
    waitFor: (predicate, label, waitOpts = {}) => {
      const what =
        opts.labelFromPredicate === true && label === "?"
          ? predicate.toString().replace(/\s+/g, " ").slice(0, 140)
          : label
      return waitForImpl(predicate, what, waitOpts.dump ?? dump, waitOpts, opts.tag)
    },
    killServer: async (): Promise<void> => {
      await outer(["kill-server"]).catch(() => {})
    },
  }
}

// ---- boot / teardown scaffolding ---------------------------------------------------

/**
 * The canonical app boot command: hidden env wrapper around
 * `bun run src/index.tsx`, stderr appended to a per-boot log (opentui hijacks
 * console.* — in-app diagnostics must go to a file). The app no longer takes a
 * private tmux socket; the outer tmux session is the only isolation the test
 * needs.
 */
export function appBootCommand(o: {
  sensusHome: string
  bootLog: string
  /** Adds SENSUS_BASE_URL=<mockUrl> (real provider against a mock server). */
  mockUrl?: string
  /** Raw extra env bits appended verbatim (e.g. "SENSUS_MOCK=1 SENSUS_MODEL=x"). */
  env?: string
  /** Extra CLI args after the entry point (e.g. "--resume"). */
  args?: string
}): string {
  const bits = ["SHELL=/bin/bash", "SENSUS_SKIP=1", "SENSUS_NO_SETUP=1", "SENSUS_MODELS_DEV_WARM=0", `SENSUS_HOME=${o.sensusHome}`, sandboxRuntimeEnv(o.sensusHome)]
  if (o.mockUrl !== undefined) bits.push(`SENSUS_BASE_URL=${o.mockUrl}`)
  if (o.env !== undefined && o.env.length > 0) bits.push(o.env)
  return `env ${bits.join(" ")} bun run src/index.tsx${o.args ? ` ${o.args}` : ""} 2>>${o.bootLog}`
}

/**
 * Write a minimal config.json into a smoke sandbox. API keys live in config
 * now (no env fallback), so real-provider smoke boots must seed the selected
 * endpoint's `apiKey` before launch.
 */
export function writeSmokeConfig(sensusHome: string, doc: Record<string, unknown>): void {
  mkdirSync(sensusHome, { recursive: true })
  writeFileSync(join(sensusHome, "config.json"), JSON.stringify(doc, null, 2))
}

/** new-session argv for a 200x50 smoke boot (the standard dogfood size). */
export function bootSessionArgv(session: string, command: string, opts: { cols?: number; rows?: number; cwd?: string } = {}): string[] {
  return [
    "new-session",
    "-d",
    "-x",
    String(opts.cols ?? 200),
    "-y",
    String(opts.rows ?? 50),
    "-s",
    session,
    "-c",
    opts.cwd ?? REPO_ROOT,
    command,
  ]
}

/** The clean-exit core: type "exit" + Enter, wait for the session to end. */
export async function cleanExit(
  h: Harness,
  opts: { session: string; timeoutMs?: number },
): Promise<void> {
  await h.typeTo(opts.session, "exit")
  await h.keyTo(opts.session, "Enter")
  await h.waitFor(async () => (await h.outer(["has-session", "-t", opts.session])).code !== 0, "clean exit", {
    timeoutMs: opts.timeoutMs ?? 10000,
  })
}

/**
 * Stop the sandbox's daemon (P4d). Smoke tests boot the app, which auto-spawns
 * `sensus daemon serve` into the sandbox runtime dir; on quit the app DETACHES
 * (leaves the daemon + shells alive, D4), so teardown must stop it explicitly.
 * SIGTERM lets the daemon run its shutdown (kill every shell/chat); a wedge is
 * SIGKILLed. Never throws.
 */
export async function stopSandboxDaemon(sensusHome: string): Promise<void> {
  const runtimeDir = sandboxRuntimeDir(sensusHome)
  const pidPath = join(runtimeDir, "daemon.pid")
  let pid: number | null = null
  try {
    const n = Number(readFileSync(pidPath, "utf8").trim())
    pid = Number.isInteger(n) && n > 0 ? n : null
  } catch {
    pid = null
  }
  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone
    }
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && isAlive(pid)) await Bun.sleep(100)
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
      await Bun.sleep(200)
    }
  }
  try {
    rmSync(join(runtimeDir, "daemon.sock"), { force: true })
  } catch {
    // best-effort
  }
  try {
    rmSync(pidPath, { force: true })
  } catch {
    // best-effort
  }
}

/** True when a pid names a live process (EPERM still counts as alive). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Assert no process is still bound to this smoke sandbox — the app process
 * must not linger after exit, and neither may an orphaned PTY shell.
 *
 * The per-boot unique value is `SENSUS_HOME`, which the app, its DETACHED
 * daemon (a new process it intentionally leaves running, D4) and the daemon's
 * PTY children all inherit. Teardown therefore STOPS the sandbox daemon first
 * (which kills its shells), then scans `/proc/<pid>/environ` for the exact
 * `SENSUS_HOME=<sensusHome>` marker. Any remaining match is a real leak.
 */
export async function expectNoStrayProcesses(sensusHome: string): Promise<void> {
  await stopSandboxDaemon(sensusHome)
  const marker = `SENSUS_HOME=${sensusHome}`
  const script = [
    'found=""',
    "for d in /proc/[0-9]*; do",
    "  pid=${d#/proc/}",
    '  if tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -Fxq "$SENSUS_SMOKE_MARKER"; then',
    '    found="$found $pid"',
    "  fi",
    "done",
    'if [ -n "$found" ]; then echo "$found"; fi',
  ].join("\n")
  const r = await sh(["bash", "-c", script], { env: { SENSUS_SMOKE_MARKER: marker } })
  if (r.stdout.trim() !== "") throw new Error(`stray processes holding ${marker}:${r.stdout}`)
}
