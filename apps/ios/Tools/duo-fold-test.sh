#!/bin/bash
# Real hinge folds for DuoFoldUITests on the owned Duo simulator. The test
# writes the pose it wants (open|closed) into a signal folder; this script
# applies it with agent-device's fold helper and removes the request.
#
# usage: Tools/duo-fold-test.sh [fold-helper path]   (run from apps/ios after Tools/duo-readiness.sh test or sim.sh build)
set -euo pipefail
cd "$(dirname "$0")/.."
SIM_NAME=${SIM_NAME:-SWC-1079-Duo}
helper=${1:-$(ls -d "$HOME"/.agent-device/fold-helper/*/fold-helper 2>/dev/null | head -1)}
[ -x "$helper" ] || { echo "BLOCKED: no fold-helper; install agent-device or pass its path" >&2; exit 2; }
udid=$(SIM_NAME="$SIM_NAME" bash Tools/sim.sh ensure)
signal=$(mktemp -d /tmp/swc-duo-fold.XXXXXX)
trap 'kill "$watcher" 2>/dev/null || true; rm -rf "$signal"' EXIT
(
  while true; do
    if [ -f "$signal/request" ]; then
      pose=$(cat "$signal/request")
      xcrun simctl spawn "$udid" "$helper" "$pose" >/dev/null
      rm -f "$signal/request"
    fi
    sleep 0.5
  done
) & watcher=$!
export SIM_NAME DERIVED_DATA=${DERIVED_DATA:-build/DuoDerivedData} OUT=${OUT:-build/duo-fold}
TEST_RUNNER_SWC_DUO_FOLD_SIGNAL="$signal" bash Tools/sim.sh test -only-testing:SpecWithCodeUITests/DuoFoldUITests
