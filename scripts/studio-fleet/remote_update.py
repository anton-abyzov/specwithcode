#!/usr/bin/env python3
"""Guarded manual update of one SpecWithCode service from a staged release.

For a host whose update agent cannot install a release on its own (a manual upgrade path, or
an agent too old for the plan). Run it on the host that owns the service, with the release's
assets copied to the staging folder:

    /usr/bin/python3 -B scripts/studio-fleet/remote_update.py --identity m3 --version 1.0.37 \\
      --runtime studio-1.0.37-<sha12>.tar.gz --helpers studio-1.0.37-deployment-helpers-<sha12>.tar.gz

It checks every staged file against SHA256SUMS, unpacks the helpers, copies the live database
through live_database.snapshot (read-only and unable to reset -shm or remove -wal, the only
supported way while the service runs), then runs that release's own update.py: first
--snapshot, then the guarded apply with the snapshot as its prestate. Its exit code is the
apply's. The staging folder defaults to <studio root>/release-staging/<version>; the backup,
snapshot and receipt go to <studio root>/backups/pre-<version>-<time>/.

Those folders are not pruned. release_retention.prune_state_backups removes only the
pre-<commit>-<stamp> folders update.py writes, holding nothing but the database copy and
settings.json; a pre-<version>-<time> folder here also keeps the prestate, the helper output
and the apply receipt, which are the evidence of this manual update. The apply itself still
prunes update.py's own copies and refuses when the disk is too full for its backup; this script
refuses first, before its own copy, when the disk cannot hold both. Remove a folder here by
hand once its update is verified: each holds a full database copy.
"""
import argparse
import datetime
import hashlib
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import live_database  # noqa: E402  Shipped beside this file.
import studio_paths  # noqa: E402

SYSTEM_PYTHON = '/usr/bin/python3'
SUMS = 'SHA256SUMS'
SEMVER = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
ASSET = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,199}')
IDENTITY = re.compile(r'[a-z][a-z0-9_-]{0,31}')
ALLOWED_ARGS = ('--allow-existing-browser-heartbeat', '--allow-project-migrations')
SNAPSHOT_TIMEOUT = 900
APPLY_TIMEOUT = 1800


# update.py's BACKUP_SPACE_MARGIN: room for the staged release and for the Mac to run.
BACKUP_SPACE_MARGIN = 2 * 1024 ** 3


class UpdateError(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with open(str(path), 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_sums(staging):
    sums = {}
    for line in (staging / SUMS).read_text().splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'([0-9a-fA-F]{64}) [ *](\S+)', line.rstrip('\r'))
        if not match or match.group(2) in sums:
            raise UpdateError('SHA256SUMS has a malformed or repeated line')
        sums[match.group(2)] = match.group(1).lower()
    return sums


def verify_staging(staging, runtime, helpers):
    """Every listed file that is staged must match; the runtime and helpers must be both."""
    sums = read_sums(staging)
    for name in (runtime, helpers):
        if not ASSET.fullmatch(name) or name not in sums:
            raise UpdateError('%s is not listed in SHA256SUMS' % name)
        if not (staging / name).is_file():
            raise UpdateError('%s is not staged in %s' % (name, staging))
    checked = 0
    for name, expected in sorted(sums.items()):
        path = staging / name
        if path.is_file():
            if sha256(path) != expected:
                raise UpdateError('%s does not match SHA256SUMS' % name)
            checked += 1
    return sums, checked


def unpack_helpers(archive, destination, root):
    """Extracts the helpers archive into a new `destination`; refuses links and paths that leave it."""
    if destination.exists():
        shutil.rmtree(str(destination))
    destination.mkdir(mode=0o700)
    with tarfile.open(str(archive), 'r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            parts = pathlib.PurePosixPath(member.name).parts
            if (member.name.startswith('/') or '..' in parts or not parts or parts[0] != root
                    or not (member.isfile() or member.isdir())):
                raise UpdateError('Unsafe helpers archive entry: %s' % member.name)
        for member in members:
            target = destination.joinpath(*pathlib.PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with bundle.extractfile(member) as source, open(str(target), 'wb') as sink:
                shutil.copyfileobj(source, sink)
            os.chmod(str(target), 0o755 if member.mode & 0o111 else 0o644)
    helpers = destination / root
    if not (helpers / 'scripts/studio-fleet/update.py').is_file():
        raise UpdateError('The helpers archive has no scripts/studio-fleet/update.py')
    return helpers


def backup_database(database, backup):
    """Copies the live database with live_database.snapshot, then checks the copy in full."""
    result = live_database.snapshot(database, backup / 'statev2.sqlite')
    copy = sqlite3.connect(str(backup / 'statev2.sqlite'))  # This process's own new file.
    try:
        integrity = copy.execute('PRAGMA integrity_check').fetchone()[0]
    finally:
        copy.close()
    if integrity != 'ok':
        raise UpdateError('The database backup failed integrity_check: %s' % integrity)
    return result


def assert_backup_space(database, backups, usage=None):
    """Refuses before any copy when the disk cannot hold both database copies: this one and
    the one the apply makes for its rollback, each the size of the database and its log,
    plus update.py's margin. Sizes come from stat alone: the live database is not opened."""
    size = 0
    for path in (database, database.with_name(database.name + '-wal')):
        try:
            size += os.stat(str(path)).st_size
        except FileNotFoundError:
            pass
    needed = 2 * size + BACKUP_SPACE_MARGIN
    root = backups
    while not root.exists() and root != root.parent:
        root = root.parent  # The first update makes the backups folder; measure its disk.
    free = (usage or shutil.disk_usage)(str(root)).free
    if free < needed:
        raise UpdateError('Not enough free disk space for the pre-update backup: needs %.1f GB, %.1f GB free; '
                          'nothing was copied or applied' % (needed / 1e9, free / 1e9))


def run_helper(python, helpers, argv, log, timeout):
    with open(str(log), 'wb') as output:
        try:
            result = subprocess.run([python, '-B', 'scripts/studio-fleet/update.py'] + argv, cwd=str(helpers),
                                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 124
    return result.returncode


def tail(path, lines=5):
    try:
        return path.read_text(errors='replace').splitlines()[-lines:]
    except OSError:
        return []


def update(home, identity, version, runtime, helpers_asset, staging=None, extra_args=('--allow-existing-browser-heartbeat',),
           python=None, now=None, say=print):
    if not IDENTITY.fullmatch(identity or ''):
        raise UpdateError('Invalid identity %r' % identity)
    if not SEMVER.fullmatch(version or ''):
        raise UpdateError('Invalid version %r' % version)
    for flag in extra_args:
        if flag not in ALLOWED_ARGS:
            raise UpdateError('update.py flag %s is not allowed here' % flag)
    if not helpers_asset.endswith('.tar.gz'):
        raise UpdateError('The helpers asset must be a .tar.gz')
    home = pathlib.Path(home)
    staging = pathlib.Path(staging) if staging else studio_paths.studio_root(home) / 'release-staging' / version
    database = studio_paths.identity_home(home, identity) / 'userdata' / 'statev2.sqlite'
    if not database.is_file():
        raise UpdateError('%s has no database at %s' % (identity, database))
    sums, checked = verify_staging(staging, runtime, helpers_asset)
    say('staging: %d files match SHA256SUMS' % checked)
    helpers = unpack_helpers(staging / helpers_asset, staging / 'helpers', helpers_asset[:-len('.tar.gz')])
    stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    backup = studio_paths.backups_root(home) / ('pre-%s-%s' % (version, stamp))
    assert_backup_space(database, backup.parent)
    backup.mkdir(parents=True, mode=0o700)
    copied = backup_database(database, backup)
    say('backup: %s (%d bytes, integrity ok)' % (copied['path'], copied['bytes']))
    python = python or (SYSTEM_PYTHON if os.path.exists(SYSTEM_PYTHON) else sys.executable)
    prestate = backup / 'prestate.json'
    code = run_helper(python, helpers, ['--identity', identity, '--snapshot', str(prestate)],
                      backup / 'snapshot.out', SNAPSHOT_TIMEOUT)
    for line in tail(backup / 'snapshot.out'):
        say('snapshot: ' + line)
    if code != 0:
        raise UpdateError('update.py --snapshot exited %d; nothing was applied (backup %s)' % (code, backup))
    code = run_helper(python, helpers, ['--identity', identity, '--prestate', str(prestate),
                                        '--archive', str(staging / runtime), '--sha256', sums[runtime],
                                        '--output', str(backup / ('receipt-%s.json' % version))] + list(extra_args),
                      backup / 'apply.out', APPLY_TIMEOUT)
    for line in tail(backup / 'apply.out'):
        say('apply: ' + line)
    say('apply exit %d, backup %s' % (code, backup))
    return code


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--identity', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--runtime', required=True, help='runtime asset name, studio-<version>-<sha12>.tar.gz')
    parser.add_argument('--helpers', required=True, help='helpers asset name')
    parser.add_argument('--staging', type=pathlib.Path, help='folder with the assets and SHA256SUMS')
    parser.add_argument('--allow-project-migrations', action='store_true',
                        help="pass update.py's --allow-project-migrations (only for a release that migrates)")
    parser.add_argument('--home', help=argparse.SUPPRESS)  # Tests only: a temporary private home.
    parser.add_argument('--python', help=argparse.SUPPRESS)  # Tests only: the interpreter for update.py.
    args = parser.parse_args(argv)
    extra = ['--allow-existing-browser-heartbeat'] + (['--allow-project-migrations'] if args.allow_project_migrations else [])
    try:
        return update(pathlib.Path(args.home) if args.home else pathlib.Path.home(), args.identity, args.version,
                      args.runtime, args.helpers, args.staging, extra, args.python)
    except (UpdateError, OSError, sqlite3.Error, tarfile.TarError, ValueError, RuntimeError) as error:
        print('remote_update: %s' % error, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
