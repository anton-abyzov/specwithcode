#!/usr/bin/env python3
"""The agent's admission snapshot of a large database (update_admission.py): its read does not
grow with the logs, the helper's own full read refuses whatever the full comparison refused
outside the logs and untouched threads, rows that change while the agent reads are judged by the
helper's read, not thrown away with it, and update.snapshot and update.apply route through it.
Temporary SQLite only; no services or user stores."""
import contextlib
import copy
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import live_database
import update_admission
import update_agent
import update_read

spec = importlib.util.spec_from_file_location('admission_update_base', pathlib.Path(__file__).with_name('test-update.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
update, waiting_fixture, waiting_check, mutate_state = base.update, base.waiting_fixture, base.waiting_check, base.mutate_state


def add_history(state, rows, stream='t-idle'):
    """`rows` more events and receipts of a finished thread: history no admission read reads."""
    db = sqlite3.connect(state / 'statev2.sqlite')
    start = db.execute('SELECT coalesce(max(sequence), 0) FROM orchestration_events').fetchone()[0]
    payload = '{"private":"synthetic-private-payload","padding":"' + 'x' * 200 + '"}'
    db.executemany('INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,?,?,?)',
                   (('history-%d' % (start + index), stream, 'message.updated', payload) for index in range(rows)))
    db.executemany("INSERT INTO orchestration_command_receipts VALUES (?,?,?,'accepted')",
                   (('history-receipt-%d' % (start + index), stream, start + index) for index in range(rows)))
    db.commit()
    db.close()


@contextlib.contextmanager
def counted_reads():
    """SQLite VM steps and statements of every connection live_database opens meanwhile."""
    real, seen = live_database.connect, {'steps': 0, 'sql': []}

    def connect(*args, **kwargs):
        db = real(*args, **kwargs)
        def step():
            seen['steps'] += 1
            return 0
        db.set_progress_handler(step, 100)
        db.set_trace_callback(seen['sql'].append)
        return db
    with patch.object(live_database, 'connect', side_effect=connect):
        yield seen


def helper_read(state, expected):
    """What update.py _apply reads for an admission snapshot: one full read, appended rows
    measured against the admission's log ends."""
    rows, _, carried, capture = update._read_state(state, False, update_admission.since(expected), True)
    return {'rows': rows, 'databaseCapture': capture}, carried


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-admission-')
        self.state = pathlib.Path(self.temp.name)
        waiting_fixture(self.state)

    def tearDown(self):
        self.temp.cleanup()

    def admission(self):
        rows, proof = update_admission.read(self.state)
        return {'rows': rows, 'admissionProof': proof, 'snapshotMode': update_admission.MODE}

    def admitted(self, expected):
        before, carried = helper_read(self.state, expected)
        update_admission.assert_admitted(expected['admissionProof'], before, carried)
        return before

    def refused(self, expected, pattern='Guarded prestate changed'):
        before, carried = helper_read(self.state, expected)
        with self.assertRaisesRegex(AssertionError, pattern):
            update_admission.assert_admitted(expected['admissionProof'], before, carried)


class ReadVolume(Fixture):
    """The admission read stays the same size as the history grows; the full read does not."""

    def measure(self, read):
        with counted_reads() as seen:
            read()
        return seen

    def test_the_admission_read_does_not_grow_with_the_logs(self):
        add_history(self.state, 1000)
        small_admission = self.measure(lambda: update_admission.read(self.state))
        small_full = self.measure(lambda: update._read_state(self.state, False, None, True))
        add_history(self.state, 40000)
        large_admission = self.measure(lambda: update_admission.read(self.state))
        large_full = self.measure(lambda: update._read_state(self.state, False, None, True))
        # 41x the history: the full read's work grows with it, the admission read's does not.
        self.assertGreater(large_full['steps'], 20 * max(small_full['steps'], 1))
        self.assertLessEqual(large_admission['steps'], small_admission['steps'] + 2)
        self.assertLess(large_admission['steps'] * 50, large_full['steps'])
        # No statement reads a log's rows: only where each log ends.
        for sql in large_admission['sql']:
            for log in update_read.LOG_TABLES:
                if 'FROM ' + log in sql:
                    self.assertTrue('max(rowid)' in sql or sql.endswith('LIMIT 0'), sql)

    def test_counts_for_the_quiet_check_leave_out_only_the_bookkeeping_logs(self):
        rows, _ = update_admission.read(self.state)
        full = update.rows_snapshot(self.state)
        self.assertEqual(update_agent.work_counts(rows['counts']), update_agent.work_counts(full['counts']))
        self.assertNotIn('orchestration_events', rows['counts'])
        self.assertIs(rows['nativeWorkIdle'], True)

    def test_busy_work_refuses_the_admission_read(self):
        mutate_state(self.state, "UPDATE orchestration_v2_projection_runs SET status='running' WHERE run_id='r-t-wait'")
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            update_admission.read(self.state)

    def test_a_virtual_table_takes_the_full_snapshot(self):
        try:
            mutate_state(self.state, 'CREATE VIRTUAL TABLE notes USING fts5(body)')
        except sqlite3.OperationalError:
            self.skipTest('SQLite without FTS5')
        self.assertIsNone(update_admission.read(self.state))


class HelperComparison(Fixture):
    """The helper's own full read against the admission, before anything is written."""

    def test_nothing_changed_is_admitted_and_the_helper_read_is_complete(self):
        expected = self.admission()
        before = self.admitted(expected)
        self.assertIn('orchestration_events', before['rows']['hashes'])
        self.assertIn('orchestration_events', before['databaseCapture']['legacy'])

    def test_what_a_running_service_appends_is_admitted(self):
        expected = self.admission()
        waiting_check(self.state, 'a')
        waiting_check(self.state, 'bb')
        mutate_state(self.state, "UPDATE auth_sessions SET last_connected_at='2026-10-11T05:00:00Z'")
        self.admitted(expected)

    def test_a_new_thread_needs_its_own_events(self):
        expected = self.admission()
        mutate_state(self.state, "INSERT INTO orchestration_v2_projection_threads VALUES ('t-new','p1','2026-10-11T05:00:00Z','{}')")
        self.refused(expected)
        mutate_state(self.state, "INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES ('created-t-new','t-new','thread.created','{}')")
        self.admitted(expected)

    def test_changes_the_full_comparison_refuses_outside_the_logs_still_refuse(self):
        for statement in ["INSERT INTO projection_projects VALUES ('p2','Another')",
                          "DELETE FROM projection_projects",
                          "DELETE FROM orchestration_v2_projection_threads WHERE thread_id='t-idle'",
                          "UPDATE orchestration_v2_projection_metadata SET schema_version=3",
                          "INSERT INTO auth_pairing_links VALUES ('grant-2','synthetic-private-credential')",
                          "UPDATE scheduled_tasks SET cron='* * * * *'",
                          "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('completed')",
                          "UPDATE orchestration_v2_effect_outbox SET status='succeeded'"]:
            with self.subTest(statement=statement):
                self.tearDown(); self.setUp()
                mutate_state(self.state, "INSERT INTO orchestration_v2_effect_outbox VALUES ('failed')")
                expected = self.admission()
                waiting_check(self.state, 'a')
                mutate_state(self.state, statement)
                self.refused(expected)

    def test_a_schema_change_refuses(self):
        expected = self.admission()
        mutate_state(self.state, 'CREATE INDEX auth_subject ON auth_sessions(subject)')
        self.refused(expected, 'Guarded prestate changed: schema')

    def test_autoincrement_counters_move_only_for_logs_that_grew(self):
        mutate_state(self.state, 'CREATE TABLE project_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)',
                     "INSERT INTO project_notes(body) VALUES ('kept')")
        expected = self.admission()
        mutate_state(self.state, "UPDATE sqlite_sequence SET seq=seq+5 WHERE name='orchestration_events'")
        self.refused(expected)  # No event was appended.
        self.tearDown(); self.setUp()
        mutate_state(self.state, 'CREATE TABLE project_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)',
                     "INSERT INTO project_notes(body) VALUES ('kept')")
        expected = self.admission()
        waiting_check(self.state, 'a')
        self.admitted(expected)
        mutate_state(self.state, "UPDATE sqlite_sequence SET seq=seq+5 WHERE name='project_notes'")
        self.refused(expected)

    def test_a_table_past_the_row_budget_is_compared_by_its_count(self):
        mutate_state(self.state, "INSERT INTO scheduled_tasks VALUES ('weekly','0 3 * * 0')")
        with patch.object(update_admission, 'ROW_BUDGET', 1):
            expected = self.admission()
        self.assertEqual(expected['admissionProof']['sized']['scheduled_tasks'], 2)
        mutate_state(self.state, "DELETE FROM scheduled_tasks WHERE id='weekly'")
        self.refused(expected)

    def test_a_proof_without_its_facts_refuses(self):
        expected = self.admission()
        broken = copy.deepcopy(expected)
        del broken['admissionProof']['exact']
        with self.assertRaisesRegex(AssertionError, 'Admission snapshot proof missing'):
            update_admission.since(broken)
        before, carried = helper_read(self.state, expected)
        with self.assertRaisesRegex(AssertionError, 'Admission snapshot proof missing'):
            update_admission.assert_admitted(broken['admissionProof'], before, carried)


class RowsChangingDuringTheSnapshot(Fixture):
    """A commit while the agent reads lands after its snapshot: the read is one transaction, and
    the helper's read judges the commit. Appends no longer cost the whole read again."""

    def setUp(self):
        super().setUp()
        db = sqlite3.connect(self.state / 'statev2.sqlite')
        db.execute('PRAGMA journal_mode=WAL')
        db.close()
        add_history(self.state, 5000)

    def read_while(self, *statements):
        real, done, reading = live_database.connect, [], []

        def connect(*args, **kwargs):
            db = real(*args, **kwargs)
            def write():  # Inside the first read after BEGIN: its snapshot is already taken.
                if not done and reading:
                    done.append(True)
                    mutate_state(self.state, *statements)
                return 0
            db.set_trace_callback(lambda sql: reading.append(sql) if db.in_transaction and sql != 'BEGIN' else None)
            db.set_progress_handler(write, 10)
            return db
        with patch.object(live_database, 'connect', side_effect=connect):
            expected = self.admission()
        self.assertEqual(done, [True], 'The write must land while the admission read runs')
        return expected

    def test_appends_during_the_read_are_admitted(self):
        expected = self.read_while(
            "INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES ('during','t-wait','thread.metadata-updated','{}')",
            "UPDATE orchestration_v2_projection_threads SET payload_json='{\"checked\":\"during\"}' WHERE thread_id='t-wait'")
        self.assertEqual(expected['admissionProof']['logRowids']['orchestration_events'], 5004)  # Its own snapshot.
        self.admitted(expected)

    def test_a_change_during_the_read_is_refused_by_the_helper(self):
        expected = self.read_while("UPDATE scheduled_tasks SET cron='* * * * *'")
        self.refused(expected)


class SnapshotRouting(Fixture):
    """update.snapshot takes the admission read for a large database without a hold."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-admission-')
        self.own = pathlib.Path(self.temp.name) / 'own'
        self.state = self.own / 'userdata'
        waiting_fixture(self.state)
        self.calls = []

    def full(self, identity, include_auth, since=None, widen_from=None, reads=None):
        self.calls.append(reads)
        rows, _, _, capture = reads or update._read_state(self.state, include_auth, since, True, widen_from)
        return {'servicePid': 100, 'rows': rows, 'databaseCapture': capture,
                'observedAt': '2026-11-03T00:00:00+00:00'}, None, None

    def take(self, request=None):
        updates = self.own / 'updates'
        with patch.object(update, '_service', return_value={'own': self.own, 'home': self.own.parent, 'runtime': {'pid': 100}}), \
             patch.object(update, '_snapshot', side_effect=self.full), \
             patch.object(update.studio_paths, 'identity_home', return_value=self.own), \
             patch.object(update.folder_work, 'in_progress', return_value=False):
            updates.mkdir(exist_ok=True)
            return update.snapshot('m4', request)

    def test_a_large_database_takes_the_admission_snapshot(self):
        with patch.object(update_admission, 'ADMISSION_BYTES', 0):
            value = self.take()
        self.assertEqual(value['snapshotMode'], update_admission.MODE)
        self.assertNotIn('databaseCapture', value)
        self.assertEqual(self.calls[0][2:], (None, None))
        self.assertTrue(update_admission.valid(value['admissionProof']))
        # The update agent keeps it as any snapshot, and its quiet check compares its counts.
        agent = update_agent.Agent.__new__(update_agent.Agent)
        agent.home = self.own.parent
        path = self.own / 'updates' / 'snapshot.json'
        path.write_text(json.dumps(value))
        self.assertEqual(agent.read_snapshot(path)['rows']['counts'], value['rows']['counts'])

    def test_a_small_database_keeps_the_full_snapshot(self):
        value = self.take()
        self.assertNotIn('snapshotMode', value)
        self.assertIn('databaseCapture', value)
        self.assertEqual(self.calls, [None])

    def test_a_forced_request_without_its_hold_takes_the_admission_snapshot(self):
        with patch.object(update_admission, 'ADMISSION_BYTES', 0):
            value = self.take(request='2026-11-03T00:00:00+00:00')
        self.assertEqual(value['snapshotMode'], update_admission.MODE)


class AdmissionApply(base.ApplyRecovery):
    """update.apply from an admission snapshot under test-update.py's harness."""

    def use_admission(self):
        state = self.use_captured_waiting_state()
        rows, proof = update_admission.read(state)
        self.before.update(snapshotMode=update_admission.MODE, rows=rows, admissionProof=proof)
        self.before.pop('databaseCapture')
        return state

    def test_an_admission_takes_its_complete_baseline_in_the_helper(self):
        state = self.use_admission()
        waiting_check(state, 'between')  # Appended after the agent read, before the helper's.
        self.execute()
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt['phase'], 'verified')
        self.assertIsInstance(receipt['before']['databaseCapture'], dict)
        self.assertIn('orchestration_events', receipt['before']['rows']['hashes'])

    def test_a_change_after_the_admission_refuses_before_staging_or_restart(self):
        state = self.use_admission()
        mutate_state(state, "UPDATE scheduled_tasks SET cron='* * * * *'")
        with self.assertRaisesRegex(AssertionError, 'Guarded prestate changed: rows'):
            self.execute()
        self.assertEqual((self.stage_timeouts, self.restart_calls, self.backups), ([], [], []))
        self.assertEqual({path: path.read_bytes() for path in self.original}, self.original)  # No pointer moved.
        # A refusal the update agent retries, as a full snapshot's prestate check is.
        self.assertTrue(update_admission.REFUSAL.startswith(update_agent.RETRYABLE_REFUSALS))

    def test_an_unknown_snapshot_mode_still_refuses(self):
        self.use_admission()
        self.before['snapshotMode'] = 'something-else'
        with self.assertRaisesRegex(AssertionError, 'Unknown snapshot mode'):
            self.execute()


if __name__ == '__main__':
    unittest.main()
