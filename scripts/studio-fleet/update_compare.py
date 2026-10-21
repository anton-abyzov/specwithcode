"""The update's row comparisons, split from update.py: which differences between two reads of
the protected rows and the complete database capture a running, held service may cause (appended
log rows, their projections, auth heartbeats), the auth read for the heartbeat proof, the guarded
row counts and the settings proof. update.py imports every name here, so callers and receipts use
it as before. Pure reads and comparisons: nothing here starts, stops or signals a process.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import re

from auth_heartbeat import read_auth_sessions_in_transaction, rows_hash
import database_continuity as continuity
import live_database
import settings_continuity
from update_read import (ACTIVITY_KEY, AUTH_INVARIANT_KEY, AUTHORITY_TABLES, carried_applies,
                         log_rows_carried)


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

def auth_since(state, expected_rows):
    """The complete auth cells, and `expected_rows` with the auth count and hash those cells have,
    in one read: a proof over them never mixes two reads of a table every connect writes."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        rows = [list(row) for row in db.execute('SELECT * FROM auth_sessions')]
        view = {**expected_rows, 'counts': {**expected_rows['counts'], 'auth_sessions': len(rows)},
                'hashes': {**expected_rows['hashes'], 'auth_sessions': rows_hash(rows)}}
        return read_auth_sessions_in_transaction(db, view), view
    finally:
        db.close()

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

def settings_preserved(before, after):
    """Settings across the restart: byte-identical, or every user value kept with only the
    documented migrations (settings_continuity). Without both proofs the bytes must match."""
    if after['fileHashes']['settings'] == before['fileHashes']['settings']:
        return {'result': 'byte-identical'}
    proofs = before.get('settingsProof'), after.get('settingsProof')
    assert all(isinstance(proof, dict) for proof in proofs), 'User settings changed after restart'
    return settings_continuity.assert_settings_preserved(*proofs)
