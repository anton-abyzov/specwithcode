#!/usr/bin/env python3
"""A normal update past the provider servers an idle service keeps open (idle_agents.py).

M3, 2026-10-19: an automatic update waited forever with "Waiting for open SpecWithCode
terminals and agent processes to close (codex, codex-code-mode-host, node x3, node_repl x4)":
the shared Codex app-server and its helpers, idle, with nothing running. Covers which processes
count as an idle provider server (quiescence), the selective reap, update.py's snapshot
fallback (idle_agent_refusal: settings, database, quiet window, record) and the agent's text.
Temporary homes and synthetic process tables; no real service.

Run: cd scripts/studio-fleet && python3 -B test-idle-agents.py
"""
import contextlib
import copy
import datetime
import functools
import importlib.util
import io
import json
import pathlib
import signal
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import idle_agents  # noqa: E402
import quiescence  # noqa: E402
import update_agent  # noqa: E402

spec = importlib.util.spec_from_file_location('owned_update_idle_agents', HERE / 'update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)

NODE = '/verified/node22'
CODEX = '/Users/someone/.specwithcode/m4/userdata/providers/codex/0.130.0/bin/codex'
START = 'Mon Oct 19 09:00:00 2026'
APP_SERVER = [CODEX, 'app-server', '-c', 'model_provider="openai_token_sharing"']


def process(pid, parent, executable, uid=501, started=START):
    return {'pid': pid, 'parent': parent, 'uid': uid, 'startedAt': started, 'executable': executable}


def m3_tree():
    """What M3 showed: the service (100), its supervisor, the shared Codex app-server (110) with
    codex-code-mode-host, three node MCP servers and four node_repl, and the server browser."""
    table = {1: process(1, 0, '/sbin/launchd', 0), 100: process(100, 1, NODE),
             101: process(101, 100, '/usr/bin/caffeinate'), 110: process(110, 100, CODEX),
             111: process(111, 110, CODEX[:-len('codex')] + 'codex-code-mode-host')}
    for pid in (112, 113, 114):
        table[pid] = process(pid, 110, '/opt/homebrew/bin/node')
    for pid in (115, 116, 117, 118):
        table[pid] = process(pid, 114, '/Users/someone/.cache/node_repl')
    table[200] = process(200, 1, CODEX)  # Codex the person runs in their own Terminal app.
    return table


class FakeHost(object):
    """A process table that signals change; an exited process's children go to launchd."""

    def __init__(self, table, home):
        self.table, self.signals, self.now, self.before_signal = table, [], 0.0, None
        self.argv = {101: ['/usr/bin/caffeinate', '-s', home + '/launch.sh'], 110: list(APP_SERVER)}
        self.args = self.argv[101]

    def processes(self):
        return copy.deepcopy(self.table)

    def argv_of(self, pid):
        if pid not in self.table:
            raise AssertionError('Supervisor arguments unavailable')
        return list(self.argv.get(pid, [self.table[pid]['executable']]))

    def executable(self, pid):
        if pid not in self.table:
            raise AssertionError('Process executable unavailable')
        return self.table[pid]['executable']

    def kill(self, pid, number):
        if self.before_signal:
            self.before_signal(pid, number)
        if pid not in self.table:
            raise ProcessLookupError(pid)
        self.signals.append((pid, signal.Signals(number).name))
        del self.table[pid]
        for item in self.table.values():
            if item['parent'] == pid:
                item['parent'] = 1

    def sleep(self, seconds):
        self.now += seconds

    def readers(self):
        return dict(process_reader=self.processes, argv_reader=self.argv_of, executable_reader=self.executable)

    def reap(self, **extra):
        return quiescence.reap_descendants(100, 501, NODE, self.args, signaler=self.kill, clock=lambda: self.now,
                                           sleeper=self.sleep, select=quiescence.idle_provider_trees,
                                           **dict(self.readers(), **extra))

    def providers(self):
        return quiescence.idle_providers(100, 501, NODE, self.args, **self.readers())


class IdleProviderServer(unittest.TestCase):
    def test_codex_app_server_as_studio_starts_it(self):
        cases = {
            'managed binary': (APP_SERVER, CODEX),
            'homebrew cask': (['/opt/homebrew/bin/codex', 'app-server'],
                              '/opt/homebrew/Caskroom/codex/0.130.0/codex-aarch64-apple-darwin'),
            'npm script': (['node', '/opt/homebrew/bin/codex', 'app-server'], '/opt/homebrew/Cellar/node/24/bin/node'),
            'npm script by its file name': (['/usr/local/bin/node', '/x/@openai/codex/bin/codex.js', 'app-server', '-c', 'a=b'],
                                            '/usr/local/bin/node'),
        }
        for name, (arguments, kernel) in cases.items():
            with self.subTest(case=name):
                self.assertEqual(quiescence.idle_provider_server(arguments, kernel), 'codex')

    def test_anything_else_is_not_a_provider_server(self):
        cases = {
            'a terminal': (['-zsh'], '/bin/zsh'),
            'a login shell': (['/bin/zsh', '-l', '-o', 'nopromptsp'], '/bin/zsh'),
            'codex run for one task': ([CODEX, 'exec', 'npm test'], CODEX),
            'codex without a subcommand': ([CODEX], CODEX),
            'app-server not first': ([CODEX, '-c', 'x', 'app-server'], CODEX),
            'named codex, runs a shell': ([CODEX, 'app-server'], '/bin/zsh'),
            'named codex, runs another program': ([CODEX, 'app-server'], '/usr/local/bin/codexx'),
            'another provider': (['/Users/someone/.local/bin/claude', '--output-format', 'stream-json'],
                                 '/Users/someone/.local/share/claude/versions/2.1.0'),
            'node running something else': (['node', '/srv/app/server.js', 'app-server'], '/usr/local/bin/node'),
            'node with no script': (['node'], '/usr/local/bin/node'),
            'no arguments': ([], CODEX),
        }
        for name, (arguments, kernel) in cases.items():
            with self.subTest(case=name):
                self.assertIsNone(quiescence.idle_provider_server(arguments, kernel))


HOME = '/private/owned/m3'


class SelectiveReap(unittest.TestCase):
    def test_the_idle_codex_tree_is_stopped_and_nothing_else(self):
        table = m3_tree()
        browser = HOME + '/tools/chrome-headless-shell/mac-arm64/131.0.6778/chrome-headless-shell'
        table[120] = process(120, 100, browser)
        host = FakeHost(table, HOME)
        host.argv[120] = [browser, '--headless', '--remote-debugging-pipe']
        self.assertEqual(host.providers(), {'codex': 1})
        self.assertEqual(host.signals, [])
        record = host.reap()
        self.assertEqual(sorted({pid for pid, _ in host.signals}), [110, 111, 112, 113, 114, 115, 116, 117, 118])
        self.assertEqual({name for _, name in host.signals}, {'SIGTERM'})
        self.assertEqual((record['processCount'], record['sparedBrowserCount'], record['survivors']), (9, 1, []))
        for pid in (1, 100, 101, 120, 200):
            self.assertIn(pid, host.table)
        self.assertNotIn(CODEX, json.dumps(record))

    def test_the_service_s_own_tunnel_beside_idle_codex_is_neither_named_nor_stopped(self):
        table = m3_tree()
        tunnel = HOME + '/tools/cloudflared/2026.5.2/darwin-arm64/cloudflared'
        table[140] = process(140, 100, tunnel)
        host = FakeHost(table, HOME)
        host.argv[140] = [tunnel, 'tunnel', '--no-autoupdate', '--loglevel', 'info', '--output', 'default', 'run']
        self.assertEqual(host.providers(), {'codex': 1})
        host.reap()
        self.assertEqual(sorted({pid for pid, _ in host.signals}), [110, 111, 112, 113, 114, 115, 116, 117, 118])
        self.assertIn(140, host.table)
        for pid in list(host.table):  # Only the tunnel is left: nothing for the fallback to name.
            if pid not in (1, 100, 101, 140, 200):
                del host.table[pid]
        self.assertEqual(host.providers(), {})

    def test_a_terminal_or_anything_unnamed_keeps_every_process_running(self):
        cases = {
            'an open terminal': {130: process(130, 100, '/bin/zsh')},
            'a command left in a terminal': {130: process(130, 100, '/bin/zsh'),
                                             131: process(131, 130, '/opt/homebrew/bin/node')},
            'another provider': {130: process(130, 100, '/Users/someone/.local/bin/claude')},
            'a root-owned helper': {130: process(130, 100, '/usr/libexec/helper', uid=0)},
            'another owner beneath codex': {130: process(130, 110, '/opt/homebrew/bin/node', uid=502)},
            'a work caffeinate': {130: process(130, 100, '/usr/bin/caffeinate')},
        }
        for name, extra in cases.items():
            with self.subTest(case=name):
                table = m3_tree()
                table.update(copy.deepcopy(extra))
                host = FakeHost(table, HOME)
                if 'caffeinate' in name:
                    host.argv[130] = ['/usr/bin/caffeinate', '-i', 'npm', 'test']
                with self.assertRaisesRegex(AssertionError, 'descendants'):
                    host.providers()
                with self.assertRaisesRegex(AssertionError, 'descendants'):
                    host.reap()
                self.assertEqual(host.signals, [])

    def test_codex_run_for_a_task_is_not_an_idle_server(self):
        host = FakeHost(m3_tree(), HOME)
        host.argv[110] = [CODEX, 'exec', '--json', 'fix the build']
        with self.assertRaisesRegex(AssertionError, 'unexpected descendants'):
            host.reap()
        self.assertEqual(host.signals, [])

    def test_the_guard_stops_the_reap_before_the_next_signal(self):
        host = FakeHost(m3_tree(), HOME)
        report, guarded = {}, []

        def guard():
            guarded.append(len(host.signals))
            if len(host.signals) == 2:
                raise AssertionError(idle_agents.NOT_ALLOWED)
        with self.assertRaisesRegex(AssertionError, 'normal update'):
            host.reap(report=report, guard=guard)
        self.assertEqual([pid for pid, _ in host.signals], [110, 111])
        self.assertEqual(len(report['signals']), 2)

    def test_a_restarted_service_stops_the_reap(self):
        host = FakeHost(m3_tree(), HOME)

        def restart(pid, number):
            if pid == 112:
                host.table[100] = process(100, 1, NODE, started='Mon Oct 19 10:00:00 2026')
        host.before_signal = restart
        with self.assertRaisesRegex(AssertionError, 'Owned service process identity changed'):
            host.reap()


SCHEMA = """
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY);
CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
CREATE TABLE orchestration_events(stream_id TEXT, payload TEXT);
CREATE TABLE orchestration_v2_events(thread_id TEXT, payload TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(request_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions(session_id TEXT, status TEXT);
CREATE TABLE unguarded_cache(value TEXT);
"""
T0 = datetime.datetime(2026, 10, 19, 9, 0, tzinfo=datetime.timezone.utc)


class SnapshotFallback(unittest.TestCase):
    """update.py idle_agent_refusal and the --snapshot command line around it."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.own = self.home / '.specwithcode' / 'm3'
        (self.own / 'updates').mkdir(parents=True)
        (self.own / 'userdata').mkdir()
        self.db = self.own / 'userdata' / 'statev2.sqlite'
        self.sql(SCHEMA + "INSERT INTO orchestration_v2_projection_runs VALUES ('r0', 't', 'completed');"
                 "INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('s0', 'ready');")
        self.settings(installAutomatically=True, installMode='normal', quietMinutes=10)
        self.runtime(100)
        patcher = mock.patch.object(update.pathlib.Path, 'home', return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.host = FakeHost(m3_tree(), str(self.own))
        self.service = {'owner': mock.Mock(uid=501), 'home': self.home, 'own': self.own, 'node': pathlib.Path(NODE),
                        'content': {'ProgramArguments': self.host.args}, 'runtime': {'pid': 100}}
        for name, value in (('_service', mock.Mock(return_value=self.service)),
                            ('idle_providers', functools.partial(quiescence.idle_providers, **self.host.readers())),
                            ('reap_descendants', mock.Mock(side_effect=functools.partial(
                                quiescence.reap_descendants, signaler=self.host.kill, clock=lambda: self.host.now,
                                sleeper=self.host.sleep, **self.host.readers())))):
            patcher = mock.patch.object(update, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def sql(self, script):
        db = sqlite3.connect(str(self.db))
        db.executescript(script)
        db.commit()
        db.close()

    def settings(self, **values):
        (self.own / 'updates/config.json').write_text(json.dumps(values))

    def runtime(self, pid):
        (self.own / 'userdata/server-runtime.json').write_text(json.dumps({'pid': pid, 'host': '127.0.0.1', 'port': 8319}))

    @property
    def marker(self):
        return self.own / 'updates' / idle_agents.MARKER

    def refuse(self, minutes=0, error='Owned service has unexpected descendants', report=None):
        return update.idle_agent_refusal('m3', AssertionError(error), report,
                                         now=T0 + datetime.timedelta(minutes=minutes))

    def records(self):
        receipts = self.own / 'updates' / 'receipts'
        return [json.loads(path.read_text()) for path in sorted(receipts.glob('idle-agents-*.json'))] \
            if receipts.exists() else []

    def test_idle_codex_is_stopped_after_the_quiet_window_then_the_snapshot_decides(self):
        self.assertEqual(self.refuse(0), 'REFUSAL idle-agents codex=1 wait=600')
        marker = json.loads(self.marker.read_text())
        self.assertEqual((marker['servicePid'], marker['idleSince']), (100, T0.isoformat()))
        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.refuse(4), 'REFUSAL idle-agents codex=1 wait=360')
        self.assertEqual(json.loads(self.marker.read_text())['idleSince'], T0.isoformat())
        update.reap_descendants.assert_not_called()
        self.assertEqual(self.host.signals, [])
        self.assertEqual(self.refuse(10), 'REFUSAL idle-agents codex=1 stopped=9')
        call = update.reap_descendants.call_args
        self.assertEqual(call.args, (100, 501, NODE, self.host.args))
        self.assertIs(call.kwargs['select'], quiescence.idle_provider_trees)
        self.assertEqual(sorted({pid for pid, _ in self.host.signals}), [110, 111, 112, 113, 114, 115, 116, 117, 118])
        for pid in (100, 101, 200):
            self.assertIn(pid, self.host.table)
        self.assertFalse(self.marker.exists())
        [record] = self.records()
        self.assertEqual((record['result'], record['reason'], record['servicePid'], record['providers']),
                         ('reaped', 'idle-agents', 100, {'codex': 1}))
        self.assertEqual(len(record['signals']), 9)
        # Nothing left beneath the service: the next snapshot no longer refuses for processes.
        quiescence._owned_tree(self.host.processes(), 100, 501, NODE, str(self.own))

    def test_a_first_sighting_never_stops_anything_even_with_no_quiet_time(self):
        self.settings(installAutomatically=True, installMode='normal', quietMinutes=0)
        self.assertEqual(self.refuse(0), 'REFUSAL idle-agents codex=1 wait=1')
        self.assertEqual(self.refuse(0), 'REFUSAL idle-agents codex=1 stopped=9')

    def test_new_rows_or_another_service_start_the_quiet_window_again(self):
        changes = {
            'a new message': lambda: self.sql("INSERT INTO orchestration_v2_events VALUES ('t', 'x');"),
            'a new thread': lambda: self.sql("INSERT INTO projection_threads VALUES ('t2');"),
            # The record is from an earlier service process (the same pid's start differs).
            'another service': lambda: self.marker.write_text(json.dumps(
                dict(json.loads(self.marker.read_text()), servicePid=4242))),
            'a malformed record': lambda: self.marker.write_text('[]'),
            'a future-dated record': lambda: self.marker.write_text(json.dumps(
                dict(json.loads(self.marker.read_text()), idleSince='2026-10-19T10:00:00+00:00'))),
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                self.setUp()
                self.refuse(0)
                change()
                self.assertEqual(self.refuse(10), 'REFUSAL idle-agents codex=1 wait=600')
                self.assertEqual(json.loads(self.marker.read_text())['idleSince'],
                                 (T0 + datetime.timedelta(minutes=10)).isoformat())
                self.assertEqual(self.host.signals, [])

    def test_bookkeeping_and_unguarded_rows_do_not_restart_it(self):
        self.refuse(0)
        # A thread waiting on a usage limit checks availability every five minutes.
        self.sql("INSERT INTO orchestration_events VALUES ('t', 'availability'); INSERT INTO unguarded_cache VALUES ('x');")
        self.assertEqual(self.refuse(10), 'REFUSAL idle-agents codex=1 stopped=9')

    def test_work_in_the_database_keeps_waiting_and_restarts_the_window(self):
        cases = {
            'a running run': "INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'running');",
            'a queued message': "INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't', 'queued');",
            'a pending request': "INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('q', 'pending');",
            'an unfinished effect': "INSERT INTO orchestration_v2_effect_outbox VALUES ('e', NULL);",
            'an active session': "INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('s1', 'working');",
        }
        for name, script in cases.items():
            with self.subTest(work=name):
                self.setUp()
                self.refuse(0)
                self.sql(script)
                with self.assertRaisesRegex(AssertionError, idle_agents.NOT_ALLOWED):
                    self.refuse(10)
                self.assertFalse(self.marker.exists())
                update.reap_descendants.assert_not_called()
                self.assertEqual(self.host.signals, [])

    def test_only_a_normal_update_that_may_install_now_stops_anything(self):
        cases = {
            'automatic installs off': dict(installAutomatically=False, installMode='normal'),
            'update now (forced)': dict(installAutomatically=True, installMode='force',
                                        installRequestedAt='2026-10-19T08:00:00Z'),
            'request cancelled': dict(installAutomatically=False, installMode='normal',
                                      installRequestedAt='2026-10-19T08:00:00Z', installCancelledAt='2026-10-19T08:01:00Z'),
            'no settings': None,
        }
        for name, settings in cases.items():
            with self.subTest(case=name):
                self.setUp()
                self.refuse(0)
                if settings is None:
                    (self.own / 'updates/config.json').unlink()
                else:
                    self.settings(**settings)
                with self.assertRaisesRegex(AssertionError, idle_agents.NOT_ALLOWED):
                    self.refuse(10)
                self.assertFalse(self.marker.exists())
                self.assertEqual(self.host.signals, [])
        # A pending normal request may install even with automatic installs off.
        self.setUp()
        self.settings(installAutomatically=False, installMode='normal', installRequestedAt='2026-10-19T08:00:00Z',
                      installCancelledAt='2026-10-19T07:00:00Z')
        self.refuse(0)
        self.assertEqual(self.refuse(10), 'REFUSAL idle-agents codex=1 stopped=9')

    def test_a_terminal_keeps_waiting_and_restarts_the_window(self):
        self.refuse(0)
        self.host.table[130] = process(130, 100, '/bin/zsh')
        with self.assertRaisesRegex(AssertionError, 'unexpected descendants'):
            self.refuse(10)
        self.assertFalse(self.marker.exists())
        del self.host.table[130]
        self.assertEqual(self.refuse(11), 'REFUSAL idle-agents codex=1 wait=600')
        self.assertEqual(self.host.signals, [])

    def test_other_refusals_restart_the_window_only_for_work(self):
        self.refuse(0)
        for error in (AssertionError('Owned process identities changed during inventory'),
                      AssertionError('Process executable unavailable'), sqlite3.OperationalError('database is locked')):
            with self.subTest(error=repr(error)):
                self.assertIsNone(update.idle_agent_refusal('m3', error, now=T0))
                self.assertTrue(self.marker.exists())
        self.assertIsNone(self.refuse(5, error='Native work is not idle'))
        self.assertFalse(self.marker.exists())
        update._service.assert_called_once_with('m3')

    def test_work_that_starts_during_the_reap_stops_it_and_the_record_says_what_was_sent(self):
        self.refuse(0)

        def work_starts(pid, number):
            if pid == 112:
                self.sql("INSERT INTO orchestration_v2_projection_runs VALUES ('r9', 't', 'running');")
        self.host.before_signal = work_starts
        report = {}
        with self.assertRaisesRegex(AssertionError, idle_agents.NOT_ALLOWED):
            self.refuse(10, report=report)
        self.assertEqual([pid for pid, _ in self.host.signals], [110, 111, 112])
        [record] = self.records()
        self.assertEqual((record['result'], len(record['signals'])), ('refused', 3))

    def test_a_service_that_restarts_during_the_reap_gets_no_further_signal(self):
        self.refuse(0)

        def restart(pid, number):
            if pid == 111:
                self.runtime(4242)
        self.host.before_signal = restart
        with self.assertRaisesRegex(AssertionError, 'Owned service process identity changed'):
            self.refuse(10)
        self.assertEqual([pid for pid, _ in self.host.signals], [110, 111])

    def snapshot_cli(self):
        target = self.home / 'snapshot.json'
        err = io.StringIO()
        with mock.patch.object(update, 'snapshot', side_effect=AssertionError('Owned service has unexpected descendants')), \
                mock.patch.object(update, 'refusal_line', return_value='REFUSAL descendants codex=1 node=3'), \
                mock.patch('sys.argv', ['update.py', '--identity', 'm3', '--snapshot', str(target)]), \
                contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as caught:
                update.main()
        self.assertEqual(caught.exception.code, 1)
        self.assertFalse(target.exists())
        return err.getvalue().strip().splitlines()

    def test_the_snapshot_command_prints_the_idle_agents_line_last(self):
        lines = self.snapshot_cli()
        self.assertIn('AssertionError: Owned service has unexpected descendants', lines)
        self.assertRegex(lines[-1], r'^REFUSAL idle-agents codex=1 wait=\d+$')
        # A terminal: the usual line, nothing stopped.
        self.host.table[130] = process(130, 100, '/bin/zsh')
        self.assertEqual(self.snapshot_cli()[-1], 'REFUSAL descendants codex=1 node=3')
        self.assertEqual(self.host.signals, [])


class AgentText(unittest.TestCase):
    def test_the_agent_says_what_the_update_waits_for(self):
        reason = update_agent.refusal_reason
        self.assertEqual(reason('Traceback ...\nREFUSAL idle-agents codex=1 wait=540\n', 'failed'),
                         ('waiting-for-quiet', 'Waiting for a quiet moment, then closing idle agent processes '
                          'so the update can install (codex)'))
        self.assertEqual(reason('REFUSAL idle-agents codex=2 stopped=9', 'failed'),
                         ('waiting-for-quiet', 'Closed idle agent processes; installing after a quiet moment (codex x2)'))
        self.assertEqual(reason('REFUSAL descendants codex=1 node=3 node_repl=4 zsh=1', 'failed'),
                         ('waiting-for-quiet', 'Waiting for open SpecWithCode terminals and agent processes to close '
                          '(codex, node x3, node_repl x4, zsh)'))

    def test_an_older_agent_still_shows_its_waiting_text(self):
        # Agents from before this change know no idle-agents code; the helper's traceback names
        # the descendants, so they keep saying what they said before.
        tail = ('AssertionError: Owned service has unexpected descendants\nREFUSAL idle-agents codex=1 wait=600\n')
        phrase = next(message for key, message in update_agent.WAITING_REASONS if key in tail)
        self.assertEqual(phrase, update_agent.WAITING_REASONS[1][1])


if __name__ == '__main__':
    unittest.main()
