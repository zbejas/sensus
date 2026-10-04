/**
 * Daemon-specific filenames under the shared runtime dir (D7/D18;
 * docs/daemon-api.md): `daemon.sock` (API UDS), `daemon.token` (`0600` bearer
 * token), `daemon.pid` (pidfile for `start`/`stop`/`status`), `daemon.log`
 * (the detached process's raw stdio banner) and `daemon-log.jsonl` (the
 * STRUCTURED log — see `docs/operations.md`). The dir is derived from
 * `sensusRuntimeDir()` unless a caller passes one explicitly (tests).
 */

import { join } from "node:path"
import { sensusRuntimeDir } from "../engine/index.ts"

/** Runtime dir the daemon owns (`0700`). */
export function daemonRuntimeDir(): string {
  return sensusRuntimeDir()
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
