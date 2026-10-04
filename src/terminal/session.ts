/**
 * Terminal session (client): one shell on a native PTY rendered by OpenTUI's
 * embedded terminal (the tmux replacement).
 *
 * This is the RENDERER half of the terminal engine. The PTY child, the output
 * pipeline (`SgrColorRewriter` → `StreamScanner`) and the input reply-leak
 * guard live in `ptySession.ts` (headless, no `@opentui/core`); this class
 * mounts an `EmbeddedTerminalRenderable` on top of a `PtySession`, pipes the
 * rewritten bytes into it, routes its `onData` back to the PTY, and owns the
 * `PanePainter` theming hook (docs/terminal-layer.md "PTY core vs renderable").
 *
 * Wiring:
 *   PtySession (PTY + rewrite + scan) --onOutput--> EmbeddedTerminalRenderable
 *          ^                                              |
 *          +----- write(bytes) <--- onData(keys/responses)-+
 *
 * The renderable owns the VT state (screen, cursor, colors, native
 * scrollback); the scanner ring + title/cwd/alt-screen facts come from the
 * `PtySession`. The class satisfies the structural `AgentPane` surface the
 * tools need (`sendKeys` + `captureScrollbackRaw`). Every method is
 * defensively wrapped: a renderable failure surfaces as a dropped byte / dead
 * session, never an exception.
 */

import { EmbeddedTerminalRenderable, PasteEvent, type RenderContext } from "@opentui/core"
import type { KeyAction } from "./keys.ts"
import { PanePainter } from "./paneBg.ts"
import { PtySession, type PtySessionOptions, type TerminalStatus } from "./ptySession.ts"
import { classifyPaneState, type PaneState } from "./paneState.ts"
import type { PanePalette, Rgb } from "./sgr.ts"

export type { TerminalStatus } from "./ptySession.ts"

/** Options for spawning a TerminalSession (a PtySession + renderable extras). */
export interface TerminalSessionOptions extends PtySessionOptions {
  /** Native scrollback depth kept by the renderable (default 10000). */
  maxScrollback?: number
}

/** Clamp a cell dimension to a positive integer. */
function normalizeSize(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1
}

export class TerminalSession {
  private readonly pty: PtySession
  private readonly termRenderable: EmbeddedTerminalRenderable
  /** Render-time pane color applier (default-bg repaint + theme color remap). */
  private readonly painter: PanePainter

  private constructor(pty: PtySession, termRenderable: EmbeddedTerminalRenderable, painter: PanePainter) {
    this.pty = pty
    this.termRenderable = termRenderable
    this.painter = painter
  }

  /**
   * Spawn a headless `PtySession` and render it into `ctx`.
   *
   * A renderer-level spawn failure (bad shell / unavailable PTY) still throws
   * so the caller can toast and skip the tab — the headless `PtySession`
   * itself never throws.
   */
  static spawn(ctx: RenderContext, opts: TerminalSessionOptions): TerminalSession {
    const cols = normalizeSize(opts.cols)
    const rows = normalizeSize(opts.rows)

    // Render-time pane color applier shared with the render hook (see below).
    const painter = new PanePainter()
    painter.setPalette(opts.palette ?? null)
    painter.setDefaults(opts.defaultFg ?? null, opts.defaultBg ?? null)

    const pty = PtySession.spawn({
      cols,
      rows,
      shell: opts.shell,
      cwd: opts.cwd,
      env: opts.env,
      palette: opts.palette ?? null,
      boldBright: opts.boldBright ?? true,
      defaultFg: opts.defaultFg ?? null,
      defaultBg: opts.defaultBg ?? null,
    })
    if (pty.spawnError !== null) {
      // Preserve the pre-split contract: the caller catches and toasts.
      try {
        pty.kill()
      } catch {
        // already gone
      }
      throw new Error(pty.spawnError)
    }

    let renderable: EmbeddedTerminalRenderable
    try {
      renderable = new EmbeddedTerminalRenderable(ctx, {
        cols,
        rows,
        maxScrollback: opts.maxScrollback ?? 10000,
        // Repaint the VT's opaque-black default background with the theme
        // background, and remap frozen theme/palette colors to the current ones,
        // on every composed frame. This is what keeps the pane themed across
        // resize, scroll, and theme switches — the SGR rewriter and a one-shot
        // repaint cannot, because the VT re-composes cells from its own state.
        renderAfter: (buffer) => {
          try {
            painter.paint(buffer.buffers.fg, buffer.buffers.bg)
          } catch {
            // A render-hook failure must never take down the frame.
          }
        },
        // The renderable emits encoded keys/mouse (source "input") AND emulator
        // responses such as DA/CPR replies (source "response"); both belong on
        // the PTY input, so the source is deliberately ignored. `PtySession.write`
        // routes them through `ResponseLeakGuard` so a terminal-query reply the
        // parser split into key events (the SSH/`cmd` `:ffff/ffff/ffff` report)
        // is dropped before it can be typed into the pane.
        onData: (bytes) => {
          pty.write(bytes)
        },
        onTerminalResize: (c, r) => {
          pty.resize(c, r)
        },
      })
    } catch (e) {
      // A renderable failure must not leak the already-spawned PTY child.
      try {
        pty.kill()
      } catch {
        // already gone
      }
      throw e
    }

    // Pipe the rewritten output into the VT. Bytes the child wrote before this
    // listener attached were buffered (bounded) by the PtySession and flush here.
    pty.onOutput((bytes) => {
      try {
        renderable.write(bytes)
      } catch {
        // PTY/renderable closed mid-write: drop the bytes, never crash.
      }
    })

    return new TerminalSession(pty, renderable, painter)
  }

  /** Last known cell size (delegates to the PTY). */
  get cols(): number {
    return this.pty.cols
  }

  get rows(): number {
    return this.pty.rows
  }

  // -- input ------------------------------------------------------------------

  /** Send one key action (literal text or named keys) to the PTY. */
  async sendKeys(action: KeyAction): Promise<void> {
    await this.pty.sendKeys(action)
  }

  /** Send literal text to the PTY. */
  async sendText(text: string): Promise<void> {
    await this.pty.sendText(text)
  }

  /**
   * Send host-clipboard text to the PTY as a BRACKETED PASTE, so embedded
   * newlines are inserted literally instead of executing each line (the pane's
   * paste path; the renderable owns the encoding).
   */
  pasteText(text: string): void {
    if (text.length === 0) return
    try {
      this.termRenderable.handlePaste(new PasteEvent(new TextEncoder().encode(text)))
    } catch {
      // renderable already destroyed
    }
  }

  /** Send raw bytes (e.g. synthesized mouse events) to the PTY. */
  sendBytes(bytes: Uint8Array): void {
    this.pty.sendBytes(bytes)
  }

  /** Resize the PTY + renderable to a cell size. */
  resize(cols: number, rows: number): void {
    const c = normalizeSize(cols)
    const r = normalizeSize(rows)
    this.pty.resize(c, r)
    try {
      this.termRenderable.width = c
      this.termRenderable.height = r
    } catch {
      // renderable already destroyed
    }
  }

  // -- status / capture -------------------------------------------------------

  /** Current session status (mirrors the old tmux PaneStatus shape). */
  status(): TerminalStatus {
    let cursorX = 0
    let cursorY = 0
    let cursorVisible = false
    try {
      const cursor = this.termRenderable.screen().cursor
      cursorX = cursor.x
      cursorY = cursor.y
      cursorVisible = cursor.visible
    } catch {
      // Destroyed renderable / native failure: fall back to the neutral cursor.
    }
    return { ...this.pty.status(), cursorX, cursorY, cursorVisible }
  }

  /** Visible screen lines (plain text, as composed by the renderable). */
  screenText(): string[] {
    try {
      return this.termRenderable.screen().lines
    } catch {
      return []
    }
  }

  /**
   * Structured pane-state probe (docs/terminal-layer.md "Pane state"): classify
   * the bottom of the LIVE SCREEN GRID (not the scanner ring) into
   * prompt/continuation/running/password-prompt/fullscreen. Best-effort and
   * never throws — an unrecognizable screen yields `unknown`. `shell_session`
   * pre-flights this before typing so a `dquote>` continuation or a waiting
   * password prompt is refused instead of swallowed.
   */
  paneState(tailLines = 8): PaneState {
    let cursorY: number | null = null
    try {
      cursorY = this.termRenderable.screen().cursor.y
    } catch {
      // Destroyed renderable: classify from the lines alone.
    }
    const facts = this.pty.status()
    return classifyPaneState({
      lines: this.screenText(),
      alternateOn: facts.alternateOn,
      commandRunning: facts.commandRunning,
      cwd: facts.cwd,
      shellPid: this.pid >= 0 ? this.pid : null,
      cursorY,
      tailLines,
    })
  }

  /**
   * Synchronous recent plain-text tail (scanner ring), for the per-message
   * context block. `n <= 0` returns the whole ring.
   */
  recentLines(n: number): string[] {
    return this.pty.recentLines(n)
  }

  /**
   * Deep capture for the agent's get_scrollback tool: the last N scanned
   * plain-text lines (clamped to the tool's hard cap of 5000).
   */
  async captureScrollbackRaw(lines: number): Promise<string> {
    return this.pty.captureScrollbackRaw(lines)
  }

  // -- focus / lifecycle ------------------------------------------------------

  focus(): void {
    try {
      this.termRenderable.focus()
    } catch {
      // ignore
    }
  }

  blur(): void {
    try {
      this.termRenderable.blur()
    } catch {
      // ignore
    }
  }

  /** Update the pane palette used to rewrite indexed colors (detected/override). */
  setPalette(palette: PanePalette | null): void {
    this.pty.setPalette(palette)
    this.painter.setPalette(palette)
    this.invalidate()
  }

  /** Toggle bold→bright promotion. */
  setBoldBright(on: boolean): void {
    this.pty.setBoldBright(on)
  }

  /** Update the theme default fg/bg: the SGR rewriter re-applies the fg for new
   * bytes, and the painter remaps the colors already on screen + repaints the
   * default background, so a theme change updates existing content immediately. */
  setDefaults(fg: Rgb | null, bg: Rgb | null): void {
    this.pty.setDefaults(fg, bg)
    this.painter.setDefaults(fg, bg)
    this.invalidate()
  }

  /** Force a recompose + render so a color change repaints the existing screen. */
  private invalidate(): void {
    try {
      this.termRenderable.invalidate()
    } catch {
      // destroyed renderable: ignore
    }
  }

  /** Register an exit listener; fires once, immediately if already dead. */
  onExit(cb: (code: number | null) => void): void {
    this.pty.onExit(cb)
  }

  /** Best-effort teardown: kill the child and close the PTY. Never throws. */
  kill(): void {
    this.pty.kill()
  }

  /** Child pid (-1 before spawn completes / after teardown). */
  get pid(): number {
    return this.pty.pid
  }

  /** The embedded terminal renderable (the UI mounts/manages it). */
  get renderable(): EmbeddedTerminalRenderable {
    return this.termRenderable
  }

  /** Resolves with the child exit code (null when unavailable). */
  get exited(): Promise<number | null> {
    return this.pty.exited
  }
}
