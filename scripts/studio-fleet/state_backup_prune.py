#!/usr/bin/env python3
"""Old pre-update state copies, pruned once a verified update has finished.

Each update clones the state database before the new release can migrate it (state_backup) and
keeps the newest older copy beside the new one. Deleting an older clone took 15-18 s of 1.0.86's
19 s backupSpace on M4, all of it while the service was held and the desktop waited. The helper
now prunes before the copy only when the disk is too short for it (update._apply's shortfall
branch, which may drop every older copy). Otherwise, once a verified update's receipt is written,
spawn starts after_install in its own session: it waits for the helper to exit and release the
installation lock, keeps what the prune before the copy kept (the new copy, the newest older one,
any copy a held rollback names and anything from the last hour), and adds the removed folders to
the receipt's prunedStateBackups. A refused or failed update prunes nothing.
"""
import datetime
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import time

from installation_descriptor import installation_lock
from release_retention import held_state_backups, prune_state_backups
import studio_paths

LOCK_BUSY = 'Another installation operation is in progress for this home'
LOCK_WAIT_SECONDS = 300
READY_WAIT_SECONDS = 10
READY = b'ready\n'
# The new copy and the newest older one: what keep_newest=1 kept before the copy was made.
KEPT_AFTER_INSTALL = 2


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
                    removed, error = prune_state_backups(home, keep=held_state_backups(own) + [value['stateBackup']],
                                                         keep_newest=KEPT_AFTER_INSTALL), None
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
