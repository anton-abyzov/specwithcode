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
"""
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
    root = releases_root(home)
    if root.is_symlink() or not root.is_dir():
        return []
    ancestor = pathlib.Path(home)
    for part in root.relative_to(home).parts:
        ancestor = ancestor / part
        if ancestor.is_symlink():
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
        root = studio_paths.backups_root(home)
        ancestor = pathlib.Path(home)
        for part in root.relative_to(home).parts:
            ancestor = ancestor / part
            if ancestor.is_symlink():
                return []
        if not root.is_dir():
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
