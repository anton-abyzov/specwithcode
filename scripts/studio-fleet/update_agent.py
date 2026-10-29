#!/usr/bin/env python3
"""Background Studio update agent: one resumable, lock-guarded pass per launchd run.

A pass discovers a newer GitHub release, verifies its update plan, assets and helper
files, waits for a quiet moment and then runs the target release's own guarded
update.py. The agent never stops or signals the Studio service; only that verified
helper restarts it. GitHub tokens stay in memory: they are never written, logged or
placed in exception text. Helper output is discarded; only short status lines print.
Stdlib only and Python 3.9 compatible (macOS /usr/bin/python3); copied with its siblings
update_agent_reap.py, update_agent_cache.py, update_request.py, update_agent_pause.py, service_hold.py,
service_handles.py and live_database.py into the updater LaunchAgent location (update_request.AGENT_FILES).
"""
import argparse
import datetime
import errno
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
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.dont_write_bytecode = True  # Never write __pycache__ into the signed app bundle.
import update_agent_reap as reaper  # noqa: E402  Update now's fallback; installed beside this file.
import update_agent_cache as cache  # noqa: E402  Shipped beside this file.
import update_request  # noqa: E402  Shipped beside this file.
import update_agent_recovery as recovery  # noqa: E402  Shipped beside this file.
import update_agent_pause as pause  # noqa: E402  Shipped beside this file, with service_hold.py.
from update_agent_pause import TIMED_OUT, WAITING, WAITING_REASONS, refusal_reason  # noqa: E402,F401  Refusals moved there.
import update_agent_run as runs  # noqa: E402  Shipped beside this file: run.json, the pass lock, log rotation.
import installation_descriptor  # noqa: E402  Shipped beside this file.
import studio_paths  # noqa: E402  Shipped beside this file.

AGENT_VERSION = 1
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
CHECK_INTERVAL = update_request.CHECK_INTERVAL  # 60 minutes; status() calls a check older than 2x stale.
# Two process inventories bracket the snapshot and it hashes every guarded table; on a
# loaded Mac one took almost 4 minutes, so the limit leaves room before reporting "busy".
SNAPSHOT_TIMEOUT = 600
# How long the agent waits for the install helper, passed to it as STUDIO_UPDATE_APPLY_BUDGET so
# the helper always ends (restart or rollback included) within it. 40 minutes lets a busy Mac with
# a large database spend up to 28 minutes before the restart: on M4 (1.0.112) the before-read,
# staging and prestate re-read took 902 s and a 1500 s budget refused at 780 s.
APPLY_TIMEOUT = 2400
# While an install request waits for the service to drain, a pass snapshots again this often.
# A forced request retries until the service's update hold ends (at most 15 minutes); a plain
# one retries briefly, then waits for quiet as before. An apply for either that the helper refused before
# the restart, as work changed meanwhile, runs again this many more times, each in a window of its own.
RETRY_SECONDS = 10
FORCE_WINDOW = datetime.timedelta(minutes=15)
REQUEST_WINDOW = datetime.timedelta(minutes=2)
APPLY_RETRIES = 2
# run_once's passes at most: one more for a request written meanwhile, and one after each newer release's request.
RUN_ONCE_PASSES = 4
# A refused apply's retry snapshots for at least this long, even once installHoldUntil has passed:
# with a 40-minute APPLY_TIMEOUT the refusal can come long after it. Its statuses begin with
# APPLY_RETRY_MESSAGE, which the service keeps its hold for (ServiceUpdateHold.ts).
APPLY_RETRY_WINDOW = datetime.timedelta(minutes=2)
APPLY_RETRY_MESSAGE = 'New work started before the restart; trying again'
RETRYABLE_REFUSALS = ('Guarded prestate changed', 'Native work changed before restart', 'Native work is not idle',
                      'Complete database prestate changed', 'Complete database changed before restart',
                      'Another installation operation is in progress for this home')  # e.g. a prune after install
# A process beneath the service before the restart: a request's retry waits for it (or a hold reaps it).
PROCESS_REFUSALS = ('Owned service has unexpected descendants', 'Owned service has unexpected or missing descendants',
                    'A new process started beneath the service while its browser stopped', 'Owned process identities changed during inventory')
# update.py's assert_backup_space; shown to the user as it is, not as "did not install".
DISK_REFUSAL = 'Not enough free disk space for the pre-update backup'
GH_TIMEOUT = 10
# launchd runs the agent as a Background process; on a loaded Mac its children ran about
# 25x slower, so `gh auth token` and the snapshot timed out. Children leave darwin background.
PRIO_DARWIN_PROCESS = 4
HTTP_TIMEOUT = 60
NOTES_LIMIT = 4000
SYSTEM_PYTHON = '/usr/bin/python3'
GH_PATHS = ('/opt/homebrew/bin/gh', '/usr/local/bin/gh')
LOOPBACK = ('127.0.0.1', 'localhost', '::1')
SIGN_IN = 'Sign in with `gh auth login` so Studio can read private releases.'
CANCELLED = 'Update cancelled'
STATUSES = ('disabled', 'up-to-date', 'available', 'downloading', 'downloaded', 'waiting-for-quiet',
            'installing', 'installed', 'manual-required', 'error')
LIMITS = {'list': 10 << 20, PLAN_ASSET: 256 << 10, SUMS_ASSET: 256 << 10, MANIFEST_ASSET: 4 << 20,
          'runtime': 1 << 30, 'helpers': 64 << 20, 'json': 4 << 20, 'receipt': 64 << 20}  # Receipts, snapshots: grow with threads
HELPER_MAX_FILES = 2000
HELPER_MAX_BYTES = 64 << 20
# Finder's view settings (release_check.FINDER_FILES, which is not shipped beside this agent): a
# regular file of this name in the helpers folder is not a change; a link of the name still is.
FINDER_FILES = frozenset({'.DS_Store'})
LOG_LIMIT = 1 << 20
# launchd's StandardOutPath and StandardErrorPath for the service grow forever otherwise
# (52 MB seen); past the limit the newest SERVICE_LOG_KEPT bytes move to <name>.1.
SERVICE_LOG_LIMIT, SERVICE_LOG_KEPT = runs.SERVICE_LOG_LIMIT, runs.SERVICE_LOG_KEPT
SERVICE_LOGS = ('stdout.log', 'stderr.log')
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
                  'repository': DEFAULT_REPOSITORY, 'installRequestedAt': None, 'checkRequestedAt': None,
                  'installMode': 'normal', 'installHoldUntil': None, 'installCancelledAt': None, 'installRequest': None,
                  'installRunId': None, 'pauseWorkAfterMinutes': 10, 'automaticPausePostponedUntil': None}
STATE_KEYS = ('schemaVersion', 'agentVersion', 'status', 'installedVersion', 'installedSourceCommit',
              'availableVersion', 'availableTag', 'availableNotes', 'availablePublishedAt',
              'downloadedVersion', 'checkedAt', 'quietSince', 'message', 'lastInstall',
              'handledInstallRequestAt', 'handledCheckRequestAt', 'answeredInstallRequestAt', 'updatedAt',
              'automaticRetry', 'runSupport',
              'automaticWaitSince', 'automaticPauseAt', 'automaticLastBusyAt',  # update_agent_pause: an automatic
              'automaticPausedAt')  # install's wait for work, and its last drain {version, at}.

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

def _refuse_if(condition, message):
    if condition:
        raise AgentError(message)

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
        _refuse_if(not stat.S_ISREG(os.fstat(handle.fileno()).st_mode), 'Expected a regular file')
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()

# ---------------------------------------------------------------- owned paths

def owned(path, home):
    """Lexically confine a path to home and reject any symlink ancestor (dangling included)."""
    try:
        return installation_descriptor.owned_path(path, home)
    except AssertionError as error:
        raise AgentError(str(error)) from None

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
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or info.st_uid != os.getuid():
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
        _refuse_if(not match, 'SHA256SUMS has a malformed line')
        name = match.group(2)
        if name.startswith('./'):
            name = name[2:]
        _refuse_if(name in sums, 'SHA256SUMS lists a file twice')
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
    raise ManualRequired('SpecWithCode %s needs a manual upgrade from this installation (%s).'
                         % (plan['version'], source_commit[:12]))

def select_release(releases, channel, installed):
    """Highest plain vX.Y.Z release above installed; drafts never.

    The version decides the track, not GitHub's prerelease flag: the 0.2.x
    alpha releases were published as prereleases, yet a plain vX.Y.Z is a
    stable release. From 1.0.0 plain versions are also published as Latest.
    """
    _refuse_if(not isinstance(releases, list), 'GitHub returned an unexpected releases response')
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
    _refuse_if(not isinstance(manifest, dict) or not isinstance(manifest.get('files'), list) or not manifest['files'],
               'Helper manifest is malformed')
    entries = {}
    for entry in manifest['files']:
        _refuse_if(not isinstance(entry, dict), 'Helper manifest is malformed')
        path = entry.get('path')
        parts = pathlib.PurePosixPath(path).parts if isinstance(path, str) else ()
        if (not parts or pathlib.PurePosixPath(path).is_absolute() or any(p in ('.', '..') for p in parts)
                or '/'.join(parts) != path):
            raise AgentError('Helper manifest has an unsafe path')
        _refuse_if(not isinstance(entry.get('sha256'), str) or not HEX64.fullmatch(entry['sha256']),
                   'Helper manifest has an invalid hash')
        size = entry.get('bytes')
        _refuse_if(size is not None and (type(size) is not int or size < 0), 'Helper manifest has an invalid size')
        mode = entry.get('mode')
        _refuse_if(mode is not None and type(mode) is not int, 'Helper manifest has an invalid mode')
        _refuse_if(path in entries, 'Helper manifest lists a file twice')
        entries[path] = entry
    archive = manifest.get('archive')
    _refuse_if(archive is not None and (not isinstance(archive, str) or posixpath.basename(archive) != helpers_asset),
               'Helper manifest names a different archive')
    _refuse_if(manifest.get('archiveSha256') is not None and manifest.get('archiveSha256') != helpers_sha,
               'Helper manifest describes a different archive')
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
        _refuse_if(len(members) > HELPER_MAX_FILES, 'Helper archive has too many entries')
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            _refuse_if(name.is_absolute() or '..' in name.parts or '\\' in member.name,
                       'Helper archive has an unsafe path')
            parts = [part for part in name.parts if part != '.']
            _refuse_if(not parts or parts[0] != root, 'Helper archive has an entry outside its root folder')
            if member.isdir():
                continue
            _refuse_if(not member.isfile(), 'Helper archive contains a link or special file')
            relative = '/'.join(parts[1:])
            _refuse_if(not relative, 'Helper archive has an unsafe path')
            _refuse_if(relative in files, 'Helper archive lists a file twice')
            _refuse_if(expected is not None and relative not in expected,
                       'Helper archive contains a file not in the manifest')
            total += member.size
            _refuse_if(total > HELPER_MAX_BYTES, 'Helper archive is too large')
            files[relative] = None
            selected.append((member, relative))
        _refuse_if(expected is not None and set(files) != set(expected), 'Helper archive is missing manifest files')
        _refuse_if(ENTRYPOINT not in files, 'Helper archive has no ' + ENTRYPOINT)
        for member, relative in selected:
            destination = stage.joinpath(*relative.split('/'))
            ensure_dir(destination.parent, home)
            entry = expected.get(relative) if expected is not None else None
            mode_bits = entry.get('mode') if entry and entry.get('mode') is not None else member.mode
            mode = 0o700 if mode_bits & 0o111 else 0o600
            source = tar.extractfile(member)
            _refuse_if(source is None, 'Helper archive member is unreadable')
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
                _refuse_if(value != entry['sha256'] or (entry.get('bytes') is not None and size != entry['bytes']),
                           'Helper file does not match the manifest: ' + relative)
            files[relative] = value
    return files

# ---------------------------------------------------------------- installation and config

def studio_home(home, identity):
    return studio_paths.identity_home(home, identity)

def load_installation(home, identity):
    try:
        installation_descriptor.InstallationDescriptor(identity, home=home, require_policy=False)
    except AssertionError as error:
        raise AgentError(str(error)) from None
    own = owned(studio_home(home, identity), home)
    receipt = read_json(own / 'installation.json', home, 1 << 20)
    _refuse_if(not isinstance(receipt, dict), 'Studio installation receipt is malformed')
    try:
        descriptor = installation_descriptor.InstallationDescriptor.from_receipt(identity, receipt, home=home)
    except AssertionError as error:
        raise AgentError(str(error)) from None
    service = receipt.get('service') if isinstance(receipt.get('service'), dict) else {}
    checks = [receipt.get('identity') == identity, receipt.get('studioHome') == str(own),
              service.get('label') == 'com.specweave.studio.' + identity,
              version_tuple(receipt.get('version')) is not None,
              isinstance(receipt.get('sourceCommit'), str) and HEX40.fullmatch(receipt['sourceCommit']) is not None]
    _refuse_if(not all(checks), 'Studio installation receipt does not describe this service')
    return {'identity': identity, 'studioHome': own, 'version': receipt['version'],
            'sourceCommit': receipt['sourceCommit'], 'label': service['label'], 'uid': descriptor.uid,
            'domain': descriptor.domain, 'port': descriptor.port, 'webSessionPolicy': descriptor.policy}

def load_config(updates, home):
    path = updates / 'config.json'
    config = dict(DEFAULT_CONFIG)
    if not os.path.lexists(str(path)):
        return config
    raw = read_json(path, home, 64 << 10)
    _refuse_if(not isinstance(raw, dict), 'Update settings are malformed')
    for key in DEFAULT_CONFIG:
        if key in raw:
            config[key] = raw[key]
    valid = (type(config['schemaVersion']) is int and config['schemaVersion'] == 1
             and all(type(config[key]) is bool for key in ('checkAutomatically', 'downloadInBackground',
                                                            'installAutomatically'))
             and config['channel'] in ('stable', 'preview')
             and type(config['pauseWorkAfterMinutes']) is int and 1 <= config['pauseWorkAfterMinutes'] <= 10080
             and type(config['quietMinutes']) is int and 0 <= config['quietMinutes'] <= 10080
             and isinstance(config['repository'], str) and REPOSITORY.fullmatch(config['repository']) is not None
             and '..' not in config['repository'] and config['installMode'] in ('normal', 'force')
             and all(config[key] is None or (isinstance(config[key], str) and 0 < len(config[key]) <= 100)
                     for key in ('installRequestedAt', 'checkRequestedAt', 'installHoldUntil', 'installCancelledAt',
                                 'automaticPausePostponedUntil'))
             and (config['installRunId'] is None or runs.valid_run_id(config['installRunId'])))
    _refuse_if(not valid, 'Update settings are invalid')
    return config

def blank_state():
    state = {key: None for key in STATE_KEYS}
    state.update({'schemaVersion': 1, 'agentVersion': AGENT_VERSION, 'status': 'up-to-date', 'runSupport': runs.RUN_SUPPORT})
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
        if key in ('lastInstall', 'automaticRetry', 'automaticPausedAt'):
            state[key] = value if isinstance(value, dict) else None
        elif key in ('schemaVersion', 'agentVersion', 'runSupport'):
            continue
        elif key == 'status':
            state[key] = value if value in STATUSES else 'up-to-date'
        else:
            state[key] = value if isinstance(value, str) else None
    return state

# ---------------------------------------------------------------- injectable process seams

def leave_background():
    """Run in a child before exec: drop the agent's darwin-background CPU and I/O throttling."""
    try:
        os.setpriority(PRIO_DARWIN_PROCESS, 0, 0)
    except (AttributeError, OSError):
        pass  # Not macOS, or already a normal process.

def leave_background_io():
    """leave_background, and the default disk I/O policy in place of the agent's LowPriorityIO: for
    the apply helper and a held snapshot, which a person waits for. Other snapshots stay throttled."""
    leave_background()
    runs.normal_disk_io()

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
                                    timeout=GH_TIMEOUT, env=environment, preexec_fn=leave_background)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0:
            value = result.stdout.decode('utf-8', 'replace').strip()
            if TOKEN_SHAPE.fullmatch(value):
                return value
    return None

def run_helper_process(command, cwd, env, timeout, pass_fds=(), wait_detached=False, log_path=None, home=None, normal_io=False):
    """Run a verified helper. Returns 'ok', 'failed' or 'timeout'.

    Output is discarded unless log_path is given; then stdout and stderr go to that new
    private file (never to agent.log) so a failed install can be diagnosed afterwards.
    Snapshot children are ours and read-only, so subprocess may stop them on timeout.
    Apply children (wait_detached) are never signalled: they run in their own session,
    keep the inherited pass lock until they exit and own any rollback themselves. `normal_io`
    children also leave the agent's disk throttle (leave_background_io).
    """
    sink, preexec = subprocess.DEVNULL, leave_background_io if normal_io else leave_background
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
                                    stdout=sink, stderr=sink, timeout=timeout, preexec_fn=preexec)
            return 'ok' if result.returncode == 0 else 'failed'
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=sink, stderr=sink,
                                   start_new_session=True, pass_fds=tuple(pass_fds),
                                   preexec_fn=preexec)
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

def install_cancelled(config):
    """True when the desktop cancelled the pending install request after making it."""
    cancelled, requested = parse_time(config['installCancelledAt']), parse_time(config['installRequestedAt'])
    return cancelled is not None and (requested is None or cancelled > requested)

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

def launchctl(args, output=None):
    """launchctl's exit status; its stdout and stderr are appended to `output` when given."""
    _refuse_if(sys.platform != 'darwin', 'LaunchAgents are only available on macOS')
    code, stdout, stderr = update_request.launchctl_run(args)
    (output if output is not None else []).extend((stdout, stderr))
    return code

def current_uid():
    return os.getuid()

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Redirects are followed manually so credentials stay on the API host.

def _loopback(parts):
    return (parts.hostname or '') in LOOPBACK

# ---------------------------------------------------------------- the pass

class Agent(object):
    def __init__(self, home, identity, test_mode, out, lock_fd=None):
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
        self.lock_fd = lock_fd  # Passed to the helper, which keeps the pass lock while it runs.
        self.run = None  # The run.json record this pass owns (update_agent_run.claim).
        self.serving = None  # The install request this pass serves, '' for none; None until run_pass names it.
        self.newer_release = None  # The newer release whose request ended this pass (update_agent_recovery.withdrawn).
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
        # Names the request this pass serves ('' for none): the service's hold for another request never takes
        # this as its answer. None, before a pass names one, still ends a hold by its time.
        self.state['answeredInstallRequestAt'] = self.serving
        self.save()
        if self.run is not None:
            self.run.mirror(status, self.state['message'])

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
                    _refuse_if(total > limit, 'A GitHub download exceeded its size limit')
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
        return cache.download(self, name, asset, destination, limit)

    # -- check

    def check_is_due(self):
        checked = parse_time(self.state.get('checkedAt'))
        now = utcnow()
        return checked is None or checked > now + datetime.timedelta(minutes=5) or now - checked >= CHECK_INTERVAL

    def release_dir(self, version):
        return self.updates / 'downloads' / version

    def check(self):
        return recovery.check(self)

    def discover_version(self):
        """Bounded information-only discovery: no plans, caches, downloads or preferences."""
        body = self.fetch_bytes('%s/repos/%s/releases?per_page=30' % (self.api_base(), self.config['repository']),
                                'application/vnd.github+json', LIMITS['list'])
        try:
            releases = json.loads(body.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise AgentError('Unreadable release list') from None
        _refuse_if(not isinstance(releases, list) or len(releases) > recovery.FEED_LIMIT,
                   'Unexpected bounded release list')
        versions = [tag_version(item.get('tag_name')) for item in releases
                    if isinstance(item, dict) and not item.get('draft')]
        versions = [version for version in versions if version is not None]
        _refuse_if(len(versions) != len(set(versions)), 'Ambiguous release versions')
        installed = version_tuple(self.inst['version'])
        newer = [version for version in versions if version_tuple(version) > installed]
        if newer:
            return 'available', max(newer, key=version_tuple)
        if len(releases) == recovery.FEED_LIMIT and self.inst['version'] not in versions:
            return 'manual-required', None
        return 'up-to-date', None

    def load_release(self, version):
        return recovery.load_release(self, version)

    # -- download and verify

    def load_verified(self, meta):
        directory = self.release_dir(meta['version'])
        path = directory / 'verified.json'
        if not meta.get('planSha256') or not path.is_file():
            return None
        try:
            verified = read_json(path, self.home)
            if not isinstance(verified, dict) or not recovery.verified_matches(self, meta, verified) \
                    or verified.get('version') != meta['version'] \
                    or verified.get('planSha256') != meta['planSha256'] \
                    or not isinstance(verified['helpers']['files'], dict) \
                    or not HEX64.fullmatch(verified['runtime']['sha256']) \
                    or not _safe_name(verified['runtime']['asset']) or not _safe_name(verified['helpers']['root']) \
                    or not all(arg in ALLOWED_ARGS for arg in verified['args']) \
                    or not (directory / verified['runtime']['asset']).is_file():
                return None
        except (AgentError, KeyError, TypeError):
            return None
        return verified

    def download_and_verify(self, meta):
        version, plan = meta['version'], meta['plan']
        runtime, helpers = plan['service']['runtime'], plan['service']['helpers']
        directory = ensure_dir(self.release_dir(version), self.home)
        names = [SUMS_ASSET, runtime['asset'], helpers['asset']] + [n for n in (MANIFEST_ASSET,) if n in meta['assets']]
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
            cache.forget(self, directory, names)
            raise
        verified = {'schemaVersion': 1, 'version': version, 'tag': meta['tag'], 'planSha256': meta['planSha256'],
                    'runtime': {'asset': runtime['asset'], 'sha256': runtime['sha256']},
                    'helpers': {'root': helpers['root'], 'sha256': helpers['sha256'], 'files': files},
                    'entrypoint': ENTRYPOINT, 'args': meta['args'], 'verifiedAt': iso(utcnow()),
                    'binding': meta['binding'], 'sourceCommit': plan['sourceCommit']}
        write_json(directory / 'verified.json', verified, self.home)
        remove_path(directory / 'rejected.json', self.home)
        return verified

    def extract_helpers(self, archive, version, root, expected):
        parent = ensure_dir(self.updates / 'helpers', self.home)
        final = parent / version
        stage = parent / ('.stage-%s-%s' % (version, uuid.uuid4().hex[:12]))
        ensure_dir(stage / root, self.home)
        try:
            files = safe_extract(archive, stage / root, root, expected, self.home)
            remove_path(final, self.home)
            os.rename(str(stage), str(final))
        except BaseException:
            if os.path.lexists(str(stage)):
                remove_path(stage, self.home)
            raise
        return files

    def verify_helpers(self, verified):
        root = owned(self.updates / 'helpers' / verified['version'] / verified['helpers']['root'], self.home)
        _refuse_if(not root.is_dir(), 'Verified helpers are missing; they will be downloaded again')
        actual = {}
        for directory, dirnames, filenames in os.walk(str(root)):
            for name in dirnames + filenames:
                path = pathlib.Path(directory) / name
                _refuse_if(path.is_symlink(), 'Verified helpers changed on disk')
            for name in filenames:
                path = pathlib.Path(directory) / name
                if not (name in FINDER_FILES and path.is_file()):
                    actual[path.relative_to(root).as_posix()] = sha256_file(path)
        _refuse_if(actual != verified['helpers']['files'], 'Verified helpers changed on disk')
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
            return {'reason': 'SpecWithCode %s failed verification' % version}
        return value if isinstance(value, dict) else {'reason': 'SpecWithCode %s failed verification' % version}

    # -- helper execution

    def helper_python(self):
        override = os.environ.get('STUDIO_UPDATE_HELPER_PYTHON')
        if self.test_mode and override and os.path.isabs(override) and os.path.isfile(override):
            return override
        return SYSTEM_PYTHON

    def helper_env(self):
        return {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8', 'STUDIO_UPDATE_APPLY_BUDGET': str(APPLY_TIMEOUT)}

    def helper_command(self, helper_dir, args):
        return [self.helper_python(), '-B', '-E', '-s', str(helper_dir / 'update.py')] + [str(arg) for arg in args]

    def read_snapshot(self, path):
        try:
            value = read_json(path, self.home, LIMITS['receipt'])
        except AgentError:
            return None
        rows = value.get('rows') if isinstance(value, dict) else None
        if not (isinstance(rows, dict) and isinstance(rows.get('counts'), dict) and rows.get('nativeWorkIdle') is True
                and type(value.get('servicePid')) is int and parse_time(value.get('observedAt'))):
            return None
        return value

    # -- install

    def take_snapshot(self, helper_dir, snapshots, request=None):
        """One snapshot by the verified helper: (path, snapshot, None), or (None, None, (status, message))."""
        newest = snapshots / ('snapshot-%s-%s.json' % (stamp(), uuid.uuid4().hex[:8]))
        output = newest.with_suffix('.log')
        args = ['--identity', self.identity, '--snapshot', newest]
        if request is not None:
            args += ['--request', request]
        outcome = run_helper_process(self.helper_command(helper_dir, args),
                                     str(helper_dir), self.helper_env(), SNAPSHOT_TIMEOUT,
                                     log_path=output, home=self.home, normal_io=request is not None)
        snapshot = self.read_snapshot(newest) if outcome == 'ok' else None
        refusal = read_tail(output, self.home) if snapshot is None and os.path.lexists(str(output)) else ''
        if os.path.lexists(str(output)):
            remove_path(output, self.home)
        if snapshot is not None:
            return newest, snapshot, None
        if os.path.lexists(str(newest)):
            remove_path(newest, self.home)
        return None, None, refusal_reason(refusal, outcome)

    def retry_deadline(self, started, applied=False):
        """Until when a pending request snapshots again in this pass (runs.retry_until); `applied`: a refused apply's."""
        hold = parse_time(self.config['installHoldUntil']) if self.config['installMode'] == 'force' else None
        own = min(hold, started + FORCE_WINDOW) if hold else started + REQUEST_WINDOW
        return runs.retry_until(self, max(own, started + APPLY_RETRY_WINDOW) if applied else own)

    def quiet_then_install(self, verified, install_request):
        version = verified['version']
        runs.lap(self, 'beforeInstall', install_request)
        helper_dir = self.verify_helpers(verified)
        runs.lap(self, 'verifyHelpers')
        snapshots = ensure_dir(self.updates / 'snapshots', self.home)
        baseline_path = snapshots / 'baseline.json'
        started = window = utcnow()  # The pass (a reap's budget) and the current retry window.
        attempt, retries, refused_apply = 0, 0, None
        serving = self.config['installRequestedAt']
        reaper.reset(self, self.config['installRequestedAt'])  # A second pass in run_once starts afresh.
        while True:
            if self.config['installRequestedAt'] != serving:  # A newer request this pass took on starts afresh.
                attempt, retries, refused_apply, window = 0, 0, None, utcnow()
                serving = self.config['installRequestedAt']
            if install_request:
                self.serving = serving
            attempt += 1
            if not install_request and recovery.automatic_superseded(self):  # Ends as after the snapshot, without its full read.
                self.state['automaticRetry'] = None
                return self.finish('downloaded', recovery.SETTINGS_CHANGED)
            request = self.config['installRequestedAt'] if install_request and self.config['installMode'] == 'force' else None
            newest, snapshot, refused = self.take_snapshot(helper_dir, snapshots, request)
            runs.lap(self, 'snapshot')
            if snapshot is None:
                if os.path.lexists(str(baseline_path)):
                    remove_path(baseline_path, self.home)
                self.state['quietSince'] = None
                retry_by = self.retry_deadline(window, refused_apply is not None) if install_request else started
                if refused[0] != 'waiting-for-quiet':
                    self.state['automaticRetry'] = None
                if refused[0] != 'waiting-for-quiet' or utcnow() + datetime.timedelta(seconds=RETRY_SECONDS) >= retry_by:
                    if refused_apply is not None:  # A retry that never applied ends as the apply it retried,
                        if (ended := recovery.withdrawn(self, version)):  # unless cancelled or replaced meanwhile.
                            return self.finish(*ended)
                        if self.config['installRequestedAt'] != serving:
                            continue  # A newer request this pass took on: its own attempts and window.
                        return self.settle(verified, refused_apply, 'failed', install_request,  # The user's cause as it is.
                                           shown=None if refused[0] == 'waiting-for-quiet' else refused)
                    if install_request:  # An explicit request never drains: no pause time or Later stays on show.
                        if refused[0] != 'waiting-for-quiet' and recovery.asked_again(self, version, serving):
                            continue  # Asked again as the snapshot refused: served, not answered with that refusal.
                        # A run's or another release's request written meanwhile is not served here: the
                        # refusal names the request it ends, so the service's hold for that one ignores it.
                        return pause.forget(self.state) or self.finish(*refused)
                    return pause.after_refusal(self, verified, refused)
                # A refused apply's retry leads with its message, by which the service's hold outlasts installHoldUntil.
                self.set_status(refused[0], ('%s. ' % APPLY_RETRY_MESSAGE if refused_apply is not None else '')
                                + '%s (attempt %d)' % (refused[1], attempt))
                if (ended := recovery.withdrawn(self, version)):  # Written while the snapshot ran: no reap.
                    return self.finish(*ended)
                time.sleep(reaper.before_retry(self, helper_dir, refused, started, window))
                runs.lap(self, 'retryWait')
                if (ended := recovery.withdrawn(self, version)):
                    return self.finish(*ended)
                continue
            ended = recovery.withdrawn(self, version) if install_request else recovery.automatic_withdrawn(self, verified)
            if ended:
                remove_path(newest, self.home)
                return self.finish(*ended)
            if install_request:  # Retries count per request: one taken on since `serving` has its own.
                refused_apply = self.apply(verified, helper_dir, newest, baseline_path, install_request, retries < APPLY_RETRIES, serving)
                if not isinstance(refused_apply, pathlib.Path):
                    return refused_apply
                # The refused apply is the request's it ran for: its first, if taken on as the snapshot or apply ran.
                retries = retries + 1 if self.config['installRequestedAt'] == serving else 1
                attempt, window, serving = 0, utcnow(), self.config['installRequestedAt']
                self.set_status('waiting-for-quiet', APPLY_RETRY_MESSAGE)
                continue
            break
        pause.forget(self.state)  # Idle: nothing to pause any more.
        return recovery.install_when_quiet(self, verified, helper_dir, newest, snapshot, baseline_path, install_request)

    def apply(self, verified, helper_dir, prestate, baseline_path, install_request, may_retry=False, serving=None):
        """Run the verified helper once. Its receipt's path means it refused before the restart and put every pointer
        back, so the caller may apply again: when may_retry, or for a request taken on since `serving` (its first apply)."""
        version = verified['version']
        runtime = owned(self.release_dir(version) / verified['runtime']['asset'], self.home)
        if sha256_file(runtime) != verified['runtime']['sha256']:
            cache.forget(self, self.release_dir(version), ('verified.json', verified['runtime']['asset']))
            raise AgentError('Downloaded runtime changed on disk; it will be downloaded again')
        receipts = ensure_dir(self.updates / 'receipts', self.home)
        moment = stamp()
        receipt = receipts / ('update-%s-%s.json' % (version, moment))
        kept = receipts / ('prestate-%s-%s.json' % (version, moment))
        os.replace(str(prestate), str(kept))
        if os.path.lexists(str(baseline_path)):
            remove_path(baseline_path, self.home)
        self.state['quietSince'] = pause.forget(self.state)  # Nothing waits once an install starts.
        before = recovery.installation_fingerprint(self) if not install_request else None
        if install_request: self.state['automaticRetry'] = None  # Explicit requests start fresh.
        handled = self.state['handledInstallRequestAt']
        if install_request:  # The request it settles, which a failure from here on names.
            self.state['handledInstallRequestAt'] = self.config['installRequestedAt']
            self.serving = self.config['installRequestedAt']
        write_json(self.marker_path, {'version': version, 'receipt': str(receipt), 'at': iso(utcnow()),
                                      'sourceCommit': verified['sourceCommit'],
                                      'previousSourceCommit': verified['binding']['installedSourceCommit']}, self.home)
        self.set_status('installing', 'Installing SpecWithCode %s' % version)
        ended = recovery.withdrawn(self, version) if install_request else recovery.automatic_withdrawn(self, verified)
        if ended:  # A settings change that raced the status write above.
            return remove_path(self.marker_path, self.home) or self.finish(*ended)
        may_retry = may_retry or serving not in (None, self.config['installRequestedAt'])
        if not recovery.current_installation_matches(self, verified):
            remove_path(self.marker_path, self.home)
            self.state['checkedAt'] = None
            return self.finish('error', 'The installation changed during preparation; a new update check is required.')
        args = ['--identity', self.identity, '--prestate', kept, '--archive', runtime,
                '--sha256', verified['runtime']['sha256'], '--output', receipt] + list(verified['args'])
        pass_fds = (self.lock_fd,) if self.lock_fd is not None else ()
        outcome = run_helper_process(self.helper_command(helper_dir, args), str(helper_dir), runs.apply_env(self),
                                     APPLY_TIMEOUT, pass_fds=pass_fds, wait_detached=True,
                                     log_path=helper_log_path(receipt), normal_io=True)
        runs.lap(self, 'apply')
        if may_retry and outcome == 'failed' and recovery.refused_before_restart(self, receipt, version):
            self.state['handledInstallRequestAt'] = handled  # Still pending until an attempt completes.
            return remove_path(self.marker_path, self.home) or receipt
        return self.settle(verified, receipt, outcome, install_request, before)

    def settle(self, verified, receipt, outcome, install_request, before=None, shown=None):
        """Record an apply's outcome and end the pass; also a refused one whose retry never applied,
        then with `shown`, the retry snapshot's own refusal, when that is one the user can act on."""
        if install_request:  # The request it settles, which a failure from here on names.
            self.state['handledInstallRequestAt'] = self.config['installRequestedAt']
            self.serving = self.config['installRequestedAt']
        status, message = self.complete_install(verified['version'], receipt, outcome, verified['sourceCommit'],
                                                verified['binding']['installedSourceCommit'])
        if not install_request and outcome == 'failed':
            recovery.record_refusal(self, verified, receipt, before)
        elif outcome != 'ok':
            self.state['automaticRetry'] = None
        if install_request and outcome == 'failed' and recovery.refused_before_restart(self, receipt, verified['version']):
            self.state['lastInstall']['refusedBeforeRestart'] = True  # Nothing changed: see recovery.holds.
        return self.finish(*(shown or (status, message)))

    def complete_install(self, version, receipt, outcome, expected_source=None, previous_source=None):
        try:
            inst = load_installation(self.home, self.identity)
        except AgentError:
            inst = None
        if inst is not None:
            self.inst = inst
            self.state['installedVersion'] = inst['version']
            self.state['installedSourceCommit'] = inst['sourceCommit']
        if outcome != 'timeout' and os.path.lexists(str(self.marker_path)):
            remove_path(self.marker_path, self.home)  # A timed-out helper runs on; a later pass settles it.
        now = iso(utcnow())
        if outcome == 'ok' and inst is not None and inst['version'] == version \
                and (expected_source is None or inst['sourceCommit'] == expected_source) \
                and recovery.completion_proof(self, receipt, expected_source, previous_source):
            self.state['lastInstall'] = {'version': version, 'at': now, 'result': 'updated', 'receipt': str(receipt)}
            self.clear_available()
            self.state['checkedAt'] = None  # Discover the next verified hop on a later pass.
            self.state['automaticRetry'] = None
            self.cleanup_versions(version_tuple(inst['version']))
            return 'installed', 'SpecWithCode %s is installed' % version
        self.state['lastInstall'] = {'version': version, 'at': now, 'result': 'failed', 'receipt': str(receipt),
                                    'sourceCommit': expected_source, 'previousSourceCommit': previous_source}
        current = inst['version'] if inst is not None else 'its previous version'
        if outcome == 'failed':
            recovery.ensure_failure_receipt(self, version, receipt, current)
        if outcome == 'timeout':
            return 'error', ('Installing SpecWithCode %s is taking longer than %d minutes; it was left to finish. '
                             'See the update receipt.' % (version, max(1, int(APPLY_TIMEOUT // 60))))
        if outcome == 'interrupted':
            return 'error', 'The install of SpecWithCode %s was interrupted; SpecWithCode is on %s.' % (version, current)
        disk = recovery.disk_refusal(self, receipt) if outcome == 'failed' else None
        if disk:  # One cause the user can act on, not "see the receipt".
            return 'error', '%s; SpecWithCode stayed on %s.' % (disk, current)
        if inst is not None and inst['version'] == version and self.kept_after_restart(receipt):
            # Retained pointers and a past observation do not prove liveness after a failed rollback.
            return 'error', ('SpecWithCode %s was kept after a restart check failed. The update was not '
                             'confirmed. See the update receipt.' % version)
        return 'error', 'SpecWithCode %s did not install; SpecWithCode stayed on %s. See the update receipt.' % (version, current)

    def kept_after_restart(self, receipt):
        """True only when the helper restarted into the new release, observed it and kept it (any `held-*`
        rollback: kept for review, or a rollback whose checks or restores failed). Not current liveness."""
        try:
            value = read_json(owned(pathlib.Path(receipt), self.home), self.home, LIMITS['receipt']) if receipt else None
        except (AgentError, OSError):
            return False
        return isinstance(value, dict) and value.get('pointers') == 'new-release' \
            and str(value.get('rollback') or '').startswith('held-') and bool(value.get('attemptedAfter'))

    def failed_switch_stands(self, last):
        """A recorded failure clears only when its helper receipt verifies completion."""
        if last.get('result') != 'failed':
            return False
        return not recovery.completion_proof(self, last.get('receipt'), last.get('sourceCommit'),
                                              last.get('previousSourceCommit'))

    def cleanup_versions(self, installed):
        for parent in (self.updates / 'downloads', self.updates / 'helpers'):
            if not parent.is_dir() or parent.is_symlink():
                continue
            for child in parent.iterdir():
                ranked = version_tuple(child.name)
                if (ranked is not None and ranked <= installed) or child.name.startswith('.stage-'):
                    remove_path(child, self.home)

    def rotate_log(self):
        for name in SERVICE_LOGS:
            rotate_service_log(self.own / name)
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
        if state.get('installedSourceCommit') not in (None, self.inst['sourceCommit']):
            state['checkedAt'] = None
            state['automaticRetry'] = None
        state['installedVersion'] = self.inst['version']
        state['installedSourceCommit'] = self.inst['sourceCommit']
        installed = version_tuple(self.inst['version'])
        if config['installRequestedAt'] in (None, state.get('handledInstallRequestAt')):
            self.serving = ''  # No request pending: an interrupted install settled here answers none.
        if state['status'] == 'installing' or os.path.lexists(str(self.marker_path)):
            settled = recovery.settle_interrupted(self)
            if settled is not None:
                return self.finish(*settled)
        # Manual or failed installs leave downloads and helpers only an agent install cleaned; drop any <= this version.
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
        self.serving = config['installRequestedAt']  # An expired request's failure names it too.
        install_request = update_request.pending(config, state, installed, utcnow(), install_cancelled, AgentError,
                                                 ttl_until=runs.ttl_until(self))
        self.serving = config['installRequestedAt'] if install_request else ''  # An automatic pass serves none.
        check_request = config['checkRequestedAt'] is not None and \
            config['checkRequestedAt'] != state.get('handledCheckRequestAt')
        if not config['checkAutomatically'] and not install_request and not check_request:
            return pause.forget(state) or self.finish('disabled', 'Automatic update checks are off')
        meta = self.load_release(state['availableVersion']) if state.get('availableVersion') else None
        # A request for a release newer than the cached one (the desktop saw it first) needs a fresh check.
        wanted = (update_request.bound(config) or {}).get('version') if install_request else None
        newer = meta is not None and wanted is not None and \
            (version_tuple(wanted) or ()) > (version_tuple(meta['version']) or ())
        due = (check_request or newer or (config['checkAutomatically'] and self.check_is_due())
               or (install_request and meta is None) or (state.get('availableVersion') and meta is None))
        fresh = False
        if due:
            if check_request:
                state['handledCheckRequestAt'] = config['checkRequestedAt']
            try:
                meta = self.check()
                fresh = True
            except AgentError as error:
                state['checkedAt'] = None  # Failed discovery must not authorize cached fallback next pass.
                state['automaticRetry'] = None
                return self.finish(error.status, error.message)
        last = state.get('lastInstall') or {}  # The version can switch before the helper's checks fail.
        if meta is None:
            if install_request:
                state['handledInstallRequestAt'] = config['installRequestedAt']
            if last.get('version') == self.inst['version'] and self.failed_switch_stands(last):
                return self.finish('error', 'Updating to SpecWithCode %s failed. See the update receipt.' % last['version'])
            return pause.forget(state) or self.finish('up-to-date', None)
        refused = install_request and update_request.refuse(config, state, meta['version'])  # Bound to another version.
        if meta.get('manual') or meta.get('rejected') or not meta.get('plan') or refused:
            if install_request:
                state['handledInstallRequestAt'] = config['installRequestedAt']
            if meta.get('manual'):
                return self.finish('manual-required', meta['manual'])
            return self.finish('error', refused or meta.get('rejected') or 'The release update plan is unusable')
        version = meta['version']
        verified = self.load_verified(meta)
        if verified is None:
            state['downloadedVersion'] = pause.forget(state)  # A new download waits for work afresh.
            if not (config['downloadInBackground'] or install_request):
                return self.finish('available', None)
            rejected = self.load_rejected(version)
            if rejected and not fresh:
                if install_request:
                    state['handledInstallRequestAt'] = config['installRequestedAt']
                return self.finish('error', rejected.get('reason') or 'SpecWithCode %s failed verification' % version)
            self.set_status('downloading', 'Downloading SpecWithCode %s' % version)
            try:
                verified = self.download_and_verify(meta)
            except AgentError as error:
                self.reject(version, error.message)
                state['automaticRetry'] = None
                if install_request:
                    state['handledInstallRequestAt'] = config['installRequestedAt']
                return self.finish('error', error.message)
            state['downloadedVersion'] = version
            self.set_status('downloaded', None)
        state['downloadedVersion'] = version
        if not (config['installAutomatically'] or install_request):
            return pause.forget(state) or self.finish('downloaded', None)
        if not install_request and recovery.holds(self, last):
            held = recovery.automatic_retry(self, verified)
            if held:
                return self.finish('error', held)
        return self.quiet_then_install(verified, install_request)

rotate_service_log = runs.rotate_service_log

# ---------------------------------------------------------------- entry points

def acquire_lock(path, home):
    return runs.acquire_lock(owned(path, home))

def run_once(home, identity, test_mode, out):
    load_installation(home, identity)  # Refuse before creating locks, logs or update state.
    own = owned(studio_home(home, identity), home)
    if not own.is_dir():
        raise AgentError('SpecWithCode %s is not installed' % identity)
    updates = ensure_dir(own / 'updates', home)
    os.chmod(str(updates), 0o700)
    lock_fd = acquire_lock(updates / 'agent.lock', home)
    if lock_fd is None:
        return 0  # Another pass (or a still-running helper) holds the lock.
    try:
        agent = Agent(home, identity, test_mode, out, lock_fd)
        agent.rotate_log()
        for passes in range(1, RUN_ONCE_PASSES + 1):
            agent.state, agent.serving, agent.newer_release = load_state(agent.state_path, home), None, None
            try:
                agent.config = load_config(updates, home)
                agent.inst = load_installation(home, identity)
                agent.run, agent.timings = runs.claim(agent), runs.Timings()  # A pass's own clock.
                agent.pass_started = utcnow()  # update_agent_pause: a grace counts from the start of its pass.
                code = agent.run_pass()
            except AgentError as error:
                agent.state['automaticRetry'] = None
                code = agent.finish(error.status, error.message)
            except Exception as error:  # Never let a traceback (with possible values) reach the log.
                agent.state['automaticRetry'] = None
                code = agent.finish('error', 'Unexpected updater failure (%s)' % type(error).__name__)
            runs.release(agent)
            # Once more for a request written while the first pass held the lock, and after a newer release's request.
            if not ((passes == 1 or agent.newer_release) and passes < RUN_ONCE_PASSES
                    and update_request.arrived(agent, lambda: load_config(updates, home))):
                return code
    finally:
        os.close(lock_fd)

def show_status(home, identity, out):
    own = owned(studio_home(home, identity), home)
    path = own / 'updates' / 'state.json'
    if path.is_file():
        state = load_state(path, home)  # Keeps the saved updatedAt.
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

agent_label = update_request.agent_label

def install_launch_agent(home, identity, out):
    inst = load_installation(home, identity)
    keep = update_request.keeps_installed_agent(here := pathlib.Path(os.path.abspath(__file__)).parent, studio_paths.updater_root(home))
    cached = not keep and cache.install_beside(sys.modules[__name__], home)  # Before the agent that imports it.
    updates = ensure_dir(inst['studioHome'] / 'updates', home)
    label = agent_label(identity)
    lock_fd = acquire_lock(updates / 'agent.lock', home)
    try:
        target_dir = ensure_dir(studio_paths.updater_root(home), home)
        os.chmod(str(target_dir), 0o700)
        files = [(owned(target_dir / os.path.basename(name), home), pathlib.Path(os.path.abspath(name)).read_bytes())
                 for name in (studio_paths.__file__, update_request.__file__, recovery.__file__, installation_descriptor.__file__,
                              runs.__file__, pause.service_hold.__file__, here / 'live_database.py', here / 'service_handles.py',
                              pause.__file__, here / 'managed_updates.py',
                              here / 'migrate_home.py', __file__)]  # Modules first.

        def same(path, data):
            return path.is_file() and not path.is_symlink() and read_owned(path, home, 8 << 20) == data

        # Atomic writes are safe while a pass runs: launchd runs the new copy next time; no reload.
        written = not keep and reaper.install_beside(files[-1][0], home, same, atomic_write) or cached
        for path, data in files:
            if not keep and not same(path, data):
                atomic_write(path, data, home, 0o700)
                written = True
        if not keep: update_request.record_agent(here, target_dir)  # noqa: E701  Its release, for the next installer.
        if lock_fd is None:
            # A pass (or the install helper it started) runs: a bootout would stop it mid-snapshot
            # or mid-install. Its files are in place; the next request reloads the job if needed.
            out(json.dumps({'result': 'busy', 'written': written, 'label': label}))
            return 0
        plist_path = owned(home / 'Library' / 'LaunchAgents' / (label + '.plist'), home)
        ensure_dir(plist_path.parent, home)
        log = str(updates / 'agent.log')
        content = plistlib.dumps({'Label': label,
                                  'ProgramArguments': [SYSTEM_PYTHON, str(files[-1][0]), '--identity', identity],
                                  'StartInterval': 600, 'RunAtLoad': True, 'ProcessType': 'Standard',
                                  'LowPriorityIO': True, 'StandardOutPath': log, 'StandardErrorPath': log,
                                  'WorkingDirectory': str(updates)})
        domain, result = 'gui/%d' % current_uid(), 'installed' if written else 'unchanged'
        if not same(plist_path, content) or launchctl(['print', domain + '/' + label]) != 0:
            atomic_write(plist_path, content, home, 0o644)
            listing = []  # A disabled label never bootstraps: booting it out would only lose the job.
            if launchctl(['print-disabled', domain], listing) == 0 and \
                    update_request.label_disabled(''.join(listing[:1]), label):
                out(json.dumps({'result': 'disabled', 'label': label, 'message': update_request.DISABLED}))
                return update_request.DISABLED_EXIT  # Only Repair, on a person's click, turns it back on.
            launchctl(['bootout', domain + '/' + label])  # Not loaded yet is fine.
            errors = []
            code = launchctl(['bootstrap', domain, str(plist_path)], errors)
            if code != 0:
                raise AgentError('launchctl could not load the update agent: ' +
                                 update_request.launchctl_reason(code, *errors[1:2]))
            result = 'installed'
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
    out(json.dumps({'result': result, 'label': label}))
    return 0

def uninstall_launch_agent(home, identity, out):
    try:
        domain, label, plist_path = installation_descriptor.updater_removal(home, identity)
    except AssertionError as error:
        raise AgentError(str(error)) from None
    launchctl(['bootout', domain + '/' + label])
    existed = os.path.lexists(str(plist_path))
    if existed:
        remove_path(plist_path, home)
    out(json.dumps({'result': 'uninstalled' if existed else 'absent', 'label': label}))
    return 0

def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='SpecWithCode background update agent')
    parser.add_argument('--identity', required=True)
    parser.add_argument('--home', help=argparse.SUPPRESS)  # Tests only: a temporary private home.
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--install-launch-agent', action='store_true')
    mode.add_argument('--uninstall-launch-agent', action='store_true')
    mode.add_argument('--repair-launch-agent', action='store_true')  # Settings' Repair, on a click only.
    mode.add_argument('--status', action='store_true')
    args = parser.parse_args(argv)
    home = pathlib.Path(args.home) if args.home else pathlib.Path.home()
    passing = not (args.install_launch_agent or args.uninstall_launch_agent or args.repair_launch_agent or args.status)
    timed = runs.stamp if passing else (lambda line: line)  # Install mode's JSON reply is parsed: never stamped.

    def out(line):
        print(timed(redact(line)))
        sys.stdout.flush()

    try:
        installation_descriptor.validate_identity(args.identity)
        if args.install_launch_agent:
            return install_launch_agent(home, args.identity, out)
        if args.repair_launch_agent:
            return update_request.repair_launch_agent(args.identity, current_uid(), launchctl, lambda: install_launch_agent(
                home, args.identity, out), AgentError, out)
        if args.uninstall_launch_agent:
            return uninstall_launch_agent(home, args.identity, out)
        if args.status:
            return show_status(home, args.identity, out)
        return run_once(home, args.identity, bool(args.home), out)
    except AgentError as error:
        print(timed('update-agent %s: error: %s' % (args.identity, redact(error.message))), file=sys.stderr)
        return 1
    except Exception as error:
        print(timed('update-agent %s: error: unexpected failure (%s)' % (args.identity, type(error).__name__)),
              file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
