---
title: Install
description: Get sensus running on Linux or macOS with one command, then let the setup wizard configure your first endpoint.
order: 1
---

Sensus runs as a standalone binary on Linux and macOS, locally or over SSH. The release binary embeds its runtime, so there is nothing else to install first: no Bun, no package manager, no shell configuration.

## Install with one command

```sh
curl -fsSL https://sensus.sh/install | bash
```

The installer detects your platform, downloads the matching binary, verifies it against the release checksums, and installs it to `~/.local/bin`. If that directory is not searched by your shell, it prints the line to add to your shell profile. It also writes a starter config to `~/.config/sensus/config.json` unless one already exists. Running the command again is safe: the binary is replaced and your config is left alone.

The installer needs `curl` (or `wget`) and a checksum tool, both of which are usually present already. Bun is not needed.

### System-wide install

```sh
curl -fsSL https://sensus.sh/install | bash -s -- -g
```

`-g` installs to `/usr/local/bin` instead, using `sudo` when needed.

### Pin a release

```sh
curl -fsSL https://sensus.sh/install | bash -s -- --version <tag>
```

Pass `--version` with a release tag to install that release instead of the latest.

## Requirements

- Linux or macOS on x86_64 or aarch64.
- A terminal of at least 20×5: sensus refuses to start in anything smaller.
- SSH works; sensus is a normal full-screen terminal application, so just give the session an adequate size.

Bun is only needed when building from source; the release binary does not use it.

## First run

```sh
sensus
```

A plain first run opens the guided setup inside the app. It walks through the provider, endpoint name, base URL and API key, tests the connection, lets you pick a model, previews a theme, and offers a read-only scan of the machine that seeds the agent's map of it. Nothing is written until you confirm the review step; after saving, a short welcome tour shows you the layout and hotkeys, and leaves you in the running app.

Reopen setup whenever you like:

- `sensus init`: starts sensus with the setup wizard open.
- `/init-wizard` in the chat, or `Ctrl+P` → Setup wizard.

Everything setup writes stays editable afterwards in the settings screen (`Ctrl+O`) or in `~/.config/sensus/config.json`. See [Configuration](/docs/configuration/).

For a headless scaffold without the TUI (useful in scripts), `sensus init --create-config` writes the starter config only and never overwrites an existing one.

## Update

```sh
sensus update
```

Updates to the latest release in place (alias: `sensus upgrade`). `sensus update --check`
only reports whether a newer release exists, and `sensus update --version <tag>` installs a
specific one. Your config, sessions, and memory are untouched. From a source checkout it
prints the git-based update instead.

Sensus also notices a newer release at launch and shows a short reminder; you can turn that
check off with `"updateCheck": false` in your configuration. Re-running the install command
works too — the binary is replaced either way.

## Next steps

- [Configuration](/docs/configuration/): endpoints, models, themes, and approval rules.
- [Build from source](/docs/development/): compile the binary yourself.
- [Troubleshooting](/docs/troubleshooting/): install and startup problems.
- [CLI](/docs/cli/): every command and flag.
