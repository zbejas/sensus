/**
 * Terminal scrollback controller — the pane's scrollbar geometry.
 *
 * The embedded VT owns its viewport, but OpenTUI exposes only `scroll(delta)`
 * and a composed screen: there is no "where am I" getter (docs/terminal-layer.md
 * "Capture & scrollback"). This module reconstructs the missing geometry:
 *
 * - **Calibration** measures the exact history depth with a relative scroll
 *   and a screen-unchanged probe. At any position, `scroll(+1)` changing the
 *   composed screen means the viewport is not pinned to the live bottom; binary
 *   search over the byte budget finds the row where down-scrolling stops
 *   moving. The probe is cursor-independent, so an app that hides the cursor
 *   (DECTCEM) or parks it mid-screen cannot fool it.
 * - **Tracking** keeps the viewport position between calibrations. Every native
 *   scroll passes through `noteNativeScroll` (the client wraps the renderable's
 *   native scroll call), and `scrollBy`/`scrollTo` are ours, so the row offset
 *   is exact; output only grows the history (`noteOutput`), which marks the
 *   geometry stale. Recalibration is throttled per state (pinned vs. scrolled).
 *
 * The module is renderer-free (a structural `ScrollbackViewport` seam), so the
 * engine barrel / daemon never touch `@opentui/core` and the controller is
 * unit-testable against a fake grid. Every method is safe on a detached or
 * no-op viewport and never throws.
 */

/** Renderer-free viewport surface the controller drives. */
export interface ScrollbackViewport {
  /** Scroll by `delta` rows (negative = up, positive = down); the VT clamps. */
  scroll(delta: number): void
  /** Compose the VT so `fingerprint()` reflects the current viewport. */
  compose(): void
  /** Hash of the composed viewport; equality means the screen did not move. */
  fingerprint(): number
  /** Viewport height in rows. */
  rows(): number
}

/** Scrollbar geometry handed to the UI (docs/ui.md "TerminalPane"). */
export interface TerminalScrollInfo {
  /** Viewport height in rows. */
  viewport: number
  /** Total addressable rows (history + viewport). */
  total: number
  /** Rows from the top of the addressable buffer to the viewport top. */
  position: number
  /** True when the viewport is pinned to the live bottom. */
  pinned: boolean
  /** True once a calibration has measured the geometry. */
  ready: boolean
  /** True while an alternate-screen app owns the VT (no scrollback there). */
  altScreen: boolean
}

export interface TerminalScrollbackOptions {
  viewport: ScrollbackViewport
  /** Byte budget handed to the renderable; bounds the calibration search. */
  maxScrollbackBytes: number
  /** Alternate-screen probe; while true the VT has no scrollback. */
  altScreen?: () => boolean
  /** Clock seam (ms); defaults to `Date.now`. */
  now?: () => number
}

/**
 * Ghostty's default scrollback budget (10 MB). OpenTUI's own 10_000 default is
 * a byte budget too — ~1_000 short lines — which is why deep history vanished.
 */
export const DEFAULT_PANE_SCROLLBACK_BYTES = 10_000_000

/** A calibration moves the viewport; throttle it per state. */
const SCROLL_RECALIBRATE_MS = 400
const SCROLLED_REFRESH_MS = 800
const PINNED_REFRESH_MS = 2500
/** `scroll(delta)` takes an i32; larger budgets clamp to this search bound. */
const MAX_SCROLL_DELTA = 0x7fffffff

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

export class TerminalScrollback {
  private readonly viewport: ScrollbackViewport
  private readonly bound: number
  private readonly altScreen: () => boolean
  private readonly now: () => number

  /** History rows above the viewport (0 = no history). */
  private max = 0
  /** Viewport top in rows from the addressable top. */
  private fromTop = 0
  /** True while the viewport follows the live bottom. */
  private pinned = true
  private ready = false
  /** True when output/resize may have changed the geometry since calibration. */
  private stale = false
  private altActive = false
  private lastCalibratedAt = Number.NEGATIVE_INFINITY

  constructor(opts: TerminalScrollbackOptions) {
    this.viewport = opts.viewport
    const bytes = Number.isFinite(opts.maxScrollbackBytes)
      ? Math.max(0, Math.floor(opts.maxScrollbackBytes))
      : DEFAULT_PANE_SCROLLBACK_BYTES
    this.bound = Math.min(bytes, MAX_SCROLL_DELTA)
    this.altScreen = opts.altScreen ?? (() => false)
    this.now = opts.now ?? Date.now
  }

  /** Output was applied: the history may have grown since calibration. */
  noteOutput(): void {
    if (this.altScreen()) return
    this.stale = true
  }

  /** The viewport was resized (reflow invalidates row coordinates). */
  noteResize(): void {
    this.stale = true
  }

  /** One native scroll already moved the viewport (wheel / wrapped call). */
  noteNativeScroll(delta: number): void {
    if (delta === 0 || this.altScreen()) return
    if (this.stale && this.due(SCROLL_RECALIBRATE_MS)) this.calibrate(this.pinned ? null : this.fromTop)
    this.applyDelta(delta)
  }

  /** Scroll by `delta` rows (the scrollbar's keyboard/page route). */
  scrollBy(delta: number): void {
    if (delta === 0 || this.altScreen()) return
    if (this.stale && this.due(SCROLL_RECALIBRATE_MS)) this.calibrate(this.pinned ? null : this.fromTop)
    this.applyDelta(delta)
    this.viewport.scroll(delta)
  }

  /** Jump the viewport top to `position` rows from the addressable top. */
  scrollTo(position: number): void {
    if (this.altScreen()) return
    if (this.stale && this.due(SCROLL_RECALIBRATE_MS)) this.calibrate(this.pinned ? null : this.fromTop)
    const start = this.pinned ? this.max : this.fromTop
    const target = clamp(Math.round(Number.isFinite(position) ? position : 0), 0, this.max)
    if (target !== start) this.viewport.scroll(target - start)
    this.fromTop = target
    this.pinned = target >= this.max
  }

  /** Force a fresh measurement, preserving the current viewport. */
  recalibrate(): void {
    if (this.altScreen()) return
    this.calibrate(this.pinned ? null : this.fromTop)
  }

  /** Current scrollbar geometry; may run a throttled calibration. */
  info(): TerminalScrollInfo {
    const viewport = Math.max(1, this.viewport.rows())
    if (this.altScreen()) {
      if (!this.altActive) {
        // Entering the alternate screen: the primary scrollback is untouched
        // but not addressable; re-measure when it returns.
        this.altActive = true
        this.stale = true
        this.ready = false
        this.max = 0
        this.fromTop = 0
        this.pinned = true
      }
      return { viewport, total: viewport, position: 0, pinned: true, ready: this.ready, altScreen: true }
    }
    if (this.altActive) {
      this.altActive = false
      this.stale = true
    }
    if (!this.ready || (this.stale && this.due(this.pinned ? PINNED_REFRESH_MS : SCROLLED_REFRESH_MS))) {
      this.calibrate(this.pinned ? null : this.fromTop)
    }
    return {
      viewport,
      total: this.max + viewport,
      position: this.pinned ? this.max : this.fromTop,
      pinned: this.pinned,
      ready: this.ready,
      altScreen: false,
    }
  }

  private applyDelta(delta: number): void {
    const start = this.pinned ? this.max : this.fromTop
    let next = start + delta
    if (next < 0) next = 0
    if (next >= this.max) {
      next = this.max
      this.pinned = true
    } else {
      this.pinned = false
    }
    this.fromTop = next
  }

  private due(intervalMs: number): boolean {
    return this.now() - this.lastCalibratedAt >= intervalMs
  }

  /**
   * Exact history depth via binary search over the byte budget. The viewport
   * ends at `preserve` (or the live bottom when null); all movement is
   * synchronous, so the user only ever sees the restored position.
   */
  private calibrate(preserve: number | null): void {
    if (this.bound <= 0) {
      this.max = 0
    } else {
      this.viewport.scroll(-this.bound)
      if (this.screenUnchangedAfterDown()) {
        this.max = 0
      } else {
        let lo = 1
        let hi = this.bound
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          this.viewport.scroll(-this.bound)
          this.viewport.scroll(mid)
          if (this.screenUnchangedAfterDown()) hi = mid
          else lo = mid + 1
        }
        this.max = lo
      }
    }
    this.viewport.scroll(this.bound) // the search may end above the bottom
    this.ready = true
    this.stale = false
    this.lastCalibratedAt = this.now()
    const target = preserve === null ? this.max : clamp(Math.round(preserve), 0, this.max)
    this.viewport.scroll(target - this.max)
    this.fromTop = target
    this.pinned = target >= this.max
  }

  /**
   * True when the composed screen does not move after scrolling down one row,
   * i.e. the viewport is pinned to the bottom. The probe restores the pre-probe
   * position when the screen did move.
   */
  private screenUnchangedAfterDown(): boolean {
    this.viewport.compose()
    const before = this.viewport.fingerprint()
    this.viewport.scroll(1)
    this.viewport.compose()
    const after = this.viewport.fingerprint()
    if (before !== after) this.viewport.scroll(-1)
    return before === after
  }
}
