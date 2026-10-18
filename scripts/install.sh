#!/bin/sh
# Installs SpecWithCode from its own GitHub release and runs it as a background service, on
# macOS with Apple silicon and on Linux (x64 or arm64, glibc, systemd user services).
#
#   curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/latest/download/install.sh | bash
#
# Pass --join to also set up Tailscale (installing it and opening its sign-in page when needed) and print the line that adds this machine to your main one:
#
#   curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/latest/download/install.sh | bash -s -- --join
#
# The release's server archive is JavaScript plus native modules for Node.js 22. It is checked
# against the release's SHA256SUMS and unpacked into $STUDIO_HOME/runtime/versions/<version>,
# where `specwithcode service install` expects it. Unless --node names one, a private
# Node.js 22.20.0 from nodejs.org, checked against the SHA-256 pinned below, goes to
# $STUDIO_HOME/runtime/node. Nothing else changes: projects, threads, settings, other homes and
# existing services are left alone. Run it again to move to the newest release.
set -eu

repo="anton-abyzov/specwithcode"
tailscale_app=/Applications/Tailscale.app
tailscale_pkg_url="https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg"
tailscale_wait="${STUDIO_TAILSCALE_WAIT:-60}"
node_version="22.20.0"

usage() {
  cat <<'EOF'
Usage: install.sh [--join] [--no-service] [--standalone] [--dry-run] [--version V]
                  [--node PATH]

Installs SpecWithCode from its GitHub release, puts `specwithcode` (and its other name,
`specweave-studio`) in ~/.local/bin and starts it as a background service.

  --join          after installing, set up Tailscale (installing it and opening its sign-in
                  page if needed) and run `specwithcode fleet invite`, which prints the line
                  to paste on your main machine
  -y, --yes       install Tailscale for --join without asking
  --no-service    set up the command only; leave the background service alone
  --standalone    install the command-line build even when the desktop app is on this Mac
                  (otherwise the app is reused)
  --dry-run       show what would happen; downloads only SHA256SUMS and changes nothing
  --version V     install exactly version V (default: the newest release on the channel)
  --node PATH     run SpecWithCode with this Node.js 22 (22.20 or a later 22.x) instead of
                  a private Node.js 22.20.0 from nodejs.org
  -h, --help      show this help

Environment:
  STUDIO_CHANNEL           release train: stable (default), nightly or preview
  STUDIO_VERSION           same as --version
  STUDIO_NODE              same as --node
  STUDIO_INSTALL_STANDALONE  1 is the same as --standalone
  STUDIO_HOME              SpecWithCode home (default ~/.specwithcode; a legacy
                           ~/.specweave-studio that still holds a profile keeps precedence)
  STUDIO_INSTALL_BIN_DIR   where the two command links go (default ~/.local/bin)
  STUDIO_RELEASE_BASE_URL  HTTPS mirror of releases/download (default: the app's GitHub releases)
EOF
}

fail() {
  printf '\nspecwithcode install: %s\n' "$1" >&2
  exit 1
}

# Single-quotes a value for the generated launcher.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

main() {
  join=false service=true dry_run=false assume_yes=false
  case "${STUDIO_INSTALL_STANDALONE:-}" in 1 | true) standalone=true ;; *) standalone=false ;; esac
  version="${STUDIO_VERSION:-}"
  explicit_node="${STUDIO_NODE:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --join) join=true ;;
      --no-service) service=false ;;
      --standalone) standalone=true ;;
      --dry-run) dry_run=true ;;
      -y | --yes) assume_yes=true ;;
      --version) [ $# -ge 2 ] || fail "--version needs a version"; version="$2"; shift ;;
      --version=*) version="${1#*=}" ;;
      --node) [ $# -ge 2 ] || fail "--node needs a path"; explicit_node="$2"; shift ;;
      --node=*) explicit_node="${1#*=}" ;;
      -h | --help) usage; exit 0 ;;
      *) fail "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  version_explicit=false
  [ -z "$version" ] || version_explicit=true

  base_url="${STUDIO_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
  base_url="${base_url%/}"
  case "$base_url" in
    https://*) ;;
    # Loopback only: a local mirror or a test fixture.
    http://127.0.0.1:* | http://localhost:*) ;;
    *) fail "STUDIO_RELEASE_BASE_URL must be an https:// address" ;;
  esac

  # The same choice as the app's studioRootDirectory: a migrated legacy root is a link to the
  # branded one, and a legacy root holding a standalone profile keeps precedence until it moves.
  legacy_home="$HOME/.specweave-studio"
  branded_home="$HOME/.specwithcode"
  if [ -L "$legacy_home" ]; then default_home="$branded_home"
  elif [ -e "$legacy_home/userdata" ] || [ -e "$legacy_home/dev" ]; then default_home="$legacy_home"
  elif [ -e "$branded_home" ]; then default_home="$branded_home"
  elif [ -e "$legacy_home" ]; then default_home="$legacy_home"
  else default_home="$branded_home"; fi
  studio_home="${STUDIO_HOME:-$default_home}"
  # The spelling the CLI resolves STUDIO_HOME to, so both writers of the launcher agree.
  studio_home="$(printf '%s' "$studio_home" | tr -s /)"
  [ "$studio_home" = / ] || studio_home="${studio_home%/}"
  case "$studio_home" in /*) ;; *) fail "STUDIO_HOME must be an absolute path" ;; esac
  bin_dir="${STUDIO_INSTALL_BIN_DIR:-$HOME/.local/bin}"
  versions_dir="${studio_home}/runtime/versions"

  setup_output

  case "$(uname -s)" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) fail "SpecWithCode publishes no command-line build for $(uname -s); use macOS or Linux" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch="arm64" ;;
    x86_64 | amd64) arch="x64" ;;
    *) fail "unsupported architecture $(uname -m)" ;;
  esac
  # The targets with a server archive in the release, and the Node.js build that runs each.
  case "${platform}-${arch}" in
    darwin-arm64) node_sha256="cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949" ;;
    linux-x64) node_sha256="eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29" ;;
    linux-arm64) node_sha256="4181609e03dcb9880e7e5bf956061ecc0503c77a480c6631d868cb1f65a2c7dd" ;;
    darwin-x64) fail "there is no SpecWithCode build for Intel Macs; build it from source (docs/user/install.md#build-from-source)" ;;
  esac
  if [ "$platform" = linux ]; then
    if [ -f /etc/alpine-release ] || { ldd --version 2>&1 | grep -qi musl; }; then
      fail "the Linux build needs glibc (Debian, Ubuntu, Fedora); musl systems such as Alpine are not supported"
    fi
  fi
  command -v tar >/dev/null 2>&1 || fail "tar is required"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "curl or wget is required"
  if command -v sha256sum >/dev/null 2>&1; then
    checksum() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    fail "sha256sum or shasum is required"
  fi

  # Checked before the download, so a missing sign-in is fixed before waiting for it.
  if "$join"; then ensure_tailscale; fi

  # A desktop app or managed service already running SpecWithCode here is used as it is.
  find_existing_install
  if [ -n "$existing" ]; then
    use_existing_install
    return 0
  fi
  check_launchers

  step "Finding your release..."
  resolve_version
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/specwithcode-install.XXXXXX")"
  staging='' node_staging='' download_pid=''
  trap 'cleanup_on_exit' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${scratch}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "SpecWithCode ${version} has no SHA256SUMS at ${base_url}/v${version}; is it a published release?"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  # The macOS server archive has no platform in its name (studio-<version>-<commit>.tar.gz);
  # the Linux ones do (studio-<version>-linux-<arch>-<commit>.tar.gz).
  escaped_version="$(printf '%s' "$version" | sed 's/\./\\./g')"
  if [ "$platform" = darwin ]; then
    archive_pattern="studio-${escaped_version}-[0-9a-f]\{12\}\.tar\.gz"
  else
    archive_pattern="studio-${escaped_version}-linux-${arch}-[0-9a-f]\{12\}\.tar\.gz"
  fi
  matches="$(sed -n "s/^\([0-9a-fA-F]\{64\}\) [ *]\(${archive_pattern}\)$/\1 \2/p" "${scratch}/SHA256SUMS")"
  [ -n "$matches" ] || fail "SpecWithCode ${version} publishes no server archive for ${platform}-${arch}"
  [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" = 1 ] ||
    fail "SHA256SUMS lists more than one ${platform}-${arch} archive"
  archive_sha256="$(printf '%s' "$matches" | cut -d' ' -f1 | tr 'A-F' 'a-f')"
  archive="$(printf '%s' "$matches" | cut -d' ' -f2)"
  target_dir="${versions_dir}/${version}"
  entry="${target_dir}/specweave-studio"

  choose_node
  decide_service

  if "$dry_run"; then
    print_plan
    return 0
  fi

  install_node
  install_runtime
  install_launchers
  install_service
  if "$join"; then
    if [ "$service_state" = installed ]; then attempts=45; else attempts=1; fi
    run_invite "$attempts" "${bin_dir}/specwithcode"
  fi
  print_next_steps
}

setup_output() {
  # ANSI stays on stderr, so `curl ... | bash` still shows progress.
  interactive=false
  if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
  reset='' bold='' muted='' accent='' green=''
  if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
    reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
    muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
  fi
  if "$interactive"; then
    printf '\n  %sSpecWithCode%s\n' "$bold" "$reset" >&2
    printf '  %sinstaller%s\n\n' "$muted" "$reset" >&2
  fi
}

step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}

clear_line() {
  if "$interactive"; then printf '\r\033[2K' >&2; fi
}

cleanup_on_exit() {
  if [ -n "$download_pid" ]; then
    kill "$download_pid" 2>/dev/null || true
    wait "$download_pid" 2>/dev/null || true
  fi
  rm -rf "$scratch"
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
  if [ -n "$node_staging" ]; then rm -rf "$node_staging"; fi
}

# fetch URL FILE. Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
# An https:// address is never followed to plain HTTP.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    case "$1" in
      https://*) status="$(curl -sSL --proto '=https' -w '%{http_code}' "$1" -o "$2")" || return 1 ;;
      *) status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1 ;;
    esac
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  else
    case "$1" in
      https://*) wget -q --https-only --server-response "$1" -O "$2" 2>"$2.headers" ;;
      *) wget -q --server-response "$1" -O "$2" 2>"$2.headers" ;;
    esac && { rm -f "$2.headers"; return 0; }
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}

# download URL FILE: fetch, with a progress bar on a terminal. Polls the file the downloader
# writes; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    case "$1" in
      https://*) curl -fsSL --proto '=https' -D "$2.headers" "$1" -o "$2" 2>"$2.errors" & ;;
      *) curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" & ;;
    esac
  else
    case "$1" in
      https://*) wget -q --https-only --server-response "$1" -O "$2" 2>"$2.headers" & ;;
      *) wget -q --server-response "$1" -O "$2" 2>"$2.headers" & ;;
    esac
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in '' | *[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=''; rest=''; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=''
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

resolve_version() {
  channel="${STUDIO_CHANNEL:-stable}"
  if [ -z "$version" ]; then
    # Tags are v<semver>; the channel is the prerelease identifier, or none for stable. Only tags
    # of the requested train count, so a stable install never picks up a nightly or preview
    # build. Splitting at commas also reads a minified reply.
    case "$channel" in
      stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
      nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
      *) fail "STUDIO_CHANNEL must be stable, nightly, or preview" ;;
    esac
    tmp_index="$(mktemp "${TMPDIR:-/tmp}/specwithcode-releases.XXXXXX")"
    fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index" ||
      { rm -f "$tmp_index"; fail "could not list the releases of ${repo}; pass --version"; }
    version="$(tr '{' ',' < "$tmp_index" | tr ',' '\n' | sed -n "s/^ *\"tag_name\": *\"${tag_pattern}\" *$/\1/p" | head -n 1)"
    rm -f "$tmp_index"
    [ -n "$version" ] || fail "could not find a ${channel} release; pass --version"
  fi
  version="${version#v}"
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
    fail "${version} is not a SpecWithCode version"
  case "$version" in
    *-preview.*)
      printf '%s\n' \
        "SpecWithCode ${version} is a preview build." \
        "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
        "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
        "  Set STUDIO_CHANNEL=stable (the default) for a supported build." >&2
      if [ "$channel" != "preview" ] && ! "$version_explicit"; then
        fail "refusing a preview build that was not explicitly requested"
      fi
      ;;
  esac
}

# node_is_supported PATH: Node.js 22.20 or a later 22.x, the line the archive's native modules
# are built for.
node_is_supported() {
  [ -x "$1" ] || return 1
  reported="$("$1" --version 2>/dev/null)" || return 1
  case "$reported" in
    v22.*) minor="${reported#v22.}"; minor="${minor%%.*}" ;;
    *) return 1 ;;
  esac
  case "$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$minor" -ge 20 ]
}

choose_node() {
  node_stem="node-v${node_version}-${platform}-${arch}"
  node_url="https://nodejs.org/dist/v${node_version}/${node_stem}.tar.gz"
  private_node_dir="${studio_home}/runtime/node/${node_stem}"
  node_download=false
  if [ -n "$explicit_node" ]; then
    case "$explicit_node" in /*) ;; *) explicit_node="$(pwd)/${explicit_node}" ;; esac
    node_is_supported "$explicit_node" || fail "${explicit_node} is not Node.js 22.20 or a later 22.x"
    node="$explicit_node"
  else
    node="${private_node_dir}/bin/node"
    node_is_supported "$node" || node_download=true
  fi
}

# wrapper_kind FILE: "managed" for a launcher the fleet installer or service updater wrote
# (scripts/studio-fleet/launcher.py, running a release under its releases folder), "ours" for
# one this installer wrote for this home, "" for anything else.
wrapper_kind() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 0
  [ "$(sed -n '1,3p' "$1" 2>/dev/null)" = "$(printf '#!/bin/sh\nset -eu\numask 077')" ] || return 0
  last="$(tail -n 1 "$1")"
  case "$last" in 'exec /usr/bin/env -i '*'/bin.mjs "$@"' | "exec /usr/bin/env -i "*"/bin.mjs' \"\$@\"") ;; *) return 0 ;; esac
  case "$last" in
    *"${versions_dir}/"*) printf 'ours\n' ;;
    */install/releases/* | */.local/share/specweave-studio/releases/*) printf 'managed\n' ;;
  esac
}

# Sets existing to "managed" or "desktop" when SpecWithCode already runs on this machine, and
# existing_cli to a command line that reaches it.
find_existing_install() {
  existing='' existing_cli='' existing_reason=''
  # The fleet installer always writes its wrappers to ~/.local/bin, whatever bin_dir is here.
  for dir in "$bin_dir" "$HOME/.local/bin"; do
    for name in specwithcode specweave-studio; do
      if [ "$(wrapper_kind "${dir}/${name}")" = managed ]; then
        existing=managed existing_cli="${dir}/${name}"
        existing_reason="a managed SpecWithCode install already provides ${dir}/${name}"
        return 0
      fi
    done
  done
  [ "$platform" = darwin ] || return 0
  for plist in "$HOME"/Library/LaunchAgents/com.specweave.studio.*.plist; do
    [ -e "$plist" ] || continue
    case "${plist##*/}" in
      com.specweave.studio.service.plist | *.updater.plist) ;;
      *)
        existing=managed
        existing_reason="a managed SpecWithCode service already runs on this Mac (${plist##*/})"
        return 0 ;;
    esac
  done
  # --standalone installs the command-line build next to the app instead of reusing it.
  "$standalone" && return 0
  for app in /Applications/SpecWithCode.app "$HOME/Applications/SpecWithCode.app"; do
    if [ -x "${app}/Contents/MacOS/SpecWithCode" ]; then
      existing=desktop existing_app="$app"
      existing_reason="the SpecWithCode desktop app (${app}) runs SpecWithCode on this Mac"
      return 0
    fi
  done
}

# The desktop app puts no command on PATH; its bundled CLI is the same version as the server it
# runs, so `fleet invite` mints the token with matching code.
existing_command() {
  if [ "$existing" = desktop ]; then
    ELECTRON_RUN_AS_NODE=1 STUDIO_CLI_NAME=specwithcode "${existing_app}/Contents/MacOS/SpecWithCode" \
      "${existing_app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs" "$@"
  else
    "$existing_cli" "$@"
  fi
}

use_existing_install() {
  clear_line
  if "$dry_run"; then printf 'Dry run: nothing was installed or changed.\n'; fi
  printf '  Nothing to install: %s.\n' "$existing_reason" >&2
  if "$version_explicit" && [ "$existing" = desktop ]; then
    printf '  --version %s was not installed; update the app, or add --standalone to install\n' "$version" >&2
    printf '  the command-line build next to it.\n' >&2
  fi
  if ! "$join"; then
    if [ "$existing" = desktop ]; then
      printf '  To add this Mac to your main machine, run this again with --join.\n\n' >&2
    else
      printf '  To add this machine to your main one, run %sspecwithcode fleet invite%s.\n\n' "$bold" "$reset" >&2
    fi
    return 0
  fi
  if [ "$existing" = managed ] && [ -z "$existing_cli" ]; then
    fail "no specwithcode command for that install was found in ${bin_dir}; run its own \`specwithcode fleet invite\`"
  fi
  if "$dry_run"; then
    printf '  Join:      %sspecwithcode fleet invite\n' "${tailscale_plan:+${tailscale_plan}; then }"
    return 0
  fi
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/specwithcode-install.XXXXXX")"
  staging='' node_staging='' download_pid=''
  trap 'cleanup_on_exit' EXIT
  if [ "$existing" = desktop ]; then
    printf '  Using the desktop app'"'"'s server; open SpecWithCode first if it is not running.\n' >&2
  fi
  run_invite 1 existing_command
  print_join_next_step
}

# Each launcher is only this installer's own: a wrapper it wrote for this home, or the symlink
# into $STUDIO_HOME/runtime/versions that earlier versions of it made. Anything else at that path
# (another install, a hand-written wrapper) is left alone.
check_launchers() {
  for name in specwithcode specweave-studio; do
    launcher="${bin_dir}/${name}"
    [ -e "$launcher" ] || [ -L "$launcher" ] || continue
    [ "$(wrapper_kind "$launcher")" != ours ] || continue
    if [ -L "$launcher" ]; then
      case "$(readlink "$launcher" 2>/dev/null | tr -s /)" in
        "${versions_dir}/"*) continue ;;
        # A link written before the home moved still targets the linked legacy root.
        "$(printf '%s' "$legacy_home" | tr -s /)/runtime/versions/"*)
          if [ -z "${STUDIO_HOME:-}" ] && [ -L "$legacy_home" ]; then continue; fi ;;
      esac
    fi
    fail "${launcher} already exists and is not a SpecWithCode launcher for ${studio_home}; move it, or set STUDIO_INSTALL_BIN_DIR to another directory"
  done
}

# The background service needs systemd user services on Linux.
decide_service() {
  service_skip=''
  if ! "$service"; then
    service_skip='--no-service was given'
  elif [ "$platform" = linux ] && ! command -v systemctl >/dev/null 2>&1; then
    service_skip='this machine has no systemd, which the background service needs'
  fi
}

# The same lookup as the app: tailscale on PATH first, then the macOS app's own executable.
find_tailscale() {
  tailscale=''
  if command -v tailscale >/dev/null 2>&1; then
    tailscale="$(command -v tailscale)"
  elif [ "$platform" = darwin ] && [ -x "$tailscale_app/Contents/MacOS/Tailscale" ]; then
    tailscale="$tailscale_app/Contents/MacOS/Tailscale"
  fi
}

tailscale_state() {
  "$tailscale" status --json 2>/dev/null </dev/null | tr -d '\n' |
    sed -n 's/.*"BackendState": *"\([A-Za-z]*\)".*/\1/p' || true
}

# Asks on the terminal, even under `curl ... | bash`; --yes answers yes. With no terminal the
# answer is no, so nothing is installed unasked.
confirm() {
  "$assume_yes" && return 0
  (: </dev/tty) 2>/dev/null || return 1
  printf '\n  %s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in '' | y | Y | yes | Yes | YES) return 0 ;; *) return 1 ;; esac
}

open_url() {
  if [ "$platform" = darwin ]; then open "$1" >/dev/null 2>&1 </dev/null || true
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 </dev/null || true
  fi
}

# Root runs Tailscale's own commands directly; anyone else goes through sudo, which asks for the
# password on the terminal.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

# Tailscale's own installers: the signed macOS package, or tailscale.com/install.sh on Linux
# (it adds Tailscale's package repository and starts tailscaled).
install_tailscale() {
  if [ "$platform" = darwin ]; then
    how="Tailscale's signed macOS installer (asks for your Mac password)"
    manual="install it from https://tailscale.com/download/mac"
  else
    how="Tailscale's installer from tailscale.com (asks for your password)"
    manual="install it with \`curl -fsSL https://tailscale.com/install.sh | sh\`"
  fi
  if "$dry_run"; then
    tailscale_plan="install Tailscale with ${how}, then open its sign-in page"
    return 0
  fi
  clear_line
  printf '  --join needs Tailscale, which connects this machine to your main one privately.\n' >&2
  confirm "Install Tailscale now?" ||
    fail "--join needs Tailscale: ${manual} (or run this again with --yes), sign in with the account your main machine uses, then run this again"
  tailscale_scratch="$(mktemp -d "${TMPDIR:-/tmp}/specwithcode-tailscale.XXXXXX")"
  if [ "$platform" = darwin ]; then
    step "Downloading Tailscale..."
    download "$tailscale_pkg_url" "${tailscale_scratch}/Tailscale.pkg" ||
      fail "could not download ${tailscale_pkg_url}; ${manual}"
    # The package must carry Tailscale's own Developer ID (team W5364U7YZB), whatever the download returned.
    pkgutil --check-signature "${tailscale_scratch}/Tailscale.pkg" 2>/dev/null |
      grep -q 'Developer ID Installer: Tailscale Inc\. (W5364U7YZB)' ||
      fail "the downloaded Tailscale package is not signed by Tailscale Inc.; ${manual}"
    clear_line
    printf '  Installing Tailscale...\n' >&2
    as_root installer -pkg "${tailscale_scratch}/Tailscale.pkg" -target / >&2 ||
      fail "Tailscale did not install; ${manual}"
  else
    step "Downloading Tailscale's installer..."
    fetch https://tailscale.com/install.sh "${tailscale_scratch}/tailscale-install.sh" ||
      fail "could not download https://tailscale.com/install.sh; ${manual}"
    clear_line
    sh "${tailscale_scratch}/tailscale-install.sh" >&2 </dev/null || fail "Tailscale did not install; ${manual}"
  fi
  rm -rf "$tailscale_scratch"
  find_tailscale
  [ -n "$tailscale" ] || fail "Tailscale installed, but its command was not found; ${manual}"
}

# Starts Tailscale and, when it is signed out, runs `tailscale up` and opens the sign-in page it
# prints. On Linux the signed-in user becomes Tailscale's operator, so `fleet invite` can publish
# this machine with `tailscale serve` without root.
ensure_tailscale() {
  tailscale_plan=''
  find_tailscale
  if [ -z "$tailscale" ]; then
    install_tailscale
    "$dry_run" && return 0
  fi
  state="$(tailscale_state)"
  [ "$state" = Running ] && return 0
  if "$dry_run"; then
    tailscale_plan="start Tailscale and open its sign-in page"
    return 0
  fi
  step "Starting Tailscale..."
  if [ "$platform" = darwin ]; then
    # The app runs the tailnet connection; its first launch asks to allow its VPN configuration.
    [ -d "$tailscale_app" ] && open -a "$tailscale_app" >/dev/null 2>&1 </dev/null || true
  elif [ -z "$state" ] || [ "$state" = NoState ]; then
    as_root systemctl enable --now tailscaled >/dev/null 2>&1 </dev/null || true
  fi
  # Starting can take a few seconds, and on a first macOS launch until the VPN prompt is allowed.
  waited=0
  while :; do
    state="$(tailscale_state)"
    case "$state" in Running | NeedsLogin | NeedsMachineAuth | Stopped) break ;; esac
    [ "$waited" -lt "$tailscale_wait" ] ||
      fail "Tailscale did not start; open it (on a Mac, allow its VPN configuration when asked), then run this again"
    if [ "$waited" -eq 4 ] && [ "$platform" = darwin ]; then
      clear_line
      printf '  Waiting for Tailscale. If macOS asks to allow its VPN configuration, click Allow.\n' >&2
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ "$state" = Running ] && { clear_line; return 0; }
  clear_line
  if [ "$state" = Stopped ]; then
    printf '  Turning Tailscale on...\n' >&2
  else
    printf '  Sign in to Tailscale with the account your main machine uses. Your browser opens\n' >&2
    printf '  the sign-in page; if it does not, open the link below.\n' >&2
  fi
  if [ "$platform" = darwin ]; then
    set -- "$tailscale" up
  else
    set -- as_root "$tailscale" up "--operator=$(id -un)"
  fi
  # `tailscale up` prints the sign-in link and returns once the sign-in finishes.
  "$@" 2>&1 </dev/null | while IFS= read -r line; do
    url="$(printf '%s\n' "$line" | sed -n 's|.*\(https://login\.tailscale\.com/[^[:space:]]*\).*|\1|p')"
    if [ -n "$url" ]; then
      printf '\n    %s\n\n' "$url" >&2
      open_url "$url"
    fi
  done
  state="$(tailscale_state)"
  case "$state" in
    Running) printf '  Tailscale is signed in.\n' >&2 ;;
    NeedsMachineAuth)
      fail "Tailscale is signed in, but your tailnet admin must approve this machine first (https://login.tailscale.com/admin/machines); then run this again" ;;
    *) fail "Tailscale is not signed in yet; sign in with the account your main machine uses, then run this again" ;;
  esac
}

print_plan() {
  clear_line
  printf 'Dry run: nothing was installed or changed.\n'
  printf '  Version:   %s (%s-%s)\n' "$version" "$platform" "$arch"
  printf '  Archive:   %s/v%s/%s\n' "$base_url" "$version" "$archive"
  printf '             sha256 %s, from SHA256SUMS\n' "$archive_sha256"
  if "$node_download"; then
    printf '  Node.js:   would download %s\n' "$node_url"
    printf '             sha256 %s (pinned) into %s\n' "$node_sha256" "$private_node_dir"
  else
    printf '  Node.js:   %s\n' "$node"
  fi
  if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
    printf '  Install:   %s (already there)\n' "$target_dir"
  else
    printf '  Install:   %s\n' "$target_dir"
  fi
  printf '  Commands:  %s/specwithcode, %s/specweave-studio\n' "$bin_dir" "$bin_dir"
  if [ -n "$service_skip" ]; then
    printf '  Service:   not installed, because %s\n' "$service_skip"
  else
    printf '  Service:   specwithcode service install\n'
  fi
  if "$join"; then printf '  Join:      %sspecwithcode fleet invite\n' "${tailscale_plan:+${tailscale_plan}; then }"; fi
}

install_node() {
  "$node_download" || return 0
  step "Downloading Node.js ${node_version}..."
  mkdir -p "${studio_home}/runtime/node"
  node_staging="$(mktemp -d "${studio_home}/runtime/node/.staging-XXXXXX")"
  download "$node_url" "${node_staging}/node.tar.gz" || fail "could not download ${node_url}"
  [ "$(checksum "${node_staging}/node.tar.gz")" = "$node_sha256" ] || fail "checksum mismatch for ${node_url}"
  mkdir "${node_staging}/tree"
  tar -xzf "${node_staging}/node.tar.gz" -C "${node_staging}/tree" --strip-components=1
  [ "$("${node_staging}/tree/bin/node" --version 2>/dev/null)" = "v${node_version}" ] ||
    fail "the downloaded Node.js does not run on this machine"
  rm -rf "$private_node_dir"
  mv "${node_staging}/tree" "$private_node_dir"
  rm -rf "$node_staging"
  node_staging=''
}

# The executable `specwithcode service install` pins and the service runs: this release's
# bin.mjs under the chosen Node.js. The name it was started as becomes STUDIO_CLI_NAME, so the
# commands it prints match what was typed.
render_entry() {
  printf '#!/bin/sh\n'
  printf '# specwithcode-install launcher: runs this release with the Node.js the installer chose.\n'
  # shellcheck disable=SC2016
  printf 'STUDIO_CLI_NAME="${0##*/}"\nexport STUDIO_CLI_NAME\n'
  if [ -n "${STUDIO_HOME:-}" ]; then
    # shellcheck disable=SC2016
    printf 'if [ -z "${STUDIO_HOME:-}" ]; then STUDIO_HOME=%s; export STUDIO_HOME; fi\n' "$(shell_quote "$studio_home")"
  fi
  # shellcheck disable=SC2016
  printf 'exec %s %s "$@"\n' "$(shell_quote "$node")" "$(shell_quote "$1/bin.mjs")"
}

manifest_value() {  # manifest_value FILE KEY: a top-level string of studio-manifest.json
  sed -n "s/^  \"$2\": \"\([^\"]*\)\",\{0,1\}$/\1/p" "$1" | head -n 1
}

install_runtime() {
  if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ] &&
    [ -x "$entry" ]; then
    step "SpecWithCode ${version} is already downloaded."
    # The installer's own launcher follows a changed Node.js; any other executable stays as it is.
    if grep -q '^# specwithcode-install launcher' "$entry" 2>/dev/null; then
      render_entry "$target_dir" > "${entry}.new"
      chmod 755 "${entry}.new"
      if cmp -s "${entry}.new" "$entry"; then rm -f "${entry}.new"; else mv "${entry}.new" "$entry"; fi
    fi
    return 0
  fi
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  clear_line
  printf '  %sInstalling%s SpecWithCode %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  download "${base_url}/v${version}/${archive}" "${scratch}/${archive}" || fail "could not download ${archive}"

  step "Verifying the download..."
  [ "$(checksum "${scratch}/${archive}")" = "$archive_sha256" ] || fail "checksum mismatch for ${archive}"

  step "Extracting SpecWithCode..."
  tar -xzf "${scratch}/${archive}" -C "$staging"
  rm -f "${scratch}/${archive}"
  manifest="${staging}/studio-manifest.json"
  [ -f "$manifest" ] && [ -f "${staging}/bin.mjs" ] || fail "${archive} is not a SpecWithCode server archive"
  [ "$(manifest_value "$manifest" version)" = "$version" ] &&
    [ "$(manifest_value "$manifest" platform)" = "$platform" ] &&
    [ "$(manifest_value "$manifest" arch)" = "$arch" ] ||
    fail "${archive} is not the ${version} build for ${platform}-${arch}"
  # Written for the final path, so the launcher never names the staging folder.
  render_entry "$target_dir" > "${staging}/specweave-studio"
  chmod 755 "${staging}/specweave-studio"
  reported="$("$node" "${staging}/bin.mjs" --version 2>/dev/null)" ||
    fail "SpecWithCode ${version} does not start with ${node}"
  case "$reported" in *"v${version}") ;; *) fail "the downloaded archive reports ${reported}, not ${version}" ;; esac
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  staging=''
}

# shlex.quote: the quoting launcher.py uses, so the wrapper text is byte for byte what it writes.
py_quote() {
  case "$1" in
    '') printf "''" ;;
    *[!A-Za-z0-9_@%+=:,./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# launcher.runtime_path: an explicit PATH for Git hooks and agent tools, never the caller's.
runtime_path() {
  path_out=''
  for directory in "${node%/*}" "$HOME/.local/share/specweave/providers/bin" "$HOME/.local/bin" \
    /opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin /usr/local/sbin /usr/bin /bin /usr/sbin /sbin; do
    case ":${path_out}:" in *":${directory}:"*) ;; *) path_out="${path_out:+${path_out}:}${directory}" ;; esac
  done
  printf '%s' "$path_out"
}

# The `specwithcode` and `specweave-studio` launchers, in the format the fleet installer and the
# service updater write (scripts/studio-fleet/launcher.py render_cli): a clean environment with
# this home and an explicit PATH, the name it was run as, then Node.js on this release's bin.mjs.
render_cli_wrapper() {
  user="$(id -un)"
  words=''
  for word in /usr/bin/env -i "HOME=${HOME}" "USER=${user}" "LOGNAME=${user}" "PATH=$(runtime_path)" \
    LANG=en_US.UTF-8 "TMPDIR=${TMPDIR:-/tmp}" "STUDIO_HOME=${studio_home}" \
    STUDIO_ENABLE_HOSTED_SERVICES=false PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never; do
    words="${words:+${words} }$(py_quote "$word")"
  done
  # shellcheck disable=SC2016
  name=' "STUDIO_CLI_NAME=${0##*/}"'
  command_words="$(py_quote "$node") $(py_quote "${target_dir}/bin.mjs")"
  # shellcheck disable=SC2016
  printf '#!/bin/sh\nset -eu\numask 077\nif [ "${STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD+x}" = x ]; then\n  case "$STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD" in true|false) ;; *) exit 2 ;; esac\n  exec %s "$@"\nfi\nexec %s "$@"\n' \
    "${words} \"STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=\$STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD\"${name} ${command_words}" \
    "${words}${name} ${command_words}"
}

install_launchers() {
  step "Setting up the specwithcode command..."
  for value in "$HOME" "$node" "$studio_home" "${TMPDIR:-/tmp}"; do
    case "$value" in *:* | *"
"*) fail "${value} cannot be used in a launcher PATH (it holds a colon or a line break)" ;; esac
  done
  mkdir -p "$bin_dir"
  render_cli_wrapper > "${bin_dir}/.specwithcode.install-new"
  chmod 700 "${bin_dir}/.specwithcode.install-new"
  # Both names hold byte-identical text; a rename replaces an older symlink without following it.
  cp -p "${bin_dir}/.specwithcode.install-new" "${bin_dir}/.specweave-studio.install-new"
  mv -f "${bin_dir}/.specwithcode.install-new" "${bin_dir}/specwithcode"
  mv -f "${bin_dir}/.specweave-studio.install-new" "${bin_dir}/specweave-studio"
  "${bin_dir}/specwithcode" --version >/dev/null 2>&1 || fail "${bin_dir}/specwithcode does not run"
  clear_line
  printf '  %sInstalled SpecWithCode %s%s\n' "$green" "$version" "$reset" >&2
}

install_service() {
  service_state=skipped
  if [ -n "$service_skip" ]; then
    printf '  Background service not installed: %s.\n' "$service_skip" >&2
    return 0
  fi
  step "Starting the background service..."
  clear_line
  "$entry" service install >&2 ||
    fail "the background service did not install; see \`specwithcode service status\`, then run \`specwithcode service install\` again"
  service_state=installed
}

# run_invite ATTEMPTS COMMAND...: COMMAND fleet invite. A server takes a few seconds to answer
# after its service starts, so only "no running server" is retried, every 2 seconds.
run_invite() {
  attempts="$1"
  shift
  step "Publishing this machine on your tailnet..."
  tries=0
  while :; do
    if "$@" fleet invite > "${scratch}/invite.out" 2> "${scratch}/invite.err"; then
      clear_line
      printf '\n' >&2
      cat "${scratch}/invite.out"
      return 0
    fi
    tries=$((tries + 1))
    if ! grep -q 'No running SpecWithCode server found' "${scratch}/invite.out" "${scratch}/invite.err" ||
      [ "$tries" -ge "$attempts" ]; then
      clear_line
      cat "${scratch}/invite.out" "${scratch}/invite.err" >&2
      fail "\`specwithcode fleet invite\` did not finish; fix the problem above, then run \`specwithcode fleet invite\`"
    fi
    sleep 2
  done
}

print_join_next_step() {
  printf '  Next: on your main machine, run the %sfleet add%s command above, or paste the line\n' "$bold" "$reset" >&2
  printf '  into Settings > Connections > Add a machine.\n\n' >&2
}

print_next_steps() {
  printf '\n' >&2
  case ":${PATH}:" in
    *":${bin_dir}:"*) ;;
    *)
      printf '  %s is not on your PATH yet. Add it, then open a new terminal:\n' "$bin_dir" >&2
      case "${SHELL:-}" in
        */zsh) rc="$HOME/.zshrc" ;;
        */bash) if [ "$platform" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
        *) rc='' ;;
      esac
      if [ -n "$rc" ]; then
        printf '    echo %s >> %s\n\n' "$(shell_quote "export PATH=\"${bin_dir}:\$PATH\"")" "$rc" >&2
      else
        # shellcheck disable=SC2016
        printf '    export PATH="%s:$PATH"\n\n' "$bin_dir" >&2
      fi
      ;;
  esac
  if "$join"; then
    print_join_next_step
  elif [ "$service_state" = installed ]; then
    printf '  SpecWithCode runs in the background; check it with %sspecwithcode service status%s.\n' "$bold" "$reset" >&2
    printf '  To add this machine to your main one, sign in to Tailscale and run %sspecwithcode fleet invite%s.\n\n' "$bold" "$reset" >&2
  else
    printf '  Run %sspecwithcode%s to start it, or %sspecwithcode service install%s to keep it running.\n\n' "$bold" "$reset" "$bold" "$reset" >&2
  fi
}

main "$@"
