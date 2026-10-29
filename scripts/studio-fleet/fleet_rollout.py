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
asked again or held, and its failure stops the rollout like a failure of its own request. So is
one Update now asks for while the rollout waits: while that held request stands, the rollout
neither holds nor asks again, which would replace it (the service's hold and the agent then follow
the rollout's request instead of the press's run), and asks once more only after it ended, which it
has once the agent answered it without installing it (a failed download, say). Nor is a host asked
again while its agent installs, whoever asked for that install. A
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

SSH is tried first. A worker whose ssh gives no answer (exit 255, a timeout, Tailscale off) is
reached over SpecWithCode Connect instead, when M4's studio-fleet.json lists it with a Connect
address and a proof-bound management token: each update_request.py command becomes M4's own
`specweave-studio fleet update <machine> ... --json`, which answers with the same keys, so the
worker policy above is unchanged (`--no-hold` unless --worker-force). The first call picks the
route and the host keeps it; the desktop app step needs SSH and is reported as skipped on Connect.
Fleet machines outside the SSH inventory (ministorm) go over Connect only; one with neither route
(a bearer-only token, no Connect address) is reported as skipped, and a machine neither route
answers fails the rollout by name instead of being waited on.

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
import base64
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
import urllib.parse

import desktop_app_rollout
import fleet_hosts
import service_hold
import studio_paths
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
FLEET_CONFIG = 'studio-fleet.json'  # M4's fleet (studioFleet.FLEET_CONFIG_FILE).
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


def _no_answer(error, detail):
    """Marks `error` as the route giving no answer at all (not the host answering with an error)."""
    error.unanswered = detail
    return error


def unanswered(error):
    """Why a route gave no answer ('exit 255', 'timeout', ...), or None when the host answered."""
    if getattr(error, 'unanswered', None):
        return error.unanswered
    text = str(error)
    if 'gave no answer (exit 255)' in text:
        return 'exit 255'
    if 'did not answer within' in text:
        return 'timeout'
    if 'could not be reached' in text:
        return 'not reachable'
    return None


# Over SpecWithCode Connect a forced request waits for the worker's drain and the request it writes
# (fleet update polls up to 200 s after a POST of up to 75 s). A Linux machine older than the fleet
# update endpoint (ministorm on 1.0.105) instead keeps `server.updateServer` open through its whole
# download and staged preflight, for up to 10 minutes (LEGACY_SELF_UPDATE_TIMEOUT in fleetUpdate.ts);
# killing the CLI before then closes that socket and cancels the download.
LEGACY_SELF_UPDATE_SECONDS = 600
CONNECT_REQUEST_TIMEOUT = LEGACY_SELF_UPDATE_SECONDS + 120  # Plus reaching it and its WebSocket ticket.
CONNECT_UNANSWERED = ('unreachable', 'connect-key-missing')  # fleet update reasons meaning no route answered.


class ConnectHost(object):
    """The same `__call__(argv) -> dict` as Host, over SpecWithCode Connect: each update_request.py
    command becomes M4's own `fleet update <machine> ... --json` (its installed CLI, with M4's
    studio home), which reaches the machine with the management token M4 saved for it, DPoP-bound,
    and answers with update_request.py's keys. `command` is that CLI's `fleet update` prefix."""

    route = 'connect'
    app_command = None  # The desktop app step needs SSH.

    def __init__(self, identity, command, machine=None, env=None, run=subprocess.run):
        self.identity = identity
        self.machine = machine or identity
        self.command = list(command)
        self.env = env
        self.run = run

    def argv(self, argv):
        """`fleet update` arguments for one update_request.py command line."""
        argv = list(argv)
        kind, flags = argv[0], argv[1:]

        def value(flag):
            return flags[flags.index(flag) + 1] if flag in flags and flags.index(flag) + 1 < len(flags) else None

        if kind == 'status':
            mapped = ['--status']
        elif kind == 'check':
            mapped = ['--check']
        elif kind == 'cancel':
            mapped = ['--cancel', value('--request')]
        elif kind == 'request':
            mapped = ['--version', value('--version')]
            mapped += ['--hold-minutes', value('--hold-minutes') or str(update_request.HOLD_MAX_MINUTES)] \
                if '--force' in flags else ['--no-hold']
        else:
            raise RolloutError('%s: %s cannot go over SpecWithCode Connect' % (self.identity, kind))
        if None in mapped:
            raise RolloutError('%s: %s is missing a value for SpecWithCode Connect' % (self.identity, kind))
        return self.command + [self.machine] + mapped + ['--json']

    def __call__(self, argv):
        command = self.argv(argv)
        timeout = CONNECT_REQUEST_TIMEOUT if argv[0] == 'request' else CALL_TIMEOUT
        try:
            result = self.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout,
                              env=self.env)
        except subprocess.TimeoutExpired:
            raise _no_answer(RolloutError('%s did not answer over SpecWithCode Connect within %ds'
                                          % (self.identity, timeout)), 'timeout') from None
        except OSError as error:
            raise _no_answer(RolloutError('%s: could not run the fleet CLI (%s)'
                                          % (self.identity, type(error).__name__)), 'no fleet CLI') from None
        lines = [line for line in (result.stdout or '').splitlines() if line.strip()]
        try:
            value = json.loads(lines[-1]) if lines else None
        except ValueError:
            value = None
        if not isinstance(value, dict):
            raise _no_answer(RolloutError('%s gave no answer over SpecWithCode Connect (exit %d)'
                                          % (self.identity, result.returncode)), 'exit %d' % result.returncode)
        if result.returncode != 0 or 'error' in value:
            reason = value.get('reason')
            error = RolloutError('%s: %s%s' % (self.identity, value.get('error') or 'exit %d' % result.returncode,
                                               ' (%s)' % reason if reason else ''))
            error.reply = value
            if reason in CONNECT_UNANSWERED:
                error.unanswered = reason
            raise error
        return value


class FallbackHost(object):
    """SSH first, SpecWithCode Connect when SSH gives no answer (exit 255, a timeout or no ssh). The
    first call picks the route and every later call keeps it; an SSH error answer stays on SSH."""

    def __init__(self, identity, ssh, connect, say=None):
        self.identity = identity
        self.ssh = ssh
        self.connect = connect
        self.say = say
        self.route = None
        self.command = ssh.command

    @property
    def app_command(self):
        return None if self.route == 'connect' else self.ssh.app_command

    def __call__(self, argv):
        if self.route == 'ssh':
            return self.ssh(argv)
        if self.route == 'connect':
            return self.connect(argv)
        try:
            value = self.ssh(argv)
        except RolloutError as error:
            ssh_reason = unanswered(error)
            if ssh_reason is None:
                self.route = 'ssh'
                raise
        else:
            self.route = 'ssh'
            return value
        try:
            value = self.connect(argv)
        except RolloutError as error:
            connect_reason = unanswered(error)
            if connect_reason is None:  # Connect answered: it is the route, with its refusal.
                self.route = 'connect'
                self._note(ssh_reason)
                raise
            raise RolloutError('%s: unreachable over SSH (%s) and SpecWithCode Connect (%s)' % (
                self.identity, ssh_reason, connect_reason)) from None
        self.route = 'connect'
        self._note(ssh_reason)
        return value

    def _note(self, ssh_reason):
        if self.say is not None:
            self.say('%s: no SSH answer (%s); using SpecWithCode Connect' % (self.identity, ssh_reason))


class Unreachable(object):
    """A fleet machine with neither SSH nor a usable SpecWithCode Connect route: reported, never asked."""

    route = None
    command = None
    app_command = None

    def __init__(self, identity, reason):
        self.identity = identity
        self.reason = reason

    def __call__(self, argv):
        raise RolloutError('%s: %s' % (self.identity, self.reason))


def _proof_bound(token):
    """True for a management token bound to M4's fleet proof key (a `jkt` claim), as
    fleetProofKey.tokenProofThumbprint reads it; only such a token is sent over Connect."""
    parts = token.split('.') if isinstance(token, str) else []
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return False
    try:
        claims = json.loads(base64.urlsafe_b64decode(parts[0] + '=' * (-len(parts[0]) % 4)).decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return False
    jkt = claims.get('jkt') if isinstance(claims, dict) else None
    return isinstance(jkt, str) and 0 < len(jkt) <= 128


def _has_connect(machine):
    if isinstance(machine.get('connectUrl'), str):
        return True
    url = machine.get('url')
    host = urllib.parse.urlsplit(url).hostname if isinstance(url, str) else None
    return bool(host) and not host.endswith('.ts.net')


def connect_machines(home):
    """[{identity, machine, label, connect, reason}] for each machine in M4's studio-fleet.json.
    `connect` is True when it has a Connect address and a proof-bound management token; the token
    itself is never kept or printed. An unreadable file gives []."""
    path = studio_paths.identity_home(home, LOCAL) / FLEET_CONFIG
    try:
        machines = json.loads(path.read_text()).get('machines')
    except (OSError, ValueError, AttributeError):
        return []
    found = []
    for machine in machines if isinstance(machines, list) else []:
        if not isinstance(machine, dict) or not isinstance(machine.get('id'), str):
            continue
        label = machine.get('label') if isinstance(machine.get('label'), str) else machine['id']
        slug = re.sub(r"['\u2019]", '', label.strip().lower())  # "Anna's Air" -> annas-air
        identity = re.sub(r'[^a-z0-9]+', '-', slug).strip('-') or machine['id']
        if not _has_connect(machine):
            reason = 'it has no SpecWithCode Connect address'
        elif not _proof_bound(machine.get('managementToken')):
            reason = ('its management token is not proof-bound, so it is never sent over SpecWithCode Connect; '
                      'choose Invite this machine on it again and add the new line on M4')
        else:
            reason = None
        found.append({'identity': identity, 'machine': machine['id'], 'label': label,
                      'connect': reason is None, 'reason': reason})
    return found


def connect_command(home):
    """M4's installed `fleet update` CLI with M4's studio home, or None when it cannot run."""
    try:
        own, receipt = service_hold.ServiceHold(LOCAL, home).receipt()
    except HoldUnavailable:
        return None
    wrapper = receipt.get('cliWrapper') if isinstance(receipt, dict) else None
    studio_home = receipt.get('studioHome') if isinstance(receipt, dict) else None
    if not isinstance(wrapper, str) or not os.path.isabs(wrapper) or not os.path.isfile(wrapper) \
            or not os.access(wrapper, os.X_OK) or studio_home != str(own):
        return None
    return [wrapper, 'fleet', 'update', '--base-dir', studio_home]


def fleet(home=None, connect=None):
    """{identity: host} for M4 (local), every worker in the inventory over SSH (falling back to
    SpecWithCode Connect when M4's fleet lists it with a Connect address and a proof-bound token),
    and every other fleet machine: Connect-only when it has that route, else Unreachable.
    `connect` is the `fleet update` command prefix (default: M4's installed CLI)."""
    home = pathlib.Path(home or pathlib.Path.home())
    command = connect if connect is not None else connect_command(home)
    machines = connect_machines(home)
    hosts = {LOCAL: Host(LOCAL, [SYSTEM_PYTHON, '-B', '-'])}
    for identity, user, host, _tunnel, _https in fleet_hosts.worker_plans():
        ssh = Host(identity, ssh_command(home, user, host),
                   app_command=ssh_command(home, user, host, desktop_app_rollout.REMOTE_COMMAND))
        match = next((machine for machine in machines
                      if identity in (machine['machine'], machine['identity'])), None)
        if match is not None:
            machines.remove(match)
        if match is not None and match['connect'] and command:
            hosts[identity] = FallbackHost(identity, ssh, ConnectHost(identity, command, match['machine']))
        else:
            hosts[identity] = ssh
    for machine in machines:
        identity = machine['identity']
        # M4's own row: its fleet id is m4 while its label ("M4 Max") gives another slug.
        if LOCAL in (machine['machine'], identity) or identity in hosts:
            continue
        if machine['connect'] and command:
            hosts[identity] = ConnectHost(identity, command, machine['machine'])
        else:
            hosts[identity] = Unreachable(identity, 'no SSH, and %s' % (
                machine['reason'] or "M4's installed CLI cannot run `fleet update`"))
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
    earlier rollout) writes it: not cancelled since, its hold not yet run out, and not answered. One
    the agent handled stands only while it installs it (studioServiceUpdates.pendingServiceInstall),
    or its helper, left to finish, still may: otherwise it failed before any install, which no
    lastInstall records."""
    if (status.get('installRequest') or {}).get('version') != version or not forced_pending(status, now):
        return False
    return (status.get('handledInstallRequestAt') != status.get('installRequestedAt')
            or status.get('status') == 'installing' or 'left to finish' in (status.get('message') or ''))


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
    waited = [None]  # installRequestedAt of the last held request someone else wrote that this rollout waits on.

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
        if getattr(holder[0], 'wait_for_idle', False):
            # The service closes admission before checking work. A busy answer releases
            # only its temporary lease; we neither interrupt work nor send an install.
            if (type(reply.get('idle')) is not bool or type(reply.get('held')) is not bool
                    or reply.get('stoppedThreads') != 0 or reply.get('interruptedRuns', 0) != 0):
                raise unheld('invalid idle-only preparation result')
            if reply['held'] is False:
                return False
            if not reply['idle'] or reply.get('openTerminals') != 0:
                raise unheld('idle-only hold did not prove quiet')
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

    def pressed(status):
        """True while a forced, held request for `version` that this rollout did not write stands: Update
        now pressed meanwhile (or another rollout). Its install is joined, as one under way at the start."""
        at = status.get('installRequestedAt')
        if at == written[0] or not requested_by_update_now(status, version):
            return False
        if waited[0] != at:
            waited[0] = at
            say('%s: Update now asked for %s; waiting for that install instead of asking again' % (identity, version))
        return True

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
        if getattr(hold, 'wait_for_idle', False):
            # Older installed CLIs cannot release a specific lease token. An unconditional
            # release could remove a replacement owner's hold. Cancellation settles our
            # request; without a request the service expires its two-minute idle lease.
            say("%s: left idle lease expiry to its service; no other owner's hold was released" % identity)
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
            if status.get('method') == 'boot-service' and status.get('phase') == 'failed':
                # A Linux self-update keeps no lastInstall; its worker names the failure, set after
                # this rollout's request moved it to downloading. Asking again would fail the same way.
                raise RolloutError('%s could not install %s, so it stays on %s: %s' % (
                    identity, version, status.get('version'),
                    status.get('lastError') or status.get('message') or 'the self-update failed'))
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
            if not held_request and not pressed(status) and drain(status):
                # The agent offers the release now: the forced request follows the hold, so the
                # snapshot its apply is checked against already counts the hold's session row.
                held_request, asked, requests = True, ask(), requests + 1
                continue
            if clock() - asked < window:
                continue
            if pressed(status):  # Its own window from here, once that request no longer stands.
                asked = clock()
                continue
            if status.get('status') == 'installing':
                # A request now would replace the one under way (a press's past its hold among them), and
                # on M4 would follow no drain: that install ends the hold.
                continue
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


def rollout(version, hosts, only='all', hold_minutes=15, local_deadline=115 * 60, worker_deadline=60 * 60,
            worker_force=False, poll=15, clock=time.time, sleep=time.sleep, say=None, hold=None, desktop=None):
    """M4 first (drained and held through `hold`, its ServiceHold, when given), then every other
    host in `hosts` together (M1 and M3, and any Connect-only machine), never held; an Unreachable
    one is reported as skipped. With `desktop` (desktop_app_rollout.DesktopApps), each worker's desktop app
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
            host = hosts[identity]
            if isinstance(host, Unreachable):  # Reported, never asked.
                say('%s: skipped: %s' % (identity, host.reason))
                with lock:
                    results[identity] = {'identity': identity, 'result': 'skipped', 'reason': host.reason}
                return
            if hasattr(host, 'say') and host.say is None:
                host.say = say  # FallbackHost names the route it falls back to.
            try:
                result = roll_host(identity, host, version, worker_force, hold_minutes,
                                   worker_deadline, poll, clock, sleep, say)
                route = getattr(host, 'route', None)
                if route:
                    result['route'] = route
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
                if getattr(host, 'route', None) == 'connect':
                    # desktop_app_update_remote.sh runs over SSH only; the service is on the version.
                    say('%s: desktop app skipped: needs SSH (reached over SpecWithCode Connect)' % identity)
                    app = {'result': 'skipped', 'reason': 'needs SSH'}
                else:
                    app = update_app(identity)
                with lock:
                    result['desktopApp'] = app

        threads = [threading.Thread(target=worker, args=(identity,), name='rollout-' + identity)
                   for identity in hosts if identity != LOCAL]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if errors:
            raise RolloutError('; '.join(sorted(errors) + sorted(app_errors)))
        if app_errors:
            raise DesktopAppsFailed('; '.join(sorted(app_errors)), results)
    return results


def plan_route(host):
    """How --dry-run would reach a host: its route and the commands for it."""
    if isinstance(host, Unreachable):
        return {'route': 'skipped', 'reason': host.reason}
    if isinstance(host, FallbackHost):
        return {'route': 'ssh, then SpecWithCode Connect on no answer', 'ssh': host.ssh.command,
                'connect': host.connect.command + [host.connect.machine, '...', '--json']}
    if isinstance(host, ConnectHost):
        return {'route': 'SpecWithCode Connect', 'connect': host.command + [host.machine, '...', '--json']}
    return {'route': 'local' if host.command[:1] == [SYSTEM_PYTHON] else 'ssh', 'command': host.command}


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--version', required=True)
    parser.add_argument('--only', choices=('all', LOCAL, 'workers'), default='all')
    parser.add_argument('--hold-minutes', type=int, default=update_request.HOLD_MAX_MINUTES,
                        help='M4 hold (and worker hold with --worker-force), 1 to 15')
    parser.add_argument('--m4-deadline-minutes', type=int, default=115)
    parser.add_argument('--worker-deadline-minutes', type=int, default=60)
    parser.add_argument('--worker-force', action='store_true', help='force the M1 and M3 requests too')
    parser.add_argument('--poll-seconds', type=int, default=15)
    parser.add_argument('--wait-for-idle', action='store_true',
                        default=os.environ.get('STUDIO_FLEET_WAIT_FOR_IDLE') == '1',
                        help='acquire a service-owned idle hold; never interrupt running work')
    parser.add_argument('--no-hold', action='store_true',
                        help="do not drain and hold M4's service first (a busy M4 then waits for its work)")
    parser.add_argument('--no-desktop-apps', action='store_true',
                        help="leave M1's and M3's desktop apps as they are (by default each follows its service)")
    parser.add_argument('--dry-run', action='store_true', help='print the order and commands; contact no host')
    args = parser.parse_args(argv)
    if args.wait_for_idle and args.no_hold:
        parser.error('--wait-for-idle cannot be combined with --no-hold')
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
    if hold is not None:
        hold.wait_for_idle = args.wait_for_idle
    supported, reason = hold.support() if hold else (True, None)
    if args.dry_run:
        order = ([LOCAL] if args.only in ('all', LOCAL) else []) + (
            ['+'.join(name for name in hosts if name != LOCAL) or '+'.join(WORKERS)]
            if args.only in ('all', 'workers') else [])
        try:
            planned = hold.command(hold.prepare_flags()) if hold else None
        except HoldUnavailable as error:
            planned = 'unavailable: %s' % error
        if not supported:
            planned = 'unsupported: %s' % reason
        print(json.dumps({'version': args.version, 'order': order, 'hold': planned,
                          'commands': {name: host.command for name, host in hosts.items()},
                          'routes': {name: plan_route(host) for name, host in hosts.items()},
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
