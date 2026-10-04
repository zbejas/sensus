---
title: Tools
description: "The agent's built-in toolbox: what each tool does and when the agent reaches for it."
order: 6
generated: tools
---

The agent does its work through tools. Every call is visible in the chat and gated by
[Approvals](/docs/approvals/): in the default mode you accept or reject each one before it
runs. A full reference table of every built-in tool, with a one-line purpose for each, sits at
the end of this page.

## The two shells

The agent has two very different places to run commands, and the difference matters:

- **`shell_background` is the hidden shell.** Commands run off-screen; you see nothing, and
  the output comes back to the chat. This is where the agent investigates state and does work
  you delegated: checks, builds, long jobs. A long command can be started in the background
  and keep running after the turn ends; the status bar shows how many jobs are still alive,
  and you can ask about or stop one later.
- **`shell_session` is your visible terminal.** The agent types into the pane you are looking
  at, special keys included, so you watch every keystroke. Typing runs free; the moment a line
  would actually run (Enter) is confirmed. If your shell is busy, mid-prompt, or inside a
  full-screen app, the tool refuses and explains why instead of typing into the wrong place.

Ask for something in your terminal ("run it in my terminal", "show me that") and the agent
uses `shell_session`. Work it should just get done goes through the hidden shell.

## Files

- **`read_file`** reads a regular file, with line paging for large files. It refuses
  directories and special files, and it is the preferred way to look at a file, so the agent
  does not shell out to `sed` or `head` for it.
- **`edit_file`** replaces one exact piece of text. It fails when the text is missing or
  appears more than once, so the agent asks for more context instead of guessing.
- **`write_file`** creates or overwrites a file.

Both edit tools show a diff card before anything is written; the write happens when you
approve it. Relative paths resolve against your terminal's working directory.

## Looking around

- **`get_scrollback`** captures the last lines of your visible terminal, including the live
  screen, so the agent can see what happened there.
- **`view_image`** reads a local image (png, jpeg, webp, or gif) into the model's context so
  the agent can actually see it. It is offered only when the selected model accepts images.

## Asking you

**`ask_user`** puts a question in the chat and pauses until you answer. It shows clickable
options plus a free-text answer, and it is reserved for genuine forks in the road (which
approach, which account, whether to accept a breaking change), not for per-step sign-offs.

## Memory and your machine

- **`memory`** maintains the agent's long-term notes: durable facts, the machine map, and the
  journal of what it did. See [Memory](/docs/memory/).
- **`host_scan`** runs a read-only discovery pass over the machine and returns a draft for the
  machine map, which the agent then curates. `/map` does the same from your side.

## Session history

**`session_search`** searches your past chats by content, so the agent can pick up something
discussed before. It can also list past sessions and read one a window at a time, rather than
loading a whole transcript at once. See [Sessions](/docs/sessions/).

## Skills

**`skills_list`** shows the available skills with their one-line descriptions, and
**`skill_view`** loads one skill's full procedure when the agent decides it applies. See
[Skills](/docs/skills/).

## Configuration

**`reload`** re-reads your configuration, custom instructions, agent files, and skills after
an edit, so changes take effect without a restart. It is the same action as `/reload` and
never writes anything.

## Tools from MCP servers

Servers you connect in your configuration contribute their own tools, named after the server.
They join the built-in toolbox and get the same approval cards as everything else. See
[MCP](/docs/mcp/).

## Next steps

- [Approvals](/docs/approvals/): how each call is gated, and how to loosen the gate
- [How the agent works](/docs/how-it-works/): the turn loop and the two shells
- [Skills](/docs/skills/): reusable procedures the agent loads on demand
- [Memory](/docs/memory/): what the agent remembers between sessions
- [MCP](/docs/mcp/): connect external tool servers

## The full toolbox

Every built-in tool, with a one-line purpose:
