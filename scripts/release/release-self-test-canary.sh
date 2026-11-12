#!/bin/bash
# Sourced by release-self-test.sh: the candidate channel, canary and finalize (release-canary.sh,
# increment 1239). Uses that file's run, check, has, lacks, make_machine, use_machine, stub_set,
# stages_after and labels_of. Stub runs record r2_publish.py and canary_soak.py instead of running
# them, so no bucket is reached; canary_soak.py itself runs against a fake fleet_health.py.

CANDIDATE_ORDER="preflight trees prev bump candidate server stage1 rehearsal build bundle sign verify helpers plan drafts server-wait quit-desktop publish-candidate fleet-m4 desktop canary-soak fleet-workers publish-private publish-public promote-stable merge fleet-linux"
CHANNEL_ENV=(RELEASE_CHANNEL=candidate RELEASE_R2_BUCKET=studio-releases RELEASE_CHANNEL_SINCE=1.0.190)

dry_candidate_ok() {
  STUB_ENV=(HOME="$DRY_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_ENV= "${CHANNEL_ENV[@]}")
  run 0 9.9.9 --dry-run || return 1
  [ "$(sed -n 's/^> \([a-z0-9-]*\).*/\1/p' "$LAST_OUT" | tr '\n' ' ' | sed 's/ $//')" = "$CANDIDATE_ORDER" ] || return 1
  has 'fleet_rollout.py --version 9.9.9 --only m4 --hold-minutes 15 --channel candidate --channel-since 1.0.190 --require-all' &&
    has 'fleet_rollout.py --version 9.9.9 --only workers --channel candidate --channel-since 1.0.190 --require-all' &&
    has 'r2_publish.py publish-candidate --version 9.9.9 --dir ' && has 'r2_publish.py check --channel candidate --version 9.9.9' &&
    has 'canary_soak.py --fleet-dir ' && has '--seconds 900' && has 'r2_publish.py promote --version 9.9.9' &&
    has 'preflight: channel candidate (r2://studio-releases, hosts from 1.0.190)' && lacks 'fleet-feed: stop unless' || return 1
  # The first GitHub flip comes after the fleet stage asked M1 and M3.
  [ "$(grep -n 'only workers' "$LAST_OUT" | head -1 | cut -d: -f1)" -lt "$(grep -n 'draft=false' "$LAST_OUT" | head -1 | cut -d: -f1)" ]
}
check 'candidate channel: the dry-run publishes to R2, canaries M4 and soaks, asks the fleet, then flips GitHub and stable' dry_candidate_ok
dry_channel_default_ok() {
  STUB_ENV=(HOME="$DRY_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_ENV= RELEASE_R2_BUCKET=studio-releases
    RELEASE_CHANNEL_SINCE=1.0.190)
  run 0 9.9.9 --dry-run && has 'preflight: channel candidate' || return 1
  STUB_ENV=(HOME="$DRY_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_ENV=)
  run 0 9.9.9 --dry-run && has 'preflight: channel github' && lacks 'r2_publish.py' || return 1
  STUB_ENV=(HOME="$DRY_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_ENV= "${CHANNEL_ENV[@]}")
  run 0 9.9.9 --dry-run --ci && has 'would stop: the github channel (RELEASE_CHANNEL=github or --ci) leaves stable.json' ||
    return 1
  STUB_ENV+=(RELEASE_ALLOW_GITHUB_CHANNEL_WITH_FEED=1)
  run 0 9.9.9 --dry-run --ci && lacks 'would stop: the github channel' || return 1
  [ "$(sed -n 's/^> \([a-z0-9-]*\).*/\1/p' "$LAST_OUT" | tr '\n' ' ' | sed 's/ $//')" = "$CI_ORDER" ] && lacks 'r2_publish.py' || return 1
  STUB_ENV=(HOME="$DRY_HOME" RELEASE_STUB= RELEASE_STAGING_ROOT= RELEASE_TREES= RELEASE_ENV= RELEASE_CHANNEL=beta)
  run 2 9.9.9 --dry-run && has 'RELEASE_CHANNEL must be candidate or github'
}
check 'the channel is candidate once a bucket is set, github without one or with --ci, and nothing else' dry_channel_default_ok
check 'the candidate dry-runs write nothing under HOME' test -z "$(find "$DRY_HOME" -mindepth 1 -print -quit)"

R="$WORK/r2"
make_machine "$R"
use_machine "$R" 1.7.0
R2_SECRET=r2-secret-value-never-in-a-log
printf 'CLOUDFLARE_R2_ACCOUNT_ID=acct\nCLOUDFLARE_R2_ACCESS_KEY_ID="key-id"\nCLOUDFLARE_R2_SECRET_ACCESS_KEY=%s\n' "$R2_SECRET" \
  > "$R/secrets/r2.env"
chmod 600 "$R/secrets/r2.env"
STUB_ENV+=("${CHANNEL_ENV[@]}" RELEASE_R2_ENV_FILE="$R/secrets/r2.env")
preflight_refused() {  # preflight_refused MESSAGE: a fresh 1.7.0 run stops at preflight with MESSAGE
  rm -rf "$STAGE"
  run 1 1.7.0 --stop-after preflight && has "$1" && [ -z "$(labels_of trees)" ]
}
candidate_preflight_refused() {
  stub_set RELEASE_CHANNEL_SINCE=
  preflight_refused 'RELEASE_CHANNEL_SINCE must name the first release' || return 1
  stub_set RELEASE_CHANNEL_SINCE=1.0.190 RELEASE_R2_ENV_FILE="$R/secrets/missing.env"
  preflight_refused 'RELEASE_R2_ENV_FILE does not name a non-empty file' || return 1
  chmod 644 "$R/secrets/r2.env"
  stub_set RELEASE_R2_ENV_FILE="$R/secrets/r2.env"
  preflight_refused "$R/secrets/r2.env must be mode 600" || return 1
  chmod 600 "$R/secrets/r2.env"
  printf 'CLOUDFLARE_R2_ACCOUNT_ID=acct\n' > "$R/secrets/r2-partial.env"
  chmod 600 "$R/secrets/r2-partial.env"
  stub_set RELEASE_R2_ENV_FILE="$R/secrets/r2-partial.env"
  preflight_refused 'r2-partial.env has no CLOUDFLARE_R2_ACCESS_KEY_ID' || return 1
  stub_set RELEASE_R2_ENV_FILE="$R/secrets/r2.env" "RELEASE_STUB_STATUS=cmd-aws=1"
  preflight_refused 'aws is not on PATH' || return 1
  stub_set RELEASE_STUB_STATUS=
  rm -rf "$STAGE"
}
check 'candidate preflight stops without the since version, the R2 file (mode 600) or the aws CLI' candidate_preflight_refused
github_with_feed_refused() {
  local rc=0
  stub_set RELEASE_CHANNEL=github
  preflight_refused 'hosts reading that feed never install v1.7.0; use the candidate channel' || rc=1
  stub_set RELEASE_CHANNEL=candidate
  rm -rf "$STAGE"
  return "$rc"
}
check 'the github channel with a bucket set stops at preflight: stable.json would hold feed hosts back' github_with_feed_refused

# The canary fails its soak: M4 and its app are on the candidate, nobody else is asked, nothing is public.
stub_set RELEASE_STUB_FAIL=canary-soak
canary_failed_ok() {
  run 1 1.7.0 || return 1
  has 'the canary failed its soak on M4' && has 'GitHub and stable.json are untouched' || return 1
  [ "$(stages_after 0)" = "prev bump candidate stage1 build bundle sign verify helpers plan drafts publish-candidate fleet-m4 desktop canary-soak " ] || return 1
  [ -f "$STAGE/markers/fleet-m4" ] && [ -f "$STAGE/markers/desktop" ] && [ ! -f "$STAGE/markers/canary-soak" ] &&
    [ -z "$(labels_of fleet-workers)" ] && [ -z "$(labels_of publish-private)" ] && [ -z "$(labels_of promote-stable)" ] &&
    ! grep -q 'draft=false' "$STUB_LOG"
}
check 'a failed canary soak asks no other host and publishes nothing' canary_failed_ok
# Then a required worker is not verified: still nothing on GitHub or stable.
stub_set RELEASE_STUB_FAIL=fleet-workers
BEFORE="$(lines)"
fleet_failed_ok() {
  run 1 1.7.0 --resume || return 1
  [ "$(stages_after "$BEFORE")" = "canary-soak fleet-workers " ] && [ -f "$STAGE/markers/canary-soak" ] &&
    [ ! -f "$STAGE/markers/fleet-workers" ] && ! grep -q 'draft=false' "$STUB_LOG" &&
    [ -z "$(labels_of promote-stable)" ] && [ -z "$(labels_of merge)" ] && [ ! -f "$STAGE/markers/publish-private" ] &&
    [ "$(cat "$STAGE/published.sha")" = "$SHA_A" ]
}
check 'a fleet stage without M1 and M3 verified flips no GitHub draft, swaps no stable pointer and merges nothing' fleet_failed_ok
stub_set RELEASE_STUB_FAIL= RELEASE_STUB_SHA="$SHA_B"
BEFORE="$(lines)"
candidate_pinned_ok() {
  run 1 1.7.0 --resume || return 1
  has "v1.7.0 is published at $SHA_A but" && has 'release the change as a new version' &&
    [ "$(stages_after "$BEFORE")" = "" ] && [ "$(cat "$STAGE/candidate.sha")" = "$SHA_A" ]
}
check 'once the candidate feed has v1.7.0, a resume at another SHA stops: that change is a new version' candidate_pinned_ok
stub_set RELEASE_STUB_SHA="$SHA_A"
BEFORE="$(lines)"
candidate_finish_ok() {
  run 0 1.7.0 --resume || return 1
  has 'SpecWithCode 1.7.0 is released.' || return 1
  [ "$(stages_after "$BEFORE")" = "fleet-workers publish-private publish-public promote-stable merge fleet-linux " ] || return 1
  local order
  order="$(awk -F '\t' '{ printf "%s ", $2 }' "$STUB_LOG")"
  case "$order" in
    *public-notes*publish-candidate*candidate-feed*fleet-m4*desktop-open*canary-soak*candidate-feed*fleet-workers*publish-private*publish-public*promote-stable*pr-merge*fleet-linux*) ;;
    *) return 1 ;;
  esac
  grep -qF "$(printf 'publish-candidate\tpublish-candidate\tpython3 -B %s/r2_publish.py publish-candidate --version 1.7.0 --dir %s/assets-' "$HERE" "$STAGE")" "$STUB_LOG" &&
    grep -qF -- '--source-commit '"$SHA_A" "$STUB_LOG" &&
    grep -qF "$(printf 'promote-stable\tpromote-stable\tpython3 -B %s/r2_publish.py promote --version 1.7.0' "$HERE")" "$STUB_LOG" &&
    grep -qF 'fleet_rollout.py --version 1.7.0 --only workers --channel candidate --channel-since 1.0.190 --require-all' "$STUB_LOG" &&
    grep -qF -- "canary_soak.py --fleet-dir $R/trees.noindex/build/scripts/studio-fleet --identity m4 --seconds 900" "$STUB_LOG" &&
    [ "$(cat "$STAGE/published.sha")" = "$SHA_A" ]
}
check 'then finalize flips both drafts, promotes stable last of the writes, merges and updates Linux' candidate_finish_ok
r2_secret_kept() {
  ! grep -rqF -- "$R2_SECRET" "$STAGE" && ! grep -qF -- "$R2_SECRET" "$LAST_OUT" && ! grep -qF -- 'key-id' "$STUB_LOG"
}
check 'the R2 credentials reach no log, stub record or output' r2_secret_kept
STAGE_RESUMED="$STAGE"
use_machine "$R" 1.7.1
STUB_ENV+=("${CHANNEL_ENV[@]}" RELEASE_R2_ENV_FILE="$R/secrets/r2.env" RELEASE_STUB_PREVIOUS=1.7.0)
stub_set RELEASE_STUB_FAIL=fleet-m4:candidate-feed
feed_refused_ok() {
  run 1 1.7.1 || return 1
  has 'candidate.json does not name a complete 1.7.1' && [ -z "$(labels_of fleet-m4 | grep -v candidate-feed)" ] &&
    [ ! -f "$STAGE/markers/fleet-m4" ]
}
check 'fleet-m4 asks M4 for nothing while candidate.json lacks the release' feed_refused_ok
stub_set RELEASE_STUB_FAIL=
rm -rf "$STAGE"
check 'finalize refuses a folder whose fleet stages are not done' bash -c '
  MODE=stub VERSION=1.7.2 MARKERS="$1" HERE="$2"
  say() { :; }; die() { printf "%s\n" "$*"; exit 3; }; is_done() { [ -f "$MARKERS/$1" ]; }
  . "$HERE/release-canary.sh"
  mkdir -p "$MARKERS" && : > "$MARKERS/fleet-m4" && : > "$MARKERS/desktop" && : > "$MARKERS/canary-soak"
  out="$(finalize_ready)"; rc=$?
  [ "$rc" -eq 3 ] && case "$out" in *"finalize needs fleet-workers done first"*) ;; *) exit 1 ;; esac' _ "$WORK/finalize-markers" "$HERE"

# canary_soak.py itself, on a fake fleet_health.py and a temporary service home.
SOAK="$WORK/soak"
mkdir -p "$SOAK/fleet" "$SOAK/home"
cat > "$SOAK/fleet/fleet_health.py" << 'EOF'
import json, pathlib, sys
base = pathlib.Path(sys.argv[sys.argv.index('--base-dir') + 1])
control = json.loads((base / 'control.json').read_text())
calls = base / 'calls'
count = int(calls.read_text()) + 1 if calls.exists() else 1
calls.write_text(str(count))
if count == control.get('errorOnCall'):
    with open(str(base / 'stderr.log'), 'a') as log:
        log.write('2026-11-04T12:00:00Z Error: boom in the candidate\n')
status = control.get('statusOnCall', {}).get(str(count), 'ok')
print(json.dumps({'status': status, 'problems': [] if status == 'ok' else ['traces: 3 failed spans']}))
sys.exit({'ok': 0, 'degraded': 1}.get(status, 2))
EOF
soak_run() {  # soak_run EXPECTED_RC CONTROL_JSON SECONDS
  rm -f "$SOAK/home/calls"
  printf '%s\n' "$2" > "$SOAK/home/control.json"
  set +e
  python3 -B "$HERE/canary_soak.py" --fleet-dir "$SOAK/fleet" --base-dir "$SOAK/home" --seconds "$3" --interval 1 > "$LAST_OUT" 2>&1
  local rc=$?
  set -e
  [ "$rc" -eq "$1" ]
}
canary_soak_ok() {
  printf 'old Error: from before the soak\n' > "$SOAK/home/stderr.log"
  soak_run 0 '{}' 2 && has '"result": "passed"' && [ "$(cat "$SOAK/home/calls")" -ge 3 ] || return 1
  soak_run 1 '{"statusOnCall": {"2": "degraded"}}' 5 && has 'fleet_health.py reports degraded: traces: 3 failed spans' &&
    [ "$(cat "$SOAK/home/calls")" -eq 2 ] || return 1
  soak_run 1 '{"errorOnCall": 2}' 5 && has '1 new error line(s)' && has 'Error: boom in the candidate' && lacks 'from before the soak' || return 1
  : > "$SOAK/home/stderr.log"
  soak_run 0 '{}' 0 && has '"rounds": 1'
}
check 'canary_soak.py passes a clean window and fails on a degraded health check or a new stderr error' canary_soak_ok
