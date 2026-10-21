#!/usr/bin/env python3
"""install_progress: whole records under concurrent readers, a heartbeat that moves while a phase
blocks, the result an apply ends with (verified, refused, rolled back, crashed) and expectedMs
from the newest earlier receipt."""
import importlib.util
import json
import os
import pathlib
import tempfile
import threading
import time
import unittest

import install_progress

HERE = pathlib.Path(__file__).resolve().parent


def harness():
    """test-update.py's ApplyRecovery harness (its file name is not importable)."""
    spec = importlib.util.spec_from_file_location('studio_test_update', HERE / 'test-update.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProgressFile(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='studio-install-progress-')
        self.addCleanup(folder.cleanup)
        self.updates = pathlib.Path(folder.name) / 'updates'
        self.receipts = self.updates / 'receipts'

    def read(self):
        return json.loads((self.updates / install_progress.FILE).read_text())

    def test_the_record_has_the_schema_fields_and_is_private(self):
        with install_progress.ProgressWriter(self.updates, version='0.2.0', receipt=self.receipts / 'r.json') as progress:
            progress.lap('beforeRead', {'beforeRead': 12})
            value = self.read()
        self.assertEqual(set(value), {'schemaVersion', 'version', 'receipt', 'phase', 'step', 'steps', 'phaseStartedAt',
                                      'heartbeatAt', 'expectedMs', 'timings', 'serviceRestartedAt', 'result'})
        self.assertEqual((value['schemaVersion'], value['version'], value['phase'], value['step'], value['steps']),
                         (1, '0.2.0', 'backupSpace', 2, len(install_progress.PHASES)))
        self.assertEqual(value['timings'], {'beforeRead': 12})
        self.assertEqual(os.stat(self.updates / install_progress.FILE).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.updates).st_mode & 0o777, 0o700)
        self.assertEqual([path.name for path in self.updates.iterdir() if path.name.startswith('.')], [])

    def test_concurrent_readers_never_see_a_torn_record(self):
        progress = install_progress.ProgressWriter(self.updates, heartbeat_seconds=0.001).start()
        self.addCleanup(progress.stop)
        stop, torn, reads = threading.Event(), [], [0]

        def reader():
            while not stop.is_set():
                try:
                    text = (self.updates / install_progress.FILE).read_text()
                except FileNotFoundError:
                    torn.append('missing')
                    continue
                try:
                    json.loads(text)
                    reads[0] += 1
                except ValueError:
                    torn.append(text)

        readers = [threading.Thread(target=reader) for _ in range(4)]
        for thread in readers:
            thread.start()
        timings = {}
        for index in range(400):
            phase = install_progress.PHASES[index % len(install_progress.PHASES)]
            timings[phase] = index
            progress.lap(phase, timings)
        stop.set()
        for thread in readers:
            thread.join()
        self.assertEqual(torn, [])
        self.assertGreater(reads[0], 100)

    def test_the_heartbeat_moves_while_a_phase_blocks(self):
        with install_progress.ProgressWriter(self.updates, heartbeat_seconds=0.05) as progress:
            first = self.read()
            time.sleep(0.3)  # One long phase: no lap, only heartbeats.
            later = self.read()
        self.assertEqual((first['phase'], first['phaseStartedAt']), (later['phase'], later['phaseStartedAt']))
        self.assertGreater(later['heartbeatAt'], first['heartbeatAt'])
        self.assertEqual(install_progress.HEARTBEAT_SECONDS, 5)

    def test_a_finished_record_stays_finished(self):
        with install_progress.ProgressWriter(self.updates, heartbeat_seconds=0.02) as progress:
            progress.finish('verified', {'total': 9})
            progress.lap('readiness', {'total': 10})
            progress.set(version='other')
            first = self.read()
            time.sleep(0.1)  # The heartbeat stopped with the finish.
            self.assertEqual(self.read(), first)
        self.assertEqual((first['result'], first['timings'], first['version']), ('verified', {'total': 9}, None))
        with self.assertRaises(AssertionError):
            install_progress.ProgressWriter(self.updates).finish('done')

    def test_an_exception_before_any_pointer_moved_is_a_refusal(self):
        with self.assertRaises(AssertionError):
            with install_progress.ProgressWriter(self.updates):
                raise AssertionError('Guarded prestate changed: rows')
        self.assertEqual(self.read()['result'], 'refused')

    def test_a_crash_after_the_pointers_moved_is_a_failure(self):
        with self.assertRaises(RuntimeError):
            with install_progress.ProgressWriter(self.updates) as progress:
                progress.lap('swapPointers', {})
                raise RuntimeError('killed')
        self.assertEqual(self.read()['result'], 'failed')

    def test_failure_receipts_map_to_results(self):
        self.assertEqual(install_progress.result_of({'rollback': 'restored-runtime-pointers-and-state'}), 'rolled-back')
        for phase in ('prepared', 'pointers-written'):
            self.assertEqual(install_progress.result_of({'rollback': 'restored-exact-owned-runtime-pointers', 'phase': phase}), 'refused')
        self.assertEqual(install_progress.result_of({'rollback': 'restored-exact-owned-runtime-pointers', 'phase': 'restart-requested'}),
                         'rolled-back')
        self.assertEqual(install_progress.result_of({'rollback': 'held: state changed'}), 'held')
        # Stopped for the copy, then the stop, copy or start failed: the old release was started again.
        self.assertEqual(install_progress.result_of({'rollback': 'restored-exact-owned-runtime-pointers',
                                                     'phase': 'pointers-written', 'serviceStopped': True}), 'rolled-back')

    def test_a_rollback_shows_while_it_runs(self):
        with install_progress.ProgressWriter(self.updates) as progress:
            progress.lap('readinessCheap', {'readinessCheap': 1})
            progress.rollback()
            self.assertEqual((self.read()['phase'], self.read()['result']), ('rollback', None))
            progress.finish('rolled-back')
        self.assertEqual((self.read()['phase'], self.read()['result']), ('rollback', 'rolled-back'))

    def test_a_crash_during_the_rollback_is_a_failure(self):
        with self.assertRaises(RuntimeError):
            with install_progress.ProgressWriter(self.updates) as progress:
                progress.rollback()
                raise RuntimeError('killed')
        self.assertEqual(self.read()['result'], 'failed')

    def test_a_write_that_fails_never_raises(self):
        self.updates.parent.mkdir(exist_ok=True)
        self.updates.write_text('not a folder')
        with install_progress.ProgressWriter(self.updates) as progress:
            progress.lap('beforeRead', {})
        self.assertGreater(progress.errors, 0)

    def test_expected_ms_is_the_newest_earlier_verified_total(self):
        self.receipts.mkdir(parents=True)
        # A refusal, a rollback and the agent's prestate copy took other times than an install.
        for name, receipt, age in (('update-old.json', {'phase': 'verified', 'timings': {'total': 900000}}, 300),
                                   ('update-newer.json', {'phase': 'verified', 'timings': {'total': 810000}}, 200),
                                   ('update-no-timings.json', {'phase': 'verified'}, 150),
                                   ('update-refused.json', {'phase': 'pointers-written', 'result': 'update-failed',
                                                            'timings': {'total': 45000}}, 120),
                                   ('update-rolled-back.json', {'phase': 'restart-requested', 'result': 'update-failed',
                                                                'timings': {'total': 400000}}, 110),
                                   ('prestate-newest.json', {'phase': 'verified', 'timings': {'total': 7}}, 100)):
            path = self.receipts / name
            path.write_text(json.dumps(receipt))
            os.utime(path, (time.time() - age, time.time() - age))
        current = self.receipts / 'update-current.json'
        current.write_text(json.dumps({'timings': {'total': 1}}))
        self.assertEqual(install_progress.expected_ms(self.receipts, current), 810000)
        with install_progress.ProgressWriter(self.updates, receipt=current):
            self.assertEqual(self.read()['expectedMs'], 810000)
        self.assertIsNone(install_progress.expected_ms(self.updates / 'absent'))


class ApplyWritesProgress(unittest.TestCase):
    """update.apply through the ApplyRecovery harness: the file it leaves for each outcome."""

    def run_case(self, configure=None, fails=False):
        module = harness()
        case = module.ApplyRecovery('runTest')
        case.setUp()
        self.addCleanup(case.tearDown)
        if configure:
            configure(case)
        if fails:
            with self.assertRaises(Exception):
                case.execute()
        else:
            case.execute()
        return json.loads((case.own / 'updates' / install_progress.FILE).read_text())

    def test_a_verified_apply_ends_verified_with_its_laps(self):
        value = self.run_case()
        self.assertEqual(value['result'], 'verified')
        self.assertIsNotNone(value['serviceRestartedAt'])
        for lap in ('serviceStop', 'backupClone', 'restart', 'readinessCheap', 'readiness'):
            self.assertIn(lap, value['timings'])

    def test_a_restart_that_fails_ends_rolled_back(self):
        value = self.run_case(lambda case: setattr(case, 'scenario', 'restart-failed'), fails=True)
        self.assertEqual(value['result'], 'rolled-back')

    def test_a_copy_that_fails_after_the_stop_ends_rolled_back(self):
        # The old service was stopped for the copy and started again: not a refusal.
        cases = []
        def configure(case):
            cases.append(case)
            case.failing_copy(OSError(28, 'No space left on device'))
        value = self.run_case(configure, fails=True)
        self.assertEqual((value['phase'], value['result']), ('rollback', 'rolled-back'))
        receipt = json.loads(cases[0].output.read_text())
        self.assertEqual((receipt['phase'], receipt['serviceStopped']), ('pointers-written', True))

    def test_a_refusal_before_the_stop_ends_refused(self):
        cases = []
        def configure(case):
            cases.append(case)
            case.scenario = 'pre-restart-child'
        value = self.run_case(configure, fails=True)
        self.assertEqual(value['result'], 'refused')
        self.assertNotIn('serviceStopped', json.loads(cases[0].output.read_text()))

    def test_the_rollback_shows_while_it_runs(self):
        seen = []
        def configure(case):
            restore = case.restore_state
            def restore_state(backup, own):
                seen.append(json.loads((case.own / 'updates' / install_progress.FILE).read_text()))
                restore(backup, own)
            case.restore_state = restore_state
            case.after_mutation = lambda after: after.update(archiveSha256='another-owned-release')
        value = self.run_case(configure, fails=True)
        self.assertEqual([(record['phase'], record['result']) for record in seen], [('rollback', None)])
        self.assertEqual(value['result'], 'rolled-back')


if __name__ == '__main__':
    unittest.main()
