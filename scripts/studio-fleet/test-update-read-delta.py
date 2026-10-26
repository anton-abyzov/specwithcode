#!/usr/bin/env python3
"""read_delta: re-reads before the restart while a held service keeps committing in its own process.

A real WAL database in a temporary folder, written only by a child process that keeps one
connection open the way the service does, and read only through the updater's read-only
connections. Whenever a re-read of only what changed returns, it must equal the full read of the
same moment exactly; protected changes must still refuse before the restart; and its cost must
follow what was committed, not the size of the database.

read_delta needs SQLite's dbstat table, which macOS /usr/bin/python3 (the interpreter the update
agent runs update.py with) has and python.org builds lack: under such a build this file runs
itself again with /usr/bin/python3."""
import os
import sqlite3
import sys


def has_dbstat(connect=sqlite3.connect):
    try:
        connect(':memory:').execute('SELECT count(*) FROM dbstat').fetchall()
        return True
    except sqlite3.Error:
        return False


SYSTEM_PYTHON = '/usr/bin/python3'
if __name__ == '__main__' and not has_dbstat() and os.path.exists(SYSTEM_PYTHON) \
        and os.path.realpath(sys.executable) != os.path.realpath(SYSTEM_PYTHON) \
        and os.environ.get('READ_DELTA_TEST_REEXEC') != '1':
    os.environ['READ_DELTA_TEST_REEXEC'] = '1'
    os.execv(SYSTEM_PYTHON, [SYSTEM_PYTHON, '-B', os.path.abspath(__file__)] + sys.argv[1:])

import contextlib
import copy
import datetime
import importlib.util
import json
import pathlib
import random
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import database_continuity as continuity
import live_database
import read_delta
import update_read


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


base_tests = module('read_delta_update_base', 'test-update.py')
update = base_tests.update
DBSTAT = has_dbstat()
needs_dbstat = unittest.skipUnless(DBSTAT, 'This SQLite has no dbstat table; read_delta reads in full')

# The service in its own process: one WAL connection, open for the whole test, that commits each
# batch of statements it is sent (one JSON list of [sql, parameters] per line) and answers "ok".
WRITER = r"""
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None, timeout=30)
db.execute('PRAGMA journal_mode=WAL')
print('ready', flush=True)
for line in sys.stdin:
    try:
        if line.startswith('checkpoint '):  # A checkpoint, outside any transaction, as SQLite runs one.
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

# auth_sessions as the service creates it (031_AuthAuthorizationScopes), with the index on it.
AUTH_SCHEMA = """
DROP TABLE auth_sessions;
CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, method TEXT, client_surface TEXT, issued_at TEXT,
    expires_at TEXT, last_connected_at TEXT, revoked_at TEXT, credential BLOB);
CREATE INDEX auth_sessions_active ON auth_sessions(revoked_at, expires_at);
CREATE TABLE checkpoint_diff_blobs(id INTEGER PRIMARY KEY, body BLOB);
INSERT INTO checkpoint_diff_blobs(body) VALUES (x'abcd'), (zeroblob(9000));
"""


def iso(moment=None):
    return (moment or datetime.datetime.now(datetime.timezone.utc)).isoformat()


def build(state, history=0, payload=1000, sessions=1):
    """The waiting-thread database, in WAL mode, with real auth sessions and `history` more events."""
    base_tests.waiting_fixture(state)
    db = sqlite3.connect(state / 'statev2.sqlite')
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript(AUTH_SCHEMA)
    now = datetime.datetime.now(datetime.timezone.utc)
    for index in range(sessions):
        db.execute('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)',
                   ('session-%d' % index, 'browser-session-cookie', 'web', iso(now - datetime.timedelta(days=1)),
                    iso(now + datetime.timedelta(days=1)), iso(now - datetime.timedelta(hours=1)), None,
                    b'synthetic-private-credential'))
    db.executemany("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,'t-idle','run.updated',?)",
                   (('history-%d' % index, 'h' * payload) for index in range(history)))
    db.commit()
    db.close()


def replace_database(database, how):
    """Puts a copy of `database` whose project title differs in its place, without a word to the
    service, which keeps its connection: renamed over it (a new inode) or copied over it in place."""
    copied = database.with_name('copy.sqlite')
    source, target = sqlite3.connect(str(database)), sqlite3.connect(str(copied))
    source.backup(target)
    source.close()
    target.execute('PRAGMA journal_mode=DELETE')
    target.execute("UPDATE projection_projects SET title='swapped'")
    target.commit()
    target.close()
    if how == 'renamed over':
        os.replace(str(copied), str(database))
    else:
        with open(str(copied), 'rb') as handle:
            body = handle.read()
        with open(str(database), 'r+b') as handle:
            handle.write(body)
            handle.truncate()
        os.unlink(str(copied))


class Writer:
    """The child process that commits as the service would."""

    def __init__(self, database):
        self.process = subprocess.Popen([sys.executable, '-c', WRITER, str(database)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)
        assert self.process.stdout.readline().strip() == 'ready'
        # A running service has a log with frames in it; a log not written yet reads in full.
        self.heartbeat()

    def commit(self, *statements):
        batch = [[sql, list(parameters)] for sql, *rest in statements for parameters in [rest[0] if rest else []]]
        self.process.stdin.write(json.dumps(batch) + '\n')
        self.process.stdin.flush()
        answer = self.process.stdout.readline().strip()
        assert answer == 'ok', answer

    def checkpoint(self, mode):
        self.process.stdin.write('checkpoint %s\n' % mode)
        self.process.stdin.flush()
        answer = self.process.stdout.readline().strip()
        assert answer.startswith('ok [(0,'), answer  # Not busy: the checkpoint ran.

    def heartbeat(self, session='session-0'):
        self.commit(('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?', [iso(), session]))

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=30)
        self.process.stdout.close()


class LiveDatabase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-read-delta-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name).resolve() / 'userdata'

    def start(self, **shape):
        build(self.state, **shape)
        writer = Writer(self.state / 'statev2.sqlite')
        self.addCleanup(writer.close)
        return writer

    def full(self, since):
        rows, _, carried, capture = update_read._read_state(self.state, False, since, True)
        return rows, carried, capture

    def base(self, since):
        position = read_delta.position(self.state / 'statev2.sqlite')
        return {'position': position, 'since': since, 'reads': self.full(since)}

    def same(self, left, right):
        self.assertEqual(continuity.encoded(left), continuity.encoded(right))


@needs_dbstat
class RereadEqualsFullRead(LiveDatabase):
    def test_heartbeats_reread_only_auth_sessions_and_equal_a_full_read(self):
        writer = self.start(sessions=3)
        since = self.full(None)[0]
        base = self.base(since)
        for session in ('session-0', 'session-2', 'session-0'):
            writer.heartbeat(session)
        delta = read_delta.reread(self.state, base, since)
        self.assertIsNotNone(delta)
        self.same(delta, self.full(since))
        self.assertNotEqual(delta[0]['hashes']['auth_sessions'], base['reads'][0]['hashes']['auth_sessions'])

    def test_no_commit_since_returns_the_earlier_read(self):
        self.start()
        since = self.full(None)[0]
        base = self.base(since)
        self.same(read_delta.reread(self.state, base, since), base['reads'])

    def test_any_other_table_or_the_schema_reads_in_full(self):
        cases = {
            'edited earlier event': ["UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1"],
            'appended event': ["INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES ('new','t-wait','x','{}')"],
            'project title': ["UPDATE projection_projects SET title='changed'"],
            'unprotected blob, same size, overflow page only': ['UPDATE checkpoint_diff_blobs SET body=zeroblob(8999)||x\'01\' WHERE id=2'],
            'unprotected blob deleted': ['DELETE FROM checkpoint_diff_blobs WHERE id=1'],
            'schedule': ["UPDATE scheduled_tasks SET cron='* * * * *'"],
            'schema': ['CREATE INDEX extra ON checkpoint_diff_blobs(body)'],
            'auth schema': ['ALTER TABLE auth_sessions ADD COLUMN client_app_version TEXT'],
            'run started': ["UPDATE orchestration_v2_projection_runs SET status='running' WHERE thread_id='t-wait'"],
        }
        for name, statements in cases.items():
            with self.subTest(name):
                self.setUp()
                writer = self.start()
                since = self.full(None)[0]
                base = self.base(since)
                writer.heartbeat()
                writer.commit(*[(sql,) for sql in statements])
                writer.heartbeat()
                self.assertIsNone(read_delta.reread(self.state, base, since))

    def test_a_reset_log_or_another_log_file_reads_in_full(self):
        for mode in ('RESTART', 'TRUNCATE'):
            with self.subTest(mode):
                self.setUp()
                writer = self.start()
                since = self.full(None)[0]
                base = self.base(since)
                writer.heartbeat()
                writer.checkpoint(mode)
                writer.heartbeat()
                self.assertIsNone(read_delta.reread(self.state, base, since))
        self.setUp()
        self.start()
        since = self.full(None)[0]
        base = self.base(since)
        moved = dict(base, position=dict(base['position'], walInode=base['position']['walInode'] + 1))
        self.assertIsNone(read_delta.reread(self.state, moved, since))

    def test_a_database_file_swapped_or_copied_over_reads_in_full(self):
        # The -wal stays the same file and generation, and the commit after the swap writes only
        # auth_sessions, yet every other table may now read otherwise: only the full read decides.
        for how in ('renamed over', 'copied in place'):
            with self.subTest(how):
                self.setUp()
                writer = self.start()
                since = self.full(None)[0]
                base = self.base(since)
                database = self.state / 'statev2.sqlite'
                replace_database(database, how)
                writer.heartbeat()
                self.assertIsNone(read_delta.reread(self.state, base, since))
                self.assertNotEqual(self.full(since)[0]['hashes']['projection_projects'],
                                    base['reads'][0]['hashes']['projection_projects'])

    def test_a_checkpoint_into_the_database_file_reads_in_full(self):
        # A checkpoint writes the database file itself, which the -wal does not show.
        writer = self.start()
        since = self.full(None)[0]
        base = self.base(since)
        writer.heartbeat()
        writer.checkpoint('PASSIVE')
        self.assertIsNone(read_delta.reread(self.state, base, since))

    def test_a_reread_that_reads_in_full_says_why(self):
        # Receipt diagnostics only: why each re-read before the restart went to a full read.
        writer = self.start()
        since = self.full(None)[0]
        base = self.base(since)
        writer.commit(("UPDATE scheduled_tasks SET cron='* * * * *'",))
        why = {}
        self.assertIsNone(read_delta.reread(self.state, base, since, why=why))
        self.assertEqual(why['reason'], 'pages-outside-auth')
        self.assertGreater(why['pagesOutsideAuth'], 0)
        self.assertLessEqual(len(why['samplePages']), 8)
        moved = dict(base, position=dict(base['position'], walInode=base['position']['walInode'] + 1))
        why = {}
        self.assertIsNone(read_delta.reread(self.state, moved, since, why=why))
        self.assertEqual(why, {'reason': 'wal-replaced'})
        writer.checkpoint('PASSIVE')
        writer.heartbeat()
        why = {}
        self.assertIsNone(read_delta.reread(self.state, base, since, why=why))
        self.assertEqual(why, {'reason': 'main-file-changed'})
        why = {}
        self.assertIsNone(read_delta.reread(self.state, dict(base, position=None), since, why=why))
        self.assertEqual(why, {'reason': 'no-position'})

    def test_appended_rows_measured_against_other_log_positions_read_in_full(self):
        writer = self.start()
        since = self.full(None)[0]
        writer.commit(("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES ('later','t-wait','x','{}')",))
        later = self.full(None)[0]
        writer.heartbeat()  # The position keeps the last commit after it, which may be unpublished.
        base = self.base(since)
        writer.heartbeat()
        self.assertIsNone(read_delta.reread(self.state, base, later))
        self.same(read_delta.reread(self.state, base, since), self.full(since))

    def test_random_commits_never_give_a_reread_that_differs_from_the_full_read(self):
        # Whatever the child commits, a re-read that returns equals the full read of that moment;
        # one that does not return leaves the decision to the full read. Chained, as update.py
        # chains them: each exact read is the next one's base.
        random_state = random.Random(985)
        writer = self.start(history=40, payload=5000, sessions=4)
        since = self.full(None)[0]
        base, returned, heartbeat_only = self.base(since), 0, 0
        operations = [
            ('heartbeat', lambda: ('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?',
                                   [iso(), 'session-%d' % random_state.randrange(4)])),
            ('auth', lambda: ('UPDATE auth_sessions SET last_connected_at=? WHERE session_id=?',
                              ['x' * random_state.randrange(1, 400), 'session-%d' % random_state.randrange(4)])),
            ('auth', lambda: ("UPDATE auth_sessions SET client_surface=? WHERE session_id='session-1'", [random_state.choice(['web', 'cli', 'desktop'])])),
            ('auth', lambda: ("INSERT OR REPLACE INTO auth_sessions VALUES (?,?,?,?,?,?,?,x'63')",
                              ['session-%d' % random_state.randrange(4, 6), 'bearer-access-token', 'cli', iso(), iso(), iso(), None])),
            ('other', lambda: ("UPDATE orchestration_events SET payload_json=? WHERE sequence=?", ['e' * 5000, random_state.randrange(1, 40)])),
            ('other', lambda: ("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) VALUES (?,'t-wait','x',?)",
                               ['r-%r' % random_state.random(), 'p' * random_state.randrange(10, 9000)])),
            ('other', lambda: ('DELETE FROM orchestration_events WHERE sequence=?', [random_state.randrange(1, 60)])),
            ('other', lambda: ('UPDATE checkpoint_diff_blobs SET body=randomblob(9000) WHERE id=2', [])),
            ('other', lambda: ("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id='t-idle'", ['{"n":%d}' % random_state.randrange(9)])),
        ]
        unread = []  # What each commit after the base's position wrote.
        for _ in range(120):
            # Mostly heartbeats, as a held service commits; now and then anything else.
            chosen = [operations[0] if random_state.random() < 0.6 else random_state.choice(operations)
                      for _ in range(random_state.randrange(1, 3))]
            writer.commit(*[make() for _, make in chosen])
            unread.append({kind for kind, _ in chosen})
            position = read_delta.position(self.state / 'statev2.sqlite')
            delta = read_delta.reread(self.state, base, since)
            full = self.full(since)
            if all(kinds == {'heartbeat'} for kinds in unread):
                heartbeat_only += 1
                self.assertIsNotNone(delta)
            if delta is not None:
                returned += 1
                self.same(delta, full)
            if random_state.random() < 0.5:  # The next check reads against this one, as update.py does.
                base, unread = {'position': position, 'since': since, 'reads': delta or full}, unread[-1:]
        self.assertGreater(heartbeat_only, 5)
        self.assertGreater(returned, heartbeat_only)  # Auth-only commits re-read too.
        self.assertGreater(120, returned)  # And every other change read in full.


@needs_dbstat
class CostFollowsCommits(LiveDatabase):
    """The re-read's work follows what was committed since, not the database's size."""

    def steps(self, read):
        # SQLite virtual machine steps of every connection the read opens: deterministic for the same data.
        counted = [0]
        real = live_database.connect
        def counting(*args, **kwargs):
            connection = real(*args, **kwargs)
            def tick():
                counted[0] += 1
                return 0
            connection.set_progress_handler(tick, 100)
            return connection
        with patch.object(live_database, 'connect', side_effect=counting):
            started = time.monotonic()
            value = read()
            return value, counted[0], time.monotonic() - started

    def measure(self, history, heartbeats, sessions=2):
        self.setUp()
        writer = self.start(history=history, payload=2000, sessions=sessions)
        since = self.full(None)[0]
        base = self.base(since)
        for index in range(heartbeats):
            writer.heartbeat('session-%d' % (index % sessions))
        runs = [self.steps(lambda: read_delta.reread(self.state, base, since)) for _ in range(3)]
        delta, delta_steps = runs[0][:2]
        self.assertEqual({run[1] for run in runs}, {delta_steps})
        delta_seconds = min(run[2] for run in runs)  # The quickest of three: no cold start or scheduler noise.
        full, full_steps, full_seconds = self.steps(lambda: self.full(since))
        self.assertIsNotNone(delta)
        self.same(delta, full)
        pages = read_delta.written_pages(self.state / 'statev2.sqlite', base['position'])
        return {'delta': delta_steps, 'full': full_steps, 'deltaSeconds': delta_seconds,
                'fullSeconds': full_seconds, 'pages': len(pages)}

    def test_a_database_twenty_times_larger_costs_the_reread_the_same(self):
        small, large = self.measure(500, 5), self.measure(10000, 5)
        self.assertGreater(large['full'], 10 * small['full'])
        self.assertLessEqual(large['delta'], small['delta'] + 5)
        self.assertLess(large['deltaSeconds'] * 20, large['fullSeconds'])

    def test_more_committed_sessions_cost_more_and_more_history_does_not(self):
        few, many = self.measure(2000, 3, sessions=2), self.measure(2000, 3, sessions=400)
        self.assertGreater(many['delta'], few['delta'])
        self.assertLess(many['delta'], many['full'])


@needs_dbstat
class ApplyWithALiveService(unittest.TestCase):
    """update.apply under the ApplyRecovery harness, the service's commits made by a child process
    at each point the held service may commit: while the release stages, as the gate settles, while
    the server browser stops, and on the new release after the restart."""

    def harness(self):
        fixture = base_tests.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        state = fixture.own / 'userdata'
        build(state)
        fixture.real_db, fixture.capture_database = True, True
        writer = Writer(state / 'statev2.sqlite')
        self.addCleanup(writer.close)
        fixture.before['rows'], _, fixture.before['databaseCapture'] = update._rows_snapshot(state, False, include_database=True)
        fixture.on_stage = writer.heartbeat
        fixture.on_restart = writer.heartbeat
        self.at_gate, self.at_stop = [writer.heartbeat], [writer.heartbeat]
        real_gate, guard = update.write_install_gate, fixture.quiescence_guard
        def gate(own, home):
            real_gate(own, home)
            for commit in self.at_gate: commit()
        def browser_stop(*args, **kwargs):
            value = guard(*args, **kwargs)
            if not fixture.restarted:
                for commit in self.at_stop: commit()
            return value
        fixture.quiescence_guard = browser_stop
        self.gate = patch.object(update, 'write_install_gate', side_effect=gate)
        self.fixture, self.writer, self.state = fixture, writer, state
        return fixture

    def run_apply(self, refusal=None, **flags):
        """apply, with the full reads (True after the restart) and whether each re-read before it
        returned. With `refusal`, apply must raise it before any restart, leaving the release as it was."""
        reads, counting = self.fixture.counted_full_reads()
        deltas = []
        real = read_delta.reread
        def counted(*args, **kwargs):
            value = real(*args, **kwargs)
            deltas.append(value is not None)
            return value
        with counting, self.gate, patch.object(read_delta, 'reread', side_effect=counted):
            if refusal is None:
                self.fixture.execute(**flags)
            else:
                with self.assertRaisesRegex(AssertionError, refusal):
                    self.fixture.execute(**flags)
                self.assertEqual((self.fixture.restart_calls, self.fixture.launchd), ([], []))
                self.assertTrue(all(path.read_bytes() == value for path, value in self.fixture.original.items()))
                self.assertNotIn(True, reads)
        return reads, deltas

    def test_heartbeats_before_the_restart_cost_no_full_read(self):
        self.harness()
        reads, deltas = self.run_apply(allow_existing_browser_heartbeat=True)
        result = json.loads(self.fixture.output.read_text())
        self.assertEqual((result['phase'], result['completeDatabaseContinuity']), ('verified', 'verified'))
        self.assertEqual(result['rowPreservation'], 'verified-existing-browser-heartbeat')
        self.assertEqual(reads, [False, True])  # The read before and the one after the restart only.
        self.assertEqual(deltas, [True, True, True])  # Prestate, after the gate, before the stop.
        self.assertIn('deltaRead', result['timings'])
        self.assertNotIn('synthetic-private', self.fixture.output.read_text())

    def test_a_heartbeat_without_the_heartbeat_proof_still_refuses_before_the_restart(self):
        self.harness()
        self.fixture.on_stage = None
        reads, deltas = self.run_apply('Native work changed before restart')
        self.assertEqual((reads, deltas), ([False], [True]))  # Re-read cheaply, and refused on what it read.

    def test_protected_changes_beside_heartbeats_still_refuse_before_the_restart(self):
        # Each change lands with heartbeats around it, at one of the points the held service commits.
        cases = [
            ('stage', ["UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1"], 'Guarded prestate changed: rows'),
            ('stage', ["DELETE FROM orchestration_v2_projection_messages WHERE thread_id='t-idle'"], 'Guarded prestate changed: rows'),
            ('stage', ["UPDATE auth_sessions SET method='bearer-access-token'"], 'Guarded prestate changed: rows'),
            ('gate', ["UPDATE checkpoint_diff_blobs SET body=x'beef' WHERE id=1"], 'Complete database changed before restart'),
            ('gate', ["UPDATE scheduled_tasks SET cron='* * * * *'"], 'Native work changed before restart'),
            ('gate', ["INSERT INTO auth_sessions VALUES ('cli','bearer-access-token','cli','2026-10-01','2099-01-01',NULL,NULL,x'00')"],
             'Native work changed before restart'),
            ('stop', ["UPDATE projection_projects SET title='changed before the stop'"], 'Native work changed before restart'),
            ('stop', ['UPDATE checkpoint_diff_blobs SET body=zeroblob(8999)||x\'01\' WHERE id=2'], 'Complete database changed before restart'),
            ('stop', ["UPDATE auth_sessions SET revoked_at='2026-10-21T00:00:00Z'"], 'Native work changed before restart'),
        ]
        for where, statements, pattern in cases:
            with self.subTest(where=where, change=statements[0]):
                self.harness()
                change = lambda statements=statements: self.writer.commit(*[(sql,) for sql in statements])
                commits = [self.writer.heartbeat, change, self.writer.heartbeat]
                if where == 'stage':
                    self.fixture.on_stage = lambda: [commit() for commit in commits]
                else:
                    (self.at_gate if where == 'gate' else self.at_stop)[:] = commits
                self.run_apply(pattern, allow_existing_browser_heartbeat=True)

    def test_a_database_file_replaced_before_the_stop_refuses_before_the_restart(self):
        for how in ('renamed over', 'copied in place'):
            with self.subTest(how):
                self.harness()
                def replace(how=how):
                    replace_database(self.state / 'statev2.sqlite', how)
                    self.writer.heartbeat()
                self.at_stop[:] = [self.writer.heartbeat, replace]
                reads, deltas = self.run_apply('Native work changed before restart', allow_existing_browser_heartbeat=True)
                self.assertEqual(deltas, [True, True, False])

    def test_events_appended_before_the_first_read_leave_the_later_checks_cheap(self):
        # The agent's snapshot is older than the helper's first read; only heartbeats follow it.
        self.harness()
        self.writer.commit(("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) "
                            "VALUES ('appended','t-wait','x','{}')",))
        self.writer.heartbeat()  # The last commit before a read is never taken as published.
        reads, deltas = self.run_apply(allow_existing_browser_heartbeat=True)
        result = json.loads(self.fixture.output.read_text())
        self.assertEqual((result['phase'], result['rowPreservation']), ('verified', 'verified-existing-browser-heartbeat'))
        self.assertEqual(reads, [False, True])
        self.assertEqual(deltas, [True, True, True])

    def test_a_log_reset_between_the_reads_reads_in_full_and_installs(self):
        self.harness()
        def reset():
            self.writer.heartbeat()
            self.writer.checkpoint('TRUNCATE')
            self.writer.heartbeat()
        self.at_gate[:] = [reset]
        reads, deltas = self.run_apply(allow_existing_browser_heartbeat=True)
        self.assertEqual(json.loads(self.fixture.output.read_text())['phase'], 'verified')
        self.assertEqual(reads, [False, False, True])  # The check after the gate, then the stop's re-read chains on it.
        self.assertEqual(deltas, [True, False, True])


    def held(self, at_stop=()):
        """The live harness as a held admission: the helper takes its own baseline. The held
        service appends an event while the release stages (the tail of a turn it interrupted),
        then only what `at_stop` commits while the server browser stops. Returns the full reads,
        the receipt, the after-proof mark as confirmed, and every -wal position taken and every
        base re-read against, in order."""
        fixture = self.harness()
        now = datetime.datetime.now(datetime.timezone.utc)
        updates = fixture.own / 'updates'
        updates.mkdir(exist_ok=True)
        (updates / 'hold.json').write_text(json.dumps({'schemaVersion': 1, 'pid': 100, 'startedAt': iso(now - datetime.timedelta(seconds=1)),
                                                       'expiresAt': iso(now + datetime.timedelta(minutes=5))}))
        (updates / 'config.json').write_text(json.dumps({'installMode': 'force', 'installRequestedAt': iso(now)}))
        fixture.before.update(snapshotMode='held-service', installRequestedAt=iso(now), rows={'nativeWorkIdle': True, 'counts': {}})
        fixture.before.pop('databaseCapture')
        def tail():
            self.writer.commit(("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) "
                                "VALUES ('turn-tail','t-wait','x','{}')",))
            self.writer.heartbeat()  # The last commit before a read is never taken as published.
        fixture.on_stage = tail
        self.at_gate[:], self.at_stop[:] = [], list(at_stop)
        service = {'own': fixture.own, 'home': fixture.home,
                   'runtime': {'pid': 100, 'startedAt': iso(now - datetime.timedelta(minutes=5))}}
        marks, confirm = [], update.after_proof.confirm
        def confirming(marked, *args):
            confirm(marked, *args)
            marks.append(dict(marked) if isinstance(marked, dict) else marked)
        events, position, reread = [], read_delta.position, read_delta.reread
        def positioned(*args):
            value = position(*args)
            events.append(('position', value))
            return value
        def rereading(state, base, since, **kwargs):
            events.append(('reread', base['position']))
            return reread(state, base, since, **kwargs)
        with patch.object(update, '_service', return_value=service), patch.object(update.after_proof, 'confirm', side_effect=confirming), \
                patch.object(read_delta, 'position', side_effect=positioned), patch.object(read_delta, 'reread', side_effect=rereading):
            reads, _ = self.run_apply(allow_existing_browser_heartbeat=True)
        result = json.loads(self.fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(len(marks), 1)
        self.assertIn('reader', marks[0])  # A mark the proof after the restart may start from.
        return reads, result, marks[0], events

    def test_a_held_commit_while_staging_is_reused_and_confirms_the_mark(self):
        # #777 reuses the prestate read after the gate; #763's mark is confirmed against it.
        reads, result, marked, events = self.held()
        self.assertEqual(reads, [False, False, True])  # The before-read, the prestate check, after the restart.
        self.assertEqual([kind for kind, _ in events], ['position', 'position', 'reread'])  # Before, prestate.
        self.assertTrue(marked['confirmed'])

    def test_a_held_commit_after_the_reused_read_is_read_against_it_and_unconfirmed(self):
        # passed[0] and base['before'] advance together on the reused read: the last check before
        # the stop re-reads against the prestate read's -wal position, and the mark is not confirmed.
        def commit():
            self.writer.commit(("INSERT INTO orchestration_events(event_id,stream_id,event_type,payload_json) "
                                "VALUES ('after-prestate','t-wait','x','{}')",))
            self.writer.heartbeat()
        reads, result, marked, events = self.held(at_stop=[commit])
        self.assertEqual(reads, [False, False, False, True])  # The last check before the stop reads again.
        positions = [value for kind, value in events if kind == 'position']
        rereads = [value for kind, value in events if kind == 'reread']
        self.assertEqual(len(positions), 3)
        self.assertIsNotNone(positions[1])
        self.assertIs(rereads[-1], positions[1])  # The prestate read's position, not the before-read's.
        self.assertIsNot(positions[1], positions[0])
        self.assertFalse(marked['confirmed'])
        self.assertEqual([miss['against'] for miss in result['readDeltaMisses']], ['expected', 'before'])


if __name__ == '__main__':
    unittest.main()
