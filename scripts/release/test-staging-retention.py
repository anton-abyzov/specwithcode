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

    def published_only(self, name):
        """A release that stopped after publish-public, as every --ci release does."""
        stage = self.stage(name, done=False)
        for marker in ('publish-private', 'publish-public'):
            (stage / 'markers' / marker).write_text('once\n')
        return stage

    def test_locks_incomplete_publication_and_foreign_descriptors_stay(self):
        locked = self.stage('1.0.0')
        (locked / 'lock').mkdir()  # A stale or empty lock is still a lock.
        partial = self.stage('1.0.1', done=False)
        (partial / 'markers/publish-private').write_text('once\n')  # Private only: not public.
        foreign = self.stage('1.0.2')
        (foreign / 'release.json').write_text('{}')
        unmerged = self.stage('1.1.0')
        (unmerged / 'markers/merge').unlink()
        failed_fleet = self.stage('1.0.3')
        (failed_fleet / 'markers/fleet-workers').unlink()
        result = retention.prune(self.root, '1.2.0', '1.1.0', apply=True)
        # Published but not merged: the older stage goes, the previous one is compacted.
        self.assertEqual(sorted(a['action'] for a in result['removed']), ['remove-payload'] * 5 + ['remove-stage'])
        self.assertFalse(failed_fleet.exists())
        self.assertFalse(list(unmerged.glob('runtime-*')))
        self.assertTrue((unmerged / 'release.json').is_file())
        self.assertTrue((unmerged / 'markers/publish-public').is_file())
        for stage in (locked, partial, foreign):
            self.assertTrue(list(stage.glob('runtime-*')))
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])

    def test_ci_releases_that_stop_after_publish_public_are_superseded(self):
        old = self.published_only('1.0.134')
        previous = self.published_only('1.0.135')
        current = self.published_only('1.0.136')
        result = retention.prune(self.root, '1.0.136', '1.0.135', apply=True)
        self.assertEqual(len(result['removed']), 6)
        self.assertFalse(old.exists())
        self.assertFalse(list(previous.glob('runtime-*')))
        self.assertEqual((previous / 'stage1/history.json').read_text(), '{"tests":"keep"}')
        self.assertTrue(list(current.glob('runtime-*')))
        # --finished still needs the whole rollout, so the current CI stage keeps its payloads.
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'], [])
        self.assertTrue(list(current.glob('runtime-*')))

    def test_published_needs_both_markers_and_a_recorded_sha(self):
        missing_public = self.published_only('1.0.0')
        (missing_public / 'markers/publish-public').unlink()
        bad_sha = self.published_only('1.0.1')
        (bad_sha / 'published.sha').write_text('not a commit')
        no_sha = self.published_only('1.0.2')
        (no_sha / 'published.sha').unlink()
        started = self.published_only('1.0.3')
        (started / 'markers/publish-private').write_text('started')
        self.assertEqual(retention.prune(self.root, '1.2.0', '1.1.0', apply=True)['removed'], [])
        for stage in (missing_public, bad_sha, no_sha, started):
            self.assertTrue(list(stage.glob('runtime-*')))

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

    def test_a_retired_husk_a_failed_removal_left_is_removed_and_a_locked_one_stays(self):
        husk = self.root / ('.retired-1.0.189-' + 'b' * 32)
        (husk / ('assets-' + SHA[:12])).mkdir(parents=True)
        (husk / ('assets-' + SHA[:12]) / 'bytes').write_bytes(b'rebuildable')
        busy = self.root / ('.retired-1.0.190-' + 'c' * 32)
        (busy / 'lock').mkdir(parents=True)
        foreign = self.root / '.retired-notes'
        foreign.mkdir()
        current = self.stage('1.2.0')
        plan = retention.prune(self.root, '1.2.0', '1.1.0')
        self.assertEqual([item['path'] for item in plan['planned']], [str(husk)])
        self.assertTrue(husk.is_dir())
        result = retention.prune(self.root, '1.2.0', '1.1.0', apply=True)
        self.assertEqual(result['removed'], plan['planned'])
        self.assertFalse(husk.exists())
        self.assertTrue(busy.is_dir() and foreign.is_dir() and current.is_dir())
        finished = retention.prune(self.root, finished=True, apply=True)
        self.assertNotIn(str(busy), [item['path'] for item in finished['removed']])

    def test_removal_retries_when_finder_refills_a_folder(self):
        old = self.stage('1.0.0')
        original = retention.shutil.rmtree
        calls = []
        def remove(path):
            calls.append(path)
            if len(calls) == 1:
                raise OSError(retention.errno.ENOTEMPTY, 'Directory not empty')
            original(path)
        with patch.object(retention.shutil, 'rmtree', side_effect=remove), patch.object(retention, 'RETRY_PAUSE_SECONDS', 0):
            result = retention.prune(self.root, '1.2.0', '1.1.0', apply=True)
        self.assertEqual(len(result['removed']), 1)
        self.assertEqual(len(calls), 2)
        self.assertFalse(old.exists())
        self.assertFalse(list(self.root.iterdir()))

    def test_a_husk_that_cannot_be_removed_releases_its_lock_for_the_next_run(self):
        husk = self.root / ('.retired-1.0.189-' + 'b' * 32)
        husk.mkdir()
        with patch.object(retention.shutil, 'rmtree', side_effect=OSError(retention.errno.ENOTEMPTY, 'Directory not empty')), \
                patch.object(retention, 'RETRY_PAUSE_SECONDS', 0):
            result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual(result['refused'], [{'path': str(husk), 'error': 'OSError'}])
        self.assertFalse((husk / 'lock').exists())
        self.assertEqual(retention.prune(self.root, finished=True, apply=True)['removed'][0]['path'], str(husk))

    def test_permission_errors_are_not_retried_and_partial_removal_is_not_success(self):
        husk = self.root / ('.retired-1.0.189-' + 'b' * 32)
        husk.mkdir()
        calls = []
        def denied(path):
            calls.append(path)
            raise PermissionError(13, 'denied')
        with patch.object(retention.shutil, 'rmtree', side_effect=denied):
            result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual((len(calls), result['removed']), (1, []))
        def vanished(path):
            raise FileNotFoundError(2, 'gone', str(pathlib.Path(path) / 'child'))
        with patch.object(retention.shutil, 'rmtree', side_effect=vanished), patch.object(retention, 'RETRY_PAUSE_SECONDS', 0):
            result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual(result['removed'], [])
        self.assertTrue(husk.is_dir() and not (husk / 'lock').exists())

    def test_a_husk_with_a_stale_lock_is_swept_but_a_live_one_stays(self):
        dead = self.root / ('.retired-1.0.188-' + 'd' * 32)
        (dead / 'lock').mkdir(parents=True)
        (dead / 'lock' / 'pid').write_text('999999\n')
        nopid = self.root / ('.retired-1.0.187-' + 'e' * 32)
        (nopid / 'lock').mkdir(parents=True)
        old = __import__('time').time() - 2 * 3600
        __import__('os').utime(nopid / 'lock', (old, old))
        live = self.root / ('.retired-1.0.186-' + 'f' * 32)
        (live / 'lock').mkdir(parents=True)
        (live / 'lock' / 'pid').write_text('%d\n' % __import__('os').getpid())
        fresh = self.root / ('.retired-1.0.185-' + '0' * 32)
        (fresh / 'lock').mkdir(parents=True)
        result = retention.prune(self.root, finished=True, apply=True)
        self.assertEqual(sorted(item['path'] for item in result['removed']), sorted([str(dead), str(nopid)]))
        self.assertTrue(live.is_dir() and fresh.is_dir())

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
