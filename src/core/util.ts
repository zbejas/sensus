/**
 * Tiny shared helpers used across modules (agent / ui / terminal / session).
 *
 * Every function here is pure (except `atomicWriteText`, the one sanctioned
 * file-write seam) and side-effect free, so it is safe to import from
 * anything. Rule of thumb for what belongs: a helper goes here when TWO OR
 * MORE modules need the exact same semantics — near-identical-but-drifted
 * variants (different rounding, different fallbacks) stay local on purpose,
 * because merging them would silently change one call site's behavior.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

// ---- errors -----------------------------------------------------------------

/** Human message for an unknown throw value (`catch (e)`) — never empty-ish. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---- unknown-JSON guards ------------------------------------------------------

/** True for plain objects (not null, not arrays) — the shared JSON-shape guard. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** String value of an unknown JSON field, else undefined. */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Finite number value of an unknown JSON field, else undefined. */
export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

// ---- text ---------------------------------------------------------------------

/** String → array of code points (emoji/CJK safe width math). */
export const cps = (s: string): string[] => [...s]

/**
 * Clamp a string to `max` code points with a trailing "…" when it overflows.
 * `max` is floored at 1, so `max <= 0` yields just "…" for non-empty input.
 */
export function truncateWithEllipsis(s: string, max: number): string {
  const cap = Math.max(1, max)
  const chars = cps(s)
  if (chars.length <= cap) return s
  return `${chars.slice(0, cap - 1).join("")}…`
}

/**
 * Normalize pasted text for a SINGLE-LINE field (an overlay's name / URL /
 * api-key editor or type-to-filter query): strip CR/LF. A terminal/bracketed
 * paste usually carries a trailing newline, and appending it to a value or
 * query is never what the user meant. Multi-line surfaces (the chat editor,
 * the embedded terminal) must NOT use this.
 */
export function singleLinePaste(text: string): string {
  return text.replace(/[\r\n]/g, "")
}

// ---- hashing / colors -----------------------------------------------------------

/**
 * Count non-overlapping occurrences of a literal `needle` in `haystack`.
 * An empty needle is 0 (not "every position") — callers treat "no stock phrase"
 * as no match. The shared copy used by the memory tool and the edit planner.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count++
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/** 32-bit FNV-1a of a string (fingerprint-grade only, not cryptographic). */
export function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** Clamp-rounded 0-255 channel → two hex digits. */
function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
}

/** RGB → "#rrggbb" (channels clamped to 0-255). */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

// ---- files ------------------------------------------------------------------------

export interface AtomicWriteResult {
  ok: boolean
  /** Created by THIS write (first-ever backup, `bak: true` only). */
  backupCreated?: boolean
  error?: string
}

/** Files created by `atomicWriteText` are owner-only (config.json holds plaintext
 * API keys; transcripts/sidecars hold command output). */
const PRIVATE_FILE_MODE = 0o600
/** Parent dirs created by `atomicWriteText` are owner-only. */
const PRIVATE_DIR_MODE = 0o700

/**
 * The ONE atomic file write: tmp file (`.tmp-<pid>`) + rename in the target
 * directory, parent dirs created. `bak: true` adds a one-time `.bak` backup
 * of the previous contents (config edits — a bad write must stay rollable by
 * hand; registries/caches skip it). Never throws.
 *
 * Privacy (docs/config.md): the config holds plaintext API keys, so new files
 * are created 0600 and new parent dirs 0700. An existing target (and its
 * `.bak`) is best-effort chmod'ed to 0600 as well, so a file written before
 * this policy is tightened up on the next write. Every chmod is best-effort —
 * a filesystem that rejects the mode must still not fail the write.
 */
export function atomicWriteText(path: string, text: string, opts: { bak?: boolean } = {}): AtomicWriteResult {
  try {
    const dir = dirname(path)
    if (dir.length > 0 && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
    if (dir.length > 0) {
      try {
        chmodSync(dir, PRIVATE_DIR_MODE)
      } catch {
        // best-effort: an unchangeable mode must not fail the write
      }
    }
    let backupCreated = false
    if (opts.bak === true) {
      const bak = `${path}.bak`
      if (existsSync(path) && !existsSync(bak)) {
        copyFileSync(path, bak)
        backupCreated = true
      }
      if (existsSync(bak)) {
        try {
          chmodSync(bak, PRIVATE_FILE_MODE)
        } catch {
          // best-effort
        }
      }
    }
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
    renameSync(tmp, path)
    try {
      chmodSync(path, PRIVATE_FILE_MODE)
    } catch {
      // best-effort: an existing target on a strict FS keeps its mode
    }
    return { ok: true, backupCreated }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

// ---- key events ---------------------------------------------------------------------

/**
 * opentui reports the Enter key under several names depending on how it was
 * produced (keypad mode, terminals, paste); overlays must accept them all.
 * Structural typing — works for opentui key events and test fakes alike.
 */
export function isEnterKey(key: { name: string }): boolean {
  return key.name === "return" || key.name === "enter" || key.name === "linefeed"
}

/**
 * The character a printable key event produces: opentui reports shifted
 * letters as the lowercase `name` + `shift`, so reconstruct the uppercase.
 */
export function keyChar(key: { name: string; shift?: boolean }): string {
  if (key.name === "space") return " "
  return key.shift === true && /^[a-z]$/.test(key.name) ? key.name.toUpperCase() : key.name
}

/**
 * The exact text a printable key emits, for fields that must preserve WHAT WAS
 * TYPED (a password): `sequence` carries the literal character — symbols,
 * shifted punctuation, spaces — while opentui's `name` spells punctuation out
 * ("period") or reports a special-key name, so keyChar alone silently drops
 * those. Falls back to keyChar for name-only events (tests / encodings without
 * a sequence). null = not a plain printable key.
 */
export function printableKeyText(key: {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
}): string | null {
  if (key.ctrl === true || key.meta === true) return null
  const seq = key.sequence
  if (seq !== undefined && seq.length === 1) {
    const code = seq.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) return seq
  }
  if (key.name === "space") return " "
  if (key.name.length === 1) {
    const code = key.name.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) return keyChar(key)
  }
  return null
}
