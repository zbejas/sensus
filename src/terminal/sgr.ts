/**
 * SGR palette rewriter for the embedded terminal.
 *
 * Why this exists: OpenTUI's `EmbeddedTerminalRenderable` owns a FIXED built-in
 * palette (libghostty) and exposes no hook — `rendererSetPaletteState` affects
 * neither indexed colors nor the default background (verified). So an indexed
 * shell color (`\x1b[31m`) always painted the VT's own red, and every cell with
 * no explicit background painted the VT's opaque default — the pane stopped
 * following the user's terminal/theme palette.
 *
 * Fix: rewrite the child's OUTPUT SGR parameters before the bytes reach the VT,
 * which passes truecolor through untouched:
 *   - indexed fg/bg (basic, bright, `38;5;n`) → truecolor from the palette the
 *     host terminal reported (OSC 4) or the config `themePalette` override;
 *   - the DEFAULT fg (`\e[0m`, `\e[m`, `39`) → the active theme's fg truecolor,
 *     re-applied so text never falls back to the VT's own default. The default
 *     **bg** is left alone: an explicit bg truecolor on every cell corrupts the
 *     embedded VT's width-reflow (it double-spaces the screen on resize), so the
 *     background is painted by `PanePainter` in the composed frame instead.
 *
 * Scope: color parameters only. Attributes (bold/italic/underline/reverse/dim),
 * cursor motion, non-`m` escapes, and OSC pass through byte-for-byte. With no
 * palette AND no defaults the rewriter is a no-op. Pure + incremental across
 * chunk boundaries + never-throwing: a malformed or split sequence is copied.
 *
 * Rules (mirroring the old pane paint, applied on the way IN):
 * - `30-37` / `40-47` (basic): palette[index]
 * - `90-97` / `100-107` (bright): palette[index + 8]
 * - `38;5;n` / `48;5;n` (and colon form): palette[n] when known
 * - `38;2;r;g;b` (truecolor): untouched
 * - `0` / `39`: re-applied as the theme default fg; `49` is passed through
 * - bold→bright for a BASIC fg 0-7 (`1;31` → index 9), suppressed by dim,
 *   foreground only (`boldBright`, default on)
 */

import { isKonsoleDefaultPalette, parseHexColor } from "../theme/themePalette.ts"

/** index → RGB, or null when the terminal did not answer that entry. */
export type PanePaletteEntry = readonly [number, number, number] | null
export type PanePalette = ReadonlyArray<PanePaletteEntry>
export type Rgb = readonly [number, number, number]

/** Build the pane palette from detected/merged terminal colors. Unanswered
 * entries are null (left as indices). Returns null when nothing was answered.
 *
 * Konsole's OSC 4 answer is its COMPILED-IN default table, not the active
 * scheme (docs/config.md "themePalette"), so repainting the pane with it shows
 * saturated primaries that match neither the terminal nor the theme. The basic
 * 0-15 row is therefore treated as unanswered for a Konsole-lie detection and
 * the embedded VT resolves those indices against its own palette, matching the
 * no-detection (SSH) path. A `themePalette.palette` pin changes the row, so a
 * pinned Konsole is honored. Entries 16-255 (the standard cube) are kept. */
export function buildPanePalette(colors: {
  readonly palette: readonly (string | null)[]
} | null): PanePalette | null {
  if (colors === null) return null
  const ignoreBasic = isKonsoleDefaultPalette(colors)
  const out: PanePaletteEntry[] = []
  let any = false
  for (let i = 0; i < 256; i++) {
    if (ignoreBasic && i < 16) {
      out.push(null)
      continue
    }
    const parsed = parseHexColor(colors.palette[i] ?? null)
    if (parsed) {
      out.push([parsed.r, parsed.g, parsed.b])
      any = true
    } else {
      out.push(null)
    }
  }
  return any ? out : null
}

const ESC = 0x1b
const BRACKET = 0x5b // [
const M = 0x6d // m
const MAX_CARRY = 512
/** Shared empty carry: "nothing pending" allocates nothing. */
const NO_BYTES = new Uint8Array(0)

export interface SgrRewriterOptions {
  boldBright?: boolean
}

export class SgrColorRewriter {
  private palette: PanePalette | null = null
  private defaultFg: Rgb | null = null
  private defaultBg: Rgb | null = null
  private reapply = false
  private started = false
  private boldBright: boolean
  private carry: Uint8Array = NO_BYTES
  private bold = false
  private dim = false
  /** Reused output scratch. SGR rewrites only ever grow bytes (indexed colors
   * expand to truecolor), but a corrupt parameter run can still defeat that
   * assumption, so the buffer grows on demand. The exact-length `slice` result
   * is one typed-array copy — no boxed `number[]` + per-byte push. */
  private out = new Uint8Array(256)
  private outLen = 0

  constructor(opts: SgrRewriterOptions = {}) {
    this.boldBright = opts.boldBright ?? true
  }

  setPalette(palette: PanePalette | null): void {
    this.palette = palette
  }

  setBoldBright(on: boolean): void {
    this.boldBright = on
  }

  /** Theme default fg/bg. The fg is re-applied on reset/`39`; the bg is tracked
   * only so a theme/palette change invalidates the painter (the background is
   * painted by `PanePainter`, never through SGR — see `defaultParams`). null
   * leaves the VT default for that channel. */
  setDefaults(fg: Rgb | null, bg: Rgb | null): void {
    if (!sameRgb(this.defaultFg, fg) || !sameRgb(this.defaultBg, bg)) this.reapply = true
    this.defaultFg = fg
    this.defaultBg = bg
  }

  /** Rewrite colors/defaults in `input`; returns the bytes to feed the VT. */
  transform(input: Uint8Array): Uint8Array {
    const first = !this.started
    this.started = true
    const hasDefaults = this.defaultFg !== null || this.defaultBg !== null
    if (this.palette === null && !hasDefaults) {
      if (this.carry.length > 0) return this.mergeCarry(input)
      return input
    }

    // On the FIRST chunk (and on later theme/palette changes) assert the theme
    // default SGR so new bytes never fall back to the VT's own defaults.
    //
    // Deliberately NO background-color-erase (`\e[2J \e[H`) here: the embedded
    // VT, once it has seen a `\e[2J` clear, clears the visible screen the next
    // time it is width-resized (a sidebar/window resize wiped the pane back to
    // a fresh prompt — the "resize clears the terminal" bug). The blank/default
    // cells are painted by `PanePainter` from the renderable's `renderAfter`
    // hook on every composed frame anyway, so the erase was redundant.
    const needPrefix = (first || this.reapply) && hasDefaults
    this.reapply = false

    // Hot path: a chunk with no ESC byte cannot carry an SGR sequence, so there
    // is nothing to rewrite. Return the input BY REFERENCE (zero allocation)
    // when there is also no pending carry and no default prefix to assert.
    // This is the common case — a theme default fg is always seeded, so the old
    // "no palette AND no defaults" bail-out never fired.
    if (!needPrefix && this.carry.length === 0 && input.indexOf(ESC) < 0) return input

    const bytes = this.carry.length > 0 ? this.mergeCarry(input) : input
    this.outLen = 0
    if (needPrefix) this.writeSgr(this.defaultParams())

    let i = 0
    while (i < bytes.length) {
      const b = bytes[i] ?? 0
      if (b !== ESC) {
        this.emit(b)
        i++
        continue
      }
      if (i + 1 >= bytes.length) {
        this.carry = bytes.slice(i)
        break
      }
      if (bytes[i + 1] !== BRACKET) {
        this.emit(b)
        i++
        continue
      }
      let j = i + 2
      while (j < bytes.length && !((bytes[j] ?? 0) >= 0x40 && (bytes[j] ?? 0) <= 0x7e)) j++
      if (j >= bytes.length) {
        const tail = bytes.slice(i)
        if (tail.length > MAX_CARRY) {
          for (let k = 0; k < tail.length; k++) this.emit(tail[k] ?? 0)
        } else {
          this.carry = tail
        }
        break
      }
      const final = bytes[j] ?? 0
      if (final !== M) {
        for (let k = i; k <= j; k++) this.emit(bytes[k] ?? 0)
        i = j + 1
        continue
      }
      const rewritten = this.rewriteParams(latin1(bytes, i + 2, j))
      this.emit(ESC)
      this.emit(BRACKET)
      for (let c = 0; c < rewritten.length; c++) this.emit(rewritten.charCodeAt(c))
      this.emit(M)
      i = j + 1
    }
    return this.takeOut()
  }

  /** Merge a held incomplete escape with the next chunk (rare: only after a
   * split sequence). */
  private mergeCarry(input: Uint8Array): Uint8Array {
    const merged = new Uint8Array(this.carry.length + input.length)
    merged.set(this.carry, 0)
    merged.set(input, this.carry.length)
    this.carry = NO_BYTES
    return merged
  }

  /** Grow the scratch buffer so `extra` more bytes fit. */
  private ensure(extra: number): void {
    const need = this.outLen + extra
    if (need <= this.out.length) return
    let cap = this.out.length > 0 ? this.out.length : 256
    while (cap < need) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.out.subarray(0, this.outLen))
    this.out = next
  }

  private emit(b: number): void {
    this.ensure(1)
    this.out[this.outLen++] = b
  }

  /** Write `ESC [ <params joined by ;> m` into the scratch buffer. */
  private writeSgr(params: readonly string[]): void {
    if (params.length === 0) return
    const text = params.join(";")
    this.ensure(text.length + 3)
    this.out[this.outLen++] = ESC
    this.out[this.outLen++] = BRACKET
    for (let i = 0; i < text.length; i++) this.out[this.outLen++] = text.charCodeAt(i)
    this.out[this.outLen++] = M
  }

  /** Copy the scratch result out at its exact length and reset the cursor. */
  private takeOut(): Uint8Array {
    const result = this.out.slice(0, this.outLen)
    this.outLen = 0
    return result
  }

  /** The theme default FOREGROUND SGR params, re-applied on reset/`39`.
   *
   * The default **background** is deliberately NOT re-applied here. Painting an
   * explicit bg truecolor onto every reset/reset/49 cell makes the embedded VT's
   * width-reflow emit a blank row after every content row (the "resize
   * double-spaces the pane" bug). The `PanePainter` already repaints the VT's
   * opaque-black default-background cells with the theme bg on every composed
   * frame, so the default background follows the theme without any SGR here. */
  private defaultParams(): string[] {
    const parts: string[] = []
    if (this.defaultFg) parts.push(`38;2;${this.defaultFg[0]};${this.defaultFg[1]};${this.defaultFg[2]}`)
    return parts
  }

  /** Rewrite one SGR parameter list (between `ESC [` and `m`). */
  private rewriteParams(params: string): string {
    const pal = this.palette
    const defaults = this.defaultParams()
    if (params === "" || params === "0") {
      this.bold = false
      this.dim = false
      return ["0", ...defaults].join(";")
    }
    const tokens = params.split(";")
    const out: string[] = []
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t] ?? ""
      const num = /^\d+$/.test(token) ? Number(token) : null

      // Extended color: "38"/"48" followed by 5;n or 2;r;g;b (semicolon form).
      if ((token === "38" || token === "48") && t + 1 < tokens.length) {
        const mode = tokens[t + 1] ?? ""
        if (mode === "5" && t + 2 < tokens.length) {
          const n = Number(tokens[t + 2])
          const rgb = pal !== null && Number.isInteger(n) ? pal[n] ?? null : null
          if (rgb !== null) out.push(`${token};2;${rgb[0]};${rgb[1]};${rgb[2]}`)
          else out.push(token, mode, tokens[t + 2] ?? "")
          t += 2
          continue
        }
        if (mode === "2") {
          out.push(token, mode)
          for (let k = t + 2; k < tokens.length && k < t + 5; k++) out.push(tokens[k] ?? "")
          t += 4
          continue
        }
        out.push(token)
        continue
      }

      // Colon form: "38:5:n" / "38:2::r:g:b" arrive as ONE token.
      if (/^(38|48)[:]/.test(token)) {
        out.push(pal !== null ? this.rewriteColonExtended(token, pal) : token)
        continue
      }

      if (num !== null) {
        if (num === 0) {
          this.bold = false
          this.dim = false
          out.push("0", ...defaults)
          continue
        }
        if (num === 1) {
          this.bold = true
          out.push("1")
          continue
        }
        if (num === 2) {
          this.dim = true
          out.push("2")
          continue
        }
        if (num === 22) {
          this.bold = false
          this.dim = false
          out.push("22")
          continue
        }
        if (num === 39) {
          out.push(this.defaultFg ? `38;2;${this.defaultFg[0]};${this.defaultFg[1]};${this.defaultFg[2]}` : "39")
          continue
        }
        if (num === 49) {
          // Leave the default background to the VT; the PanePainter themes it
          // (applying it here would corrupt the VT's resize reflow).
          out.push("49")
          continue
        }
        if (pal !== null && num >= 30 && num <= 37) {
          let idx = num - 30
          if (this.boldBright && this.bold && !this.dim) idx += 8
          out.push(rgbParam(38, pal[idx] ?? pal[num - 30] ?? null, num))
          continue
        }
        if (pal !== null && num >= 90 && num <= 97) {
          out.push(rgbParam(38, pal[8 + (num - 90)] ?? null, num))
          continue
        }
        if (pal !== null && num >= 40 && num <= 47) {
          out.push(rgbParam(48, pal[num - 40] ?? null, num))
          continue
        }
        if (pal !== null && num >= 100 && num <= 107) {
          out.push(rgbParam(48, pal[8 + (num - 100)] ?? null, num))
          continue
        }
      }
      out.push(token)
    }
    return out.join(";")
  }

  /** "38:5:n" / "48:5:n" / "38:2::r:g:b" colon-form extended colors. */
  private rewriteColonExtended(token: string, pal: PanePalette): string {
    const parts = token.split(":")
    const base = parts[0] === "48" ? 48 : 38
    if (parts[1] === "5") {
      const n = Number(parts[2])
      const rgb = Number.isInteger(n) ? pal[n] ?? null : null
      return rgb !== null ? `${base};2;${rgb[0]};${rgb[1]};${rgb[2]}` : token
    }
    return token
  }
}

function rgbParam(base: 38 | 48, rgb: PanePaletteEntry, original: number): string {
  return rgb !== null ? `${base};2;${rgb[0]};${rgb[1]};${rgb[2]}` : String(original)
}

/** Structural RGB equality (null-safe): the shared comparator for palette/theme deltas. */
export function sameRgb(a: Rgb | null, b: Rgb | null): boolean {
  if (a === null || b === null) return a === b
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  const len = end - start
  if (len <= 0) return ""
  // Spread in bounded chunks: a corrupt input can put a very long parameter run
  // before the CSI final byte, and one unbounded spread would blow the argument
  // stack. Short parameter lists (the common case) take the single-spread path.
  const CHUNK = 1024
  if (len <= CHUNK) return String.fromCharCode(...bytes.subarray(start, end))
  let s = ""
  for (let i = start; i < end; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, end)))
  }
  return s
}
