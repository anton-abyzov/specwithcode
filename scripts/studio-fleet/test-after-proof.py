#!/usr/bin/env python3
"""after_proof: the page proof after the restart must equal the full read byte for byte, or refuse.

Each test builds a small WAL database from scratch with the real statev2 table names and shapes
(log rows with overflow-sized payloads, a projection keyed by thread large enough to be kept),
runs the old service as a child process that keeps one connection open, takes the read before the
restart (with its lines kept), marks the old log (with the reader update.py starts, unless a test
says otherwise), stops that service, clones its files as update.py does (state_backup.clone_state),
starts the new service as another child process and has it commit what a starting release writes.
The page proof then either returns exactly what update_read._read_state returns for the same
moment, or None.

    python3 -B test-after-proof.py
    /usr/bin/python3 -B test-after-proof.py --measure ~/.specwithcode/m4/scratch/fast-install-profile/clone

--measure clones the given clone folder's statev2.sqlite with `cp -c` into a sibling folder, keeps
it open in a writer that appends 30 events and 10 receipts and updates a session, then times the
full read with kept lines on the given clone, the page proof on the copy and a full read of the
copy, checks the proof equals that full read and deletes the copy. The given clone is only read.
"""
import contextlib
import datetime
import errno
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

# The service's own SQLite (node:sqlite) with its pragmas (apps/server/src/persistence/Sqlite.ts).
NODE_WRITER = r"""
import { DatabaseSync } from "node:sqlite";
import readline from "node:readline";
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 33554432;");
console.log("ready");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [sql, parameters] of JSON.parse(line)) db.prepare(sql).run(...parameters);
    db.exec("COMMIT");
    console.log("ok");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    console.log("error " + error.message);
  }
}).on("close", () => { db.close(); process.exit(0); });
"""


# Another process with the database open and idle: it keeps the -shm, so the next connection trusts it.
IDLE_READER = r'''
import sqlite3, sys
db = sqlite3.connect('file:%s?mode=ro' % sys.argv[1], uri=True)
db.execute('SELECT count(*) FROM sqlite_master').fetchall()
print('open', flush=True)
sys.stdin.read()
'''


def node_with_sqlite():
    """STUDIO_TEST_NODE (run-tests.sh) or node on PATH, when it has node:sqlite; else None."""
    node = os.environ.get('STUDIO_TEST_NODE') or shutil.which('node')
    if not node:
        return None
    probe = subprocess.run([node, '--input-type=module', '-e', 'import "node:sqlite"'], capture_output=True)
    return node if probe.returncode == 0 else None


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

    def __init__(self, database, node=None):
        command = ([node, '--no-warnings', '--input-type=module', '-e', NODE_WRITER, str(database)] if node
                   else [sys.executable, '-c', WRITER, str(database)])
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
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


# The status the new service settles at startup, the same length, so the row is written in place.
SETTLE_BIG_NODE = """UPDATE orchestration_v2_projection_nodes SET payload_json=replace(payload_json, '"running"', '"stopped"') WHERE node_id='node-big-0'"""


def encoded(value):
    return continuity.encoded(value)


class Update:
    """update.py's steps around the restart, on a fixture database."""

    def __init__(self, test, include_auth=False, since_expected=True, watermark=False, reader=True, pinned_commits=0,
                 node=None, written=(), **shape):
        self.test, self.include_auth, self.reader = test, include_auth, reader
        folder = tempfile.TemporaryDirectory(prefix='studio-after-proof-')
        test.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name).resolve()
        self.state = self.root / 'own' / 'userdata'
        self.database = self.state / 'statev2.sqlite'
        build(self.state, **shape)
        self.old = Writer(self.database, node)
        test.addCleanup(self.old.close)
        self.old.heartbeat(moment='2026-10-22T13:59:00Z')  # A running service's log has frames in it.
        if written:  # What the old service wrote before the read, as [(sql, parameters)].
            self.old.commit(*written)
        if pinned_commits:
            # A long read (the read before the restart on a large database) keeps every checkpoint
            # from copying the commits made meanwhile: the log is past the autocheckpoint at the mark.
            pin = sqlite3.connect('file:%s?mode=ro' % self.database, uri=True)
            pin.execute('BEGIN')
            pin.execute('SELECT count(*) FROM sqlite_master').fetchall()
            for index in range(pinned_commits):
                self.old.commit(("INSERT OR REPLACE INTO scheduled_tasks VALUES ('pinned', ?)", ['%d * * * *' % index]))
            pin.close()
        expected = update_read._read_state(self.state, False, None, True)[0] if since_expected else None
        with after_proof.keeping(self.database) as self.kept:
            before = update_read._read_state(self.state, include_auth, expected, True)
        self.before = before[0]
        self.reference = {'position': None, 'since': self.before, 'reads': (before[0], None, before[3])}
        # update.py keeps one open from the read before the restart until the stop; with a reader, the
        # mark is confirmed against it.
        self.watermark = read_watermark.Watermark.open(self.database) if watermark or reader else None
        self.taken = None
        if self.watermark is not None:
            test.addCleanup(self.watermark.close)
            self.taken = self.watermark.take()
        self.new = None

    def mark(self, reread=False):
        """`reread`: update.py's final check read again after the read the proof starts from."""
        self.marked = after_proof.mark(self.database, reader=self.reader)
        self.test.addCleanup(after_proof.release, self.marked)
        self.test.assertEqual(self.reader, 'reader' in (self.marked or {}))
        current = self.watermark.take() if reread and self.watermark is not None else self.taken
        after_proof.confirm(self.marked, self.watermark or read_watermark.NEVER_UNCHANGED, self.taken, current)
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
        self.held = after_proof.stopped(self.marked, backup, method or actual, update._clonefile())
        self.test.addCleanup(after_proof.discard, self.held)
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
    MEMORY = 0  # Kept lines on disk; EqualInMemory keeps them in memory.

    def setUp(self):
        for name, value in (('available_disk', 1 << 50), ('available_memory', self.MEMORY)):
            patcher = patch.object(kept_lines, name, return_value=value)
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
        self.assertTrue(flow.kept.tables)  # A decided proof leaves its lines for update.py to let go after readiness.
        flow.kept.clear()
        self.assertEqual(record['keptIn'], 'memory' if self.MEMORY else 'disk')
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

    def big_nodes(self):
        """Projection rows with overflow pages. The new service settling one at startup (a status of
        the same length, M4's 1.0.92 install) writes it again in place: only an overflow page changes."""
        return Update(self, written=[("INSERT INTO orchestration_v2_projection_nodes VALUES (?,?,?,NULL,?,'agent','running',?)",
                                      ['node-big-%d' % index, THREADS[index % 4], 'run-' + THREADS[index % 4], 'node-0',
                                       '{"text":"' + 'a' * 9000 + '","status":"running"}']) for index in range(2)])

    def test_a_row_rewritten_at_its_length_decides_by_pages(self):
        flow = self.big_nodes()
        new = flow.around_restart(writes=False)
        new.commit((SETTLE_BIG_NODE, []))
        record = self.assert_same(flow)
        self.assertGreaterEqual(record['overflowAdopted'], 1)
        self.assertIn('orchestration_v2_projection_nodes', record['touchedTables'])

    def test_a_kept_table_row_rewritten_at_its_length_is_compared_row_by_row(self):
        with patch.object(kept_lines, 'KEEP_BYTES', 16 << 10):
            flow = self.big_nodes()
        self.assertIn('orchestration_v2_projection_nodes', flow.kept.tables)
        new = flow.around_restart(writes=False)
        new.commit((SETTLE_BIG_NODE, []),
                   # Another row of the table changes length: its leaf changes too, and the search starts with that tree.
                   ("UPDATE orchestration_v2_projection_nodes SET payload_json=payload_json || ' ' WHERE node_id='node-1'", []))
        record = self.assert_same(flow)
        self.assertGreaterEqual(record['overflowAdopted'], 1)

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
        # The reader's snapshot, or with the watermark's index the old service's last commit, counts
        # as read; without either, the second-to-last commit is the mark and the last one (a
        # heartbeat here) is read again.
        for reader, watermark, touched in ((True, False, []), (False, True, []), (False, False, ['auth_sessions'])):
            with self.subTest(reader=reader, watermark=watermark):
                flow = Update(self, watermark=watermark, reader=reader)
                flow.around_restart(writes=False)
                self.assertEqual(self.assert_same(flow)['touchedTables'], touched)

    def test_a_log_left_behind_by_the_stop_is_explained_by_the_file_under_it(self):
        flow = Update(self, reader=False)
        flow.old.heartbeat('session-2', '2026-10-22T13:59:30Z')
        flow.around_restart(stop='kill')
        self.assertTrue(flow.held['walPresent'])
        record = self.assert_same(flow)
        self.assertGreater(record['mainPagesExplained'], 0)

    def test_the_log_the_reader_kept_is_folded_into_the_live_database_before_the_restart(self):
        for stop in ('close', 'kill'):
            with self.subTest(stop=stop):
                flow = Update(self)
                self.assertTrue(flow.mark()['confirmed'])
                flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
                flow.stop(stop)
                self.assertGreater(os.path.getsize(str(flow.database) + '-wal'), 0)  # The reader kept the close from folding it.
                held = flow.clone()
                self.assertFalse(held['walPresent'], held)
                self.assertFalse(os.path.exists(str(flow.database) + '-wal') and os.path.getsize(str(flow.database) + '-wal'))
                self.assertEqual(flow.marked['reader'].process.poll(), 0)
                flow.restart()
                self.assertEqual(self.assert_same(flow)['mainPagesExplained'], 0)

    def test_the_mark_is_confirmed_only_when_nothing_committed_since_the_read(self):
        flow = Update(self)
        self.assertTrue(flow.mark()['confirmed'])
        flow = Update(self)
        flow.old.commit(("UPDATE scheduled_tasks SET cron='changed' WHERE id='nightly'", []))
        self.assertFalse(flow.mark()['confirmed'])
        flow.stop()
        self.assertNotIn('reference', flow.clone())
        self.assertFalse(flow.marked['confirmed'])

    def test_a_fold_the_live_log_refuses_keeps_the_log_for_the_new_release(self):
        flow = Update(self)
        flow.mark()
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.stop()
        with patch.object(after_proof, '_fold_live', return_value=None):
            held = flow.clone()
        self.assertTrue(held['walPresent'], held)
        self.assertIn('reference', held)
        flow.restart()
        self.assert_same(flow)

    def test_a_reference_image_is_removed_by_every_path(self):
        flow = Update(self)
        folder = flow.root / 'backups'
        folder.mkdir()
        dead = subprocess.Popen([sys.executable, '-c', 'pass'])
        dead.wait()
        stale = folder / ('%s%d-%s.sqlite' % (after_proof.REFERENCE_PREFIX, dead.pid, 'a' * 32))
        stale.write_bytes(b'')
        flow.mark()
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.stop()
        path = flow.clone()['reference']
        self.assertFalse(stale.exists())  # Left by a helper that died.
        self.assertEqual(flow.marked['reference'], path)
        after_proof.discard(flow.marked)  # update.py's failure path before `stopped` returned.
        self.assertFalse(os.path.exists(path))

    def test_the_old_services_shutdown_writes_decide_by_pages(self):
        # 1.0.85 on M4: SIGTERM cancelled background work, which appended 51 events and 20 receipts
        # and updated projections 0.4 s after the mark. The reference image reads them again.
        with patch.object(kept_lines, 'KEEP_BYTES', 64 << 10):
            flow = Update(self)
        flow.mark()
        rng = random.Random(85)
        flow.old.commit(*[event(rng, 'shutdown-%d' % index, 't-1', 2000 + index, low=100, high=12000) for index in range(12)])
        flow.old.commit(*[receipt('shutdown-%d' % index, 1) for index in range(5)])
        flow.old.commit(("UPDATE orchestration_v2_projection_turn_items SET status='interrupted' WHERE turn_item_id='item-old-9'", []),
                        ("UPDATE orchestration_v2_projection_threads SET updated_at=? WHERE thread_id='t-2'", ['2026-10-22T14:03:00Z']))
        flow.stop()
        held = flow.clone()
        self.assertTrue(held['gap'] and held['reference'], held)
        flow.restart()
        record = self.assert_same(flow)
        self.assertTrue(record['referenceImage'])
        self.assertGreater(record['gapPages'], 0)
        self.assertIn('orchestration_events', record['touchedTables'])
        self.assertIn('orchestration_v2_projection_turn_items', record['touchedTables'])
        self.assertFalse(os.path.exists(held['reference']))  # Removed once the proof ran.
        self.assertEqual(flow.full()[2]['appendedRows']['orchestration_events'], 42)

    def test_a_log_past_the_autocheckpoint_at_the_mark_keeps_its_generation(self):
        # 1.0.85 on M4: the read before the restart pinned the log, so at the mark it was past the
        # autocheckpoint; the old service's first commit after the mark copied every frame and its
        # second restarted the log (old-log-reset). The reader blocks both.
        for reader in (False, True):
            with self.subTest(reader=reader):
                flow = Update(self, reader=reader, pinned_commits=1100)
                flow.mark()
                for index in range(3):
                    flow.old.commit(event(random.Random(index), 'shutdown-%d' % index, 't-1', 3000 + index, low=100, high=300))
                flow.stop()
                held = flow.clone()
                flow.restart()
                if not reader:
                    self.assertEqual(held, {'reason': 'old-log-reset'})
                    continue
                self.assertIn('reference', held)
                self.assertTrue(self.assert_same(flow)['referenceImage'])

    def test_a_snapshot_that_read_the_file_alone_admits_one_restart(self):
        flow = Update(self)
        flow.old.checkpoint('PASSIVE')  # Every frame copied: the reader reads the file alone (read mark 0).
        marked = flow.mark()
        self.assertTrue(marked['fromFile'])
        rng = random.Random(4)
        for index in range(3):
            flow.old.commit(event(rng, 'restart-%d' % index, 't-3', 4000 + index, low=100, high=9000))
        with open(str(flow.database) + '-wal', 'rb') as handle:
            self.assertNotEqual(handle.read(24)[16:24], marked['salt'])  # The first commit restarted the log.
        flow.stop()
        held = flow.clone()
        self.assertTrue(held['gap'] and held['reference'], held)
        flow.restart()
        self.assertTrue(self.assert_same(flow)['referenceImage'])

    def test_an_old_log_its_close_checkpointed_and_emptied(self):
        # SQLite builds that keep the -wal (Apple's) checkpoint it on the last close and truncate it
        # to zero bytes; the gap's pages then come from the WAL index the close left.
        flow = Update(self, reader=False)
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


class EqualInMemory(Equal):
    """Equal with the kept lines in memory, the first place they go."""
    MEMORY = 1 << 50


@unittest.skipUnless(node_with_sqlite(), 'needs Node 22 with node:sqlite (STUDIO_TEST_NODE)')
class NodeService(unittest.TestCase):
    """The old service on node:sqlite with its own pragmas, as on M4 for 1.0.85."""
    MEMORY = 0

    setUp, assert_same = Equal.setUp, Equal.assert_same

    def test_a_pinned_log_and_shutdown_writes_decide_by_pages(self):
        for reader in (False, True):
            with self.subTest(reader=reader):
                flow = Update(self, reader=reader, pinned_commits=1100, node=node_with_sqlite())
                flow.mark()
                rng = random.Random(1085)
                for index in range(3):  # Background work cancelled on SIGTERM, one commit each.
                    flow.old.commit(event(rng, 'sigterm-%d' % index, 't-1', 5000 + index, low=100, high=6000),
                                    receipt('sigterm-%d' % index, 1))
                flow.stop()
                held = flow.clone()
                flow.restart()
                if not reader:
                    self.assertEqual(held, {'reason': 'old-log-reset'})
                    continue
                record = self.assert_same(flow)
                self.assertTrue(record['referenceImage'])
                self.assertIn('orchestration_events', record['touchedTables'])


class Refuses(unittest.TestCase):
    """Every case the proof cannot show leaves the decision to the full read."""
    MEMORY = 0

    def setUp(self):
        for name, value in (('available_disk', 1 << 50), ('available_memory', self.MEMORY)):
            patcher = patch.object(kept_lines, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def refused(self, flow, reason=None):
        reads, record, _ = flow.decide()
        self.assertIsNone(reads)
        self.assertEqual(record['mode'], 'full')
        self.assertEqual(flow.kept.tables, {})  # Let go at once: the full read that follows needs the memory.
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
        # Its overflow page is placed but a log's rows are not searched (find_owners): still refused.
        self.refused(flow, 'unowned-page')

    def test_an_overflow_page_the_search_cannot_place_in_its_budget(self):
        flow = Equal.big_nodes(self)
        new = flow.around_restart(writes=False)
        new.commit((SETTLE_BIG_NODE, []))
        with patch.object(after_proof, 'ORPHAN_SEARCH_PAGES', 0):
            self.refused(flow, 'unowned-page')

    def test_a_table_dropped_or_widened(self):
        for statement in ('DROP TABLE scheduled_tasks', 'ALTER TABLE scheduled_tasks ADD COLUMN note TEXT'):
            with self.subTest(statement):
                self.refused(self.after_restart(statement)[0], 'schema')

    def test_a_page_that_moved_between_tables_reads_both_tables_again(self):
        flow = Update(self)
        new = flow.around_restart(writes=False)
        new.commit(('DELETE FROM checkpoint_diff_blobs', []))
        new.commit(*[("INSERT INTO auth_pairing_links VALUES (?,?)", ['big-%d' % index, 'x' * 9000]) for index in range(6)])
        reads, record, _ = flow.decide()
        self.assertEqual(record['mode'], 'pages', record)
        self.assertTrue({'checkpoint_diff_blobs', 'auth_pairing_links'} <= set(record['touchedTables']))
        full = flow.full()
        self.assertEqual([json.dumps(reads[index]) for index in (0, 2, 3)], [json.dumps(full[index]) for index in (0, 2, 3)])

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
        flow = Update(self, reader=False)  # A reader blocks the reset (the RESTART checkpoint is busy).
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
        # Without the reference image (no reader, or a final check that read again after it opened).
        for reader, reread in ((False, False), (True, True)):
            with self.subTest(reader=reader, reread=reread):
                flow = Update(self, reader=reader)
                flow.mark(reread=reread)
                flow.old.commit(event(random.Random(1), 'late', 't-1', 999, low=100, high=200))
                flow.stop()
                self.assertNotIn('reference', flow.clone())
                flow.restart()
                self.assertIn(self.refused(flow)['reason'], {'gap-touches-log', 'gap-touches-schema'})

    def test_a_fold_that_trusted_an_index_short_of_the_log(self):
        # Another connection keeps the -shm through the stop, and the old service died between writing
        # its last commit frame and publishing it: the clone, folded from the log alone, has that commit;
        # a fold that trusts the index does not.
        flow = Update(self)
        other = subprocess.Popen([sys.executable, '-c', IDLE_READER, str(flow.database)], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, universal_newlines=True)
        self.addCleanup(other.wait)
        self.addCleanup(other.stdin.close)
        self.addCleanup(other.stdout.close)
        self.assertEqual(other.stdout.readline(), 'open\n')
        flow.mark()
        flow.old.heartbeat('session-2', '2026-10-22T14:02:00Z')
        flow.stop()
        database = str(flow.database)
        with open(database + '-shm', 'rb') as handle:  # This process holds no lock on the -shm.
            index = after_proof._index_header(handle.fileno())
        frame = 24 + index['pageSize']
        copy = flow.root / 'copy'
        copy.mkdir()
        for suffix in ('', '-wal', '-shm'):
            shutil.copyfile(database + suffix, str(copy / ('c.sqlite' + suffix)))
        writer = sqlite3.connect(str(copy / 'c.sqlite'), isolation_level=None)
        writer.execute("UPDATE scheduled_tasks SET cron='unpublished' WHERE id='nightly'")
        with open(str(copy / 'c.sqlite-wal'), 'rb') as handle:
            handle.seek(32 + index['mxFrame'] * frame)
            unpublished = handle.read()
        writer.close()
        self.assertTrue(unpublished and len(unpublished) % frame == 0)
        with open(database + '-wal', 'r+b') as handle:
            handle.seek(32 + index['mxFrame'] * frame)
            handle.write(unpublished)
        self.assertEqual(flow.clone(), {'reason': 'fold-differs'})
        self.assertFalse(os.path.exists(flow.marked['reference']))
        other.stdin.close()
        other.wait()
        flow.restart(writes=False)
        self.refused(flow, 'fold-differs')

    def test_a_reader_lost_before_the_stop(self):
        flow = Update(self)
        flow.mark()
        flow.marked['reader'].process.kill()
        flow.marked['reader'].process.wait()
        flow.old.commit(event(random.Random(2), 'late', 't-1', 998, low=100, high=200))
        flow.stop()
        self.assertEqual(flow.clone(), {'reason': 'reader-lost'})
        flow.restart()
        self.refused(flow, 'reader-lost')

    def test_an_old_event_changed_in_the_gap_is_caught_by_both_reads(self):
        flow = Update(self)
        flow.mark()
        flow.old.commit(("UPDATE orchestration_events SET event_type='tampered' WHERE sequence=4", []))
        flow.stop()
        self.assertIn('reference', flow.clone())
        flow.restart()
        self.refused(flow, 'old-log-row-changed')
        rows, _, carried, _ = flow.full()
        self.assertFalse(update_compare.same_guarded_rows(flow.before, rows, carried, auth_heartbeat=False))

    def test_no_clone_or_no_log(self):
        flow = Update(self)
        flow.mark()
        flow.stop()
        flow.clone(method='sqlite-backup')
        flow.restart()
        self.refused(flow, 'not-a-clone')
        self.assertEqual(after_proof.stopped(None, flow.root, 'clone'), {'reason': 'no-log'})

    def test_lines_not_kept_below_the_disk_floor(self):
        with patch.object(kept_lines, 'available_disk', return_value=1 << 20):
            flow = Update(self)
        flow.around_restart()
        reads, record, laps = flow.decide()
        self.assertEqual((reads, laps), (None, []))
        self.assertEqual((record['mode'], record['reason'], record['availableBytes']), ('full', 'disk', 1 << 20))
        self.assertGreater(record['floorBytes'], kept_lines.DISK_FLOOR_MARGIN)

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
            with patch.object(kept_lines, 'available_disk', return_value=1 << 50), patch.object(kept_lines, 'KEEP_BYTES', 0):
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

    def test_the_disk_floor(self):
        with tempfile.NamedTemporaryFile() as handle:
            handle.write(b'x' * 4096)
            handle.flush()
            with patch.object(kept_lines, 'available_disk', return_value=kept_lines.disk_floor(4096) - 1), \
                    patch.object(kept_lines, 'available_memory', return_value=7), patch.object(kept_lines, 'headroom', return_value=8):
                kept = kept_lines.start(handle.name)
                self.assertEqual((kept.reason, kept.measured), ('disk', {'availableBytes': kept_lines.disk_floor(4096) - 1,
                                                                         'floorBytes': kept_lines.disk_floor(4096),
                                                                         'availableMemoryBytes': 7, 'headroomBytes': 8}))
            with patch.object(kept_lines, 'available_disk', return_value=kept_lines.disk_floor(4096)), \
                    patch.object(kept_lines, 'available_memory', return_value=0):
                kept = kept_lines.start(handle.name)
                self.assertTrue(kept.enabled)
                folder = pathlib.Path(kept.folder)
                self.assertTrue(folder.is_dir())
                kept.clear()
                self.assertFalse(folder.exists())
        self.assertGreater(kept_lines.available_disk(tempfile.gettempdir()) or 1, 0)

    def test_lines_written_to_disk_hash_and_merge_as_the_list(self):
        rng = random.Random(12)
        with tempfile.TemporaryDirectory(prefix='studio-kept-disk-') as folder:
            for size in (0, 1, 2, 6, 7, 8, 40, 300):
                lines = sorted(rng.choice(['a', 'b', 'bb', 'é' * rng.randrange(1, 4), '', 'x\ny']) + str(rng.randrange(50))
                               for _ in range(size))
                sha256, marks, stored = kept_lines.marked_digest(lines, every=7, folder=folder)
                self.assertEqual(sha256, continuity.joined_digest(lines))
                self.assertEqual(list(stored[:]), lines)
                self.assertEqual(len(stored), len(lines))
                kept = {'lines': stored, 'marks': marks, 'sha256': sha256}
                for _ in range(30):
                    removed = rng.sample(lines, rng.randrange(0, min(len(lines), 6) + 1))
                    added = [rng.choice(['a', 'b', 'zz', '', 'é']) + str(rng.randrange(60)) for _ in range(rng.randrange(0, 6))]
                    rest = list(lines)
                    for line in removed:
                        rest.remove(line)
                    expected = sorted(rest + added)
                    self.assertEqual(kept_lines.merged_digest(kept, removed, added, every=7),
                                     {'count': len(expected), 'sha256': continuity.joined_digest(expected)})
                if lines:
                    self.assertIsNone(kept_lines.merged_digest(kept, ['missing-line'], []))
                    path = stored.path
                    stored.close()
                    self.assertFalse(os.path.exists(path))

    def test_empty_lines_on_disk_merge_as_the_list(self):
        # Review of #795: a run of one empty line lost its separator, and a lone [''] could not be mapped.
        with tempfile.TemporaryDirectory(prefix='studio-kept-empty-') as folder:
            for lines, removed, added in ((['', '', '\x00'], ['', '\x00'], ['zz']), ([''], [''], ['a']), ([''], [], ['a'])):
                sha256, marks, stored = kept_lines.marked_digest(lines, every=4, folder=folder)
                rest = list(lines)
                for line in removed:
                    rest.remove(line)
                expected = sorted(rest + added)
                self.assertEqual(kept_lines.merged_digest({'lines': stored, 'marks': marks, 'sha256': sha256}, removed, added, every=4),
                                 {'count': len(expected), 'sha256': continuity.joined_digest(expected)})

    def test_a_write_that_fails_lets_the_read_go_on_and_the_proof_fall_back(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-full-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            expected = update_read._read_state(state, False, None, True)
            with patch.object(kept_lines, 'available_disk', return_value=1 << 50), patch.object(kept_lines, 'KEEP_BYTES', 0), \
                    patch.object(kept_lines, 'available_memory', return_value=0), \
                    patch.object(kept_lines.FileLines, '__init__', side_effect=OSError(28, 'No space left on device')):
                with after_proof.keeping(state / 'statev2.sqlite') as kept:
                    keeping = update_read._read_state(state, True, expected[0], True)
            plain = update_read._read_state(state, True, expected[0], True)
            self.assertEqual(json.dumps(keeping, default=str), json.dumps(plain, default=str))
            self.assertEqual((kept.reason, kept.tables), ('disk-full', {}))
            self.assertFalse(pathlib.Path(kept.folder).exists())
            progress = {}
            self.assertIsNone(after_proof.decide(state, {'clone': 'x'}, kept, None, None, False, progress, lambda phase: None))
            self.assertEqual(progress['afterProof'], {'mode': 'full', 'reason': 'disk-full'})

    def test_the_floor_counts_what_the_backup_still_needs(self):
        with tempfile.NamedTemporaryFile() as handle:
            handle.write(b'x' * 4096)
            handle.flush()
            with patch.object(kept_lines, 'available_disk', return_value=kept_lines.disk_floor(4096)), \
                    patch.object(kept_lines, 'available_memory', return_value=0):
                kept = kept_lines.start(handle.name, reserve=1)
            self.assertEqual((kept.reason, kept.measured['floorBytes']), ('disk', kept_lines.disk_floor(4096) + 1))

    def test_empty_lines_on_disk_hash_and_merge_as_the_list(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-empty-') as folder:
            for lines in ([''], ['', ''], ['', 'a'], ['', '', 'b', 'b'], ['a', ''] [::-1], [''] * 9):
                sha256, marks, stored = kept_lines.marked_digest(lines, every=4, folder=folder)
                self.assertEqual((sha256, list(stored[:]), len(stored)), (continuity.joined_digest(lines), lines, len(lines)))
                kept = {'lines': stored, 'marks': marks, 'sha256': sha256}
                for removed, added in (([''], []), ([], ['']), ([], ['', 'c']), ([lines[-1]], ['', ''])):
                    rest = list(lines)
                    for line in removed:
                        rest.remove(line)
                    expected = sorted(rest + added)
                    self.assertEqual(kept_lines.merged_digest(kept, removed, added, every=4),
                                     {'count': len(expected), 'sha256': continuity.joined_digest(expected)})

    def test_a_file_never_passes_the_disk_margin(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-limit-') as folder:
            lines = ['x' * 100] * 50
            with self.assertRaises(OSError) as raised:
                kept_lines.marked_digest(lines, every=7, folder=folder, limit=1000)
            self.assertEqual(raised.exception.errno, errno.ENOSPC)
            self.assertLessEqual(max(os.path.getsize(path) for path in pathlib.Path(folder).iterdir()), 1000)
            self.assertEqual(kept_lines.marked_digest(lines, every=7, folder=folder, limit=50 * 101)[0], continuity.joined_digest(lines))
            # A Kept stops at the margin plus the backup's reserve, lets go and removes its folder.
            free = kept_lines.DISK_FLOOR_MARGIN + 7 + 2000
            with patch.object(kept_lines, 'available_disk', return_value=free):
                kept = kept_lines.Kept(True, None, ('t',), folder=kept_lines._scratch(folder), reserve=7)
                kept.keeper('t', 'typed')(['y' * 10] * 100)
                self.assertIsNone(kept.reason)
                scratch = pathlib.Path(kept.folder)
                kept.keeper('t', 'typed')(['y' * 10] * 300)
            self.assertEqual((kept.reason, kept.tables, scratch.exists()), ('disk-full', {}, False))

    def test_lines_held_in_memory_make_room_before_another_full_read(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            plain = update_read._read_state(state, True, None, True)
            proof, kept = self.keeping_read(state, [1 << 50])
            self.assertEqual((kept.place, kept.reason), ('memory', None))
            self.assertGreater(kept.resident, 0)
            with patch.object(kept_lines, 'available_memory', return_value=1 << 50):  # Room for another read: kept as is.
                self.assertEqual(json.dumps(update_read._read_state(state, True, None, True), default=str), json.dumps(plain, default=str))
            self.assertEqual(kept.place, 'memory')
            with patch.object(kept_lines, 'available_memory', return_value=0):
                again = update_read._read_state(state, True, None, True)
            self.assertEqual(json.dumps(again, default=str), json.dumps(plain, default=str))
            self.assertEqual((kept.place, kept.reason, kept.resident), ('disk', None, 0))
            for table, entry in kept.tables.items():
                self.assertEqual(entry['typed']['sha256'], plain[3]['summary']['tables'][table]['sha256'])
                for record in entry.values():
                    self.assertFalse(isinstance(record['lines'], list) and record['count'] > 1)
                    self.assertEqual(continuity.joined_digest(list(record['lines'][:])), record['sha256'])
            kept.clear()
            kept = kept_lines.Kept(True, None, ('t',))  # Without a disk fallback the lines go.
            with patch.object(kept_lines, 'memory_room', return_value=True):
                kept.keeper('t', 'typed')(['a'])
            with patch.object(kept_lines, 'memory_room', return_value=False):
                kept_lines.make_room()
            self.assertEqual((kept.reason, kept.tables), ('memory', {}))

    def test_the_floor_counts_the_log(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-wal-') as folder:
            database = pathlib.Path(folder) / 'statev2.sqlite'
            database.write_bytes(b'x' * 4096)
            (pathlib.Path(folder) / 'statev2.sqlite-wal').write_bytes(b'w' * 1000)
            with patch.object(kept_lines, 'available_disk', return_value=0), patch.object(kept_lines, 'available_memory', return_value=0):
                self.assertEqual(kept_lines.start(database).measured['floorBytes'], kept_lines.disk_floor(5096))

    def test_a_dead_helpers_scratch_folder_is_removed_and_a_live_ones_kept(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-stale-') as parent:
            dead = pathlib.Path(parent) / ('%s%d-old' % (kept_lines.SCRATCH_PREFIX, 999999))
            live = pathlib.Path(parent) / ('%s%d-new' % (kept_lines.SCRATCH_PREFIX, os.getppid()))
            other = pathlib.Path(parent) / 'receipts'
            for folder in (dead, live, other):
                folder.mkdir()
            with patch.object(kept_lines, '_running', side_effect=lambda pid: pid != 999999):
                kept_lines.remove_stale(parent)
            self.assertEqual((dead.exists(), live.exists(), other.exists()), (False, True, True))


    def keeping_read(self, state, memory, disk=1 << 50):
        """(proof, kept) of a read that keeps every table's lines, `memory` the available_memory
        readings in order (the last one repeats)."""
        readings = list(memory)
        patches = [patch.object(kept_lines, 'available_memory', side_effect=lambda: readings.pop(0) if len(readings) > 1 else readings[0]),
                   patch.object(kept_lines, 'available_disk', return_value=disk), patch.object(kept_lines, 'KEEP_BYTES', 0),
                   patch.object(kept_lines, 'physical_memory', return_value=None)]
        with contextlib.ExitStack() as stack:
            for patcher in patches:
                stack.enter_context(patcher)
            with after_proof.keeping(state / 'statev2.sqlite') as kept:
                proof = update_read._read_state(state, True, None, True)
        return proof, kept

    def test_lines_stay_in_memory_while_there_is_headroom(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            plain = update_read._read_state(state, True, None, True)
            proof, kept = self.keeping_read(state, [1 << 50])
            self.assertEqual(json.dumps(proof, default=str), json.dumps(plain, default=str))
            self.assertEqual((kept.enabled, kept.place, kept.folder), (True, 'memory', None))
            self.assertTrue(kept.tables)
            for entry in kept.tables.values():
                self.assertTrue(all(isinstance(record['lines'], list) for record in entry.values()))
            kept.clear()

    def test_lines_move_to_disk_when_memory_runs_short_and_hash_the_same(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            plain = update_read._read_state(state, True, None, True)
            proof, kept = self.keeping_read(state, [1 << 50] * 3 + [0])  # The start and two tables, then none.
            self.assertEqual(json.dumps(proof, default=str), json.dumps(plain, default=str))
            self.assertEqual((kept.enabled, kept.place), (True, 'disk'))
            self.assertEqual(set(kept.tables), set(plain[3]['summary']['tables']))
            for table, entry in kept.tables.items():
                for encoding, record in entry.items():
                    self.assertTrue(record['lines'] == [] if record['count'] == 0 else isinstance(record['lines'], kept_lines.FileLines))
                    self.assertEqual(record['sha256'], continuity.joined_digest(list(record['lines'][:])))
                self.assertEqual(entry['typed']['sha256'], plain[3]['summary']['tables'][table]['sha256'])
                self.assertEqual(entry['legacy']['sha256'], plain[3]['legacy'][table]['sha256'])
            scratch = pathlib.Path(kept.folder)
            self.assertTrue(scratch.is_dir())
            kept.clear()
            self.assertFalse(scratch.exists())

    def test_the_typed_lines_need_room_for_the_legacy_lines_built_next(self):
        asked = []
        real = kept_lines.memory_room
        kept = kept_lines.Kept(True, None, ('t',))
        with patch.object(kept_lines, 'memory_room', side_effect=lambda need=0: asked.append(need) or True):
            kept.keeper('t', 'typed')(['ab', 'cde'])
            kept.keeper('t', 'legacy')(['ab', 'cde'])
        self.assertEqual(asked, [5, 0])
        with patch.object(kept_lines, 'available_memory', return_value=(9 << 30) + 4), \
                patch.object(kept_lines, 'physical_memory', return_value=None):
            self.assertTrue(real(4))
            self.assertFalse(real(5 << 30))

    def test_without_room_in_memory_or_on_disk_nothing_is_kept_and_the_proof_reads_in_full(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            plain = update_read._read_state(state, True, None, True)
            proof, kept = self.keeping_read(state, [1 << 50] * 2 + [0], disk=0)
            self.assertEqual(json.dumps(proof, default=str), json.dumps(plain, default=str))
            self.assertEqual((kept.reason, kept.tables, kept.folder), ('memory', {}, None))
            progress, laps = {}, []
            with patch.object(after_proof, 'discard'):
                self.assertIsNone(after_proof.decide(state, {'clone': 'unused'}, kept, None, None, False, progress, laps.append))
            self.assertEqual((progress['afterProof'], laps), ({'mode': 'full', 'reason': 'memory'}, []))

    def test_a_full_disk_while_moving_lines_out_of_memory_keeps_nothing(self):
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as folder:
            state = pathlib.Path(folder) / 'userdata'
            build(state)
            plain = update_read._read_state(state, True, None, True)
            with patch.object(kept_lines.FileLines, '__init__', side_effect=OSError(28, 'No space left on device')):
                proof, kept = self.keeping_read(state, [1 << 50] * 3 + [0])
            self.assertEqual(json.dumps(proof, default=str), json.dumps(plain, default=str))
            self.assertEqual((kept.reason, kept.tables), ('disk-full', {}))
            self.assertFalse(pathlib.Path(kept.folder).exists())

    def test_a_failed_update_lets_the_lines_go_before_its_rollback_read(self):
        with patch.object(kept_lines, 'memory_room', return_value=True):
            kept = kept_lines.Kept(True, None, ('t',))
            kept.keeper('t', 'typed')(['a'])
        self.assertTrue(kept.tables)
        after_proof.abandon({}, kept)
        self.assertEqual((kept.reason, kept.tables), ('failed', {}))
        with tempfile.TemporaryDirectory(prefix='studio-kept-') as parent:  # On disk: the scratch folder goes too.
            with patch.object(kept_lines, 'available_disk', return_value=1 << 50):
                kept = kept_lines.Kept(True, None, ('t',), folder=kept_lines._scratch(parent))
                kept.keeper('t', 'typed')(['a', 'b'])
            folder = pathlib.Path(kept.folder)
            self.assertTrue(any(folder.iterdir()))
            after_proof.abandon({}, kept)
            self.assertFalse(folder.exists())
        after_proof.abandon({})  # Without kept lines, as before.
        source = (pathlib.Path(__file__).parent / 'update.py').read_text()
        handler = source[source.index('    except BaseException as error:'):]
        self.assertLess(handler.index('after_proof.abandon(held, kept)'), handler.index('snapshot('))
        # The keeping read is told what the backup still needs on disk after it.
        self.assertIn("after_proof.keeping(own / 'userdata' / 'statev2.sqlite', backup_space_needed(", source)

    def test_the_first_place_lines_go(self):
        with tempfile.NamedTemporaryFile() as handle:
            handle.write(b'x' * 4096)
            handle.flush()
            with patch.object(kept_lines, 'available_memory', return_value=1 << 50), \
                    patch.object(kept_lines, 'available_disk', return_value=1 << 50):
                kept = kept_lines.start(handle.name)
                self.assertEqual((kept.place, kept.spill is not None), ('memory', True))
            with patch.object(kept_lines, 'available_memory', return_value=1 << 50), \
                    patch.object(kept_lines, 'available_disk', return_value=0):
                kept = kept_lines.start(handle.name)
                self.assertEqual((kept.enabled, kept.place, kept.spill), (True, 'memory', None))
            with patch.object(kept_lines, 'available_memory', return_value=None), \
                    patch.object(kept_lines, 'available_disk', return_value=1 << 50):
                kept = kept_lines.start(handle.name)
                self.assertEqual((kept.enabled, kept.place), (True, 'disk'))
                kept.clear()
        with patch.object(kept_lines, 'physical_memory', return_value=128 << 30):
            self.assertEqual(kept_lines.headroom(), 16 << 30)
        with patch.object(kept_lines, 'physical_memory', return_value=None):
            self.assertEqual(kept_lines.headroom(), kept_lines.HEADROOM_BYTES)
        if sys.platform in ('darwin', 'linux'):
            self.assertGreater(kept_lines.available_memory(), 0)
            self.assertGreater(kept_lines.physical_memory(), kept_lines.available_memory() // 2)


# --measure: the proof on a clone of M4's database.

def _timed(function, *arguments):
    started = time.monotonic()
    value = function(*arguments)
    return value, round(time.monotonic() - started, 2)


def settled_in_place(db, table='orchestration_v2_projection_turn_items'):
    """(sql, parameters) rewriting the newest `table` row whose longest text holds overflow pages at
    its length, its last (ASCII) character changed; None without one. SQLite writes it in place."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
        return None
    columns = [row[1] for row in db.execute('PRAGMA table_info(%s)' % table) if row[2].upper() == 'TEXT']
    for column in columns:
        row = db.execute("SELECT rowid FROM %s WHERE length(CAST(%s AS BLOB)) > 8192 AND unicode(substr(%s, -1)) BETWEEN 32 AND 126 "
                         "ORDER BY rowid DESC LIMIT 1" % (table, column, column)).fetchone()
        if row:
            return ("UPDATE %s SET %s = substr(%s, 1, length(%s) - 1) || CASE substr(%s, -1) WHEN 'x' THEN 'y' ELSE 'x' END "
                    "WHERE rowid = %d" % (table, column, column, column, column, row[0]), [])
    return None


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
        settle = settled_in_place(db)
        db.close()
        # The agent's earlier snapshot only names where the logs ended, so the read below takes
        # the prefix path update.py's read before the restart takes.
        expected = {update_read.ACTIVITY_KEY: {'logRowids': logs, 'threadTables': [], 'threadSha256': {}, 'cursorSha256': {}}}
        # A stopped WAL database (an update's state backup) has no index; read-only opens need one,
        # which a writable connection held through the read provides. It writes nothing.
        index = None if os.path.exists(str(original) + '-shm') else sqlite3.connect(str(original))
        try:
            if index is not None:
                index.execute('SELECT count(*) FROM sqlite_master').fetchall()
            with after_proof.keeping(original) as kept:
                before, before_seconds = _timed(update_read._read_state, clone_folder, False, expected, True)
        finally:
            if index is not None:
                index.close()
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
        if settle:  # The newest projection row with overflow pages, settled at its length as on 1.0.92.
            writer.commit(settle)
            print('settled in place: %s' % settle[0], flush=True)
        progress, laps = {}, []
        reads, proof_seconds = _timed(after_proof.decide, live_folder, held, kept, reference, before[0], False, progress, laps.append)
        print('page proof: %.2f s, %s' % (proof_seconds, json.dumps(progress['afterProof'])), flush=True)
        _, release_seconds = _timed(kept.clear)  # update.py's keptRelease, after readiness; before the full read's make_room.
        print('kept lines let go: %.2f s' % release_seconds, flush=True)
        full, full_seconds = _timed(update_read._read_state, live_folder, False, before[0], True)
        print('full read of the copy: %.2f s' % full_seconds, flush=True)
        same = reads is not None and all(json.dumps(reads[index]) == json.dumps(full[index]) for index in (0, 2, 3))
        print(json.dumps({'beforeReadSeconds': before_seconds, 'pageProofSeconds': proof_seconds, 'keptReleaseSeconds': release_seconds, 'fullReadSeconds': full_seconds,
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
