"""The before read's sorted lines of the largest tables, kept for the page proof after the restart.

The full read hashes each table as SHA-256 of its rows' lines, sorted and joined with newlines
(database_continuity.typed_rows_hash and legacy_rows_hash). After the restart the new service has
appended a few dozen rows to logs of a million rows; to hash such a table exactly again without
reading it, after_proof needs the before read's sorted lines and the hash state at points along
them. Inside `keeping(database)`, the next complete read (update_read._read_state, single scan)
hands over both sorted line lists (typed and legacy) of every log table and of every table whose
typed lines take KEEP_BYTES or more, with a copy of the SHA-256 state every MARK_EVERY lines. The
hashes it publishes are the ones a read without it computes; a read outside the context runs as
before and keeps nothing.

Memory first, then disk. The kept lines take about 1.2 times the database file (M4, October 2026:
26.7 GB of lines for a 21.9 GB file, 20 GB of them orchestration_events; 39 GB peak for the whole
read), and a memory floor of three times the database left the proof unused on M4's 1.0.89
install. The lines stay in memory while the system keeps headroom() available (macOS: free,
speculative, purgeable and file-backed pages; Linux: MemAvailable) with room for the table's
legacy lines, which the read builds after its typed ones; that is checked as each table is kept.
When it is not, at the start or during the read, each kept list is written once, as the exact
bytes it hashes ('\\n'.join(lines).encode()), to a file in a scratch folder inside the service's
`updates` folder (the database's volume), with the byte offset of every line (8 bytes a line) in
memory, and lines already kept move there too. Disk is used only when that volume has
DISK_FLOOR_FACTOR times the database file plus DISK_FLOOR_MARGIN free, plus what the update still
needs after the read (its pre-update backup). Without either, nothing is kept and the proof after
the restart falls back to the full read; its record names the numbers. The factor is not a bound
(BLOBs are hex, JSON escapes text): a write that fails during the read lets go of every kept file,
the read goes on hashing only, and the proof falls back with `disk-full`. The folder goes with
clear(), when the Kept is collected, and on the next start after a helper that died with it.
Stdlib only.
"""
import array
import bisect
import contextlib
import contextvars
import ctypes
import errno
import hashlib
import itertools
import os
import pathlib
import shutil
import sys
import tempfile
import weakref

KEEP_BYTES = 8 << 20
MARK_EVERY = 1 << 14
DISK_FLOOR_FACTOR = 2  # The typed and the legacy lines of the kept tables, each at most about the file.
DISK_FLOOR_MARGIN = 4 << 30
SCRATCH_PREFIX = 'kept-lines-'
# Left available while lines are kept in memory: the larger of HEADROOM_BYTES and one HEADROOM_SHARE
# of the physical memory, for the restarted service and what the user runs meanwhile.
HEADROOM_BYTES = 8 << 30
HEADROOM_SHARE = 8
_ACTIVE = contextvars.ContextVar('kept_lines', default=None)
_RESIDENT = weakref.WeakSet()  # Kepts holding lines in memory, for make_room().


def _sysctl(name):
    value, size = ctypes.c_uint64(0), ctypes.c_size_t(8)
    function = ctypes.CDLL(None, use_errno=True).sysctlbyname
    if function(name.encode(), ctypes.byref(value), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        raise OSError(ctypes.get_errno(), name)
    return value.value


def _meminfo(key):
    with open('/proc/meminfo') as handle:
        for line in handle:
            if line.startswith(key + ':'):
                return int(line.split()[1]) * 1024
    return None


def available_memory():
    """Bytes the system can hand out without swapping, or None when it cannot tell."""
    try:
        if sys.platform == 'darwin':
            pages = sum(_sysctl('vm.' + name) for name in (
                'page_free_count', 'page_speculative_count', 'page_purgeable_count', 'page_pageable_external_count'))
            return pages * _sysctl('vm.pagesize')
        return _meminfo('MemAvailable')
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def physical_memory():
    """Bytes of physical memory, or None when it cannot tell."""
    try:
        return _sysctl('hw.memsize') if sys.platform == 'darwin' else _meminfo('MemTotal')
    except (OSError, ValueError, AttributeError, TypeError):
        return None


def headroom():
    """Bytes that must stay available while lines are kept in memory."""
    return max(HEADROOM_BYTES, (physical_memory() or 0) // HEADROOM_SHARE)


def memory_room(need=0):
    """Whether `need` more bytes still leave headroom() available; False when it cannot tell."""
    available = available_memory()
    return available is not None and available >= headroom() + need


def scratch_parent(database):
    """Where kept lines go: the service's `updates` folder beside its `userdata`, on the database's
    volume; the system's temporary folder for a database outside such a home (tests)."""
    updates = pathlib.Path(database).parent.parent / 'updates'
    return updates if updates.is_dir() else pathlib.Path(tempfile.gettempdir())


def disk_floor(database_bytes):
    return DISK_FLOOR_FACTOR * database_bytes + DISK_FLOOR_MARGIN


def available_disk(folder):
    """Free bytes on `folder`'s volume, or None when it cannot tell."""
    try:
        stat = os.statvfs(str(folder))
        return stat.f_bavail * stat.f_frsize
    except OSError:
        return None


def _running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:  # Someone else's process: running.
        return True
    return True


def remove_stale(parent):
    """Scratch folders a helper that is no longer running left behind."""
    try:
        entries = list(pathlib.Path(parent).iterdir())
    except OSError:
        return
    for entry in entries:
        pid = entry.name[len(SCRATCH_PREFIX):].split('-', 1)[0]
        if entry.name.startswith(SCRATCH_PREFIX) and pid.isdigit() and int(pid) != os.getpid() \
                and not _running(int(pid)) and entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)


class FileLines:
    """Sorted lines kept as '\\n'.join(lines).encode() in a file. len, an index and a slice read
    them back as str, so bisect runs on it as on the list; `chunks(a, b)` yields the bytes of
    '\\n'.join(lines[a:b]).encode() straight from the file. Read with pread, not a map: a disk
    error is then an OSError the proof falls back on, not a SIGBUS that kills the helper."""

    def __init__(self, path, starts, size):
        self.path, self.starts, self.size = path, starts, size  # Byte offset of every line; file length.
        self.fd = os.open(path, os.O_RDONLY)

    def _read(self, start, end):
        data = os.pread(self.fd, end - start, start)
        if len(data) != end - start:
            raise OSError(errno.EIO, 'Kept lines file is shorter than written', self.path)
        return data

    def __len__(self):
        return len(self.starts)

    def _end(self, index):
        """Where line `index` ends, before its separator."""
        return self.starts[index + 1] - 1 if index + 1 < len(self.starts) else self.size

    def __getitem__(self, index):
        if isinstance(index, slice):
            return [self[at] for at in range(*index.indices(len(self)))]
        if index < 0:
            index += len(self)
        if not 0 <= index < len(self):
            raise IndexError(index)
        return self._read(self.starts[index], self._end(index)).decode()

    def chunks(self, start, stop, size=1 << 20):
        if start >= stop:
            return
        position, end = self.starts[start], self._end(stop - 1)
        while position < end:
            yield self._read(position, min(position + size, end))
            position += size

    def close(self):
        with contextlib.suppress(OSError):
            os.close(self.fd)
        with contextlib.suppress(OSError):
            os.unlink(self.path)


def marked_digest(lines, every=MARK_EVERY, folder=None, limit=None):
    """(digest('\\n'.join(lines)), marks): the same hex digest as database_continuity.joined_digest,
    and [(index, hasher)] with the SHA-256 state of '\\n'.join(lines[:index]) at every `every`
    lines, so a list changed from some line on is hashed again from the mark before it. With
    `folder`, a third value: the lines written to a file there (FileLines), or [] for no lines;
    OSError(ENOSPC) before the file would pass `limit` bytes."""
    hasher, marks = hashlib.sha256(), []
    handle = tempfile.NamedTemporaryFile(dir=str(folder), prefix='lines-', delete=False) \
        if folder is not None and lines else None
    starts, offset = array.array('q'), 0
    try:
        for start in range(0, len(lines), every):
            marks.append((start, hasher.copy()))
            encoded = [line.encode() for line in lines[start:start + every]]
            run = b'\n'.join(encoded)
            if start:
                run = b'\n' + run
            if handle is not None:
                # Each line starts one separator after the previous one ends; no separator after the
                # run's last line, and the next run begins with one.
                ends = list(itertools.accumulate(map((1).__add__, map(len, encoded)), initial=offset + (1 if start else 0)))
                starts.fromlist(ends[:-1])
                offset = ends[-1] - 1
                if limit is not None and offset > limit:
                    raise OSError(errno.ENOSPC, 'Kept lines would leave less than the disk margin free')
                handle.write(run)
            hasher.update(run)
    finally:
        if handle is not None:
            handle.close()
    if not marks:
        marks.append((0, hasher.copy()))
    if folder is None:
        return hasher.hexdigest(), marks
    if handle is None:
        return hasher.hexdigest(), marks, []
    if offset == 0:  # [''] alone: no bytes to map, and nothing to keep but the list itself.
        os.unlink(handle.name)
        return hasher.hexdigest(), marks, list(lines)
    return hasher.hexdigest(), marks, FileLines(handle.name, starts, offset)


def _removals(lines, removed, low):
    """Indexes in `lines` (sorted) of one occurrence each of `removed`, at or after `low`; None
    when one is missing."""
    taken, indexes = {}, []
    for line in sorted(removed):
        index = bisect.bisect_left(lines, line, low) + taken.get(line, 0)
        if index >= len(lines) or lines[index] != line:
            return None
        taken[line] = taken.get(line, 0) + 1
        indexes.append(index)
    return indexes


def merged_digest(kept, removed, added, every=MARK_EVERY):
    """{count, sha256} of the kept lines without `removed` and with `added`, hashed as
    joined_digest hashes the sorted result; None when a removed line is not among them. Only the
    lines from the mark before the first change on are hashed again."""
    lines, marks = kept['lines'], kept['marks']
    if not removed and not added:
        return {'count': len(lines), 'sha256': kept['sha256']}
    added = sorted(added)
    first = min([bisect.bisect_left(lines, line) for line in list(removed) + added[:1]])
    start, hasher = marks[max(0, bisect.bisect_right([index for index, _ in marks], first) - 1)]
    hasher = hasher.copy()
    skipped = _removals(lines, removed, start)
    if skipped is None:
        return None
    skipped = set(skipped)
    inserts = [(bisect.bisect_left(lines, line, start), line) for line in added]
    written = [start > 0]  # Whether a line came before: the next one needs its newline.

    def feed(run):
        for offset in range(0, len(run), every):
            if written[0]:
                hasher.update(b'\n')
            hasher.update('\n'.join(run[offset:offset + every]).encode())
            written[0] = True

    def feed_kept(low, high):
        """lines[low:high], read from the file when they were written to one."""
        if not isinstance(lines, FileLines):
            return feed(lines[low:high])
        if low >= high:
            return
        if written[0]:
            hasher.update(b'\n')
        for chunk in lines.chunks(low, high):  # None for a run of one empty line.
            hasher.update(chunk)
        written[0] = True

    position, pending = start, 0
    for cut in sorted(skipped | {index for index, _ in inserts} | {len(lines)}):
        feed_kept(position, cut)
        while pending < len(inserts) and inserts[pending][0] == cut:
            feed([inserts[pending][1]])
            pending += 1
        position = cut + 1 if cut in skipped else cut
    return {'count': len(lines) - len(removed) + len(added), 'sha256': hasher.hexdigest()}


def _close(entry):
    for record in (entry or {}).values():
        if record is not None and isinstance(record['lines'], FileLines):
            record['lines'].close()


class Kept:
    """What one read hands over: {table: {'typed': lines, 'legacy': lines}}, each lines a dict
    {'lines', 'marks', 'sha256', 'count'}. `complete` once the whole read returned. `measured`
    names, in bytes, the free space, memory and floors when nothing is kept for lack of them.
    The lines are a list in memory, or FileLines once on disk (`folder`); `spill`, for lines in
    memory, is where they move when memory runs short (None: they are let go)."""

    def __init__(self, enabled=True, reason=None, always=(), folder=None, measured=None, spill=None, reserve=0):
        self.enabled, self.reason, self.always = enabled, reason, frozenset(always)
        self.measured, self.folder, self.spill, self.reserve = measured or {}, None, spill, reserve
        self.tables, self.complete, self._remove, self.resident = {}, False, None, 0
        if folder is not None:
            self._use(folder)

    @property
    def place(self):
        return 'disk' if self.folder is not None else 'memory'

    def _use(self, folder):
        self.folder = folder
        self._remove = weakref.finalize(self, shutil.rmtree, str(folder), True)

    def _limit(self):
        """Bytes the next file may take and still leave the margin and the backup's reserve free."""
        available = available_disk(self.folder)
        return (available if available is not None else 0) - DISK_FLOOR_MARGIN - self.reserve

    def _to_disk(self):
        """Lines kept in memory move to a new scratch folder in `spill`; let go without one."""
        if self.spill is None:
            return self.let_go('memory')
        try:
            self._use(_scratch(self.spill))
            for entry in self.tables.values():
                for record in entry.values():
                    if isinstance(record['lines'], list):
                        record['lines'] = marked_digest(record['lines'], folder=self.folder, limit=self._limit())[2]
            self.resident = 0
            _RESIDENT.discard(self)
        except OSError:
            self.let_go('disk-full')

    def make_room(self):
        """Before another full read while lines are held in memory: they move to disk (or go)
        unless memory for one more read their size still leaves headroom()."""
        if self.reason is None and self.folder is None and self.resident and not memory_room(self.resident):
            self._to_disk()

    def let_go(self, reason):
        """Keep nothing more and drop what was kept: the proof after the restart reads in full."""
        self.clear()
        self.reason = reason

    def keeper(self, table, encoding):
        """The hash function the capture uses for `table`'s sorted lines in `encoding` ('typed',
        then 'legacy'): it returns joined_digest's value and keeps the lines when the table
        qualifies. None when nothing is kept."""
        if not self.enabled:
            return None

        def keep(lines):
            if self.reason is not None:  # Given up during this read: hash only.
                return marked_digest(lines)[0]
            size = sum(map(len, lines))
            if encoding == 'typed':
                _close(self.tables.pop(table, None))
                wanted = table in self.always or size >= KEEP_BYTES
            else:
                wanted = table in self.tables
            if not wanted:
                return marked_digest(lines)[0]
            # These lines are in memory already; keeping them only stops the read from freeing
            # them. The typed ones must also leave room for the legacy lines built next.
            if self.folder is None and not memory_room(size if encoding == 'typed' else 0):
                self._to_disk()
                if self.reason is not None:
                    return marked_digest(lines)[0]
            if self.folder is None:
                (sha256, marks), stored = marked_digest(lines), lines
                self.resident += size
                _RESIDENT.add(self)
            else:
                try:
                    sha256, marks, stored = marked_digest(lines, folder=self.folder, limit=self._limit())
                except OSError:  # A full disk while writing: the read goes on, the proof falls back.
                    self.let_go('disk-full')
                    return marked_digest(lines)[0]
            record = {'lines': stored, 'marks': marks, 'sha256': sha256, 'count': len(lines)}
            if encoding == 'typed':
                self.tables[table] = {'typed': record}
            else:
                _close({'legacy': self.tables[table].get('legacy')})
                self.tables[table]['legacy'] = record
            return sha256
        return keep

    def clear(self):
        for entry in self.tables.values():
            _close(entry)
        self.tables, self.complete, self.resident = {}, False, 0
        _RESIDENT.discard(self)
        if self._remove is not None:
            self._remove()


def make_room():
    """update_read's full reads outside keeping call this first (Kept.make_room)."""
    for kept in list(_RESIDENT):
        kept.make_room()


def _scratch(parent):
    return tempfile.mkdtemp(prefix='%s%d-' % (SCRATCH_PREFIX, os.getpid()), dir=str(parent))


def start(database, always=(), reserve=0):
    """A Kept for a read of `database`: in memory while there is headroom, with a scratch folder as
    the fallback when its volume is above the disk floor plus `reserve` (what the update still
    needs free after this read, its backup); on disk from the start without headroom; disabled
    with neither."""
    try:
        size = os.stat(str(database)).st_size
    except OSError:
        return Kept(False, 'no-database')
    with contextlib.suppress(OSError):  # Committed rows still in the log are read too.
        size += os.stat(str(database) + '-wal').st_size
    parent = scratch_parent(database)
    remove_stale(parent)
    available, floor = available_disk(parent), disk_floor(size) + reserve
    disk = available is not None and available >= floor
    if memory_room():
        return Kept(True, None, always, spill=parent if disk else None, reserve=reserve)
    if not disk:
        return Kept(False, 'disk', measured={'availableBytes': available, 'floorBytes': floor,
                                             'availableMemoryBytes': available_memory(), 'headroomBytes': headroom()})
    return Kept(True, None, always, folder=_scratch(parent), reserve=reserve)


def active():
    """The Kept a read in this context hands its lines to, or None."""
    kept = _ACTIVE.get()
    return kept if kept is not None and kept.enabled else None


@contextlib.contextmanager
def keeping(database, always=(), reserve=0):
    """Inside, the next complete read keeps its lines in the yielded Kept (see the module)."""
    kept = start(database, always, reserve)
    token = _ACTIVE.set(kept)
    try:
        yield kept
    finally:
        _ACTIVE.reset(token)
