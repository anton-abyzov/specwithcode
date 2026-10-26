"""Facts about the running service that update.py checks, split from update.py: which listeners on
other services' ports belong to it, whether it holds itself for a forced install, the native work
and processes a refusal names, and loading the old release again after a failed stop, copy or
start. update.py imports every name here, so callers and receipts use it as before. Nothing here
runs launchctl or signals a process itself: restart_old_release is handed the calls that do.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import contextlib
import datetime
import json
import posixpath
import re

from installation_descriptor import owned_path
import live_database
from quiescence import server_browser_pids
from update_read import TERMINAL_RUNS, run_work


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
    restarted, a hold that ended or a request that changed refuses the reap. Returns when the
    hold began."""
    updates = service['own'] / 'updates'
    values = {}
    for name in ('hold.json', 'config.json'):
        path = owned_path(updates / name, service['home'])
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
    return began

# The install gate's settle when the running service holds itself for this very forced request:
# a held service has refused every command that starts work and skipped its background ticks since
# the hold began (apps/server/src/serviceUpdate/ServiceUpdateHold.ts), so the gate's 5 s poll in
# releases up to 1.0.46 cannot let a run start; 2 s covers a commit already under way.
HELD_GATE_SETTLE_SECONDS = 2

def gate_settle(own, home, service_pid, full):
    """('held', HELD_GATE_SETTLE_SECONDS) when assert_held passes for the request in
    `updates/config.json` and the service `service_pid` that `userdata/server-runtime.json`
    names, else ('full', full). Never raises."""
    try:
        runtime = json.loads(owned_path(own / 'userdata' / 'server-runtime.json', home).read_text())
        config = json.loads(owned_path(own / 'updates' / 'config.json', home).read_text())
        assert isinstance(runtime, dict) and isinstance(config, dict) and runtime.get('pid') == service_pid
        assert_held({'own': own, 'home': home, 'runtime': runtime}, config.get('installRequestedAt'))
        return 'held', HELD_GATE_SETTLE_SECONDS
    except Exception:  # Any doubt keeps the full settle.
        return 'full', full

def restart_old_release(failure, state_backup, loaded, launcher_restored, bootstrap, discard):
    """After a failed stop, copy or start, before anything of the new release ran: load the old
    release again once its launcher is back (it alone names the release that starts), and only
    then let the unused pre-update copy go. While the job stays unloaded, or the launcher still
    names the new release, the copy is kept and named in `failure`: the next start may run the
    new release on this database, and the copy is then the only one to roll back to."""
    if state_backup is not None:
        failure['stateBackup'] = str(state_backup)
    if not loaded():
        failure['serviceStopped'] = True  # Unloaded: whatever starts it next is a restart.
        if not launcher_restored:
            failure['stateBackupKept'] = 'launcher-names-the-new-release'
            return
        bootstrap()
    if not (launcher_restored and loaded()):
        if state_backup is not None:
            failure['stateBackupKept'] = 'service-not-loaded' if launcher_restored else 'launcher-names-the-new-release'
        return
    if state_backup is not None:
        with contextlib.suppress(OSError, AssertionError):
            discard(state_backup)
            del failure['stateBackup']
            failure['stateBackupDiscarded'] = True

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

def descendant_names(pid, processes, home=None):
    """Executable basenames beneath the service, with counts; the one supervisor is left out, and
    with the service's `home` its own server browser (which an update stops itself) unless nothing
    else is there. Only `ps comm` is read, never argv, so no argument or secret can appear."""
    names, pending, seen, supervisor, tree = {}, [pid], {pid}, False, []
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
            tree.append(child)
    browsers = server_browser_pids(processes, pid, home, tree) if home and tree and pid in processes else set()
    for child in [item for item in tree if item['pid'] not in browsers] or tree:
        name = _name(child['executable'])
        names[name] = names.get(name, 0) + 1
    return ' '.join('%s=%d' % item for item in sorted(names.items())[:8]) or ('none' if supervisor else 'no-supervisor')
