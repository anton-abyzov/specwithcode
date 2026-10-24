#!/usr/bin/env python3
"""The update agent's own phase timings (update_agent_run.Timings): whole milliseconds per phase,
the shape of update.py's `timings`, in run.json as `agentTimings` and in the apply helper's
environment, which install_progress.agent_timings reads back. Reuses test-update-agent.py's
temporary homes, loopback fake GitHub API and fake helper.

Run: cd scripts/studio-fleet && python3 -B test-update-agent-timings.py
Nothing here touches a real Studio home, launchd, GitHub or gh.
"""
import importlib.util
import json
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install_progress  # noqa: E402
import update_agent_run as runs  # noqa: E402

_spec = importlib.util.spec_from_file_location('agent_tests_for_timings', str(HERE / 'test-update-agent-run.py'))
run_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_tests)

LAPS = ('beforeInstall', 'verifyHelpers', 'snapshot', 'retryWait', 'apply')


class Laps(unittest.TestCase):
    def test_each_lap_books_the_time_since_the_last_one_and_total_is_the_pass(self):
        moments = iter([10.0, 10.25, 10.5, 11.5, 11.501, 13.0])
        timings = runs.Timings(clock=lambda: next(moments))
        for phase in ('beforeInstall', 'snapshot', 'retryWait', 'snapshot', 'apply'):
            timings.lap(phase)
        self.assertEqual(timings.values, {'beforeInstall': 250, 'snapshot': 250 + 1, 'retryWait': 1000,
                                          'apply': 1499, 'total': 3000})

    def test_the_helper_reads_only_whole_milliseconds_back(self):
        env = install_progress.AGENT_TIMINGS_ENV
        self.assertEqual(env, runs.TIMINGS_ENV)
        self.assertEqual(install_progress.agent_timings({env: '{"snapshot": 61000, "total": 104000}'}),
                         {'snapshot': 61000, 'total': 104000})
        for text in ('', 'not json', '[]', '{"snapshot": 1.5}', '{"snapshot": -1}', '{"snapshot": true}',
                     json.dumps({str(index): 1 for index in range(40)}), '{"a": %s}' % ('1' * 5000)):
            self.assertEqual(install_progress.agent_timings({env: text}), {}, text)
        self.assertEqual(install_progress.agent_timings({}), {})


class AgentTimings(run_tests.RunCase):
    def test_a_forced_install_records_its_waits_in_the_run_and_hands_them_to_the_helper(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFailures=1)  # One refused snapshot, a wait, then the apply.
        self.run_agent()
        record = self.run_record()
        self.assertEqual(record['phase'], 'verified')
        timings = record['agentTimings']
        self.assertEqual(set(timings), set(LAPS) | {'requestWait', 'total'})
        self.assertTrue(all(type(value) is int and value >= 0 for value in timings.values()), timings)
        laps = sum(timings[phase] for phase in LAPS)
        self.assertLessEqual(abs(timings['total'] - laps), len(LAPS) + 2)  # Each lap rounds on its own.
        self.assertGreater(timings['snapshot'], 0)  # Two snapshot attempts ran.
        # The helper got the timings up to its own start: the apply itself is its receipt's `timings`.
        applies = self.apply_calls()
        self.assertEqual(len(applies), 1)
        handed = json.loads(applies[0]['agentTimings'])
        self.assertEqual(set(handed), set(LAPS) - {'apply'} | {'requestWait', 'total'})
        self.assertEqual(install_progress.agent_timings({runs.TIMINGS_ENV: applies[0]['agentTimings']}), handed)
        self.assertEqual(handed['requestWait'], timings['requestWait'])
        # A snapshot is never handed timings: its environment stays the documented one.
        self.assertTrue(all(call['agentTimings'] is None for call in self.snapshot_calls()))

    def test_an_automatic_install_records_no_request_wait(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.run_agent()  # The baseline snapshot.
        self.run_agent()  # Quiet since then: it installs.
        self.assertEqual(self.state()['status'], 'installed')
        handed = json.loads(self.apply_calls()[0]['agentTimings'])
        self.assertNotIn('requestWait', handed)  # Nobody asked: nothing waited for this pass.
        self.assertEqual(set(handed), {'beforeInstall', 'verifyHelpers', 'snapshot', 'total'})


if __name__ == '__main__':
    unittest.main()
