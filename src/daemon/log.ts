/**
 * Daemon-side logger helper (docs/operations.md "Structured daemon log").
 *
 * `getLogger()` returns the process-wide default at CALL time: a child captured
 * once at module load (`const log = getLogger().child(...)`) would freeze the
 * PRE-`configureLogger` handle (stderr) because `serve.ts` configures the file
 * logger only inside `startDaemon`, after every daemon module has been imported.
 * `componentLogger` binds the component but defers `getLogger()` to each emit,
 * so a boot-time `configureLogger` takes effect for every module.
 */

import { getLogger, type Logger } from "../core/log.ts"

/** A `Logger` bound to `component`, resolving the process logger lazily. */
export function componentLogger(component: string): Logger {
  const bound = (): Logger => getLogger().child({ component })
  return {
    trace: (msg, fields) => bound().trace(msg, fields),
    debug: (msg, fields) => bound().debug(msg, fields),
    info: (msg, fields) => bound().info(msg, fields),
    warn: (msg, fields) => bound().warn(msg, fields),
    error: (msg, fields) => bound().error(msg, fields),
    child: (bindings) => bound().child(bindings),
  }
}
