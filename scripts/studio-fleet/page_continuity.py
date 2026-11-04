"""Versioned same-schema preservation verdict; no cached history or fabricated row hashes.

The caller must hold the owned service idle and supply after_proof.stopped's immutable
clone. That stopped image is the baseline (never the earlier running-service reference).
Unchanged pages preserve their exact cells. Changed leaves/overflow owners are compared
through SQLite's typed rows; uncertain layout, snapshots or policy refuse this fast path.
The caller then uses the existing complete capture/migration proof, never assumes success.

With `migrations` (an update allowed to migrate), a schema delta that is exactly what declared
additive migrations create (additive_migrations.delta: new tables and indexes only, every earlier
schema entry and migration row unchanged) keeps this proof: the new b-trees are new data, each of
their pages freshly written, and every page of every earlier b-tree is proven as without a delta.
A declared rebuild (additive_migrations.REBUILT, migration 072: a table recreated under its name
with the same columns and a wider CHECK) keeps it too: the old trees' typed rows equal the new
trees' row for row (within MAX_CHANGED_ROWS), the new index is consistent with the new table, every page of
the new trees was written after the stop, every page of the old trees is free in the live database
or reused by a tree whose rows are compared, and every other b-tree is proven page by page.
Anything else still refuses 'schema' and takes the full read.
"""
import os
import pathlib
import re
import struct
from types import SimpleNamespace

import additive_migrations
import after_proof
import auth_heartbeat
import database_continuity as continuity
import read_cache
import update_read

Refused = after_proof.Refused
MAX_CHANGED_ROWS = 50000
MAX_CHANGED_BYTES = 64 << 20
MAX_REBUILT_PAGES = 16384  # Interior and leaf pages of one rebuilt tree, per version.


def prove(state, held, restart_started_at, observed_after_at, *, identity='m4', web_session_policy=None, migrations=False):
    if not isinstance(held, dict) or not held.get('clone'):
        raise Refused('no-stopped-clone')
    baseline = dict(held, gap=[])
    baseline.pop('reference', None)
    proof = PageProof(str(pathlib.Path(state) / 'statev2.sqlite'), baseline,
                      restart_started_at, observed_after_at, identity, web_session_policy, migrations)
    try:
        verdict, record = proof.run()
        proof.snapshot.check()
        proof.check_clone()
        return {**verdict, 'pages': record}
    except read_cache.Unavailable as error:
        raise Refused(str(error)) from error
    finally:
        proof.close()


class PageProof(after_proof._Proof):
    def __init__(self, database, held, started, observed, identity, policy, migrations=False):
        super().__init__(os.path.abspath(database), held, SimpleNamespace(tables={}), {}, {}, None, True)
        self.snapshot = None
        self.migrations, self.delta, self.added, self.rebuilt = migrations, None, {}, {}
        self.rebuilt_rows = 0
        self.started, self.observed, self.identity, self.policy = started, observed, identity, policy
        self.decoded_rows = self.decoded_bytes = 0

    def open_live(self):
        self.snapshot = read_cache.Snapshot(self.database)
        self.snapshot.open()
        snap = self.snapshot
        self.db, self.main_fd, self.wal_fd = snap.db, snap.main, snap.wal
        self.page_size, self.pages, self.log_header = snap.page_size, snap.pages, snap.wal_header
        self.frames = snap.frame_numbers
        self.tables = [row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]

    def open_clone(self):
        super().open_clone()
        self.clone_stat = self.file_identity(os.fstat(self.clone_fd))
        self.check_clone()
        self.clone_db.execute('BEGIN')
        self.capture = {'schema': continuity.schema(self.clone_db)}

    @staticmethod
    def file_identity(value):
        return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns

    def check_clone(self):
        if self.file_identity(os.stat(self.held['clone'], follow_symlinks=False)) != self.clone_stat \
                or self.file_identity(os.fstat(self.clone_fd)) != self.clone_stat:
            raise Refused('clone-changed')

    def close(self):
        if self.clone_db is not None:
            self.clone_db.close()
        for fd in {self.clone_fd, self.stop_fd} - {None}:
            os.close(fd)
        if self.snapshot is not None:
            self.snapshot.close()

    # A schema delta of declared additive migrations.

    def check_schema(self):
        query = 'SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name'
        live = [tuple(row) for row in self.db.execute(query)]
        old = [tuple(row) for row in self.clone_db.execute(query)]
        if not self.migrations or live == old:
            return super().check_schema()
        for table in self.tables:
            if not re.fullmatch('[a-z0-9_]+', table):
                raise Refused('table-name')
        if after_proof.virtual_tables(self.db, self.tables):
            raise Refused('virtual-table')
        try:
            self.delta = additive_migrations.delta(old, live, self.clone_db, self.db)
        except additive_migrations.Undeclared as error:
            raise Refused('schema:' + str(error)) from None
        self.added, self.rebuilt, self.master = self.delta['objects'], self.delta['rebuilt'], live
        self.structure = continuity.schema(self.db)
        if continuity.encoded(additive_migrations.without(self.structure, self.added, self.rebuilt)) != \
                continuity.encoded(additive_migrations.without(self.capture['schema'], {}, self.rebuilt)):
            raise Refused('schema:structure')
        if 1 in self.gap and not self.reference:
            raise Refused('gap-touches-schema')
        live_page, clone_page = (self.page(version, 1) for version in ('live', 'clone'))
        # Header bytes 24-40 (change counter, size, freelist) differ after any write, as without a
        # delta; the schema cookie (40) must have moved forward, every other field stays. Page 1's
        # cells are sqlite_schema's root, whose rows delta() compared above.
        if live_page[:24] != clone_page[:24] or live_page[44:92] != clone_page[44:92]:
            raise Refused('schema')
        if struct.unpack_from('>I', live_page, 40)[0] <= struct.unpack_from('>I', clone_page, 40)[0]:
            raise Refused('schema:cookie')
        if struct.unpack_from('>I', clone_page, 52)[0]:
            raise Refused('auto-vacuum')

    def walk(self):
        """after_proof's walk, where an added b-tree exists only in the live version and a rebuilt one
        has its old root in the clone; then check_added and check_rebuilt."""
        if not self.added and not self.rebuilt:
            return super().walk()
        self.trees = [(after_proof.SCHEMA, 1, 'table', after_proof.SCHEMA)] + [
            (name, root, kind, table) for kind, name, table, root, _ in self.master if kind in ('table', 'index') and root]
        self.tree_table = {name: table if kind == 'index' else name for name, _, kind, table in self.trees}
        self.tree_kind = {name: kind for name, _, kind, _ in self.trees}
        for version in ('clone', 'live'):
            for name, root, _, _ in self.trees:
                if version == 'clone' and name in self.added:
                    self.leaves[version, name] = []
                    continue
                if version == 'clone' and name in self.rebuilt:
                    root = self.rebuilt[name][2]
                interior, leaves, family = self.tree(version, root)
                for number in self.paged.intersection(interior):
                    self.claim(version, number, name)
                for number in self.paged.intersection(leaves):
                    self.claim(version, number, name)
                self.leaves[version, name], self.kinds[name] = leaves, family
            self.freelist(version)
        for version, pages in (('clone', sorted(self.paged)), ('live', sorted(self.changed))):
            for number in pages:
                owner = self.owners[version].get(number)
                if owner is not None and owner != after_proof.FREE and number not in self.overflow[version]:
                    self.cells(version, number, owner)
        self.check_added()
        self.check_rebuilt()

    def check_added(self):
        """Every page of an added b-tree (interior, leaf, overflow) was written after the stop, so
        it was free or past the clone's end and its claim in walk() makes sharing a page with any
        other tree refuse ('page-owned-twice'); its kind is its schema entry's."""
        for name, (kind, _, root) in sorted(self.added.items()):
            interior, leaves, family = self.tree('live', root)
            if family != (after_proof.TABLE_PAGES if kind == 'table' else after_proof.INDEX_PAGES):
                raise Refused('added-tree-kind')
            pages = set(interior) | set(leaves)
            for number in interior + leaves:
                page = self.page('live', number)
                page_kind = page[100 if number == 1 else 0]
                if page_kind == 5:
                    continue
                for _, count, link in self.cell_links(page, 100 if number == 1 else 0, page_kind):
                    pages.update(self.chain('live', count, link))
            if not pages <= self.live_changed:
                raise Refused('added-tree-page-unchanged')

    def tree_pages(self, version, root, family):
        """Every page of the b-tree at `root` in `version`: (interior and leaf pages, overflow pages)."""
        interior, leaves, found = self.tree(version, root)
        if found != family:
            raise Refused('rebuild-tree-kind')
        if len(interior) + len(leaves) > MAX_REBUILT_PAGES:
            raise Refused('rebuild-budget')
        overflow = set()
        for number in interior + leaves:
            page = self.page(version, number)
            kind = page[100 if number == 1 else 0]
            if kind == 5:
                continue
            for _, count, link in self.cell_links(page, 100 if number == 1 else 0, kind):
                overflow.update(self.chain(version, count, link))
        return set(interior) | set(leaves), overflow

    def free_pages(self, version):
        """Every page on `version`'s freelist (freelist() already checked its shape)."""
        trunk, total = struct.unpack_from('>II', self.page(version, 1), 32)
        pages = set()
        while trunk:
            if trunk in pages:
                raise Refused('freelist')
            pages.add(trunk)
            page = self.page(version, trunk)
            trunk, count = struct.unpack_from('>II', page, 0)
            if count > self.usable // 4 - 2:
                raise Refused('freelist')
            pages.update(struct.unpack_from('>%dI' % count, page, 8))
            if len(pages) > total:
                raise Refused('freelist')
        if len(pages) != total:
            raise Refused('freelist')
        return pages

    def check_rebuilt(self):
        """A declared rebuild's trees: every page of each new tree (interior, leaf, overflow) was
        written after the stop, and every page of each old tree is on the live freelist, in a new
        tree, or a changed page another tree now owns (whose rows touched() then compares). The
        changed and gap pages of both are claimed for the rebuilt name, so a page another tree also
        claims refuses ('page-owned-twice'). The rows themselves are compared in assemble()."""
        if not self.rebuilt:
            return
        old_pages, new_pages = set(), set()
        for name, (kind, _, old_root, new_root) in sorted(self.rebuilt.items()):
            family = after_proof.TABLE_PAGES if kind == 'table' else after_proof.INDEX_PAGES
            for version, root, pages in (('clone', old_root, old_pages), ('live', new_root, new_pages)):
                nodes, overflow = self.tree_pages(version, root, family)
                for number in sorted((nodes | overflow) & self.paged):
                    owner = self.owners[version].get(number)
                    if owner is None:
                        self.claim(version, number, name, overflow=number in overflow)
                    elif owner != name:
                        raise Refused('page-owned-twice')
                pages.update(nodes | overflow)
        if not new_pages <= self.live_changed:
            raise Refused('rebuild-tree-page-unchanged')
        free = self.free_pages('live')
        for number in sorted(old_pages - new_pages - free):
            owner = self.owners['live'].get(number) if number in self.changed else None
            if owner in (None, after_proof.FREE) or owner in self.rebuilt:
                raise Refused('rebuild-old-page-kept')

    def rebuilt_lines(self, db, query):
        """The sorted typed rows `query` reads from `db`, counted against MAX_CHANGED_ROWS and
        MAX_CHANGED_BYTES as changed rows are: both sides are held in memory at once."""
        values = []
        for row in db.execute(query):
            self.decoded_rows += 1
            self.decoded_bytes += sum(len(value) if isinstance(value, (str, bytes)) else 8 for value in row)
            if self.decoded_rows > MAX_CHANGED_ROWS or self.decoded_bytes > MAX_CHANGED_BYTES:
                raise Refused('changed-row-budget')
            values.append(continuity.typed_line(row))
        return sorted(values)

    def compare_rebuilt(self):
        """A rebuilt table's typed rows in the clone equal the live table's row for row (ordered by
        their typed cells: the copy renumbers rowids), and each rebuilt index in the live database
        holds exactly the live table's rows (the old index is gone with the old tree, whose pages
        check_rebuilt accounts for). Bounded by MAX_CHANGED_ROWS and MAX_CHANGED_BYTES, as changed
        rows are.

        Equality is strict, also for rows the new service could write after the migration: the
        proof runs after the restart, so a retention marker inserted or completed in between
        refuses 'rebuild-rows', exactly as any write to this table refuses
        'authority-table-changed' in an update without the rebuild, and the full read refuses it
        too (the table's count and hash are guarded). ThreadHistoryRetention runs every write behind
        shouldContinue, which stops while an update helper holds its snapshot or the install gate,
        and a marker is always followed by event deletes the proof refuses anyway."""
        for name, (kind, table, _, _) in sorted(self.rebuilt.items()):
            if not re.fullmatch('[a-z0-9_]+', name):
                raise Refused('table-name')
            if kind == 'table':
                old, new = (self.rebuilt_lines(db, 'SELECT * FROM ' + name + ' NOT INDEXED') for db in (self.clone_db, self.db))
                if old != new:
                    raise Refused('rebuild-rows:' + name)
                self.rebuilt_rows += len(new)
                continue
            columns = [row[2] for row in self.db.execute('PRAGMA index_xinfo(' + name + ')') if row[5]]
            if not columns or not all(isinstance(column, str) and re.fullmatch('[a-z0-9_]+', column) for column in columns):
                raise Refused('rebuild-index:' + name)
            selected = ', '.join(columns) + ', rowid FROM ' + table
            if self.rebuilt_lines(self.db, 'SELECT ' + selected + ' INDEXED BY ' + name) != \
                    self.rebuilt_lines(self.db, 'SELECT ' + selected + ' NOT INDEXED'):
                raise Refused('rebuild-index:' + name)

    def touched(self):
        """after_proof's touched(), where sqlite_schema pages (their rows proven by delta()), an
        added b-tree's pages (check_added) and a rebuilt one's (compare_rebuilt) belong to no
        compared table."""
        if not self.added and not self.rebuilt:
            return super().touched()
        for number in self.paged:
            if number != 1 and not (self.owners['clone'].get(number) or (number in self.changed and self.owners['live'].get(number))):
                raise Refused('unowned-page')
        tables, indexed, self.gap_tables = set(), set(), set()
        for version, pages in (('clone', self.paged), ('live', self.changed)):
            for number in pages:
                owner = self.owners[version].get(number)
                if owner in (None, after_proof.FREE, after_proof.SCHEMA) or owner in self.added or owner in self.rebuilt:
                    continue
                (indexed if self.tree_kind[owner] == 'index' else tables).add(self.tree_table[owner])
                if version == 'clone' and number in self.gap and not self.reference:
                    self.gap_tables.add(self.tree_table[owner])
        if indexed - tables:
            raise Refused('index-only')
        return tables

    def changed_rows(self, table):
        if not self.rowid_table(table):
            raise Refused('changed-table-without-rowid')
        if set(self.leaves['clone', table]) - self.changed != set(self.leaves['live', table]) - self.changed:
            raise Refused('leaf-sets')
        self.leaves_verified += sum(len(set(self.leaves[v, table]) & self.changed) for v in ('clone', 'live'))
        rows = []
        # NOT INDEXED guarantees that corruption of a changed index cannot hide changed table cells.
        query = 'SELECT rowid, * FROM ' + table + ' NOT INDEXED WHERE rowid BETWEEN ? AND ?'
        for db in (self.clone_db, self.db):
            values = {}
            for low, high in after_proof._intervals(self.ranges.get(table, [])):
                for row in db.execute(query, (low, high)):
                    self.decoded_rows += 1
                    self.decoded_bytes += sum(len(value) if isinstance(value, (str, bytes)) else 8 for value in row)
                    if self.decoded_rows > MAX_CHANGED_ROWS or self.decoded_bytes > MAX_CHANGED_BYTES:
                        raise Refused('changed-row-budget')
                    values[row[0]] = row[1:]
            rows.append(values)
        return after_proof._changed_rows(*rows)

    def auth(self, db):
        values = [list(row) for row in db.execute('SELECT * FROM auth_sessions NOT INDEXED')]
        view = {'nativeWorkIdle': True, update_read.AUTH_INVARIANT_KEY: update_read.auth_invariant_hash(db),
                'counts': {'auth_sessions': len(values)},
                'hashes': {'auth_sessions': auth_heartbeat.rows_hash(values)}}
        return view, auth_heartbeat.read_auth_sessions_in_transaction(db, view)

    def identities(self, table, column):
        # These ID sets are small, have explicit preservation meaning, and contain no history.
        old, new = [set(row[0] for row in db.execute('SELECT ' + column + ' FROM ' + table + ' NOT INDEXED'))
                    for db in (self.clone_db, self.db)]
        if not old <= new:
            raise Refused('identity-removed')
        return new - old

    def assemble(self, touched):
        self.compare_rebuilt()
        changes = {table: self.changed_rows(table) for table in sorted(touched)}
        appended, streams = {}, set()
        for table in update_read.LOG_TABLES:
            if table not in self.tables:
                continue
            if not self.rowid_table(table):
                raise Refused('log-without-rowid')
            removed, added = changes.get(table, ([], []))
            boundary = self.clone_db.execute('SELECT coalesce(max(rowid),0) FROM ' + table + ' NOT INDEXED').fetchone()[0]
            if removed or any(rowid <= boundary for rowid, _ in added):
                raise Refused('old-log-row-changed')
            appended[table] = len(added)
            key = update_read.STREAM_COLUMNS.get(table)
            columns = update_read.table_columns(self.db, table)
            if key and key in columns:
                streams.update(update_read.stream_key(values[columns.index(key)]) for _, values in added)
        grew = any(appended.values())
        for table, (removed, added) in changes.items():
            if table in update_read.LOG_TABLES or table == 'auth_sessions':
                continue
            if not removed and not added:
                continue
            columns = update_read.table_columns(self.db, table)
            key = update_read.stream_column(columns)
            if table in update_read.CURSOR_COLUMNS:
                moving = update_read.CURSOR_COLUMNS[table]
                def stable(rows):
                    return sorted(continuity.typed_line([v for c, v in zip(columns, values) if c not in moving])
                                  for _, values in rows)
                if not grew or stable(removed) != stable(added):
                    raise Refused('cursor-authority-changed')
            elif table == 'sqlite_sequence':
                entries = [list(db.execute('SELECT * FROM sqlite_sequence NOT INDEXED'))
                           for db in (self.clone_db, self.db)]
                old, new = (dict(rows) for rows in entries)
                if any(len(rows) != len(dict(rows)) for rows in entries):
                    raise Refused('duplicate-sequence')
                if set(old) != set(new) or any(name not in update_read.LOG_TABLES or type(value) is not int
                      or type(old[name]) is not int or value < old[name] or not appended.get(name)
                      for name, value in new.items() if type(value) is not type(old.get(name)) or value != old.get(name)):
                    raise Refused('sequence-changed')
            elif table == additive_migrations.MIGRATIONS_TABLE and self.delta is not None:
                # delta() compared every row; only the declared migrations' rows were added.
                if removed or sorted(rowid for rowid, _ in added) != self.delta['migrations']:
                    raise Refused('migration-rows')
            elif update_read.is_projection_table(table) and key:
                index = columns.index(key)
                changed = {update_read.stream_key(values[index]) for _, values in removed + added}
                if not changed <= streams:
                    raise Refused('projection-without-event')
                # Old streams must still exist somewhere in the projection group. New row IDs
                # are not themselves authority; the event stream is the admitted change.
                for stream in changed:
                    if stream.startswith('#'):
                        raise Refused('projection-stream-type')
                    if not any(self.db.execute('SELECT 1 FROM ' + name + ' WHERE ' + column + '=? LIMIT 1', (stream,)).fetchone()
                               for name, column in self.projections()):
                        raise Refused('projection-stream-removed')
            else:
                raise Refused('authority-table-changed:' + table)
        if 'projection_projects' in self.tables and self.identities('projection_projects', 'project_id'):
            raise Refused('project-added')
        for table in ('projection_threads', 'orchestration_v2_projection_threads'):
            if table in self.tables and not self.identities(table, 'thread_id') <= streams:
                raise Refused('thread-without-event')
        witness = None
        if 'auth_sessions' in self.tables:
            old, original = self.auth(self.clone_db)
            new, current = self.auth(self.db)
            if old == new and continuity.typed_rows_hash(original['rows']) != continuity.typed_rows_hash(current['rows']):
                raise Refused('auth-heartbeat:typed-collision')
            try:
                witness = auth_heartbeat.prove_restart_heartbeat(old, new, original, current,
                    self.started, self.observed, identity=self.identity, web_session_policy=self.policy)
            except AssertionError as error:
                raise Refused('auth-heartbeat:' + str(error)) from error
        return {'schemaVersion': 1, 'proofKind': 'stopped-clone-pages-v1', 'preserved': True,
                'schemaSha256': continuity.digest(continuity.encoded(self.structure)),
                'appendedRows': appended, 'touchedStreams': sorted(streams), 'authHeartbeat': witness,
                'decodedRows': self.decoded_rows, 'decodedBytes': self.decoded_bytes,
                **({'schemaDelta': {'migrations': self.delta['migrations'], 'objects': sorted(self.added),
                                    **({'rebuilt': sorted(self.rebuilt), 'rebuiltRows': self.rebuilt_rows}
                                       if self.rebuilt else {})}}
                   if self.delta is not None else {})}

    def projections(self):
        return [(table, update_read.stream_column(update_read.table_columns(self.db, table)))
                for table in self.tables if update_read.is_projection_table(table)
                and table not in update_read.CURSOR_COLUMNS
                and update_read.stream_column(update_read.table_columns(self.db, table))]
