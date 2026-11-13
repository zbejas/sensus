/**
 * Daemon-specific filenames under the shared runtime dir (D7/D18;
 * docs/daemon-api.md): `daemon.sock` (API UDS), `daemon.token` (`0600` bearer
 * token), `daemon.pid` (pidfile for `start`/`stop`/`status`), `daemon.log`
 * (the detached process's raw stdio banner) and `daemon-log.jsonl` (the
 * STRUCTURED log — see `docs/operations.md`). The dir is derived from
 * `sensusRuntimeDir()` unless a caller passes one explicitly (tests).
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { sensusRuntimeDirFrom, sensusStateDirFrom } from "../engine/index.ts"

/** Runtime dir the root `--root` system service owns. */
export const SYSTEM_RUNTIME_DIR = "/run/sensus"

/** True when a root shell should attach to the system service. */
export function systemRuntimeAvailable(): boolean {
  if ((process.getuid?.() ?? -1) !== 0) return false
  try {
    return existsSync(join(SYSTEM_RUNTIME_DIR, "daemon.token"))
  } catch {
    return false
  }
}

/**
 * Runtime dir for a CLI/TUI invocation: an explicit `SENSUS_RUNTIME_DIR` wins,
 * then a root shell prefers the running system service at `/run/sensus`, then
 * the normal per-user directory.
 */
export function resolveDaemonRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  opts: { systemAvailable?: () => boolean } = {},
): string {
  const explicit = env["SENSUS_RUNTIME_DIR"]
  if (explicit !== undefined) return explicit
  if ((opts.systemAvailable ?? systemRuntimeAvailable)()) return SYSTEM_RUNTIME_DIR
  return sensusRuntimeDirFrom(env)
}

/** Runtime dir the daemon owns (`0700`). */
export function daemonRuntimeDir(): string {
  return resolveDaemonRuntimeDir()
}

/** Unix socket the management API binds. */
export function daemonSocketPath(dir: string = daemonRuntimeDir()): string {
  return join(dir, "daemon.sock")
}

/** `0600` bearer-token file, regenerated per boot. */
export function daemonTokenPath(dir: string = daemonRuntimeDir()): string {
  return join(dir, "daemon.token")
}

/** Pidfile written by `sensus daemon serve` (read by start/stop/status). */
export function daemonPidPath(dir: string = daemonRuntimeDir()): string {
  return join(dir, "daemon.pid")
}

/** Log file the detached `start` process writes stdout/stderr to. */
export function daemonLogPath(dir: string = daemonRuntimeDir()): string {
  return join(dir, "daemon.log")
}

/**
 * Raw stdio banner for the persistent **service** (systemd/launchd). Unlike
 * `daemonLogPath`, it cannot live in the runtime dir: the service manager opens
 * stdout before the daemon runs, and the runtime dir lives on tmpfs, so it does
 * not exist yet after a reboot. Keep this in the persistent state dir and create
 * the parent at install time.
 */
export function daemonServiceLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(sensusStateDirFrom(env), "logs", "daemon.log")
}

/**
 * STRUCTURED NDJSON log the daemon writes through `src/core/log.ts` (distinct
 * from `daemon.log`, which remains the detached process's RAW stdio banner).
 * One compact JSON record per line; configured at boot in `serve.ts`.
 */
export function daemonLogJsonlPath(dir: string = daemonRuntimeDir()): string {
  return join(dir, "daemon-log.jsonl")
}

/** Unix socket a local `eventSink` may target (symmetry with the shared dir). */
export function daemonEventsSocketPath(dir: string = daemonRuntimeDir()): string {
  return join(dir, "events.sock")
}
