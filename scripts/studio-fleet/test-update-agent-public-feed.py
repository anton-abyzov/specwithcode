#!/usr/bin/env python3
"""Public managed releases: temporary homes, fake GitHub and mocked launchd only."""
import importlib.util
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import update_agent

spec = importlib.util.spec_from_file_location('agent_public_fixture', str(HERE / 'test-update-agent.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

PUBLIC = 'anton-abyzov/specwithcode'
PRIVATE = 'anton-abyzov/specwithcode'


class PublicFeed(fixture.AgentCase):
    def bootstrap(self):
        with mock.patch.object(update_agent, 'launchctl', return_value=0), \
                mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)

    def test_missing_config_discovers_and_downloads_public_assets_without_credentials(self):
        os.environ.pop('STUDIO_UPDATE_TOKEN')
        self.fake.repository = PUBLIC
        self.fake.add_release()
        self.assertFalse((self.updates / 'config.json').exists())
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['availableVersion'], '0.2.0')
        self.assertEqual(state['downloadedVersion'], '0.2.0')
        self.assertIsNotNone(state['checkedAt'])
        self.assertTrue(self.fake.blob_requests())
        self.assertTrue(all(r[2] is None for r in self.fake.requests))
        self.assertTrue(all('/repos/' + PUBLIC + '/' in r[1]
                            for r in self.fake.requests if r[0] == 'api'))
        self.assertFalse((self.updates / 'config.json').exists())

    def test_explicit_private_repository_is_used_and_preserved(self):
        self.fake.repository = PRIVATE
        self.fake.add_release()
        self.config(repository=PRIVATE, installAutomatically=False)
        path = self.updates / 'config.json'
        before = path.read_bytes()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['downloadedVersion'], '0.2.0')
        self.assertEqual(path.read_bytes(), before)
        api = [r for r in self.fake.requests if r[0] == 'api']
        self.assertTrue(api and all('/repos/' + PRIVATE + '/' in r[1] for r in api))
        self.assertTrue(all(r[2] == 'Bearer ' + fixture.TOKEN for r in api))
        self.assertTrue(all(r[2] is None for r in self.fake.blob_requests()))

    def test_bootstrap_preserves_explicit_repository_and_all_optouts(self):
        self.config(repository=PRIVATE, checkAutomatically=False,
                    downloadInBackground=False, installAutomatically=False)
        path = self.updates / 'config.json'
        before = path.read_bytes()
        self.bootstrap()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'disabled')
        self.assertEqual(self.fake.requests, [])
        self.gh_mock.assert_not_called()

    def test_supported_bootstrap_upgrades_helpers_on_116_without_rewriting_installation(self):
        self.write_installation('1.0.16', '157ea42fe61de34998e8fa737a8dc45b49fac482')
        installation = self.own / 'installation.json'
        before = installation.read_bytes()
        target = self.home / '.specwithcode/install/updater'
        target.mkdir(parents=True)
        (target / 'update_agent.py').write_text('# previous 1.0.16 helper\n')
        self.bootstrap()
        self.assertEqual(installation.read_bytes(), before)
        self.assertFalse((self.updates / 'config.json').exists())
        for name in ['update_agent.py', 'update_agent_reap.py', 'update_agent_cache.py',
                     'update_request.py', 'update_agent_recovery.py']:
            self.assertEqual((target / name).read_bytes(), (HERE / name).read_bytes())
        os.environ.pop('STUDIO_UPDATE_TOKEN')
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertEqual(self.state()['installedVersion'], '1.0.16')
        self.assertTrue(any('/repos/' + PUBLIC + '/' in r[1] for r in self.fake.requests))
        self.assertTrue(all(r[2] is None for r in self.fake.requests))

    def test_partial_config_keeps_optout_and_uses_public_default_without_writes(self):
        self.updates.mkdir()
        path = self.updates / 'config.json'
        path.write_text(json.dumps({'installAutomatically': False}))
        before = path.read_bytes()
        config = update_agent.load_config(self.updates, self.home)
        self.assertEqual(config['repository'], PUBLIC)
        self.assertFalse(config['installAutomatically'])
        self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
