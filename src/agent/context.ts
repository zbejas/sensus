/**
 * Context injection (docs/agent.md "Context injection"): per user message, a
 * compact terminal context block — pane cwd, shell, current command, tail of
 * the tab's scrollback ring (suppressed while a full-screen app holds the
 * alternate screen), and git branch + dirty status (collected via the hidden
 * shell in the pane cwd).
 *
 * Cache durability: the block is emitted ONCE per generation into a durable
 * provider-history message and never re-derived or rewritten afterwards —
 * the provider's prefix cache stays valid (docs/agent.md "Prompt caching").
 *
 * Pure formatting + git parsing here; the UI layer gathers the live data.
 * Defensive contract: never throws, never returns more than maxLines of tail.
 */

import { runHiddenCommand } from "./tools.ts"
import { fnv1a } from "../core/util.ts"

/** Max context tail lines kept (docs default: 100 = config.context.scrollbackLines). */
export const DEFAULT_MAX_LINES = 100

/** Options for buildContextBlock. */
export interface ContextBlockOptions {
  /** Emit an "unchanged" note instead of repeating the tail lines (the
   * fingerprint matched what the model last saw — token saver). */
  tailUnchanged?: boolean
  /** Approval mode line ([agent] approval: …). Volatile env facts belong
   * HERE, not in the system prompt (prompt-cache invariant, docs/agent.md). */
  approval?: string
}

/** Live terminal facts gathered by the UI at send time. */
export interface TerminalSnapshot {
  /** Pane cwd (#{pane_current_path}), null when unknown. */
  cwd: string | null
  /** Login shell of the pane. */
  shell: string
  /** Foreground command (#{pane_current_command}). */
  currentCommand: string
  /** #{alternate_on}: a full-screen app owns the terminal. */
  alternateOn: boolean
  /** Plain-text scrollback tail (oldest → newest), already de-styled. */
  tailLines: string[]
}

export interface GitStatus {
  branch: string
  /** Number of changed files (porcelain entries). */
  changed: number
}

/** Collapse blank-line spam: runs of blanks -> one blank; trim the edges. */
export function trimBlankSpam(lines: readonly string[]): string[] {
  const out: string[] = []
  let blanks = 0
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "")
    if (line.trim() === "") {
      blanks++
      continue
    }
    if (out.length > 0 && blanks > 0) out.push("")
    blanks = 0
    out.push(line)
  }
  return out
}

/** Abbreviate $HOME to ~ for display (docs example: "cwd: ~/server"). */
export function abbreviateHome(p: string | null): string {
  if (!p) return "?"
  const home = process.env["HOME"]
  if (home && home.length > 1 && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`
  return p
}

/**
 * The per-message context block (docs/agent.md format). While a full-screen
 * app holds the alternate screen the tail is NEVER injected — a note replaces
 * it (docs/agent.md: "note 'user is in alt-screen app' instead").
 */
export function buildContextBlock(
  s: TerminalSnapshot,
  git: GitStatus | null,
  maxLines = DEFAULT_MAX_LINES,
  opts: ContextBlockOptions = {},
): string {
  const parts: string[] = []
  const cmd = s.currentCommand.length > 0 ? s.currentCommand : "shell"
  if (s.alternateOn) {
    parts.push(`[terminal] cwd: ${abbreviateHome(s.cwd)} · shell: ${s.shell} · user is in alt-screen app (${cmd})`)
  } else {
    parts.push(`[terminal] cwd: ${abbreviateHome(s.cwd)} · shell: ${s.shell} · cmd: ${cmd}`)
    const tail = trimBlankSpam(s.tailLines.slice(-Math.max(1, maxLines)))
    if (tail.length > 0) {
      if (opts.tailUnchanged === true) {
        parts.push(
          `[terminal] last output: unchanged (${tail.length} line${tail.length === 1 ? "" : "s"} since your last look)`,
        )
      } else {
        parts.push("[terminal] last output:")
        parts.push(...tail)
      }
    }
  }
  if (git !== null) {
    parts.push(
      git.changed > 0
        ? `[git] branch ${git.branch}, ${git.changed} changed file${git.changed === 1 ? "" : "s"}`
        : `[git] branch ${git.branch} (clean)`,
    )
  }
  if (opts.approval !== undefined) parts.push(`[agent] approval: ${opts.approval}`)
  return parts.join("\n")
}

/**
 * Collect git branch + dirty status for a directory with ONE hidden shell
 * call (keeps send latency low). Returns null when not a repo, or when git
 * is missing/too slow.
 */
export async function collectGitStatus(cwd: string, signal: AbortSignal): Promise<GitStatus | null> {
  try {
    const r = await runHiddenCommand({
      command:
        "git rev-parse --is-inside-work-tree 2>/dev/null; git rev-parse --abbrev-ref HEAD 2>/dev/null; git status --porcelain 2>/dev/null | head -200",
      cwd,
      timeoutS: 5,
      signal,
    })
    return parseGitOutput(r.output)
  } catch {
    return null
  }
}

/**
 * Parse the composite git output (pure; unit-tested):
 *   line "true"  -> inside a work tree
 *   next non-blank line -> branch (may be "HEAD" when detached)
 *   remaining non-blank lines -> porcelain entries (changed files)
 */
export function parseGitOutput(output: string): GitStatus | null {
  const lines = output.split("\n")
  const t = lines.indexOf("true")
  if (t === -1) return null
  let branch = ""
  let changed = 0
  for (let i = t + 1; i < lines.length; i++) {
    const l = (lines[i] ?? "").trim()
    if (l === "") continue
    if (branch === "" && !/^[AMDRCTU? ]/.test(l)) {
      branch = l
      continue
    }
    changed++
  }
  return { branch: branch === "" ? "HEAD" : branch, changed }
}

/**
 * Fingerprint of the (already trimmed) tail the context block is about to
 * carry. When two consecutive snapshots hash equal, the block can replace the
 * repeated lines with an "unchanged" note (token saver; docs/agent.md).
 */
export function tailFingerprint(lines: readonly string[]): string {
  return fnv1a(lines.join("\n")).toString(36)
}