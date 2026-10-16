#!/bin/sh
# Installs the SpecWithCode CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://studio.invalid/install.sh | sh
#
# Environment:
#   STUDIO_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   STUDIO_VERSION           exact version to install (overrides STUDIO_CHANNEL)
#   STUDIO_HOME              Studio home directory (default: ~/.specwithcode; an
#                            existing real ~/.specweave-studio is kept until migrated)
#   STUDIO_INSTALL_BIN_DIR   where the `specweave-studio` symlink goes (default: ~/.local/bin)
#   STUDIO_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $STUDIO_HOME/runtime/versions/<version>, the
# same layout `specweave-studio service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="anton-abyzov/specwithcode"
base_url="${STUDIO_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
# ~/.specwithcode, unless only a real (unmigrated) legacy ~/.specweave-studio exists.
# A migrated legacy root is a link to the branded one.
default_studio_home="$HOME/.specwithcode"
if [ -d "$HOME/.specweave-studio" ] && [ ! -L "$HOME/.specweave-studio" ] && [ ! -e "$HOME/.specwithcode" ]; then
  default_studio_home="$HOME/.specweave-studio"
fi
studio_home="${STUDIO_HOME:-$default_studio_home}"
# Same spelling the CLI resolves STUDIO_HOME to, so both writers of the
# launcher agree on its target.
studio_home="$(printf '%s' "$studio_home" | tr -s /)"
[ "$studio_home" = / ] || studio_home="${studio_home%/}"
bin_dir="${STUDIO_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\nspecweave-studio install: %s\n' "$1" >&2
  exit 1
}

# The launcher is only ever this installer's own symlink into
# $STUDIO_HOME/runtime/versions. Anything else already at that path (another
# install, a hand-written wrapper) is left alone instead of being replaced.
launcher="${bin_dir}/specweave-studio"
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  case "$(readlink "$launcher" 2>/dev/null | tr -s /)" in
    "${studio_home}/runtime/versions/"*) ;;
    # A launcher written before the move still targets the linked legacy root.
    "$(printf '%s' "$HOME/.specweave-studio" | tr -s /)/runtime/versions/"*)
      [ -z "${STUDIO_HOME:-}" ] && [ -L "$HOME/.specweave-studio" ] ||
        fail "${launcher} already exists and is not a SpecWithCode launcher for ${studio_home}; move it, or set STUDIO_INSTALL_BIN_DIR to another directory" ;;
    *) fail "${launcher} already exists and is not a SpecWithCode launcher for ${studio_home}; move it, or set STUDIO_INSTALL_BIN_DIR to another directory" ;;
  esac
fi

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n  %sSpecWithCode%s\n' "$bold" "$reset" >&2
  printf '  %sCLI installer%s\n\n' "$muted" "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
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
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
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
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${STUDIO_CHANNEL:-stable}"
version="${STUDIO_VERSION:-}"
if [ -z "$version" ]; then
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "STUDIO_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index"
  version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set STUDIO_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "specweave-studio ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set STUDIO_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${STUDIO_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="studio-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${studio_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s SpecWithCode %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "specweave-studio ${version} has no release archive for ${platform}-${arch}; releases before the self-contained CLI can only be installed with \`npm install -g specweave-studio@${version}\`"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "${archive} is not listed in SHA256SUMS"
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting SpecWithCode..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/specweave-studio" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the specweave-studio command..."
mkdir -p "$bin_dir"
ln -sfn "${target_dir}/specweave-studio" "$launcher"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled SpecWithCode %s%s\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %sspecweave-studio%s to get started.\n\n' "$bold" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %sspecweave-studio%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
esac
