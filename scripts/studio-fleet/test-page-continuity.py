#!/usr/bin/env python3
"""Stopped-clone page verdict against synthetic WAL services; never a live user database."""
import importlib.util
import pathlib
import random
import os
import re
import sqlite3
import struct
import unittest
from unittest.mock import patch

import additive_migrations
import database_continuity as continuity
import page_continuity as proof
import kept_lines
import update_migration
import update_read

spec = importlib.util.spec_from_file_location('page_fixture', pathlib.Path(__file__).with_name('test-after-proof.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Preservation(unittest.TestCase):
    def setUp(self):
        p = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        p.start()
        self.addCleanup(p.stop)

    def flow(self, writes=False, **shape):
        flow = fixture.Update(self, **shape)
        flow.around_restart(writes=writes)
        self.addCleanup(flow.kept.clear)
        return flow

    def prove(self, flow):
        return proof.prove(flow.state, flow.held, '2026-10-22T14:00:00Z', '2026-10-22T14:06:00Z')

    def test_unchanged_history_is_not_decoded(self):
        flow = self.flow()
        result = self.prove(flow)
        self.assertTrue(result['preserved'])
        self.assertEqual(result['decodedRows'], 0)
        self.assertEqual(result['proofKind'], 'stopped-clone-pages-v1')

    def test_restart_append_projection_cursor_auth(self):
        flow = self.flow(writes=True)
        result = self.prove(flow)
        self.assertEqual(result['appendedRows']['orchestration_events'], 30)
        self.assertEqual(result['appendedRows']['orchestration_command_receipts'], 10)
        self.assertEqual(result['authHeartbeat']['changedRows'], 1)
        self.assertLess(result['decodedRows'], 1000)

    def test_old_log_edit_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_events SET payload_json='changed' WHERE sequence=1", []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_old_log_delete_refused(self):
        flow = self.flow()
        flow.new.commit(('DELETE FROM orchestration_events WHERE sequence=1', []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_projection_without_event_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_v2_projection_threads SET title='changed' WHERE thread_id='t-1'", []))
        with self.assertRaisesRegex(proof.Refused, 'projection-without-event'): self.prove(flow)

    def test_authority_edit_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE scheduled_tasks SET cron='new'", []))
        with self.assertRaisesRegex(proof.Refused, 'authority-table-changed'): self.prove(flow)

    def test_schema_change_refused(self):
        flow = self.flow()
        flow.new.commit(('CREATE TABLE surprise (id INTEGER)', []))
        with self.assertRaisesRegex(proof.Refused, 'schema'): self.prove(flow)

    def test_auth_change_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE auth_sessions SET subject='stranger'", []))
        with self.assertRaisesRegex(proof.Refused, 'auth-heartbeat'): self.prove(flow)

    def test_blob_change_in_old_log_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_events SET payload_json=CAST(payload_json AS BLOB) WHERE sequence=1", []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_deleted_thread_with_new_event_refused(self):
        flow = self.flow(writes=True)
        flow.new.commit(("DELETE FROM orchestration_v2_projection_threads WHERE thread_id='t-1'", []))
        with self.assertRaisesRegex(proof.Refused, 'identity-removed'): self.prove(flow)

    def test_unknown_without_rowid_change_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE pull_request_files_viewed SET viewed_at='changed'", []))
        with self.assertRaisesRegex(proof.Refused, 'without-rowid'): self.prove(flow)

    def test_corrupt_wal_frame_header_cannot_hide_edit(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_events SET payload_json='changed' WHERE sequence=1", []))
        wal = str(flow.database) + '-wal'
        with open(wal, 'r+b') as handle:
            header = handle.read(32)
            size = struct.unpack_from('>I', header, 8)[0]
            length = os.fstat(handle.fileno()).st_size
            offset = 32 + ((length - 32) // (24 + size) - 1) * (24 + size)
            handle.seek(offset)
            handle.write(struct.pack('>I', 1))
            handle.flush()
        with self.assertRaisesRegex(proof.Refused, 'wal-checksum'): self.prove(flow)

    def test_clone_mutation_during_proof_refused(self):
        flow = self.flow()
        assemble = proof.PageProof.assemble
        def changed(instance, touched):
            result = assemble(instance, touched)
            os.utime(flow.held['clone'], None)
            return result
        with patch.object(proof.PageProof, 'assemble', changed):
            with self.assertRaisesRegex(proof.Refused, 'clone-changed'): self.prove(flow)

    def test_duplicate_sequence_counter_refused(self):
        flow = self.flow(writes=True)
        flow.new.commit(("INSERT INTO sqlite_sequence(name,seq) VALUES ('orchestration_events',1)", []))
        with self.assertRaisesRegex(proof.Refused, 'duplicate-sequence'): self.prove(flow)

    def test_legacy_auth_hash_collision_does_not_preserve_subject(self):
        flow = fixture.Update(self, written=[("UPDATE auth_sessions SET subject='6162'", [])])
        self.addCleanup(flow.kept.clear)
        flow.around_restart(writes=False)
        flow.new.commit(("UPDATE auth_sessions SET subject=x'6162'", []))
        with self.assertRaisesRegex(proof.Refused, 'auth-heartbeat'): self.prove(flow)

    def test_legacy_auth_hash_collision_does_not_preserve_app_version(self):
        flow = fixture.Update(self, written=[("UPDATE auth_sessions SET client_app_version='6162'", [])])
        self.addCleanup(flow.kept.clear)
        flow.around_restart(writes=False)
        flow.new.commit(("UPDATE auth_sessions SET client_app_version=x'6162'", []))
        with self.assertRaisesRegex(proof.Refused, 'typed-collision'): self.prove(flow)

    def test_stopped_clone_is_baseline_not_old_read(self):
        flow = fixture.Update(self)
        self.addCleanup(flow.kept.clear)
        flow.old.commit(("UPDATE scheduled_tasks SET cron='legitimate-before-stop'", []))
        flow.mark(reread=True)
        flow.stop()
        flow.clone()
        flow.restart(writes=False)
        self.assertTrue(self.prove(flow)['preserved'])

    def test_changed_rows_budget_refuses(self):
        flow = self.flow(writes=True)
        with patch.object(proof, 'MAX_CHANGED_ROWS', 1), self.assertRaisesRegex(proof.Refused, 'budget'):
            self.prove(flow)

    def test_unavailable_snapshot_refuses(self):
        flow = self.flow()
        with patch.object(proof.read_cache.Snapshot, 'open', side_effect=proof.read_cache.Unavailable('test')):
            with self.assertRaisesRegex(proof.Refused, 'test'): self.prove(flow)


MIGRATIONS_SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'apps' / 'server' / 'src' / 'persistence'
MIGRATIONS_TABLE = ('CREATE TABLE "effect_sql_migrations" (migration_id integer PRIMARY KEY NOT NULL, '
                    'created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)')


def source_statements(number):
    """The SQL statements of server migration `number`, as its TypeScript source runs them."""
    files = sorted(MIGRATIONS_SOURCE.joinpath('Migrations').glob('%03d_*.ts' % number))
    files = [path for path in files if not path.name.endswith('.test.ts')]
    assert len(files) == 1, files
    return re.findall(r'sql`(.*?)`', files[0].read_text(), re.S)


def migration(number, statements=None):
    """What the new service commits for migration `number`: its statements, then its row."""
    name = (additive_migrations.DECLARED.get(number) or additive_migrations.REBUILT.get(number) or ('Undeclared',))[0]
    return [(sql, []) for sql in (source_statements(number) if statements is None else statements)] + \
        [('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [number, name])]


class AdditiveMigrations(unittest.TestCase):
    """Declared additive migrations keep the page proof; any other schema change still refuses."""

    def setUp(self):
        p = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        p.start()
        self.addCleanup(p.stop)

    def flow(self, *statements, writes=True, ran=(), through=69):
        """The old service has run migrations 1-`through` and then `ran`; the new one runs
        `statements` at startup, then the usual startup writes."""
        flow = fixture.Update(self, written=[(MIGRATIONS_TABLE, [])] + [
            ('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [number, 'M%d' % number])
            for number in range(1, through + 1)] + list(ran))
        self.addCleanup(flow.kept.clear)
        flow.mark()
        flow.stop()
        flow.clone()
        new = flow.restart(writes=False)
        new.commit(*statements)
        if writes:
            for batch in fixture.startup_writes(random.Random(7)):
                new.commit(*batch)
        return flow

    def prove(self, flow, migrations=True):
        return proof.prove(flow.state, flow.held, '2026-10-22T14:00:00Z', '2026-10-22T14:06:00Z', migrations=migrations)

    def test_declared_migrations_070_071_keep_the_page_proof(self):
        flow = self.flow(*migration(70), *migration(71),
                         ("INSERT INTO orchestration_v2_thread_history_compactions VALUES ('t-9','deleted',3,'now',NULL)", []))
        result = self.prove(flow)
        self.assertTrue(result['preserved'])
        self.assertEqual(result['schemaDelta']['migrations'], [70, 71])
        self.assertEqual(result['schemaDelta']['objects'], sorted(
            name for number in (70, 71) for _, name, _, _ in additive_migrations.DECLARED[number][1]))
        self.assertEqual(result['appendedRows']['orchestration_events'], 30)
        self.assertEqual(result['authHeartbeat']['changedRows'], 1)

    def test_declared_migration_without_other_writes(self):
        result = self.prove(self.flow(*migration(70), *migration(71), writes=False))
        self.assertEqual(result['schemaDelta']['migrations'], [70, 71])
        # Only the migrations table's changed leaf is compared: the new trees and the indexed
        # projection table are not read.
        self.assertEqual(result['pages']['touchedTables'], ['effect_sql_migrations'])
        self.assertLess(result['decodedRows'], 200)

    def test_without_migration_permission_refuses(self):
        with self.assertRaisesRegex(proof.Refused, '^schema$'):
            self.prove(self.flow(*migration(70)), migrations=False)

    def test_undeclared_extra_table_refuses(self):
        flow = self.flow(*migration(70), ('CREATE TABLE surprise (id INTEGER PRIMARY KEY)', []))
        with self.assertRaisesRegex(proof.Refused, 'schema-undeclared:surprise'): self.prove(flow)

    def test_undeclared_extra_index_refuses(self):
        flow = self.flow(*migration(71), ('CREATE INDEX surprise_idx ON scheduled_tasks(cron)', []))
        with self.assertRaisesRegex(proof.Refused, 'schema-undeclared:surprise_idx'): self.prove(flow)

    def test_modified_existing_table_sql_refuses(self):
        flow = self.flow(*migration(70), ('ALTER TABLE scheduled_tasks ADD COLUMN note TEXT', []))
        with self.assertRaisesRegex(proof.Refused, 'schema-existing-changed'): self.prove(flow)

    def test_dropped_index_refuses(self):
        flow = self.flow(*migration(71), ('DROP INDEX orchestration_v2_projection_nodes_thread_run_idx', []))
        with self.assertRaisesRegex(proof.Refused, 'schema-existing-changed'): self.prove(flow)

    def test_data_rewrite_in_existing_table_refuses(self):
        flow = self.flow(*migration(70), ("UPDATE scheduled_tasks SET cron='rewritten'", []))
        with self.assertRaisesRegex(proof.Refused, 'authority-table-changed:scheduled_tasks'): self.prove(flow)

    def test_history_rewrite_refuses(self):
        flow = self.flow(*migration(71), ("UPDATE orchestration_events SET payload_json='rewritten' WHERE sequence=1", []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_projection_rewrite_without_event_refuses(self):
        flow = self.flow(*migration(71), ("UPDATE orchestration_v2_projection_nodes SET status='waiting'", []), writes=False)
        with self.assertRaisesRegex(proof.Refused, 'projection-without-event'): self.prove(flow)

    def test_declared_object_with_other_sql_refuses(self):
        flow = self.flow(*migration(70, ['CREATE TABLE orchestration_v2_thread_history_compactions (thread_id TEXT PRIMARY KEY, extra TEXT)']))
        with self.assertRaisesRegex(proof.Refused, 'schema-sql'): self.prove(flow)

    def test_every_full_read_migration_refuses(self):
        """Each FULL_READ migration, run by its own source on a database that ran every earlier
        one: the page proof refuses it, so the update takes the full read, whose room the helper
        checks before the stop. A migration listed there by mistake fails here."""
        for number in sorted(additive_migrations.FULL_READ):
            earlier = [step for done in range(70, number) for step in migration(done)]
            with self.subTest(migration=number):
                flow = self.flow(*migration(number), ran=earlier, through=min(number - 1, 69))
                with self.assertRaisesRegex(proof.Refused, 'schema-existing-changed'): self.prove(flow)
                self.assertEqual(additive_migrations.full_read_pending(number - 1)[0], number)
                self.assertNotIn(number, additive_migrations.full_read_pending(number))
        self.assertEqual(additive_migrations.full_read_pending(None), [])

    def test_undeclared_migration_number_refuses(self):
        flow = self.flow(*migration(999, ['CREATE TABLE later_feature (id INTEGER PRIMARY KEY)']))
        with self.assertRaisesRegex(proof.Refused, 'migration-undeclared:999'): self.prove(flow)

    def test_migration_name_mismatch_refuses(self):
        statements = migration(70)
        statements[-1] = (statements[-1][0], [70, 'SomethingElse'])
        with self.assertRaisesRegex(proof.Refused, 'migration-undeclared:70'): self.prove(self.flow(*statements))

    def test_schema_change_without_migration_row_refuses(self):
        flow = self.flow(*migration(70)[:-1])
        with self.assertRaisesRegex(proof.Refused, 'schema-without-migration'): self.prove(flow)

    def test_earlier_migration_row_rewritten_refuses(self):
        flow = self.flow(*migration(70), ("UPDATE effect_sql_migrations SET name='Changed' WHERE migration_id=3", []))
        with self.assertRaisesRegex(proof.Refused, 'migration-row-changed'): self.prove(flow)

    def test_partial_declared_migration_refuses(self):
        flow = self.flow(*migration(71, source_statements(71)[:1]))
        with self.assertRaisesRegex(proof.Refused, 'schema-missing'): self.prove(flow)

    def test_added_tree_on_a_page_still_in_use_refuses(self):
        # A new index whose root names an earlier table's leaf (a corrupt schema) shares a page.
        flow = self.flow(*migration(71))
        live = proof.PageProof.check_added
        def shared(instance):
            name = sorted(instance.added)[0]
            kind, table, _ = instance.added[name]
            instance.added[name] = (kind, table, instance.trees[1][1])
            return live(instance)
        with patch.object(proof.PageProof, 'check_added', shared), self.assertRaisesRegex(proof.Refused, 'added-tree'):
            self.prove(flow)


class DeclaredMigrations(unittest.TestCase):
    """additive_migrations.DECLARED is what the server's migrations create, as SQLite stores it."""

    def test_declared_sql_is_the_server_source(self):
        index = (MIGRATIONS_SOURCE / 'Migrations.ts').read_text()
        for number, (name, objects) in additive_migrations.DECLARED.items():
            # Registered under its number, from its file, whatever the formatting of the entry.
            self.assertRegex(index, r'\[\s*%d\s*,\s*"%s"' % (number, name))
            self.assertEqual(len(list(MIGRATIONS_SOURCE.joinpath('Migrations').glob('%03d_%s.ts' % (number, name)))), 1)
            statements = [additive_migrations.normalized(re.sub(r'\bIF NOT EXISTS\s+', '', sql, flags=re.I))
                          for sql in source_statements(number)]
            self.assertEqual(statements, [sql for _, _, _, sql in objects if sql is not None])

    def test_every_server_migration_is_classified(self):
        """A release whose new migration is neither declared additive nor listed as needing the full
        read fails here, before it ships: the update helper decides from these lists, before the
        service stops, whether the full read and its disk room are needed (M4, 1.0.184, 072)."""
        index = (MIGRATIONS_SOURCE / 'Migrations.ts').read_text()
        numbers = sorted({int(path.name[:3]) for path in MIGRATIONS_SOURCE.joinpath('Migrations').glob('[0-9][0-9][0-9]_*.ts')
                          if not path.name.endswith('.test.ts')})
        tracked = [number for number in numbers if number >= additive_migrations.FIRST_TRACKED]
        self.assertTrue(tracked)
        lists = (additive_migrations.DECLARED, additive_migrations.REBUILT, additive_migrations.FULL_READ)
        for first, second in ((0, 1), (0, 2), (1, 2)):
            self.assertFalse(set(lists[first]) & set(lists[second]))
        for number in tracked:
            self.assertTrue(any(number in listed for listed in lists),
                            'Server migration %03d is in none of additive_migrations.DECLARED, REBUILT and FULL_READ' % number)
        named = {**additive_migrations.FULL_READ, **{number: value[0] for number, value in additive_migrations.REBUILT.items()}}
        for number, name in named.items():
            # Registered under its number, from its file, whatever the formatting of the entry.
            self.assertRegex(index, r'\[\s*%d\s*,\s*"%s"' % (number, name))
            self.assertEqual(len(list(MIGRATIONS_SOURCE.joinpath('Migrations').glob('%03d_%s.ts' % (number, name)))), 1)

    def test_declared_objects_are_what_sqlite_stores(self):
        for number, (_, objects) in additive_migrations.DECLARED.items():
            db = sqlite3.connect(':memory:')
            db.executescript(fixture.SCHEMA)
            before = {row[0] for row in db.execute('SELECT name FROM sqlite_master')}
            for sql in source_statements(number):
                db.execute(sql)
            stored = sorted((kind, name, table, additive_migrations.normalized(sql))
                            for kind, name, table, sql in db.execute('SELECT type, name, tbl_name, sql FROM sqlite_master')
                            if name not in before)
            self.assertEqual(stored, sorted(objects))

    def test_normalized_keeps_quoted_whitespace(self):
        self.assertEqual(additive_migrations.normalized("CREATE  INDEX\n i ON t(a)  WHERE b = 'x  y'"),
                         "CREATE INDEX i ON t(a) WHERE b = 'x  y'")
        self.assertNotEqual(additive_migrations.normalized("WHERE b = 'x  y'"), additive_migrations.normalized("WHERE b = 'x y'"))


COMPACTIONS = 'orchestration_v2_thread_history_compactions'
AUTOINDEX = 'sqlite_autoindex_orchestration_v2_thread_history_compactions_1'


def compaction_rows(count=260):
    """What the old service wrote to the table 070 created: one row per compacted thread, rowids
    with gaps (rows deleted), NULL and long cells (a row on overflow pages)."""
    rows = [("INSERT INTO %s VALUES (?, ?, ?, ?, ?)" % COMPACTIONS,
             ['thread-%04d' % index, 'deleted' if index % 3 else 'archived', index * 7,
              '2026-10-%02dT10:00:00Z' % (1 + index % 28), None if index % 5 else '2026-11-01T00:00:00Z'])
            for index in range(count)]
    rows.append(("INSERT INTO %s VALUES ('thread-long', 'archived', 99, ?, NULL)" % COMPACTIONS, ['x' * 9000]))
    rows.append(("DELETE FROM %s WHERE thread_id IN ('thread-0003', 'thread-0100')" % COMPACTIONS, []))
    return rows


def read_capture(path, widen_from=None):
    """The complete capture (database_continuity) of the database at `path`, read only."""
    db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    try:
        db.execute('BEGIN')
        return continuity.capture_connection(db, widen_from)
    finally:
        db.close()


class RebuiltMigrations(unittest.TestCase):
    """Migration 072 rebuilds orchestration_v2_thread_history_compactions (CREATE _next, copy, DROP,
    RENAME) to widen a CHECK. The page proof and the full read's schema check accept exactly that
    declared rebuild, run here by the server's own SQL on a database that ran 070 and 071."""

    def setUp(self):
        p = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        p.start()
        self.addCleanup(p.stop)

    def flow(self, *statements, writes=True, earlier=(70, 71), rows=True):
        steps = AdditiveMigrations.flow
        ran = [step for number in earlier for step in migration(number)] + (compaction_rows() if rows and 70 in earlier else [])
        return steps(self, *statements, writes=writes, ran=ran)

    def prove(self, flow, migrations=True):
        return proof.prove(flow.state, flow.held, '2026-10-22T14:00:00Z', '2026-10-22T14:06:00Z', migrations=migrations)

    def full_read(self, flow):
        """update_migration's checks on the full read: the stopped clone against the live database
        captured with the migration baseline (update.py's widen_from)."""
        before = read_capture(flow.held['clone'])
        after = read_capture(flow.database, before['schema']['columns'])
        guarded = {table: 0 for table in before['legacy']
                   if table.startswith(('projection_', 'orchestration_', 'project_')) or table in update_read.AUTHORITY_TABLES}
        rows = [{'counts': {table: capture['legacy'][table]['count'] for table in guarded},
                 'hashes': {table: capture['legacy'][table]['sha256'] for table in guarded},
                 'projectIds': [], 'threadIds': [], 'nativeWorkIdle': True,
                 update_read.ACTIVITY_KEY: {}} for capture in (before, after)]
        update_migration.assert_migration_preserved(rows[0], rows[1])
        update_migration.assert_migration_typed_cells(before, after, rows[0], rows[1])
        update_migration.assert_migration_protected_schema(before, after, rows[0])
        return before, after

    def test_faithful_rebuild_keeps_the_page_proof_and_the_full_read(self):
        for writes in (False, True):
            with self.subTest(writes=writes):
                flow = self.flow(*migration(72), writes=writes)
                result = self.prove(flow)
                self.assertTrue(result['preserved'])
                delta = result['schemaDelta']
                self.assertEqual(delta['migrations'], [72])
                self.assertEqual(delta['objects'], [])
                self.assertEqual(delta['rebuilt'], sorted([COMPACTIONS, AUTOINDEX]))
                self.assertEqual(delta['rebuiltRows'], 259)
                self.assertNotIn(COMPACTIONS, result['pages']['touchedTables'])
                if writes:
                    self.assertEqual(result['appendedRows']['orchestration_events'], 30)
                else:
                    self.assertEqual(result['pages']['touchedTables'], ['effect_sql_migrations'])
                    _, after = self.full_read(flow)
                    self.assertEqual(after['rebuilt'], {COMPACTIONS: [72, 'RetentionHorizon']})

    def test_faithful_rebuild_of_an_empty_table(self):
        """M4's stopped copy of November 4 (migration 071) holds no compaction row."""
        flow = self.flow(*migration(72), writes=False, rows=False)
        result = self.prove(flow)
        self.assertEqual(result['schemaDelta']['rebuiltRows'], 0)
        self.full_read(flow)

    def test_070_071_and_072_in_one_update(self):
        result = self.prove(self.flow(*migration(70), *migration(71), *migration(72), earlier=()))
        self.assertEqual(result['schemaDelta']['migrations'], [70, 71, 72])
        self.assertIn(COMPACTIONS, result['schemaDelta']['objects'])
        self.assertNotIn('rebuilt', result['schemaDelta'])

    def assert_refused(self, flow, reason, full_read=None):
        with self.assertRaisesRegex(proof.Refused, reason):
            self.prove(flow)
        if full_read is not None:
            with self.assertRaisesRegex(AssertionError, full_read):
                self.full_read(flow)

    def test_rebuild_that_drops_a_row_refuses(self):
        flow = self.flow(*migration(72), ("DELETE FROM %s WHERE thread_id='thread-0007'" % COMPACTIONS, []), writes=False)
        self.assert_refused(flow, 'rebuild-rows:' + COMPACTIONS, 'rows changed during migration')

    def test_rebuild_that_adds_a_row_refuses(self):
        flow = self.flow(*migration(72), ("INSERT INTO %s VALUES ('thread-new', 'horizon', 1, 'now', NULL)" % COMPACTIONS, []),
                         writes=False)
        self.assert_refused(flow, 'rebuild-rows:' + COMPACTIONS, 'rows changed during migration')

    def test_rebuild_that_changes_a_cell_refuses(self):
        for change in ("UPDATE %s SET through_sequence=through_sequence+1 WHERE thread_id='thread-0010'",
                       "UPDATE %s SET kind='horizon' WHERE thread_id='thread-0011'",
                       "UPDATE %s SET completed_at=CAST('2026' AS BLOB) WHERE thread_id='thread-0012'"):
            with self.subTest(change=change):
                flow = self.flow(*migration(72), (change % COMPACTIONS, []), writes=False)
                self.assert_refused(flow, 'rebuild-rows:' + COMPACTIONS, 'changed during migration')

    def test_retention_write_after_the_rebuild_refuses(self):
        """The new service writing the table after 072 (a 'horizon' marker, or completed_at set on a
        half-finished pass) is a change the proof does not accept: strict equality, as without 072."""
        for change in ("INSERT INTO %s VALUES ('thread-later', 'horizon', 40, '2026-11-04T10:00:00Z', NULL)",
                       "UPDATE %s SET completed_at='2026-11-04T10:00:00Z' WHERE thread_id='thread-0001'"):
            with self.subTest(change=change):
                flow = self.flow(*migration(72), writes=True)
                flow.new.commit((change % COMPACTIONS, []))
                with self.assertRaisesRegex(proof.Refused, 'rebuild-rows:' + COMPACTIONS):
                    self.prove(flow)
        flow = self.flow(*migration(72), writes=False)
        flow.new.commit(("UPDATE %s SET completed_at='2026-11-04T10:00:00Z' WHERE thread_id='thread-0001'" % COMPACTIONS, []))
        self.assert_refused(flow, 'rebuild-rows:' + COMPACTIONS, 'changed during migration')

    def test_retention_write_without_a_rebuild_refuses_as_well(self):
        flow = self.flow(("UPDATE %s SET completed_at='2026-11-04T10:00:00Z' WHERE thread_id='thread-0001'" % COMPACTIONS, []),
                         writes=False)
        with self.assertRaisesRegex(proof.Refused, 'authority-table-changed:' + COMPACTIONS):
            self.prove(flow)

    def test_rebuilt_index_missing_a_row_refuses(self):
        flow = self.flow(*migration(72), writes=False)
        lines = proof.PageProof.rebuilt_lines
        def short_index(instance, db, query):
            values = lines(instance, db, query)
            return values[1:] if ' INDEXED BY ' in query else values
        with patch.object(proof.PageProof, 'rebuilt_lines', short_index):
            self.assert_refused(flow, 'rebuild-index:' + AUTOINDEX)

    def test_rebuild_beyond_its_budgets_refuses(self):
        flow = self.flow(*migration(72), writes=False)
        with patch.object(proof, 'MAX_CHANGED_ROWS', 100):
            self.assert_refused(flow, 'changed-row-budget')
        with patch.object(proof, 'MAX_CHANGED_BYTES', 1000):
            self.assert_refused(flow, 'changed-row-budget')
        with patch.object(proof, 'MAX_REBUILT_PAGES', 1):
            self.assert_refused(flow, 'rebuild-budget')

    def test_full_read_needs_the_migration_baseline_and_a_new_rebuild(self):
        """Without widen_from the capture records no rebuild and the full read refuses (fail closed);
        a database before that already records the rebuild is not a rebuild this update ran."""
        flow = self.flow(*migration(72), writes=False)
        before, after = self.full_read(flow)
        rows = {'counts': {COMPACTIONS: 0}}
        bare = read_capture(flow.database)
        self.assertNotIn('rebuilt', bare)
        self.assertFalse(additive_migrations.rebuild_accepted(
            COMPACTIONS, *(next(item[3] for item in capture['schema']['objects'] if item[1] == COMPACTIONS)
                           for capture in (before, after)),
            before['schema']['columns'][COMPACTIONS], after['schema']['columns'][COMPACTIONS], bare.get('rebuilt')))
        with self.assertRaisesRegex(AssertionError, 'table definition changed'):
            update_migration.assert_migration_protected_schema(before, bare, rows)
        with self.assertRaisesRegex(AssertionError, 'table definition changed'):
            update_migration.assert_migration_protected_schema({**before, 'rebuilt': after['rebuilt']}, after, rows)
        update_migration.assert_migration_protected_schema(before, after, rows)

    def test_072_needs_no_full_read_room(self):
        self.assertEqual(additive_migrations.full_read_pending(71), [])
        self.assertEqual(additive_migrations.full_read_pending(68), [69])
        self.assertNotIn(72, additive_migrations.FULL_READ)
        self.assertEqual(additive_migrations.REBUILT[72][1][COMPACTIONS]['before'],
                         next(sql for kind, name, _, sql in additive_migrations.DECLARED[70][1]
                              if (kind, name) == ('table', COMPACTIONS)))

    def test_rebuild_with_other_columns_refuses(self):
        create, *rest = source_statements(72)
        for changed in (create.replace('through_sequence INTEGER NOT NULL', 'through_sequence TEXT NOT NULL'),
                        create.replace('completed_at TEXT', 'completed_at TEXT, note TEXT')):
            statements = [changed] + rest
            if 'note TEXT' in changed:
                statements[1] = statements[1].replace('completed_at\n    )', 'completed_at, note\n    )', 1) \
                    .replace('completed_at\n    FROM', "completed_at, NULL\n    FROM", 1)
            with self.subTest(sql=changed):
                flow = self.flow(*migration(72, statements), writes=False)
                self.assert_refused(flow, 'rebuild-sql:' + COMPACTIONS, 'changed during migration')

    def test_rebuild_leaving_old_pages_owned_refuses(self):
        """Every page of the old trees must be free in the live database (or a changed page another
        compared tree now owns): here the live freelist is read without them, as a leaked tree."""
        flow = self.flow(*migration(72), writes=False)
        live = proof.PageProof.free_pages
        def without_old(instance, version):
            pages = live(instance, version)
            old = set()
            for _, _, root, _ in instance.rebuilt.values():
                nodes, overflow = instance.tree_pages('clone', root, instance.tree('clone', root)[2])
                old |= nodes | overflow
            self.assertTrue(old & pages)
            return pages - old
        with patch.object(proof.PageProof, 'free_pages', without_old):
            self.assert_refused(flow, 'rebuild-old-page-kept')

    def test_rebuild_with_a_new_tree_page_older_than_the_stop_refuses(self):
        flow = self.flow(*migration(72), writes=False)
        live = proof.PageProof.tree_pages
        def stale(instance, version, root, family):
            nodes, overflow = live(instance, version, root, family)
            return (nodes | {2}, overflow) if version == 'live' else (nodes, overflow)
        with patch.object(proof.PageProof, 'tree_pages', stale):
            self.assert_refused(flow, 'rebuild-tree-page-unchanged|page-owned-twice')

    def test_undeclared_rebuild_of_another_table_refuses(self):
        rebuild = [
            ('CREATE TABLE orchestration_v2_effect_outbox_next (effect_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, '
             'thread_id TEXT NOT NULL, effect_type TEXT NOT NULL, payload_json TEXT NOT NULL, '
             "status TEXT NOT NULL CHECK (status <> ''), created_at TEXT NOT NULL)", []),
            ('INSERT INTO orchestration_v2_effect_outbox_next SELECT * FROM orchestration_v2_effect_outbox', []),
            ('DROP TABLE orchestration_v2_effect_outbox', []),
            ('ALTER TABLE orchestration_v2_effect_outbox_next RENAME TO orchestration_v2_effect_outbox', [])]
        flow = self.flow(*migration(72)[:-1], *rebuild, migration(72)[-1], writes=False)
        self.assert_refused(flow, 'schema-existing-changed', 'table definition changed during migration')
        # The same rebuild without 072, and the 072 rebuild under another migration, also refuse.
        self.assert_refused(self.flow(*rebuild, ('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (72, ?)',
                                                 ['RetentionHorizon']), writes=False), 'schema-existing-changed')
        renamed = migration(72)
        renamed[-1] = (renamed[-1][0], [72, 'SomethingElse'])
        self.assert_refused(self.flow(*renamed, writes=False), 'schema-existing-changed',
                            'table definition changed during migration')
        self.assert_refused(self.flow(*migration(72)[:-1], ('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (73, ?)',
                                                            ['RetentionHorizon']), writes=False), 'schema-existing-changed')

    def test_rebuild_without_its_migration_row_refuses(self):
        flow = self.flow(*migration(72)[:-1], writes=False)
        self.assert_refused(flow, 'schema-existing-changed', 'table definition changed during migration')

    def test_partial_rebuild_refuses(self):
        """072's row with only some of the declared entries moved is not the declared rebuild."""
        old, new = (sqlite3.connect(':memory:') for _ in range(2))
        for db in (old, new):
            db.execute(MIGRATIONS_TABLE)
            db.executemany('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)',
                           [(70, 'ThreadHistoryCompactions'), (71, 'HotReadPartialIndexes')])
            for sql in source_statements(70):
                db.execute(sql)
        for sql, parameters in migration(72):
            new.execute(sql, parameters)
        query = 'SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name'
        before, after = ([tuple(row) for row in db.execute(query)] for db in (old, new))
        self.assertEqual(sorted(additive_migrations.delta(before, after, old, new)['rebuilt']), sorted([COMPACTIONS, AUTOINDEX]))
        kept_table = [row if row[1] != COMPACTIONS else next(item for item in before if item[1] == COMPACTIONS) for row in after]
        with self.assertRaisesRegex(additive_migrations.Undeclared, 'rebuild-partial'):
            additive_migrations.delta(before, kept_table, old, new)
        kept_index = [row if row[1] != AUTOINDEX else next(item for item in before if item[1] == AUTOINDEX) for row in after]
        with self.assertRaisesRegex(additive_migrations.Undeclared, 'rebuild-partial'):
            additive_migrations.delta(before, kept_index, old, new)
        same_root = [row if row[1] != COMPACTIONS else row[:3] + (next(item for item in before if item[1] == COMPACTIONS)[3], row[4])
                     for row in after]
        with self.assertRaisesRegex(additive_migrations.Undeclared, 'rebuild-root'):
            additive_migrations.delta(before, same_root, old, new)
        new.execute('ALTER TABLE %s ADD COLUMN note TEXT' % COMPACTIONS)
        widened = [row if row[1] != COMPACTIONS else row[:4] + (additive_migrations.REBUILT[72][1][COMPACTIONS]['after'],)
                   for row in after]
        with self.assertRaisesRegex(additive_migrations.Undeclared, 'rebuild-columns'):
            additive_migrations.delta(before, widened, old, new)

    def test_full_read_accepts_only_the_declared_sql(self):
        flow = self.flow(*migration(72), writes=False)
        before, after = self.full_read(flow)
        declared = additive_migrations.REBUILT[72][1][COMPACTIONS]
        sql = {item[1]: item[3] for item in after['schema']['objects'] if item[0] == 'table'}
        self.assertEqual(additive_migrations.normalized(sql[COMPACTIONS]), declared['after'])
        rows = {'counts': {COMPACTIONS: 0}}
        for recorded in (None, {COMPACTIONS: [72, 'Other']}, {COMPACTIONS: [73, 'RetentionHorizon']}):
            with self.subTest(recorded=recorded):
                changed = {**after}
                changed.pop('rebuilt')
                if recorded:
                    changed['rebuilt'] = recorded
                with self.assertRaisesRegex(AssertionError, 'table definition changed'):
                    update_migration.assert_migration_protected_schema(before, changed, rows)
        update_migration.assert_migration_protected_schema(before, after, rows)


class DeclaredRebuilds(unittest.TestCase):
    """additive_migrations.REBUILT is what the server's migration leaves, as SQLite stores it."""

    def test_declared_rebuild_is_the_server_source(self):
        index = (MIGRATIONS_SOURCE / 'Migrations.ts').read_text()
        for number, (name, tables) in additive_migrations.REBUILT.items():
            self.assertRegex(index, r'\[\s*%d\s*,\s*"%s"' % (number, name))
            db = sqlite3.connect(':memory:')
            db.executescript(fixture.SCHEMA)
            for sql in source_statements(70):
                db.execute(sql)
            master = 'SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name=? ORDER BY type, name'
            for table, declared in tables.items():
                self.assertNotRegex(table, additive_migrations._PROTECTED)
                self.assertNotIn(table, update_read.AUTHORITY_TABLES + update_read.LOG_TABLES)
                self.assertEqual([additive_migrations.normalized(row[3]) for row in db.execute(master, (table,)) if row[0] == 'table'],
                                 [declared['before']])
            for sql in source_statements(number):
                db.execute(sql)
            for table, declared in tables.items():
                stored = list(db.execute(master, (table,)))
                self.assertEqual([additive_migrations.normalized(row[3]) for row in stored if row[0] == 'table'], [declared['after']])
                self.assertEqual(sorted(row[1] for row in stored if row[0] == 'index'), sorted(declared['indexes']))
                self.assertTrue(all(row[3] is None for row in stored if row[0] == 'index'))
                self.assertEqual([list(row) for row in db.execute('PRAGMA table_xinfo(%s)' % table)], declared['columns'])


class AutoVacuum:
    """The same cases on an auto_vacuum=INCREMENTAL database (the fixture's AutoVacuum)."""

    def setUp(self):
        super().setUp()
        patcher = patch.dict(fixture.build.__globals__, {'AUTO_VACUUM': 2})
        patcher.start()
        self.addCleanup(patcher.stop)


class PreservationAutoVacuum(AutoVacuum, Preservation):
    def test_pointer_map_entries_are_checked(self):
        result = self.prove(self.flow(writes=True))
        self.assertTrue(result['preserved'])
        self.assertGreater(result['pages']['pointerMapEntries'], 0)


class AdditiveMigrationsAutoVacuum(AutoVacuum, AdditiveMigrations):
    def test_declared_migration_without_other_writes(self):
        """A new root takes the page after the last root, and the page that was there moves to the
        end of the file: its table is compared by rows as any touched table is."""
        result = self.prove(self.flow(*migration(70), *migration(71), writes=False))
        self.assertTrue(result['preserved'])
        self.assertEqual(result['schemaDelta']['migrations'], [70, 71])
        self.assertIn('effect_sql_migrations', result['pages']['touchedTables'])
        self.assertGreater(result['pages']['pointerMapEntries'], 0)


    def test_a_largest_root_page_that_is_not_the_schemas_refuses(self):
        flow = self.flow(*migration(70), *migration(71))
        page = proof.PageProof.page

        def read(instance, version, number):
            data = page(instance, version, number)
            if version == 'live' and number == 1:
                data = data[:52] + struct.pack('>I', struct.unpack_from('>I', data, 52)[0] - 1) + data[56:]
            return data
        with patch.object(proof.PageProof, 'page', read):
            with self.assertRaisesRegex(proof.Refused, '^schema:largest-root$'):
                self.prove(flow)


class RebuiltMigrationsAutoVacuum(AutoVacuum, unittest.TestCase):
    """DROP TABLE in an auto-vacuum database moves the last root into the freed root's place, so a
    rebuilt table ends on its old root page: the proof refuses and the full read decides."""

    setUp_memory, flow, prove, full_read = RebuiltMigrations.setUp, RebuiltMigrations.flow, RebuiltMigrations.prove, RebuiltMigrations.full_read

    def setUp(self):
        super().setUp()
        self.setUp_memory()

    def test_a_declared_rebuild_is_left_to_the_full_read(self):
        flow = self.flow(*migration(72), writes=False)
        with self.assertRaisesRegex(proof.Refused, '^schema:rebuild-root:' + COMPACTIONS + '$'):
            self.prove(flow)
        self.full_read(flow)


if __name__ == '__main__': unittest.main()
