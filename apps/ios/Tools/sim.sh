#!/bin/bash
# Simulator-first runs of the iPhone app: no phone, no unlocked screen, no
# Simulator window. Everything targets one dedicated simulator that this
# script creates and owns, booted headless with simctl.
#
# usage: Tools/sim.sh <command> [args]
#
#   ensure                 create (once) and boot the dedicated simulator; prints its UDID
#   build                  xcodegen + build-for-testing for that simulator
#   test [xcodebuild args] test-without-building; pass -only-testing:... to narrow it
#   smoke                  ensure, build, then the routine UI suite (see SMOKE below)
#   run [fixture] [route]  install and launch on fixture data, then save a screenshot
#   link <url>             open a URL (deep link) in the running app, then save a screenshot
#   logs [minutes]         save the app's unified log from the last N minutes (default 5)
#   stop                   shut the dedicated simulator down
#
# Environment: SIM_NAME names the simulator (default "SWC Sim-First"; give each
# worktree its own name to run in parallel), SIM_DEVICE_TYPE and SIM_RUNTIME
# pick what to create, DERIVED_DATA the build folder (default build/DerivedData),
# OUT the evidence folder (default build/sim-first). Run from apps/ios.
set -euo pipefail

SIM_NAME=${SIM_NAME:-SWC Sim-First}
SIM_DEVICE_TYPE=${SIM_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}
DERIVED_DATA=${DERIVED_DATA:-build/DerivedData}
OUT=${OUT:-build/sim-first}
BUNDLE=com.specwithcode.ios.dev
APP="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/SpecWithCode.app"
# The routine UI suite: every fixture-driven class. LiveServerTests needs a real
# machine and skips itself without SWC_LIVE_LINK.
SMOKE=${SMOKE:-SpecWithCodeUITests}

# The agent harness injects GIT_CONFIG_* and that breaks SwiftPM's package
# resolution inside xcodebuild, so every build runs without them.
xcb() {
  env -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 \
    xcodebuild "$@"
}

stamp() { date +%Y%m%d-%H%M%S; }

# Prints the UDID of the dedicated simulator, or nothing.
find_sim() {
  xcrun simctl list devices -j | python3 -I -c '
import json, sys
name = sys.argv[1]
for runtime, devices in json.load(sys.stdin)["devices"].items():
    for d in devices:
        if d["name"] == name and d.get("isAvailable", True):
            print(d["udid"]); sys.exit(0)
' "$SIM_NAME"
}

latest_ios_runtime() {
  xcrun simctl list runtimes -j | python3 -I -c '
import json, sys
ios = [r for r in json.load(sys.stdin)["runtimes"] if r.get("platform") == "iOS" and r.get("isAvailable")]
if not ios: sys.exit("No iOS Simulator runtime is installed. Add one in Xcode > Settings > Components.")
ios.sort(key=lambda r: [int(p) for p in r["version"].split(".")])
print(ios[-1]["identifier"])
'
}

ensure() {
  local udid
  udid=$(find_sim)
  if [ -z "$udid" ]; then
    local runtime=${SIM_RUNTIME:-$(latest_ios_runtime)}
    udid=$(xcrun simctl create "$SIM_NAME" "$SIM_DEVICE_TYPE" "$runtime")
    echo "Created simulator \"$SIM_NAME\" ($udid) on $runtime" >&2
  fi
  local state
  state=$(xcrun simctl list devices -j | python3 -I -c '
import json, sys
for devices in json.load(sys.stdin)["devices"].values():
    for d in devices:
        if d["udid"] == sys.argv[1]: print(d["state"])
' "$udid")
  if [ "$state" != "Booted" ]; then
    # simctl boot starts the device without the Simulator app or any window.
    xcrun simctl boot "$udid"
  fi
  xcrun simctl bootstatus "$udid" -b >/dev/null
  echo "$udid"
}

require_sim() {
  local udid
  udid=$(find_sim)
  [ -n "$udid" ] || { echo "No simulator named \"$SIM_NAME\". Run: Tools/sim.sh ensure" >&2; exit 1; }
  echo "$udid"
}

build() {
  local udid=$1
  mkdir -p "$OUT"
  xcodegen generate >/dev/null
  echo "Building for testing on $SIM_NAME ($udid); log: $OUT/build.log" >&2
  if ! xcb -project SpecWithCode.xcodeproj -scheme SpecWithCode \
      -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$DERIVED_DATA" \
      build-for-testing >"$OUT/build.log" 2>&1; then
    grep -E "error:|BUILD FAILED" "$OUT/build.log" | tail -20 >&2
    echo "Build failed; full log: $OUT/build.log" >&2
    exit 1
  fi
}

run_tests() {
  local udid=$1; shift
  local dir="$OUT/$(stamp)"
  mkdir -p "$dir"
  local result="$dir/Tests.xcresult"
  echo "Testing on $SIM_NAME ($udid); evidence: $dir" >&2
  local status=0
  xcb -project SpecWithCode.xcodeproj -scheme SpecWithCode \
    -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$DERIVED_DATA" \
    -resultBundlePath "$result" "$@" test-without-building >"$dir/test.log" 2>&1 || status=$?
  xcrun xcresulttool get test-results summary --path "$result" --compact >"$dir/summary.json" 2>/dev/null || true
  xcrun xcresulttool export attachments --path "$result" --output-path "$dir/attachments" >/dev/null 2>&1 || true
  python3 -I - "$dir/summary.json" <<'PY' || true
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
print(f"{s.get('result')}: {s.get('passedTests', 0)} passed, {s.get('failedTests', 0)} failed, {s.get('skippedTests', 0)} skipped")
for f in s.get("testFailures", [])[:20]:
    print(f"  FAIL {f.get('testIdentifierString') or f.get('testName')}: {f.get('failureText', '').strip()[:300]}")
PY
  echo "Result bundle: $result" >&2
  echo "Screenshots: $dir/attachments" >&2
  return $status
}

install_app() {
  local udid=$1
  [ -d "$APP" ] || { echo "No app at $APP. Run: Tools/sim.sh build" >&2; exit 1; }
  xcrun simctl install "$udid" "$APP"
}

shot() {
  local udid=$1 name=$2
  local file="$OUT/$(stamp)-$name.png"
  mkdir -p "$OUT"
  xcrun simctl io "$udid" screenshot "$file" >/dev/null 2>&1
  echo "$file"
}

cmd=${1:-}
[ -n "$cmd" ] || { sed -n '2,22p' "$0" >&2; exit 2; }
shift || true

case "$cmd" in
  ensure)
    ensure
    ;;
  build)
    build "$(ensure)"
    ;;
  test)
    run_tests "$(ensure)" "$@"
    ;;
  smoke)
    udid=$(ensure)
    build "$udid"
    run_tests "$udid" "-only-testing:$SMOKE"
    ;;
  run)
    fixture=${1:-default}
    route=${2:-}
    udid=$(ensure)
    install_app "$udid"
    args=(-SWCFixture "$fixture" -SWCAppearance "${APPEARANCE:-light}")
    [ -n "$route" ] && args+=(-SWCRoute "$route")
    xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE" "${args[@]}" >/dev/null
    sleep "${WAIT:-3}"
    shot "$udid" "${fixture}${route:+-$route}"
    ;;
  link)
    url=${1:?usage: Tools/sim.sh link <url>}
    udid=$(require_sim)
    xcrun simctl openurl "$udid" "$url"
    sleep "${WAIT:-2}"
    shot "$udid" link
    ;;
  logs)
    minutes=${1:-5}
    udid=$(require_sim)
    mkdir -p "$OUT"
    file="$OUT/$(stamp)-app.log"
    xcrun simctl spawn "$udid" log show --last "${minutes}m" --style compact \
      --predicate 'process == "SpecWithCode"' >"$file" 2>&1 || true
    echo "$file"
    ;;
  stop)
    udid=$(find_sim)
    [ -n "$udid" ] && xcrun simctl shutdown "$udid" 2>/dev/null || true
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    sed -n '2,22p' "$0" >&2
    exit 2
    ;;
esac
