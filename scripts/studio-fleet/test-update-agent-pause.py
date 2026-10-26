#!/usr/bin/env python3
"""Update agent tests for an automatic install that waits for running work: it waits for the grace
(pauseWorkAfterMinutes), then drains and holds the service the way Update now does, asks for a
forced install and installs in the same run; "Later" postpones the pause, and a drain that cannot
run leaves it waiting. Reuses test-update-agent.py's temporary homes, fake GitHub and fake helper.

Run: cd scripts/studio-fleet && python3 -B test-update-agent-pause.py
Nothing here touches a real Studio home, service, launchd, GitHub or gh: the drain is a fake, or a
stand-in CLI script inside the temporary home.
"""
import datetime
import importlib.util
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import service_handles  # noqa: E402
import service_hold  # noqa: E402
import update_agent  # noqa: E402
import update_agent_pause as pause  # noqa: E402
import update_request  # noqa: E402

_spec = importlib.util.spec_from_file_location('agent_tests_for_pause', str(HERE / 'test-update-agent.py'))
agent_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_tests)
AgentCase = agent_tests.AgentCase
BUSY = 'AssertionError: Native work is not idle\nREFUSAL native-work runs=1 sessions=1'


class FakeHold(object):
    """service_hold.ServiceHold's interface; each prepare is recorded with the settings it saw."""

    def __init__(self, case):
        self.case = case
        self.calls = []

    def __call__(self, identity, home, run=None):
        self.calls.append(('new', identity, pathlib.Path(home), callable(run)))
        return self

    def prepare(self):
        config = self.case.read_config()
        self.calls.append(('prepare', config.get('installRequestedAt')))
        if self.case.on_prepare:
            return self.case.on_prepare()
        self.case.control()  # The drain stopped the work: the next snapshot is idle.
        return {'held': True, 'stoppedThreads': 1, 'interruptedRuns': 1, 'openTerminals': 0}

    def release(self):
        self.calls.append(('release',))
        if self.case.on_release:
            return self.case.on_release()
        return {'released': True}

    def prepared(self):
        return [call for call in self.calls if call[0] == 'prepare']

    def released(self):
        return [call for call in self.calls if call[0] == 'release']


def raises(error):
    def fail(*args, **kwargs):
        raise error
    return fail


WORK = 'Waiting for running tasks, queued messages and open questions to finish (1 running task, 1 active session)'


class AutomaticPause(AgentCase):
    def setUp(self):
        AgentCase.setUp(self)
        self.fake.add_release()
        self.hold, self.on_prepare, self.on_release = FakeHold(self), None, None
        patcher = mock.patch.object(pause, 'HOLD', self.hold)
        patcher.start()
        self.addCleanup(patcher.stop)
        # A service with the safe CLI publishes its credential; the gate has its own test.
        self.credential = self.own.joinpath('userdata', *pause.CLI_CREDENTIAL)
        self.credential.parent.mkdir(parents=True, exist_ok=True)
        self.credential.write_bytes(b'token')

    def read_config(self):
        path = self.updates / 'config.json'
        return json.loads(path.read_text()) if path.exists() else {}

    def edit_state(self, **values):
        path = self.updates / 'state.json'
        state = json.loads(path.read_text())
        state.update(values)
        path.write_text(json.dumps(state))

    def now(self):
        return update_agent.utcnow()

    def advance(self, minutes):
        self.offset += datetime.timedelta(minutes=minutes)

    def busy_pass(self):
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        return self.state()

    def assert_waiting(self, state, pause_at):
        self.assertEqual(state['status'], 'waiting-for-quiet')
        self.assertEqual(update_agent.parse_time(state['automaticPauseAt']), pause_at)
        self.assertEqual(state['message'], pause.WILL_PAUSE % (WORK, pause.clock(pause_at)))
        self.assertEqual(self.apply_calls(), [])
        self.assertIsNone(self.read_config().get('installRequestedAt'))

    def assert_not_paused(self, state):
        self.assertEqual((state['status'], state['message']), ('waiting-for-quiet', pause.NOT_PAUSED % WORK))
        self.assertIn('Choose Update now', state['message'])  # The sidebar's button.
        self.assertIsNone(state['automaticPauseAt'])
        self.assertIsNone(self.read_config().get('installRequestedAt'))
        self.assertEqual(self.apply_calls(), [])

    def test_waits_for_the_grace_before_pausing(self):
        before = self.now()
        state = self.busy_pass()
        since = update_agent.parse_time(state['automaticWaitSince'])
        self.assertTrue(before <= since <= update_agent.parse_time(state['automaticLastBusyAt']) <= self.now())
        self.assert_waiting(state, since + datetime.timedelta(minutes=10))
        self.assertIn('running work will be paused at', state['message'])
        self.advance(4)  # A pass the desktop started before the pause time: not yet.
        state = self.busy_pass()
        self.assertEqual(update_agent.parse_time(state['automaticWaitSince']), since)  # The first refusal counts.
        self.assert_waiting(state, since + datetime.timedelta(minutes=10))
        self.assertEqual(self.hold.prepared(), [])

    def test_the_grace_counts_from_the_start_of_the_pass(self):
        self.control(snapshotFail=True, snapshotError=BUSY, snapshotSleep=1.2)
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        since, busy = (update_agent.parse_time(state[key]) for key in ('automaticWaitSince', 'automaticLastBusyAt'))
        self.assertGreaterEqual(busy - since, datetime.timedelta(seconds=1))  # Stamped before the slow snapshot.

    def test_an_unscheduled_pass_before_the_pause_time_never_pauses(self):
        since = update_agent.parse_time(self.busy_pass()['automaticWaitSince'])
        self.advance(9)  # The desktop started this pass (app start, startAgent): one minute early.
        self.assert_waiting(self.busy_pass(), since + datetime.timedelta(minutes=10))
        self.assertEqual(self.hold.prepared(), [])
        self.advance(1)  # The next scheduled pass, at the time shown.
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(len(self.hold.prepared()), 1)
        self.assertEqual(self.state()['status'], 'installed')

    def test_the_pause_time_is_the_first_scheduled_pass_after_the_grace(self):
        self.config(pauseWorkAfterMinutes=15)
        since = update_agent.parse_time(self.busy_pass()['automaticWaitSince'])
        pause_at = since + datetime.timedelta(minutes=20)  # No pass runs at 15 minutes: the one at 20 pauses.
        for minutes in (10, 6):  # 10, and 16: a pass the desktop started after the grace but before that one.
            self.advance(minutes)
            self.assert_waiting(self.busy_pass(), pause_at)
        self.assertEqual(self.hold.prepared(), [])
        self.advance(4)
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(len(self.hold.prepared()), 1)
        config = {'automaticPausePostponedUntil': update_agent.iso(since + datetime.timedelta(minutes=25))}
        self.assertEqual(pause.pause_at(config, since), since + datetime.timedelta(minutes=30))  # A Later, likewise.
        self.assertEqual(pause.pause_at({'pauseWorkAfterMinutes': 1}, since), since + pause.START_INTERVAL)

    def test_the_drain_stops_offering_later(self):
        seen = {}

        def look():
            state = json.loads((self.updates / 'state.json').read_text())
            seen.update(message=state['message'], pause=state['automaticPauseAt'])
            self.control()
            return {'held': True}
        self.busy_pass()
        self.advance(10)
        self.on_prepare = look
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(seen, {'message': pause.PAUSING % '0.2.0', 'pause': None})  # Saved before the drain ran.

    def test_the_pass_that_starts_the_grace_never_pauses(self):
        self.config(pauseWorkAfterMinutes=1)
        self.control(snapshotFail=True, snapshotError=BUSY, snapshotSleep=0.5)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.hold.prepared(), [])
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')

    def test_the_grace_starts_again_after_a_gap_or_an_unpublished_pause(self):
        first = update_agent.parse_time(self.busy_pass()['automaticWaitSince'])
        self.advance(21)  # More than two passes without a busy refusal (the Mac slept).
        state = self.busy_pass()
        since = update_agent.parse_time(state['automaticWaitSince'])
        self.assertGreaterEqual(since - first, datetime.timedelta(minutes=21))
        self.assert_waiting(state, since + datetime.timedelta(minutes=10))
        self.advance(10)
        self.control(snapshotFail=True, snapshotError='REFUSAL timeout lsof')  # Publishes no pause time.
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertIsNone(self.state()['automaticPauseAt'])
        self.advance(10)
        state = self.busy_pass()
        again = update_agent.parse_time(state['automaticWaitSince'])
        self.assertGreaterEqual(again - since, datetime.timedelta(minutes=20))
        self.assert_waiting(state, again + datetime.timedelta(minutes=10))
        self.assertEqual(self.hold.prepared(), [])

    def test_drains_then_requests_a_forced_install_and_installs_in_the_same_run(self):
        self.busy_pass()
        self.advance(10)
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('installed', '0.2.0'))
        # Drained before any request was written: the hold's session row never splits a snapshot and apply.
        self.assertEqual(self.hold.calls[0], ('new', 'm4', self.home, True))
        self.assertEqual(self.hold.prepared(), [('prepare', None)])
        self.assertEqual(self.hold.released(), [])  # The install ends the hold.
        config = self.read_config()
        self.assertEqual((config['installMode'], config['installRequest']['version']), ('force', '0.2.0'))
        self.assertEqual(state['handledInstallRequestAt'], config['installRequestedAt'])
        held = update_agent.parse_time(config['installHoldUntil']) - update_agent.parse_time(config['installRequestedAt'])
        self.assertEqual(held, datetime.timedelta(minutes=update_request.HOLD_MAX_MINUTES))
        # The forced request's snapshot names it, so update.py may reap what the drain left behind.
        self.assertIn('--request', self.snapshot_calls()[-1]['argv'])
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual((state['automaticWaitSince'], state['automaticPauseAt'], state['automaticLastBusyAt']),
                         (None, None, None))
        self.assertEqual(state['automaticPausedAt']['version'], '0.2.0')
        self.assertIn('paused running work for SpecWithCode 0.2.0 (1 thread, 1 turn, 0 terminals)', self.log)

    def test_the_real_service_hold_runs_the_service_cli_out_of_the_background(self):
        """service_hold.ServiceHold itself, against a stand-in for the service's CLI wrapper."""
        cli = self.home / '.local/bin/specweave-studio'
        cli.parent.mkdir(parents=True)
        calls = self.home / 'cli-calls.txt'
        cli.write_text('#!/bin/sh\necho "$@" >> %s\nrm -f %s\n'
                       'echo \'{"held": true, "stoppedThreads": 2, "interruptedRuns": 1, "openTerminals": 1}\'\n'
                       % (calls, self.home / 'fake-control.json'))
        cli.chmod(0o755)
        self.busy_pass()
        self.advance(10)
        # The test home installs 0.1.4, older than the CLI command (that refusal is the unsupported case).
        with mock.patch.object(pause, 'HOLD', service_hold.ServiceHold), \
                mock.patch.object(service_hold, 'PREPARE_UPDATE_SINCE', (0, 1, 0)):
            self.control(snapshotFail=True, snapshotError=BUSY)
            self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.state()['status'], 'installed', self.log)
        self.assertEqual(calls.read_text().split(), ['service', 'prepare-update', '--base-dir', str(self.own),
                                                     '--stop-work', '--hold', '--reason', 'install', '--json'])
        self.assertIn('(2 threads, 1 turn, 1 terminal)', self.log)

    def test_services_without_the_cli_credential_wait_for_quiet_without_a_pause(self):
        # Their `service prepare-update` opens the live database read-write to add its session.
        self.credential.unlink()
        for _ in range(3):
            state = self.busy_pass()
            self.assertEqual((state['status'], state['message']), ('waiting-for-quiet', WORK))
            self.assertEqual((state['automaticPauseAt'], state['automaticWaitSince']), (None, None))
            self.advance(10)
        self.assertEqual(self.hold.prepared(), [])
        self.assertEqual(self.apply_calls(), [])
        # An unreadable installation.json is not proof of a new enough release either.
        (self.own / 'installation.json').write_text('{')
        self.assertFalse(pause.supported(mock.Mock(identity='m4', home=self.home)))

    def test_later_postpones_the_pause(self):
        state = self.busy_pass()
        since = update_agent.parse_time(state['automaticWaitSince'])
        postponed = since + datetime.timedelta(minutes=30)
        self.config(automaticPausePostponedUntil=update_agent.iso(postponed))
        for _ in range(2):  # The passes at 10 and 20 minutes keep waiting.
            self.advance(10)
            self.assert_waiting(self.busy_pass(), postponed)
        self.assertEqual(self.hold.prepared(), [])
        self.advance(10)
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(len(self.hold.prepared()), 1)
        self.assertEqual(self.state()['status'], 'installed')

    def test_a_later_written_during_the_snapshot_is_honoured(self):
        since = update_agent.parse_time(self.busy_pass()['automaticWaitSince'])
        postponed = since + datetime.timedelta(minutes=70)
        real = update_agent.Agent.take_snapshot

        def snapshot_then_later(agent, *args, **kwargs):
            value = real(agent, *args, **kwargs)
            self.config(automaticPausePostponedUntil=update_agent.iso(postponed))  # Pressed while it ran.
            return value
        self.advance(10)
        with mock.patch.object(update_agent.Agent, 'take_snapshot', snapshot_then_later):
            state = self.busy_pass()
        self.assert_waiting(state, postponed)
        self.assertEqual(self.hold.prepared(), [])

    def test_a_longer_grace_from_settings_is_respected(self):
        self.config(pauseWorkAfterMinutes=30)
        since = update_agent.parse_time(self.busy_pass()['automaticWaitSince'])
        for _ in range(2):
            self.advance(10)
            self.assert_waiting(self.busy_pass(), since + datetime.timedelta(minutes=30))
        self.assertEqual(self.hold.prepared(), [])

    def test_invalid_pause_settings_are_refused(self):
        for values in ({'pauseWorkAfterMinutes': 0}, {'pauseWorkAfterMinutes': '10'},
                       {'automaticPausePostponedUntil': 5}):
            with self.subTest(values=values):
                self.config(**values)
                self.assertEqual(self.run_agent(), 1)
                self.assertEqual(self.state()['message'], 'Update settings are invalid')

    def test_a_drain_that_cannot_run_releases_its_hold_and_keeps_waiting(self):
        no_request = mock.patch.object(update_request, 'write_request',
                                       side_effect=update_request.RequestError('settings changed'))
        failures = (('timeout', raises(service_hold.HoldUnavailable('no answer within 200s')), None, True),
                    ('unsupported', raises(service_hold.HoldUnsupported('M4 runs 1.0.44')), None, False),
                    ('not held', lambda: {'held': False, 'stoppedThreads': 0}, None, True),
                    ('no request', lambda: {'held': True}, no_request, True))
        for name, failure, patcher, released in failures:
            with self.subTest(name):
                if (self.updates / 'state.json').exists():
                    self.edit_state(automaticPausedAt=None)  # Each failure is the version's first drain.
                self.busy_pass()
                self.advance(10)
                self.on_prepare = failure
                before = (len(self.hold.prepared()), len(self.hold.released()))
                self.control(snapshotFail=True, snapshotError=BUSY)
                with patcher or mock.patch.object(pause, 'HOLD', self.hold):
                    self.assertEqual(self.run_agent(), 0, self.log)
                self.assertEqual(len(self.hold.prepared()), before[0] + 1)
                # Nothing was held when the CLI has no such command; every other failure lets work start again.
                self.assertEqual(len(self.hold.released()), before[1] + int(released))
                self.assert_not_paused(self.state())
                self.assertEqual(self.state()['automaticPausedAt']['version'], '0.2.0')
                self.assertIn('could not pause running work', self.log)
                self.advance(30)

    def test_a_release_that_fails_is_logged(self):
        self.busy_pass()
        self.advance(10)
        self.on_prepare = lambda: {'held': False}
        self.on_release = raises(service_hold.HoldUnavailable('no answer within 60s'))
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(len(self.hold.released()), 1)
        self.assertIn('could not release the service hold (HoldUnavailable: no answer within 60s)', self.log)
        self.assert_not_paused(self.state())

    def test_one_automatic_drain_per_version_per_hour(self):
        self.on_prepare = lambda: {'held': False}
        self.busy_pass()
        self.advance(10)
        self.busy_pass()
        self.assertEqual(len(self.hold.prepared()), 1)
        for _ in range(5):  # 20 to 60 minutes: the person is asked to choose Install now; no second drain.
            self.advance(10)
            self.assert_not_paused(self.busy_pass())
        self.assertEqual(len(self.hold.prepared()), 1)
        self.advance(10)  # 70 minutes: the hour has passed, a new grace is published.
        state = self.busy_pass()
        self.assertEqual(update_agent.parse_time(state['automaticPauseAt']),
                         update_agent.parse_time(state['automaticWaitSince']) + datetime.timedelta(minutes=10))
        self.advance(10)
        self.busy_pass()
        self.assertEqual(len(self.hold.prepared()), 2)

    def test_installs_turned_off_during_the_drain_release_the_hold(self):
        def turn_off():
            self.config(installAutomatically=False)
            return {'held': True}
        self.busy_pass()
        self.advance(10)
        self.on_prepare = turn_off
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual((self.state()['status'], self.state()['message']),
                         ('downloaded', update_agent.recovery.SETTINGS_CHANGED))
        self.assertIsNone(self.read_config().get('installRequestedAt'))
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(len(self.hold.released()), 1)

    def test_update_now_pressed_during_the_drain_keeps_the_hold(self):
        requested = {}

        def update_now():
            now = self.now()
            requested['at'] = update_agent.iso(now)
            self.config(installMode='force', installRequestedAt=requested['at'],
                        installHoldUntil=update_agent.iso(now + datetime.timedelta(minutes=15)))
            self.control()
            return {'held': True}
        self.busy_pass()
        self.advance(10)
        self.on_prepare = update_now
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.hold.released(), [])  # Update now's own request serves the hold.
        self.assertEqual(self.read_config()['installRequestedAt'], requested['at'])
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt']), ('installed', requested['at']))

    def test_refusals_that_are_not_running_work_never_pause(self):
        self.busy_pass()
        self.advance(10)
        for error in ('Traceback (most recent call last):\nOSError: database is locked', 'REFUSAL timeout lsof',
                      'REFUSAL idle-agents codex=1 wait=30'):
            with self.subTest(error=error):
                self.control(snapshotFail=True, snapshotError=error)
                self.assertEqual(self.run_agent(), 0, self.log)
                state = self.state()
                self.assertEqual(state['status'], 'waiting-for-quiet')
                self.assertIsNone(state['automaticPauseAt'])
        self.assertEqual(self.hold.prepared(), [])

    def assert_forgotten(self, state):
        self.assertEqual((state['automaticWaitSince'], state['automaticPauseAt'], state['automaticLastBusyAt']),
                         (None, None, None))

    def test_the_wait_is_forgotten_when_idle_turned_off_disabled_or_up_to_date(self):
        self.busy_pass()
        self.control()  # Idle: the quiet period starts and nothing waits on work.
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual(state['status'], 'waiting-for-quiet')
        self.assert_forgotten(state)
        self.busy_pass()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual(state['status'], 'downloaded')
        self.assert_forgotten(state)
        self.config()
        self.busy_pass()
        self.config(checkAutomatically=False)
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual(state['status'], 'disabled')
        self.assert_forgotten(state)
        self.config()
        self.assertIsNotNone(self.busy_pass()['automaticWaitSince'])
        self.write_installation('0.2.0', agent_tests.NEW_COMMIT)  # Installed meanwhile, by another path.
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual(state['status'], 'up-to-date')
        self.assert_forgotten(state)

    def test_a_new_version_waits_afresh(self):
        first = update_agent.parse_time(self.busy_pass()['automaticWaitSince'])
        self.fake.add_release('0.3.0')
        self.advance(61)  # The next scheduled check finds 0.3.0 and downloads it.
        state = self.busy_pass()
        self.assertEqual(state['downloadedVersion'], '0.3.0')
        since = update_agent.parse_time(state['automaticWaitSince'])
        self.assertTrue(since - first >= datetime.timedelta(minutes=61))
        self.assertEqual(update_agent.parse_time(state['automaticPauseAt']), since + datetime.timedelta(minutes=10))
        self.assertEqual(self.hold.prepared(), [])

    def test_a_refused_explicit_request_clears_the_pause_time(self):
        self.assertIsNotNone(self.busy_pass()['automaticPauseAt'])
        self.config(installMode='force', installRequestedAt=update_agent.iso(self.now()),
                    installHoldUntil=update_agent.iso(self.now() + datetime.timedelta(minutes=15)))
        self.control(snapshotFail=True, snapshotError=BUSY)
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual((state['status'], state['message']), ('waiting-for-quiet', WORK))
        self.assertEqual((state['automaticPauseAt'], state['automaticWaitSince']), (None, None))
        self.assertEqual(self.hold.prepared(), [])

    def test_an_explicit_request_never_drains(self):
        self.config(installAutomatically=False, installMode='force', installRequestedAt=update_agent.iso(self.now()),
                    installHoldUntil=update_agent.iso(self.now() + datetime.timedelta(minutes=15)))
        self.control(snapshotFail=True, snapshotError=BUSY)
        code = self.run_agent()
        state = self.state()
        # It waits as an Update now does, inside its own window, and ends waiting: no drain, no pause time.
        self.assertEqual((code, state['status'], state['message']), (0, 'waiting-for-quiet', WORK))
        self.assertEqual(self.hold.prepared(), [])
        self.assertIsNone(state['automaticPauseAt'])
        self.assertEqual(self.apply_calls(), [])


class Shipping(unittest.TestCase):
    def test_the_agent_installs_its_new_modules_beside_itself(self):
        for name in ('update_agent_pause.py', 'service_hold.py'):
            self.assertIn(name, update_request.AGENT_FILES)
        self.assertIs(update_agent.pause, pause)
        self.assertIs(pause.service_hold, service_hold)

    def test_the_automatic_pause_needs_the_cli_credential_and_the_rollout_keeps_its_own_gate(self):
        self.assertEqual(pause.CLI_CREDENTIAL, ('secrets', 'local-cli-credential.bin'))
        self.assertEqual(service_hold.PREPARE_UPDATE_SINCE, (1, 0, 45))
        import fleet_rollout
        self.assertIs(fleet_rollout.PREPARE_UPDATE_SINCE, service_hold.PREPARE_UPDATE_SINCE)

    def test_restart_faults_are_update_pys_own_texts(self):
        spec = importlib.util.spec_from_file_location('update_for_pause_texts', str(HERE / 'update.py'))
        update = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(update)
        self.assertIs(pause.RESTART_FAULTS['detached'], service_handles.DETACHED_DATABASE)
        self.assertIs(pause.RESTART_FAULTS['locks-lost'], service_handles.LOCKS_LOST)
        # Every code update.py prints has its text, the very one its refusal raised.
        self.assertEqual({code: pause.RESTART_FAULTS[code] for code in update.DATABASE_RESTART_REASONS.values()},
                         {code: text for text, code in update.DATABASE_RESTART_REASONS.items()})
        unknown = update_agent.refusal_reason('REFUSAL restart-needed something-new', 'failed')
        self.assertEqual(unknown[0], 'error')
        self.assertNotIn('Update now', unknown[1])
        self.assertIn('SpecWithCode will try again; if this persists, restart the Mac', unknown[1])

    def test_restart_needed_asks_for_update_now(self):
        """An agent's restart-needed error carries update.py's own guidance, not "Restart SpecWithCode"."""
        reason = update_agent.refusal_reason
        prefix = 'SpecWithCode cannot be updated right now: '
        self.assertEqual(reason('REFUSAL restart-needed detached', 'failed'),
                         ('error', prefix + service_handles.DETACHED_DATABASE))
        self.assertEqual(reason('REFUSAL restart-needed locks-lost other=1', 'failed'),
                         ('error', prefix + service_handles.LOCKS_LOST))
        self.assertNotIn('Restart SpecWithCode, then update', reason('REFUSAL restart-needed', 'failed')[1])
        self.assertEqual(reason('REFUSAL restart-needed detached restarted=1', 'failed'),
                         ('waiting-for-quiet', pause.RECOVERING[1]))
        for detail in ('wait=540', 'retry=1'):
            self.assertEqual(reason('REFUSAL restart-needed detached ' + detail, 'failed'),
                             ('waiting-for-quiet', pause.RECOVERING[0]))


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
