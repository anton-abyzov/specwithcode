#!/usr/bin/env python3
"""Byte-validated cache tests. Temporary synthetic SQLite only, never a live store."""
import contextlib
import importlib.util
import json
import os
import pathlib
import sqlite3
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

import database_continuity as continuity
import kept_lines
import live_database
import read_cache
import update_read

spec = importlib.util.spec_from_file_location('read_cache_fixture', pathlib.Path(__file__).with_name('test-update.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def supports_dbstat():
    with sqlite3.connect(':memory:') as db:
        try:
            db.execute('SELECT * FROM dbstat LIMIT 1').fetchall()
            return True
        except sqlite3.OperationalError:
            return False


class CacheProof(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='specwithcode-read-cache-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name) / 'userdata'
        fixture.waiting_fixture(self.state)
        self.writer = sqlite3.connect(self.state / 'statev2.sqlite')
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.execute('PRAGMA wal_autocheckpoint=0')
        self.writer.execute("UPDATE projection_projects SET title='WAL fixture'")
        self.writer.commit()
        self.addCleanup(self.writer.close)
        self.path = pathlib.Path(self.temp.name) / 'updates/read-cache-v1.json'

    def read(self):
        return update_read._read_state(self.state, True, None, True)

    def original(self):
        with patch.object(read_cache, 'read', return_value=None):
            return self.read()

    def require_cache(self):
        if not supports_dbstat():
            self.skipTest('this SQLite build lacks dbstat; fallback is tested separately')

    def test_unsupported_sqlite_falls_back_to_original_read(self):
        expected = self.original()
        with patch.object(read_cache.Snapshot, 'fingerprint', side_effect=sqlite3.OperationalError('no such table: dbstat')):
            self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['mode'], 'full')

    def test_cold_and_warm_exact_proof_and_no_private_cells(self):
        self.require_cache()
        expected = self.original()
        self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['reusedTables'], [])
        self.assertEqual(json.dumps(self.read()), json.dumps(expected))
        self.assertIn('orchestration_v2_projection_messages', read_cache.LAST['reusedTables'])
        data = self.path.read_text()
        for secret in ('synthetic-private-message', 'synthetic-private-payload', 'synthetic-private-credential', '2026-10-11T03:00:00Z'):
            self.assertNotIn(secret, data)
        self.assertLess(len(data), read_cache.MAX_CACHE_BYTES)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_cache_hit_never_encodes_unchanged_history(self):
        self.require_cache()
        self.read()
        typed, legacy = continuity.typed_line, continuity.legacy_line
        def guard(fn):
            def line(row):
                self.assertNotIn('synthetic-private-message', row)
                self.assertNotIn('{"private":"synthetic-private-payload"}', row)
                return fn(row)
            return line
        with patch.object(continuity, 'typed_line', side_effect=guard(typed)), \
                patch.object(continuity, 'legacy_line', side_effect=guard(legacy)):
            self.read()
        self.assertEqual(read_cache.LAST['mode'], 'pages')

    def test_wal_cell_type_and_main_file_changes_invalidate_only_changed_tables(self):
        self.require_cache()
        before = self.read()
        for statement in (
            "UPDATE orchestration_v2_projection_messages SET text=x'616263' WHERE message_id='m-t-idle'",
            "UPDATE orchestration_v2_projection_messages SET text='616263' WHERE message_id='m-t-idle'",
        ):
            self.writer.execute(statement)
            self.writer.commit()
            expected = self.original()
            self.assertEqual(self.read(), expected)
            self.assertNotEqual(before, expected)
            self.assertNotIn('orchestration_v2_projection_messages', read_cache.LAST['reusedTables'])
            self.assertIn('auth_pairing_links', read_cache.LAST['reusedTables'])
            self.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['mode'], 'pages')

    def test_schema_and_source_key_changes_discard_prior_cache(self):
        self.require_cache()
        self.read()
        self.writer.execute('ALTER TABLE scheduled_tasks ADD COLUMN extra INTEGER')
        self.writer.commit()
        self.assertEqual(self.read(), self.original())
        self.assertEqual(read_cache.LAST['reusedTables'], [])
        with patch.object(read_cache, 'source_key', return_value='new-format'):
            self.read()
            self.assertEqual(read_cache.LAST['reusedTables'], [])

    def test_corrupt_deleted_oversize_or_symlink_cache_never_changes_the_proof(self):
        self.require_cache()
        expected = self.read()
        for content in ('{broken', '{"value":{}}', 'x' * (read_cache.MAX_CACHE_BYTES + 1)):
            self.path.write_text(content)
            self.assertEqual(self.read(), expected)
            self.assertEqual(read_cache.LAST['reusedTables'], [])
        data = json.loads(self.path.read_text())
        data['value']['tables']['scheduled_tasks']['typed']['sha256'] = 'a' * 64
        self.path.write_text(json.dumps(data))
        self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['reusedTables'], [])
        self.path.unlink()
        self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['reusedTables'], [])
        outside = pathlib.Path(self.temp.name) / 'unrelated'
        outside.write_text('do not overwrite')
        self.path.unlink()
        self.path.symlink_to(outside)
        self.assertEqual(self.read(), expected)
        self.assertEqual(outside.read_text(), 'do not overwrite')

    def test_busy_database_is_refused_even_with_a_warm_cache(self):
        self.require_cache()
        self.read()
        self.writer.execute("UPDATE orchestration_v2_projection_runs SET status='running'")
        self.writer.commit()
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            self.read()

    def test_kept_logs_stay_available_for_post_restart_append_proof(self):
        self.require_cache()
        expected = self.read()
        keep = kept_lines.Kept(always=update_read.LOG_TABLES)
        self.addCleanup(keep.clear)
        with patch.object(kept_lines, 'active', return_value=keep), \
                patch.object(kept_lines, 'available_memory', return_value=1 << 50):
            self.assertEqual(self.read(), expected)
        self.assertTrue(keep.complete)
        for table in set(update_read.LOG_TABLES) & set(expected[3]['summary']['tables']):
            self.assertNotIn(table, read_cache.LAST['reusedTables'])
            self.assertEqual(set(keep.tables[table]), {'typed', 'legacy'})
        self.assertIn('orchestration_v2_projection_messages', read_cache.LAST['reusedTables'])

    def test_borrowed_watermark_probes_are_not_closed(self):
        self.require_cache()
        database = str(self.state / 'statev2.sqlite')
        for suffix in ('', '-shm'):
            live_database.hold_probe(database + suffix)
            self.addCleanup(live_database.release_probe, database + suffix)
        before = [live_database.held_probe(database + suffix) for suffix in ('', '-shm')]
        self.read()
        self.assertEqual(before, [live_database.held_probe(database + suffix) for suffix in ('', '-shm')])
        for fd in before:
            os.fstat(fd)

    def test_commit_after_snapshot_uses_the_pinned_rows_and_invalidates_next_read(self):
        self.require_cache()
        expected = self.read()
        fingerprint, committed = read_cache.Snapshot.fingerprint, False
        def during(snapshot, names):
            nonlocal committed
            result = fingerprint(snapshot, names)
            if not committed:
                self.writer.execute("UPDATE orchestration_v2_projection_messages SET text='new commit'")
                self.writer.commit()
                committed = True
            return result
        with patch.object(read_cache.Snapshot, 'fingerprint', during):
            self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['mode'], 'pages')
        new = self.read()
        self.assertNotEqual(new, expected)
        self.assertEqual(new, self.original())

    def test_unprovable_snapshot_drops_cache_and_kept_lines_before_full_read(self):
        self.require_cache()
        expected = self.read()
        with patch.object(read_cache.Snapshot, 'check', side_effect=read_cache.Unavailable('wal-restarted')):
            self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['mode'], 'full')

    def test_a_real_table_shadowing_dbstat_cannot_forge_page_ownership(self):
        self.require_cache()
        self.writer.execute('CREATE TABLE dbstat(name TEXT,pageno INTEGER,pagetype TEXT)')
        self.writer.execute("INSERT INTO dbstat SELECT name,1,'leaf' FROM sqlite_master WHERE type='table'")
        self.writer.commit()
        before = self.read()
        self.writer.execute("UPDATE orchestration_v2_projection_messages SET text='changed under forged page map'")
        self.writer.commit()
        expected = self.original()
        self.assertNotEqual(expected, before)
        self.assertEqual(self.read(), expected)
        self.assertEqual(read_cache.LAST['mode'], 'full')
        self.assertIn('shadowed-dbstat', read_cache.LAST['reason'])

    def test_large_wal_falls_back_without_checksum_work(self):
        self.require_cache()
        expected = self.original()
        with patch.object(read_cache, 'MAX_WAL_BYTES', 1):
            self.assertEqual(self.read(), expected)
        self.assertIn('wal-budget', read_cache.LAST['reason'])

    def test_corrupt_wal_frame_mapping_never_reuses_a_stale_table_proof(self):
        self.require_cache()
        before = self.read()
        self.writer.execute("UPDATE orchestration_v2_projection_messages SET text='changed in WAL'")
        self.writer.commit()
        expected = self.original()
        self.assertNotEqual(expected, before)
        wal = pathlib.Path(str(self.state / 'statev2.sqlite') + '-wal')
        raw = wal.read_bytes()
        page_size = struct.unpack_from('>I', raw, 8)[0]
        root = self.writer.execute("SELECT rootpage FROM sqlite_master WHERE name='orchestration_v2_projection_messages'").fetchone()[0]
        frames = [offset for offset in range(32, len(raw), page_size + 24)
                  if struct.unpack_from('>I', raw, offset)[0] == root]
        self.assertTrue(frames)
        try:
            with wal.open('r+b') as handle:
                handle.seek(frames[-1])
                handle.write(struct.pack('>I', 1))  # Index still maps this frame to the message table.
            self.assertEqual(self.read(), expected)
            self.assertEqual(read_cache.LAST['mode'], 'full')
            self.assertIn('wal-checksum', read_cache.LAST['reason'])
        finally:
            wal.write_bytes(raw)

    def test_cached_before_read_still_uses_page_proof_after_restart(self):
        self.require_cache()
        spec = importlib.util.spec_from_file_location('read_cache_after', pathlib.Path(__file__).with_name('test-after-proof.py'))
        after = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(after)
        with patch.object(kept_lines, 'available_disk', return_value=1 << 50), \
                patch.object(kept_lines, 'available_memory', return_value=1 << 50):
            flow = after.Update(self, since_expected=False)
            flow.kept.clear()
            with after.after_proof.keeping(flow.database) as flow.kept:
                before = update_read._read_state(flow.state, False, None, True)
            self.assertIn('orchestration_v2_projection_turn_items', read_cache.LAST['reusedTables'])
            flow.before = before[0]
            flow.reference = {'position': None, 'since': flow.before, 'reads': (before[0], None, before[3])}
            flow.taken = flow.watermark.take()
            flow.around_restart()
            reads, record, _ = flow.decide()
            self.assertEqual(record['mode'], 'pages', record)
            self.assertEqual(reads, flow.full())
            flow.kept.clear()

    def test_since_or_migration_read_never_uses_the_cache(self):
        self.require_cache()
        expected = self.read()
        with patch.object(read_cache, 'read', side_effect=AssertionError('cache must not run')):
            with_since = update_read._read_state(self.state, True, expected[0], True)
            with_widen = update_read._read_state(self.state, True, None, True, expected[3]['schema']['columns'])
        self.assertEqual(with_since[3], expected[3])
        self.assertEqual(with_widen, expected)


if __name__ == '__main__':
    unittest.main()
