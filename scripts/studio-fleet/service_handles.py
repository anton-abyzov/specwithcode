"""What the running service holds open, read with lsof and SQLite's own locks: its listening port,
its statev2 database files and their locks. Moved from update.py (file-size cap); update.py
imports every name, so its checks and refusal texts are unchanged."""
import os
import subprocess

import live_database

LSOF_TIMEOUT_SECONDS = 30
LSOF_ATTEMPTS = 2

def listeners(port):
    # lsof walks every open file; on a loaded Mac 5 s was not enough and failed the preflight.
    for attempt in range(1, LSOF_ATTEMPTS + 1):
        try:
            result = subprocess.run(['/usr/sbin/lsof', '-nP', '-t', '-iTCP:' + str(port), '-sTCP:LISTEN'],
                                    capture_output=True, text=True, timeout=LSOF_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            if attempt == LSOF_ATTEMPTS:
                raise
            continue
        assert result.returncode in {0, 1}, 'Listening ports could not be read'
        return sorted(set(int(value) for value in result.stdout.split()))

DATABASE_FILES = ('statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm')
DETACHED_DATABASE = ('The SpecWithCode service is using a database log that was deleted from disk. '
                     'Restart SpecWithCode, then update')
LOCKS_LOST = ('The SpecWithCode service lost its SQLite locks on its database. '
              'Restart SpecWithCode, then update')

def open_inodes(pid):
    """{path: inode} of the regular files `pid` holds open, from lsof's field output."""
    for attempt in range(1, LSOF_ATTEMPTS + 1):
        try:
            result = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid), '-Fin'],
                                    capture_output=True, text=True, timeout=LSOF_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            if attempt == LSOF_ATTEMPTS:
                raise
            continue
        assert result.returncode in {0, 1}, 'Open service files could not be read'
        files, inode = {}, None
        for line in result.stdout.splitlines():
            if line[:1] in {'p', 'f'}:
                inode = None
            elif line[:1] == 'i' and line[1:].isdigit():
                inode = int(line[1:])
            elif line[:1] == 'n' and inode is not None:
                files.setdefault(line[1:], set()).add(inode)
        return files

def assert_database_attached(pid, state):
    """The service's open statev2 database, -wal and -shm are the files on disk. When another
    connection deletes the -wal and -shm while the service has them open (it can, once the
    service's lock on the database file is lost), the service keeps writing a log no other
    process can see. A read then misses its newest commits and races its checkpoints into
    SQLITE_CORRUPT ("database disk image is malformed"), so no snapshot can be trusted until
    the service reopens the database."""
    held = open_inodes(pid)
    for name in DATABASE_FILES:
        path = str(state / name)
        for inode in held.get(path, ()):
            try:
                current = os.stat(path).st_ino
            except FileNotFoundError:
                current = None
            assert current == inode, DETACHED_DATABASE

def assert_database_locked(state):
    """Some process holds SQLite's locks on the database and on -shm. The running service holds
    both for as long as its connection is open, so neither means it lost them: a process that
    closes another descriptor for one of those files drops its own POSIX locks on it. Until it
    reopens the database, any other open can rebuild -shm under it (SIGBUS) or delete -wal as
    the "last" user, and no snapshot is safe to take."""
    locks = live_database.service_locks(state / 'statev2.sqlite')
    assert locks['database'] is not None and locks['index'] is not None, LOCKS_LOST
