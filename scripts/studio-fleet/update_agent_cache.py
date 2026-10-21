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
import os
import pathlib
import shutil
import stat
import sys

RECORD_LIMIT = 4096


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
