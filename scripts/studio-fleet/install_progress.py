#!/usr/bin/env python3
"""updates/install-progress.json: what update.py is doing right now, for the desktop and phones.

The 1.0.65 install on M4 ran 13.5 minutes behind one static "Installing" line. While it applies a
release, update.py now keeps this file current: the phase it is in, step i of n, when that phase
began, a heartbeat at least every HEARTBEAT_SECONDS, the phase timings so far, how long the last
install took (expectedMs, the total of the newest earlier verified install), when the service was
restarted, the update agent's own timings before this apply (agentTimings), and, once it ends, the result: `verified`, `refused` (the old service never stopped:
any pointer moved was put back), `rolled-back` (the old release runs again after a restart: the
new one failed its checks, or the stop, copy or start failed), `held` (the rollback stopped on a
check) or `failed`. While a failed apply puts things back, `phase` is `rollback`. A helper killed
outright leaves `result` null and a heartbeat that stops moving.

Every write is a new 0600 file, fsynced, renamed over the old one: a reader sees a whole record
or the previous one, never part of one. Only update.py writes it; nothing in it is read back by
the update itself. Stdlib only.
"""
import datetime
import json
import os
import pathlib
import threading
import uuid

FILE = 'install-progress.json'
SCHEMA_VERSION = 1
HEARTBEAT_SECONDS = 5
# The phases of an apply, in order (update._apply's laps; each lap names the phase that ended).
# A phase that does not run on this install (a skipped re-read) is simply passed over.
PHASES = ('beforeRead', 'backupSpace', 'verifyAndStage', 'prestateCheck', 'swapPointers', 'gateSettle',
          'checkBeforeRestart', 'stop', 'finalCheck', 'serviceStop', 'backupClone', 'restart',
          'readinessCheap', 'readiness', 'guardedComparison', 'cleanup')
# Not one of PHASES' steps: entered from whichever phase failed, until the failure receipt is final.
ROLLBACK = 'rollback'
RESULTS = {'verified', 'refused', 'rolled-back', 'held', 'failed'}
# The agent's phase timings before the apply (update_agent_run.Timings, its TIMINGS_ENV).
AGENT_TIMINGS_ENV = 'STUDIO_UPDATE_AGENT_TIMINGS'


def agent_timings(environ=None):
    """The update agent's whole-millisecond phase timings for this apply; {} from an agent that
    passes none, or passes anything but a small object of names to whole milliseconds."""
    text = (os.environ if environ is None else environ).get(AGENT_TIMINGS_ENV, '')
    try:
        value = json.loads(text) if 0 < len(text) <= 4096 else {}
    except ValueError:
        return {}
    if not isinstance(value, dict) or len(value) > 32 or not all(
            isinstance(name, str) and len(name) <= 64 and type(ms) is int and ms >= 0 for name, ms in value.items()):
        return {}
    return value


def disk_io_policy():
    """This helper's disk I/O policy, for the update receipt (`diskIoPolicy`): getiopolicy_np's
    IOPOL_DEFAULT (0) when the agent lifted its LowPriorityIO throttle (3) for this apply
    (update_agent_run.normal_disk_io), None where it cannot be read."""
    try:
        import ctypes
        value = ctypes.CDLL(None).getiopolicy_np(0, 0)  # IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS
    except (ImportError, OSError, AttributeError):
        return None
    return value if value >= 0 else None


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def write_atomic(path, value):
    """`value` as JSON in a new 0600 file, fsynced and renamed over `path`."""
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write((json.dumps(value, indent=2) + '\n').encode())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(path))
    finally:
        if os.path.lexists(str(temporary)):
            os.unlink(str(temporary))


def expected_ms(receipts, current=None):
    """`timings.total` of the newest earlier verified update receipt, else None. A refusal or a
    rollback took another time than an install, and the prestate-*.json files are no receipts."""
    try:
        candidates = sorted((path for path in pathlib.Path(receipts).glob('update-*.json')
                             if path.is_file() and not path.is_symlink() and path != current),
                            key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        return None
    for path in candidates[:50]:
        try:
            if path.stat().st_size > 16 << 20:
                continue
            receipt = json.loads(path.read_text())
            if receipt.get('phase') != 'verified':
                continue
            total = (receipt.get('timings') or {}).get('total')
        except (OSError, ValueError, AttributeError):
            continue
        if type(total) is int and total > 0:
            return total
    return None


def result_of(failure):
    """The progress result for update._apply's failure receipt."""
    rollback = failure.get('rollback')
    if rollback == 'restored-runtime-pointers-and-state':
        return 'rolled-back'
    if rollback == 'restored-exact-owned-runtime-pointers':
        # The old service never stopped: a refusal the agent may retry. Once it stopped (for the
        # copy), it was started again, which every client connection noticed.
        return 'refused' if failure.get('phase') in ('prepared', 'pointers-written') \
            and not failure.get('serviceStopped') else 'rolled-back'
    return 'held'


class ProgressWriter:
    """Writes `<updates>/install-progress.json` for one apply. Never raises from a write: progress
    is for people to read, and a failed write never fails or slows an update."""

    def __init__(self, updates, version=None, receipt=None, heartbeat_seconds=HEARTBEAT_SECONDS):
        self.path = pathlib.Path(updates) / FILE
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.heartbeat_seconds = heartbeat_seconds
        self.errors = 0
        receipt = pathlib.Path(receipt) if receipt is not None else None
        self.record = {'schemaVersion': SCHEMA_VERSION, 'version': version,
                       'receipt': str(receipt) if receipt is not None else None,
                       'phase': PHASES[0], 'step': 1, 'steps': len(PHASES), 'phaseStartedAt': now(),
                       'heartbeatAt': now(), 'expectedMs': expected_ms(receipt.parent, receipt) if receipt else None,
                       'timings': {}, 'agentTimings': agent_timings(), 'serviceRestartedAt': None, 'result': None}
        self.thread = None

    def start(self):
        try:
            self.path.parent.mkdir(mode=0o700, exist_ok=True)
        except OSError:
            self.errors += 1
        self._write()
        self.thread = threading.Thread(target=self._beat, name='install-progress-heartbeat', daemon=True)
        self.thread.start()
        return self

    def _beat(self):
        while not self.stopped.wait(self.heartbeat_seconds):
            self._write()

    def _write(self, **fields):
        with self.lock:
            self.record.update(fields)
            self.record['heartbeatAt'] = now()
            try:
                write_atomic(self.path, self.record)
            except OSError:
                self.errors += 1

    @property
    def finished(self):
        return self.record['result'] is not None

    def set(self, **fields):
        """Fields known later in the apply (the release version, when the service restarted)."""
        if not self.finished:
            self._write(**fields)

    def lap(self, ended, timings):
        """The phase `ended` is done: the next one in PHASES begins (update._apply's lap). A lap
        outside PHASES (watermarkSkip, deltaRead) keeps the step but moves
        `phaseStartedAt` too, so `phaseStartedAt` minus the sum of `timings` stays the apply's start."""
        if self.finished:
            return
        index = PHASES.index(ended) + 1 if ended in PHASES else None
        fields = {'timings': dict(timings), 'phaseStartedAt': now()}
        if index is not None and index < len(PHASES):
            fields.update(phase=PHASES[index], step=index + 1)
        self._write(**fields)

    def rollback(self):
        """The apply failed and is putting things back (update._apply's failure path)."""
        self.set(phase=ROLLBACK, phaseStartedAt=now())

    def finish(self, result, timings=None):
        """The final record; later calls change nothing. Stops the heartbeat."""
        assert result in RESULTS
        if self.finished:
            return
        fields = {'result': result}
        if timings is not None:
            fields['timings'] = dict(timings)
        self._write(**fields)
        self.stop()

    def stop(self):
        self.stopped.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(timeout=10)

    def __enter__(self):
        return self.start()

    def __exit__(self, kind, error, traceback):
        # update._apply finishes the record itself once pointers may have moved. What is left is a
        # refusal before any write (a prestate check, staging, the version gate) or a crash.
        if not self.finished:
            phase = self.record['phase']
            early = phase in PHASES and PHASES.index(phase) <= PHASES.index('swapPointers')
            self.finish('refused' if error is not None and early else 'failed')
        self.stop()
        return False


class Unwritten:
    """A ProgressWriter that writes nothing, for an apply run without one."""
    def set(self, **fields):
        pass

    def lap(self, ended, timings):
        pass

    def rollback(self):
        pass

    def finish(self, result, timings=None):
        pass


UNWRITTEN = Unwritten()
