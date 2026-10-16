#!/usr/bin/env python3
"""Real temporary SQLite WAL races; no production state, native calls or credentials."""
import copy
import json
import pathlib
import os
import pwd
import types
import plistlib
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import auth_heartbeat as heartbeat
import update
import database_continuity as continuity
from launcher import runtime_path

OLD = '2026-10-09T09:00:00.000Z'
NEW = '2026-10-09T10:00:01.000Z'
START = '2026-10-09T10:00:00+00:00'
END = '2026-10-09T10:00:02+00:00'

# Stands in for the running service: like the service's own connection it keeps the WAL
# database open, which holds SQLite's locks on statev2.sqlite and -shm (#228). A connection in
# this test process cannot: F_GETLK never reports the caller's own locks.
SERVICE_HOLDER = '''
import sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute('SELECT count(*) FROM auth_sessions').fetchone()
print('ready', flush=True)
sys.stdin.read()
db.close()
'''


class CoherentAuthRead(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-auth-read-consistency-')
        self.home = pathlib.Path(self.temp.name).resolve()
        self.state = self.home / '.specwithcode/m3/userdata'
        self.state.mkdir(parents=True)
        self.writer = sqlite3.connect(self.state / 'statev2.sqlite')
        self.assertEqual(self.writer.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
        self.writer.executescript('''
            CREATE TABLE projection_projects(project_id TEXT);
            CREATE TABLE projection_threads(thread_id TEXT);
            CREATE TABLE orchestration_v2_projection_runs(status TEXT);
            CREATE TABLE orchestration_v2_projection_runtime_requests(status TEXT);
            CREATE TABLE orchestration_v2_effect_outbox(status TEXT);
            CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT);
            CREATE TABLE scheduled_tasks(content TEXT);
            CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, method TEXT,
                client_surface TEXT, issued_at TEXT, expires_at TEXT, last_connected_at TEXT,
                revoked_at TEXT, credential BLOB, scopes TEXT);
            INSERT INTO projection_projects VALUES ('project');
            INSERT INTO projection_threads VALUES ('thread');
            INSERT INTO scheduled_tasks VALUES ('synthetic-private-history');
        ''')
        self.row = ('synthetic-private-session', 'bearer-access-token', 'web',
                    '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', OLD,
                    None, b'synthetic-private-credential', '["read"]')
        self.writer.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?)', self.row)
        self.writer.commit()

    def tearDown(self):
        self.writer.close()
        self.temp.cleanup()

    def advance(self):
        self.writer.execute('UPDATE auth_sessions SET last_connected_at=?', (NEW,))
        self.writer.commit()

    def prove(self, before, original, after, current):
        return heartbeat.prove_restart_heartbeat(before, after, original, current, START, END, identity='m3')

    def test_separate_transactions_reproduce_the_n6_hash_mismatch(self):
        before = update.rows_snapshot(self.state)
        self.advance()
        with self.assertRaisesRegex(AssertionError, 'Complete auth hash changed during readback'):
            heartbeat.read_auth_sessions(self.state, before)

    def test_paired_transaction_retains_exact_hash_when_wal_writer_commits_between_reads(self):
        baseline = update.rows_snapshot(self.state)
        reader = heartbeat.read_auth_sessions_in_transaction
        connections = []

        def concurrent_commit(db, expected):
            connections.append(db)
            self.assertTrue(db.in_transaction)
            with self.assertRaisesRegex(sqlite3.OperationalError, 'readonly'):
                db.execute('UPDATE auth_sessions SET scopes=\'[]\'')
            self.advance()  # A separate connection commits while the RO snapshot remains open.
            return reader(db, expected)

        with patch.object(update, 'read_auth_sessions_in_transaction', side_effect=concurrent_commit):
            protected, private = update.rows_snapshot_with_auth(self.state)
        self.assertEqual(protected, baseline)
        self.assertEqual(private['rows'][0][private['columns'].index('last_connected_at')], OLD)
        heartbeat.bind_auth(private, protected)
        current, current_auth = update.rows_snapshot_with_auth(self.state)
        self.assertNotEqual(current['hashes']['auth_sessions'], protected['hashes']['auth_sessions'])
        self.assertEqual(self.prove(protected, private, current, current_auth)['changedRows'], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            connections[0].execute('SELECT 1')  # Caller closed its transaction and connection.

    def test_auth_schema_is_from_the_same_snapshot_as_protected_rows(self):
        before, original = update.rows_snapshot_with_auth(self.state)
        reader = heartbeat.read_auth_sessions_in_transaction

        def concurrent_schema_commit(db, expected):
            self.writer.execute('ALTER TABLE auth_sessions ADD COLUMN extra TEXT')
            self.writer.commit()
            return reader(db, expected)

        with patch.object(update, 'read_auth_sessions_in_transaction', side_effect=concurrent_schema_commit):
            paired, private = update.rows_snapshot_with_auth(self.state)
        self.assertEqual((paired, private), (before, original))
        fresh, fresh_auth = update.rows_snapshot_with_auth(self.state)
        with self.assertRaisesRegex(AssertionError, 'Complete auth schema changed'):
            self.prove(before, original, fresh, fresh_auth)

    def test_private_rows_never_enter_the_serializable_public_proof(self):
        public, private = update.rows_snapshot_with_auth(self.state)
        serialized = json.dumps(public)
        for secret in ['synthetic-private-session', 'synthetic-private-credential', 'synthetic-private-history']:
            self.assertNotIn(secret, serialized)
        self.assertIn('synthetic-private-session', str(private['rows']))
        self.assertNotIn('schema', public)
        self.assertNotIn('columns', public)
        self.assertEqual(public, update.rows_snapshot(self.state))

    def hold_database_like_the_service(self):
        holder = subprocess.Popen([sys.executable, '-B', '-c', SERVICE_HOLDER, str(self.state / 'statev2.sqlite')],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.wait, 10)
        self.addCleanup(holder.stdin.close)
        self.addCleanup(holder.stdout.close)
        self.assertEqual(holder.stdout.readline().strip(), 'ready')
        return holder.pid

    def test_public_snapshot_api_keeps_auth_private_and_uses_the_same_wal_snapshot(self):
        own = self.state.parent
        pid = self.hold_database_like_the_service()
        uid, user = os.getuid(), pwd.getpwuid(os.getuid()).pw_name
        node = self.home / 'tools/node22'
        node.parent.mkdir()
        node.write_bytes(b'synthetic-node-never-executed')
        release = self.home / '.specwithcode/install/releases' / ('b' * 20)
        release.mkdir(parents=True)
        binary = b'synthetic-runtime-never-executed'
        (release / 'bin.mjs').write_bytes(binary)
        (release / 'studio-manifest.json').write_text(json.dumps({
            'product': 'SpecWeave Studio', 'version': '0.1.0', 'sourceCommit': 'a' * 40,
            'files': [{'path': 'bin.mjs', 'type': 'file', 'sha256': update.digest(binary)}]}))
        label = 'com.specweave.studio.m3'
        launcher = own / 'launch.sh'
        wrapper = self.home / '.local/bin/specweave-studio'
        wrapper.parent.mkdir(parents=True)
        prefix = ['/usr/bin/env', '-i', 'HOME=' + str(self.home),
                  'PATH=' + runtime_path(self.home, node), 'USER=' + user, 'LOGNAME=' + user,
                  'STUDIO_HOME=' + str(own), 'STUDIO_PORT=8319', 'STUDIO_HOST=127.0.0.1',
                  'STUDIO_MODE=web', 'STUDIO_NO_BROWSER=true', 'STUDIO_ENABLE_HOSTED_SERVICES=false',
                  str(node), str(release / 'bin.mjs')]
        tail = ['start', '--no-browser', '--host', '127.0.0.1', '--port', '8319', '--base-dir', str(own), '--mode', 'web']
        launcher.write_text('#!/bin/sh\nset -eu\numask 077\ncd ' + shlex.quote(str(own)) + '\nexec ' +
                            ' '.join(shlex.quote(part) for part in prefix + tail) + '\n')
        wrapper.write_text(update.render_cli(prefix))
        plist = self.home / 'Library/LaunchAgents' / (label + '.plist')
        plist.parent.mkdir(parents=True)
        plist.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': ['/usr/bin/caffeinate', '-s', str(launcher)],
            'WorkingDirectory': str(own), 'StandardOutPath': str(own / 'stdout.log'), 'StandardErrorPath': str(own / 'stderr.log')}))
        (own / 'installation.json').write_text(json.dumps({'identity': 'm3', 'studioHome': str(own), 'uid': uid, 'user': user,
            'stateDir': str(self.state), 'cliWrapper': str(wrapper), 'service': {'installed': True, 'label': label, 'domain': 'gui/' + str(uid)},
            'port': 8319, 'host': '127.0.0.1', 'node': str(node), 'release': str(release),
            'archiveSha256': 'b' * 64, 'sourceCommit': 'a' * 40, 'cookieName': 'synthetic-cookie'}))
        (self.state / 'settings.json').write_text('{}')
        (self.state / 'environment-id').write_text('synthetic-environment')
        (self.state / 'server-runtime.json').write_text(json.dumps({'pid': pid, 'host': '127.0.0.1', 'port': 8319}))

        def transport(command, **kwargs):
            if command == [str(node), '--version']:
                return b'v22.20.0'
            if command == ['/bin/launchctl', 'print', 'gui/' + str(uid) + '/' + label]:
                return 'pid = ' + str(pid) + '\nstate = running\npath = ' + str(plist)
            if command == ['/bin/ps', '-p', str(pid), '-o', 'command=']:
                return str(node) + ' ' + str(release / 'bin.mjs')
            self.fail('Unexpected external command')

        reader = heartbeat.read_auth_sessions_in_transaction
        def concurrent_commit(db, expected):
            self.advance()
            return reader(db, expected)

        baseline = update.rows_snapshot(self.state)
        full_baseline = continuity.read_database(self.state, baseline)
        with patch.object(pathlib.Path, 'home', return_value=self.home), patch.object(pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_name=user, pw_dir=str(self.home))), \
             patch.object(update, 'run', side_effect=transport), patch.object(update, 'listeners', side_effect=lambda p: [pid] if p == 8319 else []), \
             patch.object(update, 'capture_quiescence', return_value={'synthetic': 'idle'}), \
             patch.object(update, 'read_auth_sessions_in_transaction', side_effect=concurrent_commit):
            public, private = update.snapshot_with_auth('m3')
        self.assertEqual(public['rows'], baseline)
        self.assertEqual(public['databaseCapture'], full_baseline)
        heartbeat.bind_auth(private, public['rows'])
        self.assertNotIn('synthetic-private', json.dumps(public))
        self.assertNotIn('auth', public)
        self.assertNotEqual(update.rows_snapshot(self.state), public['rows'])

    def test_shared_reader_requires_an_open_transaction_and_exact_hash(self):
        expected = update.rows_snapshot(self.state)
        db = sqlite3.connect('file:' + str(self.state / 'statev2.sqlite') + '?mode=ro', uri=True)
        try:
            with self.assertRaisesRegex(AssertionError, 'existing read transaction'):
                heartbeat.read_auth_sessions_in_transaction(db, expected)
            db.execute('BEGIN')
            wrong = copy.deepcopy(expected)
            wrong['hashes']['auth_sessions'] = '0' * 64
            with self.assertRaisesRegex(AssertionError, 'Complete auth hash changed'):
                heartbeat.read_auth_sessions_in_transaction(db, wrong)
        finally:
            db.close()

    def test_only_the_existing_single_m3_timestamp_change_is_proven(self):
        before, original = update.rows_snapshot_with_auth(self.state)
        self.advance()
        after, current = update.rows_snapshot_with_auth(self.state)
        witness = self.prove(before, original, after, current)
        self.assertEqual(witness['changedRows'], 1)
        self.assertEqual(witness['serviceIdentity'], 'm3')
        self.assertEqual(heartbeat.verify_restart_witness(before, after, witness, current, identity='m3'), witness)
        self.assertNotIn('synthetic-private', json.dumps(witness))

    def test_other_auth_cells_still_fail_inverse_proof(self):
        variants = {'credential': b'changed', 'scopes': '["write"]', 'method': 'browser-session-cookie',
                    'client_surface': 'native', 'issued_at': '2026-10-02T00:00:00.000Z',
                    'expires_at': '2026-11-02T00:00:00.000Z', 'revoked_at': NEW, 'session_id': 'different'}
        for column, value in variants.items():
            with self.subTest(column=column):
                self.writer.execute('DELETE FROM auth_sessions')
                self.writer.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?)', self.row)
                self.writer.commit()
                before, original = update.rows_snapshot_with_auth(self.state)
                self.writer.execute('UPDATE auth_sessions SET last_connected_at=?, ' + column + '=?', (NEW, value))
                self.writer.commit()
                after, current = update.rows_snapshot_with_auth(self.state)
                with self.assertRaises(AssertionError):
                    self.prove(before, original, after, current)

    def test_other_protected_history_change_is_not_exempted(self):
        before, original = update.rows_snapshot_with_auth(self.state)
        self.writer.execute("UPDATE scheduled_tasks SET content='changed'")
        self.advance()
        after, current = update.rows_snapshot_with_auth(self.state)
        with self.assertRaisesRegex(AssertionError, 'Other protected table changed'):
            self.prove(before, original, after, current)

    def test_active_work_rejects_paired_capture(self):
        self.writer.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('running')")
        self.writer.commit()
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            update.rows_snapshot_with_auth(self.state)

    def test_m3_two_existing_session_reconnects_remain_rejected(self):
        self.writer.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?)', ('second', *self.row[1:]))
        self.writer.commit()
        before, original = update.rows_snapshot_with_auth(self.state)
        self.advance()
        after, current = update.rows_snapshot_with_auth(self.state)
        with self.assertRaisesRegex(AssertionError, 'supported existing-session count'):
            self.prove(before, original, after, current)


if __name__ == '__main__':
    unittest.main()
