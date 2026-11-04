"""Database policies used by the owned updater; the original full proof stays unchanged."""
def compare(n, before, after, original_auth, current_auth, after_carried, restart_started_at, identity, policy, allow_project_migrations, allow_existing_browser_heartbeat):
    heartbeat = None
    appended = False
    migration_cells = None
    widenings = {}
    if allow_project_migrations:
        if 'databaseCapture' in before:
            assert 'databaseCapture' in after, 'Complete database proof missing after restart'
            widenings = n.accepted_widenings(before['databaseCapture'], after['databaseCapture'], before['rows'])
        # Migrations 067 and 069 widen auth_sessions; its proofs then compare the earlier columns.
        heartbeat = n.prove_migration_preserved(
            before['rows'], n.narrowed_rows(after['rows'], widenings), original_auth,
            n.principal_auth(current_auth, after['rows'], widenings),
            restart_started_at, after['observedAt'], identity=identity,
            allow_existing_browser_heartbeat=allow_existing_browser_heartbeat,
            carried=after_carried, web_session_policy=policy)
        if 'databaseCapture' in before:
            assert 'databaseCapture' in after, 'Complete database proof missing after restart'
            n.assert_migration_typed_cells(before['databaseCapture'], after['databaseCapture'],
                                         before['rows'], after['rows'], after_carried, widenings)
            n.assert_migration_protected_schema(before['databaseCapture'], after['databaseCapture'],
                                              before['rows'], widenings)
            migration_cells = 'typed-verified'
    elif allow_existing_browser_heartbeat:
        # Rows the services appended carry forward as below (a project's startup settings
        # save, a usage-limit check). Every auth cell except what a reconnect writes stays
        # exact through the invariant hash, and the heartbeat itself is proven separately
        # against the old non-auth rows, so neither allowance widens the other.
        appended = (n.carried_applies(before['rows'], after['rows'], after_carried)
                    and all('auth_sessions' in rows[key] for rows in (before['rows'], after['rows'])
                            for key in ('counts', 'hashes'))
                    and n.auth_comparison(before['rows'], after['rows']) != after['rows'])
        if appended:
            assert n.same_guarded_rows(before['rows'], after['rows'], after_carried),\
                'Existing projects, history or auth rows changed'
            heartbeat_after = n.auth_comparison(before['rows'], after['rows'])
        else:
            heartbeat_after = after['rows']
        heartbeat = n.prove_restart_heartbeat(before['rows'], heartbeat_after, original_auth, current_auth,
                                            restart_started_at, after['observedAt'], identity=identity, web_session_policy=policy)
    else:
        # Rows the old service appended before it stopped, or the new one appended since,
        # carry forward; auth stays byte-exact here (heartbeats need their own proof).
        assert n.same_guarded_rows(before['rows'], after['rows'], after_carried, auth_heartbeat=False),\
            'Existing projects, history or auth rows changed'
    database_continuity = 'not-compared-migration' if allow_project_migrations else 'not-captured'
    if not allow_project_migrations and 'databaseCapture' in before:
        # Every table and the schema must be unchanged. Only a proven heartbeat may differ,
        # and only in auth_sessions; without one, rows the services appended carry forward
        # under the same allowance as the guarded rows above.
        assert 'databaseCapture' in after, 'Complete database proof missing after restart'
        if heartbeat is not None and appended:
            allowance = n.database_allowance(before['rows'], after['rows'], after_carried, auth_heartbeat=False)
            n.continuity.assert_database_continuity(before['databaseCapture']['summary'], after['databaseCapture']['summary'],
                                                  original_auth, current_auth,
                                                  carried_tables=allowance['tables'],
                                                  log_prefixes=allowance['logPrefixes'])
        elif heartbeat is not None:
            n.continuity.assert_database_continuity(before['databaseCapture']['summary'], after['databaseCapture']['summary'],
                                                  original_auth, current_auth)
        else:
            n.assert_capture_carried(before['databaseCapture'], after['databaseCapture'], before['rows'], after['rows'],
                                   after_carried, auth_heartbeat=False, message='Complete preexisting database changed')
        database_continuity = 'verified'
    return heartbeat, appended, migration_cells, widenings, database_continuity


import datetime
import os
import contextlib
import pathlib
import re
import sqlite3
import subprocess
import time
import urllib.parse

import disk_room
import quiescence
import service_handles

PAGE_VERIFY_ATTEMPTS = 5  # Each costs seconds; giving up costs minutes of full reads.
PAGE_VERIFY_QUIET_SECONDS = 1.0
PAGE_VERIFY_QUIET_WAIT_SECONDS = 15
# The restarted service runs git, gh and python3 for milliseconds at a time while it starts, and one
# seen in the process inventory cost M4 345 s of full reads on 1.0.162 (M1, 121 MB, paid 4 s for the
# same refusal). A child that stays past this also refuses the full read, so waiting loses nothing.
# Each owned child the page proof's capture sees is followed by pid and start time and must exit
# within it, holding none of the database files: on a busy service (M4 resumes agent turns as it
# starts) a new git or ps is always running, so waiting for one capture with none never ended.
PAGE_VERIFY_DESCENDANT_SECONDS = 30
PAGE_VERIFY_DESCENDANT_POLL_SECONDS = 0.25
PASSING_CHILD_REFUSALS = ('Owned service has unexpected descendants', 'Owned process identities changed during inventory',
                          *sorted(quiescence.VANISHED_READS))  # A child that exited before its kernel read.
DATABASE_HELD_BY_CHILD = 'An owned child process holds the database open'
CHILD_REFUSALS_KEPT = 20  # pageChildRefusals in the receipt: the first ones, each naming its processes.
# Rows of one authority table or identity set. M4's 48,000 auth sessions and 54,000 pairing links
# (October 31, 2026) cost about 2 s a read, and past the old 20,000 every held install silently
# took three full reads of the database.
AUTHORITY_ROW_BUDGET = 500000
FULL_READ_NO_ROOM = ('Not enough free disk space for the full database read that migration %s needs after the restart: '
                     'needs %.1f GB, %.1f GB free (refused before the service stops)')
FULL_READ_NO_MEMORY = ('Not enough memory for the full database read that migration %s needs after the restart: its sorted '
                       'runs cannot go to disk on this volume and need about %.1f GB (refused before the service stops)')
# Appended to FULL_READ_NO_ROOM: what the need is made of, so the receipt's error (the five-key
# preflight receipt installed update agents read, update_receipt.write_preflight_failure) names it.
ROOM_PARTS = '; pageFallback %.1f GB, backupSpace %.1f GB'
# Bytes of sorted runs per byte of the largest table's b-tree (disk_room.FULL_READ_LINE_FACTOR).
FULL_READ_LINE_FACTOR = disk_room.FULL_READ_LINE_FACTOR


class DatabaseChangedDuringVerification(AssertionError):
    """The watermark moved during one page-verification attempt; that attempt proves nothing."""


import additive_migrations
import after_proof
import auth_heartbeat
import database_continuity as continuity
import kept_lines
import live_database
import page_continuity
import read_cache
import read_watermark
import update_read
import update_service


def live_migration(database):
    """The newest migration id the live `database` recorded, or None when it cannot tell (no
    migrations table, or a snapshot that cannot be taken); the database is only read."""
    snapshot = read_cache.Snapshot(database)
    try:
        snapshot.open()
        return additive_migrations.newest(snapshot.db)
    except (read_cache.Unavailable, OSError, sqlite3.Error, ValueError):
        return None
    finally:
        snapshot.close()


_Pages = disk_room.Pages  # The b-tree walk largest_table_bytes takes; tests patch it here.


@contextlib.contextmanager
def _snapshot_schema(database):
    """read_cache.Snapshot's connection, held open during the walk; ValueError when unavailable."""
    snapshot = read_cache.Snapshot(database)
    try:
        try:
            snapshot.open()
        except read_cache.Unavailable as error:
            raise ValueError('snapshot-unavailable') from error
        yield snapshot.db
    finally:
        snapshot.close()


def largest_table_bytes(database):
    """An estimate, without reading the tables, of the largest table's bytes in the live
    `database`: its b-tree pages (counted from interior pages) and its overflow pages (from the
    payload sizes on up to OVERFLOW_SAMPLE of its leaves, scaled to all of them), plus the pages
    that estimate leaves unexplained (sampling error, index overflow) as if that table held them,
    plus the -wal file. The whole file plus its -wal when the walk cannot tell. M4's 22.4 GB
    copy of November 4: orchestration_events 6.5 GB of b-tree pages and about 4.5 GB of overflow
    (the file's 9.4 GB of overflow is shared with turn items), 11.4 GB in all; about 20 s cold.
    Called only when a FULL_READ migration is pending."""
    return disk_room.largest_table_bytes(database, _snapshot_schema)


def measured_table(database, live):
    """largest_table_bytes when this release has a FULL_READ migration above `live`, else None."""
    return largest_table_bytes(database) if additive_migrations.full_read_pending(live) else None


def fallback_room(database, live, reserve=0, freed=0, table=None):
    """The FULL_READ migrations this release will run on a database whose newest migration is
    `live`, after refusing, before the service stops, when the full read they force lacks room.
    The page proof refuses such a migration, so after the restart the full read of the stopped
    clone and the live database is certain. It hashes one table at a time through sorted runs
    (database_continuity.spilled_table), so its peak is the largest table's typed and legacy runs:
    FULL_READ_LINE_FACTOR times largest_table_bytes and DISK_FLOOR_MARGIN, plus `reserve` (what the pre-update backup and
    the new release take first, state_backup.backup_space_needed) on the spill volume; `freed`
    is what the update lets go before that read (kept lines on disk). Runs that cannot spill (no
    spill folder on the database's volume) need that memory instead. An estimate: the per-run
    check during the read (SortedRuns._check_room) stays the hard guard. M4 on 1.0.184 (072, 22 GB
    database, 12-18 GB free) found out only after the restart, with the new release held.
    `live` None (no migrations table, or no snapshot) counts nothing: nothing to check against.
    `table`, the largest table's bytes an earlier call measured, saves a second walk."""
    pending = additive_migrations.full_read_pending(live)
    if not pending:
        return []
    numbers = ', '.join('%03d' % number for number in pending)
    runs = disk_room.full_read_runs(largest_table_bytes(database) if table is None else table)
    folder = kept_lines.spill_folder(database)
    if folder is None:
        assert kept_lines.memory_room(runs), FULL_READ_NO_MEMORY % (numbers, runs / 1e9)
        return pending
    needed, free = runs + kept_lines.DISK_FLOOR_MARGIN + reserve, kept_lines.available_disk(folder)
    free = None if free is None else free + freed
    assert free is not None and free >= needed, (FULL_READ_NO_ROOM % (numbers, needed / 1e9, (free or 0) / 1e9)
                                                 + ROOM_PARTS % ((runs + kept_lines.DISK_FLOOR_MARGIN) / 1e9, reserve / 1e9))
    return pending


class PageMode:
    """Only a proven held admission can defer history validation to its stopped clone.

    Cheap captures contain authority, schema and identity facts, explicitly no history hashes.
    A refusal after activation takes the old complete clone/live proof. A failed proof leaves
    the new database held for review, never restores over unproven postactivation writes.
    """
    def __init__(self, names, identity, expected, heartbeat, migrations=False):
        self.n, self.identity, self.expected, self.heartbeat = names, identity, expected, heartbeat
        # An update allowed to migrate: the page proof also accepts declared additive migrations.
        self.migrations = migrations
        self.service = names._service(identity)
        self.state = self.service['own'] / 'userdata'
        self.verdict = self.fallback_reason = None
        self.started = None
        self.live_migration = None
        self.child_waits, self.child_refusals = 0, []
        self.process_reader, self.database_holders = quiescence.read_processes, service_handles.database_holders

    @classmethod
    def prepare(cls, names, identity, expected, heartbeat, report=None, migrations=False):
        """The mode, or None and the reason in `report['pageModeRefused']` when a held install takes
        the full path instead."""
        if expected.get('snapshotMode') != 'held-service':
            return None
        mode = cls(names, identity, expected, heartbeat, migrations)
        try:
            _, auth = mode.read()  # Unsupported/moving snapshots take the old path before any write.
            assert auth is not None, 'Page mode requires an existing auth table'
        except (read_cache.Unavailable, OSError, sqlite3.Error, AssertionError, ValueError) as error:
            if report is not None:
                report['pageModeRefused'] = type(error).__name__ + ':' + str(error)[:160]
            return None
        return mode

    def assert_fallback_room(self, reserve=0, freed=0):
        """fallback_room for the live database's newest migration as the last read() saw it."""
        return fallback_room(self.state / 'statev2.sqlite', self.live_migration, reserve, freed)

    @staticmethod
    def authority(db):
        update_read.assert_idle(db)
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        selected = sorted(tables & set(update_read.AUTHORITY_TABLES))
        rows = {'nativeWorkIdle': True, 'counts': {}, 'hashes': {},
                'schemaSha256': continuity.digest(continuity.encoded(continuity.schema(db)))}
        for table in selected:
            values = list(db.execute('SELECT * FROM ' + table + ' NOT INDEXED LIMIT ' + str(AUTHORITY_ROW_BUDGET + 1)))
            assert len(values) <= AUTHORITY_ROW_BUDGET, 'Authority capture budget exceeded'
            rows['counts'][table] = len(values)
            rows['hashes'][table] = continuity.legacy_rows_hash(values)
            if table != 'auth_sessions':
                rows['hashes'][table] = continuity.typed_rows_hash(values)
        for key, sources, column in (
                ('projectIds', ('projection_projects',), 'project_id'),
                ('threadIds', ('projection_threads', 'orchestration_v2_projection_threads'), 'thread_id')):
            ids = set()
            for table in sources:
                if table in tables:
                    values = [row[0] for row in db.execute('SELECT ' + column + ' FROM ' + table + ' NOT INDEXED LIMIT ' + str(AUTHORITY_ROW_BUDGET + 1))]
                    assert len(values) <= AUTHORITY_ROW_BUDGET and all(type(value) is str for value in values), 'Identity capture budget or type'
                    ids.update(values)
            rows[key] = sorted(ids)
        auth = None
        if 'auth_sessions' in tables:
            rows[update_read.AUTH_INVARIANT_KEY] = update_read.auth_invariant_hash(db)
            auth = auth_heartbeat.read_auth_sessions_in_transaction(db, rows)
        return rows, auth

    def held(self):
        runtime = update_service._small_json(self.state / 'server-runtime.json', self.service['home'])
        assert runtime['pid'] == self.expected['servicePid'], 'Held service changed before restart'
        service = {**self.service, 'runtime': runtime}
        self.n.assert_held(service, self.expected['installRequestedAt'])
        return service

    def read(self):
        snapshot = read_cache.Snapshot(self.state / 'statev2.sqlite')
        try:
            snapshot.open()
            rows, auth = self.authority(snapshot.db)
            self.live_migration = additive_migrations.newest(snapshot.db)
            snapshot.check()
            return rows, auth
        finally:
            snapshot.close()

    def snapshot(self, passing=None):
        rows, auth = self.read()
        extra = {} if passing is None else {'passing': passing}
        value = self.n._snapshot(self.identity, True, reads=(rows, auth, None, None), **extra)[0]
        value.pop('databaseCapture')
        value['databaseProofMode'] = 'stopped-clone-pages-v1'
        return value, auth, None

    def validate_auth(self, before, after, original, current, started, observed, policy):
        if not self.heartbeat:
            assert continuity.typed_rows_hash(original['rows']) == continuity.typed_rows_hash(current['rows']), 'Auth cells changed'
            return None
        def view(rows):
            return {'nativeWorkIdle': True, 'counts': {'auth_sessions': rows['counts']['auth_sessions']},
                    'hashes': {'auth_sessions': rows['hashes']['auth_sessions']},
                    update_read.AUTH_INVARIANT_KEY: rows[update_read.AUTH_INVARIANT_KEY]}
        left, right = view(before), view(after)
        if left == right:
            assert continuity.typed_rows_hash(original['rows']) == continuity.typed_rows_hash(current['rows']), 'Auth typed cells changed'
        return auth_heartbeat.prove_restart_heartbeat(left, right, original, current, started, observed,
            identity=self.identity, web_session_policy=policy)

    def stopped(self, held, before, original_auth, started, policy, backup=None):
        if not isinstance(held, dict) or not held.get('clone'):
            assert backup is not None, 'Stopped immutable history baseline unavailable'
            held = {'clone': str(backup), 'fullOnly': (held or {}).get('reason', 'no-page-baseline')}
        assert held.get('clone'), 'Stopped immutable history baseline unavailable'
        path = pathlib.Path(held['clone'])
        assert path.is_file() and not path.is_symlink(), 'Stopped baseline is not a plain file'
        baseline_identity = page_continuity.PageProof.file_identity(path.stat())
        db = sqlite3.connect('file:' + urllib.parse.quote(str(path.resolve()), safe='/') + '?mode=ro&immutable=1', uri=True)
        try:
            db.execute('BEGIN')
            rows, auth = self.authority(db)
        finally:
            db.close()
        assert page_continuity.PageProof.file_identity(path.stat()) == baseline_identity, 'Stopped baseline changed'
        assert self.n.same_guarded_rows(before['rows'], rows, auth_heartbeat=self.heartbeat), 'Authority changed before stopped baseline'
        if original_auth is not None:
            self.validate_auth(before['rows'], rows, original_auth, auth, started,
                               datetime.datetime.now(datetime.timezone.utc).isoformat(), policy)
        self.baseline_auth = auth
        self.baseline_identity = baseline_identity
        return held

    def check_baseline(self, held):
        path = pathlib.Path(held['clone'])
        assert not path.is_symlink() and page_continuity.PageProof.file_identity(path.stat()) == self.baseline_identity, 'Stopped baseline changed after capture'

    def after(self, held, started, policy):
        # A write that lands while one attempt verifies (a reconnected browser's auth
        # heartbeat is the known one: the gate stops new work, not that heartbeat) discards
        # only that attempt. Each retry waits for a quiet watermark, then re-proves from
        # scratch under the same unchanged() check, so nothing is proved more weakly; only
        # a database that never stays still takes the full clone read. 1.0.117 on M4 fell
        # back on the first heartbeat and the full read held "Installing" for 326 s.
        self.verdict = None
        self.after_attempts = 0
        self.child_waits, self.child_refusals = 0, []
        for attempt in range(PAGE_VERIFY_ATTEMPTS):
            self.after_attempts += 1
            try:
                return self._after_once(held, started, policy)
            except DatabaseChangedDuringVerification as error:
                if attempt + 1 >= PAGE_VERIFY_ATTEMPTS:
                    self.fallback_reason = '%s (%d attempts)' % (_why(error), self.after_attempts)
                    return None
                self._wait_quiet()
            except (page_continuity.Refused, read_cache.Unavailable, AssertionError, OSError, sqlite3.Error, ValueError,
                    subprocess.TimeoutExpired) as error:
                self.fallback_reason = _why(error)
                return None
        return None

    def _wait_quiet(self):
        """Until the watermark holds still for PAGE_VERIFY_QUIET_SECONDS, at most
        PAGE_VERIFY_QUIET_WAIT_SECONDS; a database that never settles is retried anyway."""
        mark = read_watermark.Watermark.open(self.state / 'statev2.sqlite')
        try:
            deadline = time.monotonic() + PAGE_VERIFY_QUIET_WAIT_SECONDS
            token, since = mark.take(), time.monotonic()
            while time.monotonic() < deadline:
                time.sleep(0.25)
                current = mark.take()
                if current is None or token is None or current != token:
                    token, since = current, time.monotonic()
                elif time.monotonic() - since >= PAGE_VERIFY_QUIET_SECONDS:
                    return
        finally:
            mark.close()

    def _after_once(self, held, started, policy):
        mark = read_watermark.Watermark.open(self.state / 'statev2.sqlite')
        try:
            self.check_baseline(held)
            if held.get('fullOnly'): raise page_continuity.Refused('stopped-full-only:' + held['fullOnly'])
            token = mark.take()
            observed = datetime.datetime.now(datetime.timezone.utc).isoformat()
            verdict = page_continuity.prove(self.state, held, started, observed,
                                            identity=self.identity, web_session_policy=policy, migrations=self.migrations)
            assert self.heartbeat or verdict['authHeartbeat'] is None, 'Auth heartbeat was not authorized'
            after, auth, _ = self._snapshot_once_children_pass()
            assert after['servicePid'] != self.expected['servicePid'], 'Page verification still sees the old service'
            if not mark.unchanged(token):
                raise DatabaseChangedDuringVerification('Database changed during page verification')
            self.check_baseline(held)
            self.verdict = verdict
            return after, auth, None
        finally:
            mark.close()

    def _snapshot_once_children_pass(self):
        """The proof stands while the watermark holds, which the caller checks after this returns,
        so only the process check is repeated, and it must still pass in full. The service's own
        children it sets aside must then exit before the deadline (_children_exit)."""
        deadline = time.monotonic() + PAGE_VERIFY_DESCENDANT_SECONDS
        while True:
            try:
                passing = []
                value = self.snapshot(passing=passing)
                self._children_exit(passing, deadline)
                return value
            except (AssertionError, subprocess.TimeoutExpired) as error:
                if len(self.child_refusals) < CHILD_REFUSALS_KEPT:
                    self.child_refusals.append(_why(error))
                passing = isinstance(error, subprocess.TimeoutExpired) or str(error) in PASSING_CHILD_REFUSALS
                if not passing or time.monotonic() >= deadline:
                    raise
            self.child_waits += 1
            time.sleep(PAGE_VERIFY_DESCENDANT_POLL_SECONDS)

    def _children_exit(self, passing, deadline):
        """Each owned child the capture set aside, by pid and start time, exits (or is left unreaped)
        by `deadline`, and none holds statev2.sqlite, -wal or -shm open: one that does refuses at
        once. One still running at the deadline refuses, naming it, as a capture with it did before."""
        if not passing:
            return
        held = self.database_holders(self.state, [item['pid'] for item in passing])
        if held:
            raise quiescence.UnexpectedDescendants([item for item in passing if item['pid'] in held], DATABASE_HELD_BY_CHILD)
        while True:
            processes = self.process_reader()
            running = [item for item in passing if (found := processes.get(item['pid'])) is not None
                       and found['startedAt'] == item['startedAt'] and not quiescence._exited(found)]
            if not running:
                return
            if time.monotonic() >= deadline:
                raise quiescence.UnexpectedDescendants(running)
            self.child_waits += 1
            time.sleep(PAGE_VERIFY_DESCENDANT_POLL_SECONDS)

    def report(self, result):
        """pageFallback when the proof fell back, and the process refusals it waited through."""
        if self.fallback_reason:
            result['pageFallback'] = self.fallback_reason
        if self.child_refusals:
            result['pageChildRefusals'] = list(self.child_refusals)

    def full_baseline(self, held, before):
        path = pathlib.Path(held['clone'])
        assert path.name == 'statev2.sqlite' and path.is_file() and not path.is_symlink(), 'Unexpected baseline path'
        self.check_baseline(held)
        db = sqlite3.connect('file:' + urllib.parse.quote(str(path.resolve()), safe='/') + '?mode=ro&immutable=1', uri=True)
        try:
            db.execute('BEGIN')
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            assert all(re.fullmatch('[a-z0-9_]+', table) for table in tables), 'Unexpected table identifier'
            virtual = update_read.virtual_tables(db, tables)
            if not virtual: update_read.assert_idle(db)
            rows, auth, _, capture = update_read._read_tables(db, tables, True, None, True, None, once=not virtual, check_idle=virtual,
                                                          spill=kept_lines.spill_folder(self.state / 'statev2.sqlite'))
        finally:
            db.close()
        self.check_baseline(held)
        value = {**before, 'rows': rows, 'databaseCapture': capture, 'databaseProofMode': 'full-stopped-clone'}
        return value, auth

    def receipt(self, result):
        result['databaseProofMode'] = 'stopped-clone-pages-v1'
        result['databasePageProof'] = self.verdict
        result['pageChildWaits'] = self.child_waits
        if self.child_refusals:
            result['pageChildRefusals'] = list(self.child_refusals)
        result['rowPreservation'] = 'verified-stopped-clone-pages'
        result['completeDatabaseContinuity'] = 'verified-pages'
        result.pop('rowsByteIdentical', None)  # No claim about a legacy whole-history hash.
        result['appendedLogRows'] = self.verdict['appendedRows']


def _why(error):
    """`Type:message`, plus the processes a quiescence refusal names; the type stays AssertionError for
    those, as receipts and the update agent have always read it."""
    name = 'AssertionError' if isinstance(error, quiescence.UnexpectedDescendants) else type(error).__name__
    detail = error.detail() if isinstance(error, quiescence.UnexpectedDescendants) else ''
    return name + ':' + str(error)[:160] + (' [%s]' % detail if detail else '')
