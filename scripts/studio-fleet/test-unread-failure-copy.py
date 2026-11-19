#!/usr/bin/env python3
"""The newest failed install's state copy stays until someone has read it.

M4, November 18, 2026: 1.0.361 failed (`update-failed`, `held-for-safe-review`), and 1.0.374's
verified install pruned its copy, the only database that could say why the page proof refused.
Runs in temporary homes under test-update.py's ApplyRecovery harness, never production services.

Run: cd scripts/studio-fleet && python3 -B test-unread-failure-copy.py
"""
import contextlib
import datetime
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import time
import unittest
from unittest.mock import patch

import release_retention
import state_backup_prune
import studio_paths

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('unread_failure_base', HERE / 'test-update.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
DAY = 86400
READ = release_retention.FAILURE_COPY_READ_KEY


def verified(hours=1, **extra):
    at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
    return {'phase': 'verified', 'preservedRowsAuthAndIdentity': True, 'originalServicesPreserved': True,
            'onlyKnownOwnedServiceRestarted': True, 'verifiedAt': at.isoformat(), 'before': {'identity': 'm4'},
            'prunedStateBackups': [], **extra}


def m4_failure(copy):
    """The 1.0.361 receipt's retention-relevant shape (update-1.0.361-20261118T190331588596Z.json)."""
    return {'identity': 'm4', 'phase': 'restart-requested', 'stateBackup': str(copy),
            'pageFallback': 'Refused:auth-heartbeat:Protected rows or counts changed', 'result': 'update-failed',
            'rollback': 'held-for-safe-review', 'pointers': 'new-release',
            'error': 'SpillFailed: Cannot capture table orchestration_events within the memory budget: '
                     '[Errno 28] Scratch volume is below its floor',
            'rollbackError': 'AssertionError: Activated page-mode database retained: postactivation writes cannot be discarded'}


class UnreadFailureCopy(unittest.TestCase):
    def setUp(self):
        self.h = h = base.ApplyRecovery('runTest')
        h.setUp()
        self.addCleanup(h.tearDown)
        self.home, self.own = h.home, h.own
        self.root = studio_paths.backups_root(self.home)
        self.receipts = self.own / 'updates' / 'receipts'
        self.receipts.mkdir(parents=True, exist_ok=True)

    def copy(self, stamp, commit='bb58529bb0f1'):
        folder = self.root / ('pre-%s-%s-%s' % (commit, stamp, '0' * 32))
        folder.mkdir(parents=True)
        connection = sqlite3.connect(str(folder / 'statev2.sqlite'))
        connection.execute('create table t(x)')
        connection.commit()
        connection.close()
        os.utime(folder, (time.time() - 2 * DAY,) * 2)
        return folder

    def receipt(self, name, value):
        path = self.receipts / ('update-%s.json' % name)
        path.write_text(json.dumps(value))
        return path

    def m4_history(self):
        """1.0.361 failed with its copy; 1.0.374 then verified with its own."""
        failed_copy = self.copy('20261118T190338Z')
        failed = self.receipt('1.0.361-20261118T190331588596Z', m4_failure(failed_copy / 'statev2.sqlite'))
        later_copy = self.copy('20261119T045700Z', commit='0123456789ab')
        later = self.receipt('1.0.374-20261119T045629705257Z', verified(stateBackup=str(later_copy / 'statev2.sqlite')))
        return failed_copy, failed, later_copy, later

    def names(self):
        return sorted(child.name for child in self.root.iterdir())

    def test_a_later_verified_install_keeps_the_unread_copy(self):
        failed_copy, failed, later_copy, later = self.m4_history()
        held, finished = release_retention.state_backup_references(self.home)
        self.assertIn(failed_copy.name, held)
        self.assertNotIn(failed_copy.name, finished)
        self.assertEqual(release_retention.held_state_backups(self.own), [str(failed_copy / 'statev2.sqlite')])
        # The after-install prune of the later verified update.
        self.assertEqual(state_backup_prune.after_install('m4', self.home, later), [])
        self.assertEqual(self.names(), sorted([failed_copy.name, later_copy.name]))
        # The pre-copy prune of the next update with nothing else kept, and no hour wait.
        self.assertEqual(release_retention.prune_state_backups(
            self.home, keep=release_retention.held_state_backups(self.own), keep_newest=0, verified_install=True),
            [later_copy.name])
        self.assertEqual(self.names(), [failed_copy.name])

    def test_once_read_the_copy_goes_with_the_next_prune(self):
        failed_copy, failed, later_copy, later = self.m4_history()
        stamp = state_backup_prune.mark_read(self.home, failed, now='2026-11-19T07:00:00+00:00')
        self.assertEqual(stamp, '2026-11-19T07:00:00+00:00')
        self.assertEqual(json.loads(failed.read_text())[READ], stamp)
        self.assertEqual(release_retention.held_state_backups(self.own), [])
        self.assertEqual(state_backup_prune.after_install('m4', self.home, later), [failed_copy.name])
        self.assertEqual(self.names(), [later_copy.name])

    def test_mark_read_keeps_the_first_stamp_and_everything_else(self):
        _, failed, _, _ = self.m4_history()
        before = json.loads(failed.read_text())
        first = state_backup_prune.mark_read(self.home, failed, now='2026-11-19T07:00:00+00:00')
        self.assertEqual(state_backup_prune.mark_read(self.home, failed, now='2026-11-20T07:00:00+00:00'), first)
        self.assertEqual(json.loads(failed.read_text()), {**before, READ: first})

    def test_only_the_newest_failure_is_kept(self):
        older_copy = self.copy('20261101T000000Z')
        self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        failed_copy, failed, later_copy, later = self.m4_history()
        self.assertEqual(state_backup_prune.after_install('m4', self.home, later), [older_copy.name])
        self.assertEqual(self.names(), sorted([failed_copy.name, later_copy.name]))

    def test_a_read_newest_failure_does_not_bring_back_an_older_one(self):
        older_copy = self.copy('20261101T000000Z')
        self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        failed_copy, failed, later_copy, later = self.m4_history()
        state_backup_prune.mark_read(self.home, failed)
        self.assertEqual(sorted(state_backup_prune.after_install('m4', self.home, later)),
                         sorted([older_copy.name, failed_copy.name]))

    def test_pruning_the_read_receipt_does_not_bring_back_an_older_failure(self):
        """Review round 1: A failed and held its copy, B failed later, rolled back and was read; receipt
        pruning then removed B's finished receipt. A must not become the newest unread failure."""
        older_copy = self.copy('20261101T000000Z')
        older = self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        failed_copy, failed, later_copy, later = self.m4_history()
        value = dict(json.loads(failed.read_text()), rollback='restored-old-release', pointers='previous-release')
        value.pop('rollbackError')
        failed.write_text(json.dumps(value))
        state_backup_prune.mark_read(self.home, failed)
        self.assertNotIn(READ, json.loads(older.read_text()))  # The watermark covers it, not its receipt.
        for index in range(11):
            self.receipt('1.0.%d-20261119T0500%02dZ' % (375 + index, index), {
                'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed', 'pointers': 'unchanged',
                'error': 'AssertionError: Guarded prestate changed: rows'})
        for path in self.receipts.iterdir():
            os.utime(path, (time.time() - 2 * DAY,) * 2)
        removed = release_retention.prune_update_receipts(self.own, keep=[later])
        self.assertIn(failed.name, removed['receipts'])
        self.assertTrue(older.is_file())
        self.assertIsNone(release_retention.unread_failure_receipt(
            [(path, json.loads(path.read_text())) for path in self.receipts.glob('update-*.json')],
            release_retention.failure_read_through(self.own)))
        self.assertIn(older_copy.name, state_backup_prune.after_install('m4', self.home, later))
        self.assertFalse(older_copy.exists())

    def age_past_the_receipt_window(self, after):
        """Eleven newer no-copy refusals and two days of age: a finished receipt then goes by rank."""
        for index in range(11):
            self.receipt('1.0.%d-20261119T0600%02dZ' % (390 + index, index), {
                'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed', 'pointers': 'unchanged',
                'error': 'AssertionError: Guarded prestate changed: rows'})
        for path in self.receipts.iterdir():
            os.utime(path, (time.time() - 2 * DAY,) * 2)

    def restored(self, receipt):
        value = dict(json.loads(receipt.read_text()), rollback='restored-old-release', pointers='previous-release')
        value.pop('rollbackError')
        receipt.write_text(json.dumps(value))

    @contextlib.contextmanager
    def unreadable(self, path):
        path.chmod(0)
        try:
            with self.assertRaises(PermissionError):
                path.read_text()
            yield
        finally:
            path.chmod(0o600)

    def test_an_unreadable_receipt_keeps_the_unread_failure_receipt(self):
        """Review round 2, finding 1: an unrelated unreadable receipt must not let the unread failure's
        receipt go, or the next state prune removes its copy unread."""
        unrelated = self.receipt('1.0.200-20261001T000000Z', verified(hours=900))
        failed_copy, failed, later_copy, later = self.m4_history()
        self.restored(failed)  # Finished: receipt pruning could take it by rank.
        self.age_past_the_receipt_window(later)
        with self.unreadable(unrelated):
            removed = release_retention.prune_update_receipts(self.own, keep=[later])
        self.assertNotIn(failed.name, removed['receipts'])
        self.assertTrue(removed['receipts'])  # Pruning still runs for the rest.
        self.assertTrue(failed.is_file())
        self.assertNotIn(failed.name, release_retention.prune_update_receipts(self.own, keep=[later])['receipts'])
        self.assertNotIn(failed_copy.name, state_backup_prune.after_install('m4', self.home, later))
        self.assertTrue(failed_copy.is_dir())

    def test_an_unreadable_newest_failure_receipt_is_not_aged_out(self):
        """Review round 3, finding 1: the unread failure's own receipt unreadable while receipts age."""
        failed_copy, failed, later_copy, later = self.m4_history()
        self.restored(failed)
        self.age_past_the_receipt_window(later)
        for path in self.receipts.iterdir():
            os.utime(path, (time.time() - 10 * DAY,) * 2)
        with self.unreadable(failed):
            removed = release_retention.prune_update_receipts(self.own, keep=[later])
        self.assertNotIn(failed.name, removed['receipts'])
        self.assertTrue(failed.is_file())
        self.assertNotIn(failed_copy.name, state_backup_prune.after_install('m4', self.home, later))
        self.assertTrue(failed_copy.is_dir())

    def test_a_non_object_receipt_is_not_aged_out(self):
        """Review round 4: valid JSON that is not an object is as unclassifiable as unreadable JSON."""
        for content in ('[]', 'null', 'true', '"unavailable"', '42'):
            with self.subTest(content=content):
                self.tearDown_home()
                failed_copy, failed, later_copy, later = self.m4_history()
                self.age_past_the_receipt_window(later)
                failed.write_text(content)
                for path in self.receipts.iterdir():
                    os.utime(path, (time.time() - 10 * DAY,) * 2)
                removed = release_retention.prune_update_receipts(self.own, keep=[later])
                self.assertNotIn(failed.name, removed['receipts'])
                self.assertIsNone(state_backup_prune.after_install('m4', self.home, later) or None)
                self.assertTrue(failed.is_file() and failed_copy.is_dir())

    def tearDown_home(self):
        """A fresh receipts folder and backups root for the next subtest."""
        import shutil
        for folder in (self.receipts, self.root):
            if folder.exists():
                shutil.rmtree(folder)
        self.receipts.mkdir(parents=True)
        watermark = self.own / 'updates' / release_retention.FAILURE_READ_FILE
        if watermark.exists():
            watermark.unlink()

    def test_an_unreadable_watermark_is_never_lowered(self):
        """Review round 3, finding 2: marking an older failure read while the watermark is unreadable."""
        older_copy = self.copy('20261101T000000Z')
        older = self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        _, failed, _, _ = self.m4_history()
        state_backup_prune.mark_read(self.home, failed)
        watermark = self.own / 'updates' / release_retention.FAILURE_READ_FILE
        before = watermark.read_bytes()
        with self.unreadable(watermark), self.assertRaisesRegex(AssertionError, 'Read watermark cannot be read'):
            state_backup_prune.mark_read(self.home, older)
        self.assertEqual(watermark.read_bytes(), before)
        self.assertNotIn(READ, json.loads(older.read_text()))
        self.assertEqual(release_retention.failure_read_through(self.own), '20261118190331588596')

    def test_an_unreadable_older_receipt_cannot_skip_the_read_mark(self):
        """Review round 2, finding 2: the watermark is one file, so an older receipt unreadable while
        B is marked read is still covered once it is readable again and B's receipt is gone."""
        older_copy = self.copy('20261101T000000Z')
        older = self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        failed_copy, failed, later_copy, later = self.m4_history()
        self.restored(failed)
        with self.unreadable(older):
            state_backup_prune.mark_read(self.home, failed)
        self.age_past_the_receipt_window(later)
        self.assertIn(failed.name, release_retention.prune_update_receipts(self.own, keep=[later])['receipts'])
        self.assertIn(older_copy.name, state_backup_prune.after_install('m4', self.home, later))

    def test_a_failed_receipt_write_still_leaves_the_copy_read(self):
        failed_copy, failed, later_copy, later = self.m4_history()
        real = state_backup_prune._write_receipt

        def write(path, value):
            if path == failed:
                raise OSError(28, 'No space left on device')
            real(path, value)
        with patch.object(state_backup_prune, '_write_receipt', side_effect=write), self.assertRaises(OSError):
            state_backup_prune.mark_read(self.home, failed)
        self.assertNotIn(READ, json.loads(failed.read_text()))
        self.assertEqual(state_backup_prune.after_install('m4', self.home, later), [failed_copy.name])

    def test_an_older_receipt_written_after_the_mark_stays_read(self):
        failed_copy, failed, later_copy, later = self.m4_history()
        state_backup_prune.mark_read(self.home, failed)
        failed.unlink()
        late_copy = self.copy('20261110T000000Z')
        self.receipt('1.0.350-20261110T000000Z', m4_failure(late_copy / 'statev2.sqlite'))
        self.assertIn(late_copy.name, state_backup_prune.after_install('m4', self.home, later))

    def test_the_watermark_only_moves_forward(self):
        older_copy = self.copy('20261101T000000Z')
        older = self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        _, failed, _, _ = self.m4_history()
        state_backup_prune.mark_read(self.home, failed)
        state_backup_prune.mark_read(self.home, older)
        self.assertEqual(release_retention.failure_read_through(self.own), '20261118190331588596')

    def test_an_unreadable_watermark_keeps_the_copy(self):
        failed_copy, failed, later_copy, later = self.m4_history()
        state_backup_prune.mark_read(self.home, failed)
        failed.write_text(json.dumps({k: v for k, v in json.loads(failed.read_text()).items() if k != READ}))
        (self.own / 'updates' / release_retention.FAILURE_READ_FILE).write_text('{not json')
        self.assertEqual(state_backup_prune.after_install('m4', self.home, later), [])

    def test_marking_an_older_receipt_leaves_newer_ones_unread(self):
        older_copy = self.copy('20261101T000000Z')
        older = self.receipt('1.0.300-20261101T000000Z', m4_failure(older_copy / 'statev2.sqlite'))
        _, failed, _, _ = self.m4_history()
        state_backup_prune.mark_read(self.home, older)
        self.assertNotIn(READ, json.loads(failed.read_text()))

    def test_a_clean_rollback_counts_as_a_failure(self):
        copy = self.copy('20261118T190338Z')
        value = dict(m4_failure(copy / 'statev2.sqlite'), rollback='restored-old-release', pointers='previous-release')
        value.pop('rollbackError')
        failed = self.receipt('1.0.361-20261118T190331588596Z', value)
        self.assertEqual(release_retention.unread_failure_receipt([(failed, value)]), failed)

    def test_verified_and_refusal_receipts_are_not_failures(self):
        copy = self.copy('20261118T190338Z')
        for value in (verified(stateBackup=str(copy / 'statev2.sqlite')),
                      {'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed', 'pointers': 'unchanged',
                       'error': 'AssertionError: Guarded prestate changed: rows'}):
            with self.subTest(value=value.get('phase')):
                self.assertFalse(release_retention.failed_install(value))

    def test_the_unread_receipt_is_not_aged_out_while_its_copy_exists(self):
        copy = self.copy('20261018T000000Z')
        value = dict(m4_failure(copy / 'statev2.sqlite'), rollback='restored-old-release', pointers='previous-release')
        value.pop('rollbackError')  # A finished receipt: it would otherwise age out after a week.
        failed = self.receipt('1.0.300-20261018T000000123456Z', value)
        for index in range(12):
            self.receipt('1.0.%d-202610%02dT000000123456Z' % (301 + index, 19 + index // 2), verified(hours=200))
        for path in self.receipts.iterdir():
            os.utime(path, (time.time() - 30 * DAY,) * 2)
        removed = release_retention.prune_update_receipts(self.own)
        self.assertNotIn(failed.name, removed['receipts'])
        self.assertTrue(failed.is_file())
        state_backup_prune.mark_read(self.home, failed)
        os.utime(failed, (time.time() - 30 * DAY,) * 2)
        self.assertIn(failed.name, release_retention.prune_update_receipts(self.own)['receipts'])

    def test_mark_read_refuses_a_receipt_it_must_not_touch(self):
        refusal = self.receipt('1.0.344-20261118T034729987466Z', {
            'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed', 'pointers': 'unchanged',
            'error': 'AssertionError: Guarded prestate changed: rows'})
        text = refusal.read_text()
        with self.assertRaisesRegex(AssertionError, 'Not a failed install that names a state copy'):
            state_backup_prune.mark_read(self.home, refusal)
        self.assertEqual(refusal.read_text(), text)  # 1414's refusal_proof reads exactly its keys.
        elsewhere = self.home / 'update-1.0.361-20261118T190331588596Z.json'
        elsewhere.write_text(json.dumps(m4_failure(self.copy('20261118T190338Z') / 'statev2.sqlite')))
        with self.assertRaisesRegex(AssertionError, 'Not an update receipt of this home'):
            state_backup_prune.mark_read(self.home, elsewhere)
        with self.assertRaisesRegex(AssertionError, 'Receipt not found'):
            state_backup_prune.mark_read(self.home, self.receipts / 'update-missing.json')
        unstamped = self.receipt('hand-run', m4_failure(self.copy('20261118T200000Z') / 'statev2.sqlite'))
        with self.assertRaisesRegex(AssertionError, 'no start time'):
            state_backup_prune.mark_read(self.home, unstamped)
        self.assertFalse((self.own / 'updates' / release_retention.FAILURE_READ_FILE).exists())

    def test_the_command_stamps_the_receipt(self):
        _, failed, _, _ = self.m4_history()
        output = io.StringIO()
        with patch.object(pathlib.Path, 'home', return_value=self.home), contextlib.redirect_stdout(output):
            state_backup_prune.main(['--mark-read', str(failed)])
        printed = json.loads(output.getvalue())
        self.assertEqual(printed[READ], json.loads(failed.read_text())[READ])


if __name__ == '__main__':
    unittest.main()
