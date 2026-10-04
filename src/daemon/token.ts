/**
 * Daemon token + runtime-dir file helpers. Mirroring `src/agent/audit.ts` /
 * `src/config/configFile.ts`, nothing here throws: every function returns a
 * result object or `null`, so a read-only filesystem or a stray permission
 * error surfaces as a value the caller can report — never a crash.
 */

import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { errorMessage } from "../core/util.ts"

/** Result of a filesystem mutation; `error` is set only when `ok` is false. */
export interface TokenResult {
  ok: boolean
  error?: string
}

/** The private modes the daemon owns: dir `0700`, token/pid `0600`. */
export const RUNTIME_DIR_MODE = 0o700
export const TOKEN_FILE_MODE = 0o600
export const PID_FILE_MODE = 0o600

/** A fresh 256-bit token as lowercase hex (64 chars). */
export function generateToken(): string {
  return randomBytes(32).toString("hex")
}

/** Create the runtime dir `0700` (idempotent; tightens an existing dir too). */
export function ensureRuntimeDir(dir: string): TokenResult {
  try {
    mkdirSync(dir, { recursive: true, mode: RUNTIME_DIR_MODE })
    chmodSync(dir, RUNTIME_DIR_MODE)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

/** Write the token `0600`, chmod'ing an existing file down to `0600` too. */
export function writeToken(path: string, token: string): TokenResult {
  try {
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: TOKEN_FILE_MODE })
    chmodSync(path, TOKEN_FILE_MODE)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

/** Read the token; null when absent/empty/unreadable. */
export function readToken(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/** Write the pidfile `0600`. */
export function writePidFile(path: string, pid: number): TokenResult {
  try {
    writeFileSync(path, `${pid}\n`, { encoding: "utf8", mode: PID_FILE_MODE })
    chmodSync(path, PID_FILE_MODE)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

/** Read a pidfile; null when absent/empty/non-numeric/unreadable. */
export function readPidFile(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
