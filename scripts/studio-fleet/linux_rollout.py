#!/usr/bin/env python3
"""Update the fleet's Linux workers to a published release, best effort, after the Macs.

release.sh runs this in its last stage (fleet-linux), once macOS is published, M4, M1 and M3 run
the release and the release pull request is merged, so a Linux worker never delays or fails the
macOS release: release.sh only warns when this exits non-zero. Run it by hand to retry:

    python3 -B scripts/studio-fleet/linux_rollout.py --version 1.0.95
    python3 -B scripts/studio-fleet/linux_rollout.py --version 1.0.95 --host ministorm --dry-run

Workers are the inventory entries with "os": "linux" (fleet_hosts.linux_workers). Each runs its
service as a systemd user unit whose ExecStart is
<studioHome>/runtime/versions/<version>/specweave-studio, the layout `service install` and the
CLI's own `update` write (docs/user/linux-worker.md). For each worker, over SSH:

1. Read the service's state with the user manager's bus restored (an SSH session may lack
   XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS; systemdUserBus.ts restores them the same way):
   the unit's LoadState and ActiveState, and the version the server actually runs. That is the
   childVersion the launcher started the live server with (server-runtime.json names its pid;
   the process must be in the unit's cgroup), and it must be the launcher's selected
   activeVersion with no update trial pending (service-state.json). The unit's ExecStart alone
   says nothing about what runs: the launcher picks the child, also after a rollback.
2. When it runs the version, or a newer one, healthy, nothing changes.
3. A failed query or an uncertain state (activating, deactivating, reloading, not loaded)
   skips the worker with a warning. Only "inactive" and "failed" count as stopped: nothing runs,
   and the update starts it.
4. When the service is active, ask it what still runs with `service prepare-update --json`
   without --stop-work, a read-only look that stops nothing. Anything left (a running turn, a
   queued message, a pending request, a provider session) skips the worker with a warning.
5. Run the CLI's own self-update, `STUDIO_ENABLE_SELF_UPDATE=true specweave-studio update
   <version> --yes`, which downloads the Linux archive from the public release, pins it under
   runtime/versions/<version>, rewrites the unit and restarts the service. For an active service
   it adds --if-idle: right before the restart the running service holds itself only when nothing
   runs, so work that arrived after the look is never interrupted; busy, or too old to hold
   itself (1.0.105 and earlier), it keeps running and the worker is skipped. Such a worker is
   updated by hand once (docs/user/linux-worker.md).
6. Read the state again until the server runs the version, healthy (up to VERIFY_SECONDS).

Exit 0 when every worker chosen runs the version (or a newer one), or there is none; 1 when one
was skipped or failed; 2 for bad arguments. The last line of output is a JSON summary.
"""
import argparse
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import time

import fleet_hosts
import fleet_rollout

DEFAULT_UNIT = 'studio.service'
CALL_TIMEOUT = 90
UPDATE_TIMEOUT = 15 * 60  # Downloads the archive (about 100 MB), checks it and restarts the service.
VERIFY_SECONDS = 120
VERIFY_POLL = 5
VERSION = fleet_rollout.VERSION
OK_RESULTS = ('installed', 'already-installed', 'newer')
# Only these mean nothing runs in the service; anything else is not known to be stopped.
STOPPED = ('inactive', 'failed')
# What a CLI older than `update --if-idle` prints for the flag.
CLI_PARSE_ERRORS = ('Unrecognized flag', 'Unknown flag', 'Invalid flag')

# Runs on the worker with `sh -s -- STUDIO_HOME UNIT ACTION [VERSION]`. POSIX sh and GNU sed only.
REMOTE = r'''set -u
studio_home=$1 unit=$2 action=$3 version=${4:-}
# The user manager's bus, as systemdUserBus.ts restores it for an SSH session without one.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
: "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}"
export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
# Where the CLI's boot service writes it (cloud/bootService.ts), whatever XDG_CONFIG_HOME says.
unit_file="$HOME/.config/systemd/user/$unit"
bin=$(sed -n 's|^ExecStart=\(/[^ ]*/specweave-studio\)\( .*\)\{0,1\}$|\1|p' "$unit_file" 2>/dev/null | head -n 1)
json_string() {  # json_string FILE KEY: the first "KEY": "value" in FILE
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1
}
case "$action" in
  status)
    printf 'bin=%s\n' "$bin"
    # show exits 0 for a stopped or unknown unit; non-zero only when systemd cannot be asked.
    if props=$(systemctl --user show -p LoadState -p ActiveState -p ControlGroup "$unit" 2>/dev/null); then
      printf 'query=ok\n%s\n' "$props"
    else
      printf 'query=failed\n'
      props=''
    fi
    cgroup=$(printf '%s\n' "$props" | sed -n 's/^ControlGroup=//p')
    runtime_state="$studio_home/userdata/server-runtime.json"
    pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$runtime_state" 2>/dev/null | head -n 1)
    running=''
    # The live server, in this unit: its own launcher context names the version it runs.
    if [ -n "$pid" ] && [ -n "$cgroup" ] &&
      sed 's/^[^:]*:[^:]*://' "/proc/$pid/cgroup" 2>/dev/null | grep -qxF -- "$cgroup"; then
      running=$(tr '\000' '\n' < "/proc/$pid/environ" 2>/dev/null |
        sed -n 's/^STUDIO_SERVICE_LAUNCHER_CONTEXT=.*"childVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    fi
    printf 'running=%s\n' "$running"
    state_file="$studio_home/runtime/service-state.json"
    printf 'selected=%s\n' "$(json_string "$state_file" activeVersion)"
    printf 'update=%s\n' "$(json_string "$state_file" status)"
    ;;
  preview)
    [ -n "$bin" ] && [ -x "$bin" ] || { echo "no runnable specweave-studio in $unit_file" >&2; exit 3; }
    STUDIO_HOME="$studio_home" exec "$bin" service prepare-update --base-dir "$studio_home" --json < /dev/null
    ;;
  update | update-if-idle)
    [ -n "$bin" ] && [ -x "$bin" ] || { echo "no runnable specweave-studio in $unit_file" >&2; exit 3; }
    if_idle=''
    [ "$action" = update-if-idle ] && if_idle=--if-idle
    STUDIO_ENABLE_SELF_UPDATE=true STUDIO_HOME="$studio_home" exec "$bin" update "$version" --yes $if_idle < /dev/null
    ;;
  *) echo "unknown action $action" >&2; exit 2 ;;
esac
'''


class LinuxError(Exception):
    pass


class Status(object):
    def __init__(self, unit, query_ok, load, active, running, selected, update):
        self.unit, self.query_ok, self.load, self.active = unit, query_ok, load, active
        self.running, self.selected, self.update = running, selected, update

    def healthy(self):
        """The version a healthy service runs, or None: systemd answered, the unit is loaded and
        active, its live server runs the launcher's selected version, and no trial is pending."""
        if not (self.query_ok and self.load == 'loaded' and self.active == 'active'):
            return None
        if self.running is None or self.running != self.selected or self.update == 'pending':
            return None
        return self.running

    def describe(self):
        if not self.query_ok:
            return 'systemd could not be asked about the unit'
        return 'unit %s, %s; server runs %s (selected %s%s)' % (
            self.load, self.active, self.running or 'nothing readable', self.selected or 'unknown',
            ', update pending' if self.update == 'pending' else '')


def _tuple(version):
    return fleet_rollout._tuple(version)


def ssh_command(identity, entry, home=None):
    """The SSH argv, without the remote command: the pinned fleet key (as for M1 and M3), or
    with "sshConfig": true the M4's own ~/.ssh/config alias."""
    if entry.get('sshConfig') is True:
        return ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=no',
                entry['host']]
    pinned = fleet_rollout.ssh_command(home or pathlib.Path.home(), entry['user'], entry['host'])
    return pinned[:-1]  # Drops the Macs' '/usr/bin/python3 -B -'.


class Worker(object):
    def __init__(self, identity, entry, home=None, run=subprocess.run):
        self.identity = identity
        self.studio_home = entry['studioHome'].rstrip('/')
        self.unit = entry.get('unit') or DEFAULT_UNIT
        self.ssh = ssh_command(identity, entry, home)
        self.run = run

    def command(self, action, version=None):
        args = [self.studio_home, self.unit, action] + ([version] if version else [])
        return self.ssh + ['sh -s -- ' + ' '.join(shlex.quote(arg) for arg in args)]

    def call(self, action, version=None, timeout=CALL_TIMEOUT):
        argv = self.command(action, version)
        try:
            result = self.run(argv, input=REMOTE, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise LinuxError('%s: %s did not finish within %ds' % (self.identity, action, timeout)) from None
        except OSError as error:
            raise LinuxError('%s could not be reached (%s)' % (self.identity, type(error).__name__)) from None
        if result.returncode != 0:
            raise LinuxError('%s: %s exited %d%s' % (self.identity, action, result.returncode, tail(result)))
        return result.stdout or ''

    def status(self):
        """The service as the worker sees it: Status(unit, query_ok, load, active, running,
        selected, update). `running` is the version the live server in this unit runs, or None."""
        fields = dict(line.split('=', 1) for line in self.call('status').splitlines() if '=' in line)
        match = re.fullmatch(re.escape(self.studio_home) + r'/runtime/versions/([0-9.]+)/specweave-studio',
                             fields.get('bin', '').strip())

        def version(value):
            value = (value or '').strip()
            return value if _tuple(value) else None
        return Status(unit=version(match.group(1)) if match else None,
                      query_ok=fields.get('query', '').strip() == 'ok',
                      load=fields.get('LoadState', '').strip() or 'unknown',
                      active=fields.get('ActiveState', '').strip() or 'unknown',
                      running=version(fields.get('running')),
                      selected=version(fields.get('selected')),
                      update=fields.get('update', '').strip())

    def preview(self):
        out = self.call('preview')
        lines = [line for line in out.splitlines() if line.strip()]
        try:
            reply = json.loads(lines[-1]) if lines else None
        except ValueError:
            reply = None
        if not isinstance(reply, dict) or not isinstance(reply.get('idle'), bool):
            raise LinuxError('%s: prepare-update gave no answer' % self.identity)
        return reply


def tail(result):
    lines = [line.strip() for line in ((result.stderr or '') + '\n' + (result.stdout or '')).splitlines()
             if line.strip()]
    return ': ' + lines[-1][:300] if lines else ''


def describe_blockers(reply):
    left = ', '.join('%s %s%s' % (blocker.get('count'), blocker.get('kind'),
                                  ' (%s)' % blocker['threadTitle'] if blocker.get('threadTitle') else '')
                     for blocker in reply.get('blockers') or [] if isinstance(blocker, dict))
    return left or 'work the service did not name'


def roll_worker(worker, version, say, sleep=time.sleep, clock=time.monotonic):
    """Updates one worker; returns {'identity', 'result', 'from', ...}. Never raises."""
    identity = worker.identity
    begin = clock()
    outcome = {'identity': identity, 'from': None}
    try:
        state = worker.status()
        running = state.healthy()
        outcome['from'] = running or state.running
        if running is not None and _tuple(running) >= _tuple(version):
            if running == version:
                say('%s: already runs %s' % (identity, version))
                return dict(outcome, result='already-installed')
            say('%s: runs %s, newer than %s; left alone' % (identity, running, version))
            return dict(outcome, result='newer')
        if not state.query_ok or state.load != 'loaded':
            reason = 'could not tell whether the service runs (%s)' % state.describe()
            say('%s: WARNING: skipped, %s' % (identity, reason))
            return dict(outcome, result='skipped', reason=reason)
        if state.active == 'active':
            try:
                reply = worker.preview()
            except LinuxError as error:
                say('%s: WARNING: skipped, could not ask the service what runs (%s)' % (identity, error))
                return dict(outcome, result='skipped', reason=str(error))
            if not reply['idle']:
                reason = 'still running: ' + describe_blockers(reply)
                say('%s: WARNING: skipped, the update restarts the service and it is %s' % (identity, reason))
                return dict(outcome, result='skipped-busy', reason=reason)
            action = 'update-if-idle'
        elif state.active in STOPPED:
            say('%s: service is %s, so nothing runs in it' % (identity, state.active))
            action = 'update'
        else:
            reason = 'the service is %s, not known to be running or stopped' % state.active
            say('%s: WARNING: skipped, %s' % (identity, reason))
            return dict(outcome, result='skipped', reason=reason)
        say('%s: updating %s -> %s' % (identity, outcome['from'] or 'an unknown version', version))
        try:
            worker.call(action, version, timeout=UPDATE_TIMEOUT)
        except LinuxError as error:
            message = str(error)
            if action == 'update-if-idle' and any(text in message for text in CLI_PARSE_ERRORS):
                reason = 'its CLI predates update --if-idle; update it by hand once (docs/user/linux-worker.md)'
                say('%s: WARNING: skipped, %s' % (identity, reason))
                return dict(outcome, result='skipped', reason=reason)
            if action == 'update-if-idle' and 'was not restarted' in message:
                say('%s: WARNING: skipped, %s' % (identity, message))
                return dict(outcome, result='skipped-busy', reason=message)
            raise
        deadline = clock() + VERIFY_SECONDS
        while True:
            state = worker.status()
            if state.healthy() == version:
                seconds = int(clock() - begin)
                say('%s: installed %s after %ds' % (identity, version, seconds))
                return dict(outcome, result='installed', seconds=seconds)
            if clock() >= deadline:
                raise LinuxError('%s: after the update the %s, not %s healthy' % (identity, state.describe(), version))
            sleep(VERIFY_POLL)
    except LinuxError as error:
        say('%s: WARNING: %s' % (identity, error))
        return dict(outcome, result='failed', reason=str(error))


def rollout(version, workers, say, sleep=time.sleep, clock=time.monotonic):
    """One worker after another (a Linux worker is cheap to update; the order is the inventory's)."""
    return [roll_worker(worker, version, say, sleep, clock) for worker in workers]


def main(argv=None, home=None, run=subprocess.run, sleep=time.sleep, stdout=None):
    os.umask(0o077)
    out = stdout or sys.stdout
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--version', required=True)
    parser.add_argument('--host', action='append', default=[], help='only this Linux worker (repeatable)')
    parser.add_argument('--dry-run', action='store_true', help='print the workers and commands; contact none')
    args = parser.parse_args(argv)
    if _tuple(args.version) is None:
        parser.error('--version must be X.Y.Z')
    try:
        entries = fleet_hosts.linux_workers()
    except SystemExit as error:
        print('linux_rollout: %s' % error, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error)}), file=out)
        return 1
    unknown = sorted(set(args.host) - {identity for identity, _entry in entries})
    if unknown:
        parser.error('not a Linux worker in the inventory: %s' % ', '.join(unknown))
    workers = [Worker(identity, entry, home, run) for identity, entry in entries
               if not args.host or identity in args.host]
    if args.dry_run:
        print(json.dumps({'version': args.version, 'order': [worker.identity for worker in workers],
                          'commands': {worker.identity: {action: worker.command(action, args.version if action.startswith('update') else None)
                                                         for action in ('status', 'preview', 'update', 'update-if-idle')}
                                       for worker in workers}}), file=out)
        return 0
    say = fleet_rollout.Printer(stream=out)
    if not workers:
        say('no Linux workers in the fleet inventory; nothing to update')
        print(json.dumps({'version': args.version, 'result': 'installed', 'hosts': []}), file=out)
        return 0
    results = rollout(args.version, workers, say, sleep)
    ok = all(result['result'] in OK_RESULTS for result in results)
    if not ok:
        say('retry once the worker is idle: python3 -B scripts/studio-fleet/linux_rollout.py --version %s%s' % (
            args.version, ''.join(' --host ' + r['identity'] for r in results if r['result'] not in OK_RESULTS)))
    print(json.dumps({'version': args.version, 'result': 'installed' if ok else 'incomplete', 'hosts': results}),
          file=out)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
