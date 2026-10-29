"""Versioned same-schema preservation verdict; no cached history or fabricated row hashes.

The caller must hold the owned service idle and supply after_proof.stopped's immutable
clone. That stopped image is the baseline (never the earlier running-service reference).
Unchanged pages preserve their exact cells. Changed leaves/overflow owners are compared
through SQLite's typed rows; uncertain layout, snapshots or policy refuse this fast path.
The caller then uses the existing complete capture/migration proof, never assumes success.
"""
import os
import pathlib
from types import SimpleNamespace

import after_proof
import auth_heartbeat
import database_continuity as continuity
import read_cache
import update_read

Refused = after_proof.Refused
MAX_CHANGED_ROWS = 50000
MAX_CHANGED_BYTES = 64 << 20


def prove(state, held, restart_started_at, observed_after_at, *, identity='m4', web_session_policy=None):
    if not isinstance(held, dict) or not held.get('clone'):
        raise Refused('no-stopped-clone')
    baseline = dict(held, gap=[])
    baseline.pop('reference', None)
    proof = PageProof(str(pathlib.Path(state) / 'statev2.sqlite'), baseline,
                      restart_started_at, observed_after_at, identity, web_session_policy)
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
    def __init__(self, database, held, started, observed, identity, policy):
        super().__init__(os.path.abspath(database), held, SimpleNamespace(tables={}), {}, {}, None, True)
        self.snapshot = None
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
                'decodedRows': self.decoded_rows, 'decodedBytes': self.decoded_bytes}

    def projections(self):
        return [(table, update_read.stream_column(update_read.table_columns(self.db, table)))
                for table in self.tables if update_read.is_projection_table(table)
                and table not in update_read.CURSOR_COLUMNS
                and update_read.stream_column(update_read.table_columns(self.db, table))]
