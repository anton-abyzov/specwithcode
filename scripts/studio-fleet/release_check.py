#!/usr/bin/env python3
"""The installed release and its running service, checked before any database is read.

release_verified proves an unpacked release holds exactly the files its manifest names, with
their sha256. One update asks it many times about the same two releases (each service check,
both held-snapshot checks, staging, publication and every 0.5 s readiness poll), and a full pass
over a ~340 MB release took seconds each time. The first full pass in a process records each
file's identity (device, inode, size, mtime and ctime, in nanoseconds) taken before its bytes
were read; a later call re-hashes only when any of that differs, the manifest or package.json
bytes changed, or the release's file set changed (checked on every call). A write to a file
always moves its ctime, which no caller can set back, so a byte rewritten at the same size is
hashed again and refused. A file changed within RACY_NANOSECONDS of the pass is not recorded, so
a write a coarse timestamp (HFS+ keeps whole seconds) would hide is hashed on the next call too.
The record lives in this process's memory only: nothing on disk can claim a release was verified.

service (update._service) verifies the installation's receipt, LaunchAgent, launcher, runtime
record, port owner and executable, and reads no database.
"""
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shlex
import time

from installation_descriptor import InstallationDescriptor, owned_path, validate_identity
from launcher import migrate_runtime_path, render_cli, render_legacy_cli, render_unnamed_cli
from release_policy import validate_manifest, validate_package
import studio_paths

ENV_KEYS = {'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'STUDIO_HOME',
            'STUDIO_HOST', 'STUDIO_PORT', 'STUDIO_MODE', 'STUDIO_NO_BROWSER',
            'STUDIO_LOG_LEVEL', 'STUDIO_ENABLE_HOSTED_SERVICES', 'STUDIO_DEV_ALLOWED_ORIGINS',
            'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD', 'PWDEBUG', 'PLAYWRIGHT_HTML_OPEN'}

# (st_dev, st_ino) of a release folder -> what its last full pass proved. The folder's own
# identity, not its path, so the staged release renamed into releases/ keeps its record.
_VERIFIED = {}
# A file whose mtime or ctime is this close to a pass is hashed again by the next one.
RACY_NANOSECONDS = 2 * 10 ** 9


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def release_manifest(release):
    """A release's validated manifest, without checking a file: for a release this process has
    verified already, or one release_verified checks before any pointer can name it."""
    assert release.is_dir() and not release.is_symlink()
    manifest = json.loads((release / 'studio-manifest.json').read_bytes())
    validate_manifest(manifest)
    return manifest


def _listing(release):
    """{path relative to `release`: os.DirEntry} of every file and link beneath it. Links are listed,
    never followed, so a file reached through a linked folder is not listed at all. One scandir per
    folder: the pathlib walk and per-file resolve() it replaces took 2.3 s a call on a 7,800-file
    release, and the readiness check after a restart makes one (October 2026)."""
    listed, pending = {}, ['']
    while pending:
        prefix = pending.pop()
        with os.scandir(os.path.join(str(release), prefix)) as entries:
            for entry in entries:
                name = prefix + entry.name
                if entry.is_dir(follow_symlinks=False):
                    pending.append(name + '/')
                elif entry.is_file(follow_symlinks=False) or entry.is_symlink():
                    listed[name] = entry
    return listed


def release_verified(release):
    assert release.is_dir() and not release.is_symlink()
    folder = os.lstat(str(release))
    manifest_bytes = (release / 'studio-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    validate_manifest(manifest)
    package = release / 'package.json'
    package_bytes = package.read_bytes() if package.is_file() else None
    validate_package(manifest, package_bytes)
    known = _VERIFIED.get((folder.st_dev, folder.st_ino))
    sealed = (_sha256(manifest_bytes), None if package_bytes is None else _sha256(package_bytes))
    hashed = full = known is None or known['sealed'] != sealed
    trusted_before = time.time_ns() - RACY_NANOSECONDS
    identities, declared, listed = {}, set(), _listing(release)
    for entry in manifest['files']:
        declared.add(entry['path'])
        found = listed.get(entry['path'])
        assert found is not None, 'Artifact path escapes release'
        if entry['type'] == 'symlink':
            path = release / entry['path']
            assert release in path.resolve().parents, 'Artifact path escapes release'
            assert found.is_symlink() and os.readlink(found.path) == entry['target']
            continue
        # Listed under real folders only (_listing), so it lies inside the release.
        assert found.is_file(follow_symlinks=False)
        info = found.stat(follow_symlinks=False)  # Before the read: a write during it shows on the next call.
        recent = max(info.st_mtime_ns, info.st_ctime_ns) >= trusted_before
        identities[entry['path']] = None if recent else _identity(info)
        recorded = None if full else known['files'].get(entry['path'])
        if recorded is None or recorded != identities[entry['path']]:
            hashed = True
            with open(found.path, 'rb') as handle:
                assert _sha256(handle.read()) == entry['sha256']
    assert set(listed) == declared | {'studio-manifest.json'}
    if hashed:
        _VERIFIED[(folder.st_dev, folder.st_ino)] = {'sealed': sealed, 'files': identities}
    return manifest


def service(identity, run, listeners, release_verified=release_verified):
    """update._service: `run`, `listeners` and `release_verified` are update.py's, looked up per call."""
    validate_identity(identity)
    owner = InstallationDescriptor(identity, require_policy=False)
    home, own, installation = owner.home, owner.own, owner.installation
    receipt = json.loads(installation.read_text())
    owner = InstallationDescriptor.from_receipt(identity, receipt, home=home)
    label, plist, wrapper, launcher, port = owner.label, owner.plist, owner.wrapper, owner.launcher, owner.port
    node = pathlib.Path(receipt['node'])
    assert node.is_absolute() and node.is_file() and run([str(node), '--version']).strip() == b'v22.20.0', \
        'The Node.js runtime is missing or is not v22.20.0'
    release = owned_path(pathlib.Path(receipt['release']), home)
    assert release == studio_paths.releases_root(home) / receipt['archiveSha256'][:20], \
        'The installed release is outside the owned releases folder'
    manifest = release_verified(release)
    assert manifest['sourceCommit'] == receipt['sourceCommit'] and manifest['product'] == 'SpecWeave Studio', \
        'The installed release does not match its receipt'
    content = plistlib.loads(plist.read_bytes())
    assert content['Label'] == label and content['ProgramArguments'] == ['/usr/bin/caffeinate', '-s', str(launcher)], \
        'The service LaunchAgent does not match the installation'
    assert content['WorkingDirectory'] == str(own) and content['StandardOutPath'] == str(own / 'stdout.log') and content['StandardErrorPath'] == str(own / 'stderr.log'), \
        'The service LaunchAgent does not match the installation'
    lines = launcher.read_text().splitlines()
    assert lines[:4] == ['#!/bin/sh', 'set -eu', 'umask 077', 'cd ' + shlex.quote(str(own))] and len(lines) == 5, \
        'The service launcher does not match the installation'
    tokens = shlex.split(lines[4])
    assert tokens[:4] == ['exec', '/usr/bin/env', '-i', 'HOME=' + str(home)], 'The service launcher does not match the installation'
    index = tokens.index(str(node))
    environment = dict(token.split('=', 1) for token in tokens[3:index])
    assert len(environment) == index - 3 and set(environment).issubset(ENV_KEYS), 'The service launcher sets unexpected variables'
    assert environment.get('USER') == environment.get('LOGNAME') == owner.user, 'Launcher names another OS user'
    assert environment['STUDIO_HOME'] == str(own) and environment['STUDIO_PORT'] == str(port), 'The service launcher does not match the installation'
    assert environment['STUDIO_HOST'] == '127.0.0.1' and environment['STUDIO_MODE'] == 'web', 'The service launcher does not match the installation'
    assert environment['STUDIO_NO_BROWSER'] == 'true' and environment['STUDIO_ENABLE_HOSTED_SERVICES'] == 'false', \
        'The service launcher does not match the installation'
    assert tokens[index:] == [str(node), str(release / 'bin.mjs'), 'start', '--no-browser', '--host', '127.0.0.1', '--port', str(port), '--base-dir', str(own), '--mode', 'web'], \
        'The service launcher does not match the installation'
    prefix = tokens[1:index + 2]
    migrate_runtime_path(prefix, home, node)  # Reject missing/custom paths even for a read-only prestate.
    # Any wrapper format a Studio release wrote; an update rewrites it in the current one.
    assert wrapper.read_text() in {render_legacy_cli(prefix), render_unnamed_cli(prefix), render_cli(prefix)}, \
        'The specweave-studio command does not match the installation'
    live = run(['/bin/launchctl', 'print', owner.domain + '/' + label], text=True)
    pid = re.search(r'^\s*pid = (\d+)\s*$', live, re.M)
    assert pid and re.search(r'^\s*state = running\s*$', live, re.M) and 'path = ' + str(plist) in live, \
        'The SpecWithCode service is not running'
    runtime = json.loads((own / 'userdata/server-runtime.json').read_text())
    assert runtime['pid'] == int(pid.group(1)) and runtime['host'] == '127.0.0.1' and runtime['port'] == port, \
        'The running service does not match its runtime record'
    assert listeners(port) == [runtime['pid']], 'Port belongs to another process'
    command = run(['/bin/ps', '-p', str(runtime['pid']), '-o', 'command='], text=True)
    assert str(node) in command and str(release / 'bin.mjs') in command, 'Running executable does not match the owned release'
    return {'home': home, 'own': own, 'installation': installation, 'receipt': receipt, 'label': label, 'plist': plist,
            'wrapper': wrapper, 'launcher': launcher, 'content': content, 'node': node, 'runtime': runtime, 'owner': owner}
