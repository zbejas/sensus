/**
 * Encrypted secrets store (docs/config.md "Secrets").
 *
 * config.json must never hold a raw API key. Instead it references one with a
 * `${NAME}` token — the same syntax MCP `env`/`headers` already used — and this
 * module supplies the values:
 *
 * - `~/.config/sensus/secrets.json` holds the values, encrypted at rest with
 *   AES-256-GCM;
 * - the 256-bit master key lives in `~/.config/sensus/.secrets-key` (0600,
 *   best-effort) so the store decrypts without a passphrase — the TUI boots
 *   unattended;
 * - `loadSecrets` feeds the values into config resolution as an extra
 *   environment layer (store first, process env second), so
 *   `"apiKey": "${OPENAI_API_KEY}"` and `Bearer ${FIRECRAWL_API_KEY}` resolve
 *   transparently.
 *
 * The threat model is "a stray backup/paste of config.json": the config is
 * cipher-free, and only the store + key pair can reproduce a value. A local
 * attacker who can read BOTH files is out of scope (the key has to be readable
 * without user input at boot — the same trade-off as `core/sudoVault.ts`).
 *
 * Never throws: every entry point returns a result object, so a corrupt store
 * degrades to "secrets unavailable" instead of crashing the TUI.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { expandEnvRefs } from "../agent/mcp/types.ts"
import { atomicWriteText, errorMessage, isRecord } from "../core/util.ts"
import { readRawConfig, writeRawConfig, type RawConfigDoc } from "./configFile.ts"

export type SecretValues = Record<string, string>

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12

export const SECRETS_FILE = "secrets.json"
export const SECRETS_KEY_FILE = ".secrets-key"

/** Full path to the encrypted store (SENSUS_HOME redirects it). */
export function secretsPath(home: string): string {
  return `${home}/${SECRETS_FILE}`
}

/** Full path to the 0600 master-key file. */
export function secretsKeyPath(home: string): string {
  return `${home}/${SECRETS_KEY_FILE}`
}

// ---- references -------------------------------------------------------------

const REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** True when a whole string is exactly one `${NAME}` reference. */
export function isSecretRef(value: string): boolean {
  return REF_RE.test(value.trim())
}

/** The name in a whole-string `${NAME}` reference, or null. */
export function secretRefName(value: string): string | null {
  const m = REF_RE.exec(value.trim())
  return m === null ? null : (m[1] ?? null)
}

// ---- envelope + crypto ------------------------------------------------------

interface SecretsEnvelope {
  version: 1
  alg: string
  iv: string
  tag: string
  data: string
}

function isEnvelope(v: unknown): v is SecretsEnvelope {
  return (
    isRecord(v) &&
    v["version"] === 1 &&
    v["alg"] === ALGORITHM &&
    typeof v["iv"] === "string" &&
    typeof v["tag"] === "string" &&
    typeof v["data"] === "string"
  )
}

/** Keep only string values (a hand-edited store may carry junk). */
function toStringMap(obj: Record<string, unknown>): SecretValues {
  const out: SecretValues = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function encrypt(values: SecretValues, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()])
  const envelope: SecretsEnvelope = {
    version: 1,
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

function decrypt(text: string, key: Buffer): SecretValues | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isEnvelope(parsed)) return null
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"))
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"))
    const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8")
    const obj: unknown = JSON.parse(plain)
    return isRecord(obj) ? toStringMap(obj) : null
  } catch {
    // Wrong key / tampered ciphertext: treat as unreadable, never throw.
    return null
  }
}

// ---- key --------------------------------------------------------------------

/** The master key from the key file, or null when absent/malformed. */
export function readSecretsKey(home: string): Buffer | null {
  try {
    const key = Buffer.from(readFileSync(secretsKeyPath(home), "utf8").trim(), "base64")
    return key.length === KEY_BYTES ? key : null
  } catch {
    return null
  }
}

function ensureSecretsKey(home: string): { key: Buffer | null; created: boolean; error?: string } {
  const existing = readSecretsKey(home)
  if (existing !== null) return { key: existing, created: false }
  const key = randomBytes(KEY_BYTES)
  const res = atomicWriteText(secretsKeyPath(home), `${key.toString("base64")}\n`)
  return res.ok ? { key, created: true } : { key: null, created: false, error: res.error }
}

// ---- load / save ------------------------------------------------------------

export interface SecretsLoadResult {
  values: SecretValues
  /** True when the store exists but holds plaintext (offer migration). */
  plaintext: boolean
  /**
   * True when the store exists but could not be read (bad JSON, missing key,
   * corrupt ciphertext). Callers MUST NOT overwrite the store in that state —
   * that would silently destroy every secret.
   */
  unavailable: boolean
  warnings: string[]
}

/** Load + decrypt the store. Missing file = empty, not an error. */
export function loadSecrets(home: string): SecretsLoadResult {
  const path = secretsPath(home)
  if (!existsSync(path)) return { values: {}, plaintext: false, unavailable: false, warnings: [] }

  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    return { values: {}, plaintext: false, unavailable: true, warnings: [`secrets: cannot read ${path} — ${errorMessage(e)}`] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  // A plain map is a legacy/hand-written store: usable now, encrypted on migrate.
  if (isRecord(parsed) && !isEnvelope(parsed)) {
    return {
      values: toStringMap(parsed),
      plaintext: true,
      unavailable: false,
      warnings: [`secrets: ${path} is stored in plaintext — run \`sensus secrets migrate\` to encrypt it (docs/config.md)`],
    }
  }
  if (!isEnvelope(parsed)) {
    return { values: {}, plaintext: false, unavailable: true, warnings: [`secrets: ${path} is not a valid secrets store — ignored`] }
  }

  const key = readSecretsKey(home)
  if (key === null) {
    return {
      values: {},
      plaintext: false,
      unavailable: true,
      warnings: [`secrets: ${path} is encrypted but ${secretsKeyPath(home)} is missing — secrets unavailable`],
    }
  }
  const values = decrypt(text, key)
  if (values === null) {
    return {
      values: {},
      plaintext: false,
      unavailable: true,
      warnings: [`secrets: cannot decrypt ${path} (wrong or corrupt key) — secrets unavailable`],
    }
  }
  return { values, plaintext: false, unavailable: false, warnings: [] }
}

export interface SecretsWriteResult {
  ok: boolean
  /** A fresh master key was generated by this write. */
  keyCreated?: boolean
  error?: string
}

/** Encrypt + write the whole store (low-level; creates the key when needed). */
export function saveSecrets(home: string, values: SecretValues): SecretsWriteResult {
  const ensured = ensureSecretsKey(home)
  if (ensured.key === null) return { ok: false, error: ensured.error ?? "could not create the secrets key" }
  const res = atomicWriteText(secretsPath(home), encrypt(values, ensured.key))
  return res.ok ? { ok: true, keyCreated: ensured.created } : { ok: false, error: res.error }
}

/** Set one secret, preserving the rest. Refuses to clobber an unreadable store. */
export function setSecret(home: string, name: string, value: string): SecretsWriteResult {
  const loaded = loadSecrets(home)
  if (loaded.unavailable) return { ok: false, error: "the secrets store is unreadable — refusing to overwrite it" }
  return saveSecrets(home, { ...loaded.values, [name]: value })
}

/** Delete one secret (missing = success). Refuses to clobber an unreadable store. */
export function deleteSecret(home: string, name: string): SecretsWriteResult {
  const loaded = loadSecrets(home)
  if (loaded.unavailable) return { ok: false, error: "the secrets store is unreadable — refusing to overwrite it" }
  if (!(name in loaded.values)) return { ok: true }
  const values = { ...loaded.values }
  delete values[name]
  return saveSecrets(home, values)
}

/** Stored secret names, sorted (never the values). */
export function listSecretNames(home: string): string[] {
  return Object.keys(loadSecrets(home).values).sort()
}

/**
 * Expand a standalone value (not a whole config document) with the same
 * precedence resolution uses: secrets store first, then the process env.
 * Used by UI actions that need the real credential for a one-off request
 * (settings "test connection") while the file keeps the `${NAME}` ref.
 */
export function resolveSecretValue(value: string, home: string, env?: NodeJS.ProcessEnv): string {
  if (!value.includes("${")) return value
  const e = env ?? (process.env as NodeJS.ProcessEnv)
  const merged = { ...e, ...loadSecrets(home).values }
  return expandEnvRefs(value, merged).value
}

// ---- capture / migration ----------------------------------------------------

/** A key that smells like a credential, for choosing which MCP values to move. */
const SECRET_KEY_HINT = /api[_-]?key|token|secret|passw|credential|bearer|auth/i
/** A value that smells like a credential regardless of its key. */
const SECRET_VALUE_HINT = /^(?:bearer\s+)?(?:sk-|xox[bap]-|ghp_|github_pat_|AIza|ya29\.|eyJ)|-----BEGIN/

function sanitizeName(parts: string[]): string {
  const s = parts
    .join("_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
  return s.length > 0 ? s : "SECRET"
}

/** A name whose value is that of `value` when the base collides with another. */
function uniqueName(values: SecretValues, base: string, value: string): string {
  let name = base
  let i = 2
  while (name in values && values[name] !== value) name = `${base}_${i++}`
  return name
}

/** Move literal secrets out of `doc` into `values` (doc is mutated). */
function extractSecrets(values: SecretValues, doc: RawConfigDoc): string[] {
  const moved: string[] = []

  const eps = doc["endpoints"]
  if (isRecord(eps)) {
    for (const [ename, epRaw] of Object.entries(eps)) {
      if (!isRecord(epRaw)) continue
      const key = epRaw["apiKey"]
      if (typeof key === "string" && key.length > 0 && !isSecretRef(key)) {
        const name = uniqueName(values, sanitizeName([ename, "API_KEY"]), key)
        values[name] = key
        epRaw["apiKey"] = `\${${name}}`
        moved.push(name)
      }
    }
  }

  const mcp = doc["mcp"]
  if (isRecord(mcp) && isRecord(mcp["servers"])) {
    for (const [sname, sRaw] of Object.entries(mcp["servers"])) {
      if (!isRecord(sRaw)) continue
      for (const field of ["env", "headers"] as const) {
        const map = sRaw[field]
        if (!isRecord(map)) continue
        for (const [k, v] of Object.entries(map)) {
          if (typeof v !== "string" || v.length === 0 || v.includes("${")) continue
          if (!SECRET_KEY_HINT.test(k) && !SECRET_VALUE_HINT.test(v)) continue
          const name = uniqueName(values, sanitizeName([sname, k]), v)
          values[name] = v
          map[k] = `\${${name}}`
          moved.push(name)
        }
      }
    }
  }

  return moved
}

export interface CaptureSecretsResult {
  /** The document with `${NAME}` refs (a clone; unchanged when nothing moved). */
  doc: RawConfigDoc
  /** Secret names created/updated by this capture. */
  moved: string[]
  error?: string
}

/**
 * Route any literal secrets in `doc` into the encrypted store and return the
 * document with `${NAME}` references. Used by every config-write path (setup
 * wizard, settings screen) so a newly typed key is never persisted in the
 * clear. A no-op when there is nothing to move.
 */
export function captureSecrets(home: string, doc: RawConfigDoc): CaptureSecretsResult {
  let next: RawConfigDoc
  try {
    next = JSON.parse(JSON.stringify(doc)) as RawConfigDoc
  } catch {
    return { doc, moved: [] }
  }
  const loaded = loadSecrets(home)
  if (loaded.unavailable) return { doc, moved: [], error: "the secrets store is unreadable — refusing to overwrite it" }
  const values: SecretValues = { ...loaded.values }
  const moved = extractSecrets(values, next)
  if (moved.length === 0) return { doc, moved: [] }
  const saved = saveSecrets(home, values)
  if (!saved.ok) return { doc, moved, error: saved.error ?? "could not write the secrets store" }
  return { doc: next, moved }
}

export interface SecretsMigrationResult {
  ok: boolean
  /** Secret names moved into the store. */
  moved: string[]
  /** config.json was rewritten with `${NAME}` refs. */
  updatedConfig: boolean
  backupCreated?: boolean
  error?: string
}

/**
 * Move every plaintext secret in `config.json` into the encrypted store and
 * rewrite the config with `${NAME}` refs. Also encrypts a plaintext store that
 * has no config-side literals to move. No-op when there is nothing to do.
 */
export function migrateConfigSecrets(home: string): SecretsMigrationResult {
  const cfgPath = `${home}/config.json`
  const doc = readRawConfig(cfgPath)
  const loaded = loadSecrets(home)
  if (loaded.unavailable) {
    return { ok: false, moved: [], updatedConfig: false, error: "the secrets store is unreadable — refusing to overwrite it" }
  }
  const values: SecretValues = { ...loaded.values }
  let next: RawConfigDoc | null = null
  let moved: string[] = []
  if (doc !== null) {
    try {
      next = JSON.parse(JSON.stringify(doc)) as RawConfigDoc
    } catch {
      next = doc
    }
    moved = extractSecrets(values, next)
  }
  if (moved.length === 0 && !loaded.plaintext) return { ok: true, moved: [], updatedConfig: false }

  const saved = saveSecrets(home, values)
  if (!saved.ok) return { ok: false, moved, updatedConfig: false, error: saved.error ?? "could not write the secrets store" }
  if (next === null || moved.length === 0) return { ok: true, moved, updatedConfig: false }

  const written = writeRawConfig(cfgPath, next)
  if (!written.ok) return { ok: false, moved, updatedConfig: false, error: written.error }
  return { ok: true, moved, updatedConfig: true, backupCreated: written.backupCreated }
}
