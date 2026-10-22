#!/bin/bash
# Exercise the device helper without Xcode, signing, provisioning or a device.
# Optional first argument selects another device.sh for regression verification.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
DEVICE_SCRIPT=${1:-$SCRIPT_DIR/device.sh}
case "$DEVICE_SCRIPT" in
  /*) ;;
  *) DEVICE_SCRIPT="$PWD/$DEVICE_SCRIPT" ;;
esac
[ -f "$DEVICE_SCRIPT" ] || { echo "Missing device helper: $DEVICE_SCRIPT" >&2; exit 2; }

FIXTURE=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/swc-device-test.XXXXXX")
trap '/bin/rm -rf -- "$FIXTURE"' EXIT
/bin/mkdir "$FIXTURE/bin"

# PATH contains only these stubs plus env. An unexpected executable cannot
# fall through to the developer's real Xcode or device tools.
/bin/ln -s /usr/bin/env "$FIXTURE/bin/env"
cat > "$FIXTURE/bin/stub" <<'STUB'
#!/bin/bash
set -eu
case "${0##*/}" in
  xcodegen) step=generate; status=${MOCK_GENERATE_EXIT:-0} ;;
  xcodebuild) step=build; status=${MOCK_BUILD_EXIT:-0} ;;
  xcrun)
    case "$*" in
      'devicectl list devices') step=list; status=${MOCK_LIST_EXIT:-0} ;;
      'devicectl device install app '*) step=install; status=${MOCK_INSTALL_EXIT:-0} ;;
      'devicectl device process launch '*) step=launch; status=${MOCK_LAUNCH_EXIT:-0} ;;
      *) printf 'Unexpected xcrun arguments: %s\n' "$*" >&2; exit 99 ;;
    esac
    ;;
  *) exit 99 ;;
esac
printf '%s\n' "$step" >> "$MOCK_LOG"
if [ "$status" -ne 0 ]; then
  printf '%s\n' "${MOCK_ERROR:-fixture $step failure}" >&2
fi
exit "$status"
STUB
/bin/chmod +x "$FIXTURE/bin/stub"
for tool in xcodegen xcodebuild xcrun; do
  /bin/ln -s stub "$FIXTURE/bin/$tool"
done

passed=0
failed=0

run_case() {
  local name=$1 configuration=$2 expected_status=$3 expected_steps=$4 diagnostic=$5
  shift 5
  local case_dir="$FIXTURE/$name" status=0 reason=''
  /bin/mkdir "$case_dir"
  : > "$case_dir/commands"
  local environment=(PATH="$FIXTURE/bin" MOCK_LOG="$case_dir/commands")
  if [ "$configuration" != bare ]; then
    environment+=(DEVICE='Fixture iPhone' STUDIO_APPLE_TEAM_ID=FIXTURE_TEAM)
  fi
  case "$configuration" in
    generate_fail) environment+=(MOCK_GENERATE_EXIT=64) ;;
    build_fail) environment+=(MOCK_BUILD_EXIT=65) ;;
    install_fail) environment+=(MOCK_INSTALL_EXIT=17) ;;
    launch_locked) environment+=(MOCK_LAUNCH_EXIT=7 MOCK_ERROR='fixture: phone locked') ;;
    launch_disconnected) environment+=(MOCK_LAUNCH_EXIT=19 MOCK_ERROR='fixture: device disconnected') ;;
    launch_signature) environment+=(MOCK_LAUNCH_EXIT=23 MOCK_ERROR='fixture: invalid code signature') ;;
    list_fail) environment+=(MOCK_LIST_EXIT=11) ;;
    missing_device) environment+=(DEVICE=) ;;
    missing_team) environment+=(STUDIO_APPLE_TEAM_ID=) ;;
  esac
  (
    cd "$case_dir"
    /usr/bin/env -i "${environment[@]}" /bin/bash "$DEVICE_SCRIPT" "$@"
  ) > "$case_dir/stdout" 2> "$case_dir/stderr" || status=$?

  [ "$status" -eq "$expected_status" ] || reason="exit $status, expected $expected_status"
  local actual_steps
  actual_steps=$(< "$case_dir/commands")
  [ "$actual_steps" = "$expected_steps" ] || reason="${reason:+$reason; }unexpected command stages: $actual_steps"
  if [ -n "$diagnostic" ] && ! /usr/bin/grep -Fq -- "$diagnostic" "$case_dir/stderr"; then
    reason="${reason:+$reason; }missing original diagnostic: $diagnostic"
  fi
  case "$configuration" in
    launch_*)
      if ! /usr/bin/grep -Fq -- "installed; launch failed (exit $expected_status); successful launch was not confirmed." "$case_dir/stderr"; then
        reason="${reason:+$reason; }missing honest install/launch outcome"
      fi
      ;;
  esac
  case "$name" in
    help|long_help|short_help)
      if ! /usr/bin/grep -Fq 'Usage: Tools/device.sh' "$case_dir/stdout"; then
        reason="${reason:+$reason; }missing help output"
      fi
      ;;
    success)
      [ ! -s "$case_dir/stderr" ] || reason="${reason:+$reason; }unexpected success diagnostic"
      ;;
  esac
  if [ -z "$reason" ]; then
    passed=$((passed + 1))
    printf 'PASS %s\n' "$name"
  else
    failed=$((failed + 1))
    printf 'FAIL %s: %s\n' "$name" "$reason" >&2
  fi
}

all_steps=$'generate\nbuild\ninstall\nlaunch'
run_case success configured 0 "$all_steps" ''
run_case help bare 0 '' '' help
run_case long_help bare 0 '' '' --help
run_case short_help bare 0 '' '' -h
run_case help_configured configured 0 '' '' --help
run_case list bare 0 list '' list
run_case list_failure list_fail 11 list 'fixture list failure' list
run_case unknown_help_typo configured 2 '' '' --hlep
run_case unknown_list_typo configured 2 '' '' lits
run_case unsupported_dry_run configured 2 '' '' --dry-run
run_case explicit_empty_argument configured 2 '' '' ''
run_case extra_list_argument configured 2 '' '' list extra
run_case extra_help_argument configured 2 '' '' help extra
run_case extra_unknown_argument configured 2 '' '' unknown extra
run_case unknown_without_configuration bare 2 '' '' unknown
run_case missing_device missing_device 1 '' 'DEVICE: set DEVICE'
run_case missing_team missing_team 1 '' 'STUDIO_APPLE_TEAM_ID: set STUDIO_APPLE_TEAM_ID'
run_case generation_failure generate_fail 64 generate 'fixture generate failure'
run_case build_failure build_fail 65 $'generate\nbuild' 'fixture build failure'
run_case install_failure install_fail 17 $'generate\nbuild\ninstall' 'fixture install failure'
run_case launch_locked launch_locked 7 "$all_steps" 'fixture: phone locked'
run_case launch_disconnected launch_disconnected 19 "$all_steps" 'fixture: device disconnected'
run_case launch_signature launch_signature 23 "$all_steps" 'fixture: invalid code signature'

printf '%s passed; %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
