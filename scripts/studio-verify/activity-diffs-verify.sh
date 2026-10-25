#!/bin/bash
# The pre-merge gate for activity diffs and compact output (increment 1011): every focused
# test the feature owns, the activity fixture, the web and server production builds, and the
# typecheck gate for the five packages it touches. Every step runs; the script exits non-zero
# when any failed and names each one.
#
#   bash scripts/studio-verify/activity-diffs-verify.sh [--out DIR] [--fixture-out DIR]
#
# --out          logs, one per step (default: a new temporary directory)
# --fixture-out  where the headless fixture writes its captures (default: DIR/fixture)
#
# Environment: STUDIO_PLAYWRIGHT_MODULE, the playwright-core entry the fixture loads
# (default: apps/server's installed copy). The fixture runs headless and never opens a window.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=""
FIXTURE_OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "--out needs a directory" >&2; exit 2; }; OUT="$2"; shift 2;;
    --fixture-out) [ $# -ge 2 ] || { echo "--fixture-out needs a directory" >&2; exit 2; }; FIXTURE_OUT="$2"; shift 2;;
    *) echo "activity-diffs-verify.sh: unknown argument $1" >&2; exit 2;;
  esac
done
[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/activity-diffs-verify.XXXXXX")"
[ -n "$FIXTURE_OUT" ] || FIXTURE_OUT="$OUT/fixture"
mkdir -p "$OUT" "$FIXTURE_OUT"
cd "$ROOT" || exit 2

VP="$ROOT/node_modules/vite-plus/bin/vp"
FAILED=()

step() {
  local name="$1"
  shift
  local log="$OUT/$name.log"
  local started=$SECONDS
  if (cd "$ROOT" && "$@") > "$log" 2>&1; then
    echo "ok    $name ($((SECONDS - started)) s)"
  else
    local code=$?
    echo "FAIL  $name (exit $code, $((SECONDS - started)) s): $log"
    tail -n 30 "$log" | sed 's/^/      /'
    FAILED+=("$name")
  fi
}

package_tests() {
  local dir="$1"
  shift
  (cd "$ROOT/$dir" && node "$VP" test run --config ../../vite.config.ts --dir . "$@")
}

web_tests() {
  (cd "$ROOT/apps/web" && node "$VP" test run "$@")
}

echo "Activity diffs gate; logs in $OUT"

step contracts package_tests packages/contracts src/orchestrationV2.test.ts src/checkpointDiff.test.ts
step shared package_tests packages/shared \
  src/toolOutput.test.ts src/structuredPatch.test.ts src/toolActivity.test.ts
step client-runtime bash -c "cd packages/client-runtime && node '$VP' test run \
  src/work-log/presentation.test.ts src/work-log/itemDetail.test.ts \
  src/state/threadCheckpoints.test.ts src/state/threadRequests.test.ts"
step capture-harness node --test scripts/studio-verify/activity-diffs-capture.test.mjs
step server-detail node "$VP" test run \
  apps/server/src/orchestration-v2/WireProjection.test.ts \
  apps/server/src/orchestration-v2/ThreadManagementService.test.ts \
  apps/server/src/orchestration-v2/ProjectionStore.test.ts
step server-checkpoints node "$VP" test run \
  apps/server/src/checkpointing/CheckpointDiffQuery.test.ts \
  apps/server/src/checkpointing/CheckpointStore.test.ts \
  apps/server/src/vcs/GitVcsDriver.test.ts \
  apps/server/src/orchestration-v2/CheckpointService.test.ts \
  apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts \
  apps/server/src/orchestration-v2/CheckpointScopeOwnership.test.ts \
  apps/server/src/checkpointing/headMoveAttribution.test.ts
step server-adapters node "$VP" test run \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts \
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.fileChanges.test.ts \
  apps/server/src/orchestration-v2/Adapters/codexFileChanges.test.ts \
  apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts \
  apps/server/src/provider/acp/AcpRuntimeModel.test.ts \
  apps/server/src/provider/acp/AntigravityProtocol.test.ts
# Web component tests run from apps/web, as CI does: only its config applies the React Compiler,
# which the render-cost test measures.
step web-diff-panel web_tests \
  src/diffPanelStore.test.ts \
  src/diffFileActions.test.ts \
  src/components/DiffPanel.test.tsx
step web-timeline web_tests \
  src/components/chat/MessagesTimeline.logic.test.ts \
  src/components/chat/MessagesTimeline.toolActivity.test.ts \
  src/components/chat/MessagesTimeline.renderCost.test.tsx \
  src/components/chat/MessagesTimeline.activityDiffs.test.tsx \
  src/components/chat/MessagesTimeline.test.tsx
step web-inspector web_tests \
  src/components/chat/toolOutputPresentation.test.tsx \
  src/components/chat/V2ItemInspector.test.tsx \
  src/components/chat/ComposerPendingApprovalPanel.test.tsx \
  src/components/chat/ChangedFilesTree.test.tsx

step fixture-build node "$VP" build --config apps/web/tests/activity-diffs/vite.config.ts
step fixture-verify env PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never \
  STUDIO_PLAYWRIGHT_MODULE="${STUDIO_PLAYWRIGHT_MODULE:-$ROOT/apps/server/node_modules/playwright-core/index.mjs}" \
  node apps/web/tests/activity-diffs/verify.mjs "$FIXTURE_OUT"

step web-build bash -c "cd apps/web && node ../../node_modules/vite-plus/bin/vp build"
step server-build node apps/server/scripts/cli.ts build
step typecheck bash scripts/studio-verify/typecheck-gate.sh --out "$OUT/typecheck" \
  --package apps/server --package apps/web --package packages/contracts \
  --package packages/client-runtime --package packages/shared

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Activity diffs gate failed: ${FAILED[*]}"
  exit 1
fi
echo "Activity diffs gate passed; fixture captures in $FIXTURE_OUT"
