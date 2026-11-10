/**
 * Host-local pairing policy (`<config>/auth/policy.json`, 0600). The host
 * chooses the scopes once; the cloud connector reads them and the cloud can
 * never widen them. `chat`/`control`/`orchestrator` imply `view`.
 */

import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, resolve, sep } from "node:path"
import { errorMessage, isRecord } from "../core/util.ts"
import {
  DEFAULT_SCOPE,
  MAX_STREAMS,
  SCOPES,
  normalizeScopeArray,
  type Scope,
} from "./scopes.ts"
import { authDir, authPolicyPath, safeUid, writeAuthJson } from "./paths.ts"

/** The `policy.json` document (version 1). */
export interface AuthPolicy {
  version: 1
  scopes: Scope[]
  startDaemon: boolean
  /** Absolute directories a connector `terminal.open` may use as its cwd. */
  allowedCwd: string[]
  maxStreams: number
}

export function defaultPolicy(): AuthPolicy {
  return {
    version: 1,
    scopes: [DEFAULT_SCOPE],
    startDaemon: false,
    allowedCwd: [],
    maxStreams: MAX_STREAMS,
  }
}

function clampMaxStreams(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_STREAMS
  return Math.min(MAX_STREAMS, Math.max(1, Math.floor(value)))
}

/** Resolve a path without requiring it to exist, canonicalizing symlinks when it does. */
export function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Validate one parsed policy object; null when structurally invalid. */
export function normalizePolicy(value: unknown): AuthPolicy | null {
  if (!isRecord(value)) return null
  if (value["version"] !== undefined && value["version"] !== 1) return null
  const scopes = normalizeScopeArray(value["scopes"])
  if (scopes === null) return null
  const allowedCwdRaw = value["allowedCwd"]
  if (allowedCwdRaw !== undefined && (!Array.isArray(allowedCwdRaw) || !allowedCwdRaw.every((v) => typeof v === "string"))) {
    return null
  }
  const allowedCwd = ((allowedCwdRaw as string[] | undefined) ?? [])
    .filter((path) => path.length > 0 && isAbsolute(path))
    .map((path) => normalizeExistingPath(path))
  return {
    version: 1,
    scopes: scopes.length > 0 ? scopes : [DEFAULT_SCOPE],
    startDaemon: value["startDaemon"] === true,
    allowedCwd: [...new Set(allowedCwd)],
    maxStreams: clampMaxStreams(value["maxStreams"]),
  }
}

export type PolicyReadResult = { ok: true; policy: AuthPolicy; existed: boolean } | { ok: false; error: string }

/** Read `policy.json`; a missing file is the safe default, a bad file is an error. */
export function readPolicy(home: string): PolicyReadResult {
  const path = authPolicyPath(home)
  if (!existsSync(path)) return { ok: true, policy: defaultPolicy(), existed: false }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    return { ok: false, error: `cannot read ${path}: ${errorMessage(e)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `invalid policy JSON at ${path}: ${errorMessage(e)}` }
  }
  const policy = normalizePolicy(parsed)
  if (policy === null) return { ok: false, error: `invalid auth policy at ${path}` }
  return { ok: true, policy, existed: true }
}

/** Write `policy.json` (0600) atomically. Refuses root. */
export function writePolicy(
  home: string,
  policy: AuthPolicy,
  opts: { uid?: number } = {},
): { ok: true; path: string } | { ok: false; error: string } {
  if ((opts.uid ?? safeUid()) === 0) {
    return { ok: false, error: "refusing to write the auth policy as root (run as the Sensus user)" }
  }
  const normalized = normalizePolicy(policy)
  if (normalized === null) return { ok: false, error: "invalid auth policy" }
  const res = writeAuthJson(authPolicyPath(home), normalized)
  if (!res.ok) return { ok: false, error: res.error ?? "cannot write the auth policy" }
  try {
    chmodSync(authDir(home), 0o700)
    chmodSync(authPolicyPath(home), 0o600)
  } catch {
    // best-effort: the atomic write already used 0600/0700
  }
  return { ok: true, path: authPolicyPath(home) }
}

/** Update the scopes in an existing policy, preserving allowedCwd/startDaemon. */
export function updatePolicyScopes(policy: AuthPolicy, scopes: readonly Scope[]): AuthPolicy {
  const next = normalizePolicy({ ...policy, scopes })
  return next ?? { ...policy, scopes: [DEFAULT_SCOPE] }
}

/** True when `cwd` is absolute and inside one of the policy's allowlisted dirs. */
export function isCwdAllowed(policy: AuthPolicy, cwd: string | undefined): boolean {
  if (cwd === undefined || cwd.length === 0) return true
  if (!isAbsolute(cwd)) return false
  if (policy.allowedCwd.length === 0) return false
  const target = normalizeExistingPath(cwd)
  for (const allowed of policy.allowedCwd) {
    const root = normalizeExistingPath(allowed)
    if (target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return true
  }
  return false
}

/** A short human scope line used by the CLI/status output. */
export function scopeSummary(policy: AuthPolicy): string {
  return policy.scopes.length > 0 ? policy.scopes.join(",") : "none"
}

/** Unknown scopes are rejected; the connector reads only this canonical list. */
export function availableScopes(): readonly Scope[] {
  return SCOPES
}
