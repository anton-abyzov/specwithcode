#!/usr/bin/env python3
"""`service prepare-update` runs once per forced request: each run inserts an auth_sessions row
(servicePrepareUpdate.ts), and a second one landing between the agent's snapshot and update.py's
read is what failed the guarded prestate on "rows" (1.0.48 to 1.0.66). fleet_rollout is the only
caller; a forced agent pass and a verified update.py apply start no such command. The rollout here drives test-fleet-rollout.py's
fake fleet with a real ServiceHold whose subprocess.run is a mock, so the CLI calls are counted.

Run: cd scripts/studio-fleet && python3 -B test-fleet-rollout-prepare.py
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fleet_rollout  # noqa: E402

_spec = importlib.util.spec_from_file_location('rollout_tests_for_prepare', str(HERE / 'test-fleet-rollout.py'))
rollout_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rollout_tests)
Clock, Fleet, HELD, NEW = rollout_tests.Clock, rollout_tests.Fleet, rollout_tests.HELD, rollout_tests.NEW


class PrepareOncePerRequest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = pathlib.Path(folder.name)
        own = self.home / '.specwithcode' / 'm4'
        own.mkdir(parents=True)
        wrapper = self.home / 'specweave-studio'
        wrapper.write_text('#!/bin/sh\nexit 99\n')  # Never run: subprocess.run is the mock below.
        wrapper.chmod(0o700)
        (own / 'installation.json').write_text(json.dumps(
            {'identity': 'm4', 'version': '1.0.45', 'cliWrapper': str(wrapper), 'studioHome': str(own)}))

    def rollout(self, polls, **options):
        """Runs the rollout for M4; returns (fleet, the RolloutError or None). The fleet's log holds
        its calls, the CLI runs named 'prepare-update' (--stop-work, the one that inserts the hold's
        session row) or 'release-hold'."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': polls})

        def run(argv, **kwargs):
            assert argv[1:3] == ['service', 'prepare-update'], argv
            with fleet.lock:
                fleet.log.append(('m4', 'prepare-update' if '--stop-work' in argv else 'release-hold', None, list(argv)))
            reply = HELD if '--stop-work' in argv else {'idle': True, 'stoppedThreads': 0, 'blockers': [], 'held': False}
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(reply) + '\n', stderr='')
        hold = fleet_rollout.ServiceHold(home=self.home, run=run)
        options.setdefault('poll', 30)
        try:
            fleet_rollout.rollout(NEW, fleet.hosts(), only='m4', clock=clock, sleep=clock.sleep,
                                  say=rollout_tests.quiet, hold=hold, **options)
        except fleet_rollout.RolloutError as error:
            return fleet, error
        return fleet, None

    def test_an_install_runs_prepare_update_once_right_before_its_one_request(self):
        fleet, error = self.rollout(polls=3)
        self.assertIsNone(error)
        self.assertEqual(rollout_tests.kinds(fleet), ['prepare-update', 'request'])
        self.assertIn('--force', fleet.asked['m4'])

    def test_each_request_again_follows_exactly_one_prepare_update(self):
        fleet, error = self.rollout(polls=10 ** 6, hold_minutes=15, local_deadline=40 * 60)
        self.assertIn('did not install', str(error))
        # Three requests, each right after its own hold; the give-up cancels, then releases once.
        self.assertEqual(rollout_tests.kinds(fleet), ['prepare-update', 'request'] * 3 + ['cancel', 'release-hold'])



def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(HERE / filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class Commands(object):
    """Every argv started through subprocess.Popen (run, check_output and call use it), and any
    other runner a test passes through `record`."""
    def __init__(self, case):
        self.argvs = []
        real = subprocess.Popen
        commands = self

        class Recorded(real):
            def __init__(self, args, *rest, **kwargs):
                commands.record(args)
                super().__init__(args, *rest, **kwargs)
        patcher = mock.patch.object(subprocess, 'Popen', Recorded)
        patcher.start()
        case.addCleanup(patcher.stop)

    def record(self, argv):
        self.argvs.append([str(part) for part in argv] if isinstance(argv, (list, tuple)) else [str(argv)])

    def prepare_updates(self):
        return [argv for argv in self.argvs if any('prepare-update' in part for part in argv)]


agent_tests = load('agent_tests_for_prepare', 'test-update-agent.py')
apply_tests = load('apply_tests_for_prepare', 'test-update.py')


class NeverFromTheAgent(agent_tests.AgentCase):
    def test_a_forced_install_pass_runs_no_prepare_update(self):
        commands = Commands(self)
        self.fake.add_release()
        self.config(installMode='force', installRequestedAt='2026-10-10T10:00:00Z',
                    installHoldUntil=agent_tests.update_agent.iso(
                        agent_tests.update_agent.utcnow() + agent_tests.datetime.timedelta(minutes=15)))
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'installed')
        self.assertTrue(commands.argvs)  # The pass ran its helpers through the spy.
        self.assertEqual(commands.prepare_updates(), [])
        self.assertEqual([call['argv'] for call in self.calls()
                          if any('prepare-update' in str(part) for part in call['argv'])], [])


class NeverFromUpdatePy(unittest.TestCase):
    def test_a_verified_apply_runs_no_prepare_update(self):
        fixture = apply_tests.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        commands = Commands(self)
        transport = fixture.transport

        def recorded(command, **kwargs):
            commands.record(command)
            return transport(command, **kwargs)
        fixture.transport = recorded  # update.run, which the harness answers instead of running.
        fixture.execute()
        self.assertEqual(json.loads(fixture.output.read_text())['phase'], 'verified')
        self.assertTrue(commands.argvs)
        self.assertEqual(commands.prepare_updates(), [])


if __name__ == '__main__':
    unittest.main()
