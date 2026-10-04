# Sessions

One chat session = one append-only JSONL transcript under
`<dataDir>/sessions/<instance-id>/<tab-n>.jsonl` (see [`architecture.md`](architecture.md)
"session/"). `--resume` reopens one; each tab gets its own file, and `/clear` starts a new
generation (`tab-n-2.jsonl`, …) while keeping the old file. A **rewind** (the `↺ revert`
affordance on a user message; [`ui.md`](ui.md) "Rewind") appends a `revert` event carrying
`keep` (the number of user+assistant records to retain): `loadSessionFile` truncates the
logical transcript as it reads, so later records append after the rewind and `--resume` never
resurrects the discarded turns.

User guide: https://sensus.sh/docs/sessions/

## Empty sessions are not stored

A fresh transcript is **lazy**: opening a tab (or running a slash command that is only a
local UI action, e.g. `/help`, `/model`, `/yolo`) touches no disk. The file is created the
moment the first record with real content lands — a `user_message`, `assistant_message`,
`tool_call`, `compaction`, or `revert`. Buffered leading `slash_command` events flush ahead
of that first record, so nothing is lost once a session does start. A tab the user never
sent a message in therefore leaves no file and no `(empty session)` row in `/sessions`,
`session_list`, or the `--resume` picker. Listings and the search index also ignore any
header-only transcript left by an older version (a transcript with zero user/assistant
records is skipped, and the index hides zero-message rows at query time).

## Metadata sidecar

Transcripts are append-only, so a human **title** and **tags** live beside them in a small
sidecar (never rewriting the JSONL):

```
<session>.jsonl.meta.json   ->   { "title"?: string, "tags"?: string[], "renamedAt"?: number }
```

`src/session/meta.ts` owns the pure layer: `readSessionMeta` (missing/corrupt → `{}`),
`writeSessionMeta` (atomic tmp+rename; never throws), `renameSession`, `tagSession`,
`deriveTitle` / `deriveTitleFromText` (the first user message, whitespace-collapsed,
ellipsized to 60 chars), and `sessionToMarkdown`. `loadSessionFile` merges the sidecar in:
`LoadedSession.title` is the sidecar title or the derived title, and
`LoadedSession.tags` is the normalized tag list. A rename/tag change is picked up by the
search index because `refresh` also compares the sidecar mtime.

### Auto titles

On a session's **first user prompt**, sensus asks a model for a short title and writes it
to the sidecar (`renameSession`), so the `/sessions` overlay and the `--resume` picker show
a recognizable topic instead of the raw first message. `src/agent/chat/title.ts` owns the
one-shot, no-tools completion; `cleanSessionTitle` (meta.ts) strips a stray `Title:` label
and quotes and caps the result at 10 words / 60 chars. The request is fire-and-forget and
aborts with the generation (Esc); it never blocks or fails a send, and a failure leaves the
derived title. It runs only when there is no explicit sidecar title yet, so a manual rename
always wins and resumed sessions are never retitled. The model is the session's selected
model by default (`titles.model` empty); `titles.model` / `titles.enabled` in
[`config.md`](config.md) override it, and the settings screen's **Model** category edits
both.

**Tab titles.** Each tab's title is its session title (`ui/lib/tabs.tabTitle`): the
auto/manual title when known, otherwise the derived first-user-message title, falling back
to the shell basename before the first prompt. On the first prompt the tab immediately shows
the derived title — `deriveTitleFromText` (meta.ts), whitespace-collapsed and ellipsized —
while the model title generates in the background; when it lands, the host pushes it onto
the session (`ChatSession.setSessionTitle`) and the tab re-renders. `setSessionTitle` also
emits a `title` chat event ([`agent.md`](agent.md) "Remote approval & event stream") — it
lands *after* the turn settles, when no other engine event fires, so a remote host has to
surface it explicitly. The daemon folds it into `meta.sessionTitle` and pushes a `chat.meta`
([`daemon-api.md`](daemon-api.md) "WebSocket channels"), and `RemoteChat` mirrors
`meta.sessionTitle` onto the title accessor from that event (not only `chat.state`), so a
detached/re-attached tab still retitles. A resumed transcript's tab shows its loaded title
at once.

## Search

The SQLite FTS5 index (`src/session/indexDb.ts`, docs/agent.md "Session search") stores the
title/tags per session for the `session_search` tool and the agent's history browsing. The
agent can also browse history directly: `session_list` pages
through indexed transcripts newest-first and `session_view` reads one transcript's messages
a window at a time (`offset`/`limit`), so a large history is never loaded whole.

The **`/sessions` overlay is served by the daemon REST list** (`GET /v1/sessions`, the same
source as `--resume`), not the FTS index — the index has no daemon endpoint, so the overlay
lists titles/ids and filters them client-side. With an
empty query it lists the recent
sessions newest-first — time, short id and title — so it is useful
before you type; typing filters the newest page by title/id and renders per-message-shaped
hits with matched-character
highlighting. Both views page through the list by `offset` as the selection nears the
bottom (infinite scroll).

A row whose transcript is **currently open in a tab** is marked like the tab bar
(`docs/DESIGN.md` "Tab bar"): an accent `●` for the active tab, a muted `·` for another open
tab, or the tab's activity glyph (`!` when an approval is pending, else the streaming
spinner) — so live sessions show up "like in tabs".

`Enter` opens the highlighted transcript in a NEW tab (resumed exactly like `--resume`),
leaving the current tab untouched; `Del`/`Ctrl+D` deletes it. Deletion is refused for a
transcript a tab is still appending to (the next append would silently recreate a partial
file); otherwise `deleteSessionFile` (`store.ts`) unlinks the JSONL and its sidecar and
`SessionIndex.remove` drops the index rows, so the session disappears from search, `list`
and the `--resume` picker. The `--resume` picker
(`src/ui/components/ResumePicker.tsx`) adds type-to-filter over titles + first user text +
tags.

## Export

`sessionToMarkdown(session)` renders a transcript as Markdown (title heading, tags/timestamp
facts, then role-labelled messages with bodies verbatim, so code fences survive). The
`--export <session.jsonl>` CLI flag writes it to stdout and exits (see
[`operations.md`](operations.md)).

## Related docs

- [`architecture.md`](architecture.md) — the session layer and lifecycle
- [`config.md`](config.md) — `SENSUS_HOME`/data dir overrides
- [`agent.md`](agent.md) — session search tool and context compaction
