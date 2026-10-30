#!/usr/bin/env python3
"""update.apply and folder copies, under test-update.py's ApplyRecovery harness: a normal or
automatic install that a copy began after its snapshot stops before the service, as one whose
work changed does; a forced one goes ahead. Pure temporary metadata, never production services.

Run: cd scripts/studio-fleet && python3 -B test-update-apply-folder-copies.py
"""
import datetime
import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('apply_update_base', pathlib.Path(__file__).with_name('test-update.py'))
updater_base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater_base)
update = updater_base.update
import folder_work  # noqa: E402


class FolderCopiesBeforeRestart(updater_base.ApplyRecovery):
    """2026-10-29: the snapshot is the only folder-copy check, and staging, backup and verify take
    tens of seconds; a 'Copy files only' handoff started meanwhile writes no row the apply compares."""

    def setUp(self):
        super().setUp()
        self.before['waitsForFolderCopies'] = True  # As update.snapshot marks a normal or automatic install.

    def copy_starts(self):
        updates = self.own / 'updates'
        updates.mkdir(parents=True, exist_ok=True)
        until = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=50)
        (updates / folder_work.FILE).write_text(json.dumps(
            {'schemaVersion': 1, 'operations': 1, 'until': until.isoformat().replace('+00:00', 'Z')}))

    def assert_refused_before_the_stop(self, pointers_written):
        with self.assertRaisesRegex(AssertionError, update.FOLDER_COPY_STARTED):
            self.execute()
        self.assertEqual(self.restart_calls, [])
        self.assertEqual(self.stops, [])
        self.assertTrue(all(path.read_bytes() == value for path, value in self.original.items()))
        if pointers_written:
            result = json.loads(self.output.read_text())
            self.assertEqual(result['rollback'], 'restored-exact-owned-runtime-pointers')
            self.assertIn(update.FOLDER_COPY_STARTED, result['error'])
        # The agent retries it (update_agent.RETRYABLE_REFUSALS); its next snapshot waits for the copy.
        self.assertTrue(update.FOLDER_COPY_STARTED.startswith('Native work changed before restart'))

    def test_a_copy_that_began_during_staging_stops_it_before_any_pointer_moves(self):
        self.on_stage = self.copy_starts
        self.assert_refused_before_the_stop(pointers_written=False)
        self.assertFalse((self.own / 'owned-updates').exists())

    def test_a_copy_that_began_right_before_the_stop_stops_it_with_the_old_release_running(self):
        guard = self.quiescence_guard

        def browser_stop(*args, **kwargs):  # The last step before the final check and the stop.
            self.copy_starts()
            return guard(*args, **kwargs)
        self.quiescence_guard = browser_stop
        self.assert_refused_before_the_stop(pointers_written=True)

    def test_a_forced_install_goes_ahead_over_a_copy(self):
        del self.before['waitsForFolderCopies']
        self.copy_starts()
        self.execute()
        self.assertEqual(json.loads(self.output.read_text())['phase'], 'verified')
        self.assertEqual(len(self.restart_calls), 1)


if __name__ == '__main__':
    unittest.main()
