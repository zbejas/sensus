#!/usr/bin/env bash
#
# sensus source installer: build this checkout with bun and install it.
#
#   ./scripts/build-install.sh        ask user (default) or global install
#   ./scripts/build-install.sh -g     install system-wide (/usr/local/bin)
#   PREFIX=/opt ./scripts/build-install.sh
#
# The install/verify/config tail lives in scripts/install-release.sh; this
# wrapper only checks bun, builds dist/sensus, then delegates with
# SENSUS_PREBUILT. For a prebuilt release (no checkout, no bun):
#   curl -fsSL https://sensus.sh/install | bash
#
# Requires bun >= 1.4.1 to run and >= 1.4.2 to build (docs/operations.md
# "Build & ship": bun 1.4.1's bundler emits a binary that fails at startup).

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
[ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ] ||
  { printf 'sensus install: run this script from a file (not piped).\n' >&2; exit 1; }
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
[ -f "$REPO_ROOT/package.json" ] && [ -f "$REPO_ROOT/scripts/build.ts" ] ||
  { printf 'sensus install: scripts/build-install.sh must run from a sensus checkout.\n' >&2; exit 1; }

say() { printf '%s\n' "$*"; }
die() { printf 'sensus install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "Usage: ./scripts/build-install.sh [-g|--global]"
  say ""
  say "  -g, --global    install system-wide to /usr/local/bin"
  say "  -h, --help      show this help"
  say ""
  say "Environment:"
  say "  PREFIX=/path    install under an explicit prefix (\$PREFIX/bin), skips the prompt"
}

GLOBAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -g|--global) GLOBAL=1 ;;
    -h|--help) usage; exit 0 ;;
    --release|--source|--build)
      die "$1 moved: a checkout always builds from source now.
  Install a prebuilt release with:  curl -fsSL https://sensus.sh/install | bash
  (or ./scripts/install-release.sh from this checkout)"
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# Numeric major.minor.patch check: succeeds when $1 >= $2 (awk is POSIX/macOS).
bun_at_least() {
  awk -v have="$1" -v want="$2" 'BEGIN {
    split(have, h, "."); split(want, w, ".")
    for (i = 1; i <= 3; i++) {
      if ((h[i] + 0) > (w[i] + 0)) exit 0
      if ((h[i] + 0) < (w[i] + 0)) exit 1
    }
    exit 0
  }'
}

command -v bun >/dev/null 2>&1 || die "bun is required to build from source but was not found on PATH.
  Install it first:  curl -fsSL https://bun.sh/install | bash
  Or install a prebuilt release instead:  curl -fsSL https://sensus.sh/install | bash"

# The repo requires bun >= 1.4.1 (package.json engines). An older bun cannot
# parse bun.lock (lockfileVersion 2) and silently installs floating versions —
# warn loudly, but still let the install proceed.
BUN_VERSION="$(bun --version 2>/dev/null || true)"
if [ -n "$BUN_VERSION" ] && ! bun_at_least "$BUN_VERSION" "1.4.1"; then
  say "WARNING: bun $BUN_VERSION is older than the required 1.4.1."
  say "  Its lockfile format is newer than this bun understands, so \`bun install\`"
  say "  ignores bun.lock and may pick different package versions. Upgrade first:"
  say "    bun upgrade"
  say ""
fi

# Bundling Elysia needs bun >= 1.4.2: bun 1.4.1's bundler renamer emits an
# invalid `var Check2 = Check2` for elysia's schema module, so a binary built
# from source on 1.4.1 dies at startup with a SyntaxError.
if [ -n "$BUN_VERSION" ] && ! bun_at_least "$BUN_VERSION" "1.4.2"; then
  say "WARNING: bun < 1.4.2 cannot build a working sensus binary."
  say "  bun 1.4.1's bundler emits invalid JS for Elysia, so the binary fails at startup;"
  say "  build with 1.4.2 or newer, or supply a prebuilt binary (install-release.sh / SENSUS_PREBUILT)."
  say "  Upgrade:"
  say "    bun upgrade"
  say ""
fi

# Where to install: an explicit PREFIX wins; otherwise -g installs
# system-wide; otherwise ask on a TTY with "this user" as the default.
if [ -z "${PREFIX:-}" ] && [ "$GLOBAL" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
  say "Where should sensus be installed?"
  say "  1) this user only   $HOME/.local/bin   [default]"
  say "  2) all users        /usr/local/bin"
  printf 'Choice [1/2]: '
  read -r choice || choice=""
  case "$choice" in
    2|g|global|system|all) GLOBAL=1 ;;
    ""|1|u|user) ;;
    *) say "Unrecognized choice '$choice' — defaulting to a user install." ;;
  esac
fi

say "Building the sensus binary (bun build --compile)…"
cd "$REPO_ROOT"
if [ ! -d node_modules ]; then
  say "Installing dependencies (bun install)…"
  bun install || die "bun install failed — see output above."
fi
bun run build || die "build failed — see output above."
BUILT="$REPO_ROOT/dist/sensus"
[ -x "$BUILT" ] || die "build finished but $BUILT is missing/not executable"

# Delegate the install/verify/config tail so there is exactly one
# implementation of it (install-release.sh; SENSUS_PREBUILT skips the download).
say "Installing the built binary via scripts/install-release.sh…"
if [ "$GLOBAL" -eq 1 ]; then
  SENSUS_PREBUILT="$BUILT" exec bash "$REPO_ROOT/scripts/install-release.sh" -g
else
  SENSUS_PREBUILT="$BUILT" exec bash "$REPO_ROOT/scripts/install-release.sh"
fi
