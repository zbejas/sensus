/**
 * PaneDivider: the draggable gap between the terminal pane and the chat sidebar
 * (docs/DESIGN.md "Layout", docs/ui.md "Click mapping").
 *
 * The two panes are separate bordered cards; this one column sits BETWEEN them
 * and paints nothing until the pointer is over it — then a single accent `│`
 * appears in the gap, so the splitter is discoverable without adding a third
 * permanent line next to the cards' own edges.
 *
 * Drag: a left mousedown captures the pointer for the rest of the gesture, so
 * drag/up keep arriving even when the pointer leaves this 1-column target. The
 * drag start column/width are captured locally, so a re-render mid-drag (the
 * store width updates on every move) never resets them. App clamps the reported
 * width; `sidebarWidthForDrag` is the pure math.
 */

import { type JSX, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { MouseButton, type MouseEvent, type Renderable } from "@opentui/core"
import { bgProps, borderProps, theme, type ThemeColor } from "../../theme/theme.ts"
import { sidebarWidthForDrag } from "../lib/layout.ts"

export interface PaneDividerProps {
  /** Current chat sidebar width (reactive store value). */
  width: number
  /** Report a desired sidebar width while dragging; App clamps it. */
  onResize: (width: number) => void
}

/**
 * Ask the renderer to route the rest of the pointer gesture to `target`
 * (opentui's own drag-capture mechanism). `setCapturedRenderable` is not on the
 * public type, so this is a guarded fast-path: without it, drag/up still arrive
 * while the pointer stays on the handle (the unclamped case), which is why the
 * handle still works on a renderer build that lacks the hook.
 */
function capturePointer(renderer: unknown, target: Renderable | null): void {
  if (target === null) return
  try {
    const fn = (renderer as { setCapturedRenderable?: (r: Renderable) => void }).setCapturedRenderable
    if (typeof fn === "function") fn.call(renderer, target)
  } catch {
    // Optional fast-path only — never let it take the TUI down.
  }
}

export function PaneDivider(props: PaneDividerProps): JSX.Element {
  const t = () => theme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  let el: Renderable | null = null
  // Captured at mousedown so the drag math uses absolute pointer columns and a
  // fixed starting width (props.width changes as the store updates mid-drag).
  let startCol = 0
  let startWidth = 0

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== MouseButton.LEFT) return
    e.stopPropagation()
    e.preventDefault()
    startCol = e.x
    startWidth = props.width
    setDragging(true)
    capturePointer(renderer, el)
  }

  const onMouseDrag = (e: MouseEvent): void => {
    if (!dragging()) return
    e.stopPropagation()
    props.onResize(sidebarWidthForDrag(startCol, startWidth, e.x))
  }

  const endDrag = (): void => {
    if (!dragging()) return
    setDragging(false)
    // A pointer that left the 1-col handle keeps the hover flag stale; the
    // pointer must re-enter to re-light it.
    setHover(false)
  }

  onCleanup(endDrag)

  /** Transparent when idle (the gap is invisible), accent under the pointer. */
  const lineColor = (): ThemeColor => (dragging() || hover() ? t().accent : "transparent")

  return (
    <box
      ref={(box) => (el = box)}
      style={{
        width: 1,
        border: ["left"],
        borderStyle: "single",
        ...borderProps(lineColor()),
        ...bgProps(t().bg),
      }}
      onMouseDown={onMouseDown}
      onMouseDrag={onMouseDrag}
      onMouseDragEnd={endDrag}
      onMouseUp={endDrag}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    />
  )
}
