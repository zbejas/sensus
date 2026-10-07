# Keybindings

User guide: https://sensus.sh/docs/keybindings/

## Overview

Global hotkeys are intercepted before pane/chat routing and are reserved — they are never
sent to the inner shell. The default table lives in `src/core/keymap.ts`; config overrides
are merged by `resolveKeymap()`. This doc covers the keymap, the Ctrl+A prefix, the slash
and command menus, click targets, and the opentui quirks behind them. The input encoding
that reaches the pane is in [`terminal-layer.md`](terminal-layer.md); the visual rules are
in [`DESIGN.md`](DESIGN.md).

## Key files

| File | Purpose |
|---|---|
| `src/core/keymap.ts` | `defaultKeymap`, `KeyActionId`, `parseKeySpec`/`specLabel`/`resolveKeymap`/`matchKey`/`findAction` |
| `src/core/keymapRuntime.ts` | Installs the table as a `@opentui/keymap` layer; the event-match resolver bridge |
| `src/core/commandCatalog.ts` | The command registry (label/description/category/slash) driving Ctrl+P and keymap metadata |
| `src/ui/chat/prefix.ts` | Pure Ctrl+A prefix state machine |
| `src/engine/chat/slashComplete.ts` | Slash autocomplete filter/window math (re-exported at `src/ui/chat/slashComplete.ts`) |
| `src/ui/chat/commandMenu.ts` | Command palette filter/window/hint math |
| `src/ui/lib/clickTarget.ts` | One-text-row click mapping |
| `src/ui/components/PaneDivider.tsx` | Draggable pane/sidebar separator (pointer-captured drag → clamped sidebar width) |
| `src/ui/chat/chatKeys.ts` | Chat-input key state machine |
| `src/engine/chat/inputEditor.ts` | Input editor state (cursor, visual↔logical mapping); re-exported at `src/ui/chat/inputEditor.ts` |

## Dispatch

Global hotkeys run through `@opentui/keymap`: `keymapRuntime` installs `defaultKeymap` as a
keymap layer over the renderer. The keymap's listener is PREPENDED on `renderer.keyInput`,
so a matched hotkey is consumed (`preventDefault`) before App's single `useKeyboard`
dispatch runs. The layer is gated off while an input-capturing surface is active — a modal
overlay OR the stacked sudo popup (which renders with no overlay) — or the prefix
window is armed, letting those keys reach the capture/prefix stages. Keys no binding claims
fall through to the focused region unchanged.

The Alt+punctuation quirk (ESC-prefixed punctuation arrives as an empty-name event) is
bridged by a custom event-match resolver; sensus replaces opentui's stock resolver, which
throws on empty names.

## Default keymap

Remappable via the `keymap` config key (`"keymap": { "focus-toggle": "shift+tab", ... }`);
malformed entries keep the default binding. The `/keys` overlay (Ctrl+P "Keybindings") edits
this live: Enter captures a new key (modifiers required for letters), `d`/Delete restores the
default, and the global hotkey layer is re-installed immediately. Actions: `focus-toggle`, `focus-sidebar`,
`new-tab`, `close-tab`, `tab-prev`, `tab-next`, `open-settings`, `open-menu`, `open-agents`,
`sidebar-shrink`, `sidebar-grow`, `prefix`, `toggle-approval`, `toggle-thinking`,
`toggle-details`, `chat-bottom`, `toggle-chat-only`, `copy-message`, `revert-message`,
`send-code-block`, `paste-image`, `tab-1`..`tab-9`.

| Key | Action | Notes |
|---|---|---|
| `Shift+Tab` | toggle focus terminal ⇄ chat | focus also gates the carets |
| `Alt+A` | focus the chat input from anywhere | |
| `Ctrl+T` | new tab | fresh PTY shell + fresh chat session |
| `Ctrl+W` | close current tab (detach) | the daemon keeps the shell + chat (and any running turn) alive; press again within 3s to confirm while the agent is generating. `exit` in the pane ends the shell |
| `Ctrl+O` | open/close the settings screen | works from any focus; an open overlay swallows all keys, `Esc`/backdrop pops one view (see "View tree") |
| `Ctrl+P` | open/close the command menu | filterable palette; works from any focus |
| `Alt+1..9` | jump to tab N | |
| `Alt+Left/Right` | cycle tabs | |
| `Esc` | cancel generation / dismiss overlay | terminal focus forwards Esc to the pane; also aborts hidden commands and resolves pending cards as aborted |
| `y` / `n` / `a` | accept / reject / trust this command class for the session | chat focus, only while a card is pending AND the input draft is empty; rows are clickable too. `a` appears only on a card with a trustable operation class (never destructive); the status-bar `trust:` chip revokes session trust |
| `↑`/`↓` (or `k`/`j`), `space`, `y`/`n`, `Shift+A`/`Shift+N`, `Enter` | approval-batch plan: move the highlight, toggle the highlighted line, set it approved/rejected and advance, approve all (marks every non-destructive line approved AND commits the plan), deny all, commit | chat focus, only while a ≥2-call plan card is pending AND the draft is empty (docs/agent.md "Approval-batch plan card"); every line row and control row is clickable; `Esc` aborts the plan + turn |
| `1..9` | pick one of the model's `ask_user` options | chat focus, only while the draft is empty; the appended custom-answer entry is typed rather than picked |
| `Alt+,` / `Alt+.` | shrink / grow the chat | min 30, max 50% width; resizes the PTY to the new pane width; the pane divider drags to the same bounds |
| `Alt+M` | open the agent picker | [`agents.md`](agents.md) |
| `Alt+Y` | toggle approval confirm ⇄ full-auto | same as clicking the approval indicator or `/yolo` |
| `Ctrl+C` / `Ctrl+Shift+C` | copy the current selection (chat or terminal) | selection-copy layer; without a selection it falls through (`^C` to the pane, or a draft clear in chat) |
| `Alt+T` | toggle the most recent thinking block | per-message override; `/thinking` changes the session default |
| `Alt+E` | toggle the most recent tool card's output expansion | per-card override; `/details` changes the session default |
| `Alt+C` | toggle the message card style | `border` (default; rounded outlined card) ⇄ `fill` (solid notched panel); `/cards` also works |
| `Alt+End` | jump the chat to the newest message | unpins/returns to the sticky bottom after a manual scroll-up; also the palette's "Jump to latest" |
| `Alt+Home` | toggle the chat-only view | hides the terminal pane + tab rail and gives the chat the full width, keeping the top tab bar and status bar — for narrow/mobile terminals. Ephemeral: the configured `layout` is untouched, focus is clamped to the chat, and the palette's "Chat-only view" row is the pointer equivalent. A narrow terminal (≤90 cols) starts here automatically (`autoChatOnly`, default on); the key overrides the auto-switch for the session |
| `Alt+B` | copy the newest message (or the live selection) | `copy-message`; keyboard parity for the `⧉ copy` label affordance — a selection wins when one exists |
| `Alt+R` | revert/rewind the newest user turn | `revert-message`; parity for the `↺ revert` label affordance (the mid-work double-confirm applies) |
| `Alt+S` | send the newest fenced code block to the visible pane | `send-code-block`; writes the WHOLE block verbatim, so a multi-line block executes line by line and the final line is left at the prompt — click a single command line for the per-command route |
| `End` | jump the chat to the newest message | chat focus + empty draft only; a non-empty draft keeps End = end-of-line (use `Alt+End` there) |
| `Ctrl+←` / `Ctrl+→` | move the chat input caret by word | readline `backward-word`/`forward-word` (whitespace-delimited, crosses draft lines); plain arrows move one character. In the pane the shell receives the terminal-native `ESC [ 1 ; 5 D/C` — zsh gets `backward-word`/`forward-word` for the unbound sequence via the shell integration, bash/fish bind it natively ([`terminal-layer.md`](terminal-layer.md)) |
| `PgUp` / `PgDn` | page the chat message list up / down | chat focus; ~0.9 viewport per press |
| `Ctrl+Home` / `Ctrl+End` | jump the chat message list to the top / bottom | chat focus |
| `Ctrl+Shift+V` / `Alt+V` | paste the system clipboard into the focused surface | `paste-image`; adapts to what the clipboard holds — image bytes attach to the chat draft, a copied file list attaches image files and pastes other paths as text, plain text goes to the chat draft (or the pane as a bracketed paste); requires a host clipboard tool; `/image <path>` is the file fallback ([`agent.md`](agent.md) "Images") |
| `Shift+Enter` / `Ctrl+Enter` / `Ctrl+J` | newline in the chat input | `Shift+Enter` is reported by the kitty protocol or by xterm `modifyOtherKeys` level 2 (both pushed/enabled at boot); `Ctrl+Enter` arrives as linefeed without them |
| `Alt+Enter` | newline (idle) / the other busy-send mode (streaming) | while a reply streams, Enter applies `chat.busySend` and Alt+Enter applies the other mode (docs/config.md "chat"); when idle it stays the newline fallback |
| wheel (terminal, app-mouse off) | native scrollback (macOS-accelerated; 3 rows/notch base) | wheel back to the bottom re-follows live; drag or click the pane's overlay scrollbar for fast traversal |
| wheel (chat message list) | scroll the transcript (macOS-accelerated) | drag the vertical scrollbar thumb for fast traversal |
| drag-select (terminal) | copy via OSC52 | app-mouse off |
| click (chat code line) | paste that command into the visible pane | single click pastes the clicked line without Enter; clicking the same line again within 400ms presses Enter to run it (no-tools copy-paste behavior). The language label and hint rows are inert |
| click (tool card header/hint) | toggle output expansion | `/details` for the session default |
| click (thinking header: `⠋ Thinking` or `+/− Thought`) | toggle the thinking block | `/thinking` for the session default |
| paste from the outer terminal | forwarded as text to the focused region | an open overlay's edit field / filter receives it; terminal bracketed paste goes to the pane |

## Ctrl+A prefix

The prefix key (action `prefix`, default `ctrl+a`) opens a ~1s window; the status bar shows
`prefix…` while open. Resolution happens BEFORE global hotkeys (prefix+k goes to the pane,
tmux-style, not the keymap). Pure state machine in `src/ui/chat/prefix.ts`.

| Second key (within ~1s) | Behavior |
|---|---|
| `d` (or `D`) | **detach** — the client closes its WebSocket and exits; the daemon keeps the shells and running turns alive (D4). `sensus daemon stop` is the full teardown, `sensus kill` the kill switch for every daemon/runtime dir |
| any other key, terminal focus | the pane receives `Ctrl+A` + that key (readline `C-a`, `C-a a`, `C-a C-a`, `C-a C-k` keep working) |
| any other key, chat focus | prefix canceled; the key behaves normally in chat |
| timeout, terminal focus | the pane receives plain `Ctrl+A` |
| timeout, chat focus | canceled (nothing sent) |

Notes: works from both focuses; the window is per-keypress (`Ctrl+A` `Ctrl+A` sends both to
the pane); paste cancels a pending prefix; overlays block the prefix; mouse handling is
unaffected.

## Slash autocomplete

Typing `/` as the first character of the chat input pops a menu directly above the input
listing commands from the `SLASH_COMMANDS` table in `src/agent/slash.ts` with a one-line
description. The menu is derived from the draft — it closes when the text no longer
qualifies and reopens after an Esc dismissal for a new query. `/help` renders from the same
table. Only prefix matches are offered (case-insensitive). The menu paints an opaque panel
(theme `cardBg`) because it floats over message rows; the selection highlight is fg-only.
Menu keys: [keybindings guide](https://sensus.sh/docs/keybindings/).

## Command menu (Ctrl+P)

`Ctrl+P` (action `open-menu`) opens a centered modal palette: a filterable list of actions
grouped under muted category headers (Settings · Chat · Help · Tabs · Layout) while
unfiltered, flattening to a ranked list while typing. The table is
`src/core/commandCatalog.ts`; hints render from the RESOLVED keymap, and chat-dependent rows
show live state (`Toggle approval · now: confirm`). Theme switching is deliberately not a
palette row: use the settings screen (`Ctrl+O`) or `/theme`. While open the menu swallows all
keys. Menu keys: [keybindings guide](https://sensus.sh/docs/keybindings/).

## View tree (overlay stack)

Open views form a stack; only the top renders. Opening a view pushes it. `Esc` — or a click
on the backdrop outside the card — POPS the top and reveals the view that opened it, so
`Ctrl+P` → Settings → `Esc` lands back on the palette, and a second `Esc` closes the palette.
Picking a value in a pushed picker (`/models` or `/theme` opened from Settings) pops back to
Settings. Commit actions that leave the overlay context (opening a past session from
`/sessions`) dismiss the whole stack (`store.clearOverlays()`). A palette pick that does not
navigate to another view closes the palette.

## Overlay keys

**Settings** (swallows all keys; `Esc` closes or cancels an in-progress edit first):

A left **rail** (Endpoints · Model · Agent · Appearance · Chat · Context · MCP servers ·
Memory) plus a right **detail** pane. `Tab`/`Shift+Tab` toggles panes; `↑/↓` (or `j/k`)
move within the focused pane; `←/→` cycle an enum or switch panes; `Enter` opens a section,
edits a field, runs a button, or cycles an enum. A section with advanced fields ends with an
`Advanced…` row that opens a nested submenu (`Esc` pops back to the section). Typing — or `/`
— starts a fuzzy search that flattens matching fields across every category; `Esc` clears it.

| Key | Action |
|---|---|
| `↑/↓` or `j/k` | move within the focused pane (rail or detail; no wrap) |
| `PgUp` / `PgDn` / `Home` / `End` | page / jump to the ends |
| `Tab` / `Shift+Tab` | switch rail ⇄ detail |
| `←` / `→` | cycle the current enum, else switch pane |
| `Enter` | open a section / edit / run / cycle |
| `/` or any printable / `Backspace` | start / edit the search (with `/`, `j/k/g` type instead of navigating) |
| `Ctrl+U` | clear the field draft while editing |
| `Left/Right`, `Home/End` | cursor movement while editing |
| `Esc` | cancel the edit → clear the search → pop an `Advanced…` submenu → close the screen |
| `y` / `n` | confirm / cancel a destructive prompt (delete endpoint, reset colors) |
| click | rail rows, fields, buttons (hover highlights); click outside the panel closes |

**Model picker:** `/` or printable fuzzy-filters (`endpoint@` scopes), `↑/↓`/`j/k` move,
`PgUp`/`PgDn`/`Home`/`End` jump, wheel scrolls, `Enter` selects (session + persist
default), `Esc` closes, click selects; the highlighted model's metadata shows in a detail
pane. **Agent picker:** `/` or printable filters (name + description), same navigation, a
bounded prompt preview follows the highlight. **Theme picker** (`/theme` or Appearance →
theme): `/` or printable fuzzy-filters (name + kind, so `dark`/`light` narrow the list),
`↑/↓`/`j/k` preview the highlighted theme LIVE, `PgUp`/`PgDn`/`Home`/`End` jump, wheel
scrolls, `Enter` applies + persists, `Esc` restores the theme you came in with; click
selects. **Session search** (`/sessions`): an empty
filter lists recent transcripts newest-first (a row open in a tab is marked like the tab bar
— `●` active / `·` open / the tab's activity glyph), and typing searches their titles/ids
(Backspace
edits, `/` focuses the filter so a query may begin with `j`/`k`/`g`), `↑/↓`/`j/k`/`PgUp`/`PgDn`/`Home`/`End`
move (paging loads more rows near the bottom — infinite scroll), wheel scrolls, `Enter` opens
the selected transcript in a NEW tab (resumed, like `--resume`), `Del`/`Ctrl+D` permanently
deletes the highlighted transcript from disk (`y` confirms, `n`/`Esc` cancels — a session
still open in a tab is refused), `Esc` closes, click selects;
a bounded detail pane previews the selected row's metadata / snippet. **Context
inspector** (`/ctx`): `↑/↓`/`j/k`, `PgUp`/`PgDn`/`Home`/`End` and the wheel scroll the
durable-history list, `Esc` closes; read-only. **MCP manager** (the status-bar `mcp:` chip
or Ctrl+P "MCP servers"): `↑/↓`/`j/k`/`PgUp`/`PgDn`/`Home`/`End` and the wheel move,
`Space`/`Enter` (or a click) toggles the highlighted server's config `enabled` flag —
persisted globally and applied live, so disabling drops its tools from later requests —
`Esc` closes. **Sudo prompt** (centered modal card):
printable/Backspace/`Ctrl+U` edit the masked password, `Tab` selects cache-for-session (off
by default), `Enter` submits, `Esc`/outside declines. When selected, the agent reuses the
cached password for later sudo commands — both hidden-shell (`shell_background`) and the
visible pane (`shell_session`, typed as `sudo -A`) — without a new popup; when not, each sudo
use re-prompts. A re-prompt after a refused password shows a warning-coloured hint line
(e.g. `wrong password — try again`) so the user knows why it is asking again. `/sudo forget`
clears it. **Welcome onboarding** (opened automatically after a setup save): a compact card
over the live UI, `←`/`→` (or `↑`/`↓`, `Tab`/`Shift+Tab`) page through layout · keys,
`Enter`/`Space` advances (and from the last page dismisses the overlay), `l` flips the REAL
layout (left rail vs top bar) live behind the card and saves it to config.json,
`Esc`/`q`/`s` skips, and the backdrop click closes —
dismissing simply leaves you in sensus.
**Setup wizard** (its own overlay): `←`/`→` step back/forward where a step offers it, `↑`/`↓`
and `Enter` as documented per step, and `Esc` (or a backdrop click / the footer `exit`) opens
an exit confirmation — `y` exits (nothing written), `Esc`/`Enter` stays
([`operations.md`](operations.md) "Setup wizard").

vim keys (`j`/`k`, `g`/`G`) navigate only while the search is empty; press `/` (or any
other printable) to type a query — including one that starts with `j`/`k`/`g`.

Paste is single-line everywhere in overlays: a paste into an in-progress text edit (settings,
memory entry editor, setup wizard field) inserts at the cursor, and a paste while filtering
(settings search, command menu / model / agent / theme pickers, session search, `--resume`)
types into the query. CR/LF are dropped so a terminal paste's trailing newline can never
submit or append to the value (API keys are the common case). The sudo prompt pastes into
its masked field. Read-only overlays (keybindings, context inspector, skills, usage) swallow
paste.

Rows across the settings screen and every picker mark the active row with a `❯` arrow +
accent fg (no full-width bar); moving the mouse over a row paints a hover fill that clears
when the pointer leaves (an explicit `bg` on every row keeps stale fills from sticking).

## Click targets

All click targets have keyboard equivalents — including the chat-row copy / revert
affordances (`Alt+B` / `Alt+R`) and the whole-block send (`Alt+S`; per-command pasting
from a code line is pointer-only). The tab bar and status bar are single
text rows whose clicked column maps back to a region, so truncated labels still select by
region; the
same region map drives hover (theme selection fill) and press (accent flash) feedback, so a
clickable tab or status chip lights up under the pointer. Any click in the chat sidebar focuses
it. Text selection: only selectable
surfaces — the terminal pane (app-mouse off) and every chat message row — start a drag
selection. All chrome, overlays, pickers, menus, the chat input and its slash menu set
`selectable={false}`, so a click can never start (and copy) a selection over them. Dragging
over a selectable surface copies the selection to the system clipboard (OSC52) on release
with a toast; right-click copies the current selection; `Ctrl+C`/`Ctrl+Shift+C` re-copy it.
The selection stays until the next click/drag replaces it. Right/middle clicks never
trigger chat row actions.

| Click | Action |
|---|---|
| tab bar: a tab | select that tab (title = the session title, truncated at 24 chars for render + region math); a busy tab's spinner / `!` glyph is part of the tab |
| tab bar: a tab's `×` | close that tab (a second confirmation is required while its agent is streaming) |
| tab bar: the ACTIVE tab | re-focus the terminal pane |
| tab bar: ` + new tab` | open a new tab |
| tab bar: ` ? commands ` | open the command menu (the named palette button; `?` is its affordance) |
| tab rail (`layout: "sidebar"`): a tab row | select that tab; the ACTIVE row re-focuses the terminal pane |
| tab rail (`layout: "sidebar"`): a row's ` × ` | close that tab (a second confirmation is required while its agent is streaming) |
| tab rail (`layout: "sidebar"`): ` + new tab` | open a new tab |
| tab rail (`layout: "sidebar"`): ` ? commands` | open the command menu |
| status bar: `tab N/M: title` | cycle to the next tab (wraps from the last back to the first; keyboard `Alt+→`) |
| status bar: `✱ agent:<name>` | open the agent picker |
| status bar: `confirm` / `full-auto` | cycle approval mode |
| status bar: `<endpoint>@<model>` | open the model picker |
| status bar: `used/limit` (context figure) | open the context inspector (`/ctx`) |
| status bar: `think:<mode>` | cycle the thinking mode |
| status bar: `mcp:` chip | open the MCP manager (enable/disable servers; toggles persist to config) |
| status bar: `jobs:N` | nothing (inert; shows live background jobs for the active tab) |
| status bar: `trust:<pattern>` | revoke all session-scoped approval trust |
| status bar: `prefix…` hint / size warning | nothing (inert) |
| pane divider (the invisible gap between the pane card and the chat card) | drag to resize the chat (min 30 / 50%), like `Alt+,`/`Alt+.`; shows an accent `│` only on hover |
| pane: the overlay scrollbar thumb/track (right edge, when history exists) | drag (or click) to scroll the shell's scrollback; hidden without history and while a full-screen app owns the pane |
| sidebar: anywhere in the chat | focus the sidebar |
| sidebar: the vertical scrollbar thumb/track | drag (or click) to scroll the message list |
| sidebar: a message label's `⧉ copy` | copy the message's raw text (OSC52) |
| sidebar: a user message label's `↺ revert` | rewind the chat to just before that message (confirm when the agent is working) |
| sidebar: the `agent:<name> ⇄` chip | cycle to the next loaded agent (apply-current + persist-default) |
| sidebar: a code-block command line | single click pastes that line into the visible pane (no Enter); a second click within 400ms presses Enter to run it |
| sidebar: inside the input box | focus + place the caret at the clicked character |
| model / agent / settings rows | select/edit |
| command menu: a row / the backdrop outside the card | run that command / close |

## Gotchas & invariants

- **Two key systems, one consumer order.** `@opentui/keymap` and `useKeyboard` both hook
  `renderer.keyInput`; the keymap's listener is prepended and consumed keys never reach
  `useKeyboard`. Never add a second global key listener (overlays have the same
  double-handling hazard — they register through the store's single dispatch).
- **Do not re-add `registerDefaultKeys`.** opentui's stock event-match resolver throws on
  empty-name events; sensus replaces it.
- **ESC-prefixed punctuation** (`Alt+,` → `ESC ,`) parses to an EMPTY name without the meta
  flag; only the raw `sequence` identifies it, so such specs carry a sequence fallback. When
  the terminal negotiates an extended keyboard protocol (Kitty, xterm modifyOtherKeys) the
  same key arrives by its LITERAL character (`.` + alt) instead — the event-match resolver
  aliases punctuation names to their stroke (`"."` → `period`) so both encodings hit the
  same binding.
- **Shift+Tab** arrives as `BTab` or `{name:"tab", shift:true}` depending on protocol; the
  spec matches both.
- **`bold` is a `<span>`-only style prop.**
- **Stale-paint rules**: Solid components run once (recompute view state in
  `createMemo`); a removed span keeps its painted cells, so rows that can shrink need a
  fixed cell budget with explicit `bg` per span.
- **Overlays swallow all keys** while open, including global hotkeys and the prefix. The
  sudo popup does the same even though it renders WITHOUT an overlay; App gates on the
  derived `store.inputCaptured()` (overlay OR sudo popup), not `overlay() !== null`.
- **Mouse coordinates** from opentui are 0-based screen cells; the embedded VT forwards
  them to the PTY natively (no manual encoding).
- **Extended keyboard protocols** are enabled at boot (src/index.tsx): the kitty
  keyboard protocol is pushed (`renderer.enableKittyKeyboard()`), and the xterm
  `modifyOtherKeys` fallback — which OpenTUI enables at LEVEL 1, insufficient to
  report the Shift modifier on Enter — is upgraded to LEVEL 2
  (`enableModifyOtherKeysLevel2`, the `>4;2m` sequence). `Shift+Enter`/`Ctrl+Enter`
  and distinct `Ctrl+char` reporting therefore work on terminals supporting either
  protocol; kitty wins when both do, and OpenTUI resets to `>4;0m` on exit. A
  terminal supporting NEITHER cannot distinguish `Shift+Enter` from `Enter`, so
  `Alt+Enter` remains the newline fallback. Never require a protocol for core UX.
- **Level 2 changes the encoding of every modified key**, so the whole
  `CSI 27 ; <mod> ; <code> ~` family flows through OpenTUI's parser
  (`parseKeypress` → `{name, ctrl, shift}`) and is re-encoded by the focused
  embedded renderable for the PTY — never forwarded as literal text. This is
  verified end-to-end in `tests/smoke/chat.test.ts`: injecting the raw
  `ESC [ 27 ; 2 ; 13 ~` inserts a chat newline instead of sending (the draft
  lands as one `user_message`), and a `Ctrl+E` / `Tab` / `Enter` regression
  pass confirms `Ctrl+letter` still reaches the shell as its control byte
  (readline end-of-line), `Tab` as `0x09` (`cat -A` shows `^I`), and `Enter`
  still submits. No double-encoding or dropped keys.

## Known conflicts (documented to users)

- `Ctrl+A` is intercepted globally: inner apps get `prefix + key` (readline-compatible)
  rather than a bare `Ctrl+A` immediately; a bare `Ctrl+A` arrives after the ~1s window, or
  via `prefix + Ctrl+A`.
- `Alt+A`, `Alt+1..9`, `Alt+,`, `Alt+.`, `Alt+M`, `Alt+Y`, `Alt+T`, `Alt+E`, `Alt+C`,
  `Alt+B`, `Alt+R`, `Alt+S`, `Alt+End`, `Alt+Home`, `Alt+V`, `Ctrl+T`, `Ctrl+W`, and `Ctrl+P` are
  stolen from inner apps. Apps that need them
  (rare) can be used in a plain shell outside sensus. Paste is `Ctrl+Shift+V` (or `Alt+V`);
  `Ctrl+V` is deliberately left alone so inner apps keep visual-block / quoted-insert.
- The command menu swallows all keys while open (`Ctrl+T`, `Ctrl+W`, `Ctrl+O` do not fire).
- The chat input sends on `Enter` — intentional (terminal-native feel); `Shift+Enter` /
  `Ctrl+Enter` add a newline. While a reply streams, Enter does NOT block: it applies
  `chat.busySend` (`steer` = inject into the running turn, `queue` = send after it) and
  `Alt+Enter` applies the other mode (docs/config.md "chat", docs/agent.md "Busy sends").

## Related docs

- [`ui.md`](ui.md) — the components and overlays these keys drive
- [`terminal-layer.md`](terminal-layer.md) — how keys are encoded to raw PTY bytes
- [`config.md`](config.md) — the `keymap` config key
- [`DESIGN.md`](DESIGN.md) — status-bar segments and click-region rendering
