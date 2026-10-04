/**
 * Shell integration: make the pane shell report its working directory.
 *
 * The status bar's `cwd` chip and the agent's terminal-context block read the
 * cwd from OSC 7 (`StreamScanner.cwd`, docs/terminal-layer.md "Status &
 * facts"). zsh and bash do not emit OSC 7 on their own, so before this module
 * the chip only ever showed the spawn directory and never followed `cd`. sensus
 * now launches those shells with a generated startup file that runs the user's
 * normal rc and then reports `$PWD` via OSC 7 before every prompt.
 *
 * How each shell is redirected, without touching the user's dotfiles:
 *   - zsh: `ZDOTDIR` points at a generated dir whose `.zshenv`/`.zshrc` source
 *     the user's files, then append a `precmd` hook. `ZDOTDIR` stays ours so a
 *     pane `exec zsh` keeps the integration.
 *   - bash: `--rcfile <generated>` reproduces bash's normal interactive rc
 *     chain (bash's `--rcfile` replaces BOTH the system and user rc) and then
 *     prepends a `PROMPT_COMMAND` reporter.
 *   - fish: reports OSC 7 natively (fish ≥ 3.5, unconditional since 4.0), so it
 *     is left untouched.
 *   - anything else (sh/dash/…): no injection; the spawn-cwd fallback stands.
 *
 * The generated dir is a single `mkdtemp` per process (shared by every tab)
 * and is removed best-effort on exit. Files are only written for the zsh/bash
 * families; the pure planners below are what tests exercise.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type ShellFamily = "zsh" | "bash" | "fish" | "posix"

/** Extra argv appended to the real shell, and env merged into the spawn env. */
export interface ShellIntegration {
  args: string[]
  env: Record<string, string>
}

const ZSHENV_FILE = ".zshenv"
const ZSHRC_FILE = ".zshrc"
const BASHRC_FILE = "bashrc"

/** Last path segment (shell paths are simple; avoids importing node:path). */
export function shellBasename(shell: string): string {
  const i = shell.lastIndexOf("/")
  return i >= 0 ? shell.slice(i + 1) : shell
}

/** Map a shell executable path to the family whose integration we install. */
export function shellFamily(shell: string): ShellFamily {
  const base = shellBasename(shell)
  if (base === "zsh") return "zsh"
  if (base === "bash") return "bash"
  if (base === "fish") return "fish"
  return "posix"
}

/**
 * zsh `.zshenv`: run the user's environment setup, then hand the `.zshrc` lookup
 * back to our generated dir. `SENSUS_USER_ZDOTDIR` carries the user's original
 * `ZDOTDIR` (else `$HOME`); a `.zshenv` that relocates `ZDOTDIR` updates it so
 * the later `.zshrc` source still finds the user's file.
 */
export function zshEnvFile(): string {
  return [
    "# sensus shell integration (generated): keep the user's zsh environment.",
    'if [ -n "${SENSUS_USER_ZDOTDIR:-}" ] && [ -f "${SENSUS_USER_ZDOTDIR}/.zshenv" ]; then',
    '  . "${SENSUS_USER_ZDOTDIR}/.zshenv"',
    "fi",
    "# The user's .zshenv may relocate ZDOTDIR; honor it for their rc lookup, then",
    "# force ours so zsh reads the integration rc next (and after a pane `exec zsh`).",
    'if [ -n "${ZDOTDIR:-}" ] && [ "${ZDOTDIR}" != "${SENSUS_ZDOTDIR}" ]; then',
    '  SENSUS_USER_ZDOTDIR="${ZDOTDIR}"',
    "fi",
    'ZDOTDIR="${SENSUS_ZDOTDIR}"',
    "",
  ].join("\n")
}

/**
 * zsh `.zshrc`: source the user's rc, then report `$PWD` via OSC 7 before every
 * prompt and fill in the Ctrl+Left/Right word-skip bindings zsh does not ship
 * (bash readline and fish bind the xterm sequences natively, so a vanilla zsh
 * prompt ignored them). BEL-terminated OSC 7 so neither shell nor `printf`
 * escaping can mangle it.
 */
export function zshRcFile(): string {
  return [
    "# sensus shell integration (generated): source the user's rc, report cwd.",
    'if [ -n "${SENSUS_USER_ZDOTDIR:-}" ] && [ -f "${SENSUS_USER_ZDOTDIR}/.zshrc" ]; then',
    '  . "${SENSUS_USER_ZDOTDIR}/.zshrc"',
    "fi",
    "",
    "_sensus_report_cwd() {",
    "  printf '\\033]7;file://%s%s\\a' \"${HOST:-localhost}\" \"${PWD}\"",
    "}",
    'if [ -z "${_sensus_cwd_hook:-}" ]; then',
    "  typeset -ga precmd_functions",
    "  precmd_functions+=(_sensus_report_cwd)",
    "  _sensus_cwd_hook=1",
    "fi",
    "_sensus_report_cwd",
    "",
    "# zsh does not bind the xterm Ctrl+Left/Right sequences by default, so the",
    "# keys did nothing at the prompt. Fill them in only when the user's rc left",
    "# the sequence unbound; an explicit binding always wins.",
    "if [[ \"$(bindkey '^[[1;5D')\" == *undefined-key* ]]; then bindkey '^[[1;5D' backward-word; fi",
    "if [[ \"$(bindkey '^[[1;5C')\" == *undefined-key* ]]; then bindkey '^[[1;5C' forward-word; fi",
    "",
  ].join("\n")
}

/**
 * bash rc (`--rcfile`): bash's `--rcfile` replaces both the system-wide and the
 * user rc, so replay the normal chain first, then prepend a `PROMPT_COMMAND`
 * reporter (guarding against double-install if the file is re-sourced).
 */
export function bashRcFile(): string {
  return [
    "# sensus shell integration (generated): replay the normal interactive rc,",
    "# then report cwd. `bash --rcfile` replaces BOTH the system and user rc.",
    "if [ -f /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi",
    "if [ -f /etc/bashrc ]; then . /etc/bashrc; fi",
    'if [ -n "${HOME:-}" ] && [ -f "${HOME}/.bashrc" ]; then . "${HOME}/.bashrc"; fi',
    "",
    "_sensus_report_cwd() {",
    "  printf '\\033]7;file://%s%s\\a' \"${HOSTNAME:-localhost}\" \"${PWD}\"",
    "}",
    'case ";${PROMPT_COMMAND:-};" in',
    '  *";_sensus_report_cwd;"*) ;;',
    '  *) PROMPT_COMMAND="_sensus_report_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
    "esac",
    "_sensus_report_cwd",
    "",
  ].join("\n")
}

/** The files a family needs in the integration dir (empty when it needs none). */
export function integrationFiles(family: ShellFamily): Array<{ name: string; content: string }> {
  if (family === "zsh") {
    return [
      { name: ZSHENV_FILE, content: zshEnvFile() },
      { name: ZSHRC_FILE, content: zshRcFile() },
    ]
  }
  if (family === "bash") return [{ name: BASHRC_FILE, content: bashRcFile() }]
  return []
}

/** Write every integration file into `dir`. Returns false if any write failed. */
export function writeIntegrationFiles(dir: string): boolean {
  let ok = true
  for (const family of ["zsh", "bash"] as const) {
    for (const file of integrationFiles(family)) {
      try {
        writeFileSync(join(dir, file.name), file.content, { mode: 0o600 })
      } catch {
        ok = false
      }
    }
  }
  return ok
}

/**
 * Pure launch plan for a shell: the extra argv + env that turn on OSC 7 cwd
 * reporting. `dir` is the generated integration dir; `userZdotdir` is the
 * user's original `ZDOTDIR` (else `$HOME`) for zsh.
 */
export function shellIntegrationPlan(shell: string, dir: string, userZdotdir: string): ShellIntegration {
  switch (shellFamily(shell)) {
    case "zsh":
      return {
        args: [],
        env: { SENSUS_ZDOTDIR: dir, SENSUS_USER_ZDOTDIR: userZdotdir, ZDOTDIR: dir },
      }
    case "bash":
      return { args: ["--rcfile", join(dir, BASHRC_FILE)], env: {} }
    default:
      // fish reports natively; others keep the spawn-cwd fallback.
      return { args: [], env: {} }
  }
}

/** The user's original zsh `ZDOTDIR`, else `$HOME` (empty when neither is set). */
function userZdotdir(): string {
  const zdot = process.env["ZDOTDIR"]
  if (zdot !== undefined && zdot.length > 0) return zdot
  return process.env["HOME"] ?? ""
}

let cachedDir: string | null = null

/** Create (once per process) the generated integration dir with all files. */
function integrationDir(): string | null {
  if (cachedDir !== null && existsSync(cachedDir)) return cachedDir
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), "sensus-shell-"))
  } catch {
    return null
  }
  // A dir we cannot populate is worse than none: pointing ZDOTDIR/--rcfile at
  // it would drop the user's rc. Discard it and fall back to no integration.
  if (!writeIntegrationFiles(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
    return null
  }
  cachedDir = dir
  return dir
}

/**
 * Resolve the integration plan for `shell`, materializing the generated dir on
 * first use. Returns an empty plan when the dir cannot be created — the pane
 * still works, the cwd chip just falls back to the spawn directory.
 */
export function prepareShellIntegration(shell: string): ShellIntegration {
  const dir = integrationDir()
  if (dir === null) return { args: [], env: {} }
  const plan = shellIntegrationPlan(shell, dir, userZdotdir())
  // The generated dir must survive a pane `exec zsh` (ZDOTDIR still points at
  // it), so only remove it when the process exits.
  registerCleanup()
  return plan
}

let cleanupRegistered = false
function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  try {
    process.once("exit", cleanupShellIntegration)
  } catch {
    // No exit hook available: the tiny temp dir is left to the OS.
  }
}

/** Remove the generated dir (best-effort). Exposed for the process exit hook. */
export function cleanupShellIntegration(): void {
  const dir = cachedDir
  cachedDir = null
  if (dir === null) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // already gone
  }
}
