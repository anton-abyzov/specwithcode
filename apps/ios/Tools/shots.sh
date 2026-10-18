#!/bin/bash
# Fixture screenshots of every launch route, light and dark, plus contact sheets.
#
# usage: Tools/shots.sh <simulator-udid> [derived-data-dir] [out-dir]
#
#   simulator-udid    the booted simulator to use (default: $SIM_UDID). It is
#                     required: the script installs into, relaunches and restyles
#                     it. "booted" is accepted only while exactly one simulator
#                     is booted.
#   derived-data-dir  installs SpecWithCode.app from this build first
#                     (default: $DERIVED_DATA or build/DerivedData, when it has the app;
#                     "-" shoots the app already installed)
#   out-dir           where the PNGs go (default: build/shots)
#
# Environment: ROUTES overrides the route list, WAIT the seconds to wait after
# each launch (default 3), CONTENT_SIZE a content size category to shoot with,
# SHEET=0 skips the contact sheets. The simulator's appearance and content size
# are put back as they were when the script exits.
set -euo pipefail

usage() {
  echo "usage: Tools/shots.sh <simulator-udid> [derived-data-dir] [out-dir]" >&2
  echo "       (or set SIM_UDID; list simulators with: xcrun simctl list devices booted)" >&2
  exit 2
}

U=${1:-${SIM_UDID:-}}
[ -n "$U" ] || usage
DD=${2:-}
OUT=${3:-build/shots}
B=com.specwithcode.ios.dev
ROUTES=${ROUTES:-overview thread drawer search settings projectSettings machines pair}

# Resolve the device once, so every command below targets the same simulator.
DEVICE=$(xcrun simctl list devices -j | python3 -I -c '
import json, sys
want = sys.argv[1]
devices = [d for runtime in json.load(sys.stdin)["devices"].values() for d in runtime]
if want == "booted":
    booted = [d for d in devices if d.get("state") == "Booted"]
    if len(booted) != 1:
        sys.exit(f"{len(booted)} simulators are booted; pass a simulator UDID instead of \"booted\".")
    device = booted[0]
else:
    matches = [d for d in devices if d.get("udid") == want]
    if not matches:
        sys.exit(f"No simulator has the UDID {want}. List them with: xcrun simctl list devices")
    device = matches[0]
udid, name = device["udid"], device["name"]
if device.get("state") != "Booted":
    sys.exit(f"{name} ({udid}) is not booted. Boot it first: xcrun simctl boot {udid}")
print(udid)
print(name)
' "$U")
U=$(printf '%s\n' "$DEVICE" | sed -n 1p)
echo "Simulator: $(printf '%s\n' "$DEVICE" | sed -n 2p) ($U)" >&2

mkdir -p "$OUT"

if [ "$DD" = "-" ]; then
  :
elif [ -n "$DD" ]; then
  APP="$DD/Build/Products/Debug-iphonesimulator/SpecWithCode.app"
  if [ ! -d "$APP" ]; then
    echo "No app at $APP. Build first." >&2
    exit 1
  fi
  xcrun simctl install "$U" "$APP"
else
  APP="${DERIVED_DATA:-build/DerivedData}/Build/Products/Debug-iphonesimulator/SpecWithCode.app"
  [ -d "$APP" ] && xcrun simctl install "$U" "$APP"
fi

# Put the simulator's appearance and content size back however the script ends.
ORIG_APPEARANCE=$(xcrun simctl ui "$U" appearance 2>/dev/null || true)
ORIG_CONTENT_SIZE=$(xcrun simctl ui "$U" content_size 2>/dev/null || true)
restore_ui() {
  case "$ORIG_APPEARANCE" in
    light|dark) xcrun simctl ui "$U" appearance "$ORIG_APPEARANCE" >/dev/null 2>&1 || true ;;
  esac
  if [ -n "${CONTENT_SIZE:-}" ]; then
    case "$ORIG_CONTENT_SIZE" in
      ""|unknown|unsupported) ORIG_CONTENT_SIZE=large ;;
    esac
    xcrun simctl ui "$U" content_size "$ORIG_CONTENT_SIZE" >/dev/null 2>&1 || true
  fi
}
trap restore_ui EXIT
trap 'exit 130' INT TERM

if [ -n "${CONTENT_SIZE:-}" ]; then
  xcrun simctl ui "$U" content_size "$CONTENT_SIZE"
fi

shot() {
  local name=$1
  shift
  xcrun simctl launch --terminate-running-process "$U" "$B" "$@" >/dev/null
  sleep "${WAIT:-3}"
  xcrun simctl io "$U" screenshot "$OUT/$name.png" >/dev/null 2>&1
  echo "$OUT/$name.png"
}

for theme in light dark; do
  xcrun simctl ui "$U" appearance "$theme"
  shot "home-$theme" -SWCFixture default -SWCAppearance "$theme"
  for r in $ROUTES; do
    shot "$r-$theme" -SWCFixture default -SWCAppearance "$theme" -SWCRoute "$r"
  done
  shot "running-$theme" -SWCFixture running -SWCAppearance "$theme" -SWCRoute thread
  shot "welcome-$theme" -SWCFixture empty -SWCAppearance "$theme"
done

[ "${SHEET:-1}" = "0" ] && exit 0

python3 - "$OUT" <<'PY'
import os, sys
try:
    from PIL import Image
except ImportError:
    print("Pillow is not installed; skipping contact sheets", file=sys.stderr)
    sys.exit(0)
out = sys.argv[1]
for theme in ("light", "dark"):
    files = sorted(f for f in os.listdir(out) if f.endswith(f"-{theme}.png"))
    order = ["home", "overview", "thread", "running", "drawer", "search", "settings", "projectSettings", "machines", "pair", "welcome"]
    files.sort(key=lambda f: order.index(f[: -len(f"-{theme}.png")]) if f[: -len(f"-{theme}.png")] in order else 99)
    if not files:
        continue
    ims = [Image.open(os.path.join(out, f)).convert("RGB") for f in files]
    w, h = ims[0].size
    s = 0.33
    W, H = int(w * s), int(h * s)
    cols = 6
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (W * cols + 10 * (cols - 1), H * rows + 10 * (rows - 1)), "white")
    for i, im in enumerate(ims):
        sheet.paste(im.resize((W, H)), ((i % cols) * (W + 10), (i // cols) * (H + 10)))
    path = os.path.join(out, f"sheet-{theme}.png")
    sheet.save(path)
    print(path)
PY
