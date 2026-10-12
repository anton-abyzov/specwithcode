#!/usr/bin/env python3
"""Background Studio update agent: one resumable, lock-guarded pass per launchd run.

A pass discovers a newer GitHub release, verifies its update plan, assets and helper
files, waits for a quiet moment and then runs the target release's own guarded
update.py. The agent never stops or signals the Studio service; only that verified
helper restarts it. GitHub tokens stay in memory: they are never written, logged or
placed in exception text. Helper output is discarded; only short status lines print.
Stdlib only and Python 3.9 compatible (macOS /usr/bin/python3); self-contained so it
can be copied alone into the updater LaunchAgent location.
"""
import argparse
import datetime
import errno
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import plistlib
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

AGENT_VERSION = 1
IDENTITIES = ('m4', 'm1', 'm3')
PRODUCT = 'SpecWeave Studio'
PLATFORM = 'darwin-arm64'
ENTRYPOINT = 'scripts/studio-fleet/update.py'
ALLOWED_ARGS = ('--allow-project-migrations', '--allow-existing-browser-heartbeat')
PLAN_ASSET = 'studio-update.json'
SUMS_ASSET = 'SHA256SUMS'
MANIFEST_ASSET = 'deployment-helpers-manifest.json'
RESERVED_ASSETS = (PLAN_ASSET, SUMS_ASSET, MANIFEST_ASSET)
DEFAULT_REPOSITORY = 'anton-abyzov/specwithcode'
DEFAULT_API = 'https://api.github.com'
CHECK_INTERVAL = datetime.timedelta(minutes=60)
# Two process inventories bracket the snapshot; each may take 2 x 30 s on a loaded Mac.
SNAPSHOT_TIMEOUT = 240
APPLY_TIMEOUT = 900
GH_TIMEOUT = 10
HTTP_TIMEOUT = 60
NOTES_LIMIT = 4000
SYSTEM_PYTHON = '/usr/bin/python3'
GH_PATHS = ('/opt/homebrew/bin/gh', '/usr/local/bin/gh')
LOOPBACK = ('127.0.0.1', 'localhost', '::1')
SIGN_IN = 'Sign in with `gh auth login` so Studio can read private releases.'
WAITING = 'Waiting for running sessions and open Studio terminals to finish'
# What the snapshot helper's refusal means, in the words the app shows. The helper's
# output is read only for these phrases; it is never logged or kept.
WAITING_REASONS = (
    ('Native work is not idle', 'Waiting for running tasks, queued messages and open questions to finish'),
    ('has unexpected descendants', 'Waiting for open Studio terminals and agent processes to close'),
)
STATUSES = ('disabled', 'up-to-date', 'available', 'downloading', 'downloaded', 'waiting-for-quiet',
            'installing', 'installed', 'manual-required', 'error')
LIMITS = {'list': 10 << 20, PLAN_ASSET: 256 << 10, SUMS_ASSET: 256 << 10, MANIFEST_ASSET: 4 << 20,
          'runtime': 1 << 30, 'helpers': 64 << 20, 'json': 4 << 20}
HELPER_MAX_FILES = 2000
HELPER_MAX_BYTES = 64 << 20
LOG_LIMIT = 1 << 20
HELPER_TAIL = 4096  # Bytes of a failed helper's output kept in its fallback receipt.
# The service appends to these logs on its own while a thread waits on a usage limit
# (one availability check every five minutes), so they cannot tell work from waiting.
# Work by a session always adds rows elsewhere: messages, turn items, runs.
BOOKKEEPING_COUNTS = ('orchestration_events', 'orchestration_command_receipts')
HEX40 = re.compile('[0-9a-f]{40}')
HEX64 = re.compile('[0-9a-f]{64}')
SEMVER = r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})'
ASSET_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,199}')
REPOSITORY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}')
TOKEN_SHAPE = re.compile(r'[A-Za-z0-9_.\-]{8,1024}')
DEFAULT_CONFIG = {'schemaVersion': 1, 'checkAutomatically': True, 'downloadInBackground': True,
                  'installAutomatically': True, 'channel': 'stable', 'quietMinutes': 10,
                  'repository': DEFAULT_REPOSITORY, 'installRequestedAt': None, 'checkRequestedAt': None}
STATE_KEYS = ('schemaVersion', 'agentVersion', 'status', 'installedVersion', 'installedSourceCommit',
              'availableVersion', 'availableTag', 'availableNotes', 'availablePublishedAt',
              'downloadedVersion', 'checkedAt', 'quietSince', 'message', 'lastInstall',
              'handledInstallRequestAt', 'handledCheckRequestAt', 'updatedAt')

_REDACT = set()  # In-memory only: values scrubbed from any text the agent emits.


class AgentError(Exception):
    """A user-facing failure; its message must never contain secrets or command output."""
    status = 'error'

    def __init__(self, message):
        Exception.__init__(self, message)
        self.message = message


class ManualRequired(AgentError):
    status = 'manual-required'


class HttpFailure(AgentError):
    def __init__(self, message, code):
        AgentError.__init__(self, message)
        self.code = code


def redact(text):
    text = str(text)
    for secret in _REDACT:
        if secret:
            text = text.replace(secret, '[redacted]')
    return text


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(moment):
    return moment.isoformat()


def stamp():
    return utcnow().strftime('%Y%m%dT%H%M%S%fZ')


def parse_time(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        moment = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment


def version_tuple(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(SEMVER, value)
    return tuple(int(part) for part in match.groups()) if match else None


def tag_version(tag):
    if not isinstance(tag, str):
        return None
    match = re.fullmatch('v' + SEMVER, tag)
    return tag[1:] if match else None


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise AgentError('Expected a regular file')
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------- owned paths

def owned(path, home):
    """Lexically confine a path to home and reject any symlink ancestor (dangling included)."""
    path = pathlib.Path(path)
    try:
        relative = path.relative_to(home)
    except ValueError:
        raise AgentError('Path escapes the owned home') from None
    ancestor = home
    for part in relative.parts:
        if part in ('', '.', '..'):
            raise AgentError('Unsafe owned path component')
        ancestor = ancestor / part
        if ancestor.is_symlink():
            raise AgentError('Owned path has a symlink ancestor')
    return path


def ensure_dir(path, home):
    owned(path, home)
    ancestor = home
    for part in pathlib.Path(path).relative_to(home).parts:
        ancestor = ancestor / part
        if not ancestor.exists():
            os.mkdir(str(ancestor), 0o700)
        elif not ancestor.is_dir():
            raise AgentError('Owned path has a non-directory ancestor')
    return path


def read_owned(path, home, limit):
    owned(path, home)
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        if error.errno == errno.ENOENT:
            raise AgentError('Missing file: ' + pathlib.Path(path).name) from None
        raise AgentError('Unreadable file: ' + pathlib.Path(path).name) from None
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise AgentError('Unexpected file: ' + pathlib.Path(path).name)
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise AgentError('Oversized file: ' + pathlib.Path(path).name)
    return data


def read_json(path, home, limit=LIMITS['json']):
    data = read_owned(path, home, limit)
    try:
        return json.loads(data.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        raise AgentError('Malformed JSON: ' + pathlib.Path(path).name) from None


def atomic_write(path, data, home, mode=0o600):
    owned(path, home)
    path = pathlib.Path(path)
    temporary = path.with_name('.' + path.name + '.tmp-' + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(str(temporary), mode)
        os.replace(str(temporary), str(path))
    except BaseException:
        try:
            os.unlink(str(temporary))
        except OSError:
            pass
        raise


def write_json(path, value, home):
    atomic_write(path, (json.dumps(value, indent=2) + '\n').encode(), home)


def remove_path(path, home):
    owned(path, home)
    path = pathlib.Path(path)
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(str(path))


# ---------------------------------------------------------------- release policy

def parse_sums(data):
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise AgentError('SHA256SUMS is not UTF-8') from None
    sums = {}
    for line in text.splitlines():
        line = line.rstrip('\r')
        if not line.strip():
            continue
        match = re.fullmatch(r'([0-9a-fA-F]{64}) [ *](\S+)', line)
        if not match:
            raise AgentError('SHA256SUMS has a malformed line')
        name = match.group(2)
        if name.startswith('./'):
            name = name[2:]
        if name in sums:
            raise AgentError('SHA256SUMS lists a file twice')
        sums[name] = match.group(1).lower()
    return sums


def _plan_need(condition, why):
    if not condition:
        raise AgentError('Update plan was rejected: ' + why)


def _safe_name(value):
    return isinstance(value, str) and ASSET_NAME.fullmatch(value) is not None and '..' not in value


def validate_plan(plan, expected_version=None):
    need = _plan_need
    need(isinstance(plan, dict), 'not a JSON object')
    need(type(plan.get('schemaVersion')) is int and plan.get('schemaVersion') == 1, 'unsupported schemaVersion')
    need(plan.get('product') == PRODUCT, 'unexpected product')
    version = plan.get('version')
    need(version_tuple(version) is not None, 'invalid version')
    if expected_version is not None:
        need(version == expected_version, 'version does not match the release tag')
    need(isinstance(plan.get('sourceCommit'), str) and HEX40.fullmatch(plan['sourceCommit']) is not None,
         'invalid sourceCommit')
    service = plan.get('service')
    need(isinstance(service, dict), 'missing service')
    need(service.get('platform') == PLATFORM, 'unsupported platform')
    runtime, helpers = service.get('runtime'), service.get('helpers')
    need(isinstance(runtime, dict) and _safe_name(runtime.get('asset')), 'invalid runtime asset')
    need(isinstance(runtime.get('sha256'), str) and HEX64.fullmatch(runtime['sha256']) is not None,
         'invalid runtime sha256')
    need(isinstance(helpers, dict) and _safe_name(helpers.get('asset')), 'invalid helpers asset')
    need(isinstance(helpers.get('sha256'), str) and HEX64.fullmatch(helpers['sha256']) is not None,
         'invalid helpers sha256')
    need(_safe_name(helpers.get('root')), 'invalid helpers root')
    need(runtime['asset'] != helpers['asset'] and runtime['asset'] not in RESERVED_ASSETS
         and helpers['asset'] not in RESERVED_ASSETS, 'conflicting asset names')
    upgrades = service.get('upgrades')
    need(isinstance(upgrades, list) and upgrades, 'missing upgrades')
    for upgrade in upgrades:
        need(isinstance(upgrade, dict), 'invalid upgrade entry')
        sources = upgrade.get('fromSourceCommits')
        need(isinstance(sources, list) and sources and all(
            isinstance(item, str) and HEX40.fullmatch(item) for item in sources), 'invalid fromSourceCommits')
        need(upgrade.get('entrypoint') == ENTRYPOINT, 'entrypoint must be ' + ENTRYPOINT)
        args = upgrade.get('args', [])
        need(isinstance(args, list), 'invalid args')
        for arg in args:
            need(isinstance(arg, str) and arg in ALLOWED_ARGS,
                 'argument %s is not allowed' % (json.dumps(arg)[:60] if isinstance(arg, str) else 'value'))
        need(len(set(args)) == len(args), 'duplicate args')
    return plan


def work_counts(counts):
    """Row counts that move only when a session works; the service's own bookkeeping is left out."""
    return {name: value for name, value in counts.items() if name not in BOOKKEEPING_COUNTS}


def select_upgrade(plan, source_commit):
    for upgrade in plan['service']['upgrades']:
        if source_commit in upgrade['fromSourceCommits']:
            return list(upgrade.get('args', []))
    raise ManualRequired('Studio %s needs a manual upgrade from this installation (%s).'
                         % (plan['version'], source_commit[:12]))


def select_release(releases, channel, installed):
    """Highest plain vX.Y.Z release above installed; drafts never.

    The version decides the track, not GitHub's prerelease flag: the 0.2.x
    alpha releases were published as prereleases, yet a plain vX.Y.Z is a
    stable release. From 1.0.0 plain versions are also published as Latest.
    """
    if not isinstance(releases, list):
        raise AgentError('GitHub returned an unexpected releases response')
    best = None
    for release in releases:
        if not isinstance(release, dict) or release.get('draft'):
            continue
        version = tag_version(release.get('tag_name'))
        if version is None:
            continue
        ranked = version_tuple(version)
        if ranked <= installed:
            continue
        if best is None or ranked > best[0]:
            best = (ranked, release)
    return best[1] if best else None


def validate_manifest(manifest, helpers_asset, helpers_sha):
    if not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list) or not manifest['files']:
        raise AgentError('Helper manifest is malformed')
    entries = {}
    for entry in manifest['files']:
        if not isinstance(entry, dict):
            raise AgentError('Helper manifest is malformed')
        path = entry.get('path')
        parts = pathlib.PurePosixPath(path).parts if isinstance(path, str) else ()
        if (not parts or pathlib.PurePosixPath(path).is_absolute() or any(p in ('.', '..') for p in parts)
                or '/'.join(parts) != path):
            raise AgentError('Helper manifest has an unsafe path')
        if not isinstance(entry.get('sha256'), str) or not HEX64.fullmatch(entry['sha256']):
            raise AgentError('Helper manifest has an invalid hash')
        size = entry.get('bytes')
        if size is not None and (type(size) is not int or size < 0):
            raise AgentError('Helper manifest has an invalid size')
        mode = entry.get('mode')
        if mode is not None and type(mode) is not int:
            raise AgentError('Helper manifest has an invalid mode')
        if path in entries:
            raise AgentError('Helper manifest lists a file twice')
        entries[path] = entry
    archive = manifest.get('archive')
    if archive is not None and (not isinstance(archive, str) or posixpath.basename(archive) != helpers_asset):
        raise AgentError('Helper manifest names a different archive')
    if manifest.get('archiveSha256') is not None and manifest.get('archiveSha256') != helpers_sha:
        raise AgentError('Helper manifest describes a different archive')
    return entries


def safe_extract(archive, stage, root, expected, home):
    """Write only regular files under root/; reject links, specials, escapes and unindexed files."""
    try:
        tar = tarfile.open(str(archive), 'r:gz')
    except (tarfile.TarError, OSError, EOFError):
        raise AgentError('Helper archive is not a readable tarball') from None
    files = {}
    with tar:
        selected = []
        total = 0
        try:
            members = tar.getmembers()
        except (tarfile.TarError, OSError, EOFError):
            raise AgentError('Helper archive is not a readable tarball') from None
        if len(members) > HELPER_MAX_FILES:
            raise AgentError('Helper archive has too many entries')
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise AgentError('Helper archive has an unsafe path')
            parts = [part for part in name.parts if part != '.']
            if not parts or parts[0] != root:
                raise AgentError('Helper archive has an entry outside its root folder')
            if member.isdir():
                continue
            if not member.isfile():
                raise AgentError('Helper archive contains a link or special file')
            relative = '/'.join(parts[1:])
            if not relative:
                raise AgentError('Helper archive has an unsafe path')
            if relative in files:
                raise AgentError('Helper archive lists a file twice')
            if expected is not None and relative not in expected:
                raise AgentError('Helper archive contains a file not in the manifest')
            total += member.size
            if total > HELPER_MAX_BYTES:
                raise AgentError('Helper archive is too large')
            files[relative] = None
            selected.append((member, relative))
        if expected is not None and set(files) != set(expected):
            raise AgentError('Helper archive is missing manifest files')
        if ENTRYPOINT not in files:
            raise AgentError('Helper archive has no ' + ENTRYPOINT)
        for member, relative in selected:
            destination = stage.joinpath(*relative.split('/'))
            ensure_dir(destination.parent, home)
            entry = expected.get(relative) if expected is not None else None
            mode_bits = entry.get('mode') if entry and entry.get('mode') is not None else member.mode
            mode = 0o700 if mode_bits & 0o111 else 0o600
            source = tar.extractfile(member)
            if source is None:
                raise AgentError('Helper archive member is unreadable')
            digest = hashlib.sha256()
            size = 0
            fd = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, 'wb') as handle, source:
                for chunk in iter(lambda: source.read(1 << 20), b''):
                    size += len(chunk)
                    digest.update(chunk)
                    handle.write(chunk)
            os.chmod(str(destination), mode)
            value = digest.hexdigest()
            if entry is not None:
                if value != entry['sha256'] or (entry.get('bytes') is not None and size != entry['bytes']):
                    raise AgentError('Helper file does not match the manifest: ' + relative)
            files[relative] = value
    return files


# ---------------------------------------------------------------- installation and config

def studio_home(home, identity):
    return home / '.specweave-studio' / identity


def load_installation(home, identity):
    own = owned(studio_home(home, identity), home)
    receipt = read_json(own / 'installation.json', home, 1 << 20)
    if not isinstance(receipt, dict):
        raise AgentError('Studio installation receipt is malformed')
    service = receipt.get('service') if isinstance(receipt.get('service'), dict) else {}
    checks = [receipt.get('identity') == identity, receipt.get('studioHome') == str(own),
              service.get('label') == 'com.specweave.studio.' + identity,
              version_tuple(receipt.get('version')) is not None,
              isinstance(receipt.get('sourceCommit'), str) and HEX40.fullmatch(receipt['sourceCommit']) is not None]
    if not all(checks):
        raise AgentError('Studio installation receipt does not describe this service')
    return {'identity': identity, 'studioHome': own, 'version': receipt['version'],
            'sourceCommit': receipt['sourceCommit'], 'label': service['label']}


def load_config(updates, home):
    path = updates / 'config.json'
    config = dict(DEFAULT_CONFIG)
    if not os.path.lexists(str(path)):
        return config
    raw = read_json(path, home, 64 << 10)
    if not isinstance(raw, dict):
        raise AgentError('Update settings are malformed')
    for key in DEFAULT_CONFIG:
        if key in raw:
            config[key] = raw[key]
    valid = (type(config['schemaVersion']) is int and config['schemaVersion'] == 1
             and all(type(config[key]) is bool for key in ('checkAutomatically', 'downloadInBackground',
                                                            'installAutomatically'))
             and config['channel'] in ('stable', 'preview')
             and type(config['quietMinutes']) is int and 0 <= config['quietMinutes'] <= 10080
             and isinstance(config['repository'], str) and REPOSITORY.fullmatch(config['repository']) is not None
             and '..' not in config['repository']
             and all(config[key] is None or (isinstance(config[key], str) and 0 < len(config[key]) <= 100)
                     for key in ('installRequestedAt', 'checkRequestedAt')))
    if not valid:
        raise AgentError('Update settings are invalid')
    return config


def blank_state():
    state = {key: None for key in STATE_KEYS}
    state.update({'schemaVersion': 1, 'agentVersion': AGENT_VERSION, 'status': 'up-to-date'})
    return state


def load_state(path, home):
    state = blank_state()
    try:
        raw = read_json(path, home)
    except AgentError:
        return state
    if not isinstance(raw, dict):
        return state
    for key in STATE_KEYS:
        value = raw.get(key)
        if key == 'lastInstall':
            state[key] = value if isinstance(value, dict) else None
        elif key in ('schemaVersion', 'agentVersion'):
            continue
        elif key == 'status':
            state[key] = value if value in STATUSES else 'up-to-date'
        else:
            state[key] = value if isinstance(value, str) else None
    return state


# ---------------------------------------------------------------- injectable process seams

def find_gh_token(home):
    """`gh auth token` from known Homebrew locations, then PATH. Output stays in memory."""
    candidates = list(GH_PATHS)
    found = shutil.which('gh')
    if found and found not in candidates:
        candidates.append(found)
    environment = {'HOME': str(home), 'PATH': '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
                   'LANG': 'en_US.UTF-8'}
    for candidate in candidates:
        if not (os.path.isfile(candidate) and os.access(candidate, os.X_OK)):
            continue
        try:
            result = subprocess.run([candidate, 'auth', 'token'], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=GH_TIMEOUT, env=environment)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0:
            value = result.stdout.decode('utf-8', 'replace').strip()
            if TOKEN_SHAPE.fullmatch(value):
                return value
    return None


def run_helper_process(command, cwd, env, timeout, pass_fds=(), wait_detached=False, log_path=None, home=None):
    """Run a verified helper. Returns 'ok', 'failed' or 'timeout'.

    Output is discarded unless log_path is given; then stdout and stderr go to that new
    private file (never to agent.log) so a failed install can be diagnosed afterwards.
    Snapshot children are ours and read-only, so subprocess may stop them on timeout.
    Apply children (wait_detached) are never signalled: they run in their own session,
    keep the inherited pass lock until they exit and own any rollback themselves.
    """
    sink = subprocess.DEVNULL
    if log_path is not None:
        try:
            if home is not None:
                owned(log_path, home)
            sink = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except (OSError, AgentError):
            sink = subprocess.DEVNULL  # Diagnostics never block an install.
    try:
        if not wait_detached:
            result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=sink, stderr=sink, timeout=timeout)
            return 'ok' if result.returncode == 0 else 'failed'
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=sink, stderr=sink,
                                   start_new_session=True, pass_fds=tuple(pass_fds))
        try:
            return 'ok' if process.wait(timeout=timeout) == 0 else 'failed'
        except subprocess.TimeoutExpired:
            return 'timeout'
    except subprocess.TimeoutExpired:
        return 'timeout'
    except (OSError, subprocess.SubprocessError):
        return 'failed'
    finally:
        if isinstance(sink, int) and sink >= 0:
            os.close(sink)


def waiting_reason(refusal):
    """The message for a refused snapshot: what is still running, when the helper said."""
    for phrase, message in WAITING_REASONS:
        if phrase in refusal:
            return message
    return WAITING


def helper_log_path(receipt):
    """The private helper output file kept next to an update receipt."""
    receipt = pathlib.Path(receipt)
    return receipt.with_name(receipt.stem + '.log')


def read_tail(path, home, limit=HELPER_TAIL):
    """The last `limit` bytes of a helper output file as text, or '' when unreadable."""
    try:
        owned(path, home)
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except (OSError, AgentError):
        return ''
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            return ''
        handle.seek(max(0, info.st_size - limit))
        return handle.read(limit).decode('utf-8', 'replace')


def launchctl(args):
    if sys.platform != 'darwin':
        raise AgentError('LaunchAgents are only available on macOS')
    try:
        return subprocess.run(['/bin/launchctl'] + list(args), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30).returncode
    except (OSError, subprocess.SubprocessError):
        return 1


def current_uid():
    return os.getuid()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Redirects are followed manually so credentials stay on the API host.


def _loopback(parts):
    return (parts.hostname or '') in LOOPBACK


# ---------------------------------------------------------------- the pass

class Agent(object):
    def __init__(self, home, identity, test_mode, out):
        self.home = home
        self.identity = identity
        self.test_mode = test_mode
        self.out = out
        self.own = studio_home(home, identity)
        self.updates = self.own / 'updates'
        self.state_path = self.updates / 'state.json'
        self.marker_path = self.updates / 'install-in-progress.json'
        self.state = blank_state()
        self.config = dict(DEFAULT_CONFIG)
        self.inst = None
        self.lock_fd = None
        self._token = None
        self._token_resolved = False

    # -- state

    def save(self):
        self.state['updatedAt'] = iso(utcnow())
        write_json(self.state_path, {key: self.state.get(key) for key in STATE_KEYS}, self.home)

    def set_status(self, status, message=None):
        assert status in STATUSES
        self.state['status'] = status
        self.state['message'] = redact(message) if message else None
        self.save()

    def finish(self, status, message=None):
        self.set_status(status, message)
        line = 'update-agent %s: %s' % (self.identity, status)
        if self.state['message']:
            line += ': ' + self.state['message'][:300]
        self.out(line)
        return 1 if status == 'error' else 0

    def clear_available(self):
        for key in ('availableVersion', 'availableTag', 'availableNotes', 'availablePublishedAt', 'downloadedVersion'):
            self.state[key] = None

    # -- network

    def api_base(self):
        base = (os.environ.get('STUDIO_UPDATE_API_URL') or DEFAULT_API).rstrip('/')
        parts = urllib.parse.urlsplit(base)
        if parts.scheme != 'https' and not (parts.scheme == 'http' and _loopback(parts)):
            raise AgentError('STUDIO_UPDATE_API_URL must be an https URL')
        if parts.username or parts.password or parts.query or parts.fragment:
            raise AgentError('STUDIO_UPDATE_API_URL must be a plain URL')
        return base

    def token(self):
        if not self._token_resolved:
            self._token_resolved = True
            value = None
            for key in ('STUDIO_UPDATE_TOKEN', 'GH_TOKEN'):
                candidate = os.environ.get(key, '').strip()
                if candidate:
                    if not TOKEN_SHAPE.fullmatch(candidate):
                        _REDACT.add(candidate)
                        raise AgentError('The configured GitHub token is malformed')
                    value = candidate
                    break
            if value is None:
                value = find_gh_token(self.home)
            if value:
                _REDACT.add(value)
            self._token = value
        return self._token

    def open_url(self, url, accept):
        origin = urllib.parse.urlsplit(self.api_base())
        current = url
        for _ in range(6):
            parts = urllib.parse.urlsplit(current)
            if parts.scheme != 'https' and not (parts.scheme == 'http' and _loopback(parts)):
                raise AgentError('GitHub redirected to an insecure location')
            same_host = (parts.scheme, parts.netloc) == (origin.scheme, origin.netloc)
            headers = {'Accept': accept, 'User-Agent': 'specweave-studio-update-agent/%d' % AGENT_VERSION}
            token = self.token()
            if same_host:
                headers['X-GitHub-Api-Version'] = '2022-11-28'
                if token:
                    headers['Authorization'] = 'Bearer ' + token
            handlers = [_NoRedirect()]
            if _loopback(parts):
                handlers.append(urllib.request.ProxyHandler({}))
            opener = urllib.request.build_opener(*handlers)
            request = urllib.request.Request(current, headers=headers)
            try:
                return opener.open(request, timeout=HTTP_TIMEOUT)
            except urllib.error.HTTPError as error:
                code = error.code
                location = error.headers.get('Location') if error.headers else None
                error.close()
                if code in (301, 302, 303, 307, 308):
                    if not location:
                        raise AgentError('GitHub sent a redirect without a location') from None
                    current = urllib.parse.urljoin(current, location)
                    continue
                raise HttpFailure('GitHub request failed (HTTP %d)' % code, code) from None
            except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
                raise AgentError('Could not reach GitHub (%s)' % type(error).__name__) from None
        raise AgentError('GitHub sent too many redirects')

    def fetch(self, url, accept, limit, sink):
        response = self.open_url(url, accept)
        total = 0
        try:
            with response:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise AgentError('A GitHub download exceeded its size limit')
                    sink(chunk)
        except (http.client.HTTPException, OSError) as error:
            raise AgentError('GitHub download was interrupted (%s)' % type(error).__name__) from None
        return total

    def fetch_bytes(self, url, accept, limit):
        chunks = []
        self.fetch(url, accept, limit, chunks.append)
        return b''.join(chunks)

    def asset_url(self, asset):
        return '%s/repos/%s/releases/assets/%d' % (self.api_base(), self.config['repository'], asset['id'])

    def download_asset(self, name, asset, destination, limit):
        expected = asset.get('size')
        if destination.is_file() and not destination.is_symlink() and type(expected) is int \
                and destination.stat().st_size == expected:
            return destination  # Completed by an earlier pass; verification follows regardless.
        part = destination.with_name(destination.name + '.part')
        if os.path.lexists(str(part)):
            remove_path(part, self.home)
        fd = os.open(str(part), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as handle:
                try:
                    size = self.fetch(self.asset_url(asset), 'application/octet-stream', limit, handle.write)
                except HttpFailure as error:
                    raise AgentError('Downloading %s failed (HTTP %d)' % (name, error.code)) from None
                handle.flush()
                os.fsync(handle.fileno())
            if type(expected) is int and size != expected:
                raise AgentError('Download of %s was incomplete' % name)
            os.replace(str(part), str(destination))
        except BaseException:
            if os.path.lexists(str(part)):
                os.unlink(str(part))
            raise
        return destination

    # -- check

    def check_is_due(self):
        checked = parse_time(self.state.get('checkedAt'))
        now = utcnow()
        return checked is None or checked > now + datetime.timedelta(minutes=5) or now - checked >= CHECK_INTERVAL

    def release_dir(self, version):
        return self.updates / 'downloads' / version

    def check(self):
        repository = self.config['repository']
        try:
            body = self.fetch_bytes('%s/repos/%s/releases?per_page=30' % (self.api_base(), repository),
                                    'application/vnd.github+json', LIMITS['list'])
        except HttpFailure as error:
            if error.code in (401, 403, 404) and not self.token():
                raise AgentError(SIGN_IN) from None
            if error.code in (401, 403, 404):
                raise AgentError('GitHub refused access to %s releases (HTTP %d). Check that `gh auth login` '
                                 'can read the repository.' % (repository, error.code)) from None
            raise AgentError('Checking %s releases failed (HTTP %d)' % (repository, error.code)) from None
        try:
            releases = json.loads(body.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise AgentError('GitHub returned an unreadable releases response') from None
        installed = version_tuple(self.inst['version'])
        release = select_release(releases, self.config['channel'], installed)
        self.state['checkedAt'] = iso(utcnow())
        if release is None:
            self.clear_available()
            return None
        version = tag_version(release['tag_name'])
        notes = release.get('body') if isinstance(release.get('body'), str) else None
        published = release.get('published_at') if isinstance(release.get('published_at'), str) else None
        if self.state.get('availableVersion') != version:
            self.state['downloadedVersion'] = None
        self.state.update({'availableVersion': version, 'availableTag': release['tag_name'],
                           'availableNotes': notes[:NOTES_LIMIT] if notes else None,
                           'availablePublishedAt': published[:64] if published else None})
        assets = {}
        for asset in release.get('assets') or []:
            if isinstance(asset, dict) and _safe_name(asset.get('name')) and type(asset.get('id')) is int:
                size = asset.get('size')
                assets[asset['name']] = {'id': asset['id'], 'size': size if type(size) is int else None}
        meta = {'schemaVersion': 1, 'tag': release['tag_name'], 'version': version, 'assets': assets,
                'plan': None, 'planSha256': None, 'args': None, 'manual': None, 'rejected': None,
                'checkedAt': self.state['checkedAt']}
        directory = ensure_dir(self.release_dir(version), self.home)
        if PLAN_ASSET not in assets:
            meta['manual'] = 'Studio %s needs a manual upgrade: the release has no update plan.' % version
        else:
            try:
                plan_bytes = self.fetch_bytes(self.asset_url(assets[PLAN_ASSET]), 'application/octet-stream',
                                              LIMITS[PLAN_ASSET])
            except HttpFailure as error:
                raise AgentError('Downloading %s failed (HTTP %d)' % (PLAN_ASSET, error.code)) from None
            try:
                try:
                    plan = json.loads(plan_bytes.decode('utf-8'))
                except (UnicodeDecodeError, ValueError):
                    raise AgentError('Update plan was rejected: not valid JSON') from None
                validate_plan(plan, version)
                if version_tuple(plan['version']) <= installed:
                    raise AgentError('Update plan was rejected: version is not newer than the installation')
                for name in (plan['service']['runtime']['asset'], plan['service']['helpers']['asset'], SUMS_ASSET):
                    if name not in assets:
                        raise AgentError('Release %s is missing %s' % (release['tag_name'], name))
                meta['args'] = select_upgrade(plan, self.inst['sourceCommit'])
                meta['plan'] = plan
                meta['planSha256'] = sha256_bytes(plan_bytes)
                atomic_write(directory / PLAN_ASSET, plan_bytes, self.home)
            except ManualRequired as error:
                meta['manual'] = error.message
            except AgentError as error:
                meta['rejected'] = 'Release %s: %s' % (release['tag_name'], error.message)
        write_json(directory / 'release.json', meta, self.home)
        return meta

    def load_release(self, version):
        if version_tuple(version) is None:
            return None
        path = self.release_dir(version) / 'release.json'
        if not path.is_file():
            return None
        try:
            meta = read_json(path, self.home)
        except AgentError:
            return None
        if not isinstance(meta, dict) or meta.get('version') != version or not isinstance(meta.get('assets'), dict):
            return None
        if meta.get('plan') is not None:
            try:
                validate_plan(meta['plan'], version)
            except AgentError:
                return None
        return meta

    # -- download and verify

    def load_verified(self, meta):
        directory = self.release_dir(meta['version'])
        path = directory / 'verified.json'
        if not meta.get('planSha256') or not path.is_file():
            return None
        try:
            verified = read_json(path, self.home)
        except AgentError:
            return None
        try:
            if not isinstance(verified, dict) or verified.get('version') != meta['version'] \
                    or verified.get('planSha256') != meta['planSha256'] \
                    or not isinstance(verified['helpers']['files'], dict) \
                    or not HEX64.fullmatch(verified['runtime']['sha256']) \
                    or not _safe_name(verified['runtime']['asset']) or not _safe_name(verified['helpers']['root']) \
                    or not all(arg in ALLOWED_ARGS for arg in verified['args']):
                return None
            if not (directory / verified['runtime']['asset']).is_file():
                return None
        except (KeyError, TypeError):
            return None
        return verified

    def download_and_verify(self, meta):
        version, plan = meta['version'], meta['plan']
        runtime, helpers = plan['service']['runtime'], plan['service']['helpers']
        directory = ensure_dir(self.release_dir(version), self.home)
        names = [SUMS_ASSET, runtime['asset'], helpers['asset']]
        if MANIFEST_ASSET in meta['assets']:
            names.append(MANIFEST_ASSET)
        limits = {runtime['asset']: LIMITS['runtime'], helpers['asset']: LIMITS['helpers']}
        try:
            for name in names:
                self.download_asset(name, meta['assets'][name], directory / name, limits.get(name, LIMITS.get(name)))
            sums = parse_sums(read_owned(directory / SUMS_ASSET, self.home, LIMITS[SUMS_ASSET]))
            for label, entry in (('Runtime archive', runtime), ('Helper archive', helpers)):
                actual = sha256_file(directory / entry['asset'])
                if sums.get(entry['asset']) != entry['sha256'] or actual != entry['sha256']:
                    raise AgentError('%s checksum does not match the release' % label)
            plan_bytes = read_owned(directory / PLAN_ASSET, self.home, LIMITS[PLAN_ASSET])
            if sha256_bytes(plan_bytes) != meta['planSha256'] or (
                    PLAN_ASSET in sums and sums[PLAN_ASSET] != meta['planSha256']):
                raise AgentError('Update plan checksum does not match the release')
            expected = None
            if MANIFEST_ASSET in names:
                manifest_bytes = read_owned(directory / MANIFEST_ASSET, self.home, LIMITS[MANIFEST_ASSET])
                if MANIFEST_ASSET in sums and sums[MANIFEST_ASSET] != sha256_bytes(manifest_bytes):
                    raise AgentError('Helper manifest checksum does not match the release')
                try:
                    manifest = json.loads(manifest_bytes.decode('utf-8'))
                except (UnicodeDecodeError, ValueError):
                    raise AgentError('Helper manifest is malformed') from None
                expected = validate_manifest(manifest, helpers['asset'], helpers['sha256'])
            files = self.extract_helpers(directory / helpers['asset'], version, helpers['root'], expected)
        except AgentError:
            for name in names:
                for path in (directory / name, directory / (name + '.part')):
                    if os.path.lexists(str(path)):
                        remove_path(path, self.home)
            raise
        verified = {'schemaVersion': 1, 'version': version, 'tag': meta['tag'], 'planSha256': meta['planSha256'],
                    'runtime': {'asset': runtime['asset'], 'sha256': runtime['sha256']},
                    'helpers': {'root': helpers['root'], 'sha256': helpers['sha256'], 'files': files},
                    'entrypoint': ENTRYPOINT, 'args': meta['args'], 'verifiedAt': iso(utcnow())}
        write_json(directory / 'verified.json', verified, self.home)
        if os.path.lexists(str(directory / 'rejected.json')):
            remove_path(directory / 'rejected.json', self.home)
        return verified

    def extract_helpers(self, archive, version, root, expected):
        parent = ensure_dir(self.updates / 'helpers', self.home)
        final = parent / version
        stage = parent / ('.stage-%s-%s' % (version, uuid.uuid4().hex[:12]))
        ensure_dir(stage / root, self.home)
        try:
            files = safe_extract(archive, stage / root, root, expected, self.home)
            if os.path.lexists(str(final)):
                remove_path(final, self.home)
            os.rename(str(stage), str(final))
        except BaseException:
            if os.path.lexists(str(stage)):
                remove_path(stage, self.home)
            raise
        return files

    def verify_helpers(self, verified):
        root = owned(self.updates / 'helpers' / verified['version'] / verified['helpers']['root'], self.home)
        if not root.is_dir():
            raise AgentError('Verified helpers are missing; they will be downloaded again')
        actual = {}
        for directory, dirnames, filenames in os.walk(str(root)):
            for name in dirnames + filenames:
                path = pathlib.Path(directory) / name
                if path.is_symlink():
                    raise AgentError('Verified helpers changed on disk')
            for name in filenames:
                path = pathlib.Path(directory) / name
                actual[path.relative_to(root).as_posix()] = sha256_file(path)
        if actual != verified['helpers']['files']:
            raise AgentError('Verified helpers changed on disk')
        return root / 'scripts' / 'studio-fleet'

    def reject(self, version, message):
        directory = ensure_dir(self.release_dir(version), self.home)
        write_json(directory / 'rejected.json', {'version': version, 'at': iso(utcnow()), 'reason': message}, self.home)

    def load_rejected(self, version):
        path = self.release_dir(version) / 'rejected.json'
        if not path.is_file():
            return None
        try:
            value = read_json(path, self.home)
        except AgentError:
            return {'reason': 'Studio %s failed verification' % version}
        return value if isinstance(value, dict) else {'reason': 'Studio %s failed verification' % version}

    # -- helper execution

    def helper_python(self):
        override = os.environ.get('STUDIO_UPDATE_HELPER_PYTHON')
        if self.test_mode and override and os.path.isabs(override) and os.path.isfile(override):
            return override
        return SYSTEM_PYTHON

    def helper_env(self):
        return {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}

    def helper_command(self, helper_dir, args):
        return [self.helper_python(), '-B', '-E', '-s', str(helper_dir / 'update.py')] + [str(arg) for arg in args]

    def read_snapshot(self, path):
        try:
            value = read_json(path, self.home)
        except AgentError:
            return None
        rows = value.get('rows') if isinstance(value, dict) else None
        if not (isinstance(rows, dict) and isinstance(rows.get('counts'), dict) and rows.get('nativeWorkIdle') is True
                and type(value.get('servicePid')) is int and parse_time(value.get('observedAt'))):
            return None
        return value

    # -- install

    def quiet_then_install(self, verified, install_request):
        version = verified['version']
        helper_dir = self.verify_helpers(verified)
        snapshots = ensure_dir(self.updates / 'snapshots', self.home)
        baseline_path = snapshots / 'baseline.json'
        newest = snapshots / ('snapshot-%s-%s.json' % (stamp(), uuid.uuid4().hex[:8]))
        output = newest.with_suffix('.log')
        outcome = run_helper_process(self.helper_command(helper_dir, ['--identity', self.identity, '--snapshot', newest]),
                                     str(helper_dir), self.helper_env(), SNAPSHOT_TIMEOUT,
                                     log_path=output, home=self.home)
        snapshot = self.read_snapshot(newest) if outcome == 'ok' else None
        refusal = read_tail(output, self.home) if snapshot is None and os.path.lexists(str(output)) else ''
        if os.path.lexists(str(output)):
            remove_path(output, self.home)
        if snapshot is None:
            for path in (newest, baseline_path):
                if os.path.lexists(str(path)):
                    remove_path(path, self.home)
            self.state['quietSince'] = None
            return self.finish('waiting-for-quiet', waiting_reason(refusal))
        baseline = self.read_snapshot(baseline_path) if os.path.lexists(str(baseline_path)) else None
        now = utcnow()
        quiet = False
        same = (baseline is not None and baseline['servicePid'] == snapshot['servicePid']
                and work_counts(baseline['rows']['counts']) == work_counts(snapshot['rows']['counts']))
        if same:
            since = parse_time(baseline['observedAt'])
            if since <= now + datetime.timedelta(minutes=5):
                quiet = now - since >= datetime.timedelta(minutes=self.config['quietMinutes'])
            else:
                same = False  # A future-dated baseline cannot prove quiet time.
        if install_request or quiet:
            return self.apply(verified, helper_dir, newest, baseline_path, install_request)
        if same:
            remove_path(newest, self.home)  # Keep the older matching baseline so quiet time accrues.
        else:
            os.replace(str(newest), str(baseline_path))
            baseline = snapshot
        self.state['quietSince'] = baseline['observedAt']
        return self.finish('waiting-for-quiet', 'Waiting for a quiet moment before installing Studio %s' % version)

    def apply(self, verified, helper_dir, prestate, baseline_path, install_request):
        version = verified['version']
        runtime = owned(self.release_dir(version) / verified['runtime']['asset'], self.home)
        if sha256_file(runtime) != verified['runtime']['sha256']:
            remove_path(self.release_dir(version) / 'verified.json', self.home)
            raise AgentError('Downloaded runtime changed on disk; it will be downloaded again')
        receipts = ensure_dir(self.updates / 'receipts', self.home)
        moment = stamp()
        receipt = receipts / ('update-%s-%s.json' % (version, moment))
        kept = receipts / ('prestate-%s-%s.json' % (version, moment))
        os.replace(str(prestate), str(kept))
        if os.path.lexists(str(baseline_path)):
            remove_path(baseline_path, self.home)
        self.state['quietSince'] = None
        if install_request:
            self.state['handledInstallRequestAt'] = self.config['installRequestedAt']
        write_json(self.marker_path, {'version': version, 'receipt': str(receipt), 'at': iso(utcnow())}, self.home)
        self.set_status('installing', 'Installing Studio %s' % version)
        args = ['--identity', self.identity, '--prestate', kept, '--archive', runtime,
                '--sha256', verified['runtime']['sha256'], '--output', receipt] + list(verified['args'])
        pass_fds = (self.lock_fd,) if self.lock_fd is not None else ()
        outcome = run_helper_process(self.helper_command(helper_dir, args), str(helper_dir), self.helper_env(),
                                     APPLY_TIMEOUT, pass_fds=pass_fds, wait_detached=True,
                                     log_path=helper_log_path(receipt))
        status, message = self.complete_install(version, receipt, outcome)
        return self.finish(status, message)

    def complete_install(self, version, receipt, outcome):
        try:
            inst = load_installation(self.home, self.identity)
        except AgentError:
            inst = None
        if inst is not None:
            self.inst = inst
            self.state['installedVersion'] = inst['version']
            self.state['installedSourceCommit'] = inst['sourceCommit']
        if os.path.lexists(str(self.marker_path)):
            remove_path(self.marker_path, self.home)
        now = iso(utcnow())
        if outcome == 'ok' and inst is not None and inst['version'] == version:
            self.state['lastInstall'] = {'version': version, 'at': now, 'result': 'updated', 'receipt': str(receipt)}
            self.clear_available()
            self.cleanup_versions(version_tuple(inst['version']))
            return 'installed', 'Studio %s is installed' % version
        self.state['lastInstall'] = {'version': version, 'at': now, 'result': 'failed', 'receipt': str(receipt)}
        current = inst['version'] if inst is not None else 'its previous version'
        if outcome == 'failed':
            self.ensure_failure_receipt(version, receipt, current)
        if outcome == 'timeout':
            return 'error', ('Installing Studio %s is taking longer than 15 minutes; it was left to finish. '
                             'See the update receipt.' % version)
        if outcome == 'interrupted':
            return 'error', 'The install of Studio %s was interrupted; Studio is on %s.' % (version, current)
        return 'error', 'Studio %s did not install; Studio stayed on %s. See the update receipt.' % (version, current)

    def ensure_failure_receipt(self, version, receipt, current):
        """A helper that failed before writing its receipt still leaves one with its cause."""
        if not receipt:
            return
        try:
            path = owned(pathlib.Path(receipt), self.home)
            if os.path.lexists(str(path)):
                return
            log = helper_log_path(path)
            write_json(path, {'identity': self.identity, 'version': version, 'result': 'update-failed',
                              'phase': 'preflight', 'exitOutcome': 'failed', 'stayedOn': current,
                              'helperLog': str(log) if os.path.lexists(str(log)) else None,
                              'stderrTail': redact(read_tail(log, self.home))}, self.home)
        except (OSError, AgentError) as error:
            print('update-agent %s: could not write the failed-install receipt (%s)'
                  % (self.identity, type(error).__name__), file=sys.stderr)

    def cleanup_versions(self, installed):
        for parent in (self.updates / 'downloads', self.updates / 'helpers'):
            if not parent.is_dir() or parent.is_symlink():
                continue
            for child in parent.iterdir():
                ranked = version_tuple(child.name)
                if (ranked is not None and ranked <= installed) or child.name.startswith('.stage-'):
                    remove_path(child, self.home)

    def settle_interrupted(self):
        """A pass that died while installing left a marker; record its outcome without retrying."""
        try:
            marker = read_json(self.marker_path, self.home)
        except AgentError:
            marker = None
        if not isinstance(marker, dict) or version_tuple(marker.get('version')) is None:
            return None
        version = marker['version']
        outcome = 'ok' if self.inst['version'] == version else 'interrupted'
        return self.complete_install(version, marker.get('receipt'), outcome)

    def rotate_log(self):
        path = self.updates / 'agent.log'
        try:
            info = os.lstat(str(path))
        except OSError:
            return
        if stat.S_ISREG(info.st_mode) and info.st_size > LOG_LIMIT:
            os.truncate(str(path), 0)

    # -- one pass

    def run_pass(self):
        state, config = self.state, self.config
        state['installedVersion'] = self.inst['version']
        state['installedSourceCommit'] = self.inst['sourceCommit']
        installed = version_tuple(self.inst['version'])
        if state['status'] == 'installing' or os.path.lexists(str(self.marker_path)):
            settled = self.settle_interrupted()
            if settled is not None:
                return self.finish(*settled)
        # A manual or failed install leaves downloads and helpers that only a
        # successful agent install used to clean; drop any at or below this version.
        try:
            self.cleanup_versions(installed)
        except (AgentError, OSError):
            pass
        for key in ('availableVersion', 'downloadedVersion'):
            ranked = version_tuple(state.get(key))
            if state.get(key) is not None and (ranked is None or ranked <= installed):
                if key == 'availableVersion':
                    self.clear_available()
                state[key] = None
        install_request = config['installRequestedAt'] is not None and \
            config['installRequestedAt'] != state.get('handledInstallRequestAt')
        check_request = config['checkRequestedAt'] is not None and \
            config['checkRequestedAt'] != state.get('handledCheckRequestAt')
        if not config['checkAutomatically'] and not install_request and not check_request:
            return self.finish('disabled', 'Automatic update checks are off')
        meta = self.load_release(state['availableVersion']) if state.get('availableVersion') else None
        due = (check_request or (config['checkAutomatically'] and self.check_is_due())
               or (install_request and meta is None) or (state.get('availableVersion') and meta is None))
        fresh = False
        if due:
            if check_request:
                state['handledCheckRequestAt'] = config['checkRequestedAt']
            try:
                meta = self.check()
                fresh = True
            except AgentError as error:
                if not (meta and meta.get('plan') and self.load_verified(meta)):
                    return self.finish(error.status, error.message)
                # The network failed but a verified download is ready: keep going with it.
        if meta is None:
            if install_request:
                state['handledInstallRequestAt'] = config['installRequestedAt']
            return self.finish('up-to-date', None)
        if meta.get('manual') or meta.get('rejected') or not meta.get('plan'):
            if install_request:
                state['handledInstallRequestAt'] = config['installRequestedAt']
            if meta.get('manual'):
                return self.finish('manual-required', meta['manual'])
            return self.finish('error', meta.get('rejected') or 'The release update plan is unusable')
        version = meta['version']
        verified = self.load_verified(meta)
        if verified is None:
            state['downloadedVersion'] = None
            if not (config['downloadInBackground'] or install_request):
                return self.finish('available', None)
            rejected = self.load_rejected(version)
            if rejected and not fresh:
                if install_request:
                    state['handledInstallRequestAt'] = config['installRequestedAt']
                return self.finish('error', rejected.get('reason') or 'Studio %s failed verification' % version)
            self.set_status('downloading', 'Downloading Studio %s' % version)
            try:
                verified = self.download_and_verify(meta)
            except AgentError as error:
                self.reject(version, error.message)
                if install_request:
                    state['handledInstallRequestAt'] = config['installRequestedAt']
                return self.finish('error', error.message)
            state['downloadedVersion'] = version
            self.set_status('downloaded', None)
        state['downloadedVersion'] = version
        if not (config['installAutomatically'] or install_request):
            return self.finish('downloaded', None)
        last = state.get('lastInstall')
        if not install_request and isinstance(last, dict) and last.get('version') == version \
                and last.get('result') == 'failed':
            return self.finish('error', 'Studio %s did not install automatically; choose Install now to retry.' % version)
        return self.quiet_then_install(verified, install_request)


# ---------------------------------------------------------------- entry points

def acquire_lock(path, home):
    owned(path, home)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(fd)
        if error.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
            return None
        raise
    return fd


def run_once(home, identity, test_mode, out):
    own = owned(studio_home(home, identity), home)
    if not own.is_dir():
        raise AgentError('Studio %s is not installed' % identity)
    updates = ensure_dir(own / 'updates', home)
    os.chmod(str(updates), 0o700)
    lock_fd = acquire_lock(updates / 'agent.lock', home)
    if lock_fd is None:
        return 0  # Another pass (or a still-running helper) holds the lock.
    try:
        agent = Agent(home, identity, test_mode, out)
        agent.lock_fd = lock_fd
        agent.rotate_log()
        agent.state = load_state(agent.state_path, home)
        try:
            agent.config = load_config(updates, home)
            agent.inst = load_installation(home, identity)
            return agent.run_pass()
        except AgentError as error:
            return agent.finish(error.status, error.message)
        except Exception as error:  # Never let a traceback (with possible values) reach the log.
            return agent.finish('error', 'Unexpected updater failure (%s)' % type(error).__name__)
    finally:
        os.close(lock_fd)


def show_status(home, identity, out):
    own = owned(studio_home(home, identity), home)
    path = own / 'updates' / 'state.json'
    if path.is_file():
        state = load_state(path, home)
        try:
            raw = read_json(path, home)
            if isinstance(raw, dict) and raw.get('updatedAt'):
                state['updatedAt'] = raw['updatedAt'] if isinstance(raw['updatedAt'], str) else None
        except AgentError:
            pass
    else:
        state = blank_state()
        try:
            config = load_config(own / 'updates', home)
        except AgentError:
            config = dict(DEFAULT_CONFIG)
        state['status'] = 'up-to-date' if config['checkAutomatically'] else 'disabled'
        state['message'] = 'No update check has run yet' if config['checkAutomatically'] else \
            'Automatic update checks are off'
        try:
            inst = load_installation(home, identity)
            state['installedVersion'] = inst['version']
            state['installedSourceCommit'] = inst['sourceCommit']
        except AgentError:
            pass
    out(json.dumps({key: state.get(key) for key in STATE_KEYS}))
    return 0


def agent_label(identity):
    return 'com.specweave.studio.%s.updater' % identity


def install_launch_agent(home, identity, out):
    inst = load_installation(home, identity)
    updates = ensure_dir(inst['studioHome'] / 'updates', home)
    label = agent_label(identity)
    target_dir = ensure_dir(home / '.local' / 'share' / 'specweave-studio' / 'updater', home)
    os.chmod(str(target_dir), 0o700)
    script = owned(target_dir / 'update_agent.py', home)
    source = pathlib.Path(os.path.abspath(__file__)).read_bytes()
    plist_path = owned(home / 'Library' / 'LaunchAgents' / (label + '.plist'), home)
    ensure_dir(plist_path.parent, home)
    log = str(updates / 'agent.log')
    content = plistlib.dumps({'Label': label,
                              'ProgramArguments': [SYSTEM_PYTHON, str(script), '--identity', identity],
                              'StartInterval': 600, 'RunAtLoad': True, 'ProcessType': 'Background',
                              'LowPriorityIO': True, 'StandardOutPath': log, 'StandardErrorPath': log,
                              'WorkingDirectory': str(updates)})

    def same(path, data):
        return path.is_file() and not path.is_symlink() and read_owned(path, home, 8 << 20) == data

    script_same, plist_same = same(script, source), same(plist_path, content)
    domain = 'gui/%d' % current_uid()
    if script_same and plist_same and launchctl(['print', domain + '/' + label]) == 0:
        result = 'unchanged'
    else:
        if not script_same:
            atomic_write(script, source, home, 0o700)
        if not plist_same:
            atomic_write(plist_path, content, home, 0o644)
        launchctl(['bootout', domain + '/' + label])  # Not loaded yet is fine.
        if launchctl(['bootstrap', domain, str(plist_path)]) != 0:
            raise AgentError('launchctl could not load the update agent')
        result = 'installed'
    out(json.dumps({'result': result, 'label': label}))
    return 0


def uninstall_launch_agent(home, identity, out):
    label = agent_label(identity)
    plist_path = owned(home / 'Library' / 'LaunchAgents' / (label + '.plist'), home)
    launchctl(['bootout', 'gui/%d/%s' % (current_uid(), label)])
    existed = os.path.lexists(str(plist_path))
    if existed:
        remove_path(plist_path, home)
    out(json.dumps({'result': 'uninstalled' if existed else 'absent', 'label': label}))
    return 0


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='SpecWithCode background update agent')
    parser.add_argument('--identity', choices=IDENTITIES, required=True)
    parser.add_argument('--home', help=argparse.SUPPRESS)  # Tests only: a temporary private home.
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--install-launch-agent', action='store_true')
    mode.add_argument('--uninstall-launch-agent', action='store_true')
    mode.add_argument('--status', action='store_true')
    args = parser.parse_args(argv)
    home = pathlib.Path(args.home).resolve() if args.home else pathlib.Path.home().resolve()

    def out(line):
        print(redact(line))
        sys.stdout.flush()

    try:
        if args.install_launch_agent:
            return install_launch_agent(home, args.identity, out)
        if args.uninstall_launch_agent:
            return uninstall_launch_agent(home, args.identity, out)
        if args.status:
            return show_status(home, args.identity, out)
        return run_once(home, args.identity, bool(args.home), out)
    except AgentError as error:
        print('update-agent %s: error: %s' % (args.identity, redact(error.message)), file=sys.stderr)
        return 1
    except Exception as error:
        print('update-agent %s: error: unexpected failure (%s)' % (args.identity, type(error).__name__),
              file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
