import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Config dir for an explicit env (test seam; sensusHome() reads process.env). */
export function sensusHomeFrom(env: NodeJS.ProcessEnv): string {
  return env["SENSUS_HOME"] ?? `${env["HOME"] ?? ""}/.config/sensus`
}

/** Config dir: SENSUS_HOME redirects everything (docs/config.md). */
export function sensusHome(): string {
  return sensusHomeFrom(process.env as NodeJS.ProcessEnv)
}

/** Data dir for an explicit env (test seam; sensusDataDir() reads process.env). */
export function sensusDataDirFrom(env: NodeJS.ProcessEnv): string {
  return env["SENSUS_HOME"] ?? `${env["HOME"] ?? ""}/.local/share/sensus`
}

/** Data dir (sessions, resume, the event log). SENSUS_HOME redirects it too. */
export function sensusDataDir(): string {
  return sensusDataDirFrom(process.env as NodeJS.ProcessEnv)
}

/** Cache dir (MCP per-server spawn dirs, docs/mcp.md). Resolution order:
 * SENSUS_CACHE_DIR → `${SENSUS_HOME}/cache` → `${HOME}/.cache/sensus`. */
export function sensusCacheDir(): string {
  return (
    process.env["SENSUS_CACHE_DIR"] ??
    (process.env["SENSUS_HOME"] !== undefined ? `${process.env["SENSUS_HOME"]}/cache` : undefined) ??
    `${process.env["HOME"] ?? ""}/.cache/sensus`
  )
}

/** State dir (M6 detached-server registry). SENSUS_STATE overrides; like the
 * config/data dirs, SENSUS_HOME redirects it wholesale (test seam). */
export function sensusStateDir(): string {
  return (
    process.env["SENSUS_STATE"] ??
    process.env["SENSUS_HOME"] ??
    `${process.env["HOME"] ?? ""}/.local/state/sensus`
  )
}

/** Runtime dir for an explicit env (test seam; the daemon reads process.env).
 * Resolution: `SENSUS_RUNTIME_DIR` → `${XDG_RUNTIME_DIR}/sensus-<uid>` when
 * `XDG_RUNTIME_DIR` is non-empty → `${os.tmpdir()}/sensus-<uid>`.
 * `SENSUS_RUNTIME_DIR` is the hermetic seam the daemon tests set. */
export function sensusRuntimeDirFrom(env: NodeJS.ProcessEnv): string {
  const explicit = env["SENSUS_RUNTIME_DIR"]
  if (explicit !== undefined) return explicit
  const uid = runtimeUid()
  const xdg = env["XDG_RUNTIME_DIR"]
  if (xdg !== undefined && xdg !== "") return `${xdg}/sensus-${uid}`
  return join(tmpdir(), `sensus-${uid}`)
}

/** Runtime dir the daemon owns: the UDS socket + token live here
 * (D7; docs/architecture.md "Lifecycle"). */
export function sensusRuntimeDir(): string {
  return sensusRuntimeDirFrom(process.env as NodeJS.ProcessEnv)
}

/** POSIX uid for the runtime-dir name; a stable `"0"` fallback where getuid is
 * unavailable (Windows) keeps the path deterministic. */
function runtimeUid(): string {
  try {
    const uid = process.getuid?.()
    if (typeof uid === "number") return String(uid)
  } catch {
    // fall through to the stable fallback
  }
  return "0"
}

/** Full path to the JSON config file. */
export function configPath(home = sensusHome()): string {
  return `${home}/config.json`
}

/** Agents dir (docs/agents.md): markdown agent definitions. */
export function agentsDir(home = sensusHome()): string {
  return `${home}/agents`
}

/** Skills dir (docs/skills.md): user SKILL.md files + the built-in `sensus` skill. */
export function skillsDir(home = sensusHome()): string {
  return `${home}/skills`
}

/** Memory dir — reserved for future agent memory (materialized empty). */
export function memoryDir(home = sensusHome()): string {
  return `${home}/memory`
}

/** Machine/installation identity (D13; docs/events.md): the daemon owns and
 * generates it at boot, stable across upgrades/restarts. */
export function instancePath(home = sensusHome()): string {
  return `${home}/instance.json`
}

/** Durable local event log (event schema v1, NDJSON; docs/events.md). The
 * daemon owns the writer; `SENSUS_HOME` redirects it like the data dir. */
export function eventsPath(dataDir = sensusDataDir()): string {
  return `${dataDir}/events.jsonl`
}

/** Durable local trigger log (docs/triggers.md): one JSON record per matched
 * condition trigger, bounded/rotated like `events.jsonl`. The daemon owns the
 * writer; `SENSUS_HOME` redirects it like the data dir. */
export function triggersPath(dataDir = sensusDataDir()): string {
  return `${dataDir}/triggers.jsonl`
}

/** Custom instructions: ~/.config/sensus/AGENTS.md (appended to the system
 * prompt in M3). /reload re-reads it. Returns null when absent. */
export function loadCustomInstructions(home = sensusHome()): string | null {
  try {
    return readFileSync(`${home}/AGENTS.md`, "utf8")
  } catch {
    return null
  }
}
