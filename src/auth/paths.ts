/**
 * Host auth files under `<config>/auth/`: the Ed25519 host identity and the
 * local scope policy. Both are owner-only and created atomically. The embedded
 * cloud client (`src/daemon/cloud/`) only reads these files.
 */

import { join } from "node:path"
import { atomicWriteText, type AtomicWriteResult } from "../core/util.ts"
import { sensusHome, sensusHomeFrom } from "../config/config.ts"

/** `<config>/auth`. */
export function authDir(home: string = sensusHome()): string {
  return join(home, "auth")
}

/** The local Ed25519 keypair (0600). */
export function authIdentityPath(home: string = sensusHome()): string {
  return join(authDir(home), "identity.json")
}

/** Host-local pairing/scope policy (0600). */
export function authPolicyPath(home: string = sensusHome()): string {
  return join(authDir(home), "policy.json")
}

/** The config home for an explicit env (test seam). */
export function authHomeFrom(env: NodeJS.ProcessEnv): string {
  return sensusHomeFrom(env)
}

/** True when this process is root — identity/policy writes refuse root. */
export function isRoot(uid: number | undefined = safeUid()): boolean {
  return uid === 0
}

/** `process.getuid()` without throwing on platforms that do not have it. */
export function safeUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined
  } catch {
    return undefined
  }
}

/** Atomically write one auth JSON artifact with owner-only permissions. */
export function writeAuthJson(path: string, value: unknown): AtomicWriteResult {
  try {
    return atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
