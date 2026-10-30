"""updates/run.json: the one record of an Update now press, and the agent's side of it (0988).

The desktop creates the record (O_EXCL, keyed by runId) when a person presses Update now, and
mirrors the request into config.json with `installRunId`. A pass of the update agent claims the
run when config.json names it and asks for the same request; while it owns the run a heartbeat
thread renews `leaseUntil` every HEARTBEAT_SECONDS, also while the detached install helper runs.
The pass mirrors its status into `phase`, ends the run as `verified`, `failed` or `cancelled`
when it decides the request (`cancelled` also when a request for a newer release replaced it, as no
pass takes the run on again), and otherwise lets go of it (owner null, lease now) so a later pass
or the desktop's re-kick can take it on. The run's `deadlineAt` is the one clock of a run-era
request: it replaces the forced retry window and the request TTL. A request for the same release that
the pass takes on while it owns a run (the fleet's or the CLI's) is served by its own TTL, a forced one
also by its own window (installHoldUntil, which the service's hold follows), a plain one as long as the
press's hold times it, and the run ends with that pass.

`runSupport` in state.json tells the desktop this agent understands run records; an older agent
rewriting state.json drops the key, so the desktop falls back to today's path on its own.

Every write replaces the whole file, bumps `rev` and never overwrites a terminal record. Also
holds the pass lock and the service log rotation, moved here from update_agent.py (file-size
cap), the pass's own phase timings (Timings): `agentTimings` in run.json, and in the apply
helper's environment (TIMINGS_ENV), which install-progress.json and the update receipt copy,
and the disk priority the agent gives the helpers a person waits for (normal_disk_io).
Stdlib only and Python 3.9 compatible, like the agent it is installed beside.
"""
import datetime
import errno
import fcntl
import json
import os
import stat
import sys
import threading
import time
import uuid

RUN_SUPPORT = 1
SCHEMA_VERSION = 1
FILE = 'run.json'
HEARTBEAT_SECONDS = 5
LEASE = datetime.timedelta(seconds=90)
LIVE = ('preparing', 'requested', 'downloading', 'waiting', 'installing')
TERMINAL = ('verified', 'failed', 'cancelled', 'expired')
# The message of a run whose request a request for a newer release replaced (update_agent_recovery.withdrawn).
REPLACED = 'A request to install SpecWithCode %s replaced this one.'
# The agent status a pass sets, as the run's phase while the pass owns it.
PHASE_OF = {'downloading': 'downloading', 'downloaded': 'downloading', 'waiting-for-quiet': 'waiting',
            'installing': 'installing'}
RUN_ID_LIMIT = 64
# launchd's StandardOutPath and StandardErrorPath for the service grow forever otherwise
# (52 MB seen); past the limit the newest SERVICE_LOG_KEPT bytes move to <name>.1.
SERVICE_LOG_LIMIT = 16 << 20
SERVICE_LOG_KEPT = 8 << 20
# Read by install_progress.agent_timings in the helper the agent runs for an apply.
TIMINGS_ENV = 'STUDIO_UPDATE_AGENT_TIMINGS'


def _ua(agent):
    return sys.modules[type(agent).__module__]


def valid_run_id(value):
    return isinstance(value, str) and 0 < len(value) <= RUN_ID_LIMIT and all(
        character.isalnum() or character == '-' for character in value)


def stamp(line, moment=None):
    """A pass's log line with the time it was written: agent.log had none (22 untimed lines)."""
    moment = moment or datetime.datetime.now(datetime.timezone.utc)
    return '%s %s' % (moment.strftime('%Y-%m-%dT%H:%M:%SZ'), line)


def path(agent):
    return agent.updates / FILE


def load(agent):
    """The run record, or None when there is none or it is not one this agent understands."""
    ua = _ua(agent)
    target = path(agent)
    if not os.path.lexists(str(target)):
        return None
    try:
        record = ua.read_json(target, agent.home, 1 << 20)
    except ua.AgentError:
        return None
    if not (isinstance(record, dict) and record.get('schemaVersion') == SCHEMA_VERSION
            and valid_run_id(record.get('runId')) and type(record.get('rev')) is int
            and record.get('phase') in LIVE + TERMINAL and ua.parse_time(record.get('deadlineAt'))):
        return None
    return record


class Run(object):
    """The run this pass owns. Writes are serialized with the heartbeat thread."""

    def __init__(self, agent, record):
        self.agent = agent
        self.ua = ua = _ua(agent)
        self.run_id = record['runId']
        self.requested_at = record.get('requestedAt')
        self.target = record.get('targetVersion')
        self.deadline = ua.parse_time(record['deadlineAt'])
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.thread = None
        self.lost = False  # Replaced or ended by someone else: never written again.

    def write(self, change):
        """Re-read the record and apply `change` to it; False once it is no longer ours to write."""
        ua = self.ua
        with self.lock:
            if self.lost:
                return False
            current = load(self.agent)
            if current is None or current['runId'] != self.run_id or current['phase'] in TERMINAL:
                self.lost = True
                return False
            change(current)
            current['rev'] = current['rev'] + 1
            try:
                ua.write_json(path(self.agent), current, self.agent.home)
            except (OSError, ua.AgentError):
                return False
            return True

    def renew(self, record):
        now = self.ua.utcnow()
        record['heartbeatAt'] = self.ua.iso(now)
        record['leaseUntil'] = self.ua.iso(now + LEASE)

    def beat(self):
        while not self.stopped.wait(HEARTBEAT_SECONDS):
            if not self.write(self.renew):
                return

    def start(self):
        self.thread = threading.Thread(target=self.beat, name='run-heartbeat', daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(HEARTBEAT_SECONDS + 1)

    def mirror(self, status, message):
        phase = PHASE_OF.get(status)

        def change(record):
            if phase:
                record['phase'] = phase
            record['message'] = message
            self.renew(record)
        self.write(change)


class Timings(object):
    """Whole milliseconds per phase of one install pass, the shape of update.py's `timings`: a lap
    books the time since the last one to the phase that ended, and `total` is the pass so far. The
    1.0.71 install spent 214 s in the agent before its helper started, and nothing showed where.
    Phases, in order: beforeInstall (the check, download and verification), verifyHelpers, snapshot
    and retryWait (every snapshot attempt, and the waits and reaps between them), apply (the
    helper). `requestWait` is how long the install request waited for this pass, not in `total`."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.started = self.last = clock()
        self.values = {}

    def lap(self, phase):
        moment = self.clock()
        self.values[phase] = self.values.get(phase, 0) + int(round((moment - self.last) * 1000))
        self.values['total'] = int(round((moment - self.started) * 1000))
        self.last = moment


# A check this recent that found the very release an install request is bound to answers a check
# request pending beside it: the pass installs what the person was shown without asking GitHub
# again (beforeInstall took 1.1-1.7 s with a discovery on M4, 1.0.119-1.0.126).
FRESH_CHECK = datetime.timedelta(minutes=10)


def fresh_check(agent, meta, wanted):
    ua = _ua(agent)
    checked, now = ua.parse_time(agent.state.get('checkedAt')), ua.utcnow()
    return (meta is not None and wanted is not None and wanted == meta.get('version') and checked is not None
            and now - FRESH_CHECK <= checked <= now + datetime.timedelta(minutes=1))


def lap(agent, phase, install_request=False):
    """Ends `phase` of this pass and mirrors the timings into its run. The first lap of an install
    request also records how long that request waited for this pass. Never raises."""
    ua = _ua(agent)
    timings = getattr(agent, 'timings', None)
    if timings is None:
        timings = agent.timings = Timings()
    requested = ua.parse_time(agent.config.get('installRequestedAt')) if install_request else None
    if requested is not None and 'requestWait' not in timings.values:
        waited = (ua.utcnow() - requested).total_seconds() - (timings.clock() - timings.started)
        timings.values['requestWait'] = max(0, int(round(waited * 1000)))
    timings.lap(phase)
    run = getattr(agent, 'run', None)
    if run is not None:
        run.write(lambda record: record.update(agentTimings=dict(timings.values)))


def apply_env(agent):
    """The helper environment for an apply: helper_env plus this pass's timings so far."""
    timings = getattr(agent, 'timings', None)
    return dict(agent.helper_env(), **{TIMINGS_ENV: json.dumps(timings.values if timings else {}, sort_keys=True)})


def claim(agent):
    """Take on the run config.json names, when it asks for this same request and nobody else
    holds a fresh lease on it. None otherwise: the pass then runs as it did before runs."""
    ua = _ua(agent)
    run_id = agent.config.get('installRunId')
    if not valid_run_id(run_id):
        return None
    record = load(agent)
    if record is None or record['runId'] != run_id or record['phase'] in TERMINAL \
            or record.get('requestedAt') is None or record.get('requestedAt') != agent.config.get('installRequestedAt'):
        return None
    owner, lease = record.get('owner'), ua.parse_time(record.get('leaseUntil'))
    if isinstance(owner, dict) and owner.get('pid') != os.getpid() and lease is not None and lease > ua.utcnow():
        return None
    run = Run(agent, record)
    now = ua.iso(ua.utcnow())

    def take(current):
        current['owner'] = {'kind': 'agent', 'pid': os.getpid(), 'agentVersion': ua.AGENT_VERSION, 'claimedAt': now}
        if current['phase'] in ('preparing', 'requested'):
            current['phase'] = 'requested'
        run.renew(current)
    if not run.write(take):
        return None
    run.start()
    return run


def retry_until(agent, own=None):
    """Until when a pass retries the request it serves, whose own window ends at `own`. A pass that owns a
    run retries the run's request until the run's deadline, its one clock; a request it took on since (the
    fleet's or the CLI's, for the same release) keeps its own window, the one the service's hold follows for
    a forced request (installHoldUntil). The hold times a plain one from its own start, HOLD_TTL_MS
    (ServiceUpdateHold.ts, FORCE_WINDOW here), and reads a waiting-for-quiet as the give-up only from then
    on: the press's drain took it just before the run's request was written, so the pass retries a plain
    request until FORCE_WINDOW after that, past its own 2 minutes, and the hold ends with the pass.
    An older update_agent.py (1.0.69 on) asks with no `own` and gets the run's deadline for any request: an
    install cut off after this module was written (install_launch_agent writes update_agent.py last) runs one."""
    run = getattr(agent, 'run', None)
    if run is None:
        return own
    if own is None or agent.config.get('installRequestedAt') == run.requested_at:
        return run.deadline
    pressed = _ua(agent).parse_time(run.requested_at)
    if agent.config.get('installMode') != 'force' and pressed is not None:
        return max(own, pressed + _ua(agent).FORCE_WINDOW)
    return own


def ttl_until(agent):
    """When the request the pass serves lapses, or None for REQUEST_TTL after it was written: the run's
    deadline for the run's request, and None for one the pass took on since, as for any request."""
    run = getattr(agent, 'run', None)
    if run is not None and run.requested_at == agent.config.get('installRequestedAt'):
        return run.deadline
    return None


def outcome(agent, run):
    """The terminal phase this pass decided, with its message, or (None, None) when the run goes on."""
    ua = _ua(agent)
    state = agent.state
    status, message = state.get('status'), state.get('message')
    if os.path.lexists(str(agent.marker_path)):
        return None, None  # The helper still runs (apply timed out): a later pass settles it.
    if message == ua.CANCELLED:
        return 'cancelled', message
    if status in ('error', 'manual-required'):
        return 'failed', message
    installed = ua.version_tuple(state.get('installedVersion'))
    wanted = ua.version_tuple(run.target)
    if installed is not None and wanted is not None and installed >= wanted:
        return 'verified', message
    newer = getattr(agent, 'newer_release', None)  # config.json names that request now, not this run.
    # Only a newer release replaces it: an older update_agent.py's run_once keeps the value its pass before set.
    if newer and (ua.version_tuple(newer) or ()) > (wanted or ()):
        return 'cancelled', REPLACED % newer
    handled = state.get('handledInstallRequestAt') == run.requested_at
    late = ua.utcnow() + datetime.timedelta(seconds=ua.RETRY_SECONDS) >= run.deadline
    # config.json names a request the pass took on since (the fleet's or the CLI's): no later pass claims the run.
    taken_on = agent.config.get('installRequestedAt') != run.requested_at
    if handled or late or taken_on:
        return 'failed', message or 'SpecWithCode %s did not install.' % run.target
    return None, None


def release(agent):
    """End the pass's hold on its run: terminal when the pass decided it, else ownerless."""
    ua = _ua(agent)
    run = getattr(agent, 'run', None)
    if run is None:
        return
    agent.run = None
    run.stop()
    phase, message = outcome(agent, run)
    last = agent.state.get('lastInstall') or {}
    now = ua.iso(ua.utcnow())

    def end(record):
        record['owner'] = None
        record['leaseUntil'] = now
        if phase is None:
            return
        record['phase'] = phase
        record['message'] = message
        record['endedAt'] = now
        if last.get('version') == run.target and isinstance(last.get('receipt'), str):
            record['receipt'] = last['receipt']
    run.write(end)
    if phase in ('failed', 'cancelled') and agent.config.get('installRequestedAt') == run.requested_at \
            and agent.state.get('handledInstallRequestAt') != run.requested_at:
        # An ended run's request never installs later, at some idle moment nobody asked for. One the pass
        # took on since (update_agent_recovery.withdrawn) keeps the outcome the pass gave it.
        agent.state['handledInstallRequestAt'] = run.requested_at
        try:
            agent.save()
        except (OSError, ua.AgentError):
            pass


# ---------------------------------------------------------------- moved from update_agent.py

def acquire_lock(path):
    """The pass lock's fd, held exclusively, or None while another pass (or its helper) holds it."""
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(fd)
        if error.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
            return None
        raise
    return fd


def rotate_service_log(path, limit=SERVICE_LOG_LIMIT, kept=SERVICE_LOG_KEPT):
    """Bounds a log launchd appends to. Over `limit`, its newest `kept` bytes (from the first
    whole line) replace <name>.1, written privately and never through a link, and the live
    file is truncated in place: launchd opened it with O_APPEND, so the service's next write
    lands at the new end. A disk too full for <name>.1 still truncates the live file. Returns
    True when it truncated; never raises."""
    try:
        fd = os.open(str(path), os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= limit:
            return False
        start = max(0, info.st_size - kept)
        os.lseek(fd, start, os.SEEK_SET)
        chunks, left = [], info.st_size - start
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        tail = b''.join(chunks)
        if start and b'\n' in tail:
            tail = tail.split(b'\n', 1)[1]  # The cut line's end alone would mislead a reader.
        older = path.with_name(path.name + '.1')
        temporary = path.with_name('%s.1.rotate-%s' % (path.name, uuid.uuid4().hex))
        try:
            out = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(out, 'wb') as handle:
                    handle.write(tail)
                os.replace(str(temporary), str(older))  # Replaces a link at .1 itself, never its target.
            finally:
                if os.path.lexists(str(temporary)):
                    os.unlink(str(temporary))
        except OSError as error:
            # A full disk is when the bound matters most: drop the tail, keep the old .1.
            if error.errno not in (errno.ENOSPC, errno.EDQUOT):
                raise
        os.ftruncate(fd, 0)
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


# ---------------------------------------------------------------- helper disk priority

# sys/resource.h: the process-wide disk I/O policy. launchd's LowPriorityIO, which the agent runs
# under, sets IOPOL_THROTTLE (3), and children inherit it; the helper records its own in the
# update receipt (install_progress.disk_io_policy, `diskIoPolicy`).
IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_DEFAULT = 0, 0, 0


def _setiopolicy():
    """libc's setiopolicy_np, looked up in the agent itself: a child between fork and exec
    must not load a library or look up a symbol. None off macOS."""
    try:
        import ctypes
        return ctypes.CDLL(None).setiopolicy_np
    except (ImportError, OSError, AttributeError):
        return None


_SET_IOPOLICY = _setiopolicy()


def normal_disk_io():
    """In a child before exec: the default disk I/O policy in place of the inherited throttle.
    Best effort, like leaving darwin background: a child never fails to start over it."""
    try:
        if _SET_IOPOLICY is not None:
            _SET_IOPOLICY(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_DEFAULT)
    except Exception:
        pass
