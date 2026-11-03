"""A normal update's way past the provider servers an idle service keeps open between turns.

M3, 2026-10-19: an automatic update waited for days with "Waiting for open SpecWithCode
terminals and agent processes to close (codex, codex-code-mode-host, node x3, node_repl x4)".
Those were the shared Codex app-server and its helpers, open while nothing ran: no run, no
pending request, nothing queued. Every snapshot refuses any process beneath the service, and
only Update now (a forced, held request) had a way to stop one, so a Mac that keeps a provider
open never updated on its own.

When a snapshot refuses for processes beneath the service, update.py (idle_agent_refusal)
lets a normal update stop them, but only when all of this holds:

- updates/config.json lets an update install now: automatic installs, or a pending request
  that was not cancelled, and not a forced request (Update now has its own reap);
- the database shows no work: no running run, queued message, pending request, unfinished
  effect or active provider session (the snapshot's own idle predicate);
- every process beneath the service, its server browser aside, belongs to one of its own idle
  provider servers (quiescence.idle_provider_trees): a terminal keeps the update waiting;
- the same service has shown the same row counts (the update agent's own measure of work,
  its bookkeeping logs left out) for the quiet window, `quietMinutes` of the update settings,
  across at least two snapshots. The first sighting is recorded in updates/idle-agents.json.

The stop is quiescence.reap_descendants with the same guards as Update now's: the service
verified, each process recorded by pid, owner, start time and kernel executable, re-read right
before its signal, and the reap stopped when the service restarted or any check above fails
(run again before every signal). The snapshot still refuses; the next one decides as before,
so the update agent waits its usual quiet time before installing.

The update agent runs the target release's own update.py for snapshots, so this takes effect
for every Mac updating to the release that ships it, whatever agent that Mac runs. Stdlib only,
Python 3.9 compatible.
"""
import datetime
import hashlib
import json
import math

MARKER = 'idle-agents.json'
CODE = 'idle-agents'
DEFAULT_QUIET_MINUTES = 10  # update_agent.DEFAULT_CONFIG['quietMinutes']
# update_agent.BOOKKEEPING_COUNTS: logs the service appends to on its own while it waits.
BOOKKEEPING_COUNTS = ('orchestration_events', 'orchestration_command_receipts')
# update.native_work_counts keys that are work; `held` (queued runs in a held queue) is not.
WORK_KEYS = ('runs', 'queued', 'requests', 'effects', 'sessions')
FUTURE_SKEW = datetime.timedelta(minutes=5)
MAX_FILE_BYTES = 64 << 10
NOT_ALLOWED = 'A normal update may not stop processes beneath the service now'


def utc(value):
    """An ISO time with its zone (`Z` included), or None."""
    if not isinstance(value, str) or not 0 < len(value) <= 64:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def read_json(path):
    """A small JSON object from a regular file (never a link), else None."""
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def allowed(config):
    """True when the update settings let an update install now without forcing it."""
    if not isinstance(config, dict) or config.get('installMode', 'normal') != 'normal':
        return False
    requested = config.get('installRequestedAt')
    cancelled = config.get('installCancelledAt')
    if cancelled is not None:
        # update_agent.install_cancelled: a cancel after the request (or with none) stands.
        if utc(cancelled) is None or requested is None or utc(requested) is None or utc(cancelled) > utc(requested):
            return False
    return config.get('installAutomatically') is True or utc(requested) is not None


def quiet_minutes(config):
    value = config.get('quietMinutes') if isinstance(config, dict) else None
    return value if type(value) is int and 0 <= value <= 10080 else DEFAULT_QUIET_MINUTES


def idle(work):
    """True when none of update.native_work_counts' work counts is above zero."""
    return all(type(work.get(key)) is int and work[key] == 0 for key in WORK_KEYS)


def work_digest(counts):
    """A hash of the guarded tables' row counts, the bookkeeping logs left out."""
    kept = {table: count for table, count in counts.items() if table not in BOOKKEEPING_COUNTS}
    return hashlib.sha256(json.dumps(kept, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def observe(marker, service_pid, digest, now, quiet):
    """(marker to keep, seconds of quiet still needed). The window counts from the first
    snapshot that saw this service with these row counts; a new service, other counts, a
    malformed or future-dated record starts it again, and a first sighting never ends it."""
    since = None
    if (isinstance(marker, dict) and marker.get('schemaVersion') == 1 and marker.get('servicePid') == service_pid
            and marker.get('workSha256') == digest):
        since = utc(marker.get('idleSince'))
        if since is not None and since > now + FUTURE_SKEW:
            since = None
    if since is None:
        fresh = {'schemaVersion': 1, 'servicePid': service_pid, 'workSha256': digest, 'idleSince': now.isoformat()}
        return fresh, max(1, quiet * 60)
    return marker, max(0, int(math.ceil(quiet * 60 - (now - since).total_seconds())))


def refusal(providers, **detail):
    """`REFUSAL idle-agents codex=1 wait=540` (or `stopped=3`): provider names and counts only."""
    parts = ['%s=%d' % item for item in sorted(providers.items())[:6]]
    parts += ['%s=%d' % item for item in sorted(detail.items())]
    return ' '.join(['REFUSAL', CODE] + parts)


# Refusals after which the quiet window starts again (refusal_fallback).
WINDOW_RESETS = {'Native work is not idle', NOT_ALLOWED, 'Owned service has unexpected descendants',
                 'Owned service has unexpected or missing descendants'}


def refusal_fallback(u, identity, error, report=None, now=None):
    """update.py idle_agent_refusal, over its globals `u` (database_restart.Names, so a test's patch of
    update.X applies). A normal update's fallback when a snapshot refused for processes beneath the service
    (idle_agents): the service's own idle provider servers, and nothing else, are stopped once
    the database has shown no work and the same row counts for the quiet window. Returns the
    REFUSAL line, or None to keep refusal_line's; raises when the fallback does not apply. The
    snapshot still refuses: the next one decides. `report` holds the reap's record."""
    home = u.pathlib.Path.home().resolve()
    marker_path = u.safe_path(u.studio_paths.identity_home(home, identity) / 'updates' / MARKER, home)

    def restart_window(reason):
        """Work, a terminal or anything else this cannot stop: the quiet window starts again.
        A slow or busy reading says nothing about work and keeps it."""
        message = str(reason) if isinstance(reason, AssertionError) else ''
        if message in WINDOW_RESETS and u.os.path.lexists(str(marker_path)):
            marker_path.unlink()
    if not isinstance(error, AssertionError) or 'descendants' not in str(error):
        restart_window(error)
        return None
    service = u._service(identity)
    own, pid = service['own'], service['runtime']['pid']
    uid, node, arguments = service['owner'].uid, str(service['node']), service['content']['ProgramArguments']
    assert marker_path == u.safe_path(own / 'updates' / MARKER, home), 'Owned service home changed'
    config_path = u.safe_path(own / 'updates' / 'config.json', home)
    runtime_path = u.safe_path(own / 'userdata' / 'server-runtime.json', home)

    def settled():  # Checked first, and again right before every signal.
        assert (read_json(runtime_path) or {}).get('pid') == pid, 'Owned service process identity changed'
        config = read_json(config_path)
        assert allowed(config) and idle(u.native_work_counts(own / 'userdata')), NOT_ALLOWED
        return config
    try:
        config = settled()
        digest = work_digest(u.guarded_row_counts(own / 'userdata'))
        providers = u.idle_providers(pid, uid, node, arguments)
    except BaseException as reason:
        restart_window(reason)
        raise
    now = now or datetime.datetime.now(datetime.timezone.utc)
    marker, left = observe(read_json(marker_path), pid, digest, now, quiet_minutes(config))
    if left:
        u._write_private(marker_path, (json.dumps(marker, indent=2) + '\n').encode())
        return refusal(providers, wait=left)
    marker_path.unlink()
    report = {} if report is None else report
    report.update(schemaVersion=1, identity=identity, reason=CODE, servicePid=pid, providers=providers,
                  result='refused')
    receipts = u.safe_path(own / 'updates' / 'receipts', home)
    receipts.mkdir(mode=0o700, exist_ok=True)
    record = u.safe_path(receipts / ('idle-agents-%s-%s.json' % (now.strftime('%Y%m%dT%H%M%SZ'), u.uuid.uuid4().hex[:8])), home)
    try:
        u.reap_descendants(pid, uid, node, arguments, report=report, guard=settled, select=u.idle_provider_trees)
        report['result'] = 'reaped'
    finally:  # Whatever was signalled is recorded, even when the reap stopped part way.
        report['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        u._write_private(record, (json.dumps(report, indent=2) + '\n').encode())
    return refusal(providers, stopped=len(report['signals']))
