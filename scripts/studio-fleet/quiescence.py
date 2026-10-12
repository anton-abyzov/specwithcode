"""Fail-closed process proof for an exact owned macOS service.

A capture is read-only. Argument bytes stay in memory; receipts contain only
identities and hashes. Two inventories bracket the argv lookups.

The one process an update may stop is the service's own headless server browser:
chrome-headless-shell from the service's own tools directory, started directly by
the owned service on one of its own profiles, plus that browser's helpers.
`assert_quiescence` stops it gracefully right before the restart and reports it.
Anything else beneath the service still refuses the update.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import ctypes
import hashlib
import json
import os
import posixpath
import re
import signal
import struct
import subprocess
import time


def parse_processes(value):
    processes = {}
    for line in value.splitlines():
        fields = line.split(None, 8)
        assert len(fields) == 9, 'Invalid process inventory'
        assert all(re.fullmatch(r'\d+', item) for item in fields[:2]), 'Invalid process identity'
        # macOS ps renders the built-in nobody account as -2. It is valid in
        # the machine inventory; the owned root and supervisor still require 501.
        assert re.fullmatch(r'(?:\d+|-2)', fields[2]), 'Invalid process owner'
        pid, parent, uid = map(int, fields[:3])
        started = ' '.join(fields[3:8])
        assert re.fullmatch(r'[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}', started), 'Invalid process start time'
        assert pid not in processes and fields[8], 'Duplicate or missing process identity'
        processes[pid] = {'pid': pid, 'parent': parent, 'uid': uid,
                          'startedAt': started, 'executable': fields[8]}
    assert processes, 'Empty process inventory'
    return processes


# A loaded Mac (load average ~95 on M4) took more than 5 s to list processes and
# failed an install. Each attempt gets 30 s; one timed-out attempt is retried and a
# second timeout is raised unchanged, so callers still write their failure receipt.
PS_TIMEOUT_SECONDS = 30
PS_ATTEMPTS = 2


def read_processes():
    for attempt in range(1, PS_ATTEMPTS + 1):
        try:
            result = subprocess.run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,uid=,lstart=,comm='],
                                    capture_output=True, text=True, timeout=PS_TIMEOUT_SECONDS,
                                    env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        except subprocess.TimeoutExpired:
            if attempt == PS_ATTEMPTS:
                raise
            continue
        assert result.returncode == 0, 'Process inventory unavailable; output withheld'
        return parse_processes(result.stdout)


def parse_procargs2(value):
    """Decode actual kernel argv, rather than whitespace-ambiguous ps command text."""
    assert len(value) >= 5, 'Invalid supervisor arguments'
    argc = struct.unpack_from('=i', value)[0]
    assert 1 <= argc <= 4096, 'Invalid supervisor argument count'
    end = value.find(b'\0', 4)  # Kernel executable path, followed by NUL padding.
    assert end > 4, 'Missing supervisor executable'
    offset = end + 1
    while offset < len(value) and value[offset] == 0:
        offset += 1
    arguments = []
    for _ in range(argc):
        end = value.find(b'\0', offset)
        assert end >= offset, 'Truncated supervisor arguments'
        try:
            arguments.append(value[offset:end].decode('utf-8'))
        except UnicodeDecodeError:
            raise AssertionError('Invalid supervisor arguments') from None
        offset = end + 1
    return arguments  # Never inspect or return the environment following argv.


def _procargs2(pid):
    # macOS sys/sysctl.h: CTL_KERN=1, KERN_PROCARGS2=49.
    library = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t()
    assert library.sysctl(mib, 3, None, ctypes.byref(size), None, 0) == 0, 'Supervisor arguments unavailable'
    assert 0 < size.value <= 4 * 1024 * 1024, 'Invalid supervisor argument size'
    buffer = ctypes.create_string_buffer(size.value)
    assert library.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) == 0, 'Supervisor arguments unavailable'
    return buffer.raw[:size.value]


def read_argv(pid):
    return parse_procargs2(_procargs2(pid))


PROC_PIDPATHINFO_MAXSIZE = 4096  # macOS sys/proc_info.h: 4 * MAXPATHLEN.


def read_executable(pid):
    """The file a process actually runs, resolved by the kernel from its executable vnode
    (libproc proc_pidpath). Unlike ps comm or the argv copy on the process's own stack,
    the process cannot change it."""
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    buffer = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
    length = library.proc_pidpath(ctypes.c_int(pid), buffer, ctypes.c_uint32(PROC_PIDPATHINFO_MAXSIZE))
    assert 0 < length < PROC_PIDPATHINFO_MAXSIZE, 'Process executable unavailable'
    try:
        return buffer.raw[:length].decode('utf-8')
    except UnicodeDecodeError:
        raise AssertionError('Process executable unavailable') from None


# Bounds on the server browser an update may stop: the shared browser plus a few
# persistent profiles, and their GPU/network/renderer helpers.
SERVER_BROWSER_MAX_BROWSERS = 8
SERVER_BROWSER_MAX_PROCESSES = 64
# Graceful stop, then a forced stop of the same verified processes, then refusal.
SERVER_BROWSER_STOP_SECONDS = 15
SERVER_BROWSER_KILL_SECONDS = 5


def studio_home_of(supervisor_argv):
    """The service's own home: the directory holding the verified launch.sh."""
    launcher = supervisor_argv[2]
    home = posixpath.dirname(launcher)
    assert posixpath.basename(launcher) == 'launch.sh' and posixpath.isabs(home) and home != '/', \
        'Supervisor launch path is not an owned Studio launcher'
    assert posixpath.normpath(home) == home, 'Supervisor launch path is not normalized'
    return home


def _server_browser_executable(home):
    # PreviewBrowser installs <base-dir>/tools/chrome-headless-shell/<platform>/<version>/.
    return re.compile(re.escape(home) + r'/tools/chrome-headless-shell/(?:mac-arm64|mac-x64)/'
                      r'\d{1,6}(?:\.\d{1,6}){0,3}/chrome-headless-shell')


# Playwright's throwaway profile for the shared browser, under the service's TMPDIR.
_TEMP_PROFILE = re.compile(r'/(?:private/)?(?:tmp|var/folders/[A-Za-z0-9_+-]{1,64}/[A-Za-z0-9_+-]{1,64}/T)'
                           r'/playwright_chromiumdev_profile-[A-Za-z0-9]{1,64}')


def _server_browser_argv(arguments, home):
    """A browser the service launched: headless, driven over a pipe, on its own profile."""
    headless = any(item == '--headless' or item.startswith('--headless=') for item in arguments)
    assert headless and '--remote-debugging-pipe' in arguments, \
        'Server browser was not launched by the owned service'
    profiles = [item[len('--user-data-dir='):] for item in arguments if item.startswith('--user-data-dir=')]
    assert len(profiles) == 1, 'Server browser profile unavailable'
    profile = profiles[0]
    own = home + '/userdata/server-browser/profiles/'
    if profile.startswith(own):
        name = profile[len(own):]
        assert name and '/' not in name and name not in {'.', '..'} and '\0' not in name, \
            'Server browser profile is outside the owned service'
        return
    assert _TEMP_PROFILE.fullmatch(profile), 'Server browser profile is outside the owned service'


def _server_browsers(processes, root_pid, uid, home, candidates):
    """The root's non-supervisor descendants, accepted only as the service's own browser.

    Top-level browsers are direct children of the owned root running the owned
    chrome-headless-shell; every other process must descend from one of them and run
    that same executable. Anything else is rejected.
    """
    executable = _server_browser_executable(home)
    browsers = [item for item in candidates if item['parent'] == root_pid]
    assert len(browsers) <= SERVER_BROWSER_MAX_BROWSERS and len(candidates) <= SERVER_BROWSER_MAX_PROCESSES, \
        'Owned service has unexpected descendants'
    for browser in browsers:
        assert browser['uid'] == uid and executable.fullmatch(browser['executable']), \
            'Owned service has unexpected descendants'
    owner = {item['pid'] for item in browsers}
    for item in candidates:
        if item['pid'] in owner:
            continue
        top = item
        while top['parent'] != root_pid:
            top = processes[top['parent']]
        assert top['pid'] in owner and item['uid'] == uid and item['executable'] == top['executable'], \
            'Owned service has unexpected descendants'
    return browsers


def _owned_tree(processes, pid, uid, executable, home=None, check_browsers=True):
    root = processes.get(pid)
    assert root and pid > 0 and root['uid'] == uid, 'Owned service process identity changed'
    assert root['executable'] == executable, 'Owned service executable changed'
    parent = processes.get(root['parent'])
    assert parent and parent['pid'] != pid, 'Owned service parent identity unavailable'
    descendants, pending = [], [pid]
    seen = {pid}
    while pending:
        parent_pid = pending.pop()
        for child in processes.values():
            if child['parent'] != parent_pid:
                continue
            assert child['pid'] not in seen, 'Invalid service process parentage'
            seen.add(child['pid'])
            descendants.append(child)
            pending.append(child['pid'])
    # The verified LaunchAgent requires exactly this supervisor, with no work
    # beneath it. Even idle native/MCP/repl resources require operator review.
    # The service's own server browser is the one exception (see _server_browsers).
    supervisors = [item for item in descendants if item['executable'] == '/usr/bin/caffeinate']
    others = [item for item in descendants if item['executable'] != '/usr/bin/caffeinate']
    assert len(supervisors) == 1, 'Owned service has unexpected or missing descendants'
    assert not others or home is not None, 'Owned service has unexpected or missing descendants'
    supervisor = supervisors[0]
    assert supervisor['parent'] == pid and supervisor['uid'] == uid, 'Supervisor parent or owner changed'
    browsers = _server_browsers(processes, pid, uid, home, others) if others and check_browsers else []
    return root, parent, supervisor, browsers, sorted(others, key=lambda item: item['pid'])


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _identity(process):
    return {'pid': process['pid'], 'uid': process['uid'], 'startedAt': process['startedAt'],
            'identitySha256': _hash(process)}


def _capture(pid, uid, executable, supervisor_argv, process_reader, argv_reader, executable_reader=None):
    """The verified tree plus the server-browser processes found in it (kept private)."""
    assert uid == 501 and isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    assert executable.startswith('/') and supervisor_argv[:2] == ['/usr/bin/caffeinate', '-s'] and len(supervisor_argv) == 3
    assert supervisor_argv[2].startswith('/'), 'Supervisor launch path must be absolute'
    home = studio_home_of(supervisor_argv)
    process_reader = process_reader or read_processes
    argv_reader = argv_reader or read_argv
    first = _owned_tree(process_reader(), pid, uid, executable, home)
    assert argv_reader(first[2]['pid']) == supervisor_argv, 'Supervisor arguments differ from the verified LaunchAgent'
    for browser in first[3]:
        _server_browser_argv(argv_reader(browser['pid']), home)
    executable_reader = executable_reader or read_executable
    for item in first[4]:
        # ps reports a name the process chose; the kernel resolves the file it actually runs.
        assert executable_reader(item['pid']) == item['executable'], 'Owned service has unexpected descendants'
    second = _owned_tree(process_reader(), pid, uid, executable, home)
    assert first == second, 'Owned process identities changed during inventory'
    root, parent, supervisor, browsers, others = second
    proof = {'root': _identity(root), 'parentIdentitySha256': _hash(parent),
             'supervisor': _identity(supervisor), 'treeSha256': _hash([root, parent, supervisor]),
             'descendantCount': 1}
    if others:
        # Studio's own browser, safe to stop for the update. Identities only.
        proof['serverBrowser'] = {'browserCount': len(browsers), 'processCount': len(others),
                                  'browsers': [_identity(item) for item in browsers],
                                  'treeSha256': _hash(others)}
    return proof, browsers, others


def capture_quiescence(pid, uid, executable, supervisor_argv, *, process_reader=None, argv_reader=None,
                       executable_reader=None):
    return _capture(pid, uid, executable, supervisor_argv, process_reader, argv_reader, executable_reader)[0]


def quiescence_core(value):
    """The part of a proof that must not change before a restart: the service, its parent
    and its supervisor. The server browser may come and go; every capture re-verifies it."""
    if not isinstance(value, dict):
        return value  # Not a proof; compared whole, so any difference still fails.
    return {key: item for key, item in value.items() if key != 'serverBrowser'}


def _same_process(found, recorded):
    # A pid with the same start time, owner and executable is the same process, even
    # after its browser exited and launchd adopted it.
    return found is not None and all(found[key] == recorded[key] for key in ('pid', 'uid', 'startedAt', 'executable'))


def _still_running(processes, recorded):
    return [item for item in recorded if _same_process(processes.get(item['pid']), item)]


def _exited(process):
    # macOS ps names an exited process its parent has not reaped yet <defunct> or (name).
    return process['executable'] == '<defunct>' or bool(re.fullmatch(r'\([^/]{1,64}\)', process['executable']))


def stop_server_browser(pid, uid, executable, supervisor_argv, browsers, others, *, process_reader=None,
                        signaler=None, clock=None, sleeper=None, executable_reader=None, report=None):
    """Stop the verified server-browser trees: SIGTERM each top-level browser, wait, then
    SIGKILL only the tracked processes still running unchanged. Each signal follows a
    fresh inventory and a kernel executable check of the exact process (pid, start time,
    parent, owner and executable). A helper the browser starts while shutting down is
    tracked only when it runs the owned browser beneath a tracked browser process.

    `report`, when given, is filled as the stop proceeds (each signal sent), so a caller
    can record what happened even when this raises. Returns the completed record."""
    process_reader = process_reader or read_processes
    signaler = signaler or os.kill
    clock = clock or time.monotonic
    sleeper = sleeper or time.sleep
    executable_reader = executable_reader or read_executable
    home = studio_home_of(supervisor_argv)
    owned_browser = _server_browser_executable(home)
    started = clock()
    report = {} if report is None else report
    report.update(serverBrowser='stopping', browserCount=len(browsers), processCount=len(others),
                  browsers=[_identity(item) for item in browsers], signals=[])
    tracked = list(others)
    unverified = []  # Late processes whose executable could not be read: waited for, never signalled.

    def known(item):
        return any(all(item[key] == old[key] for key in ('pid', 'uid', 'startedAt')) for old in tracked)

    def late_helper(processes, item):
        """True for the owned browser beneath a tracked browser process; None when its
        executable cannot be read, as while it exits: it is neither tracked nor signalled,
        and the stop succeeds only once it is gone."""
        if item['uid'] != uid or not owned_browser.fullmatch(item['executable']):
            return False
        ancestor = processes.get(item['parent'])
        while ancestor is not None and ancestor['pid'] != pid:
            if _still_running(processes, [old for old in tracked if old['pid'] == ancestor['pid']]):
                try:
                    return executable_reader(item['pid']) == item['executable']
                except (AssertionError, OSError):
                    return None
            ancestor = processes.get(ancestor['parent'])
        return False

    def current():
        processes = process_reader()
        present = _owned_tree(processes, pid, uid, executable, home, check_browsers=False)[4]
        for item in present:
            if _exited(item) or known(item):
                continue
            accepted = late_helper(processes, item)
            assert accepted is not False, 'A new process started beneath the service while its browser stopped'
            if accepted:
                tracked.append(item)
            elif item not in unverified:
                unverified.append(item)
        return processes, present

    def signal_verified(targets, number):
        processes, _ = current()
        for item in _still_running(processes, targets):
            # Still beneath its recorded parent, or orphaned to launchd as its browser exited.
            assert processes[item['pid']]['parent'] in {item['parent'], 1}, \
                'Server browser identity changed before stopping'
            try:
                actual = executable_reader(item['pid'])
            except (AssertionError, OSError):
                # Exiting (the kernel has released its executable) or gone: never signalled
                # unverified; the stop waits for it and refuses if it stays.
                continue
            assert actual == item['executable'], 'Server browser identity changed before stopping'
            try:
                signaler(item['pid'], number)
            except ProcessLookupError:
                continue  # It exited after the check.
            report['signals'].append({'pid': item['pid'], 'startedAt': item['startedAt'],
                                      'signal': signal.Signals(number).name})

    def stopped_within(seconds):
        deadline = clock() + seconds
        while True:
            processes, present = current()
            # Done once no tracked or unverified process runs anywhere and the service has
            # only its supervisor.
            if not present and not _still_running(processes, tracked + unverified):
                return True
            if clock() >= deadline:
                return False
            sleeper(0.25)

    signal_verified(browsers, signal.SIGTERM)
    used = 'SIGTERM'
    if not stopped_within(SERVER_BROWSER_STOP_SECONDS):
        signal_verified(tracked, signal.SIGKILL)
        used = 'SIGKILL'
        assert stopped_within(SERVER_BROWSER_KILL_SECONDS), 'Studio server browser did not stop'
    report.update(serverBrowser='stopped', signal=used, lateHelperCount=len(tracked) - len(others),
                  unverifiedExitedCount=len(unverified),
                  stoppedInSeconds=round(max(0.0, clock() - started), 2))
    return dict(report)


def assert_quiescence(expected, executable, supervisor_argv, *, process_reader=None, argv_reader=None,
                      signaler=None, clock=None, sleeper=None, executable_reader=None, report=None):
    """Re-verify the owned tree right before a restart and stop the service's own server
    browser if one runs. Returns what was stopped, for the receipt; `report` (optional)
    holds the same record as it is built, for a failure receipt."""
    pid, uid = expected['root']['pid'], expected['root']['uid']
    actual, browsers, others = _capture(pid, uid, executable, supervisor_argv, process_reader, argv_reader,
                                        executable_reader)
    assert quiescence_core(actual) == quiescence_core(expected), 'Owned process prestate changed before restart'
    if not others:
        if report is not None:
            report.update(serverBrowser='not-running')
        return {'serverBrowser': 'not-running'}
    record = stop_server_browser(pid, uid, executable, supervisor_argv, browsers, others,
                                 process_reader=process_reader, signaler=signaler, clock=clock, sleeper=sleeper,
                                 executable_reader=executable_reader, report=report)
    after = _capture(pid, uid, executable, supervisor_argv, process_reader, argv_reader, executable_reader)[0]
    assert after == quiescence_core(expected), 'Owned process prestate changed while its browser stopped'
    return record
