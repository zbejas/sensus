/**
 * Key encoding: opentui key events -> raw PTY bytes.
 *
 * The embedded-terminal replacement for the old tmux `send-keys` encoder.
 * The KeyAction vocabulary is IDENTICAL, so existing
 * callers (ui/chat/prefix.ts, ui/components/App.tsx, agent/tools.ts) keep
 * working once they are repointed at this module:
 *
 *   { kind: "literal"; text }  -> UTF-8 bytes of the text
 *   { kind: "keys"; names }    -> concatenated raw escape sequences
 *
 * The names emitted by `mapKeyEventToAction` are the same tmux spellings as
 * before (`Enter`, `Tab`, `BSpace`, `Up`, `C-C`, `M-X`, `S-Tab`, `F5`, ...)
 * so anything that builds KeyActions by hand (prefix.ts's `C-A`, tools.ts's
 * `Enter`) keeps producing the same actions.
 *
 * Pure module: no opentui / PTY imports so it stays trivially unit-testable.
 */

/** Minimal structural subset of @opentui/core KeyEvent we depend on. */
export interface KeyInfo {
  /** opentui key name: "a", "A", "return", "tab", "up", "f5", ... */
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** The raw sequence as parsed; for printable keys equals `name`. */
  sequence: string
}

export type KeyAction =
  /** Send literal text. */
  | { kind: "literal"; text: string }
  /** Send named keys (tmux-style spellings; see NAMED_KEYS + modifier forms). */
  | { kind: "keys"; names: string[] }

const NAMED_KEYS: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  backspace: "BSpace",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  delete: "Delete",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
}

/** Modifier prefix in tmux key-name order. */
function modifierPrefix(k: KeyInfo): string {
  let p = ""
  if (k.ctrl) p += "C-"
  if (k.meta) p += "M-"
  if (k.shift) p += "S-"
  return p
}

/**
 * Map one opentui key event to a key action (ported verbatim from
 * `mapKeyToTmux`; only the consumer changes). Returns null when the key cannot
 * be represented and should be dropped.
 */
export function mapKeyEventToAction(k: KeyInfo): KeyAction | null {
  const name = k.name
  if (!name) return null

  // Printable single character: send literally. Two cases (opentui reports
  // shifted letters as the BASE name with shift=true — verified in
  // @opentui/core parse.keypress: `key.name = s.toLowerCase(); key.shift = true`):
  //   - shifted letter: reconstruct the uppercase glyph
  //   - everything else (incl. shifted punctuation like "!"): name is the glyph
  // Ctrl/meta are handled below; shift never needs a prefix here.
  if (name.length === 1 && !k.ctrl && !k.meta) {
    if (k.shift && name >= "a" && name <= "z") {
      return { kind: "literal", text: name.toUpperCase() }
    }
    return { kind: "literal", text: name }
  }

  // Space by name (opentui names it "space"); the literal " " also works, but
  // treat it like a named key when modifiers are held (C-Space etc.).
  if (name === "space") {
    if (!k.ctrl && !k.meta && !k.shift) return { kind: "literal", text: " " }
    return { kind: "keys", names: [`${modifierPrefix(k)}Space`] }
  }

  const named = NAMED_KEYS[name]
  if (named) {
    // Plain (unmodified) named key.
    if (!k.ctrl && !k.meta && !k.shift) return { kind: "keys", names: [named] }
    // Modifier combos: C-Enter, M-Left, S-Tab, C-M-Up, ...
    return { kind: "keys", names: [`${modifierPrefix(k)}${named}`] }
  }

  // Ctrl/Meta + letter (e.g. C-a, M-x, C-M-c). opentui reports `name` as the
  // unshifted letter for ctrl/meta combos.
  if ((k.ctrl || k.meta) && name.length === 1) {
    const upper = name.toUpperCase()
    return { kind: "keys", names: [`${modifierPrefix(k)}${upper}`] }
  }

  return null
}

/**
 * Agent-facing key names -> key actions (shell_session's `keys` param). Ported
 * from `agentKeyToTmux`; accepted spellings (case-insensitive):
 *   plain:  enter/tab/escape/esc/backspace/space/up/down/left/right/home/end/
 *           pageup/pgup/pagedown/pgdn/delete/insert/f1..f12
 *   combos: ctrl+c | c-c | alt+x | m-x | shift+tab | s-tab (and multi-modifier
 *           forms like ctrl+alt+del)
 * Unknown/unmappable names are dropped (return null, never crash the call).
 */
export function agentKeyAction(raw: string): KeyAction | null {
  const s = raw.trim().toLowerCase().replace(/\+/g, "-")
  if (s.length === 0) return null
  const named: Record<string, string> = {
    enter: "return",
    return: "return",
    tab: "tab",
    escape: "escape",
    esc: "escape",
    backspace: "backspace",
    space: "space",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    home: "home",
    end: "end",
    pageup: "pageup",
    pgup: "pageup",
    pagedown: "pagedown",
    pgdn: "pagedown",
    delete: "delete",
    del: "delete",
    insert: "insert",
    ins: "insert",
  }
  let mods = { ctrl: false, meta: false, shift: false }
  let name = s
  for (;;) {
    const m = /^(ctrl|control|alt|meta|shift|c|m|s)-(.+)$/.exec(name)
    if (!m) break
    const mod = m[1] ?? ""
    name = m[2] ?? ""
    if (mod === "ctrl" || mod === "control" || mod === "c") mods = { ...mods, ctrl: true }
    else if (mod === "alt" || mod === "meta" || mod === "m") mods = { ...mods, meta: true }
    else mods = { ...mods, shift: true }
  }
  if (name.length === 0) return null
  // Single character: literal (shift+letter reconstructed by
  // mapKeyEventToAction); with ctrl/meta the letter is not in `named` —
  // mapKeyEventToAction's modifier branch handles it (C-C / M-X).
  if (name.length === 1) {
    return mapKeyEventToAction({ name, ctrl: mods.ctrl, meta: mods.meta, shift: mods.shift, sequence: name })
  }
  const base = named[name] ?? (/^f([1-9]|1[0-2])$/.test(name) ? name : null)
  if (base === null) return null
  return mapKeyEventToAction({ name: base, ctrl: mods.ctrl, meta: mods.meta, shift: mods.shift, sequence: "" })
}

/** Map a pasted chunk of text to a single literal action. */
export function pasteAction(text: string): KeyAction {
  return { kind: "literal", text }
}

// ---- Raw byte encoding ------------------------------------------------------

const encoder = new TextEncoder()

function byteSeq(...values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

/** Concatenate byte sequences (used for literals + multi-byte combos). */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/**
 * Base byte sequence per named key (lowercased). Covers every spelling
 * `mapKeyEventToAction` emits (tmux names) plus the agent/tool spellings.
 */
const NAMED_BYTES: Record<string, Uint8Array> = {
  return: byteSeq(0x0d),
  enter: byteSeq(0x0d),
  tab: byteSeq(0x09),
  btab: byteSeq(0x1b, 0x5b, 0x5a), // back-tab: ESC [ Z
  bspace: byteSeq(0x7f),
  backspace: byteSeq(0x7f),
  escape: byteSeq(0x1b),
  esc: byteSeq(0x1b),
  space: byteSeq(0x20),
  up: byteSeq(0x1b, 0x5b, 0x41),
  down: byteSeq(0x1b, 0x5b, 0x42),
  right: byteSeq(0x1b, 0x5b, 0x43),
  left: byteSeq(0x1b, 0x5b, 0x44),
  home: byteSeq(0x1b, 0x5b, 0x48),
  end: byteSeq(0x1b, 0x5b, 0x46),
  ppage: byteSeq(0x1b, 0x5b, 0x35, 0x7e),
  pageup: byteSeq(0x1b, 0x5b, 0x35, 0x7e),
  npage: byteSeq(0x1b, 0x5b, 0x36, 0x7e),
  pagedown: byteSeq(0x1b, 0x5b, 0x36, 0x7e),
  delete: byteSeq(0x1b, 0x5b, 0x33, 0x7e),
  ic: byteSeq(0x1b, 0x5b, 0x32, 0x7e),
  insert: byteSeq(0x1b, 0x5b, 0x32, 0x7e),
  f1: byteSeq(0x1b, 0x4f, 0x50),
  f2: byteSeq(0x1b, 0x4f, 0x51),
  f3: byteSeq(0x1b, 0x4f, 0x52),
  f4: byteSeq(0x1b, 0x4f, 0x53),
  f5: byteSeq(0x1b, 0x5b, 0x31, 0x35, 0x7e),
  f6: byteSeq(0x1b, 0x5b, 0x31, 0x37, 0x7e),
  f7: byteSeq(0x1b, 0x5b, 0x31, 0x38, 0x7e),
  f8: byteSeq(0x1b, 0x5b, 0x31, 0x39, 0x7e),
  f9: byteSeq(0x1b, 0x5b, 0x32, 0x30, 0x7e),
  f10: byteSeq(0x1b, 0x5b, 0x32, 0x31, 0x7e),
  f11: byteSeq(0x1b, 0x5b, 0x32, 0x33, 0x7e),
  f12: byteSeq(0x1b, 0x5b, 0x32, 0x34, 0x7e),
}

interface KeyMods {
  ctrl: boolean
  meta: boolean
  shift: boolean
}

/** Encoder mode flags. */
export interface EncodeOptions {
  /** DECCKM is active: unmodified arrows/Home/End emit SS3 (`ESC O A`)
   * instead of CSI (`ESC [ A`). */
  applicationCursor?: boolean
}

/**
 * Application-cursor (DECCKM) forms for the nav keys. Full-screen apps that
 * enable DECCKM (`CSI ? 1 h`) expect these SS3 sequences for unmodified keys.
 * Modified forms keep the CSI modifier parameter, per xterm.
 */
const APPLICATION_CURSOR_BYTES: Record<string, Uint8Array> = {
  up: byteSeq(0x1b, 0x4f, 0x41),
  down: byteSeq(0x1b, 0x4f, 0x42),
  right: byteSeq(0x1b, 0x4f, 0x43),
  left: byteSeq(0x1b, 0x4f, 0x44),
  home: byteSeq(0x1b, 0x4f, 0x48),
  end: byteSeq(0x1b, 0x4f, 0x46),
}

/** ASCII decode of a short escape sequence (all our table entries are ASCII). */
function sequenceText(base: Uint8Array): string {
  return String.fromCharCode(...base)
}

/**
 * Encode a single-character combo (C-x, M-x, C-M-x, S-x, ...). The tmux name
 * convention uppercases the base glyph for ctrl/meta combos; shift is carried
 * separately in the modifier prefix, so an unshifted combo is lowercased.
 */
function encodeCharCombo(ch: string, mods: KeyMods): Uint8Array | null {
  const lower = ch.toLowerCase()
  if (mods.ctrl) {
    let ctrlByte: number
    if (ch === " " || ch === "@") ctrlByte = 0x00
    else if (lower >= "a" && lower <= "z") ctrlByte = lower.charCodeAt(0) & 0x1f
    else if (ch === "?") ctrlByte = 0x7f
    else return null
    return mods.meta ? byteSeq(0x1b, ctrlByte) : byteSeq(ctrlByte)
  }
  let glyph = ch
  if (mods.shift && lower >= "a" && lower <= "z") glyph = lower.toUpperCase()
  else if (!mods.shift && ch >= "A" && ch <= "Z") glyph = lower
  const out = encoder.encode(glyph)
  return mods.meta ? concat([byteSeq(0x1b), out]) : out
}

/**
 * Apply modifiers to a named key. Arrows / Home / End / F-keys / nav keys use
 * the xterm CSI modifier parameter (`ESC [ 1 ; <m> <final>`); Alt/Meta on the
 * remaining keys (Enter, Tab, ...) is an ESC prefix. Ctrl/Shift on keys with
 * no portable encoding fall back to the base sequence.
 */
function applyNamedModifiers(base: Uint8Array, mods: KeyMods): Uint8Array {
  const modifier = 1 + (mods.shift ? 1 : 0) + (mods.meta ? 2 : 0) + (mods.ctrl ? 4 : 0)
  const text = sequenceText(base)
  const csi = text.startsWith("\x1b[")
  const ss3 = text.startsWith("\x1bO")
  if ((csi || ss3) && modifier > 1) {
    const final = text.slice(-1)
    if (final === "~") return encoder.encode(`\x1b[${text.slice(2, -1)};${modifier}~`)
    return encoder.encode(`\x1b[1;${modifier}${final}`)
  }
  if (mods.meta) return concat([byteSeq(0x1b), base])
  return base
}

/**
 * Encode one named key to raw PTY bytes. Returns null for an unknown name
 * (the caller skips it rather than throwing).
 */
export function encodeNamedKey(name: string, opts: EncodeOptions = {}): Uint8Array | null {
  if (name.length === 0) return null

  // Exact base key (case-insensitive: Enter/Tab/PageUp/F5/...).
  const direct = NAMED_BYTES[name.toLowerCase()]
  if (direct !== undefined) {
    // DECCKM: the shell asked for application cursor keys, so unmodified
    // arrows/Home/End switch from CSI (`ESC [ A`) to SS3 (`ESC O A`).
    // Modified forms never resolve through `NAMED_BYTES` and keep the CSI
    // modifier parameter (handled below).
    if (opts.applicationCursor) {
      const app = APPLICATION_CURSOR_BYTES[name.toLowerCase()]
      if (app !== undefined) return app
    }
    return direct
  }

  // Modifier chains in tmux order: C-/M-/S-.
  const mods: KeyMods = { ctrl: false, meta: false, shift: false }
  let rest = name
  for (;;) {
    const m = /^([CMS])-(.+)$/.exec(rest)
    if (m === null) break
    const flag = m[1] ?? ""
    rest = m[2] ?? ""
    if (flag === "C") mods.ctrl = true
    else if (flag === "M") mods.meta = true
    else mods.shift = true
  }
  if (rest.length === 0) return null
  if (!mods.ctrl && !mods.meta && !mods.shift) return null

  // Shift+Tab is the canonical back-tab sequence, not a modified Tab.
  if (mods.shift && !mods.ctrl && !mods.meta && rest.toLowerCase() === "tab") {
    return byteSeq(0x1b, 0x5b, 0x5a)
  }
  // Space is named but encodes like a character (C-Space = NUL).
  if (rest.toLowerCase() === "space") return encodeCharCombo(" ", mods)
  // Single-character combos (C-x, M-x, C-M-x, S-x, ...).
  if (rest.length === 1) return encodeCharCombo(rest, mods)

  // Named key + modifiers.
  const base = NAMED_BYTES[rest.toLowerCase()]
  if (base === undefined) return null
  return applyNamedModifiers(base, mods)
}

/** Turn a KeyAction into the raw bytes to write to the PTY. */
export function encodeKeyAction(action: KeyAction, opts: EncodeOptions = {}): Uint8Array {
  if (action.kind === "literal") return encoder.encode(action.text)
  const parts: Uint8Array[] = []
  for (const name of action.names) {
    const bytes = encodeNamedKey(name, opts)
    if (bytes !== null) parts.push(bytes)
  }
  return concat(parts)
}

// ---- Embedded-renderable F-key patch ----------------------------------------

/**
 * Physical names OpenTUI's native embedded-terminal encoder expects for the
 * function keys. The renderable's own `physicalKey()` has no F1–F12 mapping:
 * the parsed event carries either an SS3 letter pair (`OP` for F1) or a raw CSI
 * string (`[15~` for F5), both of which fail its lookup, so it hands the native
 * encoder an EMPTY key and every function key is silently dropped (F2/F12 dead
 * in nvtop/htop). Supplying the physical name makes the native encoder emit the
 * right sequence, honoring modifiers and the inner app's kitty keyboard mode.
 */
const FUNCTION_KEY_PHYSICAL_NAMES: Record<string, string> = {
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
}

/**
 * Patch an embedded-terminal renderable's key encoding so F1–F12 reach the
 * native encoder (see `FUNCTION_KEY_PHYSICAL_NAMES`). The event's `code` is set
 * to the physical name for the duration of the native call and restored after;
 * every other key passes through untouched. Structural seam (no `@opentui/core`
 * import), so this stays pure and unit-testable; a renderable without
 * `encodeKey` — a test fake — is left alone.
 */
export function installFunctionKeyEncoding<T extends { name: string; code?: string }>(
  renderable: { encodeKey?: (key: T) => Uint8Array },
): void {
  const encode = renderable.encodeKey
  if (typeof encode !== "function") return
  const bound = encode.bind(renderable)
  renderable.encodeKey = (key: T): Uint8Array => {
    const physical = FUNCTION_KEY_PHYSICAL_NAMES[key.name]
    if (physical === undefined) return bound(key)
    const previous = key.code
    try {
      key.code = physical
    } catch {
      // Frozen/sealed event: fall back to the unpatched encoding.
      return bound(key)
    }
    try {
      return bound(key)
    } finally {
      try {
        key.code = previous
      } catch {
        // Frozen event: the physical name stays; encoding already happened.
      }
    }
  }
}
