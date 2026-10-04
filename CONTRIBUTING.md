# Contributing to Sensus

Thanks for wanting to help. Sensus is **Apache-2.0, in full** — there is no open-core
split and no CLA. If you only want to use sensus, none of this applies to you.

## Before you start

- Read [`AGENTS.md`](AGENTS.md) (task routing + the non-negotiable rules), then
  [`docs/architecture.md`](docs/architecture.md).
- Open an issue for anything non-trivial before writing a large pull request.

## Docs

Two audiences, two homes:

- **User docs** live on the site: **https://sensus.sh/docs** (`site/src/content/docs/`). They
  describe behavior only — no file paths, function names, env vars, or internal identifiers.
- **Engineering docs** live in [`docs/`](docs/README.md): internals, invariants, key files,
  gotchas. Start at [`docs/architecture.md`](docs/architecture.md).

A dev doc with a user page carries a `User guide:` line linking it; when a fact needs both,
the dev doc states the mechanism and the site page states the behavior
([`docs/TEMPLATE.md`](docs/TEMPLATE.md)).

## Licence (no CLA)

Contributions are accepted under the project's **Apache-2.0** terms — inbound equals
outbound. There is **no Contributor Licence Agreement** and no separate agreement to sign:
the whole project is Apache-2.0, so there is no other licence to grant rights to.

We ask for a **DCO-style sign-off** on your commits:

```
Signed-off-by: Your Name <you@example.com>
```

Add it with `git commit -s`. The sign-off certifies the [Developer Certificate of
Origin](https://developercertificate.org/): that you wrote the contribution, or that you
otherwise have the right to submit it under the Apache-2.0 licence. A plain "this
contribution is Apache-2.0" in the PR description is also accepted if you prefer not to
sign off commits.

By opening a PR you confirm the contribution is your original work (or that you have the
right to submit it) and that it may be distributed under Apache-2.0.

## Gates

- TypeScript strict mode, ESM, named exports; no `any` without a justifying comment.
- Run `bun run typecheck` and `bun run test:unit` before opening a PR (behavior changes: the
  full `bun test`, per [`docs/testing.md`](docs/testing.md)).
- If you add or change a dependency, run `bun run license:check` — the bundled runtime set
  must stay within {MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC}
  ([`docs/licensing.md`](docs/licensing.md)).
- Behavior changes update the affected doc in `docs/` in the same change.

## What not to send

- Vendored or copied code without a clear licence and attribution. Derived work must be
  recorded in [`NOTICE`](NOTICE) and in a per-file source comment.
- A `ee/`-style commercial directory or a `licenseKey` branch. A future control plane
  lives in a separate proprietary repository, never here
  ([`docs/licensing.md`](docs/licensing.md)).

## Related

- [`docs/licensing.md`](docs/licensing.md) — the licence, the allow-list, and the release contents
- [`LICENSE`](LICENSE) — Apache-2.0
- [`NOTICE`](NOTICE) — attribution
