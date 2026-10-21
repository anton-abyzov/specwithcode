#!/usr/bin/env python3
"""A database with a virtual table, split from test-update-read-speed.py, against the origin/main
reads frozen there: such a database (FTS4 or FTS5: a log whose content rowids are not integers,
a table over a view that reads differently each time, a table in each role a read gives it, one
whose CREATE text or root page was rewritten; an R*Tree that reads its node table to connect)
is read in origin/main's order, as is every database on an SQLite older than 3.37: the same
statements, answers and refusals. Which tables count as virtual (update.virtual_tables).
Temporary SQLite only; no services or user stores.
"""
import contextlib
import importlib.util
import itertools
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

import live_database
import update
import update_read


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


# The frozen origin/main reads and the fixtures they share.
speed = module('read_virtual_speed', 'test-update-read-speed.py')
REFERENCE, updater_base, build, CHECK = speed.REFERENCE, speed.updater_base, speed.build, speed.CHECK
outcome, frozen, sorted_json, read_once = speed.outcome, speed.frozen, speed.sorted_json, speed.read_once
traced_reads, is_guarded, corrupt_leaf = speed.traced_reads, speed.is_guarded, speed.corrupt_leaf
LIST_TABLES, TABLE_TEXT = speed.LIST_TABLES, speed.TABLE_TEXT

# The v1 receipts log as an FTS4 or FTS5 table over a view of rows whose content rowid is not an
# integer (CONTENT_ROWIDS): the module reads it back as one (REAL 2.5 as 2, NULL and most TEXT as
# 0), while `WHERE rowid <= ?` reaches the content table as a comparison of the stored value.
VIRTUAL_LOGS = {
    'fts4': ['CREATE VIEW receipt_view AS SELECT rid AS rowid, command_id, aggregate_id, result_sequence, status FROM receipt_rows',
             'CREATE VIRTUAL TABLE orchestration_command_receipts USING fts4(content="receipt_view", '
             'command_id, aggregate_id, result_sequence, status)'],
    'fts5': ['CREATE VIEW receipt_view AS SELECT rid, command_id, aggregate_id, result_sequence, status FROM receipt_rows',
             'CREATE VIRTUAL TABLE orchestration_command_receipts USING fts5(command_id, aggregate_id, result_sequence, '
             "status, content='receipt_view', content_rowid='rid')"],
}
# The content rowid column and its values; under a TEXT column the numbers are stored as text.
CONTENT_ROWIDS = {'real': ('rid', [1, 2.5]), 'null': ('rid', [1, None, 3]), 'text': ('rid', [1, '2', 3]),
                  'text-column': ('rid TEXT', [1, 10, 2])}


def virtual_log(module, kind):
    column, rowids = CONTENT_ROWIDS[kind]
    def literal(value):
        return 'NULL' if value is None else "'%s'" % value if isinstance(value, str) else repr(value)
    return ['DROP TABLE orchestration_command_receipts',
            'CREATE TABLE receipt_rows(%s, command_id TEXT, aggregate_id TEXT, result_sequence INTEGER, status TEXT)' % column,
            'INSERT INTO receipt_rows VALUES ' + ', '.join(
                "(%s, 'c%d', 't-wait', %d, 'accepted')" % (literal(rowid), index, index) for index, rowid in enumerate(rowids)),
            *VIRTUAL_LOGS[module]]
# A view a virtual table can take its external content from: its module reads the view each time
# the table is read. CHANGING_VIEW makes the view read differently every time, even in one
# transaction.
DOCS_VIEW = ['CREATE TABLE project_docs(id INTEGER PRIMARY KEY, body TEXT)',
             "INSERT INTO project_docs(body) VALUES ('a.md'), ('ünïcödé ☃'), (NULL)",
             'CREATE VIEW project_docs_view AS SELECT id AS rowid, body FROM project_docs']
# A virtual table over that view of each kind: FTS5 and FTS4, under each guarded prefix, an
# authority table's name and no guarded name.
OVER_THE_VIEW = {
    'project_docs_fts': "CREATE VIRTUAL TABLE project_docs_fts USING fts5(body, content='project_docs_view', content_rowid='rowid')",
    'project_docs_fts4': 'CREATE VIRTUAL TABLE project_docs_fts4 USING fts4(content="project_docs_view", body)',
    'orchestration_docs_fts': "CREATE VIRTUAL TABLE orchestration_docs_fts USING fts5(body, content='project_docs_view', content_rowid='rowid')",
    'projection_docs_fts': "CREATE VIRTUAL TABLE projection_docs_fts USING fts5(body, content='project_docs_view', content_rowid='rowid')",
    'provider_session_runtime': "CREATE VIRTUAL TABLE provider_session_runtime USING fts5(body, content='project_docs_view', content_rowid='rowid')",
    'docs_fts': "CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='project_docs_view', content_rowid='rowid')",
}
FTS5_OVER_A_VIEW = DOCS_VIEW + [OVER_THE_VIEW['project_docs_fts']]
CHANGING_VIEW = ['DROP VIEW project_docs_view',
                 'CREATE VIEW project_docs_view AS SELECT id AS rowid, body || random() AS body FROM project_docs']
BUSY_RUN = "INSERT INTO orchestration_v2_projection_runs VALUES ('r-busy','t-wait','running')"
# Each role a read gives a table, {label: (table, statements that fill it, cell)}, for
# as_fts5_over_a_view: hashed and captured only, an idle check's table, auth_sessions (its
# invariant and private cells; a row or a cell that changes), the project ids and project-keyed
# rows, a log's positions and earlier rows, a projection cursor; and tables the guarded hashes
# leave out: one only the capture reads (also one whose text cannot be decoded on one read),
# and a thread-keyed projection.
VIRTUAL_ROLES = {
    'hashed': ('project_notes', ['CREATE TABLE project_notes(body TEXT)', "INSERT INTO project_notes VALUES ('a.md')"], None),
    'idle': ('orchestration_v2_projection_runs', [], None),
    'auth': ('auth_sessions', [], None),
    'auth-cell': ('auth_sessions', [], 'subject'),
    'projects': ('projection_projects', [], None),
    'log': ('orchestration_events', [], None),
    'cursor': ('projection_state', ["INSERT INTO projection_state VALUES ('projects', 4, '2026-10-11T03:00:00Z')"], None),
    'captured-only': ('notes', ['CREATE TABLE notes(thread_id TEXT, body TEXT)', "INSERT INTO notes VALUES ('t-wait', 'a.md')"], None),
    'captured-only-undecodable': ('notes', ['CREATE TABLE notes(thread_id TEXT, body TEXT)',
                                            "INSERT INTO notes VALUES ('t-wait', 'a.md')"], 'undecodable'),
    'thread-keyed': ('notes_projection_rows', ['CREATE TABLE notes_projection_rows(thread_id TEXT, body TEXT)',
                                               "INSERT INTO notes_projection_rows VALUES ('t-wait', 'a.md')"], None),
}


def rewrite_in_file(state, old, new):
    """Rewrite stored schema text in the database file itself, byte for byte. Text of the same
    length leaves every record and page as it was, so any SQLite reads the new text, also one
    that refuses PRAGMA writable_schema in defensive mode."""
    path = state / 'statev2.sqlite'
    db = sqlite3.connect(path)
    try:
        assert db.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'  # Every page is in the file.
    finally:
        db.close()
    data = path.read_bytes()
    assert len(old) == len(new) and old in data
    path.write_bytes(data.replace(old, new))


def rewrite_schema_row(state, name, column, value):
    """Rewrite one sqlite_master cell of `name` with PRAGMA writable_schema, as a repair tool
    could. False where SQLite refuses: Apple's SQLite in defensive mode, which only Python 3.12
    and later can turn off (Connection.setconfig)."""
    db = sqlite3.connect(state / 'statev2.sqlite')
    try:
        if hasattr(db, 'setconfig'): db.setconfig(sqlite3.SQLITE_DBCONFIG_DEFENSIVE, False)
        db.execute('PRAGMA writable_schema=ON')
        try:
            db.execute('UPDATE sqlite_master SET %s=? WHERE name=?' % column, (value, name))
        except sqlite3.OperationalError as error:
            assert str(error) == 'table sqlite_master may not be modified', error
            return False
        db.commit()
        return True
    finally:
        db.close()


@contextlib.contextmanager
def scripted_random(value):
    """random() on each connection live_database.connect opens returns value(n) on that
    connection's n-th call. Yields a list of each connection's calls."""
    real, counts = live_database.connect, []
    def connect(path, *args, **kwargs):
        connection = real(path, *args, **kwargs)
        calls = []
        counts.append(calls)
        def random():
            calls.append(None)
            return value(len(calls))
        connection.create_function('random', 0, random)
        return connection
    with patch.object(live_database, 'connect', side_effect=connect):
        yield counts


def odd_on_call(call):
    """A random() that is odd on each connection's `call`-th call only: a view that keeps the
    rows whose random() is even, with one row, hides it on that read alone."""
    return lambda made: 1 if made == call else 2


def as_fts5_over_a_view(state, table, *, cell=None):
    """Rebuild `table` as an FTS5 table over a view of its rows (kept in role_rows) that calls
    random() once a row each time the table is read: it hides a row whose random() is odd, or,
    with `cell` (a column), gives that column of the row other text, or with 'undecodable' as
    `cell`, makes its last column text that cannot be decoded."""
    db = sqlite3.connect(state / 'statev2.sqlite')
    try:
        columns = [row[1] for row in db.execute('PRAGMA table_info(%s)' % table)]
        odd = 'abs(random()) % 2 = 1'
        def value(column):
            if cell == 'undecodable' and column == columns[-1]:
                return "CASE WHEN %s THEN CAST(x'ff' AS TEXT) ELSE %s END AS %s" % (odd, column, column)
            return "%s || CASE WHEN %s THEN '-changed' ELSE '' END AS %s" % (column, odd, column) if column == cell else column
        db.executescript('''
            CREATE TABLE role_rows AS SELECT rowid AS rid, * FROM {table};
            DROP TABLE {table};
            CREATE VIEW role_view AS SELECT rid, {values} FROM role_rows{where};
            CREATE VIRTUAL TABLE {table} USING fts5({columns}, content='role_view', content_rowid='rid');
        '''.format(table=table, values=', '.join(map(value, columns)), columns=', '.join(columns),
                   where='' if cell else ' WHERE abs(random()) % 2 = 0'))
    finally:
        db.close()


def rtree_over_a_node_view(state, name, triggers):
    """An R*Tree `name` whose node table is a view of its nodes that hides each one whose
    random() is odd. Its module reads node 1 to connect (the node size), so whether it connects
    depends on that call: 'undersize RTree blobs' when node 1 is hidden; when it is not,
    'cannot modify ... because it is a view' without INSTEAD OF triggers that let it write to the
    view, and with them it connects (a read of its rows then fails: 'database disk image is
    malformed'). The view and the node table trade names in the file, which no SQL statement may
    do. False where SQLite refuses the triggers: Apple's, in defensive mode, loads no trigger on
    a view with a shadow table's name."""
    node, view, kept = ('%s_%s' % (name, suffix) for suffix in ('node', 'nodx', 'nodf'))
    updater_base.mutate_state(state, 'CREATE VIRTUAL TABLE %s USING rtree(id, x0, x1)' % name,
                              'INSERT INTO %s VALUES (1, 0, 1), (2, -1.5, 2)' % name,
                              'CREATE VIEW %s AS SELECT nodeno, data FROM %s WHERE abs(random()) %% 2 = 0' % (view, node),
                              *['CREATE TRIGGER %s_%s INSTEAD OF %s ON %s BEGIN SELECT 1; END' % (name, what.lower(), what, view)
                                for what in (('INSERT', 'UPDATE', 'DELETE') if triggers else ())])
    rewrite_in_file(state, node.encode(), kept.encode())
    rewrite_in_file(state, view.encode(), node.encode())
    db = sqlite3.connect(state / 'statev2.sqlite')
    try:
        db.execute('SELECT count(*) FROM sqlite_master').fetchone()
        return True
    except sqlite3.DatabaseError as error:
        assert triggers and 'cannot create triggers on shadow tables' in str(error), error
        return False
    finally:
        db.close()


class VirtualGoldenEquality(unittest.TestCase):
    """Every read of a database with a virtual table answers as origin/main answered."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-read-speed-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def assert_same(self, state, include_auth, since, include_database, widen_from, label, in_order=False):
        old = outcome(REFERENCE['_read_state'], state, include_auth, since, include_database, widen_from)
        new = read_once(self, state, include_auth, since, include_database, widen_from, label, in_order)
        self.assertEqual(old[0], 'ok', (label, old))
        self.assertEqual(frozen(new), frozen(old), label)
        self.assertEqual(sorted_json(new), sorted_json(old), label)
        return new[1]

    def assert_in_order(self, args, label, value=odd_on_call(0)):
        """For a database with a virtual table: update._read_state answers exactly as
        origin/main, a refusal or not, from origin/main's whole order alone, with random()
        returning value(n) on each connection's n-th call, and after as many calls."""
        with scripted_random(value) as calls:
            old = outcome(REFERENCE['_read_state'], *args)
        with scripted_random(value) as made:
            new = read_once(self, *args, label, in_order=True)
        self.assertEqual(frozen(new), frozen(old), label)
        self.assertEqual(sorted_json(new), sorted_json(old), label)
        self.assertEqual([len(each) for each in made], [len(each) for each in calls], label)
        return old

    def test_a_virtual_log_is_carried_as_origin_main_carried_it(self):
        """A log that is an FTS4 or FTS5 table over a view of rows whose content rowid is REAL,
        NULL or TEXT (VIRTUAL_LOGS): the rowids a scan of it reads back cannot tell which rows
        `WHERE rowid <= ?` picks, and a database with a virtual table is read in origin/main's
        order (update.virtual_tables), so its earlier rows are read as origin/main read them,
        and every read matches origin/main, with nothing appended or a row appended."""
        checked, differ = 0, set()
        for module, kind in itertools.product(VIRTUAL_LOGS, CONTENT_ROWIDS):
            state = self.root / ('virtual-log-%s-%s' % (module, kind))
            build(state, 'without-rowid')
            updater_base.mutate_state(state, *virtual_log(module, kind))
            proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
            boundary = proof[update.ACTIVITY_KEY]['logRowids']['orchestration_command_receipts']
            db = sqlite3.connect(state / 'statev2.sqlite')
            try:
                scanned = [row[0] for row in db.execute('SELECT rowid FROM orchestration_command_receipts')]
                picked = db.execute('SELECT count(*) FROM orchestration_command_receipts WHERE rowid <= ?', (boundary,)).fetchone()[0]
            finally:
                db.close()
            if sum(rowid <= boundary for rowid in scanned) != picked: differ.add((module, kind))
            for appended in (False, True):
                if appended:
                    updater_base.mutate_state(state, "INSERT INTO receipt_rows VALUES (20, 'c-new', 't-wait', 20, 'accepted')")
                for include_auth, since, include_database, widen_from in itertools.product(
                        (False, True), (None, proof), (False, True), (None, capture['schema']['columns'])):
                    label = (module, kind, appended, include_auth, since is not None, include_database, widen_from is not None)
                    with self.subTest(label=label):
                        carried = self.assert_same(state, include_auth, since, include_database, widen_from, label, True)[2]
                        self.assertIsInstance(carried, type(None) if since is None else dict, label)
                        checked += 1
        self.assertEqual(checked, len(VIRTUAL_LOGS) * len(CONTENT_ROWIDS) * 2 * 16)
        # The rowids a scan reads back and `WHERE rowid <=` disagree here (an FTS4 NULL docid read
        # as 0, an FTS5 REAL content rowid read as its integer part).
        self.assertLessEqual({('fts4', 'null'), ('fts5', 'real')}, differ)

    def test_an_fts5_table_widens_as_origin_main_widened_it(self):
        """An FTS5 table lists two hidden columns (the one named after the table, then rank)
        after its declared ones and cannot gain a column in place, so a real capture's columns
        never widen it. A hand-made widen_from that ends at the table-named column selects it,
        and that column reads as a cursor number SQLite counts per connection: read in
        origin/main's order, after as many cursors, it hashes as origin/main hashed it."""
        state = self.root / 'fts5'
        build(state, 'without-rowid')
        updater_base.mutate_state(state, 'CREATE VIRTUAL TABLE project_search USING fts5(path, body)',
                                  "INSERT INTO project_search VALUES ('a.md', 'ünïcödé ☃'), ('b.md', NULL)")
        proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
        columns = capture['schema']['columns']
        self.assertEqual([(column[1], column[6]) for column in columns['project_search']],
                         [('path', 0), ('body', 0), ('project_search', 1), ('rank', 1)])
        hand_made = {'project_search': columns['project_search'][:3]}
        for widen_from, include_auth, since, include_database in itertools.product(
                (columns, hand_made), (False, True), (None, proof), (False, True)):
            label = ('hand-made' if widen_from is hand_made else 'captured', include_auth, since is not None, include_database)
            with self.subTest(label=label):
                database = self.assert_same(state, include_auth, since, include_database, widen_from, label, True)[3]
                widened = (database or {}).get('widened', {})
                self.assertEqual(list(widened), ['project_search'] if include_database and widen_from is hand_made else [])
        # A release rebuilds it with one more column: only its shadow content table widens.
        updater_base.mutate_state(state, 'DROP TABLE project_search',
                                  'CREATE VIRTUAL TABLE project_search USING fts5(path, body, title)',
                                  "INSERT INTO project_search VALUES ('a.md', 'ünïcödé ☃', 'A')", *CHECK)
        for include_auth, since, include_database in itertools.product((False, True), (None, proof), (False, True)):
            label = ('rebuilt', include_auth, since is not None, include_database)
            with self.subTest(label=label):
                database = self.assert_same(state, include_auth, since, include_database, columns, label, True)[3]
                if include_database:
                    self.assertEqual(list(database['widened']), ['project_search_content'])

    def test_a_virtual_table_over_a_view_reads_as_origin_main_read_it(self):
        """FTS5 or FTS4, under each guarded prefix, an authority table's name or none
        (OVER_THE_VIEW), each the only table over the view. origin/main hashed every guarded
        table before its capture, so bind_rows compared two reads of a guarded one. A database
        with a virtual table is read in origin/main's order, so every read matches origin/main
        over a view that reads the same each time, over one that reads differently each time
        (refused with the capture where the table is guarded, as origin/main refused it), and
        with a busy service, refused after the guarded rows, as origin/main refused it."""
        refused = ('error', ('AssertionError', 'Database changed during protected row readback'))
        busy = ('error', ('AssertionError', 'Native work is not idle'))
        for name, create in OVER_THE_VIEW.items():
            state = self.root / ('over-a-view-' + name)
            build(state, 'without-rowid')
            proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
            updater_base.mutate_state(state, *DOCS_VIEW, create)
            combinations = list(itertools.product((False, True), (None, proof), (False, True), (None, capture['schema']['columns'])))
            for view, statements, value in (('steady', [], odd_on_call(0)), ('changing', CHANGING_VIEW, lambda call: call),
                                           ('busy', [BUSY_RUN], lambda call: call)):
                updater_base.mutate_state(state, *statements)
                for include_auth, since, include_database, widen_from in combinations:
                    label = (name, view, include_auth, since is not None, include_database, widen_from is not None)
                    with self.subTest(label=label):
                        old = self.assert_in_order((state, include_auth, since, include_database, widen_from), label, value)
                        if view == 'busy' or (view == 'changing' and include_database and is_guarded(name)):
                            self.assertEqual(old, busy if view == 'busy' else refused, label)
                        else:
                            self.assertEqual(old[0], 'ok', label)

    def test_a_virtual_table_in_each_role_reads_as_origin_main_read_it(self):
        """A table in each role a read gives it (VIRTUAL_ROLES), rebuilt as an FTS5 table over a
        view whose random() changes one read of it, whichever: before, a single scan read such
        a table fewer times or in another order, and gave proofs, captures and refusals
        origin/main did not. A database with a virtual table is read in origin/main's order,
        so every answer, a refusal or not, is origin/main's after as many calls of random(),
        also with a widen_from that widens that table."""
        answers = set()
        for label, (table, statements, cell) in VIRTUAL_ROLES.items():
            state = self.root / ('role-' + label)
            updater_base.waiting_fixture(state)
            updater_base.mutate_state(state, *statements)
            as_fts5_over_a_view(state, table, cell=cell)
            with scripted_random(odd_on_call(0)):
                proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
            columns = capture['schema']['columns']
            widens = {'none': None, 'captured': columns, 'widens-it': {table: columns[table][:1]}}
            seen = set()
            for (widen, widen_from), include_auth, since, include_database in itertools.product(
                    widens.items(), (False, True), (None, proof), (False, True)):
                if widen_from is not None and not include_database:
                    continue
                args = (state, include_auth, since, include_database, widen_from)
                with scripted_random(odd_on_call(0)) as calls:
                    self.assertEqual(outcome(REFERENCE['_read_state'], *args)[0], 'ok')
                for call in range(1, sum(map(len, calls)) + 1):
                    name = (label, widen, include_auth, since is not None, include_database, call)
                    with self.subTest(label=name):
                        old = self.assert_in_order(args, name, odd_on_call(call))
                        seen.add(frozen(old))
                        answers.add((label, old[0]))
            self.assertGreater(len(seen), 1, label)  # What random() changes changes the answer.
        self.assertLessEqual({(label, 'error') for label in ('hashed', 'idle', 'auth', 'auth-cell', 'projects', 'log',
                                                             'cursor', 'captured-only-undecodable')}, answers)

    def test_a_virtual_auth_sessions_read_back_differently_is_refused_as_origin_main_refused_it(self):
        """origin/main read auth_sessions for its guarded hash, then for the auth invariant, then
        for the private auth cells, which auth_heartbeat.bind_auth compares with the first read.
        When only that third read loses a row or changes a cell, the answer is still
        origin/main's refusal (before, the single scan's refusal gave way to the original
        order's own reads, which agreed)."""
        for cell, message in ((None, 'Complete auth row count changed'),
                              ('subject', 'Complete auth hash changed during readback')):
            state = self.root / ('auth-read-back-%s' % cell)
            updater_base.waiting_fixture(state)
            as_fts5_over_a_view(state, 'auth_sessions', cell=cell)
            for include_database in (False, True):
                label = (cell, include_database)
                with self.subTest(label=label):
                    old = self.assert_in_order((state, True, None, include_database, None), label, odd_on_call(3))
                    self.assertEqual(old, ('error', ('AssertionError', message)), label)

    def test_an_rtree_that_reads_its_node_table_to_connect_reads_as_origin_main_read_it(self):
        """An R*Tree's module reads its node table to connect, so a database with one must
        connect it where origin/main did: update.virtual_tables reads schema text alone and
        connects no module. Before, pragma_table_list connected every module first, so over a
        node table that reads differently each time (rtree_over_a_node_view) the R*Tree
        connected, or failed to, on another call of random() than origin/main's, and the answer
        changed. Guarded and not, with and without the triggers that let it connect, every
        argument combination, random() odd on no call, on each call in turn and on one past the
        last: every answer, a refusal or not, is origin/main's after as many calls."""
        built = 0
        for name, triggers in itertools.product(('project_tree', 'zzz_tree'), (False, True)):
            state = self.root / ('rtree-%s-%s' % (name, 'triggers' if triggers else 'plain'))
            build(state, 'without-rowid')
            proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
            if not rtree_over_a_node_view(state, name, triggers):
                continue
            built += 1
            answers = set()
            for include_auth, since, include_database, widen_from in itertools.product(
                    (False, True), (None, proof), (False, True), (None, capture['schema']['columns'])):
                if widen_from is not None and not include_database:
                    continue
                args = (state, include_auth, since, include_database, widen_from)
                with scripted_random(odd_on_call(0)) as calls:
                    outcome(REFERENCE['_read_state'], *args)
                for call in range(sum(map(len, calls)) + 2):
                    label = (name, triggers, include_auth, since is not None, include_database, widen_from is not None, call)
                    with self.subTest(label=label):
                        old = self.assert_in_order(args, label, odd_on_call(call))
                        answers.add('ok' if old[0] == 'ok' else old[1])
            # It failed to connect over a hidden node 1, and found it: then, without the triggers,
            # it failed on the view, and with them it connected.
            undersize = ('DatabaseError', 'undersize RTree blobs in "%s_node"' % name)
            on_the_view = ('OperationalError', 'cannot modify %s_node because it is a view' % name)
            self.assertIn(undersize, answers, (name, triggers))
            if triggers:
                self.assertTrue(answers - {undersize, on_the_view}, (name, triggers))
            else:
                self.assertIn(on_the_view, answers, (name, triggers))
        self.assertIn(built, (2, 4))

    def test_a_virtual_table_whose_schema_row_was_rewritten_is_still_read_in_origin_mains_order(self):
        """SQLite reads a table by the schema it parsed, so a virtual table whose CREATE text or
        root page was rewritten (PRAGMA writable_schema) still loads, reads and passes
        integrity_check, and neither `LIKE 'CREATE VIRTUAL TABLE%'` nor root page 0 can tell it
        apart. Its text does not create an ordinary table (update.ORDINARY_TABLE), so its
        database is still read in origin/main's order (update.virtual_tables): every read matches
        origin/main, and over a view that reads differently each time, every read with the
        capture is refused as origin/main refused it. Text of the same length is rewritten in the
        file; the rest needs writable_schema, which Apple's SQLite refuses in defensive mode and
        only Python 3.12 and later can turn off."""
        create = "CREATE VIRTUAL TABLE project_docs_fts USING fts5(body, content='project_docs_view', content_rowid='rowid')"
        def in_file(text):
            return lambda state: rewrite_in_file(state, create.encode(), text.encode()) or True
        def with_writable_schema(column, value):
            return lambda state: rewrite_schema_row(state, 'project_docs_fts', column, value(state))
        def root_of(table):
            def root(state):
                db = sqlite3.connect(state / 'statev2.sqlite')
                try:
                    return db.execute("SELECT rootpage FROM sqlite_master WHERE name=?", (table,)).fetchone()[0]
                finally:
                    db.close()
            return root
        # Each rewrite and the schema query that no longer finds the table.
        by_text = "SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'"
        by_root_page = "SELECT name FROM sqlite_master WHERE type='table' AND rootpage=0"
        edits = {'newline': (in_file(create.replace('VIRTUAL TABLE', 'VIRTUAL\nTABLE')), by_text),
                 'lower-case-and-tab': (in_file(create.replace('CREATE VIRTUAL TABLE', 'create virtual\ttable')), by_text),
                 'two-spaces': (with_writable_schema('sql', lambda state: create.replace('VIRTUAL TABLE', 'VIRTUAL  TABLE')), by_text),
                 'comment': (with_writable_schema('sql', lambda state: create.replace('VIRTUAL TABLE', 'VIRTUAL/**/TABLE')), by_text),
                 'root-page': (with_writable_schema('rootpage', root_of('project_docs')), by_root_page)}
        refused = ('error', ('AssertionError', 'Database changed during protected row readback'))
        for name, (edit, missed_by) in edits.items():
            with self.subTest(edit=name):
                state = self.root / ('rewritten-' + name)
                build(state, 'without-rowid')
                proof, _, _, capture = REFERENCE['_read_state'](state, False, None, True, None)
                updater_base.mutate_state(state, *FTS5_OVER_A_VIEW)
                if not edit(state):
                    self.skipTest('this SQLite refuses PRAGMA writable_schema (defensive mode)')
                db = sqlite3.connect(state / 'statev2.sqlite')
                try:
                    self.assertNotEqual(db.execute("SELECT sql, rootpage FROM sqlite_master WHERE name='project_docs_fts'").fetchone(),
                                        (create, 0))
                    self.assertNotIn(('project_docs_fts',), db.execute(missed_by).fetchall())
                    self.assertEqual(len(db.execute('SELECT * FROM project_docs_fts').fetchall()), 3)
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
                finally:
                    db.close()
                widen = capture['schema']['columns']
                for include_auth, since, include_database, widen_from in itertools.product(
                        (False, True), (None, proof), (False, True), (None, widen)):
                    label = (name, 'steady', include_auth, since is not None, include_database, widen_from is not None)
                    self.assert_same(state, include_auth, since, include_database, widen_from, label, True)
                updater_base.mutate_state(state, *CHANGING_VIEW)
                for include_auth, since, widen_from in itertools.product((False, True), (None, proof), (None, widen)):
                    label = (name, 'changing', include_auth, since is not None, widen_from is not None)
                    self.assertEqual(self.assert_in_order((state, include_auth, since, True, widen_from), label, lambda call: call),
                                     refused, label)


class VirtualReadCost(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-read-cost-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name)
        build(self.state, 'without-rowid')
        self.proof = update._read_state(self.state, False)[0]

    def test_a_database_with_a_virtual_table_runs_origin_mains_statements(self):
        """Every statement origin/main ran, in its order, each read of a virtual table and what
        its module runs to connect among them, and one more before them: the schema text query
        that found the virtual table (update.virtual_tables), which connects no module. Each
        kind of virtual table (OVER_THE_VIEW). statev2 has none: SpecWithCode keeps its only
        FTS5 table in each project's knowledge index, a database of its own, so its reads keep
        the single scan."""
        updater_base.mutate_state(self.state, *DOCS_VIEW, *OVER_THE_VIEW.values())
        for since, include_auth, include_database in itertools.product((None, self.proof), (False, True), (False, True)):
            with self.subTest(since=since is not None, include_auth=include_auth, include_database=include_database):
                with traced_reads() as statements:
                    new = update._read_state(self.state, include_auth, since, include_database)
                with traced_reads() as reference:
                    old = REFERENCE['_read_state'](self.state, include_auth, since, include_database)
                self.assertEqual(frozen(new), frozen(old))
                expected = reference[:]
                expected.insert(expected.index(LIST_TABLES) + 1, TABLE_TEXT)
                self.assertEqual(statements, expected)

    def test_before_sqlite_3_37_every_database_runs_origin_mains_statements(self):
        """On an SQLite before 3.37.0 (update.SINGLE_SCAN_SQLITE), which no test here runs on,
        every database is read in origin/main's order, without a virtual table or with one, also
        one over a view that reads differently each time: the same statements in the same order,
        and the same answer."""
        with patch.object(update_read, 'SINGLE_SCAN_SQLITE', (sys.maxsize,)):
            for tables, statements in (('none', []), ('virtual', FTS5_OVER_A_VIEW), ('changing', CHANGING_VIEW)):
                updater_base.mutate_state(self.state, *statements)
                for since, include_database in itertools.product((None, self.proof), (False, True)):
                    with self.subTest(tables=tables, since=since is not None, include_database=include_database):
                        with scripted_random(lambda call: call), traced_reads() as new_statements, \
                                patch.object(update_read, '_read_tables', wraps=update_read._read_tables) as paths:
                            new = outcome(update._read_state, self.state, True, since, include_database)
                        with scripted_random(lambda call: call), traced_reads() as old_statements:
                            old = outcome(REFERENCE['_read_state'], self.state, True, since, include_database)
                        self.assertEqual([call.kwargs for call in paths.call_args_list], [{'check_idle': True}])
                        self.assertEqual(new_statements, old_statements)
                        self.assertEqual(frozen(new), frozen(old))
                        if tables == 'changing' and include_database:
                            self.assertEqual(old, ('error', ('AssertionError', 'Database changed during protected row readback')))
                        else:
                            self.assertEqual(old[0], 'ok')


    def test_a_table_is_virtual_unless_its_text_creates_an_ordinary_table(self):
        """update.virtual_tables reads sqlite_master's text alone. A table whose text starts
        CREATE TABLE (update.ORDINARY_TABLE) is ordinary: SQLite writes every ordinary table's
        text so, however it was created or altered, shadow tables and its own included, and so
        is one rewritten in lower case or with a tab or newline between the words, or with
        bytes that cannot be decoded (refused only where origin/main read that text). Every other
        table counts as virtual: each virtual table, also one whose arguments hold 'create table',
        and an ordinary table whose rewritten text SQLite still reads as one but which starts
        otherwise (a quoted name right after TABLE, a comment between the words). pragma_table_list
        agrees but for those two, whose databases are read in origin/main's order, which is never
        wrong; the rest keep the single scan. Every answer is origin/main's."""
        ordinary = ['CREATE TABLE plain_a(v)', 'create table if not exists "plain_b"(v)',
                    'CREATE TABLE plain_c(k PRIMARY KEY, v) WITHOUT ROWID', 'CREATE TABLE plain_d AS SELECT * FROM plain_a',
                    'CREATE TABLE plain_e(id INTEGER PRIMARY KEY AUTOINCREMENT, v)', 'CREATE TABLE plain_f(v INTEGER) STRICT',
                    'CREATE TABLE plain_g(v)', 'ALTER TABLE plain_g RENAME TO plain_h', 'ALTER TABLE plain_h ADD COLUMN w',
                    'CREATE INDEX plain_a_v ON plain_a(v)', 'INSERT INTO plain_a VALUES (1), (2)', 'ANALYZE',
                    'CREATE TABLE lower_l(v)', 'CREATE TABLE newline_m(v)', 'CREATE TABLE quoted_j (v)', 'CREATE TABLE comment_k   (v)',
                    'CREATE TABLE undecodable_n(v /* ab */)']
        virtual = ['CREATE VIRTUAL TABLE docs_fts5 USING fts5(body)', 'CREATE VIRTUAL TABLE docs_fts4 USING fts4(body)',
                   'CREATE VIRTUAL TABLE docs_rtree USING rtree(id, x0, x1)',
                   'CREATE VIRTUAL TABLE docs_args USING fts5("create table x", body)', "INSERT INTO docs_args VALUES ('a', 'b')"]
        # Same-length rewrites of the stored text: still read as ordinary, or not by the rule.
        still_ordinary = [(b'CREATE TABLE lower_l(v)', b'create\ttable lower_l(v)'),
                          (b'CREATE TABLE newline_m(v)', b'CREATE\nTABLE\nnewline_m(v)')]
        undecodable = (b'undecodable_n(v /* ab */)', b'undecodable_n(v /* \xff\xfe */)')
        starts_otherwise = {'quoted_j': (b'CREATE TABLE quoted_j (v)', b'CREATE TABLE"quoted_j"(v)'),
                            'comment_k': (b'CREATE TABLE comment_k   (v)', b'CREATE/**/TABLE comment_k(v)')}
        cases = {'ordinary': ([], [], set()), 'virtual': (virtual, [], {'docs_fts5', 'docs_fts4', 'docs_rtree', 'docs_args'}),
                 'quoted': ([], [starts_otherwise['quoted_j']], {'quoted_j'}),
                 'comment': ([], [starts_otherwise['comment_k']], {'comment_k'}),
                 'undecodable': ([], [undecodable], set())}
        for case, (statements, rewrites, expected) in cases.items():
            state = pathlib.Path(self.temp.name) / ('kinds-' + case)
            build(state, 'without-rowid')
            proof = REFERENCE['_read_state'](state, False)[0]
            updater_base.mutate_state(state, *ordinary, *statements)
            for old, new in still_ordinary + rewrites:
                rewrite_in_file(state, old, new)
            db = sqlite3.connect(state / 'statev2.sqlite')
            try:
                tables = [row[0] for row in db.execute(LIST_TABLES)]
                found = update.virtual_tables(db, tables)
                listed = {row[0] for row in db.execute("SELECT name FROM pragma_table_list WHERE schema='main' AND type='virtual'")}
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            finally:
                db.close()
            self.assertEqual(found, expected, case)
            self.assertEqual(listed, expected - set(starts_otherwise), case)
            self.assertLessEqual({'plain_h', 'sqlite_sequence', 'sqlite_stat1', 'lower_l', 'newline_m'}, set(tables) - found)
            if case == 'virtual':
                self.assertLessEqual({'docs_fts5_config', 'docs_fts4_segdir', 'docs_rtree_node'}, set(tables) - found)
            for include_auth, since, include_database in itertools.product((False, True), (None, proof), (False, True)):
                label = (case, include_auth, since is not None, include_database)
                with self.subTest(label=label):
                    args = (state, include_auth, since, include_database, None)
                    old = outcome(REFERENCE['_read_state'], *args)
                    # origin/main reads the stored text as text only in its capture.
                    self.assertEqual(old[0], 'error' if case == 'undecodable' and include_database else 'ok', (label, old))
                    new = read_once(self, *args, label, bool(expected))
                    self.assertEqual(frozen(new), frozen(old), label)
                    self.assertEqual(sorted_json(new), sorted_json(old), label)


class VirtualRefusalOrder(unittest.TestCase):
    """A database with a virtual table and two faults is refused as origin/main refused it."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-refusal-order-')
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name) / 'state'
        build(self.state, 'without-rowid')
        self.proof, _, _, self.capture = update._read_state(self.state, False, None, True)

    def test_a_database_with_a_virtual_table_is_refused_as_origin_main_refused_it(self):
        """Where the table names and the idle queries come first without one: a busy service
        with a corrupt guarded page, and an undecodable guarded row with a table name sorted
        after it."""
        undecodable = "UPDATE orchestration_events SET payload_json=CAST(x'ff' AS TEXT) WHERE sequence=1"
        cases = {'busy-and-corrupt': ([BUSY_RUN], 'DatabaseError'),
                 'undecodable-and-unexpected-name': ([undecodable, 'CREATE TABLE "zz-unexpected"(v)'], 'OperationalError')}
        for name, (statements, kind) in cases.items():
            state = self.state.with_name(name)
            build(state, 'without-rowid')
            updater_base.mutate_state(state, *FTS5_OVER_A_VIEW, *statements)
            if kind == 'DatabaseError': corrupt_leaf(state, 'orchestration_events')
            for include_database, since in itertools.product((False, True), (None, self.proof)):
                label = (name, include_database, since is not None)
                with self.subTest(label=label):
                    args = (state, False, since, include_database, None)
                    old = outcome(REFERENCE['_read_state'], *args)
                    self.assertEqual((old[0], old[1][0]), ('error', kind), label)
                    self.assertEqual(read_once(self, *args, label, True), old, label)

    def test_an_unexpected_table_name_is_refused_where_origin_main_refused_it(self):
        """With a virtual table, the guarded reads check each table name before it is read
        (update.guarded_hashes), the only name check before names are put into SQL: a name with
        upper case sorts before every guarded table and is refused before any row is read, and
        one sorted after an undecodable guarded row is never reached. The same answer and the
        same statements, over all 8 combinations of auth, since and capture."""
        notes = 'CREATE VIRTUAL TABLE notes USING fts5(body)'
        undecodable = "UPDATE orchestration_events SET payload_json=CAST(x'ff' AS TEXT) WHERE sequence=1"
        cases = {'mixed-case': ([notes, 'CREATE TABLE "Mixed_Case"(v)'], 'Unexpected table identifier'),
                 'undecodable-then-unexpected': ([notes, undecodable, 'CREATE TABLE "zz-unexpected"(v)'], None)}
        for name, (statements, refusal) in cases.items():
            state = self.state.with_name(name)
            build(state, 'without-rowid')
            updater_base.mutate_state(state, *statements)
            with contextlib.closing(sqlite3.connect(state / 'statev2.sqlite')) as db:
                self.assertEqual(update.virtual_tables(db, []), {'notes'})
            for include_auth, since, include_database in itertools.product((False, True), (None, self.proof), (False, True)):
                label = (name, include_auth, since is not None, include_database)
                with self.subTest(label=label):
                    args = (state, include_auth, since, include_database, None)
                    with traced_reads() as reference:
                        old = outcome(REFERENCE['_read_state'], *args)
                    with traced_reads() as statements_run:
                        new = read_once(self, *args, label, True)
                    if refusal:
                        self.assertEqual(old, ('error', ('AssertionError', refusal)), label)
                    else:
                        self.assertEqual((old[0], old[1][0]), ('error', 'OperationalError'), label)
                        self.assertRegex(old[1][1], "^Could not decode to UTF-8 column 'payload_json'")
                    self.assertEqual(new, old, label)
                    expected = reference[:]
                    expected.insert(expected.index(LIST_TABLES) + 1, TABLE_TEXT)
                    self.assertEqual(statements_run, expected, label)


if __name__ == '__main__':
    unittest.main()
