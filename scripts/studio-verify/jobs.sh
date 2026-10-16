# Job helpers sourced by pr-gate.sh, typecheck-gate.sh and scripts/studio-fleet/run-tests.sh
# (bash 3.2 and later).
#
# job_run OUT NAME LIMIT COMMAND [ARG...]
#   Runs COMMAND in a process group of its own, stdin from /dev/null, all output in
#   OUT/NAME.log, then writes OUT/NAME.exit (its exit code) and OUT/NAME.secs (wall seconds).
#   After LIMIT seconds it writes OUT/NAME.timeout and sends the group TERM, then KILL 15
#   seconds later. An INT, TERM or HUP to the calling shell stops the group at once.
#
# job_pool LIST JOBS COMMAND [ARG...]
#   Runs `COMMAND <line>` for every line of LIST, at most JOBS at a time (xargs -P), in a
#   process group of its own. Returns non-zero when any COMMAND did. An INT, TERM or HUP to the
#   calling shell (Ctrl-C, or the timeout of a gate that runs this one) stops the pool, and
#   through job_run every job in it, and the caller exits 130 or 143.
#
# Without the traps a stopped gate leaves its jobs running: a job runs in its own process
# group, so a terminal's Ctrl-C never reaches it, and a non-interactive shell's background
# jobs ignore INT.

JOB_PID=""
JOB_WATCHDOG=""
JOB_POOL=""

# TERM to the job's group, then KILL to whatever is left of it after 5 seconds.
job_stop() {
  local waited=0
  if [ -n "$JOB_WATCHDOG" ]; then kill -TERM "$JOB_WATCHDOG" 2>/dev/null || true; fi
  [ -n "$JOB_PID" ] || return 0
  kill -TERM -- "-$JOB_PID" 2>/dev/null || return 0
  while [ "$waited" -lt 5 ] && kill -0 -- "-$JOB_PID" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL -- "-$JOB_PID" 2>/dev/null || true
}

job_run() {
  local out="$1" name="$2" limit="$3" started code=0
  shift 3
  case "$limit" in
    '' | *[!0-9]* | 0)
      echo "job_run: time limit must be a positive number of seconds, not '$limit'" >&2
      return 2
      ;;
  esac
  started=$(date +%s)
  trap 'job_stop; exit 130' INT
  trap 'job_stop; exit 143' TERM HUP
  # Job control (set -m) gives the job its own process group, so stopping the group stops
  # every process it started; a background group that reads the terminal is stopped, hence
  # /dev/null.
  set -m
  "$@" < /dev/null > "$out/$name.log" 2>&1 &
  JOB_PID=$!
  set +m
  (
    sleeper=""
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    sleep "$limit" &
    sleeper=$!
    wait "$sleeper"
    : > "$out/$name.timeout"
    kill -TERM -- "-$JOB_PID" 2>/dev/null || exit 0
    sleep 15 &
    sleeper=$!
    wait "$sleeper"
    kill -KILL -- "-$JOB_PID" 2>/dev/null || true
  ) &
  JOB_WATCHDOG=$!
  wait "$JOB_PID" 2>/dev/null || code=$?
  kill -TERM "$JOB_WATCHDOG" 2>/dev/null || true
  wait "$JOB_WATCHDOG" 2>/dev/null || true
  # A timed-out job's leader can exit on TERM while processes it started ignore TERM.
  if [ -f "$out/$name.timeout" ]; then kill -KILL -- "-$JOB_PID" 2>/dev/null || true; fi
  trap - INT TERM HUP
  JOB_PID=""
  JOB_WATCHDOG=""
  echo $(($(date +%s) - started)) > "$out/$name.secs"
  echo "$code" > "$out/$name.exit"
}

# TERM to the pool's group: xargs and each job_run, which stops its own job. Returns once the
# group is gone (job_stop takes at most 5 seconds), or KILLs what is left after 10.
job_pool_stop() {
  local waited=0
  [ -n "$JOB_POOL" ] || return 0
  kill -TERM -- "-$JOB_POOL" 2>/dev/null || return 0
  wait "$JOB_POOL" 2>/dev/null || true
  while [ "$waited" -lt 10 ] && kill -0 -- "-$JOB_POOL" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL -- "-$JOB_POOL" 2>/dev/null || true
}

job_pool() {
  local list="$1" jobs="$2" code=0
  shift 2
  trap 'job_pool_stop; exit 130' INT
  trap 'job_pool_stop; exit 143' TERM HUP
  set -m
  xargs -n 1 -P "$jobs" "$@" < "$list" &
  JOB_POOL=$!
  set +m
  wait "$JOB_POOL" || code=$?
  trap - INT TERM HUP
  JOB_POOL=""
  return "$code"
}
