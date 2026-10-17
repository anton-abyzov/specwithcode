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
    python3 -B update_request.py status --identity m4

scripts/studio-fleet/fleet_rollout.py streams this file to each fleet host and runs it there.
"""
import argparse
import datetime
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile

REQUEST_TTL = datetime.timedelta(minutes=10)
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


def _verdict(config, state, installed, now, cancelled):
    """(pending, message) for the settings' install request; `installed` is the installed version
    as a tuple, or None. A request that is not pending is settled (copied into
    handledInstallRequestAt); message says why when the user should know."""
    requested = config.get('installRequestedAt')
    if requested is None or requested == state.get('handledInstallRequestAt'):
        return False, None
    record = bound(config)
    settled, expired = cancelled(config) or record is False, False
    if record:
        at, wanted = _time(record['at']), _version(record['version'])
        settled = settled or at > now + CLOCK_SKEW
        settled = settled or (installed is not None and wanted <= installed)
        expired = not settled and now - at > REQUEST_TTL
    if settled or expired:
        state['handledInstallRequestAt'] = requested
    return not (settled or expired), EXPIRED if expired else None


def pending(config, state, installed, now, cancelled, failure):
    """True while the settings hold an install request this pass should act on. A request that
    was cancelled, has a malformed record or asks for a version already installed is settled
    here and never acted on later. One that lapsed is settled too, and raises failure(EXPIRED)
    so the pass ends saying why instead of with an unrelated status."""
    waiting, message = _verdict(config, state, installed, now, cancelled)
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
                    'installHoldUntil': None, 'installCancelledAt': None, 'installRequest': None}
# update_agent.FORCE_WINDOW: one pass retries a forced request for at most this long.
HOLD_MAX_MINUTES = 15
_IDENTITY = re.compile(r'[a-z][a-z0-9_-]{0,31}')
_JSON_LIMIT = 1 << 20
LAUNCHCTL = '/bin/launchctl'


class RequestError(Exception):
    pass


def _iso(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (moment.microsecond // 1000)


def _read_json(path):
    """The JSON object in `path`, {} when it is missing. Refuses links and other non-files."""
    try:
        info = os.lstat(str(path))
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(info.st_mode) or info.st_size > _JSON_LIMIT:
        raise RequestError('%s is not a regular file of at most 1 MiB' % path)
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
        proof = _read_json(path)
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


def status(home, identity):
    own = _identity_home(home, identity)
    state = _read_json(own / 'updates' / 'state.json')
    config = _read_json(own / 'updates' / 'config.json')
    receipt = _read_json(own / 'installation.json')
    report = {'identity': identity, 'installationVersion': receipt.get('version'),
              'installedVersion': state.get('installedVersion'), 'version': installed(home, identity)}
    for key in ('status', 'message', 'downloadedVersion', 'availableVersion', 'updatedAt',
                'handledInstallRequestAt', 'lastInstall'):
        report[key] = state.get(key)
    for key in ('installRequestedAt', 'installMode', 'installHoldUntil', 'installCancelledAt', 'installRequest'):
        report[key] = config.get(key)
    report['installFinalized'] = finalized(own, identity, receipt, state)
    return report


def write_request(home, identity, version, force=False, hold_minutes=HOLD_MAX_MINUTES, now=None):
    """Writes an install request bound to `version` into config.json, atomically and mode 600.
    A forced request makes the agent retry its snapshot every few seconds until installHoldUntil
    instead of waiting for a quiet period; it never stops running work. Other settings stay."""
    if _version(version) is None:
        raise RequestError('Invalid version %r' % version)
    if force and not (isinstance(hold_minutes, int) and 1 <= hold_minutes <= HOLD_MAX_MINUTES):
        raise RequestError('--hold-minutes must be 1 to %d' % HOLD_MAX_MINUTES)
    updates = _identity_home(home, identity) / 'updates'
    if updates.is_symlink() or not updates.is_dir():
        raise RequestError('%s has no update agent folder at %s' % (identity, updates))
    path = updates / 'config.json'
    config = dict(DEFAULT_SETTINGS)
    config.update(_read_json(path))
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stamp = _iso(now)
    config.update({'checkRequestedAt': stamp, 'installRequestedAt': stamp,
                   'installMode': 'force' if force else 'normal',
                   'installHoldUntil': _iso(now + datetime.timedelta(minutes=hold_minutes)) if force else None,
                   'installRequest': {'at': stamp, 'version': version}})
    descriptor, temporary = tempfile.mkstemp(prefix='.config.json.', dir=str(updates))
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write((json.dumps(config, indent=2) + '\n').encode('utf-8'))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, str(path))
    except BaseException:
        if os.path.lexists(temporary):
            os.unlink(temporary)
        raise
    return {key: config[key] for key in ('installRequestedAt', 'installMode', 'installHoldUntil', 'installRequest')}


def kickstart(identity):
    """Starts the agent's launchd job now instead of at its next 10-minute run."""
    label = 'gui/%d/com.specweave.studio.%s.updater' % (os.getuid(), identity)
    try:
        result = subprocess.run([LAUNCHCTL, 'kickstart', label], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog='update_request.py', description='Write or read a SpecWithCode service install request')
    commands = parser.add_subparsers(dest='command')
    for name in ('request', 'status'):
        command = commands.add_parser(name)
        command.add_argument('--identity', required=True)
        command.add_argument('--home', help=argparse.SUPPRESS)  # Tests only: a temporary private home.
        if name == 'request':
            command.add_argument('--version', required=True)
            command.add_argument('--force', action='store_true',
                                 help='retry the snapshot until the hold ends instead of waiting for quiet')
            command.add_argument('--hold-minutes', type=int, default=HOLD_MAX_MINUTES)
            command.add_argument('--kickstart', action='store_true', help='start the agent now')
    args = parser.parse_args(argv)
    if args.command is None:
        parser.error('choose request or status')
    home = pathlib.Path(args.home) if args.home else pathlib.Path.home()
    try:
        if args.command == 'status':
            report = status(home, args.identity)
        else:
            current, wanted = installed(home, args.identity), _version(args.version)
            if current is not None and wanted is not None and _version(current) > wanted:
                raise RequestError('%s already runs %s, newer than %s' % (args.identity, current, args.version))
            if current == args.version:
                report = {'identity': args.identity, 'result': 'already-installed', 'version': current}
            else:
                report = {'identity': args.identity, 'result': 'requested',
                          'request': write_request(home, args.identity, args.version, args.force, args.hold_minutes)}
                report['kicked'] = kickstart(args.identity) if args.kickstart else None
    except (RequestError, OSError) as error:
        message = str(error) if isinstance(error, RequestError) else '%s (%s)' % (type(error).__name__, error.strerror)
        print(json.dumps({'identity': args.identity, 'error': message}))
        return 1
    print(json.dumps(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
