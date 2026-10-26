#!/usr/bin/env python3
"""The database snapshot marker update.py keeps for the service's scheduled compaction
(apps/server/src/persistence/StorageMaintenance.ts): written before every snapshot, refreshed by
every apply and removed when the apply ends, whoever runs the helper. Temporary files only; the
real home is never read."""
import contextlib
import datetime
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('marker_update', pathlib.Path(__file__).with_name('update.py'))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class Refused(Exception):
    pass


class SnapshotMarker(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.directory.name)
        self.marker = self.home / 'updates' / update.SNAPSHOT_MARKER_FILE
        self.sleeps = []
        for target in (patch.object(update, 'snapshot_marker_path', lambda identity, own=None, home=None: self.marker),
                       patch.object(update.time, 'sleep', self.sleeps.append)):
            target.start()
            self.addCleanup(target.stop)

    def tearDown(self):
        self.directory.cleanup()

    def test_a_snapshot_writes_the_marker_first_and_settles_only_when_it_was_not_live(self):
        seen = []

        def snapshot(identity, request=None):
            seen.append(json.loads(self.marker.read_text()))
            return {'servicePid': 1}

        with patch.object(update, 'snapshot', snapshot):
            for name in ('one.json', 'two.json'):
                with patch.object(sys, 'argv', ['update.py', '--identity', 'm4', '--snapshot', str(self.home / name)]), \
                        contextlib.redirect_stdout(io.StringIO()):
                    update.main()
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(update.snapshot_marker_live(self.marker) for _ in seen))
        # The second snapshot found the marker live: the service already reads it.
        self.assertEqual(self.sleeps, [update.SNAPSHOT_MARKER_SETTLE_SECONDS])

    def test_a_marker_lapses(self):
        self.marker.parent.mkdir()
        old = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=update.SNAPSHOT_MARKER_MAX_SECONDS + 1)
        self.marker.write_text(json.dumps({'at': old.isoformat(), 'pid': 1}))
        self.assertFalse(update.snapshot_marker_live(self.marker))
        update.mark_database_snapshot('m4')
        self.assertTrue(update.snapshot_marker_live(self.marker))
        self.assertEqual(self.sleeps, [update.SNAPSHOT_MARKER_SETTLE_SECONDS])

    def test_an_apply_keeps_the_marker_while_it_runs_and_removes_it_when_it_ends(self):
        seen = []

        def failing_apply(*args, **kwargs):
            seen.append(update.snapshot_marker_live(self.marker))
            raise Refused('refused before the restart')

        class Watermark:
            def close(self):
                pass

        with patch.object(update, 'validate_identity', lambda identity: None), \
                patch.object(update, 'web_session_policy', lambda identity, policy: None), \
                patch.object(update, 'current_owner', lambda: {'home': self.home}), \
                patch.object(update, 'installation_lock', lambda home: contextlib.nullcontext()), \
                patch.object(update.read_watermark.Watermark, 'open', lambda path: Watermark()), \
                patch.object(update, '_apply', failing_apply):
            with self.assertRaises(Refused):
                update.apply('m4', {}, self.home / 'archive', '0' * 64, self.home / 'receipt.json')
        self.assertEqual(seen, [True])
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.sleeps, [])

    def test_a_marker_that_cannot_be_written_never_refuses(self):
        with patch.object(update, 'snapshot_marker_path', lambda identity, own=None, home=None: (_ for _ in ()).throw(AssertionError('not owned'))), \
                contextlib.redirect_stderr(io.StringIO()):
            update.mark_database_snapshot('m4')
            update.clear_database_snapshot('m4')
        self.assertEqual(self.sleeps, [])

    def refused_snapshot(self):
        def snapshot(identity, request=None):
            self.assertTrue(update.snapshot_marker_live(self.marker))
            raise Refused('the service is not ready')

        with patch.object(update, 'snapshot', snapshot), \
                patch.object(update, 'snapshot_refusal', lambda identity, error, request=None: 'refused'), \
                patch.object(sys, 'argv', ['update.py', '--identity', 'm4', '--snapshot', str(self.home / 'report.json')]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            update.main()

    def test_a_refused_snapshot_removes_the_marker_it_wrote(self):
        # The agent retries every few minutes: a marker left behind would never lapse.
        self.refused_snapshot()
        self.assertFalse(self.marker.exists())
        self.assertEqual(sorted(path.name for path in self.marker.parent.iterdir()), [])

    def test_a_refused_snapshot_gives_a_live_marker_it_refreshed_its_own_content_back(self):
        self.marker.parent.mkdir()
        other = json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'pid': 4242}) + '\n'
        self.marker.write_text(other)
        self.refused_snapshot()
        self.assertEqual(self.marker.read_text(), other)
        self.assertEqual(sorted(path.name for path in self.marker.parent.iterdir()), [self.marker.name])

    def test_a_failed_marker_write_leaves_no_temporary_file(self):
        def failing_replace(source, target):
            raise OSError(28, 'No space left on device')

        with patch.object(update.os, 'replace', failing_replace), contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(update.mark_database_snapshot('m4'))
        self.assertEqual(sorted(path.name for path in self.marker.parent.iterdir()), [])
        self.assertEqual(self.sleeps, [])


if __name__ == '__main__':
    unittest.main()
