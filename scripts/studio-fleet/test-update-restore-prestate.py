#!/usr/bin/env python3
"""Install-speed changes to the update's rollback restore and prestate check, split from
test-update-read-speed.py: a rollback restores the database as a clonefile(2) clone, with a
plain copy as the fallback, and the prestate is checked once before pointers move. Temporary
files only; no services or user stores.
"""

import ctypes
import errno
import importlib.util
import json
import os
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

import state_backup
import update


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


updater_base = module('restore_prestate_update_base', 'test-update.py')


def failing_clone(calls, written=None, code=errno.ENOTSUP):
    def clonefile(source, target, flags):
        calls.append((source, target, flags))
        if written is not None: pathlib.Path(os.fsdecode(target)).write_bytes(written)
        ctypes.set_errno(code)
        return -1
    return clonefile


class RestoreClone(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-update-restore-clone-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / 'backup.sqlite'
        self.source.write_bytes(bytes(range(256)) * 4096 + b'tail')

    def restore_fixture(self):
        own = self.root / 'own'
        state = own / 'userdata'
        state.mkdir(parents=True)
        backup = self.root / 'pre' / 'statev2.sqlite'
        backup.parent.mkdir()
        db = sqlite3.connect(backup); db.execute('CREATE TABLE t(v)'); db.execute("INSERT INTO t VALUES ('before')"); db.commit(); db.close()
        (state / 'statev2.sqlite').write_bytes(b'migrated')
        (state / 'statev2.sqlite-wal').write_bytes(b'wal'); (state / 'statev2.sqlite-shm').write_bytes(b'shm')
        return own, state, backup

    def test_a_failed_clone_falls_back_to_an_identical_copy(self):
        for code in (errno.ENOTSUP, errno.EXDEV):
            with self.subTest(code=errno.errorcode[code]):
                target, calls = self.root / ('failed-%d.sqlite' % code), []
                # What the failed clone left, longer than the source, is replaced by the copy.
                with patch.object(state_backup, '_clonefile', return_value=failing_clone(calls, self.source.read_bytes() + b'partial', code)):
                    update.clone_file(self.source, target)
                self.assertEqual(calls, [(os.fsencode(self.source), os.fsencode(target), 0)])
                self.assertEqual(target.read_bytes(), self.source.read_bytes())

    def test_no_clonefile_falls_back_to_an_identical_copy(self):
        for name, loader in (('symbol-missing', {'return_value': object()}),
                             ('no-libc', {'side_effect': OSError('no C library')})):
            with self.subTest(name=name):
                target = self.root / (name + '.sqlite')
                with patch.object(ctypes, 'CDLL', **loader):
                    self.assertIsNone(update._clonefile())
                    update.clone_file(self.source, target)
                self.assertEqual(target.read_bytes(), self.source.read_bytes())

    @unittest.skipUnless(sys.platform == 'darwin', 'APFS clones are macOS only')
    def test_clone_and_plain_copy_give_identical_bytes(self):
        self.assertIsNotNone(update._clonefile())
        cloned, copied = self.root / 'cloned.sqlite', self.root / 'copied.sqlite'
        with patch.object(update.shutil, 'copyfile', side_effect=AssertionError('fell back to a copy')):
            update.clone_file(self.source, cloned)
        shutil.copyfile(self.source, copied)
        self.assertEqual(cloned.read_bytes(), self.source.read_bytes())
        self.assertEqual(cloned.read_bytes(), copied.read_bytes())

    def test_restore_still_replaces_the_database_and_removes_sidecars(self):
        own, state, backup = self.restore_fixture()
        update.restore_state(backup, own)
        self.assertEqual((state / 'statev2.sqlite').read_bytes(), backup.read_bytes())
        self.assertEqual((state / 'statev2.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertEqual(sorted(path.name for path in state.iterdir()), ['statev2.sqlite'])

    def test_restore_clones_from_the_backup(self):
        own, state, backup = self.restore_fixture()
        with patch.object(update, 'clone_file', wraps=update.clone_file) as clone:
            update.restore_state(backup, own)
        clone.assert_called_once()
        source, target = clone.call_args.args
        self.assertEqual(source, backup)
        self.assertEqual(target.parent, state)
        self.assertTrue(target.name.startswith('statev2.sqlite.owned-restore-'))
        self.assertEqual((state / 'statev2.sqlite').read_bytes(), backup.read_bytes())

    def test_a_failed_restore_leaves_the_database_and_no_staged_file(self):
        own, state, backup = self.restore_fixture()
        calls = []
        with patch.object(state_backup, '_clonefile', return_value=failing_clone(calls, b'partial', errno.EIO)), \
                patch.object(update.shutil, 'copyfile', side_effect=OSError(errno.ENOSPC, 'No space left on device')), \
                self.assertRaises(OSError):
            update.restore_state(backup, own)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sorted(path.name for path in state.iterdir()),
                         ['statev2.sqlite', 'statev2.sqlite-shm', 'statev2.sqlite-wal'])
        self.assertEqual((state / 'statev2.sqlite').read_bytes(), b'migrated')


class SinglePrestateCheck(unittest.TestCase):
    """The prestate is checked once before pointers move (after the before-read), not again
    before the release is published: a refusal there leaves the inert release, which a retry
    reuses, and a published release that differs from the archive is refused first."""

    def harness(self):
        fixture = updater_base.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        self.state = fixture.use_captured_waiting_state()
        self.reads = []
        since = fixture.snapshot_since
        def counted(identity, expected_rows, include_auth=False, widen_from=None):
            self.reads.append({'restarted': fixture.restarted, 'reused': False,
                               'pointers': {path: path.read_bytes() for path in fixture.original}})
            return since(identity, expected_rows, include_auth, widen_from)
        fixture.snapshot_since = counted
        reusing = fixture.snapshot_reusing
        def reused(identity, earlier, carried):
            # A check whose database read the watermark let stand (read_watermark).
            self.reads.append({'restarted': fixture.restarted, 'reused': True,
                               'pointers': {path: path.read_bytes() for path in fixture.original}})
            return reusing(identity, earlier, carried)
        fixture.snapshot_reusing = reused
        self.release = fixture.home / '.specwithcode/install/releases' / fixture.sha[:20]
        return fixture

    def test_two_reads_before_the_restart_and_the_backup_folder_after_the_check(self):
        fixture = self.harness()
        fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        before_restart = [read for read in self.reads if not read['restarted']]
        self.assertEqual(len(before_restart), 2)  # The before-read and the check before the pointers.
        # Nothing changed between them, so the check reused the before-read's rows.
        self.assertEqual([read['reused'] for read in before_restart], [False, True])
        self.assertTrue(all(read['pointers'] == fixture.original for read in before_restart))
        backup = pathlib.Path(result['backup'])
        self.assertEqual(json.loads((backup / 'prestate.json').read_text()), result['before'])
        self.assertEqual((backup / 'cli-wrapper.sh').read_bytes(), fixture.original[fixture.wrapper])

    def test_a_guarded_change_after_the_before_read_is_refused_before_any_pointer_moves(self):
        for name, sql in (('edited-history', "UPDATE orchestration_events SET payload_json='edited' WHERE sequence=1"),
                          ('changed-project', "UPDATE projection_projects SET title='changed'"),
                          ('unprotected-table', 'CREATE TABLE extra_table(v)')):
            with self.subTest(name=name):
                fixture = self.harness()
                fixture.on_stage = lambda: updater_base.mutate_state(self.state, sql)
                with self.assertRaisesRegex(AssertionError, '^Guarded prestate changed: rows$|^Complete database prestate changed$'):
                    fixture.execute()
                self.assertEqual(fixture.restart_calls, [])
                self.assertEqual({path: path.read_bytes() for path in fixture.original}, fixture.original)
                self.assertFalse((fixture.own / 'owned-updates').exists())
                self.assertFalse(fixture.output.exists())
                self.assertEqual(fixture.backups, [])
                self.assertEqual(len(self.reads), 2)
                # Published but inert: no pointer names it, and the retry below reuses it.
                self.assertTrue((self.release / 'studio-manifest.json').is_file())
                self.assertNotIn(fixture.sha[:20], (fixture.own / 'installation.json').read_text())
                manifest = (self.release / 'studio-manifest.json').read_bytes()
                # The agent's retry starts from a fresh prestate of the changed database.
                fixture.before['rows'], _, fixture.before['databaseCapture'] = \
                    updater_base.update._rows_snapshot(self.state, False, include_database=True)
                fixture.on_stage = None
                published = []
                real = updater_base.update.publish_release
                def publish(staged, destination):
                    published.append(destination.exists())
                    return real(staged, destination)
                with patch.object(updater_base.update, 'publish_release', side_effect=publish):
                    fixture.execute()
                result = json.loads(fixture.output.read_text())
                self.assertEqual(result['phase'], 'verified')
                self.assertEqual(published, [True])
                self.assertEqual((self.release / 'studio-manifest.json').read_bytes(), manifest)
                self.assertEqual(json.loads((fixture.own / 'installation.json').read_text())['release'], str(self.release))
                self.assertEqual(len(list((fixture.own / 'owned-updates').iterdir())), 1)

    def test_a_published_release_that_differs_is_refused_before_the_prestate_is_read_again(self):
        """Publishing comes before the one check after staging: where both would refuse, the
        refusal names the release that differs from the archive (origin/main checked the
        prestate first, and named that)."""
        fixture = self.harness()
        self.release.mkdir(parents=True)
        (self.release / 'bin.mjs').write_bytes(b'new-owned-code')
        (self.release / 'studio-manifest.json').write_text(json.dumps({
            'product': 'SpecWeave Studio', 'version': fixture.incoming_version, 'sourceCommit': 'another-source',
            'files': [{'path': 'bin.mjs', 'type': 'file', 'sha256': updater_base.update.digest(b'new-owned-code')}]}))
        fixture.on_stage = lambda: updater_base.mutate_state(self.state, "UPDATE projection_projects SET title='changed'")
        with self.assertRaisesRegex(AssertionError, '^Previously staged release differs from the verified archive$'):
            fixture.execute()
        self.assertEqual(len(self.reads), 1)  # The before-read only.
        self.assertEqual(fixture.restart_calls, [])
        self.assertEqual({path: path.read_bytes() for path in fixture.original}, fixture.original)
        self.assertFalse((fixture.own / 'owned-updates').exists())
        self.assertFalse(fixture.output.exists())


if __name__ == '__main__':
    unittest.main()
