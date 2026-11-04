#!/usr/bin/env python3
"""The candidate server, restarted under an update's install gate on a linked project with memory
and a native plan, keeps every protected table unchanged while linked memory and plans sync.

M4's 1.0.179 to 1.0.180 update failed after its restart: the new service merged a linked copy's
plan into project_plans while update.py was proving the restart changed nothing, and the full read
refused ('History, provider, schedule or pairing rows changed during migration'). Fixed by
1a170559a6 (merges wait while the service is held). This runs that case on real servers:
  - two servers of this checkout (apps/server/src/bin.ts, or STUDIO_SERVER_ENTRYPOINT, a built
    bin.mjs), each on its own temporary home, with every provider off;
  - fixtures/linked-memory-state: each holds memory the other lacks, the first a native plan, and
    the two projects are one logical project (drive.mjs seed);
  - the first restarts with update.py's install gate live (updates/install-gate.json naming this
    process), as after an update's restart, and stays up PROTECTED_IDLE_SECONDS (default 120);
  - meanwhile every 10 s an app window's pass runs for the pair: memory and plan exported from each
    side and merged into the other (projectLink.memoryExport/memoryMerge, planExport/planMerge),
    so LinkedMemorySync runs on the first both ways.
Asserts that LinkedMemorySync ran there (its exports answer with the first's own notes and save
their versions under linked-memory/, its merges answer 'paused'), that every non-projection table
(update_read.is_projection_table) keeps its row count and content hash, and, once the gate is
removed, that the next pass does merge the second's notes and plan into the first: the fixture
would have written protected rows without the hold.

PROTECTED_IDLE_SECONDS may be lowered for a local run; the release and run-tests.sh use 120.
Never a live user database: every home is a temporary folder."""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest

from update_read import is_projection_table

HERE = pathlib.Path(__file__).resolve().parent
FIXTURE = HERE / 'fixtures/linked-memory-state'
IDLE_SECONDS = int(os.environ.get('PROTECTED_IDLE_SECONDS', '120'))
GATE = 'install-gate.json'  # update.py INSTALL_GATE_FILE


def node():
    found = os.environ.get('STUDIO_TEST_NODE') or shutil.which('node')
    assert found, 'Node 22 not found; set STUDIO_TEST_NODE'
    return found


def protected(path):
    """{table: [count, sha256 of every row in a fixed order]} of each non-projection table, read
    only (a running service's WAL is read as it stands)."""
    db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        found = {}
        for table in tables:
            if is_projection_table(table):
                continue
            width = len(db.execute('PRAGMA table_info("%s")' % table).fetchall())
            order = ', '.join(str(index) for index in range(1, width + 1))
            digest, count = hashlib.sha256(), 0
            for row in db.execute('SELECT * FROM "%s" ORDER BY %s' % (table, order)):
                digest.update(json.dumps(row, default=lambda value: value.hex()).encode() + b'\n')
                count += 1
            found[table] = [count, digest.hexdigest()]
        return found
    finally:
        db.close()


def merges_into(passes, target, kind):
    return [result for one in passes for result in one['results'] if result['to'] == target and result['kind'] == kind]


class ProtectedTablesAfterRestart(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='studio-protected-restart-')
        self.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name).resolve()
        self.homes = {name: self.root / name / 'state' for name in ('first', 'second')}
        self.env = dict(os.environ, PWDEBUG='0', PLAYWRIGHT_HTML_OPEN='never')

    def drive(self, *args, **kwargs):
        return subprocess.Popen([node(), '--no-warnings', str(FIXTURE / 'drive.mjs'), *map(str, args)], env=self.env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, **kwargs)

    def seed(self):
        process = self.drive('seed', FIXTURE / 'fixture.json', self.homes['first'], self.homes['second'])
        out, _ = process.communicate(timeout=600)
        self.assertEqual(process.returncode, 0, 'drive.mjs seed failed')
        machines = json.loads(out.strip().splitlines()[-1])
        (self.root / 'seed.json').write_text(json.dumps(machines))
        return machines

    def test_linked_sync_under_the_install_gate_keeps_protected_tables(self):
        machines = self.seed()
        database = self.homes['first'] / 'userdata/statev2.sqlite'
        gate = self.homes['first'] / 'updates' / GATE
        gate.parent.mkdir(parents=True, exist_ok=True)
        gate.write_text(json.dumps({'helperPid': os.getpid(), 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        before = protected(database)
        for table in ('project_memory', 'project_plans'):
            self.assertGreater(before[table][0], 0, table)

        began = time.monotonic()
        process = self.drive('passes', self.root / 'seed.json', self.homes['first'], self.homes['second'], IDLE_SECONDS)
        try:
            idle = json.loads(process.stdout.readline())
            self.assertEqual(idle['phase'], 'idle')
            self.assertGreaterEqual(time.monotonic() - began, IDLE_SECONDS)
            during = protected(database)
            gate.unlink()
            process.stdin.write('release\n')
            process.stdin.flush()
            released = json.loads(process.stdout.readline())
            self.assertEqual(process.wait(timeout=120), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdin.close()
            process.stdout.close()

        # Every protected table, sessions, pairing, schedules, history, memory and plans included,
        # is what the stopped server left.
        self.assertEqual(during, before)
        passes = idle['passes']
        self.assertGreaterEqual(len(passes), max(1, IDLE_SECONDS // 10))
        # LinkedMemorySync ran on the first: it exported its own notes every pass and saved their
        # versions, and refused every merge while held.
        own = sorted(json.loads((FIXTURE / 'fixture.json').read_text())['machines']['first']['memory'])
        exports = [result for one in passes for result in one['results'] if result['from'] == 'first' and result['kind'] == 'memory']
        self.assertTrue(exports)
        for result in exports:
            self.assertIs(result['exported'], True)
            self.assertEqual(result['exportedFiles'], own)
        self.assertTrue(any((self.homes['first'] / 'userdata/linked-memory').glob('*.versions/*')))
        for result in merges_into(passes, 'first', 'memory'):
            self.assertEqual(result['merged']['error']['code'], 'paused', result)
        for result in merges_into(passes, 'first', 'plan'):
            self.assertIs(result['merged'].get('changed'), False, result)
        # The second, not held, took the first's notes in on the first pass.
        self.assertEqual(sorted(merges_into(passes, 'second', 'memory')[0]['merged']['applied']), own)

        # Without the gate the same pass writes the first's memory and plan.
        memory = merges_into([{'results': released['pass']}], 'first', 'memory')[0]['merged']
        self.assertEqual(sorted(memory['applied']), sorted(json.loads((FIXTURE / 'fixture.json').read_text())['machines']['second']['memory']))
        after = protected(database)
        self.assertNotEqual(after['project_memory'], before['project_memory'])
        self.assertNotEqual(machines['first']['projectId'], machines['second']['projectId'])


if __name__ == '__main__':
    unittest.main()
