---
title: Skills
description: "Reusable procedures the agent loads on demand: write them once, use them whenever the task fits."
order: 8
---

A skill is a reusable procedure the agent loads when a task matches: how to deploy this app,
how you like release notes written, the steps for a recurring maintenance job. Skills keep
that knowledge out of the system prompt until it is actually needed.

## Where skills live

A skill is a folder with a `SKILL.md` inside:

```
~/.config/sensus/skills/<name>/SKILL.md
```

A flat `~/.config/sensus/skills/<name>.md` works too, for a single-file procedure.

Sensus also ships a built-in skill, **sensus**: a self-reference the agent can load when you
ask how Sensus itself works or how to configure it. Like the built-in agents, it is
Sensus-owned: it refreshes when an update changes it, and an edit in place is rescued under a
new name rather than lost.

## The format

A skill is markdown: frontmatter with a name and a description, then the procedure as the
body.

```markdown
---
name: deploy
description: ship this app safely
---
1. run the tests
2. build
3. deploy and verify
```

- **`name`** is how the skill is selected. It defaults to the folder or file name.
- **`description`** is the one line shown in the skills index. It defaults to the first line
  of the body.
- **The body** is the procedure itself: numbered steps, notes, commands, whatever is
  clearest.

## How the agent finds and uses them

Only each skill's name and description sit in the agent's context. When a task matches, the
agent loads the full body on demand. That keeps the prompt small, and it means editing a
skill's body never disturbs the rest of the conversation. `/reload` re-reads the skills
folder.

## Working with skills

- `/skills` opens the skills manager: the list plus a preview of the highlighted skill.
- `/skill <name>` loads a skill's body into the chat so the agent follows it right now.
- `/learn <slug>` drafts a new skill from the conversation you just had. Use it after you
  work out a process together, then `/reload` makes the skill visible.
- An agent can limit which skills it sees with the `skills` field in its file; see
  [Agents](/docs/agents/).

## Next steps

- [Tools](/docs/tools/): the skills tools, and the rest of the toolbox
- [Agents](/docs/agents/): postures, including which skills each one may load
- [Memory](/docs/memory/): durable notes that are always available
- [Configuration](/docs/configuration/): where Sensus keeps its files and settings
