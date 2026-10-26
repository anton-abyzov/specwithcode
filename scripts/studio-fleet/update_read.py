"""The update's database reads, split from update.py: protected rows, private auth, rows
appended since an earlier proof and the complete database capture, all measured in one
read-only transaction (_read_state), and the idle check judged in that transaction's own
snapshot. update.py imports every name here, so callers and receipts use it as before;
patch a name read here (_read_tables, run_work, read_auth_sessions_in_transaction,
SINGLE_SCAN_SQLITE) on this module.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import hashlib
import json
import re
import sqlite3

from auth_heartbeat import encoded, read_auth_sessions_in_transaction
import database_continuity as continuity
import kept_lines
import live_database


def digest(value):
    return hashlib.sha256(value).hexdigest()

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

# Sign-in sessions, pairing credentials, principal revocations (migration 067), provider
# runtime and schedules: rows here grant or withdraw access or run work, so a migration may
# create these tables only empty and may never add a trigger that touches them.
AUTHORITY_TABLES = ('auth_pairing_links', 'auth_principal_revocations', 'auth_sessions', 'provider_session_runtime',
                    'scheduled_tasks', 'scheduled_task_run_receipts')

def _read_state(state, include_auth, since=None, include_database=False, widen_from=None):
    """Protected rows, private auth, rows appended after `since` and the complete database
    capture, all measured in one read-only transaction. `widen_from` (an earlier capture's
    schema columns) also measures tables that gained columns since (accepted_widenings).
    With the capture, its one scan of each table also serves the guarded hashes, the auth
    invariant, the projection cursors and the carried log prefixes (_read_tables). A database
    with a virtual table is read protected rows first, then the idle check, then the rest."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        if virtual_tables(db, tables):
            # A virtual table's module makes its rows on every read: two reads of an FTS5 table
            # over a view of random() can differ, its hidden column counts the cursors this
            # connection opened, and a module may read its own tables to connect (an R*Tree
            # reads its root node). What a read of it gives then depends on what this connection
            # read before, so such a database is read in the order releases before the single
            # scan read every database, each read as they made it: protected rows first (the
            # table names checked and the guarded tables hashed in name order), then the idle
            # check, then the rest. statev2 has no virtual table;
            # SpecWithCode keeps its only FTS5 table in each project's knowledge index, a
            # database of its own.
            return _read_tables(db, tables, include_auth, since, include_database, widen_from, check_idle=True)
        for table in tables:
            if not re.fullmatch('[a-z0-9_]+', table):
                raise AssertionError('Unexpected table identifier')
        # Idle first: reading every table takes minutes on a large database, and a busy
        # service is refused anyway. It is judged in this read's own snapshot, the one the
        # rows below come from. Against helpers that hashed the guarded tables first, only the
        # order of refusals changes: an unexpected table name, then a busy service or an idle
        # query that cannot run (a missing idle table, an undecodable or corrupt idle row), are
        # refused before any row is read, also where a row could not be read (a corrupt page,
        # undecodable text); test-update-read-speed.py RefusalOrder.
        assert_idle(db)
        if not include_database:
            return _read_tables(db, tables, include_auth, since, False, None)
        # Inside kept_lines.keeping (update.py's read before the restart) the single scan also
        # hands over the sorted lines of the largest tables for after_proof; nothing else changes.
        keep = kept_lines.active()
        try:
            return _read_tables(db, tables, include_auth, since, True, widen_from, once=True,
                                **({'keep': keep} if keep is not None else {}))
        except Exception:
            if keep is not None:
                keep.clear()
            # The single scan met a fault (a read that succeeds never comes here; an interrupt
            # is not caught). If SQLite has already ended the transaction (an I/O, disk-full or
            # out-of-memory error), its error stands: no snapshot is left to read again.
            if not db.in_transaction:
                raise
        # Otherwise the original order runs again in this transaction, after the failed scan's
        # rows are let go: the first fault it meets is what helpers that read in that order
        # answer, and without one its rows are the answer. Without a virtual table, a table
        # gives the same rows each time this transaction reads it.
        return _read_tables(db, tables, include_auth, since, True, widen_from)
    finally:
        db.close()

def _read_tables(db, tables, include_auth, since, include_database, widen_from, *, once=False, check_idle=False, keep=None):
    """The rest of _read_state, in its read transaction. With `once`, the complete capture
    comes first: its legacy hashes are the guarded hashes (the same encoding), it hashes the
    logs' earlier rows in the same scan (log_prefixes), and it hands over the rows of
    auth_sessions and the projection cursors, the only rows kept, and hashes the thread-keyed
    projections per stream as it goes (ThreadRows). Otherwise every part reads its own rows in the
    original order, the capture last; with `check_idle`, protected rows first, then the idle
    check, then the rest. `keep` (kept_lines.Kept, with `once` only) is handed the capture's sorted
    lines."""
    database, scanned, prefixes = None, None, None
    if once:
        # Complete schema and typed cells of every table, bound to the protected rows in
        # this same read transaction. Hashes and schema text only; no cell values.
        scanned, threads = {}, ThreadRows(db)
        def visit(table, rows):
            if table == 'auth_sessions' or table in CURSOR_COLUMNS: scanned[table] = rows
            threads.visit(table, rows)
        prefixes = log_prefixes(db, tables, since) if since is not None else None
        database = continuity.capture_connection(db, widen_from, visit=visit, prefixes=prefixes,
                                                  **({'keep': keep} if keep is not None else {}))
        guarded = [table for table in tables
                   if table.startswith(('projection_', 'orchestration_', 'project_')) or table in AUTHORITY_TABLES]
        counts = {table: database['legacy'][table]['count'] for table in guarded}
        hashes = {table: database['legacy'][table]['sha256'] for table in guarded}
    else:
        counts, hashes = guarded_hashes(db, tables)
        if check_idle: assert_idle(db)
    thread_ids = {row[0] for row in db.execute('SELECT thread_id FROM projection_threads')}
    if 'orchestration_v2_projection_threads' in tables:
        thread_ids.update(row[0] for row in db.execute('SELECT thread_id FROM orchestration_v2_projection_threads'))
    proof = {'projectIds': sorted(row[0] for row in db.execute('SELECT project_id FROM projection_projects')),
             'threadIds': sorted(thread_ids),
             'counts': counts, 'hashes': hashes, 'nativeWorkIdle': True}
    if 'auth_sessions' in tables:
        proof[AUTH_INVARIANT_KEY] = auth_invariant_hash(db, scanned.pop('auth_sessions') if once else None)
    proof[ACTIVITY_KEY] = append_only_activity(db, tables, scanned, threads if once else None)
    # Keep complete auth cells separate from every serializable public proof. A database
    # without the auth table has no session to capture (a migration may create it).
    auth = read_auth_sessions_in_transaction(db, proof) if include_auth and 'auth_sessions' in tables else None
    # Measured in the same read transaction as the proof it is compared with.
    carried = carried_since(db, tables, since, prefixes) if since is not None else None
    if include_database and not once:
        # Complete schema and typed cells of every table, bound to the protected rows in
        # this same read transaction. Hashes and schema text only; no cell values.
        database = continuity.capture_connection(db, widen_from)
    # After a single scan, whose guarded hashes came from the capture, bind_rows checks the shape.
    if database is not None: continuity.bind_rows(database, proof)
    if keep is not None: keep.complete = True
    return proof, auth, carried, database

def assert_idle(db):
    """Refuses unless native work is idle in this read's own snapshot. Its run statuses, one
    string a run, are let go when it returns."""
    runs = run_work(db)[0]
    requests = db.execute("SELECT count(*) FROM orchestration_v2_projection_runtime_requests WHERE status='pending'").fetchone()[0]
    # EffectOutbox.ts uses succeeded (not run-status completed). Unknown/NULL
    # values remain nonidle; retain every terminal row in the preservation hash.
    effects = db.execute("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status IS NULL OR status NOT IN ('succeeded','failed','cancelled')").fetchone()[0]
    sessions = db.execute("SELECT count(*) FROM orchestration_v2_projection_provider_sessions WHERE status IN ('running','working','connecting','starting')").fetchone()[0]
    assert all(status in TERMINAL_RUNS for status in runs) and requests == effects == sessions == 0, 'Native work is not idle'

# The single scan runs on SQLite 3.37.0 and newer only; an older SQLite, which no test here
# runs on, reads every database protected rows first, then the idle check, then the rest.
SINGLE_SCAN_SQLITE = (3, 37, 0)
# SQLite reads each table from its stored CREATE text: text whose first two words are CREATE
# TABLE makes an ordinary table, and SQLite writes every ordinary table's text so.
ORDINARY_TABLE = re.compile(rb'CREATE[ \t\n\f\r]+TABLE[ \t\n\f\r]', re.IGNORECASE)

def virtual_tables(db, tables):
    """The tables whose stored CREATE text does not start as ORDINARY_TABLE, read from
    sqlite_master alone, as bytes (text that cannot be decoded is still read): every virtual
    table, also one whose text was rewritten with PRAGMA writable_schema ('CREATE VIRTUAL  TABLE',
    'create virtual\\ntable'), and any other text, even an ordinary table's (a comment between
    the words), so none is missed. Not pragma_table_list: it connects each virtual table's
    module first, and a module that reads its own tables to connect (an R*Tree reads its root
    node) would read them before the guarded reads do. Before SINGLE_SCAN_SQLITE every one of
    `tables` counts."""
    if sqlite3.sqlite_version_info < SINGLE_SCAN_SQLITE:
        return set(tables)
    return {name for name, text in db.execute("SELECT name, CAST(sql AS BLOB) FROM sqlite_master WHERE type='table'")
            if not ORDINARY_TABLE.match(text or b'')}

def guarded_hashes(db, tables):
    """({table: count}, {table: hash}) of every guarded table, read one by one in name order,
    each table name checked before it is read: protected rows first, as releases before the
    single scan read them."""
    counts, hashes = {}, {}
    for table in tables:
        if not re.fullmatch('[a-z0-9_]+', table):
            raise AssertionError('Unexpected table identifier')
        if table.startswith(('projection_', 'orchestration_', 'project_')) or table in AUTHORITY_TABLES:
            counts[table], hashes[table] = guarded_rows(db, table)
    return counts, hashes

def guarded_rows(db, table):
    """(count, hash) of a guarded table's rows, read on their own. Hash only in memory. Never
    return columns, credentials, prompts or native IDs."""
    rows = sorted(json.dumps(list(row), default=lambda value: value.hex(), separators=(',', ':')) for row in db.execute('SELECT * FROM ' + table))
    return len(rows), digest(('\n'.join(rows)).encode())

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

def append_only_activity(db, tables, scanned=None, threads=None):
    """In-memory hashes and row positions only; no content leaves the transaction. `scanned`
    holds rows of some of the tables read here (the projection cursors), read earlier in this
    transaction by the complete capture; each is used once and let go, and any other table is
    read here, row by row. `threads` (ThreadRows) holds the thread-keyed projections' hashes
    from that same scan, which then reads none of them again."""
    def rows_of(table):
        return scanned.pop(table) if scanned is not None and table in scanned else db.execute('SELECT * FROM ' + table)
    logs = log_rowids(db, tables)
    if threads is not None:
        assert threads.visited == tables, 'The complete capture did not visit every table'
        return {'logRowids': logs, 'threadTables': sorted(threads.tables), 'threadSha256': threads.digests(),
                'cursorSha256': cursor_hashes(db, tables, rows_of)}
    thread_tables, buckets = [], {}
    for table in tables:
        columns = table_columns(db, table)
        key = stream_column(columns)
        if not (is_projection_table(table) and key) or table in CURSOR_COLUMNS:
            continue
        thread_tables.append(table)
        index = columns.index(key)
        for row in rows_of(table):
            buckets.setdefault(stream_key(row[index]), []).append(thread_line(table, row))
    return {'logRowids': logs, 'threadTables': sorted(thread_tables),
            'threadSha256': {key: thread_digest(lines) for key, lines in buckets.items()},
            'cursorSha256': cursor_hashes(db, tables, rows_of)}

class ThreadRows:
    """appendOnlyActivity's threadTables and threadSha256 from the complete capture's scan
    (visit, handed each table's rows in name order), equal to append_only_activity's own read.
    A stream's sorted lines are its tables' sorted lines in name order: each line starts with
    its table's quoted name, and '"' sorts before every character a table name holds. So each
    table's lines go into their stream's running hash (thread_digest's bytes) as the table is
    visited, a run at a time (continuity.update_joined), and are let go with its rows: no table
    is read again for the activity, and no stream's lines are held past their own table."""

    def __init__(self, db):
        self.db, self.visited, self.tables, self.hashers = db, [], [], {}

    def visit(self, table, rows):
        assert not self.visited or self.visited[-1] < table, 'Tables visited out of name order'
        self.visited.append(table)
        columns = table_columns(self.db, table)
        key = stream_column(columns)
        if not (is_projection_table(table) and key) or table in CURSOR_COLUMNS:
            return
        self.tables.append(table)
        index, streams = columns.index(key), {}
        for row in rows:
            streams.setdefault(stream_key(row[index]), []).append(thread_line(table, row))
        for stream, lines in streams.items():
            hasher = self.hashers.get(stream)
            if hasher is None:
                hasher = self.hashers[stream] = hashlib.sha256(b'studio-thread-rows-v1\n')
            else:
                hasher.update(b'\n')
            lines.sort()
            continuity.update_joined(hasher, lines)

    def digests(self):
        return {stream: hasher.hexdigest() for stream, hasher in self.hashers.items()}

def log_rowids(db, tables):
    """{log table: its largest rowid} (appendOnlyActivity logRowids)."""
    return {table: db.execute('SELECT coalesce(max(rowid), 0) FROM ' + table).fetchone()[0]
            for table in LOG_TABLES if table in tables and has_rowid(db, table)}

def thread_line(table, row):
    return json.dumps(table) + ',' + encoded_row(row)

def thread_digest(lines):
    """The hash of one stream's projection rows (appendOnlyActivity threadSha256)."""
    return digest(('studio-thread-rows-v1\n' + '\n'.join(sorted(lines))).encode())

def cursor_hashes(db, tables, rows_of):
    """{cursor table: hash of its rows without the moving columns} (appendOnlyActivity cursorSha256)."""
    cursors = {}
    for table, moving in CURSOR_COLUMNS.items():
        if table in tables:
            columns = table_columns(db, table)
            keep = [index for index, name in enumerate(columns) if name not in moving]
            cursors[table] = digest(('studio-projection-cursor-v1\n' + '\n'.join(sorted(
                json.dumps([[columns[index], row[index]] for index in keep], default=lambda value: value.hex(),
                           separators=(',', ':')) for row in rows_of(table)))).encode())
    return cursors

def activity_digest(activity):
    return digest(json.dumps(activity, sort_keys=True, separators=(',', ':')).encode())

def valid_activity(activity):
    return (isinstance(activity, dict) and set(activity) == {'logRowids', 'threadTables', 'threadSha256', 'cursorSha256'}
            and isinstance(activity['logRowids'], dict) and isinstance(activity['threadTables'], list)
            and isinstance(activity['threadSha256'], dict) and isinstance(activity['cursorSha256'], dict)
            and all(table in LOG_TABLES and type(value) is int and value >= 0 for table, value in activity['logRowids'].items()))

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

def rowid_is_a_column(db, table):
    """A declared column named rowid hides the row position from `WHERE rowid ...`."""
    return any(row[1].lower() == 'rowid' for row in db.execute('PRAGMA table_xinfo(' + table + ')'))

def has_covering_index(db, table):
    """An index holding every column but the primary key's (the rowid is in every index): a
    full scan may read such an index instead of the table, while `WHERE rowid <= ?` reads the
    table, and a stale or redefined index would then give other rows. Partial and expression
    indexes count too; leaving a log out only reads it as before."""
    columns = {row[1] for row in db.execute('PRAGMA table_xinfo(' + table + ')') if row[6] == 0}
    keys = {row[1] for row in db.execute('PRAGMA table_info(' + table + ')') if row[5]}
    for (index,) in db.execute('SELECT name FROM pragma_index_list(?)', (table,)).fetchall():
        if columns - keys <= {row[0] for row in db.execute('SELECT name FROM pragma_index_info(?)', (index,))}:
            return True
    return False

def log_prefixes(db, tables, expected):
    """The logs of `expected` whose earlier rows the complete capture hashes in its own scan
    ({table: {'boundary': rowid}}, for continuity.capture_connection): rowid tables whose
    rowid is the row position and whose full scan reads the table b-tree, as `WHERE rowid <= ?`
    does (no index holds every column; the single scan reads no virtual table, _read_state).
    carried_since reads any other log as before."""
    activity = expected.get(ACTIVITY_KEY) if isinstance(expected, dict) else None
    if not valid_activity(activity):
        return None
    return {table: {'boundary': boundary} for table, boundary in activity['logRowids'].items()
            if table in tables and has_rowid(db, table) and not rowid_is_a_column(db, table)
            and not has_covering_index(db, table)}

def carried_since(db, tables, expected, prefixes=None):
    """Rows the running service appended after `expected` was measured. Earlier log rows
    are rehashed at the recorded positions, in the format of the proof's table hashes.
    `prefixes` (log_prefixes, filled by this transaction's complete capture) holds those
    hashes for the logs it names, so they are not read a second time."""
    activity = expected.get(ACTIVITY_KEY) if isinstance(expected, dict) else None
    if not valid_activity(activity):
        return None
    prefix, typed, appended, streams = {}, {}, {}, set()
    for table, boundary in activity['logRowids'].items():
        if table not in tables or not has_rowid(db, table):
            return None
        if prefixes and table in prefixes:
            assert prefixes[table]['boundary'] == boundary
            legacy = prefixes[table]['legacy']
            prefix[table] = [legacy['count'], legacy['sha256']]
            typed[table] = dict(prefixes[table]['typed'])
        else:
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

AUTH_INVARIANT_KEY = 'authSessionsInvariantSha256'
AUTH_HEARTBEAT_COLUMN = 'last_connected_at'
# The app version a connect reports (AuthSessions.ts setClientConnectionRow), shown in the sessions
# list only. A desktop app relaunched into a new release reports it on its first connect, which landed
# between the agent's snapshot and the apply on every first attempt from 1.0.46 to 1.0.60. The surface
# written beside it stays guarded: the heartbeat proof classifies sessions by it (active_session), so
# a change refuses here, before the restart, rather than rolling back after it.
AUTH_APP_VERSION_COLUMN = 'client_app_version'

def auth_invariant_hash(db, scanned=None):
    """Hash every auth_sessions cell except what a connect rewrites on its own: the heartbeat (a
    connected browser or desktop app rewrites last_connected_at every few seconds) and the app
    version it reports (AUTH_APP_VERSION_COLUMN). Identity, surface, scopes, credentials, expiry
    and revocation all stay guarded, including SQLite types and the complete schema. Hashed in
    memory only. Older invariant hashes fail closed: read a receipt back with the release's own
    helper (v2 until 1.0.60 also hashed the app version). `scanned` is the table's rows when
    this transaction already read them."""
    columns = [row[1] for row in db.execute('PRAGMA table_info(auth_sessions)')]
    skipped = {AUTH_HEARTBEAT_COLUMN, AUTH_APP_VERSION_COLUMN}
    keep = [index for index, name in enumerate(columns) if name not in skipped]
    schema = [[list(row) for row in db.execute('PRAGMA table_xinfo(auth_sessions)')],
              [list(row) for row in db.execute(
                  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='auth_sessions' ORDER BY type,name")]]
    rows = sorted(encoded([(columns[index], type(row[index]).__name__, row[index]) for index in keep])
                  for row in (db.execute('SELECT * FROM auth_sessions') if scanned is None else scanned))
    return digest(('studio-auth-invariant-v3\n' + encoded(schema) + '\n' + '\n'.join(rows)).encode())

def is_projection_table(table):
    return table.startswith('projection_') or '_projection_' in table
