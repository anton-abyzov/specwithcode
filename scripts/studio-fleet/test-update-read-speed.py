#!/usr/bin/env python3
"""Install-speed changes to the update reads, against the origin/main code they replace.

Golden equality: the origin/main _read_state, append_only_activity, carried_since,
auth_invariant_hash and capture_connection, with the row hashes and widened_tables the capture
calls, are frozen below and must produce byte-identical proofs, auth, carried rows and captures
on synthetic databases, among them logs longer than one hash chunk and a since nothing can be
carried from, because older and newer helpers compare each other's proofs. Then: idle work is
refused before any table is read in full and in the read's own snapshot, the capture reads each
table once, the thread-keyed projections too (rows appended or not), no read peaks more than 5%
above origin/main's memory and a projection-heavy read or a table's row hash peaks well below
it, a database with two faults is refused as origin/main refused it except where the table names and the idle queries now come first or a
fault ended the read transaction, and a fault only the single scan meets gives origin/main's
answer (also after a migration widened tables). A database with a virtual table is read in
origin/main's order (test-update-read-virtual.py); the restore clone and the single prestate
check are in test-update-restore-prestate.py. Temporary SQLite only; no services or user stores.
"""
import contextlib
import copy
import gc
import hashlib
import importlib.util
import inspect
import itertools
import json
import pathlib
import random
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import tracemalloc
import unittest
from unittest.mock import patch

import database_continuity as continuity
import live_database
import update
import update_read


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


updater_base = module('read_speed_update_base', 'test-update.py')

# Verbatim from origin/main (fe842153c2) scripts/studio-fleet/update.py.
REFERENCE_UPDATE = r'''
def _read_state(state, include_auth, since=None, include_database=False, widen_from=None):
    """Protected rows, private auth, rows appended after `since` and the complete database
    capture, all measured in one read-only transaction. `widen_from` (an earlier capture's
    schema columns) also measures tables that gained columns since (accepted_widenings)."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        counts, hashes = {}, {}
        for table in tables:
            if not re.fullmatch('[a-z0-9_]+', table):
                raise AssertionError('Unexpected table identifier')
            if table.startswith(('projection_', 'orchestration_', 'project_')) or table in AUTHORITY_TABLES:
                # Hash only in memory. Never return columns, credentials, prompts or native IDs.
                rows = sorted(json.dumps(list(row), default=lambda value: value.hex(), separators=(',', ':')) for row in db.execute('SELECT * FROM ' + table))
                counts[table] = len(rows)
                hashes[table] = digest(('\n'.join(rows)).encode())
        runs = run_work(db)[0]
        requests = db.execute("SELECT count(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending'").fetchone()[0]
        # EffectOutbox.ts uses succeeded (not run-status completed). Unknown/NULL
        # values remain nonidle; retain every terminal row in the preservation hash.
        effects = db.execute("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status IS NULL OR status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
        sessions = db.execute("SELECT count(*) FROM orchestration_v2_projection_provider_sessions WHERE status IN ('running','working','connecting','starting')").fetchone()[0]
        assert all(status in TERMINAL_RUNS for status in runs) and requests == effects == sessions == 0, 'Native work is not idle'
        thread_ids = {row[0] for row in db.execute('SELECT thread_id FROM projection_threads')}
        if 'orchestration_v2_projection_threads' in tables:
            thread_ids.update(row[0] for row in db.execute('SELECT thread_id FROM orchestration_v2_projection_threads'))
        proof = {'projectIds': sorted(row[0] for row in db.execute('SELECT project_id FROM projection_projects')),
                 'threadIds': sorted(thread_ids),
                 'counts': counts, 'hashes': hashes, 'nativeWorkIdle': True}
        if 'auth_sessions' in tables:
            proof[AUTH_INVARIANT_KEY] = auth_invariant_hash(db)
        proof[ACTIVITY_KEY] = append_only_activity(db, tables)
        # Keep complete auth cells separate from every serializable public proof. A database
        # without the auth table has no session to capture (a migration may create it).
        auth = read_auth_sessions_in_transaction(db, proof) if include_auth and 'auth_sessions' in tables else None
        # Measured in the same read transaction as the proof it is compared with.
        carried = carried_since(db, tables, since) if since is not None else None
        # Complete schema and typed cells of every table, bound to the protected rows in
        # this same read transaction. Hashes and schema text only; no cell values.
        database = None
        if include_database:
            database = (continuity.capture_connection(db) if widen_from is None
                        else continuity.capture_connection(db, widen_from))
        if database is not None: continuity.bind_rows(database, proof)
        return proof, auth, carried, database
    finally:
        db.close()

def append_only_activity(db, tables):
    """In-memory hashes and row positions only; no content leaves the transaction."""
    logs = {table: db.execute('SELECT coalesce(max(rowid), 0) FROM ' + table).fetchone()[0]
            for table in LOG_TABLES if table in tables and has_rowid(db, table)}
    thread_tables, buckets = [], {}
    for table in tables:
        columns = table_columns(db, table)
        key = stream_column(columns)
        if not (is_projection_table(table) and key) or table in CURSOR_COLUMNS:
            continue
        thread_tables.append(table)
        index = columns.index(key)
        for row in db.execute('SELECT * FROM ' + table):
            buckets.setdefault(stream_key(row[index]), []).append(json.dumps(table) + ',' + encoded_row(row))
    cursors = {}
    for table, moving in CURSOR_COLUMNS.items():
        if table in tables:
            columns = table_columns(db, table)
            keep = [index for index, name in enumerate(columns) if name not in moving]
            cursors[table] = digest(('studio-projection-cursor-v1\n' + '\n'.join(sorted(
                json.dumps([[columns[index], row[index]] for index in keep], default=lambda value: value.hex(),
                           separators=(',', ':')) for row in db.execute('SELECT * FROM ' + table)))).encode())
    return {'logRowids': logs, 'threadTables': sorted(thread_tables),
            'threadSha256': {key: digest(('studio-thread-rows-v1\n' + '\n'.join(sorted(lines))).encode())
                             for key, lines in buckets.items()},
            'cursorSha256': cursors}

def carried_since(db, tables, expected):
    """Rows the running service appended after `expected` was measured. Earlier log rows
    are rehashed at the recorded positions, in the format of the proof's table hashes."""
    activity = expected.get(ACTIVITY_KEY) if isinstance(expected, dict) else None
    if not valid_activity(activity):
        return None
    prefix, typed, appended, streams = {}, {}, {}, set()
    for table, boundary in activity['logRowids'].items():
        if table not in tables or not has_rowid(db, table):
            return None
        earlier = list(db.execute('SELECT * FROM ' + table + ' WHERE rowid <= ?', (boundary,)))
        lines = [encoded_row(row) for row in earlier]
        prefix[table] = [len(lines), rows_digest(lines)]
        # The same earlier rows with SQLite storage classes, for the complete database check.
        typed[table] = {'count': len(earlier), 'sha256': continuity.typed_rows_hash(earlier)}
        appended[table] = db.execute('SELECT count(*) FROM ' + table + ' WHERE rowid > ?', (boundary,)).fetchone()[0]
        column = STREAM_COLUMNS.get(table)
        if column and column in table_columns(db, table):
            streams.update(stream_key(row[0]) for row in
                           db.execute('SELECT ' + column + ' FROM ' + table + ' WHERE rowid > ?', (boundary,)))
    return {'activitySha256': activity_digest(activity), 'logPrefix': prefix, 'typedLogPrefix': typed,
            'appendedRows': appended, 'touchedStreams': sorted(streams)}

def auth_invariant_hash(db):
    """Hash every auth_sessions cell except what a connect rewrites on its own: the heartbeat (a
    connected browser or desktop app rewrites last_connected_at every few seconds) and the app
    version it reports (AUTH_APP_VERSION_COLUMN). Identity, surface, scopes, credentials, expiry
    and revocation all stay guarded, including SQLite types and the complete schema. Hashed in
    memory only. Older invariant hashes fail closed: read a receipt back with the release's own
    helper (v2 until 1.0.60 also hashed the app version)."""
    columns = [row[1] for row in db.execute('PRAGMA table_info(auth_sessions)')]
    skipped = {AUTH_HEARTBEAT_COLUMN, AUTH_APP_VERSION_COLUMN}
    keep = [index for index, name in enumerate(columns) if name not in skipped]
    schema = [[list(row) for row in db.execute('PRAGMA table_xinfo(auth_sessions)')],
              [list(row) for row in db.execute(
                  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='auth_sessions' ORDER BY type,name")]]
    rows = sorted(encoded([(columns[index], type(row[index]).__name__, row[index]) for index in keep])
                  for row in db.execute('SELECT * FROM auth_sessions'))
    return digest(('studio-auth-invariant-v3\n' + encoded(schema) + '\n' + '\n'.join(rows)).encode())
'''

# Verbatim from origin/main (fe842153c2) scripts/studio-fleet/database_continuity.py.
REFERENCE_CONTINUITY = r'''
def typed_rows_hash(rows):
    return digest('\n'.join(sorted(encoded([cell(value) for value in row]) for row in rows)))

def legacy_rows_hash(rows):
    """The protected-row hash update.rows_snapshot publishes (BLOBs as hex strings)."""
    return digest('\n'.join(sorted(json.dumps(list(row), default=lambda value: value.hex(),
                                              separators=(',', ':')) for row in rows)))

def widened_tables(db, structure, widen_from):
    """Tables that gained trailing columns since `widen_from` (an earlier capture's
    schema['columns']): the earlier columns' rows hashed as the earlier capture hashed
    them, and how many rows hold a value in an added column. Hashes and counts only.
    The caller decides which of these widenings it accepts."""
    widened = {}
    for table, old in sorted(widen_from.items()):
        new = structure['columns'].get(table)
        if not (isinstance(old, list) and old and new and len(new) > len(old) and new[:len(old)] == old):
            continue
        names = ','.join(identifier(column[1]) for column in old)
        rows = list(db.execute('SELECT ' + names + ' FROM ' + identifier(table)))
        filled = ' OR '.join(identifier(column[1]) + ' IS NOT NULL' for column in new[len(old):])
        widened[table] = {'added': new[len(old):],
                          'typed': {'count': len(rows), 'sha256': typed_rows_hash(rows)},
                          'legacy': {'count': len(rows), 'sha256': legacy_rows_hash(rows)},
                          'filledRows': db.execute('SELECT count(*) FROM ' + identifier(table) + ' WHERE ' + filled).fetchone()[0]}
    return widened

def capture_connection(db, widen_from=None):
    """Capture the complete database inside the caller's open read transaction. With
    `widen_from`, also measure tables that gained columns since then (widened_tables)."""
    assert db.in_transaction, 'Complete database capture requires an existing read transaction'
    structure = schema(db)
    tables, legacy, sequences = {}, {}, None
    for table in structure['columns']:
        rows = list(db.execute('SELECT * FROM ' + identifier(table)))
        tables[table] = {'count': len(rows), 'sha256': typed_rows_hash(rows)}
        legacy[table] = {'count': len(rows), 'sha256': legacy_rows_hash(rows)}
        if table == 'sqlite_sequence':
            # AUTOINCREMENT counters: table names and integers only, so a log that grew can
            # be told apart from any other change to this bookkeeping table.
            sequences = sorted([list(row) for row in rows], key=encoded)
    summary = {'schemaSha256': digest(encoded(structure)), 'tables': tables}
    if sequences is not None: summary['sqliteSequence'] = sequences
    capture = {'schema': structure, 'summary': summary, 'legacy': legacy}
    if widen_from is not None:
        # Only when a table widened, so an unchanged database captures exactly as without.
        widened = widened_tables(db, structure, widen_from)
        if widened: capture['widened'] = widened
    return capture
'''


def reference_modules():
    """The frozen functions, each resolving its helpers in its own module as on origin/main."""
    capture_space = dict(vars(continuity))
    exec(compile(REFERENCE_CONTINUITY, 'reference-database_continuity', 'exec'), capture_space)
    frozen_continuity = type(continuity)('reference_database_continuity')
    frozen_continuity.__dict__.update(capture_space)
    update_space = dict(vars(update))
    update_space['continuity'] = frozen_continuity
    exec(compile(REFERENCE_UPDATE, 'reference-update', 'exec'), update_space)
    return update_space, frozen_continuity


REFERENCE, REFERENCE_CONTINUITY_MODULE = reference_modules()
# The characters continuity.joined_digest encodes at a time.
CHUNK = inspect.signature(continuity.joined_digest).parameters['size'].default

EXTRA = [
    'CREATE TABLE checkpoint_diff_blobs(id INTEGER PRIMARY KEY AUTOINCREMENT, body)',
    "INSERT INTO checkpoint_diff_blobs(body) VALUES (x'abcd'), ('abcd'), (NULL), (1), (1.0), (-0.0), "
    "(9223372036854775807), (0.1), ('ünïcödé ☃ 😀'), (x'')",
    'CREATE TABLE project_kv(k TEXT PRIMARY KEY, v) WITHOUT ROWID',
    "INSERT INTO project_kv VALUES ('a', x'6162'), ('b', '6162'), ('c', NULL), ('d', 2), ('e', 2.0), ('ü', 'ü')",
    'CREATE TABLE projection_empty(thread_id TEXT, body TEXT)',
    'CREATE TABLE unguarded_empty(v)',
    'CREATE TABLE projection_project_settings(project_id TEXT PRIMARY KEY, value BLOB)',
    "INSERT INTO projection_project_settings VALUES ('p1', x'00ff'), ('p2', 'ünï')",
    'CREATE TABLE projection_thread_numbers(thread_id, n)',
    "INSERT INTO projection_thread_numbers VALUES (7, 1.5), (NULL, 'x'), (x'01', 2), ('t-wait', 3.0)",
    "INSERT INTO projection_threads VALUES ('t-wait'), ('t-idle')",
    "INSERT INTO projection_state VALUES ('projects', 4, '2026-10-11T03:00:00Z')",
    "UPDATE orchestration_events SET payload_json=x'6162' WHERE sequence=1",
    'CREATE TABLE orchestration_v2_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, payload BLOB)',
    "INSERT INTO orchestration_v2_events(thread_id, payload) VALUES ('t-wait', x'01'), ('t-idle', 'ü'), (NULL, 1.25)",
    "INSERT INTO auth_sessions VALUES ('s2', 'other', 'read', 1.5, x'0102')",
    # What a connect writes (the heartbeat, the app version: skipped by the v3 auth invariant)
    # and the surface beside it (kept).
    'ALTER TABLE auth_sessions ADD COLUMN client_surface TEXT',
    'ALTER TABLE auth_sessions ADD COLUMN client_app_version TEXT',
    "UPDATE auth_sessions SET client_surface='desktop', client_app_version='1.0.60' WHERE session_id='s1'",
    "INSERT INTO scheduled_tasks VALUES ('ünï', NULL)",
]
# The fourth log table: without a rowid (left out of the activity), or with a declared column
# named rowid holding a NULL, which `WHERE rowid <= ?` skips: lower case, upper case, or a
# generated column (which PRAGMA table_info leaves out and table_xinfo lists).
RECEIPT_VARIANTS = {
    'without-rowid': ['CREATE TABLE orchestration_v2_command_receipts(command_id TEXT PRIMARY KEY, seq INTEGER) WITHOUT ROWID',
                      "INSERT INTO orchestration_v2_command_receipts VALUES ('c1', 1), ('c2', NULL)"],
    'rowid-column': ['CREATE TABLE orchestration_v2_command_receipts(rowid INTEGER, command_id TEXT)',
                     "INSERT INTO orchestration_v2_command_receipts VALUES (5, 'a'), (NULL, 'b'), (2, 'c')"],
    'rowid-upper-case': ['CREATE TABLE orchestration_v2_command_receipts(ROWID INTEGER, command_id TEXT)',
                         "INSERT INTO orchestration_v2_command_receipts VALUES (5, 'a'), (NULL, 'b'), (2, 'c')"],
    'rowid-generated': ['CREATE TABLE orchestration_v2_command_receipts(seq INTEGER, command_id TEXT, '
                        'rowid INTEGER GENERATED ALWAYS AS (seq) VIRTUAL)',
                        "INSERT INTO orchestration_v2_command_receipts VALUES (5, 'a'), (NULL, 'b'), (2, 'c')"],
}
DECLARED_ROWID_VARIANTS = ('rowid-column', 'rowid-upper-case', 'rowid-generated')
APPEND = ["INSERT INTO orchestration_v2_events(thread_id, payload) VALUES ('t-wait', x'02')"]
# One usage-limit availability check: an event and its receipt past both v1 log boundaries.
CHECK = ["INSERT INTO orchestration_events(event_id, stream_id, event_type, payload_json) "
         "VALUES ('limit-check-z', 't-wait', 'thread.metadata-updated', '{\"limitAvailability\":\"z\"}')",
         "INSERT INTO orchestration_command_receipts(command_id, aggregate_id, result_sequence, status) "
         "VALUES ('limit-check:z', 't-wait', 99, 'accepted')"]
DELETE_LAST = ['DELETE FROM orchestration_events WHERE sequence=(SELECT max(sequence) FROM orchestration_events)',
               'DELETE FROM orchestration_command_receipts WHERE rowid=(SELECT max(rowid) FROM orchestration_command_receipts)']
SCENARIOS = {
    'nothing-appended': [],
    'appended': APPEND,
    'deleted-earlier-row': ['DELETE FROM orchestration_events WHERE sequence=1'],
    'deleted-earlier-row-and-appended': ['DELETE FROM orchestration_events WHERE sequence=2'] + APPEND,
    'edited-earlier-row': ["UPDATE orchestration_events SET payload_json='6162' WHERE sequence=1"],
    'edited-earlier-row-and-appended': ["UPDATE orchestration_v2_events SET payload='ü' WHERE sequence=1"] + APPEND,
    'widened': ['ALTER TABLE projection_projects ADD COLUMN extra TEXT', "UPDATE projection_projects SET extra='x'",
                'ALTER TABLE checkpoint_diff_blobs ADD COLUMN note TEXT'],
    'counter-moved': ["UPDATE sqlite_sequence SET seq=seq+1 WHERE name='checkpoint_diff_blobs'"],
    'unprotected-and-auth-changed': ["UPDATE checkpoint_diff_blobs SET body=x'beef' WHERE id=1",
                                     "UPDATE auth_sessions SET last_connected_at='2026-10-12T00:00:00Z'"],
    'receipt-appended': ["INSERT INTO orchestration_v2_command_receipts VALUES (9, 'd')"],
    # Earlier rows hashed from the capture's scan while rows were appended (log_prefixes).
    'check-appended': CHECK,
    'deleted-last-row': DELETE_LAST,
    # The receipt reuses the deleted rowid (no AUTOINCREMENT): at the boundary, not past it.
    'deleted-last-row-and-appended': DELETE_LAST + CHECK + APPEND,
    'rowid-moved-past-boundary': ['UPDATE orchestration_events SET sequence=1000 WHERE sequence=1',
                                  'UPDATE orchestration_command_receipts SET rowid=1000 WHERE rowid=1'],
    'negative-rowid-and-appended': [
        "INSERT INTO orchestration_events(sequence, event_id, stream_id, event_type, payload_json) "
        "VALUES (-5, 'negative', 't-idle', 'x', '{}')",
        "INSERT INTO orchestration_command_receipts(rowid, command_id, aggregate_id, result_sequence, status) "
        "VALUES (-3, 'negative', 't-idle', -5, 'accepted')"] + CHECK,
    'gap-refilled-and-appended': [
        'DELETE FROM orchestration_events WHERE sequence=2',
        "INSERT INTO orchestration_events(sequence, event_id, stream_id, event_type, payload_json) "
        "VALUES (2, 'refilled', 't-idle', 'x', '{}')",
        'DELETE FROM orchestration_command_receipts WHERE rowid=2',
        "INSERT INTO orchestration_command_receipts(rowid, command_id, aggregate_id, result_sequence, status) "
        "VALUES (2, 'refilled', 't-idle', 2, 'accepted')"] + CHECK,
    'widened-log-and-appended': ['ALTER TABLE orchestration_events ADD COLUMN extra TEXT',
                                 'ALTER TABLE orchestration_command_receipts ADD COLUMN extra BLOB',
                                 "UPDATE orchestration_command_receipts SET extra=x'00' WHERE rowid=1"] + CHECK + [
        "UPDATE orchestration_events SET extra='new' WHERE event_id='limit-check-z'"],
    'reconnected': ["UPDATE auth_sessions SET last_connected_at='2026-10-12T00:00:00Z', client_app_version='1.0.61' "
                    "WHERE session_id='s1'"],
    # A log rebuilt without a rowid after the proof: nothing is carried, and log_prefixes leaves
    # it out (its capture still reads it as `SELECT *`).
    'log-rebuilt-without-rowid': [
        'DROP TABLE orchestration_command_receipts',
        'CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, '
        'result_sequence INTEGER NOT NULL, status TEXT NOT NULL) WITHOUT ROWID',
        "INSERT INTO orchestration_command_receipts VALUES ('rebuilt', 't-wait', 1, 'accepted')"],
}
NOTHING_CARRIED = ('log-rebuilt-without-rowid',)
def build(state, variant):
    updater_base.waiting_fixture(state)
    updater_base.mutate_state(state, *EXTRA, *RECEIPT_VARIANTS[variant])


def frozen(value):
    """Exact text of a result: repr keeps dict order and every type (1 vs 1.0, str vs bytes)."""
    return repr(value)


def sorted_json(value):
    return json.dumps(value, sort_keys=True, default=lambda item: ['bytes', item.hex()])


def outcome(read, *args):
    try:
        return 'ok', read(*args)
    except Exception as error:
        return 'error', (type(error).__name__, str(error))


def read_once(test, state, include_auth, since, include_database, widen_from, label=None, in_order=False):
    """update._read_state's outcome, checked to come from its single scan alone when it
    succeeds: the original order runs again only after a fault, so a fault only the new path
    meets would otherwise hide behind that order's answer. With `in_order` (a database with a
    virtual table), from origin/main's whole order alone, whatever it answers."""
    with patch.object(update_read, '_read_tables', wraps=update_read._read_tables) as tables:
        new = outcome(update._read_state, state, include_auth, since, include_database, widen_from)
    paths = [call.kwargs for call in tables.call_args_list]
    if in_order:
        test.assertEqual(paths, [{'check_idle': True}], label)
    elif new[0] == 'ok':
        test.assertEqual(paths, [{'once': True}] if include_database else [{}], label)
    return new


def single_scan_outcome(state, include_auth, since, widen_from=None):
    """What update._read_state's single scan alone answers, without origin/main's order after it."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        return outcome(lambda: update_read._read_tables(db, table_names(db), include_auth, since, True, widen_from, once=True))
    finally:
        db.close()


class GoldenEquality(unittest.TestCase):
    """The new reads return exactly what origin/main returned, in every supported combination."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-read-speed-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def assert_same(self, state, include_auth, since, include_database, widen_from, label, in_order=False):
        old = outcome(REFERENCE['_read_state'], state, include_auth, since, include_database, widen_from)
        new = read_once(self, state, include_auth, since, include_database, widen_from, label, in_order)
        self.assertEqual(old[0], 'ok', (label, old))
        self.assertEqual(frozen(new), frozen(old), label)
        self.assertEqual(sorted_json(new), sorted_json(old), label)
        return new[1]

    def test_every_read_combination_matches_origin_main(self):
        checked = 0
        for variant, (scenario, statements) in itertools.product(RECEIPT_VARIANTS, SCENARIOS.items()):
            state = self.root / (variant + '-' + scenario)
            build(state, variant)
            proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
            if statements: updater_base.mutate_state(state, *statements)
            widen = capture['schema']['columns']
            for include_auth, since, include_database, widen_from in itertools.product(
                    (False, True), (None, proof), (False, True), (None, widen)):
                label = (variant, scenario, include_auth, since is not None, include_database, widen_from is not None)
                with self.subTest(label=label):
                    rows, auth, carried, database = self.assert_same(
                        state, include_auth, since, include_database, widen_from, label)
                    checked += 1
                    if scenario == 'widened' and include_database and widen_from is not None:
                        self.assertIn('widened', database)
                    if since is not None:
                        self.assertIsInstance(carried, type(None) if scenario in NOTHING_CARRIED else dict)
            if scenario == 'edited-earlier-row':
                # The BLOB-to-hex-TEXT edit keeps the legacy prefix and still shows in the typed one.
                carried = update._read_state(state, False, proof, True)[2]
                self.assertEqual(carried['appendedRows']['orchestration_events'], 0)
                self.assertEqual(carried['logPrefix']['orchestration_events'],
                                 [proof['counts']['orchestration_events'], proof['hashes']['orchestration_events']])
                self.assertNotEqual(carried['typedLogPrefix']['orchestration_events'],
                                    capture['summary']['tables']['orchestration_events'])
        self.assertEqual(checked, len(RECEIPT_VARIANTS) * len(SCENARIOS) * 16)

    def test_a_declared_rowid_column_is_read_as_before(self):
        for variant in DECLARED_ROWID_VARIANTS:
            with self.subTest(variant=variant):
                state = self.root / variant
                build(state, variant)
                proof = update._read_state(state, False)[0]
                self.assertEqual(proof['appendOnlyActivity']['logRowids']['orchestration_v2_command_receipts'], 5)
                for appended in (0, 1):
                    if appended: updater_base.mutate_state(state, *CHECK)
                    carried = update._read_state(state, False, proof, True)[2]
                    # `WHERE rowid <= 5` skips the NULL row, so the prefix is not the whole table.
                    self.assertEqual(carried['appendedRows']['orchestration_v2_command_receipts'], 0)
                    self.assertEqual(carried['appendedRows']['orchestration_events'], appended)
                    self.assertEqual(carried['logPrefix']['orchestration_v2_command_receipts'][0], 2)
                    self.assertEqual(frozen(carried), frozen(REFERENCE['_read_state'](state, False, proof, True)[2]))

    def test_capture_matches_origin_main_with_and_without_a_visitor(self):
        state = self.root / 'capture'
        build(state, 'without-rowid')
        updater_base.mutate_state(state, *SCENARIOS['widened'])
        db = live_database.connect(state / 'statev2.sqlite')
        try:
            db.execute('BEGIN')
            columns = REFERENCE_CONTINUITY_MODULE.capture_connection(db)['schema']['columns']
            columns = {table: value[:-1] if table == 'projection_projects' else value for table, value in columns.items()}
            seen = []
            for widen_from in (None, columns):
                old = REFERENCE_CONTINUITY_MODULE.capture_connection(db, widen_from)
                self.assertEqual(frozen(continuity.capture_connection(db, widen_from)), frozen(old))
                visited = continuity.capture_connection(db, widen_from, visit=lambda table, rows: seen.append(table))
                self.assertEqual(frozen(visited), frozen(old))
            self.assertEqual(seen, list(old['summary']['tables']) * 2)
            self.assertIn('widened', old)
        finally:
            db.close()

    def test_capture_with_log_prefixes_is_unchanged_and_hashes_the_earlier_rows(self):
        state = self.root / 'prefixes'
        build(state, 'without-rowid')
        updater_base.mutate_state(state, *SCENARIOS['negative-rowid-and-appended'], *SCENARIOS['widened'])
        db = live_database.connect(state / 'statev2.sqlite')
        try:
            db.execute('BEGIN')
            logs = ('orchestration_events', 'orchestration_command_receipts', 'orchestration_v2_events')
            reference = REFERENCE_CONTINUITY_MODULE
            for widen_from, boundary in itertools.product((None, {'projection_projects': [[0, 'project_id', 'TEXT', 0, None, 1, 0]]}),
                                                         (-10, 0, 2, 3, 10 ** 6)):
                with self.subTest(widen=widen_from is not None, boundary=boundary):
                    old = reference.capture_connection(db, widen_from)
                    prefixes = {table: {'boundary': boundary} for table in logs}
                    visited = {}
                    new = continuity.capture_connection(db, widen_from, prefixes=prefixes,
                                                        visit=lambda table, rows: visited.setdefault(table, rows))
                    self.assertEqual(frozen(new), frozen(old))
                    for table in logs:
                        earlier = list(db.execute('SELECT * FROM ' + table + ' WHERE rowid <= ?', (boundary,)))
                        self.assertEqual(frozen(prefixes[table]), frozen({
                            'boundary': boundary,
                            'typed': {'count': len(earlier), 'sha256': reference.typed_rows_hash(earlier)},
                            'legacy': {'count': len(earlier), 'sha256': reference.legacy_rows_hash(earlier)}}))
                        # A visitor still gets the table's own rows, without the rowid.
                        self.assertEqual(sorted(map(repr, visited[table])),
                                         sorted(map(repr, db.execute('SELECT * FROM ' + table))))
        finally:
            db.close()

    def test_logs_longer_than_one_hash_chunk_match_origin_main(self):
        """The other fixtures' logs join to less than one continuity.joined_digest chunk."""
        state = self.root / 'long-logs'
        heavy(state, events=600, receipts=600)
        proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
        updater_base.mutate_state(state, *CHECK)
        db = sqlite3.connect(state / 'statev2.sqlite')
        try:
            for table in ('orchestration_events', 'orchestration_command_receipts'):
                joined = '\n'.join(continuity.legacy_line(row) for row in db.execute('SELECT * FROM ' + table))
                self.assertGreater(len(joined), 3 * CHUNK, table)
        finally:
            db.close()
        for include_auth, since, include_database, widen_from in itertools.product(
                (False, True), (None, proof), (False, True), (None, capture['schema']['columns'])):
            label = ('long-logs', include_auth, since is not None, include_database, widen_from is not None)
            with self.subTest(label=label):
                carried = self.assert_same(state, include_auth, since, include_database, widen_from, label)[2]
                if since is not None:
                    self.assertEqual(carried['appendedRows'], {'orchestration_events': 1, 'orchestration_command_receipts': 1})

    def test_a_since_without_a_valid_activity_matches_origin_main(self):
        """A since nothing can be carried from: written by an older helper without
        appendOnlyActivity, with corrupt log positions, or not a proof at all."""
        state = self.root / 'invalid-since'
        build(state, 'without-rowid')
        proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
        updater_base.mutate_state(state, *CHECK)
        def with_log_rowids(value):
            changed = copy.deepcopy(proof)
            changed[update.ACTIVITY_KEY]['logRowids'] = value
            return changed
        variants = {
            'without-activity': {key: value for key, value in proof.items() if key != update.ACTIVITY_KEY},
            'position-text': with_log_rowids({'orchestration_events': 'x'}),
            'position-real': with_log_rowids({'orchestration_events': 4.0}),
            'position-negative': with_log_rowids({'orchestration_events': -1}),
            'not-a-log': with_log_rowids({'projection_threads': 1}),
            'positions-not-a-dict': with_log_rowids([['orchestration_events', 1]]),
            'not-a-dict': ['not', 'a', 'proof'],
        }
        for (name, since), include_auth, include_database, widen_from in itertools.product(
                variants.items(), (False, True), (False, True), (None, capture['schema']['columns'])):
            label = (name, include_auth, include_database, widen_from is not None)
            with self.subTest(label=label):
                self.assertIsNone(self.assert_same(state, include_auth, since, include_database, widen_from, label)[2])

    def assert_same_after(self, state, proof, widen, name):
        """Every read of `state` with `proof` as the since equals origin/main's, the carried
        rows included, over all 8 combinations of auth, capture and widening."""
        results = []
        for include_auth, include_database, widen_from in itertools.product((False, True), (False, True), (None, widen)):
            label = (name, include_auth, include_database, widen_from is not None)
            with self.subTest(label=label):
                results.append(self.assert_same(state, include_auth, proof, include_database, widen_from, label))
        self.assertEqual(len(results), 8)
        return results

    def test_a_log_page_out_of_rowid_order_is_carried_as_origin_main_read_it(self):
        """`WHERE rowid <= boundary` reads the table b-tree from its first cell and stops at the
        first larger rowid, so on a leaf whose cells are out of rowid order (integrity_check:
        'Rowid 4 out of order') the earlier rows are that leading run, not every row at or
        below the boundary."""
        state = self.root / 'permuted-leaf'
        build(state, 'without-rowid')
        proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
        updater_base.mutate_state(state, *APPEND, *APPEND)
        permute_leaf(state, 'orchestration_v2_events', [4, 1, 2, 5, 3])
        db = sqlite3.connect(state / 'statev2.sqlite')
        try:
            self.assertIn('Rowid 4 out of order', ' '.join(row[0] for row in db.execute('PRAGMA integrity_check')))
        finally:
            db.close()
        for _, _, carried, _ in self.assert_same_after(state, proof, capture['schema']['columns'], 'permuted-leaf'):
            self.assertEqual(carried['logPrefix']['orchestration_v2_events'][0], 0)
            self.assertEqual(carried['typedLogPrefix']['orchestration_v2_events']['count'], 0)

    def test_a_log_with_a_stale_covering_index_is_carried_as_origin_main_read_it(self):
        """A log with an index holding every column: with sz hints that make the index the
        smaller read, a full scan reads the index while `WHERE rowid <= boundary` reads the
        table, so where the two disagree the earlier rows come from the table, as before."""
        state = self.root / 'covering-index'
        build(state, 'without-rowid')
        updater_base.mutate_state(state, 'CREATE INDEX events_everything ON orchestration_v2_events(thread_id, payload)',
                                  'ANALYZE', 'DELETE FROM sqlite_stat1',
                                  "INSERT INTO sqlite_stat1 VALUES ('orchestration_v2_events', NULL, '3 sz=20'), "
                                  "('orchestration_v2_events', 'events_everything', '3 1 1 sz=15')")
        proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
        updater_base.mutate_state(state, *APPEND, *APPEND)
        # The table's row 3 now holds 1.5 where the index still holds 1.25.
        rewrite_page_bytes(state, 'orchestration_v2_events', struct.pack('>d', 1.25), struct.pack('>d', 1.5))
        db = sqlite3.connect(state / 'statev2.sqlite')
        try:
            plan = db.execute('EXPLAIN QUERY PLAN SELECT rowid, * FROM orchestration_v2_events').fetchone()[3]
            self.assertEqual(db.execute('SELECT payload FROM orchestration_v2_events WHERE rowid <= 3').fetchall()[2], (1.5,))
        finally:
            db.close()
        # Equal to origin/main's read whichever b-tree this SQLite's planner scans.
        results = self.assert_same_after(state, proof, capture['schema']['columns'], 'covering-index')
        self.assertNotEqual(results[0][2]['logPrefix']['orchestration_v2_events'],
                            [proof['counts']['orchestration_v2_events'], proof['hashes']['orchestration_v2_events']])
        if 'COVERING INDEX events_everything' not in plan:
            # Homebrew's SQLite 3.53.1, like the fleet gate's runner, scans the table despite the sz
            # hints, where Apple's 3.54.0 and 3.45/3.46 builds take the index: both reads then see
            # the table, and no stale index is read.
            self.skipTest('SQLite %s plans %r, not the covering index this test needs'
                          % (sqlite3.sqlite_version, plan))


def table_root_page(state, table):
    """(file bytes, page size, offset of `table`'s root page), a leaf in these small fixtures."""
    path = state / 'statev2.sqlite'
    db = sqlite3.connect(path)
    try:
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'  # Every page is in the file.
        size = db.execute('PRAGMA page_size').fetchone()[0]
        root = db.execute("SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
    finally:
        db.close()
    data = bytearray(path.read_bytes())
    assert root > 1 and data[(root - 1) * size] == 0x0d  # A table leaf page.
    return data, size, (root - 1) * size


def permute_leaf(state, table, order):
    """Reorder the cell pointers of `table`'s leaf so its cells read in `order` (rowids, the
    cells' current order being rowid order)."""
    data, _, start = table_root_page(state, table)
    count = struct.unpack_from('>H', data, start + 3)[0]
    assert sorted(order) == list(range(1, count + 1))
    pointers = [data[start + 8 + 2 * index:start + 10 + 2 * index] for index in range(count)]
    data[start + 8:start + 8 + 2 * count] = b''.join(pointers[rowid - 1] for rowid in order)
    (state / 'statev2.sqlite').write_bytes(bytes(data))


def rewrite_page_bytes(state, table, old, new):
    """Replace the one occurrence of `old` in `table`'s leaf with `new` (same length), leaving
    every index as it was."""
    data, size, start = table_root_page(state, table)
    page = bytes(data[start:start + size])
    assert page.count(old) == 1 and len(old) == len(new)
    offset = start + page.index(old)
    data[offset:offset + len(old)] = new
    (state / 'statev2.sqlite').write_bytes(bytes(data))


class JoinedDigest(unittest.TestCase):
    """continuity.joined_digest is the sha256 of the joined text, at any length and chunk size."""

    def test_the_hash_of_the_joined_text_at_every_chunk_boundary(self):
        for length, alphabet in itertools.product((0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 7),
                                                  ('a row\n', 'ü☃😀\nx')):
            text = (alphabet * (length // len(alphabet) + 1))[:length]
            lines = text.split('\n')
            with self.subTest(length=length, alphabet=alphabet):
                self.assertEqual(len('\n'.join(lines)), length)
                self.assertEqual(continuity.joined_digest(lines), hashlib.sha256(text.encode()).hexdigest())

    def test_any_chunk_size_gives_the_same_hash(self):
        lines = ['ü☃😀', '', 'abc', 'x' * 10, '😀']
        expected = hashlib.sha256('\n'.join(lines).encode()).hexdigest()
        for size in (0, 1, 2, 3, 5, 7, 64):
            self.assertEqual(continuity.joined_digest(lines, size), expected, size)

    def test_update_joined_continues_a_hash_with_the_joined_text(self):
        """ThreadRows feeds each table's lines of a stream into that stream's running hash."""
        for lines in ([], [''], ['ü☃😀', '', 'abc'], ['x' * (2 * CHUNK + 3), 'y', 'z' * CHUNK]):
            with self.subTest(count=len(lines)):
                hasher = hashlib.sha256(b'prefix\n')
                continuity.update_joined(hasher, lines)
                self.assertEqual(hasher.hexdigest(), hashlib.sha256(('prefix\n' + '\n'.join(lines)).encode()).hexdigest())

    def test_runs_hold_about_size_characters_and_a_long_line_alone(self):
        lines, runs, sha256 = ['ab', 'cd', 'e' * 9, '', 'f', 'gh'], [], hashlib.sha256
        class Recorder:
            def __init__(self): self.real = sha256()
            def update(self, data): runs.append(data); self.real.update(data)
            def hexdigest(self): return self.real.hexdigest()
        with patch.object(continuity.hashlib, 'sha256', Recorder):
            value = continuity.joined_digest(lines, 4)
        self.assertEqual(value, hashlib.sha256('\n'.join(lines).encode()).hexdigest())
        self.assertEqual(runs, [b'ab\ncd', b'\n', b'eeeeeeeee', b'\n', b'\nf\ngh'])


SELECT_ALL = re.compile(r'^\s*SELECT (?:rowid, )?\* FROM "?([A-Za-z0-9_]+)"?\s*$')


@contextlib.contextmanager
def traced_reads():
    """Every statement the update reads run, from connections live_database.connect opens."""
    statements = []
    real = live_database.connect
    def connect(path, *args, **kwargs):
        connection = real(path, *args, **kwargs)
        connection.set_trace_callback(statements.append)
        return connection
    with patch.object(live_database, 'connect', side_effect=connect):
        yield statements


def whole_table_reads(statements):
    reads = {}
    for statement in statements:
        match = SELECT_ALL.match(statement)
        if match: reads[match.group(1)] = reads.get(match.group(1), 0) + 1
    return reads


def is_guarded(table):
    return table.startswith(('projection_', 'orchestration_', 'project_')) or table in update.AUTHORITY_TABLES


LIST_TABLES = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
# The schema text update.virtual_tables reads, the one statement origin/main did not run.
TABLE_TEXT = "SELECT name, CAST(sql AS BLOB) FROM sqlite_master WHERE type='table'"


def single_scan_reads(proof, capture):
    """Whole-table reads of a read with the capture: one each, the thread-keyed projections
    too, whose activity hashes come from that scan (update_read.ThreadRows)."""
    assert proof[update.ACTIVITY_KEY]['threadTables']
    return {table: 1 for table in capture['summary']['tables']}


class ReadCost(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-read-cost-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name)
        build(self.state, 'without-rowid')
        self.proof = update._read_state(self.state, False)[0]

    def test_busy_service_is_refused_before_any_table_is_read_in_full(self):
        updater_base.mutate_state(self.state, "INSERT INTO orchestration_v2_projection_runs VALUES ('r-busy','t-wait','running')")
        for include_database, since in itertools.product((False, True), (None, self.proof)):
            with self.subTest(include_database=include_database, since=since is not None):
                with traced_reads() as statements, \
                        self.assertRaisesRegex(AssertionError, '^Native work is not idle$'):
                    update._read_state(self.state, True, since, include_database)
                self.assertEqual(whole_table_reads(statements), {})
                self.assertTrue(any('orchestration_v2_projection_runs' in statement for statement in statements))
                # origin/main gave the same answer only after reading every guarded table.
                with traced_reads() as statements, \
                        self.assertRaisesRegex(AssertionError, '^Native work is not idle$'):
                    REFERENCE['_read_state'](self.state, True, since, include_database)
                self.assertTrue(any(is_guarded(table) for table in whole_table_reads(statements)))

    def test_an_unexpected_table_name_is_refused_before_any_row_is_read(self):
        updater_base.mutate_state(self.state, 'CREATE TABLE "Mixed_Case"(v)',
                                  "INSERT INTO orchestration_v2_projection_runs VALUES ('r-busy','t-wait','running')")
        for include_database in (False, True):
            with traced_reads() as statements, self.assertRaisesRegex(AssertionError, '^Unexpected table identifier$'):
                update._read_state(self.state, False, self.proof, include_database)
            self.assertEqual(whole_table_reads(statements), {})

    def test_each_table_is_read_once_by_the_capture_when_nothing_was_appended(self):
        with traced_reads() as statements:
            rows, _, carried, capture = update._read_state(self.state, False, self.proof, True)
        self.assertEqual(set(carried['appendedRows'].values()), {0})
        reads = whole_table_reads(statements)
        threads = rows[update.ACTIVITY_KEY]['threadTables']
        self.assertTrue(threads)
        self.assertEqual(reads, single_scan_reads(rows, capture))
        self.assertFalse([statement for statement in statements if 'WHERE rowid <=' in statement])
        with traced_reads() as statements:
            REFERENCE['_read_state'](self.state, False, self.proof, True)
        before = whole_table_reads(statements)
        # The cost this removes: guarded tables were hashed and captured, thread-keyed
        # projections read a third time for the activity, and logs rehashed below the boundary.
        self.assertEqual({table: before[table] for table in threads}, {table: 3 for table in threads})
        self.assertGreaterEqual(before['orchestration_events'], 2)
        self.assertGreater(sum(before.values()), sum(reads.values()))

    def test_appended_logs_are_read_once(self):
        updater_base.waiting_check(self.state, 'a')
        updater_base.mutate_state(self.state, *APPEND)
        with traced_reads() as statements:
            rows, _, carried, capture = update._read_state(self.state, False, self.proof, True)
        self.assertEqual(carried['appendedRows'], {'orchestration_events': 1, 'orchestration_command_receipts': 1,
                                                   'orchestration_v2_events': 1})
        self.assertEqual(whole_table_reads(statements), single_scan_reads(rows, capture))
        self.assertEqual([statement for statement in statements if 'WHERE rowid <=' in statement], [])
        logs = sorted(re.match(r'SELECT rowid, \* FROM "(\w+)"$', statement).group(1)
                      for statement in statements if statement.startswith('SELECT rowid, *'))
        self.assertEqual(logs, sorted(carried['appendedRows']))
        with traced_reads() as statements:
            old = REFERENCE['_read_state'](self.state, False, self.proof, True)
        self.assertEqual(frozen(old[2]), frozen(carried))
        self.assertEqual(sorted(re.match(r'SELECT \* FROM (\w+) WHERE rowid <=', statement).group(1)
                                for statement in statements if 'WHERE rowid <=' in statement),
                         sorted(carried['appendedRows']))  # The second scan this removes.

    def test_the_capture_is_still_bound_to_the_proof(self):
        for since in (None, self.proof):
            with self.subTest(since=since is not None), \
                    patch.object(continuity, 'bind_rows', wraps=continuity.bind_rows) as bind:
                proof, _, _, capture = update._read_state(self.state, False, since, True)
                bind.assert_called_once_with(capture, proof)

    def test_without_the_capture_reads_stay_as_they_were(self):
        """The same statements as origin/main's, and the schema text query (no virtual table)."""
        for since in (None, self.proof):
            with traced_reads() as statements:
                update._read_state(self.state, False, since, False)
            new = statements[:]
            with traced_reads() as statements:
                REFERENCE['_read_state'](self.state, False, since, False)
            self.assertEqual(sorted(new), sorted(statements + [TABLE_TEXT]))


def corrupt_leaf(state, table):
    """Overwrite the page type of `table`'s root page, a leaf in these small fixtures: reading
    the table fails with 'database disk image is malformed', and nothing else does."""
    path = state / 'statev2.sqlite'
    db = sqlite3.connect(path)
    try:
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'  # Every page is in the file.
        size = db.execute('PRAGMA page_size').fetchone()[0]
        root = db.execute("SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
    finally:
        db.close()
    data = bytearray(path.read_bytes())
    assert root > 1 and data[(root - 1) * size] == 0x0d  # A table leaf page.
    data[(root - 1) * size] = 0xff
    path.write_bytes(bytes(data))


def table_names(db):
    return [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]


# Run by another process while a read is open: a new project and a pending runtime request.
COMMIT_DURING_THE_SCAN = '\n'.join([
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    "db.execute(\"INSERT INTO projection_projects(project_id, title) VALUES ('p2', 'Committed during the scan')\")",
    "db.execute(\"INSERT INTO orchestration_v2_projection_runtime_requests(status) VALUES ('pending')\")",
    'db.commit()',
    'db.close()'])


class RefusalOrder(unittest.TestCase):
    """A database with two faults. The table names and the idle queries come before any row is
    read, so there the refusal differs from origin/main's (documented in _read_state and
    docs/studio/updates.md). After any other fault the single scan meets, origin/main's order
    runs again in the same transaction and its answer stands, unless SQLite has ended that
    transaction, whose fault then stands (documented too); an interrupt is not caught. A
    database with a virtual table is read in origin/main's order alone, so it is refused as
    origin/main refused it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-refusal-order-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name) / 'state'
        build(self.state, 'without-rowid')
        self.proof, _, _, self.capture = update._read_state(self.state, False, None, True)

    def outcomes(self, since, include_database, widen_from=None):
        args = (self.state, False, since, include_database, widen_from)
        return outcome(REFERENCE['_read_state'], *args), outcome(update._read_state, *args)

    def single_scan(self, since, widen_from=None):
        """What the single scan alone raises, without origin/main's order after it."""
        return single_scan_outcome(self.state, False, since, widen_from)

    def test_a_busy_database_with_a_corrupt_guarded_page_is_refused_as_busy(self):
        updater_base.mutate_state(self.state, "INSERT INTO orchestration_v2_projection_runs VALUES ('r-busy','t-wait','running')")
        corrupt_leaf(self.state, 'orchestration_events')
        for include_database, since in itertools.product((False, True), (None, self.proof)):
            with self.subTest(include_database=include_database, since=since is not None):
                old, new = self.outcomes(since, include_database)
                self.assertEqual(old, ('error', ('DatabaseError', 'database disk image is malformed')))
                self.assertEqual(new, ('error', ('AssertionError', 'Native work is not idle')))

    def test_an_unexpected_table_name_is_refused_before_an_undecodable_guarded_row(self):
        updater_base.mutate_state(self.state, "UPDATE orchestration_events SET payload_json=CAST(x'ff' AS TEXT) WHERE sequence=1",
                                  'CREATE TABLE "zz-unexpected"(v)')  # Sorted after every guarded table.
        for include_database, since in itertools.product((False, True), (None, self.proof)):
            with self.subTest(include_database=include_database, since=since is not None):
                old, new = self.outcomes(since, include_database)
                self.assertEqual((old[0], old[1][0]), ('error', 'OperationalError'))
                self.assertRegex(old[1][1], "^Could not decode to UTF-8 column 'payload_json'")
                self.assertEqual(new, ('error', ('AssertionError', 'Unexpected table identifier')))

    def test_a_null_project_id_is_refused_before_undecodable_unguarded_text(self):
        # origin/main sorts the project ids before its capture reaches the text.
        updater_base.mutate_state(self.state, "INSERT INTO projection_projects VALUES (NULL, 'no id')",
                                  "UPDATE checkpoint_diff_blobs SET body=CAST(x'ff' AS TEXT) WHERE id=1")
        for since in (None, self.proof):
            with self.subTest(since=since is not None):
                old, new = self.outcomes(since, True)
                self.assertEqual((old[0], old[1][0]), ('error', 'TypeError'))
                self.assertEqual(new, old)
                alone = self.single_scan(since)
                self.assertEqual((alone[0], alone[1][0]), ('error', 'OperationalError'))
                self.assertRegex(alone[1][1], "^Could not decode to UTF-8 column 'body'")

    def test_a_missing_thread_table_is_refused_before_an_unexpected_column_name(self):
        # origin/main reads the thread ids before its capture measures the widened table.
        updater_base.mutate_state(self.state, 'DROP TABLE projection_threads',
                                  'ALTER TABLE projection_projects ADD COLUMN "bad-name" TEXT')
        widen_from = self.capture['schema']['columns']
        for since in (None, self.proof):
            with self.subTest(since=since is not None):
                old, new = self.outcomes(since, True, widen_from)
                self.assertEqual(old, ('error', ('OperationalError', 'no such table: projection_threads')))
                self.assertEqual(new, old)
                self.assertEqual(self.single_scan(since, widen_from), ('error', ('AssertionError', 'Unexpected schema identifier')))

    def test_a_missing_idle_table_or_an_undecodable_idle_row_is_refused_before_a_guarded_row(self):
        # The idle queries now run before any guarded row is read (documented in _read_state
        # and docs/studio/updates.md).
        undecodable = "UPDATE orchestration_events SET payload_json=CAST(x'ff' AS TEXT) WHERE sequence=1"
        cases = {'missing-idle-table': ('DROP TABLE orchestration_v2_projection_runtime_requests',
                                        ('OperationalError', '^no such table: orchestration_v2_projection_runtime_requests$')),
                 'undecodable-run-status': ("UPDATE orchestration_v2_projection_runs SET status=CAST(x'ff' AS TEXT)",
                                            ('OperationalError', "^Could not decode to UTF-8 column 'status'"))}
        for name, (statement, (kind, message)) in cases.items():
            state = self.state.with_name(name)
            build(state, 'without-rowid')
            updater_base.mutate_state(state, statement, undecodable)
            for include_database, since in itertools.product((False, True), (None, self.proof)):
                with self.subTest(name=name, include_database=include_database, since=since is not None):
                    args = (state, False, since, include_database, None)
                    old, new = outcome(REFERENCE['_read_state'], *args), outcome(update._read_state, *args)
                    self.assertEqual((old[0], old[1][0]), ('error', 'OperationalError'))
                    self.assertRegex(old[1][1], "^Could not decode to UTF-8 column 'payload_json'")
                    self.assertEqual((new[0], new[1][0]), ('error', kind))
                    self.assertRegex(new[1][1], message)

    def test_a_fault_only_the_single_scan_meets_gives_origin_mains_answer(self):
        """In the same transaction, so from the snapshot the idle check judged: just before the
        fault another process commits a project and a pending request (WAL, beside a connection
        that keeps the log open as the service's does), and the answer is origin/main's for the
        snapshot before that commit. Also after a migration widened tables: origin/main's order
        measures them from the earlier capture's columns too. Any fault gives way to that
        answer, an assertion too."""
        real, real_tables = continuity.capture_connection, update_read._read_tables
        cases = [(self.state, include_auth, since, widen_from) for include_auth, since, widen_from in itertools.product(
            (False, True), (None, self.proof), (None, self.capture['schema']['columns']))]
        migrated = self.state.with_name('migrated')
        build(migrated, 'without-rowid')
        proof, _, _, capture = REFERENCE['_read_state'](migrated, False, None, True, None)
        updater_base.mutate_state(migrated, *SCENARIOS['widened'])
        cases += [(migrated, include_auth, since, capture['schema']['columns'])
                  for include_auth, since in itertools.product((False, True), (None, proof))]
        faults = (sqlite3.OperationalError('single scan only'), AssertionError('Unexpected schema identifier'))
        for index, ((state, include_auth, since, widen_from), fault) in enumerate(itertools.product(cases, faults)):
            with self.subTest(state=state.name, include_auth=include_auth, since=since is not None, widen=widen_from is not None,
                              fault=type(fault).__name__):
                case = self.state.with_name('fallback-%d' % index)
                case.mkdir()
                shutil.copyfile(state / 'statev2.sqlite', case / 'statev2.sqlite')
                args = (case, include_auth, since, True, widen_from)
                service = sqlite3.connect(case / 'statev2.sqlite')
                try:
                    self.assertEqual(service.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
                    service.execute('SELECT count(*) FROM sqlite_master').fetchone()  # Opens -wal and -shm.
                    self.assertTrue((case / 'statev2.sqlite-shm').exists())
                    expected = frozen(REFERENCE['_read_state'](*args))
                    committed = []
                    def single_scan_fails(db, widen_from=None, **kwargs):
                        if not kwargs: return real(db, widen_from)
                        writer = subprocess.run([sys.executable, '-I', '-c', COMMIT_DURING_THE_SCAN, str(case / 'statev2.sqlite')],
                                                capture_output=True, text=True, timeout=60)
                        committed.append((writer.returncode, writer.stderr))
                        raise fault
                    calls = []
                    def read_tables(db, *rest, **kwargs):
                        calls.append((kwargs, db, db.in_transaction))
                        return real_tables(db, *rest, **kwargs)
                    with patch.object(continuity, 'capture_connection', side_effect=single_scan_fails), \
                            patch.object(update_read, '_read_tables', side_effect=read_tables):
                        new = update._read_state(*args)
                    self.assertEqual(committed, [(0, '')])
                    # origin/main's order ran after it, on the same connection, still in its transaction.
                    self.assertEqual([kwargs for kwargs, _, _ in calls], [{'once': True}, {}])
                    self.assertIs(calls[1][1], calls[0][1])
                    self.assertTrue(calls[1][2])
                    self.assertEqual(new[0]['projectIds'], ['p1'])
                    self.assertEqual(frozen(new), expected)
                    if state == migrated:
                        self.assertEqual(sorted(new[3]['widened']), ['checkpoint_diff_blobs', 'projection_projects'])
                    # The commit landed: a read that starts now holds the pending request.
                    with self.assertRaisesRegex(AssertionError, '^Native work is not idle$'):
                        update._read_state(case, include_auth, since, True, widen_from)
                finally:
                    service.close()

    def failing_single_scan(self, fail, table=None):
        """continuity.capture_connection whose single scan (the call with a visitor) calls
        fail(db) once it has read `table`, or three tables; the original order's capture is the
        real one."""
        real, calls = continuity.capture_connection, []
        def capture(db, widen_from=None, **kwargs):
            calls.append(sorted(kwargs))
            if not kwargs:
                return real(db, widen_from)
            seen = []
            def visit(name, rows):
                kwargs['visit'](name, rows)
                seen.append(name)
                if name == table or (table is None and len(seen) == 3): fail(db)
            return real(db, widen_from, visit=visit, prefixes=kwargs['prefixes'])
        return calls, patch.object(continuity, 'capture_connection', side_effect=capture)

    def test_a_fault_that_ended_the_transaction_is_the_refusal(self):
        """SQLite may roll a read back itself on an I/O, disk-full or out-of-memory error. No
        snapshot is left to read in origin/main's order, so that fault is the refusal, raised
        without reading again, also where it meets a table the capture reads before a guarded
        table's own fault (documented in _read_state and docs/studio/updates.md): here
        aaa_unguarded, before an undecodable event, which origin/main, hashing the guarded
        tables first, refused for the same database."""
        updater_base.mutate_state(self.state, 'CREATE TABLE aaa_unguarded(v)', "INSERT INTO aaa_unguarded VALUES ('a')",
                                  "UPDATE orchestration_events SET payload_json=CAST(x'ff' AS TEXT) WHERE sequence=1")
        for include_auth, since, widen_from in itertools.product((False, True), (None, self.proof),
                                                                 (None, self.capture['schema']['columns'])):
            with self.subTest(include_auth=include_auth, since=since is not None, widen_from=widen_from is not None):
                old = outcome(REFERENCE['_read_state'], self.state, include_auth, since, True, widen_from)
                self.assertEqual((old[0], old[1][0]), ('error', 'OperationalError'))
                self.assertRegex(old[1][1], "^Could not decode to UTF-8 column 'payload_json'")
                with traced_reads() as statements:
                    def fail(db):
                        db.execute('ROLLBACK')
                        statements.append('-- rolled back')
                        raise sqlite3.OperationalError('disk I/O error')
                    calls, failing = self.failing_single_scan(fail, 'aaa_unguarded')
                    with failing:
                        new = outcome(update._read_state, self.state, include_auth, since, True, widen_from)
                self.assertEqual(new, ('error', ('OperationalError', 'disk I/O error')))
                self.assertEqual(calls, [['prefixes', 'visit']])
                self.assertEqual(whole_table_reads(statements), {'aaa_unguarded': 1})
                self.assertEqual(whole_table_reads(statements[statements.index('-- rolled back'):]), {})

    def test_an_interrupt_during_the_single_scan_is_not_caught(self):
        for since in (None, self.proof):
            with self.subTest(since=since is not None), traced_reads() as statements:
                def fail(db):
                    statements.append('-- interrupted')
                    raise KeyboardInterrupt
                calls, failing = self.failing_single_scan(fail)
                with failing, self.assertRaises(KeyboardInterrupt):
                    update._read_state(self.state, False, since, True)
                self.assertEqual(calls, [['prefixes', 'visit']])
                self.assertEqual(whole_table_reads(statements[statements.index('-- interrupted'):]), {})

    def test_a_read_that_succeeds_scans_once(self):
        for since in (None, self.proof):
            with self.subTest(since=since is not None), \
                    patch.object(update_read, '_read_tables', wraps=update_read._read_tables) as tables:
                update._read_state(self.state, False, since, True)
                self.assertEqual([call.kwargs for call in tables.call_args_list], [{'once': True}])


# About 1 KB of text a row, so the rows a read holds outweigh everything else it allocates.
PAYLOAD = '{"text":"' + 'x' * 1000 + '"}'
THREAD_KEYED = ('orchestration_v2_projection_messages2', 'projection_thread_activities',
                'projection_thread_messages', 'projection_thread_proposed_plans', 'projection_turns')


def heavy(state, projections=0, events=0, receipts=0, runs=0):
    """The waiting fixture with large thread-keyed projections, large logs or many finished runs."""
    updater_base.waiting_fixture(state)
    db = sqlite3.connect(state / 'statev2.sqlite')
    try:
        for table in THREAD_KEYED if projections else ():
            db.execute('CREATE TABLE %s(id INTEGER PRIMARY KEY, thread_id TEXT, body TEXT)' % table)
            db.executemany('INSERT INTO %s(thread_id, body) VALUES (?, ?)' % table,
                           (('t-%d' % (i % 50), PAYLOAD + str(i)) for i in range(projections)))
        db.executemany("INSERT INTO orchestration_events(event_id, stream_id, event_type, payload_json) "
                       "VALUES (?, ?, 'x', ?)", (('e%d' % i, 't-%d' % (i % 50), PAYLOAD + str(i)) for i in range(events)))
        db.executemany("INSERT INTO orchestration_command_receipts VALUES (?, ?, ?, 'accepted')",
                       (('c%d' % i + 'y' * 1000, 't-%d' % (i % 50), i) for i in range(receipts)))
        db.executemany("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, 'completed')",
                       (('r-%d' % i, 't-%d' % (i % 50)) for i in range(runs)))
        db.commit()
    finally:
        db.close()


def traced_peak(read, *args):
    """The most memory `read` held at once (tracemalloc), above what it started with, and what
    it returned."""
    gc.collect()
    tracemalloc.start()
    try:
        value = read(*args)
        return tracemalloc.get_traced_memory()[1], value
    finally:
        tracemalloc.stop()


class PeakMemory(unittest.TestCase):
    """The single scan keeps only the rows it hands over (auth_sessions and the projection
    cursors), hashes the thread-keyed projections per stream as it scans them, and lets each
    table's rows go before the next table is read, and the idle check's run statuses go before any of it:
    no read peaks more than 5% above origin/main's, and each gives origin/main's answer."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-peak-memory-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def assert_within_origin(self, state, since, include_database):
        args = (state, False, since, include_database)
        (old, expected), (new, value) = traced_peak(REFERENCE['_read_state'], *args), traced_peak(update._read_state, *args)
        self.assertLessEqual(new, old * 1.05, 'peak %d bytes, origin/main %d' % (new, old))
        self.assertEqual(frozen(value), frozen(expected))

    def warmed(self, state):
        """The proof of `state`, read once by each helper so module caches are not measured."""
        REFERENCE['_read_state'](state, False, None, True)
        return update._read_state(state, False, None, True)[0]

    def test_a_projection_heavy_read_peaks_within_five_percent_of_origin_main(self):
        state = self.root / 'projections'
        heavy(state, projections=1500)
        proof = self.warmed(state)
        for since, include_database in ((None, True), (proof, True), (proof, False)):
            with self.subTest(since=since is not None, include_database=include_database):
                self.assert_within_origin(state, since, include_database)

    def test_a_log_heavy_check_read_peaks_within_five_percent_of_origin_main(self):
        state = self.root / 'logs'
        heavy(state, events=3000, receipts=3000)
        proof = self.warmed(state)
        updater_base.mutate_state(state, *CHECK)
        for since in (None, proof):
            with self.subTest(since=since is not None):
                self.assert_within_origin(state, since, True)

    def test_two_large_adjacent_logs_peak_as_one_does(self):
        """The first log's rows are let go before the second is read and hashed."""
        peaks = {}
        for name, receipts in (('one', 0), ('two', 3000)):
            state = self.root / name
            heavy(state, events=3000, receipts=receipts)
            proof = self.warmed(state)
            updater_base.mutate_state(state, *CHECK)
            peaks[name] = traced_peak(update._read_state, state, False, proof, True)[0]
        self.assertLessEqual(peaks['two'], peaks['one'] * 1.1, peaks)

    def test_many_runs_read_without_the_capture_peak_within_five_percent_of_origin_main(self):
        """origin/main hashed the guarded tables before it read the run statuses; here those
        statuses are read first, and let go before the first guarded table is hashed."""
        state = self.root / 'runs'
        heavy(state, events=2000, runs=20000)
        proof = self.warmed(state)
        for since in (None, proof):
            with self.subTest(since=since is not None):
                self.assert_within_origin(state, since, False)


# Thread-keyed projections whose names sort around projection_threads, one a prefix of others
# ('"' sorts before '_' and 's'), rows of one stream in several tables, the same row in two
# tables, streams keyed by text, an integer, a real, a BLOB and NULL, a project-keyed table and
# an empty one.
PROJECTIONS = [
    'CREATE TABLE projection_thread(thread_id, v)',
    'CREATE TABLE projection_thread_items(thread_id TEXT, v)',
    'CREATE TABLE projection_threadx(thread_id, v)',
    'CREATE TABLE orchestration_v2_projection_steps(project_id TEXT, thread_id TEXT, v)',
    'CREATE TABLE projection_board(project_id TEXT, v)',
    'CREATE TABLE projection_unused(thread_id TEXT)',
    "INSERT INTO projection_thread VALUES ('t-wait', 'a'), ('t-wait', 'a'), (7, x'00'), (NULL, 1), (2.5, 'r')",
    "INSERT INTO projection_thread_items VALUES ('t-wait', 'a'), ('t-idle', 'b'), (x'01', 'c'), ('t-wait', '')",
    "INSERT INTO projection_threadx VALUES ('t-wait', 'z'), (7, 7), ('t-new', NULL)",
    "INSERT INTO orchestration_v2_projection_steps VALUES ('p1', 't-wait', 1), ('p1', NULL, 2), ('p2', 't-idle', 3)",
    "INSERT INTO projection_board VALUES ('p1', 'x'), ('p1', 'x'), (NULL, 'y')",
]


class ProjectionsReadOnce(unittest.TestCase):
    """The thread-keyed projections are hashed from the capture's one scan (ThreadRows): every
    proof, auth, carried and capture field equals origin/main's and this release's own read in
    the original order, and the row hashes equal the hash of the joined, encoded lines."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-projections-once-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def original_order(self, state, include_auth, since, widen_from):
        db = live_database.connect(state / 'statev2.sqlite')
        try:
            db.execute('BEGIN')
            return outcome(lambda: update_read._read_tables(db, table_names(db), include_auth, since, True, widen_from))
        finally:
            db.close()

    def test_every_field_matches_origin_main_and_the_original_order(self):
        checked = 0
        for variant in ('without-rowid', 'rowid-column'):
            state = self.root / variant
            build(state, variant)
            updater_base.mutate_state(state, *PROJECTIONS)
            proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
            threads = proof[update.ACTIVITY_KEY]['threadSha256']
            self.assertIn('#7', threads)
            self.assertIn('#null', threads)
            updater_base.mutate_state(state, *CHECK, *APPEND, "INSERT INTO projection_thread_items VALUES ('t-new', 'd')",
                                      "UPDATE projection_threadx SET v='y' WHERE thread_id='t-wait'")
            for include_auth, since, widen_from in itertools.product((False, True), (None, proof),
                                                                     (None, capture['schema']['columns'])):
                label = (variant, include_auth, since is not None, widen_from is not None)
                with self.subTest(label=label), traced_reads() as statements:
                    old = outcome(REFERENCE['_read_state'], state, include_auth, since, True, widen_from)
                    del statements[:]
                    new = read_once(self, state, include_auth, since, True, widen_from, label)
                    reads = whole_table_reads(statements)
                    self.assertEqual(old[0], 'ok', old)
                    self.assertEqual(frozen(new), frozen(old))
                    self.assertEqual(sorted_json(new), sorted_json(old))
                    self.assertEqual(frozen(self.original_order(state, include_auth, since, widen_from)), frozen(new))
                    activity = new[1][0][update.ACTIVITY_KEY]
                    self.assertLessEqual({'orchestration_v2_projection_steps', 'projection_board', 'projection_thread',
                                          'projection_thread_items', 'projection_threadx', 'projection_unused'},
                                         set(activity['threadTables']))
                    self.assertEqual({table: reads.get(table) for table in activity['threadTables']},
                                     dict.fromkeys(activity['threadTables'], 1))
                    checked += 1
        self.assertEqual(checked, 16)

    def test_streams_hash_as_origin_main_over_random_tables_and_keys(self):
        """Seeded: table names that are prefixes of others or differ in a digit or '_', several
        stream columns, mixed key types and rows longer than a run hash as origin/main's own read."""
        rnd, checked = random.Random(1074), 0
        for trial in range(120):
            db = sqlite3.connect(':memory:')
            try:
                names = set()
                while len(names) < rnd.randint(1, 7):
                    names.add(rnd.choice(('projection_', 'x_projection_', 'orchestration_v2_projection_', 'other_'))
                              + ''.join(rnd.choice('a0_z9') for _ in range(rnd.randint(0, 3))))
                for name in sorted(names):
                    db.execute('CREATE TABLE %s(%s, w)' % (name, rnd.choice(('thread_id', 'project_id', 'v'))))
                    db.executemany('INSERT INTO %s VALUES (?, ?)' % name, [
                        (rnd.choice(('t1', 't1_', '', None, 3, 2.5, b'\x00', '#3', '\u00fc')),
                         rnd.choice(('a', '', None, 1, b'', '"', 'x' * rnd.choice((5, CHUNK + 7)))))
                        for _ in range(rnd.randint(0, 10))])
                db.commit()
                tables = table_names(db)
                threads = update_read.ThreadRows(db)
                for name in tables:
                    threads.visit(name, list(db.execute('SELECT * FROM ' + name)))
                self.assertEqual(update_read.append_only_activity(db, tables, {}, threads),
                                 REFERENCE['append_only_activity'](db, tables), (trial, tables))
                checked += bool(threads.tables)
            finally:
                db.close()
        self.assertGreater(checked, 60)

    def test_a_visit_out_of_name_order_is_refused_and_the_original_order_answers(self):
        state = self.root / 'out-of-order'
        build(state, 'without-rowid')
        updater_base.mutate_state(state, *PROJECTIONS)
        db = live_database.connect(state / 'statev2.sqlite')
        try:
            rows = update_read.ThreadRows(db)
            rows.visit('projection_threadx', [])
            with self.assertRaisesRegex(AssertionError, '^Tables visited out of name order$'):
                rows.visit('projection_thread', [])
        finally:
            db.close()
        real = continuity.capture_connection
        def reversed_visits(db, widen_from=None, **kwargs):
            if not kwargs: return real(db, widen_from)
            seen = []
            capture = real(db, widen_from, visit=lambda table, rows: seen.append((table, rows)), prefixes=kwargs['prefixes'])
            for table, rows in reversed(seen): kwargs['visit'](table, rows)
            return capture
        expected = frozen(REFERENCE['_read_state'](state, False, None, True))
        with patch.object(continuity, 'capture_connection', side_effect=reversed_visits), \
                patch.object(update_read, '_read_tables', wraps=update_read._read_tables) as tables:
            self.assertEqual(frozen(update._read_state(state, False, None, True)), expected)
        self.assertEqual([call.kwargs for call in tables.call_args_list], [{'once': True}, {}])

    def test_a_projection_heavy_read_peaks_well_below_origin_main(self):
        """origin/main held every thread-keyed projection's lines at once, after the capture
        had held its rows, its lines, their joined text and that text encoded."""
        state = self.root / 'projections'
        heavy(state, projections=1500)
        proof = update._read_state(state, False, None, True)[0]
        REFERENCE['_read_state'](state, False, None, True)
        for since in (None, proof):
            with self.subTest(since=since is not None):
                (old, expected), (new, value) = (traced_peak(REFERENCE['_read_state'], state, False, since, True),
                                                 traced_peak(update._read_state, state, False, since, True))
                self.assertLess(new, old * 0.7, 'peak %d bytes, origin/main %d' % (new, old))
                self.assertEqual(frozen(value), frozen(expected))

    def test_row_hashes_match_the_joined_text_and_peak_below_origin_main(self):
        reference = REFERENCE_CONTINUITY_MODULE
        tables = {'empty': [], 'one-empty-text': [('',)], 'typed': [(None,), (1,), (1.0,), ('ü☃😀',), (b'\x00',), (b'',)],
                  'long': [(index, 'x' * 1000 + str(index)) for index in range(4000)],
                  'one-long-row': [('y' * (3 * CHUNK),), ('a',), ('z' * CHUNK,)]}
        for name, rows in tables.items():
            with self.subTest(name=name):
                typed, legacy = sorted(map(continuity.typed_line, rows)), sorted(map(continuity.legacy_line, rows))
                self.assertEqual(continuity.typed_rows_hash(rows), hashlib.sha256('\n'.join(typed).encode()).hexdigest())
                self.assertEqual(continuity.legacy_rows_hash(rows), hashlib.sha256('\n'.join(legacy).encode()).hexdigest())
                self.assertEqual(continuity.typed_rows_hash(rows), reference.typed_rows_hash(rows))
                self.assertEqual(continuity.legacy_rows_hash(rows), reference.legacy_rows_hash(rows))
        rows = tables['long']
        for new, old in ((continuity.typed_rows_hash, reference.typed_rows_hash),
                         (continuity.legacy_rows_hash, reference.legacy_rows_hash)):
            with self.subTest(hash=new.__name__):
                (old_peak, expected), (new_peak, value) = traced_peak(old, rows), traced_peak(new, rows)
                self.assertEqual(value, expected)
                # origin/main held the joined text and its encoded copy; now one run at a time.
                self.assertLess(new_peak, old_peak * 0.7, (new_peak, old_peak))


class IdleSnapshot(unittest.TestCase):
    def test_idle_is_judged_in_the_read_transaction(self):
        """A run that completes after the read's snapshot was taken is still running for the
        rows that read hashes, so the read is refused (with a second connection it was not)."""
        with tempfile.TemporaryDirectory(prefix='studio-update-idle-snapshot-') as temp:
            state = pathlib.Path(temp)
            build(state, 'without-rowid')
            service = sqlite3.connect(state / 'statev2.sqlite')
            try:
                self.assertEqual(service.execute('PRAGMA journal_mode=WAL').fetchone()[0], 'wal')
                real = update_read.run_work
                for include_database in (False, True):
                    with self.subTest(include_database=include_database):
                        service.execute("INSERT OR REPLACE INTO orchestration_v2_projection_runs VALUES ('r-busy','t-wait','running')")
                        service.commit()
                        completed = []
                        def completes_first(db):
                            service.execute("UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='r-busy'")
                            service.commit()
                            completed.append(True)
                            return real(db)
                        with patch.object(update_read, 'run_work', side_effect=completes_first), \
                                self.assertRaisesRegex(AssertionError, '^Native work is not idle$'):
                            update._read_state(state, False, None, include_database)
                        self.assertEqual(completed, [True])
                        # The next read starts after the run completed, and is idle.
                        self.assertTrue(update._read_state(state, False, None, include_database)[0]['nativeWorkIdle'])
            finally:
                service.close()


if __name__ == '__main__':
    unittest.main()
