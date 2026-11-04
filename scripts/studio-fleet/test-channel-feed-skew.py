#!/usr/bin/env python3
"""Channel feeds and schema skew (increment 1239, AC-18): while GitHub still serves N-1, a canary
asked for the candidate installs it from the R2 candidate feed; an agent without the feed, and the
1.0.65 agent as released, keep reading GitHub with no crash and no downgrade; an unreadable feed
falls back to GitHub; and a GitHub release above stable.json is never offered
while the feed is on.

The feed is a folder store written by scripts/release/r2_publish.py and served over loopback HTTP;
GitHub is the agent tests' loopback fake. Nothing reaches a real bucket, GitHub, launchd or a real
SpecWithCode home.

Run: cd scripts/studio-fleet && python3 -B test-channel-feed-skew.py
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
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'test-fixtures'))
import channel_feed  # noqa: E402
import update_agent  # noqa: E402
import update_request  # noqa: E402

fixture = channel_feed.agent_fixture
r2_publish = channel_feed.r2_publish
PREVIOUS, CANDIDATE, OLDER = '1.0.189', '1.0.190', '1.0.188'
AGENT_1_0_65 = HERE / 'test-fixtures' / 'agent-1.0.65'
# Runs an installed agent's pass in its own process (its modules share names with this folder's),
# with the account's home pointed at the test home, as test-update.py's AGENT_DRIVER does.
OLD_AGENT_DRIVER = """
import os, pathlib, pwd, sys
agent_dir, home = sys.argv[1:3]
sys.path.insert(0, agent_dir)
import installation_descriptor
account = pwd.getpwuid(os.getuid())
installation_descriptor.pwd.getpwuid = lambda uid: type('Account', (), {'pw_dir': home, 'pw_name': account.pw_name})()
import update_agent
update_agent.find_gh_token = lambda home: None
sys.exit(update_agent.main(['--identity', 'm4', '--home', home]))
"""


class ChannelCase(fixture.AgentCase):
    def setUp(self):
        fixture.AgentCase.setUp(self)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.scratch = pathlib.Path(folder.name)
        self.feed = channel_feed.Feed(self.scratch / 'bucket')
        self.addCleanup(self.feed.close)
        self.write_installation(PREVIOUS, fixture.OLD_COMMIT)
        # GitHub serves N-1 (and an older release); the feed's stable pointer names N-1 too.
        channel_feed.release_dir(self.fake, OLDER, self.scratch / OLDER, on_github=True)
        channel_feed.release_dir(self.fake, PREVIOUS, self.scratch / PREVIOUS, on_github=True)
        self.publish(PREVIOUS)
        r2_publish.promote(self.feed.store, PREVIOUS)
        os.environ[update_agent.recovery.FEED_ENV] = self.feed.url

    def publish(self, version, **options):
        directory = self.scratch / version
        if not directory.is_dir():
            channel_feed.release_dir(self.fake, version, directory, **options)
        return r2_publish.publish_candidate(self.feed.store, version, directory, notes='Notes for ' + version)

    def ask(self, version):
        """The request fleet_rollout writes on M4 (update_request.py request --force)."""
        self.updates.mkdir(mode=0o700, exist_ok=True)
        return update_request.write_request(self.home, 'm4', version, force=True, hold_minutes=15)

    def installed(self):
        return json.loads((self.own / 'installation.json').read_text())['version']


class CanaryOnCandidate(ChannelCase):
    def test_the_canary_installs_the_candidate_while_github_still_serves_n_minus_1(self):
        self.publish(CANDIDATE)
        self.control(newVersion=CANDIDATE)
        written = self.ask(CANDIDATE)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.installed(), CANDIDATE)
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('installed', CANDIDATE))
        self.assertEqual(state['handledInstallRequestAt'], written['installRequestedAt'])
        self.assertEqual(len(self.apply_calls()), 1)
        # Its assets came from the candidate prefix, with no GitHub token sent to the feed.
        fetched = self.feed.fetched('candidate/%s/' % CANDIDATE)
        for name in (r2_publish.PLAN, r2_publish.SUMS, 'specweave-studio-%s-darwin-arm64.tgz' % CANDIDATE):
            self.assertIn('/candidate/%s/%s' % (CANDIDATE, name), fetched)
        self.assertTrue(self.feed.requests)
        self.assertTrue(all(auth is None for _, auth in self.feed.requests))
        self.assertNotIn('v' + CANDIDATE, [release['tag_name'] for release in self.fake.releases])

    def test_a_tampered_candidate_object_is_refused_before_any_install(self):
        self.publish(CANDIDATE)
        sums = self.feed.root / 'candidate' / CANDIDATE / r2_publish.SUMS
        data = sums.read_bytes()
        sums.write_bytes(data[:-2] + (b'x' if data[-2:-1] != b'x' else b'y') + data[-1:])  # Same size.
        self.ask(CANDIDATE)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(self.apply_calls(), [])
        self.assertIn('lists another digest for SHA256SUMS', self.state()['message'])


class OlderAgents(ChannelCase):
    def test_an_agent_without_the_feed_reads_github_with_no_crash_and_no_downgrade(self):
        self.publish(CANDIDATE)
        os.environ[update_agent.recovery.FEED_ENV] = ''  # What an agent before channel feeds does.
        self.ask(CANDIDATE)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertEqual(self.feed.requests, [])
        self.assertTrue(any(kind == 'api' for kind, *_ in self.fake.requests))

    def test_the_request_keeps_the_shape_older_agents_accept(self):
        # Nothing new goes into config.json for a candidate: an older agent's bound() and settings
        # check see the request they always saw.
        written = self.ask(CANDIDATE)
        config = json.loads((self.updates / 'config.json').read_text())
        self.assertEqual(config['installRequest'], {'at': written['installRequestedAt'], 'version': CANDIDATE})
        self.assertEqual(config['channel'], 'stable')
        self.assertEqual(update_agent.load_config(self.updates, self.home)['installRequest'], config['installRequest'])

    def test_the_released_1_0_65_agent_ignores_the_feed_with_no_crash_and_no_downgrade(self):
        self.assertTrue((AGENT_1_0_65 / 'update_agent.py').is_file(), 'The 1.0.65 agent fixture is missing')
        self.publish(CANDIDATE)
        self.ask(CANDIDATE)
        driver = self.scratch / 'driver' / 'driver.py'
        driver.parent.mkdir()
        driver.write_text(OLD_AGENT_DRIVER)
        env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8',
               'STUDIO_UPDATE_API_URL': self.fake.api_url, 'STUDIO_UPDATE_TOKEN': fixture.TOKEN,
               'STUDIO_UPDATE_HELPER_PYTHON': sys.executable, update_agent.recovery.FEED_ENV: self.feed.url}
        before = len(self.feed.requests)
        result = subprocess.run([sys.executable, '-B', str(driver), str(AGENT_1_0_65), str(self.home)],
                                capture_output=True, text=True, timeout=120, env=env)
        output = result.stdout + result.stderr
        self.assertNotIn('Traceback', output)
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("update-agent m4: up-to-date", output)
        self.assertEqual(self.installed(), PREVIOUS)
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(len(self.feed.requests), before)  # It never reads the feed...
        self.assertTrue(any(kind == 'api' and '/releases?' in path for kind, path, *_ in self.fake.requests),
                        output)  # ...and still reads GitHub.
        self.assertNotEqual(json.loads((self.updates / 'state.json').read_text()).get('installedVersion'), OLDER)


class Fallback(ChannelCase):
    def test_an_unreadable_feed_falls_back_to_github(self):
        newer = '1.0.191'
        channel_feed.release_dir(self.fake, newer, self.scratch / newer, on_github=True)
        os.environ[update_agent.recovery.FEED_ENV] = 'http://127.0.0.1:9/'  # Nothing listens there.
        self.control(newVersion=newer)
        self.config(installAutomatically=True, quietMinutes=0)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.state()['availableVersion'], newer)
        self.assertIn('the stable channel feed could not be read; reading GitHub', self.log)

    def test_a_malformed_stable_pointer_also_falls_back(self):
        (self.feed.root / r2_publish.STABLE).write_text('{"schemaVersion": 1, "channel": "stable"}')
        newer = '1.0.191'
        channel_feed.release_dir(self.fake, newer, self.scratch / newer, on_github=True)
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.state()['availableVersion'], newer)

    def test_the_feed_url_must_be_https_or_loopback(self):
        agent = update_agent.Agent(self.home, 'm4', True, lambda line: None)
        for bad in ('http://example.com/feed/', 'https://user:pw@example.com/', 'https://example.com/?a=1'):
            with mock.patch.dict(os.environ, {update_agent.recovery.FEED_ENV: bad}):
                with self.assertRaises(update_agent.AgentError):
                    update_agent.recovery.feed_base(agent)
        with mock.patch.dict(os.environ, {update_agent.recovery.FEED_ENV: 'https://feed.example.com/studio'}):
            self.assertEqual(update_agent.recovery.feed_base(agent), 'https://feed.example.com/studio/')
        with mock.patch.dict(os.environ, {update_agent.recovery.FEED_ENV: 'off'}):
            self.assertIsNone(update_agent.recovery.feed_base(agent))


class FeedCeiling(ChannelCase):
    """stable.json caps a feed host: a GitHub release above it (a github-channel release) is never offered."""

    def setUp(self):
        ChannelCase.setUp(self)
        self.newer = '1.0.191'
        channel_feed.release_dir(self.fake, self.newer, self.scratch / self.newer, on_github=True)
        self.control(newVersion=self.newer)
        self.config(installAutomatically=True, quietMinutes=0)

    def test_a_github_release_above_stable_json_is_never_offered(self):
        self.assertEqual(self.run_agent(), 0, self.log)
        state = self.state()
        self.assertEqual(state['status'], 'up-to-date', state)
        self.assertNotEqual(state.get('availableVersion'), self.newer)
        self.assertEqual((self.installed(), self.apply_calls()), (PREVIOUS, []))
        self.assertFalse((self.updates / 'snapshots' / 'baseline.json').exists())  # Nothing was downloaded.
        self.assertTrue(any(kind == 'api' and '/releases?' in path for kind, path, *_ in self.fake.requests))

    def test_nor_when_a_request_names_it_and_no_candidate_does(self):
        self.ask(self.newer)
        self.run_agent()
        self.assertEqual((self.installed(), self.apply_calls()), (PREVIOUS, []))
        self.assertNotEqual(self.state().get('installedVersion'), self.newer)

    def test_without_the_feed_the_same_host_is_offered_it(self):
        os.environ[update_agent.recovery.FEED_ENV] = 'off'
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.state()['availableVersion'], self.newer)


if __name__ == '__main__':
    unittest.main()
