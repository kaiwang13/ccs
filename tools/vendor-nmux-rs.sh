#!/bin/sh
# Packs the source of the nmux-rs checkout beside this repo, as committed, into vendor/nmux-rs-<version>.tar.gz, and builds
# libexec/nmux from it. That binary is what ccs runs its sessions on and attaches with; the tarball is what an install builds it
# from. Tests and tools are left out: building the binary needs neither. Each release needs its own version, as with nmux.
set -eu
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
RS_DIR=$(cd "${NMUX_RS_DIR:-$REPO_DIR/../nmux-rs}" && pwd)
VERSION=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$RS_DIR/Cargo.toml" | head -1)
[ -n "$VERSION" ] || { echo "no version in $RS_DIR/Cargo.toml" >&2; exit 1; }
FILE="nmux-rs-$VERSION.tar.gz"
[ ! -e "$REPO_DIR/vendor/$FILE" ] || { echo "vendor/$FILE already exists: bump the version in nmux-rs first" >&2; exit 1; }
[ -z "$(git -C "$RS_DIR" status --porcelain)" ] || { echo "$RS_DIR has changes that are not committed: commit them first" >&2; exit 1; }
git -C "$RS_DIR" archive --format=tar.gz --prefix="nmux-rs-$VERSION/" -o "$REPO_DIR/vendor/$FILE.new" HEAD -- . \
  ':(exclude,glob)crates/*/tests/**' ':(exclude)tools'
mv "$REPO_DIR/vendor/$FILE.new" "$REPO_DIR/vendor/$FILE"
find "$REPO_DIR/vendor" -name 'nmux-rs-*.tar.gz' ! -name "$FILE" -exec rm -f {} +
echo "vendor/$FILE: nmux-rs $(git -C "$RS_DIR" rev-parse --short HEAD)"
sh "$REPO_DIR/tools/build-nmux.sh"
