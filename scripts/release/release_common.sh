#!/bin/bash
# Sourced by release.sh after it establishes SELF/HERE and shared state. Functions only.
# Keep paths tied to release.sh, not this file: the release runner may use a script snapshot.

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
  # All publish/merge markers are durable and our lock is gone. The helper takes its own
  # lock; a racing --resume wins safely. Keep evidence, discard rebuilt runtime payloads.
  if [ "$rc" -eq 0 ] && [ "$LOCKED" -eq 1 ] && is_done merge once; then
    x staging-finished -- python3 -B "$HERE/staging_retention.py" --root "$STAGING_ROOT" \
      --finished --apply || say "(completed staging cleanup deferred)"
  fi
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
    holder="$(cat "$STAGE/lock/pid" 2> /dev/null || true)"
    # mkdir and writing pid are separate syscalls. A missing/partial record can belong to
    # a runner or cleanup that just acquired the lock; never steal that starting operation.
    if ! [[ $holder =~ ^[1-9][0-9]*$ ]]; then die "release.sh $VERSION lock is starting or unreadable; refusing takeover"; fi
    if kill -0 "$holder" 2> /dev/null; then die "release.sh $VERSION already runs (pid $holder)"; fi
    # A dead holder still requires review: deleting and recreating a shared lock can race a
    # second recovery. No release or cleanup reaps another owner's lock automatically.
    die "release.sh $VERSION has a stale lock (pid $holder); review and remove that lock before resuming"
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

