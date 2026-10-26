#!/usr/bin/env python3
"""Removes unpacked Studio releases that no service can start any more.

Each update unpacks a release of about 340 MB under
~/.specwithcode/install/releases/<sha20>, and nothing removed old ones.
After a verified update this keeps:
- the release the service now runs and the one it ran before (the rollback target);
- every release named by any ~/.specwithcode/<identity>/launch.sh or
  installation.json, so another identity's service is never broken;
- anything unpacked in the last hour, which may belong to an update in flight;
- anything that is not a plain <sha20> directory.

Each update also copies the state database (2.5 GB on a long-used Mac) to
~/.specwithcode/backups/pre-<commit>-<stamp>-<uuid> before the new release can
migrate it, and nothing removed those either: 73 copies filled 47 GB of one Mac's
disk. prune_state_backups keeps the newest few of them.

prune_update_leftovers removes what no other step does: install/incoming folders a killed helper
left behind and release bundles older than the installed release, and the receipts (296 files,
54 MB on one Mac) and owned-updates folders of finished updates beyond the newest few. A held or
unfinished update's receipt and folder, and any receipt the agent's state, run or marker names,
always stay.
"""
import json
import os
import pathlib
import re
import shutil
import time

import studio_paths

RELEASE_NAME = re.compile(r'[a-f0-9]{20}')
RELEASE_REFERENCE = re.compile(r'(?:specweave-studio|install)/releases/([a-f0-9]{20})(?![a-f0-9])')
RECENT_SECONDS = 3600
# pre-<commit>-<stamp>-<uuid> now; older updaters wrote pre-<commit>-<stamp>, some without the Z.
STATE_BACKUP_NAME = re.compile(r'pre-(?:[a-f0-9]{1,12}|unknown)-\d{8}T\d{6}Z?(?:-[a-f0-9]{32})?')
STATE_BACKUP_FILES = {'statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm', 'settings.json'}
STATE_BACKUPS_KEPT = 2
# update.py's staging folder (tempfile.TemporaryDirectory) and release assets named as release.sh names them.
STAGE_NAME = re.compile(r'owned-update-stage-[A-Za-z0-9_]+')
BUNDLE_NAME = re.compile(r'studio-(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{12}(?:\.tar\.gz(?:\.receipt\.json)?)?')
# update_agent.apply's update-/prestate- pair (plus the helper's .log), and the helpers' refusal records.
ATTEMPT_FILE = re.compile(r'(?:update|prestate)-(.+-\d{8}T\d{6,12}Z)\.(?:json|log)')
RECORD_FILE = re.compile(r'(reap|idle-agents|database-restart)-(\d{8}T\d{6,12}Z-[a-f0-9]{8})\.(?:json|log)')
OWNED_UPDATE_NAME = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
RECEIPTS_KEPT = 10
RECEIPT_READ_LIMIT = 64 << 20


def _plain_directory(root, home):
    """`root` when it and every folder between it and `home` is a real directory, else None."""
    ancestor = pathlib.Path(home)
    for part in pathlib.Path(root).relative_to(home).parts:
        ancestor = ancestor / part
        if ancestor.is_symlink():
            return None
    return root if root.is_dir() else None


def _remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(str(path))
    else:
        path.unlink()


def _version(text):
    match = re.match(r'(\d+)\.(\d+)\.(\d+)', text or '')
    return tuple(map(int, match.groups())) if match else None


def releases_root(home):
    return studio_paths.releases_root(home)


def referenced_releases(home):
    """Release names that any Studio identity's launcher or receipt points at."""
    names = set()
    roots = [root for root in (studio_paths.branded_root(home), studio_paths.legacy_root(home))
             if root.is_dir() and not root.is_symlink()]
    for identity in (entry for root in roots for entry in root.iterdir()):
        if identity.is_symlink() or not identity.is_dir():
            continue
        for file_name in ('launch.sh', 'installation.json'):
            path = identity / file_name
            try:
                text = path.read_text(errors='replace')
            except OSError:
                continue
            names.update(RELEASE_REFERENCE.findall(text))
    return names


def prune_releases(home, keep, now=None, recent_seconds=RECENT_SECONDS):
    """Deletes unreferenced old releases; returns the names removed, oldest first.

    `keep` holds release paths or names that must survive (the new and previous
    release). Errors on one directory never stop the rest, and never raise.
    """
    root = _plain_directory(releases_root(home), home)
    if root is None:
        return []
    protected = {pathlib.Path(str(item)).name for item in keep if item}
    protected |= referenced_releases(home)
    moment = time.time() if now is None else now
    candidates = []
    for child in root.iterdir():
        if not RELEASE_NAME.fullmatch(child.name) or child.name in protected:
            continue
        try:
            info = os.lstat(str(child))
        except OSError:
            continue
        if child.is_symlink() or not child.is_dir():
            continue
        if moment - info.st_mtime < recent_seconds:
            continue
        candidates.append((info.st_mtime, child))
    removed = []
    for _, child in sorted(candidates):
        try:
            shutil.rmtree(str(child))
        except OSError:
            continue
        removed.append(child.name)
    return removed


def prune_state_backups(home, keep=(), keep_newest=STATE_BACKUPS_KEPT, now=None, recent_seconds=RECENT_SECONDS,
                        only_if_frees=None):
    """Deletes old pre-update state database copies; returns the folder names removed.

    Keeps the `keep_newest` newest copies, any folder in `keep`, anything written in the
    last hour (another identity's update may be using it) and any folder that holds a file
    backup_state never writes. Only plain pre-<commit>-<stamp>[-<uuid>] folders directly in
    the backups root are candidates; symlinks are never followed. Never raises.

    With `only_if_frees`, removes nothing unless the candidates' files add up to at least that many
    bytes. Their sizes are an upper bound: a clone frees only the blocks it no longer shares.
    """
    try:
        root = _plain_directory(studio_paths.backups_root(home), home)
        if root is None:
            return []
        protected = {pathlib.Path(str(item)).name for item in keep if item}
        protected |= {pathlib.Path(str(item)).parent.name for item in keep if item}
        moment = time.time() if now is None else now
        backups = []
        for child in root.iterdir():
            if not STATE_BACKUP_NAME.fullmatch(child.name):
                continue
            try:
                info = os.lstat(str(child))
            except OSError:
                continue
            if child.is_symlink() or not child.is_dir():
                continue
            try:
                entries = list(child.iterdir())
            except OSError:
                continue
            if any(entry.is_symlink() or not entry.is_file() or entry.name not in STATE_BACKUP_FILES for entry in entries):
                continue  # Not only what backup_state writes: someone put it there by hand.
            backups.append((child.name.split('-')[2], info.st_mtime, child, entries))
    except OSError:
        return []
    backups.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    removed = []
    candidates = [(child, entries) for stamp, mtime, child, entries in backups[max(0, keep_newest):]
                  if child.name not in protected and moment - mtime >= recent_seconds]
    if only_if_frees is not None:
        total = 0
        for child, entries in candidates:
            for entry in entries:
                try:
                    total += os.lstat(str(entry)).st_size
                except OSError:
                    pass
        if total < only_if_frees:
            return []
    for child, entries in candidates:
        try:
            for entry in entries:
                entry.unlink()
            child.rmdir()
        except OSError:
            continue
        removed.append(child.name)
    return sorted(removed)


def held_state_backups(own):
    """The pre-update copies a held rollback's receipt still names: after a failed state restore that
    copy is the only database from before the migration, so space pruning keeps it. Moved from
    update.py (file-size cap)."""
    held = []
    try:
        receipts = sorted((own / 'updates' / 'receipts').glob('update-*.json'))
    except OSError:
        return held
    for path in receipts:
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if (isinstance(value, dict) and str(value.get('rollback') or '').startswith('held')
                and isinstance(value.get('stateBackup'), str)):
            held.append(value['stateBackup'])
    return held


def prune_incoming(home, installed, now=None, recent_seconds=RECENT_SECONDS):
    """Deletes install/incoming leftovers; returns the names removed. A staging folder outlives
    update.py only when the agent killed the helper; a release bundle or .tar.gz is removed once
    its version is older than `installed`, the release now verified. Anything else, anything
    written in the last hour and any symlink stays."""
    root = _plain_directory(studio_paths.incoming_root(home), home)
    newest = _version(installed)
    if root is None or newest is None:
        return []
    moment = time.time() if now is None else now
    removed = []
    for child in sorted(root.iterdir()):
        bundle = BUNDLE_NAME.fullmatch(child.name)
        if not (STAGE_NAME.fullmatch(child.name) and child.is_dir()) \
                and not (bundle and tuple(map(int, bundle.groups())) < newest):
            continue
        try:
            if child.is_symlink() or moment - os.lstat(str(child)).st_mtime < recent_seconds:
                continue
            _remove(child)
        except OSError:
            continue
        removed.append(child.name)
    return removed


def _named_receipts(updates):
    """The receipt file names the agent still points at: its state, its run, its install marker."""
    names = set()
    for file_name in ('state.json', 'run.json', 'install-in-progress.json'):
        try:
            value = json.loads((updates / file_name).read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict):
            continue
        for holder in (value, value.get('lastInstall'), value.get('automaticRetry')):
            if isinstance(holder, dict) and isinstance(holder.get('receipt'), str):
                names.add(pathlib.Path(holder['receipt']).name)
    return names


def _finished(receipt):
    """True for an update receipt nothing needs again: verified, refused with every pointer
    unchanged, or fully rolled back. A held rollback, a failed rollback, an apply that died
    with pointers moved, or anything unreadable is kept for a person."""
    if not isinstance(receipt, dict) or 'rollbackError' in receipt:
        return False
    return (receipt.get('phase') in ('verified', 'preflight') or receipt.get('pointers') == 'unchanged'
            or str(receipt.get('rollback') or '').startswith('restored-'))


def _finished_attempt(files, owned_root, own):
    """(True, owned-updates folder or None) when an attempt may go: its update receipt, if any, is
    finished and the folder it names, if that still exists, is a plain one in owned-updates."""
    folder = None
    for path in files:
        if not (path.name.startswith('update-') and path.suffix == '.json'):
            continue
        try:
            receipt = json.loads(path.read_text()) if path.stat().st_size <= RECEIPT_READ_LIMIT else None
        except (OSError, ValueError):
            receipt = None
        if not _finished(receipt):
            return False, None
        backup = pathlib.Path(str(receipt.get('backup') or ''))
        if backup.parent == owned_root and OWNED_UPDATE_NAME.fullmatch(backup.name) and os.path.lexists(str(backup)):
            if _plain_directory(owned_root, own) is None or backup.is_symlink() or not backup.is_dir():
                return False, None
            folder = backup
    return True, folder


def prune_update_receipts(own, keep=(), keep_newest=RECEIPTS_KEPT, now=None, recent_seconds=RECENT_SECONDS):
    """Deletes old update receipts and the owned-updates folders of finished updates; returns
    {'receipts': [...], 'ownedUpdates': [...]}, the names removed. Keeps the `keep_newest` newest
    attempts (an update-/prestate- pair) and records of each kind, anything in `keep`, anything
    the agent's state.json, run.json or install marker names, anything written in the last hour,
    and every attempt whose receipt is not finished (see _finished), so a held rollback keeps its
    receipt, the state copy it names (held_state_backups) and its owned-updates folder. An
    owned-updates folder goes only with the finished receipt that names it."""
    own = pathlib.Path(own)
    updates = own / 'updates'
    removed = {'receipts': [], 'ownedUpdates': []}
    root = _plain_directory(updates / 'receipts', own)
    if root is None:
        return removed
    protected = {pathlib.Path(str(item)).name for item in keep if item} | _named_receipts(updates)
    moment = time.time() if now is None else now
    groups = {}
    for child in root.iterdir():
        attempt, record = ATTEMPT_FILE.fullmatch(child.name), RECORD_FILE.fullmatch(child.name)
        if not (attempt or record):
            continue
        try:
            info = os.lstat(str(child))
        except OSError:
            continue
        if child.is_symlink() or not child.is_file():
            continue
        key = ('attempt', attempt.group(1)) if attempt else (record.group(1), record.group(2))
        groups.setdefault(key, []).append((info.st_mtime, child))
    by_kind = {}
    for key, files in groups.items():
        stamp = key[1].rsplit('-', 1)[-1] if key[0] == 'attempt' else key[1]
        by_kind.setdefault(key[0], []).append((stamp[:15], max(mtime for mtime, _ in files), key))
    owned_root = own / 'owned-updates'
    for entries in by_kind.values():
        for _stamp, newest, key in sorted(entries, reverse=True)[max(0, keep_newest):]:
            files = [path for _, path in groups[key]]
            if moment - newest < recent_seconds or any(path.name in protected for path in files):
                continue
            finished, folder = _finished_attempt(files, owned_root, own)
            if not finished:
                continue
            try:
                if folder is not None:
                    shutil.rmtree(str(folder))
                    removed['ownedUpdates'].append(folder.name)
                for path in files:
                    path.unlink()
                    removed['receipts'].append(path.name)
            except OSError:
                continue
    removed['receipts'].sort()
    removed['ownedUpdates'].sort()
    return removed


def prune_update_leftovers(home, own, installed, keep=()):
    """prune_incoming and prune_update_receipts after a verified update. Never raises."""
    result = {}
    for name, step in (('incoming', lambda: prune_incoming(home, installed)),
                       ('receipts', lambda: prune_update_receipts(own, keep))):
        try:
            result[name] = step()
        except Exception as error:  # Pruning never fails a verified update.
            result[name + 'Error'] = type(error).__name__
    return result
