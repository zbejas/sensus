---
title: CLI
description: "The sensus command line: run the TUI, manage the local service, and read the local logs."
order: 13
---

`sensus` is both the fullscreen app and a headless command-line tool. Run it with no
arguments to start the TUI; the subcommands below cover setup, secrets, the local service
that keeps your shells alive, and its logs. They work over SSH and in scripts.

## Start the TUI

```sh
sensus
```

Start flags override your saved configuration for this run:

| Flag | Effect |
|---|---|
| `--model <endpoint@id>` | Select the model; a bare id keeps the current endpoint |
| `--endpoint <name>` | Switch the selected model's endpoint |
| `--base-url <url>` | Override the endpoint's base URL |
| `--resume` | Pick a recent session to continue |
| `--yolo` | Start in full-auto approval mode |
| `--sidebar-width <cols>` | Set the chat sidebar width |

Sensus refuses to start inside a sensus pane; detach first (`Ctrl+A` then `d`), or run it
from another terminal.

## Set up

```sh
sensus init                  # start the TUI with the setup wizard open
sensus init --create-config  # write a starter config file and exit (never overwrites)
```

A first run opens the wizard automatically, and `/init-wizard` or `Ctrl+P` → Setup wizard
reopens it anytime. See [Configuration](/docs/configuration/) for what it writes.

## Manage secrets

```sh
sensus secrets list
sensus secrets set OPENAI_API_KEY sk-…
sensus secrets rm OPENAI_API_KEY
sensus secrets migrate
```

`set` stores a value in the encrypted secrets store, and `migrate` moves any plaintext keys
out of your config file. Reference a stored value as `${NAME}` in configuration.

## Manage the local service

Your shells and agent turns are hosted by a local background service, so quitting sensus
does not stop them. The `daemon` subcommands manage it:

| Command | Effect |
|---|---|
| `sensus daemon start` | Start it in the background; safe when it is already running |
| `sensus daemon status` | Print its process id and health; exits 0 when healthy, 1 otherwise |
| `sensus daemon stop` | Stop this environment's service and the shells it owns |
| `sensus daemon restart` | Stop, then start |
| `sensus daemon serve` | Run it in the foreground (what the always-on service runs) |
| `sensus daemon logs` | Read the structured log (below) |
| `sensus daemon install` | Install an always-on user service (systemd or launchd) |
| `sensus daemon uninstall` | Remove that service |

`sensus kill` is the global switch: it stops every sensus service this user runs, whatever
directory or environment started it, along with the shells they own. Add `--dry-run` to list
what it would stop first.

## Read the local logs

```sh
sensus daemon logs --follow
sensus daemon logs --level warn --component 'daemon*'
```

`sensus daemon logs` renders the structured service log. `--follow` streams new records,
`--level` filters by severity, `--component` matches a component name (a trailing `*`
matches a prefix), and `--json` prints raw records for `jq`.

The local event and trigger logs are follow-able too:

```sh
sensus events tail --follow --type tool.executed,error.raised
sensus triggers tail --follow --type error.raised
```

Both commands also take `--since` as epoch milliseconds or a date. The logs stay on your
machine; see [Privacy & data](/docs/privacy/).

## Export a session

```sh
sensus --export <session-file>
```

Prints a stored transcript as Markdown. Find sessions with `/sessions` inside sensus; see
[Sessions](/docs/sessions/).

## Help and version

```sh
sensus --help       # usage
sensus --version    # the version you are running
```

## Update

```sh
sensus update                    # update to the latest release, in place
sensus update --check            # only report whether a newer release exists
sensus update --version <tag>    # install a specific release
```

`sensus update` (alias: `sensus upgrade`) downloads the latest release and replaces the
installed binary in place. Your configuration, sessions, and memory are untouched. From a
source checkout it prints the git-based update instead.

Sensus also checks for a newer release once a day at launch and shows a short notice when
one exists. Turn that check off with `"updateCheck": false` in your configuration; see
[Configuration](/docs/configuration/).

## Remove

Remove the always-on service with `sensus daemon uninstall`; to remove the app itself, stop
the services and delete the installed binary. Your config, sessions, memory, and logs stay on
disk until you delete them. See [Install](/docs/install/).

## Next steps

- [Install](/docs/install/): the one-line installer and its options
- [Configuration](/docs/configuration/): endpoints, secrets, and config keys
- [Troubleshooting](/docs/troubleshooting/): when something will not start
- [Privacy & data](/docs/privacy/): what stays local
