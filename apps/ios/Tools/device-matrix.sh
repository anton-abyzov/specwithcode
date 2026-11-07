#!/usr/bin/env bash
# The Duo has no simulator on hosted runners; PhoneWidthLayoutTests covers its
# folded width (358) and DuoWideLayoutTests its unfolded one.
#
# Renders the app on fixture data across iPhone width classes and saves one
# screenshot per device and screen, so a layout change is checked on compact,
# standard, Pro Max and Duo widths at once. Headless: simctl only.
#
# usage: Tools/device-matrix.sh [out-dir]   (run from apps/ios after a build)
#   DEVICES  newline-separated device type names; the first match of each wins
#   APP      the built SpecWithCode.app for the simulator
set -euo pipefail

OUT=${1:-build/device-matrix}
APP=${APP:-build/DerivedData/Build/Products/Debug-iphonesimulator/SpecWithCode.app}
BUNDLE=com.specwithcode.ios.dev
DEVICES=${DEVICES:-"iPhone SE (3rd generation)
iPhone 16e
iPhone 16
iPhone 16 Plus
iPhone 17
iPhone 17 Pro Max
iPhone Air
iPhone Duo"}
# fixture|route|extra launch arguments|file name
SCENES=${SCENES:-"fleet|||coordinator
fleet|thread||thread
fleet|drawer||drawer
default|||aide
long|thread||long-thread
running|thread||running"}

[ -d "$APP" ] || { echo "No app at $APP" >&2; exit 1; }
mkdir -p "$OUT"
runtime=$(xcrun simctl list runtimes -j | python3 -I -c '
import json, sys
ios = [r for r in json.load(sys.stdin)["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
ios.sort(key=lambda r: [int(p) for p in r["version"].split(".")])
print(ios[-1]["identifier"])')
xcrun simctl list devicetypes > "$OUT/devicetypes.txt"

while IFS= read -r name; do
  [ -n "$name" ] || continue
  type=$(xcrun simctl list devicetypes -j | python3 -I -c '
import json, sys
for t in json.load(sys.stdin)["devicetypes"]:
    if t["name"] == sys.argv[1]: print(t["identifier"]); break' "$name")
  if [ -z "$type" ]; then echo "skip: no device type \"$name\"" | tee -a "$OUT/skipped.txt"; continue; fi
  slug=$(echo "$name" | tr 'A-Z ()' 'a-z-' | tr -s '-' | sed 's/-$//')
  udid=$(xcrun simctl create "matrix $name" "$type" "$runtime")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 >/dev/null 2>&1 || true
  xcrun simctl install "$udid" "$APP"
  while IFS='|' read -r fixture route extra file; do
    [ -n "$fixture" ] || continue
    args=(-SWCFixture "$fixture" -SWCAppearance light)
    [ -n "$route" ] && args+=(-SWCRoute "$route")
    # shellcheck disable=SC2206
    [ -n "$extra" ] && args+=($extra)
    xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE" "${args[@]}" >/dev/null
    sleep "${WAIT:-6}"
    xcrun simctl io "$udid" screenshot "$OUT/$slug-$file.png" >/dev/null 2>&1 || echo "screenshot failed: $slug-$file" >&2
    echo "$OUT/$slug-$file.png"
  done <<< "$SCENES"
  xcrun simctl shutdown "$udid" || true
  xcrun simctl delete "$udid" || true
done <<< "$DEVICES"
