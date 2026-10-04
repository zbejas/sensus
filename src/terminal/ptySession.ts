/**
 * Headless PTY session: one shell on a native PTY (`Bun.Terminal` +
 * `Bun.spawn({ terminal })`), the renderer-free half of the terminal engine
 * (docs/terminal-layer.md "PTY core vs renderable").
 *
 * This module owns exactly the side the daemon needs (D1): the PTY child, the
 * output pipeline (`SgrColorRewriter` → `StreamScanner`), the input reply-leak
 * guard, resize, status facts, and the plain-text ring. It does NOT import
 * `@opentui/core` and has no screen grid: a client (`TerminalSession`, or the
 * future remote client) owns the embedded VT renderable and the `PanePainter`.
 *
 * Wiring:
 *   Bun.Terminal (PTY) --data callback--> rewrite indexed SGR -> scan
 *          ^                                      |
 *          | write(bytes)                         v
 *          |                              onOutput(raw post-rewrite bytes)
 *          |                                      |
 *          |                                 client VT renderable
 *          | (guarded)                            |
 *          +---- write(bytes) <---- renderable.onData / WS terminal.input
 *
 * Every method is defensively wrapped: a PTY failure surfaces as a dead
 * session or a dropped byte, never an exception (AGENTS.md rule 10).
 */

import { errorMessage } from "../core/util.ts"
import type { KeyAction } from "./keys.ts"
import { encodeKeyAction } from "./keys.ts"
import { shellLaunchArgv } from "./launch.ts"
import { prepareShellIntegration, type ShellIntegration } from "./shellIntegration.ts"
import { StreamScanner } from "./scan.ts"
import { SgrColorRewriter, type PanePalette, type Rgb } from "./sgr.ts"
import { ResponseLeakGuard, RESPONSE_GUARD_HOLD_MS } from "./responseGuard.ts"
import { classifyPaneState, type PaneState } from "./paneState.ts"

/** Terminal facts a client/agent reads (docs/terminal-layer.md "Status & facts"). */
export interface TerminalStatus {
  dead: boolean
  /** Exit status of the dead shell (null while alive). */
  deadStatus: number | null
  cols: number
  rows: number
  /** Last cwd reported by the shell via OSC 7, else the spawn cwd. */
  cwd: string | null
  /** Foreground command name ("": no reliable native-PTY source; the UI
   * falls back to the shell basename for the tab title). */
  currentCommand: string
  /** A full-screen app holds the alternate screen (DECSET 47/1047/1049). */
  alternateOn: boolean
  /** DECCKM active (DECSET `?1`): the shell wants SS3 cursor keys. */
  applicationCursor?: boolean
  /** Between OSC 133 `C` (command started) and `D` (finished). */
  commandRunning?: boolean
  /** Exit code from the last OSC 133 `D;<code>`, else null. */
  lastExitCode?: number | null
  /** Cursor position; `null` when no client grid is attached (D2 fallback). */
  cursorX: number | null
  cursorY: number | null
  cursorVisible: boolean
}

/** Options for spawning a headless PtySession. */
export interface PtySessionOptions {
  cols: number
  rows: number
  shell: string
  cwd?: string
  env?: Record<string, string | undefined>
  /** Terminal palette used to rewrite indexed SGR colors to truecolor; null
   * (or omitted) leaves the VT's built-in palette. */
  palette?: PanePalette | null
  /** Bold→bright promotion for basic fg (default true). */
  boldBright?: boolean
  /** Theme default fg (truecolor), re-applied on reset/39 so the pane fg
   * follows the active theme. `defaultBg` is tracked for change detection; a
   * client paints the background, never SGR. */
  defaultFg?: Rgb | null
  defaultBg?: Rgb | null
}

/** Clamp a cell dimension to a positive integer. */
function normalizeSize(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1
}

/** Cap on bytes buffered before the first output listener attaches (D12-ish:
 * never unbounded; a client that never attaches drops old output, not memory). */
const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024

export class PtySession {
  cols: number
  rows: number

  private readonly scanner = new StreamScanner()
  private readonly rewriter = new SgrColorRewriter()
  /** Set when the PTY/child could not be created; surfaced read-only for a
   * client that wants to toast instead of hosting a dead session. */
  spawnError: string | null = null
  private term: Bun.Terminal | null = null
  private readonly spawnCwd: string | null
  private readonly exitCallbacks: Array<(code: number | null) => void> = []
  private readonly outputListeners: Array<(bytes: Uint8Array) => void> = []
  /** Bytes emitted before the first `onOutput` listener attached (bounded). */
  private pendingOutput: Uint8Array[] = []
  private pendingOutputBytes = 0
  /** Drops terminal-query-response tails misparsed as pane keystrokes. */
  private readonly inputGuard = new ResponseLeakGuard()
  private guardTimer: ReturnType<typeof setTimeout> | null = null

  private proc: Bun.Subprocess | null = null
  private exitedPromise: Promise<number | null> = Promise.resolve(null)
  private dead = false
  private deadStatus: number | null = null
  private closed = false

  private constructor(term: Bun.Terminal | null, opts: PtySessionOptions) {
    this.term = term
    this.cols = normalizeSize(opts.cols)
    this.rows = normalizeSize(opts.rows)
    this.spawnCwd = opts.cwd !== undefined && opts.cwd.length > 0 ? opts.cwd : null
    this.rewriter.setPalette(opts.palette ?? null)
    this.rewriter.setBoldBright(opts.boldBright ?? true)
    this.rewriter.setDefaults(opts.defaultFg ?? null, opts.defaultBg ?? null)
  }

  /**
   * Spawn a shell on a fresh native PTY. Never throws: a failure yields a dead
   * session (check `status().dead` / `spawnError`) so the daemon can degrade.
   */
  static spawn(opts: PtySessionOptions): PtySession {
    const cols = normalizeSize(opts.cols)
    const rows = normalizeSize(opts.rows)

    // Late-bound holder: the PTY data callback is created before the session
    // exists and must forward into it once construction completes.
    const holder: { session: PtySession | null } = { session: null }

    let term: Bun.Terminal | null = null
    try {
      term = new Bun.Terminal({
        cols,
        rows,
        name: "xterm-256color",
        data: (_terminal, bytes) => {
          holder.session?.handleOutput(bytes)
        },
      })
    } catch (e) {
      const session = new PtySession(null, opts)
      session.spawnError = errorMessage(e)
      session.markDead(null)
      return session
    }

    const session = new PtySession(term, opts)
    holder.session = session

    // Shell integration: turn on OSC 7 cwd reporting so status/context follow
    // `cd` (docs/terminal-layer.md "Shell integration"). A failure here must
    // never block the pane — the spawn-cwd fallback stands.
    let integration: ShellIntegration = { args: [], env: {} }
    try {
      integration = prepareShellIntegration(opts.shell)
    } catch {
      // no integration; the pane still runs
    }

    // `Bun.Terminal.name` does NOT set the child's $TERM (verified), so
    // TERM/COLORTERM must be passed explicitly. `detached: true` is
    // load-bearing: Bun calls setsid() so the child becomes a session leader;
    // `shellLaunchArgv` makes the shell claim the controlling tty.
    try {
      const proc = Bun.spawn({
        cmd: shellLaunchArgv(opts.shell, integration.args),
        terminal: term,
        cwd: opts.cwd,
        detached: true,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          SENSUS_ACTIVE: "1",
          ...opts.env,
          ...integration.env,
        },
      })
      session.attachProcess(proc)
    } catch (e) {
      session.spawnError = errorMessage(e)
      session.markDead(null)
      session.closed = true
      try {
        term.close()
      } catch {
        // already closed
      }
    }
    return session
  }

  /**
   * Raw child output: rewrite indexed colors, scan for status, fan out the
   * rewritten bytes to every `onOutput` listener (the client's VT / WS).
   */
  private handleOutput(bytes: Uint8Array): void {
    try {
      const out = this.rewriter.transform(bytes)
      this.scanner.push(out)
      this.emitOutput(out)
    } catch {
      // Defensive: a malformed byte stream must not take down the host.
    }
  }

  /** Fan out post-rewrite bytes, buffering (bounded) until a listener attaches. */
  private emitOutput(bytes: Uint8Array): void {
    if (this.outputListeners.length === 0) {
      if (bytes.byteLength > 0 && this.pendingOutputBytes < OUTPUT_BUFFER_MAX_BYTES) {
        this.pendingOutput.push(bytes)
        this.pendingOutputBytes += bytes.byteLength
      }
      return
    }
    for (const cb of this.outputListeners) {
      try {
        cb(bytes)
      } catch {
        // a listener failure must not break the PTY data path
      }
    }
  }

  /**
   * Register an output listener and flush any bytes that arrived before it
   * attached. Listener errors are contained; `onOutput` never throws.
   */
  onOutput(cb: (bytes: Uint8Array) => void): void {
    this.outputListeners.push(cb)
    const buffered = this.pendingOutput
    this.pendingOutput = []
    this.pendingOutputBytes = 0
    for (const bytes of buffered) {
      try {
        cb(bytes)
      } catch {
        // contained
      }
    }
  }

  private attachProcess(proc: Bun.Subprocess): void {
    this.proc = proc
    this.exitedPromise = proc.exited.then(
      (code) => {
        this.markDead(code)
        return code
      },
      () => {
        this.markDead(null)
        return null
      },
    )
  }

  private markDead(code: number | null): void {
    if (this.dead) return
    this.dead = true
    this.deadStatus = code
    for (const cb of this.exitCallbacks) {
      try {
        cb(code)
      } catch {
        // A listener error must not escape into the PTY/exit path.
      }
    }
  }

  // -- input ------------------------------------------------------------------

  /**
   * Feed input bytes to the PTY through the reply-leak guard. This is the
   * client path: a renderable's `onData` or a daemon's `terminal.input`. A
   * closed PTY drops the bytes without throwing.
   */
  write(bytes: Uint8Array): void {
    let out: Uint8Array
    try {
      out = this.inputGuard.push(bytes, Date.now())
    } catch {
      out = bytes
    }
    if (out.byteLength > 0) {
      try {
        this.term?.write(out)
      } catch {
        this.closed = true
      }
    }
    this.armGuardFlush()
  }

  /** (Re)arm the idle timer that releases a held guard candidate. */
  private armGuardFlush(): void {
    if (this.guardTimer !== null) {
      clearTimeout(this.guardTimer)
      this.guardTimer = null
    }
    if (!this.inputGuard.pending) return
    this.guardTimer = setTimeout(() => {
      this.guardTimer = null
      try {
        const out = this.inputGuard.flush(Date.now(), true)
        if (out.byteLength > 0) this.term?.write(out)
      } catch {
        // best-effort: a closed PTY drops the bytes
      }
    }, RESPONSE_GUARD_HOLD_MS)
    // Do not keep the host alive for a pending key candidate.
    this.guardTimer.unref?.()
  }

  /** Send one key action (literal text or named keys) to the PTY. */
  async sendKeys(action: KeyAction): Promise<void> {
    try {
      // DECCKM: the shell may have asked for application cursor keys, in which
      // case arrows/Home/End must go out as SS3 (docs/terminal-layer.md "keys").
      this.sendBytes(encodeKeyAction(action, { applicationCursor: this.scanner.applicationCursor }))
    } catch {
      // Encoding is pure; a surprise here must not crash the host.
    }
  }

  /** Send literal text to the PTY (unguarded: programmatic, not a reply tail). */
  async sendText(text: string): Promise<void> {
    if (this.closed || text.length === 0) return
    try {
      this.term?.write(text)
    } catch {
      this.closed = true
    }
  }

  /** Send raw bytes (e.g. synthesized mouse events) to the PTY. */
  sendBytes(bytes: Uint8Array): void {
    if (this.closed || bytes.byteLength === 0) return
    try {
      this.term?.write(bytes)
    } catch {
      this.closed = true
    }
  }

  /** Resize the PTY to a cell size. */
  resize(cols: number, rows: number): void {
    const c = normalizeSize(cols)
    const r = normalizeSize(rows)
    this.cols = c
    this.rows = r
    try {
      this.term?.resize(c, r)
    } catch {
      // ignore: resize on a closed PTY is a no-op
    }
  }

  // -- status / capture -------------------------------------------------------

  /** Current session status. Cursor fields are `null` without a client grid. */
  status(): TerminalStatus {
    return {
      dead: this.dead,
      deadStatus: this.deadStatus,
      cols: this.cols,
      rows: this.rows,
      cwd: this.scanner.cwd ?? this.spawnCwd,
      // No reliable foreground-command source with a native PTY (that was a
      // tmux `#{pane_current_command}` format); kept for parity.
      currentCommand: "",
      alternateOn: this.scanner.alternateOn,
      applicationCursor: this.scanner.applicationCursor,
      commandRunning: this.scanner.commandRunning,
      lastExitCode: this.scanner.lastExitCode,
      cursorX: null,
      cursorY: null,
      cursorVisible: false,
    }
  }

  /**
   * Structured pane-state probe (docs/terminal-layer.md "Pane state"). With no
   * client grid (D2 fallback) it classifies the scanner ring's bottom lines and
   * passes `cursorY: null`; the classifier stays best-effort and never throws.
   */
  paneState(tailLines = 8): PaneState {
    return classifyPaneState({
      lines: this.recentLines(tailLines),
      alternateOn: this.scanner.alternateOn,
      commandRunning: this.scanner.commandRunning,
      cwd: this.scanner.cwd ?? this.spawnCwd,
      shellPid: this.pid >= 0 ? this.pid : null,
      cursorY: null,
      tailLines,
    })
  }

  /**
   * Synchronous recent plain-text tail (scanner ring), for the per-message
   * context block. `n <= 0` returns the whole ring.
   */
  recentLines(n: number): string[] {
    const all = this.scanner.ring.lines()
    if (!Number.isFinite(n) || n <= 0 || all.length <= n) return all
    return all.slice(all.length - n)
  }

  /**
   * Deep capture for the agent's get_scrollback tool: the last N scanned
   * plain-text lines (clamped to the tool's hard cap of 5000).
   */
  async captureScrollbackRaw(lines: number): Promise<string> {
    const requested = Number.isFinite(lines) ? Math.floor(lines) : 500
    const n = Math.min(Math.max(requested, 1), 5000)
    const all = this.scanner.ring.lines()
    if (all.length <= n) return all.join("\n")
    return all.slice(all.length - n).join("\n")
  }

  // -- palette / theme --------------------------------------------------------

  /** Update the palette used to rewrite indexed colors (detected/override). */
  setPalette(palette: PanePalette | null): void {
    this.rewriter.setPalette(palette)
  }

  /** Toggle bold→bright promotion. */
  setBoldBright(on: boolean): void {
    this.rewriter.setBoldBright(on)
  }

  /** Update the theme default fg/bg for the SGR rewriter. */
  setDefaults(fg: Rgb | null, bg: Rgb | null): void {
    this.rewriter.setDefaults(fg, bg)
  }

  // -- lifecycle --------------------------------------------------------------

  /** Register an exit listener; fires once, immediately if already dead. */
  onExit(cb: (code: number | null) => void): void {
    if (this.dead) {
      queueMicrotask(() => {
        try {
          cb(this.deadStatus)
        } catch {
          // ignore listener error
        }
      })
      return
    }
    this.exitCallbacks.push(cb)
  }

  /** Best-effort teardown: kill the child and close the PTY. Idempotent. */
  kill(): void {
    this.closed = true
    if (this.guardTimer !== null) {
      clearTimeout(this.guardTimer)
      this.guardTimer = null
    }
    try {
      this.proc?.kill()
    } catch {
      // already gone
    }
    try {
      this.term?.close()
    } catch {
      // already closed
    }
  }

  /** Child pid (-1 before spawn completes / after teardown). */
  get pid(): number {
    return this.proc?.pid ?? -1
  }

  /** Resolves with the child exit code (null when unavailable). */
  get exited(): Promise<number | null> {
    return this.exitedPromise
  }
}
