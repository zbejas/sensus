/**
 * Shared overlay chrome: a centered, bounded MODAL card floating over a
 * transparent, input-capturing backdrop (docs/DESIGN.md "Overlays"). The card
 * FILLS a fixed 90%-wide × 85%-tall area (bounded-large), so the pane/chat
 * stays visible around it and every menu reads as a modal instead of a
 * full-screen window — the same interaction shape as the sudo prompt.
 *
 * A caller may pass a compact `width`/`height` to `OverlayPanel` (clamped to
 * the terminal): the welcome tour does, so the live layout stays visible behind
 * the explanation and the `l` preview can flip it in place.
 *
 * Overlays swallow all input via the store's single overlayKeyHandler dispatch
 * point (each component assigns its own handler); the backdrop's
 * click-outside-to-close is wired here.
 *
 * `overlayMetrics()` is the single source of truth for the card's size and the
 * row/column budgets components use to window their lists — a list must never
 * exceed `innerHeight` or it would spill past the frame.
 */

import { type JSX, useTerminalDimensions } from "@opentui/solid"
import { bgProps, borderProps, theme, type ResolvedTheme, type ThemeColor } from "../../theme/theme.ts"

/** Cap the modal card at this fraction of the terminal (bounded-large). */
export const OVERLAY_WIDTH_RATIO = 0.9
export const OVERLAY_HEIGHT_RATIO = 0.85

export interface OverlayMetrics {
  /** Outer card width in cells (border included). */
  width: number
  /** Outer card height in cells (border included). The card fills this. */
  height: number
  /** Usable cells inside the border (the row/column budget). */
  innerWidth: number
  innerHeight: number
}

/**
 * Modal geometry for a terminal size. Width/height are the ratios above, never
 * larger than the terminal minus a 1-cell frame, and floored so the card stays
 * drawable on a tiny terminal (the app refuses < 20x5 anyway).
 */
export function overlayMetrics(dims: { width: number; height: number }): OverlayMetrics {
  const width = Math.max(8, Math.min(Math.max(8, dims.width - 2), Math.floor(dims.width * OVERLAY_WIDTH_RATIO)))
  const height = Math.max(3, Math.min(Math.max(3, dims.height - 2), Math.floor(dims.height * OVERLAY_HEIGHT_RATIO)))
  return { width, height, innerWidth: Math.max(1, width - 2), innerHeight: Math.max(1, height - 2) }
}

/** Centered modal card; per-overlay content is slotted.
 *
 * `width`/`height` are an optional COMPACT override in cells (clamped to the
 * terminal): the welcome tour uses them so the live layout stays visible around
 * the card, while every other overlay keeps the bounded-large default of
 * `overlayMetrics`. */
export function OverlayPanel(props: {
  title: string
  onClose: () => void
  children: JSX.Element
  width?: number
  height?: number
}): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const m = () => overlayMetrics(dims())
  const cardWidth = (): number => Math.max(8, Math.min(m().width, Math.round(props.width ?? m().width)))
  const cardHeight = (): number => Math.max(3, Math.min(m().height, Math.round(props.height ?? m().height)))
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
        // Transparent backdrop: the pane/chat stays visible behind the card.
        // The box is still full-screen and captures clicks/keys (click-outside
        // closes), it just paints nothing.
        backgroundColor: "transparent",
      }}
      onMouseDown={(e) => {
        // Click-outside closes; rows stop propagation below, and an inside
        // click's target is never the backdrop itself.
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <box
        title={props.title}
        titleAlignment="left"
        titleColor={t().accent}
        style={{
          flexDirection: "column",
          width: cardWidth(),
          height: cardHeight(),
          border: true,
          borderStyle: "rounded",
          ...bgProps(t().cardBg),
          ...borderProps(t().borderFocused),
        }}
      >
        {props.children}
      </box>
    </box>
  )
}

/**
 * Style for one selectable overlay row.
 *
 * Selection is marked by the caller's `❯` arrow + accent fg ONLY — no
 * full-width bar (owner decision: "arrow-marker-only"). The mouse hover is
 * the one place a background highlight appears, so pointer users can see what
 * a click will hit.
 *
 * ALWAYS returns an explicit `bg`. opentui style objects are ADDITIVE: keys
 * omitted from a new style never reset a previously painted color, so a row
 * that once carried a hover/selection background would keep it forever — the
 * "items stay selected when I move down" bug. Unselected/selected rows set
 * `bg: "transparent"` so the card shows through and any stale fill clears.
 */
export function overlayRowStyle(
  t: ResolvedTheme,
  selected: boolean,
  unselectedFg: ThemeColor,
  hovered = false,
): Record<string, unknown> {
  if (selected) return { bg: "transparent", fg: t.accent }
  if (hovered) {
    // selectionBg is the strongest available fill; when a theme has none
    // (rare — adaptive detection usually derives one) hover falls back to the
    // accent fg so it is still visible.
    if (t.selectionBg !== null) return { bg: t.selectionBg, fg: t.onSelection ?? t.fg }
    return { bg: "transparent", fg: t.accent }
  }
  return { bg: "transparent", fg: unselectedFg }
}

/** Drop the last CHARACTER of a filter draft (backspace in the overlays —
 * a codepoint slice, not a UTF-16 unit slice). */
export function backspaceFilter(filter: string): string {
  return [...filter].slice(0, -1).join("")
}
