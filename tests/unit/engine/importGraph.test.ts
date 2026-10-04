/**
 * Engine dependency-direction guard (docs/architecture.md "engine/",
 * AGENTS.md "Non-negotiable rules"): the engine is headless, so NOTHING under
 * the engine-side layers may import the renderer/view layer (`src/ui/**`).
 * The dependency is one-way `ui → engine`.
 *
 * This is a structural test, not a behavior test: it statically scans the
 * import specifiers of every engine-side source file and fails on any specifier
 * that resolves into `src/ui/`. Type-only imports are forbidden too — the UI
 * types the engine needs (e.g. `ToastLevel`, `ContextBreakdown`) were moved
 * down into the engine, so a type import from `src/ui/**` would mean a leak
 * slipped back in.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const SRC = resolve(REPO_ROOT, "src")

/** Engine-side layers that must stay independent of the renderer. */
const ENGINE_SIDE_DIRS = ["agent", "config", "session", "terminal", "engine", "daemon"] as const

/** `src/ui/` is the view layer; the daemon will host the engine headless. */
const FORBIDDEN_PREFIX = "ui/"

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(path)
  }
  return out
}

/**
 * Every import specifier in a source file: static `from "…"`, bare side-effect
 * `import "…"`, and dynamic `import("…")`.
 */
function importSpecifiers(source: string): string[] {
  const out: string[] = []
  const staticRe = /\bfrom\s+["']([^"']+)["']/g
  const bareRe = /\bimport\s+["']([^"']+)["']/g
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = staticRe.exec(source)) !== null) out.push(m[1] ?? "")
  while ((m = bareRe.exec(source)) !== null) out.push(m[1] ?? "")
  while ((m = dynamicRe.exec(source)) !== null) out.push(m[1] ?? "")
  return out
}

/**
 * Resolve a relative specifier to a path under `src/` (or null for bare
 * package specifiers). NodeNext-style `.ts`/`.tsx` stripping is unnecessary
 * here because every relative import in this repo carries its extension.
 */
function resolveUnderSrc(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null
  const abs = resolve(dirname(file), specifier)
  const rel = relative(SRC, abs).split("\\").join("/")
  return rel.startsWith("..") ? null : rel
}

describe("engine import graph", () => {
  test("no engine-side file imports from src/ui/** (one-way ui → engine)", () => {
    const violations: string[] = []
    for (const layer of ENGINE_SIDE_DIRS) {
      const layerDir = resolve(SRC, layer)
      for (const file of walk(layerDir)) {
        const source = readFileSync(file, "utf8")
        for (const specifier of importSpecifiers(source)) {
          const resolved = resolveUnderSrc(file, specifier)
          if (resolved === null) continue
          if (resolved === FORBIDDEN_PREFIX.slice(0, -1) || resolved.startsWith(FORBIDDEN_PREFIX)) {
            violations.push(`${relative(REPO_ROOT, file)} → ${specifier}`)
          }
        }
      }
    }
    // Report the exact offenders so a regression is fixable without a grep.
    expect(violations).toEqual([])
  })

  test("no engine-side file imports @opentui/core except the client renderable", () => {
    // The daemon hosts the engine headlessly, so the renderer package must not
    // be reachable from it. `src/terminal/session.ts` is the ONE client-side
    // file (the embedded VT renderable); everything else is renderer-free.
    const CLIENT_RENDERABLE = "src/terminal/session.ts"
    const violations: string[] = []
    for (const layer of ENGINE_SIDE_DIRS) {
      for (const file of walk(resolve(SRC, layer))) {
        const rel = relative(REPO_ROOT, file).split("\\").join("/")
        if (rel === CLIENT_RENDERABLE) continue
        for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
          if (specifier === "@opentui/core") violations.push(`${rel} → ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("the engine barrel imports cleanly with no renderer (IF1 surface)", async () => {
    const mod = await import("../../../src/engine/index.ts")
    // The barrel is the frozen inter-phase contract; a few load-bearing names
    // must be present for the daemon to host a turn.
    expect(typeof mod.ChatSession).toBe("function")
    expect(typeof mod.ChatHost).toBe("function")
    expect(typeof mod.PtySession).toBe("function")
    expect(typeof mod.createEventSink).toBe("function")
    expect(typeof mod.StreamScanner).toBe("function")
    expect(typeof mod.MemoryStore).toBe("function")
    expect(typeof mod.McpRegistry).toBe("function")
    expect(typeof mod.InputEditor).toBe("function")
  })
})
