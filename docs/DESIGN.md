# Design System: Sensus

The visual and interaction rules of the TUI. Color and theme behavior has one canonical
home here; [`config.md`](config.md) documents the config keys that tune it and
[`keybindings.md`](keybindings.md) documents the input map.

## Overview

**North star: "The quiet terminal companion."**

The terminal is the product; sensus is chrome around it. The default adaptive theme
keeps chrome **background-free**, so the user's own terminal palette shows through and
sensus looks native next to their shell — message cards default to rounded borders
(`chat.cardStyle: "border"`); the opt-in fill panels (`chat.cardStyle: "fill"`) are the
one deliberate exception. Structure is neutral — muted text, quiet bars, grey borders —
while the chromatic accent is reserved for meaning: focused box titles, selection, active
tabs. The agent sidebar is calm until it has something to say.

Key characteristics:

- Zero painted backgrounds in the default `terminal` theme's chrome; the opt-in chat fill
  panels are the deliberate exception (see the zero-background invariant).
- Neutral structure (palette-index greys) + one accent for focus/selection.
- Focus reads through the border **title** color, not a full accent border.
- Pane content preserves the inner app's colors and bold/underline/dim/reverse via the
  embedded VT.
- One toast slot, top-right, never stealing tab-bar clicks.
- Rounded chrome on the terminal box, sidebar, input, and overlays.

## Layout

```
layout: "topbar"  (tab strip on row 0; the rail is hidden)
row 0   ┌────────────────────────────────────────────┬─────────────────────┐
        │ ● 1:zsh │ 2:logs  + new tab   ? commands      │  chat (active tab)  │
        ├────────────────────────────────────────────┤    [ⓘ toast float]  │
        │                                            │                     │
        │  active tab's pane (embedded VT screen)     │  messages (scroll)  │
        │                                            │  tool/approval cards│
        │                                            ├─────────────────────┤
        │                                            │  input box          │
        ├────────────────────────────────────────────┴─────────────────────┤
bottom  │ tab 1:zsh · cwd:…      chat:… · model · ✱ agent · confirm          │
        └──────────────────────────────────────────────────────────────────┘

layout: "sidebar" (default)
row 0   ┌───────────┬────────────────────────────────┬─────────────────────┐
        │ tabs      │                                │  chat (active tab)  │
        │ ● 1:zsh   │                                │    [ⓘ toast float]  │
        │   2:logs  │  active tab's pane             │  messages (scroll)  │
        │           │  (embedded VT screen)          │  tool/approval cards│
        │           │                                ├─────────────────────┤
        │           │                                │  input box          │
        │ + new tab │                                │                     │
        │ ? commands│                                │                     │
bottom  ├───────────┴────────────────────────────────┴─────────────────────┤
        │ tab 1:zsh · cwd:…      chat:… · model · ✱ agent · confirm          │
        └──────────────────────────────────────────────────────────────────┘
```

The bars are the one place the accent is turned on for structure: the active tab
carries an accent `●` marker and the selected/clickable status chips light up
under the pointer (selection fill) and flash the accent block on press — the
same feedback every clickable row uses.

**Chat-only view** (`Alt+Home`, ephemeral; also the Ctrl+P "Chat-only view" row):
the terminal pane, its divider and the tab rail are hidden and the chat card spans the
full width, with the horizontal top tab bar forced on and the status bar kept. It targets
narrow/mobile terminals where the pane would be unusable, and turns on **automatically** on a
narrow terminal (`autoChatOnly`, default on; width ≤ 90 cols) so mobile users never press the
key — the manual toggle overrides the auto-switch for the session. The configured `layout`
(`topbar`/`sidebar`) is never written — toggling off restores it exactly — focus is clamped
to the chat, and the hidden pane's PTY keeps its normal cell size so nothing SIGWINCH-resizes.

| Region | Owner | Contents |
|---|---|---|
| Tab bar (row 0, `layout: "topbar"`) | `ui/components/TabBar.tsx` | One entry per tab (title = the session title, shell basename fallback) with a `×` close region, a muted `│` separator, a ` + new tab ` affordance, a one-glyph activity marker on a busy tab, and the right-aligned ` ? commands ` button; one text row, region-mapped clicks + hover. Hidden in `layout: "sidebar"` |
| Tab rail (far left, `layout: "sidebar"`) | `ui/components/TabRail.tsx` | The vertical replacement for the top bar: a full-height rounded card with one row per tab (`●` active marker + accent bold label, a muted/neutral inactive index + title, a symmetric ` × ` close region, a busy-tab activity glyph), windowed when the list overflows, plus pinned ` + new tab` / ` ? commands` rows at the bottom; the remaining card height is painted as full-width blank rows so every rail cell is repainted each frame (stale-paint safe); region-mapped clicks + hover. Absent in `topbar` mode |
| Terminal pane | `ui/components/TerminalPane.tsx` | The active tab's `EmbeddedTerminalRenderable` — native VT screen, cursor, and scrollback; not a capture pipeline. A full rounded bordered card, clipped (`overflow: hidden`) so the terminal can never blit outside it. A width-1 **overlay scrollbar** rides its right edge when history exists (thumb = the theme `scrollbar` token over a transparent track, drag/click to scroll, auto-hidden on the alternate screen) and never reserves a PTY column |
| Pane divider | `ui/components/PaneDivider.tsx` | The 1-column gap between the two cards; invisible until hovered/dragged, when an accent `│` appears. Drag it to resize the sidebar (App clamps min 30 / 50%) |
| Chat sidebar | `ui/components/ChatSidebar.tsx` | Messages, tool/approval cards, thinking blocks, the slash menu, and the input box. A full rounded bordered card |
| Status bar (bottom row) | `ui/components/StatusBar.tsx` | A left context group (tab · cwd · terminal health) and a right agent group (chat · model · context · think · `✱` agent · approval · no-tools · conditional `mcp`), an elastic gap between them; one text row, region-mapped clicks + hover |
| Toast float | `ui/components/ToastPanel.tsx` | One transient notification as a solid padded card, top-right, inset below the tab bar and from the right edge |
| Overlays | `ui/components/{CommandMenu,ModelPicker,AgentPicker,ThemePicker,SettingsScreen,MemoryManager,SessionsSearch,ContextInspector,UsageDashboard,KeymapEditor,SkillsManager,AttachPicker,ResumePicker}.tsx` | Centered modal cards filling a bounded 90% × 85% area over a transparent, input-capturing backdrop; swallow all input while open. Includes the two boot pickers (re-attach / `--resume`), presented in-app like the rest |
| Welcome tour | `ui/components/WelcomeModal.tsx` | The first-run onboarding: the same centered modal, but a deliberately COMPACT card (`welcomeCardSize`) so the live layout stays visible behind it; `l` flips the real tab strip in place and saves the pick to config.json |
| Sudo prompt | `ui/components/SudoPrompt.tsx` | The same centered modal shape, but sized to its narrow content (the pane/chat stays visible around it); swallows all input while open |

**Chat sidebar** width defaults to 50 columns. Hotkey resize (`Alt+,`/`Alt+.`, labelled
"shrink / grow the chat") and dragging the pane divider both clamp to min 30 / max 50% of the
terminal; in the `"sidebar"` layout the clamp reserves the vertical tab rail's footprint too,
so the chat and rail together never claim more than half the terminal (the pane keeps the
majority). The `sidebar.width` config key accepts 20–200. The separate **tab rail** width
(`tabs.width`, `layout: "sidebar"`) is documented under "Tab rail" below.

## Focus model

Exactly one region is focused: the terminal pane or the chat input. All keys route to
the focused region except reserved global hotkeys and the Ctrl+A prefix. The chat input
caret renders only in chat focus; the terminal cursor is the native VT cursor owned by the
renderable (there is no synthesized overlay).

The vertical tab rail (`layout: "sidebar"`) is not a keyboard focus region: its
clickable chrome is reached with the mouse only, so `Shift+Tab` stays a terminal
⇄ chat swap.

## Color and theme

### Token contract

Every UI color comes from a theme token map (`src/theme/themes.ts`, re-exported by
`src/theme/theme.ts`); components never
hardcode colors. Tokens carry one of three intents:

- **`null` bg-ish tokens** (`bg`, `barBg`, `cardBg`, `selectionBg`, `scrollbar`): "omit
  the style" — the terminal background shows through.
- **`null` fg-ish tokens** (`fg`, `muted`, `barFg`): "adaptive" — resolved from the
  detected terminal light/dark mode (and, when available, the OSC palette).
- **`RGBA.fromIndex(n)` indexed tokens**: the host terminal resolves the palette index
  against its **active scheme at paint time** (SGR `38;5;N` / `48;5;N`). This is what
  makes neutral chrome match the shell with zero configuration.

Built-in themes: the adaptive `terminal` (default), the plain `dark`/`light` pair, and a
curated registry of popular schemes — solarized (dark/light), gruvbox, nord, dracula,
catppuccin (mocha/macchiato/frappe/latte), tokyo-night, one (dark/light), monokai, rose-pine
(main/moon/dawn), everforest (dark/light), kanagawa, ayu (dark/mirage/light), night-owl,
palenight, material, github (dark/light), cobalt2, horizon, zenburn, iceberg, synthwave-84,
spacegray, oceanic-next and papercolor. `THEME_NAMES` in `src/theme/themes.ts` is the single
source of truth for the list and its display order; each definition fills the token contract
(`ThemeTokens`) and the compiler enforces one definition per name. The theme name is
persisted in config; switching is live. `/theme` (no argument) and the settings Appearance
row open the searchable `ThemePicker`, which previews live and persists on Enter.

**Secondary text is readable by construction.** Reasoning blocks, tool-card output, labels
and hints all paint `muted`, so the resolver raises every non-adaptive theme's shipped
`muted` toward the readable end of its own hue until it clears a WCAG 4.5:1 floor against
the theme's `bg` (`readableMuted` in `src/theme/themePalette.ts`; hue preserved, saturation
capped). Published "comment greys" are often only ~2-3:1, which made those blocks disappear
on their own background. The semantic `dim` style maps to this `muted` color and does NOT
also emit the SGR faint attribute — a second faint pass halved the color again. The
adaptive `terminal` theme keeps its host-resolved indexed neutral instead.

### Neutral structure, accent in the title

The unfocused border is the quiet grey and the focused one a slightly stronger grey
(`deriveIndexedAccents` picks palette 7/8 by contrast) — a focused pane never floods a
whole rounded box in the accent. The accent carries focus through the border **title**
(`titleColor`): focused titles are accent, unfocused are muted. Selection is
**arrow-marker-only** — the `❯` marker + accent foreground, never a full-width bar.
Mouse **hover** paints the `selectionBg` fill so pointer users can see the target row; it
is cleared with an explicit `bg: "transparent"` when the pointer leaves, because opentui
styles are additive (omitted keys never reset a previously painted fill).

### Adaptive `terminal` theme

- Neutral tokens (`muted`, `barFg`, `border`, `borderFocused`) are palette indices so the
  host resolves them.
- Chromatic accents (`accent`, `danger`, `success`, `warning`, `toast`) keep the
  terminal's hue family but are **softened** (saturation-capped, lightness-normalized via
  `softenAccent`) when OSC 10/11 answered, so chrome is not full-saturation bright ANSI.
  A terminal that never answers keeps the raw palette indices.
- `fg` and the overlay blends (`cardBg`/`selectionBg`) are RGB-derived from OSC 10/11,
  which every terminal answers truthfully; fixed constants are the fallback.
- OSC probing is retried with backoff when the first answer is empty (a common race over
  SSH); the result is visible in `/status` as `palette: N/16 entries · fg · bg`.
- `themePalette` (config) is **optional tuning**, never required for correct colors.

### Pane color fidelity (embedded VT)

The pane is rendered by OpenTUI's `EmbeddedTerminalRenderable` (Ghostty VT), not by sensus.
The VT composes a **fixed built-in palette** (libghostty "Tomorrow Night": index 1
`#CC6666`, 2 `#B5BD68`, 4 `#81A2BE`, 9 `#D54E53`, …), exposes **no palette hook**
(`rendererSetPaletteState` does not affect it — verified), and defaults to an **opaque black
background** that ignores the host. Sensus therefore rewrites the shell's **output** SGR
color parameters to **truecolor** from the terminal's detected palette
(`src/terminal/sgr.ts`) before the bytes reach the VT; truecolor passes through the VT
untouched, so the pane's indexed colors **and** its background follow the user's terminal
theme again.

- **Source:** OSC 4 detection merged with the config `themePalette.palette` override (the
  override wins per entry). `themePalette.foreground`/`background` also set the pane's
  **default fg** (re-applied on resets) and its painted default **bg** (below), not just the
  chrome. Unanswered entries stay indices, so the VT
  palette shows for exactly those.
- **Untrustworthy source (Konsole/Yakuake):** KDE's OSC 4 reporter answers with its
  compiled-in `ColorScheme::defaultTable`, never the active scheme (a saturated primary
  table — verified against Konsole source), so using it would repaint the pane in vivid ANSI
  that matches neither the terminal nor the theme. `isKonsoleDefaultPalette` fingerprints
  that exact 0-15 row. On a match, `konsoleScheme.ts` resolves the real scheme and merges it
  **over** the detection (0-15 + fg/bg; the standard 16-255 cube is kept), so the pane and
  adaptive chrome match the terminal; `/status` shows `source: KDE scheme "<name>"`. The
  profile is resolved three ways, in order: the legacy `KONSOLE_PROFILE_NAME` →
  `~/.local/share/konsole/<profile>.profile` → `<ColorScheme>.colorscheme` (`Color0`-`Color7`
  normal + `ColorNIntense` bright + fg/bg); **modern Konsole dropped that variable**, so the
  session's own profile is asked over D-Bus — `KONSOLE_DBUS_SERVICE` +
  `KONSOLE_DBUS_SESSION` → `org.kde.konsole.Session.profile()` via any session-bus CLI that
  is installed (`busctl`, `dbus-send`, `gdbus`, `qdbus6`/`qdbus`; the tab's profile, not
  merely the default); then `konsolerc` `[Desktop Entry] DefaultProfile`. If the profile
  chain fails, the active scheme is **fingerprinted** from the truthful OSC 10/11
  defaults: the first installed `*.colorscheme` whose `[Foreground]`/`[Background]` match the
  terminal's reported defaults. Scheme dirs follow Qt's XDG rules (an empty/relative
  `XDG_DATA_HOME`/`XDG_DATA_DIRS` falls back to `~/.local/share` / `/usr/local/share:/usr/share`,
  so a distro `Nord.colorscheme` is not lost). If all of that fails, the lying 0-15 row is
  treated as **unanswered** (the VT palette shows, matching the no-detection/SSH path) and
  `/status`/a one-time boot toast point at the `themePalette.palette` pin (`/status` also names
  the failing step and how many schemes the fingerprint saw, e.g.
  `KDE scheme lookup: Nord.colorscheme not found`). A config pin always wins the merge.
- **Defaults & repaint:** the VT's own default background is opaque black and ignores the
  host. The rewriter re-applies the theme default **fg** as truecolor on every reset
  (`\e[0m`/`\e[m`) and on `39`. The default **bg** (`49`, reset) is deliberately left to the
  VT: painting an explicit bg truecolor on every cell makes the embedded VT's width-reflow
  emit a blank row after every content row, and a first-chunk background-color-erase
  (`\e[2J\e[H`) makes the next width resize wipe the screen. Both were removed; `PanePainter`
  covers the background. That alone is not enough: the VT composes
  cells to plain RGB (dropping the SGR intent) and re-composes blank/redrawn cells from its
  own black default, so already-written text kept the old theme and blank cells went black
  on resize. `src/terminal/paneBg.ts` (`PanePainter`) therefore runs in the renderable's
  `renderAfter` hook and, every composed frame, remaps each cell's fg/bg through a
  **source → current color map** (the previous theme default fg/bg and palette entries mapped
  to the current ones, composed across changes) and repaints the plain opaque-black default
  cells with the theme background. Together these make the pane follow the theme across
  redraw, **resize**, and **theme switches** (`TerminalSession.setPalette`/`setDefaults`
  invalidate the renderable so a change repaints immediately). A theme/palette change
  re-asserts colors **without** clearing (a switch never wipes output).
  Priority: config `themePalette.foreground`/`background` → the active theme's `fg`/`bg` →
  the terminal's detected OSC 11 background (adaptive `terminal` theme, `bg = null`) → the
  built-in dark/light constant. A fixed VT black shows only when nothing is detected or
  overridden.
- **Fallback:** with no detected palette and no override the rewriter leaves indexed entries
  as indices (the fixed VT palette), but the default fg re-application plus the `PanePainter`
  default-bg repaint still make the pane follow the theme.
- **`themePalette.paneColors`** (`"exact"` default | `"index"`): `"exact"` rewrites via the
  palette; `"index"` disables the indexed rewrite and passes indices to the VT's built-in
  palette (the default fg re-application and the painted default bg still apply).
- **`themePalette.boldBright`** (boolean, default `true`): a bold basic fg 0-7 promotes to
  the bright entry (index + 8); suppressed by dim, foreground only.
- Rewritten: basic `30-37`/`40-47`, bright `90-97`/`100-107`, `38;5;n`/`48;5;n` (and colon
  forms), and the `0`/`39` default fg. Untouched: truecolor, attributes, non-`m` escapes,
  OSC, and the default bg. Because the pane default fg is now the theme fg, reverse video
  swaps the theme fg with the VT's default (black) bg instead of the fixed palette's
  white-on-black.

The fixed VT palette is the fallback for unanswered indexed entries, not the primary
contract, and the sidebar/theme tokens are unaffected — they still derive from OSC 4/10/11 as
described below.

### Renderer color space

The renderer's color space still matters for **chrome** (theme RGB): OpenTUI's native
renderer decides ONCE around library load whether the terminal is truecolor (from
`COLORTERM`/`TERM`), with **two distinct failure modes**. When it thinks **256-color** it
**quantizes every RGB color** — chrome and any truecolor content — to a lossy `38;5;N`
(`#bf616a` → `38;5;131`). When it thinks **low-color** it has no legacy-SGR path at all:
`RGBA.fromIndex(N)` is emitted as a **fixed VGA-snapshot RGB** (`index 1` → `38;2;128;0;0`,
`7` → `38;2;192;192;192`), never `30–37`, so every indexed shell color becomes a hardcoded
RGB that is wrong in every terminal. SSH strips `COLORTERM`, so a 24-bit terminal silently
degrades to 256 and the whole TUI shifts; `TERM=xterm`/`xterm-color`/`screen`/`tmux`/empty
with no `COLORTERM` instead triggered the low-color snapshot. SSH is a second trap: OpenTUI
classifies an SSH session (`SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`) as a **remote renderer
with forwarded env** and early-returns before applying `COLORTERM`/`TERM` at all
(`packages/native/src/terminal.zig` `checkEnvironmentOverrides`), so the forced mode never
reaches the native renderer and caps stay `none`. The renderer is therefore created with
`remote: false` (`src/index.tsx`), which is correct for a UI that paints into the real
terminal. Sensus therefore bootstraps the mode before `@opentui/core` evaluates
(`core/colorModeBoot.ts`, imported first in `src/index.tsx`): `themePalette.colorMode`
(config) > `SENSUS_COLORTERM` (env) > (`NO_COLOR`, or a `COLORTERM` OpenTUI actually
understands — `truecolor`/`24bit` — → leave OpenTUI alone) > auto (force truecolor for
**any** `TERM` not in the low-color deny-list). That list is `LOW_COLOR_TERMS` in
`core/colorMode.ts`: `dumb`, `unknown`, `linux`, `cons25`/`cons50`/`cons60`,
`vt100`/`vt101`/`vt102`/`vt220`/`vt320`/`vt52`, `ansi`, `sun`, `hpterm`, `pcansi`, `ibm`,
`mach`, `nsterm-16color`, `eterm-color` (an empty `TERM` is **not** low-color). It sets
`COLORTERM` in `process.env`, so the PTY child inherits it and inner apps emit truecolor
too. The effective mode is surfaced in `/status` (`color: truecolor (auto)`); an `ansi256`
that overrides a forced truecolor (e.g. an outer multiplexer) shows as
`color: 256 (truecolor)` — that is when theme RGB is being quantized. When OpenTUI confirms
neither RGB nor 256-color, `/status` shows `color: none` and the App raises a one-time
warning toast pointing back at `themePalette.colorMode`.

### The zero-background invariant

With the overlays closed and the `terminal` theme active, the TUI's chrome must emit
**zero** background SGRs (`48;2;`, `48;5;`, `40`–`47`) apart from the one deliberate
exception below. This holds under the default `chat.cardStyle: "border"`; the smoke suite
verifies it black-box with `capture-pane -e` (border pinned), where the count must be
exactly zero. Three consequences:

- Style props that disappear between renders do **not** reset. A live theme switch must
  explicitly SET `backgroundColor`/`bg` to `"transparent"` — the `bgProps` /
  `borderProps` / `textBgProps` helpers enforce this.
- Pane **content** backgrounds are exempt: `48;5;N` / `48;2;r;g;b` from the inner app, and
  the default bg painted by `PanePainter`, are legitimate and expected.
- **Chat message panels** in `chat.cardStyle: "fill"` (opt-in; not the default) paint the
  theme `cardBg` panel. This is the one chrome exception; the default `"border"` keeps
  the chrome background-free everywhere. A fill panel keeps its box
  background transparent and paints the surface on an inner body, because a box
  background would also cover the border cells and square off the notched block corners.
- **Transient pointer hover** fills (`selectionBg` on the row under the cursor) are exempt
  while the pointer is over a target; nothing is painted without a mouse event.

Overlays intentionally paint an opaque **modal card** — a transparent dialog with text
underneath is unreadable. The backdrop AROUND the card paints nothing, so the pane/chat
stays visible behind it; only the bounded card is opaque. That is why the invariant is
scoped to "overlays closed".

## Components

### Tab bar

One text element (per-segment `<text>` elements clip on narrow terminals). Title = the
chat session's title (`ui/lib/tabs.tabTitle`), truncated at 24 cells; the shell basename
is the fallback. The **active** tab carries an accent `●` marker and an accent bold label;
inactive tabs are a muted index next to a neutral title, with a muted `│` between tabs. Each
tab ends with a muted, symmetric ` × ` — its own click region, so clicking it closes that tab
instead of selecting it (a busy tab's stream guard applies). A ` + new tab ` affordance opens
a tab. A **busy** tab appends one glyph — `!` (warning) while an approval is pending, else the
shared streaming spinner in the accent — so a background tab visibly asks for attention while
you are working elsewhere. The same marker vocabulary is reused by the `/sessions` overlay
(`ui/components/SessionsSearch.tsx`): a row whose transcript is open in a tab shows the
active `●` / open `·` / activity glyph, so live sessions are recognisable in search too
([`sessions.md`](sessions.md) "Search").
The right-aligned `? commands` button opens the command menu — a named button with a `?`
affordance for "what commands are there?" (the Ctrl+P shortcut and the ctrl+t/ctrl+w hints
live in the palette and `/help`, not on the bar). Clicks map
`e.x - currentTarget.screenX` back onto the recomputed rendered string (`ui/lib/bar.ts`);
hovering a tab, its `×`, `+ new tab`, or button paints the selection fill and pressing flashes the
accent block. Every affordance is a symmetric, text-scale glyph: `✕` (U+2715) is NOT
monospace-covered, so terminals fall back to a symbol font that draws it large/double-width
and breaks the bar's cell math — use `×` (U+00D7, Latin-1) for close.

When the tabs outgrow the row, the overflow fitter (`bar.ts` `fitBarParts`) shrinks every
title with an ellipsis (balanced, floors at a few cells), then drops tabs from the right with
the **active tab last**, then the ` + new tab ` affordance — so the right-aligned `? commands`
button stays on screen and mouse-reachable at any width (keyboard `Ctrl+P` always works).

### Tab rail (`layout: "sidebar"`)

When the global `layout` setting is `"sidebar"` (the default) the horizontal `TabBar` is
replaced by a full-height vertical `TabRail` on the **far left** (a full rounded card titled
`tabs`); the terminal pane stays in the middle, the chat sidebar stays on the right, and the
status bar stays on the bottom row. It carries the same visual language as the bar, one row
per tab:

- the **active** tab has an accent `●` marker and an accent bold label (a fixed 2-cell
  marker slot keeps labels aligned); inactive rows are a muted marker with a neutral
  index + title;
- each row ends with a muted, symmetric ` × ` (U+00D7) — its own click region, so clicking
  it closes that tab instead of selecting it (a streaming tab's close arm applies);
- a **busy** tab appends one glyph — `!` while an approval is pending, else the shared
  streaming spinner in the accent;
- the list is **windowed** when it overflows the rail's content rows, sliding so the active
  tab stays visible; and
- two **pinned** rows sit at the bottom: ` + new tab` and ` ? commands` (the named palette
  button with its `?` affordance; same action/wording as the top bar's button).

Each row highlights with the theme selection fill on hover and flashes the accent block on
press, like every other clickable row. The rail width clamps to **`[16, 60]` columns and at
most a third of the terminal** (`clampTabRailWidth`); the settings Appearance row edits it
(labelled "tab rail width"). Because the rail costs columns the top bar did not, the chat
sidebar is clamped to its layout bounds while it is shown, and App **silently falls back to
the topbar layout** when the rail would leave the terminal pane fewer than
`canUseSidebarLayout`'s 10 usable columns — the configured `layout: "sidebar"` is kept, so
growing the terminal restores the rail.

### Status bar

One text row of two groups separated by an elastic gap: **context** on the left (tab · cwd
· terminal health) and **agent** on the right (`endpoint@model · used/limit` · `think:<mode>`
· `✱ agent:<name>` · approval · `jobs:N` · `trust:<pattern>` · `no-tools` · a conditional
`mcp:` chip). Each chip is a
muted **label** next to a readable **value** (`barFg`), so the row scans as structure rather
than one grey line. Eight chips are clickable — the `tab` chip, model, context, think, agent,
approval, `trust`, `mcp` — and light up on hover / flash the accent block on press (clicking the left
`tab N/M: title` chip cycles to the next tab, wrapping; the model name opens the model
picker, the context figure opens the context inspector, the `trust` chip revokes all
session trust, the `mcp:` chip opens the MCP manager). Tones carry meaning only: streaming
and the active marker accent, `full-auto` and `terminal: starting`/`prefix…` warning, a dead
shell and the size warning danger, the `jobs:N` count warning, trusted patterns success.
Conditionals render only when they mean something (`terminal:`, `shell exited (N)`,
`chat:streaming`/`chat:compacting`/`chat:no-key`, `no-tools`, the size warning, the `prefix…` hint, the
`jobs:N` chip while a background job is live, the `trust:` chip while a pattern is trusted,
and the
`mcp:` chip — shown whenever MCP is on and servers are configured, counting enabled servers
before the first message (`mcp:3`), naming one connected server, and warning
`connected/total` on a failure). Runtime facts that left the bar (focus, pane size,
theme, tokens) print via `/status`.

On a narrow terminal the row overflows, so the fitter (`bar.ts` `fitBarParts`) sacrifices in
priority order: the unbounded `cwd` shrinks with an ellipsis first, the conditional
`mcp`/`no-tools` chips and the informational `trust` chip drop, then the tab title and the
`model`/`context` values shrink,
then the transient `chat` state and the left context group (`terminal:`, tab, cwd) yield,
then the `jobs:N` count drops.
The `think`/`context`/`model` affordances and the `agent` chip are sacrificed last (and
only when the row physically cannot hold them); the approval indicator is never dropped by
policy.

### Pane divider

The terminal pane and the chat sidebar are two separate full rounded cards with a single
one-column gap between them (`ui/components/PaneDivider.tsx`). The gap paints nothing until
the pointer is over it — then a single accent `│` appears, so the splitter is discoverable
without stacking a third permanent line next to the cards' own edges. A left mousedown
captures the pointer for the gesture; the line follows the mouse and reports a sidebar
width (moving right narrows the sidebar and widens the terminal). The width is clamped like
the keyboard resize (min 30 / 50%); the pure math lives in `ui/lib/layout.ts`
(`sidebarWidthForDrag`, `clampSidebarWidth`).

### Chat sidebar

- **Messages:** one card per message under a reference-keyed `<For>`, inside a
  native `<scrollbox>` (sticky to the bottom while streaming, free wheel scroll
  otherwise; `Alt+End`/`End` return to the newest message after a manual
  scroll-up). `chat.cardStyle` (default `"border"`) renders rounded bordered
  cards with no fill and keeps the adaptive theme background-free; `"fill"`
  renders solid `cardBg` panels with notched block corners — full-block `█`
  edges and quarter-cell `▟▙▜▛` corners, because a fill-colored rounded corner
  glyph on a filled box background would read as a square
  (`/cards`, `Alt+C`, the settings Chat row). Both styles carry no inner
  horizontal padding, so their text sits flush against the panel edge, and the
  message body floats one column inside the chat card's border (the panels never
  glue to it). Assistant cards span the content width; user cards are
  **right-aligned**, shrink-wrapped and capped at 80%.
- **Interaction:** clickable rows (code, tool-card header/hint, thinking header,
  approval/option rows) and the `⧉ copy` / `agent:<name> ⇄` affordances highlight on
  hover (theme selection fill) and flash the accent block on press. The assistant
  label names the active agent.
- **Scrollbar:** a visible, draggable vertical scrollbar (width 1, no arrows)
  whose thumb is the theme `scrollbar` token (falling back to muted) over a
  transparent track; wheel input is macOS-accelerated. `PgUp`/`PgDn` page and
  `Ctrl+Home`/`Ctrl+End` jump to the ends while the chat is focused.
- **Assistant prose** renders through the native `<markdown>` renderable; fenced code stays on
  the custom row model so per-line click-to-paste survives.
- **Labels:** user/assistant/error label rows carry a `⧉ copy` affordance (hidden when too
  narrow) that copies the raw text via OSC52; user labels additionally carry `↺ revert`
  (rewind to that message — docs/ui.md "Rewind"). Use TEXT-presentation glyphs that a
  monospace font actually covers (`⧉ ↺ × ❯ ✱`): an Emoji-property glyph such as `↩` (U+21A9)
  renders as a COLOR emoji, and an uncovered symbol such as `✕` (U+2715) makes terminals fall
  back to a large/double-width symbol font — both break the monochrome chrome.
- **Waiting label:** before the assistant bubble exists (created on its first delta) a
  standalone animated `⠋ Thinking` row stands in for its header, so the wait never shows
  only the streaming caret; it hides while a tool card is pending/running.
- **Thinking blocks:** an animated header while reasoning — click it to open the live
  reasoning body — then a collapsed `+ Thought for 2.3s` (click or `Alt+T` to expand).
  Hidden blocks draw the header only; the reasoning body is not shown until expanded.
  While the active header is on screen it is the bubble's only live row: the streaming
  label is suppressed so two spinners never stack.
- **Tool cards:** name, params peek, status glyph, and output collapsed to a preview with
  click / `Alt+E` expansion; `edit_file`/`write_file` show a diff while pending.
- **Plan card:** a ≥2-gated-call turn renders as ONE ordered `▸ plan · N approvals` card
  (accent border while unresolved) instead of N separate approval cards; each line carries a
  status glyph (`○ ✓ ⊘`) and the full command/diff, with `approve all` / `deny all` /
  `confirm` controls and a `⚠ destructive` line that is never pre-approved
  (docs/agent.md "Approval-batch plan card").
- **Input:** hand-rolled multi-line editor that word-wraps at whitespace (words are never
  split mid-word; a word wider than the row hard-splits); click-to-caret; the slash menu
  floats absolutely above it.

### Overlays and pickers

Every overlay shares one chrome kit (`ui/components/overlayKit.tsx`): a centered modal card
that fills a fixed 90% width × 85% height bounded area (floored so it stays drawable on a
tiny terminal) over a transparent, input-capturing backdrop, plus a selectable-row style
helper (arrow-marker-only selection, a mouse-hover fill, and an explicit `bg` on every
branch). `overlayMetrics(dims)` is the single source of truth for the card size and the
`innerWidth`/`innerHeight` budgets: each overlay windows its list to `innerHeight` (minus its
own chrome rows) so it never spills past the frame. Overlays register a single key handler
through the UI store (never a second global key listener) and swallow all input while open.
The sudo prompt is the exception to the fixed height — its card is sized to its content
(the agent's command wraps onto as many rows as it needs — never truncated — bounded by the
terminal height, and the card widens toward the terminal width for a long command), keeping the
pane/chat visible around it.

**Interaction: the view tree.** Overlays are a stack (the "view tree"), not a single modal
slot: opening a view pushes it, and `Esc` or a click on the backdrop pops the top back to the
view that opened it — so Ctrl+P → Settings → `Esc` returns to Ctrl+P rather than clearing the
screen. The card is the only opaque chrome; the backdrop paints nothing and captures the
input (a click outside the card is a pop). Overlays that commit and leave the overlay context
dismiss the whole stack.

### Toasts

One slot, top-right: a solid padded card inset two rows below the tab bar and two
columns from the right edge. Four levels (`info` · `success` · `warn` · `error`) map to a
theme token and a glyph (`· ✓ ⚠ ✗`), with per-level TTLs (info 2.5s, success 2s, warn 4s,
error 5s). The newest toast wins, but a live `error` is not preempted within its TTL by a
lower-severity toast — that one is dropped (never queued and replayed later, which would
surface a stale message after the fact). Only `error` is protected; `warn`/`info`/`success`
stay newest-wins, so a routine confirmation is never swallowed by a lingering warning
(`shouldPreemptToast`). The card paints the opaque `cardBg` with 2 cols / 1 row
of internal padding, so it reads as a card rather than a bare line. Pure geometry/TTL logic
lives in `engine/toast.ts` (re-exported at `ui/lib/toast.ts`).

## Motion

Animation is throttled and optional (`chat.animations: false` disables it):

- A shared 80ms braille tick drives the streaming spinner, the animated `Thinking`
  header, the standalone waiting label, and running tool-card glyphs. Settled content never
  subscribes to the tick. A tick repaint never remounts a card's interactive rows: the
  freshly laid row list is reconciled against the previous one by object identity
  (`chatLayout.reuseRows`), so only the row carrying the animated glyph is rebuilt and every
  other row keeps its live hover/press state.
- New messages play a short (~220ms) ease-out entrance: a 1-cell slide (margin, so the
  wrapped text never reflows) plus a border highlight. The entrance is tracked **once per
  message id**, so the streaming block's per-delta remount never replays it, and
  historical/resumed messages (old timestamps) never animate. Toggling a
  thinking/tool-output block flashes the card border (visible in the default
  `cardStyle: "border"`; the opt-in `"fill"` panel has no visible border). The streaming
  caret `▌` pulses
  accent↔muted.
- Streamed text is revealed through a paced typewriter pour (ease-out catch-up) so burst
  deltas unfurl instead of popping; the "streaming" state is held until the pour lands.
- The chat input caret blinks on a ~530ms phase, solid for a window after a keystroke;
  `chat.animations: false` or `SENSUS_REDUCED_MOTION` holds it solid and takes the tick off
  the paint path entirely. The terminal cursor is native to the embedded VT (no Solid-side
  blink).

## Named rules

**The Zero-Background Rule.** In the default theme, chrome paints nothing; the terminal's
own background shows through. Only an overlay's modal card is allowed an opaque panel (the
backdrop around it paints nothing).

**The Neutral-Structure Rule.** Borders and bars are palette-index greys. The accent
signals focus/selection through titles and text, never by flooding a box.

**The Meaningful-Accent Rule.** Accent (and danger/success/warning) colors carry meaning —
focus, selection, status, severity. Never decoration.

**The Fidelity-Not-Emulation Rule.** Pane colors and background follow the terminal's own
palette: sensus rewrites the inner app's indexed SGR to truecolor from the OSC 4/override
palette, re-applies the theme default fg on resets, and paints the default bg in the composed
frame (`PanePainter`) — never via a screen-clearing erase — so the embedded VT's fixed palette
is only the fallback and sensus never writes its own emulator.

## Do's and don'ts

**Do:**

- Do drive every color through a theme token; no hardcoded colors in `src/ui/`.
- Do preserve the zero-background invariant when adding chrome (the opt-in chat `fill`
  panels are the deliberate exception); verify with `capture-pane -e` under the default
  `cardStyle: "border"`.
- Do keep the tab bar and status bar as single text rows with region-mapped clicks; build
  them through the shared `ui/lib/bar.ts` kit (muted label + value tones, selection fill on
  hover, accent flash on press) so the bars match every other clickable row.
- Do pad both bars to the full row width (the kit's elastic `barFlex` part) so a shrinking
  row repaints every cell — opentui keeps stale cells otherwise.
- Do clip an embedded/native renderable to its pane (`overflow: hidden`); opentui only
  scissors a child when the parent's `overflow` is not `"visible"`, and a `TerminalPane`
  whose origin is momentarily stale during a reflow can otherwise blit shell output across
  the tab rail, where transparent chrome never repaints it.
- Do paint the empty part of the tab rail with full-width blank rows (not a bare flex
  spacer) so stale cells can never persist there.
- Do render new chat rows with a fixed cell budget and explicit backgrounds (stale paint
  otherwise).
- Do honor `chat.animations: false` and keep settled content off the animation tick.

**Don't:**

- Don't paint opaque backgrounds for chrome to "fix" contrast — fix the token instead.
- Don't flood borders/boxes with the accent; use the title.
- Don't add a second global key listener or bypass the store's single overlay handler.
- Don't fold fenced code into `<markdown>` (per-line click-to-paste depends on the custom rows).
- Don't expect to re-palettize the embedded VT — it has no hook. The `themePalette`
  `paneColors`/`boldBright` output-SGR rewrite is the only pane knob, and 256/truecolor pass
  through.

## Related docs

- [`config.md`](config.md) — `theme`, `themePalette`, `chat`, `sidebar` keys
- [`terminal-layer.md`](terminal-layer.md) — the embedded terminal engine and the pane's adaptive palette rewrite
- [`ui.md`](ui.md) — components and stores that implement this system
- [`PRODUCT.md`](PRODUCT.md) — the principles behind "blend in, do not take over"
