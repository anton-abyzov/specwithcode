#!/usr/bin/env python3
"""rehearse_update.py on synthetic temporary state only: never ~/.specwithcode, never a real copy.

The previous release's state is made here: this checkout's server builds a database on an empty
temporary home, then migration 072 is undone (its row removed, the compaction table back in 070's
form with rows), so the rehearsal's candidate server runs 072's rebuild on the clone, as a real
1.0.183 to 1.0.184 update did. Every --home, --source-db, --source-config and --scratch below is a
temporary folder."""
import io
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import additive_migrations
import rehearse_update
import studio_paths

HERE = pathlib.Path(__file__).resolve().parent
COMPACTIONS = 'orchestration_v2_thread_history_compactions'
_STATE = {}


def node():
    found = os.environ.get('STUDIO_TEST_NODE') or shutil.which('node')
    assert found, 'Node 22 not found; set STUDIO_TEST_NODE'
    return found


def previous_release_state(folder):
    """A statev2.sqlite as the release before 072 left it, built once per run by the server."""
    if 'db' in _STATE:
        target = folder / 'statev2.sqlite'
        shutil.copy(_STATE['db'], target)
        return target
    built = pathlib.Path(tempfile.mkdtemp(prefix='rehearse-previous-'))
    unittest.addModuleCleanup(shutil.rmtree, built, ignore_errors=True)
    own = built / 'state'
    (own / 'userdata').mkdir(parents=True)
    candidate = rehearse_update.Candidate(rehearse_update.DEFAULT_ENTRYPOINT, own, built, 0)
    candidate.start()
    candidate.stop()
    database = own / 'userdata/statev2.sqlite'
    db = sqlite3.connect(database)
    assert db.execute('SELECT max(migration_id) FROM effect_sql_migrations').fetchone()[0] >= 72
    db.execute('DELETE FROM effect_sql_migrations WHERE migration_id >= 72')
    db.execute('DROP TABLE %s' % COMPACTIONS)
    db.execute(additive_migrations.REBUILT[72][1][COMPACTIONS]['before'])
    for row in additive_migrations.FIXTURES[72][COMPACTIONS]:
        db.execute('INSERT INTO %s (%s) VALUES (%s)' % (COMPACTIONS, ', '.join(row), ', '.join('?' * len(row))), list(row.values()))
    db.commit()
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    _STATE['db'] = database
    return previous_release_state(folder)


class Rehearsal(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='rehearse-test-')
        self.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name).resolve()
        self.home = self.root / 'home'
        self.scratch = self.root / 'scratch'
        self.scratch.mkdir()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.config = self.source / 'config.json'
        self.config.write_text(json.dumps({'schemaVersion': 1, 'checkAutomatically': True, 'installMode': 'normal',
                                           'quietMinutes': 15}))

    def run_main(self, *extra):
        out = io.StringIO()
        with redirect_stdout(out):
            code = rehearse_update.main(['--json', '--home', str(self.home), '--scratch', str(self.scratch), *extra])
        return code, json.loads(out.getvalue())

    def rehearsal(self, *extra):
        database = previous_release_state(self.source)
        return self.run_main('--source-db', str(database), '--source-config', str(self.config), '--idle', '3', *extra)

    def test_a_declared_rebuild_rehearses_verified_and_the_clone_is_removed(self):
        before = (self.source / 'statev2.sqlite')
        code, report = self.rehearsal()
        self.assertEqual(code, 0, report)
        self.assertEqual(report['result'], 'passed')
        self.assertEqual(report['phase'], 'verified')
        self.assertEqual(report['databaseProofMode'], 'stopped-clone-pages-v1')
        self.assertEqual(report['fullReadMigrations'], [])
        # The candidate server ran 072's rebuild on the clone, and the page proof accepted it.
        self.assertEqual(report['migrations'], [72])
        self.assertEqual(report['problems'], [])
        self.assertGreater(report['protectedTables'], 5)
        self.assertLess(report['seconds'], rehearse_update.PAGE_BUDGET_SECONDS)
        self.assertEqual(report['config'], {'lost': [], 'changed': [],
                                            'added': sorted(set(rehearse_update.load('agent_keys', 'update_agent.py').DEFAULT_CONFIG) - {'schemaVersion', 'checkAutomatically', 'installMode', 'quietMinutes'})})
        self.assertTrue(report['removed'])
        self.assertFalse(pathlib.Path(report['folder']).exists())
        self.assertEqual(list(self.scratch.iterdir()), [])
        # The source is never written: 072 has still not run there.
        db = sqlite3.connect('file:%s?mode=ro' % before, uri=True)
        self.assertIsNone(db.execute('SELECT 1 FROM effect_sql_migrations WHERE migration_id = 72').fetchone())
        db.close()

    def test_keep_leaves_the_folder(self):
        code, report = self.rehearsal('--keep')
        self.assertEqual(code, 0, report)
        self.assertTrue(pathlib.Path(report['folder']).is_dir())
        self.assertNotIn('removed', report)

    def test_a_failing_rehearsal_still_removes_the_clone(self):
        code, report = self.rehearsal('--server-entrypoint', str(self.root / 'missing-bin.mjs'))
        self.assertEqual(code, 1, report)
        self.assertEqual(report['result'], 'failed')
        self.assertTrue(any('not verified' in problem for problem in report['problems']), report)
        self.assertTrue(report['removed'])
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_a_copy_that_cannot_be_removed_fails_the_rehearsal(self):
        real_rmtree = shutil.rmtree
        with patch.object(rehearse_update.shutil, 'rmtree', lambda *a, **k: None):
            code, report = self.rehearsal('--server-entrypoint', str(self.root / 'missing-bin.mjs'))
        self.addCleanup(real_rmtree, report['folder'], ignore_errors=True)
        self.assertEqual(code, 1, report)
        self.assertEqual(report['result'], 'failed')
        self.assertFalse(report['removed'])
        self.assertTrue(any('Could not remove the rehearsal copy' in problem for problem in report['problems']), report)

    def test_sigterm_stops_the_candidate_and_removes_the_copy(self):
        database = previous_release_state(self.source)
        child = subprocess.Popen([sys.executable, '-B', str(HERE / 'rehearse_update.py'), '--json', '--home', str(self.home),
                                  '--scratch', str(self.scratch), '--source-db', str(database),
                                  '--source-config', str(self.config), '--idle', '120'],
                                 cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        began = time.monotonic()
        log = None
        while log is None:
            self.assertIsNone(child.poll(), child.stderr.read() if child.poll() is not None else '')
            self.assertLess(time.monotonic() - began, 300, 'the candidate server never started')
            found = list(self.scratch.glob('rehearse-update-*/**/candidate-server.log'))
            log = found[0] if found else None
            time.sleep(0.2)
        folder = next(self.scratch.glob('rehearse-update-*'))
        def candidates():
            found = subprocess.run(['pgrep', '-f', str(folder)], capture_output=True, text=True).stdout.split()
            return [pid for pid in found if int(pid) != child.pid]
        while not candidates():
            self.assertLess(time.monotonic() - began, 300, 'no candidate process')
            time.sleep(0.2)
        child.send_signal(signal.SIGTERM)
        out, err = child.communicate(timeout=120)
        self.assertEqual(child.returncode, 128 + signal.SIGTERM, err)
        self.assertIn(b'stopped by signal %d' % signal.SIGTERM, err)
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(candidates(), [])

    def signalled_rehearsal(self, target, name, *signals):
        """A failing rehearsal (no candidate server) whose step `target.name` first sends this process `signals`."""
        original = getattr(target, name)
        def send_then_run(*args, **kwargs):
            for sig in signals:
                os.kill(os.getpid(), sig)
            return original(*args, **kwargs)
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        database = previous_release_state(self.source)
        err = io.StringIO()
        with patch.object(target, name, send_then_run), redirect_stdout(io.StringIO()), patch.object(sys, 'stderr', err):
            code = rehearse_update.main(['--json', '--home', str(self.home), '--scratch', str(self.scratch), '--source-db', str(database),
                                         '--source-config', str(self.config), '--idle', '3',
                                         '--server-entrypoint', str(self.root / 'missing-bin.mjs')])
        self.assertEqual({sig: signal.getsignal(sig) for sig in before}, before)  # main restores the handlers.
        return code, err.getvalue()

    def test_a_signal_during_the_removal_does_not_abort_it(self):
        # Sent from remove() itself: the only signal of the run lands inside the removal.
        code, err = self.signalled_rehearsal(rehearse_update, 'remove', signal.SIGTERM)
        self.assertEqual(code, 128 + signal.SIGTERM, err)
        self.assertIn('stopped by signal %d' % signal.SIGTERM, err)
        self.assertNotIn('LEFT AT', err)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_a_signal_inside_popen_keeps_the_candidate_handle(self):
        # The signal lands once the server runs, before its handle is stored: the server must be
        # gone before the copy is removed (an orphan would hold the copy open). Two things ensure
        # it: start()'s shield keeps the handle for stop(), and update.apply's rollback stops the
        # new server itself, so this checks the outcome, not which of them did it.
        real_popen, real_remove, seen = subprocess.Popen, rehearse_update.remove, {}
        def popen_then_signal(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            # Only the candidate server's Popen; the clone's cp and this test's ps pass through.
            if 'pid' in seen or '--no-browser' not in (args[0] if args else kwargs.get('args', ())):
                return process
            seen['pid'] = process.pid
            self.addCleanup(lambda: process.poll() is None and os.killpg(process.pid, signal.SIGKILL))
            os.kill(os.getpid(), signal.SIGTERM)
            return process
        def remove(folder, report, args):
            try:
                os.kill(seen['pid'], 0)
                seen['alive at removal'] = subprocess.run(['ps', '-o', 'stat=', '-p', str(seen['pid'])],
                                                          capture_output=True, text=True).stdout.strip()[:1] not in ('Z', '')
            except ProcessLookupError:
                seen['alive at removal'] = False
            return real_remove(folder, report, args)
        database = previous_release_state(self.source)
        err = io.StringIO()
        with patch.object(rehearse_update.subprocess, 'Popen', popen_then_signal), patch.object(rehearse_update, 'remove', remove), \
                redirect_stdout(io.StringIO()), patch.object(sys, 'stderr', err):
            code = rehearse_update.main(['--json', '--home', str(self.home), '--scratch', str(self.scratch), '--source-db', str(database),
                                         '--source-config', str(self.config), '--idle', '3'])
        self.assertEqual(code, 128 + signal.SIGTERM, err.getvalue())
        self.assertIn('pid', seen)
        self.assertFalse(seen['alive at removal'], 'the candidate server was still running when its copy was removed')
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_an_interrupt_replaced_by_another_exception_still_stops(self):
        # A rollback that raises while Interrupted unwinds must not turn the stop into a plain failure.
        def rehearse(args):
            try:
                rehearse_update.on_signal(signal.SIGTERM)
            except rehearse_update.Interrupted:
                raise KeyError('rollback failed')
        with patch.object(rehearse_update, 'rehearse', rehearse), redirect_stdout(io.StringIO()), patch.object(sys, 'stderr', io.StringIO()):
            self.assertEqual(rehearse_update.main(['--json', '--home', str(self.home)]), 128 + signal.SIGTERM)

    def test_two_signals_while_the_candidate_stops_still_remove_the_copy(self):
        # A logout: SIGHUP then SIGTERM, both inside the candidate's stop.
        code, err = self.signalled_rehearsal(rehearse_update.Candidate, '_stop', signal.SIGHUP, signal.SIGTERM)
        self.assertEqual(code, 128 + signal.SIGHUP, err)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_stop_kills_a_child_that_ignores_sigterm(self):
        # The leader exits on SIGTERM; a child in its group that ignores SIGTERM must not survive.
        own = self.root / 'own'
        own.mkdir()
        candidate = rehearse_update.Candidate(None, own, self.root, 0)
        candidate.log = open(own / 'candidate-server.log', 'w')
        candidate.process = subprocess.Popen(
            ['/bin/sh', '-c', 'trap "" TERM; (trap "" TERM; exec sleep 600) & echo $! > child.pid; trap - TERM; wait'],
            cwd=str(own), start_new_session=True)
        began = time.monotonic()
        while not (own / 'child.pid').exists() or not (own / 'child.pid').read_text().strip():
            self.assertLess(time.monotonic() - began, 10)
            time.sleep(0.05)
        child = int((own / 'child.pid').read_text())
        self.addCleanup(lambda: subprocess.run(['kill', '-9', str(child)], capture_output=True))
        candidate.stop()
        time.sleep(0.2)
        state = subprocess.run(['ps', '-o', 'stat=', '-p', str(child)], capture_output=True, text=True).stdout.strip()
        self.assertIn(state[:1], ('', 'Z'), 'the SIGTERM-ignoring child survived stop()')

    def test_a_config_key_the_new_agent_drops_fails(self):
        self.config.write_text(json.dumps({'schemaVersion': 1, 'removedSetting': True}))
        report = rehearse_update.config_check(self.config, self.root)
        self.assertEqual(report['lost'], ['removedSetting'])
        self.config.write_text(json.dumps({'schemaVersion': 1, 'quietMinutes': 5}))
        self.assertEqual(rehearse_update.config_check(self.config, self.root)['lost'], [])

    def test_refuses_to_start_without_twice_the_database_free(self):
        database = previous_release_state(self.source)
        need = 2 * database.stat().st_size
        with patch.object(rehearse_update.disk_room.kept_lines, 'available_disk', return_value=need - 1):
            code, report = self.run_main('--source-db', str(database), '--source-config', str(self.config))
        self.assertEqual(code, 2)
        self.assertEqual(report['result'], 'cannot-start')
        self.assertIn('needs %d' % need, report['error'])
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_without_a_previous_copy_it_cannot_start(self):
        code, report = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn('No previous state copy', report['error'])

    def test_the_newest_pre_update_copy_is_the_default_source(self):
        root = studio_paths.backups_root(self.home)
        for index, name in enumerate(('pre-aaa-20261101T000000Z-1', 'pre-bbb-20261103T000000Z-2')):
            (root / name).mkdir(parents=True)
            (root / name / 'statev2.sqlite').write_bytes(b'')
            os.utime(root / name / 'statev2.sqlite', (1000 + index, 1000 + index))
        self.assertEqual(rehearse_update.newest_backup(self.home).parent.name, 'pre-bbb-20261103T000000Z-2')
        self.assertIsNone(rehearse_update.newest_backup(self.root / 'nobody'))

    def test_judge_names_each_failure(self):
        good = {'phase': 'verified', 'databaseProofMode': 'stopped-clone-pages-v1'}
        self.assertEqual(rehearse_update.judge(good, {'t': [1, 'a']}, {'t': [1, 'a']}, 10, None), [])
        self.assertEqual(rehearse_update.judge(good, {'t': [1, 'a']}, {'t': [2, 'b']}, 10, None), ['protected tables changed: t'])
        self.assertIn('over the 300 s budget', rehearse_update.judge(good, {}, {}, 301, None)[0])
        self.assertEqual(rehearse_update.judge(dict(good, fullReadMigrations=[69], databaseProofMode='full-stopped-clone'), {}, {}, 1000, None), [])
        self.assertIn('databaseProofMode', rehearse_update.judge(dict(good, databaseProofMode='full-stopped-clone'), {}, {}, 1, None)[0])
        self.assertIn('not verified', rehearse_update.judge({'phase': 'restart-requested', 'error': 'x'}, {}, {}, 1, None)[0])


if __name__ == '__main__':
    unittest.main()
