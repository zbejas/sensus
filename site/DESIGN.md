# sensus.sh design

The site is the product's own terminal. It wears a custom token pair (`ink` dark and
`paper` light) built on the app's token roles, and renders the interface (the `tabs`
strip, the focused `terminal ●` card, the `chat` card with its nested `input` card, the
status bar) as the hero artifact, in both real layouts: `layout: "sidebar"` (the default,
tabs on a left rail) and `layout: "topbar"` (tabs on row 0). A CSS-only switch (hidden
radios + labels) flips between them with no JS, and clicking a tab in the rail or the tab
strip switches the mock's session between three homelab examples (`1:sshd`, `2:logs`,
`3:disk`) by clearing the pane and re-printing the chat: an easter egg with no separate
control, the mock's own tabs are the labels. The active tab, the rail, and the status bar
follow it. A note names the two panes. The direction contract lives at the top of
`src/layouts/Base.astro` (first child of `<body>`, survives the production build).

## Palette

Dark is the default; light follows `prefers-color-scheme`. Tokens are in
`src/styles/tokens.css`. The pair is custom (layered slate rather than flat black, warm
paper rather than stark white), and every text token clears 4.5:1 on all three surfaces.

| Token | Dark ("ink") | Light ("paper") | Use |
|---|---|---|---|
| `--bg` | `#11151b` | `#f7f6f2` | page, terminal pane |
| `--bg-card` | `#1a1f27` | `#ffffff` | chat sidebar, bands, code chips |
| `--bg-bar` | `#0c0f14` | `#eeece6` | tab/status bars, keys, buttons |
| `--fg` | `#e9ecf2` | `#1b2027` | primary text |
| `--fg-muted` | `#9ba4b2` | `#59616d` | body/secondary text |
| `--fg-faint` | `#7e8896` | `#5f6874` | comments, chrome, decorative |
| `--border` | `#2b323d` | `#d7d4cc` | frames, rows, hairlines |
| `--accent` | `#58c4d8` | `#0b6b80` | actions, links, active tab |
| `--success` | `#82d09b` | `#1f7a4a` | shell prompts, pass lines |
| `--warning` | `#e6b566` | `#8a5a00` | git hashes, functions |
| `--danger` | `#e97e7e` | `#b83232` | branch names, deletions |

Text selection, focus rings, carets, and scrollbars are themed from the same tokens.

## Type

System sans for prose and display (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, …);
system mono for anything the shell would print (commands, terminal content, status bars,
data labels). No webfonts.

- Display: `clamp(2.6rem, 6.4vw, 5rem)`, weight 700, tracking `-0.035em`.
- Section headings: `clamp(1.7rem, 3.4vw, 2.5rem)`.
- Body measure ≤ 68ch; hero lead ≤ 64ch.

## Composition

A centered product hero over a full-width mock of the real screen, switchable between
`layout: "sidebar"` (tabs on a left rail, the default) and `layout: "topbar"` (tabs on row
0), and between three sessions (sshd hardening, a crash-looping container, a full root
disk); then alternating split sections (terminal, agent), one full-bleed quieter band (the
detach transcript), provider rows, and a loud install close. Sections are separated by
hairlines, not cards; the titled rounded card is the only repeated container. On narrow
viewports the mock follows the app's own chat-only view (top tab bar, chat full width,
status bar kept) instead of shrinking cards into illegibility, and the layout switch is
hidden because both layouts resolve to that same view there; the session switch stays.

The mock's session content is homelab work (an sshd brute-force flood, a crash-looping
container, a full root disk), never repo development, and the session runs as a normal
user (`ops`): privileged steps go through sudo, never a root shell. Every session has the
same shape: the pane runs the plain command a user would reach for and shows its noisy
output, and the chat shows the agent fetching what it needs in a hidden shell (`● done`),
then a plain summary and the gated fix.

Corners mirror the app's card species, so the showcase never rounds what the terminal
cannot paint. Bordered cards (`╭ ╮ ╰ ╯`, one terminal cell) keep a one-cell arc — 5px, not
a large smooth curve. The app's opt-in fill panels (solid surfaces with a half-cell
rectangular notch cut from each corner, the `▟ ▙ ▜ ▛` quadrant glyphs) are not drawn on
the site: every showcase follows the default border cards. The rule
covers every TUI surface the site draws: the hero mock, the agent section's chat
panels, and the terminal section's pane. Site chrome (chips, the install command, the
lifecycle transcript) keeps the site's own radii. The hero install command wears the
latest release as a tag on its bottom-left edge: a page-surface pill riding the card
border (`latest v<version>`, mono, quiet), bound to the root `package.json` at build
time.

## Docs

`/docs` is the manual, and it reads like one: the same ink/paper world as the landing
chrome, tuned for long-form reading rather than the hero.

- **Navigation:** a persistent sidebar (manifest order) on desktop; below 1024px it becomes
  an off-canvas drawer behind a sticky `Contents` bar, with a backdrop, Escape/backdrop
  close, focus return, and a focus trap. Without scripting it stays a plain list above the
  content.
- **Orientation:** an "On this page" rail (sticky, h2/h3) at 1280px and up, and the same
  list as a disclosure on smaller screens. Headings carry `scroll-margin-top` so anchor
  jumps clear the sticky chrome.
- **Reading:** prose measure 74ch, body 1.0625rem on desktop, hairline section rules, a
  prev/next pager in manifest order, and copy buttons on code blocks. Tables pan
  horizontally in a runtime `table-wrap` when they outgrow the column.
- **Chrome:** the landing nav and the docs bar go solid on docs pages, so scrolled text
  never bleeds through the header.
- **Active state:** the sidebar marks the current page with the brand's block cursor (a
  small accent square) plus weight, not a colored border. On a page change the cursor is
  the transition's shared element: it glides from the old entry to the new one while the
  page reprints.

## Motion

The page boots like the app. The hero banner eases in (`.rise`, 0.55s ease-out, a 10px
rise) while the mock's chrome prints: the status bar repaints left to right, the chat
assembles panel by panel (`.boot` + `--d` delays), and the terminal output is already
there. Terminal surfaces print instantly (`visibility` steps, a main-thread property, so
no composited layers are left behind for large captures to drop); the pane's lines are
deliberately never animated, because a line-level entrance is what large captures dropped.

Clicking a tab switches sessions like the real thing: the pane clears and the new chat
prints in sequence, the active marker moves, and the status bar repaints. Switching layouts
re-arranges the same screen continuously: the rail track interpolates to zero (both sides
keep three grid tracks so the columns can animate), the rail and tab strip crossfade, and
the tab strip takes row 0. Both switches stay CSS-only (radios + `:has()`), and a narrow
floor on the chat log keeps the three sessions from changing the mock's height.

Scrolling adds: prose rises once per section (`data-reveal`), terminal surfaces pop in
place (`data-reveal-step`), lists arrive as lists with a capped stagger
(`data-reveal-stagger`), the lifecycle transcript prints in story order
(`data-reveal-print`), and the approval markers breathe while on screen (`data-pulse`,
paused offscreen by the same observer). The nav gains elevation over the first 72px of
scroll (a scroll-driven animation where supported). Reveals are progressive enhancement:
`js` is added before first paint, `reveal-fallback` restores everything if the observer
fails, and without scripting every element is simply visible.

Moving between pages reprints the content like the terminal: a cross-document view
transition clears the current content to the surface and prints the next one in (the same
short rise as the hero), while the frame — the top nav, the docs sidebar and bar, and the
footer — is named and holds perfectly still. On `/docs` the sidebar's block cursor is the
shared element: it glides from the old entry to the new one while the page reprints, so
the manual keeps its place. The opt-in and the frame rules live in
`src/styles/global.css`; the names sit on the components. This is progressive
enhancement too: browsers without the API (Firefox today) navigate exactly as before,
and reduced motion keeps the page change without the animation.

Feedback stays small: the copy button presses and pings a success ring, buttons and nav
links draw their underline, the caret and the vim block cursor blink. All motion is
disabled under `prefers-reduced-motion` (spatial movement removed, state changes kept),
and hover/focus transitions use the exponential ease-out token (`--ease-out`).

## Assets

- `public/favicon.svg`: the wordmark at icon size — lowercase `s` + block cursor on ink.
- `public/og.png`: rendered from `src/assets/og.svg` by `bun run og` (`scripts/og.ts`); the
  script is its provenance. `src/layouts/Base.astro` folds the raster's content hash into
  the `og:image`/`twitter:image` URL, so social crawlers refetch a re-rendered card instead
  of serving their cached copy.
- `../assets/ui.svg` + `ui-topbar-disk.svg`: the README's hero and topbar example, generated
  from the built mock by `bun run readme-svg` (`scripts/readme-svg.ts`) — a headless-Chrome
  DOM capture that pins every text run with `textLength`, so the layout holds across
  platforms. Re-run it after any mock change.
- The hero mock and every section visual are authored HTML/CSS; there are no screenshots.
