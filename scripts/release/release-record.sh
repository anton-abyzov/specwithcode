# shellcheck shell=bash
# The release run record and the --stage entry points (increment 1239, phase 5). Sourced by
# release_common.sh (release.sh is at its 1500-line cap); uses release.sh's MODE, VERSION, PREV,
# SHA, STAGE, STAGING_ROOT, STAGE_NAMES, LOG_DIR, MARKERS, CI_MODE, TEST, HERE and its say, die,
# usage_error, x, is_done, mark_done, ensure_dir and state_write.
#
# The record: one file per release run, updates/runs/release-<version>-<runId>.json in M4's home
# (scripts/release/run_record.py; the Releases view in SpecWithCode reads it). The run id is kept in
# the staging folder, so --resume, and every --stage job of .github/workflows/release.yml on the same
# runner, writes the same record and keeps its rows. Each step is recorded as it starts and ends;
# the canary and fleet steps record each machine: fleet_rollout.py as it asks one
# (STUDIO_RELEASE_RUN_RECORD), and its summary once it ends. A record that cannot be written is a
# warning, never a failed release. RELEASE_RUNS_DIR overrides the folder; stub runs default to
# <staging root>/runs, dry runs write nothing.
#
# --stage ID runs only the steps of one stage of the release graph (run_record.py STEP_STAGE maps
# release.sh's steps to the graph's ids), in their usual order, against this machine's staging
# folder; other stages' steps are left as they are. --stage resolve may start a release (with
# --resume too, as every job passes it); any other stage needs one under way. A stage release.sh has
# no step for yet (Windows and Linux builds run in their own workflow) is recorded as skipped. While
# another --stage job holds the release lock, a --stage job waits for it (RELEASE_STAGE_LOCK_WAIT
# seconds, default 7200) instead of failing. --stage test.server --shard N runs shard N of
# RELEASE_GRAPH_SHARDS (8) of the server suite in the foreground, and --shard merge judges every
# shard's result and marks the suite (and server-wait) green for the candidate. Shards only read the
# release state and take no lock, so they can run side by side.

RUN_RECORD_TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run_record.py"
RUN_RECORD="${STUDIO_RELEASE_RUN_RECORD:-}"  # The --internal-server child inherits its parent's.
STAGE_ONLY="" STAGE_STEPS="" SERVER_SHARD="" STAGE_EMPTY=0 STAGE_NEEDS_CHECKED=0
GRAPH_SHARDS="${RELEASE_GRAPH_SHARDS:-8}"
RECORD_STEPS="${STAGE_NAMES:-} server rehearsal"

stage_option() {  # stage_option OPTION VALUE: --stage and --shard from parse_args
  case "$1" in
    --stage) STAGE_ONLY="$2" ;;
    --shard) SERVER_SHARD="$2" ;;
  esac
}

# check_stage_args: at the end of parse_args; the steps --stage selects, or a usage error.
check_stage_args() {
  if [ -n "$SERVER_SHARD" ] && [ "$STAGE_ONLY" != test.server ]; then usage_error "--shard needs --stage test.server"; fi
  [ -n "$STAGE_ONLY" ] || return 0
  case "$GRAPH_SHARDS" in [1-9] | 1[0-2]) ;; *) usage_error "RELEASE_GRAPH_SHARDS must be 1 to 12" ;; esac
  case "$SERVER_SHARD" in
    "" | merge) ;;
    [1-9] | 1[0-2]) [ "$SERVER_SHARD" -le "$GRAPH_SHARDS" ] || usage_error "--shard $SERVER_SHARD is above RELEASE_GRAPH_SHARDS ($GRAPH_SHARDS)" ;;
    *) usage_error "--shard takes 1 to $GRAPH_SHARDS or merge" ;;
  esac
  if [ -n "$STOP_AFTER" ]; then usage_error "--stage runs one stage; drop --stop-after"; fi
  stage_steps
}

# stage_steps: the steps of STAGE_ONLY on this run's channel. Again from stage_entry, once
# channel_init has settled RELEASE_CHANNEL (candidate publishes to GitHub in finalize).
stage_steps() {
  STAGE_STEPS="$(python3 -B "$RUN_RECORD_TOOL" steps --stage "$STAGE_ONLY" --names "$RECORD_STEPS" \
    --channel "${RELEASE_CHANNEL:-github}" 2>&1)" ||
    usage_error "--stage: ${STAGE_STEPS#run_record: }"
  STAGE_EMPTY=0
  if [ -z "$STAGE_STEPS" ]; then STAGE_EMPTY=1; fi
}

# stage_selected STEP: whether this run runs STEP (every step without --stage).
stage_selected() {
  [ -z "$STAGE_ONLY" ] && return 0
  case " $STAGE_STEPS " in *" $1 "*) return 0 ;; esac
  return 1
}

# stage_skip STEP: true (and says so) when --stage leaves STEP out; for run_stage. The first step
# a --stage run does run first checks that the stages it needs are done.
stage_skip() {
  if stage_selected "$1"; then
    stage_needs_check
    return 1
  fi
  if [ -f "$MARKERS/$1" ]; then say "= $1: done"; else say "= $1: not in stage $STAGE_ONLY"; fi
  return 0
}

# begin_background STEP: false when --stage leaves the background STEP (server, rehearsal) out;
# else records it running, unless its process for this candidate (STEP.pid) still runs.
begin_background() {
  local pid="" sha=""
  stage_selected "$1" || return 1
  stage_needs_check
  if [ -f "$STAGE/$1.pid" ]; then read -r pid sha _ < "$STAGE/$1.pid" || true; fi
  if [ -n "$pid" ] && [ "$sha" = "$SHA" ] && kill -0 "$pid" 2> /dev/null; then return 0; fi
  record_step "$1" running
}

# stage_needs_check: once per --stage run, every step of the stages it needs, directly or through
# others (resolve's candidate step for every stage), is done for this candidate (its marker), so a job started out of order stops before it acts. Steps that keep no
# marker (they run every time), steps --ci leaves out and the candidate channel's own steps on
# the github channel are not asked for. Finalize also passes finalize_ready (release-canary.sh).
stage_needs_check() {
  [ -n "$STAGE_ONLY" ] && [ "$STAGE_NEEDS_CHECKED" -eq 0 ] && [ "$MODE" != dry ] || return 0
  STAGE_NEEDS_CHECKED=1
  local steps step key candidate="" missing=""
  candidate="$(cat "$STAGE/candidate.sha" 2> /dev/null || true)"
  steps="$(python3 -B "$RUN_RECORD_TOOL" steps --stage "$STAGE_ONLY" --of-needs --names "$RECORD_STEPS" \
    --channel "${RELEASE_CHANNEL:-github}")" || die "--stage $STAGE_ONLY: could not read the release graph"
  for step in $steps; do
    case " preflight trees quit-desktop " in *" $step "*) continue ;; esac
    if [ "$CI_MODE" -eq 1 ]; then case " fleet-m4 desktop fleet-workers fleet-linux rehearsal " in *" $step "*) continue ;; esac; fi
    # The github channel has no candidate feed, soak or promotion (release_tail).
    if [ "${RELEASE_CHANNEL:-github}" != candidate ]; then case " publish-candidate canary-soak promote-stable " in *" $step "*) continue ;; esac; fi
    key="$(cat "$MARKERS/$step" 2> /dev/null || true)"
    if [ -z "$key" ] || { [ "$key" != once ] && [ "$key" != "$candidate" ]; }; then missing="$missing $step"; fi
  done
  [ -z "$missing" ] || die "--stage $STAGE_ONLY: the stages it needs are not done for this candidate (missing:$missing)"
}

# stage_candidate_check: from resolve_candidate. Only --stage resolve sets or changes the candidate;
# any other --stage job stops when the build tree is not at candidate.sha, before it pushes,
# rewrites candidate.sha or stops the server suite.
stage_candidate_check() {
  [ -n "$STAGE_ONLY" ] && [ "$STAGE_ONLY" != resolve ] || return 0
  local candidate
  candidate="$(cat "$STAGE/candidate.sha" 2> /dev/null || true)"
  [ -n "$candidate" ] || die "--stage $STAGE_ONLY: no candidate for $VERSION yet; run --stage resolve first"
  [ "$SHA" = "$candidate" ] ||
    die "--stage $STAGE_ONLY: $BUILD is at $SHA12, not the candidate $(printf '%s' "$candidate" | cut -c1-12); only --stage resolve takes a new candidate"
}

# stage_note STAGE: why release.sh has no step of its own for STAGE.
stage_note() {
  case "$1" in
    test.web | test.fleet | test.desktop-e2e) say "runs inside test.unit (release.sh stage1)" ;;
    build.windows | build.linux | verify.windows | verify.linux) say "desktop-windows-linux.yml builds and checks it after publish-public" ;;
    *) say "release.sh has no step for it yet" ;;
  esac
}

# stage_init_ok: init_state may start a release under --resume (the first job of the graph).
stage_init_ok() { [ "$STAGE_ONLY" = resolve ]; }

# stage_lock_wait: true after a wait when another --stage job holds the lock and may be retried.
stage_lock_wait() {
  [ -n "$STAGE_ONLY" ] || return 1
  local waited="${STAGE_LOCK_WAITED:-0}" limit="${RELEASE_STAGE_LOCK_WAIT:-7200}"
  [ "$waited" -lt "$limit" ] || return 1
  if [ "$waited" -eq 0 ] || [ $((waited % 300)) -eq 0 ]; then say "--stage $STAGE_ONLY: waiting for the release lock ($STAGE/lock)"; fi
  sleep 1
  STAGE_LOCK_WAITED=$((waited + 1))
}

record_init() {
  if [ "$MODE" = dry ]; then
    RUN_RECORD=""
    return 0
  fi
  local runs="${RELEASE_RUNS_DIR:-}" by=release.sh out steps="$RECORD_STEPS" step
  if [ -z "$runs" ]; then
    if [ "$MODE" = stub ]; then runs="$STAGING_ROOT/runs"; else runs="$HOME/.specwithcode/m4/updates/runs"; fi
  fi
  if [ -n "${GITHUB_RUN_ID:-}" ]; then by=release.yml; fi
  if [ "${RELEASE_CHANNEL:-github}" != candidate ]; then  # Steps only the candidate channel has.
    steps=""
    for step in $RECORD_STEPS; do
      case " publish-candidate canary-soak promote-stable " in *" $step "*) ;; *) steps="$steps $step" ;; esac
    done
  fi
  if ! out="$(python3 -B "$RUN_RECORD_TOOL" init --dir "$runs" --version "$VERSION" --id-file "$STAGE/run-id" \
    --steps "$steps" --previous "$PREV" --created-by "$by" --channel "${RELEASE_CHANNEL:-github}" 2>&1)"; then
    say "(run record unavailable: ${out#run_record: })"
    RUN_RECORD=""
    return 0
  fi
  RUN_RECORD="$out"
  STUDIO_RELEASE_RUN_RECORD="$RUN_RECORD"
  export STUDIO_RELEASE_RUN_RECORD
  # --ci leaves the fleet and the rehearsal to the machines' own update checks.
  if [ "${CI_MODE:-0}" -eq 1 ]; then record_skipped quit-desktop fleet-m4 desktop fleet-workers fleet-linux rehearsal; fi
}

# record_step STEP STATE [LOG] [--shard N | --fact K=V ...]: best effort; logs are kept relative to
# the staging root.
record_step() {
  [ -n "$RUN_RECORD" ] || return 0
  local name="$1" state="$2" log=()
  shift 2
  if [ -n "${1:-}" ]; then log=(--log "${1#"$STAGING_ROOT"/}"); fi
  [ $# -eq 0 ] || shift
  python3 -B "$RUN_RECORD_TOOL" step --file "$RUN_RECORD" --name "$name" --state "$state" ${log[@]+"${log[@]}"} "$@" \
    > /dev/null 2>&1 || say "(run record: $name $state not written)"
}

record_skipped() {  # record_skipped STEP...: steps this run leaves out
  local step
  for step in "$@"; do record_step "$step" skipped; done
}

# record_timed STEP ok|failed: from record_timing, which every finished step passes through.
record_timed() {
  local state=passed log="$LOG_DIR/$1.log"
  if [ "$2" != ok ]; then state=failed; fi
  [ -f "$log" ] || log=""
  record_step "$1" "$state" "$log"
}

# record_rollout STEP LOG: the machines of fleet_rollout.py's summary, the last JSON line of the
# step's latest attempt in LOG (a failed rollout that named no machine adds none).
record_rollout() {
  [ -n "$RUN_RECORD" ] || return 0
  local role
  case "$1" in
    fleet-m4) role=canary ;;
    fleet-workers) role=fleet ;;
    *) return 0 ;;
  esac
  [ -f "$2" ] || return 0
  awk '/^===== .* attempt /{ out = "" } { out = out $0 "\n" } END { printf "%s", out }' "$2" |
    python3 -B "$RUN_RECORD_TOOL" rollout --file "$RUN_RECORD" --summary - --role "$role" > /dev/null 2>&1 || true
}

# record_finish RC: from on_exit. Done once merged, failed on an error, held when a whole run
# stopped early (--stop-after); a --stage job leaves the run running for the next job.
record_finish() {
  [ -n "$RUN_RECORD" ] || return 0
  local state=""
  if [ "$1" -ne 0 ]; then
    state=failed
  elif is_done merge once && { [ -z "$STAGE_ONLY" ] || stage_selected merge; }; then
    state=done
  elif [ -z "$STAGE_ONLY" ]; then
    state=held
  fi
  [ -n "$state" ] || return 0
  python3 -B "$RUN_RECORD_TOOL" finish --file "$RUN_RECORD" --state "$state" > /dev/null 2>&1 ||
    say "(run record: not finished)"
}

# stage_entry: from main, before init_state. --shard and a stage with no release.sh step end here.
stage_entry() {
  [ -n "$STAGE_ONLY" ] || return 0
  stage_steps
  if [ -n "$SERVER_SHARD" ]; then server_shard_main; fi
  [ "$STAGE_EMPTY" -eq 1 ] || return 0
  stage_state_ready
  local note
  note="$(stage_note "$STAGE_ONLY")"
  if [ "$MODE" != dry ]; then
    record_init
    record_step "$STAGE_ONLY" skipped "" --fact "note=$note"
  fi
  say "= $STAGE_ONLY: skipped; $note"
  exit 0
}

# stage_state_ready: a release of VERSION under way here; sets PREV.
stage_state_ready() {
  if [ "$MODE" = dry ]; then
    PREV="${PREV_OVERRIDE:-<previous>}"
    return 0
  fi
  [ -f "$STAGE/release.json" ] || die "--stage $STAGE_ONLY: no release of $VERSION in $STAGE; run --stage resolve first"
  PREV="$(python3 -B "$TOOLS" json-get "$STAGE/release.json" previous)" ||
    die "$STAGE/release.json names no previous release"
}

# server_shard_main: --stage test.server --shard N|merge. Exits.
server_shard_main() {
  stage_state_ready
  if [ "$MODE" = dry ]; then
    SHA="<candidate>"
  else
    SHA="$(cat "$STAGE/candidate.sha" 2> /dev/null || true)"
  fi
  if [ "$MODE" != dry ] && { [ -z "$SHA" ] || ! is_done candidate "$SHA"; }; then
    die "--shard: the candidate step is not done for $VERSION; run --stage resolve first"
  fi
  SHA12="$(printf '%s' "$SHA" | cut -c1-12)"
  CURRENT_STAGE=server
  record_init
  trap 'record_finish "$?"' EXIT  # A failed shard or merge fails the run.
  local out="$STAGE/server/graph-$SHA12" rc=0 n dirs=()
  if [ "$SERVER_SHARD" = merge ]; then
    if [ "$MODE" = dry ]; then
      x server-merge -C "$TEST" -- node scripts/release/test-sharded.mjs --merge "$out/shard-1..$GRAPH_SHARDS"
      exit 0
    fi
    for n in $(seq 1 "$GRAPH_SHARDS"); do if [ -d "$out/shard-$n" ]; then dirs+=("$out/shard-$n"); fi; done
    if [ ${#dirs[@]} -ne "$GRAPH_SHARDS" ]; then
      record_step server failed
      die "--shard merge: ${#dirs[@]} of $GRAPH_SHARDS shard results in $out"
    fi
    x server-merge -C "$TEST" -- node scripts/release/test-sharded.mjs --merge "${dirs[@]}" || rc=$?
    if [ "$rc" -ne 0 ]; then
      record_step server failed
      state_write "$STAGE/server.exit" "$SHA $rc"
      die "the server suite failed for $SHA12 (merge exit $rc); see the shard jobs' logs"
    fi
    mark_done server "$SHA"
    mark_done server-wait "$SHA"
    state_write "$STAGE/green-server.sha" "$SHA"
    state_write "$STAGE/server.exit" "$SHA 0"
    record_step server passed
    record_step server-wait passed
    say "server: green for $SHA12 ($GRAPH_SHARDS shards)"
    exit 0
  fi
  if [ "$MODE" != dry ]; then
    ensure_dir "$out"
    rm -rf "${out:?}/shard-$SERVER_SHARD"
    rm -f "$STAGE/server.exit"  # A new shard run: an earlier run's verdict no longer stands.
    # The test tree is the candidate's (the candidate step checks it out); shards never move it.
    [ "$(q sha -C "$TEST" -- git rev-parse HEAD)" = "$SHA" ] || die "--shard: $TEST is not at the candidate $SHA12"
    if [ "$MODE" != stub ]; then playwright_shell; fi
  fi
  record_shard running
  # The suite never needs the release's GitHub token, as in stage_server.
  x server-shard -C "$TEST" -- env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
    CI=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    node scripts/release/test-sharded.mjs --shards "$GRAPH_SHARDS" --run "$SERVER_SHARD" --out "$out/shard-$SERVER_SHARD" || rc=$?
  if [ "$MODE" = stub ] && [ "$rc" -eq 0 ]; then ensure_dir "$out/shard-$SERVER_SHARD"; fi
  if [ "$rc" -eq 0 ]; then record_shard passed; else record_shard failed; fi
  exit "$rc"
}

record_shard() {  # record_shard STATE: this shard's; test.server keeps running until the merge
  record_step server "$1" "" --shard "$SERVER_SHARD"
}
