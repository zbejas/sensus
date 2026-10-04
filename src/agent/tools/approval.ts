import type { PermissionRule } from "../../config/config.ts"
import type { ApprovalDecision } from "./types.ts"
import { suggestAllowPrefix } from "./summary.ts"

// ---- Approval classification -------------------------------------------------

/**
 * Root-level paths whose recursive deletion/move/perm-change is catastrophic.
 * `/tmp` is deliberately NOT here: `rm -rf /tmp/sandbox` is a normal cleanup
 * and must stay un-gated.
 */
const CRITICAL_DIR = String.raw`(?:etc|usr|var|bin|sbin|lib|lib64|boot|root|home|opt|srv|sys|proc|dev|run)`

/**
 * A genuinely catastrophic operand: `/`, `$HOME`/`${HOME}`, `~`, a bare glob,
 * `.`/`..`, or a critical system/home root (optionally with a subpath/glob).
 * Kept as a source string so the per-tool regexes share one definition.
 */
const CATASTROPHIC = String.raw`(?:\$(?:\{)?HOME(?:\})?|~\/?(?:\*)?(?=\s|$)|/(?=\s|$)|\.{1,2}(?=\s|$)|\.?\/?\*(?=\s|$)|/${CRITICAL_DIR}(?:\/\*)?(?=\s|$))`

/** `mv`'s (narrower) operand: the home dir itself, `/`, a critical root, or a bare glob. */
const MV_CATASTROPHIC = String.raw`(?:~\/?(?:\*)?(?=\s|$)|/(?=\s|$)|/${CRITICAL_DIR}(?:\/\*)?(?=\s|$)|\.?\/?\*(?=\s|$))`

/**
 * The catastrophic classes (needs explicit user text approval even in
 * full-auto). Broader than the old `rm … /`-only check but still narrow: a
 * normal `rm -rf /tmp/sandbox`, `rm -rf ./build` or `chmod 755 x` is NOT
 * destructive. Each pattern is anchored to a real command word so prose in a
 * command line cannot trip it.
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // rm with a recursive/force flag and a catastrophic target.
  new RegExp(
    String.raw`\brm\s+(?:-{1,2}[a-zA-Z-]+\s+)*-{1,2}[a-zA-Z]*[rf][a-zA-Z]*\s+(?:-{1,2}[a-zA-Z-]+\s+)*${CATASTROPHIC}`,
  ),
  // find <root> … -delete / -exec rm
  new RegExp(String.raw`\bfind\s+[^\n;&|]*?${MV_CATASTROPHIC}[^\n;&|]*?(?:-delete\b|-exec\s+rm\b)`),
  // recursive chmod/chown/chgrp on a catastrophic root
  new RegExp(String.raw`\bch(?:mod|own|grp)\s+(?=[^\n;&|]*-[a-zA-Z]*R)[^\n;&|]*?\s${CATASTROPHIC}`),
  // mv with a catastrophic source or destination
  new RegExp(String.raw`\bmv\s+[^\n;&|]*?${MV_CATASTROPHIC}`),
  // secure-delete / filesystem-wipe tools
  /\b(?:shred|wipefs)\b/,
  // filesystem format
  /\bmkfs(\.\w+)?\b/,
  // raw device write via dd (`of=/dev/null` is harmless and must not gate)
  /\bdd\b[^\n]*\bof=\/dev\/(?!null\b)/,
  // fork bomb (no leading \b: `:` is a non-word char, so `\b:` never matches at
  // the start of a command line)
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  // power state
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  // shell redirect truncating a block device
  />{1,2}\s*\/dev\/(?:sd[a-z]|nvme|mmcblk|hd[a-z]|vd[a-z]|xvd[a-z]|disk)/,
]

/**
 * Destructive "rm -rf /"-class command (docs/agent.md rules): needs explicit
 * user text approval even in full-auto.
 */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command))
}

// ---- Session-scoped pattern trust --------------------------------------------

/**
 * A session-only, user-granted trust pattern: the OPERATION CLASS of a shell
 * call (an arity-aware command prefix), not the literal string. `tool` is the
 * gated tool (`shell_background` / `shell_session`); `prefix` is the trailing
 * space form from `suggestAllowPrefix` (`git status `). Trust dies with the
 * process — nothing is persisted (locked decision 6).
 */
export interface TrustPattern {
  tool: string
  prefix: string
}

/**
 * Command classes that must NEVER be offered session trust, even when they are
 * not caught by the (narrow) catastrophic floor above. Trusting a broad prefix
 * for one of these would let a single "don't ask again" wave through an
 * irreversible operation (`rm` anywhere, `chmod -R`, `git reset --hard`,
 * `docker rm`, …). Over-matching is safe: an exempt command simply keeps its
 * per-call card. Each pattern anchors to real command words so prose in a
 * command line cannot trip it.
 */
const TRUST_EXEMPT_PATTERNS: readonly RegExp[] = [
  // Deletion / filesystem destruction.
  /\brm\b/,
  /\brmdir\b/,
  /\b(?:shred|wipefs|fdisk|parted|sgdisk|sfdisk|mkswap|swapoff)\b/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\b/,
  /\bmv\b/,
  /\bch(?:mod|own|grp)\b/,
  /\btruncate\b/,
  // Power state.
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  // Service state changes (read-only `systemctl status` stays trustable).
  /\bsystemctl\s+(?:start|stop|restart|reload|reload-or-restart|try-restart|enable|disable|mask|unmask|kill|set-default|reset-failed|daemon-reload|poweroff|reboot|suspend|hibernate)\b/,
  // Privilege escalation / arbitrary shell execution. `eval`/`exec` only as
  // the command word (not a subcommand like `pct exec …`).
  /\bsudo\b/,
  /(?:^|[;&|])\s*(?:eval|exec)\b/,
  /\b(?:ba|z|k|da)?sh\s+-c\b/,
  // Git history / worktree destruction.
  /\bgit\s+(?:reset|clean|restore|rebase|checkout)\b/,
  /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+stash\s+(?:drop|clear)\b/,
  // Container / orchestration teardown.
  /\b(?:docker|podman)\s+(?:rm|rmi|system|volume|network|container|image)\b/,
  /\b(?:docker|podman)\s+compose\s+down\b/,
  /\bkubectl\s+delete\b/,
  /\bhelm\s+uninstall\b/,
  /\bterraform\s+destroy\b/,
  /\b(?:pct|qm)\s+(?:destroy|stop|reset|del)\b/,
  // Process kills.
  /\b(?:pkill|killall|kill)\b/,
]

/**
 * Is this command class exempt from session trust? True for the catastrophic
 * floor AND the broader irreversible set above. Exempt commands still get their
 * normal card (and full-auto still gates only the true floor) — they just never
 * carry the "don't ask again" affordance. Pure.
 */
export function isTrustExempt(command: string): boolean {
  if (isDestructiveCommand(command)) return true
  return TRUST_EXEMPT_PATTERNS.some((re) => re.test(command))
}

/**
 * The session trust pattern a gated card may offer, or null when none applies
 * (docs/agent.md "Approval modes"). Trust is only offered for shell tools with
 * a meaningful command class, never for an exempt/destructive command, and
 * never for a compound command (`&&`/`|`/`;`/…): its "operation class" is
 * ambiguous, so the whole line keeps its per-call card. Pure.
 */
export function trustPatternFor(name: string, args: Record<string, unknown>): TrustPattern | null {
  const target =
    name === "shell_background" ? String(args["command"] ?? "") : name === "shell_session" ? String(args["text"] ?? "") : ""
  if (target.trim().length === 0) return null
  if (isTrustExempt(target)) return null
  // A compound line's class can't be captured by a prefix safely.
  if (/&&|\|\||[;|`]|\$\(|\n/.test(target)) return null
  const prefix = suggestAllowPrefix(target)
  return prefix.length > 0 ? { tool: name, prefix } : null
}

/**
 * Compact status-bar label for the trusted patterns ("names it"): a single
 * pattern is named outright (`git status*`); several collapse to
 * `<first>, +N` so the row stays bounded. Pure — unit-tested.
 */
export function trustChipLabel(patterns: readonly TrustPattern[]): string {
  const names = patterns.map((p) => `${p.prefix.trim()}*`)
  if (names.length <= 2) return names.join(", ")
  return `${names[0]}, +${names.length - 1}`
}

/**
 * Glob matcher for `permission` patterns (docs/config.md "permission"): `*`
 * matches any run (including empty), `?` matches exactly one character.
 * Everything else is literal; the match is anchored (whole value). Pure.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let re = "^"
  for (const ch of pattern) {
    if (ch === "*") re += ".*"
    else if (ch === "?") re += "."
    else if (/[\\^$.*+?()[\]{}|]/.test(ch)) re += `\\${ch}`
    else re += ch
  }
  re += "$"
  try {
    return new RegExp(re).test(value)
  } catch {
    return false
  }
}

/** The value a `permission` rule's `pattern` is matched against, if any. */
function permissionTarget(name: string, args: Record<string, unknown>): string | null {
  if (name === "shell_background") return String(args["command"] ?? "")
  if (name === "shell_session") return String(args["text"] ?? "")
  if (name === "edit_file" || name === "write_file" || name === "read_file" || name === "view_image") {
    return String(args["path"] ?? "")
  }
  return null
}

/** Does one rule match this call? Absent pattern = any (for a patternless tool). */
function permissionRuleMatches(rule: PermissionRule, name: string, target: string | null): boolean {
  if (rule.tool !== "*" && rule.tool !== name) return false
  if (rule.pattern === undefined) return true
  return target !== null && matchGlob(rule.pattern, target)
}

/** `shell_session` `keys` spellings that submit the current input line. A
 * modifier-free Enter only; `shift+enter`/`alt+enter` and friends do NOT submit
 * a normal shell line. */
const SHELL_SESSION_SUBMIT_KEYS: ReadonlySet<string> = new Set(["enter", "return"])

/** Does a `keys` entry name a plain submit key? Ignores case and any `+`/`-`
 * modifier prefix (only a bare `enter`/`return` submits). */
function isSubmitKey(raw: string): boolean {
  const s = raw.trim().toLowerCase().replace(/\+/g, "-")
  return SHELL_SESSION_SUBMIT_KEYS.has(s)
}

/**
 * True when a `shell_session` call would SUBMIT the current input line (press
 * Enter) — the moment a typed command actually executes in the user's visible
 * pane. True when `enter:true`, when `keys` contains a plain Enter/Return, or
 * when the literal `text` itself contains a newline (a pasted multi-line block
 * runs its last line). A call that merely types text or presses non-submit keys
 * is NOT a submission: it auto-runs in `confirm` mode so the user watches the
 * keystrokes land (docs/agent.md "Approval modes"). Pure.
 */
export function shellSessionSubmits(args: Record<string, unknown>): boolean {
  if (args["enter"] === true) return true
  const rawKeys = args["keys"]
  if (Array.isArray(rawKeys) && rawKeys.some((k) => isSubmitKey(String(k)))) return true
  return /[\r\n]/.test(String(args["text"] ?? ""))
}

/** The command line a `shell_session` submission would run (its typed text with
 * trailing newlines trimmed), for the approval card. Pure. */
export function shellSessionSubmitText(args: Record<string, unknown>): string {
  return String(args["text"] ?? "").replace(/[\r\n]+$/, "")
}

/**
 * The mode/tool baseline (P2a), plus the destructive floor for the shells.
 *
 * `confirm` (the default) gates every call that reads or runs something —
 * file/scrollback/session reads, writes, shell commands, submissions, memory,
 * MCP. Two deliberate exceptions: `ask_user` IS the user interaction (it blocks
 * on the question), and `shell_session` TYPING auto-runs because the user
 * watches every keystroke and nothing executes. EVERY submission — any call
 * that presses Enter, including a bare Enter over a line already in the pane —
 * gates. The saved allow mechanisms still apply on top: `allowPrefixes` +
 * session trust for shell commands and `permission` rules for any tool.
 */
function baselineApprovalDecision(
  name: string,
  mode: "confirm" | "full-auto",
  args: Record<string, unknown>,
  allowPrefixes: readonly string[],
  trusted: readonly TrustPattern[] = [],
): ApprovalDecision {
  if (mode === "full-auto") {
    if (name === "shell_background" && isDestructiveCommand(String(args["command"] ?? ""))) return { gate: true, destructive: true }
    if (name === "shell_session" && isDestructiveCommand(String(args["text"] ?? ""))) return { gate: true, destructive: true }
    return { gate: false }
  }
  if (name === "ask_user") return { gate: false }
  switch (name) {
    case "shell_session": {
      // Typing auto-runs (the user watches it; nothing executes). A
      // SUBMISSION gates — any call that presses Enter, so the line can never
      // RUN without approval. Session trust for a typed command class
      // auto-runs the submission too, checked AFTER the destructive floor and
      // refused for a trust-exempt class — a "don't ask again" for `git
      // status` can never wave a `sudo`/`rm` through.
      const typed = String(args["text"] ?? "")
      if (isDestructiveCommand(typed)) return { gate: true, destructive: true }
      if (shellSessionSubmits(args)) {
        for (const t of trusted) {
          if (t.tool === name && t.prefix.length > 0 && !isTrustExempt(typed) && typed.startsWith(t.prefix)) {
            return { gate: false, allowPrefix: t.prefix }
          }
        }
        return { gate: true }
      }
      return { gate: false }
    }
    case "shell_background": {
      const cmd = String(args["command"] ?? "")
      if (isDestructiveCommand(cmd)) return { gate: true, destructive: true }
      for (const p of allowPrefixes) {
        if (p.length > 0 && cmd.startsWith(p)) return { gate: false, allowPrefix: p }
      }
      // Session trust (docs/agent.md "Approval modes"): user-granted this
      // session, checked AFTER the destructive floor and refused for any
      // trust-exempt class, so it can never wave an irreversible command
      // through even if a stale pattern somehow reached the registry.
      for (const t of trusted) {
        if (t.tool === name && t.prefix.length > 0 && !isTrustExempt(cmd) && cmd.startsWith(t.prefix)) {
          return { gate: false, allowPrefix: t.prefix }
        }
      }
      return { gate: true }
    }
    default:
      return { gate: true }
  }
}

/**
 * Approval policy (docs/agent.md "Approval modes", docs/config.md
 * "permission"): `confirm` (the default) gates every call — file/scrollback/
 * session reads, writes, shell commands, submissions, memory, MCP — with two
 * exceptions: `ask_user` (it IS the question) and `shell_session` typing
 * (nothing executes until Enter, and every submission gates). The allow-prefix
 * list (config) and session trust exempt matching shell commands; a
 * `permission` rule can allow any tool. MCP tools (mcp__*) gate like everything
 * else and are never allow-prefixable (prefixes are shell commands). full-auto
 * gates only destructive commands; both shells carry the destructive floor
 * (shell_session's typed text included), and a `permission` pattern matches
 * shell_session's text.
 *
 * P2a precedence:
 *   1. baseline from the mode/tool (above; session trust sits inside the
 *      baseline, AFTER the destructive floor);
 *   2. `permission` rules in order — the LAST matching rule wins and REPLACES
 *      the baseline action (so an explicit rule still wins over session trust);
 *   3. if NO rule matched, the allow-prefix fallback applies (step 1 already
 *      did, for shell_background);
 *   4. a `deny` is terminal: the caller must not execute. This is plain
 *      last-match-wins — a later `allow` CAN override an earlier `deny` (no
 *      deny-domination).
 * A destructive command is never un-gated by a rule or by session trust:
 * `allow`/`ask` rules and trust leave the destructive gate standing (a `deny`
 * still denies), preserving the `rm -rf /`-class safety net.
 */
export function approvalDecision(
  name: string,
  mode: "confirm" | "full-auto",
  args: Record<string, unknown>,
  allowPrefixes: readonly string[],
  permission: readonly PermissionRule[] = [],
  trusted: readonly TrustPattern[] = [],
): ApprovalDecision {
  const base = baselineApprovalDecision(name, mode, args, allowPrefixes, trusted)
  if (permission.length === 0) return base
  const target = permissionTarget(name, args)
  let action: "allow" | "ask" | "deny" | null = null
  for (const rule of permission) {
    if (permissionRuleMatches(rule, name, target)) action = rule.action // last match wins
  }
  if (action === null) return base
  if (action === "deny") return { gate: true, destructive: base.destructive, action: "deny" }
  // The destructive gate is a floor: rules cannot wave a destructive command
  // through. An `ask` still records the explicit action; an `allow` simply
  // falls back to the standing destructive gate.
  if (base.destructive === true) {
    return action === "ask" ? { gate: true, destructive: true, action: "ask" } : { gate: true, destructive: true }
  }
  if (action === "allow") return { gate: false, ...(base.allowPrefix !== undefined ? { allowPrefix: base.allowPrefix } : {}), action: "allow" }
  return { gate: true, action: "ask" }
}

// ---- Read-only agent guard (docs/agents.md `readonly`) -----------------------

/**
 * Tools a read-only agent may never call, independent of its `tools` list
 * (docs/agents.md `readonly`). `shell_session` types into the user's visible
 * pane, so it is refused outright; read-only shell work goes through
 * `shell_background` (`isReadOnlyShellCommand`).
 */
export const READONLY_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_file",
  "memory",
  "shell_session",
])

/**
 * Command classes that mutate state. A read-only agent may not run a command
 * matching ANY of these. This is a conservative guard, not a sandbox: it blocks
 * the enumerated mutations at the tool layer, but an interpreter can still be
 * coaxed into writing (the residual is documented in docs/agents.md).
 */
const READONLY_MUTATING_PATTERNS: readonly RegExp[] = [
  // Output redirection (writes a file, incl. `2>&1`/`&>` — deny conservatively).
  /(?:^|[^<])>{1,2}/,
  // In-place editors / stream editors that rewrite files.
  /\bsed\s+(?:-[A-Za-z]*i|--in-place)/,
  /\bperl\s+-\S*i/,
  /\bruby\s+-\S*i/,
  /\bgawk\s+-\S*i/,
  // Filesystem mutators.
  /\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|truncate|tee|install|mkfifo|mknod)\b/,
  /\b(?:dd|shred|wipefs|fdisk|parted|sgdisk|sfdisk|mkswap|swapoff|mkfs(?:\.\w+)?)\b/,
  /\b(?:mount|umount|swapon|losetup|cryptsetup)\b/,
  // Package / language toolchains (build/install/remove write state).
  /\b(?:apt|apt-get|apt-cache|dpkg|dpkg-deb|yum|dnf|rpm|pacman|apk|zypper|brew|snap|pip|pip3|easy_install|npm|npx|yarn|pnpm|bun|deno|gem|composer|go|cargo|rustup|conda|poetry|uv)\b/,
  // Service / init control (read-only `systemctl status` is unaffected).
  /\b(?:systemctl|service|launchctl)\s+(?:start|stop|restart|reload|reload-or-restart|try-restart|force-reload|enable|disable|mask|unmask|kill|set-default|reset-failed|daemon-reload|poweroff|reboot|suspend|hibernate|load|unload|kickstart|bootstrap|bootout|link)\b/,
  // Container / orchestration mutations.
  /\b(?:docker|podman)\s+(?:rm|rmi|run|create|start|stop|restart|kill|pause|unpause|build|push|tag|exec|commit|import|load|save|volume|network|container|image|system|compose|swarm|node|service|secret|config)\b/,
  /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|scale|rollout|set|annotate|label|drain|cordon|taint|exec|run|cp)\b/,
  /\bhelm\s+(?:install|upgrade|uninstall|rollback|delete|repo|push)\b/,
  /\bterraform\s+(?:apply|destroy|import|taint|state)\b/,
  /\b(?:pct|qm)\s+(?:start|stop|restart|create|destroy|set|clone|migrate|resize|del|reset|snapshot|rollback|move|template|suspend|resume)\b/,
  // Privilege escalation / arbitrary shell execution.
  /\b(?:sudo|doas)\b/,
  /(?:^|[;&|]\s*)su(?:\s|$)/,
  /(?:^|[;&|]\s*)(?:eval|exec|source|\.)\b/,
  /\b(?:ba|z|k|da|fi)?sh\s+-c\b/,
  // Interpreters given inline code (they can write without a redirect).
  /\b(?:python|python3|perl|ruby|node|php|lua)\s+(?:-\S*c|--eval|-e)\b/,
  // find that deletes/execs, and xargs (can invoke any mutator).
  /\bfind\b[^\n;&|]*(?:-delete\b|-exec(?:dir)?\b|-ok(?:dir)?\b)/,
  /\bxargs\b/,
  // Patch application.
  /\bpatch\b/,
  // Process / power / account state.
  /\b(?:kill|pkill|killall)\b/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  /\bcrontab\b/,
  /\b(?:useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|chpasswd)\b/,
]

/** `git` subcommands that only read (anything else is treated as mutating). */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "remote", "tag", "describe",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "cat-file",
  "blame", "grep", "shortlog", "reflog", "version", "help", "whatchanged",
  "show-ref", "for-each-ref", "name-rev", "count-objects", "diff-tree",
  "diff-files", "diff-index", "merge-base", "verify-commit", "verify-tag",
  "var", "cherry", "worktree", "symbolic-ref", "check-ignore", "check-attr",
])

/**
 * The first non-flag token after each `git` in the line (skipping `-C <dir>`
 * and other leading flags). Returns the subcommand, or null when none resolves.
 */
function gitSubcommands(command: string): string[] {
  const out: string[] = []
  const re = /\bgit\b([^;&|]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) {
    const tokens = (m[1] ?? "").trim().split(/\s+/).filter((t) => t.length > 0)
    let i = 0
    // Skip leading flags; `-C`/`-c` consume the next token.
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      const flag = tokens[i]!
      i++
      if ((flag === "-C" || flag === "-c" || flag === "--git-dir" || flag === "--work-tree") && i < tokens.length) i++
    }
    if (i < tokens.length) out.push(tokens[i]!)
  }
  return out
}

/**
 * True when a shell command is safe for a read-only agent: no mutating pattern
 * and, for any `git`, only a read-only subcommand. Pure + unit-tested.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const cmd = command.trim()
  if (cmd.length === 0) return true
  if (READONLY_MUTATING_PATTERNS.some((re) => re.test(cmd))) return false
  for (const sub of gitSubcommands(cmd)) {
    if (!GIT_READONLY_SUBCOMMANDS.has(sub)) return false
  }
  return true
}

/** First line of a command, trimmed, for a bounded denial reason. */
function firstLine(command: string): string {
  const line = command.split("\n")[0] ?? command
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/**
 * The read-only guard decision for a call, or null when the call is allowed.
 * A terminal `deny` (`denySource: "guard"`): the read-only agent may not run
 * edits, memory writes, `shell_session`, MCP side effects, or a mutating shell
 * command — regardless of permission rules, session trust or an approval policy
 * (docs/agents.md `readonly`). Pure.
 */
export function readonlyGuardDecision(name: string, args: Record<string, unknown>): ApprovalDecision | null {
  if (READONLY_DENIED_TOOLS.has(name)) {
    return {
      gate: true,
      action: "deny",
      denySource: "guard",
      denyReason: `read-only agent: ${name} is not permitted`,
    }
  }
  if (name === "shell_background") {
    const command = String(args["command"] ?? "")
    if (!isReadOnlyShellCommand(command)) {
      return {
        gate: true,
        action: "deny",
        denySource: "guard",
        denyReason: `read-only agent: the command mutates state — ${firstLine(command)}`,
      }
    }
  }
  // MCP tools are external side effects; a read-only agent does not get them.
  if (name.startsWith("mcp__")) {
    return {
      gate: true,
      action: "deny",
      denySource: "guard",
      denyReason: "read-only agent: MCP tools may have side effects",
    }
  }
  return null
}
