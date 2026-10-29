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
        # Migration 067 widens auth_sessions; its proofs then compare the earlier columns.
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
import pathlib
import re
import sqlite3
import urllib.parse

import after_proof
import auth_heartbeat
import database_continuity as continuity
import live_database
import page_continuity
import read_cache
import read_watermark
import update_read
import update_service


class PageMode:
    """Only a proven held admission can defer history validation to its stopped clone.

    Cheap captures contain authority, schema and identity facts, explicitly no history hashes.
    A refusal after activation takes the old complete clone/live proof. A failed proof leaves
    the new database held for review, never restores over unproven postactivation writes.
    """
    def __init__(self, names, identity, expected, heartbeat):
        self.n, self.identity, self.expected, self.heartbeat = names, identity, expected, heartbeat
        self.service = names._service(identity)
        self.state = self.service['own'] / 'userdata'
        self.verdict = self.fallback_reason = None
        self.started = None

    @classmethod
    def prepare(cls, names, identity, expected, heartbeat):
        if expected.get('snapshotMode') != 'held-service':
            return None
        mode = cls(names, identity, expected, heartbeat)
        try:
            _, auth = mode.read()  # Unsupported/moving snapshots take the old path before any write.
            assert auth is not None, 'Page mode requires an existing auth table'
        except (read_cache.Unavailable, OSError, sqlite3.Error, AssertionError, ValueError):
            return None
        return mode

    @staticmethod
    def authority(db):
        update_read.assert_idle(db)
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        selected = sorted(tables & set(update_read.AUTHORITY_TABLES))
        rows = {'nativeWorkIdle': True, 'counts': {}, 'hashes': {},
                'schemaSha256': continuity.digest(continuity.encoded(continuity.schema(db)))}
        for table in selected:
            values = list(db.execute('SELECT * FROM ' + table + ' NOT INDEXED LIMIT 20001'))
            assert len(values) <= 20000, 'Authority capture budget exceeded'
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
                    values = [row[0] for row in db.execute('SELECT ' + column + ' FROM ' + table + ' NOT INDEXED LIMIT 20001')]
                    assert len(values) <= 20000 and all(type(value) is str for value in values), 'Identity capture budget or type'
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
            snapshot.check()
            return rows, auth
        finally:
            snapshot.close()

    def snapshot(self):
        rows, auth = self.read()
        value = self.n._snapshot(self.identity, True, reads=(rows, auth, None, None))[0]
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
        self.verdict = None
        mark = read_watermark.Watermark.open(self.state / 'statev2.sqlite')
        try:
            self.check_baseline(held)
            if held.get('fullOnly'): raise page_continuity.Refused('stopped-full-only:' + held['fullOnly'])
            token = mark.take()
            observed = datetime.datetime.now(datetime.timezone.utc).isoformat()
            verdict = page_continuity.prove(self.state, held, started, observed,
                                            identity=self.identity, web_session_policy=policy)
            assert self.heartbeat or verdict['authHeartbeat'] is None, 'Auth heartbeat was not authorized'
            after, auth, _ = self.snapshot()
            assert after['servicePid'] != self.expected['servicePid'], 'Page verification still sees the old service'
            assert mark.unchanged(token), 'Database changed during page verification'
            self.check_baseline(held)
            self.verdict = verdict
            return after, auth, None
        except (page_continuity.Refused, read_cache.Unavailable, AssertionError, OSError, sqlite3.Error, ValueError) as error:
            self.fallback_reason = type(error).__name__ + ':' + str(error)[:160]
            return None
        finally:
            mark.close()

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
            rows, auth, _, capture = update_read._read_tables(db, tables, True, None, True, None, once=not virtual, check_idle=virtual)
        finally:
            db.close()
        self.check_baseline(held)
        value = {**before, 'rows': rows, 'databaseCapture': capture, 'databaseProofMode': 'full-stopped-clone'}
        return value, auth

    def receipt(self, result):
        result['databaseProofMode'] = 'stopped-clone-pages-v1'
        result['databasePageProof'] = self.verdict
        result['rowPreservation'] = 'verified-stopped-clone-pages'
        result['completeDatabaseContinuity'] = 'verified-pages'
        result.pop('rowsByteIdentical', None)  # No claim about a legacy whole-history hash.
        result['appendedLogRows'] = self.verdict['appendedRows']
