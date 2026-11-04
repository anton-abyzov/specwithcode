#!/usr/bin/env python3
"""fleet_rollout's default route: SpecWithCode Connect only. Without --ssh-fallback no fleet inventory is
read, no pinned SSH is built, and the desktop app step (which needs SSH) is skipped without failing."""
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fleet_rollout  # noqa: E402

_spec = importlib.util.spec_from_file_location('fleet_rollout_tests', HERE / 'test-fleet-rollout.py')
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)


class ConnectOnlyDefault(unittest.TestCase):
    def test_by_default_no_inventory_is_read_and_no_ssh_is_built(self):
        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.dict(os.environ, {'STUDIO_FLEET_HOSTS': str(pathlib.Path(temporary) / 'missing.json')}):
            hosts = fleet_rollout.fleet(home=temporary, connect=base.CLI)
        self.assertEqual(sorted(hosts), ['m1', 'm3', 'm4'])
        for identity in ('m1', 'm3'):
            self.assertIsInstance(hosts[identity], fleet_rollout.Unreachable)
            self.assertIn("not in M4's fleet (studio-fleet.json)", hosts[identity].reason)
            self.assertIn('pass --ssh-fallback to use pinned fleet SSH', hosts[identity].reason)

    def test_connect_only_workers_skip_the_desktop_step_without_failing(self):
        clock, lines = base.Clock(), []
        fleet = base.connect_fleet(clock, extra=(), polls={'m1': 1, 'm3': 1})
        cli = base.FakeCli(fleet)
        hosts = fleet.hosts()
        for identity in ('m1', 'm3'):
            hosts[identity] = fleet_rollout.ConnectHost(identity, base.CLI, identity + '-id', run=cli)
        skip = 'needs pinned fleet SSH (pass --ssh-fallback); its own updater installs %s on quit' % base.NEW
        results = fleet_rollout.rollout(base.NEW, hosts, only='workers', clock=clock, sleep=clock.sleep,
                                        say=lines.append, desktop_skip=skip)
        for identity in ('m1', 'm3'):
            self.assertEqual(results[identity]['result'], 'installed')
            self.assertEqual(results[identity]['route'], 'connect')
            self.assertEqual(results[identity]['desktopApp'], {'result': 'skipped', 'reason': skip})
            self.assertIn('%s: desktop app skipped: %s' % (identity, skip), lines)


if __name__ == '__main__':
    unittest.main()
