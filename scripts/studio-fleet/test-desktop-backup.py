#!/usr/bin/env python3
"""Desktop rollback copies end up cloned or zipped under a .noindex folder, in temporary homes only."""
import io
import json
import pathlib
import plistlib
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import desktop_backup


def make_app(path, version, bundle_id='com.specweave.studio'):
    path = pathlib.Path(path)
    (path / 'Contents' / 'MacOS').mkdir(parents=True)
    with open(path / 'Contents' / 'Info.plist', 'wb') as handle:
        plistlib.dump({'CFBundleIdentifier': bundle_id, 'CFBundleShortVersionString': version}, handle)
    (path / 'Contents' / 'MacOS' / 'SpecWithCode').write_text('binary ' + version)
    (path / 'Contents' / 'Frameworks').mkdir()
    (path / 'Contents' / 'Frameworks' / 'Current').symlink_to('../MacOS')
    return path


class DesktopBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.tmp.name) / 'home'
        self.backups = self.home / '.specwithcode' / 'backups'
        self.backups.mkdir(parents=True)
        self.unregistered = []
        patcher = patch.object(desktop_backup, 'unregister', self.unregistered.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        # The zip path unless a test clones: temporary folders may sit on APFS or not.
        self.real_clone_supported = desktop_backup.clone_supported
        self.cloning = False
        cloning = patch.object(desktop_backup, 'clone_supported',
                               lambda app, root: self.cloning and self.real_clone_supported(app, root))
        cloning.start()
        self.addCleanup(cloning.stop)
        self.addCleanup(self.tmp.cleanup)

    def use_clones(self):
        root = pathlib.Path(self.tmp.name) / 'probe'
        make_app(root / 'Probe.app', '0.0.0')
        if not self.real_clone_supported(root / 'Probe.app', root):
            self.skipTest('the temporary folder is not on APFS')
        self.cloning = True

    def loose_apps(self):
        return sorted(str(path) for path in self.backups.rglob('*.app'))

    def assert_restored(self, bundle, version):
        self.assertEqual(desktop_backup.bundle_version(bundle), version)
        self.assertEqual((bundle / 'Contents' / 'MacOS' / 'SpecWithCode').read_text(), 'binary ' + version)
        self.assertTrue((bundle / 'Contents' / 'Frameworks' / 'Current').is_symlink())
        self.assertEqual(desktop_backup.bundle_id(bundle), 'com.specweave.studio')

    def test_snapshot_zips_under_noindex_and_restores_with_symlinks(self):
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        archive = desktop_backup.snapshot(app, self.home, now=0)
        self.assertEqual(archive.parent, self.backups / 'desktop.noindex')
        self.assertTrue(archive.parent.name.endswith('.noindex'))
        self.assertEqual(archive.name, '1.0.0-19700101T000000Z.zip')
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.loose_apps(), [])
        restored = pathlib.Path(self.tmp.name) / 'restored'
        restored.mkdir()
        bundle = desktop_backup.restore(archive, restored)
        self.assertEqual(bundle, restored / 'SpecWithCode.app')
        self.assert_restored(bundle, '1.0.0')

    def test_snapshot_clones_into_a_folder_launch_services_ignores(self):
        self.use_clones()
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        with patch.object(desktop_backup.subprocess, 'run', wraps=subprocess.run) as run:
            archive = desktop_backup.snapshot(app, self.home, now=0)
        self.assertEqual(run.call_args_list[0].args[0][:3], ['/bin/cp', '-c', '-p'])
        self.assertNotIn('/usr/bin/ditto', [call.args[0][0] for call in run.call_args_list])
        self.assertEqual(archive, self.backups / 'desktop.noindex' / '1.0.0-19700101T000000Z.noindex')
        self.assertTrue(archive.is_dir())
        self.assertEqual(archive.stat().st_mode & 0o777, 0o700)
        # No .app anywhere at the top: the bundle itself sits under the .noindex name.
        self.assertEqual(self.loose_apps(), [])
        self.assertEqual(sorted(path.name for path in archive.iterdir()), ['Contents'])
        self.assertEqual(desktop_backup.bundle_version(archive), '1.0.0')
        self.assertEqual([path.name for path in archive.parent.iterdir()], [archive.name])

        restored = pathlib.Path(self.tmp.name) / 'restored'
        restored.mkdir()
        bundle = desktop_backup.restore(archive, restored)
        self.assertEqual(bundle, restored / 'SpecWithCode.app')
        self.assert_restored(bundle, '1.0.0')
        self.assertEqual(bundle.stat().st_mode & 0o777, 0o755)
        self.assertEqual(sorted(path.name for path in restored.iterdir()), ['SpecWithCode.app'])
        # The copy stays for another restore, which refuses to mix into an existing app.
        self.assertTrue(archive.is_dir())
        with self.assertRaises(ValueError):
            desktop_backup.restore(archive, restored)

    def test_snapshot_zips_when_the_clone_fails(self):
        self.use_clones()
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        real_run = subprocess.run

        def run(argv, *args, **kwargs):
            if argv[0] == '/bin/cp':
                # A copy cut short leaves part of the bundle behind.
                (pathlib.Path(argv[-1]) / 'Contents').mkdir(parents=True)
                raise subprocess.CalledProcessError(1, argv)
            return real_run(argv, *args, **kwargs)

        with patch.object(desktop_backup.subprocess, 'run', run):
            archive = desktop_backup.snapshot(app, self.home, now=0)
        self.assertEqual(archive.name, '1.0.0-19700101T000000Z.zip')
        self.assertEqual([path.name for path in archive.parent.iterdir()], [archive.name])

    def test_snapshot_zips_where_apfs_cannot_clone(self):
        self.cloning = False
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        with patch.object(desktop_backup.subprocess, 'run', wraps=subprocess.run) as run:
            archive = desktop_backup.snapshot(app, self.home, now=0)
        self.assertEqual(archive.suffix, '.zip')
        self.assertEqual([call.args[0][0] for call in run.call_args_list], ['/usr/bin/ditto'])

    def test_clone_support_is_probed_with_one_file(self):
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        result = self.real_clone_supported(app, root)
        self.assertIsInstance(result, bool)
        self.assertEqual(list(root.iterdir()), [])
        # Another volume or file system: clonefile(2) fails, so the zip is used.
        self.assertFalse(self.real_clone_supported(app, root / 'missing'))

    def test_restore_refuses_what_is_not_a_rollback_copy(self):
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        with self.assertRaises(ValueError):
            desktop_backup.restore(app, pathlib.Path(self.tmp.name))

    def test_prune_handles_clones_and_zips_together(self):
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        (root / '1.0.68-20261020T000000Z.zip').write_text('zip')
        (root / '1.0.71-20261021T000000Z.zip').write_text('zip')
        make_app(root / '1.0.72-20261022T000000Z.noindex', '1.0.72')
        newest = make_app(root / '1.0.74-20261023T000000Z.noindex', '1.0.74')
        # A clone cut short and a stray file are not copies.
        (root / '1.0.75-20261023T010000Z.noindex.partial').mkdir()
        (root / '1.0.73-20261022T120000Z.zip.partial').write_text('partial')
        removed = desktop_backup.prune(self.home, keep=1)
        self.assertEqual(sorted(path.name for path in removed),
                         ['1.0.68-20261020T000000Z.zip', '1.0.71-20261021T000000Z.zip',
                          '1.0.72-20261022T000000Z.noindex'])
        self.assertEqual(sorted(path.name for path in root.iterdir()),
                         ['1.0.73-20261022T120000Z.zip.partial', newest.name,
                          '1.0.75-20261023T010000Z.noindex.partial'])
        # The newest copy may be a zip too.
        (root / '1.0.75-20261024T000000Z.zip').write_text('zip')
        self.assertEqual([path.name for path in desktop_backup.prune(self.home, keep=1)], [newest.name])

    def test_snapshot_command_clones_and_prunes_the_older_zip(self):
        self.use_clones()
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        older = root / '1.0.71-20261021T000000Z.zip'
        older.write_text('zip')
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.74')
        output = io.StringIO()
        with redirect_stdout(output):
            desktop_backup.main(['--home', str(self.home), 'snapshot', str(app)])
        result = json.loads(output.getvalue())
        self.assertTrue(result['archive'].endswith('.noindex'))
        self.assertEqual(result['pruned'], [str(older)])
        restored = pathlib.Path(self.tmp.name) / 'restored'
        restored.mkdir()
        with redirect_stdout(io.StringIO()) as restore_output:
            desktop_backup.main(['--home', str(self.home), 'restore', result['archive'],
                                 '--to', str(restored)])
        self.assertEqual(json.loads(restore_output.getvalue()),
                         {'restored': str(restored / 'SpecWithCode.app')})
        self.assert_restored(restored / 'SpecWithCode.app', '1.0.74')

    def test_prune_keeps_the_most_recently_made_copy(self):
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        for name in ['0.2.9-20261011T204258Z.zip', '0.2.11-20261012T010000Z.zip',
                     '0.2.10-20261012T020000Z.zip', 'notes.txt']:
            (root / name).write_text(name)
        removed = desktop_backup.prune(self.home, keep=1)
        self.assertEqual(sorted(path.name for path in removed),
                         ['0.2.11-20261012T010000Z.zip', '0.2.9-20261011T204258Z.zip'])
        self.assertEqual(sorted(path.name for path in root.iterdir()),
                         ['0.2.10-20261012T020000Z.zip', 'notes.txt'])

    def test_snapshot_survives_a_higher_version_archive(self):
        # A dev build or a rolled-back release with a higher version must not
        # evict the copy that was just made.
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        newer = root / '1.0.1-dev.20261012.gabcdef0-20991231T235959Z.zip'
        newer.write_text('dev')
        app = make_app(pathlib.Path(self.tmp.name) / 'SpecWithCode.app', '1.0.0')
        output = io.StringIO()
        with redirect_stdout(output):
            desktop_backup.main(['--home', str(self.home), 'snapshot', str(app)])
        result = json.loads(output.getvalue())
        archive = pathlib.Path(result['archive'])
        self.assertTrue(archive.is_file())
        self.assertNotIn(str(archive), result['pruned'])
        self.assertEqual(result['pruned'], [str(newer)])
        self.assertEqual([path.name for path in root.iterdir()], [archive.name])

    def test_keep_is_accepted_before_or_after_the_command(self):
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        for stamp in ['20261010T000000Z', '20261011T000000Z', '20261012T000000Z']:
            (root / ('1.0.0-%s.zip' % stamp)).write_text(stamp)
        for argv in (['prune', '--keep', '2'], ['--keep', '2', 'prune']):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(desktop_backup.main(['--home', str(self.home)] + argv), 0)
            self.assertEqual(len(list(root.iterdir())), 2)
        with redirect_stdout(io.StringIO()):
            desktop_backup.main(['--home', str(self.home), 'migrate', '--keep', '1'])
        self.assertEqual([path.name for path in root.iterdir()], ['1.0.0-20261012T000000Z.zip'])

    def test_migrate_leaves_no_app_bundle_under_backups(self):
        make_app(self.backups / 'SpecWeave Studio (Alpha) 0.2.1-dev.gabc pre-0.2.1-20261010T211417Z.app', '0.2.11')
        make_app(self.backups / 'desktop-0.2.7-20261011T160950Z' / 'SpecWeave Studio (Alpha).app', '0.2.7')
        make_app(self.backups / 'desktop-prev-20261011T170252Z' / 'SpecWeave Studio (Alpha).app', '0.2.8')
        make_app(self.backups / 'desktop-prev-20261011T204258Z' / 'SpecWeave Studio (Alpha).app', '0.2.9')
        (self.backups / 'pre-0.2.9-20261011T165625Z').mkdir()
        (self.backups / 'pre-0.2.9-20261011T165625Z' / 'statev2.sqlite').write_text('db')

        report = desktop_backup.migrate(self.home, processes=[], now=0)

        self.assertEqual(self.loose_apps(), [])
        self.assertEqual(len(report['archived']), 4)
        self.assertEqual(len(self.unregistered), 4)
        archives = sorted(path.name for path in desktop_backup.archive_root(self.home).iterdir())
        self.assertEqual(archives, ['0.2.11-19700101T000000Z.zip'])
        self.assertEqual(len(report['pruned']), 3)
        # Emptied desktop-* folders go; database backups are not this tool's business.
        self.assertFalse((self.backups / 'desktop-prev-20261011T204258Z').exists())
        self.assertTrue((self.backups / 'pre-0.2.9-20261011T165625Z' / 'statev2.sqlite').exists())
        # Running it again finds nothing more to do.
        again = desktop_backup.migrate(self.home, processes=[], now=0)
        self.assertEqual(again['archived'], [])

    def test_running_or_installed_apps_are_never_touched(self):
        running = make_app(self.backups / 'desktop-prev-20261011T204258Z' / 'SpecWeave Studio (Alpha).app', '0.2.9')
        processes = [str(running.resolve()) + '/Contents/MacOS/SpecWeave Studio (Alpha)']
        report = desktop_backup.migrate(self.home, processes=processes, now=0)
        self.assertTrue(running.is_dir())
        self.assertEqual(report['skipped'][0]['reason'], 'running')
        # An unreadable process list counts as running.
        self.assertTrue(desktop_backup.is_running(running, None))

        with patch.object(desktop_backup, 'is_live_install', lambda app: True):
            report = desktop_backup.migrate(self.home, processes=[], now=0)
        self.assertTrue(running.is_dir())
        self.assertEqual(report['skipped'][0]['reason'], 'installed app')
        self.assertEqual(self.unregistered, [])

    def test_live_install_paths_are_recognised(self):
        self.assertTrue(desktop_backup.is_live_install('/Applications/SpecWithCode.app'))
        self.assertTrue(desktop_backup.is_live_install('/Applications/SpecWeave Studio (Alpha).app'))
        self.assertFalse(desktop_backup.is_live_install(
            '/Applications/.specweave-studio-backup-024-20261011T0832/SpecWeave Studio (Alpha).app'))
        self.assertFalse(desktop_backup.is_live_install(self.backups / 'x' / 'SpecWithCode.app'))

    def test_migrate_and_snapshot_leave_other_apps_alone(self):
        root = desktop_backup.archive_root(self.home)
        root.mkdir(parents=True)
        rollback = root / '1.0.0-20261012T000000Z.zip'
        rollback.write_text('rollback')
        downloads = pathlib.Path(self.tmp.name) / 'Downloads'
        other = make_app(downloads / 'Other.app', '3.1.0', bundle_id='com.example.other')
        report = desktop_backup.migrate(self.home, extra=[str(downloads)], processes=[], now=0)
        self.assertTrue((other / 'Contents' / 'Info.plist').is_file())
        self.assertEqual(report['archived'], [])
        self.assertEqual(report['skipped'][0]['reason'], 'not a com.specweave.studio bundle')
        self.assertEqual(report['pruned'], [])
        self.assertTrue(rollback.is_file())
        with self.assertRaises(ValueError):
            desktop_backup.snapshot(other, self.home, now=0)
        self.assertEqual([path.name for path in root.iterdir()], [rollback.name])

    def test_migrate_carries_on_when_a_copy_cannot_be_removed(self):
        stuck = make_app(self.backups / 'desktop-prev-20261011T170252Z' / 'SpecWeave Studio (Alpha).app', '0.2.8')
        make_app(self.backups / 'desktop-prev-20261011T204258Z' / 'SpecWeave Studio (Alpha).app', '0.2.9')
        real_rmtree = desktop_backup.shutil.rmtree

        def rmtree(path, *args, **kwargs):
            if pathlib.Path(path) == stuck:
                raise PermissionError(13, 'Permission denied', str(path))
            return real_rmtree(path, *args, **kwargs)

        with patch.object(desktop_backup.shutil, 'rmtree', rmtree):
            report = desktop_backup.migrate(self.home, keep=5, processes=[], now=0)
        self.assertEqual(len(report['archived']), 1)
        self.assertEqual(report['failed'][0]['path'], str(stuck))
        self.assertTrue(pathlib.Path(report['failed'][0]['archive']).is_file())
        self.assertIn('could not remove', report['failed'][0]['reason'])
        # Both copies leave Launch Services, and prune still runs.
        self.assertEqual(sorted(map(str, self.unregistered)),
                         sorted([str(stuck), report['archived'][0]['from']]))
        self.assertEqual(report['pruned'], [])

    def test_extra_backup_folders_are_migrated_and_removed_when_empty(self):
        outside = pathlib.Path(self.tmp.name) / 'Applications' / '.specweave-studio-backup-024-20261011T0832'
        make_app(outside / 'SpecWeave Studio (Alpha).app', '0.2.4')
        report = desktop_backup.migrate(self.home, extra=[str(outside)], keep=5, processes=[], now=0)
        self.assertEqual(len(report['archived']), 1)
        self.assertFalse(outside.exists())
        self.assertEqual(report['removedFolders'], [str(outside)])


if __name__ == '__main__':
    unittest.main()
