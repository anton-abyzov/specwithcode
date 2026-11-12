#!/bin/bash
# Ask for a SpecWithCode release, and find out whether a commit is released. For people and agent
# sessions alike: nobody picks a version or checks whether a release is running first.
#
#   bash scripts/release/request-release.sh [--by NAME]
#       Dispatches Release macOS with no version and prints the run. The run waits its turn, then
#       releases what main holds as the next version, or ends green at once when main is already
#       released (.github/workflows/release-macos.yml, scripts/release/release_plan.py). Any number
#       of these may be dispatched; one run cuts each version. NAME (a session or thread name) is
#       shown in the run's title, so runs can be told apart.
#   bash scripts/release/request-release.sh --released COMMIT
#       Prints the first release that holds COMMIT and exits 0, or exits 2 when none does yet.
#       This is the check that a change shipped: a green run alone can be someone else's.
#
# RELEASE_REPO (default anton-abyzov/specwithcode) and --ref (default main) pick the repository
# and the branch. Continuing a failed release by name stays a plain dispatch:
#   gh workflow run release-macos.yml -R <repo> -f version=X.Y.Z -f resume=true
set -euo pipefail

REPO="${RELEASE_REPO:-anton-abyzov/specwithcode}"
REF=main BY="" COMMIT="" MODE=request

die() { printf 'request-release.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --by) [ $# -ge 2 ] || die "--by needs a name"; BY="$2"; shift ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a branch"; REF="$2"; shift ;;
    --released) [ $# -ge 2 ] || die "--released needs a commit"; MODE=released; COMMIT="$2"; shift ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

if [ "$MODE" = released ]; then
  [[ $COMMIT =~ ^[0-9a-f]{7,40}$ ]] || die "--released takes a commit sha"
  # Newest first; the commit is in a release when that release's tag is not behind it.
  tags="$(gh api --paginate "repos/$REPO/git/matching-refs/tags/v1.?per_page=100" --jq '.[].ref' |
    sed -n 's|^refs/tags/v\(1\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -12)"
  found=""
  for version in $tags; do
    status="$(gh api "repos/$REPO/compare/v$version...$COMMIT" --jq .status 2> /dev/null)" ||
      die "cannot compare $COMMIT with v$version on $REPO"
    case "$status" in
      behind | identical) found="$version" ;;
      *) break ;;
    esac
  done
  if [ -z "$found" ]; then
    echo "$COMMIT is not in a release yet (newest: v$(printf '%s\n' "$tags" | head -1))"
    exit 2
  fi
  echo "$COMMIT is released in v$found"
  exit 0
fi

# A label unique to this dispatch, so its run can be found among others dispatched at the same time.
label="${BY:-$(whoami)@$(hostname -s)} $(date -u +%H%M%S)-$RANDOM"
gh workflow run release-macos.yml -R "$REPO" --ref "$REF" -f requested_by="$label" > /dev/null
run="" tries=0
while [ -z "$run" ] && [ "$tries" -lt 10 ]; do
  sleep 2
  run="$(gh run list -R "$REPO" --workflow release-macos.yml --event workflow_dispatch --limit 30 \
    --json databaseId,displayTitle --jq "[.[] | select(.displayTitle | endswith(\"$label\"))][0].databaseId // empty")"
  tries=$((tries + 1))
done
[ -n "$run" ] || die "dispatched, but the run did not show up in 20s; look for '$label' in: gh run list -R $REPO --workflow release-macos.yml"
echo "Requested a release of $REF: run $run, https://github.com/$REPO/actions/runs/$run"
echo "It waits for the releases before it. Its 'Plan the release' job names the version, or says main is already released."
echo "Check that your change shipped: bash scripts/release/request-release.sh --released <commit>"
