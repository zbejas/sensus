---
title: Agents
description: "Choose or write the posture the agent works from: session-first, autonomous, or read-only."
order: 7
---

An agent is the posture the Sensus agent works from. It is a markdown file with a short
description, optional limits on which tools it may use, and a prompt body that steers how it
behaves. Picking an agent is how you make the agent more cautious, more autonomous, or
read-only.

## Built-in agents

Sensus ships two, written into `~/.config/sensus/agents/` the first time you run it:

- **copilot** (the default): the terminal guide. It adapts to the approval mode: in confirm
  mode it works in your visible terminal so you can watch, explains one step at a time, and
  hands privileged commands to you; in full-auto it drives the task end-to-end in the hidden
  shell, verifies each step, and finishes with a summary.
- **scout**: the read-only researcher. It explores your machine and code and reports what it
  found; changes are refused outright, whatever the approval mode.

Built-ins are Sensus-owned. They refresh in place when an update changes them, and if you edit
one, your version is rescued under a new name and a fresh built-in is generated; nothing is
lost. To customize one, copy it to a new name and edit the copy.

## Picking an agent

- `/agent <name>` switches directly.
- `/agent` or `Alt+M` opens the picker.
- The status-bar chip shows the current agent and opens the picker; the sidebar chip cycles
  through the loaded agents.

A pick applies to the current session and becomes the default for new sessions. Other open
tabs keep what they were using. A session that has never picked follows your configured
default and notices a change on its next message.

## Writing your own

Create a markdown file in `~/.config/sensus/agents/`. The file name is the agent name unless
the frontmatter sets one. After you edit a file, `/reload` makes the change visible, and it
takes effect on the next message.

| Field | What it does |
|---|---|
| `name` | The selection name. Defaults to the file name. |
| `description` | One line shown in the picker. |
| `tools` | The built-in tools this agent may use, as a list. Absent, empty, or `["*"]` means all of them. It limits tools from MCP servers too. |
| `skills` | Which skills the agent may see and load. Absent, empty, or `["*"]` means all. |
| `sudoPrompt` | How sudo is handled: `ask` (the default, where the agent hands the command to you), `popup` (Sensus asks for the password in a popup and retries), or `auto` (popup in full-auto, ask in confirm). |
| `shell` | The preferred shell: `session` for your visible terminal, `background` for the hidden shell, or `auto` for no preference. |
| `readonly` | `true` makes the agent read-only: edits, memory writes, typing into your terminal, and mutating shell commands are refused outright, whatever the approval mode. |

Unknown fields are ignored with a warning. A minimal custom agent looks like this:

```markdown
---
name: deployer
description: Ships this project, nothing else
tools: ["shell_background", "read_file", "edit_file"]
shell: background
sudoPrompt: ask
---
You are DEPLOYER: ship this project and verify the result. Do not touch
anything else.
```

## Next steps

- [Approvals](/docs/approvals/): how tool calls are gated in each posture
- [Tools](/docs/tools/): what an agent's `tools` list can choose from
- [Skills](/docs/skills/): limit or share reusable procedures
- [Configuration](/docs/configuration/): the `agent` default and every other setting
- [How the agent works](/docs/how-it-works/): the turn loop and the two shells
