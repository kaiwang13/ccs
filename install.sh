#!/bin/sh
# ccs installer — install, update and uninstall.
#
# From a prebuilt release package (nothing is compiled; the package carries its own Node):
#
#   curl -fsSL https://raw.githubusercontent.com/kaiwang13/ccs/main/install.sh | sh             # latest release
#   curl -fsSL https://raw.githubusercontent.com/kaiwang13/ccs/main/install.sh | sh -s update   # update to it
#   sh ccs-<version>-<os>-<arch>/install.sh            # from an unpacked package, offline
#   CCS_PACKAGE=./ccs-linux-x64.tar.gz sh install.sh   # from a downloaded package file (or URL)
#
# From source (builds the native addons; needs git, Node 24, npm, make and a C compiler):
#
#   git clone git@github.com:kaiwang13/ccs.git ~/src/ccs
#   cd ~/src/ccs
#   CCS_REPO="$PWD" sh install.sh
#   CCS_REPO="$PWD" sh install.sh update
#
#   sh install.sh uninstall
#
# Layout. Releases are immutable directories; `current` is a symlink, so an update builds the new
# version COMPLETELY BEFORE anything stops, and a rollback is one symlink away:
#
#   ~/.local/share/ccs/releases/<ref>-<sha>/   a clone with its native addons built (from source)
#   ~/.local/share/ccs/releases/v<ver>-<sha>/  an unpacked release package (runtime/bin/node inside)
#   ~/.local/share/ccs/current -> releases/…   what the wrapper runs
#   ~/.local/bin/ccs                           the wrapper on your PATH
#
# Your sessions live in ~/.local/state/ccs and are NEVER touched by install or update: an update stops
# the running ones, swaps the symlink, and starts exactly those again, resuming each conversation.
set -eu

REPO="${CCS_REPO:-https://github.com/kaiwang13/ccs.git}"
REF="${CCS_REF:-main}"
# Release packages: CCS_VERSION picks a tag (e.g. v0.5.1); the default is the latest release.
RELEASES="${CCS_RELEASES_URL:-https://github.com/kaiwang13/ccs/releases}"
VERSION="${CCS_VERSION:-latest}"
PACKAGE="${CCS_PACKAGE:-}"
ROOT="${CCS_HOME:-$HOME/.local/share/ccs}"
BIN="${CCS_BIN_DIR:-$HOME/.local/bin}"
STATE="${CCS_STATE_DIR:-$HOME/.local/state/ccs}"
WRAPPER="$BIN/ccs"

# An install is SELF-CONTAINED: everything lands under $HOME, nothing needs sudo, and no file outside
# $ROOT, $BIN and $STATE is written. When CCS_STATE_DIR / CCS_RUNTIME_DIR / CCS_CONFIG are set explicitly
# they are pinned into the wrapper, so a second install elsewhere is fully isolated — it cannot see, stop
# or delete the sessions of the install you actually use. That is what makes end-to-end testing safe.
PIN_STATE="${CCS_STATE_DIR:-}"
PIN_RUNTIME="${CCS_RUNTIME_DIR:-}"
PIN_CONFIG="${CCS_CONFIG:-}"

say()  { printf '\033[1mccs:\033[0m %s\n' "$*"; }
warn() { printf '\033[33mccs: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mccs: %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

check_os() {
  case "$(uname -s)" in
    Linux|Darwin) ;;
    *) die "ccs supports Linux and macOS; found $(uname -s)" ;;
  esac
}

check_prereqs() {
  check_os
  if [ "$MODE" != source ]; then
    need tar
    [ "$MODE" = local ] || command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "'curl' or 'wget' is required to download ccs"
    return 0
  fi
  need git; need node; need npm; need make; need cc
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 24 ] || die "Node 24+ required; found $(node -v)"
}

# Where the new release comes from:
#   source   CCS_REPO is set: clone it and build the native addons here
#   local    this script sits in an unpacked release package (and is not the installed copy): install that directory
#   package  otherwise: CCS_PACKAGE (a file or URL), or the release asset for this OS and architecture
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || echo /nonexistent)
if [ -n "${CCS_REPO:-}" ]; then MODE=source
elif [ -z "$PACKAGE" ] && [ -f "$HERE/RELEASE" ] && [ -x "$HERE/runtime/bin/node" ] \
     && case "$HERE/" in "$(cd "$ROOT" 2>/dev/null && pwd -P || echo /nonexistent)/"*) false ;; *) true ;; esac
then MODE=local
else MODE=package
fi

platform_id() {
  case "$(uname -s)" in Linux) _os=linux ;; Darwin) _os=darwin ;; *) _os=unknown ;; esac
  case "$(uname -m)" in x86_64|amd64) _arch=x64 ;; aarch64|arm64) _arch=arm64 ;; *) _arch=$(uname -m) ;; esac
  echo "$_os-$_arch"
}

fetch() {  # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

release_field() { sed -n "s/^$1=//p" "$2/RELEASE" | head -1; }

# Install a prebuilt release package (MODE local or package). Never touches the running install; the package is checked
# to run on this machine BEFORE it becomes a release directory, so a broken download changes nothing.
install_package() {
  mkdir -p "$ROOT/releases"
  _tmp="$ROOT/releases/.staging.$$"
  rm -rf "$_tmp"; mkdir -p "$_tmp"
  if [ "$MODE" = local ]; then
    say "installing from $HERE"
    ( cd "$HERE" && tar -cf - . ) | ( cd "$_tmp" && tar -xf - )
  else
    _plat=$(platform_id)
    _file="$PACKAGE"
    if [ -z "$_file" ]; then
      if [ "$VERSION" = latest ]; then _file="$RELEASES/latest/download/ccs-$_plat.tar.gz"
      else _file="$RELEASES/download/$VERSION/ccs-$_plat.tar.gz"; fi
    fi
    case "$_file" in
      http://*|https://*)
        say "downloading $_file"
        fetch "$_file" "$_tmp.tar.gz" || { rm -rf "$_tmp" "$_tmp.tar.gz"; die "could not download $_file — is there a release for $_plat? (to build from source instead: CCS_REPO=<clone> sh install.sh)"; }
        if fetch "$_file.sha256" "$_tmp.sha256" 2>/dev/null; then
          _want=$(cut -d' ' -f1 "$_tmp.sha256"); _got=$(sha256_of "$_tmp.tar.gz")
          [ -z "$_got" ] || [ "$_want" = "$_got" ] || { rm -rf "$_tmp" "$_tmp.tar.gz" "$_tmp.sha256"; die "checksum mismatch for $_file"; }
        fi
        rm -f "$_tmp.sha256"
        _archive="$_tmp.tar.gz" ;;
      *) [ -f "$_file" ] || { rm -rf "$_tmp"; die "no such package: $_file"; }
         _archive="$_file" ;;
    esac
    tar -xzf "$_archive" -C "$_tmp" --strip-components=1 || { rm -rf "$_tmp" "$_tmp.tar.gz"; die "could not unpack $_file"; }
    rm -f "$_tmp.tar.gz"
  fi
  [ -f "$_tmp/RELEASE" ] && [ -x "$_tmp/runtime/bin/node" ] || { rm -rf "$_tmp"; die "not a ccs release package (no RELEASE / runtime/bin/node)"; }
  _want_plat=$(platform_id); _pkg_plat="$(release_field os "$_tmp")-$(release_field arch "$_tmp")"
  [ "$_pkg_plat" = "$_want_plat" ] || { rm -rf "$_tmp"; die "this package is for $_pkg_plat, but this machine is $_want_plat"; }
  case "$(uname -s)" in
    # A package downloaded by a browser carries the quarantine attribute, which would stop the bundled node.
    Darwin) xattr -dr com.apple.quarantine "$_tmp" 2>/dev/null || true ;;
  esac
  ( cd "$_tmp" && runtime/bin/node -e 'require("./src/common/native.js"); require("node-pty")' ) \
    || { rm -rf "$_tmp"; die "the package does not run on this machine (native addons failed to load)"; }
  _dir="$ROOT/releases/v$(release_field version "$_tmp")-$(release_field commit "$_tmp")"
  if [ -d "$_dir" ]; then rm -rf "$_tmp"; say "already installed: $(basename "$_dir")"; RELEASE="$_dir"; return 0; fi
  mv "$_tmp" "$_dir"
  RELEASE="$_dir"
  say "unpacked $(basename "$_dir")"
}

new_release() { if [ "$MODE" = source ]; then build_release "$REF"; else install_package; fi; }

# The optional Feishu add-on's dependencies — only when it is enabled (docs/feishu.md). A release directory is otherwise
# never changed after it is built; this adds one directory no running process maps, with no native code (spec §11).
feishu_deps() {
  [ -f "$STATE/feishu/enabled" ] || return 0
  [ -f "$1/addons/feishu/package-lock.json" ] || return 0
  # node_modules/.package-lock.json is the file npm writes LAST (M5): its absence means an earlier `npm ci` was
  # interrupted and left a partial tree, which checking @larksuite/channel's own package.json alone would miss
  # and never repair — the same check src/cli/commands/feishu.js's depsInstalled() makes.
  [ -d "$1/addons/feishu/node_modules/@larksuite/channel" ] && [ -f "$1/addons/feishu/node_modules/.package-lock.json" ] && return 0
  say "installing the Feishu add-on's dependencies…"
  ( cd "$1/addons/feishu" && npm ci --omit=dev --silent --no-audit --no-fund ) || die "could not install the Feishu add-on's dependencies"
}

# The connector is not started at boot (docs/feishu.md), so "not running now" says nothing about whether it should
# run: after a reboot it is down and the update must still start it. Enabled is the question, not running.
feishu_enabled() { [ -f "$STATE/feishu/enabled" ]; }
feishu_running() { "$WRAPPER" feishu status 2>/dev/null | grep -q '^ccs: Feishu connector: running'; }

# Build a release directory from a git ref. Never touches the running install.
build_release() {
  _ref=$1
  mkdir -p "$ROOT/releases"
  _tmp="$ROOT/releases/.staging.$$"
  rm -rf "$_tmp"
  say "fetching $REPO ($_ref)…"
  git clone --quiet --depth 1 --branch "$_ref" "$REPO" "$_tmp" 2>/dev/null \
    || git clone --quiet "$REPO" "$_tmp"
  ( cd "$_tmp" && git checkout --quiet "$_ref" 2>/dev/null || true )
  _sha=$( cd "$_tmp" && git rev-parse --short HEAD )
  _dir="$ROOT/releases/$_ref-$_sha"
  if [ -d "$_dir" ]; then rm -rf "$_tmp"; say "already built: $_ref-$_sha"; feishu_deps "$_dir"; RELEASE="$_dir"; return 0; fi
  say "installing dependencies…"
  ( cd "$_tmp" && npm ci --silent --no-audit --no-fund )
  say "building native addon…"
  ( cd "$_tmp" && npm run --silent build:native )
  [ -f "$_tmp/native/ttyctl/build/Release/ttyctl.node" ] || die "native build produced no addon"
  feishu_deps "$_tmp"
  mv "$_tmp" "$_dir"
  RELEASE="$_dir"
  say "built $_ref-$_sha"
}

write_wrapper() {
  mkdir -p "$BIN"
  {
    echo '#!/bin/sh'
    echo '# Generated by the ccs installer. Absolute node path on purpose: sessions outlive your shell,'
    echo '# so a daemon restarted later must not depend on nvm being loaded.'
    echo 'export UV_THREADPOOL_SIZE=16'
    [ -n "$PIN_STATE" ]   && echo "export CCS_STATE_DIR=\"$PIN_STATE\""
    [ -n "$PIN_RUNTIME" ] && echo "export CCS_RUNTIME_DIR=\"$PIN_RUNTIME\""
    [ -n "$PIN_CONFIG" ]  && echo "export CCS_CONFIG=\"$PIN_CONFIG\""
    if [ -x "$RELEASE/runtime/bin/node" ]; then
      # A release package runs on the Node it carries, found through `current` so a rollback switches it too.
      echo "exec \"$ROOT/current/runtime/bin/node\" \"$ROOT/current/bin/ccs.js\" \"\$@\""
    else
      _node=$(command -v node); _node=$(readlink -f "$_node")
      echo "exec \"$_node\" \"$ROOT/current/bin/ccs.js\" \"\$@\""
    fi
  } > "$WRAPPER"
  chmod 0755 "$WRAPPER"
}

# Names of sessions that are alive right now, one per line.
running_sessions() {
  [ -x "$WRAPPER" ] || return 0
  "$WRAPPER" ls --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { for (const r of JSON.parse(s)) if (r.live) console.log(r.name); } catch { /* no sessions */ }
    });' 2>/dev/null || true
}

# The rename must not follow `current` into the directory it points at: GNU mv spells that -T, BSD (macOS) mv -h.
point_current_at() {
  case "$(uname -s)" in Darwin) _nofollow=-h ;; *) _nofollow=-T ;; esac
  ln -sfn "$1" "$ROOT/current.new" && mv "$_nofollow" -f "$ROOT/current.new" "$ROOT/current"
}

cmd_install() {
  check_prereqs
  [ -e "$ROOT/current" ] && warn "an install already exists at $ROOT — use 'update' to upgrade it"
  new_release
  point_current_at "$RELEASE"
  write_wrapper
  say "installed $(basename "$RELEASE")"
  case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on your PATH — add it to your shell profile" ;; esac
  say "next: ccs doctor --lite     then: cd <a project> && ccs new myproject"
}

cmd_update() {
  check_prereqs
  [ -e "$ROOT/current" ] || die "no install found at $ROOT — run install first"
  _old=$(readlink -f "$ROOT/current")
  new_release                     # built BEFORE anything stops; a failure here changes nothing
  _feishu=""
  if feishu_enabled; then
    _feishu=1
    if feishu_running; then
      say "stopping the Feishu connector"
      "$WRAPPER" feishu stop >/dev/null || warn "  the Feishu connector did not stop cleanly — check 'ccs feishu status'"
    else
      say "the Feishu connector is not running; starting it after the update"
    fi
  fi

  # "Already up to date" is about the release, not about the connector: it is not started at boot, so this may be the
  # only chance to bring it back after a reboot.
  if [ "$(readlink -f "$RELEASE")" = "$_old" ]; then
    say "already up to date"
    if [ -n "$_feishu" ]; then "$WRAPPER" feishu start >/dev/null || warn "the Feishu connector did not start — run 'ccs feishu start'"; fi
    return 0
  fi

  _live=$(running_sessions)
  if [ -n "$_live" ]; then
    say "stopping $(printf '%s\n' "$_live" | wc -l | tr -d ' ') running session(s); conversations are kept"
    printf '%s\n' "$_live" | while IFS= read -r n; do [ -n "$n" ] && { say "  stop $n"; "$WRAPPER" stop "$n" >/dev/null || warn "  '$n' did not stop cleanly — check 'ccs ls'"; }; done
  else
    say "no running sessions"
  fi

  point_current_at "$RELEASE"
  write_wrapper
  say "switched to $(basename "$RELEASE")"

  if [ -n "$_live" ]; then
    printf '%s\n' "$_live" | while IFS= read -r n; do [ -n "$n" ] && { say "  restart $n"; "$WRAPPER" restart "$n" >/dev/null || warn "  '$n' did not restart — run 'ccs restart $n'"; }; done
  fi
  if [ -n "$_feishu" ]; then
    say "  restart the Feishu connector"
    "$WRAPPER" feishu start >/dev/null || warn "  the Feishu connector did not restart — run 'ccs feishu start'"
  fi
  say "updated. Session records in $STATE were not touched."
  say "rollback: ln -sfn '$_old' '$ROOT/current'"
}

cmd_uninstall() {
  _purge=${1:-}
  _live=$(running_sessions)
  if [ -n "$_live" ]; then
    say "stopping running session(s)…"
    printf '%s\n' "$_live" | while IFS= read -r n; do [ -n "$n" ] && "$WRAPPER" stop "$n" >/dev/null 2>&1 || true; done
  fi
  "$WRAPPER" feishu stop >/dev/null 2>&1 || true
  rm -f "$WRAPPER"
  rm -rf "$ROOT"
  say "removed $ROOT and $WRAPPER"
  if [ "$_purge" = "--purge" ]; then
    rm -rf "$STATE" "${XDG_CONFIG_HOME:-$HOME/.config}/ccs"
    say "purged session records and config"
    warn "Claude's own transcripts in ~/.claude/projects were NOT deleted"
  else
    # Not "$0 uninstall --purge": the installed copy of this script was just removed with the install.
    say "session records kept in $STATE (delete them and the config with: rm -rf '$STATE' '${XDG_CONFIG_HOME:-$HOME/.config}/ccs')"
  fi
}

case "${1:-install}" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  uninstall) shift 2>/dev/null || true; cmd_uninstall "${1:-}" ;;
  -h|--help|help)
    cat <<EOF
usage: install.sh [install|update|uninstall [--purge]]

  install     install a release package (or build from source) and put a 'ccs' wrapper on your PATH
  update      get the new version first, then stop running sessions, switch, and start them again
  uninstall   remove the install; session records are kept unless --purge

release package: CCS_VERSION (tag, default latest) CCS_PACKAGE (file or URL) CCS_RELEASES_URL
from source:     CCS_REPO (a clone or git URL; setting it selects the source build) CCS_REF
everywhere:      CCS_HOME CCS_BIN_DIR CCS_STATE_DIR
EOF
    ;;
  *) die "unknown command '$1' (try: install, update, uninstall)" ;;
esac
