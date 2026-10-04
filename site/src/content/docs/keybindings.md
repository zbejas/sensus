---
title: Keybindings
description: The global hotkeys, the Ctrl+A prefix, the slash and command menus, and how to remap keys to your liking.
order: 5
generated: keymap
---

Sensus reserves its global hotkeys: they are intercepted before the terminal pane or the chat sees them, so the inner shell never receives a bound key. Most work from any focus; the notes below call out the exceptions, and the reference table at the end lists every remappable action.

## The Ctrl+A prefix

`Ctrl+A` is a prefix key, in the tmux tradition. Press it and the status bar shows `prefix…` for about a second:

- `d`: detach sensus. The local worker keeps your shells and any running agent turn alive, ready to re-attach the next time you start sensus.
- Any other key with terminal focus: the pane receives `Ctrl+A` followed by that key, so readline bindings such as `Ctrl+A` `Ctrl+A` (beginning of line) keep working.
- Any other key with chat focus: the prefix is cancelled and the key behaves normally.

With terminal focus, `Ctrl+A` on its own reaches the pane after the window expires. `sensus kill` is the kill switch when you want to stop every local worker and its shells for good.

## Keys you will use most

- `Shift+Tab`: move focus between the terminal pane and the chat; `Alt+A` jumps straight to the chat input.
- `Ctrl+T` / `Ctrl+W`: open a new tab / close the current one. Closing detaches the tab's shell rather than killing it, and while the agent is generating a reply a second press within a moment confirms.
- `Alt+1`…`Alt+9`, `Alt+Left`/`Alt+Right`: jump to or cycle tabs.
- `Ctrl+O`: settings; `Ctrl+P`: the command palette.
- `Alt+M`: agent picker; `Alt+Y`: switch between confirm and full-auto; `Alt+T`, `Alt+E`, `Alt+C`: toggle thinking display, tool-card output, and card style.
- `Alt+B` / `Alt+R` / `Alt+S`: copy the newest message, revert the newest user turn, send the newest code block to the visible pane.
- `Esc`: abort the running generation in chat focus; in terminal focus it goes to the pane.
- `y` / `n` / `a`: answer an approval card; `1`…`9`: pick an option when the agent asks a question.
- `Ctrl+Shift+V` or `Alt+V` to paste: an image from the clipboard attaches to the chat, text goes to the focused input.
- `Alt+Home`: chat-only view for narrow terminals; `Alt+,` / `Alt+.`: shrink or grow the chat.

## Keys taken from inner apps

`Ctrl+A` is intercepted for the prefix (see above). `Alt+A`, `Alt+1`…`Alt+9`, `Alt+Left`/`Alt+Right`, `Alt+,`, `Alt+.`, `Alt+M`, `Alt+Y`, `Alt+T`, `Alt+E`, `Alt+C`, `Alt+B`, `Alt+R`, `Alt+S`, `Alt+End`, `Alt+Home`, `Alt+V`, `Ctrl+T`, `Ctrl+W`, `Ctrl+P`, `Ctrl+O`, and `Ctrl+Shift+V` are reserved too. `Ctrl+V` is deliberately left alone so inner apps keep visual-block and quoted-insert; paste is `Ctrl+Shift+V` (or `Alt+V`). An app that needs one of the reserved keys can be run in a plain shell outside sensus.

## Slash menu

Typing `/` as the first character of the chat input opens a menu of commands directly above the input. Only prefix matches are offered; `Up`/`Down` move, `Tab` completes the highlighted command, `Enter` completes a partial token or sends an exact command immediately, and `Esc` dismisses. `/help` prints the command list in the chat.

## Command palette

`Ctrl+P` opens a filterable palette of actions grouped under Settings, Chat, Help, Tabs, and Layout. Type to narrow it down, move with the arrow keys (or `j`/`k` while the filter is empty), and press `Enter` to run a row. Rows show the key or slash command that does the same thing, and stateful rows show the current value. Picking a row that opens another view leaves the palette underneath; `Esc` pops back one view at a time. While the palette is open it swallows all keys.

## Overlays and the view stack

Overlays (settings, the pickers, session search, the context inspector, the MCP manager, the sudo prompt, the welcome tour, and setup) stack. Only the top one renders, `Esc` (or a click outside the card) pops it, and choosing something that leaves the overlay context closes the whole stack. While any overlay is open, global hotkeys and the prefix are suspended.

## Click targets

Everything clickable has a keyboard equivalent:

- Tab bar or rail: select a tab, close it with its `×`, or open `+ new tab`; clicking the active tab returns focus to the terminal.
- Status bar chips: cycle tabs, open the agent picker, cycle the approval mode, open the model picker, open the context inspector, cycle the thinking mode, open the MCP manager, and revoke session trust.
- Pane divider: drag to resize the chat.
- Chat scrollbar: drag or click to scroll; a code-block command line pastes into the terminal on one click and runs on a second click within a moment.
- Selection: drag over the terminal or a chat message to copy it; right-click re-copies the current selection.

## Remap keys

`/keys` opens the keybindings editor. `Enter` captures a new key for the highlighted action (single letters require a modifier), `d` or `Delete` restores the default, and changes apply immediately. The editor also shows each action's id.

You can edit the `keymap` key directly:

```json
{
  "keymap": {
    "new-tab": "ctrl+n",
    "close-tab": "ctrl+q",
    "focus-toggle": "shift+tab"
  }
}
```

The action ids are `focus-toggle`, `focus-sidebar`, `new-tab`, `close-tab`, `tab-prev`, `tab-next`, `open-settings`, `open-menu`, `open-agents`, `sidebar-shrink`, `sidebar-grow`, `prefix`, `toggle-approval`, `toggle-thinking`, `toggle-details`, `toggle-card-style`, `chat-bottom`, `toggle-chat-only`, `copy-message`, `revert-message`, `send-code-block`, `paste-image`, and `tab-1` through `tab-9`. A malformed entry keeps the default binding rather than breaking the keymap.

## Next steps

- [Approvals](/docs/approvals/): the cards these keys answer.
- [Configuration](/docs/configuration/): the `keymap` key and everything else.
- [Sessions](/docs/sessions/): resume, search, and export.
- [Tools](/docs/tools/): what the agent can do.
- [How the agent works](/docs/how-it-works/): the loop behind the chat.

## Full keymap

Every remappable action, its default keys, and the slash-command equivalent where one exists.
