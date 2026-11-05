#!/usr/bin/env python3
"""Old pre-update state copies, pruned once a verified update has finished.

Each update clones the state database before the new release can migrate it (state_backup) and
retains one newest verified rollback copy; unfinished recovery copies also stay. Deleting an older clone took 15-18 s of 1.0.86's
19 s backupSpace on M4, all of it while the service was held and the desktop waited. The helper
now prunes before the copy only when the disk is too short for it (update._apply's shortfall
branch, which may drop every older copy). Otherwise, once a verified update's receipt is written,
spawn starts after_install in its own session: it waits for the helper to exit and release the
installation lock, keeps the new copy and every identity's unresolved recovery copies. Older verified
copies can go immediately; unclassified copies still have the existing age guard, and adds the removed folders to
the receipt's prunedStateBackups. A refused or failed update prunes nothing.
"""
import datetime
import json
import os
import pathlib
import select
import stat
import subprocess
import sys
import tempfile
import time

from installation_descriptor import installation_lock
from release_retention import STATE_BACKUP_NAME, held_state_backups, prune_state_backups
import studio_paths

LOCK_BUSY = 'Another installation operation is in progress for this home'
LOCK_WAIT_SECONDS = 300
READY_WAIT_SECONDS = 10
READY = b'ready\n'
# One pre-update copy per Mac (owner, 2026-11-05). Before the next copy only the newest older one
# stays, the previous update's rollback copy; after a verified update only that update's own copy.
KEPT_BEFORE_COPY = 1
KEPT_AFTER_VERIFIED = 0
SQLITE_HEADER = b'SQLite format 3\x00'


def complete_copy(path):
    """True when `path` is the finished copy backup_state or clone_state wrote: a plain file
    holding a whole SQLite database (its header, its page size times its page count) and no log
    beside it. Only then may the older copies go: there is never a moment without a valid one."""
    try:
        path = pathlib.Path(path)
        info = os.lstat(str(path))
        if not stat.S_ISREG(info.st_mode) or info.st_size < 100:
            return False
        if any(os.path.lexists(str(path) + suffix) for suffix in ('-wal', '-journal')):
            return False  # A log beside it: the copy stopped before its last write.
        with open(str(path), 'rb') as handle:
            header = handle.read(100)
        if not header.startswith(SQLITE_HEADER):
            return False
        page_size = int.from_bytes(header[16:18], 'big')
        page_size = 65536 if page_size == 1 else page_size
        if page_size < 512 or page_size & (page_size - 1) or info.st_size % page_size:
            return False
        pages = int.from_bytes(header[28:32], 'big')
        # Its page count holds only while version-valid-for matches the change counter (every copy
        # backup_state and clone_state write); a file may run longer than it. Otherwise: not whole.
        return header[92:96] == header[24:28] and pages > 0 and info.st_size >= page_size * pages
    except OSError:
        return False


def copies_by_stamp(home):
    """The pre-update copy folders in the backups root, newest stamp first (symlinks skipped)."""
    try:
        root = studio_paths.backups_root(home)
        folders = [child for child in root.iterdir()
                   if STATE_BACKUP_NAME.fullmatch(child.name) and not child.is_symlink() and child.is_dir()]
    except OSError:
        return []
    return sorted(folders, key=lambda child: child.name.split('-')[2], reverse=True)


def newest_complete_copy(home):
    """The newest folder whose database is a whole copy, or None: the one the pre-copy prune
    keeps, so an update killed mid-copy (its folder newest) never leaves only a partial."""
    for folder in copies_by_stamp(home):
        if complete_copy(folder / 'statev2.sqlite'):
            return folder
    return None


def newer_copies(home, current):
    """Copy folders stamped after `current`'s folder: a later update's, which an earlier update's
    late prune must never remove."""
    stamp = pathlib.Path(current).parent.name.split('-')
    stamp = stamp[2] if len(stamp) > 2 else ''
    return [folder for folder in copies_by_stamp(home) if folder.name.split('-')[2] > stamp]


def agent_receipt(home, identity, receipt):
    """True only for a receipt in this identity's own receipts folder, where the update agent
    writes them: a helper run anywhere else (a test, a hand-run apply) never prunes this home."""
    receipts = studio_paths.identity_home(home, identity) / 'updates' / 'receipts'
    try:
        return pathlib.Path(receipt).resolve().parent == receipts.resolve(strict=True)
    except OSError:
        return False


def spawn(identity, home, receipt, script):
    """Starts `script --prune-state-backups receipt` in its own session and waits, at most
    READY_WAIT_SECONDS, until it has loaded every module (the agent removes this helper's folder
    once it exits). Returns 'started', 'not-an-agent-receipt' or why it could not start. Never raises."""
    try:
        if not agent_receipt(home, identity, receipt):
            return 'not-an-agent-receipt'
        child = subprocess.Popen([sys.executable, '-B', '-E', '-s', str(script), '--identity', identity,
                                  '--prune-state-backups', str(receipt)],
                                 cwd='/', env={'HOME': str(home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        try:
            ready, _, _ = select.select([child.stdout], [], [], READY_WAIT_SECONDS)
            line = child.stdout.readline() if ready else b''
        finally:
            child.stdout.close()
        return 'started' if line == READY else 'not-ready'
    except Exception as error:  # Pruning never fails an update.
        return type(error).__name__


IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_THROTTLE = 0, 0, 3


def background_disk_io():
    """after_install's child: throttled disk I/O again. It inherits the apply helper's default
    policy (update_agent_run.normal_disk_io), but deleting old copies must not compete with the
    service that just restarted. Best effort; never raises."""
    try:
        import ctypes
        ctypes.CDLL(None).setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_THROTTLE)
    except Exception:
        pass


def announce_ready():
    """after_install's child, once its modules are loaded (spawn waits for this line)."""
    try:
        sys.stdout.buffer.write(READY)
        sys.stdout.flush()
        sys.stdout.close()
    except OSError:
        pass


def _write_receipt(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(json.dumps(value, indent=2) + '\n')
        os.replace(temporary, str(path))
    except BaseException:
        if os.path.lexists(temporary):
            os.unlink(temporary)
        raise


def after_install(identity, home, receipt, wait=LOCK_WAIT_SECONDS, sleep=time.sleep, clock=time.monotonic):
    """Prunes after the verified update `receipt` names, under the installation lock; returns the
    folder names removed, or None when it did not run (busy past `wait`, or no verified receipt)."""
    receipt = pathlib.Path(receipt)
    if not agent_receipt(home, identity, receipt):
        return None
    own = studio_paths.identity_home(home, identity)
    deadline = clock() + wait
    while True:
        try:
            with installation_lock(home):
                started = clock()
                value = json.loads(receipt.read_text())
                before = value.get('before') if isinstance(value, dict) else None
                if not (isinstance(before, dict) and before.get('identity') == identity
                        and value.get('phase') == 'verified' and isinstance(value.get('stateBackup'), str)):
                    return None
                try:
                    if not complete_copy(value['stateBackup']):
                        removed, error = [], 'CurrentCopyIncomplete'  # Keep every older copy.
                    else:
                        removed, error = prune_state_backups(home, keep=held_state_backups(own) + [value['stateBackup']] + newer_copies(home, value['stateBackup']),
                                                             keep_newest=KEPT_AFTER_VERIFIED, verified_install=True), None
                except Exception as failure:  # prune_state_backups never raises; recorded if it does.
                    removed, error = [], type(failure).__name__
                value['prunedStateBackups'] = list(value.get('prunedStateBackups') or []) + removed
                value['stateBackupPruneAfterInstall'] = {'milliseconds': round((clock() - started) * 1000),
                                                         'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
                if error:
                    value['stateBackupPruneError'] = error
                _write_receipt(receipt, value)
                return removed
        except AssertionError as error:
            if str(error) != LOCK_BUSY or clock() >= deadline:
                return None
        sleep(0.5)
