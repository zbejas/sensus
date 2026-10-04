// ---- sudo detection / retry ---------------------------------------------------

const SUDO_FAIL_RE =
  /sudo: a password is required|sudo: no password was provided|sudo: a terminal is required|\[sudo\] password for|sudo: timed out reading password|sudo: \d+ incorrect password attempt|Sorry, try again\./i

/**
 * A `sudo` that is actually being INVOKED — at a command boundary, optionally
 * behind leading `VAR=value` assignments and the common wrappers the model
 * reaches for (`env`, `command`, `nohup`, `setsid`, `nice`, `ionice`,
 * `timeout <dur>`, `stdbuf <flags>`). The boundary covers the shell operators
 * that can precede a command: `;`, `&`, `|`, `(`, `{`, a command substitution
 * backtick, and a newline (`then`/`do` keywords too), so a sudo in ANY
 * position is detected — `ls …; sudo …`, `sudo a | sudo b`, `x && sudo y`,
 * `$( sudo z )`, `if …; then sudo z; fi`. `echo sudo` / `grep sudo` stay false:
 * an argument is not an invocation. Missing the wrapped shapes
 * (e.g. `DEBIAN_FRONTEND=noninteractive sudo apt-get …`) skipped the password
 * popup entirely, so the model just retried the failing command.
 */
const SUDO_CMD_RE =
  /(?:^|[;&|({`\n]\s*|\bthen\s+|\bdo\s+)(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;|&()]*)\s+)*(?:(?:env|command|nohup|setsid|nice|ionice)\s+(?:-[^\s]+\s+|[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*|timeout\s+(?:-[^\s]+\s+)*[^\s]+\s+|stdbuf\s+(?:-[^\s]+\s+)+)*sudo\b/

/** Does the command itself invoke sudo? (Only then can a retry help.) */
export function commandUsesSudo(command: string): boolean {
  return SUDO_CMD_RE.test(command)
}

/**
 * Did a shell_background command fail because sudo needs a password (the
 * hidden shell has no tty, so password prompts always fail)? The exit code
 * is not reliable across sudo builds — the output patterns are the signal.
 */
export function isSudoPasswordFailure(output: string): boolean {
  return SUDO_FAIL_RE.test(output)
}

/**
 * Did sudo actually TEST and reject a password? Distinct from "a password is
 * required": a non-interactive (`-n`) sudo, a nested/unrewritten sudo, or a
 * missing askpass all fail without ever trying the password. Only a real
 * rejection should drop the cached vault.
 */
export function isSudoPasswordRejection(output: string): boolean {
  return /sudo: \d+ incorrect password attempt|Sorry, try again\./i.test(output)
}

/**
 * Does any sudo invocation pass `-n`/`--non-interactive` as its first option?
 * Such a sudo explicitly forbids prompting, so a popup/retry is wrong (and
 * would otherwise look like a failed password). Checking only the first token
 * after `sudo` avoids false positives from command args like `grep -n`.
 */
export function commandHasNonInteractiveSudo(command: string): boolean {
  return countNonInteractiveSudo(command).nonInteractive > 0
}

/**
 * True only when EVERY sudo invocation is `-n`/`--non-interactive` — nothing in
 * the line can be rescued, so skip the popup/retry. A MIXED compound
 * (`sudo -n true; sudo whoami`) must still be retried: the `-n` call fails by
 * design, but the plain call is rescued. Treating any `-n` as "skip the whole
 * line" was the trap that left a later plain sudo unrescued.
 */
export function commandAllSudoNonInteractive(command: string): boolean {
  const n = countNonInteractiveSudo(command)
  return n.total > 0 && n.nonInteractive === n.total
}

/** `{ total, nonInteractive }` sudo invocations (first-option detection). */
function countNonInteractiveSudo(command: string): { total: number; nonInteractive: number } {
  const re = new RegExp(SUDO_CMD_RE.source, `${SUDO_CMD_RE.flags}g`)
  let total = 0
  let nonInteractive = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    total++
    const after = command.slice(m.index + m[0].length).replace(/^\s+/, "")
    const first = after.split(/[\s;&|()]/, 1)[0] ?? ""
    if (first === "--non-interactive") nonInteractive++
    else if (/^-[A-Za-z]+$/.test(first) && first.slice(1).includes("n")) nonInteractive++
    re.lastIndex = m.index + m[0].length
  }
  return { total, nonInteractive }
}

/**
 * Rewrite EVERY sudo invocation so it reads the password from stdin:
 * `sudo …` → `sudo -S -p '' …`. Rewriting only the first left commands like
 * `sudo -k true && sudo whoami` failing on the second sudo (the tty-less
 * hidden shell has no shared timestamp for `-p`/setsid), which then surfaced
 * as a bogus "password rejected". Pure string transform (unit-tested);
 * callers feed one password line per invocation and feed them via the
 * runner's stdinData.
 */
/**
 * Rewrite EVERY sudo invocation, replacing the `sudo` word with `replacement`
 * (which must end in a space or carry its own separator). Pure.
 */
function rewriteSudo(command: string, replacement: string): string {
  const re = new RegExp(SUDO_CMD_RE.source, `${SUDO_CMD_RE.flags}g`)
  let out = ""
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    // m[0] ends at the `sudo` word (the `\b` after it), so its start is the
    // end of the match minus the four chars of "sudo".
    const at = m.index + m[0].length - 4
    // The replacement supplies its own separating space; swallow one original
    // space so `sudo id` does not become `sudo -S -p ''  id`.
    const after = command[at + 4] === " " ? at + 5 : at + 4
    out += command.slice(cursor, at) + replacement
    cursor = after
    re.lastIndex = after
  }
  return out + command.slice(cursor)
}

/**
 * Rewrite EVERY sudo invocation so it reads the password from stdin:
 * `sudo …` → `sudo -S -p '' …`. Fallback for when askpass material cannot be
 * created; callers feed one password line per invocation.
 */
export function commandWithSudoStdin(command: string): string {
  return rewriteSudo(command, "sudo -S -p '' ")
}

/**
 * Rewrite EVERY sudo invocation to use the askpass program (`sudo -A`), which
 * never touches the command's stdin — the preferred retry path (piped sudo and
 * multi-sudo chains both work, and no password can leak to the command).
 */
export function commandWithSudoAskpass(command: string): string {
  return rewriteSudo(command, "sudo -A ")
}

/**
 * How many sudo invocations a command has — the number of password lines the
 * retry must stage on stdin (one per `-S` reader). Uses the same detection as
 * the rewrite so the two cannot drift.
 */
export function countSudoInvocations(command: string): number {
  const re = new RegExp(SUDO_CMD_RE.source, `${SUDO_CMD_RE.flags}g`)
  let n = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    n++
    re.lastIndex = m.index + m[0].length
  }
  return n
}
