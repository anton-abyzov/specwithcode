#!/usr/bin/env python3
"""Release preflight: stop a release before anything is built when M4 or a fleet Mac lacks the disk
its update to this version needs, or cannot be asked.

M4's 1.0.180 to 1.0.184 update ran out of scratch disk after its service had stopped (`SpillFailed
... [Errno 28] Scratch volume is below its floor`): the full read migration 072 forced needed about
34 GB with 12 to 18 GB free. Each host is asked what scripts/studio-fleet/disk_room.py reports: the
full read's room for this release's pending FULL_READ migrations, the pre-update backup and the
staged release (docs there).

  - M4: `update.py room` from this checkout, plus BUILD_HEADROOM_GIB (10 GiB) for the build itself,
    which writes its trees, bundles and signed app on the same disk. RELEASE_BUILD_HEADROOM_GIB
    sets that headroom; nothing turns the check off.
  - M1 and M3 (fleet_hosts.PORTS), over SpecWithCode Connect: M4's installed CLI (its service
    receipt, as fleet_rollout.connect_command) runs `fleet room <machine> --version V --full-read
    N,... --connect-only --json`, and the worker runs its own release's disk_room.py with the
    FULL_READ migration numbers of THIS checkout's additive_migrations (`none` when it has none),
    since its installed list may be older than the release being checked. Each worker is matched
    to M4's studio-fleet.json by machine id or label, as fleet_rollout.fleet() does; the fleet
    inventory (hosts.json) is not read. A worker missing there, without a Connect address or a
    proof-bound management token, with no usable CLI on M4, or one Connect could not ask
    (unreachable, unauthorized, unsupported ...) is a failure naming the machine and the reason,
    never skipped.
  - `--ssh-fallback` (release.sh passes it when RELEASE_FLEET_SSH=1): for a worker Connect could
    not ask, disk_room.py and the six stdlib-only modules it imports are streamed to the host's
    /usr/bin/python3 over the pinned fleet SSH key from hosts.json, as fleet_rollout.py streams
    update_request.py, so a host needs neither this repository nor a newer helper. update.py itself
    is not streamed: it imports about forty modules of studio-fleet (launcher, quiescence,
    update_read, page_continuity ...), none of which the report needs.

Bootstrap: until M4 and a worker run a release that has `fleet room`, the Connect check reports
`unsupported` for that worker; run that one release with RELEASE_FLEET_SSH=1 (--ssh-fallback).

    python3 -B scripts/release/preflight_fleet.py --version 1.0.188
    python3 -B scripts/release/preflight_fleet.py --version 1.0.188 --ssh-fallback

Prints one line per host. Exit 0 when every host has room, 1 when any is short or cannot be
asked, 2 for bad arguments.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
FLEET = HERE.parent / 'studio-fleet'
sys.path.insert(0, str(FLEET))

import additive_migrations  # noqa: E402
import disk_room  # noqa: E402
import fleet_hosts  # noqa: E402
import fleet_rollout  # noqa: E402

LOCAL = 'm4'
SYSTEM_PYTHON = '/usr/bin/python3'
BUILD_HEADROOM_GIB = 10
HEADROOM_ENV = 'RELEASE_BUILD_HEADROOM_GIB'
LOCAL_TIMEOUT = 300  # The largest-table walk takes about 20 s cold on M4's 22 GB database.
REMOTE_TIMEOUT = 180
CONNECT_TIMEOUT = 300  # The worker's own largest-table walk, plus reaching it over Connect.
VERSION = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
BOOT = """
import sys, types
for name in %r:
    module = types.ModuleType(name)
    module.__file__ = name + '.py'
    sys.modules[name] = module
    exec(compile(sources[name], name + '.py', 'exec'), module.__dict__)
sys.exit(sys.modules['disk_room'].main(argv))
""" % (disk_room.MODULES,)


def program(argv):
    """Python for `/usr/bin/python3 -B -`: this checkout's disk_room.py and the modules it imports,
    then disk_room.main(argv)."""
    sources = {name: (FLEET / (name + '.py')).read_text() for name in disk_room.MODULES}
    return 'argv = %r\nsources = %r\n%s' % (list(argv), sources, BOOT)


def ssh_command(home, user, host, remote='/usr/bin/python3 -B -'):
    """fleet_rollout.ssh_command: the pinned fleet ssh to `user@host`, running `remote`."""
    return fleet_rollout.ssh_command(home, user, host, remote)


def full_read_list():
    """This checkout's FULL_READ migration numbers for `--full-read`: '69,73', or 'none'."""
    return ','.join(str(number) for number in sorted(additive_migrations.FULL_READ)) or 'none'


def _answer(identity, result):
    """The report from a probe's last stdout line; {'error': ...} when there is none."""
    lines = [line for line in (result.stdout or '').splitlines() if line.strip()]
    try:
        value = json.loads(lines[-1]) if lines else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        tail = (result.stderr or '').strip().splitlines()[-1:] or ['no output']
        return {'identity': identity, 'error': 'gave no answer (exit %d: %s)' % (result.returncode, tail[0][:200])}
    value.setdefault('identity', identity)
    return value


def probe(identity, command, version, stdin=None, timeout=REMOTE_TIMEOUT, run=subprocess.run):
    """One host's report, or {'identity', 'error'} when it could not be asked."""
    try:
        result = run(command, input=stdin, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'identity': identity, 'error': 'did not answer within %ds' % timeout}
    except OSError as error:
        return {'identity': identity, 'error': 'could not be reached (%s)' % type(error).__name__}
    return _answer(identity, result)


def _connect_failure(identity, machine, reason, error):
    where = ' (machine %s)' % machine if machine else ''
    return {'identity': identity, 'route': 'connect', 'connectReason': reason,
            'error': 'could not be asked over SpecWithCode Connect%s: %s: %s' % (where, reason, error)}


def connect_probe(identity, command, machine, timeout=CONNECT_TIMEOUT, run=subprocess.run):
    """The worker's report from M4's `fleet room ... --connect-only --json`; {'identity', 'error',
    'connectReason'} when Connect could not ask it or it could not make one."""
    try:
        result = run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return _connect_failure(identity, machine, 'timeout', 'no answer within %ds' % timeout)
    except OSError as error:
        return _connect_failure(identity, machine, 'no-cli', 'could not run the fleet CLI (%s)' % type(error).__name__)
    lines = [line for line in (result.stdout or '').splitlines() if line.strip()]
    try:
        value = json.loads(lines[-1]) if lines else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        tail = (result.stderr or '').strip().splitlines()[-1:] or ['no output']
        return _connect_failure(identity, machine, 'no-answer', 'the fleet CLI gave no JSON (exit %d: %s); M4\'s '
                                'installed CLI may predate `fleet room` (RELEASE_FLEET_SSH=1 once, until M4 runs a '
                                'release with it)' % (result.returncode, tail[0][:200]))
    if result.returncode != 0 or 'error' in value:
        return _connect_failure(identity, machine, str(value.get('reason') or 'failed'),
                                str(value.get('error') or 'exit %d' % result.returncode)[:300])
    if value.get('transport') != 'connect':
        return _connect_failure(identity, machine, 'transport',
                                'answered over %s, not SpecWithCode Connect' % (value.get('transport') or 'no named route'))
    value['identity'] = identity  # The fleet name the release uses; the worker's own is workerIdentity.
    value['route'] = 'connect'
    return value


def ssh_fallback_entry(identity, version, home):
    """(command, stdin, timeout) for the pinned SSH probe of `identity` from hosts.json; read only
    when that worker needs it. SystemExit when the inventory lacks it."""
    for name, user, host, _tunnel, _https in fleet_hosts.worker_plans():
        if name == identity:
            return (ssh_command(home, user, host),
                    program(['--identity', identity, '--version', version, '--json']), REMOTE_TIMEOUT)
    raise SystemExit('the fleet inventory has no %s' % identity)


def hosts(version, home=None, ssh_fallback=False, connect=None):
    """[(identity, command, stdin, timeout[, via])]: M4 first, run locally, then M1 and M3 over
    SpecWithCode Connect. `via` for a worker: {'machine', 'reason' (why Connect cannot ask it, or
    None), 'fallback' (a callable giving the SSH probe, with `ssh_fallback`)}. `connect` is the
    `fleet room` command prefix (default: M4's installed CLI)."""
    home = pathlib.Path(home or pathlib.Path.home())
    argv = ['--version', version, '--json']
    plan = [(LOCAL, [sys.executable, '-B', str(FLEET / 'update.py'), 'room', '--identity', LOCAL] + argv,
             None, LOCAL_TIMEOUT)]
    prefix = connect if connect is not None else fleet_rollout.connect_command(home, 'room')
    machines = fleet_rollout.connect_machines(home)
    for identity in fleet_rollout.WORKERS:
        match = fleet_rollout.find_machine(machines, identity)
        reason = fleet_rollout.connect_reason(match, prefix, 'room')
        machine = match['machine'] if match else None
        command = None if reason else list(prefix) + [machine, '--version', version, '--full-read', full_read_list(),
                                                      '--connect-only', '--json']
        fallback = (lambda identity=identity: ssh_fallback_entry(identity, version, home)) if ssh_fallback else None
        plan.append((identity, command, None, CONNECT_TIMEOUT,
                     {'machine': machine, 'reason': reason, 'fallback': fallback}))
    return plan


# Connect reasons that leave the worker unasked, so pinned SSH may ask it instead. A refusal it
# answered (unauthorized, identity-mismatch, a report it could not make) is never retried over SSH,
# as fleet_rollout.FallbackHost never retries one: SSH would hide a revoked or wrong fleet link.
SSH_FALLBACK_REASONS = frozenset(('no-route', 'no-cli', 'no-answer', 'timeout', 'unreachable', 'unsupported',
                                  'connect-unbound', 'connect-key-missing'))


def ask(identity, command, stdin, timeout, via, run=subprocess.run, say=print):
    """One host's report: a plain probe, or over Connect then (with a fallback, and only when
    Connect left it unasked) pinned SSH."""
    if via is None:
        return probe(identity, command, None, stdin, timeout, run)
    if command is None:
        report = _connect_failure(identity, via.get('machine'), 'no-route', via.get('reason'))
    else:
        report = connect_probe(identity, command, via.get('machine'), timeout, run)
    if 'error' not in report or via.get('fallback') is None or report.get('connectReason') not in SSH_FALLBACK_REASONS:
        return report
    say('%s: SpecWithCode Connect could not ask (%s); using pinned fleet SSH' % (identity, report['connectReason']))
    try:
        ssh, program_text, ssh_timeout = via['fallback']()
    except SystemExit as error:
        return {'identity': identity, 'error': 'could not be asked over pinned fleet SSH either: %s' % error}
    return probe(identity, ssh, None, program_text, ssh_timeout, run)


def headroom_bytes(environ=None):
    """M4's build headroom in bytes, from RELEASE_BUILD_HEADROOM_GIB (default 10); ValueError when
    it is not a non-negative number."""
    value = (environ if environ is not None else os.environ).get(HEADROOM_ENV, '').strip()
    gib = float(value) if value else BUILD_HEADROOM_GIB
    if not gib >= 0 or gib == float('inf'):
        raise ValueError(value)
    return int(gib * (1 << 30))


def judge(report, headroom=0):
    """(ok, line): the host's line naming its need and free space; M4's need includes `headroom`."""
    identity = report.get('identity') or '?'
    if 'error' in report:
        if report.get('route') == 'connect':  # The error names the route, the machine and the reason.
            return False, '%s: FAILED, %s' % (identity, report['error'])
        return False, '%s: FAILED, could not be asked: %s' % (identity, report['error'])
    need, free = report['needBytes'] + headroom, report.get('freeBytes')
    ok = bool(report.get('ok')) and free is not None and free >= need
    extra = ' + %.1f GB build headroom' % (headroom / 1e9) if headroom else ''
    pending = report.get('fullReadMigrations') or []
    line = '%s: %s, needs %.1f GB, %.1f GB free on %s (fallback %.1f GB%s, backup %.1f GB, staged %.1f GB%s)' % (
        identity, 'ok' if ok else 'FAILED, short of disk', need / 1e9, (free or 0) / 1e9, report.get('volume'),
        report['parts']['fallback'] / 1e9, ' for migration ' + ', '.join('%03d' % n for n in pending) if pending else '',
        report['parts']['backup'] / 1e9, report['parts']['staged'] / 1e9, extra)
    if 'fallbackMemoryBytes' in report and not report.get('ok'):
        line += '; not enough memory for its %.1f GB full read' % (report['fallbackMemoryBytes'] / 1e9)
    for volume in report.get('volumes') or []:
        if not volume.get('ok'):
            line += '; %s needs %.1f GB, %.1f GB free' % (volume['volume'], volume['needBytes'] / 1e9,
                                                          (volume['freeBytes'] or 0) / 1e9)
    return ok, line


def preflight(version, plan, headroom, run=subprocess.run, say=print):
    """Every host asked at once, each reported in plan order; True when all have room."""
    def one(entry):
        identity, command, stdin, timeout = entry[:4]
        notes = []
        report = ask(identity, command, stdin, timeout, entry[4] if len(entry) > 4 else None, run, notes.append)
        return identity, notes, judge(report, headroom if identity == LOCAL else 0)

    # Hosts are asked together (a worker's walk or an SSH fallback takes minutes), then reported in plan order.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(plan))) as pool:
        answers = list(pool.map(one, plan))
    failed = []
    for identity, notes, (ok, line) in answers:
        for note in notes:
            say(note)
        say(line)
        if not ok:
            failed.append(identity)
    if failed:
        say('disk preflight: %s %s not ready for %s; free disk there (or retry once it answers) before releasing'
            % (', '.join(failed), 'is' if len(failed) == 1 else 'are', version))
    else:
        say('disk preflight: %s have room for %s' % (', '.join(identity for identity, *_ in plan), version))
    return not failed


def main(argv=None, run=subprocess.run, environ=None):
    parser = argparse.ArgumentParser(description='Refuse a release when a host lacks disk for its update.')
    parser.add_argument('--version', required=True)
    parser.add_argument('--ssh-fallback', action='store_true',
                        help='ask a worker SpecWithCode Connect could not ask over the pinned fleet SSH from '
                             'hosts.json (release.sh: RELEASE_FLEET_SSH=1)')
    args = parser.parse_args(argv)
    if not VERSION.fullmatch(args.version):
        parser.error('--version must be X.Y.Z')
    try:
        headroom = headroom_bytes(environ)
    except ValueError:
        parser.error('%s must be a number of GiB, 0 or more' % HEADROOM_ENV)
    try:
        plan = hosts(args.version, ssh_fallback=args.ssh_fallback)
    except SystemExit as error:  # Not expected on the Connect route; kept for a broken checkout.
        print('disk preflight: FAILED, the fleet cannot be asked: %s' % error)
        return 1
    return 0 if preflight(args.version, plan, headroom, run) else 1


if __name__ == '__main__':
    sys.exit(main())
