#!/usr/bin/env python3
"""Execute real transition against temporary records and read-only fake transports."""
import contextlib
import copy
import datetime
import importlib.util
import io
import json
import os
import pathlib
import pwd
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import auth_heartbeat
import database_continuity as continuity

# Fixture inventory (documentation addresses only); never the operator's real fleet file.
FLEET = tempfile.TemporaryDirectory(prefix='studio-fleet-hosts-')
FLEET_HOSTS = pathlib.Path(FLEET.name) / 'hosts.json'
FLEET_HOSTS.write_text(json.dumps({'m1': {'host': '192.0.2.11', 'user': 'worker-one', 'home': '/Users/worker-one'},
    'm3': {'host': '192.0.2.13', 'user': 'worker-three', 'home': '/Users/worker-three'}}))
os.environ['STUDIO_FLEET_HOSTS'] = str(FLEET_HOSTS)
spec = importlib.util.spec_from_file_location('network_transition', pathlib.Path(__file__).with_name('network-transition.py'))
transition = importlib.util.module_from_spec(spec); spec.loader.exec_module(transition)
REAL_RUN = subprocess.run  # transition.subprocess is this module; fakes patch it.

class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-network-transition-')
        self.home = pathlib.Path(self.temp.name).resolve()
        self.network = self.home / '.specweave-studio/m4/network'; self.network.mkdir(parents=True)
        (self.home / 'Library/LaunchAgents').mkdir(parents=True)
        self.old = 'a' * 64; self.new = 'b' * 64; self.dns = 'fixture.tail-test.ts.net'
        self.serve = {}; self.pid_changed = False; self.commands = []
        self.serve_changed_on_final_read = False; self.metadata_changed_during_read = False
        self.metadata = self.network / 'private-access.json'
        self.progress = {'schemaVersion': 1, 'initialServe': {}, 'selfDNSName': self.dns, 'archiveSha256': self.old,
            'serveReadback': {}, 'safeToResume': True, 'complete': False, 'phase': 'serve', 'failureType': 'TimeoutExpired', 'tunnels': {}}
        user = pwd.getpwuid(os.getuid()).pw_name
        for i, (identity, remote_user, ip, port) in enumerate(transition.PLANS):
            label = 'com.specweave.studio.tunnel-' + identity
            plist = self.home / 'Library/LaunchAgents' / (label + '.plist')
            value = transition.tunnel_bytes(self.home, identity, remote_user, ip, port, user); plist.write_bytes(value)
            self.progress['tunnels'][label] = {'phase': 'ready', 'plistPath': str(plist), 'pid': 1001 + i, 'expectedPlistSha256': transition.digest(value)}
        self.path = self.network / 'progress.json'; self.path.write_text(json.dumps(self.progress))
        self.original = self.path.read_bytes(); self.expected = transition.digest(self.original)
        self.proof = {'schemaVersion': 1, 'hosts': {}}
        for identity in ['m4', 'm1', 'm3']:
            after = {'identity': identity, 'uid': 501, 'serviceLabel': 'com.specweave.studio.' + identity, 'servicePid': 77,
                'archiveSha256': self.new, 'artifactSourceCommit': 'c' * 40, 'fileHashes': {}, 'rows': {'nativeWorkIdle': True},
                'processQuiescence': {'root': {'pid': 77, 'uid': 501}, 'treeSha256': 'fixture-stable-tree'},
                'otherListeners': {}, 'cookieName': identity, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            before = copy.deepcopy(after); before['archiveSha256'] = self.old
            self.proof['hosts'][identity] = {'update': {'phase': 'verified', 'before': before, 'after': after,
                'preservedRowsAuthAndIdentity': True, 'originalServicesPreserved': True, 'onlyKnownOwnedServiceRestarted': True}, 'finalSnapshot': copy.deepcopy(after)}
        self.proof_path = self.home / 'proof.json'; self.output = self.home / 'receipt.json'
    def tearDown(self): self.temp.cleanup()
    def read_command(self, command):
        self.commands.append(command)
        if command == [transition.TAILSCALE, 'status', '--json']:
            return json.dumps({'BackendState': 'Running', 'Self': {'DNSName': self.dns}})
        if command == [transition.TAILSCALE, 'serve', 'status', '--json']:
            if self.metadata_changed_during_read and self.metadata.exists(): self.metadata.write_text('{}')
            if self.serve_changed_on_final_read and self.commands.count(command) > 1: return '{}'
            return json.dumps(self.serve)
        if command[:2] == ['/bin/launchctl', 'print']:
            record = self.progress['tunnels'][command[-1].rsplit('/', 1)[1]]
            return 'state = running\npath = ' + record['plistPath'] + '\npid = ' + str(record['pid'] + int(self.pid_changed)) + '\n'
        if command[0] == '/bin/ps':
            index = int(command[2]) - 1001; identity, user, ip, port = transition.PLANS[index]
            return '/usr/bin/ssh -L 127.0.0.1:' + str(port) + ':127.0.0.1:8319 ' + user + '@' + ip
        self.fail('Unexpected non-read operation')
    def execute(self, allow_existing_browser_heartbeat=False):
        self.proof_path.write_text(json.dumps(self.proof))
        with patch.object(pathlib.Path, 'home', return_value=self.home), patch.object(transition, 'snapshot', return_value=self.proof['hosts']['m4']['finalSnapshot']), \
             patch.object(transition, 'read_command', side_effect=self.read_command), patch.object(transition, 'listeners', side_effect=lambda port: [1001 if port == 18319 else 1002]), \
             contextlib.redirect_stdout(io.StringIO()):
            transition.transition(self.home, self.proof_path, self.expected, self.old, self.new, self.output,
                                  allow_existing_browser_heartbeat=allow_existing_browser_heartbeat)
    def assert_rejected_unchanged(self, allow_existing_browser_heartbeat=False):
        with self.assertRaises(AssertionError): self.execute(allow_existing_browser_heartbeat)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertFalse(self.output.exists())
        self.assertFalse(any('kickstart' in command or '--bg' in command or 'reset' in command for command in self.commands))
    def test_owned_transition_preserves_original_record_and_transport_state(self):
        self.execute(); value = json.loads(self.path.read_text()); receipt = json.loads(self.output.read_text())
        self.assertEqual(value['archiveSha256'], self.new); self.assertEqual(pathlib.Path(receipt['backup']).read_bytes(), self.original)
        for key, old in self.progress.items():
            if key != 'archiveSha256': self.assertEqual(value[key], old)
        self.assertFalse(receipt['mappingWrites']); self.assertTrue(receipt['privateGateStillDisabled'])
        self.assertEqual(receipt['previousProgressSha256'], self.expected)
    def test_foreign_or_changed_progress_is_rejected(self):
        self.path.write_text('{}'); self.original = self.path.read_bytes(); self.assert_rejected_unchanged()
    def test_stale_host_proof_is_rejected(self):
        self.proof['hosts']['m1']['finalSnapshot']['observedAt'] = '2020-01-01T00:00:00Z'; self.assert_rejected_unchanged()
    def test_host_auth_or_state_change_is_rejected(self):
        self.proof['hosts']['m3']['finalSnapshot']['rows']['auth'] = 'changed'; self.assert_rejected_unchanged()
    def test_changed_dns_is_rejected(self):
        self.dns = 'foreign.tail-test.ts.net'; self.assert_rejected_unchanged()
    def test_changed_serve_is_rejected(self):
        self.serve = {'TCP': {'443': {'TCPForward': 'foreign:443'}}}; self.assert_rejected_unchanged()
    def test_changed_tunnel_plist_is_rejected(self):
        pathlib.Path(self.progress['tunnels']['com.specweave.studio.tunnel-m1']['plistPath']).write_bytes(b'foreign'); self.assert_rejected_unchanged()
    def test_changed_tunnel_pid_is_rejected(self):
        self.pid_changed = True; self.assert_rejected_unchanged()
    def test_mixed_artifact_fleet_is_rejected(self):
        self.proof['hosts']['m1']['finalSnapshot']['archiveSha256'] = self.old; self.assert_rejected_unchanged()
    def heartbeat(self):
        directory = self.home / '.specweave-studio/m4/userdata'; directory.mkdir(parents=True)
        self.before_timestamp = '2026-10-08T07:18:54.222Z'
        self.after_timestamp = '2026-10-08T08:38:00.749Z'
        db = sqlite3.connect(str(directory / 'statev2.sqlite'))
        db.execute('CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, scopes TEXT, last_connected_at TEXT, revoked_at TEXT)')
        db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?)', [
            ('browser-fixture', '["read","write"]', self.before_timestamp, None),
            ('revoked-fixture', '["read"]', self.before_timestamp, '2026-10-08T07:20:00.000Z')])
        def auth_hash():
            return transition.digest(('\n'.join(sorted(json.dumps(list(row), separators=(',', ':')) for row in db.execute('SELECT * FROM auth_sessions')))).encode())
        before_hash = auth_hash()
        db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', (self.after_timestamp, 'browser-fixture'))
        db.commit(); after_hash = auth_hash(); db.close()
        host = self.proof['hosts']['m4']
        for value in [host['update']['before'], host['update']['after'], host['finalSnapshot']]:
            value['rows'].update({'counts': {'auth_sessions': 2}, 'hashes': {'auth_sessions': before_hash}})
        host['finalSnapshot']['rows']['hashes']['auth_sessions'] = after_hash
        self.proof['authHeartbeatWitnesses'] = {'m4': {
            'beforeLastConnectedAt': self.before_timestamp, 'afterLastConnectedAt': self.after_timestamp}}
        return directory / 'statev2.sqlite'
    def test_complete_auth_rows_reconstruct_only_one_existing_browser_heartbeat(self):
        self.completed(); self.heartbeat(); self.execute()
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt['verifiedAuthHeartbeats']['m4']['changedColumn'], 'last_connected_at')
        self.assertEqual(receipt['verifiedAuthHeartbeats']['m4']['changedRows'], 1)
        self.assertTrue(receipt['verifiedAuthHeartbeats']['m4']['originalCompleteRowsReconstructed'])
    def complete_capture_heartbeat(self):
        path = self.heartbeat()
        reverted = self.home / 'reverted'; reverted.mkdir()
        source = sqlite3.connect(str(path)); copy_db = sqlite3.connect(str(reverted / 'statev2.sqlite'))
        source.backup(copy_db); source.close()
        copy_db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', (self.before_timestamp, 'browser-fixture'))
        copy_db.commit(); copy_db.close()
        host = self.proof['hosts']['m4']
        for value in [host['update']['before'], host['update']['after']]:
            value['databaseCapture'] = continuity.read_database(reverted)
        host['finalSnapshot']['databaseCapture'] = continuity.read_database(path.parent)
        host['update'].update(rowsByteIdentical=True, rowPreservation='byte-identical')
        return path
    def test_heartbeat_reverses_only_auth_in_the_complete_database_capture(self):
        self.completed(); self.complete_capture_heartbeat(); self.execute()
        receipt = json.loads(self.output.read_text())
        self.assertTrue(receipt['verifiedAuthHeartbeats']['m4']['originalCompleteRowsReconstructed'])
        final = self.proof['hosts']['m4']['finalSnapshot']['databaseCapture']['summary']
        self.assertEqual(receipt['verifiedDatabasePreservation'], {'m4': {
            'authHeartbeatWitness': None, 'finalDatabaseSha256': continuity.digest(continuity.encoded(final))}})
    def test_m4_complete_capture_is_recomputed_against_the_live_database(self):
        path = self.complete_capture_heartbeat()
        # The saved after and final captures agree with each other; only the live read differs.
        db = sqlite3.connect(str(path)); db.execute('CREATE TABLE late_unrelated(value TEXT)'); db.commit(); db.close()
        self.assert_rejected_unchanged()
    def test_a_partial_complete_capture_is_rejected(self):
        self.complete_capture_heartbeat()
        del self.proof['hosts']['m4']['update']['before']['databaseCapture']
        self.assert_rejected_unchanged()
    def remote_worker(self, identity='m1'):
        """A worker's state in a separate home; the streamed verifier runs there for real."""
        home = (self.home / ('remote-' + identity)).resolve(); state = home / '.specweave-studio' / identity / 'userdata'
        state.mkdir(parents=True)
        db = sqlite3.connect(str(state / 'statev2.sqlite'))
        db.executescript("CREATE TABLE checkpoint_diff_blobs(id INTEGER PRIMARY KEY, body BLOB); INSERT INTO checkpoint_diff_blobs(body) VALUES (x'abcd');")
        db.commit(); db.close()
        (state.parent / 'installation.json').write_text(json.dumps({'identity': identity, 'stateDir': str(state),
            'sourceCommit': 'c' * 40, 'archiveSha256': self.new}))
        host = self.proof['hosts'][identity]
        for value in [host['update']['before'], host['update']['after'], host['finalSnapshot']]:
            value['rows'] = {'nativeWorkIdle': True, 'counts': {}, 'hashes': {}}
            value['databaseCapture'] = continuity.read_database(state, value['rows'])
        host['update'].update(rowsByteIdentical=True, rowPreservation='byte-identical')
        self.remote_calls = []
        def run(command, **kwargs):
            remote_user, ip = next((user, address) for name, user, address, _port in transition.PLANS if name == identity)
            self.assertEqual(command[0], '/usr/bin/ssh'); self.assertEqual(command[-2:], [remote_user + '@' + ip, '/usr/bin/python3 -B -'])
            self.assertIn('StrictHostKeyChecking=yes', command); self.assertIn('BatchMode=yes', command)
            self.remote_calls.append(command)
            return REAL_RUN(['/usr/bin/python3', '-B', '-'], input=kwargs['input'], capture_output=True, text=True,
                                  timeout=45, env={'HOME': str(home), 'PATH': '/usr/bin:/bin'})
        return state, run
    def execute_remote(self, run, allow_existing_browser_heartbeat=False):
        with patch.object(transition.subprocess, 'run', side_effect=run):
            self.execute(allow_existing_browser_heartbeat)
    def test_worker_complete_capture_is_recomputed_on_its_own_host(self):
        self.completed(); state, run = self.remote_worker('m1'); self.execute_remote(run)
        receipt = json.loads(self.output.read_text())
        final = self.proof['hosts']['m1']['finalSnapshot']['databaseCapture']['summary']
        self.assertEqual(receipt['verifiedDatabasePreservation'], {'m1': {
            'authHeartbeatWitness': None, 'finalDatabaseSha256': continuity.digest(continuity.encoded(final))}})
        self.assertEqual(len(self.remote_calls), 1)
    def test_worker_live_drift_fails_on_its_own_host(self):
        state, run = self.remote_worker('m3')
        db = sqlite3.connect(str(state / 'statev2.sqlite')); db.execute("UPDATE checkpoint_diff_blobs SET body=x'beef'"); db.commit(); db.close()
        with patch.object(transition.subprocess, 'run', side_effect=run), \
                self.assertRaisesRegex(AssertionError, 'owning-host preservation verifier failed'):
            self.execute()
        self.assertEqual(len(self.remote_calls), 1); self.assertFalse(self.output.exists())
    def test_worker_result_must_match_the_requested_proof(self):
        state, run = self.remote_worker('m1')
        def forged(command, **kwargs):
            result = run(command, **kwargs); value = json.loads(result.stdout)
            value['verified']['finalDatabaseSha256'] = '0' * 64
            return subprocess.CompletedProcess(command, 0, json.dumps(value), '')
        with patch.object(transition.subprocess, 'run', side_effect=forged): self.assert_rejected_unchanged()
        def failed(command, **kwargs): return subprocess.CompletedProcess(command, 1, '', 'private detail')
        with patch.object(transition.subprocess, 'run', side_effect=failed): self.assert_rejected_unchanged()
    def test_heartbeat_cannot_hide_other_complete_database_changes(self):
        path = self.complete_capture_heartbeat()
        db = sqlite3.connect(str(path)); db.execute('CREATE TABLE unrelated(value TEXT)'); db.commit(); db.close()
        self.proof['hosts']['m4']['finalSnapshot']['databaseCapture'] = continuity.read_database(path.parent)
        self.assert_rejected_unchanged()
    def test_heartbeat_complete_capture_must_bind_live_auth_cells(self):
        self.complete_capture_heartbeat()
        tables = self.proof['hosts']['m4']['finalSnapshot']['databaseCapture']['summary']['tables']
        tables['auth_sessions']['sha256'] = '0' * 64
        self.assert_rejected_unchanged()
    def test_heartbeat_security_field_change_cannot_reconstruct_original_auth_hash(self):
        path = self.heartbeat(); db = sqlite3.connect(str(path))
        db.execute('UPDATE auth_sessions SET scopes=? WHERE session_id=?', ('["admin"]', 'browser-fixture')); db.commit()
        rows = sorted(json.dumps(list(row), separators=(',', ':')) for row in db.execute('SELECT * FROM auth_sessions')); db.close()
        self.proof['hosts']['m4']['finalSnapshot']['rows']['hashes']['auth_sessions'] = transition.digest(('\n'.join(rows)).encode())
        self.assert_rejected_unchanged()
    def test_heartbeat_missing_witness_remains_strict(self):
        self.heartbeat(); del self.proof['authHeartbeatWitnesses']; self.assert_rejected_unchanged()
    def test_heartbeat_wrong_timestamp_and_nonadvancement_rejected(self):
        for value in ['2026-10-08T07:18:54.221Z', self.before_timestamp if hasattr(self, 'before_timestamp') else '2026-10-08T08:38:00.749Z']:
            if not hasattr(self, 'before_timestamp'): self.heartbeat()
            self.proof['authHeartbeatWitnesses']['m4']['beforeLastConnectedAt'] = value
            self.assert_rejected_unchanged()
    def test_heartbeat_cannot_exempt_unrelated_thread_state_or_service_pid(self):
        self.heartbeat(); self.proof['hosts']['m4']['finalSnapshot']['rows']['nativeThreads'] = 'changed'; self.assert_rejected_unchanged()
        del self.proof['hosts']['m4']['finalSnapshot']['rows']['nativeThreads']
        self.proof['hosts']['m4']['finalSnapshot']['servicePid'] += 1; self.assert_rejected_unchanged()
    def test_heartbeat_witness_is_m4_only_and_exact_shape(self):
        self.heartbeat(); self.proof['authHeartbeatWitnesses']['m1'] = self.proof['authHeartbeatWitnesses']['m4']; self.assert_rejected_unchanged()
        del self.proof['authHeartbeatWitnesses']['m1']; self.proof['authHeartbeatWitnesses']['m4']['sessionId'] = 'foreign'; self.assert_rejected_unchanged()
    def restart_heartbeat(self, later=False, second=False):
        state = self.home / '.specweave-studio/m4/userdata'; state.mkdir(parents=True)
        path = state / 'statev2.sqlite'; db = sqlite3.connect(path)
        db.execute('CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,method TEXT,client_surface TEXT,issued_at TEXT,expires_at TEXT,last_connected_at TEXT,revoked_at TEXT,credential BLOB)')
        now = datetime.datetime.now(datetime.timezone.utc)
        old = (now - datetime.timedelta(hours=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        connected = (now - datetime.timedelta(seconds=9)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        started = (now - datetime.timedelta(seconds=10)).isoformat()
        observed = (now - datetime.timedelta(seconds=8)).isoformat()
        db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)', ('private-browser', 'browser-session-cookie', 'web',
                   (now - datetime.timedelta(days=1)).isoformat(), (now + datetime.timedelta(days=1)).isoformat(), old, None, b'private-credential'))
        if second:
            db.execute("INSERT INTO auth_sessions SELECT 'private-second-browser',method,client_surface,issued_at,expires_at,last_connected_at,revoked_at,credential FROM auth_sessions LIMIT 1")
        db.commit()
        def proof():
            return {'nativeWorkIdle': True, 'projectIds': ['original-project'], 'threadIds': ['original-thread'],
                    'counts': {'auth_sessions': 2 if second else 1, 'history': 2},
                    'hashes': {'auth_sessions': auth_heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')]), 'history': 'd' * 64}}
        before = proof(); original = auth_heartbeat.read_auth_sessions(state, before)
        db.execute('UPDATE auth_sessions SET last_connected_at=?', (connected,)); db.commit()
        after = proof(); current = auth_heartbeat.read_auth_sessions(state, after)
        host = self.proof['hosts']['m4']; update = host['update']
        update['before']['rows'] = before; update['after']['rows'] = after
        update['after']['observedAt'] = observed
        update.update({'rowsByteIdentical': False, 'rowPreservation': 'verified-existing-browser-heartbeat', 'restartStartedAt': started,
                       'authHeartbeatWitness': auth_heartbeat.prove_restart_heartbeat(before, after, original, current, started, observed)})
        if later:
            latest = (now - datetime.timedelta(seconds=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            db.execute("UPDATE auth_sessions SET last_connected_at=? WHERE session_id='private-browser'", (latest,)); db.commit()
            self.proof['authHeartbeatWitnesses'] = {'m4': {'beforeLastConnectedAt': connected, 'afterLastConnectedAt': latest}}
        host['finalSnapshot']['rows'] = proof(); db.close()
        return path
    def test_restart_heartbeat_requires_separate_explicit_opt_in(self):
        self.restart_heartbeat(); self.assert_rejected_unchanged()
    def test_restart_heartbeat_is_reconstructed_from_actual_live_rows(self):
        self.completed(); self.restart_heartbeat(); self.execute(True)
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt['verifiedRestartAuthHeartbeats']['m4'], self.proof['hosts']['m4']['update']['authHeartbeatWitness'])
        self.assertEqual(receipt['verifiedAuthHeartbeats'], {})
        self.assertNotIn('private-browser', self.output.read_text()); self.assertNotIn('private-credential', self.output.read_text())
        self.assertNotEqual(self.proof['hosts']['m4']['update']['before']['rows'], self.proof['hosts']['m4']['update']['after']['rows'])
    def test_restart_and_separate_later_heartbeat_each_reconstruct_exact_complete_hashes(self):
        self.completed(); self.restart_heartbeat(later=True); self.execute(True)
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt['verifiedRestartAuthHeartbeats']['m4']['changedRows'], 1)
        self.assertEqual(receipt['verifiedAuthHeartbeats']['m4']['changedRows'], 1)
        self.assertEqual(receipt['verifiedAuthHeartbeats']['m4']['beforeAuthSessionsSha256'],
                         receipt['verifiedRestartAuthHeartbeats']['m4']['afterAuthSessionsSha256'])
    def test_two_cookie_restart_witness_is_consumed_from_exact_live_rows(self):
        self.completed(); self.restart_heartbeat(second=True); self.execute(True)
        receipt = json.loads(self.output.read_text())
        witness = receipt['verifiedRestartAuthHeartbeats']['m4']
        self.assertEqual(witness['schemaVersion'], 2); self.assertEqual(witness['changedRows'], 2)
        self.assertEqual(witness, self.proof['hosts']['m4']['update']['authHeartbeatWitness'])
        self.assertNotIn('private-second-browser', self.output.read_text())
        self.assertNotIn('private-credential', self.output.read_text())
        self.assertEqual(pathlib.Path(receipt['backup']).read_bytes(), self.original)
        self.assertFalse(receipt['mappingWrites'])
    def test_two_cookie_restart_and_separate_single_later_heartbeat_both_reconstruct(self):
        self.completed(); self.restart_heartbeat(second=True, later=True); self.execute(True)
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt['verifiedRestartAuthHeartbeats']['m4']['changedRows'], 2)
        self.assertEqual(receipt['verifiedAuthHeartbeats']['m4']['changedRows'], 1)
        self.assertEqual(receipt['verifiedAuthHeartbeats']['m4']['beforeAuthSessionsSha256'],
                         receipt['verifiedRestartAuthHeartbeats']['m4']['afterAuthSessionsSha256'])
    def test_two_cookie_restart_remains_explicit_opt_in(self):
        self.restart_heartbeat(second=True); self.assert_rejected_unchanged()
    def test_two_cookie_consumer_rejects_duplicate_cells_count_types_and_wrong_host(self):
        self.restart_heartbeat(second=True)
        update = self.proof['hosts']['m4']['update']; original = copy.deepcopy(update['authHeartbeatWitness'])
        for field, value in [('changedRows', 1), ('changedRows', 2.0), ('schemaVersion', 2.0),
                             ('serviceIdentity', 'm1'), ('timestampChanges', [original['timestampChanges'][0]] * 2)]:
            with self.subTest(field=field):
                update['authHeartbeatWitness'] = {**original, field: value}
                self.assert_rejected_unchanged(True)
    def test_two_cookie_consumer_preserves_quiescence_guard(self):
        self.restart_heartbeat(second=True)
        self.proof['hosts']['m4']['finalSnapshot']['processQuiescence']['treeSha256'] = 'changed'
        self.assert_rejected_unchanged(True)
    def test_restart_witness_missing_or_downgraded_report_does_not_bypass_equality(self):
        self.restart_heartbeat(); update = self.proof['hosts']['m4']['update']; saved = update.pop('authHeartbeatWitness')
        self.assert_rejected_unchanged(True); update['authHeartbeatWitness'] = saved; update['rowsByteIdentical'] = True
        self.assert_rejected_unchanged(True)
    def test_restart_witness_false_hash_or_extra_field_is_rejected(self):
        self.restart_heartbeat(); witness = self.proof['hosts']['m4']['update']['authHeartbeatWitness']
        original = copy.deepcopy(witness)
        for key, value in [('afterAuthSessionsSha256', 'f' * 64), ('authSchemaSha256', 'f' * 64),
                           ('beforeLastConnectedAt', '2026-02-30T00:00:00.000Z'), ('changedRows', 2), ('extra', True)]:
            with self.subTest(key=key):
                witness.clear(); witness.update(original); witness[key] = value
                self.assert_rejected_unchanged(True)
    def test_restart_window_must_match_recorded_update_and_after_snapshot(self):
        self.restart_heartbeat(); update = self.proof['hosts']['m4']['update']; original = update['restartStartedAt']
        update['restartStartedAt'] = update['after']['observedAt']; self.assert_rejected_unchanged(True)
        update['restartStartedAt'] = original; update['after']['observedAt'] = original; self.assert_rejected_unchanged(True)
    def test_restart_schema_drift_is_detected_even_when_raw_row_hash_is_unchanged(self):
        path = self.restart_heartbeat(); db = sqlite3.connect(path)
        db.execute('CREATE INDEX changed_schema ON auth_sessions(method)'); db.commit(); db.close()
        self.assert_rejected_unchanged(True)
    def test_restart_live_hash_race_cannot_be_hidden_by_witness(self):
        path = self.restart_heartbeat(); db = sqlite3.connect(path)
        db.execute("UPDATE auth_sessions SET credential='changed'"); db.commit(); db.close()
        self.assert_rejected_unchanged(True)
    def test_restart_cannot_exempt_unrelated_history_count_or_host_identity(self):
        self.restart_heartbeat(); update = self.proof['hosts']['m4']['update']; original = copy.deepcopy(update['before']['rows'])
        for key in ['hashes', 'counts']:
            update['before']['rows'][key]['history'] = 'changed'; self.assert_rejected_unchanged(True)
            update['before']['rows'] = copy.deepcopy(original)
        update['before']['identity'] = 'm1'; self.assert_rejected_unchanged(True)
    def completed(self):
        self.serve = {'TCP': {str(port): {'HTTPS': True} for port in transition.MAPPINGS},
            'Web': {self.dns + ':' + str(port): {'Handlers': {'/': {'Proxy': target}}} for port, target in transition.MAPPINGS.items()}}
        self.progress['complete'] = True; self.progress['serveReadback'] = copy.deepcopy(self.serve)
        self.metadata.write_text(json.dumps({'configuredPrivateOnly': True, 'selfDNSName': self.dns,
            'origins': {'m4': 'https://' + self.dns, 'm1': 'https://' + self.dns + ':8443', 'm3': 'https://' + self.dns + ':8444'},
            'serveReadback': self.serve, 'tunnels': [{'identity': identity, 'localPort': port, 'remoteHost': ip,
                'remotePort': 8319, 'label': 'com.specweave.studio.tunnel-' + identity} for identity, _user, ip, port in transition.PLANS]}))
        self.save_progress()
    def save_progress(self):
        self.path.write_text(json.dumps(self.progress)); self.original = self.path.read_bytes(); self.expected = transition.digest(self.original)
    def test_completed_private_transition_preserves_all_three_maps_and_transport_metadata(self):
        self.completed(); metadata = self.metadata.read_bytes(); self.execute()
        value = json.loads(self.path.read_text()); receipt = json.loads(self.output.read_text())
        self.assertTrue(value['complete']); self.assertEqual(value['serveReadback'], self.serve)
        self.assertEqual(self.metadata.read_bytes(), metadata); self.assertEqual(receipt['transportMetadataSha256'], transition.digest(metadata))
        self.assertTrue(receipt['privateAccessComplete']); self.assertFalse(receipt['privateGateStillDisabled'])
        self.assertFalse(receipt['mappingWrites']); self.assertEqual(pathlib.Path(receipt['backup']).read_bytes(), self.original)
        for key, old in self.progress.items():
            if key != 'archiveSha256': self.assertEqual(value[key], old)
        self.assertTrue(all(command[0] in [transition.TAILSCALE, '/bin/launchctl', '/bin/ps'] for command in self.commands))
    def test_completed_partial_mapping_is_rejected_even_when_progress_matches(self):
        self.completed(); del self.progress['serveReadback']['Web'][self.dns + ':8444']; self.save_progress(); self.assert_rejected_unchanged()
    def test_completed_public_funnel_is_rejected_even_when_progress_matches(self):
        self.completed(); self.progress['serveReadback']['AllowFunnel'] = {self.dns + ':443': True}; self.save_progress(); self.assert_rejected_unchanged()
    def test_completed_foreign_proxy_is_rejected_even_when_progress_matches(self):
        self.completed(); self.progress['serveReadback']['Web'][self.dns + ':443']['Handlers']['/']['Proxy'] = 'http://foreign:8319'; self.save_progress(); self.assert_rejected_unchanged()
    def test_completed_extra_port_is_rejected(self):
        self.completed(); self.progress['serveReadback']['TCP']['9999'] = {'HTTPS': True}; self.save_progress(); self.assert_rejected_unchanged()
    def test_incomplete_record_cannot_adopt_completed_mappings(self):
        self.completed(); self.progress['complete'] = False; self.save_progress(); self.assert_rejected_unchanged()
    def test_completed_transport_metadata_origin_change_is_rejected(self):
        self.completed(); value = json.loads(self.metadata.read_text()); value['origins']['m1'] = 'https://foreign.example.test'; self.metadata.write_text(json.dumps(value)); self.assert_rejected_unchanged()
    def test_completed_transport_metadata_race_is_rejected(self):
        self.completed(); self.metadata_changed_during_read = True; self.assert_rejected_unchanged()
    def test_completed_serve_race_is_rejected(self):
        self.completed(); self.serve_changed_on_final_read = True; self.assert_rejected_unchanged()

if __name__ == '__main__': unittest.main()
