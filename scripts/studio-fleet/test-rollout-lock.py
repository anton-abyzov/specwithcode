#!/usr/bin/env python3
"""One fleet rollout at a time: a second run waits or, as a reconcile, gives up with `locked`, so no
host gets two install requests; a lock left by a dead process is taken again (increment 1239, AC-06).

Run: cd scripts/studio-fleet && python3 -B test-rollout-lock.py
"""
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fleet_rollout  # noqa: E402
from rollout_test_fakes import NEW, Clock, Fleet, quiet  # noqa: E402

HOLD = """
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
os.write(fd, sys.argv[2].encode() % os.getpid())
print('held', flush=True)
time.sleep(60)
"""


class Lock(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.dir.name) / 'updates' / fleet_rollout.LOCK_NAME
        self.path.parent.mkdir()

    def tearDown(self):
        self.dir.cleanup()

    @contextlib.contextmanager
    def other_holder(self, only='workers', version=NEW):
        info = '{"pid": %%d, "version": "%s", "only": "%s"}' % (version, only)
        child = subprocess.Popen([sys.executable, '-c', HOLD, str(self.path), info], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'held')
            yield child
        finally:
            child.kill()
            child.wait()
            child.stdout.close()

    def test_second_run_waits_then_gives_up_and_names_the_holder(self):
        clock = Clock()
        with self.other_holder() as child:
            lock = fleet_rollout.RolloutLock(self.path, clock=clock, sleep=clock.sleep)
            with self.assertRaises(fleet_rollout.RolloutLocked) as caught:
                lock.acquire(wait=120, poll=10)
            self.assertEqual(caught.exception.holder['pid'], child.pid)
            self.assertGreaterEqual(clock() - 1_000_000.0, 120)  # It waited the whole time.

    def test_lock_left_by_a_dead_process_is_taken(self):
        with self.other_holder():
            pass  # Killed: the file stays, naming a dead pid.
        self.assertIn('"pid"', self.path.read_text())
        lock = fleet_rollout.RolloutLock(self.path).acquire(wait=0)
        try:
            self.assertEqual(json.loads(self.path.read_text())['pid'], os.getpid())
        finally:
            lock.release()

    def test_reconcile_while_a_release_runs_sends_no_request(self):
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        out = io.StringIO()
        with self.other_holder(), \
                mock.patch.object(fleet_rollout, 'fleet', lambda: fleet.hosts()), \
                mock.patch.object(fleet_rollout, 'lock_path', lambda: self.path), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fleet_rollout.main(['--version', NEW, '--reconcile', '--no-desktop-apps'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue().strip().splitlines()[-1])['result'], 'locked')
        self.assertEqual(fleet.asked, {})
        self.assertEqual(fleet.log, [])  # Not even a status read.

    def reconcile_behind(self, only, version):
        """A reconcile behind another holder, with a fake clock: True when it waited for that holder."""
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        waited = []
        real = fleet_rollout.RolloutLock.acquire

        def acquire(lock, wait=0, poll=10, info=None, say=None):
            waited.append(wait)
            lock.clock, lock.sleep = clock, clock.sleep
            return real(lock, wait, poll, info, None)
        with self.other_holder(only=only, version=version), \
                mock.patch.object(fleet_rollout, 'fleet', lambda: fleet.hosts()), \
                mock.patch.object(fleet_rollout, 'lock_path', lambda: self.path), \
                mock.patch.object(fleet_rollout.RolloutLock, 'acquire', acquire), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fleet_rollout.main(['--version', NEW, '--reconcile', '--no-desktop-apps'])
        self.assertEqual(fleet.asked, {})  # The holder never let go in this test.
        return waited == [0, fleet_rollout.RECONCILE_WAIT]

    def test_reconcile_waits_for_an_m4_only_run(self):
        self.assertTrue(self.reconcile_behind('m4', NEW))

    def test_reconcile_waits_for_a_run_of_another_version(self):
        self.assertTrue(self.reconcile_behind('workers', '1.0.39'))

    def test_reconcile_trusts_a_workers_run_of_this_version(self):
        self.assertFalse(self.reconcile_behind('all', NEW))

    def test_unnamed_holder_does_not_count_as_covering(self):
        self.assertFalse(fleet_rollout.covers(None, NEW))
        self.assertFalse(fleet_rollout.covers({}, NEW))

    def test_release_run_waits_for_the_lock_and_fails_when_it_stays(self):
        fleet = Fleet(Clock())
        out = io.StringIO()
        with self.other_holder(), \
                mock.patch.object(fleet_rollout, 'fleet', lambda: fleet.hosts()), \
                mock.patch.object(fleet_rollout, 'lock_path', lambda: self.path), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fleet_rollout.main(['--version', NEW, '--only', 'workers', '--no-desktop-apps',
                                       '--lock-wait-minutes', '0'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue().strip().splitlines()[-1])['result'], 'locked')
        self.assertEqual(fleet.asked, {})

    def test_two_rollouts_one_after_the_other_each_get_the_lock(self):
        for _ in range(2):
            lock = fleet_rollout.RolloutLock(self.path).acquire(wait=0, info={'version': NEW})
            self.assertEqual(json.loads(self.path.read_text())['version'], NEW)
            lock.release()
        self.assertEqual(self.path.read_text(), '')

    def test_reconcile_implies_workers_and_refuses_only_m4(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            fleet_rollout.main(['--version', NEW, '--reconcile', '--only', 'm4'])
        self.assertEqual(caught.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
