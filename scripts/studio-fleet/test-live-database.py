#!/usr/bin/env python3
"""live_database: reading a database another process holds without ever resetting its -shm or
removing its -wal. Synthetic databases in a temporary folder only; never a live Studio database.

The holder below stands in for the service: it keeps a WAL database open and reads through its
-shm index. 'dropped' closes a plain descriptor for -shm and the database first, which silently
drops the holder's own POSIX locks on them, as the M4 service's were on 2026-10-15 and 16. The
holder runs on the service's own SQLite (node:sqlite) when Node 22 is on PATH: Apple's system
SQLite (/usr/bin/python3) keeps its locks when another descriptor closes, so with it as the
holder the tests that need lost locks are skipped.

Run: cd scripts/studio-fleet && python3 -B test-live-database.py
"""
import contextlib
import io
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

import live_database

ROWS = 3000
HOLDER = r"""
import os, sqlite3, sys
path, mode = sys.argv[1], sys.argv[2]
db = sqlite3.connect(path, isolation_level=None)
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, v BLOB)')
db.execute('CREATE INDEX t_k ON t(k)')
db.execute('BEGIN')
db.executemany('INSERT INTO t(k, v) VALUES (?, randomblob(200))', [('k' + str(i % 97),) for i in range(ROWS)])
db.execute('COMMIT')
if mode == 'dropped':
    for name in (path + '-shm', path):
        os.close(os.open(name, os.O_RDONLY))
print('ready', flush=True)
n = 0
while True:
    for i in range(20):
        db.execute('SELECT count(*) FROM t WHERE k = ?', ('k' + str((n + i) % 97),)).fetchone()
    n += 1
""".replace('ROWS', str(ROWS))


NODE_HOLDER = r"""
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const [path, mode] = process.argv.slice(1);
const db = new DatabaseSync(path);
db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, v BLOB); CREATE INDEX t_k ON t(k);");
const insert = db.prepare("INSERT INTO t(k, v) VALUES (?, randomblob(200))");
db.exec("BEGIN");
for (let i = 0; i < ROWS; i++) insert.run("k" + (i % 97));
db.exec("COMMIT");
if (mode === "dropped") for (const name of [path + "-shm", path]) fs.closeSync(fs.openSync(name, "r"));
const select = db.prepare("SELECT count(*) AS n FROM t WHERE k = ?");
process.stdout.write("ready\n");
let n = 0;
const loop = () => {
  for (let i = 0; i < 20; i++) select.get("k" + ((n + i) % 97));
  n++;
  setImmediate(loop);
};
loop();
""".replace('ROWS', str(ROWS))


def service_sqlite_node():
    """Node 22 or newer, whose node:sqlite is the SQLite the service runs, or None."""
    node = shutil.which('node')
    if node is None:
        return None
    try:
        version = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return node if version.startswith('v') and int(version[1:].split('.')[0]) >= 22 else None


class Holder:
    def __init__(self, path, mode):
        node = service_sqlite_node()
        command = ([node, '--no-warnings', '--input-type=module', '--eval', NODE_HOLDER, str(path), mode] if node
                   else [sys.executable, '-B', '-c', HOLDER, str(path), mode])
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.process.stdout.readline().strip()
        if line != 'ready':
            self.process.kill()
            _, errors = self.process.communicate(timeout=10)
            raise AssertionError('the holder did not start: ' + (errors or line or 'no output'))

    def crashed(self, within=0.3):
        """The holder's exit status, or None while it still runs `within` seconds on. A loaded host
        can take seconds to schedule the holder's next read, so a test that expects the fault
        waits longer than one that expects none."""
        deadline = time.monotonic() + within
        while self.process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        return self.process.poll()

    def errors(self):
        """What the holder wrote to stderr; call only after it exited."""
        return self.process.stderr.read()

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(10)
        self.process.stdout.close()
        self.process.stderr.close()


class LiveDatabase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        self.database = self.root / 'statev2.sqlite'

    def hold(self, mode, database=None):
        database = database or self.database
        holder = Holder(database, mode)
        self.addCleanup(holder.close)
        if mode == 'dropped' and live_database.service_locks(database) != {'database': None, 'index': None}:
            self.skipTest("this holder's SQLite keeps its locks when another descriptor closes")
        return holder

    def test_the_uri_opens_the_index_read_only_whenever_it_exists(self):
        odd = self.root / 'a b#?' / 'statev2.sqlite'
        odd.parent.mkdir()
        self.assertEqual(live_database.readonly_uri(odd), 'file:' + str(odd.parent).replace(' ', '%20')
                         .replace('#', '%23').replace('?', '%3F') + '/statev2.sqlite?mode=ro')
        self.hold('intact')
        self.assertTrue(live_database.readonly_uri(self.database).endswith('?mode=ro&readonly_shm=1'))

    def test_locks_name_the_holder_until_it_drops_them(self):
        holder = self.hold('intact')
        self.assertEqual(live_database.service_locks(self.database),
                         {'database': holder.process.pid, 'index': holder.process.pid})
        holder.close()
        self.database.unlink()
        for name in ('statev2.sqlite-wal', 'statev2.sqlite-shm'):
            (self.root / name).unlink(missing_ok=True)
        self.hold('dropped')
        self.assertEqual(live_database.service_locks(self.database), {'database': None, 'index': None})

    @unittest.skipUnless(sys.platform == 'darwin', 'the truncated index faults at the 16 KiB page on macOS')
    def test_a_plain_read_only_open_crashes_a_holder_that_lost_its_index_lock(self):
        # The plain reader takes the holder for gone and rebuilds the index under it. The holder's
        # next read usually faults on the truncated page; on a loaded host it can land while the
        # rebuild still runs and fail with SQLITE_BUSY_RECOVERY (261), which a reader that keeps
        # the holder's index also never causes. A holder the host never schedules while the reader
        # is open finds the index rebuilt and lives on, so that one outcome gets a fresh holder.
        for attempt in range(5):
            database = self.root / str(attempt) / 'statev2.sqlite'
            database.parent.mkdir()
            holder = self.hold('dropped', database)
            reader = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True)
            reader.execute('SELECT count(*) FROM t').fetchone()
            reader.close()
            status = holder.crashed(within=30)
            if status is None:
                holder.close()
                continue
            if status != -signal.SIGBUS:
                self.assertEqual(status, 1)
                self.assertIn('errcode: 261', holder.errors())
            return
        self.fail('five holders survived a plain read-only open of their database')

    def test_the_safe_reader_never_resets_the_index_of_a_holder_that_lost_its_locks(self):
        holder = self.hold('dropped')
        inode = (self.root / 'statev2.sqlite-shm').stat().st_ino
        for _ in range(3):
            reader = live_database.connect(self.database)
            self.assertEqual(reader.execute('SELECT count(*) FROM t').fetchone()[0], ROWS)
            with self.assertRaises(sqlite3.OperationalError):
                reader.execute("INSERT INTO t(k) VALUES ('no')")
            reader.close()
            self.assertIsNone(holder.crashed())
        self.assertEqual((self.root / 'statev2.sqlite-shm').stat().st_ino, inode)

    def test_a_snapshot_is_a_checked_self_contained_copy_and_never_overwrites(self):
        self.hold('dropped')
        out = self.root / 'copies' / 'copy.sqlite'
        result = live_database.snapshot(self.database, out)
        self.assertEqual(result['quickCheck'], 'ok')
        self.assertEqual(result['path'], str(out))
        copy = sqlite3.connect(str(out))
        self.assertEqual(copy.execute('SELECT count(*) FROM t').fetchone()[0], ROWS)
        self.assertEqual(copy.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        copy.close()
        self.assertEqual(oct(out.stat().st_mode & 0o777), '0o600')
        with self.assertRaises(FileExistsError):
            live_database.snapshot(self.database, out)
        with self.assertRaises(ValueError):
            live_database.snapshot(self.database, str(self.database) + '-wal')
        self.assertEqual([p.name for p in out.parent.iterdir()], ['copy.sqlite'])

    def test_the_command_line_reports_locks_and_writes_snapshots(self):
        holder = self.hold('intact')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(live_database.main(['locks', '--database', str(self.database)]), 0)
        self.assertEqual(json.loads(output.getvalue()), {'database': holder.process.pid, 'index': holder.process.pid})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            live_database.main(['snapshot', '--database', str(self.database), '--out', str(self.root / 'cli.sqlite')])
        self.assertEqual(json.loads(output.getvalue())['quickCheck'], 'ok')
        with self.assertRaises(ValueError):
            live_database.identity_database('../m4')


if __name__ == '__main__':
    unittest.main()
