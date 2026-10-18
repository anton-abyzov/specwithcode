#!/usr/bin/env python3
"""Synthetic service homes only: never reads a live ~/.specwithcode home."""
import contextlib
import datetime
import hashlib
import http.server
import io
import json
import os
import pathlib
import socket
import tempfile
import threading
import unittest
import fleet_health

NOW = datetime.datetime(2026, 10, 17, 0, 56, tzinfo=datetime.timezone.utc)
COMMIT = '6beec0371bab214c2f516c377ac44f79a36a2c8c'


def iso(moment):
    return moment.isoformat().replace('+00:00', 'Z')


def nanos(moment):
    return str(int(moment.timestamp() * 1e9))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))


def effect_span(name, at, span_id, parent=None, cause=None, tag=None):
    span = {'type': 'effect-span', 'name': name, 'traceId': 't1', 'spanId': span_id, 'sampled': True,
            'kind': 'internal', 'startTimeUnixNano': nanos(at), 'endTimeUnixNano': nanos(at), 'attributes': {},
            'events': [], 'links': [], 'exit': {'_tag': tag or ('Failure' if cause else 'Success')}}
    if parent:
        span['parentSpanId'] = parent
    if cause:
        span['exit']['cause'] = cause
    return span


def client_span(name, at, message):
    return {'type': 'otlp-span', 'name': name, 'traceId': 't2', 'spanId': 'c1', 'sampled': True, 'kind': 'client',
            'startTimeUnixNano': nanos(at), 'endTimeUnixNano': nanos(at), 'attributes': {},
            'events': [{'name': 'exception', 'timeUnixNano': nanos(at),
                        'attributes': {'exception.type': 'ProjectWorkspaceError', 'exception.message': message}}],
            'links': [], 'status': {'code': '2', 'message': message}}


def log_line(moment, message, level='WARN'):
    return '[%s] %s (#101): %s\n  {\n    taskId: "x"\n  }\n' % (
        moment.astimezone().strftime('%H:%M:%S.000'), level, message)


class EnvironmentServer:
    """Serves /.well-known/studio/environment like a running service."""

    def __init__(self, version='1.0.38', commit=COMMIT):
        body = json.dumps({'serverVersion': version, 'serverSourceCommit': commit}).encode()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path == fleet_health.ENVIRONMENT_PATH else 404)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()


def closed_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def closed_pid():
    """A pid no running process has, found by counting down from a high one."""
    pid = 99990
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return pid
        except PermissionError:
            pass
        pid -= 1


def make_home(root, port, incident=False):
    base = pathlib.Path(root) / 'm4'
    release = pathlib.Path(root) / 'releases' / 'b61ebf7eb0ec909eca65'
    write(release / 'studio-manifest.json', {'version': '1.0.38', 'sourceCommit': COMMIT})
    write(base / 'installation.json', {'identity': 'm4', 'host': '127.0.0.1', 'port': port, 'release': str(release),
                                       'version': '1.0.38', 'sourceCommit': COMMIT})
    write(base / 'userdata' / 'server-runtime.json', {'version': 1, 'pid': os.getpid(), 'host': '127.0.0.1',
                                                      'port': port, 'startedAt': iso(NOW - datetime.timedelta(hours=2))})
    write(base / 'updates' / 'config.json', {'installRequestedAt': iso(NOW - datetime.timedelta(hours=3))})
    write(base / 'updates' / 'state.json', {'status': 'up-to-date', 'installedVersion': '1.0.38',
                                            'lastInstall': {'version': '1.0.38', 'result': 'updated'}})
    minute = datetime.timedelta(minutes=1)
    spans = [effect_span('GitHubApi.send', NOW - minute, 's0'),
             effect_span('ws.rpc.orchestration.subscribeThread', NOW - minute, 's1', tag='Interrupted',
                         cause='InterruptError: All fibers interrupted without error'),
             effect_span('ws.rpc.projects.listEntries', NOW - 40 * minute, 's2',
                         cause="ProjectListEntriesError: Failed to list workspace entries in '/old'.")]
    log = log_line(NOW - 2 * minute, 'Failed to enrich optional project metadata')
    if incident:
        # 2026-10-16 20:54 EDT: "Restart to update" drained the service and held it; the app relaunched,
        # the service did not, no install request followed, and the coordinator send was refused.
        held_at = NOW - 3 * minute
        write(base / 'updates' / 'hold.json', {'schemaVersion': 1, 'pid': os.getpid(), 'holdId': 'hold-1',
                                               'startedAt': iso(held_at),
                                               'expiresAt': iso(held_at + 15 * minute)})
        spans += [
            effect_span('ws.rpc.projects.coordinatorSend', NOW - minute, 'a1', parent='session',
                        cause='ProjectWorkspaceError: The project operation failed. Reload and try again.\n'
                              '    at fail (file:///release/binCli.mjs:221074:36)'),
            effect_span('ProjectCoordinatorAttachments.send', NOW - minute, 'a2', parent='a1',
                        cause='OrchestratorDispatchError: Failed to dispatch orchestration command message.dispatch'
                              ' (coordinator-send:1).\n    at file:///release/binCli.mjs:216872:127'),
            effect_span('ThreadMessageIntake.sendToThread', NOW - minute, 'a3', parent='a2',
                        cause='OrchestratorDispatchError: Failed to dispatch orchestration command message.dispatch'
                              ' (coordinator-send:1).\n    at file:///release/binCli.mjs:216872:127 {\n'
                              '  [cause]: ServiceUpdateInProgressError: SpecWithCode is installing an update. '
                              'Send this again after it restarts.\n}'),
            client_span('RpcClient.projects.coordinatorSend', NOW - minute,
                        'The project operation failed. Reload and try again.'),
        ]
    logs = base / 'userdata' / 'logs'
    write(logs / 'server.trace.ndjson.1', ''.join(json.dumps(span) + '\n' for span in spans[2:3]))
    write(logs / 'server.trace.ndjson', ''.join(json.dumps(span) + '\n' for span in spans[:2] + spans[3:]))
    write(base / 'stdout.log', log)
    os.utime(base / 'stdout.log', (NOW.timestamp(), NOW.timestamp()))
    return base


def snapshot(root):
    files = {}
    for path in sorted(pathlib.Path(root).rglob('*')):
        info = path.lstat()
        files[str(path)] = (info.st_mtime_ns, info.st_size,
                            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
    return files


def run_main(argv):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = fleet_health.main(argv)
    return code, buffer.getvalue()


class FleetHealth(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name

    def tearDown(self):
        self.directory.cleanup()

    def check(self, result, name):
        return next(entry for entry in result['checks'] if entry['check'] == name)

    def test_healthy_service_reports_ok_and_exits_zero(self):
        with EnvironmentServer() as server:
            base = make_home(self.root, server.port)
            code, out = run_main(['--base-dir', str(base), '--now', iso(NOW), '--json'])
        result = json.loads(out)
        self.assertEqual(code, 0, out)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['problems'], [])
        self.assertEqual(self.check(result, 'server')['running']['version'], '1.0.38')
        traces = self.check(result, 'traces')
        self.assertEqual(traces['errorSpans'], 0, 'an interruption is not an error, a 40-minute-old span is outside')

    def test_incident_stale_hold_and_refused_coordinator_send_are_degraded(self):
        with EnvironmentServer() as server:
            base = make_home(self.root, server.port, incident=True)
            code, out = run_main(['--base-dir', str(base), '--now', iso(NOW), '--json'])
        result = json.loads(out)
        self.assertEqual(code, 1, out)
        self.assertEqual(result['status'], 'degraded')
        hold = self.check(result, 'hold')
        self.assertEqual(hold['level'], 'degraded')
        self.assertIn('no install request since it began', hold['summary'])
        self.assertIn('held for 3m00s', hold['summary'])
        traces = self.check(result, 'traces')
        self.assertEqual(traces['level'], 'degraded')
        names = [entry['name'] for entry in traces['errors'] if entry['userFacing']]
        self.assertEqual(sorted(names), ['RpcClient.projects.coordinatorSend', 'ws.rpc.projects.coordinatorSend'])
        send = next(entry for entry in traces['errors'] if entry['name'] == 'ws.rpc.projects.coordinatorSend')
        self.assertTrue(send['rootCause'].startswith('ServiceUpdateInProgressError'), send)
        self.assertIn('ServiceUpdateInProgressError', traces['summary'])

    def test_human_summary_fits_one_screen(self):
        with EnvironmentServer() as server:
            base = make_home(self.root, server.port, incident=True)
            code, out = run_main(['--base-dir', str(base), '--now', iso(NOW)])
        self.assertEqual(code, 1)
        lines = out.splitlines()
        self.assertTrue(lines[0].startswith('DEGRADED'))
        self.assertLessEqual(len(lines), 24)
        self.assertTrue(any('[WARN] hold' in line for line in lines), out)
        self.assertTrue(any('<- ServiceUpdateInProgressError' in line for line in lines), out)

    def test_server_that_does_not_answer_is_down_with_exit_two(self):
        base = make_home(self.root, closed_port())
        code, out = run_main(['--base-dir', str(base), '--now', iso(NOW), '--json', '--timeout', '2'])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out)['status'], 'down')

    def test_server_running_another_release_is_degraded(self):
        with EnvironmentServer(version='1.0.37', commit='0' * 40) as server:
            base = make_home(self.root, server.port)
            result = fleet_health.report(base, NOW)
        server_check = self.check(result, 'server')
        self.assertEqual(server_check['level'], 'degraded')
        self.assertIn('installed release is 1.0.38', server_check['summary'])

    def test_fresh_hold_with_its_install_request_is_ok(self):
        base = make_home(self.root, closed_port())
        write(base / 'updates' / 'hold.json', {'pid': os.getpid(), 'startedAt': iso(NOW - datetime.timedelta(seconds=40)),
                                               'expiresAt': iso(NOW + datetime.timedelta(minutes=14))})
        write(base / 'updates' / 'config.json', {'installRequestedAt': iso(NOW - datetime.timedelta(seconds=38))})
        self.assertEqual(fleet_health.check_hold(base, NOW)['level'], 'ok')

    def test_hold_with_a_request_is_still_flagged_after_two_minutes(self):
        base = make_home(self.root, closed_port())
        write(base / 'updates' / 'hold.json', {'pid': os.getpid(), 'startedAt': iso(NOW - datetime.timedelta(minutes=3)),
                                               'expiresAt': iso(NOW + datetime.timedelta(minutes=12))})
        write(base / 'updates' / 'config.json', {'installRequestedAt': iso(NOW - datetime.timedelta(minutes=3))})
        hold = fleet_health.check_hold(base, NOW)
        self.assertEqual(hold['level'], 'degraded')
        self.assertNotIn('no install request', hold['summary'])
        self.assertIn('held for 3m00s', hold['summary'])

    def test_hold_file_left_by_an_exited_process_holds_nothing(self):
        base = make_home(self.root, closed_port())
        write(base / 'updates' / 'hold.json', {'pid': closed_pid(), 'startedAt': iso(NOW - datetime.timedelta(hours=1)),
                                               'expiresAt': iso(NOW - datetime.timedelta(minutes=45))})
        hold = fleet_health.check_hold(base, NOW)
        self.assertEqual(hold['level'], 'ok', hold)
        self.assertTrue(hold['leftover'])
        self.assertIn('nothing is held', hold['summary'])

    def test_a_check_that_crashes_is_reported_and_the_rest_still_run(self):
        base = make_home(self.root, closed_port())
        write(base / 'userdata' / 'logs' / 'server.trace.ndjson', '[1, 2]\n"Failure"\n')
        write(base / 'updates' / 'state.json', {'status': 'error', 'lastInstall': 'not an object'})

        def answer(host, port, timeout):
            return {'serverVersion': '1.0.38', 'serverSourceCommit': COMMIT}
        result = fleet_health.report(base, NOW, fetch=answer)
        self.assertEqual(self.check(result, 'server')['level'], 'ok')
        self.assertEqual(self.check(result, 'traces')['level'], 'ok')
        updates = self.check(result, 'updates')
        self.assertEqual(updates['level'], 'degraded')
        self.assertIn('Check failed: AttributeError', updates['summary'])
        self.assertIn('[WARN] updates  Check failed', fleet_health.human(result))

    def test_wildcard_and_ipv6_hosts_are_probed_on_loopback(self):
        self.assertEqual(fleet_health.probe_host('0.0.0.0'), '127.0.0.1')
        self.assertEqual(fleet_health.probe_host('::'), '[::1]')
        self.assertEqual(fleet_health.probe_host('fd7a::1'), '[fd7a::1]')
        self.assertEqual(fleet_health.probe_host('127.0.0.1'), '127.0.0.1')

    def test_agent_error_and_held_or_rolled_back_installs_are_degraded(self):
        base = make_home(self.root, closed_port())
        receipt = base / 'updates' / 'receipts' / 'update-1.0.39.json'
        write(receipt, {'result': 'update-failed', 'rollback': 'restored-runtime-pointers-and-state',
                        'error': 'AssertionError: rows changed during migration'})
        write(base / 'updates' / 'state.json', {
            'status': 'error', 'installedVersion': '1.0.38',
            'message': 'SpecWithCode 1.0.39 did not install automatically; choose Install now to retry.',
            'lastInstall': {'version': '1.0.39', 'result': 'failed', 'receipt': str(receipt)}})
        updates = fleet_health.check_updates(base)
        self.assertEqual(updates['level'], 'degraded')
        self.assertIn('did not install automatically', updates['summary'])
        self.assertIn('install of 1.0.39 rolled back: AssertionError', updates['summary'])
        write(receipt, {'result': 'update-failed', 'rollback': 'held-for-review', 'error': 'check failed'})
        write(base / 'updates' / 'state.json', {'status': 'installed', 'installedVersion': '1.0.39',
                                                'lastInstall': {'version': '1.0.39', 'result': 'failed',
                                                                'receipt': str(receipt)}})
        self.assertIn('held for review', fleet_health.check_updates(base)['summary'])

    def test_one_warning_more_than_twenty_times_in_ten_minutes_is_a_flood(self):
        base = make_home(self.root, closed_port())
        lines = [log_line(NOW - datetime.timedelta(seconds=10 * index), 'Scheduled task run failed')
                 for index in range(21)]
        lines.insert(0, log_line(NOW - datetime.timedelta(minutes=30), 'Scheduled task run failed'))
        write(base / 'stdout.log', ''.join(lines))
        os.utime(base / 'stdout.log', (NOW.timestamp(), NOW.timestamp()))
        flood = fleet_health.check_log_flood(base, NOW)
        self.assertEqual(flood['level'], 'degraded')
        self.assertEqual(flood['floods'][0]['count'], 21)
        write(base / 'stdout.log', ''.join(lines[:21]))
        os.utime(base / 'stdout.log', (NOW.timestamp(), NOW.timestamp()))
        self.assertEqual(fleet_health.check_log_flood(base, NOW)['level'], 'ok')

    def test_log_time_before_midnight_belongs_to_the_previous_day(self):
        now = datetime.datetime(2026, 10, 17, 0, 3).astimezone()
        self.assertEqual(fleet_health.log_time(now, 23, 58, 0, 0).day, 16)
        self.assertEqual(fleet_health.log_time(now, 0, 1, 0, 0).day, 17)

    def test_stale_stdout_does_not_replay_old_clock_times_as_a_current_flood(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        write(path, ''.join(log_line(NOW - datetime.timedelta(days=1, seconds=index),
                                    'Scheduled task run failed') for index in range(21)))
        modified = (NOW - datetime.timedelta(hours=2)).timestamp()
        os.utime(path, (modified, modified))
        flood = fleet_health.check_log_flood(base, NOW)
        self.assertEqual(flood['level'], 'ok', flood)
        self.assertIn('not modified', flood['summary'])
        self.assertEqual(flood['byLevel'], {})
        self.assertEqual(flood['floods'], [])
        self.assertEqual(flood['top'], [])

    def test_fresh_stdout_still_counts_a_flood_across_midnight(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        now = datetime.datetime(2026, 10, 17, 0, 3).astimezone()
        write(path, ''.join(log_line(now - datetime.timedelta(seconds=10 * index),
                                    'Scheduled task run failed') for index in range(21)))
        os.utime(path, (now.timestamp(), now.timestamp()))
        flood = fleet_health.check_log_flood(base, now)
        self.assertEqual(flood['level'], 'degraded', flood)
        self.assertEqual(flood['floods'][0]['count'], 21)

    def test_stdout_modified_at_window_start_is_included(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        cutoff = NOW - datetime.timedelta(minutes=10)
        write(path, log_line(cutoff, 'Scheduled task run failed') * 21)
        os.utime(path, (cutoff.timestamp(), cutoff.timestamp()))
        flood = fleet_health.check_log_flood(base, NOW)
        self.assertEqual(flood['level'], 'degraded', flood)
        self.assertEqual(flood['floods'][0]['count'], 21)

    def test_fresh_append_does_not_replay_prior_day_warnings(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        now = datetime.datetime(2026, 10, 18, 20, 40).astimezone()
        yesterday = now - datetime.timedelta(days=1)
        history = ''.join(log_line(yesterday - datetime.timedelta(seconds=index),
                                   'Scheduled task run failed') for index in range(21))
        # Only informational messages bridge midnight; they must still date warnings.
        history += log_line(yesterday.replace(hour=23, minute=59), 'Checkpoint', 'INFO')
        history += log_line(now.replace(hour=0, minute=1), 'Checkpoint', 'INFO')
        history += log_line(now - datetime.timedelta(minutes=4), 'Pull request sync skipped', 'INFO')
        write(path, history)
        os.utime(path, (now.timestamp(), now.timestamp()))
        flood = fleet_health.check_log_flood(base, now)
        self.assertEqual(flood['level'], 'ok', flood)
        self.assertEqual(flood['byLevel'].get('WARN', 0), 0, flood)

    def test_prior_days_do_not_hide_a_current_warning_flood(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        now = datetime.datetime(2026, 10, 18, 20, 40).astimezone()
        lines = []
        for days in (2, 1):
            day = now - datetime.timedelta(days=days)
            lines.append(log_line(day, 'Historical failure'))
            lines.append(log_line(day.replace(hour=23, minute=59), 'Checkpoint', 'DEBUG'))
            lines.append(log_line((day + datetime.timedelta(days=1)).replace(hour=0, minute=1),
                                  'Checkpoint', 'INFO'))
        lines.extend(log_line(now - datetime.timedelta(seconds=index), 'Current failure')
                     for index in range(21))
        write(path, ''.join(lines))
        os.utime(path, (now.timestamp(), now.timestamp()))
        flood = fleet_health.check_log_flood(base, now)
        self.assertEqual(flood['level'], 'degraded', flood)
        self.assertEqual(flood['floods'], [{'level': 'WARN', 'message': 'Current failure', 'count': 21}])
        self.assertEqual(flood['byLevel']['WARN'], 21)

    def test_historical_replay_does_not_move_future_rows_into_the_window(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        tomorrow = NOW + datetime.timedelta(days=1)
        write(path, ''.join(log_line(tomorrow - datetime.timedelta(seconds=index),
                                    'Future failure') for index in range(21)))
        os.utime(path, (tomorrow.timestamp(), tomorrow.timestamp()))
        flood = fleet_health.check_log_flood(base, NOW)
        self.assertEqual(flood['level'], 'ok', flood)
        self.assertEqual(flood['byLevel'].get('WARN', 0), 0)

    def test_small_out_of_order_midnight_write_does_not_hide_current_flood(self):
        base = make_home(self.root, closed_port())
        path = base / 'stdout.log'
        now = datetime.datetime(2026, 10, 18, 0, 3).astimezone()
        midnight = now.replace(minute=0)
        lines = [log_line(midnight + datetime.timedelta(seconds=index), 'Current failure')
                 for index in range(21)]
        lines.append(log_line(midnight - datetime.timedelta(seconds=2), 'Delayed write', 'INFO'))
        lines.append(log_line(now, 'Fresh write', 'INFO'))
        write(path, ''.join(lines))
        os.utime(path, (now.timestamp(), now.timestamp()))
        flood = fleet_health.check_log_flood(base, now)
        self.assertEqual(flood['level'], 'degraded', flood)
        self.assertEqual(flood['floods'][0]['count'], 21)

    def test_check_never_writes_inside_the_base_dir(self):
        with EnvironmentServer() as server:
            base = make_home(self.root, server.port, incident=True)
            before = snapshot(self.root)
            run_main(['--base-dir', str(base), '--now', iso(NOW), '--json'])
            run_main(['--base-dir', str(base), '--now', iso(NOW)])
        self.assertEqual(snapshot(self.root), before)

    def test_write_saves_the_json_report_where_asked(self):
        with EnvironmentServer() as server:
            base = make_home(self.root, server.port)
            target = pathlib.Path(self.root) / 'watch' / 'health' / 'latest.json'
            code, _ = run_main(['--base-dir', str(base), '--now', iso(NOW), '--write', str(target)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(target.read_text())['status'], 'ok')

    def test_plist_runs_the_check_every_five_minutes(self):
        code, out = run_main(['--base-dir', '/tmp/home-m4', '--print-plist'])
        self.assertEqual(code, 0)
        self.assertIn('<integer>300</integer>', out)
        self.assertIn('<key>StandardOutPath</key><string>/dev/null</string>', out, 'a summary every 5 min would grow forever')
        self.assertIn('<string>/tmp/home-m4/health/latest.json</string>', out)


if __name__ == '__main__':
    unittest.main()
