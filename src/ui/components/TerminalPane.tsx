/**
 * TerminalPane: hosts the active tab's native PTY session.
 *
 * OpenTUI's `EmbeddedTerminalRenderable` is a Core renderable, not a Solid
 * component, so it is mounted imperatively: a container box holds one
 * renderable at a time and `container.add(session.renderable)` (which
 * reparents) swaps tabs while preserving each session's VT state. The
 * renderable owns the screen, cursor, scrollback and mouse input; layout
 * resizes fire `onTerminalResize`, which the engine forwards to the PTY, so
 * nothing here resizes manually.
 *
 * The pane scrollbar is a second imperatively-mounted renderable: a
 * `ScrollBarRenderable` absolutely positioned over the terminal's rightmost
 * column (z-indexed above the buffered VT, never reserving a PTY column and
 * never stealing keyboard focus). A ~8/s poll copies the session's calibrated
 * scrollback geometry into it and drags call `session.scrollTo()`. The
 * transparent track lets the terminal's text show through; only the thumb
 * (theme `scrollbar` token, falling back to muted) covers cells. It auto-hides
 * while there is no history and on the alternate screen (docs/terminal-layer.md
 * "Capture & scrollback", docs/DESIGN.md "Terminal pane").
 *
 * Focus: `focus()`/`blur()` on the renderable. `blur()` fully suspends
 * terminal key input (global hotkeys still fire) — this is how chat focus,
 * overlays and the Ctrl+A prefix window suppress terminal input.
 */

import { ScrollBarRenderable, type Renderable } from "@opentui/core"
import { type JSX, useRenderer } from "@opentui/solid"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { bgProps, borderProps, theme } from "../../theme/theme.ts"
import type { RemoteTerminalSession } from "../../client/remoteTerminalSession.ts"

export interface TerminalPaneProps {
  /** Active tab's session (null before the first tab exists). */
  session: RemoteTerminalSession | null
  /** True when the terminal region owns the keyboard (App-computed). */
  focused: boolean
}

/** How often the overlay scrollbar re-reads the session's geometry. */
const SCROLL_SYNC_MS = 120

export function TerminalPane(props: TerminalPaneProps): JSX.Element {
  const t = () => theme()
  const renderer = useRenderer()
  let container: Renderable | null = null
  let mounted: Renderable | null = null
  let scrollBar: ScrollBarRenderable | null = null
  let syncTimer: ReturnType<typeof setInterval> | null = null
  /**
   * True while the poll writes geometry into the bar. A `ScrollBarRenderable`
   * propagates a programmatic `scrollPosition` write into its slider, whose
   * value setter fires `onChange` — without this guard the sync would feed
   * back into `session.scrollTo()` and scroll the pane on every tab switch.
   */
  let syncingBar = false

  const scrollbarColor = createMemo(() => t().scrollbar ?? t().muted)

  /** Copy the active session's scrollbar geometry into the overlay bar. */
  const syncScrollBar = (): void => {
    const bar = scrollBar
    if (bar === null) return
    const session = props.session
    syncingBar = true
    try {
      if (session === null) {
        bar.viewportSize = 1
        bar.scrollSize = 0
        return
      }
      const info = session.scrollInfo()
      bar.viewportSize = info.viewport
      // Alternate-screen apps have no addressable scrollback: a zero history
      // makes the bar's own auto-hide kick in.
      bar.scrollSize = info.altScreen ? info.viewport : info.total
      bar.scrollPosition = info.position
    } catch {
      // A session/renderable surprise must never take the TUI down.
    } finally {
      syncingBar = false
    }
  }

  /** Create and mount the overlay bar (once per TerminalPane instance). */
  const ensureScrollBar = (box: Renderable): void => {
    if (scrollBar !== null) return
    try {
      const bar = new ScrollBarRenderable(renderer, {
        orientation: "vertical",
        showArrows: false,
        width: 1,
        height: "100%",
        position: "absolute",
        right: 0,
        top: 0,
        zIndex: 5,
        trackOptions: { backgroundColor: "transparent", foregroundColor: scrollbarColor() },
        onChange: (position) => {
          // Programmatic syncs must never scroll the pane (see syncingBar).
          if (syncingBar) return
          try {
            props.session?.scrollTo(position)
          } catch {
            // best-effort
          }
        },
      })
      // The pane owns the keyboard: a drag on the bar must not focus it (the
      // renderer auto-focuses the clicked renderable otherwise, silencing the
      // shell's typing until the user clicks the pane again).
      bar.focusable = false
      box.add(bar)
      scrollBar = bar
    } catch {
      // Without the overlay the pane still scrolls with the wheel.
    }
  }

  // Mount/reparent the active session's renderable into the container box.
  // `add` reparents (removing it from any previous parent), and detaching an
  // EmbeddedTerminal only blurs it — never destroys its VT state.
  createEffect(() => {
    const next: Renderable | null = props.session?.renderable ?? null
    const box = container
    if (box === null) return
    if (mounted !== null && mounted !== next) {
      try {
        box.remove(mounted)
      } catch {
        // already detached
      }
      mounted = null
    }
    if (next !== null && next !== mounted) {
      try {
        next.width = "100%"
        next.height = "100%"
        next.flexGrow = 1
        box.add(next)
        mounted = next
      } catch {
        // A renderable failure must not take the TUI down.
      }
    }
    syncScrollBar()
  })

  // Theme switch: repaint the thumb from the current token.
  createEffect(() => {
    const color = scrollbarColor()
    const bar = scrollBar
    if (bar === null) return
    try {
      bar.trackOptions = { backgroundColor: "transparent", foregroundColor: color }
    } catch {
      // best-effort
    }
  })

  // Mirror store focus onto the renderable. Re-runs when the active session
  // or the focused flag changes (chat focus / overlay / prefix blur it).
  createEffect(() => {
    const session = props.session
    if (session === null) return
    if (props.focused) session.focus()
    else session.blur()
  })

  onCleanup(() => {
    if (syncTimer !== null) {
      clearInterval(syncTimer)
      syncTimer = null
    }
    if (container !== null && scrollBar !== null) {
      // The bar is disposable (unlike the terminal, whose VT state must
      // survive a detach): detach and tear it down with its slider/arrows.
      try {
        container.remove(scrollBar)
        scrollBar.destroyRecursively()
      } catch {
        // already gone
      }
    }
    scrollBar = null
    if (container !== null && mounted !== null) {
      try {
        container.remove(mounted)
      } catch {
        // already gone
      }
    }
  })

  const title = (): string => (props.focused ? " terminal ● " : " terminal ")

  return (
    <box
      title={title()}
      titleAlignment="left"
      titleColor={props.focused ? t().accent : t().muted}
      style={{
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        ...borderProps(props.focused ? t().borderFocused : t().border),
        ...bgProps(t().bg),
      }}
    >
      {/* `overflow: "hidden"` is load-bearing: OpenTUI clips a renderable to
       * its parent only when the parent's `overflow` is not `"visible"`
       * (default). The embedded terminal is a buffered renderable blitted at
       * its own `_screenX/_screenY`; for the frame where a layout/resize
       * reflow leaves that origin stale it would otherwise blit across the
       * pane's border into the tab rail. The rail's transparent chrome never
       * repaints those cells (OpenTUI keeps stale cells where nothing paints),
       * leaving frozen shell output where the tab entries should be. Clip the
       * terminal to its card so it can never paint outside it. The overlay
       * scrollbar lives in the same clipped box, so it is clipped too. */}
      <box
        ref={(el) => {
          container = el
          ensureScrollBar(el)
          if (syncTimer === null) syncTimer = setInterval(syncScrollBar, SCROLL_SYNC_MS)
        }}
        overflow="hidden"
        style={{ flexDirection: "column", width: "100%", height: "100%" }}
      />
    </box>
  )
}
