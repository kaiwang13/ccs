#!/bin/sh
# Build a self-contained ccs release package for the machine this runs on.
#
#   sh tools/build-release.sh [outdir]          # default outdir: ./dist
#
# Produces <outdir>/ccs-<os>-<arch>.tar.gz (+ .sha256). The package needs nothing on the target machine but
# `tar` and a POSIX shell: it carries the pinned Node (package.json engines) as runtime/bin/node, the production
# dependencies with node-pty compiled for that Node, the ttyctl addon, and the Feishu add-on's dependencies. Users
# install it with the install.sh inside it (or install.sh downloads it); nothing is compiled on their machine.
#
# The build machine needs a C/C++ toolchain, make, python3, curl and tar — NOT a Node install: the official Node
# binary for this platform is downloaded (checksum-verified) and builds the package itself, so the native addons are
# compiled against exactly the Node they will run on. Native code is built for the machine running the script: build
# Linux packages on the oldest glibc you want to support (CI uses manylinux_2_28, the same floor as Node 24 itself).
set -eu

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$REPO_DIR/dist}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)

say() { printf '\033[1mbuild-release:\033[0m %s\n' "$*"; }
die() { printf '\033[31mbuild-release: %s\033[0m\n' "$*" >&2; exit 1; }

json_field() { sed -n "s/^ *\"$1\": *\"\([^\"]*\)\".*/\1/p" "$REPO_DIR/package.json" | head -1; }
VERSION=$(json_field version)
NODE_VERSION=$(json_field node)
[ -n "$VERSION" ] && [ -n "$NODE_VERSION" ] || die "could not read version / engines.node from package.json"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

COMMIT=${CCS_PKG_COMMIT:-$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)}
COMMIT=$(printf '%s' "$COMMIT" | cut -c1-7)
NAME="ccs-$VERSION-$OS-$ARCH"
ASSET="ccs-$OS-$ARCH.tar.gz"

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ---- the pinned Node, verified against the release's SHASUMS256.txt -------------------------------------------
CACHE="$OUT/.cache"; mkdir -p "$CACHE"
NODE_DIST="node-v$NODE_VERSION-$OS-$ARCH"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"
if [ ! -x "$CACHE/$NODE_DIST/bin/node" ]; then
  say "downloading Node $NODE_VERSION ($OS-$ARCH)"
  curl -fsSL -o "$CACHE/$NODE_DIST.tar.gz" "$NODE_URL/$NODE_DIST.tar.gz"
  curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "$NODE_URL/SHASUMS256.txt"
  want=$(grep " $NODE_DIST.tar.gz\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)
  got=$(sha256_of "$CACHE/$NODE_DIST.tar.gz")
  [ -n "$want" ] && [ "$want" = "$got" ] || die "checksum mismatch for $NODE_DIST.tar.gz (want $want, got $got)"
  rm -rf "${CACHE:?}/$NODE_DIST"
  tar -xzf "$CACHE/$NODE_DIST.tar.gz" -C "$CACHE"
fi
NODE_HOME="$CACHE/$NODE_DIST"
PATH="$NODE_HOME/bin:$PATH"; export PATH
# Native addons are built against this Node's own headers (shipped in the tarball), never downloaded ones.
npm_config_nodedir="$NODE_HOME"; export npm_config_nodedir
[ "$(node -p process.version)" = "v$NODE_VERSION" ] || die "staged node is not v$NODE_VERSION"

# ---- stage the sources -------------------------------------------------------------------------------------------
STAGE="$OUT/stage/$NAME"
rm -rf "$OUT/stage"; mkdir -p "$STAGE"
say "staging $NAME (commit $COMMIT)"
# Runtime files only: tests, CI config and local debugging/design notes stay out of the package.
( cd "$REPO_DIR" && tar -cf - \
    --exclude=node_modules --exclude=build --exclude='*.log' \
    --exclude=docs/superpowers --exclude=docs/debug --exclude=tools/local-ci.sh \
    bin src addons native/ttyctl/binding.gyp native/ttyctl/ttyctl.c tools docs \
    package.json package-lock.json install.sh README.md LICENSE ) | ( cd "$STAGE" && tar -xf - )

say "installing production dependencies (node-pty is built for Node $NODE_VERSION)"
( cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )
say "building the ttyctl addon"
( cd "$STAGE" && npm run --silent build:native )
say "installing the Feishu add-on's dependencies"
( cd "$STAGE/addons/feishu" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )

# ---- prune build leftovers and other platforms' binaries -----------------------------------------------------------
TTY="$STAGE/native/ttyctl/build/Release/ttyctl.node"
[ -f "$TTY" ] || die "native build produced no ttyctl.node"
mv "$TTY" "$STAGE/ttyctl.node.keep"
rm -rf "$STAGE/native/ttyctl/build"; mkdir -p "$STAGE/native/ttyctl/build/Release"
mv "$STAGE/ttyctl.node.keep" "$TTY"

PTY="$STAGE/node_modules/node-pty"
rm -rf "$PTY/deps" "$PTY/third_party" "$PTY/src" "$PTY/build/Release/obj.target" "$PTY/build/Release/.deps" \
       "$PTY/build/Release/obj" "$PTY/build/deps"
if [ -d "$PTY/prebuilds" ]; then
  for d in "$PTY"/prebuilds/*; do [ "$(basename "$d")" = "$OS-$ARCH" ] || rm -rf "$d"; done
fi
find "$PTY/build" -maxdepth 1 -type f -delete 2>/dev/null || true   # Makefile, config.gypi, *.mk

# ---- the runtime -----------------------------------------------------------------------------------------------------
mkdir -p "$STAGE/runtime/bin"
cp "$NODE_HOME/bin/node" "$STAGE/runtime/bin/node"
cp "$NODE_HOME/LICENSE" "$STAGE/runtime/LICENSE"

cat > "$STAGE/RELEASE" <<EOF
name=ccs
version=$VERSION
commit=$COMMIT
os=$OS
arch=$ARCH
node=$NODE_VERSION
EOF

# ---- the package must work from its own runtime before it is shipped -------------------------------------------------
say "checking the staged package"
( cd "$STAGE" && runtime/bin/node -e '
    require("./src/common/native.js");
    const pty = require("node-pty");
    const p = pty.spawn("/bin/sh", ["-c", "echo ccs-pty-ok"], { cols: 80, rows: 24 });
    let out = "";
    p.onData((d) => (out += d));
    p.onExit(({ exitCode }) => {
      if (exitCode !== 0 || !out.includes("ccs-pty-ok")) { console.error("pty check failed:", exitCode, JSON.stringify(out)); process.exit(1); }
    });' ) || die "the staged package does not run"
( cd "$STAGE" && runtime/bin/node bin/ccs.js help >/dev/null ) || die "ccs help failed in the staged package"

rm -f "$OUT/$ASSET" "$OUT/$ASSET.sha256"
( cd "$OUT/stage" && tar -czf "$OUT/$ASSET" "$NAME" )
printf '%s  %s\n' "$(sha256_of "$OUT/$ASSET")" "$ASSET" > "$OUT/$ASSET.sha256"
say "built $OUT/$ASSET ($(du -h "$OUT/$ASSET" | cut -f1)) — $NAME"
