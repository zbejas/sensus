/**
 * The host's Ed25519 pairing identity. Generated once by `sensus auth init`,
 * stored at `<config>/auth/identity.json` (0600), and never leaves the host.
 * The cloud stores only the public key; every connector reconnect signs a
 * fresh nonce, so a stolen device token alone cannot authenticate.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { errorMessage, isRecord } from "../core/util.ts"
import { authIdentityPath, safeUid, writeAuthJson } from "./paths.ts"

export interface HostIdentity {
  version: 1
  publicKey: string
  privateKey: string
  fingerprint: string
  createdAt: number
}

export type IdentityResult = { ok: true; identity: HostIdentity; created: boolean } | { ok: false; error: string }

/** The exact bytes the connector signs for a cloud challenge. */
export function challengeSigningInput(nonce: string, instanceId: string): string {
  return `sensus-cloud/1\n${nonce}\n${instanceId}`
}

/** Base64 SPKI DER for an Ed25519 public key. */
export function encodePublicKey(publicKey: ReturnType<typeof createPublicKey>): string {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64")
}

/** Base64 PKCS8 DER for an Ed25519 private key. */
export function encodePrivateKey(privateKey: ReturnType<typeof createPrivateKey>): string {
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
}

/** SHA-256(SPKI) shortened to a human-comparable `abcd-efgh-ijkl-mnop`. */
export function fingerprintFromPublicKey(publicKeyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex")
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`
}

/** Generate a fresh identity value (does not write anything). */
export function generateIdentity(now: number = Date.now()): HostIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const spki = encodePublicKey(publicKey)
  return {
    version: 1,
    publicKey: spki,
    privateKey: encodePrivateKey(privateKey),
    fingerprint: fingerprintFromPublicKey(spki),
    createdAt: now,
  }
}

/** Validate an identity JSON value (shape, key parse, fingerprint match). */
export function normalizeIdentity(value: unknown): HostIdentity | null {
  if (!isRecord(value)) return null
  if (value["version"] !== 1) return null
  const publicKey = value["publicKey"]
  const privateKey = value["privateKey"]
  const fingerprint = value["fingerprint"]
  const createdAt = value["createdAt"]
  if (typeof publicKey !== "string" || publicKey.length === 0) return null
  if (typeof privateKey !== "string" || privateKey.length === 0) return null
  if (typeof fingerprint !== "string" || typeof createdAt !== "number") return null
  try {
    createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
    createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" })
  } catch {
    return null
  }
  if (fingerprintFromPublicKey(publicKey) !== fingerprint) return null
  return { version: 1, publicKey, privateKey, fingerprint, createdAt }
}

/** Read an existing identity; null when absent or invalid. */
export function readIdentity(home: string): { identity: HostIdentity | null; present: boolean; error: string | null } {
  const path = authIdentityPath(home)
  if (!existsSync(path)) return { identity: null, present: false, error: null }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    return { identity: null, present: true, error: `cannot read ${path}: ${errorMessage(e)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { identity: null, present: true, error: `invalid identity JSON at ${path}: ${errorMessage(e)}` }
  }
  const identity = normalizeIdentity(parsed)
  if (identity === null) return { identity: null, present: true, error: `invalid identity at ${path}` }
  return { identity, present: true, error: null }
}

/**
 * Load the identity or create it. A corrupt existing file is an ERROR (never
 * silently replaced): a new key would invalidate an existing cloud pairing.
 */
export function loadOrCreateIdentity(
  home: string,
  opts: { uid?: number; now?: () => number } = {},
): IdentityResult {
  const existing = readIdentity(home)
  if (existing.error !== null) return { ok: false, error: existing.error }
  if (existing.identity !== null) return { ok: true, identity: existing.identity, created: false }
  if ((opts.uid ?? safeUid()) === 0) {
    return { ok: false, error: "refusing to create the host identity as root (run as the Sensus user)" }
  }
  const identity = generateIdentity((opts.now ?? Date.now)())
  const res = writeAuthJson(authIdentityPath(home), identity)
  if (!res.ok) return { ok: false, error: res.error ?? "cannot write the host identity" }
  return { ok: true, identity, created: true }
}

/** Write an identity value (0600, atomic); used by tests and repair flows. */
export function writeIdentity(home: string, identity: HostIdentity, opts: { uid?: number } = {}): { ok: boolean; error?: string } {
  if ((opts.uid ?? safeUid()) === 0) return { ok: false, error: "refusing to write the host identity as root" }
  if (normalizeIdentity(identity) === null) return { ok: false, error: "invalid identity" }
  const res = writeAuthJson(authIdentityPath(home), identity)
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "cannot write the host identity" }
}

/** Sign a cloud tunnel challenge with the private key; returns base64 Ed25519. */
export function signChallenge(identity: HostIdentity, nonce: string, instanceId: string): string {
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  })
  return sign(null, Buffer.from(challengeSigningInput(nonce, instanceId), "utf8"), key).toString("base64")
}

/** Verify a challenge signature; used by the connector tests and repair flows. */
export function verifyChallenge(
  publicKeyBase64: string,
  nonce: string,
  instanceId: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" })
    return verify(
      null,
      Buffer.from(challengeSigningInput(nonce, instanceId), "utf8"),
      key,
      Buffer.from(signatureBase64, "base64"),
    )
  } catch {
    return false
  }
}
