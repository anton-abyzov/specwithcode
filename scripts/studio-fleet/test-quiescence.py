#!/usr/bin/env python3
"""Synthetic process/argv fixtures only: never enumerate or stop live processes (one test reads
the executable of a child process it starts and stops itself)."""
import copy
import json
import os
import pathlib
import struct
import subprocess
import sys
import unittest
from unittest.mock import patch
import quiescence

NODE = '/verified/node22'
ARGS = ['/usr/bin/caffeinate', '-s', '/private/owned/m4/launch.sh']
START = 'Thu Oct 8 13:26:00 2026'


def process(pid, parent, executable, uid=501, started=START):
    return {'pid': pid, 'parent': parent, 'uid': uid, 'startedAt': started, 'executable': executable}


def fixture():
    return {1: process(1, 0, '/sbin/launchd', 0),
            100: process(100, 1, NODE), 101: process(101, 100, '/usr/bin/caffeinate'),
            200: process(200, 1, '/private/unrelated/node')}


class QuiescenceProof(unittest.TestCase):
    def test_optimized_python_refuses_both_helpers_before_operations(self):
        for helper in ('quiescence', 'update'):
            for args, environment in [(['-O'], {}), ([], {'PYTHONOPTIMIZE': '1'})]:
                with self.subTest(helper=helper, args=args):
                    result = subprocess.run([sys.executable, *args, '-c', 'import ' + helper],
                        cwd=pathlib.Path(__file__).parent, capture_output=True, text=True,
                        env={**os.environ, **environment}, timeout=5)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('Optimized Python is unsupported', result.stderr)

    def capture(self, first=None, second=None, argv=None):
        first = first if first is not None else fixture()
        second = second if second is not None else copy.deepcopy(first)
        values = iter([first, second])
        return quiescence.capture_quiescence(100, 501, NODE, ARGS,
            process_reader=lambda: next(values), argv_reader=lambda pid: ARGS if argv is None else argv)

    def test_only_exact_owned_leaf_supervisor_is_allowed_and_receipt_contains_no_paths_or_argv(self):
        proof = self.capture()
        self.assertEqual(proof['root']['pid'], 100)
        self.assertEqual(proof['supervisor']['pid'], 101)
        self.assertEqual(proof['descendantCount'], 1)
        text = json.dumps(proof)
        for secret in [NODE, *ARGS, '/sbin/launchd', '/private/unrelated/node']:
            self.assertNotIn(secret, text)
        self.assertEqual(len(proof['treeSha256']), 64)

    def test_every_additional_direct_or_nested_child_is_rejected_even_if_db_were_idle(self):
        for executable in ['/bin/sh', '/usr/bin/git', '/Applications/Chromium',
                           '/verified/node_repl', '/verified/codex', '/private/mcp-server']:
            for parent in [100, 101]:
                with self.subTest(executable=executable, parent=parent):
                    values = fixture(); values[102] = process(102, parent, executable)
                    with self.assertRaises(AssertionError): self.capture(values)

    def test_missing_duplicate_reparented_or_foreign_owner_supervisor_is_rejected(self):
        for change in ['missing', 'duplicate', 'reparented', 'owner', 'basename']:
            with self.subTest(change=change):
                values = fixture()
                if change == 'missing': del values[101]
                if change == 'duplicate': values[102] = process(102, 100, '/usr/bin/caffeinate')
                if change == 'reparented': values[101]['parent'] = 200
                if change == 'owner': values[101]['uid'] = 0
                if change == 'basename': values[101]['executable'] = '/private/caffeinate'
                with self.assertRaises(AssertionError): self.capture(values)

    def test_supervisor_arguments_require_exact_vector_without_extra_or_merged_arguments(self):
        for argv in [ARGS + ['extra'], [ARGS[0], '-w', '100'],
                     [ARGS[0], '-s', '/private/another/launch.sh'],
                     [ARGS[0], '-s ' + ARGS[2]]]:
            with self.subTest(argv=argv), self.assertRaises(AssertionError): self.capture(argv=argv)

    def test_root_owner_executable_missing_parent_and_cycles_are_rejected(self):
        for change in ['missing', 'owner', 'executable', 'parent', 'cycle']:
            with self.subTest(change=change):
                values = fixture()
                if change == 'missing': del values[100]
                if change == 'owner': values[100]['uid'] = 0
                if change == 'executable': values[100]['executable'] = '/foreign/node'
                if change == 'parent': values[100]['parent'] = 999
                if change == 'cycle': values[100]['parent'] = 101
                with self.assertRaises(AssertionError): self.capture(values)

    def test_identity_reuse_reparenting_and_parent_change_between_samples_fail_closed(self):
        for pid, key, value in [(100, 'startedAt', 'Thu Oct 8 13:26:01 2026'),
                                (101, 'startedAt', 'Thu Oct 8 13:26:01 2026'),
                                (100, 'parent', 200), (1, 'startedAt', 'Thu Oct 8 13:26:01 2026')]:
            with self.subTest(pid=pid, key=key):
                second = fixture(); second[pid][key] = value
                with self.assertRaises(AssertionError): self.capture(second=second)

    def test_new_child_between_samples_is_rejected(self):
        second = fixture(); second[102] = process(102, 100, '/bin/sh')
        with self.assertRaises(AssertionError): self.capture(second=second)

    def test_pre_restart_cas_rejects_same_pid_with_new_start_time_or_parent(self):
        expected = self.capture()
        for pid, key, value in [(100, 'startedAt', 'Thu Oct 8 14:00:00 2026'),
                                (100, 'parent', 200), (101, 'startedAt', 'Thu Oct 8 14:00:00 2026')]:
            changed = fixture(); changed[pid][key] = value
            with self.subTest(pid=pid, key=key), patch.object(quiescence, 'read_processes', return_value=changed), patch.object(quiescence, 'read_argv', return_value=ARGS):
                with self.assertRaisesRegex(AssertionError, 'prestate changed'):
                    quiescence.assert_quiescence(expected, NODE, ARGS)

    PS_LINE = '  100     1   501 Thu Oct  8 13:26:00 2026 /verified/node22\n'

    def test_process_inventory_retries_one_timeout_then_succeeds(self):
        calls = []
        def run(command, **kwargs):
            calls.append(kwargs['timeout'])
            if len(calls) == 1:
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            return subprocess.CompletedProcess(command, 0, stdout=self.PS_LINE, stderr='')
        with patch.object(quiescence.subprocess, 'run', side_effect=run):
            processes = quiescence.read_processes()
        self.assertEqual(calls, [30, 30])
        self.assertEqual(processes[100]['executable'], '/verified/node22')

    def test_process_inventory_raises_after_a_second_timeout(self):
        calls = []
        def run(command, **kwargs):
            calls.append(kwargs['timeout'])
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        with patch.object(quiescence.subprocess, 'run', side_effect=run):
            with self.assertRaises(subprocess.TimeoutExpired):
                quiescence.read_processes()
        self.assertEqual(calls, [30, 30])

    def test_process_inventory_does_not_retry_a_failed_ps(self):
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1, stdout='', stderr='private detail')
        with patch.object(quiescence.subprocess, 'run', side_effect=run):
            with self.assertRaisesRegex(AssertionError, 'Process inventory unavailable'):
                quiescence.read_processes()
        self.assertEqual(len(calls), 1)

    def test_ps_parser_normalizes_start_time_and_keeps_absolute_executable(self):
        value = quiescence.parse_processes(' 100 1 501 Thu Oct  8 13:26:00 2026 /verified/node22\n')
        self.assertEqual(value[100], process(100, 1, NODE))

    def test_nobody_is_valid_only_as_an_unrelated_inventory_owner(self):
        line = '200 1 -2 Thu Oct 8 13:26:00 2026 /private/unrelated/nobody\n'
        parsed = quiescence.parse_processes(line)
        self.assertEqual(parsed[200]['uid'], -2)
        values = fixture(); values.update(parsed)
        self.assertEqual(self.capture(values)['root']['uid'], 501)
        for pid in (100, 101):
            changed = fixture(); changed[pid]['uid'] = -2
            with self.subTest(pid=pid), self.assertRaises(AssertionError):
                self.capture(changed)
        for invalid in ('-1', '-3', '--2', '+501', 'nobody'):
            with self.subTest(owner=invalid), self.assertRaises(AssertionError):
                quiescence.parse_processes(line.replace(' -2 ', ' ' + invalid + ' '))

    def test_ps_parser_rejects_empty_duplicate_and_invalid_identity_or_time(self):
        line = '100 1 501 Thu Oct 8 13:26:00 2026 /verified/node22\n'
        for value in ['', line + line, line.replace('501', 'unknown'), line.replace('13:26:00', 'unknown'), '100 1 501']:
            with self.subTest(value=value), self.assertRaises(AssertionError): quiescence.parse_processes(value)

    def test_kernel_parser_preserves_empty_arguments_and_never_returns_environment(self):
        argv = ARGS + ['']
        data = struct.pack('=i', len(argv)) + b'/usr/bin/caffeinate\0\0\0' + b'\0'.join(item.encode() for item in argv) + b'\0PRIVATE_SECRET=never-return\0'
        self.assertEqual(quiescence.parse_procargs2(data), argv)
        self.assertNotIn('PRIVATE_SECRET', json.dumps(quiescence.parse_procargs2(data)))

    def test_kernel_parser_rejects_truncated_invalid_and_empty_vectors(self):
        for value in [b'', struct.pack('=i', 0) + b'x\0', struct.pack('=i', 3) + b'/usr/bin/caffeinate\0\0one\0', struct.pack('=i', 1) + b'/usr/bin/caffeinate\0\0\xff\0']:
            with self.subTest(value=value), self.assertRaises(AssertionError): quiescence.parse_procargs2(value)


HOME = '/private/owned/m4'
CHS = HOME + '/tools/chrome-headless-shell/mac-arm64/154.0.8037.92/chrome-headless-shell'
PROFILE = '--user-data-dir=' + HOME + '/userdata/server-browser/profiles/default'
BROWSER_ARGV = [CHS, '--disable-gpu', '--headless', '--remote-debugging-pipe', PROFILE, 'about:blank']


def with_browser(values=None):
    """The M4 shape that blocked 0.2.9: the service's own browser and its helpers."""
    values = values if values is not None else fixture()
    values[300] = process(300, 100, CHS)
    values[301] = process(301, 300, CHS)
    values[302] = process(302, 300, CHS)
    return values


class Table:
    """A process table that a fake signal can change; reads return copies."""
    def __init__(self, values, on_signal=None, on_sleep=None):
        self.values, self.on_signal, self.on_sleep, self.signals, self.now = values, on_signal, on_sleep, [], 0.0
        self.kernel = {}  # pid -> executable the kernel reports, when it differs from ps.

    def read(self):
        return copy.deepcopy(self.values)

    def executable(self, pid):
        assert pid in self.values, 'Process arguments unavailable'
        return self.kernel.get(pid, self.values[pid]['executable'])

    def signal(self, pid, number):
        self.signals.append((pid, number))
        if self.on_signal: self.on_signal(self, pid, number)

    def sleep(self, seconds):
        self.now += seconds
        if self.on_sleep: self.on_sleep(self)


def stop_tree_on(number):
    def handle(table, pid, received):
        if received == number:
            for child in [300, 301, 302]: table.values.pop(child, None)
    return handle


class ServerBrowserQuiescence(unittest.TestCase):
    def argv(self, browser_argv=None):
        return lambda pid: ARGS if pid == 101 else (BROWSER_ARGV if browser_argv is None else browser_argv)

    def capture(self, values, browser_argv=None, kernel=None):
        return quiescence.capture_quiescence(100, 501, NODE, ARGS, process_reader=lambda: copy.deepcopy(values),
                                             argv_reader=self.argv(browser_argv),
                                             executable_reader=lambda pid: (kernel or {}).get(pid, values[pid]['executable']))

    def test_own_server_browser_is_recognised_without_changing_the_core_proof(self):
        plain = self.capture(fixture())
        proof = self.capture(with_browser())
        self.assertEqual(quiescence.quiescence_core(proof), plain)
        self.assertEqual(proof['serverBrowser']['browserCount'], 1)
        self.assertEqual(proof['serverBrowser']['processCount'], 3)
        self.assertEqual([item['pid'] for item in proof['serverBrowser']['browsers']], [300])
        text = json.dumps(proof)
        for secret in [CHS, HOME, PROFILE, NODE]:
            self.assertNotIn(secret, text)

    def test_shared_browser_on_a_playwright_temp_profile_is_recognised(self):
        for profile in ['/tmp/playwright_chromiumdev_profile-AbC123',
                        '/private/var/folders/x1/abc_def/T/playwright_chromiumdev_profile-Z9']:
            with self.subTest(profile=profile):
                argv = [CHS, '--headless', '--remote-debugging-pipe', '--user-data-dir=' + profile]
                self.assertEqual(self.capture(with_browser(), argv)['serverBrowser']['browserCount'], 1)

    def test_lookalike_or_unrelated_browsers_are_never_safe(self):
        cases = {
            'other identity tools': lambda v: v[300].update(executable=CHS.replace('/m4/', '/m1/')),
            'user chrome': lambda v: v[300].update(executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
            'same name elsewhere': lambda v: v[300].update(executable='/tmp/tools/chrome-headless-shell/mac-arm64/1/chrome-headless-shell'),
            'path traversal': lambda v: v[300].update(executable=HOME + '/tools/chrome-headless-shell/mac-arm64/../../../evil/chrome-headless-shell'),
            'helper runs something else': lambda v: v[301].update(executable='/bin/sh'),
            'helper under the supervisor': lambda v: v[301].update(parent=101),
            'browser under the supervisor': lambda v: [v[item].update(parent=101) for item in [300]],
            'foreign owner': lambda v: v[300].update(uid=502),
            'foreign helper owner': lambda v: v[302].update(uid=0),
            'shell next to the browser': lambda v: v.update({303: process(303, 100, '/bin/sh')}),
            'too many browsers': lambda v: v.update({400 + n: process(400 + n, 100, CHS) for n in range(9)}),
        }
        for name, change in cases.items():
            with self.subTest(name):
                values = with_browser(); change(values)
                with self.assertRaises(AssertionError): self.capture(values)

    def test_browser_not_launched_by_the_service_profile_is_rejected(self):
        for argv in [[CHS, '--remote-debugging-pipe', PROFILE],
                     [CHS, '--headless', PROFILE],
                     [CHS, '--headless', '--remote-debugging-pipe'],
                     [CHS, '--headless', '--remote-debugging-pipe', PROFILE, PROFILE],
                     [CHS, '--headless', '--remote-debugging-pipe', '--user-data-dir=/Users/me/Library/Application Support/Google/Chrome'],
                     [CHS, '--headless', '--remote-debugging-pipe', '--user-data-dir=' + HOME + '/userdata/server-browser/profiles/..'],
                     [CHS, '--headless', '--remote-debugging-pipe', '--user-data-dir=' + HOME + '/userdata/server-browser/profiles/a/b'],
                     [CHS, '--headless', '--remote-debugging-pipe', '--user-data-dir=/tmp/playwright_chromiumdev_profile-x/../y']]:
            with self.subTest(argv=argv), self.assertRaises(AssertionError):
                self.capture(with_browser(), argv)

    def test_browser_change_between_samples_fails_closed(self):
        values = iter([with_browser(), fixture()])
        with self.assertRaises(AssertionError):
            quiescence.capture_quiescence(100, 501, NODE, ARGS, process_reader=lambda: next(values),
                                          argv_reader=self.argv(), executable_reader=lambda pid: CHS)

    def test_a_process_that_exits_before_its_kernel_read_is_inventory_churn(self):
        for reader in ('argv', 'executable'):
            with self.subTest(reader=reader):
                tables = iter([with_browser(), fixture()])
                def vanished(pid):
                    assert pid == 101, 'Supervisor arguments unavailable' if reader == 'argv' else 'Process executable unavailable'
                    return ARGS
                argv = vanished if reader == 'argv' else self.argv()
                executable = vanished if reader == 'executable' else (lambda pid: CHS)
                with self.assertRaisesRegex(AssertionError, '^Owned process identities changed during inventory$'):
                    quiescence.capture_quiescence(100, 501, NODE, ARGS, process_reader=lambda: next(tables),
                                                  argv_reader=argv, executable_reader=executable)

    def test_a_kernel_read_failure_on_an_unchanged_tree_keeps_its_own_message(self):
        # Still listed (exiting or awaiting reaping): the read's own message, which update.py
        # retries for VANISHED_READS only; a malformed vector stays a fault.
        for message, vanished in (('Process executable unavailable', True), ('Invalid supervisor argument count', False)):
            with self.subTest(message=message):
                def executable(pid):
                    assert pid != 301, message
                    return with_browser()[pid]['executable']
                with self.assertRaisesRegex(AssertionError, '^' + message + '$'):
                    quiescence.capture_quiescence(100, 501, NODE, ARGS, process_reader=with_browser,
                                                  argv_reader=self.argv(), executable_reader=executable)
                self.assertEqual(message in quiescence.VANISHED_READS, vanished)

    def guard(self, table, expected=None, report=None):
        expected = expected if expected is not None else self.capture(with_browser())
        return quiescence.assert_quiescence(expected, NODE, ARGS, process_reader=table.read, argv_reader=self.argv(),
                                            signaler=table.signal, clock=lambda: table.now, sleeper=table.sleep,
                                            executable_reader=table.executable, report=report)

    def test_a_process_only_named_like_the_browser_is_never_safe(self):
        # A shell beneath the service can set its own argv[0] (exec -a); the kernel path cannot lie.
        for pid in (300, 301):
            with self.subTest(pid=pid), self.assertRaisesRegex(AssertionError, 'unexpected'):
                self.capture(with_browser(), kernel={pid: '/bin/sleep'})
        table = Table(with_browser(), stop_tree_on(quiescence.signal.SIGTERM))
        table.kernel[300] = '/bin/sleep'
        with self.assertRaises(AssertionError):
            self.guard(table)
        self.assertEqual(table.signals, [])

    def test_a_process_that_turns_into_something_else_before_the_signal_is_not_signalled(self):
        table = Table(with_browser(), stop_tree_on(quiescence.signal.SIGTERM))
        reads = []
        def read():
            reads.append(1)
            if len(reads) == 3: table.kernel[300] = '/bin/sleep'  # After the capture, before the signal.
            return copy.deepcopy(table.values)
        table.read = read
        with self.assertRaisesRegex(AssertionError, 'identity changed'):
            self.guard(table)
        self.assertEqual(table.signals, [])

    def test_exited_helpers_awaiting_reaping_do_not_abort_the_stop(self):
        def handle(table, pid, number):
            # The helpers are gone; the browser has exited but the service has not reaped it yet.
            for helper in (301, 302): table.values.pop(helper, None)
            table.values[300]['executable'] = '<defunct>'
        def reap(table):
            table.values.pop(300, None)
        table = Table(with_browser(), handle, reap)
        record = self.guard(table)
        self.assertEqual(record['signal'], 'SIGTERM')
        self.assertEqual(table.signals, [(300, quiescence.signal.SIGTERM)])
        self.assertEqual(table.values, fixture())

    def test_a_helper_the_browser_starts_while_shutting_down_is_tracked_and_waited_for(self):
        def handle(table, pid, number):
            table.values[303] = process(303, 300, CHS)
        def finish(table):
            for child in (300, 301, 302, 303): table.values.pop(child, None)
        table = Table(with_browser(), handle, finish)
        record = self.guard(table)
        self.assertEqual((record['signal'], record['lateHelperCount']), ('SIGTERM', 1))
        self.assertEqual(table.values, fixture())

    def test_a_late_helper_that_never_exits_is_killed_with_the_rest(self):
        def handle(table, pid, number):
            if number == quiescence.signal.SIGTERM:
                table.values[303] = process(303, 300, CHS)
            else:
                table.values.pop(pid, None)
        table = Table(with_browser(), handle)
        self.assertEqual(self.guard(table)['signal'], 'SIGKILL')
        self.assertEqual(sorted(table.signals[1:]), [(pid, quiescence.signal.SIGKILL) for pid in (300, 301, 302, 303)])

    def test_late_processes_that_are_not_the_owned_browser_still_refuse(self):
        cases = {
            'other program under the browser': process(303, 300, '/bin/sh'),
            'named like the browser only': process(303, 300, CHS),
            'browser binary straight under the service': process(303, 100, CHS),
        }
        for name, late in cases.items():
            with self.subTest(name):
                def handle(table, pid, number, late=late):
                    table.values[late['pid']] = dict(late)
                    if name == 'named like the browser only': table.kernel[303] = '/bin/sleep'
                    if name == 'browser binary straight under the service': table.values.pop(300, None)
                table = Table(with_browser(), handle)
                with self.assertRaisesRegex(AssertionError, 'new process'):
                    self.guard(table)

    def test_a_browser_that_exits_just_before_its_signal_is_not_an_error(self):
        def handle(table, pid, number):
            stop_tree_on(number)(table, pid, number)
            raise ProcessLookupError(pid)
        table = Table(with_browser(), handle)
        record = self.guard(table)
        self.assertEqual(record['serverBrowser'], 'stopped')
        self.assertEqual(record['signals'], [])

    def test_a_browser_that_exits_while_its_executable_is_checked_is_skipped(self):
        table = Table(with_browser())
        checks = []
        def executable(pid):
            checks.append(pid)
            if len(checks) > 3:  # Past the capture: it exits during the check.
                for child in (300, 301, 302): table.values.pop(child, None)
            return Table.executable(table, pid)
        table.executable = executable
        self.assertEqual(self.guard(table)['signals'], [])
        self.assertEqual(table.signals, [])

    def test_a_late_helper_that_exits_while_it_is_checked_does_not_abort_the_stop(self):
        def handle(table, pid, number):
            table.values[303] = process(303, 300, CHS)
        def finish(table):
            for child in (300, 301, 302): table.values.pop(child, None)
        table = Table(with_browser(), handle, finish)
        def executable(pid):
            if pid == 303:  # Gone (and reaped) by the time its executable is read.
                table.values.pop(303, None)
            return Table.executable(table, pid)
        table.executable = executable
        record = self.guard(table)
        self.assertEqual((record['signal'], record['lateHelperCount']), ('SIGTERM', 0))
        self.assertEqual(table.values, fixture())

    def test_an_unreadable_late_helper_is_never_signalled_and_blocks_until_gone(self):
        def handle(table, pid, number):
            if number == quiescence.signal.SIGTERM:
                table.values[303] = process(303, 300, CHS)
            else:
                table.values.pop(pid, None)
        table = Table(with_browser(), handle)
        def executable(pid):
            assert pid != 303, 'Process executable unavailable'
            return Table.executable(table, pid)
        table.executable = executable
        with self.assertRaisesRegex(AssertionError, 'did not stop'):
            self.guard(table)
        self.assertNotIn(303, [pid for pid, _ in table.signals])

    def test_an_exiting_helper_still_listed_does_not_abort_the_stop(self):
        def handle(table, pid, number):
            table.values[303] = process(303, 300, CHS)
        exiting = []
        def finish(table):
            exiting.append(1)
            if len(exiting) > 2:
                for child in (300, 301, 302, 303): table.values.pop(child, None)
        table = Table(with_browser(), handle, finish)
        def executable(pid):
            assert pid != 303, 'Process executable unavailable'  # Exiting: listed, executable released.
            return Table.executable(table, pid)
        table.executable = executable
        self.assertEqual(self.guard(table)['signal'], 'SIGTERM')
        self.assertEqual(table.values, fixture())

    def test_the_kernel_executable_reader_reports_this_process(self):
        if sys.platform != 'darwin': self.skipTest('macOS libproc')
        # A child this test starts and stops itself; argv[0] is set to look like the browser.
        child = subprocess.Popen([CHS, '30'], executable='/bin/sleep')
        try:
            self.assertEqual(quiescence.read_executable(child.pid), '/bin/sleep')
        finally:
            child.kill(); child.wait()
        with self.assertRaisesRegex(AssertionError, 'executable unavailable'):
            quiescence.read_executable(2 ** 31 - 1)

    def test_a_failed_stop_still_reports_each_signal_sent(self):
        report = {}
        with self.assertRaisesRegex(AssertionError, 'did not stop'):
            self.guard(Table(with_browser()), report=report)
        self.assertEqual(report['serverBrowser'], 'stopping')
        self.assertEqual([(item['pid'], item['signal']) for item in report['signals']],
                         [(300, 'SIGTERM'), (300, 'SIGKILL'), (301, 'SIGKILL'), (302, 'SIGKILL')])
        self.assertTrue(all(item['startedAt'] == START for item in report['signals']))
        self.assertNotIn(CHS, json.dumps(report))

    def test_before_restart_the_browser_is_stopped_gracefully_and_reported(self):
        table = Table(with_browser(), stop_tree_on(quiescence.signal.SIGTERM))
        record = self.guard(table)
        self.assertEqual(table.signals, [(300, quiescence.signal.SIGTERM)])
        self.assertEqual(record['serverBrowser'], 'stopped')
        self.assertEqual(record['signal'], 'SIGTERM')
        self.assertEqual((record['browserCount'], record['processCount']), (1, 3))
        self.assertEqual([item['pid'] for item in record['browsers']], [300])
        self.assertNotIn(CHS, json.dumps(record))
        self.assertEqual(table.values, fixture())

    def test_prestate_with_browser_matches_a_later_tree_without_one(self):
        # The browser exited on its own after the snapshot: nothing to stop.
        table = Table(fixture())
        self.assertEqual(self.guard(table), {'serverBrowser': 'not-running'})
        self.assertEqual(table.signals, [])

    def test_a_browser_that_ignores_sigterm_gets_sigkill_on_the_same_verified_processes(self):
        def handle(table, pid, number):
            if number == quiescence.signal.SIGKILL: table.values.pop(pid, None)
        table = Table(with_browser(), handle)
        record = self.guard(table)
        self.assertEqual(record['signal'], 'SIGKILL')
        self.assertEqual(table.signals[0], (300, quiescence.signal.SIGTERM))
        self.assertEqual(sorted(table.signals[1:]), [(pid, quiescence.signal.SIGKILL) for pid in (300, 301, 302)])
        self.assertGreaterEqual(table.now, quiescence.SERVER_BROWSER_STOP_SECONDS)

    def test_a_browser_that_survives_sigkill_refuses_the_restart(self):
        table = Table(with_browser())
        with self.assertRaisesRegex(AssertionError, 'did not stop'):
            self.guard(table)
        self.assertLessEqual(table.now, quiescence.SERVER_BROWSER_STOP_SECONDS + quiescence.SERVER_BROWSER_KILL_SECONDS + 1)

    def test_helpers_orphaned_by_the_exiting_browser_are_still_waited_for_and_stopped(self):
        def handle(table, pid, number):
            if number == quiescence.signal.SIGTERM:
                table.values.pop(300, None)
                for helper in (301, 302): table.values[helper]['parent'] = 1  # Adopted by launchd.
            else:
                table.values.pop(pid, None)
        table = Table(with_browser(), handle)
        record = self.guard(table)
        self.assertEqual(record['signal'], 'SIGKILL')
        self.assertEqual(sorted(table.signals[1:]), [(301, quiescence.signal.SIGKILL), (302, quiescence.signal.SIGKILL)])
        self.assertEqual(table.values, fixture())

    def test_a_reused_helper_pid_outside_the_service_is_never_signalled(self):
        def handle(table, pid, number):
            table.values.pop(300, None); table.values.pop(302, None)
            # pid 301 now belongs to an unrelated process of another program.
            table.values[301] = process(301, 200, '/private/unrelated/tool', started='Thu Oct 8 14:00:00 2026')
        table = Table(with_browser(), handle)
        self.assertEqual(self.guard(table)['signal'], 'SIGTERM')
        self.assertEqual(table.signals, [(300, quiescence.signal.SIGTERM)])

    def test_headless_mode_variants_are_accepted(self):
        argv = [CHS, '--headless=new', '--remote-debugging-pipe', PROFILE]
        self.assertEqual(self.capture(with_browser(), argv)['serverBrowser']['browserCount'], 1)

    def test_core_change_refuses_before_any_signal(self):
        values = with_browser(); values[101]['startedAt'] = 'Thu Oct 8 14:00:00 2026'
        table = Table(values, stop_tree_on(quiescence.signal.SIGTERM))
        with self.assertRaisesRegex(AssertionError, 'prestate changed'):
            self.guard(table)
        self.assertEqual(table.signals, [])

    def test_reused_pid_is_never_signalled(self):
        reads = []
        def read():
            reads.append(1)
            values = with_browser()
            if len(reads) > 2:  # After the capture, pid 300 is a different process.
                values[300]['startedAt'] = 'Thu Oct 8 14:00:00 2026'
            return values
        table = Table(None)
        table.read = read
        table.executable = lambda pid: CHS
        with self.assertRaises(AssertionError):
            self.guard(table)
        self.assertEqual(table.signals, [])

    def test_a_new_process_while_stopping_refuses_the_restart(self):
        def handle(table, pid, number):
            for child in [300, 301, 302]: table.values.pop(child, None)
            table.values[303] = process(303, 100, '/bin/sh')
        with self.assertRaisesRegex(AssertionError, 'unexpected|new process'):
            self.guard(Table(with_browser(), handle))


TUNNEL = HOME + '/tools/cloudflared/2026.5.2/darwin-arm64/cloudflared'
TUNNEL_ARGV = [TUNNEL, 'tunnel', '--no-autoupdate', '--loglevel', 'info', '--output', 'default', 'run']


def with_tunnel(values=None, pid=400, started=START):
    """M1 and M3 on October 26, 2026: the service's own SpecWithCode Connect tunnel, a direct
    child of the service, kept 1.0.92 "waiting-for-quiet ... (cloudflared)" for 30+ minutes."""
    values = values if values is not None else fixture()
    values[pid] = process(pid, 100, TUNNEL, started=started)
    return values


class ManagedTunnelQuiescence(unittest.TestCase):
    def argv(self, tunnel_argv=None):
        def read(pid):
            if pid == 101:
                return ARGS
            if pid in (300, 301, 302):
                return BROWSER_ARGV
            return TUNNEL_ARGV if tunnel_argv is None else tunnel_argv
        return read

    def capture(self, values, tunnel_argv=None, kernel=None):
        return quiescence.capture_quiescence(100, 501, NODE, ARGS, process_reader=lambda: copy.deepcopy(values),
                                             argv_reader=self.argv(tunnel_argv),
                                             executable_reader=lambda pid: (kernel or {}).get(pid, values[pid]['executable']))

    def guard(self, table, expected):
        return quiescence.assert_quiescence(expected, NODE, ARGS, process_reader=table.read, argv_reader=self.argv(),
                                            signaler=table.signal, clock=lambda: table.now, sleeper=table.sleep,
                                            executable_reader=table.executable)

    def test_the_service_s_own_tunnel_is_quiet_and_leaves_the_proof_unchanged(self):
        plain = self.capture(fixture())
        proof = self.capture(with_tunnel())
        self.assertEqual(proof, plain)
        self.assertNotIn(TUNNEL, json.dumps(proof))
        self.assertNotIn('cloudflared', json.dumps(proof))

    def test_the_tunnel_beside_the_server_browser_is_never_signalled(self):
        expected = self.capture(with_tunnel(with_browser()))
        table = Table(with_tunnel(with_browser()), stop_tree_on(quiescence.signal.SIGTERM))
        record = self.guard(table, expected)
        self.assertEqual(table.signals, [(300, quiescence.signal.SIGTERM)])
        self.assertEqual(record['serverBrowser'], 'stopped')
        self.assertEqual(table.values, with_tunnel())

    def test_a_tunnel_that_restarted_or_stopped_after_the_snapshot_does_not_refuse_the_restart(self):
        expected = self.capture(with_tunnel())
        for later in (with_tunnel(pid=401, started='Thu Oct 8 14:00:00 2026'), fixture()):
            table = Table(later)
            with self.subTest(tunnel=sorted(later)):
                self.assertEqual(self.guard(table, expected), {'serverBrowser': 'not-running'})
                self.assertEqual(table.signals, [])

    def test_any_other_cloudflared_still_keeps_the_update_waiting(self):
        cases = {
            'another identity\'s tools': (lambda v: v[400].update(executable=TUNNEL.replace('/m4/', '/m1/')), None, None),
            'cloudflared on PATH': (lambda v: v[400].update(executable='/opt/homebrew/bin/cloudflared'), None, None),
            'same name elsewhere': (lambda v: v[400].update(executable='/tmp/tools/cloudflared/2026.5.2/darwin-arm64/cloudflared'),
                                    None, None),
            'path traversal': (lambda v: v[400].update(executable=HOME + '/tools/cloudflared/2026.5.2/darwin-arm64/../../../../evil/cloudflared'),
                               None, None),
            'started in a terminal': (lambda v: (v.update({110: process(110, 100, '/bin/zsh')}), v[400].update(parent=110)),
                                      None, None),
            'a quick tunnel': (None, [TUNNEL, 'tunnel', '--url', 'http://localhost:3000'], None),
            'extra arguments': (None, TUNNEL_ARGV + ['--metrics', '0.0.0.0:2000'], None),
            'another program named cloudflared in argv': (None, ['/bin/sh'] + TUNNEL_ARGV[1:], None),
            'a process beneath it': (lambda v: v.update({401: process(401, 400, '/bin/sh')}), None, None),
            'another owner': (lambda v: v[400].update(uid=502), None, None),
            'kernel runs something else': (None, None, {400: '/bin/sleep'}),
            'two tunnels': (lambda v: v.update({401: process(401, 100, TUNNEL)}), None, None),
        }
        for name, (change, argv, kernel) in cases.items():
            with self.subTest(case=name):
                values = with_tunnel()
                if change:
                    change(values)
                with self.assertRaisesRegex(AssertionError, 'unexpected'):
                    self.capture(values, argv, kernel)

    def test_a_reap_spares_the_tunnel_and_stops_the_stray_process(self):
        values = with_tunnel()
        values[110] = process(110, 100, '/bin/zsh')

        def exit_on(table, pid, number):
            table.values.pop(pid, None)
        table = Table(values, exit_on)
        record = quiescence.reap_descendants(100, 501, NODE, ARGS, process_reader=table.read, argv_reader=self.argv(),
                                             executable_reader=table.executable, signaler=table.signal,
                                             clock=lambda: table.now, sleeper=table.sleep)
        self.assertEqual(table.signals, [(110, quiescence.signal.SIGTERM)])
        self.assertEqual(record['processCount'], 1)
        self.assertEqual(table.values, with_tunnel())

if __name__ == '__main__':
    unittest.main()
