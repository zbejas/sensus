# Daemon API

## Overview

`sensus daemon serve` hosts the **headless engine** (config, secrets, memory,
sessions, audit, and the PTY/terminal channels) behind an authenticated HTTP/WS
API. It is a **mode of the `sensus` binary** (D15/D18), so there is one artifact
to install, version, and sign. This doc owns the REST surface, the terminal
WebSocket envelope, the auth model, and the error shape. The CLI lifecycle is
[`operations.md`](operations.md) "Daemon".

The daemon listens on **two transports** (D7/D14): a Unix socket in the
runtime dir (`daemon.sock`, mode `0600`, dir `0700`) and a TCP listener that
defaults to **loopback** (`127.0.0.1`, ephemeral port). There is **never** a
public bind by default. A LAN/Tailscale address can be bound only through the
explicit `SENSUS_DAEMON_HOST` (and `SENSUS_DAEMON_PORT`) opt-in — off unless set
— which exists so a browser on another machine can reach the docs; the REST/WS
API stays bearer-gated, but the docs surface is unauthenticated (see
"Authenticating"). Remote access with TLS and a real auth model remains out of
scope for v1. REST is served on both transports; the terminal WebSocket is
loopback-only by default (see below).

```
sensus (client)                          sensus daemon (worker; Elysia)
  REST (UDS+loopback) ─── UDS / loopback ───────  engine: config · secrets · memory
  WS (loopback only)                              sessions · audit · skills · agents
  (VT in client)                                  PTY shells + replay · chat · approvals · sudo
```

## Key files

| File | Purpose |
|---|---|
| `src/daemon/app.ts` | `createDaemonApp`: the Elysia app, route registration, the defensive `onError` JSON shape |
| `src/daemon/auth.ts` | Bearer auth (`bearerFrom`, `safeEqual`, `bearerAuth` global hook) |
| `src/daemon/token.ts` | Runtime dir (`0700`) + token/pidfile (`0600`) helpers; never throws |
| `src/daemon/paths.ts` | `daemonRuntimeDir` + `daemon.sock` / `daemon.token` / `daemon.pid` / `daemon.log` (raw stdio banner) / `daemon-log.jsonl` (structured log) |
| `src/daemon/serve.ts` | `startDaemon`: binds UDS (REST) + loopback TCP (REST + WS), builds/reuses `instance.json`, defaults the sink to `JsonlEventSink` (docs/events.md), configures the structured logger at `<runtimeDir>/daemon-log.jsonl` (docs/logging.md), returns `{unix,tcp,token,registry,stop}` |
| `src/daemon/logStrict.ts` | `logStrictEnabled`: the `SENSUS_LOG_STRICT=1` gate for the allow-listed rethrow sites |
| `src/daemon/shells.ts` | `ShellRegistry`: the daemon-owned PTY shells, roles (D11), the bounded replay buffer (D12), client facts (D2) |
| `src/daemon/chats.ts` | `ChatRegistry`: the daemon-owned agent chats — opens `ChatSession`s through `ChatHost`, mirrors the engine `ChatEvent` stream, answers approvals via `resolveCard` and sudo via the `requestSudo` dep, and derives the `ChatMeta` readouts (P4c-ii) |
| `src/daemon/ws.ts` | `GET /v1/ws`: upgrade + auth, the request/response/event envelope, the terminal + chat op dispatch, bounded per-client queues, the `hello`/grace seam |
| `src/daemon/lifecycle.ts` | The lifetime policy (P3c-iii): grace/idle exit (held while a live pane shell exists), the idle reaper that kills panes inactive past the re-attach window (`SENSUS_DAEMON_REATTACH_MAX_AGE_MS`), detached-turn keep-alive, the no-client approval hold, and the pure `versionMismatchAction` handshake helper |
| `src/daemon/cli.ts` | `sensus daemon {serve,start,stop,restart,status,logs,install,uninstall}` lifecycle |
| `src/daemon/service.ts` | The persistent user service (P6): systemd/launchd unit rendering + install/uninstall through an injectable runner |
| `src/daemon/triggers.ts` | Local condition triggers (P6): rule matching + the bounded `triggers.jsonl` writer + the sink decoration |
| `src/daemon/config.ts` | `GET /v1/config` redaction (`redactConfig`, D13) |
| `src/daemon/settings.ts` | `PUT /v1/config` (patch) + `GET/POST/DELETE /v1/secrets` — validated, secret-safe writes (P4c-ii) |
| `src/daemon/mcp.ts` | `GET /v1/mcp` — live per-server MCP status facts (P4c-ii) |
| `src/daemon/models.ts` | `GET /v1/models` — the enriched, credential-free model catalog (P4c-ii) |
| `src/daemon/usage.ts` | `GET /v1/usage` — serializable usage roll-ups for the dashboard (P4c-ii) |
| `src/daemon/memory.ts` · `sessions.ts` + `sessions/routes.ts` · `audit/{query,reader,routes}.ts` | The memory / sessions / audit resources |
| `src/daemon/index.ts` | The daemon barrel (import from here, not the internals) |
| `src/daemon/openapi.ts` | The OpenAPI/Scalar config (docs paths, the auth-exemption helper, spec metadata) |
| `src/daemon/apiSchemas.ts` | The TypeBox request/response schemas the Scalar spec is generated from |

## Authenticating

Every request — `health` and `info` included — must carry the boot token
(`src/config/config/paths.ts` `sensusRuntimeDir()` / `daemon.token`, mode `0600`):

```
Authorization: Bearer <token>
```

The token is regenerated **per boot** and never leaves the machine. A missing,
malformed, or wrong token is:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json

{ "error": "unauthorized" }
```

Comparison is constant-time. The filesystem permissions are the first line of
defence; the bearer is the second.

The **one exemption** is the documentation surface (`/openapi*`, below): a
browser cannot attach the bearer to the initial UI/spec fetch, so `auth.ts`
skips it. It still binds only the local socket + loopback (never public) and
describes no secrets.

## Interactive API reference (Scalar)

The REST contract is **generated from the route metadata** — there is no
hand-maintained spec file. `src/daemon/app.ts` mounts `@elysiajs/openapi` with
`daemonOpenApiConfig(version)` (`src/daemon/openapi.ts`), which serves:

- `GET /openapi` — the interactive **Scalar** reference (HTML);
- `GET /openapi/json` — the generated OpenAPI 3.1 document.

A trailing-slash docs URL (`/openapi/`) is redirected (308) to the canonical
`/openapi`: Scalar builds its spec URL relative to the page path, so at
`/openapi/` it would otherwise request `/openapi/openapi/json` and report the
spec as dead.

Both are exempt from bearer auth (see "Authenticating") so a browser can load
them, but they are bound only to the local socket + loopback. The Scalar
frontend bundle loads from its default CDN (jsdelivr); the daemon process makes
no outbound call (D8). Every response shape is declared in
`src/daemon/apiSchemas.ts` and attached through each route's `detail` block
(tags, `operationId`, summary/description, typed responses) plus permissive
query/path schemas, so the spec can never drift from the handlers that own the
behavior.

Reach it on the loopback listener (the port is `GET /v1/info` → `tcp.port`,
also printed by `sensus daemon status`):

```
open http://127.0.0.1:<port>/openapi
```

To open it from **another machine on the same network**, start the daemon with
the opt-in bind (the API stays bearer-gated; the docs are unauthenticated):

```
SENSUS_DAEMON_HOST=0.0.0.0 sensus daemon serve   # or the host's LAN IP
open http://<host-lan-ip>:<port>/openapi
```

or fetch the spec over the Unix socket:

```
curl --unix-socket <runtime-dir>/daemon.sock http://localhost/openapi/json
```

`tests/unit/daemon/openapi.test.ts` locks the spec: the docs surface is
reachable without a token, every operation has a stable unique `operationId`, a
declared tag and a typed `200`, and the documented route set matches the daemon.

## Routes

All responses are JSON unless noted. The shapes and statuses are the generated
Scalar reference above.

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/health` | `{ ok, name: "sensus-daemon", version }` — cheap liveness; the readiness probe `start` waits on |
| GET | `/v1/info` | Daemon facts: `pid`, `platform`, `startedAt`, `uptimeMs`, `socket`, `tcp {host,port}`, `shells`, `persistent`, `instance { instanceId, createdAt, version }` |
| GET | `/v1/config` | `{ ok, config }` — the **effective, redacted** config (D13) |
| PUT | `/v1/config` | `{ ok, config, captured[], backupCreated }` — apply a validated config patch (P4c-ii); `?mode=replace` replaces the whole document |
| GET | `/v1/config/raw` | `{ ok, raw }` — the UNREDACTED raw `config.json` for the settings editor |
| GET | `/v1/agents` | `{ ok, agents[], warnings }` — read-only agent definitions |
| GET | `/v1/skills` | `{ ok, skills[], warnings }` — read-only skill index (name/description, no bodies) |
| GET | `/v1/memory` | `{ ok, targets[] }` — usage for MEMORY/HOST/JOURNAL |
| GET | `/v1/memory/:target` | `{ ok, target, content, entries, usage }` |
| POST | `/v1/memory/:target` | `{ ok, … }` or `{ ok:false, message }` (store-domain refusal) |
| GET | `/v1/audit` | `{ ok, records[], nextCursor }`; `?format=jsonl\|csv` exports |
| GET | `/v1/audit/stats` | `{ ok, total, byKind, byTool, bySession }` |
| GET | `/v1/sessions` | `{ ok, sessions[], nextOffset }` |
| GET | `/v1/sessions/:instance/:base` | `{ ok, id, title, tags, total, offset, messages[] }` |
| GET | `/v1/sessions/:instance/:base/export` | `?format=md` (markdown) or `jsonl` (raw file bytes) |
| GET | `/v1/sessions/:instance/:base/context` | `{ ok, title, breakdown }` — the saved-session Context Inspector snapshot (P4e) |
| DELETE | `/v1/sessions/:instance/:base` | `{ ok, id }` or `{ ok:false, message }` — unlink a transcript + sidecar (P4e) |
| GET | `/v1/mcp` | `{ ok, servers[] }` — live per-server MCP status facts (P4c-ii) |
| GET | `/v1/models` | `{ ok, endpoints[], errors[] }` — the enriched, credential-free model catalog (P4c-ii) |
| POST | `/v1/models/probe` | `{ ok, models[], error }` — probe a DRAFT endpoint (provider/baseURL/apiKey) before saving |
| GET | `/v1/usage` | `{ ok, windowDays, generatedAt, total, byDay[], bySession[], sessions[] }` — usage roll-ups (P4c-ii) |
| GET | `/v1/secrets` | `{ ok, names[], warnings }` — stored secret NAMES (never values) |
| POST | `/v1/secrets` | `{ ok, name }` or `{ ok:false, message }` — set one secret |
| DELETE | `/v1/secrets` | `{ ok, name, removed }` or `{ ok:false, message }` — remove one (`?name=`) |

### `GET /v1/config` (redacted, D13)

The daemon owns config and secrets; the client receives the EFFECTIVE config
(defaults → file → env → flags) with every resolved secret stripped:

- a `${NAME}` reference is kept **verbatim** — a whole value (`"${OPENAI_API_KEY}"`)
  or embedded (`"Bearer ${TOKEN}"`) — because it names a secret, it is not one;
- a **literal** secret (an endpoint `apiKey`, an MCP `env`/`headers` value, an MCP
  `cwd`) becomes `"<redacted>"`;
- an empty/absent credential stays `""`.

Redaction targets the known credential-bearing locations rather than guessing by
key name, so no unrelated field is mangled and no secret slips through.

### `GET /v1/mcp` (P4c-ii)

`{ ok, servers: [{ name, status, toolCount }] }` — the live per-server MCP facts
(`McpServerStatusFact`, docs/mcp.md "UI"). `status` is one of
`idle | starting | connected | failed | disabled`; `disabled` is the registry's
marker for an entry with `enabled:false` in the config file, so the config flag
is carried without a second field. The facts come from the daemon's `ChatHost`
registry (built lazily on the first chat op); before any chat exists the route
answers `servers: []`, never an error.

### `GET /v1/models` (P4c-ii)

The engine-free source for the model picker: the daemon fetches every
configured endpoint's model list **over its protocol** in parallel, enriches
the rows with models.dev metadata (each protocol pinned to its models.dev
provider), layers the endpoint's OWN reported metadata (Anthropic
capabilities, Gemini limits) over that, and merges each endpoint's
`endpoints.<name>.models.<id>` overrides **last** — the same pipeline the TUI
runs in-process. Metadata precedence is therefore
**config override > endpoint /models > models.dev**. The listing wire is
protocol-aware: `openai-compatible`/`openai-responses` GET
`{baseURL}/models` with `Authorization: Bearer`, Anthropic GETs
`{baseURL}/models?limit=1000` with `x-api-key` + `anthropic-version`, and
Gemini GETs `{baseURL}/models?pageSize=1000` with `x-goog-api-key` (its
`models/` id prefix is stripped).

```json
{
  "ok": true,
  "endpoints": [
    { "name": "main", "baseURL": "https://api.openai.com/v1", "provider": "openai-compatible",
      "hasKey": true, "models": [{ "id": "gpt-5", "ownedBy": "openai", "endpointTypes": [],
      "chat": true, "meta": { "context": 400000, "vision": true } }] }
  ],
  "errors": ["backup: HTTP 503"]
}
```

`hasKey` is `true` when the endpoint has a credential (or the mock seam) — a
resolved key is NEVER returned. `meta` is the merged native + models.dev +
override metadata (including `vision`). A per-endpoint fetch failure lands in
`errors`; an unavailable models.dev index degrades every `meta` to `null`
while the endpoint's own models still list.

### `POST /v1/models/probe`

Tests a **DRAFT** endpoint — provider + baseURL + apiKey, possibly not saved
yet — before the setup wizard or settings screen persists it. The body is
`{ provider?, baseURL?, apiKey? }`, every field optional:

- `provider` — a canonical kind (`openai-compatible`, `openai-responses`,
  `anthropic`, `google`, `mock`); unknown/absent lists like
  openai-compatible. It selects the wire (auth header, URL, id shape).
- `baseURL` — empty/absent resolves to the protocol's default
  (`PROTOCOLS[kind].defaultBaseURL`).
- `apiKey` — used **transiently** for this request only: never logged,
  persisted, or returned (it is not a config write). A `${NAME}` reference is
  expanded like config resolution (encrypted store, then process env), so a
  saved endpoint whose key is a ref still tests correctly.

The response is `{ ok: true, models: [<catalog rows>], error: string | null }`
— the same protocol-aware listing + models.dev/native enrichment as
`/v1/models`, minus config overrides (a draft may have no config entry). A
listing failure is a successful `200` with `error` set and `models: []` (the
test button reports the reason), never a `500`; a non-object JSON body is
`400 invalid_request`.

### `GET /v1/usage` (P4c-ii)

Serializable roll-ups for the usage dashboard (docs/agent.md "Observability"):
`{ ok, windowDays, generatedAt, total, byDay[], bySession[], sessions[] }`.
`byDay` is the newest `windowDays` (14) distinct days with usage; `bySession`
covers all retained history (capped at 500 sessions, newest activity first) and
`sessions` carries each row's `{ path, title, lastTs }`. A missing or unreadable
sessions dir degrades to an empty report.

### Settings writes (P4c-ii)

The daemon owns config + secrets (D13), so a remote settings screen writes
through these routes instead of touching the filesystem. Both are bearer-gated
and only reachable on the UDS/loopback listeners (D7/D14).

**`PUT /v1/config`** accepts a config **patch**: the body is a JSON object
(optionally `{ "config": { … } }`) deep-merged into the raw `config.json`
document. Objects merge recursively, arrays and scalars replace, and a `null`
deletes a key; unknown keys survive. Prototype keys (`__proto__`,
`constructor`, `prototype`) are dropped. A `<redacted>` placeholder echoed from
`GET /v1/config` is restored to the existing credential (or removed) — a client
can never overwrite a stored secret with the redaction marker. Any literal
credential in the merged document is moved into the encrypted store and
replaced with a `${NAME}` reference (`captureSecrets`), so **no secret value is
ever written into `config.json`**. The write is atomic with a one-time `.bak`
(shared with the TUI's settings path) and then reloads the daemon's chats.
Response: `{ ok, config, captured[], backupCreated }` where `config` is the new
redacted effective config and `captured` lists the secret names moved. A failed
write is `200 {ok:false,message}` (the caller renders it); a structurally bad
body is `400 {error:"invalid_request"}`.

**Secrets** — values are write-only, names are readable:

- `GET /v1/secrets` → `{ ok, names[], warnings }` — stored names only, never a
  value;
- `POST /v1/secrets` body `{ "name": "OPENAI_API_KEY", "value": "…" }` → sets
  one value in the AES-256-GCM store (docs/config.md "Secrets"); the name must
  match `[A-Za-z_][A-Za-z0-9_]*`;
- `DELETE /v1/secrets?name=OPENAI_API_KEY` (or a JSON `{ "name" }` body) →
  removes it.

An unreadable secret store refuses every write (`200 {ok:false,message}`)
rather than clobbering the ciphertext, the same contract as the CLI. The store
and key live under the config home with the same permissions the TUI uses.

### Identity & events (P5)

The daemon owns the installation identity and the durable event log (D13;
[`events.md`](events.md)):

- **`instance.json`** (`~/.config/sensus/instance.json`) is generated at the
  first boot and **reused** across restarts/upgrades (only `version` refreshes;
  a corrupt file is repaired). `GET /v1/info` reports it as `instance`.
- **`events.jsonl`** (`~/.local/share/sensus/events.jsonl`) is event schema v1
  NDJSON. The daemon defaults its `EventSink` to the built-in `JsonlEventSink`
  (the engine `noop` default means "the daemon's log"; `uds`/`jsonl` in config
  still select those), routes the engine's seam events through it, and flushes
  it synchronously in `stop()`. The log is bounded (queue + per-field cap) and
  rotates to `events.jsonl.1` at the byte cap. Read it with
  `sensus events tail` ([`operations.md`](operations.md)).
- There is **no forwarding** in v1 and no reference to `SENSUS_CONTROL_URL` in
  the source (D8): the daemon makes no outbound call.

**Structured log.** Boot also configures the process-wide logger
(`configureLogger`) to append NDJSON records to `<runtimeDir>/daemon-log.jsonl`
(`daemonLogJsonlPath`), distinct from the raw `daemon.log` stdio banner. Records
carry `component`, the `instance.json` id as `instanceId`, and a `corrId` for REST
requests; the boot bearer token is redacted by literal value. The log records
activity — sessions, tool executions, settled turns with their abort reason, errors —
and the daemon's own `previous` restart reason (`clean`/`stale-pid`/`stale-socket`/
`unresponsive`, classified by the foreground CLI from the pidfile/socket/health it
found) plus the `reason` on `daemon stopping` (`signal:SIGINT|SIGTERM|SIGHUP`,
`idle`, `crash`, `requested`). `SENSUS_LOG_LEVEL` sets the minimum level and
`SENSUS_LOG_STRICT=1` turns an allow-listed set of absorbed failures into rethrows.
Read it with `sensus daemon logs`; the full contract is in
[`logging.md`](logging.md).

**Condition triggers (P6).** The daemon also decorates that same event sink with
a `TriggerEngine` ([`triggers.md`](triggers.md)): the `triggers` config rules are
matched against every v1 record, a match appends to
`~/.local/share/sensus/triggers.jsonl` (bounded, rotated like the event log) and
broadcasts the `trigger` WS event above. The rules reload on a `PUT /v1/config`
and the log flushes in `stop()`. Local-only, no egress.

### Error model

One shape for every failure: `{ "error": "<code>" }`.

| `error` | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | missing/wrong bearer (`WWW-Authenticate: Bearer`) |
| `invalid_request` | 400 | structurally bad filter/cursor/format/body (unknown memory target/action, missing required arg, bad query number, malformed cursor, unknown export format) |
| `not_found` | 404 | unknown route, or an unknown session id |
| `internal_error` | 500 | an unexpected throw, surfaced as JSON (`onError`) — never an unhandled exception |

A **store-domain** refusal is NOT an HTTP error: an over-cap memory write, a
safety/secret refusal, or an ambiguous `old_text` is a `200 {ok:false, message}`
so the caller can render the store's precise message.

## WebSocket channels — terminal + chat (P3c-i/P3c-ii)

The daemon owns the shells on native PTYs and streams them to clients over one
WebSocket endpoint; the client owns the embedded VT (D1). It also hosts the
agent chat and its approval/sudo gates (P3c-ii). Implemented in
`src/daemon/{shells,chats,ws}.ts`; the lifetime policy (grace/idle exit, held
while a live pane shell exists, no-client hold) lives in `src/daemon/lifecycle.ts` (P3c-iii).

The engine emits a transport-agnostic `ChatEvent` stream
(`ChatSession.subscribe`, IF3 — see [`agent.md`](agent.md) "Remote approval &
event stream"); the daemon translates it into the chat/approval/sudo WS events
below. The approval gate itself is unchanged: a WS answer routes through
`ChatSession.resolveCard`, so the destructive floor and the extensions
`ApprovalPolicy` cannot be bypassed by the socket path.

### Transport

`GET /v1/ws` is served on the **loopback TCP listener only**, not the Unix
socket. Bun's `Bun.serve({ unix })` accepts a WebSocket upgrade server-side, but
Bun's WebSocket **client** has no `unix` option, so a UDS-hosted channel would be
unreachable by both our own client (P4) and the tests. The UDS keeps serving REST
exclusively; `/v1/ws` over UDS is a `404`. Never a public bind (D7/D14).

Authentication mirrors REST: `Authorization: Bearer <token>` **or**
`?token=<token>` (for a future browser client). A missing/wrong token is
`401 {error:"unauthorized"}`; a request without `Upgrade: websocket` is
`426 {error:"expected_websocket_upgrade"}`. Text frames carry JSON; every byte
field is base64.

### Envelope

```
client -> server request:   { "type":"req", "id":"<ulid>", "op":"<op>", ... }
server -> client response:  { "type":"res", "id":"<same>", "ok":true|false,
                              "result"?:{}, "error"?:string }
server -> client event:     { "type":"evt", "event":"<name>", ... }
```

The server echoes the client's `id`. A malformed frame, an unknown op, or a PTY
failure is an error `res`, never a dropped socket or a crashed daemon. Error
codes: `invalid_json`, `invalid_request`, `unknown_op`, `shell_not_found`,
`controller_taken`, `not_controller`, `not_attached`, `upgrade_failed`,
`chats_unavailable`, `chat_not_found`, `shell_taken`, `no_pending_approval`,
`no_sudo_request`.
`chat.setModel`/`setAgent`/`setEffort`/`setApproval`/`setMcp`/`trust*` are the
P4c-iii remote controls (thin wrappers over the engine's session setters, so a
client never widens trust itself); `chat.planAnswer` commits an approval-batch
plan with the client's per-line decisions; `chat.revert` rewinds and pushes a
fresh `chat.state`. A bad mode/value is `invalid_request`; a missing chat is
`chat_not_found`; a plan no longer pending is `no_pending_plan`; a message that
is not a live user turn is `not_revertible`.

### Terminal ops

| Op | Params | `result` |
|---|---|---|
| `terminal.list` | — | `{ shells: [{ shellId, cols, rows, alive, attached, controller, cwd, lastDetachedAt }] }` (`lastDetachedAt` = epoch ms the shell last lost its last client, or `null` while attached; the reaper/picker clock) |
| `terminal.open` | `{ cols, rows, cwd?, shell? }` | `{ shellId }` |
| `terminal.attach` | `{ shellId, role?, cols?, rows?, cursor? }` | `{ shellId, role }` |
| `terminal.handover` | `{ shellId, to }` | `{ shellId, clientId }` |
| `terminal.detach` | `{ shellId }` | `{ shellId }` |
| `terminal.input` | `{ shellId, data }` (base64) | `{ shellId }` |
| `terminal.resize` | `{ shellId, cols, rows }` | `{ shellId }` |
| `terminal.facts` | `{ shellId, lines, cursor:{x,y,visible} }` | `{ shellId }` |
| `terminal.kill` | `{ shellId }` | `{ shellId }` |

- `terminal.open` spawns a headless `PtySession` (the same engine/launch path the
  TUI uses) on the user's shell (config `shell`, then `$SHELL`); `shell`/`cwd`
  override per shell.
- In `terminal.list`, `attached`/`controller` are **server state** ("a shell in
  use"), not requester-relative.
- `terminal.input`/`terminal.resize` are controller-only; an observer is
  rejected with `not_controller`.
- `terminal.facts` stores the client's VT grid (`lines` + cursor) as the
  authoritative pane state for a shell (D2); the scanner ring is the no-client
  fallback.

### Roles (D11)

Exactly one client is the **controller** (may write input / resize); every other
attached client is a read-only **observer**. A second `terminal.attach` with
`role:"controller"` is rejected (`controller_taken`) unless it arrives via
`terminal.handover`. Detaching a controller frees the role. `terminal.handover`
requires the caller to be the current controller and `to` to be an attached
client.

### Attach, replay, detach (D4/D12)

`terminal.attach` takes an optional absolute `cursor` — the offset of the last
byte the client's VT has applied. Omitted means "I have nothing" (a boot/fresh
VT): the whole retained ring is replayed. A number replays only
`[cursor, outCursor)` when the cursor is still inside the ring; a cursor older
than `bufferStart` cannot be honored exactly and the retained ring is replayed
whole with `truncated: true`. It first pushes an `evt terminal.attached` with
`{ shellId, role, replay, replayFrom, cursor, truncated, resetAlt, cols, rows,
status }`, then an `evt terminal.status` with the same status, **then** the
`res`, then live `evt terminal.output` frames. `replay` is base64 of the raw
bytes in `[replayFrom, cursor)`; `cursor` is the shell's total emitted byte
count (the offset to resume from next time); `resetAlt` is true when the client
must clear the alternate screen before writing the replay (full or truncated
attach on the alternate screen). The client applies replay and `terminal.output`
frames as absolute ranges and skips bytes it has already applied, so a duplicate
or overlapping attach is idempotent.

Each `terminal.output` frame carries `cursor`, the absolute offset just past its
`data`. A client that sees a frame whose start exceeds its applied cursor knows
the daemon's bounded outbound queue dropped a frame and re-attaches from the gap
(the replay covers the missing range). `terminal.detach` stops that client's
stream but leaves the shell alive (D4); `terminal.kill` ends it
(`evt terminal.status {dead:true}` then `evt terminal.exit`) and releases its
bound chat (see "Shell-scoped lifetime").

A connection-level `evt hello` (`{ clientId, protocol:"sensus-ws/1", version }`)
is sent on open so a client knows its own id for `terminal.handover`.

### Events

| Event | Payload |
|---|---|
| `hello` | `{ clientId, protocol, version }` (on upgrade) |
| `terminal.output` | `{ shellId, data, cursor }` (base64 PTY bytes + absolute end offset — **raw**, see "Byte transparency") |
| `terminal.attached` | `{ shellId, role, replay, replayFrom, cursor, truncated, resetAlt, cols, rows, status }` |
| `terminal.status` | `{ shellId, status }` — the shell's `TerminalStatus` (see below) |
| `terminal.exit` | `{ shellId, code }` (null when the code is unavailable) |
| `terminal.role` | `{ shellId, clientId, role }` (per attached client) |
| `terminal.shells` | `{ shells }` (the list changed) |
| `trigger` | `{ trigger }` — a matched local condition trigger, `{ v, ts, rule, on, event }` (docs/triggers.md) |

Per-client outbound queues are bounded (drop-oldest) and resume on Bun's
`drain`, so a slow reader cannot OOM the daemon. Dropped output is recoverable:
every `terminal.output` frame carries its end `cursor`, and a client that sees a
gap re-attaches from its last applied offset.

### Terminal status (P4a)

`terminal.status` carries the engine's `TerminalStatus` (`PtySession.status()`,
`src/terminal/ptySession.ts`) so the client's status bar, tab title and chat
context stay current without polling `terminal.list`:

```
{ dead, deadStatus, cols, rows, cwd, currentCommand, alternateOn,
  applicationCursor?, commandRunning?, lastExitCode?, cursorX, cursorY, cursorVisible }
```

It is **event-driven** (no tick): the registry emits when the parsed status
changes — `cwd` via OSC 7, the alternate-screen toggle, the OSC 133
command-running toggle, and death — and forces one emission right after
`terminal.attach` and `terminal.resize`. The status is also included in
`terminal.attached`. `cursorX`/`cursorY` stay `null` unless a client supplied
`terminal.facts` (D2); facts do not clear on detach, so the fallback cursor is
`null` when no client grid is attached.

### Byte transparency (D1/P4a)

The daemon spawns `PtySession` with a **null palette** and no theme defaults, so
its `SgrColorRewriter` is a no-op (bold-bright promotion only applies once a
palette is set) and `terminal.output` carries the **raw PTY bytes**. The client
owns the SGR rewrite (`SgrColorRewriter` against the detected/override palette)
and the `PanePainter` default-background repaint. A daemon path must never apply
a palette or the byte stream would be rewritten twice; the registry's
byte-transparency test guards it.

### Chat, approvals, sudo (P3c-ii)

The daemon hosts one `ChatHost` (lazily — a terminal-only daemon never reads the
config home) and opens a `ChatSession` per chat (`ChatRegistry`,
`src/daemon/chats.ts`). One tab = one shell = one chat: `chat.open` may bind a
`shellId` (a second live chat on the same shell is `shell_taken`). A chat
survives client detach (D4); the transcript JSONL stays on disk and
`chat.open {resume}` reopens it.

Chat events are **per-chat**: `chat.open`/`chat.attach` subscribe the requesting
client, `chat.detach` unsubscribes it (the chat keeps running), and a closed
socket drops all of its subscriptions. `chat.list` is global.

**Shell-scoped lifetime.** A shell's exit (`exit` in the pane, or `terminal.kill`)
releases the chat bound to it (`ChatRegistry.closeForShell`): one tab = one shell
= one chat, so a dead shell's chat can never be re-attached and must not linger
(any in-flight turn is aborted first). A **client** detach or an ordinary tab
close (`Ctrl+W`/`×`) does neither — the shell and its chat stay alive for the
boot re-attach picker. An unsent chat (`empty: true`) has nothing to resume but
its pane is still live, so it stays a candidate: the picker labels it `empty`
and lists it after chats with content, and a lone pane is re-attached silently
— closing an empty tab never masquerades as a resumable session.

| Op | Params | `result` |
|---|---|---|
| `chat.list` | — | `{ chats: [{ chatId, shellId, title, status, empty, lastDetachedAt }] }` (`empty` = no messages yet; `lastDetachedAt` = the bound shell's inactivity clock, `null` while attached) |
| `chat.open` | `{ shellId?, agent?, model?, resume? }` | `{ chatId, state }` |
| `chat.attach` | `{ chatId }` | `{ chatId, state }` |
| `chat.detach` | `{ chatId }` | `{ chatId }` |
| `chat.send` | `{ chatId, text }` | `{ accepted, mode }` — the engine's `handleInput` route (then streams events) |
| `chat.abort` | `{ chatId }` | `{ ok: true }` |
| `chat.compact` | `{ chatId }` | `{ ok: true }` (the engine `/compact`) |
| `chat.retry` | `{ chatId }` | `{ ok: true }` (the engine `/retry`) |
| `chat.revert` | `{ chatId, messageId }` | `{ ok: true }` — rewind to before a user message (pushes `chat.state`) |
| `chat.setModel` | `{ chatId, model }` (`endpoint@model`) | `{ ok: true }` |
| `chat.setAgent` | `{ chatId, agent }` | `{ ok: true }` |
| `chat.setEffort` | `{ chatId, mode }` | `{ ok: true }` |
| `chat.cycleEffort` | `{ chatId }` | `{ ok: true }` |
| `chat.setApproval` | `{ chatId, mode: "confirm"\|"full-auto" }` | `{ ok: true }` |
| `chat.setMcp` | `{ chatId, enabled }` | `{ ok: true }` |
| `chat.trustAdd` | `{ chatId, tool, prefix }` | `{ ok: true }` |
| `chat.trustRevoke` | `{ chatId, tool, prefix }` | `{ ok: true }` |
| `chat.trustRevokeAll` | `{ chatId }` | `{ ok: true }` |
| `chat.planAnswer` | `{ chatId, messageId, decisions: [{ callId, accept }] }` | `{ ok: true }` |
| `approvals.answer` | `{ chatId, callId, action: "accept"\|"reject", addPrefix?, addToSession?, trust? }` | `{ ok: true }` |
| `sudo.answer` | `{ chatId, requestId, password }` | `{ ok: true }` |

`state` = `{ messages, status, plan, pendingApproval, pendingSudo, meta }` — the
full snapshot a (re)attaching client renders from. `meta` is the
engine-derived `ChatMeta` (P4c-ii): see "Engine-derived meta" below.

**Engine-derived meta (P4c-ii).** The daemon derives every readout a remote
chat renders from the live engine session (D13), so the client needs no
in-process engine. `ChatMeta` (verbatim shape):

```
{
  selectedModel, endpointName, modelName, endpoint, hasKey, modelMeta,
  modelSupportsVision, effortSetting,
  contextLimit, contextUsed, cacheRead, contextBreakdown,
  agentName, agentDef,
  approval, trustPatterns, noTools,
  isWorking, compacting, activeJobCount, streamingSince, busyPending,
  mcpEnabled, mcpStatusFacts,
  sessionTitle
}
```

- `endpoint` is the selected endpoint's effective config with `apiKey` redacted
  by the same `redactConfig` the config resource uses.
- `modelMeta` is the models.dev metadata merged with the endpoint override.
- `contextBreakdown` is the full `ContextBreakdown` snapshot (context
  inspector).
- Local display preferences (animations, card style, thinking/tool details,
  drafts, editor/slash state) are deliberately absent — they are client-owned.

The daemon pushes `chat.meta` whenever any meta field changes (a
signature-gated recompute on every engine event except streamed deltas, and
after every mutating op: `open`/`send`/`abort`/`compact`/`retry`/
`approvals.answer`/`sudo.answer`). `chat.open`/`chat.attach` still carry the
full meta in `state`. A title change (the engine `title` event; `sessionTitle`
is part of the signature) is one such field: the auto title resolves *after*
the turn settles, so it arrives as a `chat.meta` with no follow-up `chat.state`
— the client mirrors `meta.sessionTitle` from this event.

**`chat.send` mode (P4a).** `mode` is the engine's own `ChatSession.handleInput`
return, so the daemon never reinterprets busy semantics:
`"sent"` (dispatched), `"steered"`/`"queued"` (accepted while a turn streams,
per `chat.busySend`), `"empty"` (nothing to send), `"busy"` (a slash command /
compaction refused while streaming). `accepted` is true for
`sent`/`steered`/`queued` and false for `empty`/`busy`.

**Terminal context (P4a).** A chat opened with `shellId` wires
`ChatSession.attachTerminal` to the shell, so the per-generation `[terminal]`
context block is no longer dropped: the snapshot's tail is the last client
`terminal.facts` grid while a client is attached (D2), else the scanner ring's
recent lines; cwd/alt-screen come from `TerminalStatus`. The getter never
throws and a gone shell yields no block.

| Event | Payload |
|---|---|
| `chat.state` | `{ chatId, state }` — on `open`/`attach` and when the list is replaced (`/clear`, resume) |
| `chat.meta` | `{ chatId, meta }` — the engine-derived readouts changed (P4c-ii); carries a title change (the engine `title` event) and any `open`/`send`/`abort`/… mutation |
| `chat.message` | `{ chatId, message }` — a message was added or patched (tool status/output/exitCode, usage, plan) |
| `chat.delta` | `{ chatId, messageId, kind: "content"\|"thinking", text }` — one streamed fragment |
| `chat.status` | `{ chatId, status }` |
| `chat.plan` | `{ chatId, message }` — the approval-batch plan card changed |
| `chat.error` | `{ chatId, message }` — an error bubble |
| `chat.done` | `{ chatId }` — a streaming turn settled (status left `streaming`) |
| `approvals.request` | `{ chatId, callId, tool, args, command, destructive }` |
| `approvals.resolved` | `{ chatId, callId, action: "accept"\|"reject"\|"aborted" }` |
| `sudo.request` | `{ chatId, requestId, command, prompt }` |
| `sudo.resolved` | `{ chatId, requestId, ok }` |

**Approvals.** A gated tool call emits `approvals.request` and blocks;
`approvals.answer accept` routes to `ChatSession.resolveCard` (the engine's one
enforcement point), so the destructive floor and the extensions
`ApprovalPolicy` are exactly the built-in ones. `addToSession`/`trust`/
`addPrefix` answer with the engine's `allow`, which records the CARD's offered
operation class — a client can never widen the trusted class (a compound line is
never trustable). A batch of ≥2 gated calls surfaces as `chat.plan` (the plan
card); its per-line decisions are not individual `approvals.request`s.

**Sudo.** The engine's `requestSudo` dep is the same seam the TUI's masked popup
implements; the registry answers it by emitting `sudo.request` and returning a
promise that `sudo.answer` resolves. The request id is engine-generated (carried
on both the `ChatEvent` and the WS event), so the answer correlates without the
registry inventing ids. An empty `password` resolves `null` (declined). A
`chat.abort` resolves any pending prompt as declined. A **socket close** does
not: if the last client leaves, the prompt holds and then aborts on the
approval timeout (D10, "Lifecycle" below). The engine then runs the command
through the askpass helper
exactly as it does in-process — the password is never persisted, never
model-facing, and never written to the transcript.

### Lifecycle

`stop()` closes every client, kills every shell and releases every chat, so
`daemon stop` leaves no orphaned PTY child. The global kill switch (`sensus
kill`; [`operations.md`](operations.md) "Daemon") SIGTERMs every daemon this
user runs — whatever runtime dir each was started with — so the same teardown
runs for all of them.

**Crash containment (locked #6).** `serve` registers its own process-wide
`unhandledRejection` / `uncaughtException` handlers before the listeners exist
(the TUI has handlers; the headless daemon had none, so Bun's fatal default
could drop every pane socket). An escaped rejection is logged at `error` (the
reason stringified defensively) and the daemon **stays alive** — a detached
turn/shell has no owner to retry it. An uncaught exception is unrecoverable: it
is logged with the stack, then the normal `stop()` teardown runs with stop reason
`crash` (a `daemon stopping` record), and the structured log is flushed
(`flushLoggerSync`) before exiting `1` (clients closed, shells/PTYs killed,
listeners removed, socket/pidfile unlinked). The hidden-shell drain path is
contained too: a straggler that holds a pipe is cancelled through its reader —
never `stream.cancel()` on a locked stream, the rejection that once killed the
daemon — and a lost drain race is recorded (`hidden command force-drained`,
warn). `stop()` is idempotent, so an idle exit emits exactly one stopping record.

**Boot catalog warm.** The daemon warms the models.dev index at boot
(best-effort, never blocking the listeners), matching the in-process TUI and
[`config.md`](config.md) "Model catalog cache". A fresh install therefore
resolves the model's real context window and reasoning metadata (the status-bar
`think:` chip) without opening the model picker first; a catalog-version bump
re-resolves any session that read a pre-fetch value.

**Idle exit (D3/D4/D9).** A non-persistent daemon is on-demand. When it has no
attached WS clients it starts a **grace timer** (`SENSUS_DAEMON_GRACE_MS`,
default `300000`; the timer starts at boot too, so a daemon that never gets a
client still exits). A client connecting cancels it. On expiry the daemon
checks for running work:

- **no chat turn running and no live shell** → shut down cleanly: kill every
  shell + chat, close both listeners, remove `daemon.sock`/`daemon.pid`, exit
  `0`;
- **a turn (or a blocked prompt) still running** → keep the daemon alive and
  **re-arm the grace clock when the turn settles**. A **detached turn is never
  aborted** just because the client left.
- **a live pane shell** → keep the daemon alive. The visible pane is the user's
  real terminal, so a client kill/restart must not reap it or a command running
  in it (D1, locked #6; `docs/PRODUCT.md`). The clock re-arms when the last
  shell exits (`shellsChanged`), so an idle daemon with no panes still exits.

A **persistent** daemon (`SENSUS_DAEMON_PERSISTENT=1`, or the config flag
`daemonPersistent`; docs/config.md "daemon") never grace-exits. `sensus daemon
restart` performs a stop + start (`docs/operations.md`).

**Idle reaper / re-attach window.** Independently of the grace exit, the daemon
kills a shell left **inactive** (no attached client — a detached pane) longer
than `SENSUS_DAEMON_REATTACH_MAX_AGE_MS` (default `28800000`, 8h; `0` disables
reaping). The reaper runs once at startup and every `REAP_INTERVAL_MS` (60s) on
an `unref`'d interval, so it also reaps a session left over from a previous
workday in a **persistent** daemon that never exits. `ShellRegistry.abandoned`
(the pure read) returns the idle shells and the daemon kills each one; a shell
that is currently attached is never reaped. Killing a shell releases its bound
chat (one tab = one shell = one chat), so a reaped session is **gone and cannot
be re-attached** — that is the point: re-attach is for a recent detach (a
restart, a crash, a closed laptop), not for a session from days ago. The boot
picker also age-gates its candidates with the same window
(`listAttachCandidates(ws, maxAgeMs)`), a client-side guard against the race
between daemon boot and the first reap tick.

**No-client approvals/sudo (D10).** Pending approval / plan / sudo / `ask_user`
prompts **hold** when no client is attached — they are never declined the
instant the last client leaves. After `SENSUS_DAEMON_APPROVAL_TIMEOUT_MS`
(default `60000`) the daemon records the pending calls as **denied** and aborts
the turn, so a no-client turn can never sit blocked forever and nothing ever
executes unapproved. A client reconnecting during the hold cancels the timer and
can answer normally. `chat.abort` still declines a pending sudo/approval at
once, and when a client that was the only watcher of a blocked chat leaves
while *other* clients remain, that orphaned prompt is denied immediately (no
present client can answer it).

**Version handshake (D21).** `/v1/info` carries `shells` (the live PTY shell
count) and `persistent`. The pure helper `versionMismatchAction(localVersion,
remoteVersion, heldShells)` — exported from the daemon barrel
(`src/daemon/index.ts`) — returns `"ok"` when the versions match, `"restart"`
when the daemon holds no shells, and `"warn"` when it holds shells.

`ensureDaemon` acts on that at boot: `"restart"` stops and replaces the shell-less
daemon silently; `"warn"` returns the mismatch as a `warning` instead of losing
shells. `src/index.tsx` then shows the `DaemonMismatchPrompt` (before the main
renderer, like the resume/attach pickers) so the user chooses restart-and-lose-
shells vs defer. A restart runs `restartAndReconnect` — detach the old client,
stop + respawn the daemon, open a fresh REST + WS client; a defer keeps the old
daemon and re-shows the warning as a toast (`sensus daemon restart` remains the
manual escape hatch).

The chat/approval/sudo channels and the idle-exit policy are implemented (P3c-i/
ii/iii). `daemon install`/`uninstall` (a systemd/launchd user unit that runs the
daemon in persistent mode; P6) is implemented in `src/daemon/service.ts` — see
[`operations.md`](operations.md) "Daemon" for the unit shapes and
[`triggers.md`](triggers.md) for the always-on monitoring layer it enables.

## Gotchas & invariants

- **Two transports, one app.** The UDS and the loopback listener both serve
  `createDaemonApp(...)`; neither is public (D7/D14). The **WS endpoint is
  loopback-only** (Bun's client cannot connect over UDS) — the UDS stays REST.
- **One controller per shell (D11).** Observers are read-only; control moves only
  through `terminal.handover`. The replay buffer is bounded and drop-oldest, and
  every per-client queue is bounded — a slow or hostile client cannot grow the
  daemon's memory.
- **Socket perms matter.** The dir is `0700`, the socket and token `0600`; a
  stale socket left by a crash is unlinked before bind, and `stop`/SIGTERM
  remove it.
- **Every response is secret-free.** `GET /v1/config`, `GET /v1/models` and
  `chat.meta`'s `endpoint` are the only routes that could leak a credential and
  all redact by construction; `GET /v1/secrets` returns names only. Config
  writes never persist a literal secret — `PUT /v1/config` moves one into the
  encrypted store and writes a `${NAME}` reference. This is the P4c-ii write
  surface: bearer-gated, UDS/loopback-only, and defensive (invalid input →
  `400`, a store refusal → `200 {ok:false,message}`, never a crash).
- **The REST sessions resource never mutates a transcript.** It imports only
  read paths from `src/session/store.ts`; the FTS index is never opened (the TUI
  may own it). `GET`s are proven non-mutating by test. The CHAT channel is the
  one writer: the engine appends the turn's JSONL exactly as the TUI does.
- **Approval parity.** A socket answer (`approvals.answer`) goes through
  `ChatSession.resolveCard` — the same enforcement point as the TUI — so the
  destructive floor, session trust, `permission` rules and the extensions
  `ApprovalPolicy` behave identically. The daemon never decides a gate itself.
- **No network egress.** The daemon is loopback-only and makes no outbound calls
  (D8); there is no telemetry.
- **Headless.** `src/index.tsx` loads `src/daemon/cli.ts` lazily, so the TUI boot
  path never pulls in Elysia; the daemon itself imports the engine only
  (`src/engine/index.ts`), never `src/ui/**`.

## Related docs

- [`operations.md`](operations.md) — `sensus daemon` CLI, start/stop/status/logs, runtime dir
- [`architecture.md`](architecture.md) — the daemon layer and the engine/client split
- [`config.md`](config.md) — paths, the runtime dir, secrets/`${NAME}` refs
- [`events.md`](events.md) — the instance identity and the durable event log
- [`triggers.md`](triggers.md) — the local condition triggers over the v1 stream
- [`extensions.md`](extensions.md) — the approval/event seam the daemon consumes
- `src/daemon/openapi.ts` / `src/daemon/apiSchemas.ts` — the OpenAPI/Scalar config and the schemas the REST reference is generated from
