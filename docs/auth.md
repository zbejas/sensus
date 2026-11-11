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
| `src/daemon/cloud/cli.ts` | `sensus cloud pair/status/enable/disable/unpair` |
| `src/daemon/cloud/pairing.ts` | Pairing exchange, whoami preflight, approval polling |
| `src/daemon/cloud/tunnel.ts` | Outbound WSS, challenge signature, heartbeat, reconnect |
| `src/daemon/cloud/broker.ts` | Typed broker: op allowlist, scope checks, trust stripping, run lifecycle |
| `src/daemon/cloud/discovery.ts` / `daemonClient.ts` | Local daemon token/port discovery + one local WS per cloud stream |
| `src/daemon/cloud/client.ts` | Daemon-owned lifecycle: start/stop/reload, lifetime pin |
| `src/daemon/cloud/state.ts` / `paths.ts` | `connection.json` + run registry paths |
| `src/daemon/serve.ts` | Starts/stops the cloud client with the daemon |
| `src/daemon/lifecycle.ts` | A paired tunnel pins the daemon (no idle exit) |
| `tests/unit/cloud/**`, `tests/unit/daemon/cloud*.test.ts` | Pairing, root approval, no-daemon prompt, tunnel handshake/RPC |

## How it works

### Commands

```bash
sensus cloud pair --cloud https://cloud.example [--code ABCD-EFGH] \
  [--allow view,chat,control,orchestrator] [--allow-root] [--no-wait]
sensus cloud scopes [--allow view,chat,control,orchestrator] [--allow-root] [--json]
sensus cloud status [--json]
sensus cloud disable | enable | unpair
```

- `pair` creates the identity and policy when missing, pairs, stores the token, and
  then asks whether to install/enable the daemon's **user** service if no daemon is
  running. The service runs as the user who ran the command.
- Without `--allow`, an interactive `pair` lists the scopes (`view`, `chat`, `control`,
  `orchestrator`) with a short explanation and asks which to grant. The default is
  `view,chat,control`; non-interactive pairing keeps the safe `view` default.
- `--code` is optional on a TTY: the CLI prompts with echo disabled.
- `scopes` shows the local policy; with `--allow`, it writes new scopes and reloads the
  daemon so the broker picks them up. Narrowing needs no new pairing code. The cloud caps
  host scopes at the set approved when the host paired, so widening beyond that set (for
  example a view-only pairing) needs a new pairing code and
  `sensus cloud pair --allow view,chat,control`.
- `status` reports the pinned origin, instance, fingerprint, scopes, Unix user/root,
  and the live tunnel state. It never prints the device token or private key.
- `disable` keeps the pairing but stops the tunnel; `unpair` removes the local token
  and leaves the identity/scopes.
- `sensus auth …` was folded into `sensus cloud`; it now prints a migration error.

### Root approval

Pairing and host-scope writes as root are refused by default. `--allow-root` (or an
interactive `yes`) records the approval and the connection stores `runsAsRoot: true`.
The daemon then prints a boot warning, `sensus cloud status` shows it, and the cloud
Fleet panel marks the instance as root. Root is allowed for single-user homelabs; it is
never the quiet default.

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
  "maxStreams": 8
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
  "clientVersion": "0.2.1",
  "unixUser": "alice",
  "uid": 1000,
  "runsAsRoot": false,
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
| `view` | Terminal list/attach as observer/detach; chat list/attach; daemon info/health |
| `chat` | Create chats, send, abort, compact, retry, answer `ask_user`, commit plans, answer approvals |
| `control` | Terminal controller: open/input/resize/facts/detach. No `terminal.kill` from the cloud |
| `orchestrator` | Headless runs: dedicated shell + chat, prompt, prompt answers, cleanup |

The cloud intersects the host policy with the scopes approved at pairing; the
host broker still enforces the policy for every op. Restart/reload the daemon after
changing scopes (`sensus cloud` reloads automatically; otherwise restart it).
Widening past the approved set requires pairing the host again.

## Gotchas & invariants

- **Do not regenerate the identity after pairing.** The cloud stores the public key;
  a new key fails every tunnel handshake until the host is re-paired. `pair`
  preserves an existing identity and errors on a corrupt file rather than replacing it.
- **The private key must never leave the host.** It is `0600`, and no command prints it.
- **`view` is implied.** A policy with `["chat"]` normalizes to `["view", "chat"]`.
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
