#!/usr/bin/env python3
"""`update.py verify --local` (post_update_check.py): a home captured before the new build starts
on it passes only when the new release's migrations kept every project, thread, history row,
setting and the environment id. Temporary homes with a small statev2 schema; no service.

Run: cd scripts/studio-fleet && python3 -B test-post-update-check.py
"""
import datetime
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import post_update_check  # noqa: E402

SCHEMA = """
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(request_id TEXT, prompt TEXT, status TEXT);
CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions(session_id TEXT, status TEXT);
CREATE TABLE auth_pairing_links(id TEXT PRIMARY KEY, subject TEXT, revoked_at TEXT, consumed_at TEXT);
CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL,
 method TEXT NOT NULL, client_label TEXT, client_surface TEXT, client_app_version TEXT,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_connected_at TEXT, revoked_at TEXT, token_digest BLOB);
CREATE TABLE orchestration_v2_events(event_id TEXT, thread_id TEXT, payload TEXT);
INSERT INTO projection_projects VALUES ('project-1', 'E2E project');
INSERT INTO orchestration_v2_projection_threads VALUES ('thread-1', 'E2E thread');
INSERT INTO orchestration_v2_projection_runs VALUES ('run-1', 'thread-1', 'completed');
INSERT INTO auth_pairing_links VALUES ('link-1', 'administrative-bootstrap', NULL, '2026-11-01');
INSERT INTO auth_sessions VALUES ('session-1', 'owner', '["read","write"]', 'browser-session-cookie', 'Browser', 'web',
 '1.0.183', '2026-11-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', NULL, X'00ff');
INSERT INTO orchestration_v2_events VALUES ('event-1', 'thread-1', '{"type":"thread.created"}');
"""
SETTINGS = {'providerInstances': {'e2e-fake': {'driver': 'acpRegistry', 'enabled': True}}, 'theme': 'dark'}


def run_cli(*args):
    return subprocess.run([sys.executable, '-B', str(HERE / 'update.py'), 'verify', *args],
                          capture_output=True, text=True, timeout=60)


class PostUpdateCheck(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        self.base = self.root / 'base'
        userdata = self.base / 'userdata'
        userdata.mkdir(parents=True)
        self.database = userdata / 'statev2.sqlite'
        db = sqlite3.connect(self.database)
        db.executescript(SCHEMA)
        db.commit()
        db.close()
        self.settings = userdata / 'settings.json'
        self.settings.write_text(json.dumps(SETTINGS))
        (userdata / 'environment-id').write_text('environment-1\n')
        self.before = self.root / 'before.json'
        self.receipt = self.root / 'receipt.json'

    def migrate(self, *statements):
        db = sqlite3.connect(self.database)
        for statement in statements:
            db.execute(statement)
        db.commit()
        db.close()

    def capture(self):
        result = run_cli('--local', '--state', str(self.base), '--capture', str(self.before))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['result'], 'captured')

    def against(self):
        return run_cli('--local', '--state', str(self.base), '--against', str(self.before), '--output', str(self.receipt))

    def test_a_migration_that_adds_a_table_and_grows_a_projection_is_verified(self):
        self.capture()
        self.migrate('CREATE TABLE project_retention_horizons(project_id TEXT)',
                     "INSERT INTO orchestration_v2_projection_threads VALUES ('thread-2', 'New thread')")
        settings = json.loads(self.settings.read_text())
        settings['newDefault'] = True  # A new release may add settings; none may be lost.
        self.settings.write_text(json.dumps(settings))
        result = self.against()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt['result'], 'verified')
        self.assertEqual((receipt['projects'], receipt['threads']), (1, 2))

    def test_rows_the_new_server_appends_and_its_heartbeat_are_verified(self):
        self.capture()
        self.assertEqual(self.before.stat().st_mode & 0o777, 0o600)  # It holds the auth cells.
        now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        self.migrate("INSERT INTO orchestration_v2_events VALUES ('event-2', 'thread-1', '{\"type\":\"turn.started\"}')",
                     "UPDATE auth_sessions SET last_connected_at = '%s' WHERE session_id = 'session-1'" % now)
        result = self.against()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual((receipt['result'], receipt['heartbeat'], receipt['migrationCells']), ('verified', True, 'typed-verified'))
        self.assertFalse(receipt['rowsByteIdentical'])
        self.assertNotIn('privateAuth', receipt)
        self.assertNotIn('00ff', self.receipt.read_text())

    def test_a_changed_history_row_fails_even_with_rows_appended(self):
        self.capture()
        self.migrate("INSERT INTO orchestration_v2_events VALUES ('event-2', 'thread-1', '{}')",
                     "UPDATE orchestration_v2_events SET payload = '{\"type\":\"edited\"}' WHERE event_id = 'event-1'")
        result = self.against()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('History, provider, schedule or pairing rows changed during migration', result.stderr)
        self.assertEqual(json.loads(self.receipt.read_text())['result'], 'failed')

    def test_a_changed_auth_cell_fails(self):
        self.capture()
        self.migrate("UPDATE auth_sessions SET scopes = '[\"read\"]'")
        result = self.against()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('Heartbeat changed another auth cell: scopes', result.stderr)

    def test_a_lost_thread_fails_with_a_refusal_and_a_failed_receipt(self):
        self.capture()
        self.migrate("DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-1'")
        result = self.against()
        self.assertEqual(result.returncode, 1)
        self.assertIn('REFUSAL post-update-check A thread disappeared during migration', result.stderr)
        self.assertEqual(json.loads(self.receipt.read_text())['result'], 'failed')

    def test_a_changed_pairing_row_fails(self):
        self.capture()
        self.migrate("UPDATE auth_pairing_links SET revoked_at = '2026-11-04'")
        result = self.against()
        self.assertEqual(result.returncode, 1)
        self.assertIn('History, provider, schedule or pairing rows changed during migration', result.stderr)

    def test_a_lost_setting_fails(self):
        self.capture()
        self.settings.write_text(json.dumps({'theme': 'dark'}))
        result = self.against()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(self.receipt.read_text())['result'], 'failed')

    def test_a_changed_environment_id_fails(self):
        self.capture()
        (self.base / 'userdata' / 'environment-id').write_text('environment-2\n')
        result = self.against()
        self.assertEqual(result.returncode, 1)
        self.assertIn('The environment id changed after the update', result.stderr)

    def test_a_busy_home_is_refused_before_the_capture(self):
        self.migrate("INSERT INTO orchestration_v2_projection_runs VALUES ('run-2', 'thread-1', 'running')")
        with self.assertRaises(AssertionError):
            post_update_check.capture(self.base)
        self.assertFalse(self.before.exists())

    def test_local_is_required_and_against_needs_an_output(self):
        self.assertEqual(run_cli('--state', str(self.base), '--capture', str(self.before)).returncode, 2)
        self.assertEqual(run_cli('--local', '--state', str(self.base), '--against', str(self.before)).returncode, 2)
        self.assertFalse(self.before.exists())


if __name__ == '__main__':
    unittest.main()
