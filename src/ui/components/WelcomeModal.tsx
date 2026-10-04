/**
 * WelcomeModal — the post-`sensus init` first-run onboarding overlay
 * (docs/operations.md "Setup flow"). App opens it after a setup save and it
 * floats over the LIVE UI, so the user is already in sensus while the layout /
 * chat / keys are explained. Dismissing the last page (or Esc) leaves them there.
 *
 * Two pages (src/ui/chat/welcome.ts owns the pure model):
 *   1 layout  flips the REAL tab strip (left rail vs topbar) with `l`
 *   2 keys    the hotkey cheat sheet
 *
 * The card is deliberately SMALL (`welcomeCardSize`, not the bounded-large
 * overlay default) so the real interface stays visible behind it. The layout
 * preview is LIVE: `l` calls `store.setLayoutMode`, so the user watches the
 * actual topbar/rail rebuild behind the card instead of a drawing — and the
 * pick is SAVED (written to config.json via `onLayoutPick`), so it survives a
 * relaunch. Ctrl+O → Appearance reopens the same switch.
 *
 * Interaction mirrors the other overlays: keys arrive through
 * `store.overlayKeyHandler`, the backdrop click closes, every control is
 * clickable, and `←`/`→`/`Enter`/`Tab` page through the tour.
 */

import { type JSX, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { type LayoutMode } from "../../engine/index.ts"
import { theme } from "../../theme/theme.ts"
import { isEnterKey } from "../../core/util.ts"
import type { UiStore, OverlayKey } from "../lib/store.ts"
import { OverlayPanel } from "./overlayKit.tsx"
import { WELCOME_KEYS, WELCOME_PAGES, welcomeCardSize, welcomeStep, type WelcomePageId } from "../chat/welcome.ts"

export interface WelcomeModalProps {
  store: UiStore
  onClose: () => void
  /**
   * Persist the tab-strip layout the user picks with `l` (writes config.json +
   * live-reloads). Optional so the modal still renders in isolation; when
   * absent the session-scoped `store.setLayoutMode` still applies.
   */
  onLayoutPick?: (mode: LayoutMode) => void
}

export function WelcomeModal(props: WelcomeModalProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const card = () => welcomeCardSize(dims())

  const [page, setPage] = createSignal(0)
  const [hover, setHover] = createSignal<string | null>(null)

  /** The REAL layout behind the card — `l` previews by changing it live. */
  const rail = (): boolean => props.store.layoutMode() === "sidebar"

  const current = () => WELCOME_PAGES[Math.min(page(), WELCOME_PAGES.length - 1)]!
  const pageId = (): WelcomePageId => current().id
  const lastPage = (): boolean => page() >= WELCOME_PAGES.length - 1

  /** Advance; from the last page it dismisses the tour (leaving you in sensus). */
  const next = (): void => {
    if (lastPage()) props.onClose()
    else setPage((p) => welcomeStep(p, 1))
  }
  const prev = (): void => {
    setPage((p) => welcomeStep(p, -1))
  }

  // App routes ALL keys through store.overlayKeyHandler while the overlay is
  // open (the single dispatch point).
  props.store.overlayKeyHandler = (key: OverlayKey) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if ((key.name === "q" || key.name === "s") && !key.ctrl && !key.meta) {
      props.onClose()
      return
    }
    if (key.name === "l" && pageId() === "layout") {
      // Live preview: flip the actual layout so the user sees the chrome change
      // behind the card, and SAVE the pick (config.json) so it survives a
      // relaunch. Ctrl+O → Appearance reopens the same switch.
      const next: LayoutMode = rail() ? "topbar" : "sidebar"
      props.store.setLayoutMode(next)
      props.onLayoutPick?.(next)
      return
    }
    if (key.name === "right" || key.name === "down" || key.name === "tab" || key.name === "space" || isEnterKey(key)) {
      next()
      return
    }
    if (key.name === "left" || key.name === "up" || key.name === "BTab") {
      prev()
      return
    }
  }

  const btnStyle = (key: string, primary = false): Record<string, unknown> => {
    if (hover() === key) return { bg: t().selectionBg ?? "transparent", fg: t().onSelection ?? t().fg }
    return { bg: "transparent", fg: primary ? t().accent : t().fg }
  }

  return (
    <OverlayPanel
      title=" welcome to sensus "
      onClose={props.onClose}
      width={card().width}
      height={card().height}
    >
      <text selectable={false} style={{ fg: t().accent }}>{` ${current().title} `}</text>
      <text selectable={false} style={{ fg: t().muted }}>{` ${current().blurb} `}</text>
      <box style={{ height: 1 }} />

      <Show when={pageId() === "layout"}>
        <text selectable={false} style={{ fg: t().muted }}>
          {" the real layout is behind this card — flip it and watch. "}
        </text>
        <box style={{ height: 1 }} />
        <text selectable={false} style={{ fg: t().fg }}>
          {"  press "}
          <span style={{ fg: t().onAccent, bg: t().accent }}>{" l "}</span>
          {" to switch the tab strip live"}
        </text>
        <text selectable={false} style={{ fg: t().muted }}>
          {"  selected: "}
          <span style={{ fg: t().accent }}>
            {rail() ? "sidebar layout — tabs on a left rail" : "topbar layout — tabs on row 0"}
          </span>
        </text>
        <text selectable={false} style={{ fg: t().muted }}>{"  saved to config.json — reopen it in Ctrl+O → Appearance. "}</text>
      </Show>

      <Show when={pageId() === "keys"}>
        <For each={WELCOME_KEYS}>
          {(k) => (
            <text selectable={false}>
              <span style={{ fg: t().accent }}>{`  ${k.keys.padEnd(20)}`}</span>
              <span style={{ fg: t().fg }}>{k.what}</span>
            </text>
          )}
        </For>
        <box style={{ height: 1 }} />
        <text selectable={false} style={{ fg: t().muted }}>
          {" everything above is clickable too — tabs, chat cards, the status bar "}
        </text>
      </Show>

      {/* Spacer: keeps the page controls pinned to the bottom of the card. */}
      <box style={{ flexGrow: 1 }} />
      <box style={{ flexDirection: "row" }}>
        <For each={WELCOME_PAGES}>
          {(p, i) => (
            <text
              selectable={false}
              style={{ fg: i() === page() ? t().accent : t().muted }}
              onMouseOver={() => setHover(`dot:${i()}`)}
              onMouseOut={() => setHover((h) => (h === `dot:${i()}` ? null : h))}
              onMouseDown={(e) => {
                e.stopPropagation()
                setPage(i())
              }}
            >
              {i() === page() ? " ● " : " ○ "}
            </text>
          )}
        </For>
        <text selectable={false} style={{ fg: t().muted }}>{`  ${page() + 1}/${WELCOME_PAGES.length}  `}</text>
        <Show when={page() > 0}>
          <text
            selectable={false}
            style={btnStyle("btn:back")}
            onMouseOver={() => setHover("btn:back")}
            onMouseOut={() => setHover((h) => (h === "btn:back" ? null : h))}
            onMouseDown={(e) => {
              e.stopPropagation()
              prev()
            }}
          >
            {" ← back   "}
          </text>
        </Show>
        <text
          selectable={false}
          style={btnStyle("btn:next", true)}
          onMouseOver={() => setHover("btn:next")}
          onMouseOut={() => setHover((h) => (h === "btn:next" ? null : h))}
          onMouseDown={(e) => {
            e.stopPropagation()
            next()
          }}
        >
          {` ${lastPage() ? "start sensus" : "next"} ▶ `}
        </text>
      </box>
      <text selectable={false} style={{ fg: t().muted }}>
        {" ←/→ pages · Enter next · Esc skip — you're already in sensus "}
      </text>
    </OverlayPanel>
  )
}
