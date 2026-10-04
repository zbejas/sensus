/**
 * Instruction resolution (docs/config.md "instructions"). Turns the config
 * `instructions` list — file paths, `~/` paths, globs and `http(s)://` URLs —
 * into model-facing text, and finds the nearest `AGENTS.md` for a file the
 * agent reads.
 *
 * Pure-ish and best-effort: a missing/unreadable file or an unreachable URL
 * is ignored, never thrown (AGENTS.md rule 10). URL bodies are fetched by
 * `ChatHost` (short timeout), never here, so the system-prompt build stays
 * synchronous.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { sensusHome } from "../config/config.ts"
import { componentLogger } from "./log.ts"

const log = componentLogger("agent.instructions")

/** Request timeout for `instructions` URL entries (best-effort fetch). */
export const INSTRUCTION_URL_TIMEOUT_MS = 4000

export interface InstructionExpandOptions {
  /** Base for relative non-glob paths — the user's terminal cwd. */
  cwd: string
  /** OS home used to expand `~/` entries. */
  home: string
  /**
   * Config dir used as the fallback root for relative non-glob paths and for
   * config-relative globs (defaults to `home`). `ChatHost` passes
   * `sensusHome()` so `instructions: ["docs/GUIDE.md"]` also resolves under
   * `~/.config/sensus/`.
   */
  configDir?: string
}

const GLOB_RE = /[*?[\]{}]/
const URL_RE = /^https?:\/\//i

function isUrl(entry: string): boolean {
  return URL_RE.test(entry)
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return join(home, p.slice(2))
  return p
}

/** Scan a glob, falling back from `cwd` to `configDir` when cwd has no match. */
function scanGlob(pattern: string, cwd: string, configDir: string, add: (p: string) => void): void {
  const absolute = isAbsolute(pattern)
  const tryScan = (base: string | null): boolean => {
    let matches: string[]
    try {
      matches = [...new Bun.Glob(pattern).scanSync(base === null ? {} : { cwd: base })]
    } catch {
      return false
    }
    if (matches.length === 0) return false
    for (const m of matches) {
      add(absolute || base === null ? m : resolve(base, m))
    }
    return true
  }
  if (tryScan(absolute ? null : cwd)) return
  if (!absolute) tryScan(configDir)
}

/**
 * Resolve the config `instructions` entries to a de-duplicated, sorted list of
 * existing files. `http(s)://` entries are ignored here (see
 * `listInstructionUrls`); a missing path/glob yields nothing.
 */
export function expandInstructionEntries(
  entries: readonly string[],
  opts: InstructionExpandOptions,
): { files: string[] } {
  const cwd = opts.cwd
  const home = opts.home
  const configDir = opts.configDir ?? home
  const files = new Set<string>()
  const add = (p: string): void => {
    if (p.length > 0) files.add(resolve(p))
  }
  for (const raw of entries) {
    if (typeof raw !== "string") continue
    const entry = raw.trim()
    if (entry.length === 0 || isUrl(entry)) continue
    if (GLOB_RE.test(entry)) {
      scanGlob(expandTilde(entry, home), cwd, configDir, add)
      continue
    }
    const expanded = expandTilde(entry, home)
    if (isAbsolute(expanded)) {
      if (isFile(expanded)) add(expanded)
      continue
    }
    const fromCwd = resolve(cwd, expanded)
    if (isFile(fromCwd)) add(fromCwd)
    else {
      const fromConfig = resolve(configDir, expanded)
      if (isFile(fromConfig)) add(fromConfig)
    }
  }
  return { files: [...files].sort() }
}

/** The `http(s)://` entries of an `instructions` list, in order. */
export function listInstructionUrls(entries: readonly string[]): string[] {
  const urls: string[] = []
  for (const raw of entries) {
    if (typeof raw !== "string") continue
    const entry = raw.trim()
    if (isUrl(entry)) urls.push(entry)
  }
  return urls
}

/**
 * Read instruction files best-effort, labelling each with its path. A
 * missing/unreadable/empty file is skipped; the result never throws.
 */
export function readInstructionFiles(files: readonly string[]): { text: string; sources: string[] } {
  const parts: string[] = []
  const sources: string[] = []
  for (const file of files) {
    let body: string
    try {
      body = readFileSync(file, "utf8").trim()
    } catch (e) {
      log.debug("instruction file read failed; skipped", { path: file, err: e })
      continue
    }
    if (body.length === 0) continue
    sources.push(file)
    parts.push(`# Instructions from ${file}\n${body}`)
  }
  return { text: parts.join("\n\n---\n\n"), sources }
}

/**
 * Walk UP from `filePath`'s directory for the nearest `AGENTS.md`, stopping at
 * the filesystem root. The global `~/.config/sensus/AGENTS.md` is skipped
 * (it is already loaded statically into the prompt). Pure; returns the first
 * match or null. `opts.globalPath` overrides the skip target (tests).
 */
export function findNearestInstructionFile(
  filePath: string,
  opts: { globalPath?: string } = {},
): string | null {
  const global = resolve(opts.globalPath ?? join(sensusHome(), "AGENTS.md"))
  let dir = dirname(resolve(filePath))
  for (;;) {
    const candidate = join(dir, "AGENTS.md")
    if (resolve(candidate) !== global && isFile(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
