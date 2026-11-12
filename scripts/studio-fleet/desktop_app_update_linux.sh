#!/bin/sh
# Installs SpecWithCode $V's .deb on a fleet Linux worker through the signed update helper the .deb
# ships (/usr/lib/specwithcode/update-helper and its polkit action), the same route the app's own
# updater takes. linux_rollout.py streams it to the worker (sh -s over its fleet SSH) once that
# worker's service runs $V. By hand:
#
#   ssh <worker> 'V=1.0.268 SHA_AMD64=<sha256> SHA_ARM64=<sha256> sh -s' < scripts/studio-fleet/desktop_app_update_linux.sh
#   ssh <worker> 'DRY_RUN=1 V=1.0.268 SHA_AMD64=<sha256> SHA_ARM64=<sha256> sh -s' < scripts/studio-fleet/desktop_app_update_linux.sh
#
# The SHAs are the .deb lines of the release's SHA256SUMS-windows-linux; the .deb and its .asc come
# from the public mirror's release (REPO, default anton-abyzov/specwithcode).
#   1. No `studio` package installed: nothing to do (a headless worker), how=no-desktop-app.
#   2. Installed version $V or newer: how=already-current.
#   3. The helper, its polkit action and pkcheck's answer for a process in the user's own manager
#      (where the install runs, so no SSH session asks): any of them missing ends with exit 7 and
#      the reason, before anything is downloaded or quit. The .deb is then installed by hand once.
#   4. Download SpecWithCode-$V-<arch>.deb and its .asc, check the .deb's sha256.
#   5. Quit the app (TERM to the main /opt/SpecWithCode process, then wait): its own updater may
#      install a download it holds as it quits, through the same helper; wait for that to finish.
#   6. Still older: run the helper (pkexec, no password in the user's active session). It checks
#      the signature, the package, the architecture and that $V is newer, then runs apt-get.
#   7. Read the installed version back from dpkg; anything but $V fails.
#   8. Reopen the app only if it was running (systemd-run --user, so it is the session's, not SSH's).
#
# DRY_RUN=1 reads, downloads and checks (sha256 and the signature with gpgv, both as this user),
# and asks polkit, but installs, quits and opens nothing.
# Success ends with "RESULT before=<v> after=<v> how=<no-desktop-app|already-current|updater-on-quit|
# helper|dry-run> relaunched=<yes|no|failed>" and exit 0. A failure ends with "FAIL <reason>" and exit
# 2 for a bad value or missing tool, 3 for the download, its sha256 or its signature, 4 when the app
# did not quit or another install is in the way, 5 when the helper or apt refused the install or the
# version read back is not $V, 7 when this machine cannot install without a password (step 3).
# Tests override: SWC_APP_EXE, SWC_HELPER, SWC_POLICY, SWC_KEYRING, SWC_CACHE_DIR, SWC_POLL,
# SWC_QUIT_WAIT, SWC_INSTALL_WAIT, SWC_ARCH, and the tools SWC_CURL, SWC_DPKG_QUERY, SWC_DPKG,
# SWC_PKCHECK, SWC_PKEXEC, SWC_SYSTEMD_RUN, SWC_GPGV, SWC_PGREP, SWC_SHA256SUM.

say() { printf '%s\n' "$*" 2> /dev/null || true; }
dry() { [ "$DRY_RUN" = 1 ]; }
die() {
  REASON=$2
  exit "$1"
}

finish() {
  rc=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [ "$rc" -ne 0 ]; then
    # The app was running and this run quit it: open it again, whatever version is in.
    if [ "$QUIT" = 1 ] && [ -z "$(app_pids)" ]; then reopen; fi
    say "FAIL ${REASON:-stopped unexpectedly (exit $rc)}"
  fi
  exit "$rc"
}

init() {
  APP_EXE=${SWC_APP_EXE:-/opt/SpecWithCode/specweave-studio-desktop}
  HELPER=${SWC_HELPER:-/usr/lib/specwithcode/update-helper}
  POLICY=${SWC_POLICY:-/usr/share/polkit-1/actions/com.specwithcode.studio.update.policy}
  KEYRING=${SWC_KEYRING:-/usr/lib/specwithcode/update-key.gpg}
  ACTION=com.specwithcode.studio.update
  PACKAGE=studio
  CACHE=${SWC_CACHE_DIR:-$HOME/.specwithcode/backups/desktop-app-updates}
  POLL=${SWC_POLL:-1}
  QUIT_WAIT=${SWC_QUIT_WAIT:-60}
  INSTALL_WAIT=${SWC_INSTALL_WAIT:-600}
  CURL=${SWC_CURL:-curl}
  DPKG_QUERY=${SWC_DPKG_QUERY:-dpkg-query}
  DPKG=${SWC_DPKG:-dpkg}
  PKCHECK=${SWC_PKCHECK:-/usr/bin/pkcheck}
  PKEXEC=${SWC_PKEXEC:-/usr/bin/pkexec}
  SYSTEMD_RUN=${SWC_SYSTEMD_RUN:-systemd-run}
  GPGV=${SWC_GPGV:-gpgv}
  PGREP=${SWC_PGREP:-pgrep}
  SHA256SUM=${SWC_SHA256SUM:-sha256sum}
  # The user manager's bus, as systemdUserBus.ts restores it for an SSH session without one.
  : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
  : "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}"
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
}

installed_version() { "$DPKG_QUERY" -W -f='${Version}' "$PACKAGE" 2> /dev/null || true; }

newer_or_same() { "$DPKG" --compare-versions "$1" ge "$2" 2> /dev/null; }

# The app's main processes: its own executable, not a --type= child (zygote, renderer, GPU).
app_pids() {
  for pid in $("$PGREP" -u "$(id -u)" -f "^$APP_EXE( |\$)" 2> /dev/null || true); do
    # Chromium rewrites a child's command line into one string, so look for the flag anywhere. A
    # process that has gone, or a zombie, has an empty one.
    cmdline=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2> /dev/null || true)
    case "$cmdline" in '' | *' --type='*) continue ;; esac
    printf '%s\n' "$pid"
  done
  return 0
}

helper_running() { [ -n "$("$PGREP" -f "^(/bin/sh )?$HELPER( |\$)" 2> /dev/null || true)" ]; }

# Runs CMD in the user's own manager, outside this SSH session: polkit then judges the user's
# graphical session, as it does for the app, and the session's environment reaches a relaunch.
in_user_manager() { "$SYSTEMD_RUN" --user --quiet --collect --wait --pipe -- "$@"; }

check_unattended() {
  [ -x "$HELPER" ] || die 7 "the signed update helper $HELPER is missing (the installed $BEFORE predates it); install $V's .deb by hand once: sudo apt install ./$DEB"
  [ -f "$POLICY" ] || die 7 "the polkit action $POLICY is missing; install $V's .deb by hand once: sudo apt install ./$DEB"
  [ -f "$KEYRING" ] || die 7 "the update key $KEYRING is missing; install $V's .deb by hand once: sudo apt install ./$DEB"
  # pkcheck about its own shell: the process pkexec would be asked about runs the same way.
  # systemd-run expands $NAME in arguments, so $$ reaches the shell as $$$$.
  if ! in_user_manager /bin/sh -c "exec $PKCHECK --action-id $ACTION --process \$\$\$\$" > /dev/null 2>&1; then
    die 7 "polkit does not allow $ACTION without a password here (no active local session for this user?); install $V's .deb at the machine or log in there first"
  fi
  say "the signed update helper and its polkit action are ready"
}

fetch() {
  mkdir -p "$CACHE" || die 2 "could not make $CACHE"
  base="https://github.com/$REPO/releases/download/v$V"
  if [ -f "$CACHE/$DEB" ] && [ "$("$SHA256SUM" "$CACHE/$DEB" | cut -d' ' -f1)" = "$SHA" ]; then
    say "the release .deb is already here and matches SHA256SUMS-windows-linux"
  else
    rm -f "$CACHE/$DEB.part"
    say "downloading $base/$DEB"
    "$CURL" -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 1800 \
      -o "$CACHE/$DEB.part" "$base/$DEB" || die 3 "could not download $base/$DEB; nothing was changed"
    got=$("$SHA256SUM" "$CACHE/$DEB.part" | cut -d' ' -f1)
    if [ "$got" != "$SHA" ]; then
      rm -f "$CACHE/$DEB.part"
      die 3 "the downloaded .deb's sha256 is ${got:-unreadable}, not $SHA from SHA256SUMS-windows-linux; nothing was changed"
    fi
    mv -f "$CACHE/$DEB.part" "$CACHE/$DEB"
    say "downloaded $DEB; its sha256 matches SHA256SUMS-windows-linux"
  fi
  "$CURL" -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 120 \
    -o "$CACHE/$DEB.asc" "$base/$DEB.asc" || die 3 "could not download $base/$DEB.asc; nothing was changed"
  # The helper checks this again as root; checking here first keeps a bad file from quitting the app.
  gnupg=$(mktemp -d) || die 2 "could not make a temporary folder"
  if ! "$GPGV" --homedir "$gnupg" --keyring "$KEYRING" "$CACHE/$DEB.asc" "$CACHE/$DEB" > /dev/null 2>&1; then
    rm -rf "$gnupg"
    die 3 "$DEB's signature does not verify against $KEYRING; nothing was changed"
  fi
  rm -rf "$gnupg"
  say "$DEB's signature verifies against the installed update key"
}

quit_app() {
  pids=$(app_pids)
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
  for pid in $pids; do
    kill -TERM "$pid" 2> /dev/null || true
    say "quitting the app (TERM to pid $pid)"
  done
  waited=0
  while [ -n "$(app_pids)" ]; do
    [ "$waited" -lt "$QUIT_WAIT" ] || die 4 "the app (pid $(echo $(app_pids))) did not quit within ${QUIT_WAIT}s; nothing was changed"
    sleep "$POLL"
    waited=$((waited + POLL))
  done
}

# The app's updater installs a download it holds as it quits, through the same helper.
await_helper() {
  waited=0
  while helper_running; do
    [ "$waited" -lt "$INSTALL_WAIT" ] || die 4 "an update helper still runs after ${INSTALL_WAIT}s; let it finish, then run this again"
    [ "$waited" -gt 0 ] || say "waiting for the update the app began as it quit"
    sleep "$POLL"
    waited=$((waited + POLL))
  done
}

install_deb() {
  out=$(in_user_manager "$PKEXEC" --disable-internal-agent "$HELPER" "$CACHE/$DEB" "$CACHE/$DEB.asc" 2>&1)
  code=$?
  case "$code" in
    0) say "the update helper installed $V" ;;
    3) ;; # Not newer: the read-back below decides.
    126 | 127) die 7 "pkexec refused the helper without a password (exit $code); install $V's .deb at the machine" ;;
    *) die 5 "the update helper refused $DEB (exit $code): $(printf '%s' "$out" | head -n 1)" ;;
  esac
}

reopen() {
  if "$SYSTEMD_RUN" --user --quiet --collect -- "$APP_EXE" > /dev/null 2>&1; then
    RELAUNCHED=yes
    say "reopened the app in the user's session, as it was running before"
  else
    RELAUNCHED=failed
    say "WARNING: could not open the app again; open it at that machine"
  fi
}

result() { say "RESULT before=${BEFORE:-none} after=${1:-none} how=$2 relaunched=$RELAUNCHED"; }

main() {
  set -u
  export LC_ALL=C
  umask 022
  trap '' PIPE HUP
  trap 'die 130 "stopped by SIGINT"' INT
  trap 'die 143 "stopped by SIGTERM"' TERM
  QUIT=0 WAS_RUNNING=0 RELAUNCHED=no REASON=''
  V=${V:-} SHA_AMD64=${SHA_AMD64:-} SHA_ARM64=${SHA_ARM64:-} REPO=${REPO:-anton-abyzov/specwithcode} DRY_RUN=${DRY_RUN:-0}
  trap finish EXIT
  init
  printf '%s\n' "$V" | grep -Eqx '(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})' ||
    die 2 "V must be a release version such as 1.0.268 (digits and dots only)"
  printf '%s\n' "$REPO" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}' &&
    ! printf '%s' "$REPO" | grep -q '\.\.' || die 2 "REPO must be owner/name"
  case "$DRY_RUN" in 0 | 1) ;; *) die 2 "DRY_RUN must be 0 or 1" ;; esac
  for tool in "$DPKG_QUERY" "$DPKG" "$PGREP" "$SYSTEMD_RUN"; do
    command -v "$tool" > /dev/null 2>&1 || die 2 "$tool is missing"
  done
  if dry; then say "dry run: nothing is installed, quit or opened"; fi

  BEFORE=$(installed_version)
  if [ -z "$BEFORE" ]; then
    say "no $PACKAGE package is installed here; no desktop app to update"
    result "" no-desktop-app
    return 0
  fi
  say "installed app: $BEFORE"
  if newer_or_same "$BEFORE" "$V"; then
    say "already $BEFORE; nothing to do"
    result "$BEFORE" already-current
    return 0
  fi
  ARCH=${SWC_ARCH:-$("$DPKG" --print-architecture)}
  case "$ARCH" in
    amd64) SHA=$SHA_AMD64 ;;
    arm64) SHA=$SHA_ARM64 ;;
    *) die 2 "no SpecWithCode .deb is published for $ARCH" ;;
  esac
  printf '%s\n' "$SHA" | grep -Eqx '[0-9a-f]{64}' || die 2 "the sha256 for $ARCH must be 64 lowercase hex digits"
  DEB="SpecWithCode-$V-$ARCH.deb"
  check_unattended
  fetch
  if dry; then
    quit_app
    say "would install $DEB through the update helper and read the version back"
    result "$BEFORE" dry-run
    return 0
  fi
  helper_running && await_helper
  quit_app
  if [ "$QUIT" = 1 ]; then
    sleep "$POLL"
    await_helper
  fi
  how=helper
  if [ "$(installed_version)" = "$V" ]; then
    how=updater-on-quit
    say "the app's own updater installed $V as it quit"
  else
    install_deb
  fi
  after=$(installed_version)
  [ "$after" = "$V" ] || die 5 "dpkg reads back ${after:-nothing} after the install, not $V"
  rm -f "$CACHE"/SpecWithCode-*.deb "$CACHE"/SpecWithCode-*.deb.asc "$CACHE"/SpecWithCode-*.deb.part
  if [ "$WAS_RUNNING" = 1 ]; then reopen; else say "the app was not running before; left closed"; fi
  result "$after" "$how"
}

main "$@" < /dev/null
