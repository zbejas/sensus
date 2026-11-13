/**
 * Paths for the embedded cloud client. Unlike the standalone connector, the
 * daemon owns the connection state next to its Sensus config:
 *
 *   <SENSUS_HOME>/cloud/connection.json   paired origin + device token (0600)
 *   <SENSUS_HOME>/cloud/runs.json         cloud-created chat/shell registry
 *
 * Runtime discovery is the daemon's own per-uid runtime dir (docs/daemon-api.md).
 */

import { join } from "node:path"
import { atomicWriteText, type AtomicWriteResult } from "../../core/util.ts"
import { resolveDaemonRuntimeDir } from "../paths.ts"

/** `<config>/cloud`. */
export function cloudDir(home: string): string {
  return join(home, "cloud")
}

/** The paired-cloud connection state (0600). */
export function connectionPath(home: string): string {
  return join(cloudDir(home), "connection.json")
}

/** The cloud-created run registry (0600). */
export function runsPath(home: string): string {
  return join(cloudDir(home), "runs.json")
}

/** The local daemon runtime dir (`SENSUS_RUNTIME_DIR` > XDG > tmp, per uid). */
export function resolveRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDaemonRuntimeDir(env)
}

export function daemonSocketPath(runtimeDir: string): string {
  return join(runtimeDir, "daemon.sock")
}

export function daemonTokenPath(runtimeDir: string): string {
  return join(runtimeDir, "daemon.token")
}

/** Atomically write one cloud JSON artifact (0600 file, 0700 parent). */
export function writeCloudJson(path: string, value: unknown): AtomicWriteResult {
  return atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}
