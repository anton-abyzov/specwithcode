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
                           ('2026-10-08T10:00:00', END), (START, '2026-10-08T11:00:00.001Z')]:
            with self.subTest(start=start, end=end), self.assertRaises(AssertionError): self.prove(start, end)

    def test_a_slow_restart_within_the_readiness_deadline_is_bounded(self):
        import update
        self.assertGreaterEqual(heartbeat.MAX_RESTART_WINDOW_SECONDS, 3600)  # The largest apply budget.
        self.assertGreaterEqual(heartbeat.MAX_RESTART_WINDOW_SECONDS, update.APPLY_BUDGET_SECONDS)
        self.change()
        self.assertIsNotNone(self.prove(START, '2026-10-08T10:02:17Z'))  # 137 s, the M4 1.0.38 restart.

    def test_every_other_cell_remains_exact(self):
        for field in ['session_id', 'subject', 'scopes', 'method', 'client_label', 'client_surface',
                      'issued_at', 'expires_at', 'revoked_at', 'token_digest']:
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
            if field in ('last_connected_at', heartbeat.APP_VERSION_COLUMN): continue
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
            if field in ('last_connected_at', heartbeat.APP_VERSION_COLUMN): continue
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
        with self.assertRaises(AssertionError): self.prove(end='2026-10-08T11:00:00.001Z')

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
                            ('revoked', {'revoked_at': OLD}),
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
                             ('subject', 'other')]:
            with self.subTest(field=field):
                self.relay_baseline(); self.add_desktop(); self.baseline()
                self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', (value, 'private-desktop'))
                self.reconnect('private-session-one', 'private-desktop')
                with self.assertRaises(AssertionError): self.relay_prove('m3')
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    # A phone or tablet app's own sessions reconnect the same way (apps/ios MachineConnection.swift).
    def test_phone_app_reconnects_are_proven_and_named_on_every_host(self):
        for identity, method, version in [('m4', 'bearer-access-token', None), ('m1', 'dpop-access-token', None),
                                          ('m3', 'bearer-access-token', '1.0.66'), ('m4', 'dpop-access-token', '1.0.66')]:
            with self.subTest(identity=identity, method=method, version=version):
                self.add_desktop('private-phone', method=method, surface='mobile'); self.baseline()
                if version: self.report('private-phone', version)
                self.reconnect('private-phone'); raw = self.path.read_bytes()
                witness = self.relay_prove(identity)
                self.assertEqual((witness['schemaVersion'], witness['changedRows'], witness['serviceIdentity']),
                                 (5 if version else 3, 1, identity))
                self.assertEqual([(cell['kind'], cell['method'], cell['surface']) for cell in witness['sessions']],
                                 [('existing-mobile-app-session', method, 'mobile')])
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                                  identity=identity), witness)
                self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])
                for secret in ['private-phone', 'private-subject', 'private-desktop-label', 'private-desktop-token']:
                    self.assertNotIn(secret, json.dumps(witness))
                self.assertEqual(self.path.read_bytes(), raw)
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-phone'"); self.db.commit()

    def test_m4_cookies_and_desktop_and_phone_apps_reconnect_together(self):
        self.two_browser_baseline(); self.add_desktop(); self.add_desktop('private-phone', method='dpop-access-token', surface='mobile')
        self.baseline(); self.reconnect('private-session-one', 'private-session-two', 'private-desktop', 'private-phone')
        witness = self.prove()
        self.assertEqual((witness['schemaVersion'], witness['changedRows']), (3, 4))
        self.assertEqual(sorted(cell['kind'] for cell in witness['sessions']),
                         ['existing-desktop-app-session', 'existing-mobile-app-session', 'existing-web-session', 'existing-web-session'])
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)
        forged = copy.deepcopy(witness)
        next(cell for cell in forged['sessions'] if cell['kind'] == 'existing-mobile-app-session')['kind'] = 'existing-desktop-app-session'
        with self.assertRaises(AssertionError): heartbeat.verify_restart_witness(self.before, self.after, forged, self.current)

    def test_m4_full_session_budget_is_proven_and_restored_and_one_more_phone_is_refused(self):
        # The budgets the owner approved and docs/studio/updates.md states.
        self.assertEqual((heartbeat.MAX_DESKTOP_HEARTBEATS, heartbeat.MAX_MOBILE_HEARTBEATS), (4, 4))
        desktops = ['private-desktop-%d' % index for index in range(heartbeat.MAX_DESKTOP_HEARTBEATS)]
        phones = ['private-phone-%d' % index for index in range(heartbeat.MAX_MOBILE_HEARTBEATS + 1)]
        self.two_browser_baseline()
        for name in desktops: self.add_desktop(name)
        for name in phones: self.add_desktop(name, method='dpop-access-token', surface='mobile')
        self.baseline(); self.reconnect('private-session-one', 'private-session-two', *desktops, *phones)
        with self.assertRaisesRegex(AssertionError, 'count'): self.prove()
        self.reconnect(phones[-1], value=OLD)
        witness = self.prove()
        self.assertEqual(witness['changedRows'], 2 + heartbeat.MAX_DESKTOP_HEARTBEATS + heartbeat.MAX_MOBILE_HEARTBEATS)
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)
        self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])

    def test_phone_session_rules_match_the_desktop_apps(self):
        """Never a cookie or a CLI session, a revoked or expired one, or one changing anything but its heartbeat."""
        for name, cells, field, value in [
                ('cookie', {'method': 'browser-session-cookie'}, None, None), ('revoked', {'revoked_at': OLD}, None, None),
                ('expired', {'expires_at': '2026-10-08T09:59:59.000Z'}, None, None), ('future', {'issued_at': NEW}, None, None),
                ('now desktop', {}, 'client_surface', 'desktop'), ('now web', {}, 'client_surface', 'web'),
                ('now cli', {}, 'client_surface', 'cli'), ('other method', {}, 'method', 'dpop-access-token'),
                ('scopes', {}, 'scopes', '["admin"]'), ('token', {}, 'token_digest', b'rotated')]:
            with self.subTest(name):
                self.relay_baseline(); self.add_desktop('private-phone', surface='mobile', **cells); self.baseline()
                if field: self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', (value, 'private-phone'))
                self.reconnect('private-session-one', 'private-phone')
                with self.assertRaises(AssertionError): self.relay_prove('m3')
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-phone'"); self.db.commit()

    def test_new_or_too_many_phone_sessions_are_refused(self):
        self.relay_baseline(); self.baseline()
        self.add_desktop('private-new-phone', surface='mobile', last_connected_at=NEW)  # Not in the prestate.
        self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)
        with self.assertRaises(AssertionError): self.relay_prove('m3')
        self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-new-phone'"); self.db.commit()
        names = ['private-phone-%d' % index for index in range(heartbeat.MAX_MOBILE_HEARTBEATS + 1)]
        for name in names: self.add_desktop(name, surface='mobile')
        self.baseline(); self.reconnect(*names)
        with self.assertRaisesRegex(AssertionError, 'count'): self.relay_prove('m3')
        self.reconnect(*names[1:], value=OLD); self.reconnect(*names[:heartbeat.MAX_MOBILE_HEARTBEATS])
        self.assertEqual(self.relay_prove('m3')['changedRows'], heartbeat.MAX_MOBILE_HEARTBEATS)

    def test_a_generic_service_proves_phone_app_reconnects_under_its_policy(self):
        for policy, version in [('worker-relay', None), ('browser-cookie', '1.0.66')]:
            with self.subTest(policy=policy, version=version):
                phone = 'private-phone-' + policy
                self.add_desktop(phone, method='dpop-access-token', surface='mobile'); self.baseline()
                if version: self.report(phone, version)
                self.reconnect(phone)
                witness = heartbeat.prove_restart_heartbeat(self.before, self.after, self.original, self.current, START, END,
                                                            identity='lab', web_session_policy=policy)
                self.assertEqual((witness['schemaVersion'], witness['serviceIdentity'], witness['webSessionPolicy']),
                                 (5 if version else 4, 'lab', policy))
                self.assertEqual([cell['kind'] for cell in witness['sessions']], ['existing-mobile-app-session'])
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                                  identity='lab', web_session_policy=policy), witness)
                self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])

    # A desktop app or a page reloaded into the new release reports its version as it reconnects
    # (AuthSessions.ts setClientConnectionRow): witness version 5.
    def report(self, session_id, version):
        self.db.execute('UPDATE auth_sessions SET client_app_version=? WHERE session_id=?', (version, session_id))
        self.db.commit()

    def test_a_reconnect_reporting_its_new_app_version_is_proven_and_reversed(self):
        for old in ['0.1', None]:
            with self.subTest(old=old):
                self.report('private-session-one', old); self.baseline()
                self.report('private-session-one', '1.0.61'); self.change(); raw = self.path.read_bytes()
                witness = self.prove()
                self.assertEqual((witness['schemaVersion'], witness['changedRows'], witness['serviceIdentity']), (5, 1, 'm4'))
                self.assertNotIn('webSessionPolicy', witness)
                self.assertEqual(witness['timestampChanges'], [{
                    'rowSha256': heartbeat.invariant_row_hash(self.current, self.current['rows'][0]),
                    'beforeLastConnectedAt': OLD, 'afterLastConnectedAt': NEW,
                    'beforeClientAppVersion': old, 'afterClientAppVersion': '1.0.61'}])
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)
                self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])
                for secret in ['private-session', 'private-subject', 'private-label', 'private-token', 'token_digest']:
                    self.assertNotIn(secret, json.dumps(witness))
                self.assertEqual(self.path.read_bytes(), raw)
                self.change(OLD); self.report('private-session-one', '0.1')

    def test_desktop_app_relaunched_into_the_new_release_is_proven_on_every_host(self):
        for identity in ['m4', 'm1', 'm3']:
            with self.subTest(identity=identity):
                self.add_desktop(); self.baseline()
                self.report('private-desktop', '1.0.61'); self.reconnect('private-desktop')
                witness = self.relay_prove(identity)
                self.assertEqual((witness['schemaVersion'], witness['changedRows'], witness['serviceIdentity']), (5, 1, identity))
                self.assertEqual([cell['kind'] for cell in witness['sessions']], ['existing-desktop-app-session'])
                cell = witness['timestampChanges'][0]
                self.assertEqual((cell['beforeClientAppVersion'], cell['afterClientAppVersion']), ('0.2.8', '1.0.61'))
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                                  identity=identity), witness)
                self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_only_the_session_that_reported_a_version_carries_one(self):
        self.relay_baseline(); self.add_desktop(); self.baseline()
        self.report('private-desktop', '1.0.61'); self.reconnect('private-session-one', 'private-desktop')
        witness = self.relay_prove('m3')
        self.assertEqual((witness['schemaVersion'], witness['changedRows']), (5, 2))
        self.assertEqual(sorted(len(cell) for cell in witness['timestampChanges']), [3, 5])
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current, identity='m3'), witness)
        self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])

    def test_a_generic_service_keeps_its_policy_in_a_version_5_witness(self):
        self.add_desktop(); self.baseline()
        self.report('private-desktop', '1.0.61'); self.reconnect('private-desktop')
        witness = heartbeat.prove_restart_heartbeat(self.before, self.after, self.original, self.current, START, END,
                                                    identity='lab', web_session_policy='worker-relay')
        self.assertEqual((witness['schemaVersion'], witness['serviceIdentity'], witness['webSessionPolicy']),
                         (5, 'lab', 'worker-relay'))
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                          identity='lab', web_session_policy='worker-relay'), witness)
        for identity, policy in [('lab', 'browser-cookie'), ('other', 'worker-relay'), ('m3', None)]:
            with self.subTest(identity=identity, policy=policy), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                  identity=identity, web_session_policy=policy)

    def observe(self):
        self.after = self.proof(); self.current = heartbeat.read_auth_sessions(self.state, self.after)

    # ws.ts commits the version (recordClientConnection) before the heartbeat (markConnected), and stamps
    # the heartbeat only on a session's first open connection: a version may change on its own.
    def test_a_version_reported_without_a_new_heartbeat_is_proven_and_reversed(self):
        self.report('private-session-one', '1.0.61'); self.observe(); raw = self.path.read_bytes()
        witness = self.prove()
        self.assertEqual((witness['schemaVersion'], witness['changedRows'], witness['serviceIdentity']), (5, 1, 'm4'))
        self.assertEqual(witness['timestampChanges'], [{
            'rowSha256': heartbeat.invariant_row_hash(self.current, self.current['rows'][0]),
            'beforeClientAppVersion': '0.1', 'afterClientAppVersion': '1.0.61'}])
        self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current), witness)
        self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])
        self.assertEqual(self.path.read_bytes(), raw)

    def test_a_desktop_app_reporting_its_version_before_its_heartbeat_is_proven_on_every_host(self):
        for identity in ['m1', 'm3', 'm4']:
            with self.subTest(identity=identity):
                self.relay_baseline(method='browser-session-cookie' if identity == 'm4' else 'bearer-access-token')
                self.add_desktop(); self.baseline()
                self.report('private-desktop', '1.0.61'); self.reconnect('private-session-one')
                witness = self.relay_prove(identity)
                self.assertEqual((witness['schemaVersion'], witness['changedRows']), (5, 2))
                self.assertEqual(sorted(sorted(cell) for cell in witness['timestampChanges']),
                                 sorted([sorted(heartbeat.HEARTBEAT_CELL), sorted(heartbeat.VERSION_CELL)]))
                self.assertEqual(heartbeat.verify_restart_witness(self.before, self.after, witness, self.current,
                                                                  identity=identity), witness)
                self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_a_version_report_alone_still_needs_an_active_supported_session(self):
        self.report('private-session-two', '1.0.61'); self.observe()
        with self.assertRaisesRegex(AssertionError, 'revoked'): self.prove()
        self.report('private-session-two', '0.1')
        for name, cells in [('cli surface', {'surface': 'cli'}), ('no surface', {'surface': None}),
                            ('cookie on desktop', {'method': 'browser-session-cookie'}),
                            ('cookie on mobile', {'method': 'browser-session-cookie', 'surface': 'mobile'}),
                            ('revoked', {'revoked_at': OLD}), ('expired', {'expires_at': '2026-10-08T09:59:59.000Z'}),
                            ('future', {'issued_at': NEW})]:
            with self.subTest(name):
                surface = cells.pop('surface', 'desktop'); method = cells.pop('method', 'bearer-access-token')
                self.add_desktop(method=method, surface=surface, **cells); self.baseline()
                self.report('private-desktop', '1.0.61'); self.observe()
                with self.assertRaises(AssertionError): self.relay_prove('m3')
                self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_a_version_report_alone_is_validated_and_bound_to_its_row(self):
        for value in ['', None, 'x' * 65, b'1.0.61']:
            with self.subTest(value=value):
                self.report('private-session-one', value); self.observe()
                with self.assertRaisesRegex(AssertionError, 'invalid app version'): self.prove()
                self.report('private-session-one', '0.1')
        self.add_desktop(); self.add_desktop('private-desktop-idle'); self.baseline()
        self.report('private-desktop', '1.0.61'); self.observe()
        witness = self.relay_prove('m3')
        cell = witness['timestampChanges'][0]
        for name, forged in [('equal versions', {**cell, 'beforeClientAppVersion': '1.0.61'}),
                             ('other live version', {**cell, 'afterClientAppVersion': '0.2.8'}),
                             ('invented before', {**cell, 'beforeClientAppVersion': '0.2.7'}),
                             ('bytes before', {**cell, 'beforeClientAppVersion': b'0.2.8'}),
                             ('with timestamps', {**cell, 'beforeLastConnectedAt': OLD, 'afterLastConnectedAt': NEW}),
                             ('other row', {**cell, 'rowSha256': heartbeat.invariant_row_hash(self.current, next(
                                 row for row in self.current['rows'] if row[0] == 'private-desktop-idle'))})]:
            with self.subTest(name), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, 'timestampChanges': [forged]},
                                                  self.current, identity='m3')
        for version in (3, 4):
            with self.subTest(schemaVersion=version), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, 'schemaVersion': version},
                                                  self.current, identity='m3')
        with self.assertRaisesRegex(AssertionError, 'shape'):
            heartbeat.restore_timestamps(self.current, witness['timestampChanges'], self.before)
        self.assertEqual(heartbeat.restore_witness(self.current, witness, self.before)['rows'], self.original['rows'])

    def test_a_reported_version_must_be_short_nonempty_text(self):
        original_rows = copy.deepcopy(self.original['rows'])
        for old, new in [('0.1', ''), ('0.1', None), ('0.1', 'x' * 65), ('0.1', b'1.0.61'), (b'0.1', '1.0.61')]:
            with self.subTest(old=old, new=new):
                self.report('private-session-one', old); self.baseline()
                self.report('private-session-one', new); self.change()
                with self.assertRaisesRegex(AssertionError, 'invalid app version'): self.prove()
                self.db.execute('DELETE FROM auth_sessions')
                self.db.executemany('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', original_rows)
                self.db.commit()
        self.baseline(); self.report('private-session-one', 'x' * 64); self.change()
        self.assertEqual(self.prove()['schemaVersion'], 5)

    def test_a_version_report_never_covers_another_cell(self):
        for field, value in [('scopes', '["admin"]'), ('client_surface', 'web'), ('token_digest', b'rotated'),
                             ('method', 'dpop-access-token'), ('client_label', 'renamed')]:
            for heartbeat_moved in (True, False):
                with self.subTest(field=field, heartbeat_moved=heartbeat_moved):
                    self.relay_baseline(); self.add_desktop(); self.baseline()
                    self.report('private-desktop', '1.0.61')
                    self.db.execute('UPDATE auth_sessions SET ' + field + '=? WHERE session_id=?', (value, 'private-desktop'))
                    self.reconnect(*(['private-desktop'] if heartbeat_moved else []))
                    with self.assertRaisesRegex(AssertionError, 'another auth cell'): self.relay_prove('m3')
                    self.db.execute("DELETE FROM auth_sessions WHERE session_id='private-desktop'"); self.db.commit()

    def test_v5_witness_cannot_be_forged_downgraded_or_moved(self):
        self.add_desktop(); self.baseline()
        self.report('private-desktop', '1.0.61'); self.reconnect('private-desktop')
        witness = self.relay_prove('m3')
        for field, value in [('schemaVersion', 3), ('schemaVersion', 4), ('schemaVersion', 5.0), ('serviceIdentity', 'm1'),
                             ('webSessionPolicy', 'worker-relay'), ('changedRows', 2), ('unexpected', 'extra')]:
            with self.subTest(field=field, value=value), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**witness, field: value}, self.current, identity='m3')
        for field, value in [('afterClientAppVersion', '1.0.62'), ('beforeClientAppVersion', '0.2.7'),
                             ('beforeClientAppVersion', None), ('afterClientAppVersion', None)]:
            with self.subTest(cell=field, value=value), self.assertRaises(AssertionError):
                forged = copy.deepcopy(witness); forged['timestampChanges'][0][field] = value
                heartbeat.verify_restart_witness(self.before, self.after, forged, self.current, identity='m3')
        stripped = copy.deepcopy(witness)
        for key in ('beforeClientAppVersion', 'afterClientAppVersion'): del stripped['timestampChanges'][0][key]
        for version in (5, 3):
            with self.subTest(stripped=version), self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(self.before, self.after, {**stripped, 'schemaVersion': version},
                                                  self.current, identity='m3')
        with self.assertRaisesRegex(AssertionError, 'shape'):
            heartbeat.restore_timestamps(self.current, witness['timestampChanges'], self.before)
        with self.assertRaises(AssertionError):
            heartbeat.verify_restart_witness(self.before, self.after, witness, self.current, identity='m1')

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

    def test_actual_updater_m3_relay_and_app_reconnects_verify_and_name_both(self):
        for method, surface, kind in [('bearer-access-token', 'desktop', 'existing-desktop-app-session'),
                                      ('dpop-access-token', 'mobile', 'existing-mobile-app-session')]:
            with self.subTest(surface=surface):
                case = self.actual_relay_update_fixture('m3')
                try:
                    state = case.own / 'userdata'
                    db = sqlite3.connect(state / 'statev2.sqlite')
                    db.execute("INSERT INTO auth_sessions SELECT 'private-desktop',?,?,issued_at,expires_at,last_connected_at,revoked_at,x'02' FROM auth_sessions LIMIT 1",
                               (method, surface))
                    db.commit()
                    case.rows['counts']['auth_sessions'] = 2
                    case.rows['hashes']['auth_sessions'] = heartbeat.rows_hash([list(row) for row in db.execute('SELECT * FROM auth_sessions')])
                    db.close(); case.before['rows'] = copy.deepcopy(case.rows)
                    case.execute(True); result = json.loads(case.output.read_text())
                    self.assertEqual(result['phase'], 'verified')
                    self.assertEqual(result['authHeartbeatWitness']['schemaVersion'], 3)
                    self.assertEqual(sorted(cell['kind'] for cell in result['authHeartbeatSessions']), sorted([kind, 'existing-web-session']))
                    self.assertEqual(case.quiescence_checks, [case.before['processQuiescence']])
                    for secret in ['private-desktop', 'private-session', 'private-credential']:
                        self.assertNotIn(secret, case.output.read_text())
                finally: case.tearDown()

if __name__ == '__main__': unittest.main()
