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


def delta(old_master, new_master, old_db, new_db):
    """{'migrations': [ids], 'objects': {name: (type, tbl_name, rootpage)}} the live database added,
    proven as above; raises Undeclared otherwise. `*_master`: (type, name, tbl_name, rootpage, sql)
    rows of sqlite_master from each database."""
    old = {(row[0], row[1]): tuple(row) for row in old_master}
    new = {(row[0], row[1]): tuple(row) for row in new_master}
    if len(old) != len(old_master) or len(new) != len(new_master):
        raise Undeclared('schema-duplicate')
    for key, row in old.items():
        if new.get(key) != row:
            raise Undeclared('schema-existing-changed')
    before, after = _migrations(old_db), _migrations(new_db)
    for key, row in before.items():
        if after.get(key) != row:
            raise Undeclared('migration-row-changed')
    added_ids = sorted(set(after) - set(before))
    if not added_ids:
        raise Undeclared('schema-without-migration')
    if before and added_ids[0] <= max(before):
        raise Undeclared('migration-out-of-order')
    expected = {}
    for number in added_ids:
        declared = DECLARED.get(number)
        if declared is None or after[number][2] != declared[0]:
            raise Undeclared('migration-undeclared:%d' % number)
        for kind, name, table, sql in declared[1]:
            expected[(kind, name)] = (table, sql)
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
    if not objects:
        raise Undeclared('schema-without-objects')
    return {'migrations': added_ids, 'objects': objects}


def without(structure, objects):
    """database_continuity.schema(db) without the added `objects`: what the stopped clone held."""
    tables = {name for name, (kind, _, _) in objects.items() if kind == 'table'}
    return {'objects': [item for item in structure['objects'] if item[1] not in objects],
            'columns': {table: value for table, value in structure['columns'].items() if table not in tables},
            'foreignKeys': {table: value for table, value in structure['foreignKeys'].items() if table not in tables}}
