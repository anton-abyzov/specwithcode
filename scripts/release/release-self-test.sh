#!/bin/bash
# Self-test for scripts/release/release.sh: `bash scripts/release/release.sh --self-test`.
#
# Everything runs in a new temporary folder with RELEASE_STUB=1, so release.sh records each
# command in <staging>/<version>/stub.log instead of running it: no network, no signing, no
# GitHub release, no fleet request and no desktop app is touched. Covered: argument errors,
# the dry-run (nothing written), stage order, resume after a failed stage, refusing a second run
# and a staging folder release.sh did not make, a new candidate rerunning only per-candidate
# stages with the server suite on --changed, stage 1 rerunning its failures first, refusing a
# new candidate once published, missing release-gates interfaces, a failed lookup of the previous
# release, guards for unpushed release-branch work, untracked fix files and a stale public tag,
# the timing comparison and release_tools.py's own unit tests (test-release-tools.py). Also:
# public before the fleet, a staging folder from the earlier order (fleet before public) resuming,
# the fleet stages refusing a release the public feed does not show, the Electron runtime repair
# and its failure, the plan checked into SHA256SUMS before drafts and on the draft before
# publishing, the previous release's digests file, the public clone's noreply identity and a --ci
# rerun removing the bump-only release branch a failed run left.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASE="$HERE/release.sh"
TOOLS="$HERE/release_tools.py"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/release-self-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
SHA_C=cccccccccccccccccccccccccccccccccccccccc
PASSED=0
FAILED=0
LAST_OUT="$WORK/last.out"
FINISHED=0

cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [ "$FINISHED" -ne 1 ]; then
    printf 'release self-test stopped early (exit %s) after %d passed, %d failed\n' "$rc" "$PASSED" "$FAILED" >&2
    exit 1
  fi
}
trap cleanup EXIT

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok   %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$1"
  if [ -f "$LAST_OUT" ]; then sed 's/^/     | /' "$LAST_OUT" | tail -n 25; fi
}

check() {  # check NAME COMMAND...: passes when COMMAND succeeds
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

# run EXPECTED_RC ARGS...: release.sh with the stub environment; output in $LAST_OUT.
run() {
  local expected="$1" rc
  shift
  set +e
  env "${STUB_ENV[@]}" bash "$RELEASE" "$@" > "$LAST_OUT" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne "$expected" ]; then
    printf '     (release.sh %s exited %s, expected %s)\n' "$*" "$rc" "$expected" >> "$LAST_OUT"
    return 1
  fi
  return 0
}

has() { grep -qF -- "$1" "$LAST_OUT"; }
lacks() { ! grep -qF -- "$1" "$LAST_OUT"; }

# Stages in the order their first stubbed command appears after line $1 of the stub log.
stages_after() {
  awk -F '\t' -v from="$1" 'NR > from && $1 != "server" && !seen[$1]++ { printf "%s ", $1 }' "$STUB_LOG"
}

lines() { if [ -f "$STUB_LOG" ]; then wc -l < "$STUB_LOG" | tr -d ' '; else printf '0\n'; fi; }

wait_for_server() {  # wait_for_server SHA: the background stub server suite has finished
  local tries=0
  while [ "$tries" -lt 150 ]; do
    if [ -f "$STAGE/server.exit" ] && [ "$(cut -d' ' -f1 < "$STAGE/server.exit")" = "$1" ]; then return 0; fi
    sleep 0.2
    tries=$((tries + 1))
  done
  printf '     (no server result for %s)\n' "$1" >> "$LAST_OUT"
  return 1
}

# ---------------------------------------------------------------- a fake release machine

make_machine() {  # make_machine ROOT: secrets, toolchain, fleet files and release trees
  local root="$1" tree
  mkdir -p "$root/secrets" "$root/sdk" "$root/nvm/versions/node/v22.20.0/bin" "$root/fleet" "$root/public-rules"
  printf 'stub certificate\n' > "$root/secrets/cert.p12"
  printf 'stub passphrase\n' > "$root/secrets/p12.passphrase"
  printf 'stub key\n' > "$root/secrets/AuthKey_STUB.p8"
  printf 'STUDIO_GOOGLE_OAUTH_CLIENT_ID=stub-id\nSTUDIO_GOOGLE_OAUTH_CLIENT_SECRET=stub-secret\n' > "$root/secrets/google.env"
  cat > "$root/secrets/release.env" << EOF
CSC_LINK_PATH="$root/secrets/cert.p12"
CSC_PASSPHRASE_FILE="$root/secrets/p12.passphrase"
APPLE_API_KEY_PATH="$root/secrets/AuthKey_STUB.p8"
APPLE_API_KEY_ID="STUB"
APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
GOOGLE_OAUTH_ENV_FILE="$root/secrets/google.env"
NODE_VERSION="22.20.0"
SDKROOT="$root/sdk"
EOF
  chmod 600 "$root/secrets/"*
  printf '{}\n' > "$root/fleet/hosts.json"
  : > "$root/fleet/id_ed25519"
  : > "$root/fleet/known_hosts"
  printf '{"replace": [], "deny": []}\n' > "$root/public-rules/rules.json"
  for tree in build test public; do
    mkdir -p "$root/trees.noindex/$tree"
    printf 'gitdir: stub\n' > "$root/trees.noindex/$tree/.git"
  done
  mkdir -p "$root/trees.noindex/test/scripts/studio-verify" "$root/trees.noindex/test/scripts/studio-fleet" \
    "$root/trees.noindex/test/scripts/release" "$root/trees.noindex/build/scripts/studio-fleet"
  : > "$root/trees.noindex/test/scripts/studio-verify/typecheck-gate.sh"
  : > "$root/trees.noindex/test/scripts/studio-fleet/run-tests.sh"
  : > "$root/trees.noindex/test/scripts/release/test-sharded.mjs"
  : > "$root/trees.noindex/build/scripts/studio-fleet/make_helpers.py"
  mkdir -p "$root/trees.noindex/build/apps/desktop/scripts" "$root/trees.noindex/build/apps/desktop/node_modules/electron"
  : > "$root/trees.noindex/build/apps/desktop/scripts/ensure-electron-runtime.mjs"
  : > "$root/trees.noindex/build/apps/desktop/node_modules/electron/install.js"
}

use_machine() {  # use_machine ROOT VERSION
  local root="$1"
  STAGING="$root/staging"
  STAGE="$STAGING/$2"
  STUB_LOG="$STAGE/stub.log"
  STUB_ENV=(HOME="$root/home" RELEASE_STUB=1 RELEASE_STAGING_ROOT="$STAGING" RELEASE_TREES="$root/trees.noindex"
    RELEASE_ENV="$root/secrets/release.env" NVM_DIR="$root/nvm" STUDIO_FLEET_HOSTS="$root/fleet/hosts.json"
    STUDIO_PUBLIC_RULES="$root/public-rules/rules.json" RELEASE_DESKTOP_APP="$root/Applications/SpecWithCode.app"
    RELEASE_STUB_PREVIOUS=1.1.0 RELEASE_STUB_SHA="$SHA_A" RELEASE_STUB_FAIL= RELEASE_STUB_STATUS= RELEASE_STUB_OUTPUT=
    RELEASE_JOBS=2)
  mkdir -p "$root/home"
}

stub_set() {  # stub_set NAME=VALUE...: change the stub environment for the next runs
  local pair index
  for pair in "$@"; do
    index=0
    while [ "$index" -lt "${#STUB_ENV[@]}" ]; do
      if [ "${STUB_ENV[$index]%%=*}" = "${pair%%=*}" ]; then STUB_ENV[$index]="$pair"; fi
      index=$((index + 1))
    done
  done
}

# The checkout's status before and after; a copy outside git compares as "not a git checkout".
repo_state() {
  if git -C "$REPO_ROOT" rev-parse --git-dir > /dev/null 2>&1; then
    git -C "$REPO_ROOT" status --porcelain | cksum
  else
    printf 'not a git checkout\n'
  fi
}
REPO_STATE_BEFORE="$(repo_state)"

# ---------------------------------------------------------------- arguments

ARGS_HOME="$WORK/args-home"
mkdir -p "$ARGS_HOME"
STUB_ENV=(HOME="$ARGS_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES=)
arguments_ok() {
  run 2 || return 1
  run 2 1.2 || return 1
  run 2 1.2.0 --bogus || return 1
  run 2 1.2.0 1.3.0 || return 1
  run 2 1.2.0 --jobs 9 || return 1
  run 2 1.2.0 --stop-after nowhere || return 1
  run 2 1.2.0 --dry-run --resume || return 1
  run 2 1.2.0 --previous 1.1 || return 1
  run 2 1.2.0 --stop-after || return 1
  run 2 --self-test 1.2.0 || return 1
  STUB_ENV=(HOME="$ARGS_HOME" RELEASE_STUB=1 RELEASE_STAGING_ROOT= RELEASE_TREES=)
  run 2 1.2.0 || return 1
  has 'RELEASE_STUB needs RELEASE_STAGING_ROOT and RELEASE_TREES' || return 1
  STUB_ENV=(HOME="$ARGS_HOME" RELEASE_STUB=)
  run 0 --help || return 1
  has 'Stages, in order' && has '--resume'
}
check 'bad arguments exit 2 and --help prints the usage' arguments_ok
check 'argument errors write nothing' test -z "$(find "$ARGS_HOME" -mindepth 1 -print -quit)"

# ---------------------------------------------------------------- dry-run

DRY_HOME="$WORK/dry-home"
mkdir -p "$DRY_HOME"
STUB_ENV=(HOME="$DRY_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_ENV=)
EXPECTED_ORDER="preflight trees prev bump candidate stage1 server build bundle sign helpers plan drafts server-wait quit-desktop publish-private publish-public fleet-m4 fleet-workers desktop merge"
dry_ok() {
  run 0 9.9.9 --dry-run || return 1
  [ "$(sed -n 's/^> \([a-z0-9-]*\).*/\1/p' "$LAST_OUT" | tr '\n' ' ' | sed 's/ $//')" = "$EXPECTED_ORDER" ] || return 1
  has 'would stop: the installer and updater accept only 1.x.y' && has 'Dry-run done: nothing was run or written.' &&
    has 'test-sharded.mjs --shards 3' && has 'fleet_rollout.py --version 9.9.9 --only m4 --hold-minutes 15' &&
    has '--arg=--allow-project-migrations --arg=--allow-existing-browser-heartbeat' &&
    has 'electron-check: (in ' && has 'sums-check: python3 -B' && has 'fetch-sums-private: gh release download v9.9.9' &&
    has "verify-sums --dir $DRY_HOME/.specwithcode/release-staging/9.9.9/prev --digests" &&
    has 'fleet-feed: stop unless v9.9.9 is published on anton-abyzov/specwithcode' &&
    has 'public-identity: (in ' && has 'same-sums-public: stop unless' || return 1
  run 0 9.9.9 --dry-run --no-project-migrations || return 1
  lacks 'allow-project-migrations' && has '--arg=--allow-existing-browser-heartbeat'
}
check 'dry-run lists every stage in order and both plan flags unless told otherwise' dry_ok
check 'dry-run writes nothing under HOME' test -z "$(find "$DRY_HOME" -mindepth 1 -print -quit)"
CI_ORDER="preflight trees prev bump candidate stage1 server build bundle sign helpers plan drafts server-wait publish-private publish-public merge"
dry_ci_ok() {
  run 0 9.9.9 --dry-run --ci || return 1
  [ "$(sed -n 's/^> \([a-z0-9-]*\).*/\1/p' "$LAST_OUT" | tr '\n' ' ' | sed 's/ $//')" = "$CI_ORDER" ] &&
    has 'fleet-m4, fleet-workers, desktop: skipped (--ci)' && lacks 'fleet_rollout.py' && lacks 'osascript'
}
check '--ci leaves out quit-desktop, the fleet stages and the desktop swap' dry_ci_ok

# ---------------------------------------------------------------- a release that fails at sign, then resumes

M="$WORK/m"
make_machine "$M"
use_machine "$M" 1.2.0
mkdir -p "$STAGING/1.1.0/timings"
cat > "$STAGING/1.1.0/timings/stages.json" << 'EOF'
{"schemaVersion": 1, "version": "1.1.0", "wallSeconds": 100,
 "stages": [{"stage": "build", "seconds": 0, "status": "ok", "attempts": 1, "totalSeconds": 0}]}
EOF

stub_set RELEASE_STUB_FAIL=sign
first_ok() {
  run 1 1.2.0 || return 1
  has 'stage sign failed' && has 'bash scripts/release/release.sh 1.2.0 --resume' || return 1
  wait_for_server "$SHA_A" || return 1
  [ "$(stages_after 0)" = "prev bump candidate stage1 build bundle sign " ] || return 1
  local stage
  for stage in prev bump candidate stage1 build bundle server; do [ -f "$STAGE/markers/$stage" ] || return 1; done
  [ ! -f "$STAGE/markers/sign" ] && [ "$(cat "$STAGE/markers/stage1")" = "$SHA_A" ] &&
    [ "$(cat "$STAGE/markers/prev")" = once ] && [ "$(cat "$STAGE/candidate.sha")" = "$SHA_A" ]
}
check 'a failed stage stops the run and leaves earlier stages marked' first_ok
check 'the failed run kept its log and timings' grep -q '"stage": "sign"' "$STAGE/timings/stages.json"
check 'the first server run is a full run (no --changed)' \
  sh -c "grep '^server' '$STUB_LOG' | grep -q 'test-sharded.mjs' && ! grep '^server' '$STUB_LOG' | grep -q -- '--changed'"
check 'stage 1 ran contrast, every package, typecheck and fleet' \
  sh -c "grep -c '^stage1' '$STUB_LOG' | grep -qx 5"

second_refused() { run 1 1.2.0 && has 'continue it with --resume'; }
check 'a second run without --resume is refused' second_refused

stub_set RELEASE_STUB_FAIL=
BEFORE="$(lines)"
resume_ok() {
  run 0 1.2.0 --resume --stop-after drafts || return 1
  has '= prev: done' && has '= stage1: done' && has '= bundle: done' && has 'Stopped after drafts' || return 1
  [ "$(stages_after "$BEFORE")" = "sign helpers plan drafts " ] || return 1
  [ -f "$STAGE/markers/drafts" ] && [ ! -f "$STAGE/markers/server-wait" ]
}
check '--resume continues at the failed stage and --stop-after stops' resume_ok
check 'resume kept the server result (no second server run)' \
  sh -c "[ \$(grep -c '^server' '$STUB_LOG') -eq 1 ]"

# ---------------------------------------------------------------- a fix: new candidate, stage-1 failure first

stub_set RELEASE_STUB_SHA="$SHA_B" "RELEASE_STUB_FAIL=stage1:test:packages/shared"
BEFORE="$(lines)"
candidate_fail_ok() {
  run 1 1.2.0 --resume || return 1
  has 'New candidate bbbbbbbbbbbb' && has 'stage 1 failed: packages_shared' || return 1
  [ "$(stages_after "$BEFORE")" = "candidate stage1 " ] || return 1
  grep -qx packages_shared "$STAGE/stage1/failed.txt" && [ "$(cat "$STAGE/candidate.sha")" = "$SHA_B" ]
}
check 'a new candidate reruns stage 1 and a failure blocks the build' candidate_fail_ok

stub_set RELEASE_STUB_FAIL=
BEFORE="$(lines)"
candidate_ok() {
  run 0 1.2.0 --resume --stop-after drafts || return 1
  has 'rerunning last attempt'"'"'s failures first: packages_shared' || return 1
  [ "$(stages_after "$BEFORE")" = "stage1 build bundle sign helpers plan drafts " ] || return 1
  wait_for_server "$SHA_B" || return 1
  awk -F '\t' -v from="$BEFORE" 'NR > from && $1 == "server"' "$STUB_LOG" | grep -q -- "--changed $SHA_A" &&
    [ ! -f "$STAGE/stage1/failed.txt" ] && [ "$(cat "$STAGE/markers/sign")" = "$SHA_B" ]
}
check 'after the fix: failures first, signed build again, server on --changed <green>' candidate_ok

# ---------------------------------------------------------------- publish, fleet, desktop, merge

# The public clone still has the tag of a push that failed; the public remote has none.
stub_set RELEASE_STUB_OUTPUT=public-local-tag=v1.2.0
BEFORE="$(lines)"
finish_ok() {
  run 0 1.2.0 --resume || return 1
  has 'SpecWithCode 1.2.0 is released.' && has 'Stage timings for 1.2.0, compared with 1.1.0' || return 1
  [ "$(stages_after "$BEFORE")" = "publish-private publish-public fleet-m4 fleet-workers desktop merge " ] || return 1
  local order
  order="$(awk -F '\t' -v from="$BEFORE" 'NR > from { printf "%s ", $2 }' "$STUB_LOG")"
  case "$order" in
    *fetch-sums-private*check-sums-private*publish-private*public-untag*mirror-publish*fetch-sums-public*check-sums-public*publish-public*fleet-m4*fleet-workers*desktop-install*desktop-open*pr-merge*) ;;
    *) return 1 ;;
  esac
  grep -q 'fleet_rollout.py --version 1.2.0 --only m4 --hold-minutes 15' "$STUB_LOG" &&
    grep -q 'publish.mjs --public .* --ref '"$SHA_B"' --tag --push' "$STUB_LOG" &&
    [ "$(cat "$STAGE/published.sha")" = "$SHA_B" ]
}
check 'publish private, then public, then M4, then M1 and M3, desktop and merge' finish_ok
stub_set RELEASE_STUB_OUTPUT=

BEFORE="$(lines)"
done_ok() {
  run 0 1.2.0 --resume || return 1
  [ "$(lines)" = "$BEFORE" ] && has '= merge: done'
}
check 'a finished release resumes to nothing' done_ok

stub_set RELEASE_STUB_SHA="$SHA_C"
late_candidate_refused() { run 1 1.2.0 --resume && has 'release the change as a new version'; }
check 'a new candidate after publishing is refused' late_candidate_refused

status_ok() {
  run 0 1.2.0 --status || return 1
  has 'done  merge' && has 'done  server'
}
check '--status lists the stages' status_ok

# ---------------------------------------------------------------- refusals and missing interfaces

mkdir -p "$STAGING/1.0.36"
printf 'not ours\n' > "$STAGING/1.0.36/keep.txt"
foreign_ok() {
  run 1 1.0.36 --resume || return 1
  has 'was not made by release.sh' && [ "$(cat "$STAGING/1.0.36/keep.txt")" = 'not ours' ] &&
    [ "$(find "$STAGING/1.0.36" -mindepth 1 | wc -l | tr -d ' ')" = 1 ]
}
check 'a staging folder release.sh did not make is left alone' foreign_ok

N="$WORK/n"
make_machine "$N"
rm "$N/trees.noindex/test/scripts/release/test-sharded.mjs"
use_machine "$N" 1.2.1
sharded_ok() {
  run 1 1.2.1 || return 1
  has 'the server suite failed' && grep -q 'missing .*test-sharded.mjs (the sharded server runner' "$STAGE/logs/server.log" &&
    [ ! -f "$STAGE/markers/publish-private" ] && grep -q 'drop-draft' "$STUB_LOG" || return 1
  [ ! -f "$STAGE/markers/drafts" ]
}
check 'a missing test-sharded.mjs fails the release before anything is published' sharded_ok

O="$WORK/o"
make_machine "$O"
rm "$O/trees.noindex/test/scripts/studio-verify/typecheck-gate.sh"
use_machine "$O" 1.2.2
gate_ok() {
  run 1 1.2.2 || return 1
  has 'typecheck-gate.sh (the typecheck gate from the release-gates branch)' && [ ! -f "$STAGE/markers/build" ]
}
check 'a missing typecheck gate fails stage 1' gate_ok

P="$WORK/p"
make_machine "$P"
use_machine "$P" 1.2.3
chmod 644 "$P/secrets/google.env"
google_refused() { run 1 1.2.3 && has 'Google OAuth pair file is not ready'; }
check 'preflight refuses a Google pair file that is not mode 600' google_refused
chmod 600 "$P/secrets/google.env"
use_machine "$P" 2.0.0
stub_set RELEASE_STUB_PREVIOUS=1.9.0
policy_refused() { run 1 2.0.0 && has 'accept only 1.x.y'; }
check 'preflight refuses a version the updater would not accept' policy_refused

Q="$WORK/q"
make_machine "$Q"
use_machine "$Q" 1.3.0
stub_set RELEASE_STUB_PREVIOUS=1.4.0
no_previous_ok() {
  run 1 1.3.0 || return 1
  has 'could not find the release before 1.3.0' && [ ! -e "$STAGE" ] || return 1
  stub_set RELEASE_STUB_PREVIOUS=1.2.9
  run 0 1.3.0 --stop-after preflight && has 'Stopped after preflight' && [ -f "$STAGE/release.json" ]
}
check 'a failed lookup of the previous release leaves no staging folder to refuse later' no_previous_ok

R="$WORK/r"
make_machine "$R"
use_machine "$R" 1.3.1
logged() { [ -f "$STUB_LOG" ] && awk -F '\t' -v label="$1" '$2 == label { found = 1 } END { exit !found }' "$STUB_LOG"; }
stub_set RELEASE_STUB_OUTPUT=local-release-branch=Unpushed-fix
local_branch_refused() {
  run 1 1.3.1 || return 1
  has 'the local branch release/1.3.1 has commits that are not on main' && ! logged release-branch &&
    ! logged clean && [ ! -f "$STAGE/markers/bump" ]
}
check 'bump keeps a local release branch that holds commits not on main' local_branch_refused
stub_set RELEASE_STUB_OUTPUT=untracked=apps/web/src/newFix.ts
untracked_refused() {
  run 1 1.3.1 --resume || return 1
  has 'apps/web/src/newFix.ts' && has 'untracked files that the candidate stage would delete' &&
    ! logged push-candidate && [ ! -f "$STAGE/candidate.sha" ] || return 1
  stub_set RELEASE_STUB_OUTPUT=
  run 0 1.3.1 --resume --stop-after candidate && [ "$(cat "$STAGE/candidate.sha")" = "$SHA_A" ] && logged push-candidate
}
check 'a new candidate with untracked files is refused before the clean' untracked_refused

# ---------------------------------------------------------------- feeds, sums, Electron, identity

S="$WORK/s"
make_machine "$S"
use_machine "$S" 1.4.0
# A fresh public clone: no identity of its own yet.
stub_set "RELEASE_STUB_STATUS=electron-check=1" "RELEASE_STUB_OUTPUT=public-email= public-name="
stage_line() {  # stage_line STAGE LABEL: the first command logged under that label
  [ -f "$STUB_LOG" ] || return 0
  awk -F '\t' -v stage="$1" -v label="$2" '$1 == stage && $2 == label { print $3; exit }' "$STUB_LOG"
}
labels_of() {  # labels_of STAGE: every label logged in that stage, in order
  [ -f "$STUB_LOG" ] || return 0
  awk -F '\t' -v stage="$1" '$1 == stage { printf "%s ", $2 }' "$STUB_LOG"
}
prepared_ok() {
  run 0 1.4.0 --stop-after publish-private || return 1
  has "electron's runtime is missing or incomplete" || return 1
  case "$(labels_of candidate)" in *install-build*electron-reset*electron-install*) ;; *) return 1 ;; esac
  case "$(stage_line candidate electron-reset)" in */apps/desktop/node_modules/electron/dist*/path.txt) ;; *) return 1 ;; esac
  [ "$(stage_line trees public-email)" = 'git config --local user.email 979819+anton-abyzov@users.noreply.github.com' ] &&
    [ "$(stage_line trees public-name)" = 'git config --local user.name Anton Abyzov' ] || return 1
  [ "$(cat "$STAGE/prev/assets.json")" = '[]' ] &&
    stage_line prev prev-assets > /dev/null && stage_line prev prev-verify | grep -q -- "--digests $STAGE/prev/assets.json studio-update.json" || return 1
  case "$(labels_of plan)" in *sums-plan*sums-check*) ;; *) return 1 ;; esac
  stage_line plan sums-check | grep -q 'deployment-helpers-manifest.json studio-update.json$' || return 1
  [ -f "$STAGE/markers/publish-private" ] && [ ! -f "$STAGE/markers/publish-public" ]
}
check 'Electron repaired by its install.js, noreply identity set, plan in the sums before drafts' prepared_ok

# Today's main ran fleet-m4 before publish-public: a folder it left after M4 resumes with public
# next, then M1 and M3; a fleet stage never asks a host for a release the public feed lacks.
state_write_marker() { printf '%s\n' "$2" > "$STAGE/markers/$1"; }
state_write_marker fleet-m4 once
stub_set RELEASE_STUB_STATUS= RELEASE_STUB_OUTPUT=published-fleet-feed=true
BEFORE="$(lines)"
old_order_guard_ok() {
  run 1 1.4.0 --resume || return 1
  has '= fleet-m4: done' && has 'is not published on anton-abyzov/specwithcode, the feed the fleet' || return 1
  [ "$(stages_after "$BEFORE")" = "publish-public " ] && [ -f "$STAGE/markers/publish-public" ] &&
    ! awk -F '\t' -v from="$BEFORE" 'NR > from && $2 == "fleet-workers"' "$STUB_LOG" | grep -q . &&
    [ ! -f "$STAGE/markers/fleet-workers" ]
}
check 'a folder from the fleet-first order resumes public first; the fleet refuses an unpublished feed' old_order_guard_ok
stub_set RELEASE_STUB_OUTPUT=
BEFORE="$(lines)"
old_order_finish_ok() {
  run 0 1.4.0 --resume || return 1
  [ "$(stages_after "$BEFORE")" = "fleet-workers desktop merge " ] && has 'SpecWithCode 1.4.0 is released.'
}
check '... and then finishes with M1 and M3, desktop and merge' old_order_finish_ok

U="$WORK/u"
make_machine "$U"
use_machine "$U" 1.4.1
stub_set "RELEASE_STUB_STATUS=electron-check=1 electron-recheck=1"
electron_refused() {
  run 1 1.4.1 || return 1
  has "electron's dist is still missing or incomplete" && [ ! -f "$STAGE/markers/candidate" ] &&
    [ -z "$(labels_of stage1)" ]
}
check 'an Electron runtime still missing after install.js stops the candidate stage' electron_refused
stub_set RELEASE_STUB_STATUS=same-sums-private=1
draft_sums_refused() {
  run 1 1.4.1 --resume || return 1
  has 'SHA256SUMS on anton-abyzov/specwithcode is not' || return 1
  case "$(labels_of publish-private)" in *publish-private*) return 1 ;; esac
  [ ! -f "$STAGE/published.sha" ] && [ ! -f "$STAGE/markers/publish-private" ]
}
check 'a draft whose SHA256SUMS is not the built one is never published' draft_sums_refused
stub_set RELEASE_STUB_STATUS= RELEASE_STUB_FAIL=publish-private:check-sums-private
draft_plan_refused() {
  run 1 1.4.1 --resume || return 1
  case "$(labels_of publish-private)" in *publish-private*) return 1 ;; esac
  [ ! -f "$STAGE/published.sha" ]
}
check 'a draft whose SHA256SUMS leaves out the plan is never published' draft_plan_refused
stub_set RELEASE_STUB_FAIL=
stub_set RELEASE_STUB_OUTPUT=published-fleet-feed=true
m4_feed_refused() {
  run 1 1.4.1 --resume || return 1
  has 'is not published on anton-abyzov/specwithcode, the feed the fleet' && [ -f "$STAGE/markers/publish-public" ] &&
    [ -z "$(labels_of fleet-m4)" ] && [ ! -f "$STAGE/markers/fleet-m4" ]
}
check 'fleet-m4 asks M4 for nothing while the public feed lacks the release' m4_feed_refused
stub_set RELEASE_STUB_OUTPUT=

# A folder whose candidate stage ran without the Electron check (today's main) resumes at build:
# the build stage checks again and repairs the runtime before the desktop build.
W="$WORK/w"
make_machine "$W"
use_machine "$W" 1.4.3
stub_set RELEASE_STUB_STATUS=
BEFORE="$(lines)"
build_electron_ok() {
  run 0 1.4.3 --stop-after stage1 || return 1
  [ -f "$STAGE/markers/candidate" ] || return 1
  stub_set RELEASE_STUB_STATUS=electron-check=1
  run 0 1.4.3 --resume --stop-after build || return 1
  has '= candidate: done' && has "build: electron's runtime is missing or incomplete" || return 1
  case "$(labels_of build)" in *electron-reset*electron-install*build-desktop*) ;; *) return 1 ;; esac
  stub_set "RELEASE_STUB_STATUS=electron-check=1 electron-recheck=1"
  remove_marker build
  run 1 1.4.3 --resume --stop-after build || return 1
  has "electron's dist is still missing or incomplete" && [ ! -f "$STAGE/markers/build" ]
}
remove_marker() { rm -f "$STAGE/markers/$1"; }
check 'the build stage repairs a missing Electron runtime too, and stops when it stays missing' build_electron_ok
stub_set RELEASE_STUB_STATUS=

V="$WORK/v"
make_machine "$V"
use_machine "$V" 1.4.2
stub_set "RELEASE_STUB_OUTPUT=public-email=7+me@users.noreply.github.com public-name=Me"
identity_kept() {
  run 0 1.4.2 --stop-after trees || return 1
  [ -z "$(stage_line trees public-email)" ] && [ -z "$(stage_line trees public-name)" ]
}
check 'a noreply identity already in the public clone is kept' identity_kept
stub_set RELEASE_STUB_OUTPUT=public-email=me@example.com
BEFORE="$(lines)"
identity_replaced() {
  run 0 1.4.2 --resume --stop-after trees || return 1
  awk -F '\t' -v from="$BEFORE" 'NR > from && $2 == "public-email"' "$STUB_LOG" |
    grep -q 'user.email 979819+anton-abyzov@users.noreply.github.com$'
}
check 'a personal address in the public clone is replaced by the noreply one' identity_replaced
stub_set "RELEASE_STUB_OUTPUT=committer=Me<me@example.com>"
identity_env_refused() { run 1 1.4.2 --resume --stop-after trees && has "the public clone's committer is not a GitHub noreply address"; }
check 'a personal committer from the environment still stops the release' identity_env_refused
stub_set RELEASE_STUB_OUTPUT=

# ---------------------------------------------------------------- a CI Mac: no fleet files, no desktop

C="$WORK/c"
make_machine "$C"
rm -f "$C/fleet/hosts.json" "$C/fleet/id_ed25519" "$C/fleet/known_hosts"
use_machine "$C" 1.6.0
ci_refused_without_flag() { run 1 1.6.0 --stop-after preflight && has "missing $C/fleet/hosts.json"; }
check 'without --ci a machine with no fleet files stops at preflight' ci_refused_without_flag
rm -rf "$STAGE"
ci_release_ok() {
  run 0 1.6.0 --ci || return 1
  has 'SpecWithCode 1.6.0 is released.' && has 'skipped (--ci)' || return 1
  [ "$(stages_after 0)" = "prev bump candidate stage1 build bundle sign helpers plan drafts publish-private publish-public merge " ] &&
    [ ! -f "$STAGE/markers/fleet-m4" ] && [ ! -f "$STAGE/markers/desktop" ]
}
check 'a --ci release publishes both feeds and merges without fleet files' ci_release_ok

rm -rf "$STAGE"
stub_set RELEASE_STUB_OUTPUT=remote-branch=86c4653fe
ci_stale_removed() {
  run 0 1.6.0 --ci --stop-after bump || return 1
  has 'Removed release/1.6.0 left by an earlier failed --ci run' &&
    awk -F '\t' '$2 == "delete-stale"' "$STUB_LOG" | grep -q ':refs/heads/release/1.6.0$'
}
check 'a --ci rerun removes a release branch that holds only the bump' ci_stale_removed
rm -rf "$STAGE"
stub_set "RELEASE_STUB_OUTPUT=remote-branch=86c4653fe stale-commits=Hotfix"
ci_stale_work_kept() { run 1 1.6.0 --ci --stop-after bump && has 'has commits other than the bump' && ! grep -q delete-stale "$STUB_LOG"; }
check 'a --ci rerun keeps a release branch with other work' ci_stale_work_kept
rm -rf "$STAGE"
stub_set "RELEASE_STUB_OUTPUT=remote-branch=86c4653fe remote-tag=86c4653fe"
ci_stale_tagged() { run 1 1.6.0 --ci --stop-after bump && has 'v1.6.0 is already tagged'; }
check 'a --ci rerun refuses a version that is already tagged' ci_stale_tagged
stub_set RELEASE_STUB_OUTPUT=

# ---------------------------------------------------------------- timing comparison

T="$WORK/timing"
mkdir -p "$T"
printf '%s\n' '{"stage":"build","start":0,"end":200,"seconds":200,"status":"ok","sha":"x","attempt":1}' \
  '{"stage":"tiny","start":200,"end":203,"seconds":3,"status":"ok","sha":"x","attempt":1}' \
  '{"stage":"sign","start":203,"end":213,"seconds":10,"status":"failed","sha":"x","attempt":1}' \
  '{"stage":"sign","start":213,"end":313,"seconds":100,"status":"ok","sha":"x","attempt":2}' > "$T/stages.jsonl"
printf '%s\n' '{"schemaVersion":1,"version":"1.1.0","wallSeconds":250,"stages":[' \
  '{"stage":"build","seconds":100,"status":"ok","attempts":1,"totalSeconds":100},' \
  '{"stage":"tiny","seconds":2,"status":"ok","attempts":1,"totalSeconds":2},' \
  '{"stage":"sign","seconds":95,"status":"ok","attempts":1,"totalSeconds":95}]}' > "$T/previous.json"
timing_ok() {
  python3 -B "$TOOLS" timing summary --file "$T/stages.jsonl" --out "$T/stages.json" --version 1.2.0 || return 1
  python3 -B "$TOOLS" timing compare --current "$T/stages.json" --previous "$T/previous.json" > "$LAST_OUT" || return 1
  grep -E '^build +200 +100 +\+100% +SLOWER' "$LAST_OUT" > /dev/null &&
    grep -E '^tiny +3 +2 ' "$LAST_OUT" | grep -qv SLOWER &&
    grep -E '^sign +100 +95 ' "$LAST_OUT" | grep -q '2 attempts, 110s in all' &&
    has 'Slower than the previous release by more than 25%: build' &&
    [ "$(python3 -B "$TOOLS" timing attempts --file "$T/stages.jsonl" --stage sign)" = 3 ]
}
check 'timing compare flags a stage over 25% and 10s slower, not a small one' timing_ok

tools_ok() { python3 -B "$HERE/test-release-tools.py" > "$LAST_OUT" 2>&1; }
check 'release_tools.py unit tests' tools_ok

check 'the repository is unchanged' test "$(repo_state)" = "$REPO_STATE_BEFORE"

FINISHED=1
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
