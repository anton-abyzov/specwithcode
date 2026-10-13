#!/usr/bin/env python3
"""Synthetic database fixtures only: never opens a live Studio database."""
import contextlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
import provider_failures


def make_database(path):
    connection = sqlite3.connect(path)
    connection.executescript('''
        create table orchestration_v2_projection_runs (run_id text, thread_id text, provider text, status text,
            requested_at text, completed_at text);
        create table orchestration_v2_projection_threads (thread_id text, title text);
        create table orchestration_v2_projection_turn_items (run_id text, type text, updated_at text, payload_json text);
    ''')
    def run(run_id, status, requested, failure=None, title='Club finance'):
        connection.execute('insert into orchestration_v2_projection_runs values (?,?,?,?,?,?)',
                           (run_id, 'thread-' + run_id, 'claudeAgent', status, requested, requested))
        connection.execute('insert into orchestration_v2_projection_threads values (?,?)', ('thread-' + run_id, title))
        if failure is not None:
            connection.execute('insert into orchestration_v2_projection_turn_items values (?,?,?,?)',
                               (run_id, 'error', requested, json.dumps({'title': 'Provider error', 'failure': failure})))
    run('old', 'failed', '2026-10-10T00:00:00.000Z', {'class': 'provider_error', 'message': 'Old failure.'})
    run('ok', 'completed', '2026-10-12T10:00:00.000Z')
    run('generic', 'failed', '2026-10-12T12:39:19.000Z', {'class': 'transport_error', 'message': 'Provider turn failed.'})
    run('timeout', 'failed', '2026-10-12T19:19:26.000Z', {'class': 'provider_error', 'message': 'The native provider status check timed out. Refresh Providers on this machine and try again.'})
    run('timeout2', 'failed', '2026-10-12T19:30:00.000Z', {'class': 'provider_error', 'message': 'The native provider status check timed out. Refresh Providers on this machine and try again.'})
    run('missing', 'failed', '2026-10-12T20:00:00.000Z')
    connection.commit()
    connection.close()


class ProviderFailureReport(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = os.path.join(self.directory.name, 'statev2.sqlite')
        make_database(self.database)

    def tearDown(self):
        self.directory.cleanup()

    def test_lists_failed_runs_since_the_cutoff_with_their_reason(self):
        with provider_failures.open_read_only(self.database) as connection:
            rows = provider_failures.failures(connection, '2026-10-11T00:00:00.000Z')
        self.assertEqual([row['runId'] for row in rows], ['generic', 'timeout', 'timeout2', 'missing'])
        self.assertEqual(rows[0]['threadTitle'], 'Club finance')
        self.assertFalse(rows[0]['explained'])
        self.assertTrue(rows[1]['explained'])
        self.assertEqual(rows[3]['message'], 'No error was recorded for this run.')

    def test_counts_failures_by_reason_most_frequent_first(self):
        with provider_failures.open_read_only(self.database) as connection:
            rows = provider_failures.failures(connection, '2026-10-11T00:00:00.000Z')
        top = provider_failures.summary(rows)[0]
        self.assertEqual(top['count'], 2)
        self.assertIn('status check timed out', top['message'])

    def test_opens_the_database_read_only(self):
        with provider_failures.open_read_only(self.database) as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("insert into orchestration_v2_projection_threads values ('x', 'y')")

    def test_json_report_counts_unexplained_failures(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            provider_failures.main(['--database', self.database, '--hours', '1000000', '--json'])
        report = json.loads(buffer.getvalue())
        self.assertEqual(report['failedRuns'], 5)
        self.assertEqual(report['unexplained'], 1)


if __name__ == '__main__':
    unittest.main()
