#!/usr/bin/env python3
"""The snapshot helper's REFUSAL line: a code the update agent maps, with counts or
executable names only. Temporary homes and fake process tables; no real service.

Run: cd scripts/studio-fleet && python3 -B test-update-refusal.py
"""
import ast
import contextlib
import importlib.util
import io
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('owned_update_refusal', HERE / 'update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)

SCHEMA = """
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(request_id TEXT, prompt TEXT, status TEXT);
CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_provider_sessions(session_id TEXT, status TEXT);
"""
SECRET = 'secret-thread-text-0123456789'


def process(pid, parent, executable):
    return {'pid': pid, 'parent': parent, 'uid': 501, 'startedAt': 'Mon Oct 12 10:00:00 2026', 'executable': executable}


class RefusalLine(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.state = self.home / '.specweave-studio' / 'm4' / 'userdata'
        self.state.mkdir(parents=True)
        db = sqlite3.connect(str(self.state / 'statev2.sqlite'))
        db.executescript(SCHEMA)
        db.execute("INSERT INTO projection_projects VALUES ('p', ?)", (SECRET,))
        db.execute("INSERT INTO projection_threads VALUES (?)", (SECRET,))
        db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('r0', ?, 'completed')", (SECRET,))
        db.commit()
        db.close()
        home = patch.object(update.pathlib.Path, 'home', return_value=self.home)
        home.start()
        self.addCleanup(home.stop)

    def add_work(self):
        db = sqlite3.connect(str(self.state / 'statev2.sqlite'))
        db.executemany("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)",
                       [('r1', SECRET, 'running'), ('r2', SECRET, 'waiting'), ('r3', SECRET, 'interrupted')])
        db.execute("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('q', ?, 'pending')", (SECRET,))
        db.executemany("INSERT INTO orchestration_v2_effect_outbox VALUES (?, ?)",
                       [('e1', None), ('e2', 'running'), ('e3', 'succeeded')])
        db.executemany("INSERT INTO orchestration_v2_projection_provider_sessions VALUES (?, ?)",
                       [('s1', 'ready'), ('s2', 'starting')])
        db.commit()
        db.close()

    def assert_safe(self, line):
        self.assertTrue(line.startswith('REFUSAL '), line)
        self.assertEqual(line.count('\n'), 0)
        for forbidden in (SECRET, '/', '--', 'token', str(self.home)):
            self.assertNotIn(forbidden, line)

    def test_every_snapshot_check_has_a_message(self):
        tree = ast.parse((HERE / 'update.py').read_text())
        body = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == '_snapshot')
        bare = [node.lineno for node in ast.walk(body) if isinstance(node, ast.Assert) and node.msg is None]
        self.assertEqual(bare, [])

    def test_native_work_counts_each_check_and_agrees_with_the_snapshot(self):
        self.assertEqual(update.native_work_counts(self.state), {'runs': 0, 'requests': 0, 'effects': 0, 'sessions': 0})
        update._rows_snapshot(self.state, False)  # Idle: the authority agrees.
        self.add_work()
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            update._rows_snapshot(self.state, False)
        line = update.refusal_line('m4', AssertionError('Native work is not idle'))
        self.assertEqual(line, 'REFUSAL native-work runs=2 requests=1 effects=2 sessions=1')
        self.assert_safe(line)

    def test_descendants_are_named_by_executable_basename_only(self):
        (self.state / 'server-runtime.json').write_text(json.dumps({'pid': 100, 'host': '127.0.0.1', 'port': 8319}))
        table = {1: process(1, 0, '/sbin/launchd'), 100: process(100, 1, '/opt/node22/bin/node'),
                 101: process(101, 100, '/usr/bin/caffeinate'), 102: process(102, 100, '/bin/zsh'),
                 103: process(103, 102, '/Users/someone/.local/bin/claude'), 104: process(104, 102, '/bin/zsh'),
                 105: process(105, 101, '/opt/tools/mcp server'), 200: process(200, 1, '/bin/zsh')}

        def no_argv(pid):
            raise AssertionError('argv must never be read for a refusal')
        with patch.object(update, 'read_processes', return_value=table), \
                patch('quiescence.read_argv', side_effect=no_argv):
            for message in ('Owned service has unexpected descendants',
                            'Owned service has unexpected or missing descendants'):
                line = update.refusal_line('m4', AssertionError(message))
                self.assertEqual(line, 'REFUSAL descendants claude=1 mcp_server=1 zsh=2')
                self.assert_safe(line)
        self.assertNotIn('100', line)
        # Without a supervisor the line says so; an unreadable table still yields the code.
        with patch.object(update, 'read_processes', return_value={100: process(100, 1, '/opt/node')}):
            self.assertEqual(update.refusal_line('m4', AssertionError('Owned service has unexpected or missing descendants')),
                             'REFUSAL descendants no-supervisor')
        with patch.object(update, 'read_processes', side_effect=subprocess.TimeoutExpired(['/bin/ps'], 30)):
            self.assertEqual(update.refusal_line('m4', AssertionError('Owned service has unexpected descendants')),
                             'REFUSAL descendants')

    def test_timeouts_busy_and_environment_refusals(self):
        cases = [(subprocess.TimeoutExpired(['/usr/sbin/lsof', '-nP', '-t', '-iTCP:8319', '-sTCP:LISTEN'], 30),
                  'REFUSAL timeout lsof'),
                 (sqlite3.OperationalError('database is locked'), 'REFUSAL busy OperationalError'),
                 (AssertionError('Owned process identities changed during inventory'), 'REFUSAL busy AssertionError'),
                 # A process ps listed exited before the kernel read of it: retried, not an error.
                 (AssertionError('Process executable unavailable'), 'REFUSAL busy AssertionError'),
                 (AssertionError('Supervisor arguments unavailable'), 'REFUSAL busy AssertionError'),
                 (AssertionError('Invalid supervisor argument size'), 'REFUSAL busy AssertionError'),
                 (AssertionError('The Studio service is not running'),
                  'REFUSAL environment The Studio service is not running'),
                 (AssertionError('Port belongs to another process'), 'REFUSAL environment Port belongs to another process'),
                 (AssertionError('Release at /Users/x/token=abc differs'),
                  'REFUSAL environment A Studio installation check failed'),
                 (AssertionError(), 'REFUSAL environment A Studio installation check failed'),
                 (KeyError('token-abc'), 'REFUSAL environment A Studio installation file is missing or malformed (KeyError)'),
                 (FileNotFoundError(2, 'No such file', '/Users/x/installation.json'),
                  'REFUSAL environment A Studio installation file is missing or malformed (FileNotFoundError)')]
        for error, expected in cases:
            with self.subTest(error=repr(error)):
                line = update.refusal_line('m4', error)
                self.assertEqual(line, expected)
                self.assert_safe(line)

    def test_snapshot_cli_prints_the_refusal_last_and_exits_nonzero(self):
        self.add_work()
        target = self.home / 'snapshot.json'
        err = io.StringIO()
        with patch.object(update, 'snapshot', side_effect=AssertionError('Native work is not idle')), \
                patch('sys.argv', ['update.py', '--identity', 'm4', '--snapshot', str(target)]), \
                contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as caught:
                update.main()
        self.assertEqual(caught.exception.code, 1)
        lines = err.getvalue().strip().splitlines()
        self.assertIn('AssertionError: Native work is not idle', lines)
        self.assertEqual(lines[-1], 'REFUSAL native-work runs=2 requests=1 effects=2 sessions=1')
        self.assertFalse(target.exists())



class ApplyBudget(unittest.TestCase):
    """The agent's kill timeout sizes the apply steps; readiness is never cut short by it."""

    def constants(self, budget):
        env = {'PATH': '/usr/bin:/bin'}
        if budget is not None:
            env['STUDIO_UPDATE_APPLY_BUDGET'] = budget
        code = ('import importlib.util,json,sys;s=importlib.util.spec_from_file_location("u",sys.argv[1]);'
                'u=importlib.util.module_from_spec(s);s.loader.exec_module(u);'
                'print(json.dumps([u.APPLY_BUDGET_SECONDS,u.READY_BY_SECONDS_FROM_START,u.MIN_READINESS_SECONDS]))')
        out = subprocess.run([sys.executable, '-B', '-c', code, str(HERE / 'update.py')], env=env, cwd=str(HERE),
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def test_an_older_agent_keeps_the_900_second_plan(self):
        for budget in [None, '', 'junk', '600']:
            self.assertEqual(self.constants(budget), [900, 480, 60], budget)

    def test_a_longer_budget_keeps_the_full_readiness_wait_after_slow_staging(self):
        budget, ready_by, min_ready = self.constants('1500')
        self.assertEqual((budget, ready_by, min_ready), (1500, 1080, update.READINESS_DEADLINE_SECONDS))
        # Pre-restart work ends with the whole readiness wait still ahead, and the rollback's
        # 420 s share fits after it.
        self.assertGreaterEqual(ready_by - min_ready, 600)
        self.assertLessEqual(ready_by + 420, budget)
        self.assertEqual(self.constants('99999')[0], 3600)

if __name__ == '__main__':
    unittest.main()
