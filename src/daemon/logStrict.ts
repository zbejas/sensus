/**
 * Strict-mode gate for the daemon's structured-logging retrofit (docs/operations.md).
 *
 * By default a daemon catch site logs and SWALLOWS (AGENTS.md rule 10: the TUI
 * and daemon must never crash on unexpected data). When `SENSUS_LOG_STRICT=1`,
 * a small allow-listed set of sites in `ws.ts`/`chats.ts`/`settings.ts` ALSO
 * rethrows the error after logging, so a test can assert a genuine failure
 * surfaces instead of being silently absorbed. Every rethrow site documents the
 * enclosing handler that absorbs it; a site whose enclosing handler does not
 * absorb a rethrow logs at error and withholds the rethrow.
 *
 * This is a daemon-local helper on purpose: Phase 1's `src/core/log.ts` is
 * frozen and stays free of this policy knob.
 */

/** True only when `SENSUS_LOG_STRICT === "1"`. */
export function logStrictEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SENSUS_LOG_STRICT"] === "1"
}
