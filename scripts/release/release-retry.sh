# Sourced by release.sh: the one retry a flaky stage-1 job or server test file gets. Each failed
# job or file runs once more on the same candidate; a second failure fails the stage as before.
# Uses release.sh's say, q, x, pool, record_retry and its globals (STAGE, SHA12, RETRY, ...).

# retry_jobs OUT SPEC...: each failed job once more, one at a time, on the same candidate. The
# first tries move to OUT/try-1; a job that passes now was a flake and is recorded as one.
retry_jobs() {
  local out="$1" spec name file result detail names=""
  local JOBS=1  # pool reads JOBS, so the retries run alone (bash scoping is dynamic).
  shift
  mkdir -p "$out/try-1"
  for spec in "$@"; do
    name="${spec%%|*}"
    names="$names $name"
    for file in "$out/$name.log" "$out/$name.exit" "$out/$name.secs" "$out/$name"; do
      if [ -e "$file" ]; then mv "$file" "$out/try-1/"; fi
    done
  done
  say "----- stage1 retry:$names failed; running each once more, alone (first tries in $out/try-1) -----"
  pool "$out" "$@"
  for spec in "$@"; do
    name="${spec%%|*}"
    result=failed
    if [ "$(cat "$out/$name.exit")" = 0 ]; then result=passed; fi
    detail=""
    if [ -f "$out/try-1/$name/summary.txt" ]; then
      detail="$(grep -E ' (FAIL|TIMEOUT|NO-RESULT) ' "$out/try-1/$name/summary.txt" | awk '{print $1}' | paste -sd, - || true)"
    fi
    record_retry stage1 "$name" "$(cat "$out/try-1/$name.secs")" "$(cat "$out/$name.secs")" "$result" \
      "$out/try-1/$name.log" "$detail"
    if [ "$result" = passed ]; then
      say "stage1: FLAKE $name${detail:+ ($detail)}: failed, then passed on retry (same candidate $SHA12)"
    else
      say "stage1: $name failed again on retry"
    fi
  done
}

# run_group OUT SPEC...: the jobs, then one retry of the failures when they look like a flake
# (at most RETRY_MAX_JOBS); more failures than that are a break, and a retry would only cost time.
run_group() {
  local out="$1" spec bad=()
  shift
  pool "$out" "$@"
  for spec in "$@"; do
    if [ "$(cat "$out/${spec%%|*}.exit")" != 0 ]; then bad+=("$spec"); fi
  done
  [ ${#bad[@]} -gt 0 ] || return 0
  # Written before the retry, so a run killed during it still resumes with the failures first.
  printf '%s\n' "${bad[@]%%|*}" > "$STAGE/stage1/failed.txt"
  if [ "$RETRY" -eq 0 ]; then
    say "stage1: ${#bad[@]} job(s) failed; --no-retry, so none runs again"
  elif [ ${#bad[@]} -gt "$RETRY_MAX_JOBS" ]; then
    say "stage1: ${#bad[@]} jobs failed, more than $RETRY_MAX_JOBS: a break, not a flake; no retry"
  else
    retry_jobs "$out" "${bad[@]}"
  fi
}

# retry_server_files OUT: after a failed server run, its failed files once more, as one shard.
# No retry when a shard crashed or timed out (no file to blame) or too many files failed.
retry_server_files() {
  local out="$1" files=() secs=() file sec listing again="" started rc=0 result
  if [ "$RETRY" -eq 0 ]; then
    say "server: failed; --no-retry, so no file runs again"
    return 1
  fi
  listing="$(q server-failed-files --may-fail -- python3 -B "$TOOLS" shard-failures --summary "$out/shards.json" \
    --max "$RETRY_MAX_FILES")"
  while IFS="$(printf '\t')" read -r file sec; do
    if [ -n "$file" ]; then
      files+=("$file")
      secs+=("${sec:-0}")
    fi
  done << EOF
$listing
EOF
  if [ ${#files[@]} -eq 0 ]; then
    say "server: no retry (a shard crashed or timed out, or more than $RETRY_MAX_FILES files failed)"
    return 1
  fi
  say "----- server retry: ${files[*]} failed; running only these once more, as one shard -----"
  started=$(date +%s)
  x server-retry -C "$TEST" -- env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
    CI=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    node scripts/release/test-sharded.mjs --shards 1 --out "$out/retry-1" -- "${files[@]}" || rc=$?
  if [ "$rc" -ne 0 ]; then
    again="$(q server-failed-again --may-fail -- python3 -B "$TOOLS" shard-failures --summary "$out/retry-1/shards.json" \
      --max 1000 --names)"
  fi
  local index=0
  for file in "${files[@]}"; do
    result=passed
    if [ "$rc" -ne 0 ] && { [ -z "$again" ] || grep -qxF "$file" <<< "$again"; }; then result=failed; fi
    record_retry server "$file" "${secs[$index]}" "$(($(date +%s) - started))" "$result" "$out/shards.json"
    if [ "$result" = passed ]; then say "server: FLAKE $file: failed, then passed on retry"; else say "server: $file failed again on retry"; fi
    index=$((index + 1))
  done
  return "$rc"
}
