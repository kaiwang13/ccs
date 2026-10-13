#!/bin/sh
# End-to-end test for install.sh: install -> update -> uninstall, entirely inside a throwaway prefix.
#
# THE STANDING RULE this enforces:
#   Installing, updating or uninstalling ccs MUST NOT touch existing session records.
#   A user's sessions are their work. An update is allowed to stop and restart them; it is never
#   allowed to lose, rewrite or orphan a record. This holds for every future feature too — new session
#   kinds (e.g. Codex), new state files, new registry fields — so this test asserts the invariant
#   rather than a particular layout: the registry tree is byte-identical before and after.
#
# The test install is SELF-CONTAINED: its own prefix, its own state dir pinned into its own wrapper, so
# it cannot see or stop the sessions of the install you actually use. Nothing needs sudo.
#
#   sh test/e2e/install-e2e.sh                 # test the published main branch
#   CCS_E2E_REPO=$PWD sh test/e2e/install-e2e.sh   # test this working copy instead
#   CCS_E2E_PACKAGE=dist/ccs-linux-x64.tar.gz sh test/e2e/install-e2e.sh   # test a release package (no build)
set -eu

REPO_UNDER_TEST="${CCS_E2E_REPO:-https://github.com/kaiwang13/ccs.git}"
REF="${CCS_E2E_REF:-main}"
PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/ccs-e2e-XXXXXX")
REAL_STATE="${HOME}/.local/state/ccs"
ok=0; fail=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { ok=$((ok+1));   printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
cleanup() { rm -rf "$PREFIX"; }
# macOS has shasum, not sha256sum; the output format is the same.
if command -v sha256sum >/dev/null 2>&1; then SHA256=sha256sum; else SHA256="shasum -a 256"; fi
trap cleanup EXIT INT TERM

# Fingerprint of what the installer must never touch: the set of session records, and every intent.json.
#
# state.json is DELIBERATELY EXCLUDED. intent.json is the user's intent and is written only by CLI
# processes; state.json is runtime state owned by each live sessiond, which rewrites it continuously
# (heartbeats, status transitions). Hashing it would make this test fail on any machine that is actually
# running sessions — the exact people it protects. Excluding it does not weaken the check: a deleted,
# added or rewritten record still changes the record list or an intent.json.
fingerprint() { [ -d "$REAL_STATE" ] || { echo "no-state-dir"; return; }
  { find "$REAL_STATE" -mindepth 1 -maxdepth 4 -type d -print 2>/dev/null | sort
    find "$REAL_STATE" -type f ! -name 'state.json' -print0 2>/dev/null | sort -z \
      | xargs -0 -r $SHA256 2>/dev/null
  } | $SHA256 | cut -d' ' -f1; }

BEFORE=$(fingerprint)
say "real registry fingerprint before: ${BEFORE%"${BEFORE#????????}"}…"

export CCS_HOME="$PREFIX/share"
export CCS_BIN_DIR="$PREFIX/bin"
export CCS_STATE_DIR="$PREFIX/state"
export CCS_RUNTIME_DIR="$PREFIX/run"
if [ -n "${CCS_E2E_PACKAGE:-}" ]; then
  # A release package installs without git, npm or a compiler; CCS_REPO must be unset or it selects the source build.
  unset CCS_REPO
  export CCS_PACKAGE="$CCS_E2E_PACKAGE"
else
  export CCS_REPO="$REPO_UNDER_TEST"
  export CCS_REF="$REF"
fi
WRAPPER="$CCS_BIN_DIR/ccs"
INSTALLER=${CCS_E2E_INSTALLER:-./install.sh}

say "install"
if sh "$INSTALLER" install >"$PREFIX/install.log" 2>&1; then pass "installer exited 0"; else bad "installer failed"; tail -15 "$PREFIX/install.log"; fi
[ -x "$WRAPPER" ] && pass "wrapper is executable at \$CCS_BIN_DIR/ccs" || bad "no wrapper"
[ -L "$CCS_HOME/current" ] && pass "current is a symlink to an immutable release" || bad "current is not a symlink"

grep -q 'CCS_STATE_DIR=' "$WRAPPER" && pass "wrapper pins CCS_STATE_DIR (install is isolated)" || bad "wrapper does not pin the state dir"
grep -qE '^[^#]*\b(sudo|doas)\b' "$INSTALLER" && bad "installer invokes sudo/doas" || pass "installer never invokes sudo (root is never required)"

# Everything written must live under the prefix.
outside=$(find "$CCS_HOME" -maxdepth 0 2>/dev/null | wc -l)
[ "$outside" -eq 1 ] && pass "install root created inside the prefix" || bad "install root missing"

say "the installed ccs runs and is pointed at its own registry"
if "$WRAPPER" ls >"$PREFIX/ls.log" 2>&1; then pass "ccs ls exits 0"; else bad "ccs ls failed"; tail -5 "$PREFIX/ls.log"; fi
if "$WRAPPER" ls --json 2>/dev/null | grep -q '^\[\]$'; then pass "isolated registry is empty (cannot see your sessions)"
else bad "isolated install sees sessions — NOT isolated"; "$WRAPPER" ls --json 2>/dev/null | head -5; fi

say "the Feishu add-on stays off unless set up"
if [ -n "${CCS_E2E_PACKAGE:-}" ]; then
  # A package carries the add-on's (pure JS) dependencies so it never needs npm; they stay unused until set up.
  [ -x "$CCS_HOME/current/runtime/bin/node" ] && pass "package runs on its bundled node" || bad "package has no runtime/bin/node"
  grep -q 'current/runtime/bin/node' "$WRAPPER" && pass "wrapper runs the bundled node" || bad "wrapper does not run the bundled node"
  [ -d "$CCS_HOME/current/addons/feishu/node_modules/@larksuite/channel" ] && pass "Feishu dependencies are bundled" || bad "Feishu dependencies missing from the package"
else
  [ ! -d "$CCS_HOME/current/addons/feishu/node_modules" ] && pass "no Feishu dependencies installed without the enabled marker" || bad "Feishu dependencies installed although the add-on was never enabled"
fi
"$WRAPPER" feishu status >/dev/null 2>&1 && _fs=0 || _fs=$?
[ "$_fs" -eq 2 ] && pass "ccs feishu status: not set up (exit 2)" || bad "ccs feishu status exited $_fs, expected 2"

say "update"
if sh "$INSTALLER" update >"$PREFIX/update.log" 2>&1; then pass "update exited 0"; else bad "update failed"; tail -15 "$PREFIX/update.log"; fi
[ -x "$WRAPPER" ] && pass "wrapper still present after update" || bad "wrapper lost during update"
grep -q "Feishu" "$PREFIX/update.log" && bad "update touched Feishu although the add-on was never enabled" || pass "update leaves the Feishu add-on alone when it is not enabled"

# The connector is not started at boot, so "not running" must not be read as "never set up": an enabled add-on whose
# connector is down (a reboot) still has to be started by the update. Setup itself is skipped — it needs a QR code —
# so the start fails for want of config.json, which is enough to prove the attempt.
say "an enabled add-on is started by update even when its connector is not running"
mkdir -p "$CCS_STATE_DIR/feishu" && : > "$CCS_STATE_DIR/feishu/enabled"
if sh "$INSTALLER" update >"$PREFIX/update2.log" 2>&1; then pass "update exited 0 with the add-on enabled"; else bad "update failed with the add-on enabled"; tail -15 "$PREFIX/update2.log"; fi
grep -q "not running; starting it after the update" "$PREFIX/update2.log" && pass "update noticed the connector was down" || bad "update did not notice the connector was down"
grep -qE "restart the Feishu connector|did not start" "$PREFIX/update2.log" && pass "update tried to start the connector" || bad "update did not try to start the connector"
[ ! -e "$CCS_STATE_DIR/feishu/enabled" ] || rm -f "$CCS_STATE_DIR/feishu/enabled"

say "uninstall keeps session records"
# Plant a record so the assertion has something to protect — an empty registry proves nothing.
mkdir -p "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef"
printf '{"schema":"ccs.intent/1","id":"deadbeef","nameAtCreate":"keepme"}\n' > "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json"
RECORD_SUM=$($SHA256 "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json" | cut -d" " -f1)
if sh "$INSTALLER" uninstall >"$PREFIX/uninstall.log" 2>&1; then pass "uninstall exited 0"; else bad "uninstall failed"; tail -15 "$PREFIX/uninstall.log"; fi
[ ! -e "$WRAPPER" ] && pass "wrapper removed" || bad "wrapper still present"
[ ! -d "$CCS_HOME" ] && pass "install root removed" || bad "install root still present"
if [ -f "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json" ] \
   && [ "$($SHA256 "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json" | cut -d" " -f1)" = "$RECORD_SUM" ]; then
  pass "planted session record survives uninstall byte-identical (no --purge)"
else
  bad "uninstall destroyed or altered a session record without --purge"
fi

say "THE STANDING RULE: your real session records are untouched"
AFTER=$(fingerprint)
if [ "$BEFORE" = "$AFTER" ]; then pass "real session records unchanged: same record set, every intent.json byte-identical"
else bad "REAL SESSION RECORDS CHANGED — install/update/uninstall must never touch them"
  find "$REAL_STATE" -type f ! -name 'state.json' -newer "$PREFIX/install.log" -print 2>/dev/null | head -5
fi

printf '\n%s passed, %s failed\n' "$ok" "$fail"
[ "$fail" -eq 0 ]
