#!/bin/bash
# One-command SpecWithCode release: bump, test, build, sign, publish and roll out, in resumable stages.
#
#   bash scripts/release/release.sh <version> [--resume] [--dry-run] [--stop-after STAGE]
#                                   [--previous X.Y.Z] [--no-project-migrations] [--jobs N] [--ci]
#                                   [--no-retry]
#   bash scripts/release/release.sh <version> --status
#   bash scripts/release/release.sh --self-test
#
# Stages, in order (docs/studio/releasing.md has the runbook):
#   preflight trees prev bump candidate stage1 [server starts here, in the background]
#   build bundle sign helpers plan drafts server-wait
#   quit-desktop publish-private publish-public fleet-m4 desktop fleet-workers merge
#
# publish-public comes before the fleet stages: the hosts' update agents read the public feed
# (update_agent.DEFAULT_REPOSITORY), so a release only on the private one is invisible to them.
# The desktop app is swapped right after M4 installs: a new app opened against an older M4
# service writes its own normal-mode install request over fleet-m4's forced one, and M1 or M3
# failing must not leave the Mac without its app.
# Stage names never change, so a staging folder from an earlier order resumes at the first stage
# it has no marker for.
#
# State lives in ~/.specwithcode/release-staging/<version>/: a marker per finished stage (holding
# the candidate commit it passed for), logs/<stage>.log (appended, one header per run) and
# timings/stages.json, compared with the previous release's at the end. A run that stops resumes
# with --resume at the first stage not done for the current candidate. A fix is a commit in the
# build tree; on --resume it becomes the new candidate: stage 1 and the signed build run again in
# full, the server suite only for files changed since its last green commit (vitest --changed).
#
# A flaky test does not stop the run: in stage 1, when one or two jobs of the whole stage fail,
# each runs once more, alone, on the same candidate (first tries kept in try-1/); in the server
# suite, up to five failed files run once more as one shard (retry-1/). A second failure fails the
# stage. Every retry is in timings/retries.jsonl and the timing table (FLAKY, and REPEAT FLAKE when
# the previous release had the same one). Nothing else is retried.
#
# --dry-run     print every stage and command; run nothing and write nothing
# --resume      continue the release whose state is in the staging folder
# --stop-after  stop once that stage is done (for example drafts, before anything is published)
# --status      print the stage markers and timings; changes no release state
# --no-retry    fail a stage on its first failure (to reproduce a flaky test)
# --self-test   exercise this script with stubbed commands in a temporary folder
# --no-project-migrations  write the update plan without update.py's --allow-project-migrations,
#               for its stricter whole-database check; only when no host upgrades across a
#               migration. Give it on the run that reaches the plan stage.
# --ci          a release on a CI Mac (.github/workflows/release-macos.yml): no fleet SSH files are
#               needed and quit-desktop, fleet-m4, fleet-workers and desktop are skipped. Each host's
#               update agent installs the release from the public feed on its next hourly check;
#               `fleet_rollout.py --version X.Y.Z` on the M4 asks them at once.
#
# Environment: RELEASE_ENV (default ~/.config/skill-studio-release/release.env, see
# release.env.example), RELEASE_STAGING_ROOT, RELEASE_TREES (persistent trees, default
# ~/Projects/github/release.noindex), RELEASE_PRIVATE_REPO, RELEASE_PUBLIC_REPO, RELEASE_JOBS,
# RELEASE_NODE_BIN (the Node $NODE_VERSION bin folder, default nvm's), RELEASE_SERVER_SHARDS
# (default 4), RELEASE_RETRY_MAX_JOBS (2), RELEASE_RETRY_MAX_FILES (5).
# RELEASE_STUB=1 (with RELEASE_STAGING_ROOT and RELEASE_TREES) records commands instead of
# running them; only the self-test uses it.
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HERE="$(dirname "$SELF")"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TOOLS="$HERE/release_tools.py"

PRIVATE_REPO="${RELEASE_PRIVATE_REPO:-anton-abyzov/specwithcode}"
PUBLIC_REPO="${RELEASE_PUBLIC_REPO:-anton-abyzov/specwithcode}"
PRIVATE_URL="https://github.com/$PRIVATE_REPO.git"
RELEASE_ENV="${RELEASE_ENV:-$HOME/.config/skill-studio-release/release.env}"
STAGING_ROOT="${RELEASE_STAGING_ROOT:-$HOME/.specwithcode/release-staging}"
TREES="${RELEASE_TREES:-$HOME/Projects/github/release.noindex}"
APP="${RELEASE_DESKTOP_APP:-/Applications/SpecWithCode.app}"
STAGE_NAMES="preflight trees prev bump candidate stage1 build bundle sign helpers plan drafts server-wait quit-desktop publish-private publish-public fleet-m4 desktop fleet-workers merge"
VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
POLICY_RE='^1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
STUB_SHA_DEFAULT=1111111111111111111111111111111111111111
# Run first in stage 1: a contrast offender fails in seconds, not after the web suite.
CONTRAST_TESTS="src/themeContrastClasses.test.ts src/appearanceContrast.test.ts"
# The release's GitHub token (GH_TOKEN; RELEASE_GH_TOKEN in CI) can write to both repositories.
# Dependency installs and test suites never need it, so they run with every GitHub token unset.
# Defence in depth only: this script and the build stage still hold it, a same-user process can
# read it from them, and where gh is signed in `gh auth token` still prints it.
NO_GH_TOKEN=(env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN)

VERSION="" MODE=real RESUME=0 SELF_TEST=0 STATUS=0 INTERNAL_SERVER=0 PREV_OVERRIDE="" MIGRATIONS=1 CI_MODE=0
STOP_AFTER="" JOBS="${RELEASE_JOBS:-4}" SHA="" SHA12="" PREV="" CURRENT_STAGE=main LOCKED=0 STATE_READY=0
RETRY=1 RETRY_MAX_JOBS="${RELEASE_RETRY_MAX_JOBS:-2}" RETRY_MAX_FILES="${RELEASE_RETRY_MAX_FILES:-5}"
SERVER_SHARDS="${RELEASE_SERVER_SHARDS:-4}" STAGE_ATTEMPT=1 RETRIED_JOBS=0
POLL=1

say() { printf '%s\n' "$*"; }
die() {
  printf 'release.sh: %s\n' "$*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"; }
usage_error() {
  printf 'release.sh: %s (see --help)\n' "$*" >&2
  exit 2
}

# ---------------------------------------------------------------- running commands

# command_word HELPER LABEL CMD...: refuse a call whose command is missing or looks like an option.
# `x sums --python3 ...` (a lost space after the -- separator) ran "--python3" as the command and
# failed the 1.0.44 release after signing; dry and stub runs record calls without running them, so
# this check is the one that makes --dry-run and --self-test catch it.
command_word() {
  local helper="$1" label="$2"
  shift 2
  case "${1:-}" in
    "" | -*) die "$helper $label: \"${1:-}\" is not a command; write: $helper $label [-C DIR] -- CMD..." ;;
  esac
}

# x LABEL [-C DIR] [--] CMD...: run CMD. Stub mode records it; dry-run prints it.
x() {
  local label="$1" dir="" item
  shift
  if [ "${1:-}" = "-C" ]; then
    dir="$2"
    shift 2
  fi
  if [ "${1:-}" = "--" ]; then shift; fi
  command_word x "$label" "$@"
  case "$MODE" in
    dry)
      printf '    %s: %s%s\n' "$label" "${dir:+(in $dir) }" "$*"
      return 0
      ;;
    stub)
      printf '%s\t%s\t%s\n' "$CURRENT_STAGE" "$label" "$*" >> "$STUB_LOG"
      # RELEASE_STUB_FAIL_ONCE="STAGE:LABEL..." fails only the first run of each of those calls in
      # a staging folder.
      for item in ${RELEASE_STUB_FAIL_ONCE:-}; do
        if [ "$item" = "$CURRENT_STAGE:$label" ] && ! grep -qxF -- "$item" "$STUB_LOG.failed-once" 2> /dev/null; then
          printf '%s\n' "$item" >> "$STUB_LOG.failed-once"
          printf '%s\t%s\tFAILED (stub)\n' "$CURRENT_STAGE" "$label" >> "$STUB_LOG"
          return 1
        fi
      done
      if [ "${RELEASE_STUB_FAIL:-}" = "$CURRENT_STAGE" ] || [ "${RELEASE_STUB_FAIL:-}" = "$CURRENT_STAGE:$label" ]; then
        printf '%s\t%s\tFAILED (stub)\n' "$CURRENT_STAGE" "$label" >> "$STUB_LOG"
        return 1
      fi
      return 0
      ;;
  esac
  printf '+ %s: %s\n' "$label" "$*"
  if [ -n "$dir" ]; then (cd "$dir" && "$@"); else "$@"; fi
}

# Stand-in answers for q and t when nothing really runs. The self-test sets one-word answers in
# RELEASE_STUB_OUTPUT as KEY=VALUE pairs.
stub_value() {
  local item
  if [ "$MODE" = stub ]; then
    for item in ${RELEASE_STUB_OUTPUT:-}; do
      if [ "${item%%=*}" = "$1" ]; then
        printf '%s\n' "${item#*=}"
        return 0
      fi
    done
  fi
  case "$1" in
    sha) printf '%s\n' "${RELEASE_STUB_SHA:-$STUB_SHA_DEFAULT}" ;;
    node-version) printf 'v%s\n' "${NODE_VERSION:-22.20.0}" ;;
    pnpm-version) printf '%s\n' "$(expected_pnpm)" ;;
    loadavg) printf '{ 1.00 1.00 1.00 }\n' ;;
    ncpu) printf '16\n' ;;
    releases) printf '[{"tagName":"v%s","isDraft":false}]\n' "${RELEASE_STUB_PREVIOUS:-1.99.0}" ;;
    prev-assets) printf '[]\n' ;;
    committer | author) printf 'Release <1+release@users.noreply.github.com> 0 +0000\n' ;;
    public-email) printf '1+release@users.noreply.github.com\n' ;;
    public-name) printf 'Release\n' ;;
    release-flags) printf -- '--latest --prerelease=false\n' ;;
    published-*) printf 'false\n' ;;
    draft-state) printf 'true\n' ;;
    tag-sha) printf '%s\n' "$SHA" ;;
    app-version) printf '%s\n' "$VERSION" ;;
    pr-required-buckets) printf 'skipping\n' ;;
    pinned-objects) printf '%s\n' "$LAZY_FETCH_PROBE" ;;
    packages) printf 'apps/web\t@specweave-studio/web\npackages/shared\t@specweave-studio/shared\n' ;;
    *) printf '' ;;
  esac
}

# q KEY [-C DIR] [--may-fail] -- CMD...: CMD's output. --may-fail gives "" when CMD fails.
q() {
  local key="$1" dir="" may_fail=0 out rc
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      -C) dir="$2"; shift 2 ;;
      --may-fail) may_fail=1; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  command_word q "$key" "$@"
  if [ "$MODE" != real ]; then
    stub_value "$key"
    return 0
  fi
  set +e
  if [ $may_fail -eq 1 ]; then
    if [ -n "$dir" ]; then out=$(cd "$dir" && "$@" 2> /dev/null); else out=$("$@" 2> /dev/null); fi
  else
    if [ -n "$dir" ]; then out=$(cd "$dir" && "$@"); else out=$("$@"); fi
  fi
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    [ $may_fail -eq 1 ] && return 0
    die "$key: '$*' exited $rc"
  fi
  printf '%s\n' "$out"
}

# t KEY [-C DIR] -- CMD...: CMD's exit status (stub and dry-run: 0, or KEY=N in RELEASE_STUB_STATUS).
t() {
  local key="$1" dir="" item
  shift
  if [ "${1:-}" = "-C" ]; then
    dir="$2"
    shift 2
  fi
  if [ "${1:-}" = "--" ]; then shift; fi
  command_word t "$key" "$@"
  if [ "$MODE" != real ]; then
    for item in ${RELEASE_STUB_STATUS:-}; do
      if [ "${item%%=*}" = "$key" ]; then return "${item#*=}"; fi
    done
    return 0
  fi
  if [ -n "$dir" ]; then (cd "$dir" && "$@"); else "$@"; fi
}

# A check that stops a real or stubbed run and is only reported by a dry-run.
check_fail() {
  if [ "$MODE" = dry ]; then
    say "    would stop: $*"
    return 0
  fi
  die "$*"
}

need_file() {
  if [ "$MODE" = dry ] || [ -e "$1" ]; then return 0; fi
  die "missing $1 ($2)"
}

# An earlier stage's output: only a real run has it.
need_output() {
  if [ "$MODE" != real ]; then return 0; fi
  need_file "$@"
}

# rm -rf, only for paths inside this release's staging folder.
remove_owned() {
  local path
  for path in "$@"; do
    case "$path" in
      "$STAGE"/?*) ;;
      *) die "refusing to remove $path outside $STAGE" ;;
    esac
    if [ "$MODE" = dry ]; then continue; fi
    rm -rf "$path"
  done
}

ensure_dir() {
  if [ "$MODE" = dry ]; then return 0; fi
  mkdir -p "$@"
}

state_write() {  # state_write FILE TEXT
  if [ "$MODE" = dry ]; then return 0; fi
  printf '%s\n' "$2" > "$1.tmp.$$"
  mv "$1.tmp.$$" "$1"
}

expected_pnpm() {
  sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$REPO_ROOT/package.json"
}

# ---------------------------------------------------------------- stage bookkeeping

is_done() {  # is_done STAGE KEY
  [ -f "$MARKERS/$1" ] && [ "$(cat "$MARKERS/$1")" = "$2" ]
}

mark_done() {
  ensure_dir "$MARKERS"
  state_write "$MARKERS/$1" "$2"
}

record_timing() {  # record_timing STAGE START END STATUS ATTEMPT
  if [ "$MODE" = dry ]; then return 0; fi
  python3 -B "$TOOLS" timing record --file "$TIMINGS/stages.jsonl" --stage "$1" --start "$2" --end "$3" \
    --status "$4" --sha "${SHA12:-}" --attempt "$5"
}

attempt_of() {
  python3 -B "$TOOLS" timing attempts --file "$TIMINGS/stages.jsonl" --stage "$1"
}

# record_retry STAGE JOB FIRST_SECS RETRY_SECS passed|failed LOG [DETAIL]: one line in
# retries.jsonl, apart from stages.jsonl, whose lines count a stage's attempts.
record_retry() {
  if [ "$MODE" = dry ]; then return 0; fi
  python3 -B "$TOOLS" timing retry --file "$TIMINGS/retries.jsonl" --stage "$1" --job "$2" --first "${3:-0}" \
    --retry "${4:-0}" --result "$5" --log "$6" --detail "${7:-}" --sha "${SHA12:-}" --attempt "$STAGE_ATTEMPT"
}

stop_check() {
  if [ -n "$STOP_AFTER" ] && [ "$1" = "$STOP_AFTER" ]; then
    say "Stopped after $1 as asked; continue with: bash scripts/release/release.sh $VERSION --resume"
    print_timings
    exit 0
  fi
}

# run_stage NAME SCOPE: SCOPE is sha (done once per candidate), once (once per release) or always.
run_stage() {
  local name="$1" scope="$2" key="" fn started rc attempt log status
  case "$scope" in
    sha) key="$SHA" ;;
    once) key=once ;;
  esac
  if [ -n "$key" ] && is_done "$name" "$key"; then
    say "= $name: done"
    stop_check "$name"
    return 0
  fi
  fn="stage_$(printf '%s' "$name" | tr - _)"
  CURRENT_STAGE="$name"
  say "> $name"
  if [ "$MODE" = dry ]; then
    "$fn"
    stop_check "$name"
    return 0
  fi
  log="$LOG_DIR/$name.log"
  attempt="$(attempt_of "$name")"
  STAGE_ATTEMPT="$attempt"
  printf '\n===== %s %s attempt %s %s =====\n' "$(date -u +%FT%TZ)" "$name" "$attempt" "$SHA12" >> "$log"
  started=$(date +%s)
  set +e
  (
    set -e
    "$fn"
  ) 2>&1 | tee -a "$log" "$LOG_DIR/release.log"
  rc=${PIPESTATUS[0]}
  set -e
  status=ok
  if [ "$rc" -ne 0 ]; then status=failed; fi
  record_timing "$name" "$started" "$(date +%s)" "$status" "$attempt"
  CURRENT_STAGE=main
  if [ "$rc" -ne 0 ]; then
    die "stage $name failed (exit $rc); log: $log"
  fi
  if [ -n "$key" ]; then mark_done "$name" "$key"; fi
  stop_check "$name"
  return 0
}

print_timings() {
  if [ "$MODE" = dry ] || [ ! -f "$TIMINGS/stages.jsonl" ]; then return 0; fi
  python3 -B "$TOOLS" timing summary --file "$TIMINGS/stages.jsonl" --out "$TIMINGS/stages.json" --version "$VERSION" \
    --retries "$TIMINGS/retries.jsonl"
  python3 -B "$TOOLS" timing compare --current "$TIMINGS/stages.json" \
    --previous "$STAGING_ROOT/${PREV:-none}/timings/stages.json"
}

on_exit() {
  local rc=$?
  if [ "$LOCKED" -eq 1 ]; then rm -rf "$STAGE/lock"; fi
  if [ "$rc" -ne 0 ] && [ "$STATE_READY" -eq 1 ] && [ "$MODE" != dry ]; then
    if ! print_timings; then say "(timings unavailable)"; fi
    say "Fix the cause (commit fixes in $BUILD), then: bash scripts/release/release.sh $VERSION --resume"
  fi
  exit "$rc"
}

# ---------------------------------------------------------------- environment

load_env() {
  if [ -f "$RELEASE_ENV" ]; then
    # shellcheck source=/dev/null
    . "$RELEASE_ENV"
  elif [ "$MODE" != dry ] && [ "$STATUS" -eq 0 ]; then
    die "missing $RELEASE_ENV: copy scripts/release/release.env.example there (mode 600) and fill in its paths and ids"
  fi
  NODE_VERSION="${NODE_VERSION:-22.20.0}"
  PUBLIC_CLONE="${PUBLIC_CLONE:-$TREES/public}"
  # The public clone's own commit identity (its .git/config, not the global one): the owner's
  # GitHub noreply address, so a public snapshot or tag never carries a personal address.
  PUBLIC_GIT_NAME="${PUBLIC_GIT_NAME:-Anton Abyzov}"
  PUBLIC_GIT_EMAIL="${PUBLIC_GIT_EMAIL:-979819+anton-abyzov@users.noreply.github.com}"
  PUBLIC_RULES="${STUDIO_PUBLIC_RULES:-$HOME/.local/share/specweave/specwithcode-public/rules.json}"
  FLEET_HOSTS="${STUDIO_FLEET_HOSTS:-$HOME/.local/share/specweave/fleet/hosts.json}"
  BUILD="$TREES/build"
  TEST="$TREES/test"
  # publish.mjs and fleet_hosts read these from the environment.
  STUDIO_PUBLIC_RULES="$PUBLIC_RULES" STUDIO_FLEET_HOSTS="$FLEET_HOSTS"
  export STUDIO_PUBLIC_RULES STUDIO_FLEET_HOSTS
  # Toolchain: no anaconda Python or Node on PATH, nvm's pinned Node 22 first.
  local entry clean="" old_ifs="$IFS"
  set -f
  IFS=:
  for entry in $PATH; do
    case "$entry" in *anaconda3* | *miniconda* | "") continue ;; esac
    clean="${clean:+$clean:}$entry"
  done
  IFS="$old_ifs"
  set +f
  NODE_BIN="${RELEASE_NODE_BIN:-${NVM_DIR:-$HOME/.nvm}/versions/node/v$NODE_VERSION/bin}"
  PATH="$NODE_BIN:$clean"
  export PATH
  if [ -n "${SDKROOT:-}" ]; then export SDKROOT; fi
}

set_paths() {
  STAGE="$STAGING_ROOT/$VERSION"
  MARKERS="$STAGE/markers"
  LOG_DIR="$STAGE/logs"
  TIMINGS="$STAGE/timings"
  STUB_LOG="$STAGE/stub.log"
}

# The staging folder is this release's: refuse one this script did not make, or a second run.
init_state() {
  if [ "$MODE" = dry ]; then
    if [ -d "$STAGE" ]; then say "dry-run: $STAGE exists; a real run would need --resume"; fi
    PREV="${PREV_OVERRIDE:-<previous>}"
    return 0
  fi
  if [ -d "$STAGE" ] && [ ! -f "$STAGE/release.json" ]; then
    die "$STAGE exists but was not made by release.sh; refusing to touch it"
  fi
  if [ -f "$STAGE/release.json" ] && [ "$RESUME" -eq 0 ]; then
    die "a release of $VERSION is under way in $STAGE; continue it with --resume"
  fi
  if [ ! -f "$STAGE/release.json" ] && [ "$RESUME" -eq 1 ]; then
    die "nothing to resume: $STAGE/release.json is missing"
  fi
  # Found before the folder exists: a failed lookup must not leave a folder without release.json,
  # which every later run would refuse as not made by release.sh.
  if [ ! -f "$STAGE/release.json" ]; then resolve_previous; fi
  mkdir -p "$STAGE" "$MARKERS" "$LOG_DIR" "$TIMINGS"
  chmod 700 "$STAGE"
  if ! mkdir "$STAGE/lock" 2> /dev/null; then
    local holder
    holder="$(cat "$STAGE/lock/pid" 2> /dev/null)"
    if [ -n "$holder" ] && kill -0 "$holder" 2> /dev/null; then die "release.sh $VERSION already runs (pid $holder)"; fi
    rm -rf "$STAGE/lock"
    mkdir "$STAGE/lock"
  fi
  LOCKED=1
  printf '%s\n' "$$" > "$STAGE/lock/pid"
  if [ ! -f "$STAGE/release.json" ]; then
    python3 -B "$TOOLS" json-set "$STAGE/release.json" "version=$VERSION" "previous=$PREV" \
      "privateRepo=$PRIVATE_REPO" "publicRepo=$PUBLIC_REPO" "startedAt=$(date -u +%FT%TZ)"
  fi
  PREV="$(python3 -B "$TOOLS" json-get "$STAGE/release.json" previous)" ||
    die "$STAGE/release.json names no previous release"
  STATE_READY=1
}

resolve_previous() {
  if [ -n "$PREV_OVERRIDE" ]; then
    PREV="$PREV_OVERRIDE"
    return 0
  fi
  PREV="$(q releases -- gh release list -R "$PRIVATE_REPO" --limit 40 --json tagName,isDraft |
    python3 -B "$TOOLS" previous --version "$VERSION")" || PREV=""
  [ -n "$PREV" ] || die "could not find the release before $VERSION on $PRIVATE_REPO; pass --previous"
}

# The candidate is the build tree's HEAD on release/<version>; a new one is pushed and replaces
# every per-candidate stage. Once v<version> is published the candidate is fixed.
resolve_candidate() {
  CURRENT_STAGE=candidate
  SHA="$(q sha -C "$BUILD" -- git rev-parse HEAD)"
  [ "$MODE" = dry ] && SHA="<candidate>"
  SHA12="$(printf '%s' "$SHA" | cut -c1-12)"
  ASSETS="$STAGE/assets-$SHA12"
  if [ "$MODE" = dry ]; then return 0; fi
  [ -z "$(q dirty -C "$BUILD" -- git status --porcelain --untracked-files=no)" ] ||
    die "$BUILD has uncommitted changes; commit the fix (it becomes the candidate) or discard it"
  local published="" previous="" untracked
  [ -f "$STAGE/published.sha" ] && published="$(cat "$STAGE/published.sha")"
  if [ -n "$published" ] && [ "$published" != "$SHA" ]; then
    die "v$VERSION is published at $published but $BUILD is at $SHA; release the change as a new version"
  fi
  [ -f "$STAGE/candidate.sha" ] && previous="$(cat "$STAGE/candidate.sha")"
  if [ "$previous" != "$SHA" ]; then
    if [ -n "$previous" ]; then say "New candidate $SHA12 (was $(printf '%s' "$previous" | cut -c1-12))"; fi
    # The candidate stage runs git clean in the build tree: a new file left out of the fix commit
    # would be deleted, so stop while it is still there.
    untracked="$(q untracked -C "$BUILD" -- git ls-files --others --exclude-standard)"
    if [ -n "$untracked" ]; then
      head -n 5 >&2 << EOF
$untracked
EOF
      die "$BUILD has untracked files that the candidate stage would delete; commit them with the fix or remove them"
    fi
    x push-candidate -C "$BUILD" -- git push -q "$PRIVATE_URL" "HEAD:refs/heads/release/$VERSION"
    stop_stale_server
    state_write "$STAGE/candidate.sha" "$SHA"
  fi
  CURRENT_STAGE=main
}

# ---------------------------------------------------------------- stages: prepare

stage_preflight() {
  local var load ncpu pnpm expected
  [[ $VERSION =~ $POLICY_RE ]] ||
    check_fail "the installer and updater accept only 1.x.y (version.mjs, release_policy.py); $VERSION would be refused"
  if [ "$MODE" != dry ] && ! python3 -B "$TOOLS" newer "$VERSION" "$PREV"; then
    check_fail "$VERSION is not above the previous release $PREV"
  fi
  [ -f "$RELEASE_ENV" ] || check_fail "missing $RELEASE_ENV (copy scripts/release/release.env.example, mode 600)"
  for var in CSC_LINK_PATH CSC_PASSPHRASE_FILE APPLE_API_KEY_PATH APPLE_API_KEY_ID APPLE_API_ISSUER \
    GOOGLE_OAUTH_ENV_FILE SDKROOT; do
    [ -n "${!var:-}" ] || check_fail "$var is not set in $RELEASE_ENV"
  done
  if [ -n "${GOOGLE_OAUTH_ENV_FILE:-}" ] && [ ! -e "$GOOGLE_OAUTH_ENV_FILE" ] && [ -n "${GOOGLE_OAUTH_SOURCE_ENV:-}" ]; then
    # Only the two Google OAuth lines are copied, into a new mode-600 file outside the repo.
    x google-pair -- python3 -B "$TOOLS" google-env copy "$GOOGLE_OAUTH_SOURCE_ENV" "$GOOGLE_OAUTH_ENV_FILE"
  fi
  if [ "$MODE" != dry ] && ! python3 -B "$TOOLS" google-env check "${GOOGLE_OAUTH_ENV_FILE:-/nonexistent}"; then
    check_fail "the Google OAuth pair file is not ready (set GOOGLE_OAUTH_SOURCE_ENV once to copy it)"
  fi
  for var in CSC_LINK_PATH CSC_PASSPHRASE_FILE APPLE_API_KEY_PATH; do
    [ -s "${!var:-/nonexistent}" ] || check_fail "$var does not name a non-empty file"
  done
  for var in "$RELEASE_ENV" "${CSC_PASSPHRASE_FILE:-}"; do
    if [ -f "$var" ] && [ "$(stat -f %Lp "$var")" != 600 ]; then check_fail "$var must be mode 600"; fi
  done
  [ -d "${SDKROOT:-/nonexistent}" ] || check_fail "SDKROOT ${SDKROOT:-} is not a folder"
  [ -d "$NODE_BIN" ] || check_fail "Node $NODE_VERSION is not installed at $NODE_BIN (nvm install $NODE_VERSION)"
  [ "$(q node-version -- node -v)" = "v$NODE_VERSION" ] || check_fail "node on PATH is not v$NODE_VERSION"
  expected="$(expected_pnpm)"
  pnpm="$(q pnpm-version -- pnpm -v)"
  [ "$pnpm" = "$expected" ] || check_fail "pnpm is $pnpm; package.json wants $expected"
  for var in gh git python3 ditto codesign; do
    t "cmd-$var" -- command -v "$var" > /dev/null || check_fail "$var is not on PATH"
  done
  t gh-auth -- gh auth status > /dev/null 2>&1 || check_fail "gh is not signed in (gh auth login)"
  [ -e "$PUBLIC_RULES" ] || check_fail "missing $PUBLIC_RULES"
  if [ "$CI_MODE" -eq 0 ]; then
    for var in "$FLEET_HOSTS" "$(dirname "$FLEET_HOSTS")/id_ed25519" "$(dirname "$FLEET_HOSTS")/known_hosts"; do
      [ -e "$var" ] || check_fail "missing $var"
    done
  fi
  load="$(q loadavg -- sysctl -n vm.loadavg | awk '{print $3}')"
  ncpu="$(q ncpu -- sysctl -n hw.ncpu)"
  if awk -v load="$load" -v n="$ncpu" 'BEGIN { exit !(load > 2 * n) }'; then
    say "WARNING: 5-minute load is $load on $ncpu cores. Suites run slower and short timeouts flake;"
    say "         close idle worktrees and dev servers, or wait for the load to drop."
  fi
  say "preflight: $VERSION after ${PREV}, node v$NODE_VERSION, pnpm $pnpm, SDKROOT ${SDKROOT:-unset}"
}

ensure_tree() {  # ensure_tree DIR: a worktree of this repository, detached
  local dir="$1"
  if [ -e "$dir/.git" ]; then
    t "tree-$(basename "$dir")" -C "$dir" -- git rev-parse --is-inside-work-tree > /dev/null ||
      die "$dir is not a git work tree; move it aside"
    return 0
  fi
  x "worktree-$(basename "$dir")" -C "$REPO_ROOT" -- git worktree add --detach "$dir" HEAD
}

stage_trees() {
  case "$TREES" in *.noindex) ;; *) say "WARNING: $TREES is not a .noindex folder; Spotlight will index its node_modules" ;; esac
  ensure_dir "$TREES"
  ensure_tree "$BUILD"
  ensure_tree "$TEST"
  if [ ! -e "$PUBLIC_CLONE/.git" ]; then
    x clone-public -- git clone -q "https://github.com/$PUBLIC_REPO.git" "$PUBLIC_CLONE"
  fi
  public_identity
}

# publish.mjs commits and tags in the public clone and refuses an author or committer that is not
# a GitHub noreply address. A Mac without a global git identity has none, and a global one may be
# personal, so the clone gets its own: a local noreply address stays, anything else is replaced.
public_identity() {
  local email name ident upper
  case "$PUBLIC_GIT_EMAIL" in
    ?*@users.noreply.github.com) ;;
    *) check_fail "PUBLIC_GIT_EMAIL ($PUBLIC_GIT_EMAIL) is not a GitHub noreply address" ;;
  esac
  if [ "$MODE" = dry ]; then
    say "    public-identity: (in $PUBLIC_CLONE) git config --local user.email $PUBLIC_GIT_EMAIL and user.name, unless it has a noreply one"
    return 0
  fi
  email="$(q public-email -C "$PUBLIC_CLONE" --may-fail -- git config --local --get user.email)"
  name="$(q public-name -C "$PUBLIC_CLONE" --may-fail -- git config --local --get user.name)"
  case "$email" in
    ?*@users.noreply.github.com) ;;
    *) x public-email -C "$PUBLIC_CLONE" -- git config --local user.email "$PUBLIC_GIT_EMAIL" ;;
  esac
  if [ -z "$name" ]; then x public-name -C "$PUBLIC_CLONE" -- git config --local user.name "$PUBLIC_GIT_NAME"; fi
  # GIT_AUTHOR_EMAIL or GIT_COMMITTER_EMAIL in the environment still wins over any config.
  for ident in committer author; do
    upper="$(printf '%s' "$ident" | tr '[:lower:]' '[:upper:]')"
    case "$(q "$ident" -C "$PUBLIC_CLONE" -- git var "GIT_${upper}_IDENT")" in
      *"@users.noreply.github.com>"*) ;;
      *) check_fail "the public clone's $ident is not a GitHub noreply address; unset GIT_${upper}_EMAIL or set user.email in $PUBLIC_CLONE" ;;
    esac
  done
}

stage_prev() {
  local listing
  ensure_dir "$STAGE/prev"
  x prev-download -- gh release download "v$PREV" -R "$PRIVATE_REPO" -p studio-update.json \
    -p deployment-helpers-manifest.json -p SHA256SUMS -D "$STAGE/prev" --clobber
  # GitHub's own sha256 of each asset. 1.0.38 shipped a SHA256SUMS without studio-update.json:
  # a file the sums leave out is used only when it matches this digest, and refused otherwise.
  listing="$(q prev-assets -- gh api "repos/$PRIVATE_REPO/releases/tags/v$PREV" --jq '[.assets[] | {name, digest}]')"
  state_write "$STAGE/prev/assets.json" "$listing"
  x prev-verify -- python3 -B "$TOOLS" verify-sums --dir "$STAGE/prev" --digests "$STAGE/prev/assets.json" \
    studio-update.json deployment-helpers-manifest.json
}

# A hosted --ci run starts from an empty staging folder and cannot resume, so a failed one leaves
# release/<version> holding only the bump; remove it so the rerun bumps the current main. Any other
# commit on it, or a v<version> tag, still stops the release.
discard_failed_ci_branch() {
  [ -z "$(q remote-tag -- git ls-remote "$PRIVATE_URL" "refs/tags/v$VERSION")" ] ||
    die "v$VERSION is already tagged on $PRIVATE_REPO; release the change as a new version"
  x fetch-stale -C "$BUILD" -- git fetch -q "$PRIVATE_URL" "+refs/heads/main:refs/release-ci/main" \
    "+refs/heads/release/$VERSION:refs/release-ci/stale"
  local subjects subject
  subjects="$(q stale-commits -C "$BUILD" -- git log --format=%s refs/release-ci/main..refs/release-ci/stale --)"
  while IFS= read -r subject; do
    case "$subject" in
      "" | "Prepare SpecWithCode $VERSION release") ;;
      *) die "release/$VERSION on $PRIVATE_REPO has commits other than the bump; merge or remove them first" ;;
    esac
  done << EOF
$subjects
EOF
  x delete-stale -C "$BUILD" -- git push -q "$PRIVATE_URL" ":refs/heads/release/$VERSION"
  say "Removed release/$VERSION left by an earlier failed --ci run (it held only the bump)"
}

stage_bump() {
  if [ -n "$(q remote-branch -- git ls-remote "$PRIVATE_URL" "refs/heads/release/$VERSION")" ]; then
    [ "$CI_MODE" -eq 1 ] || die "release/$VERSION already exists on $PRIVATE_REPO; resume that release or remove the branch"
    discard_failed_ci_branch
  fi
  x fetch-main -C "$BUILD" -- git fetch -q "$PRIVATE_URL" main
  main_gate_green
  # -B resets a local release/<version>; refuse when it holds work other than this script's bump.
  local extra subject
  extra="$(q local-release-branch -C "$BUILD" --may-fail -- git log --format=%s "FETCH_HEAD..refs/heads/release/$VERSION" --)"
  while IFS= read -r subject; do
    case "$subject" in
      "" | "Prepare SpecWithCode $VERSION release") ;;
      *) die "the local branch release/$VERSION has commits that are not on main; push them or delete the branch first" ;;
    esac
  done << EOF
$extra
EOF
  x release-branch -C "$BUILD" -- git checkout -q -B "release/$VERSION" FETCH_HEAD
  x clean -C "$BUILD" -- git clean -fdxq -e node_modules
  x install -C "$BUILD" -- "${NO_GH_TOKEN[@]}" pnpm install --frozen-lockfile
  x bump -C "$BUILD" -- node scripts/update-release-package-versions.ts "$VERSION"
  if ! t bump-unchanged -C "$BUILD" -- git diff --quiet; then
    x commit -C "$BUILD" -- git commit -qam "Prepare SpecWithCode $VERSION release"
  fi
}

# main requires the PR gate checks, but an admin can merge past them (enforce_admins is off), and
# 1.0.44 failed three times in stage 1 on tests that a red or unfinished gate had let onto main.
# Stop before the bump when the pull request that made main's head merged with a failed or still
# running required check. The release/ pull request of an earlier release skips the gates, and a
# head with no merged pull request (a direct push) is left to stage 1.
main_gate_green() {
  local head pr number buckets
  head="$(q main-sha -C "$BUILD" -- git rev-parse FETCH_HEAD)"
  pr="$(q main-pr --may-fail -- gh api "repos/$PRIVATE_REPO/commits/$head/pulls" \
    -q '[.[] | select(.merged_at != null)][0] | "\(.number):\(.head.ref)"')"
  number="${pr%%:*}"
  case "$pr" in
    "" | null*) say "main gate: no merged pull request made ${head:0:12}; stage 1 decides" && return 0 ;;
    *:release/*) return 0 ;;
  esac
  buckets="$(q main-pr-buckets --may-fail -- gh pr checks "$number" -R "$PRIVATE_REPO" --required \
    --json bucket -q '[.[].bucket] | unique | join(" ")')"
  case " $buckets " in
    *" fail "* | *" cancel "*)
      die "main gate: #$number made main's head with a failed required check; fix main first (gh pr checks $number -R $PRIVATE_REPO)" ;;
    *" pending "*) die "main gate: #$number merged before its required checks finished; wait for them, then rerun" ;;
  esac
}

stage_candidate() {
  x fetch-test -C "$TEST" -- git fetch -q "$PRIVATE_URL" "release/$VERSION"
  x checkout-test -C "$TEST" -- git checkout -q --detach "$SHA"
  local tree
  for tree in "$TEST" "$BUILD"; do
    x "clean-$(basename "$tree")" -C "$tree" -- git clean -fdxq -e node_modules
    x "install-$(basename "$tree")" -C "$tree" -- "${NO_GH_TOKEN[@]}" pnpm install --frozen-lockfile
  done
  t lockfile-unchanged -C "$TEST" -- git diff --quiet -- pnpm-lock.yaml ||
    die "pnpm install changed pnpm-lock.yaml at $SHA12; commit the lockfile fix"
  electron_runtime
}

# pnpm runs electron's postinstall (install.js, which downloads dist/) only when it links the
# package. The build tree keeps node_modules across `git clean -e node_modules`, so with an
# unchanged lockfile `pnpm install` changes nothing and a dist that an earlier install skipped
# or cut short stays missing; the signed build then fails late. CI runs ensure:electron after
# every install for the same reason. Here electron's own install.js repairs it (it checks the
# download against electron's published checksums), and the check after it stops the release
# with the paths that are missing.
electron_runtime() {
  local desktop="$BUILD/apps/desktop" electron="$BUILD/apps/desktop/node_modules/electron"
  local check=(node scripts/ensure-electron-runtime.mjs --check)
  need_file "$desktop/scripts/ensure-electron-runtime.mjs" "the Electron runtime check"
  if [ "$MODE" = dry ]; then
    say "    electron-check: (in $desktop) ${check[*]}; when it fails, electron's install.js and the check again"
    return 0
  fi
  if t electron-check -C "$desktop" -- "${check[@]}" 2> /dev/null; then return 0; fi
  say "$CURRENT_STAGE: electron's runtime is missing or incomplete in $electron; running its install.js"
  need_file "$electron/install.js" "electron's install script (pnpm install did not link electron)"
  x electron-reset -- rm -rf "$electron/dist" "$electron/path.txt"
  x electron-install -C "$electron" -- "${NO_GH_TOKEN[@]}" node install.js
  t electron-recheck -C "$desktop" -- "${check[@]}" ||
    die "electron's dist is still missing or incomplete in $electron after install.js; see the paths above, check that ELECTRON_SKIP_BINARY_DOWNLOAD and npm ignore-scripts are unset, then --resume"
}

# ---------------------------------------------------------------- stage 1: everything but the server

# retry_jobs, run_group and retry_server_files.
# shellcheck source=release-retry.sh
. "$HERE/release-retry.sh"

run_job() {  # run_job OUT NAME|DIR|KIND: one stage-1 job, leaving OUT/NAME.exit and .secs
  local out="$1" name dir kind started code
  IFS='|' read -r name dir kind << EOF
$2
EOF
  if [ "$MODE" = dry ]; then
    case "$kind" in
      pkg) x "test:$dir" -C "$TEST/$dir" -- "${NO_GH_TOKEN[@]}" CI=1 node --run test ;;
      typecheck) x typecheck-gate -C "$TEST" -- "${NO_GH_TOKEN[@]}" bash scripts/studio-verify/typecheck-gate.sh --jobs 3 --out "$out/typecheck" ;;
      fleet) x fleet-tests -C "$TEST" -- "${NO_GH_TOKEN[@]}" bash scripts/studio-fleet/run-tests.sh --out "$out/fleet" --history "<the last fleet results>" ;;
      contrast) x contrast -C "$TEST/apps/web" -- "${NO_GH_TOKEN[@]}" CI=1 node --run test -- $CONTRAST_TESTS ;;
    esac
    return 0
  fi
  started=$(date +%s)
  set +e
  case "$kind" in
    pkg) x "test:$dir" -C "$TEST/$dir" -- "${NO_GH_TOKEN[@]}" CI=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 node --run test > "$out/$name.log" 2>&1 ;;
    typecheck) x typecheck-gate -C "$TEST" -- "${NO_GH_TOKEN[@]}" CI=1 bash scripts/studio-verify/typecheck-gate.sh --jobs 3 --out "$out/typecheck" > "$out/$name.log" 2>&1 ;;
    fleet) x fleet-tests -C "$TEST" -- "${NO_GH_TOKEN[@]}" bash scripts/studio-fleet/run-tests.sh --out "$out/fleet" ${FLEET_HISTORY[@]+"${FLEET_HISTORY[@]}"} > "$out/$name.log" 2>&1 ;;
    contrast) x contrast -C "$TEST/apps/web" -- "${NO_GH_TOKEN[@]}" CI=1 node --run test -- $CONTRAST_TESTS > "$out/$name.log" 2>&1 ;;
  esac
  code=$?
  set -e
  printf '%s\n' "$code" > "$out/$name.exit"
  printf '%s\n' "$(($(date +%s) - started))" > "$out/$name.secs"
}

pool() {  # pool OUT SPEC...: at most $JOBS jobs at once
  local out="$1" spec pid running
  local pids=()
  shift
  for spec in "$@"; do
    while :; do
      running=0
      for pid in ${pids[@]+"${pids[@]}"}; do
        if kill -0 "$pid" 2> /dev/null; then running=$((running + 1)); fi
      done
      if [ "$running" -lt "$JOBS" ]; then break; fi
      sleep 1
    done
    run_job "$out" "$spec" &
    pids+=($!)
  done
  for pid in ${pids[@]+"${pids[@]}"}; do
    set +e
    wait "$pid"
    set -e
  done
}

# --ci only. Stage-1 jobs run with every GitHub token unset (NO_GH_TOKEN), so git cannot fetch a
# missing object from there: on a hosted runner its credential helper is `gh auth git-credential`,
# which needs GH_TOKEN. A partial clone lacks blobs, and the preservation audits read commits that
# main does not reach (pinned by id under scripts/studio-toolchain). Fetch all of it now, while the
# token is set (stage 1 runs this on --resume too), and prove the audit's lockfile needs no fetch.
LAZY_FETCH_PROBE=f0b6d13fb273ae3285861878c43b822731926023  # its pnpm-lock.yaml: preservation-audit.test.mjs
objects_complete() {  # objects_complete ID: ID and everything it reaches are here, with no lazy fetch
  local out
  out="$(GIT_NO_LAZY_FETCH=1 git rev-list --objects --missing=print "$1" 2> /dev/null)" || return 1
  ! grep -q '^?' <<< "$out"
}
prefetch_test_objects() {
  local pinned=() absent=() tips=() sha probe=0 listed
  listed="$(q pinned-objects -- python3 -B "$TOOLS" pinned-objects "$TEST/scripts/studio-toolchain")" ||
    die "stage1: could not list the commits pinned under $TEST/scripts/studio-toolchain"
  while read -r sha; do
    if [ -n "$sha" ]; then pinned+=("$sha"); fi
    if [ "$sha" = "$LAZY_FETCH_PROBE" ]; then probe=1; fi
  done <<< "$listed"
  # The probe below is this check's proof; if the audits stop pinning it, pick a new probe here.
  [ $probe -eq 1 ] ||
    die "stage1: $LAZY_FETCH_PROBE is no longer pinned under scripts/studio-toolchain; update LAZY_FETCH_PROBE in release.sh"
  if ! t candidate-complete -C "$TEST" -- objects_complete "$SHA"; then
    # A partial clone: fetch the candidate's objects afresh, as a full clone holds them.
    x backfill-objects -C "$TEST" -- git fetch -q --refetch --no-filter --no-tags --no-write-fetch-head "$PRIVATE_URL" "$SHA"
    t candidate-complete -C "$TEST" -- objects_complete "$SHA" ||
      die "stage1: $TEST still lacks objects of $SHA12 after the backfill; stage-1 tests cannot fetch them"
  fi
  # One id at a time, with full history (the audits diff a commit against its parent). The haves
  # sent are only trees known to be complete, so a partial clone's gaps are filled too. Some ids
  # are only recorded, never read, and exist nowhere on GitHub: those are reported, not fatal.
  tips=(--negotiation-tip="$SHA")
  for sha in ${pinned[@]+"${pinned[@]}"}; do
    if ! t pinned-complete -C "$TEST" -- objects_complete "$sha"; then
      if ! x fetch-pinned -C "$TEST" -- git fetch -q --no-filter --no-tags --no-write-fetch-head "${tips[@]}" \
        "$PRIVATE_URL" "$sha" 2> /dev/null || ! t pinned-complete -C "$TEST" -- objects_complete "$sha"; then
        absent+=("$sha")
        continue
      fi
    fi
    tips+=(--negotiation-tip="$sha")
  done
  if [ ${#absent[@]} -gt 0 ]; then say "stage1: not on $PRIVATE_REPO, so stage-1 tests cannot read: ${absent[*]}"; fi
  t no-lazy-fetch -C "$TEST" -- env GIT_NO_LAZY_FETCH=1 git show "$LAZY_FETCH_PROBE:pnpm-lock.yaml" > /dev/null ||
    die "stage1: $LAZY_FETCH_PROBE:pnpm-lock.yaml needs a fetch, and stage-1 tests run without a GitHub token"
}
stage_stage1() {
  local out="$STAGE/stage1/$SHA12-$(date +%s)" failed_file="$STAGE/stage1/failed.txt" line dir name spec listing=""
  local specs=() ordered=() first=() rest=() failed=() secs retried=0
  FLEET_HISTORY=()
  RETRIED_JOBS=0  # run_group's retries in this stage, counted across its two groups
  need_file "$TEST/scripts/studio-verify/typecheck-gate.sh" "the typecheck gate from the release-gates branch"
  need_file "$TEST/scripts/studio-fleet/run-tests.sh" "the fleet test runner from the release-gates branch"
  if [ "$CI_MODE" -eq 1 ]; then prefetch_test_objects; fi
  if [ "$MODE" = dry ]; then
    # Listed from this checkout; a real run lists the candidate's packages.
    if ! listing="$(python3 -B "$TOOLS" packages "$REPO_ROOT" 2> /dev/null)"; then listing=""; fi
  else
    listing="$(q packages -- python3 -B "$TOOLS" packages "$TEST")"
  fi
  while IFS="$(printf '\t')" read -r dir name; do
    [ -n "$dir" ] || continue
    specs+=("$(printf '%s' "$dir" | tr '/' '_')|$dir|pkg")
  done << EOF
$listing
EOF
  specs+=("typecheck|.|typecheck" "fleet|.|fleet")
  if [ "$MODE" = dry ]; then
    say "    $JOBS jobs at a time, contrast first, then the longest by the last run's times; last attempt's failures first:"
    run_job "$out" "contrast|apps/web|contrast"
    for spec in "${specs[@]}"; do run_job "$out" "$spec"; done
    say "    (every package with a test script except the root and apps/server, which is the server stage)"
    say "    a failed job (at most $RETRY_MAX_JOBS in the stage) runs once more, alone; a second failure fails the stage"
    return 0
  fi
  mkdir -p "$out"
  # Contrast first (a contrast offender fails in seconds), then the longest jobs by this release's
  # or the previous release's last times, so the long ones do not start last.
  while read -r name; do
    for spec in "${specs[@]}"; do
      if [ "${spec%%|*}" = "$name" ]; then ordered+=("$spec"); fi
    done
  done << EOF
$(python3 -B "$TOOLS" stage1-order --history "$STAGE/stage1" --history "$STAGING_ROOT/$PREV/stage1" -- "${specs[@]%%|*}")
EOF
  [ ${#ordered[@]} -eq ${#specs[@]} ] || die "stage1: release_tools.py stage1-order lost jobs (${#ordered[@]} of ${#specs[@]})"
  specs=("contrast|apps/web|contrast" "${ordered[@]}")
  # The fleet runner also starts its longest tests first, by the newest fleet results here.
  if grep -q -- '--history' "$TEST/scripts/studio-fleet/run-tests.sh"; then
    while read -r dir; do
      if [ -n "$dir" ]; then FLEET_HISTORY+=(--history "$dir"); fi
    done << EOF
$(python3 -B "$TOOLS" stage1-fleet-dirs --history "$STAGE/stage1" --history "$STAGING_ROOT/$PREV/stage1")
EOF
  fi
  # Jobs that failed last time run first, so a fix is checked within seconds.
  for spec in "${specs[@]}"; do
    if [ -f "$failed_file" ] && grep -qxF "${spec%%|*}" "$failed_file"; then first+=("$spec"); else rest+=("$spec"); fi
  done
  if [ ${#first[@]} -gt 0 ]; then
    say "stage1: rerunning last attempt's failures first: $(cut -d'|' -f1 <<< "$(printf '%s\n' "${first[@]}")" | tr '\n' ' ')"
    run_group "$out" "${first[@]}"
    for spec in "${first[@]}"; do
      if [ "$(cat "$out/${spec%%|*}.exit")" != 0 ]; then failed+=("${spec%%|*}"); fi
    done
  fi
  if [ ${#failed[@]} -eq 0 ] && [ ${#rest[@]} -gt 0 ]; then
    run_group "$out" "${rest[@]}"
  fi
  printf '%-34s %-6s %6s\n' JOB RESULT SECS
  failed=()
  for spec in "${specs[@]}"; do
    name="${spec%%|*}"
    if [ ! -f "$out/$name.exit" ]; then
      printf '%-34s %-6s %6s\n' "$name" "-" "-"
      continue
    fi
    line=pass
    secs="$(cat "$out/$name.secs")"
    if [ -f "$out/try-1/$name.secs" ]; then
      secs="$(cat "$out/try-1/$name.secs")+$secs"
      retried=1
      line=FLAKE
    fi
    if [ "$(cat "$out/$name.exit")" != 0 ]; then
      line=FAIL
      failed+=("$name")
    fi
    printf '%-34s %-6s %6s\n' "$name" "$line" "$secs"
  done
  if [ ${#failed[@]} -gt 0 ]; then
    printf '%s\n' "${failed[@]}" > "$failed_file"
    for name in "${failed[@]}"; do
      if [ -f "$out/try-1/$name.log" ]; then say "--- $name: first try in $out/try-1/$name.log"; fi
      say "--- $name: failing tests in $out/$name.log"
      grep -E '^not ok|^ *(FAIL|×) ' "$out/$name.log" | head -n 20 || true
      say "--- $name: last 25 lines"
      tail -n 25 "$out/$name.log"
    done
    if [ -d "$out/try-1" ] && [ -f "$out/try-1/${failed[0]}.exit" ]; then
      die "stage 1 failed: ${failed[*]} (failed again on retry); the signed build does not start"
    fi
    die "stage 1 failed: ${failed[*]}; the signed build does not start"
  fi
  if [ "$retried" -eq 1 ]; then say "stage1: passed; each FLAKE row passed only on its second run"; fi
  rm -f "$failed_file"
}

# ---------------------------------------------------------------- the server suite (background)

server_alive() {  # server_alive PID: a live --internal-server of this version
  [ -n "$1" ] && kill -0 "$1" 2> /dev/null &&
    ps -o command= -p "$1" 2> /dev/null | grep -q -- "--internal-server $VERSION"
}

stop_stale_server() {
  local pid sha
  [ -f "$STAGE/server.pid" ] || return 0
  read -r pid sha _ < "$STAGE/server.pid"
  if [ "$sha" != "$SHA" ] && server_alive "$pid"; then
    say "Stopping the server suite for the old candidate (process group $pid)"
    x stop-server -- kill -TERM -- "-$pid"
  fi
  return 0
}

# server.pid holds the running suite's process group, its candidate and its RETRY (0 for
# --no-retry). A file without the last is from before it was kept, when retries were the default.
start_server() {
  local pid="" sha="" retry="" waited=0
  if is_done server "$SHA"; then return 0; fi
  if [ "$MODE" = dry ]; then
    say "> server (background, alongside build..drafts)"
    stage_server
    return 0
  fi
  if [ -f "$STAGE/server.pid" ]; then read -r pid sha retry < "$STAGE/server.pid"; fi
  if [ "$sha" = "$SHA" ] && server_alive "$pid"; then
    if [ "${retry:-1}" = "$RETRY" ]; then
      say "= server: still running for $SHA12 (pid $pid)"
      return 0
    fi
    # A suite that retries would hide the flake --no-retry is meant to reproduce; and one started
    # with --no-retry fails on a flake this run would retry.
    if [ "$RETRY" -eq 0 ]; then
      say "server: the suite running for $SHA12 (pid $pid) retries failed files; restarting it with --no-retry"
    else
      say "server: the suite running for $SHA12 (pid $pid) has --no-retry; restarting it with retries"
    fi
    x stop-server -- kill -TERM -- "-$pid"
    # Its whole process group gone before the new one starts: the leader goes at once, while
    # test-sharded.mjs stays until its shards (in groups of their own) have closed, 15s at most.
    # A stub run sends no signal and still waits, for the self-test's stand-in. Any result it
    # wrote meanwhile is dropped: it is not this run's (server.exit goes below).
    while kill -0 -- "-$pid" 2> /dev/null; do
      [ $waited -lt 30 ] || die "the server suite (process group $pid) did not stop within 30s; stop it, then --resume"
      sleep 1
      waited=$((waited + 1))
    done
    remove_owned "$MARKERS/server"
  fi
  rm -f "$STAGE/server.exit"
  set -m
  local flags=()
  if [ "$RETRY" -eq 0 ]; then flags=(--no-retry); fi
  bash "$SELF" --internal-server "$VERSION" "$SHA" ${flags[@]+"${flags[@]}"} >> "$LOG_DIR/server.log" 2>&1 < /dev/null &
  pid=$!
  set +m
  printf '%s %s %s\n' "$pid" "$SHA" "$RETRY" > "$STAGE/server.pid"
  say "> server: started in the background (pid $pid, log $LOG_DIR/server.log)"
}

stage_server() {
  local green="" out rc=0
  local extra=()
  need_file "$TEST/scripts/release/test-sharded.mjs" "the sharded server runner from the release-gates branch"
  if [ -s "$STAGE/green-server.sha" ]; then green="$(cat "$STAGE/green-server.sha")"; fi
  if [ -n "$green" ] && [ "$green" != "$SHA" ]; then
    if t lock-unchanged -C "$TEST" -- git diff --quiet "$green" "$SHA" -- pnpm-lock.yaml patches; then
      extra=(--changed "$green")
      say "server: only what changed since green $(printf '%s' "$green" | cut -c1-12); vitest reruns all on config changes"
    else
      say "server: pnpm-lock.yaml or patches changed since the last green run; running in full"
    fi
  fi
  out="$STAGE/server/$SHA12-$(date +%s)"
  ensure_dir "$STAGE/server"
  # The suite never needs the release's GitHub token, and gh-backed tests read it before their fakes.
  x server-shards -C "$TEST" -- env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
    CI=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    node scripts/release/test-sharded.mjs --shards "$SERVER_SHARDS" --out "$out" ${extra[@]+"${extra[@]}"} || rc=$?
  if [ "$MODE" = dry ]; then
    say "    server-retry: (in $TEST) when at most $RETRY_MAX_FILES files failed and no shard crashed or timed out, only those, once, as one shard: test-sharded.mjs --shards 1 --out $out/retry-1 -- FILE..."
  fi
  if [ "$rc" -ne 0 ]; then
    rc=0
    retry_server_files "$out" || rc=$?
    if [ "$rc" -ne 0 ]; then return "$rc"; fi
  fi
  if [ ${#extra[@]} -eq 0 ] && [ "$MODE" != dry ]; then
    # A full run's per-shard JSON reports can refresh the recorded shard weights in a follow-up PR.
    # --out writes the checkout the command runs from; without it the script would rewrite the
    # test tree's own tracked copy, under --root.
    say "server: full run; refresh shard weights from the checkout you commit them in: node scripts/update-test-shard-weights.ts --root $TEST/apps/server --out apps/server/src/testUtils/shardWeights.json $out/server-*.json"
  fi
}

internal_server() {
  local started rc attempt status=ok
  CURRENT_STAGE=server
  SHA12="$(printf '%s' "$SHA" | cut -c1-12)"
  attempt="$(attempt_of server)"
  printf '\n===== %s server attempt %s %s =====\n' "$(date -u +%FT%TZ)" "$attempt" "$SHA12"
  STAGE_ATTEMPT="$attempt"
  started=$(date +%s)
  set +e
  (
    set -e
    stage_server
  )
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then status=failed; fi
  record_timing server "$started" "$(date +%s)" "$status" "$attempt"
  if [ "$rc" -eq 0 ]; then
    mark_done server "$SHA"
    state_write "$STAGE/green-server.sha" "$SHA"
  fi
  state_write "$STAGE/server.exit" "$SHA $rc"
  exit "$rc"
}

# The current candidate's server result: its exit code, or nothing while it has none.
server_result() {
  local sha="" rc=""
  if is_done server "$SHA"; then
    printf '0\n'
    return 0
  fi
  if [ -f "$STAGE/server.exit" ]; then read -r sha rc < "$STAGE/server.exit"; fi
  if [ "$sha" = "$SHA" ] && [ -n "$rc" ]; then printf '%s\n' "$rc"; fi
  return 0
}

# The server suite runs in the background from stage 1 on. Once it has failed, stop before the
# next bundle, signing, plan or drafts stage rather than finish a candidate that cannot ship.
stop_if_server_failed() {
  local rc
  rc="$(server_result)"
  if [ -z "$rc" ] || [ "$rc" = 0 ]; then return 0; fi
  if [ -f "$LOG_DIR/server.log" ]; then tail -n 40 "$LOG_DIR/server.log"; fi
  drop_drafts  # An earlier candidate's drafts.
  die "the server suite failed for $SHA12 (exit $rc); fix, commit in $BUILD and --resume (reruns only changed files)"
}

stage_server_wait() {
  local pid="" sha="" rc="" started noted flakes attempt
  if [ "$MODE" = dry ]; then
    say "    wait for the background server suite; fail here if it failed"
    return 0
  fi
  if [ "$MODE" = stub ]; then POLL=0.2; fi
  started=$(date +%s)
  noted=$started
  while :; do
    rc="$(server_result)"
    if [ -n "$rc" ]; then break; fi
    pid="" sha=""
    if [ -f "$STAGE/server.pid" ]; then read -r pid sha _ < "$STAGE/server.pid"; fi
    if [ "$sha" != "$SHA" ] || ! server_alive "$pid"; then
      sleep 1  # It may have written its result just after the first look.
      rc="$(server_result)"
      if [ -n "$rc" ]; then break; fi
      die "the server suite for $SHA12 stopped without a result; see $LOG_DIR/server.log, then --resume"
    fi
    sleep "$POLL"
    if [ $(($(date +%s) - noted)) -ge 120 ]; then
      noted=$(date +%s)
      say "server-wait: still running after about $((noted - started))s"
    fi
  done
  if [ "$rc" != 0 ]; then
    tail -n 40 "$LOG_DIR/server.log"
    drop_drafts
    die "the server suite failed for $SHA12 (exit $rc); fix, commit in $BUILD and --resume (reruns only changed files)"
  fi
  # Only the retries of the run that gave this result: an earlier attempt on the same candidate may
  # have retried files of its own. That run is the newest server line in stages.jsonl, which
  # internal_server writes before its result.
  attempt=$(($(attempt_of server) - 1))
  flakes="$(python3 -B "$TOOLS" timing retries --file "$TIMINGS/retries.jsonl" --stage server --sha "$SHA12" \
    --attempt "$attempt" --result passed)"
  if [ -n "$flakes" ]; then
    say "server: green for $SHA12, after a retry of: ${flakes//$'\n'/ } (FLAKY)"
  else
    say "server: green for $SHA12"
  fi
}

# ---------------------------------------------------------------- build, bundle, sign

load_google_pair() {  # Exports only the two Google OAuth variables; never evaluates the file.
  local key value
  if [ "$MODE" = dry ]; then return 0; fi
  # `|| [ -n "$key" ]` keeps a last line that has no newline.
  while IFS='=' read -r key value || [ -n "$key" ]; do
    key="${key#export }"
    case "$key" in
      STUDIO_GOOGLE_OAUTH_CLIENT_ID | STUDIO_GOOGLE_OAUTH_CLIENT_SECRET)
        case "$value" in
          \"*\") value="${value#\"}" value="${value%\"}" ;;
          \'*\') value="${value#\'}" value="${value%\'}" ;;
        esac
        export "$key=$value"
        ;;
    esac
  done < "$GOOGLE_OAUTH_ENV_FILE"
}

# SpecWithCode Connect ships on only when all four public values are set (release.env, or the
# STUDIO_* repository variables in release-macos.yml). Then the build bakes hosted services on
# for the server and the web client; with any value missing the gate stays off and the values
# are not passed, so the build matches a release without Connect.
CONNECT_PUBLIC_KEYS="STUDIO_CLERK_PUBLISHABLE_KEY STUDIO_CLERK_JWT_TEMPLATE STUDIO_CLERK_CLI_OAUTH_CLIENT_ID STUDIO_RELAY_URL"
connect_public_config_complete() {
  local key
  for key in $CONNECT_PUBLIC_KEYS; do [ -n "${!key:-}" ] || return 1; done
  case "$STUDIO_RELAY_URL" in https://*) return 0 ;; *) return 1 ;; esac
}

load_connect_public_config() {
  local key
  if connect_public_config_complete; then
    for key in $CONNECT_PUBLIC_KEYS; do export "$key=${!key}"; done
    export STUDIO_ENABLE_HOSTED_SERVICES=true VITE_STUDIO_ENABLE_HOSTED_SERVICES=true
    say "build: SpecWithCode Connect on (relay $STUDIO_RELAY_URL)"
  else
    for key in $CONNECT_PUBLIC_KEYS; do unset "$key"; done
    unset STUDIO_ENABLE_HOSTED_SERVICES VITE_STUDIO_ENABLE_HOSTED_SERVICES
    say "build: SpecWithCode Connect off (public values not configured)"
  fi
}

stage_build() {
  need_file "${GOOGLE_OAUTH_ENV_FILE:-}" "the Google OAuth pair"
  # Again here: a staging folder whose candidate stage ran before this check existed (or an
  # Electron folder changed since) resumes at build, and the signed build needs the runtime.
  electron_runtime
  (
    load_google_pair
    load_connect_public_config
    x build-desktop -C "$BUILD" -- env APP_VERSION="$VERSION" node node_modules/vite-plus/bin/vp run build:desktop
  )
}

# verify_bundle LABEL ARCHIVE FRESH: the archive is what hosts install, so verify it unpacked in a
# fresh folder, not the build output.
verify_bundle() {
  if t verify-bundle-takes-archives -- grep -q 'tar\.gz' "$BUILD/scripts/studio-fleet/verify-bundle.mjs"; then
    x "$1" -C "$BUILD" -- node scripts/studio-fleet/verify-bundle.mjs "$2"
  else
    ensure_dir "$3"
    x "unpack-$1" -- tar -xzf "$2" -C "$3"
    x "$1" -C "$BUILD" -- node scripts/studio-fleet/verify-bundle.mjs "$3"
  fi
}

# The Linux worker archives: the same runtime stamped for each target, so a Linux VPS can join the
# fleet (docs/user/linux-worker.md). Built here because every native dependency ships all targets.
LINUX_ARCHS="x64 arm64"

stage_bundle() {
  local archive="$ASSETS/studio-$VERSION-$SHA12.tar.gz" runtime="$STAGE/runtime-$SHA12"
  local verify="$STAGE/google-verify-$SHA12" fresh="$STAGE/verify-runtime-$SHA12" target
  ensure_dir "$ASSETS"
  remove_owned "$runtime" "$archive" "$archive.receipt.json" "$verify" "$fresh"
  x bundle -C "$BUILD" -- node scripts/studio-fleet/bundle.mjs --out "$runtime" --archive "$archive"
  verify_bundle verify-bundle "$archive" "$fresh"
  for target in $LINUX_ARCHS; do
    remove_owned "$STAGE/runtime-linux-$target-$SHA12" "$ASSETS/studio-$VERSION-linux-$target-$SHA12.tar.gz" \
      "$ASSETS/studio-$VERSION-linux-$target-$SHA12.tar.gz.receipt.json" "$STAGE/verify-runtime-linux-$target-$SHA12"
    x "bundle-linux-$target" -C "$BUILD" -- node scripts/studio-fleet/bundle.mjs \
      --out "$STAGE/runtime-linux-$target-$SHA12" --archive "$ASSETS/studio-$VERSION-linux-$target-$SHA12.tar.gz" \
      --platform linux --arch "$target"
    verify_bundle "verify-bundle-linux-$target" "$ASSETS/studio-$VERSION-linux-$target-$SHA12.tar.gz" \
      "$STAGE/verify-runtime-linux-$target-$SHA12"
  done
  x google-verify -C "$BUILD" -- env STUDIO_TEST_REQUIRE_BUILTIN_GOOGLE=1 node scripts/studio-google/verify.mjs "$verify"
}

sign_artifacts() {
  local file
  for file in "${CSC_LINK_PATH:-}" "${CSC_PASSPHRASE_FILE:-}" "${APPLE_API_KEY_PATH:-}"; do
    need_file "$file" "signing input from $RELEASE_ENV"
  done
  (
    export CSC_LINK="${CSC_LINK_PATH:-}" APPLE_API_KEY="${APPLE_API_KEY_PATH:-}"
    export APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}" APPLE_API_ISSUER="${APPLE_API_ISSUER:-}"
    if [ "$MODE" != dry ]; then
      CSC_KEY_PASSWORD="$(cat "$CSC_PASSPHRASE_FILE")"
      export CSC_KEY_PASSWORD
    fi
    x sign -C "$BUILD" -- node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
      --signed --skip-build --build-version "$VERSION" --output-dir "$ASSETS"
  )
}

stage_sign() {
  sign_artifacts
  # Apple's notarization ticket can reach the stapler late: the 1.0.44 DMG once came out without
  # it while the zip from the same run had it. One fresh signing run fixes that; a second failure
  # is a real signing problem and stops the release.
  if ! x mac-signature -C "$BUILD" -- node scripts/studio-projects/mac-signature.mjs \
    "$ASSETS/SpecWithCode-$VERSION-arm64.dmg" "$ASSETS/SpecWithCode-$VERSION-arm64.zip"; then
    say "sign: the signature check refused the build; signing once more"
    sign_artifacts
    x mac-signature-retry -C "$BUILD" -- node scripts/studio-projects/mac-signature.mjs \
      "$ASSETS/SpecWithCode-$VERSION-arm64.dmg" "$ASSETS/SpecWithCode-$VERSION-arm64.zip"
  fi
}

stage_helpers() {
  need_file "$BUILD/scripts/studio-fleet/make_helpers.py" "the helpers builder"
  x make-helpers -C "$BUILD" -- python3 -B scripts/studio-fleet/make_helpers.py --repo "$BUILD" --out "$ASSETS" \
    --version "$VERSION" --commit "$SHA" --previous-manifest "$STAGE/prev/deployment-helpers-manifest.json"
}

desktop_assets() {
  printf '%s\n' "SpecWithCode-$VERSION-arm64.dmg" "SpecWithCode-$VERSION-arm64.dmg.blockmap" \
    "SpecWithCode-$VERSION-arm64.zip" "SpecWithCode-$VERSION-arm64.zip.blockmap" SpecWithCode-arm64.dmg latest-mac.yml
}

linux_assets() {
  local target
  for target in $LINUX_ARCHS; do printf '%s\n' "studio-$VERSION-linux-$target-$SHA12.tar.gz"; done
}

# The command-line installer (docs/user/install.md#command-line), served from the newest release
# as releases/latest/download/install.sh.
installer_assets() {
  printf '%s\n' install.sh
}

release_assets() {
  desktop_assets
  linux_assets
  installer_assets
  printf '%s\n' "studio-$VERSION-$SHA12.tar.gz" "studio-$VERSION-deployment-helpers-$SHA12.tar.gz" \
    deployment-helpers-manifest.json studio-update.json SHA256SUMS
}

stage_plan() {
  local runtime="studio-$VERSION-$SHA12.tar.gz" helpers="studio-$VERSION-deployment-helpers-$SHA12.tar.gz"
  local names=() args=() name
  while read -r name; do names+=("$name"); done << EOF
$(desktop_assets)
$(linux_assets)
$(installer_assets)
EOF
  # The plans of 1.0.30 to 1.0.37 passed both flags. Without --allow-project-migrations a release
  # that migrates fails and rolls back on every host, also on one that skipped the migrating release.
  if [ "$MIGRATIONS" -eq 1 ]; then args+=(--arg=--allow-project-migrations); fi
  args+=(--arg=--allow-existing-browser-heartbeat)
  x installer -- cp "$BUILD/scripts/install.sh" "$ASSETS/install.sh"
  x sums -- python3 -B "$TOOLS" sums --dir "$ASSETS" --out "$ASSETS/SHA256SUMS" "${names[@]}" \
    "$runtime" "$helpers" deployment-helpers-manifest.json
  x plan -C "$BUILD/scripts/studio-fleet" -- python3 -B make_update_plan.py --version "$VERSION" \
    --source-commit "$SHA" --sha256sums "$ASSETS/SHA256SUMS" --runtime "$runtime" --helpers "$helpers" \
    --previous-plan "$STAGE/prev/studio-update.json" --output "$ASSETS/studio-update.json" "${args[@]}"
  x sums-plan -- python3 -B "$TOOLS" sums --dir "$ASSETS" --out "$ASSETS/SHA256SUMS" --append studio-update.json
  # The prev stage of the next release and every host's agent check the plan against SHA256SUMS.
  x sums-check -- python3 -B "$TOOLS" verify-sums --dir "$ASSETS" "${names[@]}" "$runtime" "$helpers" \
    deployment-helpers-manifest.json studio-update.json
}

# ---------------------------------------------------------------- drafts and publishing

release_flags() {
  local flags
  flags="$(q release-flags -C "$BUILD" -- node scripts/studio-projects/release-flags.mjs "$VERSION")"
  FLAGS=()
  if [ -n "$flags" ]; then read -r -a FLAGS <<< "$flags"; fi
}

reset_public() {
  x public-fetch -C "$PUBLIC_CLONE" -- git fetch -q origin
  x public-main -C "$PUBLIC_CLONE" -- git checkout -q -B main origin/main
  x public-reset -C "$PUBLIC_CLONE" -- git reset -q --hard origin/main
  x public-clean -C "$PUBLIC_CLONE" -- git clean -fdxq
}

replace_draft() {  # replace_draft REPO TARGET NOTES LABEL: a fresh draft for this candidate
  local repo="$1" target="$2" notes="$3" label="$4" state
  state="$(q "draft-$label" --may-fail -- gh release view "v$VERSION" -R "$repo" --json isDraft -q .isDraft)"
  case "$state" in
    false) die "v$VERSION is already published on $repo" ;;
    true) x "delete-old-draft-$label" -- gh release delete "v$VERSION" -R "$repo" --yes ;;
  esac
  x "draft-$label" -- gh release create "v$VERSION" -R "$repo" --draft --target "$target" \
    --title "SpecWithCode $VERSION" --notes-file "$notes" ${FLAGS[@]+"${FLAGS[@]}"}
}

# A gate failed after the drafts were made: delete both (drafts only) so nothing half-made is left.
drop_drafts() {
  local repo state
  for repo in "$PRIVATE_REPO" "$PUBLIC_REPO"; do
    state="$(q "draft-state" --may-fail -- gh release view "v$VERSION" -R "$repo" --json isDraft -q .isDraft)"
    if [ "$state" = true ]; then x drop-draft -- gh release delete "v$VERSION" -R "$repo" --yes; fi
  done
  remove_owned "$MARKERS/drafts"
}

upload_assets() {  # upload_assets REPO LABEL
  local files=() name
  while read -r name; do
    # The version-free DMG is only for the public releases/latest/download link; SHA256SUMS
    # still lists it, and nothing downloads it from the private repo.
    if [ "$2" = private ] && [ "$name" = SpecWithCode-arm64.dmg ]; then continue; fi
    files+=("$ASSETS/$name")
  done << EOF
$(release_assets)
EOF
  x "upload-$2" -- gh release upload "v$VERSION" -R "$1" --clobber "${files[@]}"
}

stage_drafts() {
  local base
  release_flags
  if [ ! -s "$STAGE/notes.md" ]; then
    base="$(q prev-source --may-fail -- python3 -B "$TOOLS" json-get "$STAGE/prev/studio-update.json" sourceCommit)"
    x notes -- python3 -B "$TOOLS" notes --repo "$BUILD" --to "$SHA" --version "$VERSION" --out "$STAGE/notes.md" \
      ${base:+--base "$base"}
    say "drafts: release notes drafted in $STAGE/notes.md; edit them while the suites run"
  fi
  x public-notes -- python3 -B "$TOOLS" public-notes --in "$STAGE/notes.md" --out "$STAGE/notes-public.md" --rules "$PUBLIC_RULES"
  replace_draft "$PRIVATE_REPO" "$SHA" "$STAGE/notes.md" private
  upload_assets "$PRIVATE_REPO" private
  # Check the public snapshot now (commit only, no tag or push), then put the clone back.
  reset_public
  x mirror-check -C "$BUILD" -- node scripts/public-mirror/publish.mjs --public "$PUBLIC_CLONE" --ref "$SHA"
  reset_public
  replace_draft "$PUBLIC_REPO" main "$STAGE/notes-public.md" public
  upload_assets "$PUBLIC_REPO" public
}

stage_quit_desktop() {
  local pids pid command waited
  if [ "$MODE" = dry ]; then say "    quit $APP if it runs: TERM its pid (checked against the bundle path), wait up to 60s"; fi
  pids="$(q desktop-pids --may-fail -- pgrep -x SpecWithCode)"
  for pid in $pids; do
    command="$(q desktop-command --may-fail -- ps -o comm= -p "$pid")"
    [ "$command" = "$APP/Contents/MacOS/SpecWithCode" ] ||
      die "process $pid is called SpecWithCode but is not $APP; quit it yourself"
    x quit-desktop -- kill -TERM "$pid"
    waited=0
    while t desktop-running -- kill -0 "$pid" 2> /dev/null; do
      [ $waited -lt 60 ] || die "the desktop app (pid $pid) did not quit within 60s; quit it yourself and --resume"
      sleep 1
      waited=$((waited + 1))
    done
    if [ "$MODE" = real ]; then say "quit-desktop: pid $pid exited"; fi
  done
}

publish() {  # publish REPO NOTES LABEL: flip the draft and check it is public
  local check="$STAGE/published-check/$3"
  release_flags
  # What the draft holds, not what the assets folder holds: its SHA256SUMS must be this
  # candidate's and list the plan and helpers manifest it carries (1.0.38's did not list the plan).
  remove_owned "$check"
  ensure_dir "$check"
  x "fetch-sums-$3" -- gh release download "v$VERSION" -R "$1" -p SHA256SUMS -p studio-update.json \
    -p deployment-helpers-manifest.json -D "$check" --clobber
  x "check-sums-$3" -- python3 -B "$TOOLS" verify-sums --dir "$check" studio-update.json deployment-helpers-manifest.json
  if [ "$MODE" = dry ]; then say "    same-sums-$3: stop unless $check/SHA256SUMS is $ASSETS/SHA256SUMS"; fi
  t "same-sums-$3" -- cmp -s "$check/SHA256SUMS" "$ASSETS/SHA256SUMS" ||
    die "SHA256SUMS on $1 is not $ASSETS/SHA256SUMS; upload it to the draft again, then --resume"
  x "notes-$3" -- gh release edit "v$VERSION" -R "$1" --notes-file "$2"
  x "publish-$3" -- gh release edit "v$VERSION" -R "$1" --draft=false ${FLAGS[@]+"${FLAGS[@]}"}
  [ "$(q "published-$3" -- gh release view "v$VERSION" -R "$1" --json isDraft -q .isDraft)" = false ] ||
    die "v$VERSION on $1 is still a draft"
}

stage_publish_private() {
  publish "$PRIVATE_REPO" "$STAGE/notes.md" private
  local tagged
  tagged="$(q tag-sha -- gh api "repos/$PRIVATE_REPO/commits/v$VERSION" -q .sha)"
  [ "$tagged" = "$SHA" ] || die "v$VERSION on $PRIVATE_REPO points at $tagged, not the candidate $SHA"
  state_write "$STAGE/published.sha" "$SHA"
}

# The fleet's update agents find releases on the public feed: asking a host for a version that
# feed does not show leaves it waiting until the rollout's deadline.
fleet_feed_ready() {
  if [ "$MODE" = dry ]; then
    say "    fleet-feed: stop unless v$VERSION is published on $PUBLIC_REPO"
    return 0
  fi
  [ "$(q published-fleet-feed -- gh release view "v$VERSION" -R "$PUBLIC_REPO" --json isDraft -q .isDraft)" = false ] ||
    die "v$VERSION is not published on $PUBLIC_REPO, the feed the fleet's update agents read; publish-public comes first"
}

stage_fleet_m4() {
  fleet_feed_ready
  x fleet-m4 -C "$BUILD" -- python3 -B scripts/studio-fleet/fleet_rollout.py --version "$VERSION" --only m4 --hold-minutes 15
}

stage_fleet_workers() {
  fleet_feed_ready
  x fleet-workers -C "$BUILD" -- python3 -B scripts/studio-fleet/fleet_rollout.py --version "$VERSION" --only workers
}

stage_publish_public() {
  x public-notes -- python3 -B "$TOOLS" public-notes --in "$STAGE/notes.md" --out "$STAGE/notes-public.md" --rules "$PUBLIC_RULES"
  if [ -z "$(q public-tag --may-fail -- git ls-remote --tags "https://github.com/$PUBLIC_REPO.git" "refs/tags/v$VERSION")" ]; then
    reset_public
    # A push that failed after publish.mjs tagged leaves the tag only in the clone, and
    # publish.mjs --tag refuses a tag that exists; the remote has none, so drop the local one.
    if [ -n "$(q public-local-tag -C "$PUBLIC_CLONE" -- git tag -l "v$VERSION")" ]; then
      x public-untag -C "$PUBLIC_CLONE" -- git tag -d "v$VERSION"
    fi
    x mirror-publish -C "$BUILD" -- node scripts/public-mirror/publish.mjs --public "$PUBLIC_CLONE" --ref "$SHA" --tag --push
  fi
  publish "$PUBLIC_REPO" "$STAGE/notes-public.md" public
}

# The pid of the ShipIt that Squirrel.Mac runs from this app's own bundle, when one runs. Matched
# as stage_quit_desktop matches the app: the exact process name, then the exact executable path,
# which no other app's ShipIt has.
desktop_shipit() {
  local pids pid
  pids="$(q shipit-pids --may-fail -- pgrep -x ShipIt)"
  for pid in $pids; do
    if [ "$(q shipit-command --may-fail -- ps -o comm= -p "$pid")" = "$APP/Contents/Frameworks/Squirrel.framework/Resources/ShipIt" ]; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
}

# An old app that saw the public release installs it when it quits. An unsigned build's swap.sh
# (macSwapInstall.ts) moves the old bundle to $APP.studio-update-old, the new one in, then removes
# the old; a signed build updates through Squirrel.Mac (ElectronUpdater), whose ShipIt replaces the
# bundle once the app has quit. Wait up to 60s for either to finish.
desktop_swap_settled() {
  local waited=0 pause=1 shipit
  if [ "$MODE" = dry ]; then
    say "    desktop-settle: wait up to 60s while $APP.studio-update-old exists or the app's own ShipIt runs"
    return 0
  fi
  if [ "$MODE" != real ]; then pause=0; fi
  while :; do
    shipit="$(desktop_shipit)"
    if [ ! -e "$APP.studio-update-old" ] && [ -z "$shipit" ]; then return 0; fi
    if [ $waited -ge 60 ]; then
      [ -z "$shipit" ] ||
        die "the app's own Squirrel.Mac update (ShipIt, pid $shipit) still runs after 60s; let it finish, check $APP and --resume"
      die "$APP.studio-update-old is still there after 60s: the app's own update swap did not finish; check $APP, move the leftover aside and --resume"
    fi
    sleep "$pause"
    waited=$((waited + 1))
  done
}

stage_desktop() {
  local zip="$ASSETS/SpecWithCode-$VERSION-arm64.zip" version current="" grants="$STAGE/desktop-grants.json" probed=0 aside
  stage_quit_desktop
  need_output "$zip" "the signed desktop zip from the sign stage"
  desktop_swap_settled
  # Read once that update is over: it may have just put this release in.
  if [ "$MODE" != dry ]; then
    current="$(q app-version-before --may-fail -- /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
  fi
  if [ "$current" = "$VERSION" ] && t desktop-signed -- codesign --verify --deep --strict "$APP"; then
    # Its own updater already installed this release: a snapshot now would zip the new version and
    # prune the previous version's rollback copy.
    say "desktop: $APP is already $VERSION (the app's own updater swapped it in); keeping it"
  else
    if [ "$current" = "$VERSION" ] || { [ "$MODE" != dry ] && [ -z "$current" ] && [ -d "$APP" ]; }; then
      # Not a whole app: an install cut short, such as an earlier attempt's ditto, either after it
      # wrote Info.plist (it reports this release but fails its signature check) or before (it has
      # no readable version). Moved aside, never deleted, under a name Launch Services does not
      # take for an app; not snapshotted, which would copy it and prune the previous version's
      # rollback copy, and its grants not recorded, which would replace the record that earlier
      # attempt took of the previous app before its swap.
      aside="$APP.partial-$(date -u +%Y%m%dT%H%M%SZ)"
      if [ -n "$current" ]; then
        say "desktop: $APP reports $VERSION but fails its signature check; moving it to $aside and installing again"
      else
        say "desktop: $APP has no readable version (an install cut short); moving it to $aside and installing again"
      fi
      x desktop-aside -- mv "$APP" "$aside"
    elif [ "$MODE" != real ] || [ -d "$APP" ]; then
      # Computer use keeps one Accessibility and Screen Recording grant only while each release
      # satisfies the installed one's designated requirement; record both before the swap.
      x desktop-grants-before -C "$BUILD" -- node scripts/studio-projects/mac-upgrade-grant.mjs before "$APP" "$grants"
      probed=1
      x desktop-backup -C "$BUILD" -- python3 -B scripts/studio-fleet/desktop_backup.py snapshot "$APP"
      x desktop-prune -C "$BUILD" -- python3 -B scripts/studio-fleet/desktop_backup.py prune --keep 1
      x desktop-trash -- osascript -e "tell application \"Finder\" to delete POSIX file \"$APP\""
    fi
    x desktop-install -- ditto -x -k "$zip" "$(dirname "$APP")"
  fi
  x desktop-codesign -- codesign --verify --deep --strict "$APP"
  x desktop-signature -C "$BUILD" -- node scripts/studio-projects/mac-signature.mjs "$APP"
  if [ "$probed" -eq 1 ] || { [ "$MODE" = real ] && [ -f "$grants" ]; }; then
    x desktop-grants -C "$BUILD" -- node scripts/studio-projects/mac-upgrade-grant.mjs after "$APP" "$grants" ||
      die "the new desktop app lost the computer-use grants the previous one had; the previous app is in the desktop_backup.py rollback copy"
  fi
  version="$(q app-version -- /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
  [ "$version" = "$VERSION" ] || die "$APP reports $version after the swap, not $VERSION"
  x desktop-open -- open "$APP"
}

stage_merge() {
  local open merged
  open="$(q pr-open --may-fail -- gh pr list -R "$PRIVATE_REPO" --head "release/$VERSION" --state open --json number -q '.[0].number')"
  if [ -z "$open" ]; then
    merged="$(q pr-merged --may-fail -- gh pr list -R "$PRIVATE_REPO" --head "release/$VERSION" --state merged --json number -q '.[0].number')"
    if [ -n "$merged" ]; then
      say "merge: release/$VERSION already merged (#$merged)"
      return 0
    fi
    x pr-create -- gh pr create -R "$PRIVATE_REPO" --base main --head "release/$VERSION" \
      --title "Release SpecWithCode $VERSION" \
      --body "Version bump and release fixes for SpecWithCode $VERSION, published as v$VERSION from $SHA12."
  fi
  required_checks_settled
  x pr-merge -- gh pr merge "release/$VERSION" -R "$PRIVATE_REPO" --merge
}

# main requires the PR gate checks, which skip release/ branches in seconds. Merging before they
# report is refused, so wait for them: up to 10 minutes, and 2 minutes with none reported (a
# repository with no required checks has nothing to wait for). A failed check stops the merge.
required_checks_settled() {
  local buckets tries=0 empty=0 pause=10
  if [ "$MODE" != real ]; then pause=0; fi
  while :; do
    buckets="$(q pr-required-buckets --may-fail -- gh pr checks "release/$VERSION" -R "$PRIVATE_REPO" --required \
      --json bucket -q '[.[].bucket] | unique | join(" ")')"
    case " $buckets " in
      *" fail "* | *" cancel "*) die "merge: a required check failed on release/$VERSION; see gh pr checks release/$VERSION -R $PRIVATE_REPO" ;;
      *" pending "*) ;;
      "  ")
        empty=$((empty + 1))
        if [ "$empty" -ge 12 ]; then return 0; fi
        ;;
      *) return 0 ;;
    esac
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then die "merge: the required checks on release/$VERSION did not finish in 10 minutes"; fi
    sleep "$pause"
  done
}

# ---------------------------------------------------------------- status and arguments

show_status() {
  local name
  [ -f "$STAGE/release.json" ] || die "no release of $VERSION in $STAGE"
  cat "$STAGE/release.json"
  say "candidate: $(cat "$STAGE/candidate.sha" 2> /dev/null || printf 'none yet')"
  for name in $STAGE_NAMES server; do
    if [ -f "$MARKERS/$name" ]; then say "  done  $name ($(cut -c1-12 < "$MARKERS/$name"))"; else say "  -     $name"; fi
  done
  PREV="$(python3 -B "$TOOLS" json-get "$STAGE/release.json" previous)"
  print_timings
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) MODE=dry ;;
      --resume) RESUME=1 ;;
      --self-test) SELF_TEST=1 ;;
      --status) STATUS=1 ;;
      --allow-project-migrations) MIGRATIONS=1 ;;
      --no-retry) RETRY=0 ;;
      --no-project-migrations) MIGRATIONS=0 ;;
      --ci) CI_MODE=1 ;;
      --previous | --stop-after | --jobs)
        [ $# -ge 2 ] || usage_error "$1 needs a value"
        case "$1" in
          --previous) PREV_OVERRIDE="$2" ;;
          --stop-after) STOP_AFTER="$2" ;;
          --jobs) JOBS="$2" ;;
        esac
        shift
        ;;
      --internal-server)
        [ $# -ge 3 ] || usage_error "--internal-server VERSION SHA"
        INTERNAL_SERVER=1
        VERSION="$2"
        SHA="$3"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*) usage_error "unknown option $1" ;;
      *)
        [ -z "$VERSION" ] || usage_error "give one version"
        VERSION="$1"
        ;;
    esac
    shift
  done
  if [ "$SELF_TEST" -eq 1 ]; then
    [ -z "$VERSION" ] && [ "$MODE" = real ] && [ "$RESUME" -eq 0 ] || usage_error "--self-test takes no other arguments"
    return 0
  fi
  [ -n "$VERSION" ] || usage_error "give the version to release"
  [[ $VERSION =~ $VERSION_RE ]] || usage_error "version must be X.Y.Z, not $VERSION"
  if [ -n "$PREV_OVERRIDE" ] && ! [[ $PREV_OVERRIDE =~ $VERSION_RE ]]; then usage_error "--previous must be X.Y.Z"; fi
  case "$JOBS" in 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) ;; *) usage_error "--jobs must be 1 to 8" ;; esac
  case "$SERVER_SHARDS" in 1 | 2 | 3 | 4 | 5 | 6) ;; *) usage_error "RELEASE_SERVER_SHARDS must be 1 to 6" ;; esac
  case "$RETRY_MAX_JOBS$RETRY_MAX_FILES" in *[!0-9]* | "") usage_error "RELEASE_RETRY_MAX_JOBS and RELEASE_RETRY_MAX_FILES must be numbers" ;; esac
  if [ -n "$STOP_AFTER" ] && ! printf ' %s ' "$STAGE_NAMES" | grep -q " $STOP_AFTER "; then
    usage_error "--stop-after takes one of: $STAGE_NAMES"
  fi
  if [ "$MODE" = dry ] && [ "$RESUME" -eq 1 ]; then usage_error "--dry-run shows a fresh release; drop --resume"; fi
  if [ "${RELEASE_STUB:-}" = 1 ] && [ "$MODE" = real ]; then
    [ -n "${RELEASE_STAGING_ROOT:-}" ] && [ -n "${RELEASE_TREES:-}" ] ||
      usage_error "RELEASE_STUB needs RELEASE_STAGING_ROOT and RELEASE_TREES"
    MODE=stub
  fi
}

main() {
  local stage
  parse_args "$@"
  if [ "$SELF_TEST" -eq 1 ]; then exec bash "$HERE/release-self-test.sh"; fi
  set_paths
  if [ "$STATUS" -eq 1 ]; then
    load_env
    show_status
    exit 0
  fi
  load_env
  if [ "$INTERNAL_SERVER" -eq 1 ]; then internal_server; fi
  trap on_exit EXIT
  if [ "$MODE" = dry ]; then
    say "Dry-run of SpecWithCode $VERSION: every command is printed, nothing runs or is written."
    say "Query results are stand-ins (candidate <candidate>, previous ${PREV_OVERRIDE:-<previous>})."
  fi
  init_state
  say "SpecWithCode $VERSION (previous $PREV), state in $STAGE"
  run_stage preflight always
  run_stage trees always
  run_stage prev once
  run_stage bump once
  resolve_candidate
  run_stage candidate sha
  run_stage stage1 sha
  start_server
  run_stage build sha
  for stage in bundle sign helpers plan drafts; do
    stop_if_server_failed
    run_stage "$stage" sha
  done
  run_stage server-wait sha
  if [ "$CI_MODE" -eq 0 ] && ! is_done desktop once; then run_stage quit-desktop always; fi
  run_stage publish-private once
  run_stage publish-public once
  if [ "$CI_MODE" -eq 0 ]; then
    run_stage fleet-m4 once
    # Right after M4: the app attaches to the M4 service, which now runs this version, so it writes
    # no install request of its own; M1 or M3 failing next no longer leaves the Mac without its app.
    run_stage desktop once
    run_stage fleet-workers once
  else
    say "= fleet-m4, desktop, fleet-workers: skipped (--ci); the hosts install v$VERSION on their next update check"
  fi
  run_stage merge once
  if [ "$MODE" = dry ]; then
    say "Dry-run done: nothing was run or written."
    return 0
  fi
  say "SpecWithCode $VERSION is released."
  print_timings
}

main "$@"
