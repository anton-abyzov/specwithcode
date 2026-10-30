"""The fake fleet, clock and M4 hold that test-fleet-rollout.py and the rollout tests beside it drive
fleet_rollout with. A test support module, not a test: run-tests.sh runs only test-*.py.
"""
import datetime
import threading
import time

import fleet_rollout
import update_request

OLD, NEW = '1.0.40', '1.0.41'


class Clock(object):
    """Shared fake time; sleep advances it and yields so worker threads interleave."""

    def __init__(self):
        self.now = 1_000_000.0
        self.lock = threading.Lock()

    def __call__(self):
        with self.lock:
            return self.now

    def sleep(self, seconds):
        with self.lock:
            self.now += seconds
        time.sleep(0.001)


class Fleet(object):
    """Fake hosts. A host installs once it was asked and `polls` more status reads passed, and
    only when `ready(identity)` allows it. Every call is logged in order; a request is dated by
    the fake clock, as update_request dates it by the host's."""

    def __init__(self, clock, polls=None, ready=None):
        self.clock = clock
        self.lock = threading.Lock()
        self.log = []
        self.version = {name: OLD for name in ('m4', 'm1', 'm3')}
        self.asked = {}
        self.written = {name: [] for name in self.version}  # Each request's installRequestedAt.
        self.left = dict(polls or {})
        self.ready = ready or (lambda fleet, identity: True)
        self.status = {name: 'waiting-for-quiet' for name in self.version}
        self.message = {name: 'Waiting for running tasks (2 running tasks)' for name in self.version}
        self.available = {}
        self.downloaded = {}

    def host(self, identity):
        def call(argv):
            assert argv[:3] == [argv[0], '--identity', identity], argv
            with self.lock:
                stamp = update_request._iso(datetime.datetime.fromtimestamp(self.clock(), datetime.timezone.utc))
                if argv[0] == 'cancel':
                    self.log.append((identity, 'cancel', self.version[identity], list(argv)))
                    return {'identity': identity, 'result': 'cancelled'}
                if argv[0] == 'check':
                    self.log.append((identity, 'check', self.version[identity], list(argv)))
                    return {'identity': identity, 'result': 'check-requested', 'kicked': True,
                            'request': {'checkRequestedAt': stamp}}
                if argv[0] == 'request':
                    self.asked[identity] = list(argv)
                    self.log.append((identity, 'request', self.version[identity], list(argv)))
                    self.written[identity].append(stamp)
                    return {'identity': identity, 'result': 'requested', 'kicked': True,
                            'request': {'installRequestedAt': stamp}}
                if identity in self.asked and self.version[identity] != NEW and self.ready(self, identity):
                    remaining = self.left.get(identity, 1)
                    if remaining <= 0:
                        self.version[identity] = NEW
                    self.left[identity] = remaining - 1
                self.log.append((identity, 'status', self.version[identity], list(argv)))
                return {'identity': identity, 'version': self.version[identity],
                        'installFinalized': self.version[identity] == NEW,
                        'status': 'installed' if self.version[identity] == NEW else self.status[identity],
                        'message': None if self.version[identity] == NEW else self.message[identity],
                        'downloadedVersion': self.downloaded.get(identity, NEW),
                        'availableVersion': self.available.get(identity, NEW)}
        return call

    def hosts(self):
        return {name: self.host(name) for name in ('m4', 'm1', 'm3')}

    def calls(self, identity, kind):
        return [entry for entry in self.log if entry[0] == identity and entry[1] == kind]


def quiet(_line):
    pass


HELD = {'idle': True, 'stoppedThreads': 1, 'interruptedRuns': 1, 'openTerminals': 0, 'blockers': [],
        'held': True, 'holdUntil': '2026-10-16T12:15:00.000Z', 'holdReason': 'install'}


class FakeHold(object):
    """M4's ServiceHold. Each drain and release is logged in the fleet's log, in order with the
    requests, as ('m4', 'hold' | 'release', version, [])."""

    def __init__(self, fleet, reply=None, error=None, release_error=None, unsupported=None):
        self.fleet = fleet
        self.reply = dict(HELD if reply is None else reply)
        self.error = error
        self.release_error = release_error
        self.unsupported = unsupported  # The reason ServiceHold.support() gives for an old CLI.
        self.copies = 0  # Folder copies M4's heartbeat reports (ServiceHold.folder_copies).
        self.counted = 0  # Folder copies M4's service counts (ServiceHold.counted_copies).

    def folder_copies(self):
        return self.copies

    def counted_copies(self):
        self._log('count')
        return self.counted

    def support(self):
        return (False, self.unsupported) if self.unsupported else (True, None)

    def _log(self, kind):
        with self.fleet.lock:
            self.fleet.log.append(('m4', kind, self.fleet.version['m4'], []))

    def prepare(self):
        self._log('hold')
        if self.error:
            raise fleet_rollout.HoldUnavailable(self.error)
        return dict(self.reply)

    def release(self):
        self._log('release')
        if self.release_error:
            raise fleet_rollout.HoldUnavailable(self.release_error)
        return {'idle': True, 'stoppedThreads': 0, 'blockers': [], 'held': False}


def kinds(fleet, identity='m4'):
    """The calls made to one host, in order, without status reads."""
    return [entry[1] for entry in fleet.log if entry[0] == identity and entry[1] != 'status']
