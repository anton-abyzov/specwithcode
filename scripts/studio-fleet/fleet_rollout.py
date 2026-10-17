#!/usr/bin/env python3
"""Install a published SpecWithCode release on the fleet in the documented order.

M4, the Mac this runs on, goes first with one forced request bound to the version and a
15-minute hold: its agent retries the snapshot every 10 seconds while the service drains
instead of waiting for a quiet period. A forced request never stops running work (that stays
the desktop's Update now), so a busy service keeps M4 waiting; its status message, printed as
it changes, says what is still running so a person can decide. The script polls the installed
version, never 'downloaded', and asks again only after the hold has ended, because each new
request restarts the agent's escalation.

M1 and M3 restart their tunnels to M4 when they update, and auth or orchestration events in
the middle of M4's snapshot and apply fail its guarded prestate, so they are asked only after
M4 reports the new version, and then together with a plain version-bound request.

Each request is written by update_request.py, streamed with studio_paths.py to the host's
/usr/bin/python3 (over the pinned fleet SSH key for M1 and M3, the network-transition.py
convention), so a host needs neither this repository nor a newer agent. Hosts come from
fleet_hosts.load_hosts(); nothing here names an address.

    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37        # M4, then M1 and M3
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --dry-run

Exit 0 when every host chosen reports the version, 1 when one does not, 2 for bad arguments.
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time

import fleet_hosts
import update_request

HERE = pathlib.Path(__file__).resolve().parent
SYSTEM_PYTHON = '/usr/bin/python3'
LOCAL = 'm4'
WORKERS = tuple(fleet_hosts.PORTS)
MODULES = ('studio_paths', 'update_request')
REQUEST_WINDOW = int(update_request.REQUEST_TTL.total_seconds())
CALL_TIMEOUT = 90
STATUS_FAILURES = 5  # Consecutive unanswered status reads before a host counts as lost.
VERSION = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
BOOT = """
import sys, types
for name in %r:
    module = types.ModuleType(name)
    module.__file__ = name + '.py'
    sys.modules[name] = module
    exec(compile(sources[name], name + '.py', 'exec'), module.__dict__)
sys.exit(sys.modules['update_request'].main(argv))
""" % (MODULES,)


class RolloutError(Exception):
    pass


def _tuple(version):
    match = VERSION.fullmatch(version) if isinstance(version, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def program(argv):
    """Python for `/usr/bin/python3 -B -`: this checkout's update_request.py and studio_paths.py,
    then update_request.main(argv)."""
    sources = {name: (HERE / (name + '.py')).read_text() for name in MODULES}
    return 'argv = %r\nsources = %r\n%s' % (list(argv), sources, BOOT)


def ssh_command(home, user, host):
    fleet = pathlib.Path(home) / '.local/share/specweave/fleet'
    return ['/usr/bin/ssh', '-F', '/dev/null', '-i', str(fleet / 'id_ed25519'), '-o', 'IdentitiesOnly=yes',
            '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + str(fleet / 'known_hosts'), '-o', 'ConnectTimeout=8',
            '-o', 'ControlMaster=no', user + '@' + host, '/usr/bin/python3 -B -']


class Host(object):
    """Runs update_request.py on one host. `command` reads the program on stdin."""

    def __init__(self, identity, command, extra=()):
        self.identity = identity
        self.command = list(command)
        self.extra = list(extra)  # Tests: --home for a temporary private home.

    def __call__(self, argv):
        argv = list(argv) + self.extra
        try:
            result = subprocess.run(self.command, input=program(argv), capture_output=True, text=True,
                                    timeout=CALL_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise RolloutError('%s did not answer within %ds' % (self.identity, CALL_TIMEOUT)) from None
        except OSError as error:
            raise RolloutError('%s could not be reached (%s)' % (self.identity, type(error).__name__)) from None
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        try:
            value = json.loads(lines[-1]) if lines else None
        except ValueError:
            value = None
        if not isinstance(value, dict):
            raise RolloutError('%s gave no answer (exit %d)' % (self.identity, result.returncode))
        if result.returncode != 0 or 'error' in value:
            raise RolloutError('%s: %s' % (self.identity, value.get('error') or 'exit %d' % result.returncode))
        return value


def fleet(home=None):
    """{identity: Host} for M4 (local) and every worker in the inventory."""
    home = pathlib.Path(home or pathlib.Path.home())
    hosts = {LOCAL: Host(LOCAL, [SYSTEM_PYTHON, '-B', '-'])}
    for identity, user, host, _tunnel, _https in fleet_hosts.worker_plans():
        hosts[identity] = Host(identity, ssh_command(home, user, host))
    return hosts


class Printer(object):
    def __init__(self, stream=None, clock=time.time):
        self.stream = stream or sys.stdout
        self.clock = clock
        self.lock = threading.Lock()

    def __call__(self, line):
        stamp = datetime.datetime.fromtimestamp(self.clock(), datetime.timezone.utc).strftime('%H:%M:%SZ')
        with self.lock:
            self.stream.write('%s %s\n' % (stamp, line))
            self.stream.flush()


def failed_since(status, version, since):
    """True when the agent recorded a failed install of `version` at or after `since` (the host's
    time of this rollout's first request) and it is not an install left running past its timeout."""
    last = status.get('lastInstall')
    if since is None or not isinstance(last, dict) or last.get('version') != version or last.get('result') != 'failed':
        return False
    at = update_request._time(last.get('at'))
    return at is not None and at >= since and 'left to finish' not in (status.get('message') or '')


def left_running(status, version, since):
    """True when the agent gave up waiting on an install of `version` (at or after `since`) and
    left the helper to finish: its checks after the restart may still roll it back."""
    last = status.get('lastInstall')
    if since is None or not isinstance(last, dict) or last.get('version') != version or last.get('result') != 'failed':
        return False
    at = update_request._time(last.get('at'))
    return at is not None and at >= since and 'left to finish' in (status.get('message') or '')


def roll_host(identity, call, version, force, hold_minutes, deadline, poll, clock, sleep, say):
    """Asks one host for `version` and waits until it reports it installed."""
    begin = clock()
    current = call(['status', '--identity', identity]).get('version')
    if current == version:
        say('%s: already on %s' % (identity, version))
        return {'identity': identity, 'result': 'already-installed', 'requests': 0, 'seconds': 0}
    if _tuple(current) is not None and _tuple(current) > _tuple(version):
        raise RolloutError('%s already runs %s, newer than %s' % (identity, current, version))
    window = hold_minutes * 60 if force else REQUEST_WINDOW

    def ask():
        argv = ['request', '--identity', identity, '--version', version, '--kickstart']
        if force:
            argv += ['--force', '--hold-minutes', str(hold_minutes)]
        reply = call(argv)
        mode = 'forced, held %d min' % hold_minutes if force else 'version-bound'
        say('%s: asked to install %s (%s) on %s' % (identity, version, mode, current or 'an unknown version'))
        if reply.get('kicked') is False:
            say('%s: launchctl kickstart failed; the agent still runs within 10 minutes' % identity)
        if first[0] is None:  # The host's own clock, the one its agent dates lastInstall by.
            first[0] = update_request._time((reply.get('request') or {}).get('installRequestedAt'))
        return clock()

    first = [None]
    asked, requests, seen, failures, status = ask(), 1, None, 0, {}
    while True:
        if clock() - begin >= deadline:
            raise RolloutError('%s did not install %s within %d min; last: %s %s' % (
                identity, version, deadline // 60, status.get('status'), status.get('message') or ''))
        sleep(poll)
        try:
            status = call(['status', '--identity', identity])
            failures = 0
        except RolloutError as error:
            failures += 1
            say('%s: status unavailable (%d/%d): %s' % (identity, failures, STATUS_FAILURES, error))
            if failures >= STATUS_FAILURES:
                raise
            continue
        if status.get('version') == version and failed_since(status, version, first[0]):
            # The new release kept running after a check following the restart failed
            # (rollback held for a person to review): it runs, but the update is not confirmed.
            raise RolloutError('%s runs %s, but a check after the restart failed, so the update is not confirmed: %s (receipt %s)' % (
                identity, version, status.get('message') or '', status['lastInstall'].get('receipt')))
        # The installed version flips before the updater's checks after the restart finish.
        if (status.get('version') == version and status.get('status') != 'installing'
                and not left_running(status, version, first[0])):
            seconds = int(clock() - begin)
            say('%s: installed %s after %ds' % (identity, version, seconds))
            return {'identity': identity, 'result': 'installed', 'requests': requests, 'seconds': seconds}
        if status.get('status') == 'manual-required':
            raise RolloutError('%s needs a manual upgrade: %s' % (identity, status.get('message') or ''))
        if failed_since(status, version, first[0]):
            # The guarded update rolled back. Asking again would restart the service to fail the
            # same way; a person reads the receipt first. An install left running past its
            # timeout is not a failure yet: its message says so and the poll goes on.
            raise RolloutError('%s tried %s and it failed, so it stays on %s: %s (receipt %s)' % (
                identity, version, status.get('version'), status.get('message') or '',
                status['lastInstall'].get('receipt')))
        offered = _tuple(status.get('availableVersion'))
        if offered is not None and offered > _tuple(version):
            raise RolloutError('%s is offered %s, newer than %s, and will not install %s' % (
                identity, status['availableVersion'], version, version))
        line = '%s: %s%s' % (identity, status.get('status'), ': ' + status['message'] if status.get('message') else '')
        if line != seen:
            say(line)
            seen = line
        if clock() - asked >= window:
            say('%s: the %s window ended without an install; asking once more' % (identity, 'hold' if force else 'request'))
            asked = ask()
            requests += 1


def rollout(version, hosts, only='all', hold_minutes=15, local_deadline=75 * 60, worker_deadline=30 * 60,
            worker_force=False, poll=15, clock=time.time, sleep=time.sleep, say=None):
    """M4 first, then M1 and M3 together. Returns {identity: result}; raises RolloutError."""
    say = say or Printer(clock=clock)
    results = {}
    if only in ('all', LOCAL):
        results[LOCAL] = roll_host(LOCAL, hosts[LOCAL], version, True, hold_minutes, local_deadline, poll,
                                   clock, sleep, say)
    if only in ('all', 'workers'):
        if only == 'workers':
            current = hosts[LOCAL](['status', '--identity', LOCAL]).get('version')
            if current != version:
                raise RolloutError('M4 runs %s, not %s: install it first (--only m4); M1 and M3 never go '
                                   'while M4 is updating' % (current, version))
        errors, lock = [], threading.Lock()

        def worker(identity):
            try:
                result = roll_host(identity, hosts[identity], version, worker_force, hold_minutes,
                                   worker_deadline, poll, clock, sleep, say)
                with lock:
                    results[identity] = result
            except RolloutError as error:
                with lock:
                    errors.append(str(error))

        threads = [threading.Thread(target=worker, args=(identity,), name='rollout-' + identity)
                   for identity in WORKERS]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if errors:
            raise RolloutError('; '.join(sorted(errors)))
    return results


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--version', required=True)
    parser.add_argument('--only', choices=('all', LOCAL, 'workers'), default='all')
    parser.add_argument('--hold-minutes', type=int, default=update_request.HOLD_MAX_MINUTES,
                        help='M4 hold (and worker hold with --worker-force), 1 to 15')
    parser.add_argument('--m4-deadline-minutes', type=int, default=75)
    parser.add_argument('--worker-deadline-minutes', type=int, default=30)
    parser.add_argument('--worker-force', action='store_true', help='force the M1 and M3 requests too')
    parser.add_argument('--poll-seconds', type=int, default=15)
    parser.add_argument('--dry-run', action='store_true', help='print the order and commands; contact no host')
    args = parser.parse_args(argv)
    if _tuple(args.version) is None:
        parser.error('--version must be X.Y.Z')
    if not 1 <= args.hold_minutes <= update_request.HOLD_MAX_MINUTES:
        parser.error('--hold-minutes must be 1 to %d' % update_request.HOLD_MAX_MINUTES)
    if args.poll_seconds < 1 or args.m4_deadline_minutes < 1 or args.worker_deadline_minutes < 1:
        parser.error('deadlines and the poll interval must be positive')
    try:
        hosts = fleet()
    except SystemExit as error:  # fleet_hosts reports a missing or bad inventory this way.
        print('fleet_rollout: %s' % error, file=sys.stderr)
        return 1
    if args.dry_run:
        order = ([LOCAL] if args.only in ('all', LOCAL) else []) + (
            ['+'.join(WORKERS)] if args.only in ('all', 'workers') else [])
        print(json.dumps({'version': args.version, 'order': order,
                          'commands': {name: host.command for name, host in hosts.items()}}))
        return 0
    try:
        results = rollout(args.version, hosts, args.only, args.hold_minutes, args.m4_deadline_minutes * 60,
                          args.worker_deadline_minutes * 60, args.worker_force, args.poll_seconds)
    except RolloutError as error:
        print('fleet_rollout: %s' % error, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error)}))
        return 1
    print(json.dumps({'version': args.version, 'result': 'installed', 'hosts': results}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
