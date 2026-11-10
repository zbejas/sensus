# Auth — host identity and pairing scopes

## Overview

`sensus auth` is the host-local, network-free half of Sensus Cloud pairing. It creates an
Ed25519 host identity and a local scope policy under `~/.config/sensus/auth/`. The separate
cloud connector reads those files, signs the cloud challenge with the host key, and enforces
the scopes before touching the daemon. The cloud never receives the private key and cannot
write or widen the policy.

This module does not open a socket, store a cloud token, or run a relay. It exists so the
security boundary stays on the Sensus host: the connector lives in the Sensus Cloud project,
but the identity and the authorization decision do not.

## Key files

| File | Purpose |
|---|---|
| `src/auth/cli.ts` | `sensus auth init/identity/scopes/status` command runner |
| `src/auth/identity.ts` | Ed25519 keypair generation, storage, fingerprint, challenge signing/verification |
| `src/auth/policy.ts` | Policy schema, default `view`, scope parsing, cwd allowlist, atomic write |
| `src/auth/scopes.ts` | The canonical scope tags and implied-`view` rules |
| `src/auth/paths.ts` | `<config>/auth` paths, owner-only JSON writes, root refusal |
| `src/auth/index.ts` | Public barrel for the connector/tests |
| `src/cli.ts` | Routes `sensus auth …` before the TUI nest guard |
| `src/index.tsx` | Lazily imports the auth runner (keeps the TUI boot path free of it) |
| `tests/unit/auth/auth.test.ts` | Identity, policy, CLI, permissions, root refusal |

## How it works

### Commands

```bash
sensus auth init [--allow view,chat,control,orchestrator]
sensus auth identity [--json]
sensus auth scopes [--allow view,chat,control,orchestrator]
sensus auth status [--json]
```

- `init` creates the identity if absent and a `policy.json` if absent. If `--allow` is given,
  it also sets the scopes. It never regenerates an existing identity.
- `identity` prints the fingerprint and public key. `--json` is machine-readable.
- `scopes` with no flag prints the current policy. With `--allow`, it writes the new scopes.
- `status` prints identity, fingerprint, policy, scopes, cwd allowlist, and the daemon-start
  flag.

All writes refuse uid 0. Run as the same Unix user that owns the Sensus daemon.

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

The default policy is `view` only, with no daemon start and no cwd allowlist. `chat`,
`control`, and `orchestrator` imply `view`; the canonical order is fixed so diffs are
stable.

### Fingerprint and signature

- Fingerprint: `SHA-256(SPKI DER)`, first 8 bytes, lowercase hex, rendered
  `abcd-efgh-ijkl-mnop`.
- Connector challenge signature: Ed25519 over the UTF-8 bytes
  `sensus-cloud/1\n<nonce>\n<instanceId>`.
- The connector reads the private key from `identity.json`; the cloud stores only the
  public key and verifies every reconnect.

### Scopes

| Scope | Grants |
|---|---|
| `view` | Terminal list/attach as observer/detach; chat list/attach; daemon info/health |
| `chat` | Create chats, send, abort, compact, retry, answer `ask_user`, commit plans, answer approvals |
| `control` | Terminal controller: open/input/resize/facts/detach. No `terminal.kill` from the cloud |
| `orchestrator` | Headless runs: dedicated shell + chat, prompt, prompt answers, cleanup |

The connector loads this file when it connects and enforces it before every RPC/stream.
Restart the connector after changing scopes. The cloud's own scope checks are defense in
depth; this file is the authorization decision.

## Gotchas & invariants

- **Do not regenerate the identity after pairing.** The cloud stores the public key; a new
  key fails every tunnel handshake until the host is re-paired. `init` preserves an existing
  identity and returns an error for a corrupt file rather than replacing it.
- **The private key must never leave the host.** It is `0600`, and no Sensus command prints
  it. `sensus auth identity` prints only the public key.
- **`view` is implied.** A policy with `["chat"]` is normalized to `["view", "chat"]`; the
  connector relies on that rule.
- **Root is refused for writes.** The identity and policy must belong to the Sensus user;
  running `sensus auth init` as root fails with a clear error.
- **No cloud token is stored here.** Pairing with a cloud account and the device token are
  the connector's job. Sensus only owns the host identity, the fingerprint, and the scopes.
- **No egress.** This module has no `fetch`, no WebSocket, and no service installer. The
  connector is installed and supervised by the Sensus Cloud project.
- **`allowedCwd` is empty by default.** A connector that opens a shell with a cwd must be
  granted an absolute allowlisted directory; relative paths and symlink escapes are
  rejected.
- **Widening scopes may require re-pairing.** The cloud intersects the host policy with the
  scopes approved when the host was paired. Narrowing applies on the next connector
  `hello`; widening past the approved set needs the host paired again.
- **The TUI boot path stays light.** `src/index.tsx` imports `src/auth/cli.ts` lazily; do not
  import it from `src/index.tsx` at module scope.

## Related docs

- [`operations.md`](operations.md) — CLI table and where the auth commands sit.
- [`daemon-api.md`](daemon-api.md) — the local daemon token and WS auth the connector uses.
- [`architecture.md`](architecture.md) — module map and the no-egress boundary.
- [`PRODUCT.md`](PRODUCT.md) — the loopback-only daemon decision and the opt-in connector.
