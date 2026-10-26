#!/usr/bin/env python3
"""Update now's fallback for a held service that never quiets: a hung provider or a stray
process beneath it. Covers quiescence.reap_descendants (synthetic process tables, plus one
test on real processes this test starts and stops itself), `update.py --reap`, and the
agent side (update_agent_reap.py), including the installed agent importing its sibling.

Run: cd scripts/studio-fleet && python3 -B test-reap.py
"""
import contextlib
import copy
import datetime
import importlib.util
import io
import json
import os
import pathlib
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import quiescence  # noqa: E402
import update_agent  # noqa: E402
import update_agent_reap  # noqa: E402


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(HERE / path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


update = load('owned_update_for_reap', 'update.py')
agent_tests = load('agent_tests_for_reap', 'test-update-agent.py')

NODE = '/verified/node22'
HOME = '/private/owned/m4'
ARGS = ['/usr/bin/caffeinate', '-s', HOME + '/launch.sh']
BROWSER = HOME + '/tools/chrome-headless-shell/mac-arm64/131.0.6778/chrome-headless-shell'
START, LATER = 'Thu Oct 8 13:26:00 2026', 'Thu Oct 8 14:00:00 2026'


def process(pid, parent, executable, uid=501, started=START):
    return {'pid': pid, 'parent': parent, 'uid': uid, 'startedAt': started, 'executable': executable}


def tree():
    """The service (100) with its supervisor, a hung provider (110), a terminal shell (111)
    with a leftover dev server (112), its server browser (120) and a root-owned helper (130);
    plus processes outside it: an unrelated node (200, same owner and executable as 112) and
    a provider started by the person in their own terminal (201)."""
    return {1: process(1, 0, '/sbin/launchd', 0),
            100: process(100, 1, NODE), 101: process(101, 100, '/usr/bin/caffeinate'),
            110: process(110, 100, '/verified/codex'), 111: process(111, 100, '/bin/zsh'),
            112: process(112, 111, '/usr/local/bin/node'), 120: process(120, 100, BROWSER),
            130: process(130, 100, '/usr/libexec/helper', uid=0),
            200: process(200, 1, '/usr/local/bin/node'), 201: process(201, 1, '/verified/codex', started=LATER)}


class FakeHost(object):
    """A process table that signals change: a pid in `hung` ignores SIGTERM; children of an
    exiting process are adopted by launchd, as on macOS."""

    def __init__(self, table, hung=()):
        self.table, self.hung, self.signals, self.now = table, set(hung), [], 0.0
        self.kernel = {}  # pid -> executable the kernel reports, when it differs from ps.
        self.before_signal = None
        self.inventories = self.single_reads = 0
        self.single_cost = 0.0  # Seconds each single-process read takes, for the budget.

    def processes(self):
        self.inventories += 1
        return copy.deepcopy(self.table)

    def single(self, pid):
        self.single_reads += 1
        self.now += self.single_cost
        return copy.deepcopy(self.table.get(pid))

    def executable(self, pid):
        if pid not in self.table:
            raise AssertionError('Process executable unavailable')
        return self.kernel.get(pid, self.table[pid]['executable'])

    def kill(self, pid, number):
        if self.before_signal:
            self.before_signal(pid, number)
        if pid not in self.table:
            raise ProcessLookupError(pid)
        self.signals.append((pid, signal.Signals(number).name))
        if number == signal.SIGKILL or pid not in self.hung:
            del self.table[pid]
            for item in self.table.values():
                if item['parent'] == pid:
                    item['parent'] = 1

    def sleep(self, seconds):
        self.now += seconds

    def reap(self, executable=NODE, argv=ARGS, argvs=None, **extra):
        argvs = argvs or {}
        return quiescence.reap_descendants(100, 501, executable, ARGS, process_reader=self.processes,
                                           argv_reader=lambda pid: argvs.get(pid, argv),
                                           executable_reader=self.executable, signaler=self.kill,
                                           clock=lambda: self.now, sleeper=self.sleep, **extra)

    def signalled(self):
        return sorted({pid for pid, _ in self.signals})


class ReapDescendants(unittest.TestCase):
    def test_a_hung_provider_is_killed_after_sigterm_and_a_stray_process_stops_on_sigterm(self):
        host = FakeHost(tree(), hung={110})
        record = host.reap()
        self.assertEqual(host.signals, [(110, 'SIGTERM'), (111, 'SIGTERM'), (112, 'SIGTERM'), (110, 'SIGKILL')])
        self.assertEqual(record['survivors'], [])
        self.assertEqual((record['processCount'], record['sparedBrowserCount'], record['unverifiedCount']), (3, 1, 1))
        self.assertEqual([item['name'] for item in record['processes']], ['codex', 'zsh', 'node'])
        self.assertGreaterEqual(host.now, quiescence.REAP_TERM_SECONDS)
        for pid in (1, 100, 101, 120, 130, 200, 201):
            self.assertIn(pid, host.table)
        text = json.dumps(record)
        for path in (NODE, HOME, '/verified/codex', '/usr/local/bin/node', BROWSER):
            self.assertNotIn(path, text)

    def test_a_stray_process_its_parent_left_to_launchd_is_still_stopped(self):
        host = FakeHost(tree(), hung={112})
        record = host.reap()
        # 111 exits on SIGTERM; 112, now beneath launchd, ignores it and gets SIGKILL.
        self.assertEqual(host.signals, [(110, 'SIGTERM'), (111, 'SIGTERM'), (112, 'SIGTERM'), (112, 'SIGKILL')])
        self.assertEqual(record['survivors'], [])
        self.assertIn(200, host.table)

    def test_nothing_is_signalled_when_the_service_has_only_its_supervisor_and_browser(self):
        table = tree()
        for pid in (110, 111, 112, 130):
            del table[pid]
        host = FakeHost(table)
        record = host.reap()
        self.assertEqual((host.signals, record['processCount'], host.now), ([], 0, 0.0))

    def test_a_process_that_changed_after_it_was_recorded_is_never_signalled(self):
        cases = {
            # The pid was reused by another process (another start time).
            'reused': lambda host: host.table.__setitem__(112, process(112, 1, '/usr/local/bin/node', started=LATER)),
            # Same pid and start time, but the kernel now resolves another executable.
            'executable': lambda host: host.kernel.__setitem__(112, '/usr/local/bin/other'),
            # Moved beneath an unrelated process: not provably the recorded one.
            'reparented': lambda host: host.table[112].__setitem__('parent', 200),
            # Exiting: the kernel released its executable.
            'exiting': lambda host: host.kernel.__setitem__(112, None),
        }
        for name, change in cases.items():
            with self.subTest(change=name):
                host = FakeHost(tree(), hung={110, 112})
                real = host.executable

                def executable(pid, host=host, real=real):
                    value = real(pid)
                    if value is None:
                        raise AssertionError('Process executable unavailable')
                    return value
                host.executable = executable
                applied = []

                def before_signal(pid, number, host=host, change=change):
                    if not applied:
                        applied.append(pid)
                        change(host)
                host.before_signal = before_signal
                record = host.reap()
                self.assertNotIn(112, host.signalled())
                self.assertIn(112, host.table)
                self.assertEqual(record['survivors'], [{'pid': 112, 'startedAt': host.table[112]['startedAt']}]
                                 if name in ('executable', 'reparented', 'exiting') else [])

    def test_an_unreadable_executable_at_capture_is_never_signalled(self):
        host = FakeHost(tree())
        real = host.executable

        def executable(pid):
            if pid == 111:
                raise AssertionError('Process executable unavailable')
            return real(pid)
        host.executable = executable
        record = host.reap()
        self.assertNotIn(111, host.signalled())
        self.assertEqual(record['unverifiedCount'], 2)

    def test_an_unverified_service_is_refused_before_any_signal(self):
        refusals = {
            'executable': dict(executable='/private/other/node'),
            'supervisor arguments': dict(argv=ARGS + ['extra']),
        }
        for name, values in refusals.items():
            with self.subTest(refusal=name):
                host = FakeHost(tree())
                with self.assertRaises(AssertionError):
                    host.reap(**values)
                self.assertEqual(host.signals, [])
        for name, change in {'no supervisor': lambda table: table.pop(101),
                             'another owner': lambda table: table[100].__setitem__('uid', 502)}.items():
            with self.subTest(refusal=name):
                table = tree()
                change(table)
                host = FakeHost(table)
                with self.assertRaises(AssertionError):
                    host.reap()
                self.assertEqual(host.signals, [])

    def test_a_restarted_service_stops_the_reap(self):
        host = FakeHost(tree(), hung={110})

        def restart(pid, number):
            if number == signal.SIGTERM and pid == 112:
                host.table[100] = process(100, 1, NODE, started=LATER)
        host.before_signal = restart
        with self.assertRaises(AssertionError):
            host.reap()
        self.assertNotIn('SIGKILL', [name for _, name in host.signals])


    def test_a_caffeinate_started_by_work_beneath_the_service_is_stopped_and_the_supervisor_is_not(self):
        table = tree()
        table[113] = process(113, 111, '/usr/bin/caffeinate')  # `caffeinate -i npm test` in a terminal.
        table[114] = process(114, 100, '/usr/bin/caffeinate')  # Another one the service started for work.
        host = FakeHost(table)
        record = host.reap(argvs={113: ['/usr/bin/caffeinate', '-i', 'npm', 'test'],
                                  114: ['/usr/bin/caffeinate', '-i', '/bin/zsh']})
        self.assertEqual(host.signalled(), [110, 111, 112, 113, 114])
        self.assertIn(101, host.table)
        self.assertEqual(record['survivors'], [])
        # A snapshot still refuses such a tree: the extra caffeinate is work.
        with self.assertRaisesRegex(AssertionError, 'descendants'):
            quiescence._owned_tree(table, 100, 501, NODE, HOME)

    def test_without_one_supervisor_with_the_launch_agent_arguments_nothing_is_signalled(self):
        table = tree()
        table[114] = process(114, 100, '/usr/bin/caffeinate')
        for name, argvs in {'two match': {}, 'none match': {101: ['/usr/bin/caffeinate', '-i'],
                                                            114: ['/usr/bin/caffeinate', '-i']}}.items():
            with self.subTest(case=name):
                host = FakeHost(copy.deepcopy(table))
                with self.assertRaisesRegex(AssertionError, 'unexpected or missing descendants'):
                    host.reap(argvs=argvs)
                self.assertEqual(host.signals, [])

    def test_one_inventory_per_round_and_one_small_read_per_signal(self):
        table = tree()
        for pid in range(300, 340):  # 40 providers that ignore SIGTERM.
            table[pid] = process(pid, 100, '/verified/codex')
        host = FakeHost(table, hung=set(range(300, 340)) | {110})
        record = host.reap(single_reader=host.single)
        self.assertEqual(record['survivors'], [])
        self.assertEqual(len(host.signals), 2 * 43 - 2)  # SIGTERM for all 43, SIGKILL for the 41 hung.
        self.assertEqual(host.single_reads, len(host.signals))
        # Discovery, one per round, and the waits (every 0.25 s for REAP_TERM_SECONDS).
        self.assertLessEqual(host.inventories, 2 + 2 + quiescence.REAP_TERM_SECONDS * 4 + 2)

    def test_a_slow_machine_still_ends_within_the_budget_and_sends_sigkill(self):
        table = tree()
        for pid in range(300, 340):
            table[pid] = process(pid, 100, '/verified/codex')
        host = FakeHost(table, hung=set(range(300, 340)) | {110})
        host.single_cost = 2.0  # Each ps -p takes two seconds.
        record = host.reap(single_reader=host.single)
        self.assertTrue(record['budgetExceeded'])
        self.assertLessEqual(host.now, quiescence.REAP_BUDGET_SECONDS + 2.0)
        self.assertIn('SIGKILL', [name for _, name in host.signals])
        self.assertTrue(record['survivors'])  # Those it had no time for are reported, not hidden.

    def test_the_guard_stops_the_reap_before_the_next_signal(self):
        host = FakeHost(tree(), hung={110})
        report, calls = {}, []

        def guard():
            calls.append(len(host.signals))
            if len(host.signals) == 1:
                raise AssertionError('The service is not held for this update request')
        with self.assertRaisesRegex(AssertionError, 'not held'):
            host.reap(report=report, guard=guard)
        self.assertEqual(host.signals, [(110, 'SIGTERM')])
        # The record built so far survives the failure.
        self.assertEqual(report['signals'], [{'pid': 110, 'startedAt': START, 'signal': 'SIGTERM'}])
        self.assertEqual(report['processCount'], 3)

    def test_read_process_reads_one_real_process(self):
        if sys.platform != 'darwin':
            self.skipTest('macOS ps')
        mine = quiescence.read_process(os.getpid())
        self.assertEqual(mine, quiescence.read_processes()[os.getpid()])
        child = subprocess.Popen(['/usr/bin/true'])
        child.wait(timeout=10)
        self.assertIsNone(quiescence.read_process(child.pid))


# The hold began between START (13:26) and LATER (14:00), local time as ps prints it.
HOLD_BEGAN = 'Thu Oct 8 13:30:00 2026'


class StaleReap(unittest.TestCase):
    """quiescence.started_before: Update now's early reap stops only what started before the
    hold, and nothing above a process that started since."""

    def setUp(self):
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('TZ', None)  # ps and this process both read the system zone.
        self.cutoff = quiescence.latest_start(HOLD_BEGAN) - 1

    def stale_tree(self):
        """tree(), plus a git (113) the held service started beneath the old provider (110) after
        the hold began, and a dev server (114) started after it under the service itself."""
        table = tree()
        table[113] = process(113, 110, '/usr/bin/git', started=LATER)
        table[114] = process(114, 100, '/usr/local/bin/node', started=LATER)
        return table

    def test_only_what_started_before_the_hold_with_nothing_newer_beneath_it_is_stopped(self):
        host = FakeHost(self.stale_tree())
        record = host.reap(select=quiescence.started_before(self.cutoff))
        # The terminal's shell and its leftover dev server; not the provider above the new git.
        self.assertEqual(host.signals, [(111, 'SIGTERM'), (112, 'SIGTERM')])
        self.assertEqual([item['name'] for item in record['processes']], ['zsh', 'node'])
        for pid in (110, 113, 114, 120, 130, 200, 201):
            self.assertIn(pid, host.table)
        # The full reap, later, still stops everything it can prove.
        host = FakeHost(self.stale_tree())
        host.reap()
        self.assertEqual(host.signalled(), [110, 111, 112, 113, 114])

    def test_a_process_started_in_the_hold_s_own_second_or_later_waits(self):
        table = self.stale_tree()
        table[112]['startedAt'] = HOLD_BEGAN  # ps shows whole seconds: it may have started after.
        host = FakeHost(table)
        host.reap(select=quiescence.started_before(self.cutoff))
        self.assertEqual(host.signals, [])
        # A second earlier is before the hold.
        table[112]['startedAt'] = 'Thu Oct 8 13:29:59 2026'
        host = FakeHost(table)
        host.reap(select=quiescence.started_before(self.cutoff))
        self.assertEqual(host.signals, [(111, 'SIGTERM'), (112, 'SIGTERM')])

    def test_a_start_time_that_cannot_be_placed_waits_for_the_full_reap(self):
        table = self.stale_tree()
        table[112]['startedAt'] = 'Xyz Oct 8 13:26:00 2026'
        host = FakeHost(table)
        host.reap(select=quiescence.started_before(self.cutoff))
        self.assertEqual(host.signals, [])

    def test_nothing_is_chosen_when_this_process_could_read_another_zone(self):
        host = FakeHost(self.stale_tree())
        with mock.patch.dict(os.environ, {'TZ': 'UTC'}):
            record = host.reap(select=quiescence.started_before(self.cutoff))
        self.assertEqual((host.signals, record['processCount']), ([], 0))

    def test_ps_start_times_are_read_as_their_latest_instant_in_the_system_zone(self):
        stamp = 1792955806  # 2026-10-25T19:16:46Z
        local = time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(stamp))
        self.assertEqual(quiescence.latest_start(local), stamp + 1)
        self.assertIsNone(quiescence.latest_start('not a time'))
        # In a zone with DST: a repeated hour takes its later reading, a skipped one is None.
        code = ('import sys; sys.path.insert(0, sys.argv[1]); import json, quiescence; print(json.dumps('
                '[quiescence.latest_start(value) for value in sys.argv[2:]]))')
        values = ['Sun Oct 25 15:16:46 2026', 'Sun Nov 1 01:30:00 2026', 'Sun Mar 8 02:30:00 2026']
        result = subprocess.run([sys.executable, '-B', '-c', code, str(HERE)] + values, capture_output=True, text=True,
                                timeout=30, env={'PATH': '/usr/bin:/bin', 'TZ': 'America/New_York'}, check=True)
        self.assertEqual(json.loads(result.stdout), [stamp + 1, 1793514600 + 1, None])  # 06:30Z, EST.


@unittest.skipUnless(sys.platform == 'darwin', 'reads the macOS process table and kernel executables')
class ReapRealProcesses(unittest.TestCase):
    """Real processes this test starts: a stand-in service with a provider that ignores
    SIGTERM and a leftover sleep beneath it, and the same two programs outside it. Only the
    supervisor is synthetic (no power assertion is taken); signals and identities are real."""

    SERVICE = r'''
import signal, subprocess, sys, time
signal.signal(signal.SIGCHLD, signal.SIG_IGN)  # Exited children are reaped at once.
subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]])
subprocess.Popen(['/bin/sleep', '300'])
time.sleep(300)
'''
    # Ignores SIGTERM, then says so by creating the file it is given.
    HUNG = ('import pathlib, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
            'pathlib.Path(sys.argv[1]).touch(); time.sleep(300)')

    def spawn(self, argv):
        # Its own process group, so a failed run still stops whatever it started.
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, start_new_session=True)

        def stop():
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)
        self.addCleanup(stop)
        return child

    def test_only_the_service_tree_is_stopped(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        ready = [pathlib.Path(directory.name) / name for name in ('inside', 'outside')]
        service = self.spawn([sys.executable, '-c', self.SERVICE, self.HUNG, str(ready[0])])
        outside = [self.spawn(['/bin/sleep', '300']), self.spawn([sys.executable, '-c', self.HUNG, str(ready[1])])]
        supervisor = process(-7, service.pid, '/usr/bin/caffeinate', uid=os.getuid())

        def processes():
            table = quiescence.read_processes()
            table[supervisor['pid']] = dict(supervisor)
            return table
        deadline = time.monotonic() + 20
        while True:
            table = processes()
            children = [item for item in table.values() if item['parent'] == service.pid and item['pid'] > 0]
            if len(children) == 2 and all(path.exists() for path in ready):
                break
            self.assertLess(time.monotonic(), deadline, 'The stand-in service did not start its children')
            time.sleep(0.1)
        executable = table[service.pid]['executable']
        with mock.patch.object(quiescence, 'REAP_TERM_SECONDS', 2):
            record = quiescence.reap_descendants(service.pid, os.getuid(), executable, ARGS,
                                                 process_reader=processes, argv_reader=lambda pid: ARGS,
                                                 single_reader=quiescence.read_process)
        self.assertEqual(record['processCount'], 2)
        self.assertEqual(sorted(item['signal'] for item in record['signals']), ['SIGKILL', 'SIGTERM', 'SIGTERM'])
        self.assertEqual(record['survivors'], [])
        after = quiescence.read_processes()
        for child in children:
            self.assertNotIn(child['pid'], after)
        self.assertIsNone(service.poll())
        for child in outside:
            self.assertIsNone(child.poll(), 'An unrelated process was stopped')
        signalled = {item['pid'] for item in record['signals']}
        self.assertEqual(signalled, {child['pid'] for child in children})


REQUEST = '2026-10-12T20:01:00.000Z'


class UpdateReapMode(unittest.TestCase):
    """update.py --reap: the verified service, held for this very request, or nothing."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = pathlib.Path(directory.name).resolve()
        self.own = self.home / '.specwithcode' / 'm4'
        (self.own / 'updates').mkdir(parents=True)
        self.service = {'owner': mock.Mock(uid=501), 'home': self.home, 'own': self.own, 'node': pathlib.Path(NODE),
                        'content': {'ProgramArguments': ARGS},
                        'runtime': {'pid': 4242, 'startedAt': '2026-10-12T19:00:00.000Z'}}
        self.hold(pid=4242, startedAt='2026-10-12T20:00:00.000Z', expiresAt='2026-10-12T20:15:00.000Z')
        self.settings(installMode='force', installRequestedAt=REQUEST, installCancelledAt=None)
        self.now = datetime.datetime(2026, 10, 12, 20, 5, tzinfo=datetime.timezone.utc)

    def hold(self, **values):
        (self.own / 'updates/hold.json').write_text(json.dumps(dict({'schemaVersion': 1, 'holdId': 'h'}, **values)))

    def settings(self, **values):
        (self.own / 'updates/config.json').write_text(json.dumps(values))

    def held(self, request=REQUEST):
        update.assert_held(self.service, request, self.now)

    def test_a_service_held_for_this_request_may_be_reaped(self):
        self.held()
        # A cancel that came before the request does not count.
        self.settings(installMode='force', installRequestedAt=REQUEST, installCancelledAt='2026-10-12T19:30:00Z')
        self.held()

    def test_anything_but_the_held_service_and_its_request_is_refused(self):
        hold = json.loads((self.own / 'updates/hold.json').read_text())
        settings = json.loads((self.own / 'updates/config.json').read_text())
        cases = {
            # The service restarted (crash or relaunch): the new process holds nothing.
            'restarted service': lambda: self.hold(**dict(hold, pid=5151)),
            'hold from before this process started': lambda: self.service['runtime'].__setitem__(
                'startedAt', '2026-10-12T20:00:30.000Z'),
            'hold ended': lambda: self.hold(**dict(hold, expiresAt='2026-10-12T20:04:59.000Z')),
            'no hold': lambda: (self.own / 'updates/hold.json').unlink(),
            'hold file is a link': lambda: ((self.own / 'updates/hold.json').unlink(),
                                            (self.own / 'updates/hold.json').symlink_to(self.own / 'updates/config.json')),
            'malformed hold': lambda: (self.own / 'updates/hold.json').write_text('[]'),
            'cancelled': lambda: self.settings(**dict(settings, installCancelledAt='2026-10-12T20:02:00Z')),
            'asked again': lambda: self.settings(**dict(settings, installRequestedAt='2026-10-12T20:03:00.000Z')),
            'not forced': lambda: self.settings(**dict(settings, installMode='normal')),
            'request before the hold': lambda: self.hold(**dict(hold, startedAt='2026-10-12T20:01:30.000Z')),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                self.setUp()
                change()
                with self.assertRaisesRegex(AssertionError, 'symlink' if 'link' in name else update.HOLD_REFUSAL):
                    self.held()

    def test_reap_checks_the_service_and_its_hold_then_stops_its_descendants(self):
        calls = []

        def reap_descendants(*args, report, guard, select):
            calls.append(args)
            self.assertIsNone(select)  # A full reap: everything it can prove.
            guard()
            report.update(processCount=1, signals=[{'pid': 7, 'startedAt': START, 'signal': 'SIGTERM'}],
                          survivors=[])
        with mock.patch.object(update, '_service', return_value=self.service) as service, \
                mock.patch.object(update, 'assert_held') as held, \
                mock.patch.object(update, 'reap_descendants', reap_descendants):
            record = update.reap('m4', REQUEST)
        service.assert_called_once_with('m4')
        self.assertEqual(held.call_args_list, [mock.call(self.service, REQUEST)] * 2)  # Before, and per signal.
        self.assertEqual(calls, [(4242, 501, NODE, ARGS)])
        self.assertEqual((record['result'], record['servicePid'], record['identity']), ('reaped', 4242, 'm4'))

    def test_an_unverified_or_unheld_service_is_never_reaped(self):
        for name, patch in {'unverified': dict(_service=mock.Mock(side_effect=AssertionError('Port belongs to another process'))),
                            'not held': dict(_service=mock.Mock(return_value=self.service),
                                             assert_held=mock.Mock(side_effect=AssertionError(update.HOLD_REFUSAL)))}.items():
            with self.subTest(case=name), mock.patch.multiple(update, **patch), \
                    mock.patch.object(update, 'reap_descendants') as reap_descendants:
                report = {}
                with self.assertRaises(AssertionError):
                    update.reap('m4', REQUEST, report)
                reap_descendants.assert_not_called()
                self.assertEqual(report['result'], 'refused')

    def stale_reap(self, work=None, stale=True, before_signal=None):
        """update.reap with the real quiescence.reap_descendants on a FakeHost: an old provider
        (110), a git (113) the held service started beneath it, an old terminal (111) with a
        leftover dev server (112), and a dev server (114) started after the hold."""
        began = datetime.datetime(2026, 10, 12, 20, 0, tzinfo=datetime.timezone.utc).timestamp()
        old, new = (time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(began + offset)) for offset in (-3600, 60))
        table = {1: process(1, 0, '/sbin/launchd', 0), 100: process(100, 1, NODE, started=old),
                 101: process(101, 100, '/usr/bin/caffeinate', started=old),
                 110: process(110, 100, '/verified/codex', started=old), 113: process(113, 110, '/usr/bin/git', started=new),
                 111: process(111, 100, '/bin/zsh', started=old), 112: process(112, 111, '/usr/local/bin/node', started=old),
                 114: process(114, 100, '/usr/local/bin/node', started=new)}
        host = self.host = FakeHost(table)
        host.before_signal = before_signal
        self.work = dict(work or {})
        service = dict(self.service, runtime={'pid': 100, 'startedAt': '2026-10-12T19:00:00.000Z'})
        self.hold(pid=100, startedAt='2026-10-12T20:00:00.000Z', expiresAt='2026-10-12T20:15:00.000Z')
        held, counts = update.assert_held, []

        def native_work_counts(state):
            counts.append(state)
            return dict({'runs': 0, 'queued': 0, 'requests': 0, 'effects': 0, 'sessions': 0, 'held': 0}, **self.work)

        def reap_descendants(*args, **values):
            return quiescence.reap_descendants(*args, process_reader=host.processes, argv_reader=lambda pid: ARGS,
                                               executable_reader=host.executable, signaler=host.kill,
                                               clock=lambda: host.now, sleeper=host.sleep, **values)
        report = {}
        with mock.patch.dict(os.environ), mock.patch.object(update, '_service', return_value=service), \
                mock.patch.object(update, 'assert_held', lambda *args: held(*args, now=self.now)), \
                mock.patch.object(update, 'native_work_counts', native_work_counts), \
                mock.patch.object(update, 'reap_descendants', reap_descendants):
            os.environ.pop('TZ', None)
            try:
                update.reap('m4', REQUEST, report, stale=stale)
            finally:
                self.counts = counts
        return host, report

    def test_a_stale_reap_stops_only_what_started_before_the_hold(self):
        host, record = self.stale_reap()
        self.assertEqual(host.signals, [(111, 'SIGTERM'), (112, 'SIGTERM')])
        self.assertEqual((record['result'], record['stale'], record['processCount']), ('reaped', True, 2))
        self.assertEqual(self.counts, [self.own / 'userdata'] * 3)  # First, then before each signal.
        # Without --stale the same service loses everything it can prove, with no database read.
        host, record = self.stale_reap(stale=False)
        self.assertEqual(host.signalled(), [110, 111, 112, 113, 114])
        self.assertEqual((record['stale'], self.counts), (False, []))

    def test_a_stale_reap_never_runs_while_the_database_shows_work(self):
        for key in ('runs', 'queued', 'requests', 'effects', 'sessions'):
            with self.subTest(key=key), self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
                self.stale_reap(work={key: 1})
            self.assertEqual(self.host.signals, [])

        def started_work(pid, number):  # A run starts while it signals: no further signal.
            self.work['runs'] = 1
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            self.stale_reap(before_signal=started_work)
        self.assertEqual(self.host.signals, [(111, 'SIGTERM')])

    def test_command_line_passes_stale_through(self):
        for extra, stale in (([], False), (['--stale'], True)):
            with self.subTest(extra=extra), mock.patch.object(update, 'reap') as called:
                called.side_effect = lambda identity, request, report, stale=False: report.update(
                    signals=[], survivors=[], result='reaped')
                target = self.home / ('reap-%d.json' % stale)
                self.main(target, '--request', REQUEST, *extra)
                self.assertEqual(called.call_args, mock.call('m4', REQUEST, mock.ANY, stale=stale))
                self.assertEqual(json.loads(target.read_text())['result'], 'reaped')

    def main(self, path, *extra):
        out = io.StringIO()
        with mock.patch.object(sys, 'argv', ['update.py', '--identity', 'm4', '--reap', str(path)] + list(extra)), \
                contextlib.redirect_stdout(out):
            update.main()
        return out.getvalue()

    def test_command_line_writes_the_record_and_never_overwrites_one(self):
        path = self.home / 'reap.json'

        def reap(identity, request, report, stale=False):
            report.update(signals=[], survivors=[], result='reaped')
            return dict(report)
        with mock.patch.object(update, 'reap', side_effect=reap) as called:
            output = self.main(path, '--request', REQUEST)
        self.assertEqual(called.call_args[0][:2], ('m4', REQUEST))
        self.assertEqual(json.loads(path.read_text())['result'], 'reaped')
        self.assertEqual(json.loads(output)['result'], 'reaped')
        for extra in ([], ['--request', REQUEST]):  # No request, or a record already there.
            with self.subTest(extra=extra), mock.patch.object(update, 'reap') as called:
                target = path if extra else self.home / 'other.json'
                with self.assertRaises(AssertionError):
                    self.main(target, *extra)
                called.assert_not_called()

    def test_a_reap_that_stops_part_way_still_records_what_it_sent(self):
        path = self.home / 'reap.json'

        def reap(identity, request, report, stale=False):
            report.update(result='refused', signals=[{'pid': 7, 'startedAt': START, 'signal': 'SIGTERM'}],
                          survivors=[])
            raise AssertionError(update.HOLD_REFUSAL)
        with mock.patch.object(update, 'reap', side_effect=reap):
            with self.assertRaises(AssertionError):
                self.main(path, '--request', REQUEST)
        record = json.loads(path.read_text())
        self.assertEqual(record['result'], 'failed')
        self.assertEqual(record['signals'], [{'pid': 7, 'startedAt': START, 'signal': 'SIGTERM'}])
        self.assertEqual(record['error'], 'environment ' + update.HOLD_REFUSAL)

    def test_snapshot_still_reads_the_same_verified_service(self):
        self.assertIn('_service(identity)', pathlib.Path(HERE / 'update.py').read_text())
        with mock.patch.object(update, '_service', side_effect=AssertionError('The SpecWithCode service is not running')):
            with self.assertRaises(AssertionError):
                update.snapshot('m4')

    def test_the_hold_file_the_server_writes_is_the_one_the_helper_reads(self):
        source = (HERE.parent.parent / 'apps/server/src/serviceUpdate/ServiceUpdateHold.ts').read_text()
        self.assertIn('export const HOLD_MARKER_FILE = "hold.json";', source)
        for key in ('schemaVersion: 1', 'pid,', 'startedAt:', 'expiresAt:'):
            self.assertIn(key, source)


# The fake helper of test-update-agent.py, taught `--reap`: with reapClears, snapshots refuse
# until a full reap ran (the leftover processes were what kept the service busy); an early
# `--reap --stale` clears them only with staleClears (they started before the hold). With
# cancelAt, the person cancels while that snapshot runs.
REAP_HELPER = agent_tests.FAKE_HELPER
for old, new in (("for flag in ['--identity', '--snapshot',", "for flag in ['--identity', '--snapshot', '--reap',"),
                 ("parser.add_argument('--allow-project-migrations', action='store_true')\n",
                  "parser.add_argument('--allow-project-migrations', action='store_true')\n"
                  "parser.add_argument('--stale', action='store_true')\n"),
                 ("if args.snapshot:\n",
                  "if args.snapshot and control.get('cancelAt') == snapshots:\n"
                  "    settings = json.loads(pathlib.Path(control['configPath']).read_text())\n"
                  "    settings['installCancelledAt'] = '2026-10-12T21:00:00+00:00'\n"
                  "    pathlib.Path(control['configPath']).write_text(json.dumps(settings))\n"
                  "if args.snapshot:\n"),
                 ("applies = len([argv for argv in calls if '--prestate' in argv])\n",
                  "applies = len([argv for argv in calls if '--prestate' in argv])\n"
                  "reaps = len([argv for argv in calls if '--reap' in argv and ('--stale' not in argv or control.get('staleClears'))])\n"
                  "if args.reap:\n"
                  "    assert not os.path.exists(args.reap)\n"
                  "    pathlib.Path(args.reap).write_text(json.dumps({'result': 'reaped', 'signals': []}))\n"
                  "    sys.exit(0)\n"),
                 ("if control.get('snapshotFail') or", "if (control.get('snapshotFail') and not (control.get('reapClears') and reaps)) or")):
    assert REAP_HELPER.count(old) == 1, old
    REAP_HELPER = REAP_HELPER.replace(old, new)

TERMINALS = 'REFUSAL descendants codex=1 node=1'


def full_reap(call):
    return '--reap' in call['argv'] and '--stale' not in call['argv']


class AgentReap(agent_tests.AgentCase):
    def setUp(self):
        super(AgentReap, self).setUp()
        base = update_agent.utcnow()
        for target, name, value in ((agent_tests, 'FAKE_HELPER', REAP_HELPER),
                                    (update_agent, 'utcnow', lambda: base + self.offset)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request(self, mode='force', hold_minutes=15, requested='2026-10-12T20:00:00+00:00'):
        hold = (update_agent.utcnow() + datetime.timedelta(minutes=hold_minutes)).isoformat()
        self.config(installAutomatically=False, quietMinutes=60, installMode=mode, installRequestedAt=requested,
                    installHoldUntil=hold if mode == 'force' else None)

    def messages(self):
        seen = []
        self.on_sleep = lambda: seen.append(self.state()['message'])
        return seen

    def reap_calls(self):
        """The full reaps."""
        return [call for call in self.calls() if full_reap(call)]

    def stale_calls(self):
        """The early reaps, of what started before the hold."""
        return [call for call in self.calls() if '--reap' in call['argv'] and '--stale' in call['argv']]

    def test_a_forced_request_stuck_on_leftover_processes_reaps_once_then_installs(self):
        self.fake.add_release()
        self.request()
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=True)
        seen = self.messages()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'installed')
        reaps = self.reap_calls()
        self.assertEqual(len(reaps), 1)
        argv = reaps[0]['argv']
        self.assertEqual(argv[:3], ['--identity', 'm4', '--reap'])
        self.assertEqual(argv[4:], ['--request', '2026-10-12T20:00:00+00:00'])  # The request it serves.
        record = pathlib.Path(argv[3])
        self.assertEqual(record.parent, self.updates / 'receipts')
        self.assertEqual(json.loads(record.read_text())['result'], 'reaped')
        # The drain had REAP_AFTER (two minutes) before everything was stopped: the early reap, of
        # what started before the hold, cleared nothing here.
        before = [call for call in self.calls()[:self.calls().index(reaps[0])] if '--snapshot' in call['argv']]
        self.assertEqual(len(before), 13)
        stale = [self.calls().index(call) for call in self.stale_calls()]
        self.assertEqual(len(stale), update_agent_reap.STALE_REAP_LIMIT)
        self.assertEqual([len([call for call in self.calls()[start:end] if '--snapshot' in call['argv']])
                          for start, end in zip([0] + stale, stale)], [3, 2])  # At 20 and 40 seconds.
        self.assertIn(update_agent_reap.REAPING, seen)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_leftovers_from_before_the_hold_are_reaped_after_twenty_seconds(self):
        self.fake.add_release()
        self.request()
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=True, staleClears=True)
        seen = self.messages()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'installed')
        stale = self.stale_calls()
        self.assertEqual((len(stale), self.reap_calls()), (1, []))
        argv = stale[0]['argv']
        self.assertEqual(argv[:3], ['--identity', 'm4', '--reap'])
        self.assertEqual(argv[4:], ['--stale', '--request', '2026-10-12T20:00:00+00:00'])
        self.assertEqual(json.loads(pathlib.Path(argv[3]).read_text())['result'], 'reaped')
        # Refused at 0, 10 and 20 seconds (REAP_STALE_AFTER), not for two minutes.
        before = [call for call in self.calls()[:self.calls().index(stale[0])] if '--snapshot' in call['argv']]
        self.assertEqual(len(before), 3)
        self.assertIn(update_agent_reap.REAPING, seen)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_no_early_reap_for_running_work(self):
        """A provider still in a turn gets the full REAP_AFTER to answer its interrupt."""
        self.fake.add_release()
        self.request(hold_minutes=10)
        self.control(snapshotFail=True, snapshotError='REFUSAL native-work runs=1 requests=0 effects=0 sessions=1',
                     reapClears=False, staleClears=True)
        self.run_agent()
        self.assertEqual(self.stale_calls(), [])
        self.assertEqual(len(self.reap_calls()), update_agent_reap.REAP_LIMIT)

    def test_no_early_reap_that_would_outlast_the_hold(self):
        self.fake.add_release()
        self.request(hold_minutes=2)  # At 20 seconds a reap could still run past the hold's end.
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=True, staleClears=True)
        self.run_agent()
        self.assertEqual((self.stale_calls(), self.reap_calls()), ([], []))
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')

    def test_a_newer_request_gets_its_own_early_reap(self):
        self.fake.add_release()
        self.request(hold_minutes=15)
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=False)
        newer = '2026-10-12T20:30:00+00:00'

        def pressed_again():
            config = json.loads((self.updates / 'config.json').read_text())
            if len(self.reap_calls()) == 2 and config['installRequestedAt'] != newer:
                self.request(hold_minutes=15, requested=newer)
        self.on_sleep = pressed_again
        self.run_agent()
        limit = update_agent_reap.STALE_REAP_LIMIT
        self.assertEqual([call['argv'][-1] for call in self.stale_calls()], ['2026-10-12T20:00:00+00:00'] * limit + [newer] * limit)
        # Each request's early reaps came before its first full reap.
        calls = self.calls()
        for request in ('2026-10-12T20:00:00+00:00', newer):
            mine = [index for index, call in enumerate(calls) if '--reap' in call['argv'] and call['argv'][-1] == request]
            self.assertEqual([index for index in mine if '--stale' in calls[index]['argv']], mine[:limit])

    def test_a_hung_service_is_reaped_at_most_twice_two_minutes_apart(self):
        self.fake.add_release()
        self.request(hold_minutes=10)
        self.control(snapshotFail=True, snapshotError='REFUSAL native-work runs=0 requests=0 effects=0 sessions=1',
                     reapClears=False)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        calls = self.calls()
        positions = [index for index, call in enumerate(calls) if full_reap(call)]
        self.assertEqual(len(positions), update_agent_reap.REAP_LIMIT)
        between = [call for call in calls[positions[0]:positions[1]] if '--snapshot' in call['argv']]
        self.assertEqual(len(between), 12)
        self.assertEqual(self.apply_calls(), [])

    def test_a_request_written_while_a_pass_held_the_lock_gets_its_own_reaps(self):
        self.fake.add_release()
        self.request(hold_minutes=10)
        self.control(snapshotFail=True, snapshotError='REFUSAL native-work runs=0 requests=0 effects=0 sessions=1',
                     reapClears=False)
        arrived, newer = update_agent.update_request.arrived, '2026-10-12T20:30:00+00:00'

        def written_meanwhile(agent, load):  # The person presses Update now again as the first pass ends.
            if agent.config['installRequestedAt'] != newer:
                self.request(hold_minutes=10, requested=newer)
            return arrived(agent, load)
        with mock.patch.object(update_agent.update_request, 'arrived', written_meanwhile):
            self.run_agent()
        # run_once serves the newer request with the same Agent: its budget is not the first pass's.
        requests = [call['argv'][-1] for call in self.reap_calls()]
        self.assertEqual(requests, ['2026-10-12T20:00:00+00:00'] * 2 + [newer] * 2)

    def test_a_newer_request_taken_on_mid_pass_gets_its_own_reaps(self):
        self.fake.add_release()
        self.request(hold_minutes=15)
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=False)
        newer = '2026-10-12T20:30:00+00:00'

        def pressed_again():  # After both reaps for the first request, the person presses Update now again.
            config = json.loads((self.updates / 'config.json').read_text())
            if len(self.reap_calls()) == 2 and config['installRequestedAt'] != newer:
                self.request(hold_minutes=15, requested=newer)
        self.on_sleep = pressed_again
        self.run_agent()
        requests = [call['argv'][-1] for call in self.reap_calls()]
        self.assertEqual(requests, ['2026-10-12T20:00:00+00:00'] * 2 + [newer] * 2)
        # The newer request also drained REAP_AFTER (two minutes) before its first reap.
        calls = self.calls()
        positions = [index for index, call in enumerate(calls) if full_reap(call)]
        between = [call for call in calls[positions[1]:positions[2]] if '--snapshot' in call['argv']]
        self.assertGreaterEqual(len(between), 12)

    def test_a_newer_request_taken_on_late_in_a_pass_still_gets_its_reaps(self):
        """Update now chosen again 12 minutes into a forced pass: past the first request's window,
        within its own, so the leftover processes are still stopped for it."""
        self.fake.add_release()
        self.request(hold_minutes=15)
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=False)
        newer, started = '2026-10-12T20:30:00+00:00', update_agent.utcnow()

        def pressed_again():
            config = json.loads((self.updates / 'config.json').read_text())
            if update_agent.utcnow() - started >= datetime.timedelta(minutes=12) and config['installRequestedAt'] != newer:
                self.request(hold_minutes=15, requested=newer)
        self.on_sleep = pressed_again
        self.run_agent()
        requests = [call['argv'][-1] for call in self.reap_calls()]
        self.assertEqual(requests, ['2026-10-12T20:00:00+00:00'] * 2 + [newer] * 2)

    def test_no_reap_that_would_outlast_the_hold(self):
        self.fake.add_release()
        self.request(hold_minutes=3)  # At 2 minutes a reap could run past the hold's end.
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=True)
        self.run_agent()
        self.assertEqual(self.reap_calls(), [])
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')

    def test_no_reap_without_a_forced_request_or_for_refusals_no_process_causes(self):
        self.fake.add_release()
        cases = (('normal', TERMINALS), ('force', 'REFUSAL timeout lsof'),
                 ('force', 'OSError: database is locked\nREFUSAL busy OperationalError'))
        for index, (mode, error) in enumerate(cases):
            with self.subTest(mode=mode, error=error):
                self.offset = datetime.timedelta(0)
                self.request(mode=mode, hold_minutes=5, requested='2026-10-12T20:0%d:00+00:00' % index)
                self.control(snapshotFail=True, snapshotError=error, reapClears=True)
                self.run_agent()
                self.assertGreaterEqual(len(self.snapshot_calls()), 12)  # Retried for REAP_AFTER or longer.
                self.assertEqual(self.reap_calls(), [])
                self.assertEqual(self.apply_calls(), [])

    def test_a_cancel_while_the_last_snapshot_ran_stops_before_any_reap(self):
        self.fake.add_release()
        self.request()
        # Snapshot 13 is the last before the reap is due; the person cancels while it runs.
        self.control(snapshotFail=True, snapshotError=TERMINALS, reapClears=True, cancelAt=13,
                     configPath=str(self.updates / 'config.json'))
        self.run_agent()
        self.assertEqual(self.reap_calls(), [])
        self.assertEqual(len(self.snapshot_calls()), 13)
        self.assertEqual((self.state()['status'], self.state()['message']), ('downloaded', update_agent.CANCELLED))

    def test_no_reap_for_open_questions_or_finishing_steps(self):
        self.fake.add_release()
        cases = ('REFUSAL native-work runs=0 requests=1 effects=0 sessions=0',
                 'REFUSAL native-work runs=0 requests=0 effects=2 sessions=0',
                 'REFUSAL native-work runs=0 requests=3 effects=1 sessions=0',
                 'AssertionError: Native work is not idle')  # An older helper: no counts.
        for index, error in enumerate(cases):
            with self.subTest(error=error):
                self.offset = datetime.timedelta(0)
                self.request(hold_minutes=10, requested='2026-10-12T20:0%d:00+00:00' % index)
                self.control(snapshotFail=True, snapshotError=error, reapClears=True)
                self.run_agent()
                self.assertGreaterEqual(len(self.snapshot_calls()), 13)
                self.assertEqual(self.reap_calls(), [])

    def test_running_tasks_or_active_sessions_are_reaped_for(self):
        for runs, sessions in ((1, 0), (0, 2), (3, 1)):
            message = update_agent.refusal_reason(
                'REFUSAL native-work runs=%d requests=1 effects=1 sessions=%d' % (runs, sessions), 'failed')[1]
            self.assertTrue(update_agent_reap._process_refusal(update_agent, message), message)
        for detail in ('runs=0 requests=1 effects=0 sessions=0', 'runs=0 requests=0 effects=0 sessions=0'):
            message = update_agent.refusal_reason('REFUSAL native-work ' + detail, 'failed')[1]
            self.assertFalse(update_agent_reap._process_refusal(update_agent, message), message)
        for refusal in (TERMINALS, 'AssertionError: Owned service has unexpected or missing descendants'):
            message = update_agent.refusal_reason(refusal, 'failed')[1]
            self.assertTrue(update_agent_reap._process_refusal(update_agent, message), message)

    def test_a_helper_without_reap_is_tolerated(self):
        self.request(hold_minutes=10)
        self.control(snapshotFail=True, snapshotError=TERMINALS)
        with mock.patch.object(agent_tests, 'FAKE_HELPER', agent_tests.FAKE_HELPER):
            self.fake.add_release()
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertEqual(len(self.reap_calls()), update_agent_reap.REAP_LIMIT)  # Called, failed, ignored.
        self.assertEqual(len(self.stale_calls()), update_agent_reap.STALE_REAP_LIMIT)  # So were the early ones.


class InstalledAgent(agent_tests.AgentCase):
    def install(self):
        calls = []

        def launchctl(args, output=None):
            calls.append(list(args))
            return 0
        with mock.patch.object(update_agent, 'launchctl', launchctl), \
                mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
        plist = self.home / 'Library/LaunchAgents/com.specweave.studio.m4.updater.plist'
        return plistlib.loads(plist.read_bytes())

    def run_installed(self, content):
        """The installed agent, started as launchd starts it (its own folder, a bare environment)."""
        runner = '''import os,pathlib,pwd,runpy,sys,types
account = pwd.getpwuid(os.getuid())
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name=account.pw_name, pw_dir=os.environ['HOME'])
script = sys.argv.pop(1)
sys.path.insert(0, str(pathlib.Path(script).parent))
sys.argv[0] = script
runpy.run_path(script, run_name='__main__')
'''
        args = content['ProgramArguments']
        return subprocess.run([args[0], '-B', '-c', runner, *args[1:], '--home', str(self.home), '--status'],
                              cwd=content['WorkingDirectory'], capture_output=True, text=True, timeout=60,
                              env={'HOME': str(self.home), 'PATH': '/usr/bin:/bin'})

    def test_the_sibling_is_installed_beside_the_agent_and_the_installed_agent_imports_it(self):
        content = self.install()
        script = pathlib.Path(content['ProgramArguments'][1])
        sibling = script.with_name('update_agent_reap.py')
        self.assertEqual(sibling.read_bytes(), (HERE / 'update_agent_reap.py').read_bytes())
        result = self.run_installed(content)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['installedVersion'], '0.1.4')
        # Without it the installed agent cannot start: the copy is what makes it run.
        sibling.unlink()
        result = self.run_installed(content)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No module named 'update_agent_reap'", result.stderr)

    def test_a_changed_sibling_is_rewritten_with_the_agent(self):
        content = self.install()
        sibling = pathlib.Path(content['ProgramArguments'][1]).with_name('update_agent_reap.py')
        sibling.write_bytes(b'# an older fallback\n')
        self.log = ''
        self.install()
        self.assertIn('"result": "installed"', self.log)
        self.assertEqual(sibling.read_bytes(), (HERE / 'update_agent_reap.py').read_bytes())


if __name__ == '__main__':
    unittest.main()
