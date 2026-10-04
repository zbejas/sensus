/**
 * Agent-side logger helper (docs/agent.md; mirrors `src/daemon/log.ts`).
 *
 * `getLogger()` returns the process-wide default at CALL time: a child captured
 * once at module load (`const log = getLogger().child(...)`) would freeze the
 * PRE-`configureLogger` handle (stderr) because the daemon's `serve.ts` configures
 * the file logger only inside `startDaemon`, after every agent module has been
 * imported. `componentLogger` binds the component but defers `getLogger()` to each
 * emit, so a boot-time `configureLogger` takes effect for every module.
 *
 * This lives in `agent/` (not `daemon/`) so the headless engine does not depend on
 * the daemon; it imports only `core/log.ts`.
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
