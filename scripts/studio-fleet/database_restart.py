"""An update's way past a service that lost its hold on its own database.

M4, 2026-10-19: the service had dropped its SQLite locks (update.LOCKS_LOST). Every snapshot
refused with `REFUSAL environment`, the update agent reported an error every ten minutes, and
nothing restarted the service, although only reopening the database (in practice restarting
the process) gives the locks back (docs/operations/live-database.md). Such a refusal, or one
for a deleted log (update.DETACHED_DATABASE), is now `REFUSAL restart-needed`, and update.py
(database_restart_refusal) restarts the verified service with `launchctl kickstart -k` when:

- an Update now request is pending and the running service holds itself for it
  (update.assert_held: it drained its work); or, for lost locks only, the service is idle:
  the database shows no work and only its own idle provider servers run beneath it, at once
  for a pending Update now request, else for the quiet window of a normal update that may
  install now. A deleted log is restarted only for a held request: the database on disk
  misses the service's newest commits, so it cannot prove the service idle;
- no other process has statev2.sqlite, -wal or -shm open (lsof). With its locks gone, the
  service's closing connection checkpoints and deletes -wal, which is safe only while no
  other process uses the database;
- this service pid was not restarted for this in the last RESTART_EVERY;
- right before the restart, the same service pid still runs and, unless it is held, is still
  idle: nothing holds new work while lsof runs, and a turn started meanwhile is not killed.

The database is read only through live_database.connect, and no snapshot is taken while the
locks are lost. The snapshot still refuses; the restart waits until the new service holds its
locks again, and the next snapshot decides as before. The update agent says it is restarting
the app only for a line with restarted=, wait= or retry=; any other restart-needed line is an
error that asks the person to restart SpecWithCode. Stdlib only, Python 3.9 compatible.
"""
import datetime
import subprocess

import idle_agents

CODE = 'restart-needed'
MARKER = 'database-restart.json'  # The last restart: service pid and time, for RESTART_EVERY.
QUIET_MARKER = 'database-restart-quiet.json'  # idle_agents.observe's record for the quiet window.
RESTART_EVERY = datetime.timedelta(minutes=30)
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
