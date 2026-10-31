#!/usr/bin/env python3
"""Read-only health check of one SpecWithCode service home.

For a base dir (~/.specwithcode/<identity>) it checks that the server answers on its port
and runs the installed release, that no update hold outlived its request
(updates/hold.json), that the update agent is not in error and its last install was not
held or rolled back (updates/state.json), which spans failed in the last minutes
(userdata/logs/server.trace.ndjson and its rotations), whether one warning floods
stdout.log (and the stdout.log.1 the update agent rotates it to), and how much disk is
free. It prints a one-screen summary, or JSON with --json, and exits 0 when healthy, 1 when
degraded and 2 when the server does not answer or the disk is almost full.

It writes nothing unless --write names a file for the JSON report. The Status page shows a
"Health watch" component for <baseDir>/health/latest.json, so a watch every 5 minutes is:

  mkdir -p ~/.specwithcode/m4/health
  fleet_health.py --identity m4 --print-plist > ~/Library/LaunchAgents/com.specweave.studio.health.m4.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.specweave.studio.health.m4.plist

--print-plist only prints the LaunchAgent; it installs and starts nothing.
"""
import argparse
import collections
import datetime
import glob
import http.client
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request

import studio_paths

OK, DEGRADED, DOWN = 'ok', 'degraded', 'down'
EXIT_CODES = {OK: 0, DEGRADED: 1, DOWN: 2}
RANK = {OK: 0, DEGRADED: 1, DOWN: 2}

ENVIRONMENT_PATH = '/.well-known/studio/environment'
# A hold whose install request never came is the 2026-10-16 incident; a short grace lets the
# drain write its request first. Any hold older than HOLD_STALE_SECONDS is reported as well.
HOLD_REQUEST_GRACE_SECONDS = 15
HOLD_STALE_SECONDS = 120
TRACE_MINUTES = 15
FLOOD_MINUTES = 10
FLOOD_COUNT = 20
# Only the end of stdout.log is read; at the fleet's Warn level 8 MiB is hours of output.
STDOUT_TAIL_BYTES = 8 << 20
# A full disk stalls the server for seconds at a time (its database writes wait), and every
# client then reports the machine as offline; one finding names the cause instead.
DISK_WARN_BYTES = 5 * 10 ** 9  # Decimal GB, as the summaries print them.
DISK_FAIL_BYTES = 10 ** 9
USER_FACING_PREFIXES = ('ws.rpc.', 'RpcClient.')
# Answers, not faults: the app probes for an optional specweave-studio.json, and file views
# and listings ask about files or worktrees removed since. Judged per span and counted apart,
# never reported as failures. A missing program (`spawn git ENOENT`) is not an answer.
EXPECTED_ANSWER = re.compile(r"File not found: |ENOENT: no such file or directory, (?:realpath|open|stat|lstat|scandir)"
                             r"|WorkspaceRootNotExistsError|Workspace root does not exist")
# A server that started this recently is still booting, usually after an update restart.
STARTUP_GRACE_SECONDS = 180
LOG_LINE = re.compile(r'^\[(\d\d):(\d\d):(\d\d)\.(\d{3})\] (WARN|ERROR|FATAL) \(#\d+\): (.*)$')
LOG_CLOCK = re.compile(r'^\[(\d\d):(\d\d):(\d\d)\.(\d{3})\] [A-Z]+ \(#\d+\):')
ERROR_STATUS = re.compile(r'"code":\s*"2"')  # Cheap filter before parsing; OTLP status code 2 is ERROR.
CAUSE_LINE = re.compile(r'\[cause\]: ([^\n]+)')
# Paths in messages (workspace roots, thread ids) would split one failure into many groups.
PATH_TEXT = re.compile(r"(?<![\w.])/(?:[^\s'\"/]+/)*[^\s'\":,)]*")


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def parse_iso(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def read_json(path):
    try:
        with open(str(path), encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def finding(check, level, summary, **details):
    return dict({'check': check, 'level': level, 'summary': summary}, **details)


def ago(now, then):
    seconds = int((now - then).total_seconds())
    return '%dm%02ds' % (seconds // 60, seconds % 60) if seconds >= 60 else '%ds' % seconds


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)  # Existence check only; never sends a terminating signal.
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def probe_host(host):
    """A wildcard bind answers on loopback; an IPv6 literal needs brackets in a URL."""
    if host in ('0.0.0.0', '', None):
        return '127.0.0.1'
    if host in ('::', '[::]'):
        return '[::1]'
    return '[%s]' % host if ':' in host and not host.startswith('[') else host


def fetch_environment(host, port, timeout):
    url = 'http://%s:%d%s' % (probe_host(host), int(port), ENVIRONMENT_PATH)
    with urllib.request.urlopen(url, timeout=timeout) as response:
        environment = json.loads(response.read(1 << 20).decode('utf-8'))
    if not isinstance(environment, dict):
        raise ValueError('environment is not a JSON object')
    return environment


def check_server(base, timeout=5, fetch=fetch_environment, now=None):
    """(a) The server answers on its port and runs the release installation.json names."""
    installation = read_json(base / 'installation.json') or {}
    runtime = read_json(base / 'userdata' / 'server-runtime.json') or {}
    host = installation.get('host') or runtime.get('host') or '127.0.0.1'
    port = installation.get('port') or runtime.get('port') or 8319
    expected = {'version': installation.get('version'), 'sourceCommit': installation.get('sourceCommit')}
    release = installation.get('release')
    manifest = read_json(pathlib.Path(release) / 'studio-manifest.json') if release else None
    if manifest:
        expected = {'version': manifest.get('version'), 'sourceCommit': manifest.get('sourceCommit')}
    details = {'port': port, 'installed': expected, 'pid': runtime.get('pid'),
               'pidAlive': pid_alive(runtime.get('pid')), 'startedAt': runtime.get('startedAt')}
    try:
        environment = fetch(host, port, timeout)
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException) as error:
        started = parse_iso(runtime.get('startedAt'))
        # One grace per outage: a server crash-looping through launchd starts afresh every time,
        # so a watch that already saw it starting reports it down.
        previous = read_json(base / 'health' / 'latest.json') or {}
        was_starting = any(entry.get('check') == 'server' and entry.get('starting')
                           for entry in previous.get('checks') or [] if isinstance(entry, dict))
        booting = started is not None and details['pidAlive'] and not was_starting and \
            0 <= (now or utcnow()).timestamp() - started.timestamp() < STARTUP_GRACE_SECONDS
        if booting:
            return finding('server', OK, 'Server is starting on %s:%s (started %s ago)' % (
                host, port, ago(now or utcnow(), started)), starting=True, **details)
        return finding('server', DOWN, 'Server does not answer on %s:%s (%s)' % (host, port, error), **details)
    running = {'version': environment.get('serverVersion'), 'sourceCommit': environment.get('serverSourceCommit')}
    details['running'] = running
    if expected['version'] and running['version'] != expected['version'] or \
            expected['sourceCommit'] and running['sourceCommit'] != expected['sourceCommit']:
        return finding('server', DEGRADED, 'Server runs %s (%s), installed release is %s (%s)' % (
            running['version'], (running['sourceCommit'] or '?')[:12], expected['version'],
            (expected['sourceCommit'] or '?')[:12]), **details)
    return finding('server', OK, 'Server %s answers on port %s' % (running['version'], port), **details)


def check_hold(base, now):
    """(b) updates/hold.json with no install request since it began, or held too long."""
    hold = read_json(base / 'updates' / 'hold.json')
    if hold is None:
        if (base / 'updates' / 'hold.json').exists():
            return finding('hold', DEGRADED, 'updates/hold.json exists but is not readable JSON')
        return finding('hold', OK, 'No update hold')
    started = parse_iso(hold.get('startedAt'))
    expires = parse_iso(hold.get('expiresAt'))
    config = read_json(base / 'updates' / 'config.json') or {}
    requested = parse_iso(config.get('installRequestedAt'))
    state = read_json(base / 'updates' / 'state.json') or {}
    details = {'startedAt': hold.get('startedAt'), 'expiresAt': hold.get('expiresAt'), 'pid': hold.get('pid'),
               'pidAlive': pid_alive(hold.get('pid')), 'installRequestedAt': config.get('installRequestedAt'),
               'agentStatus': state.get('status')}
    runtime = read_json(base / 'userdata' / 'server-runtime.json') or {}
    holder, server_pid = hold.get('pid'), runtime.get('pid')
    if details['pidAlive'] is False or (isinstance(server_pid, int) and isinstance(holder, int)
                                        and server_pid != holder and pid_alive(server_pid)):
        # The hold lives in the process that took it; a file left by a killed process holds nothing.
        return finding('hold', OK, 'Leftover updates/hold.json from exited process %s; nothing is held' % holder,
                       leftover=True, **details)
    if started is None:
        return finding('hold', DEGRADED, 'Update hold has no start time', **details)
    age = (now - started).total_seconds()
    problems = []
    if (requested is None or requested < started) and age > HOLD_REQUEST_GRACE_SECONDS:
        problems.append('no install request since it began')
    if age > HOLD_STALE_SECONDS:
        problems.append('held for %s' % ago(now, started))
    if expires is not None and expires < now:
        problems.append('expired %s ago' % ago(now, expires))
    if not problems:
        return finding('hold', OK, 'Update hold began %s ago for a pending install' % ago(now, started), **details)
    return finding('hold', DEGRADED, 'Update hold refuses new work: ' + ', '.join(problems)
                   + (' (until %s)' % hold.get('expiresAt') if expires and expires > now else ''), **details)


def check_updates(base):
    """(c) The update agent reports an error, or its last install was held or rolled back."""
    state = read_json(base / 'updates' / 'state.json')
    if state is None:
        return finding('updates', OK, 'No update agent state')
    last = state.get('lastInstall') or {}
    details = {'status': state.get('status'), 'installedVersion': state.get('installedVersion'),
               'message': state.get('message'), 'lastInstall': last or None}
    problems = []
    if state.get('status') == 'error':
        problems.append((state.get('message') or 'update agent error').rstrip('.'))
    if last.get('result') == 'failed':
        receipt = read_json(last['receipt']) if isinstance(last.get('receipt'), str) else None
        rollback = str((receipt or {}).get('rollback') or '')
        kind = 'held for review' if rollback.startswith('held-') else 'rolled back' if rollback else 'failed'
        details['rollback'] = rollback or None
        details['receiptError'] = (receipt or {}).get('error')
        problems.append('install of %s %s%s' % (last.get('version'), kind,
                                                 ': ' + details['receiptError'] if details['receiptError'] else ''))
    if not problems:
        return finding('updates', OK, 'Update agent %s, installed %s' % (state.get('status'),
                                                                          state.get('installedVersion')), **details)
    return finding('updates', DEGRADED, '; '.join(problems), **details)


def trace_files(logs):
    """server.trace.ndjson then .1, .2 and on, newest first."""
    def rank(path):
        suffix = path.rsplit('.ndjson', 1)[1].lstrip('.')
        return int(suffix) if suffix.isdigit() else 0
    return sorted(glob.glob(str(logs / 'server.trace.ndjson*')), key=rank)


def span_failure(span):
    """The failure message of an error span, or None for a success or an interruption."""
    status = span.get('status')
    if isinstance(status, dict) and str(status.get('code')) == '2':
        for event in span.get('events') or []:
            message = (event.get('attributes') or {}).get('exception.message')
            if event.get('name') == 'exception' and message:
                return message, None
        return status.get('message') or 'error', None
    outcome = span.get('exit')
    if isinstance(outcome, dict) and outcome.get('_tag') == 'Failure':
        cause = str(outcome.get('cause') or 'Failure')
        causes = CAUSE_LINE.findall(cause)
        return cause.split('\n', 1)[0].strip(), (causes[-1].strip() if causes else None)
    return None


def innermost_cause(span_id, children, roots):
    """The cause recorded deepest among the failed spans beneath span_id."""
    best, depth, stack, seen = None, -1, [(span_id, 0)], set()
    while stack:
        current, level = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        if current in roots and level > depth:
            best, depth = roots[current], level
        stack.extend((child, level + 1) for child in children.get(current, ()))
    return best


def check_traces(base, now, minutes=TRACE_MINUTES):
    """(d) Error spans of the last minutes by name and message; any user-facing RPC failure."""
    cutoff = now - datetime.timedelta(minutes=minutes)
    cutoff_ns = int(cutoff.timestamp() * 1e9)
    until_ns = int((now + datetime.timedelta(minutes=1)).timestamp() * 1e9)  # A replay with --now skips later spans.
    groups = collections.OrderedDict()
    children = collections.defaultdict(list)  # failed parent span -> its failed child spans
    roots = {}  # failed span -> the innermost cause it recorded
    spans = collections.defaultdict(list)  # user-facing group -> its failed span ids
    files = trace_files(base / 'userdata' / 'logs')
    read = 0
    for path in files:
        try:
            if os.stat(path).st_mtime < cutoff.timestamp():
                break  # Rotated files only get older from here.
            handle = open(path, encoding='utf-8', errors='replace')
        except OSError:
            continue
        read += 1
        with handle:
            for line in handle:
                if '"Failure"' not in line and not ERROR_STATUS.search(line):
                    continue
                try:
                    span = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(span, dict):
                    continue
                try:
                    ended = int(span.get('endTimeUnixNano') or span.get('startTimeUnixNano') or 0)
                    if not cutoff_ns <= ended <= until_ns:
                        continue
                except (TypeError, ValueError):
                    continue
                failure = span_failure(span)
                if failure is None:
                    continue
                message, root = (PATH_TEXT.sub('<path>', text)[:200] if text else text for text in failure)
                key = (span.get('name') or '?', message)
                entry = groups.setdefault(key, {'name': key[0], 'message': key[1], 'rootCause': root, 'count': 0,
                                                'userFacing': key[0].startswith(USER_FACING_PREFIXES),
                                                'answers': 0, 'failures': 0, 'lastAt': None})

                entry['count'] += 1
                span_id = span.get('spanId')
                if span_id:
                    if span.get('parentSpanId'):
                        children[span['parentSpanId']].append(span_id)
                    if root:
                        roots[span_id] = root
                if entry['userFacing']:
                    spans[key].append((span_id, root))
                at = datetime.datetime.fromtimestamp(ended / 1e9, datetime.timezone.utc).isoformat()
                if entry['lastAt'] is None or at > entry['lastAt']:
                    entry['lastAt'] = at
    uncaused = collections.defaultdict(int)  # user-facing group -> its spans with no cause of their own
    for key, entry in groups.items():
        # A user-facing failure often carries only a generic message ("The project operation failed");
        # a failed span beneath it says why (ServiceUpdateInProgressError on 2026-10-16). Each span is
        # judged by its own cause, so one not-found answer never excuses a different failure.
        first_failure = None
        for span_id, root in spans[key]:
            cause = root or (innermost_cause(span_id, children, roots) if span_id else None)
            if EXPECTED_ANSWER.search(entry['message'] or '') or EXPECTED_ANSWER.search(cause or ''):
                entry['answers'] += 1
            elif cause is None and key[0].startswith('RpcClient.'):
                uncaused[key] += 1
            else:
                entry['failures'] += 1
                first_failure = first_failure or cause
        if entry['rootCause'] is None or first_failure:
            entry['rootCause'] = first_failure or entry['rootCause'] or next(
                (cause for span_id, _ in spans[key] if span_id
                 for cause in [innermost_cause(span_id, children, roots)] if cause), None)
    # A client span records only the message it was sent; the server span of the same call says why.
    # It is an answer when that method's server spans were all answers in this window.
    for key, count in uncaused.items():
        method = key[0][len('RpcClient.'):]
        served = [entry for entry in groups.values() if entry['name'] == 'ws.rpc.' + method]
        answered = served and all(entry['failures'] == 0 for entry in served) and \
            any(entry['answers'] for entry in served)
        groups[key]['answers' if answered else 'failures'] += count
    errors = sorted(groups.values(), key=lambda entry: (-entry['userFacing'], -entry['count']))
    user_facing = [entry for entry in errors if entry['userFacing'] and entry['failures']]
    answers = sum(entry['answers'] for entry in errors)
    failed_calls = sum(entry['failures'] for entry in user_facing)
    details = {'minutes': minutes, 'filesRead': read, 'errorSpans': sum(entry['count'] for entry in errors),
               'notFoundAnswers': answers, 'errors': errors}
    if not files:
        return finding('traces', OK, 'No server trace files', **details)
    if user_facing:
        worst = user_facing[0]
        return finding('traces', DEGRADED, '%d user-facing RPC failure%s in %d min, e.g. %s: %s' % (
            failed_calls, '' if failed_calls == 1 else 's', minutes, worst['name'],
            worst['rootCause'] or worst['message']), **details)
    return finding('traces', OK, '%d error span%s in %d min, none user-facing%s' % (
        details['errorSpans'], '' if details['errorSpans'] == 1 else 's', minutes,
        ' (%d not-found answer%s)' % (answers, '' if answers == 1 else 's') if answers else ''), **details)


def read_tail(path, size):
    with open(str(path), 'rb') as handle:
        handle.seek(0, os.SEEK_END)
        end = handle.tell()
        handle.seek(max(0, end - size))
        data = handle.read()
    text = data.decode('utf-8', errors='replace')
    return text.split('\n', 1)[1] if end > size and '\n' in text else text


def read_rotated_tail(path, size, cutoff):
    """(text, modified) for the end of <name>.1 when the live log was just rotated and holds
    less than the tail read, so the window still spans the rotation; ('', None) when there
    is none or it was last written before `cutoff`. The rotation writes .1 at that moment,
    so its mtime bounds its clock-only stamps: a weeks-old .1 is never dated from today."""
    older = path.with_name(path.name + '.1')
    if size <= 0 or older.is_symlink() or not older.is_file():
        return '', None
    try:
        modified = older.stat().st_mtime
        if modified < cutoff.timestamp():
            return '', None
        text = read_tail(older, size)
    except OSError:
        return '', None
    return text, modified


def folder_bytes(folder):
    """Sizes of the files directly in `folder`: a state backup holds nothing deeper."""
    total = 0
    try:
        with os.scandir(str(folder)) as entries:
            for entry in entries:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
    except OSError:
        pass
    return total


def check_disk(base, warn=DISK_WARN_BYTES, fail=DISK_FAIL_BYTES, usage=None):
    """(f) Free space on the disk holding the service home, with what the app keeps there:
    its pre-update database copies (backups/pre-*, one level of stat) and unpacked releases
    (install/releases, counted, not walked)."""
    free = (usage or shutil.disk_usage)(str(base)).free
    root = base.parent
    backups = root / 'backups'
    copies = []
    if backups.is_dir() and not backups.is_symlink():
        try:
            copies = [entry for entry in backups.iterdir()
                      if entry.name.startswith('pre-') and entry.is_dir() and not entry.is_symlink()]
        except OSError:
            copies = []
    backup_bytes = sum(folder_bytes(entry) for entry in copies)
    releases = root / 'install' / 'releases'
    try:
        release_count = sum(1 for entry in releases.iterdir() if entry.is_dir() and not entry.is_symlink()) \
            if releases.is_dir() and not releases.is_symlink() else 0
    except OSError:
        release_count = 0
    details = {'freeBytes': free, 'warnBelowBytes': warn, 'failBelowBytes': fail,
               'backups': {'path': str(backups), 'copies': len(copies), 'bytes': backup_bytes},
               'install': {'path': str(releases), 'releases': release_count}}
    holds = 'backups/ holds %d database cop%s (%.1f GB), install/ %d release%s' % (
        len(copies), 'y' if len(copies) == 1 else 'ies', backup_bytes / 1e9,
        release_count, '' if release_count == 1 else 's')
    if free < warn:
        return finding('disk', DOWN if free < fail else DEGRADED,
                       'Disk almost full: %.1f GB free; %s' % (free / 1e9, holds), **details)
    return finding('disk', OK, '%.1f GB free; %s' % (free / 1e9, holds), **details)


def log_time(now_local, hours, minutes, seconds, millis):
    """stdout.log stamps carry local time of day only; the latest such moment not after now."""
    stamp = now_local.replace(hour=hours, minute=minutes, second=seconds, microsecond=millis * 1000)
    if stamp > now_local + datetime.timedelta(minutes=1):
        stamp -= datetime.timedelta(days=1)
    return stamp


def dated_log_lines(text, latest):
    """Infer dates from observed midnight rollovers, including informational headers.

    A clock-only log cannot reveal whole silent days. Use the last file write as
    the upper bound, and treat large reverse clock jumps as midnight crossings;
    small out-of-order writes must not silently age an entire current flood.
    """
    cursor = None
    for line in reversed(text.split('\n')):
        clock = LOG_CLOCK.match(line)
        if not clock:
            continue
        hours, mins, secs, millis = (int(part) for part in clock.groups())
        try:
            if cursor is None:
                stamp = log_time(latest, hours, mins, secs, millis)
            else:
                stamp = cursor.replace(hour=hours, minute=mins, second=secs,
                                       microsecond=millis * 1000)
                if stamp - cursor > datetime.timedelta(hours=12):
                    stamp -= datetime.timedelta(days=1)
                elif cursor - stamp > datetime.timedelta(hours=12):
                    # A delayed pre-midnight write may follow newer midnight rows.
                    # Keep the cursor at the earliest time seen so small disorder
                    # cannot cumulatively shift the inferred timeline forward.
                    next_day = stamp + datetime.timedelta(days=1)
                    if next_day - cursor <= datetime.timedelta(minutes=5) and next_day <= latest:
                        stamp = next_day
        except ValueError:
            continue
        cursor = min(cursor, stamp) if cursor is not None else stamp
        yield stamp, line


def check_log_flood(base, now, minutes=FLOOD_MINUTES, limit=FLOOD_COUNT):
    """(e) One warning or error message logged more than `limit` times in the last minutes."""
    path = base / 'stdout.log'
    now_local = now.astimezone()
    cutoff = now_local - datetime.timedelta(minutes=minutes)
    try:
        # Time-only stamps can match today's clock even when the entire file is old.
        # An untouched log cannot contain warnings from this observation window.
        modified = path.stat().st_mtime
        if modified < cutoff.timestamp():
            return finding('log', OK, 'stdout.log not modified in the last %d min' % minutes,
                           minutes=minutes, limit=limit, byLevel={}, floods=[], top=[])
        text = read_tail(path, STDOUT_TAIL_BYTES)
    except OSError:
        return finding('log', OK, 'No stdout.log')
    older, older_modified = read_rotated_tail(path, STDOUT_TAIL_BYTES - len(text), cutoff)
    # Each file is dated from its own last write: the stamps carry a time of day only.
    parts = [(older, older_modified)] if older else []
    parts.append((text, modified))
    counts = collections.Counter()
    levels = collections.Counter()
    for part, written in parts:
        latest = datetime.datetime.fromtimestamp(written).astimezone()
        for stamp, line in dated_log_lines(part, latest):
            match = LOG_LINE.match(line)
            if not match:
                continue
            if stamp < cutoff or stamp > now_local + datetime.timedelta(minutes=1):
                continue
            counts[(match.group(5), match.group(6).strip())] += 1
            levels[match.group(5)] += 1
    floods = [{'level': level, 'message': message, 'count': count}
              for (level, message), count in counts.most_common() if count > limit]
    details = {'minutes': minutes, 'limit': limit, 'byLevel': dict(levels), 'floods': floods,
               'timestampQualification': 'Dates inferred from clock order; silent whole-day gaps remain ambiguous.',
               'top': [{'level': level, 'message': message, 'count': count}
                       for (level, message), count in counts.most_common(5)]}
    if floods:
        return finding('log', DEGRADED, '%s logged %d times in %d min: %s' % (
            floods[0]['level'], floods[0]['count'], minutes, floods[0]['message']), **details)
    return finding('log', OK, '%d warning%s, %d error%s in %d min' % (
        levels['WARN'], '' if levels['WARN'] == 1 else 's', levels['ERROR'] + levels['FATAL'],
        '' if levels['ERROR'] + levels['FATAL'] == 1 else 's', minutes), **details)


def report(base, now=None, trace_minutes=TRACE_MINUTES, timeout=5, fetch=fetch_environment):
    base = pathlib.Path(base)
    now = now or utcnow()
    checks = [('server', lambda: check_server(base, timeout, fetch, now)), ('hold', lambda: check_hold(base, now)),
              ('updates', lambda: check_updates(base)), ('traces', lambda: check_traces(base, now, trace_minutes)),
              ('log', lambda: check_log_flood(base, now)), ('disk', lambda: check_disk(base))]
    findings = []
    for name, run in checks:
        try:
            findings.append(run())
        except Exception as error:  # One unreadable file must not stop the report the Status page reads.
            findings.append(finding(name, DEGRADED, 'Check failed: %s: %s' % (type(error).__name__, error)))
    status = max((entry['level'] for entry in findings), key=RANK.get)
    return {'schemaVersion': 1, 'baseDir': str(base), 'checkedAt': now.isoformat(), 'status': status,
            'problems': [entry['summary'] for entry in findings if entry['level'] != OK], 'checks': findings}


def human(result):
    mark = {OK: 'ok  ', DEGRADED: 'WARN', DOWN: 'DOWN'}
    lines = ['%s  %s  %s' % (result['status'].upper(), result['baseDir'], result['checkedAt'])]
    for entry in result['checks']:
        lines.append('  [%s] %-8s %s' % (mark[entry['level']], entry['check'], entry['summary']))
        if entry['check'] == 'traces':
            for error in entry.get('errors', [])[:8]:
                lines.append('           %4dx %s%s: %s%s' % (error['count'], '* ' if error['userFacing'] else '',
                                                             error['name'], error['message'][:90],
                                                             ' <- ' + error['rootCause'][:60] if error['rootCause'] else ''))
        if entry['check'] == 'log':
            for top in entry.get('top', [])[:3]:
                lines.append('           %4dx %s %s' % (top['count'], top['level'], top['message'][:100]))
    return '\n'.join(lines)


def write_atomically(path, contents):
    path = pathlib.Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix='.' + path.name + '.')
    with os.fdopen(handle, 'w', encoding='utf-8') as out:
        out.write(contents)
    os.replace(temporary, str(path))


PLIST = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.specweave.studio.health.{identity}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string><string>-B</string><string>{script}</string>
    <string>--base-dir</string><string>{base}</string>
    <string>--write</string><string>{base}/health/latest.json</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>{base}/health/watch.log</string>
</dict>
</plist>
'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--identity', choices=['m4', 'm1', 'm3', 'stage'], default='m4')
    parser.add_argument('--base-dir', help='Service home (defaults to the identity home).')
    parser.add_argument('--minutes', type=float, default=TRACE_MINUTES, help='How far back to read error spans.')
    parser.add_argument('--timeout', type=float, default=5.0, help='Seconds to wait for the server.')
    parser.add_argument('--now', help='ISO time to check as of (for replaying an incident).')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--write', help='Also save the JSON report to this file.')
    parser.add_argument('--print-plist', action='store_true', help='Print a LaunchAgent that runs this every 5 min.')
    args = parser.parse_args(argv)
    base = pathlib.Path(args.base_dir).expanduser() if args.base_dir else \
        studio_paths.identity_home(pathlib.Path.home(), args.identity)
    if args.print_plist:
        print(PLIST.format(identity=args.identity, script=pathlib.Path(__file__).resolve(), base=base), end='')
        return 0
    now = parse_iso(args.now) if args.now else None
    if args.now and now is None:
        parser.error('--now must be an ISO time')
    result = report(base, now, args.minutes, args.timeout)
    encoded = json.dumps(result, indent=2)
    if args.write:
        write_atomically(args.write, encoded + '\n')
    print(encoded if args.json else human(result))
    return EXIT_CODES[result['status']]


if __name__ == '__main__':
    sys.exit(main())
