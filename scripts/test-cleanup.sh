#!/usr/bin/env bash
# Reap smoke-test orphans. A killed/interrupted `bun test` never runs
# afterAll — but the app it booted runs in an OUTER tmux driver, and that pane
# is a DAEMONIZED child of the driver server, so the app tree (opentui
# renderer ~200MB, PTY children, status poll, mock/MCP children) survives and
# stacks across runs until the box OOMs.
#
# SAFETY: only processes REPARENTED TO INIT (PPID 1) are killed — the invoking
# shell's own command line inevitably CONTAINS the match strings, so a plain
# pkill -f would kill the caller (this exact bug killed whole tool calls).
set -u
reap() {
  local pattern="$1" pid ppid
  for pid in $(pgrep -f "$pattern" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ "$ppid" = "1" ] && kill -9 "$pid" 2>/dev/null
  done
}
reap 'bun test tests/'
reap 'timeout [0-9]* bun test'
reap 'mockMcpServer'
# Daemon (worker) test orphans: `serve` is the long-lived one (both the compiled
# binary and `bun src/index.tsx daemon serve`); the bracket keeps the reaper's own
# command line out of the match. Only PPID-1 reparented processes are killed.
reap '[d]aemon serve'
# PTY shells orphaned by a SIGKILLed daemon: the terminal engine sets
# SENSUS_ACTIVE=1 in the pane child's env (the daemon itself does not). Only
# PPID-1 processes are killed; the invoking shell never has this marker.
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  [ "$pid" = "$$" ] && continue
  if tr '\0' '\n' < "$d/environ" 2>/dev/null | grep -Fxq 'SENSUS_ACTIVE=1'; then
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ "$ppid" = "1" ] && kill -9 "$pid" 2>/dev/null
  fi
done
# Test tmux driver servers on test sockets — kill-server takes the whole pane
# tree with them. But the socket file may already be unlinked (a prior rm),
# which makes kill-server unreachable, so ALSO reap PPID-1 test tmux servers
# directly (their cmdline starts with `tmux -S /tmp/sensus/sensus-`; the
# invoking shell has a different ppid and is never touched). The app itself
# runs no tmux server or socket.
reap '^tmux -S /tmp/sensus/sensus-'
shopt -s nullglob
for s in /tmp/sensus/*.sock; do
  tmux -S "$s" kill-server 2>/dev/null
  rm -f "$s"
done
# Test scratch: logs, launcher scripts, pipe-pane captures, sandboxes.
rm -rf /tmp/sensus/*.stderr.log /tmp/sensus/*-launch-*.sh \
       /tmp/sensus/osc*.log /tmp/sensus/sensus-* /tmp/sensus/ref \
       /tmp/sensus/memhome
echo "test:clean done"
