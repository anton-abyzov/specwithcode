#!/usr/bin/env python3
"""The canary soak (increment 1239, D-04): once M4 runs the candidate, watch it for --seconds (15 min
by default) before any other machine is asked. Every --interval it runs the candidate's own
fleet_health.py (read-only) and reads what the service appended to <home>/stderr.log since the soak
began. The soak fails at once when the health check is not `ok` or a new stderr line reads as an
error; it passes when the whole window stays clean. Writes nothing.

    python3 -B scripts/release/canary_soak.py --fleet-dir <build>/scripts/studio-fleet [--identity m4]
                                              [--seconds 900] [--interval 60] [--base-dir DIR]

Prints one JSON line {result: passed|failed, rounds, reason, errors}. Exit 0 passed, 1 failed, 2 bad
arguments.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ERROR = re.compile(r'\b(error|fatal|panic|uncaught|unhandled|traceback|assertionerror)\b', re.IGNORECASE)
READ_LIMIT = 4 << 20  # Bytes of new stderr read per round; the service writes far less.
SHOWN = 5


class Stderr(object):
    """New lines of a log that the update agent may truncate in place (update_agent_run.rotate_service_log)."""

    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.offset = self.size()
        self.partial = b''

    def size(self):
        try:
            return os.stat(str(self.path)).st_size
        except OSError:
            return 0

    def new_lines(self):
        size = self.size()
        if size < self.offset:  # Truncated by a rotation: what is there now is all new.
            self.offset, self.partial = 0, b''
        if size == self.offset:
            return []
        try:
            with open(str(self.path), 'rb') as handle:
                handle.seek(self.offset)
                data = handle.read(min(size - self.offset, READ_LIMIT))
        except OSError:
            return []
        self.offset += len(data)
        data = self.partial + data
        lines = data.split(b'\n')
        self.partial = lines.pop()
        return [line.decode('utf-8', 'replace') for line in lines]


def health(command, timeout=60):
    """(status, summary) from fleet_health.py --json; status 'failed' when it gave no report."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        report = json.loads(result.stdout)
        problems = report.get('problems') or []
        return report.get('status'), '; '.join(str(item) for item in problems)[:500] or 'exit %d' % result.returncode
    except (OSError, subprocess.TimeoutExpired, ValueError, AttributeError) as error:
        return 'failed', 'fleet_health.py gave no report (%s)' % type(error).__name__


def soak(command, stderr_path, seconds, interval, sleep=time.sleep, clock=time.monotonic):
    log = Stderr(stderr_path)
    begin, rounds = clock(), 0
    while True:
        rounds += 1
        status, summary = health(command)
        if status != 'ok':
            return {'result': 'failed', 'rounds': rounds, 'reason': 'fleet_health.py reports %s: %s' % (status, summary)}
        errors = [line.strip() for line in log.new_lines() if ERROR.search(line)]
        if errors:
            return {'result': 'failed', 'rounds': rounds, 'errors': errors[:SHOWN],
                    'reason': '%d new error line(s) in %s' % (len(errors), stderr_path)}
        if clock() - begin >= seconds:
            return {'result': 'passed', 'rounds': rounds, 'seconds': seconds}
        sleep(max(0, min(interval, seconds - (clock() - begin))))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--fleet-dir', required=True, help="the candidate's scripts/studio-fleet")
    parser.add_argument('--identity', default='m4')
    parser.add_argument('--base-dir', help='the service home (default: the identity home)')
    parser.add_argument('--seconds', type=int, default=900)
    parser.add_argument('--interval', type=int, default=60)
    args = parser.parse_args(argv)
    if args.seconds < 0 or args.interval < 0:
        parser.error('--seconds and --interval cannot be negative')
    fleet = pathlib.Path(args.fleet_dir).resolve()
    if not (fleet / 'fleet_health.py').is_file():
        parser.error('%s has no fleet_health.py' % fleet)
    if args.base_dir:
        base = pathlib.Path(args.base_dir).expanduser()
    else:
        sys.path.insert(0, str(fleet))
        import studio_paths
        base = studio_paths.identity_home(pathlib.Path.home(), args.identity)
    command = [sys.executable, '-B', str(fleet / 'fleet_health.py'), '--identity', args.identity,
               '--base-dir', str(base), '--json']
    outcome = soak(command, base / 'stderr.log', args.seconds, args.interval)
    print(json.dumps(dict(outcome, identity=args.identity)))
    if outcome['result'] != 'passed':
        print('canary_soak: %s' % outcome['reason'], file=sys.stderr)
        for line in outcome.get('errors', []):
            print('canary_soak:   %s' % line[:300], file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
