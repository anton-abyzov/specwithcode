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
import page_continuity as proof
import kept_lines

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
    name = additive_migrations.DECLARED[number][0] if number in additive_migrations.DECLARED else 'Undeclared'
    return [(sql, []) for sql in (source_statements(number) if statements is None else statements)] + \
        [('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [number, name])]


class AdditiveMigrations(unittest.TestCase):
    """Declared additive migrations keep the page proof; any other schema change still refuses."""

    def setUp(self):
        p = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        p.start()
        self.addCleanup(p.stop)

    def flow(self, *statements, writes=True):
        """The old service has run migrations 1-69; the new one runs `statements` at startup, then
        the usual startup writes."""
        flow = fixture.Update(self, written=[(MIGRATIONS_TABLE, [])] + [
            ('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [number, 'M%d' % number])
            for number in range(1, 70)])
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

    def test_undeclared_migration_number_refuses(self):
        flow = self.flow(*migration(72, ['CREATE TABLE later_feature (id INTEGER PRIMARY KEY)']))
        with self.assertRaisesRegex(proof.Refused, 'migration-undeclared:72'): self.prove(flow)

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
            self.assertRegex(index, r'\[%d, "%s", Migration%04d\]' % (number, name, number))
            statements = [additive_migrations.normalized(re.sub(r'\bIF NOT EXISTS\s+', '', sql, flags=re.I))
                          for sql in source_statements(number)]
            self.assertEqual(statements, [sql for _, _, _, sql in objects if sql is not None])

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


if __name__ == '__main__': unittest.main()
