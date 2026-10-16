"""Validated local service identity. Receipt fields never choose an OS owner or home."""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for installation safety checks')

import contextlib
import fcntl
import os
import pathlib
import plistlib
import pwd
import re
import stat

import studio_paths

LEGACY_POLICIES = {'m4': 'browser-cookie', 'm1': 'worker-relay', 'm3': 'worker-relay'}
WEB_SESSION_POLICIES = ('browser-cookie', 'worker-relay')
# Entries of the shared root that are not service identities.
RESERVED_IDENTITIES = {'backups', studio_paths.INSTALL_DIRECTORY, 'userdata', 'dev', 'caches', 'runtime', 'worktrees'}


def validate_identity(identity, *, staging=False):
    assert isinstance(identity, str) and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?', identity), 'Unsafe Studio identity'
    assert identity not in RESERVED_IDENTITIES and (identity != 'stage' or staging), 'Reserved Studio identity'
    return identity


def web_session_policy(identity, explicit=None, *, required=True):
    validate_identity(identity, staging=not required)
    legacy = LEGACY_POLICIES.get(identity)
    assert explicit is None or explicit in WEB_SESSION_POLICIES, 'Unknown web session policy'
    assert legacy is None or explicit in (None, legacy), 'Legacy web session policy cannot change'
    value = explicit or legacy
    assert value is not None or not required, 'Generic service requires an explicit web session policy'
    return value


def owned_path(path, home, uid=None):
    """Check lexical paths before resolving; existing components belong to this OS owner."""
    path, home = pathlib.Path(path), pathlib.Path(home)
    uid = os.getuid() if uid is None else uid
    assert path.is_absolute() and home.is_absolute(), 'Owned paths must be absolute'
    try:
        relative = path.relative_to(home)
    except ValueError:
        raise AssertionError('Owned path escapes the installing home') from None
    assert '..' not in path.parts and '.' not in relative.parts, 'Unsafe owned path component'
    ancestor = home
    for part in (None, *relative.parts):
        if part is not None:
            ancestor = ancestor / part
        assert not ancestor.is_symlink(), 'Owned path has a symlink ancestor'
        if ancestor.exists():
            assert ancestor.stat().st_uid == uid, 'Owned path belongs to another OS user'
            if ancestor != path:
                assert ancestor.is_dir(), 'Owned path has a non-directory ancestor'
    return path


@contextlib.contextmanager
def installation_lock(home, *, create=False):
    """Serialize each home's installs, full apply/rollback and release pruning; never wait."""
    root = owned_path(studio_paths.install_root(home), home)
    if create:
        root.mkdir(parents=True, mode=0o700, exist_ok=True)
    assert root.is_dir(), 'Owned release store is missing'
    path = owned_path(root / 'installation.lock', home)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), 'Installation lock has another owner or type'
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AssertionError('Another installation operation is in progress for this home') from None
        yield
    finally:
        os.close(fd)


def cli_paths(home, identity):
    validate_identity(identity, staging=True)
    suffix = '' if identity in LEGACY_POLICIES or identity == 'stage' else '-' + identity
    directory = pathlib.Path(home) / '.local/bin'
    return directory / ('specweave-studio' + suffix), directory / ('specwithcode' + suffix)


def updater_removal(home, identity):
    """An explicit updater opt-out remains possible after its product receipt disappears."""
    validate_identity(identity)
    owner = current_owner(home)
    label = 'com.specweave.studio.' + identity + '.updater'
    plist = owned_path(owner['home'] / 'Library/LaunchAgents' / (label + '.plist'), owner['home'], owner['uid'])
    if plist.exists():
        content = plistlib.loads(plist.read_bytes())
        script = owned_path(studio_paths.updater_root(owner['home']) / 'update_agent.py', owner['home'], owner['uid'])
        updates = owned_path(studio_paths.identity_home(owner['home'], identity) / 'updates', owner['home'], owner['uid'])
        assert content.get('Label') == label and content.get('ProgramArguments') == ['/usr/bin/python3', str(script), '--identity', identity], 'Updater LaunchAgent differs from installation identity'
        assert content.get('WorkingDirectory') == str(updates) and content.get('StandardOutPath') == content.get('StandardErrorPath') == str(updates / 'agent.log'), 'Updater LaunchAgent names another owned path'
    return 'gui/' + str(owner['uid']), label, plist


def current_owner(home=None, *, staging=False):
    uid = os.getuid()
    assert type(uid) is int and uid > 0 and os.geteuid() == uid, 'Service requires the actual non-root installing user'
    account = pwd.getpwuid(uid)
    actual = pathlib.Path(account.pw_dir)
    supplied = pathlib.Path.home() if home is None else pathlib.Path(home)
    assert supplied.is_absolute() and '..' not in supplied.parts, 'Invalid installing home'
    assert supplied == supplied.resolve(strict=True), 'Installing home may not be an alias'
    if not staging:
        assert supplied == actual and actual == actual.resolve(strict=True), 'Installing home differs from OS account home'
    assert supplied.is_dir(), 'Installing home is not a directory'
    owned_path(supplied, supplied, uid)
    return {'uid': uid, 'user': account.pw_name, 'home': supplied}


class InstallationDescriptor:
    def __init__(self, identity, *, home=None, staging=False, policy=None, require_policy=True):
        self.identity = validate_identity(identity, staging=staging)
        assert not staging or identity == 'stage', 'Private staging requires the reserved stage identity'
        owner = current_owner(home, staging=staging)
        self.uid, self.user, self.home = owner['uid'], owner['user'], owner['home']
        self.label = 'com.specweave.studio.' + identity
        self.domain = 'gui/' + str(self.uid)
        self.own = self.path(studio_paths.identity_home(self.home, identity))
        self.state = self.path(self.own / 'userdata')
        self.launcher = self.path(self.own / 'launch.sh')
        self.installation = self.path(self.own / 'installation.json')
        self.plist = self.path(self.home / 'Library/LaunchAgents' / (self.label + '.plist'))
        wrapper, alias = cli_paths(self.home, identity)
        self.wrapper, self.alias = self.path(wrapper), alias
        self.path(alias.parent)  # Optional alias leaf may belong to another tool; never adopt it.
        self.policy = web_session_policy(identity, policy, required=require_policy and not staging)

    def path(self, path):
        return owned_path(path, self.home, self.uid)

    @classmethod
    def from_receipt(cls, identity, receipt, *, home=None):
        assert isinstance(receipt, dict), 'Malformed installation receipt'
        value = cls(identity, home=home, policy=receipt.get('webSessionPolicy'))
        assert receipt.get('identity') == identity, 'Receipt names another installation'
        assert type(receipt.get('uid')) is int and receipt['uid'] == value.uid and receipt.get('user') == value.user, 'Receipt names another OS owner'
        for key, path in [('studioHome', value.own), ('stateDir', value.state), ('cliWrapper', value.wrapper)]:
            assert receipt.get(key) == str(path), 'Receipt names another owned path'
        service = receipt.get('service')
        assert isinstance(service, dict) and service.get('installed') is True, 'Receipt is not an installed service'
        assert service.get('label') == value.label and service.get('domain') == value.domain, 'Receipt names another service'
        assert receipt.get('host') == '127.0.0.1', 'Receipt is not bound to loopback'
        port = receipt.get('port')
        assert type(port) is int and 1024 <= port <= 65535, 'Invalid service port'
        value.port = port
        archive = receipt.get('archiveSha256')
        assert isinstance(archive, str) and re.fullmatch('[a-f0-9]{64}', archive), 'Invalid installed archive digest'
        release = value.path(studio_paths.releases_root(value.home) / archive[:20])
        assert receipt.get('release') == str(release), 'Receipt names another release'
        for name in ('stdout.log', 'stderr.log'):
            value.path(value.own / name)
        for name in ('server-runtime.json', 'statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm'):
            value.path(value.state / name)
        return value
