/**
 * McpManager: full-screen overlay listing every configured MCP server
 * (docs/mcp.md "UI"). Opened by the status-bar `mcp:` chip or the Ctrl+P
 * "MCP servers" row.
 *
 * Enter/Space (or a click) toggles one server's configured `enabled` flag; the
 * host persists it to config.json and reloads, so the change is GLOBAL and
 * applied live (a disabled server's tool specs are dropped from later requests,
 * saving context). This is the config-level toggle — the session-wide
 * `/mcp on|off` switch is separate.
 *
 * Keys: ↑/↓ or j/k pick · Space/Enter toggle · Esc close.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { UiStore } from "../lib/store.ts"
import type { McpServerStatusFact } from "../../engine/index.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"
import { mcpServerEnabled, mcpServerRow, mcpStatusLabel, mcpToggleIntent } from "../chat/mcpManager.ts"

export interface McpManagerProps {
  store: UiStore
  /** Reactive per-server facts (the registry's `serverStatuses` behind its
   * version signal). Reading it inside a tracked scope repaints on connect/fail. */
  servers: () => McpServerStatusFact[]
  /** Persist one server's `enabled` flag and reload; returns an error or null. */
  onToggle: (name: string, enabled: boolean) => string | null
  onClose: () => void
}

export function McpManager(props: McpManagerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [hover, setHover] = createSignal<number | null>(null)

  const servers = (): McpServerStatusFact[] => props.servers()
  const clamped = (): number => (servers().length === 0 ? 0 : Math.min(sel(), servers().length - 1))
  const active = (): McpServerStatusFact | null => servers()[clamped()] ?? null

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + count line + hint line.
  const maxRows = () => Math.max(3, metrics().innerHeight - 3)
  const win = createMemo(() => {
    const count = servers().length
    const rows = Math.max(1, maxRows())
    const start = Math.max(0, Math.min(clamped() - Math.floor(rows / 2), Math.max(0, count - rows)))
    return { start, list: Math.min(rows, Math.max(0, count - start)) }
  })

  /** Toggle one server. The host reloads + toasts the config change; only a
   * write failure needs a message here. */
  const toggle = (server: McpServerStatusFact | null): void => {
    if (server === null) return
    const err = props.onToggle(server.name, !mcpServerEnabled(server))
    if (err !== null) props.store.showToast(`mcp save failed: ${err}`, "error", 4500)
  }

  props.store.overlayKeyHandler = (key) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if (mcpToggleIntent(key) && !key.ctrl && !key.meta) {
      toggle(active())
      return
    }
    const next = overlayNavStep(key as OverlayNavKey, {
      index: clamped(),
      count: servers().length,
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
      { index: clamped(), count: servers().length, pageSize: maxRows(), vim: false, wrap: false },
    )
    if (next !== null) setSel(next)
  }

  const toneFor = (s: McpServerStatusFact): ThemeColor => {
    switch (s.status) {
      case "connected":
        return t().success
      case "failed":
        return t().danger
      case "starting":
        return t().accent
      default:
        return t().muted
    }
  }

  const width = (): number => Math.max(8, metrics().innerWidth - 2)
  const enabledCount = (): number => servers().filter(mcpServerEnabled).length
  // A bounded one-line detail for the highlighted server (transport-agnostic).
  const detail = (): string[] => {
    const s = active()
    if (s === null) return []
    const state = mcpServerEnabled(s) ? `enabled · ${mcpStatusLabel(s)}` : "disabled in config"
    return [` ${s.name} — ${state} `]
  }

  return (
    <OverlayPanel title=" mcp servers " onClose={props.onClose}>
      <Show
        when={servers().length > 0}
        fallback={
          <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>
            {" no MCP servers configured — add mcp.servers in config.json "}
          </text>
        }
      >
        <For each={servers().slice(win().start, win().start + win().list)}>
          {(s, i) => {
            const idx = () => win().start + i()
            const selected = () => idx() === clamped()
            const hovered = () => hover() === idx()
            return (
              <text
                selectable={false}
                style={overlayRowStyle(t(), selected(), toneFor(s), hovered())}
                onMouseOver={() => setHover(idx())}
                onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
                onMouseScroll={onWheel}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  setSel(idx())
                  toggle(s)
                }}
              >
                {mcpServerRow(s, selected(), width())}
              </text>
            )
          }}
        </For>
      </Show>
      <box style={{ height: 1 }} />
      <OverlayPreview lines={detail()} rows={1} width={width()} fg={t().fg} muted={t().muted} />
      <text selectable={false} style={{ fg: t().accent }}>
        {` ${enabledCount()}/${servers().length} enabled · toggles persist to config.json `}
      </text>
      <text selectable={false} style={{ fg: t().muted }}>
        {" ↑/↓/j/k pick · Space/Enter toggle · Esc close "}
      </text>
    </OverlayPanel>
  )
}
