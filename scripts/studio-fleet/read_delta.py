"""A re-read before the restart that costs what changed since the last read, not the database.

update.py checks the database again before the restart (the prestate check, after the install
gate settles, right before the stop). The read watermark lets a read stand while nothing commits,
but a drained, held service still commits: every connected browser, desktop and phone app rewrites
its session's `last_connected_at` every few seconds (AuthSessions.setLastConnectedAtRow), and a
reconnect reports its surface and app version. Each such commit made every check a full read of
the whole database (40-68 s on M4's 8 GB). Those commits write only the auth_sessions table.

`reread` proves that, from SQLite's own files, and then reads only that table:

1. `position(database)` is taken right before a read. It parses the -wal file as SQLite's
   recovery does (header and frame salts, the cumulative checksums, commit frames) and keeps
   the frame of the second-to-last commit. Every commit up to there was visible to any read that
   starts later: a writer publishes its commit in the WAL index before it lets the next writer
   in, so only the last commit in the file may still be unpublished.
2. `reread` opens a read transaction, then lists the page numbers of every frame after that
   position (`written_pages`). They hold every page any commit wrote since the earlier read: in
   one WAL generation (the same salts) frames are only appended, and a reset gives new salts.
3. In that transaction, `dbstat` lists the pages of auth_sessions and of its indexes. Any change
   to a table writes at least one page that still belongs to that table afterwards (its leaf,
   an ancestor up to its root, or an overflow page of a row that stays), and the schema is page 1.
   So when every written page belongs to auth_sessions or its indexes, every other table and the
   schema read as in the earlier read, and only auth_sessions is read again: its legacy and typed
   hashes and the auth invariant, as the full read hashes it.

Anything else gives None and update.py reads in full: no -wal (or not in WAL mode), another
generation, another -wal file, a database file renamed over, copied over or checkpointed into since
(its device, inode, size, mtime or 100-byte header differ), a page of any other table, the schema, the free list, a virtual
table, a SQLite without dbstat (python.org builds; macOS /usr/bin/python3 has it), or a read whose
appended rows were measured against other log positions. The proof format is unchanged: the result
is the earlier read's rows, appended rows and capture with auth_sessions' entries replaced, which is
what a full read returns when only that table changed. Stdlib only.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import array
import copy
import os
import struct
import sys

import database_continuity as continuity
import live_database
from update_read import ACTIVITY_KEY, AUTH_INVARIANT_KEY, auth_invariant_hash, virtual_tables

WAL_MAGIC = (0x377f0682, 0x377f0683)  # The low bit: checksums read the words big-endian.
WAL_VERSION = 3007000
WAL_HEADER_BYTES, FRAME_HEADER_BYTES = 32, 24
AUTH_TABLE = 'auth_sessions'
assert array.array('I').itemsize == 4, 'Unsupported platform word size'


def _checksum(data, big, first=0, second=0):
    """SQLite's WAL checksum (walChecksumBytes) of `data`, continuing from (first, second)."""
    words = array.array('I', data)
    if big != (sys.byteorder == 'big'):
        words.byteswap()
    for index in range(0, len(words), 2):
        first = (first + words[index] + second) & 0xFFFFFFFF
        second = (second + words[index + 1] + first) & 0xFFFFFFFF
    return first, second


def _header(handle):
    """(page size, salts, big-endian checksums, the header's checksum) of a valid -wal header, else None."""
    header = handle.read(WAL_HEADER_BYTES)
    if len(header) < WAL_HEADER_BYTES:
        return None
    magic, version, page_size, _, salt1, salt2, sum1, sum2 = struct.unpack('>8I', header)
    if magic not in WAL_MAGIC or version != WAL_VERSION or not 512 <= page_size <= 65536 \
            or page_size & (page_size - 1):
        return None
    big = bool(magic & 1)
    if _checksum(header[:24], big) != (sum1, sum2):
        return None
    return page_size, [salt1, salt2], big, (sum1, sum2)


def _main_file(database):
    """The database file itself: (device, inode, size, mtime in ns, its 100-byte header in hex).
    In WAL mode SQLite writes this file only when it checkpoints; anything else that replaces it
    (a rename over it, a copy written in place) changes one of these. Reads through a held probe
    when there is one, so the watermark connection keeps its locks (closing any descriptor on the
    file drops them). Raises OSError."""
    held = live_database.held_probe(database)
    if held is not None:
        status = os.fstat(held)
        return [status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns, os.pread(held, 100, 0).hex()]
    with open(str(database), 'rb') as handle:
        status = os.fstat(handle.fileno())
        return [status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns, handle.read(100).hex()]


def position(database):
    """Where the -wal of `database` stood, taken right before a read: its inode, salts, page size
    and `frame`, the second-to-last valid commit frame (0 with fewer than two), and the database
    file itself (_main_file). None without a valid -wal (not in WAL mode, a log just reset and not
    yet written, a file that cannot be read)."""
    try:
        main = _main_file(database)
        with open(str(database) + '-wal', 'rb') as handle:
            inode = os.fstat(handle.fileno()).st_ino
            header = _header(handle)
            if header is None:
                return None
            page_size, salt, big, running = header
            frame, commits = 0, []
            while True:
                head = handle.read(FRAME_HEADER_BYTES)
                data = handle.read(page_size)
                if len(head) < FRAME_HEADER_BYTES or len(data) < page_size:
                    break
                page, size, salt1, salt2, sum1, sum2 = struct.unpack('>6I', head)
                if page == 0 or [salt1, salt2] != salt:
                    break
                running = _checksum(data, big, *_checksum(head[:8], big, *running))
                if running != (sum1, sum2):
                    break  # The log ends at the first frame that does not check (walIndexRecover).
                frame += 1
                if size:
                    commits.append(frame)
    except OSError:
        return None
    return {'walInode': inode, 'salt': salt, 'pageSize': page_size,
            'frame': commits[-2] if len(commits) > 1 else 0, 'main': main}


def written_pages(database, earlier, why=None):
    """The page numbers of every frame after `earlier` (a position) in the same -wal generation,
    read inside the caller's read transaction, so they include every commit its snapshot holds.
    None when the -wal is another file or generation, or shorter than `earlier` said, or when the
    database file is another file or was written since (a swap, a copy over it, a checkpoint):
    the -wal says nothing about pages written to the database file itself. `why`, a dict, is
    given the reason for None (a receipt diagnostic)."""
    def miss(reason):
        if why is not None:
            why['reason'] = reason
        return None
    if not isinstance(earlier, dict) or not isinstance(earlier.get('main'), list):
        return miss('no-position')
    try:
        if _main_file(database) != earlier['main']:
            return miss('main-file-changed')  # A checkpoint, a swap or a copy over it.
        with open(str(database) + '-wal', 'rb') as handle:
            status = os.fstat(handle.fileno())
            header = _header(handle)
            if status.st_ino != earlier['walInode']:
                return miss('wal-replaced')
            if header is None or header[0] != earlier['pageSize'] or header[1] != earlier['salt']:
                return miss('wal-reset')
            frame_bytes = FRAME_HEADER_BYTES + earlier['pageSize']
            start = WAL_HEADER_BYTES + earlier['frame'] * frame_bytes
            if status.st_size < start:
                return miss('wal-shorter')
            handle.seek(start)
            pages = set()
            while True:
                head = handle.read(FRAME_HEADER_BYTES)
                if len(head) < FRAME_HEADER_BYTES:
                    break
                page, _, salt1, salt2 = struct.unpack('>4I', head[:16])
                if [salt1, salt2] != earlier['salt']:
                    break  # Frames of an earlier generation, past the end of this one.
                pages.add(page)
                handle.seek(earlier['pageSize'], os.SEEK_CUR)
            # A log reset while the frames were read would have new salts here.
            handle.seek(0)
            again = _header(handle)
            if again is None or again[1] != earlier['salt']:
                return miss('wal-reset')
            if _main_file(database) != earlier['main']:
                return miss('main-file-changed')
            return pages
    except OSError:
        return miss('unreadable')


def _auth_pages(db):
    """Pages of auth_sessions and of its indexes in this transaction's snapshot, or None without
    dbstat or without the table."""
    names = [AUTH_TABLE] + [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", (AUTH_TABLE,))]
    pages = set()
    try:
        for name in names:
            pages.update(row[0] for row in db.execute('SELECT pageno FROM dbstat WHERE name=?', (name,)))
    except Exception:  # No dbstat in this SQLite: the full read decides.
        return None
    return pages


def _activity(rows):
    return continuity.encoded(rows.get(ACTIVITY_KEY)) if isinstance(rows, dict) else None


def reread(state, base, since, why=None):
    """(rows, carried, capture) as a full read (update_read._read_state, with the capture when
    `base` has one) measuring appended rows against `since` would return now, or None when it
    cannot be shown cheaply (see the module docstring). `base` is {'position', 'since', 'reads':
    (rows, carried, capture)}: an earlier read, the position taken right before it and the rows
    it measured appended rows against. Reads must measure against the same log positions, as
    appended rows depend on `since` only through its activity. `why`, a dict, is given the reason
    for None, and for pages outside auth sessions how many there were (a receipt diagnostic)."""
    why = {} if why is None else why
    if not isinstance(base, dict) or base.get('position') is None:
        why['reason'] = 'no-position'
        return None
    if _activity(base['since']) != _activity(since):
        why['reason'] = 'activity-changed'
        return None
    rows, carried, capture = copy.deepcopy(base['reads'])
    database = state / 'statev2.sqlite'
    db = live_database.connect(database)
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        pages = written_pages(database, base['position'], why)  # After the snapshot was taken above.
        if pages is None:
            return None
        if virtual_tables(db, tables):
            why['reason'] = 'virtual-tables'
            return None
        if not pages:
            return rows, carried, capture  # No commit since the earlier read.
        if AUTH_TABLE not in tables or AUTH_TABLE not in rows.get('counts', {}):
            why['reason'] = 'no-auth-table'
            return None
        allowed = _auth_pages(db)
        if allowed is None:
            why['reason'] = 'no-dbstat'
            return None
        if not pages <= allowed:
            # Page numbers only: naming their tables would scan dbstat over the whole file.
            outside = sorted(pages - allowed)
            why.update(reason='pages-outside-auth', pagesOutsideAuth=len(outside), samplePages=outside[:8])
            return None
        cells = list(db.execute('SELECT * FROM ' + AUTH_TABLE))
        legacy = {'count': len(cells), 'sha256': continuity.legacy_rows_hash(cells)}
        rows['counts'][AUTH_TABLE], rows['hashes'][AUTH_TABLE] = legacy['count'], legacy['sha256']
        if AUTH_INVARIANT_KEY in rows:
            rows[AUTH_INVARIANT_KEY] = auth_invariant_hash(db, cells)
        if capture is not None:
            capture['summary']['tables'][AUTH_TABLE] = {'count': len(cells), 'sha256': continuity.typed_rows_hash(cells)}
            capture['legacy'][AUTH_TABLE] = legacy
            continuity.bind_rows(capture, rows)
        return rows, carried, capture
    finally:
        db.close()
