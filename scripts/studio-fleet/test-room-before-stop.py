#!/usr/bin/env python3
"""update.py apply refuses for want of disk before it drains or stops the service (1239 AC-02).

M4's 1.0.180 to 1.0.184 update stopped the service, then ran out of scratch in the full read a
pending migration forced (`SpillFailed ... Scratch volume is below its floor`). The room for that
read (pageFallback) and for the pre-update backup (backupSpace) is now asked right after the
before-read: before staging, the pointers, the install gate, the server browser stop and the
service stop. The stop function here is the real one wrapped, so a call would be seen.
"""
import importlib.util
import json
import pathlib
import sqlite3
import sys
import unittest
from collections import namedtuple
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import kept_lines  # noqa: E402
import state_backup  # noqa: E402
import update_apply  # noqa: E402


def _load(name, alias):
    spec = importlib.util.spec_from_file_location(alias, HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


page = _load('test-update-page-mode.py', 'room_page_fixture')
plain = _load('test-update.py', 'room_plain_fixture')
update = plain.update
GB = 10 ** 9
LARGEST = 11_500_000_000  # M4's orchestration_events, November 4.
Usage = namedtuple('Usage', 'total used free')


class Watched(object):
    """The service stop, the install gate and staging, each wrapped so a call is recorded."""
    def __init__(self, test, module):
        self.stop = patch.object(module, 'stop_service', wraps=module.stop_service)
        self.gate = patch.object(module, 'write_install_gate', wraps=module.write_install_gate)
        self.stage = patch.object(module.release_stage, 'stage_release', wraps=module.release_stage.stage_release)
        self.mocks = [part.start() for part in (self.stop, self.gate, self.stage)]
        for part in (self.stop, self.gate, self.stage):
            test.addCleanup(part.stop)

    def calls(self):
        return [mock.call_count for mock in self.mocks]


class PageModeRoom(unittest.TestCase):
    """A held install (page mode), as M4's Update now and fleet rollout ask."""
    def setUp(self):
        self.fixture = page.ApplyBranches('run_apply')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.h = self.fixture.h
        self.fixture.old.commit(*page.MIGRATED_THROUGH_68)  # 069, a FULL_READ migration, still to run.
        self.update = self.fixture.update  # That fixture's own load of update.py.
        self.watched = Watched(self, self.update)

    def refused(self, free):
        with patch.object(kept_lines, 'available_disk', return_value=free), \
             patch.object(update_apply, 'largest_table_bytes', return_value=LARGEST), \
             self.assertRaisesRegex(AssertionError, 'full database read that migration 069 needs') as caught:
            self.fixture.run_apply()
        return caught.exception

    def test_short_room_never_stops_drains_or_stages(self):
        error = self.refused(15 * GB)
        self.assertEqual(self.watched.calls(), [0, 0, 0])  # stop_service, write_install_gate, stage_release.
        self.assertEqual((self.h.stops, self.h.launchd, self.h.restart_calls, self.h.backups), ([], [], [], []))
        self.assertEqual(self.h.quiescence_checks, [])  # The server browser was never stopped.
        self.assertEqual({path: path.read_bytes() for path in self.h.original}, self.h.original)
        self.assertFalse(self.h.output.exists())  # Before phase 'prepared': main() writes the receipt.
        self.assertFalse((self.h.own / 'owned-updates').exists())
        # The receipt main() leaves: the five keys installed agents read, the parts in its error.
        self.update.write_preflight_failure(self.h.output, 'm4', error)
        receipt = json.loads(self.h.output.read_text())
        self.assertEqual(set(receipt), {'identity', 'phase', 'result', 'error', 'pointers'})
        self.assertEqual((receipt['phase'], receipt['pointers']), ('preflight', 'unchanged'))
        reserve = self.update.backup_space_needed(self.h.own, self.h.home, self.update._clonefile())[0]
        runs = int(update_apply.FULL_READ_LINE_FACTOR * LARGEST) + kept_lines.DISK_FLOOR_MARGIN
        self.assertIn('needs %.1f GB, 15.0 GB free' % ((runs + reserve) / GB), receipt['error'])
        self.assertIn('pageFallback %.1f GB, backupSpace %.1f GB' % (runs / GB, reserve / GB), receipt['error'])

    def test_enough_room_stops_once_and_verifies(self):
        with patch.object(kept_lines, 'available_disk', return_value=60 * GB), \
             patch.object(update_apply, 'largest_table_bytes', return_value=LARGEST) as walk:
            self.fixture.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['fullReadMigrations'], [69])
        self.assertEqual(self.watched.calls()[:2], [1, 1])
        self.assertEqual(walk.call_count, 1)  # The check before the stop reuses the early walk.


class FullPathRoom(unittest.TestCase):
    """An install without a held admission (the whole-database proof), on the same rule."""
    def setUp(self):
        self.h = plain.ApplyRecovery('runTest')
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        db = sqlite3.connect(str(self.h.own / 'userdata' / 'statev2.sqlite'))
        db.executescript("PRAGMA journal_mode=WAL;CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT);"
                         "INSERT INTO effect_sql_migrations VALUES (68, 'now', 'ActiveTurnItemIndexes');")
        db.close()
        self.watched = Watched(self, update)

    def test_short_fallback_room_refuses_before_the_stop(self):
        with patch.object(kept_lines, 'available_disk', return_value=15 * GB), \
             patch.object(update_apply, 'largest_table_bytes', return_value=LARGEST), \
             self.assertRaisesRegex(AssertionError, r'migration 069 needs.*pageFallback [\d.]+ GB, backupSpace [\d.]+ GB'):
            self.h.execute()
        self.assertEqual(self.watched.calls(), [0, 0, 0])
        self.assertEqual((self.h.stops, self.h.launchd, self.h.restart_calls, self.h.quiescence_checks), ([], [], [], []))
        self.assertEqual({path: path.read_bytes() for path in self.h.original}, self.h.original)

    def test_short_backup_room_refuses_before_the_stop(self):
        with patch.object(state_backup.shutil, 'disk_usage', return_value=Usage(100 * GB, 99 * GB, GB)), \
             self.assertRaisesRegex(AssertionError, 'Not enough free disk space for the pre-update backup'):
            self.h.execute()
        self.assertEqual(self.watched.calls(), [0, 0, 0])
        self.assertEqual((self.h.stops, self.h.launchd, self.h.restart_calls), ([], [], []))

    def test_migrated_database_asks_no_fallback_room(self):
        db = sqlite3.connect(str(self.h.own / 'userdata' / 'statev2.sqlite'))
        db.execute("INSERT INTO effect_sql_migrations VALUES (69, 'now', 'AuthSessionProofKeyThumbprint')")
        db.commit()
        db.close()
        with patch.object(kept_lines, 'available_disk', return_value=1), \
             patch.object(update_apply, 'largest_table_bytes', side_effect=AssertionError('walked')):
            self.h.execute()
        self.assertEqual(json.loads(self.h.output.read_text())['phase'], 'verified')
        self.assertEqual(self.watched.calls()[0], 1)


if __name__ == '__main__':
    unittest.main()
