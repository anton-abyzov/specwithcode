#!/usr/bin/env python3
"""Update agent tests for install requests: Update now retrying within one pass, cancels, and
requests bound to the version the desktop showed. Split from test-update-agent.py, whose
temporary homes, loopback fake GitHub API and fake helper these reuse.

Run: cd scripts/studio-fleet && python3 -B test-update-agent-install.py
Nothing here touches a real Studio home, launchd, GitHub or gh.
"""
import datetime
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import update_agent  # noqa: E402
import update_request  # noqa: E402

_spec = importlib.util.spec_from_file_location('agent_tests_for_install', str(HERE / 'test-update-agent.py'))
agent_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_tests)
AgentCase, later = agent_tests.AgentCase, agent_tests.later


class InstallNow(AgentCase):
    """An install request retries within one pass instead of waiting for the next launchd run."""
    REQUESTED = '2026-10-12T20:00:00+00:00'

    def request(self, mode='force', hold_minutes=15, **values):
        values.setdefault('installHoldUntil', later(hold_minutes) if mode == 'force' else None)
        values.setdefault('installRequestedAt', self.REQUESTED)
        self.config(installAutomatically=False, quietMinutes=60, installMode=mode, **values)

    def messages(self):
        seen = []
        self.on_sleep = lambda: seen.append(self.state()['message'])
        return seen

    def test_only_forced_snapshots_pass_their_request_to_the_verified_helper(self):
        self.fake.add_release()
        self.request()
        self.assertEqual(self.run_agent(), 0)
        argv = self.snapshot_calls()[0]['argv']
        self.assertEqual(argv[argv.index('--request') + 1], self.REQUESTED)

    def test_automatic_and_normal_snapshots_do_not_request_the_held_shortcut(self):
        self.fake.add_release()
        self.request(mode='normal')
        self.assertEqual(self.run_agent(), 0)
        self.assertNotIn('--request', self.snapshot_calls()[0]['argv'])

    def test_refused_twice_then_idle_installs_in_the_same_pass(self):
        self.fake.add_release()
        self.request()
        self.control(snapshotFailures=2)
        seen = self.messages()
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'installed')
        self.assertEqual(state['handledInstallRequestAt'], self.REQUESTED)
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (3, 1))
        self.assertEqual(self.sleeps, [update_agent.RETRY_SECONDS] * 2)
        self.assertEqual(seen, ['Waiting for running tasks, queued messages and open questions to finish (attempt 1)',
                                'Waiting for running tasks, queued messages and open questions to finish (attempt 2)'])

    def test_a_plain_request_retries_briefly_then_waits_for_quiet(self):
        self.fake.add_release()
        self.request(mode='normal')
        self.control(snapshotFail=True)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'waiting-for-quiet')
        self.assertEqual(state['message'], 'Waiting for running tasks, queued messages and open questions to finish')
        self.assertIsNone(state['handledInstallRequestAt'])  # Still pending for the next pass.
        self.assertLessEqual(self.offset, update_agent.REQUEST_WINDOW)
        self.assertGreater(len(self.snapshot_calls()), 3)
        self.assertEqual(self.apply_calls(), [])

    def test_a_forced_request_retries_until_the_hold_ends(self):
        self.fake.add_release()
        self.request(hold_minutes=1)
        self.control(snapshotFail=True)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertLessEqual(self.offset, datetime.timedelta(minutes=1))
        self.assertGreaterEqual(len(self.snapshot_calls()), 5)
        # A hold far in the future is capped (15 minutes; 2 here to keep the test short).
        self.request(installHoldUntil=later(600), installRequestedAt='2026-10-12T21:00:00+00:00')
        self.offset, before = datetime.timedelta(0), len(self.snapshot_calls())
        with mock.patch.object(update_agent, 'FORCE_WINDOW', datetime.timedelta(minutes=2)):
            self.run_agent()
        self.assertLessEqual(self.offset, datetime.timedelta(minutes=2))
        self.assertGreater(self.offset, datetime.timedelta(minutes=1))
        self.assertLessEqual(len(self.snapshot_calls()) - before, 13)
        self.assertEqual(update_agent.FORCE_WINDOW, datetime.timedelta(minutes=15))

    def test_cancel_stops_the_loop_and_drops_the_request(self):
        self.fake.add_release()
        self.request()
        self.control(snapshotFail=True)
        self.on_sleep = lambda: self.request(installCancelledAt=later(seconds=1))
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['message']), ('downloaded', 'Update cancelled'))
        self.assertEqual(state['handledInstallRequestAt'], self.REQUESTED)
        self.assertEqual((len(self.snapshot_calls()), self.apply_calls()), (1, []))
        # The cancelled request is not picked up again.
        self.control()
        self.run_agent()
        self.assertEqual(self.state()['status'], 'downloaded')
        self.assertEqual(self.apply_calls(), [])

    def test_a_request_cancelled_before_the_pass_never_installs(self):
        self.fake.add_release()
        self.request(installCancelledAt=later(seconds=5))
        self.run_agent()
        self.assertEqual(self.state()['status'], 'downloaded')
        self.assertEqual(self.state()['handledInstallRequestAt'], self.REQUESTED)
        self.assertEqual(self.snapshot_calls(), [])

    def test_cancel_after_an_idle_snapshot_still_stops_before_applying(self):
        self.fake.add_release()
        self.request(installCancelledAt=None)
        real = update_agent.Agent.take_snapshot

        def then_cancel(agent, *args):
            result = real(agent, *args)
            self.request(installCancelledAt=later(seconds=1))
            return result
        with mock.patch.object(update_agent.Agent, 'take_snapshot', then_cancel):
            self.run_agent()
        self.assertEqual(self.state()['message'], 'Update cancelled')
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(list((self.updates / 'snapshots').iterdir()), [])

    def test_a_cancel_that_races_the_installing_status_still_stops_the_install(self):
        self.fake.add_release()
        self.request(installCancelledAt=None)
        real = update_agent.Agent.set_status

        def cancel_meanwhile(agent, status, message):
            real(agent, status, message)
            if status == 'installing':
                self.request(installCancelledAt=later(seconds=1))
        with mock.patch.object(update_agent.Agent, 'set_status', cancel_meanwhile):
            self.run_agent()
        state = self.state()
        self.assertEqual((state['status'], state['message']), ('downloaded', 'Update cancelled'))
        self.assertEqual(self.apply_calls(), [])
        self.assertFalse((self.updates / 'install-in-progress.json').exists())

    def test_a_snapshot_timeout_has_its_own_message(self):
        self.fake.add_release()
        self.control(snapshotSleep=5)
        with mock.patch.object(update_agent, 'SNAPSHOT_TIMEOUT', 1):
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertEqual(self.state()['message'], update_agent.TIMED_OUT)
        self.assertEqual(update_agent.refusal_reason('', 'timeout'), ('waiting-for-quiet', update_agent.TIMED_OUT))

    def test_refusal_lines_map_to_messages(self):
        self.fake.add_release()
        terminals = 'Waiting for open SpecWithCode terminals and agent processes to close'
        cases = (('REFUSAL native-work runs=2 requests=1 effects=0 sessions=0', 'waiting-for-quiet',
                  'Waiting for running tasks, queued messages and open questions to finish (2 running tasks, 1 open request)'),
                 ('REFUSAL native-work', 'waiting-for-quiet',
                  'Waiting for running tasks, queued messages and open questions to finish'),
                 # Queued messages are named as such; held ones never block, so they are not.
                 ('REFUSAL native-work runs=0 queued=2 requests=0 effects=0 sessions=0 held=13', 'waiting-for-quiet',
                  'Waiting for running tasks, queued messages and open questions to finish (2 queued messages)'),
                 ('REFUSAL descendants node=1 zsh=2', 'waiting-for-quiet', terminals + ' (node, zsh x2)'),
                 ('REFUSAL descendants no-supervisor', 'waiting-for-quiet', terminals),
                 ('REFUSAL timeout lsof', 'waiting-for-quiet', update_agent.TIMED_OUT),
                 ('OSError: database is locked\nREFUSAL busy OperationalError', 'waiting-for-quiet', update_agent.WAITING),
                 # The structured line wins over an older phrase in the same output.
                 ('AssertionError: Owned service has unexpected descendants\nREFUSAL native-work runs=1',
                  'waiting-for-quiet', 'Waiting for running tasks, queued messages and open questions to finish (1 running task)'),
                 ('AssertionError: The SpecWithCode service is not running\nREFUSAL environment The SpecWithCode service is not running',
                  'error', 'SpecWithCode cannot be updated right now: The SpecWithCode service is not running'),
                 ('sqlite3.DatabaseError: database disk image is malformed\n'
                  'REFUSAL environment The SpecWithCode database could not be read (database disk image is malformed)',
                  'error', 'SpecWithCode cannot be updated right now: '
                  'The SpecWithCode database could not be read (database disk image is malformed)'))
        for output, status, message in cases:
            with self.subTest(output=output):
                self.control(snapshotFail=True, snapshotError=output)
                self.assertEqual(self.run_agent(), 1 if status == 'error' else 0)
                state = self.state()
                # The test home publishes no CLI credential: no pause is announced.
                self.assertIsNone(state['automaticPauseAt'])
                self.assertEqual((state['status'], state['message']), (status, message))
                self.assertNotIn('REFUSAL', self.log)

    def test_an_environment_refusal_ends_a_forced_request_at_once(self):
        self.fake.add_release()
        self.request()
        self.control(snapshotFail=True, snapshotError='REFUSAL environment Port belongs to another process')
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.snapshot_calls()), 1)
        self.assertEqual(self.sleeps, [])

    def test_forced_install_retries_a_refusal_before_the_restart(self):
        self.fake.add_release()
        self.request()
        self.control(applyRefusals=1)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'installed')
        self.assertEqual(state['lastInstall']['result'], 'updated')
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (2, 2))
        prestates = [call['argv'][call['argv'].index('--prestate') + 1] for call in self.apply_calls()]
        self.assertNotEqual(prestates[0], prestates[1])  # Each attempt applies a fresh snapshot.

    def test_forced_retries_are_bounded_and_then_recorded_as_failed(self):
        self.fake.add_release()
        self.request()
        self.control(applyRefusals=9)
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('error', 'failed'))
        self.assertEqual(state['answeredInstallRequestAt'], self.REQUESTED)  # settle() names what it settles.
        self.assertEqual(len(self.apply_calls()), 1 + update_agent.APPLY_RETRIES)
        self.assertFalse((self.updates / 'install-in-progress.json').exists())

    PREFLIGHT_DESCENDANTS = {'phase': 'preflight', 'pointers': 'unchanged',
                             'error': 'AssertionError: Owned service has unexpected descendants'}
    # The check right before the restart (quiescence.assert_quiescence), after the pointers went back.
    RESTART_DESCENDANTS = {'phase': 'pointers-written', 'pointers': 'previous-release',
                           'rollback': 'restored-exact-owned-runtime-pointers',
                           'error': 'AssertionError: Owned service has unexpected or missing descendants'}

    def descendants_refused_once(self, hold_minutes=None, refusal=None, mode='force'):
        """The apply refuses once for a process under the service; with `hold_minutes` the
        service holds itself (updates/hold.json) that long, negative = expired."""
        self.fake.add_release()
        self.request(mode=mode)
        if hold_minutes is not None:
            hold = self.updates / 'hold.json'
            hold.write_text(json.dumps({'schemaVersion': 1, 'pid': 4242, 'expiresAt': later(hold_minutes)}))
            hold.chmod(0o600)
        self.control(applyRefusals=1, applyRefusal=refusal or self.PREFLIGHT_DESCENDANTS)
        return self.run_agent()

    def test_a_preflight_descendant_refusal_retries_while_the_service_holds(self):
        """A process appeared under the held service between the snapshot and the apply's own
        preflight: the next snapshot may reap it, so the forced apply runs again (M4, 1.0.46)."""
        self.assertEqual(self.descendants_refused_once(hold_minutes=15), 0)
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['result'], 'updated')

    def test_a_preflight_descendant_refusal_retries_without_a_hold(self):
        """Nothing stops that process without a hold, but the next snapshot waits for it to exit
        instead of ending the request as "did not install"."""
        self.assertEqual(self.descendants_refused_once(), 0)
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['result'], 'updated')

    def test_a_preflight_descendant_refusal_retries_once_the_hold_expired(self):
        self.assertEqual(self.descendants_refused_once(hold_minutes=-1), 0)
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['result'], 'updated')

    def test_a_descendant_refusal_right_before_the_restart_retries(self):
        """The same process check runs again right before the restart; its refusal puts every
        pointer back first, so the next attempt starts from the old release as before."""
        self.assertEqual(self.descendants_refused_once(refusal=self.RESTART_DESCENDANTS), 0)
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['result'], 'updated')

    def test_a_process_refusal_is_final_once_a_pointer_or_the_restart_is_in_doubt(self):
        for extra in ({'pointers': 'mixed-see-backup'}, {'rollbackError': 'AssertionError: A pointer changed'},
                      {'restartStartedAt': '2026-10-12T20:00:00+00:00'}, {'stateBackup': '/x'}):
            with self.subTest(extra=extra):
                self.setUp()  # A fresh home; every resource is released through addCleanup.
                self.assertEqual(self.descendants_refused_once(refusal={**self.RESTART_DESCENDANTS, **extra}), 1)
                self.assertEqual(len(self.apply_calls()), 1)
                self.assertEqual(self.state()['lastInstall']['result'], 'failed')

    def test_a_failure_after_the_restart_is_never_retried(self):
        self.fake.add_release()
        self.request()
        self.control(applyFailAfterRestart=True)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')

    def test_a_plain_request_retries_an_apply_refused_before_the_restart(self):
        """Update (not Update now) installs on the same press: a reconnect or a process that slipped
        in after its snapshot no longer ends the request as "did not install"."""
        self.fake.add_release()
        self.request(mode='normal')
        self.control(applyRefusals=1)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (2, 2))

    def test_snapshots_and_receipts_past_4_mib_still_retry_and_install(self):
        """Guarded snapshots grow with the service's threads (M4's 1.0.65 receipt was 1.2 MB): one
        past the 4 MiB JSON limit is still read, so its refusal retries and its install is proven."""
        counts = dict(('thread-%07d' % index, index) for index in range(200000))
        self.fake.add_release()
        self.request()
        self.control(counts=counts, applyRefusals=1, applyRefusal={'before': {'rows': {'counts': counts}}})
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (2, 2))
        receipt = pathlib.Path(state['lastInstall']['receipt'])
        self.assertGreater(receipt.stat().st_size, 2 * update_agent.LIMITS['json'])
        self.assertTrue(update_request.status(self.home, 'm4', launchd=False)['installFinalized'])

    def test_a_plain_request_retries_a_descendant_refusal(self):
        self.assertEqual(self.descendants_refused_once(mode='normal'), 0)
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['result'], 'updated')

    def test_plain_request_retries_are_bounded_and_then_recorded_as_failed(self):
        self.fake.add_release()
        self.request(mode='normal')
        self.control(applyRefusals=9)
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('error', 'failed'))
        self.assertEqual(state['answeredInstallRequestAt'], self.REQUESTED)  # settle() names what it settles.
        self.assertEqual(len(self.apply_calls()), 1 + update_agent.APPLY_RETRIES)
        self.assertEqual(state['handledInstallRequestAt'], self.REQUESTED)

    DESCENDANTS = 'AssertionError: Owned service has unexpected descendants'

    def receipt_of(self, call):
        return call['argv'][call['argv'].index('--output') + 1]

    def assert_ended_as_the_refused_apply(self, request=None):
        state = self.state()
        self.assertEqual((state['status'], state['message']),
                         ('error', 'SpecWithCode 0.2.0 did not install; SpecWithCode stayed on 0.1.4. See the update receipt.'))
        self.assertEqual(state['handledInstallRequestAt'], request or self.REQUESTED)
        self.assertEqual((state['lastInstall']['result'], state['lastInstall']['receipt']),
                         ('failed', self.receipt_of(self.apply_calls()[0])))
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertFalse((self.updates / 'install-in-progress.json').exists())

    def test_a_forced_retry_that_never_applies_before_the_hold_ends_is_the_refused_apply(self):
        """Not left pending to lapse later as "expired before it could start": it did start."""
        self.fake.add_release()
        self.request(hold_minutes=1)
        self.control(applyRefusals=1, snapshotFailAfterApply=True)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['lastInstall']['version'], '0.2.0')
        self.assert_ended_as_the_refused_apply()

    def test_a_plain_retry_waiting_on_a_process_that_stays_is_the_refused_apply(self):
        self.fake.add_release()
        self.request(mode='normal')
        self.control(applyRefusals=1, applyRefusal=self.RESTART_DESCENDANTS, snapshotFailAfterApply=True,
                     snapshotError=self.DESCENDANTS)
        seen = self.messages()
        self.assertEqual(self.run_agent(), 1)
        self.assert_ended_as_the_refused_apply()
        self.assertIn(update_agent.APPLY_RETRY_MESSAGE + '. Waiting for open SpecWithCode terminals and agent processes to close (attempt 1)', seen)
        self.offset += datetime.timedelta(minutes=11)
        self.control()
        self.run_agent()  # Settled: a later pass neither installs it nor calls it expired.
        self.assertNotEqual(self.state()['message'], update_request.EXPIRED)
        self.assertEqual(len(self.apply_calls()), 1)

    def written_during_snapshot(self, call, failing, minutes=3, **written):
        """A plain request's first apply is refused. While snapshot number `call` runs, `minutes` pass
        (by default enough for the first retry snapshot to outlast the request's window) and the
        desktop writes `written` into the settings."""
        self.fake.add_release()
        self.request(mode='normal')
        self.control(**dict({'applyRefusals': 1}, **failing))
        real = update_agent.Agent.take_snapshot

        def slow(agent, *args):
            if len(self.snapshot_calls()) > 60:  # A pass that never waits or ends fails here, not by hanging.
                raise AssertionError('The pass kept taking snapshots')
            result = real(agent, *args)
            if len(self.snapshot_calls()) == call:
                self.offset += datetime.timedelta(minutes=minutes)
                self.config(installAutomatically=False, quietMinutes=60, **written)
            return result
        with mock.patch.object(update_agent.Agent, 'take_snapshot', slow):
            return self.run_agent()

    def test_a_cancel_during_the_last_retry_snapshot_ends_as_cancelled(self):
        """Not as the refused apply: the person cancelled, and automatic installs stay unaffected."""
        code = self.written_during_snapshot(
            2, {'snapshotFailAfterApply': True}, installMode='normal', installRequestedAt=None,
            installCancelledAt=update_agent.iso(update_agent.utcnow() + datetime.timedelta(minutes=3)))
        state = self.state()
        self.assertEqual((code, state['status'], state['message']), (0, 'downloaded', update_agent.CANCELLED))
        self.assertIsNone(state['lastInstall'])
        self.assertEqual(state['handledInstallRequestAt'], self.REQUESTED)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_newer_request_written_during_the_last_retry_snapshot_installs_in_the_same_pass(self):
        """It is never ended with the older request's refused apply, and gets attempts of its own."""
        newer = '2026-10-12T20:01:00+00:00'
        code = self.written_during_snapshot(2, {'snapshotFailCalls': [2]}, installMode='normal', installRequestedAt=newer)
        state = self.state()
        self.assertEqual((code, state['status'], state['lastInstall']['result']), (0, 'installed', 'updated'))
        self.assertEqual(state['handledInstallRequestAt'], newer)
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (3, 2))

    def test_a_newer_request_gets_a_retry_window_of_its_own(self):
        """Taken on after the older request's window ran out, it waits for quiet in a window of its own."""
        newer = '2026-10-12T20:01:00+00:00'
        code = self.written_during_snapshot(2, {'snapshotFailCalls': [2, 3]}, installMode='normal', installRequestedAt=newer)
        state = self.state()
        self.assertEqual((code, state['status'], state['lastInstall']['result']), (0, 'installed', 'updated'))
        self.assertEqual(state['handledInstallRequestAt'], newer)
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (4, 2))
        self.assertEqual(self.sleeps, [update_agent.RETRY_SECONDS])  # One wait before its second snapshot.

    def test_a_newer_request_whose_snapshots_all_refuse_waits_out_a_window_of_its_own(self):
        """Taken on after the older request's window ran out, it waits between snapshots for its own
        window, then is left waiting for quiet: never ended as the older request's refused apply."""
        base = update_agent.utcnow()  # Only the waits move the clock, so the count is the same under load.
        with mock.patch.object(update_agent, 'utcnow', lambda: base + self.offset):
            code = self.written_during_snapshot(2, {'snapshotFailAfterApply': True}, installMode='normal',
                                                installRequestedAt=self.NEWER)
        state = self.state()
        self.assertEqual((code, state['status'], state['lastInstall']), (0, 'waiting-for-quiet', None))
        self.assertNotEqual(state['handledInstallRequestAt'], self.NEWER)
        self.assertEqual(len(self.apply_calls()), 1)
        waits = int(update_agent.REQUEST_WINDOW.total_seconds() // update_agent.RETRY_SECONDS) - 1
        self.assertEqual(self.sleeps, [update_agent.RETRY_SECONDS] * waits)

    def test_a_newer_request_taken_on_before_its_apply_owns_the_refusal(self):
        """Update, then Update now while the snapshot before the apply ran: the refused apply and its
        retries are the newer request's, which ends as that apply, never left pending unanswered."""
        newer = '2026-10-12T20:01:00+00:00'
        code = self.written_during_snapshot(1, {'snapshotFailAfterApply': True}, minutes=0, installMode='normal',
                                            installRequestedAt=newer)
        self.assertEqual(code, 1)
        self.assert_ended_as_the_refused_apply(request=newer)
        self.assertIs(self.state()['lastInstall']['refusedBeforeRestart'], True)

    NEWER = '2026-10-12T20:01:00+00:00'

    def taken_on_as_apply_starts(self, apply, **control):
        """A plain request; the desktop writes a newer one as apply number `apply` writes its installing status."""
        self.fake.add_release()
        self.request(mode='normal')
        self.control(**control)
        real = update_agent.Agent.set_status

        def racing(agent, status, message=None):
            real(agent, status, message)
            if status == 'installing' and len(self.apply_calls()) == apply - 1:
                self.config(installAutomatically=False, quietMinutes=60, installMode='normal', installRequestedAt=self.NEWER)
        with mock.patch.object(update_agent.Agent, 'set_status', racing):
            return self.run_agent()

    def assert_installed_for_the_newer_request(self, applies):
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual(state['handledInstallRequestAt'], self.NEWER)
        self.assertEqual(len(self.apply_calls()), applies)

    def test_a_newer_request_taken_on_as_its_apply_starts_owns_the_refusal(self):
        """Written as the apply wrote its installing status: the helper ran for the newer request."""
        self.assertEqual(self.taken_on_as_apply_starts(1, applyRefusals=1, snapshotFailAfterApply=True), 1)
        self.assert_ended_as_the_refused_apply(request=self.NEWER)

    def test_a_newer_request_taken_on_as_a_retry_applies_gets_retries_of_its_own(self):
        """That apply is the newer request's first, so two retries still follow it."""
        self.assertEqual(self.taken_on_as_apply_starts(2, applyRefusals=3), 0)
        self.assert_installed_for_the_newer_request(applies=4)

    def test_a_newer_request_taken_on_as_the_last_retry_applies_still_retries_its_refusal(self):
        """The older request spent both retries; its last apply ran for the newer one, whose first it is."""
        self.assertEqual(self.taken_on_as_apply_starts(3, applyRefusals=3), 0)
        self.assert_installed_for_the_newer_request(applies=4)

    def test_a_newer_request_after_spent_retries_gets_retries_of_its_own(self):
        """The older request used both retries; the newer one, taken on before the third apply, retries it."""
        newer = '2026-10-12T20:01:00+00:00'
        code = self.written_during_snapshot(3, {'applyRefusals': 3}, minutes=0, installMode='normal',
                                            installRequestedAt=newer)
        state = self.state()
        self.assertEqual((code, state['status'], state['lastInstall']['result']), (0, 'installed', 'updated'))
        self.assertEqual(state['handledInstallRequestAt'], newer)
        self.assertEqual(len(self.apply_calls()), 4)

    def test_a_retry_snapshot_error_after_a_refused_apply_is_shown_as_it_is(self):
        """A cause the person can act on (restart the service) is not hidden behind "did not install"."""
        self.fake.add_release()
        self.request(mode='normal')
        self.control(applyRefusals=1, snapshotFailAfterApply=True,
                     snapshotError='REFUSAL restart-needed locks-lost\nAssertionError: Native work is not idle')
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual((state['status'], state['message']), ('error', (
            'SpecWithCode cannot be updated right now: The SpecWithCode service lost its SQLite locks on its '
            'database. Press Update now: SpecWithCode restarts its background service and then updates')))
        self.assertEqual(state['handledInstallRequestAt'], self.REQUESTED)
        last = state['lastInstall']
        self.assertEqual((last['result'], last['receipt'], last['refusedBeforeRestart']),
                         ('failed', self.receipt_of(self.apply_calls()[0]), True))
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_request_asked_again_while_its_snapshot_refused_is_served_without_that_refusal(self):
        """Update now before the agent had the release: its stop held nothing, so the snapshot for
        that request refuses, and while it ran the window held the work and asked again. Written
        then, the refusal would read as the answer to the request asked under the hold (the window
        and the service's hold time it against that request); the pass serves that one instead."""
        self.fake.add_release()
        self.request()
        lost = 'AssertionError: The SpecWithCode service lost its SQLite locks on its database.'
        self.control(snapshotFailCalls=[1], snapshotError=lost + '\nREFUSAL restart-needed locks-lost')
        snapshot, set_status, statuses = update_agent.Agent.take_snapshot, update_agent.Agent.set_status, []

        def asked_again(agent, *args):
            result = snapshot(agent, *args)
            if len(self.snapshot_calls()) == 1:
                self.request(installRequestedAt=self.NEWER)
            return result

        def recorded(agent, status, message=None):
            statuses.append(status)
            set_status(agent, status, message)
        with mock.patch.object(update_agent.Agent, 'take_snapshot', asked_again), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            self.assertEqual(self.run_agent(), 0)
        self.assertNotIn('error', statuses)
        self.assertEqual([call['argv'][call['argv'].index('--request') + 1] for call in self.snapshot_calls()],
                         [self.REQUESTED, self.NEWER])
        self.assert_installed_for_the_newer_request(applies=1)

    def written_while_refused(self, newer_request, fail_calls=(1,), **control):
        """Runs a pass whose first snapshot (for REQUESTED) refuses while the desktop writes `newer_request`,
        as do the other snapshot calls in `fail_calls`; returns the agent's exit code and each (status,
        request it names) it wrote."""
        self.fake.add_release()
        self.request()
        lost = 'AssertionError: The SpecWithCode service lost its SQLite locks on its database.'
        self.control(snapshotFailCalls=list(fail_calls), snapshotError=lost + '\nREFUSAL restart-needed locks-lost',
                     **control)
        snapshot, set_status, written = update_agent.Agent.take_snapshot, update_agent.Agent.set_status, []

        def asked_meanwhile(agent, *args):
            result = snapshot(agent, *args)
            if len(self.snapshot_calls()) == 1:
                newer_request()
            return result

        def recorded(agent, status, message=None):
            set_status(agent, status, message)
            written.append((status, agent.state['answeredInstallRequestAt']))
        with mock.patch.object(update_agent.Agent, 'take_snapshot', asked_meanwhile), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            code = self.run_agent()
        return code, written

    def test_a_request_asked_again_whose_own_snapshot_refuses_names_that_request(self):
        """Served after the earlier request's refusal, the newer request's own refusal answers it: the
        service's hold for it ends on that, and the earlier refusal is written for neither."""
        code, written = self.written_while_refused(lambda: self.request(installRequestedAt=self.NEWER),
                                                   fail_calls=(1, 2))
        self.assertEqual(code, 1)
        self.assertEqual([call['argv'][call['argv'].index('--request') + 1] for call in self.snapshot_calls()],
                         [self.REQUESTED, self.NEWER])
        self.assertEqual([entry for entry in written if entry[0] == 'error'], [('error', self.NEWER)])

    def test_a_request_for_another_version_asked_as_the_snapshot_refused_is_left_to_its_own_pass(self):
        """The refusing pass neither serves nor settles it: the next pass fetches that release and installs it.
        The refusal names the request it ends, so the service's hold for the newer one does not end on it."""
        newer = later()

        def asked_for_another():
            self.fake.add_release('0.3.0')
            self.request(installRequestedAt=newer, installRequest={'at': newer, 'version': '0.3.0'})
        code, written = self.written_while_refused(asked_for_another, newVersion='0.3.0')
        self.assertEqual(code, 0)
        self.assertIn(('error', self.REQUESTED), written)
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion'], state['handledInstallRequestAt'],
                          state['answeredInstallRequestAt']), ('installed', '0.3.0', newer, newer))

    def test_a_refusal_written_after_a_run_asked_names_the_request_it_ends(self):
        """Update now starts a run while the snapshot for an earlier request refuses: the pass leaves the run's
        request to its own claim, and the refusal it writes names the earlier request, not the run's."""
        _, written = self.written_while_refused(lambda: self.request(installRequestedAt=self.NEWER, installRunId='run-2'))
        self.assertIn(('error', self.REQUESTED), written)
        self.assertNotIn(('error', self.NEWER), written)
        self.assertEqual([call['argv'][call['argv'].index('--request') + 1] for call in self.snapshot_calls()][:1],
                         [self.REQUESTED])

    def test_an_automatic_refusal_with_update_now_pressed_meanwhile_leaves_it_to_that_request(self):
        """Update now pressed while an automatic pass's snapshot ran, which then refused: the pass
        writes no refusal for the service's new hold to take as its answer, and serves the request next."""
        self.fake.add_release()
        self.config(installAutomatically=True, quietMinutes=0)
        self.control(snapshotFailCalls=[1], snapshotError='REFUSAL environment Port belongs to another process')
        snapshot, set_status, written = update_agent.Agent.take_snapshot, update_agent.Agent.set_status, []

        def asked_meanwhile(agent, *args):
            result = snapshot(agent, *args)
            if len(self.snapshot_calls()) == 1:  # What Update now writes: automatic installs stay on.
                self.config(installAutomatically=True, quietMinutes=0, installMode='force',
                            installHoldUntil=later(15), installRequestedAt=self.NEWER)
            return result

        def recorded(agent, status, message=None):
            set_status(agent, status, message)
            written.append((status, agent.state['answeredInstallRequestAt'], message))
        with mock.patch.object(update_agent.Agent, 'take_snapshot', asked_meanwhile), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            self.assertEqual(self.run_agent(), 0)
        self.assertNotIn('error', [status for status, _, _ in written])
        # The automatic pass, which served none, ended there.
        self.assertIn(('downloaded', '', update_agent.recovery.SETTINGS_CHANGED), written)
        self.assertEqual(['--request' in call['argv'] for call in self.snapshot_calls()], [False, True])
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt'], state['answeredInstallRequestAt']),
                         ('installed', self.NEWER, self.NEWER))

    def reports_an_interrupted_install(self, asked_before=False, handled=False):
        """An automatic pass reports the install an earlier pass left interrupted; Update now is pressed
        before the pass or as it reports, with an earlier request handled when `handled`. Returns each
        (status, request it names) the agent wrote."""
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.run_agent()
        state = self.state()
        state['status'] = 'installing'
        if handled:  # Once Update now was used, its handled request stays in the settings.
            self.request(installRequestedAt=self.REQUESTED)
            state['handledInstallRequestAt'] = self.REQUESTED
        (self.updates / 'state.json').write_text(json.dumps(state))
        (self.updates / 'install-in-progress.json').write_text(json.dumps(
            {'version': '0.2.0', 'receipt': str(self.updates / 'receipts' / 'x.json'), 'at': 'now'}))
        if asked_before:
            self.request(installRequestedAt=self.NEWER)
        settle, set_status, written, messages = update_agent.recovery.settle_interrupted, update_agent.Agent.set_status, [], []

        def asked_meanwhile(agent):
            if not asked_before:
                self.request(installRequestedAt=self.NEWER)
            return settle(agent)

        def recorded(agent, status, message=None):
            set_status(agent, status, message)
            written.append((status, agent.state['answeredInstallRequestAt']))
            messages.append(message or '')
        with mock.patch.object(update_agent.recovery, 'settle_interrupted', asked_meanwhile), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            self.run_agent()
        self.assertIn('was interrupted', messages[0])
        return written

    def test_an_interrupted_install_an_automatic_pass_reports_names_no_request(self):
        """Update now pressed as the pass reports it: the report answers no request, so the new hold
        stays up, and the pass serves the request next."""
        written = self.reports_an_interrupted_install()
        self.assertEqual(written[0], ('error', ''))
        self.assertIn(('installing', self.NEWER), written)
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt'], state['answeredInstallRequestAt']),
                         ('installed', self.NEWER, self.NEWER))

    def test_an_interrupted_install_reported_after_a_handled_request_names_no_request(self):
        """The same once an earlier request was handled, which stays in the settings: that request is
        not pending, so the report answers none, and the request pressed as it reports is served next."""
        written = self.reports_an_interrupted_install(handled=True)
        self.assertEqual(written[0], ('error', ''))
        self.assertIn(('installing', self.NEWER), written)
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt'], state['answeredInstallRequestAt']),
                         ('installed', self.NEWER, self.NEWER))

    def test_an_interrupted_install_reported_with_a_request_pending_names_nothing(self):
        """Pressed before the pass: the interruption may be that request's own install, so the report
        names nothing and the hold ends on it by its time, as before."""
        written = self.reports_an_interrupted_install(asked_before=True)
        self.assertEqual(written[0], ('error', None))
        self.assertEqual(self.apply_calls(), [])

    def test_a_pass_for_a_request_written_meanwhile_that_fails_before_naming_it_names_none(self):
        """The pass run once more for a request written during the last one fails reading its installation:
        it named no request yet, so it names none, not the one the last pass served."""
        self.fake.add_release()
        self.request()
        load_installation, set_status = update_agent.load_installation, update_agent.Agent.set_status
        written, asked = [], []

        def unreadable_once_asked(home, identity):
            if asked:
                raise update_agent.AgentError('SpecWithCode m4 is not installed')
            return load_installation(home, identity)

        def recorded(agent, status, message=None):
            set_status(agent, status, message)
            written.append((status, agent.state['answeredInstallRequestAt']))
            if status == 'installed' and not asked:  # Update now pressed again as the pass ends.
                self.request(installRequestedAt=self.NEWER)
                asked.append(True)
        with mock.patch.object(update_agent, 'load_installation', unreadable_once_asked), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            self.assertEqual(self.run_agent(), 1)
        self.assertEqual(written[-2:], [('installed', self.REQUESTED), ('error', None)])

    def test_a_check_that_fails_for_a_request_names_it_not_one_written_meanwhile(self):
        """GitHub fails the check a request's pass runs while Update now is pressed again: that failure
        is the earlier request's, and the newer one is served next, with its hold still up."""
        self.fake.add_release()
        self.request(checkRequestedAt=later())
        self.fake.list_status = 502
        check, set_status, written = update_agent.Agent.check, update_agent.Agent.set_status, []

        def asked_meanwhile(agent):
            if self.fake.list_status != 200:
                self.request(installRequestedAt=self.NEWER)
                try:
                    return check(agent)
                finally:
                    self.fake.list_status = 200
            return check(agent)

        def recorded(agent, status, message=None):
            set_status(agent, status, message)
            written.append((status, agent.state['answeredInstallRequestAt']))
        with mock.patch.object(update_agent.Agent, 'check', asked_meanwhile), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual([entry for entry in written if entry[0] == 'error'], [('error', self.REQUESTED)])
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt'], state['answeredInstallRequestAt']),
                         ('installed', self.NEWER, self.NEWER))

    def automatic_passes_after(self, **failing):
        """A plain request that ends failed, then two automatic passes with Install automatically on."""
        self.fake.add_release()
        self.request(mode='normal')
        self.control(**failing)
        self.assertEqual(self.run_agent(), 1)
        self.control()
        self.config(installAutomatically=True, quietMinutes=0, installMode='normal', installRequestedAt=self.REQUESTED)
        self.run_agent()
        self.run_agent()
        return self.state()

    def test_automatic_installs_go_on_after_a_request_whose_retry_never_applied(self):
        """The refusal changed nothing, so it holds nothing: the next quiet automatic pass installs."""
        state = self.automatic_passes_after(applyRefusals=1, snapshotFailAfterApply=True)
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual(len(self.apply_calls()), 2)

    def test_automatic_installs_go_on_after_a_request_refused_on_every_retry(self):
        state = self.automatic_passes_after(applyRefusals=3, applyRefusal=self.RESTART_DESCENDANTS)
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual(len(self.apply_calls()), 4)

    def test_a_request_that_failed_after_the_restart_still_holds_automatic_installs(self):
        state = self.automatic_passes_after(applyFailAfterRestart=True)
        self.assertEqual((state['status'], state['message']),
                         ('error', 'SpecWithCode 0.2.0 did not install automatically; choose Install now to retry.'))
        self.assertNotIn('refusedBeforeRestart', state['lastInstall'])
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_retry_after_a_long_apply_snapshots_within_a_window_of_its_own(self):
        """Staging and the backup can outlast a plain request's 2-minute window before the check right
        before the restart refuses: its retry still waits its own window for the process to exit."""
        self.fake.add_release()
        self.request(mode='normal')
        self.control(applyRefusals=1, applyRefusal=self.RESTART_DESCENDANTS, snapshotFailCalls=[2, 3],
                     snapshotError=self.DESCENDANTS)
        real = update_agent.Agent.apply

        def slow(agent, *args):
            self.offset += datetime.timedelta(minutes=5)
            return real(agent, *args)
        with mock.patch.object(update_agent.Agent, 'apply', slow):
            self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (4, 2))
        self.assertEqual(self.sleeps, [update_agent.RETRY_SECONDS] * 2)

    def test_a_forced_apply_refused_after_the_hold_ended_retries_within_a_window_of_its_own(self):
        """With a 40-minute APPLY_TIMEOUT the refusal before the restart can come after installHoldUntil:
        the retry still snapshots again for APPLY_RETRY_WINDOW, and every status it writes leads with
        APPLY_RETRY_MESSAGE, by which the service keeps holding itself for it."""
        self.fake.add_release()
        self.request(hold_minutes=15)
        self.control(applyRefusals=1, snapshotFailCalls=[2, 3])
        real = update_agent.Agent.apply

        def slow(agent, *args):
            self.offset += datetime.timedelta(minutes=28)
            return real(agent, *args)
        seen = self.messages()
        with mock.patch.object(update_agent.Agent, 'apply', slow):
            self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual((len(self.snapshot_calls()), len(self.apply_calls())), (4, 2))
        self.assertEqual(len(seen), 2)
        for message in seen:
            self.assertTrue(message.startswith(update_agent.APPLY_RETRY_MESSAGE + '. '), message)

    def test_a_forced_retry_past_the_hold_gives_up_once_its_own_window_ends(self):
        self.fake.add_release()
        self.request(hold_minutes=15)
        self.control(applyRefusals=1, snapshotFailAfterApply=True)
        real = update_agent.Agent.apply

        def slow(agent, *args):
            self.offset += datetime.timedelta(minutes=28)
            return real(agent, *args)
        with mock.patch.object(update_agent.Agent, 'apply', slow):
            self.assertEqual(self.run_agent(), 1)
        self.assert_ended_as_the_refused_apply()
        retries = len(self.snapshot_calls()) - 1
        self.assertGreater(retries, 1)  # Not one snapshot and out, as when clipped by installHoldUntil.
        self.assertLessEqual(retries, update_agent.APPLY_RETRY_WINDOW.total_seconds() / update_agent.RETRY_SECONDS + 1)

    def test_install_settings_are_validated(self):
        for values in ({'installMode': 'now'}, {'installHoldUntil': 5}, {'installCancelledAt': ''}):
            with self.subTest(values=values):
                self.config(**values)
                self.assertEqual(self.run_agent(), 1)
                self.assertEqual(self.state()['message'], 'Update settings are invalid')
        self.assertEqual(self.fake.requests, [])


    def test_installed_agent_imports_its_sibling_module_without_writing_bytecode(self):
        with mock.patch.object(update_agent, 'launchctl', return_value=0), \
                mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
        installed = self.home / '.specwithcode/install/updater'
        sibling = installed / 'update_agent_cache.py'
        self.assertEqual(sibling.read_bytes(), (HERE / 'update_agent_cache.py').read_bytes())
        self.assertEqual(oct(sibling.stat().st_mode & 0o777), '0o600')
        # launchd runs the installed copy alone: no repository path, PYTHONPATH or cwd help.
        env = {key: value for key, value in os.environ.items() if not key.startswith('PYTHON')}
        # Bytecode would land beside the module (inside the signed app bundle) on a Python
        # without macOS's cache prefix; the prefix here must never receive the agent's modules.
        bytecode = self.home / 'bytecode'
        result = subprocess.run([sys.executable, '-X', 'pycache_prefix=%s' % bytecode,
                                 str(installed / 'update_agent.py'), '--help'], cwd=str(self.home),
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b'background update agent', result.stdout)
        self.assertEqual(list(bytecode.rglob('update_agent*')) + list(installed.rglob('*.pyc')), [])
        result = subprocess.run([sys.executable, '-B', '-c', 'import update_agent; print(update_agent.cache.__file__)'],
                                cwd=str(installed), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=60)
        self.assertEqual(result.stdout.decode().strip(), str(sibling), result.stderr.decode())
        # Missing modules are restored before replacing the agent, including the new recovery policy.
        recovery = installed / 'update_agent_recovery.py'
        self.assertEqual(recovery.read_bytes(), (HERE / recovery.name).read_bytes())
        recovery.unlink()
        sibling.unlink()
        with mock.patch.object(update_agent, 'launchctl', return_value=0), \
                mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
        self.assertTrue(sibling.is_file())
        self.assertEqual(recovery.read_bytes(), (HERE / recovery.name).read_bytes())


class BoundRequest(AgentCase):
    """A request the desktop tied to the version it showed: only that version, and only for a while."""

    def request(self, version='0.2.0', at=None, record=None, mode='force'):
        at = at or later()
        self.config(installAutomatically=False, quietMinutes=60, installMode=mode, installRequestedAt=at,
                    installHoldUntil=later(15) if mode == 'force' else None,
                    installRequest=record if record is not None else {'at': at, 'version': version})
        return at

    def test_a_fresh_request_for_the_offered_version_installs(self):
        self.fake.add_release()
        at = self.request()
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('installed', '0.2.0'))
        self.assertEqual(state['handledInstallRequestAt'], at)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_request_for_another_version_never_installs_the_newer_one(self):
        self.fake.add_release('0.2.0')
        at = self.request(version='0.1.9')
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual(state['status'], 'error')
        self.assertEqual(state['message'], 'SpecWithCode 0.1.9 was asked for, but 0.2.0 is the update now '
                                           'available; choose Update now again to install it.')
        self.assertEqual((state['handledInstallRequestAt'], state['answeredInstallRequestAt']), (at, at))
        self.assertEqual((self.snapshot_calls(), self.apply_calls()), ([], []))
        # Settled: the next pass does not install it either.
        self.run_agent()
        state = self.state()
        self.assertEqual((state['status'], state['answeredInstallRequestAt'], self.apply_calls()),
                         ('downloaded', '', []))

    def test_a_download_that_fails_for_a_request_names_the_request_it_ends(self):
        """The service's hold for a request written while it downloaded does not end on this failure."""
        self.fake.add_release(corrupt_runtime=True)
        at, newer = self.request(), later(1)
        download, set_status, written = update_agent.Agent.download_and_verify, update_agent.Agent.set_status, []

        def asked_again(agent, meta):  # Update now pressed again, for the same version, as it downloads.
            self.request(at=newer)
            return download(agent, meta)

        def recorded(agent, status, message=None):
            set_status(agent, status, message)
            written.append((status, agent.state['answeredInstallRequestAt'], message or ''))
        with mock.patch.object(update_agent.Agent, 'download_and_verify', asked_again), \
                mock.patch.object(update_agent.Agent, 'set_status', recorded):
            self.assertEqual(self.run_agent(), 1)
        errors = [entry for entry in written if entry[0] == 'error']
        # The newer request, served by the pass run once more for it, ends on the rejected download.
        self.assertEqual([named for _, named, _ in errors], [at, newer])
        self.assertIn('checksum', errors[0][2])
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt'], state['answeredInstallRequestAt']),
                         ('error', newer, newer))
        # The same failure from a pass no request asked for names none: no hold takes it as its answer.
        self.config(installAutomatically=True, installRequestedAt=None, installRequest=None, checkRequestedAt=later())
        self.run_agent()
        state = self.state()
        self.assertEqual((state['status'], state['answeredInstallRequestAt']), ('error', ''))

    def test_a_request_for_a_release_newer_than_the_cached_one_checks_again(self):
        # The desktop saw 0.2.1 before the agent's next scheduled check; the cached 0.2.0 must not refuse it.
        self.fake.add_release('0.2.0')
        self.config(installAutomatically=False)
        self.run_agent()
        self.assertEqual(self.state()['availableVersion'], '0.2.0')
        self.fake.add_release('0.2.1')
        at = self.request(version='0.2.1')
        self.control(newVersion='0.2.1')
        self.assertEqual(self.run_agent(), 0, self.state().get('message'))
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('installed', '0.2.1'))
        self.assertEqual(state['handledInstallRequestAt'], at)

    def test_a_request_older_than_ten_minutes_lapses(self):
        self.fake.add_release()
        for mode in ('force', 'normal'):
            with self.subTest(mode=mode):
                at = self.request(at=later(-10, -5), mode=mode)
                self.assertEqual(self.run_agent(), 1)
                state = self.state()
                self.assertEqual((state['status'], state['handledInstallRequestAt']), ('error', at))
                self.assertEqual(state['message'], update_request.EXPIRED)
                self.assertEqual(state['answeredInstallRequestAt'], at)
                self.assertEqual((self.snapshot_calls(), self.apply_calls()), ([], []))
                self.run_agent()  # Settled: the next pass neither installs it nor repeats the message.
                self.assertEqual((self.state()['status'], self.apply_calls()), ('downloaded', []))
        self.assertEqual(update_request.EXPIRED,
                         'The update request expired before it could start; choose Update now again.')
        self.assertEqual(update_request.REQUEST_TTL, datetime.timedelta(minutes=10))

    def test_a_request_left_pending_by_a_pass_lapses_on_a_later_pass(self):
        self.fake.add_release()
        at = self.request(mode='normal')
        self.control(snapshotFail=True)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertIsNone(self.state()['handledInstallRequestAt'])
        self.control()  # Idle now, but nobody has followed the request for ten minutes.
        self.offset = datetime.timedelta(minutes=11)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['handledInstallRequestAt'], at)
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual((self.state()['status'], self.state()['message']), ('error', update_request.EXPIRED))

    def test_a_refused_apply_whose_retry_never_applies_never_lapses_as_unstarted(self):
        self.fake.add_release()
        at = self.request(mode='normal')
        self.control(applyRefusals=1, applyRefusal={'phase': 'pointers-written', 'pointers': 'previous-release',
                                                    'error': 'AssertionError: Owned service has unexpected descendants'},
                     snapshotFailAfterApply=True, snapshotError='AssertionError: Owned service has unexpected descendants')
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual((state['handledInstallRequestAt'], state['lastInstall']['result']), (at, 'failed'))
        self.assertIn('did not install', state['message'])
        self.control()
        self.offset = datetime.timedelta(minutes=11)
        self.run_agent()
        self.assertNotEqual(self.state()['message'], update_request.EXPIRED)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_request_dated_ahead_of_the_clock_is_settled(self):
        self.fake.add_release()
        at = self.request(at=later(6))
        self.run_agent()
        self.assertEqual(self.state()['handledInstallRequestAt'], at)
        self.assertEqual(self.apply_calls(), [])

    def test_a_request_for_the_installed_version_is_settled_without_a_check(self):
        at = self.request(version='0.1.4')
        self.config(checkAutomatically=False, installAutomatically=False, installRequestedAt=at,
                    installRequest={'at': at, 'version': '0.1.4'})
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'disabled')
        self.assertEqual(self.state()['handledInstallRequestAt'], at)
        self.assertEqual(self.fake.requests, [])

    def test_a_malformed_record_settles_the_request(self):
        self.fake.add_release()
        for record in ({'at': 'soon', 'version': '0.2.0'}, {'at': later(), 'version': 'latest'}, 'x',
                       {'at': later(), 'version': '0.2.0', 'extra': 1}):
            with self.subTest(record=record):
                at = self.request(record=record)
                self.assertEqual(self.run_agent(), 0)
                self.assertEqual(self.state()['handledInstallRequestAt'], at)
        self.assertEqual(self.apply_calls(), [])

    def test_a_request_without_its_record_keeps_the_earlier_behaviour(self):
        # An older desktop writes installRequestedAt alone; a record left from an earlier request is not its.
        self.fake.add_release()
        old = later(-60)
        self.config(installAutomatically=False, quietMinutes=60, installRequestedAt=old,
                    installRequest={'at': later(-90), 'version': '0.1.9'})
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(self.state()['handledInstallRequestAt'], old)

    def test_a_request_written_while_a_pass_holds_the_lock_is_served_before_it_ends(self):
        # The desktop's kick finds the lock taken and returns at once; without one more pass the
        # request would wait for the next launchd run and could lapse there.
        self.fake.add_release()
        self.config(installAutomatically=False, quietMinutes=60)
        check, seen = update_agent.Agent.check, {}

        def check_while_a_request_arrives(agent):
            seen['at'] = self.request()
            seen['kick'] = self.run_agent()
            state = self.updates / 'state.json'
            seen['handled'] = json.loads(state.read_text())['handledInstallRequestAt'] if state.exists() else None
            return check(agent)
        with mock.patch.object(update_agent.Agent, 'check', check_while_a_request_arrives):
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual((seen['kick'], seen['handled']), (0, None))
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('installed', '0.2.0'))
        self.assertEqual(state['handledInstallRequestAt'], seen['at'])
        self.assertEqual(len(self.apply_calls()), 1)

    def test_only_one_more_pass_runs_for_requests_written_during_passes(self):
        self.fake.add_release()
        self.config(installAutomatically=False, quietMinutes=60)
        run_pass, passes = update_agent.Agent.run_pass, []

        def pass_while_a_request_arrives(agent):
            passes.append(self.request(version='0.1.9', at=later(seconds=len(passes))))
            return run_pass(agent)
        with mock.patch.object(update_agent.Agent, 'run_pass', pass_while_a_request_arrives):
            self.run_agent()
        self.assertEqual(len(passes), 2)
        self.assertEqual(self.apply_calls(), [])
        # The last request is still pending; the next scheduled pass settles it.
        self.assertNotEqual(self.state()['handledInstallRequestAt'], passes[-1])

    def test_no_second_pass_while_an_install_marker_is_left(self):
        self.fake.add_release()
        self.config(installAutomatically=False, quietMinutes=60)
        run_pass, passes = update_agent.Agent.run_pass, []

        def pass_that_leaves_a_marker(agent):
            passes.append(self.request())
            code = run_pass(agent)
            (self.updates / 'install-in-progress.json').write_text('{}')
            return code
        with mock.patch.object(update_agent.Agent, 'run_pass', pass_that_leaves_a_marker):
            self.run_agent()
        self.assertEqual(len(passes), 1)

    def test_a_newer_request_for_another_version_ends_a_retrying_pass(self):
        self.fake.add_release('0.2.0')
        first = self.request()
        self.control(snapshotFailures=1)
        newer = {}

        def write_newer():
            newer['at'] = self.request(version='0.2.1', at=later(seconds=30))
            self.on_sleep = None
        self.on_sleep = write_newer
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual(state['status'], 'error')
        self.assertEqual(state['message'], 'SpecWithCode 0.2.1 was asked for, but 0.2.0 is the update now '
                                           'available; choose Update now again to install it.')
        self.assertEqual(state['handledInstallRequestAt'], newer['at'])
        self.assertNotEqual(first, newer['at'])
        self.assertEqual(self.apply_calls(), [])

    def test_a_newer_request_for_the_same_version_is_taken_on(self):
        self.fake.add_release('0.2.0')
        self.request()
        self.control(snapshotFailures=1)
        newer = {}

        def write_newer():
            newer['at'] = self.request(at=later(seconds=30))
            self.on_sleep = None
        self.on_sleep = write_newer
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('installed', '0.2.0'))
        self.assertEqual(state['handledInstallRequestAt'], newer['at'])
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_newer_request_that_already_lapsed_ends_a_retrying_pass(self):
        self.fake.add_release('0.2.0')
        self.request()
        self.control(snapshotFailures=1)
        newer = {}

        def write_newer():
            newer['at'] = self.request(at=later(-11))
            self.on_sleep = None
        self.on_sleep = write_newer
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual((state['status'], state['message']), ('error', update_request.EXPIRED))
        self.assertEqual((state['handledInstallRequestAt'], state['answeredInstallRequestAt']), (newer['at'], newer['at']))
        self.assertEqual(self.apply_calls(), [])

    def test_the_request_lifetime_matches_the_desktop(self):
        desktop = (HERE.parents[1] / 'apps/desktop/src/updates/studioServiceUpdates.ts').read_text()
        minutes = re.search(r'SERVICE_INSTALL_REQUEST_TTL_MS = (\d+) \* 60_000', desktop).group(1)
        self.assertEqual(datetime.timedelta(minutes=int(minutes)), update_request.REQUEST_TTL)



class HelperFolderFinderFiles(AgentCase):
    """Finder's .DS_Store in the verified helpers folder is not a change; anything else still is."""

    def test_finder_view_files_are_ignored_but_other_extras_and_links_are_refused(self):
        root = self.updates / 'helpers' / '0.2.0' / 'h'
        (root / 'scripts' / 'studio-fleet').mkdir(parents=True)
        (root / 'scripts' / 'studio-fleet' / 'update.py').write_text('print(1)\n')
        verified = {'version': '0.2.0', 'helpers': {'root': 'h', 'files': {
            'scripts/studio-fleet/update.py': update_agent.sha256_file(root / 'scripts' / 'studio-fleet' / 'update.py')}}}
        agent = update_agent.Agent(self.home, 'm4', True, lambda line: None)
        for folder in (root, root / 'scripts'):
            (folder / '.DS_Store').write_bytes(b'Bud1')
        self.assertEqual(agent.verify_helpers(verified), root / 'scripts' / 'studio-fleet')
        (root / 'notes.txt').write_text('added')
        with self.assertRaisesRegex(update_agent.AgentError, 'Verified helpers changed on disk'):
            agent.verify_helpers(verified)
        (root / 'notes.txt').unlink()
        (root / 'scripts' / '.DS_Store').unlink()
        os.symlink('studio-fleet/update.py', str(root / 'scripts' / '.DS_Store'))  # A link is never Finder's.
        with self.assertRaisesRegex(update_agent.AgentError, 'Verified helpers changed on disk'):
            agent.verify_helpers(verified)

if __name__ == '__main__':
    unittest.main()
