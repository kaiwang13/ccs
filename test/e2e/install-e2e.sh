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
set -eu

REPO_UNDER_TEST="${CCS_E2E_REPO:-https://github.com/kaiwang13/AgentServer.git}"
REF="${CCS_E2E_REF:-main}"
PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/ccs-e2e-XXXXXX")
REAL_STATE="${HOME}/.local/state/ccs"
ok=0; fail=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { ok=$((ok+1));   printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
cleanup() { rm -rf "$PREFIX"; }
trap cleanup EXIT INT TERM

# A stable fingerprint of the real registry: every file's path, size and content hash.
fingerprint() { [ -d "$REAL_STATE" ] || { echo "no-state-dir"; return; }
  find "$REAL_STATE" -type f -print0 2>/dev/null | sort -z \
    | xargs -0 -r sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1; }

BEFORE=$(fingerprint)
say "real registry fingerprint before: ${BEFORE%"${BEFORE#????????}"}…"

export CCS_HOME="$PREFIX/share"
export CCS_BIN_DIR="$PREFIX/bin"
export CCS_STATE_DIR="$PREFIX/state"
export CCS_RUNTIME_DIR="$PREFIX/run"
export CCS_REPO="$REPO_UNDER_TEST"
export CCS_REF="$REF"
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
if "$WRAPPER" ls --json 2>/dev/null | grep -q '^\[\]$\|^\[$'; then pass "isolated registry is empty (cannot see your sessions)"
else bad "isolated install sees sessions — NOT isolated"; "$WRAPPER" ls --json 2>/dev/null | head -5; fi

say "update"
if sh "$INSTALLER" update >"$PREFIX/update.log" 2>&1; then pass "update exited 0"; else bad "update failed"; tail -15 "$PREFIX/update.log"; fi
[ -x "$WRAPPER" ] && pass "wrapper still present after update" || bad "wrapper lost during update"

say "uninstall keeps session records"
# Plant a record so the assertion has something to protect — an empty registry proves nothing.
mkdir -p "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef"
printf '{"schema":"ccs.intent/1","id":"deadbeef","nameAtCreate":"keepme"}\n' > "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json"
RECORD_SUM=$(sha256sum "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json" | cut -d" " -f1)
if sh "$INSTALLER" uninstall >"$PREFIX/uninstall.log" 2>&1; then pass "uninstall exited 0"; else bad "uninstall failed"; tail -15 "$PREFIX/uninstall.log"; fi
[ ! -e "$WRAPPER" ] && pass "wrapper removed" || bad "wrapper still present"
[ ! -d "$CCS_HOME" ] && pass "install root removed" || bad "install root still present"
if [ -f "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json" ] \
   && [ "$(sha256sum "$CCS_STATE_DIR/hosts/testhost/sessions/deadbeef/intent.json" | cut -d" " -f1)" = "$RECORD_SUM" ]; then
  pass "planted session record survives uninstall byte-identical (no --purge)"
else
  bad "uninstall destroyed or altered a session record without --purge"
fi

say "THE STANDING RULE: your real session records are untouched"
AFTER=$(fingerprint)
if [ "$BEFORE" = "$AFTER" ]; then pass "real registry is byte-identical before and after install/update/uninstall"
else bad "REAL REGISTRY CHANGED — install/update/uninstall must never touch session records"; fi

printf '\n%s passed, %s failed\n' "$ok" "$fail"
[ "$fail" -eq 0 ]
