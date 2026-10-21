"""The update's migration proofs, split from update.py: which changes a new release's
migrations may make to the protected rows, cells, schema and auth sessions, and the readback
of a migration's heartbeat witness. update.py imports every name here, so callers and
receipts use it as before.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import contextlib
import copy
import hashlib
import re

from auth_heartbeat import (bind_auth, encoded, prove_restart_heartbeat, restore_witness, utc_timestamp,
                            verify_restart_witness)
import database_continuity as continuity
from update_read import (ACTIVITY_KEY, AUTHORITY_TABLES, LOG_TABLES, _read_state, carried_applies,
                         is_projection_table, log_rows_carried)


def digest(value):
    return hashlib.sha256(value).hexdigest()

def _rows_snapshot(state, include_auth, since=None):
    """(rows, auth, carried) of one read (update._rows_snapshot without the capture)."""
    proof, auth, carried, _ = _read_state(state, include_auth, since, False)
    return proof, auth, carried

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
