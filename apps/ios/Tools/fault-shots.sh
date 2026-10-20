#!/bin/bash
# Screenshots of the fleet fixture's scripted machine outages: each sequence is
# shot before the machine drops, while it is out, and after it comes back.
#
# usage: Tools/fault-shots.sh <simulator-udid> [out-dir]
#
# Install the app first (Tools/shots.sh does, or xcrun simctl install). The
# fixture drops the machine 6 seconds after launch and brings it back 6 seconds
# later, so the shots are taken at about 3, 9 and 15 seconds.
set -euo pipefail

U=${1:-${SIM_UDID:-}}
[ -n "$U" ] || { echo "usage: Tools/fault-shots.sh <simulator-udid> [out-dir]" >&2; exit 2; }
OUT=${2:-build/fault-shots}
B=com.specwithcode.ios.dev
mkdir -p "$OUT"

launch() { xcrun simctl launch --terminate-running-process "$U" "$B" -SWCFixture "$1" -SWCAppearance light -SWCRoute "$2" >/dev/null; }
shot() { xcrun simctl io "$U" screenshot --type=png "$OUT/$1.png" >/dev/null 2>&1; }

for route in overview drawer coordinator; do
  launch fleet "$route"; sleep 4; shot "fleet-$route"
done

for pair in m4-blip:overview m4-blip:coordinator minis-blip:orchestrator minis-blip:overview; do
  fixture=${pair%%:*} route=${pair#*:}
  launch "$fixture" "$route"
  sleep 3; shot "$fixture-$route-1-before"
  sleep 6; shot "$fixture-$route-2-offline"
  sleep 6; shot "$fixture-$route-3-back"
done

echo "Wrote $(ls "$OUT"/*.png | wc -l | tr -d ' ') screenshots to $OUT" >&2
