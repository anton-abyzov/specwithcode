"""Release download cache for the SpecWithCode update agent (update_agent.py).

Kept beside update_agent.py, which is at the repository's 1500-line file cap. The desktop
build ships this file next to the agent (scripts/build-desktop-artifact.ts) and
install_launch_agent copies it next to the installed agent before replacing the agent,
so every agent copy can import it. The agent's own helpers are reached through the
agent's module, so tests that patch update_agent also patch what this module calls.

A cached asset is reused only when a record beside it names the same API URL (host,
repository and immutable asset ID) and size: GitHub lets a same-name asset be replaced,
even with one of the same size. Nothing here follows a symlink planted in the cache.
"""
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import time

RECORD_LIMIT = 4096
# `update.py --stage-release` (release_stage.stage_ahead): its liveness bound and checks.
PRESTAGE_TIMEOUT = 660


def _module(agent):
    return sys.modules[type(agent).__module__]


def record_path(destination):
    return destination.with_name('.' + destination.name + '.asset.json')


def remove_leaf(agent, path):
    """Remove whatever is at path (file, symlink or directory) without following a symlink
    at path itself; the directory holding it must still be owned."""
    ua, path = _module(agent), pathlib.Path(path)
    ua.owned(path.parent, agent.home)
    try:
        info = os.lstat(str(path))
        if stat.S_ISDIR(info.st_mode):
            shutil.rmtree(str(path))
        else:
            os.unlink(str(path))
    except FileNotFoundError:
        pass
    except OSError:
        raise ua.AgentError('Could not clear %s from the download cache' % path.name) from None


def forget(agent, directory, names):
    """Drop cached assets with their partial downloads and source records."""
    for name in names:
        for leaf in (name, name + '.part', '.' + name + '.asset.json'):
            remove_leaf(agent, pathlib.Path(directory) / leaf)


def _regular_size(path):
    try:
        info = os.lstat(str(path))
    except OSError:
        return None
    return info.st_size if stat.S_ISREG(info.st_mode) else None


def download(agent, name, asset, destination, limit):
    ua, home = _module(agent), agent.home
    ua.owned(pathlib.Path(destination).parent, home)
    destination = pathlib.Path(destination)
    expected = asset.get('size')
    source = {'schemaVersion': 1, 'url': agent.asset_url(asset), 'size': expected}
    record, part = record_path(destination), destination.with_name(destination.name + '.part')
    try:
        cached = ua.read_json(record, home, RECORD_LIMIT)
    except (ua.AgentError, OSError):  # Missing, unreadable, a symlink or a directory.
        cached = None
    size = _regular_size(destination)
    if cached == source and type(expected) is int and 0 <= expected <= limit and size == expected:
        return destination  # Completed by an earlier pass; verification follows regardless.
    # Unbind before replacing bytes, so a crash never binds new bytes to the old asset.
    # Unbound (legacy) downloads are fetched once to establish where they came from.
    remove_leaf(agent, record)
    remove_leaf(agent, part)
    if size is None:
        remove_leaf(agent, destination)  # A symlink or directory there would block every pass.
    fd = os.open(str(part), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            try:
                size = agent.fetch(agent.asset_url(asset), 'application/octet-stream', limit, handle.write)
            except ua.HttpFailure as error:
                raise ua.AgentError('Downloading %s failed (HTTP %d)' % (name, error.code)) from None
            handle.flush()
            os.fsync(handle.fileno())
        if type(expected) is int and size != expected:
            raise ua.AgentError('Download of %s was incomplete' % name)
        os.replace(str(part), str(destination))
        ua.write_json(record, source, home)
    except BaseException:
        if os.path.lexists(str(part)):
            os.unlink(str(part))
        raise
    return destination


def install_beside(ua, home):
    """Copy this module next to the installed agent. install_launch_agent runs this before
    it replaces the agent, so a new agent never starts without the module it imports. True when
    it wrote the module."""
    target = ua.ensure_dir(ua.studio_paths.updater_root(home), home)
    os.chmod(str(target), 0o700)
    path = ua.owned(target / pathlib.Path(__file__).name, home)
    data = pathlib.Path(os.path.abspath(__file__)).read_bytes()
    if not (path.is_file() and ua.read_owned(path, home, 8 << 20) == data):
        ua.atomic_write(path, data, home, 0o600)
        return True
    return False


def cleanup_versions(agent, installed):
    """Drop the downloads and helpers of releases at or below `installed`, and staging folders."""
    ua = _module(agent)
    for parent in (agent.updates / 'downloads', agent.updates / 'helpers'):
        if not parent.is_dir() or parent.is_symlink():
            continue
        for child in parent.iterdir():
            ranked = ua.version_tuple(child.name)
            if (ranked is not None and ranked <= installed) or child.name.startswith('.stage-'):
                ua.remove_path(child, agent.home)


def prestage(agent, verified):
    """Has the verified helper publish the runtime just downloaded (`update.py --stage-release`), so
    the apply skips unpacking it (release_stage.py; 5.6-7.0 s of every install on M4). Best effort,
    never raises: a helper without the flag (a release before it) or one that fails leaves the
    apply to stage it as before. Returns the helper's outcome, or None when it did not run."""
    ua = _module(agent)
    try:
        helper_dir = agent.verify_helpers(verified)
        runtime = ua.owned(agent.release_dir(verified['version']) / verified['runtime']['asset'], agent.home)
        return ua.run_helper_process(agent.helper_command(helper_dir, [
            '--identity', agent.identity, '--stage-release', '--archive', runtime, '--sha256', verified['runtime']['sha256']]),
            str(helper_dir), agent.helper_env(), PRESTAGE_TIMEOUT, home=agent.home)
    except Exception:
        return None


# -- workers follow M4 (increment 1239, AC-07)

RECONCILE_IDENTITY = 'm4'  # The fleet main: only its install brings the workers along.
FLEET_CONFIG = 'studio-fleet.json'
SPAWN = subprocess.Popen  # Tests replace it.


def _fleet_machines(agent):
    """Workers M4 knows about: its studio-fleet.json machines or the pinned SSH inventory."""
    try:
        machines = json.loads((agent.own / FLEET_CONFIG).read_text()).get('machines')
    except (OSError, ValueError, AttributeError):
        machines = None
    inventory = agent.home / '.local/share/specweave/fleet' / 'hosts.json'
    return bool(machines) or inventory.is_file()


RECONCILE_KEEP_SECONDS = 7 * 24 * 3600


def prune_reconciles(agent, parent):
    """Drops reconcile folders (a few hundred KB of scripts and a log each) older than a week."""
    ua = _module(agent)
    if not parent.is_dir() or parent.is_symlink():
        return
    for child in parent.iterdir():
        try:
            if not child.is_symlink() and time.time() - child.stat().st_mtime > RECONCILE_KEEP_SECONDS:
                ua.remove_path(child, agent.home)
        except OSError:
            pass


def reconcile_workers(agent, version):
    """Once M4 finalized `version` by any path (a release, Update now, the hourly agent), starts
    `fleet_rollout.py --version <version> --reconcile` from that release's verified helpers, detached,
    so M1 and M3 never stay behind unasked (1.0.186). It copies the helpers out first, since the
    cleanup that follows removes them. The rollout's lock makes it a no-op while a release's own
    fleet stage runs. Best effort, never raises; returns the log path, or None when nothing started."""
    if agent.identity != RECONCILE_IDENTITY or os.environ.get('STUDIO_FLEET_RECONCILE') == '0' \
            or (getattr(agent, 'test_mode', False) and SPAWN is subprocess.Popen) or not _fleet_machines(agent):
        return None
    ua = _module(agent)
    try:
        sources = [path for path in (agent.updates / 'helpers' / version).glob('*/scripts/studio-fleet')
                   if (path / 'fleet_rollout.py').is_file() and not path.is_symlink()]
        if len(sources) != 1:
            return None
        parent = agent.updates / 'reconcile'
        prune_reconciles(agent, parent)
        # A folder of its own: an earlier reconcile for this version may still run from its copy.
        target = parent / ('%s-%d-%d' % (version, int(time.time()), os.getpid()))
        shutil.copytree(str(sources[0]), str(target / 'studio-fleet'), symlinks=False,
                        ignore=shutil.ignore_patterns('__pycache__', 'test-*', 'fixtures'))
        log = target / 'reconcile.log'
        with open(str(log), 'ab') as out:
            SPAWN([agent.helper_python(), '-B', str(target / 'studio-fleet' / 'fleet_rollout.py'), '--version', version,
                   '--reconcile'], cwd=str(target / 'studio-fleet'), stdin=subprocess.DEVNULL, stdout=out,
                  stderr=subprocess.STDOUT, start_new_session=True, close_fds=True,
                  env={'HOME': str(agent.home), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8'})
        return log
    except Exception:  # noqa: BLE001 - a failed reconcile never fails the install it follows.
        return None
