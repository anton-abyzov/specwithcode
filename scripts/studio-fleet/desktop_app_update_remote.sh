#!/bin/bash
# Installs SpecWithCode $V in /Applications on a fleet Mac. fleet_rollout.py streams it to M1 and
# M3 (bash -s over the fleet ssh key) once that Mac's service runs $V. By hand:
#
#   ssh <worker> 'V=1.0.68 SHA=<sha256> /bin/bash -s' < scripts/studio-fleet/desktop_app_update_remote.sh
#   ssh <worker> 'DRY_RUN=1 V=1.0.68 SHA=<sha256> /bin/bash -s' < scripts/studio-fleet/desktop_app_update_remote.sh
#
# SHA is the zip's line in the release's SHA256SUMS. The zip comes from the public mirror's release
# (REPO, default anton-abyzov/specwithcode), which publish-public fills before fleet-workers runs.
# The order is release.sh's desktop stage (PR #900): the Mac is never left without a working app,
# and the previous app goes to the Trash, never rm.
#   1. Repair a run cut short: an unpack folder left behind is removed; a previous app left at
#      SpecWithCode.app.release-old goes back when nothing took its place, else to the Trash.
#   2. Wait while the app's own update runs (its Squirrel ShipIt, or an unsigned build's swap). While
#      the app runs, its ShipIt only waits for it to quit: step 6 lets it install then.
#   3. Done when the installed app is $V and passes the checks of step 5. A previous app that could
#      not go to the Trash stops the run here, before anything is downloaded or quit.
#   4. Download SpecWithCode-$V-arm64.zip and check its sha256; nothing changes until it matches.
#   5. Unpack it beside the app (/Applications/.SpecWithCode.app-$V-unpack: same volume, hidden
#      from Launch Services) and check that copy: version, codesign, the release's designated
#      requirement, Gatekeeper. A copy that fails is removed and the installed app stays as it was.
#   6. Quit the app (TERM to the exact /Applications/SpecWithCode.app process, then wait) and let
#      its own updater (ShipIt) install on quit; when that put $V in, keep it.
#   7. Otherwise rename the installed app to SpecWithCode.app.release-old, rename the checked copy
#      in, check it there (a failure puts the previous app back), then move the previous app to
#      the Trash.
#   8. Reopen the app only if it was running.
#
# DRY_RUN=1 only reads and reports: nothing is downloaded, quit, renamed, trashed or opened.
# Success ends with "RESULT before=<v> after=<v> how=<already-current|updater-on-quit|swapped|dry-run>
# relaunched=<yes|no|failed>" and exit 0. A failure ends with "FAIL <reason>" and exit 2 for a bad
# value or missing tool, 3 for the download or its sha256, 4 when another run, the app, its own
# updater or a previous app left at SpecWithCode.app.release-old is in the way, 5 for no room or a
# copy that cannot be unpacked or fails a check (after the rename too: the previous app is then back),
# and 6 when a rename failed (the reason says where each app is). The update cache or its lock that
# mkdir refuses for another reason than no room (a permission, a file in the way) ends with exit 1 and
# mkdir's own reason; a stop nobody planned says "stopped unexpectedly (exit <n>) at: <command>".
# Tests override paths, waits and tools: SWC_APP_DIR, SWC_CACHE_DIR, SWC_REQUIREMENT, SWC_POLL,
# SWC_QUIT_WAIT, SWC_SHIPIT_GRACE, SWC_SHIPIT_WAIT, SWC_LAUNCH_WAIT, SWC_LOCK_WAIT, and SWC_CURL,
# SWC_SHASUM, SWC_PLISTBUDDY, SWC_CODESIGN, SWC_SPCTL, SWC_DITTO, SWC_UNZIP, SWC_DF, SWC_PGREP,
# SWC_PS, SWC_STAT, SWC_DATE, SWC_OPEN, SWC_TRASH, SWC_OSASCRIPT.
#
# Everything runs from main, called on the last line: a stream cut short runs nothing. A session
# dropped while it runs does not stop it halfway: SIGPIPE and SIGHUP are ignored, output then goes
# nowhere, and the run finishes (the app reopened if it quit it) or fails cleanly. SIGINT or SIGTERM
# (kill on the worker, or Ctrl-C at a terminal there) stops it once the command it waits on ends, as
# a failure with exit 130 or 143 and "stopped by SIGINT" or "stopped by SIGTERM": it opens the app
# again if it quit it, once it has gone, unless the app's own updater runs. From the swap's first
# rename until the app renamed in passes its checks, a stop is ignored and the run goes on. Ctrl-C
# at the terminal of the ssh commands above ends only ssh: the run goes on, its session dropped.

# The requirement every release since 1.0.32 carries (mac-signature.mjs expectedRequirement());
# macOS keys the privacy grants to it, and only the release team's signature satisfies it.
RELEASE_REQUIREMENT='identifier "com.specweave.studio" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = NMCB2JZ7QG'

# Never fatal: see signals' trap '' PIPE. In a subshell: bash 3.2 keeps a write that failed (once the session
# dropped) in this shell's buffer, and every later $(...) and redirected builtin would carry it out.
say() { (printf '%s\n' "$*") 2> /dev/null || true; }

dry() { [ "$DRY_RUN" = 1 ]; }

die() { # die CODE REASON: the EXIT trap cleans up, then prints "FAIL REASON" last
  REASON="$2"
  exit "$1"
}

# mkdir_failed WHAT ERROR: a folder the volume has no room for stops with exit 5; one mkdir refuses for
# another reason (permissions, a file in the way) stops with exit 1 and mkdir's own reason.
mkdir_failed() {
  case "$2" in *'No space left on device'* | *'quota exceeded'*) die 5 "could not make $1 ($2; is the disk full?)" ;; esac
  die 1 "could not make $1 (${2:-mkdir failed})"
}

# A dropped session stops nothing (SIGPIPE, and SIGHUP for one with a terminal). SIGINT or SIGTERM stops the run as
# a failure, so finish cleans up and opens an app this run quit again: without these traps bash 3.2 runs the EXIT
# trap with the last command's status, 0 in a wait, and the stop reads as a success.
signals() {
  trap '' PIPE HUP
  trap 'die 130 "stopped by SIGINT"' INT
  trap 'die 143 "stopped by SIGTERM"' TERM
}

init() {
  APP_DIR="${SWC_APP_DIR:-/Applications}"
  APP="$APP_DIR/SpecWithCode.app"
  EXE="$APP/Contents/MacOS/SpecWithCode"
  SHIPIT="$APP/Contents/Frameworks/Squirrel.framework/Resources/ShipIt"
  OLD="$APP.release-old"
  UNPACK="$APP_DIR/.SpecWithCode.app-$V-unpack"
  FRESH="$UNPACK/SpecWithCode.app"
  CACHE="${SWC_CACHE_DIR:-$HOME/.specwithcode/backups/desktop-app-updates}"
  LOCK="$CACHE/.lock"
  ZIP="$CACHE/SpecWithCode-$V-arm64.zip"
  URL="https://github.com/$REPO/releases/download/v$V/SpecWithCode-$V-arm64.zip"
  REQUIREMENT="${SWC_REQUIREMENT:-$RELEASE_REQUIREMENT}"
  POLL="${SWC_POLL:-1}"
  QUIT_WAIT="${SWC_QUIT_WAIT:-60}"
  SHIPIT_GRACE="${SWC_SHIPIT_GRACE:-5}"
  SHIPIT_WAIT="${SWC_SHIPIT_WAIT:-90}"
  LAUNCH_WAIT="${SWC_LAUNCH_WAIT:-10}"
  LOCK_WAIT="${SWC_LOCK_WAIT:-2}"
  CURL="${SWC_CURL:-/usr/bin/curl}"
  SHASUM="${SWC_SHASUM:-/usr/bin/shasum}"
  PLISTBUDDY="${SWC_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
  CODESIGN="${SWC_CODESIGN:-/usr/bin/codesign}"
  SPCTL="${SWC_SPCTL:-/usr/sbin/spctl}"
  DITTO="${SWC_DITTO:-/usr/bin/ditto}"
  UNZIP="${SWC_UNZIP:-/usr/bin/unzip}"
  DF="${SWC_DF:-/bin/df}"
  PGREP="${SWC_PGREP:-/usr/bin/pgrep}"
  PS="${SWC_PS:-/bin/ps}"
  STAT="${SWC_STAT:-/usr/bin/stat}"
  DATE="${SWC_DATE:-/bin/date}"
  OPEN="${SWC_OPEN:-/usr/bin/open}"
  TRASH="${SWC_TRASH:-/usr/bin/trash}"
  OSASCRIPT="${SWC_OSASCRIPT:-/usr/bin/osascript}"
}

finish() {
  local rc=$? busy
  trap - EXIT
  # The cleanup runs to the end: another stop is ignored, by its commands too (Ctrl-C at a terminal reaches them all,
  # and a wait whose pgrep it ended would read as an app that has gone).
  trap '' INT TERM
  set +eu
  if [ "$rc" -ne 0 ]; then
    if [ -n "$UNPACK_MADE" ]; then rm -rf "$UNPACK"; fi
    # The app was running and this run quit it: open whichever app is in place again, once the app has gone
    # (a run stopped while it quits waits for that, until the quit's own deadline), unless the app's own updater
    # runs: it installs on the quit, as settle waits for.
    if [ "$QUIT" = 1 ] && [ "$LEAVE_CLOSED" != 1 ] && [ -d "$APP" ]; then
      while [ -n "$QUIT_BY" ] && [ "$SECONDS" -lt "$QUIT_BY" ] && [ -n "$(running_pids)" ]; do sleep "$POLL"; done
      if [ -z "$(running_pids)" ]; then
        busy="$(own_update)"
        if [ -z "$busy" ]; then
          reopen
        else
          say "WARNING: left the app closed while $busy runs; open it on that Mac once that has finished"
        fi
      fi
    fi
    [ -n "$REASON" ] || REASON="stopped unexpectedly (exit $rc) at: ${FAILED_COMMAND:-unknown}"
    say "FAIL $REASON"
  fi
  # Only this run's lock: one another run took over stays with that run. A lock left without a live
  # run's record (its record failed to write, say) is this run's while it is the directory it made.
  if [ -n "$LOCKED" ]; then
    case "$(lock_holder)" in
      "$$") release_lock ;;
      '' | starting)
        if [ -n "$LOCK_ID" ] && [ "$("$STAT" -f %i "$LOCK" 2> /dev/null)" = "$LOCK_ID" ]; then release_lock; fi
        ;;
    esac
  fi
  exit "$rc"
}

app_version() { # app_version BUNDLE: its CFBundleShortVersionString, or nothing
  "$PLISTBUDDY" -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2> /dev/null || true
}

sha_of() { "$SHASUM" -a 256 "$1" 2> /dev/null | cut -d' ' -f1 || true; }

signed() { "$CODESIGN" --verify --deep --strict "$1" > /dev/null 2>&1; }

# The pids of processes named SpecWithCode that run this app's own executable, matched as
# release.sh's quit-desktop stage does; a helper or another copy of the app is never one of them.
running_pids() {
  local pid
  for pid in $("$PGREP" -x SpecWithCode 2> /dev/null || true); do
    if [ "$("$PS" -o comm= -p "$pid" 2> /dev/null || true)" = "$EXE" ]; then printf '%s\n' "$pid"; fi
  done
  return 0
}

# What says the app's own update is still under way, or nothing: an unsigned build's swap.sh keeps
# SpecWithCode.app.studio-update-old until it is done; a signed build's Squirrel.Mac runs the ShipIt
# from this app's own Squirrel.framework. Squirrel.Mac starts that ShipIt as soon as the app has
# staged an update, and it changes nothing until the app quits: with "swap-only" (the app runs, not
# quit by this run), only the swap counts.
own_update() { # own_update [swap-only]
  local pid
  if [ -e "$APP.studio-update-old" ]; then
    printf 'its own update swap (%s exists)\n' "$APP.studio-update-old"
    return 0
  fi
  if [ "${1:-}" = swap-only ]; then return 0; fi
  for pid in $("$PGREP" -x ShipIt 2> /dev/null || true); do
    if [ "$("$PS" -o comm= -p "$pid" 2> /dev/null || true)" = "$SHIPIT" ]; then
      printf 'its own updater (ShipIt, pid %s)\n' "$pid"
      return 0
    fi
  done
  return 0
}

# run_limited SECONDS CMD...: runs CMD, its output dropped, and stops it (TERM to the pid it started) after SECONDS.
# CMD's own redirection: one on this function's call would stay on this shell when a stop ends the run inside it, and
# finish's lines would go nowhere.
run_limited() {
  local limit="$1" pid deadline rc=0
  shift
  "$@" > /dev/null 2>&1 &
  pid=$!
  deadline=$((SECONDS + limit))
  while kill -0 "$pid" 2> /dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill -TERM "$pid" 2> /dev/null || true
      wait "$pid" 2> /dev/null || true
      return 124
    fi
    sleep "$POLL"
  done
  wait "$pid" 2> /dev/null || rc=$?
  return "$rc"
}

# started PID: when that process started, as single-spaced words (ps pads them), or nothing.
started() { "$PS" -o lstart= -p "$1" 2> /dev/null | awk '{ $1 = $1; print }' || true; }

# The pid of the run that holds the lock, or nothing. The lock names its run by pid and start time:
# a run stopped by a power loss or SIGKILL keeps its lock, and its pid alone may belong to any other
# process by the next run (after a reboot, say), which would then stop every run and the repair.
# A lock without all of its record yet ("starting": the record is two writes) is a run between its
# mkdir and its record, for up to 10 seconds; one older than that is a run that stopped there.
lock_holder() {
  local pid="" start="" made now
  { read -r pid && read -r start; } 2> /dev/null < "$LOCK/pid" || true
  case "$pid" in '' | *[!0-9]*) start="" ;; esac
  if [ -z "$start" ]; then
    made="$("$STAT" -f %m "$LOCK" 2> /dev/null || true)"
    now="$("$DATE" +%s 2> /dev/null || true)"
    case "$made:$now" in :* | *: | *[!0-9:]*) return 0 ;; esac
    if [ $((now - made)) -lt 10 ]; then printf 'starting\n'; fi
    return 0
  fi
  if [ "$(started "$pid")" = "$start" ]; then printf '%s\n' "$pid"; fi
  return 0
}

# Moves the lock aside, then removes it: a run judging it meanwhile sees all of it or none of it, never a
# lock whose record went first, which it would take for a run that is starting. When the rename fails
# (a full volume refuses it, or another run moved the lock first) a lock that stands is removed in
# place, so it is never left behind; a record another run writes into it meanwhile keeps it, and the
# mkdir that follows leaves it to that run. Whichever lock this removes, the record each run reads
# again after LOCK_WAIT decides which run goes on.
release_lock() {
  local aside="$CACHE/.lock-gone-$$"
  rm -rf "$aside"
  if mv "$LOCK" "$aside" 2> /dev/null; then
    rm -rf "$aside"
  elif [ -e "$LOCK" ]; then
    rm -rf "$LOCK" 2> /dev/null || true
  fi
}

# Only a folder is a lock: anything else at its path (a file, a link) is in the way. One lstat decides, so a lock its
# run releases meanwhile is never taken for a file.
lock_in_the_way() {
  case "$("$STAT" -f %HT "$LOCK" 2> /dev/null || true)" in '' | Directory) return 1 ;; esac
  return 0
}

take_lock() {
  local holder me seen now err
  if dry; then
    if lock_in_the_way; then
      say "$LOCK is not a folder: a real run stops on it (exit 1) and leaves it there"
      return 0
    fi
    holder="$(lock_holder)"
    case "$holder" in
      '') ;;
      starting) say "another update of this app is starting" ;;
      *) say "another update of this app runs (pid $holder)" ;;
    esac
    return 0
  fi
  # A worker's first run makes the folder, which a full volume refuses as it would the lock.
  err="$(mkdir -p "$CACHE" 2>&1)" || mkdir_failed "the update cache" "${err:-mkdir -p $CACHE failed}"
  me="$(started "$$")" # Read first: the record follows the mkdir at once.
  if ! err="$(mkdir "$LOCK" 2>&1)"; then
    # A file or a link in its place is refused as mkdir refused it, never taken over.
    if lock_in_the_way; then mkdir_failed "the update lock" "$err"; fi
    seen="$("$STAT" -f %i "$LOCK" 2> /dev/null || true)" # The lock judged below.
    holder="$(lock_holder)"
    case "$holder" in
      '') ;;
      starting) die 4 "another update of this app is starting; let it finish" ;;
      *) die 4 "another update of this app runs (pid $holder); let it finish" ;;
    esac
    # Remove only the lock judged gone: one made since (by a run that judged it gone too, or after it
    # was released) is that run's. A lock its run released meanwhile is free to take.
    now="$("$STAT" -f %i "$LOCK" 2> /dev/null || true)"
    if [ -n "$now" ]; then
      [ "$now" = "$seen" ] || die 4 "another update of this app took the lock first; let it finish"
      say "took over the update lock of a run that is gone"
      release_lock
    fi
    if ! err="$(mkdir "$LOCK" 2>&1)"; then
      # Another run made it meanwhile, also when a third run that judged the same lock gone moved it aside since.
      case "$err" in *'File exists'*) die 4 "another update of this app took the lock first; let it finish" ;; esac
      [ ! -e "$LOCK" ] || die 4 "another update of this app took the lock first; let it finish"
      mkdir_failed "the update lock" "${err:-mkdir $LOCK failed}"
    fi
  fi
  LOCKED=1
  LOCK_ID="$("$STAT" -f %i "$LOCK" 2> /dev/null || true)"
  # Written by a subshell whose output is the record, as say: a write the disk refuses would stay in
  # this shell's buffer. In braces: bash 3.2 drops the ! of a subshell whose own redirection fails.
  if ! { (printf '%s\n%s\n' "$$" "$me") > "$LOCK/pid"; } 2> /dev/null; then
    # Gone before its record: another run that judged the lock this one replaced gone removed it.
    [ -n "$LOCK_ID" ] && [ "$("$STAT" -f %i "$LOCK" 2> /dev/null || true)" = "$LOCK_ID" ] ||
      die 4 "another update of this app took the lock over as this one did; let it finish"
    die 5 "could not write this run's record in $LOCK (is the disk full?)"
  fi
  # Another run that judged the same lock gone may have removed this one and made its own meanwhile:
  # the run whose record stands goes on and the other stops here, unless one of them stalled for
  # longer than LOCK_WAIT between judging the lock and writing its record.
  sleep "$LOCK_WAIT"
  [ "$(lock_holder)" = "$$" ] || die 4 "another update of this app took the lock over as this one did; let it finish"
  # A run stopped between release_lock's rename and its rm (a kill, a power loss) leaves its folder
  # aside, and no run with another pid removes it: the run holding the lock does.
  rm -rf "$CACHE"/.lock-gone-* 2> /dev/null || true
}

trash_old() {
  if [ ! -e "$OLD" ]; then return 0; fi
  if dry; then
    say "would move $OLD to the Trash"
    return 0
  fi
  # /usr/bin/trash (macOS 15) needs no Finder and no Apple events; Finder is the older route.
  if [ -x "$TRASH" ] && run_limited 60 "$TRASH" "$OLD" && [ ! -e "$OLD" ]; then
    say "moved the previous app to the Trash"
  elif run_limited 60 "$OSASCRIPT" -e "tell application \"Finder\" to delete POSIX file \"$OLD\"" &&
    [ ! -e "$OLD" ]; then
    say "moved the previous app to the Trash (Finder)"
  else
    say "WARNING: could not move $OLD to the Trash; it stays there, and the next run tries again"
  fi
}

# An earlier run cut short leaves a partial copy in its hidden unpack folder, or stopped between
# its two renames: the previous app goes back when nothing took its place, or to the Trash it was
# headed for when the new one made it in.
repair() {
  local stale
  for stale in "$APP_DIR"/.SpecWithCode.app-*-unpack; do
    if [ ! -d "$stale" ]; then continue; fi
    if dry; then
      say "would remove $stale, an unpack folder an earlier run left"
    else
      rm -rf "$stale"
      say "removed $stale, an unpack folder an earlier run left"
    fi
  done
  if [ ! -d "$OLD" ]; then return 0; fi
  if [ ! -e "$APP" ]; then
    if dry; then
      say "would put the previous app back from $OLD (an earlier run stopped between its renames)"
    else
      mv "$OLD" "$APP" || die 6 "could not put the previous app back from $OLD to $APP"
      say "put the previous app back from $OLD: an earlier run stopped between its renames"
    fi
  else
    trash_old
  fi
}

# Waits while the app's own update runs (with swap-only, only its swap: see own_update); after a
# quit, also up to GRACE seconds for ShipIt to start.
settle() { # settle GRACE [swap-only]
  local grace="$1" only="${2:-}" start=$SECONDS busy seen=""
  while :; do
    busy="$(own_update "$only")"
    if [ -n "$busy" ]; then
      if dry; then
        say "the app's own update runs now: $busy"
        return 0
      fi
      if [ -z "$seen" ]; then say "waiting for $busy to finish"; fi
      seen=1
      if [ $((SECONDS - start)) -ge "$SHIPIT_WAIT" ]; then
        LEAVE_CLOSED=1
        die 4 "$busy still runs after ${SHIPIT_WAIT}s; let it finish, then run this again"
      fi
    elif [ -n "$seen" ] || [ $((SECONDS - start)) -ge "$grace" ] || dry; then
      return 0
    fi
    sleep "$POLL"
  done
}

fetch_zip() {
  local got
  if [ -f "$ZIP" ] && [ "$(sha_of "$ZIP")" = "$SHA" ]; then
    say "the release zip is already here and matches SHA256SUMS: $ZIP"
    return 0
  fi
  if dry; then
    say "would download $URL and check it against SHA256SUMS"
    return 0
  fi
  rm -f "$ZIP.part"
  say "downloading $URL"
  "$CURL" -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 1800 \
    -o "$ZIP.part" "$URL" || die 3 "could not download $URL (curl exit $?); nothing was changed"
  got="$(sha_of "$ZIP.part")"
  if [ "$got" != "$SHA" ]; then
    rm -f "$ZIP.part"
    die 3 "the downloaded zip's sha256 is ${got:-unreadable}, not $SHA from the release's SHA256SUMS; nothing was changed"
  fi
  mv -f "$ZIP.part" "$ZIP"
  say "downloaded the release zip; its sha256 matches SHA256SUMS"
}

# A full disk cut the 1.0.101 install short on M4: unpack only with room for the whole app and 512 MiB.
check_space() {
  local bytes need avail
  bytes="$("$UNZIP" -Zt "$ZIP" 2> /dev/null | sed -n 's/^[0-9]* files*, \([0-9]*\) bytes uncompressed.*/\1/p' || true)"
  case "$bytes" in '' | *[!0-9]*) bytes=$(($(stat -f %z "$ZIP") * 4)) ;; esac
  need=$((bytes / 1024 + 512 * 1024))
  avail="$("$DF" -Pk "$APP_DIR" 2> /dev/null | awk 'NR == 2 { print $4 }' || true)"
  case "$avail" in '' | *[!0-9]*) die 5 "could not read the free space on the volume of $APP_DIR" ;; esac
  if [ "$avail" -lt "$need" ]; then
    die 5 "only $((avail / 1024)) MiB free beside $APP; unpacking $V needs $((need / 1024)) MiB; nothing was changed"
  fi
}

check_app() { # check_app BUNDLE LABEL: sets PROBLEM to the first check BUNDLE fails
  local bundle="$1" label="$2" version requirement
  version="$(app_version "$bundle")"
  if [ "$version" != "$V" ]; then
    PROBLEM="$label reports version ${version:-none}, not $V"
    return 1
  fi
  if ! signed "$bundle"; then
    PROBLEM="$label fails codesign --verify --deep --strict"
    return 1
  fi
  requirement="$("$CODESIGN" -d -r- "$bundle" 2>&1 | sed -n 's/^designated => //p' || true)"
  if [ "$requirement" != "$REQUIREMENT" ] || ! "$CODESIGN" --verify -R="$REQUIREMENT" "$bundle" > /dev/null 2>&1; then
    PROBLEM="$label does not carry the release's designated requirement (it has: ${requirement:-none})"
    return 1
  fi
  if ! "$SPCTL" -a -t exec "$bundle" > /dev/null 2>&1; then
    PROBLEM="$label is not accepted by Gatekeeper (spctl -a -t exec)"
    return 1
  fi
  return 0
}

unpack() {
  check_space
  rm -rf "$UNPACK"
  mkdir -p "$UNPACK"
  UNPACK_MADE=1
  "$DITTO" -x -k "$ZIP" "$UNPACK" ||
    die 5 "could not unpack $ZIP into $UNPACK (is the disk full?); the installed app was left as it was"
  [ -d "$FRESH" ] || die 5 "the release zip holds no SpecWithCode.app; the installed app was left as it was"
  check_app "$FRESH" "the unpacked $V" || die 5 "$PROBLEM; the installed app was left as it was"
  say "unpacked $V beside the app and checked it: signature, designated requirement, Gatekeeper"
}

quit_app() {
  local pids pid
  pids="$(running_pids)"
  if [ -z "$pids" ]; then
    say "the app is not running"
    return 0
  fi
  WAS_RUNNING=1
  if dry; then
    say "would quit the app (pid $(echo $pids)) and reopen it afterwards"
    return 0
  fi
  QUIT=1
  QUIT_BY=$((SECONDS + QUIT_WAIT)) # finish waits for the app until then too, for a run stopped meanwhile.
  for pid in $pids; do
    kill -TERM "$pid" 2> /dev/null || true
    say "quitting the app (TERM to pid $pid)"
  done
  while [ -n "$(running_pids)" ]; do
    if [ "$SECONDS" -ge "$QUIT_BY" ]; then
      die 4 "the app (pid $(echo $(running_pids))) did not quit within ${QUIT_WAIT}s; nothing was changed"
    fi
    sleep "$POLL"
  done
  QUIT_BY=""
}

# A previous app that repair could not move to the Trash takes the name the swap renames the
# installed app to: no swap goes ahead while it is there.
old_in_the_way() {
  if [ -e "$OLD" ]; then
    die 4 "the previous app of an earlier update is still at $OLD (it could not go to the Trash); move it to the Trash and run this again"
  fi
}

swap() {
  local moved=0
  old_in_the_way
  [ -z "$(running_pids)" ] || die 4 "the app started again during the update; nothing was changed"
  # The two renames run to the end once the first one starts.
  trap '' HUP INT TERM
  if [ -e "$APP" ]; then
    mv "$APP" "$OLD" || die 6 "could not rename $APP to $OLD; nothing was changed"
    moved=1
  fi
  mv "$FRESH" "$APP" || undo_swap "$moved" 6 "could not rename the new app into $APP"
  if ! check_app "$APP" "the installed $V"; then
    mv "$APP" "$FRESH" || true
    undo_swap "$moved" 5 "$PROBLEM after the rename"
  fi
  signals
  say "swapped $V into $APP"
  trash_old
}

# After a failed swap (MOVED: the installed app went to $OLD): the previous app goes back when
# nothing is at $APP, and the reason says where each app is. CODE is the failure's own (6 for a
# rename, 5 for a check); a rename that fails here makes it 6.
undo_swap() { # undo_swap MOVED CODE REASON
  if [ "$1" = 1 ] && [ ! -e "$APP" ]; then mv "$OLD" "$APP" || true; fi
  if [ "$1" != 1 ]; then
    die "$2" "$3; nothing was changed"
  elif [ ! -e "$OLD" ]; then
    die "$2" "$3; the previous app is back in place"
  elif [ -e "$APP" ]; then
    LEAVE_CLOSED=1
    die 6 "$3; it could not be moved aside, and the previous app is at $OLD: move $APP to the Trash and rename $OLD back"
  else
    die 6 "$3, and the previous app could not be renamed back from $OLD; the next run puts it back"
  fi
}

reopen() {
  local deadline pids=""
  if ! "$OPEN" "$APP" > /dev/null 2>&1; then
    say "WARNING: could not open $APP again; open it on that Mac"
    RELAUNCHED=failed
    return 0
  fi
  RELAUNCHED=yes
  deadline=$((SECONDS + LAUNCH_WAIT))
  while :; do
    pids="$(running_pids)"
    if [ -n "$pids" ] || [ "$SECONDS" -ge "$deadline" ]; then break; fi
    sleep "$POLL"
  done
  if [ -n "$pids" ]; then
    say "reopened the app (pid $(echo $pids)), as it was running before"
  else
    say "asked macOS to open the app again, as it was running before; no process yet"
  fi
}

finish_ok() {
  local after
  after="$(app_version "$APP")"
  if ! dry; then rm -f "$CACHE"/SpecWithCode-*-arm64.zip "$CACHE"/SpecWithCode-*-arm64.zip.part; fi
  say "RESULT before=${BEFORE:-none} after=${after:-none} how=$HOW relaunched=$RELAUNCHED"
}

main() {
  set -Eeuo pipefail
  export LC_ALL=C
  umask 022
  # The ssh session can drop mid-run (a worker's network moves): a write to it then fails instead
  # of killing the run between quitting the app and reopening it. Every pipe below reads to the end.
  signals
  BEFORE="" HOW="" RELAUNCHED=no WAS_RUNNING=0 QUIT=0 QUIT_BY="" LEAVE_CLOSED=0 LOCKED="" LOCK_ID="" UNPACK_MADE=""
  REASON=""
  V="${V:-}" SHA="${SHA:-}" REPO="${REPO:-anton-abyzov/specwithcode}" DRY_RUN="${DRY_RUN:-0}"
  trap finish EXIT
  trap 'FAILED_COMMAND="$BASH_COMMAND"' ERR
  init
  [[ $V =~ ^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$ ]] ||
    die 2 "V must be a release version such as 1.0.68 (digits and dots only)"
  [[ $SHA =~ ^[0-9a-f]{64}$ ]] || die 2 "SHA must be the zip's sha256 from the release's SHA256SUMS (64 lowercase hex digits)"
  if ! [[ $REPO =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]] || [[ $REPO == *..* ]]; then
    die 2 "REPO must be owner/name"
  fi
  case "$DRY_RUN" in 0 | 1) ;; *) die 2 "DRY_RUN must be 0 or 1" ;; esac
  for tool in "$PLISTBUDDY" "$CODESIGN" "$SPCTL" "$PGREP" "$PS"; do
    [ -x "$tool" ] || die 2 "$tool is missing"
  done
  if dry; then say "dry run: nothing is downloaded, quit, renamed, trashed or opened"; fi

  take_lock
  repair
  if [ -n "$(running_pids)" ]; then
    # Its ShipIt, if one runs, waits for the app to quit: waiting for it here would wait for this
    # run's own quit below, which lets it install, and settle waits for it there.
    settle 0 swap-only
    waiting="$(own_update)"
    if [ -n "$waiting" ]; then say "$waiting waits for the app to quit; it installs what it has when this run quits the app"; fi
  else
    settle 0
  fi
  BEFORE="$(app_version "$APP")"
  say "installed app: ${BEFORE:-none}"
  if [ "$BEFORE" = "$V" ]; then
    if check_app "$APP" "the installed $V"; then
      say "already $V, signed with the release's requirement; nothing to do"
      HOW=already-current
      if dry; then HOW=dry-run; fi
      finish_ok
      return 0
    fi
    say "$PROBLEM, so the release goes in over it"
  fi
  if ! dry; then old_in_the_way; fi # Before anything is downloaded or the app is quit.
  fetch_zip
  if dry; then
    say "would unpack $V into $UNPACK and check it, then swap it in unless the app's own updater installs $V on quit"
    quit_app
    HOW=dry-run
    finish_ok
    return 0
  fi
  unpack
  quit_app
  # An update the app began while it ran is waited for before anything is renamed, also when the
  # app quit by itself in the meantime.
  if [ "$QUIT" = 1 ]; then settle "$SHIPIT_GRACE"; else settle 0; fi
  if [ "$(app_version "$APP")" = "$V" ] && check_app "$APP" "the $V its own updater installed"; then
    say "the app's own updater installed $V as it quit"
    HOW=updater-on-quit
    rm -rf "$UNPACK"
    UNPACK_MADE=""
  else
    if [ "$(app_version "$APP")" = "$V" ]; then say "$PROBLEM; swapping in the checked copy instead"; fi
    swap
    rm -rf "$UNPACK"
    UNPACK_MADE=""
    HOW=swapped
  fi
  if [ "$WAS_RUNNING" = 1 ]; then reopen; else say "the app was not running before; left closed"; fi
  finish_ok
}

main "$@" < /dev/null
