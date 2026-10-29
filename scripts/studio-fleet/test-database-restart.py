#!/usr/bin/env python3
"""An update past a service that lost its database locks (database_restart.py).

M4, 2026-10-19: the service dropped its SQLite locks, every snapshot refused with
`REFUSAL environment`, the update agent showed an error every ten minutes and nothing restarted
the service. Covers update.py's snapshot fallback (database_restart_refusal: when it restarts,
the once-per-30-minutes limit, other openers, the receipt) and the agent's text. Temporary
homes, a fake launchctl and a fake lsof; no real service.

Run: cd scripts/studio-fleet && python3 -B test-database-restart.py
"""
import contextlib
import datetime
import importlib.util
import io
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import database_restart  # noqa: E402
import update_agent  # noqa: E402

spec = importlib.util.spec_from_file_location('owned_update_database_restart', HERE / 'update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)

SCHEMA = """
CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
CREATE TABLE orchestration_events(stream_id TEXT, payload TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(request_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions(session_id TEXT, status TEXT);
INSERT INTO orchestration_v2_projection_runs VALUES ('r0', 't', 'completed');
"""
T0 = datetime.datetime(2026, 10, 19, 9, 0, tzinfo=datetime.timezone.utc)
REQUEST = '2026-10-19T08:59:00Z'
HOLD_UNTIL = '2026-10-19T09:14:00Z'  # update_request.HOLD_MAX_MINUTES after REQUEST.


class RestartFallback(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.own = self.home / '.specwithcode' / 'm4'
        (self.own / 'updates').mkdir(parents=True)
        (self.own / 'userdata').mkdir()
        self.db = self.own / 'userdata' / 'statev2.sqlite'
        self.sql(SCHEMA)
        self.settings(installAutomatically=True, installMode='normal', quietMinutes=10)
        self.openers, self.lsof_args = [100], []
        self.locks_lost = True
        self.service = {'owner': mock.Mock(uid=501, domain='gui/501'), 'home': self.home, 'own': self.own,
                        'node': pathlib.Path('/verified/node22'), 'label': 'com.specweave.studio.m4',
                        'plist': self.home / 'service.plist', 'receipt': {'port': 8319},
                        'content': {'ProgramArguments': ['/usr/bin/caffeinate', '-s', 'launch.sh']},
                        'runtime': {'pid': 100}}

        def locked(state):
            if self.locks_lost:
                raise AssertionError(update.LOCKS_LOST)

        self.during_lsof = None

        def lsof(command, **options):
            self.lsof_args.append(command)
            if self.during_lsof:
                self.during_lsof()
            found = '\n'.join(str(pid) for pid in self.openers)
            return subprocess.CompletedProcess(command, 0 if found else 1, found + '\n' if found else '', '')
        self.restart = mock.Mock()
        for target, name, value in ((update.pathlib.Path, 'home', mock.Mock(return_value=self.home)),
                                    (update, '_service', mock.Mock(return_value=self.service)),
                                    (update, 'idle_providers', mock.Mock(return_value={})),
                                    (update, 'assert_database_locked', locked),
                                    (update, 'assert_held', mock.Mock(side_effect=AssertionError(update.HOLD_REFUSAL))),
                                    (update, 'restart_service', self.restart),
                                    (update, 'wait_for_database_owner', mock.Mock(return_value=200)),
                                    (database_restart.subprocess, 'run', lsof)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def sql(self, script):
        db = sqlite3.connect(str(self.db))
        db.executescript(script)
        db.commit()
        db.close()

    def settings(self, **values):
        (self.own / 'updates/config.json').write_text(json.dumps(values))

    def refuse(self, minutes=0, error=None, request=None):
        """`request`: the explicit request the snapshot serves (update.py --request)."""
        return update.database_restart_refusal('m4', AssertionError(error or update.LOCKS_LOST),
                                               now=T0 + datetime.timedelta(minutes=minutes), request=request)

    def live_request(self, **values):
        """An Update now request the agent is serving right now: its hold window is still ahead."""
        self.settings(installMode='force', installRequestedAt=REQUEST, installHoldUntil=HOLD_UNTIL, **values)

    def records(self):
        receipts = self.own / 'updates' / 'receipts'
        return [json.loads(path.read_text()) for path in sorted(receipts.glob('database-restart-*.json'))] \
            if receipts.exists() else []

    def assert_restarted_once(self):
        self.restart.assert_called_once_with('gui/501', 'com.specweave.studio.m4', self.home / 'service.plist',
                                             None, None, 100, 8319)

    def test_an_idle_service_is_restarted_once_after_the_quiet_window(self):
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost wait=600')
        self.assertEqual(self.refuse(4), 'REFUSAL restart-needed locks-lost wait=360')
        self.restart.assert_not_called()
        self.assertEqual(self.refuse(10), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assert_restarted_once()
        [record] = self.records()
        self.assertEqual({key: record[key] for key in ('reason', 'trigger', 'servicePid', 'newServicePid', 'result')},
                         {'reason': 'locks-lost', 'trigger': 'idle', 'servicePid': 100, 'newServicePid': 200,
                          'result': 'restarted'})
        self.assertFalse((self.own / 'updates' / database_restart.QUIET_MARKER).exists())
        # lsof was asked about the database files that exist, and only the service had them open.
        self.assertEqual(self.lsof_args[-1][:4], ['/usr/sbin/lsof', '-nP', '-t', '--'])
        self.assertEqual(self.lsof_args[-1][4:], [str(self.db)])
        # The same service, still without its locks, inside 30 minutes: no second restart.
        self.assertEqual(self.refuse(11), 'REFUSAL restart-needed locks-lost wait=600')
        self.assertEqual(self.refuse(21), 'REFUSAL restart-needed locks-lost retry=1140')
        self.assert_restarted_once()
        self.assertEqual(len(self.records()), 1)
        # After the limit it may restart again.
        self.assertEqual(self.refuse(41), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual(self.restart.call_count, 2)

    def test_a_busy_service_is_not_restarted_and_the_window_starts_again(self):
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost wait=600')
        self.sql("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'running')")
        self.assertIsNone(self.refuse(10))
        self.assertFalse((self.own / 'updates' / database_restart.QUIET_MARKER).exists())
        update.idle_providers.side_effect = AssertionError('Owned service has unexpected descendants')
        self.sql("UPDATE orchestration_v2_projection_runs SET status = 'completed'")
        self.assertIsNone(self.refuse(20))
        self.restart.assert_not_called()
        self.assertEqual(self.records(), [])
        # The snapshot's own line still says a restart is needed, which the agent waits on.
        with mock.patch.object(update, 'idle_agent_refusal', return_value=None):
            self.assertEqual(update.snapshot_refusal('m4', AssertionError(update.LOCKS_LOST)),
                             'REFUSAL restart-needed locks-lost')

    def test_update_now_restarts_a_held_service_at_once_even_with_work(self):
        self.settings(installMode='force', installRequestedAt=REQUEST, installHoldUntil='2026-10-19T09:15:00Z')
        self.sql("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'running')")
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assert_restarted_once()
        self.assertEqual(update.assert_held.call_args.args[1], REQUEST)
        self.assertEqual(self.records()[0]['trigger'], 'held')

    def marker(self):
        return json.loads((self.own / 'updates' / database_restart.MARKER).read_text())

    def test_a_held_restart_carries_the_request_to_the_new_service_and_how_far_the_hold_could_move(self):
        # M4, 2026-10-28: the restart marker held only the pid and time, so the restarted
        # service started unheld, resumed the interrupted turn and every reap refused. Then the
        # carried hold could not move past the old hold's end, so a restart late in a long pass
        # left the service unheld while the agent still worked on the request. `until` stays the
        # old hold's end: services from 1.0.108 that predate `ceiling` read only that and hold to it.
        self.live_request(installRunId='run-1')
        (self.own / 'updates/hold.json').write_text(json.dumps(
            {'schemaVersion': 1, 'pid': 100, 'startedAt': '2026-10-19T08:58:50Z', 'expiresAt': '2026-10-19T09:13:50Z'}))
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual(self.marker(), {'schemaVersion': 1, 'servicePid': 100, 'restartedAt': T0.isoformat(),
                                         'request': REQUEST, 'installRunId': 'run-1',
                                         'until': '2026-10-19T09:13:50+00:00', 'ceiling': '2026-10-19T10:48:50+00:00'})

    def test_a_hold_that_ends_past_where_it_could_move_is_carried_to_its_end(self):
        self.live_request(installRunId='run-1')
        (self.own / 'updates/hold.json').write_text(json.dumps(
            {'schemaVersion': 1, 'pid': 100, 'startedAt': '2026-10-19T08:58:50Z', 'expiresAt': '2026-10-19T10:55:00Z'}))
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual((self.marker()['until'], self.marker()['ceiling']),
                         ('2026-10-19T10:55:00+00:00', '2026-10-19T10:55:00+00:00'))

    def test_a_carried_hold_restarted_again_is_carried_no_further(self):
        """A carried hold's own start is its restart, so its hold.json names how far it may move:
        a second restart carries it no further than the first one did."""
        self.live_request(installRunId='run-1')
        (self.own / 'updates/hold.json').write_text(json.dumps(
            {'schemaVersion': 1, 'pid': 100, 'startedAt': '2026-10-19T08:59:30Z', 'expiresAt': '2026-10-19T09:14:30Z',
             'request': REQUEST, 'ceiling': '2026-10-19T09:30:00Z'}))
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual((self.marker()['until'], self.marker()['ceiling']),
                         ('2026-10-19T09:14:30+00:00', '2026-10-19T09:30:00+00:00'))

    def test_an_older_services_carried_hold_restarted_again_is_carried_to_its_end(self):
        """A service from 1.0.108 that predates `ceiling` names none in a carried hold's hold.json,
        and that hold never moves: a second restart carries it to its end and no further, not HOLD_MAX
        from its restart."""
        self.live_request(installRunId='run-1')
        (self.own / 'updates/hold.json').write_text(json.dumps(
            {'schemaVersion': 1, 'pid': 100, 'startedAt': '2026-10-19T08:59:30Z', 'expiresAt': '2026-10-19T09:14:30Z',
             'request': REQUEST}))
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual((self.marker()['until'], self.marker()['ceiling']),
                         ('2026-10-19T09:14:30+00:00', '2026-10-19T09:14:30+00:00'))

    def test_a_restart_without_a_held_request_carries_nothing(self):
        hold = {'schemaVersion': 1, 'pid': 100, 'startedAt': '2026-10-19T08:58:50Z', 'expiresAt': '2026-10-19T09:13:50Z'}
        cases = {
            # Restarted for an Update now request the service does not hold itself for.
            'not held': (False, hold),
            'hold already ended': (True, dict(hold, expiresAt='2026-10-19T08:59:59Z')),
            'hold end unreadable': (True, dict(hold, expiresAt='soon')),
            'hold start unreadable': (True, dict(hold, startedAt='soon')),
            'carried hold ceiling unreadable': (True, dict(hold, request=REQUEST, ceiling='soon')),
            'no hold file': (True, None),
        }
        for name, (held, content) in cases.items():
            with self.subTest(case=name):
                marker = self.own / 'updates' / database_restart.MARKER
                if marker.exists():
                    marker.unlink()
                hold_path = self.own / 'updates/hold.json'
                if hold_path.exists():
                    hold_path.unlink()
                if content is not None:
                    hold_path.write_text(json.dumps(content))
                self.live_request(installRunId='run-1')
                update.assert_held.side_effect = None if held else AssertionError(update.HOLD_REFUSAL)
                self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
                self.assertEqual(self.marker(), {'schemaVersion': 1, 'servicePid': 100, 'restartedAt': T0.isoformat()})

    def test_the_marker_the_helper_writes_is_the_one_the_service_reads(self):
        source = (HERE.parent.parent / 'apps/server/src/serviceUpdate/ServiceUpdateHold.ts').read_text()
        self.assertIn('export const DATABASE_RESTART_MARKER_FILE = "%s";' % database_restart.MARKER, source)
        for key in ('request', 'installRunId', 'until', 'ceiling', 'servicePid', 'restartedAt'):
            self.assertIn(key + ':', source)
        # The marker's `ceiling` is as far as the service lets a hold move.
        self.assertEqual(database_restart.HOLD_MAX, datetime.timedelta(minutes=110))
        self.assertIn('export const HOLD_MAX_MS = 110 * 60_000;', source)

    def test_update_now_without_a_hold_restarts_an_idle_service_without_the_quiet_window(self):
        self.settings(installMode='force', installRequestedAt=REQUEST)
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual(self.records()[0]['trigger'], 'update-now')
        # A cancelled request is not one.
        self.restart.reset_mock()
        (self.own / 'updates' / database_restart.MARKER).unlink()
        self.settings(installMode='force', installRequestedAt=REQUEST, installCancelledAt='2026-10-19T09:00:30Z',
                      installAutomatically=False)
        self.assertIsNone(self.refuse(0))
        self.restart.assert_not_called()

    def test_another_process_with_the_database_open_keeps_waiting(self):
        self.settings(installMode='force', installRequestedAt=REQUEST)
        self.openers = [100, 300, 301]
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost others=2')
        self.restart.assert_not_called()
        self.assertFalse((self.own / 'updates' / database_restart.MARKER).exists())

    def test_a_service_that_has_its_locks_again_is_left_alone(self):
        self.settings(installMode='force', installRequestedAt=REQUEST)
        self.locks_lost = False
        self.assertIsNone(self.refuse(0))
        self.restart.assert_not_called()

    def detached(self):
        """The service runs on a deleted log; returns the mocked stop_then_start_service."""
        for name, value in (('assert_database_attached', mock.Mock(side_effect=AssertionError(update.DETACHED_DATABASE))),
                            ('stop_then_start_service', mock.Mock())):
            patcher = mock.patch.object(update, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        return update.stop_then_start_service

    def test_a_deleted_log_is_never_restarted_without_a_request(self):
        stopper = self.detached()
        self.assertIsNone(self.refuse(0, update.DETACHED_DATABASE))  # Idle on disk proves nothing.
        self.assertIsNone(self.refuse(30, update.DETACHED_DATABASE))
        stopper.assert_not_called()
        self.restart.assert_not_called()
        self.assertEqual(self.records(), [])
        self.assertFalse((self.own / 'updates' / database_restart.MARKER).exists())

    def test_a_deleted_log_is_stopped_for_update_now_without_a_hold(self):
        # 1085, AC-04: the hold may be impossible on a deleted log, so the request alone is enough,
        # even with work running (SIGTERM lets the service stop it and save the log).
        stopper = self.detached()
        self.live_request()
        self.sql("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'running')")
        self.assertEqual(self.refuse(0, update.DETACHED_DATABASE, REQUEST), 'REFUSAL restart-needed detached restarted=1')
        # Stopped so it can save the deleted log, never `kickstart -k`.
        stopper.assert_called_once_with('gui/501', 'com.specweave.studio.m4', 100)
        self.restart.assert_not_called()
        [record] = self.records()
        self.assertEqual({key: record[key] for key in ('reason', 'trigger', 'servicePid', 'newServicePid', 'result')},
                         {'reason': 'detached', 'trigger': 'update-now', 'servicePid': 100, 'newServicePid': 200,
                          'result': 'restarted'})
        # RESTART_EVERY still holds the next attempt for the same service.
        self.assertEqual(self.refuse(10, update.DETACHED_DATABASE, REQUEST), 'REFUSAL restart-needed detached retry=1200')
        stopper.assert_called_once()

    def test_a_deleted_log_is_never_stopped_for_a_request_that_is_not_live(self):
        # installMode stays 'force' after a handled Update now: a request from days ago, one the
        # snapshot does not serve, one whose hold window passed or a cancelled one stops nothing.
        stopper = self.detached()
        self.sql("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'running')")
        cases = (('handled days ago', dict(installMode='force', installRequestedAt='2026-10-16T08:59:00Z',
                                           installHoldUntil='2026-10-16T09:14:00Z'), '2026-10-16T08:59:00Z', 0),
                 ('not served by this snapshot', dict(installMode='force', installRequestedAt=REQUEST,
                                                      installHoldUntil=HOLD_UNTIL), None, 0),
                 ('another request', dict(installMode='force', installRequestedAt=REQUEST,
                                          installHoldUntil=HOLD_UNTIL), '2026-10-19T08:00:00Z', 0),
                 ('hold window passed', dict(installMode='force', installRequestedAt=REQUEST,
                                             installHoldUntil=HOLD_UNTIL), REQUEST, 15),
                 ('no hold window', dict(installMode='force', installRequestedAt=REQUEST), REQUEST, 0),
                 ('cancelled', dict(installMode='force', installRequestedAt=REQUEST, installHoldUntil=HOLD_UNTIL,
                                    installCancelledAt='2026-10-19T08:59:30Z'), REQUEST, 0))
        for name, config, serving, minutes in cases:
            with self.subTest(name):
                self.settings(**config)
                self.assertIsNone(self.refuse(minutes, update.DETACHED_DATABASE, serving))
        stopper.assert_not_called()
        self.restart.assert_not_called()
        self.assertEqual(self.records(), [])
        self.assertFalse((self.own / 'updates' / database_restart.MARKER).exists())

    def test_a_deleted_log_is_stopped_for_the_live_request_after_a_stale_one(self):
        stopper = self.detached()
        self.settings(installMode='force', installRequestedAt='2026-10-16T08:59:00Z', installHoldUntil='2026-10-16T09:14:00Z')
        self.assertIsNone(self.refuse(0, update.DETACHED_DATABASE, '2026-10-16T08:59:00Z'))
        stopper.assert_not_called()
        self.live_request()  # Update now pressed again: the agent serves the new request.
        self.assertEqual(self.refuse(1, update.DETACHED_DATABASE, REQUEST), 'REFUSAL restart-needed detached restarted=1')
        stopper.assert_called_once_with('gui/501', 'com.specweave.studio.m4', 100)
        self.assertEqual(self.records()[0]['trigger'], 'update-now')

    def test_the_snapshot_command_passes_the_request_it_serves(self):
        stopper = self.detached()
        # main() takes the real clock: a hold window far ahead keeps the request live.
        self.settings(installMode='force', installRequestedAt=REQUEST, installHoldUntil='2999-01-01T00:00:00Z')
        err = io.StringIO()
        for argv, line in ((['--request', REQUEST], 'REFUSAL restart-needed detached restarted=1'),
                           ([], 'REFUSAL restart-needed detached')):
            with mock.patch.object(update, 'snapshot', side_effect=AssertionError(update.DETACHED_DATABASE)), \
                    mock.patch.object(update, 'idle_agent_refusal', return_value=None), \
                    mock.patch('sys.argv', ['update.py', '--identity', 'm4', '--snapshot', str(self.home / 'snap.json')] + argv), \
                    contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit):
                    update.main()
            self.assertEqual(err.getvalue().strip().splitlines()[-1], line)
        stopper.assert_called_once()

    def test_a_held_deleted_log_is_stopped_and_recorded_as_held(self):
        stopper = self.detached()
        self.settings(installMode='force', installRequestedAt=REQUEST, installHoldUntil='2026-10-19T09:15:00Z')
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0, update.DETACHED_DATABASE), 'REFUSAL restart-needed detached restarted=1')
        stopper.assert_called_once_with('gui/501', 'com.specweave.studio.m4', 100)
        self.assertEqual(self.records()[0]['trigger'], 'held')

    def test_a_deleted_log_with_another_opener_is_not_stopped(self):
        stopper = self.detached()
        self.live_request()
        self.openers = [100, 300]
        self.assertEqual(self.refuse(0, update.DETACHED_DATABASE, REQUEST), 'REFUSAL restart-needed detached others=1')
        stopper.assert_not_called()
        self.assertEqual(self.records(), [])
        self.assertFalse((self.own / 'updates' / database_restart.MARKER).exists())

    def test_a_deleted_log_service_that_was_restarted_meanwhile_is_left_alone(self):
        stopper = self.detached()
        self.live_request()
        # The fault is gone for this pid: nothing to restart.
        update.assert_database_attached.side_effect = None
        self.assertIsNone(self.refuse(0, update.DETACHED_DATABASE, REQUEST))
        # A different pid runs by the time lsof returns.
        update.assert_database_attached.side_effect = AssertionError(update.DETACHED_DATABASE)
        replaced = dict(self.service, runtime={'pid': 101})
        update._service.side_effect = [self.service, replaced]
        self.assertIsNone(self.refuse(0, update.DETACHED_DATABASE, REQUEST))
        stopper.assert_not_called()
        self.assertEqual(self.records(), [])

    def test_a_deleted_log_service_that_does_not_stop_in_time_is_left_running(self):
        detached = mock.patch.object(update, 'assert_database_attached',
                                     mock.Mock(side_effect=AssertionError(update.DETACHED_DATABASE)))
        detached.start()
        self.addCleanup(detached.stop)
        stop = mock.patch.object(update, 'stop_then_start_service',
                                 mock.Mock(side_effect=AssertionError(update.DETACHED_STOP_TIMEOUT)))
        stop.start()
        self.addCleanup(stop.stop)
        self.settings(installMode='force', installRequestedAt=REQUEST)
        update.assert_held.side_effect = None
        self.assertEqual(self.refuse(0, update.DETACHED_DATABASE), 'REFUSAL restart-needed detached retry=1800')
        self.assertEqual(self.records()[0]['result'], 'stop-timed-out')
        self.restart.assert_not_called()
        # The next attempt waits RESTART_EVERY.
        self.assertEqual(self.refuse(5, update.DETACHED_DATABASE), 'REFUSAL restart-needed detached retry=1500')

    def test_work_that_starts_while_lsof_runs_is_not_killed(self):
        # The quiet window has passed; a run starts during the (slow) lsof check.
        self.assertEqual(self.refuse(0), 'REFUSAL restart-needed locks-lost wait=600')
        self.during_lsof = lambda: self.sql("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'running')")
        self.assertIsNone(self.refuse(10))
        self.restart.assert_not_called()
        self.assertEqual(self.records(), [])
        self.assertFalse((self.own / 'updates' / database_restart.MARKER).exists())
        self.assertFalse((self.own / 'updates' / database_restart.QUIET_MARKER).exists())  # The window starts again.
        # Update now without a hold: an agent process opened meanwhile is not killed either.
        self.settings(installMode='force', installRequestedAt=REQUEST)
        self.sql("UPDATE orchestration_v2_projection_runs SET status = 'completed'")
        self.during_lsof = None
        update.idle_providers.side_effect = [{}, AssertionError('Owned service has unexpected descendants')]
        self.assertIsNone(self.refuse(11))
        self.restart.assert_not_called()

    def test_a_service_restarted_while_lsof_runs_is_left_alone(self):
        # The new process has not taken its locks yet, so the fault looks the same.
        restarted = dict(self.service, runtime={'pid': 200})
        for held in (False, True):
            self.settings(installMode='force', installRequestedAt=REQUEST)
            update.assert_held.side_effect = None if held else AssertionError(update.HOLD_REFUSAL)
            update._service.side_effect = [self.service, restarted]
            self.assertIsNone(self.refuse(0))
            self.restart.assert_not_called()
            self.assertEqual(self.records(), [])
            self.assertFalse((self.own / 'updates' / database_restart.MARKER).exists())

    def test_a_normal_update_that_may_not_install_now_restarts_nothing(self):
        self.settings(installAutomatically=False, installMode='normal', quietMinutes=0)
        self.assertIsNone(self.refuse(0))
        self.restart.assert_not_called()

    def test_other_refusals_are_not_handled(self):
        self.assertIsNone(update.database_restart_refusal('m4', AssertionError('Native work is not idle'), now=T0))
        update._service.assert_not_called()

    def test_a_failed_restart_is_recorded_and_still_counts(self):
        self.settings(installMode='force', installRequestedAt=REQUEST)
        self.restart.side_effect = AssertionError('Owned operation failed; arbitrary command output withheld')
        with self.assertRaises(AssertionError):
            self.refuse(0)
        self.assertEqual(self.records()[0]['result'], 'refused')
        self.assertEqual(self.refuse(5), 'REFUSAL restart-needed locks-lost retry=1500')

    def test_the_snapshot_command_prints_the_restart_line_last(self):
        self.settings(installMode='force', installRequestedAt=REQUEST)
        target = self.home / 'snapshot.json'
        err = io.StringIO()
        with mock.patch.object(update, 'snapshot', side_effect=AssertionError(update.LOCKS_LOST)), \
                mock.patch('sys.argv', ['update.py', '--identity', 'm4', '--snapshot', str(target)]), \
                contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as caught:
                update.main()
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(err.getvalue().strip().splitlines()[-1], 'REFUSAL restart-needed locks-lost restarted=1')
        self.assertFalse(target.exists())


class WaitForNewService(unittest.TestCase):
    def test_waits_for_a_new_pid_that_holds_the_locks(self):
        own = pathlib.Path('/owned/m4')
        services = iter([AssertionError('The SpecWithCode service is not running'),
                         {'own': own, 'runtime': {'pid': 100}}, {'own': own, 'runtime': {'pid': 200}},
                         {'own': own, 'runtime': {'pid': 200}}])

        def service(identity):
            value = next(services)
            if isinstance(value, Exception):
                raise value
            return value
        locks = iter([{'database': None}, {'database': 200}])
        with mock.patch.object(update, '_service', service), mock.patch.object(update.time, 'sleep'), \
                mock.patch.object(update.live_database, 'service_locks', lambda path: next(locks)):
            self.assertEqual(update.wait_for_database_owner('m4', 100), 200)
        with mock.patch.object(update, '_service', side_effect=AssertionError('not running')), \
                mock.patch.object(update.time, 'sleep'), mock.patch.object(update.time, 'monotonic',
                                                                           side_effect=[0, 1, 200]):
            self.assertIsNone(update.wait_for_database_owner('m4', 100))


class AgentText(unittest.TestCase):
    def test_the_agent_waits_while_the_service_is_restarted(self):
        reason = update_agent.refusal_reason
        tail = 'AssertionError: %s\nREFUSAL restart-needed locks-lost wait=540\n' % update.LOCKS_LOST
        self.assertEqual(reason(tail, 'failed'), ('waiting-for-quiet', 'Restarting SpecWithCode to recover its database'))
        self.assertEqual(reason('REFUSAL restart-needed locks-lost restarted=1', 'failed'),
                         ('waiting-for-quiet',
                          'Restarted SpecWithCode to recover its database; installing after a quiet moment'))
        self.assertEqual(reason('REFUSAL restart-needed detached retry=60', 'failed')[0], 'waiting-for-quiet')

    def test_the_agent_asks_for_a_restart_when_none_will_happen_by_itself(self):
        # A deleted log without a held request, another opener, work running, or automatic
        # installs off: nothing restarts the service, so it is an error the person can act on.
        reason = update_agent.refusal_reason
        for line in ('REFUSAL restart-needed locks-lost', 'REFUSAL restart-needed locks-lost others=2'):
            self.assertEqual(reason('AssertionError: %s\n%s\n' % (update.LOCKS_LOST, line), 'failed'),
                             ('error', 'SpecWithCode cannot be updated right now: %s' % update.LOCKS_LOST))
        self.assertEqual(reason('REFUSAL restart-needed detached', 'failed'),
                         ('error', 'SpecWithCode cannot be updated right now: %s' % update.DETACHED_DATABASE))
        # The line a manual-only case prints: the snapshot fallback restarts nothing.
        with mock.patch.object(update, 'database_restart_refusal', return_value=None), \
                mock.patch.object(update, 'idle_agent_refusal', return_value=None):
            line = update.snapshot_refusal('m4', AssertionError(update.DETACHED_DATABASE))
        self.assertEqual(reason(line, 'failed')[0], 'error')

    def test_refusal_line_names_the_restart(self):
        self.assertEqual(update.refusal_line('m4', AssertionError(update.LOCKS_LOST)), 'REFUSAL restart-needed locks-lost')
        self.assertEqual(update.refusal_line('m4', AssertionError(update.DETACHED_DATABASE)),
                         'REFUSAL restart-needed detached')
        self.assertEqual(database_restart.refusal('locks-lost', wait=5, others=1),
                         'REFUSAL restart-needed locks-lost others=1 wait=5')



class StopThenStartTest(unittest.TestCase):
    """update.stop_then_start_service: SIGTERM, wait, never SIGKILL, start without -k."""

    def setUp(self):
        self.signals, self.commands, self.alive = [], [], [True, True, False]

        def kill(pid, sig):
            self.signals.append((pid, sig))
            if sig == 0 and not self.alive.pop(0):
                raise ProcessLookupError(pid)
        for target, name, value in ((update.os, 'kill', kill),
                                    (update, 'run', lambda command, **options: self.commands.append(command)),
                                    (update.time, 'sleep', lambda seconds: None)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_terms_waits_for_exit_then_starts_without_kill(self):
        update.stop_then_start_service('gui/501', 'com.specweave.studio.m4', 100)
        self.assertEqual(self.signals[0], (100, update.signal.SIGTERM))
        self.assertNotIn((100, update.signal.SIGKILL), self.signals)
        self.assertEqual(self.commands, [['/bin/launchctl', 'kickstart', 'gui/501/com.specweave.studio.m4']])

    def test_a_service_still_running_at_the_deadline_is_not_killed(self):
        self.alive = [True] * 1000
        clock = iter(range(0, 10000, 30))
        with mock.patch.object(update.time, 'monotonic', lambda: next(clock)):
            with self.assertRaises(AssertionError) as raised:
                update.stop_then_start_service('gui/501', 'com.specweave.studio.m4', 100, timeout=60)
        self.assertEqual(str(raised.exception), update.DETACHED_STOP_TIMEOUT)
        self.assertEqual({sig for _, sig in self.signals}, {update.signal.SIGTERM, 0})
        self.assertEqual(self.commands, [])

if __name__ == '__main__':
    unittest.main()
