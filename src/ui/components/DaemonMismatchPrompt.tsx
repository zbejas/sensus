/**
 * DaemonMismatchPrompt — the D21 version-handshake prompt (docs/daemon-api.md
 * "Version handshake", docs/operations.md "Daemon"). It runs in its OWN renderer
 * before the main UI exists (mirroring ResumePicker/AttachPicker) when the
 * running daemon's version differs from this binary AND it still holds live
 * shells — the one mismatch the client may not auto-resolve.
 *
 * Two choices: restart the daemon now (starts the new version, closes the held
 * shells) or keep the running daemon (defer; restart later with
 * `sensus daemon restart`). The safe choice — keep — is highlighted by default so
 * a reflexive Enter never destroys a shell; Esc/q/d also defer. Enter activates
 * the highlighted row, r restarts, and everything is keyboard-driven like the
 * other boot pickers.
 */

import { type JSX } from "@opentui/solid"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For } from "solid-js"
import { bgProps, theme } from "../../theme/theme.ts"
import { isEnterKey } from "../../core/util.ts"

export interface DaemonMismatchPromptProps {
  /** The daemon's version-mismatch warning (names both versions + shell count). */
  warning: string
  /** Live PTY shells the running daemon holds (lost if restarted). */
  shells: number
  /** `true` = restart the daemon and reconnect; `false` = keep it (defer). */
  onChoice: (restart: boolean) => void
}

interface Choice {
  restart: boolean
  label: string
  detail: string
}

export function DaemonMismatchPrompt(props: DaemonMismatchPromptProps): JSX.Element {
  const dims = useTerminalDimensions()
  const t = () => theme()
  const held = props.shells === 1 ? "1 shell" : `${props.shells} shells`
  const choices: Choice[] = [
    {
      restart: true,
      label: "restart the daemon now",
      detail:
        props.shells > 0
          ? `starts the new sensus version — closes ${held} and loses any running commands`
          : "starts the new sensus version",
    },
    {
      restart: false,
      label: "keep the running daemon",
      detail: "restart later with `sensus daemon restart`",
    },
  ]
  // Default to the safe choice (keep) so Enter never closes a shell by reflex.
  const [sel, setSel] = createSignal(1)
  const clampedSel = createMemo(() => Math.min(sel(), choices.length - 1))

  useKeyboard((key) => {
    if (key.eventType === "release") return
    if (key.name === "escape" || (key.name === "q" && !key.ctrl && !key.meta)) {
      props.onChoice(false)
      return
    }
    if (!key.ctrl && !key.meta && (key.name === "r" || key.name === "R")) {
      props.onChoice(true)
      return
    }
    if (!key.ctrl && !key.meta && (key.name === "d" || key.name === "D")) {
      props.onChoice(false)
      return
    }
    if (isEnterKey(key) && !key.meta && !key.ctrl) {
      props.onChoice(choices[clampedSel()]?.restart ?? false)
      return
    }
    if (key.name === "up" || key.name === "k") {
      setSel((s) => Math.max(0, s - 1))
      return
    }
    if (key.name === "down" || key.name === "j") {
      setSel((s) => Math.min(choices.length - 1, s + 1))
      return
    }
  })

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        ...bgProps(t().bg),
        paddingLeft: 2,
        paddingTop: 1,
      }}
    >
      <text selectable={false} style={{ fg: t().warning }}> the running daemon is out of date </text>
      <text selectable={false} style={{ fg: t().muted }}>
        {` ${props.warning} `.padEnd(Math.max(10, dims().width - 4))}
      </text>
      <text selectable={false} style={{ fg: t().muted }}> ↑/↓ or j/k pick · Enter choose · r restart · d/Esc keep </text>
      <For each={choices}>
        {(c, i) => {
          const selected = () => i() === clampedSel()
          return (
            <text selectable={false} style={{ fg: selected() ? t().accent : t().fg, bg: "transparent" }}>
              {selected() ? "❯ " : "  "}
              <span>{c.label}</span>
              <span style={{ fg: t().muted }}>{` · ${c.detail}`}</span>
            </text>
          )
        }}
      </For>
    </box>
  )
}
