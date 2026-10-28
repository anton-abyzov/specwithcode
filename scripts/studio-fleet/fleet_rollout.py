#!/usr/bin/env python3
"""Install a published SpecWithCode release on the fleet in the documented order.

M4, the Mac this runs on, goes first, the way the desktop's Update now installs it: once its
agent offers the version, the service drains and holds itself for the install (ServiceHold:
the service's own `service prepare-update --stop-work --hold --reason install`, the same
prepareServiceUpdate call Update now makes), so running tasks are interrupted, queued messages
cancelled and terminals closed, and no new work starts; then one forced request bound to the
version with a 15-minute hold. Its agent retries the snapshot every 10 seconds instead of
waiting for a quiet period, and because the request was made during the service's hold, it may
stop processes the drain left behind (update.py --reap). Until the agent offers the release, M4
is only asked to check (checkRequestedAt and a kickstart, as the desktop's Check now does), not
to install: the hold inserts its own session row (servicePrepareUpdate.ts), which would land
between the snapshot and the apply of a request written before it and fail the guarded
prestate. A service that cannot be held is never asked unheld: an installed release older than
1.0.45 has no `service prepare-update` (PREPARE_UPDATE_SINCE), so the rollout refuses before it
asks M4 anything, and a service that does not answer, refuses or does not hold stops the rollout
before that request. An unheld forced request never stops running work and leaves update.py --reap
nothing it may stop, so a busy M4 waits for quiet and its guarded checks fail as new work starts.
The message names the safe path (UNSUPPORTED_PATH): Update now in the app on M4 holds the same
way, then `--only workers`. `--no-hold` is the explicit opt-in to an unheld forced request.
The script polls the installed version and finalized guarded receipt, never 'downloaded',
and asks again (holding again first) only after the hold has ended, because each new request
restarts the agent's escalation. An install already under way for the version is joined, not
asked again or held, and its failure stops the rollout like a failure of its own request. A
rollout that gives up cancels the forced request it wrote, while that is still the pending one
(update_request.py cancel), and on M4 then releases the hold it took, as Cancel update does, once
the state read again shows nothing needs it: the hold stays while the agent installs and while a
forced request is still pending (its own when the cancel failed, or one Update now wrote since),
so no forced request runs unheld.

M1 and M3 restart their tunnels to M4 when they update, and auth or orchestration events in
the middle of M4's snapshot and apply fail its guarded prestate, so they are asked only after
M4 completes verification of the new version, and then together with a plain version-bound
request. They are never drained or held.

Once a worker's service is confirmed on the version (installed, or already on it), its desktop
app is updated to the same version over the same ssh (desktop_app_rollout.py, which runs
desktop_app_update_remote.sh there), and the rollout reports its version before and after and
how: already current, the app's own updater on quit, or swapped. A failed app update fails the
rollout after every service is done, naming the host and the reason; --no-desktop-apps skips the
step. M4's app is release.sh's desktop stage's.

Each request is written by update_request.py, streamed with studio_paths.py to the host's
/usr/bin/python3 (over the pinned fleet SSH key for M1 and M3, the network-transition.py
convention), so a host needs neither this repository nor a newer agent. Hosts come from
fleet_hosts.load_hosts(); nothing here names an address.

    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37        # M4, then M1 and M3
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4 --no-hold
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --dry-run
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --no-desktop-apps

Exit 0 when every host chosen has finalized the version and every worker's app is on it, 1 when
one has not, 2 for bad arguments.
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

import desktop_app_rollout
import fleet_hosts
import service_hold
import update_request
from service_hold import (CLI_PARSE_ERRORS, HOLD_TIMEOUT, PREPARE_UPDATE_SINCE, RELEASE_TIMEOUT,  # noqa: F401
                          HoldUnavailable, HoldUnsupported)

HERE = pathlib.Path(__file__).resolve().parent
SYSTEM_PYTHON = '/usr/bin/python3'
LOCAL = 'm4'
WORKERS = tuple(fleet_hosts.PORTS)
MODULES = ('studio_paths', 'update_request')
REQUEST_WINDOW = int(update_request.REQUEST_TTL.total_seconds())
CALL_TIMEOUT = 90
# A request or check first installs the host's update agent and may wait for its pass to end
# (update_request.AGENT_PASS_WAIT).
REQUEST_TIMEOUT = CALL_TIMEOUT + update_request.AGENT_PASS_WAIT
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


# ServiceUpdateHold.UPDATE_PENDING_STATUSES: agent states with a release found, downloading,
# ready or installing.
PENDING_STATUSES = ('available', 'downloading', 'downloaded', 'waiting-for-quiet', 'installing')


class RolloutError(Exception):
    reply = None  # The host's error answer; it names a request written before a kickstart failed.


class DesktopAppsFailed(RolloutError):
    """Every service chosen is on the version, but a worker's desktop app is not; `results` holds them."""

    def __init__(self, message, results):
        RolloutError.__init__(self, message)
        self.results = results


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


def ssh_command(home, user, host, remote='/usr/bin/python3 -B -'):
    """The pinned fleet ssh to `user@host`, running `remote`, a fixed command that reads its program on stdin."""
    fleet = pathlib.Path(home) / '.local/share/specweave/fleet'
    return ['/usr/bin/ssh', '-F', '/dev/null', '-i', str(fleet / 'id_ed25519'), '-o', 'IdentitiesOnly=yes',
            '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + str(fleet / 'known_hosts'), '-o', 'ConnectTimeout=8',
            '-o', 'ControlMaster=no', user + '@' + host, remote]


class Host(object):
    """Runs update_request.py on one host. `command` reads the program on stdin; a worker's
    `app_command` runs the desktop app script (desktop_app_rollout.REMOTE_COMMAND) the same way."""

    def __init__(self, identity, command, extra=(), app_command=None):
        self.identity = identity
        self.command = list(command)
        self.extra = list(extra)  # Tests: --home for a temporary private home.
        self.app_command = list(app_command) if app_command else None

    def __call__(self, argv):
        argv = list(argv) + self.extra
        timeout = REQUEST_TIMEOUT if argv[0] in ('request', 'check') else CALL_TIMEOUT
        try:
            result = subprocess.run(self.command, input=program(argv), capture_output=True, text=True,
                                    timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RolloutError('%s did not answer within %ds' % (self.identity, timeout)) from None
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
            error = RolloutError('%s: %s' % (self.identity, value.get('error') or 'exit %d' % result.returncode))
            error.reply = value
            raise error
        return value


def fleet(home=None):
    """{identity: Host} for M4 (local) and every worker in the inventory."""
    home = pathlib.Path(home or pathlib.Path.home())
    hosts = {LOCAL: Host(LOCAL, [SYSTEM_PYTHON, '-B', '-'])}
    for identity, user, host, _tunnel, _https in fleet_hosts.worker_plans():
        hosts[identity] = Host(identity, ssh_command(home, user, host),
                               app_command=ssh_command(home, user, host, desktop_app_rollout.REMOTE_COMMAND))
    return hosts


class ServiceHold(service_hold.ServiceHold):
    """M4's drain and hold (service_hold.ServiceHold, shared with the update agent's automatic pause)."""

    def __init__(self, identity=LOCAL, home=None, run=subprocess.run):
        service_hold.ServiceHold.__init__(self, identity, home, run)


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
    time of this rollout's first request or check), or a joined automatic attempt wrote a new
    result. An install left running past its timeout is not a completed failure."""
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


def forced_pending(status, now=None):
    """True while a forced request stands on the host: not cancelled since, and its hold not yet
    run out. The agent's retries and update.py --reap rely on the service hold made for it."""
    asked = update_request._time(status.get('installRequestedAt'))
    cancelled = update_request._time(status.get('installCancelledAt'))
    until = update_request._time(status.get('installHoldUntil'))
    if status.get('installMode') != 'force' or asked is None or until is None \
            or (cancelled is not None and cancelled >= asked):
        return False
    return until > (now or datetime.datetime.now(datetime.timezone.utc))


# update_request.refresh_agent results worth a line: before each request or check, the host installs
# the update agent its release ships unless it has that one or a newer one.
AGENT_NOTES = {'installed': 'installed the update agent its release ships over an older one',
               'busy': 'installed the update agent its release ships over an older one, but a pass of the old '
                       'one was still running and may take on this request',
               'disabled': 'its update agent is turned off in launchd',
               'failed': 'could not install the update agent its release ships; the one it has handles this'}
# A pass never takes on a check written during it: the next pass, on the new agent, runs it.
CHECK_BUSY = ('installed the update agent its release ships over an older one; a pass of the old one was '
              'still running, so the next pass, on the new one, runs the check')


def agent_note(identity, reply, say, check=False):
    """Says what a request or check did to the host's update agent, when that is worth a line."""
    word = reply.get('agent')
    if word in AGENT_NOTES:
        say('%s: %s' % (identity, CHECK_BUSY if check and word == 'busy' else AGENT_NOTES[word]))


def requested_by_update_now(status, version, now=None):
    """True while a forced, held request for `version` stands on the host, as Update now (or an
    earlier rollout) writes it: not cancelled since, and its hold not yet run out."""
    return (status.get('installRequest') or {}).get('version') == version and forced_pending(status, now)


def roll_host(identity, call, version, force, hold_minutes, deadline, poll, clock, sleep, say, hold=None):
    """Asks one host for `version` and waits until it reports it installed. With `hold` (M4's
    ServiceHold), each forced request follows Update now's drain and hold, which waits until the
    agent offers `version`; before that the agent is only asked to check. A rollout that gives up
    cancels the forced request it wrote and releases the hold it took once nothing needs it."""
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
    written = [None]  # installRequestedAt of the last forced request this rollout wrote.

    def unheld(reason):
        """A wanted hold that cannot be taken stops the rollout before any further forced request."""
        outcome = 'it was not asked again' if sent[0] else 'it was not asked to install'
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
        reply = {}
        try:
            reply = call(argv)
        except RolloutError as error:
            reply = error.reply or {}  # It names a request written before launchctl refused to start the agent.
            raise
        finally:
            if force:  # The last forced request is the one a give-up cancels.
                written[0] = (reply.get('request') or {}).get('installRequestedAt') or written[0]
        sent[0] += 1
        mode = 'forced, held %d min' % hold_minutes if force else 'version-bound'
        say('%s: asked to install %s (%s) on %s' % (identity, version, mode, current or 'an unknown version'))
        agent_note(identity, reply, say)
        if reply.get('kicked') is False:
            say('%s: launchctl kickstart failed; the agent still runs within 10 minutes' % identity)
        if first[0] is None:  # The host's own clock, the one its agent dates lastInstall by.
            first[0] = update_request._time((reply.get('request') or {}).get('installRequestedAt'))
        return clock()

    def check():
        """Asks the agent only to look for the release (Check now), so nothing is asked to install
        before the service is held."""
        reply = call(['check', '--identity', identity, '--kickstart'])
        say('%s: the agent does not offer %s yet; asked it to check, and the service is held once it does'
            % (identity, version))
        agent_note(identity, reply, say, check=True)
        if first[0] is None:  # It may install what it finds on its own; a failure from here on counts.
            first[0] = update_request._time((reply.get('request') or {}).get('checkRequestedAt'))
        return clock()

    def busy(status):
        """Why the hold is the service's now, or None: an install under way ends it, a restart ended it."""
        if status.get('status') == 'installing':
            return 'the agent is installing'
        return 'it restarted' if status.get('version') == version else None

    def release(status):
        """A rollout that gives up cancels the forced request it wrote, while that is still the
        pending one, then lets work start again the way Cancel update does: only once the state,
        read again after the cancel, shows nothing that needs the hold. It stays while the agent
        installs (the hold ends with that install), once the service restarted (it ended with it)
        and while a forced request is pending (its own when the cancel failed, or one Update now
        wrote since), so that request never runs unheld."""
        reason = busy(status)
        if reason:
            if took[0] and hold is not None:
                say('%s: left the hold to the service: %s' % (identity, reason))
            return
        if written[0] is not None:  # Before the hold ends, so the request never runs unheld.
            try:
                call(['cancel', '--identity', identity, '--request', written[0]])
                say('%s: cancelled its forced request for %s' % (identity, version))
            except RolloutError as error:
                say('%s: WARNING: could not cancel its forced request for %s (%s)' % (identity, version, error))
        if not took[0] or hold is None:
            return
        try:  # The last poll can be a poll interval old, and the cancel may not have gone through.
            status = call(['status', '--identity', identity])
        except RolloutError as error:
            say('%s: WARNING: left the hold, as the agent state could not be read again (%s); it ends on its '
                'own within 15 minutes' % (identity, error))
            return
        reason = busy(status)
        if reason:
            say('%s: left the hold to the service: %s' % (identity, reason))
            return
        if forced_pending(status):
            say('%s: left the hold to the forced request still pending (asked at %s), so it never runs unheld; '
                'it ends with that install, on its own within 15 minutes, or with Cancel update in the app on %s'
                % (identity, status.get('installRequestedAt'), identity.upper()))
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
            if not supported:  # Before the first request or check.
                raise unheld(reason)
            held_request = drain(status)
            if held_request or holder[0] is None:
                asked, requests = ask(), 1
            elif status.get('status') == 'installing':  # Never a forced request before the hold.
                # The install under way, not joined (automatic, or its hold ran out): the agent
                # saved 'installing' before it started, so its failure, dated after, is reported
                # here instead of draining and asking for the release that just failed.
                first[0] = update_request._time(status.get('updatedAt'))
                asked, requests = clock(), 0
            else:  # Never a forced request before the hold: a check until the agent offers it.
                asked, requests = check(), 0
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
                # The agent offers the release now: the forced request follows the hold, so the
                # snapshot its apply is checked against already counts the hold's session row.
                held_request, asked, requests = True, ask(), requests + 1
                continue
            if clock() - asked < window:
                continue
            if holder[0] is not None and status.get('status') == 'installing':
                continue  # The install under way ends the hold; a request now would follow no drain.
            if holder[0] is not None and not held_request:
                asked = check()  # Still not offered.
                continue
            say('%s: the %s window ended without an install; asking once more' % (identity, 'hold' if force else 'request'))
            held_request = drain(status)
            if held_request or holder[0] is None:
                asked, requests = ask(), requests + 1
            else:  # It no longer offers the release.
                asked = check()
    except (RolloutError, KeyboardInterrupt):
        release(status)
        raise


def rollout(version, hosts, only='all', hold_minutes=15, local_deadline=75 * 60, worker_deadline=30 * 60,
            worker_force=False, poll=15, clock=time.time, sleep=time.sleep, say=None, hold=None, desktop=None):
    """M4 first (drained and held through `hold`, its ServiceHold, when given), then M1 and M3
    together, never held. With `desktop` (desktop_app_rollout.DesktopApps), each worker's desktop app
    follows once its service is confirmed on `version`. Returns {identity: result}; raises
    RolloutError, or DesktopAppsFailed once every service is done when only an app update failed."""
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
        errors, app_errors, lock = [], [], threading.Lock()

        def update_app(identity):
            """The worker's desktop app, once its service runs `version`; a failure is reported, not raised."""
            try:
                return desktop(identity, say)
            except desktop_app_rollout.DesktopAppError as error:
                reason = str(error)
            except Exception as error:  # noqa: BLE001 - an app step never drops out of the results unreported.
                reason = 'stopped on an unexpected %s: %s' % (type(error).__name__, error)
            say('%s: desktop app not updated to %s: %s' % (identity, version, reason))
            with lock:
                app_errors.append('%s: desktop app not updated to %s: %s' % (identity, version, reason))
            return {'result': 'failed', 'error': reason}

        def worker(identity):
            try:
                result = roll_host(identity, hosts[identity], version, worker_force, hold_minutes,
                                   worker_deadline, poll, clock, sleep, say)
                with lock:
                    results[identity] = result
            except RolloutError as error:
                with lock:
                    errors.append(str(error))
                return
            except Exception as error:  # noqa: BLE001 - a host never drops out of the results unreported.
                with lock:
                    errors.append('%s stopped on an unexpected %s: %s' % (identity, type(error).__name__, error))
                return
            if desktop is not None:
                app = update_app(identity)
                with lock:
                    result['desktopApp'] = app

        threads = [threading.Thread(target=worker, args=(identity,), name='rollout-' + identity)
                   for identity in WORKERS]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if errors:
            raise RolloutError('; '.join(sorted(errors) + sorted(app_errors)))
        if app_errors:
            raise DesktopAppsFailed('; '.join(sorted(app_errors)), results)
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
    parser.add_argument('--no-desktop-apps', action='store_true',
                        help="leave M1's and M3's desktop apps as they are (by default each follows its service)")
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
    desktop = None
    if args.only != LOCAL and not args.no_desktop_apps:
        try:
            desktop = desktop_app_rollout.DesktopApps(args.version, {
                name: host.app_command for name, host in hosts.items() if getattr(host, 'app_command', None)})
        except desktop_app_rollout.DesktopAppError as error:  # RELEASE_PUBLIC_REPO is not owner/name.
            print('fleet_rollout: %s' % error, file=sys.stderr)
            return 2
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
                          'commands': {name: host.command for name, host in hosts.items()},
                          'desktopApps': desktop.plan() if desktop else None}))
        return 0
    # An old M4 is refused in roll_host, after its status shows whether Update now already
    # asked for this version (then the rollout joins that install instead).
    try:
        results = rollout(args.version, hosts, args.only, args.hold_minutes, args.m4_deadline_minutes * 60,
                          args.worker_deadline_minutes * 60, args.worker_force, args.poll_seconds, hold=hold,
                          desktop=desktop)
    except DesktopAppsFailed as error:
        print('fleet_rollout: every service is on %s, but %s' % (args.version, error), file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error), 'hosts': error.results}))
        return 1
    except RolloutError as error:
        print('fleet_rollout: %s' % error, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error)}))
        return 1
    print(json.dumps({'version': args.version, 'result': 'installed', 'hosts': results}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
