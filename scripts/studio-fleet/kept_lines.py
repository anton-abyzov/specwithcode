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

Memory: the lines of M4's orchestration_events alone take about 9 GB (October 2026). Nothing is
kept unless the system has MEMORY_FLOOR_FACTOR times the database file plus MEMORY_FLOOR_MARGIN
available (macOS: free, speculative, purgeable and file-backed pages; Linux: MemAvailable); the
proof after the restart then falls back to the full read. Stdlib only.
"""
import bisect
import contextlib
import contextvars
import ctypes
import hashlib
import os
import sys

KEEP_BYTES = 8 << 20
MARK_EVERY = 1 << 14
MEMORY_FLOOR_FACTOR = 3
MEMORY_FLOOR_MARGIN = 4 << 30
_ACTIVE = contextvars.ContextVar('kept_lines', default=None)


def _sysctl(name):
    value, size = ctypes.c_uint64(0), ctypes.c_size_t(8)
    function = ctypes.CDLL(None, use_errno=True).sysctlbyname
    if function(name.encode(), ctypes.byref(value), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        raise OSError(ctypes.get_errno(), name)
    return value.value


def available_memory():
    """Bytes the system can hand out without swapping, or None when it cannot tell."""
    try:
        if sys.platform == 'darwin':
            pages = sum(_sysctl('vm.' + name) for name in (
                'page_free_count', 'page_speculative_count', 'page_purgeable_count', 'page_pageable_external_count'))
            return pages * _sysctl('vm.pagesize')
        with open('/proc/meminfo') as handle:
            for line in handle:
                if line.startswith('MemAvailable:'):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return None


def memory_floor(database_bytes):
    return MEMORY_FLOOR_FACTOR * database_bytes + MEMORY_FLOOR_MARGIN


def marked_digest(lines, every=MARK_EVERY):
    """(digest('\\n'.join(lines)), marks): the same hex digest as database_continuity.joined_digest,
    and [(index, hasher)] with the SHA-256 state of '\\n'.join(lines[:index]) at every `every`
    lines, so a list changed from some line on is hashed again from the mark before it."""
    hasher, marks = hashlib.sha256(), []
    for start in range(0, len(lines), every):
        marks.append((start, hasher.copy()))
        if start:
            hasher.update(b'\n')
        hasher.update('\n'.join(lines[start:start + every]).encode())
    if not marks:
        marks.append((0, hasher.copy()))
    return hasher.hexdigest(), marks


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

    position, pending = start, 0
    for cut in sorted(skipped | {index for index, _ in inserts} | {len(lines)}):
        feed(lines[position:cut])
        while pending < len(inserts) and inserts[pending][0] == cut:
            feed([inserts[pending][1]])
            pending += 1
        position = cut + 1 if cut in skipped else cut
    return {'count': len(lines) - len(removed) + len(added), 'sha256': hasher.hexdigest()}


class Kept:
    """What one read hands over: {table: {'typed': lines, 'legacy': lines}}, each lines a dict
    {'lines', 'marks', 'sha256', 'count'}. `complete` once the whole read returned."""

    def __init__(self, enabled=True, reason=None, always=()):
        self.enabled, self.reason, self.always = enabled, reason, frozenset(always)
        self.tables, self.complete = {}, False

    def keeper(self, table, encoding):
        """The hash function the capture uses for `table`'s sorted lines in `encoding` ('typed',
        then 'legacy'): it returns joined_digest's value and keeps the lines when the table
        qualifies. None when nothing is kept."""
        if not self.enabled:
            return None

        def keep(lines):
            sha256, marks = marked_digest(lines)
            record = {'lines': lines, 'marks': marks, 'sha256': sha256, 'count': len(lines)}
            if encoding == 'typed':
                self.tables.pop(table, None)
                if table in self.always or sum(map(len, lines)) >= KEEP_BYTES:
                    self.tables[table] = {'typed': record}
            elif table in self.tables:
                self.tables[table]['legacy'] = record
            return sha256
        return keep

    def clear(self):
        self.tables, self.complete = {}, False


def start(database, always=()):
    """A Kept for a read of `database`, disabled below the memory floor."""
    try:
        size = os.stat(str(database)).st_size
    except OSError:
        return Kept(False, 'no-database')
    available = available_memory()
    if available is None or available < memory_floor(size):
        return Kept(False, 'memory')
    return Kept(True, None, always)


def active():
    """The Kept a read in this context hands its lines to, or None."""
    kept = _ACTIVE.get()
    return kept if kept is not None and kept.enabled else None


@contextlib.contextmanager
def keeping(database, always=()):
    """Inside, the next complete read keeps its lines in the yielded Kept (see the module)."""
    kept = start(database, always)
    token = _ACTIVE.set(kept)
    try:
        yield kept
    finally:
        _ACTIVE.reset(token)
