#!/usr/bin/env python3
"""Whether a SpecWithCode database changed since an earlier full read, without reading a row.

update.py reads the whole database (minutes on a large one) before the restart, then checked it
again three times: the prestate check, right after the install gate settles and right before the
restart. When nothing committed in between, each re-read returns what the last one did. A
watermark taken right before a full read, and found unchanged later, lets that read stand.

`take()` reads, without holding a read transaction between calls:

- `PRAGMA data_version` on one long-lived read-only connection (live_database.connect), which
  changes when another connection commits (a write, a VACUUM, a migration) to the files this
  connection has open;
- the inodes of statev2.sqlite, -shm and -wal, and the database's size (a file replaced or
  restored, a VACUUM, a last connection that removed the log and index);
- the -wal header's checkpoint sequence and salts, and its size (a WAL reset or truncate);
- the connection's generation, which a reconnect advances.

data_version alone is not enough: it reads the index this connection mapped, so once the service
closes its last connection and removes -wal and -shm, a new service process writes to new files
and that number never moves again. Hence the inodes, and a take() that finds the database or -shm
no longer the files this connection opened fails (the next one reconnects). The connection keeps
its SQLite locks for as long as it is open, which is what keeps a service exit from removing those
files: live_database.lock_holder would drop them on its close of a probe descriptor, so this
watermark holds the probes open (live_database.hold_probe) until it closes.

`unchanged(earlier)` is True only when every field is equal and this connection took both. Any
difference, a reconnect, a read that fails or a connection left inside a read transaction (which
would pin the WAL and hide later commits) answers False, and the caller reads in full. The
watermark only ever skips a read; it never changes what a full read proves. Stdlib only.
"""
import os
import struct

import live_database

WAL_HEADER_BYTES = 32


class Watermark:
    """A read-only, autocommit connection kept open for `take()`; never inside a transaction."""

    def __init__(self, path):
        self.path = os.path.abspath(str(path))
        self.connection = None
        self.files = {}  # {'' or '-shm': [device, inode]} held open by live_database.hold_probe.
        self.generation = 0

    @classmethod
    def open(cls, path):
        watermark = cls(path)
        try:
            watermark._connect()
        except Exception:
            watermark.close()
        return watermark

    def _inode(self, suffix):
        try:
            status = os.stat(self.path + suffix)
        except FileNotFoundError:
            return None
        return [status.st_dev, status.st_ino]

    def _connect(self):
        self.close()
        self.generation += 1
        database, index = self._inode(''), self._inode('-shm')
        connection = live_database.connect(self.path)
        connection.isolation_level = None  # Autocommit: each statement ends its own read.
        self.connection = connection
        connection.execute('PRAGMA data_version').fetchall()  # Opens the database and maps -shm.
        # Held from here until close(), on exactly the files the connection opened.
        self.files = {'': list(live_database.hold_probe(self.path))}
        if self._inode('-shm') is not None:
            self.files['-shm'] = list(live_database.hold_probe(self.path + '-shm'))
        assert self.files[''] == database and index in (None, self.files.get('-shm')) \
            and all(self._inode(suffix) == inode for suffix, inode in self.files.items()), \
            'The database files were replaced while the watermark connected'

    def close(self):
        connection, self.connection = self.connection, None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        # Only after the connection: closing a probe drops this process's locks on that file.
        for suffix in self.files:
            live_database.release_probe(self.path + suffix)
        self.files = {}

    def _wal(self):
        """(checkpoint sequence, salt-1, salt-2) of the -wal header, and its size; None without one."""
        wal = self.path + '-wal'
        try:
            size = os.stat(wal).st_size
        except FileNotFoundError:
            return None, None
        if size < WAL_HEADER_BYTES:
            return None, size
        # Only the -wal is opened here: SQLite holds no POSIX lock on it, so closing this
        # descriptor drops none of this process's locks (live_database).
        with open(wal, 'rb') as handle:
            header = handle.read(WAL_HEADER_BYTES)
        return list(struct.unpack('>III', header[12:24])), size

    def take(self):
        """The current watermark, or None when it cannot be read (the next one reconnects)."""
        try:
            if self.connection is None:
                self._connect()
            # A transaction left open here would keep reading its own snapshot of the WAL.
            assert not self.connection.in_transaction, 'Watermark connection holds a read transaction'
            version = self.connection.execute('PRAGMA data_version').fetchall()[0][0]
            assert not self.connection.in_transaction, 'Watermark connection holds a read transaction'
            database = os.stat(self.path)
            salt, wal_size = self._wal()
            # Files other than the ones this connection opened: its data_version no longer moves.
            assert all(self._inode(suffix) == inode for suffix, inode in self.files.items()), \
                'The database files were replaced since the watermark connected'
            index, log = self._inode('-shm'), self._inode('-wal')
            return {'dataVersion': version, 'inode': database.st_ino, 'size': database.st_size,
                    'indexInode': index and index[1], 'walInode': log and log[1],
                    'walSalt': salt, 'walSize': wal_size, 'generation': self.generation}
        except Exception:
            self.close()
            return None

    def unchanged(self, earlier):
        """True only when nothing changed since `earlier` was taken on this same connection."""
        if not isinstance(earlier, dict):
            return False
        now = self.take()
        return now is not None and now == earlier and earlier.get('generation') == self.generation


class NeverUnchanged:
    """No watermark: every re-read is a full read."""
    def take(self):
        return None

    def unchanged(self, earlier):
        return False

    def close(self):
        pass


NEVER_UNCHANGED = NeverUnchanged()
