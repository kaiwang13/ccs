#!/bin/sh
# Packs the nmux checkout beside this repo into vendor/ and points ccs at it. Each release needs its own version: npm keys the
# lockfile and its cache on the name, so the same version with new contents would install the old code, or fail on a clean machine.
set -eu
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
NMUX_DIR="$REPO_DIR/../nmux"
VERSION=$(node -p "require('$NMUX_DIR/package.json').version")
FILE="nmux-$VERSION.tgz"
[ ! -e "$REPO_DIR/vendor/$FILE" ] || { echo "vendor/$FILE already exists: bump the version in nmux first" >&2; exit 1; }
cd "$REPO_DIR"
rm -f vendor/nmux-*.tgz
( cd "$NMUX_DIR" && npm pack --silent --pack-destination "$REPO_DIR/vendor" >/dev/null )
rm -rf node_modules/nmux
npm pkg set "dependencies.nmux=file:vendor/$FILE"
npm install --silent --no-audit --no-fund
echo "ccs now depends on $FILE"
