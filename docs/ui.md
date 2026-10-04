# UI Layer

## Overview

`src/ui/` is the Solid view layer over `@opentui/core`. It is deliberately thin: all
state lives in small stores (`ui/lib/store.ts`), components subscribe and wire events, and
non-render behavior lives in pure helpers that are unit-tested without a renderer. This
doc covers the components and rendering; the input map is in
[`keybindings.md`](keybindings.md), and the color/interaction rules are in
[`DESIGN.md`](DESIGN.md).

**The UI is a daemon client (P4c; D5).** `TabView.session` is a `RemoteTerminalSession`
(the client VT fed by `terminal.output`) and `TabView.chat` is a `RemoteChat` (mirrors
`chat.state`/`chat.meta` + events). The UI never constructs an in-process
`ChatHost`/`ChatSession`/`TerminalSession`; overlays read/write through `HostAdapter`
(a REST-backed facade) and `RestClient`. Purely-local state stays client-side (editor,
slash menu, drafts/images, reveal pacing, expand toggles, display prefs); UI-only slash
commands (`/memory`, `/sessions`, `/models`, `/theme <name>`, `/image`, `/cards`,
`/thinking`, `/details`) are handled locally. Exiting DETACHES (D4) — the daemon keeps the
shells/turns.

**Overlay data ports (P4e).** No overlay reads the local engine or sessions dir. Each
ports to a daemon route: the **UsageDashboard** uses `GET /v1/usage` (roll-ups incl.
`windowSessions`/`bySession`); the **Memory manager** and **Session search** use the REST
memory/sessions resources (open reconstructs via `GET /v1/sessions/:instance/:base`,
delete via `DELETE …`, the saved-session Context Inspector via `GET …/context`);
**SettingsScreen** and **SetupWizard** write `PUT /v1/config` (the editor reads
`GET /v1/config/raw`; secret values use the write-only `/v1/secrets`). `HostAdapter`
(plus `RestClient`) is the only seam, returning plain data — no `ChatHost`/`MemoryStore`/
`SessionIndex` exists client-side ([`architecture.md`](architecture.md) §client,
[`daemon-api.md`](daemon-api.md)).

## Key files

| File | Purpose |
|---|---|
| `components/App.tsx` | Root layout + the single key/mouse dispatch point; owns tab lifecycle wiring, the single config-change surface list, and the ephemeral chat-only view (Alt+Home: pane/rail hidden, chat full-width) |
| `components/TerminalPane.tsx` | Hosts the active tab's `EmbeddedTerminalRenderable` (native VT screen, cursor, scrollback) in an `overflow: hidden` box so the terminal is scissor-clipped to its card; mirrors focus |
| `components/PaneDivider.tsx` | The 1-column gap between the terminal card and the sidebar card; invisible until hovered/dragged (then an accent `│`), pointer-captured drag reports a clamped sidebar width |
| `components/ChatSidebar.tsx` | Chat orchestrator: scrollbox wiring, chat-derived memos, slash menu, input box, render tree (rows split out to `components/chat/*`) |
| `components/chat/MessageBlock.tsx` | One message card: label, image chips, body/markdown, fenced code, thinking block |
| `components/chat/Rows.tsx` | Shared message rows: label/copy/revert, card actions, copyable code, agent chip, segment spans |
| `components/chat/InputRows.tsx` | Draft-image row, editor input row, slash-autocomplete row |
| `components/TabBar.tsx` | One-text-row tab bar: active accent `●` marker, muted `│` separators, ` + new tab`, a busy-tab activity glyph (spinner / pending-approval `!`), and the right-aligned `? commands` palette button; hover/press + region-mapped clicks |
| `components/TabRail.tsx` | Vertical tab rail for `layout: "sidebar"`: a full-height rounded card on the far left, one row per tab (active accent `●` + bold label, ` × ` close region, a busy-tab activity glyph), windowed when the list overflows, plus pinned ` + new tab` / ` ? commands` rows; hover/press + region-mapped clicks |
| `components/StatusBar.tsx` | One-text-row status bar: a left context group + a right agent group (incl. a conditional `mcp:` chip) around an elastic gap; muted-label/readable-value tones, hover/press + region-mapped clicks |
| `components/SettingsScreen.tsx` | Settings modal (endpoints, models, globals) |
| `components/ModelPicker.tsx` | Model catalog overlay over `agent/provider/modelCatalog.ts` |
| `components/AgentPicker.tsx` | Agent picker overlay over `config/agents.ts` |
| `components/ThemePicker.tsx` | Theme picker overlay over `theme/themes.ts` (live preview, search) |
| `components/CommandMenu.tsx` | Ctrl+P palette over `core/commandCatalog.ts` |
| `components/MemoryManager.tsx` | Agent memory manager overlay (docs/memory.md) |
| `components/SessionsSearch.tsx` | Session search overlay (FTS5 index over past chats) |
| `components/McpManager.tsx` | MCP server manager overlay: per-server enable/disable toggles persisted to config, applied live (docs/mcp.md "UI") |
| `components/SudoPrompt.tsx` | Masked sudo-password popup (`sudoPrompt: popup`/`auto`; `shell_background` failures and `shell_session` sudo) |
| `components/WelcomeModal.tsx` | First-run onboarding overlay (opened by App right after a setup save): a compact card over the live UI — a live `l` rail-vs-topbar preview and the hotkey cheat sheet; dismissed to leave you in sensus |
| `components/SetupWizard.tsx` | Guided setup modal (first run, `sensus init`, boot config error, `/init-wizard`, or Ctrl+P → Setup wizard); confirm-gated exit; writes `config.json` |
| `components/ResumePicker.tsx` | `--resume` session picker, an in-app window over the live layout (like Settings) |
| `components/AttachPicker.tsx` | Boot re-attach picker (D4), an in-app window listing the daemon's live shells/chats |
| `components/ToastPanel.tsx` | Floating top-right toast card (solid, padded) |
| `components/overlayKit.tsx` | Shared overlay chrome: centered modal card + transparent backdrop, `overlayMetrics` budgets, selectable-row styles (arrow + hover, always-`bg`) |
| `chat/chatKeys.ts` | Chat-input key state machine (extracted from App) |
| `chat/chatLayout.ts` | Chat row segmentation/layout; card/bubble geometry; per-line paste + copy affordance geometry |
| `chat/inputEditor.ts` | Re-export barrel — the multi-line input editor state (cursor, word wrap, visual↔logical mapping) lives in the engine (`engine/chat/inputEditor.ts`); the UI path is kept for callers |
| `chat/entrance.ts` | Message/card entrance animation timing (once per message) |
| `chat/prefix.ts` | Ctrl+A prefix state machine (pure) |
| `chat/welcome.ts` | First-run onboarding page model + navigation clamp + compact card size + hotkey cheat sheet (pure) |
| `chat/slashComplete.ts` | Re-export barrel — slash autocomplete filter/window math (pure) lives in the engine (`engine/chat/slashComplete.ts`) |
| `chat/commandMenu.ts` | Command palette filter/window/hint math (pure) |
| `chat/streamReveal.ts` | Re-export barrel — streamed-text reveal pacing state lives in the engine (`engine/chat/streamReveal.ts`) |
| `chat/settingsFilter.ts` | Settings rail categories + type-to-filter ranking/window math (pure) |
| `chat/settingsDoc.ts` | Settings doc↔config derivation (`docFromConfig`, `readEndpoints`) + raw-doc coercion helpers (pure) |
| `chat/chatRowStyle.ts` | Pure row hover/press + segment color policy (`pickColor`, `spanAttrs`, `rowFx`) |
| `chat/messageText.ts` | Message content → display rows/text (`fenceRows`, `imageChipText`) |
| `chat/paste.ts` | Clipboard + bracketed-paste controller (`createPasteController`, `insertDraftText`) |
| `chat/tabEngine.ts` | Tab/session lifecycle factory (`createTabEngine`) |
| `chat/commands.ts` | Keymap/command dispatch factory (`createCommandDispatch`) |
| `chat/mcpManager.ts` | Pure MCP-manager overlay helpers (`mcpServerRow`, enabled state + toggle intent) |
| `chat/terminalDetection.ts` | OSC theme/palette detection bootstrap (`startTerminalDetection`) |
| `lib/store.ts` | The UI store (signals for focus, tabs, overlay, toast, sudo, …) |
| `lib/tabs.ts` | Pure tab lifecycle decisions (`nextActiveOnClose`, …) + `tabTitle` (the session-title tab label) |
| `lib/layout.ts` | Terminal-size guards (20×5 minimum) + the too-small message; pane/sidebar/rail geometry: `clampSidebarWidth`, the vertical-rail `clampTabRailWidth`, `canUseSidebarLayout`, and `computePaneCells` |
| `lib/toast.ts` | Re-export barrel — toast levels/TTLs/glyph/token + panel wrap math + the single-slot severity-preemption policy (pure) live in the engine (`engine/toast.ts`) |
| `lib/blink.ts` | Shared caret blink phase (chat input), gated solid by `chat.animations: false` / `SENSUS_REDUCED_MOTION` |
| `lib/spinner.ts` | Re-export barrel — the shared 80ms braille animation tick lives in the engine (`engine/spinner.ts`) |
| `lib/bar.ts` | Shared one-text-row bar kit: `BarPart`/`BarSpan` model, layout + regions, the elastic `barFlex` pad, the `fitBarParts` overflow policy (ellipsis-truncate / drop by priority), tone/state paint, and the `createBarRow` hover/press hook |
| `lib/mcpChip.ts` | Pure status-bar MCP chip (`mcpChipPart`): name/count/`connected/total` representation + hide/tone policy (docs/mcp.md "UI") |
| `lib/clickTarget.ts` | One-text-row click mapping (column → segment/region) |
| `lib/fuzzy.ts` | Re-export barrel — the fuzzy filter shared by the model picker and command menu lives in the engine (`engine/fuzzy.ts`) |
| `lib/armGuard.ts` | Double-confirm arm/timer guard (tab close, message revert) with a clock seam |
| `lib/paneTheme.ts` | Pane palette/defaults derivation + application (`paneColorConfig`, `paneDefaultColors`, `panePaletteFor`) |

## The store

`createUiStore()` owns every signal; components never hold business state. Highlights:

- `focus` (`"terminal" | "sidebar"`), `toggleFocus`, `setFocus`.
- `tabs` + `activeTab`: each `TabView` bundles the native `TerminalSession` (renderable +
  status) and its own `ChatSession`.
- `overlay` / `overlayStack` + `setOverlay` / `clearOverlays`: the overlay VIEW TREE — a
  stack whose last entry is visible (`overlay()` is the top, null when empty). Opening a
  view pushes; Esc/click-outside pops back to the view that opened it (Ctrl+P → Settings →
  Esc → Ctrl+P). `overlayKeyHandler` / `overlayPasteHandler` are how the visible overlay
  receives input through App's single dispatch point; handlers clear only when the stack
  empties.
- `sudoRequest` + `inputCaptured()`: the pending masked sudo popup and the derived "some
  surface owns the keyboard" flag — true for an overlay OR the sudo popup. App gates its
  key/paste dispatch and blurs the pane/chat on it (the popup renders ABOVE an overlay, or
  with none open at all, so `overlay() !== null` alone is not enough).
- `toast` + `showToast`: one slot, newest wins, per-level TTL — except a lower-severity
  toast cannot bury a live `error` still within its TTL; such a toast is dropped, not queued
  (a replayed stale toast would surface after the fact). Only `error` is protected:
  `warn`/`info`/`success` stay newest-wins, so a routine confirmation is never swallowed by
  a lingering warning (`lib/toast.ts` `shouldPreemptToast`).
- `prefixPending`, `terminalState`, `sizeWarning`, `paletteStatus`, `terminalInfo`,
  `configVersion`, `modelInfoVersion`. `configVersion` is bumped by App's config-change
  router after every successful reload (docs/config.md "Live config reload"), so
  config-derived effects (`autoChatOnly`, the resolved keymap) re-run even when the values
  they read are identity-stable.
- `chatBottomTick` + `requestChatBottom()` (jump to newest) and `chatScrollTick` +
  `chatScrollPages` + `requestChatScroll(pages)` (PgUp/PgDn, Ctrl+Home/End): App bumps a
  signal and `ChatSidebar`'s effect drives the native scrollbox.

`setTabStatus` replaces a tab's polled `TerminalStatus`; the renderable itself owns the
screen, so there is no frame diffing to do.

## Rendering pipeline

`App.tsx` composes the regions and owns the single `useKeyboard`/mouse dispatch. Input
order is input capture (overlay or sudo popup) → prefix → focused region; matched global
hotkeys are consumed upstream by the keymap layer ([`keybindings.md`](keybindings.md)). App
also:

- applies terminal detection (OSC 4/10/11) for the theme tokens,
- runs a lightweight status poll over the active `TerminalSession` (~1/s) for the status
  bar and chat context (and the tab-title shell fallback),
- keeps the shell-basename tab-title fallback (the visible tab title is the chat
  session's title via `lib/tabs.tabTitle`), detects pane death, and drives tab
  add/close/focus,
- mounts the toast panel **last** so toasts render above overlays.

`TerminalPane` mounts one `EmbeddedTerminalRenderable` at a time: a container box holds the
active session's renderable and `container.add` reparents it on tab switch, so each tab's
native VT state (screen, cursor, scrollback) is preserved. It mirrors the store's focus onto
the renderable (`focus()`/`blur()`); there is no frame composition, span color resolution,
or cursor overlay in the Solid layer.

## Chat rendering

`ChatSidebar` renders the active tab's `ChatSession`:

- **Cards.** Every message is one card (`MessageBlock` returns a single root
  box for all roles). `chat.cardStyle` selects the look: `"fill"` (default) is a
  **solid themed panel** filled with the theme `cardBg` token. The shell's box
  background stays transparent and an inner body paints the fill (a box
  background would cover the border cells too, squaring the corners), and the
  border uses full-block `█` edges with quarter-cell notched corners
  (`▟▙▜▛`) so the panel reads as rounded; `"border"` is
  a rounded bordered card with no fill (keeping the adaptive `terminal` theme
  background-free). Cards carry no extra inner
  horizontal padding — content sits flush against the panel edge, and the
  message body floats 1 column inside the chat card's border — and are exactly
  `textWidth + 2` columns
  (`chatLayout.CARD_CHROME`). The settings Chat row, `/cards`, `Alt+C`, or the
  Ctrl+P "Toggle card style" row flip it. `/cards`/`Alt+C` are session-scoped;
  a Settings save or `/reload` re-seeds `cardStyle` (and `thinking`, `toolOutput`,
  `animations`) on EVERY open tab through the single config-change mechanism
  (docs/config.md "Live config reload"), so already-rendered cards restyle live.
  Internal reloads (picker/MCP/setup) leave the session overrides alone. Row
  spans inside a card paint the same surface, never a mismatched background.
- **Alignment.** Assistant/tool/system/error cards span the content width,
  left-aligned; **user messages are right-aligned**, shrink-wrapped to their
  longest line and capped at 80% of the content width
  (`chatLayout.cardTextWidth`/`userBubbleTextWidth`). A card's height gap is
  its `marginBottom` (no in-body spacer row).
- **Scrollbox.** The message list is a native `<scrollbox>` (sticky to the
  bottom while pinned; free wheel scroll otherwise) with a **visible,
  draggable vertical scrollbar** (width 1, arrows off; thumb = the theme
  `scrollbar` token, track transparent) and **wheel acceleration**
  (`MacOSScrollAccel`). It is configured with
  `rootOptions`/`wrapperOptions`/`viewportOptions`/`contentOptions`
  backgrounds set to `"transparent"`, or the zero-background invariant fails.
  The root stays `flexDirection: "row"` so the scrollbar sits on the right.
- **One block per message** under a reference-keyed `<For>`; settled messages
  never re-render, only the streaming one does.
- **Prose vs. code.** `chat/chatLayout.segmentAssistant` splits assistant text into prose
  (rendered through the native `<markdown>` renderable with the theme-derived
  `SyntaxStyle`) and fenced code (kept on the custom row model so per-line pasting survives).
  Each code row carries its own source line (`MdLine.copyLine`): a **single click pastes**
  that command into the visible pane without pressing Enter, and a **double click**
  (second click on the same line within 400ms) presses Enter to run it. Wrapped rows share
  their source line, so clicking any visual row of a long command pastes the whole command.
  The language label and the ` ↳ click to paste · double-click to run` hint are inert; the
  whole-block send stays on `Alt+S` (`send-code-block`).
- **Labels.** Each message's label row has a `⧉ copy` affordance whose geometry is in
  `chatLayout.labelCopyAffordance`; it is hidden when the label would overflow, and the
  clicked column maps back onto the rendered spans. **User** labels additionally carry a
  `↺ revert` affordance after copy (`chatLayout.labelRevertAffordance`), hidden when the pair
  does not fit; clicking it rewinds the chat to just before that message and reloads it into
  the input (see "Rewind" below). The assistant label names the **active
  agent** (`✱ copilot · 1.2s`), falling back to the message's model when the session has no
  agent name.
- **Hover/press.** Every clickable row (code rows, tool-card header/hint, thinking header,
  approval/option rows) highlights under the pointer with the theme selection fill and
  flashes the accent block on press; the label's `⧉ copy` affordance and the `agent:<name> ⇄`
  chip do the same. Non-interactive body rows bind no handlers, so they never light up.
  Clickable rows are `selectable={false}` — opentui starts a text selection on a left
  mousedown over a selectable `<text>`, so without it a click on a button would also begin
  selecting its text. Reasoning/prose body rows stay selectable.
- **Thinking.** Reasoning renders as a collapsible block; `/thinking` sets the session
  default, `Alt+T` (or a header click — the live `⠋ Thinking` header or the settled
  `+/− Thought` header) toggles a block. When the block is hidden, only the one-line
  header is drawn — the reasoning body appears once expanded (a mid-stream expand shows
  the reasoning accumulated so far, then streams the rest).
- **Tool cards.** Name, params peek, status, and output collapsed to a preview; `/details`
  sets the session default, `Alt+E` (or a header click) overrides the most recent card.
  A PENDING card renders its full approval detail in the body — the entire shell command
  (or MCP args blob), wrapped and never truncated — and drops the clipped header peek, so
  a long or `&&`-continued command can never be approved unseen.
  When one assistant turn yields ≥2 gated calls they render as ONE **plan card**
  (docs/agent.md "Approval-batch plan card"): an ordered `▸ plan · N approvals` list, each
  line `cursor + status glyph + [i/N] tool + params` (plus the full detail and pending diff),
  with per-line toggle rows and `approve all` / `deny all` / `confirm` / `cancel` controls.
  Every line's status glyph (`○ pending` / `✓ approved` / `⊘ rejected`) updates live as the
  user decides; a `⚠ destructive` line is never pre-approved. The card freezes to
  `plan committed — k/N approved` (or `plan aborted`) once resolved.
  An `ask_user` card renders its question in full (wrapped, never truncated) with markdown
  and bare URLs as clickable OSC-8 links (`<a href>` over the `linkifyLines` segments in
  `agent/markdown.ts`), numbers each option as a clickable row — the option text wraps in
  full with a hanging indent, and every wrapped row carries the same click action, so a
  long candidate answer is never cut off or half-clickable — and always appends a dim
  "✎ type your custom answer in the chat" row (not a real option — picking it leaves the
  reply to the chat input).
- **Input.** `chat/inputEditor.ts` holds the editor state; `chat/chatKeys.ts` is the key
  state machine. Word wrapping is shared by the forward and inverse maps
  (`wrapEditorLine`): a line breaks at whitespace (the space stays at the row end so no
  character is dropped) and a word wider than the row is hard-split — words are never
  split mid-word. Clicks map a visual (row, col) back to the logical cursor. `Ctrl+←`/`→`
  jump by whitespace-delimited word (readline `backward-word`/`forward-word`, crossing
  logical lines); plain arrows move one character. The slash menu
  is `position: "absolute"` above the input.
- **Image chips.** A user message with attachments renders a `▣ name · size` row under its
  label; pending draft attachments render an interactive `attach ▣ name ×` row as the first
  inner row of the input box (`×` removes one). Chips only — no inline image rendering.
  See [`agent.md`](agent.md) "Images".
- **Busy-send indicator.** While messages are held from a busy send (`chat.busySend`), a
  `⇢ steering N · ⧗ queued N` row sits above the input (below the agent chip), so held
  input is never invisible. See [`agent.md`](agent.md) "Busy sends".
- **Compaction indicator.** While a compaction runs (manual `/compact` or the automatic
  preflight), a `⠹ compacting context…` row shows at the bottom of the message list and the
  status bar's `chat:` chip reads `chat:compacting ⠋` — otherwise a compaction looks idle
  until it finishes. The row is standalone (a compaction has no assistant bubble) and takes
  precedence over the waiting indicator. See [`agent.md`](agent.md) "Streaming display".

### Rewind

A user message's label row carries `↺ revert` after `⧉ copy`. Clicking it calls
`ChatSession.revertToUserMessage(id)`: the message and everything after it are dropped from
the display transcript, the durable provider history and (logically) the session file, and
the message's text + image attachments are reloaded into the input for editing and resend.
The click is wired in `App` (`onRevertMessage`). When the session is mid-work
(`ChatSession.isWorking()`: a reply streaming, a compaction, or a pending approval/ask), the
first click only arms the rewind with a warn toast (the Ctrl+W close pattern) and a second
click on the same message within the window confirms — the rewind aborts the work. The
session file stays append-only: a `revert` event records `keep` (surviving user+assistant
records) and `loadSessionFile` truncates the logical transcript as it reads, so `--resume`
never resurrects the discarded turns. Full semantics in [`agent.md`](agent.md) "Rewind".
User bubbles have a minimum text width (`chatLayout.USER_BUBBLE_MIN_TEXT`) sized to fit the
label plus both affordances, so `↺ revert` is not clipped on short messages.

Streaming display (spinner label, delta coalescing, typewriter reveal, thinking blocks) is
described in [`agent.md`](agent.md) "Streaming display". Motion is gated by `chat.animations`
(per session): `false` disables the spinner, streamed-text pacing and entrance effects and
holds the input caret solid; `SENSUS_REDUCED_MOTION` (env, truthy) additionally holds the
caret solid on its own. When the caret is gated, the shared blink tick is off the paint
path entirely. The terminal cursor is native to the embedded VT and unaffected.

## Overlays and pickers

Every overlay shares `components/overlayKit.tsx`: a centered **modal card** that fills a
fixed 90% × 85% bounded area, with `overlayMetrics(dims)` supplying the `innerWidth`/
`innerHeight` budgets each overlay windows its list to, floating over a transparent,
input-capturing backdrop — the pane/chat stays visible around it, like the sudo prompt. The
kit also supplies the selectable-row style helper (arrow-marker-only selection with an
explicit `bg` and a mouse-hover fill). Overlays register one handler through
`store.overlayKeyHandler`/`overlayPasteHandler` — never its own global listener, or keys
would double-handle. While open, an overlay swallows all input. Overlays with a text editor
or a type-to-filter query register `overlayPasteHandler` too (normalizing through
`core/util.singleLinePaste`); App routes every paste there while an overlay is open. The sudo
prompt uses the same modal shape but is narrower and sized to its content, stacked above an
overlay (or with no overlay at all) and takes over through `store.pushOverlayInput`, which
puts the displaced handlers back on close. App gates on the derived `store.inputCaptured()`
(overlay OR sudo popup) rather than `overlay() !== null`, and blurs the pane/chat while it is
true, so the popup owns the keyboard in both cases. Below the 20×5 minimum every overlay
(and the sudo popup, and toasts) is gated off and the size notice shows instead; the
overlay state is kept, so the view reappears when the terminal grows back, and App swallows
keys while too small so a hidden overlay handler is never dispatched.

**View tree.** Overlays form a stack (docs/keybindings.md): opening a view pushes it, and
`Esc` / a click on the backdrop pops the top back to the view that opened it — Ctrl+P →
Settings → Esc lands back on the Ctrl+P palette. App keeps the palette under a view it
opened (a palette pick that navigates leaves the palette on the stack; any other pick closes
it via the `runCommand` wrapper), the settings screen pushes `/theme` and `/models` on top,
and commit actions that leave the overlay context (opening a session) call `clearOverlays()`.
Only the top of the stack renders; a popped-to view remounts.

The three filterable pickers (command menu, model picker, agent picker) additionally share
three overlay primitives:

- `overlay/nav.ts` — the pure navigation resolver (`overlayNavStep`). `↑`/`↓` step ±1,
  `PgUp`/`PgDn` page by the visible row count, `Home`/`End` jump to the first/last row;
  while the filter is **empty** `j`/`k` step and `g`/`G` jump (vim). Pressing `/` (or any
  other printable) focuses the filter and makes those letters ordinary input, so a query can
  begin with `j`/`k`/`g` (e.g. "gpt"). With a non-empty filter, typing continues. Every step
  wraps; ctrl/meta are ignored.
- `overlay/MatchSpans.tsx` — splits the row's primary label with `matchSegments` and paints
  the matched runs in the accent fg, the rest in the caller's fg. Every run sets an explicit
  `bg` (opentui styles are additive), and the label is padded to a fixed cell budget.
- `overlay/PreviewPane.tsx` — a bounded, stale-paint-safe detail area: exactly N text rows,
  each truncated/padded to a fixed width, the first in `fg` and the rest in `muted`.

The mouse wheel over the list moves the selection one step; hover still paints the
`selectionBg` fill.

- **Setup wizard** (`/init-wizard`, Ctrl+P → Setup wizard; also auto-opens on a first run or a boot
  config error): a guided overlay over provider/endpoint / model / theme with a live theme
  preview and an optional read-only host scan; the endpoint step picks one of the four
  protocols (baseURL follows the protocol default; empty = the default) and the test step
  probes the DRAFT over its protocol (`POST /v1/models/probe`). Leaving is confirm-gated. It
  writes `config.json` through the same `config/configFile.ts` path as Settings. See
  [`operations.md`](operations.md) "Setup wizard".
- **Settings** (`/settings`, `Ctrl+O`): endpoint list + per-endpoint fields + global
  fields; the endpoint editor cycles the provider (`openai-compatible` /
  `openai-responses` / `anthropic` / `google`; the `mock` test seam stays config-only),
  an empty baseURL means the protocol default, and test connection probes the DRAFT
  through `POST /v1/models/probe`; commits persist immediately through
  `config/configFile.ts`. See [`config.md`](config.md).
- **Model picker** (`/models`, the status-bar model chip): all endpoints' models, grouped,
  fuzzy-filtered (`endpoint@` scopes), enriched. Matched characters in `endpoint · id`
  highlight; the detail pane shows endpoint, id, display name, context limit, tool-call and
  reasoning support, owner, endpoint types, and the `← active` tag. Enter applies to the
  session and persists the default.
- **Agent picker** (`Alt+M`, the status-bar agent chip): loaded agents, fuzzy-filtered over name +
  description with matched characters highlighted; the detail pane shows the agent's
  metadata and prompt body. Enter switches (session + persisted default); the sidebar
  `agent:<name> ⇄` chip cycles through the same list with those semantics.
- **Command menu** (`Ctrl+P`): the `commandCatalog` palette, grouped while unfiltered and
  flattened while filtering (theme switching lives in the settings screen / `/theme`, not
  the palette). A one-line detail footer previews the highlighted command's label,
  resolved binding, slash spelling, description, and live state suffix. The filter is a
  single-line edit draft (`ui/chat/memoryManager.ts` `editDraft`): once a query exists,
  Left/Right/Home/End move the caret and Delete removes forward; while the filter is empty
  those keys stay list navigation and Up/Down/PgUp/PgDn pick rows.
- **Memory manager** (`/memory`, Ctrl+P "Agent memory"): a rail (Memory · Host map · Journal)
  with usage bars, per-entry rows and a bounded preview; `a` add, `Enter` edit, `d`/Delete
  remove (`y/N`), `p` prune, `r` reload. Writes go through `MemoryStore` (docs/memory.md).
- **Skills manager** (`/skills`, Ctrl+P "Skills"): a read-only list of loaded skills with a
  bounded body preview; `/skill <name>` loads a body into the chat (docs/skills.md).
- **MCP manager** (Ctrl+P "MCP servers"; the status-bar `mcp:` chip): the configured MCP
  servers with live status, toggled per-server with `Space`/`Enter`/click. The host persists
  the `enabled` flag to `config.json` and reloads, so the change is global and applies live
  (disabled servers drop their tool specs from later requests — context savings). See
  [`mcp.md`](mcp.md) "UI".
- **Session search** (`/sessions`, Ctrl+P "Session search"): a type-to-filter bar over the
  daemon's session list (`GET /v1/sessions`; the FTS index has no daemon endpoint). With an
  empty filter it lists the recent
  sessions newest-first (time + short id + title); typing filters titles/ids and renders
  per-message-shaped hits that
  render role + short session id + a matched snippet (matched characters highlighted);
  `↑/↓`/`j/k`, PgUp/PgDn, Home/End, the wheel and clicks pick, and a bounded detail pane
  previews the selected row's metadata / snippet. A row open in a tab is marked like the tab
  bar (`●` active / `·` open / the tab's activity glyph), and the detail pane notes
  `open in tab N (active)`. `Enter` opens the selected transcript in a
  new tab (resumed, like `--resume`). `Del` (or `Ctrl+D`) asks to permanently delete the
  highlighted transcript from disk (`y` confirms, `n`/`Esc` cancels); a session still open in
  a tab is refused, and the transcript + sidecar are unlinked with the index row dropped.
  Rows page in by `offset` as the selection nears the bottom (infinite scroll). `Esc` closes.
- **Context inspector** (`/ctx`, Ctrl+P "Context inspector", the status-bar context chip): a read-only readout of what
  occupies the model's window (`ChatSession.contextBreakdown()`, docs/agent.md "Context
  inspector") — labelled rows (model · window limit · used/percent · system prompt ·
  durable history · tool specs · MCP specs · messages · compactions · cache read/write),
  a text-cell usage bar, and a bounded scrollable list of the durable history messages
  (role + one-line preview + token estimate; a turn's preview includes an `→ tool ×n` call
  summary, so tool-call/reasoning-only turns do not read as `(empty)`; on a resumed tab the
  list reconstructs the saved transcript's tool calls and merges new messages, docs/agent.md
  "Context inspector"). `↑/↓`/PgUp/PgDn/Home/End scroll the list, the
  wheel scrolls, `Esc` closes. The snapshot is a `createMemo` over the session's signals,
  so it updates live while a generation streams; an empty/disabled session shows zeros
  and a note.
- **Usage dashboard** (`/usage`): token usage rolled up over the newest 14 days with
  activity for its summary, chart and `by day` list, with the cache hit rate. Each turn is
  bucketed by the day IT happened, so a session spanning several days does not collapse
  onto its last activity date; the summary is bounded to that 14-day window rather than
  scanning unlimited history. The `by session` list is not windowed — every transcript is
  ranked by newest activity and paged 50 at a time, with a "load more" row (`Enter`/click)
  revealing older sessions on demand. Both text lists read newest-first (recent day/session
  on top). The `all` row counts every call in the window (the sum of the day rows). A
  read-only report, so `↑/↓`/`j`/`k` shift the viewport one line at a time (`PgUp`/`PgDn`
  page, `Home`/`End` jump, the wheel scrolls, `r` refreshes).
- **Keybindings** (`/keys`, Ctrl+P "Keybindings"): lists every action with its current
  binding; Enter captures a new key, `d` restores the default, and the global hotkey layer
  is re-installed immediately (docs/keybindings.md).
- **Sudo prompt** (centered modal card): masked password, `Tab` remembers for the session;
  resolves the pending
  `sudoRequest`. It covers both a hidden-shell (`shell_background`) password failure and a
  `shell_session` command that invokes sudo (the executor then types the `sudo -A` form). A
  re-prompt after sudo refused a password renders the request's optional `hint` as a
  warning-coloured line (e.g. `wrong password — try again`).
- **Resume picker** (`--resume`): the recent-session list, an in-app window at boot (the
  `resume` overlay) — type-to-filter over title/first-user/tags, Enter resumes into tab 1,
  Esc/q boots fresh. Its list is bounded to the card and paired with a detail preview.
- **Re-attach picker**: the boot re-attach list (the `attach` overlay), an in-app window over
  the live layout. App opens it only for a real choice (≥2 live panes); Enter attaches, Esc/q
  starts a fresh tab. The lone-pane case is auto-attached without asking
  ([`daemon-api.md`](daemon-api.md) "Lifecycle").

## Click mapping

The tab bar and status bar each render as **one** text element. Rendering segments as
separate `<text>` elements makes narrow terminals clip each segment, so instead the bars
are built as an ordered list of `BarPart`s (`ui/lib/bar.ts`) whose `BarRegion`s map
`e.x - currentTarget.screenX` onto the recomputed rendered string via
`ui/lib/clickTarget.ts`. An elastic `barFlex` part is padded to the terminal edge so the
row is always full width (a shrinking row repaints every cell). Hover tracks the part under
the pointer and paints the selection fill; press flashes the accent block — the same
feedback the chat rows use. When the content still cannot fit, `fitBarParts` applies the
bar's priority policy (truncate long values with an ellipsis, then drop low-priority chips)
so the right-aligned affordances — `? commands`, the agent chips — are never pushed
off-screen or clipped; separators orphaned by a dropped chip are collapsed.
Chat row actions (approval buttons, copy, revert, per-line code paste)
respond to left-click only; command/menu/model/settings rows currently act on any button.
The pane divider is the invisible 1-column gap between the terminal card and the sidebar
card: a left mousedown captures the pointer and the drag reports a clamped sidebar width
(the same `clampSidebarWidth` the keyboard resize uses), so the gap follows the mouse; it
shows an accent `│` only while hovered or dragged.
The full click-target table is in [`keybindings.md`](keybindings.md).

Only the terminal pane and the chat message list are selectable. Every other text
renderable (tab/status bar, toasts, overlays and pickers, the chat input, the slash menu)
sets `selectable={false}` so a click can never start a selection and copy a menu
([`keybindings.md`](keybindings.md), [`architecture.md`](architecture.md) "Mouse and
selection").

## Reactivity rules (Solid + opentui)

These are load-bearing and easy to get wrong:

- Solid components run **once**. Branching on `props.x` in a component body freezes that
  branch until some tracked read changes — recompute view state in a `createMemo` over
  every relevant prop.
- A span removed from the tree (or a row whose text shrank) keeps its old painted cells,
  and identical spans may be reused without repainting. Rows whose content can shrink need
  a **fixed cell budget** (content + caret + pad) with an explicit `bg` on every span.
- A remounted flow sibling next to a scrollbox may not repaint; that is why the slash menu
  is absolutely positioned above the input.
- A recomputed row list must be reconciled by object identity before it reaches a
  reference-keyed `<For>` (`chatLayout.reuseRows`). A running tool card re-lays on every
  80ms spinner tick; without reuse the whole card remounts and its interactive rows
  (`ask_user` options, approval buttons, toggle/copy rows) lose their local hover/press
  signals — the hover flicker. Only the row carrying the animated glyph is allowed to change
  identity.
- `bold` is valid on `<span>` style, not on `<text>` style.

## Related docs

- [`DESIGN.md`](DESIGN.md) — layout regions, theme tokens, color rules, do's/do not's
- [`keybindings.md`](keybindings.md) — keymap, overlays, click targets, input internals
- [`agent.md`](agent.md) — chat session state and streaming display
- [`config.md`](config.md) — what the settings screen and pickers write
