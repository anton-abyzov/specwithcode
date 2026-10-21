#!/usr/bin/env python3
"""CAS-guarded updates of exact, idle Studio services; never adopts another service."""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import argparse
import contextlib
import copy
import ctypes
import datetime
import errno
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
from launcher import (cli_alias_state, is_studio_wrapper, migrate_runtime_path, render_cli,
                      render_legacy_cli, render_unnamed_cli, swap_cli_alias)
from release_policy import validate_manifest, validate_package, validate_upgrade
from auth_heartbeat import (bind_auth, encoded, prove_restart_heartbeat,
                            read_auth_sessions_in_transaction, restore_witness, rows_hash,
                            utc_timestamp, verify_restart_witness)
from quiescence import (VANISHED_READS, capture_quiescence, assert_quiescence, quiescence_core, read_processes,
                        reap_descendants, idle_providers, idle_provider_trees)
from release_retention import prune_releases, prune_state_backups
import database_continuity as continuity
import database_restart
import idle_agents
import install_progress
import live_database
import read_delta
import read_watermark
import settings_continuity
from update_receipt import describe_error, write_preflight_failure
from update_read import (TERMINAL_RUNS, _queue_held, run_work, AUTHORITY_TABLES, _read_state, _read_tables,
                         assert_idle, SINGLE_SCAN_SQLITE, ORDINARY_TABLE, virtual_tables, guarded_hashes,
                         guarded_rows, ACTIVITY_KEY, LOG_TABLES, STREAM_COLUMNS, CURSOR_COLUMNS, encoded_row,
                         rows_digest, table_columns, stream_key, has_rowid, stream_column,
                         append_only_activity, activity_digest, valid_activity, rowid_is_a_column,
                         has_covering_index, log_prefixes, carried_since, AUTH_INVARIANT_KEY,
                         AUTH_HEARTBEAT_COLUMN, AUTH_APP_VERSION_COLUMN, auth_invariant_hash,
                         is_projection_table, carried_applies, log_rows_carried)
from update_migration import (_column_definition, accepted_widenings, narrowed_rows, assert_migration_preserved,
                              auth_comparison, typed_auth_rows, typed_auth_rows_hash, verify_migration_heartbeat_witness,
                              heartbeat_window_start, prove_migration_preserved, assert_migration_typed_cells,
                              assert_migration_protected_schema)
from update_compare import (rows_carried_forward, same_guarded_rows, database_allowance, assert_capture_carried,
                            auth_since, guarded_row_counts, settings_preserved)
from update_service import (OTHER_SERVICE_PORTS, service_owns_listener, HOLD_REFUSAL, _utc, assert_held,
                            restart_old_release, native_work_counts, _name, descendant_names)
from state_backup import (BACKUP_SPACE_MARGIN, assert_backup_space, assert_clone_headroom, backup_state,
                          clone_state, discard_unused_backup, write_private as _write_private)
from service_launch_agent import upgraded_service_plist
import managed_updates
import studio_paths
import update_request

from installation_descriptor import InstallationDescriptor, cli_paths, current_owner, installation_lock, owned_path, validate_identity, web_session_policy
ENV_KEYS = {'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'STUDIO_HOME',
            'STUDIO_HOST', 'STUDIO_PORT', 'STUDIO_MODE', 'STUDIO_NO_BROWSER',
            'STUDIO_LOG_LEVEL', 'STUDIO_ENABLE_HOSTED_SERVICES', 'STUDIO_DEV_ALLOWED_ORIGINS',
            'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD', 'PWDEBUG', 'PLAYWRIGHT_HTML_OPEN'}
def digest(value):
    return hashlib.sha256(value).hexdigest()

def safe_path(path, home):
    return owned_path(path, home)

def run(command, timeout=10, **kwargs):
    value = subprocess.run(command, capture_output=True, timeout=timeout, **kwargs)
    assert value.returncode == 0, 'Owned operation failed; arbitrary command output withheld'
    return value.stdout

def release_verified(release):
    assert release.is_dir() and not release.is_symlink()
    manifest = json.loads((release / 'studio-manifest.json').read_text())
    validate_manifest(manifest)
    package = release / 'package.json'
    validate_package(manifest, package.read_bytes() if package.is_file() else None)
    declared = set()
    for entry in manifest['files']:
        path = release / entry['path']
        assert release in path.resolve().parents, 'Artifact path escapes release'
        declared.add(entry['path'])
        if entry['type'] == 'symlink':
            assert path.is_symlink() and os.readlink(path) == entry['target']
        else:
            assert path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == entry['sha256']
    assert {str(p.relative_to(release)) for p in release.rglob('*') if p.is_file() or p.is_symlink()} == declared | {'studio-manifest.json'}
    return manifest

def _rows_snapshot(state, include_auth, since=None, *, include_database=False):
    """(rows, auth, carried), or (rows, auth, databaseCapture) with include_database."""
    assert since is None or not include_database, 'Use _read_state for appended rows with a capture'
    proof, auth, carried, database = _read_state(state, include_auth, since, include_database)
    return (proof, auth, database) if include_database else (proof, auth, carried)

def rows_snapshot(state):
    return _rows_snapshot(state, False)[0]

def rows_snapshot_with_auth(state):
    """Return public protected rows and private auth from the same RO transaction."""
    return _rows_snapshot(state, True)[:2]

def rows_since(state, expected_rows):
    """Current protected rows plus what was appended after `expected_rows`, in one read."""
    proof, _, carried = _rows_snapshot(state, False, expected_rows)
    return proof, carried

def rows_since_with_database(state, expected_rows):
    """rows_since plus the complete database capture, in the same read transaction."""
    proof, _, carried, database = _read_state(state, False, expected_rows, True)
    return proof, carried, database

LSOF_TIMEOUT_SECONDS = 30
LSOF_ATTEMPTS = 2

def listeners(port):
    # lsof walks every open file; on a loaded Mac 5 s was not enough and failed the preflight.
    for attempt in range(1, LSOF_ATTEMPTS + 1):
        try:
            result = subprocess.run(['/usr/sbin/lsof', '-nP', '-t', '-iTCP:' + str(port), '-sTCP:LISTEN'],
                                    capture_output=True, text=True, timeout=LSOF_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            if attempt == LSOF_ATTEMPTS:
                raise
            continue
        assert result.returncode in {0, 1}, 'Listening ports could not be read'
        return sorted(set(int(value) for value in result.stdout.split()))

DATABASE_FILES = ('statev2.sqlite', 'statev2.sqlite-wal', 'statev2.sqlite-shm')
DETACHED_DATABASE = ('The SpecWithCode service is using a database log that was deleted from disk. '
                     'Restart SpecWithCode, then update')
LOCKS_LOST = ('The SpecWithCode service lost its SQLite locks on its database. '
              'Restart SpecWithCode, then update')

def open_inodes(pid):
    """{path: inode} of the regular files `pid` holds open, from lsof's field output."""
    for attempt in range(1, LSOF_ATTEMPTS + 1):
        try:
            result = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid), '-Fin'],
                                    capture_output=True, text=True, timeout=LSOF_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            if attempt == LSOF_ATTEMPTS:
                raise
            continue
        assert result.returncode in {0, 1}, 'Open service files could not be read'
        files, inode = {}, None
        for line in result.stdout.splitlines():
            if line[:1] in {'p', 'f'}:
                inode = None
            elif line[:1] == 'i' and line[1:].isdigit():
                inode = int(line[1:])
            elif line[:1] == 'n' and inode is not None:
                files.setdefault(line[1:], set()).add(inode)
        return files

def assert_database_attached(pid, state):
    """The service's open statev2 database, -wal and -shm are the files on disk. When another
    connection deletes the -wal and -shm while the service has them open (it can, once the
    service's lock on the database file is lost), the service keeps writing a log no other
    process can see. A read then misses its newest commits and races its checkpoints into
    SQLITE_CORRUPT ("database disk image is malformed"), so no snapshot can be trusted until
    the service reopens the database."""
    held = open_inodes(pid)
    for name in DATABASE_FILES:
        path = str(state / name)
        for inode in held.get(path, ()):
            try:
                current = os.stat(path).st_ino
            except FileNotFoundError:
                current = None
            assert current == inode, DETACHED_DATABASE

def assert_database_locked(state):
    """Some process holds SQLite's locks on the database and on -shm. The running service holds
    both for as long as its connection is open, so neither means it lost them: a process that
    closes another descriptor for one of those files drops its own POSIX locks on it. Until it
    reopens the database, any other open can rebuild -shm under it (SIGBUS) or delete -wal as
    the "last" user, and no snapshot is safe to take."""
    locks = live_database.service_locks(state / 'statev2.sqlite')
    assert locks['database'] is not None and locks['index'] is not None, LOCKS_LOST

def _service(identity):
    """The verified installation and its running service: receipt, LaunchAgent, launcher,
    runtime record, port owner and executable. Reads no database."""
    validate_identity(identity)
    owner = InstallationDescriptor(identity, require_policy=False)
    home, own, installation = owner.home, owner.own, owner.installation
    receipt = json.loads(installation.read_text())
    owner = InstallationDescriptor.from_receipt(identity, receipt, home=home)
    label, plist, wrapper, launcher, port = owner.label, owner.plist, owner.wrapper, owner.launcher, owner.port
    node = pathlib.Path(receipt['node'])
    assert node.is_absolute() and node.is_file() and run([str(node), '--version']).strip() == b'v22.20.0', \
        'The Node.js runtime is missing or is not v22.20.0'
    release = safe_path(pathlib.Path(receipt['release']), home)
    assert release == studio_paths.releases_root(home) / receipt['archiveSha256'][:20], \
        'The installed release is outside the owned releases folder'
    manifest = release_verified(release)
    assert manifest['sourceCommit'] == receipt['sourceCommit'] and manifest['product'] == 'SpecWeave Studio', \
        'The installed release does not match its receipt'
    content = plistlib.loads(plist.read_bytes())
    assert content['Label'] == label and content['ProgramArguments'] == ['/usr/bin/caffeinate', '-s', str(launcher)], \
        'The service LaunchAgent does not match the installation'
    assert content['WorkingDirectory'] == str(own) and content['StandardOutPath'] == str(own / 'stdout.log') and content['StandardErrorPath'] == str(own / 'stderr.log'), \
        'The service LaunchAgent does not match the installation'
    lines = launcher.read_text().splitlines()
    assert lines[:4] == ['#!/bin/sh', 'set -eu', 'umask 077', 'cd ' + shlex.quote(str(own))] and len(lines) == 5, \
        'The service launcher does not match the installation'
    tokens = shlex.split(lines[4])
    assert tokens[:4] == ['exec', '/usr/bin/env', '-i', 'HOME=' + str(home)], 'The service launcher does not match the installation'
    index = tokens.index(str(node))
    environment = dict(token.split('=', 1) for token in tokens[3:index])
    assert len(environment) == index - 3 and set(environment).issubset(ENV_KEYS), 'The service launcher sets unexpected variables'
    assert environment.get('USER') == environment.get('LOGNAME') == owner.user, 'Launcher names another OS user'
    assert environment['STUDIO_HOME'] == str(own) and environment['STUDIO_PORT'] == str(port), 'The service launcher does not match the installation'
    assert environment['STUDIO_HOST'] == '127.0.0.1' and environment['STUDIO_MODE'] == 'web', 'The service launcher does not match the installation'
    assert environment['STUDIO_NO_BROWSER'] == 'true' and environment['STUDIO_ENABLE_HOSTED_SERVICES'] == 'false', \
        'The service launcher does not match the installation'
    assert tokens[index:] == [str(node), str(release / 'bin.mjs'), 'start', '--no-browser', '--host', '127.0.0.1', '--port', str(port), '--base-dir', str(own), '--mode', 'web'], \
        'The service launcher does not match the installation'
    prefix = tokens[1:index + 2]
    migrate_runtime_path(prefix, home, node)  # Reject missing/custom paths even for a read-only prestate.
    # Any wrapper format a Studio release wrote; an update rewrites it in the current one.
    assert wrapper.read_text() in {render_legacy_cli(prefix), render_unnamed_cli(prefix), render_cli(prefix)}, \
        'The specweave-studio command does not match the installation'
    live = run(['/bin/launchctl', 'print', owner.domain + '/' + label], text=True)
    pid = re.search(r'^\s*pid = (\d+)\s*$', live, re.M)
    assert pid and re.search(r'^\s*state = running\s*$', live, re.M) and 'path = ' + str(plist) in live, \
        'The SpecWithCode service is not running'
    runtime = json.loads((own / 'userdata/server-runtime.json').read_text())
    assert runtime['pid'] == int(pid.group(1)) and runtime['host'] == '127.0.0.1' and runtime['port'] == port, \
        'The running service does not match its runtime record'
    assert listeners(port) == [runtime['pid']], 'Port belongs to another process'
    command = run(['/bin/ps', '-p', str(runtime['pid']), '-o', 'command='], text=True)
    assert str(node) in command and str(release / 'bin.mjs') in command, 'Running executable does not match the owned release'
    return {'home': home, 'own': own, 'installation': installation, 'receipt': receipt, 'label': label, 'plist': plist,
            'wrapper': wrapper, 'launcher': launcher, 'content': content, 'node': node, 'runtime': runtime, 'owner': owner}

SERVICE_KEYS = ('home', 'own', 'installation', 'receipt', 'label', 'plist', 'wrapper', 'launcher', 'content', 'node', 'runtime')

def _snapshot(identity, include_auth, since=None, widen_from=None, reads=None):
    """`reads`, an earlier _read_state result for the same `since`, stands in for the database read
    (snapshot_reusing); every service, file, process and listener check runs again."""
    service = _service(identity)
    home, own, installation, receipt, label, plist, wrapper, launcher, content, node, runtime = (service[key] for key in SERVICE_KEYS)
    protected = {'launcher': launcher, 'plist': plist, 'wrapper': wrapper, 'installation': installation,
                 'settings': own / 'userdata/settings.json', 'environment': own / 'userdata/environment-id'}
    for path in protected.values():
        safe_path(path, home)
        assert path.is_file() and not path.is_symlink(), 'A protected Studio file is missing or is a link'
    contents = {name: path.read_bytes() for name, path in protected.items()}
    file_hashes = {name: digest(data) for name, data in contents.items()}
    assert_database_attached(runtime['pid'], own / 'userdata')
    assert_database_locked(own / 'userdata')
    rows, auth, carried, database = reads or _read_state(own / 'userdata', include_auth, since, True, widen_from)
    other = {str(port): listeners(port) for port in OTHER_SERVICE_PORTS if port != receipt['port']}
    proof = {'schemaVersion': 1, 'identity': identity, 'uid': service['owner'].uid, 'port': receipt['port'], 'webSessionPolicy': service['owner'].policy, 'serviceLabel': label, 'servicePid': runtime['pid'],
            'archiveSha256': receipt['archiveSha256'], 'artifactSourceCommit': receipt['sourceCommit'],
            'fileHashes': file_hashes,
            # Key paths and value hashes only, so a restart that rewrites settings.json can be
            # proven to keep every user value (see settings_continuity) without storing any.
            'settingsProof': settings_continuity.settings_proof(contents['settings']),
            'rows': rows, 'databaseCapture': database, 'otherListeners': other, 'otherListenersOwned': service_owns_listener(other, runtime['pid'], read_processes()),
            'cookieName': receipt['cookieName'],
            'processQuiescence': capture_quiescence(runtime['pid'], service['owner'].uid, str(node), content['ProgramArguments']),
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    return proof, auth, carried

def snapshot(identity):
    return _snapshot(identity, False)[0]

def reap(identity, request, report=None):
    """Update now's fallback when a held service never quiets: stop the processes left beneath
    the verified service (quiescence.reap_descendants), by pid and only after proving each
    one's identity, and only while that service is held for `request` (assert_held, checked
    first and again before every signal). The service, its supervisor and its server browser
    keep running, so its update hold stays in place. Reads no database and changes no file.
    `report` (optional) holds the record as it is built, for a failed reap's record."""
    report = {} if report is None else report
    report.update(schemaVersion=1, identity=identity, result='refused')
    service = _service(identity)
    pid = service['runtime']['pid']
    report['servicePid'] = pid
    assert_held(service, request)
    reap_descendants(pid, service['owner'].uid, str(service['node']), service['content']['ProgramArguments'], report=report,
                     guard=lambda: assert_held(service, request))
    report.update(result='reaped', observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    return dict(report)

IDLE_WINDOW_RESETS = {'Native work is not idle', idle_agents.NOT_ALLOWED, 'Owned service has unexpected descendants',
                      'Owned service has unexpected or missing descendants'}

def idle_agent_refusal(identity, error, report=None, now=None):
    """A normal update's fallback when a snapshot refused for processes beneath the service
    (idle_agents): the service's own idle provider servers, and nothing else, are stopped once
    the database has shown no work and the same row counts for the quiet window. Returns the
    REFUSAL line, or None to keep refusal_line's; raises when the fallback does not apply. The
    snapshot still refuses: the next one decides. `report` holds the reap's record."""
    home = pathlib.Path.home().resolve()
    marker_path = safe_path(studio_paths.identity_home(home, identity) / 'updates' / idle_agents.MARKER, home)

    def restart_window(reason):
        """Work, a terminal or anything else this cannot stop: the quiet window starts again.
        A slow or busy reading says nothing about work and keeps it."""
        message = str(reason) if isinstance(reason, AssertionError) else ''
        if message in IDLE_WINDOW_RESETS and os.path.lexists(str(marker_path)):
            marker_path.unlink()
    if not isinstance(error, AssertionError) or 'descendants' not in str(error):
        restart_window(error)
        return None
    service = _service(identity)
    own, pid = service['own'], service['runtime']['pid']
    uid, node, arguments = service['owner'].uid, str(service['node']), service['content']['ProgramArguments']
    assert marker_path == safe_path(own / 'updates' / idle_agents.MARKER, home), 'Owned service home changed'
    config_path = safe_path(own / 'updates' / 'config.json', home)
    runtime_path = safe_path(own / 'userdata' / 'server-runtime.json', home)

    def settled():  # Checked first, and again right before every signal.
        assert (idle_agents.read_json(runtime_path) or {}).get('pid') == pid, 'Owned service process identity changed'
        config = idle_agents.read_json(config_path)
        assert idle_agents.allowed(config) and idle_agents.idle(native_work_counts(own / 'userdata')), \
            idle_agents.NOT_ALLOWED
        return config
    try:
        config = settled()
        digest = idle_agents.work_digest(guarded_row_counts(own / 'userdata'))
        providers = idle_providers(pid, uid, node, arguments)
    except BaseException as reason:
        restart_window(reason)
        raise
    now = now or datetime.datetime.now(datetime.timezone.utc)
    marker, left = idle_agents.observe(idle_agents.read_json(marker_path), pid, digest, now,
                                       idle_agents.quiet_minutes(config))
    if left:
        _write_private(marker_path, (json.dumps(marker, indent=2) + '\n').encode())
        return idle_agents.refusal(providers, wait=left)
    marker_path.unlink()
    report = {} if report is None else report
    report.update(schemaVersion=1, identity=identity, reason=idle_agents.CODE, servicePid=pid, providers=providers,
                  result='refused')
    receipts = safe_path(own / 'updates' / 'receipts', home)
    receipts.mkdir(mode=0o700, exist_ok=True)
    record = safe_path(receipts / ('idle-agents-%s-%s.json' % (now.strftime('%Y%m%dT%H%M%SZ'), uuid.uuid4().hex[:8])), home)
    try:
        reap_descendants(pid, uid, node, arguments, report=report, guard=settled, select=idle_provider_trees)
        report['result'] = 'reaped'
    finally:  # Whatever was signalled is recorded, even when the reap stopped part way.
        report['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        _write_private(record, (json.dumps(report, indent=2) + '\n').encode())
    return idle_agents.refusal(providers, stopped=len(report['signals']))

DATABASE_RESTART_REASONS = {LOCKS_LOST: 'locks-lost', DETACHED_DATABASE: 'detached'}

def wait_for_database_owner(identity, old_pid, deadline=database_restart.READY_SECONDS):
    """The restarted service's pid once it runs and holds its database locks, else None."""
    ends = time.monotonic() + deadline
    while time.monotonic() < ends:
        time.sleep(1)
        try:
            service = _service(identity)
            pid = service['runtime']['pid']
            if pid != old_pid and live_database.service_locks(service['own'] / 'userdata/statev2.sqlite')['database'] == pid:
                return pid
        except (AssertionError, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            continue
    return None

def database_restart_refusal(identity, error, report=None, now=None):
    """A snapshot refused because the service lost its database locks or its log: restart the
    verified service when database_restart's conditions hold. Returns the REFUSAL line, or None
    to keep refusal_line's; raises when a check cannot be made. `report` holds the record."""
    reason = DATABASE_RESTART_REASONS.get(str(error)) if isinstance(error, AssertionError) else None
    if reason is None:
        return None
    home = pathlib.Path.home().resolve()
    service = _service(identity)
    own, pid, owner = service['own'], service['runtime']['pid'], service['owner']
    state, updates = own / 'userdata', safe_path(own / 'updates', home)
    quiet_path, marker_path = updates / database_restart.QUIET_MARKER, updates / database_restart.MARKER
    now = now or datetime.datetime.now(datetime.timezone.utc)
    config = idle_agents.read_json(updates / 'config.json') or {}
    request = database_restart.forced_request(config)
    held = False
    if request:
        try:
            assert_held(service, request, now)
            held = True
        except (AssertionError, OSError, ValueError):
            pass

    def quiet():
        """False, and the quiet window starts again, for work, a terminal or anything else
        beneath the service. Checked first, and again right before the restart."""
        try:
            assert idle_agents.idle(native_work_counts(state)), 'Native work is not idle'
            idle_providers(pid, owner.uid, str(service['node']), service['content']['ProgramArguments'])
        except AssertionError:
            if os.path.lexists(str(quiet_path)):
                quiet_path.unlink()
            return False
        return True
    if not held:
        if reason != 'locks-lost' or not (request or idle_agents.allowed(config)) or not quiet():
            return None
        if not request:
            marker, left = idle_agents.observe(idle_agents.read_json(quiet_path), pid,
                                               idle_agents.work_digest(guarded_row_counts(state)), now,
                                               idle_agents.quiet_minutes(config))
            if left:
                _write_private(quiet_path, (json.dumps(marker, indent=2) + '\n').encode())
                return database_restart.refusal(reason, wait=left)
    wait = database_restart.restart_wait(idle_agents.read_json(marker_path), pid, now)
    if wait:
        return database_restart.refusal(reason, retry=wait)
    files = [state / name for name in DATABASE_FILES if (state / name).exists()]
    others = database_restart.other_openers(files, {pid, os.getpid()}, LSOF_TIMEOUT_SECONDS)
    if others:
        return database_restart.refusal(reason, others=len(others))
    # Last: the same service still has the fault, so a service restarted meanwhile is left alone.
    try:
        if reason == 'detached':
            assert_database_attached(pid, state)
        else:
            assert_database_locked(state)
    except AssertionError as again:
        if str(again) != str(error):
            raise
    else:
        return None
    # The lsof waits above can take a minute: the service may have been restarted, and work may
    # have started, since. Nothing holds new work outside a held request (idle_agent_refusal's
    # guard=settled does the same before every signal).
    if _service(identity)['runtime']['pid'] != pid or not (held or quiet()):
        return None
    report = {} if report is None else report
    report.update(schemaVersion=1, identity=identity, reason=reason, servicePid=pid, result='refused',
                  trigger='held' if held else 'update-now' if request else 'idle')
    receipts = safe_path(updates / 'receipts', home)
    receipts.mkdir(mode=0o700, exist_ok=True)
    record = safe_path(receipts / ('database-restart-%s-%s.json' % (now.strftime('%Y%m%dT%H%M%SZ'), uuid.uuid4().hex[:8])), home)
    try:
        # Written first, so a restart that fails part way still counts against RESTART_EVERY.
        _write_private(marker_path, (json.dumps({'schemaVersion': 1, 'servicePid': pid, 'restartedAt': now.isoformat()}) + '\n').encode())
        if os.path.lexists(str(quiet_path)):
            quiet_path.unlink()
        if reason == 'detached':
            try:
                stop_then_start_service(owner.domain, service['label'], pid)
            except AssertionError as stopped:
                if str(stopped) != DETACHED_STOP_TIMEOUT:
                    raise
                # Still running and still saving, or stuck: never killed. RESTART_EVERY holds the
                # next attempt; the person sees the agent's error until then.
                report['result'] = 'stop-timed-out'
                return database_restart.refusal(reason, retry=int(database_restart.RESTART_EVERY.total_seconds()))
        else:
            restart_service(owner.domain, service['label'], service['plist'], None, None, pid, service['receipt']['port'])
        report['result'] = 'restart-requested'
        report['newServicePid'] = wait_for_database_owner(identity, pid)
        if report['newServicePid'] is not None:
            report['result'] = 'restarted'
    finally:  # Whatever was sent is recorded, even when the restart failed.
        report['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        _write_private(record, (json.dumps(report, indent=2) + '\n').encode())
    return database_restart.refusal(reason, restarted=1)

def snapshot_refusal(identity, error):
    """The REFUSAL line for a refused snapshot: a fallback's (database restart, idle agents)
    when one applies."""
    for fallback in (database_restart_refusal, idle_agent_refusal):
        try:
            line = fallback(identity, error)
        except Exception:  # Not idle, a terminal is open, or the service changed: wait as before.
            line = None
        if line:
            return line
    return refusal_line(identity, error)

def snapshot_with_auth(identity):
    """Return the unchanged public snapshot plus private auth; never serialize the pair."""
    return _snapshot(identity, True)[:2]

def snapshot_since(identity, expected_rows, include_auth=False, widen_from=None):
    """Snapshot (and private auth when asked) plus the rows appended after `expected_rows`."""
    return _snapshot(identity, include_auth, expected_rows, widen_from)

def snapshot_reusing(identity, earlier, carried):
    """A snapshot whose rows, appended rows and capture are those of `earlier` (taken with the
    same `since`), for a database the read watermark shows unchanged since that read."""
    return _snapshot(identity, False, reads=(earlier['rows'], None, carried, earlier['databaseCapture']))[0]

def _clonefile():
    """libc clonefile(2) (macOS), or None where there is none."""
    try:
        function = ctypes.CDLL(None, use_errno=True).clonefile
    except (OSError, AttributeError, TypeError):
        return None
    function.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32)
    function.restype = ctypes.c_int
    return function

def clone_file(source, target):
    """Copies `source` to the new file `target` as an APFS clone (clonefile(2)): no data is
    written, so a multi-GB database is back in well under a second while the service is
    stopped. clonefile never copies: where it cannot clone (ENOTSUP on another file system,
    EXDEV across volumes) it fails at once. Any failure, or no clonefile at all (not macOS),
    falls back to a plain byte copy, which replaces anything a failed clone left at `target`."""
    clonefile = _clonefile()
    try:
        cloned = clonefile is not None and clonefile(os.fsencode(source), os.fsencode(target), 0) == 0
    except (OSError, ctypes.ArgumentError):
        cloned = False
    if not cloned:
        shutil.copyfile(source, target)

def restore_state(backup, own):
    """Puts the pre-update database, and the settings.json saved with it, back while the
    service is stopped: a new release may rewrite settings.json once when it starts."""
    state = own / 'userdata'
    staged = state / ('statev2.sqlite.owned-restore-' + str(uuid.uuid4()))
    try:
        clone_file(backup, staged)
        staged.chmod(0o600)
        for suffix in ('-wal', '-shm'):
            sidecar = state / ('statev2.sqlite' + suffix)
            if sidecar.exists(): sidecar.unlink()
        os.replace(staged, state / 'statev2.sqlite')
    finally:
        if staged.exists(): staged.unlink()
    saved = pathlib.Path(backup).parent / 'settings.json'
    if saved.is_file() and not saved.is_symlink():
        data = saved.read_bytes()
        current = state / 'settings.json'
        if current.is_symlink() or not current.is_file() or current.read_bytes() != data:
            _write_private(current, data)

def wait_for_stopped(pid, timeout=30, *, port=8319):
    for attempt in range(int(timeout / 0.5)):
        alive = subprocess.run(['/bin/kill', '-0', str(pid)], capture_output=True, timeout=5).returncode == 0
        if not alive and listeners(port) == []: return
        time.sleep(0.5)
    raise AssertionError('Owned service did not stop for the state restore')

DETACHED_STOP_TIMEOUT = 'The SpecWithCode service did not stop within the time given to save its database log'

def stop_then_start_service(domain, label, pid, timeout=database_restart.DETACHED_STOP_SECONDS):
    """Restart a service whose -wal was deleted from disk without losing that log's commits.

    Only the service still has the deleted log open, and its commits there are on no file another
    process can read. SQLite writes them into the database file when the service closes its
    connection (the last one checkpoints, into the database inode the service still holds), which
    the server does on SIGTERM (NodeRuntime.runMain interrupts, nodeSqliteClient's finalizer closes
    the database). `launchctl kickstart -k` may kill it before that. So: SIGTERM to the service
    itself, wait for it to exit, never SIGKILL, then start the job if launchd has not already."""
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        if time.monotonic() >= deadline:
            raise AssertionError(DETACHED_STOP_TIMEOUT)
        time.sleep(0.5)
    run(['/bin/launchctl', 'kickstart', domain + '/' + label])

def restart_service(domain, label, plist, old, new, pid, port):
    """`kickstart -k` (database_restart). An update stops and starts the service itself
    (stop_service, start_service), which also loads a rewritten LaunchAgent."""
    assert new is None, 'An update restarts with stop_service and start_service'
    run(['/bin/launchctl', 'kickstart', '-k', domain + '/' + label])

def stop_service(domain, label, pid, port):
    """The service stopped and its job unloaded, so launchd (KeepAlive) cannot start it again
    while its database is copied: bootout, then the process gone and its port free."""
    run(['/bin/launchctl', 'bootout', domain + '/' + label], timeout=45)
    wait_for_stopped(pid, port=port)

def start_service(domain, plist, old, new):
    """Load the job again, from `new` (a rewritten LaunchAgent, which launchd reads only on
    bootstrap) when given, and from the original file if launchd refuses the rewritten one."""
    mode = plist.stat().st_mode & 0o777
    if new is not None:
        atomic(plist, new, mode)
    try:
        run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=30)
    except BaseException:
        if new is not None:
            atomic(plist, old, mode)
            run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=30)
        raise

def job_loaded(domain, label):
    """True when launchd has the job loaded (launchctl print answers for it)."""
    try:
        run(['/bin/launchctl', 'print', domain + '/' + label], text=True)
        return True
    except (AssertionError, OSError, subprocess.TimeoutExpired):
        return False

def backup_state_clone(own, commit):
    """The pre-update copy, taken while the old service is stopped (state_backup.clone_state):
    (backup, 'clone' or 'sqlite-backup')."""
    return clone_state(own, commit, _clonefile())

def service_answers(identity, old_pid, archive_sha, source_commit):
    """Readiness without reading a row: the restarted service runs the intended release under a
    new pid, as _service verifies it (receipt, LaunchAgent, launcher, runtime record, port and
    executable), and has its own database open and locked."""
    service = _service(identity)
    pid, receipt, state = service['runtime']['pid'], service['receipt'], service['own'] / 'userdata'
    assert pid != old_pid, 'The service has not restarted yet'
    assert receipt['archiveSha256'] == archive_sha and receipt['sourceCommit'] == source_commit, \
        'Updated service is not the intended artifact'
    assert_database_attached(pid, state)
    assert_database_locked(state)
    return pid

def wait_until_answering(identity, old_pid, archive_sha, source_commit, ready_by):
    """service_answers' pid, polled every 0.5 s until `ready_by`; None if it never answered."""
    while time.monotonic() < ready_by:
        time.sleep(0.5)
        try:
            return service_answers(identity, old_pid, archive_sha, source_commit)
        except (AssertionError, OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.TimeoutExpired):
            continue
    return None

def assert_prestate(expected, actual, carried=None):
    for key in ['identity', 'uid', 'serviceLabel', 'servicePid', 'archiveSha256', 'artifactSourceCommit', 'fileHashes', 'rows', 'otherListenersOwned', 'cookieName', 'processQuiescence']:
        if key == 'rows':
            same = same_guarded_rows(expected[key], actual[key], carried)
        elif key == 'processQuiescence':
            # Studio's own server browser may start or exit meanwhile; every capture
            # re-verifies it, and it is stopped right before the restart.
            same = quiescence_core(expected[key]) == quiescence_core(actual[key])
        elif key == 'otherListenersOwned':
            # Recorded pids may differ (see OTHER_SERVICE_PORTS); Studio may own none of them.
            # A snapshot without the ownership fact (older helpers) keeps the exact comparison.
            if key in expected and key in actual:
                same = expected[key] is False and actual[key] is False
            else:
                same = expected['otherListeners'] == actual['otherListeners']
        else:
            same = expected[key] == actual[key]
        assert same, 'Guarded prestate changed: ' + key
    for key in ('port', 'webSessionPolicy'):
        assert expected.get(key) == actual.get(key), 'Guarded prestate changed: ' + key
    # A prestate is taken by the same updater that applies it; both carry the capture.
    assert ('databaseCapture' in expected) == ('databaseCapture' in actual), 'Complete database proof missing'
    if 'databaseCapture' in expected:
        assert_capture_carried(expected['databaseCapture'], actual['databaseCapture'],
                               expected['rows'], actual['rows'], carried)
    assert actual['rows']['nativeWorkIdle'] is True

# Bound on waiting for the restarted service (see apply). With a full rollback (bootout,
# stop wait, restore, bootstrap) it stays under the update agent's APPLY_TIMEOUT.
READINESS_DEADLINE_SECONDS = 300
# How long the agent lets this helper run before it kills it. Agents that predate the
# variable allow 900 s; newer ones pass a longer budget so a loaded Mac still gets the full
# readiness wait after a slow staging step.
_APPLY_BUDGET = os.environ.get('STUDIO_UPDATE_APPLY_BUDGET', '')
APPLY_BUDGET_SECONDS = min(3600, max(900, int(_APPLY_BUDGET))) if _APPLY_BUDGET.isdigit() else 900
# The readiness wait also ends this long after apply() started, so slow readings before the
# restart (staging, prestate checks) leave the rollback its 420 s share of the budget.
READY_BY_SECONDS_FROM_START = APPLY_BUDGET_SECONDS - 420
# Staging unpacks and verifies the release in a private home. On a loaded Mac 120 s was not
# enough and refused a real update, so it gets a liveness bound rather than a tight one; it
# is also cut to what is left of the pre-restart budget below.
STAGE_TIMEOUT_SECONDS = 600
# A restart needs at least this long to prove the new service ready. When the work before it
# ran so long that less is left, the update stops before writing anything: nothing changed,
# and the updater may try again, rather than restarting into a rollback it cannot avoid.
# Everything before the restart thus ends within READY_BY_SECONDS_FROM_START - this (420 s with
# the old 900 s budget) plus one reading in flight, which keeps the helper under the agent's 900 s.
# With a budget beyond the old 900 s the restart always keeps the full readiness wait.
MIN_READINESS_SECONDS = min(READINESS_DEADLINE_SECONDS, max(60, READY_BY_SECONDS_FROM_START - 420))
TOO_SLOW_TO_RESTART = 'Preparing the update took too long to leave time for the restart; nothing was changed'

def atomic(path, content, mode):
    temporary = path.with_name(path.name + '.owned-update-' + str(uuid.uuid4()))
    try:
        temporary.write_bytes(content)
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()

# The install gate (apps/server/src/serviceUpdate/UpdateInstallGate.ts). Written once the
# pointers name the new release, before the last checks of the old service, and removed once
# the release is verified or rolled back: while it is live the service (the old one before the
# restart, the new one after it) starts nothing on its own and refuses new messages, so the
# pre-restart checks, the state backup and the readiness and rollback snapshots find it idle.
# The service ignores it once this helper exits, and in any case INSTALL_GATE_MAX_SECONDS
# after it was written: the longest APPLY_BUDGET_SECONDS allows.
INSTALL_GATE_FILE = 'install-gate.json'
INSTALL_GATE_MAX_SECONDS = 3600
# Releases up to 1.0.46 notice a new gate only on their 5 s poll (ServiceUpdateHold
# AGENT_POLL_MS), so a scheduler tick may still start a run just after the gate is written
# (M4, 1.0.43 -> 1.0.45: a 5-minute task ran 6 s after the last row check and the update
# rolled back). Two polls plus a margin pass before the rows are compared again; a run that
# started meanwhile shows there and stops the update before the restart, which the agent
# retries.
INSTALL_GATE_SETTLE_SECONDS = 2 * 5 + 2

def install_gate_path(own, home):
    return safe_path(own / 'updates' / INSTALL_GATE_FILE, home)

def write_install_gate(own, home):
    path = install_gate_path(own, home)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    value = {'helperPid': os.getpid(), 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    atomic(path, (json.dumps(value) + '\n').encode(), 0o600)

def clear_install_gate(own, home):
    """Never raises: a gate left behind ends when this helper exits."""
    try:
        install_gate_path(own, home).unlink()
    except (AssertionError, OSError):
        pass

def restore_cli_alias(alias, original, written, report=None):
    """Undo this update's alias write, only while the alias still holds `written` (or
    already `original` again). Anything else there is left alone and reported; a launcher
    removed meanwhile is not recreated."""
    try:
        if original is None:
            outcome, _ = swap_cli_alias(alias, None, {written}, report=report)
            names = {'removed': 'removed-on-rollback', 'absent': 'already-absent'}
        else:
            outcome, _ = swap_cli_alias(alias, original, {written, original}, create=False, report=report)
            names = {'replaced': 'restored-on-rollback'}
        if outcome == 'foreign-kept-aside':
            return 'changed-outside-kept-aside'
        return names.get(outcome, 'changed-outside-left-untouched')
    except OSError:
        return 'restore-failed-left-as-is'

def repoint_cli_alias(alias, rolled_back, original, written):
    """Put back this update's launcher after a rollback step undid it but the identity
    pointers had to return to the new release. Returns True when the alias holds `written`."""
    try:
        if rolled_back == 'removed-on-rollback':
            outcome, _ = swap_cli_alias(alias, written, set())
        elif rolled_back == 'restored-on-rollback':
            outcome, _ = swap_cli_alias(alias, written, {original}, create=False)
        else:
            return False
        return outcome in {'created', 'replaced'}
    except OSError:
        return False

def publish_release(staged, destination):
    manifest = release_verified(staged)  # The installer anchored staged bytes to the verified archive.
    if destination.exists():
        release_verified(destination)
        assert (destination / 'studio-manifest.json').read_bytes() == (staged / 'studio-manifest.json').read_bytes(), 'Previously staged release differs from the verified archive'
    else:
        try:
            staged.rename(destination)  # Atomic directory publication; never nest into a racing winner.
        except OSError as error:
            if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            release_verified(destination)
            assert (destination / 'studio-manifest.json').read_bytes() == (staged / 'studio-manifest.json').read_bytes(), 'Concurrently published release differs from the verified archive'
    return manifest

def apply(identity, expected, archive, archive_sha, output, *, allow_existing_browser_heartbeat=False,
          allow_project_migrations=False, remote_authorization=None):
    validate_identity(identity)
    web_session_policy(identity, expected.get('webSessionPolicy'))
    owner = current_owner()
    # The fresh prestate and every write, rollback and prune occur while this home's
    # release store is exclusive, including against fresh installations of another ID.
    with installation_lock(owner['home']):
        guard = (contextlib.nullcontext() if remote_authorization is None else
                 managed_updates.remote_apply_guard(identity, remote_authorization))
        own = studio_paths.identity_home(owner['home'], identity)
        with guard, install_progress.ProgressWriter(safe_path(own / 'updates', owner['home']), receipt=output) as progress_file, \
                contextlib.closing(read_watermark.Watermark.open(own / 'userdata' / 'statev2.sqlite')) as watermark:
            return _apply(identity, expected, archive, archive_sha, output,
                          allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,
                          allow_project_migrations=allow_project_migrations, progress_file=progress_file, watermark=watermark)

def _apply(identity, expected, archive, archive_sha, output, *, allow_existing_browser_heartbeat=False,
          allow_project_migrations=False, progress_file=None, watermark=None):
    """`progress_file` (install_progress.ProgressWriter) is told each lap and the result. `watermark`
    (read_watermark.Watermark, open on the database) lets a re-read before the restart reuse the
    last full read when nothing has changed since; without either, nothing is written and every
    re-read is a full read."""
    validate_identity(identity)
    web_session_policy(identity, expected.get('webSessionPolicy'))
    progress_file, watermark = progress_file or install_progress.UNWRITTEN, watermark or read_watermark.NEVER_UNCHANGED
    started = time.monotonic()
    # Whole milliseconds per phase, in every receipt from 'prepared' on: each lap names the
    # phase that just ended. Additive, for reading only; the proofs and checks are unchanged.
    timings, lap_started = {}, [started]
    def lap(phase):
        now = time.monotonic()
        timings[phase] = timings.get(phase, 0) + round((now - lap_started[0]) * 1000)
        lap_started[0] = now
        progress_file.lap(phase, timings)
    def unchanged_since(mark):
        """True, and the check is booked as watermarkSkip, when no commit, file swap, log reset or
        reconnect happened since `mark` was taken right before a full read that passed."""
        if not watermark.unchanged(mark):
            return False
        lap('watermarkSkip')
        return True
    def finish(phase):
        lap(phase)
        timings['total'] = round((time.monotonic() - started) * 1000)
    def budget_left(reserve=0):
        left = READY_BY_SECONDS_FROM_START - MIN_READINESS_SECONDS - (time.monotonic() - started)
        assert left > reserve, TOO_SLOW_TO_RESTART
        return left
    capture_auth = allow_existing_browser_heartbeat or allow_project_migrations
    # The heartbeat window opens at the auth read below: a client may reconnect to the old
    # service any time after (through the gate settle and the backup), and the checks before
    # the restart already accept that heartbeat. Recorded in the receipt only once the restart
    # is next, so a refusal before it stays one the update agent retries.
    read_opened_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    home = pathlib.Path.home().resolve()
    own = studio_paths.identity_home(home, identity)
    # Measure appended rows and private auth in the same transaction as the proof. The watermark
    # is taken first, so a commit at any point after it shows; the -wal position too, so a re-read
    # can read only what committed since (read_delta). `base` is the last exact read.
    before_mark = watermark.take()
    position = read_delta.position(own / 'userdata' / 'statev2.sqlite')
    before, original_auth, carried = snapshot_since(identity, expected['rows'], capture_auth)
    # One base per log position appended rows are measured against: the agent's snapshot
    # (the prestate check) and this read itself (the checks after the gate). Measured against
    # its own rows, this read appended nothing after them, so it carries nothing (None): the
    # rows a later re-read returns must then match `before` exactly but for auth sessions, as
    # they do whenever read_delta returns.
    base = {'expected': {'position': position, 'since': expected['rows'],
                         'reads': (before['rows'], carried, before.get('databaseCapture'))},
            'before': {'position': position, 'since': before['rows'],
                       'reads': (before['rows'], None, before.get('databaseCapture'))}}
    def delta_since(since_key, since):
        """(position, reads): the -wal position, taken before this re-read, and the re-read of only
        what committed since the last exact read, or None when a full read must decide."""
        position = read_delta.position(own / 'userdata' / 'statev2.sqlite')
        try:
            reads = read_delta.reread(own / 'userdata', base[since_key], since)
        except (OSError, sqlite3.Error):  # The full read meets the same fault and decides.
            reads = None
        if reads is not None:
            lap('deltaRead')
        return position, reads
    restart_started_at = heartbeat_window_start(
        read_opened_at, datetime.datetime.now(datetime.timezone.utc).isoformat(), original_auth)
    assert_prestate(expected, before, carried)
    # Without migrations, a heartbeat proof compares existing sessions: refuse before any write.
    assert allow_project_migrations or not allow_existing_browser_heartbeat or original_auth is not None, \
        'Restart heartbeat proof requires the auth sessions table'
    lap('beforeRead')
    # Each copy is the size of the database (2.5 GB on a long-used Mac): keep the newest one
    # beside the copy made below, so updates never pile them up and fill the disk. Pruned
    # first, so the space it frees counts in the free-space check that follows.
    try:
        pruned_state_backups, prune_error = prune_state_backups(home, keep_newest=1), None
    except Exception as error:  # Pruning never fails an update.
        pruned_state_backups, prune_error = [], type(error).__name__
    # A disk too full for the copy refuses here, before staging, a pointer or a stop.
    assert_backup_space(own, home)
    lap('backupSpace')
    old_bytes = {name: (own / name).read_bytes() for name in ['installation.json', 'launch.sh']}
    receipt = json.loads(old_bytes['installation.json'])
    port = before.get('port', receipt.get('port', 8319))
    domain = 'gui/' + str(before['uid'])
    policy = web_session_policy(identity, receipt.get('webSessionPolicy'))
    assert before.get('webSessionPolicy', policy) == policy, 'Web session policy changed'
    wrapper, alias = cli_paths(home, identity)
    old_wrapper = wrapper.read_bytes()
    old_release = receipt['release']
    old_tokens = shlex.split(old_bytes['launch.sh'].decode().splitlines()[4])[1:]
    node_index = old_tokens.index(receipt['node'])
    cli_prefix = migrate_runtime_path(old_tokens[:node_index + 2], home, pathlib.Path(receipt['node']))
    new_release = safe_path(studio_paths.releases_root(home) / archive_sha[:20], home)
    assert digest(archive.read_bytes()) == archive_sha
    incoming = safe_path(studio_paths.incoming_root(home), home)
    incoming.mkdir(parents=True, exist_ok=True)
    # Reuse the integrity installer only in a new private staging home, never a live home.
    with tempfile.TemporaryDirectory(prefix='owned-update-stage-', dir=str(incoming)) as temporary:
        stage_home = pathlib.Path(temporary)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); stage_port = probe.getsockname()[1]
        try:  # Staging past the pre-restart budget can only end in TOO_SLOW_TO_RESTART.
            value = run(['/usr/bin/python3', str(pathlib.Path(__file__).with_name('install.py')), '--archive', str(archive), '--sha256', archive_sha,
                         '--node', receipt['node'], '--identity', 'stage', '--port', str(stage_port)],
                        timeout=min(STAGE_TIMEOUT_SECONDS, budget_left()),
                        env={'HOME': str(stage_home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}, text=True)
        except subprocess.TimeoutExpired:
            raise AssertionError(TOO_SLOW_TO_RESTART) from None
        staged = json.loads(value)
        staged_release = pathlib.Path(staged['release'])
        manifest = release_verified(staged_release)
        validate_upgrade(release_verified(pathlib.Path(old_release))['version'], manifest['version'])
        budget_left()
        # A published release is inert: no pointer names it until the check below passes, and
        # a retry reuses it (publish_release), so the prestate is checked once, before pointers.
        manifest = publish_release(staged_release, new_release)
    progress_file.set(version=manifest['version'])
    def replaced(value):
        lines = value.decode().splitlines()
        assert len(lines) == 5 and lines[4].startswith('exec ')
        prefix = list(cli_prefix)
        assert prefix[-1] == old_release + '/bin.mjs'
        prefix[-1] = str(new_release / 'bin.mjs')
        bootstrap = [part for part in prefix[:-2] if part.startswith('STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=')]
        if bootstrap:
            assert bootstrap == ['STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false']
        else:
            prefix.insert(len(prefix) - 2, 'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false')
        return ('\n'.join(lines[:4]) + '\nexec ' + ' '.join(shlex.quote(part) for part in prefix + old_tokens[node_index + 2:]) + '\n').encode()
    receipt.update({'version': manifest['version'], 'sourceCommit': manifest['sourceCommit'], 'archiveSha256': archive_sha, 'release': str(new_release),
                    'startup': {'autoBootstrapProjectFromCwd': False, 'presentation': 'overview'}})
    budget_left()
    lap('verifyAndStage')
    if unchanged_since(before_mark):  # The rows, appended rows and capture of the read above.
        current, current_carried = snapshot_reusing(identity, before, carried), carried
    else:
        position, reads = delta_since('expected', expected['rows'])
        if reads is not None:  # Only auth sessions changed: every other check of a snapshot runs.
            current_carried = reads[1]
            current = snapshot_reusing(identity, {'rows': reads[0], 'databaseCapture': reads[2]}, current_carried)
        else:
            current, _, current_carried = snapshot_since(identity, expected['rows'])
        base['expected'] = {'position': position, 'since': expected['rows'],
                            'reads': (current['rows'], current_carried, current.get('databaseCapture'))}
    assert_prestate(expected, current, current_carried)
    lap('prestateCheck')
    # Written only once the prestate holds, so a refusal above leaves no folder behind.
    backup = own / 'owned-updates' / str(uuid.uuid4())
    backup.mkdir(parents=True, mode=0o700)
    for name, value in old_bytes.items(): (backup / name).write_bytes(value)
    (backup / 'cli-wrapper.sh').write_bytes(old_wrapper)
    shutil.copyfile(home / 'Library/LaunchAgents' / (before['serviceLabel'] + '.plist'), backup / 'service.plist')
    (backup / 'prestate.json').write_text(json.dumps(before, indent=2) + '\n')
    budget_left(INSTALL_GATE_SETTLE_SECONDS)
    new_launcher = replaced(old_bytes['launch.sh'])
    cli_prefix[-1] = str(new_release / 'bin.mjs')
    new_bytes = {'launch.sh': new_launcher, 'wrapper': render_cli(cli_prefix).encode(),
                 'installation.json': (json.dumps(receipt, indent=2) + '\n').encode()}
    # The `specwithcode` launcher carries the wrapper's exact bytes. It is created when
    # missing and replaced only while it holds a Studio wrapper (this update's texts, or one
    # any Studio release wrote, which may name an older release). Ownership is checked again
    # on the very entry replaced (swap_cli_alias), so a link or another tool's file that
    # appears meanwhile stays untouched; the update still proceeds.
    safe_path(alias.parent, home)
    known_wrappers = {old_wrapper, new_bytes['wrapper']}
    def studio_alias(value):
        return value in known_wrappers or is_studio_wrapper(value, home)
    alias_planned = cli_alias_state(alias, studio_alias)[0] != 'foreign'
    manage_alias = False  # True once this update has written the launcher.
    old_alias = None
    progress = {'identity': identity, 'phase': 'prepared', 'before': before, 'backup': str(backup),
                'newRelease': str(new_release), 'newArchiveSha256': archive_sha, 'helperPid': os.getpid(),
                'cliAlias': 'not-written-yet' if alias_planned else 'foreign-left-untouched',
                'readinessDeadlineSeconds': READINESS_DEADLINE_SECONDS,
                'readyBySecondsFromStart': READY_BY_SECONDS_FROM_START,
                'expectedNewHashes': {name: digest(value) for name, value in new_bytes.items()},
                'prunedStateBackups': pruned_state_backups}
    if prune_error:
        progress['stateBackupPruneError'] = prune_error
    progress['timings'] = timings  # The phases done when each receipt below is written.
    output.write_text(json.dumps(progress, indent=2) + '\n')
    restart_requested = False
    plist_hashes = {before['fileHashes']['plist']}  # Plus the rewritten LaunchAgent once written.
    state_backup = None
    service_stopped = service_started = False
    after = None
    after_carried = None
    current_auth = None
    try:
        atomic(own / 'launch.sh', new_bytes['launch.sh'], 0o700)
        atomic(wrapper, new_bytes['wrapper'], 0o700)
        if alias_planned:
            # Not an identity pointer: a failed write is reported, never fatal.
            alias_report = {}
            try:
                outcome, old_alias = swap_cli_alias(alias, new_bytes['wrapper'], studio_alias, report=alias_report)
            except OSError:
                outcome, old_alias = 'write-failed-left-as-is', None
            if 'keptAside' in alias_report:
                progress['cliAliasKeptAside'] = alias_report['keptAside']
            # Only a launcher this update wrote is undone on rollback. Decided before anything
            # else can fail, so a later failure still puts the replaced launcher back.
            manage_alias = outcome in {'created', 'replaced'}
            progress['cliAlias'] = outcome if manage_alias or outcome in {'write-failed-left-as-is', 'foreign-kept-aside'} \
                else 'changed-outside-left-untouched'
            if old_alias is not None:
                (backup / 'cli-alias.sh').write_bytes(old_alias)
        atomic(own / 'installation.json', new_bytes['installation.json'], 0o600)
        lap('swapPointers')
        progress['phase'] = 'pointers-written'
        output.write_text(json.dumps(progress, indent=2) + '\n')
        # The old service starts nothing more on its own from here (scheduler, webhooks, run
        # now), so the rows compared below stay as they are through the backup and restart.
        # Kept until the finally below: the new release (or the old one a rollback starts
        # again) stays idle for the readiness and rollback snapshots.
        write_install_gate(own, home)
        time.sleep(INSTALL_GATE_SETTLE_SECONDS)
        lap('gateSettle')
        passed = [before_mark]  # Taken right before the last read (full or read_delta) that matched `before`.
        def assert_unchanged_before_restart():
            if unchanged_since(passed[0]):  # That read stands: it would read the same rows again.
                return
            mark = watermark.take()
            position, reads = delta_since('before', before['rows'])
            if reads is not None:
                current_rows, current_carried, current_database = reads
            elif 'databaseCapture' in before:
                current_rows, current_carried, current_database = rows_since_with_database(own / 'userdata', before['rows'])
            else:
                current_rows, current_carried = rows_since(own / 'userdata', before['rows'])
                current_database = None
            assert same_guarded_rows(before['rows'], current_rows, current_carried,
                                     auth_heartbeat=allow_existing_browser_heartbeat), 'Native work changed before restart'
            assert_provable_reconnects(current_rows)
            if 'databaseCapture' in before:
                assert_capture_carried(before['databaseCapture'], current_database, before['rows'], current_rows,
                                       current_carried, auth_heartbeat=allow_existing_browser_heartbeat,
                                       message='Complete database changed before restart')
            passed[0] = mark
            base['before'] = {'position': position, 'since': before['rows'], 'reads': (current_rows, current_carried, current_database)}
        def assert_provable_reconnects(current_rows):
            # Auth may differ only as the proof after the restart accepts, so a connect it would roll
            # back (a CLI session, a revoked session, one past the session counts) refuses here, with
            # the old release running: an install request retries it, an automatic install is held.
            if not allow_existing_browser_heartbeat or original_auth is None \
                    or current_rows['hashes'].get('auth_sessions') == before['rows']['hashes'].get('auth_sessions'):
                return
            try:
                # Its own read, so a client connecting again since the rows were read is proven too.
                current_auth, current_view = auth_since(own / 'userdata', before['rows'])
                prove_restart_heartbeat(before['rows'], current_view, original_auth, current_auth, restart_started_at,
                                        datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                        identity=identity, web_session_policy=policy)
            except (AssertionError, KeyError, ValueError, OSError, sqlite3.Error) as error:  # Retried with a fresh snapshot.
                raise AssertionError('Native work changed before restart: auth (%s)' % str(error)[:200]) from None
        assert_unchanged_before_restart()
        def assert_same_service_pid():
            # A service launchd restarted on its own after the pointers moved would be the
            # new release, migrating before any backup exists.
            live = run(['/bin/launchctl', 'print', domain + '/' + before['serviceLabel']], text=True)
            assert re.search(r'^\s*pid = ' + str(before['servicePid']) + r'\s*$', live, re.M), \
                'The service restarted on its own before the update restarted it'
        assert_same_service_pid()
        lap('checkBeforeRestart')
        plist = home / 'Library/LaunchAgents' / (before['serviceLabel'] + '.plist')
        old_plist = plist.read_bytes()
        assert digest(old_plist) == before['fileHashes']['plist'], 'Verified LaunchAgent changed before restart'
        new_plist = upgraded_service_plist(old_plist)
        # Studio's own server browser is the one process stopped here (gracefully, verified).
        browser_stop = {}  # Filled as signals are sent, so a failure receipt names them too.
        try:
            stopped = assert_quiescence(before['processQuiescence'], receipt['node'], ['/usr/bin/caffeinate', '-s', str(own / 'launch.sh')],
                                        report=browser_stop)
        finally:
            if browser_stop:
                progress['serverBrowserStop'] = dict(browser_stop)
        if stopped:
            progress['serverBrowserStop'] = stopped
        lap('stop')
        # Nothing may change between this last check and the stop: the copy below is what a
        # rollback restores, and the after-snapshot is compared with `before`. Checked here, last,
        # so a write the old service made meanwhile stops the update with the old release still
        # running instead of rolling the new one back.
        assert_same_service_pid()
        assert_unchanged_before_restart()
        watermark.close()  # No connection of this helper stays open while the service closes its own.
        # Refused before the stop, with the old service running: no room for the copy, or no time left.
        assert_clone_headroom(own, home)
        budget_left()  # At least MIN_READINESS_SECONDS left before ready_by.
        lap('finalCheck')
        # Stopped and unloaded before the copy, so no writer can change the files it clones. If the
        # stop or the copy fails, the old release is started again on its untouched database.
        # Recorded first, so a receipt left by a helper that dies from here on shows the job may be
        # unloaded; serviceStopped follows once the stop is confirmed (or the failure path finds
        # the job unloaded), so a bootout that left the old service running is not a restart.
        service_stopped = progress['stopAttempted'] = True
        output.write_text(json.dumps(progress, indent=2) + '\n')
        stop_service(domain, before['serviceLabel'], before['servicePid'], port)
        progress['serviceStopped'] = True
        lap('serviceStop')
        # The new release migrates the database on start; a rollback must restore both.
        state_backup, progress['stateBackupMethod'] = backup_state_clone(own, before['artifactSourceCommit'])
        lap('backupClone')
        progress['phase'] = 'restart-requested'
        progress['restartStartedAt'] = restart_started_at
        progress['stateBackup'] = str(state_backup)
        output.write_text(json.dumps(progress, indent=2) + '\n')
        restart_requested = True
        if new_plist is not None:
            plist_hashes.add(digest(new_plist))
            progress['serviceLaunchAgent'] = 'process-type-interactive-added'
        start_service(domain, plist, old_plist, new_plist)
        service_started = True
        progress_file.set(serviceRestartedAt=install_progress.now())
        lap('restart')
        restarted_at = time.monotonic()
        # A migration may widen a protected table (accepted_widenings); measure it in the
        # same read as the after-snapshot.
        widen = ({'widen_from': before['databaseCapture']['schema']['columns']}
                 if allow_project_migrations and 'databaseCapture' in before else {})
        # Bounded by time, not attempts: one reading can take a minute when the process inventory times
        # out and retries, and the rollback must finish well inside the update agent's APPLY_TIMEOUT,
        # which kills the helper outright. Readiness itself is the cheap check (service_answers: the new
        # pid, release and database locks, no rows), polled until the deadline. The full read the proofs
        # below need then runs once, however late: it is never skipped, and tried again only while it
        # cannot be taken and the deadline allows.
        ready_by = min(restarted_at + READINESS_DEADLINE_SECONDS, started + READY_BY_SECONDS_FROM_START)
        wait_until_answering(identity, before['servicePid'], archive_sha, manifest['sourceCommit'], ready_by)
        lap('readinessCheap')
        while True:
            try:
                after, current_auth, after_carried = snapshot_since(identity, before['rows'], capture_auth, **widen)
                if after['servicePid'] != before['servicePid']: break
            # A process inventory that timed out twice is retried here like any other
            # not-yet-ready reading, rather than rolling back a service that is starting.
            except (AssertionError, OSError, sqlite3.Error, subprocess.TimeoutExpired): pass
            if time.monotonic() >= ready_by: break
            time.sleep(0.5)
        assert after and after['servicePid'] != before['servicePid'], \
            'Updated service did not become ready within %d s' % max(0, round(ready_by - restarted_at))
        lap('readiness')
        assert after['archiveSha256'] == archive_sha and after['artifactSourceCommit'] == manifest['sourceCommit'], 'Updated service is not the intended artifact'
        for row_key, pointer_key in [('launcher', 'launch.sh'), ('wrapper', 'wrapper'), ('installation', 'installation.json')]:
            assert after['fileHashes'][row_key] == progress['expectedNewHashes'][pointer_key], 'Updated pointer differs from the intended artifact'
        if manage_alias and cli_alias_state(alias, {new_bytes['wrapper']})[0] != 'owned':
            # Not an identity pointer: a change made meanwhile is reported, never fatal.
            progress['cliAlias'] = 'changed-outside-left-untouched'
        heartbeat = None
        appended = False
        migration_cells = None
        widenings = {}
        if allow_project_migrations:
            if 'databaseCapture' in before:
                assert 'databaseCapture' in after, 'Complete database proof missing after restart'
                widenings = accepted_widenings(before['databaseCapture'], after['databaseCapture'], before['rows'])
            heartbeat = prove_migration_preserved(
                before['rows'], narrowed_rows(after['rows'], widenings), original_auth, current_auth,
                restart_started_at, after['observedAt'], identity=identity,
                allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,
                carried=after_carried, web_session_policy=policy)
            if 'databaseCapture' in before:
                assert 'databaseCapture' in after, 'Complete database proof missing after restart'
                assert_migration_typed_cells(before['databaseCapture'], after['databaseCapture'],
                                             before['rows'], after['rows'], after_carried, widenings)
                assert_migration_protected_schema(before['databaseCapture'], after['databaseCapture'],
                                                  before['rows'], widenings)
                migration_cells = 'typed-verified'
        elif allow_existing_browser_heartbeat:
            # Rows the services appended carry forward as below (a project's startup settings
            # save, a usage-limit check). Every auth cell except what a reconnect writes stays
            # exact through the invariant hash, and the heartbeat itself is proven separately
            # against the old non-auth rows, so neither allowance widens the other.
            appended = (carried_applies(before['rows'], after['rows'], after_carried)
                        and all('auth_sessions' in rows[key] for rows in (before['rows'], after['rows'])
                                for key in ('counts', 'hashes'))
                        and auth_comparison(before['rows'], after['rows']) != after['rows'])
            if appended:
                assert same_guarded_rows(before['rows'], after['rows'], after_carried), \
                    'Existing projects, history or auth rows changed'
                heartbeat_after = auth_comparison(before['rows'], after['rows'])
            else:
                heartbeat_after = after['rows']
            heartbeat = prove_restart_heartbeat(before['rows'], heartbeat_after, original_auth, current_auth,
                                                restart_started_at, after['observedAt'], identity=identity, web_session_policy=policy)
        else:
            # Rows the old service appended before it stopped, or the new one appended since,
            # carry forward; auth stays byte-exact here (heartbeats need their own proof).
            assert same_guarded_rows(before['rows'], after['rows'], after_carried, auth_heartbeat=False), \
                'Existing projects, history or auth rows changed'
        database_continuity = 'not-compared-migration' if allow_project_migrations else 'not-captured'
        if not allow_project_migrations and 'databaseCapture' in before:
            # Every table and the schema must be unchanged. Only a proven heartbeat may differ,
            # and only in auth_sessions; without one, rows the services appended carry forward
            # under the same allowance as the guarded rows above.
            assert 'databaseCapture' in after, 'Complete database proof missing after restart'
            if heartbeat is not None and appended:
                allowance = database_allowance(before['rows'], after['rows'], after_carried, auth_heartbeat=False)
                continuity.assert_database_continuity(before['databaseCapture']['summary'], after['databaseCapture']['summary'],
                                                      original_auth, current_auth,
                                                      carried_tables=allowance['tables'],
                                                      log_prefixes=allowance['logPrefixes'])
            elif heartbeat is not None:
                continuity.assert_database_continuity(before['databaseCapture']['summary'], after['databaseCapture']['summary'],
                                                      original_auth, current_auth)
            else:
                assert_capture_carried(before['databaseCapture'], after['databaseCapture'], before['rows'], after['rows'],
                                       after_carried, auth_heartbeat=False, message='Complete preexisting database changed')
            database_continuity = 'verified'
        if 'otherListenersOwned' in before:
            assert after.get('otherListenersOwned') is False, 'Updated service took another service\'s port'
        else:
            assert after['otherListeners'] == before['otherListeners']
        assert after['cookieName'] == before['cookieName']
        assert after['fileHashes']['environment'] == before['fileHashes']['environment'], 'Environment identity changed after restart'
        assert after['fileHashes']['plist'] == (digest(new_plist) if new_plist is not None else before['fileHashes']['plist']), \
            'Service LaunchAgent changed after restart'
        # A release may rewrite settings.json once on start (a one-time migration); the values
        # the user set must survive it. Environment identity and the LaunchAgent stay exact.
        settings_continuity_report = settings_preserved(before, after)
        lap('guardedComparison')
        result = {'phase': 'verified', 'before': before, 'after': after, 'backup': str(backup), 'cliAlias': progress['cliAlias'], 'preservedRowsAuthAndIdentity': True, 'originalServicesPreserved': True,
                  'onlyKnownOwnedServiceRestarted': True, 'startupBootstrap': False, 'inferenceExecuted': False,
                  'restartStartedAt': restart_started_at, 'rowsByteIdentical': before['rows'] == after['rows'],
                  'rowPreservation': 'verified-migration' if allow_project_migrations and before['rows'] != after['rows']
                                     else 'verified-appended-activity-and-heartbeat' if heartbeat and appended
                                     else 'verified-existing-browser-heartbeat' if heartbeat
                                     else 'verified-appended-activity' if before['rows'] != after['rows'] else 'byte-identical',
                  'completeDatabaseContinuity': database_continuity,
                  'settingsContinuity': settings_continuity_report,
                  'prunedStateBackups': progress['prunedStateBackups']}
        if migration_cells is not None:
            result['migrationProtectedCells'] = migration_cells
        if widenings:
            # Names only: which protected tables gained which empty columns.
            result['migrationAddedColumns'] = {table: [column[1] for column in widening['added']]
                                               for table, widening in sorted(widenings.items())}
        if 'serviceLaunchAgent' in progress:
            result['serviceLaunchAgent'] = progress['serviceLaunchAgent']
        if 'serverBrowserStop' in progress:
            result['serverBrowserStop'] = progress['serverBrowserStop']
        if 'cliAliasKeptAside' in progress:
            result['cliAliasKeptAside'] = progress['cliAliasKeptAside']
        if after_carried is not None:
            # Counts only: how many log rows the services appended after the prestate.
            result['appendedLogRows'] = after_carried['appendedRows']
        if heartbeat is not None:
            result['authHeartbeatWitness'] = heartbeat
            # Which existing sessions reconnected during the restart (no ids or credentials).
            result['authHeartbeatSessions'] = heartbeat.get('sessions') or [
                {'kind': 'existing-web-session', 'rows': heartbeat['changedRows']}]
        # Old unpacked releases are ~340 MB each; keep the new and rollback ones.
        try:
            result['prunedReleases'] = prune_releases(home, [new_release, old_release])
        except Exception as error:  # Pruning never fails a verified update.
            result['prunedReleases'] = []
            result['pruneError'] = type(error).__name__
        # The new release's update agent replaces an older one, as the desktop installs its own: a Mac
        # whose desktop app is old or never opened kept its first agent otherwise. Never fails the update.
        result['updateAgent'] = update_request.refresh_agent(home, identity, new_release)
        finish('cleanup')
        result['timings'] = timings
        output.write_text(json.dumps(result, indent=2) + '\n')
        progress_file.finish('verified', timings)
        print(json.dumps({'identity': identity, 'result': 'updated', 'archiveSha256': archive_sha, 'servicePid': after['servicePid'], 'report': str(output)}))
    except BaseException as error:
        lap('untilFailure')  # The phase that failed, up to the failure.
        progress_file.rollback()
        if restart_requested and not service_started:
            # launchd refused the job or did not answer: the new release may run only if it is loaded.
            restart_requested = service_started = job_loaded(domain, before['serviceLabel'])
        failure = {**progress, 'result': 'update-failed', 'rollback': 'held-for-safe-review',
                   'error': describe_error(error), 'attemptedAfter': after}
        if restart_requested:
            failure['pointers'] = 'new-release'  # Until a rollback step below switches them.
        output.write_text(json.dumps(failure, indent=2) + '\n')
        # A failed proof never authorizes killing native work that appeared meanwhile.
        try:
            plist = home / 'Library/LaunchAgents' / (before['serviceLabel'] + '.plist')
            assert digest(plist.read_bytes()) in plist_hashes
            if restart_requested:
                try:
                    owned = snapshot(identity)  # Exact current owned PID/release + idle before any rollback stop.
                except (AssertionError, OSError, sqlite3.Error, subprocess.TimeoutExpired):
                    # A rejected kickstart may leave the exact original process alive. Restore
                    # only our pointers; this path never restarts or stops that process.
                    runtime = json.loads((own / 'userdata/server-runtime.json').read_text())
                    assert runtime['pid'] == before['servicePid'] and runtime['host'] == '127.0.0.1' and runtime['port'] == port
                    live = run(['/bin/launchctl', 'print', domain + '/' + before['serviceLabel']], text=True)
                    assert re.search(r'^\s*pid = ' + str(before['servicePid']) + r'\s*$', live, re.M) and 'path = ' + str(plist) in live
                    command = run(['/bin/ps', '-p', str(before['servicePid']), '-o', 'command='], text=True)
                    assert receipt['node'] in command and old_release + '/bin.mjs' in command
                    assert listeners(port) == [before['servicePid']]
                    owned = None
            else:
                owned = None  # Restore our CAS-owned pointers without stopping the existing process.
            for name, path, original in [('launch.sh', own / 'launch.sh', old_bytes['launch.sh']),
                                         ('wrapper', wrapper, old_wrapper),
                                         ('installation.json', own / 'installation.json', old_bytes['installation.json'])]:
                assert path.read_bytes() in {original, new_bytes[name]}, 'A pointer changed outside this operation'

            def restore_old_pointers():
                # Until all three are written, a failure leaves a mix the backup resolves.
                failure['pointers'] = 'mixed-see-backup'
                atomic(own / 'launch.sh', old_bytes['launch.sh'], 0o700)
                atomic(wrapper, old_wrapper, 0o700)
                atomic(own / 'installation.json', old_bytes['installation.json'], 0o600)
                failure['pointers'] = 'previous-release'
                # The identity pointers are back first; the alias follows only while it holds
                # what this update left there.
                if manage_alias:
                    alias_report = {}
                    failure['cliAlias'] = restore_cli_alias(alias, old_alias, new_bytes['wrapper'], alias_report)
                    if 'keptAside' in alias_report:
                        failure['cliAliasKeptAside'] = alias_report['keptAside']
                output.write_text(json.dumps(failure, indent=2) + '\n')

            if owned:
                # The new release is running and may have migrated the database. Every check
                # comes first, while the pointers still name that release: a failed check then
                # leaves the running release, its pointers and its database consistent.
                failure['pointers'] = 'new-release'
                failure['rollback'] = 'held-new-release-rollback-checks-failed'
                output.write_text(json.dumps(failure, indent=2) + '\n')
                rows_snapshot(own / 'userdata')
                live = run(['/bin/launchctl', 'print', domain + '/' + before['serviceLabel']], text=True)
                assert re.search(r'^\s*pid = ' + str(owned['servicePid']) + r'\s*$', live, re.M)
                assert digest(plist.read_bytes()) in plist_hashes, 'Verified LaunchAgent changed before rollback'
                rollback_browser_stop = {}
                try:
                    stopped = assert_quiescence(owned['processQuiescence'], receipt['node'], ['/usr/bin/caffeinate', '-s', str(own / 'launch.sh')],
                                                report=rollback_browser_stop)
                finally:
                    if rollback_browser_stop:
                        failure['rollbackServerBrowserStop'] = dict(rollback_browser_stop)
                if stopped:
                    failure['rollbackServerBrowserStop'] = stopped
                assert state_backup is not None and state_backup.is_file(), 'No state backup to roll back to'
                # The old release never starts on the migrated database: stop, restore the
                # pre-update copy, and only then point at the old release and start it.
                domain_label = domain + '/' + before['serviceLabel']
                failure['rollback'] = 'held-new-release-stopping'
                output.write_text(json.dumps(failure, indent=2) + '\n')
                run(['/bin/launchctl', 'bootout', domain_label], timeout=60)
                try:
                    wait_for_stopped(owned['servicePid'], port=port)
                    restore_state(state_backup, own)
                except BaseException:
                    # Keep the new release with the database it migrated rather than mixing
                    # them; its pointers were never switched.
                    run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=60)
                    failure['rollback'] = 'held-new-release-state-restore-failed'
                    output.write_text(json.dumps(failure, indent=2) + '\n')
                    raise
                try:
                    restore_old_pointers()
                except BaseException:
                    # The pre-update database is back, so either release may start on it; the
                    # new one re-applies its migrations. Name it again rather than leave a mix,
                    # and start the service whatever happens.
                    try:
                        atomic(own / 'launch.sh', new_bytes['launch.sh'], 0o700)
                        atomic(wrapper, new_bytes['wrapper'], 0o700)
                        atomic(own / 'installation.json', new_bytes['installation.json'], 0o600)
                        failure['pointers'] = 'new-release'
                        if manage_alias and repoint_cli_alias(alias, failure.get('cliAlias'), old_alias, new_bytes['wrapper']):
                            failure['cliAlias'] = progress['cliAlias']
                    except OSError:
                        failure['pointers'] = 'mixed-see-backup'
                    finally:
                        run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=60)
                    failure['rollback'] = 'held-new-release-pointer-restore-failed'
                    output.write_text(json.dumps(failure, indent=2) + '\n')
                    raise
                run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=60)
                failure['rollback'] = 'restored-runtime-pointers-and-state'
                failure['stateDeltaRetained'] = False
            else:
                try:
                    restore_old_pointers()
                finally:
                    # Stopped for the copy, then the stop, the copy or the start failed: nothing of the
                    # new release ran, so the old one starts again on its untouched database, once
                    # its launcher is back (it alone names the release that starts).
                    if service_stopped and not service_started:
                        restart_old_release(failure, state_backup, lambda: job_loaded(domain, before['serviceLabel']),
                                            (own / 'launch.sh').read_bytes() == old_bytes['launch.sh'],
                                            lambda: run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=60),
                                            discard_unused_backup)
                failure['rollback'] = 'restored-exact-owned-runtime-pointers'
                # No state/auth/config migration is undone by a pointer rollback.
                failure['stateDeltaRetained'] = True
            finish('rollback')
            output.write_text(json.dumps(failure, indent=2) + '\n')
        except (AssertionError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as rollback_error:
            # Retain the failed receipt and leave active or unverified services untouched;
            # the receipt names the check that stopped the rollback.
            failure['rollbackError'] = describe_error(rollback_error)
            finish('rollback')
            try:
                output.write_text(json.dumps(failure, indent=2) + '\n')
            except OSError:
                pass
        progress_file.finish(install_progress.result_of(failure), timings)
        raise
    finally:
        clear_install_gate(own, home)

# Refusals the next snapshot may not repeat: processes or the database moved while being read,
# or a process listed by ps exited before the kernel read of it.
BUSY_REFUSALS = {'Owned process identities changed during inventory', 'Owned service process identity changed'} | VANISHED_READS

def _refusal_detail(code, own):
    """Counts or names for a refusal, read again after the failed check; '' when unreadable."""
    try:
        if code == 'native-work':
            counts = native_work_counts(own / 'userdata')
            return ' '.join('%s=%d' % (key, counts[key]) for key in ('runs', 'queued', 'requests', 'effects', 'sessions', 'held'))
        pid = json.loads((own / 'userdata/server-runtime.json').read_text())['pid']
        return descendant_names(int(pid), read_processes())
    except Exception:
        return ''

def refusal_line(identity, error):
    """`REFUSAL <code> <detail>` for a refused snapshot, read by the update agent. Codes:
    native-work, descendants, timeout, busy, restart-needed and environment. Details are counts,
    executable basenames or this helper's own fixed messages: never argv, paths, rows or secrets."""
    message = str(error) if isinstance(error, AssertionError) else ''
    if message in DATABASE_RESTART_REASONS:  # Only a restart recovers it (database_restart).
        return database_restart.refusal(DATABASE_RESTART_REASONS[message])
    if isinstance(error, subprocess.TimeoutExpired):
        command = error.cmd if isinstance(error.cmd, (list, tuple)) else [error.cmd]
        return 'REFUSAL timeout ' + _name(command[0] if command else 'check')
    if message == 'Native work is not idle' or 'descendants' in message:
        code = 'native-work' if message == 'Native work is not idle' else 'descendants'
        own = studio_paths.identity_home(pathlib.Path.home().resolve(), identity)
        return ('REFUSAL %s %s' % (code, _refusal_detail(code, own))).rstrip()
    if isinstance(error, sqlite3.OperationalError) or message in BUSY_REFUSALS:
        return 'REFUSAL busy ' + type(error).__name__
    if isinstance(error, AssertionError):
        detail = message if re.fullmatch(r"[A-Za-z0-9 .,;:'()_-]{1,200}", message) else 'A Studio installation check failed'
    elif isinstance(error, sqlite3.DatabaseError):
        # SQLite's own fixed text ("database disk image is malformed", "file is not a database").
        reason = str(error) if re.fullmatch(r'[a-z ]{1,80}', str(error)) else type(error).__name__
        detail = 'The SpecWithCode database could not be read (%s)' % reason
    elif isinstance(error, (OSError, ValueError, KeyError, TypeError)):
        detail = 'A Studio installation file is missing or malformed (%s)' % type(error).__name__
    else:
        detail = 'Unexpected snapshot failure (%s)' % type(error).__name__
    return 'REFUSAL environment ' + detail

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--identity', required=True)
    parser.add_argument('--snapshot', type=pathlib.Path)
    parser.add_argument('--reap', type=pathlib.Path, help='Stop the processes left beneath the service; write the record here')
    parser.add_argument('--request', help='With --reap: the forced install request (installRequestedAt) it serves')
    parser.add_argument('--prestate', type=pathlib.Path)
    parser.add_argument('--archive', type=pathlib.Path)
    parser.add_argument('--sha256')
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--allow-project-migrations', action='store_true',
                        help="Accept the new release's migrations: added tables and rebuilt projections, nothing lost")
    parser.add_argument('--allow-existing-browser-heartbeat', action='store_true',
                        help='Prove bounded existing web and desktop reconnects under the installation web-session policy')
    args = parser.parse_args()
    if args.reap:
        assert not args.snapshot and not args.prestate and args.request and not os.path.lexists(str(args.reap))
        record = {}
        try:
            reap(args.identity, args.request, record)
        except Exception as error:
            record.update(result='failed', error=refusal_line(args.identity, error)[len('REFUSAL '):])
            raise
        finally:  # Whatever was signalled is recorded, even when the reap stopped part way.
            record.setdefault('observedAt', datetime.datetime.now(datetime.timezone.utc).isoformat())
            args.reap.write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'identity': args.identity, 'result': 'reaped', 'signals': len(record['signals']),
                          'survivors': len(record['survivors'])}))
    elif args.snapshot:
        assert not args.snapshot.exists()
        try:
            value = snapshot(args.identity)
        except Exception as error:
            traceback.print_exc()
            print(snapshot_refusal(args.identity, error), file=sys.stderr, flush=True)
            sys.exit(1)
        args.snapshot.write_text(json.dumps(value, indent=2) + '\n')
        print(json.dumps({'identity': args.identity, 'result': 'snapshotted', 'report': str(args.snapshot), 'servicePid': value['servicePid']}))
    else:
        assert args.prestate and args.archive and args.sha256 and args.output and not args.output.exists()
        try:
            assert re.fullmatch('[a-f0-9]{64}', args.sha256), 'The archive sha256 is not 64 lowercase hex characters'
            apply(args.identity, json.loads(args.prestate.read_text()), args.archive.resolve(strict=True), args.sha256, args.output,
                  allow_existing_browser_heartbeat=args.allow_existing_browser_heartbeat,
                  allow_project_migrations=args.allow_project_migrations)
        except BaseException as error:
            write_preflight_failure(args.output, args.identity, error)
            raise

if __name__ == '__main__': main()
