#!/usr/bin/env bash
# The Linux half of .github/workflows/tests.yml, run locally in docker with act (https://github.com/nektos/act).
# macOS cannot run in a Linux container, so macos-latest stays on GitHub.
#
#   tools/local-ci.sh                 test the working tree, uncommitted changes included
#   tools/local-ci.sh REV             test a commit exactly as committed (in a temporary worktree)
#   tools/local-ci.sh install-hook    run it before every `git push` (skip once: git push --no-verify)
#
# CCS_CI_PROXY (default http://172.25.101.2:2717, 'none' for no proxy) is used by act and inside the container.
# CCS_CI_IMAGE overrides the runner image. Logs: $TMPDIR/ccs-local-ci-*.log.
set -euo pipefail

REPO=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
PROXY=${CCS_CI_PROXY:-http://172.25.101.2:2717}
IMAGE=${CCS_CI_IMAGE:-catthehacker/ubuntu:act-24.04}

if [ "${1:-}" = install-hook ]; then
  hook=$(git -C "$REPO" rev-parse --git-path hooks)/pre-push
  case $hook in /*) ;; *) hook=$REPO/$hook ;; esac
  cat > "$hook" <<'EOF'
#!/usr/bin/env bash
# Installed by tools/local-ci.sh install-hook: every pushed commit passes the Linux CI locally first.
# Skip once: git push --no-verify, or CCS_SKIP_LOCAL_CI=1 git push.
[ -n "${CCS_SKIP_LOCAL_CI:-}" ] && exit 0
zero=0000000000000000000000000000000000000000
tested=
while read -r _lref lsha _rref _rsha; do
  [ "$lsha" = "$zero" ] && continue          # a deleted branch has nothing to test
  case " $tested " in *" $lsha "*) continue ;; esac
  "$(git rev-parse --show-toplevel)/tools/local-ci.sh" "$lsha" || { echo "pre-push: local CI failed for $lsha; not pushing (skip: git push --no-verify)" >&2; exit 1; }
  tested="$tested $lsha"
done
EOF
  chmod +x "$hook"
  echo "installed $hook"
  exit 0
fi

command -v act >/dev/null || { echo "local-ci: act is not on PATH (build it: make -C ~/projects/cnv_gene/act build)" >&2; exit 2; }

dir=$REPO
cleanup() { :; }
if [ $# -ge 1 ]; then
  sha=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
  dir=$(mktemp -d "${TMPDIR:-/tmp}/ccs-ci-XXXXXX")
  git -C "$REPO" worktree add --detach --quiet "$dir" "$sha"
  cleanup() { git -C "$REPO" worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"; }
  echo "local-ci: testing $(git -C "$REPO" log -1 --format='%h %s' "$sha")"
else
  echo "local-ci: testing the working tree of $REPO"
fi
trap cleanup EXIT

envs=()
if [ "$PROXY" != none ]; then
  export http_proxy=$PROXY https_proxy=$PROXY HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY
  for k in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY; do envs+=(--env "$k=$PROXY"); done
  envs+=(--env NO_PROXY=localhost,127.0.0.1 --env no_proxy=localhost,127.0.0.1)
fi

log=$(mktemp "${TMPDIR:-/tmp}/ccs-local-ci-XXXXXX.log")
echo "local-ci: log $log"
# --init: without a reaping PID 1, processes the tests orphan stay zombies and count as leaked.
set +e
(cd "$dir" && act push -W .github/workflows/tests.yml --matrix os:ubuntu-latest -P "ubuntu-latest=$IMAGE" \
  --container-options=--init "${envs[@]}") 2>&1 | tee "$log" | grep --line-buffered -E '⭐ Run|✅|❌|🏁|\| not ok|\| # (pass|fail) '
status=${PIPESTATUS[0]}
set -e
if [ "$status" -eq 0 ]; then echo "local-ci: passed"; else echo "local-ci: FAILED (exit $status); see $log" >&2; fi
exit "$status"
