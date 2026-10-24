#!/usr/bin/env python3
"""Keeps desktop app rollback copies where macOS does not treat them as apps.

A loose `.app` copy under ~/.specwithcode/backups is indexed by Spotlight
and registered with Launch Services. Every copy shares the bundle id
com.specweave.studio, so Spotlight lists several "SpecWithCode" apps and
`open -b` can start an old copy that then pairs with the running service.

This is the only supported way to keep a desktop rollback copy:
- `snapshot APP` clones the bundle (APFS, `cp -c`: no new blocks, well under a
  second) into ~/.specwithcode/backups/desktop.noindex/<version>-<timestamp>.noindex,
  a folder without the `.app` suffix that Launch Services does not take for an
  app. Where APFS cannot clone it there (another volume, another file system)
  it zips the bundle with `ditto` into <version>-<timestamp>.zip instead;
- `restore COPY` puts either kind of copy back as an app in /Applications;
- `prune` keeps the most recently made copies of either kind (one by default);
- `migrate` copies every loose `.app` that earlier release sessions left under
  backups/ (and any `--extra` paths), removes the loose copy and drops it from
  Launch Services.

It only handles bundles with the id com.specweave.studio, and never touches an
app that sits directly in /Applications or ~/Applications, or one that is
running.
"""
import argparse
import ctypes
import json
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys
import time
import zipfile
import studio_paths

LSREGISTER = ('/System/Library/Frameworks/CoreServices.framework/Frameworks/'
              'LaunchServices.framework/Support/lsregister')
BUNDLE_ID = 'com.specweave.studio'
# A zip, or a clone: the bundle itself under a name without `.app`.
ARCHIVE_NAME = re.compile(
    r'(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?-(\d{8}T\d{6}Z)(?:-\d+)?\.(zip|noindex)')
BUNDLE_NAME = re.compile(r'[0-9A-Za-z][0-9A-Za-z ()._-]{0,63}')


def backups_root(home):
    return studio_paths.backups_root(home)


def archive_root(home):
    # The `.noindex` suffix keeps Spotlight out of the folder.
    return backups_root(home) / 'desktop.noindex'


def bundle_info(app):
    with open(pathlib.Path(app) / 'Contents' / 'Info.plist', 'rb') as handle:
        info = plistlib.load(handle)
    if not isinstance(info, dict):
        raise ValueError('%s has no readable Info.plist' % app)
    return info


def bundle_id(app):
    try:
        value = bundle_info(app).get('CFBundleIdentifier')
    except (OSError, ValueError, plistlib.InvalidFileException):
        return None
    return value if isinstance(value, str) else None


def bundle_version(app):
    version = bundle_info(app).get('CFBundleShortVersionString')
    if not isinstance(version, str) or not re.fullmatch(r'[0-9A-Za-z.+-]{1,64}', version):
        raise ValueError('%s has no readable version' % app)
    return version


def is_live_install(app):
    """True for a bundle that is an installed app rather than a copy of one."""
    parent = pathlib.Path(app).resolve().parent
    return parent in {pathlib.Path('/Applications'), pathlib.Path.home() / 'Applications'}


def running_bundles():
    try:
        output = subprocess.run(['/bin/ps', '-axo', 'comm='], capture_output=True, text=True,
                                timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return output.splitlines()


def is_running(app, processes):
    if processes is None:
        return True  # Unknown counts as running: never remove what may be in use.
    prefix = str(pathlib.Path(app).resolve()) + '/'
    return any(line.startswith(prefix) for line in processes)


def unregister(app):
    """Drops a bundle path from Launch Services; the path may already be gone."""
    try:
        subprocess.run([LSREGISTER, '-u', str(app)], capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        pass


def unique_archive(root, version, stamp, suffix='.zip'):
    target = root / ('%s-%s%s' % (version, stamp, suffix))
    counter = 1
    while target.exists():
        target = root / ('%s-%s-%d%s' % (version, stamp, counter, suffix))
        counter += 1
    return target


def clone_supported(app, root):
    """True when APFS clones files of `app` into `root`.

    `cp -c` falls back to a full copy where it cannot clone, which would keep
    the whole uncompressed bundle; a clone of one file tells first.
    """
    try:
        clonefile = ctypes.CDLL(None, use_errno=True).clonefile
    except (OSError, AttributeError):
        return False  # Not macOS.
    probe = root / ('.clone-probe-%d' % os.getpid())
    probe.unlink(missing_ok=True)
    source = pathlib.Path(app) / 'Contents' / 'Info.plist'
    if clonefile(os.fsencode(str(source)), os.fsencode(str(probe)), 0) != 0:
        return False
    probe.unlink(missing_ok=True)
    return True


def clone(app, root, version, stamp):
    """Clones `app` into `root` and returns the copy, or None where cloning fails."""
    if not clone_supported(app, root):
        return None
    target = unique_archive(root, version, stamp, '.noindex')
    partial = target.with_name(target.name + '.partial')
    try:
        subprocess.run(['/bin/cp', '-c', '-p', '-R', str(app), str(partial)],
                       check=True, capture_output=True, timeout=1800)
    except (OSError, subprocess.SubprocessError):
        shutil.rmtree(partial, ignore_errors=True)
        return None
    os.chmod(partial, 0o700)
    os.replace(partial, target)
    return target


def snapshot(app, home, now=None):
    """Clones (or else zips) `app` into the archive folder and returns the copy."""
    app = pathlib.Path(app)
    if app.suffix != '.app' or app.is_symlink() or not app.is_dir():
        raise ValueError('%s is not an app bundle' % app)
    if bundle_id(app) != BUNDLE_ID:
        raise ValueError('%s is not a %s bundle' % (app, BUNDLE_ID))
    version = bundle_version(app)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now if now is not None else time.time()))
    root = archive_root(home)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    cloned = clone(app, root, version, stamp)
    if cloned is not None:
        return cloned
    target = unique_archive(root, version, stamp)
    partial = target.with_name(target.name + '.partial')
    subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(partial)],
                   check=True, timeout=1800)
    os.chmod(partial, 0o600)
    os.replace(partial, target)
    return target


def is_archive(path):
    if path.is_symlink() or not ARCHIVE_NAME.fullmatch(path.name):
        return False
    return path.is_file() if path.suffix == '.zip' else path.is_dir()


def restored_name(archive):
    """The bundle name a copy comes back under."""
    if archive.suffix == '.zip':
        # ditto --keepParent puts the bundle at the top, beside __MACOSX.
        with zipfile.ZipFile(archive) as handle:
            tops = {name.split('/', 1)[0] for name in handle.namelist()}
        bundles = sorted(top for top in tops if top.endswith('.app'))
        if len(bundles) != 1 or not BUNDLE_NAME.fullmatch(bundles[0][:-4]):
            raise ValueError('%s holds no single app bundle' % archive)
        return bundles[0]
    name = bundle_info(archive).get('CFBundleName')
    return '%s.app' % (name if isinstance(name, str) and BUNDLE_NAME.fullmatch(name) else 'SpecWithCode')


def restore(archive, destination='/Applications'):
    """Puts a rollback copy back as an app in `destination` and returns its path.

    Refuses when that app already exists: quit it and move it to the Trash
    first, as extracting over it would mix both versions.
    """
    archive = pathlib.Path(archive)
    if not is_archive(archive):
        raise ValueError('%s is not a rollback copy' % archive)
    destination = pathlib.Path(destination)
    target = destination / restored_name(archive)
    if target.exists() or target.is_symlink():
        raise ValueError('%s exists; move it to the Trash first' % target)
    if archive.suffix == '.zip':
        subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(destination)],
                       check=True, timeout=1800)
        return target
    partial = destination / (target.name[:-4] + '.restore-partial')
    shutil.rmtree(partial, ignore_errors=True)
    try:
        subprocess.run(['/bin/cp', '-c', '-p', '-R', str(archive), str(partial)],
                       check=True, capture_output=True, timeout=1800)
        os.chmod(partial, 0o755)
        os.replace(partial, target)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    return target


def archive_sort_key(path):
    # Newest copy first: the time the copy was made decides, not the version,
    # so a higher-version dev or rolled-back build never evicts a fresh copy.
    match = ARCHIVE_NAME.fullmatch(path.name)
    if match is None:
        return ('', 0, 0, 0, path.name)
    major, minor, patch, stamp, _kind = match.groups()
    return (stamp, int(major), int(minor), int(patch), path.name)


def prune(home, keep=1, protect=()):
    """Keeps the `keep` most recently made archives and deletes the rest.

    Archives in `protect` (the one just written) always stay and count
    towards `keep`.
    """
    root = archive_root(home)
    if not root.is_dir() or root.is_symlink():
        return []
    protected = {pathlib.Path(path).resolve() for path in protect}
    archives = sorted((path for path in root.iterdir() if is_archive(path)),
                      key=archive_sort_key, reverse=True)
    kept = [path for path in archives if path.resolve() in protected]
    removed = []
    for path in archives:
        if path.resolve() in protected:
            continue
        if len(kept) < max(keep, 0):
            kept.append(path)
            continue
        if path.suffix == '.zip':
            path.unlink()
        else:
            shutil.rmtree(path)
        removed.append(path)
    return removed


def loose_copies(home):
    """Every `.app` directly under backups/ or one level down in a desktop-* folder."""
    root = backups_root(home)
    if not root.is_dir() or root.is_symlink():
        return []
    found = []
    for entry in sorted(root.iterdir()):
        if entry.is_symlink():
            continue
        if entry.suffix == '.app' and entry.is_dir():
            found.append(entry)
        elif entry.is_dir() and entry.name.startswith('desktop-'):
            found.extend(child for child in sorted(entry.iterdir())
                         if child.suffix == '.app' and child.is_dir() and not child.is_symlink())
    return found


def expand_extra(path):
    path = pathlib.Path(path)
    if path.suffix == '.app':
        return [path]
    if path.is_dir() and not path.is_symlink():
        return [child for child in sorted(path.iterdir())
                if child.suffix == '.app' and child.is_dir() and not child.is_symlink()]
    return []


def migrate(home, extra=(), keep=1, processes=None, now=None):
    """Copies every loose copy away, removes it, unregisters it and prunes. Returns a report."""
    processes = running_bundles() if processes is None else processes
    report = {'archived': [], 'skipped': [], 'failed': [], 'removedFolders': [], 'pruned': []}
    candidates = loose_copies(home)
    for path in extra:
        candidates.extend(expand_extra(path))
    for app in candidates:
        if bundle_id(app) != BUNDLE_ID:
            report['skipped'].append({'path': str(app), 'reason': 'not a %s bundle' % BUNDLE_ID})
            continue
        if is_live_install(app):
            report['skipped'].append({'path': str(app), 'reason': 'installed app'})
            continue
        if is_running(app, processes):
            report['skipped'].append({'path': str(app), 'reason': 'running'})
            continue
        try:
            stamp_time = app.stat().st_mtime
            archive = snapshot(app, home, now=stamp_time if now is None else now)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            report['skipped'].append({'path': str(app), 'reason': str(error)})
            continue
        try:
            shutil.rmtree(app)
        except OSError as error:
            # The archive already holds the copy. Drop the half-removed bundle from
            # Launch Services and carry on with the rest.
            unregister(app)
            report['failed'].append({'path': str(app), 'archive': str(archive),
                                     'reason': 'could not remove: %s' % error})
            continue
        unregister(app)
        report['archived'].append({'from': str(app), 'to': str(archive)})
        holder = app.parent
        if holder != backups_root(home) and holder.name.startswith(('desktop-', '.specweave-studio-')):
            try:
                holder.rmdir()
                report['removedFolders'].append(str(holder))
            except OSError:
                pass
    report['pruned'] = [str(path) for path in prune(home, keep)]
    return report


def main(argv=None):
    # `--keep` works before or after the command (`--keep 1 prune`, `prune --keep 1`).
    keep_option = argparse.ArgumentParser(add_help=False)
    keep_option.add_argument('--keep', type=int, default=argparse.SUPPRESS,
                             help='how many rollback copies to keep (default 1)')
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0], parents=[keep_option])
    parser.add_argument('--home', default=str(pathlib.Path.home()))
    commands = parser.add_subparsers(dest='command', required=True)
    take = commands.add_parser('snapshot', parents=[keep_option], help='clone or zip an app bundle as a rollback copy')
    take.add_argument('app')
    back = commands.add_parser('restore', help='put a rollback copy back as an app')
    back.add_argument('archive')
    back.add_argument('--to', default='/Applications', help='folder to restore into (default /Applications)')
    commands.add_parser('prune', parents=[keep_option], help='keep only the newest rollback copies')
    move = commands.add_parser('migrate', parents=[keep_option], help='archive and remove loose .app rollback copies')
    move.add_argument('--extra', action='append', default=[],
                      help='another backup .app, or a folder holding one, to migrate')
    args = parser.parse_args(argv)
    # Not set_defaults: the parsers share the --keep action, so a default there
    # would overwrite a value given before the command.
    args.keep = getattr(args, 'keep', 1)
    if args.command == 'snapshot':
        # Cloning or zipping reads the bundle only, so the installed app itself may be the source.
        archive = snapshot(args.app, args.home)
        pruned = prune(args.home, args.keep, protect=[archive])
        result = {'archive': str(archive), 'pruned': [str(path) for path in pruned]}
    elif args.command == 'restore':
        result = {'restored': str(restore(args.archive, args.to))}
    elif args.command == 'prune':
        result = {'pruned': [str(path) for path in prune(args.home, args.keep)]}
    else:
        result = migrate(args.home, args.extra, args.keep)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
