#!/usr/bin/env python3
"""Adversarial complete-row proofs using private synthetic SQLite databases only."""
import ast
import copy
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import auth_heartbeat as heartbeat

SCHEMA = '''CREATE TABLE auth_sessions (
 session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL,
 method TEXT NOT NULL, client_label TEXT, client_surface TEXT, client_app_version TEXT,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_connected_at TEXT,
 revoked_at TEXT, token_digest BLOB)'''
OLD = '2026-10-08T09:00:00.000Z'
NEW = '2026-10-08T10:00:01.234Z'
START = '2026-10-08T10:00:00+00:00'
END = '2026-10-08T10:00:02+00:00'


class HeartbeatProofs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-heartbeat-proof-')
        self.state = pathlib.Path(self.temp.name)
        self.path = self.state / 'statev2.sqlite'
        self.db = sqlite3.connect(self.path)
        self.db.execute(SCHEMA)
        self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
            ('private-session-one', 'private-subject', '["read","write"]', 'browser-session-cookie',
             'private-label', 'web', '0.1', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', OLD, None, b'private-token'),
            ('private-session-two', 'private-subject', '["read"]', 'browser-session-cookie',
             'private-other', 'web', '0.1', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', OLD, '2026-10-07T00:00:00.000Z', b'other-token'),
        ])
        self.db.commit()
        self.baseline()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def proof(self):
        rows = [list(row) for row in self.db.execute('SELECT * FROM auth_sessions')]
        return {'nativeWorkIdle': True, 'projectIds': ['project'], 'threadIds': ['thread'],
                'counts': {'auth_sessions': len(rows), 'protected_history': 1},
                'hashes': {'auth_sessions': heartbeat.rows_hash(rows), 'protected_history': 'a' * 64}}

    def baseline(self):
        self.before = self.proof()
        self.original = heartbeat.read_auth_sessions(self.state, self.before)

    def change(self, value=NEW):
        self.db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', (value, 'private-session-one'))
        self.db.commit()
        self.after = self.proof()
        self.current = heartbeat.read_auth_sessions(self.state, self.after)

    def prove(self, start=START, end=END):
        return heartbeat.prove_restart_heartbeat(self.before, self.after, self.original, self.current, start, end)

    def test_exact_single_existing_browser_reconnect_reconstructs_hash_without_persisting_rows(self):
        self.change()
        raw = self.path.read_bytes()
        witness = self.prove()
        self.assertNotEqual(self.before['hashes']['auth_sessions'], self.after['hashes']['auth_sessions'])
        self.assertEqual(witness['changedRows'], 1)
        self.assertEqual(witness['beforeAuthSessionsSha256'], self.before['hashes']['auth_sessions'])
        self.assertEqual(witness['afterAuthSessionsSha256'], self.after['hashes']['auth_sessions'])
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)
        text = json.dumps(witness)
        for secret in ['private-session', 'private-subject', 'private-label', 'private-token', 'token_digest']:
            self.assertNotIn(secret, text)
        self.assertEqual(self.path.read_bytes(), raw)

    def test_identical_rows_need_no_exception(self):
        self.change(OLD)
        self.assertIsNone(self.prove())

    def test_invalid_null_equal_backward_and_outside_window_timestamps_fail(self):
        for value in [None, OLD, '2026-10-08T08:59:59.999Z', '2026-02-30T10:00:01.234Z',
                      '2026-10-08T10:00:01', '2026-10-08T10:00:01.234+01:00',
                      '2026-10-08T09:59:59.999Z', '2026-10-08T10:00:02.001Z']:
            with self.subTest(value=value):
                self.change(value)
                if value == OLD:
                    self.assertIsNone(self.prove())
                    with self.assertRaises(AssertionError):
                        heartbeat.restore_timestamp(self.current, OLD, OLD, self.before)
                else:
                    with self.assertRaises(AssertionError): self.prove()

    def test_null_old_timestamp_and_expired_revoked_or_nonbrowser_baselines_fail(self):
        for field, value in [('last_connected_at', None), ('revoked_at', OLD), ('method', 'bearer-access-token'),
                             ('client_surface', 'desktop'), ('client_surface', None),
                             ('expires_at', '2026-10-08T09:59:59.000Z'), ('issued_at', NEW)]:
            with self.subTest(field=field, value=value):
                original_rows = copy.deepcopy(self.original['rows'])
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', (value, 'private-session-one'))
                self.db.commit(); self.baseline(); self.change()
                with self.assertRaises(AssertionError): self.prove()
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.commit(); self.baseline()

    def test_invalid_or_unbounded_restart_windows_fail(self):
        self.change()
        for start, end in [(END, START), ('2026-02-30T10:00:00Z', END),
                           ('2026-10-08T10:00:00', END), (START, '2026-10-08T10:02:00.001Z')]:
            with self.subTest(start=start, end=end), self.assertRaises(AssertionError): self.prove(start, end)

    def test_every_other_cell_remains_exact(self):
        for field in ['session_id', 'subject', 'scopes', 'method', 'client_label', 'client_surface',
                      'client_app_version', 'issued_at', 'expires_at', 'revoked_at', 'token_digest']:
            with self.subTest(field=field):
                original_rows = copy.deepcopy(self.original['rows'])
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', ('changed', 'private-session-one'))
                self.db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE ' + field + '=?', (NEW, 'changed'))
                self.db.commit(); self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
                with self.assertRaises(AssertionError): self.prove()
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.commit()

    def test_two_timestamps_and_added_deleted_or_replaced_rows_fail(self):
        for mutation in ["UPDATE auth_sessions SET last_connected_at='2026-10-08T10:00:01.000Z' WHERE session_id='private-session-two'",
                         "DELETE FROM auth_sessions WHERE session_id='private-session-two'",
                         "UPDATE auth_sessions SET session_id='replacement' WHERE session_id='private-session-two'",
                         "INSERT INTO auth_sessions SELECT 'added',subject,scopes,method,client_label,client_surface,client_app_version,issued_at,expires_at,last_connected_at,revoked_at,token_digest FROM auth_sessions LIMIT 1"]:
            with self.subTest(mutation=mutation):
                self.change(); self.db.execute(mutation); self.db.commit()
                self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
                with self.assertRaises(AssertionError): self.prove()
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', self.original['rows'])
                self.db.commit()

    def test_complete_schema_type_primary_key_default_and_index_drift_fail(self):
        for schema in [SCHEMA.replace('subject TEXT', 'subject BLOB'), SCHEMA.replace('PRIMARY KEY', ''),
                       SCHEMA.replace('client_label TEXT', "client_label TEXT DEFAULT 'new'")]:
            with self.subTest(schema=schema):
                self.db.execute('DROP TABLE auth_sessions'); self.db.execute(schema)
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', self.original['rows'])
                self.db.commit(); self.change()
                with self.assertRaisesRegex(AssertionError, 'schema'): self.prove()
        self.db.execute('DROP TABLE auth_sessions'); self.db.execute(SCHEMA)
        self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', self.original['rows'])
        self.db.execute('CREATE INDEX auth_sessions_extra ON auth_sessions(subject)'); self.db.commit(); self.change()
        with self.assertRaisesRegex(AssertionError, 'schema'): self.prove()

    def test_before_after_binding_and_live_race_fail(self):
        wrong = copy.deepcopy(self.before); wrong['hashes']['auth_sessions'] = 'b' * 64
        with self.assertRaises(AssertionError): heartbeat.read_auth_sessions(self.state, wrong)
        self.change(); saved = copy.deepcopy(self.after)
        self.db.execute("UPDATE auth_sessions SET scopes='changed' WHERE session_id='private-session-one'"); self.db.commit()
        with self.assertRaises(AssertionError): heartbeat.read_auth_sessions(self.state, saved)
        self.after['hashes']['auth_sessions'] = 'c' * 64
        with self.assertRaises(AssertionError): self.prove()

    def test_other_tables_counts_ids_and_idle_status_are_not_exempt(self):
        self.change()
        for kind in ['hash', 'count', 'table', 'projectIds', 'threadIds', 'nativeWorkIdle']:
            with self.subTest(kind=kind):
                after = copy.deepcopy(self.after)
                if kind == 'hash': after['hashes']['protected_history'] = 'changed'
                elif kind == 'count': after['counts']['protected_history'] = 2
                elif kind == 'table': after['hashes']['new_table'] = 'new'
                else: after[kind] = False if kind == 'nativeWorkIdle' else ['changed']
                with self.assertRaises(AssertionError):
                    heartbeat.prove_restart_heartbeat(self.before, after, self.original, self.current, START, END)

    def test_witness_is_recomputed_and_cannot_claim_a_false_hash_or_shape(self):
        self.change(); witness = self.prove()
        for field, value in [('changedRows', 2), ('changedColumn', 'scopes'), ('schemaVersion', 2),
                             ('authSchemaSha256', 'f' * 64), ('beforeAuthSessionsSha256', 'f' * 64),
                             ('afterAuthSessionsSha256', 'f' * 64), ('originalCompleteRowsReconstructed', False),
                             ('beforeLastConnectedAt', '2026-10-08T09:00:00.001Z'), ('unexpected', 'extra')]:
            with self.subTest(field=field):
                forged = {**witness, field: value}
                with self.assertRaises(AssertionError): heartbeat.verify_restart_witness(self.before, self.after, forged, self.current)


    def relay_baseline(self, method='bearer-access-token', surface='web'):
        self.db.execute('UPDATE auth_sessions SET method=?,client_surface=?,last_connected_at=? WHERE session_id=?',
                        (method, surface, OLD, 'private-session-one'))
        self.db.commit(); self.baseline()

    def relay_prove(self, identity='m3'):
        return heartbeat.prove_restart_heartbeat(self.before, self.after, self.original, self.current,
                                                 START, END, identity=identity)

    def test_m3_existing_web_bearer_reconnect_reconstructs_every_original_cell(self):
        self.relay_baseline(); self.change(); raw = self.path.read_bytes()
        witness = self.relay_prove()
        self.assertEqual(witness['serviceIdentity'], 'm3')
        self.assertEqual(witness['sessionMethod'], 'bearer-access-token')
        self.assertEqual(witness['sessionSurface'], 'web')
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                         identity='m3'), witness)
        self.assertNotEqual(self.before['hashes']['auth_sessions'], self.after['hashes']['auth_sessions'])
        self.assertEqual(self.path.read_bytes(), raw)
        for secret in ['private-session', 'private-subject', 'private-label', 'private-token', 'token_digest']:
            self.assertNotIn(secret, json.dumps(witness))
        with self.assertRaises(AssertionError):
            heartbeat.verify_restart_witness(self.before, self.after, witness, self.current)

    def test_m3_relay_witness_host_method_and_surface_cannot_be_forged(self):
        self.relay_baseline(); self.change(); witness = self.relay_prove()
        for field, value in [('serviceIdentity', 'm4'), ('sessionMethod', 'browser-session-cookie'),
                             ('sessionSurface', 'cli'), ('serviceIdentity', None)]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, field: value},
                                                  self.current, identity='m3')

    def test_m4_cookie_witness_retains_legacy_shape_and_default_mode(self):
        self.change(); implicit = self.prove()
        explicit = heartbeat.prove_restart_heartbeat(self.before, self.after, self.original, self.current,
                                                      START, END, identity='m4')
        self.assertEqual(implicit, explicit)
        self.assertNotIn('serviceIdentity', implicit)
        self.assertNotIn('sessionMethod', implicit)
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, implicit, self.current), implicit)

    def test_cookie_mode_is_m4_only_and_relay_bearer_is_m3_only(self):
        self.change()
        with self.assertRaises(AssertionError): self.relay_prove()
        self.relay_baseline(); self.change()
        with self.assertRaises(AssertionError): self.relay_prove('m4')

    def test_unknown_and_other_host_never_receive_a_heartbeat_exception(self):
        self.relay_baseline(); self.change()
        for identity in ['stage', 'other', None, 'M3']:
            with self.subTest(identity=identity), self.assertRaises(AssertionError): self.relay_prove(identity)
        self.change(OLD)
        with self.assertRaises(AssertionError): self.relay_prove('other')

    def test_m3_cli_native_unknown_surface_or_method_is_refused(self):
        for method, surface in [('bearer-access-token', 'cli'), ('bearer-access-token', 'native'),
                                ('bearer-access-token', None), ('dpop-access-token', 'web'),
                                ('browser-session-cookie', 'web')]:
            with self.subTest(method=method, surface=surface):
                self.relay_baseline(method, surface); self.change()
                with self.assertRaises(AssertionError): self.relay_prove()

    def test_m3_revoked_expired_future_issued_or_missing_prior_heartbeat_is_refused(self):
        self.relay_baseline(); original_rows = copy.deepcopy(self.original['rows'])
        for field, value in [('revoked_at', OLD), ('expires_at', OLD), ('issued_at', NEW),
                             ('last_connected_at', None)]:
            with self.subTest(field=field):
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?',
                                (value, 'private-session-one'))
                self.db.commit(); self.baseline(); self.change()
                with self.assertRaises(AssertionError): self.relay_prove()

    def test_m3_relay_proof_refuses_each_other_original_auth_column(self):
        self.relay_baseline(); original_rows = copy.deepcopy(self.original['rows'])
        for field in self.original['columns']:
            if field == 'last_connected_at': continue
            with self.subTest(field=field):
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?',
                                ('changed', 'private-session-one'))
                self.db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE ' + field + '=?',
                                (NEW, 'changed'))
                self.db.commit(); self.after = self.proof()
                self.current = heartbeat.read_auth_sessions(self.state, self.after)
                with self.assertRaises(AssertionError): self.relay_prove()

    def test_m3_second_session_new_deleted_or_schema_rows_are_not_exempt(self):
        self.relay_baseline(); original_rows = copy.deepcopy(self.original['rows'])
        for mutation in ["UPDATE auth_sessions SET last_connected_at='2026-10-08T10:00:01.000Z' WHERE session_id='private-session-two'",
                         "DELETE FROM auth_sessions WHERE session_id='private-session-two'",
                         "UPDATE auth_sessions SET session_id='new-id' WHERE session_id='private-session-two'",
                         "INSERT INTO auth_sessions SELECT 'added',subject,scopes,method,client_label,client_surface,client_app_version,issued_at,expires_at,last_connected_at,revoked_at,token_digest FROM auth_sessions LIMIT 1"]:
            with self.subTest(mutation=mutation):
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.commit(); self.change(); self.db.execute(mutation); self.db.commit()
                self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
                with self.assertRaises(AssertionError): self.relay_prove()
        self.db.execute('DELETE FROM auth_sessions')
        self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
        self.db.execute('CREATE INDEX auth_extra ON auth_sessions(subject)'); self.db.commit(); self.change()
        with self.assertRaises(AssertionError): self.relay_prove()

    def test_actual_updater_optional_host_guard_refuses_unknown_before_snapshot(self):
        spec = importlib.util.spec_from_file_location('t13_updater', pathlib.Path(__file__).with_name('update.py'))
        updater = importlib.util.module_from_spec(spec); spec.loader.exec_module(updater)
        for identity in ['stage', 'other']:
            with self.subTest(identity=identity), patch.object(updater, 'snapshot') as snapshot:
                with self.assertRaises(AssertionError):
                    updater.apply(identity, {}, pathlib.Path('/never-read'), 'no-archive', pathlib.Path('/never-written'),
                                  allow_existing_browser_heartbeat=True)
                snapshot.assert_not_called()

    def actual_relay_update_fixture(self, identity='m3'):
        # Adapt only the existing private fixture's host/method constants. The actual
        # updater and auth proof modules execute unchanged against a real temp DB.
        path = pathlib.Path(__file__).with_name('test-update.py')
        spec = importlib.util.spec_from_file_location('t13_updater_fixture', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        tree = ast.parse(path.read_text())
        fixture = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ApplyRecovery')
        class RelayFixtureConstants(ast.NodeTransformer):
            def visit_Constant(self, node):
                if isinstance(node.value, str):
                    node.value = node.value.replace('m4', identity).replace('browser-session-cookie', 'bearer-access-token')
                return node
        fixture = RelayFixtureConstants().visit(fixture)
        namespace = dict(vars(module))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[fixture], type_ignores=[])), '<M3-private-fixture>', 'exec'), namespace)
        case = namespace['ApplyRecovery']('runTest'); case.setUp(); case.prepare_heartbeat()
        return case

    def test_actual_updater_m3_opt_in_uses_complete_before_rows_and_keeps_strict_quiescence(self):
        case = self.actual_relay_update_fixture()
        try:
            case.execute(True); result = json.loads(case.output.read_text())
            self.assertEqual(result['phase'], 'verified')
            self.assertFalse(result['rowsByteIdentical'])
            self.assertEqual(result['authHeartbeatWitness']['serviceIdentity'], 'm3')
            self.assertEqual(case.quiescence_checks, [case.before['processQuiescence']])
            self.assertEqual(len(case.restart_calls), 1)
            self.assertNotIn('private-credential', case.output.read_text())
            self.assertNotIn('private-session', case.output.read_text())
        finally: case.tearDown()

    def test_actual_updater_m3_default_remains_strict_and_cannot_claim_heartbeat(self):
        case = self.actual_relay_update_fixture()
        try:
            with self.assertRaises(AssertionError): case.execute()
            result = json.loads(case.output.read_text())
            self.assertEqual(result['result'], 'update-failed')
            self.assertNotIn('authHeartbeatWitness', result)
        finally: case.tearDown()

    def test_actual_updater_m3_credential_change_refuses_and_keeps_original_pointers(self):
        case = self.actual_relay_update_fixture()
        try:
            advance = case.on_restart
            def credential_change():
                advance()
                db = sqlite3.connect(case.own / 'userdata/statev2.sqlite')
                db.execute("UPDATE auth_sessions SET credential=x'01'"); db.commit()
                case.rows['hashes']['auth_sessions'] = heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')])
                db.close()
            case.on_restart = credential_change
            with self.assertRaises(AssertionError): case.execute(True)
            self.assertEqual(json.loads(case.output.read_text())['result'], 'update-failed')
            self.assertTrue(all(path.read_bytes() == value for path, value in case.original.items()))
        finally: case.tearDown()


    def test_m1_existing_web_bearer_reconnect_has_host_bound_inverse_proof(self):
        self.relay_baseline(); self.change(); raw = self.path.read_bytes()
        witness = self.relay_prove('m1')
        self.assertEqual(witness['serviceIdentity'], 'm1')
        self.assertEqual(witness['sessionMethod'], 'bearer-access-token')
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                         identity='m1'), witness)
        with self.assertRaises(AssertionError):
            heartbeat.verify_restart_witness(self.before, self.after, witness, self.current, identity='m3')
        self.assertEqual(self.path.read_bytes(), raw)

    def test_m1_cookie_cli_native_null_or_unknown_surface_never_has_heartbeat_permission(self):
        for method, surface in [('browser-session-cookie', 'web'), ('bearer-access-token', 'cli'),
                                ('bearer-access-token', 'native'), ('bearer-access-token', None),
                                ('dpop-access-token', 'web')]:
            with self.subTest(method=method, surface=surface):
                self.relay_baseline(method, surface); self.change()
                with self.assertRaises(AssertionError): self.relay_prove('m1')

    def test_m1_existing_null_surface_session_is_preserved_and_cannot_borrow_web_permission(self):
        self.relay_baseline()
        self.db.execute("UPDATE auth_sessions SET method='bearer-access-token',client_surface=NULL,revoked_at=NULL WHERE session_id='private-session-two'")
        self.db.commit(); self.baseline(); self.change()
        self.assertEqual(self.relay_prove('m1')['changedRows'], 1)
        self.db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?',
                        (NEW, 'private-session-two')); self.db.commit()
        self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
        with self.assertRaises(AssertionError): self.relay_prove('m1')

    def test_actual_updater_m1_web_bearer_opt_in_keeps_every_guard_and_reconstructs_one_row(self):
        case = self.actual_relay_update_fixture('m1')
        try:
            case.execute(True); result = json.loads(case.output.read_text())
            self.assertEqual(result['phase'], 'verified')
            self.assertEqual(result['authHeartbeatWitness']['serviceIdentity'], 'm1')
            self.assertEqual(result['authHeartbeatWitness']['changedColumn'], 'last_connected_at')
            self.assertFalse(result['rowsByteIdentical'])
            self.assertEqual(case.quiescence_checks, [case.before['processQuiescence']])
            self.assertEqual(len(case.restart_calls), 1)
            self.assertNotIn('private-credential', case.output.read_text())
        finally: case.tearDown()

    def test_actual_updater_m1_without_opt_in_still_refuses_timestamp_drift(self):
        case = self.actual_relay_update_fixture('m1')
        try:
            with self.assertRaises(AssertionError): case.execute()
            self.assertEqual(json.loads(case.output.read_text())['result'], 'update-failed')
        finally: case.tearDown()

    def two_browser_baseline(self):
        self.db.execute('UPDATE auth_sessions SET revoked_at=NULL')
        self.db.commit(); self.baseline()

    def change_two(self, value=NEW):
        self.db.execute('UPDATE auth_sessions SET last_connected_at=?', (value,))
        self.db.commit(); self.after = self.proof()
        self.current = heartbeat.read_auth_sessions(self.state, self.after)

    def test_m4_two_cookie_reconnects_with_identical_timestamps_reconstruct_all_rows(self):
        self.two_browser_baseline(); self.change_two(); raw = self.path.read_bytes()
        witness = self.prove()
        self.assertEqual(witness['schemaVersion'], 2)
        self.assertEqual(witness['changedRows'], 2)
        self.assertEqual(witness['serviceIdentity'], 'm4')
        self.assertEqual(witness['sessionMethod'], 'browser-session-cookie')
        self.assertEqual(witness['sessionSurface'], 'web')
        self.assertEqual(len({cell['rowSha256'] for cell in witness['timestampChanges']}), 2)
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)
        self.assertEqual(self.path.read_bytes(), raw)
        for secret in ['private-session', 'private-subject', 'private-label', 'private-token', 'token_digest']:
            self.assertNotIn(secret, json.dumps(witness))

    def test_m4_two_witness_is_deterministic_under_row_order_and_distinct_timestamps(self):
        self.two_browser_baseline(); self.change_two()
        self.db.execute("UPDATE auth_sessions SET last_connected_at='2026-10-08T10:00:01.555Z' WHERE session_id='private-session-two'")
        self.db.commit(); self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
        witness = self.prove()
        self.original['rows'].reverse(); self.current['rows'].reverse()
        self.assertEqual(self.prove(), witness)
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)

    def test_m4_does_not_require_every_existing_cookie_to_reconnect(self):
        self.two_browser_baseline(); self.change()
        witness = self.prove()
        self.assertEqual(witness['schemaVersion'], 1); self.assertEqual(witness['changedRows'], 1)
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)

    def test_m4_three_reconnects_fail_even_when_all_are_existing_active_cookies(self):
        self.two_browser_baseline()
        self.db.execute("INSERT INTO auth_sessions SELECT 'private-three',subject,scopes,method,client_label,client_surface,client_app_version,issued_at,expires_at,last_connected_at,revoked_at,token_digest FROM auth_sessions LIMIT 1")
        self.db.commit(); self.baseline(); self.change_two()
        with self.assertRaisesRegex(AssertionError, 'count'): self.prove()

    def test_workers_still_refuse_two_existing_web_bearer_reconnects(self):
        self.two_browser_baseline()
        self.db.execute("UPDATE auth_sessions SET method='bearer-access-token'")
        self.db.commit(); self.baseline(); self.change_two()
        for identity in ['m1', 'm3']:
            with self.subTest(identity=identity), self.assertRaisesRegex(AssertionError, 'count'):
                self.relay_prove(identity)

    def test_m4_second_cookie_must_already_be_active_web_with_nonnull_prior_timestamp(self):
        self.two_browser_baseline(); baseline = copy.deepcopy(self.original['rows'])
        for field, value in [('method', 'bearer-access-token'), ('client_surface', 'native'),
                             ('client_surface', 'cli'), ('client_surface', None), ('revoked_at', OLD),
                             ('issued_at', NEW), ('expires_at', START), ('last_connected_at', None)]:
            with self.subTest(field=field, value=value):
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', baseline)
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', (value, 'private-session-two'))
                self.db.commit(); self.baseline(); self.change_two()
                with self.assertRaises(AssertionError): self.prove()

    def test_m4_second_cookie_cannot_change_any_other_cell(self):
        self.two_browser_baseline(); baseline = copy.deepcopy(self.original['rows'])
        for field in self.original['columns']:
            if field == 'last_connected_at': continue
            with self.subTest(field=field):
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', baseline)
                self.db.commit(); self.baseline()
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', ('changed', 'private-session-two'))
                self.change_two()
                with self.assertRaises(AssertionError): self.prove()

    def test_m4_each_timestamp_must_advance_within_the_same_bounded_window(self):
        self.two_browser_baseline()
        for value in [None, '2026-10-08T08:59:59Z', '2026-10-08T09:59:59Z',
                      '2026-10-08T10:00:02.001Z', '2026-02-30T10:00:01Z']:
            with self.subTest(value=value):
                self.change_two()
                self.db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', (value, 'private-session-two'))
                self.db.commit(); self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
                with self.assertRaises(AssertionError): self.prove()
        self.change_two()
        with self.assertRaises(AssertionError): self.prove(end='2026-10-08T10:02:00.001Z')

    def test_m4_v2_witness_cannot_forge_host_counts_types_flags_or_schema(self):
        self.two_browser_baseline(); self.change_two(); witness = self.prove()
        for field, value in [('schemaVersion', True), ('schemaVersion', 2.0), ('schemaVersion', 1),
                             ('changedRows', True), ('changedRows', 2.0), ('changedRows', 1), ('changedRows', 3),
                             ('originalCompleteRowsReconstructed', 1), ('originalCompleteRowsReconstructed', False),
                             ('serviceIdentity', 'm1'), ('sessionMethod', 'bearer-access-token'),
                             ('sessionSurface', None), ('authSchemaSha256', 'f' * 64), ('extra', True)]:
            with self.subTest(field=field, value=value), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, field: value}, self.current)
        for identity in ['m1', 'm3']:
            with self.subTest(identity=identity), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, witness, self.current, identity=identity)

    def test_m4_v2_cells_require_unique_exact_fingerprints_and_canonical_shape(self):
        self.two_browser_baseline(); self.change_two(); witness = self.prove()
        variants = [[], witness['timestampChanges'][:1], witness['timestampChanges'] * 2,
                    [witness['timestampChanges'][0]] * 2, list(reversed(witness['timestampChanges']))]
        for field, value in [('rowSha256', 'f' * 64), ('rowSha256', None), ('rowSha256', 'bad'),
                             ('beforeLastConnectedAt', '2026-10-08T09:00:00.001Z'),
                             ('afterLastConnectedAt', '2026-10-08T10:00:01.235Z'), ('extra', True)]:
            cells = copy.deepcopy(witness['timestampChanges']); cells[0][field] = value; variants.append(cells)
        for cells in variants:
            with self.subTest(cells=cells), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, 'timestampChanges': cells}, self.current)

    def test_single_witness_integer_types_and_boolean_flag_are_exact(self):
        self.change(); witness = self.prove()
        for field, value in [('schemaVersion', True), ('schemaVersion', 1.0), ('changedRows', True),
                             ('changedRows', 1.0), ('originalCompleteRowsReconstructed', 1)]:
            with self.subTest(field=field, value=value), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, field: value}, self.current)

    def test_actual_updater_m4_two_cookie_reconnects_keep_quiescence_and_full_inverse_proof(self):
        path = pathlib.Path(__file__).with_name('test-update.py')
        spec = importlib.util.spec_from_file_location('m4_two_fixture', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        case = module.ApplyRecovery('runTest'); case.setUp(); case.prepare_heartbeat()
        try:
            db = sqlite3.connect(case.own / 'userdata/statev2.sqlite')
            db.execute("INSERT INTO auth_sessions SELECT 'private-second',method,client_surface,issued_at,expires_at,last_connected_at,revoked_at,credential FROM auth_sessions LIMIT 1")
            db.commit()
            case.rows['counts']['auth_sessions'] = 2
            case.rows['hashes']['auth_sessions'] = heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')])
            db.close(); case.before['rows'] = copy.deepcopy(case.rows)
            case.execute(True); result = json.loads(case.output.read_text())
            self.assertEqual(result['phase'], 'verified'); self.assertFalse(result['rowsByteIdentical'])
            self.assertEqual(result['authHeartbeatWitness']['schemaVersion'], 2)
            self.assertEqual(result['authHeartbeatWitness']['changedRows'], 2)
            self.assertEqual(case.quiescence_checks, [case.before['processQuiescence']])
            self.assertEqual(len(case.restart_calls), 1)
            self.assertNotIn('private-second', case.output.read_text())
            self.assertNotIn('private-credential', case.output.read_text())
        finally: case.tearDown()


    # The desktop app's own sessions on the restarted service reconnect too (M1/M3 0.2.9 rollbacks).
    def add_desktop(self, session_id='private-desktop', method='bearer-access-token', surface='desktop', **cells):
        row = {'session_id': session_id, 'subject': 'private-subject', 'scopes': '["read","write"]', 'method': method,
               'client_label': 'private-desktop-label', 'client_surface': surface, 'client_app_version': '0.2.8',
               'issued_at': '2026-10-01T00:00:00.000Z', 'expires_at': '2026-11-01T00:00:00.000Z',
               'last_connected_at': OLD, 'revoked_at': None, 'token_digest': b'private-desktop-token', **cells}
        self.db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', list(row.values()))
        self.db.commit()

    def reconnect(self, *session_ids, value=NEW):
        for session_id in session_ids:
            self.db.execute('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', (value, session_id))
        self.db.commit(); self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)

    def test_worker_relay_and_desktop_app_reconnects_are_proven_and_named(self):
        for identity in ['m1', 'm3']:
            with self.subTest(identity=identity):
                self.relay_baseline(); self.add_desktop(); self.baseline()
                self.reconnect('private-session-one', 'private-desktop'); raw = self.path.read_bytes()
                witness = self.relay_prove(identity)
                self.assertEqual((witness['schemaVersion'], witness['changedRows'], witness['serviceIdentity']), (3, 2, identity))
                self.assertEqual(sorted(cell['kind'] for cell in witness['sessions']),
                                 ['existing-desktop-app-session', 'existing-web-session'])
                desktop = next(cell for cell in witness['sessions'] if cell['kind'] == 'existing-desktop-app-session')
                self.assertEqual((desktop['method'], desktop['surface']), ('bearer-access-token', 'desktop'))
                self.assertEqual(len(desktop['sessionIdSha256']), 64)
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                                  identity=identity), witness)
                self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])
                for secret in ['private-session', 'private-desktop', 'private-subject', 'private-label', 'private-token']:
                    self.assertNotIn(secret, json.dumps(witness))
                self.assertEqual(self.path.read_bytes(), raw)
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_desktop_app_reconnect_alone_is_proven_on_every_host(self):
        for identity in ['m4', 'm1', 'm3']:
            with self.subTest(identity=identity):
                self.add_desktop(); self.baseline(); self.reconnect('private-desktop')
                witness = self.relay_prove(identity)
                self.assertEqual((witness['schemaVersion'], witness['changedRows']), (3, 1))
                self.assertEqual([cell['kind'] for cell in witness['sessions']], ['existing-desktop-app-session'])
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                                  identity=identity), witness)
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_m4_two_cookies_and_a_desktop_app_reconnect_together(self):
        self.two_browser_baseline(); self.add_desktop(); self.baseline()
        self.reconnect('private-session-one', 'private-session-two', 'private-desktop')
        witness = self.prove()
        self.assertEqual((witness['schemaVersion'], witness['changedRows']), (3, 3))
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)

    def test_desktop_permission_never_covers_other_sessions_methods_or_states(self):
        for name, cells in [('cookie on desktop', {'method': 'browser-session-cookie'}),
                            ('cli surface', {'surface': 'cli'}), ('no surface', {'surface': None}),
                            ('mobile surface', {'surface': 'mobile'}), ('revoked', {'revoked_at': OLD}),
                            ('expired', {'expires_at': '2026-10-08T09:59:59.000Z'}), ('future', {'issued_at': NEW}),
                            ('never connected', {'last_connected_at': None})]:
            with self.subTest(name):
                surface = cells.pop('surface', 'desktop'); method = cells.pop('method', 'bearer-access-token')
                self.relay_baseline(); self.add_desktop(method=method, surface=surface, **cells); self.baseline()
                self.reconnect('private-session-one', 'private-desktop')
                with self.assertRaises(AssertionError): self.relay_prove('m3')
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_desktop_session_may_change_only_its_heartbeat(self):
        for field, value in [('scopes', '["admin"]'), ('token_digest', b'rotated'), ('client_surface', 'web'),
                             ('method', 'dpop-access-token'), ('expires_at', '2026-12-01T00:00:00.000Z'),
                             ('client_app_version', '0.2.9'), ('subject', 'other')]:
            with self.subTest(field=field):
                self.relay_baseline(); self.add_desktop(); self.baseline()
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', (value, 'private-desktop'))
                self.reconnect('private-session-one', 'private-desktop')
                with self.assertRaises(AssertionError): self.relay_prove('m3')
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_desktop_heartbeat_never_covers_a_hex_alias_of_a_token(self):
        # The legacy row hash writes a BLOB as its hex text; the proof compares SQLite types.
        for target in ['private-desktop', 'private-desktop-idle']:
            with self.subTest(target=target):
                self.relay_baseline(); self.add_desktop(); self.add_desktop('private-desktop-idle'); self.baseline()
                self.db.execute('UPDATE auth_sessions SET token_digest=lower(hex(token_digest)) WHERE session_id=?', (target,))
                self.reconnect('private-session-one', 'private-desktop')
                with self.assertRaisesRegex(AssertionError, 'Heartbeat changed another auth cell'): self.relay_prove('m3')
                self.db.execute("DELETE FROM auth_sessions WHERE session_id LIKE 'private-desktop%'"); self.db.commit()

    def test_desktop_heartbeat_never_covers_an_integer_rewritten_as_text(self):
        # token_digest is declared BLOB, so SQLite keeps whatever storage class it is given.
        self.relay_baseline(); self.add_desktop(token_digest=28); self.baseline()
        self.db.execute("UPDATE auth_sessions SET token_digest='28' WHERE session_id='private-desktop'")
        self.reconnect('private-desktop')
        with self.assertRaises(AssertionError): self.relay_prove('m3')

    def test_new_or_too_many_desktop_sessions_are_refused(self):
        self.relay_baseline(); self.baseline()
        self.add_desktop('private-new-desktop', last_connected_at=NEW)  # Not in the prestate.
        self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
        with self.assertRaises(AssertionError): self.relay_prove('m3')
        self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-new-desktop'"); self.db.commit()
        names = ['private-desktop-%d' % index for index in range(heartbeat.MAX_DESKTOP_HEARTBEATS + 1)]
        for name in names: self.add_desktop(name)
        self.baseline(); self.reconnect(*names)
        with self.assertRaisesRegex(AssertionError, 'count'): self.relay_prove('m3')
        self.reconnect(*names[1:], value=OLD); self.reconnect(*names[:heartbeat.MAX_DESKTOP_HEARTBEATS])
        self.assertEqual(self.relay_prove('m3')['changedRows'], heartbeat.MAX_DESKTOP_HEARTBEATS)

    def test_workers_still_refuse_a_second_web_session_beside_a_desktop_app(self):
        self.two_browser_baseline()
        self.db.execute("UPDATE auth_sessions SET method='bearer-access-token'"); self.db.commit()
        self.add_desktop(); self.baseline()
        self.reconnect('private-session-one', 'private-session-two', 'private-desktop')
        with self.assertRaisesRegex(AssertionError, 'count'): self.relay_prove('m3')

    def test_v3_witness_cannot_be_forged_or_moved_to_another_host(self):
        self.relay_baseline(); self.add_desktop(); self.baseline()
        self.reconnect('private-session-one', 'private-desktop')
        witness = self.relay_prove('m3')
        for field, value in [('serviceIdentity', 'm1'), ('changedRows', 1), ('changedRows', True),
                             ('sessions', witness['sessions'][:1]), ('timestampChanges', witness['timestampChanges'][:1]),
                             ('schemaVersion', 2), ('unexpected', 'extra')]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, field: value}, self.current, identity='m3')
        forged = copy.deepcopy(witness); forged['sessions'][0]['kind'] = 'existing-web-session'
        forged['sessions'][1]['kind'] = 'existing-web-session'
        with self.assertRaises(AssertionError):
            heartbeat.verify_restart_witness(self.before, self.after, forged, self.current, identity='m3')
        with self.assertRaises(AssertionError):
            heartbeat.verify_restart_witness(self.before, self.after, witness, self.current, identity='m1')

    def test_actual_updater_m3_relay_and_desktop_reconnects_verify_and_name_both(self):
        case = self.actual_relay_update_fixture('m3')
        try:
            state = case.own / 'userdata'
            db = sqlite3.connect(state / 'statev2.sqlite')
            db.execute("INSERT INTO auth_sessions SELECT 'private-desktop','bearer-access-token','desktop',issued_at,expires_at,last_connected_at,revoked_at,x'02' FROM auth_sessions LIMIT 1")
            db.commit()
            case.rows['counts']['auth_sessions'] = 2
            case.rows['hashes']['auth_sessions'] = heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')])
            db.close(); case.before['rows'] = copy.deepcopy(case.rows)
            case.execute(True); result = json.loads(case.output.read_text())
            self.assertEqual(result['phase'], 'verified')
            self.assertEqual(result['authHeartbeatWitness']['schemaVersion'], 3)
            self.assertEqual(sorted(cell['kind'] for cell in result['authHeartbeatSessions']),
                             ['existing-desktop-app-session', 'existing-web-session'])
            self.assertEqual(case.quiescence_checks, [case.before['processQuiescence']])
            for secret in ['private-desktop', 'private-session', 'private-credential']:
                self.assertNotIn(secret, case.output.read_text())
        finally: case.tearDown()

if __name__ == '__main__': unittest.main()
