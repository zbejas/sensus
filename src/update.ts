/**
 * `sensus update` (alias `sensus upgrade`) + the launch update alert
 * (docs/operations.md "Update").
 *
 * Headless and renderer-free: `src/cli.ts` dispatches `update`/`upgrade`
 * BEFORE the nest guard (so it works inside a sensus pane and from the
 * compiled binary), and `src/index.tsx` awaits `runUpdate`. The boot alert
 * calls `checkForUpdate` against the state-dir cache, so at most one request
 * per day leaves the machine.
 *
 * Egress is deliberate and opt-out (the D8 carve-out, docs/events.md "No
 * egress"): `SENSUS_UPDATE_CHECK=0` disables the boot check. `sensus update`
 * always checks — that is its job — and installs by downloading the release
 * installer and running it against the running binary's prefix.
 *
 * Every network/disk failure is returned as a value or printed to `io`; a
 * check must never throw into the boot path (AGENTS.md rule 10).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { errorMessage } from "./core/util.ts"
import { sensusStateDirFrom } from "./config/config.ts"
import { SENSUS_VERSION } from "./version.ts"

/** How long a completed check is reused before asking again (24h). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The latest-release JSON endpoint (GitHub Releases by default). */
export const DEFAULT_UPDATE_URL = "https://api.github.com/repos/zbejas/sensus/releases/latest"

/** The installer `sensus update` downloads and runs (the public endpoint). */
export const DEFAULT_INSTALL_URL = "https://sensus.sh/install"

/** Timeout for the check/installer fetches: a boot must never wait long. */
const FETCH_TIMEOUT_MS = 5000

export interface UpdateIo {
  out(s: string): void
  err(s: string): void
}

// ---- version comparison ------------------------------------------------------

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

/** Parse `v1.2.3` / `1.2` / `1.2.3-rc.1+build` into a numeric triple (null on junk). */
export function parseVersion(text: string): ParsedVersion | null {
  const core = text.trim().replace(/^v/i, "").split(/[-+]/, 1)[0] ?? ""
  if (!/^\d+(\.\d+)*$/.test(core)) return null
  const parts = core.split(".").map((p) => Number(p))
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 }
}

/** True when `latest` is strictly newer than `current` (unparseable = false). */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (a === null || b === null) return false
  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  return a.patch > b.patch
}

/** The display form of a release tag: `v0.2.0` → `0.2.0`. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/i, "")
}

/** The launch-alert line for a known newer release. */
export function updateAlertMessage(current: string, latest: string): string {
  return `sensus v${normalizeTag(latest)} is available (you have v${normalizeTag(current)}) — run \`sensus update\``
}

// ---- check cache -------------------------------------------------------------

export interface UpdateCache {
  latest: string
  checkedAt: number
}

/** The cache lives in the state dir, like the search index. */
export function updateCachePath(stateDir: string): string {
  return join(stateDir, "update-check.json")
}

/** The cache when it is present, parseable, and fresher than `maxAgeMs`. */
export function readUpdateCache(path: string, now: number, maxAgeMs = UPDATE_CHECK_INTERVAL_MS): UpdateCache | null {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { latest?: unknown; checkedAt?: unknown }
    if (typeof doc.latest !== "string" || typeof doc.checkedAt !== "number") return null
    if (now - doc.checkedAt > maxAgeMs) return null
    if (doc.checkedAt > now) return null // clock moved backwards: re-check
    return { latest: doc.latest, checkedAt: doc.checkedAt }
  } catch {
    return null
  }
}

/** Best-effort cache write — a failing disk never breaks a boot or update. */
export function writeUpdateCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ v: 1, latest: cache.latest, checkedAt: cache.checkedAt })}\n`)
  } catch {
    // best-effort
  }
}

// ---- the check ---------------------------------------------------------------

/** `SENSUS_UPDATE_CHECK=0` (or false/off/no) disables the launch check. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env["SENSUS_UPDATE_CHECK"]?.trim().toLowerCase()
  return v === "0" || v === "false" || v === "off" || v === "no"
}

/** The latest-release endpoint for an env (`SENSUS_UPDATE_URL` test seam). */
export function updateUrlFrom(env: NodeJS.ProcessEnv): string {
  return env["SENSUS_UPDATE_URL"] ?? DEFAULT_UPDATE_URL
}

/** The installer URL for an env (`SENSUS_INSTALL_URL` test seam). */
export function installUrlFrom(env: NodeJS.ProcessEnv): string {
  return env["SENSUS_INSTALL_URL"] ?? DEFAULT_INSTALL_URL
}

export type FetchLatestResult = { ok: true; tag: string } | { ok: false; error: string }

/**
 * Ask the release endpoint for the latest tag. Resolves (never rejects) with
 * an error string on any HTTP/parse/network failure.
 */
export async function fetchLatestTag(opts: {
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<FetchLatestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = updateUrlFrom(opts.env)
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": `sensus/${SENSUS_VERSION}`, accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `${url} answered HTTP ${res.status}` }
    const doc = (await res.json()) as { tag_name?: unknown }
    if (typeof doc.tag_name !== "string" || doc.tag_name.trim().length === 0) {
      return { ok: false, error: `${url} did not report a release tag` }
    }
    return { ok: true, tag: normalizeTag(doc.tag_name) }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

export interface UpdateCheckResult {
  status: "ok" | "disabled" | "error"
  /** The latest known release (display form) when one is known. */
  latest: string | null
  updateAvailable: boolean
  /** Where the answer came from (null when disabled/error). */
  source: "cache" | "network" | null
  error?: string
}

export interface CheckForUpdateOptions {
  stateDir: string
  env: NodeJS.ProcessEnv
  currentVersion?: string
  now?: () => number
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * The cache-aware update check behind the launch alert. `status: "ok"` means
 * an answer is known (from the cache or the network); `"error"`/`"disabled"`
 * mean the alert stays silent. Never throws.
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<UpdateCheckResult> {
  const current = opts.currentVersion ?? SENSUS_VERSION
  if (updateCheckDisabled(opts.env)) {
    return { status: "disabled", latest: null, updateAvailable: false, source: null }
  }
  const now = opts.now ?? Date.now
  const cachePath = updateCachePath(opts.stateDir)
  const cached = readUpdateCache(cachePath, now())
  if (cached !== null) {
    return {
      status: "ok",
      latest: cached.latest,
      updateAvailable: isNewerVersion(cached.latest, current),
      source: "cache",
    }
  }
  const fetched = await fetchLatestTag({
    env: opts.env,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
  if (!fetched.ok) {
    return { status: "error", latest: null, updateAvailable: false, source: null, error: fetched.error }
  }
  writeUpdateCache(cachePath, { latest: fetched.tag, checkedAt: now() })
  return {
    status: "ok",
    latest: fetched.tag,
    updateAvailable: isNewerVersion(fetched.tag, current),
    source: "network",
  }
}

// ---- `sensus update` ---------------------------------------------------------

export interface UpdateOptions {
  check: boolean
  dryRun: boolean
  /** Pinned release (display form); null = the latest release. */
  version: string | null
  help: boolean
}

export type ParsedUpdateArgs = { ok: true; options: UpdateOptions } | { ok: false; error: string }

/** Parse `sensus update [--check] [--dry-run] [--version <tag>]`. */
export function parseUpdateArgs(argv: readonly string[]): ParsedUpdateArgs {
  const options: UpdateOptions = { check: false, dryRun: false, version: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (arg === "--check") {
      options.check = true
    } else if (arg === "--dry-run") {
      options.dryRun = true
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      const raw = arg === "--version" ? (argv[++i] ?? "").trim() : arg.slice("--version=".length).trim()
      if (raw.length === 0) return { ok: false, error: "--version needs a release tag (e.g. v0.2.0)" }
      // `--version latest` is the default behavior, not a pinned tag.
      options.version = raw.toLowerCase() === "latest" ? null : normalizeTag(raw)
    } else if (arg.startsWith("-")) {
      return { ok: false, error: `unknown flag: ${arg}` }
    } else {
      return { ok: false, error: `unexpected argument: ${arg}` }
    }
  }
  return { ok: true, options }
}

/**
 * The installer PREFIX that replaces the RUNNING binary in place
 * (`<prefix>/bin/sensus`), or null when the running path is not a canonical
 * install (a checkout `dist/sensus` must update from source instead).
 */
export function installerPrefixFor(execPath: string): string | null {
  if (basename(execPath) !== "sensus") return null
  const binDir = dirname(execPath)
  if (basename(binDir) !== "bin") return null
  return dirname(binDir)
}

/** Injectable seams: tests drive fetch/installer/compiled-detection directly. */
export interface UpdateDeps {
  fetchImpl?: typeof fetch
  /** Run the fetched installer script; resolves the child's exit code. */
  runInstaller?: (script: string, args: string[], env: Record<string, string>) => Promise<number>
  /** Compiled-binary check (defaults to the `$bunfs` probe, like the client). */
  compiled?: boolean
  execPath?: string
  now?: () => number
  timeoutMs?: number
}

/** The default installer runner: `bash -s --` with the script on stdin. */
async function spawnInstaller(script: string, args: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(["bash", "-s", "--", ...args], {
    stdin: new Blob([script]),
    stdout: "inherit",
    stderr: "inherit",
    env,
  })
  return await proc.exited
}

/** Download the release installer (a sanity `#!` check guards a captive portal). */
async function fetchInstaller(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; script: string } | { ok: false; error: string }> {
  const url = installUrlFrom(env)
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": `sensus/${SENSUS_VERSION}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `${url} answered HTTP ${res.status}` }
    const script = await res.text()
    if (!script.startsWith("#!")) return { ok: false, error: `${url} did not return an installer script` }
    return { ok: true, script }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

const UPDATE_USAGE = `usage: sensus update [--check] [--dry-run] [--version <tag>]
       sensus upgrade   (alias for sensus update)

  --check          report whether a newer release exists; install nothing
  --dry-run        print what would be installed; install nothing
  --version <tag>  install a specific release (e.g. v0.2.0)

Installs the latest release in place, over the running binary (same
directory). From a source checkout it prints the git-based update instead.
sensus checks for a newer release once a day at launch and toasts when one
exists; set SENSUS_UPDATE_CHECK=0 to disable that check.`

/**
 * `sensus update` / `sensus upgrade`: check the latest release and install it
 * in place. Headless — never boots the TUI, never nests.
 */
export async function runUpdate(
  argv: readonly string[],
  io: UpdateIo,
  env: NodeJS.ProcessEnv,
  deps: UpdateDeps = {},
): Promise<number> {
  const parsed = parseUpdateArgs(argv)
  if (!parsed.ok) {
    io.err(`sensus update: ${parsed.error}`)
    io.err(UPDATE_USAGE)
    return 1
  }
  const options = parsed.options
  if (options.help) {
    io.out(UPDATE_USAGE)
    return 0
  }

  const current = SENSUS_VERSION
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS

  // Resolve the target release: the pinned tag, or the latest release.
  let target = options.version
  if (target === null) {
    const fetched = await fetchLatestTag({
      env,
      fetchImpl,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    })
    if (!fetched.ok) {
      io.err(`sensus update: could not check for updates: ${fetched.error}`)
      return 1
    }
    target = fetched.tag
    // Refresh the launch alert's cache with what this explicit check learned.
    writeUpdateCache(updateCachePath(sensusStateDirFrom(env)), { latest: target, checkedAt: now() })
  }

  if (normalizeTag(target) === normalizeTag(current)) {
    io.out(`sensus is up to date (v${normalizeTag(current)})`)
    return 0
  }
  if (options.version === null && !isNewerVersion(target, current)) {
    // A locally built binary ahead of the latest release.
    io.out(`sensus is up to date (v${normalizeTag(current)}; latest release is v${normalizeTag(target)})`)
    return 0
  }
  if (options.check) {
    io.out(`sensus v${normalizeTag(target)} is available (you have v${normalizeTag(current)}) — run \`sensus update\``)
    return 0
  }

  // Installing needs the compiled binary: a source run updates via git.
  const compiled = deps.compiled ?? import.meta.url.includes("$bunfs")
  if (!compiled) {
    io.err("sensus update: this is a source checkout — update with `git pull && bun install` (docs/development).")
    return 1
  }
  const envPrefix = env["PREFIX"]
  const prefix =
    envPrefix !== undefined && envPrefix.length > 0
      ? envPrefix
      : installerPrefixFor(deps.execPath ?? process.execPath)
  if (prefix === null) {
    io.err(`sensus update: cannot install in place (running binary is ${deps.execPath ?? process.execPath}).`)
    io.err("sensus update: reinstall with the release installer: curl -fsSL https://sensus.sh/install | bash")
    return 1
  }
  const targetPath = join(prefix, "bin", "sensus")

  if (options.dryRun) {
    io.out(
      `sensus update: would install v${normalizeTag(target)} to ${targetPath} (running v${normalizeTag(current)})`,
    )
    return 0
  }

  const installer = await fetchInstaller(env, fetchImpl, timeoutMs)
  if (!installer.ok) {
    io.err(`sensus update: could not download the installer: ${installer.error}`)
    return 1
  }

  io.out(`sensus update: updating v${normalizeTag(current)} → v${normalizeTag(target)} (${targetPath})`)
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value
  childEnv["PREFIX"] = prefix
  if (options.version !== null) childEnv["SENSUS_RELEASE_VERSION"] = options.version
  const run = deps.runInstaller ?? spawnInstaller
  let code: number
  try {
    code = await run(installer.script, [], childEnv)
  } catch (e) {
    io.err(`sensus update: installer failed: ${errorMessage(e)}`)
    return 1
  }
  if (code !== 0) {
    io.err(`sensus update: installer exited with code ${code}`)
    return 1
  }
  io.out(`sensus update: installed v${normalizeTag(target)} — restart your sensus session to use it.`)
  io.out("sensus update: `sensus daemon restart` moves the running daemon to the new version (it will lose live shells).")
  return 0
}
