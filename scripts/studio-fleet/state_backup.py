#!/usr/bin/env python3
"""The pre-update copy of the state database that a rollback restores (update.restore_state).

update.py used to copy the live database with SQLite's online backup while the old service still
ran, which on an 8 GB database took minutes and raced the service's writes. It now copies once
the old service has stopped (launchctl bootout and its exit), so no writer can change the files:
`clone_state` clones statev2.sqlite, -wal and -shm with clonefile(2) (an APFS clone writes no data,
well under a second), then folds the cloned log into the cloned database, so the folder holds the
same single statev2.sqlite (and settings.json) as before and restore_state and
release_retention.prune_state_backups read it unchanged. Where the volume cannot clone (EXDEV,
ENOTSUP) or there is no clonefile, `backup_state`'s SQLite copy is used instead.

A clone shares the database's blocks until either side writes, so it needs only room for what the
new release and the fold write: `assert_clone_headroom` asks for max(1 GiB, 10 % of the database
plus the whole -wal) on the backups volume, measured before the service is stopped. The fold
writes every page in the log into the cloned database, so the log counts in full.
"""
import contextlib
import ctypes
import datetime
import errno
import os
import pathlib
import re
import shutil
import sqlite3
import uuid

import live_database
import studio_paths
from installation_descriptor import owned_path

DATABASE_FILES = ('statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm')
BACKUP_SPACE_MARGIN = 2 * 1024 ** 3
CLONE_HEADROOM_MIN = 1024 ** 3
CLONE_HEADROOM_SHARE = 0.10
CLONE_UNSUPPORTED = {errno.EXDEV, errno.ENOTSUP, errno.EOPNOTSUPP}
# Worded as the preflight's refusal (assert_backup_space, update_agent.DISK_REFUSAL), which needs
# more and so passed: the disk filled up since.
NO_CLONE_HEADROOM = 'Not enough free disk space for the pre-update backup: needs %.1f GB, %.1f GB free (checked again before the service stops)'


class CloneUnavailable(Exception):
    """This volume (or this system) cannot clone: use the SQLite copy instead."""


def write_private(path, data):
    """A new 0600 file, never through a link; replaces `path` atomically."""
    temporary = path.with_name(path.name + '.owned-update-' + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
        os.replace(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()


def backup_folder(commit):
    """A new, private `pre-<commit>-<time>-<uuid>` folder under the backups root."""
    home = pathlib.Path.home().resolve()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    root = owned_path(studio_paths.backups_root(home), home)
    root.mkdir(mode=0o700, exist_ok=True)
    target_dir = root / ('pre-%s-%s-%s' % (re.sub('[^a-f0-9]', '', str(commit))[:12] or 'unknown', stamp, uuid.uuid4().hex))
    target_dir.mkdir(mode=0o700)
    return target_dir


def keep_settings(own, target_dir):
    settings = own / 'userdata' / 'settings.json'
    if settings.is_file() and not settings.is_symlink():
        write_private(target_dir / 'settings.json', settings.read_bytes())


def backup_state(own, commit):
    """Consistent copy of the state database, and the exact settings.json beside it, before
    the new release can migrate them."""
    target_dir = backup_folder(commit)
    target = target_dir / 'statev2.sqlite'
    source = live_database.connect(own / 'userdata' / 'statev2.sqlite')
    try:
        copy = sqlite3.connect(str(target))
        try:
            source.backup(copy)
        finally:
            copy.close()
    except BaseException:
        # A copy cut short (a full disk) would otherwise stay behind and keep the disk full.
        discard_unused_backup(target)
        raise
    finally:
        source.close()
    target.chmod(0o600)
    keep_settings(own, target_dir)
    return target


def clone_state(own, commit, clonefile):
    """backup_state for a stopped service: clones of the database files, the log folded in.
    `clonefile` is update._clonefile()'s function or None. Returns (backup, 'clone') or
    (backup, 'sqlite-backup') when the volume cannot clone."""
    target_dir = backup_folder(commit)
    target = target_dir / 'statev2.sqlite'
    try:
        if clonefile is None:
            raise CloneUnavailable()
        state = own / 'userdata'
        for name in DATABASE_FILES:
            source = state / name
            if name != 'statev2.sqlite' and not source.exists():
                continue
            if clonefile(os.fsencode(str(source)), os.fsencode(str(target_dir / name)), 0) != 0:
                code = ctypes.get_errno()
                if code in CLONE_UNSUPPORTED:
                    raise CloneUnavailable()
                raise OSError(code, os.strerror(code), str(source))
        fold_log(target)
        target.chmod(0o600)
        keep_settings(own, target_dir)
        return target, 'clone'
    except CloneUnavailable:
        discard_unused_backup(target)
        return backup_state(own, commit), 'sqlite-backup'
    except BaseException:
        discard_unused_backup(target)
        raise


def fold_log(target):
    """Writes the cloned log into the cloned database and removes it, as the service's own last
    connection does on a clean stop: the copy is then one self-contained file. Only the copy is
    opened, never the live files."""
    database = sqlite3.connect(str(target))
    try:
        busy, _, _ = database.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        assert busy == 0, 'The copied database log could not be folded into the copy'
    finally:
        database.close()
    for suffix in ('-wal', '-shm'):
        sidecar = pathlib.Path(str(target) + suffix)
        if sidecar.exists():
            # A TRUNCATE checkpoint that succeeded left the log empty; nothing in it is lost.
            assert suffix == '-shm' or sidecar.stat().st_size == 0, 'The copied database log was not emptied'
            sidecar.unlink()


def discard_unused_backup(backup):
    """Removes a backup_state copy that no restart used (a copy of a 2.5 GB database each
    retry would otherwise pile up). Only the files the copies write, in their own folder."""
    home = pathlib.Path.home().resolve()
    folder = backup.parent
    if (backup.name != 'statev2.sqlite' or not folder.name.startswith('pre-')
            or folder.parent != owned_path(studio_paths.backups_root(home), home)):
        return
    for name in DATABASE_FILES + ('settings.json',):
        with contextlib.suppress(FileNotFoundError):
            (folder / name).unlink()
    with contextlib.suppress(OSError):
        folder.rmdir()


def _free(home):
    root = studio_paths.backups_root(home)
    while not root.exists() and root != root.parent:
        root = root.parent  # The first update makes the backups folder; measure its disk.
    return root, shutil.disk_usage(str(root)).free


def _database_bytes(own, names=('statev2.sqlite', 'statev2.sqlite-wal')):
    total = 0
    for name in names:
        try:
            total += os.stat(str(own / 'userdata' / name)).st_size
        except FileNotFoundError:
            pass
    return total


def assert_backup_space(own, home):
    """Refuses an update whose pre-update copy of the database cannot fit. The copy is
    about the database and its write-ahead log; the margin covers the release staged
    beside it and leaves the Mac room to run. Sizes come from stat alone: the live
    database is never opened here."""
    needed = BACKUP_SPACE_MARGIN + _database_bytes(own)
    free = _free(home)[1]
    assert free >= needed, 'Not enough free disk space for the pre-update backup: needs %.1f GB, %.1f GB free' % (
        needed / 1e9, free / 1e9)


def assert_clone_headroom(own, home):
    """Refuses, before the service is stopped, when the backups volume lacks the room a clone
    and the new release's first writes need. Stat only."""
    needed = max(CLONE_HEADROOM_MIN, int(_database_bytes(own, ('statev2.sqlite',)) * CLONE_HEADROOM_SHARE)
                 + _database_bytes(own, ('statev2.sqlite-wal',)))
    free = _free(home)[1]
    assert free >= needed, NO_CLONE_HEADROOM % (needed / 1e9, free / 1e9)
