"""Compact, byte-validated table proofs for repeated update reads.

A cache hit still reads every b-tree/index/overflow page in the caller's pinned SQLite
snapshot. Only unchanged tables avoid decoding, JSON encoding and sorting their history.
The cached proof has the old exact encoding; migrations, unsupported SQLite builds, virtual
tables, malformed caches and unprovable snapshots take the original full-read path.

No database copy, history lines or authentication cells are cached. Log tables are always
read when kept_lines is active: their lines are needed for the post-restart append proof.
"""
import copy
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import struct
import sys
import tempfile

import database_continuity as continuity
import live_database

VERSION = 1
MAX_CACHE_BYTES = 8 << 20
READ_BYTES = 1 << 20
MAX_WAL_BYTES = 32 << 20  # Bound checksum work; large pinned logs use the original reader.
LAST = {}


class Unavailable(Exception):
    pass


def source_key():
    result = hashlib.sha256()
    for name in ('read_cache.py', 'update_read.py', 'database_continuity.py'):
        result.update(pathlib.Path(__file__).with_name(name).read_bytes())
    return result.hexdigest()


def _sha(value):
    return hashlib.sha256(continuity.encoded(value).encode()).hexdigest()


def _entry(value):
    return (isinstance(value, dict) and set(value) == {'count', 'sha256'}
            and type(value['count']) is int and value['count'] >= 0
            and isinstance(value['sha256'], str) and re.fullmatch('[0-9a-f]{64}', value['sha256']))


class Snapshot:
    """The same WAL-index binding as after_proof.open_live, borrowing existing lock probes.

    Never replace/close a watermark's probes: closing any database descriptor can drop all
    SQLite locks held by this process. Only descriptors created here are released, after our
    connection closes. Frames later than the pinned mxFrame are never read.
    """
    def __init__(self, database):
        self.database = os.path.abspath(database)
        self.db = self.wal = None
        self.owned = []
        self.frames = {}
        self.frame_numbers = {}
        self.bytes_read = 0

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.wal is not None:
            os.close(self.wal)
            self.wal = None
        for name in self.owned:
            live_database.release_probe(name)
        self.owned = []

    def open(self):
        # Import at call time: after_proof also imports update_read.
        import after_proof
        for suffix in ('', '-shm'):
            name = self.database + suffix
            if live_database.held_probe(name) is None:
                live_database.hold_probe(name)
                self.owned.append(name)
        self.main = live_database.held_probe(self.database)
        self.index = live_database.held_probe(self.database + '-shm')
        first = after_proof._index_header(self.index)
        self.db = live_database.connect(self.database)
        self.db.execute('BEGIN')
        self.db.execute('SELECT count(*) FROM sqlite_master').fetchone()
        current = after_proof._index_header(self.index)
        if first is None or current is None or first['raw'] != current['raw']:
            raise Unavailable('snapshot-moving')
        self.page_size = after_proof._page_size(os.pread(self.main, 100, 0))
        if current['pageSize'] not in (0, self.page_size):
            raise Unavailable('page-size')
        self.pages = self.db.execute('PRAGMA page_count').fetchone()[0]
        if (current['nPage'] or os.fstat(self.main).st_size // self.page_size) != self.pages:
            raise Unavailable('snapshot-size')
        self.wal_header = None
        if current['mxFrame']:
            if 32 + current['mxFrame'] * (24 + self.page_size) > MAX_WAL_BYTES:
                raise Unavailable('wal-budget')
            self.wal = os.open(self.database + '-wal', os.O_RDONLY | os.O_NOFOLLOW)
            self.wal_header = os.pread(self.wal, 32, 0)
            header = after_proof._log_header(self.wal)
            if header is None or header[0] != self.page_size or header[1] != current['salt'] or header[2] != current['big']:
                raise Unavailable('wal-generation')
            size, running = None, header[3]
            for frame in range(1, current['mxFrame'] + 1):
                offset = 32 + (frame - 1) * (24 + self.page_size)
                head = os.pread(self.wal, 24, offset)
                if len(head) != 24 or head[8:16] != current['salt']:
                    raise Unavailable('wal-frame')
                data = os.pread(self.wal, self.page_size, offset + 24)
                if len(data) != self.page_size:
                    raise Unavailable('wal-short-page')
                running = after_proof.read_delta._checksum(data, header[2],
                    *after_proof.read_delta._checksum(head[:8], header[2], *running))
                if running != struct.unpack_from('>II', head, 16):
                    raise Unavailable('wal-checksum')
                page, size = struct.unpack_from('>II', head)
                if not page:
                    raise Unavailable('wal-page')
                self.frames[page] = offset + 24
                self.frame_numbers.setdefault(page, []).append(frame)
            if size != self.pages or running != current['frameChecksum']:
                raise Unavailable('wal-index-checksum')
        self.check()
        return self

    def check(self):
        if not self.db.in_transaction or live_database.held_probe(self.database) != self.main \
                or live_database.held_probe(self.database + '-shm') != self.index:
            raise Unavailable('database-replaced')
        if self.wal is not None:
            if os.pread(self.wal, 32, 0) != self.wal_header:
                raise Unavailable('wal-restarted')
            now, opened = os.stat(self.database + '-wal'), os.fstat(self.wal)
            if (now.st_dev, now.st_ino) != (opened.st_dev, opened.st_ino):
                raise Unavailable('wal-replaced')

    def fingerprint(self, names):
        # dbstat enumerates the table, every index and every overflow page, including WITHOUT
        # ROWID tables. An unavailable/corrupt dbstat refuses the optimization, never the read.
        slots = ','.join('?' for _ in names)
        pages = self.db.execute("SELECT pageno,pagetype FROM dbstat('main') WHERE name IN (" + slots + ') ORDER BY pageno', names)
        result = hashlib.sha256()
        result.update(struct.pack('>I', self.page_size))
        block, start, last, count = b'', 0, 0, 0
        for page, kind in pages:
            if kind not in ('internal', 'leaf', 'overflow') or not last < page <= self.pages:
                raise Unavailable('invalid-page-map')
            if page in self.frames:
                data = os.pread(self.wal, self.page_size, self.frames[page])
            else:
                offset = (page - 1) * self.page_size
                if not start <= offset < start + len(block):
                    start = offset
                    block = os.pread(self.main, READ_BYTES, start)
                data = block[offset - start:offset - start + self.page_size]
            if len(data) != self.page_size:
                raise Unavailable('short-page')
            result.update(struct.pack('>Q', page))
            result.update(data)
            self.bytes_read += self.page_size
            last, count = page, count + 1
        if not count:
            raise Unavailable('missing-pages')
        return result.hexdigest()


class Cache:
    def __init__(self, state, snapshot, structure, keep=None):
        self.snapshot, self.structure = snapshot, structure
        if snapshot.db.execute("SELECT 1 FROM sqlite_master WHERE name='dbstat' COLLATE NOCASE UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name='dbstat' COLLATE NOCASE").fetchone():
            raise Unavailable('shadowed-dbstat')
        self.path = pathlib.Path(state).parent / 'updates' / 'read-cache-v1.json'
        self.key = {'version': VERSION, 'source': source_key(),
                    'database': snapshot.database, 'schema': _sha(structure)}
        self.old = self.load()
        self.fingerprints = {}
        objects = structure['objects']
        import update_read
        for table in structure['columns']:
            if keep is not None and table in update_read.LOG_TABLES:
                continue  # These must be serialized for restart; do not read their pages twice.
            names = [row[1] for row in objects if row[2] == table and row[0] in ('table', 'index')]
            self.fingerprints[table] = snapshot.fingerprint(names)
        self.reuse = {}
        self.threads = None

    def load(self):
        try:
            if self.path.is_symlink() or self.path.parent.is_symlink():
                return {}
            with self.path.open('rb') as handle:
                raw = handle.read(MAX_CACHE_BYTES + 1)
            if len(raw) > MAX_CACHE_BYTES:
                return {}
            envelope = json.loads(raw)
            value = envelope['value']
            if _sha(value) != envelope['sha256'] or value['key'] != self.key:
                return {}
            if not isinstance(value['tables'], dict):
                return {}
            for entry in value['tables'].values():
                if not _entry(entry['typed']) or not _entry(entry['legacy']) \
                        or not re.fullmatch('[0-9a-f]{64}', entry['pages']):
                    return {}
            return value
        except (OSError, ValueError, KeyError, TypeError):
            return {}

    def select(self, db, keep):
        import update_read
        old = self.old.get('tables', {})
        unchanged = {table for table, fingerprint in self.fingerprints.items()
                     if old.get(table, {}).get('pages') == fingerprint}
        threads = []
        for table in self.structure['columns']:
            key = update_read.stream_column(update_read.table_columns(db, table))
            if update_read.is_projection_table(table) and key and table not in update_read.CURSOR_COLUMNS:
                threads.append(table)
        activity = self.old.get('activity')
        order = self.old.get('threadOrder')
        if set(threads) <= unchanged and update_read.valid_activity(activity) \
                and activity['threadTables'] == sorted(threads) \
                and isinstance(order, list) and all(isinstance(k, str) for k in order) \
                and len(order) == len(activity['threadSha256']) and set(order) == set(activity['threadSha256']) \
                and all(isinstance(k, str) and isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v)
                        for k, v in activity['threadSha256'].items()):
            self.threads = {key: activity['threadSha256'][key] for key in order}
        excluded = set(update_read.CURSOR_COLUMNS) | {'auth_sessions', 'sqlite_sequence'}
        if self.threads is None:
            excluded.update(threads)
        if keep is not None:
            # The after-restart append proof needs sorted log lines. Never trade a cheaper
            # initial read for an unavoidable full log scan while the new service starts.
            excluded.update(update_read.LOG_TABLES)
        self.reuse = {table: copy.deepcopy(old[table]) for table in unchanged - excluded}

    def save(self, reads):
        rows, _, _, capture = reads
        value = {'key': self.key, 'tables': {
            table: {'pages': fingerprint, 'typed': capture['summary']['tables'][table],
                    'legacy': capture['legacy'][table]} for table, fingerprint in self.fingerprints.items()},
                 'activity': rows['appendOnlyActivity'],
                 'threadOrder': list(rows['appendOnlyActivity']['threadSha256'])}
        data = (continuity.encoded({'value': value, 'sha256': _sha(value)}) + '\n').encode()
        if len(data) > MAX_CACHE_BYTES:
            return
        folder = self.path.parent
        if folder.is_symlink() or self.path.is_symlink():
            return
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix='.read-cache-', dir=folder)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass


def read(state, include_auth, keep):
    """Full-format capture with safely reused table hashes, or None before a snapshot opens.

    Once idle work has been judged, fallback stays inside that same read transaction. A
    concurrent writer cannot turn a busy snapshot into an accepted later snapshot, and the
    original single-scan fault ordering remains intact.
    """
    import update_read
    global LAST
    snapshot = Snapshot(str(pathlib.Path(state) / 'statev2.sqlite'))
    try:
        try:
            snapshot.open()
        except Exception as error:
            LAST = {'mode': 'full', 'reason': type(error).__name__ + ':' + str(error)}
            return None
        db = snapshot.db
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        if any(re.fullmatch('[a-z0-9_]+', table) is None for table in tables) or update_read.virtual_tables(db, tables):
            return None
        update_read.assert_idle(db)
        cache = None
        try:
            cache = Cache(state, snapshot, continuity.schema(db), keep)
            cache.select(db, keep)
        except Exception as error:
            LAST = {'mode': 'full', 'reason': type(error).__name__ + ':' + str(error)}
            cache = None
        try:
            reads = update_read._read_tables(db, tables, include_auth, None, True, None, once=True,
                                            **({'keep': keep} if keep is not None else {}),
                                            **({'cache': cache} if cache is not None and cache.reuse else {}))
        except Exception:
            if keep is not None:
                keep.clear()
            if not db.in_transaction:
                raise
            return update_read._read_tables(db, tables, include_auth, None, True, None)
        if cache is not None:
            try:
                snapshot.check()
            except Exception as error:
                LAST = {'mode': 'full', 'reason': type(error).__name__ + ':' + str(error)}
                if keep is not None:
                    keep.clear()
                # The SQL snapshot remains valid even if physical WAL provenance cannot be
                # proven. Its original reader determines the answer, without using the cache.
                return update_read._read_tables(db, tables, include_auth, None, True, None, once=True,
                                                **({'keep': keep} if keep is not None else {}))
            try:
                cache.save(reads)
            except OSError:
                pass  # A read-only/full cache folder never changes a valid database proof.
            LAST = {'mode': 'pages', 'reusedTables': sorted(cache.reuse), 'bytesRead': snapshot.bytes_read}
        return reads
    finally:
        snapshot.close()
