/**
 * Per-server MCP scratch cache pruning (docs/mcp.md "Configuration").
 *
 * Task #7 gave every stdio MCP server a stable cwd under
 * `<cache>/mcp/<server>/` (see `registry.ts` `resolveMcpServerCwd`). Servers
 * like `@playwright/mcp` write one scratch file per interaction into that dir
 * (`.playwright-mcp/page-<ts>.yml`), so it grows without bound.
 *
 * This mirrors the `truncate.ts` precedent (`cleanupToolOutput` + a module-level
 * `lastCleanup` hourly throttle + a 7-day retention): recursively delete stale
 * FILES under the MCP cache root, keep the directories themselves (the stable
 * spawn dirs must survive), and run at most once per hour from a best-effort
 * startup hook. Never throws (AGENTS.md rule 10).
 */

import { readdirSync, rmSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"

/** Scratch files older than this are deleted (parity with truncate.ts). */
export const MCP_SCRATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** The pruner runs at most once per hour (parity with truncate.ts). */
export const MCP_CACHE_CLEANUP_THROTTLE_MS = 60 * 60 * 1000

/** `<cacheDir>/mcp` — the per-server MCP scratch root (docs/mcp.md). */
export function mcpCacheRoot(cacheDir: string): string {
  return join(cacheDir, "mcp")
}

/**
 * Recursively delete FILES under `root` older than `maxAgeMs`. Dirs are kept
 * (the stable per-server spawn dirs must survive); symlinks are skipped.
 * Best-effort: a missing/unreadable dir or file never throws (AGENTS.md rule 10).
 */
export function cleanupMcpCache(root: string, maxAgeMs = MCP_SCRATCH_RETENTION_MS, now = Date.now()): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    // Missing / unreadable dir — nothing to clean.
    return
  }
  const cutoff = now - maxAgeMs
  for (const entry of entries) {
    const path = join(root, entry.name)
    try {
      if (entry.isDirectory()) {
        cleanupMcpCache(path, maxAgeMs, now)
      } else if (entry.isFile()) {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
      }
      // Symlinks and other special files are skipped.
    } catch {
      // The entry vanished / is unreadable — leave it and continue.
    }
  }
}

export interface CacheCleanupState {
  lastCleanup: number
}

/** Module-level throttle state shared by every maybeCleanupMcpCache() call. */
export const mcpCacheCleanupState: CacheCleanupState = { lastCleanup: 0 }

/**
 * Throttled wrapper: runs cleanupMcpCache at most once per `throttleMs`
 * (default hourly), using `state` (default the module-level shared state).
 * Never throws.
 */
export function maybeCleanupMcpCache(
  root: string,
  opts?: { now?: number; maxAgeMs?: number; throttleMs?: number; state?: CacheCleanupState },
): void {
  try {
    const now = opts?.now ?? Date.now()
    const throttleMs = opts?.throttleMs ?? MCP_CACHE_CLEANUP_THROTTLE_MS
    const state = opts?.state ?? mcpCacheCleanupState
    if (now - state.lastCleanup > throttleMs) {
      state.lastCleanup = now
      cleanupMcpCache(root, opts?.maxAgeMs, now)
    }
  } catch {
    // Best-effort: the pruner must never disturb startup.
  }
}
