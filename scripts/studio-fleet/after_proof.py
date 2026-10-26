"""The proof after the restart, at the cost of what the restart changed instead of the database.

update.py reads the whole database before the restart (`before`) and, until 1.0.71, again after it
to show that no row was lost: two full reads of M4's 9.65 GB statev2.sqlite, 60 s each, while the
new service had appended a few dozen events. This module returns what that second read
(update_read._read_state with the complete capture) would return, or None, and update.py then runs
the full read as before. Nothing it returns differs from the full read's bytes.

What it starts from, all taken by update.py in this process:

- the reference read: base['before'], the last read before the restart that matched `before` (the
  read itself, or the final check's re-read), and the sorted lines the read before the restart
  kept of every log and every large table (kept_lines);
- `mark`, right before the final check: a descriptor held on the old service's -wal and a reader in
  a child process (_Reader) holding a read transaction from then until the clone, so no checkpoint
  copies a later frame into the database file and the log cannot restart (but once, after a
  snapshot that read the file alone); `confirm`, after the final check, accepts that snapshot as
  the reference's when nothing committed since the reference was read;
- `stopped`, right after the APFS clone of the stopped service's files (state_backup.clone_state):
  the frames the old log gained after the reader's snapshot (the gap: commits after the final
  check, such as a heartbeat or what SIGTERM's cancelled background work appends), checked against
  the clone; the reference image (the clone with every gap page as the snapshot read it); and the
  database file once the log the reader kept is folded into it, as the old service's close would.

The clone is the database as the old service left it; from the reference it differs at most in
the gap pages, and the reference image is the reference's database. In one read transaction on the
live database (its WAL index header pinned before and after the snapshot opened):

1. Changed pages. Live pages are the latest -wal frame up to the snapshot's mxFrame, else the
   database file. The file is compared with the clone (stat alone when it was not written since
   the clone and no -wal was cloned; otherwise in 64 MiB chunks, then per page), and every page
   that differs must be one the live -wal holds and equal one of its frames (a checkpoint's copy)
   or, when the clone folded a -wal in, the page the file held under it. Changed pages are the
   -wal pages whose latest frame differs from the clone, and the gap pages.
2. Owners. Every b-tree of sqlite_master is walked in both versions from its root, reading interior
   pages only (all leaves sit at one depth), plus the free lists and the overflow chains of every
   changed b-tree page's cells. Any change to a table writes a page it owns afterwards: a table
   whose tree has no changed page reads as in the reference. A changed page that nothing owns (it
   could be an overflow page of an unchanged row), page 1 beyond its header counters, the schema,
   or a changed index of an otherwise untouched table refuses; a page one table freed and another
   took is in both tables' comparisons. Without the reference image (no reader, a reader lost
   before the stop, or no confirmation) the gap's old version is unknown and a gap page of a log,
   a projection keyed by thread or a kept table refuses.
3. Tables. An untouched table copies its capture entries from the reference. A touched kept table
   is compared row by row with the reference image (else the clone) over the rowid ranges of its
   changed leaves (the other leaves are the same pages in both trees), and its hashes are its kept
   lines with those rows taken out and put in (kept_lines.merged_digest); a log may only gain rows
   above where it ended.
   Any other touched table is read again. Streams (threads, projects) whose projection rows changed
   are hashed again from their rows, and keep their order. The idle check, project and thread ids,
   the auth invariant and auth cells, the projection cursors, the log positions and the appended
   rows (carried_since, with the earlier rows' hashes given) are read live as the full read does.

The read never uses dbstat, so it works on SQLite builds without it. The -wal is trusted as the
WAL index publishes it (frames up to mxFrame, salts checked; checksums only for the old log, whose
tail may be unpublished). It assumes that the database file changes only through SQLite while the
services run: the old service's commits from the mark to its exit go through the held -wal, or a
log created and removed again inside the stop window. Stdlib only; `python3 after_proof.py hold
<database>` is the reader's child process.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import contextlib
import copy
import hashlib
import json
import os
import pathlib
import re
import select
import signal
import sqlite3
import struct
import subprocess
import sys
import urllib.parse
import uuid

import database_continuity as continuity
import kept_lines
import live_database
import read_delta
import update_read
from update_read import (ACTIVITY_KEY, AUTH_INVARIANT_KEY, AUTHORITY_TABLES, CURSOR_COLUMNS, LOG_TABLES,
                         has_covering_index, has_rowid, is_projection_table, rowid_is_a_column, stream_column,
                         stream_key, table_columns, thread_digest, thread_line, valid_activity, virtual_tables)

WAL_HEADER_BYTES, FRAME_HEADER_BYTES = read_delta.WAL_HEADER_BYTES, read_delta.FRAME_HEADER_BYTES
INDEX_HEADER_BYTES = 136  # Two 48-byte copies of the WAL index header, then the checkpoint info.
INDEX_VERSION = 3007000
CHUNK_BYTES = 64 << 20
FREE, SCHEMA = '(free)', '(schema)'
TABLE_PAGES, INDEX_PAGES = (5, 13), (2, 10)
READER_START_SECONDS, READER_STOP_SECONDS = 30, 10
HOLD_SECONDS = 900  # A stop and clone that outlast it only cost the fast path: reader-lost, the full read decides.
REFERENCE_PREFIX = '.page-proof-'


class Refused(Exception):
    """The page proof cannot decide; its text is the receipt's reason."""


def keeping(database):
    """kept_lines.keeping for update.py's read before the restart: every log's lines are kept."""
    return kept_lines.keeping(database, LOG_TABLES)


# The old service's log, from right before the final check to the stop.

def _index_header(fd):
    """The WAL index header in -shm (both copies equal, initialised, checksum valid), else None."""
    data = os.pread(fd, INDEX_HEADER_BYTES, 0)
    if len(data) < INDEX_HEADER_BYTES or data[:48] != data[48:96]:
        return None
    version, _, change, initialised, big, size = struct.unpack_from('=IIIBBH', data, 0)
    if version != INDEX_VERSION or not initialised:
        return None
    if read_delta._checksum(data[:40], sys.byteorder == 'big') != struct.unpack_from('=II', data, 40):
        return None
    frames, pages = struct.unpack_from('=II', data, 16)
    return {'raw': data[:48], 'change': change, 'big': bool(big), 'pageSize': (size & 0xfe00) + ((size & 1) << 16),
            'mxFrame': frames, 'nPage': pages, 'frameChecksum': struct.unpack_from('=II', data, 24),
            'salt': data[32:40], 'nBackfill': struct.unpack_from('=I', data, 96)[0]}


def _log_header(fd):
    """(page size, salt bytes, big-endian checksums, header checksum) of a valid -wal header, else None."""
    data = os.pread(fd, WAL_HEADER_BYTES, 0)
    if len(data) < WAL_HEADER_BYTES:
        return None
    magic, version, page_size, _, _, _, sum1, sum2 = struct.unpack('>8I', data)
    if magic not in read_delta.WAL_MAGIC or version != read_delta.WAL_VERSION or not 512 <= page_size <= 65536 \
            or page_size & (page_size - 1):
        return None
    big = bool(magic & 1)
    if read_delta._checksum(data[:24], big) != (sum1, sum2):
        return None
    return page_size, data[16:24], big, (sum1, sum2)


def _chain(fd, page_size, salt, big, start, running):
    """[(page, commit size, running checksum)] of the valid frames after frame `start` (whose running
    checksum is `running`), validated as SQLite's recovery does: salts, then the cumulative checksum."""
    frames, frame_bytes = [], FRAME_HEADER_BYTES + page_size
    while True:
        data = os.pread(fd, frame_bytes, WAL_HEADER_BYTES + (start + len(frames)) * frame_bytes)
        if len(data) < frame_bytes:
            return frames
        page, size = struct.unpack_from('>II', data, 0)
        if page == 0 or data[8:16] != salt:
            return frames
        running = read_delta._checksum(data[FRAME_HEADER_BYTES:], big, *read_delta._checksum(data[:8], big, *running))
        if running != struct.unpack_from('>II', data, 16):
            return frames
        frames.append((page, size, running))


def _frame_page(fd, page_size, frame):
    return struct.unpack_from('>I', os.pread(fd, 4, WAL_HEADER_BYTES + (frame - 1) * (FRAME_HEADER_BYTES + page_size)))[0]


def _frame_data(fd, page_size, frame):
    return os.pread(fd, page_size, WAL_HEADER_BYTES + (frame - 1) * (FRAME_HEADER_BYTES + page_size) + FRAME_HEADER_BYTES)


class _Held:
    """A descriptor kept open on the old -wal; closed by `stopped` or when let go."""

    def __init__(self, fd):
        self.fd = fd

    def close(self):
        fd, self.fd = self.fd, None
        if fd is not None:
            os.close(fd)

    def __del__(self):
        self.close()


class _Reader:
    """A read transaction on the live database in a child process (`python3 after_proof.py hold`),
    from the mark until `stopped`. Its own process, so no descriptor this helper closes drops its
    locks. While it reads, no checkpoint copies a frame past its snapshot into the database file,
    the old service's last close cannot checkpoint and remove the log, and the log cannot restart,
    unless the snapshot read the database file alone (read mark 0, every frame already copied): then
    the first commit may restart it, and no later one can, as nothing is copied while it reads."""

    def __init__(self, process, snapshot):
        self.process, self.snapshot, self.answer = process, snapshot, None

    @classmethod
    def start(cls, database):
        """A reader holding its snapshot, else None."""
        try:
            process = subprocess.Popen([sys.executable, '-B', '-E', '-s', os.path.abspath(__file__), 'hold', database],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       text=True, close_fds=True)
        except OSError:
            return None
        reader = cls(process, None)
        line = reader.line(READER_START_SECONDS)
        try:
            snapshot = json.loads(line) if line else None
        except ValueError:
            snapshot = None
        if not isinstance(snapshot, dict) or 'mxFrame' not in snapshot:
            reader.release()
            return None
        snapshot['salt'] = bytes.fromhex(snapshot['salt'])
        snapshot['frameChecksum'] = tuple(snapshot['frameChecksum'])
        reader.snapshot = snapshot
        return reader

    def line(self, seconds):
        ready, _, _ = select.select([self.process.stdout], [], [], seconds)
        return self.process.stdout.readline().strip() if ready else ''

    def release(self):
        """True when the reader still held its snapshot when let go. Idempotent; never raises."""
        if self.answer is None:
            self.answer = False
            try:
                if self.process.poll() is None:
                    self.process.stdin.write('release\n')
                    self.process.stdin.flush()
                    self.answer = json.loads(self.line(READER_STOP_SECONDS) or '{}').get('held') is True
            except (OSError, ValueError, AttributeError):
                pass
            try:
                self.process.wait(timeout=READER_STOP_SECONDS)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            for stream in (self.process.stdin, self.process.stdout):
                try:
                    stream.close()
                except OSError:
                    pass
        return self.answer

    def __del__(self):
        self.release()


def _hold(database):
    """The child process of _Reader: opens a read transaction, prints the WAL index header of its
    snapshot, and keeps it until a line (or the end) on stdin, or HOLD_SECONDS. The descriptors on
    the database and -shm stay open to the end, so its SQLite locks stay too (live_database)."""
    signal.alarm(HOLD_SECONDS)  # A helper that hangs never pins the log for long.
    for suffix in ('', '-shm'):
        live_database.hold_probe(database + suffix)
    index_fd = live_database.held_probe(database + '-shm')
    for _ in range(5):  # The header must not move while the snapshot opens: it is that snapshot's.
        first = _index_header(index_fd)
        db = live_database.connect(database)
        db.execute('BEGIN')
        db.execute('SELECT count(*) FROM sqlite_master').fetchall()
        index = _index_header(index_fd)
        if first is not None and index is not None and first['raw'] == index['raw']:
            break
        db.close()
    else:
        return 1
    # With every frame copied into the file the snapshot may read the file alone (read mark 0).
    print(json.dumps({'mxFrame': index['mxFrame'], 'salt': index['salt'].hex(), 'pageSize': index['pageSize'],
                      'big': index['big'], 'nPage': index['nPage'], 'frameChecksum': list(index['frameChecksum']),
                      'fromFile': index['nBackfill'] == index['mxFrame']}), flush=True)
    sys.stdin.readline()
    held = db.in_transaction and all(live_database.held_probe(database + suffix) is not None for suffix in ('', '-shm'))
    print(json.dumps({'held': held}), flush=True)
    db.close()
    return 0


def mark(database, reader=True):
    """Taken right before update.py's final check, while the old service runs: a descriptor held on
    its -wal (so its frames stay readable after the service's last close removes the file), the
    generation's salts and the last frame of the snapshot after which the gap starts. With a
    _Reader (`reader`), that snapshot is the reader's and stays readable from the files through the
    stop (`stopped` builds it as the reference image when `confirm` showed it is the read before
    the restart). Without one, the last frame the index published (every read that starts later
    sees it; without the index, the second-to-last commit in the file, as read_delta reasons). None
    without a -wal: no proof after the restart."""
    database = os.path.abspath(str(database))
    try:
        fd = os.open(database + '-wal', os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    held, reading = _Held(fd), None
    try:
        reading = _Reader.start(database) if reader else None
        header = _log_header(fd)
        if header is None:
            held.close()
            if reading is not None:
                reading.release()
            return None
        page_size, salt, big, running = header
        if reading is not None:
            snapshot = reading.snapshot
            # A snapshot past frame 0 continues this file's generation, unless it read the file alone
            # and a restart followed: then every frame in the file is after it.
            if snapshot['pageSize'] in (0, page_size) and snapshot['big'] == big \
                    and (snapshot['salt'] == salt or snapshot['fromFile'] or not snapshot['mxFrame']):
                status, main = os.fstat(fd), os.stat(database)
                return {'database': database, 'held': held, 'wal': [status.st_dev, status.st_ino], 'pageSize': page_size,
                        'salt': snapshot['salt'], 'big': big, 'published': snapshot['mxFrame'],
                        'running': snapshot['frameChecksum'], 'main': [main.st_dev, main.st_ino],
                        'reader': reading, 'fromFile': snapshot['fromFile'], 'pages': snapshot['nPage'],
                        'confirmed': False}
            reading.release()
        # Read through the watermark's held probe only: opening -shm here and closing it would drop
        # this process's locks on it (live_database).
        probe = live_database.held_probe(database + '-shm')
        index = _index_header(probe) if probe is not None else None
        if index is not None and index['salt'] == salt and index['pageSize'] == page_size and index['big'] == big \
                and os.fstat(fd).st_size >= WAL_HEADER_BYTES + index['mxFrame'] * (FRAME_HEADER_BYTES + page_size):
            published = index['mxFrame']
            running = index['frameChecksum'] if published else running
        else:
            frames = _chain(fd, page_size, salt, big, 0, running)
            commits = [number for number, (_, size, _) in enumerate(frames, 1) if size]
            published = commits[-2] if len(commits) > 1 else 0
            running = frames[published - 1][2] if published else running
        status, main = os.fstat(fd), os.stat(database)
        return {'database': database, 'held': held, 'wal': [status.st_dev, status.st_ino], 'pageSize': page_size,
                'salt': salt, 'big': big, 'published': published, 'running': running,
                'main': [main.st_dev, main.st_ino]}
    except Exception:  # Never fails the update: no proof after the restart.
        held.close()
        if reading is not None:
            reading.release()
        return None


def confirm(marked, watermark, earlier, current):
    """After update.py's final check. `earlier` is the watermark taken with the read the proof starts
    from (base['before']), `current` the one that check ended on: the same object only when it read
    nothing again. When it is, and nothing committed from `earlier` until after the mark, the reader's
    snapshot holds exactly that read's rows and `stopped` may build it as the reference."""
    if isinstance(marked, dict) and 'reader' in marked:
        marked['confirmed'] = current is earlier and watermark.unchanged(earlier)


def release(marked):
    """Lets the mark's reader go (a failure before `stopped`). Idempotent; never raises."""
    reader = marked.get('reader') if isinstance(marked, dict) else None
    if reader is not None:
        reader.release()


def abandon(held):
    """update.py's failure path: the mark's reader and the reference image go. Never raises."""
    release(held)
    discard(held)


def discard(held):
    """Removes the reference image `stopped` built. Idempotent; never raises."""
    path = held.get('reference') if isinstance(held, dict) else None
    if path:
        with contextlib.suppress(OSError):
            os.unlink(path)


def stopped(marked, clone, method, clonefile=None):
    """Right after backup_state_clone, before the new release starts: what the proof needs from
    the stop, or {'reason'} when it cannot run. The old log must be the same generation (or, after a
    snapshot that read the file alone, its one restart); the frames it gained after the mark are the
    gap. Every page the old log holds must read in the clone as its last committed frame (the clone
    folds that log in), and when the -wal itself was cloned, the pages the database file held under
    it are recorded (hashes only).

    With the mark's reader: the reference image is built when `confirm` allowed it (the clone, cloned
    again with `clonefile`, its gap pages written back as the reader's snapshot holds them), the
    reader is let go, and the log the old service could not fold in on its last close is folded into
    the live database (_fold_live), so the new release starts as it does after a clean stop."""
    if not isinstance(marked, dict):
        return {'reason': 'no-log'}
    reader = marked.get('reader')
    try:
        if method != 'clone':
            result = {'reason': 'not-a-clone'}
        elif reader is not None:
            result = _stopped_held(marked, clone, clonefile)
        else:
            result = _stopped(marked, clone)
    except Exception as error:  # Never fails the update: the full read decides.
        result = {'reason': 'old-log-unreadable' if isinstance(error, (OSError, struct.error, IndexError))
                  else 'error:' + type(error).__name__}
    finally:
        marked['held'].close()
    if reader is None:
        return result
    if not reader.release():
        discard(result)
        result = {'reason': 'reader-lost'}  # The snapshot may not have held the log through the stop.
    folded = _fold_live(marked['database'])
    if folded is not None and 'clone' in result:
        if _folded_as_cloned(marked['database'], clone, marked['pageSize'], marked.get('logPages', ())):
            result.update(walPresent=False, mainUnder={}, main=folded)
        else:
            discard(result)
            result = {'reason': 'fold-differs'}
    return result


def _stopped(marked, clone):
    database, fd, page_size = marked['database'], marked['held'].fd, marked['pageSize']
    try:
        present = os.stat(database + '-wal')
    except FileNotFoundError:
        present = None
    if present is not None and [present.st_dev, present.st_ino] != marked['wal']:
        return {'reason': 'old-log-replaced'}
    header, latest = _log_header(fd), {}
    if header is None and os.fstat(fd).st_size == 0:
        gap = _truncated_gap(database, marked)
        if gap is None:
            return {'reason': 'old-log-reset'}
        present = None  # Checkpointed and emptied: the database file holds every frame.
    elif header is None or header[0] != page_size or header[1] != marked['salt']:
        return {'reason': 'old-log-reset'}
    else:
        tail = _chain(fd, page_size, marked['salt'], marked['big'], marked['published'], marked['running'])
        commits = [number for number, (_, size, _) in enumerate(tail, 1) if size]
        committed = marked['published'] + (commits[-1] if commits else 0)
        gap = sorted({page for page, _, _ in tail[:commits[-1]]}) if commits else []
        for frame in range(1, committed + 1):
            latest[_frame_page(fd, page_size, frame)] = frame
    return _checked(marked, clone, gap, latest, present is not None)


def _checked(marked, clone, gap, latest, present):
    """The record `stopped` returns, once the clone holds every committed frame of the old log."""
    database, fd, page_size = marked['database'], marked['held'].fd, marked['pageSize']
    main = read_delta._main_file(database)
    if main[:2] != marked['main']:
        return {'reason': 'database-replaced'}
    clone_fd = os.open(str(clone), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if _page_size(os.pread(clone_fd, 100, 0)) != page_size:
            return {'reason': 'page-size'}
        for page, frame in latest.items():
            if os.pread(clone_fd, page_size, (page - 1) * page_size) != _frame_data(fd, page_size, frame):
                return {'reason': 'clone-differs-from-old-log'}
    finally:
        os.close(clone_fd)
    under = {}
    if present:
        with open(database, 'rb') as handle:
            for page in latest:
                handle.seek((page - 1) * page_size)
                under[page] = hashlib.sha256(handle.read(page_size)).digest()
    return {'clone': str(clone), 'gap': gap, 'walPresent': present, 'mainUnder': under,
            'main': main, 'pageSize': page_size}


def _stopped_held(marked, clone, clonefile):
    """stopped with the reader: the log kept every frame since its snapshot (or restarted once after a
    snapshot that read the file alone), so the gap is every committed frame after it, and each gap
    page as the snapshot read it is its last frame up to the snapshot, else the database file's page
    (no checkpoint copied a later frame into the file while the reader read)."""
    database, fd, page_size = marked['database'], marked['held'].fd, marked['pageSize']
    try:
        present = os.stat(database + '-wal')
    except FileNotFoundError:
        return {'reason': 'old-log-reset'}
    if [present.st_dev, present.st_ino] != marked['wal']:
        return {'reason': 'old-log-replaced'}
    header = _log_header(fd)
    if header is None or header[0] != page_size or header[2] != marked['big']:
        return {'reason': 'old-log-reset'}
    published = marked['published']
    if published and header[1] == marked['salt']:
        start, running = published, marked['running']
    elif not published or marked['fromFile']:
        start, running = 0, header[3]  # Every frame in this generation is after the snapshot.
    else:
        return {'reason': 'old-log-reset'}
    tail = _chain(fd, page_size, header[1], header[2], start, running)
    commits = [number for number, (_, size, _) in enumerate(tail, 1) if size]
    committed = start + (commits[-1] if commits else 0)
    gap = sorted({page for page, _, _ in tail[:commits[-1]]}) if commits else []
    latest, snapshot = {}, {}
    for frame in range(1, committed + 1):
        page = _frame_page(fd, page_size, frame)
        latest[page] = frame
        if frame <= start:
            snapshot[page] = frame
    marked['logPages'] = sorted(latest)  # What _fold_live writes into the live file.
    result = _checked(marked, clone, gap, latest, True)
    if 'clone' in result and marked.get('confirmed') and clonefile is not None:
        try:
            result['reference'] = _reference_image(marked, clone, clonefile, gap, snapshot)
        except Refused as refusal:
            result['referenceRefused'] = str(refusal)
    return result


def _reference_image(marked, clone, clonefile, gap, snapshot):
    """The database as the reader's snapshot holds it, at a new path beside the backups: an APFS
    clone of the clone (no data written) with every gap page written back as the snapshot read it
    and the file cut to the snapshot's size. Raises Refused."""
    database, fd, page_size = marked['database'], marked['held'].fd, marked['pageSize']
    main_fd = os.open(database, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        pages = marked['pages'] or os.fstat(main_fd).st_size // page_size
        if not pages or pages * page_size > os.stat(str(clone)).st_size:
            raise Refused('reference-size')
        folder = os.path.dirname(os.path.dirname(os.path.abspath(str(clone))))
        _discard_stale_references(folder)
        path = os.path.join(folder, '%s%d-%s.sqlite' % (REFERENCE_PREFIX, os.getpid(), uuid.uuid4().hex))
        marked['reference'] = path  # update.py's failure path discards the mark until `stopped` returns.
        if clonefile(os.fsencode(os.path.abspath(str(clone))), os.fsencode(path), 0) != 0:
            raise Refused('reference-clone')
        try:
            out = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            try:
                for page in gap:
                    if page > pages:
                        continue  # Added after the snapshot.
                    data = (_frame_data(fd, page_size, snapshot[page]) if page in snapshot
                            else os.pread(main_fd, page_size, (page - 1) * page_size))
                    if len(data) != page_size or os.pwrite(out, data, (page - 1) * page_size) != page_size:
                        raise Refused('reference-write')
                os.ftruncate(out, pages * page_size)
                header = os.pread(out, 100, 0)
            finally:
                os.close(out)
            counter, size, valid_for = (struct.unpack_from('>I', header, offset)[0] for offset in (24, 28, 92))
            if counter == valid_for and size != pages:
                raise Refused('reference-size')
            return path
        except BaseException:
            discard(marked)
            raise
    finally:
        os.close(main_fd)


def _discard_stale_references(folder):
    """Reference images a helper that died left behind (its process gone)."""
    try:
        names = os.listdir(folder)
    except OSError:
        return
    for name in names:
        match = re.fullmatch(re.escape(REFERENCE_PREFIX) + r'([0-9]+)-[0-9a-f]{32}\.sqlite', name)
        if match is None or int(match.group(1)) == os.getpid():
            continue
        try:
            os.kill(int(match.group(1)), 0)
        except ProcessLookupError:
            with contextlib.suppress(OSError):
                os.unlink(os.path.join(folder, name))
        except OSError:
            pass


def _folded_as_cloned(database, clone, page_size, pages):
    """After _fold_live: the live file has the clone's size and, on every page the old log wrote, its
    content. A fold that trusted an index the log's last commit never reached (another connection
    kept the -shm through the stop) leaves the live file short of the clone, which folded the log
    alone. Nothing of this helper holds a lock on the live database here."""
    try:
        if os.stat(database).st_size != os.stat(str(clone)).st_size:
            return False
        live = os.open(database, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            cloned = os.open(str(clone), os.O_RDONLY | os.O_NOFOLLOW)
            try:
                return all(os.pread(live, page_size, (page - 1) * page_size)
                           == os.pread(cloned, page_size, (page - 1) * page_size) for page in pages)
            finally:
                os.close(cloned)
        finally:
            os.close(live)
    except OSError:
        return False


def _fold_live(database):
    """The old service could not fold its log into the database on its last close while the reader
    read; with the service stopped and the reader gone, this does what that close does: a
    TRUNCATE checkpoint, then the close of the last connection. Returns read_delta._main_file
    afterwards, or None (the new release then starts on the log, as after an unclean stop). Only
    while no service runs: update.py calls it between the clone and the restart."""
    try:
        uri = 'file:' + urllib.parse.quote(database, safe='/') + '?mode=rw'
        db = sqlite3.connect(uri, uri=True, timeout=0, isolation_level=None)
        try:
            if db.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
                return None
            busy = db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]
        finally:
            db.close()
        try:
            size = os.stat(database + '-wal').st_size
        except FileNotFoundError:
            size = 0
        return read_delta._main_file(database) if busy == 0 and size == 0 else None
    except (OSError, sqlite3.Error):
        return None


def _truncated_gap(database, marked):
    """The gap of an old log its last close checkpointed completely and truncated to zero bytes
    (SQLite builds that keep the -wal, such as Apple's): the pages of the frames after the mark, from
    the WAL index the close left (same generation, every frame backfilled), else None. Read after
    the service stopped; this process holds no connection then."""
    path = database + '-shm'
    probe = live_database.held_probe(path)
    fd = probe if probe is not None else os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        index = _index_header(fd)
        if index is None or index['salt'] != marked['salt'] or index['pageSize'] != marked['pageSize'] \
                or index['mxFrame'] < marked['published'] or index['nBackfill'] != index['mxFrame']:
            return None
        pages = set()
        for frame in range(marked['published'] + 1, index['mxFrame'] + 1):
            # The index's page-number array: 4062 entries after the header, then 4096 per 32 KiB block.
            block, slot = (0, frame - 1) if frame <= 4062 else divmod(frame - 4063, 4096)
            offset = INDEX_HEADER_BYTES + slot * 4 if frame <= 4062 else (block + 1) * 32768 + slot * 4
            pages.add(struct.unpack('=I', os.pread(fd, 4, offset))[0])
        return sorted(pages)
    finally:
        if probe is None:
            os.close(fd)


def _page_size(header):
    size = struct.unpack_from('>H', header, 16)[0]
    return 65536 if size == 1 else size


# The proof.

def decide(state, held, kept, reference, since, include_auth, progress, lap):
    """update.py's page proof between readinessCheap and readiness: (rows, auth, carried, capture)
    as update_read._read_state(state, include_auth, since, True) would return them now, or None for
    the full read. progress['afterProof'] gets the record; the 'pageProof' lap is booked when the
    proof ran. The kept lines are let go either way."""
    record = {'mode': 'full'}
    try:
        if not isinstance(held, dict) or 'clone' not in held:
            record['reason'] = held.get('reason', 'no-clone') if isinstance(held, dict) else 'no-clone'
            return None
        if kept is None or not kept.complete:
            record['reason'] = (kept.reason if kept is not None else None) or 'lines-not-kept'
            return None
        try:
            reads, record = prove(state, held, kept, reference, since, include_auth)
        except Refused as refusal:
            reads, record = None, {'mode': 'full', 'reason': str(refusal)}
        except Exception as error:  # Anything else the proof meets: the full read decides.
            reads, record = None, {'mode': 'full', 'reason': 'error:' + type(error).__name__}
        lap('pageProof')
        return reads
    finally:
        progress['afterProof'] = record
        if kept is not None:
            kept.clear()
        discard(held)


def prove(state, held, kept, reference, since, include_auth):
    """((rows, auth, carried, capture), record), or raises Refused (see the module docstring).
    `reference` is update.py's base['before']: {'reads': (rows, carried, capture), ...}."""
    rows, _, capture = reference['reads']
    proof = _Proof(os.path.abspath(str(pathlib.Path(state) / 'statev2.sqlite')), held, kept, rows, capture, since, include_auth)
    try:
        return proof.run()
    finally:
        proof.close()


def _varint(data, offset):
    value = 0
    for index in range(8):
        byte = data[offset + index]
        value = (value << 7) | (byte & 0x7f)
        if byte < 0x80:
            return value, offset + index + 1
    return (value << 8) | data[offset + 8], offset + 9


def _intervals(ranges):
    merged = []
    for low, high in sorted(ranges):
        if merged and low <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], high)
        else:
            merged.append([low, high])
    return merged


def _changed_rows(old, new):
    """(removed, added) [(rowid, values)]: rows of `old` not in `new` with the same typed cells, and back."""
    def differing(left, right):
        return [(rowid, values) for rowid, values in left.items()
                if rowid not in right or continuity.typed_line(right[rowid]) != continuity.typed_line(values)]
    return differing(old, new), differing(new, old)


class _Proof:
    def __init__(self, database, held, kept, rows, capture, since, include_auth):
        self.database, self.held, self.rows, self.capture = database, held, rows, capture
        self.since, self.include_auth = since, include_auth
        self.kept_tables = kept.tables
        self.reference = held.get('reference')  # The database as the read the proof starts from saw it.
        self.probes, self.db, self.clone_db, self.wal_fd, self.clone_fd, self.stop_fd = [], None, None, None, None, None
        self.cache, self.owners, self.overflow = {}, {'clone': {}, 'live': {}}, {'clone': set(), 'live': set()}
        self.leaves, self.ranges, self.kinds = {}, {}, {}
        self.explained = self.leaves_verified = 0

    def close(self):
        for connection in (self.db, self.clone_db):
            if connection is not None:
                connection.close()
        for fd in {self.wal_fd, self.clone_fd, self.stop_fd} - {None}:
            os.close(fd)
        for path in self.probes:  # Only after the connection: closing a probe drops its locks.
            live_database.release_probe(path)

    def run(self):
        self.open_live()
        try:
            update_read.assert_idle(self.db)
        except AssertionError:
            raise Refused('not-idle') from None
        self.open_clone()
        self.compare_main()
        self.check_schema()
        self.walk()
        touched = self.touched()
        reads = self.assemble(touched)
        if self.wal_fd is not None and os.pread(self.wal_fd, WAL_HEADER_BYTES, 0) != self.log_header:
            raise Refused('log-restarted')  # Frames read above may be another generation's.
        record = {'mode': 'pages', 'changedPages': len(self.changed | self.gap), 'walPages': len(self.frames),
                  'mainPagesExplained': self.explained, 'touchedTables': sorted(touched),
                  'reusedTables': len(self.tables) - len(touched), 'leavesVerified': self.leaves_verified,
                  'gapPages': len(self.gap), 'referenceImage': bool(self.reference)}
        return reads, record

    # Pages of the two versions.

    def open_live(self):
        for suffix in ('', '-shm'):
            try:
                live_database.hold_probe(self.database + suffix)
            except OSError:
                raise Refused('no-index') from None
            self.probes.append(self.database + suffix)
        self.main_fd, index_fd = (live_database.held_probe(self.database + suffix) for suffix in ('', '-shm'))
        if self.main_fd is None or index_fd is None:
            raise Refused('files-moved')
        for _ in range(5):  # The header must not move while the snapshot opens: it is that snapshot's.
            first = _index_header(index_fd)
            db = live_database.connect(self.database)
            db.execute('BEGIN')
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            index = _index_header(index_fd)
            if first is not None and index is not None and first['raw'] == index['raw']:
                break
            db.close()
        else:
            raise Refused('index-moving')
        self.db, self.tables, self.index = db, tables, index
        self.page_size = _page_size(os.pread(self.main_fd, 100, 0))
        if index['pageSize'] not in (0, self.page_size):  # 0: an index no commit has written yet.
            raise Refused('page-size')
        main_pages = os.fstat(self.main_fd).st_size // self.page_size
        self.pages = index['nPage'] or main_pages
        if db.execute('PRAGMA page_count').fetchone()[0] != self.pages:
            raise Refused('index-differs')
        self.frames, self.log_header = {}, None
        if index['mxFrame']:
            self.wal_fd = os.open(self.database + '-wal', os.O_RDONLY | os.O_NOFOLLOW)
            self.log_header = os.pread(self.wal_fd, WAL_HEADER_BYTES, 0)
            header = _log_header(self.wal_fd)
            if header is None or header[0] != self.page_size or header[1] != index['salt']:
                raise Refused('log-generation')
            frame_bytes, size = FRAME_HEADER_BYTES + self.page_size, None
            for frame in range(1, index['mxFrame'] + 1):
                head = os.pread(self.wal_fd, FRAME_HEADER_BYTES, WAL_HEADER_BYTES + (frame - 1) * frame_bytes)
                if len(head) < FRAME_HEADER_BYTES or head[8:16] != index['salt']:
                    raise Refused('log-generation')
                page, size = struct.unpack_from('>II', head, 0)
                self.frames.setdefault(page, []).append(frame)
            if size != self.pages:
                raise Refused('log-generation')
        for page in range(main_pages + 1, self.pages + 1):
            if page not in self.frames:
                raise Refused('page-beyond-file')

    def open_clone(self):
        """The clone (the database at the stop, `stop_*`) and the old version the proof compares the
        live database with (`clone_*`): the reference image when there is one, else the clone."""
        self.stop_fd, self.stop_pages, header = self.open_version(self.held['clone'])
        if self.held['pageSize'] != self.page_size:
            raise Refused('page-size')
        self.usable = self.page_size - header[20]
        if self.reference:
            self.clone_fd, self.clone_pages, reference = self.open_version(self.reference)
            if reference[20] != header[20] or self.clone_pages > self.stop_pages:
                raise Refused('reference-size')
        else:
            self.clone_fd, self.clone_pages = self.stop_fd, self.stop_pages
        if self.pages < self.stop_pages:
            raise Refused('database-shrank')
        old = self.reference or self.held['clone']
        self.clone_db = sqlite3.connect('file:' + urllib.parse.quote(os.path.abspath(old), safe='/') + '?mode=ro&immutable=1',
                                        uri=True)
        self.clone_db.execute('PRAGMA query_only=ON')

    def open_version(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            header = os.pread(fd, 100, 0)
            if _page_size(header) != self.page_size:
                raise Refused('page-size')
            size = os.fstat(fd).st_size
            if size % self.page_size:
                raise Refused('clone-size')
        except BaseException:
            os.close(fd)
            raise
        return fd, size // self.page_size, header

    def live_page(self, number):
        frames = self.frames.get(number)
        if frames:
            data = _frame_data(self.wal_fd, self.page_size, frames[-1])
        else:
            data = os.pread(self.main_fd, self.page_size, (number - 1) * self.page_size)
        if len(data) != self.page_size:
            raise Refused('short-read')
        return data

    def clone_page(self, number, fd=None):
        data = os.pread(self.clone_fd if fd is None else fd, self.page_size, (number - 1) * self.page_size)
        if len(data) != self.page_size:
            raise Refused('short-read')
        return data

    def stop_page(self, number):
        return self.clone_page(number, self.stop_fd)

    def page(self, version, number):
        if not 1 <= number <= (self.pages if version == 'live' else self.clone_pages):
            raise Refused('page-outside-database')
        if version == 'live':
            return self.live_page(number) if number in self.live_changed else self.stop_page(number)
        return self.clone_page(number)

    def compare_main(self):
        """The changed pages; every page of the database file that differs from the clone explained."""
        quick = not self.held['walPresent'] and read_delta._main_file(self.database) == self.held['main']
        if not quick:
            limit = min(self.pages, self.stop_pages, os.fstat(self.main_fd).st_size // self.page_size) * self.page_size
            for offset in range(0, limit, CHUNK_BYTES):
                length = min(CHUNK_BYTES, limit - offset)
                main, clone = os.pread(self.main_fd, length, offset), os.pread(self.stop_fd, length, offset)
                if len(main) != length or len(clone) != length:
                    raise Refused('short-read')
                if main == clone:
                    continue
                for start in range(0, length, self.page_size):
                    data = main[start:start + self.page_size]
                    if data != clone[start:start + self.page_size]:
                        self.explain((offset + start) // self.page_size + 1, data)
        for number in range(self.stop_pages + 1, self.pages + 1):
            if number not in self.frames:
                raise Refused('main-page-unexplained')  # The file grew past the clone without the log.
        self.live_changed = set()
        for number in self.frames:
            if number <= self.pages and (number > self.stop_pages or self.live_page(number) != self.stop_page(number)):
                self.live_changed.add(number)
        self.gap = set(self.held['gap'])
        # With the reference image the gap pages are changed pages like any other: their old version
        # is readable. Without it they are only known to differ from the clone somewhere.
        self.changed = self.live_changed | self.gap if self.reference else self.live_changed
        self.paged = self.changed | self.gap

    def explain(self, number, data):
        frames = self.frames.get(number)
        if not frames:
            raise Refused('main-page-unexplained')
        if any(_frame_data(self.wal_fd, self.page_size, frame) == data for frame in frames) \
                or self.held['mainUnder'].get(number) == hashlib.sha256(data).digest():
            self.explained += 1
            return
        raise Refused('main-page-unexplained')

    # The schema and every b-tree's pages.

    def check_schema(self):
        for table in self.tables:
            if not re.fullmatch('[a-z0-9_]+', table):
                raise Refused('table-name')
        if virtual_tables(self.db, self.tables):
            raise Refused('virtual-table')
        query = 'SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name'
        self.master = [tuple(row) for row in self.db.execute(query)]
        if self.master != [tuple(row) for row in self.clone_db.execute(query)]:
            raise Refused('schema')
        self.structure = continuity.schema(self.db)
        if continuity.encoded(self.structure) != continuity.encoded(self.capture['schema']):
            raise Refused('schema')
        if 1 in self.gap and not self.reference:
            raise Refused('gap-touches-schema')  # A commit in the gap that grew the file or changed the schema.
        live, clone = (self.page(version, 1) for version in ('live', 'clone'))
        if live[:24] != clone[:24] or live[40:92] != clone[40:92] or live[100:] != clone[100:]:
            raise Refused('schema')
        if struct.unpack_from('>I', clone, 52)[0]:
            raise Refused('auto-vacuum')  # Pointer-map pages belong to no tree.

    def node(self, version, number):
        """(kind, children or None) of a b-tree page; one read for both versions when unchanged."""
        key = (version, number) if number in self.changed else number
        value = self.cache.get(key)
        if value is None:
            page = self.page(version, number)
            offset = 100 if number == 1 else 0
            kind = page[offset]
            if kind not in TABLE_PAGES + INDEX_PAGES:
                raise Refused('not-a-tree-page')
            children = None
            if kind in (2, 5):
                cells = struct.unpack_from('>H', page, offset + 3)[0]
                pointers = struct.unpack_from('>%dH' % cells, page, offset + 12)
                children = [int.from_bytes(page[pointer:pointer + 4], 'big') for pointer in pointers]
                children.append(struct.unpack_from('>I', page, offset + 8)[0])
            value = self.cache[key] = (kind, children)
        return value

    def tree(self, version, root):
        """(interior pages, leaves) of the tree at `root`, reading interior pages only: the depth comes
        from the leftmost path, as every leaf of a SQLite b-tree sits at the same depth."""
        kind, children = self.node(version, root)
        family = TABLE_PAGES if kind in TABLE_PAGES else INDEX_PAGES
        depth, number = 0, root
        while children is not None:
            depth += 1
            if depth > 40:
                raise Refused('tree-depth')
            number = children[0]
            kind, children = self.node(version, number)
            if kind not in family:
                raise Refused('tree-kind')
        interior, level = [], [root]
        for _ in range(depth):
            below = []
            for number in level:
                kind, children = self.node(version, number)
                if kind != family[0]:
                    raise Refused('tree-depth')
                interior.append(number)
                below.extend(children)
            level = below
        return interior, level, family

    def claim(self, version, number, owner, overflow=False):
        """`owner` (a tree, or FREE) holds a changed or gap page in `version`; twice is corruption."""
        if number not in self.paged:
            return
        if number in self.owners[version]:
            raise Refused('page-owned-twice')
        self.owners[version][number] = owner
        if overflow:
            self.overflow[version].add(number)

    def walk(self):
        self.trees = [(SCHEMA, 1, 'table', SCHEMA)] + [(name, root, kind, table) for kind, name, table, root, _ in self.master
                                                       if kind in ('table', 'index') and root]
        self.tree_table = {name: table if kind == 'index' else name for name, _, kind, table in self.trees}
        self.tree_kind = {name: kind for name, _, kind, _ in self.trees}
        for version in ('clone', 'live'):
            for name, root, _, _ in self.trees:
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
                if owner is not None and owner != FREE and number not in self.overflow[version]:
                    self.cells(version, number, owner)

    def freelist(self, version):
        trunk, total = struct.unpack_from('>II', self.page(version, 1), 32)
        seen = 0
        while trunk:
            self.claim(version, trunk, FREE)
            page = self.page(version, trunk)
            trunk, count = struct.unpack_from('>II', page, 0)
            if count > self.usable // 4 - 2:
                raise Refused('freelist')
            for leaf in struct.unpack_from('>%dI' % count, page, 8):
                self.claim(version, leaf, FREE)
            seen += 1 + count
            if seen > total:
                raise Refused('freelist')
        if seen != total:
            raise Refused('freelist')

    def cells(self, version, number, owner):
        """Overflow chains of a changed b-tree page's cells, claimed for its tree; a leaf's rowid range."""
        page = self.page(version, number)
        offset = 100 if number == 1 else 0
        kind = page[offset]
        if kind not in self.kinds[owner]:
            raise Refused('tree-kind')
        if kind == 5:
            return
        cells = struct.unpack_from('>H', page, offset + 3)[0]
        rowids = []
        for pointer in struct.unpack_from('>%dH' % cells, page, offset + (12 if kind == 2 else 8)):
            position = pointer + (4 if kind == 2 else 0)
            payload, position = _varint(page, position)
            if kind == 13:
                rowid, position = _varint(page, position)
                rowids.append(rowid - (1 << 64) if rowid >= 1 << 63 else rowid)
                limit = self.usable - 35
            else:
                limit = (self.usable - 12) * 64 // 255 - 23
            if payload <= limit:
                continue
            least = (self.usable - 12) * 32 // 255 - 23
            local = least + (payload - least) % (self.usable - 4)
            if local > limit:
                local = least
            link = struct.unpack_from('>I', page, position + local)[0]
            for _ in range(-(-(payload - local) // (self.usable - 4))):
                if not link:
                    raise Refused('overflow-chain')
                self.claim(version, link, owner, overflow=True)
                link = struct.unpack_from('>I', self.page(version, link), 0)[0]
            if link:
                raise Refused('overflow-chain')
        if rowids and number in self.changed:
            self.ranges.setdefault(owner, []).append((min(rowids), max(rowids)))

    def touched(self):
        """The tables a changed or gap page belongs to, after every refusal of step 2."""
        for number in self.paged:
            if number != 1 and not (self.owners['clone'].get(number) or (number in self.changed and self.owners['live'].get(number))):
                raise Refused('unowned-page')
        tables, indexed, self.gap_tables = set(), set(), set()
        for version, pages in (('clone', self.paged), ('live', self.changed)):
            for number in pages:
                owner = self.owners[version].get(number)
                if owner in (None, FREE):
                    continue
                if owner == SCHEMA and number != 1:
                    raise Refused('schema')
                if owner == SCHEMA:
                    continue
                # A page freed by one table and reused by another (an overflow chain a rewritten row
                # gave up, taken by an appended event) is changed in both: each table's own changed
                # pages put the rows on it in that table's comparison, so both are read as touched.
                (indexed if self.tree_kind[owner] == 'index' else tables).add(self.tree_table[owner])
                if version == 'clone' and number in self.gap and not self.reference:
                    self.gap_tables.add(self.tree_table[owner])
        if indexed - tables:
            raise Refused('index-only')
        return tables

    # The reads a full read would return.

    def assemble(self, touched):
        db, tables = self.db, self.tables
        summary, legacy_reference = self.capture['summary'], self.capture['legacy']
        kept = {table: entry for table, entry in self.kept_tables.items()
                if set(entry) == {'typed', 'legacy'} and table in summary['tables']
                and summary['tables'][table] == {'count': entry['typed']['count'], 'sha256': entry['typed']['sha256']}
                and legacy_reference[table] == {'count': entry['legacy']['count'], 'sha256': entry['legacy']['sha256']}}
        reference_activity = self.rows[ACTIVITY_KEY]
        threads = []
        for table in tables:
            columns = table_columns(db, table)
            key = stream_column(columns)
            if is_projection_table(table) and key and table not in CURSOR_COLUMNS:
                threads.append((table, key, columns.index(key)))
        thread_names = {table for table, _, _ in threads}
        typed, legacy, streams, sequences = {}, {}, set(), None
        for table in sorted(touched):
            if table in self.gap_tables and (table in kept or table in LOG_TABLES or table in thread_names):
                raise Refused('gap-touches-' + ('log' if table in LOG_TABLES else 'kept' if table in kept else 'stream'))
            if table in LOG_TABLES and (table not in kept or not self.rowid_table(table) or has_covering_index(db, table)):
                raise Refused('log-not-kept')
            if table in kept and table != 'sqlite_sequence' and table not in self.gap_tables and self.rowid_table(table):
                typed[table], legacy[table], changed = self.delta(table, kept[table], reference_activity['logRowids'].get(table))
            else:
                rows, changed = self.reread(table, table in thread_names)
                typed[table] = {'count': len(rows), 'sha256': continuity.typed_rows_hash(rows)}
                legacy[table] = {'count': len(rows), 'sha256': continuity.legacy_rows_hash(rows)}
                if table == 'sqlite_sequence':
                    sequences = sorted([list(row) for row in rows], key=continuity.encoded)
            if table in thread_names:
                index = next(index for name, _, index in threads if name == table)
                streams.update(stream_key(values[index]) for _, values in changed)
        thread_hashes = self.stream_hashes(threads, streams, reference_activity['threadSha256'])
        typed_entries = {table: typed.get(table) or copy.deepcopy(summary['tables'][table]) for table in self.structure['columns']}
        legacy_entries = {table: legacy.get(table) or copy.deepcopy(legacy_reference[table]) for table in self.structure['columns']}
        thread_ids = {row[0] for row in db.execute('SELECT thread_id FROM projection_threads')}
        if 'orchestration_v2_projection_threads' in tables:
            thread_ids.update(row[0] for row in db.execute('SELECT thread_id FROM orchestration_v2_projection_threads'))
        guarded = [table for table in tables
                   if table.startswith(('projection_', 'orchestration_', 'project_')) or table in AUTHORITY_TABLES]
        rows = {'projectIds': sorted(row[0] for row in db.execute('SELECT project_id FROM projection_projects')),
                'threadIds': sorted(thread_ids),
                'counts': {table: legacy_entries[table]['count'] for table in guarded},
                'hashes': {table: legacy_entries[table]['sha256'] for table in guarded}, 'nativeWorkIdle': True}
        if 'auth_sessions' in tables:
            rows[AUTH_INVARIANT_KEY] = update_read.auth_invariant_hash(db)
        rows[ACTIVITY_KEY] = {'logRowids': update_read.log_rowids(db, tables), 'threadTables': sorted(thread_names),
                              'threadSha256': thread_hashes,
                              'cursorSha256': update_read.cursor_hashes(db, tables, lambda table: db.execute('SELECT * FROM ' + table))}
        auth = (update_read.read_auth_sessions_in_transaction(db, rows)
                if self.include_auth and 'auth_sessions' in tables else None)
        carried = update_read.carried_since(db, tables, self.since, self.prefixes(typed_entries, legacy_entries, reference_activity))
        database_summary = {'schemaSha256': continuity.digest(continuity.encoded(self.structure)), 'tables': typed_entries}
        if 'sqlite_sequence' in self.structure['columns']:
            database_summary['sqliteSequence'] = sequences if sequences is not None else copy.deepcopy(summary['sqliteSequence'])
        capture = {'schema': self.structure, 'summary': database_summary, 'legacy': legacy_entries}
        continuity.bind_rows(capture, rows)
        return rows, auth, carried, capture

    def rowid_table(self, table):
        return has_rowid(self.db, table) and not rowid_is_a_column(self.db, table)

    def prefixes(self, typed_entries, legacy_entries, reference_activity):
        """carried_since's earlier-row hashes: each log ended where `since` says, so its earlier rows
        are all of the reference's rows, which `delta` showed unchanged."""
        activity = self.since.get(ACTIVITY_KEY) if isinstance(self.since, dict) else None
        if not valid_activity(activity):
            return None
        prefixes = {}
        for table, boundary in activity['logRowids'].items():
            if table not in self.tables or not has_rowid(self.db, table):
                continue
            if reference_activity['logRowids'].get(table) != boundary or rowid_is_a_column(self.db, table) \
                    or has_covering_index(self.db, table):
                raise Refused('log-boundary')
            prefixes[table] = {'boundary': boundary, 'legacy': copy.deepcopy(self.capture['legacy'][table]),
                               'typed': copy.deepcopy(self.capture['summary']['tables'][table])}
        return prefixes

    def delta(self, table, kept, boundary):
        """(typed, legacy, changed rows) of a touched kept table: the clone's and the live rows over
        the rowid ranges of its changed leaves; every other leaf is the same page in both trees."""
        changed_leaves = [set(self.leaves[version, table]) & self.changed for version in ('clone', 'live')]
        if set(self.leaves['clone', table]) - self.changed != set(self.leaves['live', table]) - self.changed:
            raise Refused('leaf-sets')
        self.leaves_verified += len(changed_leaves[0]) + len(changed_leaves[1])
        old, new = {}, {}
        query = 'SELECT rowid, * FROM ' + table + ' WHERE rowid BETWEEN ? AND ?'
        for low, high in _intervals(self.ranges.get(table, [])):
            old.update((row[0], row[1:]) for row in self.clone_db.execute(query, (low, high)))
            new.update((row[0], row[1:]) for row in self.db.execute(query, (low, high)))
        removed, added = _changed_rows(old, new)
        if table in LOG_TABLES and (removed or any(rowid <= boundary for rowid, _ in added)):
            raise Refused('old-log-row-changed')
        typed = kept_lines.merged_digest(kept['typed'], [continuity.typed_line(values) for _, values in removed],
                                         [continuity.typed_line(values) for _, values in added])
        legacy = kept_lines.merged_digest(kept['legacy'], [continuity.legacy_line(values) for _, values in removed],
                                          [continuity.legacy_line(values) for _, values in added])
        if typed is None or legacy is None:
            raise Refused('kept-lines-differ')
        return typed, legacy, removed + added

    def reread(self, table, stream_rows):
        """(rows, changed rows) of a touched table read again; its changed rows against the clone
        only for a projection keyed by stream (a rowid table, or the proof refuses)."""
        if not stream_rows:
            return list(self.db.execute('SELECT * FROM ' + table)), []
        if not self.rowid_table(table):
            raise Refused('stream-table-shape')
        query = 'SELECT rowid, * FROM ' + table
        new = {row[0]: row[1:] for row in self.db.execute(query)}
        removed, added = _changed_rows({row[0]: row[1:] for row in self.clone_db.execute(query)}, new)
        return list(new.values()), removed + added

    def stream_hashes(self, threads, streams, reference):
        """The reference's stream hashes, in their order, with every stream whose rows changed hashed
        again from all its projection rows. Its first row (table, rowid) must stay where it was, so
        the order a full scan meets the streams in is the same."""
        hashes = dict(reference)
        if not streams:
            return hashes
        for table, _, _ in threads:
            plan = [row[-1] for row in self.db.execute('EXPLAIN QUERY PLAN SELECT * FROM ' + table)]
            if not self.rowid_table(table) or plan not in (['SCAN ' + table], ['SCAN TABLE ' + table]):
                raise Refused('stream-order')
        for key in sorted(streams):
            if key.startswith('#') or key not in hashes:
                raise Refused('stream-key' if key.startswith('#') else 'new-stream')
            if self.first_row(self.clone_db, threads, key) != self.first_row(self.db, threads, key):
                raise Refused('stream-order')
            lines = [thread_line(table, row) for table, column, index in threads
                     for row in self.db.execute('SELECT * FROM ' + table + ' WHERE ' + column + ' = ?', (key,))
                     if stream_key(row[index]) == key]
            if not lines:
                raise Refused('stream-gone')
            hashes[key] = thread_digest(lines)
        return hashes

    @staticmethod
    def first_row(db, threads, key):
        for position, (table, column, _) in enumerate(threads):
            rowids = [rowid for rowid, value in db.execute(
                'SELECT rowid, ' + column + ' FROM ' + table + ' WHERE ' + column + ' = ?', (key,)) if stream_key(value) == key]
            if rowids:
                return position, min(rowids)
        return None



if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'hold':
        sys.exit(_hold(os.path.abspath(sys.argv[2])))
    sys.exit('usage: after_proof.py hold <database>')
