#!/usr/bin/env python3
"""after_proof: the page proof after the restart must equal the full read byte for byte, or refuse.

Each test builds a small WAL database from scratch with the real statev2 table names and shapes
(log rows with overflow-sized payloads, a projection keyed by thread large enough to be kept),
runs the old service as a child process that keeps one connection open, takes the read before the
restart (with its lines kept), marks the old log, stops that service, clones its files as
update.py does (state_backup.clone_state), starts the new service as another child process and has
it commit what a starting release writes. The page proof then either returns exactly what
update_read._read_state returns for the same moment, or None.

    python3 -B test-after-proof.py
    /usr/bin/python3 -B test-after-proof.py --measure ~/.specwithcode/m4/scratch/fast-install-profile/clone

--measure clones the given clone folder's statev2.sqlite with `cp -c` into a sibling folder, keeps
it open in a writer that appends 30 events and 10 receipts and updates a session, then times the
full read with kept lines on the given clone, the page proof on the copy and a full read of the
copy, checks the proof equals that full read and deletes the copy. The given clone is only read.
"""
import contextlib
import datetime
import json
import os
import pathlib
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import after_proof
import database_continuity as continuity
import kept_lines
import live_database
import read_watermark
import state_backup
import update
import update_compare
import update_read

WRITER = r"""
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None, timeout=30)
db.execute('PRAGMA journal_mode=WAL')
print('ready', flush=True)
for line in sys.stdin:
    try:
        if line.startswith('checkpoint '):
            print('ok %r' % (db.execute('PRAGMA wal_checkpoint(%s)' % line.split()[1]).fetchall(),), flush=True)
            continue
        db.execute('BEGIN IMMEDIATE')
        for sql, parameters in json.loads(line):
            db.execute(sql, parameters).fetchall()
        db.execute('COMMIT')
        print('ok', flush=True)
    except Exception as error:
        if db.in_transaction:
            db.execute('ROLLBACK')
        print('error %s' % error, flush=True)
"""

# The tables update_read reads by name, as statev2 declares them (October 2026), and a few others.
SCHEMA = """
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
  command_id TEXT, causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL, application_event_version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX idx_orch_events_stream_version ON orchestration_events(aggregate_kind, stream_id, stream_version);
CREATE INDEX idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind, stream_id, sequence);
CREATE INDEX idx_orch_events_command_id ON orchestration_events(command_id);
CREATE TABLE orchestration_command_receipts (
  command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL, accepted_at TEXT NOT NULL,
  result_sequence INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, command_type TEXT NOT NULL DEFAULT 'legacy');
CREATE INDEX idx_orch_command_receipts_aggregate ON orchestration_command_receipts(aggregate_kind, aggregate_id);
CREATE INDEX idx_orch_command_receipts_sequence ON orchestration_command_receipts(result_sequence);
CREATE TABLE orchestration_v2_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, command_id TEXT, thread_id TEXT NOT NULL,
  run_id TEXT, node_id TEXT, provider TEXT, raw_event_id TEXT, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT);
CREATE INDEX orchestration_v2_events_thread_sequence_idx ON orchestration_v2_events(thread_id, sequence);
CREATE TABLE orchestration_v2_command_receipts (
  command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, command_type TEXT NOT NULL, accepted_at TEXT NOT NULL,
  result_sequence INTEGER NOT NULL, status TEXT NOT NULL, error TEXT);
CREATE TABLE auth_sessions (
  session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL, method TEXT NOT NULL, client_label TEXT,
  client_ip_address TEXT, client_user_agent TEXT, client_device_type TEXT NOT NULL DEFAULT 'unknown', client_os TEXT,
  client_browser TEXT, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_connected_at TEXT, revoked_at TEXT,
  client_surface TEXT, client_app_version TEXT);
CREATE INDEX idx_auth_sessions_active ON auth_sessions(revoked_at, expires_at, issued_at);
CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY, credential TEXT);
CREATE TABLE projection_projects (
  project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE projection_state (projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL,
  runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_turn_items (
  turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT,
  provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx
  ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id);
CREATE TABLE orchestration_v2_projection_nodes (
  node_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, parent_node_id TEXT, root_node_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX orchestration_v2_projection_nodes_thread_run_idx ON orchestration_v2_projection_nodes(thread_id, run_id);
CREATE TABLE orchestration_v2_projection_runs (
  run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL,
  provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL,
  provider_instance_id TEXT);
CREATE UNIQUE INDEX orchestration_v2_projection_runs_thread_ordinal_idx ON orchestration_v2_projection_runs(thread_id, ordinal);
CREATE TABLE orchestration_v2_projection_runtime_requests (
  runtime_request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE "orchestration_v2_effect_outbox" (
  effect_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, thread_id TEXT NOT NULL, effect_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_provider_sessions (
  provider_session_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT NOT NULL, status TEXT NOT NULL,
  updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_metadata (
  projection_name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, last_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, cron TEXT);
CREATE TABLE checkpoint_diff_blobs (id INTEGER PRIMARY KEY, body BLOB);
CREATE TABLE pull_request_files_viewed (thread_id TEXT, path TEXT, viewed_at TEXT, PRIMARY KEY (thread_id, path)) WITHOUT ROWID;
"""
THREADS = ['t-%d' % index for index in range(1, 7)]
NOW = '2026-10-22T14:00:00Z'


def text(rng, low, high):
    """A JSON-ish string of a random length: overflow pages above about 4 KB."""
    return json.dumps({'body': ''.join(rng.choice('abcdefghijklmnopqrstuvwxyz ') for _ in range(rng.randrange(low, high)))})


def event(rng, label, stream, version, low=200, high=20000):
    return ("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,"
            "command_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,?,?,?,?,?,?,?,?,?,2)",
            ['event-' + label, 'project' if stream.startswith('p') else 'thread', stream, version, 'thread.activity-appended',
             NOW, 'command-' + label, 'server', text(rng, low, high), '{}'])


def receipt(label, sequence):
    return ("INSERT INTO orchestration_command_receipts VALUES (?,?,?,?,?,?,NULL,'thread.activity.append')",
            ['command-' + label, 'thread', 't-1', NOW, sequence, 'accepted'])


def turn_item(rng, label, thread, ordinal, low=300, high=9000):
    return ("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,NULL,NULL,NULL,NULL,?,?,?,?,?)",
            ['item-' + label, thread, 'run-' + thread, ordinal, 'agent_message', 'completed', NOW, text(rng, low, high)])


def build(state, events=160, items=220, sessions=3):
    """The database before the update, in WAL mode."""
    state.mkdir(parents=True, exist_ok=True)
    rng = random.Random(993)
    db = sqlite3.connect(str(state / 'statev2.sqlite'))
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript(SCHEMA)
    for project in ('p1', 'p2'):
        db.execute('INSERT INTO projection_projects VALUES (?,?,?,?,?,?,NULL)', (project, 'Project ' + project, '/work/' + project, '{}', NOW, NOW))
    for index, thread in enumerate(THREADS):
        project = 'p1' if index % 2 == 0 else 'p2'
        db.execute('INSERT INTO projection_threads VALUES (?,?,?,?,?,NULL)', (thread, project, 'Thread ' + thread, NOW, NOW))
        db.execute("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,'codex','full-access','default',NULL,?,?,NULL,NULL,?,NULL)",
                   (thread, project, 'Thread ' + thread, NOW, NOW, text(rng, 50, 400)))
        db.execute("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,1,'codex',NULL,'completed',?,?,'{}',NULL)",
                   ('run-' + thread, thread, NOW, NOW))
        db.execute("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?,?,'codex','stopped',?,'{}')",
                   ('session-' + thread, thread, NOW))
    for index in range(events):
        stream = rng.choice(THREADS + ['p1'])
        sql, parameters = event(rng, 'old-%d' % index, stream, index)
        sequence = db.execute(sql, parameters).lastrowid
        sql, parameters = receipt('old-%d' % index, sequence)
        db.execute(sql, parameters)
    db.execute("INSERT INTO orchestration_v2_events(event_id,thread_id,event_type,occurred_at,payload_json) VALUES ('v2-1','t-1','x',?,'{}')", (NOW,))
    for index in range(items):
        sql, parameters = turn_item(rng, 'old-%d' % index, THREADS[index % 4], index)
        db.execute(sql, parameters)
        if index % 3 == 0:
            db.execute("INSERT INTO orchestration_v2_projection_nodes VALUES (?,?,?,NULL,?,'agent','completed',?)",
                       ('node-%d' % index, THREADS[index % 4], 'run-' + THREADS[index % 4], 'node-0', text(rng, 100, 3000)))
    for index in range(sessions):
        db.execute("INSERT INTO auth_sessions(session_id,subject,scopes,method,issued_at,expires_at,last_connected_at,client_surface) "
                   "VALUES (?,'owner','operate','browser-session-cookie',?,?,?,'web')",
                   ('session-%d' % index, '2026-10-21T00:00:00Z', '2026-10-30T00:00:00Z', '2026-10-22T13:00:00Z'))
    db.execute("INSERT INTO auth_pairing_links VALUES ('grant','synthetic-private-credential')")
    db.execute("INSERT INTO scheduled_tasks VALUES ('nightly','0 3 * * *')")
    db.execute("INSERT INTO orchestration_v2_projection_metadata VALUES ('thread-projections',2,?,?)", (events, NOW))
    db.execute("INSERT INTO projection_state VALUES ('threads',?,?)", (events, NOW))
    db.executemany('INSERT INTO checkpoint_diff_blobs(body) VALUES (?)', [(os.urandom(9000),) for _ in range(6)])
    db.execute("INSERT INTO pull_request_files_viewed VALUES ('t-1','src/a.ts',?)", (NOW,))
    db.commit()
    db.close()


def startup_writes(rng, label='new', events=30, receipts=10):
    """What a starting release commits: events and receipts appended, a session heartbeat, the
    projection cursors, a thread's projection rows, a project row and turn items."""
    statements, batches = [], []
    for index in range(events):
        statements.append(event(rng, '%s-%d' % (label, index), rng.choice(['t-1', 't-2', 'p1']), 1000 + index))
    batches.append(statements)
    statements = [("INSERT INTO orchestration_command_receipts VALUES (?,?,?,?,(SELECT max(sequence) FROM orchestration_events),"
                   "'accepted',NULL,'thread.activity.append')", ['command-%s-receipt-%d' % (label, index), 'thread', 't-1', NOW])
                  for index in range(receipts)]
    statements += [
        ('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', ['2026-10-22T14:05:00Z', 'session-0']),
        ('UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT max(sequence) FROM orchestration_events), updated_at=?', [NOW]),
        ('UPDATE projection_state SET last_applied_sequence=(SELECT max(sequence) FROM orchestration_events), updated_at=?', [NOW]),
        ("UPDATE orchestration_v2_projection_threads SET updated_at=?, payload_json=? WHERE thread_id='t-1'", ['2026-10-22T14:06:00Z', text(rng, 50, 400)]),
        ("UPDATE projection_projects SET updated_at=? WHERE project_id='p1'", ['2026-10-22T14:06:00Z']),
        ("UPDATE orchestration_v2_projection_turn_items SET status='interrupted', payload_json=? WHERE turn_item_id='item-old-5'", [text(rng, 300, 9000)]),
        turn_item(rng, '%s-item' % label, 't-2', 5000),
        ("INSERT INTO orchestration_v2_projection_nodes VALUES (?,'t-2','run-t-2',NULL,'node-0','agent','running',?)",
         ['node-%s' % label, text(rng, 100, 3000)]),
    ]
    batches.append(statements)
    return batches


class Writer:
    """A service in its own process: one WAL connection, open until closed or killed."""

    def __init__(self, database):
        self.process = subprocess.Popen([sys.executable, '-c', WRITER, str(database)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)
        assert self.process.stdout.readline().strip() == 'ready'

    def commit(self, *statements):
        self.process.stdin.write(json.dumps([[sql, list(parameters)] for sql, parameters in statements]) + '\n')
        self.process.stdin.flush()
        answer = self.process.stdout.readline().strip()
        assert answer == 'ok', answer

    def checkpoint(self, mode):
        self.process.stdin.write('checkpoint %s\n' % mode)
        self.process.stdin.flush()
        answer = self.process.stdout.readline().strip()
        assert answer.startswith('ok [(0,'), answer

    def heartbeat(self, session='session-1', moment='2026-10-22T14:01:00Z'):
        self.commit(('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', [moment, session]))

    def close(self):
        """The service's last connection closes: SQLite folds the log in and removes it."""
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=30)
        self.process.stdout.close()

    def kill(self):
        """A stop that leaves the log behind, as an exit without closing the database does."""
        self.process.kill()
        self.process.wait(timeout=30)
        self.process.stdin.close()
        self.process.stdout.close()


def encoded(value):
    return continuity.encoded(value)


class Update:
    """update.py's steps around the restart, on a fixture database."""

    def __init__(self, test, include_auth=False, since_expected=True, watermark=False, **shape):
        self.test, self.include_auth = test, include_auth
        folder = tempfile.TemporaryDirectory(prefix='studio-after-proof-')
        test.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name).resolve()
        self.state = self.root / 'own' / 'userdata'
        self.database = self.state / 'statev2.sqlite'
        build(self.state, **shape)
        self.old = Writer(self.database)
        test.addCleanup(self.old.close)
        self.old.heartbeat(moment='2026-10-22T13:59:00Z')  # A running service's log has frames in it.
        expected = update_read._read_state(self.state, False, None, True)[0] if since_expected else None
        with after_proof.keeping(self.database) as self.kept:
            before = update_read._read_state(self.state, include_auth, expected, True)
        self.before = before[0]
        self.reference = {'position': None, 'since': self.before, 'reads': (before[0], None, before[3])}
        self.watermark = read_watermark.Watermark.open(self.database) if watermark else None
        if self.watermark is not None:
            test.addCleanup(self.watermark.close)
            self.watermark.take()
        self.new = None

    def mark(self):
        self.marked = after_proof.mark(self.database)
        return self.marked

    def stop(self, how='close'):
        if self.watermark is not None:
            self.watermark.close()
        getattr(self.old, how)()

    def clone(self, method=None):
        target = self.root / 'backups' / 'pre-test'
        target.mkdir(parents=True)
        with patch.object(state_backup, 'backup_folder', return_value=target):
            backup, actual = state_backup.clone_state(self.state.parent, 'abc', update._clonefile())
        self.test.assertEqual(actual, 'clone', 'This volume cannot clone; the proof needs an APFS clone')
        self.held = after_proof.stopped(self.marked, backup, method or actual)
        return self.held

    def restart(self, rng=None, writes=True):
        self.new = Writer(self.database)
        self.test.addCleanup(self.new.close)
        if writes:
            for batch in startup_writes(rng or random.Random(7)):
                self.new.commit(*batch)
        return self.new

    def around_restart(self, stop='close', **restart):
        self.mark()
        self.stop(stop)
        self.clone()
        return self.restart(**restart)

    def prove(self):
        return after_proof.prove(self.state, self.held, self.kept, self.reference, self.before, self.include_auth)

    def decide(self):
        progress, laps = {}, []
        reads = after_proof.decide(self.state, self.held, self.kept, self.reference, self.before, self.include_auth,
                                   progress, laps.append)
        return reads, progress['afterProof'], laps

    def full(self):
        return update_read._read_state(self.state, self.include_auth, self.before, True)


def receipt_fields(before, reads):
    """What update.py derives from the read after the restart for a non-migration update."""
    rows, _, carried, capture = reads
    guarded = update_compare.same_guarded_rows(before['rows'], rows, carried, auth_heartbeat=False)
    try:
        update_compare.assert_capture_carried(before['capture'], capture, before['rows'], rows, carried, auth_heartbeat=False)
        continuity_result = 'verified'
    except AssertionError as error:
        continuity_result = str(error)
    return {'rowsByteIdentical': before['rows'] == rows, 'sameGuardedRows': guarded,
            'appendedLogRows': carried['appendedRows'] if carried else None, 'completeDatabaseContinuity': continuity_result}


class Equal(unittest.TestCase):
    """Whenever the proof decides, it is the full read of the same moment."""

    def setUp(self):
        patcher = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        patcher.start()
        self.addCleanup(patcher.stop)

    def assert_same(self, flow, expect_mode='pages'):
        reads, record, laps = flow.decide()
        full = flow.full()
        self.assertEqual(record['mode'], expect_mode, record)
        self.assertEqual(laps, ['pageProof'])
        self.assertIsNotNone(reads)
        self.assertEqual(encoded(reads[0]), encoded(full[0]))
        self.assertEqual(encoded(reads[2]), encoded(full[2]))
        self.assertEqual(encoded(reads[3]), encoded(full[3]))
        self.assertEqual(json.dumps(reads[0]), json.dumps(full[0]))  # Key order too: receipts are JSON.
        self.assertEqual(json.dumps(reads[2]), json.dumps(full[2]))
        self.assertEqual(json.dumps(reads[3]), json.dumps(full[3]))
        self.assertEqual(reads[1], full[1])
        before = {'rows': flow.before, 'capture': flow.reference['reads'][2]}
        self.assertEqual(receipt_fields(before, reads), receipt_fields(before, full))
        self.assertEqual(flow.kept.tables, {})  # Let go once the proof ran.
        return record

    def test_startup_writes_decide_by_pages_and_equal_the_full_read(self):
        flow = Update(self)
        flow.around_restart()
        record = self.assert_same(flow)
        self.assertIn('orchestration_events', record['touchedTables'])
        self.assertIn('auth_sessions', record['touchedTables'])
        self.assertNotIn('scheduled_tasks', record['touchedTables'])
        self.assertGreater(record['changedPages'], 0)
        self.assertEqual(record['mainPagesExplained'], 0)
        self.assertGreater(record['leavesVerified'], 0)
        rows = flow.full()[2]
        self.assertEqual(rows['appendedRows']['orchestration_events'], 30)
        self.assertEqual(rows['appendedRows']['orchestration_command_receipts'], 10)

    def test_kept_projection_tables_are_compared_row_by_row(self):
        with patch.object(kept_lines, 'KEEP_BYTES', 64 << 10):
            flow = Update(self)
        self.assertIn('orchestration_v2_projection_turn_items', flow.kept.tables)
        flow.around_restart()
        self.assert_same(flow)

    def test_with_auth_cells_and_without_an_earlier_since(self):
        flow = Update(self, include_auth=True, since_expected=False)
        flow.around_restart()
        self.assert_same(flow)

    def test_the_published_frame_comes_from_the_index_when_the_watermark_holds_it(self):
        flow = Update(self, watermark=True)
        marked = flow.mark()
        self.assertGreater(marked['published'], 0)
        flow.stop()
        flow.clone()
        flow.restart()
        self.assert_same(flow)

    def test_a_heartbeat_between_the_final_check_and_the_stop_is_read_again(self):
        flow = Update(self)
        flow.mark()
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.stop()
        held = flow.clone()
        self.assertTrue(held['gap'])
        flow.restart()
        self.assert_same(flow)

    def test_a_restart_that_writes_nothing(self):
        # With the watermark's index the old service's last commit counts as read; without it, the
        # second-to-last commit is the mark and the last one (a heartbeat here) is read again.
        for watermark, touched in ((True, []), (False, ['auth_sessions'])):
            with self.subTest(watermark=watermark):
                flow = Update(self, watermark=watermark)
                flow.around_restart(writes=False)
                self.assertEqual(self.assert_same(flow)['touchedTables'], touched)

    def test_a_log_left_behind_by_the_stop_is_explained_by_the_file_under_it(self):
        flow = Update(self)
        flow.old.heartbeat('session-2', '2026-10-22T13:59:30Z')
        flow.around_restart(stop='kill')
        self.assertTrue(flow.held['walPresent'])
        record = self.assert_same(flow)
        self.assertGreater(record['mainPagesExplained'], 0)

    def test_an_old_log_its_close_checkpointed_and_emptied(self):
        # SQLite builds that keep the -wal (Apple's) checkpoint it on the last close and truncate it
        # to zero bytes; the gap's pages then come from the WAL index the close left.
        flow = Update(self)
        flow.mark()
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.old.checkpoint('PASSIVE')
        flow.stop('kill')
        os.truncate(str(flow.database) + '-wal', 0)
        held = flow.clone()
        self.assertTrue(held['gap'], held)
        self.assertFalse(held['walPresent'])
        flow.restart()
        self.assert_same(flow)

    def test_a_passive_checkpoint_after_the_clone_is_explained(self):
        flow = Update(self)
        new = flow.around_restart()
        new.checkpoint('PASSIVE')  # Every frame copied into the file; the log keeps them until a write restarts it.
        record = self.assert_same(flow)
        self.assertGreater(record['mainPagesExplained'], 0)

    def test_without_dbstat(self):
        """The proof reads b-tree pages itself: a SQLite that denies dbstat changes nothing."""
        def deny(action, table, *rest):
            return sqlite3.SQLITE_DENY if table == 'dbstat' else sqlite3.SQLITE_OK
        connect, plain = live_database.connect, sqlite3.connect

        def guarded(connection):
            connection.set_authorizer(deny)
            return connection
        flow = Update(self)
        flow.around_restart()
        with patch.object(after_proof.live_database, 'connect', side_effect=lambda *a, **k: guarded(connect(*a, **k))), \
                patch.object(after_proof.sqlite3, 'connect', side_effect=lambda *a, **k: guarded(plain(*a, **k))):
            self.assert_same(flow)


class Refuses(unittest.TestCase):
    """Every case the proof cannot show leaves the decision to the full read."""

    def setUp(self):
        patcher = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        patcher.start()
        self.addCleanup(patcher.stop)

    def refused(self, flow, reason=None):
        reads, record, _ = flow.decide()
        self.assertIsNone(reads)
        self.assertEqual(record['mode'], 'full')
        if reason is not None:
            self.assertEqual(record['reason'], reason, record)
        return record

    def after_restart(self, *statements, stop='close', **shape):
        flow = Update(self, **shape)
        new = flow.around_restart()
        if statements:
            new.commit(*[(sql, []) for sql in statements])
        return flow, new

    def test_an_old_event_updated_in_place_is_caught_by_both_reads(self):
        flow, _ = self.after_restart("UPDATE orchestration_events SET event_type='tampered' WHERE sequence=3")
        self.refused(flow, 'old-log-row-changed')
        rows, _, carried, capture = flow.full()
        self.assertFalse(update_compare.same_guarded_rows(flow.before, rows, carried, auth_heartbeat=False))
        with self.assertRaises(AssertionError):
            update_compare.assert_capture_carried(flow.reference['reads'][2], capture, flow.before, rows, carried, auth_heartbeat=False)

    def test_an_old_event_deleted(self):
        # The delete may also rebalance the log's leaves (Apple's SQLite does): either refusal.
        record = self.refused(self.after_restart('DELETE FROM orchestration_events WHERE sequence=7')[0])
        self.assertIn(record['reason'], ('old-log-row-changed', 'leaf-sets'))

    def test_an_old_overflow_page_rewritten_in_place(self):
        # Same length, so SQLite overwrites the cell in place: only an overflow page is written.
        flow = Update(self)
        db = sqlite3.connect(str(flow.database))
        sequence, payload = db.execute('SELECT sequence, payload_json FROM orchestration_events WHERE length(payload_json) > 12000 LIMIT 1').fetchone()
        db.close()
        new = flow.around_restart(writes=False)
        new.commit(('UPDATE orchestration_events SET payload_json=? WHERE sequence=?', [payload[:-3] + 'zz"' if not payload.endswith('zz"') else payload[:-3] + 'yy"', sequence]))
        self.refused(flow, 'unowned-page')

    def test_a_table_dropped_or_widened(self):
        for statement in ('DROP TABLE scheduled_tasks', 'ALTER TABLE scheduled_tasks ADD COLUMN note TEXT'):
            with self.subTest(statement):
                self.refused(self.after_restart(statement)[0], 'schema')

    def test_a_page_that_moved_between_tables(self):
        flow = Update(self)
        new = flow.around_restart(writes=False)
        new.commit(('DELETE FROM checkpoint_diff_blobs', []))
        new.commit(*[("INSERT INTO auth_pairing_links VALUES (?,?)", ['big-%d' % index, 'x' * 9000]) for index in range(6)])
        self.refused(flow, 'page-moved')

    def test_a_changed_page_of_the_file_that_no_frame_explains(self):
        flow = Update(self)
        flow.around_restart()
        db = sqlite3.connect('file:%s?mode=ro&immutable=1' % flow.held['clone'], uri=True)
        root = db.execute("SELECT rootpage FROM sqlite_master WHERE name='scheduled_tasks'").fetchone()[0]
        db.close()
        with open(str(flow.database), 'r+b') as handle:  # Written behind SQLite's back.
            handle.seek((root - 1) * 4096 + 4000)
            handle.write(b'\x01' * 8)
        self.refused(flow, 'main-page-unexplained')

    def test_a_log_restarted_after_the_clone(self):
        for mode in ('TRUNCATE', 'PASSIVE'):  # After a complete PASSIVE checkpoint the next write restarts the log.
            with self.subTest(mode):
                flow, new = self.after_restart()
                new.checkpoint(mode)
                new.heartbeat('session-1', '2026-10-22T14:08:00Z')
                self.refused(flow, 'main-page-unexplained')

    def test_an_old_log_reset_between_the_mark_and_the_stop(self):
        flow = Update(self)
        flow.mark()
        flow.old.checkpoint('RESTART')
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.stop()
        held = flow.clone()
        self.assertEqual(held, {'reason': 'old-log-reset'})
        flow.restart()
        self.refused(flow, 'old-log-reset')

    def test_an_old_log_emptied_before_every_frame_was_checkpointed(self):
        flow = Update(self)
        flow.mark()
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.stop('kill')
        os.truncate(str(flow.database) + '-wal', 0)
        self.assertEqual(flow.clone(), {'reason': 'old-log-reset'})

    def test_an_event_appended_between_the_final_check_and_the_stop(self):
        flow = Update(self)
        flow.mark()
        flow.old.commit(event(random.Random(1), 'late', 't-1', 999, low=100, high=200))
        flow.stop()
        flow.clone()
        flow.restart()
        self.assertIn(self.refused(flow)['reason'], {'gap-touches-log', 'gap-touches-schema'})

    def test_no_clone_or_no_log(self):
        flow = Update(self)
        flow.mark()
        flow.stop()
        flow.clone(method='sqlite-backup')
        flow.restart()
        self.refused(flow, 'not-a-clone')
        self.assertEqual(after_proof.stopped(None, flow.root, 'clone'), {'reason': 'no-log'})

    def test_lines_not_kept_below_the_memory_floor(self):
        with patch.object(kept_lines, 'available_memory', return_value=1 << 20):
            flow = Update(self)
        flow.around_restart()
        reads, record, laps = flow.decide()
        self.assertEqual((reads, record, laps), (None, {'mode': 'full', 'reason': 'memory'}, []))

    def test_an_index_rebuilt_without_its_table(self):
        flow = Update(self)
        # (The receipts' sequence index rebuilds into the very same pages: nothing changes.)
        flow.around_restart(writes=False).commit(('REINDEX idx_orch_events_stream_sequence', []))
        self.refused(flow, 'index-only')

    def test_a_new_stream(self):
        flow, new = self.after_restart()
        new.commit(turn_item(random.Random(3), 'fresh', 't-new', 1))
        self.refused(flow, 'new-stream')

    def test_a_stream_whose_first_row_moved(self):
        # t-1 first appears in the nodes table (name order), at node-0.
        flow, new = self.after_restart("DELETE FROM orchestration_v2_projection_nodes WHERE node_id='node-0'")
        self.refused(flow, 'stream-order')

    def test_a_new_row_for_a_stream_that_exists_elsewhere_decides(self):
        flow, new = self.after_restart()
        new.commit(turn_item(random.Random(3), 'fresh', 't-6', 1))
        reads, record, _ = flow.decide()
        self.assertEqual(record['mode'], 'pages', record)
        self.assertEqual(encoded(reads[0]), encoded(flow.full()[0]))


class KeptLines(unittest.TestCase):
    def test_marked_and_merged_digests_equal_hashing_the_sorted_lines(self):
        rng = random.Random(11)
        for size in (0, 1, 5, 40, 300):
            lines = sorted(rng.choice(['a', 'b', 'bb', 'c' * rng.randrange(1, 30), '']) + str(rng.randrange(50)) for _ in range(size))
            sha256, marks = kept_lines.marked_digest(lines, every=7)
            self.assertEqual(sha256, continuity.joined_digest(lines))
            kept = {'lines': lines, 'marks': marks, 'sha256': sha256}
            for _ in range(30):
                removed = rng.sample(lines, rng.randrange(0, min(len(lines), 6) + 1))
                added = [rng.choice(['a', 'b', 'zz', '']) + str(rng.randrange(60)) for _ in range(rng.randrange(0, 6))]
                rest = list(lines)
                for line in removed:
                    rest.remove(line)
                expected = sorted(rest + added)
                self.assertEqual(kept_lines.merged_digest(kept, removed, added, every=7),
                                 {'count': len(expected), 'sha256': continuity.joined_digest(expected)})
            if lines:
                self.assertIsNone(kept_lines.merged_digest(kept, ['missing-line'], []))

    def test_a_read_that_keeps_lines_publishes_the_same_proof(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            expected = update_read._read_state(state, False, None, True)
            with patch.object(kept_lines, 'available_memory', return_value=1 << 50), patch.object(kept_lines, 'KEEP_BYTES', 0):
                with after_proof.keeping(state / 'statev2.sqlite') as kept:
                    keeping = update_read._read_state(state, True, expected[0], True)
                plain = update_read._read_state(state, True, expected[0], True)
            self.assertEqual(json.dumps(keeping, default=str), json.dumps(plain, default=str))
            self.assertTrue(kept.complete)
            self.assertEqual(set(kept.tables), set(plain[3]['summary']['tables']))
            for table, entry in kept.tables.items():
                self.assertEqual(entry['typed']['sha256'], plain[3]['summary']['tables'][table]['sha256'])
                self.assertEqual(entry['legacy']['sha256'], plain[3]['legacy'][table]['sha256'])
            self.assertIsNone(kept_lines.active())

    def test_the_memory_floor(self):
        with tempfile.NamedTemporaryFile() as handle:
            handle.write(b'x' * 4096)
            handle.flush()
            with patch.object(kept_lines, 'available_memory', return_value=kept_lines.memory_floor(4096) - 1):
                self.assertEqual(kept_lines.start(handle.name).reason, 'memory')
            with patch.object(kept_lines, 'available_memory', return_value=kept_lines.memory_floor(4096)):
                self.assertTrue(kept_lines.start(handle.name).enabled)
        self.assertGreater(kept_lines.available_memory() or 1, 0)


# --measure: the proof on a clone of M4's database.

def _timed(function, *arguments):
    started = time.monotonic()
    value = function(*arguments)
    return value, round(time.monotonic() - started, 2)


def measure(clone_folder):
    clone_folder = pathlib.Path(clone_folder).expanduser().resolve()
    original = clone_folder / 'statev2.sqlite'
    assert original.is_file(), 'No statev2.sqlite in %s' % clone_folder
    live_folder = clone_folder.parent / 'live'
    assert not live_folder.exists(), '%s exists; remove it first' % live_folder
    live_folder.mkdir(mode=0o700)
    writer = None
    try:
        copy = live_folder / 'statev2.sqlite'
        subprocess.run(['/bin/cp', '-c', str(original), str(copy)], check=True)
        held = {'clone': str(original), 'gap': [], 'walPresent': False, 'mainUnder': {},
                'main': after_proof.read_delta._main_file(copy), 'pageSize': 4096}
        db = sqlite3.connect('file:%s?mode=ro&immutable=1' % original, uri=True)
        logs = {table: db.execute('SELECT coalesce(max(rowid), 0) FROM ' + table).fetchone()[0]
                for table in update_read.LOG_TABLES
                if db.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone()}
        last = db.execute('SELECT stream_id, aggregate_kind, max(stream_version) FROM orchestration_events '
                          'WHERE sequence = (SELECT max(sequence) FROM orchestration_events)').fetchone()
        stream, kind = last[0], last[1]
        version = db.execute('SELECT max(stream_version) FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?',
                             (kind, stream)).fetchone()[0]
        session = db.execute('SELECT session_id FROM auth_sessions ORDER BY session_id LIMIT 1').fetchone()[0]
        db.close()
        # The agent's earlier snapshot only names where the logs ended, so the read below takes
        # the prefix path update.py's read before the restart takes.
        expected = {update_read.ACTIVITY_KEY: {'logRowids': logs, 'threadTables': [], 'threadSha256': {}, 'cursorSha256': {}}}
        with after_proof.keeping(original) as kept:
            before, before_seconds = _timed(update_read._read_state, clone_folder, False, expected, True)
        print('before read with kept lines: %.2f s, kept %s' % (before_seconds, sorted(kept.tables) or kept.reason), flush=True)
        reference = {'position': None, 'since': before[0], 'reads': (before[0], None, before[3])}
        writer = Writer(copy)
        rng = random.Random(1072)
        writer.commit(*[("INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,"
                         "command_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,?,?,?,?,?,?,?,?,?,2)",
                         ['measure-event-%d' % index, kind, stream, version + 1 + index, 'thread.activity-appended', NOW,
                          'measure-command-%d' % index, 'server', text(rng, 500, 9000), '{}']) for index in range(30)])
        writer.commit(*[("INSERT INTO orchestration_command_receipts VALUES (?,?,?,?,(SELECT max(sequence) FROM orchestration_events),"
                         "'accepted',NULL,'thread.activity.append')", ['measure-receipt-%d' % index, kind, stream, NOW])
                        for index in range(10)])
        writer.commit(('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', [NOW, session]))
        progress, laps = {}, []
        reads, proof_seconds = _timed(after_proof.decide, live_folder, held, kept, reference, before[0], False, progress, laps.append)
        print('page proof: %.2f s, %s' % (proof_seconds, json.dumps(progress['afterProof'])), flush=True)
        full, full_seconds = _timed(update_read._read_state, live_folder, False, before[0], True)
        print('full read of the copy: %.2f s' % full_seconds, flush=True)
        same = reads is not None and all(json.dumps(reads[index]) == json.dumps(full[index]) for index in (0, 2, 3))
        print(json.dumps({'beforeReadSeconds': before_seconds, 'pageProofSeconds': proof_seconds, 'fullReadSeconds': full_seconds,
                          'afterProof': progress['afterProof'], 'equalToFullRead': same,
                          'appendedLogRows': full[2]['appendedRows'] if full[2] else None}, indent=2))
        return 0 if same and proof_seconds < 10 else 1
    finally:
        if writer is not None:
            writer.close()
        shutil.rmtree(str(live_folder), ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--measure':
        sys.exit(measure(sys.argv[2]))
    unittest.main()
