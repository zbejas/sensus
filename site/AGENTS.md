# sensus.sh — site AGENTS.md

`site/` is its own Bun project: the Astro 7 landing site for sensus.sh plus the `/install`
Pages Function. The repo-root [`AGENTS.md`](../AGENTS.md) non-negotiables still apply. Local
references: [`README.md`](README.md) (layout, commands, Cloudflare) and
[`DESIGN.md`](DESIGN.md) (the visual system).

## Commands and gates

| Command | Purpose |
|---|---|
| `bun run dev` | Astro dev server (http://localhost:4321) |
| `bun run check` | `astro check` — types for `.astro` + TS |
| `bun test` | `/install` unit tests (`src/lib/install.test.ts`) |
| `bun run build` | production build to `dist/` |
| `bun run og` · `bun run readme-svg` | regenerate `public/og.png` · the README interface SVGs |

Gate for any `site/**` change: `cd site && bun run check && bun test && bun run build` (the CI
`site` job) plus the root `bun run typecheck` + `bun run test:unit`. Site changes never need
the app smoke suite ([`../docs/testing.md`](../docs/testing.md) §site).

## Hard rules

- **No imports from the repo-root `src/`.** Cloudflare builds `site/` with site dependencies
  only. A fact that needs root source arrives as committed data under `site/src/data/`.
- **Generated data is never hand-edited.** `src/data/generated/*.json` comes from the root
  `scripts/gen-docs-reference.ts`; a root unit test fails when it is stale.
- **One source of truth:** `src/data/docs-manifest.json` owns doc slugs, order, and README
  URLs. The sidebar reads it; nothing writes order per page.

## User docs (`/docs`)

The user manual lives at `/docs` (Astro content collection, Markdown only):

```
src/content/docs/<slug>.md   one file per page; the slug is the filename
src/data/docs-manifest.json  slug · title · order · devDoc · status
src/data/generated/          committed reference JSON generated from the root src/
src/pages/docs/              the /docs index + the [...slug] renderer
```

- **Audience: users.** No file paths, function names, env vars, internal identifiers, or bare
  counts. Mechanism and internals live in the repo [`docs/`](../docs/README.md) KB; a user
  page states behavior and links on.
- **Frontmatter:** `title`, `description`, `order`; the slug comes from the filename — no
  `slug:` key.
- **Links:** every internal `/docs/<slug>` link resolves to a manifest slug; the root unit
  suite checks this.
- **Keep it current.** A behavior change updates the page for it in the same change, plus
  the affected README front-door copy or links. The root `tests/unit/docs/**` suite guards
  manifest, frontmatter, dev-doc pointer, and README-link invariants; run
  `bun test tests/unit/docs/` from the repo root when touching docs or the README.
- **Voice and visuals:** match the landing site and `DESIGN.md`; use the CSS variables in
  `src/styles/tokens.css`, never raw colors.

## Where to look

| If you are… | Read |
|---|---|
| Changing visuals or motion | [`DESIGN.md`](DESIGN.md) |
| Changing the build, `/install`, or Cloudflare | [`README.md`](README.md) → [`../docs/operations.md`](../docs/operations.md) §Website |
| Writing user docs | this file §User docs → `src/data/docs-manifest.json` |
| Touching the app instead | [`../AGENTS.md`](../AGENTS.md) |
