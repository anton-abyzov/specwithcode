#!/usr/bin/env python3
"""The one supported way for a script to read a SpecWithCode database another process may hold.

SQLite coordinates processes with POSIX advisory locks, and those locks belong to a process:
when the service closes any other descriptor it has for statev2.sqlite or its -shm, the kernel
drops the service's own SQLite locks on that file. A reader that opens the database after that,
even with ?mode=ro or `sqlite3 -readonly`, believes it is the only user: it truncates and
rebuilds -shm under the service's memory map, and the service dies with SIGBUS in walFindFrame
(M4, 2026-10-16). A read-write opener that closes it believes it is the last user and
checkpoints and deletes -wal and -shm while the service still writes to them (M4, 2026-10-15).

`connect` adds readonly_shm=1 to mode=ro whenever -shm exists: -shm is then opened read-only, so
this reader can never truncate or rebuild it, and mode=ro keeps it from checkpointing or
deleting -wal. In the reproduction (studio-research-notes/sqlite-crash-2026-10-16.md) a plain
?mode=ro reader crashed a service whose -shm lock was gone 15 times out of 15; with these flags,
0 times out of 64, and every backup taken that way passed integrity_check. Without -shm on disk
no process has the current index mapped, and readonly_shm could not open the database, so plain
mode=ro is used.

Apple's SQLite on macOS 27 (3.54.0, /usr/bin/python3) refuses that plain mode=ro open of a
database in WAL mode whose -shm and -wal are both gone, as a stopped service leaves them: it will
not create them read-only and reports "unable to open database file". Stock SQLite creates them
and joins as an ordinary reader. `connect` then does the same by hand: when no process holds a
lock on the database, it creates the two files empty (O_EXCL, so never over a file another
process made) and opens plain mode=ro. The reader then takes SQLite's WAL locks like any other
connection, so a service that starts during the read still cannot checkpoint over the pages the
read uses. Just before that open it checks the new -shm is still empty: once another process
has initialised it, it is opened read-only like any shared index. The files stay behind, as
stock SQLite leaves them, and later reads share them read-only. A process that holds the
database without its -wal and -shm is refused; one that also lost its locks looks like no process
at all, to this check as to stock SQLite.

`service_locks` reports whether some process holds SQLite's locks on the database file and on
-shm, as any other process sees them. The service holds both for as long as its connection is
open, so a running service with neither has lost them.

    python3 live_database.py snapshot --identity m4 --out /tmp/statev2-copy.sqlite
    python3 live_database.py locks --identity m4
"""
import argparse
import fcntl
import json
import os
import pathlib
import sqlite3
import struct
import sys
import urllib.parse

import studio_paths

# readonly_shm arrived in SQLite 3.22.0; an older library ignores it and could reset -shm.
MIN_SQLITE_VERSION = (3, 22, 0)
SUFFIXES = ('', '-wal', '-shm', '-journal')

# os_unix.c: a SHARED lock is a read lock on 510 bytes after the pending and reserved bytes, and
# every connection holds a read lock on the -shm "dead man switch" byte while it is open.
PENDING_BYTE = 0x40000000
SHARED_FIRST, SHARED_SIZE = PENDING_BYTE + 2, 510
SHM_DMS = 120 + 8  # UNIX_SHM_BASE + SQLITE_SHM_NLOCK


def readonly_uri(path, shared_index=None):
    """The URI `connect` opens: never able to change the database, its -wal or its -shm.
    `shared_index` False opens -shm read-write, for an index this reader created itself."""
    absolute = os.path.abspath(str(path))
    if shared_index is None:
        shared_index = os.path.exists(absolute + '-shm')
    return 'file:' + urllib.parse.quote(absolute, safe='/') + '?' + ('mode=ro&readonly_shm=1' if shared_index else 'mode=ro')


def _create_side_files(path):
    """For a WAL database no process holds (no -wal, no -shm, no lock on the file): creates both
    empty, as stock SQLite's first reader does. True when this call created both."""
    absolute = os.path.abspath(str(path))
    if any(os.path.lexists(absolute + suffix) for suffix in ('-wal', '-shm')):
        return False
    if lock_holder(absolute, SHARED_FIRST, SHARED_SIZE) is not None:
        # Some process has it open with its -wal and -shm gone: a reader of the main file alone
        # would miss its log. Refused, as for any database that cannot be read safely.
        raise sqlite3.OperationalError('unable to open database file: it is open in another process without its -wal and -shm')
    mode = os.stat(absolute).st_mode & 0o666
    for suffix in ('-shm', '-wal'):  # SQLite opens the index first.
        try:
            os.close(os.open(absolute + suffix, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode))
        except FileExistsError:  # A process opened it meanwhile: it is now an ordinary shared read.
            return False
    return True


def connect(path, timeout=5.0):
    """A read-only connection to `path` that cannot reset the index or remove the log another
    process is using. Raises sqlite3.Error like sqlite3.connect."""
    if sqlite3.sqlite_version_info < MIN_SQLITE_VERSION:
        raise RuntimeError('SQLite %s cannot open the live database safely; 3.22.0 or newer is needed'
                           % sqlite3.sqlite_version)
    try:
        return _open(readonly_uri(path), timeout)
    except sqlite3.OperationalError as error:
        absolute = os.path.abspath(str(path))
        if 'unable to open database file' not in str(error) or not os.path.exists(absolute) \
                or any(os.path.lexists(absolute + suffix) for suffix in ('-wal', '-shm')):
            raise
    created = _create_side_files(path)
    # A process that opened the database since then has initialised the new index: share it read-only.
    own_index = created and os.stat(os.path.abspath(str(path)) + '-shm').st_size == 0
    return _open(readonly_uri(path, shared_index=False if own_index else None), timeout)


def _open(uri, timeout):
    """A query-only connection to `uri` that has read the schema (the open is lazy until then)."""
    connection = sqlite3.connect(uri, uri=True, timeout=timeout)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
    except BaseException:
        connection.close()
        raise
    return connection


def _flock(start, length):
    if sys.platform == 'darwin':  # off_t l_start, off_t l_len, pid_t l_pid, short l_type, short l_whence
        return struct.pack('qqihh', start, length, 0, fcntl.F_WRLCK, os.SEEK_SET)
    return struct.pack('@hhqqi', fcntl.F_WRLCK, os.SEEK_SET, start, length, 0)


def _holder(result):
    if sys.platform == 'darwin':
        _, _, pid, kind, _ = struct.unpack('qqihh', result)
    else:
        kind, _, _, _, pid = struct.unpack('@hhqqi', result)
    return None if kind == fcntl.F_UNLCK else pid


# Descriptors kept open while a connection of this process stays open across lock_holder calls
# (read_watermark): {absolute path: descriptor}. Closing a probe would drop that connection's own
# locks, so lock_holder asks through the held descriptor while it still names the same file.
_held = {}


def hold_probe(path):
    """Opens `path` once for lock_holder and keeps it open until release_probe; returns its
    (device, inode). Raises OSError like os.open."""
    path = os.path.abspath(str(path))
    release_probe(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    _held[path] = descriptor
    status = os.fstat(descriptor)
    return status.st_dev, status.st_ino


def release_probe(path):
    """Closes a hold_probe descriptor. Only once this process's connection to the file is closed:
    the close drops every lock this process holds on it."""
    descriptor = _held.pop(os.path.abspath(str(path)), None)
    if descriptor is not None:
        os.close(descriptor)


def held_probe(path):
    """The hold_probe descriptor of `path` while it is still the file at that path, else None.
    Reading through it never drops this process's locks; opening and closing the path does."""
    held = _held.get(os.path.abspath(str(path)))
    if held is None:
        return None
    try:
        current, probe = os.stat(str(path)), os.fstat(held)
    except FileNotFoundError:
        return None
    return held if (current.st_dev, current.st_ino) == (probe.st_dev, probe.st_ino) else None


def lock_holder(path, start, length):
    """The pid of a process whose lock on bytes [start, start+length) of `path` would block a write
    lock, None when no process holds one. Opening and closing the file here only ever drops this
    process's own locks; a held probe (hold_probe) on the same file drops none."""
    held = held_probe(path)
    if held is not None:
        return _holder(fcntl.fcntl(held, fcntl.F_GETLK, _flock(start, length)))
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        return _holder(fcntl.fcntl(descriptor, fcntl.F_GETLK, _flock(start, length)))
    finally:
        os.close(descriptor)


def service_locks(path):
    """{'database': pid or None, 'index': pid or None (or 'missing' without -shm)}."""
    database = os.path.abspath(str(path))
    index = database + '-shm'
    return {'database': lock_holder(database, SHARED_FIRST, SHARED_SIZE),
            'index': lock_holder(index, SHM_DMS, 1) if os.path.exists(index) else 'missing'}


def snapshot(path, out, timeout=5.0):
    """Copies `path` into the new file `out` with SQLite's online backup through `connect`, then
    checks the copy. Returns {'path', 'bytes', 'quickCheck'}."""
    target = pathlib.Path(out).absolute()
    for live in (pathlib.Path(os.path.abspath(str(path)) + suffix) for suffix in SUFFIXES):
        if target == live or (target.exists() and live.exists() and os.path.samefile(target, live)):
            raise ValueError('Refusing to write a snapshot over the live database file %s' % target)
    if target.exists():
        raise FileExistsError('%s already exists; choose a new file for the snapshot' % target)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    partial = target.with_name(target.name + '.partial-%d' % os.getpid())
    try:
        source = connect(path, timeout)
        try:
            copy = sqlite3.connect(str(partial))
            try:
                source.backup(copy)
                copy.execute('PRAGMA journal_mode=DELETE')
                check = copy.execute('PRAGMA quick_check').fetchone()[0]
            finally:
                copy.close()
        finally:
            source.close()
        if check != 'ok':
            raise sqlite3.DatabaseError('The snapshot failed PRAGMA quick_check: %s' % check)
        os.chmod(str(partial), 0o600)
        os.replace(str(partial), str(target))
        return {'path': str(target), 'bytes': target.stat().st_size, 'quickCheck': check}
    finally:
        for suffix in SUFFIXES:
            leftover = pathlib.Path(str(partial) + suffix)
            if leftover.exists():
                leftover.unlink()


def identity_database(identity):
    if not identity or '/' in identity or identity.startswith('.'):
        raise ValueError('Invalid identity')
    return studio_paths.identity_home(pathlib.Path.home(), identity) / 'userdata' / 'statev2.sqlite'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    for name, text in (('snapshot', 'copy the database to a new file'),
                       ('locks', 'show which processes hold its SQLite locks')):
        command = commands.add_parser(name, help=text)
        where = command.add_mutually_exclusive_group(required=True)
        where.add_argument('--identity', help='SpecWithCode identity home, e.g. m4 (~/.specwithcode/m4)')
        where.add_argument('--database', type=pathlib.Path, help='path to statev2.sqlite')
        if name == 'snapshot':
            command.add_argument('--out', type=pathlib.Path, required=True, help='new file to write')
    args = parser.parse_args(argv)
    database = args.database or identity_database(args.identity)
    if args.command == 'snapshot':
        print(json.dumps(snapshot(database, args.out)))
    else:
        print(json.dumps(service_locks(database)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
