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

    def test_the_command_stamps_the_receipt(self):
        _, failed, _, _ = self.m4_history()
        output = io.StringIO()
        with patch.object(pathlib.Path, 'home', return_value=self.home), contextlib.redirect_stdout(output):
            state_backup_prune.main(['--mark-read', str(failed)])
        printed = json.loads(output.getvalue())
        self.assertEqual(printed[READ], json.loads(failed.read_text())[READ])


if __name__ == '__main__':
    unittest.main()
