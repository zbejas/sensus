# Configuration

User guide: https://sensus.sh/docs/configuration/

## Overview

Sensus resolves its runtime settings from built-in defaults → the config file → `SENSUS_*`
environment variables → CLI flags. There are no profiles: endpoints hold connection info,
and one global `model` selection (`<endpoint>@<model-id>`) is the default for new sessions.
The settings screen writes the real file. This doc is the canonical home for paths, the
schema, and resolution order.

## Key files

| File | Purpose |
|---|---|
| `src/config/config.ts` + `src/config/config/` | Config layer: `config.ts` is the public barrel over `config/` — schema types, defaults, path helpers, args, MCP parsing, resolution order, active accessors |
| `src/config/configFile.ts` | Settings-screen writes: patch parsed doc → atomic write + `.bak` |
| `src/config/secrets.ts` | Encrypted secrets store (AES-256-GCM), `${NAME}` resolution helpers, migration (see "Secrets" below) |
| `src/config/agents.ts` | Agent definitions (see [`agents.md`](agents.md)) |
| `src/agent/memory/store.ts` | Memory stores (caps, entries, safety, snapshot) — see [`memory.md`](memory.md) |
| `src/config/wizard.ts` | Pure setup-wizard logic (drives the in-app setup modal; see [`operations.md`](operations.md)) |
| `src/agent/provider/modelCatalog.ts` | Model catalog + models.dev enrichment merged with the overrides below |
| `src/theme/themes.ts`, `src/theme/theme.ts`, `src/theme/themePalette.ts`, `src/theme/konsoleScheme.ts` | Built-in theme registry + runtime tokens + palette detection + the KDE scheme reader (see [`DESIGN.md`](DESIGN.md)) |

## Locations

- **Config:** `~/.config/sensus/config.json`. Scaffolded by the in-app setup wizard
  (`sensus init` / `/init-wizard` / a plain first run), `sensus init --create-config`, and
  `scripts/install-release.sh` (never overwritten). A missing
  file silently uses the built-in defaults; the file also appears the first time something
  persists (a settings save, `/theme`, a model/agent pick). Writes patch the parsed
  document, so unknown keys survive.
- **Agents:** `~/.config/sensus/agents/*.md` ([`agents.md`](agents.md)).
- **Skills:** `~/.config/sensus/skills/` — user skills plus the built-in `sensus` skill,
  materialized on boot ([`skills.md`](skills.md)).
- **Memory:** `~/.config/sensus/memory/` — created empty on boot; the `memory` tool maintains
  the notes ([`memory.md`](memory.md)).
- **Custom instructions:** `~/.config/sensus/AGENTS.md` — plus any extra sources listed in
  the config `instructions` list ([`agent.md`](agent.md) "System prompt").
- **Sessions:** `~/.local/share/sensus/sessions/<instance-id>/<tab-n>.jsonl`.
- **Instance identity:** `~/.config/sensus/instance.json` — the daemon-owned machine
  identity (`instanceId`, `createdAt`, `version`), stable across restarts/upgrades
  ([`events.md`](events.md)).
- **Event log:** `~/.local/share/sensus/events.jsonl` — event schema v1 NDJSON, written by
  the daemon's `JsonlEventSink` (rotates to `events.jsonl.1` at the byte cap;
  [`events.md`](events.md)).
- **Trigger log:** `~/.local/share/sensus/triggers.jsonl` — one record per matched condition
  trigger, written by the daemon's `TriggerEngine` (rotates to `triggers.jsonl.1`;
  [`triggers.md`](triggers.md)).
- **Session search index:** `~/.local/state/sensus/sessions-index.sqlite`.
- **Tool-output spill:** `~/.local/state/sensus/tool-output/` — the full text of tool
  results that exceeded the `tool_output` limits (`SENSUS_STATE`/`SENSUS_HOME` redirect
  it, which keeps tests sandboxed). Best-effort; spill files older than 7 days are
  cleaned up lazily. See [`agent.md`](agent.md) "Context management & compaction".
- **Model catalog cache:** `~/.cache/sensus/models-dev.json` (24h TTL; warmed at boot).
- **Secrets:** `~/.config/sensus/secrets.json` (encrypted) + `~/.config/sensus/.secrets-key`
  (the 0600 master key). `config.json` references them with `${NAME}` — see "Secrets" below.
- **Runtime:** `$SENSUS_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/sensus-<uid>` → `/tmp/sensus-<uid>`
  (`sensusRuntimeDir()`, `src/config/config/paths.ts`). The daemon (`sensus daemon
  serve`) keeps `daemon.sock` (UDS), `daemon.token` (0600 bearer), `daemon.pid` and
  `daemon.log` here (D7; [`daemon-api.md`](daemon-api.md)). The dir is `0700`; the
  socket/token/pid are `0600`. The TUI does not read it.
- **Test/CI overrides:** `SENSUS_HOME` redirects all of the above; `SENSUS_CACHE_DIR`
  redirects just the cache; `SENSUS_STATE` redirects just the state dir (the search index).
  `SENSUS_MODELS_DEV_URL` overrides the models.dev index URL.
- **File permissions:** `config.json`, the secrets store + key, session transcripts, and their
  metadata sidecars are written mode `0600` with parent directories `0700` (the store holds
  API keys; transcripts hold command output). An existing file/dir is best-effort tightened on
  the next write.

The full path each of these resolves to is implemented in `src/config/config.ts`
(`sensusHome`, `sensusDataDir`, `sensusStateDir`, `configPath`, `agentsDir`, …).

## File schema

```json
{
  "model": "openai@gpt-5",
  "endpoints": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "provider": "openai-compatible",
      "temperature": 1.0,
      "thinkingMode": "high",
      "models": {
        "gpt-5": {
          "contextLimit": 400000,
          "inputLimit": 272000,
          "reasoning": true,
          "reasoningEfforts": ["low", "medium", "high"],
          "toolCall": true,
          "temperatureSupported": false
        }
      }
    },
    "ollama": { "baseURL": "http://localhost:11434/v1" }
  },
  "agent": "copilot",
  "approval": "confirm",
  "allowPrefixes": ["git ", "ls ", "cat "],
  "permission": [{ "tool": "shell_background", "pattern": "rm *", "action": "ask" }],
  "instructions": ["~/notes/style.md", "docs/*.md", "https://example.com/rules.md"],
  "context": {
    "scrollbackLines": 100,
    "enabled": true,
    "autoCompact": true,
    "keepTokens": 15000,
    "bufferTokens": 20000,
    "contextLimit": 0
  },
  "compaction": { "auto": true, "prune": false, "tail_turns": 0, "preserve_recent_tokens": 15000, "reserved": 20000 },
  "chat": { "thinking": "hide", "toolOutput": "collapsed", "animations": true, "cardStyle": "fill", "maxToolTurns": null, "busySend": "steer" },
  "titles": { "enabled": true, "model": "" },
  "mcp": { "servers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } },
  "sidebar": { "width": 50 },
  "layout": "sidebar",
  "autoChatOnly": true,
  "daemonPersistent": false,
  "triggers": [{ "on": "error.raised" }],
  "tabs": { "width": 24 },
  "keymap": {},
  "theme": "terminal"
}
```

## Endpoints and the selected model

The config carries ENDPOINTS (provider targets — one of the protocols below, or the mock
seam) and ONE global selection: `"model": "<endpoint>@<model-id>"` (split at the FIRST
`@` — endpoint names must not contain `@`, model ids may).

- `/models` (or the status-bar model chip) opens the picker: it fetches every endpoint's
  model list **over its protocol** in parallel — openai-compatible/openai-responses
  `GET {baseURL}/models` with `Authorization: Bearer`; Anthropic
  `/models?limit=1000` with `x-api-key` + `anthropic-version`; Gemini
  `/models?pageSize=1000` with `x-goog-api-key` and the `models/` id prefix stripped. It
  groups rows under `endpoint · model-id`, and Enter
  applies the pick to the CURRENT session and persists it as the default for new
  sessions/relaunches. Model selection is per-session and latched when the session is
  created: other already-open tabs keep what they were using, and a config-default change
  (a pick elsewhere, a settings write, `/reload`) reaches NEW sessions only — an open
  session changes its model only via the picker or `/model`. Typing `ollama@` scopes the
  filter to one endpoint. Metadata precedence is
  **config override > endpoint /models (Anthropic capabilities, Gemini limits) >
  models.dev** (see "Model metadata overrides"); models.dev matching is pinned to the
  protocol's provider so an id shared across providers resolves to the right one.
- `/model <endpoint>@<id>` (or a bare `<id>` for the current endpoint) does the same.
  `--model` / `SENSUS_MODEL` accept the same two shapes; `--endpoint` / `SENSUS_ENDPOINT`
  switch just the endpoint part.
- Endpoint fields: `baseURL` (**optional** — empty/missing resolves to the protocol's
  default: `https://api.openai.com/v1` for openai-compatible/openai-responses,
  `https://api.anthropic.com/v1` for anthropic, and
  `https://generativelanguage.googleapis.com/v1beta` for google; an explicit URL is
  validated at boot — a bad one opens the setup modal to fix it), `apiKey` (empty disables
  chat), `provider` — one of `"openai-compatible"` (the default; the legacy value
  `"http"` means the same), `"openai-responses"` (OpenAI Responses API),
  `"anthropic"`, `"google"` (Gemini), or `"mock"` (canned replies; `SENSUS_MOCK=1`
  forces the mock) — plus `temperature` + `maxTokens` (request knobs), `thinkingMode`,
  and `models`.
- `maxTokens` is the output cap sent as `maxOutputTokens`, and it is **optional**:
  - **omitted (default) = auto**: use the model's advertised output limit (models.dev
    `limit.output`, or an endpoint `models.<id>` override); when that is unknown too, the
    field is OMITTED entirely so the endpoint applies its own default. Users are never
    silently capped below what their model can emit — the old 8192 default cut long
    reasoning replies off mid-answer.
  - an explicit number always wins (set `8192` to pin it, including deliberately).
  - affects the compaction reserve (below) and the truncation note shown when a reply
    still hits the cap.
- API keys should be `${NAME}` references resolved from the encrypted secrets store (falling
  back to the process env) — see "Secrets" below. A literal key still works for compatibility
  but is plaintext in the file; `sensus secrets migrate` moves it out. Editing `baseURL` or
  `apiKey` and running `/reload` rebuilds the cached provider client; the corrected credential
  is used on the next request. The setup wizard and settings screen route a typed key into the
  store automatically, so a newly entered key is never written in the clear.

## Secrets

API keys never belong in `config.json`. Sensus stores them encrypted and references
them with a `${NAME}` token — the same syntax MCP `env`/`headers` use:

```json
{
  "endpoints": { "main": { "baseURL": "https://api.openai.com/v1", "apiKey": "${OPENAI_API_KEY}" } },
  "mcp": { "servers": { "firecrawl": { "url": "https://mcp.firecrawl.dev/mcp", "headers": { "Authorization": "Bearer ${FIRECRAWL_API_KEY}" } } } }
}
```

- **Store.** `~/.config/sensus/secrets.json` is a JSON map encrypted at rest with
  AES-256-GCM. The 256-bit master key is `~/.config/sensus/.secrets-key` (0600); it is
  generated on the first write so the TUI decrypts without a passphrase. Both files are
  owner-only. A hand-written plaintext store is accepted and flagged (the next
  `sensus secrets migrate` encrypts it).
- **Resolution.** `${NAME}` resolves from the secrets store first, then the process
  environment. An unset name expands to `""` with one warning (an endpoint with an empty
  key is just "chat disabled"). A literal `apiKey` is passed through unchanged for
  compatibility.
- **Where refs work.** `endpoints.<name>.apiKey` and every MCP `env`/`headers` value (and
  `cwd`, docs/mcp.md). Any `${NAME}` token inside a larger string expands too
  (`"Bearer ${TOKEN}"`).
- **CLI.** `sensus secrets list`, `sensus secrets set <NAME> <value>`,
  `sensus secrets rm <NAME>`, and `sensus secrets migrate` (moves every plaintext key in
  `config.json` into the store and rewrites the file with refs + a `.bak`). Headless, no
  TUI. Set a value through a variable to keep it out of shell history where that matters.
- **Never clobbers.** If the store is unreadable (wrong/corrupt key, bad JSON) every write
  path refuses rather than overwrite the ciphertext; the affected keys just resolve empty.

The threat model is a stray copy of `config.json` (backup, paste, sync): the file is
cipher-free, and only the store + key pair reproduce a value. A local attacker who can read
both files is out of scope — the key must be readable without user input at boot, the same
trade-off as the session sudo vault ([`agent.md`](agent.md) "Sudo"). Display redaction is
separate and always on (`memory.redactSecrets`).

## Model metadata overrides (`endpoints.<name>.models`)

Optional per-model metadata that wins per-field over both the endpoint's own `/models`
report (Anthropic `capabilities`, Gemini limits — merged over models.dev) and the
models.dev enrichment. The full precedence is
**config override > endpoint /models > models.dev**; anything all three leave null stays
unknown:

- `contextLimit` — context window in tokens.
- `inputLimit` — the provider's input-token ceiling (models.dev `limit.input`; e.g. gpt-5
  reports 272000 beside a 400000 context window). The API rejects a prompt over it, so
  compaction treats `min(contextLimit, inputLimit)` as the effective ceiling — an explicit
  `context.contextLimit` is capped too. `0`/absent = unknown.
- `reasoning` — boolean, the model is a reasoner.
- `reasoningEfforts` — replaces the advertised effort keywords (drives the `think:` chip
  vocabulary and `/effort`).
- `reasoningBudgetMin` / `reasoningBudgetMax` — Anthropic-style `budget_tokens` range.
- `toolCall` — boolean tool-call support.
- `temperatureSupported` — `false` omits the request temperature.
- `vision` — boolean, the model accepts image input. Drives whether `/image` / paste
  attachments are allowed and whether the `view_image` tool is offered
  ([`agent.md`](agent.md) "Images"). Overrides models.dev `modalities.input` (the
  `attachment` flag is the fallback).

This is how you correct wrong models.dev data or describe private models the index does not
know. The settings screen edits it as one JSON field per endpoint; `/reload` applies hand
edits.

## `thinkingMode`

The endpoint-level default for reasoning models ([`agent.md`](agent.md) "Thinking modes"):

- absent (or `"default"`) — the model's **highest** advertised setting (top effort,
  `budget:<max>`, or reasoning on for a toggle); nothing when the model advertises no knob.
- `"off"` — the model's LOWEST advertised effort (`none`/`minimal`), or the reasoning-off
  toggle for a toggle-only model.
- `"budget:<n>"` — a token budget sent as the unified `reasoning: {max_tokens}` field
  (clamped to the advertised min/max).
- an effort keyword — `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, … sent
  as OpenAI-style `reasoning_effort`.

The knob is **protocol-aware** ([`agent.md`](agent.md) "Thinking modes"): unified effort
keywords ride the AI SDK's top-level `reasoning`, a `budget:<n>` maps to Anthropic's
`thinking.budget_tokens` / Gemini's `thinkingBudget` and is approximated to an effort for
the OpenAI Responses API, and the legacy OpenAI-compatible body fields are unchanged
(`agent/provider/protocols.ts`).

`/effort` overrides it per session (the status-bar `think:` chip cycles the metadata's
advertised choices). Invalid values warn once and are ignored.

## `agent` and `allowPrefixes`

- `agent` (default `"copilot"`): the DEFAULT agent for NEW sessions, a name from
  `~/.config/sensus/agents/` ([`agents.md`](agents.md)). The picker (`Alt+M`, the status-bar
  `agent:` chip, `/agent`) and `/agent <name>` apply their pick to the current session and
  persist it here; the sidebar `agent:<name> ⇄` chip cycles through the agents with the
  same semantics, and other open tabs are untouched.
- `allowPrefixes` (default `[]`): the PERSISTENT always-allow command prefix list —
  `shell_background` commands starting with one skip the confirm-mode gate. Edited in the
  settings screen (comma-separated; entries gain a trailing space on save) or by hand. The
  offered prefix is **arity-aware** (`agent/tools/summary.ts` `commandPrefix`):
  `git status --short` offers `git status `,
  `npm run test` offers `npm run test `, `git commit -m x` offers `git commit `,
  `rm -rf /` offers `rm `; unknown commands fall back to their first token. This list is
  written to config and survives restarts.
  The session-scoped `"a"` trust on a card (docs/agent.md "Approval modes") is a SEPARATE,
  **in-memory only** registry: it names the same arity-aware operation class but is never
  persisted (no file to clean up) and is refused for destructive/irreversible classes.
  Allow-prefixes and session trust apply only when no `permission` rule matched (see below),
  and neither can un-gate a destructive command.

## `permission`

Ordered rule-based permissions. Each entry is
a rule object:

| Key | Required | Meaning |
|---|---|---|
| `tool` | yes | a tool name (`shell_background`, `edit_file`, `read_file`, `write_file`, `view_image`, `mcp__*`, …) or `"*"` for any |
| `pattern` | no | a glob (`*` = any run, `?` = one char) matched against the shell command (`shell_background`), the typed text (`shell_session`), or the target path (`edit_file`/`write_file`/`read_file`/`view_image`); absent/omitted = match any |
| `action` | yes | `"allow"` (skip the gate), `"ask"` (gate behind an approval card), or `"deny"` (never execute) |

```json
{
  "permission": [
    { "tool": "read_file", "pattern": "src/*", "action": "allow" },
    { "tool": "shell_background", "pattern": "git status*", "action": "allow" },
    { "tool": "shell_background", "pattern": "rm *", "action": "ask" },
    { "tool": "mcp__firecrawl__*", "action": "deny" }
  ]
}
```

Precedence:

0. **Read-only guard** (docs/agents.md `readonly`): when the active agent is `readonly`, a
   mutating call is terminally denied before anything below is evaluated, so no rule,
   prefix, trust or policy can allow it.
1. **Baseline** from the approval mode and tool, exactly as without rules: `confirm` gates
   every call except `ask_user` (which renders its question inline) and `shell_session`
   typing (nothing executes until a submission, which gates); full-auto allows everything
   except destructive shell commands. Session trust sits inside this baseline (after the
   destructive floor).
2. **Rules in order.** The **last matching rule wins** and replaces the baseline action.
3. **Allow-prefixes and session trust** apply only when no rule matched.
4. A winning `"deny"` is **terminal**: the tool never executes, even in full-auto, and no
   approval card is shown — the model receives `Denied by permission policy: <tool>`. This is
   plain last-match-wins: a later `allow` CAN override an earlier `deny` (no deny-domination).
   A `"deny"` cannot be waived by a session allow-prefix or trust.

A destructive command (both shells) is never un-gated by a rule — `allow`/`ask` rules leave
the destructive gate standing (the only terminal action is `deny`). Session trust likewise
never un-gates a destructive/irreversible class (docs/agent.md "Approval modes").

Invalid entries warn and are skipped: a non-object entry, a missing/empty `tool`, or an
`action` other than `allow`/`ask`/`deny`. Unknown rule keys warn but keep the rule; an empty
`pattern` warns and is treated as absent. Config-file-only.

## `instructions`

Extra instruction sources merged with the global `~/.config/sensus/AGENTS.md` into the
system prompt. An array of strings; each
entry is one of:

| Entry | Resolution |
|---|---|
| absolute path | used as-is (only if it is an existing file) |
| `~/…` | `~` expands to the OS home |
| glob (`*`, `**`, `?`, `[]`, `{}`) | `Bun.Glob` expansion, sorted and de-duplicated; relative patterns try the launch cwd, then the config dir |
| relative path | resolved against the launch cwd, falling back to the config dir (`~/.config/sensus`) |
| `http(s)://…` | fetched best-effort (4s timeout, failures ignored) |

```json
{
  "instructions": ["~/notes/style.md", "docs/*.md", "https://example.com/rules.md"]
}
```

Resolution is once per process / `/reload` (`ChatHost` caches the combined text and hands it
to sessions through the `getInstructions` dep, so the synchronous system-prompt build never
does I/O for URLs). Local files are read synchronously; URL bodies land when their fetch
completes (guarded so a slow fetch cannot clobber a newer `/reload`). Missing files, empty
files and unreachable URLs are ignored — never fatal. Non-string/empty entries warn and are
dropped; a non-array value warns and is ignored. Config-file-only.

## `theme` and `themePalette`

`theme` names one of the built-in themes; `THEME_NAMES` in `src/theme/themes.ts` is the
canonical registry and display order. It ships the adaptive default `terminal` (no painted
backgrounds), `dark`, `light`, and a large curated set: `solarized-dark`/`solarized-light`,
`gruvbox-dark`, `nord`, `dracula`, `catppuccin-mocha`/`catppuccin-macchiato`/
`catppuccin-frappe`/`catppuccin-latte`, `tokyo-night`, `one-dark`/`one-light`, `monokai`,
`rose-pine`/`rose-pine-moon`/`rose-pine-dawn`, `everforest-dark`/`everforest-light`,
`kanagawa`, `ayu-dark`/`ayu-mirage`/`ayu-light`, `night-owl`, `palenight`, `material`,
`github-dark`/`github-light`, `cobalt2`, `horizon`, `zenburn`, `iceberg-dark`,
`synthwave-84`, `spacegray`, `oceanic-next`, `papercolor-light`. Unknown names fall back to
`terminal` with a one-time warning. Switch live via `/theme` (opens the searchable picker
with live preview), `/theme <name>` (exact or unique partial match), the settings screen
(`Ctrl+O` → Appearance → theme → the picker), or edit the file and `/reload`. The switch is
persisted immediately; `/reload` does NOT apply a file-edited theme to the live UI (the
theme signal is read at boot and via `/theme`/the settings screen only).

Adding a theme is two edits in `src/theme/themes.ts`: append its name to `THEME_NAMES` and
add its definition to `THEME_DEFS` (the `Record<ThemeName, …>` annotation makes the compiler
demand the second). `borderFocused`, `toast`, `barFg`, `onSelection` and `scrollbar` default
from `accent`/`warning`/`fg`/`border`, so only the colors a theme genuinely distinguishes
need spelling out. Secondary text (`muted`) is raised to a WCAG 4.5:1 floor against the
theme's `bg` when the theme resolves (`readableMuted`), so reasoning/tool bodies, labels and
hints stay legible no matter what "comment grey" the published palette shipped.

The default `terminal` theme blends into the terminal's own palette: neutral tokens are
palette indices the host resolves, chromatic accents keep the terminal's hue family (softened
when OSC 10/11 answered). The pane itself is rendered by the embedded VT, which ignores the
host palette and defaults to black, so sensus rewrites indexed pane SGR to truecolor from the
detected/override palette and re-applies the theme default fg on resets (the default bg is
painted by `PanePainter`, see
[`DESIGN.md`](DESIGN.md) "Pane color fidelity"); `themePalette` tunes both the sidebar/chrome
tokens and that pane rewrite. The full behavior and invariants are canonical in
[`DESIGN.md`](DESIGN.md); the `themePalette` keys below are OPTIONAL tuning, never required
for correct colors. The settings screen (`Ctrl+O` → Appearance → `Advanced…`) exposes the color overrides
directly; `paneColors`/`boldBright` are config-file keys.

```json
{
  "themePalette": {
    "foreground": "#ebdbb2",
    "background": "#282828",
    "colorMode": "auto",
    "palette": ["#282828", "#cc241d"],
    "paneColors": "exact",
    "boldBright": true
  }
}
```

- `foreground` / `background`: override the OSC 10/11 default colors (theme text color and
  the light/dark reference) for terminals that answer wrongly or not at all. `foreground` also
  sets the pane's **default fg** (re-applied on resets); `background` is painted into the pane
  frame by `PanePainter`, so the pane background follows the theme instead of the embedded VT's
  black.
- `palette`: up to 256 color strings (`#rgb`, `#rrggbb`, `rgb:r/g/b`); entry `i` overrides
  palette index `i` in the `/status` readout, the bright-vs-normal contrast picks, and the
  pane SGR rewrite.
- `paneColors` (`"exact"` | `"index"`, default `"exact"`): pane fidelity mode. `"exact"`
  rewrites indexed pane SGR to truecolor from the detected/override palette so the pane
  follows the terminal theme; `"index"` disables the indexed rewrite and passes indices to
  the embedded VT's built-in palette (the default fg re-application and the painted default bg
  still apply).
- `boldBright` (boolean, default `true`): promote a bold basic foreground 0-7 to the bright
  entry (index + 8) in the rewrite; suppressed by dim, foreground only.
- `colorMode` (`"auto"` | `"truecolor"` | `"ansi256"`, default `"auto"`): the renderer's
  color space. OpenTUI's native renderer decides ONCE around library load whether the
  terminal is truecolor, keying off `COLORTERM`/`TERM`, with two failure modes when it
  cannot confirm truecolor: thinking **256-color**, it **quantizes every RGB color** (theme
  RGB chrome and any truecolor content) to a lossy `38;5;N` (`#bf616a` → `38;5;131`);
  thinking **low-color**, it emits a **fixed VGA-snapshot RGB** for indexed colors (`index 1`
  → `38;2;128;0;0`) instead of legacy SGR, so every basic shell color is wrong in every
  terminal. SSH (and some multiplexers) strip `COLORTERM`, so a 24-bit terminal silently
  degrades. SSH also makes OpenTUI treat the session as a remote renderer and skip
  `COLORTERM`/`TERM` handling outright, so the renderer runs with `remote: false` (correct
  for a UI painting the real terminal) — otherwise no forced mode reaches the native layer.
  `auto` therefore forces truecolor for **any** `TERM` not in the low-color
  deny-list (`src/core/colorMode.ts` `LOW_COLOR_TERMS`: `dumb`, `linux`, `vt100`/`vt101`/
  `vt102`/`vt220`/`vt320`/`vt52`, `ansi`, `sun`, `hpterm`, `pcansi`, `nsterm-16color`,
  `eterm-color`, …; an empty `TERM` is not low-color), while still honoring `NO_COLOR` and a
  `COLORTERM` OpenTUI actually understands (`truecolor`/`24bit`) by leaving its own detection
  alone. An unrecognized `COLORTERM` (notably `256color`, which some terminals set) does NOT
  opt out — OpenTUI would snapshot indexed colors for it too, so the force applies.
  `"truecolor"`/`"ansi256"` (config or `SENSUS_COLORTERM`) force the mode.
  **Restart-only** (the decision is made before the renderer loads; `/reload` cannot change
  it) — the effective mode is shown in `/status` as `color: <detected> (<mode>)`; a
  `color: none` (with its one-time warning toast) is the symptom of a genuinely low-color
  terminal. Full mechanism: [`DESIGN.md`](DESIGN.md) "Renderer color space".

Config wins per entry over whatever the terminal answered; invalid values warn once and fall
back to detection. Applied at boot, on every palette event, and live on `/reload`.

Konsole and Yakuake are a special case: their OSC 4 reporter answers with a compiled-in,
saturated default table rather than the active color scheme. Sensus fingerprints that exact
0-15 row and resolves the active scheme, merging it over the detection so the pane and
adaptive chrome match the terminal; `/status` shows `source: KDE scheme "<name>"`. The
profile is found via the legacy `KONSOLE_PROFILE_NAME`, else the session's D-Bus profile
(`KONSOLE_DBUS_SERVICE` + `KONSOLE_DBUS_SESSION` → `org.kde.konsole.Session.profile()`;
modern Konsole no longer exports the env var), else `konsolerc`
`[Desktop Entry] DefaultProfile`. If none resolve, the scheme is fingerprinted from the
truthful OSC 10/11 fg/bg against the installed `*.colorscheme` files. If that also fails it
leaves the lying row as indices (the pane falls back to the embedded VT palette, matching
the no-detection/SSH look) and `/status` — plus a one-time boot toast — suggests the
`palette` pin and names the failing lookup step (`source: KDE scheme lookup: <reason>`). A
`palette` pin always wins. See [`DESIGN.md`](DESIGN.md) "Pane color fidelity".

## `context`

Context injection and compaction are specified in
[`agent.md`](agent.md) "Context injection" / "Context management & compaction".

- `scrollbackLines` (default 100): terminal tail lines carried in the per-request context
  block.
- `enabled` (default true): master switch; `/context on|off` overrides per session.
- `autoCompact` (default true): preflight compaction near the context limit.
- `keepTokens` (default 15000): recent tokens kept verbatim beside a checkpoint.
- `bufferTokens` (default 20000): safety reserve — compaction triggers at
  `estimate >= effectiveLimit - max(min(resolved maxTokens, 32k), bufferTokens)`, where
  `resolved maxTokens` is the endpoint's explicit value → the model's advertised output
  limit → unknown (0, so only the buffer reserves), and `effectiveLimit` is
  `min(contextLimit, the model's advertised input-token ceiling when one is known)` — the
  API rejects a prompt over the input cap even inside a larger context window, and the
  compaction summary request must fit under it too.
- `contextLimit` (default `0` = unlimited/auto): a positive value pins the model's context
  limit (still capped by the model's input ceiling — see the per-model `inputLimit` override);
  `0` resolves the metadata (config override → models.dev → 128k fallback) — see
  [`agent.md`](agent.md) "Context management & compaction".

## `compaction`

Compaction tuning keys
([`agent.md`](agent.md) "Context management & compaction"). `context.*` is parsed first;
every key below **overrides** the matching `context.*` value when present, so the two
sections can be mixed freely. Only `prune` and `tail_turns` are genuinely new — the aliases
resolve into `context` at load time (single runtime source of truth).

| Key | Default | Alias / meaning |
|---|---|---|
| `auto` | `true` | overrides `context.autoCompact` — preflight compaction near the limit |
| `prune` | `false` | optional cache-invalidating prune pass (see warning below) |
| `tail_turns` | `0` | always retain the tail covering at least this many recent user turns (0 = off) |
| `preserve_recent_tokens` | `15000` | overrides `context.keepTokens` — recent tokens kept verbatim beside a checkpoint |
| `reserved` | `20000` | overrides `context.bufferTokens` — safety reserve below the effective ceiling (`min(context window, input cap)`) |

**`prune` warning.** When true, the generation-start prune pass clears tool results older
than the protected recent window (`[Old tool result content cleared]`). That **rewrites
already-sent bytes and invalidates the provider's prompt-cache prefix** — unlike ordinary
append-only compaction. It is therefore never silent: the session records an audit entry
(`tool: "prune"`) and shows a toast, and resets its usage anchor so the next estimate is
recomputed locally. It commits only when at least ~20k tokens are reclaimable (protecting
the most recent ~40k tokens of tool output; `skill_view` is never cleared). The default
`false` means zero behavior change.

Invalid values warn and keep the defaults; unknown keys warn. Config-file-only at first.

## `tool_output`

Tool-output truncation. Every
tool result is capped once at the tool boundary (`agent/tools.ts` `executeTool` →
`truncateToolOutput`, `agent/truncate.ts`):

| Key | Default | Meaning |
|---|---|---|
| `max_lines` | `2000` | lines kept — head by default; `shell_background`/`get_scrollback` keep the TAIL |
| `max_bytes` | `51200` | UTF-8 bytes kept (whichever limit trips first) |

When a result exceeds either limit, the model-facing content becomes a preview plus a
pointer: the FULL text is written to `<state-dir>/tool-output/tool_<id>` and the model is
told to read it back with `read_file` (offset/limit) or `shell_background`. The card
preview stays the short card preview (boundary truncation never grows it). Spill files
older than 7 days are cleaned up lazily. Config-file-only at first (the settings screen's
Chat `Advanced…` submenu can gain a row later). Invalid values warn and keep the defaults;
unknown keys warn.

## `chat`

How the sidebar presents reasoning and tool output. Sessions override the first two via
`/thinking` and `/details` (the toggles never write it back). A Settings save or `/reload`
re-seeds EVERY open session from the new config (`applyChatDisplayConfig`, run by the single
config-change mechanism — see "Live config reload"), so the settings
Chat rows — `cardStyle`, `thinking`, `toolOutput` and `animations` — apply live and an
already-rendered bubble restyles without a restart:

- `thinking` (default `"hide"`): `"hide"` = collapsed one-liner (`+ Thought for 2.3s`; click
  the header or `Alt+T` to expand), `"show"` = expanded. While the model reasons the block
  shows an animated header, itself clickable to reveal the live reasoning. Reasoning is
  display-only (never enters the provider history) but IS persisted in the transcript and
  restored on resume.
- `toolOutput` (default `"collapsed"`): cards show a ~6-line preview + an expand hint;
  `"expanded"` shows full output (capped at 400 lines) and WRAPS long lines, so a
  single long line (e.g. `memory read journal`) is fully readable — the collapsed
  preview truncates it to the card width, so it also shows a truncation hint. Clicking
  a card's header/hint, `Alt+E`, `/details`, or the Ctrl+P "Toggle tool details" row
  flips it.
- `animations` (default `true`): braille spinner frames while streaming/thinking, the
  elapsed-seconds readout, the streamed-text reveal pacing, the message entrance
  slide/fade, the expand/collapse border flash, the pulsing streaming caret, and the input
  caret blink. `false` renders a static `⋯` glyph, shows streamed text unpaced, skips the
  entrance effects, and holds the input caret solid. `SENSUS_REDUCED_MOTION` (truthy) also
  forces the caret solid, independent of this key.
- `cardStyle` (default `"fill"`): `"fill"` renders solid themed panels
  filled with the theme `cardBg` panel token, with notched block corners and the
  message body floating one column inside the chat card's border. `"border"` draws rounded bordered
  cards with no fill (the adaptive `terminal` theme stays background-free).
  `/cards` toggles it for the session;
  `Alt+C` and the Ctrl+P "Toggle card style" row flip the session too. The settings
  Chat row persists immediately AND re-applies to every open tab, so existing bubbles
  restyle live (no restart).
- `maxToolTurns` (default `null` = no cap): the provider round-trips (tool turns) allowed per
  user message before the loop stops with a "send a message to continue" note. A positive
  number caps the loop; `null` = no cap (the loop runs until the model stops or the user
  aborts). Settings offers `25 | 50 | 100 | off`; hand-editing the file accepts any positive
  number. Read once per generation, so a change applies to the next message.
- `busySend` (default `"steer"`): what happens when a message is sent while a reply is
  still streaming (docs/agent.md "Busy sends"). `"steer"` injects the
  message into the RUNNING turn at its next safe boundary (the next model call / tool
  boundary) so the model sees it mid-task without stopping; `"queue"` holds it and sends it
  as the next turn once the current one settles. Enter applies this setting; `Alt+Enter`
  applies the other mode while streaming (docs/keybindings.md "Chat focus"). Read live, so
  the settings row or a hand-edit applies to the next send. A steer whose running turn ends
  abnormally (an Esc abort, a provider error, the loop cap) is re-dispatched as a fresh
  generation so the agent still answers it (docs/agent.md "Busy sends").

## `titles`

Automatic session titles (docs/sessions.md "Auto titles"): on the first user prompt of a
session, a small no-tools completion asks a model for a short title and writes it to the
transcript's sidecar, so `/sessions` and the `--resume` picker show something more
recognizable than the raw first message.

- `enabled` (default `true`): master switch. `false` keeps the derived (first-user-message)
  title (`deriveTitle`).
- `model` (default `""`): the model that writes the title — `<endpoint>@<model>`, or a bare
  model id on the session's endpoint. Empty = the session's selected model (including a
  per-session `/model` override), so by default nothing extra is configured.

Best-effort by contract: the request is fire-and-forget, aborts with the generation (Esc),
and a provider/disk failure leaves the derived title in place. A manual rename always wins,
and an existing explicit title is never overwritten. The result is cleaned (label/quotes
stripped, capped at 10 words / 60 chars).

## `memory`

Agent memory: three plain-markdown stores the agent maintains with the `memory` tool
(docs/memory.md). The `memory` object tunes their hard caps and write policy:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` drops the `memory` tool + prompt block entirely |
| `memoryCharLimit` | `2200` | `MEMORY.md` cap — **always injected** into the system prompt |
| `hostCharLimit` | `4000` | `HOST.md` cap (server architecture map; never injected) |
| `journalCharLimit` | `8000` | `JOURNAL.md` cap (episodic; ring-trimmed when full) |
| `writeApproval` | `false` | `true` gates every memory write behind the approval card in `full-auto` (`confirm` already gates it) |
| `consolidateAtPercent` | `80` | reserved: parsed/validated, not yet enforced — the full-store path today is the model's explicit `rewrite` action (docs/memory.md "Rewrite") |
| `redactSecrets` | `true` | refuse writes that look like credentials/tokens/private keys |

Files live in `~/.config/sensus/memory/` (`memoryDir()`; `SENSUS_HOME` redirects it). A cap
is a hard limit for MEMORY/HOST — an over-limit write errors and never truncates; JOURNAL
drops its oldest entries to fit. Invalid values warn and keep the defaults. Unknown keys
warn.

## `notifications`

Desktop alerts (docs/agent.md "Desktop notifications"):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `mode` | `"bell"` | `"bell"` (plain BEL) or `"osc777"` (rich OS notification where supported) |
| `onFinish` | `true` | alert when a reply finishes while you are elsewhere |
| `onApproval` | `true` | alert when a tool approval card appears |

Only state TRANSITIONS alert: a reply that was streaming and stopped, or an approval that
newly appears (unless the overlay is already in front of you). Invalid values warn.

## `extensions`

The extension seam (docs/extensions.md): the approval policy the agent consults once per
tool call and the event sink it emits audit events to. Both are optional and default to
no-op/local, so with neither configured the agent behaves exactly as before.

```json
{
  "extensions": {
    "approvalPolicy": { "kind": "default" },
    "eventSink": { "kind": "uds", "path": "/run/sensus/events.sock" }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `approvalPolicy.kind` | `"default"` | `"default"` = the built-in approval modes decide (no policy). Any other kind (plus the object's extra keys) is handed to a host-supplied `ApprovalPolicyFactory`; a stock build has none, so an unknown kind is a no-op. |
| `eventSink.kind` | `"noop"` | `"noop"` drops every event; `"uds"` writes newline-delimited JSON to the local Unix socket at `path` (a `unix://` prefix is accepted); `"jsonl"` appends the versioned event schema v1 to the local log (`path`, default `~/.local/share/sensus/events.jsonl`). Never TCP. The **daemon** treats the engine `"noop"` default as its own JSONL log (D13; [`events.md`](events.md)). |
| `eventSink.path` | — | Required for `kind: "uds"`; optional for `kind: "jsonl"` (overrides the default log path). |

Malformed sections degrade safely and never fail boot: unknown keys warn; an empty/non-string
policy `kind` keeps the default; a non-object section is ignored; a `uds` sink without a
path warns and stays `noop`; a `jsonl` sink with an invalid `path` warns and uses the default.
The seam's full contract (what a policy may decide, the event payloads, the destructive-floor
invariant) is in [`extensions.md`](extensions.md); the v1 log schema is in
[`events.md`](events.md).

## `sidebar` and `keymap`

- `sidebar.width` (default 50, accepted 20–200): the **chat sidebar** (chat pane) width in
  columns — edited in the settings screen as Appearance → **chat sidebar width**. Hotkey
  resize clamps to min 30 / max 50% of the terminal and stays session-scoped; the settings
  screen persists. In the `"sidebar"` layout the clamp also reserves the vertical tab rail's
  footprint, so the chat plus the rail never claim more than half the terminal — the terminal
  pane keeps the majority by default.
- `layout` (default `"sidebar"`): where the tab strip lives. `"sidebar"` puts it on a
  vertical rail on the left; `"topbar"` keeps the strip on row 0. The rail falls back to
  `"topbar"` silently when it would starve the terminal pane. Invalid values warn and keep
  `"sidebar"`. Edited in the settings screen (Appearance → **layout**), which applies live;
  like `theme`, a hand-edited value is restart-only (`/reload` does not re-seed the live
  store). A separate, **non-persisted** chat-only view (`Alt+Home`, or the Ctrl+P
  "Chat-only view" row) hides the pane and tab rail and spans the chat full-width; it keeps
  this setting intact and restores it on toggle-off.
- `autoChatOnly` (default `true`): a narrow terminal (at or below `AUTO_CHAT_ONLY_MAX_COLS`,
  a pure `ui/lib/layout.ts` constant — **90 columns**) starts in the chat-only view
  automatically, so mobile users never have to press `Alt+Home`. The manual `Alt+Home`
  toggle overrides it for the session; `false` turns the auto-switch off. A phone reports
  roughly 70–90 columns depending on the font, so the ceiling sits above that — but note an
  80-column desktop terminal also auto-switches; `Alt+Home` or `autoChatOnly: false` handles
  it. A pixel 9:19 aspect ratio is NOT the signal: a monospace cell is about twice as tall as
  it is wide, so a portrait phone is often *wider than tall in cells*. Edited in the settings
  screen as Appearance → **auto chat-only**; applies live; restart-only when hand-edited,
  like `layout`.
- `tabs.width` (default 24, accepted 16–60): the **tab rail** (vertical tab strip) width in
  columns, used when `layout` is `"sidebar"` — edited in the settings screen as Appearance →
  **tab rail width** (distinct from the chat sidebar width above). Floored; invalid values
  warn and keep the default. Unknown keys inside `tabs` warn; a non-object `tabs` warns and is
  ignored. Applies live; restart-only when hand-edited, like `layout`.
- `keymap` (default `{}`): per-action key overrides (`{ "focus-toggle": "shift+tab", ... }`).
  Malformed entries keep the default binding. Full action list and quirks:
  [`keybindings.md`](keybindings.md).

## `daemonPersistent`

`daemonPersistent` (default `false`): the daemon's idle policy (D3/D9). A
non-persistent daemon holds a grace window after the last client/turn
(`SENSUS_DAEMON_GRACE_MS`, default 300000) and then exits, taking its shells —
**unless it owns a live pane shell**, which pins it so a killed/restarted client
can re-attach (D1, locked #6). A persistent daemon never grace-exits.
`SENSUS_DAEMON_PERSISTENT=1` (or any of
`true`/`yes`/`on`) overrides it to `true`; the falsey spellings override to
`false`. A non-boolean value warns and keeps the default. The daemon's no-client
approval hold (`SENSUS_DAEMON_APPROVAL_TIMEOUT_MS`, default 60000) is
independent of this, as is the idle reaper: a shell left **inactive** longer than
`SENSUS_DAEMON_REATTACH_MAX_AGE_MS` (default 28800000 ms, 8h; `0` disables) is
killed so it can no longer be re-attached — re-attach is for a *recent* detach, not a
session from a previous workday. Full policy: [`daemon-api.md`](daemon-api.md)
"Lifecycle", [`operations.md`](operations.md) "Daemon".

## `triggers`

Local condition triggers ([`triggers.md`](triggers.md)): an opt-in list of rules
the daemon evaluates against every event schema v1 record. On a match it appends
a record to `~/.local/share/sensus/triggers.jsonl` and broadcasts a `trigger`
event to attached WS clients. Local-only — no egress (D8). `[]` (default) = off.

```json
{
  "triggers": [
    { "on": "error.raised" },
    { "on": "tool.executed", "tool": "shell_background" },
    { "on": "file.changed", "session": "01J8Z6M6Y3Q7V9K2N4P6R8T0W2" },
    { "on": "*" }
  ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `on` | yes | a v1 event type (`session.started`, `session.ended`, `turn.completed`, `tool.executed`, `file.changed`, `memory.written`, `skill.used`, `error.raised`) or `"*"` for any |
| `tool` | no | exact tool-name filter; only matches the tool-bearing types (`tool.executed`/`file.changed`/`error.raised`) |
| `session` | no | exact match against the v1 `session` field |

The **first matching rule wins** (one event → at most one record). Invalid
entries warn and are skipped (a non-object, a missing/unknown `on`, a non-string
`tool`/`session`); a non-array `triggers` warns and is ignored. Config-file-only
(and applied live by a `PUT /v1/config`). Read the log with
`sensus triggers tail`.

## MCP servers

`mcp.servers` configures MCP tools merged into every chat request as
`mcp__<server>__<tool>`. Full spec: [`mcp.md`](mcp.md). Summary: stdio (`command` + `args` +
`env` + `cwd`) or remote (`url` + `headers`); per-server `enabled` and `timeout_s`; `${VAR}`
expansion in `env`/`headers`/`cwd`; invalid entries warn and are skipped (never block boot).
A stdio server's `cwd` (relative = under the config dir) defaults to a per-server dir under
the cache dir (`~/.cache/sensus/mcp/<server>/`), never sensus's own working directory. That
cache dir is scratch space: files under it older than 7 days are pruned at startup
(hourly-throttled, best-effort); the per-server directories are kept.

## Live config reload

Every config swap reaches the UI through ONE seam: `ChatHost.onConfigChange(listener)`
(a listener set — not per-surface hooks). `ChatHost.reload(kind)` fires every listener after
a successful swap with the change kind, and the kind decides which surfaces re-apply:

| Kind | Cause | Re-seeds |
|---|---|---|
| `internal` | A reload that re-read config for an unrelated reason: a model pick (`setSelectedModel`), an agent pick (`setDefaultAgent`), an MCP toggle, a keymap remap, setup completion | Nothing session-scoped — a tab's `/cards`, `/thinking` and `/details` overrides survive |
| `user` | An explicit reload: the chat `/reload` slash command, the agent's `reload` tool, or the Ctrl+P "Reload config" row | `chat.*` display on every open tab |
| `settings` | A settings-screen write (`persistDoc`) | `chat.*` display **and** the settings-owned layout store (`sidebar.width`, `layout`, `tabs.width`) |

App registers ONE listener and its body is the surface list (`applyConfigChange` in
`src/ui/components/App.tsx`). Every reload also re-merges the `themePalette` override over
the last detection (no re-probe of the terminal), re-pushes the pane palette and default
fg/bg, and bumps the store's `configVersion` so config-derived effects (`autoChatOnly`, the
resolved keymap) re-run. Adding a future config-derived live surface means adding it to that
one list — not wiring a new bespoke setter/hook.

The internal/user split is the Kaneo #25 contract: internal reloads must **not** clobber
session-scoped display overrides, while user reloads (and settings writes) re-seed them.
`applyChatDisplayConfig` is the re-seed primitive.

## Writing the file (settings screen)

The settings screen writes the real file (`~/.config/sensus/config.json`):

- edits patch the parsed document, so unknown keys are preserved;
- writes are atomic (tmp file + rename in the same directory);
- the first write makes a one-time `config.json.bak` backup;
- a failed write applies nothing and surfaces in a toast;
- after a write the config is re-resolved live (same path as `/reload`) — env and CLI
  overrides still win over the file. The reload runs as the `settings` kind of the single
  config-change mechanism (see "Live config reload"): the `chat.*` display settings are
  pushed into EVERY open session (`applyChatDisplayConfig`) and the layout fields
  (`sidebar.width`, `layout`, `tabs.width`) re-seed the live store, so already-rendered
  bubbles restyle and the layout changes without a restart.

## Settings screen

`/settings` or `Ctrl+O` opens a centered modal with a LEFT nav rail and a RIGHT detail
pane. The rail categories, top to bottom: **Endpoints · Model · Agent · Appearance · Chat ·
Context · MCP servers · Memory**. `Up`/`Down` move within the focused pane (clamped, no
wrap); `Enter` on a rail category opens it and focuses the detail pane; `Tab`/`Shift+Tab`
toggles rail ⇄ detail; `Left`/`Right` cycle a focused cycle field (otherwise switch pane).
`Esc` cancels an in-progress edit, then clears a non-empty filter, then pops a nested
"Advanced" submenu, then closes. Each category's detail pane edits that category's config
keys; the field-by-field walkthrough is the user guide
(https://sensus.sh/docs/configuration/).

Guided first-run setup is a **separate modal overlay** over these same settings — `/init-wizard`,
Ctrl+P → Setup wizard, or automatically on a first run / a boot config error (it is confirm-gated
on exit and always writes through the same `configFile.ts` path). See
[`operations.md`](operations.md) "Setup wizard".

- **Endpoints**: the endpoint list + `+ add endpoint`; selecting one opens its editor —
  name (renames follow the selection), baseURL (empty = the protocol default; else http(s)),
  apiKey (masked; show/hide), test connection (the daemon probes the DRAFT over its
  protocol via `POST /v1/models/probe` — the transient key is never stored → ok/fail +
  model count), `provider` (cycles `openai-compatible` | `openai-responses` | `anthropic` |
  `google`; the legacy `http` reads as openai-compatible, `provider: "mock"` still works in
  config for the test seam but is not offered here, and the baseURL follows the new
  protocol's default unless it is custom),
  `temperature`/`maxTokens` (finite numbers; empty = auto for `maxTokens` — the model's
  output limit, else the endpoint default),
  `thinkingMode` (empty clears; parsed by `parseThinkingMode`), model-metadata overrides
  (JSON), browse models, delete endpoint (asks `delete endpoint "<name>"? y/N`), back to
  list. A file that **omits** `endpoints` seeds the resolved endpoints (never a silently
  empty list, which a write could otherwise persist as `"endpoints": {}` and zero the
  runtime endpoints); an explicit `"endpoints": {}` is shown as written. Unknown keys survive.
- **Model**: the global `model` (`<endpoint>@<model>`) + browse models, plus the auto-title
  switch (`titles.enabled`) and `titles.model` (empty = the chat model).
- **Agent**: `agent` (cycles the loaded agents), `approval` (confirm|full-auto),
  `allowPrefixes` (comma-separated).
- **Appearance**: `theme` (opens the searchable theme picker with live preview, applies +
  persists on Enter), `sidebar.width` (the **chat sidebar width**, 20–200, applies live),
  `layout` (topbar|sidebar, applies live), `autoChatOnly` (on|off, applies live), `tabs.width`
  (the **tab rail width**, 16–60), and `Advanced…` — a nested
  submenu holding the `themePalette` color overrides (default fg/bg, color mode, palette,
  reset — clearing the palette or resetting asks `y/N`) plus a read-only `shell` fact.
  `paneColors`/`boldBright` are config-file keys, not edited here.
- **Chat**: `chat.thinking` (show|hide), `chat.toolOutput` (collapsed|expanded),
  `chat.animations` (on|off), `chat.maxToolTurns` (25|50|100|off = no cap),
  `chat.busySend` (steer|queue — a message sent while the reply streams).
- **Advanced (per section)**: a section whose config-file-only keys have graduated ends its
  detail pane with an **`Advanced…`** row that opens one level deeper (currently only
  Appearance has one); `Esc` pops back to the section. The flat type-to-filter search still
  lists those fields, tagged with their category, and opens straight into the submenu.
- **Context**: `context.enabled`, `scrollbackLines` (10–1000), `autoCompact`, `keepTokens`
  (>0), `bufferTokens` (≥0), `contextLimit` (`0` = unlimited/auto — use the model metadata,
  capped by the model's advertised input limit when known — else >0).
- **MCP servers**: each `mcp.servers.*` entry as a block (enabled toggle, rename, url/command,
  timeout 1-600s, delete with `y/N`) plus `+ add http server` / `+ add stdio server`. Full
  add/edit/delete is available here; `args`/`env`/`headers` still live in `config.json`
  ([`mcp.md`](mcp.md)).
- **Memory**: `memory.enabled`, `memoryCharLimit`, `hostCharLimit`, `journalCharLimit`
  (all >0), `writeApproval`, `consolidateAtPercent` (1-100), `redactSecrets`
  ([`memory.md`](memory.md)).

**Type-to-filter (Ctrl+P style).** Typing printable characters builds a query; a non-empty
query replaces the panes with a FLAT, fuzzy-ranked list of matching fields across ALL
categories (`src/ui/chat/settingsFilter.ts`, `fuzzyScore` on label + category), each row
tagged `[category]`. `Backspace` removes; `Esc` clears; `Enter` opens the hit. Clearing the
query returns to rail + detail. While the query is empty `j`/`k`/`g`/`G` navigate; while it
is non-empty they are typed. `PgUp`/`PgDn`/`Home`/`End` always navigate (`stepIndex`, no
wrap — clamped).

Every row sets an explicit background and a fixed cell budget; all rows are clickable and
the backdrop click closes. Destructive actions (delete endpoint, clear palette, reset
colors) never fire on a single `Enter` — they ask inline `…? y/N`. Every commit persists
immediately through `configFile.ts` (unknown keys preserved) and reloads config; a failed
write surfaces in a toast. Fully keyboard-navigable ([`keybindings.md`](keybindings.md)).

## Model picker

`/models` (or the status-bar model chip, or "browse models") lists EVERY configured
endpoint's models over its protocol in each endpoint's own order (proxies like
LiteLLM curate it — sensus never re-sorts); embeddings-only models are tagged. Typing filters
by fuzzy relevance over id + display name + `endpoint/id`; `<endpoint>@` scopes the query.
Each row shows the models.dev enrichment merged with the endpoint's config overrides,
matched provider-agnostically by normalized id; the picker footer names models.dev as the
source. The models.dev index is cached 24h (warmed in the background at boot so the status
bar's context limit resolves without opening the picker first) and every network step times
out — the TUI never blocks. Enter persists the pick as the global `model`. The status bar
shows the selection + context usage against the effective limit (settings override → model
metadata, capped by the model's input-token ceiling → 128k fallback).

## Resolution order

1. Built-in defaults
2. Config file
3. Env overrides: `SENSUS_MODEL` (`endpoint@model` or a bare id), `SENSUS_ENDPOINT`,
   `SENSUS_BASE_URL`, `SENSUS_APPROVAL` (`confirm|full-auto`), `SENSUS_DAEMON_PERSISTENT`
   (truthy → `daemonPersistent`), `SENSUS_DAEMON_HOST`/`SENSUS_DAEMON_PORT` (the daemon
   TCP bind; loopback is the default and a non-loopback host is a deliberate opt-in,
   docs/daemon-api.md "Authenticating"), `SENSUS_MOCK=1` (provider
   test seam); `SENSUS_STREAM_TIMEOUT_MS` (idle stream timeout in ms, default 120000,
   `0` disables), `SENSUS_REDUCED_MOTION` (truthy → solid input caret, as
   `chat.animations: false`), `SENSUS_DEBUG` prints exit/signal diagnostics to stderr;
   `SENSUS_HOME`, `SENSUS_CACHE_DIR`, `SENSUS_STATE` move paths (tests)
4. CLI flags (highest): `--model`, `--endpoint`, `--base-url`, `--resume`, `--yolo`,
   `--sidebar-width`

`SENSUS_SKIP=1` is not a config setting: it is the nesting-guard override (the
test/dogfooding hatch that starts a nested copy on purpose). `SENSUS_NO_SETUP=1` is the
test/dogfooding hatch that keeps a plain boot bare (it suppresses the automatic setup modal
on a first run / boot config error, but never an explicit `sensus init`). `sensus --help`,
`--version`, and headless `init --create-config` are handled BEFORE any of this resolution;
the interactive `sensus init` does not resolve ahead of time — it boots the TUI with the
setup modal open ([`operations.md`](operations.md)).

The daemon (worker) is a separate headless process (`sensus daemon`, [`daemon-api.md`](daemon-api.md));
the TUI client cutover to it is P4. Until then every TUI boot is fresh and `--resume` opens the
session picker before the UI ([`operations.md`](operations.md)).

## Validation

Unknown keys warn once in the status bar and do not fail. Legacy keys from the profiles era
(`profiles`, `defaultProfile`, `defaultMode`) warn with a pointer to endpoints — no silent
migration. A bad `baseURL` logs the problem and opens the setup modal to fix it (the TUI no
longer refuses to boot). `bun test` covers
resolution order and selected-model parsing with `SENSUS_HOME` sandboxes.

## Gotchas & invariants

- **One selection, two scopes.** `model`/`agent` in config are the defaults for new
  sessions; an in-app pick updates the current session AND persists the default. Other open
  tabs are unaffected.
- **Endpoint names cannot contain `@`** (it would break the `endpoint@model` key); parsing
  splits at the FIRST `@`.
- **The first write is not the last.** A missing config file is normal; the first persisted
  setting creates it (and the one-time `.bak`).
- **Unknown keys survive by construction** because writes patch the parsed document rather
  than re-deriving it.
- **`contextLimit` precedence:** `context.contextLimit` (positive) → endpoint
  `models.<id>.contextLimit` → models.dev → 128k — then capped by the model's input-token
  ceiling (the `inputLimit` override → models.dev `limit.input`) when one is known, because
  the provider rejects a prompt over it. `context.contextLimit: 0` = unlimited/auto.
- **Theme reload asymmetry:** `/theme` and the settings screen apply live; a hand-edited
  `theme` needs a restart (`/reload` does not apply it).

## Related docs

- [`DESIGN.md`](DESIGN.md) — theme tokens, palette behavior, color fidelity
- [`agents.md`](agents.md) — agent files and selection
- [`agent.md`](agent.md) — context/compaction, thinking modes, approvals
- [`mcp.md`](mcp.md) — MCP server entries
- [`operations.md`](operations.md) — CLI, install, persistence, lifecycle
