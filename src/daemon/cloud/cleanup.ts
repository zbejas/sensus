/**
 * Local registry of cloud-created chats (`runs.json`) + startup cleanup
 * (docs/auth.md "Runs"; protocol "run").
 *
 * A run stream gets a dedicated daemon shell plus a chat bound to it, so the
 * pair would otherwise outlive the cloud connection. The connector records
 * both ids before starting the prompt and releases them on cleanup by killing
 * the shell (the daemon then closes the bound chat). On startup, every leftover
 * is released; an unknown shell/chat means an earlier cleanup already won.
 */

import { existsSync, readFileSync } from "node:fs"
import { errorMessage, isRecord } from "../../core/util.ts"
import { runsPath, writeCloudJson } from "./paths.ts"
import { LocalDaemonClient, type LocalDaemonLike } from "./daemonClient.ts"
import type { DiscoveryResult } from "./discovery.ts"

/** One cloud run chat the relay still owns. */
export interface RunRecord {
  streamId: string
  chatId: string
  shellId: string
  startedAt: number
}

interface RunsFile {
  version: 1
  runs: RunRecord[]
}

export type RunsReadResult = { ok: true; runs: RunRecord[]; existed: boolean } | { ok: false; error: string }

function normalizeRuns(value: unknown): RunRecord[] | null {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["runs"])) return null
  const runs: RunRecord[] = []
  for (const raw of value["runs"]) {
    if (!isRecord(raw)) return null
    const streamId = raw["streamId"]
    const chatId = raw["chatId"]
    const startedAt = raw["startedAt"]
    if (typeof streamId !== "string" || streamId.length === 0) return null
    if (typeof chatId !== "string" || chatId.length === 0) return null
    const shellId = raw["shellId"]
    if (typeof shellId !== "string" || shellId.length === 0) return null
    if (typeof startedAt !== "number") return null
    runs.push({ streamId, chatId, shellId, startedAt })
  }
  return runs
}

/** Read the run registry; a missing file is empty. */
export function readRuns(home: string): RunsReadResult {
  const path = runsPath(home)
  if (!existsSync(path)) return { ok: true, runs: [], existed: false }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    return { ok: false, error: `cannot read ${path}: ${errorMessage(e)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `invalid runs.json at ${path}: ${errorMessage(e)}` }
  }
  const runs = normalizeRuns(parsed)
  if (runs === null) return { ok: false, error: `invalid runs.json at ${path}` }
  return { ok: true, runs, existed: true }
}

/** Write the run registry (0600). Root is allowed when the daemon itself runs
 * as root (the pairing approval is the user's explicit opt-in). */
export function writeRuns(home: string, runs: readonly RunRecord[]): { ok: boolean; error?: string } {
  const file: RunsFile = { version: 1, runs: [...runs] }
  const res = writeCloudJson(runsPath(home), file)
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "cannot write runs.json" }
}

/** Add/replace one run record. Never throws. */
export function recordRun(home: string, record: RunRecord): { ok: boolean; error?: string } {
  const read = readRuns(home)
  if (!read.ok) return { ok: false, error: read.error }
  const next = read.runs.filter((run) => run.streamId !== record.streamId && run.chatId !== record.chatId)
  next.push(record)
  return writeRuns(home, next)
}

/** Remove one run record by stream id. Never throws. */
export function forgetRun(home: string, streamId: string): { ok: boolean; error?: string } {
  const read = readRuns(home)
  if (!read.ok) return { ok: false, error: read.error }
  return writeRuns(
    home,
    read.runs.filter((run) => run.streamId !== streamId),
  )
}

export interface CleanupOptions {
  home: string
  discover: () => Promise<DiscoveryResult>
  /** Test seam; defaults to a real `LocalDaemonClient`. */
  clientFactory?: () => LocalDaemonLike
  /** Called once per leftover that cannot be closed (a log seam). */
  onError?: (message: string) => void
}

export interface CleanupResult {
  /** Leftovers found in runs.json. */
  found: number
  /** Chats successfully closed (or already gone). */
  closed: number
  /** Records still left because the daemon was unreachable / close failed. */
  remaining: number
  /** True when the local daemon could not be reached; nothing was dropped. */
  daemonUnreachable: boolean
}

/**
 * Release every run left in `runs.json` by killing its dedicated shell. The
 * daemon closes a chat when its bound shell exits, so this removes both. An
 * unknown shell is already clean. If the daemon is unreachable the registry is
 * left intact for the next start.
 */
export async function cleanupLeftoverRuns(opts: CleanupOptions): Promise<CleanupResult> {
  const read = readRuns(opts.home)
  if (!read.ok) {
    opts.onError?.(read.error)
    return { found: 0, closed: 0, remaining: 0, daemonUnreachable: false }
  }
  if (read.runs.length === 0) return { found: 0, closed: 0, remaining: 0, daemonUnreachable: false }

  const client = opts.clientFactory?.() ?? new LocalDaemonClient({ discover: opts.discover })
  try {
    await client.connect()
  } catch (e) {
    client.close()
    opts.onError?.(`local daemon unavailable; keeping ${read.runs.length} run record(s): ${errorMessage(e)}`)
    return { found: read.runs.length, closed: 0, remaining: read.runs.length, daemonUnreachable: true }
  }

  const remaining: RunRecord[] = []
  let closed = 0
  for (const run of read.runs) {
    try {
      await client.request("chat.abort", { chatId: run.chatId }, 2_000).catch(() => {})
      await client.request("terminal.kill", { shellId: run.shellId }, 10_000)
      closed += 1
    } catch (e) {
      const code = (e as { code?: unknown }).code
      if (code === "shell_not_found" || code === "chat_not_found") {
        closed += 1
        continue
      }
      remaining.push(run)
      opts.onError?.(`could not release leftover run ${run.chatId}: ${errorMessage(e)}`)
    }
  }
  client.close()
  const wrote = writeRuns(opts.home, remaining)
  if (!wrote.ok) opts.onError?.(wrote.error ?? "cannot update runs.json")
  return { found: read.runs.length, closed, remaining: remaining.length, daemonUnreachable: false }
}
