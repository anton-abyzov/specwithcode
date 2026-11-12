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
The drain stops no folder copy, and the restart would cut one off: while M4's service reports a copy
to or from another machine (updates/folder-work.json, folder_work.py), M4 is neither drained nor
asked, and the rollout waits for it. Once a drain found copies, it drains again only after the
service's own count, which stops nothing, shows none: a heartbeat it cannot write never makes every
poll stop running work. Its forced request still waits for copies (update_request
--waits-for-folder-copies), and no copy starts while the service is held. A worker is not asked while
M4 copies: an older worker counts no copy of its own, so its restart would cut off one with M4.
`--ignore-folder-copies` drains, asks and installs over them.
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

Workers are asked over SpecWithCode Connect only, by default. Each update_request.py command
becomes M4's own `specweave-studio fleet update <machine> ... --connect-only --json`, which
answers with the same keys. M1 and M3 (fleet_hosts.PORTS) are matched to M4's studio-fleet.json by
machine id or label; one missing there, without a Connect address or a proof-bound management token,
or with no usable CLI on M4 is reported unreachable with that reason, and the fleet inventory
(hosts.json) is not read.

`--ssh-fallback` (release.sh passes it when RELEASE_FLEET_SSH=1) restores pinned fleet SSH from
hosts.json: Connect is still tried first, and only a transport failure during the initial status
read selects pinned SSH. An authorization refusal stops the rollout, and each worker keeps the
selected route once a request can be sent. Over SSH each request is written by update_request.py,
streamed with studio_paths.py to the host's /usr/bin/python3 (the network-transition.py
convention), so a host needs neither this repository nor a newer agent. A worker in hosts.json
without a Connect address then goes over SSH only. Machines outside M1 and M3 go over Connect only.

Once a worker's service is confirmed on the version (installed, or already on it), its desktop
app follows. That step needs pinned fleet SSH, so it runs only with --ssh-fallback: there it is
updated to the same version (desktop_app_rollout.py, which runs desktop_app_update_remote.sh
there), and the rollout reports its version before and after and how: already current, the app's
own updater on quit, or swapped. A failed app update fails the rollout after every service is
done, naming the host and the reason. Without the flag each confirmed worker reports the step
skipped (its own updater installs the version on quit), which fails nothing; --no-desktop-apps
skips the step entirely. M4's app is release.sh's desktop stage's.

    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37        # M4, then M1 and M3
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only m4 --no-hold
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --dry-run
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --no-desktop-apps
    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --only workers --ssh-fallback

A host whose "Pause running work for updates" is off (update_policy) is never forced, keeps its deadline,
and ends `deferred` only when it is still busy with running work after 30 min and nothing started: a
worker so fails nothing, M4 still ends the run with exit 1 (only held when idle).
Every host ends with a row: installed, already-installed, or not-updated with a reason. M4, M1
and M3 are required (REQUIRED_HOSTS; --optional HOST relaxes one): a required host that is
unreachable, skipped or fails ends the run as `partial` with exit 1 and a per-host report. Any other
machine (ministorm, a Connect-only Mac) may end not-updated without failing the run. A host that
stops answering status reads after its request (a restart) counts as lost only once it has stayed
silent for STATUS_OUTAGE_SECONDS, not after a number of reads. A request the host does not
acknowledge (no installRequestedAt written back) is sent again after ACK_WINDOW, at most
ACK_RETRIES more times.

One rollout runs at a time: each run takes an exclusive lock (updates/fleet-rollout.lock in M4's
home, an flock that a dead process leaves free). A release's run waits for it (--lock-wait-minutes);
`--reconcile` (M4's update agent, after M4 finalized a version any way, Update now included) gives
up at once with `locked` and exit 0, since the run holding it covers the workers.

    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.37 --reconcile

Candidate channel (increment 1239): release.sh's canary and fleet stages pass `--channel candidate
--channel-since X.Y.Z`. The request is the same version-bound one; the host's agent finds the version
in the R2 candidate feed because the request names it (update_agent_recovery.feed_releases). A host
whose installed release is older than --channel-since has an agent that reads GitHub only, so it is
not asked and ends not-updated with that reason. While an M4 candidate run is under way, M4's own
reconcile for that version leaves the workers to the release (CANDIDATE_HOLD), and the fleet stage
clears that hold once every required host verified.

    python3 -B scripts/studio-fleet/fleet_rollout.py --version 1.0.190 --only m4 --channel candidate --channel-since 1.0.190

Exit 0 when every required host has finalized the version and every worker's app is on it, 1 when
one has not, 2 for bad arguments.
"""
import argparse
import base64
import datetime
import fcntl
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
import folder_work
import rollout_record
import service_hold
import studio_paths
import update_policy
from update_policy import describe_blockers  # noqa: F401 - moved there; roll_host and tests use it here.
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
STATUS_FAILURES = 5  # Consecutive unanswered status reads, at least, before a host counts as lost...
STATUS_OUTAGE_SECONDS = 300  # ...and only once it has been silent this long: a restart is not a lost host.
# A worker's SpecWithCode Connect relay comes back about two minutes after its service restarts
# (1.0.192: M1's edge answered 530 from its 00:09:22Z restart until about 00:11:20Z), so a read
# Connect left unanswered ('unreachable') is asked again for this long before the host fails.
CONNECT_RETRY_SECONDS = 180
CONNECT_RETRY_DELAYS = (5, 10, 20, 30)  # Seconds between attempts; the last one repeats.
ACK_WINDOW = 60  # Seconds before a request the host did not acknowledge is sent again.
ACK_RETRIES = 3  # Unacknowledged requests sent again before the host counts as not reached.
REQUIRED_HOSTS = ('m4', 'm1', 'm3')  # A release is done only when these are verified (increment 1239, D-03).
LOCK_NAME = 'fleet-rollout.lock'
CANDIDATE_HOLD = 'fleet-candidate-hold.json'  # Beside the lock: {version, at} of an M4 candidate run.
CANDIDATE_HOLD_SECONDS = 6 * 3600  # Canary, soak and fleet windows, and then some.
RECONCILE_WAIT = 20 * 60  # A reconcile waits this long for an M4-only rollout to end.
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


class RolloutPartial(RolloutError):
    """A required host did not end on the version; `results` holds every host's row."""

    def __init__(self, message, results):
        RolloutError.__init__(self, message)
        self.results = results


class RolloutDeferred(RolloutError):
    """Its owner's "Pause running work for updates" is off and it stayed busy: left for later, not failed.
    `app`: False for a Linux boot service, which has no desktop app to leave for later."""

    def __init__(self, message, app=True):
        RolloutError.__init__(self, message)
        self.app = app


class RolloutLocked(Exception):
    """Another rollout holds the lock; `holder` is what it wrote there."""

    def __init__(self, holder):
        Exception.__init__(self, 'another fleet rollout runs: %s' % (json.dumps(holder) if holder else 'unknown'))
        self.holder = holder


class RolloutLock(object):
    """An exclusive flock on `path`. The kernel frees it when the holder dies, so a lock file left by
    a dead process is taken again; what the holder wrote there (pid, mode, version) only names it."""

    def __init__(self, path, clock=time.time, sleep=time.sleep):
        self.path = pathlib.Path(path)
        self.clock = clock
        self.sleep = sleep
        self.fd = None

    def holder(self):
        try:
            return json.loads(self.path.read_text() or 'null')
        except (OSError, ValueError):
            return None

    def acquire(self, wait=0, poll=10, info=None, say=None):
        """Takes the lock, waiting up to `wait` seconds; raises RolloutLocked when it stays taken."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT, 0o600)
        begin, told = self.clock(), False
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if self.clock() - begin >= wait:
                    os.close(fd)
                    raise RolloutLocked(self.holder()) from None
                if say is not None and not told:
                    say('waiting for the fleet rollout that holds %s: %s' % (self.path, json.dumps(self.holder())))
                    told = True
                self.sleep(poll)
        os.ftruncate(fd, 0)
        os.write(fd, json.dumps(dict(info or {}, pid=os.getpid(), at=self.clock())).encode('utf-8'))
        self.fd = fd
        return self

    def release(self):
        if self.fd is not None:
            try:
                os.ftruncate(self.fd, 0)
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
                self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.release()


def covers(holder, version):
    """True when the rollout holding the lock asks the workers for `version` itself."""
    return isinstance(holder, dict) and holder.get('version') == version and holder.get('only') in ('all', 'workers')


LOCK_ENV = 'STUDIO_FLEET_ROLLOUT_LOCK'  # Tests point it at a temporary file, never M4's real lock.


def lock_path(home=None):
    override = os.environ.get(LOCK_ENV)
    if override:
        return pathlib.Path(override)
    return studio_paths.identity_home(pathlib.Path(home or pathlib.Path.home()), LOCAL) / 'updates' / LOCK_NAME


def candidate_hold(version=None, clear=False, clock=time.time):
    """Writes (`version`), clears (`clear`) or reads the M4 candidate hold; reading returns the
    version a fresh hold names, or None."""
    path = lock_path().parent / CANDIDATE_HOLD
    if version is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'version': version, 'at': clock()}))
        return version
    if clear:
        if path.is_file():
            path.unlink()
        return None
    try:
        value = json.loads(path.read_text())
        fresh = 0 <= clock() - float(value['at']) <= CANDIDATE_HOLD_SECONDS
        return value['version'] if fresh else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def not_updated(identity, reason, **extra):
    """The row of a host that did not end on the version."""
    return dict({'identity': identity, 'result': 'not-updated', 'reason': reason}, **extra)


def report(version, results, required):
    """One line per host that is not on `version`, required ones first."""
    rows = sorted(((identity, row) for identity, row in results.items()
                   if row.get('result') not in ('installed', 'already-installed')),
                  key=lambda item: (item[0] not in required, item[0]))
    return ['%s%s: %s on %s: %s' % (identity, ' (required)' if identity in required else '', row.get('result'),
                                    version, row.get('reason') or row.get('error') or '') for identity, row in rows]


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


def unanswered(error):
    """Why a route gave no answer ('exit 255', 'timeout', ...), or None when the host answered."""
    if hasattr(error, 'unanswered'):
        return error.unanswered
    text = str(error)
    if 'gave no answer (exit 255)' in text:
        return 'exit 255'
    if 'did not answer within' in text:
        return 'timeout'
    if 'could not be reached' in text:
        return 'not reachable'
    return None


def connect_retry_delay(attempt, waited, window=CONNECT_RETRY_SECONDS):
    """Seconds to wait before attempt `attempt + 1` (0-based) after `waited` seconds of retries, or
    None once `window` is spent."""
    if waited >= window:
        return None
    return min(CONNECT_RETRY_DELAYS[min(attempt, len(CONNECT_RETRY_DELAYS) - 1)], window - waited)


def retry_unreachable(attempt, unreachable, identity, what, clock, sleep, say, window=CONNECT_RETRY_SECONDS):
    """`attempt()`, asked again with backoff for up to `window` seconds while `unreachable(outcome)`
    says SpecWithCode Connect left the host unanswered (its relay reconnecting after a restart);
    `outcome` is the answer or the RolloutError raised. Returns the last answer, or raises the last
    error. Only for reads: a call that may have been delivered must not go through here."""
    begin, tries = clock(), 0
    while True:
        try:
            outcome, error = attempt(), None
        except RolloutError as raised:
            outcome, error = raised, raised
        if unreachable(outcome):
            waited = clock() - begin
            delay = connect_retry_delay(tries, waited, window)
            if delay is not None:
                tries += 1
                say('%s: SpecWithCode Connect unreachable (%s); asking again in %ds (%ds of %ds)'
                    % (identity, what, delay, int(waited), window))
                sleep(delay)
                continue
            say('%s: SpecWithCode Connect still unreachable after %ds of retries' % (identity, int(waited)))
        if error is not None:
            raise error
        return outcome


def connect_settled(call, argv, identity, clock, sleep, say, window=CONNECT_RETRY_SECONDS):
    """`call(argv)` (a status read), asked again while Connect leaves the host unanswered. A refusal
    or unauthorized answer, and any SSH route (whose errors carry no `unanswered`), raise at once."""
    return retry_unreachable(lambda: call(argv), lambda outcome: getattr(outcome, 'unanswered', None) == 'unreachable',
                             identity, argv[0], clock, sleep, say, window)


# Over SpecWithCode Connect a forced request waits for the worker's drain and the request it writes
# (fleet update polls up to 200 s after a POST of up to 75 s). A Linux machine older than the fleet
# update endpoint (ministorm on 1.0.105) instead keeps `server.updateServer` open through its whole
# download and staged preflight, for up to 10 minutes (LEGACY_SELF_UPDATE_TIMEOUT in fleetUpdate.ts);
# killing the CLI before then closes that socket and cancels the download.
LEGACY_SELF_UPDATE_SECONDS = 600
CONNECT_REQUEST_TIMEOUT = LEGACY_SELF_UPDATE_SECONDS + 120  # Plus reaching it and its WebSocket ticket.


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
        return self.command + [self.machine] + mapped + ['--connect-only', '--json']

    def __call__(self, argv):
        command = self.argv(argv)
        timeout = CONNECT_REQUEST_TIMEOUT if argv[0] == 'request' else CALL_TIMEOUT
        try:
            result = self.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout,
                              env=self.env)
        except subprocess.TimeoutExpired:
            raise RolloutError('%s did not answer over SpecWithCode Connect within %ds'
                               % (self.identity, timeout)) from None
        except OSError as error:
            raise RolloutError('%s: could not run the fleet CLI (%s)'
                               % (self.identity, type(error).__name__)) from None
        lines = [line for line in (result.stdout or '').splitlines() if line.strip()]
        try:
            value = json.loads(lines[-1]) if lines else None
        except ValueError:
            value = None
        if not isinstance(value, dict):
            raise RolloutError('%s: fleet CLI returned no Connect result (exit %d); use a CLI with --connect-only'
                               % (self.identity, result.returncode))
        if result.returncode != 0 or 'error' in value:
            reason = value.get('reason')
            error = RolloutError('%s: %s%s' % (self.identity, value.get('error') or 'exit %d' % result.returncode,
                                               ' (%s)' % reason if reason else ''))
            error.reply = value
            error.unanswered = 'unreachable' if reason == 'unreachable' else None
            raise error
        if value.get('transport') != 'connect':
            raise RolloutError('%s: fleet CLI did not attest the SpecWithCode Connect route' % self.identity)
        return value


class FallbackHost(object):
    """Connect first. Only an unavailable initial status read permits fallback to pinned SSH."""

    def __init__(self, identity, ssh, connect, say=None):
        self.identity = identity
        self.ssh = ssh
        self.connect = connect
        self.say = say
        self.route = None
        self.command = ssh.command
        self.app_command = ssh.app_command

    def __call__(self, argv):
        if self.route == 'ssh':
            return self.ssh(argv)
        if self.route == 'connect':
            return self.connect(argv)
        if argv[0] != 'status':
            raise RolloutError('%s: select the fleet route with a status read first' % self.identity)
        try:
            value = self.connect(argv)
        except RolloutError as error:
            connect_reason = getattr(error, 'unanswered', None)
            if connect_reason is None:
                self.route = 'connect'
                raise
        else:
            self.route = 'connect'
            return value
        try:
            value = self.ssh(argv)
        except RolloutError as error:
            ssh_reason = unanswered(error)
            if ssh_reason is None:
                self.route = 'ssh'
                raise
            raise RolloutError('%s: unreachable over SpecWithCode Connect (%s) and SSH (%s)' % (
                self.identity, connect_reason, ssh_reason)) from None
        self.route = 'ssh'
        if self.say is not None:
            self.say('%s: SpecWithCode Connect unavailable (%s); using pinned fleet SSH' %
                     (self.identity, connect_reason))
        return value


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
        has_connect = _has_connect(machine)
        if not has_connect:
            reason = 'it has no SpecWithCode Connect address'
        elif not _proof_bound(machine.get('managementToken')):
            reason = ('its management token is not proof-bound, so it is never sent over SpecWithCode Connect; '
                      'choose Join a main machine on it again and add the new line on M4')
        else:
            reason = None
        found.append({'identity': identity, 'machine': machine['id'], 'label': label,
                      'connect': reason is None, 'has_connect': has_connect, 'reason': reason})
    return found


def connect_command(home, subcommand='update'):
    """M4's installed `fleet <subcommand>` CLI with M4's studio home, or None when it cannot run."""
    try:
        own, receipt = service_hold.ServiceHold(LOCAL, home).receipt()
    except HoldUnavailable:
        return None
    wrapper = receipt.get('cliWrapper') if isinstance(receipt, dict) else None
    studio_home = receipt.get('studioHome') if isinstance(receipt, dict) else None
    if not isinstance(wrapper, str) or not os.path.isabs(wrapper) or not os.path.isfile(wrapper) \
            or not os.access(wrapper, os.X_OK) or studio_home != str(own):
        return None
    return [wrapper, 'fleet', subcommand, '--base-dir', studio_home]


SSH_FALLBACK_HINT = 'pass --ssh-fallback to use pinned fleet SSH'


def connect_reason(match, command, subcommand='update'):
    """Why a worker cannot be asked over SpecWithCode Connect, or None when it can."""
    if match is None:
        return "it is not in M4's fleet (%s)" % FLEET_CONFIG
    if not match['connect']:
        return match['reason']
    if not command:
        return "M4's installed CLI cannot run `fleet %s`" % subcommand
    return None


def find_machine(machines, identity):
    """The studio-fleet.json row for `identity` (its machine id or label slug), or None."""
    return next((machine for machine in machines if identity in (machine['machine'], machine['identity'])), None)


def fleet(home=None, connect=None, ssh_fallback=False):
    """{identity: host} for M4 (local), M1 and M3 over Connect, and other fleet machines over
    Connect. A worker Connect cannot ask is Unreachable, naming why. With `ssh_fallback`, M1 and M3
    come from the fleet inventory: linked ones over Connect with pinned SSH as fallback, ones
    without a Connect address over SSH. `connect` is the `fleet update` command prefix (default:
    M4's installed CLI)."""
    home = pathlib.Path(home or pathlib.Path.home())
    command = connect if connect is not None else connect_command(home)
    machines = connect_machines(home)
    hosts = {LOCAL: Host(LOCAL, [SYSTEM_PYTHON, '-B', '-'])}
    if not ssh_fallback:
        for identity in WORKERS:
            match = find_machine(machines, identity)
            if match is not None:
                machines.remove(match)
            reason = connect_reason(match, command)
            hosts[identity] = ConnectHost(identity, command, match['machine']) if reason is None \
                else Unreachable(identity, 'no SpecWithCode Connect route: %s; %s' % (reason, SSH_FALLBACK_HINT))
    for identity, user, host, _tunnel, _https in fleet_hosts.worker_plans() if ssh_fallback else ():
        ssh = Host(identity, ssh_command(home, user, host),
                   app_command=ssh_command(home, user, host, desktop_app_rollout.REMOTE_COMMAND))
        match = find_machine(machines, identity)
        if match is not None:
            machines.remove(match)
        if match is not None and match['connect'] and command:
            hosts[identity] = FallbackHost(identity, ssh, ConnectHost(identity, command, match['machine']))
        elif match is not None and match['has_connect']:
            hosts[identity] = Unreachable(identity, match['reason'] or "M4's installed CLI cannot run fleet update")
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

    ignore_folder_copies = False

    def __init__(self, identity=LOCAL, home=None, run=subprocess.run):
        service_hold.ServiceHold.__init__(self, identity, home, run)

    def folder_copies(self):
        """The folder copies the service reports in progress here; 0 for none or an older service."""
        return local_folder_copies(self.home, self.identity)


def local_folder_copies(home=None, identity=LOCAL):
    """The folder copies this machine's service reports in progress (its heartbeat, folder_work.py)."""
    return folder_work.in_progress(studio_paths.identity_home(pathlib.Path(home or pathlib.Path.home()), identity)
                                   / 'updates')


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


def roll_host(identity, call, version, force, hold_minutes, deadline, poll, clock, sleep, say, hold=None,
              local_copies=None, ignore_copies=False, channel_since=None):
    """Asks one host for `version` and waits until it reports it installed. With `hold` (M4's
    ServiceHold), each forced request follows Update now's drain and hold, which waits until the
    agent offers `version`; before that the agent is only asked to check. A rollout that gives up
    cancels the forced request it wrote and releases the hold it took once nothing needs it.
    `local_copies` (a worker's): M4's own folder copies, which keep each request back until they end.
    `ignore_copies` (--ignore-folder-copies): no wait for copies, and a forced request installs over them."""
    begin = clock()
    status = connect_settled(call, ['status', '--identity', identity], identity, clock, sleep, say)
    current = status.get('version')
    if current == version and status.get('installFinalized') is True:
        say('%s: already on %s' % (identity, version))
        return {'identity': identity, 'result': 'already-installed', 'requests': 0, 'seconds': 0}
    if _tuple(current) is not None and _tuple(current) > _tuple(version):
        raise RolloutError('%s already runs %s, newer than %s' % (identity, current, version))
    if channel_since is not None and (_tuple(current) or (0, 0, 0)) < channel_since:
        raise RolloutError('%s runs %s, whose update agent reads GitHub only (the candidate channel needs %s); '
                           'ship a stable release through GitHub first' % (identity, current, '.'.join(map(str, channel_since))))
    # M4's setting comes from its service's look (main); a worker's from its status over Connect.
    allowed = getattr(hold, 'pause_work', None) if hold is not None else update_policy.pauses_work(status)
    if force and hold is None and update_policy.over_ssh(call):  # Its setting cannot be read there.
        say(update_policy.SSH_PLAIN % identity)
        force = False
    force = force and (allowed is not False or hold is not None)  # Off: M4's hold is idle-only, a worker's plain.
    started = [False]  # Its install began (a hold taken, installing seen): no deferral from then on.
    window = hold_minutes * 60 if force else REQUEST_WINDOW
    holder = [hold if force else None]
    took = [False]  # This rollout holds (or held) the service.
    sent = [0]  # Requests this rollout wrote.
    written = [None]  # installRequestedAt of the last forced request this rollout wrote.
    waited = [None]  # installRequestedAt of the last held request someone else wrote that this rollout waits on.
    copying = [0]  # Folder copies the forced drain, or a worker's request, waits for, as last seen.
    counted = [0]  # Copies a drain found: no drain again until the service's own count shows none.
    refused = [None]  # What the last idle-only hold was refused for (`describe_blockers`), else None.
    said = [None]  # The refusal last logged, so a busy service asked every poll is named once per change.
    deferred = [False]  # A worker's request held back while M4 copies.
    acked = [None]  # installRequestedAt the host wrote back for the last request, or None.
    unacked = [0]  # Requests in a row the host did not acknowledge.

    def unheld(reason):
        """A wanted hold that cannot be taken stops the rollout before any further forced request."""
        outcome = 'it was not asked again' if sent[0] else 'it was not asked to install'
        return RolloutError('%s: could not hold the service for %s (%s), so %s. %s' % (
            identity, version, reason, outcome, UNSUPPORTED_PATH % {'version': version}))

    def drain(status):
        """Update now's drain and hold, right before a request; True when the service holds.
        Raises RolloutError when the service cannot be held."""
        refused[0] = None
        if holder[0] is None or status.get('status') == 'installing' or not offers(status, version):
            return False
        # The forced drain stops no copy, and from its hold on the copy's other side gets 503s until
        # it gives up. An if-idle hold is refused while one runs.
        waits = not getattr(holder[0], 'wait_for_idle', False) and not getattr(holder[0], 'ignore_folder_copies', False)
        copies = holder[0].folder_copies() if waits else 0
        if waits and not copies and counted[0]:
            try:  # Stops nothing; a heartbeat that cannot be written reads as no copy.
                copies = holder[0].counted_copies()
            except HoldUnavailable as error:
                say('%s: could not count folder copies (%s); still waiting for them' % (identity, error))
                copies = counted[0]
            counted[0] = copies
        if copies:
            if copying[0] != copies:
                say('%s: waiting for %s to or from another machine before draining for %s '
                    '(--ignore-folder-copies installs over them)'
                    % (identity, 'a folder copy' if copies == 1 else '%d folder copies' % copies, version))
            copying[0] = copies
            return False
        copying[0] = 0
        try:
            reply = holder[0].prepare()
        except HoldUnavailable as error:
            raise unheld(error) from None
        if waits and type(reply.get('folderCopies')) is int and reply['folderCopies'] > 0:
            # A copy began during the drain: let work start again and wait for it.
            try:
                holder[0].release()
            except HoldUnavailable as error:
                say('%s: WARNING: could not release the hold (%s); it ends on its own within %d minutes'
                    % (identity, error, hold_minutes))
            copying[0] = counted[0] = reply['folderCopies']
            say('%s: a folder copy began during the drain; released the hold and waits for it' % identity)
            return False
        if getattr(holder[0], 'wait_for_idle', False):
            # The service closes admission before checking work. A busy answer releases
            # only its temporary lease; we neither interrupt work nor send an install.
            if (type(reply.get('idle')) is not bool or type(reply.get('held')) is not bool
                    or reply.get('stoppedThreads') != 0 or reply.get('interruptedRuns', 0) != 0):
                raise unheld('invalid idle-only preparation result')
            if reply['held'] is False:
                why = describe_blockers(reply)
                if said[0] != why:
                    say('%s: the service is not idle, so %s waits; busy with: %s'
                        % (identity, version, why))
                refused[0] = said[0] = why
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
            if not ignore_copies:  # Nobody forced it over copies: its snapshot still waits (update.py).
                argv += ['--waits-for-folder-copies']
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
        # The host acknowledges by answering with its request: update_request writes installRequestedAt
        # back; a Linux self-update over Connect (boot-service) answers `request: null`, as does a host
        # already on the version. A reply with no request answer at all reached no agent.
        acked[0] = ((reply.get('request') or {}).get('installRequestedAt')
                    or ('acknowledged' if 'request' in reply or reply.get('method') == 'boot-service' else None))
        rollout_record.asked(identity, current, acked[0], version=version)  # The release's run record.
        if acked[0]:
            unacked[0] = 0
        else:
            unacked[0] += 1
            if unacked[0] > ACK_RETRIES:
                raise RolloutError('%s never acknowledged a request for %s (%d sent)' % (identity, version, sent[0]))
            say('%s: the request was not acknowledged; asking again in %ds' % (identity, ACK_WINDOW))
        agent_note(identity, reply, say)
        if reply.get('kicked') is False:
            say('%s: launchctl kickstart failed; the agent still runs within 10 minutes' % identity)
        if first[0] is None:  # The host's own clock, the one its agent dates lastInstall by.
            first[0] = update_request._time((reply.get('request') or {}).get('installRequestedAt'))
        return clock()

    def held_back():
        """True while a worker's request waits for M4's own folder copies (`local_copies`)."""
        copies = local_copies() if holder[0] is None and local_copies is not None and not ignore_copies else 0
        if copies and copying[0] != copies:
            say('%s: waiting for %s on M4 to finish before asking for %s (--ignore-folder-copies asks anyway)'
                % (identity, 'a folder copy' if copies == 1 else '%d folder copies' % copies, version))
        copying[0], deferred[0] = copies, bool(copies)
        return deferred[0]

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
            if held_request or (holder[0] is None and not held_back()):
                asked, requests = ask(), 1
            elif copying[0] or refused[0]:  # Offered; the drain waits for copies or quiet.
                asked, requests = clock(), 0
            elif status.get('status') == 'installing':  # Never a forced request before the hold.
                # The install under way, not joined (automatic, or its hold ran out): the agent
                # saved 'installing' before it started, so its failure, dated after, is reported
                # here instead of draining and asking for the release that just failed.
                first[0] = update_request._time(status.get('updatedAt'))
                asked, requests = clock(), 0
            else:  # Never a forced request before the hold: a check until the agent offers it.
                asked, requests = check(), 0
        seen, failures, silent = None, 0, None
        while True:
            if clock() - begin >= deadline:
                raise RolloutError('%s did not install %s within %d min; last: %s %s%s' % (
                    identity, version, deadline // 60, status.get('status'), status.get('message') or '',
                    '; still waiting for %s here' % ('a folder copy' if copying[0] == 1 else '%d folder copies' % copying[0])
                    if copying[0] else ''))
            sleep(poll)
            try:
                status = call(['status', '--identity', identity])
                failures, silent = 0, None
            except RolloutError as error:
                failures += 1
                silent = clock() if silent is None else silent
                quiet_for = int(clock() - silent)
                say('%s: status unavailable (%d, silent %ds of %ds): %s' % (
                    identity, failures, quiet_for, STATUS_OUTAGE_SECONDS, error))
                if failures >= STATUS_FAILURES and quiet_for >= STATUS_OUTAGE_SECONDS:
                    raise RolloutError('%s gave no status for %ds (%d reads): %s' % (
                        identity, quiet_for, failures, error)) from None
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
                done = {'identity': identity, 'result': 'installed', 'requests': requests, 'seconds': seconds}
                if acked[0] and acked[0] != 'acknowledged':
                    done['acknowledgedAt'] = acked[0]
                return done
            if status.get('status') == 'manual-required':
                raise RolloutError('%s needs a manual upgrade: %s' % (identity, status.get('message') or ''))
            # Busy past the deferral point, or a Linux service's own wait ended: before any failure below.
            if (why := update_policy.deferral(identity, version, status, allowed, clock() - begin, deadline,
                                              started, took[0], refused[0], bool(sent[0]))):
                raise RolloutDeferred(why, app=status.get('method') != 'boot-service')
            if status.get('method') == 'boot-service' and status.get('phase') == 'failed' and (sent[0] or joined):
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
            if deferred[0]:  # A worker's request, once M4's copies ended; a window of its own from here.
                if not held_back():
                    asked, requests = ask(), requests + 1
                continue
            if not held_request and not pressed(status) and drain(status):
                # The agent offers the release now: the forced request follows the hold, so the
                # snapshot its apply is checked against already counts the hold's session row.
                held_request, asked, requests = True, ask(), requests + 1
                continue
            if clock() - asked < (window if acked[0] or not sent[0] or holder[0] is not None else ACK_WINDOW):
                continue
            if pressed(status):  # Its own window from here, once that request no longer stands.
                asked = clock()
                continue
            if status.get('status') == 'installing':
                # A request now would replace the one under way (a press's past its hold among them), and
                # on M4 would follow no drain: that install ends the hold.
                continue
            if holder[0] is not None and not held_request:
                asked = clock() if copying[0] or refused[0] else check()  # Copies, quiet, or not offered.
                continue
            say('%s: the %s window ended without an install; asking once more' % (identity, 'hold' if force else 'request'))
            held_request = drain(status)
            if held_request or (holder[0] is None and not held_back()):
                asked, requests = ask(), requests + 1
            elif deferred[0]:
                asked = clock()
            else:  # It waits for copies, or no longer offers the release.
                asked = clock() if copying[0] or refused[0] else check()
    except (RolloutError, KeyboardInterrupt):
        release(status)
        raise


def rollout(version, hosts, only='all', hold_minutes=15, local_deadline=115 * 60, worker_deadline=60 * 60,
            worker_force=False, poll=5, clock=time.time, sleep=time.sleep, say=None, hold=None, desktop=None,
            local_copies=None, ignore_folder_copies=False, required=REQUIRED_HOSTS, m4_wait=0, desktop_skip=None,
            channel_since=None):
    """M4 first (drained and held through `hold`, its ServiceHold, when given), then every other
    host in `hosts` together (M1 and M3, and any Connect-only machine), never held; an Unreachable
    one is reported as skipped. `local_copies` (local_folder_copies) counts M4's own folder copies,
    which keep every worker's request back, as runFleetUpdate does on the Connect route. With `desktop` (desktop_app_rollout.DesktopApps), each worker's desktop app
    follows once its service is confirmed on `version`. Returns {identity: result}; raises
    RolloutPartial (every host's row in `results`) when a host in `required` did not end on `version`,
    or DesktopAppsFailed once every service is done when only an app update failed. A host outside
    `required` that fails or cannot be reached ends with a not-updated row and fails nothing.
    `desktop_skip`, without `desktop`, is the reason each confirmed worker reports for its app."""
    say = say or Printer(clock=clock)
    results = {}
    required = tuple(required)
    if only in ('all', LOCAL):
        try:
            results[LOCAL] = roll_host(LOCAL, hosts[LOCAL], version, True, hold_minutes, local_deadline, poll,
                                       clock, sleep, say, hold=hold, channel_since=channel_since,
                                       ignore_copies=ignore_folder_copies or getattr(hold, 'ignore_folder_copies', False))
        except RolloutError as error:  # A deferred M4 still fails the run: the later stages need it on the version.
            later = isinstance(error, RolloutDeferred)
            results[LOCAL] = update_policy.deferred_row(LOCAL, str(error)) if later else not_updated(LOCAL, str(error))
            if only == 'all':
                for identity in hosts:
                    if identity != LOCAL:
                        results[identity] = not_updated(identity, update_policy.M4_LATER if later
                                                        else 'not asked: M4 did not finalize %s' % version)
            raise RolloutPartial(str(error), results) from None
    if only in ('all', 'workers'):
        if only == 'workers':
            # `m4_wait` (a reconcile): M4's agent starts it before it has saved the install it finalizes.
            begin = clock()
            while True:
                status = hosts[LOCAL](['status', '--identity', LOCAL])
                if (status.get('version') == version and status.get('installFinalized') is True) \
                        or clock() - begin >= m4_wait:
                    break
                sleep(poll)
            if status.get('version') != version or status.get('installFinalized') is not True:
                raise RolloutError('M4 has not finalized %s (descriptor %s): install it first (--only m4); '
                                   'M1 and M3 never go while M4 is updating' % (version, status.get('version')))
        errors, app_errors, lock = [], [], threading.Lock()

        def update_app(identity, via_connect):
            """The worker's desktop app, once its service runs `version`; a failure is reported, not raised."""
            try:
                return desktop(identity, say)
            except desktop_app_rollout.DesktopAppError as error:
                reason = str(error)
                if via_connect and isinstance(error, desktop_app_rollout.DesktopSshUnavailable):
                    say('%s: desktop app skipped: %s' % (identity, reason))
                    return {'result': 'skipped', 'reason': reason}
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
                    if identity in required:  # A required host is never silently skipped.
                        results[identity] = not_updated(identity, 'unreachable: %s' % host.reason)
                        errors.append('%s: unreachable: %s' % (identity, host.reason))
                return
            if hasattr(host, 'say') and host.say is None:
                host.say = say  # FallbackHost names the route it falls back to.
            try:
                result = roll_host(identity, host, version, worker_force, hold_minutes,
                                   worker_deadline, poll, clock, sleep, say, local_copies=local_copies,
                                   ignore_copies=ignore_folder_copies, channel_since=channel_since)
                route = getattr(host, 'route', None)
                if route:
                    result['route'] = route
                with lock:
                    results[identity] = result
            except RolloutDeferred as error:  # Its owner's setting, never a failure, required or not.
                say('%s: deferred: %s' % (identity, error))
                with lock:
                    results[identity] = update_policy.deferred_row(identity, str(error), getattr(host, 'route', None),
                                                                   app=error.app and (desktop is not None or desktop_skip))
                return
            except RolloutError as error:
                with lock:
                    results[identity] = not_updated(identity, str(error), route=getattr(host, 'route', None))
                    if identity in required:
                        errors.append(str(error))
                    else:
                        say('%s: not updated (optional): %s' % (identity, error))
                return
            except Exception as error:  # noqa: BLE001 - a host never drops out of the results unreported.
                reason = '%s stopped on an unexpected %s: %s' % (identity, type(error).__name__, error)
                with lock:
                    results[identity] = not_updated(identity, reason)
                    if identity in required:
                        errors.append(reason)
                return
            if desktop is not None:
                via_connect = getattr(host, 'route', None) == 'connect'
                if via_connect and not host.app_command:
                    say('%s: desktop app skipped: needs SSH (reached over SpecWithCode Connect)' % identity)
                    app = {'result': 'skipped', 'reason': 'needs SSH'}
                else:
                    app = update_app(identity, via_connect)
                with lock:
                    result['desktopApp'] = app
            elif desktop_skip:
                say('%s: desktop app skipped: %s' % (identity, desktop_skip))
                with lock:
                    result['desktopApp'] = {'result': 'skipped', 'reason': desktop_skip}

        threads = [threading.Thread(target=worker, args=(identity,), name='rollout-' + identity)
                   for identity in hosts if identity != LOCAL]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        missing = [identity for identity in required if identity != LOCAL and identity not in hosts]
        for identity in missing:  # A required machine absent from the inventory is not a pass.
            results[identity] = not_updated(identity, 'not in the fleet inventory')
            errors.append('%s: not in the fleet inventory' % identity)
        if errors:
            raise RolloutPartial('; '.join(sorted(errors) + sorted(app_errors)), results)
        if app_errors:
            raise DesktopAppsFailed('; '.join(sorted(app_errors)), results)
    return results


def plan_route(host):
    """How --dry-run would reach a host: its route and the commands for it."""
    if isinstance(host, Unreachable):
        return {'route': 'skipped', 'reason': host.reason}
    if isinstance(host, FallbackHost):
        return {'route': 'SpecWithCode Connect, then pinned SSH if unavailable', 'ssh': host.ssh.command,
                'connect': host.connect.command + [host.connect.machine, '...', '--connect-only', '--json']}
    if isinstance(host, ConnectHost):
        return {'route': 'SpecWithCode Connect', 'connect': host.command + [host.machine, '...', '--connect-only', '--json']}
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
    parser.add_argument('--require-all', action='store_true',
                        help='exit 1 when a required host was left for later (release.sh, before it finalizes)')
    # 5 s: at 15 s the poll itself was the longest single wait before the install request
    # (offer noticed up to 15 s late, then "installed" seen up to 15 s late again).
    parser.add_argument('--poll-seconds', type=int, default=5)
    parser.add_argument('--wait-for-idle', action='store_true',
                        default=os.environ.get('STUDIO_FLEET_WAIT_FOR_IDLE') == '1',
                        help='acquire a service-owned idle hold; never interrupt running work')
    parser.add_argument('--no-hold', action='store_true',
                        help="do not drain and hold M4's service first (a busy M4 then waits for its work)")
    parser.add_argument('--ignore-folder-copies', action='store_true',
                        help="drain and install on M4, and ask the workers, while M4 copies a folder to or "
                             "from another machine; the copy may need Retry")
    parser.add_argument('--no-desktop-apps', action='store_true',
                        help="leave M1's and M3's desktop apps as they are (by default each follows its service)")
    parser.add_argument('--ssh-fallback', action='store_true',
                        help='use pinned fleet SSH (hosts.json) for M1 and M3 when SpecWithCode Connect does not '
                             'answer, and for their desktop apps (release.sh: RELEASE_FLEET_SSH=1)')
    parser.add_argument('--dry-run', action='store_true', help='print the order and commands; contact no host')
    parser.add_argument('--optional', action='append', default=[], metavar='HOST',
                        help='a required host (%s) that may end not-updated without failing the run'
                             % ', '.join(REQUIRED_HOSTS))
    parser.add_argument('--reconcile', action='store_true',
                        help='M4 finalized VERSION some other way (Update now, its agent): bring the workers to it; '
                             'implies --only workers, and gives up at once when another rollout runs')
    parser.add_argument('--lock-wait-minutes', type=int, default=75,  # A reconcile's worker deadline (60) and then some.
                        help='how long to wait for another rollout to end (not with --reconcile)')
    parser.add_argument('--channel', choices=('github', 'candidate'), default='github',
                        help='candidate: the hosts install from the R2 candidate feed (release.sh canary and fleet)')
    parser.add_argument('--channel-since', metavar='X.Y.Z',
                        help='with --channel candidate: the first release whose update agent reads channel feeds')
    args = parser.parse_args(argv)
    since = _tuple(args.channel_since) if args.channel_since else None
    if (args.channel == 'candidate') != (since is not None):
        parser.error('--channel candidate needs --channel-since X.Y.Z, and --channel-since needs it')
    if args.reconcile and candidate_hold() == args.version:
        # M4 runs a release's candidate: the release's own fleet stage asks the workers after the soak.
        print(json.dumps({'version': args.version, 'result': 'candidate-held'}))
        return 0
    if args.reconcile:
        if args.only == LOCAL:
            parser.error('--reconcile updates the workers; it cannot be combined with --only m4')
        args.only = 'workers'
    required = tuple(name for name in REQUIRED_HOSTS if name not in args.optional)
    if args.wait_for_idle and args.no_hold:
        parser.error('--wait-for-idle cannot be combined with --no-hold')
    if _tuple(args.version) is None:
        parser.error('--version must be X.Y.Z')
    if not 1 <= args.hold_minutes <= update_request.HOLD_MAX_MINUTES:
        parser.error('--hold-minutes must be 1 to %d' % update_request.HOLD_MAX_MINUTES)
    if args.lock_wait_minutes < 0:
        parser.error('--lock-wait-minutes cannot be negative')
    if args.poll_seconds < 1 or args.m4_deadline_minutes < 1 or args.worker_deadline_minutes < 1:
        parser.error('deadlines and the poll interval must be positive')
    try:
        hosts = fleet(ssh_fallback=True) if args.ssh_fallback else fleet()
    except SystemExit as error:  # fleet_hosts reports a missing or bad inventory this way.
        print('fleet_rollout: %s' % error, file=sys.stderr)
        return 1
    desktop, desktop_skip = None, None
    if args.only != LOCAL and not args.no_desktop_apps and not args.ssh_fallback:
        desktop_skip = 'needs pinned fleet SSH (pass --ssh-fallback); its own updater installs %s on quit' % args.version
    elif args.only != LOCAL and not args.no_desktop_apps:
        try:
            desktop = desktop_app_rollout.DesktopApps(args.version, {
                name: host.app_command for name, host in hosts.items() if getattr(host, 'app_command', None)})
        except desktop_app_rollout.DesktopAppError as error:  # RELEASE_PUBLIC_REPO is not owner/name.
            print('fleet_rollout: %s' % error, file=sys.stderr)
            return 2
    hold = None if args.no_hold or args.only == 'workers' else ServiceHold()
    if hold is not None:
        hold.wait_for_idle = args.wait_for_idle
        hold.ignore_folder_copies = args.ignore_folder_copies
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
        print(json.dumps({'version': args.version, 'order': order, 'hold': planned, 'sshFallback': args.ssh_fallback,
                          'commands': {name: host.command for name, host in hosts.items()},
                          'routes': {name: plan_route(host) for name, host in hosts.items()},
                          'desktopApps': desktop.plan() if desktop else
                          {'skipped': desktop_skip} if desktop_skip else None}))
        return 0
    # An old M4 is refused in roll_host, after its status shows whether Update now already
    # asked for this version (then the rollout joins that install instead).
    lock, info = RolloutLock(lock_path()), {'version': args.version, 'only': args.only, 'reconcile': args.reconcile}
    try:
        try:
            lock.acquire(0 if args.reconcile else args.lock_wait_minutes * 60, info=info, say=Printer())
        except RolloutLocked as error:
            # Only a run that asks the workers for this same version covers them. An M4-only run (its
            # agent finalizing is what started this reconcile), a run for another version, or a holder
            # not yet named: wait for it rather than leave the workers behind.
            if not args.reconcile or covers(error.holder, args.version):
                raise
            lock.acquire(RECONCILE_WAIT, info=info, say=Printer())
    except RolloutLocked as error:
        print('fleet_rollout: %s' % error, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'locked', 'holder': error.holder}))
        return 0 if args.reconcile else 1
    try:  # M4's own "Pause running work for updates": off or unread, it is held only when idle; off, deferrable.
        if hold is not None and not args.wait_for_idle and not update_policy.allows_pause(policy := update_policy.service_policy(hold)):
            hold.wait_for_idle, hold.pause_work = True, False if policy == update_policy.OFF else None
            Printer()(update_policy.m4_idle_only(policy, args.m4_deadline_minutes))
        if since is not None and args.only in ('all', LOCAL):
            candidate_hold(args.version)
        results = rollout(args.version, hosts, args.only, args.hold_minutes, args.m4_deadline_minutes * 60,
                          args.worker_deadline_minutes * 60, args.worker_force, args.poll_seconds, hold=hold,
                          desktop=desktop, local_copies=local_folder_copies,
                          ignore_folder_copies=args.ignore_folder_copies, required=required,
                          m4_wait=RECONCILE_WAIT if args.reconcile else 0, desktop_skip=desktop_skip,
                          channel_since=since)
        if since is not None and args.only in ('all', 'workers') and candidate_hold() == args.version:
            candidate_hold(clear=True)
    except RolloutPartial as error:
        lines = report(args.version, error.results, required)
        print('fleet_rollout: %s' % error, file=sys.stderr)
        for line in lines:
            print('fleet_rollout: not updated: %s' % line, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': update_policy.summary_result(error.results, 'partial'),
                          'error': str(error), 'hosts': error.results,
                          'notUpdated': lines}))
        return 1
    except DesktopAppsFailed as error:
        print('fleet_rollout: every service is on %s, but %s' % (args.version, error), file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error), 'hosts': error.results}))
        return 1
    except RolloutError as error:
        print('fleet_rollout: %s' % error, file=sys.stderr)
        print(json.dumps({'version': args.version, 'result': 'failed', 'error': str(error)}))
        return 1
    finally:
        lock.release()
    lines = report(args.version, results, required)
    for line in lines:  # Optional hosts only: a required one raised.
        print('fleet_rollout: not updated: %s' % line, file=sys.stderr)
    print(json.dumps({'version': args.version, 'result': update_policy.summary_result(results, 'installed'),
                      'hosts': results, 'notUpdated': lines}))
    if (later := update_policy.left_for_later(results, required) if args.require_all else []):
        print('fleet_rollout: %s' % update_policy.require_all(later, args.version), file=sys.stderr)
    return 1 if later else 0


if __name__ == '__main__':
    sys.exit(main())
