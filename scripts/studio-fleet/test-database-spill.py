#!/usr/bin/env python3
"""The full read's large tables, hashed through sorted runs on disk: same hashes, bounded memory."""
import os
import pathlib
import sqlite3
import tempfile
import tracemalloc
import unittest
from unittest.mock import patch

import database_continuity as continuity
import kept_lines


def database(rows=500):
    db = sqlite3.connect(':memory:', isolation_level=None)
    db.executescript('''
        CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, data BLOB, score REAL);
        CREATE TABLE small(id TEXT PRIMARY KEY, body TEXT);
        INSERT INTO small VALUES ('a', 'one'), ('b', NULL);
    ''')
    for number in range(rows):
        # Lines that sort apart from scan order, equal ones, and text JSON has to escape.
        db.execute('INSERT INTO orchestration_events(body, data, score) VALUES (?, ?, ?)',
                   ('line\n"%03d" é ☃ \U0001f600' % (rows - number if number % 7 else 3), bytes([number % 256, 0]), number / 3))
    db.execute('BEGIN')
    return db


class SpilledTable(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)

    def in_memory(self, db, boundary):
        positioned = list(db.execute('SELECT rowid, * FROM orchestration_events'))
        typed = continuity.whole_and_prefix(positioned, continuity.typed_line, boundary)
        legacy = continuity.whole_and_prefix(positioned, continuity.legacy_line, boundary)
        return typed[0], legacy[0], typed[1], legacy[1]

    def test_hashes_equal_the_in_memory_read_with_any_run_size(self):
        for rows in (0, 1, 500):
            db = database(rows)
            for size in (1, 200, continuity.SPILL_RUN_CHARS):
                for boundary in (0, rows // 2, rows + 1):
                    with self.subTest(rows=rows, size=size, boundary=boundary), patch.object(continuity, 'SPILL_RUN_CHARS', size):
                        spilled = continuity.spilled_table(db.execute('SELECT rowid, * FROM orchestration_events'), boundary, self.folder)
                        self.assertEqual(spilled, self.in_memory(db, boundary))

    def test_more_runs_than_can_be_open_are_merged_in_groups(self):
        db = database()
        with patch.object(continuity, 'SPILL_RUN_CHARS', 1), patch.object(continuity, 'SPILL_MERGE_FILES', 3):
            spilled = continuity.spilled_table(db.execute('SELECT rowid, * FROM orchestration_events'), 250, self.folder)
        self.assertEqual(spilled, self.in_memory(db, 250))

    def test_a_table_within_the_budget_touches_no_disk_and_runs_are_removed(self):
        db = database()
        continuity.spilled_table(db.execute('SELECT * FROM small'), None, self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200):
            continuity.spilled_table(db.execute('SELECT * FROM orchestration_events'), None, self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_a_read_fault_removes_the_runs_and_stands(self):
        def rows():
            yield from [('x' * 300,)] * 3
            raise sqlite3.DatabaseError('malformed')
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200), self.assertRaises(sqlite3.DatabaseError):
            continuity.spilled_table(rows(), None, self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_a_dead_helpers_runs_go_with_the_kept_lines_sweep(self):
        run = self.folder / (kept_lines.SCRATCH_PREFIX + '999999-abc')
        run.mkdir()
        (run / 'run-0').write_bytes(b'x')
        with patch.object(kept_lines, '_running', return_value=False):
            kept_lines.remove_stale(self.folder)
        self.assertFalse(run.exists())

    def test_a_stale_run_folder_goes_when_a_read_first_spills(self):
        run = self.folder / (kept_lines.SCRATCH_PREFIX + '999999-abc')
        run.mkdir()
        db = database()
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200), patch.object(kept_lines, '_running', return_value=False):
            continuity.spilled_table(db.execute('SELECT * FROM orchestration_events'), None, self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_merging_only_as_many_runs_as_the_limit_takes(self):
        merged = []
        real = continuity.SortedRuns._merged
        def counting(runs, paths):
            merged.append(len(paths))
            return real(runs, paths)
        db = database(40)
        with patch.object(continuity, 'SPILL_RUN_CHARS', 1), patch.object(continuity, 'SPILL_MERGE_FILES', 38), \
                patch.object(continuity.SortedRuns, '_merged', counting):
            spilled = continuity.spilled_table(db.execute('SELECT rowid, * FROM orchestration_events'), 20, self.folder)
        self.assertEqual(spilled, self.in_memory(db, 20))
        self.assertEqual(merged, [3, 38, 3, 38])  # 40 runs of each encoding: 3 merged into one, then the rest.

    def test_memory_stays_near_the_run_size_however_large_the_table(self):
        rows = 4000
        def scan():
            for number in range(rows):
                yield (number, 'x' * 10000 + str(number))
        tracemalloc.start()
        try:
            with patch.object(continuity, 'SPILL_RUN_CHARS', 1 << 20):
                continuity.spilled_table(scan(), None, self.folder)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        total = rows * 10000 * 2  # Typed and legacy lines, which the in-memory read holds at once.
        self.assertLess(peak, total / 5)


class Capture(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.db = database()

    def test_capture_is_the_same_with_spill(self):
        plain = continuity.capture_connection(self.db)
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200):
            self.assertEqual(continuity.capture_connection(self.db, spill=self.folder), plain)

    def test_prefixes_are_the_same_with_spill(self):
        plain = {'orchestration_events': {'boundary': 100}}
        spilled = {'orchestration_events': {'boundary': 100}}
        expected = continuity.capture_connection(self.db, prefixes=plain)
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200):
            self.assertEqual(continuity.capture_connection(self.db, prefixes=spilled, spill=self.folder), expected)
        self.assertEqual(spilled, plain)

    def test_a_visitor_gets_rows_only_where_it_needs_them(self):
        seen = {}
        continuity.capture_connection(self.db, spill=self.folder, visit=lambda table, rows: seen.__setitem__(table, rows),
                                      needs_rows=lambda table: table == 'small')
        self.assertIsNone(seen['orchestration_events'])
        self.assertEqual(sorted(seen['small']), [('a', 'one'), ('b', None)])

    def test_a_visitor_without_needs_rows_gets_every_tables_rows(self):
        seen = {}
        continuity.capture_connection(self.db, spill=self.folder, visit=lambda table, rows: seen.__setitem__(table, rows))
        self.assertEqual(len(seen['orchestration_events']), 500)

    def test_a_full_scratch_volume_aborts_capture_with_the_table_name(self):
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200), patch.object(kept_lines, 'available_disk', return_value=0):
            with self.assertRaisesRegex(continuity.SpillFailed, 'Cannot capture table orchestration_events within the memory budget'):
                continuity.capture_connection(self.db, spill=self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_a_merge_below_the_floor_aborts_capture(self):
        real = kept_lines.available_disk
        calls = []
        def shrinking(folder):
            calls.append(folder)
            return 0 if len(calls) > 20 else real(folder)
        with patch.object(continuity, 'SPILL_RUN_CHARS', 1), patch.object(continuity, 'SPILL_MERGE_FILES', 3), \
                patch.object(kept_lines, 'available_disk', side_effect=shrinking):
            with self.assertRaisesRegex(continuity.SpillFailed, 'Cannot capture table orchestration_events within the memory budget'):
                continuity.capture_connection(self.db, spill=self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_a_run_that_cannot_be_opened_aborts_capture(self):
        real = open
        def refusing(path, mode='r', *args, **kwargs):
            if 'r' in mode and pathlib.Path(str(path)).name.startswith('run-'):
                raise OSError(24, 'Too many open files')
            return real(path, mode, *args, **kwargs)
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200), patch('builtins.open', refusing):
            with self.assertRaisesRegex(continuity.SpillFailed, 'Cannot capture table orchestration_events within the memory budget'):
                continuity.capture_connection(self.db, spill=self.folder)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_an_unusable_scratch_folder_aborts_capture(self):
        with patch.object(continuity, 'SPILL_RUN_CHARS', 200):
            with self.assertRaisesRegex(continuity.SpillFailed, 'Cannot capture table orchestration_events within the memory budget'):
                continuity.capture_connection(self.db, spill=self.folder / 'missing')

    def test_spill_failure_never_rereads_the_full_table_or_returns_a_capture(self):
        statements = []
        self.db.set_trace_callback(statements.append)
        try:
            with patch.object(continuity, 'SPILL_RUN_CHARS', 200), patch.object(kept_lines, 'available_disk', return_value=0):
                with self.assertRaisesRegex(continuity.SpillFailed, 'Cannot capture table orchestration_events'):
                    continuity.capture_connection(self.db, spill=self.folder)
            self.assertEqual(statements.count('SELECT * FROM "orchestration_events"'), 1)
            self.assertTrue(self.db.in_transaction)
            self.assertEqual(self.db.execute('SELECT count(*) FROM orchestration_events').fetchone()[0], 500)
            self.assertEqual(list(self.folder.iterdir()), [])
        finally:
            self.db.set_trace_callback(None)

    def test_kept_lines_still_get_the_lines(self):
        kept = kept_lines.Kept(True, None, always=('orchestration_events',))
        with patch.object(kept_lines, 'memory_room', return_value=True):
            continuity.capture_connection(self.db, keep=kept, spill=self.folder)
        self.assertEqual(kept.tables['orchestration_events']['typed']['count'], 500)
        kept.clear()


class SpillFolder(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = pathlib.Path(folder.name)
        (self.home / 'userdata').mkdir()
        self.database = self.home / 'userdata' / 'statev2.sqlite'
        self.database.write_bytes(b'')

    def test_the_updates_folder_on_the_databases_volume(self):
        (self.home / 'updates').mkdir()
        self.assertEqual(kept_lines.spill_folder(self.database), self.home / 'updates')

    def test_another_volume_keeps_the_read_in_memory(self):
        (self.home / 'updates').mkdir()
        real = os.stat
        def elsewhere(path, *args, **kwargs):
            value = real(path, *args, **kwargs)
            if str(path).endswith('updates'):
                return os.stat_result((value[0], value[1], value[2] + 1) + tuple(value[3:10]))
            return value
        with patch.object(os, 'stat', elsewhere):
            self.assertIsNone(kept_lines.spill_folder(self.database))

    def test_a_missing_database_keeps_the_read_in_memory(self):
        self.assertIsNone(kept_lines.spill_folder(self.home / 'userdata' / 'missing.sqlite'))


if __name__ == '__main__':
    unittest.main()
