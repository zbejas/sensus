/**
 * Terminal-query-response leak guard (docs/terminal-layer.md "Input & focus").
 *
 * OpenTUI's stdin parser flushes an *incomplete* escape sequence after a 20 ms
 * timeout (`StdinParser`, `timeoutMs = 20`). A terminal's reply to sensus's
 * OSC 4/10/11 palette/theme probes or CSI capability probes is routinely split
 * across reads — notably over SSH, where the ssh client and the remote PTY
 * re-chunk the bytes. When the timeout lands between the head and the tail of a
 * reply, the parser emits the reply's HEAD as a dropped response and its TAIL as
 * ordinary KEY events. Because the embedded pane renderable owns key input while
 * focused, those bytes are typed straight into the visible shell — exactly the
 * `:ffff/ffff/ffff` / `]11;rgb:...` reports users see on the prompt.
 *
 * The guard sits on the pane's input path (`PtySession.write`, which the
 * renderable's `onData` routes into) and runs only over the bytes the
 * renderable encodes for key/paste/mouse input:
 *
 * - A chunk that BEGINS with ESC is a genuine encoded key (arrow/Alt/function
 *   keys, bracketed paste, SGR mouse) and is never a leaked reply tail (the
 *   flushed ESC arrives as its own Escape event) — it passes through untouched.
 * - Ordinary characters pass through untouched.
 * - A run that BEGINS with a byte that can open a reply (`: ; # [ ] r g b ? >`)
 *   is held briefly so the whole run can be classified: a run that reads as a
 *   terminal reply is dropped; anything else is released.
 * - After a reply is dropped, a short tail window keeps discarding residual reply
 *   bytes (hex, `/`, separators) even though they no longer begin with a marker —
 *   a reply split across several reads (`:ffff/ffff/ffff` then `0c`) arrives that
 *   way. A real keystroke ends the window.
 *
 * Holding is bounded (`RESPONSE_GUARD_HOLD_MS`, `RESPONSE_GUARD_TAIL_MS`) and every
 * byte is either dropped or eventually written, so the shell can lose a keystroke
 * only if the user literally types a reply-shaped run (a colour triplet,
 * `#rrggbb`, a numeric CSI reply, …) or types reply material within the tail
 * window right after a detected leak. The module is pure + incremental and never
 * throws.
 */

const ESC = 0x1b

/** How long a candidate run may be held before it is classified and released. */
export const RESPONSE_GUARD_HOLD_MS = 30

/**
 * After a reply run is dropped, keep discarding reply-tail bytes for this long.
 * A reply the ssh client/PTY split into several reads can arrive a read after the
 * run that identified it (the reported `:ffff/ffff/ffff` then `0c`); the residual
 * bytes no longer begin with a reply marker, so only a window catches them.
 */
export const RESPONSE_GUARD_TAIL_MS = 500

/** Hard cap on a held run, so a stalled/auto-repeating marker cannot grow it forever. */
const MAX_HELD = 256
/** Hard cap on bytes swallowed by the post-reply tail window. */
const MAX_TAIL_BYTES = 64

/** Bytes that can begin a terminal-reply tail (after the parser flushed its head). */
const RESPONSE_START = new Set<number>([
  0x3a, // :
  0x3b, // ;
  0x23, // #
  0x5b, // [
  0x5d, // ]
  0x72, // r  (rgb:)
  0x67, // g
  0x62, // b
  0x3f, // ?
  0x3e, // >
])

/** Bytes that may continue a reply: hex/digits/letters plus the reply punctuation. */
function isResponseByte(b: number): boolean {
  if (b >= 0x30 && b <= 0x39) return true // 0-9
  if (b >= 0x41 && b <= 0x5a) return true // A-Z
  if (b >= 0x61 && b <= 0x7a) return true // a-z
  switch (b) {
    case 0x3a: // :
    case 0x3b: // ;
    case 0x2f: // /
    case 0x23: // #
    case 0x5b: // [
    case 0x5d: // ]
    case 0x3f: // ?
    case 0x3e: // >
    case 0x3d: // =
    case 0x7e: // ~
    case 0x2e: // .
    case 0x2d: // -
    case 0x25: // %
    case 0x5c: // backslash (ST in a decoded reply)
      return true
    default:
      return false
  }
}

/**
 * Bytes swallowed by the post-reply tail window. Narrower than `isResponseByte`
 * on purpose: only colour/CSI payload material (hex, `/`, separators) so a real
 * keystroke right after a reply ends the window instead of being eaten.
 */
function isTailByte(b: number): boolean {
  if (b >= 0x30 && b <= 0x39) return true // 0-9
  if (b >= 0x61 && b <= 0x66) return true // a-f
  if (b >= 0x41 && b <= 0x46) return true // A-F
  switch (b) {
    case 0x2f: // /
    case 0x3a: // :
    case 0x3b: // ;
    case 0x23: // #
    case 0x2e: // .
    case 0x2d: // -
    case 0x7e: // ~
    case 0x3d: // =
      return true
    default:
      return false
  }
}

/** Reply grammars. Anchored, and strict enough that ordinary typing does not match. */
const RESPONSE_PATTERNS: readonly RegExp[] = [
  // OSC 4/10-19 colour replies: `11;rgb:ffff/ffff/ffff`, `4;0;rgb:…`, `rgb:…`.
  /^[;:\d]*rgb:[0-9a-f/]+$/i,
  // Bare `rgb:` tail (head ended at `…;`).
  /^rgb:[0-9a-f/]+$/i,
  // Colour triplet tail (`:ffff/ffff/ffff`, `ffff/ffff/ffff0c`).
  /^[;:]?[0-9a-f]{1,6}(?:\/[0-9a-f]{1,6}){2,}[0-9a-f]*$/i,
  // `#rrggbb` / `#rrggbbaa` replies.
  /^[;:\d]*#[0-9a-f]{6,}$/i,
  // CSI replies with parameters and a final (`[4;1080;1920t`, `[?62;c`, `[1;5R`).
  /^\[[?>]?[0-9;]{1,}[a-z~]$/i,
  // XTVERSION / XTGETTCAP replies.
  /^P[>|][^\x1b]*$/,
  // CPR tail (`;12R`).
  /^;\d+R$/,
]

/** Does a (possibly `]`-prefixed) candidate run read as a terminal reply? */
export function looksLikeTerminalResponse(raw: string): boolean {
  const run = raw.startsWith("]") ? raw.slice(1) : raw
  if (run.length < 4) return false
  return RESPONSE_PATTERNS.some((re) => re.test(run))
}

const EMPTY = new Uint8Array(0)
const ENCODER = new TextEncoder()

/**
 * Incremental response-leak guard. Feed encoded key chunks to `push`; write the
 * returned bytes to the PTY. While `pending`, call `flush` after
 * `RESPONSE_GUARD_HOLD_MS` of inactivity to classify and release the held run.
 */
export class ResponseLeakGuard {
  private held: number[] = []
  /** Deadline of the post-reply tail window (0 = inactive). */
  private tailUntil = 0
  private tailBytes = 0

  /** True while a candidate run is held (the caller should arm a flush timer). */
  get pending(): boolean {
    return this.held.length > 0
  }

  /** True while discarding reply-tail bytes after a dropped reply. */
  get tailActive(): boolean {
    return this.tailUntil !== 0
  }

  /**
   * Classify the held run and return whatever should be forwarded (often
   * nothing). `armTail` opens the post-reply tail window when the run is a reply
   * — the idle-timer call arms it; resolving a run that ended on a real byte
   * does not (that byte is not reply material).
   */
  flush(now: number = Date.now(), armTail = false): Uint8Array {
    if (this.held.length === 0) return EMPTY
    const run = String.fromCharCode(...this.held)
    this.held = []
    if (looksLikeTerminalResponse(run)) {
      if (armTail) {
        this.tailUntil = now + RESPONSE_GUARD_TAIL_MS
        this.tailBytes = 0
      }
      return EMPTY
    }
    return ENCODER.encode(run)
  }

  /** Feed one encoded input chunk; returns the bytes to forward to the PTY now. */
  push(bytes: Uint8Array, now: number = Date.now()): Uint8Array {
    if (bytes.length === 0) return EMPTY
    if (this.tailUntil !== 0 && (now >= this.tailUntil || this.tailBytes >= MAX_TAIL_BYTES)) {
      this.tailUntil = 0
      this.tailBytes = 0
    }

    // Genuine encoded keys/paste/mouse start with ESC and are never a reply tail.
    // The parser emits a flushed lone ESC as its own event (length 1), so any
    // multi-byte ESC chunk is real input — end any tail, resolve a held run, and
    // pass it on.
    if (bytes.length > 1 && bytes[0] === ESC) {
      this.tailUntil = 0
      this.tailBytes = 0
      const released = this.flush(now)
      if (released.length === 0) return bytes
      const out = new Uint8Array(released.length + bytes.length)
      out.set(released, 0)
      out.set(bytes, released.length)
      return out
    }

    const out: number[] = []
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!
      // Post-reply tail: swallow residual reply bytes even though they no longer
      // begin with a marker (a reply split across reads).
      if (this.tailUntil !== 0 && this.tailBytes < MAX_TAIL_BYTES && isTailByte(b)) {
        this.tailBytes++
        continue
      }
      if (this.tailUntil !== 0) {
        this.tailUntil = 0
        this.tailBytes = 0
      }
      if (this.held.length === 0) {
        if (RESPONSE_START.has(b)) this.held.push(b)
        else out.push(b)
        continue
      }
      if (isResponseByte(b)) {
        this.held.push(b)
        if (this.held.length >= MAX_HELD) {
          const released = this.flush(now)
          for (const r of released) out.push(r)
        }
        continue
      }
      // The held run ended: classify it, then handle this byte on its own.
      const released = this.flush(now)
      for (const r of released) out.push(r)
      if (RESPONSE_START.has(b)) this.held.push(b)
      else out.push(b)
    }
    return out.length === 0 ? EMPTY : Uint8Array.from(out)
  }
}
