/**
 * Structured pane-state probe (docs/terminal-layer.md "Pane state").
 *
 * The agent's only window into the visible pane used to be `get_scrollback`:
 * raw, wrapped, prompt-redrawn text. Everything needed to reason about whether
 * it is safe to type is encoded in that text and nothing else — at a prompt vs
 * mid-continuation (`dquote>`/`quote>`/`heredoc>`), a foreground command still
 * running, a sudo/SSH password prompt waiting, a full-screen app owning the
 * terminal. Both #19 incidents (a command swallowed by a continuation, a
 * countdown misreported) were guess-the-state failures.
 *
 * This module classifies the **live screen grid** (the bottom N visible lines
 * the embedded Ghostty VT composes), not the scanner's scrollback ring: the
 * screen has already resolved wrapping and prompt redraws, so the classifier
 * sees what the user sees. It reuses no scanner of its own — `StreamScanner`
 * already exposes the alternate-screen and OSC 133 flags; those are passed in
 * as facts.
 *
 * Contract: pure and NEVER throws. An unrecognizable screen yields
 * `state: "unknown"`, never an exception (AGENTS.md rule 10).
 */

export type PaneStateKind =
  | "prompt"
  | "continuation"
  | "running"
  | "password-prompt"
  | "fullscreen"
  | "unknown"

export type ContinuationKind = "dquote" | "quote" | "heredoc" | "backtick" | "paren"

/** A small typed snapshot of the visible pane's state. */
export interface PaneState {
  state: PaneStateKind
  /** Present when `state === "continuation"` and the prompt shape is known. */
  continuationKind?: ContinuationKind
  /** Pane cwd (OSC 7, else the spawn cwd) when cheaply available. */
  cwd: string | null
  /** PTY shell pid when cheaply available. */
  shellPid: number | null
  /** A few sanitized bottom screen lines for evidence. */
  tail: string[]
  /** 0..1 — how sure the classifier is. 0 for `unknown`. */
  confidence: number
  /** Best-effort last command-looking line on screen (null when not derivable). */
  lastCommand: string | null
}

/** Input facts for the classifier. */
export interface PaneStateInput {
  /** Bottom visible screen lines, oldest -> newest (`renderable.screen().lines`). */
  lines: readonly string[]
  /** The VT's alternate-screen flag (a full-screen app owns the pane). */
  alternateOn?: boolean
  /** OSC 133 command-running flag, when the scanner produced marks. */
  commandRunning?: boolean
  /** Pane cwd (OSC 7 or spawn). */
  cwd?: string | null
  /** PTY shell pid. */
  shellPid?: number | null
  /** Cursor row within `lines`; sharpens which line is "active". */
  cursorY?: number | null
  /** How many bottom lines to keep in `tail` (default 8). */
  tailLines?: number
}

const DEFAULT_TAIL_LINES = 8
/** Longest evidence line kept; a redrawn status line can be huge. */
const MAX_TAIL_LINE = 200

/** Strip control characters the VT screen should never carry, and cap length. */
function cleanLine(line: string): string {
  const noControls = line.replace(/\t/g, "    ").replace(/[\u0000-\u001f\u007f]/g, "")
  const trimmed = noControls.replace(/\s+$/, "")
  return trimmed.length > MAX_TAIL_LINE ? `${trimmed.slice(0, MAX_TAIL_LINE)}…` : trimmed
}

/** Sanitized bottom-N screen lines (oldest -> newest). Never throws. */
export function sanitizePaneTail(lines: readonly string[], n: number = DEFAULT_TAIL_LINES): string[] {
  if (!Array.isArray(lines)) return []
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TAIL_LINES
  const slice = lines.slice(Math.max(0, lines.length - count))
  return slice.map((l) => cleanLine(typeof l === "string" ? l : ""))
}

/**
 * The index of the "active" line: the cursor row when known and in range, else
 * the bottom-most non-empty line, else the last line.
 */
function resolveActiveIndex(lines: readonly string[], cursorY?: number | null): number {
  if (
    cursorY !== undefined &&
    cursorY !== null &&
    Number.isInteger(cursorY) &&
    cursorY >= 0 &&
    cursorY < lines.length
  ) {
    return cursorY
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim().length > 0) return i
  }
  return lines.length - 1
}

/** Interactive prompt terminators: zsh `%`, bash `$`, root `#`, modern glyphs. */
const PROMPT_END_RE = /[%$#❯➜➔→»λ]\s*$/
/** A prompt marker followed by content on the same line (`% ls -la`). */
const PROMPT_INPUT_RE = /[%$#❯➜➔→»λ]\s+(.+)$/

/** Does this line look like an interactive shell prompt (empty input)? */
export function looksLikeShellPrompt(line: string): boolean {
  const t = line.trimEnd()
  if (t.length === 0) return false
  return PROMPT_END_RE.test(t)
}

/** Shell continuation-prompt prefixes (zsh PS2 shapes). */
const NAMED_CONTINUATION: ReadonlyArray<readonly [RegExp, ContinuationKind | undefined]> = [
  [/^dquote>/, "dquote"],
  [/^quote>/, "quote"],
  [/^heredoc>/, "heredoc"],
  [/^cmdsubst>/, "paren"],
  [/^subsh>/, "paren"],
  [/^bquote>/, "backtick"],
  [/^(?:pipe|brace|then|while|for|select|case|repeat|math|array|cond|if|nocorrect|foreach)>/, undefined],
]
/** bash's default PS2 (`> `), matched only when it is the active line. */
const BASH_PS2_RE = /^>\s?/

/**
 * Classify a continuation line. Named zsh prompts are confident; a bare bash
 * `> ` is ambiguous (an output line can look like it), so it scores lower.
 */
function matchContinuation(line: string): { kind?: ContinuationKind; confidence: number } | null {
  const t = line.replace(/\s+$/, "").replace(/^\s+/, "")
  if (t.length === 0) return null
  for (const [re, kind] of NAMED_CONTINUATION) {
    if (re.test(t)) return kind === undefined ? { confidence: 0.9 } : { kind, confidence: 0.9 }
  }
  if (BASH_PS2_RE.test(t)) return { confidence: 0.6 }
  return null
}

/** Password / confirmation prompt shapes (sudo, ssh, su, gpg, host-key). */
const PASSWORD_PATTERNS: readonly RegExp[] = [
  /\[sudo\]\s*password\s+for\s+[^:]*:\s*$/i,
  /^password\s+for\s+[^:]*:\s*$/i,
  /[^@\s]+@[^:\s]+'s\s+password:\s*$/i,
  /^(?:enter\s+)?passphrase(?:\s+for\s+key\s+[^:]+)?:\s*$/i,
  /^password:\s*$/i,
  /\(yes\/no\/\[fingerprint\]\)\?\s*$/i,
  /\(yes\/no\)\?\s*$/i,
]

/** Does a line end in a password/confirmation prompt? */
export function looksLikePasswordPrompt(line: string): boolean {
  const t = line.trim()
  if (t.length === 0) return false
  return PASSWORD_PATTERNS.some((re) => re.test(t))
}

/**
 * Best-effort "last command actually accepted" from the visible screen: the
 * most recent prompt marker followed by content, excluding the active pending
 * input line. Heuristic (prompts are user-configurable) and nullable.
 */
function deriveLastCommand(lines: readonly string[], active: number): string | null {
  let last: string | null = null
  for (let i = 0; i < lines.length; i++) {
    if (i === active) continue
    const m = PROMPT_INPUT_RE.exec((lines[i] ?? "").trimEnd())
    if (m === null) continue
    const cmd = (m[1] ?? "").trim()
    if (cmd.length > 0) last = cmd
  }
  return last
}

/** The unrecognizable / empty fallback snapshot. */
function unknownState(base: Pick<PaneState, "cwd" | "shellPid" | "tail">): PaneState {
  return { ...base, state: "unknown", confidence: 0, lastCommand: null }
}

/**
 * Classify the visible pane. Precedence: a waiting password prompt outranks
 * everything (the shell is blocked on input), then a full-screen app, then a
 * running command, then a continuation, then a prompt. Unknown when nothing
 * matches. Never throws.
 */
export function classifyPaneState(input: PaneStateInput): PaneState {
  try {
    const lines = Array.isArray(input.lines) ? input.lines : []
    const tail = sanitizePaneTail(lines, input.tailLines ?? DEFAULT_TAIL_LINES)
    const base = { cwd: input.cwd ?? null, shellPid: input.shellPid ?? null, tail }
    const active = resolveActiveIndex(lines, input.cursorY)
    const activeLine = lines[active] ?? ""
    // Password prompts can sit on the active line or the one just above it
    // (sudo prints the prompt, then the shell sits after it).
    const nearby = [activeLine, lines[active - 1] ?? ""]

    if (input.alternateOn === true) {
      return { ...base, state: "fullscreen", confidence: 0.85, lastCommand: null }
    }
    if (nearby.some((l) => looksLikePasswordPrompt(l))) {
      return { ...base, state: "password-prompt", confidence: 0.9, lastCommand: null }
    }
    if (input.commandRunning === true) {
      return { ...base, state: "running", confidence: 0.85, lastCommand: deriveLastCommand(lines, active) }
    }
    const cont = matchContinuation(activeLine)
    if (cont !== null) {
      return {
        ...base,
        state: "continuation",
        ...(cont.kind !== undefined ? { continuationKind: cont.kind } : {}),
        confidence: cont.confidence,
        // The visible line is the in-progress input, not an accepted command.
        lastCommand: null,
      }
    }
    if (looksLikeShellPrompt(activeLine)) {
      return {
        ...base,
        state: "prompt",
        confidence: input.commandRunning === false ? 0.9 : 0.8,
        lastCommand: deriveLastCommand(lines, active),
      }
    }
    const pending = PROMPT_INPUT_RE.exec(activeLine.trimEnd())
    if (pending !== null) {
      return {
        ...base,
        state: "prompt",
        confidence: 0.6,
        // The active line is the pending input; report the prior accepted line.
        lastCommand: deriveLastCommand(lines, active),
      }
    }
    if (input.commandRunning === false) {
      // OSC 133 says the shell is idle but no prompt shape matched: trust the
      // scanner at lower confidence rather than reporting unknown.
      return { ...base, state: "prompt", confidence: 0.55, lastCommand: deriveLastCommand(lines, active) }
    }
    return unknownState(base)
  } catch {
    return { state: "unknown", cwd: null, shellPid: null, tail: [], confidence: 0, lastCommand: null }
  }
}

/** Short reason a non-prompt state must not be typed into, or null to proceed. */
export function paneStateRefusal(state: PaneState | null): string | null {
  if (state === null || state.confidence < 0.5) return null
  switch (state.state) {
    case "continuation": {
      const kind = state.continuationKind ?? "shell"
      return `the pane is in a ${kind} continuation (the shell is waiting for the current line to be completed)`
    }
    case "running":
      return "a foreground command is still running in the pane"
    case "password-prompt":
      return "the pane is waiting for a password prompt (sudo/SSH)"
    case "fullscreen":
      return "a full-screen program owns the pane (alternate screen)"
    default:
      return null
  }
}

/** Render a few sanitized pane lines as indented evidence. */
export function formatPaneEvidence(state: PaneState | null, maxLines = 6): string {
  if (state === null || state.tail.length === 0) return "(no pane lines available)"
  const lines = state.tail.slice(Math.max(0, state.tail.length - maxLines))
  return lines.map((l) => (l.length > 0 ? `  ${l}` : "  …")).join("\n")
}

/** One-line state summary for a tool result ("prompt (0.85)"). */
export function paneStateSummary(state: PaneState | null): string | null {
  if (state === null) return null
  const kind = state.state === "continuation" && state.continuationKind !== undefined
    ? `continuation: ${state.continuationKind}`
    : state.state
  return `${kind} (confidence ${state.confidence.toFixed(2)})`
}
