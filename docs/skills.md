# Skills

User guide: https://sensus.sh/docs/skills/

Skills are reusable procedure documents the agent loads on demand — a lightweight,
user-editable alternative to cramming every workflow into the system prompt. Adapted from
Hermes Agent's `SKILL.md` progressive disclosure.

## Format

A skill is a `SKILL.md` with frontmatter (`name`, `description`) and a markdown body:

```
---
name: deploy
description: ship this app safely
---
1. run the tests
2. build
3. deploy and verify
```

Location: `~/.config/sensus/skills/<slug>/SKILL.md` (a flat `~/.config/sensus/skills/<name>.md`
also works). `SENSUS_HOME` redirects the directory (`skillsDir()`), which `ensureAgentDirs`
materializes on boot. The first definition of a duplicate name wins (a warning is toasted).

## Built-in skills

`src/config/builtinSkills.ts` ships skills inside the binary, materialized into the skills
dir on boot with the **same Sensus-owned lifecycle as built-in agents**
([`agents.md`](agents.md) "Built-ins"): the file carries a banner whose `sha256` hashes its
body; an unedited built-in is refreshed in place on update, and a user-modified one is
rescued as `<stem>.modified-<time>.md` (with a unique frontmatter `name`) before a fresh
built-in is generated. The shared machinery lives in `src/config/builtins.ts`.

- **sensus** — the app's self-reference: what Sensus is, the layout and the two shells, the
  config/path surfaces, the full config schema, MCP/agent/skill/memory setup, the tool list,
  approvals, and the command + key + CLI surface. Loaded on demand (`skill_view sensus`) so
  the agent can answer "how do I add MCP?" — or rewrite Sensus's own config — without the
  source tree. Its body is kept under the `tool_output` defaults (`max_lines` 2000 /
  `max_bytes` 51200, the same cap `skill_view` results pass through), so `skill_view` returns
  it whole. Bodies use `~~~` fences so the inline TS template literal needs no backtick
  escaping.

## Progressive disclosure

Only each skill's **name + description** reach the system prompt (an index line per skill).
The full body is fetched through the tool when the agent decides the skill applies:

- `skills_list` — the index (no parameters, read-only).
- `skill_view` — the full body for one name (read-only).

This keeps the prompt small and cache-stable: adding or editing a skill body does not change
the prompt prefix, only `skills_list`/`skill_view` results. `/reload` re-reads the directory.

The loader is `src/agent/skills/loader.ts` (pure, unit-tested); `ChatHost` owns the catalog
and refreshes it on `/reload`.

## Invocation and management

- `/skills` opens the read-only manager (the list plus a bounded preview of the highlighted
  skill's body); `/skill <name>` loads a skill's body into the current chat as a message so
  the agent follows that procedure.
- An agent's frontmatter `skills: [a, b]` limits which skills it sees and can load
  (docs/agents.md); absent / `["*"]` / an empty list means every skill.
- `/learn` authors a new skill from the current conversation: it asks the agent to write
  `~/.config/sensus/skills/<slug>/SKILL.md` (frontmatter + a general numbered procedure),
  then `/reload` makes it visible. It is always user-initiated — sensus does not watch shell
  commands or prompt you to capture skills on its own.

## Related docs

- [`agent.md`](agent.md) — the tool loop and tool table
- [`agents.md`](agents.md) — agent definitions (skills are a sibling concept)
- [`memory.md`](memory.md) — the durable-notes system
