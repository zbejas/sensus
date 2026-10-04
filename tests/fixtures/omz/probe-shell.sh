#!/bin/sh
# oh-my-zsh realism fixture (tests/smoke/color-fidelity.test.ts).
#
# Used as the pane's $SHELL: ZDOTDIR points at this directory so the sibling
# `.zshrc` runs as the interactive startup file. That `.zshrc` sources the real
# oh-my-zsh when the user has it and prints a labeled SGR probe. This script is
# intentionally tiny and committed — no generated artifacts.
#
# If zsh is unavailable the fixture must still print the same probe (the smoke
# assertion only reads SGR), so it falls back to a printf and keeps the pane alive.

set -u
ZDOTDIR="$(cd "$(dirname "$0")" && pwd)"
export ZDOTDIR

# Keep the distro's global /etc/zsh/zshrc compinit from dumping .zcompdump into
# this committed fixture dir; oh-my-zsh's own compinit is redirected to /tmp by
# the sibling .zshrc. (/etc/zsh/zshrc checks this var — see its comments.)
export skip_global_compinit=1

if command -v zsh >/dev/null 2>&1; then
  exec zsh -i
fi

printf 'P31:\033[31mR\033[0m P256:\033[38;5;1mR\033[0m PBOLD:\033[1;31mR\033[0m PTC:\033[38;2;191;97;106mR\033[0m PBRIGHT:\033[91mR\033[0m\n'
exec sleep 120
