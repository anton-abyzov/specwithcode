#!/usr/bin/env python3
"""Every migration the page proof refuses (additive_migrations.FULL_READ) and every declared rebuild
(REBUILT) completes an update: update.apply, with the new service running that migration's own SQL
from apps/server/src/persistence/Migrations over its populated FIXTURES rows, reaches phase
verified, and every fixture row is still there afterwards.

test-page-continuity.py's test_every_full_read_migration_refuses proves the page proof refuses
each FULL_READ migration; this proves the update then finishes. M4's 1.0.184 receipt stopped at
restart-requested after 072's full read (then a FULL_READ entry) ran out of scratch room, and
1.0.180's stopped there after a protected write. Two paths, both on synthetic temporary state:
  - held page mode (the real _apply policy, a real WAL writer in its own process), where a declared
    rebuild keeps the page proof and a FULL_READ migration falls back to the full read;
  - the full read alone (ApplyRecovery's captured waiting-thread state).
Never a live user database."""
import importlib.util
import json
import pathlib
import re
import sqlite3
import unittest
from unittest.mock import patch

import additive_migrations
import kept_lines

HERE = pathlib.Path(__file__).resolve().parent
MIGRATIONS = HERE.parents[1] / 'apps/server/src/persistence/Migrations'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


updater_base = load('full_read_update_base', 'test-update.py')
page_base = load('full_read_page_base', 'test-update-page-mode.py')
update = updater_base.update
CHECKED = sorted(set(additive_migrations.FULL_READ) | set(additive_migrations.REBUILT))
MIGRATIONS_TABLE = ('CREATE TABLE "effect_sql_migrations" (migration_id integer PRIMARY KEY NOT NULL, '
                    'created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)')


def name(number):
    return additive_migrations.FULL_READ.get(number) or additive_migrations.REBUILT[number][0]


def source_statements(number):
    """The statements migration `number` runs, as the server's source writes them (a typed read
    such as 069's sql<...>`PRAGMA ...` writes nothing and is left out)."""
    files = [path for path in MIGRATIONS.glob('%03d_*.ts' % number) if not path.name.endswith('.test.ts')]
    assert len(files) == 1, files
    return tuple(re.findall(r'sql`(.*?)`;', files[0].read_text(), re.S))


def table_sql(number, table):
    """The CREATE TABLE of a fixture table that the base schema does not have: the declared rebuild's
    'before' SQL, else the additive migration that created it."""
    rebuilt = (additive_migrations.REBUILT.get(number) or ('', {}))[1].get(table)
    if rebuilt:
        return rebuilt['before']
    for declared in additive_migrations.DECLARED.values():
        for kind, entry, _, sql in declared[1]:
            if (kind, entry) == ('table', table):
                return sql
    raise AssertionError('No CREATE TABLE known for fixture table ' + table)


def columns(db, table):
    return [row[1] for row in db.execute('PRAGMA table_info("%s")' % table)]


def prepare(path, number):
    """(statement, parameters) pairs that bring the database at `path` to just before `number`:
    the migrations table with every earlier row, the fixture tables, and FIXTURES[number]'s rows,
    each written with the columns the table has."""
    db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    try:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        steps = []
        if 'effect_sql_migrations' not in tables:
            steps.append((MIGRATIONS_TABLE, []))
        steps += [('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [done, 'M%d' % done])
                  for done in range(1, number)]
        for table, rows in additive_migrations.FIXTURES[number].items():
            if table in tables:
                present = columns(db, table)
            else:
                steps.append((table_sql(number, table), []))
                memory = sqlite3.connect(':memory:')
                memory.execute(table_sql(number, table))
                present = columns(memory, table)
                memory.close()
            for row in rows:
                kept = [column for column in row if column in present]
                steps.append(('INSERT INTO "%s"(%s) VALUES (%s)' % (table, ', '.join(kept), ', '.join('?' * len(kept))),
                              [row[column] for column in kept]))
        return steps
    finally:
        db.close()


def migration(number):
    return [(sql, []) for sql in source_statements(number)] + \
        [('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [number, name(number)])]


def fixture_rows_kept(test, path, number):
    db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    try:
        for table, rows in additive_migrations.FIXTURES[number].items():
            key = next(iter(rows[0]))
            found = {row[0] for row in db.execute('SELECT "%s" FROM "%s"' % (key, table))}
            test.assertTrue({row[key] for row in rows} <= found, table)
        test.assertEqual(db.execute('SELECT name FROM effect_sql_migrations WHERE migration_id=?', (number,)).fetchone(),
                         (name(number),))
    finally:
        db.close()


class Coverage(unittest.TestCase):
    def test_every_checked_migration_has_a_fixture_and_its_source(self):
        self.assertIn(69, CHECKED)
        self.assertIn(72, CHECKED)
        for number in CHECKED:
            with self.subTest(migration=number):
                self.assertTrue(additive_migrations.FIXTURES.get(number))
                self.assertTrue(source_statements(number))


class PageModeCompletes(unittest.TestCase):
    """The real _apply policy with a held page-mode admission, as an update agent runs it."""

    def setUp(self):
        p = patch.object(kept_lines, 'available_disk', return_value=500 * 10 ** 9)
        p.start()
        self.addCleanup(p.stop)

    def apply(self, number):
        branches = page_base.ApplyBranches('run_apply')
        branches.setUp()
        self.addCleanup(branches.doCleanups)
        h = branches.h
        database = h.own / 'userdata/statev2.sqlite'
        branches.old.commit(*prepare(database, number))
        started = h.on_restart

        def restarted():
            started()
            branches.new.commit(*migration(number))
        h.on_restart = restarted
        with patch.object(branches.update, '_service', return_value=branches.service), \
                patch.object(branches.update, '_snapshot', side_effect=branches.metadata):
            h.execute(allow_project_migrations=True)
        result = json.loads(h.output.read_text())
        branches.new.close()
        fixture_rows_kept(self, database, number)
        self.assertEqual(h.restores, [])
        return result

    def test_each_migration_reaches_verified(self):
        for number in CHECKED:
            with self.subTest(migration=number):
                result = self.apply(number)
                self.assertEqual(result['phase'], 'verified', result.get('error'))
                if number in additive_migrations.REBUILT:
                    # A declared rebuild keeps the page proof; the fixture rows are compared row for row.
                    self.assertEqual(result['rowPreservation'], 'verified-stopped-clone-pages')
                    self.assertEqual(result['databasePageProof']['schemaDelta']['migrations'], [number])
                    self.assertEqual(result['databasePageProof']['schemaDelta']['rebuiltRows'],
                                     sum(len(rows) for rows in additive_migrations.FIXTURES[number].values()))
                    self.assertNotIn('fullReadMigrations', result)
                else:
                    # The page proof refuses it; the full read it falls back to completes.
                    self.assertIn('schema', result['pageFallback'])
                    self.assertEqual(result['fullReadMigrations'], [number])
                    self.assertEqual(result['rowPreservation'], 'verified-migration')


class FullReadCompletes(updater_base.ApplyRecovery):
    """The full read alone, over the captured waiting-thread state with the fixture rows."""

    def test_each_migration_reaches_verified(self):
        for number in CHECKED:
            with self.subTest(migration=number):
                # A fresh temporary home per migration; unittest's own tearDown removes the last.
                self.tearDown()
                self.setUp()
                state = self.own / 'userdata'
                updater_base.waiting_fixture(state)
                database = state / 'statev2.sqlite'
                db = sqlite3.connect(database)
                for sql, parameters in prepare(database, number):
                    db.execute(sql, parameters)
                db.commit()
                db.close()
                self.real_db = self.capture_database = True
                self.before['rows'], _, self.before['databaseCapture'] = update._rows_snapshot(state, False, include_database=True)

                def restart():
                    db = sqlite3.connect(database)
                    for sql, parameters in migration(number):
                        db.execute(sql, parameters)
                    db.commit()
                    db.close()
                self.on_restart = restart
                self.execute(allow_project_migrations=True)
                result = json.loads(self.output.read_text())
                self.assertEqual(result['phase'], 'verified', result.get('error'))
                # The guarded rows are the same; a widened table is compared cell by cell.
                self.assertIn(result['rowPreservation'], ('verified-migration', 'byte-identical'))
                self.assertEqual(result['migrationProtectedCells'], 'typed-verified')
                for table, rows in additive_migrations.FIXTURES[number].items():
                    self.assertGreaterEqual(result['before']['rows']['counts'][table], len(rows))
                    self.assertEqual(result['after']['rows']['counts'][table], result['before']['rows']['counts'][table])
                if number in additive_migrations.REBUILT:
                    self.assertEqual(result['after']['databaseCapture']['rebuilt'],
                                     {table: [number, name(number)] for table in additive_migrations.REBUILT[number][1]})
                else:
                    # A FULL_READ widening names the columns it added to each fixture table.
                    self.assertEqual(sorted(result['migrationAddedColumns']), sorted(additive_migrations.FIXTURES[number]))
                self.assertEqual(self.restores, [])
                fixture_rows_kept(self, database, number)


if __name__ == '__main__':
    unittest.main()
