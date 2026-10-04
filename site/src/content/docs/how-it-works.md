---
title: How the agent works
description: What the Sensus agent can do, how a turn runs, and where it does its work.
order: 2
---

The right pane is an AI agent that lives next to your shell. It can see the terminal you are
working in, run commands on your behalf, read and edit files, and type into your visible
terminal when you ask it to. You stay in control: by default, every action it takes asks for
your approval first; see [Approvals](/docs/approvals/).

## What the agent can do

- **See your terminal.** It knows your working directory, your shell, your recent output, and
  whether you are inside a git repository with uncommitted changes. See
  [What the agent sees](#what-the-agent-sees).
- **Work in a hidden shell.** Long commands, checks, and the actual work happen off-screen, so
  your terminal stays yours.
- **Drive your visible terminal.** Ask it to run something "in my terminal" and it types the
  command into your shell, special keys included. You watch every keystroke.
- **Read and edit files.** It can page through large files and proposes edits as a diff you
  review before anything is written.
- **Look at images.** Paste a screenshot or point it at an image file, on models that accept
  images.
- **Ask you a question.** For a real fork in the road, it can stop and ask, with clickable
  options and a free-text answer.
- **Remember your machine and your preferences.** Durable notes survive across sessions, and
  it can scan the machine once to build a host map.
- **Load skills.** Reusable procedures you or the agent write are loaded only when relevant.
- **Use tools from MCP servers.** Connect a server and its tools join the agent's toolbox.

For the full list of what it can do and when to reach for it, see [Tools](/docs/tools/).

## A turn, step by step

1. **You ask.** Type in the chat sidebar and press Enter.
2. **It looks around.** Before changing anything, it may check state in the hidden shell or
   read a file.
3. **It proposes or acts.** If the next step touches your machine (a command, a file change,
   a tool from an MCP server), you get an approval card.
4. **You decide.** Accept, reject, or allow that kind of action for the rest of the session.
   See [Approvals](/docs/approvals/) for what each choice means.
5. **It runs the step and reports.** Results appear in the chat as it works. If the task needs
   more steps, it keeps going through the same loop until it is done or you stop it.

Press `Esc` to stop a running turn. Whatever the agent already said is kept, marked as
aborted.

## Approvals at a glance

Sensus starts in **confirm** mode: every tool call gets an inline card, reads included, unless
a saved allow rule covers it. Accept with `y`, reject with `n`, or trust that kind of action
for the rest of the session with `a`. When you want the agent to move faster, `/yolo` switches
to **full-auto**, where everything runs without a card except dangerous commands. The full
card model, the allow rules, and the destructive floor live in
[Approvals](/docs/approvals/).

## Your terminal vs the hidden shell

Sensus gives the agent two very different places to work, and the difference matters:

- **The hidden shell** is private scratch space. The agent uses it to investigate and to do
  work you delegated. You see nothing in your pane, and the output comes back to the chat.
  Long jobs can keep running in the background after the turn ends; the status bar shows how
  many are still alive.
- **Your terminal** is the pane on the left. The agent types into it only when you ask it to
  show you something or do something in your session. You watch every keystroke.

Typing into your terminal runs free: nothing executes yet. Pressing Enter is the moment a
line actually runs, so every Enter is confirmed with a card. If the agent tries to type while
your shell is busy, mid-prompt, or inside a full-screen app, it refuses and tells you why
instead of typing into the wrong place.

## When the agent runs

Your shells and agent turns are hosted by a local background service. This is what makes
Sensus feel persistent:

- **Detaching does not stop the work.** Quit Sensus, close a tab, or use `Ctrl+A d`, and any
  running turn keeps going. Your shells keep running too.
- **Re-attach on the next boot.** When you start Sensus again, it offers your live shells and
  chats back, with the conversation intact.
- **Approvals wait for you.** If the agent needs a decision while you are away, the turn waits,
  and gives up politely after a short while instead of hanging forever.
- **Sensus itself has no accounts and no telemetry.** The local service binds locally, and
  your config, memory, sessions, and logs stay on your machine. Your messages and any images
  you attach go to the model endpoint you configure, and MCP tool calls go to the servers you
  connect. Beyond those, Sensus only fetches the public models.dev catalog (model metadata),
  your endpoint's model list, and any instruction links you added to your configuration, when
  it needs them, and never your terminal output or chat.

If you ever want to stop everything, `sensus kill` is the switch that stops the local service
and the shells it owns.

## Making it yours

- **[Agents](/docs/agents/)** change the agent's posture: how proactive it is, which tools it
  may use, and whether it is allowed to change anything. Pick one with `/agent`.
- **[Skills](/docs/skills/)** are reusable procedures the agent loads when a task matches. Ask
  it to write one after you work out a process together.
- **[Memory](/docs/memory/)** is what the agent carries between sessions: durable facts, a map
  of your machine, and a journal of what it did. Open the memory manager with `/memory`.
- **[MCP](/docs/mcp/)** connects external tool servers, so the agent can use capabilities
  beyond its built-in toolbox.

## What the agent sees

Each time you send a message, the agent gets a fresh snapshot of your terminal: the working
directory, the shell, the last lines of output, and git branch status when you are in a
repository. While a full-screen app is open, it sees a note instead of the screen contents, so
it never misreads what is on display.

You can turn terminal context off for a chat with `/context off` if you prefer, and nothing
about your terminal is sent unless you send a message.

## Long conversations

When a conversation grows close to the model's limit, Sensus summarizes the older parts into a
checkpoint and keeps the most recent work verbatim, so the chat can continue without losing
the thread. If a fact must survive no matter what, pin it with `/pin`. Use `/compact` to
summarize on demand and `/ctx` to see what is filling the context window.

## Next steps

- [Approvals](/docs/approvals/): the card model, allow rules, and full-auto
- [Tools](/docs/tools/): what the agent can do, and when
- [Agents](/docs/agents/): pick or write a posture
- [Skills](/docs/skills/): reusable procedures
- [Memory](/docs/memory/): what it remembers, and how to edit it
