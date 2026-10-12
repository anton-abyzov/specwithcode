#!/usr/bin/env python3
"""Whole-database capture and continuity: real temporary SQLite only, no services or user stores."""
import copy
import datetime
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import auth_heartbeat as heartbeat
import database_continuity as continuity
import update as plain_update

START = '2026-10-09T10:00:00+00:00'
END = '2026-10-09T10:00:02+00:00'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


fixtures = module('continuity_auth_fixtures', 'test-auth-read-consistency.py')
updater_base = module('continuity_update_base', 'test-update.py')

SCHEMA = '''
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, body BLOB);
    CREATE TABLE orchestration_v2_projection_runs(status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests(status TEXT);
    CREATE TABLE orchestration_v2_effect_outbox(status TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT);
    CREATE TABLE scheduled_tasks(task_id TEXT PRIMARY KEY, prompt TEXT);
    CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, method TEXT, client_surface TEXT, issued_at TEXT,
        expires_at TEXT, last_connected_at TEXT, revoked_at TEXT, credential BLOB);
    CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT);
    CREATE TABLE checkpoint_diff_blobs(id INTEGER PRIMARY KEY AUTOINCREMENT, body BLOB);
    CREATE TABLE scheduled_task_webhook_relay_deliveries(delivery_id TEXT PRIMARY KEY, payload TEXT);
    CREATE INDEX relay_payload ON scheduled_task_webhook_relay_deliveries(payload);
    INSERT INTO projection_projects VALUES ('project', 'Synthetic title');
    INSERT INTO projection_threads VALUES ('thread', x'abcd');
    INSERT INTO scheduled_tasks VALUES ('routine', 'synthetic-private-prompt');
    INSERT INTO effect_sql_migrations VALUES (1, '2026-10-08 09:00:00', 'Synthetic');
    INSERT INTO checkpoint_diff_blobs(body) VALUES (x'abcd');
    INSERT INTO scheduled_task_webhook_relay_deliveries VALUES ('delivery', 'synthetic-private-payload');
'''


def build(path, last_connected):
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)',
               ('synthetic-private-session', 'browser-session-cookie', 'web', '2026-10-01T00:00:00.000Z',
                '2026-11-01T00:00:00.000Z', last_connected, None, b'synthetic-private-credential'))
    db.commit()
    db.close()


class CaptureContinuity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-database-continuity-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name).resolve()
        build(self.state / 'statev2.sqlite', '2026-10-09T09:00:00.000Z')
        self.rows, self.auth = plain_update.rows_snapshot_with_auth(self.state)
        self.before = continuity.read_database(self.state, self.rows)

    def execute(self, sql):
        db = sqlite3.connect(self.state / 'statev2.sqlite')
        db.executescript(sql)
        db.commit()
        db.close()

    def changed(self, sql):
        self.execute(sql)
        return continuity.read_database(self.state)

    def test_identical_database_passes(self):
        again = continuity.read_database(self.state, plain_update.rows_snapshot(self.state))
        self.assertEqual(continuity.encoded(again), continuity.encoded(self.before))
        continuity.assert_database_continuity(self.before['summary'], again['summary'])

    def test_capture_covers_every_table_and_no_cell_values(self):
        tables = set(self.before['summary']['tables'])
        self.assertTrue({'checkpoint_diff_blobs', 'scheduled_task_webhook_relay_deliveries', 'effect_sql_migrations',
                         'sqlite_sequence'} <= tables)
        self.assertFalse({'checkpoint_diff_blobs', 'effect_sql_migrations'} & set(self.rows['counts']))
        serialized = json.dumps(self.before)
        for secret in ['synthetic-private-session', 'synthetic-private-credential', 'synthetic-private-prompt',
                       'synthetic-private-payload', 'Synthetic title']:
            self.assertNotIn(secret, serialized)

    def test_changed_row_in_an_unprotected_table_fails(self):
        for sql in ["UPDATE scheduled_task_webhook_relay_deliveries SET payload='changed'",
                    "UPDATE checkpoint_diff_blobs SET body=x'abce'",
                    "DELETE FROM checkpoint_diff_blobs",
                    "INSERT INTO effect_sql_migrations VALUES (2, '2026-10-09 09:00:00', 'Other')",
                    "UPDATE sqlite_sequence SET seq=9"]:
            with self.subTest(sql=sql):
                fresh = tempfile.TemporaryDirectory(prefix='studio-database-continuity-case-')
                self.addCleanup(fresh.cleanup)
                self.state = pathlib.Path(fresh.name).resolve()
                build(self.state / 'statev2.sqlite', '2026-10-09T09:00:00.000Z')
                before = continuity.read_database(self.state)
                after = self.changed(sql)
                with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
                    continuity.assert_database_continuity(before['summary'], after['summary'])

    def test_changed_protected_row_fails(self):
        after = self.changed("UPDATE projection_projects SET title='changed'")
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            continuity.assert_database_continuity(self.before['summary'], after['summary'])

    def test_text_blob_collision_fails_although_the_legacy_hash_matches(self):
        after = self.changed("UPDATE checkpoint_diff_blobs SET body='abcd'")
        self.assertEqual(after['legacy']['checkpoint_diff_blobs'], self.before['legacy']['checkpoint_diff_blobs'])
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            continuity.assert_database_continuity(self.before['summary'], after['summary'])

    def test_integer_real_collision_fails(self):
        self.execute('CREATE TABLE numbers(value)')
        self.execute('INSERT INTO numbers VALUES (1)')
        before = continuity.read_database(self.state)
        after = self.changed('UPDATE numbers SET value=1.0')
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            continuity.assert_database_continuity(before['summary'], after['summary'])

    def test_schema_change_fails(self):
        changes = {'added column': 'ALTER TABLE checkpoint_diff_blobs ADD COLUMN extra TEXT',
                   'added index': 'CREATE INDEX extra ON checkpoint_diff_blobs(body)',
                   'dropped index': 'DROP INDEX relay_payload',
                   'changed index': 'DROP INDEX relay_payload; CREATE INDEX relay_payload ON scheduled_task_webhook_relay_deliveries(delivery_id, payload)',
                   'added empty table': 'CREATE TABLE unrelated(value TEXT)',
                   'dropped empty table': 'DELETE FROM checkpoint_diff_blobs; DROP TABLE checkpoint_diff_blobs',
                   'added trigger': 'CREATE TRIGGER noop AFTER DELETE ON projection_projects BEGIN SELECT 1; END',
                   'added view': 'CREATE VIEW v AS SELECT 1'}
        for name, sql in changes.items():
            with self.subTest(change=name):
                fresh = tempfile.TemporaryDirectory(prefix='studio-database-continuity-schema-')
                self.addCleanup(fresh.cleanup)
                self.state = pathlib.Path(fresh.name).resolve()
                build(self.state / 'statev2.sqlite', '2026-10-09T09:00:00.000Z')
                before = continuity.read_database(self.state)
                after = self.changed(sql)
                self.assertNotEqual(after['summary']['schemaSha256'], before['summary']['schemaSha256'])
                with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
                    continuity.assert_database_continuity(before['summary'], after['summary'])

    def test_auth_rows_are_preserved_exactly_without_a_heartbeat(self):
        for sql in ["UPDATE auth_sessions SET last_connected_at='2026-10-09T10:00:01.000Z'",
                    "UPDATE auth_sessions SET credential='73796e7468657469632d707269766174652d63726564656e7469616c'",
                    "DELETE FROM auth_sessions"]:
            with self.subTest(sql=sql):
                fresh = tempfile.TemporaryDirectory(prefix='studio-database-continuity-auth-')
                self.addCleanup(fresh.cleanup)
                self.state = pathlib.Path(fresh.name).resolve()
                build(self.state / 'statev2.sqlite', '2026-10-09T09:00:00.000Z')
                before = continuity.read_database(self.state)
                after = self.changed(sql)
                with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
                    continuity.assert_database_continuity(before['summary'], after['summary'])

    def test_heartbeat_normalizes_only_bound_auth_and_nothing_else(self):
        self.execute("UPDATE auth_sessions SET last_connected_at='2026-10-09T10:00:01.000Z'")
        rows, auth = plain_update.rows_snapshot_with_auth(self.state)
        after = continuity.read_database(self.state, rows)
        continuity.assert_database_continuity(self.before['summary'], after['summary'], self.auth, auth)
        with self.assertRaisesRegex(AssertionError, 'both auth tables'):
            continuity.assert_database_continuity(self.before['summary'], after['summary'], self.auth, None)
        with self.assertRaisesRegex(AssertionError, 'Original auth cells differ'):
            continuity.assert_database_continuity(self.before['summary'], after['summary'], auth, auth)
        forged = copy.deepcopy(auth)
        forged['rows'][0][-1] = forged['rows'][0][-1].hex()  # Same legacy hash, different storage class.
        with self.assertRaisesRegex(AssertionError, 'Current auth cells differ'):
            continuity.assert_database_continuity(self.before['summary'], after['summary'], self.auth, forged)
        other = self.changed("UPDATE scheduled_task_webhook_relay_deliveries SET payload='changed'")
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            continuity.assert_database_continuity(self.before['summary'], other['summary'], self.auth, auth)

    def test_reverse_later_capture_restores_only_auth(self):
        self.execute("UPDATE auth_sessions SET last_connected_at='2026-10-09T10:00:01.000Z'")
        later = continuity.read_database(self.state)
        self.assertNotEqual(continuity.encoded(later), continuity.encoded(self.before))
        self.assertEqual(continuity.encoded(continuity.reverse_later_capture(later, self.auth)),
                         continuity.encoded(self.before))

    def test_capture_requires_an_open_transaction_and_bound_rows(self):
        db = sqlite3.connect((self.state / 'statev2.sqlite').as_uri() + '?mode=ro', uri=True)
        try:
            with self.assertRaisesRegex(AssertionError, 'existing read transaction'):
                continuity.capture_connection(db)
        finally:
            db.close()
        wrong = copy.deepcopy(self.rows)
        wrong['hashes']['scheduled_tasks'] = '0' * 64
        with self.assertRaisesRegex(AssertionError, 'Database changed during protected row readback'):
            continuity.read_database(self.state, wrong)


class ProjectSnapshotRead(unittest.TestCase):
    """Ported from the earlier test-project-read-consistency.py (version-agnostic part)."""

    def setUp(self):
        self.fixture = fixtures.CoherentAuthRead()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.state, self.writer = self.fixture.state, self.fixture.writer
        self.writer.execute('CREATE TABLE unprotected_blob(value BLOB)')
        self.writer.execute("INSERT INTO unprotected_blob VALUES (x'abcd')")
        self.writer.commit()

    def test_separate_full_capture_reproduces_prior_mismatch(self):
        rows = plain_update.rows_snapshot(self.state)
        self.fixture.advance()
        with self.assertRaisesRegex(AssertionError, 'Database changed during protected row readback'):
            continuity.read_database(self.state, rows)

    def test_rows_auth_and_complete_cells_share_one_readonly_transaction(self):
        baseline = continuity.read_database(self.state)
        rows_before = plain_update.rows_snapshot(self.state)
        read_auth = heartbeat.read_auth_sessions_in_transaction
        def commit_after_rows(db, rows):
            self.fixture.advance()
            self.writer.execute("UPDATE unprotected_blob SET value='abcd'")
            self.writer.commit()
            return read_auth(db, rows)
        with patch.object(plain_update, 'read_auth_sessions_in_transaction', side_effect=commit_after_rows):
            rows, private, complete = plain_update._rows_snapshot(self.state, True, include_database=True)
        self.assertEqual(rows, rows_before)
        self.assertEqual(complete, baseline)
        heartbeat.bind_auth(private, rows)
        self.assertNotIn('synthetic-private', json.dumps(complete))
        fresh = continuity.read_database(self.state)
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            continuity.assert_database_continuity(complete['summary'], fresh['summary'])

    def test_complete_capture_without_auth_also_shares_protected_row_transaction(self):
        baseline = continuity.read_database(self.state)
        capture = continuity.capture_connection
        def commit_after_rows(db):
            self.fixture.advance()
            return capture(db)
        with patch.object(continuity, 'capture_connection', side_effect=commit_after_rows):
            rows, private, complete = plain_update._rows_snapshot(self.state, False, include_database=True)
        self.assertIsNone(private)
        self.assertEqual(complete, baseline)
        continuity.bind_rows(complete, rows)

    def test_full_capture_keeps_schema_and_private_auth_coherent(self):
        baseline = continuity.read_database(self.state)
        capture = continuity.capture_connection
        def commit_schema_after_auth(db):
            self.assertTrue(db.in_transaction)
            with self.assertRaisesRegex(sqlite3.OperationalError, 'readonly'):
                db.execute("UPDATE unprotected_blob SET value='write'")
            self.writer.execute('ALTER TABLE auth_sessions ADD COLUMN another TEXT')
            self.writer.commit()
            return capture(db)
        with patch.object(continuity, 'capture_connection', side_effect=commit_schema_after_auth):
            rows, private, complete = plain_update._rows_snapshot(self.state, True, include_database=True)
        self.assertEqual(complete, baseline)
        self.assertNotIn('another', private['columns'])
        heartbeat.bind_auth(private, rows)
        self.assertNotEqual(continuity.read_database(self.state)['schema'], complete['schema'])

    def test_full_database_and_auth_consumer_read_remains_coherent_after_capture(self):
        rows = plain_update.rows_snapshot(self.state)
        baseline = continuity.read_database(self.state, rows)
        read_auth = heartbeat.read_auth_sessions_in_transaction
        connections = []
        def commit_after_full_capture(db, expected):
            connections.append(db)
            self.fixture.advance()
            return read_auth(db, expected)
        with patch.object(heartbeat, 'read_auth_sessions_in_transaction', side_effect=commit_after_full_capture):
            complete, private = continuity.read_database_with_auth(self.state, rows)
        self.assertEqual(complete, baseline)
        heartbeat.bind_auth(private, rows)
        with self.assertRaises(sqlite3.ProgrammingError):
            connections[0].execute('SELECT 1')
        with self.assertRaisesRegex(AssertionError, 'Database changed during protected row readback'):
            continuity.read_database_with_auth(self.state, rows)

    def test_mismatched_rows_and_active_work_remain_rejected(self):
        rows = plain_update.rows_snapshot(self.state)
        rows['hashes']['auth_sessions'] = '0' * 64
        with self.assertRaises(AssertionError): continuity.read_database_with_auth(self.state, rows)
        self.writer.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('running')")
        self.writer.commit()
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            plain_update._rows_snapshot(self.state, True, include_database=True)


class SavedProofRecompute(unittest.TestCase):
    """verify_update_database recomputes a saved non-migration update proof from live state."""

    def setUp(self):
        self.fixture = fixtures.CoherentAuthRead()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.state = self.fixture.state

    def snapshot(self, auth=False):
        rows, private, database = plain_update._rows_snapshot(self.state, auth, include_database=True)
        public = {'identity': 'm3', 'artifactSourceCommit': 'a' * 40, 'archiveSha256': 'b' * 64,
                  'rows': rows, 'databaseCapture': database, 'observedAt': END}
        return public, private

    def report(self, before, after, kind='byte-identical', witness=None):
        value = {'before': before, 'after': after, 'rowsByteIdentical': before['rows'] == after['rows'],
                 'rowPreservation': kind, 'restartStartedAt': START}
        if witness is not None: value['authHeartbeatWitness'] = witness
        return value

    def test_byte_identical_proof_recomputes_and_live_drift_fails(self):
        before, _ = self.snapshot()
        after, _ = self.snapshot()
        final, _ = self.snapshot()
        result = continuity.verify_update_database(self.report(before, after), final, self.state)
        self.assertEqual(result['authHeartbeatWitness'], None)
        self.fixture.writer.execute('CREATE TABLE late_unprotected(value TEXT)')
        self.fixture.writer.commit()
        with self.assertRaisesRegex(AssertionError, 'Live complete database differs from final snapshot'):
            continuity.verify_update_database(self.report(before, after), final, self.state)

    def test_saved_proof_with_forged_rows_fails_on_complete_capture(self):
        before, _ = self.snapshot()
        self.fixture.writer.execute("UPDATE scheduled_tasks SET content='changed-behind-a-forged-row-report'")
        self.fixture.writer.commit()
        after, _ = self.snapshot()
        after['rows'] = copy.deepcopy(before['rows'])  # A forged protected-row report.
        with self.assertRaises(AssertionError):
            continuity.verify_update_database(self.report(before, after), after, self.state)

    def test_heartbeat_proof_recomputes_with_complete_continuity(self):
        before, original = self.snapshot(auth=True)
        self.fixture.advance()
        after, current = self.snapshot(auth=True)
        witness = heartbeat.prove_restart_heartbeat(before['rows'], after['rows'], original, current, START, END, identity='m3')
        report = self.report(before, after, 'verified-existing-browser-heartbeat', witness)
        with self.assertRaisesRegex(AssertionError, 'explicit opt-in'):
            continuity.verify_update_database(report, after, self.state)
        result = continuity.verify_update_database(report, after, self.state, allow_existing_browser_heartbeat=True)
        self.assertEqual(result['authHeartbeatWitness']['changedRows'], 1)
        self.assertNotIn('synthetic-private', json.dumps(result))

    def test_migrated_or_capture_less_proofs_are_not_accepted_here(self):
        before, _ = self.snapshot()
        after, _ = self.snapshot()
        with self.assertRaisesRegex(AssertionError, 'non-migration'):
            continuity.verify_update_database(self.report(before, after, 'verified-migration'), after, self.state)
        legacy = copy.deepcopy(before); del legacy['databaseCapture']
        with self.assertRaisesRegex(AssertionError, 'Complete database proof missing'):
            continuity.verify_update_database(self.report(legacy, after), after, self.state)


class UpdaterContinuity(unittest.TestCase):
    """update.apply with real temporary SQLite under the existing ApplyRecovery harness."""

    def harness(self, heartbeat_change=False):
        fixture = updater_base.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        self.updater = updater_base.update
        state = fixture.own / 'userdata'
        build(state / 'statev2.sqlite', (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).isoformat())
        fixture.rows = plain_update.rows_snapshot(state)  # The harness patches the updater copy.
        fixture.before['rows'] = copy.deepcopy(fixture.rows)
        fixture.before['databaseCapture'] = continuity.read_database(state, fixture.rows)
        self.restart_sql = []
        def advance():
            db = sqlite3.connect(state / 'statev2.sqlite')
            if heartbeat_change:
                db.execute('UPDATE auth_sessions SET last_connected_at=?', (datetime.datetime.now(datetime.timezone.utc).isoformat(),))
            for sql in self.restart_sql: db.executescript(sql)
            db.commit(); db.close()
            fixture.rows = plain_update.rows_snapshot(state)  # The harness patches the updater copy.
        fixture.on_restart = advance
        fixture.after_mutation = lambda after: after.update(databaseCapture=continuity.read_database(state))
        self.state = state
        return fixture

    def unchanged_pointers(self, fixture):
        return all(path.read_bytes() == value for path, value in fixture.original.items())

    def test_identical_database_update_verifies_complete_continuity(self):
        fixture = self.harness()
        fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['rowPreservation'], 'byte-identical')
        self.assertEqual(result['completeDatabaseContinuity'], 'verified')
        self.assertEqual(result['before']['databaseCapture'], result['after']['databaseCapture'])
        self.assertNotIn('synthetic-private', fixture.output.read_text())

    def test_unprotected_row_changed_across_restart_fails(self):
        fixture = self.harness()
        self.restart_sql = ["UPDATE scheduled_task_webhook_relay_deliveries SET payload='lost'"]
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['result'], 'update-failed')
        self.assertEqual(result['attemptedAfter']['rows'], result['before']['rows'])  # Row proof alone missed it.

    def test_schema_change_across_restart_fails(self):
        fixture = self.harness()
        self.restart_sql = ['CREATE INDEX extra ON checkpoint_diff_blobs(body)']
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            fixture.execute()
        self.assertEqual(json.loads(fixture.output.read_text())['result'], 'update-failed')

    def test_unprotected_change_before_restart_is_rejected_without_restart(self):
        fixture = self.harness()
        read = self.updater.rows_since_with_database
        def changed(state, expected_rows):
            # The change lands just before the updater's last pre-restart read.
            db = sqlite3.connect(self.state / 'statev2.sqlite')
            db.execute("UPDATE checkpoint_diff_blobs SET body='abcd'"); db.commit(); db.close()
            return read(state, expected_rows)
        with patch.object(self.updater, 'rows_since_with_database', side_effect=changed), \
                self.assertRaisesRegex(AssertionError, 'Complete database changed before restart'):
            fixture.execute()
        self.assertEqual(fixture.restart_calls, [])
        self.assertTrue(self.unchanged_pointers(fixture))

    def test_prestate_capture_mismatch_is_rejected_before_any_pointer_write(self):
        fixture = self.harness()
        expected = copy.deepcopy(fixture.before)
        expected['databaseCapture']['summary']['tables']['checkpoint_diff_blobs']['sha256'] = '0' * 64
        fixture.before, live = expected, fixture.before
        fixture.snapshot = lambda identity: copy.deepcopy(live)
        with self.assertRaisesRegex(AssertionError, 'Complete database prestate changed'):
            fixture.execute()
        self.assertEqual(fixture.restart_calls, [])
        self.assertTrue(self.unchanged_pointers(fixture))
        missing = copy.deepcopy(live); del missing['databaseCapture']
        with self.assertRaisesRegex(AssertionError, 'Complete database proof missing'):
            self.updater.assert_prestate(missing, live)

    def test_heartbeat_update_composes_with_complete_continuity(self):
        fixture = self.harness(heartbeat_change=True)
        fixture.execute(True)
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['rowPreservation'], 'verified-existing-browser-heartbeat')
        self.assertEqual(result['completeDatabaseContinuity'], 'verified')
        self.assertNotEqual(result['before']['databaseCapture'], result['after']['databaseCapture'])
        self.assertNotIn('synthetic-private', fixture.output.read_text())

    def test_heartbeat_cannot_hide_an_unprotected_change(self):
        fixture = self.harness(heartbeat_change=True)
        self.restart_sql = ['DELETE FROM checkpoint_diff_blobs']
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            fixture.execute(True)
        self.assertEqual(json.loads(fixture.output.read_text())['result'], 'update-failed')

    def test_strict_update_rejects_a_heartbeat_without_opt_in(self):
        fixture = self.harness(heartbeat_change=True)
        with self.assertRaises(AssertionError):
            fixture.execute()
        self.assertEqual(json.loads(fixture.output.read_text())['result'], 'update-failed')

    def test_migration_path_records_capture_but_keeps_its_own_preservation_rules(self):
        fixture = self.harness()
        self.restart_sql = ['CREATE TABLE project_new_feature(value TEXT)',
                            "INSERT INTO effect_sql_migrations VALUES (2, '2026-10-10 09:00:00', 'NewFeature')"]
        fixture.execute(allow_project_migrations=True)
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['rowPreservation'], 'verified-migration')
        self.assertEqual(result['completeDatabaseContinuity'], 'not-compared-migration')
        self.assertIn('project_new_feature', result['after']['databaseCapture']['summary']['tables'])


class CarriedActivityContinuity(unittest.TestCase):
    """A thread waiting on a usage limit appends while the update stages (base PR #74).

    The complete capture accepts exactly what the guarded rows accept: new log rows after
    typed-identical earlier rows, that thread's projection rows and the projection cursor.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-database-continuity-waiting-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name)
        updater_base.waiting_fixture(self.state)
        updater_base.mutate_state(self.state, 'CREATE TABLE checkpoint_diff_blobs(id INTEGER PRIMARY KEY, body BLOB)',
                                  "INSERT INTO checkpoint_diff_blobs(body) VALUES (x'abcd')",
                                  "UPDATE orchestration_events SET payload_json=x'6162' WHERE sequence=1",
                                  'CREATE TABLE webhook_deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)',
                                  "INSERT INTO webhook_deliveries(body) VALUES ('delivered')")
        self.rows, _, _, self.capture = plain_update._read_state(self.state, False, None, True)

    def prestate(self, rows, capture):
        value = {key: key for key in ['identity', 'uid', 'serviceLabel', 'servicePid', 'archiveSha256',
                                      'artifactSourceCommit', 'otherListeners', 'cookieName', 'processQuiescence']}
        value.update(fileHashes={'settings': 's'}, rows=rows, databaseCapture=capture)
        return value

    def current(self):
        return plain_update.rows_since_with_database(self.state, self.rows)

    def test_appended_waiting_thread_checks_keep_complete_continuity(self):
        updater_base.waiting_check(self.state, 'a'); updater_base.waiting_check(self.state, 'bb')
        rows, carried, capture = self.current()
        self.assertNotEqual(continuity.encoded(capture['summary']), continuity.encoded(self.capture['summary']))
        plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)
        with self.assertRaisesRegex(AssertionError, 'Complete database prestate changed'):
            plain_update.assert_capture_carried(self.capture, capture, self.rows, rows, None)

    def test_appended_rows_never_excuse_an_unprotected_change(self):
        updater_base.waiting_check(self.state, 'a')
        updater_base.mutate_state(self.state, "UPDATE checkpoint_diff_blobs SET body=x'beef'")
        rows, carried, capture = self.current()
        self.assertTrue(plain_update.same_guarded_rows(self.rows, rows, carried))  # Row proof alone misses it.
        with self.assertRaisesRegex(AssertionError, 'Complete database prestate changed'):
            plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)

    def test_appended_rows_never_excuse_a_schema_change(self):
        updater_base.waiting_check(self.state, 'a')
        updater_base.mutate_state(self.state, 'CREATE INDEX extra ON checkpoint_diff_blobs(body)')
        rows, carried, capture = self.current()
        with self.assertRaisesRegex(AssertionError, 'Complete database prestate changed'):
            plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)

    def test_typed_prefix_catches_blob_to_hex_text_edit_of_an_earlier_log_row(self):
        updater_base.waiting_check(self.state, 'a')
        updater_base.mutate_state(self.state, "UPDATE orchestration_events SET payload_json='6162' WHERE sequence=1")
        rows, carried, capture = self.current()
        # The legacy encoder maps BLOB x'6162' and TEXT '6162' to the same line.
        self.assertTrue(plain_update.same_guarded_rows(self.rows, rows, carried))
        with self.assertRaisesRegex(AssertionError, 'Complete database prestate changed'):
            plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)

    def test_only_counters_of_grown_logs_may_move_and_only_forward(self):
        for statement in ["UPDATE sqlite_sequence SET seq=seq+1 WHERE name='webhook_deliveries'",
                          "UPDATE sqlite_sequence SET seq=1 WHERE name='orchestration_events'",
                          "DELETE FROM sqlite_sequence WHERE name='webhook_deliveries'"]:
            with self.subTest(statement=statement):
                self.setUp()
                updater_base.waiting_check(self.state, 'a')
                updater_base.mutate_state(self.state, statement)
                rows, carried, capture = self.current()
                self.assertTrue(plain_update.same_guarded_rows(self.rows, rows, carried))
                with self.assertRaisesRegex(AssertionError, 'Complete database prestate changed'):
                    plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)

    def test_a_heartbeat_passes_the_prestate_only_with_equal_auth_invariants(self):
        updater_base.mutate_state(self.state, "UPDATE auth_sessions SET last_connected_at='2026-10-11T05:00:00Z'")
        rows, carried, capture = self.current()
        plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            plain_update.assert_capture_carried(self.capture, capture, self.rows, rows, carried, auth_heartbeat=False,
                                                message='Complete preexisting database changed')
        updater_base.mutate_state(self.state, "UPDATE auth_sessions SET scopes='admin'")
        rows, carried, capture = self.current()
        with self.assertRaises(AssertionError):
            plain_update.assert_prestate(self.prestate(self.rows, self.capture), self.prestate(rows, capture), carried)

    def harness(self):
        fixture = updater_base.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        state = fixture.own / 'userdata'
        updater_base.waiting_fixture(state)
        updater_base.mutate_state(state, 'CREATE TABLE checkpoint_diff_blobs(id INTEGER PRIMARY KEY, body BLOB)',
                                  "INSERT INTO checkpoint_diff_blobs(body) VALUES (x'abcd')")
        fixture.real_db = True
        fixture.rows = plain_update.rows_snapshot(state)
        fixture.before['rows'] = copy.deepcopy(fixture.rows)
        fixture.before['databaseCapture'] = continuity.read_database(state, fixture.rows)
        since = fixture.snapshot_since
        def snapshot_since(identity, expected_rows, include_auth=False):
            public, auth, carried = since(identity, expected_rows, include_auth)
            public['databaseCapture'] = continuity.read_database(state, public['rows'])
            return public, auth, carried
        fixture.snapshot_since = snapshot_since
        fixture.on_stage = lambda: updater_base.waiting_check(state, 'staged')
        self.restart_sql = []
        def restart():
            updater_base.waiting_check(state, 'restarted')
            updater_base.mutate_state(state, *self.restart_sql)
        fixture.on_restart = restart
        return fixture

    def test_update_with_appended_activity_verifies_complete_continuity(self):
        fixture = self.harness()
        fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['rowPreservation'], 'verified-appended-activity')
        self.assertEqual(result['completeDatabaseContinuity'], 'verified')
        self.assertEqual(result['appendedLogRows'], {'orchestration_events': 2, 'orchestration_command_receipts': 2})
        self.assertNotIn('synthetic-private', fixture.output.read_text())

    def test_appended_activity_never_hides_an_unprotected_change_across_restart(self):
        fixture = self.harness()
        self.restart_sql = ["UPDATE checkpoint_diff_blobs SET body=x'beef'"]
        with self.assertRaisesRegex(AssertionError, 'Complete preexisting database changed'):
            fixture.execute()
        self.assertEqual(json.loads(fixture.output.read_text())['result'], 'update-failed')


if __name__ == '__main__':
    unittest.main()
