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

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { errorMessage } from "./core/util.ts"
import { sensusHomeFrom, sensusStateDirFrom } from "./config/config.ts"
import type { ReconcileCloudServiceResult } from "./daemon/cloud/reconcile.ts"
import { daemonLogPath, resolveDaemonRuntimeDir } from "./daemon/paths.ts"
import { compiledEntry, daemonSelfArgv } from "./daemon/selfExec.ts"
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
  /** Test seam: repair the cloud service after a successful install. */
  reconcile?: (opts: { home: string; env: NodeJS.ProcessEnv }) => Promise<ReconcileCloudServiceResult>
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

/** The structured result of the shared check/install decision tree. */
export type UpdateApplyOutcome =
  | {
      ok: true
      status: "current" | "available" | "installed" | "dry_run"
      currentVersion: string
      latestVersion: string
      targetPath?: string
      prefix?: string
    }
  | {
      ok: false
      code: "update_check_failed" | "update_unavailable" | "update_failed"
      message: string
      /** Optional second human line (the CLI prints `sensus update: <hint>`). */
      hint?: string
    }

export interface UpdateApplyDeps extends UpdateDeps {
  /** Progress line emitted before the installer runs (the CLI's "updating" line). */
  note?: (message: string) => void
}

/**
 * The shared check/install decision tree behind `sensus update` and the
 * cloud-triggered `daemon.update` op. It performs no user-facing printing: the
 * caller owns the output and the service reconcile. `check` never installs.
 */
export async function applyUpdate(
  request: { check: boolean; dryRun: boolean; version: string | null },
  env: NodeJS.ProcessEnv,
  deps: UpdateApplyDeps = {},
): Promise<UpdateApplyOutcome> {
  const current = SENSUS_VERSION
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS

  // Resolve the target release: the pinned tag, or the latest release.
  let target = request.version === null ? null : normalizeTag(request.version)
  if (target === null) {
    const fetched = await fetchLatestTag({
      env,
      fetchImpl,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    })
    if (!fetched.ok) {
      return { ok: false, code: "update_check_failed", message: `could not check for updates: ${fetched.error}` }
    }
    target = fetched.tag
    // Refresh the launch alert's cache with what this explicit check learned.
    writeUpdateCache(updateCachePath(sensusStateDirFrom(env)), { latest: target, checkedAt: now() })
  }

  if (normalizeTag(target) === normalizeTag(current)) {
    return { ok: true, status: "current", currentVersion: current, latestVersion: target }
  }
  if (request.version === null && !isNewerVersion(target, current)) {
    // A locally built binary ahead of the latest release.
    return { ok: true, status: "current", currentVersion: current, latestVersion: target }
  }
  if (request.check) {
    return { ok: true, status: "available", currentVersion: current, latestVersion: target }
  }

  // Installing needs the compiled binary: a source run updates via git.
  const compiled = deps.compiled ?? import.meta.url.includes("$bunfs")
  if (!compiled) {
    return {
      ok: false,
      code: "update_unavailable",
      message: "this is a source checkout — update with `git pull && bun install` (docs/development).",
    }
  }
  const envPrefix = env["PREFIX"]
  const prefix =
    envPrefix !== undefined && envPrefix.length > 0
      ? envPrefix
      : installerPrefixFor(deps.execPath ?? process.execPath)
  if (prefix === null) {
    return {
      ok: false,
      code: "update_unavailable",
      message: `cannot install in place (running binary is ${deps.execPath ?? process.execPath}).`,
      hint: "reinstall with the release installer: curl -fsSL https://sensus.sh/install | bash",
    }
  }
  const targetPath = join(prefix, "bin", "sensus")

  if (request.dryRun) {
    return {
      ok: true,
      status: "dry_run",
      currentVersion: current,
      latestVersion: target,
      targetPath,
      prefix,
    }
  }

  const installer = await fetchInstaller(env, fetchImpl, timeoutMs)
  if (!installer.ok) {
    return { ok: false, code: "update_failed", message: `could not download the installer: ${installer.error}` }
  }

  deps.note?.(`sensus update: updating v${normalizeTag(current)} → v${normalizeTag(target)} (${targetPath})`)
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value
  childEnv["PREFIX"] = prefix
  if (request.version !== null) childEnv["SENSUS_RELEASE_VERSION"] = normalizeTag(target)
  const run = deps.runInstaller ?? spawnInstaller
  let code: number
  try {
    code = await run(installer.script, [], childEnv)
  } catch (e) {
    return { ok: false, code: "update_failed", message: `installer failed: ${errorMessage(e)}` }
  }
  if (code !== 0) {
    return { ok: false, code: "update_failed", message: `installer exited with code ${code}` }
  }
  return {
    ok: true,
    status: "installed",
    currentVersion: current,
    latestVersion: target,
    targetPath,
    prefix,
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

  const outcome = await applyUpdate(
    { check: options.check, dryRun: options.dryRun, version: options.version },
    env,
    { ...deps, note: (message) => io.out(message) },
  )
  if (!outcome.ok) {
    io.err(`sensus update: ${outcome.message}`)
    if (outcome.hint !== undefined) io.err(`sensus update: ${outcome.hint}`)
    return 1
  }

  const current = outcome.currentVersion
  if (outcome.status === "current") {
    if (normalizeTag(outcome.latestVersion) === normalizeTag(current)) {
      io.out(`sensus is up to date (v${normalizeTag(current)})`)
    } else {
      io.out(`sensus is up to date (v${normalizeTag(current)}; latest release is v${normalizeTag(outcome.latestVersion)})`)
    }
    return 0
  }
  if (outcome.status === "available") {
    io.out(
      `sensus v${normalizeTag(outcome.latestVersion)} is available (you have v${normalizeTag(current)}) — run \`sensus update\``,
    )
    return 0
  }
  if (outcome.status === "dry_run") {
    io.out(
      `sensus update: would install v${normalizeTag(outcome.latestVersion)} to ${outcome.targetPath ?? ""} (running v${normalizeTag(current)})`,
    )
    return 0
  }

  io.out(`sensus update: installed v${normalizeTag(outcome.latestVersion)} — restart your sensus session to use it.`)
  // Repair the always-on layer for a host that paired before `cloud pair`
  // started installing the user service. The running daemon (if any) is left
  // alone; the unit is enabled for the next login/boot (docs/auth.md).
  // `HOME` also keeps unit tests (which pass a bare env) from touching the
  // developer's real user service; production always has it.
  if (env["HOME"] !== undefined) {
    try {
      const reconcile =
        deps.reconcile ??
        (async (input: { home: string; env: NodeJS.ProcessEnv }) => {
          const { reconcileCloudService } = await import("./daemon/cloud/reconcile.ts")
          return await reconcileCloudService(input)
        })
      const reconciled = await reconcile({ home: sensusHomeFrom(env), env })
      if (reconciled.status === "installed") {
        io.out("sensus update: enabled the Sensus daemon service for the existing cloud pairing")
        if (reconciled.linger === "failed") {
          io.err("sensus update: warning: could not enable lingering; the service starts when you log in.")
        }
      } else if (reconciled.status === "failed") {
        io.err(`sensus update: warning: could not repair the daemon service: ${reconciled.detail ?? "unknown error"}`)
      }
    } catch (e) {
      io.err(`sensus update: warning: could not repair the daemon service: ${errorMessage(e)}`)
    }
  }
  io.out("sensus update: `sensus daemon restart` moves the running daemon to the new version (it will lose live shells).")
  return 0
}

// ---- cloud-triggered daemon update (`daemon.update`) -------------------------

export interface DaemonUpdateInput {
  check: boolean
  version: string | null
}

/** The cloud-facing result of a `daemon.update` request. */
export type DaemonUpdateResult = {
  /** Inner success marker (the cloud's result normalizer requires it). */
  ok: true
  action: "check" | "install"
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  updated: boolean
  restarting: boolean
  message?: string
}

export type DaemonUpdateOutcome =
  | { ok: true; result: DaemonUpdateResult }
  | { ok: false; code: "update_check_failed" | "update_unavailable" | "update_failed"; message: string }

export interface DaemonUpdateOptions {
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  runInstaller?: (script: string, args: string[], env: Record<string, string>) => Promise<number>
  compiled?: boolean
  execPath?: string
  /** Test seam: spawn the detached restart. Defaults to `spawnDaemonRestart`. */
  restart?: (env: NodeJS.ProcessEnv) => { ok: true } | { ok: false; error: string }
  timeoutMs?: number
}

/**
 * The daemon-side `daemon.update` runner. `check: true` never installs. A
 * successful install restarts the daemon (so the RPC reply lands first, the
 * restart helper sleeps briefly); if that spawn fails the caller is told to
 * run `sensus daemon restart`. Never throws.
 */
export async function runDaemonUpdate(
  input: DaemonUpdateInput,
  opts: DaemonUpdateOptions,
): Promise<DaemonUpdateOutcome> {
  const outcome = await applyUpdate(
    { check: input.check, dryRun: false, version: input.version },
    opts.env,
    {
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.runInstaller !== undefined ? { runInstaller: opts.runInstaller } : {}),
      ...(opts.compiled !== undefined ? { compiled: opts.compiled } : {}),
      ...(opts.execPath !== undefined ? { execPath: opts.execPath } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  )
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      message: outcome.hint !== undefined ? `${outcome.message} ${outcome.hint}` : outcome.message,
    }
  }

  const action: DaemonUpdateResult["action"] = input.check ? "check" : "install"
  const currentVersion = outcome.currentVersion
  const latestVersion: string | null = outcome.latestVersion
  const updateAvailable = isNewerVersion(outcome.latestVersion, currentVersion)

  if (outcome.status === "current") {
    return {
      ok: true,
      result: {
        ok: true,
        action,
        currentVersion,
        latestVersion,
        updateAvailable: false,
        updated: false,
        restarting: false,
        message: `sensus is up to date (v${normalizeTag(currentVersion)})`,
      },
    }
  }
  if (outcome.status === "available" || outcome.status === "dry_run") {
    return {
      ok: true,
      result: {
        ok: true,
        action,
        currentVersion,
        latestVersion,
        updateAvailable,
        updated: false,
        restarting: false,
        message: `sensus v${normalizeTag(outcome.latestVersion)} is available (you have v${normalizeTag(currentVersion)})`,
      },
    }
  }

  // Installed: restart the daemon so it runs the new binary.
  let restart: { ok: true } | { ok: false; error: string }
  try {
    restart = (opts.restart ?? spawnDaemonRestart)(opts.env)
  } catch (e) {
    restart = { ok: false, error: errorMessage(e) }
  }
  const restarting = restart.ok
  return {
    ok: true,
    result: {
      ok: true,
      action,
      currentVersion,
      latestVersion,
      updateAvailable,
      updated: true,
      restarting,
      message: restarting
        ? `installed v${normalizeTag(outcome.latestVersion)}; the daemon is restarting`
        : `installed v${normalizeTag(outcome.latestVersion)} but the daemon did not restart (${restart.error}); run \`sensus daemon restart\` to use the new version`,
    },
  }
}

/**
 * Spawn a detached `sensus daemon restart` for the cloud-triggered update. The
 * restart command honors `SENSUS_DAEMON_RESTART_DELAY_MS` so the RPC reply is
 * sent before the old daemon exits. Never throws.
 */
export function spawnDaemonRestart(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; error: string } {
  try {
    const runtimeDir = resolveDaemonRuntimeDir(env)
    const logPath = daemonLogPath(runtimeDir)
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    // Bun.spawn's env is Record<string, string|undefined>; drop undefined so
    // the child receives a clean environment.
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value
    childEnv["SENSUS_DAEMON_RESTART_DELAY_MS"] = "2000"
    const fd = openSync(logPath, "a", 0o600)
    try {
      const child = Bun.spawn(
        [...daemonSelfArgv(process.execPath, Bun.main, compiledEntry()), "daemon", "restart"],
        {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: childEnv,
        },
      )
      child.unref()
      return { ok: true }
    } finally {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}
