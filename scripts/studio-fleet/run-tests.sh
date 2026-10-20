#!/bin/bash
# Runs every fleet unit test (test-*.py and the node:test test-*.mjs files) in parallel, one
# log per test, then prints a pass/fail table. Exits non-zero when any test fails, times out
# or leaves no result, and when a new test-*.mjs file is neither a node:test file nor listed
# below as an acceptance proof, so no fleet test goes unrun without a reason.
#
#   bash scripts/studio-fleet/run-tests.sh [--out DIR] [--jobs N] [--history DIR]...
#   pnpm run test:fleet -- --out DIR
#
# --out   where <test>.log, <test>.exit, <test>.secs and summary.txt go (default: a new
#         temporary directory). Earlier results for the same tests there are replaced.
# --jobs  parallel tests, 1 to 4 (default 4). Several tests shell out to lsof and ps, which
#         time out under heavy host load, so this stays at 4 or below.
# --history  an earlier --out folder: tests start longest first by their <test>.secs there (the
#         first folder that has one wins; a test with none starts first), so a long test does
#         not start last. Without it, tests start in name order.
#
# Environment: STUDIO_TEST_NODE (Node 22 for the tests; default: node on PATH), PYTHON
# (default: python3), FLEET_TEST_TIMEOUT (seconds per test, default 900). Every test gets
# GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1, so personal git hooks and aliases
# cannot change a fixture, and the headless browser settings. Ctrl-C or a TERM stops every
# running test and the processes it started.
#
# Python tests run with `python3 -B`, never -I: -I drops the script directory from sys.path,
# and the tests import update, auth_heartbeat and launcher from it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SELF="$HERE/run-tests.sh"

# Not unit tests: each needs arguments a release run provides, and is run by that release step.
#   test-startup.mjs            starts a built server (--entrypoint) under a headless browser
#   test-installed-startup.mjs  reads the installed M4/M1/M3 services over the fleet ssh keys
ACCEPTANCE_PROOFS="test-startup.mjs test-installed-startup.mjs"

die() {
  echo "run-tests.sh: $*" >&2
  exit 2
}

is_acceptance_proof() {
  local name
  for name in $ACCEPTANCE_PROOFS; do
    [ "$name" = "$1" ] && return 0
  done
  return 1
}

# job_run and job_pool: each test in its own process group under a watchdog, stopped with the
# run on Ctrl-C or TERM.
. "$HERE/../studio-verify/jobs.sh"

# Internal: run one test under the watchdog; job_run records its exit code and wall seconds.
run_one() {
  local out="$1" name="$2"
  case "$name" in
    *.py) job_run "$out" "$name" "$LIMIT" "${PYTHON:-python3}" -B "$name" ;;
    *.mjs) job_run "$out" "$name" "$LIMIT" "$STUDIO_TEST_NODE" --test "$name" ;;
    *) die "not a fleet test: $name" ;;
  esac
}

LIMIT="${FLEET_TEST_TIMEOUT:-900}"
case "$LIMIT" in
  '' | *[!0-9]* | 0) die "FLEET_TEST_TIMEOUT must be a positive number of seconds" ;;
esac

if [ "${1:-}" = "--run-one" ]; then
  [ $# -eq 3 ] || die "usage: --run-one OUT TEST"
  cd "$HERE"
  run_one "$2" "$3"
  exit 0
fi

OUT=""
JOBS=4
HISTORY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift 2;;
    --jobs) [ $# -ge 2 ] || die "--jobs needs a number"; JOBS="$2"; shift 2;;
    --history) [ $# -ge 2 ] || die "--history needs a directory"; HISTORY+=("$2"); shift 2;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"; exit 0;;
    # pnpm run passes the `--` of `pnpm run <script> -- <options>` through.
    --) shift;;
    *) die "unknown option: $1 (see --help)";;
  esac
done
case "$JOBS" in
  1|2|3|4) ;;
  *) die "--jobs must be 1, 2, 3 or 4";;
esac
if [ -z "$OUT" ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/studio-fleet-tests.XXXXXX")"
else
  mkdir -p "$OUT"
  OUT="$(cd "$OUT" && pwd)"
fi
# Absolute before the cd below, like OUT: a relative --history would be looked up under
# scripts/studio-fleet and quietly leave the tests in name order.
if [ ${#HISTORY[@]} -gt 0 ]; then
  given=("${HISTORY[@]}")
  HISTORY=()
  for dir in "${given[@]}"; do
    if [ -d "$dir" ]; then
      HISTORY+=("$(cd "$dir" && pwd)")
    else
      echo "run-tests.sh: --history $dir is not a directory; ignoring it" >&2
    fi
  done
fi

if [ -z "${STUDIO_TEST_NODE:-}" ]; then
  STUDIO_TEST_NODE="$(command -v node || true)"
fi
[ -n "$STUDIO_TEST_NODE" ] && [ -x "$STUDIO_TEST_NODE" ] || die "Node 22 not found; set STUDIO_TEST_NODE"
command -v "${PYTHON:-python3}" > /dev/null || die "python3 not found; set PYTHON"
export STUDIO_TEST_NODE
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never
export PYTHONDONTWRITEBYTECODE=1

cd "$HERE"
LIST="$OUT/tests.txt"
SKIPPED=""
UNLISTED=""
: > "$LIST"
for test in test-*.py test-*.mjs; do
  [ -f "$test" ] || continue
  case "$test" in
    *.mjs)
      if is_acceptance_proof "$test"; then
        SKIPPED="$SKIPPED $test"
        continue
      fi
      if ! grep -qE "from ['\"]node:test['\"]" "$test"; then
        UNLISTED="$UNLISTED $test"
        continue
      fi
      ;;
  esac
  rm -f "$OUT/$test.log" "$OUT/$test.exit" "$OUT/$test.secs" "$OUT/$test.timeout"
  echo "$test" >> "$LIST"
done
[ -s "$LIST" ] || die "no fleet tests found in $HERE"
if [ ${#HISTORY[@]} -gt 0 ]; then
  while IFS= read -r test; do
    secs=100000
    for dir in "${HISTORY[@]}"; do
      if [ -s "$dir/$test.secs" ] && [ "$dir" != "$OUT" ]; then
        secs="$(cat "$dir/$test.secs")"
        break
      fi
    done
    case "$secs" in '' | *[!0-9]*) secs=100000 ;; esac
    printf '%s\t%s\n' "$secs" "$test"
  done < "$LIST" | sort -s -t "$(printf '\t')" -k1,1nr | cut -f2 > "$LIST.ordered"
  mv "$LIST.ordered" "$LIST"
fi

count=$(wc -l < "$LIST" | tr -d ' ')
echo "Running $count fleet tests, $JOBS at a time; logs in $OUT"
began=$(date +%s)
runner=0
job_pool "$LIST" "$JOBS" bash "$SELF" --run-one "$OUT" || runner=$?

failed=0
SUMMARY="$OUT/summary.txt"
{
  printf '%-42s %-8s %6s\n' "TEST" "RESULT" "SECS"
  while IFS= read -r test; do
    secs="-"
    [ -f "$OUT/$test.secs" ] && secs="$(cat "$OUT/$test.secs")"
    if [ -f "$OUT/$test.timeout" ]; then
      result="TIMEOUT"
    elif [ ! -f "$OUT/$test.exit" ]; then
      result="NO-RESULT"
    elif [ "$(cat "$OUT/$test.exit")" = "0" ]; then
      result="pass"
    else
      result="FAIL"
    fi
    printf '%-42s %-8s %6s\n' "$test" "$result" "$secs"
  done < "$LIST"
  for test in $SKIPPED; do
    printf '%-42s %-8s %6s\n' "$test" "skip" "-"
  done
  for test in $UNLISTED; do
    printf '%-42s %-8s %6s\n' "$test" "UNRUN" "-"
  done
} > "$SUMMARY"
cat "$SUMMARY"

while IFS= read -r test; do
  if [ -f "$OUT/$test.timeout" ] || [ "$(cat "$OUT/$test.exit" 2>/dev/null || echo missing)" != "0" ]; then
    failed=$((failed + 1))
    echo "--- $test (last 20 lines of $OUT/$test.log)" >&2
    tail -n 20 "$OUT/$test.log" >&2 2>/dev/null || true
    echo >&2
  fi
done < "$LIST"
for test in $UNLISTED; do
  failed=$((failed + 1))
  echo "--- $test is not a node:test file; run it here or list it in ACCEPTANCE_PROOFS with why" >&2
done

echo "Fleet tests: $count run, $failed failed, $(( $(date +%s) - began ))s; skipped acceptance proofs:${SKIPPED:- none}"
if [ "$runner" -ne 0 ] || [ "$failed" -ne 0 ]; then
  exit 1
fi
