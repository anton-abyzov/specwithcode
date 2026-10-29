#!/usr/bin/env python3
"""CAS-guarded updates of exact, idle Studio services; never adopts another service."""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import argparse
import contextlib
import copy
import datetime
import errno
import hashlib
import json
import os
import pathlib
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
                      swap_cli_alias, restore_cli_alias, repoint_cli_alias)
from release_policy import validate_upgrade
from release_check import release_manifest, release_verified
import release_check
from auth_heartbeat import (bind_auth, encoded, prove_restart_heartbeat,
                            read_auth_sessions_in_transaction, restore_witness, rows_hash,
                            utc_timestamp, verify_restart_witness)
from quiescence import (SERVICE_EXITED, VANISHED_READS, capture_quiescence, assert_quiescence, quiescence_core, read_processes,
                        reap_descendants, idle_providers, idle_provider_trees, started_before)
from release_retention import held_state_backups, prune_releases, prune_state_backups, prune_update_leftovers
import after_proof
import update_apply
import database_continuity as continuity
import database_restart
import idle_agents
import install_progress
import live_database
import read_delta
import read_watermark
import settings_continuity
import state_backup_prune
from update_receipt import describe_error, write_preflight_failure
from update_read import (TERMINAL_RUNS, _queue_held, run_work, AUTHORITY_TABLES, _read_state, _read_tables,
                         assert_idle, SINGLE_SCAN_SQLITE, ORDINARY_TABLE, virtual_tables, guarded_hashes,
                         guarded_rows, ACTIVITY_KEY, LOG_TABLES, STREAM_COLUMNS, CURSOR_COLUMNS, encoded_row,
                         rows_digest, table_columns, stream_key, has_rowid, stream_column,
                         append_only_activity, activity_digest, valid_activity, rowid_is_a_column,
                         has_covering_index, log_prefixes, carried_since, AUTH_INVARIANT_KEY,
                         AUTH_HEARTBEAT_COLUMN, AUTH_APP_VERSION_COLUMN, auth_invariant_hash,
                         is_projection_table, carried_applies, log_rows_carried)
from update_migration import (_column_definition, accepted_widenings, narrowed_rows, principal_auth, assert_migration_preserved,
                              auth_comparison, typed_auth_rows, typed_auth_rows_hash, verify_migration_heartbeat_witness,
                              heartbeat_window_start, prove_migration_preserved, assert_migration_typed_cells,
                              assert_migration_protected_schema)
from update_compare import (rows_carried_forward, same_guarded_rows, database_allowance, assert_capture_carried, without_auth, same_auth,
                            auth_since, guarded_row_counts, settings_preserved)
from update_service import (OTHER_SERVICE_PORTS, service_owns_listener, HOLD_REFUSAL, _utc, assert_held,
                            restart_old_release, native_work_counts, _name, descendant_names, gate_settle)
from state_backup import (_clonefile, clone_file, BACKUP_SPACE_MARGIN, assert_backup_space, assert_clone_headroom, backup_space, backup_space_needed, backup_state,
                          clone_state, discard_unused_backup, write_private as _write_private)
from service_handles import (LSOF_ATTEMPTS, LSOF_TIMEOUT_SECONDS, DATABASE_FILES, DETACHED_DATABASE, LOCKS_LOST, listeners,
                             open_inodes, assert_database_attached, assert_database_locked)
from service_launch_agent import upgraded_service_plist
import managed_updates
import studio_paths
import update_request

from installation_descriptor import InstallationDescriptor, cli_paths, current_owner, installation_lock, owned_path, validate_identity, web_session_policy
def digest(value):
    return hashlib.sha256(value).hexdigest()

@contextlib.contextmanager
def scratch_directory(prefix, parent):
    """tempfile.TemporaryDirectory whose cleanup never fails an update. Finder can write .DS_Store
    into a folder while it is removed (ENOTEMPTY failed a 1.0.112 install after the release was
    published); prune_update_leftovers removes whatever is left on the next verified update."""
    path = tempfile.mkdtemp(prefix=prefix, dir=str(parent))
    try:
        yield path
    finally:
        for attempt in range(3):
            try:
                shutil.rmtree(path)
                break
            except FileNotFoundError:
                break
            except OSError as error:
                if attempt == 2:
                    print(f'Left {path} for the next prune: {error}', file=sys.stderr)
                else:
                    time.sleep(0.2)

def safe_path(path, home):
    return owned_path(path, home)

def run(command, timeout=10, **kwargs):
    value = subprocess.run(command, capture_output=True, timeout=timeout, **kwargs)
    assert value.returncode == 0, 'Owned operation failed; arbitrary command output withheld'
    return value.stdout

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

def _service(identity):
    """The verified installation and its running service: receipt, LaunchAgent, launcher,
    runtime record, port owner and executable. Reads no database (release_check.service)."""
    return release_check.service(identity, run, listeners, release_verified)

# The service process a snapshot started from exited (stopped, booted out, restarted) before its
# proof. Not an install failure: no pointer moved. The message starts with 'Guarded prestate
# changed' (the service pid is guarded prestate) because update_agent_recovery retries only
# receipts whose error starts with one of update_agent.RETRYABLE_REFUSALS: refusal_proof for an
# automatic install, refused_before_restart (a substring match) for Install now.
SERVICE_RESTARTED = ('Guarded prestate changed: the SpecWithCode service restarted during the update check; '
                     'the update will retry')

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
    def service_quiescence():
        try:
            return capture_quiescence(runtime['pid'], service['owner'].uid, str(node), content['ProgramArguments'])
        except AssertionError as error:
            # The recorded process is gone. Rows read from it prove nothing about a successor,
            # so this snapshot refuses; the next one starts over from the new runtime record.
            if str(error) == SERVICE_EXITED:
                raise AssertionError(SERVICE_RESTARTED) from error
            raise
    try:
        assert_database_attached(runtime['pid'], own / 'userdata')
        assert_database_locked(own / 'userdata')
    except AssertionError as error:
        # An exited service holds no SQLite locks (and lsof lists no files for its pid), so a
        # service that stopped after _service read its record fails here first. That is the
        # same restart as one during the read, not a database that needs a restart: only when
        # the recorded process is gone. A live service that lost its locks still refuses so.
        if str(error) in DATABASE_RESTART_REASONS:
            try:
                service_quiescence()
            except AssertionError as gone:
                if str(gone) == SERVICE_RESTARTED:
                    raise gone from error
        raise
    if reads is None:  # Stray descendants refuse before the full read, not minutes after it; the proof's capture follows it.
        service_quiescence()
    rows, auth, carried, database = reads or _read_state(own / 'userdata', include_auth, since, True, widen_from)
    other = {str(port): listeners(port) for port in OTHER_SERVICE_PORTS if port != receipt['port']}
    owned, process_quiescence = service_owns_listener(other, runtime['pid'], read_processes()), service_quiescence()
    proof = {'schemaVersion': 1, 'identity': identity, 'uid': service['owner'].uid, 'port': receipt['port'], 'webSessionPolicy': service['owner'].policy, 'serviceLabel': label, 'servicePid': runtime['pid'],
            'archiveSha256': receipt['archiveSha256'], 'artifactSourceCommit': receipt['sourceCommit'],
            'fileHashes': file_hashes,
            # Key paths and value hashes only, so a restart that rewrites settings.json can be
            # proven to keep every user value (see settings_continuity) without storing any.
            'settingsProof': settings_continuity.settings_proof(contents['settings']),
            'rows': rows, 'databaseCapture': database, 'otherListeners': other, 'otherListenersOwned': owned,
            'cookieName': receipt['cookieName'],
            'processQuiescence': process_quiescence,
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    return proof, auth, carried

def snapshot(identity, request=None):
    if request is None:
        return _snapshot(identity, False)[0]
    # Update now already holds this service. The helper's apply takes the full baseline;
    # the agent needs only admission, identity and idle evidence, not a duplicate row hash.
    service = _service(identity)
    try:
        assert_held(service, request)
    except (AssertionError, OSError, ValueError, TypeError):
        # A forced CLI request need not have a service hold. Its original full
        # snapshot remains safe; only a proven matching hold permits the shortcut.
        return _snapshot(identity, False)[0]
    db = live_database.connect(service['own'] / 'userdata' / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        assert_idle(db)
    finally:
        db.close()
    proof = _snapshot(identity, False, reads=({'nativeWorkIdle': True, 'counts': {}}, None, None, None))[0]
    current = _service(identity)
    assert current['runtime']['pid'] == proof['servicePid'] == service['runtime']['pid'], HOLD_REFUSAL
    assert_held(current, request)
    proof.pop('databaseCapture')
    proof.update(snapshotMode='held-service', installRequestedAt=request)
    return proof

def reap(identity, request, report=None, stale=False):
    """Update now's fallback when a held service never quiets: stop the processes left beneath
    the verified service (quiescence.reap_descendants), by pid and only after proving each
    one's identity, and only while that service is held for `request` (assert_held, checked
    first and again before every signal). The service, its supervisor and its server browser
    keep running, so its update hold stays in place. Changes no file. `stale` (the agent's early
    reap) stops only what started before the hold began, with nothing started since beneath it
    (quiescence.started_before), and only while native_work_counts, the one database read here,
    shows no work, first and before every signal.
    `report` (optional) holds the record as it is built, for a failed reap's record."""
    report = {} if report is None else report
    report.update(schemaVersion=1, identity=identity, result='refused', stale=stale)
    service = _service(identity)
    pid = service['runtime']['pid']
    report['servicePid'] = pid
    began = assert_held(service, request)

    def idle():  # The early reap's own check, first and again before every signal.
        assert not stale or idle_agents.idle(native_work_counts(service['own'] / 'userdata')), 'Native work is not idle'
    idle()
    reap_descendants(pid, service['owner'].uid, str(service['node']), service['content']['ProgramArguments'], report=report,
                     guard=lambda: (assert_held(service, request), idle()),
                     select=started_before(began.timestamp()) if stale else None)
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
    return database_restart.wait_for_owner(database_restart.Names(globals()), identity, old_pid, deadline)

def database_restart_refusal(identity, error, report=None, now=None, request=None):
    """database_restart.restart_refusal over this module's checks; `request` is the explicit
    request the snapshot serves (--request), which alone may stop a service on a deleted log."""
    return database_restart.restart_refusal(database_restart.Names(globals()), identity, error, report, now, request)

def snapshot_refusal(identity, error, request=None):
    """The REFUSAL line for a refused snapshot: a fallback's (database restart, idle agents)
    when one applies."""
    for fallback in (lambda: database_restart_refusal(identity, error, request=request),
                     lambda: idle_agent_refusal(identity, error)):
        try:
            line = fallback()
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

def assert_prestate(expected, actual, carried=None, auth_baseline=None):
    """The agent's prestate against this helper's reads, before anything is written. With
    `auth_baseline` (the rows of this helper's own before read), auth sessions are compared with
    that read instead of the agent's: a sign-in, a CLI session or `service prepare-update` adds a row
    the hold does not stop, and between the agent's read and the helper's it failed the first
    attempt of five releases. The proof across the restart starts from the helper's read and auth
    cells, so an auth change after it still refuses here, before the restart."""
    for key in ['identity', 'uid', 'serviceLabel', 'servicePid', 'archiveSha256', 'artifactSourceCommit', 'fileHashes', 'rows', 'otherListenersOwned', 'cookieName', 'processQuiescence']:
        if key == 'rows' and auth_baseline is not None:
            same = (same_guarded_rows(without_auth(expected[key]), without_auth(actual[key]), carried)
                    and same_auth(auth_baseline, actual[key]))
        elif key == 'rows':
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
        if auth_baseline is not None:  # Auth was compared with the baseline above.
            assert_capture_carried(expected['databaseCapture'], actual['databaseCapture'],
                                   without_auth(expected['rows']), without_auth(actual['rows']), carried, auth_free=True)
        else:
            assert_capture_carried(expected['databaseCapture'], actual['databaseCapture'],
                                   expected['rows'], actual['rows'], carried)
    assert actual['rows']['nativeWorkIdle'] is True

# Bound on waiting for the restarted service (see apply). With a full rollback (bootout,
# stop wait, restore, bootstrap) it stays under the update agent's APPLY_TIMEOUT.
READINESS_DEADLINE_SECONDS = 300
# How long the agent waits for this helper (update_agent.py APPLY_TIMEOUT). Agents that predate
# the variable allow 900 s, 1.0.4x-1.0.112 agents pass 1500 s and newer ones 2400 s, so a loaded
# Mac with a large database still gets the full readiness wait after slow reads and staging.
# Everything here ends within this budget, so the agent never stops waiting mid-apply.
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
# With a budget beyond the old 900 s the restart always keeps the full readiness wait; the
# pre-restart work then gets budget - 720 s (780 s at 1500, 1680 s at 2400).
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

# The database snapshot marker (apps/server/src/persistence/StorageMaintenance.ts). The service
# deletes superseded events every few hours; an earlier event deleted between a snapshot and the
# checks after the restart reads as a changed log row and refuses the update. Every snapshot
# writes this file first, and every apply refreshes it and removes it when it ends, so the
# service's compaction waits for whatever runs update.py: the update agent, an install request
# or remote_update.py, held or not. A marker no apply removed lapses after
# SNAPSHOT_MARKER_MAX_SECONDS, which covers the longest apply. A marker that was not live
# already is followed by SNAPSHOT_MARKER_SETTLE_SECONDS: the service reads it at most once a
# second (StorageMaintenance GATE_CACHE_MS), so a delete it started just before is committed
# before the snapshot reads; the service also reads it again right before each delete, which is
# one short page. A snapshot that fails takes its marker back (release_database_snapshot).
# Best effort: without the marker an update can only refuse.
SNAPSHOT_MARKER_FILE = 'database-snapshot.json'
SNAPSHOT_MARKER_MAX_SECONDS = 2 * 3600
SNAPSHOT_MARKER_SETTLE_SECONDS = 2

def snapshot_marker_path(identity, own=None, home=None):
    if own is None or home is None:
        owner = InstallationDescriptor(identity, require_policy=False)
        own, home = owner.own, owner.home
    return safe_path(own / 'updates' / SNAPSHOT_MARKER_FILE, home)

def snapshot_marker_live(path, now=None):
    try:
        at = datetime.datetime.fromisoformat(json.loads(path.read_text())['at'].replace('Z', '+00:00'))
    except (OSError, ValueError, AttributeError, TypeError, KeyError):
        return False
    if at.tzinfo is None:
        return False
    age = ((now or datetime.datetime.now(datetime.timezone.utc)) - at).total_seconds()
    return -60 <= age < SNAPSHOT_MARKER_MAX_SECONDS

def mark_database_snapshot(identity, settle=True, own=None, home=None):
    """Writes the marker; waits SNAPSHOT_MARKER_SETTLE_SECONDS when it was not live already.

    Returns what release_database_snapshot needs to undo this call (the marker's path and the
    live marker it replaced, if any), or None when nothing was written."""
    try:
        path = snapshot_marker_path(identity, own, home)
        live = snapshot_marker_live(path)
        previous = path.read_bytes() if live else None
        path.parent.mkdir(mode=0o700, exist_ok=True)
        value = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pid': os.getpid()}
        atomic(path, (json.dumps(value) + '\n').encode(), 0o600)
    except Exception as error:  # Never a refusal: compaction during an update only refuses it.
        print('database snapshot marker not written: %s' % error, file=sys.stderr, flush=True)
        return None
    if settle and not live:
        time.sleep(SNAPSHOT_MARKER_SETTLE_SECONDS)
    return (path, previous)

def release_database_snapshot(written):
    """Undoes a mark_database_snapshot whose snapshot failed. Never raises.

    The agent retries a refused snapshot every few minutes, so a marker left behind would never
    lapse and would stop compaction for good. A live marker this call refreshed (another
    update.py's) gets its own content back; one this call created is removed."""
    if written is None:
        return
    path, previous = written
    try:
        if previous is None:
            path.unlink()
        else:
            atomic(path, previous, 0o600)
    except Exception:
        pass

def clear_database_snapshot(identity, own=None, home=None):
    """Never raises."""
    try:
        snapshot_marker_path(identity, own, home).unlink()
    except Exception:
        pass

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
        # The prestate was taken under the marker; keep compaction off until this apply ends.
        mark_database_snapshot(identity, settle=False, own=own, home=owner['home'])
        try:
            with guard, install_progress.ProgressWriter(safe_path(own / 'updates', owner['home']), receipt=output) as progress_file, \
                    contextlib.closing(read_watermark.Watermark.open(own / 'userdata' / 'statev2.sqlite')) as watermark:
                return _apply(identity, expected, archive, archive_sha, output,
                              allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,
                              allow_project_migrations=allow_project_migrations, progress_file=progress_file, watermark=watermark)
        finally:
            clear_database_snapshot(identity, own, owner['home'])

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
    held_snapshot = expected.get('snapshotMode') == 'held-service'
    assert expected.get('snapshotMode') in (None, 'held-service'), 'Unknown snapshot mode'
    if held_snapshot:
        assert_held(_service(identity), expected.get('installRequestedAt'))
    page_mode = update_apply.PageMode.prepare(database_restart.Names(globals()), identity, expected, allow_existing_browser_heartbeat)
    position = read_delta.position(own / 'userdata' / 'statev2.sqlite')
    # Its lines, for the proof after the restart, kept on disk only while the backup's space is left.
    with after_proof.keeping(own / 'userdata' / 'statev2.sqlite', backup_space_needed(own, home, _clonefile())[0]) as kept:
        before, original_auth, carried = (page_mode.snapshot() if page_mode else
            snapshot_since(identity, None if held_snapshot else expected['rows'], capture_auth))
    if held_snapshot:
        service = _service(identity)
        assert service['runtime']['pid'] == before['servicePid'], HOLD_REFUSAL
        assert_held(service, expected.get('installRequestedAt'))
        # Only database evidence is rebased. Every identity, pointer, file and process
        # comparison against the agent's admission still runs below.
        expected = {**expected, 'rows': before['rows']}
        if 'databaseCapture' in before: expected['databaseCapture'] = before['databaseCapture']
    # One base per log position appended rows are measured against: the agent's snapshot
    # (the prestate check) and this read itself (the checks after the gate). Measured against
    # its own rows, this read appended nothing after them, so it carries nothing (None): the
    # rows a later re-read returns must then match `before` exactly but for auth sessions, as
    # they do whenever read_delta returns.
    base = {'expected': {'position': position, 'since': expected['rows'],
                         'reads': (before['rows'], carried, before.get('databaseCapture'))},
            'before': {'position': position, 'since': before['rows'],
                       'reads': (before['rows'], None, before.get('databaseCapture'))}}
    delta_misses = []  # Why each re-read since the last exact read went to a full read.
    def delta_since(since_key, since):
        """(position, reads): the -wal position, taken before this re-read, and the re-read of only
        what committed since the last exact read, or None when a full read must decide."""
        position = read_delta.position(own / 'userdata' / 'statev2.sqlite')
        if page_mode:
            page_mode.held()
            rows, _ = page_mode.read()
            return position, (rows, None, None)
        why = {}
        try:
            reads = read_delta.reread(own / 'userdata', base[since_key], since, why=why)
        except (OSError, sqlite3.Error) as error:  # The full read meets the same fault and decides.
            reads, why = None, {'reason': 'read-failed', 'error': type(error).__name__}
        if reads is not None:
            lap('deltaRead')
        else:
            delta_misses.append({'against': since_key, **why})
        return position, reads
    restart_started_at = heartbeat_window_start(
        read_opened_at, datetime.datetime.now(datetime.timezone.utc).isoformat(), original_auth)
    assert_prestate(expected, before, carried, auth_baseline=before['rows'])
    # Without migrations, a heartbeat proof compares existing sessions: refuse before any write.
    assert allow_project_migrations or not allow_existing_browser_heartbeat or original_auth is not None, \
        'Restart heartbeat proof requires the auth sessions table'
    lap('beforeRead')
    # Old clones grow toward the database's size. A verified update prunes them after it exits
    # (state_backup_prune), not while the service is held; copies a failed or hand-run update left
    # go here, which removes nothing after a verified update.
    agent_run = state_backup_prune.agent_receipt(home, identity, output)
    try:
        pruned_state_backups, prune_error = prune_state_backups(
            home, keep=held_state_backups(own), keep_newest=state_backup_prune.KEPT_AFTER_INSTALL if agent_run else 1), None
    except Exception as error:  # Pruning never fails an update.
        pruned_state_backups, prune_error = [], type(error).__name__
    # A disk too full for the copy refuses here, before staging, a pointer or a stop. The previous
    # update's copy goes too before refusing when its files could cover the shortfall: this update
    # never restores it, unless a held rollback still names it as the only pre-migration database.
    clonefile = _clonefile()
    needed, free = backup_space(own, home, clonefile)
    if free < needed:
        # The newest older copy goes only when the others cannot cover what is short.
        dropped = []
        for keep_newest in (1, 0):
            try:
                removed = prune_state_backups(home, keep=held_state_backups(own), keep_newest=keep_newest, only_if_frees=needed - free)
            except Exception as error:
                removed, prune_error = [], prune_error or type(error).__name__
            dropped += removed
            if removed:
                needed, free = backup_space(own, home, clonefile)
                if free >= needed:
                    break
        pruned_state_backups = pruned_state_backups + dropped
        try:
            assert_backup_space(own, home, clonefile)
        except AssertionError as error:
            if not dropped:
                raise
            raise AssertionError('%s (after removing %d older update cop%s)' % (
                error, len(dropped), 'y' if len(dropped) == 1 else 'ies')) from None
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
    with scratch_directory('owned-update-stage-', incoming) as temporary:
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
        # The version gate reads only manifests: publish_release verifies every staged byte next,
        # and the old release was verified with the running service by the snapshot above.
        upgrade = release_manifest(staged_release)['version']
        validate_upgrade(release_manifest(pathlib.Path(old_release))['version'], upgrade)
        budget_left()
        # A published release is inert: no pointer names it until the check below passes, and
        # a retry reuses it (publish_release), so the prestate is checked once, before pointers.
        manifest = publish_release(staged_release, new_release)
        assert manifest['version'] == upgrade, 'The staged release changed while it was published'
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
    # A re-read here measured against `before` itself (a held request rebases `expected` on it) is
    # the read the check before the restart would take: that check reuses it while the watermark
    # shows no commit since, instead of reading the whole database a third time.
    prestate_read = None
    if unchanged_since(before_mark):  # The rows, appended rows and capture of the read above.
        current, current_carried = (page_mode.snapshot()[0] if page_mode else snapshot_reusing(identity, before, carried)), carried
    else:
        prestate_mark = watermark.take()
        position, reads = delta_since('expected', expected['rows'])
        if reads is not None:  # Only auth sessions changed: every other check of a snapshot runs.
            current_carried = reads[1]
            current = (page_mode.snapshot()[0] if page_mode else
                snapshot_reusing(identity, {'rows': reads[0], 'databaseCapture': reads[2]}, current_carried))
        else:
            current, _, current_carried = snapshot_since(identity, expected['rows'])
        base['expected'] = {'position': position, 'since': expected['rows'],
                            'reads': (current['rows'], current_carried, current.get('databaseCapture'))}
        if expected['rows'] == before['rows']:
            prestate_read = (prestate_mark, position, base['expected']['reads'])
            # The same `since` as `before`: the checks before the stop re-read only what committed
            # after this read. Against the before-read's position they would meet the commits this
            # read already proved (pages outside auth) and read the whole database once more.
            base['before'] = base['expected']
    if page_mode: page_mode.held()
    assert_prestate(expected, current, current_carried, auth_baseline=before['rows'])
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
                'prunedStateBackups': pruned_state_backups, 'agentTimings': install_progress.agent_timings(),
                'diskIoPolicy': install_progress.disk_io_policy()}
    if prune_error:
        progress['stateBackupPruneError'] = prune_error
    progress['readDeltaMisses'] = delta_misses  # The same list: later receipts carry later misses.
    progress['timings'] = timings  # The phases done when each receipt below is written.
    output.write_text(json.dumps(progress, indent=2) + '\n')
    restart_requested = False
    plist_hashes = {before['fileHashes']['plist']}  # Plus the rewritten LaunchAgent once written.
    state_backup = None
    service_stopped = service_started = False
    after = held = None
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
        progress['gateSettle'], settle = gate_settle(own, home, before['servicePid'], INSTALL_GATE_SETTLE_SECONDS)
        time.sleep(settle)
        lap('gateSettle')
        passed = [before_mark]  # Taken right before the last read (full or read_delta) that matched `before`.
        reused_prestate = [prestate_read]
        def assert_unchanged_before_restart():
            if page_mode: page_mode.held()
            if unchanged_since(passed[0]):  # That read stands: it would read the same rows again.
                return
            reusable, reused_prestate[0] = reused_prestate[0], None
            if reusable is not None and watermark.unchanged(reusable[0]):
                # The prestate re-read: the same `since`, nothing committed after it. It is checked
                # against `before` below like a fresh read.
                lap('prestateReuse')
                mark, position, (current_rows, current_carried, current_database) = reusable
            else:
                mark = watermark.take()
                position, reads = delta_since('before', before['rows'])
                if reads is None:
                    # A full read takes about as long as the before-read did: refuse now, with the
                    # old service running, when one could not finish within the budget anyway.
                    budget_left(timings.get('beforeRead', 0) / 1000)
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
        # The old log and a reader holding its snapshot through the stop, for the proof after the restart.
        reference_mark = passed[0]
        held = after_proof.mark(own / 'userdata' / 'statev2.sqlite')
        assert_unchanged_before_restart()
        after_proof.confirm(held, watermark, reference_mark, passed[0])
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
        if page_mode: page_mode.held()
        stop_service(domain, before['serviceLabel'], before['servicePid'], port)
        progress['serviceStopped'] = True
        lap('serviceStop')
        # The new release migrates the database on start; a rollback must restore both.
        state_backup, progress['stateBackupMethod'] = backup_state_clone(own, before['artifactSourceCommit'])
        held = after_proof.stopped(held, state_backup, progress['stateBackupMethod'], _clonefile())
        if page_mode: held = page_mode.stopped(held, before, original_auth, restart_started_at, policy, state_backup)
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
        # pid, release and database locks, no rows), polled until the deadline. The read the proofs below
        # need then runs once, however late: the page proof (after_proof: what the restart changed, the
        # same result) when it decides, else the full read, tried again only while it cannot be taken.
        ready_by = min(restarted_at + READINESS_DEADLINE_SECONDS, started + READY_BY_SECONDS_FROM_START)
        wait_until_answering(identity, before['servicePid'], archive_sha, manifest['sourceCommit'], ready_by)
        lap('readinessCheap')
        # Also for a release that may migrate: the page proof refuses on any schema change (the full
        # read with widen_from then decides), and with the schema unchanged it returns what that read
        # would, since a capture gains `widened` only when a table widened. Data a migration rewrites
        # is re-read as any touched table is.
        page_after = page_mode.after(held, restart_started_at, policy) if page_mode else None
        if page_mode and page_after is None:
            before, original_auth = page_mode.full_baseline(held, before)
            progress['pageFallback'] = page_mode.fallback_reason
            widen = ({'widen_from': before['databaseCapture']['schema']['columns']} if allow_project_migrations else {})
        reads = (None if page_mode else after_proof.decide(
            own / 'userdata', held, kept, base['before'], before['rows'], capture_auth, progress, lap))
        while True:
            earlier, reads = reads, None  # The page proof's read stands in once; a retry reads in full.
            try:
                if earlier is None:
                    kept.clear()  # Lines a decided proof left: a full read needs their memory.
                if page_after is not None:
                    after, current_auth, after_carried = page_after
                    page_after = None
                else:
                    after, current_auth, after_carried = _snapshot(identity, capture_auth, before['rows'], reads=earlier) \
                        if earlier else snapshot_since(identity, before['rows'], capture_auth, **widen)
                if after['servicePid'] != before['servicePid']: break
            # A process inventory that timed out twice is retried here like any other
            # not-yet-ready reading, rather than rolling back a service that is starting.
            except (AssertionError, OSError, sqlite3.Error, subprocess.TimeoutExpired): pass
            if time.monotonic() >= ready_by: break
            time.sleep(0.5)
        assert after and after['servicePid'] != before['servicePid'], \
            'Updated service did not become ready within %d s' % max(0, round(ready_by - restarted_at))
        lap('readiness')
        kept.clear()  # The decided proof's lines, let go after readiness (after_proof.decide).
        lap('keptRelease')
        assert after['archiveSha256'] == archive_sha and after['artifactSourceCommit'] == manifest['sourceCommit'], 'Updated service is not the intended artifact'
        for row_key, pointer_key in [('launcher', 'launch.sh'), ('wrapper', 'wrapper'), ('installation', 'installation.json')]:
            assert after['fileHashes'][row_key] == progress['expectedNewHashes'][pointer_key], 'Updated pointer differs from the intended artifact'
        if manage_alias and cli_alias_state(alias, {new_bytes['wrapper']})[0] != 'owned':
            # Not an identity pointer: a change made meanwhile is reported, never fatal.
            progress['cliAlias'] = 'changed-outside-left-untouched'
        if page_mode and page_mode.verdict:
            heartbeat = page_mode.validate_auth(before['rows'], after['rows'], original_auth, current_auth,
                                               restart_started_at, after['observedAt'], policy)
            appended = any(page_mode.verdict['appendedRows'].values())
            migration_cells, widenings, database_continuity = None, {}, 'verified-pages'
        else:
            heartbeat, appended, migration_cells, widenings, database_continuity = update_apply.compare(
                database_restart.Names(globals()), before, after, original_auth, current_auth, after_carried,
                restart_started_at, identity, policy, allow_project_migrations, allow_existing_browser_heartbeat)
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
                  'stateBackup': progress['stateBackup'], 'prunedStateBackups': progress['prunedStateBackups']}
        if page_mode and page_mode.verdict: page_mode.receipt(result)
        if page_mode and page_mode.fallback_reason: result['pageFallback'] = page_mode.fallback_reason
        if migration_cells is not None:
            result['migrationProtectedCells'] = migration_cells
        if widenings:
            # Names only: which protected tables gained which empty columns.
            result['migrationAddedColumns'] = {table: [column[1] for column in widening['added']]
                                               for table, widening in sorted(widenings.items())}
        result.update({key: progress[key] for key in ('serviceLaunchAgent', 'serverBrowserStop', 'cliAliasKeptAside', 'afterProof', 'agentTimings', 'diskIoPolicy', 'readDeltaMisses')
                       if key in progress})
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
        # Stage folders a killed helper left, older bundles, finished updates' receipts and owned-updates folders,
        # and, after a week, held receipts, refusal records, orphaned owned-updates and install/verification entries.
        result['prunedLeftovers'] = prune_update_leftovers(home, own, manifest['version'], keep=[output, backup])
        # The new release's update agent replaces an older one, as the desktop installs its own: a Mac
        # whose desktop app is old or never opened kept its first agent otherwise. Never fails the update.
        result['updateAgent'] = update_request.refresh_agent(home, identity, new_release)
        # Older state copies go once this helper exits; the prune adds them to prunedStateBackups.
        result['stateBackupPrune'] = state_backup_prune.spawn(identity, home, output, pathlib.Path(__file__).resolve())
        finish('cleanup')
        result['timings'] = timings
        output.write_text(json.dumps(result, indent=2) + '\n')
        progress_file.finish('verified', timings)
        print(json.dumps({'identity': identity, 'result': 'updated', 'archiveSha256': archive_sha, 'servicePid': after['servicePid'], 'report': str(output)}))
    except BaseException as error:
        lap('untilFailure')  # The phase that failed, up to the failure.
        after_proof.abandon(held, kept)  # The reader, the reference image and the kept lines, whichever exist.
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
                assert page_mode is None, 'Activated page-mode database retained: postactivation writes cannot be discarded'
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
        if page_mode: after_proof.abandon(held, kept)
        clear_install_gate(own, home)

# Refusals the next snapshot may not repeat: processes or the database moved while being read,
# or a process listed by ps exited before the kernel read of it.
BUSY_REFUSALS = {'Owned process identities changed during inventory', 'Owned service process identity changed',
                 SERVICE_EXITED, SERVICE_RESTARTED} | VANISHED_READS

def _refusal_detail(code, own):
    """Counts or names for a refusal, read again after the failed check; '' when unreadable."""
    try:
        if code == 'native-work':
            counts = native_work_counts(own / 'userdata')
            return ' '.join('%s=%d' % (key, counts[key]) for key in ('runs', 'queued', 'requests', 'effects', 'sessions', 'held'))
        pid = json.loads((own / 'userdata/server-runtime.json').read_text())['pid']
        return descendant_names(int(pid), read_processes(), str(own))
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
    parser.add_argument('--request', help='With --reap or --snapshot: the forced install request (installRequestedAt) it serves')
    parser.add_argument('--prune-state-backups', type=pathlib.Path, help="After a verified update: prune older state copies; this is its receipt")
    parser.add_argument('--stale', action='store_true', help='With --reap: only what started before the hold began')
    parser.add_argument('--prestate', type=pathlib.Path)
    parser.add_argument('--archive', type=pathlib.Path)
    parser.add_argument('--sha256')
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--allow-project-migrations', action='store_true',
                        help="Accept the new release's migrations: added tables and rebuilt projections, nothing lost")
    parser.add_argument('--allow-existing-browser-heartbeat', action='store_true',
                        help='Prove bounded existing web and desktop reconnects under the installation web-session policy')
    args = parser.parse_args()
    if args.prune_state_backups:
        state_backup_prune.announce_ready()  # Every module is loaded: the helper that started this may exit.
        state_backup_prune.background_disk_io()
        state_backup_prune.after_install(args.identity, current_owner()['home'], args.prune_state_backups)
    elif args.reap:
        assert not args.snapshot and not args.prestate and args.request and not os.path.lexists(str(args.reap))
        record = {}
        try:
            reap(args.identity, args.request, record, stale=args.stale)
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
        marker = None
        try:
            marker = mark_database_snapshot(args.identity)
            value = snapshot(args.identity, args.request)
        except Exception as error:
            release_database_snapshot(marker)
            traceback.print_exc()
            print(snapshot_refusal(args.identity, error, args.request), file=sys.stderr, flush=True)
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
