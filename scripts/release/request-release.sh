#!/bin/bash
# Ask for a SpecWithCode release, and find out whether a commit is released. For people and agent
# sessions alike: nobody picks a version or checks whether a release is running first.
#
#   bash scripts/release/request-release.sh [--by NAME] [--wait]
#       Asks for a release of what main holds and prints the run that will make it. When a run is
#       already waiting for its turn, the request joins that run: it has not read main yet, so it
#       releases everything main holds when it starts, and one more run behind it would find nothing
#       left. Otherwise it dispatches Release macOS with no version. The run releases main as the
#       next version, or ends green at once when main is already released
#       (.github/workflows/release-macos.yml, scripts/release/release_plan.py). Any number of
#       sessions may ask; one run cuts each version. NAME (a session or thread name) is shown in
#       the title of a run this request dispatches. --wait stays until a release holds the head of
#       main the request saw, and exits 1 when a run fails. A run can end green without it (it
#       finished an older release first), so --wait then asks again, three runs at most. A
#       release takes about 25 minutes, longer behind another, so run --wait in the background.
#   bash scripts/release/request-release.sh --dry-run
#       Prints what a run dispatched now would decide. Dispatches nothing.
#   bash scripts/release/request-release.sh --released COMMIT
#       Prints the first release that holds COMMIT and exits 0, or exits 2 when none does yet.
#       This is the check that a change shipped: a green run alone can be someone else's.
#
# RELEASE_REPO (default anton-abyzov/specwithcode) and --ref (default main) pick the repository
# and the branch. Continuing a failed release by name stays a plain dispatch:
#   gh workflow run release-macos.yml -R <repo> -f version=X.Y.Z -f resume=true
set -euo pipefail

REPO="${RELEASE_REPO:-anton-abyzov/specwithcode}"
REF=main BY="" COMMIT="" MODE=request WAIT=0
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { printf 'request-release.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --by) [ $# -ge 2 ] || die "--by needs a name"; BY="$2"; shift ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a branch"; REF="$2"; shift ;;
    --released) [ $# -ge 2 ] || die "--released needs a commit"; MODE=released; COMMIT="$2"; shift ;;
    --wait) WAIT=1 ;;
    --dry-run) MODE=dry ;;
    -h | --help) awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# The released versions, oldest first.
release_tags() {
  gh api --paginate "repos/$REPO/git/matching-refs/tags/v1.?per_page=100" --jq '.[].ref' |
    sed -n 's|^refs/tags/v\(1\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sort -t. -k1,1n -k2,2n -k3,3n
}

if [ "$MODE" = released ]; then
  [[ $COMMIT =~ ^[0-9a-f]{7,40}$ ]] || die "--released takes a commit sha"
  # Oldest first. A release holds the commit when its tag is not behind it, and every release
  # after the first one that does holds it too, so a binary search finds that first one.
  tags=()
  while IFS= read -r version; do tags+=("$version"); done < <(release_tags)
  [ "${#tags[@]}" -gt 0 ] || die "cannot read the v1.x.y tags of $REPO"
  gh api "repos/$REPO/commits/$COMMIT" --jq .sha > /dev/null 2>&1 || die "cannot read $COMMIT on $REPO"
  # An answer GitHub did not give is never "not released": ask once more, then stop.
  holds() {
    local status
    status="$(gh api "repos/$REPO/compare/v$1...$COMMIT" --jq .status 2> /dev/null)" ||
      { sleep 2; status="$(gh api "repos/$REPO/compare/v$1...$COMMIT" --jq .status 2> /dev/null)"; } ||
      die "cannot compare $COMMIT with v$1 on $REPO; try again"
    case "$status" in
      behind | identical) return 0 ;;
      ahead | diverged) return 1 ;;
      *) die "cannot compare $COMMIT with v$1 on $REPO: unexpected answer '$status'" ;;
    esac
  }
  low=0 high=$((${#tags[@]} - 1))
  if ! holds "${tags[$high]}"; then
    echo "$COMMIT is not in a release yet (newest: v${tags[$high]})"
    exit 2
  fi
  while [ "$low" -lt "$high" ]; do
    middle=$(((low + high) / 2))
    if holds "${tags[$middle]}"; then high=$middle; else low=$((middle + 1)); fi
  done
  echo "$COMMIT is released in v${tags[$low]}"
  exit 0
fi

if [ "$MODE" = dry ]; then
  exec python3 -B "$HERE/release_plan.py" plan --repo "$REPO" --branch "$REF"
fi

# The run that waits for its turn and has not started: no job of it exists yet, so it has not read
# main. Only a run this helper dispatched, told by the label at the end of its title: a run
# dispatched by hand may carry stop_after or resume, which the title does not show, and would not
# release main. The oldest one, since it starts first. Prints nothing when there is none, or when
# GitHub did not answer; the request then dispatches a run of its own, which is always safe.
waiting_run() {
  local id
  id="$(gh run list -R "$REPO" --workflow release-macos.yml --branch "$REF" --event workflow_dispatch \
    --status pending --limit 50 --json databaseId,displayTitle --jq '.[] | "\(.databaseId) \(.displayTitle)"' \
    2> /dev/null | grep -E '^[0-9]+ Release macOS next · .+ [0-9]{6}-[0-9]+$' | tail -1 | cut -d' ' -f1)" || return 0
  [ -n "$id" ] || return 0
  # Read again by id: still waiting, never rerun, and no job yet.
  [ "$(gh run view "$id" -R "$REPO" --json status,attempt,jobs \
    --jq '"\(.status) \(.attempt) \(.jobs | length)"' 2> /dev/null)" = "pending 1 0" ] || return 0
  echo "$id"
}

# Sets run.
request() {
  run="$(waiting_run)"
  if [ -n "$run" ]; then
    echo "Joined run $run, which waits for its turn: https://github.com/$REPO/actions/runs/$run"
    echo "It has not started, so it releases what $REF holds when it does. No new run was dispatched."
    return 0
  fi
  # A label unique to this dispatch, so its run can be found among others dispatched at the same time.
  # Plain characters only: the label goes into the run's title and into the filter that finds it.
  local by label tries=0
  by="$(printf '%s' "${BY:-$(whoami)@$(hostname -s)}" | tr -cd 'A-Za-z0-9 ._@:/-' | cut -c1-60)"
  label="${by:-someone} $(date -u +%H%M%S)-$RANDOM"
  gh workflow run release-macos.yml -R "$REPO" --ref "$REF" -f requested_by="$label" > /dev/null
  while [ -z "$run" ] && [ "$tries" -lt 10 ]; do
    sleep "${REQUEST_POLL_SECONDS:-2}"
    run="$(gh run list -R "$REPO" --workflow release-macos.yml --event workflow_dispatch --limit 30 \
      --json databaseId,displayTitle --jq "[.[] | select(.displayTitle | endswith(\"$label\"))][0].databaseId // empty" \
      2> /dev/null || true)"
    tries=$((tries + 1))
  done
  [ -n "$run" ] || die "dispatched, but the run did not show up; look for '$label' in: gh run list -R $REPO --workflow release-macos.yml"
  echo "Requested a release of $REF: run $run, https://github.com/$REPO/actions/runs/$run"
  echo "It waits for the release before it, if one is running."
}

# Sets newest to the highest v1.x.y tag, and left to 0 when that release holds everything
# $head_sha holds. A release whose pull request was squashed is not an ancestor of main, so equal
# trees count too.
compare_with_newest() {
  newest="$(release_tags | tail -1)"
  [ -n "$newest" ] || die "run $run finished, but the v1.x.y tags of $REPO could not be read; check with --released"
  left="$(gh api "repos/$REPO/compare/v$newest...$head_sha" --jq '.files | length' 2> /dev/null)" ||
    die "run $run finished, but $head_sha could not be compared with v$newest; check with --released"
  [ "$left" != 0 ] || return 0
  local ours theirs
  ours="$(gh api "repos/$REPO/commits/$head_sha" --jq .commit.tree.sha 2> /dev/null)" || return 0
  theirs="$(gh api "repos/$REPO/commits/v$newest" --jq .commit.tree.sha 2> /dev/null)" || return 0
  [ "$ours" != "$theirs" ] || left=0
}

# What this request must see released: the head of the branch before the request was made.
head_sha=""
if [ "$WAIT" -eq 1 ]; then
  head_sha="$(gh api "repos/$REPO/commits/$REF" --jq .sha 2> /dev/null)" || die "cannot read $REF on $REPO"
fi
request
echo "Its 'Plan the release' job names the version, or says $REF is already released."
echo "Check that your change shipped: bash scripts/release/request-release.sh --released <commit>"
if [ "$WAIT" -eq 1 ]; then
  # A run can end green without this request's commit: a joined run had started after all, or a run
  # finished an older release first. Ask again then, a few times at most.
  rounds=1
  while :; do
    gh run watch "$run" -R "$REPO" --exit-status --interval 30 > /dev/null ||
      die "run $run did not succeed: gh run view $run -R $REPO --log-failed"
    compare_with_newest
    [ "$left" != 0 ] || break
    [ "$rounds" -lt 3 ] ||
      die "run $run finished as v$newest, and ${head_sha:0:12} is still not released after $rounds runs; see why in the runs' plan jobs"
    echo "Run $run finished as v$newest without ${head_sha:0:12}; asking once more."
    rounds=$((rounds + 1))
    request
  done
  echo "Run $run finished; ${head_sha:0:12} is released, newest release v$newest"
fi
