#!/usr/bin/env python3
"""fleet_rollout's default route: SpecWithCode Connect only. Without --ssh-fallback no fleet inventory is
read, no pinned SSH is built, and the desktop app step (which needs SSH) is skipped without failing. A
worker Connect leaves unanswered right after its restart is asked again for up to three minutes."""
import importlib.util
import json
import os
import subprocess
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fleet_rollout  # noqa: E402

_spec = importlib.util.spec_from_file_location('fleet_rollout_tests', HERE / 'test-fleet-rollout.py')
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)


class ConnectOnlyDefault(unittest.TestCase):
    def test_by_default_no_inventory_is_read_and_no_ssh_is_built(self):
        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(pathlib.Path(temporary) / 'missing.json')}):
            hosts = fleet_rollout.fleet(home=temporary, connect=base.CLI)
        self.assertEqual(sorted(hosts), ['m1', 'm3', 'm4'])
        for identity in ('m1', 'm3'):
            self.assertIsInstance(hosts[identity], fleet_rollout.Unreachable)
            self.assertIn("not in M4's fleet (studio-fleet.json)", hosts[identity].reason)
            self.assertIn('pass --ssh-fallback to use pinned fleet SSH', hosts[identity].reason)

    def test_connect_only_workers_skip_the_desktop_step_without_failing(self):
        clock, lines = base.Clock(), []
        fleet = base.connect_fleet(clock, extra=(), polls={'m1': 1, 'm3': 1})
        cli = base.FakeCli(fleet)
        hosts = fleet.hosts()
        for identity in ('m1', 'm3'):
            hosts[identity] = fleet_rollout.ConnectHost(identity, base.CLI, identity + '-id', run=cli)
        skip = 'needs pinned fleet SSH (pass --ssh-fallback); its own updater installs %s on quit' % base.NEW
        results = fleet_rollout.rollout(base.NEW, hosts, only='workers', clock=clock, sleep=clock.sleep,
                                        say=lines.append, desktop_skip=skip)
        for identity in ('m1', 'm3'):
            self.assertEqual(results[identity]['result'], 'installed')
            self.assertEqual(results[identity]['route'], 'connect')
            self.assertEqual(results[identity]['desktopApp'], {'result': 'skipped', 'reason': skip})
            self.assertIn('%s: desktop app skipped: %s' % (identity, skip), lines)



class FlakyCli(object):
    """The fake fleet's CLI, except that `identity` gives `answer` (the CLI's JSON) to its first
    `times` calls: by default Connect leaving it unanswered, as M1 right after its 1.0.192 restart."""

    def __init__(self, cli, identity, times, answer=None):
        self.cli, self.identity, self.left, self.calls = cli, identity, times, 0
        self.answer = answer or {'error': 'This machine is unavailable. Check its private connection and retry.',
                                 'reason': 'unreachable'}

    def __call__(self, command, **options):
        if base.MACHINES[command[len(base.CLI)]] == self.identity and self.left:
            self.left -= 1
            self.calls += 1
            return subprocess.CompletedProcess(command, 1, json.dumps(self.answer) + '\n', '')
        return self.cli(command, **options)


class ConnectRetry(unittest.TestCase):
    def roll(self, flaky_times, answer=None):
        clock, lines = base.Clock(), []
        fleet = base.connect_fleet(clock, extra=(), polls={'m1': 1, 'm3': 1})
        fleet.version['m3'] = base.NEW  # Already there: m3's thread never moves the shared clock.
        cli = FlakyCli(base.FakeCli(fleet), 'm1', flaky_times, answer)
        hosts = fleet.hosts()
        for identity in ('m1', 'm3'):
            hosts[identity] = fleet_rollout.ConnectHost(identity, base.CLI, identity + '-id', run=cli)
        begin = clock()
        try:
            results = fleet_rollout.rollout(base.NEW, hosts, only='workers', clock=clock, sleep=clock.sleep,
                                            say=lines.append)
        except fleet_rollout.RolloutPartial as error:
            results = error.results
        return results, lines, cli, clock() - begin

    def test_a_worker_whose_connect_relay_is_reconnecting_is_asked_again(self):
        results, lines, cli, _ = self.roll(3)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(results['m1']['route'], 'connect')
        self.assertEqual(results['m3']['result'], 'already-installed')
        self.assertEqual(cli.calls, 3)
        retries = [line for line in lines if line.startswith('m1: SpecWithCode Connect unreachable (status)')]
        self.assertEqual([line.split('asking again in ')[1].split('s ')[0] for line in retries], ['5', '10', '20'])

    def test_connect_still_unreachable_after_three_minutes_fails_the_worker(self):
        results, lines, cli, elapsed = self.roll(10 ** 6)
        self.assertEqual(results['m1']['result'], 'not-updated')
        self.assertIn('This machine is unavailable', results['m1']['reason'])
        self.assertIn('(unreachable)', results['m1']['reason'])
        self.assertIn('m1: SpecWithCode Connect still unreachable after 180s of retries', lines)
        self.assertGreaterEqual(elapsed, fleet_rollout.CONNECT_RETRY_SECONDS)
        self.assertLess(elapsed, fleet_rollout.CONNECT_RETRY_SECONDS + 60)
        self.assertEqual(results['m3']['result'], 'already-installed')  # One worker's outage never holds the other.

    def test_a_refusal_fails_at_once_without_retries(self):
        for reason in ('unauthorized', 'not_authorized', 'identity-mismatch', 'connect-key-missing'):
            with self.subTest(reason=reason):
                results, lines, cli, _ = self.roll(10 ** 6, {'error': 'refused', 'reason': reason})
                self.assertEqual(results['m1']['result'], 'not-updated')
                self.assertEqual(cli.calls, 1)
                self.assertFalse(any('asking again' in line for line in lines), lines)

    def test_status_read_retries_then_raises_the_last_error(self):
        clock, lines, calls = base.Clock(), [], []

        def call(argv):
            calls.append(argv[0])
            error = fleet_rollout.RolloutError('m1: unavailable (unreachable)')
            error.unanswered = 'unreachable'
            raise error
        with self.assertRaises(fleet_rollout.RolloutError):
            fleet_rollout.connect_settled(call, ['status', '--identity', 'm1'], 'm1', clock, clock.sleep, lines.append)
        self.assertEqual(len(calls), 9)  # The first read and eight more: 5 + 10 + 20 + 30 * 4 + 25 = 180 s.
        self.assertEqual(lines[-1], 'm1: SpecWithCode Connect still unreachable after 180s of retries')

    def test_retry_backoff_is_bounded(self):
        delays, waited, attempt = [], 0, 0
        while True:
            delay = fleet_rollout.connect_retry_delay(attempt, waited)
            if delay is None:
                break
            delays.append(delay)
            waited += delay
            attempt += 1
        self.assertEqual(delays[:4], [5, 10, 20, 30])
        self.assertEqual(sum(delays), fleet_rollout.CONNECT_RETRY_SECONDS)
        self.assertLessEqual(max(delays), 30)

if __name__ == '__main__':
    unittest.main()
