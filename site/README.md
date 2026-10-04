# sensus.sh

The public site for sensus: an Astro 7 static build managed by Bun, deployed by Cloudflare
Pages. The canonical operations doc is [`../docs/operations.md`](../docs/operations.md)
§Website; this file is the quick local guide.

## Layout

```
src/
  content.config.ts       the docs content collection (glob over content/docs/*.md)
  content/docs/<slug>.md  user-manual pages (Markdown only; the slug is the filename)
  data/docs-manifest.json the manual's source of truth: slug · title · order · status · devDoc
  data/generated/         committed reference JSON (keymap · commands · tools)
  layouts/Base.astro      head/meta/OG + the direction contract (first child of <body>)
  layouts/Docs.astro      the /docs shell: manifest sidebar, mobile drawer, on-this-page TOC
  pages/index.astro       the landing page
  pages/404.astro         not-found (docs-aware fallback for unmigrated slugs)
  pages/docs/index.astro  the /docs index (live manifest entries)
  pages/docs/[...slug].astro  renders one content entry per slug
  components/             Nav · TerminalMock · Pane · InstallCommand · Footer · sections/ · generated/
  lib/install.ts          the /install logic (unit-tested)
  styles/tokens.css       the custom ink/paper theme tokens as CSS variables
  styles/global.css       base styles + shared primitives
functions/install.ts      the Pages Function adapter (GET|HEAD /install)
public/                   favicon.svg · robots.txt · _headers · _redirects · og.png
scripts/og.ts             renders src/assets/og.svg -> public/og.png
scripts/readme-svg.ts     regenerates ../assets/ui*.svg from the built mock
```

## Commands

| Command | Purpose |
|---|---|
| `bun install` | install deps |
| `bun run dev` | Astro dev server (http://localhost:4321) |
| `bun run check` | `astro check`: types for `.astro` + TS |
| `bun test` | `/install` unit tests (`src/lib/install.test.ts`) |
| `bun run build` | production build to `dist/` |
| `bunx wrangler pages dev dist` | serve `dist/` + the Pages Function locally |
| `bun run og` | re-render `public/og.png` from `src/assets/og.svg` |
| `bun run readme-svg` | regenerate the README interface SVGs from the built mock (headless Chrome) |

Astro's build-time integration wants Node ≥ 22.12; Bun owns install, dev, and tests.

## Docs

`/docs` is an Astro content collection, Markdown only: one page per file at
`src/content/docs/<slug>.md`, with `src/data/docs-manifest.json` owning slugs, titles, order,
and status. The index and sidebar read the manifest; a page opts into a generated reference
table with a `generated: keymap | commands | tools` frontmatter flag (rendered by
`src/components/generated/`, no MDX). The root unit suite (`tests/unit/docs/`) checks the
manifest, frontmatter, internal links, dev-doc pointers, and generated-JSON freshness.

`src/data/generated/*.json` is generated from the repo-root sources by
`bun run scripts/gen-docs-reference.ts` (run at the repo root, then commit the JSON) — never
edit it by hand. The site build imports only the committed JSON, so Cloudflare never needs
the root dependencies.

## /install

`GET|HEAD /install` serves the installer from the latest GitHub release:

1. the release's `install.sh` asset (staged by `release.yml` from
   `scripts/install-release.sh`);
2. otherwise the installer at the latest release tag (`scripts/install-release.sh`, then
   the pre-split root `install.sh`), never `main`.

The logic is `src/lib/install.ts`; the Function is a thin adapter. Successful responses are
cached at the edge for five minutes.

**The repository is private today.** For staging, set a read-only `GITHUB_TOKEN` secret on
the Pages project (or in the gitignored `.dev.vars` for `wrangler pages dev`); `/install`
then reads the release through the GitHub API. Public installs require the repository and
its releases to be public (the installer downloads binaries from GitHub Releases without a
token), so this is a launch gate. Remove the secret once the repo is public.

## Cloudflare Pages

Git integration, no deploy workflow:

- Root directory `site`, build command `bun run build`, output `dist`.
- Env: `NODE_VERSION=22.12.0`, `BUN_VERSION=1.4.2`.
- Build watch paths: `site/*` plus `package.json`. The install section's `--version` example
  and the hero install command's `latest v…` tag are read from the root `package.json` at
  build time (`astro.config.mjs`), so a release bump must rebuild the site.
- Custom domain `sensus.sh` (same Cloudflare account, so DNS and TLS are automatic). The
  `www` to apex 301 is a Cloudflare Bulk Redirect (Rules -> Bulk Redirects): `_redirects`
  only supports path-based sources, so a domain-level rule is silently skipped.
- Cache: `public/_headers` marks `/_astro/*` as `public, max-age=31536000, immutable`
  (content-hashed filenames) and the favicon/OG image for a day; HTML keeps Pages'
  `must-revalidate` default, so no dashboard cache rules are needed.

## README interface SVGs

`bun run readme-svg` builds the site, serves `dist`, drives headless Chrome, and captures
the mock's `.mock` figure for two states (sidebar + `sshd`, topbar + `disk`) into
`../assets/ui*.svg`. The capture is a DOM walk, not a screenshot: backgrounds, borders,
the stepped panel corners, and every line of text are emitted as SVG primitives with
`textLength` pins, so the examples stay crisp and stable. Re-run it whenever
`TerminalMock.astro` changes.

## Design

[`DESIGN.md`](DESIGN.md) records the visual system: the app's own theme tokens, the type and
spacing scales, the terminal-mock language, and the motion system.
