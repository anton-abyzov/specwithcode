"""Local, secret-free proof of the relay child actually spawned by this service.

The publisher is a direct child of the service. Neither a receipt nor a process
name alone grants an exemption: readers revalidate kernel birth, vnode path,
parent, UID and fixed argv, twice. No environment is decoded or retained.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for relay ownership proof')

import contextlib
import ctypes
import fcntl
import json
import os
from pathlib import Path
import stat
import struct
import sys
import uuid

NAME = 'relay-process.json'
VERSION = 1
ARGS = ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--output', 'default', 'run']
LIMIT = 8192
NODEV = 0xffffffff  # Darwin sys/param.h: (dev_t)-1, stored as uint32_t e_tdev.
TTY_FLAGS = 0xc0  # PROC_FLAG_CTTY | PROC_FLAG_CONTROLT, sys/proc_info.h.


class BsdInfo(ctypes.Structure):
    # Darwin sys/proc_info.h, PROC_PIDTBSDINFO. Birth has microsecond precision;
    # ps lstart is not sufficiently precise for this persisted PID binding.
    _fields_ = [(name, ctypes.c_uint32) for name in
                ('flags', 'status', 'xstatus', 'pid', 'parent', 'uid', 'gid',
                 'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in
                 ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')]
    _fields_ += [('nice', ctypes.c_int32), ('seconds', ctypes.c_uint64), ('micros', ctypes.c_uint64)]


def kernel_identity(pid):
    assert type(pid) is int and pid > 0 and sys.platform == 'darwin'
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)

    def info():
        value = BsdInfo()
        assert library.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value)) == ctypes.sizeof(value)
        assert value.pid == pid and value.seconds > 0 and value.micros < 1000000
        # A PTY shell can exec cloudflared and remain a direct service child.
        # Such a user terminal must never become exempt infrastructure.
        assert value.tdev == NODEV and value.flags & TTY_FLAGS == 0 and value.tpgid == 0
        return {'pid': pid, 'parent': value.parent, 'uid': value.uid,
                'birth': [value.seconds, value.micros], 'ttyDevice': value.tdev,
                'ttyFlags': value.flags & TTY_FLAGS, 'ttyProcessGroup': value.tpgid}

    before = info()
    buffer = ctypes.create_string_buffer(4096)
    size = library.proc_pidpath(pid, buffer, len(buffer))
    assert 0 < size < len(buffer)
    executable = buffer.value.decode('utf-8')
    assert executable.startswith('/') and before == info()
    return dict(before, executable=executable)


def kernel_argv(pid):
    library = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # KERN_PROCARGS2
    size = ctypes.c_size_t()
    assert library.sysctl(mib, 3, None, ctypes.byref(size), None, 0) == 0
    assert 0 < size.value <= 4 * 1024 * 1024
    buffer = ctypes.create_string_buffer(size.value)
    assert library.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) == 0
    value = buffer.raw[:size.value]
    assert len(value) > 4 and struct.unpack_from('=i', value)[0] == 1 + len(ARGS)
    end = value.find(b'\0', 4)
    assert end > 4
    offset = end + 1
    while offset < len(value) and value[offset] == 0:
        offset += 1
    result = []
    for _ in range(1 + len(ARGS)):
        end = value.find(b'\0', offset)
        assert end >= offset
        result.append(value[offset:end].decode('utf-8'))
        offset = end + 1
    assert Path(result[0]).name == 'cloudflared' and result[1:] == ARGS
    return result  # Never parse bytes after argc, which contain the environment.


@contextlib.contextmanager
def state_directory(home, uid):
    home = Path(home)
    assert home.is_absolute() and str(home.resolve(strict=True)) == str(home)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    home_fd = os.open(str(home), flags)
    state_fd = None
    try:
        state_fd = os.open('userdata', flags, dir_fd=home_fd)
        for fd in (home_fd, state_fd):
            value = os.fstat(fd)
            assert value.st_uid == uid and value.st_mode & 0o022 == 0
        yield state_fd
        # A renamed owning directory cannot silently select a different home.
        for path, fd in ((home, home_fd), (home / 'userdata', state_fd)):
            value = path.lstat()
            assert stat.S_ISDIR(value.st_mode)
            assert (value.st_dev, value.st_ino) == (os.fstat(fd).st_dev, os.fstat(fd).st_ino)
    finally:
        if state_fd is not None:
            os.close(state_fd)
        os.close(home_fd)


def read_at(fd, uid):
    handle = os.open(NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        before = os.fstat(handle)
        assert stat.S_ISREG(before.st_mode) and before.st_uid == uid
        assert before.st_nlink == 1 and before.st_mode & 0o077 == 0 and before.st_size <= LIMIT
        value = os.read(handle, LIMIT + 1)
        after = os.fstat(handle)
        linked = os.stat(NAME, dir_fd=fd, follow_symlinks=False)
        stable = lambda v: (v.st_dev, v.st_ino, v.st_mode, v.st_uid, v.st_nlink,
                            v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        assert stable(before) == stable(after) == stable(linked)
        assert len(value) == after.st_size
        return json.loads(value)
    finally:
        os.close(handle)


def read(home, uid):
    with state_directory(home, uid) as fd:
        return read_at(fd, uid)


@contextlib.contextmanager
def publication_lock(fd, uid):
    """Serialize only local receipt writers. Contention refuses immediately."""
    lock = os.open('.relay-process.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                   0o600, dir_fd=fd)
    try:
        value = os.fstat(lock)
        assert stat.S_ISREG(value.st_mode) and value.st_uid == uid
        assert value.st_nlink == 1 and value.st_mode & 0o077 == 0
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        linked = os.stat('.relay-process.lock', dir_fd=fd, follow_symlinks=False)
        assert (linked.st_dev, linked.st_ino) == (value.st_dev, value.st_ino)
        yield
    finally:
        os.close(lock)


def validate(record, home, service_pid, child_pid, uid):
    assert isinstance(record, dict) and set(record) == {'version', 'home', 'generation', 'service', 'child', 'argv'}
    assert type(record['version']) is int and record['version'] == VERSION and record['home'] == home
    assert isinstance(record['generation'], str) and 1 <= len(record['generation']) <= 100
    for key, pid in (('service', service_pid), ('child', child_pid)):
        value = record[key]
        assert isinstance(value, dict) and set(value) == {'pid', 'parent', 'uid', 'birth', 'executable',
                                                        'ttyDevice', 'ttyFlags', 'ttyProcessGroup'}
        assert all(type(value[k]) is int and value[k] > 0 for k in ('pid', 'parent', 'uid'))
        assert value['pid'] == pid and value['uid'] == uid
        assert isinstance(value['birth'], list) and len(value['birth']) == 2
        assert all(type(x) is int for x in value['birth'])
        assert value['birth'][0] > 0 and 0 <= value['birth'][1] < 1000000
        assert isinstance(value['executable'], str) and value['executable'].startswith('/')
        assert all(type(value[k]) is int for k in ('ttyDevice', 'ttyFlags', 'ttyProcessGroup'))
        assert value['ttyDevice'] == NODEV and value['ttyFlags'] == 0 and value['ttyProcessGroup'] == 0
    assert record['child']['parent'] == service_pid
    argv = record['argv']
    assert isinstance(argv, list) and len(argv) == 1 + len(ARGS)
    assert isinstance(argv[0], str) and argv[0].startswith('/')
    assert Path(argv[0]).name == 'cloudflared' and argv[1:] == ARGS


def recorded_pid(home, service_pid, uid, descendants):
    """Return at most one proven child; every missing/uncertain proof is no exemption."""
    try:
        record = read(home, uid)
        child_pid = record['child']['pid']
        validate(record, home, service_pid, child_pid, uid)
        listed = next(item for item in descendants if item['pid'] == child_pid)
        assert listed['parent'] == service_pid and listed['uid'] == uid
        # ps lists the path the child was started by (Homebrew: the /opt/homebrew/bin/cloudflared
        # symlink); proc_pidpath records the resolved file (its Cellar target). Only the listed
        # path is resolved; the recorded executable is still rechecked against the kernel below.
        assert isinstance(listed['executable'], str) and listed['executable'].startswith('/')
        assert os.path.realpath(listed['executable']) == record['child']['executable']
        assert not any(item['parent'] == child_pid for item in descendants)
        for _ in range(2):
            assert kernel_identity(service_pid) == record['service']
            assert kernel_identity(child_pid) == record['child']
            assert kernel_argv(child_pid) == record['argv']
        assert read(home, uid) == record
        return child_pid
    except (OSError, AssertionError, ValueError, KeyError, TypeError, StopIteration):
        return None


def publish(home, service_pid, child_pid, executable, generation):
    uid = os.getuid()
    assert os.getppid() == service_pid and uid > 0
    service, child = kernel_identity(service_pid), kernel_identity(child_pid)
    assert child['executable'] == os.path.realpath(executable)
    argv = kernel_argv(child_pid)
    assert argv == [executable] + ARGS
    record = {'version': VERSION, 'home': home, 'generation': generation,
              'service': service, 'child': child, 'argv': argv}
    validate(record, home, service_pid, child_pid, uid)
    with state_directory(home, uid) as fd, publication_lock(fd, uid):
        temporary = '.' + NAME + '.' + uuid.uuid4().hex
        handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            data = json.dumps(record, separators=(',', ':')).encode() + b'\n'
            assert len(data) <= LIMIT
            with os.fdopen(handle, 'wb') as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            assert kernel_identity(service_pid) == service and kernel_identity(child_pid) == child
            assert kernel_argv(child_pid) == argv
            os.replace(temporary, NAME, src_dir_fd=fd, dst_dir_fd=fd)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=fd)


def clear(home, service_pid, child_pid, generation):
    uid = os.getuid()
    assert os.getppid() == service_pid and uid > 0
    with state_directory(home, uid) as fd, publication_lock(fd, uid):
        record = read_at(fd, uid)
        validate(record, home, service_pid, child_pid, uid)
        assert record['generation'] == generation and kernel_identity(service_pid) == record['service']
        # Only the service's serialized lifecycle publisher clears its matching generation.
        assert read_at(fd, uid) == record
        os.unlink(NAME, dir_fd=fd)


if __name__ == '__main__':
    try:
        action, home, service, child, generation = sys.argv[1:6]
        assert action in ('publish', 'clear') and len(sys.argv) == (7 if action == 'publish' else 6)
        if action == 'publish':
            publish(home, int(service), int(child), sys.argv[6], generation)
        else:
            clear(home, int(service), int(child), generation)
    except Exception:
        # Deliberately no paths, argv, environment or exception text on stderr.
        print('Relay ownership unavailable', file=sys.stderr)
        sys.exit(1)
