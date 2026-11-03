"""The update agent's snapshot of a large database: an admission read that costs what may change,
not the database, with the helper's own read as the baseline.

Before this, `update.py --snapshot` (the agent's snapshot, taken before every apply that is not
held by Update now) read every row of every table, hashed and sorted, in Python. On M4's 22 GB
database (20 GB of it the orchestration_events log) that took 289-538 s at 98% CPU and 22.8 GB
RSS, against 2-3 s on a small database. The helper then read the whole database again for its
own baseline and compared the two reads; anything a running service changed in the minutes
between them refused the apply ("Guarded prestate changed: rows") and the agent read it all again.

An admission snapshot (`snapshotMode: 'admission'`) is taken instead when the database file is
ADMISSION_BYTES or larger. In one read-only transaction it judges idle work, counts the guarded
tables the quiet check compares (update_agent.work_counts; the v1 logs, which it leaves out, are
not counted), and records what the helper's full read must still show unchanged:

- the schema hash, the project ids and the thread ids;
- the legacy {count, sha256} of every table the full comparison keeps exact (every table but the
  logs, the thread-keyed projections, the projection cursors, auth_sessions and sqlite_sequence),
  each read in full up to ROW_BUDGET rows, and its count beyond that;
- the projection cursors' hashes without their moving columns (update_read.cursor_hashes);
- the AUTOINCREMENT counters, and where each log ended (its largest rowid).

None of these reads a log's rows, so the read scales with the tables that must stay exact, not
with the history. The helper (update.py _apply) measures appended rows against those log ends in
its own single full read (update_read.carried_since) and refuses, before it writes anything,
unless that read shows every recorded fact as it was, new thread ids only for streams with new
events, and AUTOINCREMENT counters moved only forward and only for logs that grew
(assert_admitted). It then takes its own read as the baseline, as for a held snapshot: the
prestate re-read, the checks after the gate and right before the stop, and the proof across the
restart all compare against that read, exactly as before. What no longer reaches back to the
agent's moment is the byte-identity of earlier log rows and of thread projection rows of streams
with no new events: the helper's baseline is taken idle, and everything from it on stays proved,
so no row the update could lose goes unchecked. A database with a virtual table, or below
ADMISSION_BYTES, takes the full snapshot as before. Stdlib only.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import os
import re

import database_continuity as continuity
import live_database
import update_read

MODE = 'admission'
VERSION = 1
# A full read below this costs seconds (M1, 0.16 GB: 1.7-4.9 s), and keeps its exact comparison.
ADMISSION_BYTES = 1 << 30
# Rows read and hashed per exact table; a larger table is compared by its count.
ROW_BUDGET = 250000
# Logs the quiet check never compares (update_agent.BOOKKEEPING_COUNTS): not counted here.
UNCOUNTED = ('orchestration_events', 'orchestration_command_receipts')
REFUSAL = 'Guarded prestate changed: rows'


def wanted(state):
    """Whether the agent's snapshot of `state` (a userdata folder) is an admission read."""
    try:
        return os.stat(str(state / 'statev2.sqlite')).st_size >= ADMISSION_BYTES
    except OSError:
        return False


def _thread_table(db, table):
    return update_read.is_projection_table(table) and bool(update_read.stream_column(update_read.table_columns(db, table)))


def exempt(db, table):
    """Tables the full comparison lets a running service change (rows_carried_forward), or that
    are compared another way here."""
    return (table in update_read.LOG_TABLES or table in update_read.CURSOR_COLUMNS
            or table in ('auth_sessions', 'sqlite_sequence') or _thread_table(db, table))


def read(state):
    """(rows, proof) of the admission snapshot in one read transaction, or None for a database
    with a virtual table (the full snapshot reads it in its own order). Refuses busy work."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        for table in tables:
            if not re.fullmatch('[a-z0-9_]+', table):
                raise AssertionError('Unexpected table identifier')
        if update_read.virtual_tables(db, tables):
            return None
        update_read.assert_idle(db)
        def count(table):
            return db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
        counts = {table: count(table) for table in tables if table not in UNCOUNTED
                  and (table.startswith(('projection_', 'orchestration_', 'project_')) or table in update_read.AUTHORITY_TABLES)}
        exact, sized = {}, {}
        for table in tables:
            if exempt(db, table):
                continue
            rows = list(db.execute('SELECT * FROM ' + table + ' LIMIT ' + str(ROW_BUDGET + 1)))
            if len(rows) > ROW_BUDGET:
                sized[table] = count(table)
            else:
                exact[table] = {'count': len(rows), 'sha256': continuity.legacy_rows_hash(rows)}
            del rows
        thread_ids = {row[0] for row in db.execute('SELECT thread_id FROM projection_threads')}
        if 'orchestration_v2_projection_threads' in tables:
            thread_ids.update(row[0] for row in db.execute('SELECT thread_id FROM orchestration_v2_projection_threads'))
        sequence = (sorted([list(row) for row in db.execute('SELECT * FROM sqlite_sequence')], key=continuity.encoded)
                    if 'sqlite_sequence' in tables else None)
        proof = {'version': VERSION,
                 'schemaSha256': continuity.digest(continuity.encoded(continuity.schema(db))),
                 'projectIds': sorted(row[0] for row in db.execute('SELECT project_id FROM projection_projects')),
                 'threadIds': sorted(thread_ids), 'exact': exact, 'sized': sized,
                 'cursorSha256': update_read.cursor_hashes(db, tables, lambda table: db.execute('SELECT * FROM ' + table)),
                 'logRowids': update_read.log_rowids(db, tables), 'sqliteSequence': sequence}
        return {'nativeWorkIdle': True, 'counts': counts}, proof
    finally:
        db.close()


def snapshot(identity, take_snapshot, service):
    """The agent's snapshot without a hold: an admission snapshot for a large database, else
    `take_snapshot(identity, False)` (update._snapshot), the full one. Every service, file,
    process and listener check runs as for the full snapshot. `service` is update._service."""
    try:
        own = service(identity)['own'] / 'userdata'
    except Exception:  # The full snapshot reads the service record again and refuses with its own message.
        own = None
    reads = read(own) if own is not None and wanted(own) else None
    if reads is None:
        return take_snapshot(identity, False)[0]
    rows, proof = reads
    value = take_snapshot(identity, False, reads=(rows, None, None, None))[0]
    value.pop('databaseCapture')
    value.update(snapshotMode=MODE, admissionProof=proof)
    return value


def since(expected):
    """The rows a helper's full read measures appended rows against: the admission's log ends."""
    proof = expected.get('admissionProof')
    assert valid(proof), 'Admission snapshot proof missing'
    return {update_read.ACTIVITY_KEY: {'logRowids': dict(proof['logRowids']), 'threadTables': [],
                                      'threadSha256': {}, 'cursorSha256': {}}}


def valid(proof):
    return (isinstance(proof, dict) and proof.get('version') == VERSION
            and all(isinstance(proof.get(key), dict) for key in ('exact', 'sized', 'cursorSha256', 'logRowids'))
            and all(isinstance(proof.get(key), list) for key in ('projectIds', 'threadIds'))
            and isinstance(proof.get('schemaSha256'), str)
            and (proof.get('sqliteSequence') is None or isinstance(proof['sqliteSequence'], list)))


def assert_admitted(proof, before, carried):
    """Refuses (REFUSAL, retried by the agent) unless the helper's own full read `before` (a
    snapshot with its databaseCapture) shows what the admission snapshot recorded, given the rows
    appended since it (`carried`, measured against since(expected) in that same read)."""
    assert valid(proof), 'Admission snapshot proof missing'
    rows, capture = before['rows'], before.get('databaseCapture')
    assert isinstance(capture, dict), 'Complete database proof missing'
    legacy, summary = capture['legacy'], capture['summary']
    assert summary['schemaSha256'] == proof['schemaSha256'], 'Guarded prestate changed: schema'
    assert isinstance(carried, dict) and set(carried.get('appendedRows', {})) == set(proof['logRowids']), REFUSAL
    assert rows['projectIds'] == proof['projectIds'], REFUSAL
    old, new, touched = set(proof['threadIds']), set(rows['threadIds']), set(carried['touchedStreams'])
    assert old <= new and new - old <= touched, REFUSAL
    for table, entry in proof['exact'].items():
        assert legacy.get(table) == entry, REFUSAL
    for table, count in proof['sized'].items():
        assert isinstance(legacy.get(table), dict) and legacy[table]['count'] == count, REFUSAL
    # A table the admission read neither hashed nor exempted (it could not exist then: the schema is equal).
    measured = set(proof['exact']) | set(proof['sized'])
    assert all(table in measured or table in update_read.LOG_TABLES or table in update_read.CURSOR_COLUMNS
               or table in ('auth_sessions', 'sqlite_sequence') or table in rows[update_read.ACTIVITY_KEY]['threadTables']
               for table in legacy), REFUSAL
    assert rows[update_read.ACTIVITY_KEY]['cursorSha256'] == proof['cursorSha256'], REFUSAL
    now = summary.get('sqliteSequence')
    if proof['sqliteSequence'] != now:
        assert isinstance(now, list) and isinstance(proof['sqliteSequence'], list), REFUSAL
        old_counters = {continuity.encoded(entry[0]): entry for entry in proof['sqliteSequence']}
        new_counters = {continuity.encoded(entry[0]): entry for entry in now}
        assert set(old_counters) == set(new_counters), REFUSAL
        for key, entry in new_counters.items():
            if entry != old_counters[key]:
                assert carried['appendedRows'].get(entry[0], 0) > 0, REFUSAL
                assert type(entry[1]) is int and type(old_counters[key][1]) is int and entry[1] >= old_counters[key][1], REFUSAL
