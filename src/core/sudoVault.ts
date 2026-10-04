/**
 * RAM-only vault for the session sudo password (docs/agent.md "Sudo").
 *
 * Hashing is impossible here: the password must be RECOVERED to feed
 * `sudo -S` on a retry, and a SHA digest is one-way. So the password is kept
 * encrypted at rest IN MEMORY, not in plain text: a random 256-bit key and
 * IV are generated once per vault and never leave the process, the ciphertext
 * is AES-256-GCM, and clearing zero-fills every buffer.
 *
 * This is defense-in-depth, not secrecy from someone who can read this
 * process's memory (the key necessarily lives alongside the ciphertext —
 * something must be able to decrypt without user input at use time). What it
 * DOES guarantee: the long-lived cache is never a plaintext string, it is
 * never written to disk, never reaches the transcript, and never reaches the
 * model. `get()` is the only place a transient plaintext string is produced.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12

export class SudoVault {
  private key: Buffer | null = null
  private iv: Buffer | null = null
  private tag: Buffer | null = null
  private data: Buffer | null = null

  /** Encrypt + store a password, replacing any previous one. */
  set(password: string): void {
    this.clear()
    const key = randomBytes(KEY_BYTES)
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()])
    this.key = key
    this.iv = iv
    this.tag = cipher.getAuthTag()
    this.data = data
  }

  /** Decrypt to a transient plaintext string, or null when empty/corrupt. */
  get(): string | null {
    if (this.key === null || this.iv === null || this.tag === null || this.data === null) return null
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, this.iv)
      decipher.setAuthTag(this.tag)
      return Buffer.concat([decipher.update(this.data), decipher.final()]).toString("utf8")
    } catch {
      // A corrupt vault must never throw into the tool loop; treat as empty.
      this.clear()
      return null
    }
  }

  /** True when a password is stored (no decryption). */
  has(): boolean {
    return this.data !== null
  }

  /** Zero every buffer and drop the references. */
  clear(): void {
    this.key?.fill(0)
    this.iv?.fill(0)
    this.tag?.fill(0)
    this.data?.fill(0)
    this.key = null
    this.iv = null
    this.tag = null
    this.data = null
  }
}
