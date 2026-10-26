#!/usr/bin/env python3
"""Update agent tests for updates/run.json (0988): the agent claims the run the desktop created,
keeps its lease fresh with a heartbeat, retries until the run's deadline (the one clock), ends it
as verified, failed or cancelled, and advertises runSupport. Reuses test-update-agent.py's
temporary homes, loopback fake GitHub API and fake helper.

Run: cd scripts/studio-fleet && python3 -B test-update-agent-run.py
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
import update_agent_run as runs  # noqa: E402
import update_request  # noqa: E402

_spec = importlib.util.spec_from_file_location('agent_tests_for_runs', str(HERE / 'test-update-agent.py'))
agent_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_tests)
AgentCase, later = agent_tests.AgentCase, agent_tests.later

RUN_ID = '6f1c2a34-7d1e-4f5a-9b2c-0e1d2c3b4a59'


def iso_in(minutes=0, seconds=0):
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(minutes=minutes, seconds=seconds)).isoformat().replace('+00:00', 'Z')


class RunCase(AgentCase):
    def write_run(self, **values):
        self.updates.mkdir(mode=0o700, exist_ok=True)
        record = {'schemaVersion': 1, 'runId': RUN_ID, 'rev': 1, 'createdAt': iso_in(), 'createdBy': 'desktop',
                  'targetVersion': '0.2.0', 'fromVersion': '0.1.4', 'appTargetVersion': None,
                  'requestedAt': self.requested, 'deadlineAt': iso_in(minutes=30), 'phase': 'requested',
                  'owner': None, 'heartbeatAt': None, 'leaseUntil': None, 'message': None, 'receipt': None,
                  'endedAt': None}
        record.update(values)
        (self.updates / 'run.json').write_text(json.dumps(record))
        return record

    def run_record(self):
        return json.loads((self.updates / 'run.json').read_text())

    def request(self, run_id=RUN_ID, requested=None, **values):
        requested = requested or self.requested
        values.setdefault('installHoldUntil', iso_in(minutes=30))
        self.config(installAutomatically=False, quietMinutes=60, installMode='force', installRequestedAt=requested,
                    installRequest={'at': requested, 'version': '0.2.0'}, installRunId=run_id, **values)

    def setUp(self):
        super().setUp()
        # Requests are dated "now" so REQUEST_TTL alone never decides them, unless a test says so.
        self.requested = iso_in()


class Claim(RunCase):
    def test_a_matching_run_is_claimed_and_ends_verified_with_its_receipt(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.assertEqual(self.run_agent(), 0)
        record = self.run_record()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(record['phase'], 'verified')
        self.assertIsNone(record['owner'])
        self.assertEqual(record['receipt'], self.state()['lastInstall']['receipt'])
        self.assertIsNotNone(record['endedAt'])
        self.assertGreater(record['rev'], 1)

    def test_a_run_another_request_names_is_never_claimed(self):
        self.fake.add_release()
        before = self.write_run()
        self.request(run_id='0f0f0f0f-0000-4000-8000-000000000000')
        self.run_agent()
        self.assertEqual(self.run_record(), before)  # Not ours: untouched.
        self.assertEqual(self.state()['status'], 'installed')  # The request itself is served as before runs.

    def test_a_run_for_another_request_time_is_never_claimed(self):
        self.fake.add_release()
        before = self.write_run(requestedAt=iso_in(seconds=-30))
        self.request()
        self.run_agent()
        self.assertEqual(self.run_record(), before)

    def test_a_terminal_run_is_never_claimed_or_rewritten(self):
        self.fake.add_release()
        for phase in runs.TERMINAL:
            with self.subTest(phase=phase):
                before = self.write_run(phase=phase, endedAt=iso_in())
                self.request()
                self.run_agent()
                self.assertEqual(self.run_record(), before)

    def test_a_fresh_lease_of_another_owner_is_respected(self):
        self.fake.add_release()
        before = self.write_run(owner={'kind': 'agent', 'pid': os.getpid() + 1, 'agentVersion': 1,
                                       'claimedAt': iso_in()}, leaseUntil=iso_in(seconds=60), phase='waiting')
        self.request()
        self.run_agent()
        self.assertEqual(self.run_record(), before)
        # A lapsed lease is taken over.
        self.write_run(owner=before['owner'], leaseUntil=iso_in(seconds=-1), phase='waiting')
        self.request()
        self.state_reset()
        self.run_agent()
        self.assertEqual(self.run_record()['phase'], 'verified')

    def state_reset(self):
        path = self.updates / 'state.json'
        if path.exists():
            path.unlink()

    def test_without_install_run_id_the_pass_runs_as_before(self):
        self.fake.add_release()
        self.write_run()
        self.request(run_id=None)
        self.run_agent()
        self.assertEqual(self.run_record()['phase'], 'requested')
        self.assertEqual(self.state()['status'], 'installed')

    def test_a_malformed_run_id_is_refused_as_invalid_settings(self):
        self.request(run_id='../../etc')
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['message'], 'Update settings are invalid')


class Lease(RunCase):
    def test_the_heartbeat_advances_while_the_helper_applies(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(applySleep=1.2)
        seen = []
        real = runs.Run.renew

        def renew(run, record):
            real(run, record)
            seen.append((record['phase'], record['heartbeatAt']))
        with mock.patch.object(runs, 'HEARTBEAT_SECONDS', 0.1), mock.patch.object(runs.Run, 'renew', renew):
            self.run_agent()
        installing = [beat for phase, beat in seen if phase == 'installing']
        self.assertGreaterEqual(len(installing), 5)  # Renewed during the apply, not only at status changes.
        self.assertEqual(len(set(installing)), len(installing))
        self.assertEqual(self.run_record()['phase'], 'verified')

    def test_mirrors_waiting_then_installing(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFailures=1)
        phases = []
        self.on_sleep = lambda: phases.append((self.run_record()['phase'], self.run_record()['message']))
        self.run_agent()
        self.assertEqual(phases, [('waiting', 'Waiting for running tasks, queued messages and open questions to finish (attempt 1)')])
        self.assertEqual(self.run_record()['phase'], 'verified')

    def test_an_apply_timeout_keeps_the_run_installing_without_an_owner(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(applySleep=3)
        with mock.patch.object(update_agent, 'APPLY_TIMEOUT', 1):
            self.run_agent()
        record = self.run_record()
        self.assertEqual(record['phase'], 'installing')
        self.assertIsNone(record['owner'])
        self.assertLessEqual(update_agent.parse_time(record['leaseUntil']), update_agent.utcnow())
        self.assertIsNone(record['endedAt'])
        # The next pass settles the interrupted install and ends the run.
        import time
        time.sleep(2.5)
        self.run_agent()
        self.assertEqual(self.run_record()['phase'], 'verified')


class OneClock(RunCase):
    def test_the_retry_window_is_the_run_deadline_not_the_hold_or_force_window(self):
        self.fake.add_release()
        self.write_run(deadlineAt=iso_in(minutes=3))
        self.request(installHoldUntil=iso_in(minutes=1))
        self.control(snapshotFail=True)
        with mock.patch.object(update_agent, 'FORCE_WINDOW', datetime.timedelta(minutes=1)):
            self.run_agent()
        self.assertGreater(self.offset, datetime.timedelta(minutes=2))
        self.assertLessEqual(self.offset, datetime.timedelta(minutes=3))
        record = self.run_record()
        self.assertEqual(record['phase'], 'failed')  # The owner decides: its deadline passed before the apply.
        self.assertIn('Waiting for running tasks', record['message'])
        self.assertEqual(self.state()['handledInstallRequestAt'], self.requested)  # It never installs later on its own.

    def test_the_request_ttl_extends_to_the_run_deadline(self):
        self.fake.add_release()
        old = iso_in(minutes=-20)
        self.write_run(requestedAt=old, deadlineAt=iso_in(minutes=10))
        self.request(requested=old)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(self.run_record()['phase'], 'verified')
        state = {'handledInstallRequestAt': None}
        config = {'installRequestedAt': old, 'installRequest': {'at': old, 'version': '0.2.0'}}
        now = update_agent.utcnow()
        self.assertEqual(update_request._verdict(config, dict(state), None, now, lambda c: False), (False, update_request.EXPIRED))
        self.assertEqual(update_request._verdict(config, dict(state), None, now, lambda c: False,
                                                 ttl_until=now + datetime.timedelta(minutes=1)), (True, None))

    def test_a_cancel_ends_the_run_cancelled(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFail=True)
        self.on_sleep = lambda: self.request(installCancelledAt=later(seconds=1))
        self.run_agent()
        record = self.run_record()
        self.assertEqual((record['phase'], record['message']), ('cancelled', update_agent.CANCELLED))
        self.assertEqual(self.apply_calls(), [])

    def test_a_failed_install_ends_the_run_failed(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(applyFail=True)
        self.run_agent()
        record = self.run_record()
        self.assertEqual(record['phase'], 'failed')
        self.assertIn('did not install', record['message'])
        self.assertEqual(record['receipt'], self.state()['lastInstall']['receipt'])


class Handshake(RunCase):
    def test_state_advertises_run_support_and_keeps_it_on_reload(self):
        self.fake.add_release()
        self.config(checkAutomatically=True, installAutomatically=False)
        self.run_agent()
        self.assertEqual(self.state()['runSupport'], runs.RUN_SUPPORT)
        # An older agent rewrote state.json without the key: the next pass puts it back.
        state = self.state()
        del state['runSupport']
        (self.updates / 'state.json').write_text(json.dumps(state))
        self.run_agent()
        self.assertEqual(self.state()['runSupport'], 1)

    def test_status_reports_run_support(self):
        self.config()
        self.run_agent()
        self.log = ''
        self.run_agent('--status')
        self.assertEqual(json.loads(self.log)['runSupport'], 1)

    def test_a_headless_request_clears_a_desktop_run_id(self):
        self.request()
        written = update_request.write_request(self.home, 'm4', '0.2.0', force=True, hold_minutes=5)
        self.assertNotIn('installRunId', written)
        self.assertIsNone(json.loads((self.updates / 'config.json').read_text())['installRunId'])


class StampedLog(RunCase):
    def test_pass_lines_carry_a_timestamp_and_install_mode_json_stays_plain(self):
        self.config(checkAutomatically=False)
        self.run_agent()
        line = self.log.strip().splitlines()[-1]
        self.assertRegex(line, r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ update-agent m4: disabled')
        self.log = ''
        self.run_agent('--status')
        json.loads(self.log)  # --status prints plain JSON.
        self.assertEqual(runs.stamp('x', datetime.datetime(2026, 10, 21, 12, 0, 1, tzinfo=datetime.timezone.utc)),
                         '2026-10-21T12:00:01Z x')

    def test_errors_on_stderr_are_stamped_in_pass_mode(self):
        (self.own / 'installation.json').write_text('{}')
        self.run_agent()
        self.assertTrue(re.search(r'^\d{4}-\d\d-\d\dT\S+Z update-agent m4: error: ', self.log, re.M), self.log)


class HelperDiskIo(unittest.TestCase):
    """The apply and a held snapshot leave the agent's LowPriorityIO disk throttle (normal_disk_io).
    Beside BackgroundPriorityTests in test-update-agent.py, which is over the file-size cap."""

    def test_apply_and_held_snapshot_children_leave_the_disk_throttle(self):
        """launchd's LowPriorityIO runs the agent at IOPOL_THROTTLE (3), which children inherit; an apply
        and a held snapshot, which a person waits for, run at IOPOL_DEFAULT (0), every other child keeps it."""
        probe = 'import ctypes,sys;sys.stdout.write(str(ctypes.CDLL(None).getiopolicy_np(0,0)))'
        script = ('import ctypes,subprocess,sys;sys.path.insert(0,%r);assert ctypes.CDLL(None).setiopolicy_np(0,0,3)==0;'
                  'import update_agent;'
                  'run=lambda fn:subprocess.run([sys.executable,"-c",%r],capture_output=True,text=True,preexec_fn=fn).stdout;'
                  'sys.stdout.write(run(update_agent.leave_background)+" "+run(update_agent.leave_background_io))'
                  ) % (str(pathlib.Path(update_agent.__file__).parent), probe)
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '3 0')

    def test_only_normal_io_children_leave_the_disk_throttle(self):
        calls = []
        def record(*args, **kwargs):
            calls.append(kwargs.get('preexec_fn'))
            raise OSError('stop')
        with mock.patch.object(update_agent.subprocess, 'run', side_effect=record), \
                mock.patch.object(update_agent.subprocess, 'Popen', side_effect=record):
            for wait_detached in (False, True):
                update_agent.run_helper_process(['/usr/bin/true'], '/', {}, 5, wait_detached=wait_detached, normal_io=True)
                update_agent.run_helper_process(['/usr/bin/true'], '/', {}, 5, wait_detached=wait_detached)
        self.assertEqual(calls, [update_agent.leave_background_io, update_agent.leave_background] * 2)


if __name__ == '__main__':
    unittest.main()
