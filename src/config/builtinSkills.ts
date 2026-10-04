/**
 * Built-in skill: "sensus" (docs/skills.md). Ships inside the binary and is
 * materialized into ~/.config/sensus/skills/sensus.md on boot with the same
 * Sensus-owned lifecycle as the built-in agents (docs/agents.md):
 * refreshed on update when unedited, rescued under a new name when edited.
 *
 * The body is the app's self-reference / "README for the model": what Sensus
 * is, where every file lives, the config schema, and concrete examples for
 * adding an MCP server, agent, skill, or memory — so the agent can answer
 * "how do I add MCP?" and change Sensus's own config without the source tree.
 *
 * Size budget: `skill_view` returns the body through the tool boundary, which
 * caps results at `tool_output.max_lines` / `tool_output.max_bytes` (default
 * 2000 lines / 51200 bytes, docs/config.md "tool_output"). Keep the body under
 * those defaults so it is returned whole. Bodies are written with `~~~` code
 * fences so this template literal needs no backtick escaping.
 */

import { builtInMarkdown, type BuiltInFile } from "./builtins.ts"

const SENSUS_SKILL_BODY = `---
name: sensus
description: How Sensus itself works — layout, commands, config paths, MCP/agent/skill/memory setup
---
Sensus is a terminal you live in: a fullscreen TUI that hosts a real, interactive shell
(left pane, a native PTY per tab) beside an AI agent chat sidebar (right pane, per tab).
You ARE that agent. This skill is Sensus's self-reference — what it is, where its files
live, every knob that can be turned, and how to change Sensus from inside this chat. Load
it when the user asks about Sensus itself, or before you edit Sensus's own config, agents,
skills, memory, or MCP servers.

## LAYOUT AND THE TWO SHELLS
- One tab = one native PTY shell + one chat session. The sidebar follows the active tab.
- The left pane is the USER'S real shell. You do not read it directly; each request carries
  a terminal-context block: cwd, shell, git status, and the last ~100 scrollback lines
  (config 'context.scrollbackLines'). '/context off' disables it for the session.
- shell_background runs commands in a HIDDEN shell (per-call bash -lc); the user sees
  nothing. Your default for investigation, side work, and long jobs.
- shell_session types into the USER'S VISIBLE terminal, special keys included. Use it when
  the user asked to watch, said "in my terminal"/"my session", or something needs an
  interactive prompt (sudo, a TUI, an editor).
- Closing the last tab (or Ctrl+A then d) exits Sensus and returns the user to the plain
  shell that launched it. Sensus is a child process, never exec'd; no daemon or socket.

## PATHS
Prefix = ~/.config/sensus (SENSUS_HOME rewrites it; SENSUS_CACHE_DIR and SENSUS_STATE
redirect just the cache/state dirs).
- config.json — the file below (endpoints, mcp, approval, theme, all tuning)
- agents/<name>.md — agent postures (frontmatter + prompt body)
- skills/<slug>/SKILL.md (or skills/<slug>.md) — on-demand procedures; this is a built-in
- memory/MEMORY.md, HOST.md, JOURNAL.md — durable notes (maintained by the memory tool)
- AGENTS.md — extra system-prompt instructions (re-read by /reload)
- ~/.local/share/sensus/sessions/ — per-tab JSONL transcripts
- ~/.local/state/sensus/ — sessions-index.sqlite (search) + tool-output/ (spilled results)
- ~/.cache/sensus/ — models-dev.json + per-server MCP scratch dirs

## CONFIG (config.json)
Precedence: built-in defaults -> config file -> SENSUS_* env -> CLI flags. A missing file
uses defaults; the first persisted setting creates it. Settings writes patch the parsed
document (unknown keys survive), write atomically, and make a one-time config.json.bak.
After a write — or /reload — config is re-resolved live. Unknown keys warn and are ignored.

~~~json
{
  "model": "openai@gpt-5",
  "endpoints": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "provider": "openai-compatible",
      "temperature": 1.0,
      "thinkingMode": "default",
      "models": {
        "gpt-5": { "contextLimit": 400000, "inputLimit": 272000, "reasoning": true, "toolCall": true, "temperatureSupported": false }
      }
    },
    "ollama": { "baseURL": "http://localhost:11434/v1" }
  },
  "agent": "copilot",
  "approval": "confirm",
  "allowPrefixes": ["git ", "ls ", "cat "],
  "permission": [{ "tool": "shell_background", "pattern": "rm *", "action": "ask" }],
  "instructions": ["~/notes/style.md", "docs/*.md", "https://example.com/rules.md"],
  "context": { "scrollbackLines": 100, "enabled": true, "autoCompact": true, "keepTokens": 15000, "bufferTokens": 20000, "contextLimit": 0 },
  "compaction": { "auto": true, "prune": false, "tail_turns": 0, "preserve_recent_tokens": 15000, "reserved": 20000 },
  "chat": { "thinking": "hide", "toolOutput": "collapsed", "animations": true, "cardStyle": "fill", "maxToolTurns": null, "busySend": "steer" },
  "tool_output": { "max_lines": 2000, "max_bytes": 51200 },
  "memory": { "enabled": true, "memoryCharLimit": 2200, "hostCharLimit": 4000, "journalCharLimit": 8000, "writeApproval": false, "redactSecrets": true },
  "titles": { "enabled": true, "model": "" },
  "notifications": { "enabled": true, "mode": "bell", "onFinish": true, "onApproval": true },
  "mcp": { "servers": {} },
  "theme": "terminal",
  "layout": "sidebar",
  "autoChatOnly": true,
  "sidebar": { "width": 50 },
  "tabs": { "width": 24 },
  "keymap": {}
}
~~~

ENDPOINTS AND MODEL
- An endpoint's 'provider' picks the protocol: 'openai-compatible' (the default, the
  OpenAI /chat/completions wire), 'openai-responses' (OpenAI Responses API), 'anthropic',
  'google' (Gemini), or 'mock' (test seam; SENSUS_MOCK=1 forces it). baseURL is OPTIONAL —
  empty uses the protocol's default (api.openai.com/v1 for openai-compatible/
  openai-responses, api.anthropic.com/v1, generativelanguage.googleapis.com/v1beta).
  The Vercel AI SDK owns streaming and tool calling. 'model' is ONE global selection,
  "<endpoint>@<model-id>" (split at the first @).
- /models lists every endpoint's models over its protocol; a pick applies to the current
  session and persists as the default for new sessions (other open tabs keep theirs).
- apiKey lives only in the endpoint (no env fallback). Empty disables chat (status bar
  shows 'chat:no-key'). Editing baseURL/apiKey + /reload rebuilds the cached provider.
- maxTokens (output cap) is OPTIONAL and defaults to auto: the model's advertised output
  limit (models.dev), else the field is omitted so the endpoint picks. Set a number to pin
  it. A reply still cut at the cap now says so in chat instead of stopping silently.
- Per-model overrides ('endpoints.<name>.models') win over models.dev: contextLimit,
  inputLimit (the provider's input-token ceiling — compaction uses
  min(contextLimit, inputLimit)), reasoning, reasoningEfforts, reasoningBudgetMin/Max, toolCall,
  temperatureSupported, vision (vision gates /image, paste attachments, and the view_image tool).
- thinkingMode: "off" | "budget:<n>" | an effort keyword ("low"/"high"/...); absent picks the
  model's HIGHEST advertised setting. /effort overrides it per session; choices mirror models.dev.

ENV OVERRIDES: SENSUS_MODEL, SENSUS_ENDPOINT, SENSUS_BASE_URL,
SENSUS_APPROVAL=confirm|full-auto, SENSUS_STREAM_TIMEOUT_MS (idle stream ms; default
120000, 0 disables), SENSUS_HOME, SENSUS_CACHE_DIR, SENSUS_STATE, SENSUS_COLORTERM,
SENSUS_REDUCED_MOTION, SENSUS_MOCK=1, SENSUS_SKIP=1, SENSUS_MODELS_DEV_URL.

KNOBS THAT MATTER MOST
- context.* — terminal context attached and when auto-compaction fires.
- compaction.* — V2 aliases that override context.* (auto, prune, tail_turns,
  preserve_recent_tokens, reserved). 'prune' rewrites sent bytes and invalidates the
  provider prompt cache; it is never silent.
- tool_output.max_lines / max_bytes — a result over either is spilled to
  state/tool-output/ and returned as a preview + pointer; read the full text back with
  read_file. shell_background and get_scrollback keep the TAIL, everything else the HEAD.
- chat.maxToolTurns — provider round-trips per user message (null = unlimited).
- chat.busySend — "steer" injects a mid-stream message into the running turn; "queue" holds
  it for the next turn. Enter uses the setting, Alt+Enter the other while streaming.
- titles, notifications, layout/tabs/sidebar, keymap.

EDIT IT: write config.json (or the user uses Ctrl+O / the settings screen), then apply with
the 'reload' tool (or the user types /reload). The settings screen and /reload re-resolve
live; a hand-edited 'theme' or 'layout' is restart-only.

## MCP SERVERS
Add servers under 'mcp.servers' in config.json, then reload. Their tools join your toolbox
as mcp__<server>__<tool> and get the same approval cards as commands (never allow-prefixable).

~~~json
{
  "mcp": {
    "servers": {
      "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
      "files": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/projects"],
        "env": { "FOO": "bar" },
        "cwd": "~/scratch"
      },
      "firecrawl": {
        "url": "https://mcp.firecrawl.dev/mcp",
        "headers": { "Authorization": "Bearer \${FIRECRAWL_API_KEY}" }
      },
      "example-disabled": { "url": "https://host/mcp", "enabled": false, "timeout_s": 30 }
    }
  }
}
~~~

RULES
- An entry is exactly ONE transport: stdio ('command' + optional args/env/cwd) OR http
  ('url' + optional headers). Both/neither, or a bad URL, warns and SKIPS that server
  (never blocks boot). Unknown keys warn.
- \${VAR} in env/headers/cwd expands from the environment; a missing var becomes "" with a
  one-time warning — keep API keys in the environment, not the file.
- Optional per server: enabled (default true), timeout_s (default 60, max 600), and for
  stdio cwd (a relative path resolves under the config dir; the default is a scratch dir
  under ~/.cache/sensus/mcp/<server>/ that is never Sensus's own cwd).
- Connections are lazy: nothing spawns at boot; at the start of a generation Sensus connects
  enabled servers in parallel (initialize -> initialized -> tools/list) and caches specs.
  A failing server just loses its tools (toast + one system note), retried with backoff.
- /mcp lists each server with status (idle/starting/connected/failed/disabled); /mcp off
  disables MCP for the session. On exit stdio children are killed by process group and HTTP
  sessions DELETEd — no orphan npx.

## AGENTS
An agent is a markdown file in agents/ that sets the agent's posture. Switching agents is
per-session with a persisted default ('agent' in config.json).

~~~markdown
---
name: reviewer
description: Reviews changes and never edits files
tools: ["read_file", "shell_background", "get_scrollback", "session_search"]
skills: ["*"]
sudoPrompt: ask
shell: background
---
You are operating as REVIEWER: inspect, do not modify. ...
~~~

FRONTMATTER FIELDS
- name — selection name (default: file stem); first definition wins.
- description — one line in the picker and /status.
- tools — allowed core/MCP tool names; absent, empty, or ["*"] = all. A list can only
  SUBTRACT from what is available, never add.
- skills — allowed skill names; ["*"] / absent / empty = all.
- sudoPrompt — ask (tell the user) | popup (prompt + retry) | auto (popup in full-auto, ask
  in confirm); default ask.
- shell — auto | session | background: the default shell posture placed in the prompt
  (session prefers the user's visible terminal).
- readonly — true | false (default false). true makes the agent read-only: the execution
  layer hard-denies edit_file, write_file, memory, shell_session, MCP tools, and any
  mutating shell command (redirects, rm/mv/cp/chmod, package managers, service/container
  control, sudo, git write subcommands, …), whatever the tools list says and whatever the
  model tries. It cannot be overridden by permission rules, session trust, or an approval
  policy. Reads (read_file, git status, ls, grep, …) still work.
- Unknown keys warn and are ignored.

Built-ins: 'copilot' (the general guide; materialized on boot, Sensus-owned) and 'scout'
(readonly: true — a read-only researcher). Copilot adapts to the approval mode: session-first
and step-by-step in confirm, autonomous and background-first in full-auto.
Built-in files are refreshed on update; an edited built-in is rescued as
<stem>.modified-<time>.md with a unique name — copy a built-in to a new name to customize.
/agent <name>, Alt+M, or the picker switches the session and persists the default.

## SKILLS
A skill is an on-demand procedure the model loads through skill_view. Only each skill's name
+ description sit in the system prompt; the body is fetched when relevant. Yours is this file.

~~~markdown
---
name: deploy
description: Ship this app safely
---
1. run the tests
2. build
3. deploy and verify
~~~

Location: skills/<slug>/SKILL.md, or a flat skills/<name>.md. /skills opens the read-only
manager; /skill <name> loads a body into the current chat; /learn <slug> has the agent draft
a new skill from the current conversation; /reload re-reads the directory. An agent's
'skills' frontmatter limits which skills it sees. Built-in skills follow the same
refresh/rescue lifecycle as built-in agents.

## MEMORY
Three plain-markdown stores under memory/, maintained with the 'memory' tool
(action: list|read|add|replace|remove|rewrite; target: memory|host|journal):
- MEMORY.md (cap 2200 chars) — environment facts, conventions, lessons. ALWAYS injected; a
  frozen snapshot is taken at session start (writes land on disk now, appear next session).
- HOST.md (cap 4000, never injected) — the machine/server map. /map runs a read-only
  host_scan and drafts it; the tool reads and edits it.
- JOURNAL.md (cap 8000, never injected, ring-trimmed) — the episodic log of what you did.
MEMORY/HOST are hard caps: an over-limit write returns an error and never truncates — call
'memory' with action "rewrite" (memory/host only) to replace the whole store with a condensed body. Writes
gate in confirm mode like every tool; in full-auto they auto-run unless memory.writeApproval is
true. Secrets/credentials and instruction-override
text are refused when memory.redactSecrets is true. /memory opens the manager.

## TOOLS
Core: shell_background, shell_session, read_file, edit_file, write_file, get_scrollback,
view_image, ask_user, memory, host_scan, session_search, session_list, session_view,
skills_list, skill_view, reload. Plus mcp__<server>__<tool> for every connected MCP tool.
- get_scrollback returns the user's recent terminal output — use it to see the result of
  something you typed with shell_session.
- ask_user blocks on a question with options — reserve it for genuine forks, not per-step
  sign-off. view_image needs a vision-capable model.
- An OpenAI-compatible endpoint that rejects tools degrades to plain chat with per-line
  click-to-paste code blocks; Responses/Anthropic/Gemini surface the error instead.

## APPROVALS AND PERMISSIONS
- confirm (default): EVERY tool call shows an inline card — y accept, n reject — reads
  (read_file, get_scrollback, session history, view_image), writes, shell commands, memory,
  and MCP included. Two exceptions: ask_user renders the question itself, and shell_session
  may TYPE into the pane freely — but pressing Enter to RUN the line is always a card, so
  nothing executes in the user's terminal unapproved. Nothing runs without a card unless the
  user allowed it (session trust, the saved allowPrefixes list, or a permission rule). For a
  shell command you can press 'a' to
  grant session-scoped trust for the OPERATION CLASS (e.g. 'git status*', 'systemctl status*') —
  the grant lives in this process only (dies with the tab), shows as a 'trust:' status-bar chip
  you can click to revoke, and is never offered for destructive patterns. Rejections are reported
  back to you.
- approval batches: when ONE of your turns issues several gated calls at once, they render as a
  single plan card (an ordered list with a per-line approve/deny control, plus approve-all /
  deny-all / confirm) so the user approves the task, not N opaque commands. A destructive line is
  never covered by approve-all — it needs explicit per-line approval or it is rejected.
- full-auto (/yolo, Alt+Y, --yolo): everything auto-runs except destructive commands
  (root-level rm/mv/chmod, device writes, power commands), which still gate.
- allowPrefixes: persistent command prefixes that always skip the confirm gate. Session trust
  ('a') is separate and in-memory — it is never written to config.
- permission: an ordered list of { tool, pattern?, action } rules (action allow|ask|deny).
  The LAST matching rule wins; a 'deny' is terminal (the tool never runs, even in full-auto).
  'pattern' is a glob matched against the shell command, the shell_session text, or the
  target path. Example:
~~~json
{
  "permission": [
    { "tool": "read_file", "pattern": "src/*", "action": "allow" },
    { "tool": "shell_background", "pattern": "rm *", "action": "ask" },
    { "tool": "mcp__firecrawl__*", "action": "deny" }
  ]
}
~~~
- sudo: when a hidden-shell command needs a password, sudoPrompt decides. 'popup' asks the
  user and retries; 'ask' returns guidance; 'auto' follows the mode. Never type a password
  yourself and never probe with 'sudo -n'.

## SESSIONS
Each tab appends a JSONL transcript under ~/.local/share/sensus/sessions/. --resume reopens
one, /sessions searches across them, /usage shows tokens + cache-hit rate, and
'sensus --export <file>' prints one as markdown. Sessions get auto titles, tags, rewind,
and the search index lives at ~/.local/state/sensus/sessions-index.sqlite.

## COMMANDS (type in the chat input)
/help /status /clear /compact /ctx /find <text> /edit /retry /undo /audit [n]
/model [endpoint@id] /models /agent [name] /yolo [off] /thinking /effort /details /cards
/context on|off /memory /remember <fact> /map /pin /unpin /skills /skill <name> /learn <slug>
/sessions [query] /usage /keys /image <path>|clear /mcp [on|off] /theme [name] /settings
/reload /sudo forget /init-wizard

## KEYS
Ctrl+A then d quit · Shift+Tab terminal<->chat · Alt+A focus chat input · Ctrl+T / Ctrl+W
new/close tab (closing detaches: the shell and any running turn keep going in the daemon
and re-attach on the next boot; type exit in the pane to end that shell) · Alt+1..9,
Alt+Left/Right tabs · Esc abort generation · Enter send /
Alt+Enter newline · y / n / a approval · 1..9 ask_user option · Ctrl+C or Ctrl+Shift+C copy ·
Alt+, / Alt+. shrink/grow chat · Alt+Home chat-only view (hide terminal) · Ctrl+O settings ·
Ctrl+P command palette · Alt+M agent ·
Alt+Y approval · Alt+T thinking · Alt+E tool details · Alt+C card style · Alt+B copy
message · Alt+R revert turn · Alt+S send code block · Ctrl+Shift+V / Alt+V paste image/text.
Remap with /keys or the 'keymap' config key.

## CLI
sensus [flags] · sensus init [--create-config] · --model <endpoint@id> · --endpoint <name>
· --base-url <url> · --resume · --yolo · --sidebar-width <cols> · --export <file> ·
--help · --version. A first run (no config, or an untouched default) opens the setup wizard
in-app; /init-wizard or Ctrl+P → Setup wizard reopens it, and "sensus init" just boots with it open.
init --create-config scaffolds headlessly. Sensus refuses to nest inside itself unless
SENSUS_SKIP=1.

## CHANGING SENSUS FROM HERE
You can edit Sensus's own files with write_file/edit_file and then call the 'reload' tool
(the same path as /reload) to apply config.json, AGENTS.md, agents/, skills/, and changed
MCP servers. The user sees a toast. Do not edit a built-in (copilot.md or this skill) in
place — copy it to a new name and edit the copy. When the user asks "how do I add MCP /
agent / skill?", answer with the concrete edit above and offer to make it.

## TROUBLESHOOTING
- status bar 'chat:no-key' — set the selected endpoint's apiKey.
- 'terminal too small' — Sensus needs at least 20x5.
- a result says "output was truncated" — read the spilled full text with read_file at the
  path it names (or grep it via shell_background).
- MCP tools missing — /mcp shows why; a failed server retries with backoff.
- Sensus will not start inside a Sensus pane (SENSUS_ACTIVE) — that is the nest guard.
`

export const SENSUS_SKILL_MD = builtInMarkdown(SENSUS_SKILL_BODY, "SKILL")

/** Built-in skill files written into ~/.config/sensus/skills/ on boot. */
export const BUILT_IN_SKILLS: BuiltInFile[] = [{ file: "sensus.md", markdown: SENSUS_SKILL_MD }]
