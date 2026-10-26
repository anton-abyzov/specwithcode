#!/bin/bash
# Use DEVELOPER_DIR for a side-by-side Xcode; never switch the shared toolchain.
# check: no device/store changes. test: owns SWC-1079-Duo, boots without a window.
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:-check}
case "$action" in check|test) ;; *) echo "usage: $0 [check|test]" >&2; exit 2 ;; esac
sdk=$(xcrun --sdk iphonesimulator --show-sdk-version)
python3 -I - "$sdk" <<'PY'
import sys
version=tuple(int(p) for p in sys.argv[1].split('.')[:2])
if version < (27,1):
    sys.exit(f'BLOCKED: iOS simulator SDK {sys.argv[1]}; require 27.1+. Set DEVELOPER_DIR to a side-by-side Xcode 27.1 installation.')
PY
device=$(xcrun simctl list devicetypes -j | python3 -I -c '
import json,sys
matches=[d["identifier"] for d in json.load(sys.stdin)["devicetypes"] if d["name"] == "iPhone Duo"]
if not matches: sys.exit("BLOCKED: iPhone Duo simulator device type is not installed.")
print(matches[0])')
runtime=$(xcrun simctl list runtimes -j | python3 -I -c '
import json,sys
matches=[r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r.get("platform")=="iOS" and tuple(map(int,r["version"].split(".")[:2])) >= (27,1)]
if not matches: sys.exit("BLOCKED: available iOS 27.1+ simulator runtime is required.")
print(max(matches,key=lambda r:tuple(map(int,r["version"].split("."))))["identifier"])')
printf 'Duo prerequisites ready: SDK %s, %s, %s\n' "$sdk" "$device" "$runtime"
if [ "$action" = test ]; then
  # sim.sh reuses a name; verify its identity before it can mutate a device.
  xcrun simctl list devices -j | python3 -I -c '
import json,sys
name,kind,runtime=sys.argv[1:]
found=[(r,d) for r,ds in json.load(sys.stdin)["devices"].items() for d in ds if d["name"]==name]
if len(found)>1: sys.exit("BLOCKED: duplicate owned Duo simulator names; resolve before testing.")
if found:
    r,d=found[0]
    if r!=runtime or d.get("deviceTypeIdentifier")!=kind or not d.get("isAvailable",False):
        sys.exit("BLOCKED: existing SWC-1079-Duo has a different type/runtime or is unavailable; preserving it.")
' SWC-1079-Duo "$device" "$runtime"
  export SIM_NAME=SWC-1079-Duo SIM_DEVICE_TYPE="$device" SIM_RUNTIME="$runtime"
  export PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never
  export OUT=build/duo DERIVED_DATA=build/DuoDerivedData
  bash Tools/sim.sh build
  bash Tools/sim.sh test -only-testing:SpecWithCodeTests/AdaptiveDrawerTests -only-testing:SpecWithCodeUITests/AdaptiveLayoutUITests
fi
