#!/bin/bash
# The local pull request gate (GitHub Actions is off for this repository). Run it on the PR
# branch before `gh pr merge`; it exits non-zero when anything fails.
#
#   bash scripts/studio-verify/pr-gate.sh [--base origin/main] [--out DIR] [--jobs N]
#                                          [--server-shards N] [--keep-going] [--only J]...
#   bash scripts/studio-verify/pr-gate.sh --list
#
# Stage 1, at most --jobs at a time (default 3):
#   - the theme contrast test (apps/web), first, because it fails in seconds
#   - `node --run test` in every workspace package except apps/server and the root
#     (`pnpm -r ls`), one process, log and exit code per package; the root's own `test`
#     (`vp run -r test`) would run every package again, the server included
#   - scripts/studio-verify/typecheck-gate.sh (fails only on diagnostics beyond the baseline)
#   - scripts/studio-fleet/run-tests.sh (every fleet test)
#   - a coverage guard: every workspace package with a `test` script is in stage 1 or is
#     apps/server, and no package has tracked *.test.* files without a `test` script, so a
#     new package or a package's first test cannot go unrun
# Stage 2, only when stage 1 passed (or with --keep-going): the server suite limited to the
# files vitest's module graph ties to changes since the merge base with --base, as
# --server-shards parallel shards (default 2) through scripts/release/test-sharded.mjs. A
# change to a package.json or vite config makes vitest run the whole server suite.
#
# --base     the branch the PR merges into (default origin/main); fetch it first
# --out      logs and exit codes (default: a new temporary directory)
# --list     print the jobs and the coverage guard's result without running anything
# --only J   run only stage-1 job J (contrast, typecheck, fleet or a package directory;
#            repeatable) and no server stage, to reproduce one failure. A partial run never
#            passes the gate: it exits 3 when what it ran passed.
#
# Environment: PR_GATE_TIMEOUT (seconds per stage-1 job, default 1200), VITEST_MAX_WORKERS
# (vitest workers per package suite, default 4). Ctrl-C or a TERM stops every job and shard.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/pr-gate.sh"

die() {
  echo "pr-gate.sh: $*" >&2
  exit 2
}

slug() {
  echo "$1" | sed 's#/#__#g'
}

job_command() {
  case "$1" in
    contrast)
      cd "$ROOT/apps/web"
      exec node "$ROOT/node_modules/vite-plus/bin/vp" test run --project unit src/themeContrastClasses.test.ts
      ;;
    typecheck)
      exec /bin/bash "$ROOT/scripts/studio-verify/typecheck-gate.sh" --out "$OUT_DIR/typecheck"
      ;;
    fleet)
      exec /bin/bash "$ROOT/scripts/studio-fleet/run-tests.sh" --out "$OUT_DIR/fleet"
      ;;
    pkg:*)
      if [ "${1#pkg:}" = apps/desktop ]; then
        node "$ROOT/apps/desktop/scripts/ensure-electron-runtime.mjs" || return $?
      fi
      cd "$ROOT/${1#pkg:}"
      exec node --run test
      ;;
    *)
      echo "unknown job $1" >&2
      exit 2
      ;;
  esac
}

# job_run and job_pool: each stage-1 job in its own process group under a watchdog, stopped
# with the gate on Ctrl-C or TERM.
. "$HERE/jobs.sh"

# Internal: run one stage-1 job under the watchdog; job_run records its exit code and secs.
run_one() {
  job_run "$OUT_DIR" "$(slug "$1" | sed 's/^pkg:/pkg-/')" "$LIMIT" job_command "$1"
}

LIMIT="${PR_GATE_TIMEOUT:-1200}"
case "$LIMIT" in
  '' | *[!0-9]* | 0) die "PR_GATE_TIMEOUT must be a positive number of seconds" ;;
esac

if [ "${1:-}" = "--run-one" ]; then
  [ $# -eq 3 ] || die "usage: --run-one OUT JOB"
  OUT_DIR="$2"
  export CI=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never
  export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-4}"
  run_one "$3"
  exit 0
fi

BASE="origin/main"
OUT=""
JOBS=3
SHARDS=2
KEEP_GOING=0
LIST=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || die "--base needs a ref"; BASE="$2"; shift 2;;
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift 2;;
    --jobs) [ $# -ge 2 ] || die "--jobs needs a number"; JOBS="$2"; shift 2;;
    --server-shards) [ $# -ge 2 ] || die "--server-shards needs a number"; SHARDS="$2"; shift 2;;
    --keep-going) KEEP_GOING=1; shift;;
    --list) LIST=1; shift;;
    --only) [ $# -ge 2 ] || die "--only needs a job"; ONLY="$ONLY ${2%/}"; shift 2;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"; exit 0;;
    # pnpm run passes the `--` of `pnpm run <script> -- <options>` through.
    --) shift;;
    *) die "unknown option: $1 (see --help)";;
  esac
done
case "$JOBS" in 1|2|3|4|5|6) ;; *) die "--jobs must be 1 to 6";; esac
case "$SHARDS" in 1|2|3|4|5|6) ;; *) die "--server-shards must be 1 to 6";; esac
[ -x "$ROOT/node_modules/vite-plus/bin/vp" ] || [ -f "$ROOT/node_modules/vite-plus/bin/vp" ] ||
  die "install dependencies first (pnpm install --frozen-lockfile)"
BASE_SHA="$(git -C "$ROOT" rev-parse --verify --quiet "$BASE^{commit}")" || die "unknown base $BASE; fetch it first"
MERGE_BASE="$(git -C "$ROOT" merge-base "$BASE_SHA" HEAD)" || die "no merge base between $BASE and HEAD"
if [ -z "$OUT" ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/studio-pr-gate.XXXXXX")"
else
  mkdir -p "$OUT"
  OUT="$(cd "$OUT" && pwd)"
fi

# Workspace packages as pnpm sees them: "<dir> <has test script: 1|0>", root excluded.
PACKAGES="$OUT/packages.txt"
(cd "$ROOT" && pnpm -r ls --depth -1 --json) | python3 -B -c '
import json, os, sys
root = sys.argv[1]
for item in json.load(sys.stdin):
    path = os.path.realpath(item["path"])
    if path == os.path.realpath(root):
        continue
    manifest = json.load(open(os.path.join(path, "package.json"), encoding="utf-8"))
    print(os.path.relpath(path, root), 1 if manifest.get("scripts", {}).get("test") else 0)
' "$ROOT" | sort > "$PACKAGES" || die "could not list the workspace packages with pnpm"
[ -s "$PACKAGES" ] || die "pnpm listed no workspace packages"

JOBLIST="$OUT/jobs.txt"
UNCOVERED=""
NOTESTS=""
{
  echo contrast
  echo typecheck
  echo fleet
} > "$JOBLIST"
while read -r dir has_test; do
  if [ "$has_test" != "1" ]; then
    NOTESTS="$NOTESTS $dir"
  elif [ "$dir" != "apps/server" ]; then
    echo "pkg:$dir" >> "$JOBLIST"
  fi
done < "$PACKAGES"
# The guard. A package with a test script that neither stage runs, or tracked test files in a
# package nothing runs (no test script), fails the gate whatever the reason it fell out.
while read -r dir has_test; do
  if [ "$has_test" = "1" ]; then
    [ "$dir" = "apps/server" ] || grep -qx "pkg:$dir" "$JOBLIST" || UNCOVERED="$UNCOVERED $dir"
  elif [ -n "$(git -C "$ROOT" ls-files -- ":(glob)$dir/**/*.test.*" | head -1)" ]; then
    UNCOVERED="$UNCOVERED $dir(test-files-without-a-test-script)"
  fi
done < "$PACKAGES"
grep -qx "apps/server 1" "$PACKAGES" || UNCOVERED="$UNCOVERED apps/server(no-test-script)"

if [ -n "$ONLY" ]; then
  : > "$JOBLIST.only"
  for job in $ONLY; do
    if grep -qx "$job" "$JOBLIST"; then
      echo "$job" >> "$JOBLIST.only"
    elif grep -qx "pkg:$job" "$JOBLIST"; then
      echo "pkg:$job" >> "$JOBLIST.only"
    else
      die "no stage-1 job $job (see --list)"
    fi
  done
  mv "$JOBLIST.only" "$JOBLIST"
fi

if [ "$LIST" -eq 1 ]; then
  echo "Stage 1 jobs:"
  sed 's/^pkg:/  package /; s/^\([a-z]*\)$/  \1/' "$JOBLIST"
  echo "Stage 2: apps/server, files changed since $(git -C "$ROOT" rev-parse --short "$MERGE_BASE") ($BASE), $SHARDS shards"
  [ -z "$NOTESTS" ] || echo "No test script:$NOTESTS"
  if [ -n "$UNCOVERED" ]; then
    echo "UNCOVERED:$UNCOVERED"
    exit 1
  fi
  echo "Coverage guard: every package with tests is covered"
  exit 0
fi

echo "PR gate: HEAD $(git -C "$ROOT" rev-parse --short HEAD) against $BASE (merge base $(git -C "$ROOT" rev-parse --short "$MERGE_BASE")); logs in $OUT"
echo "Stage 1: $(wc -l < "$JOBLIST" | tr -d ' ') jobs, $JOBS at a time"
began=$(date +%s)
runner=0
job_pool "$JOBLIST" "$JOBS" bash "$SELF" --run-one "$OUT" || runner=$?

stage1_failed=0
printf '%-44s %-8s %6s\n' "STAGE 1" "RESULT" "SECS"
while IFS= read -r job; do
  name="$(slug "$job" | sed 's/^pkg:/pkg-/')"
  secs="-"
  [ -f "$OUT/$name.secs" ] && secs="$(cat "$OUT/$name.secs")"
  if [ -f "$OUT/$name.timeout" ]; then
    result="TIMEOUT"
  elif [ ! -f "$OUT/$name.exit" ]; then
    result="NO-RESULT"
  elif [ "$(cat "$OUT/$name.exit")" = "0" ]; then
    result="pass"
  else
    result="FAIL"
  fi
  [ "$result" = "pass" ] || stage1_failed=$((stage1_failed + 1))
  printf '%-44s %-8s %6s\n' "${job#pkg:}" "$result" "$secs"
done < "$JOBLIST"
for dir in $UNCOVERED; do
  printf '%-44s %-8s %6s\n' "$dir" "UNCOVERED" "-"
  stage1_failed=$((stage1_failed + 1))
done
[ -z "$NOTESTS" ] || echo "No test script:$NOTESTS"
[ "$runner" -eq 0 ] || stage1_failed=$((stage1_failed + 1))

while IFS= read -r job; do
  name="$(slug "$job" | sed 's/^pkg:/pkg-/')"
  if [ -f "$OUT/$name.timeout" ] || [ "$(cat "$OUT/$name.exit" 2>/dev/null || echo missing)" != "0" ]; then
    echo "--- ${job#pkg:} (last 25 lines of $OUT/$name.log)" >&2
    tail -n 25 "$OUT/$name.log" >&2 2>/dev/null || true
    echo >&2
  fi
done < "$JOBLIST"

server_code="not-run"
if [ -n "$ONLY" ]; then
  echo "Stage 2: not run; --only runs stage-1 jobs alone"
elif [ "$stage1_failed" -eq 0 ] || [ "$KEEP_GOING" -eq 1 ]; then
  echo "Stage 2: server suite, files changed since $(git -C "$ROOT" rev-parse --short "$MERGE_BASE"), $SHARDS shards"
  # In the background so a Ctrl-C or TERM reaches the trap at once; test-sharded.mjs stops
  # its shards on TERM.
  node "$ROOT/scripts/release/test-sharded.mjs" --shards "$SHARDS" --out "$OUT/server" --changed "$MERGE_BASE" &
  server_pid=$!
  trap 'kill -TERM "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; exit 130' INT
  trap 'kill -TERM "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; exit 143' TERM HUP
  server_code=0
  wait "$server_pid" || server_code=$?
  trap - INT TERM HUP
else
  echo "Stage 2: not run; stage 1 failed (--keep-going runs it anyway)"
fi

echo "PR gate: stage 1 $([ "$stage1_failed" -eq 0 ] && echo passed || echo "FAILED ($stage1_failed)"), server $([ "$server_code" = "0" ] && echo passed || echo "$server_code"), $(( $(date +%s) - began ))s"
if [ "$stage1_failed" -ne 0 ]; then
  exit 1
fi
if [ -n "$ONLY" ]; then
  echo "PR gate: partial run (--only$ONLY); not a pass" >&2
  exit 3
fi
if [ "$server_code" != "0" ]; then
  exit 1
fi
