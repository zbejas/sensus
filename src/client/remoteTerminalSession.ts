/**
 * RemoteTerminalSession — the CLIENT half of the terminal engine (P4c; D1/D2/
 * D4/D11/D12; docs/terminal-layer.md).
 *
 * The daemon owns the PTY and streams raw bytes over `/v1/ws`; this class owns
 * the embedded Ghostty VT (`EmbeddedTerminalRenderable`), the SGR palette
 * rewrite (`SgrColorRewriter`), the render-time `PanePainter` default-background
 * repaint, and key encoding. It is the drop-in replacement for
 * `src/terminal/session.ts`'s `TerminalSession`, which was the RENDERER half of
 * the old in-process PTY (now removed from the client, D5).
 *
 * Wiring:
 *   WS terminal.output (base64, end cursor) → rewriter → renderable.write + scanner
 *   renderable.onData (keys/mouse/DA replies) → WS terminal.input (base64)
 *   renderable.onTerminalResize → WS terminal.resize
 *   renderable screen grid → WS terminal.facts (debounced, D2)
 *   terminal.attached { replay, replayFrom, cursor, truncated, resetAlt } → replay → renderable
 *   terminal.status / terminal.exit → local status mirror + death
 *
 * The session tracks the daemon's absolute output cursor (`appliedCursor`): a
 * reconnect re-issues `terminal.attach` with it, so the daemon replays only the
 * missed bytes. A dropped frame (the daemon's bounded outbound queue drops
 * oldest) is detected from each `terminal.output` frame's end cursor and
 * repaired with a resync attach from the last applied offset — reattach is
 * resumable and idempotent, never a full repaint.
 *
 * Everything is defensive (AGENTS.md rule 10): a malformed frame, a WS error,
 * or a renderable failure is reported through `onError`, never thrown.
 */

import { EmbeddedTerminalRenderable, PasteEvent, type RenderContext } from "@opentui/core"
import { encodeKeyAction, installFunctionKeyEncoding, type KeyAction } from "../terminal/keys.ts"
import { PanePainter } from "../terminal/paneBg.ts"
import { classifyPaneState, type PaneState } from "../terminal/paneState.ts"
import type { TerminalStatus } from "../terminal/ptySession.ts"
import { StreamScanner } from "../terminal/scan.ts"
import { SgrColorRewriter, type PanePalette, type Rgb } from "../terminal/sgr.ts"
import { base64ToBytes, type WsClient } from "./wsClient.ts"
import type { ShellAttachResult, ShellRole } from "../daemon/index.ts"

/** Clamp a cell dimension to a positive integer. */
function normalizeSize(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1
}

/** Written before an alt-screen replay so the VT leaves the alternate screen
 * and starts from a clean grid (D12's reset marker). */
const ALT_RESET = new TextEncoder().encode("\x1b[?1049l\x1b[2J\x1b[H")

/** Consecutive failed resync attempts before auto-healing backs off (a
 * reconnect resets the budget; a permanently broken VT must not spin). */
const MAX_RESYNC_FAILURES = 5

export interface RemoteTerminalSessionOptions {
  /** The daemon transport (already connected/handshaking). */
  ws: WsClient
  /** The daemon-owned shell id. */
  shellId: string
  cols: number
  rows: number
  /** Renderer context for the embedded VT (omit only with `createRenderable`). */
  renderer?: RenderContext
  /** Native scrollback depth (default 10000). */
  maxScrollback?: number
  /** Initial palette for the SGR rewrite. */
  palette?: PanePalette | null
  /** Bold→bright promotion (default true). */
  boldBright?: boolean
  /** Theme default fg/bg. */
  defaultFg?: Rgb | null
  defaultBg?: Rgb | null
  /** Facts publish debounce in ms (default 120). */
  factsDebounceMs?: number
  /** Transport/renderable failure sink; never throws. */
  onError?: (message: string) => void
  /** Test seam: build the embedded VT without a real renderer. */
  createRenderable?: (opts: {
    cols: number
    rows: number
    maxScrollback: number
  }) => EmbeddedTerminalRenderable
}

/**
 * A remote terminal: a client-owned VT fed by the daemon's raw PTY stream.
 * Construct with `RemoteTerminalSession.create`, which sends `terminal.attach`.
 */
export class RemoteTerminalSession {
  readonly shellId: string
  cols: number
  rows: number

  private readonly ws: WsClient
  private readonly renderableRef: EmbeddedTerminalRenderable
  private readonly painter: PanePainter
  private readonly rewriter = new SgrColorRewriter()
  private readonly scanner = new StreamScanner()
  private readonly factsDebounceMs: number
  private readonly onError: ((message: string) => void) | undefined
  private readonly exitCallbacks: Array<(code: number | null) => void> = []
  private readonly unsubscribers: Array<() => void> = []

  /** Latest daemon `terminal.status` (cwd/alt/command-running/size/death). */
  private latest: TerminalStatus | null = null
  private role: ShellRole = "controller"
  private everAttached = false
  private dead = false
  private deadStatus: number | null = null
  private disposed = false
  /** Absolute daemon output offset the local VT has fully applied. */
  private appliedCursor = 0
  /** False until the first attach / after an apply failure: ask for a full replay. */
  private cursorValid = false
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private resyncInFlight = false
  /** Consecutive failed resync attempts; reset by a successful attach. */
  private resyncFailures = 0
  private factsTimer: ReturnType<typeof setTimeout> | null = null
  private readonly exitPromise: Promise<number | null>
  private resolveExit: (code: number | null) => void = () => {}

  private constructor(opts: RemoteTerminalSessionOptions, renderable: EmbeddedTerminalRenderable, painter: PanePainter) {
    this.ws = opts.ws
    this.shellId = opts.shellId
    this.cols = normalizeSize(opts.cols)
    this.rows = normalizeSize(opts.rows)
    this.renderableRef = renderable
    this.painter = painter
    this.factsDebounceMs = opts.factsDebounceMs ?? 120
    this.onError = opts.onError
    this.exitPromise = new Promise<number | null>((resolve) => {
      this.resolveExit = resolve
    })
    this.rewriter.setPalette(opts.palette ?? null)
    this.rewriter.setBoldBright(opts.boldBright ?? true)
    this.rewriter.setDefaults(opts.defaultFg ?? null, opts.defaultBg ?? null)
    this.subscribeEvents()
  }

  /**
   * Build the VT and attach to `shellId`. The daemon replies with a
   * `terminal.attached` event carrying the bounded replay (D12), which this
   * class applies before any live output.
   */
  static create(opts: RemoteTerminalSessionOptions): RemoteTerminalSession {
    const cols = normalizeSize(opts.cols)
    const rows = normalizeSize(opts.rows)
    const maxScrollback = opts.maxScrollback ?? 10000

    const painter = new PanePainter()
    painter.setPalette(opts.palette ?? null)
    painter.setDefaults(opts.defaultFg ?? null, opts.defaultBg ?? null)

    let renderable: EmbeddedTerminalRenderable
    if (opts.createRenderable !== undefined) {
      renderable = opts.createRenderable({ cols, rows, maxScrollback })
    } else {
      if (opts.renderer === undefined) {
        throw new Error("RemoteTerminalSession: renderer or createRenderable is required")
      }
      renderable = new EmbeddedTerminalRenderable(opts.renderer, {
        cols,
        rows,
        maxScrollback,
        renderAfter: (buffer) => {
          try {
            painter.paint(buffer.buffers.fg, buffer.buffers.bg)
          } catch {
            // A render-hook failure must never take down the frame.
          }
        },
      })
    }

    // F1–F12: OpenTUI's physicalKey() has no function-key mapping, so the
    // native encoder would drop them (keys.ts installFunctionKeyEncoding).
    installFunctionKeyEncoding(renderable)

    const session = new RemoteTerminalSession(opts, renderable, painter)
    // The real renderable's inputs go out over the wire. Attached after
    // construction so `session` exists; best-effort for a read-only fake.
    try {
      renderable.onData = (bytes) => {
        session.sendBytes(bytes)
      }
      renderable.onTerminalResize = (c, r) => {
        session.resize(c, r)
      }
    } catch {
      // ignore: a fake renderable may not expose these setters
    }
    session.attach()
    return session
  }

  // -- transport events -------------------------------------------------------

  private subscribeEvents(): void {
    this.unsubscribers.push(
      this.ws.on("terminal.output", (e) => {
        if (e.shellId === this.shellId) this.handleOutput(e.data, e.cursor)
      }),
      this.ws.on("terminal.attached", (e) => {
        if (e.shellId === this.shellId) this.handleAttached(e)
      }),
      this.ws.on("terminal.status", (e) => {
        if (e.shellId === this.shellId) this.handleStatus(e.status)
      }),
      this.ws.on("terminal.exit", (e) => {
        if (e.shellId === this.shellId) this.markDead(e.code)
      }),
    )
  }

  /** Rewrite + scan + write one pre-rewrite daemon byte chunk into the VT. */
  private applyBytes(bytes: Uint8Array): void {
    const out = this.rewriter.transform(bytes)
    this.scanner.push(out)
    this.renderableRef.write(out)
    this.scheduleFacts()
  }

  private handleOutput(data: string, frameCursor?: number): void {
    try {
      let bytes = base64ToBytes(data)
      if (bytes.byteLength === 0) return
      if (typeof frameCursor === "number" && Number.isSafeInteger(frameCursor)) {
        const start = frameCursor - bytes.byteLength
        if (start > this.appliedCursor) {
          // A frame was dropped (bounded outbound queue drop-oldest) or arrived
          // out of order: stop applying and resync from the last applied
          // offset; the daemon's replay covers this frame too.
          this.scheduleResync()
          return
        }
        if (frameCursor <= this.appliedCursor) return // fully applied already
        bytes = bytes.subarray(Math.max(0, this.appliedCursor - start))
        this.applyBytes(bytes)
        this.appliedCursor = frameCursor
        return
      }
      // A daemon that does not stamp frames (older wire): append and count.
      this.applyBytes(bytes)
      this.appliedCursor += bytes.byteLength
    } catch (e) {
      // The VT may now be missing bytes; force a full replay on the next attach
      // and try to heal now (bounded by the resync budget).
      this.cursorValid = false
      this.report(e)
      this.scheduleResync()
    }
  }

  private handleAttached(e: ShellAttachResult): void {
    this.role = e.role
    this.latest = e.status
    try {
      if (e.resetAlt) this.renderableRef.write(ALT_RESET)
      const replay = base64ToBytes(e.replay)
      const replayFrom = typeof e.replayFrom === "number" ? e.replayFrom : 0
      // Idempotent range application: skip everything the VT has already
      // applied (a duplicate/overlapping/resumed attach). A reset replay must
      // always be written whole because the VT was just cleared.
      let bytes = replay
      if (!e.resetAlt && this.appliedCursor > replayFrom) {
        bytes = replay.subarray(Math.min(this.appliedCursor - replayFrom, replay.byteLength))
      }
      if (bytes.byteLength > 0) this.applyBytes(bytes)
      const end = typeof e.cursor === "number" && Number.isSafeInteger(e.cursor) ? e.cursor : replayFrom + replay.byteLength
      this.appliedCursor = Math.max(this.appliedCursor, end)
      this.cursorValid = true
      this.resyncFailures = 0
      this.everAttached = true
      this.scheduleFacts()
    } catch (err) {
      this.cursorValid = false
      this.resyncFailures += 1
      this.report(err)
    }
  }

  private handleStatus(status: TerminalStatus): void {
    this.latest = status
    if (status.dead) this.markDead(status.deadStatus)
    this.scheduleFacts()
  }

  /** Debounced resync after a detected output-frame gap (bounded attempts). */
  private scheduleResync(): void {
    if (this.disposed || this.resyncInFlight || this.resyncTimer !== null) return
    if (this.resyncFailures >= MAX_RESYNC_FAILURES) return
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null
      if (this.disposed || this.resyncInFlight) return
      this.resyncInFlight = true
      void this.requestAttach(this.cursorValid ? this.appliedCursor : undefined)
        .catch((e: unknown) => {
          this.resyncFailures += 1
          this.report(e)
        })
        .finally(() => {
          this.resyncInFlight = false
        })
    }, 50)
    this.resyncTimer.unref?.()
  }

  /** Send `terminal.attach`; resolves after the daemon's response. */
  private requestAttach(cursor?: number): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const params = cursor === undefined
      ? { shellId: this.shellId, cols: this.cols, rows: this.rows }
      : { shellId: this.shellId, cols: this.cols, rows: this.rows, cursor }
    this.scheduleFacts()
    return this.ws.terminal.attach(params).then(() => {})
  }

  /** Send `terminal.attach` (initial, full replay; errors are reported, not thrown). */
  attach(): void {
    const cursor = this.cursorValid ? this.appliedCursor : undefined
    void this.requestAttach(cursor).catch((e: unknown) => this.report(e))
  }

  /**
   * Re-attach after the WS transport reconnected. Resumes from `appliedCursor`
   * (only the missed bytes are replayed); rejects when the attach fails so the
   * tab engine can rebuild a shell that no longer exists.
   */
  reattach(): Promise<void> {
    this.resyncFailures = 0
    const cursor = this.cursorValid ? this.appliedCursor : undefined
    return this.requestAttach(cursor)
  }

  /** Absolute daemon output offset this VT has applied (tests/diagnostics). */
  get outputCursor(): number {
    return this.appliedCursor
  }

  /** True once at least one `terminal.attached` has been applied. */
  get attached(): boolean {
    return this.everAttached
  }

  /** The role the daemon assigned this client (D11). */
  get currentRole(): ShellRole {
    return this.role
  }

  // -- facts (D2) -------------------------------------------------------------

  private scheduleFacts(): void {
    if (this.disposed) return
    if (this.factsTimer !== null) clearTimeout(this.factsTimer)
    this.factsTimer = setTimeout(() => {
      this.factsTimer = null
      this.publishFacts()
    }, this.factsDebounceMs)
    this.factsTimer.unref?.()
  }

  private publishFacts(): void {
    if (this.disposed || !this.everAttached) return
    try {
      const screen = this.renderableRef.screen()
      void this.ws.terminal
        .facts({ shellId: this.shellId, lines: screen.lines, cursor: screen.cursor })
        .catch(() => {
          // an observer (or a gone shell) may reject facts; never fatal
        })
    } catch {
      // renderable destroyed: skip this publish
    }
  }

  // -- screen / status --------------------------------------------------------

  /** Status mirrored from `terminal.status`, with the LOCAL VT cursor (D2). */
  status(): TerminalStatus {
    let cursorX = 0
    let cursorY = 0
    let cursorVisible = false
    try {
      const cursor = this.renderableRef.screen().cursor
      cursorX = cursor.x
      cursorY = cursor.y
      cursorVisible = cursor.visible
    } catch {
      // destroyed renderable: neutral cursor
    }
    const base: TerminalStatus = this.latest ?? {
      dead: this.dead,
      deadStatus: this.deadStatus,
      cols: this.cols,
      rows: this.rows,
      cwd: null,
      currentCommand: "",
      alternateOn: false,
      cursorX: null,
      cursorY: null,
      cursorVisible: false,
    }
    return {
      ...base,
      dead: this.dead || base.dead,
      deadStatus: this.deadStatus ?? base.deadStatus,
      cols: this.cols,
      rows: this.rows,
      cursorX,
      cursorY,
      cursorVisible,
    }
  }

  /** Visible screen lines (plain text, as composed by the renderable). */
  screenText(): string[] {
    try {
      return this.renderableRef.screen().lines
    } catch {
      return []
    }
  }

  /** Structured pane-state probe from the LOCAL grid + mirrored status. */
  paneState(tailLines = 8): PaneState {
    let cursorY: number | null = null
    try {
      cursorY = this.renderableRef.screen().cursor.y
    } catch {
      // destroyed renderable
    }
    const facts = this.status()
    return classifyPaneState({
      lines: this.screenText(),
      alternateOn: facts.alternateOn,
      commandRunning: facts.commandRunning ?? false,
      cwd: facts.cwd,
      shellPid: null,
      cursorY,
      tailLines,
    })
  }

  /** Synchronous recent plain-text tail (the client-side scanner ring). */
  recentLines(n: number): string[] {
    const all = this.scanner.ring.lines()
    if (!Number.isFinite(n) || n <= 0 || all.length <= n) return all
    return all.slice(all.length - n)
  }

  /** Deep capture for the agent's get_scrollback tool (clamped to 5000). */
  async captureScrollbackRaw(lines: number): Promise<string> {
    const requested = Number.isFinite(lines) ? Math.floor(lines) : 500
    const n = Math.min(Math.max(requested, 1), 5000)
    const all = this.scanner.ring.lines()
    if (all.length <= n) return all.join("\n")
    return all.slice(all.length - n).join("\n")
  }

  // -- input ------------------------------------------------------------------

  /** Send one key action (literal text or named keys) to the daemon shell. */
  async sendKeys(action: KeyAction): Promise<void> {
    try {
      const applicationCursor = this.latest?.applicationCursor ?? false
      this.sendBytes(encodeKeyAction(action, { applicationCursor }))
    } catch (e) {
      this.report(e)
    }
  }

  /** Send literal text to the shell. */
  async sendText(text: string): Promise<void> {
    if (text.length === 0) return
    this.sendBytes(new TextEncoder().encode(text))
  }

  /** Send host-clipboard text as a bracketed paste (the renderable encodes it). */
  pasteText(text: string): void {
    if (text.length === 0) return
    try {
      this.renderableRef.handlePaste(new PasteEvent(new TextEncoder().encode(text)))
    } catch {
      // renderable already destroyed
    }
  }

  /** Send raw bytes (keys/mouse/synthesized sequences) to the daemon shell. */
  sendBytes(bytes: Uint8Array): void {
    if (this.disposed || bytes.byteLength === 0) return
    void this.ws.terminal.input({ shellId: this.shellId, data: bytes }).catch((e: unknown) => this.report(e))
  }

  /** Resize the VT + the daemon PTY to a cell size (only when it changed). */
  resize(cols: number, rows: number): void {
    const c = normalizeSize(cols)
    const r = normalizeSize(rows)
    const changed = c !== this.cols || r !== this.rows
    this.cols = c
    this.rows = r
    try {
      this.renderableRef.width = c
      this.renderableRef.height = r
    } catch {
      // renderable already destroyed
    }
    if (changed) {
      void this.ws.terminal.resize({ shellId: this.shellId, cols: c, rows: r }).catch((e: unknown) => this.report(e))
    }
    this.scheduleFacts()
  }

  // -- palette / theme --------------------------------------------------------

  /** Update the palette used to rewrite indexed colors (detected/override). */
  setPalette(palette: PanePalette | null): void {
    this.rewriter.setPalette(palette)
    this.painter.setPalette(palette)
    this.invalidate()
  }

  /** Toggle bold→bright promotion. */
  setBoldBright(on: boolean): void {
    this.rewriter.setBoldBright(on)
  }

  /** Update the theme default fg/bg (rewriter + already-composed cells). */
  setDefaults(fg: Rgb | null, bg: Rgb | null): void {
    this.rewriter.setDefaults(fg, bg)
    this.painter.setDefaults(fg, bg)
    this.invalidate()
  }

  private invalidate(): void {
    try {
      this.renderableRef.invalidate()
    } catch {
      // destroyed renderable: ignore
    }
  }

  // -- focus / lifecycle ------------------------------------------------------

  focus(): void {
    try {
      this.renderableRef.focus()
    } catch {
      // ignore
    }
  }

  blur(): void {
    try {
      this.renderableRef.blur()
    } catch {
      // ignore
    }
  }

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

  /** Explicit close: ask the daemon to kill the shell (the PTY children die
   * there; D9). Call `dispose()` after to release the WS subscriptions. */
  kill(): void {
    void this.ws.terminal.kill({ shellId: this.shellId }).catch((e: unknown) => this.report(e))
  }

  /** Release WS subscriptions + timers (does not kill the shell). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.factsTimer !== null) {
      clearTimeout(this.factsTimer)
      this.factsTimer = null
    }
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer)
      this.resyncTimer = null
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // ignore
      }
    }
  }

  private markDead(code: number | null): void {
    if (this.dead) return
    this.dead = true
    this.deadStatus = code
    this.resolveExit(code)
    for (const cb of this.exitCallbacks) {
      try {
        cb(code)
      } catch {
        // A listener error must not escape the exit path.
      }
    }
  }

  /** The child pid. The daemon owns the shell, so the client never knows it. */
  get pid(): number {
    return -1
  }

  /** Resolves with the daemon shell's exit code (null when unavailable). */
  get exited(): Promise<number | null> {
    return this.exitPromise
  }

  /** The embedded terminal renderable (the UI mounts/manages it). */
  get renderable(): EmbeddedTerminalRenderable {
    return this.renderableRef
  }

  private report(e: unknown): void {
    try {
      this.onError?.(e instanceof Error ? e.message : String(e))
    } catch {
      // the error sink must never throw back into the session
    }
  }
}
