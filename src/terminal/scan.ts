/**
 * Defensive incremental scanner over raw PTY output bytes.
 *
 * The native PTY (Bun.Terminal) hands us arbitrary byte chunks; OpenTUI's
 * EmbeddedTerminalRenderable owns the real VT state (screen, cursor, colors).
 * This module exists only for the facts the renderable does not expose to us:
 * a bounded plain-text line ring (for the agent's context tail) plus the
 * window title, the reported cwd (OSC 7) and the alt-screen flag. It is the
 * embedded-terminal analogue of tmux's `capture-pane` / `display-message`
 * status pull.
 *
 * Contract: NEVER throws and NEVER unbounded. Decoding is incremental
 * (TextDecoder `{ stream: true }`), incomplete escape sequences stay in a
 * small carry string capped at 64KB, and unknown bytes are ignored.
 */

/** Bounded ring of plain text lines, oldest -> newest.
 *
 * Backed by a fixed array with a moving head index, so a full ring overwrites
 * its oldest slot in O(1). The previous `Array.prototype.splice` evicted by
 * memmoving the whole buffer on every line once full — a 5000-element copy per
 * line under high line-rate output. */
export class TextRing {
  private readonly capacity: number
  private buf: string[]
  /** Index of the oldest retained line once the ring has wrapped. */
  private head = 0
  private count = 0

  constructor(capacity = 5000) {
    this.capacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 5000
    this.buf = new Array<string>(this.capacity)
  }

  pushLine(line: string): void {
    if (this.count < this.capacity) {
      this.buf[(this.head + this.count) % this.capacity] = line
      this.count++
      return
    }
    // Full: overwrite the oldest slot and advance the head — no memmove.
    this.buf[this.head] = line
    this.head = (this.head + 1) % this.capacity
  }

  lines(): string[] {
    const out = new Array<string>(this.count)
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(this.head + i) % this.capacity] ?? ""
    return out
  }

  clear(): void {
    this.buf = new Array<string>(this.capacity)
    this.head = 0
    this.count = 0
  }
}

/** Cap the pending escape carry so corrupt input cannot grow memory. */
const MAX_CARRY = 64 * 1024

function decodePercent(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    // Malformed percent escape: keep the raw path rather than throw.
    return text
  }
}

/**
 * OSC 7 payload -> cwd. Accepts `file://host/path` and `file:///path`
 * (missing host), percent-decoding the path. Returns null for anything else.
 */
export function parseOsc7(data: string): string | null {
  const withHost = /^file:\/\/([^/]*)(\/.*)$/.exec(data)
  if (withHost !== null) return decodePercent(withHost[2] ?? "")
  // Tolerate a host-less single-slash form (`file:/path`); `file://host`
  // (an authority with no path) is not a usable cwd.
  const noHost = /^file:\/([^/].*)$/.exec(data)
  if (noHost !== null) return decodePercent(`/${noHost[1] ?? ""}`)
  return null
}

/** Incremental PTY-output scanner; all accessors are safe on partial input. */
export class StreamScanner {
  private decoder = new TextDecoder()
  private carry = ""
  private line = ""
  /** Write column within `line` (so `\r` overwrites in place). */
  private col = 0
  private _title: string | null = null
  private _cwd: string | null = null
  private _alternateOn = false
  private _applicationCursor = false
  private _commandRunning = false
  private _lastExitCode: number | null = null

  readonly ring = new TextRing()

  get title(): string | null {
    return this._title
  }

  get cwd(): string | null {
    return this._cwd
  }

  get alternateOn(): boolean {
    return this._alternateOn
  }

  /** DECCKM (application cursor keys) from DECSET/DECRST `?1`. */
  get applicationCursor(): boolean {
    return this._applicationCursor
  }

  /** True between an OSC 133 `C` (command started) and `D` (finished). */
  get commandRunning(): boolean {
    return this._commandRunning
  }

  /** Exit code from the last OSC 133 `D;<code>`, or null when unknown. */
  get lastExitCode(): number | null {
    return this._lastExitCode
  }

  /** Feed a raw output chunk. Never throws. */
  push(bytes: Uint8Array): void {
    try {
      this.carry += this.decoder.decode(bytes, { stream: true })
      if (this.carry.length > MAX_CARRY) this.carry = ""
      this.parse()
    } catch {
      // Defensive: a decoder/native surprise must never reach the TUI.
    }
  }

  reset(): void {
    this.decoder = new TextDecoder()
    this.carry = ""
    this.line = ""
    this.col = 0
    this._title = null
    this._cwd = null
    this._alternateOn = false
    this._applicationCursor = false
    this._commandRunning = false
    this._lastExitCode = null
    this.ring.clear()
  }

  // -- character/line accumulation -------------------------------------------

  private putChar(ch: string): void {
    if (this.col >= this.line.length) {
      this.line += ch
    } else {
      this.line = this.line.slice(0, this.col) + ch + this.line.slice(this.col + ch.length)
    }
    this.col += ch.length
  }

  private pushCurrentLine(): void {
    this.ring.pushLine(this.line)
    this.line = ""
    this.col = 0
  }

  private parse(): void {
    const s = this.carry
    let i = 0
    while (i < s.length) {
      const ch = s.charCodeAt(i)
      if (ch === 0x1b) {
        const consumed = this.consumeEscape(s, i)
        if (consumed < 0) break // incomplete: keep from `i` in the carry
        i += consumed
        continue
      }
      if (ch === 0x0a) {
        this.pushCurrentLine()
        i++
        continue
      }
      if (ch === 0x0d) {
        // Carriage return rewinds the write column so the following text
        // overwrites in place. The buffer itself is kept — output lines end
        // with CRLF, and a progress bar (`50%\r100%`) must not lose `50%`
        // before the LF pushes the line.
        this.col = 0
        i++
        continue
      }
      if (ch === 0x09) {
        for (let k = 0; k < 4; k++) this.putChar(" ")
        i++
        continue
      }
      if (ch === 0x08) {
        this.col = Math.max(0, this.col - 1)
        i++
        continue
      }
      if (ch < 0x20 || ch === 0x7f) {
        i++ // other C0 controls / DEL: ignore
        continue
      }
      this.putChar(s[i] ?? "")
      i++
    }
    this.carry = s.slice(i)
    if (this.carry.length > MAX_CARRY) this.carry = ""
  }

  // -- escape sequences -------------------------------------------------------

  /** Consume one escape sequence starting at `i`; -1 when incomplete. */
  private consumeEscape(s: string, i: number): number {
    if (i + 1 >= s.length) return -1
    const c1 = s.charCodeAt(i + 1)
    if (c1 === 0x5b) return this.consumeCsi(s, i) // '['
    if (c1 === 0x5d) return this.consumeOsc(s, i) // ']'
    if (c1 === 0x50 || c1 === 0x51 || c1 === 0x58 || c1 === 0x5e || c1 === 0x5f) {
      // DCS 'P', SOS/Q 'Q'/'X', PM '^', APC '_': consume through ST/BEL.
      return this.consumeToSt(s, i, i + 2)
    }
    if (c1 === 0x28 || c1 === 0x29 || c1 === 0x2a || c1 === 0x2b) {
      // Charset designation: ESC ( X / ESC ) X / ESC * X / ESC + X.
      if (i + 2 >= s.length) return -1
      return 3
    }
    // Single-byte escapes (ESC =, ESC >, ESC 7, ESC 8, ESC M, ...).
    return 2
  }

  private consumeCsi(s: string, i: number): number {
    let j = i + 2
    while (j < s.length) {
      const c = s.charCodeAt(j)
      if (c >= 0x40 && c <= 0x7e) {
        this.applyCsi(s.slice(i + 2, j), s[j] ?? "")
        return j - i + 1
      }
      if (c < 0x20 || c === 0x7f) {
        // Malformed CSI (a control byte before the final): drop just ESC [ and
        // resume at the control byte so the rest of the stream still parses.
        return 2
      }
      j++
    }
    return -1
  }

  private consumeOsc(s: string, i: number): number {
    let j = i + 2
    while (j < s.length) {
      const c = s.charCodeAt(j)
      if (c === 0x07) {
        this.applyOsc(s.slice(i + 2, j))
        return j - i + 1
      }
      if (c === 0x1b) {
        if (j + 1 >= s.length) return -1
        if (s.charCodeAt(j + 1) === 0x5c) {
          this.applyOsc(s.slice(i + 2, j))
          return j - i + 2
        }
      }
      j++
    }
    return -1
  }

  private consumeToSt(s: string, i: number, start: number): number {
    let j = start
    while (j < s.length) {
      const c = s.charCodeAt(j)
      if (c === 0x07) return j - i + 1
      if (c === 0x1b) {
        if (j + 1 >= s.length) return -1
        if (s.charCodeAt(j + 1) === 0x5c) return j - i + 2
      }
      j++
    }
    return -1
  }

  private applyCsi(body: string, final: string): void {
    if (final !== "h" && final !== "l") return
    if (!body.startsWith("?")) return
    for (const part of body.slice(1).split(";")) {
      const n = Number.parseInt(part, 10)
      if (n === 47 || n === 1047 || n === 1049) this._alternateOn = final === "h"
      else if (n === 1) this._applicationCursor = final === "h"
    }
  }

  private applyOsc(payload: string): void {
    const semi = payload.indexOf(";")
    const cmd = semi === -1 ? payload : payload.slice(0, semi)
    const data = semi === -1 ? "" : payload.slice(semi + 1)
    if (cmd === "0" || cmd === "2") {
      this._title = data
      return
    }
    if (cmd === "7") {
      const cwd = parseOsc7(data)
      if (cwd !== null) this._cwd = cwd
      return
    }
    if (cmd === "133") this.applyOsc133(data)
  }

  /** OSC 133 shell-integration marks (FinalTerm): `A` prompt start, `B` command
   * line start, `C` command executed, `D;<exit>` command finished. We only need
   * the running flag and the last exit code. */
  private applyOsc133(data: string): void {
    const kind = data.charAt(0)
    if (kind === "A" || kind === "B") {
      this._commandRunning = false
      return
    }
    if (kind === "C") {
      this._commandRunning = true
      return
    }
    if (kind === "D") {
      this._commandRunning = false
      const rest = data.startsWith("D;") ? data.slice(2) : ""
      const code = Number.parseInt(rest, 10)
      this._lastExitCode = Number.isFinite(code) ? code : null
    }
  }
}
