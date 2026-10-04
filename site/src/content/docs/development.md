---
title: Build from source
description: Clone sensus, run it from source, build the standalone binary, and run the test suites.
order: 14
---

Everything on this page starts from a checkout of the repository:

```sh
git clone https://github.com/zbejas/sensus.git sensus
cd sensus
```

## Requirements

- Linux or macOS on x86_64 or aarch64.
- **Bun** ≥ 1.4.1 to run from source, and ≥ 1.4.2 to build the standalone binary. The older
  bundler emits a binary that fails at startup; `bun upgrade` fixes it.
- **Node.js** ≥ 22.12 only if you build the website.

The release installer needs none of these: shipped binaries embed the runtime. See
[Install](/docs/install/) if you would rather not build.

## Run from source

```sh
bun install
bun run dev
```

## Build the standalone binary

```sh
bun run build                    # dist/sensus
bun run build --outfile /tmp/sensus
```

The result embeds the runtime and its dependencies, so it runs on a machine with neither Bun
nor `node_modules`. On macOS the build ad-hoc signs the binary so the system will launch it.

## Build and install

```sh
./scripts/build-install.sh       # asks: this user (~/.local/bin) or all users (/usr/local/bin)
./scripts/build-install.sh -g    # install system-wide without asking
```

From a checkout you can also install a prebuilt release instead:

```sh
./scripts/install-release.sh
```

## Run the tests

```sh
bun run typecheck      # types only
bun run test:unit      # unit suite: the day-to-day loop
bun run test:smoke     # boots the real app in an outer terminal driver; reaps stale processes first
bun test               # the full suite, unit and smoke
```

The smoke suite drives the real TUI, so it needs a working terminal environment, and it is
the final gate for changes that affect runtime behavior.

## The website

The landing site is its own project:

```sh
cd site
bun install
bun run dev        # http://localhost:4321
bun run check      # types
bun test           # installer-function tests
bun run build      # production build
```

Website builds need Node.js ≥ 22.12.

## Engineering docs

The contributor knowledge base lives in the repository at
[github.com/zbejas/sensus/tree/main/docs](https://github.com/zbejas/sensus/tree/main/docs).
Start with the architecture overview, then the doc for the subsystem you are touching; each
doc names the files it owns and the invariants to keep.

## Next steps

- [Install](/docs/install/): the prebuilt path instead of building
- [CLI](/docs/cli/): the commands the binary ships
- [Troubleshooting](/docs/troubleshooting/): build and install failures
- [Changelog](/docs/changelog/): release notes
