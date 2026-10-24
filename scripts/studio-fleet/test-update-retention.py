#!/usr/bin/env python3
"""release_retention.prune_update_leftovers: what a verified update removes that no other step
does. install/incoming staging folders a killed helper left and release bundles older than the
installed release; update receipts and owned-updates folders of finished updates beyond the
newest few, never a held or unfinished one, nor one the agent's state, run or marker names.

Run: cd scripts/studio-fleet && python3 -B test-update-retention.py
Temporary homes only.
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
import uuid
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_retention  # noqa: E402
import studio_paths  # noqa: E402

DAY = 86400


def age(path, seconds):
    moment = time.time() - seconds
    os.utime(str(path), (moment, moment), follow_symlinks=False)


class Home(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = pathlib.Path(folder.name).resolve()
        self.own = studio_paths.identity_home(self.home, 'm4')
        self.receipts = self.own / 'updates' / 'receipts'
        self.receipts.mkdir(parents=True)
        self.incoming = studio_paths.incoming_root(self.home)
        self.incoming.mkdir(parents=True)

    def attempt(self, day, receipt=None, backup=True, seconds=DAY, log=True):
        """One agent apply: prestate-, update- and its .log, plus the owned-updates folder it names.
        Returns (stem, folder or None)."""
        stem = '1.0.%d-202610%02dT120000123456Z' % (day, day)
        folder = None
        if backup:
            folder = self.own / 'owned-updates' / str(uuid.uuid4())
            folder.mkdir(parents=True)
            (folder / 'prestate.json').write_text('{}')
        value = dict({'phase': 'verified'} if receipt is None else receipt)
        if folder is not None:
            value['backup'] = str(folder)
        files = [self.receipts / ('update-%s.json' % stem), self.receipts / ('prestate-%s.json' % stem)]
        files[0].write_text(json.dumps(value))
        files[1].write_text('{}')
        if log:
            files.append(self.receipts / ('update-%s.log' % stem))
            files[-1].write_text('helper output')
        for path in files + ([folder] if folder else []):
            age(path, seconds + (40 - day) * 60)  # Newer days are newer files too.
        return stem, folder

    def left(self):
        return sorted(path.name for path in self.receipts.iterdir())

    def owned(self):
        root = self.own / 'owned-updates'
        return sorted(path.name for path in root.iterdir()) if root.is_dir() else []


class Receipts(Home):
    def test_keeps_the_newest_held_unfinished_named_and_current_and_removes_old_finished_ones(self):
        old = [self.attempt(day) for day in range(1, 6)]  # Finished, beyond the newest few: removed.
        refused = self.attempt(6, {'phase': 'preflight', 'result': 'update-failed', 'pointers': 'unchanged'}, backup=False)
        rolled = self.attempt(7, {'phase': 'restart-requested', 'rollback': 'restored-runtime-pointers-and-state'})
        held = self.attempt(8, {'phase': 'restart-requested', 'rollback': 'held-for-safe-review',
                                'stateBackup': str(self.home / '.specwithcode/backups/pre-x/statev2.sqlite')})
        broken = self.attempt(9, {'phase': 'restart-requested', 'rollback': 'restored-exact-owned-runtime-pointers',
                                  'rollbackError': 'AssertionError: launchd'})
        died = self.attempt(10, {'phase': 'pointers-written', 'result': 'update-failed'})  # Helper killed, pointers moved.
        unreadable = self.attempt(11)
        (self.receipts / ('update-%s.json' % unreadable[0])).write_text('{not json')
        named = self.attempt(12)
        running = self.attempt(13)  # The run.json's receipt.
        current = self.attempt(14)  # This helper's own output.
        newest = [self.attempt(day) for day in range(15, 18)]
        fresh = self.attempt(18, seconds=60)  # Another pass may still write it.
        (self.own / 'updates' / 'state.json').write_text(json.dumps(
            {'lastInstall': {'receipt': str(self.receipts / ('update-%s.json' % named[0]))}}))
        (self.own / 'updates' / 'run.json').write_text(json.dumps(
            {'receipt': str(self.receipts / ('update-%s.json' % running[0]))}))
        records = []
        for kind in ('reap', 'idle-agents', 'database-restart'):
            for day in range(1, 5):
                path = self.receipts / ('%s-202610%02dT120000Z-%08x.json' % (kind, day, day))
                path.write_text('{}')
                age(path, DAY + (40 - day) * 60)
                records.append(path.name)
        (self.receipts / 'notes.md').write_text('mine')
        age(self.receipts / 'notes.md', 30 * DAY)

        removed = release_retention.prune_update_receipts(
            self.own, keep=[self.receipts / ('update-%s.json' % current[0])], keep_newest=4)

        gone = old + [refused, rolled]
        self.assertEqual(removed['ownedUpdates'], sorted(folder.name for _, folder in gone if folder))
        expected_gone = sorted(name for stem, _ in gone for name in
                               ('update-%s.json' % stem, 'prestate-%s.json' % stem, 'update-%s.log' % stem))
        self.assertEqual(removed['receipts'], sorted(expected_gone))
        kept = [held, broken, died, unreadable, named, running, current] + newest + [fresh]
        self.assertEqual(self.owned(), sorted(folder.name for _, folder in kept))
        left = self.left()
        for stem, _ in kept:
            self.assertIn('update-%s.json' % stem, left)
            self.assertIn('prestate-%s.json' % stem, left)
        self.assertIn('notes.md', left)
        # The newest four records of each kind stay; there are four, so none of them goes.
        self.assertEqual([name for name in records if name not in left], [])

    def test_records_beyond_the_newest_go_per_kind(self):
        for day in range(1, 5):
            path = self.receipts / ('reap-202610%02dT120000Z-%08x.json' % (day, day))
            path.write_text('{}')
            path.with_suffix('.log').write_text('log')
            age(path, DAY + (40 - day) * 60)
            age(path.with_suffix('.log'), DAY + (40 - day) * 60)
        removed = release_retention.prune_update_receipts(self.own, keep_newest=2)
        self.assertEqual(removed['receipts'], ['reap-20261001T120000Z-00000001.json', 'reap-20261001T120000Z-00000001.log',
                                               'reap-20261002T120000Z-00000002.json', 'reap-20261002T120000Z-00000002.log'])

    def test_a_backup_outside_owned_updates_is_never_removed(self):
        outside = self.home / 'elsewhere' / str(uuid.uuid4())
        outside.mkdir(parents=True)
        stem, _ = self.attempt(1, {'phase': 'verified', 'backup': str(outside)}, backup=False)
        removed = release_retention.prune_update_receipts(self.own, keep_newest=0)
        self.assertEqual(removed['ownedUpdates'], [])
        self.assertIn('update-%s.json' % stem, removed['receipts'])
        self.assertTrue(outside.is_dir())

    def test_symlinked_receipts_or_owned_updates_are_never_followed(self):
        stem, folder = self.attempt(1)
        outside = self.home / 'outside'
        self.receipts.rename(outside)
        self.receipts.symlink_to(outside)
        self.assertEqual(release_retention.prune_update_receipts(self.own, keep_newest=0),
                         {'receipts': [], 'ownedUpdates': []})
        self.assertTrue((outside / ('update-%s.json' % stem)).is_file())
        self.receipts.unlink()
        outside.rename(self.receipts)
        (self.receipts / 'update-1.0.2-20261002T120000Z.json').symlink_to(self.receipts / ('update-%s.json' % stem))
        owned_root = self.own / 'owned-updates'
        owned_root.rename(self.home / 'owned-elsewhere')
        owned_root.symlink_to(self.home / 'owned-elsewhere')
        removed = release_retention.prune_update_receipts(self.own, keep_newest=0)
        self.assertEqual(removed['ownedUpdates'], [])  # Through a link: the folder stays, so does its receipt.
        self.assertEqual(removed['receipts'], [])
        self.assertTrue((self.home / 'owned-elsewhere' / folder.name).is_dir())
        self.assertTrue((self.receipts / 'update-1.0.2-20261002T120000Z.json').is_symlink())


class Incoming(Home):
    def entry(self, name, directory=True, seconds=DAY):
        path = self.incoming / name
        if directory:
            path.mkdir()
            (path / 'bin.mjs').write_text('x')
        else:
            path.write_bytes(b'gz')
        age(path, seconds)
        return name

    def test_removes_stage_leftovers_and_older_bundles_only(self):
        sha = 'abcdef123456'
        gone = [self.entry('owned-update-stage-k2j4_x9q'),
                self.entry('studio-1.0.60-%s' % sha), self.entry('studio-1.0.60-%s.tar.gz' % sha, directory=False),
                self.entry('studio-1.0.60-deployment-helpers-%s.tar.gz' % sha, directory=False),
                self.entry('studio-1.0.73-linux-x64-%s.tar.gz.receipt.json' % sha, directory=False)]
        kept = [self.entry('owned-update-stage-fresh123', seconds=60),  # A helper staging now.
                self.entry('owned-update-stage-file', directory=False),
                self.entry('studio-1.0.74-%s' % sha),  # The release just installed.
                self.entry('studio-1.0.74-rc.1-%s.tar.gz' % sha, directory=False),
                self.entry('studio-1.0.75-%s.tar.gz' % sha, directory=False),
                self.entry('t04-b9827593'),  # Hand-staged research: not the updater's.
                self.entry('studio-1.0.60.tar.gz', directory=False)]
        (self.incoming / ('studio-1.0.50-%s' % sha)).symlink_to(self.home)
        kept.append('studio-1.0.50-%s' % sha)
        self.assertEqual(release_retention.prune_incoming(self.home, '1.0.74'), sorted(gone))
        self.assertEqual(sorted(path.name for path in self.incoming.iterdir()), sorted(kept))
        self.assertTrue(self.home.is_dir())

    def test_a_symlinked_incoming_or_an_unknown_version_removes_nothing(self):
        self.entry('owned-update-stage-k2j4_x9q')
        self.assertEqual(release_retention.prune_incoming(self.home, 'unknown'), [])
        outside = self.home / 'outside'
        self.incoming.rename(outside)
        self.incoming.symlink_to(outside)
        self.assertEqual(release_retention.prune_incoming(self.home, '1.0.74'), [])
        self.assertTrue((outside / 'owned-update-stage-k2j4_x9q').is_dir())


class AfterAVerifiedUpdate(Home):
    def test_a_failing_step_is_reported_and_never_raised(self):
        self.attempt(1)
        with mock.patch.object(release_retention, 'prune_incoming', side_effect=PermissionError('x')):
            result = release_retention.prune_update_leftovers(self.home, self.own, '1.0.74')
        self.assertEqual(result['incomingError'], 'PermissionError')
        self.assertEqual(result['receipts'], {'receipts': [], 'ownedUpdates': []})  # Within the newest ten.



def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class AVerifiedApply(unittest.TestCase):
    """update.py's own verified apply (test-update.py's ApplyRecovery harness) prunes, reports it in
    the receipt, and keeps this update's receipt and owned-updates folder however old they look."""
    attempt, entry = Home.attempt, Incoming.entry

    def test_a_verified_apply_reports_what_it_pruned_and_keeps_its_own_receipt_and_folder(self):
        updater = load('retention_update_base', 'test-update.py')
        fixture = updater.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        self.home, self.own = fixture.home, fixture.own
        self.receipts = self.own / 'updates' / 'receipts'
        self.receipts.mkdir(parents=True)
        self.incoming = studio_paths.incoming_root(self.home)
        self.incoming.mkdir(parents=True)
        # The oldest of 11 finished attempts goes, and so does a killed helper's stage folder.
        oldest, oldest_folder = [self.attempt(day) for day in range(1, 12)][0]
        stage = self.entry('owned-update-stage-k2j4_x9q')
        # This update's receipt sorts oldest of all, and the prune runs as if two days had passed.
        fixture.output = self.receipts / 'update-0.1.0-20261001T000000000000Z.json'
        real, later = release_retention.prune_update_leftovers, time.time() + 2 * DAY

        def two_days_later(*args, **kwargs):
            with mock.patch.object(release_retention.time, 'time', return_value=later):
                return real(*args, **kwargs)

        with mock.patch.object(updater.update, 'prune_update_leftovers', side_effect=two_days_later):
            fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['prunedLeftovers'], {
            'incoming': [stage],
            'receipts': {'receipts': sorted(['update-%s.json' % oldest, 'prestate-%s.json' % oldest,
                                             'update-%s.log' % oldest]),
                         'ownedUpdates': [oldest_folder.name]}})
        self.assertTrue(pathlib.Path(result['backup']).is_dir())
        self.assertFalse(oldest_folder.exists())


if __name__ == '__main__':
    unittest.main()
