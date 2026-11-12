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
| `sensus daemon install` | Install an always-on user service (systemd or launchd); `--linger` keeps a systemd user service running after logout |
| `sensus daemon uninstall` | Remove that service |

`sensus kill` is the global switch: it stops every sensus service this user runs, whatever
directory or environment started it, along with the shells they own. Add `--dry-run` to list
what it would stop first.

## Connect to a cloud panel

Pairing is opt-in and off until you run it. The panel gives you a one-time code; run this on
the machine you want to reach, as the user whose service should be controlled:

```sh
sensus cloud pair --cloud https://cloud.example
sensus cloud status
sensus cloud doctor              # diagnose pairing, service, tunnel and proxy
sensus cloud scopes              # show the host-granted scopes
sensus cloud scopes --allow view,chat
sensus cloud disable             # keep the pairing, stop the connection
sensus cloud enable
sensus cloud unpair
```

The command asks for the code without echoing it. If no local service is running, it offers
to install and enable one for that user. The host connects outbound to the panel; no inbound
port is opened. Pairing waits for the connection to come up and reports a non-zero exit with
the real error if it does not; `--no-wait` saves the pairing and returns immediately. Running
as root is refused unless you explicitly approve it, and the panel marks such an instance as
root. Multiple users on one machine can each pair their own service; the panel shows them as
separate instances.

`sensus cloud status` exits non-zero when the local service cannot answer or is running for a
different user or configuration home, so a stale service does not look like a healthy pairing.
`sensus cloud doctor` separates the remaining causes — missing or mismatched identity, a
pending or revoked token, a tunnel error, a reversed proxy that strips the WebSocket upgrade,
and a user service that stops at logout. Add `--json` for machine-readable checks.

On Linux, the always-on service is a user service. Manage it with `systemctl --user`,
not `sudo systemctl` — the system manager cannot see a user unit. The service starts
when that user's user manager starts; on a headless machine nobody logs in, so add
`--linger` to `sensus daemon install` (or run `loginctl enable-linger <user>`) to start
it at boot. If `loginctl show-user <user> -p Linger` reports `Linger=no`, install prints
the exact command; `--linger` runs it for you.

On Linux, the always-on service is a user service. Manage it with `systemctl --user`,
not `sudo systemctl` — the system manager cannot see a user unit. The service starts
when that user's user manager starts; on a headless machine nobody logs in, so add
`--linger` to `sensus daemon install` (or run `loginctl enable-linger <user>`) to start
it at boot. If `loginctl show-user <user> -p Linger` reports `Linger=no`, install prints
the exact command; `--linger` runs it for you.

Without an explicit `--allow` list, pairing explains and lists the four scopes — `view`,
`chat`, `control`, and `orchestrator` — and asks which to grant. Pressing Enter grants
`view,chat,control`; type a narrower list such as `view,chat` if you do not want terminal
control.

The scopes are the host's own policy, but the cloud remembers the set approved when you
paired. `sensus cloud scopes --allow` cannot add scopes beyond that set. To widen a view-only
pairing, request a new pairing code in the panel, then pair again with the scopes you want:

```sh
sensus cloud pair --cloud https://cloud.example --allow view,chat,control
```

## Read the local logs

```sh
sensus daemon logs --follow
sensus daemon logs --level warn --component 'daemon*'
```

`sensus daemon logs` renders the structured service log. `--follow` streams new records,
`--level` filters by severity, `--component` matches a component name (a trailing `*`
matches a prefix), and `--json` prints raw records for `jq`.

The service log records what happened, not just when the service started and stopped:
sessions opening and closing, each tool run with its status, completed turns and why one
was aborted, errors, and why the service last stopped or restarted. `--level warn`
narrows to problems.

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
