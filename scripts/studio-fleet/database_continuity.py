"""Version-agnostic whole-database capture and continuity checks for owned Studio updates.

Every read is one read-only SQLite transaction. A capture holds the complete schema
(sqlite_master objects, PRAGMA table_xinfo and foreign_key_list of every table) and a
typed-cell hash of every table, so changes outside the protected-row subset and any
schema change are detected. Public captures contain hashes and schema text only, never
cell values; private auth cells stay in the separate auth structure.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for database preservation checks')

import copy
import hashlib
import json
import pathlib
import re

import live_database


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def cell(value):
    # Preserve the storage class; TEXT 'abcd' must never equal BLOB x'abcd'.
    if value is None: return ['null', None]
    if type(value) is int: return ['integer', str(value)]
    if type(value) is float: return ['real', value.hex()]
    if type(value) is str: return ['text', value]
    if type(value) is bytes: return ['blob', value.hex()]
    raise AssertionError('Unsupported SQLite cell type')


def typed_rows_hash(rows):
    return digest('\n'.join(sorted(encoded([cell(value) for value in row]) for row in rows)))


def legacy_rows_hash(rows):
    """The protected-row hash update.rows_snapshot publishes (BLOBs as hex strings)."""
    return digest('\n'.join(sorted(json.dumps(list(row), default=lambda value: value.hex(),
                                              separators=(',', ':')) for row in rows)))


def identifier(value):
    assert re.fullmatch('[a-zA-Z0-9_]+', value), 'Unexpected schema identifier'
    return '"' + value + '"'


def schema(db):
    objects = [list(row) for row in db.execute(
        'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')]
    tables = [row[1] for row in objects if row[0] == 'table']
    return {'objects': objects,
            'columns': {table: [list(row) for row in db.execute('PRAGMA table_xinfo(' + identifier(table) + ')')]
                        for table in tables},
            'foreignKeys': {table: [list(row) for row in db.execute('PRAGMA foreign_key_list(' + identifier(table) + ')')]
                            for table in tables}}


def widened_tables(db, structure, widen_from):
    """Tables that gained trailing columns since `widen_from` (an earlier capture's
    schema['columns']): the earlier columns' rows hashed as the earlier capture hashed
    them, and how many rows hold a value in an added column. Hashes and counts only.
    The caller decides which of these widenings it accepts."""
    widened = {}
    for table, old in sorted(widen_from.items()):
        new = structure['columns'].get(table)
        if not (isinstance(old, list) and old and new and len(new) > len(old) and new[:len(old)] == old):
            continue
        names = ','.join(identifier(column[1]) for column in old)
        rows = list(db.execute('SELECT ' + names + ' FROM ' + identifier(table)))
        filled = ' OR '.join(identifier(column[1]) + ' IS NOT NULL' for column in new[len(old):])
        widened[table] = {'added': new[len(old):],
                          'typed': {'count': len(rows), 'sha256': typed_rows_hash(rows)},
                          'legacy': {'count': len(rows), 'sha256': legacy_rows_hash(rows)},
                          'filledRows': db.execute('SELECT count(*) FROM ' + identifier(table) + ' WHERE ' + filled).fetchone()[0]}
    return widened


def capture_connection(db, widen_from=None):
    """Capture the complete database inside the caller's open read transaction. With
    `widen_from`, also measure tables that gained columns since then (widened_tables)."""
    assert db.in_transaction, 'Complete database capture requires an existing read transaction'
    structure = schema(db)
    tables, legacy, sequences = {}, {}, None
    for table in structure['columns']:
        rows = list(db.execute('SELECT * FROM ' + identifier(table)))
        tables[table] = {'count': len(rows), 'sha256': typed_rows_hash(rows)}
        legacy[table] = {'count': len(rows), 'sha256': legacy_rows_hash(rows)}
        if table == 'sqlite_sequence':
            # AUTOINCREMENT counters: table names and integers only, so a log that grew can
            # be told apart from any other change to this bookkeeping table.
            sequences = sorted([list(row) for row in rows], key=encoded)
    summary = {'schemaSha256': digest(encoded(structure)), 'tables': tables}
    if sequences is not None: summary['sqliteSequence'] = sequences
    capture = {'schema': structure, 'summary': summary, 'legacy': legacy}
    if widen_from is not None:
        # Only when a table widened, so an unchanged database captures exactly as without.
        widened = widened_tables(db, structure, widen_from)
        if widened: capture['widened'] = widened
    return capture


def bind_rows(capture, rows):
    """Require the complete capture and the protected-row snapshot to be one observation."""
    assert set(rows['counts']) == set(rows['hashes']), 'Protected snapshot shape changed'
    for table in rows['counts']:
        assert capture['legacy'].get(table) == {'count': rows['counts'][table], 'sha256': rows['hashes'][table]}, \
            'Database changed during protected row readback'


def _read_database(state, rows, include_auth):
    db = live_database.connect(pathlib.Path(state) / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        capture = capture_connection(db)
        if rows is not None: bind_rows(capture, rows)
        auth = None
        if include_auth:
            from auth_heartbeat import read_auth_sessions_in_transaction
            auth = read_auth_sessions_in_transaction(db, rows)
        return capture, auth
    finally:
        db.close()


def read_database(state, rows=None):
    return _read_database(state, rows, False)[0]


def read_database_with_auth(state, rows):
    """Bind the complete database and private auth to one read-only transaction."""
    return _read_database(state, rows, True)


def _sequence_entries(summary):
    entries = summary.get('sqliteSequence')
    assert isinstance(entries, list) and all(isinstance(entry, list) and len(entry) == 2 for entry in entries), \
        'AUTOINCREMENT counters missing'
    assert summary['tables'].get('sqlite_sequence') == {'count': len(entries), 'sha256': typed_rows_hash(entries)}, \
        'AUTOINCREMENT counters differ from their table'
    names = [entry[0] for entry in entries]
    assert len(set(map(encoded, names))) == len(names), 'Duplicate AUTOINCREMENT counter'
    return {encoded(entry[0]): entry for entry in entries}


def assert_database_continuity(before, after, original_auth=None, current_auth=None, *,
                               carried_tables=(), log_prefixes=None):
    """Full schema and typed-cell equality, optionally composed with separately proven changes.

    `before`/`after` are capture summaries. auth_sessions may differ when both complete
    private auth tables are supplied and bound to the two summaries; the caller must have
    proven that change (for example with prove_restart_heartbeat). `carried_tables` names
    tables whose change the caller proved with the guarded-row comparison (rows a running
    service appended); `log_prefixes` maps a log table to the typed count and hash of its
    earlier rows, which must equal that table in `before`. The schema is always exact.
    """
    normalized = copy.deepcopy(after)
    if original_auth is not None or current_auth is not None:
        assert original_auth is not None and current_auth is not None, 'Heartbeat continuity needs both auth tables'
        assert before['tables']['auth_sessions'] == {'count': len(original_auth['rows']),
                                                     'sha256': typed_rows_hash(original_auth['rows'])}, 'Original auth cells differ'
        assert after['tables']['auth_sessions'] == {'count': len(current_auth['rows']),
                                                    'sha256': typed_rows_hash(current_auth['rows'])}, 'Current auth cells differ'
        normalized['tables']['auth_sessions'] = copy.deepcopy(before['tables']['auth_sessions'])
    for table in carried_tables:
        if table in before['tables'] and table in normalized['tables']:
            normalized['tables'][table] = copy.deepcopy(before['tables'][table])
    for table, prefix in (log_prefixes or {}).items():
        assert table in before['tables'] and table in normalized['tables'], 'A log table disappeared'
        assert prefix == before['tables'][table], 'Earlier log rows changed value or SQLite type'
        assert normalized['tables'][table]['count'] >= prefix['count'], 'Log rows disappeared'
        normalized['tables'][table] = copy.deepcopy(before['tables'][table])
    if log_prefixes and before.get('sqliteSequence') != after.get('sqliteSequence'):
        # Only the counters of logs that grew may move, and only forward.
        old, new = _sequence_entries(before), _sequence_entries(after)
        assert set(old) == set(new), 'AUTOINCREMENT counters added or removed'
        for key, entry in new.items():
            if entry != old[key]:
                assert entry[0] in log_prefixes, 'AUTOINCREMENT counter changed for a table without appended rows'
                assert type(entry[1]) is int and type(old[key][1]) is int and entry[1] >= old[key][1], \
                    'AUTOINCREMENT counter moved backwards'
        normalized['sqliteSequence'] = copy.deepcopy(before['sqliteSequence'])
        normalized['tables']['sqlite_sequence'] = copy.deepcopy(before['tables']['sqlite_sequence'])
    assert encoded(before) == encoded(normalized), 'Complete preexisting database changed'


def reverse_later_capture(capture, original_auth):
    """Only callers that separately reconstruct the complete auth table may use this."""
    value = copy.deepcopy(capture)
    value['summary']['tables']['auth_sessions'] = {
        'count': len(original_auth['rows']), 'sha256': typed_rows_hash(original_auth['rows'])}
    value['legacy']['auth_sessions'] = {
        'count': len(original_auth['rows']), 'sha256': legacy_rows_hash(original_auth['rows'])}
    return value


def verify_update_database(update, final, state, *, allow_existing_browser_heartbeat=False, later_witness=None, web_session_policy=None):
    """Recompute a saved non-migration update proof on the owning host. Return no private cells.

    Migrated updates are rejected here; they are checked by update.assert_migration_preserved.
    """
    from auth_heartbeat import restore_timestamp, restore_witness, verify_restart_witness, session_policy
    before, after = update['before'], update['after']
    identity = before['identity']
    session_policy(identity, web_session_policy)
    web_session_policy = web_session_policy or {'m4': 'browser-cookie', 'm1': 'worker-relay', 'm3': 'worker-relay'}.get(identity)
    assert after['identity'] == final['identity'] == identity
    for value in (before, after, final):
        assert value.get('webSessionPolicy', web_session_policy) == web_session_policy, 'Database proof web session policy differs'
        if identity not in {'m4', 'm1', 'm3'}:
            assert value.get('webSessionPolicy') == web_session_policy, 'Generic database proof requires bound policy'
    assert final['artifactSourceCommit'] == after['artifactSourceCommit']
    assert final['archiveSha256'] == after['archiveSha256']
    assert all('databaseCapture' in value for value in (before, after, final)), 'Complete database proof missing'
    assert update['rowPreservation'] in {'byte-identical', 'verified-existing-browser-heartbeat'}, \
        'Only non-migration updates have a complete continuity proof'
    heartbeat = update.get('authHeartbeatWitness')
    current, current_auth = (read_database_with_auth(state, final['rows']) if heartbeat or later_witness
                             else (read_database(state, final['rows']), None))
    assert encoded(current) == encoded(final['databaseCapture']), 'Live complete database differs from final snapshot'
    if later_witness is not None:
        assert identity == 'm4' and set(later_witness) == {'beforeLastConnectedAt', 'afterLastConnectedAt'}
        current_auth = restore_timestamp(current_auth, later_witness['beforeLastConnectedAt'],
                                         later_witness['afterLastConnectedAt'], after['rows'])
        current = reverse_later_capture(current, current_auth)
    assert encoded(current) == encoded(after['databaseCapture']), 'Complete database changed after update'
    original_auth, verified_heartbeat = None, None
    if heartbeat is not None:
        assert allow_existing_browser_heartbeat, 'Restart heartbeat acceptance requires explicit opt-in'
        assert update['restartStartedAt'] == heartbeat['restartStartedAt']
        assert after['observedAt'] == heartbeat['observedAfterAt']
        verified_heartbeat = verify_restart_witness(before['rows'], after['rows'], heartbeat, current_auth, identity=identity, web_session_policy=web_session_policy)
        original_auth = restore_witness(current_auth, heartbeat, before['rows'])
        expected_kind = 'verified-existing-browser-heartbeat'
    else:
        assert after['rows'] == before['rows'], 'Unwitnessed protected cells changed'
        expected_kind = 'byte-identical'
    assert_database_continuity(before['databaseCapture']['summary'], after['databaseCapture']['summary'],
                               original_auth, current_auth if heartbeat else None)
    assert type(update['rowsByteIdentical']) is bool and update['rowsByteIdentical'] == (before['rows'] == after['rows'])
    assert update['rowPreservation'] == expected_kind, 'Preservation classification differs from reconstructed proof'
    return {'authHeartbeatWitness': verified_heartbeat,
            'finalDatabaseSha256': digest(encoded(final['databaseCapture']['summary']))}
