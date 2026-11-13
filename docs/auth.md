# Cloud pairing — host identity, scopes, embedded tunnel

## Overview

`sensus cloud pair` is the host-local half of Sensus Cloud pairing. It creates an
Ed25519 host identity and a local scope policy under `<config>/auth/`, exchanges a
one-time pairing code with the panel, and stores the device token under
`<config>/cloud/connection.json` (`0600`). The `sensus` daemon then owns one
outbound WebSocket to the pinned cloud origin. There is no separate connector
binary and no inbound port.

The private key never leaves the host. The cloud stores only the public key and
verifies a fresh challenge signature on every reconnect, so a stolen device token
alone cannot authenticate.

## Key files

| File | Purpose |
|---|---|
| `src/auth/identity.ts` | Ed25519 keypair generation/storage, fingerprint, challenge signing/verification |
| `src/auth/policy.ts` | Policy schema, default `view`, scope normalization, cwd allowlist, atomic write |
| `src/auth/scopes.ts` | Canonical scope tags and implied-`view` rules |
| `src/auth/paths.ts` | `<config>/auth` paths, owner-only JSON writes, root helpers |
| `src/daemon/cloud/cli.ts` | `sensus cloud pair/status/doctor/enable/disable/unpair` |
| `src/daemon/cloud/pairing.ts` | Pairing exchange, whoami preflight, approval polling |
| `src/daemon/cloud/tunnel.ts` | Outbound WSS, challenge signature, heartbeat, reconnect |
| `src/daemon/cloud/probe.ts` | HTTPS probe of `/api/connector` when a WS upgrade fails (HTTP status/content type) |
| `src/daemon/cloud/broker.ts` | Typed broker: op allowlist, trust stripping, run lifecycle, bounded transcript/memory ops |
| `src/daemon/cloud/ops.ts` | `TUNNEL_OPS` op → scope (+ `deleteTranscripts` policy gate) table consulted before the switch |
| `src/daemon/cloud/discovery.ts` / `daemonClient.ts` | Local daemon token/port discovery + one local WS per cloud stream |
| `src/daemon/cloud/client.ts` | Daemon-owned lifecycle: start/stop/reload, lifetime pin |
| `src/daemon/cloud/reconcile.ts` | Repairs a missing user or root system service for an existing pairing (update/daemon/TUI boot; never starts a second daemon) |
| `src/daemon/cloud/state.ts` / `paths.ts` | `connection.json` + run registry paths |
| `src/daemon/systemService.ts` | Root-owned `/etc/systemd/system/sensus.service` (Linux systemd): render/install/uninstall, `/run/sensus`, no lingering |
| `src/daemon/serve.ts` | Starts/stops the cloud client with the daemon |
| `src/daemon/lifecycle.ts` | A paired tunnel pins the daemon (no idle exit) |
| `tests/unit/cloud/**`, `tests/unit/daemon/cloud*.test.ts` | Pairing, root approval, service install/linger/reconcile, tunnel handshake/RPC |

## How it works

### Commands

```bash
sensus cloud pair --cloud https://cloud.example [--code ABCD-EFGH] \
  [--allow view,chat,control,orchestrator] [--allow-root] [--no-wait] \
  [--no-service] [--no-linger] [--root|--user]
sensus cloud scopes [--allow view,chat,control,orchestrator] [--delete-transcripts on|off] [--allow-root] [--json]
sensus cloud status [--json]
sensus cloud doctor [--json]
sensus cloud disable | enable | unpair
```

- `pair` creates the identity and policy when missing, pairs, stores the token, and
  then makes the daemon ready. A root shell defaults to the root-owned **system**
  service (`/etc/systemd/system/sensus.service`, `/root/.config/sensus`,
  `/run/sensus`); `--user` keeps the per-user service even as root, and `--root`
  forces the system service from any shell (uid 0). `--root` implies root approval
  and rejects `--linger`. A running daemon is reloaded and a missing matching unit
  is installed/enabled without starting a second daemon. With no daemon running,
  pair installs/enables the chosen service and starts it. The user service tries
  systemd lingering on Linux; the system service starts at boot. If the service
  manager is unavailable (a container, an unsupported platform), pairing falls
  back to a detached `sensus daemon start` for the current session and says the
  daemon will not restart after a reboot. `--no-service` skips the unit and only
  starts the daemon for the session; `--no-linger` skips the lingering attempt.
  Before switching a root shell to the system service, pair prompts to stop root's
  existing user daemon/service; a daemon owned by another account is reported with
  the exact commands and aborts. After a reload or a service install it polls the
  daemon until the tunnel reports `connected: true`
  (20 s by default) and exits non-zero with the daemon's `lastError` when it does
  not; `--no-wait` saves the pairing and returns immediately. A running daemon that
  reads another config home or runs as another uid is refused before pairing.
- Without `--allow`, an interactive `pair` lists the scopes (`view`, `chat`, `control`,
  `orchestrator`) with a short explanation and asks which to grant. The default is
  `view,chat,control`; non-interactive pairing keeps the safe `view` default.
- `--code` is optional on a TTY: the CLI prompts with echo disabled.
- `scopes` shows the local policy; with `--allow`, it writes new scopes and reloads the
  daemon so the broker picks them up. Narrowing needs no new pairing code. The cloud caps
  host scopes at the set approved when the host paired, so widening beyond that set (for
  example a view-only pairing) needs a new pairing code and
  `sensus cloud pair --allow view,chat,control`.
- `--delete-transcripts on|off` sets the host-local destructive opt-in described under
  "Cloud reads" below. Turning it on prints an explicit warning: deleted transcripts are
  removed **permanently with no trash** and disappear from session search. The policy write
  keeps the existing uid/root protections (`--allow-root`, otherwise refused as root).
- `status` reports the pinned origin, instance, fingerprint, scopes, Unix user/root,
  and the live tunnel state. It never prints the device token or private key. The
  JSON includes the CLI's `home`/`runtimeDir` and a `daemon` object with the
  running daemon's `version`, `home`, `uid`/`unixUser`, `probeError`; a timeout or non-200 from
  `GET /v1/cloud/status` is reported as `daemon.state: "error"` and exits non-zero
  instead of silently leaving the tunnel state unknown. A daemon home/uid/version
  mismatch is also surfaced (`homeMismatch`, `userMismatch`, `versionMismatch`).
- `doctor` checks the pairing, identity/fingerprint, policy, daemon reachability,
  home/uid/version match, tunnel state/`lastError`, HTTPS `whoami`, the WebSocket
  upgrade, and systemd lingering. `--json` emits `{ ok, home, runtimeDir, checks }`;
  any `fail` check exits non-zero and a `warn` does not.
- `disable` keeps the pairing but stops the tunnel; `unpair` removes the local token
  and leaves the identity/scopes.
- `sensus auth …` was folded into `sensus cloud`; it now prints a migration error.

### Upgrading an existing pairing

A host paired before `cloud pair` installed the service is repaired after an
update. The same reconciliation (`src/daemon/cloud/reconcile.ts`) runs from
`sensus update` after the installer succeeds, on every daemon boot, and on the
TUI boot (which covers an old daemon that is still running). If `connection.json`
is paired and enabled and the matching unit is missing, it writes/enables the
unit with `startNow: false` (never starting a second daemon) and leaves the
running daemon and its shells alone; the unit takes over at the next
login/boot. A root process targets the system unit (`/etc/systemd/system/sensus.service`,
`startNow: false`); a root `--user` pairing keeps the per-user unit. The user
scope attempts lingering. A missing unit in a container/non-systemd host is
reported as unsupported rather than retried on every boot. Failures are
best-effort and never fail the update or the boot; `sensus cloud doctor` still
reports the tunnel and lingering state.

### Root approval

Pairing and host-scope writes as root are refused by default. `--allow-root` (or an
interactive `yes`) records the approval and the connection stores `runsAsRoot: true`.
The daemon then prints a boot warning, `sensus cloud status` shows it, and the cloud
Fleet panel marks the instance as root. A root shell defaults to the root-owned
system service, and `--root` itself is the explicit root approval: it pairs as
root and installs `/etc/systemd/system/sensus.service` without a separate
`--allow-root`. A root `--user` pairing keeps the per-user service and still
requires `--allow-root`/interactive approval; it warns about lingering. Root is
allowed for single-user homelabs; it is never the quiet default.

### Diagnosing "paired but never connected"

Pairing and `whoami` use HTTPS; the tunnel is a separate WSS upgrade to
`/api/connector`. A reverse proxy can forward pairing and still strip `Upgrade`, so
a paired/offline host has several distinct causes. Use `sensus cloud doctor` first;
it keeps them separate:

| Check | What a failure means |
|---|---|
| `pairing` / `identity` / `policy` | Local state is missing, corrupt, or the key no longer matches the cloud's fingerprint |
| `daemon` | No local daemon, or its local API is wedged/unreachable |
| `home` / `user` | A daemon is running, but for another config home or Unix account; it will never read this pairing |
| `version` | A stale daemon binary; `reload` is in-process and cannot replace it — restart the daemon |
| `tunnel` | The daemon's tunnel state and `lastError` (the real connection failure) |
| `whoami` | The HTTPS half: active, pending approval, revoked, or unreachable |
| `wss` | The HTTP answer to the tunnel upgrade (401/403/3xx/HTML) — a proxy/edge problem rather than a daemon problem |
| `linger` | A systemd user service stops at logout unless `loginctl enable-linger <user>` is set |

When a socket closes before its `open` event, the tunnel probes
`/api/connector` over HTTPS with `Connection: Upgrade` (no redirects, so a proxy
login page never receives the device token) and logs the status/content type, e.g.
`cloud tunnel upgrade failed: HTTP 403 text/html`. If Cloudflare Access is in front
of the panel, `/api/connector` itself must be bypassed — not only
`/api/connector/pair` and `/api/connector/whoami`.

A pairing as root defaults to the root-owned system unit
(`/etc/systemd/system/sensus.service`, `/run/sensus`) and needs no lingering.
`--user` keeps the root user service instead, which does need lingering. See
[`operations.md`](operations.md) "Persistent service".

### Files

`<config>/auth/identity.json` (`0600`):

```json
{
  "version": 1,
  "publicKey": "<base64 SPKI DER>",
  "privateKey": "<base64 PKCS8 DER>",
  "fingerprint": "abcd-efgh-ijkl-mnop",
  "createdAt": 1794329831253
}
```

`<config>/auth/policy.json` (`0600`):

```json
{
  "version": 1,
  "scopes": ["view", "chat"],
  "startDaemon": false,
  "allowedCwd": [],
  "maxStreams": 8,
  "deleteTranscripts": false
}
```

`<config>/cloud/connection.json` (`0600`):

```json
{
  "version": 1,
  "cloud": "https://cloud.example",
  "instanceId": "inst_…",
  "deviceToken": "…",
  "fingerprint": "abcd-efgh-ijkl-mnop",
  "name": null,
  "pairedAt": 1794329831253,
  "scopes": ["view", "chat"],
  "clientKind": "sensus-daemon",
  "clientVersion": "0.2.2",
  "unixUser": "alice",
  "uid": 1000,
  "runsAsRoot": false,
  "serviceScope": "user",
  "enabled": true
}
```

The default policy is `view` only. `chat`, `control`, and `orchestrator` imply
`view`; the canonical order is fixed so diffs are stable.

### Multiple daemons, one cloud

Each daemon has its own config home, runtime dir, identity, and token. Pairing as
root uses `/root/.config/sensus`; pairing as alice uses
`/home/alice/.config/sensus`. Both can connect to the same cloud panel and appear
as separate instances (the cloud names them `host (root)` / `host (alice)` unless
the pairing code supplied a name). This is the supported multi-daemon model; a
single root daemon switching users is deliberately not supported.

### Fingerprint and signature

- Fingerprint: `SHA-256(SPKI DER)`, first 8 bytes, lowercase hex, rendered
  `abcd-efgh-ijkl-mnop`.
- Tunnel challenge signature: Ed25519 over the UTF-8 bytes
  `sensus-cloud/1\n<nonce>\n<instanceId>`.
- The daemon reads the private key from `identity.json`; the cloud stores only the
  public key and verifies every reconnect.

### Scopes

| Scope | Grants |
|---|---|
| `view` | Terminal list/attach as observer/detach; chat list/attach; daemon info/health; bounded transcript list/read/export/context; memory list/read |
| `chat` | Create chats, send, abort, compact, retry, answer `ask_user`, commit plans, answer approvals |
| `control` | Terminal controller: open/input/resize/facts/detach. No `terminal.kill` from the cloud. Also memory writes and (with `deleteTranscripts`) transcript deletion |
| `orchestrator` | Headless runs: dedicated shell + chat, prompt, prompt answers, cleanup |

The cloud intersects the host policy with the scopes approved at pairing; the
host broker still enforces the policy for every op. Restart/reload the daemon after
changing scopes (`sensus cloud` reloads automatically; otherwise restart it).
Widening past the approved set requires pairing the host again.

The broker's op → scope table is `src/daemon/cloud/ops.ts` (`TUNNEL_OPS`). `RelayBroker.rpc`
consults it **before** its switch and answers `unknown_op` for anything absent, so adding a
RPC case without a table row cannot widen the surface. `BLOCKED_OPS` (`terminal.kill`,
`chat.setApproval`, trust mutations, `chat.revert`, `chat.setMcp`, `sudo.answer`) stays
first and is never allowed whatever the scopes.

### Cloud reads: transcripts, memory, and chat images

`hello.features` advertises `transcript.read`, `memory.read`, `memory.write`, and
`chat.images` always (the embedded broker validates and forwards images);
`transcript.delete` is advertised only when `deleteTranscripts` is true. The ops are bounded
in-process reads of the same data the TUI uses; none of them proxies arbitrary REST.

`chat.send` may carry `images: [{ name, mediaType, data }]` with base64 data. The broker
accepts PNG/JPEG/WebP/GIF only, at most 2 images, 1.25 MiB each and 2.5 MiB total raw. It
strictly validates canonical base64 and sniffs the magic bytes; a mismatched label is
`invalid_request`. The cloud upload route enforces the same caps. Outbound image records on
`chat.message`/`chat.state`/`chat.plan` are reduced to `{ id, name, mediaType, bytes, width?, height? }`
before they reach the cloud, so an absolute host `path` never leaves the machine.

| Op | Scope | Result (bounded) |
|---|---|---|
| `transcript.list` | `view` | `{ sessions, nextOffset }`; newest-first, limit 1–50 (default 20); rows never include the absolute `path` |
| `transcript.read` | `view` | `{ id, title, tags, total, offset, messages }`; message window 1–50 (default 20); each `content` clipped to 16 000 chars with `truncated`; `thinking`/`images`/`usage` omitted |
| `transcript.export` | `view` | `{ content, contentType, truncated, bytes }`; md or raw jsonl, hard-capped at 2 MiB with the original byte length in `bytes` |
| `transcript.context` | `view` | `{ id, title, breakdown }`; the engine `ContextBreakdown`, history capped to 120 rows and previews to 160 chars |
| `transcript.delete` | `control` + `deleteTranscripts` | `{ ok: true, id }`; refused as `delete_disabled` without the flag and `session_open` while a live chat appends to it. Permanent: JSONL + sidecar + FTS rows, no trash |
| `memory.list` | `view` | `{ targets }` usage for MEMORY/HOST/JOURNAL |
| `memory.read` | `view` | `{ target, content, entries, usage }`; content capped at 64 KiB (`truncated`), entries at 200 |
| `memory.write` | `control` | The store's result verbatim; required fields match `POST /v1/memory/:target`; content over 64 KiB is `invalid_request`; a committed write emits one `memory-write` audit event |

A transcript id is `<instance>/<base>` split on the first `/`; both segments must be a safe
single path component. Traversal (`../x`, `a/b/c`) is `not_found`. A store-domain refusal
(cap full, ambiguous `old_text`) comes back as a normal `rpc.res` whose result has
`ok:false`, exactly like the REST route's 200.

### Cloud config profile pull

The cloud may assign a narrowing-only config profile to a paired instance. The host pulls
it read-only from `GET /api/connector/config` (device token + `X-Sensus-Instance`) on tunnel
ready and, at most once a minute, when `status()` is read. The pull is optional: a failure,
an unsupported `version`, or a malformed profile keeps the last cached value (or `null`) and
never fails the tunnel.

The response is `{ version: 1, profile: { id, name, updatedAt, scopes, deniedFeatures,
chatApproval, conductorApprovals, maxStreams } | null, serverTime }`. The host caches by
`profile.updatedAt` and exposes the profile through `/v1/cloud/status` and
`sensus cloud status`. It intersects the profile's scopes with the local policy and clamps
`maxStreams`, so a broken or malicious cloud response can only narrow, never widen. A pull
never writes `policy.json` or Sensus config; the cloud enforces its ceiling and the host
broker remains the enforcement point.

## Gotchas & invariants

- **Do not regenerate the identity after pairing.** The cloud stores the public key;
  a new key fails every tunnel handshake until the host is re-paired. `pair`
  preserves an existing identity and errors on a corrupt file rather than replacing it.
- **The private key must never leave the host.** It is `0600`, and no command prints it.
- **`view` is implied.** A policy with `["chat"]` normalizes to `["view", "chat"]`.
- **A cloud config profile is a ceiling, not host config.** The host pulls it for display
  and narrows its own view; it never writes `policy.json` or Sensus config, and a failed
  pull keeps the last cached profile.
- **Root is opt-in for pairing.** Identity/policy writes default-refuse uid 0; the
  daemon itself runs as root only because the user started it that way.
- **No inbound listener.** The host dials one outbound WSS to the pinned origin.
  The cloud never gets a URL to dial back, and no cloud frame can change the origin.
- **`unixUser`/`runsAsRoot` are self-reported metadata.** The cloud shows them for
  disambiguation (root vs uid 1000 on one host), but the authorization boundary is the
  process owner, the host key, and the local policy.
- **One pairing per config home.** Multiple daemons = multiple config homes.
- **A paired tunnel pins the daemon.** It does not idle-exit while the pairing is
  enabled; install the user service for reboot persistence.
- **No token expiry yet.** Revocation is immediate in Fleet (`4401`); re-pair to
  rotate the token.
- **Legacy connector pairings are not auto-imported.** The standalone
  `sensus-cloud` connector package has been removed; a host moving from it must
  re-pair with `sensus cloud pair`. The old token lives in the connector's own
  home and is no longer read.

## Related docs

- [`operations.md`](operations.md) — CLI table, service install, lifecycle.
- [`daemon-api.md`](daemon-api.md) — the local daemon token/WS and `/v1/cloud/*`.
- [`architecture.md`](architecture.md) — module map and the egress boundary.
- [`PRODUCT.md`](PRODUCT.md) — the opt-in cloud decision.
