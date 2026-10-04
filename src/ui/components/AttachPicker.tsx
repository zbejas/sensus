/**
 * AttachPicker — the boot re-attach list (P4c-iii; D4), presented as an in-app
 * window over the live layout (like Settings), not its own fullscreen renderer.
 * Lists the daemon's live shells/chats so a restarting client can reconnect
 * instead of starting fresh. Enter attaches; Esc/q starts a fresh tab (the
 * daemon keeps the old shells until `sensus daemon stop`).
 *
 * App opens it (`store.setOverlay("attach")`) only when there is a real choice
 * (≥2 candidates); a lone candidate is auto-attached before this is shown
 * (docs/daemon-api.md "Lifecycle"). Input goes through the store's single
 * overlay dispatch point, never its own global key listener.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { isEnterKey } from "../../core/util.ts"
import type { UiStore } from "../lib/store.ts"
import type { AttachCandidate } from "../../client/attachPicker.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface AttachPickerProps {
  store: UiStore
  candidates: AttachCandidate[]
  /** Enter/click attaches the chosen candidate; Esc/q passes null (fresh). */
  onPick: (candidate: AttachCandidate | null) => void
}

const PREVIEW_ROWS = 4

export function AttachPicker(props: AttachPickerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [hover, setHover] = createSignal<number | null>(null)
  const items = props.candidates
  const clampedSel = createMemo(() => Math.min(sel(), Math.max(0, items.length - 1)))

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + PREVIEW_ROWS preview + hint rows.
  const maxRows = () => Math.max(2, metrics().innerHeight - (PREVIEW_ROWS + 4))
  const win = createMemo(() => {
    const start = Math.max(0, Math.min(clampedSel() - Math.floor(maxRows() / 2), Math.max(0, items.length - maxRows())))
    return { items: items.slice(start, start + maxRows()), start }
  })

  const active = (): AttachCandidate | null => items[clampedSel()] ?? null

  props.store.overlayKeyHandler = (key) => {
    if (key.name === "escape" || (key.name === "q" && !key.ctrl && !key.meta)) {
      props.onPick(null)
      return
    }
    if (isEnterKey(key) && !key.meta && !key.ctrl) {
      props.onPick(active())
      return
    }
    const next = overlayNavStep(key as OverlayNavKey, {
      index: clampedSel(),
      count: items.length,
      pageSize: maxRows(),
      vim: true,
      wrap: false,
    })
    if (next !== null) setSel(next)
  }

  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    const next = overlayNavStep(
      { name: dir === "up" ? "up" : "down", ctrl: false, meta: false, shift: false },
      { index: clampedSel(), count: items.length, pageSize: maxRows(), vim: false, wrap: false },
    )
    if (next !== null) setSel(next)
  }

  const previewLines = (): string[] => {
    const c = active()
    const width = Math.max(8, metrics().innerWidth - 2)
    const rows: string[] = c === null
      ? ["(nothing to re-attach)"]
      : [
          `kind: ${c.kind}`,
          `id: ${c.id}`,
          `shell: ${c.shellId ?? "(own shell)"}`,
          `status: ${c.status}${c.attached ? " · attached" : ""}`,
        ]
    const out: string[] = []
    for (let i = 0; i < PREVIEW_ROWS; i++) out.push((rows[i] ?? "").slice(0, width).padEnd(width))
    return out
  }

  return (
    <OverlayPanel title=" re-attach to a running shell " onClose={() => props.onPick(null)}>
      <text selectable={false} style={{ fg: t().muted }}>
        {" ↑/↓ or j/k pick · Enter attach · Esc/q start fresh "}
      </text>
      <For each={win().items}>
        {(c, i) => {
          const idx = () => win().start + i()
          const selected = () => idx() === clampedSel()
          const hovered = () => hover() === idx()
          return (
            <text selectable={false}
              style={overlayRowStyle(t(), selected(), t().fg, hovered())}
              onMouseOver={() => setHover(idx())}
              onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
              onMouseScroll={onWheel}
              onMouseDown={(e) => {
                e.stopPropagation()
                setSel(idx())
              }}
            >
              {` ${selected() ? "❯ " : "  "}`}
              <span style={{ fg: t().muted }}>{c.kind === "chat" ? "chat " : "shell"} </span>
              <span>{c.title}</span>
              <span style={{ fg: t().muted }}>{c.empty ? " · empty" : ""}</span>
              <span style={{ fg: t().muted }}>{` · ${c.status}${c.attached ? " · attached" : ""}`}</span>
            </text>
          )
        }}
      </For>
      <box style={{ height: 1 }} />
      <OverlayPreview lines={previewLines()} rows={PREVIEW_ROWS} width={Math.max(8, metrics().innerWidth - 2)} fg={t().fg} muted={t().muted} />
    </OverlayPanel>
  )
}
