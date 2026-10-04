/**
 * Pane shell launcher (docs/terminal-layer.md "Controlling terminal").
 *
 * The pane's PTY is created by `Bun.Terminal` and the child is spawned with
 * `detached: true`, which makes Bun call `setsid()`. That makes the child a
 * session leader, but nothing makes the new PTY the session's CONTROLLING
 * terminal (Bun never calls `TIOCSCTTY`). bash claims it while starting; zsh
 * and fish do not, so in a zsh pane `open("/dev/tty")` fails with ENXIO and
 * every program that reads the terminal directly — `sudo`, `ssh`, `gpg` —
 * reports "a terminal is required to read the password".
 *
 * Spawning the real shell through `bash -c 'exec "$0" "$@"' <shell>` lets bash
 * claim the tty first, then the SAME pid becomes the requested shell (no extra
 * process, no changed argv). bash is already a hard dependency (the hidden
 * shell runs `bash -lc`), so this adds nothing new. A pane whose shell is bash
 * spawns directly because bash attaches the tty itself.
 *
 * `extraArgs` are handed to the REAL shell (shell-integration flags such as
 * bash's `--rcfile`); they ride after `$0` in the exec form, so the wrapper
 * bash never sees them.
 */

import { existsSync } from "node:fs"
import { shellBasename } from "./shellIntegration.ts"

/** argv for `Bun.spawn` that guarantees the PTY is the controlling terminal. */
export function shellLaunchArgv(shell: string, extraArgs: readonly string[] = []): string[] {
  if (shellBasename(shell) !== "bash" && existsSync("/bin/bash")) {
    return ["/bin/bash", "-c", 'exec "$0" "$@"', shell, ...extraArgs]
  }
  return [shell, ...extraArgs]
}
