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
  - M1 and M3 (fleet_hosts.worker_plans): disk_room.py and the six stdlib-only modules it imports,
    streamed to the host's /usr/bin/python3 over the pinned fleet SSH key, as fleet_rollout.py
    streams update_request.py, so a host needs neither this repository nor a newer helper.
    update.py itself is not streamed: it imports about forty modules of studio-fleet (launcher,
    quiescence, update_read, page_continuity ...), none of which the report needs. A worker that
    does not answer over SSH is a failure, never skipped (SpecWithCode Connect cannot run it).

    python3 -B scripts/release/preflight_fleet.py --version 1.0.188

Prints one line per host. Exit 0 when every host has room, 1 when any is short or cannot be
asked, 2 for bad arguments.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
FLEET = HERE.parent / 'studio-fleet'
sys.path.insert(0, str(FLEET))

import disk_room  # noqa: E402
import fleet_hosts  # noqa: E402

LOCAL = 'm4'
SYSTEM_PYTHON = '/usr/bin/python3'
BUILD_HEADROOM_GIB = 10
HEADROOM_ENV = 'RELEASE_BUILD_HEADROOM_GIB'
LOCAL_TIMEOUT = 300  # The largest-table walk takes about 20 s cold on M4's 22 GB database.
REMOTE_TIMEOUT = 180
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
    import fleet_rollout
    return fleet_rollout.ssh_command(home, user, host, remote)


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


def hosts(version, home=None):
    """[(identity, command, stdin, timeout)]: M4 first, then every Mac worker of the inventory."""
    home = pathlib.Path(home or pathlib.Path.home())
    argv = ['--version', version, '--json']
    plan = [(LOCAL, [sys.executable, '-B', str(FLEET / 'update.py'), 'room', '--identity', LOCAL] + argv,
             None, LOCAL_TIMEOUT)]
    for identity, user, host, _tunnel, _https in fleet_hosts.worker_plans():
        plan.append((identity, ssh_command(home, user, host), program(['--identity', identity] + argv), REMOTE_TIMEOUT))
    return plan


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
    """Every host asked in turn; True when all have room."""
    failed = []
    for identity, command, stdin, timeout in plan:
        ok, line = judge(probe(identity, command, version, stdin, timeout, run), headroom if identity == LOCAL else 0)
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
    args = parser.parse_args(argv)
    if not VERSION.fullmatch(args.version):
        parser.error('--version must be X.Y.Z')
    try:
        headroom = headroom_bytes(environ)
    except ValueError:
        parser.error('%s must be a number of GiB, 0 or more' % HEADROOM_ENV)
    try:
        plan = hosts(args.version)
    except SystemExit as error:  # fleet_hosts: no inventory, or one without M1 or M3.
        print('disk preflight: FAILED, the fleet cannot be asked: %s' % error)
        return 1
    return 0 if preflight(args.version, plan, headroom, run) else 1


if __name__ == '__main__':
    sys.exit(main())
