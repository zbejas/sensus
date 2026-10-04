/**
 * M9: @opentui/keymap integration. The global hotkey table (src/core/keymap.ts —
 * still the single source of truth for WHAT is bound, including config
 * overrides) is installed as a keymap layer over the OpenTUI renderer.
 *
 * Dispatch model: the keymap hooks renderer.keyInput with a PREPENDED
 * listener, so a matched binding consumes the key (preventDefault +
 * stopPropagation) before App's single `useKeyboard` dispatch point sees it.
 * Keys with no active binding fall through to App unchanged (overlay
 * swallowing, prefix second-keys, pane/chat routing) — same order of stages
 * as before this module existed, with the old findAction stage replaced by
 * the keymap layer.
 *
 * Layer gating is a plain function evaluated at dispatch time (keymap runtime
 * matchers run per dispatch): the hotkey layer goes inert while a
 * full-screen overlay is open or the M6 prefix window is armed — in both
 * states the key must reach App's dispatchKey instead (overlay swallow /
 * prefix.secondKey routing), exactly as the pre-keymap findAction stage
 * behaved (it sat behind those stages).
 *
 * The Alt+punctuation quirk (opentui parses ESC , into an EMPTY name without
 * the meta flag — see KeySpec.sequence in src/core/keymap.ts) is bridged by an
 * appended event-match resolver that maps the raw sequence onto the named
 * stroke ("alt+comma", "alt+period", ...). Resolver results are unioned with
 * the default name-based match, so keys opentui parses normally (alt+a,
 * alt+1) keep matching through the default resolver.
 *
 * src/core/keymap.ts stays free of opentui/keymap imports (unit-tested alone);
 * everything here is integration glue.
 */

import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import {
  registerDeadBindingWarnings,
  registerDefaultBindingParser,
  registerEnabledFields,
  registerMetadataFields,
  registerUnresolvedCommandWarnings,
} from "@opentui/keymap/addons"
import type { Keymap, KeymapEvent } from "@opentui/keymap"
import { defaultKeyAliases, defaultKeymap, specsEqual, type KeyActionId, type KeySpec } from "./keymap.ts"
import type { CommandDef } from "./commandCatalog.ts"

/** Keymap instance flavor used by the TUI (opentui renderer events). */
export type SensusKeymap = Keymap<Renderable, KeyEvent>

/**
 * opentui/spec key name -> keymap stroke name. The default binding parser
 * spells punctuation out ("comma", "period", ...); opentui key events (and
 * our KeySpec names) use the bare character.
 */
const PUNCT_STROKE_NAMES: Record<string, string> = {
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  "'": "quote",
  "`": "backquote",
  "-": "minus",
  "=": "equal",
  "[": "leftbracket",
  "]": "rightbracket",
  " ": "space",
  "+": "plus",
  "<": "lt",
  ">": "gt",
}

/** Convert a KeySpec name into the keymap binding language's stroke name. */
export function keymapStrokeName(name: string): string {
  return PUNCT_STROKE_NAMES[name] ?? name
}

/** KeySpec -> keymap binding key ("ctrl+t", "alt+comma", "shift+tab"). */
export function toBindingKey(spec: KeySpec): string {
  const parts: string[] = []
  if (spec.ctrl) parts.push("ctrl")
  if (spec.shift) parts.push("shift")
  if (spec.meta) parts.push("alt")
  parts.push(keymapStrokeName(spec.name))
  return parts.join("+")
}

/**
 * The Alt+punctuation quirk: opentui parses ESC-prefixed punctuation
 * (Alt+, -> ESC ,) into an event with an EMPTY name and no meta flag; the
 * raw two-byte sequence is the only discriminator. Maps such a sequence to
 * the stroke the user actually pressed. Letters/digits are excluded —
 * opentui already parses those with meta set (and a lone ESC is 1 byte).
 */
export function strokeFromAltSequence(
  sequence: string | undefined,
): { name: string; meta: true } | null {
  if (sequence === undefined || sequence.length !== 2 || !sequence.startsWith("\x1b")) {
    return null
  }
  const stroke = PUNCT_STROKE_NAMES[sequence[1] ?? ""]
  if (stroke === undefined) return null
  return { name: stroke, meta: true }
}

/**
 * xterm `modifyOtherKeys` level-2 enable sequence (DECSET-like CSI > 4 ; 2 m).
 * OpenTUI enables level 1 for the xterm fallback at renderer construction, but
 * level 1 does NOT report the Shift modifier on Enter: Shift+Enter arrives as a
 * bare CR, indistinguishable from Enter. Level 2 emits `ESC [ 27 ; 2 ; 13 ~`
 * for Shift+Enter, which OpenTUI's parser already decodes to
 * `{ name: "return", shift: true }` — so upgrading the level is what makes
 * Shift+Enter work on xterm / iTerm2 / macOS Terminal / other non-kitty
 * terminals. Terminals that pushed the kitty protocol ignore this (kitty wins);
 * OpenTUI resets to `>4;0m` on destroy, so the mode never leaks.
 */
const MODIFY_OTHER_KEYS_LEVEL2 = "\x1b[>4;2m"

/**
 * Upgrade the xterm `modifyOtherKeys` fallback to level 2 so terminals WITHOUT
 * the kitty keyboard protocol still report Shift+Enter (docs/keybindings.md
 * "Gotchas"). OpenTUI has no public API for the level, so the 7-byte mode
 * sequence is written directly to the renderer's stdout (the default `write`).
 * Best-effort: a write failure (EPIPE, a closed stream) must never fail boot, so
 * this never throws. `write` is injectable for tests.
 */
export function enableModifyOtherKeysLevel2(
  write: (s: string) => void = (s) => {
    process.stdout.write(s)
  },
): void {
  try {
    write(MODIFY_OTHER_KEYS_LEVEL2)
  } catch {
    // best-effort: an unwritable stdout must never crash boot
  }
}

/**
 * Addons every sensus keymap needs. The default binding parser brings the
 * "ctrl+t"-style binding language; the event-match resolver below REPLACES
 * the stock defaultEventMatchResolver (registerDefaultKeys would install
 * both): it adds the Alt+punctuation quirk bridge AND avoids the stock
 * resolver's throw on empty-name events (resolveKey({name: ""}) rejects —
 * opentui emits exactly such events for the quirk keys, which would spam a
 * caught-but-noisy keymap error on every alt-punct press). enabled powers
 * layer gating; metadata compiles title/category fields (used by the command
 * catalog from M9 phase 2); the warnings addons flag bindings that reference
 * unknown commands. Shared by production (createSensusKeymap) and the
 * fake-host tests so both run the exact same stack.
 */
export function configureSensusKeymap<TTarget extends object, TEvent extends KeymapEvent & { sequence?: string }>(
  keymap: Keymap<TTarget, TEvent>,
): void {
  registerDefaultBindingParser(keymap)
  registerEnabledFields(keymap)
  registerMetadataFields(keymap)
  registerUnresolvedCommandWarnings(keymap)
  registerDeadBindingWarnings(keymap)
  keymap.appendEventMatchResolver((event, ctx) => {
    // TEvent carries opentui's optional raw `sequence` (KeyEvents always do;
    // test-harness events may not).
    const quirk = strokeFromAltSequence(event.sequence)
    if (event.name === "") {
      // Unparseable event (the Alt+punctuation quirk and friends): the raw
      // sequence is the only meaningful signal — match the quirk stroke or
      // nothing. Never resolveKey({name: ""}), which throws.
      return quirk === null ? [] : [ctx.resolveKey(quirk)]
    }
    // Stock defaultEventMatchResolver behavior: match the event's own
    // name+modifiers; the quirk stroke is added on top when one applies.
    const base = {
      name: event.name,
      ctrl: event.ctrl,
      shift: event.shift,
      meta: event.meta,
      super: event.super ?? false,
      hyper: event.hyper || undefined,
    }
    const matches = [ctx.resolveKey(base)]
    // Kitty-protocol / xterm-modifyOtherKeys encodings report punctuation by
    // its literal character (Alt+. arrives as name "." + meta), while the
    // binding language spells punctuation out ("alt+period"). Without this
    // alias the Alt+punctuation hotkeys die whenever the terminal negotiates
    // an extended keyboard protocol — the raw-ESC quirk path above only
    // covers the legacy encoding.
    const stroke = PUNCT_STROKE_NAMES[event.name]
    if (stroke !== undefined && stroke !== event.name) {
      matches.push(ctx.resolveKey({ ...base, name: stroke }))
    }
    if (quirk !== null) matches.push(ctx.resolveKey(quirk))
    return matches
  })
}

/**
 * Selection-copy layer: Ctrl+C /
 * Ctrl+Shift+C copy the CURRENT selection when one exists, and fall through
 * otherwise. A dedicated high-priority layer with a selection gate is the
 * whole point: the main hotkey layer must NEVER bind ctrl+c (a bound binding
 * is consumed selection-less too, which would break ^C/SIGINT forwarding to
 * the terminal pane). The gate also carries the main layer's conditions
 * (no overlay, prefix not armed) so overlays/prefix keep swallowing keys.
 */
export interface SelectionCopyLayerOptions {
  /** Main-layer conditions (overlay/prefix) ANDed with "a selection exists". */
  gate: () => boolean
  /** Copy dispatch (App: copySelectionToClipboard). */
  onCopy: () => void
}

export function installSelectionCopyLayer<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  opts: SelectionCopyLayerOptions,
): () => void {
  return keymap.registerLayer({
    priority: 150,
    enabled: () => opts.gate(),
    commands: [{ name: "copy-selection", run: () => opts.onCopy() }],
    bindings: [
      { key: "ctrl+c", cmd: "copy-selection" },
      { key: "ctrl+shift+c", cmd: "copy-selection" },
    ],
  })
}

/** Create the TUI's keymap over an opentui renderer (M9 phase 1). */
export function createSensusKeymap(renderer: CliRenderer): SensusKeymap {
  const keymap = createOpenTuiKeymap(renderer)
  configureSensusKeymap(keymap)
  return keymap
}

export interface GlobalKeyLayerOptions {
  /** Resolved bindings (defaults + config overrides). Default: the defaults. */
  resolved?: Record<KeyActionId, KeySpec>
  /**
   * Command registry (commandCatalog.ts): matched actions get title/desc/
   * category metadata so keymap command consumers (hint footers, /help,
   * pickers) read the same registry the palette does.
   */
  catalog?: readonly CommandDef[]
  /**
   * Live gate — when false the layer is inert and keys fall through to
   * App's dispatch (overlay open / prefix armed). Evaluated per dispatch.
   */
  gate?: () => boolean
  /** Matched action dispatch (App: prefix-arm special case + handleAction). */
  onAction: (action: KeyActionId) => void
  /**
   * Secondary keys per action (same command). Defaults to `defaultKeyAliases`;
   * an alias is emitted only while the action keeps its default primary
   * binding, so a config remap of the primary never leaves a stale extra key.
   */
  aliases?: Partial<Record<KeyActionId, KeySpec[]>>
}

/**
 * Install the global hotkey layer. One command + one primary binding per
 * resolved action id, plus any aliases; the returned function unregisters the
 * layer (App onCleanup). Bindings consume their keys by default (preventDefault
 * + stopPropagation), which is what keeps App's useKeyboard from
 * double-handling them.
 */
export function installGlobalKeyLayer<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  opts: GlobalKeyLayerOptions,
): () => void {
  const resolved = opts.resolved ?? defaultKeymap
  const aliases = opts.aliases ?? defaultKeyAliases
  const ids = Object.keys(resolved) as KeyActionId[]
  const defFor = (id: KeyActionId): CommandDef | undefined =>
    opts.catalog?.find((c) => c.action === id)
  const bindings: Array<{ key: string; cmd: string }> = ids.map((id) => ({
    key: toBindingKey(resolved[id]),
    cmd: id,
  }))
  for (const [rawId, specs] of Object.entries(aliases)) {
    const id = rawId as KeyActionId
    if (!(id in resolved) || specs === undefined) continue
    if (!specsEqual(resolved[id], defaultKeymap[id])) continue
    for (const spec of specs) bindings.push({ key: toBindingKey(spec), cmd: id })
  }
  return keymap.registerLayer({
    priority: 100,
    ...(opts.gate !== undefined ? { enabled: opts.gate } : {}),
    commands: ids.map((id) => {
      const def = defFor(id)
      return {
        name: id,
        run: () => {
          opts.onAction(id)
        },
        // Command metadata (compiled by registerMetadataFields — the same
        // registry the Ctrl+P palette renders).
        ...(def !== undefined
          ? { title: def.label, desc: def.description, category: def.category }
          : {}),
      }
    }),
    bindings,
  })
}