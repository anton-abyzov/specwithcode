#!/usr/bin/env python3
"""SpecWithCode's release channels on Cloudflare R2: candidate publish, stable promotion, rollback
and candidate retention. Stdlib only.

Bucket layout (served read-only at the update agent's feed URL, update_agent_recovery.DEFAULT_FEED_URL):

  candidate/<v>/<asset>    every asset SHA256SUMS lists, and SHA256SUMS itself
  candidate.json           the candidate pointer
  stable/<v>/<asset>       a promoted candidate, copied and checked again
  stable.json              the stable pointer: the newest release a host takes on its own
  stable.prev.json         what stable.json held before the last promotion (rollback restores it)
  stable.rolledback.json   the pointer the last rollback replaced

A pointer is {schemaVersion: 1, channel, version, tag, prefix, publishedAt, sourceCommit, notes,
assets: [{name, size, sha256}]}. Every object is uploaded before its pointer, and each pointer is
one PUT, which R2 applies atomically: a reader sees the old pointer or the new one, never a mix.

    r2_publish.py publish-candidate --version 1.0.190 --dir <assets> [--notes FILE] [--source-commit SHA]
    r2_publish.py promote --version 1.0.190      # release.sh finalize: candidate -> stable
    r2_publish.py rollback                       # stable.json <- stable.prev.json
    r2_publish.py prune [--apply]                # old candidate/<v>/ prefixes (dry-run by default)
    r2_publish.py check --channel candidate --version 1.0.190   # exit 0 when that pointer names it, complete
    r2_publish.py status

publish-candidate uploads, downloads every object again and compares sha256 and size, removes its own
prefix when one does not match, and only then writes candidate.json; it then prunes. Retention
follows staging_retention.py: a candidate prefix older than the previous release is removed, and
the current candidate's prefix, newer ones and any version a stable pointer names are kept. Nothing
outside candidate/ is ever removed.

Store: --store or RELEASE_R2_STORE, `file:///abs/folder` (tests and rehearsals; atomic renames) or
`r2://BUCKET` (default r2://$RELEASE_R2_BUCKET, else r2://studio-releases). R2 is reached the way the
vskill desktop release reaches it: the AWS CLI in S3 mode against
https://$CLOUDFLARE_R2_ACCOUNT_ID.r2.cloudflarestorage.com, with CLOUDFLARE_R2_ACCESS_KEY_ID and
CLOUDFLARE_R2_SECRET_ACCESS_KEY passed only in the CLI's environment. Values are never printed.

Prints one JSON line. Exit 0 on success, 1 on a refusal or failure, 2 for bad arguments.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

SEMVER = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,199}')
HEX64 = re.compile('[0-9a-f]{64}')
SUMS = 'SHA256SUMS'
PLAN = 'studio-update.json'
CANDIDATE, STABLE, PREVIOUS, ROLLED_BACK = 'candidate.json', 'stable.json', 'stable.prev.json', 'stable.rolledback.json'
POINTERS = (CANDIDATE, STABLE, PREVIOUS, ROLLED_BACK)
NOTES_LIMIT = 64 << 10
DEFAULT_BUCKET = 'studio-releases'
CREDENTIALS = ('CLOUDFLARE_R2_ACCOUNT_ID', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY')


class PublishError(Exception):
    pass


def version_tuple(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def sha256_file(path):
    digest = hashlib.sha256()
    with open(str(path), 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def check_key(key):
    parts = key.split('/')
    if not key or key.startswith('/') or any(part in ('', '.', '..') for part in parts[:-1]) or parts[-1] in ('.', '..'):
        raise PublishError('unsafe object key %r' % key)
    return key


# ---------------------------------------------------------------- stores


class LocalStore(object):
    """A folder standing in for the bucket: each write is a rename, so it is atomic like an R2 PUT."""

    def __init__(self, root):
        self.root = pathlib.Path(root)
        if not self.root.is_absolute():
            raise PublishError('a file store needs an absolute folder')
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key):
        return self.root / check_key(key)

    def _write(self, key, fill):
        target = self.path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix='.' + target.name + '.', dir=str(target.parent))
        try:
            with os.fdopen(descriptor, 'wb') as handle:
                fill(handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, str(target))
        except BaseException:
            if os.path.lexists(temporary):
                os.unlink(temporary)
            raise

    def put_file(self, key, path, content_type=None):
        with open(str(path), 'rb') as source:
            self._write(key, lambda handle: shutil.copyfileobj(source, handle, 1 << 20))

    def put_bytes(self, key, data, content_type=None):
        self._write(key, lambda handle: handle.write(data))

    def get_file(self, key, destination):
        source = self.path(key)
        if not source.is_file():
            return False
        shutil.copyfile(str(source), str(destination))
        return True

    def get_bytes(self, key):
        source = self.path(key)
        return source.read_bytes() if source.is_file() else None

    def list(self, prefix):
        found = {}
        base = self.root / prefix if prefix else self.root
        if not base.is_dir():
            return found
        for directory, _, files in os.walk(str(base)):
            for name in files:
                if name.startswith('.'):
                    continue  # An unfinished write's temporary file.
                path = pathlib.Path(directory) / name
                found[path.relative_to(self.root).as_posix()] = path.stat().st_size
        return found

    def delete(self, key):
        path = self.path(key)
        if path.is_file():
            path.unlink()

    def copy(self, source, target):
        self.put_file(target, self.path(source))


class R2Store(object):
    """R2 through the AWS CLI's s3api, as the vskill desktop release does. `run` is subprocess.run."""

    def __init__(self, bucket, environ=None, run=subprocess.run, aws='aws'):
        environ = os.environ if environ is None else environ
        missing = [name for name in CREDENTIALS if not environ.get(name)]
        if missing:
            raise PublishError('R2 needs %s in the environment (release.env); missing: %s'
                               % (', '.join(CREDENTIALS), ', '.join(missing)))
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket or ''):
            raise PublishError('invalid R2 bucket name %r' % bucket)
        self.bucket = bucket
        self.endpoint = 'https://%s.r2.cloudflarestorage.com' % environ['CLOUDFLARE_R2_ACCOUNT_ID']
        self.env = {key: value for key, value in environ.items() if not key.startswith('AWS_')}
        self.env.update(AWS_ACCESS_KEY_ID=environ['CLOUDFLARE_R2_ACCESS_KEY_ID'],
                        AWS_SECRET_ACCESS_KEY=environ['CLOUDFLARE_R2_SECRET_ACCESS_KEY'],
                        AWS_DEFAULT_REGION='auto', AWS_EC2_METADATA_DISABLED='true', AWS_PAGER='')
        self.run = run
        self.aws = aws

    def call(self, args, missing_ok=False):
        command = [self.aws, '--endpoint-url', self.endpoint, 's3api'] + list(args) + ['--output', 'json']
        try:
            result = self.run(command, env=self.env, capture_output=True, text=True, timeout=1800)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PublishError('aws s3api %s could not run (%s)' % (args[0], type(error).__name__)) from None
        if result.returncode != 0:
            if missing_ok and ('NoSuchKey' in (result.stderr or '') or '404' in (result.stderr or '')):
                return None
            raise PublishError('aws s3api %s failed (exit %d): %s'
                               % (args[0], result.returncode, (result.stderr or '').strip()[-300:]))
        return result.stdout

    def put_file(self, key, path, content_type=None):
        args = ['put-object', '--bucket', self.bucket, '--key', check_key(key), '--body', str(path)]
        if content_type:
            args += ['--content-type', content_type]
        if key in POINTERS:
            args += ['--cache-control', 'no-cache, max-age=0']
        self.call(args)

    def put_bytes(self, key, data, content_type=None):
        with tempfile.TemporaryDirectory(prefix='r2-put-') as folder:
            path = pathlib.Path(folder) / 'body'
            path.write_bytes(data)
            self.put_file(key, path, content_type)

    def get_file(self, key, destination):
        return self.call(['get-object', '--bucket', self.bucket, '--key', check_key(key), str(destination)],
                         missing_ok=True) is not None

    def get_bytes(self, key):
        with tempfile.TemporaryDirectory(prefix='r2-get-') as folder:
            path = pathlib.Path(folder) / 'body'
            return path.read_bytes() if self.get_file(key, path) else None

    def list(self, prefix):
        out = self.call(['list-objects-v2', '--bucket', self.bucket, '--prefix', prefix])
        try:
            contents = (json.loads(out) if out and out.strip() else {}).get('Contents') or []
        except (ValueError, AttributeError):
            raise PublishError('aws s3api list-objects-v2 returned unreadable output') from None
        return {item['Key']: int(item['Size']) for item in contents}

    def delete(self, key):
        self.call(['delete-object', '--bucket', self.bucket, '--key', check_key(key)])

    def copy(self, source, target):
        self.call(['copy-object', '--bucket', self.bucket, '--key', check_key(target),
                   '--copy-source', '%s/%s' % (self.bucket, urllib.parse.quote(check_key(source)))])


def open_store(spec=None, environ=None):
    environ = os.environ if environ is None else environ
    spec = spec or environ.get('RELEASE_R2_STORE') or 'r2://' + (environ.get('RELEASE_R2_BUCKET') or DEFAULT_BUCKET)
    parts = urllib.parse.urlsplit(spec)
    if parts.scheme == 'file' and not parts.netloc:
        return LocalStore(urllib.parse.unquote(parts.path))
    if parts.scheme == 'r2' and parts.netloc and parts.path in ('', '/'):
        return R2Store(parts.netloc, environ)
    raise PublishError('--store must be file:///abs/folder or r2://BUCKET, not %r' % spec)


# ---------------------------------------------------------------- pointers


def content_type(name):
    return 'application/json' if name.endswith('.json') else 'application/octet-stream'


def valid_pointer(value, channel):
    if not (isinstance(value, dict) and value.get('schemaVersion') == 1 and value.get('channel') == channel):
        return False
    version, assets = value.get('version'), value.get('assets')
    if version_tuple(version) is None or value.get('tag') != 'v' + version \
            or value.get('prefix') != '%s/%s/' % (channel, version) or not isinstance(assets, list) or not assets:
        return False
    names = [asset.get('name') for asset in assets if isinstance(asset, dict)]
    return (len(names) == len(assets) == len(set(names)) and PLAN in names and SUMS in names
            and all(NAME.fullmatch(asset['name'] or '') and type(asset.get('size')) is int and asset['size'] >= 0
                    and HEX64.fullmatch(asset.get('sha256') or '') for asset in assets))


def read_pointer(store, key, channel):
    """(parsed pointer or None, raw bytes or None); a pointer that is there but malformed refuses."""
    raw = store.get_bytes(key)
    if raw is None:
        return None, None
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        value = None
    if not valid_pointer(value, channel):
        raise PublishError('%s is malformed; fix it by hand before publishing' % key)
    return value, raw


def encode(pointer):
    return (json.dumps(pointer, indent=2, sort_keys=True) + '\n').encode('utf-8')


def verify_prefix(store, pointer, scratch):
    """Downloads every object the pointer names and checks its size and sha256."""
    for asset in pointer['assets']:
        key = pointer['prefix'] + asset['name']
        local = pathlib.Path(scratch) / asset['name']
        if not store.get_file(key, local):
            raise PublishError('%s is missing after the upload' % key)
        if local.stat().st_size != asset['size'] or sha256_file(local) != asset['sha256']:
            raise PublishError('%s does not match its sha256 after the upload' % key)
        local.unlink()


def present(store, pointer):
    """True when every object the pointer names is in the store with its size (no download)."""
    listed = store.list(pointer['prefix'])
    return all(listed.get(pointer['prefix'] + asset['name']) == asset['size'] for asset in pointer['assets'])


def drop_prefix(store, prefix):
    for key in sorted(store.list(prefix)):
        store.delete(key)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- commands


def local_assets(directory):
    """[{name, size, sha256}] for SHA256SUMS and every file it lists, each checked against it."""
    directory = pathlib.Path(directory)
    sums_path = directory / SUMS
    if not sums_path.is_file():
        raise PublishError('%s has no %s' % (directory, SUMS))
    listed = {}
    for line in sums_path.read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *](\S+)', line.strip())
        if not line.strip():
            continue
        if not match or not NAME.fullmatch(match.group(2)) or match.group(2) in listed:
            raise PublishError('%s has a malformed or duplicate line: %r' % (SUMS, line[:120]))
        listed[match.group(2)] = match.group(1)
    if PLAN not in listed:
        raise PublishError('%s does not list %s; the update agent checks the plan against it' % (SUMS, PLAN))
    assets = []
    for name in sorted(listed) + [SUMS]:
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise PublishError('%s is missing from %s' % (name, directory))
        digest = sha256_file(path)
        if name != SUMS and digest != listed[name]:
            raise PublishError('%s does not match %s' % (name, SUMS))
        assets.append({'name': name, 'size': path.stat().st_size, 'sha256': digest})
    return assets


def same_assets(left, right):
    key = lambda asset: (asset['name'], asset['size'], asset['sha256'])  # noqa: E731
    return sorted(map(key, left)) == sorted(map(key, right))


def named_prefixes(store):
    """Every prefix a pointer names; publishing never deletes under one of them."""
    named = set()
    for key, channel in ((CANDIDATE, 'candidate'), (STABLE, 'stable'), (PREVIOUS, 'stable'), (ROLLED_BACK, 'stable')):
        pointer, _ = read_pointer(store, key, channel)
        if pointer is not None:
            named.add(pointer['prefix'])
    return named


def prune_after_publish(store, report):
    """Retention after candidate.json is written: a failure is reported, never a failed publish."""
    try:
        report['pruned'] = prune(store, apply=True)
    except (PublishError, OSError) as error:
        report['pruned'], report['pruneError'] = [], str(error)
        print('r2_publish: warning: retention failed (%s); the next publish prunes again' % error, file=sys.stderr)
    return report


def publish_candidate(store, version, directory, notes=None, source_commit=None):
    if version_tuple(version) is None:
        raise PublishError('--version must be X.Y.Z')
    stable, _ = read_pointer(store, STABLE, 'stable')
    if stable is not None and version_tuple(version) <= version_tuple(stable['version']):
        raise PublishError('%s is not newer than the stable release %s' % (version, stable['version']))
    current, _ = read_pointer(store, CANDIDATE, 'candidate')  # A malformed one is fixed by hand, never written over.
    assets = local_assets(directory)
    prefix = 'candidate/%s/' % version
    if current is not None and current['version'] == version:
        # A resumed stage, or a second run: the live prefix is never written over.
        if current['prefix'] != prefix or not same_assets(current['assets'], assets):
            raise PublishError('candidate.json already names %s with other assets; release the change as a new version'
                               % version)
        with tempfile.TemporaryDirectory(prefix='r2-verify-') as scratch:
            try:
                verify_prefix(store, current, scratch)
            except PublishError as error:
                raise PublishError('candidate.json names %s but %s no longer matches it (%s); fix it by hand'
                                   % (version, prefix, error))
        return prune_after_publish(store, {'result': 'already-candidate', 'version': version, 'prefix': prefix,
                                           'assets': len(assets)})
    pointer = {'schemaVersion': 1, 'channel': 'candidate', 'version': version, 'tag': 'v' + version,
               'prefix': prefix, 'publishedAt': now_iso(), 'sourceCommit': source_commit,
               'notes': notes[:NOTES_LIMIT] if isinstance(notes, str) else None, 'assets': assets}
    with tempfile.TemporaryDirectory(prefix='r2-verify-') as scratch:
        try:
            for asset in assets:
                store.put_file(prefix + asset['name'], pathlib.Path(directory) / asset['name'],
                               content_type(asset['name']))
            verify_prefix(store, pointer, scratch)
        except (PublishError, OSError):
            if prefix not in named_prefixes(store):
                drop_prefix(store, prefix)  # Nothing points at it.
            raise
    store.put_bytes(CANDIDATE, encode(pointer), 'application/json')
    return prune_after_publish(store, {'result': 'candidate-published', 'version': version, 'prefix': prefix,
                                       'assets': len(assets)})


def promote(store, version):
    if version_tuple(version) is None:
        raise PublishError('--version must be X.Y.Z')
    candidate, _ = read_pointer(store, CANDIDATE, 'candidate')
    stable, stable_raw = read_pointer(store, STABLE, 'stable')
    if stable is not None and stable['version'] == version:
        if not present(store, stable):
            raise PublishError('stable.json names %s but stable/%s/ is incomplete' % (version, version))
        return {'result': 'already-stable', 'version': version}
    if candidate is None or candidate['version'] != version:
        raise PublishError('candidate.json names %s, not %s' % (candidate and candidate['version'], version))
    if stable is not None and version_tuple(version) <= version_tuple(stable['version']):
        raise PublishError('%s is not newer than the stable release %s' % (version, stable['version']))
    pointer = dict(candidate, channel='stable', prefix='stable/%s/' % version, promotedAt=now_iso())
    for asset in candidate['assets']:
        store.copy(candidate['prefix'] + asset['name'], pointer['prefix'] + asset['name'])
    with tempfile.TemporaryDirectory(prefix='r2-verify-') as scratch:
        verify_prefix(store, pointer, scratch)
    if stable_raw is not None:
        store.put_bytes(PREVIOUS, stable_raw, 'application/json')
    store.put_bytes(STABLE, encode(pointer), 'application/json')  # The last step, one atomic PUT.
    return {'result': 'promoted', 'version': version, 'previous': stable and stable['version']}


def rollback(store):
    previous, previous_raw = read_pointer(store, PREVIOUS, 'stable')
    if previous is None:
        raise PublishError('there is no %s to roll back to' % PREVIOUS)
    if not present(store, previous):
        raise PublishError('%s names %s, but stable/%s/ is incomplete; nothing was changed'
                           % (PREVIOUS, previous['version'], previous['version']))
    current, current_raw = read_pointer(store, STABLE, 'stable')
    if current_raw == previous_raw:
        return {'result': 'already-rolled-back', 'version': previous['version']}
    if current_raw is not None:
        store.put_bytes(ROLLED_BACK, current_raw, 'application/json')
    store.put_bytes(STABLE, previous_raw, 'application/json')  # One atomic PUT of the exact previous bytes.
    return {'result': 'rolled-back', 'version': previous['version'], 'from': current and current['version']}


def prune(store, apply=False):
    """Candidate prefixes older than the previous release and named by no pointer; returns the versions."""
    candidate, _ = read_pointer(store, CANDIDATE, 'candidate')
    if candidate is None:
        return []
    keep = {candidate['version']}
    for key in (STABLE, PREVIOUS, ROLLED_BACK):
        pointer, _ = read_pointer(store, key, 'stable')
        if pointer is not None:
            keep.add(pointer['version'])
    current = version_tuple(candidate['version'])
    versions = {}
    for key in store.list('candidate/'):
        parts = key.split('/')
        if len(parts) >= 3 and version_tuple(parts[1]) is not None:
            versions.setdefault(parts[1], []).append(key)
    older = sorted((v for v in versions if version_tuple(v) < current), key=version_tuple)
    previous = older[-1] if older else None
    removed = [v for v in older if v != previous and v not in keep]
    if apply:
        for name in removed:
            for key in sorted(versions[name]):
                store.delete(key)
    return removed


def check(store, channel, version):
    key = CANDIDATE if channel == 'candidate' else STABLE
    pointer, _ = read_pointer(store, key, channel)
    if pointer is None or pointer['version'] != version:
        raise PublishError('%s names %s, not %s' % (key, pointer and pointer['version'], version))
    if not present(store, pointer):
        raise PublishError('%s names %s, but %s is incomplete' % (key, version, pointer['prefix']))
    return {'result': 'ready', 'channel': channel, 'version': version}


def status(store):
    report = {}
    for key, channel in ((CANDIDATE, 'candidate'), (STABLE, 'stable'), (PREVIOUS, 'stable'), (ROLLED_BACK, 'stable')):
        pointer, _ = read_pointer(store, key, channel)
        report[key] = pointer and {'version': pointer['version'], 'complete': present(store, pointer)}
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(prog='r2_publish.py', description=__doc__.split('\n')[0])
    parser.add_argument('--store', help='file:///abs/folder or r2://BUCKET (default RELEASE_R2_STORE or the bucket)')
    commands = parser.add_subparsers(dest='command')
    publish = commands.add_parser('publish-candidate')
    publish.add_argument('--version', required=True)
    publish.add_argument('--dir', required=True)
    publish.add_argument('--notes')
    publish.add_argument('--source-commit')
    commands.add_parser('promote').add_argument('--version', required=True)
    commands.add_parser('rollback')
    commands.add_parser('prune').add_argument('--apply', action='store_true')
    checked = commands.add_parser('check')
    checked.add_argument('--channel', choices=('candidate', 'stable'), required=True)
    checked.add_argument('--version', required=True)
    commands.add_parser('status')
    args = parser.parse_args(argv)
    if args.command is None:
        parser.error('choose publish-candidate, promote, rollback, prune, check or status')
    try:
        store = open_store(args.store)
        if args.command == 'publish-candidate':
            notes = pathlib.Path(args.notes).read_text(encoding='utf-8') if args.notes else None
            report = publish_candidate(store, args.version, args.dir, notes, args.source_commit)
        elif args.command == 'promote':
            report = promote(store, args.version)
        elif args.command == 'rollback':
            report = rollback(store)
        elif args.command == 'check':
            report = check(store, args.channel, args.version)
        elif args.command == 'prune':
            report = {'result': 'pruned' if args.apply else 'would-prune', 'versions': prune(store, args.apply)}
        else:
            report = status(store)
    except (PublishError, OSError) as error:
        print(json.dumps({'result': 'failed', 'error': str(error)}))
        print('r2_publish: %s' % error, file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
