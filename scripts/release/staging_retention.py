#!/usr/bin/env python3
"""Retain release evidence, not duplicate build payloads. Dry-run unless --apply.

Normal publication removes stages older than the previous release and compacts a completed
previous stage. --finished compacts completed unlocked stages without deleting their receipts.
A compacted release retains release.json, published/candidate SHAs, stage markers, logs, timing
and stage-1 history. They are what later releases read; shipped binaries live in the release
stores. Incomplete releases and every lock (including a stale lock) require their owner.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import uuid

VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
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


def completed(stage):
    if not all(marker(stage, name) for name in ('publish-private', 'publish-public', 'fleet-m4', 'desktop', 'fleet-workers', 'merge', 'fleet-linux')):
        return False
    path = stage / 'published.sha'
    try:
        return plain(path) and path.is_file() and re.fullmatch('[a-f0-9]{40}', path.read_text().strip()) is not None
    except OSError:
        return False


def stage_actions(stage, current=None, previous=None, finished=False, locked=False):
    if not owned(stage) or (os.path.lexists(stage / 'lock') and not locked):
        return []
    release = version(stage.name)
    if release is None:
        return []
    if not finished:
        if release >= current:
            return []
        if release < previous and completed(stage):
            return [{'path': str(stage), 'action': 'remove-stage', 'reason': 'superseded release with completed rollout'}]
        if release != previous:
            return []
    if not completed(stage):
        return []
    actions = []
    published = (stage / 'published.sha').read_text().strip()[:12]
    for child in sorted(stage.iterdir()):
        match = PAYLOAD.fullmatch(child.name)
        # The exact published candidate is known generated output; unfamiliar folders stay.
        if match and match.group(1) == published and plain(child) and child.is_dir():
            actions.append({'path': str(child), 'action': 'remove-payload',
                            'reason': 'published, rollout complete and merged; receipts and history retained'})
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
                shutil.rmtree(target)  # Descendant symlinks are unlinked, never traversed.
                result['removed'].append(action)
        except OSError as error:
            result['refused'].append({'path': str(stage), 'error': type(error).__name__})
        finally:
            if acquired and lock.is_dir():
                try:
                    info = lock.stat()
                    if (info.st_dev, info.st_ino) != lock_identity:
                        continue
                    (lock / 'pid').unlink()
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
