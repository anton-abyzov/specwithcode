#!/usr/bin/env python3
"""migrate_home.py and studio_paths.py against a private temporary home (no launchd)."""
import json
import os
import pathlib
import plistlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import migrate_home  # noqa: E402
import studio_paths  # noqa: E402

ARCHIVE = 'a' * 20


def make_home(root):
    home = pathlib.Path(root).resolve()
    legacy = home / '.specweave-studio'
    install = home / '.local/share/specweave-studio'
    own = legacy / 'm4'
    (own / 'userdata').mkdir(parents=True)
    (own / 'worktrees').mkdir()
    (legacy / 'userdata').mkdir()
    (install / 'releases' / ARCHIVE).mkdir(parents=True)
    (install / 'updater').mkdir()
    (install / 'updater' / 'update_agent.py').write_text('# agent\n')
    release = install / 'releases' / ARCHIVE
    (own / 'installation.json').write_text(json.dumps({
        'identity': 'm4', 'studioHome': str(own), 'stateDir': str(own / 'userdata'),
        'release': str(release), 'cliWrapper': str(home / '.local/bin/specweave-studio')}, indent=2) + '\n')
    (own / 'launch.sh').write_text('#!/bin/sh\nset -eu\numask 077\ncd %s\nexec node %s/bin.mjs start --base-dir %s\n'
                                   % (own, release, own))
    (home / '.local/bin').mkdir(parents=True)
    (home / '.local/bin/specweave-studio').write_text('exec env STUDIO_HOME=%s node %s/bin.mjs "$@"\n' % (own, release))
    agents = home / 'Library/LaunchAgents'
    agents.mkdir(parents=True)
    (agents / 'com.specweave.studio.m4.plist').write_bytes(plistlib.dumps({
        'Label': 'com.specweave.studio.m4', 'ProgramArguments': ['/usr/bin/caffeinate', '-s', str(own / 'launch.sh')],
        'WorkingDirectory': str(own), 'StandardOutPath': str(own / 'stdout.log')}))
    (agents / 'com.specweave.studio.m4.updater.plist').write_bytes(plistlib.dumps({
        'Label': 'com.specweave.studio.m4.updater',
        'ProgramArguments': ['/usr/bin/python3', str(install / 'updater/update_agent.py'), '--identity', 'm4'],
        'WorkingDirectory': str(own / 'updates')}))
    (agents / 'com.other.tool.plist').write_bytes(plistlib.dumps({'Label': 'com.other.tool', 'Program': str(own)}))
    db = sqlite3.connect(str(own / 'userdata/statev2.sqlite'))
    db.execute('create table projection_projects (project_id text primary key, workspace_root text)')
    db.execute('create table orchestration_v2_projection_threads (thread_id text, payload_json text)')
    db.executemany('insert into projection_projects values (?, ?)', [
        ('scratch', str(own / 'scratch')), ('m4', str(own)), ('repo', '/Users/elsewhere/repo'),
        ('lookalike', str(legacy) + '-other/x')])
    db.execute('insert into orchestration_v2_projection_threads values (?, ?)',
               ('t1', json.dumps({'worktreePath': str(own / 'worktrees/x')})))
    db.commit()
    db.close()
    return home


class StudioPathsTest(unittest.TestCase):
    def test_resolution_before_and_after(self):
        with tempfile.TemporaryDirectory() as root:
            home = pathlib.Path(root).resolve()
            self.assertEqual(studio_paths.identity_home(home, 'm4'), home / '.specwithcode/m4')
            self.assertEqual(studio_paths.install_root(home), home / '.specwithcode/install')
            make_home(root)
            self.assertEqual(studio_paths.identity_home(home, 'm4'), home / '.specweave-studio/m4')
            self.assertEqual(studio_paths.releases_root(home), home / '.local/share/specweave-studio/releases')
            self.assertEqual(studio_paths.backups_root(home), home / '.specweave-studio/backups')
            migrate_home.Migration(home, services=False, out=lambda _: None).run()
            self.assertEqual(studio_paths.identity_home(home, 'm4'), home / '.specwithcode/m4')
            self.assertEqual(studio_paths.releases_root(home), home / '.specwithcode/install/releases')
            self.assertEqual(studio_paths.backups_root(home), home / '.specwithcode/backups')

    def test_fresh_branded_profile_never_hides_legacy_service(self):
        with tempfile.TemporaryDirectory() as root:
            home = make_home(root)
            (home / '.specwithcode/userdata').mkdir(parents=True)
            self.assertEqual(studio_paths.identity_home(home, 'm4'), home / '.specweave-studio/m4')
            self.assertEqual(studio_paths.install_root(home), home / '.local/share/specweave-studio')


class MigrateHomeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = make_home(self.tmp.name)
        self.lines = []

    def tearDown(self):
        self.tmp.cleanup()

    def migration(self):
        return migrate_home.Migration(self.home, services=False, out=self.lines.append)

    def assert_migrated(self):
        home = self.home
        branded = home / '.specwithcode'
        self.assertTrue((home / '.specweave-studio').is_symlink())
        self.assertEqual(os.readlink(str(home / '.specweave-studio')), '.specwithcode')
        self.assertTrue((home / '.local/share/specweave-studio').is_symlink())
        self.assertEqual((home / '.local/share/specweave-studio').resolve(), branded / 'install')
        self.assertTrue((branded / 'm4/userdata/statev2.sqlite').is_file())
        receipt = json.loads((branded / 'm4/installation.json').read_text())
        self.assertEqual(receipt['studioHome'], str(branded / 'm4'))
        self.assertEqual(receipt['release'], str(branded / 'install/releases' / ARCHIVE))
        for path in [branded / 'm4/launch.sh', home / '.local/bin/specweave-studio']:
            text = path.read_text()
            self.assertNotIn('.specweave-studio', text)
            self.assertIn(str(branded / 'm4'), text)
        service = plistlib.loads((home / 'Library/LaunchAgents/com.specweave.studio.m4.plist').read_bytes())
        self.assertEqual(service['WorkingDirectory'], str(branded / 'm4'))
        updater = plistlib.loads((home / 'Library/LaunchAgents/com.specweave.studio.m4.updater.plist').read_bytes())
        self.assertEqual(updater['ProgramArguments'][1], str(branded / 'install/updater/update_agent.py'))
        other = plistlib.loads((home / 'Library/LaunchAgents/com.other.tool.plist').read_bytes())
        self.assertEqual(other['Program'], str(home / '.specweave-studio/m4'), 'foreign agents are untouched')
        db = sqlite3.connect(str(branded / 'm4/userdata/statev2.sqlite'))
        roots = dict(db.execute('select project_id, workspace_root from projection_projects'))
        db.close()
        self.assertEqual(roots['scratch'], str(branded / 'm4/scratch'))
        self.assertEqual(roots['m4'], str(branded / 'm4'))
        self.assertEqual(roots['repo'], '/Users/elsewhere/repo')
        self.assertEqual(roots['lookalike'], str(home / '.specweave-studio') + '-other/x')

    def test_moves_links_and_rewrites(self):
        journal = self.migration().run()
        self.assertEqual(journal['phase'], 'verified')
        self.assert_migrated()
        self.assertEqual(list(self.home.glob('.specwithcode/backups/*/*.sqlite*')), [], 'the database is never copied')
        self.assertEqual(journal['countsBeforeStart']['m4'], journal['counts']['m4'])

    def test_a_process_holding_the_database_blocks_the_move(self):
        held = open(str(self.home / '.specweave-studio/m4/userdata/statev2.sqlite'), 'rb')
        try:
            migration = self.migration()
            migration.require_unheld = lambda root, wait=120: migrate_home.Migration.require_unheld(migration, root, wait=0)
            with self.assertRaises(migrate_home.MigrationError) as raised:
                migration.run()
            self.assertIn('(%d)' % os.getpid(), str(raised.exception))
            self.assertTrue((self.home / '.specweave-studio').is_dir())
            self.assertFalse((self.home / '.specweave-studio').is_symlink())
        finally:
            held.close()
        self.assertEqual(self.migration().run()['phase'], 'verified')

    def test_rerun_is_a_no_op(self):
        self.migration().run()
        before = (self.home / '.specwithcode/m4/launch.sh').read_bytes()
        self.migration().run()
        self.assertIn('home-migration: already complete', self.lines)
        self.assertEqual((self.home / '.specwithcode/m4/launch.sh').read_bytes(), before)
        self.assert_migrated()

    def test_interrupted_after_rename_finishes_on_rerun(self):
        migration = self.migration()
        def crash():
            raise OSError('simulated crash')
        migration.link = crash
        with self.assertRaises(OSError):
            migration.run()
        self.assertFalse(os.path.lexists(str(self.home / '.specweave-studio')))
        self.assertTrue((self.home / '.specwithcode/m4').is_dir())
        self.assertEqual(self.migration().run()['phase'], 'verified')
        self.assert_migrated()

    def test_conflicting_branded_data_is_refused(self):
        (self.home / '.specwithcode/userdata').mkdir(parents=True)
        with self.assertRaises(migrate_home.MigrationError):
            self.migration().run()
        self.assertTrue((self.home / '.specweave-studio').is_dir())
        self.assertFalse((self.home / '.specweave-studio').is_symlink())
        self.assertEqual(self.migration().journal['phase'], 'failed-before-move')

    def test_rollback_restores_the_legacy_layout(self):
        original = (self.home / '.specweave-studio/m4/launch.sh').read_bytes()
        self.migration().run()
        db = sqlite3.connect(str(self.home / '.specwithcode/m4/userdata/statev2.sqlite'))
        db.execute("insert into projection_projects values ('new', 'kept')")
        db.commit(); db.close()
        self.migration().rollback()
        self.assertTrue((self.home / '.specweave-studio').is_dir())
        self.assertFalse((self.home / '.specweave-studio').is_symlink())
        self.assertFalse(os.path.lexists(str(self.home / '.specwithcode')))
        self.assertTrue((self.home / '.local/share/specweave-studio/releases' / ARCHIVE).is_dir())
        self.assertEqual((self.home / '.specweave-studio/m4/launch.sh').read_bytes(), original)
        db = sqlite3.connect(str(self.home / '.specweave-studio/m4/userdata/statev2.sqlite'))
        roots = dict(db.execute('select project_id, workspace_root from projection_projects'))
        db.close()
        self.assertEqual(roots['scratch'], str(self.home / '.specweave-studio/m4/scratch'))
        self.assertEqual(roots['new'], 'kept', 'data written after a verified move survives a rollback')

    def test_older_services_are_refused_before_anything_stops(self):
        migration = migrate_home.Migration(self.home, services=False, out=self.lines.append, minimum_version=(1, 0, 35))
        with self.assertRaises(migrate_home.MigrationError):
            migration.run()
        self.assertFalse((self.home / '.specweave-studio').is_symlink())
        self.assertFalse(os.path.lexists(str(self.home / '.specwithcode-migration.json')))
        receipt = self.home / '.specweave-studio/m4/installation.json'
        value = json.loads(receipt.read_text()); value['version'] = '1.0.35'
        receipt.write_text(json.dumps(value))
        (self.home / '.local/share/specweave-studio/updater/studio_paths.py').write_text('')
        self.assertEqual(migrate_home.Migration(self.home, services=False, out=self.lines.append,
                                                minimum_version=(1, 0, 35)).run()['phase'], 'verified')

    def test_a_receipt_without_a_service_does_not_block_the_move(self):
        stage = self.home / '.specweave-studio/stage'
        stage.mkdir()
        (stage / 'installation.json').write_text(json.dumps({'identity': 'stage', 'studioHome': str(stage)}))
        receipt = self.home / '.specweave-studio/m4/installation.json'
        value = json.loads(receipt.read_text()); value['version'] = '1.0.35'
        receipt.write_text(json.dumps(value))
        (self.home / '.local/share/specweave-studio/updater/studio_paths.py').write_text('')
        journal = migrate_home.Migration(self.home, services=False, out=self.lines.append,
                                         minimum_version=(1, 0, 35)).run()
        self.assertEqual(journal['phase'], 'verified')
        self.assertTrue((self.home / '.specwithcode/stage/installation.json').is_file())

    def test_an_unreadable_receipt_refuses_before_anything_stops(self):
        receipt = self.home / '.specweave-studio/m4/installation.json'
        value = json.loads(receipt.read_text()); value['version'] = '1.0.35'
        receipt.write_text(json.dumps(value))
        (self.home / '.local/share/specweave-studio/updater/studio_paths.py').write_text('')
        for text in ('', '{"identity": "stage"'):
            stage = self.home / '.specweave-studio/stage'
            stage.mkdir(exist_ok=True)
            (stage / 'installation.json').write_text(text)
            with self.assertRaises(migrate_home.MigrationError):
                migrate_home.Migration(self.home, services=False, out=self.lines.append,
                                       minimum_version=(1, 0, 35)).run()
            self.assertFalse((self.home / '.specweave-studio').is_symlink())
            self.assertFalse(os.path.lexists(str(self.home / '.specwithcode-migration.json')))

    def test_an_old_receipt_with_a_cli_is_still_refused(self):
        stage = self.home / '.specweave-studio/stage'
        stage.mkdir()
        (stage / 'installation.json').write_text(json.dumps(
            {'identity': 'stage', 'version': '1.0.10', 'cliWrapper': str(self.home / '.local/bin/x')}))
        receipt = self.home / '.specweave-studio/m4/installation.json'
        value = json.loads(receipt.read_text()); value['version'] = '1.0.35'
        receipt.write_text(json.dumps(value))
        (self.home / '.local/share/specweave-studio/updater/studio_paths.py').write_text('')
        with self.assertRaises(migrate_home.MigrationError):
            migrate_home.Migration(self.home, services=False, out=self.lines.append,
                                   minimum_version=(1, 0, 35)).run()
        self.assertFalse((self.home / '.specweave-studio').is_symlink())

    def test_an_unversioned_service_is_still_refused(self):
        receipt = self.home / '.specweave-studio/m4/installation.json'
        value = json.loads(receipt.read_text()); value.pop('version', None)
        receipt.write_text(json.dumps(value))
        (self.home / '.local/share/specweave-studio/updater/studio_paths.py').write_text('')
        with self.assertRaises(migrate_home.MigrationError):
            migrate_home.Migration(self.home, services=False, out=self.lines.append,
                                   minimum_version=(1, 0, 35)).run()
        self.assertFalse((self.home / '.specweave-studio').is_symlink())

    def test_nothing_to_move_on_a_fresh_machine(self):
        with tempfile.TemporaryDirectory() as root:
            journal = migrate_home.Migration(pathlib.Path(root).resolve(), services=False, out=self.lines.append).run()
            self.assertEqual(journal['phase'], 'new')
            self.assertIn('home-migration: nothing to move', self.lines)


if __name__ == '__main__':
    unittest.main()
