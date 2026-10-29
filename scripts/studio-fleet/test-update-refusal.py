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
import shutil
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
        self.state = self.home / '.specwithcode' / 'm4' / 'userdata'
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
        self.assertEqual(update.native_work_counts(self.state),
                         {'runs': 0, 'queued': 0, 'requests': 0, 'effects': 0, 'sessions': 0, 'held': 0})
        update._rows_snapshot(self.state, False)  # Idle: the authority agrees.
        self.add_work()
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            update._rows_snapshot(self.state, False)
        line = update.refusal_line('m4', AssertionError('Native work is not idle'))
        self.assertEqual(line, 'REFUSAL native-work runs=2 queued=0 requests=1 effects=2 sessions=1 held=0')
        self.assert_safe(line)

    def test_a_held_queue_is_not_work_but_a_waiting_queue_is(self):
        # 13 handoffs held after a restart once kept an update waiting forever: a held queue
        # starts only when someone resumes it, so the snapshot must not wait for it.
        db = sqlite3.connect(str(self.state / 'statev2.sqlite'))
        db.execute('ALTER TABLE orchestration_v2_projection_runs ADD COLUMN payload_json TEXT')
        db.executemany("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, 'queued', ?)",
                       [('h%d' % index, SECRET, json.dumps({'status': 'queued', 'queueHeld': True, 'text': SECRET}))
                        for index in range(13)] + [('bad', SECRET, 'not json')])
        db.commit()
        db.close()
        # The malformed payload is not provably held, so it still counts as a queued message.
        self.assertEqual(update.native_work_counts(self.state),
                         {'runs': 0, 'queued': 1, 'requests': 0, 'effects': 0, 'sessions': 0, 'held': 13})
        db = sqlite3.connect(str(self.state / 'statev2.sqlite'))
        db.execute("DELETE FROM orchestration_v2_projection_runs WHERE run_id = 'bad'")
        db.commit()
        db.close()
        update._rows_snapshot(self.state, False)  # Only held runs left: idle.
        self.assertEqual(update.native_work_counts(self.state)['held'], 13)
        db = sqlite3.connect(str(self.state / 'statev2.sqlite'))
        db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('q', ?, 'queued', ?)",
                   (SECRET, json.dumps({'status': 'queued', 'queueHeld': False})))
        db.commit()
        db.close()
        with self.assertRaisesRegex(AssertionError, 'Native work is not idle'):
            update._rows_snapshot(self.state, False)
        line = update.refusal_line('m4', AssertionError('Native work is not idle'))
        self.assertEqual(line, 'REFUSAL native-work runs=0 queued=1 requests=0 effects=0 sessions=0 held=13')
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

    def test_the_service_s_own_server_browser_is_not_named_while_something_else_is(self):
        """It is stopped by the update itself (M4, 1.0.86: "chrome-headless-shell x8, node"
        named eight browsers that never kept the update waiting)."""
        (self.state / 'server-runtime.json').write_text(json.dumps({'pid': 100, 'host': '127.0.0.1', 'port': 8319}))
        browser = str(self.state.parent / 'tools/chrome-headless-shell/mac-arm64/131.0.6778/chrome-headless-shell')
        table = {1: process(1, 0, '/sbin/launchd'), 100: process(100, 1, '/opt/node22/bin/node'),
                 101: process(101, 100, '/usr/bin/caffeinate'), 110: process(110, 100, browser),
                 111: process(111, 110, browser), 112: process(112, 100, browser), 113: process(113, 100, '/bin/zsh'),
                 114: process(114, 113, '/usr/local/bin/node')}
        error = AssertionError('Owned service has unexpected descendants')
        with patch.object(update, 'read_processes', return_value=table):
            self.assertEqual(update.refusal_line('m4', error), 'REFUSAL descendants node=1 zsh=1')
        # A browser from anywhere else is named; with nothing else there, so is the service's own.
        table[113] = process(113, 100, '/tmp/chrome-headless-shell')
        del table[114]
        with patch.object(update, 'read_processes', return_value=table):
            self.assertEqual(update.refusal_line('m4', error), 'REFUSAL descendants chrome-headless-shell=1')
        del table[113]
        with patch.object(update, 'read_processes', return_value=table):
            self.assertEqual(update.refusal_line('m4', error), 'REFUSAL descendants chrome-headless-shell=3')

    def test_the_service_s_own_tunnel_is_not_named_while_something_else_is(self):
        """It never keeps an update waiting (M1 and M3, 1.0.92: "(cloudflared)" for 30+ minutes)."""
        (self.state / 'server-runtime.json').write_text(json.dumps({'pid': 100, 'host': '127.0.0.1', 'port': 8319}))
        tunnel = str(self.state.parent / 'tools/cloudflared/2026.5.2/darwin-arm64/cloudflared')
        table = {1: process(1, 0, '/sbin/launchd'), 100: process(100, 1, '/opt/node22/bin/node'),
                 101: process(101, 100, '/usr/bin/caffeinate'), 110: process(110, 100, tunnel),
                 113: process(113, 100, '/bin/zsh')}
        error = AssertionError('Owned service has unexpected descendants')
        with patch.object(update, 'read_processes', return_value=table):
            self.assertEqual(update.refusal_line('m4', error), 'REFUSAL descendants zsh=1')
        # A cloudflared someone runs in a terminal is named.
        table[114] = process(114, 113, '/opt/homebrew/bin/cloudflared')
        with patch.object(update, 'read_processes', return_value=table):
            self.assertEqual(update.refusal_line('m4', error), 'REFUSAL descendants cloudflared=1 zsh=1')

    def test_timeouts_busy_and_environment_refusals(self):
        cases = [(subprocess.TimeoutExpired(['/usr/sbin/lsof', '-nP', '-t', '-iTCP:8319', '-sTCP:LISTEN'], 30),
                  'REFUSAL timeout lsof'),
                 (sqlite3.OperationalError('database is locked'), 'REFUSAL busy OperationalError'),
                 (AssertionError('Owned process identities changed during inventory'), 'REFUSAL busy AssertionError'),
                 # A process ps listed exited before the kernel read of it: retried, not an error.
                 (AssertionError('Process executable unavailable'), 'REFUSAL busy AssertionError'),
                 (AssertionError('Supervisor arguments unavailable'), 'REFUSAL busy AssertionError'),
                 (AssertionError('Invalid supervisor argument size'), 'REFUSAL busy AssertionError'),
                 (AssertionError('The SpecWithCode service is not running'),
                  'REFUSAL environment The SpecWithCode service is not running'),
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
        self.assertEqual(lines[-1], 'REFUSAL native-work runs=2 queued=0 requests=1 effects=2 sessions=1 held=0')
        self.assertFalse(target.exists())


HOLDER = """
import sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute('PRAGMA journal_mode=WAL')
db.execute('CREATE TABLE IF NOT EXISTS orchestration_events(stream_id TEXT, payload TEXT)')
db.execute("INSERT INTO orchestration_events VALUES ('t', 'x')")
print('ready', flush=True)
sys.stdin.read()
db.execute("INSERT INTO orchestration_events VALUES ('t', 'y')")
"""


# On the service's own SQLite (node:sqlite): Apple's system SQLite keeps its locks when another
# descriptor closes, so a /usr/bin/python3 dropper could not stand in for the service.
LOCK_DROPPER = """
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.prepare("SELECT count(*) AS n FROM orchestration_events").get();
for (const name of [process.argv[1] + "-shm", process.argv[1]]) fs.closeSync(fs.openSync(name, "r"));
process.stdout.write("ready\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
"""


class DatabaseRefusals(unittest.TestCase):
    """m4, October 15, 2026: another connection deleted statev2.sqlite-wal and -shm while the
    service held them, so every snapshot read raced the service's private log and failed with
    'database disk image is malformed', reported only as 'Unexpected snapshot failure
    (DatabaseError)'. The refusal names the cause."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = pathlib.Path(temporary.name).resolve() / 'userdata'
        self.state.mkdir()

    def test_an_unreadable_database_is_named_with_sqlites_reason(self):
        (self.state / 'statev2.sqlite').write_bytes(b'not a database ' * 512)
        with self.assertRaises(sqlite3.DatabaseError) as caught:
            update._rows_snapshot(self.state, False)
        self.assertNotIsInstance(caught.exception, sqlite3.OperationalError)
        self.assertEqual(update.refusal_line('m4', caught.exception),
                         'REFUSAL environment The SpecWithCode database could not be read (file is not a database)')
        cases = [(sqlite3.DatabaseError('database disk image is malformed'),
                  'REFUSAL environment The SpecWithCode database could not be read (database disk image is malformed)'),
                 (sqlite3.IntegrityError('UNIQUE constraint failed: auth_sessions.token'),
                  'REFUSAL environment The SpecWithCode database could not be read (IntegrityError)'),
                 # Not a database fault: still the generic line.
                 (RuntimeError('boom'), 'REFUSAL environment Unexpected snapshot failure (RuntimeError)')]
        for error, expected in cases:
            with self.subTest(error=repr(error)):
                self.assertEqual(update.refusal_line('m4', error), expected)

    @unittest.skipUnless(pathlib.Path('/usr/sbin/lsof').exists(), 'needs lsof')
    def test_a_deleted_log_the_service_still_writes_is_refused(self):
        database = self.state / 'statev2.sqlite'
        holder = subprocess.Popen([sys.executable, '-B', '-c', HOLDER, str(database)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.wait, 10)
        self.addCleanup(holder.stdin.close)
        self.addCleanup(holder.stdout.close)
        self.assertEqual(holder.stdout.readline().strip(), 'ready')
        update.assert_database_attached(holder.pid, self.state)  # The files on disk are the open ones.
        for name in ('statev2.sqlite-wal', 'statev2.sqlite-shm'):
            (self.state / name).unlink()
        reader = sqlite3.connect(str(database))  # Recreates an empty -wal and -shm, as on m4.
        # Its commits live only in the deleted log: a new reader cannot see them.
        self.assertEqual(reader.execute('SELECT count(*) FROM sqlite_master').fetchone()[0], 0)
        reader.close()
        self.assertTrue((self.state / 'statev2.sqlite-wal').exists())
        with self.assertRaises(AssertionError) as caught:
            update.assert_database_attached(holder.pid, self.state)
        self.assertEqual(str(caught.exception), update.DETACHED_DATABASE)
        self.assertEqual(update.refusal_line('m4', caught.exception), 'REFUSAL restart-needed detached')

    def test_a_service_that_lost_its_database_locks_is_refused(self):
        """m4, October 16, 2026: the service had dropped its own POSIX locks on statev2.sqlite and
        -shm, so the next read-only open rebuilt -shm under it and it died with SIGBUS. A snapshot
        must not be the open that does that."""
        database = self.state / 'statev2.sqlite'
        holder = subprocess.Popen([sys.executable, '-B', '-c', HOLDER, str(database)], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.wait, 10)
        self.addCleanup(holder.stdin.close)
        self.addCleanup(holder.stdout.close)
        self.assertEqual(holder.stdout.readline().strip(), 'ready')
        update.assert_database_locked(self.state)
        node = shutil.which('node')
        if node is None:
            self.skipTest('needs Node 22 for the service\'s own SQLite')
        dropper = subprocess.Popen([node, '--no-warnings', '--input-type=module', '--eval', LOCK_DROPPER, str(database)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(dropper.wait, 10)
        self.addCleanup(dropper.stdin.close)
        self.addCleanup(dropper.stdout.close)
        self.assertEqual(dropper.stdout.readline().strip(), 'ready')
        holder.stdin.close()  # Only the dropper holds the database now, without its locks.
        holder.wait(10)
        with self.assertRaises(AssertionError) as caught:
            update.assert_database_locked(self.state)
        self.assertEqual(str(caught.exception), update.LOCKS_LOST)
        self.assertEqual(update.refusal_line('m4', caught.exception), 'REFUSAL restart-needed locks-lost')

    def test_the_snapshot_checks_the_open_database_before_reading_it(self):
        tree = ast.parse((HERE / 'update.py').read_text())
        body = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == '_snapshot')
        calls = [node.func.id for node in ast.walk(body) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
        self.assertLess(calls.index('assert_database_attached'), calls.index('_read_state'))
        self.assertLess(calls.index('assert_database_locked'), calls.index('_read_state'))


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

    def test_the_agent_budget_leaves_room_for_m4s_902_second_preparation(self):
        # M4's 1.0.112 retry spent 527 + 101 + 274 s before the gate settle and refused at 780 s
        # under the 1500 s budget. The agent's budget takes that, the settle and one more full
        # read as long as the before-read (the check before the restart may need one).
        import update_agent
        budget, ready_by, min_ready = self.constants(str(update_agent.APPLY_TIMEOUT))
        self.assertEqual(budget, update_agent.APPLY_TIMEOUT)
        self.assertEqual(min_ready, update.READINESS_DEADLINE_SECONDS)
        old_cap = self.constants('1500')[1] - self.constants('1500')[2]
        cap = ready_by - min_ready
        self.assertLess(old_cap, 902 + update.INSTALL_GATE_SETTLE_SECONDS)
        self.assertGreater(cap, 902 + update.INSTALL_GATE_SETTLE_SECONDS + 527)
        # The helper's rollback share still ends inside the time the agent waits.
        self.assertLessEqual(ready_by + 420, update_agent.APPLY_TIMEOUT)

if __name__ == '__main__':
    unittest.main()
