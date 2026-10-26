#!/usr/bin/env python3
"""Build a release's deployment-helpers archive and deployment-helpers-manifest.json.

The update agent downloads the archive, checks every file against the manifest
(update_agent.validate_manifest) and runs the release's own update.py from it. The archive is
`git archive` of SOURCE_PATHS at one commit, gzipped without a name or timestamp, so the same
commit always gives the same bytes. SOURCE_PATHS here is the list a release uses; a previous
release's manifest is only compared with it.

    python3 -B scripts/studio-fleet/make_helpers.py --repo . --out <assets dir> --version 1.0.37 \\
      [--commit HEAD] [--previous-manifest <previous release's deployment-helpers-manifest.json>]

Prints one JSON line: the archive name, its sha256, the file count and any source paths that
differ from the previous manifest.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

PRODUCT = 'SpecWeave Studio deployment helpers'  # A kept identity: docs/studio/naming.md.
MANIFEST = 'deployment-helpers-manifest.json'
SOURCE_PATHS = ('scripts/studio-fleet', 'scripts/studio-projects/version.mjs', 'scripts/lib/cli-executable-imports.ts',
                'scripts/lib/cli-external-packages.ts', 'scripts/lib/third-party-licenses.ts', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.md',
                'package.json', 'pnpm-lock.yaml')
ENTRYPOINTS = ('scripts/studio-fleet/update.py', 'scripts/studio-fleet/network-transition.py',
               'scripts/studio-fleet/install.py')
SEMVER = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
GIT_ENV = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}


class HelpersError(Exception):
    pass


def _git(repo, args, text=True):
    env = dict(os.environ, **GIT_ENV)
    try:
        return subprocess.run(['git', '-C', str(repo)] + list(args), check=True, capture_output=True,
                              text=text, env=env).stdout
    except subprocess.CalledProcessError as error:
        detail = error.stderr if isinstance(error.stderr, str) else error.stderr.decode('utf-8', 'replace')
        raise HelpersError('git %s failed: %s' % (args[0], detail.strip()[:300])) from None


def _write(path, data, mode):
    """Writes `data` to `path` through a temporary file in the same folder."""
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, str(path))
    except BaseException:
        if os.path.lexists(temporary):
            os.unlink(temporary)
        raise


def build(repo, out, version, commit='HEAD'):
    """Writes <root>.tar.gz and deployment-helpers-manifest.json into `out`; returns the manifest."""
    if not SEMVER.fullmatch(version or ''):
        raise HelpersError('Invalid version %r' % version)
    repo, out = pathlib.Path(repo).resolve(), pathlib.Path(out).resolve()
    if not out.is_dir():
        raise HelpersError('%s is not a folder' % out)
    sha = _git(repo, ['rev-parse', '--verify', commit + '^{commit}']).strip()
    root = 'studio-%s-deployment-helpers-%s' % (version, sha[:12])
    paths = list(SOURCE_PATHS)
    argv = ['git', '-c', 'tar.umask=0022', 'archive', '--format=tar', '--prefix=' + root + '/', sha, '--'] + paths
    tar = _git(repo, argv[1:], text=False)
    gzip = shutil.which('gzip') or '/usr/bin/gzip'
    packed = subprocess.run([gzip, '-n', '-9'], input=tar, stdout=subprocess.PIPE, check=True).stdout
    archive = root + '.tar.gz'
    _write(out / archive, packed, 0o644)
    files = []
    for line in _git(repo, ['ls-tree', '-r', '-l', sha, '--'] + paths).splitlines():
        meta, path = line.split('\t', 1)
        mode, kind, blob, _size = meta.split()
        if kind != 'blob':
            continue
        data = _git(repo, ['cat-file', 'blob', blob], text=False)
        entry = {'path': path, 'gitBlob': blob, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        if mode == '100755':
            entry['mode'] = 0o755
        files.append(entry)
    if not files:
        raise HelpersError('No helper files at %s' % sha)
    missing = [path for path in ENTRYPOINTS if path not in {entry['path'] for entry in files}]
    if missing:
        raise HelpersError('Helper entrypoints missing at %s: %s' % (sha, ', '.join(missing)))
    files.sort(key=lambda entry: entry['path'])
    manifest = {'schemaVersion': 1, 'product': PRODUCT, 'version': version, 'sourceCommit': sha,
                'runtimeSourceCommit': sha, 'archive': archive, 'archiveSha256': hashlib.sha256(packed).hexdigest(),
                'archiveBytes': len(packed), 'entrypoints': list(ENTRYPOINTS), 'sourcePaths': paths,
                'gitArchiveArgv': argv, 'files': files}
    _write(out / MANIFEST, (json.dumps(manifest, indent=2) + '\n').encode('utf-8'), 0o644)
    return manifest


def path_changes(previous):
    """Source paths added or dropped since the previous release's manifest."""
    try:
        listed = json.loads(pathlib.Path(previous).read_text()).get('sourcePaths')
    except (OSError, ValueError, AttributeError):
        raise HelpersError('%s is not a helpers manifest' % previous) from None
    if not isinstance(listed, list):
        raise HelpersError('%s lists no sourcePaths' % previous)
    return (['+' + path for path in SOURCE_PATHS if path not in listed]
            + ['-' + path for path in listed if path not in SOURCE_PATHS])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--repo', default='.', type=pathlib.Path)
    parser.add_argument('--out', required=True, type=pathlib.Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--commit', default='HEAD')
    parser.add_argument('--previous-manifest', type=pathlib.Path)
    args = parser.parse_args(argv)
    try:
        changes = path_changes(args.previous_manifest) if args.previous_manifest else []
        manifest = build(args.repo, args.out, args.version, args.commit)
    except (HelpersError, OSError, subprocess.CalledProcessError) as error:
        print('make_helpers: %s' % error, file=sys.stderr)
        return 1
    print(json.dumps({'archive': manifest['archive'], 'sha256': manifest['archiveSha256'],
                      'files': len(manifest['files']), 'sourceCommit': manifest['sourceCommit'],
                      'sourcePathChanges': changes}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
