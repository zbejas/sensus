# Doc Template — Sensus Knowledge Base

Every doc in `docs/` follows this shape. Keep it tight: **facts over prose**, tables
over paragraphs, and always name **every file** in scope.

## 1. Overview

2–4 sentences: what this subsystem does, why it exists, and where it sits in the system.
No history and no milestone narration — docs describe current behavior only.

## 2. Key files

A table with **every file in scope** — path relative to the repo root + a 1–2 line
purpose. If a file exists but is not covered, say so.

| File | Purpose |
|---|---|
| `src/...` | … |

## 3. How it works

- Data / control flow (a short ASCII diagram where it helps)
- Key functions with their shape and what they return
- Entry points and call order
- Invariants stated as rules, not narration

## 4. Gotchas & invariants

Verified facts that are easy to get wrong — the things that cost a debugging session
when forgotten. Good examples from this repo:

- A `<scrollbox>` paints its internal boxes' default background — pass
  `backgroundColor: "transparent"` or the zero-bg-SGR invariant fails.
- The PTY child must be spawned `detached: true` (session leader) **and** the shell must claim
  the PTY as its controlling tty (Bun's `setsid()` does not call `TIOCSCTTY`; launch non-bash
  shells through bash). Otherwise `/dev/tty` is missing and `sudo`/`ssh` fail.
- The provider sees the terminal context block as its own user message right before the
  user's text; scripted test servers must key markers off the last paragraph.

## 5. Related docs

Relative links to other docs in `docs/` (e.g. `../agent.md`, `DESIGN.md`).

---

## Writing rules

- **English only.** Code identifiers in backticks.
- **Two audiences, two docs.** User-visible behavior lives on the site
  (`https://sensus.sh/docs/<slug>/`); engineering detail lives here. A dev doc with a user page
  carries one line near the top — `User guide: https://sensus.sh/docs/<slug>/` — and links it
  instead of restating behavior the site owns. Site pages never name files, functions, env
  vars, or internal identifiers; the `/docs` index links this knowledge base for contributors.
  When a fact needs both, the dev doc states the mechanism and the site page states the
  behavior.
- **Trust the code over docs.** Verify every claim against `src/` before writing it
  down; if they disagree, the code wins and the doc is fixed.
- **No bare counts or versions.** Anything volatile (tool counts, test counts, package
  versions) must link its source of truth or carry an "as of vX.Y, YYYY-MM-DD"
  qualifier. Bare numbers drift silently.
- **State cross-cutting facts once.** Paths/env/config resolution are canonical in
  `config.md`; color and theme rules in `DESIGN.md`; test rules in `testing.md`;
  lifecycle/build in `operations.md`. Elsewhere, link instead of restating.
- **No code changes.** Docs work never edits `src/` or `tests/` — unless the code is
  genuinely wrong; then fix it in the same commit and say so.
- **Cross-reference instead of duplicating.** If a fact lives in another doc, link it.
- **Mark known anomalies** (dead code, drift, TODOs) explicitly — do not omit them.
- **Keep milestone tags out.** `M6:` / `M9 adds…` are history: docs describe current
  behavior.
