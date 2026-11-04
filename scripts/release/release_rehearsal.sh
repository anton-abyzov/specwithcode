# Sourced by release.sh: the update rehearsal (scripts/studio-fleet/rehearse_update.py).
#
# The candidate's update agent and server run once on an APFS clone of this Mac's newest
# pre-update state copy, beside the server suite and after stage 1, and the release waits for its
# result before drafts: a candidate whose update would not reach verified on this Mac's own state,
# within its time budget, with every protected table unchanged and no config key lost, never gets
# a draft. The clone stays on this Mac and is removed afterwards, also on failure. A hosted runner
# (--ci) has no such state, so the rehearsal is skipped there. rehearsal.exit holds "SHA EXIT" once
# it has finished; its report is in logs/rehearsal.log.

start_rehearsal() {
  if [ "$CI_MODE" -eq 1 ]; then
    say "= rehearsal: skipped (--ci)"
    return 0
  fi
  if is_done rehearsal "$SHA"; then return 0; fi
  if [ "$MODE" = dry ]; then
    say "> rehearsal (background, alongside build..plan; waited on before drafts)"
    CURRENT_STAGE=rehearsal rehearsal_command
    return 0
  fi
  local sha="" rc="" pid=""
  if [ -f "$STAGE/rehearsal.exit" ]; then read -r sha rc < "$STAGE/rehearsal.exit"; fi
  if [ "$sha" = "$SHA" ] && [ "$rc" = 0 ]; then return 0; fi  # A failed one reruns on --resume.
  if [ -f "$STAGE/rehearsal.pid" ] && read -r pid sha < "$STAGE/rehearsal.pid" && [ "$sha" = "$SHA" ] &&
    kill -0 "$pid" 2> /dev/null; then
    say "= rehearsal: still running for $SHA12 (pid $pid)"
    return 0
  fi
  rm -f "$STAGE/rehearsal.exit"
  (
    set +e
    CURRENT_STAGE=rehearsal
    printf '\n===== %s rehearsal %s =====\n' "$(date -u +%FT%TZ)" "$SHA12"
    rehearsal_command
    state_write "$STAGE/rehearsal.exit" "$SHA $?"
  ) >> "$LOG_DIR/rehearsal.log" 2>&1 < /dev/null &
  printf '%s %s\n' "$!" "$SHA" > "$STAGE/rehearsal.pid"
  say "> rehearsal: started in the background (pid $!, log $LOG_DIR/rehearsal.log)"
}

rehearsal_command() {
  x rehearse -C "$TEST" -- "${NO_GH_TOKEN[@]}" python3 -B scripts/studio-fleet/rehearse_update.py --json \
    --server-entrypoint "$TEST/apps/server/src/bin.ts"
}

# Before drafts: wait for this candidate's rehearsal; stop the release if it did not pass.
rehearsal_wait() {
  local sha="" rc="" pid="" waited=0
  if [ "$CI_MODE" -eq 1 ] || [ "$MODE" = dry ] || is_done rehearsal "$SHA"; then return 0; fi
  while :; do
    if [ -f "$STAGE/rehearsal.exit" ]; then read -r sha rc < "$STAGE/rehearsal.exit"; fi
    if [ "$sha" = "$SHA" ] && [ -n "$rc" ]; then break; fi
    if [ -f "$STAGE/rehearsal.pid" ]; then read -r pid _ < "$STAGE/rehearsal.pid"; fi
    if [ -z "$pid" ] || ! kill -0 "$pid" 2> /dev/null; then
      sleep 1  # It may have written its result just now.
      if [ -f "$STAGE/rehearsal.exit" ]; then read -r sha rc < "$STAGE/rehearsal.exit"; fi
      if [ "$sha" = "$SHA" ] && [ -n "$rc" ]; then break; fi
      die "the update rehearsal for $SHA12 stopped without a result; log: $LOG_DIR/rehearsal.log; --resume reruns it"
    fi
    if [ $((waited % 60)) -eq 0 ] && [ "$waited" -gt 0 ]; then say "rehearsal: still running after about ${waited}s"; fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$rc" != 0 ]; then
    if [ -f "$LOG_DIR/rehearsal.log" ]; then tail -n 40 "$LOG_DIR/rehearsal.log"; fi
    drop_drafts  # An earlier candidate's drafts.
    die "the update rehearsal failed for $SHA12 (exit $rc); log: $LOG_DIR/rehearsal.log"
  fi
  mark_done rehearsal "$SHA"
  say "= rehearsal: passed for $SHA12"
}
