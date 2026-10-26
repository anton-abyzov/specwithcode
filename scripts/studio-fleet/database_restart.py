"""An update's way past a service that lost its hold on its own database.

M4, 2026-10-19: the service had dropped its SQLite locks (update.LOCKS_LOST). Every snapshot
refused with `REFUSAL environment`, the update agent reported an error every ten minutes, and
nothing restarted the service, although only reopening the database (in practice restarting
the process) gives the locks back (docs/operations/live-database.md). Such a refusal, or one
for a deleted log (update.DETACHED_DATABASE), is now `REFUSAL restart-needed`, and update.py
(database_restart_refusal, here as restart_refusal) restarts the verified service with
`launchctl kickstart -k` when:

- an Update now request is pending and the running service holds itself for it
  (update.assert_held: it drained its work); or, for lost locks only, the service is idle:
  the database shows no work and only its own idle provider servers run beneath it, at once
  for a pending Update now request, else for the quiet window of a normal update that may
  install now. A deleted log is restarted, held or not, only for a live explicit request
  (live_request: Update now, Try again, or an automatic install past its grace): the snapshot
  serves it (--request), config.json still asks for it, it was not cancelled and its
  installHoldUntil has not passed. installMode stays 'force' after a handled request, so a
  request from days ago never stops a busy service. The database on disk misses the service's
  newest commits, so it cannot prove the service idle, and the hold may be impossible in that
  state. Without a live request it is never restarted;
- no other process has statev2.sqlite, -wal or -shm open (lsof). With its locks gone, the
  service's closing connection checkpoints and deletes -wal, which is safe only while no
  other process uses the database;
- this service pid was not restarted for this in the last RESTART_EVERY;
- right before the restart, the same service pid still runs and, unless it is held or has a
  deleted log, is still idle: nothing holds new work while lsof runs, and a turn started
  meanwhile is not killed. A deleted-log service is only ever sent SIGTERM, so it stops its
  own work and closes its database itself (1085, AC-04).

The database is read only through live_database.connect, and no snapshot is taken while the
locks are lost. The snapshot still refuses; the restart waits until the new service holds its
locks again, and the next snapshot decides as before. The update agent says it is restarting
the app only for a line with restarted=, wait= or retry=; any other restart-needed line is an
error that asks the person to press Update now (update_agent_pause.RESTART_FAULTS). Stdlib only,
Python 3.9 compatible.

A deleted log is stopped, not killed (update.stop_then_start_service): SIGTERM, wait up to
DETACHED_STOP_SECONDS for the service to close its database, which writes the deleted log's
commits into the database file, then `launchctl kickstart` without -k. A service that does not
exit in time is left running and is tried again after RESTART_EVERY. On M4, 2026-10-20, the
service ran on a deleted log from 2:52 PM and other readers later saw "database disk image is
malformed"; `kickstart -k` there could have dropped commits only that log held.
"""
import datetime
import json
import os
import pathlib
import subprocess
import uuid

import idle_agents

CODE = 'restart-needed'
MARKER = 'database-restart.json'  # The last restart: service pid and time, for RESTART_EVERY.
QUIET_MARKER = 'database-restart-quiet.json'  # idle_agents.observe's record for the quiet window.
RESTART_EVERY = datetime.timedelta(minutes=30)
# How long a service with a deleted log gets to close its database after SIGTERM. Closing writes
# the whole log into the database file, so a large log takes a while; it is never killed instead.
DETACHED_STOP_SECONDS = 180
READY_SECONDS = 120  # How long the restart waits for the new service to hold its locks.


def forced_request(config):
    """The pending Update now request (installRequestedAt) that was not cancelled, else None."""
    if not isinstance(config, dict) or config.get('installMode') != 'force':
        return None
    request = config.get('installRequestedAt')
    requested, cancelled = idle_agents.utc(request), config.get('installCancelledAt')
    if requested is None or (cancelled is not None and (idle_agents.utc(cancelled) is None
                                                        or idle_agents.utc(cancelled) > requested)):
        return None
    return request


def live_request(config, serving, now):
    """`serving`, the explicit request the snapshot serves (update.py --request), while it is live:
    config.json still asks to force-install it, it was not cancelled and its installHoldUntil is
    still ahead. Else None: a handled request leaves installMode 'force' behind."""
    if not serving or forced_request(config) != serving:
        return None
    until = idle_agents.utc(config.get('installHoldUntil'))
    return serving if until is not None and now < until else None


def restart_wait(marker, service_pid, now):
    """Seconds until this service may be restarted again; 0 when it may be now."""
    if not isinstance(marker, dict) or marker.get('servicePid') != service_pid:
        return 0
    restarted = idle_agents.utc(marker.get('restartedAt'))
    if restarted is None or restarted > now + idle_agents.FUTURE_SKEW:
        return 0
    return max(0, int((restarted + RESTART_EVERY - now).total_seconds()))


def other_openers(paths, own_pids, timeout, attempts=2):
    """Pids, other than `own_pids`, that have any of `paths` open (lsof exits 1 for none)."""
    for attempt in range(1, attempts + 1):
        try:
            result = subprocess.run(['/usr/sbin/lsof', '-nP', '-t', '--'] + [str(path) for path in paths],
                                    capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            if attempt == attempts:
                raise
            continue
        assert result.returncode in {0, 1}, 'Open database files could not be read'
        return sorted(set(int(value) for value in result.stdout.split()) - set(own_pids))


def refusal(reason, **detail):
    """`REFUSAL restart-needed locks-lost wait=540` (or restarted=1, retry=, others=)."""
    return ' '.join(['REFUSAL', CODE, reason] + ['%s=%d' % item for item in sorted(detail.items())])


class Names(object):
    """update.py's globals as attributes, read at call time, so a test's patch of update.X applies."""

    def __init__(self, names):
        self.__dict__ = names


def wait_for_owner(u, identity, old_pid, deadline=READY_SECONDS):
    """The restarted service's pid once it runs and holds its database locks, else None."""
    ends = u.time.monotonic() + deadline
    while u.time.monotonic() < ends:
        u.time.sleep(1)
        try:
            service = u._service(identity)
            pid = service['runtime']['pid']
            if pid != old_pid and u.live_database.service_locks(service['own'] / 'userdata/statev2.sqlite')['database'] == pid:
                return pid
        except (AssertionError, OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            continue
    return None


def _write_record(u, receipts, now, report):
    record = u.safe_path(receipts / ('database-restart-%s-%s.json' % (now.strftime('%Y%m%dT%H%M%SZ'), uuid.uuid4().hex[:8])),
                         pathlib.Path.home().resolve())
    report['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    u._write_private(record, (json.dumps(report, indent=2) + '\n').encode())


def restart_refusal(u, identity, error, report=None, now=None, serving=None):
    """update.database_restart_refusal: a snapshot refused because the service lost its database
    locks or its log; restart the verified service when this module's conditions hold. `u` is
    update.py (Names), `serving` the explicit request the snapshot serves. Returns the REFUSAL
    line, or None to keep refusal_line's; raises when a check cannot be made. `report` holds the
    record."""
    reason = u.DATABASE_RESTART_REASONS.get(str(error)) if isinstance(error, AssertionError) else None
    if reason is None:
        return None
    home = pathlib.Path.home().resolve()
    service = u._service(identity)
    own, pid, owner = service['own'], service['runtime']['pid'], service['owner']
    state, updates = own / 'userdata', u.safe_path(own / 'updates', home)
    quiet_path, marker_path = updates / QUIET_MARKER, updates / MARKER
    now = now or datetime.datetime.now(datetime.timezone.utc)
    config = idle_agents.read_json(updates / 'config.json') or {}
    request = forced_request(config)
    held = False
    if request:
        try:
            u.assert_held(service, request, now)
            held = True
        except (AssertionError, OSError, ValueError):
            pass

    def quiet():
        """False, and the quiet window starts again, for work, a terminal or anything else
        beneath the service. Checked first, and again right before the restart."""
        try:
            assert idle_agents.idle(u.native_work_counts(state)), 'Native work is not idle'
            u.idle_providers(pid, owner.uid, str(service['node']), service['content']['ProgramArguments'])
        except AssertionError:
            if os.path.lexists(str(quiet_path)):
                quiet_path.unlink()
            return False
        return True
    if not held:
        if reason == 'detached':
            # Idle on disk proves nothing and the hold may be impossible, so a live explicit
            # request alone stops it (SIGTERM saves the log); a stale or no request never does.
            request = live_request(config, serving, now)
            if not request:
                return None
        else:
            if not (request or idle_agents.allowed(config)) or not quiet():
                return None
            if not request:
                marker, left = idle_agents.observe(idle_agents.read_json(quiet_path), pid,
                                                   idle_agents.work_digest(u.guarded_row_counts(state)), now,
                                                   idle_agents.quiet_minutes(config))
                if left:
                    u._write_private(quiet_path, (json.dumps(marker, indent=2) + '\n').encode())
                    return refusal(reason, wait=left)
    wait = restart_wait(idle_agents.read_json(marker_path), pid, now)
    if wait:
        return refusal(reason, retry=wait)
    files = [state / name for name in u.DATABASE_FILES if (state / name).exists()]
    others = other_openers(files, {pid, os.getpid()}, u.LSOF_TIMEOUT_SECONDS)
    if others:
        return refusal(reason, others=len(others))
    # Last: the same service still has the fault, so a service restarted meanwhile is left alone.
    try:
        if reason == 'detached':
            u.assert_database_attached(pid, state)
        else:
            u.assert_database_locked(state)
    except AssertionError as again:
        if str(again) != str(error):
            raise
    else:
        return None
    # The lsof waits above can take a minute: the service may have been restarted, and work may
    # have started, since. Nothing holds new work outside a held request (idle_agent_refusal's
    # guard=settled does the same before every signal); a requested deleted-log stop saves it.
    if u._service(identity)['runtime']['pid'] != pid or not (held or reason == 'detached' or quiet()):
        return None
    report = {} if report is None else report
    report.update(schemaVersion=1, identity=identity, reason=reason, servicePid=pid, result='refused',
                  trigger='held' if held else 'update-now' if request else 'idle')
    receipts = u.safe_path(updates / 'receipts', home)
    receipts.mkdir(mode=0o700, exist_ok=True)
    try:
        # Written first, so a restart that fails part way still counts against RESTART_EVERY.
        u._write_private(marker_path, (json.dumps({'schemaVersion': 1, 'servicePid': pid, 'restartedAt': now.isoformat()}) + '\n').encode())
        if os.path.lexists(str(quiet_path)):
            quiet_path.unlink()
        if reason == 'detached':
            try:
                u.stop_then_start_service(owner.domain, service['label'], pid)
            except AssertionError as stopped:
                if str(stopped) != u.DETACHED_STOP_TIMEOUT:
                    raise
                # Still running and still saving, or stuck: never killed. RESTART_EVERY holds the
                # next attempt; the person sees the agent's error until then.
                report['result'] = 'stop-timed-out'
                return refusal(reason, retry=int(RESTART_EVERY.total_seconds()))
        else:
            u.restart_service(owner.domain, service['label'], service['plist'], None, None, pid, service['receipt']['port'])
        report['result'] = 'restart-requested'
        report['newServicePid'] = u.wait_for_database_owner(identity, pid)
        if report['newServicePid'] is not None:
            report['result'] = 'restarted'
    finally:  # Whatever was sent is recorded, even when the restart failed.
        _write_record(u, receipts, now, report)
    return refusal(reason, restarted=1)
