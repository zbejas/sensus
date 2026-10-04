/**
 * SudoPrompt (docs/agent.md "Sudo"): the masked sudo-password popup. Shown when
 * a `shell_background` command failed because sudo needed a password (the hidden
 * shell has no tty), or when `shell_session` is asked to type a sudo command
 * (the agent must not leave a bare prompt for the model to retry around). The
 * active agent declares `sudoPrompt: popup`/`auto`; `ask` agents get guidance
 * instead. Resolution is DETERMINISTIC — the executor uses the password via
 * askpass (`SUDO_ASKPASS`), with no extra LLM turn.
 *
 * Keys: any printable type · Enter submit · Esc cancel · Tab toggles
 * "cache for this session" (OFF by default — the user must SELECT it; a
 * cached password lives encrypted in RAM only — never on disk, never in the
 * transcript, never sent to the model) · Ctrl+U clears.
 *
 * Rendered as a centered MODAL card over the full-screen backdrop (not a
 * full-screen panel): the backdrop still owns click-outside and input, but the
 * card is a bounded, content-sized box that leaves the pane/chat visible behind
 * it.
 */

import { type JSX, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { bgProps, borderProps, theme } from "../../theme/theme.ts"
import { isEnterKey, printableKeyText, singleLinePaste } from "../../core/util.ts"
import type { OverlayKey, SudoRequest, UiStore } from "../lib/store.ts"

/**
 * Wrap a sudo command for the modal (pure). Newlines split first, then each
 * logical line hard-wraps to `width` code points so no character is dropped —
 * a long unbroken token still shows in full rather than being cut off. Rows are
 * capped at `maxRows`; when capped, the final row becomes an ellipsis marker so
 * the user knows content is hidden.
 */
export function wrapCommand(command: string, width: number, maxRows: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const cap = Math.max(1, Math.floor(maxRows))
  const rows: string[] = []
  for (const logical of command.split("\n")) {
    const chars = [...logical]
    if (chars.length === 0) {
      rows.push("")
      continue
    }
    for (let i = 0; i < chars.length; i += w) {
      rows.push(chars.slice(i, i + w).join(""))
    }
  }
  if (rows.length === 0) rows.push("")
  if (rows.length > cap) {
    rows.length = cap
    rows[cap - 1] = "…"
  }
  return rows
}

/** Narrowest the sudo card may get (keeps the fixed chrome lines readable). */
export const SUDO_CARD_MIN = 16
/** Default width for a short command; a long one widens past this (pure). */
export const SUDO_CARD_BASE = 72

/**
 * Card width for the sudo modal (pure): the base width for a short command,
 * widened so a long command fits with less wrapping, clamped to the terminal
 * (minus a small margin) so the card can never spill past the frame.
 */
export function sudoCardWidth(command: string, termWidth: number): number {
  const max = Math.max(SUDO_CARD_MIN, termWidth - 4)
  let longest = 0
  for (const line of command.split("\n")) longest = Math.max(longest, [...line].length)
  return Math.min(max, Math.max(SUDO_CARD_BASE, longest + 4))
}

export function SudoPrompt(props: { store: UiStore; request: SudoRequest }): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [draft, setDraft] = createSignal("")
  // Opt-in: the user must SELECT caching for the session. When selected the
  // program stores the password in RAM and the agent's hidden shell reuses it
  // for every later sudo command; when not, each sudo use re-prompts
  // (docs/agent.md "Sudo"). Tab toggles this selection.
  const [remember, setRemember] = createSignal(false)

  const settle = (password: string | null): void => {
    props.request.resolve(password, password !== null && remember())
  }

  // The sudo popup is stacked ABOVE whatever overlay is open, so it owns input
  // while it is up; `pushOverlayInput` puts the displaced handlers back when
  // the prompt closes (the overlay underneath does not re-register).
  const keyHandler = (key: OverlayKey): void => {
    if (key.name === "escape") {
      settle(null)
      return
    }
    if (isEnterKey(key) && !key.ctrl) {
      settle(draft())
      return
    }
    if (key.name === "tab") {
      setRemember((r) => !r)
      return
    }
    if (key.ctrl && key.name === "u") {
      setDraft("")
      return
    }
    if (key.name === "backspace") {
      setDraft((d) => [...d].slice(0, -1).join(""))
      return
    }
    // printableKeyText prefers the literal `sequence`, so symbols and shifted
    // punctuation survive (keyChar alone dropped them and the password was fed
    // truncated — see its doc in core/util.ts).
    const ch = printableKeyText(key)
    if (ch !== null) {
      setDraft((d) => (d.length >= 128 ? d : d + ch))
    }
  }
  const pasteHandler = (raw: string): void => {
    const text = singleLinePaste(raw)
    setDraft((d) => (d.length >= 128 ? d : (d + text).slice(0, 128)))
  }
  onCleanup(props.store.pushOverlayInput(keyHandler, pasteHandler))

  const masked = (): string => (draft().length > 0 ? "•".repeat(draft().length) : "")
  // Bounded, centered card (docs/DESIGN.md "Overlays"): never wider than the
  // terminal. A short command keeps the base width; a long one WIDENS the card
  // (up to the terminal) so it fits with less wrapping. The command is WRAPPED
  // onto as many rows as it needs (never truncated) so the user can read the
  // whole thing before handing over a password. Rows are capped to the terminal
  // height so a pathological command cannot spill the card past the frame.
  const cardWidth = (): number => sudoCardWidth(props.request.command, dims().width)
  const commandRows = (): string[] => {
    const inner = Math.max(4, cardWidth() - 4)
    const hasHint = props.request.hint !== undefined && props.request.hint.length > 0
    // Non-command card rows (border + title/subtitle/password/cache/help/blank
    // spacers) plus the optional hint row.
    const maxRows = Math.max(1, dims().height - (hasHint ? 14 : 13))
    return wrapCommand(props.request.command, inner, maxRows)
  }

  return (
    <box
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        // Transparent backdrop: the modal card floats over the pane/chat so the
        // background stays visible. The box is still full-screen and captures
        // clicks (click-outside = decline), it just paints nothing.
        backgroundColor: "transparent",
      }}
      onMouseDown={() => {
        // Click-outside = decline (same as Esc).
        settle(null)
      }}
    >
      <box
        style={{
          flexDirection: "column",
          width: cardWidth(),
          border: true,
          borderStyle: "rounded",
          ...bgProps(t().cardBg),
          ...borderProps(t().borderFocused),
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <box style={{ height: 1 }} />
        <text selectable={false} style={{ fg: t().warning }}> sudo password required </text>
        <text selectable={false} style={{ fg: t().muted }}> the agent's command needs sudo: </text>
        {commandRows().map((row) => (
          <text selectable={false} style={{ fg: t().fg }}>{` ${row} `}</text>
        ))}
        {props.request.hint !== undefined && props.request.hint.length > 0 ? (
          <text selectable={false} style={{ fg: t().warning }}>{` ${props.request.hint} `}</text>
        ) : null}
        <box style={{ height: 1 }} />
        <text selectable={false} style={{ fg: t().fg }}>
          {" password: "}
          <span>{masked()}</span>
          <span style={{ fg: t().onAccent, bg: t().accent }}>{" "}</span>
        </text>
        <box style={{ height: 1 }} />
        <text selectable={false} style={{ fg: remember() ? t().accent : t().muted }}>
          {` [Tab] cache for this session (agent reuses it): ${remember() ? "yes" : "no"} `}
        </text>
        <box style={{ height: 1 }} />
        <text selectable={false} style={{ fg: t().muted }}>
          {" Enter submit · Esc cancel · Tab caches it in RAM "}
        </text>
        <box style={{ height: 1 }} />
      </box>
    </box>
  )
}
