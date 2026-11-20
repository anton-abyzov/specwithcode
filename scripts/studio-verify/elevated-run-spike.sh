#!/bin/bash
# Measures, on a real Mac, what the administrator prompt for code-block runs
# relies on: the prompt can be drawn from this process, one password primes
# sudo for the same terminal only, and `sudo -k` drops it again.
#
#   elevated-run-spike.sh --run <report.md>          asks for the password once
#   elevated-run-spike.sh --check-report <report.md> exits 0 when the report is complete
#
# The password goes from the macOS dialog to sudo's pipe. This script never
# reads, prints or stores it.
set -u

mode="${1:-}"
report="${2:-}"
if [ -z "$report" ] || { [ "$mode" != "--run" ] && [ "$mode" != "--check-report" ]; }; then
  echo "usage: $0 --run|--check-report <report.md>" >&2
  exit 64
fi

required_keys="session prompt_exit same_terminal other_terminal no_terminal as_user as_root after_drop protected_write"

if [ "$mode" = "--check-report" ]; then
  [ -s "$report" ] || { echo "missing report: $report" >&2; exit 1; }
  for key in $required_keys; do
    grep -q "^| $key |" "$report" || { echo "report lacks $key" >&2; exit 1; }
  done
  echo "report complete: $report"
  exit 0
fi

[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/elevated-run-spike.XXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

printf '%s' "SpecWithCode check (increment 1438)

This is a one-time test of the administrator prompt on $(scutil --get ComputerName 2>/dev/null || hostname). It runs 'sudo -v' and 'id', changes nothing, and forgets the password when it ends." > "$work/label.txt"

cat > "$work/askpass.sh" <<EOF
#!/bin/sh
exec /usr/bin/osascript - "$work/label.txt" <<'OSA'
on run argv
  set labelText to read POSIX file (item 1 of argv) as «class utf8»
  set answer to display dialog labelText default answer "" with hidden answer with title "SpecWithCode" buttons {"Cancel", "OK"} default button "OK" giving up after 120 with icon caution
  if gave up of answer then error number -128
  return text returned of answer
end run
OSA
EOF
chmod 700 "$work/askpass.sh"

cat > "$work/inner.sh" <<EOF
#!/bin/sh
out="$work/results.txt"
if sudo -n true 2>/dev/null; then echo "before=no password needed" >> "\$out"; else echo "before=password needed" >> "\$out"; fi
SUDO_ASKPASS="$work/askpass.sh" sudo -A -v 2>>"$work/prompt.err"
echo "prompt_exit=\$?" >> "\$out"
sudo -n true 2>/dev/null; echo "same_terminal=\$?" >> "\$out"
echo "as_user=\$(id -un)" >> "\$out"
echo "as_root=\$(sudo -n id -un 2>/dev/null)" >> "\$out"
echo "as_other=\$(sudo -n -u nobody id -un 2>/dev/null)" >> "\$out"
/usr/bin/script -q /dev/null sudo -n true >/dev/null 2>&1; echo "other_terminal=\$?" >> "\$out"
/usr/bin/perl -e 'use POSIX; if (fork) { wait; exit(\$? >> 8) } setsid(); exec @ARGV' sudo -n true </dev/null >/dev/null 2>&1
echo "no_terminal=\$?" >> "\$out"
sudo -n sh -c ': >> /Library/Preferences/com.apple.networkextension.plist' 2>"$work/write.err"
echo "protected_write=\$?" >> "\$out"
sudo -k
sudo -n true 2>/dev/null; echo "after_drop=\$?" >> "\$out"
EOF
chmod 700 "$work/inner.sh"

/usr/bin/script -q /dev/null /bin/sh "$work/inner.sh" >/dev/null 2>&1

value() { grep "^$1=" "$work/results.txt" 2>/dev/null | head -1 | cut -d= -f2-; }

tcc="$HOME/Library/Application Support/com.apple.TCC"
if ls "$tcc" >/dev/null 2>"$work/tcc.err"; then fda="readable"; else fda="$(sed 's/.*: //' "$work/tcc.err" | head -1)"; fi

ancestors=""
pid=$$
for _ in 1 2 3 4 5 6 7 8; do
  pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ -z "$pid" ] || [ "$pid" = "0" ] && break
  ancestors="$ancestors$(basename "$(ps -o comm= -p "$pid")") < "
  [ "$pid" = "1" ] && break
done

{
  echo "# 1438 spike: the administrator prompt on $(scutil --get ComputerName 2>/dev/null || hostname)"
  echo
  echo "Measured $(date '+%B %-d, %Y %H:%M %Z') on macOS $(sw_vers -productVersion), $(sudo -V | head -1)."
  echo
  echo "Exit codes: 0 means sudo ran without asking, 1 means it would have asked."
  echo
  echo "| Check | Result |"
  echo "|---|---|"
  echo "| session | $(launchctl managername) |"
  echo "| started by | ${ancestors% < } |"
  echo "| before | $(value before) |"
  echo "| prompt_exit | $(value prompt_exit) |"
  echo "| prompt_error | $(tr '\n' ' ' < "$work/prompt.err" 2>/dev/null) |"
  echo "| same_terminal | $(value same_terminal) |"
  echo "| as_user | $(value as_user) |"
  echo "| as_root | $(value as_root) |"
  echo "| as_other | $(value as_other) |"
  echo "| other_terminal | $(value other_terminal) |"
  echo "| no_terminal | $(value no_terminal) |"
  echo "| after_drop | $(value after_drop) |"
  echo "| protected_write | $(value protected_write) $(tr '\n' ' ' < "$work/write.err" 2>/dev/null) |"
  echo "| tcc_folder | $fda |"
} > "$report"

cat "$report"
