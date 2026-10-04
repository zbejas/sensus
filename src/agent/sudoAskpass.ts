/**
 * Askpass material for the sudo retry (docs/agent.md "Sudo").
 *
 * `sudo -S` reads the password from stdin, which is fragile for anything but a
 * single bare command: every extra `sudo` needs another line, the command
 * inherits the leftover pipe as its stdin (so `sudo cat` can print the next
 * password), and a command that pipes INTO sudo (`echo x | sudo tee f`) has
 * its data mistaken for a password. An askpass program avoids all of that:
 * sudo runs the helper, the helper prints the password, and the command's own
 * stdin is never touched — so every sudo in a chain authenticates and piped
 * commands keep working.
 *
 * The helper reads a 0600 secret file (one line). The file lives under
 * `$XDG_RUNTIME_DIR` / `/dev/shm` when available (RAM-backed, not the disk),
 * and is overwritten + removed as soon as the retry finishes. This transient
 * plaintext is unavoidable: sudo must receive the real password, and a SHA
 * digest is one-way (the long-lived session cache is the encrypted
 * `core/sudoVault.ts`, which is what stays in memory between commands).
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface SudoAskpass {
  /** Value for the child's `SUDO_ASKPASS` env var. */
  helperPath: string
  /** Zero the secret and remove the temp dir. Never throws. */
  cleanup(): void
}

/** RAM-backed dirs first, so the transient secret never touches a disk. */
function askpassBaseDirs(): string[] {
  const dirs: string[] = []
  const runtime = process.env["XDG_RUNTIME_DIR"]
  if (runtime !== undefined && runtime.length > 0) dirs.push(runtime)
  if (existsSync("/dev/shm")) dirs.push("/dev/shm")
  dirs.push(tmpdir())
  return dirs
}

/** Single-quote a path for /bin/sh (a pathological base dir could contain quotes). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Create a throwaway askpass helper that prints `password` on stdout. Returns
 * null when no temp dir can be created (caller falls back to `sudo -S`).
 */
export function createSudoAskpass(password: string): SudoAskpass | null {
  let dir: string | null = null
  for (const base of askpassBaseDirs()) {
    try {
      dir = mkdtempSync(join(base, "sensus-askpass-"))
      break
    } catch {
      // base unusable — try the next candidate
    }
  }
  if (dir === null) return null
  const secret = join(dir, "pw")
  const helper = join(dir, "askpass")
  try {
    writeFileSync(secret, `${password}\n`, { mode: 0o600 })
    chmodSync(secret, 0o600)
    // The helper embeds the absolute secret path (no secret in it), so it does
    // not depend on SUDO_ASKPASS/argv[0] being preserved.
    writeFileSync(helper, `#!/bin/sh\nexec /bin/cat ${shQuote(secret)}\n`, { mode: 0o700 })
    chmodSync(helper, 0o700)
    return {
      helperPath: helper,
      cleanup: () => {
        try {
          writeFileSync(secret, `${"0".repeat(password.length + 1)}\n`)
        } catch {
          // best-effort shred
        }
        try {
          rmSync(dir!, { recursive: true, force: true })
        } catch {
          // best-effort delete
        }
      },
    }
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort delete
    }
    return null
  }
}

/**
 * Session-lived askpass helper for the VISIBLE pane (docs/agent.md "Sudo").
 *
 * `shell_session` types into the user's real shell, whose env is fixed at spawn,
 * so `SUDO_ASKPASS` must point at a STABLE helper — unlike the throwaway dir
 * `createSudoAskpass` makes per hidden-shell retry. The helper carries only the
 * secret PATH; `arm(password)` writes the 0600 secret just before a `sudo -A`
 * command is typed, and it is zeroed + removed shortly after, so no plaintext
 * outlives the auth window and nothing reaches the pane's scrollback, the shell
 * history, or the model. The pane env gets the path from `helperPath()`.
 */
class SudoAskpassBroker {
  private helper: string | null = null
  private secret: string | null = null
  private initialized = false
  private disarmTimer: ReturnType<typeof setTimeout> | null = null

  /** Stable helper path for the pane env; null when no tmpfs base is usable. */
  helperPath(): string | null {
    this.ensureInitialized()
    return this.helper
  }

  /** Write the password for the next pane `sudo -A`, auto-cleared after `ms`. */
  arm(password: string, ms = 120_000): boolean {
    this.ensureInitialized()
    if (this.secret === null) return false
    try {
      writeFileSync(this.secret, `${password}\n`, { mode: 0o600 })
      chmodSync(this.secret, 0o600)
    } catch {
      return false
    }
    if (this.disarmTimer !== null) clearTimeout(this.disarmTimer)
    this.disarmTimer = setTimeout(() => this.disarm(), ms)
    // Never let the timer hold the TUI process open on exit.
    this.disarmTimer.unref?.()
    return true
  }

  /** Shred + remove the secret now (rejection, `/sudo forget`, or timeout). */
  disarm(): void {
    if (this.disarmTimer !== null) {
      clearTimeout(this.disarmTimer)
      this.disarmTimer = null
    }
    if (this.secret === null) return
    try {
      writeFileSync(this.secret, "0\n")
    } catch {
      // best-effort shred
    }
    try {
      rmSync(this.secret, { force: true })
    } catch {
      // best-effort delete
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    for (const base of askpassBaseDirs()) {
      try {
        const dir = mkdtempSync(join(base, "sensus-pane-askpass-"))
        const secret = join(dir, "pw")
        const helper = join(dir, "askpass")
        writeFileSync(helper, `#!/bin/sh\nexec /bin/cat ${shQuote(secret)}\n`, { mode: 0o700 })
        chmodSync(helper, 0o700)
        this.helper = helper
        this.secret = secret
        return
      } catch {
        // base unusable — try the next candidate
      }
    }
  }
}

/** Process-wide broker shared by the pane spawn (env) and the tool executor. */
export const sudoAskpassBroker = new SudoAskpassBroker()
