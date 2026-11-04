#!/usr/bin/env python3
"""A host outside the rollout never installs from candidate.json (increment 1239, AC-18): the hourly
agent on the stable channel neither reads the candidate pointer nor downloads its assets, a request
for another version never takes the candidate, a candidate cached by a failed canary request is not
installed later on its own, M4's own reconcile leaves the workers alone while a candidate runs, and
the fleet stage never asks a host whose agent predates channel feeds.

A folder store written by scripts/release/r2_publish.py stands in for R2; GitHub and the hosts are
loopback fakes. Nothing reaches a real bucket, GitHub, launchd or a real SpecWithCode home.

Run: cd scripts/studio-fleet && python3 -B test-candidate-ignored-off-canary.py
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# Never M4's real rollout lock (nor the candidate hold beside it).
os.environ['STUDIO_FLEET_ROLLOUT_LOCK'] = os.path.join(
    tempfile.mkdtemp(prefix='fleet-rollout-lock-'), 'fleet-rollout.lock')
import fleet_rollout  # noqa: E402
import update_agent  # noqa: E402
from rollout_test_fakes import NEW, OLD, Clock, Fleet, quiet  # noqa: E402

spec = importlib.util.spec_from_file_location('channel_skew_tests', str(HERE / 'test-channel-feed-skew.py'))
skew = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skew)
r2_publish = skew.r2_publish
PREVIOUS, CANDIDATE = skew.PREVIOUS, skew.CANDIDATE


class HourlyAgent(skew.ChannelCase):
    def setUp(self):
        skew.ChannelCase.setUp(self)
        self.publish(CANDIDATE)
        self.feed.requests.clear()
        self.control(newVersion=CANDIDATE)

    def test_the_hourly_agent_on_stable_never_reads_or_installs_the_candidate(self):
        self.config(installAutomatically=True, downloadInBackground=True, quietMinutes=0)
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual(state['status'], 'up-to-date')
        self.assertIsNone(state['availableVersion'])
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(self.apply_calls(), [])
        paths = [path for path, _ in self.feed.requests]
        self.assertIn('/' + r2_publish.STABLE, paths)
        self.assertNotIn('/' + r2_publish.CANDIDATE, paths)
        self.assertEqual(self.feed.fetched('candidate/'), [])

    def test_a_check_now_on_stable_never_reads_the_candidate(self):
        self.config(installAutomatically=False, checkRequestedAt=skew.fixture.later())
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertIsNone(self.state()['availableVersion'])
        self.assertNotIn('/' + r2_publish.CANDIDATE, [path for path, _ in self.feed.requests])

    def test_a_request_for_another_version_never_takes_the_candidate(self):
        self.ask('1.0.191')
        self.run_agent()
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(self.feed.fetched('candidate/'), [])

    def test_a_candidate_cached_by_a_failed_canary_request_is_not_installed_later(self):
        self.control(newVersion=CANDIDATE, applyFail=True)
        self.ask(CANDIDATE)
        self.run_agent()
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(len(self.apply_calls()), 1)
        meta = json.loads((self.updates / 'downloads' / CANDIDATE / 'release.json').read_text())
        self.assertEqual(meta['channel'], 'candidate')
        # Later automatic passes, checked or not: the cached candidate is no longer offered.
        self.control(newVersion=CANDIDATE)
        self.config(installAutomatically=True, quietMinutes=0,
                    installRequestedAt=self.state()['handledInstallRequestAt'])
        for _ in range(2):
            self.run_agent()
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertIsNone(self.state()['availableVersion'])


class Reconcile(unittest.TestCase):
    def run_main(self, fleet, argv):
        out = io.StringIO()
        with mock.patch.object(fleet_rollout, 'fleet', lambda: fleet.hosts()), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fleet_rollout.main(argv + ['--no-desktop-apps'])
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def tearDown(self):
        fleet_rollout.candidate_hold(clear=True)

    def test_m4s_reconcile_leaves_the_workers_alone_while_a_candidate_runs(self):
        fleet = Fleet(Clock())
        fleet.version['m4'] = NEW  # The canary installed the candidate; its agent started a reconcile.
        fleet_rollout.candidate_hold(NEW)
        code, value = self.run_main(fleet, ['--version', NEW, '--reconcile'])
        self.assertEqual((code, value['result']), (0, 'candidate-held'))
        self.assertEqual(fleet.log, [])  # No host was even read.

    def test_a_stale_or_other_version_hold_does_not_stop_a_reconcile(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version['m4'] = NEW
        real = fleet_rollout.rollout

        def fake_rollout(*args, **kwargs):
            kwargs.update(clock=clock, sleep=clock.sleep, say=quiet)
            return real(*args, **kwargs)
        for written in (lambda: fleet_rollout.candidate_hold('1.0.39'),  # Another version's candidate.
                        lambda: fleet_rollout.candidate_hold(NEW, clock=lambda: 0)):  # Written long ago.
            written()
            self.assertNotEqual(fleet_rollout.candidate_hold(), NEW)
            with mock.patch.object(fleet_rollout, 'rollout', fake_rollout):
                code, value = self.run_main(fleet, ['--version', NEW, '--reconcile'])
            self.assertEqual((code, value['result']), (0, 'installed'))
        self.assertEqual(len(fleet.calls('m1', 'request')), 1)

    def test_the_canary_writes_the_hold_and_the_fleet_stage_clears_it(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 1, 'm1': 1, 'm3': 1})
        real = fleet_rollout.rollout
        holds = []

        def fake_rollout(*args, **kwargs):
            holds.append(fleet_rollout.candidate_hold())
            kwargs.update(clock=clock, sleep=clock.sleep, say=quiet)
            return real(*args, **kwargs)
        with mock.patch.object(fleet_rollout, 'rollout', fake_rollout):
            code, value = self.run_main(fleet, ['--version', NEW, '--only', 'm4', '--no-hold', '--channel', 'candidate',
                                                '--channel-since', OLD])
            self.assertEqual((code, value['result']), (0, 'installed'))
            self.assertEqual(fleet_rollout.candidate_hold(), NEW)
            code, value = self.run_main(fleet, ['--version', NEW, '--only', 'workers', '--channel', 'candidate',
                                                '--channel-since', OLD])
        self.assertEqual((code, value['result']), (0, 'installed'))
        self.assertEqual(holds, [NEW, NEW])
        self.assertIsNone(fleet_rollout.candidate_hold())

    def test_the_fleet_stage_never_asks_a_host_whose_agent_predates_channel_feeds(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version.update(m4=NEW, m3='1.0.38')
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            fleet_rollout.rollout(NEW, fleet.hosts(), only='workers', clock=clock, sleep=clock.sleep, say=quiet,
                                  channel_since=(1, 0, 40))
        rows = caught.exception.results
        self.assertEqual(rows['m1']['result'], 'installed')
        self.assertEqual(rows['m3']['result'], 'not-updated')
        self.assertIn('reads GitHub only (the candidate channel needs 1.0.40)', rows['m3']['reason'])
        self.assertEqual(fleet.calls('m3', 'request'), [])

    def test_channel_arguments_go_together(self):
        for argv in (['--channel', 'candidate'], ['--channel-since', OLD]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                fleet_rollout.main(['--version', NEW] + argv)
            self.assertEqual(caught.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
