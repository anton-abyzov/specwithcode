#!/usr/bin/env python3
"""Activate a verified, staged native release on an idle owned Studio host.

This never installs into an existing prefix, logs in, copies credentials, stops
processes or starts inference. Keep the former release for existing processes.
"""
if not __debug__:
    raise RuntimeError("Provider activation guards require Python assertions; do not use optimized mode")

import argparse
import hashlib
import json
import os
import pathlib
import pwd
import re
import shlex
import subprocess
import uuid
from update import atomic, rows_snapshot

def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def protected(home, identity):
    paths = [home/'.codex/auth.json', home/'.codex/config.toml', home/'.claude.json',
             home/'.claude/.credentials.json', home/'.specweave-studio'/identity/'userdata/settings.json']
    profiles = home/'.local/share/specweave/account-profiles'
    if profiles.is_dir():
        for folder in profiles.iterdir():
            if folder.is_dir() and not folder.is_symlink():
                paths.extend(folder/name for name in ('auth.json', 'config.toml', '.claude.json', '.credentials.json'))
    return {str(p.relative_to(home)): sha(p.read_bytes()) if p.is_file() else None for p in paths}


REQUIRED_PROVIDER_FILES = {
    'node_modules/@openai/codex/bin/codex.js',
    'node_modules/@anthropic-ai/claude-code-darwin-arm64/claude',
}


def decode_verified_manifest(raw, expected_sha256):
    """The digest must come from the reviewed receipt, not this input file."""
    assert re.fullmatch('[a-f0-9]{64}', expected_sha256), 'Invalid expected manifest SHA-256'
    assert sha(raw) == expected_sha256, 'Provider manifest changed; preserve the installed wrappers'
    manifest = json.loads(raw)
    assert isinstance(manifest, dict) and manifest.get('credentialsIncluded') is False
    assert re.fullmatch('[a-f0-9]{64}', manifest.get('archiveSha256', ''))
    return manifest


def verify_provider_release(manifest, home):
    """Reject any file, link or directory outside the pinned manifest's inventory."""
    release = pathlib.Path(manifest['release'])
    assert release.parent == home/'.local/share/specweave/provider-releases'
    assert release.is_dir() and not release.is_symlink() and release.resolve() == release
    entries = manifest['files']
    assert isinstance(entries, list) and entries, 'Provider manifest has no files'
    declared, directories = set(), set()
    for entry in entries:
        assert isinstance(entry, dict) and entry.get('type') in ('file', 'symlink'), 'Unknown provider artifact type'
        kind = entry['type']
        assert set(entry) == ({'path', 'type', 'sha256'} if kind == 'file' else {'path', 'type', 'target'})
        relative = pathlib.PurePosixPath(entry['path'])
        assert not relative.is_absolute() and relative.parts and '..' not in relative.parts
        assert str(relative) == entry['path'] and '\\' not in entry['path'], 'Noncanonical provider artifact path'
        assert entry['path'] not in declared, 'Duplicate provider artifact path'
        declared.add(entry['path'])
        directories.update(str(parent) for parent in relative.parents if str(parent) != '.')
        path = release/entry['path']
        assert release in path.resolve(strict=True).parents, 'Provider artifact escapes release'
        if kind == 'symlink':
            assert path.is_symlink() and os.readlink(path) == entry['target']
        else:
            assert re.fullmatch('[a-f0-9]{64}', entry['sha256'])
            assert path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == entry['sha256']
    assert REQUIRED_PROVIDER_FILES.issubset(declared), 'Provider executable is absent from the manifest'
    actual, actual_directories = set(), set()
    for path in release.rglob('*'):
        relative = str(path.relative_to(release))
        if path.is_symlink() or path.is_file():
            actual.add(relative)
        elif path.is_dir():
            actual_directories.add(relative)
        else:
            raise AssertionError('Unexpected provider artifact type')
    assert actual == declared, 'Provider release contains omitted or extra files'
    assert actual_directories == directories, 'Provider release contains omitted or extra directories'
    return release


def verify_prior_wrapper(name, raw, home, node, previous_manifest_raw=None, previous_manifest_sha256=None):
    if previous_manifest_raw is None:
        assert str(home/'.local/share/specweave/providers/node_modules').encode() in raw
        return
    previous = decode_verified_manifest(previous_manifest_raw, previous_manifest_sha256)
    release = verify_provider_release(previous, home)
    command = ([node, str(release/'node_modules/@openai/codex/bin/codex.js')] if name == 'codex'
               else [str(release/'node_modules/@anthropic-ai/claude-code-darwin-arm64/claude')])
    assert raw == ('#!/bin/sh\nset -eu\nexec '+shlex.join(command)+' "$@"\n').encode(), 'Prior release wrapper differs from its pinned manifest'


def activate(identity, manifest_raw, expected, expected_manifest_sha256, *, previous_manifest_raw=None, previous_manifest_sha256=None):
    os.umask(0o077)
    manifest = decode_verified_manifest(manifest_raw, expected_manifest_sha256)
    home = pathlib.Path.home().resolve()
    assert identity in ('m4','m1','m3') and os.getuid() == 501 and home == pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    release = verify_provider_release(manifest, home)
    own = home/'.specweave-studio'/identity
    installation = json.loads((own/'installation.json').read_text())
    node = installation['node']
    assert subprocess.check_output([node,'--version'],text=True).strip() == 'v22.20.0'
    rows = rows_snapshot(own/'userdata')
    native = protected(home, identity)
    wrappers = {name: home/'.local/share/specweave/providers/bin'/name for name in ('codex','claude')}
    original = {}
    for name,path in wrappers.items():
        assert path.is_file() and not path.is_symlink() and path.resolve() == path
        original[name] = path.read_bytes()
        assert sha(original[name]) == expected[name], 'Provider wrapper changed; preserve it'
        verify_prior_wrapper(name, original[name], home, node, previous_manifest_raw, previous_manifest_sha256)
    commands = {
        'codex': [node, str(release/'node_modules/@openai/codex/bin/codex.js')],
        'claude': [str(release/'node_modules/@anthropic-ai/claude-code-darwin-arm64/claude')],
    }
    versions = {'codex': 'codex-cli '+manifest['codexVersion'], 'claude': manifest['claudeVersion']+' (Claude Code)'}
    for name,cmd in commands.items():
        result = subprocess.run(cmd+['--version'], capture_output=True,text=True,timeout=30)
        assert result.returncode == 0 and result.stdout.strip() == versions[name]
    assert rows_snapshot(own/'userdata') == rows and protected(home,identity) == native
    verify_provider_release(manifest, home)
    backup = own/'provider-updates'/str(uuid.uuid4())
    backup.mkdir(mode=0o700,parents=True)
    for name,raw in original.items():
        (backup/(name+'.sh')).write_bytes(raw)
    changed = {}
    try:
        for name,path in wrappers.items():
            assert path.read_bytes() == original[name] and rows_snapshot(own/'userdata') == rows
            raw = ('#!/bin/sh\nset -eu\nexec '+shlex.join(commands[name])+' "$@"\n').encode()
            atomic(path,raw,0o700)
            changed[name] = raw
        assert protected(home,identity) == native and rows_snapshot(own/'userdata') == rows
    except BaseException:
        for name,raw in changed.items():
            if wrappers[name].read_bytes() == raw:
                atomic(wrappers[name],original[name],0o700)
        raise
    return {'identity':identity,'versions':versions,'archiveSha256':manifest['archiveSha256'],
            'manifestSha256':expected_manifest_sha256,
            'filesVerified':len(manifest['files']),'wrapperHashes':{k:sha(v) for k,v in changed.items()},
            'backup':str(backup),'nativeFilesUnchanged':True,'studioRowsUnchanged':True,
            'existingProcessesStopped':False,'loginOrInferenceStarted':False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identity',required=True,choices=('m4','m1','m3'))
    parser.add_argument('--manifest',type=pathlib.Path,required=True)
    parser.add_argument('--expected-manifest-sha256',required=True,help='SHA-256 of the exact independently reviewed manifest bytes.')
    parser.add_argument('--expected-wrapper-hashes',type=pathlib.Path,required=True)
    args = parser.parse_args()
    print(json.dumps(activate(args.identity,args.manifest.read_bytes(),json.loads(args.expected_wrapper_hashes.read_text()),args.expected_manifest_sha256)))

if __name__ == '__main__':main()
