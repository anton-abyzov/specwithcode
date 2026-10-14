#!/usr/bin/env python3
"""Install one owned, verified Studio artifact without touching existing apps or auth."""
if not __debug__:
    raise RuntimeError("Optimized Python is unsupported for installer safety checks")

import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import pwd
import shlex
import socket
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
from installation_descriptor import InstallationDescriptor, WEB_SESSION_POLICIES, installation_lock
from launcher import render_cli, runtime_path
from release_policy import validate_manifest, validate_package

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True)
parser.add_argument('--sha256', required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--identity', required=True)
parser.add_argument('--web-session-policy', choices=WEB_SESSION_POLICIES)
parser.add_argument('--port', type=int, default=8319)
parser.add_argument('--trusted-origin', action='append', default=[])
parser.add_argument('--codex', default='')
parser.add_argument('--claude', default='')
parser.add_argument('--service', action='store_true')
parser.add_argument('--install-cli', action='store_true')
args = parser.parse_args()
os.umask(0o077)
assert args.identity != 'stage' or not args.service, 'Private staging cannot install a service'
owner = InstallationDescriptor(args.identity, staging=args.identity == 'stage',
                               policy=args.web_session_policy, require_policy=args.service)
home = owner.home
archive = pathlib.Path(args.archive).resolve(strict=True)
node = pathlib.Path(args.node).resolve(strict=True)
assert subprocess.check_output([str(node), '--version'], text=True).strip() == 'v22.20.0'
assert 1024 <= args.port <= 65535
for origin in args.trusted_origin:
    assert origin.startswith(('http://127.0.0.1:', 'https://')) and '*' not in origin
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
assert digest == args.sha256, 'Archive hash mismatch'
base = home / '.local/share/specweave-studio'
for relative_root in ['.local/share/specweave-studio/releases', '.specweave-studio']:
    ancestor = home
    for part in pathlib.Path(relative_root).parts:
        ancestor = ancestor / part
        assert not ancestor.is_symlink(), 'Studio root has a symlink ancestor'
release = base / 'releases' / digest[:20]
stage = release.with_name(release.name + '.stage-' + str(os.getpid()))
studio_home = home / '.specweave-studio' / args.identity
state = studio_home / 'userdata'
launcher = studio_home / 'launch.sh'
stdout = studio_home / 'stdout.log'
stderr = studio_home / 'stderr.log'
installation = studio_home / 'installation.json'
label = 'com.specweave.studio.' + args.identity
plist = home / 'Library/LaunchAgents' / (label + '.plist')
cli = owner.wrapper
# The same wrapper under the display name; created and owned together with `cli`.
cli_alias = owner.alias

def guard_write_destination(path, directory=False):
    """Inspect lexical components before mkdir/write; resolve would hide aliases."""
    owner.path(path)
    relative = path.relative_to(home)
    ancestor = home
    for part in relative.parts:
        assert part not in {'.', '..'}, 'Unsafe installer destination component'
        ancestor = ancestor / part
        # is_symlink also catches dangling links, whose exists() is false.
        assert not ancestor.is_symlink(), 'Installer destination has a symlink ancestor'
        if ancestor.exists() and (ancestor != path or directory):
            assert ancestor.is_dir(), 'Installer destination has a non-directory ancestor'

# Validate every selected initial write, including late CLI/plist writes, before
# the first mkdir. Artifact graph checks remain separate and unchanged below.
for destination in [release.parent, release, stage, studio_home, state]:
    guard_write_destination(destination, directory=True)
for destination in [state / 'settings.json', launcher, stdout, stderr, installation]:
    guard_write_destination(destination)
if args.install_cli:
    guard_write_destination(cli)
    guard_write_destination(cli_alias)
if args.service:
    guard_write_destination(plist)
# Every install is initially exclusive. Existing user state/services are never adopted.
assert not studio_home.exists() and not studio_home.is_symlink(), 'Studio destination already exists; use an explicit owned update'
assert not plist.exists() and not plist.is_symlink(), 'Launch agent already exists'
if args.service:
    result = subprocess.run(['/bin/launchctl', 'print', owner.domain + '/' + label],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert result.returncode != 0, 'Launch agent label is already loaded'
if args.install_cli:
    assert not cli.exists() and not cli.is_symlink(), 'CLI wrapper already exists'
    assert not cli_alias.exists() and not cli_alias.is_symlink(), 'CLI alias already exists'
sock = socket.socket()
try:
    sock.bind(('127.0.0.1', args.port))
finally:
    sock.close()
assert not release.is_symlink(), 'Release directory may not be a symlink'
with tarfile.open(str(archive), 'r:gz') as tar:
    member = tar.getmember('./studio-manifest.json')
    assert member.isfile(), 'Archive manifest is not a regular file'
    expected_manifest = tar.extractfile(member).read()
    manifest = json.loads(expected_manifest)
    validate_manifest(manifest)
    package_member = tar.getmember("./package.json") if "./package.json" in tar.getnames() else None
    assert package_member is None or package_member.isfile(), "Artifact package must be a regular file"
    package = tar.extractfile(package_member).read() if package_member else None
    validate_package(manifest, package)
with installation_lock(home, create=True):
    # Admission checked before the first write is checked again under the shared store lock.
    assert not studio_home.exists() and not studio_home.is_symlink(), 'Studio destination already exists'
    assert not plist.exists() and not plist.is_symlink(), 'Launch agent already exists'
    if args.install_cli:
        assert not cli.exists() and not cli.is_symlink() and not cli_alias.exists() and not cli_alias.is_symlink(), 'CLI launcher already exists'
    release.parent.mkdir(parents=True, exist_ok=True)
    if not release.exists():
        stage.mkdir(mode=0o700)
        with tarfile.open(str(archive), 'r:gz') as tar:
            members = tar.getmembers()
            declared = {entry['path']: entry for entry in json.loads(expected_manifest)['files']}
            names = [str(pathlib.PurePosixPath(member.name)) for member in members]
            assert len(names) == len(set(names)), 'Duplicate archive paths'
            links = {str(pathlib.PurePosixPath(member.name)): member.linkname
                     for member in members if member.issym()}
            def checked_target(parts):
                """Resolve the complete link graph before extraction, without filesystem assumptions."""
                remaining, stack, expanded = list(parts), [], 0
                while remaining:
                    part = remaining.pop(0)
                    if part == '.':
                        continue
                    if part == '..':
                        assert stack, 'Composed archive link escapes extraction root'
                        stack.pop()
                        continue
                    stack.append(part)
                    target = links.get('/'.join(stack))
                    if target is not None:
                        expanded += 1
                        assert expanded < 100, 'Cyclic archive link'
                        target_path = pathlib.PurePosixPath(target)
                        assert not target_path.is_absolute(), 'Absolute archive link'
                        stack.pop()
                        remaining = list(target_path.parts) + remaining
                return stack
            for member in members:
                path = pathlib.PurePosixPath(member.name)
                assert not path.is_absolute() and '..' not in path.parts, 'Unsafe archive member'
                assert member.isfile() or member.isdir() or member.issym(), 'Unsupported archive entry'
                assert not any('/'.join(path.parts[:index]) in links
                               for index in range(1, len(path.parts))), 'Archive member has a symlink ancestor'
                if member.issym():
                    assert not pathlib.PurePosixPath(member.linkname).is_absolute(), 'Absolute archive link'
                    checked_target(list(path.parent.parts) + list(pathlib.PurePosixPath(member.linkname).parts))
                if not member.isdir():
                    assert str(path) in declared or str(path) == 'studio-manifest.json', 'Unindexed archive member'
            # Python3.9 on workers lacks extractall(filter=); members have been checked above.
            tar.extractall(str(stage), members=members)
        manifest = json.loads((stage / 'studio-manifest.json').read_text())
        for entry in manifest['files']:
            path = stage / entry['path']
            assert stage in path.resolve().parents, 'Escaped manifest member'
            if entry['type'] == 'symlink':
                assert path.is_symlink() and os.readlink(str(path)) == entry['target']
            else:
                assert path.is_file() and not path.is_symlink()
                assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], 'File hash mismatch'
        for required in ['LICENSE', 'UPSTREAM.md', 'third-party-licenses.json', 'client/third-party-licenses.json']:
            assert (stage / required).is_file(), 'Legal notice missing'
        stage.rename(release)
    assert (release / 'studio-manifest.json').read_bytes() == expected_manifest, 'Existing manifest differs from verified archive'
    manifest = json.loads(expected_manifest)
    validate_manifest(manifest)
    for entry in manifest['files']:
        path = release / entry['path']
        assert release in path.resolve().parents, 'Existing release escapes artifact'
        if entry['type'] == 'symlink':
            assert path.is_symlink() and os.readlink(str(path)) == entry['target']
        else:
            assert path.is_file() and not path.is_symlink()
            assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], 'Existing release hash differs'
    actual_files = {str(path.relative_to(release)) for path in release.rglob('*')
                    if path.is_file() or path.is_symlink()}
    assert actual_files == {entry['path'] for entry in manifest['files']} | {'studio-manifest.json'}, 'Unindexed existing release file'
    studio_home.mkdir(parents=True, mode=0o700)
    state.mkdir(mode=0o700)
    providers = {driver: {'enabled': driver in ['codex', 'claudeAgent']}
                 for driver in ['codex', 'claudeAgent', 'cursor', 'grok', 'pi', 'opencode', 'antigravity']}
    for driver, binary in [('codex', args.codex), ('claudeAgent', args.claude)]:
        if binary:
            resolved = pathlib.Path(binary).resolve(strict=True)
            assert resolved.is_file() and os.access(str(resolved), os.X_OK)
            providers[driver]['binaryPath'] = str(resolved)
            if driver == 'codex':
                providers[driver]['setupMode'] = 'existing'
    settings = {'defaultThreadEnvMode': 'worktree', 'defaultRuntimeMode': 'approval-required',
                'providers': providers}
    (state / 'settings.json').write_text(json.dumps(settings, indent=2) + '\n')
    user = owner.user
    allowed_env = {'HOME': str(home), 'USER': user, 'LOGNAME': user,
                   'PATH': runtime_path(home, node),
                   'LANG': 'en_US.UTF-8', 'TMPDIR': os.environ.get('TMPDIR', '/tmp'),
                   'STUDIO_HOME': str(studio_home), 'STUDIO_HOST': '127.0.0.1',
                   'STUDIO_PORT': str(args.port), 'STUDIO_MODE': 'web', 'STUDIO_NO_BROWSER': 'true',
                   'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': 'false',
                   'STUDIO_LOG_LEVEL': 'Warn', 'STUDIO_ENABLE_HOSTED_SERVICES': 'false',
                   'STUDIO_DEV_ALLOWED_ORIGINS': ','.join(args.trusted_origin),
                   'PWDEBUG': '0', 'PLAYWRIGHT_HTML_OPEN': 'never'}
    prefix = ['/usr/bin/env', '-i'] + [key + '=' + value for key, value in allowed_env.items()]
    prefix += [str(node), str(release / 'bin.mjs')]
    command = prefix + ['start', '--no-browser', '--host', '127.0.0.1',
                '--port', str(args.port), '--base-dir', str(studio_home), '--mode', 'web']
    launcher.write_text('#!/bin/sh\nset -eu\numask 077\ncd ' + shlex.quote(str(studio_home)) + '\nexec ' +
                        ' '.join(shlex.quote(part) for part in command) + '\n')
    launcher.chmod(0o700)
    if args.install_cli:
        cli.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive, no-follow creation: a link or file that appeared since the checks above
        # fails the install instead of being written through or replaced.
        # Both launchers or neither: a failed second create removes the first.
        created = []
        try:
            for launcher_path in [cli, cli_alias]:
                descriptor = os.open(str(launcher_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
                created.append(launcher_path)
                with os.fdopen(descriptor, 'w') as handle:
                    handle.write(render_cli(prefix))
                launcher_path.chmod(0o700)
        except BaseException:
            for launcher_path in created:
                launcher_path.unlink()
            raise
    for log in [stdout, stderr]:
        log.touch(mode=0o600)
    service = {'installed': False, 'domain': None}
    if args.service:
        plist.parent.mkdir(parents=True, exist_ok=True)
        content = {'Label': label, 'ProgramArguments': ['/usr/bin/caffeinate', '-s', str(launcher)],
                   'RunAtLoad': True, 'KeepAlive': True, 'WorkingDirectory': str(studio_home),
                   'StandardOutPath': str(stdout), 'StandardErrorPath': str(stderr), 'ThrottleInterval': 10}
        plist.write_bytes(plistlib.dumps(content))
        domain = owner.domain
        subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        service = {'installed': True, 'domain': domain, 'label': label, 'awakePolicy': 'caffeinate -s on AC'}
    receipt = {'schemaVersion': 1, 'identity': args.identity, 'user': user, 'uid': os.getuid(),
               'version': manifest['version'], 'sourceCommit': manifest['sourceCommit'], 'archiveSha256': digest,
               'release': str(release), 'studioHome': str(studio_home), 'stateDir': str(state),
               'node': str(node), 'nodeVersion': '22.20.0', 'host': '127.0.0.1', 'port': args.port,
               'cookieName': 'studio_session_' + str(args.port) + '_' + hashlib.sha256(str(state).encode()).hexdigest()[:12],
               'settings': {'defaultThreadEnvMode': 'worktree', 'defaultRuntimeMode': 'approval-required'},
               'startup': {'autoBootstrapProjectFromCwd': False, 'presentation': 'overview'},
               'trustedOrigins': args.trusted_origin, 'service': service,
               'cliWrapper': str(cli) if args.install_cli else None,
               'nativeCredentialStoresCopied': False, 'originalServicesChanged': False,
               'resourceTelemetry': manifest['resourceTelemetry']}
    if owner.policy is not None and args.identity not in {'m4', 'm1', 'm3'}:
        receipt['webSessionPolicy'] = owner.policy
    installation.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
