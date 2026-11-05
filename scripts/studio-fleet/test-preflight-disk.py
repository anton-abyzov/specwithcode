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
import threading
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

    def test_full_read_list_replaces_this_copys_full_read(self):
        """--full-read: the target release's FULL_READ numbers, for an installed copy that predates them."""
        home = Home(self, migration=72, size=DATABASE)
        with patch.object(os, 'statvfs', fake_statvfs(60 * GB)):
            later = disk_room.room(home.home, 'm4', VERSION, largest=lambda database: LARGEST, full_read=[69, 73, 75])
            none = disk_room.room(home.home, 'm4', VERSION, largest=lambda database: self.fail('walked'), full_read=[])
        self.assertEqual(later['fullReadMigrations'], [73, 75])
        self.assertEqual(later['parts']['fallback'], int(disk_room.FULL_READ_LINE_FACTOR * LARGEST) + kept_lines.DISK_FLOOR_MARGIN)
        self.assertEqual((none['fullReadMigrations'], none['parts']['fallback']), ([], 0))
        home = Home(self, migration=68, size=DATABASE)
        out = io.StringIO()
        with patch.object(os, 'statvfs', fake_statvfs(60 * GB)), contextlib.redirect_stdout(out):
            self.assertEqual(disk_room.main(['--version', VERSION, '--identity', 'm4', '--full-read', 'none', '--json',
                                             '--home', str(home.home)]), 0)
        report = json.loads(out.getvalue())
        self.assertEqual((report['fullReadMigrations'], report['parts']['fallback']), ([], 0))  # 069 not named: none.

    def test_bad_full_read_cannot_tell(self):
        self.assertEqual(disk_room.parse_full_read('73,69,69'), [69, 73])
        self.assertEqual(disk_room.parse_full_read('none'), [])
        home = Home(self)
        for value in ('', 'all', '69,', '-1', '0', '69;rm', '1e3'):
            with self.subTest(value=value):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(disk_room.main(['--version', VERSION, '--identity', 'm4', '--full-read', value,
                                                     '--json', '--home', str(home.home)]), 2)
                self.assertIn('Invalid --full-read', json.loads(out.getvalue())['error'])

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

    def test_no_inventory_is_needed_by_default(self):
        """Connect first: a missing hosts.json is no failure; M1 and M3 without a Connect route are,
        each named."""
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(pathlib.Path(folder) / 'none.json'), 'HOME': folder}):
            out = io.StringIO()
            asked = []

            def run(command, **kwargs):
                asked.append(command)
                return subprocess.CompletedProcess(command, 0, json.dumps(self.report('m4', GB, 400 * GB)), '')

            with contextlib.redirect_stdout(out):
                self.assertEqual(preflight_fleet.main(['--version', VERSION], run=run), 1)
        self.assertEqual(len(asked), 1)  # M4 only: nothing is sent to a worker without a route.
        self.assertNotIn('Fleet inventory', out.getvalue())
        for identity in ('m1', 'm3'):
            self.assertIn("%s: FAILED, could not be asked over SpecWithCode Connect: no-route: it is not in M4's "
                          "fleet (studio-fleet.json)" % identity, out.getvalue())

    def test_plan_asks_m4_locally_and_each_worker_over_connect(self):
        with tempfile.TemporaryDirectory() as folder:
            home = ConnectPreflight.write_home(folder)
            with patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(pathlib.Path(folder) / 'none.json')}):
                plan = preflight_fleet.hosts(VERSION, home=home, connect=ConnectPreflight.CLI)
        self.assertEqual([identity for identity, *_ in plan], ['m4', 'm1', 'm3'])
        self.assertEqual(plan[0][1][-6:], ['room', '--identity', 'm4', '--version', VERSION, '--json'])
        self.assertTrue(plan[0][1][2].endswith('scripts/studio-fleet/update.py'))
        self.assertEqual(plan[1][1], ConnectPreflight.CLI + ['m1-id', '--version', VERSION, '--full-read',
                                                             ConnectPreflight.full_read(), '--connect-only', '--json'])
        self.assertEqual(plan[2][1][len(ConnectPreflight.CLI)], 'm3-id')
        self.assertIsNone(plan[1][4]['fallback'])

    def test_ssh_fallback_plan_streams_disk_room_over_pinned_ssh(self):
        with tempfile.TemporaryDirectory() as folder:
            inventory = pathlib.Path(folder) / 'hosts.json'
            inventory.write_text(json.dumps({'m1': {'host': 'm1.example', 'user': 'a'}, 'm3': {'host': 'm3.example', 'user': 'b'}}))
            with patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(inventory)}):
                plan = preflight_fleet.hosts(VERSION, home=folder, ssh_fallback=True)
                command, stdin, timeout = plan[1][4]['fallback']()
        self.assertEqual(command[0], '/usr/bin/ssh')
        self.assertIn('a@m1.example', command)
        self.assertIn("'--identity', 'm1'", stdin)
        self.assertIn("sys.modules['disk_room'].main(argv)", stdin)
        self.assertEqual(timeout, preflight_fleet.REMOTE_TIMEOUT)


class Answers(object):
    """A worker's successive answers, one per ask."""

    def __init__(self, answers):
        self.answers = iter(answers)

    def next(self):
        return next(self.answers)


class FakeClock(object):
    """time.monotonic and time.sleep for retries: sleeping moves the clock, nothing waits. Shared by
    the preflight's threads, so each thread's waits add up on one clock (an upper bound)."""

    def __init__(self):
        self.now, self.slept, self.lock = 1000.0, [], threading.Lock()

    def __call__(self):
        with self.lock:
            return self.now

    def sleep(self, seconds):
        with self.lock:
            self.slept.append(seconds)
            self.now += seconds


class ConnectPreflight(unittest.TestCase):
    """The workers' disk asked over SpecWithCode Connect through M4's `fleet room` CLI (mocked here),
    pinned SSH only with --ssh-fallback and only for the worker Connect could not ask."""
    CLI = ['/fake/specweave-studio', 'fleet', 'room', '--base-dir', '/fake/home/m4']
    MACHINES = {'m1-id': 'm1', 'm3-id': 'm3'}

    @staticmethod
    def full_read():
        import additive_migrations
        return ','.join(str(number) for number in sorted(additive_migrations.FULL_READ)) or 'none'

    @staticmethod
    def write_home(folder):
        import base64
        claims = base64.urlsafe_b64encode(json.dumps({'sub': 'coordinator', 'jkt': 'thumbprint'}).encode()).decode()
        token = claims.rstrip('=') + '.signature'
        own = pathlib.Path(folder) / '.specwithcode' / 'm4'
        own.mkdir(parents=True)
        machines = [{'id': machine, 'label': label.upper(), 'environmentId': 'e-' + label, 'url': 'https://%s.ts.net' % label,
                     'connectUrl': 'https://prod.spec-weave.com', 'managementToken': token}
                    for machine, label in ConnectPreflight.MACHINES.items()]
        (own / 'studio-fleet.json').write_text(json.dumps({'version': 1, 'machines': machines}))
        return pathlib.Path(folder)

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = self.write_home(folder.name)
        self.inventory = pathlib.Path(folder.name) / 'hosts.json'
        self.inventory.write_text(json.dumps({'m1': {'host': 'm1.example', 'user': 'a'},
                                              'm3': {'host': 'm3.example', 'user': 'b'}}))
        environment = patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(self.inventory)})
        environment.start()
        self.addCleanup(environment.stop)

    def report(self, identity, need, free, **extra):
        value = dict(FleetPreflight.report(None, identity, need, free), transport='connect', serverVersion='1.0.190',
                     workerIdentity=identity)
        value.update(extra)
        return value

    def preflight(self, answers, ssh_fallback=False):
        """answers: {'m4' | machine id | 'ssh-m1': (exit, stdout) or an exception}."""
        asked, lines = [], []

        def run(command, **kwargs):
            if command[:len(self.CLI)] == self.CLI:
                key = command[len(self.CLI)]
            elif command[0] == '/usr/bin/ssh':
                key = 'ssh-' + ('m1' if 'a@m1.example' in command else 'm3')
            else:
                key = 'm4'
            asked.append((key, command))
            answer = answers[key]
            if isinstance(answer, Answers):
                answer = answer.next()
            if isinstance(answer, Exception):
                raise answer
            return subprocess.CompletedProcess(command, answer[0], answer[1], '')

        plan = preflight_fleet.hosts(VERSION, home=self.home, ssh_fallback=ssh_fallback, connect=self.CLI)
        clock = FakeClock()
        ok = preflight_fleet.preflight(VERSION, plan, 0, run=run, say=lines.append, clock=clock, sleep=clock.sleep)
        self.slept = clock.slept
        return ok, lines, asked

    def m4(self):
        return (0, json.dumps(self.report('m4', GB, 400 * GB)))

    def test_workers_are_asked_over_connect_with_the_checkouts_full_read(self):
        ok, lines, asked = self.preflight({'m4': self.m4(), 'm1-id': (0, 'progress\n' + json.dumps(self.report('m1-id', GB, 50 * GB))),
                                           'm3-id': (0, json.dumps(self.report('m3-id', GB, 50 * GB)))})
        self.assertTrue(ok, lines)
        self.assertEqual(sorted(key for key, _ in asked), ['m1-id', 'm3-id', 'm4'])  # Asked together.
        for key, command in (entry for entry in asked if entry[0] != 'm4'):
            self.assertEqual(command, self.CLI + [key, '--version', VERSION, '--full-read', self.full_read(),
                                                  '--connect-only', '--json'])
        self.assertTrue(lines[1].startswith('m1: ok') and lines[2].startswith('m3: ok'), lines)
        self.assertEqual(lines[-1], 'disk preflight: m4, m1, m3 have room for %s' % VERSION)

    def test_full_read_none_when_the_checkout_has_none(self):
        import additive_migrations
        with patch.dict(additive_migrations.FULL_READ, clear=True):
            self.assertEqual(preflight_fleet.full_read_list(), 'none')
        expected = ','.join(str(number) for number in sorted(set(additive_migrations.FULL_READ) | {73}))
        with patch.dict(additive_migrations.FULL_READ, {73: 'Later'}):
            self.assertEqual(preflight_fleet.full_read_list(), expected)

    def test_connect_failures_are_named_failures(self):
        for reason, error in (('unsupported', 'm3 runs 1.0.188, which has no fleet disk-room call'),
                              ('unreachable', 'This machine is unavailable over Connect or Tailscale.'),
                              ('unauthorized', 'The management token was refused'),
                              ('failed', 'm3 has no state database at /x')):
            with self.subTest(reason=reason):
                ok, lines, asked = self.preflight({'m4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
                                                   'm3-id': (1, json.dumps({'error': error, 'reason': reason}))})
                self.assertFalse(ok)
                self.assertEqual(lines[-2], 'm3: FAILED, could not be asked over SpecWithCode Connect (machine m3-id): '
                                            '%s: %s' % (reason, error))
                self.assertEqual('m3: SpecWithCode Connect still unreachable after 180s of retries' in lines,
                                 reason == 'unreachable')
                self.assertIn('m3 is not ready for %s' % VERSION, lines[-1])
                self.assertFalse(any(key.startswith('ssh-') for key, _ in asked))
                # Only a worker Connect left unanswered is asked again; a refusal fails at once.
                self.assertEqual([key for key, _ in asked].count('m3-id') > 1, reason == 'unreachable')

    def test_an_unreachable_worker_is_asked_again_until_its_relay_is_back(self):
        answers = iter([(1, json.dumps({'error': 'This machine is unavailable.', 'reason': 'unreachable'}))] * 3
                       + [(0, json.dumps(self.report('m3', GB, 50 * GB)))])
        ok, lines, asked = self.preflight({'m4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
                                           'm3-id': Answers(answers)})
        self.assertTrue(ok, lines)
        self.assertEqual([key for key, _ in asked].count('m3-id'), 4)
        self.assertEqual(self.slept, [5, 10, 20])
        self.assertIn('m3: SpecWithCode Connect unreachable (fleet room); asking again in 5s (0s of 180s)', lines)
        self.assertTrue(any(line.startswith('m3: ok') for line in lines), lines)

    def test_unreachable_retries_stop_after_three_minutes(self):
        ok, lines, asked = self.preflight({'m4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
                                           'm3-id': (1, json.dumps({'error': 'offline', 'reason': 'unreachable'}))})
        self.assertFalse(ok)
        self.assertEqual(sum(self.slept), 180)
        self.assertEqual(self.slept[:4], [5, 10, 20, 30])
        self.assertIn('m3: SpecWithCode Connect still unreachable after 180s of retries', lines)
        self.assertLess(lines.index('m3: SpecWithCode Connect still unreachable after 180s of retries'),
                        lines.index(lines[-2]))  # Printed while it waited, before the host's line.

    def test_a_report_not_over_connect_is_a_failure(self):
        ok, lines, _ = self.preflight({'m4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB, transport='tailnet'))),
                                       'm3-id': (0, json.dumps(self.report('m3', GB, 50 * GB)))})
        self.assertFalse(ok)
        self.assertEqual(lines[1], 'm1: FAILED, could not be asked over SpecWithCode Connect (machine m1-id): transport: '
                                   'answered over tailnet, not SpecWithCode Connect')

    def test_a_short_worker_over_connect_fails_as_before(self):
        short = dict(FleetPreflight.SHORT, transport='connect', identity='m1-id')
        ok, lines, _ = self.preflight({'m4': self.m4(), 'm1-id': (0, json.dumps(short)),
                                       'm3-id': (0, json.dumps(self.report('m3', GB, 50 * GB)))})
        self.assertFalse(ok)
        self.assertIn('m1: FAILED, short of disk, needs 35.6 GB, 15.0 GB free on /Users/w/.specwithcode/m1/updates '
                      '(fallback 30.2 GB for migration 069', lines[1])
        self.assertIn('m1 is not ready', lines[-1])

    def test_a_cli_without_fleet_room_is_named(self):
        ok, lines, _ = self.preflight({'m4': self.m4(), 'm1-id': (0, ''), 'm3-id': (0, json.dumps(self.report('m3', GB, 50 * GB)))})
        self.assertFalse(ok)
        self.assertIn("m1: FAILED, could not be asked over SpecWithCode Connect (machine m1-id): no-answer: the fleet CLI "
                      "gave no JSON (exit 0: no output); M4's installed CLI may predate `fleet room`", lines[1])

    def test_no_cli_or_timeout_is_a_named_failure(self):
        ok, lines, _ = self.preflight({'m4': self.m4(), 'm1-id': FileNotFoundError(),
                                       'm3-id': subprocess.TimeoutExpired(['x'], 5)})
        self.assertFalse(ok)
        self.assertIn('m1: FAILED, could not be asked over SpecWithCode Connect (machine m1-id): no-cli', lines[1])
        self.assertIn('m3: FAILED, could not be asked over SpecWithCode Connect (machine m3-id): timeout', lines[2])

    def test_ssh_fallback_only_for_the_worker_connect_could_not_ask(self):
        ok, lines, asked = self.preflight({
            'm4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
            'm3-id': (1, json.dumps({'error': 'm3 runs 1.0.188, which has no fleet disk-room call', 'reason': 'unsupported'})),
            'ssh-m3': (0, json.dumps(self.report('m3', GB, 50 * GB)))}, ssh_fallback=True)
        self.assertTrue(ok, lines)
        self.assertEqual(sorted(key for key, _ in asked), ['m1-id', 'm3-id', 'm4', 'ssh-m3'])
        self.assertLess([key for key, _ in asked].index('m3-id'), [key for key, _ in asked].index('ssh-m3'))
        self.assertIn('m3: SpecWithCode Connect could not ask (unsupported); using pinned fleet SSH', lines)
        self.assertLess(lines.index('m3: SpecWithCode Connect could not ask (unsupported); using pinned fleet SSH'),
                        [index for index, line in enumerate(lines) if line.startswith('m3: ok')][0])
        ssh_command = dict(asked)['ssh-m3']
        self.assertIn('b@m3.example', ssh_command)

    def test_ssh_fallback_never_follows_a_refusal_the_worker_answered(self):
        for reason in ('unauthorized', 'identity-mismatch', 'failed'):
            with self.subTest(reason=reason):
                ok, lines, asked = self.preflight({
                    'm4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
                    'm3-id': (1, json.dumps({'error': 'refused', 'reason': reason}))}, ssh_fallback=True)
                self.assertFalse(ok)
                self.assertFalse(any(key.startswith('ssh-') for key, _ in asked))
                self.assertFalse(any('using pinned fleet SSH' in line for line in lines))
                self.assertIn('m3: FAILED, could not be asked over SpecWithCode Connect (machine m3-id): %s: refused'
                              % reason, lines)

    def test_ssh_fallback_failure_and_missing_inventory_are_named(self):
        ok, lines, _ = self.preflight({
            'm4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
            'm3-id': (1, json.dumps({'error': 'offline', 'reason': 'unreachable'})),
            'ssh-m3': (255, '')}, ssh_fallback=True)
        self.assertFalse(ok)
        self.assertEqual(self.slept, [])  # With the opt-in, an unreachable worker goes to SSH at once.
        self.assertIn('m3: FAILED, could not be asked: gave no answer (exit 255', lines[-2])
        self.inventory.unlink()
        ok, lines, _ = self.preflight({'m4': self.m4(), 'm1-id': (0, json.dumps(self.report('m1', GB, 50 * GB))),
                                       'm3-id': (1, json.dumps({'error': 'offline', 'reason': 'unreachable'}))},
                                      ssh_fallback=True)
        self.assertFalse(ok)
        self.assertIn('m3: FAILED, could not be asked: could not be asked over pinned fleet SSH either: '
                      'Fleet inventory not found', lines[-2])

    def test_main_parses_ssh_fallback(self):
        seen = {}
        def hosts(version, ssh_fallback=False):
            seen['fallback'] = ssh_fallback
            return []
        with patch.object(preflight_fleet, 'hosts', hosts), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(preflight_fleet.main(['--version', VERSION, '--ssh-fallback']), 0)
            self.assertTrue(seen['fallback'])
            self.assertEqual(preflight_fleet.main(['--version', VERSION]), 0)
            self.assertFalse(seen['fallback'])


if __name__ == '__main__':
    unittest.main()
