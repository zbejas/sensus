/**
 * Shared helpers for the client transport tests (P4b): start a real daemon on a
 * hermetic runtime dir, and poll until a predicate is satisfied. Mirrors the
 * `startTestDaemon` pattern in `tests/unit/daemon/{ws,chat}.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon, type StartDaemonResult } from "../../../src/daemon/index.ts"

export interface TestDaemon {
  runtime: string
  home: string
  token: string
  result: Extract<StartDaemonResult, { ok: true }>
  cleanup: () => void
}

export async function startTestDaemon(
  opts: { token?: string; shell?: string; config?: () => Record<string, unknown> } = {},
): Promise<TestDaemon> {
  const runtime = mkdtempSync(join(tmpdir(), "sensus-client-run-"))
  const home = mkdtempSync(join(tmpdir(), "sensus-client-home-"))
  const token = opts.token ?? "daemon-client-test-token"
  const result = await startDaemon({
    runtimeDir: runtime,
    token,
    home,
    shell: opts.shell ?? "/bin/sh",
    config: opts.config ?? (() => ({})),
    graceMs: 60_000,
  })
  if (!result.ok) {
    rmSync(runtime, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    throw new Error(result.error)
  }
  return {
    runtime,
    home,
    token,
    result,
    cleanup: () => {
      try {
        result.stop()
      } catch {
        // idempotent
      }
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Poll until `read()` is truthy (every 25ms), or throw after `timeoutMs`. */
export async function waitUntil<T>(read: () => T | null | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("waitUntil timed out")
    await Bun.sleep(25)
  }
}
