#!/usr/bin/env python3
"""Idle-only rollout drives the real service CLI adapter and a bounded fake fleet."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('rollout_idle_fixtures', HERE / 'test-fleet-rollout.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
r = f.fleet_rollout


class IdleRollout(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = pathlib.Path(temp.name)
        own = self.home / '.specwithcode/m4'
        own.mkdir(parents=True)
        wrapper = self.home / 'cli'
        wrapper.write_text('#!/bin/sh\nexit 99\n')
        wrapper.chmod(0o700)
        (own / 'installation.json').write_text(json.dumps({
            'version': '1.0.114', 'cliWrapper': str(wrapper), 'studioHome': str(own)}))
        self.clock = f.Clock()
        self.fleet = f.Fleet(self.clock, polls={'m4': 2})
        self.prepares = 0
        self.busy = 0
        self.error = False
        self.override = None
        self.commands = []
        self.hold = r.ServiceHold(home=self.home, run=self.run_cli)
        self.hold.wait_for_idle = True

    def run_cli(self, argv, **kwargs):
        self.commands.append(argv)
        self.assertNotIn('--stop-work', argv)
        self.assertNotIn('--release-hold', argv)
        self.assertIn('--if-idle', argv)
        self.assertIn('--hold', argv)
        self.prepares += 1
        if self.prepares <= self.busy:
            self.assertNotIn('m4', self.fleet.asked)
        reply = self.override or {'idle': self.prepares > self.busy, 'held': self.prepares > self.busy,
                                  'stoppedThreads': 0, 'interruptedRuns': 0, 'openTerminals': 0,
                                  'holdToken': 'a' * 64, 'blockers': []}
        if self.error:
            return subprocess.CompletedProcess(argv, 1, stdout='', stderr='Unrecognized flag --if-idle')
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(reply), stderr='')

    def rollout(self, **kwargs):
        return r.rollout(f.NEW, self.fleet.hosts(), only='m4', hold=self.hold,
                         clock=self.clock, sleep=self.clock.sleep, say=f.quiet, poll=15, **kwargs)

    def test_busy_sessions_finish_before_one_held_install(self):
        self.busy = 2
        result = self.rollout()
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(self.prepares, 3)
        self.assertEqual(len(self.fleet.calls('m4', 'request')), 1)
        self.assertIn('--force', self.fleet.asked['m4'])

    def test_busy_deadline_never_installs_or_releases_another_hold(self):
        self.busy = 100
        with self.assertRaisesRegex(r.RolloutError, 'did not install'):
            self.rollout(local_deadline=60)
        self.assertFalse(self.fleet.asked)
        self.assertEqual(self.fleet.calls('m4', 'cancel'), [])

    def test_unsupported_old_cli_never_falls_back_to_stopping_work(self):
        self.error = True
        with self.assertRaisesRegex(r.RolloutError, 'could not hold'):
            self.rollout()
        self.assertFalse(self.fleet.asked)
        self.assertEqual(len(self.commands), 1)

    def test_malformed_or_nonquiet_results_never_install(self):
        for value in ({'held': False}, {'held': True, 'idle': False, 'stoppedThreads': 0},
                      {'held': True, 'idle': True, 'stoppedThreads': 1},
                      {'held': True, 'idle': True, 'stoppedThreads': 0, 'openTerminals': 1}):
            with self.subTest(value=value):
                self.override = value
                with self.assertRaises(r.RolloutError):
                    self.rollout()
                self.assertFalse(self.fleet.asked)

    def test_failed_install_cancels_own_request_without_unconditional_lease_release(self):
        self.fleet.ready = lambda *_: False
        with self.assertRaisesRegex(r.RolloutError, 'did not install'):
            self.rollout(local_deadline=60)
        self.assertEqual(len(self.fleet.calls('m4', 'cancel')), 1)
        self.assertEqual(self.prepares, 1)
        self.assertTrue(all('--release-hold' not in argv for argv in self.commands))

    def test_environment_routes_canonical_release_to_idle_only(self):
        holds = []
        with mock.patch.object(r, 'fleet', return_value={}), \
             mock.patch.object(r, 'ServiceHold', return_value=self.hold), \
             mock.patch.object(r, 'rollout', side_effect=lambda *a, **k: holds.append(k['hold']) or {}), \
             mock.patch.dict(os.environ, {'STUDIO_FLEET_WAIT_FOR_IDLE': '1'}), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(r.main(['--version', f.NEW, '--only', 'm4']), 0)
        self.assertTrue(holds[0].wait_for_idle)

    def test_idle_flag_refuses_no_hold(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            r.main(['--version', f.NEW, '--wait-for-idle', '--no-hold'])


if __name__ == '__main__':
    unittest.main()
