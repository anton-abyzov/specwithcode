# shellcheck shell=bash
# Sourced by release-self-test.sh (at its 1500-line cap) for increment 1239, phase 5: the run record
# every release writes (updates/runs/release-<version>-<runId>.json, here under the stub staging
# root), resume keeping its rows, --stage running one stage of the release graph in order (and
# refusing one whose needs are not done), the 8 server shards and their merge, the lock wait of a
# --stage job, and .github/workflows/release.yml expressing the same graph. Uses the self-test's
# check, run, has, lacks, make_machine, use_machine, stub_set, stages_after, lines and WORK.

record_file() {  # record_file: this staging folder's run record
  printf '%s/runs/release-%s-%s.json\n' "$STAGING" "$1" "$(cat "$STAGE/run-id" 2> /dev/null)"
}

# record_ok VERSION PYTHON-EXPRESSION: the expression holds for the record (r, stages, hosts, steps).
record_ok() {
  python3 -B - "$(record_file "$1")" "$2" >> "$LAST_OUT" 2>&1 << 'PY'
import json, sys
r = json.load(open(sys.argv[1]))
stages = {stage['id']: stage for stage in r['stages']}
hosts = {host['identity']: host for host in r['hosts']}
steps = {step['name']: step for stage in r['stages'] for step in stage['steps']}
ok = eval('(' + sys.argv[2] + ')')
if not ok:
    print('record:', r['state'], [(stage['id'], stage['state']) for stage in r['stages']], r['hosts'])
sys.exit(0 if ok else 1)
PY
}

records_in() { find "$STAGING/runs" -name 'release-*.json' -type f 2> /dev/null | wc -l | tr -d ' '; }

R="$WORK/record"
make_machine "$R"
use_machine "$R" 1.8.0
printf '%s\n' 'fleet_rollout: m4: asked to install 1.8.0' \
  '{"version": "1.8.0", "result": "installed", "hosts": {"m4": {"result": "installed", "receipt": "updates/receipts/update-1.8.0.json"}}}' > "$WORK/m4-summary.txt"
printf '%s\n' '{"version": "1.8.0", "result": "partial", "hosts": {"m1": {"result": "installed", "desktopApp": {"result": "swapped"}}, "m3": {"result": "not-updated", "reason": "busy: 2 windows elapsed"}}}' > "$WORK/workers-summary.txt"
summaries() { STUB_ENV+=(RELEASE_STUB_STDOUT="fleet-m4=$WORK/m4-summary.txt fleet-workers=$WORK/workers-summary.txt" GITHUB_RUN_ID=); }
summaries
record_written() {
  run 0 1.8.0 || return 1
  [ "$(records_in)" = 1 ] && [ "$(stat -f %Lp "$(record_file 1.8.0)")" = 600 ] || return 1
  record_ok 1.8.0 "r['kind'] == 'release' and r['schemaVersion'] == 1 and r['state'] == 'done' and r['endedAt']
    and r['createdBy'] == 'release.sh' and r['version'] == '1.8.0' and r['previous'] == '1.1.0'
    and len(stages) == 19 and all(stages[s]['state'] == 'passed' for s in ('resolve', 'preflight', 'test.unit',
    'test.server', 'test.migration', 'build.mac', 'verify.mac', 'publish.candidate', 'canary', 'fleet', 'finalize'))
    and steps['preflight']['log'] == '1.8.0/logs/preflight.log' and steps['server']['state'] == 'passed'
    and all(stages[s]['startedAt'] and stages[s]['endedAt'] for s in ('resolve', 'canary', 'finalize'))"
}
check 'a release writes one run record: kind release, every stage it ran passed, with times and logs' record_written
record_hosts() {
  record_ok 1.8.0 "hosts['m4']['role'] == 'canary' and hosts['m4']['state'] == 'verified'
    and hosts['m4']['receipt'] == 'updates/receipts/update-1.8.0.json'
    and hosts['m1']['role'] == 'fleet' and hosts['m1']['state'] == 'verified' and hosts['m1']['desktop'] == 'swapped'
    and hosts['m3']['state'] == 'not-updated' and 'busy: 2 windows elapsed' in hosts['m3']['reason']
    and all(hosts[h]['required'] for h in ('m4', 'm1', 'm3')) and [h['identity'] for h in r['hosts']] == ['m4', 'm1', 'm3']"
}
check 'the canary and fleet rollouts record each machine: verified, or not updated with its reason' record_hosts

use_machine "$R" 1.8.1
summaries
stub_set RELEASE_STUB_FAIL=sign
record_resumed() {
  local first
  run 1 1.8.1 || return 1
  record_ok 1.8.1 "r['state'] == 'failed' and stages['build.mac']['state'] == 'failed' and steps['sign']['state'] == 'failed'
    and stages['test.unit']['state'] == 'passed' and stages['canary']['state'] == 'pending'" || return 1
  first="$(python3 -B -c 'import json, sys; r = json.load(open(sys.argv[1])); print(r["runId"], [s for t in r["stages"] for s in t["steps"] if s["name"] == "stage1"][0]["startedAt"])' "$(record_file 1.8.1)")"
  stub_set RELEASE_STUB_FAIL=
  run 0 1.8.1 --resume || return 1
  [ "$(find "$STAGING/runs" -name 'release-1.8.1-*.json' | wc -l | tr -d ' ')" = 1 ] || return 1
  record_ok 1.8.1 "r['state'] == 'done' and r['resumes'] == 1 and r['resumedAt']
    and '%s %s' % (r['runId'], steps['stage1']['startedAt']) == '$first'
    and steps['sign']['state'] == 'passed' and steps['sign']['attempt'] == 2 and stages['build.mac']['state'] == 'passed'
    and len(r['hosts']) == 3"
}
check 'a resume reopens the same run record and keeps the rows of what already passed' record_resumed

# ---------------------------------------------------------------- --stage, in the graph's order

use_machine "$R" 1.8.2
summaries
stage_graph_runs() {
  local from n stage
  run 1 1.8.2 --stage canary --resume && has 'nothing to resume' || return 1
  from="$(lines)"
  run 0 1.8.2 --stage resolve --resume || return 1
  [ "$(stages_after "$from")" = "prev bump candidate " ] || { stages_after "$from" >> "$LAST_OUT"; return 1; }
  run 1 1.8.2 --stage canary --resume && has 'the stages it needs are not done for this candidate' || return 1
  run 1 1.8.2 --stage test.server --shard merge --resume && has '0 of 8 shard results' || return 1
  for stage in preflight test.unit; do run 0 1.8.2 --stage "$stage" --resume || return 1; done
  for n in 1 2 3 4 5 6 7; do run 0 1.8.2 --stage test.server --shard "$n" --resume || return 1; done
  run 1 1.8.2 --stage test.server --shard merge --resume && has '7 of 8 shard results' || return 1
  run 0 1.8.2 --stage test.server --shard 8 --resume || return 1
  record_ok 1.8.2 "[s['state'] for s in stages['test.server']['shards']] == ['passed'] * 8
    and stages['test.server']['state'] == 'running'" || return 1
  run 0 1.8.2 --stage test.server --shard merge --resume && has 'green for' || return 1
  [ "$(grep -c $'\tserver-shard\t' "$STUB_LOG")" = 8 ] && grep -q $'\tserver-merge\t.*--merge' "$STUB_LOG" || return 1
  run 0 1.8.2 --stage test.web --resume && has 'runs inside test.unit' || return 1
  for stage in test.migration build.mac; do run 0 1.8.2 --stage "$stage" --resume || return 1; done
  from="$(lines)"
  run 0 1.8.2 --stage verify.mac --resume && has 'Stage verify.mac of 1.8.2: done.' || return 1
  [ "$(stages_after "$from")" = "verify " ] || { stages_after "$from" >> "$LAST_OUT"; return 1; }
  for stage in build.windows publish.candidate canary fleet finalize verify.release; do
    run 0 1.8.2 --stage "$stage" --resume || return 1
  done
  [ "$(records_in)" = 3 ] || return 1
  record_ok 1.8.2 "r['state'] == 'done' and stages['test.server']['state'] == 'passed'
    and stages['test.web']['state'] == 'skipped' and stages['build.windows']['state'] == 'skipped'
    and 'desktop-windows-linux.yml' in stages['build.windows']['facts']['note']
    and all(stages[s]['state'] == 'passed' for s in ('resolve', 'preflight', 'test.unit', 'test.migration',
      'build.mac', 'verify.mac', 'publish.candidate', 'canary', 'fleet', 'finalize', 'verify.release'))
    and steps['server-wait']['state'] == 'passed' and len(hosts) == 3"
}
check '--stage runs one graph stage at a time, refuses one whose needs are not done, and shards merge' stage_graph_runs
verify_release_refuses() {
  stub_set RELEASE_STUB_OUTPUT=release-merged=diverged
  run 1 1.8.2 --stage verify.release --resume && has 'v1.8.2 is not shipped: merged(diverged)' || return 1
  stub_set RELEASE_STUB_OUTPUT=
  record_ok 1.8.2 "r['state'] == 'failed' and stages['verify.release']['state'] == 'failed'
    and 'merged(diverged)' in stages['verify.release']['facts']['missing']" || return 1
  stub_set RELEASE_STUB_OUTPUT=release-assets=SHA256SUMS
  run 1 1.8.2 --stage verify.release --resume && has 'v1.8.2 is not shipped: studio-update.json dmg' || return 1
  stub_set RELEASE_STUB_OUTPUT=release-draft=true
  run 1 1.8.2 --stage verify.release --resume && has 'private-release(true)' && has 'public-release(true)' || return 1
  stub_set RELEASE_STUB_OUTPUT=
  run 0 1.8.2 --stage verify.release --resume || return 1
  record_ok 1.8.2 "r['state'] == 'done' and stages['verify.release']['state'] == 'passed'"
}
check 'verify.release fails the run when v<version> is not published on both repositories and on main, and a passing re-run finishes it done' verify_release_refuses
verify_release_dry() {
  local before
  before="$(find "$STAGING" -type f | wc -l | tr -d ' ')"
  run 0 1.8.2 --stage verify.release --dry-run && has 'Dry-run done: nothing was run or written.' || return 1
  [ "$(find "$STAGING" -type f | wc -l | tr -d ' ')" = "$before" ]
}
check 'a dry run of verify.release prints its checks and writes nothing' verify_release_dry
stage_markers_kept() {
  [ -f "$STAGE/markers/server" ] && [ -f "$STAGE/markers/server-wait" ] && [ -f "$STAGE/markers/merge" ] &&
    [ "$(cat "$STAGE/green-server.sha")" = "$SHA_A" ]
}
check 'the shard merge marks the server suite and server-wait green for the candidate' stage_markers_kept

verify_release_needs() {
  use_machine "$R" 1.8.9
  run 0 1.8.9 --stage resolve --resume || return 1
  run 1 1.8.9 --stage verify.release --resume && has 'the stages it needs are not done for this candidate'
}
check 'verify.release refuses to run before the stages it needs are done' verify_release_needs

# The candidate channel (release-canary.sh): publish.candidate publishes to R2 only, the canary
# installs and soaks on M4, the fleet follows, and only then does finalize publish to GitHub.
use_machine "$R" 1.8.5
printf 'CLOUDFLARE_R2_ACCOUNT_ID=acct\nCLOUDFLARE_R2_ACCESS_KEY_ID=key-id\nCLOUDFLARE_R2_SECRET_ACCESS_KEY=stub\n' > "$R/secrets/r2.env"
chmod 600 "$R/secrets/r2.env"
STUB_ENV+=(RELEASE_CHANNEL=candidate RELEASE_R2_BUCKET=studio-releases RELEASE_CHANNEL_SINCE=1.0.190
  RELEASE_R2_ENV_FILE="$R/secrets/r2.env" GITHUB_RUN_ID=)
labels_after() { awk -F '\t' -v from="$1" 'NR > from && $3 != "FAILED (stub)" { printf "%s ", $2 }' "$STUB_LOG"; }
stage_candidate_channel() {
  local from n stage labels
  run 0 1.8.5 --stage resolve --resume || return 1
  for stage in preflight test.unit; do run 0 1.8.5 --stage "$stage" --resume || return 1; done
  for n in 1 2 3 4 5 6 7 8 merge; do run 0 1.8.5 --stage test.server --shard "$n" --resume || return 1; done
  for stage in test.migration build.mac verify.mac; do run 0 1.8.5 --stage "$stage" --resume || return 1; done
  from="$(lines)"
  run 0 1.8.5 --stage publish.candidate --resume || return 1
  labels="$(labels_after "$from")"
  case "$labels" in *publish-candidate*) ;; *) printf 'publish.candidate: %s\n' "$labels" >> "$LAST_OUT"; return 1 ;; esac
  case "$labels" in *draft=false* | *fleet_rollout* | *promote*) return 1 ;; esac
  [ -f "$STAGE/markers/publish-candidate" ] && [ ! -f "$STAGE/markers/publish-public" ] || return 1
  run 1 1.8.5 --stage finalize --resume && has 'finalize needs fleet-m4 done first' &&
    [ ! -f "$STAGE/markers/publish-private" ] || return 1
  run 1 1.8.5 --stage fleet --resume && has 'missing: fleet-m4 desktop canary-soak' || return 1
  from="$(lines)"
  run 0 1.8.5 --stage canary --resume || return 1
  [ -f "$STAGE/markers/canary-soak" ] && [ ! -f "$STAGE/markers/fleet-workers" ] && [ ! -f "$STAGE/markers/publish-public" ] || return 1
  case "$(labels_after "$from")" in *canary-soak*) ;; *) return 1 ;; esac
  run 1 1.8.5 --stage finalize --resume && has 'finalize needs fleet-workers done first' &&
    [ ! -f "$STAGE/markers/publish-private" ] || return 1
  from="$(lines)"
  run 0 1.8.5 --stage fleet --resume && [ -f "$STAGE/markers/fleet-workers" ] && [ ! -f "$STAGE/markers/publish-public" ] || return 1
  # Linux workers read the public feed: fleet-linux waits for finalize, after publish-public and merge.
  [ ! -f "$STAGE/markers/fleet-linux" ] || { printf 'fleet ran fleet-linux\n' >> "$LAST_OUT"; return 1; }
  case " $(labels_after "$from")" in *" fleet-linux "*) printf 'fleet ran fleet-linux\n' >> "$LAST_OUT"; return 1 ;; esac
  from="$(lines)"
  run 0 1.8.5 --stage finalize --resume || return 1
  [ -f "$STAGE/markers/promote-stable" ] && [ -f "$STAGE/markers/merge" ] && [ -f "$STAGE/markers/fleet-linux" ] || return 1
  labels="$(labels_after "$from")"
  case "$labels" in *fleet_rollout* | *canary-soak*) return 1 ;; esac
  # fleet-linux comes last, after publish-public and the merge (staging-finished is cleanup).
  case " $labels" in *" publish-public "*" pr-merge "*" fleet-linux staging-finished ") ;;
    *) printf 'finalize: %s\n' "$labels" >> "$LAST_OUT"; return 1 ;; esac
  record_ok 1.8.5 "r['state'] == 'done' and r['channel'] == 'candidate'
    and [s['name'] for s in stages['publish.candidate']['steps']] == ['helpers', 'plan', 'drafts', 'publish-candidate']
    and 'canary-soak' in [s['name'] for s in stages['canary']['steps']]
    and [s['name'] for s in stages['finalize']['steps']] == ['publish-private', 'publish-public', 'promote-stable', 'merge', 'fleet-linux']
    and [s['name'] for s in stages['fleet']['steps']] == ['fleet-workers']
    and all(stages[s]['state'] == 'passed' for s in ('publish.candidate', 'canary', 'fleet', 'finalize'))
    and stages['finalize']['startedAt'] >= stages['fleet']['endedAt'] >= stages['canary']['endedAt']"
}
check 'on the candidate channel --stage runs publish.candidate, canary, fleet, then finalize; finalize refuses before fleet' stage_candidate_channel

STUB_ENV=(HOME="$ARGS_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES=)
stage_arguments() {
  run 2 1.2.0 --shard 1 && has '--shard needs --stage test.server' || return 1
  run 2 1.2.0 --stage test.server --shard 9 && has '--shard 9 is above RELEASE_GRAPH_SHARDS (8)' || return 1
  STUB_ENV+=(RELEASE_GRAPH_SHARDS=4)
  run 2 1.2.0 --stage test.server --shard 6 && has '--shard 6 is above RELEASE_GRAPH_SHARDS (4)' || return 1
  STUB_ENV=("${STUB_ENV[@]:0:${#STUB_ENV[@]}-1}")
  run 2 1.2.0 --stage test.server --shard first || return 1
  run 2 1.2.0 --stage nowhere && has "stage 'nowhere' is not one of" || return 1
  run 2 1.2.0 --stage canary --stop-after merge && has '--stage runs one stage' || return 1
  run 2 1.2.0 --stage || return 1
}
check '--stage and --shard refuse unknown stages, shards above 8 and --stop-after' stage_arguments

# The whole run's suite (test-sharded.mjs without --run) takes 1 to 6 shards; only CI jobs, each
# running one shard with --run, split it 8 ways. release.sh refuses what the runner would.
shard_caps_match() {
  local out="$WORK/shard-cap"
  node "$REPO_ROOT/scripts/release/test-sharded.mjs" --shards 7 --out "$out" > "$LAST_OUT" 2>&1 && return 1
  has '--shards must be an integer from 1 to 6' || return 1
  node "$REPO_ROOT/scripts/release/test-sharded.mjs" --shards 8 --run 9 --out "$out" > "$LAST_OUT" 2>&1 && return 1
  has 'from 1 to 8' || return 1
  STUB_ENV=(HOME="$ARGS_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_SERVER_SHARDS=7)
  run 2 1.2.0 && has 'RELEASE_SERVER_SHARDS must be 1 to 6'
}
check "release.sh's server shard limit is the sharded runner's: 6 in one run, 8 only as --run jobs" shard_caps_match

use_machine "$R" 1.8.4
stage_candidate_fixed() {
  local from rc=0
  run 0 1.8.4 --stage resolve --resume || return 1
  rm -f "$STAGE/markers/candidate"
  run 1 1.8.4 --stage build.mac --resume && has 'missing: candidate' || rc=1
  printf '%s\n' "$SHA_A" > "$STAGE/markers/candidate"
  stub_set RELEASE_STUB_SHA="$SHA_B"
  from="$(lines)"
  run 1 1.8.4 --stage preflight --resume && has 'only --stage resolve takes a new candidate' || rc=1
  if awk -F '\t' -v from="$from" 'NR > from && $2 == "push-candidate"' "$STUB_LOG" | grep -q .; then rc=1; fi
  [ "$(cat "$STAGE/candidate.sha")" = "$SHA_A" ] || rc=1
  stub_set RELEASE_STUB_SHA="$SHA_A"
  return "$rc"
}
check 'only --stage resolve takes a new candidate, and every stage needs its candidate marker' stage_candidate_fixed
stage_ignores_stale_server() {
  local from
  for stage in preflight test.unit; do run 0 1.8.4 --stage "$stage" --resume || return 1; done
  printf '%s 1\n' "$SHA_A" > "$STAGE/server.exit"  # An earlier run's failed suite, same candidate.
  from="$(lines)"
  run 0 1.8.4 --stage build.mac --resume || return 1
  ! awk -F '\t' -v from="$from" 'NR > from && $2 == "drop-draft"' "$STUB_LOG" | grep -q . &&
    [ -f "$STAGE/markers/sign" ]
}
check 'a --stage job neither stops on nor drops drafts for a server result an earlier run left' stage_ignores_stale_server

use_machine "$R" 1.8.3
stage_lock_waits() {
  local holder rc=0
  run 0 1.8.3 --stage resolve --resume || return 1
  mkdir "$STAGE/lock"
  sleep 30 &
  holder=$!
  printf '%s\n' "$holder" > "$STAGE/lock/pid"
  STUB_ENV+=(RELEASE_STAGE_LOCK_WAIT=2)
  run 1 1.8.3 --resume && has 'already runs' && lacks 'waiting for the release lock' || rc=1
  run 1 1.8.3 --stage preflight --resume && has 'waiting for the release lock' && has 'already runs' || rc=1
  kill "$holder" 2> /dev/null || true
  wait "$holder" 2> /dev/null || true
  (
    sleep 2
    rm -rf "$STAGE/lock"
  ) &
  holder=$!
  printf '%s\n' "$holder" > "$STAGE/lock/pid"
  stub_set RELEASE_STAGE_LOCK_WAIT=30
  run 0 1.8.3 --stage preflight --resume && has 'waiting for the release lock' || rc=1
  wait "$holder" 2> /dev/null || true
  return "$rc"
}
check 'a --stage job waits for the release lock another job holds; a whole run still refuses at once' stage_lock_waits

# ---------------------------------------------------------------- the workflow

# yaml_json <file>: the YAML file as JSON, with whichever parser this Mac has: PyYAML, the system
# Ruby's Psych, or the scripts package's yaml. The PR gate runs with no Python packages and no
# node_modules; with none of them the check fails rather than being skipped.
yaml_json() {
  python3 -B -c 'import json, sys, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))' "$1" 2> /dev/null && return 0
  ruby -ryaml -rjson -e 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))' "$1" 2> /dev/null && return 0
  node -e 'const r = require("module").createRequire(process.argv[2]); console.log(JSON.stringify(r("yaml").parse(require("fs").readFileSync(process.argv[1], "utf8"))))' \
    "$1" "$REPO_ROOT/scripts/package.json" 2> /dev/null && return 0
  echo "no YAML parser (PyYAML, ruby or the scripts package's yaml) to read $1" >&2
  return 1
}

workflow_graph() {
  local graph_json stage_json
  graph_json="$(yaml_json "$REPO_ROOT/.github/workflows/release.yml")" || { echo 'release.yml unreadable' > "$LAST_OUT"; return 1; }
  stage_json="$(yaml_json "$REPO_ROOT/.github/workflows/release-stage.yml")" || { echo 'release-stage.yml unreadable' > "$LAST_OUT"; return 1; }
  python3 -B - "$graph_json" "$stage_json" \
    "$(python3 -B "$HERE/run_record.py" graph)" > "$LAST_OUT" 2>&1 << 'PY'
import json, sys
workflow = json.loads(sys.argv[1])
stage_workflow = json.loads(sys.argv[2])
graph = {stage: set(needs) for stage, needs in json.loads(sys.argv[3])}
jobs = dict(workflow['jobs'])
# The one job outside the graph: provenance for the published macOS files (attest-macos.yml).
attest = jobs.pop('attest_macos')
assert attest['uses'] == './.github/workflows/attest-macos.yml', attest
assert attest['needs'] == ['verify_release'] and attest['if'] == '${{ !inputs.dry_run }}', attest
assert 'secrets' not in attest, attest
stage_of = {}
for name, job in jobs.items():
    assert job.get('uses') == './.github/workflows/release-stage.yml', (name, job.get('uses'))
    stage_of[name] = job['with']['stage']
    assert name == job['with']['stage'].replace('.', '_').replace('-', '_') + ('_merge' if job['with'].get('shard') == 'merge' else ''), name
by_stage = {}
for name, stage in stage_of.items():
    by_stage.setdefault(stage, []).append(name)
assert set(by_stage) == set(graph), sorted(set(by_stage) ^ set(graph))
for name, job in jobs.items():
    needs = job.get('needs', [])
    needs = [needs] if isinstance(needs, str) else needs
    stage = stage_of[name]
    if job['with'].get('shard') == 'merge':
        assert needs == ['test_server'], needs
        continue
    wanted = set()
    for need in graph[stage]:
        wanted.update(n for n in by_stage[need] if not (need == 'test.server' and n == 'test_server'))
    if 'test.server' in graph[stage]:
        wanted = {n for n in wanted} | {'test_server_merge'}
    assert set(needs) == wanted, (name, sorted(needs), sorted(wanted))
shards = jobs['test_server']
assert shards['strategy']['matrix']['shard'] == [1, 2, 3, 4, 5, 6, 7, 8], shards['strategy']
assert shards['strategy']['fail-fast'] is False
assert shards['with']['shard'] == "${{ format('{0}', matrix.shard) }}"
assert jobs['test_server_merge']['with']['shard'] == 'merge'
assert workflow['concurrency']['group'] == "${{ inputs.dry_run && format('release-dry-run-{0}', github.run_id) || 'release-macos' }}", workflow['concurrency']
assert stage_workflow.get('on', stage_workflow.get('true'))['workflow_call']['inputs']['stage']['required'] is True
run = '\n'.join(step.get('run', '') for step in stage_workflow['jobs']['stage']['steps'])
assert 'bash scripts/release/release.sh "${args[@]}"' in run, run
assert 'args=("$RELEASE_VERSION" --stage "$RELEASE_STAGE" --resume)' in run, run
assert 'args+=(--shard "$RELEASE_SHARD")' in run, run
assert 'checkout -q --detach "$GITHUB_SHA"' in run and '--detach "origin/' not in run, run
count = int(stage_workflow['env']['RELEASE_GRAPH_SHARDS'])
assert shards['strategy']['matrix']['shard'] == list(range(1, count + 1)), (count, shards['strategy'])
job = stage_workflow['jobs']['stage']
upload = [step for step in job['steps'] if step.get('name') == 'Upload logs and timings'][0]
assert upload['with']['name'].endswith('-a${{ github.run_attempt }}'), upload['with']['name']
secret_stages = set(json.loads(job['env']['RELEASE_SECRETS'].split("fromJSON('")[1].split("')")[0]))
assert not {stage for stage in graph if stage.startswith('test.')} & secret_stages, secret_stages
token = "${{ env.RELEASE_SECRETS == 'true' && secrets.RELEASE_GH_TOKEN || github.token }}"
for step in job['steps']:
    for key, value in dict(step.get('env', {}), **step.get('with', {})).items():
        if 'secrets.' in str(value) and step.get('if') != "env.RELEASE_SECRETS == 'true'":
            assert (key, value) == ('GH_TOKEN', token), (step.get('name'), key)
print('ok')
PY
}
check 'release.yml runs the graph as jobs, 8 server shards set once, logs per attempt, secrets only where needed' workflow_graph
