#!/usr/bin/env python3
"""Removes unpacked Studio releases that no service can start any more.

Each update unpacks a release of about 340 MB under
~/.local/share/specweave-studio/releases/<sha20>, and nothing removed old ones.
After a verified update this keeps:
- the release the service now runs and the one it ran before (the rollback target);
- every release named by any ~/.specweave-studio/<identity>/launch.sh or
  installation.json, so another identity's service is never broken;
- anything unpacked in the last hour, which may belong to an update in flight;
- anything that is not a plain <sha20> directory.
"""
import os
import pathlib
import re
import shutil
import time

RELEASE_NAME = re.compile(r'[a-f0-9]{20}')
RELEASE_REFERENCE = re.compile(r'specweave-studio/releases/([a-f0-9]{20})(?![a-f0-9])')
RECENT_SECONDS = 3600


def releases_root(home):
    return pathlib.Path(home) / '.local/share/specweave-studio/releases'


def referenced_releases(home):
    """Release names that any Studio identity's launcher or receipt points at."""
    names = set()
    studio = pathlib.Path(home) / '.specweave-studio'
    if not studio.is_dir() or studio.is_symlink():
        return names
    for identity in studio.iterdir():
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
