/**
 * Process-management helpers shared by the hidden agent shell (tools.ts) and
 * the MCP stdio transport (mcp/stdio.ts). Neutral module: importing it does
 * NOT couple a consumer to the tool layer or the provider layer.
 */

import { componentLogger } from "./log.ts"

const log = componentLogger("agent.process")

/** setsid(1) lets us kill the whole command group (bash + its children). */
let setsidAvailable: boolean | null = null
export function haveSetsid(): boolean {
  if (setsidAvailable === null) {
    try {
      const r = Bun.spawnSync(["setsid", "true"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      setsidAvailable = r.exitCode === 0
    } catch (e) {
      setsidAvailable = false
      log.debug("setsid probe failed; group kill unavailable", { err: e })
    }
  }
  return setsidAvailable
}

/**
 * Best-effort kill of the child AND its process group (grandchildren too).
 * `escalation` upgrades both signals to SIGKILL. With the setsid wrapper the
 * child pid IS the group id; a negative pid signals the whole group so
 * orphaned grandchildren die with the shell.
 */
export function killProcessTree(proc: ReturnType<typeof Bun.spawn>, escalation: boolean): void {
  try {
    if (escalation) proc.kill("SIGKILL")
    else proc.kill()
  } catch (e) {
    // already exited
    log.debug("killProcessTree direct kill failed (already exited?)", { err: e })
  }
  try {
    process.kill(-proc.pid, escalation ? "SIGKILL" : "SIGTERM")
  } catch (e) {
    // not a group leader (setsid missing) — direct kill was best effort
    log.debug("killProcessTree group kill failed (no setsid?)", { err: e })
  }
}

/**
 * Resolve after `ms`, or early when the signal aborts. Never rejects and
 * never throws on abort — callers re-check `signal.aborted` after awaiting.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve()
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
