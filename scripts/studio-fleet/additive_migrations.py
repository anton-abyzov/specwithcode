"""Server migrations that only add schema objects, and the schema delta a restart may show for them.

The stopped-clone page proof (page_continuity) compares the database after the restart with the
stopped clone. A release whose migration only creates new tables or indexes changes sqlite_schema,
and that proof used to refuse any change there ('schema'), so the update read the whole database
instead (M4, 22 GB: 1.0.177 and 1.0.178, migrations 070 and 071, about 9 minutes each).

DECLARED lists, for each additive migration, the effect_sql_migrations row it records and the exact
sqlite_schema entries it creates (type, name, tbl_name, sql as SQLite stores it: from CREATE, with IF
NOT EXISTS dropped). test-page-continuity.py checks each entry against the server's migration
source (apps/server/src/persistence/Migrations) and against SQLite itself. A migration that is not
listed here, or one that alters, drops, renames or rewrites anything, never matches: the proof
refuses and the update takes the full read, as before.

delta() proves the schema delta between the stopped clone and the live database:
  - every sqlite_schema entry of the clone is in the live database unchanged (type, name, tbl_name,
    rootpage, sql): no table or index altered, dropped, renamed or moved;
  - every effect_sql_migrations row of the clone is unchanged, and each new row is a declared
    additive migration with its declared name;
  - the entries the live database adds are exactly the objects those new migrations declare (an
    object a declared IF NOT EXISTS migration found already present must be there unchanged);
  - only tables and indexes are added, each with a b-tree root page, none named like a protected
    authority or log table.
Rows written to the new tables after activation are new data; the page proof still checks every
page of every pre-existing b-tree as before.

REBUILT lists, for each migration that rebuilds a table only to change a constraint SQLite cannot
alter (CREATE _next, copy, DROP, RENAME), the exact sqlite_schema SQL of the table before and after,
its columns (PRAGMA table_xinfo, the same on both sides) and the indexes SQLite recreates for it.
delta() then also accepts exactly those entries changed (new root pages, the declared SQL on each
side) when that migration's row is among the added ones; the page proof (page_continuity) requires
the table's typed rows equal row for row, its new index to hold exactly those rows, every page of
the new trees written after the stop and every page of the old trees freed or reused, and the full
read's schema check (update_migration.assert_migration_protected_schema) accepts the same change
and nothing else (recorded_rebuilds).
"""
import re

MIGRATIONS_TABLE = 'effect_sql_migrations'


class Undeclared(Exception):
    """The schema delta is not exactly what declared additive migrations create."""


def normalized(sql):
    """`sql` with each run of ASCII whitespace outside quoted text written as one space."""
    if sql is None:
        return None
    out, quote, space = [], None, False
    for char in sql.strip(' \t\n\f\r'):
        if quote:
            out.append(char)
            if char == quote:
                quote = None
            continue
        if char in ' \t\n\f\r':
            space = True
            continue
        if space and out:
            out.append(' ')
        space = False
        out.append(char)
        if char in '\'"`[':
            quote = ']' if char == '[' else char
    return ''.join(out)


DECLARED = {
    # 068_ActiveTurnItemIndexes.ts
    68: ('ActiveTurnItemIndexes', (
        ('index', 'orchestration_v2_projection_turn_items_active_ordinal_idx', 'orchestration_v2_projection_turn_items',
         "CREATE INDEX orchestration_v2_projection_turn_items_active_ordinal_idx ON "
         "orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id) WHERE status IN ('pending', 'running', 'waiting')"),
        ('index', 'orchestration_v2_projection_turn_items_active_run_idx', 'orchestration_v2_projection_turn_items',
         "CREATE INDEX orchestration_v2_projection_turn_items_active_run_idx ON "
         "orchestration_v2_projection_turn_items(thread_id, run_id) WHERE status IN ('pending', 'running', 'waiting')"),
    )),
    # 070_ThreadHistoryCompactions.ts
    70: ('ThreadHistoryCompactions', (
        ('table', 'orchestration_v2_thread_history_compactions', 'orchestration_v2_thread_history_compactions',
         "CREATE TABLE orchestration_v2_thread_history_compactions ( thread_id TEXT PRIMARY KEY, "
         "kind TEXT NOT NULL CHECK (kind IN ('deleted', 'archived')), through_sequence INTEGER NOT NULL, "
         "compacted_at TEXT NOT NULL, completed_at TEXT )"),
        ('index', 'sqlite_autoindex_orchestration_v2_thread_history_compactions_1',
         'orchestration_v2_thread_history_compactions', None),
    )),
    # 071_HotReadPartialIndexes.ts
    71: ('HotReadPartialIndexes', (
        ('index', 'orchestration_v2_projection_nodes_active_idx', 'orchestration_v2_projection_nodes',
         "CREATE INDEX orchestration_v2_projection_nodes_active_idx ON orchestration_v2_projection_nodes(thread_id) "
         "WHERE status IN ('pending','starting','running','waiting')"),
        ('index', 'orchestration_v2_projection_nodes_active_root_idx', 'orchestration_v2_projection_nodes',
         "CREATE INDEX orchestration_v2_projection_nodes_active_root_idx ON orchestration_v2_projection_nodes(thread_id, run_id) "
         "WHERE kind = 'root_turn' AND status IN ('pending', 'running', 'waiting')"),
    )),
}

# Server migrations the page proof refuses (a rebuild, alter, drop or rename): an update that runs
# one takes the full read of the stopped clone and the live database, which spills its sorted
# runs to disk (database_continuity.SortedRuns). Each server migration since FIRST_TRACKED is in
# DECLARED or here; test-page-continuity.py fails a release that adds one to neither, so the helper
# shipped with a release always knows whether that release's migrations keep the page proof.
FULL_READ = {
    # 069_AuthSessionProofKeyThumbprint.ts: alters auth_sessions (a widening the full read accepts).
    69: 'AuthSessionProofKeyThumbprint',
}
FIRST_TRACKED = 68

_COMPACTIONS = 'orchestration_v2_thread_history_compactions'


def _declared_sql(number, kind, name):
    """The SQL DECLARED[number] holds for the (kind, name) entry, looked up by name, not position."""
    found = [sql for entry_kind, entry_name, _, sql in DECLARED[number][1] if (entry_kind, entry_name) == (kind, name)]
    assert len(found) == 1, (number, kind, name)
    return found[0]


# Declared rebuilds: {migration: (name, {table: {'before', 'after', 'columns', 'indexes'}})}. 'before'
# and 'after' are the table's sqlite_schema SQL (normalized) on each side; ALTER TABLE RENAME writes
# the new name quoted. 'columns' is PRAGMA table_xinfo on both sides; 'indexes' the indexes SQLite
# itself keeps for the table (sql NULL), which the rebuild recreates under the same names.
REBUILT = {
    # 072_RetentionHorizon.ts: rebuilds the table 070 created to widen its kind CHECK to 'horizon'.
    72: ('RetentionHorizon', {
        _COMPACTIONS: {
            'before': _declared_sql(70, 'table', _COMPACTIONS),
            'after': "CREATE TABLE \"orchestration_v2_thread_history_compactions\" ( thread_id TEXT PRIMARY KEY, "
                     "kind TEXT NOT NULL CHECK (kind IN ('deleted', 'archived', 'horizon')), through_sequence INTEGER NOT NULL, "
                     "compacted_at TEXT NOT NULL, completed_at TEXT )",
            'columns': [[0, 'thread_id', 'TEXT', 0, None, 1, 0], [1, 'kind', 'TEXT', 1, None, 0, 0],
                        [2, 'through_sequence', 'INTEGER', 1, None, 0, 0], [3, 'compacted_at', 'TEXT', 1, None, 0, 0],
                        [4, 'completed_at', 'TEXT', 0, None, 0, 0]],
            'indexes': ('sqlite_autoindex_orchestration_v2_thread_history_compactions_1',),
        },
    }),
}


def full_read_pending(live_max):
    """The FULL_READ migrations a database whose newest effect_sql_migrations row is `live_max`
    has not run yet, sorted. None (no migrations table, or it cannot tell) counts none: a database
    the helper cannot place would otherwise be refused for room it may never need."""
    return [] if live_max is None else sorted(number for number in FULL_READ if number > live_max)


def newest(db):
    """The newest migration id `db` recorded, or None when it has no migrations table."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (MIGRATIONS_TABLE,)).fetchone():
        return None
    value = db.execute('SELECT max(migration_id) FROM ' + MIGRATIONS_TABLE).fetchone()[0]
    return value if type(value) is int else None


# Never added by an additive migration the page proof accepts: they carry authority or history
# with their own proofs (update_read.AUTHORITY_TABLES and LOG_TABLES, and SQLite's own tables).
_PROTECTED = re.compile(r'^(?:auth_|provider_session_runtime$|scheduled_task|orchestration_events$|'
                        r'orchestration_command_receipts$|orchestration_v2_events$|orchestration_v2_command_receipts$|'
                        r'sqlite_(?!autoindex_)|' + MIGRATIONS_TABLE + '$)')


def _migrations(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (MIGRATIONS_TABLE,)).fetchone():
        return {}
    rows = {}
    for row in db.execute('SELECT migration_id, created_at, name FROM ' + MIGRATIONS_TABLE + ' NOT INDEXED'):
        if type(row[0]) is not int or row[0] in rows:
            raise Undeclared('migration-row')
        rows[row[0]] = tuple(row)
    return rows


def _columns(db, table):
    return [list(row) for row in db.execute('PRAGMA table_xinfo(' + table + ')')]


def delta(old_master, new_master, old_db, new_db):
    """{'migrations': [ids], 'objects': {name: (type, tbl_name, rootpage)},
    'rebuilt': {name: (type, tbl_name, old rootpage, new rootpage)}} the live database added or
    rebuilt, proven as above; raises Undeclared otherwise. `*_master`: (type, name, tbl_name,
    rootpage, sql) rows of sqlite_master from each database."""
    old = {(row[0], row[1]): tuple(row) for row in old_master}
    new = {(row[0], row[1]): tuple(row) for row in new_master}
    if len(old) != len(old_master) or len(new) != len(new_master):
        raise Undeclared('schema-duplicate')
    before, after = _migrations(old_db), _migrations(new_db)
    for key, row in before.items():
        if after.get(key) != row:
            raise Undeclared('migration-row-changed')
    added_ids = sorted(set(after) - set(before))
    # Entries a declared rebuild among the added migrations may change, and how.
    rebuilding = {}
    for number in added_ids:
        if number in REBUILT and after[number][2] == REBUILT[number][0]:
            for table, declared in REBUILT[number][1].items():
                rebuilding[('table', table)] = (table, declared['before'], declared['after'], declared)
                for index in declared['indexes']:
                    rebuilding[('index', index)] = (table, None, None, declared)
    rebuilt = {}
    for key, row in old.items():
        if new.get(key) == row:
            continue
        if key not in rebuilding or key not in new:
            raise Undeclared('schema-existing-changed')
        table, sql_before, sql_after, declared = rebuilding[key]
        current = new[key]
        if row[2] != table or current[2] != table or normalized(row[4]) != sql_before:
            raise Undeclared('schema-existing-changed')
        if normalized(current[4]) != sql_after:
            raise Undeclared('rebuild-sql:' + key[1])
        if _PROTECTED.match(key[1]) or _PROTECTED.match(table):
            raise Undeclared('schema-protected:' + key[1])
        if type(current[3]) is not int or current[3] < 2 or current[3] == row[3]:
            raise Undeclared('rebuild-root:' + key[1])
        rebuilt[key[1]] = (key[0], table, row[3], current[3])
    for key, (table, _, _, declared) in rebuilding.items():
        if key[0] == 'table' and key in old:
            # Every entry of a declared rebuild of an existing table changes together: the table
            # and each of its indexes, and nothing else on that table.
            names = {table} | set(declared['indexes'])
            if set(rebuilt) & names != names or \
                    {k[1] for k in new if new[k][2] == table} != {k[1] for k in old if old[k][2] == table}:
                raise Undeclared('rebuild-partial:' + table)
            for db in (old_db, new_db):
                if _columns(db, table) != declared['columns']:
                    raise Undeclared('rebuild-columns:' + table)
    if not added_ids:
        raise Undeclared('schema-without-migration')
    if before and added_ids[0] <= max(before):
        raise Undeclared('migration-out-of-order')
    expected = {}
    for number in added_ids:
        declared = DECLARED.get(number)
        if declared is None:
            if number in REBUILT and after[number][2] == REBUILT[number][0]:
                continue
            raise Undeclared('migration-undeclared:%d' % number)
        if after[number][2] != declared[0]:
            raise Undeclared('migration-undeclared:%d' % number)
        for kind, name, table, sql in declared[1]:
            expected[(kind, name)] = (table, sql)
    for key, (table, _, sql_after, _) in rebuilding.items():
        # A table created and rebuilt in this same update (070 and 072 both pending) is added in
        # its rebuilt form.
        if key in expected and key not in old:
            expected[key] = (table, sql_after)
    added = {key: row for key, row in new.items() if key not in old}
    objects = {}
    for key, row in added.items():
        kind, name, table, root, sql = row
        if key not in expected:
            raise Undeclared('schema-undeclared:' + name)
        if kind not in ('table', 'index') or type(root) is not int or root < 2:
            raise Undeclared('schema-kind:' + name)
        if _PROTECTED.match(name) or _PROTECTED.match(table):
            raise Undeclared('schema-protected:' + name)
        if (table, normalized(sql)) != (expected[key][0], expected[key][1]):
            raise Undeclared('schema-sql:' + name)
        if kind == 'index' and ('table', table) not in new:
            raise Undeclared('schema-index-table:' + name)
        objects[name] = (kind, table, root)
    for key, (table, sql) in expected.items():
        if key in added:
            continue
        # IF NOT EXISTS found it already there: only the same object counts.
        present = old.get(key)
        if present is None or (present[2], normalized(present[4])) != (table, sql):
            raise Undeclared('schema-missing:' + key[1])
    for key, (table, _, _, _) in rebuilding.items():
        if key[0] == 'table' and key not in old and key not in added:
            raise Undeclared('rebuild-missing:' + table)
    if not objects and not rebuilt:
        raise Undeclared('schema-without-objects')
    return {'migrations': added_ids, 'objects': objects, 'rebuilt': rebuilt}


def recorded_rebuilds(db, structure):
    """{table: [migration id, name]} of each declared rebuild `db` records: its effect_sql_migrations
    row and the table's declared SQL after it (structure: database_continuity.schema(db)). The full
    read's schema check accepts exactly these (update_migration.assert_migration_protected_schema)."""
    rows = {}
    try:
        rows = _migrations(db)
    except Undeclared:
        return {}
    sql = {item[1]: item[3] for item in structure['objects'] if item[0] == 'table'}
    found = {}
    for number, (name, tables) in REBUILT.items():
        if rows.get(number, (None, None, None))[2] != name:
            continue
        for table, declared in tables.items():
            if normalized(sql.get(table)) == declared['after']:
                found[table] = [number, name]
    return found


def rebuild_accepted(table, old_sql, new_sql, old_columns, new_columns, recorded):
    """True when `table` changed from its declared SQL before a rebuild to the declared SQL after it,
    with the declared columns on both sides, and the database after records that migration's row."""
    for number, (name, tables) in REBUILT.items():
        declared = tables.get(table)
        if declared is None:
            continue
        if (recorded or {}).get(table) == [number, name] and normalized(old_sql) == declared['before'] \
                and normalized(new_sql) == declared['after'] \
                and old_columns == declared['columns'] and new_columns == declared['columns']:
            return True
    return False


def without(structure, objects, rebuilt=()):
    """database_continuity.schema(db) without the added `objects`: what the stopped clone held.
    The schema entries of `rebuilt` objects (their SQL proven on each side by delta()) are left out
    too, from either database; their columns and foreign keys stay compared."""
    tables = {name for name, (kind, _, _) in objects.items() if kind == 'table'}
    return {'objects': [item for item in structure['objects'] if item[1] not in objects and item[1] not in rebuilt],
            'columns': {table: value for table, value in structure['columns'].items() if table not in tables},
            'foreignKeys': {table: value for table, value in structure['foreignKeys'].items() if table not in tables}}
