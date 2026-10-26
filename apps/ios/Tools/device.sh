#!/bin/bash
# Install the Release app straight onto a USB- or Wi-Fi-paired iPhone, without
# waiting for TestFlight. The build is signed Apple Development, has the store
# bundle id com.specwithcode.ios and replaces a TestFlight install in place;
# the next TestFlight install replaces it back.
#
# usage: Tools/device.sh [list|help]
#
#   (no command)  xcodegen + Release device build + install + launch
#   list          paired devices (names and identifiers for DEVICE)
#   help          show usage (also --help or -h)
#
# Environment: DEVICE is the devicectl name or identifier (required to
# install), STUDIO_APPLE_TEAM_ID the team (required), BUILD_NUMBER the
# CFBundleVersion (default: project.yml; set it above the latest TestFlight
# build to tell them apart), DERIVED_DATA the build folder (default
# build/DerivedData-device). ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH let
# xcodebuild create the development profile with an App Store Connect key;
# without them it uses the Xcode account. The device must be registered in the
# team. Every launch failure returns nonzero, even when installation succeeded
# and the phone is simply locked. Run from apps/ios.
set -euo pipefail

DERIVED_DATA=${DERIVED_DATA:-build/DerivedData-device}
BUNDLE=com.specwithcode.ios
APP="$DERIVED_DATA/Build/Products/Release-iphoneos/SpecWithCode.app"

# Same as Tools/sim.sh: injected GIT_CONFIG_* breaks SwiftPM resolution.
xcb() {
  env -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 \
    xcodebuild "$@"
}

usage() {
  printf '%s\n' \
    'Usage: Tools/device.sh [list|help]' \
    '  No arguments: build, install and launch (requires DEVICE and STUDIO_APPLE_TEAM_ID).' \
    '  list: show paired devices. help, --help, -h: show this usage.'
}

if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  case "$1" in
    list) exec xcrun devicectl list devices ;;
    help|--help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
fi

: "${DEVICE:?set DEVICE to a name or identifier from: Tools/device.sh list}"
: "${STUDIO_APPLE_TEAM_ID:?set STUDIO_APPLE_TEAM_ID to the Apple team id}"
export STUDIO_APPLE_TEAM_ID

args=(-allowProvisioningUpdates)
if [ -n "${ASC_KEY_ID:-}" ]; then
  : "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required with ASC_KEY_ID}"
  args+=(-authenticationKeyPath "${ASC_KEY_PATH:-$HOME/.private_keys/AuthKey_$ASC_KEY_ID.p8}"
    -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi
[ -n "${BUILD_NUMBER:-}" ] && args+=(CURRENT_PROJECT_VERSION="$BUILD_NUMBER")

node Tools/generate-device-stream.mjs
xcodegen generate
xcb -project SpecWithCode.xcodeproj -scheme SpecWithCode -configuration Release \
  -destination generic/platform=iOS -derivedDataPath "$DERIVED_DATA" \
  DEVELOPMENT_TEAM="$STUDIO_APPLE_TEAM_ID" "${args[@]}" build

xcrun devicectl device install app --device "$DEVICE" "$APP"
if xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE"; then
  exit 0
else
  launch_status=$?
  printf 'installed; launch failed (exit %s); successful launch was not confirmed.\n' "$launch_status" >&2
  exit "$launch_status"
fi
