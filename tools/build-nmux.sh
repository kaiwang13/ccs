#!/bin/sh
# Builds the nmux binary ccs runs its sessions on, from the nmux-rs source in vendor/, into libexec/nmux or the path given:
#
#   sh tools/build-nmux.sh [OUT]          # npm run nmux:build
#   NMUX_RS_DIR=../nmux-rs sh tools/build-nmux.sh    # from a checkout instead, while working on both
#
# Needs cargo, which rustup puts in ~/.cargo/bin (found there too), and crates.io the first time. The binary replaces the old
# one by a rename, so sessions running on that one carry on.
set -eu
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$REPO_DIR/libexec/nmux}

CARGO=$(command -v cargo 2>/dev/null || true)
[ -n "$CARGO" ] || [ ! -x "$HOME/.cargo/bin/cargo" ] || CARGO="$HOME/.cargo/bin/cargo"
[ -n "$CARGO" ] || { echo "build-nmux: cargo is required to build nmux (https://rustup.rs)" >&2; exit 1; }
PATH="$(dirname "$CARGO"):$PATH"; export PATH

if [ -n "${NMUX_RS_DIR:-}" ]; then
  SRC=$(cd "$NMUX_RS_DIR" && pwd)
else
  TARBALL=$(find "$REPO_DIR/vendor" -name 'nmux-rs-*.tar.gz' | head -1)
  [ -n "$TARBALL" ] || { echo "build-nmux: no vendor/nmux-rs-*.tar.gz (npm run nmux:vendor-rs makes one)" >&2; exit 1; }
  SRC="$REPO_DIR/build/nmux-rs"
  rm -rf "$SRC"; mkdir -p "$SRC"
  tar -xzf "$TARBALL" -C "$SRC" --strip-components=1
fi

echo "build-nmux: building $(sed -n 's/^version = "\(.*\)"$/nmux \1/p' "$SRC/Cargo.toml" | head -1) (a minute or two the first time)"
"$CARGO" build --quiet --locked --release --manifest-path "$SRC/Cargo.toml" --bin nmux --target-dir "$REPO_DIR/build/nmux-target"
mkdir -p "$(dirname "$OUT")"
cp "$REPO_DIR/build/nmux-target/release/nmux" "$OUT.new"
mv -f "$OUT.new" "$OUT"
echo "build-nmux: $("$OUT" --version) in $OUT"
