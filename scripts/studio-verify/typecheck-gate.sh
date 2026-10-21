#!/bin/bash
# Type checks the workspace and fails only on diagnostics that are not in the committed
# baseline, so a known-red package can still gate releases and pull requests while its
# baseline is burned down.
#
#   bash scripts/studio-verify/typecheck-gate.sh [--out DIR] [--jobs N] [--package DIR]...
#   bash scripts/studio-verify/typecheck-gate.sh --write-baseline
#   bash scripts/studio-verify/typecheck-gate.sh --from-logs DIR
#
# Every workspace package (pnpm-workspace.yaml) with a `typecheck` script runs
# its `typecheck` script with sh in its directory (node_modules/.bin on PATH, like `node --run`,
# whose exit codes cannot be trusted: see typecheck_in), at most --jobs at a time (default 2). Each error or
# warning diagnostic reduces to `<repo-relative file> <code>`; line numbers are dropped so
# unrelated edits do not churn the baseline. The gate fails when
#   - a file has more diagnostics of a code than scripts/studio-verify/typecheck-baseline.txt
#     allows (a new file or code counts from 0),
#   - a typecheck exits non-zero without any diagnostic to explain it, or with a code other than
#     1 (the only diagnostic exit of `tsc --noEmit` and `astro check`), times out, or leaves no
#     result,
#   - its log shows a crash at any exit code: a Go panic or `fatal error:` (TypeScript 7's tsc is
#     a native Go binary, and Go exits 2 on a panic or out-of-memory), or a Node heap or stack
#     overflow.
# Warnings count because the Effect language service fails `tsc` on warnings. Suggestions do
# not. A baseline entry the run no longer produces is reported so the baseline can shrink.
#
# --out             logs, exit codes and current.txt (default: a new temporary directory)
# --package DIR     check only this package directory (repeatable); the baseline entries of
#                   other packages are kept as they are
# --baseline FILE   compare with FILE instead of the committed baseline
# --write-baseline  after the run, rewrite the baseline entries of the packages that ran
# --from-logs DIR   compare an earlier run's logs in DIR without type checking again
#
# Environment: TYPECHECK_TIMEOUT (seconds per package, default 600); TYPECHECK_TSC_ARGS, extra
# arguments for packages whose typecheck script is tsc, default `--checkers 2` as in CI. The
# checker count is tsc's memory setting (the native binary ignores NODE_OPTIONS heap sizes):
# apps/server peaks near 12 GB with tsc's default four checkers and 8 GB with two. It also
# changes the result: four checkers report 9 more Effect diagnostics in apps/server/src/server.ts,
# so a local run must use CI's count to match it. Set TYPECHECK_TSC_ARGS= (empty) to pass none.
# A tsc package must resolve the workspace's own tsc; a global tsc on PATH is refused.
# Ctrl-C or a TERM stops every running typecheck.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SELF="$HERE/typecheck-gate.sh"

die() {
  echo "typecheck-gate.sh: $*" >&2
  exit 2
}

slug() {
  echo "$1" | sed 's#/#__#g'
}

# job_run and job_pool: each typecheck in its own process group under a watchdog, stopped with
# the run on Ctrl-C or TERM.
. "$HERE/jobs.sh"

typecheck_in() {
  cd "$ROOT/$1" || return
  if grep -q '"typecheck": *"tsc ' package.json \
    && [ ! -x node_modules/.bin/tsc ] && [ ! -x "$ROOT/node_modules/.bin/tsc" ]; then
    # Without it the shell would fall through to whatever tsc is on PATH, such as an older global
    # JavaScript tsc that runs out of Node heap where the workspace's tsc does not.
    echo "typecheck-gate.sh: the workspace tsc is not installed (no node_modules/.bin/tsc); run pnpm install"
    return 127
  fi
  local script
  script="$(node -e 'process.stdout.write(require("./package.json").scripts.typecheck)')" || return
  if [ -n "${TYPECHECK_TSC_ARGS:-}" ] && grep -q '"typecheck": *"tsc ' package.json; then
    script="$script $TYPECHECK_TSC_ARGS"
  fi
  # Not `node --run`: it reports every failing exit as 1 and a checker killed by a signal (the
  # OOM killer) as 0, so a crash after some baselined output would pass. sh keeps 2 and 128+n.
  PATH="$PWD/node_modules/.bin:$ROOT/node_modules/.bin:$PATH" exec sh -c "$script"
}

# Internal: type check one package under the watchdog; job_run records its exit code and secs.
run_one() {
  job_run "$1" "$(slug "$2")" "$LIMIT" typecheck_in "$2"
}

export TYPECHECK_TSC_ARGS="${TYPECHECK_TSC_ARGS---checkers 2}"
LIMIT="${TYPECHECK_TIMEOUT:-600}"
case "$LIMIT" in
  '' | *[!0-9]* | 0) die "TYPECHECK_TIMEOUT must be a positive number of seconds" ;;
esac

# Workspace package directories from pnpm-workspace.yaml that define a typecheck script.
workspace_typecheck_packages() {
  python3 -B - "$ROOT" <<'PY'
import glob, json, os, sys
root = sys.argv[1]
patterns, inside = [], False
with open(os.path.join(root, 'pnpm-workspace.yaml'), encoding='utf-8') as handle:
    for line in handle:
        if line.startswith('packages:'):
            inside = True
        elif inside and line[:1] not in (' ', '\t', '#', '\n', ''):
            break
        elif inside and line.strip().startswith('- '):
            patterns.append(line.strip()[2:].strip().strip('"\''))
for pattern in patterns:
    for directory in sorted(glob.glob(os.path.join(root, pattern))):
        manifest = os.path.join(directory, 'package.json')
        if os.path.isfile(manifest) and json.load(open(manifest, encoding='utf-8')).get('scripts', {}).get('typecheck'):
            print(os.path.relpath(directory, root))
PY
}

if [ "${1:-}" = "--run-one" ]; then
  [ $# -eq 3 ] || die "usage: --run-one OUT PACKAGE"
  run_one "$2" "$3"
  exit 0
fi

OUT=""
JOBS=2
PACKAGES=""
BASELINE="$HERE/typecheck-baseline.txt"
WRITE=0
FROM_LOGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift 2;;
    --jobs) [ $# -ge 2 ] || die "--jobs needs a number"; JOBS="$2"; shift 2;;
    --package) [ $# -ge 2 ] || die "--package needs a directory"; PACKAGES="$PACKAGES ${2%/}"; shift 2;;
    --baseline) [ $# -ge 2 ] || die "--baseline needs a file"; BASELINE="$2"; shift 2;;
    --write-baseline) WRITE=1; shift;;
    --from-logs) [ $# -ge 2 ] || die "--from-logs needs a directory"; FROM_LOGS="$2"; shift 2;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SELF"; exit 0;;
    # pnpm run passes the `--` of `pnpm run <script> -- <options>` through.
    --) shift;;
    *) die "unknown option: $1 (see --help)";;
  esac
done
case "$JOBS" in
  1|2|3|4) ;;
  *) die "--jobs must be 1, 2, 3 or 4";;
esac
[ -f "$BASELINE" ] || [ "$WRITE" -eq 1 ] || die "baseline not found: $BASELINE"

if [ -n "$FROM_LOGS" ]; then
  OUT="$(cd "$FROM_LOGS" && pwd)"
  [ -s "$OUT/packages.txt" ] || die "no packages.txt in $OUT"
else
  if [ -z "$OUT" ]; then
    OUT="$(mktemp -d "${TMPDIR:-/tmp}/studio-typecheck.XXXXXX")"
  else
    mkdir -p "$OUT"
    OUT="$(cd "$OUT" && pwd)"
  fi
  [ -n "$PACKAGES" ] || PACKAGES="$(workspace_typecheck_packages)"
  : > "$OUT/packages.txt"
  for package in $PACKAGES; do
    [ -f "$ROOT/$package/package.json" ] || die "not a package directory: $package"
    name="$(slug "$package")"
    rm -f "$OUT/$name.log" "$OUT/$name.exit" "$OUT/$name.secs" "$OUT/$name.timeout"
    echo "$package" >> "$OUT/packages.txt"
  done
  [ -s "$OUT/packages.txt" ] || die "no workspace package has a typecheck script"
  echo "Type checking $(wc -l < "$OUT/packages.txt" | tr -d ' ') packages, $JOBS at a time; logs in $OUT"
  runner=0
  job_pool "$OUT/packages.txt" "$JOBS" bash "$SELF" --run-one "$OUT" || runner=$?
  [ "$runner" -eq 0 ] || die "a typecheck runner failed ($runner)"
fi

python3 -B - "$ROOT" "$OUT" "$BASELINE" "$WRITE" <<'PY'
import os, re, sys

root, out, baseline_path, write = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
TSC = re.compile(r'^([^\s(][^(]*)\((\d+),(\d+)\): (error|warning) (TS\d+):')
GLOBAL = re.compile(r'^(error|warning) (TS\d+):')
ASTRO = re.compile(r'^(\S+):(\d+):(\d+) - (error|warning) ts\((\d+)\)')
# A crash at any exit code: Go's panic and runtime fatal errors (the native tsc, which exits 2
# for them), and Node's heap and stack overflows (a JavaScript checker such as astro check).
CRASH = re.compile(r'^(panic: |fatal error: |runtime: out of memory|goroutine \d+ \[|'
                   r'FATAL ERROR: |<--- Last few GCs --->|RangeError: Maximum call stack size exceeded)'
                   r'|JavaScript heap out of memory')
# The only exit of `tsc --noEmit` and `astro check` that diagnostics explain.
DIAGNOSTIC_EXIT = '1'
HEADER = ('# Known type-check diagnostics: <repo-relative file> <code> <count>.\n'
          '# scripts/studio-verify/typecheck-gate.sh fails only on diagnostics beyond these.\n'
          '# Shrink it as files are fixed: bash scripts/studio-verify/typecheck-gate.sh --write-baseline\n')

def key_file(package, name):
    path = name if os.path.isabs(name) else os.path.join(root, package, name)
    return os.path.relpath(os.path.normpath(path), root).replace(os.sep, '/')

def read_baseline(path):
    counts = {}
    if not os.path.exists(path):
        return counts
    with open(path, encoding='utf-8') as handle:
        for number, line in enumerate(handle, 1):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            if len(parts) != 3 or not parts[2].isdigit():
                sys.exit('%s:%d: expected "<file> <code> <count>"' % (path, number))
            counts[(parts[0], parts[1])] = int(parts[2])
    return counts

def owner(file, packages):
    best = None
    for package in packages:
        if file == package or file.startswith(package + '/'):
            if best is None or len(package) > len(best):
                best = package
    return best

with open(os.path.join(out, 'packages.txt'), encoding='utf-8') as handle:
    packages = [line.strip() for line in handle if line.strip()]
baseline = read_baseline(baseline_path)
current, rows, failed = {}, [], False
for package in packages:
    name = package.replace('/', '__')
    log, exit_file = os.path.join(out, name + '.log'), os.path.join(out, name + '.exit')
    found = {}
    crash = None
    if os.path.exists(log):
        with open(log, encoding='utf-8', errors='replace') as handle:
            for line in handle:
                line = line.rstrip('\n')
                if crash is None and CRASH.search(line):
                    crash = line.strip()
                match = TSC.match(line)
                if match:
                    key = (key_file(package, match.group(1)), match.group(5))
                else:
                    match = ASTRO.match(line)
                    if match:
                        key = (key_file(package, match.group(1)), 'TS' + match.group(5))
                    else:
                        match = GLOBAL.match(line)
                        if not match:
                            continue
                        key = (package + '/<global>', match.group(2))
                found[key] = found.get(key, 0) + 1
    code = open(exit_file).read().strip() if os.path.exists(exit_file) else None
    timed_out = os.path.exists(os.path.join(out, name + '.timeout'))
    new = {key: count - baseline.get(key, 0) for key, count in found.items() if count > baseline.get(key, 0)}
    reason = None
    if timed_out:
        result = 'TIMEOUT'
    elif code is None:
        result = 'NO-RESULT'
    elif crash is not None:
        result, reason = 'FAIL', 'crashed (exit %s): %s' % (code, crash)
    elif code != '0' and not found:
        result, reason = 'FAIL', 'exit %s with no diagnostic to explain it' % code
    elif code not in ('0', DIAGNOSTIC_EXIT):
        # A signal (128 + n) or another non-diagnostic exit after some output: the diagnostics
        # it printed may be a fraction of what a finished run reports.
        result, reason = 'FAIL', 'exit %s is not a diagnostic exit, so the run did not finish' % code
    elif new:
        result = 'NEW'
    else:
        result = 'pass'
    failed = failed or result != 'pass'
    rows.append((package, code or '-', sum(found.values()), sum(new.values()), result, new, log, reason))
    # A file two packages both check (scripts/lib) keeps the larger count: the baseline bounds
    # what each package may report.
    for key, count in found.items():
        current[key] = max(current.get(key, 0), count)

print('%-34s %4s %6s %5s  %s' % ('PACKAGE', 'EXIT', 'DIAGS', 'NEW', 'RESULT'))
for package, code, total, added, result, new, log, reason in rows:
    print('%-34s %4s %6d %5d  %s' % (package, code, total, added, 'baselined' if write and result == 'NEW' else result))
for package, code, total, added, result, new, log, reason in rows:
    if result == 'pass' or (write and result == 'NEW'):
        continue
    print('--- %s: %s (log: %s)' % (package, result, log))
    if reason:
        print('  %s' % reason)
    for (file, code_), count in sorted(new.items()):
        print('  new: %s %s (+%d)' % (file, code_, count))
    if result in ('FAIL', 'TIMEOUT', 'NO-RESULT') and os.path.exists(log):
        with open(log, encoding='utf-8', errors='replace') as handle:
            tail = handle.readlines()[-20:]
        sys.stdout.write(''.join(tail))

checked = set(packages)
covered = lambda key: owner(key[0], checked) is not None or key in current
stale = sorted((key, count) for key, count in baseline.items()
               if covered(key) and current.get(key, 0) < count)
for (file, code_), count in stale:
    print('fixed: %s %s (baseline %d, now %d)' % (file, code_, count, current.get((file, code_), 0)))
if stale:
    print('The baseline can shrink: bash scripts/studio-verify/typecheck-gate.sh --write-baseline')

with open(os.path.join(out, 'current.txt'), 'w', encoding='utf-8') as handle:
    for (file, code_), count in sorted(current.items()):
        handle.write('%s %s %d\n' % (file, code_, count))

if write:
    if any(row[4] in ('FAIL', 'TIMEOUT', 'NO-RESULT') for row in rows):
        sys.exit('Not writing the baseline: a typecheck failed without diagnostics or did not finish')
    kept = {key: count for key, count in baseline.items() if not covered(key)}
    kept.update(current)
    with open(baseline_path, 'w', encoding='utf-8') as handle:
        handle.write(HEADER)
        for (file, code_), count in sorted(kept.items()):
            handle.write('%s %s %d\n' % (file, code_, count))
    print('Wrote %d baseline entries to %s' % (len(kept), baseline_path))
    sys.exit(0)

total = sum(row[3] for row in rows)
print('Typecheck gate: %d packages, %d new diagnostics, %s' % (len(rows), total, 'FAILED' if failed else 'passed'))
sys.exit(1 if failed else 0)
PY
