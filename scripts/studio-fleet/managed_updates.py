#!/usr/bin/env python3
"""Destination-owned update consent. No credentials, preference writes or installer dispatch.

The server supplies its actual state directory and authenticated session identity.
Native-only actions are called by the trusted desktop after its confirmation dialog;
they grant consent to that existing session, never new authentication scopes.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for managed update safety checks')

import argparse
import contextlib
import datetime
import fcntl
import json
import os
import pathlib
import sqlite3
import stat
import sys
import urllib.parse

sys.dont_write_bytecode = True
import installation_descriptor as installation
import studio_paths
import update_agent as agent

MAX_INPUT = 16384
MAX_DOCUMENT = 65536
ACTIONS = ('status', 'enroll', 'revoke', 'check', 'enroll-local', 'revoke-local')
ERRORS = ('unauthorized', 'unsupported', 'unmanaged', 'binding-changed', 'conflict',
          'approval-required', 'revoked', 'busy', 'unavailable')


class ManagedError(Exception):
    def __init__(self, code):
        assert code in ERRORS
        self.code = code
        super().__init__(code)  # Never include paths, request bytes or auth database values.


def require(value, code='binding-changed'):
    if not value:
        raise ManagedError(code)


def text(value):
    return (isinstance(value, str) and 0 < len(value) <= 512 and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def revision(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def read(path, home, limit=MAX_DOCUMENT, *, private=False):
    installation.owned_path(path, home)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_size <= limit)
        if private:
            require(stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
        content = handle.read(limit + 1)
        require(len(content) <= limit)
        return content


def document(path, home, *, private=False):
    return json.loads(read(path, home, private=private))


def timestamp(value):
    require(isinstance(value, str), 'unauthorized')
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(parsed.tzinfo is not None, 'unauthorized')
        return parsed
    except ValueError:
        raise ManagedError('unauthorized') from None


def fresh_grant(state, home, controller, scopes):
    """Read only the persisted grant, never tokens, cookie keys or client labels."""
    require(isinstance(controller, dict) and set(controller) == {'sessionId', 'subject'}
            and all(text(controller[key]) for key in controller), 'unauthorized')
    database = installation.owned_path(state / 'statev2.sqlite', home)
    for suffix in ('', '-wal', '-shm'):
        path = installation.owned_path(pathlib.Path(str(database) + suffix), home)
        if path.exists():
            require(path.is_file())
    require(database.is_file(), 'unavailable')
    # live_database.readonly_uri, inlined so the installed updater needs no new module: with
    # readonly_shm a reader can never truncate the -shm the running service has mapped.
    shm = pathlib.Path(str(database) + '-shm')
    uri = ('file:' + urllib.parse.quote(str(database), safe='/') + '?mode=ro'
           + ('&readonly_shm=1' if shm.exists() else ''))
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=1)) as connection:
        connection.execute('PRAGMA query_only=ON')
        row = connection.execute('SELECT subject, scopes, issued_at, expires_at, revoked_at '
                                 'FROM auth_sessions WHERE session_id = ?',
                                 (controller['sessionId'],)).fetchone()
    require(row is not None and row[0] == controller['subject'] and row[4] is None, 'unauthorized')
    current = now()
    require(timestamp(row[2]) <= current < timestamp(row[3]), 'unauthorized')
    try:
        granted = json.loads(row[1])
    except (TypeError, ValueError):
        raise ManagedError('unauthorized') from None
    require(isinstance(granted, list) and all(isinstance(scope, str) for scope in granted)
            and all(scope in granted for scope in scopes), 'unauthorized')


class Destination:
    def __init__(self, state_dir, environment_id):
        owner = installation.current_owner()
        self.home = owner['home']
        self.state = installation.owned_path(pathlib.Path(state_dir), self.home)
        require(self.state.is_dir() and str(self.state) == str(state_dir))
        persisted = read(self.state / 'environment-id', self.home, 2048).decode('utf-8').strip()
        require(text(persisted) and persisted == environment_id)
        self.environment_id = persisted
        self.descriptor = None
        self.receipt = None
        self.support = 'unsupported' if sys.platform != 'darwin' else 'unmanaged'
        # Managed service paths are explicit installer roots; default desktop homes
        # (.specwithcode or legacy .specweave-studio) do not imply service ownership.
        if self.state.name != 'userdata' or self.state.parent.parent not in {
                studio_paths.branded_root(self.home), studio_paths.legacy_root(self.home)}:
            return
        identity = installation.validate_identity(self.state.parent.name)
        if self.state.parent != studio_paths.identity_home(self.home, identity):
            return
        receipt_path = self.state.parent / 'installation.json'
        if not os.path.lexists(str(receipt_path)):
            return
        self.receipt = document(receipt_path, self.home)
        self.descriptor = installation.InstallationDescriptor.from_receipt(identity, self.receipt, home=self.home)
        require(self.descriptor.state == self.state)
        require(agent.version_tuple(self.receipt.get('version')) is not None)
        require(isinstance(self.receipt.get('sourceCommit'), str)
                and agent.HEX40.fullmatch(self.receipt['sourceCommit']) is not None)
        if sys.platform == 'darwin':
            self.support = 'supported'

    def supported(self):
        require(self.support == 'supported', self.support)
        return self.descriptor

    def binding(self):
        value = self.supported()
        return {'installationId': value.identity, 'environmentId': self.environment_id,
                'uid': value.uid, 'user': value.user, 'home': str(value.home),
                'studioHome': str(value.own), 'stateDir': str(value.state),
                'serviceLabel': value.label, 'serviceDomain': value.domain,
                'host': '127.0.0.1', 'port': value.port, 'webSessionPolicy': value.policy,
                'origin': 'specwithcode://environment/' + urllib.parse.quote(self.environment_id, safe='')}

    @property
    def updates(self):
        return self.supported().path(self.descriptor.own / 'updates')

    def target(self, value):
        require(isinstance(value, dict) and value.get('installationId') == self.supported().identity
                and value.get('environmentId') == self.environment_id)

    def consent(self):
        path = self.updates / 'managed-consent.json'
        if not os.path.lexists(str(path)):
            return None
        value = document(path, self.home, private=True)
        require(isinstance(value, dict) and set(value) == {
                    'schemaVersion', 'revision', 'binding', 'state', 'controller', 'changedAt', 'approval'}
                and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1
                and revision(value.get('revision')) and value['revision'] > 0
                and value.get('binding') == self.binding()
                and value.get('state') in ('enrolled', 'revoked')
                and isinstance(value.get('controller'), dict)
                and set(value['controller']) == {'sessionId', 'subject'}
                and all(text(item) for item in value['controller'].values()))
        require(text(value['changedAt']) and isinstance(value['approval'], dict)
                and set(value['approval']) == {'kind', 'uid'}
                and value['approval']['kind'] in ('native-owner', 'remote-administrator')
                and type(value['approval']['uid']) is int and value['approval']['uid'] == self.descriptor.uid)
        return value

    def revalidate(self):
        fresh = Destination(str(self.state), self.environment_id)
        require(fresh.binding() == self.binding())
        return fresh


@contextlib.contextmanager
def consent_lock(destination):
    directory = agent.ensure_dir(destination.updates, destination.home)
    require(directory.stat().st_mode & 0o022 == 0)
    path = installation.owned_path(directory / 'managed-consent.lock', destination.home)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ManagedError('busy') from None
        yield
    finally:
        os.close(fd)


def scopes_for(action):
    if action in ('enroll', 'revoke'):
        return ('access:write', 'environment:maintain')
    return ('orchestration:read',) if action == 'status' else ('environment:maintain',)


def active_consent(destination, controller, expected=None):
    saved = destination.consent()
    require(saved is not None, 'approval-required')
    require(saved['state'] == 'enrolled', 'revoked')
    require(saved['controller'] == controller, 'approval-required')
    if expected is not None:
        require(saved['revision'] == expected, 'conflict')
    return saved


def status(destination, controller):
    result = {'environmentId': destination.environment_id,
              'installationId': destination.descriptor.identity if destination.descriptor else None,
              'support': destination.support, 'localAutomation': 'unavailable',
              'remoteConsent': 'not-enrolled', 'revision': 0, 'operation': 'idle',
              'currentVersion': None, 'availableVersion': None, 'checkedAt': None,
              'agentLoaded': None, 'agentDisabled': None, 'stale': False}
    if destination.support != 'supported':
        return result
    saved = destination.consent()
    if saved:
        result.update(revision=saved['revision'], remoteConsent=('revoked' if saved['state'] == 'revoked'
                      else 'enrolled' if saved['controller'] == controller else 'other-controller'))
    config = agent.load_config(destination.updates, destination.home)
    domain, label, plist = installation.updater_removal(destination.home, destination.descriptor.identity)
    # What launchd runs now, not only what state.json last said: a disabled or unloaded job
    # leaves that file frozen. Read-only launchctl print and print-disabled.
    result.update(agent.update_request.agent_health(domain, label))
    script = installation.owned_path(studio_paths.updater_root(destination.home) / 'update_agent.py', destination.home)
    if plist.is_file() and script.is_file():
        result['localAutomation'] = 'enabled' if config['checkAutomatically'] else 'disabled'
    result['currentVersion'] = destination.receipt['version']
    path = destination.updates / 'state.json'
    if path.exists():
        saved_state = agent.load_state(path, destination.home)
        result.update(operation=saved_state['status'], availableVersion=saved_state['availableVersion'],
                      checkedAt=saved_state['checkedAt'])
    elif not config['checkAutomatically']:
        result['operation'] = 'disabled'
    result['stale'] = agent.update_request.stale(result['checkedAt'], config['checkAutomatically'])
    check_path = destination.updates / 'managed-check.json'
    if check_path.exists():
        checked = document(check_path, destination.home, private=True)
        require(isinstance(checked, dict) and checked.get('binding') == destination.binding()
                and checked.get('operation') in ('up-to-date', 'available', 'manual-required', 'error')
                and text(checked.get('checkedAt')))
        # An active install always wins over an informational remote discovery result.
        if checked.get('installedVersion') == destination.receipt['version'] \
                and result['operation'] not in ('installing', 'downloading', 'waiting-for-quiet') \
                and (not result['checkedAt'] or checked['checkedAt'] >= result['checkedAt']):
            result.update(operation=checked['operation'], availableVersion=checked.get('availableVersion'),
                          checkedAt=checked['checkedAt'])
    return result


def validate_request(request):
    require(isinstance(request, dict) and request.get('action') in ACTIONS, 'unavailable')
    action = request['action']
    allowed = {'action', 'environmentId', 'controller'}
    if action != 'status':
        allowed.add('input')
    if action.endswith('-local'):
        allowed.add('approval')
    require(set(request) == allowed and text(request.get('environmentId')), 'binding-changed')
    if action != 'status':
        value = request['input']
        fields = {'installationId', 'environmentId'}
        if action != 'check':
            fields.add('expectedRevision')
        if action.startswith('enroll'):
            fields.add('consent')
        require(isinstance(value, dict) and set(value) == fields)
        if action != 'check':
            require(revision(value['expectedRevision']), 'conflict')
        if action.startswith('enroll'):
            require(value['consent'] is True, 'approval-required')
        if action.endswith('-local'):
            require(isinstance(request['approval'], dict) and request['approval'].get('confirmed') is True
                    and revision(request['approval'].get('expectedRevision'))
                    and request['approval'] == {'kind': 'native-owner', 'confirmed': True,
                    **{key: value[key] for key in ('installationId', 'environmentId', 'expectedRevision')}},
                    'approval-required')
    return action


def execute(state_dir, request):
    action = validate_request(request)
    destination = Destination(state_dir, request['environmentId'])
    controller = request['controller']
    fresh_grant(destination.state, destination.home, controller, scopes_for(action))
    if action == 'status':
        return status(destination, controller)
    destination.target(request['input'])
    with consent_lock(destination):
        destination = destination.revalidate()
        fresh_grant(destination.state, destination.home, controller, scopes_for(action))
        saved = destination.consent()
        result = status(destination, controller)  # Validate status/config before committing consent.
        if action == 'check':
            active_consent(destination, controller)
            checker = agent.Agent(destination.home, destination.descriptor.identity, False, lambda _: None)
            checker.config = agent.load_config(destination.updates, destination.home)
            checker.inst = agent.load_installation(destination.home, destination.descriptor.identity)
            operation, available = 'error', None
            try:
                operation, available = checker.discover_version()
            except agent.AgentError:
                pass  # Only a fixed status crosses the helper boundary, never provider text.
            destination = destination.revalidate()
            fresh_grant(destination.state, destination.home, controller, scopes_for(action))
            active_consent(destination, controller, saved['revision'])
            agent.write_json(destination.updates / 'managed-check.json', {
                'schemaVersion': 1, 'binding': destination.binding(), 'operation': operation,
                'installedVersion': destination.receipt['version'],
                'availableVersion': available, 'checkedAt': agent.iso(now())}, destination.home)
            return status(destination, controller)
        else:
            expected = request['input']['expectedRevision']
            require(expected == (saved['revision'] if saved else 0), 'conflict')
            desired = 'enrolled' if action.startswith('enroll') else 'revoked'
            if not (saved and saved['state'] == desired and saved['controller'] == controller):
                require(expected < 9007199254740991, 'conflict')
                agent.write_json(destination.updates / 'managed-consent.json', {
                    'schemaVersion': 1, 'binding': destination.binding(), 'revision': expected + 1,
                    'state': desired, 'controller': controller, 'changedAt': agent.iso(now()),
                    'approval': {'kind': 'native-owner' if action.endswith('-local') else 'remote-administrator',
                                 'uid': destination.descriptor.uid}}, destination.home)
                result.update(revision=expected + 1, remoteConsent=desired)
        return result


@contextlib.contextmanager
def remote_apply_guard(identity, authorization):
    """Caller holds the shared installation lock. Local automation never calls this.

    Holding consent through apply linearizes a competing revoke: it either wins
    before apply admission, or receives busy and must retry with fresh status.
    """
    require(isinstance(authorization, dict) and set(authorization) == {'environmentId', 'controller', 'input'})
    value = authorization['input']
    require(isinstance(value, dict) and set(value) == {'installationId', 'environmentId', 'expectedRevision'}
            and revision(value.get('expectedRevision')))
    owner = installation.current_owner()
    installation.validate_identity(identity)
    destination = Destination(str(studio_paths.identity_home(owner['home'], identity) / 'userdata'),
                              authorization['environmentId'])
    destination.target(value)
    fresh_grant(destination.state, destination.home, authorization['controller'], ('environment:maintain',))
    active_consent(destination, authorization['controller'], value['expectedRevision'])
    with consent_lock(destination):
        destination = destination.revalidate()
        fresh_grant(destination.state, destination.home, authorization['controller'], ('environment:maintain',))
        active_consent(destination, authorization['controller'], value['expectedRevision'])
        yield


def main(argv=None, stdin=None, stdout=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args(argv)
    stdin, stdout = stdin or sys.stdin.buffer, stdout or sys.stdout
    try:
        payload = stdin.read(MAX_INPUT + 1)
        require(len(payload) <= MAX_INPUT, 'unavailable')
        result = {'ok': True, 'status': execute(args.state_dir, json.loads(payload))}
        code = 0
    except ManagedError as error:
        result, code = {'ok': False, 'error': {'code': error.code}}, 1
    except (AssertionError, ValueError, TypeError, KeyError):
        result, code = {'ok': False, 'error': {'code': 'binding-changed'}}, 1
    except Exception:
        result, code = {'ok': False, 'error': {'code': 'unavailable'}}, 1
    stdout.write(json.dumps(result) + '\n')
    return code


if __name__ == '__main__':
    sys.exit(main())
