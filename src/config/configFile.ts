/**
 * Config-file mutation helpers (the settings screen). The resolver in
 * config.ts is read-only; this module owns WRITES to the real file:
 *
 * - unknown keys are preserved (edits patch the parsed document, never a
 *   re-serialization of the resolved config),
 * - writes are atomic (tmp file + rename in the same directory),
 * - the FIRST write creates a one-time `<file>.bak` backup of the current
 *   contents, so a bad edit can always be rolled back by hand,
 * - never throws: every function returns a result object (the TUI must not
 *   crash on disk errors — AGENTS.md convention).
 *
 * Paths are taken explicitly (callers use configPath() which honors
 * SENSUS_HOME) so unit tests never need to mutate process.env.
 */

import { readFileSync } from "node:fs"
import { atomicWriteText, errorMessage, isRecord, type AtomicWriteResult } from "../core/util.ts"

export interface RawConfigDoc {
  [key: string]: unknown
}

export interface ConfigWriteResult {
  ok: boolean
  /** Created by THIS write (first-ever backup). */
  backupCreated?: boolean
  error?: string
}

/** Read the raw JSON document; null when missing/unparseable (caller decides
 * what to bootstrap). Never throws. */
export function readRawConfig(path: string): RawConfigDoc | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? (parsed as RawConfigDoc) : null
  } catch {
    return null
  }
}

/**
 * Atomically write the document (util.atomicWriteText: tmp+rename, one-time
 * `.bak` backup of the previous contents, parent dirs created).
 */
export function writeRawConfig(path: string, doc: RawConfigDoc): ConfigWriteResult {
  const res: AtomicWriteResult = atomicWriteText(path, `${JSON.stringify(doc, null, 2)}\n`, { bak: true })
  return res.ok ? { ok: true, backupCreated: res.backupCreated } : { ok: false, error: res.error }
}

/**
 * Read → mutate → atomically write. The mutator receives the parsed document
 * (or `{}` when the file is missing/unparseable) and returns the new document
 * — returning the SAME object is fine; unknown keys are whatever the mutator
 * left in place.
 */
export function updateRawConfig(
  path: string,
  mutate: (doc: RawConfigDoc) => RawConfigDoc,
): ConfigWriteResult & { doc: RawConfigDoc } {
  const current = readRawConfig(path) ?? {}
  let next: RawConfigDoc
  try {
    next = mutate(current)
  } catch (e) {
    return { ok: false, error: errorMessage(e), doc: current }
  }
  const res = writeRawConfig(path, next)
  return { ...res, doc: next }
}
