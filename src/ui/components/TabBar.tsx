/**
 * TabBar: the top row — one tab = one terminal session = one chat session.
 *
 * Visual language (docs/DESIGN.md "Tab bar"): the ACTIVE tab carries an accent
 * `●` marker and an accent bold label; inactive tabs are neutral (muted index +
 * bar value). A muted ` × ` after each tab closes it (its own click region, so
 * it never selects), a muted `│` separates tabs, ` + new tab` opens a new tab,
 * and the right-aligned `? commands` button opens the palette. Key hints
 * (ctrl+t/ctrl+w) live in the palette and /help instead of the bar.
 *
 * Session activity (the "which tab needs me?" read): a busy tab appends one
 * glyph — `!` while an approval is pending (warning), else the shared streaming
 * spinner in the accent. Idle tabs append nothing, so the bar stays quiet until
 * a tab has something to say.
 *
 * opentui spans cannot carry handlers, so the row is ONE <text>; the clicked /
 * hovered column maps back onto a part (src/ui/lib/bar.ts). Pointer hover
 * paints the theme selection fill and a press flashes the accent block — the
 * same feedback every clickable row uses.
 */

import { type JSX } from "@opentui/solid"
import { For } from "solid-js"
import { bgProps, theme } from "../../theme/theme.ts"
import type { TabView } from "../lib/store.ts"
import { tabActivity, tabTitle } from "../lib/tabs.ts"
import { truncateWithEllipsis } from "../../core/util.ts"
import { barFlex, createBarRow, fitBarParts, type BarFitRule, type BarPart, type BarSpan } from "../lib/bar.ts"

/** Titles render (and region-map) truncated to this many visible chars. */
const TAB_TITLE_MAX = 24

/** The ` + new tab` affordance at the end of the tab list (opens a new tab).
 * Full words (not just ` + `) so the click target matches the rail's pinned
 * row and reads as a named button (docs/DESIGN.md "Tab bar"). */
const NEW_TAB_LABEL = " + new tab"

/** Per-tab close affordance (docs/DESIGN.md "Tab bar"); own region, muted idle.
 * `×` (U+00D7) is Latin-1 — covered by every monospace font, so it renders at
 * text scale/width; `✕` (U+2715) is not, and terminals fall back to a symbol
 * font that draws it large/double-width, breaking the bar's cell math. */
const TAB_CLOSE_GLYPH = "×"

/** The right-aligned palette button: a named button with a `?` affordance
 * (opens the Ctrl+P command menu — the `?` hints "what commands are there?").
 * The shortcut is no longer its label; hints live in the palette and /help. */
const MENU_GLYPH = "?"
const MENU_LABEL = "commands"

export function TabBar(props: {
  tabs: TabView[]
  activeTabId: number | null
  /** Terminal width — the palette button is padded to the bar's right edge. */
  width: number
  /** Click on tab region i (0-based); App selects it or refocuses the pane. */
  onSelectTab?: (index: number) => void
  /** Click on tab i's `×`; App closes that tab (streaming arm applies). */
  onCloseTab?: (index: number) => void
  /** Click on the " + " affordance. */
  onNewTab?: () => void
  /** Click on the right-aligned palette button. */
  onOpenMenu?: () => void
}): JSX.Element {
  const t = () => theme()
  const innerWidth = (): number => Math.max(props.width - 2, 0)

  const build = (): BarPart[] => {
    const out: BarPart[] = []
    props.tabs.forEach((tab, i) => {
      if (i > 0) out.push({ id: "tab-sep", spans: [{ text: "│ ", tone: "label" }], separator: true })
      const active = tab.id === props.activeTabId
      const title = truncateWithEllipsis(tabTitle(tab), TAB_TITLE_MAX)
      const activity = tabActivity(tab)
      // The title is its own span (index 2) so the overflow fitter can shrink
      // it with an ellipsis while the marker, index and activity glyph survive.
      const spans: BarSpan[] = [
        // Fixed 2-cell marker slot so the labels align across tabs.
        { text: active ? "● " : "  ", tone: active ? "accent" : "muted", bold: active },
        { text: `${i + 1}:`, tone: active ? "accent" : "value", bold: active },
        { text: title, tone: active ? "accent" : "value", bold: active },
      ]
      if (activity !== null) spans.push({ text: ` ${activity.glyph}`, tone: activity.tone, bold: true })
      out.push({ id: `tab:${tab.id}`, spans, onClick: () => props.onSelectTab?.(i) })
      // A separate part (not a span) so the click closes instead of selecting.
      // Symmetric ` × ` so the hover fill is centered on the glyph.
      out.push({
        id: `tab-close:${tab.id}`,
        spans: [{ text: ` ${TAB_CLOSE_GLYPH} `, tone: "muted" }],
        onClick: () => props.onCloseTab?.(i),
      })
    })
    out.push({ id: "new-tab", spans: [{ text: NEW_TAB_LABEL, tone: "label" }], onClick: () => props.onNewTab?.() })
    out.push(barFlex())
    out.push({
      id: "menu",
      spans: [
        { text: MENU_GLYPH, tone: "label" },
        { text: " ", tone: "label" },
        { text: MENU_LABEL, tone: "value" },
      ],
      onClick: () => props.onOpenMenu?.(),
    })

    // Overflow priority (docs/DESIGN.md "Tab bar"): shrink every title evenly
    // first, then drop tabs from the right (the active tab last) and finally
    // the ` + new tab ` affordance. The ` ? commands ` button is never dropped —
    // it stays mouse-reachable at any width (keyboard: Ctrl+P).
    const activeId = props.activeTabId
    // One balanced truncate rule over every tab, so titles shrink together
    // instead of the leftmost tab being starved.
    const plan: BarFitRule[] = [
      { ids: props.tabs.map((tab) => `tab:${tab.id}`), mode: "truncate", span: 2, min: 4 },
    ]
    for (const tab of [...props.tabs].reverse()) {
      if (tab.id === activeId) continue
      plan.push({ ids: [`tab:${tab.id}`, `tab-close:${tab.id}`], mode: "drop" })
    }
    plan.push({ ids: ["new-tab"], mode: "drop" })
    for (const tab of [...props.tabs].reverse()) {
      if (tab.id !== activeId) continue
      plan.push({ ids: [`tab:${tab.id}`, `tab-close:${tab.id}`], mode: "drop" })
    }

    return fitBarParts(out, innerWidth(), plan)
  }

  const row = createBarRow({ build, innerWidth })

  return (
    <box
      style={{
        height: 1,
        flexDirection: "row",
        ...bgProps(t().barBg),
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        selectable={false}
        style={{ fg: t().barFg }}
        onMouseMove={row.onMouseMove}
        onMouseOut={row.onMouseOut}
        onMouseDown={row.onMouseDown}
      >
        <For each={row.spans()}>{(s) => <span style={s.style}>{s.text}</span>}</For>
      </text>
    </box>
  )
}
