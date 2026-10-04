---
title: Troubleshooting
description: The failure modes sensus users hit most, with their causes and fixes.
order: 15
---

Most problems show up in the chat or the status bar. Find the symptom that matches; the
local logs ([CLI](/docs/cli/)) have the detail when a message is not enough.

## Sensus refuses to start

**Symptom:** starting `sensus` prints a refusal that you are already inside sensus.

**Cause:** you are running it from a sensus pane.

**Fix:** detach first (`Ctrl+A` then `d`), or run sensus from another terminal. Sensus
refuses to nest so two copies never fight over the same terminal.

## The terminal is too small

**Symptom:** a `terminal too small` notice, or the app refuses to boot.

**Cause:** the window is below the minimum size of 20 columns × 5 rows.

**Fix:** enlarge the terminal (or your SSH client's window) and retry. If it shrinks
mid-session, sensus shows a notice and recovers when it grows back.

## The chat says it has no key

**Symptom:** `chat:no-key` in the status bar; messages do not send.

**Cause:** the selected endpoint has no API key.

**Fix:** open settings (`Ctrl+O`) and set the endpoint's API key, or reopen the setup wizard
with `/init-wizard`. The terminal pane keeps working either way.

## The agent's requests fail

**Symptom:** an error bubble instead of a reply.

**Cause:** a wrong key, base URL, or model id; an endpoint that is down; or a request that
timed out while no data arrived.

**Fix:** check the endpoint in `Ctrl+O` and retry the message. Transient network failures are
retried automatically, and a stalled stream is cut off after an idle timeout rather than
hanging forever.

## The agent stops running commands

**Symptom:** the chat still replies, but the agent no longer uses tools, and code blocks in
its answers are clickable.

**Cause:** the endpoint rejected tool calling, so sensus retried without tools and kept the
session in plain-chat mode.

**Fix:** switch to a model that supports tool calling (`/model`), then start a new tab so the
session re-enables tools. You can still click a code block to send it to your terminal.

## An MCP server fails

**Symptom:** a server shows as failed, or its tools are missing.

**Cause:** the command could not start, the URL is unreachable, or credentials are wrong.

**Fix:** check status with `/mcp`, correct the server in your configuration, and run
`/reload`. A failed server only loses its own tools; the rest of the chat continues.

## The local service will not start, or looks stale

**Symptom:** boot reports that it cannot reach the local service, or `sensus daemon status`
is not healthy.

**Cause:** a service left over from a crash, a dev checkout, or another environment; a stale
socket; or an old service still holding your shells.

**Fix:** run `sensus daemon status`, then `sensus daemon stop`. If that is not enough,
`sensus kill` stops every sensus service this user runs, whatever started it (`--dry-run`
lists first). Starting the service again unlinks a stale socket automatically.

## After an update, the old version is still running

**Symptom:** an update does not seem to take effect, or boot warns about a version mismatch.

**Cause:** the previous version's service still holds your shells.

**Fix:** the boot prompt offers to restart it now (losing anything running in those shells)
or to keep it for later; `sensus daemon restart` is the manual escape hatch.

## The install fails

- **Checksum mismatch:** the download was corrupted or tampered with; the installer refuses
  to continue. Re-run it.
- **`~/.local/bin` is not on your PATH:** the installer prints the line to add. Or install
  system-wide with `-g`.
- **macOS kills the binary instantly (`Killed: 9`):** the code signature was rejected.
  Re-run the installer, or ad-hoc sign the binary with `codesign --force --sign - <path>`.
- **`Unknown lockfile version` or floating dependency versions:** your Bun is too old for a
  source build; run `bun upgrade`.
- **`preload not found`:** an old build; rebuild from source or reinstall the latest release.
- **No prebuilt binary for your platform:** releases cover Linux and macOS on x86_64 and
  aarch64; build from source otherwise.

## The terminal pane fails to spawn

**Symptom:** `terminal spawn failed`, or the pane never starts.

**Cause:** the platform has no native terminal support.

**Fix:** run sensus on Linux or macOS on x86_64 or aarch64. The rest of the app may still
run, but the embedded terminal needs those platforms.

## Where the logs are

`sensus daemon logs` renders the structured service log. Add `--follow` to stream, `--level`
to filter by severity, and `--json` to pipe raw records to `jq`. See [CLI](/docs/cli/) for
the flags and for the event and trigger logs.

## Next steps

- [CLI](/docs/cli/): the daemon, logs, and kill switch
- [Install](/docs/install/): installer options and supported platforms
- [Configuration](/docs/configuration/): endpoints and keys
- [Privacy & data](/docs/privacy/): what stays on your machine
