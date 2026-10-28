#!/usr/bin/env python3
"""read_watermark: a real WAL database in a temporary folder, written the way the service writes
(one long-lived writer connection), and read only through the watermark's read-only connection.
Any commit, replaced file, checkpoint, VACUUM or reconnect must answer "changed"; a pure read
must not, or the watermark would never let a re-read go."""
import importlib.util
import os
import pathlib
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import live_database
import read_delta
import read_watermark
import update

# A service in its own process: one WAL writer that commits a row, then stays open until told to
# close (its close is the last one, which checkpoints and removes -wal and -shm when it can).
SERVICE = """
import os, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE IF NOT EXISTS rows(id INTEGER PRIMARY KEY, value TEXT)')
db.execute('INSERT INTO rows(value) VALUES (?)', ('from %d' % os.getpid(),))
db.commit()
print('ready', flush=True)
sys.stdin.readline()
db.close()
"""
# A checkpoint that moves every commit into the database file and empties the log.
CHECKPOINT = """
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0, 'checkpoint busy'
db.close()
"""
# Who holds the -shm dead-man-switch byte, as another process sees it.
INDEX_HOLDER = """
import sys
sys.path.insert(0, sys.argv[2])
import live_database
import read_delta
print(live_database.lock_holder(sys.argv[1] + '-shm', live_database.SHM_DMS, 1))
"""


class Database:
    def __init__(self, folder):
        self.path = pathlib.Path(folder) / 'statev2.sqlite'
        self.writer = None
        self.open()
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.execute('CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT)')
        self.writer.executemany('INSERT INTO rows(value) VALUES (?)', [('row-%d' % index,) for index in range(50)])
        self.writer.commit()

    def open(self):
        self.writer = sqlite3.connect(str(self.path))
        self.writer.execute('PRAGMA wal_autocheckpoint=0')

    def write(self, statement, *parameters):
        self.writer.execute(statement, parameters)
        self.writer.commit()

    def close(self):
        if self.writer is not None:
            self.writer.close()
            self.writer = None


class WatermarkTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='studio-read-watermark-')
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.database = Database(self.folder)
        self.addCleanup(self.database.close)
        self.watermark = read_watermark.Watermark.open(self.database.path)
        self.addCleanup(self.watermark.close)

    def test_nothing_changed_lets_the_read_stand(self):
        mark = self.watermark.take()
        self.assertIsNotNone(mark)
        # Another reader is not a change.
        reader = sqlite3.connect(str(self.database.path))
        self.assertEqual(reader.execute('SELECT count(*) FROM rows').fetchone()[0], 50)
        reader.close()
        self.assertTrue(self.watermark.unchanged(mark))
        self.assertTrue(self.watermark.unchanged(mark))

    def test_a_commit_from_another_connection_flips_it(self):
        mark = self.watermark.take()
        self.database.write("UPDATE rows SET value='changed' WHERE id=1")
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_same_size_rewrite_in_place_flips_it(self):
        self.database.write('PRAGMA wal_checkpoint(TRUNCATE)')
        mark = self.watermark.take()
        self.database.write("UPDATE rows SET value='row-x' WHERE id=2")  # Same length as row-2.
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_replaced_file_flips_it(self):
        self.database.write('PRAGMA wal_checkpoint(TRUNCATE)')
        mark = self.watermark.take()
        copy = self.folder / 'copy.sqlite'
        shutil.copyfile(self.database.path, copy)
        os.replace(copy, self.database.path)  # The same bytes under a new inode (a restore).
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_truncating_checkpoint_flips_it(self):
        self.database.write("INSERT INTO rows(value) VALUES ('in the log')")
        mark = self.watermark.take()
        self.assertGreater(mark['walSize'], 0)
        self.database.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_log_reset_flips_it(self):
        self.database.write("INSERT INTO rows(value) VALUES ('first')")
        self.database.writer.execute('PRAGMA wal_checkpoint(PASSIVE)').fetchall()
        mark = self.watermark.take()
        self.database.write("INSERT INTO rows(value) VALUES ('after the reset')")  # Restarts the log: new salts.
        now = self.watermark.take()
        self.assertNotEqual(now['walSalt'], mark['walSalt'])
        self.assertFalse(self.watermark.unchanged(mark))

    def test_vacuum_flips_it(self):
        self.database.write('DELETE FROM rows WHERE id > 10')
        mark = self.watermark.take()
        self.database.writer.execute('VACUUM')
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_reconnect_forces_a_full_read(self):
        mark = self.watermark.take()
        self.watermark.close()
        self.assertFalse(self.watermark.unchanged(mark))
        again = self.watermark.take()
        self.assertEqual(again['generation'], mark['generation'] + 1)
        self.assertTrue(self.watermark.unchanged(again))

    def test_a_failed_read_reconnects_and_forces_a_full_read(self):
        mark = self.watermark.take()
        class Broken:
            in_transaction = False
            def execute(self, *args):
                raise sqlite3.OperationalError('disk I/O error')
            def close(self):
                pass
        self.watermark.connection = Broken()
        self.assertIsNone(self.watermark.take())
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_connection_inside_a_read_transaction_is_never_trusted(self):
        mark = self.watermark.take()
        self.watermark.connection.execute('BEGIN')
        self.watermark.connection.execute('SELECT count(*) FROM rows').fetchall()
        self.database.write("UPDATE rows SET value='hidden by the snapshot' WHERE id=3")
        self.assertFalse(self.watermark.unchanged(mark))

    def test_a_missing_database_never_answers_unchanged(self):
        missing = read_watermark.Watermark.open(self.folder / 'absent' / 'statev2.sqlite')
        self.addCleanup(missing.close)
        self.assertIsNone(missing.take())
        self.assertFalse(missing.unchanged(None))
        self.assertFalse(missing.unchanged({'generation': missing.generation}))

    def test_random_interleavings_never_answer_unchanged_after_a_change(self):
        seed = int(os.environ.get('WATERMARK_SEED', '20261021'))
        rng = random.Random(seed)
        database = self.database

        def insert():
            database.write('INSERT INTO rows(value) VALUES (?)', 'r%d' % rng.randrange(10 ** 6))

        def update_one():
            database.write('UPDATE rows SET value=? WHERE id=(SELECT min(id) FROM rows)', 'u%d' % rng.randrange(10 ** 6))

        def delete_one():
            database.write('DELETE FROM rows WHERE id=(SELECT max(id) FROM rows)')

        def rewrite_same():
            # Writes a row back with its own value: SQLite may commit no page at all, and then
            # nothing changed; only a different content below requires "changed".
            database.write('UPDATE rows SET value=value WHERE id=(SELECT min(id) FROM rows)')

        def other_writer():
            other = sqlite3.connect(str(database.path))
            other.execute('INSERT INTO rows(value) VALUES (?)', ('other-%d' % rng.randrange(10 ** 6),))
            other.commit()
            other.close()

        def reopen_and_write():
            database.close()  # The last connection checkpoints and removes the log.
            database.open()
            insert()

        def vacuum():
            database.writer.execute('VACUUM')

        def checkpoint_then_write():
            database.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
            insert()

        def read_only():
            reader = sqlite3.connect(str(database.path))
            reader.execute('SELECT count(*), max(id) FROM rows').fetchall()
            reader.close()

        writes = [insert, update_one, delete_one, rewrite_same, other_writer, reopen_and_write, vacuum,
                  checkpoint_then_write]
        def content():
            reader = sqlite3.connect(str(database.path))
            try:
                return list(reader.iterdump())
            finally:
                reader.close()

        counted = {'changed': 0, 'unchanged': 0}
        mark, before = self.watermark.take(), content()
        for step in range(1000):
            wrote = rng.random() < 0.5
            if wrote:
                rng.choice(writes)()
            elif rng.random() < 0.5:
                read_only()
            reconnected = rng.random() < 0.05
            if reconnected:
                self.watermark.close()  # A reconnect between reads: a full read is required.
            same = self.watermark.unchanged(mark)
            now = content()
            if now != before or reconnected:
                self.assertFalse(same, 'step %d (seed %d): a change answered unchanged' % (step, seed))
            before = now
            counted['unchanged' if same else 'changed'] += 1
            mark = self.watermark.take()
            self.assertIsNotNone(mark)
        # Steps without a write mostly let the read stand.
        self.assertGreater(counted['unchanged'], 300, counted)


class ServiceLockTests(unittest.TestCase):
    """The service runs in another process, as on a Mac; the helper (this process) keeps the
    watermark open while it runs update.assert_database_locked between takes."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='studio-read-watermark-service-')
        self.addCleanup(folder.cleanup)
        self.state = pathlib.Path(folder.name)
        self.path = self.state / 'statev2.sqlite'

    def service(self):
        process = subprocess.Popen([sys.executable, '-B', '-c', SERVICE, str(self.path)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is not None or process.kill())
        self.assertEqual(process.stdout.readline().strip(), 'ready')
        return process

    def stop(self, process):
        process.stdin.write('\n')
        process.stdin.flush()
        self.assertEqual(process.wait(timeout=30), 0)
        process.stdout.close()
        process.stdin.close()

    def index_holder(self):
        value = subprocess.run([sys.executable, '-B', '-c', INDEX_HOLDER, str(self.path),
                                str(pathlib.Path(__file__).resolve().parent)],
                               capture_output=True, text=True, timeout=30, check=True)
        return value.stdout.strip()

    def test_lock_checks_between_takes_keep_this_connections_locks(self):
        first = self.service()
        watermark = read_watermark.Watermark.open(self.path)
        self.addCleanup(watermark.close)
        mark = watermark.take()
        self.assertIsNotNone(mark)
        update.assert_database_locked(self.state)  # Opens and closes probes of the database and -shm.
        self.assertTrue(watermark.unchanged(mark))
        update.assert_database_locked(self.state)
        self.stop(first)
        # This connection still holds its locks, so the service's exit left -wal and -shm in place.
        self.assertTrue(os.path.exists(str(self.path) + '-shm'))
        self.assertTrue(os.path.exists(str(self.path) + '-wal'))
        self.assertEqual(self.index_holder(), str(os.getpid()))
        self.stop(self.service())  # A restarted service commits a row.
        self.assertFalse(watermark.unchanged(mark))
        watermark.close()
        self.assertEqual(self.index_holder(), 'None')  # Closing released the held probes too.

    def test_delta_positions_between_takes_keep_this_connections_locks(self):
        first = self.service()
        watermark = read_watermark.Watermark.open(self.path)
        self.addCleanup(watermark.close)
        mark = watermark.take()
        self.assertIsNotNone(read_delta.position(self.path))  # Reads the database file's header.
        self.assertTrue(watermark.unchanged(mark))
        self.stop(first)
        self.assertTrue(os.path.exists(str(self.path) + '-shm'))
        self.assertTrue(os.path.exists(str(self.path) + '-wal'))
        self.assertEqual(self.index_holder(), str(os.getpid()))

    def test_a_service_restart_on_new_files_never_answers_unchanged(self):
        # Whatever drops this connection's locks (here, a probe closed outside hold_probe), a
        # service that exits may leave no -wal and -shm, and its successor then writes to new
        # ones. This connection's data_version then never moves, so the new inodes alone must
        # say changed. python.org's SQLite removes both as its last connection closes; Apple's
        # (/usr/bin/python3, which runs update.py) keeps them, so the files the exited service
        # leaves are removed here, as a successor started on new files would find them.
        first = self.service()
        watermark = read_watermark.Watermark.open(self.path)
        self.addCleanup(watermark.close)
        first_mark = watermark.take()
        for suffix in ('', '-shm'):
            os.close(os.open(str(self.path) + suffix, os.O_RDONLY))
        self.stop(first)
        if os.path.exists(str(self.path) + '-shm'):
            # Apple's SQLite: every commit goes into the database file first (in another process,
            # as the service would), so removing the files loses nothing; the empty log shows it.
            subprocess.run([sys.executable, '-B', '-c', CHECKPOINT, str(self.path)], check=True, timeout=30)
            self.assertEqual(os.path.getsize(str(self.path) + '-wal'), 0)
            for suffix in ('-wal', '-shm'):
                os.unlink(str(self.path) + suffix)
        self.assertFalse(os.path.exists(str(self.path) + '-shm'))
        self.stop(self.service())
        second = self.service()
        self.assertIsNone(watermark.take())
        self.assertFalse(watermark.unchanged(first_mark))
        mark = watermark.take()  # Reconnected, on the files the running service has open.
        self.assertEqual(mark['generation'], first_mark['generation'] + 1)
        self.assertTrue(watermark.unchanged(mark))
        self.stop(second)


class NoRepeatedFullReadAfterADeltaMiss(unittest.TestCase):
    """A held install whose prestate re-read missed (the held service appended an event while the
    release staged) reads the whole database once more, for the prestate check. A heartbeat after
    it then re-reads only what committed since that read before the stop, never the whole database
    a second time (1.0.104: 195 s, then 109 s more), and a protected change after it still refuses."""

    def live(self):
        if not has_dbstat():
            self.skipTest('No dbstat in this SQLite (read_delta needs it)')
        spec = importlib.util.spec_from_file_location('read_watermark_delta_tests', pathlib.Path(__file__).with_name('test-update-read-delta.py'))
        loaded = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loaded)
        case = loaded.ApplyWithALiveService('run')
        self.update = loaded.update  # The update module the harness patches and runs.
        self.addCleanup(case.doCleanups)
        return case

    def held(self, case, commit):
        """case.held with `commit` made as the install gate settles, after the prestate read."""
        real = self.update.gate_settle
        def settle(*args):
            commit()
            return real(*args)
        with patch.object(self.update, 'gate_settle', side_effect=settle):
            return case.held()

    def test_a_heartbeat_after_the_prestate_full_read_is_read_against_it(self):
        case = self.live()
        reads, result, marked, events = self.held(case, lambda: case.writer.heartbeat())
        self.assertEqual(reads, [False, False, True])  # The before-read, the prestate check, after the restart.
        positions = [value for kind, value in events if kind == 'position']
        rereads = [value for kind, value in events if kind == 'reread']
        self.assertEqual(len(positions), 3)
        self.assertIs(rereads[-1], positions[1])  # Against the prestate read, not the before-read.
        self.assertEqual([miss['against'] for miss in result['readDeltaMisses']], ['expected'])
        self.assertEqual(result['readDeltaMisses'][0]['reason'], 'pages-outside-auth')
        self.assertIn('deltaRead', result['timings'])
        self.assertTrue(marked['confirmed'])  # Nothing committed after the gate's re-read.

    def test_a_protected_change_after_the_prestate_full_read_still_refuses(self):
        case = self.live()
        def change():
            case.writer.commit(("UPDATE projection_projects SET title='changed before the stop'",))
            case.writer.heartbeat()
        with self.assertRaisesRegex(AssertionError, 'Native work changed before restart'):
            self.held(case, change)
        self.assertEqual(case.fixture.restart_calls, [])


def has_dbstat():
    try:
        sqlite3.connect(':memory:').execute('SELECT count(*) FROM dbstat').fetchall()
        return True
    except sqlite3.Error:
        return False


if __name__ == '__main__':
    unittest.main()
