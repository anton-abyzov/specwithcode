"""Which install request the update agent may still act on.

The desktop writes `installRequestedAt` (read by every agent) and, beside it, `installRequest`
`{at, version}`: the version the app showed when the user asked. A request with that record is
bound to its version and lapses after REQUEST_TTL, so a click for 1.0.7 never installs 1.0.8
and a request nobody followed never installs at some later idle moment. A request without the
record (an older desktop) keeps the earlier behaviour. Shipped beside update_agent.py, which
imports it; stdlib only and Python 3.9 compatible like the agent.

Run as a script it writes such a request the way the desktop does, for a release that installs
a published version on a service with no desktop in front of it, and reports what the agent last
wrote. It touches only the identity's updates/config.json, never the service or its database:

    python3 -B update_request.py request --identity m4 --version 1.0.37 [--force --hold-minutes 15] [--kickstart]
    python3 -B update_request.py check --identity m4 [--kickstart]
    python3 -B update_request.py cancel --identity m4 --request 2026-10-20T12:00:00.000Z
    python3 -B update_request.py status --identity m4

check asks only for a check, as the desktop's Check now does (checkRequestedAt), so nothing is
asked to install. cancel withdraws one install request, named by its installRequestedAt, the way
the agent reads a cancel (installCancelledAt after the request), and only while it is still the
pending request: one written since is left alone and the command exits non-zero.

request and check first install the update agent that ships with the release the Mac runs, unless
its agent belongs to that release or a newer one (refresh_agent), so the request is handled with
that release's fixes. A pass of the old agent still running gets up to a minute to end first: it
would take on a request written meanwhile, and the kickstart starts no new pass while it runs. A
forced request never waits: it follows a drain whose hold lets go when no request arrives within
a minute. update.py does the same with the new release after every verified install.

With --kickstart a request or check is written only while the agent's launchd job is loaded and
enabled, and a kickstart launchd refuses exits non-zero with launchctl's reason (the error names
the request written, so the caller can cancel it): a request nothing starts would lapse unseen.
status adds whether the job is loaded (agentLoaded), turned off with `launchctl disable`
(agentDisabled), and whether its last check is overdue (stale).

It also holds the agent's launchd helpers (update_agent.py is at its file-size cap): the one
launchctl transport, the disabled-label check install_launch_agent runs before any bootout,
and the Repair that Settings runs only when a person asks for it.

scripts/studio-fleet/fleet_rollout.py streams this file to each fleet host and runs it there.
"""
import argparse
import datetime
import errno
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time

REQUEST_TTL = datetime.timedelta(minutes=10)
# update_agent.CHECK_INTERVAL: a scheduled agent checks this often. A last check older than
# twice this means the agent is not running its passes.
CHECK_INTERVAL = datetime.timedelta(minutes=60)
# A request dated this far ahead of the agent's clock was not written by this computer's app.
CLOCK_SKEW = datetime.timedelta(minutes=5)
EXPIRED = 'The update request expired before it could start; choose Update now again.'
_SEMVER = re.compile(r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})')


def _time(value):
    if not isinstance(value, str) or not 0 < len(value) <= 64:
        return None
    text = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        moment = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _version(value):
    match = _SEMVER.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def bound(config):
    """The `installRequest` record of the pending request: a dict, None when the request has
    none (an older desktop wrote it), or False when the record is malformed."""
    record = config.get('installRequest')
    if record is None:
        return None
    if not (isinstance(record, dict) and set(record) == {'at', 'version'}
            and _time(record['at']) is not None and _version(record['version']) is not None):
        return False
    return record if record['at'] == config.get('installRequestedAt') else None


def _verdict(config, state, installed, now, cancelled, ttl_until=None):
    """(pending, message) for the settings' install request; `installed` is the installed version
    as a tuple, or None. A request that is not pending is settled (copied into
    handledInstallRequestAt); message says why when the user should know. `ttl_until`, the
    deadline of the update run that owns the request, replaces REQUEST_TTL for it."""
    requested = config.get('installRequestedAt')
    if requested is None or requested == state.get('handledInstallRequestAt'):
        return False, None
    record = bound(config)
    settled, expired = cancelled(config) or record is False, False
    if record:
        at, wanted = _time(record['at']), _version(record['version'])
        settled = settled or at > now + CLOCK_SKEW
        settled = settled or (installed is not None and wanted <= installed)
        expired = not settled and (now > ttl_until if ttl_until is not None else now - at > REQUEST_TTL)
    if settled or expired:
        state['handledInstallRequestAt'] = requested
    return not (settled or expired), EXPIRED if expired else None


def pending(config, state, installed, now, cancelled, failure, ttl_until=None):
    """True while the settings hold an install request this pass should act on. A request that
    was cancelled, has a malformed record or asks for a version already installed is settled
    here and never acted on later. One that lapsed is settled too, and raises failure(EXPIRED)
    so the pass ends saying why instead of with an unrelated status."""
    waiting, message = _verdict(config, state, installed, now, cancelled, ttl_until)
    if message:
        raise failure(message)
    return waiting


def refuse(config, state, version):
    """The message for a pending request bound to a version other than `version`, the release
    this pass would install; the request is then settled. None when the request may install it."""
    record = bound(config)
    if not record or record['version'] == version:
        return None
    state['handledInstallRequestAt'] = config['installRequestedAt']
    return ('SpecWithCode %s was asked for, but %s is the update now available; '
            'choose Update now again to install it.' % (record['version'], version))


def replaced(before, config, state, version, now):
    """None while the pending request is still `before` (the one this pass started with) or is a
    newer one that may install `version`. Otherwise that newer request is settled and this is
    the (status, message) that ends the pass, so it never installs a version it did not ask for."""
    if config.get('installRequestedAt') == before:
        return None
    waiting, message = _verdict(config, state, None, now, lambda _config: False)
    refusal = refuse(config, state, version) if waiting else None
    if message or refusal:
        return 'error', message or refusal
    return None if waiting else ('downloaded', None)


def arrived(agent, load):
    """True when a request written while the agent's pass held the lock is still pending. The
    kick that came with it found the lock taken, so nothing else would serve it before it
    lapses. `load` re-reads the settings; nothing runs again while an install marker is left."""
    try:
        requested = load().get('installRequestedAt')
    except Exception:  # Settings that do not load are reported by the next scheduled pass.
        return False
    seen = (None, agent.config.get('installRequestedAt'), agent.state.get('handledInstallRequestAt'))
    return requested not in seen and not os.path.lexists(str(agent.marker_path))


# ---------------------------------------------------------------- command line

# The settings an agent assumes when config.json is missing (update_agent.DEFAULT_CONFIG without
# `repository`, which stays absent unless the desktop or a person chose one).
DEFAULT_SETTINGS = {'schemaVersion': 1, 'checkAutomatically': True, 'downloadInBackground': True,
                    'installAutomatically': True, 'channel': 'stable', 'quietMinutes': 10,
                    'installRequestedAt': None, 'checkRequestedAt': None, 'installMode': 'normal',
                    'installHoldUntil': None, 'installCancelledAt': None, 'installRequest': None, 'installRunId': None,
                    'pauseWorkAfterMinutes': 10, 'automaticPausePostponedUntil': None}
# update_agent.FORCE_WINDOW: one pass retries a forced request for at most this long.
HOLD_MAX_MINUTES = 15
_IDENTITY = re.compile(r'[a-z][a-z0-9_-]{0,31}')
_JSON_LIMIT = 1 << 20
# An update receipt holds both guarded snapshots, which grow with the service's threads (1.2 MB
# on M4 with 887 threads in 1.0.65); the agent reads receipts up to the same size.
_RECEIPT_LIMIT = 64 << 20
LAUNCHCTL = '/bin/launchctl'


class RequestError(Exception):
    pass


def _iso(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (moment.microsecond // 1000)


def _read_json(path, limit=_JSON_LIMIT):
    """The JSON object in `path`, {} when it is missing. Refuses links and other non-files."""
    try:
        info = os.lstat(str(path))
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise RequestError('%s is not a regular file of at most %d MiB' % (path, limit >> 20))
    with open(str(path), 'rb') as handle:
        try:
            value = json.loads(handle.read().decode('utf-8'))
        except ValueError:
            raise RequestError('%s is not JSON' % path) from None
    if not isinstance(value, dict):
        raise RequestError('%s is not a JSON object' % path)
    return value


def _identity_home(home, identity):
    if not _IDENTITY.fullmatch(identity or ''):
        raise RequestError('Invalid identity %r' % identity)
    import studio_paths  # Shipped beside this file; fleet_rollout.py streams both.
    return studio_paths.identity_home(home, identity)


def installed(home, identity):
    """The current descriptor's version, which may change before guarded verification ends."""
    own = _identity_home(home, identity)
    version = _read_json(own / 'installation.json').get('version')
    if _version(version) is None:
        version = _read_json(own / 'updates' / 'state.json').get('installedVersion')
    return version if _version(version) is not None else None


def finalized(own, identity, installation, state):
    """A descriptor switch alone is provisional. Require the agent's successful completion
    and its source-bound guarded receipt, after both install markers have gone away."""
    updates = own / 'updates'
    last = state.get('lastInstall')
    if (not isinstance(last, dict) or last.get('result') != 'updated'
            or _time(last.get('at')) is None or _version(installation.get('version')) is None
            or last.get('version') != installation.get('version')
            or state.get('installedVersion') != installation.get('version')
            or state.get('installedSourceCommit') != installation.get('sourceCommit')
            or installation.get('identity') != identity
            or any(os.path.lexists(str(updates / name))
                   for name in ('install-in-progress.json', 'install-gate.json'))):
        return False
    try:
        path = pathlib.Path(last['receipt'])
        if path.parent != updates / 'receipts' or path.parent.is_symlink():
            return False
        proof = _read_json(path, _RECEIPT_LIMIT)
        before, after = proof.get('before'), proof.get('after')
        source, archive = installation.get('sourceCommit'), installation.get('archiveSha256')
        service = installation.get('service')
        label = service.get('label') if isinstance(service, dict) else None
        return (isinstance(source, str) and re.fullmatch('[0-9a-f]{40}', source) is not None
                and isinstance(archive, str) and re.fullmatch('[0-9a-f]{64}', archive) is not None
                and isinstance(label, str) and bool(label)
                and proof.get('phase') == 'verified' and proof.get('result') in (None, 'updated')
                and all(proof.get(flag) is True for flag in ('preservedRowsAuthAndIdentity',
                        'originalServicesPreserved', 'onlyKnownOwnedServiceRestarted'))
                and isinstance(before, dict) and isinstance(after, dict)
                and all(part.get('schemaVersion') == 1 and part.get('identity') == identity
                        and part.get('serviceLabel') == label for part in (before, after))
                and isinstance(before.get('artifactSourceCommit'), str)
                and re.fullmatch('[0-9a-f]{40}', before['artifactSourceCommit']) is not None
                and after.get('artifactSourceCommit') == source and after.get('archiveSha256') == archive
                # Refuse a mixed read if an agent started/finished another pass during this check.
                and installation == _read_json(own / 'installation.json')
                and state == _read_json(updates / 'state.json')
                and not any(os.path.lexists(str(updates / name))
                            for name in ('install-in-progress.json', 'install-gate.json')))
    except (KeyError, TypeError, ValueError, OSError, RequestError):
        return False


def status(home, identity, run=None, launchd=True):
    own = _identity_home(home, identity)
    state = _read_json(own / 'updates' / 'state.json')
    config = _read_json(own / 'updates' / 'config.json')
    receipt = _read_json(own / 'installation.json')
    report = {'identity': identity, 'installationVersion': receipt.get('version'),
              'installedVersion': state.get('installedVersion'), 'version': installed(home, identity)}
    for key in ('status', 'message', 'downloadedVersion', 'availableVersion', 'updatedAt',
                'handledInstallRequestAt', 'lastInstall'):
        report[key] = state.get(key)
    for key in ('installRequestedAt', 'installMode', 'installHoldUntil', 'installCancelledAt', 'installRequest',
                'installRunId'):
        report[key] = config.get(key)
    report['installFinalized'] = finalized(own, identity, receipt, state)
    report.update(agent_status(identity, state, config, run, launchd=launchd, home=home))
    return report


def _updates(home, identity):
    updates = _identity_home(home, identity) / 'updates'
    if updates.is_symlink() or not updates.is_dir():
        raise RequestError('%s has no update agent folder at %s' % (identity, updates))
    return updates


def _write_config(updates, config):
    """Replaces updates/config.json with `config`, atomically and mode 600."""
    _write_json(updates / 'config.json', config)


def _write_json(path, value):
    """Replaces `path` with `value` as JSON, atomically and mode 600."""
    descriptor, temporary = tempfile.mkstemp(prefix='.%s.' % path.name, dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write((json.dumps(value, indent=2) + '\n').encode('utf-8'))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, str(path))
    except BaseException:
        if os.path.lexists(temporary):
            os.unlink(temporary)
        raise


def write_request(home, identity, version, force=False, hold_minutes=HOLD_MAX_MINUTES, now=None):
    """Writes an install request bound to `version` into config.json, atomically and mode 600.
    A forced request makes the agent retry its snapshot every few seconds until installHoldUntil
    instead of waiting for a quiet period; it never stops running work. Other settings stay."""
    if _version(version) is None:
        raise RequestError('Invalid version %r' % version)
    if force and not (isinstance(hold_minutes, int) and 1 <= hold_minutes <= HOLD_MAX_MINUTES):
        raise RequestError('--hold-minutes must be 1 to %d' % HOLD_MAX_MINUTES)
    updates = _updates(home, identity)
    config = dict(DEFAULT_SETTINGS)
    config.update(_read_json(updates / 'config.json'))
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stamp = _iso(now)
    config.update({'checkRequestedAt': stamp, 'installRequestedAt': stamp,
                   'installMode': 'force' if force else 'normal',
                   'installHoldUntil': _iso(now + datetime.timedelta(minutes=hold_minutes)) if force else None,
                   'installRequest': {'at': stamp, 'version': version}, 'installRunId': None})
    _write_config(updates, config)
    return {key: config[key] for key in ('installRequestedAt', 'installMode', 'installHoldUntil', 'installRequest')}


def write_check(home, identity, now=None):
    """Asks the agent to look for a release now, as the desktop's Check now does: only
    checkRequestedAt changes, so nothing is asked to install. Other settings stay."""
    updates = _updates(home, identity)
    config = dict(DEFAULT_SETTINGS)
    config.update(_read_json(updates / 'config.json'))
    config['checkRequestedAt'] = _iso(now or datetime.datetime.now(datetime.timezone.utc))
    _write_config(updates, config)
    return {'checkRequestedAt': config['checkRequestedAt']}


def cancel_request(home, identity, request, now=None):
    """Cancels the install request dated `request` (its installRequestedAt) by writing
    installCancelledAt, which the agent, update.py --reap and the desktop read as a cancel when it
    is later than the request. Refuses, changing nothing, once another request replaced it or it
    was cleared. Other settings stay."""
    updates = _updates(home, identity)
    config = _read_json(updates / 'config.json')
    current = config.get('installRequestedAt')
    if current != request:
        raise RequestError('The pending install request on %s is not %s (%s); nothing was cancelled' % (
            identity, request, 'it is %s' % current if current else 'there is none'))
    stamp = _iso(now or datetime.datetime.now(datetime.timezone.utc))
    asked = _time(request)
    if asked is not None and _time(stamp) <= asked:  # Only a later cancel counts, even if the clock stepped back.
        stamp = _iso((asked + datetime.timedelta(milliseconds=1)).astimezone(datetime.timezone.utc))
    config['installCancelledAt'] = stamp
    _write_config(updates, config)
    return {'installRequestedAt': request, 'installCancelledAt': stamp}


# ---------------------------------------------------------------- the update agent's own copy

# The files install_launch_agent copies into <install>/updater, beside the agent
# (scripts/lib/studio-service-updater.ts MAC_SERVICE_UPDATER_FILES).
AGENT_FILES = ('update_agent.py', 'update_agent_reap.py', 'update_agent_cache.py', 'update_request.py',
               'update_agent_recovery.py', 'installation_descriptor.py', 'managed_updates.py', 'studio_paths.py',
               'migrate_home.py', 'update_agent_run.py', 'update_agent_pause.py', 'service_hold.py',
               'service_handles.py', 'live_database.py')
# Beside every copy of those files: the release they belong to, {schemaVersion, version}, written by
# the runtime and desktop builds since 1.0.67. The installed copy's record also lists each file it
# installed with its sha256.
AGENT_RECORD = 'agent-release.json'
SYSTEM_PYTHON = '/usr/bin/python3'
_AGENT_FILE_LIMIT = 8 << 20
_AGENT_INSTALL_TIMEOUT = 60  # As the desktop's ensureAgent.
_AGENT_RESULTS = ('installed', 'unchanged', 'busy')  # install_launch_agent's results with exit status 0.
# How long a request or check waits for a pass of the agent it replaced to end, counted from the
# refresh's start. With ready_to_kick's two launchctl reads and the kickstart after it, a call stays
# within fleet_rollout.REQUEST_TIMEOUT.
AGENT_PASS_WAIT = 60


def _sha256(path):
    """The sha256 of a regular file of at most 8 MiB; None for anything else."""
    try:
        info = os.lstat(str(path))
        if not stat.S_ISREG(info.st_mode) or info.st_size > _AGENT_FILE_LIMIT:
            return None
        with open(str(path), 'rb') as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


def agent_release(directory, installed=False):
    """The release the update agent in `directory` belongs to, from its agent-release.json; None
    when it has none or it cannot be read. For the installed agent (`installed`) every file its
    record lists, the agent among them, must still have the sha256 recorded: an installer that writes
    no record, such as an older desktop app, may have put another copy there since, and then its
    release is unknown. The list is the installing release's own, so a newer one may name more files."""
    directory = pathlib.Path(directory)
    try:
        record = _read_json(directory / AGENT_RECORD)
    except (RequestError, OSError):
        return None
    version = record.get('version') if record.get('schemaVersion') == 1 else None
    if _version(version) is None:
        return None
    if installed:
        files = record.get('files')
        if not isinstance(files, dict) or 'update_agent.py' not in files:
            return None
        for name, recorded in files.items():
            if not isinstance(name, str) or pathlib.PurePath(name).name != name or name.startswith('.') or \
                    _sha256(directory / name) != recorded:
                return None
    return version


def keeps_installed_agent(source, target):
    """True when the agent installed in `target` belongs to a newer release than the copy in
    `source`: installing that copy would put an older agent back."""
    mine, installed = _version(agent_release(source)), _version(agent_release(target, installed=True))
    return mine is not None and installed is not None and mine < installed


def record_agent(source, target):
    """Records the release of the agent just copied from `source` into `target`, with each installed
    file's sha256, for the next installer. A copy that belongs to no release (from a checkout)
    removes the record instead, so any release replaces that agent. A failure here leaves the agent
    unrecorded, which the next refresh repairs; it never fails the install."""
    path = pathlib.Path(target) / AGENT_RECORD
    try:
        version = agent_release(source)
        files = {name: _sha256(pathlib.Path(target) / name) for name in AGENT_FILES}
        # Only the files this copy holds: an installer running at the same time may have put some of
        # its own there, and a record would vouch for that mix.
        if version is not None and None not in files.values() and \
                all(_sha256(pathlib.Path(source) / name) == files[name] for name in AGENT_FILES):
            record = {'schemaVersion': 1, 'version': version, 'files': files}
            _write_json(path, record)
            return record
        if os.path.lexists(str(path)):
            os.unlink(str(path))
    except OSError:
        pass
    return None


def refresh_agent(home, identity, release, run=None, wait=0):
    """Installs the update agent that ships with `release`, one of this Mac's installed releases,
    the way the desktop installs its own copy (update_agent.py --install-launch-agent), unless the
    Mac's agent belongs to that release or a newer one. Before, only the desktop app installed the
    agent, so a Mac whose desktop app was old or never opened (M1's ran 1.0.48) kept an agent from
    10-16 and none of the fixes since. Never sets up an agent for an identity that has none (the
    agent's files are shared by every identity of the OS user, its launchd job is not), and never
    runs the installer of a release that records no agent (1.0.66 and older): it would put its agent
    over a newer one. While a pass runs, the installer writes the new files and the pass goes on with
    the old agent, which takes on a request written meanwhile; with `wait` (a request's or check's,
    so its kickstart starts the new agent) it gets that many seconds to end first. Returns one word:
    absent (nothing to refresh), current,
    installed, unchanged, busy (the old agent's pass still runs), disabled or failed. Never raises:
    an update or a request goes on either way."""
    started = time.monotonic()
    try:
        import studio_paths  # Shipped beside this file; fleet_rollout.py streams both.
        home = pathlib.Path(home)
        updater, releases = studio_paths.updater_root(home), studio_paths.releases_root(home)
        release = pathlib.Path(release)
        shipped = release / 'studio-updater'
        plist = home / 'Library' / 'LaunchAgents' / (agent_label(identity) + '.plist')
        if os.path.realpath(str(release.parent)) != os.path.realpath(str(releases)) or release.is_symlink() or not (
                plist.is_file() and (updater / 'update_agent.py').is_file() and (shipped / 'update_agent.py').is_file()):
            return 'absent'  # Only this Mac's own installed releases, and only over this identity's agent.
        wanted, installed = _version(agent_release(shipped)), _version(agent_release(updater, installed=True))
        if wanted is None:
            return 'absent'
        if installed is not None and installed >= wanted:
            return 'current'
        command = [SYSTEM_PYTHON, '-B', str(shipped / 'update_agent.py'), '--identity', identity, '--install-launch-agent']
        if home.resolve() != pathlib.Path.home().resolve():
            command += ['--home', str(home)]  # Tests only: a temporary private home.
        result = (run or subprocess.run)(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, timeout=_AGENT_INSTALL_TIMEOUT)
        if result.returncode == DISABLED_EXIT:
            return 'disabled'
        lines = [line for line in result.stdout.decode('utf-8', 'replace').splitlines() if line.strip()]
        reply = json.loads(lines[-1]) if lines else None
        if result.returncode != 0 or not isinstance(reply, dict) or reply.get('result') not in _AGENT_RESULTS:
            return 'failed'
        if reply['result'] != 'busy':
            return reply['result']
        if reply.get('written') is not True:
            return 'unchanged'  # The pass running now runs the same agent.
        return 'installed' if wait and wait_for_pass(home, identity, started + wait) else 'busy'
    except Exception:  # noqa: BLE001 - the next update or request refreshes again.
        return 'failed'


def refresh_installed_agent(home, identity, run=None, wait=0):
    """refresh_agent with the release this Mac's service runs, as its installation.json names it."""
    try:
        installation = _read_json(_identity_home(home, identity) / 'installation.json')
    except (RequestError, OSError):
        return 'failed'
    release = installation.get('release')
    if not isinstance(release, str) or not os.path.isabs(release):
        return 'absent'
    return refresh_agent(home, identity, release, run, wait)


def pass_running(home, identity):
    """True while a pass of the update agent, or the install helper it started, holds the agent's
    lock. Never creates the lock file and holds the lock only for the test: a pass that starts in
    that instant ends at once, and the request's or check's kickstart (or the next scheduled pass)
    starts another."""
    import fcntl  # Not on Windows, where no agent runs.
    try:
        descriptor = os.open(str(_identity_home(home, identity) / 'updates' / 'agent.lock'), os.O_RDWR | os.O_NOFOLLOW)
    except OSError:
        return False  # No pass has run, or the lock is one no agent would take.
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        return error.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES)
    finally:
        os.close(descriptor)
    return False


def wait_for_pass(home, identity, until, clock=time.monotonic, sleep=time.sleep):
    """Waits until no pass holds the agent's lock or `clock` reaches `until`; True when none does."""
    while pass_running(home, identity):
        if clock() >= until:
            return False
        sleep(1)
    return True


# ---------------------------------------------------------------- launchd

# install_launch_agent's exit status when launchd has the label turned off: nothing was booted
# out or loaded, and only Repair (a person's click) turns it back on.
DISABLED_EXIT = 3
DISABLED = 'Update agent is turned off in launchd'
NOT_LOADED = 'Update agent is not loaded in launchd'
_LAUNCHCTL_TEXT = 400


def agent_label(identity):
    return 'com.specweave.studio.%s.updater' % identity


def launchctl_run(args, timeout=30):
    """(exit status, stdout, stderr) of one launchctl call; status 1 and the error's name when
    launchctl cannot run at all. The only place the fleet scripts here start launchctl."""
    try:
        result = subprocess.run([LAUNCHCTL] + list(args), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        return 1, '', type(error).__name__
    return (result.returncode, result.stdout.decode('utf-8', 'replace'),
            result.stderr.decode('utf-8', 'replace'))


def launchctl_reason(code, *texts):
    """One line for an error message: launchctl's own words, else its exit status."""
    text = ' '.join(' '.join(part.split()) for part in texts if part and part.strip())
    return (text[:_LAUNCHCTL_TEXT] + ' (exit %d)' % code) if text else 'exit %d' % code


def label_disabled(listing, label):
    """True when `launchctl print-disabled <domain>` lists `label` as disabled (`=> true` before
    macOS 13)."""
    pattern = r'^\s*"%s"\s*=>\s*(?:disabled|true)\s*$' % re.escape(label)
    return re.search(pattern, listing or '', re.M) is not None


def agent_health(domain, label, run=None):
    """{'agentLoaded', 'agentDisabled'} as launchd sees the agent's job now. Read-only: `print`
    and `print-disabled` change nothing. agentDisabled is None when launchd did not answer."""
    run = run or launchctl_run
    code, listing, _ = run(['print-disabled', domain])
    disabled = label_disabled(listing, label) if code == 0 else None
    return {'agentLoaded': run(['print', domain + '/' + label])[0] == 0, 'agentDisabled': disabled}


def stale(checked_at, check_automatically, now=None):
    """True when the agent should have checked by now and has not: automatic checks are on
    and its last check is older than twice CHECK_INTERVAL. A job that never checked is
    reported through agentLoaded and agentDisabled instead."""
    at = _time(checked_at)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return bool(check_automatically) and at is not None and now - at > 2 * CHECK_INTERVAL


def agent_status(identity, state, config, run=None, uid=None, now=None, launchd=True, home=None):
    """agentLoaded, agentDisabled and stale for status(); both launchd fields are None off macOS,
    when `launchd` is false (a temporary test home has no launchd job of its own) and when
    `home` has no LaunchAgents plist for the agent (it was never installed or the owner removed
    it), so Settings never offers to repair an agent nobody set up."""
    plist = None if home is None else (
        pathlib.Path(home) / 'Library' / 'LaunchAgents' / (agent_label(identity) + '.plist'))
    if sys.platform != 'darwin' or not launchd or (plist is not None and not plist.exists()):
        health = {'agentLoaded': None, 'agentDisabled': None}
    else:
        health = agent_health('gui/%d' % (os.getuid() if uid is None else uid), agent_label(identity), run)
    health['stale'] = stale(state.get('checkedAt'), config.get('checkAutomatically', True), now)
    return health


def repair_launch_agent(identity, uid, launchctl, install, failure, out):
    """Settings' Repair, run only when a person clicks it: turn the agent's label back on
    (`launchctl enable`), load its job through `install` (install_launch_agent, which
    bootstraps a job that is not loaded) and start one pass. Never run on its own: the owner
    may have turned the agent off on purpose. `launchctl(args, output)` returns the exit
    status and appends stdout and stderr to `output`."""
    target = 'gui/%d/%s' % (uid, agent_label(identity))

    def call(args, what):
        output = []
        code = launchctl(args, output)
        if code != 0:
            raise failure('launchctl could not %s: %s' % (what, launchctl_reason(code, *output[1:2])))

    call(['enable', target], 'turn the update agent back on')
    code = install()
    if code != 0:
        return code
    call(['kickstart', target], 'start the update agent')
    out(json.dumps({'result': 'repaired', 'label': agent_label(identity)}))
    return 0


def kickstart(identity, run=None):
    """Starts the agent's launchd job now instead of at its next 10-minute run. (True, None),
    or (False, launchctl's reason)."""
    code, _, error = (run or launchctl_run)(['kickstart', 'gui/%d/%s' % (os.getuid(), agent_label(identity))],
                                            timeout=15)
    return (True, None) if code == 0 else (False, launchctl_reason(code, error))


def ready_to_kick(identity, run=None):
    """None when the agent's job can be kicked, else why not, before any request is written."""
    if sys.platform != 'darwin':
        return 'LaunchAgents are only available on macOS'
    health = agent_health('gui/%d' % os.getuid(), agent_label(identity), run)
    if health['agentDisabled']:
        return '%s (launchctl disable); nothing would handle the request' % DISABLED
    if not health['agentLoaded']:
        return '%s; nothing would handle the request' % NOT_LOADED
    return None


def _kick(identity, what):
    """kickstart() for the command line: True, or RequestError naming what was written."""
    kicked, reason = kickstart(identity)
    if not kicked:
        raise RequestError('The %s was written but launchctl could not start the update agent: %s' % (what, reason))
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(prog='update_request.py', description='Write or read a SpecWithCode service install request')
    commands = parser.add_subparsers(dest='command')
    for name in ('request', 'check', 'cancel', 'status'):
        command = commands.add_parser(name)
        command.add_argument('--identity', required=True)
        command.add_argument('--home', help=argparse.SUPPRESS)  # Tests only: a temporary private home.
        if name == 'request':
            command.add_argument('--version', required=True)
            command.add_argument('--force', action='store_true',
                                 help='retry the snapshot until the hold ends instead of waiting for quiet')
            command.add_argument('--hold-minutes', type=int, default=HOLD_MAX_MINUTES)
        if name in ('request', 'check'):
            command.add_argument('--kickstart', action='store_true', help='start the agent now')
        if name == 'cancel':
            command.add_argument('--request', required=True, help='installRequestedAt of the request to cancel')
    args = parser.parse_args(argv)
    if args.command is None:
        parser.error('choose request, check, cancel or status')
    home = pathlib.Path(args.home) if args.home else pathlib.Path.home()
    written = {}  # A request written before a kickstart failed, named in the error.

    def refresh(waits):
        # Never an older agent over a newer one. A test home loads no launchd job, as in status.
        return 'absent' if args.home else refresh_installed_agent(home, args.identity,
                                                                  wait=AGENT_PASS_WAIT if waits else 0)
    try:
        if args.command == 'status':
            # launchd jobs belong to the user, not to a --home: a test home reads no live job.
            report = status(home, args.identity, launchd=not args.home)
        elif args.command == 'cancel':
            report = {'identity': args.identity, 'result': 'cancelled',
                      'request': cancel_request(home, args.identity, args.request)}
        elif args.command == 'check':
            agent = refresh(True)
            refused = ready_to_kick(args.identity) if args.kickstart else None
            if refused:
                raise RequestError(refused)
            written['request'] = write_check(home, args.identity)
            report = {'identity': args.identity, 'result': 'check-requested', 'request': written['request'],
                      'kicked': None, 'agent': agent}
            if args.kickstart:
                report['kicked'] = _kick(args.identity, 'check request')
        else:
            current, wanted = installed(home, args.identity), _version(args.version)
            if current is not None and wanted is not None and _version(current) > wanted:
                raise RequestError('%s already runs %s, newer than %s' % (args.identity, current, args.version))
            # Only a request it writes waits for a pass, and never a forced one: it follows a drain
            # whose hold lets go when no request arrives within a minute (ServiceUpdateHold.ts).
            agent = refresh(current != args.version and not args.force)
            if current == args.version:
                report = {'identity': args.identity, 'result': 'already-installed', 'version': current, 'agent': agent}
            else:
                refused = ready_to_kick(args.identity) if args.kickstart else None
                if refused:
                    raise RequestError(refused)
                written['request'] = write_request(home, args.identity, args.version, args.force, args.hold_minutes)
                report = {'identity': args.identity, 'result': 'requested', 'request': written['request'],
                          'kicked': None, 'agent': agent}
                if args.kickstart:
                    report['kicked'] = _kick(args.identity, 'request')
    except (RequestError, OSError) as error:
        message = str(error) if isinstance(error, RequestError) else '%s (%s)' % (type(error).__name__, error.strerror)
        print(json.dumps(dict({'identity': args.identity, 'error': message}, **written)))
        return 1
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
