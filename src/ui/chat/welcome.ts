/**
 * First-run onboarding model (docs/operations.md "Setup flow"). After
 * `sensus init` saves the config it boots the TUI and opens the "welcome"
 * overlay over the live UI; this module is the PURE page model the component
 * renders (page list, navigation clamp, card size, and the hotkey cheat sheet),
 * kept free of Solid/renderer imports so it is unit-tested without a terminal.
 *
 * The onboarding is deliberately a MODAL over the real app, not a separate
 * setup renderer: the user watches the actual chrome (sidebar, top bar, chat)
 * while it is explained, and dismissing the last page simply leaves them in
 * sensus — no "now run `sensus`" step.
 *
 * The card is deliberately SMALL (not the bounded-large 90% × 85% the other
 * overlays use) so the real interface stays visible behind it; the `l` preview
 * flips the REAL layout, not a drawing, so the user watches the chrome change
 * live. `welcomeCardSize` owns that compact geometry (pure, clamped).
 */

export type WelcomePageId = "layout" | "keys"

export interface WelcomePage {
  id: WelcomePageId
  /** Header title for the page. */
  title: string
  /** One-line orientation under the title. */
  blurb: string
}

/** The onboarding pages, in order. */
export const WELCOME_PAGES: readonly WelcomePage[] = [
  {
    id: "layout",
    title: "the layout",
    blurb: "your shell on the left, the agent's chat on the right",
  },
  {
    id: "keys",
    title: "getting around",
    blurb: "the chrome is clickable and every action has a hotkey",
  },
]

/**
 * Step the page index by `dir`, clamped to the page range. Callers detect the
 * end themselves to close instead of stepping (see the component).
 */
export function welcomeStep(index: number, dir: -1 | 1, count: number = WELCOME_PAGES.length): number {
  if (count <= 0) return 0
  const base = Number.isFinite(index) ? Math.trunc(index) : 0
  return Math.max(0, Math.min(count - 1, base + dir))
}

/**
 * Preferred compact card size for the tour, in cells. Much smaller than the
 * bounded-large overlay default so the live layout stays visible around it.
 * Width/height are clamped to the terminal (and floored) by
 * `welcomeCardSize`; a card that covered the real chrome would defeat the
 * whole "watch the interface behind it" point.
 */
export const WELCOME_CARD_WIDTH = 96
export const WELCOME_CARD_HEIGHT = 26

/**
 * Compact card geometry for a terminal size (pure). The preferred size is used
 * on a roomy terminal; on a narrower one the card shrinks to leave room for the
 * interface (at most ~55% of the columns) and never spills past the frame.
 */
export function welcomeCardSize(dims: { width: number; height: number }): { width: number; height: number } {
  const width = Math.max(8, Math.min(WELCOME_CARD_WIDTH, Math.max(40, Math.floor(dims.width * 0.55)), Math.max(8, dims.width - 2)))
  const height = Math.max(3, Math.min(WELCOME_CARD_HEIGHT, Math.max(12, Math.floor(dims.height * 0.55)), Math.max(3, dims.height - 2)))
  return { width, height }
}

/** One entry of the "getting around" cheat sheet. */
export interface WelcomeKey {
  keys: string
  what: string
}

/**
 * The first-run pointers — enough to know the chrome is clickable and where
 * the palette / slash commands / focus switch live, not the full keymap
 * (docs/keybindings.md has that, `/keys` remaps it).
 */
export const WELCOME_KEYS: readonly WelcomeKey[] = [
  { keys: "Ctrl+P", what: "command palette (`? commands` button)" },
  { keys: "/", what: "slash commands in chat — or just ask in plain English" },
  { keys: "Shift+Tab", what: "switch focus between the terminal and the chat" },
  { keys: "Ctrl+T / Ctrl+W", what: "new tab / close tab (the shell keeps running)" },
  { keys: "Ctrl+O", what: "settings — theme, layout, endpoints, models" },
  { keys: "Alt+M / Alt+Y", what: "agents / approval mode" },
  { keys: "Ctrl+W on every tab", what: "quit sensus (sessions keep running in the daemon)" },
]
