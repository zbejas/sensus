/**
 * Per-server MCP scratch pruning unit tests (docs/mcp.md "Configuration";
 * `src/agent/mcp/cache.ts`): stale files are removed (fresh kept, dirs kept,
 * symlinks skipped), recursion preserves directories, a missing root is a
 * no-op, and the maybeCleanupMcpCache throttle fires at most once per hour.
 * Real files in a temp dir; no PTY, no network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupMcpCache,
  MCP_CACHE_CLEANUP_THROTTLE_MS,
  MCP_SCRATCH_RETENTION_MS,
  mcpCacheCleanupState,
  mcpCacheRoot,
  maybeCleanupMcpCache,
  type CacheCleanupState,
} from "../../../../src/agent/mcp/cache.ts"

const DAY = 24 * 60 * 60 * 1000

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sensus-mcp-cache-"))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

/** Create a file whose mtime is `ageMs` in the past. */
function stale(path: string, ageMs = 8 * DAY): void {
  writeFileSync(path, "scratch")
  const past = new Date(Date.now() - ageMs)
  utimesSync(path, past, past)
}

function fresh(path: string): void {
  writeFileSync(path, "scratch")
}

describe("mcpCacheRoot", () => {
  test("joins the per-server MCP scratch root under the cache dir", () => {
    expect(mcpCacheRoot("/tmp/cache")).toBe(join("/tmp/cache", "mcp"))
    expect(mcpCacheRoot("/tmp/cache").endsWith("mcp")).toBe(true)
  })
})

describe("cleanupMcpCache", () => {
  test("deletes stale files, keeps fresh files and directories", () => {
    const root = join(dir, "basics")
    mkdirSync(join(root, "playwright"), { recursive: true })
    const old = join(root, "old.yml")
    const recent = join(root, "recent.yml")
    stale(old)
    fresh(recent)

    cleanupMcpCache(root)

    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    // Directories always survive (the stable spawn dirs).
    expect(existsSync(join(root, "playwright"))).toBe(true)
  })

  test("recurses into per-server dirs, deleting stale files but keeping the dirs", () => {
    const root = join(dir, "nested")
    const inner = join(root, "playwright", ".playwright-mcp")
    mkdirSync(inner, { recursive: true })
    const page = join(inner, "page-1.yml")
    stale(page)

    cleanupMcpCache(root)

    expect(existsSync(page)).toBe(false)
    expect(existsSync(inner)).toBe(true)
    expect(existsSync(join(root, "playwright"))).toBe(true)
  })

  test("a missing root is a no-op and never throws", () => {
    expect(() => cleanupMcpCache(join(dir, "does-not-exist"))).not.toThrow()
  })

  test("retention defaults match the truncate.ts precedent", () => {
    expect(MCP_SCRATCH_RETENTION_MS).toBe(7 * DAY)
    expect(MCP_CACHE_CLEANUP_THROTTLE_MS).toBe(60 * 60 * 1000)
  })
})

describe("maybeCleanupMcpCache", () => {
  test("prunes once, then throttles until the window elapses (injected state)", () => {
    const root = join(dir, "throttle")
    mkdirSync(root, { recursive: true })
    const state: CacheCleanupState = { lastCleanup: 0 }
    const base = Date.now()

    // First call: stale file is pruned.
    const first = join(root, "page-1.yml")
    stale(first)
    maybeCleanupMcpCache(root, { state, now: base })
    expect(existsSync(first)).toBe(false)
    expect(state.lastCleanup).toBe(base)

    // Within the throttle window: the second call is skipped.
    const second = join(root, "page-2.yml")
    stale(second)
    maybeCleanupMcpCache(root, { state, now: base + 1_000 })
    expect(existsSync(second)).toBe(true)
    expect(state.lastCleanup).toBe(base)

    // Past the throttle window: it prunes again.
    maybeCleanupMcpCache(root, { state, now: base + MCP_CACHE_CLEANUP_THROTTLE_MS + 1 })
    expect(existsSync(second)).toBe(false)
    expect(state.lastCleanup).toBe(base + MCP_CACHE_CLEANUP_THROTTLE_MS + 1)
  })

  test("a missing root under the throttle never throws", () => {
    const state: CacheCleanupState = { lastCleanup: 0 }
    expect(() => maybeCleanupMcpCache(join(dir, "no-root"), { state })).not.toThrow()
    // The shared module-level state exists for the production startup hook.
    expect(typeof mcpCacheCleanupState.lastCleanup).toBe("number")
  })
})
