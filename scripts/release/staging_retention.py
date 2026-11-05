#!/usr/bin/env python3
"""Retain release evidence, not duplicate build payloads. Dry-run unless --apply.

Normal publication removes published stages older than the previous release and compacts a
published previous stage: a release that stops after publish-public (every --ci release) is
still superseded once the next one is public. --finished compacts completed unlocked stages
without deleting their receipts.
A compacted release retains release.json, published/candidate SHAs, stage markers, logs, timing
and stage-1 history. They are what later releases read; shipped binaries live in the release
stores. Incomplete releases and every lock (including a stale lock) require their owner.

A superseded stage is renamed to .retired-<version>-<hex> under its lock and then removed. When
that removal failed part way (Finder rewrites .DS_Store while a folder empties, ENOTEMPTY), the
husk had no lock and no sweep, so 857 MB of 1.0.189 stayed. Removal now retries, and every run
removes unlocked .retired-* folders a failed run left.
"""
import argparse
import errno
import json
import os
import pathlib
import re
import shutil
import time
import uuid

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
RETIRED = re.compile(r'\.retired-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-[a-f0-9]{32}')
REMOVE_ATTEMPTS = 3
RETRY_PAUSE_SECONDS = 0.5
STALE_LOCK_SECONDS = 3600
PAYLOAD = re.compile(r'(?:assets|runtime|runtime-linux-(?:arm64|x64)|google-verify|verify-runtime|verify-runtime-linux-(?:arm64|x64))-([a-f0-9]{12})')


def version(value):
    return tuple(map(int, value.split('.'))) if VERSION.fullmatch(value or '') else None


def plain(path):
    """Reject links anywhere in an absolute path, not only at its last component."""
    return path.is_absolute() and not any(part.is_symlink() for part in (path, *path.parents))


def marker(stage, name):
    path = stage / 'markers' / name
    try:
        return plain(path) and path.is_file() and path.read_text().strip() == 'once'
    except OSError:
        return False


def owned(stage):
    try:
        descriptor = stage / 'release.json'
        if not (plain(stage) and stage.is_dir() and plain(descriptor) and descriptor.is_file()):
            return False
        if descriptor.stat().st_size > 65536:
            return False
        value = json.loads(descriptor.read_text())
        return isinstance(value, dict) and value.get('version') == stage.name
    except (OSError, ValueError):
        return False


def published_sha(stage):
    path = stage / 'published.sha'
    try:
        return plain(path) and path.is_file() and re.fullmatch('[a-f0-9]{40}', path.read_text().strip()) is not None
    except OSError:
        return False


def published(stage):
    """Both publish markers and the recorded published commit; later rollout stages may be absent."""
    return all(marker(stage, name) for name in ('publish-private', 'publish-public')) and published_sha(stage)


def completed(stage):
    return published(stage) and all(marker(stage, name) for name in ('fleet-m4', 'desktop', 'fleet-workers', 'merge', 'fleet-linux'))


def remove_tree(target):
    """shutil.rmtree; again, after a short pause, when a folder refilled while it emptied (Finder
    rewrites .DS_Store: ENOTEMPTY). Done only when nothing is left at `target`."""
    for attempt in range(REMOVE_ATTEMPTS):
        try:
            shutil.rmtree(target)  # Descendant symlinks are unlinked, never traversed.
        except FileNotFoundError:
            pass  # Another remover took part of it; done only if nothing is left.
        except OSError as error:
            if error.errno != errno.ENOTEMPTY or attempt == REMOVE_ATTEMPTS - 1:
                raise
        if not os.path.lexists(target):
            return
        time.sleep(RETRY_PAUSE_SECONDS)
    raise OSError(errno.ENOTEMPTY, 'still not empty', str(target))


def stale_lock(lock, now=None):
    """True for a husk's lock no remover holds: its pid is gone, or it has no readable pid and is
    older than an hour. No release resumes a .retired-* folder, so nothing else would clear it."""
    moment = time.time() if now is None else now
    try:
        info = os.lstat(lock)
    except OSError:
        return False
    try:
        pid = int((lock / 'pid').read_text().strip())
    except (OSError, ValueError):
        return moment - info.st_mtime >= STALE_LOCK_SECONDS
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def retired_actions(child):
    """A .retired-<version>-<hex> folder a failed removal left: only plain ones, unlocked or with a
    stale lock."""
    if RETIRED.fullmatch(child.name) is None or not plain(child) or not child.is_dir():
        return []
    if os.path.lexists(child / 'lock') and not stale_lock(child / 'lock'):
        return []
    return [{'path': str(child), 'action': 'remove-retired', 'reason': 'superseded stage a failed removal left'}]


def sweep_retired(husk, actions, result):
    """Removes one husk under the stage mkdir lock, with the same pid and identity check as prune."""
    lock = husk / 'lock'
    acquired, identity = False, None
    try:
        if os.path.lexists(lock):
            # Only one sweeper can move a stale lock aside; the loser's mkdir below then fails.
            os.rename(lock, husk / ('lock.stale-' + uuid.uuid4().hex))
        lock.mkdir()
        acquired = True
        info = lock.stat()
        identity = (info.st_dev, info.st_ino)
        (lock / 'pid').write_text(str(os.getpid()) + '\n')
        remove_tree(husk)  # The lock goes with it.
        result['removed'].extend(actions)
    except OSError as error:
        result['refused'].append({'path': str(husk), 'error': type(error).__name__})
    finally:
        if acquired and lock.is_dir():
            try:
                info = lock.stat()
                if (info.st_dev, info.st_ino) == identity:
                    (lock / 'pid').unlink(missing_ok=True)
                    lock.rmdir()
            except OSError:
                pass


def stage_actions(stage, current=None, previous=None, finished=False, locked=False):
    if not owned(stage) or (os.path.lexists(stage / 'lock') and not locked):
        return []
    release = version(stage.name)
    if release is None:
        return []
    if not finished:
        if release >= current:
            return []
        if release < previous and published(stage):
            return [{'path': str(stage), 'action': 'remove-stage', 'reason': 'superseded published release'}]
        if release != previous:
            return []
    if not (completed(stage) if finished else published(stage)):
        return []
    actions = []
    sha = (stage / 'published.sha').read_text().strip()[:12]
    for child in sorted(stage.iterdir()):
        match = PAYLOAD.fullmatch(child.name)
        # The exact published candidate is known generated output; unfamiliar folders stay.
        if match and match.group(1) == sha and plain(child) and child.is_dir():
            actions.append({'path': str(child), 'action': 'remove-payload',
                            'reason': ('published, rollout complete and merged' if finished else 'published and superseded')
                            + '; receipts and history retained'})
    return actions


def prune(root, current=None, previous=None, *, finished=False, apply=False):
    root = pathlib.Path(os.path.abspath(root))
    if not plain(root) or not root.is_dir():
        return {'planned': [], 'removed': [], 'refused': ['staging root is missing or symlinked']}
    if not finished and (version(current) is None or version(previous) is None or version(previous) >= version(current)):
        raise ValueError('current and previous must be ordered X.Y.Z versions')
    current, previous = version(current), version(previous)
    result = {'planned': [], 'removed': [], 'refused': []}
    for stage in sorted(root.iterdir()):
        if RETIRED.fullmatch(stage.name):
            actions = retired_actions(stage)
            result['planned'].extend(actions)
            if apply and actions:
                sweep_retired(stage, actions, result)
            continue
        actions = stage_actions(stage, current, previous, finished)
        result['planned'].extend(actions)
        if not apply or not actions:
            continue
        lock = stage / 'lock'
        acquired = False
        lock_identity = None
        try:
            # The release runner uses this same mkdir lock. Recheck after acquiring it so a
            # release cannot resume or change publication state between plan and removal.
            lock.mkdir()
            acquired = True
            info = lock.stat()
            lock_identity = (info.st_dev, info.st_ino)
            (lock / 'pid').write_text(str(os.getpid()) + '\n')
            for action in stage_actions(stage, current, previous, finished, locked=True):
                target = pathlib.Path(action['path'])
                if action['action'] == 'remove-stage':
                    # Remove the visible stage atomically while its lock is still present.
                    # A new --resume can never enter half of a recursively removed stage.
                    retired = root / ('.retired-' + stage.name + '-' + uuid.uuid4().hex)
                    os.rename(stage, retired)
                    lock = retired / 'lock'
                    target = retired
                remove_tree(target)
                result['removed'].append(action)
        except OSError as error:
            result['refused'].append({'path': str(stage), 'error': type(error).__name__})
        finally:
            if acquired and lock.is_dir():
                try:
                    info = lock.stat()
                    if (info.st_dev, info.st_ino) != lock_identity:
                        continue
                    (lock / 'pid').unlink(missing_ok=True)
                    lock.rmdir()
                except OSError:
                    pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--current')
    parser.add_argument('--previous')
    parser.add_argument('--finished', action='store_true', help='compact completed stages; keep all receipts')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(prune(args.root, args.current, args.previous, finished=args.finished, apply=args.apply), indent=2))


if __name__ == '__main__':
    main()
