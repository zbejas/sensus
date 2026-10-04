/**
 * KeymapEditor (phase 4.4): remap the global hotkeys (docs/keybindings.md).
 * Lists every action with its CURRENT binding; Enter captures a new key press
 * (modifiers required for single-char keys), `d`/Delete restores the default.
 * Persists through the `keymap` config key.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import type { UiStore, OverlayKey } from "../lib/store.ts"
import { defaultKeymap, keyEventToSpec, parseKeySpec, specLabel, type KeyActionId, type KeySpec } from "../../core/keymap.ts"
import { isEnterKey } from "../../core/util.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface KeymapEditorProps {
  store: UiStore
  /** The RESOLVED keymap (config overrides already merged). */
  keymap: Record<KeyActionId, KeySpec>
  /** Persist an override spec string; returns an error or null. */
  onSet: (action: KeyActionId, spec: string) => string | null
  /** Remove the override (restore the default); returns an error or null. */
  onClear: (action: KeyActionId) => string | null
  onClose: () => void
}

const ACTIONS = Object.keys(defaultKeymap) as KeyActionId[]

export function KeymapEditor(props: KeymapEditorProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [hover, setHover] = createSignal<number | null>(null)
  const [capture, setCapture] = createSignal<KeyActionId | null>(null)

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + hint, plus the capture line while armed.
  const maxRows = () => Math.max(4, metrics().innerHeight - (capture() !== null ? 3 : 2))
  const clamped = () => Math.min(sel(), ACTIONS.length - 1)
  const win = () => {
    const rows = Math.max(1, maxRows())
    const start = Math.max(0, Math.min(clamped() - Math.floor(rows / 2), Math.max(0, ACTIONS.length - rows)))
    return { start, items: ACTIONS.slice(start, start + rows) }
  }
  const bindingOf = (a: KeyActionId): string => specLabel(props.keymap[a] ?? defaultKeymap[a]!)
  const isCustom = (a: KeyActionId): boolean => specLabel(props.keymap[a]!) !== specLabel(defaultKeymap[a]!)

  props.store.overlayKeyHandler = (key: OverlayKey) => {
    const capturing = capture()
    if (capturing !== null) {
      if (key.name === "escape") {
        setCapture(null)
        return
      }
      const spec = keyEventToSpec(key)
      if (spec === null) {
        props.store.showToast("that key cannot be captured (add a modifier)", "warn", 3000)
        return
      }
      // Validate through the real parser before persisting.
      try {
        parseKeySpec(spec)
      } catch {
        props.store.showToast(`invalid binding: ${spec}`, "error", 4000)
        return
      }
      const err = props.onSet(capturing, spec)
      if (err !== null) props.store.showToast(`keymap save failed: ${err}`, "error", 4500)
      else props.store.showToast(`${capturing} → ${spec}`, "success", 2500)
      setCapture(null)
      return
    }
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if (isEnterKey(key) && !key.ctrl && !key.meta) {
      setCapture(ACTIONS[clamped()] ?? null)
      return
    }
    if ((key.name === "d" || key.name === "delete") && !key.ctrl && !key.meta) {
      const action = ACTIONS[clamped()]
      if (action === undefined) return
      const err = props.onClear(action)
      if (err !== null) props.store.showToast(`keymap save failed: ${err}`, "error", 4500)
      else props.store.showToast(`${action} restored to ${specLabel(defaultKeymap[action]!)}`, "success", 2500)
      return
    }
    const next = overlayNavStep(key as OverlayNavKey, {
      index: clamped(),
      count: ACTIONS.length,
      pageSize: maxRows(),
      vim: true,
      wrap: false,
    })
    if (next !== null) setSel(next)
  }

  const width = (): number => Math.max(24, metrics().innerWidth - 2)
  const rowText = (a: KeyActionId, selected: boolean): string => {
    const bind = bindingOf(a)
    const custom = isCustom(a) ? " *" : ""
    return ` ${selected ? "❯ " : "  "}${bind.padEnd(14)}${a}${custom}`.slice(0, width())
  }

  return (
    <OverlayPanel title=" keybindings " onClose={props.onClose}>
      <Show when={capture() !== null} fallback={null}>
        <text selectable={false} style={{ fg: t().warning, bg: "transparent" }}>
          {` press a key for "${capture()}" (modifier required for letters) · Esc cancel `.padEnd(width())}
        </text>
      </Show>
      <For each={win().items}>
        {(a, i) => {
          const idx = () => win().start + i()
          const selected = () => idx() === clamped() && capture() === null
          const hovered = () => hover() === idx()
          return (
            <text selectable={false}
              style={overlayRowStyle(t(), selected(), t().fg, hovered())}
              onMouseOver={() => setHover(idx())}
              onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
              onMouseDown={(e) => {
                e.stopPropagation()
                setSel(idx())
                setCapture(a)
              }}
            >
              {rowText(a, selected())}
            </text>
          )
        }}
      </For>
      <box style={{ height: 1 }} />
      <text selectable={false} style={{ fg: t().muted }}> {" Enter remap · d restore default · * = custom · Esc close "} </text>
    </OverlayPanel>
  )
}
