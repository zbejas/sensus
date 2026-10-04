# Licensing

User guide: https://sensus.sh/docs/license/

Sensus is licensed under the **Apache License 2.0** — the entire repository, with no
open-core split, no `ee/` tree, and no CLA. Every file (`src/`, `tests/`, `scripts/`,
`docs/`, and the root files) is under the same terms.

## Key files

| File | Purpose |
|---|---|
| [`LICENSE`](../LICENSE) | The full Apache-2.0 text (`Copyright 2026 Anže Mavrič`) |
| [`NOTICE`](../NOTICE) | The copyright line and the OpenCode attribution |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Inbound = Apache-2.0, no CLA (DCO sign-off) |
| `package.json` `license` | `Apache-2.0` — the machine-readable statement |

## Contributions

Contributions are accepted under **Apache-2.0** with **no CLA** — inbound equals outbound.
We ask for a DCO-style `Signed-off-by` line (`git commit -s`). See
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Attribution

Sensus is inspired by **OpenCode** (MIT, `Copyright (c) 2025 opencode`); some harness and
TUI behaviors follow it. The credit is recorded in [`NOTICE`](../NOTICE). Everything else is
original to Sensus.

Bundled dependency licences are checked by `bun run license:check` (allow-list: MIT,
Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC).

## Gotchas & invariants

- **No `if (licenseKey)` anywhere.** No gated branch, no crippled mode, no per-seat limit.
- **No telemetry, no outbound calls by default.**
- **A future control plane, if any, is a separate repository** — do not add an `ee/`
  directory or a licence-key branch here.

## Related docs

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor gates (DCO, no CLA)
- [`../NOTICE`](../NOTICE) — attribution
- [`../README.md`](../README.md) — the user-facing licence line
