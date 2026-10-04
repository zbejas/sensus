/**
 * Centralized keymap: global hotkeys are defined here as a table of actions
 * -> key specs (docs/keybindings.md). Never forward a bound key to the pane.
 *
 * Config hook: `keymap` in ~/.config/sensus/config.json (M2) will carry
 * `{ "focus-toggle": "shift+tab", ... }` strings; resolveKeymap(overrides)
 * parses them over the defaults. The module is deliberately free of
 * opentui/solid imports so it is unit-testable.
 */

export type KeyActionId =
  | "focus-toggle"
  | "focus-sidebar"
  | "new-tab"
  | "close-tab"
  | "tab-prev"
  | "tab-next"
  | "open-settings"
  | "open-menu"
  | "open-agents"
  | "sidebar-shrink"
  | "sidebar-grow"
  | "prefix"
  | "toggle-approval"
  | "toggle-thinking"
  | "toggle-details"
  | "toggle-card-style"
  | "chat-bottom"
  | "toggle-chat-only"
  // Keyboard parity for the mouse-only chat row actions (docs/keybindings.md
  // "Click targets"): `⧉ copy` on a message label, `↺ revert` on a user label,
  // and the whole-block send for a fenced code block (per-line click-to-paste
  // is pointer-only). No per-message focus model exists, so these act on the
  // newest relevant target (copy prefers a live selection).
  | "copy-message"
  | "revert-message"
  | "send-code-block"
  | "paste-image"
  | "tab-1"
  | "tab-2"
  | "tab-3"
  | "tab-4"
  | "tab-5"
  | "tab-6"
  | "tab-7"
  | "tab-8"
  | "tab-9"

/** A key binding: opentui key name + modifier flags, plus an optional raw
 * sequence fallback (see the Alt+punctuation quirk below). */
export interface KeySpec {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  /**
   * Exact stdin sequence fallback. Needed because opentui parses ESC-prefixed
   * punctuation (Alt+"," -> ESC ,) into an EMPTY name without the meta flag;
   * the raw sequence is the only reliable discriminator for those.
   */
  sequence?: string
}

/**
 * Default bindings (docs/keybindings.md). Alt+1..9 and Alt+A/,/. are stolen
 * from inner apps — documented conflict, see docs/keybindings.md. M6: "prefix"
 * is the Ctrl+A prefix (tmux muscle memory; opens a ~1s window; `d` quits
 * sensus, any other key is passed through as C-a + key — see
 * src/ui/chat/prefix.ts).
 */
export const defaultKeymap: Record<KeyActionId, KeySpec> = {
  "focus-toggle": { name: "tab", shift: true },
  "focus-sidebar": { name: "a", meta: true, sequence: "\x1ba" },
  "new-tab": { name: "t", ctrl: true },
  "close-tab": { name: "w", ctrl: true },
  "open-settings": { name: "o", ctrl: true },
  // Command menu (Ctrl+P): filterable palette of actions incl. open-settings
  // (docs/keybindings.md "Command menu"). Ctrl+P is stolen from inner apps —
  // documented conflict (readline previous-line).
  "open-menu": { name: "p", ctrl: true },
  "tab-prev": { name: "left", meta: true },
  "tab-next": { name: "right", meta: true },
  "sidebar-shrink": { name: ",", meta: true, sequence: "\x1b," },
  "sidebar-grow": { name: ".", meta: true, sequence: "\x1b." },
  "prefix": { name: "a", ctrl: true },
  // Agent picker (was the copilot/autopilot mode toggle — Alt+M stays).
  "open-agents": { name: "m", meta: true, sequence: "\x1bm" },
  "toggle-approval": { name: "y", meta: true, sequence: "\x1by" },
  // M10 display toggles (keyboard equivalents of clicking a tool card header /
  // a thinking block; same as /details and /thinking).
  "toggle-thinking": { name: "t", meta: true, sequence: "\x1bt" },
  "toggle-details": { name: "e", meta: true, sequence: "\x1be" },
  // Message card style (fill = borderless themed panel, border = bordered
  // card; /cards + the settings Chat row are equivalents).
  "toggle-card-style": { name: "c", meta: true, sequence: "\x1bc" },
  // Jump the chat scrollbox to the newest message (while a generation keeps
  // appending, a manual scroll-up can be a long way back). Alt+End is a global
  // steal like the other Alt toggles.
  "chat-bottom": { name: "end", meta: true },
  // Chat-only view (ephemeral, not persisted): hide the terminal pane and give
  // the chat the full width, keeping the top tab bar + status bar. Aimed at
  // narrow/mobile terminals where the pane would be unusable. Alt+Home is a
  // free slot (Alt+End already jumps the chat to the newest message); the
  // Ctrl+P "Chat-only view" row is the touch/palette equivalent.
  "toggle-chat-only": { name: "home", meta: true },
  // Keyboard parity for the mouse-only chat row affordances. Alt+B (bubble:
  // copy the newest message, or the current selection), Alt+R (revert/rewind
  // the newest user turn), Alt+S (send the newest fenced code block to the
  // visible pane). All three are free Alt+letter slots; the mouse paths remain.
  "copy-message": { name: "b", meta: true, sequence: "\x1bb" },
  "revert-message": { name: "r", meta: true, sequence: "\x1br" },
  "send-code-block": { name: "s", meta: true, sequence: "\x1bs" },
  // Paste from the system clipboard into the focused surface (docs/agent.md
  // "Images", docs/keybindings.md). Ctrl+Shift+V is the terminal-native paste
  // spelling and never steals a bare Ctrl+V from the inner app (vim
  // visual-block, readline quoted-insert); Alt+V stays as a default alias.
  "paste-image": { name: "v", ctrl: true, shift: true },
  "tab-1": { name: "1", meta: true },
  "tab-2": { name: "2", meta: true },
  "tab-3": { name: "3", meta: true },
  "tab-4": { name: "4", meta: true },
  "tab-5": { name: "5", meta: true },
  "tab-6": { name: "6", meta: true },
  "tab-7": { name: "7", meta: true },
  "tab-8": { name: "8", meta: true },
  "tab-9": { name: "9", meta: true },
}

/**
 * Secondary default keys for an action (the same command on extra keys). The
 * primary table stays one-spec-per-action so a `keymap` config override remains
 * authoritative: an alias only applies while the action keeps its DEFAULT
 * primary binding (remap paste-image and the alias goes quiet with it).
 *
 * Paste is the one action bound through more than one key: Ctrl+Shift+V is the
 * primary (the terminal-native spelling) and Alt+V — the original binding — is
 * kept as a default alias (docs/keybindings.md).
 */
export const defaultKeyAliases: Partial<Record<KeyActionId, KeySpec[]>> = {
  "paste-image": [{ name: "v", meta: true, sequence: "\x1bv" }],
}

/** Parse a human binding string like "shift+tab", "ctrl+t", "alt+1", "alt+,". */
export function parseKeySpec(spec: string): KeySpec {
  const parts = spec.toLowerCase().split("+")
  const name = parts[parts.length - 1]
  if (!name) throw new Error(`empty key spec: ${spec}`)
  const out: KeySpec = { name }
  for (const mod of parts.slice(0, -1)) {
    if (mod === "ctrl") out.ctrl = true
    else if (mod === "alt" || mod === "meta") out.meta = true
    else if (mod === "shift") out.shift = true
    else throw new Error(`unknown modifier "${mod}" in key spec: ${spec}`)
  }
  // Punctuation names that arrive from opentui with an empty name (ESC ,
  // parses to name "" without meta) get a sequence fallback automatically.
  if (out.meta && out.name.length === 1 && !/[a-z0-9]/.test(out.name)) {
    out.sequence = `\x1b${out.name}`
  }
  return out
}

/** Human label for a KeySpec ("ctrl+o", "shift+tab", "alt+,") — used by UI
 * hints (command menu rows). Mirrors the parseKeySpec input syntax. */
export function specLabel(spec: KeySpec): string {
  const mods: string[] = []
  if (spec.ctrl) mods.push("ctrl")
  if (spec.meta) mods.push("alt")
  if (spec.shift) mods.push("shift")
  mods.push(spec.name === " " ? "space" : spec.name)
  return mods.join("+")
}

/** Convert a captured key event into a config spec string, or null when the
 * event is only a modifier / has no usable base key. Single-character keys
 * REQUIRE a modifier so a plain letter can never be captured as a global hotkey. */
export function keyEventToSpec(event: {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}): string | null {
  const name = event.name
  if (name.length === 0) return null
  const modifierOnly = new Set(["shift", "control", "ctrl", "alt", "meta", "super", "hyper", "capslock", "numlock", "escape"])
  if (modifierOnly.has(name.toLowerCase())) return null
  const hasMod = event.ctrl === true || event.meta === true || event.shift === true
  if (!hasMod && name.length === 1) return null
  const mods: string[] = []
  if (event.ctrl === true) mods.push("ctrl")
  if (event.meta === true) mods.push("alt")
  if (event.shift === true) mods.push("shift")
  mods.push(name === " " ? "space" : name)
  return mods.join("+")
}

/** Defaults overlaid with config-provided overrides (values are spec strings). */
export function resolveKeymap(
  overrides?: Partial<Record<KeyActionId, string>>,
): Record<KeyActionId, KeySpec> {
  const map: Record<KeyActionId, KeySpec> = { ...defaultKeymap }
  if (overrides) {
    for (const [id, spec] of Object.entries(overrides)) {
      if (!(id in defaultKeymap) || typeof spec !== "string") continue
      try {
        map[id as KeyActionId] = parseKeySpec(spec)
      } catch {
        // Malformed override: keep the default binding (config must not crash the TUI).
      }
    }
  }
  return map
}

/** Structural match of an opentui key event against a KeySpec. */
export function matchKey(
  key: { name: string; ctrl: boolean; meta: boolean; shift: boolean; sequence: string },
  spec: KeySpec,
): boolean {
  if (spec.sequence !== undefined && key.sequence === spec.sequence) return true
  if (key.name !== spec.name) return false
  return (
    (spec.ctrl ?? false) === key.ctrl &&
    (spec.meta ?? false) === key.meta &&
    (spec.shift ?? false) === key.shift
  )
}

/** Structural equality of two key specs (aliases apply only at the default). */
export function specsEqual(a: KeySpec | undefined, b: KeySpec | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.name === b.name &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.meta ?? false) === (b.meta ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.sequence ?? "") === (b.sequence ?? "")
  )
}

/** First bound action matching the key, or null (key is routable). Aliases
 * (defaultKeyAliases) are consulted for actions still at their default primary
 * binding, so the legacy inline path routes Ctrl+Shift+V / Alt+V. */
export function findAction(
  key: { name: string; ctrl: boolean; meta: boolean; shift: boolean; sequence: string },
  keymap: Record<KeyActionId, KeySpec>,
  aliases: Partial<Record<KeyActionId, KeySpec[]>> = defaultKeyAliases,
): KeyActionId | null {
  for (const id of Object.keys(keymap) as KeyActionId[]) {
    if (matchKey(key, keymap[id])) return id
  }
  for (const [rawId, specs] of Object.entries(aliases)) {
    const id = rawId as KeyActionId
    if (!(id in keymap) || specs === undefined) continue
    if (!specsEqual(keymap[id], defaultKeymap[id])) continue
    for (const spec of specs) if (matchKey(key, spec)) return id
  }
  return null
}