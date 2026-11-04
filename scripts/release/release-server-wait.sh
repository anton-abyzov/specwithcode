# shellcheck shell=bash
# The server suite's result and server-wait, moved out of release.sh (at its 1500-line cap) for
# increment 1239. They use release.sh's MODE, SHA, SHA12, STAGE, LOG_DIR, TIMINGS, TOOLS, POLL and its
# say, die, is_done, server_alive, attempt_of and drop_drafts.

# The current candidate's server result: its exit code, or nothing while it has none.
server_result() {
  local sha="" rc=""
  if is_done server "$SHA"; then
    printf '0\n'
    return 0
  fi
  if [ -f "$STAGE/server.exit" ]; then read -r sha rc < "$STAGE/server.exit"; fi
  if [ "$sha" = "$SHA" ] && [ -n "$rc" ]; then printf '%s\n' "$rc"; fi
  return 0
}

# The server suite runs in the background from stage 1 on. Once it has failed, stop before the
# next bundle, signing, plan or drafts stage rather than finish a candidate that cannot ship.
# A --stage job never acts on it: only the test.server jobs own the suite's result, and the stages
# after them need its markers (stage_needs_check), not a server.exit an earlier run left.
stop_if_server_failed() {
  local rc
  [ -z "$STAGE_ONLY" ] || return 0
  rc="$(server_result)"
  if [ -z "$rc" ] || [ "$rc" = 0 ]; then return 0; fi
  if [ -f "$LOG_DIR/server.log" ]; then tail -n 40 "$LOG_DIR/server.log"; fi
  drop_drafts  # An earlier candidate's drafts.
  die "the server suite failed for $SHA12 (exit $rc); fix, commit in $BUILD and --resume (reruns only changed files)"
}

stage_server_wait() {
  local pid="" sha="" rc="" started noted flakes attempt
  if [ "$MODE" = dry ]; then
    say "    wait for the background server suite; fail here if it failed"
    return 0
  fi
  if [ "$MODE" = stub ]; then POLL=0.2; fi
  started=$(date +%s)
  noted=$started
  while :; do
    rc="$(server_result)"
    if [ -n "$rc" ]; then break; fi
    pid="" sha=""
    if [ -f "$STAGE/server.pid" ]; then read -r pid sha _ < "$STAGE/server.pid"; fi
    if [ "$sha" != "$SHA" ] || ! server_alive "$pid"; then
      sleep 1  # It may have written its result just after the first look.
      rc="$(server_result)"
      if [ -n "$rc" ]; then break; fi
      die "the server suite for $SHA12 stopped without a result; see $LOG_DIR/server.log, then --resume"
    fi
    sleep "$POLL"
    if [ $(($(date +%s) - noted)) -ge 120 ]; then
      noted=$(date +%s)
      say "server-wait: still running after about $((noted - started))s"
    fi
  done
  if [ "$rc" != 0 ]; then
    tail -n 40 "$LOG_DIR/server.log"
    drop_drafts
    die "the server suite failed for $SHA12 (exit $rc); fix, commit in $BUILD and --resume (reruns only changed files)"
  fi
  # Only the retries of the run that gave this result: an earlier attempt on the same candidate may
  # have retried files of its own. That run is the newest server line in stages.jsonl, which
  # internal_server writes before its result.
  attempt=$(($(attempt_of server) - 1))
  flakes="$(python3 -B "$TOOLS" timing retries --file "$TIMINGS/retries.jsonl" --stage server --sha "$SHA12" \
    --attempt "$attempt" --result passed)"
  if [ -n "$flakes" ]; then
    say "server: green for $SHA12, after a retry of: ${flakes//$'\n'/ } (FLAKY)"
  else
    say "server: green for $SHA12"
  fi
}
