---
title: Approvals
description: How Sensus asks before the agent acts, and how to loosen or tighten the gate.
order: 3
---

The agent can read files, run commands, change files, and call external tools. Sensus asks
before each of those actions by default, so nothing happens on your machine without your say-so.
This page covers the card model, the keys, the allow rules, and what still asks even when you
turn approvals off.

## The approval card

Every tool call gets an inline card in the chat showing exactly what is about to happen: the
full command, the file and its diff, or the tool and its arguments. Nothing is hidden behind a
truncated preview.

| Key | What it does |
|---|---|
| `y` | Accept this action once. |
| `n` | Reject it. The agent is told and adjusts its approach. |
| `a` | Accept and stop asking for that same kind of command for the rest of this session. |

The `a` option appears only when the action belongs to a repeatable command class, and it is
never offered for dangerous or irreversible actions. What you trusted is visible in the status
bar; click it to revoke, and clearing the chat forgets it too.

Reads are approved like everything else in the default mode. If a read or a command is routine
for you, saving an allow rule (below) is how you stop seeing its card.

One deliberate exception: typing into your terminal runs free (you watch every keystroke), and
only the moment a line would run (pressing Enter) is confirmed. Moving around or filling in a
command does not ask; running it does.

## Plans for multi-step turns

When a single turn needs several actions, Sensus can present them as one ordered plan instead
of a stack of separate cards. You can move through the lines, toggle individual ones, approve
or reject the whole plan, or approve everything that is not dangerous. Dangerous lines are
never included in "approve all"; each one still needs its own explicit approval.

## Full-auto mode

When you want the agent to work without stopping for each step, switch to **full-auto** with
`/yolo`, `Alt+Y`, or the status-bar indicator. In full-auto, everything runs without a card
except the dangerous actions described below. Switch back at any time; the current mode is
always visible in the status bar.

Full-auto is a convenience switch, not a safety boundary. It is still worth watching what the
agent does in your terminal and reading its summaries.

## What still asks in full-auto

A small set of actions is never auto-approved, because they can destroy data or take the
machine down. They still show a card in full-auto: catastrophic deletes (for example, removing
a system directory or your home directory), filesystem-format and secure-wipe tools, raw
device writes, power commands, and similar irreversible operations.

An ordinary delete inside a project folder, like cleaning up a build directory, is not in that
set: the floor is about catastrophic targets, not about `rm` in general. Some agents are also
read-only by design: they refuse changes outright no matter which mode you are in. See
[Agents](/docs/agents/).

## Saved allow rules

You do not have to approve the same thing every day. There are three ways to narrow the gate:

- **Trust for this session**: the `a` key on a card. It lasts until you clear the chat or
  revoke it from the status bar, and it never covers dangerous actions.
- **Saved allow rules**: rules you add in settings so matching actions skip the card from
  then on, across sessions. A saved rule still never un-gates a dangerous action.
- **Custom permission rules**: advanced rules for exactly what may run, ask, or be refused,
  including rules that block an action outright. See
  [Configuration](/docs/configuration/) for the rule format.

A blocked action never runs and the agent is told why, so it can propose a different approach.

## Questions are not approvals

Sometimes the agent needs a decision only you can make: which of two approaches to take, which
account to use, whether to accept a breaking change. For those it asks a question inline, with
clickable options and a free-text answer, and pauses until you answer. Questions are about
direction; approval cards are about permission. Answering one does not approve anything.

## When you reject

Rejecting a card does not end the turn. The agent receives the rejection, explains or adjusts,
and may propose a safer alternative. If you rejected by mistake, ask it to try again; the next
attempt shows a fresh card.

## Next steps

- [Tools](/docs/tools/): what each tool does and when the agent reaches for it
- [How the agent works](/docs/how-it-works/): the turn loop, the hidden shell, and what keeps
  running when you detach
- [Agents](/docs/agents/): stricter or more autonomous postures, including read-only agents
- [Configuration](/docs/configuration/): saved rules, endpoints, and every setting
