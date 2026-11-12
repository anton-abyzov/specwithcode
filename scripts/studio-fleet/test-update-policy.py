#!/usr/bin/env python3
"""update_policy: one reading of "Pause running work for updates" for the update agent and the rollout.

Run: cd scripts/studio-fleet && python3 -B test-update-policy.py
"""
import pathlib
import subprocess
import sys
import tempfile
import json
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import service_hold  # noqa: E402
import update_policy  # noqa: E402
import update_request  # noqa: E402


class FakeHold(object):
    def __init__(self, answer=None, error=None):
        self.answer, self.error, self.looks = answer, error, 0

    def look(self):
        self.looks += 1
        if self.error is not None:
            raise self.error
        return self.answer


class PausesWork(unittest.TestCase):
    def test_only_a_boolean_counts(self):
        self.assertIs(update_policy.pauses_work({'pauseWorkForUpdates': True}), True)
        self.assertIs(update_policy.pauses_work({'pauseWorkForUpdates': False}), False)
        for answer in ({}, {'pauseWorkForUpdates': None}, {'pauseWorkForUpdates': 'false'},
                       {'pauseWorkForUpdates': 0}, {'pauseWorkForUpdates': 1}, None, [], 'off'):
            with self.subTest(answer=answer):
                self.assertIsNone(update_policy.pauses_work(answer))


class ServicePolicy(unittest.TestCase):
    def test_each_answer_maps_to_one_policy(self):
        cases = ((FakeHold({'pauseWorkForUpdates': True}), 'on'),
                 (FakeHold({'pauseWorkForUpdates': False, 'idle': False}), 'off'),
                 (FakeHold({'idle': True}), 'legacy'),  # Answered without the key: predates the setting (D-08).
                 (FakeHold(error=service_hold.HoldUnsupported('M4 runs 1.0.44')), 'legacy'),
                 (FakeHold(error=service_hold.HoldUnavailable('no answer within 60s')), 'unknown'))
        for hold, policy in cases:
            with self.subTest(policy=policy):
                self.assertEqual(update_policy.service_policy(hold), policy)
                self.assertEqual(hold.looks, 1)

    def test_look_returns_the_answer_it_read(self):
        answer = {'pauseWorkForUpdates': True, 'folderCopies': 2}
        self.assertEqual(update_policy.look(FakeHold(answer)), ('on', answer))
        self.assertEqual(update_policy.look(FakeHold(error=service_hold.HoldUnavailable('x'))), ('unknown', None))

    def test_only_on_and_legacy_allow_a_pause(self):
        self.assertEqual([policy for policy in ('on', 'off', 'legacy', 'unknown') if update_policy.allows_pause(policy)],
                         ['on', 'legacy'])

    def test_the_real_look_stops_and_holds_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            own = home / '.specwithcode/m4'
            own.mkdir(parents=True)
            wrapper = home / 'cli'
            wrapper.write_text('#!/bin/sh\nexit 99\n')
            wrapper.chmod(0o700)
            (own / 'installation.json').write_text(json.dumps({
                'version': '1.0.243', 'cliWrapper': str(wrapper), 'studioHome': str(own)}))
            calls = []

            def run(argv, **kwargs):
                calls.append(list(argv))
                return subprocess.CompletedProcess(argv, 0, stdout='{"idle": false, "pauseWorkForUpdates": false}\n',
                                                   stderr='')
            hold = service_hold.ServiceHold('m4', home, run=run)
            self.assertEqual(update_policy.service_policy(hold), 'off')
            self.assertEqual(calls, [[str(wrapper), 'service', 'prepare-update', '--base-dir', str(own), '--json']])
            self.assertEqual(hold.counted_copies(), 0)
            (own / 'installation.json').write_text(json.dumps({
                'version': '1.0.44', 'cliWrapper': str(wrapper), 'studioHome': str(own)}))
            self.assertEqual(update_policy.service_policy(hold), 'legacy')  # Refused before anything runs.
            self.assertEqual(len(calls), 2)


class Messages(unittest.TestCase):
    def test_the_agent_line_keeps_the_refusal_first(self):
        refusal = 'Waiting for running tasks, queued messages and open questions to finish (1 running task)'
        off = update_policy.agent_waiting(refusal, 'off')
        self.assertTrue(off.startswith(refusal + '; '))
        self.assertIn('installs once running work finishes', off)
        self.assertIn('"Pause running work for updates" is off on this Mac', off)
        unknown = update_policy.agent_waiting(refusal, 'unknown')
        self.assertTrue(unknown.startswith(refusal + '; '))
        self.assertIn('did not say whether "Pause running work for updates" is on', unknown)

    def test_the_deferred_reason_is_a_fact_not_a_blocker(self):
        reason = update_policy.deferred_reason('ministorm', '1.0.243', '1.0.236', '1 run (Build SpecOS on Linux)')
        for words in ('ministorm is left on 1.0.236 until it is quiet', '"Pause running work for updates" is off on ministorm',
                      '1.0.243 is not installed over its running work (1 run (Build SpecOS on Linux))',
                      "This is its owner's setting, not a failure", 'report it as a fact, not a blocker'):
            self.assertIn(words, reason)
        self.assertNotIn('force', reason.lower())  # Never the question that reached the owner as a blocker.

    def test_the_m4_line_names_the_setting_and_the_wait(self):
        off = update_policy.m4_idle_only('off', 115)
        self.assertIn('"Pause running work for updates" is off on M4, so M4 is held only when idle', off)
        self.assertIn('left for later if it is still busy after 30 min', off)
        unknown = update_policy.m4_idle_only('unknown', 115)
        self.assertIn("could not be read from M4's service, so M4 is held only when idle", unknown)
        self.assertIn('fails as before if it has not installed within 115 min', unknown)
        self.assertNotIn('is off', unknown)
        self.assertNotIn('left for later', unknown)
        self.assertEqual(update_policy.DEFER_SECONDS, 30 * 60)
        self.assertEqual(update_policy.SETTING, 'Pause running work for updates')


WORKING = update_policy.RUNNING_WORK[0] + ' (1 running task) (attempt 2)'
MINUTE = 60


class Deferral(unittest.TestCase):
    """When the rollout may leave a host whose setting is off for later: busy evidence only."""

    def defer(self, status, elapsed, allowed=False, deadline=60 * MINUTE, started=None, **kwargs):
        return update_policy.deferral('m1', '1.0.243', dict(status, version='1.0.240'), allowed, elapsed, deadline,
                                      started if started is not None else [False], **kwargs)

    def test_a_mac_waiting_for_running_work_is_left_for_later_from_30_minutes(self):
        busy = {'status': 'waiting-for-quiet', 'message': WORKING}
        self.assertIsNone(self.defer(busy, 29 * MINUTE))
        reason = self.defer(busy, 30 * MINUTE)
        self.assertIn('m1 is left on 1.0.240 until it is quiet', reason)
        self.assertIn(WORKING, reason)
        self.assertIsNotNone(self.defer(busy, 10 * MINUTE, deadline=10 * MINUTE))  # A shorter deadline is the point.
        terminals = {'status': 'waiting-for-quiet', 'message': update_policy.RUNNING_WORK[1] + ' (codex)'}
        self.assertIsNotNone(self.defer(terminals, 30 * MINUTE))

    def test_anything_but_running_work_is_never_left_for_later(self):
        for status in ({'status': 'error', 'message': 'launchctl could not load the update agent'},
                       {'status': 'downloading', 'message': 'Downloading'}, {'status': 'up-to-date'},
                       {'status': 'downloaded'}, {'status': 'installing', 'message': WORKING},
                       {'status': 'waiting-for-quiet', 'message': "The updater's check took too long; retrying"},
                       {'status': 'waiting-for-quiet',
                        'message': 'Waiting for a folder copy to or from another machine to finish'},
                       {'method': 'boot-service', 'phase': 'requested', 'lastError': 'waiting for 1 run'},
                       {'method': 'boot-service', 'phase': 'failed', 'lastErrorReason': 'install-failed'}):
            with self.subTest(status=status):
                self.assertIsNone(self.defer(status, 59 * MINUTE))
                self.assertIsNone(self.defer(status, 60 * MINUTE))

    def test_only_the_setting_off_defers(self):
        busy = {'status': 'waiting-for-quiet', 'message': WORKING}
        for allowed in (True, None):
            self.assertIsNone(self.defer(busy, 40 * MINUTE, allowed=allowed))

    def test_once_an_install_started_only_the_deadline_applies(self):
        started = [False]
        self.assertIsNone(self.defer({'status': 'installing'}, 20 * MINUTE, started=started))
        self.assertEqual(started, [True])
        self.assertIsNone(self.defer({'status': 'waiting-for-quiet', 'message': WORKING}, 40 * MINUTE, started=started))
        self.assertIsNone(self.defer({}, 40 * MINUTE, took=True, refused='1 run'))  # M4 held: started.

    def test_m4_refused_as_busy_is_evidence(self):
        reason = self.defer({'status': 'downloaded'}, 30 * MINUTE, refused='1 run (Build SpecOS on Linux)')
        self.assertIn('over its running work (1 run (Build SpecOS on Linux))', reason)

    def test_a_linux_service_that_gave_up_busy_is_left_for_later_at_once(self):
        gave_up = {'method': 'boot-service', 'phase': 'failed', 'lastErrorReason': 'busy', 'lastError': 'stayed busy'}
        self.assertIn('stayed busy', self.defer(gave_up, 2 * MINUTE))
        self.assertIsNone(self.defer(gave_up, 2 * MINUTE, allowed=None))

    def test_the_running_work_texts_are_the_agents_own(self):
        import update_agent_pause  # noqa: E402 - only here: it ships beside the agent, not this policy.
        self.assertEqual(update_policy.RUNNING_WORK,
                         tuple(message for _phrase, message in update_agent_pause.WAITING_REASONS[:2]))
        self.assertTrue(update_agent_pause.running_work(('waiting-for-quiet', WORKING)))


class Summary(unittest.TestCase):
    def test_deferred_only_when_nothing_else_is_left(self):
        deferred = update_policy.deferred_row('m1', 'left for later', 'connect')
        self.assertEqual(deferred, {'identity': 'm1', 'result': 'deferred', 'reason': 'left for later', 'route': 'connect'})
        installed = {'identity': 'm3', 'result': 'installed'}
        self.assertEqual(update_policy.summary_result({'m1': deferred, 'm3': installed}, 'installed'), 'deferred')
        self.assertEqual(update_policy.summary_result({'m3': installed}, 'installed'), 'installed')
        failed = {'identity': 'm3', 'result': 'not-updated', 'reason': 'm3 tried 1.0.243 and it failed'}
        self.assertEqual(update_policy.summary_result({'m1': deferred, 'm3': failed}, 'partial'), 'partial')
        behind = {'identity': 'm1', 'result': 'not-updated', 'reason': update_policy.M4_LATER}
        m4 = update_policy.deferred_row('m4', 'left for later')
        self.assertEqual(update_policy.summary_result({'m4': m4, 'm1': behind}, 'partial'), 'deferred')
        self.assertEqual(update_policy.summary_result({'m1': behind}, 'partial'), 'partial')  # No deferred row at all.

    def test_a_deferred_mac_row_leaves_its_app_for_later(self):
        row = update_policy.deferred_row('m1', 'left for later', 'connect', app=True)
        self.assertEqual(row['desktopApp']['result'], 'skipped')
        self.assertTrue(row['desktopApp']['reason'].startswith('deferred: '))
        self.assertNotIn('desktopApp', update_policy.deferred_row('ministorm', 'left for later'))
        self.assertEqual(update_policy.summary_result({'m1': row}, 'installed'), 'deferred')


class Shipping(unittest.TestCase):
    def test_it_ships_beside_the_installed_agent(self):
        self.assertIn('update_policy.py', update_request.AGENT_FILES)
        build = (HERE.parent / 'lib/studio-service-updater.ts').read_text()
        self.assertIn('"update_policy.py"', build)

    def test_it_imports_only_the_standard_library_and_its_shipped_neighbours(self):
        source = (HERE / 'update_policy.py').read_text()
        imported = {line.split()[1].split('.')[0] for line in source.splitlines()
                    if line.startswith(('import ', 'from '))}
        self.assertEqual(imported, {'service_hold'})
        self.assertIn('service_hold.py', update_request.AGENT_FILES)


if __name__ == '__main__':
    unittest.main()
