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
| `sensus daemon install` | Install an always-on service. Default: a per-user service (systemd or launchd); `--root`: a root-owned system service on Linux; `--user` forces the per-user service from a root shell. `--linger` keeps a systemd user service running after logout |
| `sensus daemon uninstall` | Remove that service (`--root` / `--user` choose the scope) |

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

The command asks for the code without echoing it. If a local service is already running, it
reloads it and repairs the always-on unit when it is missing; otherwise it installs and
enables one and waits for the connection. A normal user gets a per-user service with
lingering where needed so a headless machine starts at boot. A root shell gets a root-owned
system service (`/etc/systemd/system/sensus.service`, running as root) by default; `--root`
forces that from any shell, and `--user` keeps the per-user service even as root. The root
system service starts at boot, so it does not use lingering. If the machine cannot run a
service (a container, for example), it starts the local service for the current session and
says that it will not restart after a reboot; `--no-service` and `--no-linger` opt out of
the unit and of lingering. The host connects outbound to the panel; no inbound port is
opened. Pairing waits for the connection to come up and reports a non-zero exit with the
real error if it does not; `--no-wait` saves the pairing and returns immediately.

A root pairing requires explicit approval: `--root` is that approval, and a root shell
defaults to it. Before switching to the root system service, pairing asks before stopping a
root user service or daemon; a daemon owned by another account is never stopped, and the
command prints what to run instead. The panel marks root instances as root. Multiple users
on one machine can each pair their own service; the panel shows them as separate instances.
If you paired before this behavior existed, updating sensus repairs the service automatically
on the next update, daemon start, or boot: there is no need to pair again.

`sensus cloud status` exits non-zero when the local service cannot answer or is running for a
different user or configuration home, so a stale service does not look like a healthy pairing.
When the cloud assigns a config profile to this host, status also shows its name, updated
time, effective scopes, denied features, approval defaults, and stream limit. The host only
narrows to that profile; it never writes it into your local policy or configuration.
`sensus cloud doctor` separates the remaining causes — missing or mismatched identity, a
pending or revoked token, a tunnel error, a reversed proxy that strips the WebSocket upgrade,
and a user service that stops at logout. Add `--json` for machine-readable checks.

On Linux, the default always-on service is per-user. Manage it with `systemctl --user`,
not `sudo systemctl` — the system manager cannot see a user unit. It starts when that
user's user manager starts; on a headless machine nobody logs in, so add `--linger` to
`sensus daemon install` (or run `loginctl enable-linger <user>`) to start it at boot.
If `loginctl show-user <user> -p Linger` reports `Linger=no`, install prints the exact
command; `--linger` runs it for you.

The root `--root` service is different: it is a system service, starts at boot, and is
managed with `sudo systemctl status sensus`, `sudo systemctl restart sensus`, and
`sudo systemctl disable --now sensus`. Its socket and config live under root, so run
the CLI and TUI as root to use it.

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
