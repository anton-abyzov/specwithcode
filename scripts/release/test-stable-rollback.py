#!/usr/bin/env python3
"""r2_publish.py promote and rollback (increment 1239, AC-20): finalize copies the candidate to
stable/<v>/, checks it, keeps the old pointer as stable.prev.json and swaps stable.json last;
rollback puts stable.prev.json's exact bytes back in one atomic write, refuses when the previous
release's objects are incomplete, and leaves stable.json as it was when a write fails. Then, through
the update agent: a stable host already on <v> is not downgraded, and a host on N-2 sees N-1.

A folder store served over loopback HTTP stands in for R2, and GitHub is the agent tests' loopback
fake. Nothing reaches a real bucket, GitHub, launchd or a real SpecWithCode home.

Run: python3 -B scripts/release/test-stable-rollback.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
FLEET = HERE.parent / 'studio-fleet'
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(FLEET / 'test-fixtures'))
os.environ.setdefault('STUDIO_FLEET_ROLLOUT_LOCK', os.path.join(tempfile.mkdtemp(prefix='fleet-rollout-lock-'), 'lock'))
import channel_feed  # noqa: E402

r2_publish = channel_feed.r2_publish
fixture = channel_feed.agent_fixture
update_agent = fixture.update_agent
N2, N1, N = '1.0.188', '1.0.189', '1.0.190'


class Pointers(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.work = pathlib.Path(folder.name)
        self.store = r2_publish.LocalStore(self.work / 'bucket')
        self.fake = fixture.FakeGitHub()
        self.addCleanup(self.fake.close)
        for version in (N1, N):
            r2_publish.publish_candidate(self.store, version, channel_feed.release_dir(self.fake, version, self.work / version))
            r2_publish.promote(self.store, version)

    def raw(self, key):
        return self.store.get_bytes(key)

    def test_promotion_copies_checks_and_keeps_the_previous_pointer(self):
        stable, previous = json.loads(self.raw(r2_publish.STABLE)), json.loads(self.raw(r2_publish.PREVIOUS))
        self.assertEqual((stable['version'], stable['prefix'], stable['channel']), (N, 'stable/%s/' % N, 'stable'))
        self.assertEqual(previous['version'], N1)
        self.assertTrue(r2_publish.present(self.store, stable) and r2_publish.present(self.store, previous))
        self.assertEqual(r2_publish.promote(self.store, N)['result'], 'already-stable')  # A resumed finalize.
        self.assertEqual(json.loads(self.raw(r2_publish.PREVIOUS))['version'], N1)

    def test_rollback_restores_the_previous_pointer_bytes(self):
        before = self.raw(r2_publish.STABLE)
        report = r2_publish.rollback(self.store)
        self.assertEqual((report['result'], report['version'], report['from']), ('rolled-back', N1, N))
        self.assertEqual(self.raw(r2_publish.STABLE), self.raw(r2_publish.PREVIOUS))
        self.assertEqual(self.raw(r2_publish.ROLLED_BACK), before)
        self.assertEqual(r2_publish.rollback(self.store)['result'], 'already-rolled-back')
        self.assertEqual(self.raw(r2_publish.ROLLED_BACK), before)
        self.assertNotEqual(self.store.list('stable/%s/' % N), {})  # Rolling back deletes nothing.

    def test_rollback_is_one_atomic_write_and_a_failed_one_changes_nothing(self):
        before = self.raw(r2_publish.STABLE)
        writes = []
        real = os.replace

        def failing(source, target):
            writes.append(pathlib.Path(target).name)
            if pathlib.Path(target).name == r2_publish.STABLE:
                raise OSError('disk gone')
            return real(source, target)
        with mock.patch.object(r2_publish.os, 'replace', failing), self.assertRaises(OSError):
            r2_publish.rollback(self.store)
        self.assertEqual(writes, [r2_publish.ROLLED_BACK, r2_publish.STABLE])
        self.assertEqual(self.raw(r2_publish.STABLE), before)
        self.assertEqual([path.name for path in self.store.root.iterdir() if path.name.startswith('.')], [])

    def test_rollback_refuses_without_a_complete_previous_release(self):
        before = self.raw(r2_publish.STABLE)
        victim = next(iter(self.store.list('stable/%s/' % N1)))
        self.store.delete(victim)
        with self.assertRaisesRegex(r2_publish.PublishError, 'stable/%s/ is incomplete; nothing was changed' % N1):
            r2_publish.rollback(self.store)
        self.assertEqual(self.raw(r2_publish.STABLE), before)
        self.store.delete(r2_publish.PREVIOUS)
        with self.assertRaisesRegex(r2_publish.PublishError, 'no stable.prev.json'):
            r2_publish.rollback(self.store)

    def test_promotion_needs_the_matching_candidate(self):
        with self.assertRaisesRegex(r2_publish.PublishError, 'candidate.json names %s, not 1.0.191' % N):
            r2_publish.promote(self.store, '1.0.191')

    def test_the_cli_rolls_back(self):
        out = subprocess.run([sys.executable, '-B', str(HERE / 'r2_publish.py'), '--store',
                              'file://' + str(self.store.root), 'rollback'], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)['result'], 'rolled-back')
        self.assertEqual(json.loads(self.raw(r2_publish.STABLE))['version'], N1)


class HostsAfterRollback(fixture.AgentCase):
    """GitHub still shows <v> as its newest release after the rollback; the stable pointer wins."""

    def setUp(self):
        fixture.AgentCase.setUp(self)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.work = pathlib.Path(folder.name)
        self.feed = channel_feed.Feed(self.work / 'bucket')
        self.addCleanup(self.feed.close)
        for version in (N2, N1, N):
            directory = channel_feed.release_dir(self.fake, version, self.work / version, on_github=True)
            r2_publish.publish_candidate(self.feed.store, version, directory)
            r2_publish.promote(self.feed.store, version)
        r2_publish.rollback(self.feed.store)
        os.environ['STUDIO_UPDATE_FEED_URL'] = self.feed.url
        self.config(installAutomatically=True, quietMinutes=0)

    def installed(self):
        return json.loads((self.own / 'installation.json').read_text())['version']

    def test_a_stable_host_on_v_is_not_downgraded(self):
        self.write_installation(N, fixture.OLD_COMMIT)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.installed(), N)
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertEqual(self.apply_calls(), [])

    def test_a_host_on_n_minus_2_sees_n_minus_1_not_the_rolled_back_v(self):
        self.write_installation(N2, fixture.OLD_COMMIT)
        self.control(newVersion=N1)
        self.assertEqual(self.run_agent(), 0, self.log)  # Found, downloaded, then waits for quiet.
        self.assertEqual(self.state()['availableVersion'], N1)
        self.backdate_baseline(11)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.installed(), N1)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertIn('/stable/%s/%s' % (N1, r2_publish.PLAN), [path for path, _ in self.feed.requests])
        self.assertIn('v' + N, [release['tag_name'] for release in self.fake.releases])  # GitHub still lists it.
        self.assertEqual(self.feed.fetched('stable/%s/' % N), [])


if __name__ == '__main__':
    unittest.main()
