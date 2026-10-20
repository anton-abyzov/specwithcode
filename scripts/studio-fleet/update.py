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
import plistlib
import posixpath
import re
import shlex
import shutil
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
from auth_heartbeat import (bind_auth, encoded, prove_restart_heartbeat, read_auth_sessions,
                            read_auth_sessions_in_transaction, restore_witness,
                            utc_timestamp, verify_restart_witness)
from quiescence import (VANISHED_READS, capture_quiescence, assert_quiescence, quiescence_core, read_processes,
                        reap_descendants, idle_providers, idle_provider_trees)
from release_retention import prune_releases, prune_state_backups
import database_continuity as continuity
import database_restart
import idle_agents
import live_database
import settings_continuity
from service_launch_agent import upgraded_service_plist
import managed_updates
import studio_paths

from installation_descriptor import InstallationDescriptor, cli_paths, current_owner, installation_lock, owned_path, validate_identity, web_session_policy
ENV_KEYS = {'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'STUDIO_HOME',
            'STUDIO_HOST', 'STUDIO_PORT', 'STUDIO_MODE', 'STUDIO_NO_BROWSER',
            'STUDIO_LOG_LEVEL', 'STUDIO_ENABLE_HOSTED_SERVICES', 'STUDIO_DEV_ALLOWED_ORIGINS',
            'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD', 'PWDEBUG', 'PLAYWRIGHT_HTML_OPEN'}
TERMINAL_RUNS = {'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'}

def _queue_held(payload):
    """A queued run's payload says it waits in a held queue (`"queueHeld": true`)."""
    try:
        return json.loads(payload).get('queueHeld') is True
    except (TypeError, ValueError, AttributeError):
        return False

def run_work(db):
    """(statuses of the runs that are work, held queued runs). A queued run in a held queue
    (after Stop, a restart or a provider failure) starts only when someone resumes the queue,
    so it never quiets on its own: it is not work, and it stays held across the update.
    ServiceUpdatePreparation.readBlockerRows applies the same rule. A database without run
    payloads (older fixtures) counts every run."""
    columns = {row[1] for row in db.execute('PRAGMA table_info(orchestration_v2_projection_runs)')}
    if 'payload_json' not in columns:
        return [row[0] for row in db.execute('SELECT status FROM orchestration_v2_projection_runs')], 0
    statuses = [row[0] for row in db.execute(
        "SELECT status FROM orchestration_v2_projection_runs WHERE status IS NOT 'queued'")]
    held = 0
    for (payload,) in db.execute(
            "SELECT payload_json FROM orchestration_v2_projection_runs WHERE status = 'queued'"):
        if _queue_held(payload):
            held += 1
        else:
            statuses.append('queued')
    return statuses, held

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

# Sign-in sessions, pairing credentials, provider runtime and schedules: rows here grant
# access or run work, so a migration may create these tables only empty and may never add
# a trigger that touches them.
AUTHORITY_TABLES = ('auth_pairing_links', 'auth_sessions', 'provider_session_runtime',
                    'scheduled_tasks', 'scheduled_task_run_receipts')

def _read_state(state, include_auth, since=None, include_database=False, widen_from=None):
    """Protected rows, private auth, rows appended after `since` and the complete database
    capture, all measured in one read-only transaction. `widen_from` (an earlier capture's
    schema columns) also measures tables that gained columns since (accepted_widenings)."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        counts, hashes = {}, {}
        for table in tables:
            if not re.fullmatch('[a-z0-9_]+', table):
                raise AssertionError('Unexpected table identifier')
            if table.startswith(('projection_', 'orchestration_', 'project_')) or table in AUTHORITY_TABLES:
                # Hash only in memory. Never return columns, credentials, prompts or native IDs.
                rows = sorted(json.dumps(list(row), default=lambda value: value.hex(), separators=(',', ':')) for row in db.execute('SELECT * FROM ' + table))
                counts[table] = len(rows)
                hashes[table] = digest(('\n'.join(rows)).encode())
        runs = run_work(db)[0]
        requests = db.execute("SELECT count(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending'").fetchone()[0]
        # EffectOutbox.ts uses succeeded (not run-status completed). Unknown/NULL
        # values remain nonidle; retain every terminal row in the preservation hash.
        effects = db.execute("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status IS NULL OR status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
        sessions = db.execute("SELECT count(*) FROM orchestration_v2_projection_provider_sessions WHERE status IN ('running','working','connecting','starting')").fetchone()[0]
        assert all(status in TERMINAL_RUNS for status in runs) and requests == effects == sessions == 0, 'Native work is not idle'
        thread_ids = {row[0] for row in db.execute('SELECT thread_id FROM projection_threads')}
        if 'orchestration_v2_projection_threads' in tables:
            thread_ids.update(row[0] for row in db.execute('SELECT thread_id FROM orchestration_v2_projection_threads'))
        proof = {'projectIds': sorted(row[0] for row in db.execute('SELECT project_id FROM projection_projects')),
                 'threadIds': sorted(thread_ids),
                 'counts': counts, 'hashes': hashes, 'nativeWorkIdle': True}
        if 'auth_sessions' in tables:
            proof[AUTH_INVARIANT_KEY] = auth_invariant_hash(db)
        proof[ACTIVITY_KEY] = append_only_activity(db, tables)
        # Keep complete auth cells separate from every serializable public proof. A database
        # without the auth table has no session to capture (a migration may create it).
        auth = read_auth_sessions_in_transaction(db, proof) if include_auth and 'auth_sessions' in tables else None
        # Measured in the same read transaction as the proof it is compared with.
        carried = carried_since(db, tables, since) if since is not None else None
        # Complete schema and typed cells of every table, bound to the protected rows in
        # this same read transaction. Hashes and schema text only; no cell values.
        database = None
        if include_database:
            database = (continuity.capture_connection(db) if widen_from is None
                        else continuity.capture_connection(db, widen_from))
        if database is not None: continuity.bind_rows(database, proof)
        return proof, auth, carried, database
    finally:
        db.close()

def _rows_snapshot(state, include_auth, since=None, *, include_database=False):
    """(rows, auth, carried), or (rows, auth, databaseCapture) with include_database."""
    assert since is None or not include_database, 'Use _read_state for appended rows with a capture'
    proof, auth, carried, database = _read_state(state, include_auth, since, include_database)
    return (proof, auth, database) if include_database else (proof, auth, carried)

# A running service appends on its own while a thread waits on a usage limit: each
# availability check adds an event and a command receipt, and the projector rewrites
# that thread's projection row and its cursor. A starting release can do the same for
# a project: a settings save is a project event (stream_id is the project id), its
# receipt and that project's projection row. The new release opens the same database,
# so these rows carry forward. The proof records where each log ended and a hash per
# stream (thread or project) of the projection rows keyed by it, so a later read can
# show that every earlier row is untouched and that projection changes belong to
# streams with new events. The set of projects and threads, deletes, edits of earlier
# rows and every other table stay exact. (The proof keys keep their thread names.)
ACTIVITY_KEY = 'appendOnlyActivity'
LOG_TABLES = ('orchestration_events', 'orchestration_command_receipts',
              'orchestration_v2_events', 'orchestration_v2_command_receipts')
STREAM_COLUMNS = {'orchestration_events': 'stream_id', 'orchestration_v2_events': 'thread_id'}
CURSOR_COLUMNS = {'orchestration_v2_projection_metadata': ('last_sequence', 'updated_at'),
                  'projection_state': ('last_applied_sequence', 'updated_at')}

def encoded_row(row):
    return json.dumps(list(row), default=lambda value: value.hex(), separators=(',', ':'))

def rows_digest(lines):
    return digest(('\n'.join(sorted(lines))).encode())

def table_columns(db, table):
    return [row[1] for row in db.execute('PRAGMA table_info(' + table + ')')]

def stream_key(value):
    return value if isinstance(value, str) else '#' + json.dumps(value, default=lambda item: item.hex())

def has_rowid(db, table):
    try:
        db.execute('SELECT rowid FROM ' + table + ' LIMIT 0')
        return True
    except sqlite3.OperationalError:
        return False

def stream_column(columns):
    """A projection row belongs to its thread, or, with no thread column, its project."""
    return 'thread_id' if 'thread_id' in columns else 'project_id' if 'project_id' in columns else None

def append_only_activity(db, tables):
    """In-memory hashes and row positions only; no content leaves the transaction."""
    logs = {table: db.execute('SELECT coalesce(max(rowid), 0) FROM ' + table).fetchone()[0]
            for table in LOG_TABLES if table in tables and has_rowid(db, table)}
    thread_tables, buckets = [], {}
    for table in tables:
        columns = table_columns(db, table)
        key = stream_column(columns)
        if not (is_projection_table(table) and key) or table in CURSOR_COLUMNS:
            continue
        thread_tables.append(table)
        index = columns.index(key)
        for row in db.execute('SELECT * FROM ' + table):
            buckets.setdefault(stream_key(row[index]), []).append(json.dumps(table) + ',' + encoded_row(row))
    cursors = {}
    for table, moving in CURSOR_COLUMNS.items():
        if table in tables:
            columns = table_columns(db, table)
            keep = [index for index, name in enumerate(columns) if name not in moving]
            cursors[table] = digest(('studio-projection-cursor-v1\n' + '\n'.join(sorted(
                json.dumps([[columns[index], row[index]] for index in keep], default=lambda value: value.hex(),
                           separators=(',', ':')) for row in db.execute('SELECT * FROM ' + table)))).encode())
    return {'logRowids': logs, 'threadTables': sorted(thread_tables),
            'threadSha256': {key: digest(('studio-thread-rows-v1\n' + '\n'.join(sorted(lines))).encode())
                             for key, lines in buckets.items()},
            'cursorSha256': cursors}

def activity_digest(activity):
    return digest(json.dumps(activity, sort_keys=True, separators=(',', ':')).encode())

def valid_activity(activity):
    return (isinstance(activity, dict) and set(activity) == {'logRowids', 'threadTables', 'threadSha256', 'cursorSha256'}
            and isinstance(activity['logRowids'], dict) and isinstance(activity['threadTables'], list)
            and isinstance(activity['threadSha256'], dict) and isinstance(activity['cursorSha256'], dict)
            and all(table in LOG_TABLES and type(value) is int and value >= 0 for table, value in activity['logRowids'].items()))

def carried_since(db, tables, expected):
    """Rows the running service appended after `expected` was measured. Earlier log rows
    are rehashed at the recorded positions, in the format of the proof's table hashes."""
    activity = expected.get(ACTIVITY_KEY) if isinstance(expected, dict) else None
    if not valid_activity(activity):
        return None
    prefix, typed, appended, streams = {}, {}, {}, set()
    for table, boundary in activity['logRowids'].items():
        if table not in tables or not has_rowid(db, table):
            return None
        earlier = list(db.execute('SELECT * FROM ' + table + ' WHERE rowid <= ?', (boundary,)))
        lines = [encoded_row(row) for row in earlier]
        prefix[table] = [len(lines), rows_digest(lines)]
        # The same earlier rows with SQLite storage classes, for the complete database check.
        typed[table] = {'count': len(earlier), 'sha256': continuity.typed_rows_hash(earlier)}
        appended[table] = db.execute('SELECT count(*) FROM ' + table + ' WHERE rowid > ?', (boundary,)).fetchone()[0]
        column = STREAM_COLUMNS.get(table)
        if column and column in table_columns(db, table):
            streams.update(stream_key(row[0]) for row in
                           db.execute('SELECT ' + column + ' FROM ' + table + ' WHERE rowid > ?', (boundary,)))
    return {'activitySha256': activity_digest(activity), 'logPrefix': prefix, 'typedLogPrefix': typed,
            'appendedRows': appended, 'touchedStreams': sorted(streams)}

def carried_applies(expected, actual, carried):
    return (isinstance(expected, dict) and isinstance(actual, dict) and isinstance(carried, dict)
            and valid_activity(expected.get(ACTIVITY_KEY)) and valid_activity(actual.get(ACTIVITY_KEY))
            and carried.get('activitySha256') == activity_digest(expected[ACTIVITY_KEY])
            and isinstance(expected.get('counts'), dict) and isinstance(actual.get('counts'), dict)
            and isinstance(expected.get('hashes'), dict) and isinstance(actual.get('hashes'), dict))

def log_rows_carried(table, expected, actual, carried):
    """Every earlier row is byte-identical at its position; new rows only follow them."""
    before = [expected['counts'].get(table), expected['hashes'].get(table)]
    if before == [actual['counts'].get(table), actual['hashes'].get(table)]:
        return True
    return (carried['logPrefix'].get(table) == before
            and actual['counts'].get(table) == before[0] + carried['appendedRows'].get(table, -1))

def rows_carried_forward(expected, actual, carried, auth_heartbeat=True):
    """True when `actual` is `expected` plus rows the running service appended: new log
    rows, projection rows of threads or projects that have new events, and the projection
    cursor."""
    exempt = {'counts', 'hashes', 'threadIds', ACTIVITY_KEY}
    if set(expected) != set(actual) or any(expected[key] != actual[key] for key in expected if key not in exempt):
        return False  # Projects, idle state and the auth invariant stay exact.
    if set(expected['counts']) != set(actual['counts']) or set(expected['hashes']) != set(actual['hashes']):
        return False
    before, now = expected[ACTIVITY_KEY], actual[ACTIVITY_KEY]
    if before['threadTables'] != now['threadTables'] or set(before['cursorSha256']) != set(now['cursorSha256']):
        return False
    streams = set(carried['touchedStreams'])
    grew = any(count > 0 for count in carried['appendedRows'].values())
    heartbeat = auth_heartbeat and isinstance(expected.get(AUTH_INVARIANT_KEY), str)
    for table in expected['hashes']:
        same = (expected['counts'].get(table) == actual['counts'].get(table)
                and expected['hashes'][table] == actual['hashes'][table])
        if table == 'auth_sessions' and heartbeat:
            continue  # Compared through the invariant hash above.
        if table in before['logRowids']:
            if not log_rows_carried(table, expected, actual, carried):
                return False
        elif table in before['cursorSha256']:
            if now['cursorSha256'][table] != before['cursorSha256'][table] or not (same or grew):
                return False
        elif table in before['threadTables']:
            continue  # Compared per thread below.
        elif not same:
            return False
    old_threads, new_threads = before['threadSha256'], now['threadSha256']
    if any(key not in new_threads or (new_threads[key] != value and key not in streams) for key, value in old_threads.items()):
        return False
    if any(key not in streams for key in set(new_threads) - set(old_threads)):
        return False
    old_ids, new_ids = set(expected['threadIds']), set(actual['threadIds'])
    return old_ids <= new_ids and all(key in streams for key in new_ids - old_ids)

AUTH_INVARIANT_KEY = 'authSessionsInvariantSha256'
AUTH_HEARTBEAT_COLUMN = 'last_connected_at'
# The app version a connect reports (AuthSessions.ts setClientConnectionRow), shown in the sessions
# list only. A desktop app relaunched into a new release reports it on its first connect, which landed
# between the agent's snapshot and the apply on every first attempt from 1.0.46 to 1.0.60. The surface
# written beside it stays guarded: the heartbeat proof classifies sessions by it (active_session), so
# a change refuses here, before the restart, rather than rolling back after it.
AUTH_APP_VERSION_COLUMN = 'client_app_version'

def auth_invariant_hash(db):
    """Hash every auth_sessions cell except what a connect rewrites on its own: the heartbeat (a
    connected browser or desktop app rewrites last_connected_at every few seconds) and the app
    version it reports (AUTH_APP_VERSION_COLUMN). Identity, surface, scopes, credentials, expiry
    and revocation all stay guarded, including SQLite types and the complete schema. Hashed in
    memory only. Older invariant hashes fail closed: read a receipt back with the release's own
    helper (v2 until 1.0.60 also hashed the app version)."""
    columns = [row[1] for row in db.execute('PRAGMA table_info(auth_sessions)')]
    skipped = {AUTH_HEARTBEAT_COLUMN, AUTH_APP_VERSION_COLUMN}
    keep = [index for index, name in enumerate(columns) if name not in skipped]
    schema = [[list(row) for row in db.execute('PRAGMA table_xinfo(auth_sessions)')],
              [list(row) for row in db.execute(
                  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='auth_sessions' ORDER BY type,name")]]
    rows = sorted(encoded([(columns[index], type(row[index]).__name__, row[index]) for index in keep])
                  for row in db.execute('SELECT * FROM auth_sessions'))
    return digest(('studio-auth-invariant-v3\n' + encoded(schema) + '\n' + '\n'.join(rows)).encode())

def same_guarded_rows(expected, actual, carried=None, *, auth_heartbeat=True):
    """Protected rows are unchanged, allowing auth_sessions heartbeats and, with `carried`
    measured against `expected`, rows the running service appended (rows_carried_forward).
    Without the invariant hash on both sides (an older snapshot) the comparison stays
    byte-exact."""
    if carried_applies(expected, actual, carried):
        return rows_carried_forward(expected, actual, carried, auth_heartbeat)
    if not auth_heartbeat:
        return expected == actual
    if not (isinstance(expected, dict) and isinstance(actual, dict)
            and isinstance(expected.get(AUTH_INVARIANT_KEY), str) and isinstance(actual.get(AUTH_INVARIANT_KEY), str)
            and isinstance(expected.get('hashes'), dict) and isinstance(actual.get('hashes'), dict)):
        return expected == actual
    def without_heartbeat(rows):
        rest = dict(rows)
        rest['hashes'] = {table: value for table, value in rows['hashes'].items() if table != 'auth_sessions'}
        return rest, set(rows['hashes'])
    (left, left_tables), (right, right_tables) = without_heartbeat(expected), without_heartbeat(actual)
    return left == right and left_tables == right_tables

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

def database_allowance(expected, actual, carried, *, auth_heartbeat=True):
    """Tables of a complete capture that the guarded row comparison has already proven.

    Call only after same_guarded_rows(expected, actual, carried, auth_heartbeat=...) passed.
    auth_sessions may differ when both invariant hashes (every cell but the heartbeat and the
    reported app version, with SQLite types and the auth schema) are equal. With `carried` measured
    against `expected`, thread projection rows and projection cursors may differ, and log
    tables may grow when their earlier rows are typed-identical (`logPrefixes`). Every
    other table and the schema must stay exactly equal."""
    tables, prefixes = set(), {}
    if (auth_heartbeat and isinstance(expected, dict) and isinstance(actual, dict)
            and isinstance(expected.get(AUTH_INVARIANT_KEY), str)
            and expected.get(AUTH_INVARIANT_KEY) == actual.get(AUTH_INVARIANT_KEY)):
        tables.add('auth_sessions')
    if carried_applies(expected, actual, carried):
        activity = expected[ACTIVITY_KEY]
        tables.update(activity['threadTables'])
        tables.update(activity['cursorSha256'])
        typed = carried.get('typedLogPrefix')
        assert isinstance(typed, dict) and set(typed) == set(activity['logRowids']), 'Typed log prefixes missing'
        prefixes = dict(typed)
    return {'tables': sorted(tables), 'logPrefixes': prefixes}

def assert_capture_carried(expected, actual, expected_rows, actual_rows, carried, *, auth_heartbeat=True,
                           message='Complete database prestate changed'):
    """Complete database continuity with the same allowance as the guarded rows."""
    assert isinstance(expected, dict) and isinstance(actual, dict), 'Complete database proof missing'
    allowance = database_allowance(expected_rows, actual_rows, carried, auth_heartbeat=auth_heartbeat)
    try:
        continuity.assert_database_continuity(expected['summary'], actual['summary'],
                                              carried_tables=allowance['tables'],
                                              log_prefixes=allowance['logPrefixes'])
    except AssertionError as error:
        raise AssertionError(message) from error

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

# Ports of other local services: the model proxy (8317), Switch (8318) and the worker tunnels
# (18319, 28319). Their own launchd jobs restart them, and a tunnel reconnects after any
# network blip, so a listener there changing is not this update's doing and never refuses it.
# What an update must not do is take one of them: that is the guarded fact.
OTHER_SERVICE_PORTS = [8317, 8318, 18319, 28319]


def service_owns_listener(other_listeners, root_pid, processes):
    """True when a listener on another service's port is the Studio service or its descendant."""
    tree, grew = {root_pid}, True
    while grew:
        found = {pid for pid, process in processes.items() if process['parent'] in tree} - tree
        grew = bool(found)
        tree |= found
    return any(pid in tree for pids in other_listeners.values() for pid in pids)


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

def _snapshot(identity, include_auth, since=None, widen_from=None):
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
    rows, auth, carried, database = _read_state(own / 'userdata', include_auth, since, True, widen_from)
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

HOLD_REFUSAL = 'The service is not held for this update request'

def _utc(value):
    """An ISO time with its zone (`Z` included), or None."""
    if not isinstance(value, str) or not 0 < len(value) <= 64:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None

def assert_held(service, request, now=None):
    """The running service holds itself for this very forced request: its `updates/hold.json`
    (written by ServiceUpdateHold while held, removed when the hold ends) names the running
    pid, began after this process started and has not ended; and `updates/config.json` still
    asks to force-install `request`, made during this hold and not cancelled. A service that
    restarted, a hold that ended or a request that changed refuses the reap."""
    updates = service['own'] / 'updates'
    values = {}
    for name in ('hold.json', 'config.json'):
        path = safe_path(updates / name, service['home'])
        assert path.is_file() and not path.is_symlink() and path.stat().st_size <= 64 << 10, HOLD_REFUSAL
        values[name] = json.loads(path.read_text())
        assert isinstance(values[name], dict), HOLD_REFUSAL
    hold, config, runtime = values['hold.json'], values['config.json'], service['runtime']
    now = now or datetime.datetime.now(datetime.timezone.utc)
    began, ends, launched = _utc(hold.get('startedAt')), _utc(hold.get('expiresAt')), _utc(runtime.get('startedAt'))
    requested, cancelled = _utc(request), config.get('installCancelledAt')
    assert hold.get('schemaVersion') == 1 and type(hold.get('pid')) is int and hold['pid'] == runtime['pid'], HOLD_REFUSAL
    assert None not in (began, ends, launched, requested) and launched <= began <= requested <= now < ends, HOLD_REFUSAL
    assert config.get('installMode') == 'force' and config.get('installRequestedAt') == request, HOLD_REFUSAL
    assert cancelled is None or (_utc(cancelled) is not None and _utc(cancelled) <= requested), HOLD_REFUSAL

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

def guarded_row_counts(state):
    """Each guarded table's row count, as in _read_state's proof, without reading a row."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        assert all(re.fullmatch('[a-z0-9_]+', table) for table in tables), 'Unexpected table identifier'
        return {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in tables
                if table.startswith(('projection_', 'orchestration_', 'project_')) or table in AUTHORITY_TABLES}
    finally:
        db.close()

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

def is_projection_table(table):
    return table.startswith('projection_') or '_projection_' in table

def _column_definition(column):
    """How SQLite writes `ALTER TABLE ... ADD COLUMN name [type]` into the table's sql."""
    return column[1] + (' ' + column[2] if column[2] else '')

def accepted_widenings(before_capture, after_capture, before):
    """Protected tables a migration widened with plain nullable columns, as
    `ALTER TABLE t ADD COLUMN c [type]` does: every earlier column, row and typed cell is
    unchanged (compared through the earlier columns), and every added column has no
    constraint, no default and no value in any row. {table: widening} from the after
    capture. Projection tables may change anyway; auth_sessions and the event and receipt
    logs are never widened."""
    accepted = {}
    for table, widening in (after_capture.get('widened') or {}).items():
        if table not in before.get('counts', {}) or is_projection_table(table):
            continue
        assert table != 'auth_sessions' and table not in LOG_TABLES, \
            'A migration added columns to the auth sessions or history tables'
        for column in widening['added']:
            # PRAGMA table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden.
            assert column[3] == 0 and column[4] is None and column[5] == 0 and column[6] == 0, \
                'A migration added a protected column with a constraint or default'
            assert re.fullmatch('[a-z0-9_]+', column[1]) and re.fullmatch('[A-Z]*', column[2]), \
                'A migration added a protected column with an unexpected name or type'
        assert widening['filledRows'] == 0, 'A migration filled a new column of a protected table'
        old = [item for item in before_capture['schema']['objects'] if item[0] == 'table' and item[1] == table]
        new = [item for item in after_capture['schema']['objects'] if item[0] == 'table' and item[1] == table]
        assert len(old) == len(new) == 1 and isinstance(old[0][3], str) and old[0][3].endswith(')'), \
            'History, provider, schedule or pairing table definition changed during migration'
        widened_sql = old[0][3][:-1] + ''.join(', ' + _column_definition(column) for column in widening['added']) + ')'
        assert new[0][:3] == old[0][:3] and new[0][3] == widened_sql, \
            'History, provider, schedule or pairing table definition changed during migration'
        accepted[table] = widening
    return accepted

def narrowed_rows(rows, widenings):
    """`rows` with each widened table hashed through its earlier columns, so the
    byte-identical comparison of protected rows applies to every earlier cell."""
    narrowed = copy.deepcopy(rows)
    for table, widening in widenings.items():
        narrowed['counts'][table] = widening['legacy']['count']
        narrowed['hashes'][table] = widening['legacy']['sha256']
    return narrowed

def assert_migration_preserved(before, after, carried=None):
    """A new release's migrations may add tables and rebuild projections. Nothing is lost:
    every project, thread and protected table survives; event history, provider, schedule
    pairing and auth rows stay byte-identical; projections may grow. With
    `carried` measured against `before`, the event and receipt logs may also gain rows
    after their byte-identical earlier rows (a thread waiting on a usage limit)."""
    assert after.get('nativeWorkIdle') is True, 'Native work is not idle after restart'
    assert set(before['projectIds']) <= set(after['projectIds']), 'A project disappeared during migration'
    assert set(before['threadIds']) <= set(after['threadIds']), 'A thread disappeared during migration'
    before_counts, after_counts = before.get('counts', {}), after.get('counts', {})
    before_hashes, after_hashes = before.get('hashes', {}), after.get('hashes', {})
    logs = before[ACTIVITY_KEY]['logRowids'] if carried_applies(before, after, carried) else {}
    for table in AUTHORITY_TABLES:
        if table not in before_counts and table in after_counts:
            assert after_counts[table] == 0, 'A migration created a session, pairing, provider or schedule table holding rows'
    for table in set(before_counts) | set(before_hashes):
        assert table in after_counts or table in after_hashes, 'A protected table disappeared during migration'
        if is_projection_table(table):
            assert after_counts.get(table, 0) >= before_counts.get(table, 0), 'Rows disappeared during migration'
        elif table in logs:
            assert log_rows_carried(table, before, after, carried), \
                'History, provider, schedule or pairing rows changed during migration'
        else:
            assert after_counts.get(table) == before_counts.get(table) and after_hashes.get(table) == before_hashes.get(table), \
                'History, provider, schedule or pairing rows changed during migration'

def auth_comparison(before, after):
    """Private comparison view; retain actual auth evidence and all old non-auth rows."""
    return {**before,
            'counts': {**before['counts'], 'auth_sessions': after['counts']['auth_sessions']},
            'hashes': {**before['hashes'], 'auth_sessions': after['hashes']['auth_sessions']}}

def typed_auth_rows(auth):
    # The legacy public encoder maps BLOB bytes to hex strings. Compare SQLite types
    # as well as values so an equal public hash cannot hide a BLOB-to-TEXT change.
    return sorted(encoded([(type(value).__name__, value) for value in row]) for row in auth['rows'])

def typed_auth_rows_hash(auth):
    return digest(('studio-migration-auth-typed-v1\n' + '\n'.join(typed_auth_rows(auth))).encode())

def verify_migration_heartbeat_witness(before, after, witness, current_auth, *, identity, state=None, web_session_policy=None,
                                       before_capture=None, after_capture=None):
    """Recheck actual migration snapshots and type-bound complete private auth.

    Appended logs require a fresh, coherent read of the trusted database at `state`.
    Receipt counts alone cannot prove that earlier log rows survived. A migration that
    added columns to a protected table (accepted_widenings) needs the receipt's before and
    after database captures.
    """
    carried = None
    if state is not None:
        measured_rows, measured_auth, carried = _rows_snapshot(state, True, before)
        assert measured_rows == after, 'Current database differs from the migration after-snapshot'
        assert measured_auth is not None, 'Auth sessions table disappeared after the migration'
        assert measured_auth['schema'] == current_auth['schema'] and measured_auth['columns'] == current_auth['columns'] and typed_auth_rows(measured_auth) == typed_auth_rows(current_auth), \
            'Current private auth differs from the migration database'

    typed = witness.get('migrationTypedAuth')
    assert isinstance(typed, dict) and set(typed) == {'schemaVersion', 'beforeSha256', 'afterSha256'}, 'Migration requires typed auth commitments'
    assert type(typed['schemaVersion']) is int and typed['schemaVersion'] == 1, 'Unknown typed auth commitment version'
    assert typed_auth_rows_hash(current_auth) == typed['afterSha256'], 'Current auth cell values or types changed'
    heartbeat = {key: value for key, value in witness.items() if key != 'migrationTypedAuth'}
    verify_restart_witness(before, auth_comparison(before, after), heartbeat,
                           current_auth, identity=identity, web_session_policy=web_session_policy)
    original = restore_witness(current_auth, heartbeat, before)
    assert typed_auth_rows_hash(original) == typed['beforeSha256'], 'Reconstructed auth cell values or types changed'
    widenings = {}
    if before_capture is not None or after_capture is not None:
        assert before_capture is not None and after_capture is not None, 'Widened migration readback needs both database captures'
        continuity.bind_rows(before_capture, before)
        continuity.bind_rows(after_capture, after)
        widenings = accepted_widenings(before_capture, after_capture, before)
    assert_migration_preserved(before, auth_comparison(narrowed_rows(after, widenings), before), carried)
    return witness

def heartbeat_window_start(opened_at, closed_at, auth):
    """The restart window's start: no earlier than any heartbeat stamped during the baseline
    read, and no later than that read, so every reconnect after it falls inside the window.
    A row stamped after the read (a clock that stepped back) never moves the start."""
    latest, closed = utc_timestamp(opened_at), utc_timestamp(closed_at)
    if auth:
        column = auth['columns'].index('last_connected_at')
        for row in auth['rows']:
            with contextlib.suppress(AssertionError):
                stamped = utc_timestamp(row[column])
                if stamped <= closed:
                    latest = max(latest, stamped)
    return latest.isoformat()

def prove_migration_preserved(before, after, original_auth, current_auth, restart_started_at,
                              observed_after_at, *, identity, allow_existing_browser_heartbeat, carried=None, web_session_policy=None):
    """Prove auth independently, then permit only the existing projection migrations.

    Complete private auth cells are bound to both public snapshots. A comparison copy
    may reverse a proven heartbeat; receipt snapshots always retain their actual hashes.
    Auth schema migrations require a separate explicit transformation proof. A database
    without an auth table has no session to protect, so a migration may create the table.
    """
    if original_auth is None:
        assert 'auth_sessions' not in before.get('counts', {}), 'Existing auth sessions were not captured'
        if current_auth is not None:
            bind_auth(current_auth, after)
            # A new table holds no session: new auth sessions are never permitted.
            assert current_auth['rows'] == [], 'A migration created the auth table holding sessions'
        assert_migration_preserved(before, after, carried)
        return None
    assert current_auth is not None, 'Auth sessions table disappeared during migration'
    bind_auth(original_auth, before)
    bind_auth(current_auth, after)
    assert original_auth['schema'] == current_auth['schema'], 'Complete auth schema changed'
    heartbeat = None
    comparison = after
    if (before['counts']['auth_sessions'] == after['counts']['auth_sessions'] and
            before['hashes']['auth_sessions'] == after['hashes']['auth_sessions']):
        assert typed_auth_rows(original_auth) == typed_auth_rows(current_auth), 'Auth cell values or types changed'
    else:
        assert allow_existing_browser_heartbeat, 'Auth changed during migration without a heartbeat proof'
        # Retain all auth counts and hashes from the real after-snapshot. The existing
        # heartbeat prover checks every auth cell, identity, schema and timestamp.
        auth_after = auth_comparison(before, after)
        heartbeat = prove_restart_heartbeat(before, auth_after, original_auth, current_auth,
                                           restart_started_at, observed_after_at, identity=identity, web_session_policy=web_session_policy)
        assert heartbeat is not None, 'Changed auth requires a complete heartbeat witness'
        heartbeat = {**heartbeat, 'migrationTypedAuth': {
            'schemaVersion': 1, 'beforeSha256': typed_auth_rows_hash(original_auth),
            'afterSha256': typed_auth_rows_hash(current_auth)}}
        comparison = auth_comparison(after, before)
    assert_migration_preserved(before, comparison, carried)
    return heartbeat

def assert_migration_typed_cells(before_capture, after_capture, before, after, carried=None, widenings=None):
    """Protected tables a migration must keep byte-identical also keep each cell's SQLite type.

    The protected-row hash writes a BLOB as its hex text, so a pairing credential, provider
    or schedule cell, or an earlier event rewritten as that text would compare equal there.
    Compares the typed hashes of the complete captures, which _read_state bound to these
    rows in the same read. Projection tables may be rebuilt; auth_sessions is proven cell by
    cell in prove_migration_preserved; a log that grew compares the typed hash of the earlier
    rows measured with `carried`."""
    old, new = before_capture['summary']['tables'], after_capture['summary']['tables']
    logs = before[ACTIVITY_KEY]['logRowids'] if carried_applies(before, after, carried) else {}
    for table in before.get('counts', {}):
        if is_projection_table(table) or table == 'auth_sessions':
            continue
        assert table in old and table in new, 'A protected table disappeared during migration'
        expected = old[table]
        if table in (widenings or {}):
            actual = widenings[table]['typed']
        elif table in logs and new[table] != expected:
            actual = carried.get('typedLogPrefix', {}).get(table)
        else:
            actual = new[table]
        assert actual == expected, 'History, provider, schedule or pairing cell values or types changed during migration'

def assert_migration_protected_schema(before_capture, after_capture, before, widenings=None):
    """Protected tables a migration must keep byte-identical also keep their definition,
    columns and foreign keys, and no new trigger may touch a session, pairing, provider or
    schedule table.

    Both row hashes ignore column names, so swapping two column names would keep every hash.
    A foreign key with ON UPDATE or ON DELETE CASCADE lets a write to another table rewrite
    or delete protected rows, and a trigger on any table could write sessions or credentials
    after the update verified. A trigger may sit on any table, including projections and
    project tables, as long as it names none of these tables. New indexes stay allowed."""
    old, new = before_capture['schema'], after_capture['schema']
    def definition(objects, table):
        return [item for item in objects if item[0] == 'table' and item[1] == table]
    for table in before.get('counts', {}):
        if is_projection_table(table) or table == 'auth_sessions':
            continue
        assert old['foreignKeys'].get(table) == new['foreignKeys'].get(table), \
            'History, provider, schedule or pairing foreign keys changed during migration'
        if table in (widenings or {}):
            # accepted_widenings checked the added columns and the widened definition.
            assert old['columns'].get(table) + widenings[table]['added'] == new['columns'].get(table), \
                'History, provider, schedule or pairing columns changed during migration'
            continue
        assert old['columns'].get(table) == new['columns'].get(table), \
            'History, provider, schedule or pairing columns changed during migration'
        assert definition(old['objects'], table) == definition(new['objects'], table), \
            'History, provider, schedule or pairing table definition changed during migration'
    existing = {encoded(item) for item in old['objects']}
    touches = re.compile(r'\b(?:' + '|'.join(AUTHORITY_TABLES) + r')\b', re.IGNORECASE)
    for item in new['objects']:
        if item[0] == 'trigger' and encoded(item) not in existing:
            assert not touches.search(str(item[2]) + ' ' + str(item[3] or '')), \
                'A migration added a trigger touching sessions, pairing, provider or schedule rows'

def _write_private(path, data):
    """A new 0600 file, never through a link; replaces `path` atomically."""
    temporary = path.with_name(path.name + '.owned-update-' + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
        os.replace(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()

def backup_state(own, commit):
    """Consistent copy of the state database, and the exact settings.json beside it, before
    the new release can migrate them."""
    home = pathlib.Path.home().resolve()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    root = safe_path(studio_paths.backups_root(home), home)
    root.mkdir(mode=0o700, exist_ok=True)
    target_dir = root / ('pre-%s-%s-%s' % (re.sub('[^a-f0-9]', '', str(commit))[:12] or 'unknown', stamp, uuid.uuid4().hex))
    target_dir.mkdir(mode=0o700)
    target = target_dir / 'statev2.sqlite'
    source = live_database.connect(own / 'userdata' / 'statev2.sqlite')
    try:
        copy = sqlite3.connect(str(target))
        try:
            source.backup(copy)
        finally:
            copy.close()
    except BaseException:
        # A copy cut short (a full disk) would otherwise stay behind and keep the disk full.
        discard_unused_backup(target)
        raise
    finally:
        source.close()
    target.chmod(0o600)
    settings = own / 'userdata' / 'settings.json'
    if settings.is_file() and not settings.is_symlink():
        _write_private(target_dir / 'settings.json', settings.read_bytes())
    return target

BACKUP_SPACE_MARGIN = 2 * 1024 ** 3

def assert_backup_space(own, home):
    """Refuses an update whose pre-update copy of the database cannot fit. The copy is
    about the database and its write-ahead log; the margin covers the release staged
    beside it and leaves the Mac room to run. Sizes come from stat alone: the live
    database is never opened here."""
    needed = BACKUP_SPACE_MARGIN
    for name in ('statev2.sqlite', 'statev2.sqlite-wal'):
        try:
            needed += os.stat(str(own / 'userdata' / name)).st_size
        except FileNotFoundError:
            pass
    root = studio_paths.backups_root(home)
    while not root.exists() and root != root.parent:
        root = root.parent  # The first update makes the backups folder; measure its disk.
    free = shutil.disk_usage(str(root)).free
    assert free >= needed, 'Not enough free disk space for the pre-update backup: needs %.1f GB, %.1f GB free' % (
        needed / 1e9, free / 1e9)

def discard_unused_backup(backup):
    """Removes a backup_state copy that no restart used (a copy of a 2.5 GB database each
    retry would otherwise pile up). Only the files backup_state writes, in its own folder."""
    home = pathlib.Path.home().resolve()
    folder = backup.parent
    if (backup.name != 'statev2.sqlite' or not folder.name.startswith('pre-')
            or folder.parent != safe_path(studio_paths.backups_root(home), home)):
        return
    for name in ('statev2.sqlite', 'settings.json'):
        with contextlib.suppress(FileNotFoundError):
            (folder / name).unlink()
    with contextlib.suppress(OSError):
        folder.rmdir()

def restore_state(backup, own):
    """Puts the pre-update database, and the settings.json saved with it, back while the
    service is stopped: a new release may rewrite settings.json once when it starts."""
    state = own / 'userdata'
    staged = state / ('statev2.sqlite.owned-restore-' + str(uuid.uuid4()))
    try:
        shutil.copyfile(backup, staged)
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

def settings_preserved(before, after):
    """Settings across the restart: byte-identical, or every user value kept with only the
    documented migrations (settings_continuity). Without both proofs the bytes must match."""
    if after['fileHashes']['settings'] == before['fileHashes']['settings']:
        return {'result': 'byte-identical'}
    proofs = before.get('settingsProof'), after.get('settingsProof')
    assert all(isinstance(proof, dict) for proof in proofs), 'User settings changed after restart'
    return settings_continuity.assert_settings_preserved(*proofs)

def wait_for_stopped(pid, timeout=30, *, port=8319):
    for attempt in range(int(timeout / 0.5)):
        alive = subprocess.run(['/bin/kill', '-0', str(pid)], capture_output=True, timeout=5).returncode == 0
        if not alive and listeners(port) == []: return
        time.sleep(0.5)
    raise AssertionError('Owned service did not stop for the state restore')

def restart_service(domain, label, plist, old, new, pid, port):
    """Restart the service. `new` is a rewritten LaunchAgent (service_launch_agent): launchd
    reads it only on bootstrap, so the job is booted out and bootstrapped again; otherwise
    `kickstart -k`. The job is always loaded again, from the original file if launchd refuses
    the rewritten one. Bounded to 135 s, inside the rollback reserve after a late restart."""
    if new is None:
        run(['/bin/launchctl', 'kickstart', '-k', domain + '/' + label])
        return
    mode = plist.stat().st_mode & 0o777
    atomic(plist, new, mode)
    try:
        run(['/bin/launchctl', 'bootout', domain + '/' + label], timeout=45)
        wait_for_stopped(pid, port=port)
    finally:
        try:
            run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=30)
        except BaseException:
            atomic(plist, old, mode)
            run(['/bin/launchctl', 'bootstrap', domain, str(plist)], timeout=30)
            raise

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
# Everything before the restart thus ends within READY_BY_SECONDS_FROM_START - this (420 s
# with the old 900 s budget)
# plus one reading in flight, which keeps the helper under the agent's 900 s.
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
        with guard:
            return _apply(identity, expected, archive, archive_sha, output,
                          allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,
                          allow_project_migrations=allow_project_migrations)

def _apply(identity, expected, archive, archive_sha, output, *, allow_existing_browser_heartbeat=False,
          allow_project_migrations=False):
    validate_identity(identity)
    web_session_policy(identity, expected.get('webSessionPolicy'))
    started = time.monotonic()
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
    # Measure appended rows and private auth in the same transaction as the proof.
    before, original_auth, carried = snapshot_since(identity, expected['rows'], capture_auth)
    restart_started_at = heartbeat_window_start(
        read_opened_at, datetime.datetime.now(datetime.timezone.utc).isoformat(), original_auth)
    assert_prestate(expected, before, carried)
    # Without migrations, a heartbeat proof compares existing sessions: refuse before any write.
    assert allow_project_migrations or not allow_existing_browser_heartbeat or original_auth is not None, \
        'Restart heartbeat proof requires the auth sessions table'
    home = pathlib.Path.home().resolve()
    own = studio_paths.identity_home(home, identity)
    # Each copy is the size of the database (2.5 GB on a long-used Mac): keep the newest one
    # beside the copy made below, so updates never pile them up and fill the disk. Pruned
    # first, so the space it frees counts in the free-space check that follows.
    try:
        pruned_state_backups, prune_error = prune_state_backups(home, keep_newest=1), None
    except Exception as error:  # Pruning never fails an update.
        pruned_state_backups, prune_error = [], type(error).__name__
    # A disk too full for the copy refuses here, before staging, a pointer or a stop.
    assert_backup_space(own, home)
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
        current, _, current_carried = snapshot_since(identity, expected['rows'])
        assert_prestate(expected, current, current_carried)
        manifest = publish_release(staged_release, new_release)
    backup = own / 'owned-updates' / str(uuid.uuid4())
    backup.mkdir(parents=True, mode=0o700)
    for name, value in old_bytes.items(): (backup / name).write_bytes(value)
    (backup / 'cli-wrapper.sh').write_bytes(old_wrapper)
    shutil.copyfile(home / 'Library/LaunchAgents' / (before['serviceLabel'] + '.plist'), backup / 'service.plist')
    (backup / 'prestate.json').write_text(json.dumps(before, indent=2) + '\n')
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
    current, _, current_carried = snapshot_since(identity, expected['rows'])
    assert_prestate(expected, current, current_carried)
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
    output.write_text(json.dumps(progress, indent=2) + '\n')
    restart_requested = False
    plist_hashes = {before['fileHashes']['plist']}  # Plus the rewritten LaunchAgent once written.
    state_backup = None
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
        progress['phase'] = 'pointers-written'
        output.write_text(json.dumps(progress, indent=2) + '\n')
        # The old service starts nothing more on its own from here (scheduler, webhooks, run
        # now), so the rows compared below stay as they are through the backup and restart.
        # Kept until the finally below: the new release (or the old one a rollback starts
        # again) stays idle for the readiness and rollback snapshots.
        write_install_gate(own, home)
        time.sleep(INSTALL_GATE_SETTLE_SECONDS)
        def assert_unchanged_before_restart():
            if 'databaseCapture' in before:
                current_rows, current_carried, current_database = rows_since_with_database(own / 'userdata', before['rows'])
            else:
                current_rows, current_carried = rows_since(own / 'userdata', before['rows'])
            assert same_guarded_rows(before['rows'], current_rows, current_carried,
                                     auth_heartbeat=allow_existing_browser_heartbeat), 'Native work changed before restart'
            assert_provable_reconnects(current_rows)
            if 'databaseCapture' in before:
                assert_capture_carried(before['databaseCapture'], current_database, before['rows'], current_rows,
                                       current_carried, auth_heartbeat=allow_existing_browser_heartbeat,
                                       message='Complete database changed before restart')
        def assert_provable_reconnects(current_rows):
            # Auth may differ only as the proof after the restart accepts, so a connect it would roll
            # back (a phone app, a revoked session, one past the session counts) refuses here, with
            # the old release running, as a refusal the update agent retries.
            if not allow_existing_browser_heartbeat or original_auth is None \
                    or current_rows['hashes'].get('auth_sessions') == before['rows']['hashes'].get('auth_sessions'):
                return
            try:
                current_auth = read_auth_sessions(own / 'userdata', current_rows)  # Bound to the rows just compared.
                prove_restart_heartbeat(before['rows'], auth_comparison(before['rows'], current_rows), original_auth,
                                        current_auth, restart_started_at, datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                        identity=identity, web_session_policy=policy)
            except (AssertionError, KeyError, ValueError) as error:  # A fresh snapshot may prove it: retried.
                raise AssertionError('Native work changed before restart: auth (%s)' % str(error)[:200]) from None
        assert_unchanged_before_restart()
        def assert_same_service_pid():
            # A service launchd restarted on its own after the pointers moved would be the
            # new release, migrating before any backup exists.
            live = run(['/bin/launchctl', 'print', domain + '/' + before['serviceLabel']], text=True)
            assert re.search(r'^\s*pid = ' + str(before['servicePid']) + r'\s*$', live, re.M), \
                'The service restarted on its own before the update restarted it'
        assert_same_service_pid()
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
        # The new release migrates the database on start; a rollback must restore both.
        state_backup = backup_state(own, before['artifactSourceCommit'])
        # Nothing may change between the backup and the restart: the rollback restores this
        # copy, and the after-snapshot is compared with `before`. Checked again here, last,
        # so a write the old service made meanwhile stops the update with the old release
        # still running instead of rolling the new one back.
        try:
            assert_same_service_pid()
            assert_unchanged_before_restart()
        except BaseException:
            with contextlib.suppress(OSError, AssertionError):
                discard_unused_backup(state_backup)
            raise
        progress['phase'] = 'restart-requested'
        progress['restartStartedAt'] = restart_started_at
        progress['stateBackup'] = str(state_backup)
        output.write_text(json.dumps(progress, indent=2) + '\n')
        restart_requested = True
        if new_plist is not None:
            plist_hashes.add(digest(new_plist))
            progress['serviceLaunchAgent'] = 'process-type-interactive-added'
        restart_service(domain, before['serviceLabel'], plist, old_plist, new_plist, before['servicePid'], port)
        # One reading can take a minute when the process inventory times out and retries, so
        # the loop is bounded by time, not attempts: the rollback must finish well inside the
        # update agent's APPLY_TIMEOUT (900 s), which kills the helper outright.
        restarted_at = time.monotonic()
        # A migration may widen a protected table (accepted_widenings); measure it in the
        # same read as the after-snapshot.
        widen = ({'widen_from': before['databaseCapture']['schema']['columns']}
                 if allow_project_migrations and 'databaseCapture' in before else {})
        ready_by = min(restarted_at + READINESS_DEADLINE_SECONDS, started + READY_BY_SECONDS_FROM_START)
        while time.monotonic() < ready_by:
            time.sleep(0.5)
            try:
                after, current_auth, after_carried = snapshot_since(identity, before['rows'], capture_auth, **widen)
                if after['servicePid'] != before['servicePid']: break
            # A process inventory that timed out twice is retried here like any other
            # not-yet-ready reading, rather than rolling back a service that is starting.
            except (AssertionError, OSError, sqlite3.Error, subprocess.TimeoutExpired): continue
        assert after and after['servicePid'] != before['servicePid'], \
            'Updated service did not become ready within %d s' % max(0, round(ready_by - restarted_at))
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
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'identity': identity, 'result': 'updated', 'archiveSha256': archive_sha, 'servicePid': after['servicePid'], 'report': str(output)}))
    except BaseException as error:
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
                restore_old_pointers()
                failure['rollback'] = 'restored-exact-owned-runtime-pointers'
                # No state/auth/config migration is undone by a pointer rollback.
                failure['stateDeltaRetained'] = True
            output.write_text(json.dumps(failure, indent=2) + '\n')
        except (AssertionError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as rollback_error:
            # Retain the failed receipt and leave active or unverified services untouched;
            # the receipt names the check that stopped the rollback.
            failure['rollbackError'] = describe_error(rollback_error)
            try:
                output.write_text(json.dumps(failure, indent=2) + '\n')
            except OSError:
                pass
        raise
    finally:
        clear_install_gate(own, home)

def describe_error(error):
    """Type and message of a failed proof, bounded; messages here never carry row content."""
    message = str(error)
    if len(message) > 2000:
        message = message[:2000] + '...'
    return type(error).__name__ + (': ' + message if message else '')

def write_preflight_failure(output, identity, error):
    """apply() writes its own receipt from phase 'prepared' on. A failure before that point
    (snapshot, prestate checks, staging, version gate, publish) leaves one here, so the
    updater's "See the update receipt" always names a real file. Never overwrites."""
    if output.exists() or output.is_symlink():
        return
    failure = {'identity': identity, 'phase': 'preflight', 'result': 'update-failed',
               'error': describe_error(error),
               'pointers': 'unchanged'}
    try:
        fd = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(json.dumps(failure, indent=2) + '\n')
    except OSError:
        pass  # The original error is what the caller needs; it is re-raised.

# Refusals the next snapshot may not repeat: processes or the database moved while being read,
# or a process listed by ps exited before the kernel read of it.
BUSY_REFUSALS = {'Owned process identities changed during inventory', 'Owned service process identity changed'} | VANISHED_READS

def native_work_counts(state):
    """The per-check counts behind 'Native work is not idle', read again (read-only) for the
    refusal line. The same predicates as _read_state, which alone decides."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        def count(query):
            return db.execute(query).fetchone()[0]
        statuses, held = run_work(db)
        runs = sum(1 for status in statuses if status not in TERMINAL_RUNS and status != 'queued')
        return {'runs': runs,
                'queued': statuses.count('queued'),
                'requests': count("SELECT count(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending'"),
                'effects': count("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status IS NULL OR status NOT IN ('succeeded','failed','cancelled')"),
                'sessions': count("SELECT count(*) FROM orchestration_v2_projection_provider_sessions WHERE status IN ('running','working','connecting','starting')"),
                # Held queued runs never block; the count says why a queue still shows.
                'held': held}
    finally:
        db.close()

def _name(value):
    return re.sub(r'[^A-Za-z0-9._+-]', '_', posixpath.basename(str(value)))[:40] or '_'

def descendant_names(pid, processes):
    """Executable basenames beneath the service, with counts; the one supervisor is left out.
    Only `ps comm` is read, never argv, so no argument or secret can appear."""
    names, pending, seen, supervisor = {}, [pid], {pid}, False
    while pending:
        parent = pending.pop()
        for child in sorted(processes.values(), key=lambda item: item['pid']):
            if child['parent'] != parent or child['pid'] in seen:
                continue
            seen.add(child['pid'])
            pending.append(child['pid'])
            if not supervisor and parent == pid and child['executable'] == '/usr/bin/caffeinate':
                supervisor = True
                continue
            name = _name(child['executable'])
            names[name] = names.get(name, 0) + 1
    return ' '.join('%s=%d' % item for item in sorted(names.items())[:8]) or ('none' if supervisor else 'no-supervisor')

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
