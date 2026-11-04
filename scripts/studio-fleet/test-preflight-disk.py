#!/usr/bin/env python3
"""`update.py room` and the release's disk preflight (scripts/release/preflight_fleet.py), 1239 AC-01.

Reproduces M4's 1.0.180 to 1.0.184 update, which ran out of scratch after its service stopped: a
22 GB database whose largest table (orchestration_events) is 11.5 GB, 15 GB free, a FULL_READ
migration pending. Free space comes from a fake statvfs; every home is a temporary folder.
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from collections import namedtuple
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'release'))

import disk_room  # noqa: E402
import kept_lines  # noqa: E402
import preflight_fleet  # noqa: E402
import state_backup  # noqa: E402

GB = 10 ** 9
DATABASE = 22 * GB
LARGEST = 11_500_000_000
VERSION = '1.0.184'
StatVfs = namedtuple('StatVfs', 'f_bavail f_frsize')


def fake_statvfs(free):
    return lambda path: StatVfs(free // 4096, 4096)


class Home(object):
    """A temporary private home with one identity, its updates folder and a state database whose
    newest migration is `migration`; `size` makes the file that long (sparse) after it is written."""
    def __init__(self, test, identity='m4', migration=68, size=None):
        folder = tempfile.TemporaryDirectory(prefix='studio-room-')
        test.addCleanup(folder.cleanup)
        self.home = pathlib.Path(folder.name).resolve()
        self.own = self.home / '.specwithcode' / identity
        (self.own / 'userdata').mkdir(parents=True)
        (self.own / 'updates').mkdir()
        (self.own / 'installation.json').write_text('{}')
        self.database = self.own / 'userdata' / 'statev2.sqlite'
        db = sqlite3.connect(str(self.database))
        db.executescript("PRAGMA journal_mode=WAL;CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT);"
                         "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, body TEXT);")
        db.execute('INSERT INTO effect_sql_migrations VALUES (?, ?, ?)', (migration, 'now', 'm'))
        db.executemany('INSERT INTO orchestration_events(body) VALUES (?)', [('x' * 500,)] * 200)
        db.commit()
        db.close()
        if size:
            os.truncate(str(self.database), size)  # Sparse: the size backups are measured by, no data.


class RoomReport(unittest.TestCase):
    def m4_184(self, free):
        """The 1.0.184 case: 069 (FULL_READ) pending, largest table 11.5 GB, 22 GB file."""
        home = Home(self, size=DATABASE)
        with patch.object(os, 'statvfs', fake_statvfs(free)):
            report = disk_room.room(home.home, 'm4', VERSION, live=lambda database: 68, largest=lambda database: LARGEST)
        return home, report

    def test_m4_1_0_184_is_refused(self):
        home, report = self.m4_184(15 * GB)
        backup = state_backup.backup_space_needed(home.own, home.home, state_backup._clonefile())[0]
        fallback = int(disk_room.FULL_READ_LINE_FACTOR * LARGEST) + kept_lines.DISK_FLOOR_MARGIN
        self.assertFalse(report['ok'])
        self.assertEqual(report['fullReadMigrations'], [69])
        self.assertEqual(report['parts'], {'fallback': fallback, 'backup': backup, 'staged': disk_room.STAGED_RELEASE_BYTES})
        self.assertEqual(report['needBytes'], fallback + backup + disk_room.STAGED_RELEASE_BYTES)
        self.assertGreater(report['needBytes'], 34 * GB)  # About 34 GB, as the receipt's floor found out.
        self.assertEqual(report['freeBytes'], 15 * GB // 4096 * 4096)
        self.assertEqual(report['volume'], str(home.own / 'updates'))
        self.assertEqual((report['identity'], report['version'], report['stagedFrom']), ('m4', VERSION, 'estimate'))
        line = disk_room.describe(report)
        self.assertIn('m4: needs %.1f GB, 15.0 GB free' % (report['needBytes'] / GB), line)
        self.assertTrue(line.endswith('SHORT'))

    def test_enough_room_without_pending_migrations_is_ok(self):
        home = Home(self, migration=72, size=DATABASE)
        with patch.object(os, 'statvfs', fake_statvfs(60 * GB)):
            report = disk_room.room(home.home, 'm4', VERSION, largest=lambda database: self.fail('walked'))
        self.assertTrue(report['ok'])
        self.assertEqual((report['installedMigration'], report['fullReadMigrations']), (72, []))
        self.assertEqual(report['parts']['fallback'], 0)
        self.assertEqual(report['needBytes'], report['parts']['backup'] + report['parts']['staged'])

    def test_same_case_with_room_is_ok(self):
        _, report = self.m4_184(60 * GB)
        self.assertTrue(report['ok'])

    def test_staged_release_is_estimated_from_what_is_on_disk(self):
        home = Home(self)
        downloads = home.own / 'updates' / 'downloads' / VERSION
        downloads.mkdir(parents=True)
        (downloads / 'specwithcode-runtime.tar.gz').write_bytes(b'z' * 1000)
        self.assertEqual(disk_room.staged_release_bytes(home.own, home.home, VERSION), (3000, 'downloaded-archive'))
        release = home.home / '.specwithcode' / 'install' / 'releases' / ('a' * 20)
        release.mkdir(parents=True)
        (release / 'studio-manifest.json').write_text(json.dumps({'version': VERSION}))
        self.assertEqual(disk_room.staged_release_bytes(home.own, home.home, VERSION), (0, 'in-release-store'))
        self.assertEqual(disk_room.staged_release_bytes(home.own, home.home, '1.0.185'),
                         (disk_room.STAGED_RELEASE_BYTES, 'estimate'))

    def test_runs_held_in_memory_need_memory(self):
        home = Home(self)
        with patch.object(kept_lines, 'spill_folder', return_value=None), \
             patch.object(kept_lines, 'memory_room', return_value=False), \
             patch.object(os, 'statvfs', fake_statvfs(60 * GB)):
            report = disk_room.room(home.home, 'm4', VERSION, live=lambda database: 68, largest=lambda database: LARGEST)
        self.assertFalse(report['ok'])
        self.assertEqual(report['parts']['fallback'], 0)
        self.assertEqual(report['fallbackMemoryBytes'], int(disk_room.FULL_READ_LINE_FACTOR * LARGEST))

    def test_no_database_or_bad_arguments_cannot_tell(self):
        home = Home(self)
        home.database.unlink()
        with self.assertRaisesRegex(disk_room.RoomError, 'no state database'):
            disk_room.room(home.home, 'm4', VERSION)
        with self.assertRaisesRegex(disk_room.RoomError, 'Invalid identity'):
            disk_room.room(home.home, '../m4', VERSION)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(disk_room.main(['--version', VERSION, '--json', '--home', str(home.home)]), 2)
        self.assertIn('no state database', json.loads(out.getvalue())['error'])


class UpdateRoomCommand(unittest.TestCase):
    """`update.py room --version <v> --json`: the same report, through update_apply's readers."""
    def setUp(self):
        spec = importlib.util.spec_from_file_location('room_update', HERE / 'update.py')
        self.update = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.update)

    def run_room(self, home, free, *extra):
        out = io.StringIO()
        argv = ['update.py', 'room', '--version', VERSION, '--json', '--home', str(home.home)] + list(extra)
        with patch.object(sys, 'argv', argv), patch.object(os, 'statvfs', fake_statvfs(free)), \
             contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as code:
            self.update.main()
        return code.exception.code, json.loads(out.getvalue())

    def test_exit_status_and_keys(self):
        home = Home(self, size=DATABASE)
        service = sqlite3.connect(str(home.database))  # The running service's connection: its -shm exists.
        self.addCleanup(service.close)
        service.execute('SELECT count(*) FROM effect_sql_migrations').fetchone()
        with patch.object(self.update.update_apply, 'largest_table_bytes', return_value=LARGEST) as walk:
            code, report = self.run_room(home, 15 * GB)
        self.assertEqual(code, 1)
        walk.assert_called_once()
        self.assertTrue({'identity', 'version', 'freeBytes', 'needBytes', 'parts', 'ok', 'volume'} <= set(report))
        self.assertEqual(set(report['parts']), {'fallback', 'backup', 'staged'})
        self.assertEqual((report['identity'], report['installedMigration'], report['ok']), ('m4', 68, False))
        code, report = self.run_room(home, 80 * GB, '--identity', 'm4')
        self.assertEqual((code, report['ok']), (0, True))


    def test_stopped_service_is_read_without_its_snapshot(self):
        home = Home(self)
        self.assertFalse(pathlib.Path(str(home.database) + '-shm').exists())
        with patch.object(self.update.update_apply, 'largest_table_bytes', side_effect=AssertionError('snapshot walk')):
            code, report = self.run_room(home, 80 * GB)
        self.assertEqual((code, report['ok'], report['installedMigration'], report['fullReadMigrations']), (0, True, 68, [69]))
        expected = int(disk_room.FULL_READ_LINE_FACTOR * disk_room.largest_table_bytes(home.database)) + kept_lines.DISK_FLOOR_MARGIN
        self.assertEqual(report['parts']['fallback'], expected)
        self.assertLess(expected, kept_lines.DISK_FLOOR_MARGIN + home.database.stat().st_size * 3)
        for suffix in ('-wal', '-shm'):  # Read as immutable: nothing of its own left beside the file.
            self.assertFalse(pathlib.Path(str(home.database) + suffix).exists(), suffix)


class StreamedProbe(unittest.TestCase):
    def test_streamed_sources_boot_alone_and_report_the_same(self):
        """What preflight_fleet sends a worker, run by a fresh interpreter outside this folder."""
        home = Home(self, identity='m1')
        free = 15 * GB
        prefix = 'import os, collections\nos.statvfs = lambda path: collections.namedtuple("S", "f_bavail f_frsize")(%d, 4096)\n' % (free // 4096)
        program = prefix + preflight_fleet.program(['--identity', 'm1', '--version', VERSION, '--json', '--home', str(home.home)])
        result = subprocess.run([sys.executable, '-B', '-I', '-'], input=program, capture_output=True, text=True,
                                timeout=60, cwd=str(home.home))
        streamed = json.loads(result.stdout.splitlines()[-1])
        with patch.object(os, 'statvfs', fake_statvfs(free)):
            local = disk_room.room(home.home, 'm1', VERSION)
        self.assertEqual(result.returncode, 0 if local['ok'] else 1, result.stderr)
        for key in ('identity', 'needBytes', 'freeBytes', 'parts', 'ok', 'fullReadMigrations', 'volume'):
            self.assertEqual(streamed[key], local[key], key)
        self.assertEqual(streamed['fullReadMigrations'], [69])


class FleetPreflight(unittest.TestCase):
    """preflight_fleet: every host asked, each failure naming its host, need and free space."""
    SHORT = {'identity': 'm1', 'version': VERSION, 'needBytes': 35_600_000_000, 'freeBytes': 15 * GB, 'ok': False,
             'volume': '/Users/w/.specwithcode/m1/updates', 'fullReadMigrations': [69],
             'parts': {'fallback': 30_170_000_000, 'backup': 4_350_000_000, 'staged': 1 << 30}}

    def report(self, identity, need, free):
        return {'identity': identity, 'version': VERSION, 'needBytes': need, 'freeBytes': free, 'ok': free >= need,
                'volume': '/v/' + identity, 'fullReadMigrations': [], 'parts': {'fallback': 0, 'backup': need, 'staged': 0}}

    def plan(self):
        return [(identity, [identity], None, 5) for identity in ('m4', 'm1', 'm3')]

    def run_preflight(self, answers, headroom=preflight_fleet.BUILD_HEADROOM_GIB << 30):
        lines = []
        def run(command, **kwargs):
            answer = answers[command[0]]
            if isinstance(answer, Exception):
                raise answer
            return subprocess.CompletedProcess(command, answer[0], answer[1], answer[2] if len(answer) > 2 else '')
        ok = preflight_fleet.preflight(VERSION, self.plan(), headroom, run=run, say=lines.append)
        return ok, lines

    def test_short_host_is_named_with_need_and_free(self):
        ok, lines = self.run_preflight({'m4': (0, json.dumps(self.report('m4', 5 * GB, 400 * GB))),
                                        'm1': (1, json.dumps(self.SHORT)),
                                        'm3': (0, json.dumps(self.report('m3', 5 * GB, 100 * GB)))})
        self.assertFalse(ok)
        self.assertIn('m1: FAILED, short of disk, needs 35.6 GB, 15.0 GB free on /Users/w/.specwithcode/m1/updates '
                      '(fallback 30.2 GB for migration 069', lines[1])
        self.assertTrue(lines[0].startswith('m4: ok') and lines[2].startswith('m3: ok'), lines)
        self.assertIn('m1 is not ready for 1.0.184', lines[-1])

    def test_unreachable_hosts_are_failures_not_skips(self):
        ok, lines = self.run_preflight({'m4': (0, json.dumps(self.report('m4', 5 * GB, 400 * GB))),
                                        'm1': (255, '', 'ssh: connect to host m1 port 22: Operation timed out'),
                                        'm3': subprocess.TimeoutExpired(['m3'], 5)})
        self.assertFalse(ok)
        self.assertIn('m1: FAILED, could not be asked: gave no answer (exit 255: ssh: connect to host', lines[1])
        self.assertIn('m3: FAILED, could not be asked: did not answer within 5s', lines[2])
        self.assertIn('m1, m3 are not ready', lines[-1])

    def test_m4_needs_build_headroom_too(self):
        answers = {'m4': (0, json.dumps(self.report('m4', 5 * GB, 5 * GB + (6 << 30)))),
                   'm1': (0, json.dumps(self.report('m1', GB, 50 * GB))), 'm3': (0, json.dumps(self.report('m3', GB, 50 * GB)))}
        ok, lines = self.run_preflight(answers)
        self.assertFalse(ok)
        self.assertIn('m4: FAILED, short of disk, needs %.1f GB' % ((5 * GB + (10 << 30)) / GB), lines[0])
        self.assertIn('+ 10.7 GB build headroom', lines[0])
        ok, lines = self.run_preflight(answers, headroom=preflight_fleet.headroom_bytes({'RELEASE_BUILD_HEADROOM_GIB': '4'}))
        self.assertTrue(ok, lines)
        self.assertEqual(lines[-1], 'disk preflight: m4, m1, m3 have room for 1.0.184')

    def test_headroom_setting_never_turns_the_check_off(self):
        self.assertEqual(preflight_fleet.headroom_bytes({}), 10 << 30)
        self.assertEqual(preflight_fleet.headroom_bytes({'RELEASE_BUILD_HEADROOM_GIB': '0'}), 0)
        for value in ('-1', 'off', 'nan', 'inf'):
            with self.assertRaises(ValueError):
                preflight_fleet.headroom_bytes({'RELEASE_BUILD_HEADROOM_GIB': value})
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as code:
            preflight_fleet.main(['--version', VERSION], environ={'RELEASE_BUILD_HEADROOM_GIB': 'skip'})
        self.assertEqual(code.exception.code, 2)
        # Zero headroom still asks every host.
        ok, _ = self.run_preflight({'m4': (0, json.dumps(self.report('m4', GB, 2 * GB))), 'm1': (1, json.dumps(self.SHORT)),
                                    'm3': (0, json.dumps(self.report('m3', GB, 2 * GB)))}, headroom=0)
        self.assertFalse(ok)

    def test_missing_inventory_fails(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(pathlib.Path(folder) / 'none.json')}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(preflight_fleet.main(['--version', VERSION], run=lambda *a, **k: self.fail('ran')), 1)
        self.assertIn('the fleet cannot be asked: Fleet inventory not found', out.getvalue())

    def test_plan_asks_m4_locally_and_each_worker_over_pinned_ssh(self):
        with tempfile.TemporaryDirectory() as folder:
            inventory = pathlib.Path(folder) / 'hosts.json'
            inventory.write_text(json.dumps({'m1': {'host': 'm1.example', 'user': 'a'}, 'm3': {'host': 'm3.example', 'user': 'b'}}))
            with patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(inventory)}):
                plan = preflight_fleet.hosts(VERSION, home=folder)
        self.assertEqual([identity for identity, *_ in plan], ['m4', 'm1', 'm3'])
        self.assertEqual(plan[0][1][-6:], ['room', '--identity', 'm4', '--version', VERSION, '--json'])
        self.assertTrue(plan[0][1][2].endswith('scripts/studio-fleet/update.py'))
        self.assertEqual(plan[1][1][0], '/usr/bin/ssh')
        self.assertIn('a@m1.example', plan[1][1])
        self.assertIn("'--identity', 'm1'", plan[1][2])
        self.assertIn("sys.modules['disk_room'].main(argv)", plan[1][2])


if __name__ == '__main__':
    unittest.main()
