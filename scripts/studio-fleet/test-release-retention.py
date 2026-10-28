#!/usr/bin/env python3
"""release_retention's week-long age rules after a verified update: held receipts and refusal
records older than 7 days (unless the receipt still names an existing pre-update state copy),
owned-updates folders nothing names any more, and old
install/verification entries go; the current run's files, the last verified install's receipt and
folder, anything newer and anything behind a symlink stay.

Run: cd scripts/studio-fleet && python3 -B test-release-retention.py
Temporary homes only.
"""
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_retention  # noqa: E402
import studio_paths  # noqa: E402

DAY = 86400


def age(path, seconds):
    moment = time.time() - seconds
    os.utime(str(path), (moment, moment), follow_symlinks=False)


def age_tree(path, seconds):
    for parent, folders, files in os.walk(str(path)):
        for name in folders + files:
            age(pathlib.Path(parent) / name, seconds)
    age(path, seconds)


class Home(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.home = pathlib.Path(folder.name).resolve()
        self.own = studio_paths.identity_home(self.home, 'm4')
        self.receipts = self.own / 'updates' / 'receipts'
        self.receipts.mkdir(parents=True)
        self.owned_root = self.own / 'owned-updates'
        self.owned_root.mkdir()
        self.verification = studio_paths.install_root(self.home) / 'verification'
        self.verification.mkdir(parents=True)

    def folder(self, days):
        path = self.owned_root / str(uuid.uuid4())
        path.mkdir()
        (path / 'prestate.json').write_text('{}')
        age_tree(path, days * DAY)
        return path

    def attempt(self, day, receipt, days, folder=None):
        stem = '1.0.%d-202610%02dT120000123456Z' % (day, day)
        value = dict(receipt)
        if folder is not None:
            value['backup'] = str(folder)
        files = [self.receipts / ('update-%s.json' % stem), self.receipts / ('prestate-%s.json' % stem)]
        files[0].write_text(json.dumps(value))
        files[1].write_text('{}')
        for path in files:
            age(path, days * DAY)
        return stem

    def record(self, kind, day, days):
        path = self.receipts / ('%s-202610%02dT120000Z-%08x.json' % (kind, day, day))
        path.write_text('{}')
        age(path, days * DAY)
        return path.name

    def left(self):
        return sorted(path.name for path in self.receipts.iterdir())


HELD = {'phase': 'restart-requested', 'rollback': 'held-for-safe-review'}


class HeldReceiptsAndRecords(Home):
    def test_held_receipts_and_records_older_than_a_week_go_whatever_their_rank(self):
        old_held = self.attempt(1, HELD, 8)
        new_held = self.attempt(2, HELD, 6)
        named_held = self.attempt(3, HELD, 9)  # The agent's last install: kept however old.
        finished = self.attempt(4, {'phase': 'verified'}, 9)  # Within the newest ten: kept.
        old_reaps = [self.record('reap', day, 8) for day in (1, 2)]
        new_reap = self.record('reap', 3, 2)
        old_restart = self.record('database-restart', 4, 10)
        (self.own / 'updates' / 'state.json').write_text(json.dumps(
            {'lastInstall': {'receipt': str(self.receipts / ('update-%s.json' % named_held))}}))

        removed = release_retention.prune_update_receipts(self.own)

        self.assertEqual(removed['receipts'], sorted(
            ['update-%s.json' % old_held, 'prestate-%s.json' % old_held] + old_reaps + [old_restart]))
        self.assertEqual(removed['ownedUpdates'], [])
        left = self.left()
        for stem in (new_held, named_held, finished):
            self.assertIn('update-%s.json' % stem, left)
        self.assertIn(new_reap, left)

    def test_a_held_receipt_whose_state_copy_exists_stays_with_its_folder_and_copy(self):
        backups = self.own / 'backups'
        backups.mkdir()
        copy = backups / 'pre-1.0.1-20261001T120000Z'
        copy.mkdir()
        (copy / 'state.sqlite').write_bytes(b'db')
        age_tree(copy, 30 * DAY)
        held_folder, failed_folder = self.folder(30), self.folder(30)
        held = self.attempt(1, dict(HELD, stateBackup=str(copy)), 30, folder=held_folder)
        failed = self.attempt(2, {'phase': 'restart-requested', 'rollbackError': 'restore failed',
                                  'stateBackup': str(copy)}, 30, folder=failed_folder)
        gone = self.attempt(3, dict(HELD, stateBackup=str(backups / 'pre-gone')), 30)
        newer = self.attempt(4, {'phase': 'verified'}, 1)
        (self.own / 'updates' / 'state.json').write_text(json.dumps(
            {'lastInstall': {'receipt': str(self.receipts / ('update-%s.json' % newer))}}))

        leftovers = release_retention.prune_update_leftovers(self.home, self.own, '1.0.74')

        self.assertEqual(leftovers['receipts']['receipts'],
                         sorted(['update-%s.json' % gone, 'prestate-%s.json' % gone]))
        self.assertNotIn('orphanedOwnedUpdates', leftovers)
        for stem in (held, failed):
            self.assertIn('update-%s.json' % stem, self.left())
        self.assertTrue(held_folder.is_dir() and failed_folder.is_dir())
        self.assertEqual(release_retention.held_state_backups(self.own), [str(copy)])

    def test_a_held_receipt_named_by_the_current_run_stays(self):
        stem = self.attempt(1, HELD, 30)
        removed = release_retention.prune_update_receipts(self.own, keep=[self.receipts / ('update-%s.json' % stem)])
        self.assertEqual(removed['receipts'], [])


class OrphanedOwnedUpdates(Home):
    def test_only_old_folders_nothing_names_go(self):
        orphan = self.folder(8)
        fresh_orphan = self.folder(6)
        named = self.folder(30)
        self.attempt(1, HELD, 30, folder=named)
        last_verified = self.folder(30)
        last_stem = self.attempt(2, {'phase': 'verified'}, 30, folder=last_verified)
        (self.own / 'updates' / 'state.json').write_text(json.dumps(
            {'lastInstall': {'receipt': str(self.receipts / ('update-%s.json' % last_stem))}}))
        marker = self.folder(30)
        (self.own / 'updates' / 'install-in-progress.json').write_text(json.dumps({'backup': str(marker)}))
        current = self.folder(30)  # This run's folder, passed in keep.
        broken = self.folder(30)
        (self.receipts / 'update-1.0.9-20261009T120000Z.json').write_text('{not json, %s' % broken.name)
        touched = self.folder(30)
        (touched / 'note.txt').write_text('written now')  # Something below it changed this week.
        (self.owned_root / 'notes').mkdir()
        age(self.owned_root / 'notes', 30 * DAY)

        removed = release_retention.prune_orphaned_owned_updates(self.own, keep=[current])

        self.assertEqual(removed, [orphan.name])
        self.assertFalse(orphan.exists())
        for path in (fresh_orphan, named, last_verified, marker, current, broken, touched, self.owned_root / 'notes'):
            self.assertTrue(path.is_dir(), path.name)

    def test_a_held_receipt_aged_out_leaves_its_folder_to_the_orphan_pass(self):
        folder = self.folder(9)
        stem = self.attempt(1, HELD, 9, folder=folder)
        leftovers = release_retention.prune_update_leftovers(self.home, self.own, '1.0.74')
        self.assertIn('update-%s.json' % stem, leftovers['receipts']['receipts'])
        self.assertEqual(leftovers['orphanedOwnedUpdates'], [folder.name])
        self.assertFalse(folder.exists())

    def test_symlinks_are_never_followed(self):
        outside = self.home / 'outside'
        outside.mkdir()
        (outside / 'keep.txt').write_text('x')
        linked = self.owned_root / str(uuid.uuid4())
        linked.symlink_to(outside)
        inner = self.folder(30)
        (inner / 'link').symlink_to(outside)
        age(inner / 'link', 30 * DAY)
        age(inner, 30 * DAY)
        self.assertEqual(release_retention.prune_orphaned_owned_updates(self.own), [inner.name])
        self.assertTrue(linked.is_symlink())
        self.assertTrue((outside / 'keep.txt').is_file())  # Removing the folder removed only the link inside.
        # A symlinked receipt may name a folder it cannot read without following: nothing goes.
        orphan = self.folder(30)
        (self.receipts / 'update-1.0.9-20261009T120000Z.json').symlink_to(outside / 'keep.txt')
        self.assertEqual(release_retention.prune_orphaned_owned_updates(self.own), [])
        (self.receipts / 'update-1.0.9-20261009T120000Z.json').unlink()
        # A symlinked owned-updates or receipts root removes nothing.
        self.owned_root.rename(self.home / 'owned-elsewhere')
        self.owned_root.symlink_to(self.home / 'owned-elsewhere')
        self.assertEqual(release_retention.prune_orphaned_owned_updates(self.own), [])
        self.owned_root.unlink()
        (self.home / 'owned-elsewhere').rename(self.owned_root)
        self.receipts.rename(self.home / 'receipts-elsewhere')
        self.receipts.symlink_to(self.home / 'receipts-elsewhere')
        self.assertEqual(release_retention.prune_orphaned_owned_updates(self.own), [])
        self.assertTrue(orphan.is_dir())


class Verification(Home):
    def entry(self, name, days, directory=True):
        path = self.verification / name
        if directory:
            (path / 'shots').mkdir(parents=True)
            (path / 'shots' / 'a.png').write_bytes(b'png')
        else:
            path.write_text('log')
        age_tree(path, days * DAY) if directory else age(path, days * DAY)
        return path

    def test_entries_older_than_a_week_go_and_the_rest_stay(self):
        old = self.entry('activity-diffs', 9)
        old_file = self.entry('run.log', 8, directory=False)
        recent = self.entry('chat-rename', 6)
        touched = self.entry('code-review', 20)
        (touched / 'shots' / 'b.png').write_bytes(b'new')  # Written today, deep inside.
        kept = self.entry('last-install', 20)
        finder = self.verification / '.DS_Store'
        finder.write_bytes(b'\0')
        age(finder, 30 * DAY)
        outside = self.home / 'outside'
        outside.mkdir()
        (outside / 'keep.txt').write_text('x')
        age_tree(outside, 30 * DAY)
        (self.verification / 'linked').symlink_to(outside)
        age(self.verification / 'linked', 30 * DAY)
        inner_link = self.entry('with-link', 20)
        (inner_link / 'out').symlink_to(outside)
        age(inner_link / 'out', 20 * DAY)
        age(inner_link, 20 * DAY)

        removed = release_retention.prune_verification(self.home, keep=['last-install'])

        self.assertEqual(removed, sorted([old.name, old_file.name, inner_link.name]))
        self.assertEqual(sorted(path.name for path in self.verification.iterdir()),
                         sorted(['.DS_Store', recent.name, touched.name, kept.name, 'linked']))
        self.assertTrue((outside / 'keep.txt').is_file())

    def test_a_symlinked_verification_root_removes_nothing(self):
        self.entry('activity-diffs', 30)
        self.verification.rename(self.home / 'verification-elsewhere')
        self.verification.symlink_to(self.home / 'verification-elsewhere')
        self.assertEqual(release_retention.prune_verification(self.home), [])
        self.assertTrue((self.home / 'verification-elsewhere' / 'activity-diffs').is_dir())


class AfterAVerifiedUpdate(Home):
    def test_reports_the_new_steps_only_when_they_removed_something(self):
        self.assertEqual(release_retention.prune_update_leftovers(self.home, self.own, '1.0.74'),
                         {'incoming': [], 'receipts': {'receipts': [], 'ownedUpdates': []}})
        old = self.verification / 'old'
        old.mkdir()
        age(old, 8 * DAY)
        result = release_retention.prune_update_leftovers(self.home, self.own, '1.0.74')
        self.assertEqual(result['verification'], ['old'])
        self.assertNotIn('orphanedOwnedUpdates', result)


if __name__ == '__main__':
    unittest.main()
