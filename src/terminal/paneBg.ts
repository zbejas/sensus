/**
 * Pane render-time color paint (embedded terminal).
 *
 * The embedded VT composes colors into its own frame buffer as plain RGB and
 * exposes no palette hook. Two consequences:
 *
 * 1. Its **default background** is opaque black (`[0,0,0,255]` per cell), so
 *    blank cells — and every cell the VT redraws on resize/scroll/reflow —
 *    would show black regardless of the theme. `paintDefaultBackground` repaints
 *    those cells with the theme background.
 * 2. It **freezes** the colors the SGR rewriter applied (`sgr.ts`) into each
 *    cell, so switching theme leaves already-written text on the old theme's
 *    fg/bg — the SGR rewriter only affects the next bytes. `PanePainter` keeps a
 *    source-color → current-color map (the previous theme/palette defaults and
 *    palette entries mapped to the current ones, composed across changes) and
 *    applies it to every cell on every composed frame, so existing content
 *    repaints immediately on a theme or palette change.
 *
 * Both run in the renderable's `renderAfter` hook, which receives the
 * renderable's own frame buffer after the VT has composed into it.
 *
 * Frame-buffer layout: `fg`/`bg` are `Uint16Array`s with 4 entries per cell
 * (r,g,b,a); the low byte of each `Uint16` holds the 0-255 value and the high
 * byte holds OpenTUI's color-intent metadata (0 for plain RGB). Only the low
 * byte is rewritten here; metadata is preserved.
 */

import { sameRgb, type PanePalette, type Rgb } from "./sgr.ts"

/** Pack an RGB triple into a 24-bit int (map key). */
function pack(rgb: Rgb): number {
  return ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff)
}

/** Repaint the VT's default-background cells in `bg` with `rgb`. */
export function paintDefaultBackground(bg: Uint16Array, rgb: Rgb | null): void {
  if (rgb === null) return
  const r = rgb[0]
  const g = rgb[1]
  const b = rgb[2]
  if (r === 0 && g === 0 && b === 0) return // theme bg is black: nothing to do
  for (let i = 0; i < bg.length; i += 4) {
    if (bg[i] === 0 && bg[i + 1] === 0 && bg[i + 2] === 0 && bg[i + 3] === 0xff) {
      bg[i] = r
      bg[i + 1] = g
      bg[i + 2] = b
    }
  }
}

/** Rewrite every cell's RGB in `channel` through `map` (value → value). */
function applyMap(channel: Uint16Array, map: Map<number, number>): void {
  for (let i = 0; i < channel.length; i += 4) {
    const key = ((channel[i]! & 0xff) << 16) | ((channel[i + 1]! & 0xff) << 8) | (channel[i + 2]! & 0xff)
    const to = map.get(key)
    if (to !== undefined) {
      channel[i] = (channel[i]! & 0xff00) | ((to >> 16) & 0xff)
      channel[i + 1] = (channel[i + 1]! & 0xff00) | ((to >> 8) & 0xff)
      channel[i + 2] = (channel[i + 2]! & 0xff00) | (to & 0xff)
    }
  }
}

/**
 * Per-session pane color applier. Tracks the theme default fg/bg and the pane
 * palette, and keeps a composed source → current color map so a live theme or
 * palette change repaints content already on screen (the VT froze its colors).
 */
export class PanePainter {
  private map = new Map<number, number>()
  private fg: Rgb | null = null
  private bg: Rgb | null = null
  private palette: PanePalette | null = null

  /** Update the theme default fg/bg (from `App` on theme/palette change). */
  setDefaults(fg: Rgb | null, bg: Rgb | null): void {
    const delta = new Map<number, number>()
    if (!sameRgb(this.fg, fg) && this.fg !== null && fg !== null) delta.set(pack(this.fg), pack(fg))
    if (!sameRgb(this.bg, bg) && this.bg !== null && bg !== null) delta.set(pack(this.bg), pack(bg))
    this.compose(delta)
    this.fg = fg
    this.bg = bg
  }

  /** Update the pane palette (indexed colors resolved by the SGR rewriter). */
  setPalette(palette: PanePalette | null): void {
    const delta = new Map<number, number>()
    if (this.palette !== null && palette !== null) {
      const n = Math.min(this.palette.length, palette.length)
      for (let i = 0; i < n; i++) {
        const from = this.palette[i] ?? null
        const to = palette[i] ?? null
        if (from !== null && to !== null && !sameRgb(from, to)) delta.set(pack(from), pack(to))
      }
    }
    this.compose(delta)
    this.palette = palette
  }

  /** Fold a prev → next delta into the standing source → current map. */
  private compose(delta: Map<number, number>): void {
    if (delta.size === 0) return
    const merged = new Map<number, number>()
    for (const [from, to] of this.map) merged.set(from, delta.get(to) ?? to)
    for (const [from, to] of delta) merged.set(from, to)
    this.map = merged
  }

  /** Repaint one composed frame: remap frozen colors, then the default bg. */
  paint(fg: Uint16Array, bg: Uint16Array): void {
    if (this.map.size > 0) {
      applyMap(fg, this.map)
      applyMap(bg, this.map)
    }
    if (this.bg !== null) paintDefaultBackground(bg, this.bg)
  }
}
