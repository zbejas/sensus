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
 * Focus: `focus()`/`blur()` on the renderable. `blur()` fully suspends
 * terminal key input (global hotkeys still fire) — this is how chat focus,
 * overlays and the Ctrl+A prefix window suppress terminal input.
 */

import { type JSX } from "@opentui/solid"
import { createEffect, onCleanup } from "solid-js"
import type { Renderable } from "@opentui/core"
import { bgProps, borderProps, theme } from "../../theme/theme.ts"
import type { RemoteTerminalSession } from "../../client/remoteTerminalSession.ts"

export interface TerminalPaneProps {
  /** Active tab's session (null before the first tab exists). */
  session: RemoteTerminalSession | null
  /** True when the terminal region owns the keyboard (App-computed). */
  focused: boolean
}

export function TerminalPane(props: TerminalPaneProps): JSX.Element {
  const t = () => theme()
  let container: Renderable | null = null
  let mounted: Renderable | null = null

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
       * terminal to its card so it can never paint outside it. */}
      <box
        ref={(el) => (container = el)}
        overflow="hidden"
        style={{ flexDirection: "column", width: "100%", height: "100%" }}
      />
    </box>
  )
}
