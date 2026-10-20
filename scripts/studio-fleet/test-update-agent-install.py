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
                self.assertEqual((self.state()['status'], self.state()['message']), (status, message))
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
        self.assertEqual(len(self.apply_calls()), 1 + update_agent.FORCE_APPLY_RETRIES)
        self.assertFalse((self.updates / 'install-in-progress.json').exists())

    PREFLIGHT_DESCENDANTS = {'phase': 'preflight', 'pointers': 'unchanged',
                             'error': 'AssertionError: Owned service has unexpected descendants'}

    def descendants_refused_once(self, hold_minutes=None):
        """The apply's preflight snapshot refuses once for a process under the service; with
        `hold_minutes` the service holds itself (updates/hold.json) that long, negative = expired."""
        self.fake.add_release()
        self.request()
        if hold_minutes is not None:
            hold = self.updates / 'hold.json'
            hold.write_text(json.dumps({'schemaVersion': 1, 'pid': 4242, 'expiresAt': later(hold_minutes)}))
            hold.chmod(0o600)
        self.control(applyRefusals=1, applyRefusal=self.PREFLIGHT_DESCENDANTS)
        return self.run_agent()

    def test_a_preflight_descendant_refusal_retries_while_the_service_holds(self):
        """A process appeared under the held service between the snapshot and the apply's own
        preflight: the next snapshot may reap it, so the forced apply runs again (M4, 1.0.46)."""
        self.assertEqual(self.descendants_refused_once(hold_minutes=15), 0)
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['result'], 'updated')

    def test_a_preflight_descendant_refusal_is_final_without_a_hold(self):
        """Without a hold nothing may stop that process, so another apply would refuse the same way."""
        self.assertEqual(self.descendants_refused_once(), 1)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')

    def test_a_preflight_descendant_refusal_is_final_once_the_hold_expired(self):
        self.assertEqual(self.descendants_refused_once(hold_minutes=-1), 1)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')

    def test_a_failure_after_the_restart_is_never_retried(self):
        self.fake.add_release()
        self.request()
        self.control(applyFailAfterRestart=True)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')

    def test_a_plain_request_does_not_retry_an_apply(self):
        self.fake.add_release()
        self.request(mode='normal')
        self.control(applyRefusals=1)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_retried_request_stays_pending_when_the_hold_runs_out(self):
        self.fake.add_release()
        self.request(hold_minutes=1)
        self.control(applyRefusals=1, snapshotFailAfterApply=True)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'waiting-for-quiet')
        self.assertIsNone(state['handledInstallRequestAt'])
        self.assertIsNone(state['lastInstall'])
        self.assertEqual(len(self.apply_calls()), 1)

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
        self.assertEqual(state['handledInstallRequestAt'], at)
        self.assertEqual((self.snapshot_calls(), self.apply_calls()), ([], []))
        # Settled: the next pass does not install it either.
        self.run_agent()
        self.assertEqual((self.state()['status'], self.apply_calls()), ('downloaded', []))

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
        self.assertEqual(state['handledInstallRequestAt'], newer['at'])
        self.assertEqual(self.apply_calls(), [])

    def test_the_request_lifetime_matches_the_desktop(self):
        desktop = (HERE.parents[1] / 'apps/desktop/src/updates/studioServiceUpdates.ts').read_text()
        minutes = re.search(r'SERVICE_INSTALL_REQUEST_TTL_MS = (\d+) \* 60_000', desktop).group(1)
        self.assertEqual(datetime.timedelta(minutes=int(minutes)), update_request.REQUEST_TTL)


if __name__ == '__main__':
    unittest.main()
