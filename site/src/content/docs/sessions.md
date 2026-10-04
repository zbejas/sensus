---
title: Sessions
description: How your conversations are saved, how to browse, resume, and export them, and what happens when you detach.
order: 10
---

Every conversation is saved as it happens, on your machine, under
`~/.local/share/sensus/sessions/`. Detach, close a tab, or quit: the transcript is still there,
and the conversation picks up where it left off when you come back.

## What gets saved

Each tab writes its own transcript as the conversation unfolds: your messages, the agent's
replies and reasoning, tool calls, and checkpoints. A few details matter:

- An empty tab (one you never sent a message in) saves nothing, so it never shows up in your
  history.
- `/clear` starts a fresh conversation in the tab and keeps the old transcript around.
- Rewinding to an earlier message (the `↺ revert` action) discards the turns after it. Resuming
  that session continues from the rewind point; the discarded turns don't come back.

Transcripts can contain command output, so treat them like your shell history. They're stored
with owner-only permissions.

## Detach and come back

Your shells and agent turns are hosted by a local background service (see
[How the agent works](/docs/how-it-works/)). That means:

- Closing Sensus, closing a tab, or detaching with `Ctrl+A d` doesn't stop a running turn or lose
  the conversation.
- The next time you start Sensus, your live shells and chats are offered back, conversation
  intact.
- A tab you re-attach to keeps writing to the same transcript.

Use `sensus --resume` to reopen a saved transcript directly.

## Browsing and searching: `/sessions`

`/sessions` (or Ctrl+P → "Session search") lists your recent sessions, newest first, with the
time, a short id, and the title. Rows mark sessions that are currently open in a tab.

- Type to filter by title or session id. The list loads more rows as you scroll.
- `↑`/`↓` (or `j`/`k`) move the selection; `Enter` opens the highlighted session in a new tab,
  leaving the current one alone.
- `Del` (or `Ctrl+D`) deletes the highlighted session after a `y/N` confirmation. A session a tab
  is still writing to can't be deleted: close the tab first.

The filter matches titles and ids in the list. To search *inside* your past messages, ask the
agent: it can search your full conversation history.

## Titles and tags

On your first message, Sensus asks a model for a short title and shows it on the tab, in
`/sessions`, and in the resume picker. If titles are turned off or the request fails, the session
keeps its first message as the title. The `titles` configuration controls this; see
[Configuration](/docs/configuration/).

Sessions can also carry free-form tags in their metadata: when present they show in the browser's
detail pane and in the history listings the agent reads. There is no tag editor in the app yet.

## Export

`sensus --export <file>` prints a saved transcript as Markdown to standard output (title, tags,
timestamps, and role-labelled messages with code fences intact) so you can redirect it to a file
or pipe it somewhere else.

## Next steps

- [How the agent works](/docs/how-it-works/): the turn loop and what persists
- [Memory](/docs/memory/): what the agent remembers between sessions
- [Privacy & data](/docs/privacy/): what stays on your machine
