#!/bin/bash
# Sourced by release.sh: the R2 candidate channel, the canary and finalize (increment 1239, phase 4).
# Functions only; paths stay tied to release.sh ($HERE, $BUILD, $ASSETS, $STAGE).
#
# RELEASE_CHANNEL (release.env or the environment) picks the order after server-wait:
#   candidate  publish-candidate fleet-m4 desktop canary-soak fleet-workers, then finalize:
#              publish-private publish-public promote-stable merge, then fleet-linux.
#              The hosts install from the R2 candidate feed (fleet_rollout.py --channel candidate);
#              nothing reaches GitHub or stable.json before M4, M1 and M3 are verified (D-03).
#   github     the earlier order: publish-private publish-public fleet-m4 desktop fleet-workers merge
#              fleet-linux, the hosts reading the public GitHub feed. Always with --ci, and the
#              default while RELEASE_R2_BUCKET is unset: the first release with channel feeds in its
#              update agent ships this way (schema skew), and RELEASE_CHANNEL_SINCE then names it.
# Candidate settings: RELEASE_R2_BUCKET; RELEASE_R2_ENV_FILE, a mode-600 file holding only
# CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID and CLOUDFLARE_R2_SECRET_ACCESS_KEY (read
# without evaluating it, passed only to r2_publish.py); RELEASE_CHANNEL_SINCE, the first release
# whose update agent reads channel feeds (a host on an older one is not asked and fails the fleet);
# RELEASE_CANARY_SOAK_SECONDS (900, D-04). The aws CLI must be on PATH.
#
# A canary that fails its soak stops the release: M4 keeps the candidate (restore it from its
# pre-update backup and desktop_backup.py's copy), and GitHub and stable.json are untouched.
# `python3 -B scripts/release/r2_publish.py rollback` puts the previous stable pointer back.

R2_KEYS="CLOUDFLARE_R2_ACCOUNT_ID CLOUDFLARE_R2_ACCESS_KEY_ID CLOUDFLARE_R2_SECRET_ACCESS_KEY"
CHANNEL_ARGS=()

channel_init() {  # After load_env.
  case "${RELEASE_CHANNEL:-}" in
    candidate | github) ;;
    "") if [ -n "${RELEASE_R2_BUCKET:-}" ]; then RELEASE_CHANNEL=candidate; else RELEASE_CHANNEL=github; fi ;;
    *) usage_error "RELEASE_CHANNEL must be candidate or github, not $RELEASE_CHANNEL" ;;
  esac
  if [ "$CI_MODE" -eq 1 ]; then RELEASE_CHANNEL=github; fi
  CHANNEL_ARGS=()
  if [ "$RELEASE_CHANNEL" = candidate ]; then
    CHANNEL_ARGS=(--channel candidate --channel-since "${RELEASE_CHANNEL_SINCE:-}")
    RELEASE_R2_STORE="${RELEASE_R2_STORE:-r2://${RELEASE_R2_BUCKET:-}}"
  fi
}

channel_preflight() {
  local var
  if [ "$RELEASE_CHANNEL" = github ]; then
    # A host with STUDIO_UPDATE_FEED_URL installs nothing above stable.json, which this order never
    # moves: with a bucket set, that host would never see this release.
    if [ -n "${RELEASE_R2_BUCKET:-}" ] && [ "${RELEASE_ALLOW_GITHUB_CHANNEL_WITH_FEED:-}" != 1 ]; then
      check_fail "the github channel (RELEASE_CHANNEL=github or --ci) leaves stable.json on r2://$RELEASE_R2_BUCKET" \
        "behind, and hosts reading that feed never install v$VERSION; use the candidate channel, or set" \
        "RELEASE_ALLOW_GITHUB_CHANNEL_WITH_FEED=1 while no host reads the feed"
    fi
    say "preflight: channel github (GitHub releases are published before the fleet installs them)"
    return 0
  fi
  [ -n "${RELEASE_R2_BUCKET:-}" ] || check_fail "RELEASE_CHANNEL=candidate needs RELEASE_R2_BUCKET in $RELEASE_ENV"
  [[ ${RELEASE_CHANNEL_SINCE:-} =~ $VERSION_RE ]] ||
    check_fail "RELEASE_CHANNEL_SINCE must name the first release whose update agent reads channel feeds"
  [ -s "${RELEASE_R2_ENV_FILE:-/nonexistent}" ] || check_fail "RELEASE_R2_ENV_FILE does not name a non-empty file"
  if [ -f "${RELEASE_R2_ENV_FILE:-}" ] && [ "$(stat -f %Lp "$RELEASE_R2_ENV_FILE")" != 600 ]; then
    check_fail "$RELEASE_R2_ENV_FILE must be mode 600"
  fi
  if [ "$MODE" != dry ] && [ -f "${RELEASE_R2_ENV_FILE:-}" ]; then
    for var in $R2_KEYS; do
      grep -Eq "^(export )?$var=." "$RELEASE_R2_ENV_FILE" || check_fail "$RELEASE_R2_ENV_FILE has no $var"
    done
  fi
  t cmd-aws -- command -v aws > /dev/null || check_fail "aws is not on PATH (brew install awscli); r2_publish.py reaches R2 with it"
  say "preflight: channel candidate (r2://$RELEASE_R2_BUCKET, hosts from $RELEASE_CHANNEL_SINCE)"
}

r2() {  # r2 LABEL ARGS...: r2_publish.py with the three R2 values in its environment only, never in argv.
  local label="$1"
  shift
  (
    local key value
    if [ "$MODE" != dry ]; then
      # Only those three names are read, and the file is never evaluated (as load_google_pair reads its pair).
      while IFS='=' read -r key value || [ -n "$key" ]; do
        key="${key#export }"
        case " $R2_KEYS " in
          *" $key "*)
            case "$value" in
              \"*\") value="${value#\"}" value="${value%\"}" ;;
              \'*\') value="${value#\'}" value="${value%\'}" ;;
            esac
            export "$key=$value"
            ;;
        esac
      done < "$RELEASE_R2_ENV_FILE"
    fi
    export RELEASE_R2_STORE
    x "$label" -- python3 -B "$HERE/r2_publish.py" "$@"
  )
}

# The feed the fleet stages' hosts read must show this release before any host is asked.
fleet_feed_ready() {
  if [ "$RELEASE_CHANNEL" = candidate ]; then
    r2 candidate-feed check --channel candidate --version "$VERSION" ||
      die "candidate.json does not name a complete $VERSION; publish-candidate comes first"
    return 0
  fi
  if [ "$MODE" = dry ]; then
    say "    fleet-feed: stop unless v$VERSION is published on $PUBLIC_REPO"
    return 0
  fi
  [ "$(q published-fleet-feed -- gh release view "v$VERSION" -R "$PUBLIC_REPO" --json isDraft -q .isDraft)" = false ] ||
    die "v$VERSION is not published on $PUBLIC_REPO, the feed the fleet's update agents read; publish-public comes first"
}

stage_publish_candidate() {
  x public-notes -- python3 -B "$TOOLS" public-notes --in "$STAGE/notes.md" --out "$STAGE/notes-public.md" --rules "$PUBLIC_RULES"
  r2 publish-candidate publish-candidate --version "$VERSION" --dir "$ASSETS" --notes "$STAGE/notes-public.md" \
    --source-commit "$SHA"
  # The candidate feed now carries these bytes as $VERSION: resolve_candidate refuses another SHA on
  # --resume, since the once stages after this would not run again for it.
  state_write "$STAGE/published.sha" "$SHA"
}

stage_canary_soak() {
  x canary-soak -- python3 -B "$HERE/canary_soak.py" --fleet-dir "$BUILD/scripts/studio-fleet" --identity m4 \
    --seconds "${RELEASE_CANARY_SOAK_SECONDS:-900}" ||
    die "the canary failed its soak on M4 (above): M4 keeps candidate $VERSION; GitHub and stable.json are untouched"
}

# D-03: finalize runs only once M4 (canary), its soak and M1 and M3 (fleet) are verified. fleet_rollout.py
# exits non-zero unless every required host verified, so these markers stand for that.
finalize_ready() {
  local stage
  for stage in fleet-m4 desktop canary-soak fleet-workers; do
    is_done "$stage" once || [ "$MODE" = dry ] ||
      die "finalize needs $stage done first (M4, M1 and M3 verified on $VERSION); --resume runs it"
  done
}

stage_promote_stable() {
  finalize_ready
  r2 promote-stable promote --version "$VERSION"
}

# Everything after server-wait, in the order RELEASE_CHANNEL picks (see the top of this file).
release_tail() {
  if [ "$RELEASE_CHANNEL" = candidate ]; then
    run_stage publish-candidate once
    run_stage fleet-m4 once
    run_stage desktop once
    run_stage canary-soak once
    run_stage fleet-workers once
    if stage_selected publish-private; then finalize_ready; fi  # A --stage job before finalize skips it.
    run_stage publish-private once
    run_stage publish-public once
    run_stage promote-stable once
    run_stage merge once
    run_stage fleet-linux once
    return 0
  fi
  run_stage publish-private once
  run_stage publish-public once
  if [ "$CI_MODE" -eq 0 ]; then
    run_stage fleet-m4 once
    # Right after M4: the app attaches to the M4 service, which now runs this version, so it writes
    # no install request of its own; M1 or M3 failing next no longer leaves the Mac without its app.
    run_stage desktop once
    run_stage fleet-workers once
  else
    say "= fleet-m4, desktop, fleet-workers: skipped (--ci); hosts reading GitHub install v$VERSION on their next update check"
  fi
  run_stage merge once
  if [ "$CI_MODE" -eq 0 ]; then
    run_stage fleet-linux once
  else
    say "= fleet-linux: skipped (--ci); update Linux workers with linux_rollout.py --version $VERSION on the M4"
  fi
}
