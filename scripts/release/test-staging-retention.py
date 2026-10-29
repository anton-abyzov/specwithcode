#!/usr/bin/env python3
"""Real-filesystem release retention checks. Temporary homes only; no network or services."""
import importlib.util
import json
import pathlib
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('staging_retention', HERE / 'staging_retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)
SHA = 'a' * 40


class Retention(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='release-retention-')
        self.addCleanup(temp.cleanup)
        self.home = pathlib.Path(temp.name).resolve()
        self.root = self.home / 'staging'
        self.root.mkdir()

    def stage(self, name, done=True):
        stage = self.root / name
        (stage / 'markers').mkdir(parents=True)
        (stage / 'release.json').write_text(json.dumps({'version': name, 'previous': '0.0.1'}))
        (stage / 'published.sha').write_text(SHA + '\n')
        (stage / 'timings').mkdir()
        (stage / 'timings' / 'stages.json').write_text('{"timings":"keep"}')
        (stage / 'stage1').mkdir()
        (stage / 'stage1' / 'history.json').write_text('{"tests":"keep"}')
        for prefix in ('assets', 'runtime', 'runtime-linux-x64', 'google-verify', 'verify-runtime-linux-arm64'):
            payload = stage / (prefix + '-' + SHA[:12])
            payload.mkdir()
            (payload / 'bytes').write_bytes(b'rebuildable')
        if done:
            for name in ('publish-private', 'publish-public', 'fleet-m4', 'desktop', 'fleet-workers', 'merge', 'fleet-linux'):
                (stage / 'markers' / name).write_text('once\n')
        return stage

    def test_normal_publish_removes_old_stages_and_compacts_previous_not_current(self):
        old = self.stage('1.0.0')
        previous = self.stage('1.1.0')
        current = self.stage('1.2.0')
        plan = retention.prune(self.root, '1.2.0', '1.1.0')
        self.assertEqual(len(plan['planned']), 6)
        self.assertTrue(old.is_dir())
        result = retention.prune(self.root, '1.2.0', '1.1.0', apply=True)
        self.assertEqual(result['removed'], plan['planned'])
        self.assertFalse(old.exists())
        self.assertFalse(list(previous.glob('runtime-*')))
        self.assertEqual((previous / 'timings/stages.json').read_text(), '{"timings":"keep"}')
        self.assertEqual((previous / 'stage1/history.json').read_text(), '{"tests":"keep"}')
        self.assertTrue((previous / 'release.json').is_file())
        self.assertTrue(list(current.glob('runtime-*')))
        self.assertFalse((previous / 'lock').exists())
        self.assertEqual(retention.prune(self.root, '1.2.0', '1.1.0', apply=True)['removed'], [])

    def test_finished_mode_preserves_receipts_and_unknown_folders(self):
        current = self.stage('1.2.0')
        for name in ('notes', 'runtime-custom', 'runtime-' + 'b' * 12):
            (current / name).mkdir()
            (current / name / 'keep').write_text('sole copy')
        result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual(len(result['removed']), 5)
        self.assertTrue((current / 'release.json').is_file())
        self.assertTrue((current / 'notes/keep').is_file())
        self.assertTrue((current / ('runtime-' + 'b' * 12) / 'keep').is_file())

    def test_locks_incomplete_publication_and_foreign_descriptors_stay(self):
        locked = self.stage('1.0.0')
        (locked / 'lock').mkdir()  # A stale or empty lock is still a lock.
        partial = self.stage('1.0.1', done=False)
        foreign = self.stage('1.0.2')
        (foreign / 'release.json').write_text('{}')
        published = self.stage('1.1.0')
        (published / 'markers/merge').unlink()
        failed_fleet = self.stage('1.0.3')
        (failed_fleet / 'markers/fleet-workers').unlink()
        plan = retention.prune(self.root, '1.2.0', '1.1.0', apply=True)
        self.assertEqual(plan['removed'], [])
        for stage in (locked, partial, foreign, published, failed_fleet):
            self.assertTrue(list(stage.glob('runtime-*')))
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])

    def test_invalid_marker_or_sha_does_not_prove_completed_release(self):
        current = self.stage('1.2.0')
        (current / 'markers/merge').write_text('started')
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])
        (current / 'markers/merge').write_text('once')
        (current / 'published.sha').write_text('not a commit')
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])

    def test_lock_acquired_after_plan_prevents_removal(self):
        current = self.stage('1.2.0')
        original = retention.stage_actions
        def competing_release(*args, **kwargs):
            result = original(*args, **kwargs)
            (current / 'lock').mkdir()
            return result
        with patch.object(retention, 'stage_actions', side_effect=competing_release):
            result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual(result['removed'], [])
        self.assertEqual(result['refused'][0]['error'], 'FileExistsError')
        self.assertTrue(list(current.glob('runtime-*')))
        self.assertTrue((current / 'lock').is_dir())

    def test_whole_stage_is_renamed_before_recursive_removal(self):
        old = self.stage('1.0.0')
        original = retention.shutil.rmtree
        observed = []
        def remove(path):
            path = pathlib.Path(path)
            observed.append(path)
            self.assertFalse(old.exists())
            self.assertTrue(path.name.startswith('.retired-1.0.0-'))
            self.assertTrue((path / 'lock/pid').is_file())
            original(path)
        with patch.object(retention.shutil, 'rmtree', side_effect=remove):
            result = retention.prune(self.root, '1.2.0', '1.1.0', apply=True)
        self.assertEqual(len(result['removed']), 1)
        self.assertEqual(len(observed), 1)
        self.assertFalse(list(self.root.iterdir()))

    def test_real_exit_hook_compacts_only_after_success_and_releases_its_lock(self):
        stage = self.stage('1.2.0')
        (stage / 'lock').mkdir()
        commands = [
            '. ' + shlex.quote(str(HERE / 'release_common.sh')),
            'MODE=real', 'LOCKED=1', 'STATE_READY=0', 'VERSION=1.2.0', 'CURRENT_STAGE=main',
            'HERE=' + shlex.quote(str(HERE)), 'STAGING_ROOT=' + shlex.quote(str(self.root)),
            'STAGE=' + shlex.quote(str(stage)), 'MARKERS="$STAGE/markers"',
        ]
        failed = subprocess.run(['bash', '-c', '\n'.join(commands + ['false', 'on_exit'])],
                                capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1)
        self.assertTrue(list(stage.glob('runtime-*')))
        self.assertFalse((stage / 'lock').exists())
        (stage / 'lock').mkdir()
        succeeded = subprocess.run(['bash', '-c', '\n'.join(commands + ['true', 'on_exit'])],
                                   capture_output=True, text=True)
        self.assertEqual(succeeded.returncode, 0, succeeded.stdout + succeeded.stderr)
        self.assertFalse(list(stage.glob('runtime-*')))
        self.assertTrue((stage / 'release.json').is_file())
        self.assertFalse((stage / 'lock').exists())

    def test_release_runner_refuses_an_incomplete_or_stale_cleanup_lock(self):
        stage = self.stage('1.2.0')
        (stage / 'lock').mkdir()
        commands = [
            'set -eu', '. ' + shlex.quote(str(HERE / 'release_common.sh')),
            'MODE=real', 'RESUME=1', 'VERSION=1.2.0', 'PREV_OVERRIDE=',
            'STAGE=' + shlex.quote(str(stage)),
            'MARKERS="$STAGE/markers"', 'LOG_DIR="$STAGE/logs"', 'TIMINGS="$STAGE/timings"',
            'init_state',
        ]
        for record in (None, '', 'not-a-pid', '999999999'):
            with self.subTest(record=record):
                if record is not None:
                    (stage / 'lock/pid').write_text(record)
                result = subprocess.run(['bash', '-c', '\n'.join(commands)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('lock', result.stderr)
                self.assertTrue((stage / 'lock').is_dir())
                self.assertTrue(list(stage.glob('runtime-*')))

    def test_symlinked_stage_root_descriptor_markers_and_payload_are_preserved(self):
        outside = self.home / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('private')
        current = self.stage('1.2.0')
        (current / 'release.json').unlink()
        (current / 'release.json').symlink_to(outside / 'keep')
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])
        alias = self.home / 'alias'
        alias.symlink_to(self.root)
        self.assertEqual(retention.prune(alias, finished=True, apply=True)['removed'], [])
        (self.root / '1.0.0').symlink_to(current)
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])
        (current / 'release.json').unlink()
        (current / 'release.json').write_text(json.dumps({'version': current.name}))
        target = current / ('runtime-' + SHA[:12])
        (target / 'inside-link').symlink_to(outside)
        result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual(len(result['removed']), 5)
        self.assertEqual((outside / 'keep').read_text(), 'private')


if __name__ == '__main__':
    unittest.main()
