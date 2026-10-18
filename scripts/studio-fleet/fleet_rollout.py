#!/usr/bin/env python3
"""Install a published SpecWithCode release on the fleet in the documented order.

M4, the Mac this runs on, goes first, the way the desktop's Update now installs it: once its
agent offers the version, the service drains and holds itself for the install (ServiceHold:
the service's own `service prepare-update --stop-work --hold --reason install`, the same
prepareServiceUpdate call Update now makes), so running tasks are interrupted, queued messages
cancelled and terminals closed, and no new work starts; then one forced request bound to the
version with a 15-minute hold. Its agent retries the snapshot every 10 seconds instead of
waiting for a quiet period, and because the request was made during the service's hold, it may
stop processes the drain left behind (update.py --reap). When the agent has not found the
release at the first request, the rollout holds and asks again as soon as it has. A service
that cannot be held is never asked unheld: an installed release older than 1.0.45 has no
`service prepare-update` (PREPARE_UPDATE_SINCE), so the rollout refuses before it asks M4
anything, and a service that does not answer, refuses or does not hold stops the rollout before
that request. An unheld forced request never stops running work and leaves update.py --reap
nothing it may stop, so a busy M4 waits for quiet and its guarded checks fail as new work starts.
The message names the safe path (UNSUPPORTED_PATH): Update now in the app on M4 holds the same
way, then `--only workers`. `--no-hold` is the explicit opt-in to an unheld forced request.
The script polls the installed version and finalized guarded receipt, never 'downloaded',
and asks again (holding again first) only after the hold has ended, because each new request
restarts the agent's escalation. An install already under way for the version is joined, not
asked again or held. A rollout that gives up on M4 releases the hold it took, unless the agent
is installing, so work can start again.

M1 and M3 restart their tunnels to M4 when they update, and auth or orchestration events in
the middle of M4's snapshot and apply fail its guarded prestate, so they are asked only after
M4 completes verification of the new version, and then together with a plain version-bound
request. They are never drained or held.

Each request is written by update_request.py, streamed with studio_paths.py to the host's
/usr/bin/python3 (over the pinned fleet SSH key for M1 and M3, the network-transition.py
convention), so a host needs neither this repository nor a newer agent. Hosts come from
fleet_hosts.load_hosts(); nothing here names an address.

    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37        # M4, then M1 and M3
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4 --no-hold
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --dry-run

Exit 0 when every host chosen has finalized the version, 1 when one has not, 2 for bad arguments.
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
import studio_paths
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


# The CLI's own drain call allows 150 s (servicePrepareUpdate.ts STOP_WORK_TIMEOUT), plus start-up.
HOLD_TIMEOUT = 200
RELEASE_TIMEOUT = 60
# ServiceUpdateHold.UPDATE_PENDING_STATUSES: agent states with a release found, downloading,
# ready or installing.
PENDING_STATUSES = ('available', 'downloading', 'downloaded', 'waiting-for-quiet', 'installing')


class RolloutError(Exception):
    pass


class HoldUnavailable(Exception):
    """The service could not be drained and held; the rollout stops instead of asking unheld."""


class HoldUnsupported(HoldUnavailable):
    """The installed service CLI predates `service prepare-update` (PREPARE_UPDATE_SINCE)."""


# The first release whose CLI has `service prepare-update ... --json` (servicePrepareUpdate.ts).
# Older services serve the same prepareServiceUpdate call to their own Update now, not to a CLI.
PREPARE_UPDATE_SINCE = (1, 0, 45)
# What an older CLI prints for the command or its flags.
CLI_PARSE_ERRORS = ('Unrecognized flag', 'Unknown subcommand', 'Invalid subcommand', 'Unknown command')
UNSUPPORTED_PATH = (
    "Hold M4 with Update now in the SpecWithCode app on M4 instead (it drains and holds the service through "
    "the same prepareServiceUpdate call and asks for a forced install), wait until `fleet_rollout.py --version "
    "%(version)s --only m4` reports it installed, then run `fleet_rollout.py --version %(version)s --only workers`. "
    "--no-hold asks without a hold, but running work then keeps M4 waiting and its guarded checks fail")


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


class ServiceHold(object):
    """Drains and holds this Mac's service for an install the way the desktop's Update now does:
    its own CLI (`cliWrapper` in the identity's installation.json, which runs the installed
    release with the service's environment) calls `service prepare-update`, which makes the
    service's prepareServiceUpdate call over its socket with a five-minute session it revokes
    after. The service then refuses new work until the update installs, fails, is released, or
    its hold runs out, and keeps updates/hold.json for update.py --reap. Raises HoldUnavailable
    when that CLI or its service cannot do it (an older release has no such command)."""

    def __init__(self, identity=LOCAL, home=None, run=subprocess.run):
        self.identity = identity
        self.home = pathlib.Path(home or pathlib.Path.home())
        self.run = run

    def receipt(self):
        own = studio_paths.identity_home(self.home, self.identity)
        try:
            receipt = json.loads((own / 'installation.json').read_text())
        except (OSError, ValueError) as error:
            raise HoldUnavailable('no readable installation.json in %s (%s)' % (own, type(error).__name__)) from None
        return own, receipt

    def support(self):
        """(True, None) when the installed CLI has `service prepare-update`, else (False, reason).
        An unreadable or unversioned receipt is left to the call itself."""
        try:
            _own, receipt = self.receipt()
        except HoldUnavailable:
            return True, None
        version = receipt.get('version') if isinstance(receipt, dict) else None
        installed = _tuple(version)
        if installed is not None and installed < PREPARE_UPDATE_SINCE:
            return False, '%s runs %s; `service prepare-update` first shipped in %s' % (
                self.identity.upper(), version, '.'.join(map(str, PREPARE_UPDATE_SINCE)))
        return True, None

    def command(self, flags):
        own, receipt = self.receipt()
        wrapper = receipt.get('cliWrapper') if isinstance(receipt, dict) else None
        studio_home = receipt.get('studioHome') if isinstance(receipt, dict) else None
        if not isinstance(wrapper, str) or not os.path.isabs(wrapper) or not os.path.isfile(wrapper) \
                or not os.access(wrapper, os.X_OK):
            raise HoldUnavailable('installation.json names no runnable cliWrapper')
        if studio_home != str(own):
            raise HoldUnavailable('installation.json names the home %r, not %s' % (studio_home, own))
        return [wrapper, 'service', 'prepare-update', '--base-dir', studio_home] + list(flags) + ['--json']

    def _call(self, flags, timeout):
        argv = self.command(flags)
        try:
            result = self.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise HoldUnavailable('no answer within %ds' % timeout) from None
        except OSError as error:
            raise HoldUnavailable('could not run the service CLI (%s)' % type(error).__name__) from None
        lines = [line for line in (result.stdout or '').splitlines() if line.strip()]
        try:
            value = json.loads(lines[-1]) if lines else None
        except ValueError:
            value = None
        if isinstance(value, dict) and result.returncode == 0 and 'error' not in value:
            return value
        if isinstance(value, dict) and isinstance(value.get('error'), str):
            reason = value['error']
        else:  # An older CLI prints its usage for the unknown command.
            other = [line.strip() for line in (result.stderr or '').splitlines() if line.strip()]
            reason = 'exit %d%s' % (result.returncode, ': ' + other[-1][:200] if other else '')
            if any(phrase in (result.stderr or '') + (result.stdout or '') for phrase in CLI_PARSE_ERRORS):
                raise HoldUnsupported('the service CLI has no `service prepare-update --json` (%s)' % reason)
        raise HoldUnavailable(reason)

    def prepare(self):
        """Stops the service's work and holds it for an install; returns its answer. Raises
        HoldUnsupported, without running anything, for a release older than the command."""
        supported, reason = self.support()
        if not supported:
            raise HoldUnsupported(reason)
        return self._call(['--stop-work', '--hold', '--reason', 'install'], HOLD_TIMEOUT)

    def release(self):
        """Releases the hold, as Cancel update does, so work can start again."""
        supported, reason = self.support()
        if not supported:
            raise HoldUnsupported(reason)
        return self._call(['--release-hold'], RELEASE_TIMEOUT)


def offers(status, version):
    """True when the agent offers `version` in a way the service holds for: the check
    ServiceUpdateHold.updatePendingFor makes before it holds, narrowed to this release. A drain
    the service would not hold for only stops work."""
    if (status.get('downloadedVersion') or status.get('availableVersion')) != version:
        return False
    if status.get('status') in PENDING_STATUSES:
        return True
    installed = _tuple(status.get('installedVersion'))
    return installed is not None and installed < _tuple(version)


def _plural(count, word):
    count = count if isinstance(count, int) else 0
    return '%d %s%s' % (count, word, '' if count == 1 else 's')


def describe_hold(reply):
    """One line for what the drain stopped and what is left."""
    left = ', '.join('%s %s%s' % (blocker.get('count'), blocker.get('kind'),
                                  ' (%s)' % blocker['threadTitle'] if blocker.get('threadTitle') else '')
                     for blocker in reply.get('blockers') or [] if isinstance(blocker, dict))
    return 'stopped %s (%s interrupted), closed %s%s; %s' % (
        _plural(reply.get('stoppedThreads'), 'thread'), _plural(reply.get('interruptedRuns'), 'turn'),
        _plural(reply.get('openTerminals'), 'terminal'),
        ', held until %s' % reply['holdUntil'] if reply.get('holdUntil') else '',
        'still running: ' + left if left else 'nothing left running')


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


def failed_since(status, version, since, changed_attempt=False):
    """True when the agent recorded a failed install of `version` at or after `since` (the host's
    time of this rollout's first request), or a joined automatic attempt wrote a new result.
    An install left running past its timeout is not a completed failure."""
    last = status.get('lastInstall')
    if not isinstance(last, dict) or last.get('version') != version or last.get('result') != 'failed':
        return False
    at = update_request._time(last.get('at'))
    return (at is not None and (changed_attempt or (since is not None and at >= since))
            and 'left to finish' not in (status.get('message') or ''))


def left_running(status, version, since):
    """True when the agent gave up waiting on an install of `version` (at or after `since`) and
    left the helper to finish: its checks after the restart may still roll it back."""
    last = status.get('lastInstall')
    if since is None or not isinstance(last, dict) or last.get('version') != version or last.get('result') != 'failed':
        return False
    at = update_request._time(last.get('at'))
    return at is not None and at >= since and 'left to finish' in (status.get('message') or '')


def requested_by_update_now(status, version, now=None):
    """True while a forced, held request for `version` stands on the host, as Update now (or an
    earlier rollout) writes it: not cancelled since, and its hold not yet run out."""
    request = status.get('installRequest') or {}
    if request.get('version') != version or status.get('installMode') != 'force':
        return False
    asked = update_request._time(status.get('installRequestedAt'))
    cancelled = update_request._time(status.get('installCancelledAt'))
    until = update_request._time(status.get('installHoldUntil'))
    if asked is None or until is None or (cancelled is not None and cancelled >= asked):
        return False
    return until > (now or datetime.datetime.now(datetime.timezone.utc))


def roll_host(identity, call, version, force, hold_minutes, deadline, poll, clock, sleep, say, hold=None):
    """Asks one host for `version` and waits until it reports it installed. With `hold` (M4's
    ServiceHold), each forced request is preceded by Update now's drain and hold once the agent
    offers `version`, and a rollout that gives up releases the hold it took."""
    begin = clock()
    status = call(['status', '--identity', identity])
    current = status.get('version')
    if current == version and status.get('installFinalized') is True:
        say('%s: already on %s' % (identity, version))
        return {'identity': identity, 'result': 'already-installed', 'requests': 0, 'seconds': 0}
    if _tuple(current) is not None and _tuple(current) > _tuple(version):
        raise RolloutError('%s already runs %s, newer than %s' % (identity, current, version))
    window = hold_minutes * 60 if force else REQUEST_WINDOW
    holder = [hold if force else None]
    took = [False]  # This rollout holds (or held) the service.
    sent = [0]  # Requests this rollout wrote.

    def unheld(reason):
        """A wanted hold that cannot be taken stops the rollout before any further forced request."""
        if sent[0]:
            outcome = ('its earlier forced request for %s is still pending and waits for quiet; '
                       'choose Cancel update on M4 if it should not install' % version)
        else:
            outcome = 'it was not asked to install'
        return RolloutError('%s: could not hold the service for %s (%s), so %s. %s' % (
            identity, version, reason, outcome, UNSUPPORTED_PATH % {'version': version}))

    def drain(status):
        """Update now's drain and hold, right before a request; True when the service holds.
        Raises RolloutError when the service cannot be held."""
        if holder[0] is None or status.get('status') == 'installing' or not offers(status, version):
            return False
        try:
            reply = holder[0].prepare()
        except HoldUnavailable as error:
            raise unheld(error) from None
        if reply.get('held') is not True:
            raise unheld('it did not hold: %s' % describe_hold(reply))
        took[0] = True
        say('%s: held the service for %s: %s' % (identity, version, describe_hold(reply)))
        return True

    def ask():
        argv = ['request', '--identity', identity, '--version', version, '--kickstart']
        if force:
            argv += ['--force', '--hold-minutes', str(hold_minutes)]
        reply = call(argv)
        sent[0] += 1
        mode = 'forced, held %d min' % hold_minutes if force else 'version-bound'
        say('%s: asked to install %s (%s) on %s' % (identity, version, mode, current or 'an unknown version'))
        if reply.get('kicked') is False:
            say('%s: launchctl kickstart failed; the agent still runs within 10 minutes' % identity)
        if first[0] is None:  # The host's own clock, the one its agent dates lastInstall by.
            first[0] = update_request._time((reply.get('request') or {}).get('installRequestedAt'))
        return clock()

    def release(status):
        """A rollout that gives up lets work start again, unless the agent is installing (the
        hold ends with that install) or the service already restarted (the hold ended with it)."""
        if not took[0] or hold is None:
            return
        if status.get('status') == 'installing' or status.get('version') == version:
            say('%s: left the hold to the service: %s' % (
                identity, 'the agent is installing' if status.get('status') == 'installing' else 'it restarted'))
            return
        try:
            hold.release()
            say('%s: released the hold, so work can start again' % identity)
        except HoldUnavailable as error:
            say('%s: WARNING: could not release the hold (%s); it ends on its own within 15 minutes, '
                'or choose Cancel update' % (identity, error))

    # Joining an in-progress target install must not restart it. Its request supplies the
    # host-clock boundary for detecting a later rollback, even if the descriptor is target.
    under_way = requested_by_update_now(status, version)
    if under_way:
        say('%s: joins the forced install of %s already asked for on M4' % (identity, version))
    first = [update_request._time(status.get('installRequestedAt')) if current == version or under_way else None]
    joined, initial_last = current == version or under_way, status.get('lastInstall')
    try:
        if joined:
            held_request, asked, requests = False, clock(), 0
        else:
            supported, reason = holder[0].support() if holder[0] is not None else (True, None)
            if not supported:  # Before the first request, even one asked before the agent offers it.
                raise unheld(reason)
            held_request = drain(status)
            if holder[0] is not None and not held_request and not offers(status, version):
                say('%s: the agent does not offer %s yet; the service is held once it does' % (identity, version))
            asked, requests = ask(), 1
        seen, failures = None, 0
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
                raise RolloutError('%s runs %s, but it failed a check after the restart, so the update is not confirmed: %s (receipt %s)' % (
                    identity, version, status.get('message') or '', status['lastInstall'].get('receipt')))
            # The installed version flips before the updater's checks after the restart finish;
            # only the agent's successful, receipt-backed completion counts.
            if status.get('version') == version and status.get('installFinalized') is True:
                seconds = int(clock() - begin)
                say('%s: installed %s after %ds' % (identity, version, seconds))
                return {'identity': identity, 'result': 'installed', 'requests': requests, 'seconds': seconds}
            if status.get('status') == 'manual-required':
                raise RolloutError('%s needs a manual upgrade: %s' % (identity, status.get('message') or ''))
            if failed_since(status, version, first[0], joined and status.get('lastInstall') != initial_last):
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
            if joined or status.get('version') == version:
                continue
            if not held_request and drain(status):
                # The agent found the release after the first request: ask again during the hold,
                # so that request may reap what the drain left behind.
                held_request, asked, requests = True, ask(), requests + 1
                continue
            if clock() - asked >= window:
                say('%s: the %s window ended without an install; asking once more' % (identity, 'hold' if force else 'request'))
                held_request = drain(status)
                asked = ask()
                requests += 1
    except (RolloutError, KeyboardInterrupt):
        release(status)
        raise


def rollout(version, hosts, only='all', hold_minutes=15, local_deadline=75 * 60, worker_deadline=30 * 60,
            worker_force=False, poll=15, clock=time.time, sleep=time.sleep, say=None, hold=None):
    """M4 first (drained and held through `hold`, its ServiceHold, when given), then M1 and M3
    together, never held. Returns {identity: result}; raises RolloutError."""
    say = say or Printer(clock=clock)
    results = {}
    if only in ('all', LOCAL):
        results[LOCAL] = roll_host(LOCAL, hosts[LOCAL], version, True, hold_minutes, local_deadline, poll,
                                   clock, sleep, say, hold=hold)
    if only in ('all', 'workers'):
        if only == 'workers':
            status = hosts[LOCAL](['status', '--identity', LOCAL])
            if status.get('version') != version or status.get('installFinalized') is not True:
                raise RolloutError('M4 has not finalized %s (descriptor %s): install it first (--only m4); '
                                   'M1 and M3 never go while M4 is updating' % (version, status.get('version')))
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
    parser.add_argument('--no-hold', action='store_true',
                        help="do not drain and hold M4's service first (a busy M4 then waits for its work)")
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
    hold = None if args.no_hold or args.only == 'workers' else ServiceHold()
    supported, reason = hold.support() if hold else (True, None)
    if args.dry_run:
        order = ([LOCAL] if args.only in ('all', LOCAL) else []) + (
            ['+'.join(WORKERS)] if args.only in ('all', 'workers') else [])
        try:
            planned = hold.command(['--stop-work', '--hold', '--reason', 'install']) if hold else None
        except HoldUnavailable as error:
            planned = 'unavailable: %s' % error
        if not supported:
            planned = 'unsupported: %s' % reason
        print(json.dumps({'version': args.version, 'order': order, 'hold': planned,
                          'commands': {name: host.command for name, host in hosts.items()}}))
        return 0
    # An old M4 is refused in roll_host, after its status shows whether Update now already
    # asked for this version (then the rollout joins that install instead).
    try:
        results = rollout(args.version, hosts, args.only, args.hold_minutes, args.m4_deadline_minutes * 60,
                          args.worker_deadline_minutes * 60, args.worker_force, args.poll_seconds, hold=hold)
    except RolloutError as error:
        print('fleet_rollout: %s' % error, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error)}))
        return 1
    print(json.dumps({'version': args.version, 'result': 'installed', 'hosts': results}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
