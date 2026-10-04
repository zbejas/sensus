/**
 * ToastPanel — the floating notification card (docs/architecture.md
 * "Toasts"): mounted by App as the LAST child (topmost), keyed per toast so
 * every toast gets fresh cells (a shorter toast must fully repaint the rows
 * a longer one occupied). Anchored to the screen's top-right, dropped a couple
 * of rows below the tab bar and inset from the right edge (never steals
 * tab-bar clicks). Opaque solid card (theme cardBg — an overlay paints a panel
 * by design; the M5 zero-bg invariant applies with overlays/toasts closed),
 * padded on all sides, level-colored text + glyph. No key/mouse handlers:
 * toasts never take input.
 */

import { type JSX } from "@opentui/solid"
import { For } from "solid-js"
import { bgProps, theme } from "../../theme/theme.ts"
import {
  TOAST_CHROME_X,
  TOAST_MARGIN_RIGHT,
  TOAST_MARGIN_TOP,
  TOAST_MAX_WIDTH,
  TOAST_PAD_X,
  TOAST_PAD_Y,
  toastGlyph,
  toastLines,
  toastPanelWidth,
  toastToken,
  type Toast,
} from "../lib/toast.ts"

export function ToastPanel(props: { toast: Toast; screenWidth: number }): JSX.Element {
  const t = () => theme()
  // Wrap width excludes the card chrome (glyph column + padding) and the right
  // margin, capped by TOAST_MAX_WIDTH so the card never renders wider than it can.
  const wrapWidth = () =>
    Math.min(TOAST_MAX_WIDTH, Math.max(8, props.screenWidth - TOAST_CHROME_X - TOAST_MARGIN_RIGHT))
  const lines = () => toastLines(props.toast.message, wrapWidth())
  const width = () => toastPanelWidth(lines(), wrapWidth())
  const left = () => Math.max(0, props.screenWidth - width() - TOAST_MARGIN_RIGHT)
  const token = () => t()[toastToken(props.toast.level)]
  return (
    <box
      style={{
        position: "absolute",
        top: TOAST_MARGIN_TOP,
        left: left(),
        width: width(),
        flexDirection: "column",
        ...bgProps(t().cardBg),
        paddingTop: TOAST_PAD_Y,
        paddingBottom: TOAST_PAD_Y,
        paddingLeft: TOAST_PAD_X,
        paddingRight: TOAST_PAD_X,
      }}
    >
      <For each={lines()}>
        {(line, i) => {
          const body = line.length === 0 ? " " : line
          return (
            <text selectable={false} style={{ fg: token() }}>{i() === 0 ? `${toastGlyph(props.toast.level)} ${body}` : `  ${body}`}</text>
          )
        }}
      </For>
    </box>
  )
}
