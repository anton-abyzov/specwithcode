"""Exact, read-only proof of bounded existing-session reconnects; rows stay in memory.

During an owned restart, sessions that already existed reconnect and advance only
their `last_connected_at`: the supported web session (M4 browser cookie, or the paired
worker relay's web bearer) and the desktop and phone apps' own sessions on that service. A
connect may also report the app version its client now runs (`client_app_version`,
witness version 5), with or without advancing the heartbeat: the server writes the version
first and stamps the heartbeat only on a session's first open connection. No new session,
no other column, no revoked or expired session, and a bounded count.
"""
import copy
import datetime
import hashlib
import json
import re

import live_database

# From the owned restart to the helper's observation of the new service. Before the kickstart
# come process inventories and the state backup (unbounded on a loaded host), then up to
# READINESS_DEADLINE_SECONDS of readiness polling and a final snapshot, all inside the helper's
# apply budget (update.APPLY_BUDGET_SECONDS, at most 3600). The window only bounds which
# `last_connected_at` values count as a reconnect; at 120 a sound 1.0.38 restart observed after
# 137 s failed its proof.
MAX_RESTART_WINDOW_SECONDS = 3600
WEB_SESSION_METHOD = {'m4': 'browser-session-cookie', 'm1': 'bearer-access-token', 'm3': 'bearer-access-token'}
MAX_WEB_HEARTBEATS = {'m4': 2, 'm1': 1, 'm3': 1}
# The desktop app signs in with an access token and reports the desktop surface.
DESKTOP_SESSION_METHODS = ('bearer-access-token', 'dpop-access-token')
MAX_DESKTOP_HEARTBEATS = 4
# A phone or tablet app (apps/ios, apps/mobile) signs in the same ways, directly or over the
# relay, and reports the mobile surface (MachineConnection.swift: clientSurface=mobile).
MOBILE_SESSION_METHODS = DESKTOP_SESSION_METHODS
MAX_MOBILE_HEARTBEATS = 4
SESSION_KIND_NAMES = {'web': 'existing-web-session', 'desktop': 'existing-desktop-app-session',
                      'mobile': 'existing-mobile-app-session'}
# What a connect reports besides its heartbeat (AuthSessions.ts setClientConnectionRow): the
# version of the app or page that connected, for the sessions list only. A desktop app or a page
# reloaded into the new release reports it on every connect, committed before the heartbeat (ws.ts
# recordClientConnection, then markConnected, which stamps only a session's first open connection).
# The server stores it trimmed, never empty, at most 64 characters (ws.ts MAX_CLIENT_APP_VERSION_LENGTH),
# never NULL over a value.
APP_VERSION_COLUMN = 'client_app_version'
MAX_APP_VERSION_LENGTH = 64
HEARTBEAT_CELL = {'rowSha256', 'beforeLastConnectedAt', 'afterLastConnectedAt'}
VERSION_CELL = {'rowSha256', 'beforeClientAppVersion', 'afterClientAppVersion'}
VERSIONED_CELL = HEARTBEAT_CELL | VERSION_CELL


def session_policy(identity, policy=None):
    # Dependency-free: the read-only network verifier streams this module by itself.
    assert isinstance(identity, str) and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?', identity) and identity not in {'stage', 'backups'}, 'Unsafe service identity'
    legacy = {'m4': 'browser-cookie', 'm1': 'worker-relay', 'm3': 'worker-relay'}.get(identity)
    assert policy is None or policy in {'browser-cookie', 'worker-relay'}, 'Unknown web session policy'
    assert legacy is None or policy in (None, legacy), 'Legacy web session policy cannot change'
    policy = policy or legacy
    assert policy is not None, 'Generic service requires an explicit web session policy'
    return ('browser-session-cookie', 2) if policy == 'browser-cookie' else ('bearer-access-token', 1)


def encoded(value):
    return json.dumps(value, default=lambda item: item.hex(), separators=(',', ':'))


def rows_hash(rows):
    return hashlib.sha256('\n'.join(sorted(encoded(row) for row in rows)).encode()).hexdigest()


def schema_hash(auth):
    return hashlib.sha256(encoded(auth['schema']).encode()).hexdigest()


def utc_timestamp(value):
    assert isinstance(value, str) and re.fullmatch(
        r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', value
    ), 'Heartbeat requires a UTC timestamp'
    try:
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise AssertionError('Heartbeat requires a valid calendar timestamp') from None


def bind_auth(auth, expected):
    assert len(auth['rows']) == expected['counts']['auth_sessions'], 'Complete auth row count changed'
    assert rows_hash(auth['rows']) == expected['hashes']['auth_sessions'], 'Complete auth hash changed during readback'


def read_auth_sessions_in_transaction(db, expected):
    """Capture private auth cells in the caller's protected-row read transaction."""
    assert db.in_transaction, 'Auth capture requires an existing read transaction'
    columns = [list(row) for row in db.execute('PRAGMA table_info(auth_sessions)')]
    extended = [list(row) for row in db.execute('PRAGMA table_xinfo(auth_sessions)')]
    definitions = [list(row) for row in db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='auth_sessions' ORDER BY type,name"
    )]
    assert columns and extended and definitions, 'Complete auth schema unavailable'
    auth = {'schema': [columns, extended, definitions],
            'columns': [row[1] for row in columns],
            'rows': [list(row) for row in db.execute('SELECT * FROM auth_sessions')]}
    bind_auth(auth, expected)
    return auth


def read_auth_sessions(state, expected):
    """Read schema and every cell in one RO transaction, bound to the saved snapshot."""
    db = live_database.connect(state / 'statev2.sqlite')
    try:
        db.execute('BEGIN')
        return read_auth_sessions_in_transaction(db, expected)
    finally:
        db.close()


def assert_only_auth_hash_changed(before, after):
    assert set(before) == set(after), 'Protected row proof shape changed'
    for key in before:
        if key != 'hashes':
            assert before[key] == after[key], 'Protected rows or counts changed'
    assert set(before['hashes']) == set(after['hashes']), 'Protected tables changed'
    assert 'auth_sessions' in before['hashes']
    for table in before['hashes']:
        if table != 'auth_sessions':
            assert before['hashes'][table] == after['hashes'][table], 'Other protected table changed'
    assert before['nativeWorkIdle'] is True and after['nativeWorkIdle'] is True


def active_session(auth, row, instant, identity, web_session_policy=None):
    """'web', 'desktop' or 'mobile' for an active session allowed to heartbeat; raises otherwise."""
    fields = dict(zip(auth['columns'], row))
    assert fields['revoked_at'] is None, 'Heartbeat session is revoked'
    if fields['method'] == session_policy(identity, web_session_policy)[0] and fields['client_surface'] == 'web':
        kind = 'web'
    elif fields['method'] in DESKTOP_SESSION_METHODS and fields['client_surface'] == 'desktop':
        kind = 'desktop'
    elif fields['method'] in MOBILE_SESSION_METHODS and fields['client_surface'] == 'mobile':
        kind = 'mobile'
    else:
        raise AssertionError('Heartbeat is not the supported existing web-browser session or a desktop-app or phone-app session')
    assert utc_timestamp(fields['issued_at']) <= instant < utc_timestamp(fields['expires_at']), 'Heartbeat session is not active'
    return kind


def active_browser(auth, row, instant, identity, web_session_policy=None):
    assert active_session(auth, row, instant, identity, web_session_policy) == 'web', \
        'Heartbeat is not the supported existing web-browser session'


def session_name(auth, row, kind):
    """Names a heartbeating session in a receipt without its identifier or credential."""
    fields = dict(zip(auth['columns'], row))
    return {'kind': SESSION_KIND_NAMES[kind],
            'method': fields['method'], 'surface': fields['client_surface'],
            'sessionIdSha256': hashlib.sha256(('studio-auth-session-id-v1\n' + encoded(fields['session_id'])).encode()).hexdigest()}


def invariant_row_hash(auth, row):
    """Noncredential identity binding; retain column names and SQLite value types."""
    cells = [(name, type(value).__name__, value) for name, value in zip(auth['columns'], row)
             if name != 'last_connected_at']
    return hashlib.sha256(('studio-auth-heartbeat-row-v2\n' + encoded(cells)).encode()).hexdigest()


def prove_restart_heartbeat(before, after, original, current, restart_started_at, observed_after_at, *, identity='m4', web_session_policy=None):
    """Return a noncredential witness; never alter or normalize the reported snapshots."""
    _, max_web = session_policy(identity, web_session_policy)
    assert original is not None and current is not None, 'Restart heartbeat proof requires the auth sessions table'
    bind_auth(original, before)
    bind_auth(current, after)
    assert original['schema'] == current['schema'], 'Complete auth schema changed'
    assert_only_auth_hash_changed(before, after)
    if before == after:
        return None
    start, end = utc_timestamp(restart_started_at), utc_timestamp(observed_after_at)
    assert 0 <= (end - start).total_seconds() <= MAX_RESTART_WINDOW_SECONDS, 'Owned restart window is not bounded'
    columns = original['columns']
    identifier, timestamp = columns.index('session_id'), columns.index('last_connected_at')
    version = columns.index(APP_VERSION_COLUMN) if APP_VERSION_COLUMN in columns else None
    old_rows = {row[identifier]: row for row in original['rows']}
    new_rows = {row[identifier]: row for row in current['rows']}
    assert len(old_rows) == len(original['rows']) and len(new_rows) == len(current['rows']), 'Duplicate auth session identity'
    assert old_rows.keys() == new_rows.keys(), 'Auth session identities changed'
    changed = [(old, new_rows[key]) for key, old in old_rows.items() if old != new_rows[key]]
    assert 1 <= len(changed) <= max_web + MAX_DESKTOP_HEARTBEATS + MAX_MOBILE_HEARTBEATS, \
        'Heartbeat exceeds the supported existing-session count'
    restored = copy.deepcopy(current)
    changes = []
    kinds = []
    sessions = []
    for old, new in changed:
        assert len(old) == len(new) == len(columns), 'Heartbeat auth row shape changed'
        differing = [index for index, pair in enumerate(zip(old, new))
                     if type(pair[0]) is not type(pair[1]) or pair[0] != pair[1]]
        moved, reported = timestamp in differing, version is not None and version in differing
        assert set(differing) <= {timestamp, version}, 'Heartbeat changed another auth cell'
        if reported:
            assert (old[version] is None or type(old[version]) is str) and type(new[version]) is str \
                and 0 < len(new[version]) <= MAX_APP_VERSION_LENGTH, 'Heartbeat reported an invalid app version'
        connected = start  # A version reported over a connection the session already had, or before its stamp.
        if moved:
            previous, connected = utc_timestamp(old[timestamp]), utc_timestamp(new[timestamp])
            assert previous <= start <= connected <= end and previous < connected, 'Heartbeat did not advance inside the owned restart window'
        kind = active_session(original, old, start, identity, web_session_policy)
        assert active_session(current, new, connected, identity, web_session_policy) == kind, 'Heartbeat session kind changed'
        kinds.append(kind)
        row = restored['rows'][current['rows'].index(new)]
        changes.append({'rowSha256': invariant_row_hash(current, new)})
        if moved:
            row[timestamp] = old[timestamp]
            changes[-1].update(beforeLastConnectedAt=old[timestamp], afterLastConnectedAt=new[timestamp])
        if reported:
            row[version] = old[version]
            changes[-1].update(beforeClientAppVersion=old[version], afterClientAppVersion=new[version])
        sessions.append({**session_name(current, new, kind), 'rowSha256': changes[-1]['rowSha256']})
    assert kinds.count('web') <= max_web and kinds.count('desktop') <= MAX_DESKTOP_HEARTBEATS \
        and kinds.count('mobile') <= MAX_MOBILE_HEARTBEATS, 'Heartbeat exceeds the supported existing-session count'
    assert len({cell['rowSha256'] for cell in changes}) == len(changes), 'Duplicate heartbeat row fingerprint'
    bind_auth(restored, before)
    witness = {'schemaVersion': 1, 'changedColumn': 'last_connected_at', 'changedRows': len(changed),
            'restartStartedAt': restart_started_at, 'observedAfterAt': observed_after_at,
            'authSchemaSha256': schema_hash(current),
            'beforeAuthSessionsSha256': before['hashes']['auth_sessions'],
            'afterAuthSessionsSha256': after['hashes']['auth_sessions'],
            'originalCompleteRowsReconstructed': True}
    # Version 5: version 3 or 4 where a reconnect also reported its app version.
    versioned = any('afterClientAppVersion' in cell for cell in changes)
    if identity not in WEB_SESSION_METHOD:
        witness.update(schemaVersion=5 if versioned else 4, serviceIdentity=identity, webSessionPolicy=web_session_policy,
                       timestampChanges=sorted(changes, key=lambda cell: cell['rowSha256']),
                       sessions=sorted(sessions, key=lambda cell: cell['rowSha256']))
        return witness
    if 'desktop' in kinds or 'mobile' in kinds or versioned:
        # Version 3: any mix of the web session and existing desktop or phone app sessions, each named.
        witness.update(schemaVersion=5 if versioned else 3, serviceIdentity=identity,
                       timestampChanges=sorted(changes, key=lambda cell: cell['rowSha256']),
                       sessions=sorted(sessions, key=lambda cell: cell['rowSha256']))
        return witness
    if len(changed) == 2:
        assert identity == 'm4', 'Heartbeat exceeds the supported existing-session count'
        witness.update(schemaVersion=2, serviceIdentity='m4', sessionMethod='browser-session-cookie',
                       sessionSurface='web', timestampChanges=sorted(changes, key=lambda cell: cell['rowSha256']))
    else:
        witness.update(beforeLastConnectedAt=changes[0]['beforeLastConnectedAt'],
                       afterLastConnectedAt=changes[0]['afterLastConnectedAt'])
    if identity in {'m1', 'm3'}:
        witness.update(serviceIdentity=identity, sessionMethod='bearer-access-token', sessionSurface='web')
    return witness


def restore_timestamp(auth, before_timestamp, after_timestamp, expected):
    """Privately reverse one witnessed cell and require the full expected row hash."""
    assert utc_timestamp(before_timestamp) < utc_timestamp(after_timestamp), 'Heartbeat timestamp did not advance'
    restored = copy.deepcopy(auth)
    timestamp = restored['columns'].index('last_connected_at')
    revoked = restored['columns'].index('revoked_at')
    candidates = [row for row in restored['rows'] if row[timestamp] == after_timestamp and row[revoked] is None]
    assert len(candidates) == 1, 'Heartbeat witness must identify one existing active session'
    candidates[0][timestamp] = before_timestamp
    bind_auth(restored, expected)
    return restored


def restore_m4_timestamps(auth, changes, expected):
    """Reverse exactly two uniquely bound cells privately, then bind the full table."""
    assert isinstance(changes, list) and len(changes) == 2, 'M4 heartbeat requires exactly two changes'
    return restore_timestamps(auth, changes, expected)


def restore_timestamps(auth, changes, expected, *, versions=False):
    """Reverse uniquely bound cells privately, then bind the full table. With `versions`
    (witness version 5) a cell may also, or only, reverse the app version a connect reported."""
    assert isinstance(changes, list) and 1 <= len(changes) <= max(MAX_WEB_HEARTBEATS.values()) + MAX_DESKTOP_HEARTBEATS + MAX_MOBILE_HEARTBEATS, \
        'Heartbeat change count is not supported'
    restored = copy.deepcopy(auth)
    timestamp = restored['columns'].index('last_connected_at')
    version = restored['columns'].index(APP_VERSION_COLUMN) if APP_VERSION_COLUMN in restored['columns'] else None
    # Fingerprints bind the live rows; reversing a version changes the restored row's own.
    fingerprints = [invariant_row_hash(restored, row) for row in restored['rows']]
    seen = set()
    for cell in changes:
        keys = set(cell) if isinstance(cell, dict) else None
        assert keys == HEARTBEAT_CELL or (versions and version is not None and keys in (VERSIONED_CELL, VERSION_CELL)), \
            'Heartbeat cell witness shape changed'
        fingerprint = cell['rowSha256']
        assert isinstance(fingerprint, str) and re.fullmatch('[a-f0-9]{64}', fingerprint), 'Invalid heartbeat row fingerprint'
        assert fingerprint not in seen, 'Duplicate heartbeat row fingerprint'
        seen.add(fingerprint)
        candidates = [row for row, value in zip(restored['rows'], fingerprints) if value == fingerprint]
        assert len(candidates) == 1, 'Heartbeat fingerprint must identify exactly one existing row'
        if keys != VERSION_CELL:
            before, after = cell['beforeLastConnectedAt'], cell['afterLastConnectedAt']
            assert utc_timestamp(before) < utc_timestamp(after), 'Heartbeat timestamp did not advance'
            assert candidates[0][timestamp] == after, 'Heartbeat timestamp does not match live row'
            candidates[0][timestamp] = before
        if keys != HEARTBEAT_CELL:
            earlier, reported = cell['beforeClientAppVersion'], cell['afterClientAppVersion']
            assert (earlier is None or type(earlier) is str) and type(reported) is str and earlier != reported, \
                'Heartbeat app version witness is invalid'
            assert type(candidates[0][version]) is str and candidates[0][version] == reported, \
                'Heartbeat app version does not match live row'
            candidates[0][version] = earlier
    bind_auth(restored, expected)
    return restored


def restore_witness(current, witness, expected):
    """The complete original auth rows a verified witness of any version reverses to."""
    if witness['schemaVersion'] in (2, 3, 4, 5):
        return restore_timestamps(current, witness['timestampChanges'], expected, versions=witness['schemaVersion'] == 5)
    return restore_timestamp(current, witness['beforeLastConnectedAt'], witness['afterLastConnectedAt'], expected)


def verify_restart_witness(before, after, witness, current, *, identity='m4', web_session_policy=None):
    """Recompute the complete proof from live rows, not the witness's booleans."""
    session_policy(identity, web_session_policy)
    bind_auth(current, after)
    assert schema_hash(current) == witness['authSchemaSha256'], 'Live auth schema does not match restart proof'
    assert type(witness['schemaVersion']) is int and type(witness['changedRows']) is int, 'Heartbeat witness counts must be integers'
    assert type(witness['originalCompleteRowsReconstructed']) is bool, 'Heartbeat proof flag must be boolean'
    if witness['schemaVersion'] == 2:
        assert identity == 'm4' and witness['changedRows'] == 2, 'Only M4 supports exactly two cookie heartbeats'
        original = restore_m4_timestamps(current, witness['timestampChanges'], before)
    elif witness['schemaVersion'] in (3, 4, 5):
        generic = identity not in WEB_SESSION_METHOD
        if witness['schemaVersion'] == 4 or (witness['schemaVersion'] == 5 and generic):
            assert generic and witness.get('webSessionPolicy') == web_session_policy, 'Heartbeat witness policy differs'
        assert witness.get('serviceIdentity') == identity, 'Heartbeat witness names another service'
        assert isinstance(witness['timestampChanges'], list) and witness['changedRows'] == len(witness['timestampChanges']), \
            'Heartbeat witness counts differ'
        original = restore_timestamps(current, witness['timestampChanges'], before, versions=witness['schemaVersion'] == 5)
    else:
        assert witness['schemaVersion'] == 1 and witness['changedRows'] == 1, 'Unsupported heartbeat witness version or count'
        original = restore_timestamp(current, witness['beforeLastConnectedAt'], witness['afterLastConnectedAt'], before)
    verified = prove_restart_heartbeat(before, after, original, current,
                                      witness['restartStartedAt'], witness['observedAfterAt'], identity=identity, web_session_policy=web_session_policy)
    assert verified is not None and verified == witness, 'Restart heartbeat witness differs from complete reconstruction'
    return verified
