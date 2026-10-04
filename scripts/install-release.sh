#!/usr/bin/env bash
#
# sensus release installer (public — served at https://sensus.sh/install).
#
# Downloads the matching prebuilt binary from the GitHub Release, verifies it
# against the release's checksums.txt, installs it, and scaffolds a starter
# config. Safe to re-run: the binary is overwritten, an existing config never
# is, and no shell rc file is touched.
#
#   curl -fsSL https://sensus.sh/install | bash
#   curl -fsSL https://sensus.sh/install | bash -s -- -g
#   curl -fsSL https://sensus.sh/install | bash -s -- --version vx.x.x
#
# From a checkout:
#   ./scripts/install-release.sh [-g] [--version <tag>]
#
# Building from a checkout is scripts/build-install.sh: it compiles dist/sensus
# with bun and then delegates here with SENSUS_PREBUILT.
#
# Requires: curl (or wget) and a sha256 tool only — the shipped binary embeds
# the Bun runtime, so no Bun is needed. The release binaries are built and
# ad-hoc signed by .github/workflows/release.yml (docs/operations.md
# "Build & ship").

set -euo pipefail

REPO_SLUG="${SENSUS_REPO_SLUG:-zbejas/sensus}"
RELEASES_BASE_URL="${SENSUS_RELEASES_BASE_URL:-https://github.com/$REPO_SLUG/releases}"
RELEASE_VERSION="${SENSUS_RELEASE_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'sensus install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "Usage: install-release.sh [-g|--global] [--version <tag>]"
  say ""
  say "  -g, --global    install system-wide to /usr/local/bin"
  say "  --version <tag> install a specific release (e.g. vx.x.x; default: latest)"
  say "  -h, --help      show this help"
  say ""
  say "One-liner (downloads the latest release):"
  say "  curl -fsSL https://sensus.sh/install | bash"
  say ""
  say "Environment:"
  say "  PREFIX=/path               install under an explicit prefix (\$PREFIX/bin)"
  say "  SENSUS_PREBUILT=           skip the download and install the given binary"
  say "  SENSUS_RELEASE_VERSION=    release to install (same as --version)"
  say "  SENSUS_RELEASES_BASE_URL=  override the release host (default: the GitHub repo's releases)"
}

GLOBAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -g|--global) GLOBAL=1 ;;
    --version)
      [ $# -ge 2 ] || die "--version needs a value (e.g. --version vx.x.x)"
      RELEASE_VERSION="$2"
      shift
      ;;
    --version=*) RELEASE_VERSION="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# Where to install: an explicit PREFIX wins, then -g (system-wide), else the
# per-user prefix. A piped install is never interactive.
USER_PREFIX="$HOME/.local"
GLOBAL_PREFIX="/usr/local"
if [ -n "${PREFIX:-}" ]; then
  INSTALL_PREFIX="$PREFIX"
elif [ "$GLOBAL" -eq 1 ]; then
  INSTALL_PREFIX="$GLOBAL_PREFIX"
else
  INSTALL_PREFIX="$USER_PREFIX"
fi

BIN_DIR="$INSTALL_PREFIX/bin"
TARGET="$BIN_DIR/sensus"

# --- Helpers ----------------------------------------------------------------

# Map this machine to a release asset (the names the release workflow uploads).
detect_asset() {
  local os arch
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"
  # Under Rosetta (an x86_64 shell on Apple Silicon), prefer the native arm64
  # binary: it is the one the machine actually wants.
  if [ "$os" = "Darwin" ] && [ "$arch" = "x86_64" ] &&
    [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi
  case "$os/$arch" in
    Linux/x86_64|Linux/amd64) ASSET="sensus-linux-x64" ;;
    Linux/aarch64|Linux/arm64) ASSET="sensus-linux-arm64" ;;
    Darwin/x86_64) ASSET="sensus-darwin-x64" ;;
    Darwin/arm64) ASSET="sensus-darwin-arm64" ;;
    *)
      die "no prebuilt binary for $os/$arch.
  Supported: Linux x86_64/aarch64, macOS x86_64/arm64.
  Build from source instead:
    git clone https://github.com/$REPO_SLUG.git sensus && cd sensus && ./scripts/build-install.sh"
      ;;
  esac
}

# curl (preferred; -f turns a 404 into a failure) or wget.
fetch_to() { # <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 1 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is required to download a release binary"
  fi
}

# Verify <file> against the <asset> line of a checksums.txt. A release without
# a usable checksum warns (TLS is still the transport's trust anchor) but a
# MISMATCH refuses to install.
verify_checksum() { # <file> <asset> <checksums.txt>
  local expected actual
  expected="$(awk -v asset="$2" '$2 == asset || $2 == "*" asset { print $1; exit }' "$3")"
  if [ -z "$expected" ]; then
    say "WARNING: $2 is not listed in checksums.txt — skipping checksum verification."
    return 0
  fi
  actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$1" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha256 "$1" | awk '{print $NF}')"
  fi
  if [ -z "$actual" ]; then
    say "WARNING: no sha256 tool found (sha256sum/shasum/openssl) — skipping checksum verification."
    return 0
  fi
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $2 — refusing to install.
  expected: $expected
  actual:   $actual"
  fi
  say "Checksum verified."
}

# --- Download, or use a supplied binary --------------------------------------

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  return 0
}
trap cleanup EXIT

if [ -n "${SENSUS_PREBUILT:-}" ]; then
  [ -x "$SENSUS_PREBUILT" ] || die "SENSUS_PREBUILT=$SENSUS_PREBUILT is not an executable file"
  BUILT="$SENSUS_PREBUILT"
  say "Using prebuilt binary: $BUILT"
else
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 ||
    die "curl or wget is required to download a release binary"
  detect_asset
  case "$RELEASE_VERSION" in
    ""|latest) RELEASE_LABEL="latest"; RELEASE_URL_BASE="$RELEASES_BASE_URL/latest/download" ;;
    v*) RELEASE_LABEL="$RELEASE_VERSION"; RELEASE_URL_BASE="$RELEASES_BASE_URL/download/$RELEASE_VERSION" ;;
    *) RELEASE_LABEL="v$RELEASE_VERSION"; RELEASE_URL_BASE="$RELEASES_BASE_URL/download/v$RELEASE_VERSION" ;;
  esac
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sensus-install.XXXXXX")" ||
    die "could not create a temp directory to download into"
  say "Downloading $ASSET ($RELEASE_LABEL)…"
  fetch_to "$RELEASE_URL_BASE/$ASSET" "$TMP_DIR/sensus" ||
    die "could not download $RELEASE_URL_BASE/$ASSET"
  chmod +x "$TMP_DIR/sensus" || die "could not mark the downloaded binary executable"
  if fetch_to "$RELEASE_URL_BASE/checksums.txt" "$TMP_DIR/checksums.txt" 2>/dev/null; then
    verify_checksum "$TMP_DIR/sensus" "$ASSET" "$TMP_DIR/checksums.txt"
  else
    say "WARNING: could not download checksums.txt — skipping checksum verification."
  fi
  BUILT="$TMP_DIR/sensus"
fi

# --- Install ---------------------------------------------------------------
say "Installing to $TARGET"
SUDO=""
install_cmd() {
  if [ "$SUDO" = "sudo" ]; then
    sudo "$@"
  else
    "$@"
  fi
}
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$BIN_DIR" || die "could not create $BIN_DIR"
elif mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
  :
elif command -v sudo >/dev/null 2>&1; then
  say "$BIN_DIR is not writable — using sudo for the install step."
  SUDO="sudo"
  install_cmd mkdir -p "$BIN_DIR" || die "could not create $BIN_DIR (needs elevated privileges)"
else
  die "cannot create $BIN_DIR and sudo is unavailable.
  Re-run as root, choose the user install, or set PREFIX to a writable location."
fi
install_cmd cp -f "$BUILT" "$TARGET" || die "could not copy the binary to $TARGET"
install_cmd chmod 0755 "$TARGET"

# --- Verify ----------------------------------------------------------------
if ! "$TARGET" --version >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ]; then
    die "installed binary failed to run (\`$TARGET --version\`).
  On macOS this is almost always a code-signature problem: the kernel SIGKILLs
  a binary with an invalid/unsigned Mach-O signature (\`Killed: 9\`). Re-sign it
  ad-hoc and retry:
    codesign --force --sign - \"$TARGET\"
  (If codesign is missing, install the Xcode command line tools:
   \`xcode-select --install\` and rebuild with \`bun run build\`.)"
  fi
  die "installed binary failed to run (\`$TARGET --version\`) — see output above"
fi
say "Installed: $TARGET ($("$TARGET" --version))"

# --- First-run config --------------------------------------------------------
# Scaffold ~/.config/sensus/config.json if missing (the binary owns the
# schema; this NEVER overwrites an existing config). Non-fatal on failure.
# Output is suppressed: setup runs INSIDE sensus now, so the headless
# scaffold's "sensus init: ..." line is just noise (and reads confusingly).
if ! "$TARGET" init --create-config >/dev/null 2>&1; then
  say "WARNING: could not scaffold the config — create ~/.config/sensus/config.json by hand (docs/config.md)."
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "WARNING: $BIN_DIR is not on your PATH. Add this to your shell rc:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

say ""
say "Next steps:"
say "  sensus   # start the TUI; a first run opens the setup wizard (endpoint, model, theme)"
say ""
say "Setup runs inside sensus now — reopen it anytime with /init-wizard (or Ctrl+P -> Setup wizard)."
say ""
say "Config: ~/.config/sensus/config.json (scaffolded above if missing; schema in docs/config.md)."
