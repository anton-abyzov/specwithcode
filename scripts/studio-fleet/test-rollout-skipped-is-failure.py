#!/usr/bin/env python3
"""A required host (M4, M1, M3) that is unreachable, skipped or fails ends the rollout as partial with a
not-updated row; an optional machine only gets the row (increment 1239, AC-03).

Run: cd scripts/studio-fleet && python3 -B test-rollout-skipped-is-failure.py
"""
import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import os
# Never M4's real rollout lock: a test run must neither wait for a live release nor block one.
os.environ['STUDIO_FLEET_ROLLOUT_LOCK'] = os.path.join(
    tempfile.mkdtemp(prefix='fleet-rollout-lock-'), 'fleet-rollout.lock')
import fleet_rollout  # noqa: E402
from rollout_test_fakes import NEW, Clock, Fleet, quiet  # noqa: E402


def workers(fleet, clock, hosts, **kwargs):
    fleet.version['m4'] = NEW
    return fleet_rollout.rollout(NEW, hosts, only='workers', clock=clock, sleep=clock.sleep, say=quiet, **kwargs)


class RequiredHosts(unittest.TestCase):
    def test_unreachable_required_host_fails_with_a_not_updated_row(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()
        hosts['m3'] = fleet_rollout.Unreachable('m3', 'no SSH, and its management token is not proof-bound')
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            workers(fleet, clock, hosts)
        rows = caught.exception.results
        self.assertEqual(rows['m3']['result'], 'not-updated')
        self.assertIn('unreachable', rows['m3']['reason'])
        self.assertEqual(rows['m1']['result'], 'installed')  # The others still go.
        lines = fleet_rollout.report(NEW, rows, fleet_rollout.REQUIRED_HOSTS)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith('m3 (required): not-updated on %s' % NEW))

    def test_unreachable_optional_host_gets_a_row_and_passes(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()
        hosts['annas-air'] = fleet_rollout.Unreachable('annas-air', 'no SSH, and it has no SpecWithCode Connect address')
        results = workers(fleet, clock, hosts)
        self.assertEqual(results['annas-air']['result'], 'skipped')
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(results['m3']['result'], 'installed')

    def test_failing_optional_host_does_not_fail_the_run(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()

        def broken(argv):
            raise fleet_rollout.RolloutError('ministorm: manual upgrade needed')
        hosts['ministorm'] = broken
        results = workers(fleet, clock, hosts)
        self.assertEqual(results['ministorm']['result'], 'not-updated')
        self.assertEqual(results['m3']['result'], 'installed')

    def test_failing_required_host_is_partial(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()

        def broken(argv):
            raise fleet_rollout.RolloutError('m1: manual upgrade needed')
        hosts['m1'] = broken
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            workers(fleet, clock, hosts)
        self.assertEqual(caught.exception.results['m1']['result'], 'not-updated')
        self.assertEqual(caught.exception.results['m3']['result'], 'installed')

    def test_optional_flag_relaxes_a_required_host(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()
        hosts['m3'] = fleet_rollout.Unreachable('m3', 'no route')
        results = workers(fleet, clock, hosts, required=('m4', 'm1'))
        self.assertEqual(results['m3']['result'], 'skipped')

    def test_required_host_missing_from_inventory_is_partial(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1})
        hosts = fleet.hosts()
        del hosts['m3']
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            workers(fleet, clock, hosts)
        self.assertEqual(caught.exception.results['m3']['reason'], 'not in the fleet inventory')

    def test_m4_failure_marks_workers_not_asked(self):
        clock = Clock()
        fleet = Fleet(clock)
        hosts = fleet.hosts()

        def broken(argv):
            raise fleet_rollout.RolloutError('m4: manual upgrade needed')
        hosts['m4'] = broken
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            fleet_rollout.rollout(NEW, hosts, only='all', clock=clock, sleep=clock.sleep, say=quiet)
        rows = caught.exception.results
        self.assertEqual(rows['m4']['result'], 'not-updated')
        self.assertIn('not asked', rows['m1']['reason'])
        self.assertEqual(fleet.asked, {})

    def test_main_exits_1_with_partial_json(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1})
        fleet.version['m4'] = NEW
        hosts = fleet.hosts()
        hosts['m3'] = fleet_rollout.Unreachable('m3', 'no route')
        real = fleet_rollout.rollout

        def fake_rollout(*args, **kwargs):
            kwargs.update(clock=clock, sleep=clock.sleep, say=quiet)
            return real(*args, **kwargs)
        out, err = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as home, \
                mock.patch.object(fleet_rollout, 'fleet', lambda: hosts), \
                mock.patch.object(fleet_rollout, 'rollout', fake_rollout), \
                mock.patch.object(fleet_rollout, 'lock_path', lambda: pathlib.Path(home) / 'lock'), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fleet_rollout.main(['--version', NEW, '--only', 'workers', '--no-desktop-apps'])
        self.assertEqual(code, 1)
        value = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual(value['result'], 'partial')
        self.assertEqual(value['hosts']['m3']['result'], 'not-updated')
        self.assertIn('not updated: m3 (required)', err.getvalue())


if __name__ == '__main__':
    unittest.main()
